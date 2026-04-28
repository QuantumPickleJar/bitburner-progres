/** @typedef {import("../../server-store.types").ScoredServerSnapshotTuple} ScoredServerSnapshotTuple */

/**
 * Accept both the current object shape
 *   { detailedScore, server }
 * and the legacy tuple shape
 *   [detailedScore, server]
 *
 * @param {ScoredServerSnapshotTuple | [object, object] | unknown} entry
 * @returns {{ detailedScore: any, server: any }}
 */
function normalizeScoredSnapshot(entry) {
    if (Array.isArray(entry)) {
        return {
            detailedScore: entry[0],
            server: entry[1],
        };
    }

    if (entry && typeof entry === "object") {
        return {
            detailedScore: entry.detailedScore,
            server: entry.server,
        };
    }

    return {
        detailedScore: { score: Number.NEGATIVE_INFINITY },
        server: { hostname: "" },
    };
}

/**
 * @param {Map<string, ScoredServerSnapshotTuple>} map Key=hostname, Value=scored snapshot for that host.
 * @param {boolean} asc true if the sort should be ascending, else it defaults to descending
 * @returns {Map<string, ScoredServerSnapshotTuple>}
 */
export function sortMapAlphabetically(map, asc = false) {
    return new Map(
        [...map.entries()].sort((a, b) => {
            const aNorm = normalizeScoredSnapshot(a[1]);
            const bNorm = normalizeScoredSnapshot(b[1]);
            const aHost = String(aNorm.server?.hostname ?? a[0] ?? "");
            const bHost = String(bNorm.server?.hostname ?? b[0] ?? "");

            if (aHost < bHost) return asc ? -1 : 1;
            if (aHost > bHost) return asc ? 1 : -1;
            return 0;
        })
    );
}

/**
 * @param {Map<string, ScoredServerSnapshotTuple>} map Key=hostname, Value=scored snapshot for that host.
 * @returns {Map<string, ScoredServerSnapshotTuple>}
 */
export function sortMapByServerScore(map) {
    return new Map(
        [...map.entries()].sort((a, b) => {
            const aNorm = normalizeScoredSnapshot(a[1]);
            const bNorm = normalizeScoredSnapshot(b[1]);
            const aScore = Number(aNorm.detailedScore?.score ?? Number.NEGATIVE_INFINITY);
            const bScore = Number(bNorm.detailedScore?.score ?? Number.NEGATIVE_INFINITY);
            return bScore - aScore;
        })
    );
}

/**
 * @param {Array<ScoredServerSnapshotTuple>} array
 * @returns {Array<ScoredServerSnapshotTuple>}
 */
export function sortArrayByServerScore(array) {
    return array.sort((a, b) => {
        const aNorm = normalizeScoredSnapshot(a);
        const bNorm = normalizeScoredSnapshot(b);
        const aScore = Number(aNorm.detailedScore?.score ?? Number.NEGATIVE_INFINITY);
        const bScore = Number(bNorm.detailedScore?.score ?? Number.NEGATIVE_INFINITY);
        return bScore - aScore;
    });
}

/**
 * @param {Array<ScoredServerSnapshotTuple>} array
 * @param {boolean} asc true if the sort should be ascending, else it defaults to descending
 * @returns {Array<ScoredServerSnapshotTuple>}
 */
export function sortArrayAlphabetically(array, asc = false) {
    return array.sort((a, b) => {
        const aNorm = normalizeScoredSnapshot(a);
        const bNorm = normalizeScoredSnapshot(b);
        const aHost = String(aNorm.server?.hostname ?? "");
        const bHost = String(bNorm.server?.hostname ?? "");

        if (aHost < bHost) return asc ? -1 : 1;
        if (aHost > bHost) return asc ? 1 : -1;
        return 0;
    });
}
