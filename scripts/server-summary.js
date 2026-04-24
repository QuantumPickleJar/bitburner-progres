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

import { ServerMultiProgressBar } from "../bitburner-progres/ui/components/ServerMultiProgressBar.js";
import { ServerSummaryPanel } from "../bitburner-progres/ui/components/ServerSummaryPanel.js";

const SORTED_SCORED_RESULTS_FILE = "data/sorted-serversnapshot.json";

/** @typedef {import("../server-store.types.js").ScoredServerSnapshotTuple} ScoredServerSnapshotTuple */


/** @typedef {import("../server-store.types.js").ServerSnapshot} ServerSnapshot */

/** @type {ScoredServerSnapshotTuple[]} */
let serverTuples = [];

let selectedIndex = -1;


/**
 * 
 * * @param {import("NetscriptDefinitions").NS} ns 
 */
export async function main(ns) {
  // refresh servers
  ns.run("bitburner-progres/tools/get-targets.js");
  
  // servers = readServerStore(ns).servers; --> superceded by get-targets and writing to scored-servers.json
  serverTuples = JSON.parse(ns.read(SORTED_SCORED_RESULTS_FILE));
  
  // handle UI
  ns.disableLog("ALL");
  ns.clearLog();

  ns.ui.openTail();
  ns.ui.setTailTitle("Servers Overview");
  ns.ui.resizeTail(800, 360);
  ns.ui.moveTail(80, 120);

  ns.printRaw(React.createElement(ServerPowerViewer, null));



  // detect button press


  // on button press:

  // change selectedIndex

}

/**
 * @param {import("NetscriptDefinitions").NS} ns 
 */
function ServerPowerViewer(ns) {
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


  return e(
    "div", { style: styles.root },

    e("div", { style: styles.headerRow },
      e("div", { style: styles.title }, "Server Summary"),
      // e("div", { style: styles.subtitle }, `Last updated: ${new Date(serverTuples[0][1].snapshotTime).toLocaleTimeString()}`),

    ),

    e(ServerSummaryPanel, {
      
    }),

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
