/**
 * hwgw-batcher-v2.js - Formulas-aware HWGW batcher with strict backpressure.
 *
 * This version intentionally keeps only one scheduler-assigned batch in flight
 * per batcher instance. It trades some peak throughput for runtime stability,
 * especially in browser-hosted environments where very deep delayed pipelines
 * can freeze the engine.
 *
 * Args:
 *   [0] target      - target hostname
 *   [1] ramLimitGb  - soft RAM cap (-1 = all currently free RAM)
 *   [2] instanceTag - optional tag for logs and scheduler identity
 *
 * Flags:
 *   --use-formulas / -f   Require Formulas API
 *   --gap <ms>            Landing gap between HWGW phases (default 100)
 *   --hack <frac>         Requested hack fraction 0.001-0.95 (default 0.25)
 *   --poll <ms>           Poll interval (default 200)
 *
 * @param {import("NetscriptDefinitions").NS} ns
 */

const HACK_WORKER = "/workers/hack-once.js";
const GROW_WORKER = "/workers/grow-once.js";
const WEAKEN_WORKER = "/workers/weaken-once.js";
const WORKER_FILES = [HACK_WORKER, GROW_WORKER, WEAKEN_WORKER];

const REGISTER_PORT = 2;
const COMPLETE_PORT = 4;
const THREAD_PORT = 1;

const DEFAULT_ENABLE_THREAD_SNAPSHOTS = false;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 2000;

const REGISTER_RETRY_MS = 250;
const REGISTER_HEARTBEAT_MS = 5000;
const SLOT_TIMEOUT_MS = 15000;

const JOURNAL_MAX_CHARS = 200000;
const JOURNAL_TRIM_TO_CHARS = 100000;

var gEnableThreadSnapshots = DEFAULT_ENABLE_THREAD_SNAPSHOTS;
var gSnapshotIntervalMs = DEFAULT_SNAPSHOT_INTERVAL_MS;
var gLastSnapshotAt = 0;
var gEnableJournal = true;
var gJournalFile = "";
var gJournalWrites = 0;

/**
 * @typedef {{
 *   hackThreads: number,
 *   weakenHackThreads: number,
 *   growThreads: number,
 *   weakenGrowThreads: number,
 *   hackFraction: number,
 *   jobs: Array<{name:string, script:string, threads:number, startOffset:number, endOffset:number, ram:number}>,
 *   reservedRam: number,
 *   peakRam: number,
 *   weakenTime: number
 * }} BatchPlanV2
 */

/**
 * @param {import("NetscriptDefinitions").NS} ns
 */
export async function main(ns) {
  /** @type {[string, string | number | boolean | string[]][]} */
  var flagSchema = [
    ["use-formulas", false],
    ["f", false],
    ["gap", 100],
    ["hack", 0.25],
    ["poll", 200],
    ["thread-snapshots", false],
    ["snapshot-interval", DEFAULT_SNAPSHOT_INTERVAL_MS],
    ["journal", true]
  ];

  var flags = ns.flags(flagSchema);
  var requireFormulas = Boolean(flags["use-formulas"] || flags["f"]);
  var gapMs = Math.max(20, Number(flags["gap"]));
  var desiredHack = clamp(Number(flags["hack"]), 0.001, 0.95);
  var pollMs = Math.max(20, Number(flags["poll"]));
  gEnableThreadSnapshots = Boolean(flags["thread-snapshots"]);
  gSnapshotIntervalMs = Math.max(200, Number(flags["snapshot-interval"]));
  gEnableJournal = Boolean(flags["journal"]);

  var posArgs = /** @type {string[]} */ (flags._);
  var target = posArgs.length > 0 ? String(posArgs[0]) : "";
  var execHost = ns.getHostname();
  var ramLimitGb = Math.max(-1, norm(posArgs.length > 1 ? posArgs[1] : undefined, -1));
  var instanceTag = posArgs.length > 2 ? String(posArgs[2]) : (target + "@" + execHost + "-" + Date.now());
  gJournalFile = "/logs/hwgw-journal-" + sanitizeFileToken(execHost) + "-" + sanitizeFileToken(instanceTag) + ".log";

  ns.disableLog("ALL");

  if (!target) throw new Error("hwgw-batcher-v2: target hostname required as arg[0].");
  if (!ns.serverExists(target)) throw new Error("Target does not exist: " + target);
  if (!ns.hasRootAccess(target)) throw new Error("No root on target: " + target);
  if (!ns.hasRootAccess(execHost)) throw new Error("No root on exec host: " + execHost);

  for (var i = 0; i < WORKER_FILES.length; i++) {
    if (!ns.fileExists(WORKER_FILES[i], execHost)) {
      throw new Error("Missing worker on " + execHost + ": " + WORKER_FILES[i]);
    }
  }

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

  await prepTarget(ns, target, execHost, ramLimitGb, pollMs, instanceTag, useFormulas);

  // Large positive port based on pid avoids collisions from pid modulo buckets.
  var replyPort = 100000 + ns.pid;
  ns.clearPort(replyPort);

  var regPayload = JSON.stringify({
    type: "register",
    execHost: execHost,
    target: target,
    tag: instanceTag,
    pid: ns.pid,
    replyPort: replyPort
  });

  await ensureRegistered(ns, regPayload);
  ns.print("[" + instanceTag + "] Registered with scheduler. replyPort=" + replyPort);
  journal(ns, "INFO", "batcher", "registered replyPort=" + replyPort + " snapshots=" + gEnableThreadSnapshots);

  var lastRegisterAt = Date.now();

  while (true) {
    if (Date.now() - lastRegisterAt >= REGISTER_HEARTBEAT_MS) {
      if (ns.tryWritePort(REGISTER_PORT, regPayload)) {
        lastRegisterAt = Date.now();
      }
    }

    var plan = planBatch(ns, target, execHost, ramLimitGb, desiredHack, gapMs, useFormulas);
    if (!plan) {
      snapshot(ns, execHost, target, instanceTag, 0, 0, 0);
      if (plannerFree(ns, execHost, ramLimitGb) <= 0) {
        await ns.sleep(pollMs);
      } else {
        await prepTarget(ns, target, execHost, ramLimitGb, pollMs, instanceTag, useFormulas);
      }
      continue;
    }

    var slot = await waitForSlot(ns, instanceTag, replyPort, pollMs, regPayload, lastRegisterAt);
    if (!slot) {
      journal(ns, "WARN", "batcher", "slot timeout; re-registering");
      await ensureRegistered(ns, regPayload);
      lastRegisterAt = Date.now();
      continue;
    }

    journal(ns, "INFO", "slot", "received batchId=" + slot.batchId + " landHackAt=" + slot.landHackAt);

    var dispatch = dispatchBatch(ns, target, execHost, plan, slot.landHackAt, ramLimitGb, instanceTag);
    if (!dispatch.success) {
      journal(ns, "WARN", "dispatch", "failed batchId=" + slot.batchId + " launchedJobs=" + dispatch.launchedJobs.length);
      reportDone(ns, target, instanceTag, slot.batchId, false);
      await waitForBatchJobs(ns, execHost, target, dispatch.launchedJobs, pollMs, instanceTag);
      await prepTarget(ns, target, execHost, ramLimitGb, pollMs, instanceTag, useFormulas);
      continue;
    }

    await waitForBatchJobs(ns, execHost, target, dispatch.launchedJobs, pollMs, instanceTag);
    reportDone(ns, target, instanceTag, slot.batchId, true);
    journal(ns, "INFO", "dispatch", "complete batchId=" + slot.batchId + " reservedRam=" + plan.reservedRam.toFixed(1));

    ns.print(
      "[" + instanceTag + "] Batch " + slot.batchId + " complete." +
      " peakRam=" + plan.peakRam.toFixed(1) + "GB" +
      " reservedRam=" + plan.reservedRam.toFixed(1) + "GB"
    );

    await ns.sleep(gapMs);
  }
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} regPayload
 * @returns {Promise<void>}
 */
async function ensureRegistered(ns, regPayload) {
  while (!ns.tryWritePort(REGISTER_PORT, regPayload)) {
    await ns.sleep(REGISTER_RETRY_MS);
  }
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} tag
 * @param {number} replyPort
 * @param {number} pollMs
 * @param {string} regPayload
 * @param {number} lastRegisterAt
 * @returns {Promise<{target:string,tag:string,landHackAt:number,batchId:number}|null>}
 */
async function waitForSlot(ns, tag, replyPort, pollMs, regPayload, lastRegisterAt) {
  var deadline = Date.now() + SLOT_TIMEOUT_MS;
  var lastBeat = lastRegisterAt;

  while (Date.now() < deadline) {
    if (Date.now() - lastBeat >= REGISTER_HEARTBEAT_MS) {
      if (ns.tryWritePort(REGISTER_PORT, regPayload)) {
        lastBeat = Date.now();
      }
    }

    var raw = ns.readPort(replyPort);
    if (raw !== "NULL PORT DATA") {
      var msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (_) {
        await ns.sleep(pollMs);
        continue;
      }

      if (!msg || msg.type !== "batchSlot" || msg.tag !== tag) {
        await ns.sleep(pollMs);
        continue;
      }

      var minLeadMs = 500;
      if (msg.landHackAt - Date.now() < minLeadMs) {
        ns.print("[" + tag + "] Discarded stale slot id=" + msg.batchId);
        journal(ns, "WARN", "slot", "stale batchId=" + msg.batchId);
        await ns.sleep(pollMs);
        continue;
      }

      return msg;
    }

    await ns.sleep(pollMs);
  }

  ns.print("[" + tag + "] Timed out waiting for slot.");
  return null;
}

/**
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

/**
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
    var maxMoney = ns.getServerMaxMoney(target);
    var curMoney = ns.getServerMoneyAvailable(target);
    var minSec = ns.getServerMinSecurityLevel(target);
    var curSec = ns.getServerSecurityLevel(target);

    if (curMoney < maxMoney * moneyReadyPct) {
      var growNeeded = estimateGrowThreads(ns, target, execHost, curMoney, maxMoney, useFormulas);
      var maxGrow = maxThreads(ns, GROW_WORKER, execHost, ramLimitGb);
      if (maxGrow < 1) {
        snapshot(ns, execHost, target, instanceTag, 0, 0, 0);
        await ns.sleep(pollMs * 3);
        continue;
      }

      var growThreads = Math.min(growNeeded, maxGrow);
      var growPid = ns.exec(GROW_WORKER, execHost, growThreads, target);
      if (growPid === 0) {
        await ns.sleep(pollMs);
        continue;
      }
      await waitPid(ns, execHost, target, growPid, "grow", growThreads, pollMs, instanceTag);
      continue;
    }

    if (curSec > minSec + secReadyBuffer) {
      var wkNeeded = estimateWeakenThreads(ns, execHost, curSec - minSec);
      var maxWk = maxThreads(ns, WEAKEN_WORKER, execHost, ramLimitGb);
      if (maxWk < 1) {
        snapshot(ns, execHost, target, instanceTag, 0, 0, 0);
        await ns.sleep(pollMs * 3);
        continue;
      }

      var wkThreads = Math.min(wkNeeded, maxWk);
      var wkPid = ns.exec(WEAKEN_WORKER, execHost, wkThreads, target);
      if (wkPid === 0) {
        await ns.sleep(pollMs);
        continue;
      }
      await waitPid(ns, execHost, target, wkPid, "weaken-prep", wkThreads, pollMs, instanceTag);
      continue;
    }

    snapshot(ns, execHost, target, instanceTag, 0, 0, 0);
    return;
  }
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {number} ramLimitGb
 * @param {number} desiredHack
 * @param {number} gapMs
 * @param {boolean} useFormulas
 * @returns {BatchPlanV2|null}
 */
function planBatch(ns, target, execHost, ramLimitGb, desiredHack, gapMs, useFormulas) {
  var availRam = plannerFree(ns, execHost, ramLimitGb);
  if (availRam <= 0) return null;

  var cores = ns.getServer(execHost).cpuCores;
  var player = ns.getPlayer();
  var hackRam = ns.getScriptRam(HACK_WORKER, execHost);
  var growRam = ns.getScriptRam(GROW_WORKER, execHost);
  var weakenRam = ns.getScriptRam(WEAKEN_WORKER, execHost);

  /** @type {import("NetscriptDefinitions").Server} */
  var idealServer = ns.getServer(target);
  if (useFormulas) {
    idealServer.hackDifficulty = idealServer.minDifficulty;
    idealServer.moneyAvailable = idealServer.moneyMax;
  }

  var hackTime = useFormulas ? ns.formulas.hacking.hackTime(idealServer, player) : ns.getHackTime(target);
  var growTime = useFormulas ? ns.formulas.hacking.growTime(idealServer, player) : ns.getGrowTime(target);
  var weakenTime = useFormulas ? ns.formulas.hacking.weakenTime(idealServer, player) : ns.getWeakenTime(target);
  var weakenPerThread = ns.weakenAnalyze(1, cores);

  /** @param {number} frac */
  function tryFraction(frac) {
    var hackPerThread = useFormulas
      ? ns.formulas.hacking.hackPercent(idealServer, player)
      : Math.max(1e-9, ns.hackAnalyze(target));

    var hackThreads = Math.max(1, Math.ceil(frac / hackPerThread));
    var actualHackFraction = Math.min(hackThreads * hackPerThread, 0.95);

    var hackSecInc = ns.hackAnalyzeSecurity(hackThreads, target);
    var weakenHackThreads = Math.max(1, Math.ceil(hackSecInc / weakenPerThread));

    var growThreads;
    if (useFormulas) {
      var postHack = ns.getServer(target);
      var maxMoney = postHack.moneyMax || 0;
      postHack.hackDifficulty = postHack.minDifficulty;
      postHack.moneyAvailable = maxMoney * (1 - actualHackFraction);
      growThreads = ns.formulas.hacking.growThreads(postHack, player, maxMoney, cores);
    } else {
      var growMult = 1 / Math.max(0.05, 1 - actualHackFraction);
      var rawGrow = ns.growthAnalyze(target, growMult, cores);
      growThreads = (!Number.isFinite(rawGrow) || rawGrow < 1) ? 1 : Math.ceil(rawGrow);
    }
    growThreads = Math.max(1, growThreads);

    var growSecInc = ns.growthAnalyzeSecurity(growThreads, target, cores);
    var weakenGrowThreads = Math.max(1, Math.ceil(growSecInc / weakenPerThread));

    var jobs = [
      {
        name: "hack",
        script: HACK_WORKER,
        threads: hackThreads,
        startOffset: -hackTime,
        endOffset: 0,
        ram: hackRam * hackThreads
      },
      {
        name: "weaken-hack",
        script: WEAKEN_WORKER,
        threads: weakenHackThreads,
        startOffset: gapMs - weakenTime,
        endOffset: gapMs,
        ram: weakenRam * weakenHackThreads
      },
      {
        name: "grow",
        script: GROW_WORKER,
        threads: growThreads,
        startOffset: (2 * gapMs) - growTime,
        endOffset: 2 * gapMs,
        ram: growRam * growThreads
      },
      {
        name: "weaken-grow",
        script: WEAKEN_WORKER,
        threads: weakenGrowThreads,
        startOffset: (3 * gapMs) - weakenTime,
        endOffset: 3 * gapMs,
        ram: weakenRam * weakenGrowThreads
      }
    ];

    var reserved = sumRam(jobs);
    if (reserved > availRam) return null;

    return {
      hackThreads: hackThreads,
      weakenHackThreads: weakenHackThreads,
      growThreads: growThreads,
      weakenGrowThreads: weakenGrowThreads,
      hackFraction: actualHackFraction,
      jobs: jobs,
      reservedRam: reserved,
      peakRam: peakRam(jobs),
      weakenTime: weakenTime
    };
  }

  var fraction = desiredHack;
  for (var i = 0; i < 40; i++) {
    var plan = tryFraction(fraction);
    if (plan) return plan;
    fraction *= 0.9;
  }

  return null;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {BatchPlanV2} plan
 * @param {number} landHackAt
 * @param {number} ramLimitGb
 * @param {string} instanceTag
 * @returns {{success:boolean, launchedJobs:Array<{pid:number,name:string,threads:number}>}}
 */
function dispatchBatch(ns, target, execHost, plan, landHackAt, ramLimitGb, instanceTag) {
  var schedule = [];
  for (var i = 0; i < plan.jobs.length; i++) {
    schedule.push({
      name: plan.jobs[i].name,
      script: plan.jobs[i].script,
      threads: plan.jobs[i].threads,
      ram: plan.jobs[i].ram,
      startAt: landHackAt + plan.jobs[i].startOffset
    });
  }
  schedule.sort(function (a, b) { return a.startAt - b.startAt; });

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

/**
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
    var h = 0;
    var g = 0;
    var w = 0;

    for (var i = live.length - 1; i >= 0; i--) {
      if (!ns.isRunning(live[i].pid, execHost)) {
        live.splice(i, 1);
        continue;
      }

      if (live[i].name === "hack") h += live[i].threads;
      else if (live[i].name === "grow") g += live[i].threads;
      else w += live[i].threads;
    }

    snapshot(ns, execHost, target, instanceTag, h, g, w);
    if (live.length > 0) {
      await ns.sleep(pollMs);
    }
  }

  snapshot(ns, execHost, target, instanceTag, 0, 0, 0);
}

/**
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
      ns,
      execHost,
      target,
      instanceTag,
      jobName === "hack" ? threads : 0,
      jobName === "grow" ? threads : 0,
      jobName.indexOf("weaken") !== -1 ? threads : 0
    );
    await ns.sleep(pollMs);
  }
  snapshot(ns, execHost, target, instanceTag, 0, 0, 0);
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} execHost
 * @param {string} target
 * @param {string} instanceTag
 * @param {number} hack
 * @param {number} grow
 * @param {number} weaken
 */
function snapshot(ns, execHost, target, instanceTag, hack, grow, weaken) {
  if (!gEnableThreadSnapshots) {
    return;
  }

  var now = Date.now();
  if (now - gLastSnapshotAt < gSnapshotIntervalMs) {
    return;
  }
  gLastSnapshotAt = now;

  var h = Math.max(0, Math.floor(hack));
  var g = Math.max(0, Math.floor(grow));
  var w = Math.max(0, Math.floor(weaken));

  ns.tryWritePort(THREAD_PORT, JSON.stringify({
    type: "threadSnapshot",
    source: String(execHost),
    target: String(target),
    tag: String(instanceTag),
    controllerPid: ns.pid,
    hack: h,
    grow: g,
    weaken: w,
    total: h + g + w,
    ts: Date.now()
  }));
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
 * @param {string} value
 * @returns {string}
 */
function sanitizeFileToken(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
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
    srv.hackDifficulty = srv.minDifficulty;
    srv.moneyAvailable = money;
    return Math.max(1, ns.formulas.hacking.growThreads(srv, ns.getPlayer(), maxMoney, cores));
  }

  var mult = Math.max(1, maxMoney / money);
  var raw = ns.growthAnalyze(target, mult, cores);
  return Math.max(1, (!Number.isFinite(raw) ? 1 : Math.ceil(raw)));
}

/**
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
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} script
 * @param {string} host
 * @param {number} ramLimitGb
 * @returns {number}
 */
function maxThreads(ns, script, host, ramLimitGb) {
  var free = plannerFree(ns, host, ramLimitGb);
  var ram = ns.getScriptRam(script, host);
  return ram <= 0 ? 0 : Math.floor(free / ram);
}

/**
 * @param {Array<{startOffset:number,endOffset:number,ram:number}>} jobs
 * @returns {number}
 */
function peakRam(jobs) {
  var events = [];
  for (var i = 0; i < jobs.length; i++) {
    events.push({ t: jobs[i].startOffset, d: jobs[i].ram });
    events.push({ t: jobs[i].endOffset, d: -jobs[i].ram });
  }

  events.sort(function (a, b) {
    if (a.t !== b.t) return a.t - b.t;
    return a.d - b.d;
  });

  var cur = 0;
  var max = 0;
  for (var j = 0; j < events.length; j++) {
    cur += events[j].d;
    if (cur > max) max = cur;
  }
  return max;
}

/**
 * @param {Array<{ram:number}>} jobs
 * @returns {number}
 */
function sumRam(jobs) {
  var total = 0;
  for (var i = 0; i < jobs.length; i++) {
    total += Math.max(0, jobs[i].ram);
  }
  return total;
}

/**
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
  return data.servers.filter(function (s) { return !args.includes(s); });
}
