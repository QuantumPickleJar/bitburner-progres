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

/**
 * Params:
 * - data: Bitburner autocomplete context
 * - args: current terminal args after the script name
 *
 * Offers hostnames as autocomplete suggestions, excluding ones already typed.
 *
 * @param {AutocompleteData} data
 * @param {string[]} args
 * @returns {string[]}
 */
export function autocomplete(data, args) {
  return data.servers.filter((server) => !args.includes(server));
}

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
  var instanceTag = "";

  if (!target) {
    target = String(await ns.prompt("Target hostname:", { type: "text" }));
  }

  if (!target) {
    ns.tprint("No target provided. Starter cancelled.");
    return;
  }

  instanceTag = getOptionalInstanceTag(ns.args, target, execHost);

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

  // Still blocks duplicate batchers by target on the same host.
  // If you later want multiple instances for the same target with different tags,
  // this is the gate you would relax.
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

  var freeRam = ns.getServerMaxRam(execHost) - ns.getServerUsedRam(execHost);
  if (freeRam < execBatcherRam) {
    ns.tprint(
      'Failed preflight: not enough free RAM on "' + execHost + '" to start the batcher. ' +
      "Need " + execBatcherRam.toFixed(2) + " GB, have " + freeRam.toFixed(2) + " GB."
    );
    return;
  }

  // Higher-learning note:
  // ns.exec() passes args positionally, so this must stay aligned with the batcher's parsing order.
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

/**
 * Params:
 * - args: raw ns.args array
 * - target: chosen target hostname
 * - execHost: current execution host
 *
 * Extracts the instance tag while tolerating the legacy argument layout.
 *
 * @param {Array<unknown>} args
 * @param {string} target
 * @param {string} execHost
 * @returns {string}
 */
function getOptionalInstanceTag(args, target, execHost) {
  if (args.length > 6) {
    return String(args[6]);
  }

  if (args.length > 5 && !isNumericLike(args[5])) {
    return String(args[5]);
  }

  return target ? (target + "@" + execHost + "-" + Date.now()) : "";
}

/**
 * Params:
 * - ramLimitGb: configured RAM cap
 *
 * Returns a readable label for startup logging.
 *
 * @param {number} ramLimitGb
 * @returns {string}
 */
function describeRamMode(ramLimitGb) {
  if (ramLimitGb < 0) {
    return "dynamic free RAM";
  }
  return "capped at " + ramLimitGb + " GB";
}

/**
 * Params:
 * - value: any value that may represent a number
 *
 * Checks whether a value can be safely interpreted as a finite number.
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
 * Converts a maybe-empty argument into a usable number.
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
 * Restricts a number to the provided inclusive interval.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}