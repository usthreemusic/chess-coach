// Integration tests for site/js/core/sync.js against fake-indexeddb, a stubbed chess.com,
// a fake navigator.locks and a fake UCI Worker.
// Isolation: one IDBFactory for the file with a different username per test, and a fresh
// instance of sync.js per test (cache-busting import) because sync.js keeps module state
// (failedThisSession, the memoised seed.json lookup, its BroadcastChannel). store.js,
// engine.js etc. are shared instances.
import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  core, createFetchStub, FakeWorker, FakeBroadcastChannel, locks, fakeNavigator, monthStr, timeIn, rawGame,
  pgnOf, tick, SCHOLARS, QUIET, ILLEGAL,
} from "./helpers.mjs";

const store = await core("store.js");
const { CONFIG } = await core("config.js");
const stub = createFetchStub();
const freshSync = () => core("sync.js", { fresh: true });

let n = 0;
const newUser = () => `player${++n}`;
beforeEach(() => {
  stub.reset(); FakeWorker.reset(); locks.held.clear(); locks.calls.length = 0; locks.waiters.length = 0;
  fakeNavigator.locks = locks;
});

/** Run startSync to completion, returning every progress event. */
async function runSync(sync, user, hooks = {}) {
  const events = [];
  let handle = null; // the first progress event fires synchronously, before startSync returns
  handle = sync.startSync(user, { onProgress: (p) => { events.push(p); if (handle && hooks.onProgress) hooks.onProgress(p, handle); } });
  await handle.done;
  return events;
}
const phases = (events) => events.filter((e, i) => i === 0 || e.phase !== events[i - 1].phase).map((e) => e.phase);
const last = (arr) => arr[arr.length - 1];

/** Stub a player with the given { "YYYY-MM": [raw games] } map. */
function player(user, months, status) { stub.players[user] = { months, status }; return stub.players[user]; }
const ids = (games) => games.map((g) => g.id).sort();

test("happy path: 5 archives, 3 in the window; fetch -> analyse -> done; everything stored and analysed", async () => {
  const sync = await freshSync();
  const user = newUser();
  const [m0, m1, m2, m3, m4] = [-4, -3, -2, -1, 0].map((d) => monthStr(d));
  player(user, {
    [m0]: [rawGame(user, `${user}-old1`, timeIn(m0))],            // outside the 3-month window: never requested
    [m1]: [rawGame(user, `${user}-old2`, timeIn(m1))],
    [m2]: [rawGame(user, `${user}-a`, timeIn(m2), { sans: SCHOLARS }), rawGame(user, `${user}-b`, timeIn(m2, 3))],
    [m3]: [rawGame(user, `${user}-c`, timeIn(m3), { sans: QUIET })],
    [m4]: [rawGame(user, `${user}-d`, timeIn(m4, 1), { sans: SCHOLARS }), rawGame(user, `${user}-e`, timeIn(m4, 1) + 60)],
  });
  const events = await runSync(sync, user);

  assert.deepEqual(phases(events), ["fetch", "analyse", "done"]);
  assert.equal(last(events).message, "Finished");
  // fetch progress counts 0..3 of 3
  const fetchEvents = events.filter((e) => e.phase === "fetch");
  assert.deepEqual([fetchEvents[0].total, fetchEvents[1].total, last(fetchEvents).done, last(fetchEvents).total], [0, 3, 3, 3]);
  // analyse progress: total 5, counter climbs to 5
  const analyseEvents = events.filter((e) => e.phase === "analyse");
  assert.equal(analyseEvents[0].done, 0);
  assert.equal(last(analyseEvents).done, 5);
  assert.ok(analyseEvents.every((e) => e.total === 5));
  assert.deepEqual(analyseEvents.map((e) => e.done), [0, 1, 2, 3, 4, 5]);

  // only the three in-window months were requested
  assert.deepEqual(stub.monthCalls(user).filter((u) => !u.endsWith("/archives")).map((u) => u.slice(-7).replace("/", "-")), [m2, m3, m4]);

  const games = await store.getGames(user);
  assert.deepEqual(ids(games), ["a", "b", "c", "d", "e"].map((x) => `${user}-${x}`));
  assert.ok(games.every((g) => typeof g.pgn === "string" && g.colour === "white" && g.result === "win" && g.my_rating === 1234));

  const months = await store.getMonths(user);
  assert.deepEqual([...months.keys()].sort(), [m2, m3, m4]);
  assert.equal(months.get(m2).complete, true);
  assert.equal(months.get(m3).complete, true);
  assert.equal(months.get(m4).complete, false, "the current month is never complete");

  const index = await store.getAnalysisIndex(user);
  assert.deepEqual([...index.keys()].sort(), ids(games));
  for (const rec of index.values()) assert.equal(rec.analysisVersion, CONFIG.analysisVersion);
  const a = await store.getAnalysis(user, `${user}-a`);
  assert.equal(a.id, `${user}-a`);
  assert.equal(a.analysisVersion, CONFIG.analysisVersion);
  assert.equal(a.moves.length, SCHOLARS.length); // 7 plies
  assert.equal(a.moves.at(-1).san, "Qxf7#");
  assert.equal((await store.getAnalysis(user, `${user}-c`)).moves.length, QUIET.length);

  // one pool slot (2 cores), engine workers all terminated afterwards, no stray requests
  assert.equal(FakeWorker.instances.length, 1);
  assert.ok(FakeWorker.instances.every((w) => w.terminated));
  assert.deepEqual(stub.unexpected, []);
  assert.deepEqual(locks.calls, [{ name: "chess-coach-sync", options: { ifAvailable: true } }]);
  assert.equal(locks.held.size, 0, "lock released afterwards");
});

test("a second startSync refetches only the current month and analyses nothing", async () => {
  const sync = await freshSync();
  const user = newUser();
  const [m2, m3, m4] = [-2, -1, 0].map((d) => monthStr(d));
  player(user, {
    [m2]: [rawGame(user, `${user}-a`, timeIn(m2))],
    [m3]: [rawGame(user, `${user}-b`, timeIn(m3))],
    [m4]: [rawGame(user, `${user}-c`, timeIn(m4, 1))],
  });
  await runSync(sync, user);
  stub.calls.length = 0;
  FakeWorker.reset();

  const events = await runSync(sync, user);
  assert.deepEqual(stub.calls.filter((u) => !u.endsWith("/archives")), [stub.calls.find((u) => u.endsWith(m4.replace("-", "/")))]);
  assert.equal(stub.monthCalls(user).filter((u) => !u.endsWith("/archives")).length, 1);
  assert.equal(FakeWorker.instances.length, 0, "no engine started");
  const analyse = events.filter((e) => e.phase === "analyse");
  assert.deepEqual(analyse.map((e) => [e.done, e.total, e.message]), [[0, 0, "All games analysed"]]);
  assert.equal(last(events).phase, "done");
  assert.equal((await store.getGames(user)).length, 3);
});

test("when everything is stored as complete, the fetch phase says the games are up to date", async () => {
  const sync = await freshSync();
  const user = newUser();
  const past = monthStr(-1);
  player(user, { [past]: [rawGame(user, `${user}-a`, timeIn(past))] });
  await runSync(sync, user);
  stub.calls.length = 0;
  const events = await runSync(sync, user);
  assert.equal(events[1].message, "Games are up to date");
  assert.equal(stub.monthCalls(user).filter((u) => !u.endsWith("/archives")).length, 0);
});

test("unknown player: archives 404 -> phase error with a clear message and nothing stored", async () => {
  const sync = await freshSync();
  const user = newUser();
  const err = mock.method(console, "error", () => {});
  try {
    const events = await runSync(sync, user);
    assert.equal(last(events).phase, "error");
    assert.equal(last(events).message, `No chess.com player called ${user}`);
    assert.ok(!events.some((e) => e.phase === "analyse" || e.phase === "done"));
  } finally { err.mock.restore(); }
  assert.deepEqual(await store.getGames(user), []);
  assert.equal((await store.getMonths(user)).size, 0);
  assert.equal((await store.getAnalysisIndex(user)).size, 0);
  assert.ok(!(await store.listUsers()).includes(user));
  assert.equal(FakeWorker.instances.length, 0);
});

test("the username is trimmed and lower-cased before it is used", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m))] });
  const events = await runSync(sync, `  ${user.toUpperCase()} `);
  assert.equal(last(events).phase, "done");
  assert.equal((await store.getGames(user)).length, 1);
});

test("an empty username reports 'Enter a chess.com username' (code not_found kept)", async () => {
  const sync = await freshSync();
  const err = mock.method(console, "error", () => {});
  try {
    const events = await runSync(sync, "   ");
    assert.equal(last(events).phase, "error");
    assert.match(last(events).message, /Enter a chess\.com username/);
    assert.equal(last(events).error.code, "not_found");
  } finally { err.mock.restore(); }
});

test("a month request failing with HTTP 500 -> earlier months stay stored and are still analysed, then phase error", async () => {
  const sync = await freshSync();
  const user = newUser();
  const [m3, m4] = [monthStr(-1), monthStr(0)];
  player(user, {
    [m3]: [rawGame(user, `${user}-a`, timeIn(m3)), rawGame(user, `${user}-b`, timeIn(m3, 3))],
    [m4]: [rawGame(user, `${user}-c`, timeIn(m4, 1))],
  }, { [m4]: 500 });
  const err = mock.method(console, "error", () => {});
  let events;
  try { events = await runSync(sync, user); } finally { err.mock.restore(); }

  assert.equal(last(events).phase, "error");
  assert.equal(last(events).message, "chess.com returned HTTP 500");
  assert.deepEqual(phases(events), ["fetch", "analyse", "error"]);
  assert.ok(!events.some((e) => e.phase === "done"), "finishes with the error, not done");
  // Months fetched before the failure are kept (games + month record) and analysed;
  // the failing month is neither stored nor recorded.
  assert.deepEqual(ids(await store.getGames(user)), [`${user}-a`, `${user}-b`]);
  const months = await store.getMonths(user);
  assert.deepEqual([...months.keys()], [m3]);
  assert.equal(months.get(m3).complete, true);
  assert.equal((await store.getAnalysisIndex(user)).size, 2);

  // and a retry picks up where it left off: only the failing month is requested again
  stub.players[user].status = {};
  stub.calls.length = 0;
  const retry = await runSync(sync, user);
  assert.equal(last(retry).phase, "done");
  assert.equal(stub.monthCalls(user).filter((u) => !u.endsWith("/archives")).length, 1);
  assert.equal((await store.getGames(user)).length, 3);
  assert.equal((await store.getAnalysisIndex(user)).size, 3);
});

test("a failed month still analyses stored games and the error event carries the fetch error's message", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  await store.putGames(user, [{ id: `${user}-old`, end_time: timeIn(m), colour: "white", pgn: pgnOf(QUIET) }]);
  player(user, { [m]: [] }, { [m]: 500 });
  const err = mock.method(console, "error", () => {});
  let events;
  try { events = await runSync(sync, user); } finally { err.mock.restore(); }
  assert.equal(last(events).phase, "error");
  assert.equal(last(events).message, "chess.com returned HTTP 500");
  assert.equal(last(events).error.code, "network");
  assert.ok(events.some((e) => e.phase === "analyse" && e.message === "Analysed 1 of 1"));
  assert.equal((await store.getAnalysisIndex(user)).size, 1);
});

test("an unknown player (not_found) stops at once: no analysis phase, no lock request", async () => {
  const sync = await freshSync();
  const user = newUser();
  await store.putGames(user, [{ id: `${user}-old`, end_time: timeIn(monthStr(0)), colour: "white", pgn: pgnOf(QUIET) }]);
  const err = mock.method(console, "error", () => {});
  try {
    const events = await runSync(sync, user);
    assert.deepEqual(phases(events), ["fetch", "error"]);
  } finally { err.mock.restore(); }
  assert.equal(locks.calls.length, 0);
  assert.equal((await store.getAnalysisIndex(user)).size, 0);
});

// ---- sync status broadcasts (read by pages through data.syncStatus) ----
/** Collect { type: "sync" } messages broadcast on the app channel. */
function collectSync() {
  const msgs = [];
  const ch = new FakeBroadcastChannel("chess-coach");
  ch.onmessage = (ev) => { if (ev.data && ev.data.type === "sync") msgs.push(ev.data); };
  return { msgs, close: () => ch.close() };
}

test("broadcasts a sync message when the fetch phase ends and another when the run ends", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m))] });
  const c = collectSync();
  await runSync(sync, user);
  await tick();
  c.close();
  assert.deepEqual(c.msgs, [
    { type: "sync", username: user, fetched: true, done: false, error: null },
    { type: "sync", username: user, fetched: true, done: true, error: null },
  ]);
});

test("sync messages on the failure paths: fetch error, unknown player, stop", async () => {
  const err = mock.method(console, "error", () => {});
  try {
    // failed month: fetched false with the message, then done true with the same
    let sync = await freshSync();
    let user = newUser();
    let m = monthStr(0);
    player(user, { [m]: [] }, { [m]: 500 });
    let c = collectSync();
    await runSync(sync, user);
    await tick();
    c.close();
    assert.deepEqual(c.msgs, [
      { type: "sync", username: user, fetched: false, done: false, error: "chess.com returned HTTP 500" },
      { type: "sync", username: user, fetched: false, done: true, error: "chess.com returned HTTP 500" },
    ]);

    // unknown player: both messages carry the not-found text
    sync = await freshSync();
    user = newUser();
    c = collectSync();
    await runSync(sync, user);
    await tick();
    c.close();
    assert.deepEqual(c.msgs.map((x) => [x.fetched, x.done, x.error]), [
      [false, false, "No chess.com player called " + user],
      [false, true, "No chess.com player called " + user],
    ]);

    // stopped during the fetch: done true, no error
    sync = await freshSync();
    user = newUser();
    m = monthStr(0);
    player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m))] });
    c = collectSync();
    await runSync(sync, user, { onProgress: (p, h) => { if (p.phase === "fetch" && p.total === 1) h.stop(); } });
    await tick();
    c.close();
    assert.equal(last(c.msgs).done, true);
    assert.equal(last(c.msgs).error, null);
  } finally { err.mock.restore(); }
});

test("a network failure on the archives list is reported as an error", async () => {
  const sync = await freshSync();
  const user = newUser();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  const err = mock.method(console, "error", () => {});
  try {
    const events = await runSync(sync, user);
    assert.equal(last(events).phase, "error");
    assert.match(last(events).message, /Could not reach chess\.com \(offline\)/);
  } finally { err.mock.restore(); globalThis.fetch = realFetch; }
});

test("variant games (chess960) and custom-position games are not stored", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  const custom = rawGame(user, `${user}-custom`, timeIn(m, 2) + 5);
  custom.pgn = custom.pgn.replace('[ECO ', '[SetUp "1"]\n[FEN "8/8/8/8/8/8/8/K6k w - - 0 1"]\n[ECO ');
  player(user, {
    [m]: [
      rawGame(user, `${user}-std`, timeIn(m)),
      rawGame(user, `${user}-960`, timeIn(m, 3), { rules: "chess960" }),
      rawGame(user, `${user}-kotc`, timeIn(m, 4), { rules: "kingofthehill" }),
      custom,
    ],
  });
  const events = await runSync(sync, user);
  assert.deepEqual((await store.getGames(user)).map((g) => g.id), [`${user}-std`]);
  assert.ok(events.some((e) => e.phase === "fetch" && /Fetched .* \(1 games\)/.test(e.message)));
  assert.deepEqual([...(await store.getAnalysisIndex(user)).keys()], [`${user}-std`]);
});

test("lock held by another tab -> busy, then this tab analyses when the lock is released, then done", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m))] });
  locks.held.add("chess-coach-sync");
  const c = collectSync();
  const events = await runSync(sync, user, { onProgress: (p) => { if (p.phase === "busy") setTimeout(() => locks.release("chess-coach-sync"), 20); } });
  await tick();
  c.close();

  assert.deepEqual(events.map((e) => e.phase + ":" + e.message), [
    "fetch:Looking up " + user + " on chess.com",
    "fetch:Fetching 1 month(s) of games",
    "fetch:Fetched " + m + " (1 games)",
    "busy:Waiting for another tab to finish analysing",
    "analyse:Analysing 1 game(s)",
    "analyse:Analysed 1 of 1",
    "done:Finished",
  ]);
  assert.equal((await store.getAnalysisIndex(user)).size, 1);
  assert.deepEqual(locks.calls.map((x) => Object.keys(x.options)), [["ifAvailable"], ["signal"]]);
  assert.equal(locks.held.size, 0, "lock released afterwards");
  assert.equal(locks.waiters.length, 0);
  // the done sync message only arrives once this tab really finished
  assert.deepEqual(c.msgs.map((x) => [x.fetched, x.done]), [[true, false], [true, true]]);
});

test("while waiting for another tab's lock nothing is analysed and no 'done' is emitted", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m))] });
  locks.held.add("chess-coach-sync");
  const events = [];
  const handle = sync.startSync(user, { onProgress: (p) => events.push(p) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(last(events).phase, "busy");
  assert.ok(!events.some((e) => e.phase === "done" || e.phase === "analyse"));
  assert.equal((await store.getAnalysisIndex(user)).size, 0);
  assert.equal(FakeWorker.instances.length, 0);
  assert.ok(locks.held.has("chess-coach-sync"), "we did not steal the other tab's lock");
  locks.release("chess-coach-sync");
  await handle.done;
  assert.equal(last(events).message, "Finished");
});

test("stop() while waiting for the lock -> 'Stopped', no analysis, no unhandled rejection", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m))] });
  locks.held.add("chess-coach-sync");
  const rejections = [];
  const onRejection = (e) => rejections.push(e);
  process.on("unhandledRejection", onRejection);
  const err = mock.method(console, "error", () => {});
  try {
    const events = await runSync(sync, user, { onProgress: (p, h) => { if (p.phase === "busy") setTimeout(() => h.stop(), 10); } });
    await tick();
    assert.equal(last(events).phase, "done");
    assert.equal(last(events).message, "Stopped");
    assert.ok(!events.some((e) => e.phase === "error" || e.phase === "analyse"));
    assert.equal(err.mock.callCount(), 0, "AbortError is not reported as an error");
  } finally {
    err.mock.restore();
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(rejections, []);
  assert.equal((await store.getAnalysisIndex(user)).size, 0);
  assert.equal(FakeWorker.instances.length, 0);
  assert.equal(locks.waiters.length, 0, "the pending request was withdrawn");
  assert.ok(locks.held.has("chess-coach-sync"), "the other tab's lock is untouched");
});

test("lock free: the analysis runs inside the lock and the lock is released afterwards", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m))] });
  let heldDuringAnalysis = null;
  await runSync(sync, user, { onProgress: (p) => { if (p.phase === "analyse" && p.done === 0 && p.total === 1) heldDuringAnalysis = locks.held.has("chess-coach-sync"); } });
  assert.equal(heldDuringAnalysis, true);
  assert.equal(locks.held.size, 0);
  assert.equal((await store.getAnalysisIndex(user)).size, 1);
});

test("without navigator.locks the analysis still runs", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m))] });
  fakeNavigator.locks = undefined;
  const events = await runSync(sync, user);
  assert.deepEqual(phases(events), ["fetch", "analyse", "done"]);
  assert.equal((await store.getAnalysisIndex(user)).size, 1);
});

test("stop() during analysis: no further writes, workers terminated, final 'Stopped'", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [1, 2, 3, 4].map((i) => rawGame(user, `${user}-g${i}`, timeIn(m, i))) });
  const events = await runSync(sync, user, {
    onProgress: (p, handle) => { if (p.phase === "analyse" && p.done === 1) handle.stop(); },
  });
  assert.deepEqual(phases(events), ["fetch", "analyse", "done"]);
  assert.equal(last(events).message, "Stopped");
  assert.equal(last(events).phase, "done");
  assert.equal(last(events.filter((e) => e.phase === "analyse")).done, 1);
  assert.equal((await store.getAnalysisIndex(user)).size, 1);
  assert.equal(FakeWorker.instances.length, 1);
  assert.ok(FakeWorker.instances.every((w) => w.terminated));
  // nothing sneaks in afterwards
  const count = events.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.length, count);
  assert.equal((await store.getAnalysisIndex(user)).size, 1);
  assert.equal((await store.getAnalyses(user)).size, 1);
  assert.equal(locks.held.size, 0);
  assert.equal(FakeWorker.instances.length, 1, "no replacement worker was started");
});

test("stop() while the engine is mid-search: the in-flight game is not written and the worker is terminated", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m)), rawGame(user, `${user}-b`, timeIn(m, 3))] });
  let handle = null;
  FakeWorker.onGo = () => { FakeWorker.onGo = null; handle.stop(); }; // first search request
  const events = [];
  handle = sync.startSync(user, { onProgress: (p) => events.push(p) });
  await handle.done;
  assert.equal(last(events).phase, "done");
  assert.equal(last(events).message, "Stopped");
  assert.equal((await store.getAnalysisIndex(user)).size, 0);
  assert.equal((await store.getAnalyses(user)).size, 0);
  assert.equal(FakeWorker.instances.length, 1);
  assert.ok(FakeWorker.instances.every((w) => w.terminated));
  assert.equal(last(events.filter((e) => e.phase === "analyse")).done, 0, "an abandoned game is not counted as done");
});

test("stop() during the fetch phase fetches nothing more and skips analysis", async () => {
  const sync = await freshSync();
  const user = newUser();
  const [m3, m4] = [monthStr(-1), monthStr(0)];
  player(user, { [m3]: [rawGame(user, `${user}-a`, timeIn(m3))], [m4]: [rawGame(user, `${user}-b`, timeIn(m4, 1))] });
  const events = await runSync(sync, user, { onProgress: (p, h) => { if (p.phase === "fetch" && p.total === 2 && p.done === 0) h.stop(); } });
  assert.equal(last(events).phase, "done");
  assert.equal(last(events).message, "Stopped");
  assert.equal(stub.monthCalls(user).filter((u) => !u.endsWith("/archives")).length, 0);
  assert.deepEqual(await store.getGames(user), []);
  assert.equal(FakeWorker.instances.length, 0);
});

test("a game whose analysis throws is skipped; the others are analysed and the counter still reaches total", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, {
    [m]: [
      rawGame(user, `${user}-ok1`, timeIn(m, 1), { sans: SCHOLARS }),
      rawGame(user, `${user}-bad`, timeIn(m, 2), { sans: ILLEGAL }),
      rawGame(user, `${user}-ok2`, timeIn(m, 3), { sans: QUIET }),
    ],
  });
  const err = mock.method(console, "error", () => {});
  let events;
  try { events = await runSync(sync, user); } finally { err.mock.restore(); }

  assert.deepEqual(phases(events), ["fetch", "analyse", "done"]);
  assert.equal(last(events).message, "Finished");
  const analyse = events.filter((e) => e.phase === "analyse");
  assert.deepEqual(analyse.map((e) => e.done), [0, 1, 2, 3]);
  assert.ok(analyse.every((e) => e.total === 3));
  assert.deepEqual([...(await store.getAnalysisIndex(user)).keys()].sort(), [`${user}-ok1`, `${user}-ok2`]);
  assert.equal((await store.getGames(user)).length, 3, "the game itself is still stored");
  assert.equal(err.mock.callCount(), 1, "the failure was logged once");

  // within this page session the failed game is not retried; the others are not redone
  FakeWorker.reset();
  const again = await runSync(sync, user);
  assert.deepEqual(again.filter((e) => e.phase === "analyse").map((e) => [e.done, e.total]), [[0, 0]]);
  assert.equal(FakeWorker.instances.length, 0);
});

test("a fresh page session (new module instance) retries a game that failed before", async () => {
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-bad`, timeIn(m), { sans: ILLEGAL })] });
  const err = mock.method(console, "error", () => {});
  try {
    const first = await runSync(await freshSync(), user);
    assert.deepEqual(first.filter((e) => e.phase === "analyse").map((e) => e.total), [1, 1]);
    const second = await runSync(await freshSync(), user);
    assert.deepEqual(second.filter((e) => e.phase === "analyse").map((e) => e.total), [1, 1]);
    assert.equal(err.mock.callCount(), 2);
  } finally { err.mock.restore(); }
});

test("games analysed with an older analysisVersion are re-analysed; older-than-window games are left alone", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m, 1))] });
  // pre-existing store content: an analysis from an old version, and a game before the window
  await store.putGames(user, [{ id: `${user}-ancient`, end_time: timeIn(monthStr(-8)), pgn: "1. e4 *", colour: "white", url: "u" }]);
  await store.putGames(user, [{ id: `${user}-a`, end_time: timeIn(m, 1), pgn: rawGame(user, "x", 1).pgn, colour: "white", url: "u" }]);
  await store.putAnalysis(user, { id: `${user}-a`, moves: [], counts: null, analysisVersion: CONFIG.analysisVersion - 1 });
  const events = await runSync(sync, user);
  const analyse = events.filter((e) => e.phase === "analyse");
  assert.equal(analyse[0].total, 1);
  const index = await store.getAnalysisIndex(user);
  assert.equal(index.get(`${user}-a`).analysisVersion, CONFIG.analysisVersion);
  assert.ok(!index.has(`${user}-ancient`));
});

test("seed player: analyses come from data/analysis/<id>.json and no engine Worker is ever constructed", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m, 1), { sans: SCHOLARS }), rawGame(user, `${user}-b`, timeIn(m, 2), { sans: QUIET })] });
  stub.seed = user.toUpperCase(); // seed.json is compared case-insensitively
  const seeded = (id, san) => ({ id: "wrong-id", depth: 14, start_cp: 11, moves: [{ san, uci: "e2e4", cp: 11 }], counts: { inaccuracy: 0, mistake: 1, blunder: 0 } });
  stub.seedAnalyses[`${user}-a`] = seeded(`${user}-a`, "e4");
  stub.seedAnalyses[`${user}-b`] = seeded(`${user}-b`, "d4");

  const events = await runSync(sync, user);
  assert.deepEqual(phases(events), ["fetch", "analyse", "done"]);
  assert.equal(last(events.filter((e) => e.phase === "analyse")).done, 2);
  assert.equal(FakeWorker.instances.length, 0, "Worker never constructed");
  assert.ok(stub.calls.includes("data/seed.json"));
  assert.ok(stub.calls.includes(`data/analysis/${user}-a.json`) && stub.calls.includes(`data/analysis/${user}-b.json`));

  const a = await store.getAnalysis(user, `${user}-a`);
  assert.equal(a.id, `${user}-a`, "id taken from the game, not the file");
  assert.equal(a.depth, 14, "the seed file's analysis is used as is");
  assert.equal(a.moves[0].san, "e4");
  assert.equal(a.analysisVersion, CONFIG.analysisVersion);
  assert.deepEqual((await store.getAnalysisIndex(user)).get(`${user}-b`), { analysisVersion: CONFIG.analysisVersion, counts: { inaccuracy: 0, mistake: 1, blunder: 0 } });
});

test("seed player: a game without a seed analysis falls back to the engine", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m, 1), { sans: SCHOLARS }), rawGame(user, `${user}-b`, timeIn(m, 2), { sans: QUIET })] });
  stub.seed = user;
  stub.seedAnalyses[`${user}-a`] = { depth: 14, start_cp: 0, moves: [{ san: "e4", uci: "e2e4", cp: 0 }], counts: { inaccuracy: 0, mistake: 0, blunder: 0 } };
  // -b has no file (404), and a malformed one would be treated the same way
  const events = await runSync(sync, user);
  assert.equal(last(events).phase, "done");
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal((await store.getAnalysis(user, `${user}-a`)).depth, 14);
  const b = await store.getAnalysis(user, `${user}-b`);
  assert.equal(b.depth, CONFIG.depth);
  assert.equal(b.moves.length, QUIET.length);
});

test("seed.json naming another player: seed analyses are never requested and the engine is used", async () => {
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m))] });
  stub.seed = "somebodyelse";
  stub.seedAnalyses[`${user}-a`] = { depth: 99, moves: [{ san: "e4", uci: "e2e4", cp: 0 }] };
  await runSync(sync, user);
  assert.ok(!stub.calls.some((u) => u.startsWith("data/analysis/")));
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal((await store.getAnalysis(user, `${user}-a`)).depth, CONFIG.depth);
});

test("sync broadcasts change events so other tabs and data.js can refresh", async () => {
  const { FakeBroadcastChannel, tick } = await import("./helpers.mjs");
  const sync = await freshSync();
  const user = newUser();
  const m = monthStr(0);
  player(user, { [m]: [rawGame(user, `${user}-a`, timeIn(m))] });
  const got = [];
  const listener = new FakeBroadcastChannel("chess-coach");
  listener.onmessage = (ev) => got.push(ev.data);
  await runSync(sync, user);
  await tick();
  listener.close();
  assert.deepEqual(got, [
    { type: "games", username: user },
    { type: "sync", username: user, fetched: true, done: false, error: null },
    { type: "analysis", username: user, id: `${user}-a` },
    { type: "sync", username: user, fetched: true, done: true, error: null },
  ]);
});

test("no unexpected network requests were made", () => {
  assert.deepEqual(stub.unexpected, []);
});
