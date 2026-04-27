// AT WORK
// /** @typedef {import("../NetscriptDefinitions").Server} Server */
//  /** @typedef {import("./lib/server-store.types").ServerStore} ServerStore */
// /** @typedef {import("./lib/server-store.types").ServerSnapshot} ServerSnapshot  */
// /** @typedef {import("./lib/server-store.types").ServerStoreMeta}  ServerStoreMeta */

// AT HOME
/** @typedef {import("NetscriptDefinitions").Server} Server */
 /** @typedef {import("../server-store.types.js").ServerStore} ServerStore */
/** @typedef {import("../server-store.types.js").ServerSnapshot} ServerSnapshot  */
/** @typedef {import("../server-store.types.js").ServerStoreMeta}  ServerStoreMeta */

// import { readServerStore } from "./lib/server-store.js";
import { readServerStore } from "../bitburner-progres/lib/server-store.js";
const EARLY_HACK_PATH = "scripts/early-hack-template.js";
const START_HWGW_V2_PATH = "/bitburner-progres/controllers/start-hwgw-v2.js";
const DEFAULT_FILE = "/data/home-neighbors.json";
const YIELD_EVERY = 20;
const LOG_HOST_LIMIT = 40;
const DEPLOY_DELAY_MS = 30;
const MAX_DEPLOYS_PER_RUN = 20;
const MAX_EARLY_LAUNCHES_PER_RUN = 14;
const MAX_BATCHER_LAUNCHES_PER_RUN = 6;
// const DEFAULT_FILE_VS_CODE = "./data/home-neighbors.json";

/**
 * @type {Array<ServerSnapshot>}
 */
let servers = [];

/** 
 * @param {import("NetscriptDefinitions").NS} ns
 */
export async function main(ns) {

    if (!acquireSingleInstance(ns)) {
        return;
    }

    servers = init(ns);
    ns.disableLog("getServerNumPortsRequired");
    ns.print(`INFO: Finished loading ${servers.length} servers from ${DEFAULT_FILE}`)

    const candidateServers = servers.filter((s) =>
        s &&
        typeof s.hostname === "string" &&
        !shouldSkipDeploymentHost(ns, s.hostname)
    );

    ns.print(`INFO: filtered down to ${candidateServers.length}`)

    // Pre-compute required ports once per server to avoid repeated NS API calls.
    const withPorts = candidateServers.map((s) => ({ s, ports: getPortsRequired(ns, s) }));

    const hostLogLimit = Math.min(withPorts.length, LOG_HOST_LIMIT);
    for (let i = 0; i < hostLogLimit; i += 1) {
        const { s, ports } = withPorts[i];
        ns.print(`  ${s.hostname}: ports=${ports}, root=${ns.hasRootAccess(s.hostname)}, ram=${s.maxRam}GB`);
    }
    if (withPorts.length > hostLogLimit) {
        ns.print(`INFO: host detail log truncated (${hostLogLimit}/${withPorts.length})`);
    }

    const servers0Port = withPorts.filter(({ ports }) => ports === 0).map(({ s }) => s);
    ns.print(`INFO ${servers0Port.length} servers with 0 ports`)
    const servers1Port = withPorts.filter(({ ports }) => ports === 1).map(({ s }) => s);
    ns.print(`INFO ${servers1Port.length} servers with 1 ports`)
    const servers2Port = withPorts.filter(({ ports }) => ports === 2).map(({ s }) => s);
    ns.print(`INFO ${servers2Port.length} servers with 2 ports`)
    const servers3Port = withPorts.filter(({ ports }) => ports === 3).map(({ s }) => s);
    ns.print(`INFO ${servers3Port.length} servers with 3 ports`)
    const servers4Port = withPorts.filter(({ ports }) => ports === 4).map(({ s }) => s);
    ns.print(`INFO ${servers4Port.length} servers with 4 ports`)
    const servers5Port = withPorts.filter(({ ports }) => ports === 5).map(({ s }) => s);
    ns.print(`INFO ${servers5Port.length} servers with 5 ports`)

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
    /** @type {{ remaining: number, earlyRemaining: number, batcherRemaining: number }} */
    const budget = {
        remaining: MAX_DEPLOYS_PER_RUN,
        earlyRemaining: MAX_EARLY_LAUNCHES_PER_RUN,
        batcherRemaining: MAX_BATCHER_LAUNCHES_PER_RUN,
    };

    await dispatchPortQueues(ns, [
        { portsRequired: 5, servers: servers5Port },
        { portsRequired: 4, servers: servers4Port },
        { portsRequired: 3, servers: servers3Port },
        { portsRequired: 2, servers: servers2Port },
        { portsRequired: 1, servers: servers1Port },
        { portsRequired: 0, servers: servers0Port },
    ], budget);

    ns.print(`INFO: deploy budget remaining=${budget.remaining}, early remaining=${budget.earlyRemaining}, batcher remaining=${budget.batcherRemaining}`);
}

/**
 * Prevent duplicate instances from stampeding deployments.
 * @param {import("NetscriptDefinitions").NS} ns
 * @returns {boolean}
 */
function acquireSingleInstance(ns) {
    const sameScript = ns.ps("home").filter((p) => p.filename === ns.getScriptName());
    if (sameScript.length > 1) {
        ns.print("WARN: another startMeUp-v2 instance is already running; exiting");
        return false;
    }
    return true;
}

/**
 * Exclude player infrastructure and cloud-like hosts that should not run
 * self-targeting worker/controller scripts.
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} hostname
 * @returns {boolean}
 */
function shouldSkipDeploymentHost(ns, hostname) {
    if (hostname === "home" || hostname.startsWith("p-serv")) {
        return true;
    }

    const lowerName = hostname.toLowerCase();
    if (lowerName.startsWith("hacknet-node-") || lowerName.startsWith("hacknet-server-")) {
        return true;
    }

    if (!ns.serverExists(hostname)) {
        return true;
    }

    const liveServer = ns.getServer(hostname);
    if (liveServer.purchasedByPlayer) {
        return true;
    }

    const organizationName = String(liveServer.organizationName || "").toLowerCase();
    if (organizationName.includes("hacknet") || organizationName.includes("cloud")) {
        return true;
    }

    return false;
}

/** primes the server-store so it's guaranteed to be populated on a fresh reset
 * @param {import("NetscriptDefinitions").NS} ns
*/
export function init(ns) { 
    var datum = readServerStore(ns, DEFAULT_FILE);
    // iterate over the JSON and build server objects 
    
    /** @type {Array<ServerSnapshot>} */
    const servers = datum.servers;
    return servers;
}

 /** 
  * @param {import("../server-store.types.js").ServerSnapshot} serv
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

/** @param {import("NetscriptDefinitions").NS} ns */
function canUseFormulas(ns) {
    return ns.fileExists("Formulas.exe", "home");
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} hostname
 */
function launchStartHwgwV2(ns, hostname) {
    if (canUseFormulas(ns)) {
        return ns.exec(START_HWGW_V2_PATH, hostname, 1, hostname, "--poll", 50, "-f");
    } else {
        return ns.exec(START_HWGW_V2_PATH, hostname, 1, hostname, "--poll", 50);
    }
}

/**
 * Let Bitburner scheduler breathe during large deployment runs.
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {number} i
 */
async function maybeYield(ns, i) {
    if (i > 0 && i % YIELD_EVERY === 0) {
        await ns.sleep(0);
    }
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {{ remaining: number, earlyRemaining: number, batcherRemaining: number }} budget
 * @returns {boolean}
 */
function consumeBudget(ns, budget) {
    if (budget.remaining <= 0) {
        ns.print(`INFO: reached max deployments for this run (${MAX_DEPLOYS_PER_RUN})`);
        return false;
    }
    budget.remaining -= 1;
    return true;
}

/**
 * @param {string} name
 * @returns {string}
 */
function normalizeScriptName(name) {
    return String(name).replace(/^[./]+/, "");
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} host
 * @param {string} script
 * @returns {boolean}
 */
function isScriptRunningOnHost(ns, host, script) {
    const wanted = normalizeScriptName(script);
    return ns.ps(host).some((p) => normalizeScriptName(p.filename) === wanted);
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} host
 * @param {{ remaining: number, earlyRemaining: number, batcherRemaining: number }} budget
 * @returns {boolean}
 */
function tryLaunchEarly(ns, host, budget) {
    if (isScriptRunningOnHost(ns, host, EARLY_HACK_PATH)) {
        return true;
    }
    if (budget.earlyRemaining <= 0) {
        ns.print(`INFO: early-hack launch cap reached (${MAX_EARLY_LAUNCHES_PER_RUN})`);
        return false;
    }
    const pid = ns.exec(EARLY_HACK_PATH, host, 1);
    if (pid !== 0) {
        budget.earlyRemaining -= 1;
        return true;
    }
    return false;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} host
 * @param {{ remaining: number, earlyRemaining: number, batcherRemaining: number }} budget
 * @returns {boolean}
 */
function tryLaunchBatcher(ns, host, budget) {
    // If this launcher is already running on the host, treat it as "0 batchers"
    // for this slot and reroll another candidate in the same queue.
    if (isScriptRunningOnHost(ns, host, START_HWGW_V2_PATH)) {
        return false;
    }
    if (budget.batcherRemaining <= 0) {
        ns.print(`INFO: batcher launch cap reached (${MAX_BATCHER_LAUNCHES_PER_RUN})`);
        return false;
    }
    const pid = launchStartHwgwV2(ns, host);
    if (pid !== 0) {
        budget.batcherRemaining -= 1;
        return true;
    }
    return false;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {Array<{ portsRequired: number, servers: Array<import("../server-store.types.js").ServerSnapshot> }>} queues
 * @param {{ remaining: number, earlyRemaining: number, batcherRemaining: number }} budget
 */
async function dispatchPortQueues(ns, queues, budget) {
    const pendingQueues = queues
        .map((queue) => ({
            portsRequired: queue.portsRequired,
            servers: [...queue.servers],
        }))
        .filter((queue) => queue.servers.length > 0);

    let dispatchCount = 0;

    while (budget.remaining > 0) {
        let madeProgress = false;

        for (let i = 0; i < pendingQueues.length; i += 1) {
            const queue = pendingQueues[i];
            if (queue.servers.length === 0 || budget.remaining <= 0) {
                continue;
            }

            // Try this queue at most once per server during this pass.
            // This preserves reroll behavior but prevents infinite spin when
            // all candidates in a queue are currently non-launchable.
            let attempts = 0;
            const attemptLimit = queue.servers.length;

            while (attempts < attemptLimit && budget.remaining > 0 && queue.servers.length > 0) {
                await maybeYield(ns, dispatchCount);

                const serv = queue.servers[0];
                if (!serv) {
                    break;
                }

                const result = await deployServer(ns, serv, queue.portsRequired, budget);
                dispatchCount += 1;
                attempts += 1;

                if (result.deployed) {
                    // Pop servers only when deployment actually succeeded.
                    queue.servers.shift();
                    madeProgress = true;
                    break;
                }

                if (result.reroll && queue.servers.length > 1) {
                    // Move failed candidate to back and retry this queue.
                    const rotated = queue.servers.shift();
                    if (rotated) {
                        queue.servers.push(rotated);
                    }
                    continue;
                }

                break;
            }
        }

        if (!madeProgress) {
            return;
        }
    }
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {import("../server-store.types.js").ServerSnapshot} serv
 * @param {number} portsRequired
 * @param {{ remaining: number, earlyRemaining: number, batcherRemaining: number }} budget
 * @returns {Promise<{ deployed: boolean, reroll: boolean }>}
 */
async function deployServer(ns, serv, portsRequired, budget) {
    if (!openPortsAndNuke(ns, serv.hostname, portsRequired)) {
        return { deployed: false, reroll: false };
    }
    if (budget.remaining <= 0) {
        ns.print(`INFO: reached max deployments for this run (${MAX_DEPLOYS_PER_RUN})`);
        return { deployed: false, reroll: false };
    }

    const ramRestricted = getRamLessThan32(serv);
    deployScripts(serv, ns);

    let launched = false;
    let reroll = false;

    if (ramRestricted) {
        if (serv.maxRam > 0) {
            launched = tryLaunchEarly(ns, serv.hostname, budget);
        }
    } else {
        launched = tryLaunchBatcher(ns, serv.hostname, budget);
        if (!launched) {
            reroll = true;
        }
    }

    if (!launched) {
        return { deployed: false, reroll };
    }

    if (!consumeBudget(ns, budget)) {
        return { deployed: false, reroll: false };
    }

    await ns.sleep(DEPLOY_DELAY_MS);
    return { deployed: true, reroll: false };
}

/**
  * @param {import("NetscriptDefinitions").NS} ns
  * @param {Array<import("../server-store.types.js").ServerSnapshot>} servers
    * @param {{ remaining: number, earlyRemaining: number, batcherRemaining: number }} budget
  */
export async function attack0PortServers(ns, servers, budget) {
    // Copy our scripts onto each server that requires 1 port
    // to gain root access. Then use brutessh() and nuke()
    // to gain admin access and run the scripts.
    for (let i = 0; i < servers.length; ++i) {
        await maybeYield(ns, i);
        const serv = servers[i];
        if (!openPortsAndNuke(ns, serv.hostname, 0)) {
            continue;
        }
        if (!consumeBudget(ns, budget)) {
            return;
        }
        deployScripts(serv, ns);
        // ns.exec("start-hwgw-v2.js", serv.hostname, 1, serv.hostname, ns.getServerMaxRam(serv.hostname) / 4, 400);
        if (serv.maxRam > 0) {
            tryLaunchEarly(ns, serv.hostname, budget);
        }
        await ns.sleep(DEPLOY_DELAY_MS);
    }
}

/**
  * @param {import("NetscriptDefinitions").NS} ns
  * @param {Array<import("../server-store.types.js").ServerSnapshot>} servers
    * @param {{ remaining: number, earlyRemaining: number, batcherRemaining: number }} budget
  */
export async function attack1PortServers(ns, servers, budget) {
    
    // Copy our scripts onto each server that requires 1 port
    // to gain root access. Then use brutessh() and nuke()
    // to gain admin access and run the scripts.
    for (let i = 0; i < servers.length; ++i) {
        await maybeYield(ns, i);
        const serv = servers[i];
        if (!openPortsAndNuke(ns, serv.hostname, 1)) {
            continue;
        }
        if (!consumeBudget(ns, budget)) {
            return;
        }
        deployScripts(serv, ns);
        // ns.exec("start-hwgw-v2.js", serv.hostname, 1, serv.hostname, ns.getServerMaxRam(serv.hostname) / 4, 400);
        tryLaunchEarly(ns, serv.hostname, budget);
        await ns.sleep(DEPLOY_DELAY_MS);
    }
}


/**
  * @param {import("NetscriptDefinitions").NS} ns
  * @param {Array<import("../server-store.types.js").ServerSnapshot>} servers
    * @param {{ remaining: number, earlyRemaining: number, batcherRemaining: number }} budget
  */
export async function attack2PortServers(ns, servers, budget) {
    // Copy our scripts onto each server that requires 1 port
    // to gain root access.
    for (let i = 0; i < servers.length; ++i) {
        await maybeYield(ns, i);
        let ramRestricted = getRamLessThan32(servers[i]);
        const serv = servers[i];
        if (!openPortsAndNuke(ns, serv.hostname, 2)) {
            continue;
        }
        if (!consumeBudget(ns, budget)) {
            return;
        }
        deployScripts(serv, ns);
        
        if (ramRestricted) { 
            if (serv.maxRam > 0) {
                tryLaunchEarly(ns, serv.hostname, budget);
            }
        } else { 
            tryLaunchBatcher(ns, serv.hostname, budget);
        }
        await ns.sleep(DEPLOY_DELAY_MS);
    }
}

/**
  * @param {import("NetscriptDefinitions").NS} ns
  * @param {Array<import("../server-store.types.js").ServerSnapshot>} servers
    * @param {{ remaining: number, earlyRemaining: number, batcherRemaining: number }} budget
  */
export async function attack3PortServers(ns, servers, budget) {
    for (let i = 0; i < servers.length; ++i) {
        await maybeYield(ns, i);
        let ramRestricted = getRamLessThan32(servers[i]);
        const serv = servers[i];
        if (!openPortsAndNuke(ns, serv.hostname, 3)) {
            continue;
        }
        if (!consumeBudget(ns, budget)) {
            return;
        }
        deployScripts(serv, ns);
        
        if (ramRestricted) { 
            if (serv.maxRam > 0) {
                tryLaunchEarly(ns, serv.hostname, budget);
            }
        } else { 
            tryLaunchBatcher(ns, serv.hostname, budget);
        }
        await ns.sleep(DEPLOY_DELAY_MS);
    }
}

/**
  * @param {import("NetscriptDefinitions").NS} ns
  * @param {Array<import("../server-store.types.js").ServerSnapshot>} servers
    * @param {{ remaining: number, earlyRemaining: number, batcherRemaining: number }} budget
  */
export async function attack4PortServers(ns, servers, budget) {
    for (let i = 0; i < servers.length; ++i) {
        await maybeYield(ns, i);
        let ramRestricted = getRamLessThan32(servers[i]);
        const serv = servers[i];
        if (!openPortsAndNuke(ns, serv.hostname, 4)) {
            continue;
        }
        if (!consumeBudget(ns, budget)) {
            return;
        }
        deployScripts(serv, ns);
        
        if (ramRestricted) { 
            if (serv.maxRam > 0) {
                tryLaunchEarly(ns, serv.hostname, budget);
            }
        } else { 
            tryLaunchBatcher(ns, serv.hostname, budget);
        }
        await ns.sleep(DEPLOY_DELAY_MS);
    }
}



/**
  * @param {import("NetscriptDefinitions").NS} ns
  * @param {Array<import("../server-store.types.js").ServerSnapshot>} servers
    * @param {{ remaining: number, earlyRemaining: number, batcherRemaining: number }} budget
  */
export async function attack5PortServers(ns, servers, budget) {
    for (let i = 0; i < servers.length; ++i) {
        await maybeYield(ns, i);
        let ramRestricted = getRamLessThan32(servers[i]);
        const serv = servers[i];
        if (!openPortsAndNuke(ns, serv.hostname, 5)) {
            continue;
        }
        if (!consumeBudget(ns, budget)) {
            return;
        }
        deployScripts(serv, ns);
        
        if (ramRestricted) { 
            if (serv.maxRam > 0) {
                tryLaunchEarly(ns, serv.hostname, budget);
            }
        } else { 
            tryLaunchBatcher(ns, serv.hostname, budget);
        }
        await ns.sleep(DEPLOY_DELAY_MS);
    }
}


