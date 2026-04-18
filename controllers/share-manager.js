const SHARE_WORKER = "/workers/share-loop.js";

/** @param {NS} ns */
export async function main(ns) {
  let execHost = String(ns.args[0] ?? "");
  let dedicateRamGb = ns.args[1];
  let reserveRamGb = ns.args[2];

  // Collect missing knobs from the user.
  if (!execHost) {
    execHost = String(await ns.prompt("Execution host for sharing:", { type: "text" }));
  }

  if (!execHost) {
    ns.tprint("No execution host provided. Cancelled.");
    return;
  }

  if (!ns.serverExists(execHost)) {
    ns.tprint(`Host does not exist: ${execHost}`);
    return;
  }

  if (dedicateRamGb === undefined) {
    dedicateRamGb = await promptNumber(
      ns,
      "How much RAM should be dedicated to sharing? (GB)",
      32
    );
  }

  if (reserveRamGb === undefined) {
    reserveRamGb = await promptNumber(
      ns,
      "How much RAM should be reserved and left unused? (GB)",
      execHost === "home" ? 8 : 0
    );
  }

  dedicateRamGb = Math.max(0, Number(dedicateRamGb));
  reserveRamGb = Math.max(0, Number(reserveRamGb));

  if (dedicateRamGb <= 0) {
    ns.tprint("Dedicated RAM must be greater than 0.");
    return;
  }

  // Make sure the worker exists on the target host.
  const copied = await ns.scp(SHARE_WORKER, execHost, "home");
  if (!copied || !ns.fileExists(SHARE_WORKER, execHost)) {
    ns.tprint(`Failed to deploy ${SHARE_WORKER} to ${execHost}.`);
    return;
  }

  const workerRam = ns.getScriptRam(SHARE_WORKER, execHost);
  if (workerRam <= 0) {
    ns.tprint(
      `Could not read RAM cost for ${SHARE_WORKER} on ${execHost}. ` +
      `Check the filename and path.`
    );
    return;
  }

  const maxRam = ns.getServerMaxRam(execHost);
  const usedRam = ns.getServerUsedRam(execHost);
  const freeRamAfterReserve = Math.max(0, maxRam - usedRam - reserveRamGb);

  // We can only dedicate what is actually free after reserve.
  const usableBudgetGb = Math.min(dedicateRamGb, freeRamAfterReserve);
  const threads = Math.floor(usableBudgetGb / workerRam);

  if (threads < 1) {
    ns.tprint(
      `Not enough RAM on ${execHost}. ` +
      `Free after reserve: ${freeRamAfterReserve.toFixed(2)} GB, ` +
      `worker RAM: ${workerRam.toFixed(2)} GB.`
    );
    return;
  }

  // Optional convenience:
  // kill any older copy of the share worker so the new budget is cleanly applied.
  ns.scriptKill(SHARE_WORKER, execHost);

  const pid = ns.exec(SHARE_WORKER, execHost, threads);
  if (pid === 0) {
    ns.tprint(
      `Failed to launch ${SHARE_WORKER} on ${execHost} ` +
      `with ${threads} thread(s).`
    );
    return;
  }

  ns.tprint(
    `Started ${SHARE_WORKER} on ${execHost} with ${threads} thread(s). ` +
    `Approx RAM used: ${(threads * workerRam).toFixed(2)} GB.`
  );

  // Open a live log window so you can watch the effect.
  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.ui.resizeTail(500, 260);

  while (true) {
    const currentUsedRam = ns.getServerUsedRam(execHost);
    const currentFreeRam = Math.max(0, ns.getServerMaxRam(execHost) - currentUsedRam);

    ns.clearLog();
    ns.print(`Share manager`);
    ns.print(`Host:              ${execHost}`);
    ns.print(`Worker:            ${SHARE_WORKER}`);
    ns.print(`Threads launched:  ${threads}`);
    ns.print(`Worker RAM/thread: ${workerRam.toFixed(2)} GB`);
    ns.print(`Reserved RAM:      ${reserveRamGb.toFixed(2)} GB`);
    ns.print(`Host free RAM now: ${currentFreeRam.toFixed(2)} GB`);
    ns.print(`Share power:       ${ns.getSharePower().toFixed(4)}`);

    await ns.sleep(1000);
  }
}

/**
 * Prompt the user for a numeric value.
 *
 * @param {NS} ns - Bitburner Netscript handle.
 * @param {string} message - Prompt text shown to the user.
 * @param {number} fallback - Default value if blank or invalid.
 * @returns {Promise<number>} Parsed numeric result.
 */
async function promptNumber(ns, message, fallback) {
  const raw = String(await ns.prompt(`${message}\nDefault: ${fallback}`, { type: "text" }));

  if (raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}