// The coach as a floating chat bubble on every page. Minimised to a round launcher by default; opened, it
// tells the coach's note one message at a time and shows the positions it is talking about on a small board.
// The words come from core/coachscript.js (pure, tested); this file only draws them and keeps the state.
import { Chessground } from "../vendor/chessground.min.js";
import { ready, onRefresh } from "./app.js";
import { loadGames, loadPuzzles, loadPairs } from "./core/data.js";
import { buildCoach } from "./core/coach.js";
import { findPatterns, pickForCoach } from "./core/patterns.js";
import { buildScript } from "./core/coachscript.js";

const TYPING_MS = 450;
const MAX_BOARDS = 4; // the script has at most three boards, but never keep more than this many alive
const SVG = "http://www.w3.org/2000/svg";

const focusKey = (user) => `chess-coach-focus:${user}`;
const seenKey = (user) => `chess-coach-seen:${user}`;

function readFocus(user) {
  try {
    const v = JSON.parse(localStorage.getItem(focusKey(user)));
    return v && typeof v.tag === "string" && Number.isFinite(v.since) ? { tag: v.tag, since: v.since } : null;
  } catch (e) { return null; }
}
function saveFocus(user, focus) {
  try { localStorage.setItem(focusKey(user), JSON.stringify({ tag: focus.tag, since: focus.since })); } catch (e) { /* private mode */ }
}
function readSeen(user) {
  try { return localStorage.getItem(seenKey(user)) || ""; } catch (e) { return ""; }
}
function saveSeen(user, value) {
  try { localStorage.setItem(seenKey(user), value); } catch (e) { /* private mode */ }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launcherIcon() {
  // A speech bubble with three dots
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "28");
  svg.setAttribute("height", "28");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const bubble = document.createElementNS(SVG, "path");
  bubble.setAttribute("d", "M5 3h14a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-8l-5 4v-4H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z");
  bubble.setAttribute("fill", "none");
  bubble.setAttribute("stroke", "currentColor");
  bubble.setAttribute("stroke-width", "2");
  bubble.setAttribute("stroke-linejoin", "round");
  svg.append(bubble);
  for (const x of [8, 12, 16]) {
    const dot = document.createElementNS(SVG, "circle");
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", "10.5");
    dot.setAttribute("r", "1.4");
    dot.setAttribute("fill", "currentColor");
    svg.append(dot);
  }
  return svg;
}

async function init() {
  const user = await ready;
  if (!user || document.getElementById("coach-launcher")) return;

  // ---- state ----
  let data = null; // { note, games, puzzles } once loaded
  let dataPromise = null;
  let picked = null; // pickForCoach(...) once the habits are worked out
  let habits = "idle"; // "idle" | "loading" | "done"
  let patternsFor = { pairs: null, result: null };
  let script = [];
  let revealed = 0; // messages on screen
  let busy = false; // a message is being "typed"
  let hungry = false; // reader reached the last available message while the habits were still loading
  let opened = false; // has been opened on this page
  let open = false;
  const boards = []; // live Chessground instances, oldest first: { api, holder }

  // ---- DOM ----
  const launcher = el("button", "coach-launcher");
  launcher.type = "button";
  launcher.id = "coach-launcher";
  launcher.setAttribute("aria-label", "Open coach");
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "coach-chat");
  launcher.append(launcherIcon());
  const badge = el("span", "coach-badge");
  badge.hidden = true;
  badge.setAttribute("aria-hidden", "true");
  launcher.append(badge);

  const panel = el("section", "coach-chat");
  panel.id = "coach-chat";
  panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Coach");
  const head = el("header", "coach-head");
  head.append(el("h2", "coach-title", "Coach"));
  const minimise = el("button", "coach-minimise", "−");
  minimise.type = "button";
  minimise.setAttribute("aria-label", "Minimise coach");
  head.append(minimise);
  const log = el("div", "coach-log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  const actions = el("div", "coach-actions");
  const progress = el("span", "coach-progress");
  const next = el("button", "coach-primary", "Next");
  next.type = "button";
  const again = el("button", "coach-primary", "Start again");
  again.type = "button";
  const train = el("a", "button-link coach-train", "Train this");
  actions.append(progress, next, again, train);
  panel.append(head, log, actions);
  document.body.append(launcher, panel);

  // ---- data ----
  function loadData() {
    if (!dataPromise) {
      dataPromise = (async () => {
        const [{ games }, { puzzles }] = await Promise.all([loadGames(), loadPuzzles()]);
        const prev = readFocus(user);
        const note = buildCoach(games, puzzles, { previousFocus: prev });
        // The weekly focus is remembered so it stays the same for a week (buildCoach keeps it while it still applies).
        if (note && (!prev || prev.tag !== note.focus.tag || prev.since !== note.focus.since)) saveFocus(user, note.focus);
        return { note, games, puzzles };
      })();
      dataPromise.catch(() => { dataPromise = null; });
    }
    return dataPromise;
  }

  // Habits replay up to 60 games, so they are worked out once per set of data (loadPairs hands back the same
  // array until the data changes) and only when the panel has been opened.
  async function loadHabits() {
    habits = "loading";
    try {
      await wait(0); // let the first message paint before the replay blocks the page
      const pairs = await loadPairs();
      if (patternsFor.pairs !== pairs) patternsFor = { pairs, result: findPatterns(pairs) };
      picked = pickForCoach(patternsFor.result);
    } catch (err) {
      console.error(err);
      picked = { bad: [], good: null, headline: null }; // no habits: the note still ends with the trends
    }
    habits = "done";
    rebuildScript();
    if (open) markSeen();
    if (hungry) { hungry = false; step(); } else updateActions();
  }

  const base = () => (data && data.note ? `${data.note.focus.tag}|${data.note.focus.since}` : null);
  function signature() {
    const b = base();
    if (!b) return null;
    return picked && picked.headline ? `${b}|${picked.headline.id}` : b;
  }
  // The badge only looks at tag and week: the headline habit is not known before the first opening.
  function updateBadge() {
    const b = base();
    const seen = readSeen(user);
    badge.hidden = !b || open || seen === b || seen.startsWith(b + "|");
  }
  function markSeen() {
    const s = signature();
    if (s) saveSeen(user, s);
    updateBadge();
  }

  function rebuildScript() {
    if (!data) return;
    script = buildScript(data.note, picked, data.puzzles, data.games);
  }

  // ---- boards ----
  const refreshBoards = () => { if (open) for (const b of boards) b.api.redrawAll(); };

  function drawExample(block, i) {
    const { api, examples, caption, link, count } = block;
    const ex = examples[i];
    const shapes = [];
    if (ex.played) shapes.push({ orig: ex.played.slice(0, 2), dest: ex.played.slice(2, 4), brush: "red" });
    if (ex.best) shapes.push({ orig: ex.best.slice(0, 2), dest: ex.best.slice(2, 4), brush: "green" });
    api.set({ fen: ex.fen, orientation: ex.orientation, lastMove: undefined });
    api.setAutoShapes(shapes);
    caption.textContent = ex.caption;
    link.href = ex.reviewUrl;
    if (count) count.textContent = `${i + 1} of ${examples.length}`;
  }

  // One board per message that has examples, so at most three exist; if the script ever grows, the oldest
  // is destroyed (its caption and link stay) rather than keeping many Chessground instances alive.
  function addExamples(msg, examples) {
    const holder = el("div", "coach-example");
    const wrap = el("div", "coach-board-wrap");
    const boardEl = el("div", "coach-board");
    wrap.append(boardEl);
    const caption = el("p", "coach-caption");
    const row = el("div", "coach-example-row");
    const link = el("a", "coach-review", "Open in Review");
    let count = null, cycle = null;
    if (examples.length > 1) {
      cycle = el("button", "coach-another", "Another example");
      cycle.type = "button";
      count = el("span", "coach-count");
      row.append(cycle, count);
    }
    row.append(link);
    holder.append(wrap, caption, row);
    msg.append(holder);

    const api = Chessground(boardEl, {
      fen: examples[0].fen,
      orientation: examples[0].orientation,
      viewOnly: true,
      coordinates: false,
      animation: { enabled: false },
      drawable: { enabled: false, visible: true },
    });
    const block = { api, holder, wrap, examples, caption, link, count };
    let at = 0;
    if (cycle) cycle.addEventListener("click", () => { at = (at + 1) % examples.length; drawExample(block, at); });
    drawExample(block, 0);
    boards.push(block);
    while (boards.length > MAX_BOARDS) {
      const old = boards.shift();
      old.api.destroy();
      old.wrap.remove();
    }
  }

  // ---- log ----
  function scrollToNewest(node) {
    // A tall message (text plus board) is scrolled to its top, so the reader starts at the first line.
    const tall = node.offsetHeight > log.clientHeight;
    log.scrollTop = tall ? Math.max(0, node.offsetTop - 8) : log.scrollHeight;
  }

  function appendMessage(m) {
    const msg = el("div", "coach-msg");
    for (const text of m.paragraphs) msg.append(el("p", "", text));
    log.append(msg);
    if (m.examples.length) {
      try { addExamples(msg, m.examples); } catch (err) { console.error(err); }
    }
    scrollToNewest(msg);
  }

  function appendPlain(text) {
    const msg = el("div", "coach-msg", "");
    msg.append(el("p", "", text));
    log.append(msg);
    return msg;
  }

  function typing() {
    const t = el("div", "coach-msg coach-typing");
    t.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) t.append(el("span", "coach-dot"));
    log.append(t);
    log.scrollTop = log.scrollHeight;
    return t;
  }

  const finished = () => data && revealed >= script.length && (!data.note || habits === "done");

  function updateActions() {
    const hasNote = data && data.note;
    progress.hidden = !hasNote;
    if (hasNote) progress.textContent = `${Math.min(revealed, script.length)} of ${script.length}${habits === "done" ? "" : "+"}`;
    const end = finished();
    const hadFocus = document.activeElement === next;
    next.hidden = !hasNote || end;
    // aria-disabled, not disabled: a disabled button drops keyboard focus while a message is being typed
    next.setAttribute("aria-disabled", String(busy || revealed === 0));
    again.hidden = !(hasNote && end);
    train.hidden = !(hasNote && end && data.note.focus.tag !== "other");
    if (!train.hidden) train.href = `train.html?tag=${encodeURIComponent(data.note.focus.tag)}`;
    actions.hidden = !hasNote;
    if (hadFocus && next.hidden) (again.hidden ? panel : again).focus({ preventScroll: true });
  }

  // Reveal the next message after a short "typing" pause.
  async function step() {
    if (busy || revealed === 0) return;
    if (revealed >= script.length) {
      // Reached the end of what is known: the habits are still being worked out, show typing until they arrive.
      if (habits !== "done") {
        hungry = true;
        if (!log.querySelector(".coach-typing")) typing();
      }
      updateActions();
      return;
    }
    busy = true;
    updateActions();
    const dots = log.querySelector(".coach-typing") || typing();
    if (!reducedMotion()) await wait(TYPING_MS);
    dots.remove();
    appendMessage(script[revealed]);
    revealed++;
    busy = false;
    updateActions();
  }

  function restart() {
    for (const b of boards.splice(0)) b.api.destroy();
    log.replaceChildren();
    revealed = 0;
    hungry = false;
    busy = false;
    start();
  }

  async function start() {
    if (!data) {
      log.replaceChildren();
      const loading = appendPlain("Looking through your games…");
      updateActions();
      try {
        data = await loadData();
      } catch (err) {
        console.error(err);
        loading.replaceChildren(el("p", "", "I could not read your games from this browser's storage."));
        opened = false; // the next opening tries again
        return;
      }
      loading.remove();
      rebuildScript();
      updateBadge();
    } else if (!script.length) rebuildScript();
    if (data.note && habits === "idle") loadHabits();
    if (!data.note) {
      appendMessage(script[0]);
      revealed = 1;
      updateActions();
      return;
    }
    // The first message is shown straight away; the typing pause is for the ones after it.
    appendMessage(script[0]);
    revealed = 1;
    updateActions();
    if (open) next.focus({ preventScroll: true });
  }

  // ---- open / close ----
  function setOpen(value) {
    open = value;
    panel.hidden = !value;
    launcher.hidden = value;
    launcher.setAttribute("aria-expanded", String(value));
    if (value) {
      panel.focus({ preventScroll: true });
      refreshBoards();
      log.scrollTop = log.scrollHeight;
      if (!opened) { opened = true; start(); }
      markSeen();
    } else {
      launcher.focus({ preventScroll: true });
      updateBadge();
    }
  }

  launcher.addEventListener("click", () => setOpen(true));
  minimise.addEventListener("click", () => setOpen(false));
  next.addEventListener("click", step);
  again.addEventListener("click", restart);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && open) setOpen(false); });

  // Chessground caches where the board sits on the page: refresh it when the layout moves.
  window.addEventListener("themechange", refreshBoards);
  window.addEventListener("resize", refreshBoards);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(refreshBoards).observe(panel);

  // ---- badge, and updates when data changes ----
  try {
    data = await loadData();
    updateBadge();
  } catch (err) { console.error(err); }

  onRefresh(async () => {
    dataPromise = null;
    const wasWaiting = data && !data.note;
    data = await loadData();
    updateBadge();
    if (!opened) return;
    patternsFor = { pairs: null, result: null };
    if (data.note) {
      habits = "loading";
      loadHabits();
    } else { habits = "idle"; picked = null; }
    rebuildScript();
    // Messages already on screen stay as they are; only what comes next uses the new data.
    if (wasWaiting && data.note) restart();
    else updateActions();
  });
}

init().catch((err) => console.error(err));
