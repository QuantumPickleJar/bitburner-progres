/** @typedef {import("NetscriptDefinitions").Server} Server */
/** @typedef {import("../../../server-store.types.js").ServerStore} ServerStore */
/** @typedef {import("../../../server-store.types.js").ServerSnapshot} ServerSnapshot  */
/** @typedef {import("../../../server-store.types.js").ServerStoreMeta}  ServerStoreMeta */
/** @typedef {import("../../../server-store.types.js").MultiLayeredProgressBar} MultiProgressBar*/
/** @typedef {import("../../../server-store.types.js").ScoredServerSnapshotTuple} ScoredServerSnapshotTuple */

import { ServerMultiProgressBar } from "./ServerMultiProgressBar";
import { ServerSummaryHeader } from "./ServerSummaryHeader";

// TODO: add a filter that lets you opt to hide servers with [0, N-1] ports

// TODO: figure out a way to get the filter mask change to be listened to by other "parts" (callback or event listener, maybe?)


/** 
 * @param {object} props
 * @param {ScoredServerSnapshotTuple[]} props.servers 
 * @param {() => void} props.refreshFn 
 * @param {number} props.sortByIndex
 * @param {Record<string, object>} props.styles
 */
export function ServerSummaryPanel({ servers, refreshFn, sortByIndex, styles }) { 
    const e = React.createElement;
    const serverElements = servers.map((tuple, i) =>
        e(ServerMultiProgressBar, { 
            key: tuple.server?.hostname ?? i,
            scoredSnapshot: tuple,
            styles: styles
        })
    );

    return e(
        "div", { style: styles.headerRow },
        e("div", {
                // style: 
            }, 
            e(ServerSummaryHeader, {
                servers: servers.map(tuple => tuple.server),
                sortByIndex: sortByIndex,
                onSelect: () => {}, 
                styles: styles
            })
        ),
        e("button", { style: styles.button, onClick: refreshFn }, "Refresh"),
        e("div", {style: styles.headerCenter }, serverElements),
    );
}
