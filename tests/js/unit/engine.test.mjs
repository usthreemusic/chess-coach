// Unit tests for site/js/core/engine.js (UCI parsing, the worker-backed engine, the pool).
// Run from the repo root: node --test tests/js/unit/engine.test.mjs
// The Worker is a scripted fake; the 30 s / 60 s engine timeouts use mock timers.
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { parseInfo, collectInfo, finishLines, createEngine, createPool, defaultPoolSize } =
  await load("site/js/core/engine.js");
const { CONFIG } = await load("site/js/core/config.js");

// Let queued microtasks and real setImmediate callbacks run (mock timers only replace setTimeout).
const flush = async (rounds = 3) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r)); };

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

// ---- parseInfo ------------------------------------------------------------------------------
describe("parseInfo", () => {
  it("parses a full Stockfish line with a centipawn score", () => {
    const line = "info depth 18 seldepth 24 multipv 2 score cp 34 nodes 123456 nps 987654 hashfull 5 tbhits 0 time 125 pv e2e4 e7e5 g1f3";
    assert.deepEqual(parseInfo(line), {
      depth: 18, multipv: 2, cp: 34, mate: null, pv: ["e2e4", "e7e5", "g1f3"],
    });
  });

  it("parses a negative centipawn score", () => {
    assert.deepEqual(parseInfo("info depth 9 multipv 1 score cp -145 pv d7d5"), {
      depth: 9, multipv: 1, cp: -145, mate: null, pv: ["d7d5"],
    });
  });

  it("parses positive and negative mate scores with cp null", () => {
    assert.deepEqual(parseInfo("info depth 20 score mate 3 pv d8h4 g2g3 h4g3"), {
      depth: 20, multipv: 1, cp: null, mate: 3, pv: ["d8h4", "g2g3", "h4g3"],
    });
    assert.deepEqual(parseInfo("info depth 20 score mate -2 pv a1a2"), {
      depth: 20, multipv: 1, cp: null, mate: -2, pv: ["a1a2"],
    });
  });

  it("defaults multipv to 1 and reads an explicit multipv index", () => {
    assert.equal(parseInfo("info depth 5 score cp 10 pv e2e4").multipv, 1);
    assert.equal(parseInfo("info depth 5 multipv 3 score cp 10 pv e2e4").multipv, 3);
  });

  it("rejects lowerbound and upperbound scores", () => {
    assert.equal(parseInfo("info depth 12 score cp 50 lowerbound nodes 1 pv e2e4"), null);
    assert.equal(parseInfo("info depth 12 score cp 50 upperbound nodes 1 pv e2e4"), null);
    assert.equal(parseInfo("info depth 12 score mate 2 lowerbound pv e2e4"), null);
  });

  it("rejects info string lines", () => {
    assert.equal(parseInfo("info string NNUE evaluation using nn-1234.nnue"), null);
  });

  it("treats everything after 'info string' as free text, even if it looks like a score and pv", () => {
    // UCI: "string" is followed by arbitrary text to the end of the line.
    assert.equal(parseInfo("info string depth 3 score cp 5 pv e2e4"), null);
  });

  it("rejects currmove lines (no score, no pv)", () => {
    assert.equal(parseInfo("info depth 5 currmove e2e4 currmovenumber 1"), null);
  });

  it("rejects lines with no pv, or an empty pv", () => {
    assert.equal(parseInfo("info depth 10 score cp 5 nodes 100"), null);
    assert.equal(parseInfo("info depth 10 score cp 5 pv"), null);
  });

  it("rejects lines with no score", () => {
    assert.equal(parseInfo("info depth 10 pv e2e4"), null);
  });

  it("rejects an unknown score kind", () => {
    assert.equal(parseInfo("info depth 10 score wdl 5 pv e2e4"), null);
  });

  it("returns null for non-string and non-info input", () => {
    for (const bad of [undefined, null, 42, {}, ["info depth 1 score cp 1 pv e2e4"], "", "bestmove e2e4", "readyok", "uciok", "infodepth 1"]) {
      assert.equal(parseInfo(bad), null, `input ${JSON.stringify(bad)}`);
    }
  });

  it("tolerates repeated spaces, tabs and trailing whitespace between tokens", () => {
    assert.deepEqual(parseInfo("info  depth   7  multipv 2\tscore  cp   -3   pv   e2e4   e7e5  \r\n"), {
      depth: 7, multipv: 2, cp: -3, mate: null, pv: ["e2e4", "e7e5"],
    });
  });

  it("does not read tokens after pv as keywords", () => {
    // 'depth' and 'score' appearing inside the pv would be nonsense moves; the pv swallows the rest.
    const r = parseInfo("info depth 4 score cp 1 pv e2e4 depth 99");
    assert.equal(r.depth, 4);
    assert.deepEqual(r.pv, ["e2e4", "depth", "99"]);
  });
});

// ---- collectInfo / finishLines --------------------------------------------------------------
describe("collectInfo and finishLines", () => {
  const info = (depth, multipv, cp, pv = ["e2e4"]) => ({ depth, multipv, cp, mate: null, pv });

  it("a deeper line replaces a shallower one", () => {
    const best = new Map();
    assert.equal(collectInfo(best, info(5, 1, 10)), true);
    assert.equal(collectInfo(best, info(6, 1, 20)), true);
    assert.equal(best.get(1).cp, 20);
  });

  it("an equal-depth line replaces the earlier one (later wins)", () => {
    const best = new Map();
    collectInfo(best, info(8, 1, 10));
    assert.equal(collectInfo(best, info(8, 1, 99)), true);
    assert.equal(best.get(1).cp, 99);
  });

  it("a shallower line is ignored", () => {
    const best = new Map();
    collectInfo(best, info(8, 1, 10));
    assert.equal(collectInfo(best, info(7, 1, 99)), false);
    assert.equal(best.get(1).cp, 10);
  });

  it("null is ignored", () => {
    const best = new Map();
    assert.equal(collectInfo(best, null), false);
    assert.equal(best.size, 0);
  });

  it("keeps each multipv index independently", () => {
    const best = new Map();
    collectInfo(best, info(10, 1, 30));
    collectInfo(best, info(4, 2, 5));
    assert.equal(best.size, 2);
    assert.equal(best.get(2).depth, 4);
  });

  it("finishLines sorts by multipv index and returns exactly { cp, mate, pv }", () => {
    const best = new Map();
    collectInfo(best, info(10, 3, -5, ["c2c4"]));
    collectInfo(best, info(10, 1, 40, ["e2e4", "e7e5"]));
    collectInfo(best, { depth: 10, multipv: 2, cp: null, mate: 4, pv: ["d2d4"] });
    assert.deepStrictEqual(finishLines(best), [
      { cp: 40, mate: null, pv: ["e2e4", "e7e5"] },
      { cp: null, mate: 4, pv: ["d2d4"] },
      { cp: -5, mate: null, pv: ["c2c4"] },
    ]);
  });

  it("finishLines of an empty map is an empty array", () => {
    assert.deepStrictEqual(finishLines(new Map()), []);
  });
});

// ---- scripted fake Worker -------------------------------------------------------------------
class FakeWorker {
  static instances = [];
  static auto = { uci: true, isready: true, go: true };   // which commands get an automatic reply
  static goLines = null;                                   // override reply to "go": array of lines
  static throwOnConstruct = null;

  constructor(url) {
    if (FakeWorker.throwOnConstruct) throw FakeWorker.throwOnConstruct;
    this.url = url;
    this.sent = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.instances.push(this);
  }

  reply(...lines) {
    for (const l of lines) queueMicrotask(() => { if (this.onmessage) this.onmessage({ data: l }); });
  }

  postMessage(cmd) {
    this.sent.push(cmd);
    const A = FakeWorker.auto;
    if (cmd === "uci") { if (A.uci) this.reply("id name FakeFish", "uciok"); }
    else if (cmd === "isready") { if (A.isready) this.reply("readyok"); }
    else if (cmd.startsWith("go depth ") && A.go) this.reply(...(FakeWorker.goLines || defaultGo()));
  }

  terminate() { this.terminated = true; }

  get goCount() { return this.sent.filter((c) => c.startsWith("go ")).length; }
}

const defaultGo = () => [
  "info depth 1 multipv 1 score cp 5 pv e2e4",
  "info string some noise",
  "info depth 12 multipv 1 score cp 31 pv e2e4 e7e5",
  "bestmove e2e4 ponder e7e5",
];

let originalWorker, hadWorker;

beforeEach(() => {
  hadWorker = Object.prototype.hasOwnProperty.call(globalThis, "Worker");
  originalWorker = globalThis.Worker;
  FakeWorker.instances = [];
  FakeWorker.auto = { uci: true, isready: true, go: true };
  FakeWorker.goLines = null;
  FakeWorker.throwOnConstruct = null;
  globalThis.Worker = FakeWorker;
});

afterEach(() => {
  mock.timers.reset();
  if (hadWorker) globalThis.Worker = originalWorker; else delete globalThis.Worker;
});

// ---- createEngine ---------------------------------------------------------------------------
describe("createEngine", () => {
  it("constructs no Worker until the first evaluate", () => {
    createEngine();
    assert.equal(FakeWorker.instances.length, 0);
  });

  it("handshakes uci -> isready, then MultiPV, position fen, go depth CONFIG.depth", async () => {
    const eng = createEngine();
    const lines = await eng.evaluate(START);
    assert.equal(FakeWorker.instances.length, 1);
    assert.deepEqual(FakeWorker.instances[0].sent, [
      "uci", "isready", "setoption name MultiPV value 1", "position fen " + START, "go depth " + CONFIG.depth,
    ]);
    assert.deepStrictEqual(lines, [{ cp: 31, mate: null, pv: ["e2e4", "e7e5"] }]);
    eng.terminate();
  });

  it("uses opts.depth when given, and CONFIG.depth otherwise", async () => {
    const eng = createEngine();
    await eng.evaluate(START, { depth: 7 });
    await eng.evaluate(START);
    const goes = FakeWorker.instances[0].sent.filter((c) => c.startsWith("go "));
    assert.deepEqual(goes, ["go depth 7", "go depth " + CONFIG.depth]);
    eng.terminate();
  });

  it("sends setoption MultiPV only when the value changes", async () => {
    const eng = createEngine();
    await eng.evaluate(START, { multipv: 3 });
    await eng.evaluate(AFTER_E4, { multipv: 3 });
    await eng.evaluate(START, { multipv: 1 });
    await eng.evaluate(START);                     // default multipv is 1 again: unchanged
    await eng.evaluate(START, { multipv: 0 });     // clamps to 1: unchanged
    const opts = FakeWorker.instances[0].sent.filter((c) => c.startsWith("setoption"));
    assert.deepEqual(opts, ["setoption name MultiPV value 3", "setoption name MultiPV value 1"]);
    eng.terminate();
  });

  it("sends setoption before the position and go for that search", async () => {
    const eng = createEngine();
    await eng.evaluate(START, { multipv: 2 });
    const sent = FakeWorker.instances[0].sent;
    assert.ok(sent.indexOf("setoption name MultiPV value 2") < sent.indexOf("position fen " + START));
    assert.ok(sent.indexOf("position fen " + START) < sent.findIndex((c) => c.startsWith("go ")));
    eng.terminate();
  });

  it("returns lines best first (by multipv index) keeping the deepest of each", async () => {
    FakeWorker.goLines = [
      "info depth 10 multipv 2 score cp 20 pv d2d4 d7d5",
      "info depth 10 multipv 1 score cp 40 pv e2e4 e7e5",
      "info depth 11 multipv 2 score cp 25 pv d2d4 g8f6",
      "info depth 11 multipv 1 score mate 5 pv e2e4",
      "info depth 9 multipv 1 score cp 999 pv a2a3",       // shallower: ignored
      "info depth 11 multipv 3 score cp 5 lowerbound pv c2c4", // bound: ignored
      "bestmove e2e4",
    ];
    const eng = createEngine();
    const lines = await eng.evaluate(START, { multipv: 3 });
    assert.deepStrictEqual(lines, [
      { cp: null, mate: 5, pv: ["e2e4"] },
      { cp: 25, mate: null, pv: ["d2d4", "g8f6"] },
    ]);
    eng.terminate();
  });

  it("resolves to [] when the engine answers bestmove with no scored lines", async () => {
    FakeWorker.goLines = ["bestmove (none)"];
    const eng = createEngine();
    assert.deepStrictEqual(await eng.evaluate(START), []);
    eng.terminate();
  });

  it("reuses one worker across searches", async () => {
    const eng = createEngine();
    await eng.evaluate(START);
    await eng.evaluate(AFTER_E4);
    assert.equal(FakeWorker.instances.length, 1);
    assert.deepEqual(FakeWorker.instances[0].sent.filter((c) => c === "uci" || c === "isready"), ["uci", "isready"]);
    eng.terminate();
  });

  it("runs back-to-back evaluate() calls strictly one after the other", async () => {
    FakeWorker.auto.go = false;
    const eng = createEngine();
    const p1 = eng.evaluate(START);
    const p2 = eng.evaluate(AFTER_E4);
    await flush();
    const w = FakeWorker.instances[0];
    assert.equal(w.goCount, 1, "second go must wait for the first bestmove");
    assert.ok(!w.sent.includes("position fen " + AFTER_E4));

    w.reply("info depth 3 score cp 11 pv e2e4", "bestmove e2e4");
    assert.deepStrictEqual(await p1, [{ cp: 11, mate: null, pv: ["e2e4"] }]);
    await flush();
    assert.equal(w.goCount, 2);
    assert.ok(w.sent.indexOf("position fen " + AFTER_E4) > w.sent.indexOf("position fen " + START));

    w.reply("info depth 3 score cp -22 pv e7e5", "bestmove e7e5");
    assert.deepStrictEqual(await p2, [{ cp: -22, mate: null, pv: ["e7e5"] }]);
    eng.terminate();
  });

  it("does not leak lines from the first search into the second", async () => {
    FakeWorker.auto.go = false;
    const eng = createEngine();
    const p1 = eng.evaluate(START, { multipv: 2 });
    const p2 = eng.evaluate(AFTER_E4, { multipv: 2 });
    await flush();
    const w = FakeWorker.instances[0];
    w.reply("info depth 3 multipv 1 score cp 1 pv a2a3", "info depth 3 multipv 2 score cp 2 pv b2b3", "bestmove a2a3");
    await p1;
    await flush();
    w.reply("info depth 3 multipv 1 score cp 9 pv e7e5", "bestmove e7e5");
    assert.deepStrictEqual(await p2, [{ cp: 9, mate: null, pv: ["e7e5"] }]);
    eng.terminate();
  });

  it("rejects a search that never answers after 60 s, and the next evaluate() gets a fresh worker", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    FakeWorker.auto.go = false;
    const eng = createEngine();
    const p1 = eng.evaluate(START, { multipv: 2 });
    const settled = assert.rejects(p1, /Engine search timed out/);
    await flush();
    const w1 = FakeWorker.instances[0];
    assert.equal(w1.goCount, 1);

    mock.timers.tick(59999);
    await flush();
    assert.equal(w1.terminated, false, "not yet timed out at 59.999 s");
    mock.timers.tick(1);
    await settled;
    assert.equal(w1.terminated, true, "the stuck worker is killed");

    FakeWorker.auto.go = true;
    const lines = await eng.evaluate(AFTER_E4, { multipv: 2 });
    assert.equal(FakeWorker.instances.length, 2, "a new worker is created");
    const w2 = FakeWorker.instances[1];
    assert.deepEqual(w2.sent.slice(0, 3), ["uci", "isready", "setoption name MultiPV value 2"],
      "the new worker is initialised and gets MultiPV again");
    assert.deepStrictEqual(lines, [{ cp: 31, mate: null, pv: ["e2e4", "e7e5"] }]);
    eng.terminate();
  });

  it("a timed-out search does not poison a call already queued behind it", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    FakeWorker.auto.go = false;
    const eng = createEngine();
    const p1 = eng.evaluate(START);
    const p2 = eng.evaluate(AFTER_E4);
    const first = assert.rejects(p1, /timed out/);
    await flush();
    FakeWorker.auto.go = true;
    mock.timers.tick(60000);
    await first;
    assert.deepStrictEqual(await p2, [{ cp: 31, mate: null, pv: ["e2e4", "e7e5"] }]);
    assert.equal(FakeWorker.instances.length, 2);
    eng.terminate();
  });

  it("a worker error during a search rejects it, and the next call recovers on a fresh worker", async () => {
    FakeWorker.auto.go = false;
    const eng = createEngine();
    const p1 = eng.evaluate(START);
    const settled = assert.rejects(p1, /Engine worker error: wasm exploded/);
    await flush();
    const w1 = FakeWorker.instances[0];
    w1.onerror({ message: "wasm exploded" });
    await settled;
    assert.equal(w1.terminated, true);

    FakeWorker.auto.go = true;
    const lines = await eng.evaluate(START);
    assert.equal(FakeWorker.instances.length, 2);
    assert.equal(lines[0].cp, 31);
    eng.terminate();
  });

  it("a worker error with no message still rejects with 'unknown'", async () => {
    FakeWorker.auto.go = false;
    const eng = createEngine();
    const p = eng.evaluate(START);
    const settled = assert.rejects(p, /Engine worker error: unknown/);
    await flush();
    FakeWorker.instances[0].onerror(undefined);
    await settled;
    eng.terminate();
  });

  it("a worker error during init rejects and the next call starts over", async () => {
    FakeWorker.auto.uci = false;
    const eng = createEngine();
    const p = eng.evaluate(START);
    const settled = assert.rejects(p, /Engine worker error: no wasm/);
    await flush();
    FakeWorker.instances[0].onerror({ message: "no wasm" });
    await settled;

    FakeWorker.auto.uci = true;
    assert.equal((await eng.evaluate(START))[0].cp, 31);
    assert.equal(FakeWorker.instances.length, 2);
    eng.terminate();
  });

  it("rejects an init that never sends uciok after 30 s", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    FakeWorker.auto.uci = false;
    const eng = createEngine();
    const p = eng.evaluate(START);
    const settled = assert.rejects(p, /Engine timed out waiting for uciok/);
    await flush();
    mock.timers.tick(29999);
    await flush();
    assert.deepEqual(FakeWorker.instances[0].sent, ["uci"]);
    mock.timers.tick(1);
    await settled;
    assert.equal(FakeWorker.instances[0].terminated, true);
    assert.ok(!FakeWorker.instances[0].sent.includes("isready"));

    FakeWorker.auto.uci = true;
    assert.equal((await eng.evaluate(START))[0].cp, 31);
    eng.terminate();
  });

  it("rejects an init that sends uciok but never readyok after 30 s", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    FakeWorker.auto.isready = false;
    const eng = createEngine();
    const settled = assert.rejects(eng.evaluate(START), /Engine timed out waiting for readyok/);
    await flush();
    mock.timers.tick(30000);
    await settled;
    eng.terminate();
  });

  it("rejects when constructing the Worker throws, and recovers once it works", async () => {
    FakeWorker.throwOnConstruct = new Error("no workers here");
    const eng = createEngine();
    await assert.rejects(eng.evaluate(START), /no workers here/);
    FakeWorker.throwOnConstruct = null;
    assert.equal((await eng.evaluate(START))[0].cp, 31);
    eng.terminate();
  });

  it("terminate() rejects the in-flight search, terminates the worker, and later calls reject", async () => {
    FakeWorker.auto.go = false;
    const eng = createEngine();
    const inflight = eng.evaluate(START);
    const queued = eng.evaluate(AFTER_E4);
    const s1 = assert.rejects(inflight, /Engine terminated/);
    const s2 = assert.rejects(queued, /Engine terminated/);
    await flush();
    const w = FakeWorker.instances[0];
    eng.terminate();
    await s1;
    await s2;
    assert.equal(w.terminated, true);
    await assert.rejects(eng.evaluate(START), /Engine terminated/);
    assert.equal(FakeWorker.instances.length, 1, "no new worker after terminate");
  });

  it("terminate() before any use makes evaluate reject without creating a worker", async () => {
    const eng = createEngine();
    eng.terminate();
    await assert.rejects(eng.evaluate(START), /Engine terminated/);
    assert.equal(FakeWorker.instances.length, 0);
  });

  it("terminate() during init rejects the pending evaluate", async () => {
    FakeWorker.auto.uci = false;
    const eng = createEngine();
    const settled = assert.rejects(eng.evaluate(START), /Engine terminated/);
    await flush();
    eng.terminate();
    await settled;
    assert.equal(FakeWorker.instances[0].terminated, true);
  });

  it("calling terminate() twice is harmless", async () => {
    const eng = createEngine();
    await eng.evaluate(START);
    eng.terminate();
    eng.terminate();
    assert.equal(FakeWorker.instances[0].terminated, true);
  });

  it("a rejected search does not poison the queue for the following call", async () => {
    FakeWorker.auto.go = false;
    const eng = createEngine();
    const p1 = eng.evaluate(START);
    const s1 = assert.rejects(p1, /Engine worker error: boom/);
    const p2 = eng.evaluate(AFTER_E4);
    await flush();
    FakeWorker.auto.go = true;
    FakeWorker.instances[0].onerror({ message: "boom" });
    await s1;
    assert.deepStrictEqual(await p2, [{ cp: 31, mate: null, pv: ["e2e4", "e7e5"] }]);
    eng.terminate();
  });

  it("ignores messages and errors from an old, killed worker", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    FakeWorker.auto.go = false;
    const eng = createEngine();
    const p1 = eng.evaluate(START);
    const s1 = assert.rejects(p1, /timed out/);
    await flush();
    const oldWorker = FakeWorker.instances[0];
    mock.timers.tick(60000);
    await s1;

    const p2 = eng.evaluate(AFTER_E4);
    await flush();
    const newWorker = FakeWorker.instances[1];
    assert.equal(newWorker.goCount, 1);

    // A late answer from the dead worker must not complete the new search or kill the new worker.
    oldWorker.onmessage({ data: "info depth 99 score cp 12345 pv h2h4" });
    oldWorker.onmessage({ data: "bestmove h2h4" });
    oldWorker.onerror({ message: "late error" });
    await flush();
    assert.equal(newWorker.terminated, false);

    newWorker.reply("info depth 4 score cp 7 pv e7e5", "bestmove e7e5");
    assert.deepStrictEqual(await p2, [{ cp: 7, mate: null, pv: ["e7e5"] }]);
    eng.terminate();
  });

  it("coerces non-string worker payloads without throwing", async () => {
    FakeWorker.auto.go = false;
    const eng = createEngine();
    const p = eng.evaluate(START);
    await flush();
    const w = FakeWorker.instances[0];
    w.onmessage({ data: { some: "object" } });
    w.onmessage({ data: undefined });
    w.reply("info depth 2 score cp 3 pv e2e4", "bestmove e2e4");
    assert.deepStrictEqual(await p, [{ cp: 3, mate: null, pv: ["e2e4"] }]);
    eng.terminate();
  });
});

// ---- defaultPoolSize ------------------------------------------------------------------------
describe("defaultPoolSize", () => {
  let navDescriptor;
  beforeEach(() => { navDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator"); });
  afterEach(() => {
    if (navDescriptor) Object.defineProperty(globalThis, "navigator", navDescriptor);
    else delete globalThis.navigator;
  });
  const setCores = (hardwareConcurrency) =>
    Object.defineProperty(globalThis, "navigator", { value: { hardwareConcurrency }, configurable: true, writable: true });

  it("is half the cores, at least 1 and at most 4", () => {
    const cases = [[1, 1], [2, 1], [4, 2], [8, 4], [16, 4], [64, 4], [undefined, 1]];
    for (const [cores, expected] of cases) {
      setCores(cores);
      assert.equal(defaultPoolSize(), expected, `hardwareConcurrency ${cores}`);
    }
  });

  it("handles odd core counts by rounding down", () => {
    setCores(5);
    assert.equal(defaultPoolSize(), 2);
    setCores(7);
    assert.equal(defaultPoolSize(), 3);
  });

  it("falls back to 1 when navigator does not exist", () => {
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true, writable: true });
    assert.equal(defaultPoolSize(), 1);
  });
});

// ---- createPool -----------------------------------------------------------------------------
describe("createPool", () => {
  it("creates engines lazily: no Worker until an evaluator is used", async () => {
    const pool = createPool(3);
    const ev = pool.evaluatorFor(0);
    pool.evaluatorFor(1);
    assert.equal(FakeWorker.instances.length, 0);
    await ev(START);
    assert.equal(FakeWorker.instances.length, 1);
    pool.terminate();
  });

  it("wraps slot indices modulo size, including negative ones", async () => {
    const pool = createPool(2);
    await pool.evaluatorFor(0)(START);      // slot 0
    await pool.evaluatorFor(2)(START);      // slot 0 again
    await pool.evaluatorFor(4)(START);      // slot 0 again
    assert.equal(FakeWorker.instances.length, 1);
    await pool.evaluatorFor(-1)(START);     // slot 1
    assert.equal(FakeWorker.instances.length, 2);
    await pool.evaluatorFor(3)(START);      // slot 1 again
    await pool.evaluatorFor(-3)(START);     // slot 1 again (-3 mod 2 = 1)
    await pool.evaluatorFor(-2)(START);     // slot 0
    assert.equal(FakeWorker.instances.length, 2);
    const [w0, w1] = FakeWorker.instances;
    assert.equal(w0.goCount, 4);  // evaluators 0, 2, 4, -2
    assert.equal(w1.goCount, 3);  // evaluators -1, 3, -3
    pool.terminate();
  });

  it("different slots use different workers and can search concurrently", async () => {
    FakeWorker.auto.go = false;
    const pool = createPool(2);
    const a = pool.evaluatorFor(0)(START);
    const b = pool.evaluatorFor(1)(AFTER_E4);
    await flush();
    assert.equal(FakeWorker.instances.length, 2);
    assert.equal(FakeWorker.instances[0].goCount, 1);
    assert.equal(FakeWorker.instances[1].goCount, 1);
    FakeWorker.instances[0].reply("info depth 1 score cp 1 pv e2e4", "bestmove e2e4");
    FakeWorker.instances[1].reply("info depth 1 score cp 2 pv e7e5", "bestmove e7e5");
    assert.equal((await a)[0].cp, 1);
    assert.equal((await b)[0].cp, 2);
    pool.terminate();
  });

  it("exposes its size and clamps it to at least 1", () => {
    assert.equal(createPool(4).size, 4);
    assert.equal(createPool(0).size, 1);
    assert.equal(createPool(-5).size, 1);
    assert.equal(createPool(2.9).size, 2);
    assert.equal(createPool(0.5).size, 1);
  });

  it("a size-clamped pool still serves any slot index", async () => {
    const pool = createPool(0);
    await pool.evaluatorFor(7)(START);
    await pool.evaluatorFor(-3)(START);
    assert.equal(FakeWorker.instances.length, 1);
    pool.terminate();
  });

  it("defaults its size to defaultPoolSize()", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      Object.defineProperty(globalThis, "navigator", { value: { hardwareConcurrency: 8 }, configurable: true, writable: true });
      assert.equal(createPool().size, 4);
    } finally {
      if (desc) Object.defineProperty(globalThis, "navigator", desc); else delete globalThis.navigator;
    }
  });

  it("after terminate() every evaluator rejects with 'Engine pool terminated'", async () => {
    const pool = createPool(2);
    const early = pool.evaluatorFor(0);
    await early(START);
    pool.terminate();
    await assert.rejects(early(START), /Engine pool terminated/);
    await assert.rejects(pool.evaluatorFor(1)(START), /Engine pool terminated/);
    await assert.rejects(pool.evaluatorFor(-9)(START), /Engine pool terminated/);
    assert.equal(FakeWorker.instances.length, 1, "no worker is created after terminate");
    assert.equal(FakeWorker.instances[0].terminated, true);
  });

  it("terminate() rejects searches in flight on every slot and terminates their workers", async () => {
    FakeWorker.auto.go = false;
    const pool = createPool(2);
    const a = pool.evaluatorFor(0)(START);
    const b = pool.evaluatorFor(1)(START);
    const sa = assert.rejects(a, /Engine terminated/);
    const sb = assert.rejects(b, /Engine terminated/);
    await flush();
    pool.terminate();
    await sa;
    await sb;
    assert.ok(FakeWorker.instances.every((w) => w.terminated));
  });

  it("terminate() on a pool that was never used is harmless", async () => {
    const pool = createPool(3);
    pool.terminate();
    pool.terminate();
    assert.equal(FakeWorker.instances.length, 0);
    await assert.rejects(pool.evaluatorFor(0)(START), /Engine pool terminated/);
  });
});
