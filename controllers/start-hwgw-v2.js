/**
 * start-hwgw-v2.js — Unified launcher for coordinated HWGW batching.
 *
 * Starts the scheduler on home, then deploys a batcher-v2 instance on the
 * current host for each target.
 *
 * Each positional arg is a "target:ramBudgetGB" pair:
 *   run start-hwgw-v2.js n00dles:32768 neo-net:2048 -f
 *
 * If the budget is omitted the batcher uses all free RAM on the host:
 *   run start-hwgw-v2.js n00dles -f
 *
 * Flags:
 *   --use-formulas / -f     Pass through to batcher (require Formulas API)
 *   --gap <ms>              Gap between HWGW landing phases (default 100)
 *   --hack <frac>           Hack fraction (default 0.25)
 *   --poll <ms>             Poll interval (default 200)
 *   --dry-run               Print what would be launched without executing
 *
 * @param {import("NetscriptDefinitions").NS} ns
 */

const SCHEDULER     = "/bitburner-progres/controllers/hwgw-scheduler.js";
const BATCHER_V2    = "/bitburner-progres/controllers/hwgw-batcher-v2.js";
const WORKER_FILES  = [
  "/workers/hack-once.js",
  "/workers/grow-once.js",
  "/workers/weaken-once.js"
];
const ALL_FILES = [SCHEDULER, BATCHER_V2].concat(WORKER_FILES);

/**
 * @param {import("NetscriptDefinitions").NS} ns
 */
export async function main(ns) {
  var flags = ns.flags([
    ["use-formulas", false],
    ["f", false],
    ["gap", 100],
    ["hack", 0.25],
    ["poll", 200],
    ["dry-run", false]
  ]);

  var useFormulas = flags["use-formulas"] || flags["f"];
  var defaultGap  = Math.max(20, Number(flags["gap"]));
  var defaultHack = Number(flags["hack"]);
  var defaultPoll = Math.max(20, Number(flags["poll"]));
  var dryRun      = flags["dry-run"];
  var posArgs     = /** @type {string[]} */ (flags._);

  var homeHost = "home";
  var execHost = ns.getHostname();

  // --- Parse "target:budgetGB" args ---
  /** @type {Array<{target:string, ramLimitGb:number}>} */
  var deployments = [];

  if (posArgs.length === 0) {
    ns.tprint("ERROR: No targets specified.");
    ns.tprint('Usage:  run start-hwgw-v2.js n00dles:32768 neo-net:2048 -f');
    ns.tprint('        run start-hwgw-v2.js n00dles  (uses all free RAM)');
    return;
  }

  for (var i = 0; i < posArgs.length; i++) {
    var raw = String(posArgs[i]);
    var colonIdx = raw.indexOf(":");
    var target, ramBudget;

    if (colonIdx > 0) {
      target    = raw.substring(0, colonIdx);
      ramBudget = Number(raw.substring(colonIdx + 1));
      if (!Number.isFinite(ramBudget) || ramBudget <= 0) {
        ns.tprint("ERROR: Invalid RAM budget in '" + raw + "'. Use target:budgetGB (e.g. n00dles:32768).");
        return;
      }
    } else {
      target    = raw;
      ramBudget = -1; // dynamic — use all free RAM
    }

    deployments.push({ target: target, ramLimitGb: ramBudget });
  }

  // --- Validate ---
  for (var d = 0; d < deployments.length; d++) {
    var dep = deployments[d];
    if (!ns.serverExists(dep.target)) {
      ns.tprint("ERROR: Target does not exist: " + dep.target);
      return;
    }
    if (!ns.hasRootAccess(dep.target)) {
      ns.tprint("ERROR: No root on target: " + dep.target);
      return;
    }
  }

  if (!ns.hasRootAccess(execHost)) {
    ns.tprint("ERROR: No root on exec host: " + execHost);
    return;
  }

  // --- Preflight: validate per-batcher RAM caps are physically achievable ---
  var execMaxRam = ns.getServerMaxRam(execHost);
  var minWorkerRamOnHost = getMinimumWorkerRam(ns, execHost);
  for (var rc = 0; rc < deployments.length; rc++) {
    var rcDep = deployments[rc];
    if (rcDep.ramLimitGb >= 0 && rcDep.ramLimitGb > execMaxRam) {
      ns.tprint(
        "ERROR: RAM budget for " + rcDep.target + " (" + rcDep.ramLimitGb + "GB) " +
        "exceeds host max RAM on \"" + execHost + "\" (" + execMaxRam.toFixed(2) + "GB)."
      );
      return;
    }
    if (rcDep.ramLimitGb >= 0 && minWorkerRamOnHost > 0 && rcDep.ramLimitGb < minWorkerRamOnHost) {
      ns.tprint(
        "ERROR: RAM budget for " + rcDep.target + " (" + rcDep.ramLimitGb + "GB) " +
        "is below the minimum worker RAM on \"" + execHost + "\" (" + minWorkerRamOnHost.toFixed(2) + "GB). " +
        "Workers could never launch."
      );
      return;
    }
  }

  // --- Dry run ---
  if (dryRun) {
    ns.tprint("=== DRY RUN ===");
    ns.tprint("Scheduler: " + SCHEDULER + " on " + homeHost + " (gapMs=" + defaultGap + ")");
    ns.tprint("Exec host: " + execHost);
    for (var dr = 0; dr < deployments.length; dr++) {
      var dd = deployments[dr];
      var ramLabel = dd.ramLimitGb < 0 ? "dynamic" : dd.ramLimitGb + " GB";
      ns.tprint("  Batcher: " + execHost + " → " + dd.target + " (ram=" + ramLabel + ")");
    }
    return;
  }

  // --- Deploy files ---
  for (var file of ALL_FILES) {
    if (!ns.fileExists(file, homeHost)) {
      ns.tprint("ERROR: Missing on home: " + file);
      return;
    }
  }

  if (execHost !== homeHost) {
    var ok = await ns.scp(ALL_FILES, execHost, homeHost);
    if (!ok) {
      ns.tprint("ERROR: SCP failed to " + execHost);
      return;
    }
  }

  // --- Start scheduler on home (if not already running) ---
  var schedulerRunning = false;
  var procs = ns.ps(homeHost);
  // Compare with and without leading "/" since ns.ps() may normalize the path
  var schedName = SCHEDULER.replace(/^\//, "");
  for (var sp = 0; sp < procs.length; sp++) {
    var pName = procs[sp].filename.replace(/^\//, "");
    if (pName === schedName) {
      schedulerRunning = true;
      ns.tprint("Scheduler already running (PID " + procs[sp].pid + ").");
      break;
    }
  }

  if (!schedulerRunning) {
    var schedPid = ns.exec(SCHEDULER, homeHost, 1, defaultGap);
    if (schedPid === 0) {
      ns.tprint("ERROR: Failed to start scheduler on " + homeHost);
      return;
    }
    ns.tprint("Started scheduler (PID " + schedPid + ") gapMs=" + defaultGap);
    // Give it a moment to initialise
    await ns.sleep(200);
  }

  // --- Launch batchers ---
  var launchCount = 0;
  var hostProcs = ns.ps(execHost);

  for (var ld = 0; ld < deployments.length; ld++) {
    var dep2 = deployments[ld];
    var tag = dep2.target + "@" + execHost + "-" + Date.now();

    // Check for duplicate
    var already = false;
    for (var hp = 0; hp < hostProcs.length; hp++) {
      if (hostProcs[hp].filename === BATCHER_V2 &&
          hostProcs[hp].args.length > 0 &&
          String(hostProcs[hp].args[0]) === dep2.target) {
        ns.tprint("Batcher already running on " + execHost + " for " + dep2.target + " (PID " + hostProcs[hp].pid + ").");
        already = true;
        break;
      }
    }
    if (already) continue;

    var batcherArgs = [
      dep2.target,
      dep2.ramLimitGb,
      tag
    ];
    if (useFormulas) {
      batcherArgs.push("--use-formulas");
    }
    batcherArgs.push("--gap", defaultGap, "--hack", defaultHack, "--poll", defaultPoll);

    var bPid = ns.exec(BATCHER_V2, execHost, 1, ...batcherArgs);
    if (bPid === 0) {
      ns.tprint("WARN: Failed to start batcher on " + execHost + " for " + dep2.target);
      continue;
    }

    var ramLabel = dep2.ramLimitGb < 0 ? "dynamic" : dep2.ramLimitGb + "GB";
    ns.tprint("Started batcher (PID " + bPid + ") on " + execHost + " → " + dep2.target +
      " [ram=" + ramLabel + ", tag=" + tag + "]");
    launchCount++;
  }

  ns.tprint("Launched " + launchCount + " batcher(s) on " + execHost + ".");
}

/**
 * @param {import("NetscriptDefinitions").AutocompleteData} data
 * @param {string[]} args
 * @returns {string[]}
 */
export function autocomplete(data, args) {
  // Offer "server:" prefixed suggestions so the user can append a RAM budget
  return data.servers.map(/** @param {string} s */ function(s) { return s + ":"; });
}

/**
 * Returns the smallest per-thread RAM cost among HWGW worker scripts on the given host.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} host
 * @returns {number}
 */
function getMinimumWorkerRam(ns, host) {
  var minimum = Infinity;
  for (var i = 0; i < WORKER_FILES.length; i++) {
    var ram = ns.getScriptRam(WORKER_FILES[i], host);
    if (ram > 0 && ram < minimum) minimum = ram;
  }
  return Number.isFinite(minimum) ? minimum : 0;
}
