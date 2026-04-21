const HACK_WORKER = "/workers/hack-once.js";
const GROW_WORKER = "/workers/grow-once.js";
const WEAKEN_WORKER = "/workers/weaken-once.js";

const WORKER_FILES = [HACK_WORKER, GROW_WORKER, WEAKEN_WORKER];
const THREAD_PORT = 1;

/**
 * @typedef {{
 *   requestedHackFraction: number,
 *   plannedHackFraction: number,
 *   hackThreads: number,
 *   weakenAfterHackThreads: number,
 *   growThreads: number,
 *   weakenAfterGrowThreads: number,
 *   jobs: Array<{name:string, script:string, threads:number, startOffset:number, endOffset:number, ram:number}>,
 *   peakRam: number,
 *   weakenTime: number
 * }} BatchPlan
 */

/**  
 * @param {import("NetscriptDefinitions").NS} ns
 */
 export async function main(ns) {
var target = ns.args.length > 0 ? String(ns.args[0]) : "";
  var execHost = ns.getHostname();

  // Arg layout:
  // [0] target
  // [1] ramLimitGb
  // [2] gapMs
  // [3] desiredHackFraction
  // [4] pollMs
  // [5] instanceTag (new layout)
  // [5] reserveRamGb, [6] instanceTag (legacy layout tolerated)
  var ramLimitGb = Math.max(-1, normalizeNumber(ns.args.length > 1 ? ns.args[1] : undefined, -1));
  var gapMs = Math.max(20, normalizeNumber(ns.args.length > 2 ? ns.args[2] : undefined, 100));
  var desiredHackFraction = clamp(normalizeNumber(ns.args.length > 3 ? ns.args[3] : undefined, 0.05), 0.001, 0.95);
  var pollMs = Math.max(20, normalizeNumber(ns.args.length > 4 ? ns.args[4] : undefined, 200));
  var instanceTag = getOptionalInstanceTag(ns.args, target, execHost);

  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");
  ns.disableLog("getServerSecurityLevel");
  ns.disableLog("getServerUsedRam");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("readPort");
  ns.disableLog("tryWritePort");
  ns.disableLog("getServerMaxMoney");

  if (!target) {
    throw new Error("hwgw-batcher.js requires a target hostname as arg[0].");
  }

  if (!ns.serverExists(target)) {
    throw new Error("Target server does not exist: " + target);
  }

  if (!ns.serverExists(execHost)) {
    throw new Error("Execution host does not exist: " + execHost);
  }

  if (!ns.hasRootAccess(target)) {
    throw new Error("No root access on target: " + target);
  }

  if (!ns.hasRootAccess(execHost)) {
    throw new Error("No root access on execution host: " + execHost);
  }

  var i;
  for (i = 0; i < WORKER_FILES.length; i++) {
    if (!ns.fileExists(WORKER_FILES[i], execHost)) {
      throw new Error('Missing worker on "' + execHost + '": ' + WORKER_FILES[i]);
    }
    if (ns.getScriptRam(WORKER_FILES[i], execHost) <= 0) {
      throw new Error('Unreadable worker on "' + execHost + '": ' + WORKER_FILES[i]);
    }
  }

  if (ns.args.length > 5 && isNumericLike(ns.args[5])) {
    ns.print("[" + instanceTag + "] NOTE: legacy reserveRamGb argument detected and ignored.");
  }

  publishThreadSnapshot(ns, execHost, target, instanceTag, 0, 0, 0);

  ns.print(
    "[" + instanceTag + "] start target=" + target +
    " host=" + execHost +
    " ramLimitGb=" + ramLimitGb +
    " gapMs=" + gapMs +
    " desiredHackFraction=" + desiredHackFraction +
    " pollMs=" + pollMs
  );

  while (true) {
    var state = getTargetState(ns, target);

    if (state.maxMoney <= 0) {
      publishThreadSnapshot(ns, execHost, target, instanceTag, 0, 0, 0);
      ns.tprint(target + " has no money. Stopping batcher.");
      return;
    }

    await prepTarget(ns, target, execHost, ramLimitGb, pollMs, instanceTag);

    var plan = fitBatchToRam(
      ns,
      target,
      execHost,
      ramLimitGb,
      desiredHackFraction,
      gapMs
    );

    if (plan === null) {
      ns.print("[" + instanceTag + "] No batch fits right now. Retrying...");
      publishThreadSnapshot(ns, execHost, target, instanceTag, 0, 0, 0);
      await ns.sleep(pollMs);
      continue;
    }

    printBatchSummary(ns, target, execHost, plan, ramLimitGb, gapMs, instanceTag);

    var moneyBeforeBatch = ns.getServerMoneyAvailable(target);

    var dispatchResult = await dispatchBatch(
      ns,
      target,
      execHost,
      plan,
      gapMs,
      pollMs,
      ramLimitGb,
      instanceTag
    );

    await waitForBatchWithHeartbeat(
      ns,
      execHost,
      target,
      dispatchResult.launchedJobs,
      pollMs,
      instanceTag
    );

    if (dispatchResult.success) {
      var moneyAfterBatch = ns.getServerMoneyAvailable(target);
      var incomeThisCycle = moneyBeforeBatch - moneyAfterBatch;
      ns.print(
        "[" + instanceTag + "] Batch complete. income=" +
        ns.formatNumber(incomeThisCycle, 3) +
        " moneyNow=" + ns.formatNumber(moneyAfterBatch, 3) +
        " / " + ns.formatNumber(ns.getServerMaxMoney(target), 3)
      );
    }

    if (!dispatchResult.success) {
      ns.print("[" + instanceTag + "] Batch launch failed mid-flight. Re-prepping.");
      await ns.sleep(pollMs);
      continue;
    }

    await ns.sleep(gapMs);
  }
}

/**
 * Params:
 * - ns: Netscript handle
 * - target: target hostname
 *
 * Reads the current target state used for prep and batch planning.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @returns {{maxMoney:number,currentMoney:number,minSec:number,currentSec:number}}
 */
function getTargetState(ns, target) {
  return {
    maxMoney: ns.getServerMaxMoney(target),
    currentMoney: ns.getServerMoneyAvailable(target),
    minSec: ns.getServerMinSecurityLevel(target),
    currentSec: ns.getServerSecurityLevel(target)
  };
}

/**
 * Params:
 * - ns: Netscript handle
 * - host: execution host
 *
 * Computes physical free RAM from current host state.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} host
 * @returns {number}
 */
function getPhysicalFreeRam(ns, host) {
  var maxRam = ns.getServerMaxRam(host);
  var usedRam = ns.getServerUsedRam(host);
  return Math.max(0, maxRam - usedRam);
}

/**
 * Params:
 * - ns: Netscript handle
 * - host: execution host
 * - ramLimitGb: optional soft cap; -1 means use all currently free RAM
 *
 * Returns the planner-visible free RAM after applying the optional cap.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} host
 * @param {number} ramLimitGb
 * @returns {number}
 */
function getPlannerFreeRam(ns, host, ramLimitGb) {
  var physicalFree = getPhysicalFreeRam(ns, host);

  if (ramLimitGb < 0) {
    return physicalFree;
  }

  return Math.max(0, Math.min(physicalFree, ramLimitGb));
}

/**
 * Params:
 * - ns: Netscript handle
 * - script: worker script path
 * - host: execution host
 * - ramLimitGb: optional soft cap
 *
 * Calculates the maximum threads that fit for a single script given the current planner view.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} script
 * @param {string} host
 * @param {number} ramLimitGb
 * @returns {number}
 */
function getMaxThreadsForScript(ns, script, host, ramLimitGb) {
  var freeRam = getPlannerFreeRam(ns, host, ramLimitGb);
  var ramPerThread = ns.getScriptRam(script, host);

  if (ramPerThread <= 0) {
    return 0;
  }

  return Math.floor(freeRam / ramPerThread);
}

/**
 * Params:
 * - ns: Netscript handle
 * - target: target hostname
 * - execHost: execution host
 * - ramLimitGb: optional soft cap
 * - pollMs: poll interval
 * - instanceTag: log label
 *
 * Preps the target to near-max money and near-min security, publishing thread heartbeats while prep jobs run.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {number} ramLimitGb
 * @param {number} pollMs
 * @param {string} instanceTag
 * @returns {Promise<void>}
 */
async function prepTarget(ns, target, execHost, ramLimitGb, pollMs, instanceTag) {
  var moneyReadyPct = 0.999;
  var secReadyBuffer = 0.5;

  while (true) {
    var state = getTargetState(ns, target);

    // Check money first. Growing raises security, but a single weaken pass
    // afterwards covers both the grow-induced increase and any residual drift.
    // Checking security first causes a grow→weaken ping-pong on servers that
    // are already close to prepped.
    if (state.currentMoney < state.maxMoney * moneyReadyPct) {
      var requestedGrow = estimateGrowThreadsForPrep(ns, target, execHost, state);
      var maxGrow = getMaxThreadsForScript(ns, GROW_WORKER, execHost, ramLimitGb);

      if (maxGrow < 1) {
        publishThreadSnapshot(ns, execHost, target, instanceTag, 0, 0, 0);
        await ns.sleep(pollMs);
        continue;
      }

      var growThreads = Math.min(requestedGrow, maxGrow);
      var growPid = ns.exec(GROW_WORKER, execHost, growThreads, target);

      if (growPid === 0) {
        publishThreadSnapshot(ns, execHost, target, instanceTag, 0, 0, 0);
        await ns.sleep(pollMs);
        continue;
      }

      await waitForPidWithHeartbeat(
        ns,
        execHost,
        target,
        growPid,
        "grow",
        growThreads,
        pollMs,
        instanceTag
      );
      continue;
    }

    if (state.currentSec > state.minSec + secReadyBuffer) {
      var requestedWeaken = estimateWeakenThreadsForPrep(ns, execHost, state);
      var maxWeaken = getMaxThreadsForScript(ns, WEAKEN_WORKER, execHost, ramLimitGb);

      if (maxWeaken < 1) {
        publishThreadSnapshot(ns, execHost, target, instanceTag, 0, 0, 0);
        await ns.sleep(pollMs);
        continue;
      }

      var weakenThreads = Math.min(requestedWeaken, maxWeaken);
      var weakenPid = ns.exec(WEAKEN_WORKER, execHost, weakenThreads, target);

      if (weakenPid === 0) {
        publishThreadSnapshot(ns, execHost, target, instanceTag, 0, 0, 0);
        await ns.sleep(pollMs);
        continue;
      }

      await waitForPidWithHeartbeat(
        ns,
        execHost,
        target,
        weakenPid,
        "weaken-prep",
        weakenThreads,
        pollMs,
        instanceTag
      );
      continue;
    }

    publishThreadSnapshot(ns, execHost, target, instanceTag, 0, 0, 0);
    ns.print("[" + instanceTag + "] Prep complete for " + target);
    return;
  }
}

/**
 * Params:
 * - ns: Netscript handle
 * - execHost: execution host
 * - state: current target state
 *
 * Estimates weaken threads needed to return security to minimum during prep.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} execHost
 * @param {{currentSec:number,minSec:number}} state
 * @returns {number}
 */
function estimateWeakenThreadsForPrep(ns, execHost, state) {
  var cores = ns.getServer(execHost).cpuCores;
  var weakenPerThread = ns.weakenAnalyze(1, cores);
  var securityGap = Math.max(0, state.currentSec - state.minSec);
  return Math.max(1, Math.ceil(securityGap / weakenPerThread));
}

/**
 * Params:
 * - ns: Netscript handle
 * - target: target hostname
 * - execHost: execution host
 * - state: current target state
 *
 * Estimates grow threads needed to return money to maximum during prep.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {{maxMoney:number,currentMoney:number}} state
 * @returns {number}
 */
function estimateGrowThreadsForPrep(ns, target, execHost, state) {
  var cores = ns.getServer(execHost).cpuCores;
  var currentMoney = Math.max(1, state.currentMoney);
  var growMultiplier = Math.max(1, state.maxMoney / currentMoney);
  var rawThreads = ns.growthAnalyze(target, growMultiplier, cores);

  if (!Number.isFinite(rawThreads) || rawThreads < 1) {
    return 1;
  }

  return Math.ceil(rawThreads);
}

/**
 * Params:
 * - ns: Netscript handle
 * - target: target hostname
 * - execHost: execution host
 * - ramLimitGb: optional soft cap
 * - desiredHackFraction: requested hack fraction
 * - gapMs: landing gap between phases
 *
 * Shrinks the requested hack fraction until a full HWGW batch fits in the current planner RAM.
 * All NS values that are constant across the shrink loop are queried once and passed down.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {number} ramLimitGb
 * @param {number} desiredHackFraction
 * @param {number} gapMs
 * @returns {BatchPlan|null}
 */
function fitBatchToRam(ns, target, execHost, ramLimitGb, desiredHackFraction, gapMs) {
  var availableRam = getPlannerFreeRam(ns, execHost, ramLimitGb);
  var fraction = desiredHackFraction;
  var i;

  // Hoist all NS calls that are constant across the shrink iterations.
  var cores = ns.getServer(execHost).cpuCores;
  var staticCtx = {
    maxMoney: ns.getServerMaxMoney(target),
    cores: cores,
    hackFractionPerThread: Math.max(1e-9, ns.hackAnalyze(target)),
    weakenPerThread: ns.weakenAnalyze(1, cores),
    hackTime: ns.getHackTime(target),
    growTime: ns.getGrowTime(target),
    weakenTime: ns.getWeakenTime(target),
    hackRamPerThread: ns.getScriptRam(HACK_WORKER, execHost),
    growRamPerThread: ns.getScriptRam(GROW_WORKER, execHost),
    weakenRamPerThread: ns.getScriptRam(WEAKEN_WORKER, execHost)
  };

  for (i = 0; i < 40; i++) {
    var plan = buildBatchPlan(ns, target, execHost, fraction, gapMs, staticCtx);
    if (plan.peakRam <= availableRam) {
      return plan;
    }
    fraction *= 0.9;
  }

  return null;
}

/**
 * Params:
 * - ns: Netscript handle
 * - target: target hostname
 * - execHost: execution host
 * - desiredHackFraction: requested hack fraction
 * - gapMs: landing gap between phases
 * - ctx: pre-fetched static NS values for this batch cycle
 *
 * Builds an HWGW batch plan and computes its peak concurrent RAM footprint.
 * Only NS calls that vary with the hack fraction are made here.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {number} desiredHackFraction
 * @param {number} gapMs
 * @param {{maxMoney:number,cores:number,hackFractionPerThread:number,weakenPerThread:number,hackTime:number,growTime:number,weakenTime:number,hackRamPerThread:number,growRamPerThread:number,weakenRamPerThread:number}} ctx
 * @returns {BatchPlan}
 */
function buildBatchPlan(ns, target, execHost, desiredHackFraction, gapMs, ctx) {
  var desiredHackAmount = ctx.maxMoney * desiredHackFraction;
  var rawHackThreads = ns.hackAnalyzeThreads(target, desiredHackAmount);

  if (!Number.isFinite(rawHackThreads) || rawHackThreads < 1) {
    rawHackThreads = desiredHackFraction / ctx.hackFractionPerThread;
  }

  var hackThreads = Math.max(1, Math.ceil(rawHackThreads));
  var plannedHackFraction = Math.min(hackThreads * ctx.hackFractionPerThread, 0.95);

  var hackSecIncrease = ns.hackAnalyzeSecurity(hackThreads, target);
  var weakenAfterHackThreads = Math.max(1, Math.ceil(hackSecIncrease / ctx.weakenPerThread));

  var growMultiplier = 1 / Math.max(0.05, 1 - plannedHackFraction);
  var rawGrowThreads = ns.growthAnalyze(target, growMultiplier, ctx.cores);

  if (!Number.isFinite(rawGrowThreads) || rawGrowThreads < 1) {
    rawGrowThreads = 1;
  }

  var growThreads = Math.max(1, Math.ceil(rawGrowThreads));

  var growSecIncrease = ns.growthAnalyzeSecurity(growThreads, target, ctx.cores);
  var weakenAfterGrowThreads = Math.max(1, Math.ceil(growSecIncrease / ctx.weakenPerThread));

  var jobs = [
    {
      name: "hack",
      script: HACK_WORKER,
      threads: hackThreads,
      startOffset: -ctx.hackTime,
      endOffset: 0,
      ram: ctx.hackRamPerThread * hackThreads
    },
    {
      name: "weaken-hack",
      script: WEAKEN_WORKER,
      threads: weakenAfterHackThreads,
      startOffset: gapMs - ctx.weakenTime,
      endOffset: gapMs,
      ram: ctx.weakenRamPerThread * weakenAfterHackThreads
    },
    {
      name: "grow",
      script: GROW_WORKER,
      threads: growThreads,
      startOffset: 2 * gapMs - ctx.growTime,
      endOffset: 2 * gapMs,
      ram: ctx.growRamPerThread * growThreads
    },
    {
      name: "weaken-grow",
      script: WEAKEN_WORKER,
      threads: weakenAfterGrowThreads,
      startOffset: 3 * gapMs - ctx.weakenTime,
      endOffset: 3 * gapMs,
      ram: ctx.weakenRamPerThread * weakenAfterGrowThreads
    }
  ];

  return {
    requestedHackFraction: desiredHackFraction,
    plannedHackFraction: plannedHackFraction,
    hackThreads: hackThreads,
    weakenAfterHackThreads: weakenAfterHackThreads,
    growThreads: growThreads,
    weakenAfterGrowThreads: weakenAfterGrowThreads,
    jobs: jobs,
    peakRam: calculatePeakRamFromJobs(jobs),
    // Store the times used to build the job offsets so dispatchBatch can
    // anchor landHackAt with the SAME time base and avoid de-sync.
    weakenTime: ctx.weakenTime
  };
}

/**
 * Params:
 * - jobs: batch job descriptors with start/end offsets and RAM
 *
 * Calculates the maximum concurrent RAM usage across the scheduled batch.
 *
 * @param {Array<{startOffset:number,endOffset:number,ram:number}>} jobs
 * @returns {number}
 */
function calculatePeakRamFromJobs(jobs) {
  var events = [];
  var i;

  for (i = 0; i < jobs.length; i++) {
    events.push({ time: jobs[i].startOffset, delta: jobs[i].ram });
    events.push({ time: jobs[i].endOffset, delta: -jobs[i].ram });
  }

  events.sort(function (a, b) {
    if (a.time !== b.time) {
      return a.time - b.time;
    }
    return a.delta - b.delta;
  });

  var currentRam = 0;
  var peakRam = 0;

  for (i = 0; i < events.length; i++) {
    currentRam += events[i].delta;
    if (currentRam > peakRam) {
      peakRam = currentRam;
    }
  }

  return peakRam;
}

/**
 * Params:
 * - ns: Netscript handle
 * - target: target hostname
 * - execHost: execution host
 * - plan: computed batch plan
 * - gapMs: landing gap
 * - pollMs: poll interval
 * - ramLimitGb: optional soft cap
 * - instanceTag: log label
 *
 * Schedules and launches the batch. Returns both raw PIDs and launched job metadata for heartbeat tracking.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {BatchPlan} plan
 * @param {number} gapMs
 * @param {number} pollMs
 * @param {number} ramLimitGb
 * @param {string} instanceTag
 * @returns {Promise<{success:boolean,pids:number[],launchedJobs:Array<{pid:number,name:string,threads:number}>}>}
 */
async function dispatchBatch(ns, target, execHost, plan, gapMs, pollMs, ramLimitGb, instanceTag) {
  // Use the weakenTime that was used to build the job startOffsets so that
  // landHackAt and the offsets share the same time base. Fetching a fresh
  // weakenTime here would de-sync the two and cause jobs to land out of order.
  var weakenTime = plan.weakenTime;
  var now = Date.now();
  var landHackAt = now + weakenTime + (5 * gapMs) + 250;

  var schedule = [];
  var i;

  for (i = 0; i < plan.jobs.length; i++) {
    schedule.push({
      name: plan.jobs[i].name,
      script: plan.jobs[i].script,
      threads: plan.jobs[i].threads,
      ram: plan.jobs[i].ram,
      startAt: landHackAt + plan.jobs[i].startOffset
    });
  }

  schedule.sort(function (a, b) {
    return a.startAt - b.startAt;
  });

  var pids = [];
  var launchedJobs = [];

  for (i = 0; i < schedule.length; i++) {
    var delay = Math.max(0, schedule[i].startAt - Date.now());
    if (delay > 0) {
      await ns.sleep(delay);
    }

    var plannerFree = getPlannerFreeRam(ns, execHost, ramLimitGb);
    if (schedule[i].ram > plannerFree) {
      ns.print(
        "[" + instanceTag + "] Not enough planner RAM for " + schedule[i].name +
        ". need=" + schedule[i].ram.toFixed(2) + " free=" + plannerFree.toFixed(2)
      );
      return { success: false, pids: pids, launchedJobs: launchedJobs };
    }

    var pid = ns.exec(schedule[i].script, execHost, schedule[i].threads, target);
    if (pid === 0) {
      ns.print(
        "[" + instanceTag + "] Launch failed for " + schedule[i].name +
        " (" + schedule[i].script + " x" + schedule[i].threads + ")"
      );
      return { success: false, pids: pids, launchedJobs: launchedJobs };
    }

    pids.push(pid);
    launchedJobs.push({
      pid: pid,
      name: schedule[i].name,
      threads: schedule[i].threads
    });
  }

  return { success: true, pids: pids, launchedJobs: launchedJobs };
}

/**
 * Params:
 * - ns: Netscript handle
 * - source: execution host
 * - target: target hostname
 * - hackThreads: active hack threads
 * - growThreads: active grow threads
 * - weakenThreads: active weaken threads
 *
 * Sends a best-effort heartbeat for the selected target. This is intentionally fire-and-forget.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} execHost
 * @param {string} target
 * @param {string} instanceTag
 * @param {number} hackThreads
 * @param {number} growThreads
 * @param {number} weakenThreads
 */
function publishThreadSnapshot(ns, execHost, target, instanceTag, hackThreads, growThreads, weakenThreads) {
  var hack = Math.max(0, Math.floor(hackThreads));
  var grow = Math.max(0, Math.floor(growThreads));
  var weaken = Math.max(0, Math.floor(weakenThreads));

  var payload = {
    type: "threadSnapshot",
    source: String(execHost),
    target: String(target),
    tag: String(instanceTag),
    controllerPid: ns.pid,
    hack: hack,
    grow: grow,
    weaken: weaken,
    total: hack + grow + weaken,
    ts: Date.now()
  };

  ns.tryWritePort(THREAD_PORT, JSON.stringify(payload));
}

/**
 * Params:
 * - ns: Netscript handle
 * - execHost: execution host
 * - target: target hostname
 * - pid: active process id
 * - jobName: logical job name
 * - threads: threads for that job
 * - pollMs: poll interval
 *
 * Waits for a single prep job while continuously publishing its thread contribution.
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
async function waitForPidWithHeartbeat(ns, execHost, target, pid, jobName, threads, pollMs, instanceTag) {
  while (ns.isRunning(pid, execHost)) {
    publishThreadSnapshot(
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

  publishThreadSnapshot(ns, execHost, target, instanceTag, 0, 0, 0);
}

/**
 * Params:
 * - ns: Netscript handle
 * - execHost: execution host
 * - target: target hostname
 * - launchedJobs: launched HWGW jobs with pid/name/threads
 * - pollMs: poll interval
 *
 * Tracks active batch jobs and publishes aggregate active thread counts until the batch fully drains.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} execHost
 * @param {string} target
 * @param {Array<{pid:number,name:string,threads:number}>} launchedJobs
 * @param {number} pollMs
 * @param {string} instanceTag
 * @returns {Promise<void>}
 */
async function waitForBatchWithHeartbeat(ns, execHost, target, launchedJobs, pollMs, instanceTag) {
  var liveJobs = launchedJobs.slice();

  while (liveJobs.length > 0) {
    var hackThreads = 0;
    var growThreads = 0;
    var weakenThreads = 0;
    var i;

    for (i = liveJobs.length - 1; i >= 0; i--) {
      var job = liveJobs[i];

      if (!ns.isRunning(job.pid, execHost)) {
        liveJobs.splice(i, 1);
        continue;
      }

      if (job.name === "hack") {
        hackThreads += job.threads;
      } else if (job.name === "grow") {
        growThreads += job.threads;
      } else if (job.name.indexOf("weaken") !== -1) {
        weakenThreads += job.threads;
      }
    }

    publishThreadSnapshot(ns, execHost, target, instanceTag, hackThreads, growThreads, weakenThreads);

    if (liveJobs.length > 0) {
      await ns.sleep(pollMs);
    }
  }

  publishThreadSnapshot(ns, execHost, target, instanceTag, 0, 0, 0);
}

/**
 * Params:
 * - ns: Netscript handle
 * - target: target hostname
 * - execHost: execution host
 * - plan: batch plan
 * - ramLimitGb: optional soft cap
 * - gapMs: landing gap
 * - instanceTag: log label
 *
 * Prints the current batch plan and RAM situation for visibility.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} target
 * @param {string} execHost 
 * @param {BatchPlan} plan
 * @param {number} ramLimitGb
 * @param {number} gapMs
 * @param {string} instanceTag
 */
function printBatchSummary(ns, target, execHost, plan, ramLimitGb, gapMs, instanceTag) {
  var maxRam = ns.getServerMaxRam(execHost);
  var usedRam = ns.getServerUsedRam(execHost);
  var actualFreeRam = maxRam - usedRam;
  var plannerFreeRam = getPlannerFreeRam(ns, execHost, ramLimitGb);

  ns.print("--------------------------------------------------");
  ns.print("Instance: " + instanceTag);
  ns.print("Target: " + target);
  ns.print("Exec host: " + execHost);
  ns.print("RAM mode: " + describeRamMode(ramLimitGb));
  ns.print("Actual free RAM: " + actualFreeRam.toFixed(2) + " GB");
  ns.print("Planner free RAM: " + plannerFreeRam.toFixed(2) + " GB");
  ns.print("Batch peak RAM: " + plan.peakRam.toFixed(2) + " GB");
  ns.print("Gap: " + gapMs + " ms");
  ns.print("Requested hack fraction: " + (plan.requestedHackFraction * 100).toFixed(2) + "%");
  ns.print("Planned hack fraction: " + (plan.plannedHackFraction * 100).toFixed(2) + "%");
  ns.print("Hack threads: " + plan.hackThreads);
  ns.print("Weaken-after-hack threads: " + plan.weakenAfterHackThreads);
  ns.print("Grow threads: " + plan.growThreads);
  ns.print("Weaken-after-grow threads: " + plan.weakenAfterGrowThreads);
}

/**
 * Params:
 * - args: raw ns.args array
 * - target: target hostname
 * - execHost: execution host
 *
 * Extracts the instance tag while tolerating the legacy arg layout.
 *
 * @param {Array<unknown>} args
 * @param {string} target
 * @param {string} execHost
 * @returns {string}
 */
function getOptionalInstanceTag(args, target, execHost) {
  var defaultTag = target + "@" + execHost;

  if (args.length > 6) {
    return String(args[6]);
  }

  if (args.length > 5 && !isNumericLike(args[5])) {
    return String(args[5]);
  }

  return defaultTag;
}

/**
 * Params:
 * - ramLimitGb: configured RAM cap
 *
 * Returns a readable label for logging.
 *
 * @param {number} ramLimitGb
 * @returns {string}
 */
function describeRamMode(ramLimitGb) {
  if (ramLimitGb < 0) {
    return "dynamic (all currently free RAM)";
  }
  return "capped at " + ramLimitGb + " GB";
}

/**
 * Params:
 * - value: any value that may or may not be numeric
 *
 * Checks whether the input can be safely interpreted as a finite number.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isNumericLike(value) {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  return Number.isFinite(Number(value));
}

/**
 * Params:
 * - value: incoming value
 * - fallback: default value if parsing fails
 *
 * Normalizes a possibly-empty or non-numeric input to a usable number.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  var parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Params:
 * - value: number to clamp
 * - min: lower bound
 * - max: upper bound
 *
 * Restricts a number to a closed interval.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}