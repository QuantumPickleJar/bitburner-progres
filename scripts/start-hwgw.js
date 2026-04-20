const BATCHER = "/controllers/hwgw-batcher.js";
const WORKER_FILES = [
  "/workers/hack-once.js",
  "/workers/grow-once.js",
  "/workers/weaken-once.js",
];

/*
ARGS:
  [0] target
  [1] ramLimitGb           optional soft cap for workers on this host; -1 or omitted = dynamic free RAM
  [2] gapMs                landing gap between HWGW phases
  [3] desiredHackFraction  requested hack fraction
  [4] pollMs               polling interval
  [5] instanceTag          optional label shown in logs / ps args

Backward-compat:
  If arg[5] is numeric, it is treated as the old deprecated reserveRamGb and ignored.
  If arg[6] exists, it is treated as the tag from the old layout.
*/

/** @param {NS} ns */
export async function main(ns) {
  var target = ns.args.length > 0 ? String(ns.args[0]) : "";
  var ramLimitGb = Math.max(-1, normalizeNumber(ns.args.length > 1 ? ns.args[1] : undefined, -1));
  var gapMs = Math.max(20, normalizeNumber(ns.args.length > 2 ? ns.args[2] : undefined, 100));
  var desiredHackFraction = clamp(normalizeNumber(ns.args.length > 3 ? ns.args[3] : undefined, 0.05), 0.001, 0.95);
  var pollMs = Math.max(20, normalizeNumber(ns.args.length > 4 ? ns.args[4] : undefined, 200));

  var execHost = ns.getHostname();
  var sourceHost = "home";
  var filesToDeploy = [BATCHER].concat(WORKER_FILES);
  var instanceTag = getOptionalInstanceTag(ns.args, target, execHost);

  if (!target) {
    target = String(await ns.prompt("Target hostname:", { type: "text" }));
  }

  if (!target) {
    ns.tprint("No target provided. Starter cancelled.");
    return;
  }

  if (!instanceTag) {
    instanceTag = target + "@" + execHost + "-" + Date.now();
  }

  if (!ns.serverExists(execHost)) {
    ns.tprint('ERROR: Execution host "' + execHost + '" does not exist.');
    return;
  }

  if (!ns.serverExists(sourceHost)) {
    ns.tprint('ERROR: Source host "' + sourceHost + '" does not exist.');
    return;
  }

  if (ns.args.length > 5 && isNumericLike(ns.args[5])) {
    ns.tprint("NOTE: legacy reserveRamGb argument detected and ignored.");
  }

  var i;
  for (i = 0; i < filesToDeploy.length; i++) {
    if (!ns.fileExists(filesToDeploy[i], sourceHost)) {
      ns.tprint('ERROR: Source file missing on "' + sourceHost + '": ' + filesToDeploy[i]);
      return;
    }
  }

  var homeBatcherRam = ns.getScriptRam(BATCHER, sourceHost);
  if (homeBatcherRam <= 0) {
    ns.tprint(
      'Failed preflight: "' + BATCHER + '" on "' + sourceHost + '" is missing or unreadable ' +
      "(getScriptRam returned " + homeBatcherRam + ")."
    );
    return;
  }

  if (execHost !== sourceHost) {
    var copied = await ns.scp(filesToDeploy, execHost, sourceHost);
    if (!copied) {
      ns.tprint('ERROR: Failed to scp files from "' + sourceHost + '" to "' + execHost + '".');
      return;
    }
  }

  for (i = 0; i < filesToDeploy.length; i++) {
    if (!ns.fileExists(filesToDeploy[i], execHost)) {
      ns.tprint('ERROR: "' + filesToDeploy[i] + '" missing on "' + execHost + '" after deploy.');
      return;
    }
  }

  var execBatcherRam = ns.getScriptRam(BATCHER, execHost);
  if (execBatcherRam <= 0) {
    ns.tprint(
      'Failed preflight: "' + BATCHER + '" on "' + execHost + '" is present but unreadable ' +
      "(getScriptRam returned " + execBatcherRam + ")."
    );
    return;
  }

  var procs = ns.ps(execHost);
  for (i = 0; i < procs.length; i++) {
    if (procs[i].filename === BATCHER && procs[i].args.length > 0 && String(procs[i].args[0]) === target) {
      ns.tprint(
        'Batcher already running on "' + execHost + '" for "' + target + '" ' +
        "(PID " + procs[i].pid + ")."
      );
      return;
    }
  }

  var execMaxRam = ns.getServerMaxRam(execHost);
  if (ramLimitGb >= 0 && ramLimitGb > execMaxRam) {
    ns.tprint(
      'Failed preflight: ramLimitGb exceeds host capacity on "' + execHost + '". ' +
      "ramLimitGb=" + ramLimitGb + "GB maxRam=" + execMaxRam.toFixed(2) + "GB."
    );
    return;
  }

  var minimumWorkerRam = getMinimumWorkerRam(ns, execHost);
  if (ramLimitGb >= 0 && minimumWorkerRam > 0 && ramLimitGb < minimumWorkerRam) {
    ns.tprint(
      'Failed preflight: ramLimitGb is too low to run any worker on "' + execHost + '". ' +
      "ramLimitGb=" + ramLimitGb + "GB minimumWorkerRam=" + minimumWorkerRam.toFixed(2) + "GB."
    );
    return;
  }

  var freeRam = ns.getServerMaxRam(execHost) - ns.getServerUsedRam(execHost);
  if (freeRam < execBatcherRam) {
    ns.tprint(
      'Failed preflight: not enough free RAM on "' + execHost + '" to start the batcher. ' +
      "Need " + execBatcherRam.toFixed(2) + " GB, have " + freeRam.toFixed(2) + " GB."
    );
    return;
  }

  var pid = ns.exec(
    BATCHER,
    execHost,
    1,
    target,
    ramLimitGb,
    gapMs,
    desiredHackFraction,
    pollMs,
    instanceTag
  );

  if (pid === 0) {
    ns.tprint(
      'Failed to start batcher on "' + execHost + '". ' +
      "freeRam=" + freeRam.toFixed(2) + "GB, " +
      "batcherRam=" + execBatcherRam.toFixed(2) + "GB, " +
      "target=" + target + ", " +
      "ramLimitGb=" + ramLimitGb + ", " +
      "gapMs=" + gapMs + ", " +
      "desiredHackFraction=" + desiredHackFraction + ", " +
      "pollMs=" + pollMs + ", " +
      "tag=" + instanceTag
    );
    return;
  }

  ns.tprint(
    'Started HWGW batcher (PID ' + pid + ') on "' + execHost + '" ' +
    'targeting "' + target + '" ' +
    "(ramMode=" + describeRamMode(ramLimitGb) + ", gapMs=" + gapMs +
    ", desiredHackFraction=" + desiredHackFraction + ", pollMs=" + pollMs +
    ", tag=" + instanceTag + ")."
  );
}

function getOptionalInstanceTag(args, target, execHost) {
  if (args.length > 6) {
    return String(args[6]);
  }

  if (args.length > 5 && !isNumericLike(args[5])) {
    return String(args[5]);
  }

  return target ? (target + "@" + execHost + "-" + Date.now()) : "";
}

function describeRamMode(ramLimitGb) {
  if (ramLimitGb < 0) {
    return "dynamic free RAM";
  }
  return "capped at " + ramLimitGb + " GB";
}

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

function isNumericLike(value) {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  return Number.isFinite(Number(value));
}

function normalizeNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  var parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
