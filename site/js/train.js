import { Chessground } from "../vendor/chessground.min.js";
import { Chess } from "../vendor/chess.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const STORE_KEY = "chess-coach-puzzles";
const FILTER_KEY = "chess-coach-train-filters";
const DAY = 86400000;
const INTERVAL_DAYS = [0, 0, 1, 3, 7, 21]; // indexed by box, 1-5
const LEARNED_BOX = 4;

let puzzles = []; // every puzzle
let pool = []; // puzzles matching the filters
let filters = { opening: "all", colour: "both" };
let state = {};
let board, current, answered;

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
  pool = puzzles.filter(
    (p) =>
      (filters.opening === "all" || p.opening_family === filters.opening) &&
      (filters.colour === "both" || p.colour === filters.colour)
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

function record(puzzle, solved) {
  const box = state[puzzle.id]?.box ?? 1;
  const next = solved ? Math.min(5, box + 1) : 1;
  state[puzzle.id] = { box: next, due: Date.now() + INTERVAL_DAYS[next] * DAY };
  saveState();
}

function dueList() {
  const now = Date.now();
  return pool
    .filter((p) => state[p.id] && state[p.id].due <= now)
    .sort((a, b) => state[a.id].due - state[b.id].due);
}

const unseenList = () =>
  pool.filter((p) => !state[p.id]).sort((a, b) => b.end_time - a.end_time || b.ply - a.ply);

const learnedCount = () => pool.filter((p) => state[p.id] && state[p.id].box >= LEARNED_BOX).length;

// Recency drives the queue: a puzzle's weight halves for every HALF_LIFE_DAYS
// of game age, and a review that is due counts REVIEW_BOOST times an unseen one.
const HALF_LIFE_DAYS = 30;
const REVIEW_BOOST = 3;
const recentlyShown = [];

function priority(puzzle, now) {
  const ageDays = (now / 1000 - puzzle.end_time) / 86400;
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS) * (state[puzzle.id] ? REVIEW_BOOST : 1);
}

function pickNext(skipId) {
  const now = Date.now();
  const queue = [...dueList(), ...unseenList()].sort((a, b) => priority(b, now) - priority(a, now));
  // Do not bring a puzzle straight back: skip the last few shown while others remain.
  const next =
    queue.find((p) => p.id !== skipId && !recentlyShown.includes(p.id)) ||
    queue.find((p) => p.id !== skipId) ||
    queue[0] ||
    null;
  if (next) {
    recentlyShown.push(next.id);
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

function setMovable(enabled) {
  const chess = new Chess(current.fen);
  const colour = chess.turn() === "w" ? "white" : "black";
  board.set({
    fen: current.fen,
    turnColor: colour,
    movable: { free: false, color: enabled ? colour : undefined, dests: enabled ? destsFor(chess) : new Map() },
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
  record(current, solved);
  updateCounts();
  $("show-answer").hidden = true;
  $("next").hidden = false;
  $("next").focus();
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

function onMove(orig, dest) {
  if (answered) return;
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

function showPuzzle(puzzle) {
  current = puzzle;
  answered = false;
  const chess = new Chess(puzzle.fen);
  const colour = chess.turn() === "w" ? "white" : "black";
  board.set({ orientation: colour, lastMove: undefined });
  board.setAutoShapes([]);
  setMovable(true);

  $("prompt").textContent = `You played ${puzzle.played_san} here (${puzzle.class}). Find a better move.`;
  $("puzzle-meta").textContent =
    `${formatDate(puzzle.end_time * 1000)} · ${puzzle.time_class} · ${puzzle.opening_family} · ${puzzle.opening || "Unknown opening"} · you are ${colour}`;
  $("review-link").href = `review.html?id=${encodeURIComponent(puzzle.game_id)}&ply=${puzzle.ply}`;
  $("result").replaceChildren();
  $("show-answer").hidden = false;
  $("next").hidden = true;
  updateCounts();
}

function showDone() {
  current = null;
  $("puzzle").hidden = true;
  const upcoming = pool.map((p) => state[p.id]).filter(Boolean).map((s) => s.due).filter((d) => d > Date.now());
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

async function init() {
  const fail = (message) => {
    $("status").textContent = message;
    $("status").hidden = false;
  };
  try {
    const resp = await fetch("data/puzzles.json");
    if (!resp.ok) throw new Error(resp.status);
    puzzles = (await resp.json()).puzzles;
  } catch (err) {
    return fail("Could not load data/puzzles.json. Puzzles appear once games have been analysed.");
  }
  state = loadState();
  filters = loadFilters();
  applyFilters();
  buildOpeningOptions();

  $("train").hidden = false;
  board = Chessground($("board"), {
    coordinates: true,
    drawable: { enabled: false, visible: true },
    movable: { free: false, showDests: true, events: { after: onMove } },
  });

  $("show-answer").onclick = () => {
    if (!answered) finish(false);
  };
  $("next").onclick = () => advance(current && current.id);
  $("export").onclick = exportProgress;
  $("import").onclick = () => $("import-file").click();
  $("import-file").onchange = (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) importProgress(file);
  };
  const onFilter = () => {
    filters = { opening: $("filter-opening").value, colour: $("filter-colour").value };
    saveFilters();
    applyFilters();
    advance();
  };
  $("filter-opening").onchange = onFilter;
  $("filter-colour").onchange = onFilter;
  advance();
}

init();
