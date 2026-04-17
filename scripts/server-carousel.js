// server-carousel.js
// Prototype UI: draggable tail window + React carousel for server stats.
// Put the servers you care about in SERVERS at the top.

/** Top-level configuration */
const SERVERS = [
  "n00dles",
  "foodnstuff",
  "sigma-cosmetics",
  "joesguns",
  "harakiri-sushi",
];

const THREAD_PORT = 1;          // Shared heartbeat port for thread snapshots.
const POLL_MS = 500;            // UI refresh cadence.
const SNAPSHOT_STALE_MS = 4000; // Drop producer snapshots older than this.
const WINDOW = { x: 80, y: 120, w: 440, h: 310 };

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.clearLog();

  // Higher-learning note:
  // Bitburner exposes React at runtime, but you don't get JSX transpilation in-game.
  // So we use React.createElement(...) directly instead of <Component /> syntax.
  ns.ui.openTail();
  ns.ui.setTailTitle("Server Carousel");
  ns.ui.resizeTail(WINDOW.w, WINDOW.h);
  ns.ui.moveTail(WINDOW.x, WINDOW.y);

  ns.printRaw(
    React.createElement(ServerCarousel, {
      ns,
      servers: SERVERS,
      port: THREAD_PORT,
      pollMs: POLL_MS,
      staleMs: SNAPSHOT_STALE_MS,
    }),
  );

  // Keep the script alive so the React content stays interactive.
  while (true) {
    await ns.sleep(60_000);
  }
}

/**
 * Params:
 * - ns: Bitburner Netscript handle
 * - servers: array of hostnames to cycle through
 * - port: shared port number carrying thread heartbeat JSON
 * - pollMs: refresh interval for UI + port drain
 * - staleMs: maximum age for a producer heartbeat before ignoring it
 *
 * Renders a left/right carousel inside the tail window.
 */
function ServerCarousel({ ns, servers, port, pollMs, staleMs }) {
  const e = React.createElement;

  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [snapshots, setSnapshots] = React.useState({});
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    const id = setInterval(() => {
      setSnapshots((prev) => drainThreadSnapshots(ns, port, prev, staleMs));
      setNow(Date.now());
    }, pollMs);

    return () => clearInterval(id);
  }, [ns, port, pollMs, staleMs]);

  const safeServers = Array.isArray(servers) && servers.length > 0 ? servers : ["home"];
  const currentHost = safeServers[((selectedIndex % safeServers.length) + safeServers.length) % safeServers.length];

  const stats = collectServerStats(ns, currentHost);
  const threadSummary = summarizeTargetThreads(snapshots, currentHost);
  const moneyRatio = stats.maxMoney > 0 ? stats.currentMoney / stats.maxMoney : 0;

  const styles = getStyles();

  const prev = () => setSelectedIndex((i) => (i - 1 + safeServers.length) % safeServers.length);
  const next = () => setSelectedIndex((i) => (i + 1) % safeServers.length);

  return e(
    "div",
    { style: styles.root },
    e(
      "div",
      { style: styles.headerRow },
      e("button", { style: styles.button, onClick: prev }, "◀"),
      e(
        "div",
        { style: styles.headerCenter },
        e("div", { style: styles.title }, currentHost),
        e(
          "div",
          { style: styles.subtitle },
          `${selectedIndex + 1} / ${safeServers.length}`,
        ),
      ),
      e("button", { style: styles.button, onClick: next }, "▶"),
    ),

    stats.error
      ? e("p", { style: styles.error }, `Error: ${stats.error}`)
      : e(
          React.Fragment,
          null,

          e("p", { style: styles.line }, `Root access: ${stats.root ? "yes" : "no"}`),
          e(
            "p",
            { style: styles.line },
            `Money: ${formatMoneyCompact(stats.currentMoney)} / ${formatMoneyCompact(stats.maxMoney)} (${formatPercent(moneyRatio)})`,
          ),
          e(
            "p",
            { style: styles.line },
            `Security: min ${formatDecimal(stats.minSecurity)} | base ${formatDecimal(stats.baseSecurity)} | current ${formatDecimal(stats.currentSecurity)}`,
          ),
          e(
            "p",
            { style: styles.line },
            `Above min: ${formatDecimal(Math.max(0, stats.currentSecurity - stats.minSecurity))}`,
          ),

          e("div", { style: styles.sectionGap }),

          e("p", { style: styles.sectionTitle }, `Thread allocation for selected target`),
          e("p", { style: styles.line }, `Total: ${threadSummary.total}`),
          e(
            "p",
            { style: styles.line },
            `Hack / Grow / Weaken: ${threadSummary.hack} / ${threadSummary.grow} / ${threadSummary.weaken}`,
          ),
          e("p", { style: styles.line }, `Reporting hosts: ${threadSummary.producers}`),
          e(
            "p",
            { style: styles.footer },
            `Port ${port} heartbeat view • last UI tick ${new Date(now).toLocaleTimeString()}`,
          ),
        ),
  );
}

/**
 * Params:
 * - ns: Bitburner Netscript handle
 * - host: server to inspect
 *
 * Reads the current money + security state for a host.
 */
function collectServerStats(ns, host) {
  try {
    if (!ns.serverExists(host)) {
      return { error: `Server does not exist: ${host}` };
    }

    return {
      host,
      root: ns.hasRootAccess(host),
      currentMoney: ns.getServerMoneyAvailable(host),
      maxMoney: ns.getServerMaxMoney(host),
      minSecurity: ns.getServerMinSecurityLevel(host),
      baseSecurity: ns.getServerBaseSecurityLevel(host),
      currentSecurity: ns.getServerSecurityLevel(host),
    };
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Params:
 * - ns: Bitburner Netscript handle
 * - port: shared port number used by producers
 * - prior: previous snapshot map
 * - staleMs: heartbeat expiration threshold
 *
 * Drains JSON heartbeat messages from the port into an in-memory snapshot map.
 *
 * Expected message shape:
 * {
 *   type: "threadSnapshot",
 *   source: "pserv-0",
 *   target: "foodnstuff",
 *   hack: 120,
 *   grow: 240,
 *   weaken: 360,
 *   total: 720,
 *   ts: Date.now()
 * }
 */
function drainThreadSnapshots(ns, port, prior, staleMs) {
  const next = { ...prior };

  if (!Number.isInteger(port) || port < 1 || port > 20) {
    return pruneStaleSnapshots(next, staleMs);
  }

  while (true) {
    const raw = ns.readPort(port);
    if (raw === "NULL PORT DATA") break;

    let msg;
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      continue;
    }

    if (!msg || msg.type !== "threadSnapshot" || !msg.source || !msg.target) {
      continue;
    }

    const hack = toInt(msg.hack);
    const grow = toInt(msg.grow);
    const weaken = toInt(msg.weaken);
    const total = Number.isFinite(Number(msg.total)) ? toInt(msg.total) : hack + grow + weaken;
    const ts = Number.isFinite(Number(msg.ts)) ? Number(msg.ts) : Date.now();

    const key = `${String(msg.source)}=>${String(msg.target)}`;
    next[key] = {
      source: String(msg.source),
      target: String(msg.target),
      hack,
      grow,
      weaken,
      total,
      ts,
    };
  }

  return pruneStaleSnapshots(next, staleMs);
}

/**
 * Params:
 * - snapshots: current producer snapshot map
 * - staleMs: heartbeat expiration threshold
 *
 * Removes producer entries that have stopped reporting.
 */
function pruneStaleSnapshots(snapshots, staleMs) {
  const cutoff = Date.now() - staleMs;
  const pruned = {};

  for (const [key, snap] of Object.entries(snapshots)) {
    if (snap && Number(snap.ts) >= cutoff) {
      pruned[key] = snap;
    }
  }

  return pruned;
}

/**
 * Params:
 * - snapshots: current producer snapshot map
 * - target: selected server
 *
 * Totals all currently live producer snapshots aimed at the selected target.
 */
function summarizeTargetThreads(snapshots, target) {
  let hack = 0;
  let grow = 0;
  let weaken = 0;
  let total = 0;
  let producers = 0;

  for (const snap of Object.values(snapshots)) {
    if (!snap || snap.target !== target) continue;
    hack += toInt(snap.hack);
    grow += toInt(snap.grow);
    weaken += toInt(snap.weaken);
    total += toInt(snap.total);
    producers += 1;
  }

  return { hack, grow, weaken, total, producers };
}

/**
 * Params:
 * - value: any numeric-ish value
 *
 * Converts to a safe non-negative integer for display.
 */
function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function formatDecimal(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function formatPercent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "0.0%";
}

function formatMoneyCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0";

  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}t`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}b`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}m`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}k`;
  return `$${n.toFixed(0)}`;
}

function getStyles() {
  return {
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
}


// HELPER FUNCTION: splice into existing worker controller(s)
// Example producer snippet to call every ~1-2 seconds from each host/controller.
function publishThreadSnapshot(ns, port, source, target, hack, grow, weaken) {
  const msg = {
    type: "threadSnapshot",
    source,
    target,
    hack,
    grow,
    weaken,
    total: hack + grow + weaken,
    ts: Date.now(),
  };

  // We intentionally don't block if the port is full.
  ns.tryWritePort(port, JSON.stringify(msg));
}
