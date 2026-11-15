// Integration tests for site/js/core/data.js (memoised facade over store.js).
// Isolation: one IDBFactory and one instance of data.js/store.js for the whole file (they
// share state by design, data.js reads through the same store.js module); every test uses
// its own username, and setUser()/change events reset data.js's cache where a test needs it.
import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { core, createFetchStub, FakeBroadcastChannel, FakeStorage, tick, pad2 } from "./helpers.mjs";

const store = await core("store.js");
const data = await core("data.js");
const { windowStart } = await core("config.js");
const stub = createFetchStub();

let n = 0;
const newUser = (tag = "u") => `${tag}${++n}`;
beforeEach(() => { stub.reset(); localStorage.clear(); data.clearUser(); });

const game = (id, end_time, extra = {}) => ({
  id, end_time, url: "https://www.chess.com/game/live/" + id, time_class: "rapid", time_control: "600",
  colour: "white", result: "win", my_rating: 1234, opening: "Kings Pawn Opening", pgn: "1. e4 e5 *", ...extra,
});
// White blundered with f3 (best was e4) on ply 1.
const blunderAnalysis = (id, extra = {}) => ({
  id, depth: 12, start_cp: 20, analysisVersion: 1,
  moves: [
    { san: "f3", uci: "f2f3", best: "e4", best_uci: "e2e4", pv: ["e4", "e5"], cp: -300, class: "blunder", drop: 320 },
    { san: "e5", uci: "e7e5", cp: -280 },
  ],
  counts: { inaccuracy: 0, mistake: 0, blunder: 1 },
  ...extra,
});
const monthOfSeconds = (t) => { const d = new Date(t * 1000); return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1); };
const change = async (detail = { type: "games" }) => { new FakeBroadcastChannel("chess-coach").postMessage(detail); await tick(); };

// ---- user handling ----
test("currentUser is null until a user is set; setUser trims and lower-cases", () => {
  assert.equal(data.currentUser(), null);
  assert.equal(data.setUser("  MagnusCarlsen "), "magnuscarlsen");
  assert.equal(data.currentUser(), "magnuscarlsen");
  assert.equal(localStorage.getItem("chess-coach-user"), "magnuscarlsen");
});

test("a fresh page normalises whatever is in localStorage, and blank means no user", async () => {
  localStorage.setItem("chess-coach-user", "  BoB ");
  assert.equal((await core("data.js", { fresh: true })).currentUser(), "bob");
  localStorage.setItem("chess-coach-user", "   ");
  assert.equal((await core("data.js", { fresh: true })).currentUser(), null);
});

test("the player is pinned: another tab changing localStorage does not change this tab's user", () => {
  data.setUser("alice");
  localStorage.setItem("chess-coach-user", "bob"); // a second tab switched player
  assert.equal(data.currentUser(), "alice");
  localStorage.removeItem("chess-coach-user");
  assert.equal(data.currentUser(), "alice");
});

test("a fresh page pins from sessionStorage first, then localStorage", async () => {
  localStorage.setItem("chess-coach-user", "local");
  globalThis.sessionStorage = new FakeStorage();
  try {
    assert.equal((await core("data.js", { fresh: true })).currentUser(), "local", "falls back to localStorage");
    sessionStorage.setItem("chess-coach-user", "Tabuser");
    assert.equal((await core("data.js", { fresh: true })).currentUser(), "tabuser");
    // setUser and clearUser keep both stores in step
    const fresh = await core("data.js", { fresh: true });
    fresh.setUser("zed");
    assert.equal(sessionStorage.getItem("chess-coach-user"), "zed");
    assert.equal(localStorage.getItem("chess-coach-user"), "zed");
    fresh.clearUser();
    assert.equal(sessionStorage.getItem("chess-coach-user"), null);
    assert.equal(localStorage.getItem("chess-coach-user"), null);
    assert.equal(fresh.currentUser(), null);
  } finally { delete globalThis.sessionStorage; }
});

test("setUser does not pin the name when the localStorage write fails (blocked storage is detectable)", () => {
  data.setUser("kept");
  const real = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() { throw new Error("blocked"); }, removeItem() {} };
  try {
    assert.equal(data.setUser("blocked"), "blocked");
    assert.notEqual(data.currentUser(), "blocked");
    assert.equal(data.currentUser(), "kept");
  } finally { globalThis.localStorage = real; }
});

test("a throwing or missing sessionStorage does not break setUser/clearUser", () => {
  globalThis.sessionStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  try {
    assert.equal(data.setUser("sess"), "sess");
    assert.equal(data.currentUser(), "sess");
    data.clearUser();
    assert.equal(data.currentUser(), null);
  } finally { delete globalThis.sessionStorage; }
});

test("setUser with a blank name returns null and does not store anything", () => {
  assert.equal(data.setUser("   "), null);
  assert.equal(data.setUser(null), null);
  assert.equal(data.currentUser(), null);
});

test("clearUser forgets the user", () => {
  data.setUser("alice");
  data.clearUser();
  assert.equal(data.currentUser(), null);
  assert.equal(localStorage.getItem("chess-coach-user"), null);
});

test("with no user, loaders return empty results without touching the store", async () => {
  assert.deepEqual(await data.loadGames(), { username: null, games: [] });
  assert.deepEqual(await data.loadPuzzles(), { puzzles: [] });
  assert.equal(await data.loadStats(), null);
  assert.equal(await data.loadAnalysis("x"), null);
});

// ---- loadGames ----
test("loadGames keeps only games inside the months window and shapes them for the UI", async () => {
  const user = newUser();
  const from = windowStart(3);
  await store.putGames(user, [
    game("outside", from - 1),        // last second before the window
    game("edge", from),               // first second of the window
    game("inside", from + 86400 * 5),
  ]);
  data.setUser(user);
  const { username, games } = await data.loadGames();
  assert.equal(username, user);
  assert.deepEqual(games.map((g) => g.id), ["edge", "inside"]);
  for (const g of games) {
    assert.ok(!("pgn" in g), "pgn stripped");
    assert.ok(!("username" in g));
    assert.equal(g.month, monthOfSeconds(g.end_time));
  }
  // the edge game is 00:00:00 UTC on the 1st of the window's first month
  assert.match(games[0].month, /^\d{4}-\d{2}$/);
  assert.equal(games[0].month, monthOfSeconds(from));
  assert.notEqual(monthOfSeconds(from - 1), games[0].month);
});

test("loadGames attaches mistakes only for analysed games", async () => {
  const user = newUser();
  const t = windowStart(3) + 1000;
  await store.putGames(user, [game("a", t), game("b", t + 1), game("c", t + 2)]);
  await store.putAnalysis(user, blunderAnalysis("a"));
  await store.putAnalysis(user, { id: "c", moves: [], analysisVersion: 1 }); // analysed, but no counts recorded
  data.setUser(user);
  const { games } = await data.loadGames();
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  assert.deepEqual(byId.a.mistakes, { inaccuracy: 0, mistake: 0, blunder: 1 });
  assert.ok(!("mistakes" in byId.b));
  assert.ok(!("mistakes" in byId.c));
});

test("setMonthsBack widens the window and invalidates the cache", async () => {
  const user = newUser();
  const old = windowStart(6) + 3600; // inside 6 months, outside 3
  await store.putGames(user, [game("recent", windowStart(3) + 10), game("older", old)]);
  data.setUser(user);
  assert.equal(data.monthsBack(), 3);
  const before = data.loadGames();
  assert.deepEqual((await before).games.map((g) => g.id), ["recent"]);
  assert.equal(data.loadGames(), before, "memoised until something changes");

  data.setMonthsBack(6);
  assert.equal(data.monthsBack(), 6);
  const after = data.loadGames();
  assert.notEqual(after, before);
  assert.deepEqual((await after).games.map((g) => g.id), ["older", "recent"]);

  data.setMonthsBack(3);
  assert.deepEqual((await data.loadGames()).games.map((g) => g.id), ["recent"]);
});

test("an unsupported months choice is ignored and the default window applies", async () => {
  const user = newUser();
  data.setUser(user);
  data.setMonthsBack(5);
  assert.equal(data.monthsBack(), 3);
});

test("the months choice is remembered per player", () => {
  const a = newUser(), b = newUser();
  data.setUser(a); data.setMonthsBack(12);
  data.setUser(b);
  assert.equal(data.monthsBack(), 3);
  data.setUser(a);
  assert.equal(data.monthsBack(), 12);
});

// ---- puzzles and stats ----
test("loadPuzzles derives puzzles from stored game/analysis pairs", async () => {
  const user = newUser();
  const t = windowStart(3) + 5000;
  await store.putGames(user, [game("g1", t), game("g2", t + 10)]);
  await store.putAnalysis(user, blunderAnalysis("g1")); // g2 stays unanalysed
  data.setUser(user);
  const { puzzles } = await data.loadPuzzles();
  assert.equal(puzzles.length, 1);
  const p = puzzles[0];
  assert.equal(p.id, "g1:1");
  assert.equal(p.game_id, "g1");
  assert.equal(p.ply, 1);
  assert.equal(p.best_uci, "e2e4");
  assert.equal(p.class, "blunder");
  assert.equal(p.played_san, "f3");
  assert.equal(p.end_time, t);
  assert.equal(p.fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
});

test("loadPuzzles skips a game whose analysis cannot be read instead of failing the whole list", async () => {
  const user = newUser();
  const t = windowStart(3) + 5000;
  await store.putGames(user, [game("good", t), game("bad", t + 10)]);
  await store.putAnalysis(user, blunderAnalysis("good"));
  await store.putAnalysis(user, { id: "bad", analysisVersion: 1, moves: null, counts: {} });
  data.setUser(user);
  const err = mock.method(console, "error", () => {});
  try {
    const { puzzles } = await data.loadPuzzles();
    assert.deepEqual(puzzles.map((p) => p.id), ["good:1"]);
    assert.equal(err.mock.callCount(), 1);
  } finally { err.mock.restore(); }
});

test("loadPuzzles ignores analyses of games outside the window", async () => {
  const user = newUser();
  await store.putGames(user, [game("old", windowStart(3) - 100)]);
  await store.putAnalysis(user, blunderAnalysis("old"));
  data.setUser(user);
  assert.deepEqual((await data.loadPuzzles()).puzzles, []);
});

test("loadStats is null when nothing is analysed, an aggregate when something is", async () => {
  const user = newUser();
  const t = windowStart(3) + 5000;
  await store.putGames(user, [game("g1", t)]);
  data.setUser(user);
  assert.equal(await data.loadStats(), null);

  await store.putAnalysis(user, blunderAnalysis("g1"));
  await change(); // tell data.js the store changed
  const stats = await data.loadStats();
  assert.notEqual(stats, null);
  assert.equal(stats.games, 1);
  assert.equal(stats.moves, 1); // only my (white) moves count: f3 of the two plies
});

// ---- memoisation ----
test("results are memoised (same promise) until a change event, then recomputed", async () => {
  const user = newUser();
  const t = windowStart(3) + 100;
  await store.putGames(user, [game("g1", t)]);
  data.setUser(user);
  const first = data.loadGames();
  assert.equal(data.loadGames(), first);
  assert.equal(data.loadPuzzles(), data.loadPuzzles());
  assert.equal(data.loadStats(), data.loadStats());

  await store.putGames(user, [game("g2", t + 1)]);
  assert.equal((await data.loadGames()).games.length, 1, "stale until told about the change");

  await change({ type: "games", username: user });
  const second = data.loadGames();
  assert.notEqual(second, first);
  assert.equal((await second).games.length, 2);
});

test("a rejected load is not cached, so the next call can succeed", async () => {
  const user = newUser();
  await store.putGames(user, [game("g1", windowStart(3) + 10)]);
  data.setUser(user);
  // no themed file for the band yet: 404
  const failed = data.loadThemed(4);
  await assert.rejects(failed, /HTTP 404/);
  assert.notEqual(data.loadThemed(4), failed, "the failed promise was dropped from the cache");
  stub.themed["1400"] = { source: "test", band: 1400, puzzles: { fork: [{ id: "f1", tag: "fork" }] } };
  const ok = await data.loadThemed(4);
  assert.equal(ok.band, 1400);
});

test("switching user returns the other user's data, never a stale cache", async () => {
  const a = newUser("a"), b = newUser("b");
  const t = windowStart(3) + 50;
  await store.putGames(a, [game("ga", t)]);
  await store.putGames(b, [game("gb1", t), game("gb2", t + 1)]);
  data.setUser(a);
  assert.deepEqual((await data.loadGames()).games.map((g) => g.id), ["ga"]);
  data.setUser(b);
  const rb = await data.loadGames();
  assert.equal(rb.username, b);
  assert.deepEqual(rb.games.map((g) => g.id), ["gb1", "gb2"]);
  data.setUser(a);
  assert.deepEqual((await data.loadGames()).games.map((g) => g.id), ["ga"]);
  data.clearUser();
  assert.deepEqual(await data.loadGames(), { username: null, games: [] });
});

test("loadAnalysis reads the current user's stored analysis", async () => {
  const a = newUser(), b = newUser();
  await store.putAnalysis(a, blunderAnalysis("g1"));
  data.setUser(b);
  assert.equal(await data.loadAnalysis("g1"), null);
  data.setUser(a);
  assert.equal((await data.loadAnalysis("g1")).id, "g1");
  assert.equal(await data.loadAnalysis("missing"), null);
});

// ---- change notification ----
test("onDataChanged coalesces a burst of change events into one callback; unsubscribe stops it", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const seen = [];
    const off = data.onDataChanged((d) => seen.push(d));
    for (let i = 0; i < 5; i++) new FakeBroadcastChannel("chess-coach").postMessage({ type: "games", i });
    await tick();
    assert.equal(seen.length, 0, "nothing before the debounce elapses");
    mock.timers.tick(149);
    assert.equal(seen.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(seen, [{ type: "games", i: 4 }], "one callback, with the latest detail");

    // a later burst fires again
    new FakeBroadcastChannel("chess-coach").postMessage({ type: "analysis" });
    await tick();
    mock.timers.tick(150);
    assert.equal(seen.length, 2);

    // unsubscribe while a callback is pending cancels it, and later events are ignored
    new FakeBroadcastChannel("chess-coach").postMessage({ type: "games" });
    await tick();
    off();
    mock.timers.tick(1000);
    new FakeBroadcastChannel("chess-coach").postMessage({ type: "games" });
    await tick();
    mock.timers.tick(1000);
    assert.equal(seen.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("messages about another player are ignored: no invalidation and no subscriber call", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const user = newUser();
    data.setUser(user);
    const first = data.loadGames();
    const seen = [];
    const off = data.onDataChanged((d) => seen.push(d));
    new FakeBroadcastChannel("chess-coach").postMessage({ type: "games", username: "someone-else" });
    new FakeBroadcastChannel("chess-coach").postMessage({ type: "analysis", username: "someone-else", id: "x" });
    await tick();
    mock.timers.tick(1000);
    assert.equal(seen.length, 0);
    assert.equal(data.loadGames(), first, "cache kept");
    // messages for this player (or with no player) still go through
    new FakeBroadcastChannel("chess-coach").postMessage({ type: "games", username: user });
    await tick();
    mock.timers.tick(150);
    assert.equal(seen.length, 1);
    assert.notEqual(data.loadGames(), first, "cache dropped");
    new FakeBroadcastChannel("chess-coach").postMessage({ type: "other" });
    await tick();
    mock.timers.tick(150);
    assert.equal(seen.length, 2);
    off();
  } finally { mock.timers.reset(); }
});

test("syncStatus reports the latest sync message for the current player only", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const user = newUser();
    data.setUser(user);
    assert.deepEqual(data.syncStatus(), { fetched: false, done: false, error: null });
    const seen = [];
    const off = data.onDataChanged((d) => seen.push(d));
    const post = async (m) => { new FakeBroadcastChannel("chess-coach").postMessage(m); await tick(); };
    await post({ type: "sync", username: user, fetched: true, done: false, error: null });
    assert.deepEqual(data.syncStatus(), { fetched: true, done: false, error: null });
    await post({ type: "sync", username: "someone-else", fetched: true, done: true, error: null });
    assert.deepEqual(data.syncStatus(), { fetched: true, done: false, error: null });
    await post({ type: "sync", username: user, fetched: false, done: true, error: "chess.com did not respond" });
    assert.deepEqual(data.syncStatus(), { fetched: false, done: true, error: "chess.com did not respond" });
    mock.timers.tick(150);
    assert.equal(seen.length, 1, "subscribers are notified (coalesced)");
    assert.equal(seen[0].type, "sync");
    off();
    // switching player: status of the new player, defaults when none was seen
    data.setUser(newUser());
    assert.deepEqual(data.syncStatus(), { fetched: false, done: false, error: null });
  } finally { mock.timers.reset(); }
});

test("each subscriber gets its own coalesced callback; a throwing callback does not break the others", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const err = mock.method(console, "error", () => {});
  try {
    let a = 0, b = 0;
    const offA = data.onDataChanged(() => { a++; throw new Error("boom"); });
    const offB = data.onDataChanged(() => { b++; });
    new FakeBroadcastChannel("chess-coach").postMessage({ type: "games" });
    new FakeBroadcastChannel("chess-coach").postMessage({ type: "games" });
    await tick();
    mock.timers.tick(150);
    assert.deepEqual([a, b], [1, 1]);
    assert.equal(err.mock.callCount(), 1);
    offA(); offB();
  } finally {
    err.mock.restore();
    mock.timers.reset();
  }
});

// ---- themed puzzles ----
test("loadThemed picks the band file from the player's rating", async () => {
  const user = newUser();
  // (1234 + 300) = 1534 -> rounded down to a multiple of 200 = 1400
  await store.putGames(user, [game("g1", windowStart(3) + 10, { my_rating: 1234 })]);
  stub.themed["1400"] = {
    source: "Lichess test pool", band: 1400,
    puzzles: { fork: [{ id: "f1", tag: "fork" }, { id: "f2", tag: "fork" }, { id: "f3", tag: "fork" }], pin: [{ id: "p1", tag: "pin" }, { id: "p2", tag: "pin" }, { id: "p3", tag: "pin" }] },
  };
  data.setUser(user);
  const res = await data.loadThemed(4);
  assert.ok(stub.calls.includes("data/themed/1400.json"));
  assert.ok(!stub.calls.some((u) => u.startsWith("data/themed/") && u !== "data/themed/1400.json"));
  assert.equal(res.source, "Lichess test pool");
  assert.equal(res.band, 1400);
  assert.equal(res.puzzles.length, 4);
  assert.deepEqual(new Set(res.puzzles.map((p) => p.tag)), new Set(["fork", "pin"]));
});

test("loadThemed defaults to the 1000 band with no games and clamps very high ratings to 1800", async () => {
  const none = newUser(), strong = newUser();
  await store.putGames(strong, [game("s1", windowStart(3) + 10, { my_rating: 2600 })]);
  stub.themed["1000"] = { source: "s", band: 1000, puzzles: { fork: [{ id: "a", tag: "fork" }] } };
  stub.themed["1800"] = { source: "s", band: 1800, puzzles: { fork: [{ id: "b", tag: "fork" }] } };
  data.setUser(none);
  assert.equal((await data.loadThemed(2)).band, 1000);
  data.setUser(strong);
  assert.equal((await data.loadThemed(2)).band, 1800);
});

test("loadThemed rejects with a clear error on HTTP 404", async () => {
  const user = newUser();
  await store.putGames(user, [game("g1", windowStart(3) + 10, { my_rating: 1234 })]);
  data.setUser(user);
  await assert.rejects(data.loadThemed(), (e) => {
    assert.match(e.message, /Could not load themed puzzles for band 1400 \(HTTP 404\)/);
    return true;
  });
});

test("no unexpected network requests were made", () => {
  assert.deepEqual(stub.unexpected, []);
});
