let targetRam = -1;
let currentRam = -1;
let serverPurchaseCost = -1;

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @arg {number} size size of the server.  Should be computed
 */
export async function main(ns, size = 512) {
  let hostname = ns.getHostname();

  targetRam = await getDesiredRamSize(ns);
  serverPurchaseCost = ns.getPurchasedServerCost(targetRam);

  // prompt player to buy a server
  if (ns.getPlayer().money > serverPurchaseCost) {
    const wantsToBuyServer = await ns.prompt(
      `Would you like to upgrade to a ${targetRam}GB server for \$${serverPurchaseCost}?`,
      { type: "boolean" }
    );
    
    if (wantsToBuyServer) {
      const newName = ns.purchaseServer(hostname, targetRam);
      if (newName) {
          await ns.sleep(1000);
          ns.alert("Server purchased: ");
        }
        ns.exec("tools/renameServer.js","home");
    }
  } else {
    ns.alert("You do not have enough for the server upgrade.");
  }
}

function computeLargestAffordableServerSize(ns) { 
    
}


export async function getDesiredRamSize(ns) {
  const resultD = await ns.prompt("Please select the RAM size of the server.", {
    type: "select",
    choices: [512, 1024, 2048, 4096, 8144, 32134, 65536, 131072, 262144, 524288, 1048576]
  });

  ns.tprint(`You selected to upgrade ${resultD.toLowerCase()}.
  This will cost \$${serverPurchaseCost}`);
  return parseInt(resultD);
}

