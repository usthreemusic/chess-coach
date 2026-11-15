// Fetch a player's games from chess.com, store them, and analyse them in the browser.
import { CONFIG, monthsBackFor, windowStart } from "./config.js";
import { normaliseGame } from "./normalise.js";
import { analyseGame } from "./analyse.js";
import { listArchives, fetchMonth } from "./chesscom.js";
import * as store from "./store.js";
import { createPool, defaultPoolSize } from "./engine.js";

const MONTH_DELAY_MS = 400;
const LOCK_NAME = "chess-coach-sync";
const CHANNEL = "chess-coach";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failedThisSession = new Set();   // "user:id" of games whose analysis threw

/** "YYYY-MM" of a month-archive URL, or null. */
export function monthOfUrl(url) {
  const m = /\/(\d{4})\/(\d{2})\/?$/.exec(String(url));
  return m && m[2] >= "01" && m[2] <= "12" ? m[1] + "-" + m[2] : null;
}

/** "YYYY-MM" of a Date in UTC, shifted by `delta` months. */
export function shiftMonth(date, delta) {
  const idx = date.getUTCFullYear() * 12 + date.getUTCMonth() + delta;
  return Math.floor(idx / 12) + "-" + String((idx % 12) + 1).padStart(2, "0");
}

/**
 * Pure month selection. archiveUrls: chess.com archive URLs; today: Date;
 * stored: Map (or object) month -> { complete }. Keeps the current month and
 * the (monthsBack - 1) before it; skips months stored as complete; always
 * includes the current month and any month not stored as complete (which
 * covers "stored before it had ended"). Returns [{ month, url }] oldest first.
 */
export function selectMonths(archiveUrls, today, stored, monthsBack = CONFIG.monthsBack) {
  const current = shiftMonth(today, 0);
  const cutoff = shiftMonth(today, -(monthsBack - 1));
  const get = (m) => (stored instanceof Map ? stored.get(m) : stored && stored[m]);
  const out = [];
  for (const url of archiveUrls) {
    const month = monthOfUrl(url);
    if (!month || month < cutoff || month > current) continue;
    const rec = get(month);
    if (month >= current || !rec || !rec.complete) out.push({ month, url });
  }
  out.sort((a, b) => (a.month < b.month ? -1 : 1));
  return out;
}

let channel = null;
function broadcast(msg) {
  try {
    if (typeof BroadcastChannel !== "undefined") {
      if (!channel) channel = new BroadcastChannel(CHANNEL);
      channel.postMessage(msg);
    }
  } catch (e) { /* ignore */ }
  try {
    if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
      window.dispatchEvent(new CustomEvent("coach-data", { detail: msg }));
    }
  } catch (e) { /* ignore */ }
}

let seedPromise = null;
function loadSeedUsername() {
  if (!seedPromise) {
    seedPromise = fetch("data/seed.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && typeof j.username === "string" ? j.username.toLowerCase() : null))
      .catch(() => null);
  }
  return seedPromise;
}

async function loadSeedAnalysis(id) {
  try {
    const r = await fetch("data/analysis/" + encodeURIComponent(id) + ".json");
    if (!r.ok) return null;
    const a = await r.json();
    if (!a || !Array.isArray(a.moves)) return null;
    return { ...a, id };
  } catch (e) { return null; }
}

function errorMessage(e, username) {
  if (e && e.code === "not_found") return username ? "No chess.com player called " + username : "Enter a chess.com username";
  if (e && e.code === "network") return e.message || "Could not reach chess.com";
  return "Something went wrong: " + (e && e.message ? e.message : String(e));
}

export function startSync(username, { onProgress } = {}) {
  const user = String(username || "").trim().toLowerCase();
  let stopped = false;
  let pool = null;
  const waiting = new AbortController(); // aborts a pending wait for the analysis lock
  const emit = (p) => { try { if (onProgress) onProgress(p); } catch (e) { console.error(e); } };

  async function fetchPhase() {
    const today = new Date();
    emit({ phase: "fetch", done: 0, total: 0, message: "Looking up " + user + " on chess.com" });
    const archives = await listArchives(user);
    const stored = await store.getMonths(user);
    const todo = selectMonths(archives, today, stored, monthsBackFor(user));
    const current = shiftMonth(today, 0);
    let done = 0;
    emit({ phase: "fetch", done, total: todo.length, message: todo.length ? "Fetching " + todo.length + " month(s) of games" : "Games are up to date" });
    for (const { month, url } of todo) {
      if (stopped) return;
      const raw = await fetchMonth(url);
      const games = raw.map((r) => { try { return normaliseGame(r, user); } catch (e) { return null; } }).filter(Boolean);
      if (games.length) await store.putGames(user, games);
      await store.putMonth(user, month, { complete: month < current, fetched: Date.now() });
      done++;
      broadcast({ type: "games", username: user });
      emit({ phase: "fetch", done, total: todo.length, message: "Fetched " + month + " (" + games.length + " games)" });
      if (done < todo.length) await sleep(MONTH_DELAY_MS);
    }
  }

  async function analysePhase() {
    const games = await store.getGames(user);
    const index = await store.getAnalysisIndex(user);
    const from = windowStart(monthsBackFor(user)); // older stored games are left alone
    const todo = games
      .filter((g) => {
        if (g.end_time < from) return false;
        const rec = index.get(g.id);
        return !(rec && rec.analysisVersion === CONFIG.analysisVersion) && !failedThisSession.has(user + ":" + g.id);
      })
      .sort((a, b) => b.end_time - a.end_time);
    const total = todo.length;
    let done = 0;
    if (!total) { emit({ phase: "analyse", done: 0, total: 0, message: "All games analysed" }); return; }
    emit({ phase: "analyse", done, total, message: "Analysing " + total + " game(s)" });

    const seedUser = await loadSeedUsername();
    const useSeed = seedUser === user;
    pool = createPool(defaultPoolSize());
    let next = 0;

    async function worker(slot) {
      const evaluate = pool.evaluatorFor(slot);
      while (!stopped && next < todo.length) {
        const game = todo[next++];
        try {
          let analysis = useSeed ? await loadSeedAnalysis(game.id) : null;
          if (!analysis) analysis = await analyseGame(game, evaluate, CONFIG);
          if (stopped) return;
          analysis = { ...analysis, id: game.id, analysisVersion: CONFIG.analysisVersion };
          await store.putAnalysis(user, analysis);
          broadcast({ type: "analysis", username: user, id: game.id });
        } catch (e) {
          if (stopped) return;
          console.error("Analysis failed for game " + game.id, e);
          failedThisSession.add(user + ":" + game.id);
        }
        done++;
        emit({ phase: "analyse", done, total, message: "Analysed " + done + " of " + total });
      }
    }

    try {
      await Promise.all(Array.from({ length: pool.size }, (_, i) => worker(i)));
    } finally {
      pool.terminate();
      pool = null;
    }
  }

  // Run fn while holding the global lock (one engine pool across all tabs). If another tab has it,
  // say so and wait our turn; stop() abandons the wait.
  async function withLock(fn) {
    const locks = typeof navigator !== "undefined" ? navigator.locks : null;
    if (!locks || !locks.request) return fn();
    let ran = false;
    await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      ran = true;
      await fn();
    });
    if (ran || stopped) return;
    emit({ phase: "busy", done: 0, total: 0, message: "Waiting for another tab to finish analysing" });
    try {
      await locks.request(LOCK_NAME, { signal: waiting.signal }, async () => { if (!stopped) await fn(); });
    } catch (e) {
      if (!(e && e.name === "AbortError" && waiting.signal.aborted)) throw e;
    }
  }

  async function run() {
    let fetched = false, fetchEnded = false;
    const syncMsg = (isDone, error) => broadcast({ type: "sync", username: user, fetched, done: isDone, error });
    const endFetch = (error) => { if (!fetchEnded) { fetchEnded = true; syncMsg(false, error); } };
    try {
      if (!user) { const e = new Error("Enter a chess.com username"); e.code = "not_found"; throw e; }
      let fetchError = null;
      try {
        await fetchPhase();
      } catch (e) {
        if (e && e.code === "not_found") throw e;
        console.error(e); // a failed month: still analyse the games already stored
        fetchError = e;
      }
      fetched = !fetchError && !stopped;
      const message = fetchError ? errorMessage(fetchError, user) : null;
      endFetch(message);
      if (!stopped) await withLock(analysePhase);
      if (stopped) emit({ phase: "done", done: 0, total: 0, message: "Stopped" });
      else if (fetchError) emit({ phase: "error", done: 0, total: 0, message, error: fetchError });
      else emit({ phase: "done", done: 0, total: 0, message: "Finished" });
      syncMsg(true, stopped ? null : message);
    } catch (e) {
      console.error(e);
      const message = errorMessage(e, user);
      endFetch(message);
      emit({ phase: "error", done: 0, total: 0, message, error: e });
      syncMsg(true, message);
    }
  }

  const done = run();
  return {
    done,
    stop() { stopped = true; waiting.abort(); if (pool) pool.terminate(); },
  };
}
