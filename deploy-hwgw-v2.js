
/**
 * HGW deploy helper.
 *
 * Copies the controller + workers + starter to a destination host, then verifies
 * that each file exists there.
 *
 * Example:
 *   run /tools/deploy-hgw.js pserv-1
 *   run /tools/deploy-hgw.js pserv-1 home
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const destHost = String(ns.args[0] ?? "");
  const sourceHost = String(ns.args[1] ?? "home");

  /**
   * Keep this list as the single source of truth for the HGW script pack.
   * Every path is absolute on purpose, so there is no ambiguity about folders.
   */
  const files = [
    "/bitburner-progres/controllers/start-hwgw-v2.js",
    "/bitburner-progres/controllers/hwgw-batcher-v2.js",
    "/bitburner-progres/controllers/hwgw-scheduler.js",
    "/workers/hack-once.js",
    "/workers/grow-once.js",
    "/workers/weaken-once.js",
  ];

  if (!destHost) {
    ns.tprint("Usage: run /tools/deploy-hwgw.js <destinationHost> [sourceHost]");
    return;
  }

  if (!ns.serverExists(destHost)) {
    ns.tprint(`Destination server does not exist: ${destHost}`);
    return;
  }

  if (!ns.serverExists(sourceHost)) {
    ns.tprint(`Source server does not exist: ${sourceHost}`);
    return;
  }

  // Check the source host first so you immediately know if a file path is wrong.
  const missingOnSource = files.filter((file) => !ns.fileExists(file, sourceHost));
  if (missingOnSource.length > 0) {
    ns.tprint(`Missing file(s) on source host ${sourceHost}:`);
    for (const file of missingOnSource) {
      ns.tprint(`  - ${file}`);
    }
    return;
  }

  // scp() returns false if any copy in the array failed.
  const copied = await ns.scp(files, destHost, sourceHost);

  if (!copied) {
    ns.tprint(`scp reported a failure while copying to ${destHost}.`);
  }

  // Verify each file individually on the destination.
  const missingOnDest = files.filter((file) => !ns.fileExists(file, destHost));

  if (missingOnDest.length > 0) {
    ns.tprint(`Deployment incomplete. Missing file(s) on ${destHost}:`);
    for (const file of missingOnDest) {
      ns.tprint(`  - ${file}`);
    }
    return;
  }

  ns.tprint(`HWGW bundle deployed successfully from ${sourceHost} to ${destHost}.`);
  for (const file of files) {
    ns.tprint(`  ✓ ${file}`);
  }
}

/**
 * @param {import("NetscriptDefinitions").AutocompleteData} data
 * @param {string[]} args
 * @returns {string[]}
 */
export function autocomplete(data, args) {
  return data.servers.map(
    /** @param {string} s */ 
    function(s) { return s;}
    );
}