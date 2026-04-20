const HACK_WORKER = "/workers/hack-once.js";
const GROW_WORKER = "/workers/grow-once.js";
const WEAKEN_WORKER = "/workers/weaken-once.js";

const WORKER_FILES = [HACK_WORKER, GROW_WORKER, WEAKEN_WORKER];
const THREAD_PORT = 1;
const RAM_STALL_WINDOW_MS = 30000;
const MIN_POLL_MS = 20;
const MIN_RAM_STALL_POLLS = 10;

/** @param {NS} ns */
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
  var noFitStreak = 0;
  var noFitLimit = getRamStallLimit(pollMs);
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

  publishThreadSnapshot(ns, execHost, target, 0, 0, 0);

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
      publishThreadSnapshot(ns, execHost, target, 0, 0, 0);
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
      noFitStreak += 1;
      if (noFitStreak >= noFitLimit) {
        var plannerFree = getPlannerFreeRam(ns, execHost, ramLimitGb);
        var minimumBatchRam = getMinimumBatchRam(ns, execHost);
        publishThreadSnapshot(ns, execHost, target, 0, 0, 0);
        throw new Error(
          "[" + instanceTag + "] Batch planning stalled: no HWGW plan fit for " +
          noFitStreak + " consecutive attempts. plannerFreeRam=" +
          plannerFree.toFixed(2) + "GB minimumBatchRam=" + minimumBatchRam.toFixed(2) +
          "GB ramLimitGb=" + ramLimitGb
        );
      }
      ns.print("[" + instanceTag + "] No batch fits right now. Retrying...");
      publishThreadSnapshot(ns, execHost, target, 0, 0, 0);
      await ns.sleep(pollMs);
      continue;
    }
    noFitStreak = 0;

    printBatchSummary(ns, target, execHost, plan, ramLimitGb, gapMs, instanceTag);

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
      pollMs
    );

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
 * @param {NS} ns
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
 * @param {NS} ns
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
 * @param {NS} ns
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
 * @param {NS} ns
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
 * @param {NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {number} ramLimitGb
 * @param {number} pollMs
 * @param {string} instanceTag
 * @returns {Promise<void>}
 */
async function prepTarget(ns, target, execHost, ramLimitGb, pollMs, instanceTag) {
  var moneyReadyPct = 0.999;
  var secReadyBuffer = 0.05;
  var prepStallCount = 0;
  var prepStallLimit = getRamStallLimit(pollMs);
  var minimumWorkerRam = getMinimumWorkerRam(ns, execHost);

  while (true) {
    var state = getTargetState(ns, target);

    if (state.currentSec > state.minSec + secReadyBuffer) {
      var requestedWeaken = estimateWeakenThreadsForPrep(ns, execHost, state);
      var maxWeaken = getMaxThreadsForScript(ns, WEAKEN_WORKER, execHost, ramLimitGb);

      if (maxWeaken < 1) {
        prepStallCount += 1;
        if (prepStallCount >= prepStallLimit) {
          throwPrepStallError(ns, instanceTag, execHost, ramLimitGb, minimumWorkerRam, prepStallCount);
        }
        publishThreadSnapshot(ns, execHost, target, 0, 0, 0);
        await ns.sleep(pollMs);
        continue;
      }

      var weakenThreads = Math.min(requestedWeaken, maxWeaken);
      var weakenPid = ns.exec(WEAKEN_WORKER, execHost, weakenThreads, target);

      if (weakenPid === 0) {
        prepStallCount += 1;
        if (prepStallCount >= prepStallLimit) {
          throwPrepStallError(ns, instanceTag, execHost, ramLimitGb, minimumWorkerRam, prepStallCount);
        }
        publishThreadSnapshot(ns, execHost, target, 0, 0, 0);
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
        pollMs
      );
      prepStallCount = 0;
      continue;
    }

    if (state.currentMoney < state.maxMoney * moneyReadyPct) {
      var requestedGrow = estimateGrowThreadsForPrep(ns, target, execHost, state);
      var maxGrow = getMaxThreadsForScript(ns, GROW_WORKER, execHost, ramLimitGb);

      if (maxGrow < 1) {
        prepStallCount += 1;
        if (prepStallCount >= prepStallLimit) {
          throwPrepStallError(ns, instanceTag, execHost, ramLimitGb, minimumWorkerRam, prepStallCount);
        }
        publishThreadSnapshot(ns, execHost, target, 0, 0, 0);
        await ns.sleep(pollMs);
        continue;
      }

      var growThreads = Math.min(requestedGrow, maxGrow);
      var growPid = ns.exec(GROW_WORKER, execHost, growThreads, target);

      if (growPid === 0) {
        prepStallCount += 1;
        if (prepStallCount >= prepStallLimit) {
          throwPrepStallError(ns, instanceTag, execHost, ramLimitGb, minimumWorkerRam, prepStallCount);
        }
        publishThreadSnapshot(ns, execHost, target, 0, 0, 0);
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
        pollMs
      );
      prepStallCount = 0;
      continue;
    }

    publishThreadSnapshot(ns, execHost, target, 0, 0, 0);
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
 * @param {NS} ns
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
 * @param {NS} ns
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
 *
 * @param {NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {number} ramLimitGb
 * @param {number} desiredHackFraction
 * @param {number} gapMs
 * @returns {object|null}
 */
function fitBatchToRam(ns, target, execHost, ramLimitGb, desiredHackFraction, gapMs) {
  var availableRam = getPlannerFreeRam(ns, execHost, ramLimitGb);
  var fraction = desiredHackFraction;
  var i;

  for (i = 0; i < 40; i++) {
    var plan = buildBatchPlan(ns, target, execHost, fraction, gapMs);
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
 *
 * Builds an HWGW batch plan and computes its peak concurrent RAM footprint.
 *
 * @param {NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {number} desiredHackFraction
 * @param {number} gapMs
 * @returns {object}
 */
function buildBatchPlan(ns, target, execHost, desiredHackFraction, gapMs) {
  var maxMoney = ns.getServerMaxMoney(target);
  var cores = ns.getServer(execHost).cpuCores;

  var desiredHackAmount = maxMoney * desiredHackFraction;
  var rawHackThreads = ns.hackAnalyzeThreads(target, desiredHackAmount);

  if (!Number.isFinite(rawHackThreads) || rawHackThreads < 1) {
    var hackFractionPerThread = Math.max(1e-9, ns.hackAnalyze(target));
    rawHackThreads = desiredHackFraction / hackFractionPerThread;
  }

  var hackThreads = Math.max(1, Math.ceil(rawHackThreads));
  var plannedHackFraction = Math.min(hackThreads * ns.hackAnalyze(target), 0.95);

  var weakenPerThread = ns.weakenAnalyze(1, cores);

  var hackSecIncrease = ns.hackAnalyzeSecurity(hackThreads, target);
  var weakenAfterHackThreads = Math.max(1, Math.ceil(hackSecIncrease / weakenPerThread));

  var growMultiplier = 1 / Math.max(0.05, 1 - plannedHackFraction);
  var rawGrowThreads = ns.growthAnalyze(target, growMultiplier, cores);

  if (!Number.isFinite(rawGrowThreads) || rawGrowThreads < 1) {
    rawGrowThreads = 1;
  }

  var growThreads = Math.max(1, Math.ceil(rawGrowThreads));

  var growSecIncrease = ns.growthAnalyzeSecurity(growThreads, target, cores);
  var weakenAfterGrowThreads = Math.max(1, Math.ceil(growSecIncrease / weakenPerThread));

  var hackTime = ns.getHackTime(target);
  var growTime = ns.getGrowTime(target);
  var weakenTime = ns.getWeakenTime(target);

  var jobs = [
    {
      name: "hack",
      script: HACK_WORKER,
      threads: hackThreads,
      startOffset: -hackTime,
      endOffset: 0,
      ram: ns.getScriptRam(HACK_WORKER, execHost) * hackThreads
    },
    {
      name: "weaken-hack",
      script: WEAKEN_WORKER,
      threads: weakenAfterHackThreads,
      startOffset: gapMs - weakenTime,
      endOffset: gapMs,
      ram: ns.getScriptRam(WEAKEN_WORKER, execHost) * weakenAfterHackThreads
    },
    {
      name: "grow",
      script: GROW_WORKER,
      threads: growThreads,
      startOffset: 2 * gapMs - growTime,
      endOffset: 2 * gapMs,
      ram: ns.getScriptRam(GROW_WORKER, execHost) * growThreads
    },
    {
      name: "weaken-grow",
      script: WEAKEN_WORKER,
      threads: weakenAfterGrowThreads,
      startOffset: 3 * gapMs - weakenTime,
      endOffset: 3 * gapMs,
      ram: ns.getScriptRam(WEAKEN_WORKER, execHost) * weakenAfterGrowThreads
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
    peakRam: calculatePeakRamFromJobs(jobs)
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
 * @param {NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {object} plan
 * @param {number} gapMs
 * @param {number} pollMs
 * @param {number} ramLimitGb
 * @param {string} instanceTag
 * @returns {Promise<{success:boolean,pids:number[],launchedJobs:Array<{pid:number,name:string,threads:number}>}>}
 */
async function dispatchBatch(ns, target, execHost, plan, gapMs, pollMs, ramLimitGb, instanceTag) {
  var weakenTime = ns.getWeakenTime(target);
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
 * @param {NS} ns
 * @param {string} source
 * @param {string} target
 * @param {number} hackThreads
 * @param {number} growThreads
 * @param {number} weakenThreads
 */
function publishThreadSnapshot(ns, source, target, hackThreads, growThreads, weakenThreads) {
  var hack = Math.max(0, Math.floor(hackThreads));
  var grow = Math.max(0, Math.floor(growThreads));
  var weaken = Math.max(0, Math.floor(weakenThreads));

  var payload = {
    type: "threadSnapshot",
    source: String(source),
    target: String(target),
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
 * @param {NS} ns
 * @param {string} execHost
 * @param {string} target
 * @param {number} pid
 * @param {string} jobName
 * @param {number} threads
 * @param {number} pollMs
 * @returns {Promise<void>}
 */
async function waitForPidWithHeartbeat(ns, execHost, target, pid, jobName, threads, pollMs) {
  while (ns.isRunning(pid, execHost)) {
    publishThreadSnapshot(
      ns,
      execHost,
      target,
      jobName === "hack" ? threads : 0,
      jobName === "grow" ? threads : 0,
      jobName.indexOf("weaken") !== -1 ? threads : 0
    );
    await ns.sleep(pollMs);
  }

  publishThreadSnapshot(ns, execHost, target, 0, 0, 0);
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
 * @param {NS} ns
 * @param {string} execHost
 * @param {string} target
 * @param {Array<{pid:number,name:string,threads:number}>} launchedJobs
 * @param {number} pollMs
 * @returns {Promise<void>}
 */
async function waitForBatchWithHeartbeat(ns, execHost, target, launchedJobs, pollMs) {
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

    publishThreadSnapshot(ns, execHost, target, hackThreads, growThreads, weakenThreads);

    if (liveJobs.length > 0) {
      await ns.sleep(pollMs);
    }
  }

  publishThreadSnapshot(ns, execHost, target, 0, 0, 0);
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
 * @param {NS} ns
 * @param {string} target
 * @param {string} execHost
 * @param {object} plan
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
 * @param {number} pollMs
 * @returns {number}
 */
function getRamStallLimit(pollMs) {
  var effectivePollMs = Math.max(MIN_POLL_MS, pollMs);
  return Math.max(MIN_RAM_STALL_POLLS, Math.ceil(RAM_STALL_WINDOW_MS / effectivePollMs));
}

/**
 * @param {NS} ns
 * @param {string} host
 * @returns {number}
 */
function getMinimumWorkerRam(ns, host) {
  var minimum = Infinity;
  var i;
  for (i = 0; i < WORKER_FILES.length; i++) {
    var ram = ns.getScriptRam(WORKER_FILES[i], host);
    if (ram > 0 && ram < minimum) {
      minimum = ram;
    }
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

/**
 * @param {NS} ns
 * @param {string} host
 * @returns {number}
 */
function getMinimumBatchRam(ns, host) {
  return (
    ns.getScriptRam(HACK_WORKER, host) +
    ns.getScriptRam(GROW_WORKER, host) +
    (2 * ns.getScriptRam(WEAKEN_WORKER, host))
  );
}

/**
 * @param {NS} ns
 * @param {string} instanceTag
 * @param {string} execHost
 * @param {number} ramLimitGb
 * @param {number} minimumWorkerRam
 * @param {number} prepStallCount
 */
function throwPrepStallError(ns, instanceTag, execHost, ramLimitGb, minimumWorkerRam, prepStallCount) {
  var plannerFree = getPlannerFreeRam(ns, execHost, ramLimitGb);
  throw new Error(
    "[" + instanceTag + "] Prep stalled for " + prepStallCount +
    " cycles. plannerFreeRam=" + plannerFree.toFixed(2) +
    "GB minimumWorkerRam=" + minimumWorkerRam.toFixed(2) +
    "GB ramLimitGb=" + ramLimitGb
  );
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
