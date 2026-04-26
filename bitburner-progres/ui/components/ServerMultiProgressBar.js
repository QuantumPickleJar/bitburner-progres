/** @typedef {import("../../../server-store.types.js").ServerStore} ServerStore */
/** @typedef {import("../../../server-store.types.js").ServerSnapshot} ServerSnapshot  */
/** @typedef {import("../../../server-store.types.js").ServerStoreMeta} ServerStoreMeta */
/** @typedef {import("../../../server-store.types.js").ScoreResult} ScoreResult */
/** @typedef {import("../../../server-store.types.js").ScoredServerSnapshotTuple} ScoredServerSnapshotTuple */

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
  const { scoredSnapshot, styles } = props;
  const e = React.createElement;

  if (props.scoredSnapshot) {
    composeLayers(
      renderZ0(20, Z0_CHAR),
      renderZ1(20, scoredSnapshot.detailedScore.moneyFillRatio, {
        fillChar: "░",
        emptyChar: " ",
      }),
      renderZ2Bars(20, scoredSnapshot.detailedScore.securityRatio, {
        tickChar: "-",
        tickEvery: 1
      }),
    );
  }

  const bar = createProgressbar(props.scoredSnapshot);

  return e(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        marginBottom: "6px",
        width: "100%"
      }
    },
    // display the server name to the left of the bar
    e(
      "span",
      {
        style: {
          width: "128px",
          flex: "0 0 128px",
          textAlign: "left",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis"
        }
      },
      props.scoredSnapshot.server.hostname
    ),
    e("div", { style: { flex: "1 1 auto", minWidth: "120px" } }, bar)
  );
}

/**
 * Flattens all layers from low to hjigh priority.  non-space characters overwrite lower characters.
 * @param  {...string[]} layers 
 * @returns {string}
 */
function composeLayers(...layers) {
  const width = layers.length > 0 ? Math.max(...layers.map((x) => x.length)) : 0;
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
  const e = React.createElement;
  const moneyRatio = clamp01(serverTuple?.detailedScore?.moneyFillRatio ?? 0);
  const securityRatio = clamp01(serverTuple?.detailedScore?.securityRatio ?? 0);

  const moneyPct = `${moneyRatio * 100}%`;
  const securityPct = `${securityRatio * 100}%`;

  return e(
    "div",
    {
      style: {
        position: "relative",
        width: "100%",
        height: "12px",
        border: "1px solid #9250ff",
        background: "rgba(146, 80, 255, 0.08)",
        overflow: "hidden",
        boxSizing: "border-box"
      }
    },
    // z0 background gives baseline visibility even with 0 ratios
    e("div", {
      style: {
        position: "absolute",
        inset: "0",
        background: "repeating-linear-gradient(90deg, rgba(146, 80, 255, 0.08) 0px, rgba(146, 80, 255, 0.08) 3px, rgba(146, 80, 255, 0.02) 3px, rgba(146, 80, 255, 0.02) 6px)"
      }
    }),
    // z1 money fill occupies full height
    e("div", {
      style: {
        position: "absolute",
        left: "0",
        bottom: "0",
        height: "100%",
        width: moneyPct,
        background: "linear-gradient(to right, rgba(80, 200, 120, 0.22), rgba(80, 200, 120, 0.48))"
      }
    }),
    // z2 security overlay is a top stripe so both layers remain visible
    e("div", {
      style: {
        position: "absolute",
        left: "0",
        top: "0",
        height: "45%",
        width: securityPct,
        background: "repeating-linear-gradient(90deg, rgba(76, 125, 184, 0.85) 0px, rgba(76, 125, 184, 0.85) 5px, rgba(76, 125, 184, 0.35) 5px, rgba(76, 125, 184, 0.35) 8px)"
      }
    })
  );
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
  if (width === 1) {
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
 * this method seems wrong.  the parameter name like tickEvery and Offset make me think it's
 * not sharing the same width as the other servers 
 * @param {number} width 
 * @param {number} ratio
 * @param {Object} options 
 * @param {number} [options.tickEvery]
 * @param {number} [options.tickOffset]
 * @param {string} [options.tickChar]
 * @returns {string[]}
 */
function renderZ2Bars(width, ratio, options = {}) {
  const layer = makeBlankLayer(width);
  const normalized = clamp01(ratio);

  const tickEvery = options.tickEvery ?? 4;
  const tickOffset = options.tickOffset ?? 0;
  const tickChar = options.tickChar ?? "=";

  const innerWidth = width - 2;
  const filledCells = Math.round(innerWidth * normalized);

  if (width <= 2 || tickEvery <= 0) return layer;

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
  return Array.from({ length: Math.max(0, width) }, () => " ");
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
 * converts a ScoredServerSnapshot to something that the element can render
 * @param {ScoredServerSnapshotTuple} snapshot
 */
function normalizeServerSnapshot(snapshot) {

  // why this syntax changed because of the import, beats me

  // const moneyRatio = snapshot[0].moneyFillRatio;
  // const securityRatio = snapshot[0].securityRatio;

  const moneyRatio = snapshot.detailedScore.moneyFillRatio;
  const securityRatio = snapshot.detailedScore.securityRatio;
  // const ramRatio = 

  // we likely don't need to clamp it again since it does that in server-store.js and get-targets.js
  return {
    moneyRatio: clamp01(moneyRatio),
    securityRatio: clamp01(securityRatio),
    // ramRatio: clamp01(ramRatio)
  }
}