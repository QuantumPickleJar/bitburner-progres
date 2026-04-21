/**
 * hwgw-batcher-v2.js — Formulas-aware HWGW batcher with coordinated scheduling.
 *
 * Runs on each execution host. Registers with the scheduler (port 2), receives
 * batch slot assignments (port 3), dispatches the HWGW batch to land at the
 * assigned time, then reports completion (port 4).
 *
 * Uses the Formulas API to compute thread counts at min-security / max-money,
 * eliminating drift-based miscalculations.
 *
 * Falls back to basic NS methods if Formulas is unavailable (unless --use-formulas / -f is passed,
 * in which case it will error).
 *
 * Args:
 *   [0] target       - target hostname
 *   [1] ramLimitGb   - soft RAM cap (-1 = all free RAM)
 *   [2] instanceTag  - log label (auto-generated if omitted)
 *
 * Flags:
 *   --use-formulas / -f   Require Formulas API (error if unavailable)
 *   --gap <ms>            Landing gap between HWGW phases (default 100)
 *   --hack <frac>         Hack fraction 0.001–0.95 (default 0.25)
 *   --poll <ms>           Poll interval (default 200)
 *
 * @param {import("NetscriptDefinitions").NS} ns
 */

const HACK_WORKER   = "/workers/hack-once.js";
const GROW_WORKER   = "/workers/grow-once.js";
const WEAKEN_WORKER = "/workers/weaken-once.js";
const WORKER_FILES  = [HACK_WORKER, GROW_WORKER, WEAKEN_WORKER];

const REGISTER_PORT = 2;
const COMPLETE_PORT = 4;
const THREAD_PORT   = 1;

/** Reply ports start at 100 to avoid colliding with well-known ports. Each batcher uses 100 + (pid % 900). */
const REPLY_PORT_BASE = 100;
const REPLY_PORT_RANGE = 900;

/**
 * @param {import("NetscriptDefinitions").NS} ns
 */
export async function main(ns) {
  // --- Parse flags ---
  /** @type {[string, string | number | boolean | string[]][]} */
  var flagSchema = [
    ["use-formulas", false],
    ["f", false],
    ["gap", 100],
    ["hack", 0.25],
    ["poll", 200]
  ];
  var flags = ns.flags(flagSchema);
  var requireFormulas = flags["use-formulas"] || flags["f"];
  var gapMs       = Math.max(20, Number(flags["gap"]));
  var desiredHack = clamp(Number(flags["hack"]), 0.001, 0.95);
  var pollMs      = Math.max(20, Number(flags["poll"]));

  // Positional args: target, ramLimitGb, instanceTag
  var posArgs = /** @type {string[]} */ (flags._);
  var target      = posArgs.length > 0 ? String(posArgs[0]) : "";
  var execHost    = ns.getHostname();
  var ramLimitGb  = Math.max(-1, norm(posArgs.length > 1 ? posArgs[1] : undefined, -1));
  var instanceTag = posArgs.length > 2 ? String(posArgs[2]) : (target + "@" + execHost + "-" + Date.now());

  ns.disableLog("ALL");

  // --- Validation ---
  if (!target) throw new Error("hwgw-batcher-v2: target hostname required as arg[0].");
  if (!ns.serverExists(target)) throw new Error("Target does not exist: " + target);
  if (!ns.hasRootAccess(target)) throw new Error("No root on target: " + target);
  if (!ns.hasRootAccess(execHost)) throw new Error("No root on exec host: " + execHost);

  for (var w = 0; w < WORKER_FILES.length; w++) {
    if (!ns.fileExists(WORKER_FILES[w], execHost)) {
      throw new Error("Missing worker on " + execHost + ": " + WORKER_FILES[w]);
    }
  }

  // --- Formulas detection ---
  var useFormulas = false;
  try {
    ns.formulas.hacking.hackPercent(ns.getServer(target), ns.getPlayer());
    useFormulas = true;
  } catch (_) {
    if (requireFormulas) {
      throw new Error("Formulas API required (--use-formulas) but not available.");
    }
    ns.print("Formulas API not available; using basic NS methods.");
  }

  // --- Prep target to ideal state BEFORE registering ---
  // Registration must happen after prep so the scheduler doesn't assign a slot
  // that expires while the batcher is still growing/weakening the target.
  var replyPort = REPLY_PORT_BASE + (ns.pid % REPLY_PORT_RANGE);
  await prepTarget(ns, target, execHost, ramLimitGb, pollMs, instanceTag, useFormulas);

  // --- Register with scheduler ---
  // Clear any stale port data accumulated during prep (e.g. from a prior run
  // that shared the same PID mod-range), then register.
  ns.clearPort(replyPort);

  var regPayload = JSON.stringify({
    type: "register",
    execHost: execHost,
    target: target,
    tag: instanceTag,
    pid: ns.pid,
    replyPort: replyPort
  });
  for (var _ri = 0; _ri < 10; _ri++) {
    if (ns.tryWritePort(REGISTER_PORT, regPayload)) break;
    await ns.sleep(200);
  }
  ns.print("[" + instanceTag + "] Registered with scheduler. replyPort=" + replyPort);

  // --- Pipelined batch loop ---
  // Dispatch completes in milliseconds (workers handle their own timing).
  // Report done immediately after each dispatch so the scheduler assigns the
  // next slot right away. planBatch re-runs each iteration against the *actual*
  // current free RAM, so it naturally caps pipeline depth: once inflight workers
  // saturate the budget, planBatch returns null and we wait.
  /** @type {Array<{batchId: number, jobs: Array<{pid:number, name:string, threads:number}>}>} */
  var inflightBatches = [];
  // Tracks whether the last planBatch call returned null (RAM saturated).
  // When transitioning back to a valid plan, we re-register so the scheduler
  // knows we are ready — it may have us marked non-idle from before saturation.
  var prevPlanNull = false;

  while (true) {
    // Prune finished batches and compute aggregate thread counts for snapshot
    var h = 0, g = 0, w = 0;
    for (var ib = inflightBatches.length - 1; ib >= 0; ib--) {
      var ibatch = inflightBatches[ib];
      var ibDone = true;
      for (var ji = ibatch.jobs.length - 1; ji >= 0; ji--) {
        if (!ns.isRunning(ibatch.jobs[ji].pid, execHost)) {
          ibatch.jobs.splice(ji, 1);
          continue;
        }
        ibDone = false;
        var jn = ibatch.jobs[ji].name;
        if      (jn === "hack") h += ibatch.jobs[ji].threads;
        else if (jn === "grow") g += ibatch.jobs[ji].threads;
        else                    w += ibatch.jobs[ji].threads;
      }
      if (ibDone) inflightBatches.splice(ib, 1);
    }
    snapshot(ns, execHost, target, instanceTag, h, g, w);

    // Plan next batch using real-time free RAM (all inflight workers already counted)
    var plan = planBatch(ns, target, execHost, ramLimitGb, desiredHack, gapMs, useFormulas);

    if (!plan) {
      prevPlanNull = true;
      if (inflightBatches.length === 0) {
        // Nothing running and can't fit a batch → target drifted, re-prep
        await prepTarget(ns, target, execHost, ramLimitGb, pollMs, instanceTag, useFormulas);
      } else {
        // RAM saturated by inflight batches — wait for one to free up
        await ns.sleep(pollMs);
      }
      continue;
    }

    if (prevPlanNull) {
      // Coming out of RAM saturation: the scheduler may have us as non-idle
      // (it marked idle=false when it last assigned, and we never consumed
      // subsequent slots because the port filled up). Re-register to reset its
      // state so it will assign a fresh slot.
      prevPlanNull = false;
      ns.print("[" + instanceTag + "] RAM freed — re-registering to request slot.");
      for (var _r = 0; _r < 10; _r++) {
        if (ns.tryWritePort(REGISTER_PORT, regPayload)) break;
        await ns.sleep(200);
      }
    }

    // Wait for next slot assignment from scheduler
    var slot = await waitForSlot(ns, instanceTag, replyPort, pollMs);

    if (!slot) {
      // Timeout — scheduler may have restarted; treat as saturation exit
      prevPlanNull = true;
      ns.print("[" + instanceTag + "] Slot timeout — re-registering with scheduler.");
      for (var _rt = 0; _rt < 10; _rt++) {
        if (ns.tryWritePort(REGISTER_PORT, regPayload)) break;
        await ns.sleep(500);
      }
      await ns.sleep(500);
      continue;
    }

    // Dispatch (near-instant: all workers launched with their delay as arg)
    var result = dispatchBatch(ns, target, execHost, plan, slot.landHackAt, gapMs, ramLimitGb, instanceTag);

    if (result.success) {
      inflightBatches.push({ batchId: slot.batchId, jobs: result.launchedJobs });
      // Report done immediately — workers are running with internal delays
      reportDone(ns, target, instanceTag, slot.batchId, true);
      ns.print("[" + instanceTag + "] Batch " + slot.batchId + " dispatched." +
               " inflight=" + inflightBatches.length +
               " peakRam=" + plan.peakRam.toFixed(0) + "GB");
    } else {
      reportDone(ns, target, instanceTag, slot.batchId, false);
      // Wait for any partially-launched workers before re-prepping
      for (var pk = 0; pk < result.launchedJobs.length; pk++) {
        while (ns.isRunning(result.launchedJobs[pk].pid, execHost)) {
          await ns.sleep(pollMs);
        }
      }
      await prepTarget(ns, target, execHost, ramLimitGb, pollMs, instanceTag, useFormulas);
    }
  }
}

// ─── Slot Communication ──────────────────────────────────────────────

/**
 * Waits for a batchSlot message on this batcher's dedicated reply port.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} tag
 * @param {number} replyPort
 * @param {number} pollMs
 * @returns {Promise<{target:string, tag:string, landHackAt:number, batchId:number}|null>}
 */
async function waitForSlot(ns, tag, replyPort, pollMs) {
  // 10 s timeout — short enough that a restarted scheduler is noticed quickly
  // without being so tight that normal scheduling latency causes false timeouts.
  var deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    var raw = ns.readPort(replyPort);
    if (raw !== "NULL PORT DATA") {
      var msg;
      try { msg = JSON.parse(String(raw)); } catch (_) { continue; }

      if (msg.type === "batchSlot" && msg.tag === tag) {
        // Discard stale slots — landHackAt must be far enough in the future
        // that we can still schedule at least the weaken worker (the last to
        // start). A slot is usable if there is still time to sleep before launch.
        var minLeadMs = 500;
        if (msg.landHackAt - Date.now() < minLeadMs) {
          ns.print("[" + tag + "] Discarding stale slot id=" + msg.batchId +
                   " (landHackAt already passed or too soon)");
          continue;
        }
        return msg;
      }
      // Not for us (shouldn't happen with dedicated ports) — discard
    }
    await ns.sleep(pollMs);
  }

  ns.print("[" + tag + "] Timed out waiting for batch slot.");
  return null;
}

/**
 * Reports batch completion to the scheduler.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} tag
 * @param {number} batchId
 * @param {boolean} success
 */
function reportDone(ns, target, tag, batchId, success) {
  ns.tryWritePort(COMPLETE_PORT, JSON.stringify({
    type: "batchDone",
    target: target,
    tag: tag,
    batchId: batchId,
    success: success
  }));
}

// ─── Prep ────────────────────────────────────────────────────────────

/**
 * Preps target to max money / min security. Grows first, then weakens (avoids ping-pong).
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {number} ramLimitGb
 * @param {number} pollMs
 * @param {string} instanceTag
 * @param {boolean} useFormulas
 * @returns {Promise<void>}
 */
async function prepTarget(ns, target, execHost, ramLimitGb, pollMs, instanceTag, useFormulas) {
  var moneyReadyPct = 0.999;
  var secReadyBuffer = 0.5;

  while (true) {
    var maxMoney  = ns.getServerMaxMoney(target);
    var curMoney  = ns.getServerMoneyAvailable(target);
    var minSec    = ns.getServerMinSecurityLevel(target);
    var curSec    = ns.getServerSecurityLevel(target);

    // Grow first
    if (curMoney < maxMoney * moneyReadyPct) {
      var growNeeded = estimateGrowThreads(ns, target, execHost, curMoney, maxMoney, useFormulas);
      var maxGrow = maxThreads(ns, GROW_WORKER, execHost, ramLimitGb);
      if (maxGrow < 1) {
        // No RAM available right now — gate, don't error. Wait and retry.
        ns.print("[" + instanceTag + "] prep: waiting for free RAM (grow)...");
        snapshot(ns, execHost, target, instanceTag, 0, 0, 0);
        await ns.sleep(pollMs * 5);
        continue;
      }
      var gt = Math.min(growNeeded, maxGrow);
      var pid = ns.exec(GROW_WORKER, execHost, gt, target);
      if (pid === 0) { snapshot(ns, execHost, target, instanceTag, 0, 0, 0); await ns.sleep(pollMs); continue; }
      await waitPid(ns, execHost, target, pid, "grow", gt, pollMs, instanceTag);
      continue;
    }

    // Then weaken
    if (curSec > minSec + secReadyBuffer) {
      var wkNeeded = estimateWeakenThreads(ns, execHost, curSec - minSec);
      var maxWk = maxThreads(ns, WEAKEN_WORKER, execHost, ramLimitGb);
      if (maxWk < 1) {
        // No RAM available right now — gate, don't error. Wait and retry.
        ns.print("[" + instanceTag + "] prep: waiting for free RAM (weaken)...");
        snapshot(ns, execHost, target, instanceTag, 0, 0, 0);
        await ns.sleep(pollMs * 5);
        continue;
      }
      var wt = Math.min(wkNeeded, maxWk);
      var pidW = ns.exec(WEAKEN_WORKER, execHost, wt, target);
      if (pidW === 0) { snapshot(ns, execHost, target, instanceTag, 0, 0, 0); await ns.sleep(pollMs); continue; }
      await waitPid(ns, execHost, target, pidW, "weaken-prep", wt, pollMs, instanceTag);
      continue;
    }

    snapshot(ns, execHost, target, instanceTag, 0, 0, 0);
    return;
  }
}

// ─── Batch Planning ──────────────────────────────────────────────────

/**
 * @typedef {{
 *   hackThreads: number,
 *   weakenHackThreads: number,
 *   growThreads: number,
 *   weakenGrowThreads: number,
 *   hackFraction: number,
 *   jobs: Array<{name:string, script:string, threads:number, startOffset:number, endOffset:number, ram:number}>,
 *   peakRam: number,
 *   weakenTime: number
 * }} BatchPlanV2
 */

/**
 * Plans a batch that maximises RAM usage.
 *
 * Phase 1 – downward search: start at `desiredHack` (the minimum acceptable
 * fraction), scaling by 0.9 each step until a plan fits in available RAM.
 *
 * Phase 2 – upward binary search: if the fitting plan uses less than 85% of
 * available RAM there is headroom, so binary-search upward toward 0.95 to find
 * the largest fraction that still fits.  This fills the server's RAM instead of
 * leaving 90 %+ idle.
 *
 * Uses Formulas API if available for accurate thread counts at min-sec.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {number} ramLimitGb
 * @param {number} desiredHack  Minimum hack fraction (floor, not ceiling)
 * @param {number} gapMs
 * @param {boolean} useFormulas
 * @returns {BatchPlanV2|null}
 */
function planBatch(ns, target, execHost, ramLimitGb, desiredHack, gapMs, useFormulas) {
  var availRam = plannerFree(ns, execHost, ramLimitGb);
  if (availRam <= 0) return null;

  // Pre-fetch constants (shared by tryFraction closure below)
  var cores   = ns.getServer(execHost).cpuCores;
  var player  = ns.getPlayer();

  var hackRam   = ns.getScriptRam(HACK_WORKER, execHost);
  var growRam   = ns.getScriptRam(GROW_WORKER, execHost);
  var weakenRam = ns.getScriptRam(WEAKEN_WORKER, execHost);

  // Use Formulas with min-sec server for accurate timing/thread counts
  /** @type {import("NetscriptDefinitions").Server} */
  var idealServer = ns.getServer(target);
  if (useFormulas) {
    idealServer.hackDifficulty = idealServer.minDifficulty;
    idealServer.moneyAvailable = idealServer.moneyMax;
  }

  var hackTime = 0, growTime = 0, weakenTime = 0;
  if (useFormulas) {
    hackTime   = ns.formulas.hacking.hackTime(idealServer, player);
    growTime   = ns.formulas.hacking.growTime(idealServer, player);
    weakenTime = ns.formulas.hacking.weakenTime(idealServer, player);
  } else {
    hackTime   = ns.getHackTime(target);
    growTime   = ns.getGrowTime(target);
    weakenTime = ns.getWeakenTime(target);
  }

  var weakenPerThread = ns.weakenAnalyze(1, cores);

  // ── Inner helper: compute a plan for a given fraction, null if RAM doesn't fit ──
  /** @param {number} frac */
  function tryFraction(frac) {
    // --- Hack threads ---
    var hackPerThread;
    if (useFormulas) {
      hackPerThread = ns.formulas.hacking.hackPercent(idealServer, player);
    } else {
      hackPerThread = Math.max(1e-9, ns.hackAnalyze(target));
    }
    var hackThreads = Math.max(1, Math.ceil(frac / hackPerThread));
    var actualHackFraction = Math.min(hackThreads * hackPerThread, 0.95);

    // --- Weaken-after-hack ---
    var hackSecInc = ns.hackAnalyzeSecurity(hackThreads, target);
    var weakenHackThreads = Math.max(1, Math.ceil(hackSecInc / weakenPerThread));

    // --- Grow threads ---
    var growThreads;
    if (useFormulas) {
      // Use formulas.hacking.growThreads with ideal server at post-hack money
      var postHackServer = ns.getServer(target);
      var postHackMax = postHackServer.moneyMax || 0;
      postHackServer.hackDifficulty  = postHackServer.minDifficulty;
      postHackServer.moneyAvailable  = postHackMax * (1 - actualHackFraction);
      growThreads = ns.formulas.hacking.growThreads(postHackServer, player, postHackMax, cores);
    } else {
      var growMult = 1 / Math.max(0.05, 1 - actualHackFraction);
      var rawGrow = ns.growthAnalyze(target, growMult, cores);
      growThreads = (!Number.isFinite(rawGrow) || rawGrow < 1) ? 1 : Math.ceil(rawGrow);
    }
    growThreads = Math.max(1, growThreads);

    // --- Weaken-after-grow ---
    var growSecInc = ns.growthAnalyzeSecurity(growThreads, target, cores);
    var weakenGrowThreads = Math.max(1, Math.ceil(growSecInc / weakenPerThread));

    // --- Build job list ---
    var jobs = [
      { name: "hack",        script: HACK_WORKER,   threads: hackThreads,        startOffset: -hackTime,                endOffset: 0,          ram: hackRam * hackThreads },
      { name: "weaken-hack", script: WEAKEN_WORKER,  threads: weakenHackThreads,  startOffset: gapMs - weakenTime,       endOffset: gapMs,      ram: weakenRam * weakenHackThreads },
      { name: "grow",        script: GROW_WORKER,    threads: growThreads,         startOffset: 2 * gapMs - growTime,     endOffset: 2 * gapMs,  ram: growRam * growThreads },
      { name: "weaken-grow", script: WEAKEN_WORKER,  threads: weakenGrowThreads,   startOffset: 3 * gapMs - weakenTime,   endOffset: 3 * gapMs,  ram: weakenRam * weakenGrowThreads }
    ];

    var peak = peakRam(jobs);
    if (peak > availRam) return null;

    return {
      hackThreads: hackThreads,
      weakenHackThreads: weakenHackThreads,
      growThreads: growThreads,
      weakenGrowThreads: weakenGrowThreads,
      hackFraction: actualHackFraction,
      jobs: jobs,
      peakRam: peak,
      weakenTime: weakenTime
    };
  }

  // Find the first fitting plan by scaling DOWN from desiredHack.
  // In the pipelined model, batch size is intentionally kept at the configured
  // hack fraction — pipeline depth (many concurrent batches) handles throughput.
  // An upward fill search would produce a few giant batches instead of hundreds
  // of small ones, which is worse for income.
  var fraction = desiredHack;
  for (var i = 0; i < 40; i++) {
    var plan = tryFraction(fraction);
    if (plan) return plan;
    fraction *= 0.9;
  }
  return null;
}

// ─── Dispatch ────────────────────────────────────────────────────────

/**
 * Dispatches a batch with a specific landHackAt time assigned by the scheduler.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {BatchPlanV2} plan
 * @param {number} landHackAt
 * @param {number} gapMs
 * @param {number} ramLimitGb
 * @param {string} instanceTag
 * @returns {{success:boolean, launchedJobs:Array<{pid:number,name:string,threads:number}>}}
 */
function dispatchBatch(ns, target, execHost, plan, landHackAt, gapMs, ramLimitGb, instanceTag) {
  var schedule = [];
  for (var i = 0; i < plan.jobs.length; i++) {
    schedule.push({
      name:    plan.jobs[i].name,
      script:  plan.jobs[i].script,
      threads: plan.jobs[i].threads,
      ram:     plan.jobs[i].ram,
      startAt: landHackAt + plan.jobs[i].startOffset
    });
  }
  schedule.sort(function(a, b) { return a.startAt - b.startAt; });

  // Launch all workers immediately, passing their individual delays as arg[1].
  // Workers already support a delayMs argument, so they sleep internally.
  // This makes dispatch complete in milliseconds rather than blocking for hackTime.
  var launchedJobs = [];
  for (var j = 0; j < schedule.length; j++) {
    var workerDelay = Math.max(0, schedule[j].startAt - Date.now());

    var free = plannerFree(ns, execHost, ramLimitGb);
    if (schedule[j].ram > free) {
      ns.print("[" + instanceTag + "] RAM shortage for " + schedule[j].name);
      return { success: false, launchedJobs: launchedJobs };
    }

    var pid = ns.exec(schedule[j].script, execHost, schedule[j].threads, target, workerDelay);
    if (pid === 0) {
      ns.print("[" + instanceTag + "] Launch failed: " + schedule[j].name);
      return { success: false, launchedJobs: launchedJobs };
    }
    launchedJobs.push({ pid: pid, name: schedule[j].name, threads: schedule[j].threads });
  }
  return { success: true, launchedJobs: launchedJobs };
}

// ─── Wait / Heartbeat ────────────────────────────────────────────────

/**
 * Waits for all batch jobs to finish, publishing thread snapshots.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} execHost
 * @param {string} target
 * @param {Array<{pid:number,name:string,threads:number}>} jobs
 * @param {number} pollMs
 * @param {string} instanceTag
 * @returns {Promise<void>}
 */
async function waitForBatchJobs(ns, execHost, target, jobs, pollMs, instanceTag) {
  var live = jobs.slice();
  while (live.length > 0) {
    var h = 0, g = 0, w = 0;
    for (var i = live.length - 1; i >= 0; i--) {
      if (!ns.isRunning(live[i].pid, execHost)) { live.splice(i, 1); continue; }
      if (live[i].name === "hack") h += live[i].threads;
      else if (live[i].name === "grow") g += live[i].threads;
      else w += live[i].threads;
    }
    snapshot(ns, execHost, target, instanceTag, h, g, w);
    if (live.length > 0) await ns.sleep(pollMs);
  }
  snapshot(ns, execHost, target, instanceTag, 0, 0, 0);
}

/**
 * Waits for a single PID (used during prep).
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} execHost
 * @param {string} target
 * @param {number} pid
 * @param {string} jobName
 * @param {number} threads
 * @param {number} pollMs
 * @param {string} instanceTag
 * @returns {Promise<void>}
 */
async function waitPid(ns, execHost, target, pid, jobName, threads, pollMs, instanceTag) {
  while (ns.isRunning(pid, execHost)) {
    snapshot(
      ns, execHost, target, instanceTag,
      jobName === "hack" ? threads : 0,
      jobName === "grow" ? threads : 0,
      jobName.indexOf("weaken") !== -1 ? threads : 0
    );
    await ns.sleep(pollMs);
  }
  snapshot(ns, execHost, target, instanceTag, 0, 0, 0);
}

// ─── Thread Snapshot ─────────────────────────────────────────────────

/**
 * Publishes a thread snapshot heartbeat on port 1.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} execHost
 * @param {string} target
 * @param {string} instanceTag
 * @param {number} hack
 * @param {number} grow
 * @param {number} weaken
 */
function snapshot(ns, execHost, target, instanceTag, hack, grow, weaken) {
  var h = Math.max(0, Math.floor(hack));
  var g = Math.max(0, Math.floor(grow));
  var w = Math.max(0, Math.floor(weaken));
  ns.tryWritePort(THREAD_PORT, JSON.stringify({
    type: "threadSnapshot",
    source: String(execHost),
    target: String(target),
    tag: String(instanceTag),
    controllerPid: ns.pid,
    hack: h, grow: g, weaken: w,
    total: h + g + w,
    ts: Date.now()
  }));
}

// ─── Utility ─────────────────────────────────────────────────────────

/**
 * Estimates grow threads needed to reach max money.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {number} curMoney
 * @param {number} maxMoney
 * @param {boolean} useFormulas
 * @returns {number}
 */
function estimateGrowThreads(ns, target, execHost, curMoney, maxMoney, useFormulas) {
  var cores = ns.getServer(execHost).cpuCores;
  var money = Math.max(1, curMoney);

  if (useFormulas) {
    var srv = ns.getServer(target);
    srv.hackDifficulty  = srv.minDifficulty;
    srv.moneyAvailable  = money;
    return Math.max(1, ns.formulas.hacking.growThreads(srv, ns.getPlayer(), maxMoney, cores));
  }

  var mult = Math.max(1, maxMoney / money);
  var raw = ns.growthAnalyze(target, mult, cores);
  return Math.max(1, (!Number.isFinite(raw) ? 1 : Math.ceil(raw)));
}

/**
 * Estimates weaken threads to drop security by a given amount.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} execHost
 * @param {number} secGap
 * @returns {number}
 */
function estimateWeakenThreads(ns, execHost, secGap) {
  var cores = ns.getServer(execHost).cpuCores;
  var per = ns.weakenAnalyze(1, cores);
  return Math.max(1, Math.ceil(Math.max(0, secGap) / per));
}

/**
 * Returns planner-visible free RAM.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} host
 * @param {number} ramLimitGb
 * @returns {number}
 */
function plannerFree(ns, host, ramLimitGb) {
  var free = Math.max(0, ns.getServerMaxRam(host) - ns.getServerUsedRam(host));
  return ramLimitGb < 0 ? free : Math.max(0, Math.min(free, ramLimitGb));
}

/**
 * Returns max threads for a script given planner RAM.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} script
 * @param {string} host
 * @param {number} ramLimitGb
 * @returns {number}
 */
function maxThreads(ns, script, host, ramLimitGb) {
  var free = plannerFree(ns, host, ramLimitGb);
  var ram  = ns.getScriptRam(script, host);
  return ram <= 0 ? 0 : Math.floor(free / ram);
}

/**
 * Calculates peak concurrent RAM from job start/end offsets.
 *
 * @param {Array<{startOffset:number,endOffset:number,ram:number}>} jobs
 * @returns {number}
 */
function peakRam(jobs) {
  var events = [];
  for (var i = 0; i < jobs.length; i++) {
    events.push({ t: jobs[i].startOffset, d: jobs[i].ram });
    events.push({ t: jobs[i].endOffset,   d: -jobs[i].ram });
  }
  events.sort(function(a, b) { return a.t !== b.t ? a.t - b.t : a.d - b.d; });
  var cur = 0, max = 0;
  for (var j = 0; j < events.length; j++) {
    cur += events[j].d;
    if (cur > max) max = cur;
  }
  return max;
}

/**
 * Normalizes a value to a number with fallback.
 *
 * @param {unknown} v
 * @param {number} fb
 * @returns {number}
 */
function norm(v, fb) {
  if (v === undefined || v === null || v === "") return fb;
  var n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

/**
 * Clamps a number to [min, max].
 *
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * @param {import("NetscriptDefinitions").AutocompleteData} data
 * @param {string[]} args
 * @returns {string[]}
 */
export function autocomplete(data, args) {
  return data.servers.filter(/** @param {string} s */ function(s) { return !args.includes(s); });
}
