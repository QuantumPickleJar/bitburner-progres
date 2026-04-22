import { readServerStore } from "../lib/server-store.js";
import { CarouselHeader } from "./components/CarouselHeader.js";
import { ServerStatsPanel } from "./components/ServerStatsPanel.js";
import { ThreadSnapshotPanel } from "./components/ThreadSnapshotPanel.js";

const DEFAULT_FILE = "/data/home-neighbors.json";
const THREAD_PORT = 1;
const POLL_MS = 250;
const SNAPSHOT_STALE_MS = 15000;

/**
 * Shared plain-data store.
 * React reads this; main() updates it.
 */
const STORE = {
  selectedIndex: 0,
  lastUpdated: 0,
  serverNames: [],
  serverStats: {},
  snapshots: {},
};

let triggerRender = null;

/**
 * @param {import("NetscriptDefinitions").AutocompleteData} data
 * @param {string[]} args
 * @returns {string[]}
 */
export function autocomplete(data, args) {
  return data.txts.filter((name) => name.endsWith(".json"));
}

/** @param {import("NetscriptDefinitions").NS} ns */
export async function main(ns) {
  const file = String(ns.args[0] ?? DEFAULT_FILE);

  ns.disableLog("ALL");
  ns.clearLog();

  ns.ui.openTail();
  ns.ui.setTailTitle("Server Carousel");
  ns.ui.resizeTail(520, 360);
  ns.ui.moveTail(80, 120);

  ns.printRaw(React.createElement(ServerCarousel));

  while (true) {
    const storeFile = readServerStore(ns, file);

    STORE.serverNames = storeFile.servers
      .map((server) => server.hostname)
      .filter((hostname) => typeof hostname === "string" && ns.serverExists(hostname));

    STORE.selectedIndex = normalizeIndex(
      STORE.selectedIndex,
      Math.max(STORE.serverNames.length, 1),
    );

    STORE.serverStats = collectAllServerStats(ns, STORE.serverNames);
    STORE.snapshots = drainThreadSnapshots(ns, THREAD_PORT, STORE.snapshots, SNAPSHOT_STALE_MS);
    STORE.lastUpdated = Date.now();

    if (typeof triggerRender === "function") {
      triggerRender();
    }

    await ns.asleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// React root component
// ---------------------------------------------------------------------------

function ServerCarousel() {
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

  const safeServers = STORE.serverNames.length > 0 ? STORE.serverNames : ["home"];
  const selectedIndex = normalizeIndex(STORE.selectedIndex, safeServers.length);
  const selectedHost = safeServers[selectedIndex];
  const stats = STORE.serverStats[selectedHost] || makeMissingStats(selectedHost);
  const threadSummary = summarizeTargetThreads(STORE.snapshots, selectedHost);

  function previousServer() {
    STORE.selectedIndex = normalizeIndex(STORE.selectedIndex - 1, safeServers.length);
    setVersion((v) => v + 1);
  }

  function nextServer() {
    STORE.selectedIndex = normalizeIndex(STORE.selectedIndex + 1, safeServers.length);
    setVersion((v) => v + 1);
  }

  function chooseServer(event) {
    STORE.selectedIndex = normalizeIndex(Number(event.target.value), safeServers.length);
    setVersion((v) => v + 1);
  }

  return e(
    "div",
    { style: styles.root },

    e(CarouselHeader, {
      servers: safeServers,
      index: selectedIndex,
      onPrev: previousServer,
      onNext: nextServer,
      onSelect: chooseServer,
      styles: styles,
    }),

    e(
      "div",
      { style: styles.headerCenter },
      e("div", { style: styles.title }, selectedHost),
      e("div", { style: styles.subtitle }, (selectedIndex + 1) + " / " + safeServers.length),
    ),

    e(ServerStatsPanel, { stats: stats, styles: styles }),

    e(ThreadSnapshotPanel, {
      summary: threadSummary,
      lastUpdated: STORE.lastUpdated,
      styles: styles,
    }),
  );
}

// ---------------------------------------------------------------------------
// Data helpers (run outside React, called from main loop)
// ---------------------------------------------------------------------------

/**
 * @param {NS} ns
 * @param {string[]} servers
 * @returns {Object<string, object>}
 */
function collectAllServerStats(ns, servers) {
  const result = {};
  for (let i = 0; i < servers.length; i++) {
    result[servers[i]] = collectServerStats(ns, servers[i]);
  }
  return result;
}

/**
 * @param {NS} ns
 * @param {string} host
 * @returns {object}
 */
function collectServerStats(ns, host) {
  try {
    if (!ns.serverExists(host)) {
      return makeMissingStats(host, "Server does not exist");
    }

    const maxMoney = ns.getServerMaxMoney(host);
    const currentMoney = ns.getServerMoneyAvailable(host);
    const minSec = ns.getServerMinSecurityLevel(host);
    const baseSec = ns.getServerBaseSecurityLevel(host);
    const currentSec = ns.getServerSecurityLevel(host);

    return {
      host,
      maxMoney,
      currentMoney,
      minSec,
      baseSec,
      currentSec,
      moneyPct: maxMoney > 0 ? currentMoney / maxMoney : 0,
      error: "",
    };
  } catch (err) {
    return makeMissingStats(host, String(err));
  }
}

/**
 * @param {string} host
 * @param {string} [errorMessage]
 * @returns {object}
 */
function makeMissingStats(host, errorMessage) {
  return {
    host,
    maxMoney: 0,
    currentMoney: 0,
    minSec: 0,
    baseSec: 0,
    currentSec: 0,
    moneyPct: 0,
    error: errorMessage || "",
  };
}

// ---------------------------------------------------------------------------
// Thread snapshot protocol
// ---------------------------------------------------------------------------

/**
 * @param {NS} ns
 * @param {number} port
 * @param {Object<string, object>} prior
 * @param {number} staleMs
 * @returns {Object<string, object>}
 */
function drainThreadSnapshots(ns, port, prior, staleMs) {
  const next = { ...prior };

  while (true) {
    const raw = ns.readPort(port);
    if (raw === "NULL PORT DATA") break;

    let msg;
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      continue;
    }

    if (!msg || msg.type !== "threadSnapshot") continue;
    if (!msg.source || !msg.target) continue;

    const key = getSnapshotKey(msg);

    next[key] = {
      source: String(msg.source),
      target: String(msg.target),
      tag: String(msg.tag ?? ""),
      controllerPid: Number(msg.controllerPid ?? 0),
      hack: toInt(msg.hack),
      grow: toInt(msg.grow),
      weaken: toInt(msg.weaken),
      total: toInt(msg.total),
      ts: Number.isFinite(Number(msg.ts)) ? Number(msg.ts) : Date.now(),
    };
  }

  return pruneStaleSnapshots(next, staleMs);
}

/**
 * @param {object} msg
 * @returns {string}
 */
function getSnapshotKey(msg) {
  if (msg.tag) return String(msg.tag);
  if (msg.controllerPid) return String(msg.source) + "=>" + String(msg.target) + "#" + String(msg.controllerPid);
  return String(msg.source) + "=>" + String(msg.target);
}

/**
 * @param {Object<string, object>} snapshots
 * @param {number} staleMs
 * @returns {Object<string, object>}
 */
function pruneStaleSnapshots(snapshots, staleMs) {
  const cutoff = Date.now() - staleMs;
  const pruned = {};
  const entries = Object.entries(snapshots);

  for (let i = 0; i < entries.length; i++) {
    const [key, snap] = entries[i];
    if (snap && snap.ts >= cutoff) {
      pruned[key] = snap;
    }
  }

  return pruned;
}

/**
 * @param {Object<string, object>} snapshots
 * @param {string} target
 * @returns {{ hack:number, grow:number, weaken:number, total:number, producers:number, tags:string[] }}
 */
function summarizeTargetThreads(snapshots, target) {
  const values = Object.values(snapshots);
  let hack = 0;
  let grow = 0;
  let weaken = 0;
  let total = 0;
  let producers = 0;
  const tags = [];

  for (let i = 0; i < values.length; i++) {
    const snap = values[i];
    if (!snap || snap.target !== target) continue;

    hack += toInt(snap.hack);
    grow += toInt(snap.grow);
    weaken += toInt(snap.weaken);
    total += toInt(snap.total);
    producers += 1;

    if (snap.tag) tags.push(String(snap.tag));
  }

  return { hack, grow, weaken, total, producers, tags };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function normalizeIndex(index, length) {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

function toInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.floor(num));
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

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
