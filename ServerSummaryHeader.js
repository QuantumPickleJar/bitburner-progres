/** @typedef {import("../../../server-store.types").ServerStore} ServerStore */
/** @typedef {import("../../../server-store.types").ServerSnapshot} ServerSnapshot  */
/** @typedef {import("../../../server-store.types").ServerStoreMeta}  ServerStoreMeta */

import { SORT_BY } from "../../../server-store.types";
/**
 * Header component for the ServerSummaryPanel

 * 
 * Hierarchy:
 *  server-summary.js -- ENTRYPOINT
 *  ├── server-store.js runs in main and updates a .json file in /data/
 *  └── ServerSummaryPanel
 *      ├─ ServerSummaryHeader
 *      └─ N * ServerMultiProgressBar (produced from Array<ScoredServerSnapshotTuple>)
 *      
 * Regarding filtering: 
 * in server-picker.js, CarouselHeader has its onNext parameter defined at the ENTRYPOINT
 * from there it can be inserted into the summary panel?
 *  
 * 
 * ├ ─ └ │
 * @param {object} props
 * @param {ServerSnapshot[]} props.servers
 * @param {number} props.sortByIndex
 * @param {(event: any) => void} props.onSelect
 * @param {Record<string, object>} props.styles
 */
export function ServerSummaryHeader({servers, sortByIndex, onSelect, styles}) { 
    const e = React.createElement;

    const options = servers.map((server, i) =>
        e("option", { key: server.hostname, value: String(i) }, server.hostname)
    );

    return e(
        "div", { style: styles.headerRow },
        e(
            // sort by dropdown
            "select",
            { 
                style: styles.select,
                value: String(sortByIndex),
                onChange: onSelect,
            },
            ...options,
        )
    )
}