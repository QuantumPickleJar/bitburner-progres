/** @typedef {import("NetscriptDefinitions").Server} Server */
/** @typedef {import("../server-store.types.js").ServerStore} ServerStore */
/** @typedef {import("../server-store.types.js").ServerSnapshot} ServerSnapshot  */
/** @typedef {import("../server-store.types.js").ServerStoreMeta}  ServerStoreMeta */
/** @typedef {[number, ServerSnapshot]} ScoredServerSnapshotTupleOld */
/** @typedef {import("../server-store.types.js").ScoreResult} ScoreResult */
/** @typedef {[ScoreResult, ServerSnapshot]} ScoredServerSnapshotTuple */

import { readServerStore } from "../bitburner-progres/lib/server-store";

const DEFAULT_FILE = "data/home-neighbors.json";
const DEFAULT_WRITE_FILE = "data/scored-server-data.json";
const SORTED_SCORED_RESULTS_FILE = "data/sorted-serversnapshot.json";
/**
 * @type {Array<ServerSnapshot>}
 */
let servers = [];

/** @type { Array<ScoredServerSnapshotTuple>} */
let scoredServers = [];

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
    const sortedSnapshotsMap = getSortedHackCandidates(ns);
    scoredServers = Array.from(sortedSnapshotsMap.values());

    // ns.disableLog("serverExists");
    // // ns.disableLog("hasRootAccess");
    // ns.disableLog("getServerMaxRam");
    // ns.disableLog("getServerUsedRam");
    // ns.disableLog("getServerMaxMoney");
    // ns.disableLog("getServerMoneyAvailable");
    // ns.disableLog("getServerMinSecurityLevel");
    // ns.disableLog("getServerSecurityLevel");

    printServerMap(ns, sortedSnapshotsMap);                 // print it for sanity (checkpoint)
    ns.print(`DEBUG: Size of scoredServers: ${scoredServers.length}`);
    
    ns.write(DEFAULT_WRITE_FILE, ""); // clear any existing data 
    writeServerScores(ns, scoredServers);
    // sortMapByServerScore(sortedSnapshotsMap);   // already called in getHackCandidates
    writeSortedServerScores(ns);
    printScoresTable(ns);
}


/**
 * returns an array of servers ordered by their desirability for hacking
 * @param {import("NetscriptDefinitions").NS} ns
 * @returns array of ScoredServerSnapshotTuple
 */ 
export function getSortedHackCandidates(ns) { 
    /** @type {Map<string, ScoredServerSnapshotTuple>} */
    let primeCandidates = new Map();
    ns.print(`INFO: starting for-of loop:`);
    ns.print(`> Size of servers: ${servers.length}`);

    for(const server of servers) { 
        // ns.print(`DEBUG: Server '${server.hostname}' info: 
        //     ${(server.hasRoot) ? "ROOTED" : "UNROOTED"}, ${(server.backdoor) ? "ISOLATED" : "BACKDOORED"}, `);
        // ns.print(`DEBUG: Calculating score for ${server.hostname}...`);
        
        let serverScore = scoreTargetServer(ns, server);
        
        /** @type {ScoreResult} */
        const scoreResult = serverScore[0];

        // ns.print(`DEBUG: Calculated score of ${scoreResult.score} for ${server.hostname}.`);
        
        primeCandidates.set(server.hostname, [scoreResult, server]);
    }
    
    // ns.print(`SUCCESS assigned scores to ${primeCandidates.size} servers.`);

    // now sort them by their scores
    // const sortedCandidates = sortMapByServerScoreAsArray(primeCandidates);
    const sortedCandidates = sortMapByServerScore(primeCandidates);
    return sortedCandidates;
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
                                            b[1][0].score - a[1][0].score
                                         ).reverse();
                                         
    // now that the array is sorted, we can treat it like a queue to push into the map
    for (let i = 0; i < mutableMap.size; i++) {
        const scoredTupleRow = sortedServersArray.pop();
        if (!scoredTupleRow) continue               // null-safety check        
        sortedServersMap.set(scoredTupleRow[0],scoredTupleRow[1]);
    }

    // for (const scoredServer of sortedServersArray) {
    //     // [score, ServerSnapshot]\
    //     // TODO: verify that scoredServer[0] is the hostname and not the score
    //     sortedServersMap.set(scoredServer[0], scoredServer[1]);
    // }

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
 * @param {Array<ScoredServerSnapshotTuple>} scoreData
 */
export function writeServerScores(ns, scoreData, file = DEFAULT_WRITE_FILE) { 
    ns.write(file, JSON.stringify(scoreData, null, 2), "w");
}

/**
 * @param {import("NetscriptDefinitions").NS} ns 
 * @param {Array<ScoredServerSnapshotTuple>} scoreData
 */
export function writeSortedServerScores(ns, scoreData = scoredServers, file = SORTED_SCORED_RESULTS_FILE) { 
    ns.write(file, JSON.stringify(scoreData, null, 2), "w");
}


/**
 * @param {import("NetscriptDefinitions").NS} ns
 */
export function openLoggingTail(ns) { 
    ns.ui.openTail();
    ns.ui.resizeTail(1200, 350);
}


/**
 * @param {import("NetscriptDefinitions").NS} ns 
 * @param {import("../server-store.types").ServerSnapshot} server
 * @returns {ScoreResult} 
 */
export function computeServerScoreDetails(ns, server) { 
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
                  
    // return score;

    /** @type {ScoreResult} */
    return {
        moneyFillRatio: moneyFill,
        maxMoneyFill: maxMoneyFill,
        securityRatio: securityRatio,
        sizeScore: sizeScore,
        normalizedFill: normalizedFill,
        score: score
    };
}

/**
 * @param {import("NetscriptDefinitions").NS} ns 
 * @param {import("../server-store.types").ServerSnapshot} server
 * @return {ScoredServerSnapshotTuple} scored snapshot of the server
 */
export function scoreTargetServer(ns, server) {
    // normalization happens inside the compute method
    // ns.print(`DEBUG[scoreTargetServer]: invoked on ${server.hostname}`);

    /** @type {ScoreResult} */
    const scoreDetails = computeServerScoreDetails(ns, server);
    
    // ns.print(`DEBUG[scoreTargetServer]: computeServerScoredetails on ${server.hostname} computed 
    //     Fill ratio: ${scoreDetails.moneyFillRatio}
    //     Sec. ratio: ${scoreDetails.securityRatio}
    //     Size score: ${scoreDetails.sizeScore}
    //     Final score: ${scoreDetails.score}`);

    
    // push to scoredServers
    /** @type {ScoredServerSnapshotTuple} */
    const tuple = [scoreDetails, server];
    
    scoredServers.push(tuple);
    return tuple;
}

/* ======================= UTILITY FUNCTIONS : PRINTING ==================== */

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
 *
 * @param {import("NetscriptDefinitions").NS} ns 
 */
export function printScoresTable(ns) { 
    // read the ScoredServerSnapshotTuples from the JSON file we wrote to in writeServerScores
    
    /** @type {Array<ScoredServerSnapshotTuple>}  */
    // const tuples = JSON.parse(ns.read(DEFAULT_WRITE_FILE));
    const tuples = scoredServers;

    // print the header
    ns.printf(`\tSERVER    \tSCORE\t\tFILL\t\tSECURITY`);

    for (const duo of tuples) { 
        const stats = duo[0];
        const server = duo[1];
        // String.raw("%15s\t%4.1f",[server.hostname, stats.score]);
        ns.printf("%20s\t%8.3f\t%8.3f%%\t%.3f%%", server.hostname, stats.score, stats.moneyFillRatio * 100, stats.securityRatio * 100);
    }    
}