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

import { ServerSummaryPanel } from "../bitburner-progres/ui/components/ServerSummaryPanel.js";
import { sortArrayByServerScore, sortArrayAlphabetically } from "../tools/sortMapByServerScore.js";
const SORTED_SCORED_RESULTS_FILE = "data/sorted-serversnapshot.json";
const GET_TARGETS_SCRIPT = "tools/get-targets.js";

/** @typedef {import("../server-store.types.js").ScoredServerSnapshotTuple} ScoredServerSnapshotTuple */


/** @typedef {import("../server-store.types.js").ServerSnapshot} ServerSnapshot */

/** @type {ScoredServerSnapshotTuple[]} */
let serverTuples = [];


/** @type { null | (() => void)} */
let triggerRender = null;
// let selectedIndex = -1;

/**
 * Accepts both legacy tuple shape [ScoreResult, ServerSnapshot] and current
 * object shape { detailedScore, server }, while handling transient empty writes.
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} file
 * @returns {ScoredServerSnapshotTuple[]}
 */
function readSortedServerTuples(ns, file = SORTED_SCORED_RESULTS_FILE) {
  const raw = String(ns.read(file) ?? "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((entry) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          if (entry.detailedScore && entry.server) return entry;
        }

        if (Array.isArray(entry) && entry.length >= 2) {
          const detailedScore = entry[0];
          const server = entry[1];
          if (detailedScore && server) {
            return { detailedScore, server };
          }
        }

        return null;
      })
      .filter(Boolean);
  } catch {
    // get-targets may still be writing; retry next poll tick.
    return [];
  }
}


/**
 *
 * @param {import("NetscriptDefinitions").NS} ns 
 */
export async function main(ns) {
  const POLL_MS = Number(ns.args[0] ?? 1000);
  const RESCORE_MS = Number(ns.args[1] ?? POLL_MS);
  let lastRescoreAt = 0;

  // Prime data at startup.
  ns.run(GET_TARGETS_SCRIPT);
  
  // handle UI
  ns.disableLog("ALL");
  ns.clearLog();

  ns.ui.openTail();
  ns.ui.setTailTitle("Servers Overview");
  ns.ui.resizeTail(800, 360);
  ns.ui.moveTail(80, 120);

  ns.printRaw(/** @type {any} */ (React.createElement(ServerPowerViewer, { ns })));


  while (true) { 
    const now = Date.now();

    // Keep the scored snapshot file in sync with UI polling cadence.
    if (now - lastRescoreAt >= RESCORE_MS && !ns.isRunning(GET_TARGETS_SCRIPT, "home")) {
      ns.run(GET_TARGETS_SCRIPT);
      lastRescoreAt = now;
    }

    // servers = readServerStore(ns).servers; --> superseded by get-targets output
    serverTuples = readSortedServerTuples(ns, SORTED_SCORED_RESULTS_FILE);
    if (typeof(triggerRender) === "function") {
        triggerRender();
    }        
    
    // detect button press
    await ns.asleep(POLL_MS);
  }
}

/**
 * @param {object} props
 * @param {import("NetscriptDefinitions").NS} props.ns
 */
function ServerPowerViewer({ ns }) {
  const e = React.createElement;
  const [, setVersion] = React.useState(0);

  React.useEffect(() => {
    triggerRender = function () {
      setVersion((v) => v + 1);
    };

    return () => {
      if (triggerRender) {
        triggerRender = null;
      }
    };
  }, []);

  // const filteredServers = serverTuples.filter(([score, snapshot]) => {
  const filteredServers = serverTuples.filter((tuple) => {
    // discard all servers with `pserv-` prefix
    // if (snapshot.hostname.startsWith("pserv")) return false
    if (tuple.server.hostname.startsWith("pserv")) return false
    return true;
  });

  const sortedFilteredServers = sortArrayAlphabetically(filteredServers);

  return e(
    "div", { style: styles.root },

    e("div", { style: styles.headerRow },
      e("div", { style: styles.title }, "Server Summary"),
      // e("div", { style: styles.subtitle }, `Last updated: ${new Date(serverTuples[0][1].snapshotTime).toLocaleTimeString()}`),
    ),
    e("div", 
        { style: styles.headerCenter },
        e(ServerSummaryPanel, {
            servers: sortedFilteredServers,
            refreshFn: () => {
                // manually trigger a refresh of the server data by re-running get-targets
          ns.run(GET_TARGETS_SCRIPT, 1, "--tail", "--manual", String(Date.now()));
          setVersion((v) => v + 1);
            }, 
            styles: styles
        }),
    )
  );
}


const styles = {
  root: {
    fontFamily: "monospace",
    padding: "8px 10px",
    color: "#e6edf3",
    background: "rgba(10, 14, 18, 0.88)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "8px",
    lineHeight: "1.35",
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    marginBottom: "10px",
  },
  headerCenter: {
    flex: "1 1 auto",
    textAlign: "center",
  },
  title: {
    fontWeight: "bold",
    fontSize: "15px",
  },
  subtitle: {
    opacity: 0.75,
    fontSize: "12px",
    marginTop: "2px",
  },
  button: {
    minWidth: "36px",
    height: "30px",
    borderRadius: "6px",
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.08)",
    color: "#e6edf3",
    cursor: "pointer",
    fontWeight: "bold",
  },
  select: {
    flex: "1 1 auto",
    minWidth: "220px",
    height: "30px",
    borderRadius: "6px",
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(0,0,0,0.08)",
    color: "#e6edf3",
    padding: "0 8px",
  },
  line: {
    margin: "4px 0",
    whiteSpace: "pre-wrap",
  },
  sectionGap: {
    height: "8px",
  },
  sectionTitle: {
    margin: "8px 0 4px 0",
    fontWeight: "bold",
    textDecoration: "underline",
  },
  footer: {
    marginTop: "8px",
    opacity: 0.7,
    fontSize: "11px",
  },
  error: {
    color: "#ff8a8a",
    fontWeight: "bold",
  },
};

