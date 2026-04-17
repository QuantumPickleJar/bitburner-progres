const HACK_WORKER = "/workers/hack-once.js";
const GROW_WORKER = "/workers/grow-once.js";
const WEAKEN_WORKER = "/workers/weaken-once.js";
const HEARTBEAT_PORT = 1;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const target = ns.args.length > 0 ? String(ns.args[0]) : "";
  const budgetRamGb = normalizeNumber(ns.args.length > 1 ? ns.args[1] : undefined, -1);
  const gapMs = Math.max(20, normalizeNumber(ns.args.length > 2 ? ns.args[2] : undefined, 100));
  const desiredHackFraction = clamp(
    normalizeNumber(ns.args.length > 3 ? ns.args[3] : undefined, 0.05),
    0.001,
    0.95,
  );
  const pollMs = Math.max(20, normalizeNumber(ns.args.length > 4 ? ns.args[4] : undefined, 200));

  const parsed = parseLegacyAwareArgs(ns.args);
  const reserveRamGb = parsed.reserveRamGb;
  const instanceTag = parsed.instanceTag || `${target || "unknown"}@${ns.getHostname()}-${Date.now()}`;

  if (!target) {
    ns.tprint("ERROR: Missing target hostname.");
    return;
  }

  if (!ns.serverExists(target)) {
    ns.tprint(`ERROR: Target server does not exist: ${target}`);
    return;
  }

  const host = ns.getHostname();
  const workerRam = {
    hack: ns.getScriptRam(HACK_WORKER, host),
    grow: ns.getScriptRam(GROW_WORKER, host),
    weaken: ns.getScriptRam(WEAKEN_WORKER, host),
  };

  if (workerRam.hack <= 0 || workerRam.grow <= 0 || workerRam.weaken <= 0) {
    ns.tprint(
      `ERROR: Missing/unreadable worker script(s) on ${host}. ` +
      `${HACK_WORKER}=${workerRam.hack}, ${GROW_WORKER}=${workerRam.grow}, ${WEAKEN_WORKER}=${workerRam.weaken}`,
    );
    return;
  }

  await prepTarget(ns, {
    target,
    host,
    budgetRamGb,
    reserveRamGb,
    pollMs,
    workerRam,
    instanceTag,
  });

  while (true) {
    try {
      const budgetNow = getCurrentBudgetRam(ns, host, budgetRamGb, reserveRamGb);
      if (budgetNow > 0) {
        scheduleBatch(ns, {
          target,
          host,
          desiredHackFraction,
          gapMs,
          budgetRamGb: budgetNow,
          workerRam,
          instanceTag,
        });
      }

      publishThreadSnapshot(ns, host, target, instanceTag);
    } catch (err) {
      ns.print(`WARN batch loop error: ${String(err)}`);
    }

    await ns.sleep(pollMs);
  }
}

async function prepTarget(ns, ctx) {
  const toleranceMoney = 0.999;
  const toleranceSec = 0.05;

  while (ns.getServerSecurityLevel(ctx.target) > ns.getServerMinSecurityLevel(ctx.target) + toleranceSec) {
    const sec = ns.getServerSecurityLevel(ctx.target);
    const min = ns.getServerMinSecurityLevel(ctx.target);
    const weakenNeeded = Math.max(1, Math.ceil((sec - min) / ns.weakenAnalyze(1)));

    const maxThreads = maxThreadsForBudget(ctx.budgetRamGb, ctx.reserveRamGb, ctx.workerRam.weaken, ns, ctx.host);
    const threads = Math.min(weakenNeeded, maxThreads);
    if (threads <= 0) break;

    const pid = ns.exec(WEAKEN_WORKER, ctx.host, threads, ctx.target, 0, ctx.instanceTag, "prep-w1");
    if (pid !== 0) {
      await ns.sleep(Math.max(ctx.pollMs, Math.ceil(ns.getWeakenTime(ctx.target) + 20)));
    } else {
      await ns.sleep(ctx.pollMs);
    }

    publishThreadSnapshot(ns, ctx.host, ctx.target, ctx.instanceTag);
  }

  while (ns.getServerMoneyAvailable(ctx.target) < ns.getServerMaxMoney(ctx.target) * toleranceMoney) {
    const maxMoney = Math.max(1, ns.getServerMaxMoney(ctx.target));
    const currentMoney = Math.max(1, ns.getServerMoneyAvailable(ctx.target));
    const growthMult = Math.max(1.000001, maxMoney / currentMoney);
    let growNeeded;
    try {
      growNeeded = Math.ceil(ns.growthAnalyze(ctx.target, growthMult));
    } catch {
      growNeeded = 1;
    }
    if (!Number.isFinite(growNeeded) || growNeeded <= 0) {
      growNeeded = 1;
    }

    const maxThreads = maxThreadsForBudget(ctx.budgetRamGb, ctx.reserveRamGb, ctx.workerRam.grow, ns, ctx.host);
    const threads = Math.min(growNeeded, maxThreads);
    if (threads <= 0) break;

    const pid = ns.exec(GROW_WORKER, ctx.host, threads, ctx.target, 0, ctx.instanceTag, "prep-g");
    if (pid !== 0) {
      await ns.sleep(Math.max(ctx.pollMs, Math.ceil(ns.getGrowTime(ctx.target) + 20)));
    } else {
      await ns.sleep(ctx.pollMs);
    }

    publishThreadSnapshot(ns, ctx.host, ctx.target, ctx.instanceTag);
  }

  while (ns.getServerSecurityLevel(ctx.target) > ns.getServerMinSecurityLevel(ctx.target) + toleranceSec) {
    const sec = ns.getServerSecurityLevel(ctx.target);
    const min = ns.getServerMinSecurityLevel(ctx.target);
    const weakenNeeded = Math.max(1, Math.ceil((sec - min) / ns.weakenAnalyze(1)));

    const maxThreads = maxThreadsForBudget(ctx.budgetRamGb, ctx.reserveRamGb, ctx.workerRam.weaken, ns, ctx.host);
    const threads = Math.min(weakenNeeded, maxThreads);
    if (threads <= 0) break;

    const pid = ns.exec(WEAKEN_WORKER, ctx.host, threads, ctx.target, 0, ctx.instanceTag, "prep-w2");
    if (pid !== 0) {
      await ns.sleep(Math.max(ctx.pollMs, Math.ceil(ns.getWeakenTime(ctx.target) + 20)));
    } else {
      await ns.sleep(ctx.pollMs);
    }

    publishThreadSnapshot(ns, ctx.host, ctx.target, ctx.instanceTag);
  }
}

function scheduleBatch(ns, cfg) {
  const hackPctPerThread = ns.hackAnalyze(cfg.target);
  if (!Number.isFinite(hackPctPerThread) || hackPctPerThread <= 0) {
    return;
  }

  const weakenPerThread = ns.weakenAnalyze(1);
  if (!Number.isFinite(weakenPerThread) || weakenPerThread <= 0) {
    return;
  }

  let hackThreads = Math.max(1, Math.floor(cfg.desiredHackFraction / hackPctPerThread));
  hackThreads = Math.min(hackThreads, Math.floor(cfg.budgetRamGb / cfg.workerRam.hack));
  if (hackThreads <= 0) return;

  while (hackThreads > 0) {
    const hackedFrac = clamp(hackThreads * hackPctPerThread, 0.0001, 0.99);
    let growThreads;
    try {
      growThreads = Math.ceil(ns.growthAnalyze(cfg.target, 1 / (1 - hackedFrac)));
    } catch {
      growThreads = 1;
    }
    if (!Number.isFinite(growThreads) || growThreads < 1) growThreads = 1;

    const w1Threads = Math.max(1, Math.ceil(ns.hackAnalyzeSecurity(hackThreads) / weakenPerThread));
    const w2Threads = Math.max(1, Math.ceil(ns.growthAnalyzeSecurity(growThreads) / weakenPerThread));

    const totalRam =
      hackThreads * cfg.workerRam.hack +
      growThreads * cfg.workerRam.grow +
      (w1Threads + w2Threads) * cfg.workerRam.weaken;

    if (totalRam <= cfg.budgetRamGb) {
      launchTimedBatch(ns, cfg, { hackThreads, growThreads, w1Threads, w2Threads });
      return;
    }

    hackThreads -= 1;
  }
}

function launchTimedBatch(ns, cfg, plan) {
  const now = Date.now();
  const batchId = `${cfg.instanceTag}:${now}`;

  const hackTime = ns.getHackTime(cfg.target);
  const growTime = ns.getGrowTime(cfg.target);
  const weakenTime = ns.getWeakenTime(cfg.target);

  const desiredHackLand = now + Math.max(200, cfg.gapMs * 4);
  const desiredW1Land = desiredHackLand + cfg.gapMs;
  const desiredGrowLand = desiredHackLand + cfg.gapMs * 2;
  const desiredW2Land = desiredHackLand + cfg.gapMs * 3;

  let hackStart = desiredHackLand - hackTime;
  let w1Start = desiredW1Land - weakenTime;
  let growStart = desiredGrowLand - growTime;
  let w2Start = desiredW2Land - weakenTime;

  const earliestStart = Math.min(hackStart, w1Start, growStart, w2Start);
  const minAllowed = now + 5;
  if (earliestStart < minAllowed) {
    const shift = minAllowed - earliestStart;
    hackStart += shift;
    w1Start += shift;
    growStart += shift;
    w2Start += shift;
  }

  const hackDelay = Math.max(0, Math.round(hackStart - now));
  const w1Delay = Math.max(0, Math.round(w1Start - now));
  const growDelay = Math.max(0, Math.round(growStart - now));
  const w2Delay = Math.max(0, Math.round(w2Start - now));

  ns.exec(HACK_WORKER, cfg.host, plan.hackThreads, cfg.target, hackDelay, cfg.instanceTag, batchId, "H");
  ns.exec(WEAKEN_WORKER, cfg.host, plan.w1Threads, cfg.target, w1Delay, cfg.instanceTag, batchId, "W1");
  ns.exec(GROW_WORKER, cfg.host, plan.growThreads, cfg.target, growDelay, cfg.instanceTag, batchId, "G");
  ns.exec(WEAKEN_WORKER, cfg.host, plan.w2Threads, cfg.target, w2Delay, cfg.instanceTag, batchId, "W2");
}

function maxThreadsForBudget(budgetRamGb, reserveRamGb, scriptRam, ns, host) {
  if (scriptRam <= 0) return 0;
  const budget = getCurrentBudgetRam(ns, host, budgetRamGb, reserveRamGb);
  return Math.max(0, Math.floor(budget / scriptRam));
}

function getCurrentBudgetRam(ns, host, budgetRamGb, reserveRamGb) {
  const freeRam = Math.max(0, ns.getServerMaxRam(host) - ns.getServerUsedRam(host));
  const usableRam = Math.max(0, freeRam - Math.max(0, reserveRamGb));
  if (budgetRamGb < 0) {
    return usableRam;
  }
  return Math.max(0, Math.min(usableRam, budgetRamGb));
}

function publishThreadSnapshot(ns, host, target, instanceTag) {
  let hack = 0;
  let grow = 0;
  let weaken = 0;

  const procs = ns.ps(host);
  for (let i = 0; i < procs.length; i += 1) {
    const p = procs[i];
    if (!p || !Array.isArray(p.args) || p.args.length < 1) continue;
    if (String(p.args[0]) !== target) continue;

    if (p.filename === HACK_WORKER) hack += p.threads;
    if (p.filename === GROW_WORKER) grow += p.threads;
    if (p.filename === WEAKEN_WORKER) weaken += p.threads;
  }

  const msg = {
    type: "threadSnapshot",
    source: instanceTag || host,
    target,
    hack,
    grow,
    weaken,
    total: hack + grow + weaken,
    ts: Date.now(),
  };

  ns.tryWritePort(HEARTBEAT_PORT, JSON.stringify(msg));
}

function parseLegacyAwareArgs(args) {
  const hasLegacyLayout = args.length > 6;
  if (hasLegacyLayout) {
    return {
      reserveRamGb: Math.max(0, normalizeNumber(args[5], 0)),
      instanceTag: args[6] !== undefined ? String(args[6]) : "",
    };
  }

  if (args.length > 5) {
    if (isNumericLike(args[5])) {
      return {
        reserveRamGb: Math.max(0, normalizeNumber(args[5], 0)),
        instanceTag: "",
      };
    }

    return {
      reserveRamGb: 0,
      instanceTag: String(args[5]),
    };
  }

  return {
    reserveRamGb: 0,
    instanceTag: "",
  };
}

function isNumericLike(value) {
  if (value === undefined || value === null || value === "") return false;
  return Number.isFinite(Number(value));
}

function normalizeNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
