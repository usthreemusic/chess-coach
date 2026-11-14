import { Chessground } from "../vendor/chessground.min.js";
import { Chess } from "../vendor/chess.js";
import { ready, onRefresh } from "./app.js";
import { loadPuzzles, loadThemed } from "./core/data.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// Progress and filters are stored per player: "<base>:<username>".
const STORE_BASE = "chess-coach-puzzles";
const FILTER_BASE = "chess-coach-train-filters";
let STORE_KEY = STORE_BASE;
let FILTER_KEY = FILTER_BASE;

// Copy the old un-suffixed value into the per-player key, once, if the per-player key is missing.
function migrateKey(base, key) {
  try {
    if (localStorage.getItem(key) === null) {
      const old = localStorage.getItem(base);
      if (old !== null) localStorage.setItem(key, old);
    }
  } catch (err) {
    // storage unavailable
  }
}
const DAY = 86400000;
const INTERVAL_DAYS = [0, 0, 1, 3, 7, 21]; // indexed by box, 1-5
const LEARNED_BOX = 4;

const THEMED_DELAY = 500; // ms before the opponent's reply is played in themed puzzles
const TAG_LABELS = {
  missed_mate: "Missed mate",
  missed_capture: "Missed capture",
  missed_fork: "Missed fork",
  hung_piece: "Hung a piece",
  back_rank: "Back rank",
  endgame: "Endgame",
  other: "Other",
};
const tagLabel = (tag) => TAG_LABELS[tag] || tag;

let puzzles = []; // every puzzle from my games
let themed = null; // Lichess puzzles, or null when the themed pool could not be loaded
let pool = []; // puzzles matching the filters
let filters = { mode: "games", opening: "all", colour: "both", tag: "all", weakness: "all" };
let state = {};
let board, current, answered;
let wantedTag = null; // ?tag= from the URL, applied once puzzles with that tag exist
// Themed puzzles: the live position, the index of the next solution move, the last move shown
let chess, step, lastMove, playToken = 0;

const isThemed = () => filters.mode === "themed";

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    return {};
  }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (err) {
    // storage unavailable: progress lasts for this visit only
  }
}

function loadFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY));
    if (saved && typeof saved === "object") return { ...filters, ...saved };
  } catch (err) {
    // ignore
  }
  return filters;
}

function saveFilters() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
  } catch (err) {
    // ignore
  }
}

function applyFilters() {
  if (isThemed()) {
    pool = (themed || []).filter((p) => filters.weakness === "all" || p.tag === filters.weakness);
    return;
  }
  pool = puzzles.filter(
    (p) =>
      (filters.opening === "all" || p.opening_family === filters.opening) &&
      (filters.colour === "both" || p.colour === filters.colour) &&
      (filters.tag === "all" || (p.tags || []).includes(filters.tag))
  );
}

function buildOpeningOptions() {
  const counts = new Map();
  for (const p of puzzles) counts.set(p.opening_family, (counts.get(p.opening_family) || 0) + 1);
  const families = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const select = $("filter-opening");
  select.replaceChildren(new Option("All openings", "all"));
  for (const [family, n] of families) select.append(new Option(`${family} (${n})`, family));
  if (!counts.has(filters.opening)) filters.opening = "all";
  select.value = filters.opening;
  $("filter-colour").value = filters.colour;
}

// Mistake type options for my own games, with counts.
function buildTagOptions() {
  const counts = new Map();
  for (const p of puzzles) for (const t of p.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  const order = Object.keys(TAG_LABELS).filter((t) => counts.has(t));
  const extra = [...counts.keys()].filter((t) => !TAG_LABELS[t]).sort();
  const select = $("filter-tag");
  select.replaceChildren(new Option("All mistake types", "all"));
  for (const tag of [...order, ...extra]) select.append(new Option(`${tagLabel(tag)} (${counts.get(tag)})`, tag));
  if (!counts.has(filters.tag)) filters.tag = "all";
  select.value = filters.tag;
}

// Weakness options: tags that have themed puzzles, most frequent mistake first.
function buildWeaknessOptions() {
  const mine = new Map();
  for (const p of puzzles) for (const t of p.tags || []) mine.set(t, (mine.get(t) || 0) + 1);
  const counts = new Map();
  for (const p of themed || []) counts.set(p.tag, (counts.get(p.tag) || 0) + 1);
  const tags = [...counts.keys()].sort(
    (a, b) => (mine.get(b) || 0) - (mine.get(a) || 0) || counts.get(b) - counts.get(a) || a.localeCompare(b)
  );
  const select = $("filter-weakness");
  select.replaceChildren(new Option("All weaknesses", "all"));
  for (const tag of tags) select.append(new Option(`${tagLabel(tag)} (${counts.get(tag)})`, tag));
  if (!counts.has(filters.weakness)) filters.weakness = "all";
  select.value = filters.weakness;
}

function syncFilterControls() {
  $("filter-mode").value = filters.mode;
  $("filter-opening").hidden = isThemed();
  $("filter-colour").hidden = isThemed();
  $("filter-tag").hidden = isThemed();
  $("filter-weakness").hidden = !isThemed();
}

function record(puzzle, solved) {
  const box = state[puzzle.key]?.box ?? 1;
  const next = solved ? Math.min(5, box + 1) : 1;
  state[puzzle.key] = { box: next, due: Date.now() + INTERVAL_DAYS[next] * DAY };
  saveState();
}

function dueList() {
  const now = Date.now();
  return pool
    .filter((p) => state[p.key] && state[p.key].due <= now)
    .sort((a, b) => state[a.key].due - state[b.key].due);
}

// Games: newest first. Themed: the file's order.
const unseenList = () =>
  pool
    .filter((p) => !state[p.key])
    .sort(isThemed() ? () => 0 : (a, b) => b.end_time - a.end_time || b.ply - a.ply);

const learnedCount = () => pool.filter((p) => state[p.key] && state[p.key].box >= LEARNED_BOX).length;

// Recency drives the queue: a puzzle's weight halves for every HALF_LIFE_DAYS
// of game age, and a review that is due counts REVIEW_BOOST times an unseen one.
const HALF_LIFE_DAYS = 30;
const REVIEW_BOOST = 3;
const recentlyShown = [];

function priority(puzzle, now) {
  const ageDays = (now / 1000 - puzzle.end_time) / 86400;
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS) * (state[puzzle.key] ? REVIEW_BOOST : 1);
}

function pickNext(skipId) {
  const now = Date.now();
  const queue = [...dueList(), ...unseenList()];
  // Themed: due reviews (oldest first) then unseen in file order. Games: recency-weighted.
  if (!isThemed()) queue.sort((a, b) => priority(b, now) - priority(a, now));
  // Do not bring a puzzle straight back: skip the last few shown while others remain.
  const next =
    queue.find((p) => p.key !== skipId && !recentlyShown.includes(p.key)) ||
    queue.find((p) => p.key !== skipId) ||
    queue[0] ||
    null;
  if (next) {
    recentlyShown.push(next.key);
    if (recentlyShown.length > 5) recentlyShown.shift();
  }
  return next;
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function updateCounts() {
  $("counts").textContent =
    `${dueList().length} due now · ${unseenList().length} unseen · ${learnedCount()} learned (of ${pool.length})`;
}

// Legal moves from chess.js in the shape chessground wants: Map(from -> [to, ...]).
function destsFor(chess) {
  const dests = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

function setMovable(enabled, position = new Chess(current.fen)) {
  const colour = position.turn() === "w" ? "white" : "black";
  board.set({
    fen: position.fen(),
    turnColor: colour,
    movable: { free: false, color: enabled ? colour : undefined, dests: enabled ? destsFor(position) : new Map() },
  });
}

function showRest(label, className) {
  const rest = current.pv.slice(1).join(" ");
  const result = $("result");
  result.replaceChildren(el("p", className, label));
  if (rest) result.append(el("p", "", `Continuation: ${rest}`));
}

function finish(solved, altSan) {
  answered = true;
  playToken++; // cancel a pending opponent reply
  record(current, solved);
  updateCounts();
  $("show-answer").hidden = true;
  $("next").hidden = false;
  $("next").focus();
  $("show-answer").disabled = false;
  if (isThemed()) return finishThemed(solved);
  if (solved) {
    board.set({ movable: { color: undefined } });
    if (altSan) {
      $("result").replaceChildren(
        el("p", "solved", `Solved! ${altSan} is a good move.`),
        el("p", "", `The engine's first choice was ${current.best_san}.`)
      );
    } else {
      showRest("Solved! That is the best move.", "solved");
    }
  } else {
    const rest = current.pv.slice(1).join(" ");
    $("result").replaceChildren(el("p", "failed", `Best was ${current.best_san}${rest ? `, then ${rest}` : ""}.`));
    setMovable(false); // snap back to the puzzle position
    board.setAutoShapes([
      { orig: current.best_uci.slice(0, 2), dest: current.best_uci.slice(2, 4), brush: "green" },
    ]);
  }
}

const sq = (uci) => [uci.slice(0, 2), uci.slice(2, 4)];

// SAN for a line of UCI moves played from the live position (stops at an illegal one).
function sanLine(ucis) {
  const c = new Chess(chess.fen());
  const out = [];
  for (const uci of ucis) {
    try {
      out.push(c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    } catch (err) {
      break;
    }
  }
  return out;
}

function finishThemed(solved) {
  if (solved) {
    board.set({ movable: { color: undefined } });
    $("result").replaceChildren(el("p", "solved", "Solved!"));
    return;
  }
  const line = sanLine(current.solution.slice(step));
  const rest = line.slice(1).join(" ");
  $("result").replaceChildren(el("p", "failed", `Best was ${line[0] || "?"}${rest ? `, then ${rest}` : ""}.`));
  setMovable(false, chess); // snap back to the position before the wrong move
  board.set({ lastMove });
  board.setAutoShapes([{ orig: sq(current.solution[step])[0], dest: sq(current.solution[step])[1], brush: "green" }]);
}

function onThemedMove(orig, dest) {
  const expected = current.solution[step];
  const move = chess.moves({ verbose: true }).find((m) => m.from === orig && m.to === dest);
  if (!move) return finish(false);
  // Promote to the solution's piece when the squares match, else to a queen.
  const promotion = move.promotion ? (expected.slice(0, 4) === orig + dest && expected[4]) || "q" : undefined;
  let ok = orig + dest + (promotion || "") === expected;
  if (!ok) {
    // Any checkmate is as good as an expected checkmate.
    const wanted = new Chess(chess.fen());
    wanted.move({ from: sq(expected)[0], to: sq(expected)[1], promotion: expected[4] });
    if (wanted.isCheckmate()) {
      const mine = new Chess(chess.fen());
      mine.move({ from: orig, to: dest, promotion });
      ok = mine.isCheckmate();
    }
  }
  if (!ok) return finish(false);
  chess.move({ from: orig, to: dest, promotion });
  step++;
  lastMove = [orig, dest];
  board.set({ fen: chess.fen(), lastMove });
  if (step >= current.solution.length || chess.isGameOver()) return finish(true);
  setMovable(false, chess);
  $("show-answer").disabled = true;
  const token = ++playToken;
  setTimeout(() => {
    if (token !== playToken || answered) return;
    const reply = current.solution[step];
    chess.move({ from: sq(reply)[0], to: sq(reply)[1], promotion: reply[4] });
    step++;
    lastMove = sq(reply);
    board.set({ lastMove });
    $("show-answer").disabled = false;
    if (step >= current.solution.length) return finish(true);
    setMovable(true, chess);
    board.set({ lastMove });
  }, THEMED_DELAY);
}

function onMove(orig, dest) {
  if (answered) return;
  if (isThemed()) return onThemedMove(orig, dest);
  const chess = new Chess(current.fen);
  const alts = current.alts || [];
  // Auto-promote to queen unless an accepted answer on these squares promotes otherwise.
  const accepted = [current.best_uci, ...alts].find((u) => u.slice(0, 4) === orig + dest);
  const move = chess.moves({ verbose: true }).find((m) => m.from === orig && m.to === dest);
  const uci = orig + dest + (move && move.promotion ? (accepted && accepted[4]) || "q" : "");
  if (uci === current.best_uci) return finish(true);
  const alt = alts.indexOf(uci);
  if (alt !== -1) return finish(true, current.alts_san[alt]);
  finish(false);
}

function showThemed(puzzle) {
  chess = new Chess(puzzle.fen);
  step = 0;
  lastMove = sq(puzzle.last_uci);
  const colour = chess.turn() === "w" ? "white" : "black";
  board.set({ orientation: colour, lastMove });
  board.setAutoShapes([]);
  setMovable(true, chess);
  board.set({ lastMove });
  $("prompt").textContent = `Themed puzzle: ${tagLabel(puzzle.tag)}. Find the best move.`;
  $("puzzle-meta").textContent = `Rating ${puzzle.rating} · you are ${colour}`;
  $("credit-link").href = `https://lichess.org/training/${encodeURIComponent(puzzle.id)}`;
}

function showPuzzle(puzzle) {
  current = puzzle;
  answered = false;
  playToken++;
  $("review-line").hidden = isThemed();
  $("credit").hidden = !isThemed();
  $("show-answer").disabled = false;
  $("result").replaceChildren();
  $("show-answer").hidden = false;
  $("next").hidden = true;
  if (isThemed()) {
    showThemed(puzzle);
    updateCounts();
    return;
  }
  const chess = new Chess(puzzle.fen);
  const colour = chess.turn() === "w" ? "white" : "black";
  board.set({ orientation: colour, lastMove: undefined });
  board.setAutoShapes([]);
  setMovable(true);

  $("prompt").textContent = `You played ${puzzle.played_san} here (${puzzle.class}). Find a better move.`;
  $("puzzle-meta").textContent =
    `${formatDate(puzzle.end_time * 1000)} · ${puzzle.time_class} · ${puzzle.opening_family} · ${puzzle.opening || "Unknown opening"} · you are ${colour}`;
  $("review-link").href = `review.html?id=${encodeURIComponent(puzzle.game_id)}&ply=${puzzle.ply}`;
  updateCounts();
}

function showDone() {
  current = null;
  playToken++;
  $("puzzle").hidden = true;
  if (isThemed() && !themed) {
    $("done").textContent = "Themed puzzles could not be loaded. Check your connection and reload the page.";
    $("done").hidden = false;
    updateCounts();
    return;
  }
  if (!isThemed() && !puzzles.length) {
    $("done").textContent = "Analysing your games — puzzles appear as soon as the first game is done.";
    $("done").hidden = false;
    updateCounts();
    return;
  }
  const upcoming = pool.map((p) => state[p.key]).filter(Boolean).map((s) => s.due).filter((d) => d > Date.now());
  $("done").textContent = upcoming.length
    ? `Nothing is due and nothing is unseen. The next puzzle is due ${formatDate(Math.min(...upcoming))}.`
    : "No puzzles match these filters.";
  $("done").hidden = false;
  updateCounts();
}

function advance(skipId) {
  const next = pickNext(skipId);
  if (next) {
    $("done").hidden = true;
    $("puzzle").hidden = false;
    showPuzzle(next);
  } else {
    showDone();
  }
}

function notice(text) {
  $("notice").textContent = text;
}

function exportProgress() {
  const blob = new Blob([JSON.stringify(state, null, 1)], { type: "application/json" });
  const link = el("a");
  link.href = URL.createObjectURL(blob);
  link.download = `chess-coach-progress-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

async function importProgress(file) {
  let incoming;
  try {
    incoming = JSON.parse(await file.text());
  } catch (err) {
    return notice("That file is not valid JSON.");
  }
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return notice("That file is not a progress export.");
  let merged = 0;
  for (const [id, entry] of Object.entries(incoming)) {
    const ok = entry && Number.isInteger(entry.box) && entry.box >= 1 && entry.box <= 5 && Number.isFinite(entry.due);
    if (!ok) continue;
    if (!state[id] || entry.due > state[id].due) state[id] = { box: entry.box, due: entry.due }; // newer review wins
    merged++;
  }
  saveState();
  notice(`Imported ${merged} puzzle record(s).`);
  updateCounts();
  if (!current) advance();
}

// Load the current puzzle pools and rebuild the dropdowns and counts. The puzzle on the board stays.
async function refreshData() {
  const [mine, extra] = await Promise.all([loadPuzzles(), loadThemed().catch(() => null)]);
  puzzles = mine.puzzles;
  for (const p of puzzles) p.key = p.id;
  themed = extra ? extra.puzzles : null;
  for (const p of themed || []) p.key = `L:${p.id}`; // cannot collide with game puzzle ids
  if (wantedTag && puzzles.some((p) => (p.tags || []).includes(wantedTag))) {
    filters.mode = "games";
    filters.tag = wantedTag;
    wantedTag = null;
    saveFilters();
  }
  buildOpeningOptions();
  buildTagOptions();
  applyFilters();
  buildWeaknessOptions();
  syncFilterControls();
  updateCounts();
  if (!current) advance();
}

async function init() {
  const user = await ready;
  STORE_KEY = `${STORE_BASE}:${user}`;
  FILTER_KEY = `${FILTER_BASE}:${user}`;
  migrateKey(STORE_BASE, STORE_KEY);
  migrateKey(FILTER_BASE, FILTER_KEY);
  state = loadState();
  filters = loadFilters();
  if (filters.mode !== "themed") filters.mode = "games";
  // ?tag=<mistake type> overrides the saved filter; unknown values are ignored
  wantedTag = new URLSearchParams(location.search).get("tag");

  $("train").hidden = false;
  board = Chessground($("board"), {
    coordinates: true,
    drawable: { enabled: false, visible: true },
    movable: { free: false, showDests: true, events: { after: onMove } },
  });

  $("show-answer").onclick = () => {
    if (!answered) finish(false);
  };
  $("next").onclick = () => advance(current && current.key);
  $("export").onclick = exportProgress;
  $("import").onclick = () => $("import-file").click();
  $("import-file").onchange = (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) importProgress(file);
  };
  const onFilter = () => {
    filters = {
      mode: $("filter-mode").value,
      opening: $("filter-opening").value,
      colour: $("filter-colour").value,
      tag: $("filter-tag").value,
      weakness: $("filter-weakness").value,
    };
    saveFilters();
    applyFilters();
    syncFilterControls();
    advance();
  };
  $("filter-mode").onchange = onFilter;
  $("filter-weakness").onchange = onFilter;
  $("filter-opening").onchange = onFilter;
  $("filter-colour").onchange = onFilter;
  $("filter-tag").onchange = onFilter;
  try {
    await refreshData();
  } catch (err) {
    $("status").textContent = "Could not read your games from this browser's storage: " + err.message;
    $("status").hidden = false;
  }
  onRefresh(refreshData);
}

// Chessground caches where the board sits on the page. Refresh that whenever the
// layout moves (theme switch, filters wrapping), or drags land on the wrong squares.
const refreshBoard = () => board && board.redrawAll();
window.addEventListener("themechange", refreshBoard);
new ResizeObserver(refreshBoard).observe(document.body);

init();
