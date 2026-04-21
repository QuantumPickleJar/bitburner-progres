const CONTROLLER = "/controllers/hgw-controller.js";
const WORKER_FILES = [
  "/workers/hack-once.js",
  "/workers/grow-once.js",
  "/workers/weaken-once.js",
];

// ─────────────────────────────────────────────────────────────────────
// ARGS:  target  [reserveRamGb]  [pollMs]
//
//   target        — hostname of the server to hack/grow/weaken
//   reserveRamGb  — GB of RAM to leave free for other scripts (default: 8 on home, 0 elsewhere)
//   pollMs        — polling interval in ms (default: 200)
//
// The execution host (where the controller + workers run) is always
// the machine this launcher is running on — ns.getHostname().
// To target a different exec host, scp this script there and run it
// there, or use the interactive prompt override.
// ─────────────────────────────────────────────────────────────────────

/** @param {NS} ns */
export async function main(ns) {
  let target       = String(ns.args[0] ?? "");
  let reserveRamGb = ns.args[1];
  let pollMs       = ns.args[2];

  // The default exec host is wherever this launcher is running.
  // The interactive prompt gives the user a chance to override it
  // (e.g., if they want to run the launcher from home but deploy
  // to a remote server).
  let execHost = ns.getHostname();

  // ── Interactive prompts for missing values ───────────────────────

  if (!target) {
    target = String(await ns.prompt("Target hostname:", { type: "text" }));
  }

  if (!target) {
    ns.tprint("No target provided. Starter cancelled.");
    return;
  }

  // Offer to override execHost, but default to current machine.
  const overrideHost = String(
    await ns.prompt(
      `Execution host (where the controller + workers run).\n` +
      `Press Enter to use current host: ${execHost}`,
      { type: "text" }
    )
  );

  if (overrideHost.trim()) {
    execHost = overrideHost.trim();
  }

  if (!ns.serverExists(execHost)) {
    ns.tprint(`ERROR: Execution host "${execHost}" does not exist.`);
    return;
  }

  if (reserveRamGb === undefined) {
    reserveRamGb = await promptNumber(
      ns,
      "Reserved RAM to leave free on exec host (GB)",
      execHost === "home" ? 8 : 0
    );
  }

  if (pollMs === undefined) {
    pollMs = await promptNumber(
      ns,
      "Polling interval in milliseconds",
      200
    );
  }

  reserveRamGb = normalizeNumber(reserveRamGb, execHost === "home" ? 8 : 0);
  pollMs = Math.max(50, normalizeNumber(pollMs, 200));

  // ── Deploy all files to the execution host ───────────────────────
  // Both the controller and workers must exist on execHost.
  const filesToDeploy = [CONTROLLER, ...WORKER_FILES];
  const sourceHost = ns.getHostname();

  if (execHost !== sourceHost) {
    const copied = await ns.scp(filesToDeploy, execHost, sourceHost);
    if (!copied) {
      ns.tprint(`ERROR: Failed to scp files to "${execHost}".`);
      return;
    }
  }

  for (const file of filesToDeploy) {
    if (!ns.fileExists(file, execHost)) {
      ns.tprint(`ERROR: "${file}" missing on "${execHost}" after deploy.`);
      return;
    }
  }

  // Stop any older controller instance on the exec host.
  ns.scriptKill(CONTROLLER, execHost);

  // ── Launch the controller ON the exec host ───────────────────────
  // Controller args: [target, reserveRamGb, pollMs]
  // No execHost arg — the controller uses ns.getHostname().
  const pid = ns.exec(
    CONTROLLER,
    execHost,
    1,
    target,
    reserveRamGb,
    pollMs
  );

  if (pid === 0) {
    ns.tprint(
      `Failed to start controller on "${execHost}". ` +
      `Check root access, RAM, connectivity, and that ${CONTROLLER} exists.`
    );
    return;
  }

  ns.tprint(
    `Started HGW controller (PID ${pid}) on "${execHost}" ` +
    `targeting "${target}" ` +
    `(reserveRamGb=${reserveRamGb}, pollMs=${pollMs}).`
  );
}

/**
 * Prompts the user for a numeric value, with a fallback default.
 *
 * @param {NS} ns
 * @param {string} message
 * @param {number} fallback
 * @returns {Promise<number>}
 */
async function promptNumber(ns, message, fallback) {
  const raw = String(await ns.prompt(`${message}\nDefault: ${fallback}`, { type: "text" }));
  if (raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Normalizes a possibly-invalid numeric input.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}