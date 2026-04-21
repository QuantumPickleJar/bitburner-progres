// pull-scripts.mjs (run with Node locally)

// ─── Help flag ───────────────────────────────────────────────────────────────
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
pull-scripts.mjs — Download all scripts from a running Bitburner game via its HTTP API.

Usage:
  node pull-scripts.mjs [options]

Options:
  --host <url>    Base URL of the Bitburner API server
                  Default: http://localhost:9990

  --token <key>   Bearer token for Authorization header
                  Default: (hardcoded in script)

  --out <dir>     Output directory for downloaded files
                  Default: ./scripts

  --help, -h      Show this help message and exit

Examples:
  node pull-scripts.mjs
  node pull-scripts.mjs --host http://localhost:9990 --out ./bitburner-progres
  node pull-scripts.mjs --help
`);
  process.exit(0);
}

// ─── Argument parsing ────────────────────────────────────────────────────────
const args = process.argv.slice(2);

/**
 * Reads the value of a named CLI flag, e.g. --host http://localhost:9990
 * Returns undefined if the flag is not present.
 * @param {string} flag
 * @returns {string | undefined}
 */
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const HOST  = getArg("--host")  ?? "http://localhost:9990";
const TOKEN = getArg("--token") ?? "Ox8JhbAF+rriMb3SmfxrHUUFatTwfjfsGKX10X3xEz6fMXQUNdoVLSWzIoxsuKtD";
const OUTDIR = getArg("--out")  ?? "./scripts";

// ─── Main logic ───────────────────────────────────────────────────────────────
const res = await fetch(`${HOST}/getfileNames`, {
  headers: { 'Authorization': `Bearer ${TOKEN}` }
});
const files = await res.json();
for (const file of files.data || []) {
    const content = await fetch(`${HOST}/getfile`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file })
    });
    content.body.pipe(fs.createWriteStream(`${OUTDIR}/${file}`));
}