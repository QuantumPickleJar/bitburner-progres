/** @param {NS} ns */
export async function main(ns) {
  const target = ns.args.length > 0 ? String(ns.args[0]) : "";
  const delayMs = Math.max(0, Number(ns.args.length > 1 ? ns.args[1] : 0) || 0);

  if (!target) return;
  if (delayMs > 0) await ns.sleep(delayMs);
  await ns.grow(target);
}
