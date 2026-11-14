import { Chessground } from "../vendor/chessground.min.js";
import { Chess } from "../vendor/chess.js";
import { ready, onRefresh } from "./app.js";
import { loadPuzzles, loadThemed } from "./core/data.js";
import { phaseOf } from "./core/chessutil.js";
import { explainLine } from "./core/explain.js";

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

const REPLY_DELAY = 600; // ms before the opponent's reply is played
const LINE_DELAY = 1100; // ms between moves when the best line is played back
const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const PHASE_LABELS = { opening: "Opening (moves 1–11)", middlegame: "Middlegame", endgame: "Endgame" };
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
let filters = { mode: "games", opening: "all", colour: "both", tag: "all", phase: "all", weakness: "all" };
let state = {};
let board, current, answered;
const phases = new Map(); // puzzle id -> opening, middlegame or endgame
let wantedTag = null; // ?tag= from the URL, applied once puzzles with that tag exist
// The puzzle on the board: the live position, the moves to find (UCI), the whole best line (UCI),
// the index of the next move in `line`, the last move shown and the one shown at the start
let chess, line = [], fullLine = [], step, lastMove, startMove, playToken = 0;
// scored: this puzzle's result is already recorded. hinted: a hint was used. outcome: up, same or down
let scored, hinted, outcome;

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
      (filters.tag === "all" || (p.tags || []).includes(filters.tag)) &&
      (filters.phase === "all" || p.phase === filters.phase)
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

// Game phase options (opening, middlegame, endgame), with counts.
function buildPhaseOptions() {
  const counts = new Map();
  for (const p of puzzles) counts.set(p.phase, (counts.get(p.phase) || 0) + 1);
  const select = $("filter-phase");
  select.replaceChildren(new Option("All game phases", "all"));
  for (const phase of Object.keys(PHASE_LABELS)) {
    if (counts.has(phase)) select.append(new Option(`${PHASE_LABELS[phase]} (${counts.get(phase)})`, phase));
  }
  if (!counts.has(filters.phase)) filters.phase = "all";
  select.value = filters.phase;
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
  $("filter-phase").hidden = isThemed();
  $("filter-weakness").hidden = !isThemed();
}

// result: "up" (solved first try), "same" (solved with a hint) or "down" (a wrong move, or the answer shown)
function record(puzzle, result) {
  const box = state[puzzle.key]?.box ?? 1;
  const next = result === "up" ? Math.min(5, box + 1) : result === "same" ? box : 1;
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
    `${dueList().length} to review · ${unseenList().length} new · ${learnedCount()} learned · ${pool.length} puzzles in this selection`;
}

// Legal moves from chess.js in the shape chessground wants: Map(from -> [to, ...]).
function destsFor(position) {
  const dests = new Map();
  for (const m of position.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

const sq = (uci) => [uci.slice(0, 2), uci.slice(2, 4)];
const colourOf = (position) => (position.turn() === "w" ? "white" : "black");
const play = (position, uci) => position.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
const say = (...nodes) => $("result").replaceChildren(...nodes);
// A correct move is highlighted in green; anything else keeps the theme's last-move colour.
const setGood = (on) => $("board").classList.toggle("good-move", on);
// Only these moves affect the Leitner box: every move of a themed puzzle, the first move of one from my games.
const scores = () => isThemed() || step === 0;

// Put the live position on the board; `enabled` lets the player move.
function setMovable(enabled) {
  const colour = colourOf(chess);
  board.set({
    fen: chess.fen(),
    turnColor: colour,
    lastMove,
    check: chess.isCheck(),
    movable: { free: false, color: enabled ? colour : undefined, dests: enabled ? destsFor(chess) : new Map() },
  });
}

// SAN for a line of UCI moves played from a position (stops at an illegal one).
function sanFrom(position, ucis) {
  const c = new Chess(position.fen());
  const out = [];
  for (const uci of ucis) {
    try {
      out.push(play(c, uci).san);
    } catch (err) {
      break;
    }
  }
  return out;
}

// UCI for a line of SAN moves played from a FEN (stops at an illegal one).
function uciFrom(fen, sans) {
  const c = new Chess(fen);
  const out = [];
  for (const san of sans || []) {
    try {
      const m = c.move(san);
      out.push(m.from + m.to + (m.promotion || ""));
    } catch (err) {
      break;
    }
  }
  return out;
}

// fullLine is the whole best line; line is the part the player is asked to play.
// From my games the player carries on past the first move only when the follow-up is forcing
// (a capture, check or mate), because a quiet follow-up has too many equally good answers.
function buildLines(puzzle) {
  if (isThemed()) {
    fullLine = puzzle.solution;
    line = fullLine;
    return;
  }
  fullLine = uciFrom(puzzle.fen, puzzle.pv);
  if (fullLine[0] !== puzzle.best_uci) fullLine = [puzzle.best_uci];
  const forcing = fullLine.length >= 3 && /[x+#]/.test(puzzle.pv[2]);
  line = forcing ? fullLine.slice(0, 3) : fullLine.slice(0, 1);
}

function score(result) {
  if (scored) return;
  scored = true;
  outcome = result;
  record(current, result);
  updateCounts();
}

function scoreNote() {
  if (outcome === "up") {
    const days = INTERVAL_DAYS[state[current.key].box];
    return `First try. This puzzle comes back in ${days} day${days === 1 ? "" : "s"}.`;
  }
  if (outcome === "same") return "You used a hint, so this puzzle stays at the same level and comes back again.";
  return "This puzzle goes back to the start and comes round again soon.";
}

function finish(solved, altSan) {
  answered = true;
  playToken++; // cancel a pending opponent reply
  score(!solved ? "down" : hinted ? "same" : "up");
  for (const id of ["show-answer", "hint"]) {
    $(id).hidden = true;
    $(id).disabled = false;
  }
  $("play-line").hidden = false;
  $("play-line").textContent = "Play the best line";
  $("explain").hidden = false;
  $("next").hidden = false;
  $("next").focus();
  board.setAutoShapes([]);
  const rest = sanFrom(chess, fullLine.slice(step));
  if (solved) {
    board.set({ movable: { color: undefined } });
    if (altSan) {
      say(
        el("p", "solved", `Solved! ${altSan} is a good move.`),
        el("p", "", `The engine's first choice was ${current.best_san}.`)
      );
    } else {
      say(el("p", "solved", isThemed() ? "Solved!" : step > 1 ? "Solved! You found the whole line." : "Solved! That is the best move."));
      if (rest.length) $("result").append(el("p", "", `Continuation: ${rest.join(" ")}`));
    }
  } else {
    say(el("p", "failed", `Best was ${rest[0] || "?"}${rest.length > 1 ? `, then ${rest.slice(1).join(" ")}` : ""}.`));
    setGood(false);
    setMovable(false); // snap back to the position before the wrong move
    if (line[step]) board.setAutoShapes([{ orig: sq(line[step])[0], dest: sq(line[step])[1], brush: "green" }]);
  }
  $("result").append(el("p", "muted", scoreNote()));
}

// A wrong move: say so, put the piece back and let the player try again.
function wrong(san) {
  if (scores()) score("down");
  setMovable(true);
  const text = !san
    ? "That move is not legal. Try again."
    : !isThemed() && step === 0 && san === current.played_san
      ? `${san} is the move you played in the game. Try something else.`
      : `${san} is not the move. Try again.`;
  say(el("p", "failed", text), el("p", "muted", "Stuck? Ask for a hint, or show the answer."));
}

function showHint() {
  if (!current || answered || !line[step]) return;
  if (scores()) hinted = true;
  const from = sq(line[step])[0];
  board.setAutoShapes([{ orig: from, brush: "green" }]);
  say(el("p", "", `Hint: move your ${PIECE_NAMES[chess.get(from).type]} on ${from}.`));
}

function onMove(orig, dest) {
  if (!current || answered) return;
  const expected = line[step];
  const move = chess.moves({ verbose: true }).find((m) => m.from === orig && m.to === dest);
  if (!move) return wrong(null);
  // Other good first moves (within 50 cp of the best) are accepted in puzzles from my games.
  const alts = !isThemed() && step === 0 ? current.alts || [] : [];
  // Promote to an accepted answer's piece when the squares match, else to a queen.
  const match = [expected, ...alts].find((u) => u.slice(0, 4) === orig + dest);
  const promotion = move.promotion ? (match && match[4]) || "q" : undefined;
  const uci = orig + dest + (promotion || "");
  const after = new Chess(chess.fen());
  const san = play(after, uci).san;
  const alt = alts.indexOf(uci);
  // Any checkmate is as good as the expected move.
  if (uci !== expected && alt === -1 && !after.isCheckmate()) return wrong(san);

  chess = after;
  step++;
  lastMove = [orig, dest];
  setGood(true);
  board.setAutoShapes([]);
  setMovable(false);
  if (uci !== expected) return finish(true, alt !== -1 ? current.alts_san[alt] : null);
  if (step >= line.length || chess.isGameOver()) return finish(true);

  // The opponent's reply, then the player carries on.
  say(el("p", "solved", `${san} is right.`));
  $("show-answer").disabled = true;
  $("hint").disabled = true;
  const token = ++playToken;
  setTimeout(() => {
    if (token !== playToken || answered) return;
    const reply = line[step];
    const replySan = play(chess, reply).san;
    step++;
    lastMove = sq(reply);
    setGood(false);
    $("show-answer").disabled = false;
    $("hint").disabled = false;
    if (step >= line.length || chess.isGameOver()) {
      setMovable(false);
      return finish(true);
    }
    setMovable(true);
    say(el("p", "solved", `${san} is right.`), el("p", "", `Your opponent answers ${replySan}. Find the follow-up.`));
  }, REPLY_DELAY);
}

// Play the whole best line on the board from the puzzle position, one move at a time.
function playLine() {
  if (!current || !answered) return;
  const token = ++playToken;
  const position = new Chess(current.fen);
  const sans = sanFrom(position, fullLine);
  const caption = el("p", "line-caption");
  say(el("p", "", "Best line:"), caption);
  board.setAutoShapes([]);
  setGood(false);
  board.set({
    fen: position.fen(),
    turnColor: colourOf(position),
    lastMove: startMove,
    check: position.isCheck(),
    movable: { color: undefined, dests: new Map() },
  });
  $("play-line").textContent = "Replay the best line";
  const me = position.turn();
  let i = 0;
  const tick = () => {
    if (token !== playToken || i >= sans.length) return;
    const mine = position.turn() === me;
    const move = position.move(sans[i]);
    setGood(mine);
    board.set({ fen: position.fen(), turnColor: colourOf(position), lastMove: [move.from, move.to], check: position.isCheck() });
    const span = el("span", mine ? "mine" : "", sans[i]);
    caption.append(i ? " " : "", span);
    i++;
    setTimeout(tick, LINE_DELAY);
  };
  setTimeout(tick, LINE_DELAY / 2);
}

function showWhy() {
  if (!current || !answered) return;
  const sans = sanFrom(new Chess(current.fen), fullLine);
  const info = isThemed() ? {} : { playedSan: current.played_san, drop: current.drop, tags: current.tags || [] };
  let sentences;
  try {
    sentences = explainLine(current.fen, sans, info);
  } catch (err) {
    sentences = ["No explanation is available for this position."];
  }
  $("why").replaceChildren(el("h3", "", `Why ${sans[0] || "this move"}?`), ...sentences.map((s) => el("p", "", s)));
  $("why").hidden = false;
  $("explain").hidden = true;
}

function showPuzzle(puzzle) {
  current = puzzle;
  answered = false;
  scored = false;
  hinted = false;
  outcome = null;
  playToken++;
  chess = new Chess(puzzle.fen);
  step = 0;
  buildLines(puzzle);
  startMove = isThemed() && puzzle.last_uci ? sq(puzzle.last_uci) : undefined;
  lastMove = startMove;
  const colour = colourOf(chess);

  $("review-line").hidden = isThemed();
  $("credit").hidden = !isThemed();
  say();
  $("why").hidden = true;
  for (const id of ["show-answer", "hint"]) {
    $(id).hidden = false;
    $(id).disabled = false;
  }
  for (const id of ["next", "play-line", "explain"]) $(id).hidden = true;

  setGood(false);
  board.set({ orientation: colour });
  board.setAutoShapes([]);
  setMovable(true);

  if (isThemed()) {
    $("prompt").textContent = `Themed puzzle: ${tagLabel(puzzle.tag)}. Find the best move.`;
    $("puzzle-meta").textContent = `Rating ${puzzle.rating} · you are ${colour}`;
    $("credit-link").href = `https://lichess.org/training/${encodeURIComponent(puzzle.id)}`;
  } else {
    $("prompt").textContent = `You played ${puzzle.played_san} here (${puzzle.class}). Find a better move.`;
    $("puzzle-meta").textContent =
      `${formatDate(puzzle.end_time * 1000)} · ${puzzle.time_class} · ${puzzle.opening_family} · ${puzzle.opening || "Unknown opening"} · you are ${colour}`;
    $("review-link").href = `review.html?id=${encodeURIComponent(puzzle.game_id)}&ply=${puzzle.ply}`;
  }
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
  for (const p of puzzles) {
    p.key = p.id;
    if (!phases.has(p.id)) phases.set(p.id, phaseOf(new Chess(p.fen)));
    p.phase = phases.get(p.id);
  }
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
  buildPhaseOptions();
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
    movable: { free: false, showDests: false, events: { after: onMove } },
  });

  $("show-answer").onclick = () => {
    if (current && !answered) finish(false);
  };
  $("hint").onclick = showHint;
  $("play-line").onclick = playLine;
  $("explain").onclick = showWhy;
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
      phase: $("filter-phase").value,
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
  $("filter-phase").onchange = onFilter;
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
