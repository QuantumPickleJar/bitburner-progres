/**
 * hwgw-scheduler.js — Central coordinator for multi-host HWGW batching.
 *
 * Runs on home. Manages batch slot assignment for one or more targets, ensuring
 * that batches from different exec hosts targeting the same server do not overlap
 * in their landing windows.
 *
 * Communication:
 *   Port 2 (REGISTER_PORT):  batcher-v2 → scheduler  { type:"register", execHost, target, tag, pid, replyPort }
 *   Port <replyPort>:        scheduler → batcher-v2   { type:"batchSlot", target, tag, landHackAt, batchId }
 *   Port 4 (COMPLETE_PORT):  batcher-v2 → scheduler   { type:"batchDone", target, tag, batchId, success }
 *
 * Each batcher picks its own unique reply port (starting at 100+), sent in the
 * register message. The scheduler writes batch slots directly to that port,
 * eliminating FIFO head-of-line blocking.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 */

const REGISTER_PORT = 2;
const COMPLETE_PORT = 4;
const THREAD_PORT   = 1;

const POLL_MS = 50;

/** How far apart two batch landing windows must be (ms). 4 phases × gapMs + buffer. */
const DEFAULT_GAP_MS = 100;
const BATCH_WINDOW_MS = 4; // multiplier for gapMs to get full window width

/**
 * @param {import("NetscriptDefinitions").NS} ns
 */
export async function main(ns) {
  var gapMs = Math.max(20, Number(ns.args[0]) || DEFAULT_GAP_MS);

  ns.disableLog("ALL");

  /** @type {Map<string, TargetState>} keyed by target hostname */
  var targets = new Map();

  /** @type {Map<string, RegisteredBatcher>} keyed by tag */
  var batchers = new Map();

  var nextBatchId = 1;

  ns.print("Scheduler started. gapMs=" + gapMs);
  ns.tprint("HWGW Scheduler started (PID " + ns.pid + "). gapMs=" + gapMs);

  while (true) {
    // Drain registrations
    while (true) {
      var raw = ns.readPort(REGISTER_PORT);
      if (raw === "NULL PORT DATA") break;

      var msg;
      try { msg = JSON.parse(String(raw)); } catch (_) { continue; }

      if (msg.type === "register") {
        handleRegister(ns, msg, targets, batchers, gapMs);
      }
    }

    // Drain completions
    while (true) {
      var rawC = ns.readPort(COMPLETE_PORT);
      if (rawC === "NULL PORT DATA") break;

      var msgC;
      try { msgC = JSON.parse(String(rawC)); } catch (_) { continue; }

      if (msgC.type === "batchDone") {
        handleBatchDone(ns, msgC, targets, batchers);
      }
    }

    // Assign slots to batchers that are idle
    assignSlots(ns, targets, batchers, gapMs, nextBatchId);
    // Advance nextBatchId based on how many were assigned
    for (var [, b] of batchers) {
      if (b.currentBatchId >= nextBatchId) {
        nextBatchId = b.currentBatchId + 1;
      }
    }

    // Prune dead batchers
    pruneDeadBatchers(ns, batchers, targets);

    await ns.sleep(POLL_MS);
  }
}

/**
 * @typedef {{
 *   execHost: string,
 *   target: string,
 *   tag: string,
 *   pid: number,
 *   replyPort: number,
 *   idle: boolean,
 *   currentBatchId: number
 * }} RegisteredBatcher
 */

/**
 * @typedef {{
 *   hostname: string,
 *   gapMs: number,
 *   nextLandAt: number,
 *   activeBatches: number
 * }} TargetState
 */

/**
 * Handles a registration message from a batcher.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {{type:string, execHost:string, target:string, tag:string, pid:number, replyPort:number}} msg
 * @param {Map<string, TargetState>} targets
 * @param {Map<string, RegisteredBatcher>} batchers
 * @param {number} gapMs
 */
function handleRegister(ns, msg, targets, batchers, gapMs) {
  if (!targets.has(msg.target)) {
    targets.set(msg.target, {
      hostname: msg.target,
      gapMs: gapMs,
      nextLandAt: 0,
      activeBatches: 0
    });
  }

  batchers.set(msg.tag, {
    execHost: msg.execHost,
    target: msg.target,
    tag: msg.tag,
    pid: msg.pid,
    replyPort: msg.replyPort,
    idle: true,
    currentBatchId: 0
  });

  ns.print("Registered batcher: " + msg.tag + " (" + msg.execHost + " → " + msg.target + ") replyPort=" + msg.replyPort);
}

/**
 * Handles a batch completion message.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {{type:string, target:string, tag:string, batchId:number, success:boolean}} msg
 * @param {Map<string, TargetState>} targets
 * @param {Map<string, RegisteredBatcher>} batchers
 */
function handleBatchDone(ns, msg, targets, batchers) {
  var b = batchers.get(msg.tag);
  if (b) {
    b.idle = true;
  }

  var t = targets.get(msg.target);
  if (t) {
    t.activeBatches = Math.max(0, t.activeBatches - 1);
  }

  ns.print("Batch done: " + msg.tag + " id=" + msg.batchId + " ok=" + msg.success);
}

/**
 * Assigns the next batch slot to each idle batcher, ensuring non-overlapping landing windows per target.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {Map<string, TargetState>} targets
 * @param {Map<string, RegisteredBatcher>} batchers
 * @param {number} gapMs
 * @param {number} nextBatchId
 */
function assignSlots(ns, targets, batchers, gapMs, nextBatchId) {
  var now = Date.now();
  var batchWindowMs = BATCH_WINDOW_MS * gapMs;

  for (var [, b] of batchers) {
    if (!b.idle) continue;

    var t = targets.get(b.target);
    if (!t) continue;

    // Ensure next landing slot is in the future and doesn't overlap prior batches
    var weakenTime;
    try {
      weakenTime = ns.getWeakenTime(b.target);
    } catch (_) {
      ns.print("WARN: Cannot get weakenTime for " + b.target + ". Skipping.");
      continue;
    }

    var earliest = now + weakenTime + 5 * gapMs + 500;
    if (t.nextLandAt < earliest) {
      t.nextLandAt = earliest;
    }

    var landHackAt = t.nextLandAt;

    // Reserve the window: 4 phases × gapMs
    t.nextLandAt = landHackAt + batchWindowMs + gapMs;
    t.activeBatches++;

    b.idle = false;
    b.currentBatchId = nextBatchId++;

    var slot = {
      type: "batchSlot",
      target: b.target,
      tag: b.tag,
      landHackAt: landHackAt,
      batchId: b.currentBatchId
    };

    ns.tryWritePort(b.replyPort, JSON.stringify(slot));
    ns.print("Assigned slot to " + b.tag + " land=" + landHackAt + " id=" + b.currentBatchId + " port=" + b.replyPort);
  }
}

/**
 * Removes batchers whose PID is no longer running.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {Map<string, RegisteredBatcher>} batchers
 * @param {Map<string, TargetState>} targets
 */
function pruneDeadBatchers(ns, batchers, targets) {
  for (var [tag, b] of batchers) {
    if (!ns.isRunning(b.pid, b.execHost)) {
      ns.print("Pruning dead batcher: " + tag);

      if (!b.idle) {
        var t = targets.get(b.target);
        if (t) {
          t.activeBatches = Math.max(0, t.activeBatches - 1);
        }
      }

      batchers.delete(tag);
    }
  }
}

/**
 * @param {import("NetscriptDefinitions").AutocompleteData} data
 * @param {string[]} args
 * @returns {string[]}
 */
export function autocomplete(data, args) {
  return [];
}
