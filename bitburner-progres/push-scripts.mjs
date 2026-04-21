// push-scripts.mjs (run with Node locally)
//
// Pushes local workspace files into a running Bitburner game via its HTTP API.
// Files are placed under /vs/ in the game's filesystem by default, mirroring
// the local folder structure.

import fs from "node:fs";
import path from "node:path";

// ─── Help flag ───────────────────────────────────────────────────────────────
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
push-scripts.mjs — Upload workspace files to a running Bitburner game via its HTTP API.

Usage:
  node push-scripts.mjs [options]

Options:
  --host <url>      Base URL of the Bitburner API server
                    Default: http://localhost:9990

  --token <key>     Bearer token for Authorization header
                    Default: (hardcoded — same as pull-scripts.mjs)

  --src <dir>       Local directory to upload from (recursive)
                    Default: .   (workspace root, i.e. the bitburner-progres folder)

  --prefix <path>   In-game path prefix prepended to every file
                    Default: /vs

  --dry-run         Print what would be uploaded without actually pushing

  --help, -h        Show this help message and exit

The script walks --src recursively, skips dotfiles / node_modules / saves,
and pushes every .js / .jsx / .json / .txt file into the game under --prefix.

Examples:
  node push-scripts.mjs
  node push-scripts.mjs --src . --prefix /vs
  node push-scripts.mjs --dry-run
`);
  process.exit(0);
}

// ─── Argument parsing ────────────────────────────────────────────────────────
const cliArgs = process.argv.slice(2);

function getArg(flag) {
  const idx = cliArgs.indexOf(flag);
  return idx !== -1 ? cliArgs[idx + 1] : undefined;
}

const HOST    = getArg("--host")   ?? "http://localhost:9990";
const TOKEN   = getArg("--token")  ?? "Ox8JhbAF+rriMb3SmfxrHUUFatTwfjfsGKX10X3xEz6fMXQUNdoVLSWzIoxsuKtD";
const SRC_DIR = path.resolve(getArg("--src") ?? "./bitburner-progres");
const PREFIX  = (getArg("--prefix") ?? "/vs").replace(/\/+$/, "");
const DRY_RUN = cliArgs.includes("--dry-run");

const EXTENSIONS = new Set([".js", ".jsx", ".json", ".txt"]);
const SKIP_DIRS  = new Set(["node_modules", ".git", "bitburnerSave"]);

// ─── File collection ─────────────────────────────────────────────────────────
function collectFiles(dir, baseDir) {
  const results = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Skip gzipped save files at the top level
      results.push(...collectFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!EXTENSIONS.has(ext)) continue;
      // Skip save files
      if (entry.name.endsWith(".json.gz")) continue;

      const relativePath = path.relative(baseDir, fullPath).split(path.sep).join("/");
      results.push({ localPath: fullPath, gamePath: PREFIX + "/" + relativePath });
    }
  }

  return results;
}

// ─── Push logic ──────────────────────────────────────────────────────────────
async function pushFile(gamePath, content) {
  const res = await fetch(`${HOST}/pushFile`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filename: gamePath, content }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`HTTP ${res.status} pushing ${gamePath}: ${body}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
const files = collectFiles(SRC_DIR, SRC_DIR);

if (files.length === 0) {
  console.log(`No uploadable files found in "${SRC_DIR}".`);
  process.exit(0);
}

console.log(`Found ${files.length} file(s) to push from "${SRC_DIR}" → game prefix "${PREFIX}/":`);

let ok = 0;
let failed = 0;

for (const { localPath, gamePath } of files) {
  if (DRY_RUN) {
    console.log(`  [dry-run] ${gamePath}`);
    continue;
  }

  try {
    const content = fs.readFileSync(localPath, "utf-8");
    await pushFile(gamePath, content);
    console.log(`  ✓ ${gamePath}`);
    ok++;
  } catch (err) {
    console.error(`  ✗ ${gamePath} — ${err.message}`);
    failed++;
  }
}

if (DRY_RUN) {
  console.log(`\nDry run complete. ${files.length} file(s) would be pushed.`);
} else {
  console.log(`\nDone. ${ok} pushed, ${failed} failed.`);
}
