/** @typedef {import("NetscriptDefinitions").Server} Server */
/** @typedef {import("../../../server-store.types.js").ServerStore} ServerStore */
/** @typedef {import("../../../server-store.types.js").ServerSnapshot} ServerSnapshot  */
/** @typedef {import("../../../server-store.types.js").ServerStoreMeta}  ServerStoreMeta */
/** @typedef {import("../../../server-store.types.js").MultiLayeredProgressBar} MultiProgressBar*/
/** @typedef {import("../../../server-store.types.js").ScoredServerSnapshotTuple} ScoredServerSnapshotTuple */

import { ServerMultiProgressBar } from "../components/ServerMultiProgressBar";

/** @type {Array<MultiProgressBar>} */
let serverElements = [];

/** 
 * @param {object} props
 * @param {ScoredServerSnapshotTuple[]} props.servers 
 * @param {() => void} props.refreshFn 
 * @param {Record<string, object>} props.styles
 * 
 */
export function ServerSummaryPanel({ servers, refreshFn, styles }) { 
    const e = React.createElement;

    // const options = servers.map((
    
    // load a progress bar for each servers

    for (const tuple of servers) { 
        /** @type {MultiProgressBar} */
        const progBar = ServerMultiProgressBar(
            { scoredSnapshot: tuple,
              styles: styles,
            }
        );

        serverElements.push(progBar);

        // push to serverElements
    }

    return e(
        "div",
        { style: styles.headerRow },
        e("button", { style: styles.button, onClick: refreshFn }, "Refresh"),

    );
}
