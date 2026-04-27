/** @typedef {import("./../server-store.types.js").ServerStore} ServerStore */
/** @typedef {import("./../server-store.types.js").ServerSnapshot} ServerSnapshot  */
/** @typedef {import("./../server-store.types.js").ServerStoreMeta} ServerStoreMeta */
/** @typedef {import("./../server-store.types.js").ScoreResult} ScoreResult */
/** @typedef {import("./../server-store.types.js").ScoredServerSnapshotTuple} ScoredServerSnapshotTuple */
/** @typedef {{ success: boolean, server: ServerSnapshot }} HackAttemptResult */

import { readServerStore } from "../bitburner-progres/lib/server-store.js";

/** @param {import("NetscriptDefinitions").NS} ns */
export async function main(ns) { 

    /** @type {HackAttemptResult[]} */
    const hackedServers = [];
    
    // fetch a security snapshot of everything 
     const store = readServerStore(ns);
     for (const server of store.servers) {
        // prep server with our scripts
        deployScripts(server,ns);

        // check what ports are open 
        
        const serverOpened = openPortsAndNuke(ns, server.hostname, server.portsRequired);
        hackedServers.push({ success: serverOpened, server });

        // switch(server.portsRequired) {

        //     case 0:
        //         openPortsAndNuke(ns, server.hostname, server.portsRequired); 
        //         break;

        //     case 1: 
        //         break;

        //     case 2: 
        //         break;

        //     case 3: 
        //         break;

        //     case 4: 
        //         break;

        //     case 5: 
        //         break;
        // }
     }
     printResults(ns, hackedServers);

}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {HackAttemptResult[]} hackedServerResults One entry per attempted server, preserving duplicates and processing order.
 */
function printResults(ns, hackedServerResults) {
    const green = "\u001b[32m";
    const red = "\u001b[31m";
    
    for (const result of hackedServerResults) {
        ns.print(`${result.success ? green : red}${result.server.hostname}: ${result.success ? "SUCCESS" : "FAILED"}`);
    }
}


 /** 
  * @param {ServerSnapshot} serv
  * @param {import("NetscriptDefinitions").NS} ns
  */
 function deployScripts(serv, ns) {
     if (getRamLessThan32(serv)) {
         // use the early hack template
         ns.scp("scripts/early-hack-template.js", serv.hostname);
     } else {
         ns.scp("./bitburner-progres/controllers/hwgw-batcher-v2.js", serv.hostname);
         ns.scp("./bitburner-progres/controllers/start-hwgw-v2.js", serv.hostname);
     }
 }


 

/** @param {import("../server-store.types.js").ServerSnapshot} server*/
function getRamLessThan32(server) { 
    return server.maxRam ? server.maxRam < 32 : false;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {import("../server-store.types.js").ServerSnapshot} server
 * @returns {number}
 */
function getPortsRequired(ns, server) {
    if (Number.isFinite(server?.portsRequired)) {
        return Number(server.portsRequired);
    }

    // Backward-compatible fallback for snapshots that use Bitburner's native property names.
    const fallback = Number((/** @type {any} */ (server))?.numOpenPortsRequired);
    if (Number.isFinite(fallback)) {
        return fallback;
    }

    if (server?.hostname && ns.serverExists(server.hostname)) {
        return ns.getServerNumPortsRequired(server.hostname);
    }

    return 0;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} hostname
 * @param {number} portsRequired
 * @returns {boolean}
 */
function openPortsAndNuke(ns, hostname, portsRequired) {
    if (ns.hasRootAccess(hostname)) {
        return true;
    }

    let openedPorts = 0;

    if (ns.fileExists("BruteSSH.exe", "home")) {
        ns.brutessh(hostname);
        openedPorts += 1;
    }
    if (ns.fileExists("FTPCrack.exe", "home")) {
        ns.ftpcrack(hostname);
        openedPorts += 1;
    }
    if (ns.fileExists("relaySMTP.exe", "home")) {
        ns.relaysmtp(hostname);
        openedPorts += 1;
    }
    if (ns.fileExists("HTTPWorm.exe", "home")) {
        ns.httpworm(hostname);
        openedPorts += 1;
    }
    if (ns.fileExists("SQLInject.exe", "home")) {
        ns.sqlinject(hostname);
        openedPorts += 1;
    }

    if (openedPorts < portsRequired) {
        ns.print(`WARN cannot root ${hostname}: opened ${openedPorts}/${portsRequired} required ports`);
        return false;
    }

    ns.nuke(hostname);
    return ns.hasRootAccess(hostname);
}

