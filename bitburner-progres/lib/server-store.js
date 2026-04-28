/** @typedef {import("./server-store.types").ServerStore} ServerStore */
/** @typedef {import("./server-store.types").ServerSnapshot} ServerSnapshot  */
/** @typedef {import("./server-store.types").ServerStoreMeta}  ServerStoreMeta */


const DEFAULT_FILE = "/data/home-neighbors.json";

/**
 * @param {import("NetscriptDefinitions").AutocompleteData} data
 * @param {string[]} args
 * @returns {string[]}
 */
export function autocomplete(data, args) {
  const actions = ["build", "refresh", "read"];
  const depths = ["1", "2", "3", "4", "all"];
  const jsonFiles = data.txts.filter((name) => name.endsWith(".json"));

  return [...new Set([...actions, ...depths, DEFAULT_FILE, ...jsonFiles])];
}

/** @param {import("NetscriptDefinitions").NS} ns */
export async function main(ns) {
  const action = String(ns.args[0] ?? "build");
  const depthArg = String(ns.args[1] ?? "1");
  const file = String(ns.args[2] ?? DEFAULT_FILE);

  ns.disableLog("read");
  ns.disableLog("write");
  ns.disableLog("scan");
  ns.disableLog("serverExists");
  // ns.disableLog("scp");
  ns.disableLog("hack");
  ns.disableLog("grow");
  ns.disableLog("weaken");
  ns.disableLog("hasRootAccess");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");
  ns.disableLog("getServerMaxMoney");
  ns.disableLog("getServerMoneyAvailable");
  ns.disableLog("getServerMinSecurityLevel");
  ns.disableLog("getServerSecurityLevel");
  
  switch (action) {
    case "build": {
      const maxDepth = parseDepthArg(depthArg);
      const store = buildHomeNeighborStore(ns, file, maxDepth);
      ns.tprint(`Built ${store.servers.length} servers into ${file} (depth: ${store.meta.maxDepth})`);
      return;
    }

    case "refresh": {
      const count = refreshAllServerSnapshots(ns, file);
      ns.tprint(`Refreshed ${count} servers in ${file}`);
      return;
    }

    case "read": {
      const store = readServerStore(ns, file);
      ns.tprint(JSON.stringify(store, null, 2));
      return;
    }

    default:
      ns.tprint(`Unknown action: ${action}`);
      ns.tprint(`Usage: run /lib/server-store.js [build|refresh|read] [depth|all] [file]`);
  }
}

/** 
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} file
 * @returns {ServerStore}
*/
export function readServerStore(ns, file = DEFAULT_FILE) {
  const raw = ns.read(file);
  if (!raw) {
    ns.print(`ERROR Failed to read servers from ${file}!`);
    return { servers: [], updatedAt: Date.now(), meta: { root: "home", maxDepth: 1 } };
  }

  try {
    const parsed = JSON.parse(raw);
    const servers = Array.isArray(parsed.servers) ? parsed.servers : [];

    return {
      meta: {
        root: String(parsed.meta?.root ?? "home"),
        maxDepth: parsed.meta?.maxDepth === "all" ? "all" : Number(parsed.meta?.maxDepth ?? 1),
      },
      servers,
      updatedAt: Number(parsed.updatedAt ?? Date.now()),
    };
  } catch {
    ns.print(`ERROR Failed to read servers!`);
    return { servers: [], updatedAt: Date.now(), meta: { root: "home", maxDepth: 1 } };
  }
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {ServerStore} store
 * @param {string} file
 */
export function writeServerStore(ns, store, file = DEFAULT_FILE) {
  store.updatedAt = Date.now();
  ns.write(file, JSON.stringify(store, null, 2), "w");
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} file
 * @param {number} maxDepth
 * @returns {ServerStore}
 */
export function buildHomeNeighborStore(ns, file = DEFAULT_FILE, maxDepth = 1) {
  const discovered = crawlNetwork(ns, "home", maxDepth);

  /** @type {ServerStore} */
  const store = {
    meta: {
      root: "home",
      maxDepth: Number.isFinite(maxDepth) ? maxDepth : "all",
    },
    servers: discovered.map((hostname) => snapshotServer(ns, hostname)),
    updatedAt: Date.now(),
  };

  writeServerStore(ns, store, file);
  return store;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} file
 * @returns {ServerStore}
 */
export function ensureStore(ns, file = DEFAULT_FILE) {
  const store = readServerStore(ns, file);

  if (!Array.isArray(store.servers) || store.servers.length === 0) {
    return buildHomeNeighborStore(ns, file, 1);
  }

  const maxDepth = store.meta?.maxDepth === "all"
    ? Number.POSITIVE_INFINITY
    : Number(store.meta?.maxDepth ?? 1);

  const validHosts = new Set(crawlNetwork(ns, "home", maxDepth));

  const looksValid = store.servers.every((/** @type {ServerSnapshot} */ server) =>
    server &&
    typeof server.hostname === "string" &&
    ns.serverExists(server.hostname) &&
    validHosts.has(server.hostname)
  );

  if (looksValid) {
    return store;
  }

  return buildHomeNeighborStore(ns, file, maxDepth);
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} hostname
 * @param {Partial<ServerSnapshot>} patch
 * @param {string} file
 * @returns {boolean}
 */
export function updateServerByHostname(ns, hostname, patch, file = DEFAULT_FILE) {
  if (!ns.serverExists(hostname)) {
    return false;
  }
  /** @type {ServerStore} */
  const store = ensureStore(ns, file);

  const index = store.servers.findIndex((/** @type {ServerSnapshot} */ server) => server.hostname === hostname);

  if (index === -1) {
    return false;
  }

  store.servers[index] = {
    ...store.servers[index],
    ...patch,
    updatedAt: Date.now(),
  };

  writeServerStore(ns, store, file);
  return true;
}

/**
 * @param {string | number} rawDepth
 * @returns {number}
 */
function parseDepthArg(rawDepth) {
  if (String(rawDepth).toLowerCase() === "all") {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number(rawDepth);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  return Math.floor(parsed);
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} startHost
 * @param {number} maxDepth
 * @returns {string[]}
 */
export function crawlNetwork(ns, startHost = "home", maxDepth = 1) {
  const visited = new Set([startHost]);
  const queue = [{ host: startHost, depth: 0 }];
  const discovered = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    const neighbors = ns.scan(current.host);

    for (let i = 0; i < neighbors.length; i++) {
      const neighbor = neighbors[i];

      if (visited.has(neighbor)) {
        continue;
      }

      if (!ns.serverExists(neighbor)) {
        continue;
      }

      visited.add(neighbor);
      discovered.push(neighbor);
      queue.push({
        host: neighbor,
        depth: current.depth + 1,
      });
    }
  }

  return discovered;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} hostname
 * @param {string} file
 * @returns {boolean}
 */
export function refreshServerSnapshot(ns, hostname, file = DEFAULT_FILE) {
  if (!ns.serverExists(hostname)) {
    return false;
  }

  return updateServerByHostname(ns, hostname, snapshotServer(ns, hostname), file);
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} file
 * @returns {number}
 */
export function refreshAllServerSnapshots(ns, file = DEFAULT_FILE) {
  const existing = readServerStore(ns, file);
  const maxDepth = existing.meta?.maxDepth === "all"
    ? Number.POSITIVE_INFINITY
    : Number(existing.meta?.maxDepth ?? 1);

  const rebuilt = buildHomeNeighborStore(ns, file, maxDepth);
  return rebuilt.servers.length;
}

/**
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} hostname
 * @returns {ServerSnapshot}
 */
export function snapshotServer(ns, hostname) {
  if (!ns.serverExists(hostname)) {
    throw new Error(`snapshotServer received invalid hostname: ${hostname}`);
  }

  const currentServer = ns.getServer(hostname); 

  ns.print(`${currentServer.hostname} has ${currentServer.openPortCount ? currentServer.openPortCount : "no"} ports open.`)
  // if number of open ports is less than number of ports required...
  return (currentServer.openPortCount ?? 0) < (currentServer.numOpenPortsRequired ?? 0) ? {
    hostname,
    hasRoot: ns.hasRootAccess(hostname),
    backdoor: currentServer.backdoorInstalled,
    sshOpen: currentServer.sshPortOpen,
    ftpOpen: currentServer.ftpPortOpen,
    sqlOpen: currentServer.sqlPortOpen,
    httpOpen: currentServer.httpPortOpen,
    smtpOpen: currentServer.smtpPortOpen,
    portsRequired: currentServer.numOpenPortsRequired ?? 0,
    openPorts: currentServer.openPortCount ?? 0,
    cores: currentServer.cpuCores, 
    maxRam: ns.getServerMaxRam(hostname),
    usedRam: ns.getServerUsedRam(hostname),
    maxMoney: ns.getServerMaxMoney(hostname),
    money: ns.getServerMoneyAvailable(hostname),
    minSecurity: ns.getServerMinSecurityLevel(hostname),
    security: ns.getServerSecurityLevel(hostname),
    updatedAt: Date.now(),
  } : {
    hostname,
    hasRoot: ns.hasRootAccess(hostname),
    backdoor: currentServer.backdoorInstalled,
    portsRequired: currentServer.numOpenPortsRequired ?? 0,
    openPorts: currentServer.openPortCount ?? 0,
    cores: currentServer.cpuCores, 
    maxRam: ns.getServerMaxRam(hostname),
    usedRam: ns.getServerUsedRam(hostname),
    maxMoney: ns.getServerMaxMoney(hostname),
    money: ns.getServerMoneyAvailable(hostname),
    minSecurity: ns.getServerMinSecurityLevel(hostname),
    security: ns.getServerSecurityLevel(hostname),
    updatedAt: Date.now(),
  };
}