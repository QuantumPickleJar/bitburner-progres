/**
 * watchdog.js — Kills scripts that contain provably unsafe infinite loops.
 *
 * Scans all processes on home + purchased servers every INTERVAL ms.
 * For each non-allowlisted script it reads the source and runs static analysis.
 * If a fatal loop risk is detected the process is killed immediately.
 *
 * Analysis improvements over naïve file-wide checks:
 *  - Extracts the loop body via bracket balancing and checks for an
 *    await ns.*() INSIDE that body, not just anywhere in the file.
 *  - Covers while(true), while(1), while(!0), for(;;), and do{…}while(true).
 *  - Rule 3 only fires for `async function main` (the entry point that the
 *    game runs), not helper async functions that legitimately have no await.
 *  - Rule 5 flags ns.hack/grow/weaken/share called without await.
 *  - Purchased-server list is refreshed every cycle so new buys are watched.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.clearLog();

  const INTERVAL = 3000;
  const SELF     = ns.getScriptName();

  /**
   * Scripts that intentionally run infinite loops and must not be killed.
   * Add full in-game paths here (leading slash) as returned by ns.ps().
   */
  const ALLOWLIST = new Set([
    "/workers/share-loop.js",
    "share-loop.js",
  ]);

  ns.print("=== Watchdog started ===");

  while (true) {
    // Refresh server list each cycle — catches newly purchased servers.
    const watched = ["home", ...ns.getPurchasedServers()];

    for (const server of watched) {
      for (const proc of ns.ps(server)) {
        if (proc.filename === SELF)            continue;
        if (ALLOWLIST.has(proc.filename))      continue;

        // Read the source.  ns.read() only reads from home, so scp first when
        // the script doesn't originate there.
        let source = ns.read(proc.filename);
        const alreadyOnHome = source.length > 0;

        if (!alreadyOnHome) {
          const copied = await ns.scp(proc.filename, "home", server);
          if (copied) {
            source = ns.read(proc.filename);
            ns.rm(proc.filename, "home");   // clean up what we copied
          }
        }

        if (!source) continue;

        const risks = analyzeScript(source);
        if (risks.length === 0) continue;

        ns.tprint(`⚠ [WATCHDOG] ${proc.filename} on ${server} (PID ${proc.pid}):`);
        for (const r of risks) ns.tprint(`   → ${r}`);

        ns.kill(proc.pid);
        ns.tprint(`   ✖ Killed PID ${proc.pid}`);
      }
    }

    await ns.sleep(INTERVAL);
  }
}

// ─── Source Analysis ─────────────────────────────────────────────────────────

/**
 * Extracts the block body (contents between the matching `{…}`) that starts
 * at or after `fromIndex` in `src`.  Uses a bracket-depth counter so nested
 * braces are handled correctly.
 *
 * Returns an empty string if no opening brace is found.
 *
 * @param {string} src
 * @param {number} fromIndex
 * @returns {string}
 */
function extractBody(src, fromIndex) {
  let i = fromIndex;
  while (i < src.length && src[i] !== "{") i++;
  if (i >= src.length) return "";

  let depth = 0;
  const start = i + 1;   // content starts after the opening brace
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i);
    }
  }
  return src.slice(start);  // unclosed — return everything
}

/**
 * Returns true if the string contains `await ns.` (an awaited NS call that
 * yields control back to Bitburner's event loop).
 *
 * @param {string} body
 * @returns {boolean}
 */
function hasNsAwaitIn(body) {
  return /\bawait\s+ns\s*\./.test(body);
}

/**
 * Strips line and block comments from source so patterns inside comments
 * do not produce false positives.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  return src
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Statically analyses a script source for infinite-loop risks.
 *
 * @param {string} src
 * @returns {string[]}   Human-readable risk descriptions; empty ⇒ safe.
 */
function analyzeScript(src) {
  const risks = [];
  const s = stripComments(src);

  // ── Rule 1: while(true/1/!0) with no yielding await in its body ───────────
  const whileRe = /while\s*\(\s*(?:true|1|!0)\s*\)/g;
  let m;
  while ((m = whileRe.exec(s)) !== null) {
    const body = extractBody(s, m.index + m[0].length);
    if (!hasNsAwaitIn(body)) {
      risks.push(`${m[0].replace(/\s+/g, "")} with no await ns.*() in loop body — infinite loop risk`);
      break;
    }
  }

  // ── Rule 2: for(;;) with no yielding await in its body ────────────────────
  const forRe = /for\s*\(\s*;\s*;\s*\)/g;
  while ((m = forRe.exec(s)) !== null) {
    const body = extractBody(s, m.index + m[0].length);
    if (!hasNsAwaitIn(body)) {
      risks.push("for(;;) with no await ns.*() in loop body — infinite loop risk");
      break;
    }
  }

  // ── Rule 3: do { … } while(true/1/!0) with no await inside ───────────────
  //    Regex approximation: captures everything between `do {` and `} while(…)`.
  //    Handles only one level of nesting — sufficient for typical scripts.
  const doWhileRe = /\bdo\s*\{([\s\S]*?)\}\s*while\s*\(\s*(?:true|1|!0)\s*\)/g;
  while ((m = doWhileRe.exec(s)) !== null) {
    if (!hasNsAwaitIn(m[1])) {
      risks.push("do{…}while(true) with no await ns.*() in loop body — infinite loop risk");
      break;
    }
  }

  // ── Rule 4: async function main with no await at all ──────────────────────
  //    Only the game entry point matters — helper async functions that return
  //    a resolved Promise are harmless and must NOT be flagged.
  if (/async\s+function\s+main\b/.test(s) && !/\bawait\b/.test(s)) {
    risks.push("async function main with no await — will block event loop");
  }

  // ── Rule 5: ns.sleep() without await ──────────────────────────────────────
  const sleepRe = /ns\s*\.\s*sleep\s*\(/g;
  while ((m = sleepRe.exec(s)) !== null) {
    const before = s.slice(0, m.index).trimEnd();
    if (!before.endsWith("await")) {
      risks.push("ns.sleep() called without await — sleep won't yield");
      break;
    }
  }

  // ── Rule 6: ns.hack/grow/weaken/share without await ───────────────────────
  //    These are all long-running async operations; skipping await means they
  //    fire-and-forget and can pile up, eventually freezing the game.
  const blockingRe = /\bns\s*\.\s*(hack|grow|weaken|share)\s*\(/g;
  while ((m = blockingRe.exec(s)) !== null) {
    const before = s.slice(0, m.index).trimEnd();
    if (!before.endsWith("await")) {
      risks.push(`ns.${m[1]}() called without await — fire-and-forget will saturate the thread pool`);
      break;
    }
  }

  return risks;
}
