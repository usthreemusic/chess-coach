// Facade the pages use: reads the local store and derives the same shapes as the old data/*.json files.
import * as store from "./store.js";
import { buildPuzzles } from "./puzzles.js";
import { buildStats } from "./stats.js";
import { ratingBand, pickThemed } from "./themed.js";
import { monthsBackFor, setMonthsBackFor, windowStart } from "./config.js";

const USER_KEY = "chess-coach-user";
const CHANNEL = "chess-coach";

// The player is pinned per tab: read once, so another tab switching player cannot change this one.
const clean = (v) => (v ? v.trim().toLowerCase() || null : null);
function readStoredUser() {
  try { const v = clean(sessionStorage.getItem(USER_KEY)); if (v) return v; } catch (e) { /* no sessionStorage */ }
  try { return clean(localStorage.getItem(USER_KEY)); } catch (e) { return null; }
}
let pinned = readStoredUser();

export function currentUser() {
  return pinned;
}
export function setUser(name) {
  const v = String(name || "").trim().toLowerCase();
  if (v) {
    let saved = false;
    try { localStorage.setItem(USER_KEY, v); saved = true; } catch (e) { /* private mode */ }
    try { sessionStorage.setItem(USER_KEY, v); } catch (e) { /* no sessionStorage */ }
    if (saved) pinned = v; // callers detect blocked storage by checking currentUser() afterwards
  }
  invalidate();
  return v || null;
}
export function clearUser() {
  try { localStorage.removeItem(USER_KEY); } catch (e) { /* ignore */ }
  try { sessionStorage.removeItem(USER_KEY); } catch (e) { /* ignore */ }
  pinned = null;
  invalidate();
}

/** Months of games this player has chosen to look at (3, 6 or 12). */
export const monthsBack = () => monthsBackFor(currentUser());
export function setMonthsBack(months) {
  setMonthsBackFor(currentUser(), months);
  invalidate();
}
// Games older than the chosen window stay in storage but are not shown.
const inWindow = (user) => {
  const from = windowStart(monthsBackFor(user));
  return (g) => g.end_time >= from;
};

// ---- memoisation, keyed by username, cleared on any change ----
let cache = new Map();
function memo(key, fn) {
  const user = currentUser();
  const k = user + "|" + key;
  if (!cache.has(k)) {
    const p = fn(user);
    p.catch(() => { if (cache.get(k) === p) cache.delete(k); });
    cache.set(k, p);
  }
  return cache.get(k);
}
function invalidate() { cache = new Map(); }

const monthOf = (t) => new Date(t * 1000).toISOString().slice(0, 7);

export function loadGames() {
  return memo("games", async (user) => {
    if (!user) return { username: null, games: [] };
    const [all, index] = await Promise.all([store.getGames(user), store.getAnalysisIndex(user)]);
    const games = all.filter(inWindow(user)).map((g) => {
      const { pgn, ...rest } = g;
      const entry = { ...rest, month: monthOf(g.end_time) };
      const rec = index.get(g.id);
      if (rec && rec.counts) entry.mistakes = rec.counts;
      return entry;
    });
    return { username: user, games };
  });
}

export async function loadAnalysis(id) {
  const user = currentUser();
  if (!user) return null;
  return (await store.getAnalysis(user, id)) || null;
}

// Games (with pgn) paired with their analysis, oldest first.
function loadPairs() {
  return memo("pairs", async (user) => {
    if (!user) return [];
    const [games, analyses] = await Promise.all([store.getGames(user), store.getAnalyses(user)]);
    const pairs = [];
    for (const game of games.filter(inWindow(user))) {
      const analysis = analyses.get(game.id);
      if (analysis) pairs.push({ game, analysis });
    }
    return pairs;
  });
}

export function loadPuzzles() {
  return memo("puzzles", async () => {
    const pairs = await loadPairs();
    const puzzles = [];
    for (const { game, analysis } of pairs) {
      try { puzzles.push(...buildPuzzles(game, analysis)); }
      catch (e) { console.error("Skipping puzzles for game " + game.id, e); } // one unreadable analysis
    }
    puzzles.sort((a, b) => (a.end_time - b.end_time) || (a.ply - b.ply));
    return { puzzles };
  });
}

export function loadStats() {
  return memo("stats", async () => {
    const pairs = await loadPairs();
    return pairs.length ? buildStats(pairs) : null;
  });
}

export function loadThemed(total = 2000) {
  return memo("themed:" + total, async () => {
    const [{ games }, { puzzles: mine }] = await Promise.all([loadGames(), loadPuzzles()]);
    const band = ratingBand(games);
    const resp = await fetch("data/themed/" + band + ".json");
    if (!resp.ok) throw new Error("Could not load themed puzzles for band " + band + " (HTTP " + resp.status + ")");
    const pool = await resp.json();
    const tagCounts = {};
    for (const p of mine) for (const t of p.tags || []) if (t !== "other") tagCounts[t] = (tagCounts[t] || 0) + 1;
    return { source: pool.source, band: pool.band, puzzles: pickThemed(pool.puzzles, tagCounts, total) };
  });
}

// ---- change notification ----
let ownChannel = null;
try { if (typeof BroadcastChannel !== "undefined") ownChannel = new BroadcastChannel(CHANNEL); } catch (e) { ownChannel = null; }
const subscribers = new Set();

const syncStatuses = new Map(); // username -> latest { type: "sync" } message
const NO_SYNC = { fetched: false, done: false, error: null };

/** Latest sync status for the current player: { fetched, done, error }. */
export function syncStatus() {
  const m = pinned && syncStatuses.get(pinned);
  return m ? { fetched: Boolean(m.fetched), done: Boolean(m.done), error: m.error ?? null } : { ...NO_SYNC };
}

function onRaw(detail) {
  if (detail && detail.type === "sync" && typeof detail.username === "string") syncStatuses.set(detail.username, detail);
  // Messages about another player (another tab switched user) are not ours.
  if (detail && detail.username && detail.username !== pinned) return;
  invalidate();
  for (const s of subscribers) s(detail);
}
if (ownChannel) ownChannel.onmessage = (ev) => onRaw(ev.data);
if (typeof window !== "undefined") window.addEventListener("coach-data", (ev) => onRaw(ev.detail));

/** Subscribe to data changes (this page and other tabs). Returns unsubscribe. */
export function onDataChanged(callback) {
  // The same change can arrive twice in one page (window event + channel), so coalesce.
  let timer = null, last = null;
  const sub = (detail) => {
    last = detail;
    if (timer) return;
    timer = setTimeout(() => { timer = null; try { callback(last); } catch (e) { console.error(e); } }, 150);
  };
  subscribers.add(sub);
  return () => { subscribers.delete(sub); if (timer) { clearTimeout(timer); timer = null; } };
}
