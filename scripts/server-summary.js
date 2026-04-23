/**
 * 
 * SERVERS   
 * Filter:  <Ports:{0|1|2|3|4|5|all}>
 * View     <Threads:Security:
 * 
 * ---------------------------------------
 *  Server                               $ / Mem
 * hostname  [      progress bar      ] Xn / Yn
 *
 * 
 * n = servers[n]
 * X = max money available on servers[n] / current $ available on servers[n]
 * Y = GB of running threads targeting servers[n] / sum of all GB 
 *  
 * feature idea:
 * - "cycle" mode on the view: every N seconds, flip to the next view mode?
 * - overlay mode: use differing overlappable display methods to show simultaneous information on a single line
 * overlapping progress bars: 
 * - colored full-character block (z=0) 
 * - line of equals signs [====]  (z=1) (alternatively, the double pipe on its side could work)
 * - line of hyphens [-----]      (z=2)
 */
import { readServerStore } from "../bitburner-progres/lib/server-store.js";
/**
 * @typedef {import("../server-store.types.js").ServerSnapshot} ServerSnapshot
 */

/** @type {ServerSnapshot[]} */
let servers = [];

let selectedIndex = -1;


/**
 * 
 * * @param {import("NetscriptDefinitions").NS} ns 
 */
export async function main(ns) { 

    servers = readServerStore(ns).servers;
    
    // detect button press


    // on button press:

    // change selectedIndex

}


