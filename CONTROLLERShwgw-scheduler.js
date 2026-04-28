/**
 * hwgw-scheduler.js - Central coordinator for multi-host HWGW batching.
 *
 * Communication:
 *   Port 2 (REGISTER_PORT): batcher -> scheduler
 *     { type:"register", execHost, target, tag, pid, replyPort }
 *   Port <replyPort>: scheduler -> batcher
 *     { type:"batchSlot", target, tag, landHackAt, batchId }
 *   Port 4 (COMPLETE_PORT): batcher -> scheduler
 *     { type:"batchDone", target, tag, batchId, success }
 *
 * @param {import("NetscriptDefinitions").NS} ns
 */

const REGISTER_PORT = 2;
const COMPLETE_PORT = 4;

const POLL_MS = 50;
const DEFAULT_GAP_MS = 100;
const BATCH_WINDOW_MULT = 4;

// Defensive caps keep the scheduler loop responsive under heavy message load.
const MAX_REGISTER_DRAIN_PER_TICK = 250;
const MAX_COMPLETE_DRAIN_PER_TICK = 250;

// If a batcher never reports completion, reclaim it after this timeout.
const ASSIGNMENT_TIMEOUT_MS = 180000;

const JOURNAL_MAX_CHARS = 200000;
const JOURNAL_TRIM_TO_CHARS = 100000;

var gEnableJournal = true;
var gJournalFile = "/logs/hwgw-journal-scheduler.log";
var gJournalWrites = 0;

/**
 * @typedef {{
 *   hostname: string,
 *   nextLandAt: number,
 *   activeBatches: number
 * }} TargetState
 */

/**
 * @typedef {{
 *   execHost: string,
 *   target: string,
 *   tag: string,
 *   pid: number,
 *   replyPort: number,
 *   idle: boolean,
 *   currentBatchId: number,
 *   assignedAt: number,
 *   lastSeenAt: number
 * }} RegisteredBatcher
 */

/**
 * @param {import("NetscriptDefinitions").NS} ns
 */
export async function main(ns) {
  var gapMs = Math.max(20, Number(ns.args[0]) || DEFAULT_GAP_MS);
  gEnableJournal = ns.args.length < 2 ? true : Boolean(ns.args[1]);

  ns.disableLog("ALL");

  /** @type {Map<string, TargetState>} */
  var targets = new Map();
  /** @type {Map<string, RegisteredBatcher>} */
  var batchers = new Map();
  var nextBatchId = 1;

  ns.print("Scheduler started. gapMs=" + gapMs);
  ns.tprint("HWGW Scheduler started (PID " + ns.pid + "). gapMs=" + gapMs);
  journal(ns, "INFO", "scheduler", "started gapMs=" + gapMs + " journal=" + gEnableJournal);

  while (true) {
    drainRegisters(ns, targets, batchers);
    drainCompletions(ns, targets, batchers);

    reclaimTimedOutAssignments(ns, targets, batchers);
    nextBatchId = assignSlots(ns, targets, batchers, gapMs, nextBatchId);
    pruneDeadBatchers(ns, targets, batchers);

    await ns.sleep(POLL_MS);
  }
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {Map<string, TargetState>} targets
 * @param {Map<string, RegisteredBatcher>} batchers
 */
function drainRegisters(ns, targets, batchers) {
  for (var i = 0; i < MAX_REGISTER_DRAIN_PER_TICK; i++) {
    var raw = ns.readPort(REGISTER_PORT);
    if (raw === "NULL PORT DATA") {
      return;
    }

    var msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (_) {
      continue;
    }

    if (!msg || msg.type !== "register") {
      continue;
    }

    if (typeof msg.tag !== "string" || !msg.tag) {
      continue;
    }
    if (typeof msg.target !== "string" || !msg.target) {
      continue;
    }
    if (typeof msg.execHost !== "string" || !msg.execHost) {
      continue;
    }
    if (!Number.isFinite(Number(msg.pid)) || !Number.isFinite(Number(msg.replyPort))) {
      continue;
    }

    handleRegister(ns, /** @type {{execHost:string,target:string,tag:string,pid:number,replyPort:number}} */ (msg), targets, batchers);
  }
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {{execHost:string,target:string,tag:string,pid:number,replyPort:number}} msg
 * @param {Map<string, TargetState>} targets
 * @param {Map<string, RegisteredBatcher>} batchers
 */
function handleRegister(ns, msg, targets, batchers) {
  var now = Date.now();

  if (!targets.has(msg.target)) {
    targets.set(msg.target, {
      hostname: msg.target,
      nextLandAt: 0,
      activeBatches: 0
    });
  }

  var existing = batchers.get(msg.tag);
  if (!existing) {
    batchers.set(msg.tag, {
      execHost: msg.execHost,
      target: msg.target,
      tag: msg.tag,
      pid: msg.pid,
      replyPort: msg.replyPort,
      idle: true,
      currentBatchId: 0,
      assignedAt: 0,
      lastSeenAt: now
    });
    ns.print("Registered batcher: " + msg.tag + " (" + msg.execHost + " -> " + msg.target + ") port=" + msg.replyPort);
    journal(ns, "INFO", "register", "new tag=" + msg.tag + " host=" + msg.execHost + " target=" + msg.target + " port=" + msg.replyPort);
    return;
  }

  // Same tag with different pid means a restart. Reset state safely.
  var restarted = existing.pid !== msg.pid;
  if (restarted && !existing.idle) {
    var priorTarget = targets.get(existing.target);
    if (priorTarget) {
      priorTarget.activeBatches = Math.max(0, priorTarget.activeBatches - 1);
    }
  }

  existing.execHost = msg.execHost;
  existing.target = msg.target;
  existing.pid = msg.pid;
  existing.replyPort = msg.replyPort;
  existing.lastSeenAt = now;

  if (restarted) {
    existing.idle = true;
    existing.currentBatchId = 0;
    existing.assignedAt = 0;
    ns.print("Batcher restarted: " + msg.tag + " newPid=" + msg.pid);
    journal(ns, "WARN", "register", "restart tag=" + msg.tag + " pid=" + msg.pid);
  }
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {Map<string, TargetState>} targets
 * @param {Map<string, RegisteredBatcher>} batchers
 */
function drainCompletions(ns, targets, batchers) {
  for (var i = 0; i < MAX_COMPLETE_DRAIN_PER_TICK; i++) {
    var raw = ns.readPort(COMPLETE_PORT);
    if (raw === "NULL PORT DATA") {
      return;
    }

    var msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (_) {
      continue;
    }

    if (!msg || msg.type !== "batchDone") {
      continue;
    }

    handleBatchDone(ns, /** @type {{target:string,tag:string,batchId:number,success:boolean}} */ (msg), targets, batchers);
  }
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {{target:string,tag:string,batchId:number,success:boolean}} msg
 * @param {Map<string, TargetState>} targets
 * @param {Map<string, RegisteredBatcher>} batchers
 */
function handleBatchDone(ns, msg, targets, batchers) {
  var b = batchers.get(msg.tag);
  if (!b) {
    return;
  }

  // Ignore stale or duplicate completions.
  if (b.idle || b.currentBatchId !== msg.batchId) {
    return;
  }

  b.idle = true;
  b.assignedAt = 0;

  var t = targets.get(b.target);
  if (t) {
    t.activeBatches = Math.max(0, t.activeBatches - 1);
  }

  ns.print("Batch done: " + msg.tag + " id=" + msg.batchId + " ok=" + msg.success);
  journal(ns, "INFO", "complete", "tag=" + msg.tag + " batchId=" + msg.batchId + " ok=" + msg.success);
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {Map<string, TargetState>} targets
 * @param {Map<string, RegisteredBatcher>} batchers
 */
function reclaimTimedOutAssignments(ns, targets, batchers) {
  var now = Date.now();

  for (var [, b] of batchers) {
    if (b.idle) {
      continue;
    }

    if (now - b.assignedAt < ASSIGNMENT_TIMEOUT_MS) {
      continue;
    }

    var t = targets.get(b.target);
    if (t) {
      t.activeBatches = Math.max(0, t.activeBatches - 1);
    }
    b.idle = true;
    b.assignedAt = 0;
    ns.print("Reclaimed timed-out assignment: " + b.tag + " id=" + b.currentBatchId);
    journal(ns, "WARN", "timeout", "reclaimed tag=" + b.tag + " batchId=" + b.currentBatchId);
  }
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {Map<string, TargetState>} targets
 * @param {Map<string, RegisteredBatcher>} batchers
 * @param {number} gapMs
 * @param {number} nextBatchId
 * @returns {number}
 */
function assignSlots(ns, targets, batchers, gapMs, nextBatchId) {
  var now = Date.now();
  var batchWindowMs = BATCH_WINDOW_MULT * gapMs;

  for (var [, b] of batchers) {
    if (!b.idle) {
      continue;
    }
    if (!ns.isRunning(b.pid, b.execHost)) {
      continue;
    }

    var t = targets.get(b.target);
    if (!t) {
      continue;
    }

    var weakenTime;
    try {
      weakenTime = ns.getWeakenTime(b.target);
    } catch (_) {
      continue;
    }

    var earliest = now + weakenTime + (5 * gapMs) + 500;
    if (t.nextLandAt < earliest) {
      t.nextLandAt = earliest;
    }

    var landHackAt = t.nextLandAt;
    var slot = {
      type: "batchSlot",
      target: b.target,
      tag: b.tag,
      landHackAt: landHackAt,
      batchId: nextBatchId
    };

    if (!ns.tryWritePort(b.replyPort, JSON.stringify(slot))) {
      continue;
    }

    t.nextLandAt = landHackAt + batchWindowMs + gapMs;
    t.activeBatches++;
    b.idle = false;
    b.currentBatchId = nextBatchId;
    b.assignedAt = now;

    ns.print("Assigned slot to " + b.tag + " land=" + landHackAt + " id=" + nextBatchId + " port=" + b.replyPort);
    journal(ns, "INFO", "assign", "tag=" + b.tag + " batchId=" + nextBatchId + " landHackAt=" + landHackAt);
    nextBatchId++;
  }

  return nextBatchId;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {Map<string, TargetState>} targets
 * @param {Map<string, RegisteredBatcher>} batchers
 */
function pruneDeadBatchers(ns, targets, batchers) {
  for (var [tag, b] of batchers) {
    if (ns.isRunning(b.pid, b.execHost)) {
      continue;
    }

    if (!b.idle) {
      var t = targets.get(b.target);
      if (t) {
        t.activeBatches = Math.max(0, t.activeBatches - 1);
      }
    }

    batchers.delete(tag);
    ns.print("Pruned dead batcher: " + tag);
    journal(ns, "WARN", "prune", "dead tag=" + tag + " host=" + b.execHost + " pid=" + b.pid);
  }
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} level
 * @param {string} scope
 * @param {string} message
 */
function journal(ns, level, scope, message) {
  if (!gEnableJournal || !gJournalFile) {
    return;
  }

  ns.write(gJournalFile, new Date().toISOString() + "|" + level + "|" + scope + "|" + message + "\n", "a");
  gJournalWrites++;

  if (gJournalWrites % 200 !== 0) {
    return;
  }

  var content = ns.read(gJournalFile);
  if (content.length <= JOURNAL_MAX_CHARS) {
    return;
  }

  ns.write(gJournalFile, content.slice(-JOURNAL_TRIM_TO_CHARS), "w");
}

/**
 * @param {import("NetscriptDefinitions").AutocompleteData} data
 * @param {string[]} args
 * @returns {string[]}
 */
export function autocomplete(data, args) {
  return [];
}
