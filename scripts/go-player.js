/**
 * go-player.js
 * Automated IPvGO subnet player for Bitburner.
 *
 * RAM priority: all heavy board analysis (chains, liberties, territory) is done
 * in pure JS so we skip the expensive 16 GB analysis API calls.
 * Per-turn RAM budget:
 *   getBoardState()   4 GB
 *   getValidMoves()   8 GB
 *   makeMove()        4 GB
 *   ─────────────────────
 *   Total             ~16 GB  (safe to run alongside other scripts)
 *
 * Move priority score table:
 *   CAPTURE    (100) — place at last liberty of an enemy chain → kills it
 *   ESCAPE      (80) — save own chain that is in atari
 *   EYE_CREATE  (70) — complete/create an eye for an own group
 *   ATARI       (60) — reduce enemy chain to 1 liberty
 *   LADDER      (55) — start/continue a ladder the AI cannot escape (no lookahead)
 *   CORNER      (45) — claim a corner 3×3 region early (AI permanently abandons occupied corners)
 *   CONNECT     (35) — join 2+ separate friendly chains
 *   TERRITORY   (25) — claim contested space
 *   REDUCE      (18) — pressure enemy chains at 2-4 liberties
 *   INFLUENCE   (12) — expand presence, including near enemy stones
 *   NEUTRAL      (5) — any other valid move
 *   FILL_EYE    (-5) — playing inside already-secured own territory (last resort)
 *   SELF-ATARI   — disqualified (score set to -1, never played)
 *
 * Exploits of the Daedalus/Illuminati AI (from source analysis):
 *   - AI only blocks eye creation when there is EXACTLY ONE eye threat.
 *     → Create TWO simultaneous eye threats; AI blocks neither.
 *   - AI only defends a chain when it has EXACTLY 1 liberty (in atari).
 *     → Squeeze to 2 liberties first; AI won't react.
 *   - AI uses getCornerMove() only when the entire 3×3 corner region is empty.
 *     → Place one stone in each corner region early; AI abandons all four corners.
 *   - AI has ZERO lookahead; ladders and nets are completely invisible to it.
 *   - AI responds to only ONE capture threat per turn (picks the first chain found).
 *     → Set up two simultaneous capture threats; AI saves one, we take the other.
 *
 * Usage:
 *   run go-player.js [opponent] [boardSize]
 *   run go-player.js "Netburners" 5
 *   run go-player.js "No AI" 9
 *
 * @param {import("NetscriptDefinitions").NS} ns
 */

// ─── Score constants ───────────────────────────────────────────────────────
const SCORE = {
  CAPTURE:          100,
  ESCAPE:            80,
  SECOND_EYE:        88, // completing the 2nd eye makes a group permanently alive — above ESCAPE
  BLOCK_SECOND_EYE:  84, // blocking WHITE's 2nd eye = making enemy group permanently dead
  FIRST_EYE:         72, // creating the 1st eye is still urgent
  BLOCK_FIRST_EYE:   67, // blocking WHITE's 1st eye forces it to find another route to life
  DOUBLE_ATARI:      75, // fork: simultaneously threatens 2 enemy chains; AI handles only 1
  EYE_APPROACH:      65, // 3-of-4 same-chain neighbors: almost an eye, build toward it
  ATARI:             60, // reduce enemy chain to 1 liberty
  LADDER:            55, // start/continue a ladder the AI can't escape
  CORNER:            45, // claim a corner 3×3 region (AI abandons occupied corners)
  FORTIFY:           40, // strengthen own chain at 2–3 liberties before AI squeezes to atari
  CONNECT:           35, // connecting own chains prevents capture and builds living groups
  TERRITORY:         25, // claiming contested space aggressively
  REDUCE:            18, // pressuring enemy-controlled space to contest it
  INFLUENCE:         12, // expanding presence, including near enemy stones
  NEUTRAL:            5,
  FILL_EYE:          -5, // playing inside already-secured own territory (wastes/destroys eyes)
  DISQUALIFY:        -1,
};

// ─── Board cell constants ───────────────────────────────────────────────────
const BLACK = "X";   // player's pieces
const WHITE = "O";   // opponent's pieces
const EMPTY = ".";   // open node
const DEAD  = "#";   // offline node — not playable, not territory

// ─── Entry point ────────────────────────────────────────────────────────────

/** @param {import("NetscriptDefinitions").NS} ns */
export async function main(ns) {
  // Parse CLI arguments with defaults
  // Cast opponent to GoOpponent — the API accepts only the known faction strings
  const opponent  = /** @type {import("NetscriptDefinitions").GoOpponent} */ (ns.args[0] ?? "Netburners");
  // Cast boardSize to the literal union 5|7|9|13 that resetBoardState expects
  const boardSize = /** @type {5|7|9|13} */ (Number(ns.args[1] ?? 5));

  ns.disableLog("ALL");
  ns.print(`▶ IPvGO player starting — opponent: ${opponent}, size: ${boardSize}`);

  // Run continuously: start a new game immediately after each game-over.
  while (true) {
    // Start a fresh game against the chosen opponent and board size.
    ns.go.resetBoardState(opponent, boardSize);

    // ── Game loop ────────────────────────────────────────────────────────────
    // We keep looping until the game reports "gameOver".
    // Each iteration:
    //   1. Read the board and valid moves
    //   2. Derive chain/liberty data locally (0 extra GB)
    //   3. Score every valid move
    //   4. Play the best move, or pass if nothing scores above zero
    //   5. Await the opponent's response
    let result = { type: "move" };

    while (result.type !== "gameOver") {
      // ── 1. Read state ──────────────────────────────────────────────────────
      const boardState  = ns.go.getBoardState();          // 4 GB
      const validGrid   = ns.go.analysis.getValidMoves(); // 8 GB

      // ── 2. Derive local data ───────────────────────────────────────────────
      const board     = parseBoard(boardState);            // 2D char array
      const size      = board.length;
      const chains    = computeLocalChains(board, size);   // flood-fill chain IDs
      const liberties = computeLocalLiberties(chains, board, size); // open-port counts per chain

      // Pre-compute eye vitality for both sides — used by scoreMoves and selectBestMove
      const eyeCounts = computeEyeCounts(board, chains, size, BLACK);

      // ── 3. Score moves ─────────────────────────────────────────────────────
      // Pre-compute fillRatio once; shared by scoreMoves and selectBestMove
      let _f = 0, _t = 0;
      for (let _x = 0; _x < size; _x++) for (let _y = 0; _y < size; _y++) {
        if (board[_x][_y] === DEAD) continue; _t++;
        if (board[_x][_y] !== EMPTY) _f++;
      }
      const fillRatio = _t > 0 ? _f / _t : 0;
      const scored = scoreMoves(validGrid, board, chains, liberties, size, fillRatio, eyeCounts);

      // ── 4. Pick best move ──────────────────────────────────────────────────
      const best = selectBestMove(scored, fillRatio, chains, eyeCounts);

      // ── 5. Play ────────────────────────────────────────────────────────────
      if (best) {
        ns.print(`  ↳ playing (${best.x}, ${best.y})  score=${best.score}`);
        result = await ns.go.makeMove(best.x, best.y); // 4 GB
      } else {
        ns.print("  ↳ passing (no move clears the late-game threshold)");
        result = await ns.go.passTurn();
      }

      // Small yield so other scripts keep running smoothly
      await ns.sleep(200);
    }

    // ── Game over ─────────────────────────────────────────────────────────────
    await handleGameOver(ns, boardSize);
  }
}

// ─── Board parsing ───────────────────────────────────────────────────────────

/**
 * Converts Bitburner's column-string board format into a 2D array indexed
 * board[x][y] where x is the column (left→right) and y is the row (bottom→top).
 *
 * Bitburner returns: ["XX.", "OO.", ".X."]  — each string is a vertical column.
 * So boardState[x][y] == board[x][y] directly; we just split into a proper 2D
 * array so callers can use board[x][y] with normal array indexing.
 *
 * @param {string[]} boardState — raw output from ns.go.getBoardState()
 * @returns {string[][]}         2D array board[x][y]
 */
function parseBoard(boardState) {
  // Each element of boardState is already one column, stored as a string.
  // Split each string into an array of characters.
  return boardState.map(col => col.split(""));
}

// ─── Neighbor helper ─────────────────────────────────────────────────────────

/**
 * Returns the coordinates of valid (in-bounds, non-dead) 4-directional neighbors
 * of point (x, y) on a board of the given size.
 *
 * Go only counts orthogonal adjacency — diagonals don't connect chains.
 *
 * @param {number}    x
 * @param {number}    y
 * @param {number}    size   board dimension
 * @param {string[][]} board  used to exclude DEAD ("#") nodes
 * @returns {{x:number, y:number}[]}
 */
function getNeighbors(x, y, size, board) {
  return [
    { x: x - 1, y },
    { x: x + 1, y },
    { x, y: y - 1 },
    { x, y: y + 1 },
  ].filter(
    // Keep only points that are within bounds and not offline dead nodes
    n => n.x >= 0 && n.x < size &&
         n.y >= 0 && n.y < size &&
         board[n.x][n.y] !== DEAD
  );
}

// ─── Chain computation ───────────────────────────────────────────────────────

/**
 * Assigns a unique integer chain ID to every non-dead point on the board using
 * a simple flood-fill (BFS).  Points that are orthogonally adjacent and share
 * the same color (B/W/empty) belong to the same chain.
 *
 * Empty regions form their own chain IDs so we can count their liberties too —
 * useful for territory evaluation.
 *
 * Dead ("#") nodes are given chainId = null.
 *
 * Returns:
 *   chains[x][y] = number  (chain ID, ≥ 0)
 *                 | null   (dead node)
 *
 * Also returns a parallel structure chainColor[id] = "X" | "O" | "." so callers
 * can quickly look up what color a chain is without re-reading the board.
 *
 * @param {string[][]} board
 * @param {number}     size
 * @returns {{ ids: (number|null)[][], color: string[], members: {x:number,y:number}[][] }}
 */
function computeLocalChains(board, size) {
  // ids[x][y] starts as undefined (unvisited) or null (dead)
  const ids     = Array.from({ length: size }, () => new Array(size).fill(undefined));
  const color   = []; // indexed by chain ID
  /** @type {{x:number,y:number}[][]} */
  const members = []; // members[chainId] = [{x,y}, ...] — every stone in that chain
  let   nextId  = 0;

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const cell = board[x][y];

      // Dead nodes get null and are skipped
      if (cell === DEAD) {
        ids[x][y] = null;
        continue;
      }

      // Already assigned during a previous flood-fill pass
      if (ids[x][y] !== undefined) continue;

      // ── BFS flood-fill from (x, y) ────────────────────────────────────────
      const id    = nextId++;
      color[id]   = cell;
      members[id] = [];
      const queue = [{ x, y }];
      ids[x][y]   = id;

      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur) break;
        members[id].push(cur);

        for (const nb of getNeighbors(cur.x, cur.y, size, board)) {
          // Only expand into unvisited cells with the same color
          if (ids[nb.x][nb.y] === undefined && board[nb.x][nb.y] === cell) {
            ids[nb.x][nb.y] = id;
            queue.push(nb);
          }
        }
      }
    }
  }

  return { ids, color, members };
}

// ─── Liberty computation ─────────────────────────────────────────────────────

/**
 * Counts "liberties" for every chain — the number of distinct EMPTY neighbors
 * that touch the chain.
 *
 * In Go, a chain's liberty count determines how close it is to capture:
 *   1 liberty → "in atari"  (one move away from capture)
 *   0 liberties → captured / removed from the board
 *
 * Only BLACK and WHITE chains get meaningful liberty counts; empty chains return -1
 * (consistent with how the game's own API reports them).
 *
 * Returns libertyCount[chainId] = number.
 *
 * @param {{ ids: (number|null)[][], color: string[] }} chains
 * @param {string[][]} board
 * @param {number}     size
 * @returns {number[]}   indexed by chain ID
 */
function computeLocalLiberties(chains, board, size) {
  const { ids, color } = chains;
  const libertyCount = new Array(color.length).fill(0);

  // Track which empty cells have already been counted for each chain
  // to avoid double-counting a shared empty neighbor.
  // libertySet[chainId] = Set of "x,y" strings
  const libertySets = color.map(() => new Set());

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const cell = board[x][y];

      // We only care about BLACK or WHITE routers
      if (cell !== BLACK && cell !== WHITE) continue;

      const id = ids[x][y];
      // id can only be null for DEAD nodes, which are already skipped above
      if (id === null) continue;

      for (const nb of getNeighbors(x, y, size, board)) {
        // An empty neighbor is a liberty for this chain
        if (board[nb.x][nb.y] === EMPTY) {
          const key = `${nb.x},${nb.y}`;
          if (!libertySets[id].has(key)) {
            libertySets[id].add(key);
            libertyCount[id]++;
          }
        }
      }
    }
  }

  // Empty-point chains are given -1 (conventional, matching the NS API)
  for (let id = 0; id < color.length; id++) {
    if (color[id] === EMPTY) libertyCount[id] = -1;
  }

  return libertyCount;
}

// ─── Eye counting ─────────────────────────────────────────────────────────────

/**
 * Counts the number of confirmed "real eyes" each chain of a given color has.
 *
 * A real eye is an empty point where:
 *   1. Every orthogonal neighbor is of `targetColor` (or off-board/dead), AND
 *   2. All those neighbors belong to the SAME chain.
 *
 * Condition 2 is critical: a point enclosed by two *different* chains of the same
 * color is a "false eye" — either chain could be captured, opening the space.
 *
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[] }} chains
 * @param {number}     size
 * @param {string}     [targetColor]  defaults to BLACK
 * @returns {number[]}
 */
function computeEyeCounts(board, chains, size, targetColor = BLACK) {
  const { ids, color } = chains;
  const eyeCounts = new Array(color.length).fill(0);

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (board[x][y] !== EMPTY) continue;

      const nbs = getNeighbors(x, y, size, board);
      if (nbs.length === 0) continue; // isolated dead-surrounded cell, skip

      let ownerChain = null;
      let isRealEye  = true;

      for (const nb of nbs) {
        if (board[nb.x][nb.y] !== targetColor) { isRealEye = false; break; }
        const nid = ids[nb.x][nb.y];
        if (ownerChain === null) { ownerChain = nid; }
        else if (nid !== ownerChain) { isRealEye = false; break; }
      }

      if (isRealEye && ownerChain !== null) {
        eyeCounts[ownerChain]++;
      }
    }
  }

  return eyeCounts;
}

// ─── Move scoring ─────────────────────────────────────────────────────────────

/**
 * Iterates every valid move and assigns a priority score using the five
 * heuristic evaluators below.  The highest-scoring evaluator wins for each
 * point.
 *
 * Moves that would self-atari with no rescue are disqualified (score = -1)
 * and will never be chosen.
 *
 * @param {boolean[][]}                        validGrid   output of getValidMoves()
 * @param {string[][]}                         board
 * @param {{ ids: (number|null)[][], color: string[], members: {x:number,y:number}[][] }} chains
 * @param {number[]}                           liberties   indexed by chain ID
 * @param {number}                             size
 * @param {number}                             fillRatio   pre-computed board fill fraction
 * @param {number[]}                           eyeCounts   BLACK eye counts from computeEyeCounts()
 * @returns {{ x: number, y: number, score: number }[]}
 */
function scoreMoves(validGrid, board, chains, liberties, size, fillRatio, eyeCounts) {
  const scored = [];

  // Pre-compute territory map ONCE per turn (not once per move — that was O(n⁴))
  const territory = floodFillTerritory(board, size);

  // Pre-compute WHITE eye counts for eye-blocking evaluator
  const whiteEyeCounts = computeEyeCounts(board, chains, size, WHITE);

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      // Skip moves the game considers invalid (ko rule, suicide, occupied, etc.)
      if (!validGrid[x][y]) continue;

      // Self-atari check first — disqualify before spending time scoring
      if (evaluateSelfAtariRisk(x, y, board, chains, liberties, size)) {
        scored.push({ x, y, score: SCORE.DISQUALIFY });
        continue;
      }

      // Build a list of scores from each heuristic and take the highest.
      // A small positional bonus (0–2) breaks ties in favor of center over edges.
      const positionalBonus = evaluatePositionalBonus(x, y, size);
      const scores = [
        evaluateCaptureMove   (x, y, board, chains, liberties, size),
        evaluateEscapeMove    (x, y, board, chains, liberties, size),
        evaluateEyeCreateMove (x, y, board, chains, eyeCounts, size),
        evaluateEyeBlockMove  (x, y, board, chains, whiteEyeCounts, size),
        evaluateDoubleAtariMove(x, y, board, chains, liberties, size),
        evaluateAtariMove     (x, y, board, chains, liberties, size),
        evaluateLadderMove    (x, y, board, chains, liberties, size),
        evaluateCornerMove    (x, y, board, size, fillRatio),
        evaluateFortifyMove   (x, y, board, chains, liberties, eyeCounts, size),
        evaluateConnectionMove(x, y, board, chains, liberties, eyeCounts, size, fillRatio),
        evaluateTerritoryMove (x, y, board, chains, eyeCounts, size, territory),
        evaluateReduceMove    (x, y, board, chains, liberties, size, territory),
        evaluateInfluenceMove (x, y, board, chains, liberties, size),
        SCORE.NEUTRAL + positionalBonus, // fallback — center > edge > corner
      ];

      scored.push({ x, y, score: Math.max(...scores) });
    }
  }

  return scored;
}

// ─── Move selection ───────────────────────────────────────────────────────────

/**
 * Returns the {x, y, score} entry with the highest score, or null if every
 * candidate is disqualified or below the dynamic pass threshold.
 *
 * Pass threshold scales with board fill:
 *   < 40% filled  → play anything positive (early game, expand freely)
 *   40–65% filled → require score > NEUTRAL (don't play "meh" moves)
 *   65–80% filled → require score > INFLUENCE (only tactical/territory moves)
 *   > 80% filled  → require score > TERRITORY (only critical moves)
 *
 * This prevents the bot from burning moves in the late game on pointless
 * neutral/influence plays that weaken groups or gift the opponent.
 *
 * @param {{ x: number, y: number, score: number }[]} scoredMoves
 * @param {number}     fillRatio   pre-computed board fill fraction
 * @param {{ color: string[] }} chains
 * @param {number[]}   eyeCounts   BLACK eye counts from computeEyeCounts()
 * @returns {{ x: number, y: number, score: number } | null}
 */
function selectBestMove(scoredMoves, fillRatio, chains, eyeCounts) {

  // CRITICAL: never pass if any BLACK chain is not yet alive (< 2 real eyes).
  // Passing while groups are vulnerable gifts the opponent free territory.
  let anyBlackVulnerable = false;
  for (let id = 0; id < chains.color.length; id++) {
    if (chains.color[id] === BLACK && (eyeCounts[id] ?? 0) < 2) {
      anyBlackVulnerable = true;
      break;
    }
  }

  // Dynamic pass threshold — be pickier as the board fills up.
  // Thresholds are intentionally kept low to stay aggressive late.
  let passThreshold;
  if (anyBlackVulnerable) {
    // We have groups that aren't alive yet — keep playing regardless of fill
    passThreshold = 0;
  } else if (fillRatio > 0.85) {
    passThreshold = SCORE.REDUCE;     // > 18 — only tactical moves
  } else if (fillRatio > 0.70) {
    passThreshold = SCORE.INFLUENCE;  // > 12
  } else if (fillRatio > 0.45) {
    passThreshold = SCORE.NEUTRAL;    // > 5
  } else {
    passThreshold = 0;                // play anything
  }

  // Filter disqualified moves AND moves below the pass threshold
  const candidates = scoredMoves.filter(m => m.score > passThreshold);
  if (candidates.length === 0) return null;

  // Find the maximum score, then pick randomly among all tied top candidates.
  // Randomizing ties prevents deterministic, predictable play patterns.
  const maxScore = candidates.reduce((max, m) => Math.max(max, m.score), -Infinity);
  const topMoves = candidates.filter(m => m.score === maxScore);
  return topMoves[Math.floor(Math.random() * topMoves.length)];
}

// ─── Heuristic evaluators ─────────────────────────────────────────────────────

/**
 * CAPTURE evaluator.
 *
 * A move at (x, y) captures an enemy chain if that chain currently has exactly
 * one liberty AND that liberty is (x, y).  After placing here the enemy chain
 * has zero liberties and is removed.
 *
 * We check every enemy neighbor of the candidate point.  If any adjacent
 * enemy chain's only remaining liberty is this point, this is a capture move.
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[] }} chains
 * @param {number[]}   liberties
 * @param {number}     size
 * @returns {number} SCORE.CAPTURE if this move captures anything, else 0
 */
function evaluateCaptureMove(x, y, board, chains, liberties, size) {
  const { ids } = chains;

  for (const nb of getNeighbors(x, y, size, board)) {
    // We only care about enemy (WHITE) neighboring routers
    if (board[nb.x][nb.y] !== WHITE) continue;

    const enemyChainId = ids[nb.x][nb.y];
    // Neighbor is WHITE so it cannot be a dead node; id will not be null
    if (enemyChainId === null) continue;

    // If this chain has exactly 1 liberty, and (x,y) is reachable from it,
    // placing here captures it.  Because (x,y) is a valid empty cell and it
    // is adjacent to the enemy chain, and the chain has 1 liberty, (x,y)
    // must be that liberty (otherwise the move wouldn't be valid).
    if (liberties[enemyChainId] === 1) {
      return SCORE.CAPTURE;
    }
  }

  return 0;
}

/**
 * ESCAPE evaluator.
 *
 * If any friendly (BLACK) chain adjacent to (x, y) is currently in atari
 * (exactly 1 liberty), placing here may give it additional liberties and save it.
 *
 * We verify the rescue by checking that (x, y) would become an open neighbor
 * of the friendly chain — since (x, y) is empty and valid, placing there adds
 * at least one liberty to anything adjacent.
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[] }} chains
 * @param {number[]}   liberties
 * @param {number}     size
 * @returns {number} SCORE.ESCAPE if this move rescues a friendly chain, else 0
 */
function evaluateEscapeMove(x, y, board, chains, liberties, size) {
  const { ids } = chains;

  for (const nb of getNeighbors(x, y, size, board)) {
    if (board[nb.x][nb.y] !== BLACK) continue;

    const friendlyChainId = ids[nb.x][nb.y];
    // Neighbor is BLACK so it cannot be a dead node; id will not be null
    if (friendlyChainId === null) continue;

    // 1 liberty means the chain is in atari — placing at (x,y) adds a liberty
    if (liberties[friendlyChainId] === 1) {
      return SCORE.ESCAPE;
    }
  }

  return 0;
}

/**
 * ATARI evaluator.
 *
 * A move at (x, y) puts an enemy chain in atari if, after placing here,
 * the enemy chain would have exactly 1 liberty remaining.
 *
 * We approximate this by checking whether any adjacent enemy chain currently
 * has exactly 2 liberties AND (x, y) is one of them.  If so, placing here
 * reduces it to 1 liberty.
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[] }} chains
 * @param {number[]}   liberties
 * @param {number}     size
 * @returns {number} SCORE.ATARI if this move threatens a capture next turn, else 0
 */
function evaluateAtariMove(x, y, board, chains, liberties, size) {
  const { ids } = chains;
  // We'll need to know each enemy chain's actual liberty positions to check
  // if (x,y) is one of the two remaining liberties.
  // Fast approximation: if the chain has exactly 2 liberties and (x,y) borders it,
  // placing here will remove one liberty and leave it in atari.

  const checkedChains = new Set(); // avoid scoring the same chain twice

  for (const nb of getNeighbors(x, y, size, board)) {
    if (board[nb.x][nb.y] !== WHITE) continue;

    const enemyId = ids[nb.x][nb.y];
    // Neighbor is WHITE so it cannot be a dead node; id will not be null
    if (enemyId === null) continue;
    if (checkedChains.has(enemyId)) continue;
    checkedChains.add(enemyId);

    // If the enemy chain has exactly 2 liberties, placing at (x,y) — which is
    // adjacent to the chain — removes one liberty, leaving it in atari.
    if (liberties[enemyId] === 2) {
      return SCORE.ATARI;
    }
  }

  return 0;
}

/**
 * TERRITORY evaluator.
 *
 * Bitburner IPvGO scores both stones AND empty controlled nodes equally, so
 * filling already-secured own territory gives zero net benefit — it trades an
 * empty-point score for a stone-point score.  Worse, it can destroy an eye and
 * make an otherwise-immortal group killable.
 *
 * Instead we reward claiming CONTESTED ("?") empty space, which is the highest-
 * value territory action: converting a point from uncertain to ours.
 *
 * Moves placing inside already-confirmed BLACK territory return FILL_EYE penalty
 * so the player avoids blindly walking into its own secured regions.
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[] }} chains
 * @param {number[]}   eyeCounts  per-chain real-eye counts from computeEyeCounts()
 * @param {number}     size
 * @param {string[][]} territory  pre-computed from floodFillTerritory()
 * @returns {number}
 */
function evaluateTerritoryMove(x, y, board, chains, eyeCounts, size, territory) {
  const t = territory[x][y];

  // Contested space: always worth claiming — self-atari check already ensures safety.
  // Prioritise slightly if we have a friendly neighbor (better connectivity).
  if (t === "?") {
    for (const nb of getNeighbors(x, y, size, board)) {
      if (board[nb.x][nb.y] === BLACK) return SCORE.TERRITORY + 2; // friendly support bonus
    }
    return SCORE.TERRITORY; // contest it regardless — no lonely-stone bail-out
  }

  // Black-controlled empty space: apply FILL_EYE penalty only if the enclosing
  // group is already alive (2+ real eyes).  If the group has 0 or 1 eye, this
  // empty point is a potential eye space — we must NOT penalise it (return 0)
  // so the bot stays neutral about it; evaluateEyeCreateMove will score it
  // positively when the geometry is right.
  if (t === BLACK) {
    const { ids } = chains;
    // Find the chain that encloses this point (any BLACK neighbor)
    for (const nb of getNeighbors(x, y, size, board)) {
      if (board[nb.x][nb.y] === BLACK) {
        const cid = ids[nb.x][nb.y];
        if (cid !== null && (eyeCounts[cid] ?? 0) < 2) return 0; // group needs more eyes
        break;
      }
    }
    return SCORE.FILL_EYE; // group already has 2 eyes — filling here wastes a move
  }

  return 0;
}

/**
 * EYE_CREATE evaluator.
 *
 * Rewards moves that complete or create a real eye for a friendly group.
 * An eye is an empty cell completely surrounded by stones of the same color
 * (all 4 orthogonal neighbors are BLACK or off-board/dead).
 *
 * Exploit: the AI only blocks one eye-creation threat at a time.  If we have
 * two groups each needing one eye, build both simultaneously — the AI cannot
 * block both and both groups live.
 *
 * We score a move highly if placing at (x,y) would complete a 2nd eye for an
 * adjacent friendly group that already has exactly one eye-like space.  Even
 * without two-eye detection, scoring any eye-forming move above ATARI ensures
 * the bot proactively builds living groups.
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[] }} chains
 * @param {number[]}   eyeCounts  per-chain real-eye counts from computeEyeCounts()
 * @param {number}     size
 * @returns {number}
 */
function evaluateEyeCreateMove(x, y, board, chains, eyeCounts, size) {
  const { ids } = chains;
  const nbs = getNeighbors(x, y, size, board);
  if (nbs.length === 0) return 0;

  // ── True eye check ────────────────────────────────────────────────────────
  // All neighbors must be BLACK and all must belong to the SAME chain.
  // A point where two different chains meet is a "false eye" — not a real eye.
  let ownerChain = null;
  let isRealEye  = true;

  for (const nb of nbs) {
    if (board[nb.x][nb.y] !== BLACK) { isRealEye = false; break; }
    const nid = ids[nb.x][nb.y];
    if (ownerChain === null) { ownerChain = nid; }
    else if (nid !== ownerChain) { isRealEye = false; break; }
  }

  if (isRealEye && ownerChain !== null) {
    const eyes = eyeCounts[ownerChain] ?? 0;
    if (eyes >= 2) return 0;              // group already alive — no benefit
    if (eyes === 1) return SCORE.SECOND_EYE; // 88 — completing life is above ESCAPE
    return SCORE.FIRST_EYE;              // 72 — first eye is above ATARI
  }

  // ── Near-eye check ────────────────────────────────────────────────────────
  // 3-of-4 neighbors are BLACK and from the same chain: one move away from
  // forming a real eye.  Score it above ATARI to keep building toward life.
  let sameChainCount = 0;
  let nearOwner      = null;
  let isSameChain    = true;

  for (const nb of nbs) {
    if (board[nb.x][nb.y] !== BLACK) continue;
    const nid = ids[nb.x][nb.y];
    if (nearOwner === null) { nearOwner = nid; }
    else if (nid !== nearOwner) { isSameChain = false; break; }
    sameChainCount++;
  }

  if (isSameChain && nearOwner !== null && sameChainCount >= 3) {
    const eyes = eyeCounts[nearOwner] ?? 0;
    if (eyes >= 2) return 0; // already alive, don't bother
    return SCORE.EYE_APPROACH; // 65 — building toward an eye
  }

  return 0;
}

/**
 * CORNER evaluator.
 *
 * Exploit: the Bitburner AI's getCornerMove() only claims a corner if the
 * entire 3×3 corner region is completely empty.  Placing a single stone inside
 * any corner region permanently disables the AI's corner move for that corner.
 *
 * We score corner-region plays highly in the early game (< 25% fill) when
 * the corners are likely still empty, giving us a structural advantage that
 * persists for the entire game.
 *
 * Corner regions for an N×N board (0-indexed):
 *   top-left:     x ∈ [0, 2],        y ∈ [0, 2]
 *   top-right:    x ∈ [N-3, N-1],    y ∈ [0, 2]
 *   bottom-left:  x ∈ [0, 2],        y ∈ [N-3, N-1]
 *   bottom-right: x ∈ [N-3, N-1],    y ∈ [N-3, N-1]
 *
 * Only fires when fillRatio < 0.25 and the corner region is still entirely empty.
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {number}     size
 * @param {number}     fillRatio
 * @returns {number}
 */
function evaluateCornerMove(x, y, board, size, fillRatio) {
  // Only relevant early in the game
  if (fillRatio > 0.25) return 0;

  const hi = size - 1;
  // Check if (x,y) is inside one of the four 3×3 corner regions
  const inTopLeft     = x <= 2          && y <= 2;
  const inTopRight    = x <= 2          && y >= hi - 2;
  const inBottomLeft  = x >= hi - 2     && y <= 2;
  const inBottomRight = x >= hi - 2     && y >= hi - 2;

  if (!inTopLeft && !inTopRight && !inBottomLeft && !inBottomRight) return 0;

  // Determine which corner we're in and check if the region is still empty enough
  // to be worth claiming (AI only skips if region has ANY non-empty cell)
  let rx0, rx1, ry0, ry1;
  if      (inTopLeft)     { rx0 = 0;      rx1 = 2;      ry0 = 0;      ry1 = 2; }
  else if (inTopRight)    { rx0 = 0;      rx1 = 2;      ry0 = hi - 2; ry1 = hi; }
  else if (inBottomLeft)  { rx0 = hi - 2; rx1 = hi;     ry0 = 0;      ry1 = 2; }
  else                    { rx0 = hi - 2; rx1 = hi;     ry0 = hi - 2; ry1 = hi; }

  // If any non-dead cell in the region is already occupied, our stone is already
  // there or enemy has it — no bonus.
  for (let cx = rx0; cx <= rx1; cx++) {
    for (let cy = ry0; cy <= ry1; cy++) {
      if (board[cx][cy] === DEAD) continue;
      if (board[cx][cy] !== EMPTY) return 0;
    }
  }

  // The corner is entirely empty — play near its center to claim it
  // Highest bonus for the inner-most point (distance 1 from corner tip)
  const midX = Math.round((rx0 + rx1) / 2);
  const midY = Math.round((ry0 + ry1) / 2);
  const dist  = Math.abs(x - midX) + Math.abs(y - midY);
  return SCORE.CORNER - dist; // center of region = full bonus, edge = slightly less
}

/**
 * LADDER evaluator.
 *
 * A ladder is a sequence where an enemy chain in atari cannot escape because
 * every escape move puts it back in atari on the next turn.  The Bitburner AI
 * has ZERO lookahead — it cannot detect or avoid ladders.
 *
 * We detect a simple ladder start: the candidate move puts an enemy chain in
 * atari (1 liberty), and the enemy's only escape point is itself immediately
 * re-captured (its escape would also have only 1 or 2 liberties after moving,
 * leaving it vulnerable to the same pattern).
 *
 * This is a conservative one-level lookahead — we check that the enemy
 * escape point is not "safe" (i.e., would itself be in atari or low liberties
 * after moving there).  Full ladder reading is too expensive, but even a
 * one-level check catches most practical ladders on small boards.
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[], members: {x:number,y:number}[][] }} chains
 * @param {number[]}   liberties
 * @param {number}     size
 * @returns {number}
 */
function evaluateLadderMove(x, y, board, chains, liberties, size) {
  const { ids, members } = chains;

  for (const nb of getNeighbors(x, y, size, board)) {
    if (board[nb.x][nb.y] !== WHITE) continue;
    const eid = ids[nb.x][nb.y];
    if (eid === null) continue;

    // Move puts enemy in atari (2 liberties → 1 after our placement)
    if (liberties[eid] !== 2) continue;

    // Find the enemy chain's remaining liberty after we place at (x,y)
    // Collect all liberties of the enemy chain, excluding (x,y)
    const escapePts = [];
    const seen = new Set();
    for (const stone of members[eid]) {
      for (const snb of getNeighbors(stone.x, stone.y, size, board)) {
        const key = `${snb.x},${snb.y}`;
        if (!seen.has(key) && board[snb.x][snb.y] === EMPTY &&
            !(snb.x === x && snb.y === y)) {
          seen.add(key);
          escapePts.push(snb);
        }
      }
    }

    if (escapePts.length !== 1) continue; // not a simple 2-lib situation

    // Check if the escape point is itself "unsafe": count how many liberties the
    // enemy chain would have after moving to the escape point.
    // Approximation: count distinct empty neighbors of (escape + chain members),
    // excluding our stone at (x,y).
    const escX = escapePts[0].x, escY = escapePts[0].y;
    const postEscapeLiberties = new Set();
    // Escape stone's own neighbors
    for (const esnb of getNeighbors(escX, escY, size, board)) {
      if (board[esnb.x][esnb.y] === EMPTY && !(esnb.x === x && esnb.y === y)) {
        postEscapeLiberties.add(`${esnb.x},${esnb.y}`);
      }
    }
    // Chain member neighbors (excluding old liberty at x,y and adding escape point's neighbors)
    for (const stone of members[eid]) {
      for (const snb of getNeighbors(stone.x, stone.y, size, board)) {
        if (board[snb.x][snb.y] === EMPTY &&
            !(snb.x === x && snb.y === y) &&
            !(snb.x === escX && snb.y === escY)) {
          postEscapeLiberties.add(`${snb.x},${snb.y}`);
        }
      }
    }
    // The escape point is now occupied — remove it from liberties
    postEscapeLiberties.delete(`${escX},${escY}`);

    // If escape leaves the chain with ≤2 liberties, this is a ladder position —
    // the AI will be squeezed to capture on subsequent turns.
    if (postEscapeLiberties.size <= 2) {
      return SCORE.LADDER;
    }
  }

  return 0;
}

/**
 * EYE_BLOCK evaluator.
 *
 * Mirrors evaluateEyeCreateMove but for the OPPONENT: scores moves that
 * prevent WHITE from forming a real eye.
 *
 * Exploit: the AI's eyeBlock only blocks when there is EXACTLY ONE eye-creation
 * threat.  By proactively blocking WHITE's eye formation ourselves, we deprive
 * the AI of living groups and make its stones capturable.
 *
 * Scoring mirrors our own eye-creation priority (but slightly lower, since
 * blocking the enemy is reactive rather than building our own position):
 *   WHITE already has 1 eye → blocking 2nd = BLOCK_SECOND_EYE (84)
 *   WHITE has 0 eyes        → blocking 1st = BLOCK_FIRST_EYE  (67)
 *   3/4 WHITE same-chain    → near-block   = 60
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[] }} chains
 * @param {number[]}   whiteEyeCounts  WHITE eye counts from computeEyeCounts(…, WHITE)
 * @param {number}     size
 * @returns {number}
 */
function evaluateEyeBlockMove(x, y, board, chains, whiteEyeCounts, size) {
  const { ids } = chains;
  const nbs = getNeighbors(x, y, size, board);
  if (nbs.length === 0) return 0;

  // ── True white-eye check ─────────────────────────────────────────────────
  // Would this empty point be a real eye for WHITE if we don't play here?
  // All neighbors must be WHITE and from the same WHITE chain.
  let ownerChain = null;
  let isWhiteEye = true;

  for (const nb of nbs) {
    if (board[nb.x][nb.y] !== WHITE) { isWhiteEye = false; break; }
    const nid = ids[nb.x][nb.y];
    if (ownerChain === null) { ownerChain = nid; }
    else if (nid !== ownerChain) { isWhiteEye = false; break; }
  }

  if (isWhiteEye && ownerChain !== null) {
    const whiteEyes = whiteEyeCounts[ownerChain] ?? 0;
    if (whiteEyes >= 2) return 0;                   // already alive — blocking more eyes doesn't help
    if (whiteEyes === 1) return SCORE.BLOCK_SECOND_EYE; // 84 — making white group permanently dead
    return SCORE.BLOCK_FIRST_EYE;                   // 67 — preventing first white eye
  }

  // ── Near-eye block ───────────────────────────────────────────────────────
  // 3/4 neighbors WHITE same-chain: one step away from becoming a white eye.
  let sameCount  = 0;
  let nearOwner  = null;
  let isSame     = true;

  for (const nb of nbs) {
    if (board[nb.x][nb.y] !== WHITE) continue;
    const nid = ids[nb.x][nb.y];
    if (nearOwner === null) { nearOwner = nid; }
    else if (nid !== nearOwner) { isSame = false; break; }
    sameCount++;
  }

  if (isSame && nearOwner !== null && sameCount >= 3) {
    const whiteEyes = whiteEyeCounts[nearOwner] ?? 0;
    if (whiteEyes >= 2) return 0;
    return SCORE.ATARI - 2; // 58 — disrupt near-eye before it completes
  }

  return 0;
}

/**
 * DOUBLE_ATARI evaluator.
 *
 * Scores moves that simultaneously put TWO or more separate WHITE chains into
 * atari (1 liberty) with a single stone.
 *
 * Exploit: the AI's defendCapture checks each chain independently and can only
 * escape ONE per turn.  A double atari guarantees one capture next turn.
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[] }} chains
 * @param {number[]}   liberties
 * @param {number}     size
 * @returns {number}
 */
function evaluateDoubleAtariMove(x, y, board, chains, liberties, size) {
  const { ids } = chains;
  const threatened = new Set(); // distinct WHITE chains that go to 1 liberty after this move

  for (const nb of getNeighbors(x, y, size, board)) {
    if (board[nb.x][nb.y] !== WHITE) continue;
    const eid = ids[nb.x][nb.y];
    if (eid === null || threatened.has(eid)) continue;
    // Chain currently has 2 liberties and (x,y) is adjacent → placing here
    // removes one liberty, leaving it in atari.
    if (liberties[eid] === 2) threatened.add(eid);
  }

  if (threatened.size >= 2) return SCORE.DOUBLE_ATARI; // 75 — guaranteed fork
  return 0;
}

/**
 * FORTIFY evaluator.
 *
 * Exploit: the AI's defendCapture ONLY fires when a chain has exactly 1 liberty.
 * It never proactively defends a chain at 2 liberties.
 *
 * Mirror tactic: we proactively strengthen OWN chains that are at 2–3 liberties
 * BEFORE the AI squeezes them to 1 liberty.  A move that adds a liberty to a
 * vulnerable friendly chain is FORTIFY (40).
 *
 * Only fires for BLACK chains that also lack 2 eyes (chains with 2 eyes are
 * already alive — no urgency to add liberties).
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[], members: {x:number,y:number}[][] }} chains
 * @param {number[]}   liberties
 * @param {number[]}   eyeCounts
 * @param {number}     size
 * @returns {number}
 */
function evaluateFortifyMove(x, y, board, chains, liberties, eyeCounts, size) {
  const { ids } = chains;

  for (const nb of getNeighbors(x, y, size, board)) {
    if (board[nb.x][nb.y] !== BLACK) continue;
    const fid = ids[nb.x][nb.y];
    if (fid === null) continue;

    const lib  = liberties[fid];
    const eyes = eyeCounts[fid] ?? 0;

    // Only fortify chains that are not yet alive AND are at 2–3 liberties
    if (eyes < 2 && lib >= 2 && lib <= 3) {
      return SCORE.FORTIFY; // 40 — strengthen before being squeezed to atari
    }
  }

  return 0;
}

/**
 * REDUCE evaluator.
 *
 * Rewards moves that encroach on WHITE-controlled territory by placing a stone
 * adjacent to an enemy chain that has more than one liberty (not yet in atari,
 * but under pressure).  This contests space the opponent thought was safe and
 * forces defensive responses.
 *
 * Scores higher when the target enemy chain has fewer liberties (i.e., is weaker).
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[] }} chains
 * @param {number[]}   liberties
 * @param {number}     size
 * @param {string[][]} territory
 * @returns {number}
 */
function evaluateReduceMove(x, y, board, chains, liberties, size, territory) {
  // Only applies when the point is in enemy- or contested-territory
  const t = territory[x][y];
  if (t !== WHITE && t !== "?") return 0;

  const { ids } = chains;
  let minEnemyLiberties = Infinity;

  for (const nb of getNeighbors(x, y, size, board)) {
    if (board[nb.x][nb.y] !== WHITE) continue;
    const eid = ids[nb.x][nb.y];
    if (eid === null) continue;
    const lib = liberties[eid];
    // Atari (1 liberty) is handled by evaluateCaptureMove / evaluateAtariMove.
    // We care about chains with 2–4 liberties that we can squeeze further.
    if (lib >= 2 && lib <= 4) {
      minEnemyLiberties = Math.min(minEnemyLiberties, lib);
    }
  }

  if (minEnemyLiberties === Infinity) return 0;

  // The fewer liberties the enemy chain has, the more valuable the pressure.
  // 2 libs → REDUCE, 3 libs → REDUCE-2, 4 libs → REDUCE-4
  return SCORE.REDUCE - (minEnemyLiberties - 2) * 2;
}

/**
 * CONNECTION evaluator.
 *
 * Rewards moves that connect two or more separate friendly (BLACK) chains.
 * Connected groups share liberties, are much harder to capture, and can form
 * living groups (two eyes).  This is one of the most important positional concepts.
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[] }} chains
 * @param {number[]}   liberties
 * @param {number[]}   eyeCounts  per-chain real-eye counts from computeEyeCounts()
 * @param {number}     size
 * @param {number}     fillRatio
 * @returns {number}
 */
function evaluateConnectionMove(x, y, board, chains, liberties, eyeCounts, size, fillRatio) {
  const { ids } = chains;
  const adjacentFriendlyChains = new Set();

  for (const nb of getNeighbors(x, y, size, board)) {
    if (board[nb.x][nb.y] === BLACK) {
      const id = ids[nb.x][nb.y];
      if (id !== null) adjacentFriendlyChains.add(id);
    }
  }

  if (adjacentFriendlyChains.size < 2) return 0;

  // Tally how many eyes the groups we'd be joining collectively have.
  let totalEyes = 0;
  for (const id of adjacentFriendlyChains) totalEyes += (eyeCounts[id] ?? 0);

  // Two groups each with 1 eye unite to form a living group (2 eyes) — very good.
  if (totalEyes >= 2) return SCORE.CONNECT + 10; // 45 — completing a living group
  // At least one group has an eye — connection is still useful.
  if (totalEyes === 1) return SCORE.CONNECT;      // 35 — normal connect bonus
  // Both groups are eyeless — in early game connecting gives them shared resources
  // to build eyes together; in late game it's likely futile.
  if (fillRatio < 0.40) return SCORE.CONNECT - 12; // 23 — early, allow eyeless merge
  return 0; // late game: merging two dead groups creates a bigger dead group
}

/**
 * INFLUENCE evaluator.
 *
 * Rewards moves adjacent to own stones that expand outward into empty space.
 * This builds "influence" — presence across the board that makes it harder for
 * white to establish territory.  Think of it as placing scouts ahead of your lines.
 *
 * Only activates if the point is empty AND at least one friendly neighbor exists
 * AND at least one empty neighbor exists (i.e. we're expanding, not just filling).
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[] }} chains
 * @param {number[]}   liberties
 * @param {number}     size
 * @returns {number} SCORE.INFLUENCE if this move extends own presence, else 0
 */
function evaluateInfluenceMove(x, y, board, chains, liberties, size) {
  let hasFriendlyNeighbor = false;
  let hasEmptyNeighbor    = false;

  for (const nb of getNeighbors(x, y, size, board)) {
    if (board[nb.x][nb.y] === BLACK) hasFriendlyNeighbor = true;
    if (board[nb.x][nb.y] === EMPTY) hasEmptyNeighbor    = true;
    // Enemy contact is now handled by evaluateReduceMove; don't bail out here.
  }
  // Reward extending own presence — whether into pure empty or toward enemy.
  if (hasFriendlyNeighbor && hasEmptyNeighbor) return SCORE.INFLUENCE;
  return 0;
}

/**
 * POSITIONAL BONUS.
 *
 * Returns a small bonus (0–2) based on how central the point is.
 * Center points project influence in all directions; corners are weak.
 * Used only to break ties within the NEUTRAL fallback bucket.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @returns {number} 0–2
 */
function evaluatePositionalBonus(x, y, size) {
  // Manhattan distance from center, normalized to 0–2
  const cx   = (size - 1) / 2;
  const cy   = (size - 1) / 2;
  const dist = Math.abs(x - cx) + Math.abs(y - cy);
  const maxDist = cx + cy; // max possible Manhattan distance
  // Center = 2, corners = 0
  return Math.round((1 - dist / maxDist) * 2);
}

/**
 * SELF-ATARI risk check.
 *
 * Returns true if placing at (x, y) would put the newly placed stone (and any
 * friendly chain it connects to) into atari with no immediate capture rescue.
 *
 * Logic:
 *   1. Count the raw liberties the new stone would have from empty neighbors.
 *   2. Add liberties gained by merging with adjacent friendly chains.
 *   3. Subtract a liberty for each friendly chain already in atari that is not
 *      rescued by this move (they still share the one remaining liberty = x,y).
 *   4. If the net liberty count is 1 after adjustment, this is self-atari.
 *
 * We do NOT disqualify if the move also captures an enemy chain (the capture
 * produces open nodes which become new liberties, so it is fine).
 *
 * @param {number}     x
 * @param {number}     y
 * @param {string[][]} board
 * @param {{ ids: (number|null)[][], color: string[], members: {x:number,y:number}[][] }} chains
 * @param {number[]}   liberties
 * @param {number}     size
 * @returns {boolean} true if the move self-ataris with no rescue
 */
function evaluateSelfAtariRisk(x, y, board, chains, liberties, size) {
  const { ids, members } = chains;

  // If this move captures an enemy chain, it's always safe — captured stones
  // become empty nodes that act as new liberties for the placed stone.
  for (const nb of getNeighbors(x, y, size, board)) {
    if (board[nb.x][nb.y] === WHITE) {
      const nbId = ids[nb.x][nb.y];
      if (nbId !== null && liberties[nbId] === 1) return false;
    }
  }

  // Compute the ACTUAL post-placement liberty count for the merged group.
  // Merged group = new stone at (x,y) + all adjacent friendly chains.
  // Liberties = union of empty neighbors of every stone in the group, minus (x,y).
  //
  // The old heuristic "if any merged chain has >1 liberty, safe" was WRONG:
  // a chain with 2 liberties where one is (x,y) contributes only 1 liberty
  // after merge — which can leave the whole group in atari.
  const mergedLiberties = new Set();
  const visitedChains = new Set();

  // Add empty neighbors of the placed stone itself
  for (const nb of getNeighbors(x, y, size, board)) {
    if (board[nb.x][nb.y] === EMPTY) {
      mergedLiberties.add(`${nb.x},${nb.y}`);
    } else if (board[nb.x][nb.y] === BLACK) {
      const fid = ids[nb.x][nb.y];
      if (fid !== null && !visitedChains.has(fid)) {
        visitedChains.add(fid);
        // Walk every stone in the friendly chain and collect its empty neighbors
        for (const stone of members[fid]) {
          for (const cnb of getNeighbors(stone.x, stone.y, size, board)) {
            if (board[cnb.x][cnb.y] === EMPTY) {
              mergedLiberties.add(`${cnb.x},${cnb.y}`);
            }
          }
        }
      }
    }
  }

  // (x,y) is occupied after placement — it is no longer an empty liberty
  mergedLiberties.delete(`${x},${y}`);

  return mergedLiberties.size <= 1;
}

// ─── Territory classification ─────────────────────────────────────────────────

/**
 * Classifies every empty point on the board as controlled by BLACK ("X"),
 * WHITE ("O"), or contested ("?") using a flood-fill over empty regions.
 *
 * Algorithm:
 *   For each unvisited empty point, BFS-flood through connected empty space.
 *   Track which colored pieces border the region:
 *     - Only BLACK borders → BLACK controls the region
 *     - Only WHITE borders → WHITE controls the region
 *     - Both border it     → contested ("?")
 *
 * Filled points return "." (irrelevant — territory is only counted on empty nodes).
 * Dead nodes return "#".
 *
 * @param {string[][]} board
 * @param {number}     size
 * @returns {string[][]}  territory[x][y] = "X" | "O" | "?" | "." | "#"
 */
function floodFillTerritory(board, size) {
  // Start: copy the board so filled/dead cells have their value already
  const territory = board.map(col => [...col]);

  // Track which empty cells have been classified
  const visited = Array.from({ length: size }, () => new Array(size).fill(false));

  for (let sx = 0; sx < size; sx++) {
    for (let sy = 0; sy < size; sy++) {
      // Only start floods from unvisited empty cells
      if (board[sx][sy] !== EMPTY || visited[sx][sy]) continue;

      // ── BFS over connected empty region ──────────────────────────────────
      const region = [];          // all empty cells in this connected group
      let touchesBlack = false;
      let touchesWhite = false;
      const queue = [{ x: sx, y: sy }];
      visited[sx][sy] = true;

      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur) break;
        const { x, y } = cur;
        region.push({ x, y });

        for (const nb of getNeighbors(x, y, size, board)) {
          const cell = board[nb.x][nb.y];

          if (cell === BLACK) {
            touchesBlack = true;
          } else if (cell === WHITE) {
            touchesWhite = true;
          } else if (cell === EMPTY && !visited[nb.x][nb.y]) {
            visited[nb.x][nb.y] = true;
            queue.push(nb);
          }
          // DEAD cells are excluded by getNeighbors already
        }
      }

      // ── Label every cell in the region ────────────────────────────────────
      let label;
      if      (touchesBlack && !touchesWhite) label = BLACK;  // "X"
      else if (touchesWhite && !touchesBlack) label = WHITE;  // "O"
      else                                    label = "?";    // contested

      for (const { x, y } of region) {
        territory[x][y] = label;
      }
    }
  }

  return territory;
}

// ─── Game-over handler (STUB — implement this yourself!) ──────────────────────

/**
 * Called when the game loop receives a "gameOver" result.
 * Logs final scores and win/loss record, then restarts the game.
 *
 * @param {import("NetscriptDefinitions").NS} ns
 * @param {number} boardSize — board dimension to reuse when restarting
 */
async function handleGameOver(ns, boardSize) {
  const state    = ns.go.getGameState();
  const opponent = ns.go.getOpponent();
  const komi     = state.komi;

  // Determine winner — black wins if their score exceeds white's score + komi
  const blackWins = state.blackScore > state.whiteScore + komi;
  const winner    = blackWins ? "Black (you)" : `White (${opponent})`;

  ns.tprint(`▶ Game over vs ${opponent} — Winner: ${winner}`);
  ns.tprint(`  Black: ${state.blackScore}  |  White: ${state.whiteScore}  |  Komi: ${komi}`);

  // Log cumulative win/loss record for this opponent
  const stats         = ns.go.analysis.getStats();
  const opponentStats = stats[opponent];
  if (opponentStats) {
    const total   = opponentStats.wins + opponentStats.losses;
    const winRate = total > 0 ? (opponentStats.wins / total * 100).toFixed(1) : "0.0";
    ns.tprint(`  Record vs ${opponent}: ${opponentStats.wins}W / ${opponentStats.losses}L  (${winRate}% win rate)`);
  }

  // Short pause so the result is visible before the next game starts.
  // main() immediately starts the next game after this returns.
  await ns.sleep(2000);
}

// ─── Tab-completion ───────────────────────────────────────────────────────────

/**
 * Provides tab-completion for opponent names and board sizes.
 *
 * @param {import("NetscriptDefinitions").AutocompleteData} data
 * @param {string[]}         args
 * @returns {string[]}
 */
export function autocomplete(data, args) {
  if (args.length <= 1) {
    // First argument: opponent name
    return [
      "Netburners",
      "Slum Snakes",
      "The Black Hand",
      "Tetrads",
      "Daedalus",
      "Illuminati",
      "????????????",
      "No AI",
    ];
  }
  // Second argument: board size
  return ["5", "7", "9", "13"];
}
