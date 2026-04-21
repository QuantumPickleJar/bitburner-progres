/** @typedef {import("../NetscriptDefinitions").Server} Server */
 /** @typedef {import("./lib/server-store.types").ServerStore} ServerStore */
/** @typedef {import("./lib/server-store.types").ServerSnapshot} ServerSnapshot  */
/** @typedef {import("./lib/server-store.types").ServerStoreMeta}  ServerStoreMeta */


// /** @typedef { boolean } */

// /** @typedef { boolean } */
// let has ssh

import { readServerStore } from "./lib/server-store.js";

const DEFAULT_FILE = "/data/home-neighbors.json";
// const DEFAULT_FILE_VS_CODE = "./data/home-neighbors.json";

/**
 * @type {Array<ServerSnapshot>}
 */
let servers = [];

/** 
 * @param {import("../NetscriptDefinitions").NS} ns
 */
export async function main(ns) {

    servers = init(ns);

    const servers0Port = servers.map((s) => servers.filter
        
    );

    /*
    // Array of all servers that don't need any ports opened
    // to gain root access. These have 16 GB of RAM
    const servers0Port = ["sigma-cosmetics",
                        "joesguns",
                        "nectar-net",
                        "hong-fang-tea",
                        "harakiri-sushi",
                        "foodnstuff"];

    // Array of all servers that only need 1 port opened
    // to gain root access. These have 32 GB of RAM
    const servers1Port = ["neo-net",
                        "zer0",
                        "max-hardware",
                        "iron-gym"];

    // Copy our scripts onto each server that requires 0 ports
    // to gain root access. Then use nuke() to gain admin access and
    // run the scripts.
    for (let i = 0; i < servers0Port.length; ++i) {
        const serv = servers0Port[i];

        // ns.scp("early-hack-template.js", serv);
        ns.scp("workers/grow-once.js", serv);
        ns.scp("workers/hack-once.js", serv);
        ns.scp("workers/weaken-once.js", serv);
        ns.scp("controllers/start-hwgw-v2.js", serv);
        ns.scp("controllers/hwgw-batcher.js", serv);

        ns.nuke(serv);
      
        ns.exec("controllers/hwgw-batcher.js", serv, 1, serv, ns.getServerMaxRam(serv) / 4, 400);
        // ns.exec("controllers/start-hwgw.js", serv, 1, serv, ns.getServerMaxRam(serv), 400);
        ns.exec("controllers/start-hgw.js", serv, 1, serv, ns.getServerMaxRam(serv) / 4, 400);
    }
*/
    // Wait until we acquire the "BruteSSH.exe" program
    while (!ns.fileExists("BruteSSH.exe")) {
        await ns.sleep(60000);
    }

    // Copy our scripts onto each server that requires 1 port
    // to gain root access. Then use brutessh() and nuke()
    // to gain admin access and run the scripts.
    for (let i = 0; i < servers1Port.length; ++i) {
        const serv = servers1Port[i];

        // ns.scp("early-hack-template.js", serv);
        // ns.brutessh(serv);
        // ns.nuke(serv);
        // ns.exec("early-hack-template.js", serv, 12);

        
    }
}

/** primes the server-store so it's guaranteed to be populated on a fresh reset
  * @param {import("../NetscriptDefinitions").NS} ns
  */
export function init(ns) { 
    var datum = readServerStore(ns, DEFAULT_FILE);
    // iterate over the JSON and build server objects 
    
    /** @type {Array<ServerSnapshot>} */
    const servers = datum.servers;
    return servers;
}

/**
  * @param {import("../NetscriptDefinitions").NS} ns
  */
export function attack0PortServers(ns) { 
    // deploy self-targeting instances of the batcher due to low RAM constraints

}

/**
  * @param {import("../NetscriptDefinitions").NS} ns
  */
export function attack1PortServers(ns) { 
    
    // deploy self-targeting
}

/**
  * @param {import("../NetscriptDefinitions").NS} ns
  */
export function attack2PortServers(ns) { 
      
}