/** @typedef {import("NetscriptDefinitions").Server} Server */
/** @typedef {import("../server-store.types.js").ServerStore} ServerStore */
/** @typedef {import("../server-store.types.js").ServerSnapshot} ServerSnapshot  */
/** @typedef {import("../server-store.types.js").ServerStoreMeta}  ServerStoreMeta */
/** @typedef {import("../server-store.types.js").NormalizedServerSnapshot} NormalizedServerSnapshot*/
/** @typedef {[number, ServerSnapshot]} ScoredServerSnapshotTuple */


import { readServerStore } from "../bitburner-progres/lib/server-store";

const DEFAULT_FILE = "data/home-neighbors.json";

/**
 * @type {Array<ServerSnapshot>}
 */
let servers = [];

/** primes the server-store so it's guaranteed to be populated on a fresh reset
 * @param {import("NetscriptDefinitions").NS} ns
*/
export function init(ns) { 
    /** @type {ServerStore} */
    const datum = readServerStore(ns, DEFAULT_FILE);
    
    // iterate over the JSON and build server objects 
    servers = datum.servers;

    ns.print(`Loaded ${servers.length} servers from /data/.`);
    ns.print(`DEBUG: equality check: parsed vs. saved? ${servers == datum.servers}`);
    return servers;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 */
export function openLoggingTail(ns) { 
    ns.ui.openTail();
    ns.ui.resizeTail(1200, 350);
}

/** 
 * @param {string[]} args accepts an optional tail to push teh 
  * @param {import("NetscriptDefinitions").NS} ns
  */
export async function main(ns, args) {
    // open the tail window for them if they pass --
    const wantsTail = String(ns.args[0] ?? false);
    // todo: clean this up 

    if (wantsTail) openLoggingTail(ns);

    init(ns);                                               // populate servers    
    ns.print(`DEBUG: calling getHackCandidates...`);
    const sortedSnapshotsMap = getHackCandidates(ns);
    
    // ns.disableLog("serverExists");
    // // ns.disableLog("hasRootAccess");
    // ns.disableLog("getServerMaxRam");
    // ns.disableLog("getServerUsedRam");
    // ns.disableLog("getServerMaxMoney");
    // ns.disableLog("getServerMoneyAvailable");
    // ns.disableLog("getServerMinSecurityLevel");
    // ns.disableLog("getServerSecurityLevel");

    printServerMap(ns, sortedSnapshotsMap);                 // print it for sanity (checkpoint)
}


/**
 * returns an array of servers ordered by their desirability for hacking
 * @param {import("NetscriptDefinitions").NS} ns
 * @returns array of ScoredServerSnapshotTuple
 */ 
export function getHackCandidates(ns) { 
    /** @type {Map<string, ScoredServerSnapshotTuple>} */
    let primeCandidates = new Map();
    ns.print(`INFO: starting for-of loop:`);
    ns.print(`> Size of servers: ${servers.length}`);

    for(const server of servers) { 
        // ns.print(`DEBUG: Server '${server.hostname}' info: 
        //     ${(server.hasRoot) ? "ROOTED" : "UNROOTED"}, ${(server.backdoor) ? "ISOLATED" : "BACKDOORED"}, `);
        // ns.print(`DEBUG: Calculating score for ${server.hostname}...`);
        
        let serverScore = assignServerScore(ns, server);
        
        ns.print(`DEBUG: Calculated score of ${serverScore} for ${server.hostname}.`);

        primeCandidates.set(server.hostname, [serverScore.normalizedScore, server]);
    }
    
    ns.print(`SUCCESS assigned scored to ${primeCandidates.size} servers.`);

    // now sort them by their scores
    // const sortedCandidates = sortMapByServerScoreAsArray(primeCandidates);
    const sortedCandidates = sortMapByServerScore(primeCandidates);
    return sortedCandidates;
}



/**
  * @param {import("NetscriptDefinitions").NS} ns
 * @param {Map<string, ScoredServerSnapshotTuple>} serversMap
 */
export function printServerMap(ns, serversMap) { 
    const serversArray = Array.from(serversMap);

    // I think the outermost string was supposed to be for using that index's ServerSnapshot.hostname as a key
    for(let i = 0; i > serversArray.length; ++i) {
        // in order, by depth: 
        // serversMap[i]       | the iterator                   (Iterable<)
        // serversMap[i][0]    | Map<K> - Hostname                                  (string)
        // serversMap[i][1]    | Map<V> - ScoredServerSnapshotTuple (string, ServerSnapshot)
        // serversMap[i][1][0] | ServerSnapshotTuple.score                          (number)
        // serversMap[i][1][1] | ServerSnapshotTuple.ServerSnapshot         (ServerSnapShot)
        
        const currentWrappedTuple = serversArray[i]; 

        // these both print the same thing, but for clarity we print serversMap[i][0]
        // ns.print(`Arr[${i}]: ${serversArray[i][1][1].hostname} with score ${serversArray[i][0]}`);
        ns.print(`Arr[${i}]: ${currentWrappedTuple[0]} with score ${currentWrappedTuple[1][0]}`);
    }
}

/**
  * @param {import("NetscriptDefinitions").NS} ns
 * @param {Array<ScoredServerSnapshotTuple>} serversArr
 */
export function printServerArray(ns, serversArr) { 
    // for(const server of serversArr) { 
    for(let i = 0; i > serversArr.length; ++i) {
        // in order, by depth: 
        // serversMap[i]       | the iterator
        // serversMap[i][0]    | Score (string)
        // serversMap[i][1]    | ScoredServerSnapshotTuple (string, ServerSnapshot)
        ns.print(`Arr[${i}]: ${serversArr[i][1].hostname} with score ${serversArr[i][0]}`);
    }
}

/**
 * this will strip the outer key in the process
 * @param {Map<string,ScoredServerSnapshotTuple>} map
 */
export function sortMapByServerScoreAsArray(map) { 
    /** @type {Array<ScoredServerSnapshotTuple>} */
    const sortedServersArray = [];

    for (const scoredServer of map) {
        if (scoredServer !== undefined) {
            sortedServersArray.push(scoredServer[1]);
        }
    }

    // sort on the scores
    return sortedServersArray.sort((a, b) => b[0] - a[0]);
}

/**
 * @param {Map<string, ScoredServerSnapshotTuple>} map
 */
export function sortMapByServerScore(map) { 
    /** @type {Map<string, ScoredServerSnapshotTuple>} */
    const sortedServersMap = new Map();
    
    /** @type {Map<string, ScoredServerSnapshotTuple>} */
    const mutableMap = new Map(map);

    for (const [hostname, scoredTuple] of mutableMap) {
        if (scoredTuple[0] !== undefined) {
            // sortedServersArray.push(scoredServer);
            // sortedServersMap.set(hostname, scoredTuple);
            mutableMap.set(hostname, scoredTuple);
        }
    }

    const sortedServersArray = mutableMap.entries()
                                         .toArray()
                                         .sort((a, b) => 
                                            b[1][0] - a[1][0]
                                         );
                                         
    // now that the array is sorted, we can treat it like a queue to push into the map
    for (let i = 0; i < mutableMap.size; i++) {
        const scoredTupleRow = sortedServersArray.pop();
        if (!scoredTupleRow) continue               // null-safety check        
        sortedServersMap.set(scoredTupleRow[0],scoredTupleRow[1]);
    }

    for (const scoredServer of sortedServersArray) {
        // [score, ServerSnapshot]\
        // TODO: verify that scoredServer[0] is the hostname and not the score
        sortedServersMap.set(scoredServer[0], scoredServer[1]);
    }

    return sortedServersMap;
    // return sortedServersArray.sort((a, b) => b[0] - a[0]);
}

/**
 * @deprecated
 * @param {ServerSnapshot} server - the server to perform normalization 
 * @return {number} value representative of server's amount of money,  relative to best
 *  and worst servers 
 */
export function normalizeServerMoney_minMax(server) { 
    const maxMoney = Math.max(
        // for all members of servers: (...)
        // run function 
        ...servers.map(s => s.maxMoney > 0 ? s.money / s.maxMoney : 0)
    );

    const normalizedMoney = maxMoney > 0 ? server.money / server.maxMoney : 0;

    return normalizedMoney;
}


/**
 * @deprecated
 * @param {ServerSnapshot} server - the server to perform normalization 
 * @return {number} value representative of server's amount of money,  relative to best
 *  and worst servers 
 */
export function normalizeServerMoney_sizeWeights(server) { 
    const maxServerMoney = Math.max(...servers.map(s => s.maxMoney));
    const normalizedMoney = maxServerMoney > 0 ? server.maxMoney / maxServerMoney : 0;
    
    return normalizedMoney;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns 
 * @param {import("../server-store.types").ServerSnapshot} server
 */
export function computeNormalizedServerScore(ns, server) { 
    // money / maxMoney --> "Is this server ready right now?"
    // normalize at a per-server scope 
    const moneyFill =  server.maxMoney > 0 ? 
                        server.money / server.maxMoney : 0;
    // minSecurity / security --> "How cheap is it to exploit this server?"
    const securityRatio = server.security > 0 ?
                          server.minSecurity / server.security : 0;
                          
    // normalize at a global scope 
    const maxMoneyFill = Math.max( 
        ...servers.map(s => s.maxMoney > 0 ? s.money / s.maxMoney : 0)
    );

    const maxServerMoney = Math.max( 
        ...servers.map(s => s.maxMoney)
    );

    const normalizedFill = maxMoneyFill > 0 ?
                           moneyFill / maxMoneyFill : 0;

    // maxMoney / globalMaxMoney --> "Is this server worth hacking at all?"
    const sizeScore = maxServerMoney > 0 ? 
                      server.maxMoney / maxServerMoney : 0;

    // compute the final score
    const score = 0.40 * normalizedFill + 
                  0.30 * securityRatio + 
                  0.30 * sizeScore;
                  
    return score;
}



/**
 * @param {import("NetscriptDefinitions").NS} ns 
 * @param {import("../server-store.types").ServerSnapshot} server
 * @return {import("../server-store.types").NormalizedServerSnapshot} scored snapshot of the server
 */
export function assignServerScore(ns, server) {
    // normalization happens inside the compute method
    const score = computeNormalizedServerScore(ns, server);

    ns.print(`INFO Results:
        Money: ${moneyFill}
        Sec:   ${securityRatio}
        Size:  ${sizeScore}
        Final score: ${score}
        `);

    // return score;

    /** @type {NormalizedServerSnapshot} */
    const scoredServerSnapshot = { 
        maxMoney: server.maxMoney,
        moneyNow: server.money,
        minSecurity: server.minSecurity,
        security: server.security,
        normalizedScore: score
    };

    return scoredServerSnapshot;
}