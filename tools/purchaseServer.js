/**
   * @typedef {import("../lib/server-store.types").ServerStore} ServerStore
   */

import { buildHomeNeighborStore, readServerStore } from "../lib/server-store";
const CLOUD_SERVER_PREFIX = "pserv-";

let targetRam = -1;
let serverPurchaseCost = -1;

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @arg {number} size size of the server.  Should be computed
 */
export async function main(ns, size = 512) {

  /** @type {boolean} */
  let success = false;

  targetRam = (ns.args[0] ? ns.args[0] : await getDesiredRamSize(ns))
  // targetRam = await getDesiredRamSize(ns);
  serverPurchaseCost = ns.getPurchasedServerCost(targetRam);

  // prompt player to buy a server
  if (ns.getPlayer().money > serverPurchaseCost) {
    const wantsToBuyServer = await ns.prompt(
      `Would you like to upgrade to a ${targetRam}GB server for \$${serverPurchaseCost}?`,
      { type: "boolean" }
    );
    
    if (wantsToBuyServer) {
      // const newName = ns.purchaseServer(hostname, targetRam);
      const largestTag = getMaxCloudServerTag(ns);
      ns.print("Largest server tag found was " + largestTag);
      let newName = "";

      if (largestTag == -1) {
          // await ns.sleep(1000);
          // ns.alert("Server purchased: ");
          // ns.exec("tools/renameServer.js","home", 1, CLOUD_SERVER_PREFIX + "0");
          
          newName = ns.purchaseServer(CLOUD_SERVER_PREFIX + "0", targetRam);
          success = (newName == null) ? true : false;
      } else { 
          // tryRenameServer(ns, getMaxCloudServerTag(ns));
          newName = ns.purchaseServer(CLOUD_SERVER_PREFIX + (largestTag + 1).toString(), targetRam);
          success = (newName == null) ? true : false;
      }
      if (success) ns.tprint(`SUCCESS: Server ${newName} purchased`);
    }
  } else {
    ns.tprint(`WARNING You do not have enough for the server upgrade.
      Needed: ${serverPurchaseCost} `);
  }
}


/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} targetServer hostname
 * @param {number} maxCloudSuffix 
 */
function tryRenameServer(ns, targetServer, maxCloudSuffix) { 
  const newTag = maxCloudSuffix + 1;
  let newName = CLOUD_SERVER_PREFIX;
  if (!ns.serverExists(targetServer)) {
    ns.print("WARNING Server not found!");
    return false;
  }
  if (maxCloudSuffix < 0) { 
    newName.concat("0");
    ns.exec("tools/renameServer.js","home", 1, CLOUD_SERVER_PREFIX + newTag);
    return true;
  } else if (maxCloudSuffix <= 24) {
    newName.concat(newTag.toString());
    ns.exec("tools/renameServer.js","home", 1, CLOUD_SERVER_PREFIX + newTag);
    return true;
  }
  return false;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 */
function computeLargestAffordableServerSize(ns) { 
    
}

/**
 * finds the highest value numeric tag on a cloud server and returns it
 * @param {import("NetscriptDefinitions").NS} ns
 * @returns {number} the greatest server prefix found, else -1
 */
function getMaxCloudServerTag(ns) {
  
  // check the server store, only read if it's empty
  /** @type {ServerStore} */
  const store = buildHomeNeighborStore(ns, "/data/home-neightbors.json", 1);

  // filter out any servers that don't start with "pserv-"
  let highestPrefix = -1;       // start at -1 so we know if it's < 0 then we know no pserv servers exist
  for (const server of store.servers) { 
    if (!server.hostname.includes(CLOUD_SERVER_PREFIX)) continue;
    // get last character
    const endChar = server.hostname.charAt(server.hostname.length);
    // debug check:
    ns.tprint(`INFO: Final char of ${server.hostname} should be ${endChar}`);

    // todo: sanity check it: make sure it's a number (hint: use regex)

    if (Number.parseInt(endChar) > highestPrefix) highestPrefix = Number.parseInt(endChar);
  }
  
  return highestPrefix;
}




/**
 * 
 * @param {import("NetscriptDefinitions").NS} ns
 * @returns {Promise<number>}
 */
export async function getDesiredRamSize(ns) {
  const resultD = await ns.prompt("Please select the RAM size of the server.", {
    type: "select",
    choices: [512, 1024, 2048, 4096, 8144, 32134, 65536, 131072, 262144, 524288, 1048576]
  });

  ns.tprint(`You selected to upgrade ${resultD.toLowerCase()}.
  This will cost \$${ns.getPurchasedServerCost(resultD)}`);
  return Number.parseInt(resultD);
}

