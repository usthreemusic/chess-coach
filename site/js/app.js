// Shared app shell: username gate, player chip, sync status strip and refresh helper.
// Page scripts do `const user = await ready;` and simply never start while the gate is showing.
import { currentUser, setUser, clearUser, onDataChanged } from "./core/data.js";
import { startSync } from "./core/sync.js";

const USERNAME_RE = /^[a-z0-9_-]{3,25}$/;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let resolveReady;
/** Resolves to the username once one is set. Never resolves while the welcome panel is showing. */
export const ready = new Promise((resolve) => { resolveReady = resolve; });

/**
 * Call cb after stored data changes (this tab or another), at most once per minIntervalMs.
 * The first change fires promptly; changes arriving inside the interval collapse into one
 * trailing call. Returns an unsubscribe function.
 */
export function onRefresh(cb, minIntervalMs = 5000) {
  let last = 0;
  let timer = null;
  const run = () => {
    timer = null;
    last = Date.now();
    try {
      const r = cb();
      if (r && typeof r.catch === "function") r.catch((e) => console.error(e));
    } catch (e) { console.error(e); }
  };
  const off = onDataChanged(() => {
    if (timer) return;
    timer = setTimeout(run, Math.max(0, last + minIntervalMs - Date.now()));
  });
  return () => { off(); if (timer) { clearTimeout(timer); timer = null; } };
}

function switchPlayer() {
  clearUser();
  location.reload();
}

// ---- welcome panel ----
function showGate() {
  const main = document.querySelector("main");
  if (main) main.hidden = true;

  const wrap = el("main", "welcome-wrap");
  const panel = el("section", "welcome");
  panel.append(el("h2", "", "Welcome to Chess Coach"));
  panel.append(el("p", "", "Enter your chess.com username and Chess Coach will find your recent games, show where you went wrong and turn your mistakes into puzzles."));

  const form = el("form", "welcome-form");
  const label = el("label", "", "chess.com username");
  label.htmlFor = "username-input";
  const input = el("input");
  input.type = "text";
  input.id = "username-input";
  input.name = "username";
  input.required = true;
  input.maxLength = 40;
  input.autocomplete = "username";
  input.autocapitalize = "none";
  input.spellcheck = false;
  const submit = el("button", "", "Start");
  submit.type = "submit";
  const row = el("div", "welcome-row");
  row.append(input, submit);
  const error = el("p", "welcome-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  form.append(label, row, error);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = input.value.trim().toLowerCase();
    const fail = (msg) => { error.textContent = msg; error.hidden = false; input.focus(); };
    if (!USERNAME_RE.test(name)) return fail("Usernames are 3 to 25 characters: letters, digits, _ and -.");
    setUser(name);
    if (currentUser() !== name) return fail("Your browser is blocking site storage, so Chess Coach cannot remember you. Allow storage for this site and try again.");
    location.reload();
  });
  panel.append(form);
  panel.append(el("p", "welcome-note", "Privacy: your games come from chess.com's public records and are analysed inside this browser. Nothing is uploaded anywhere."));
  wrap.append(panel);
  (main || document.body).after(wrap);
  input.focus();
}

// ---- header chip ----
function addChip(user) {
  const header = document.querySelector("header");
  if (!header) return;
  const chip = el("div", "player-chip");
  chip.append(el("span", "player-name", "Player: " + user));
  const btn = el("button", "", "Switch player");
  btn.type = "button";
  btn.addEventListener("click", switchPlayer);
  chip.append(btn);
  const picker = header.querySelector(".theme-picker");
  if (picker) header.insertBefore(chip, picker); else header.append(chip);
}

// ---- sync status strip ----
function addStrip() {
  const strip = el("div");
  strip.id = "sync-status";
  strip.setAttribute("role", "status");
  strip.hidden = true;
  const header = document.querySelector("header");
  if (header) header.after(strip); else document.body.prepend(strip);
  return strip;
}

function runSync(user, strip) {
  let handle = null;
  let sawBusy = false;
  const text = el("span", "sync-text");
  const bar = el("progress");
  const action = el("button", "sync-action");
  action.type = "button";
  strip.replaceChildren(text, bar, action);

  const show = (message, { progress, button } = {}) => {
    strip.hidden = false;
    text.textContent = message;
    if (progress) { bar.hidden = false; bar.max = progress.total; bar.value = progress.done; } else bar.hidden = true;
    if (button) { action.hidden = false; action.textContent = button.label; action.onclick = button.run; } else { action.hidden = true; action.onclick = null; }
  };

  const onProgress = (p) => {
    if (p.phase === "fetch") {
      sawBusy = false;
      if (p.total > 0) show(`Fetching games… ${p.done} of ${p.total} months`, { progress: p });
      else show("Fetching games…");
    } else if (p.phase === "analyse") {
      if (p.total > 0) show(`Analysing games… ${p.done} of ${p.total}`, { progress: p });
      else strip.hidden = true;
    } else if (p.phase === "busy") {
      sawBusy = true;
      show("Analysing in another tab");
    } else if (p.phase === "done") {
      if (sawBusy) show("Analysing in another tab"); else strip.hidden = true;
    } else if (p.phase === "error") {
      const notFound = p.error && p.error.code === "not_found";
      if (notFound) show(p.message || "No chess.com player called " + user, { button: { label: "Try another name", run: switchPlayer } });
      else show(p.message || "Something went wrong", { button: { label: "Retry", run: start } });
    }
  };

  function start() {
    if (handle) handle.stop();
    sawBusy = false;
    show("Fetching games…");
    handle = startSync(user, { onProgress });
  }
  start();
  window.addEventListener("pagehide", () => { if (handle) handle.stop(); });
  // A page restored from the back/forward cache has a stopped sync: reload to start afresh.
  window.addEventListener("pageshow", (ev) => { if (ev.persisted) location.reload(); });
}

function init() {
  const user = currentUser();
  if (!user) return showGate();
  addChip(user);
  runSync(user, addStrip());
  resolveReady(user);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
