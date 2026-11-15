// Integration tests for site/js/core/store.js on fake-indexeddb.
// Isolation: every test gets a brand new IDBFactory AND a fresh instance of store.js
// (cache-busting import), because store.js caches its DB connection at module level.
import test from "node:test";
import assert from "node:assert/strict";
import { core, freshIndexedDB } from "./helpers.mjs";

async function freshStore() {
  freshIndexedDB();
  return core("store.js", { fresh: true });
}

const game = (id, end_time, extra = {}) => ({ id, end_time, url: "https://www.chess.com/game/live/" + id, result: "win", pgn: "1. e4 e5 *", ...extra });
const analysis = (id, extra = {}) => ({ id, depth: 12, start_cp: 20, moves: [{ san: "e4", uci: "e2e4", cp: 20 }], counts: { inaccuracy: 1, mistake: 0, blunder: 2 }, analysisVersion: 1, ...extra });

test("putGames/getGames round trip: oldest first, username stripped, pgn kept", async () => {
  const s = await freshStore();
  await s.putGames("alice", [game("c", 300), game("a", 100, { pgn: "PGN-A" }), game("b", 200)]);
  const got = await s.getGames("alice");
  assert.deepEqual(got.map((g) => g.id), ["a", "b", "c"]);
  assert.ok(got.every((g) => !("username" in g)));
  assert.equal(got[0].pgn, "PGN-A");
  assert.deepEqual(got[1], game("b", 200));
});

test("getGames for an unknown user is an empty list", async () => {
  const s = await freshStore();
  assert.deepEqual(await s.getGames("nobody"), []);
});

test("usernames are case-insensitive and trimmed", async () => {
  const s = await freshStore();
  await s.putGames("  Alice ", [game("g1", 1)]);
  await s.putMonth("ALICE", "2026-01", { complete: true });
  await s.putAnalysis(" alice", analysis("g1"));
  for (const name of ["alice", "ALICE", "  AlIcE  "]) {
    assert.equal((await s.getGames(name)).length, 1, name);
    assert.equal((await s.getMonth(name, "2026-01")).complete, true, name);
    assert.equal((await s.getAnalysis(name, "g1")).id, "g1", name);
  }
  assert.deepEqual(await s.listUsers(), ["alice"]);
});

test("two users never see each other's games, months or analyses", async () => {
  const s = await freshStore();
  await s.putGames("alice", [game("a1", 10)]);
  await s.putGames("bob", [game("b1", 20)]);
  await s.putMonth("alice", "2026-01", { complete: true, fetched: 5 });
  await s.putMonth("bob", "2026-02", { complete: false, fetched: 6 });
  await s.putAnalysis("alice", analysis("a1"));
  await s.putAnalysis("bob", analysis("b1"));

  assert.deepEqual((await s.getGames("alice")).map((g) => g.id), ["a1"]);
  assert.deepEqual((await s.getGames("bob")).map((g) => g.id), ["b1"]);
  assert.deepEqual([...(await s.getMonths("alice")).keys()], ["2026-01"]);
  assert.deepEqual([...(await s.getMonths("bob")).keys()], ["2026-02"]);
  assert.equal(await s.getMonth("alice", "2026-02"), null);
  assert.deepEqual([...(await s.getAnalyses("alice")).keys()], ["a1"]);
  assert.deepEqual([...(await s.getAnalysisIndex("bob")).keys()], ["b1"]);
  assert.equal(await s.getAnalysis("alice", "b1"), null);
});

test("the same game id may exist for two users independently", async () => {
  const s = await freshStore();
  await s.putGames("alice", [game("same", 1, { result: "win" })]);
  await s.putGames("bob", [game("same", 2, { result: "loss" })]);
  assert.equal((await s.getGames("alice"))[0].result, "win");
  assert.equal((await s.getGames("bob"))[0].result, "loss");
});

test("putGames with an existing id overwrites instead of duplicating", async () => {
  const s = await freshStore();
  await s.putGames("alice", [game("g", 100, { result: "loss" })]);
  await s.putGames("alice", [game("g", 150, { result: "win" }), game("h", 120)]);
  const got = await s.getGames("alice");
  assert.equal(got.length, 2);
  const g = got.find((x) => x.id === "g");
  assert.equal(g.result, "win");
  assert.equal(g.end_time, 150);
  assert.deepEqual(got.map((x) => x.id), ["h", "g"]); // re-sorted by the new end_time
});

test("putMonth/getMonth: complete coerced to boolean, fetched defaulted, missing is null", async () => {
  const s = await freshStore();
  assert.equal(await s.getMonth("alice", "2026-01"), null);

  await s.putMonth("alice", "2026-01", { complete: 1, fetched: 1234 });
  assert.deepEqual(await s.getMonth("alice", "2026-01"), { complete: true, fetched: 1234 });

  await s.putMonth("alice", "2026-02", { complete: undefined, fetched: 99 });
  assert.deepEqual(await s.getMonth("alice", "2026-02"), { complete: false, fetched: 99 });

  const before = Date.now();
  await s.putMonth("alice", "2026-03", { complete: "yes" });
  const after = Date.now();
  const m = await s.getMonth("alice", "2026-03");
  assert.equal(m.complete, true);
  assert.ok(m.fetched >= before && m.fetched <= after, "fetched defaults to now");

  // overwrite flips the flag
  await s.putMonth("alice", "2026-01", { complete: false, fetched: 5 });
  assert.deepEqual(await s.getMonth("alice", "2026-01"), { complete: false, fetched: 5 });
});

test("getMonths returns a Map of month -> { complete, fetched }", async () => {
  const s = await freshStore();
  await s.putMonth("alice", "2026-01", { complete: true, fetched: 1 });
  await s.putMonth("alice", "2026-02", { complete: 0, fetched: 2 });
  const months = await s.getMonths("alice");
  assert.ok(months instanceof Map);
  assert.deepEqual([...months.entries()].sort(), [
    ["2026-01", { complete: true, fetched: 1 }],
    ["2026-02", { complete: false, fetched: 2 }],
  ]);
  assert.equal((await s.getMonths("nobody")).size, 0);
});

test("putAnalysis writes the analysis and the light index", async () => {
  const s = await freshStore();
  const a = analysis("g1");
  await s.putAnalysis("alice", a);
  assert.deepEqual(await s.getAnalysis("alice", "g1"), a);
  const idx = await s.getAnalysisIndex("alice");
  assert.deepEqual(idx.get("g1"), { analysisVersion: 1, counts: { inaccuracy: 1, mistake: 0, blunder: 2 } });
  // the index holds no moves
  assert.deepEqual(Object.keys(idx.get("g1")).sort(), ["analysisVersion", "counts"]);
});

test("putAnalysis without counts indexes counts as null; re-put updates the index", async () => {
  const s = await freshStore();
  await s.putAnalysis("alice", { id: "g1", moves: [], analysisVersion: 1 });
  assert.deepEqual((await s.getAnalysisIndex("alice")).get("g1"), { analysisVersion: 1, counts: null });
  await s.putAnalysis("alice", analysis("g1", { analysisVersion: 2 }));
  assert.equal((await s.getAnalysisIndex("alice")).get("g1").analysisVersion, 2);
  assert.equal((await s.getAnalyses("alice")).size, 1);
});

test("getAnalysis for a missing id resolves to null", async () => {
  const s = await freshStore();
  assert.equal(await s.getAnalysis("alice", "nope"), null);
  await s.putAnalysis("alice", analysis("g1"));
  assert.equal(await s.getAnalysis("alice", "nope"), null);
});

test("getAnalyses maps id -> analysis without the username", async () => {
  const s = await freshStore();
  await s.putAnalysis("alice", analysis("g1"));
  await s.putAnalysis("alice", analysis("g2", { start_cp: -40 }));
  const map = await s.getAnalyses("alice");
  assert.deepEqual([...map.keys()].sort(), ["g1", "g2"]);
  assert.equal(map.get("g2").start_cp, -40);
  assert.ok(!("username" in map.get("g1")));
});

test("deleteUser removes everything for that user and nothing for others", async () => {
  const s = await freshStore();
  for (const u of ["alice", "bob"]) {
    await s.putGames(u, [game(u + "1", 1)]);
    await s.putMonth(u, "2026-01", { complete: true });
    await s.putAnalysis(u, analysis(u + "1"));
  }
  await s.deleteUser("Alice ");
  assert.deepEqual(await s.getGames("alice"), []);
  assert.equal((await s.getMonths("alice")).size, 0);
  assert.equal((await s.getAnalyses("alice")).size, 0);
  assert.equal((await s.getAnalysisIndex("alice")).size, 0);
  assert.equal(await s.getAnalysis("alice", "alice1"), null);
  assert.equal((await s.getGames("bob")).length, 1);
  assert.equal((await s.getMonths("bob")).size, 1);
  assert.equal((await s.getAnalyses("bob")).size, 1);
  assert.equal((await s.getAnalysisIndex("bob")).size, 1);
  assert.deepEqual(await s.listUsers(), ["bob"]);
});

test("deleteUser does not touch a user whose name has the deleted name as a prefix (and vice versa)", async () => {
  const s = await freshStore();
  for (const u of ["bob", "bobby", "bo"]) {
    await s.putGames(u, [game(u + "-g", 1)]);
    await s.putMonth(u, "2026-01", { complete: true });
    await s.putAnalysis(u, analysis(u + "-g"));
  }
  await s.deleteUser("bob");
  assert.deepEqual(await s.listUsers(), ["bo", "bobby"]);
  for (const u of ["bobby", "bo"]) {
    assert.equal((await s.getGames(u)).length, 1, u);
    assert.equal((await s.getMonths(u)).size, 1, u);
    assert.equal((await s.getAnalyses(u)).size, 1, u);
    assert.equal((await s.getAnalysisIndex(u)).size, 1, u);
  }
  await s.deleteUser("bobby");
  assert.deepEqual(await s.listUsers(), ["bo"]);
  assert.equal((await s.getGames("bo")).length, 1);
});

test("deleteUser also clears that user's meta records, and deleting an unknown user is harmless", async () => {
  const s = await freshStore();
  await s.putGames("alice", [game("g", 1)]);
  await s.deleteUser("ghost");
  // the public API never writes meta, so write it directly
  const db = await new Promise((res, rej) => { const r = indexedDB.open("chess-coach", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const put = (rec) => new Promise((res, rej) => { const t = db.transaction("meta", "readwrite"); t.objectStore("meta").put(rec); t.oncomplete = res; t.onerror = () => rej(t.error); });
  await put({ username: "alice", key: "k", value: 1 });
  await put({ username: "alicia", key: "k", value: 2 });
  await s.deleteUser("alice");
  const keys = await new Promise((res, rej) => { const r = db.transaction("meta").objectStore("meta").getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  assert.deepEqual(keys, [["alicia", "k"]]);
  db.close();
});

test("listUsers: sorted, lower-case, no duplicates, from games or months", async () => {
  const s = await freshStore();
  assert.deepEqual(await s.listUsers(), []);
  await s.putGames("Zed", [game("z1", 1), game("z2", 2)]);
  await s.putMonth("zed", "2026-01", { complete: true });
  await s.putMonth("Amy", "2026-01", { complete: false }); // months only
  await s.putGames("mia", [game("m1", 1)]);
  assert.deepEqual(await s.listUsers(), ["amy", "mia", "zed"]);
});

test("an unavailable IndexedDB rejects with a clear error, then recovers once it is available", async () => {
  const s = await freshStore();
  const saved = globalThis.indexedDB;
  Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true, writable: true });
  await assert.rejects(s.getGames("alice"), /IndexedDB is not available/);
  Object.defineProperty(globalThis, "indexedDB", { value: saved, configurable: true, writable: true });
  await s.putGames("alice", [game("g", 1)]);
  assert.equal((await s.getGames("alice")).length, 1);
});
