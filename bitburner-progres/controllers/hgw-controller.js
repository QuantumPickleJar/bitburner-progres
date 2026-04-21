const HACK_WORKER = "/workers/hack-once.js";
const GROW_WORKER = "/workers/grow-once.js";
const WEAKEN_WORKER = "/workers/weaken-once.js";

const WORKER_FILES = [HACK_WORKER, GROW_WORKER, WEAKEN_WORKER];


/** @param {NS} ns */
export async function main(ns) {
  const target = String(ns.args[0] ?? "");
  const execHost = ns.getHostname();
  const reserveRamGb = Math.max(0, Number(ns.args[1] ?? (execHost === "home" ? 8 : 0)));
  const pollMs = Math.max(50, Number(ns.args[2] ?? 200));
  const desiredHackFraction = clamp(Number(ns.args[3] ?? 0.05), 0.001, 0.95);

  const moneyReadyPct = 0.999;
  const secReadyBuffer = 0.05;

  if (!target) {
    throw new Error("hgw-controller.js requires a target hostname as arg[0].");
  }

  if (!ns.serverExists(target)) {
    throw new Error(`Target server does not exist: ${target}`);
  }

  if (!ns.serverExists(execHost)) {
    throw new Error(`Execution host does not exist: ${execHost}`);
  }

  if (!ns.hasRootAccess(target)) {
    throw new Error(`No root access on target: ${target}`);
  }

  if (!ns.hasRootAccess(execHost)) {
    throw new Error(`No root access on execution host: ${execHost}`);
  }

  // Starter already deploys these, so this is optional.
  // Keeping it here is harmless only because execHost is now correct.
  await ns.scp(WORKER_FILES, execHost, "home");

  while (true) {
    const state = getTargetState(ns, target);

    // Skip non-money targets entirely.
    if (state.maxMoney <= 0) {
      ns.tprint(`${target} has no money. Stopping controller.`);
      return;
    }

    // --- PREP PHASE 1: SECURITY FIRST ---
    if (state.currentSec > state.minSec + secReadyBuffer) {
      const weakenThreadsNeeded = estimateWeakenThreadsForPrep(ns, execHost, state);
      const launched = await runOnePhaseThatFits(
        ns,
        WEAKEN_WORKER,
        execHost,
        target,
        weakenThreadsNeeded,
        reserveRamGb,
        pollMs
      );

      if (launched === 0) {
        ns.print(`No free RAM to weaken ${target}. Retrying...`);
        await ns.sleep(pollMs);
      }

      continue;
    }

    // --- PREP PHASE 2: MONEY SECOND ---
    if (state.currentMoney < state.maxMoney * moneyReadyPct) {
      const growThreadsNeeded = estimateGrowThreadsForPrep(ns, target, execHost, state);
      const launched = await runOnePhaseThatFits(
        ns,
        GROW_WORKER,
        execHost,
        target,
        growThreadsNeeded,
        reserveRamGb,
        pollMs
      );

      if (launched === 0) {
        ns.print(`No free RAM to grow ${target}. Retrying...`);
        await ns.sleep(pollMs);
      }

      continue;
    }

    // --- FARM PHASE ---
    // Build a cycle plan, then shrink it until every phase fits the available RAM
    // on the chosen execution host as a single launch.
    const cyclePlan = fitCycleToRam(ns, target, desiredHackFraction, execHost, reserveRamGb);

    if (!cyclePlan) {
      ns.print(`Unable to fit even a tiny farm cycle for ${target}. Retrying...`);
      await ns.sleep(pollMs);
      continue;
    }

    printCycleSummary(ns, target, execHost, cyclePlan, reserveRamGb);

    // Learning note:
    // This is NOT timed batching. We are sequencing H -> W -> G -> W on purpose,
    // because it is easier to understand and debug before you move into delayed
    // finish-order scheduling.
    await launchAndWait(ns, HACK_WORKER, execHost, target, cyclePlan.hackThreads, pollMs);
    await launchAndWait(ns, WEAKEN_WORKER, execHost, target, cyclePlan.weakenAfterHackThreads, pollMs);
    await launchAndWait(ns, GROW_WORKER, execHost, target, cyclePlan.growThreads, pollMs);
    await launchAndWait(ns, WEAKEN_WORKER, execHost, target, cyclePlan.weakenAfterGrowThreads, pollMs);
  }
}

/**
 * Reads the live state of a target server.
 *
 * @param {NS} ns - Bitburner Netscript handle.
 * @param {string} target - The server being analyzed.
 * @returns {{
 *   maxMoney: number,
 *   currentMoney: number,
 *   minSec: number,
 *   currentSec: number
 * }}
 */
function getTargetState(ns, target) {
  return {
    maxMoney: ns.getServerMaxMoney(target),
    currentMoney: ns.getServerMoneyAvailable(target),
    minSec: ns.getServerMinSecurityLevel(target),
    currentSec: ns.getServerSecurityLevel(target),
  };
}

/**
 * Returns free RAM on an execution host after reserving some RAM for your own use.
 *
 * @param {NS} ns - Bitburner Netscript handle.
 * @param {string} host - Host where workers will be launched.
 * @param {number} reserveRamGb - RAM to keep free intentionally.
 * @returns {number} Remaining usable RAM on the host.
 */
function getAvailableRam(ns, host, reserveRamGb = 0) {
  const maxRam = ns.getServerMaxRam(host);
  const usedRam = ns.getServerUsedRam(host);
  return Math.max(0, maxRam - usedRam - reserveRamGb);
}

/**
 * Computes the maximum threads a single script can run with the current free RAM.
 *
 * @param {NS} ns - Bitburner Netscript handle.
 * @param {string} script - Worker script filename.
 * @param {string} host - Host that will execute the worker.
 * @param {number} reserveRamGb - RAM to keep free intentionally.
 * @returns {number} Maximum runnable thread count for the script.
 */
function getMaxThreadsForScript(ns, script, host, reserveRamGb = 0) {
  const freeRam = getAvailableRam(ns, host, reserveRamGb);
  const scriptRam = ns.getScriptRam(script, host);

  if (scriptRam <= 0) {
    return 0;
  }

  return Math.floor(freeRam / scriptRam);
}

/**
 * Estimates weaken threads needed to remove the current excess security.
 *
 * @param {NS} ns - Bitburner Netscript handle.
 * @param {string} execHost - Host whose CPU core count will apply to weaken.
 * @param {{minSec:number,currentSec:number}} state - Live target state snapshot.
 * @returns {number} Estimated weaken threads needed.
 */
function estimateWeakenThreadsForPrep(ns, execHost, state) {
  const cores = ns.getServer(execHost).cpuCores;
  const weakenPerThread = ns.weakenAnalyze(1, cores);
  const securityGap = Math.max(0, state.currentSec - state.minSec);

  return Math.max(1, Math.ceil(securityGap / weakenPerThread));
}

/**
 * Estimates grow threads needed to refill the target from its current money back
 * toward max money.
 *
 * @param {NS} ns - Bitburner Netscript handle.
 * @param {string} target - Target server being grown.
 * @param {string} execHost - Host whose CPU core count will apply to grow.
 * @param {{maxMoney:number,currentMoney:number}} state - Live target state snapshot.
 * @returns {number} Estimated grow threads needed.
 */
function estimateGrowThreadsForPrep(ns, target, execHost, state) {
  const cores = ns.getServer(execHost).cpuCores;

  // Avoid division by zero and impossible multipliers when money is nearly empty.
  const currentMoney = Math.max(1, state.currentMoney);
  const growMultiplier = Math.max(1, state.maxMoney / currentMoney);

  const rawThreads = ns.growthAnalyze(target, growMultiplier, cores);

  if (!Number.isFinite(rawThreads) || rawThreads < 1) {
    return 1;
  }

  return Math.ceil(rawThreads);
}

/**
 * Builds a hack cycle plan for a prepped server.
 *
 * The controller treats the desired hack fraction as the "request", then derives
 * the follow-up weaken/grow/weaken debt from that request.
 *
 * @param {NS} ns - Bitburner Netscript handle.
 * @param {string} target - Prepped target server.
 * @param {number} desiredHackFraction - Requested fraction of max money to steal.
 * @param {string} execHost - Host whose CPU cores affect grow/weaken calculations.
 * @returns {{
 *   requestedHackFraction: number,
 *   plannedHackFraction: number,
 *   desiredHackAmount: number,
 *   hackThreads: number,
 *   weakenAfterHackThreads: number,
 *   growMultiplier: number,
 *   growThreads: number,
 *   weakenAfterGrowThreads: number
 * }}
 */
function planCycle(ns, target, desiredHackFraction, execHost = "home") {
  const maxMoney = ns.getServerMaxMoney(target);
  const cores = ns.getServer(execHost).cpuCores;

  const desiredHackAmount = maxMoney * desiredHackFraction;

  const rawHackThreads = ns.hackAnalyzeThreads(target, desiredHackAmount);
  const hackThreads = Math.max(1, Math.ceil(rawHackThreads));

  const hackFractionPerThread = ns.hackAnalyze(target);
  const plannedHackFraction = Math.min(hackThreads * hackFractionPerThread, 0.95);

  const hackSecIncrease = ns.hackAnalyzeSecurity(hackThreads, target);
  const weakenPerThread = ns.weakenAnalyze(1, cores);
  const weakenAfterHackThreads = Math.max(1, Math.ceil(hackSecIncrease / weakenPerThread));

  const growMultiplier = 1 / (1 - plannedHackFraction);

  const rawGrowThreads = ns.growthAnalyze(target, growMultiplier, cores);
  const growThreads = Math.max(1, Math.ceil(rawGrowThreads));

  const growSecIncrease = ns.growthAnalyzeSecurity(growThreads, target, cores);
  const weakenAfterGrowThreads = Math.max(1, Math.ceil(growSecIncrease / weakenPerThread));

  return {
    requestedHackFraction: desiredHackFraction,
    plannedHackFraction,
    desiredHackAmount,
    hackThreads,
    weakenAfterHackThreads,
    growMultiplier,
    growThreads,
    weakenAfterGrowThreads,
  };
}

/**
 * Shrinks a requested farm cycle until every individual phase fits on the selected
 * execution host with the currently free RAM.
 *
 * This avoids planning a hack wave that would require an oversized grow or weaken
 * phase that cannot be launched cleanly.
 *
 * @param {NS} ns - Bitburner Netscript handle.
 * @param {string} target - Target server.
 * @param {number} desiredHackFraction - Starting requested hack fraction.
 * @param {string} execHost - Host where workers will run.
 * @param {number} reserveRamGb - RAM to keep free intentionally.
 * @returns {ReturnType<typeof planCycle> | null} A cycle plan that fits, or null.
 */
function fitCycleToRam(ns, target, desiredHackFraction, execHost, reserveRamGb) {
  const maxHackThreads = getMaxThreadsForScript(ns, HACK_WORKER, execHost, reserveRamGb);
  const maxGrowThreads = getMaxThreadsForScript(ns, GROW_WORKER, execHost, reserveRamGb);
  const maxWeakenThreads = getMaxThreadsForScript(ns, WEAKEN_WORKER, execHost, reserveRamGb);

  if (maxHackThreads < 1 || maxGrowThreads < 1 || maxWeakenThreads < 1) {
    return null;
  }

  let fraction = desiredHackFraction;

  // Try progressively smaller hack fractions until the whole cycle fits.
  for (let i = 0; i < 30; i++) {
    const plan = planCycle(ns, target, fraction, execHost);

    const fits =
      plan.hackThreads <= maxHackThreads &&
      plan.growThreads <= maxGrowThreads &&
      plan.weakenAfterHackThreads <= maxWeakenThreads &&
      plan.weakenAfterGrowThreads <= maxWeakenThreads;

    if (fits) {
      return plan;
    }

    fraction *= 0.9;
  }

  return null;
}

/**
 * Launches the largest single phase that currently fits on the execution host,
 * then waits for it to finish.
 *
 * This is used for prep, where one pass may not be enough and the loop can
 * naturally reevaluate state afterward.
 *
 * @param {NS} ns - Bitburner Netscript handle.
 * @param {string} script - Worker script to execute.
 * @param {string} execHost - Host that will run the worker.
 * @param {string} target - Worker target argument.
 * @param {number} requestedThreads - Desired threads for this phase.
 * @param {number} reserveRamGb - RAM to keep free intentionally.
 * @param {number} pollMs - Sleep interval while waiting for completion.
 * @returns {Promise<number>} Actual threads launched.
 */
async function runOnePhaseThatFits(ns, script, execHost, target, requestedThreads, reserveRamGb, pollMs) {
  const maxThreads = getMaxThreadsForScript(ns, script, execHost, reserveRamGb);

  if (maxThreads < 1) {
    return 0;
  }

  const threadsToLaunch = Math.max(1, Math.min(requestedThreads, maxThreads));
  await launchAndWait(ns, script, execHost, target, threadsToLaunch, pollMs);
  return threadsToLaunch;
}

/**
 * Launches one worker phase and waits until that exact worker invocation finishes.
 *
 * @param {NS} ns - Bitburner Netscript handle.
 * @param {string} script - Worker script filename.
 * @param {string} execHost - Host that will run the worker.
 * @param {string} target - Worker target argument.
 * @param {number} threads - Threads to launch.
 * @param {number} pollMs - Sleep interval while waiting for completion.
 * @returns {Promise<void>}
 */
async function launchAndWait(ns, script, execHost, target, threads, pollMs) {
  if (threads < 1) {
    return;
  }

  const pid = ns.exec(script, execHost, threads, target);

  if (pid === 0) {
    throw new Error(`Failed to exec ${script} on ${execHost} with ${threads} threads.`);
  }

  // Wait on the exact process we launched, not "any matching script".
  while (ns.isRunning(pid)) {
    await ns.sleep(pollMs);
  }
}

/**
 * Prints a short summary of the fitted cycle.
 *
 * @param {NS} ns - Bitburner Netscript handle.
 * @param {string} target - Target server.
 * @param {string} execHost - Host running the workers.
 * @param {ReturnType<typeof planCycle>} plan - Fitted cycle plan.
 * @param {number} reserveRamGb - RAM reserved on execHost.
 * @returns {void}
 */
function printCycleSummary(ns, target, execHost, plan, reserveRamGb) {
  const freeRam = getAvailableRam(ns, execHost, reserveRamGb);

  ns.print("--------------------------------------------------");
  ns.print(`Target: ${target}`);
  ns.print(`Exec host: ${execHost}`);
  ns.print(`Free RAM for workers: ${freeRam.toFixed(2)} GB`);
  ns.print(`Requested hack fraction: ${(plan.requestedHackFraction * 100).toFixed(2)}%`);
  ns.print(`Planned hack fraction: ${(plan.plannedHackFraction * 100).toFixed(2)}%`);
  ns.print(`Hack threads: ${plan.hackThreads}`);
  ns.print(`Weaken-after-hack threads: ${plan.weakenAfterHackThreads}`);
  ns.print(`Grow threads: ${plan.growThreads}`);
  ns.print(`Weaken-after-grow threads: ${plan.weakenAfterGrowThreads}`);
}

/**
 * Restricts a number to a supplied range.
 *
 * @param {number} value - Incoming numeric value.
 * @param {number} min - Lower inclusive bound.
 * @param {number} max - Upper inclusive bound.
 * @returns {number} Clamped value.
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}