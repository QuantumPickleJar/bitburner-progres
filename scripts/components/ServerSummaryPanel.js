
/** @typedef {import("NetscriptDefinitions").Server} Server */
/** @typedef {import("../../server-store.types.js").ServerStore} ServerStore */
/** @typedef {import("../../server-store.types.js").ServerSnapshot} ServerSnapshot  */
/** @typedef {import("../../server-store.types.js").ServerStoreMeta}  ServerStoreMeta */

/** @type {ServerSnapshot} */
let displayedServer = null;

/** 
 * @param {object} props
 * @param {ServerSnapshot} props.server
 * @param {Record<string, object>} props.styles
*/
export async function ServerSummaryPanel({server, styles}) { 
    if(server !== null) { 
        displayedServer = server;
    }
    
    const e = React.createElement;
    
    
}

/**
 * @param {import("NetscriptDefinitions").NS} ns 
 * @param {number} percentFill the percent of the horizontal bar to fill from left to right */
export function generateZ0ProgBar(ns, percentFill) { 
    
}