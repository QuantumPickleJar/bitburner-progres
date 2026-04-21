/**
 * Reads and validates the server list from a JSON data file.
 *
 * Expected file shape:
 * {
 *   "servers": [
 *     { "hostname": "n00dles" },
 *     { "hostname": "foodnstuff" }
 *   ]
 * }
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {string} file
 * @returns {{ servers: Array<{ hostname: string }> }}
 */
export function readServerStore(ns, file) {
  var fallback = { servers: [] };

  try {
    var raw = ns.read(file);

    if (!raw || typeof raw !== "string") {
      return fallback;
    }

    var parsed = JSON.parse(raw);

    if (!parsed || !Array.isArray(parsed.servers)) {
      return fallback;
    }

    return parsed;
  } catch {
    return fallback;
  }
}
