/** @typedef {import("../../../server-store.types.js").ServerStore} ServerStore */
/** @typedef {import("../../../server-store.types.js").ServerSnapshot} ServerSnapshot  */
/** @typedef {import("../../../server-store.types.js").ServerStoreMeta} ServerStoreMeta */
/** @typedef {import("../../../server-store.types.js").ScoreResult} ScoreResult */
/** @typedef {[ScoreResult, ServerSnapshot]} ScoredServerSnapshotTuple */

// /** @param {import("NetscriptDefinitions").NS} ns */
// export async function main(ns) { 
    
// }

const Z0_CHAR = "▒";

/**
 * @param {object} props
 * @param {ScoredServerSnapshotTuple} props.scoredSnapshot
 * @param {Record<string, object>} props.styles
 */
export function ServerMultiProgressBar(props) {
    const {scoredSnapshot, styles} = props;
    const e = React.createElement;

    if (props.scoredSnapshot) {

    }

}

/**
 * Flattens all layers from low to hjigh priority.  non-space characters overwrite lower characters.
 * @param  {...string[]} layers 
 * @returns {string}
 */
function composeLayers(...layers) {
    const width = layers.length > 0 ? Math.max(...layers.map((x) => x.length)): 0;
    const out = Array.from({ length: width }, () => " ");

    for (const layer of layers) { 
        for (let i = 0; i < width; i++) {
            const char = layer[i] ?? " ";
            // print non-empty characters to replace the empty space
            if (char !== " ") {
                out[i] = char;
            }
            
        }
    }

    return out.join("");
}

// /** 
//  * @deprecated
//  * @param {number} width 
//  * @param {number} ratio 
//  * @param {Object} options 
//  * @param {string} [options.leftChar]
//  * @param {string} [options.rightChar]
//  * @param {string} [options.fillChar]
//  * @param {string} [options.emptyChar]
//  * @param {number} [options.tickEvery]
//  * @param {number} [options.tickOffset]
//  * @param {string} [options.tickChar]
//  */
// function createProgressBar(width, ratio, options = {}) { 
//     const z0 = renderZ0(width, Z0_CHAR);

//     const z1 = renderZ1(width, ratio, {
//         leftChar: options.leftChar,
//         rightChar: options.rightChar,
//         emptyChar: options.emptyChar,
//         fillChar: options.fillChar
//     });

//     let z2 = makeBlankLayer(width);

//     z2 = renderZ2Bars(width, {
//         tickChar: options.tickChar,
//         tickEvery: options.tickEvery ?? 4,
//         tickOffset: options.tickOffset ?? 0 
//     });

//     return composeLayers(z0, z1, z2);
// }

/**
 * 
 * @param {ScoredServerSnapshotTuple} serverTuple 
 */
function createProgressbar(serverTuple) { 
    
    const root = document.createElement("div");
    root.style.position = "relative";
    root.style.width = "100%";
    root.style.height = "14px";
    root.style.border = "1px solid #9250ff";
    root.style.background = "#111";
    root.style.overflow = "hidden";
    root.style.boxSizing = "border-box";

    // bottom band
    const moneyBand = document.createElement("div");
    moneyBand.style.position = "absolute"; 
    moneyBand.style.left = "0";
    moneyBand.style.bottom = "0";
    moneyBand.style.height = "100%";
    moneyBand.style.width = `${serverTuple[0].moneyFillRatio * 100}%`;
    moneyBand.style.background = "linear-gradient(to right, rgba(80,200,120,0.35))";
    
    // center band
    const securityBand = document.createElement("div");
    securityBand.style.position = "absolute"; 
    securityBand.style.left = "0";
    securityBand.style.bottom = "0";
    securityBand.style.height = "100%";
    securityBand.style.width = `${serverTuple[0].securityRatio * 100}%`;
    securityBand.style.background = "linear-gradient(to right, rgba(76, 125, 184, 0.64))";

    // top band (WIP)
    

    root.appendChild(moneyBand);
    root.appendChild(securityBand);
    // root.appendChild(thirdBand);

    return root;
}
/* ==================== UTILITY FUNCTIONS: Z-Levels ====================== */

/**
 * can use this to represent security
 * @param {number} width 
 * @param {string} backgroundChar 
 * @returns {string[]}
 */
function renderZ0(width, backgroundChar = Z0_CHAR) { 
    return Array.from({
        length: Math.max(0, width),
        },
        () => backgroundChar
    );
}


/**
 * 
 * @param {number} width 
 * @param {number} ratio 
 * @param {Object} options 
 * @param {string} [options.leftChar]
 * @param {string} [options.rightChar]
 * @param {string} [options.fillChar]
 * @param {string} [options.emptyChar]
 * @returns {string[]}
 */
function renderZ1(width, ratio, options = {}) { 
    const layer = makeBlankLayer(width);
    const normalized = clamp01(ratio);

    // safety checks and fallbacks
    if (!options.leftChar) options.leftChar = "{";
    if (!options.rightChar) options.rightChar = "}";
    if (!options.emptyChar) options.emptyChar = "";
    if (!options.fillChar) options.fillChar = "+";
    // if (!options.fillChar) options.fillChar = "=";

    if (width <= 0) return layer;
    if (width === 1 ) {
        if (options.fillChar) {
            layer[0] = options.fillChar;
            return layer;
        }
    }

    const innerWidth = width - 2;
    const filledCells = Math.round(innerWidth * normalized);

    for (let i = 0; i < innerWidth; i++) {
        layer[i + 1] = i < filledCells ? options.fillChar : options.emptyChar;
    }

    return layer;
}

/**
 * 
 * @param {number} width 
 * @param {Object} options 
 * @param {number} [options.tickEvery]
 * @param {number} [options.tickOffset]
 * @param {string} [options.tickChar]
 * @returns {string[]}
 */
function renderZ2Bars(width, options = {}) { 
    const layer = makeBlankLayer(width);

    const tickEvery = options.tickEvery ?? 4;
    const tickOffset = options.tickOffset ?? 0;
    const tickChar = options.tickChar ?? "=";

    if (width <=2 || tickEvery <=0) return layer;

    for (let i = 1; i < width - 1; i += tickEvery) {
        layer[i] = tickChar;
    }
    return layer;
}

/* ==================== UTILITY FUNCTIONS: ======================*/

/**
 * @param {number} width
 * @returns {string[]}
 */
function makeBlankLayer(width) {
    return Array.from({length: Math.max(0, width) }, () => " ");
}

/**
 * Clamps number to the [0-1] range
 * @param {number} value 
 * @returns {number}
 */
function clamp01(value) { 
    return Math.max(0, Math.min(1, value));
}

// @TODO: come back and add RAM to the server-store so we can display that too
/**
 * converts a ScoredServerSnapshot
 * @param {ScoredServerSnapshotTuple} snapshot
 */
function normalizeServerSnapshot(snapshot) { 
    const moneyRatio = snapshot[0].moneyFillRatio;
    const securityRatio = snapshot[0].securityRatio;
    // const ramRatio = 

    // we likely don't need to clamp it again since it does that in server-store.js and get-targets.js
    return { 
        moneyRatio: clamp01(moneyRatio), 
        securityRatio: clamp01(securityRatio),

    }
}