// Shared fakes for the integration tests. Importing this file installs the browser
// globals the app modules expect (indexedDB, localStorage, navigator, BroadcastChannel,
// Worker, fetch) so it must be imported BEFORE any module under site/js/core.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const coreUrl = (name) => pathToFileURL(path.join(ROOT, "site/js/core", name)).href;
const { Chess } = await import(pathToFileURL(path.join(ROOT, "site/vendor/chess.js")).href);

let bust = 0;
/** Import a core module. With fresh: true the module gets its own state (a new instance). */
export function core(name, { fresh = false } = {}) {
  return import(coreUrl(name) + (fresh ? "?t=" + ++bust : ""));
}

function define(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false });
}

// ---- IndexedDB ----
export function freshIndexedDB() {
  define("indexedDB", new IDBFactory());
  define("IDBKeyRange", IDBKeyRange);
  return globalThis.indexedDB;
}
freshIndexedDB();

// ---- localStorage ----
export class FakeStorage {
  #m = new Map();
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
  clear() { this.#m.clear(); }
}
define("localStorage", new FakeStorage());

// ---- BroadcastChannel: in-process, no handles, so the process can exit ----
export class FakeBroadcastChannel {
  static instances = [];
  constructor(name) { this.name = name; this.onmessage = null; this.closed = false; FakeBroadcastChannel.instances.push(this); }
  postMessage(data) {
    for (const c of FakeBroadcastChannel.instances) {
      if (c !== this && c.name === this.name && !c.closed) {
        queueMicrotask(() => { if (!c.closed && c.onmessage) c.onmessage({ data }); });
      }
    }
  }
  close() { this.closed = true; }
}
define("BroadcastChannel", FakeBroadcastChannel);

// ---- navigator.locks ----
export class FakeLocks {
  held = new Set();   // names "held by another tab" (add to simulate) or by us while a callback runs
  calls = [];         // [{ name, options }]
  waiters = [];       // blocking requests queued behind a held lock: [{ name, grant }]
  async request(name, options, cb) {
    this.calls.push({ name, options });
    if (this.held.has(name)) {
      if (options && options.ifAvailable) return cb(null);
      return new Promise((resolve, reject) => {
        const signal = options && options.signal;
        const waiter = { name, grant: () => { signal?.removeEventListener("abort", onAbort); this.#run(name, cb).then(resolve, reject); } };
        const onAbort = () => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new DOMException("The request was aborted.", "AbortError"));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort);
        this.waiters.push(waiter);
      });
    }
    return this.#run(name, cb);
  }
  async #run(name, cb) {
    this.held.add(name);
    try { return await cb({ name, mode: "exclusive" }); } finally { this.held.delete(name); this.#next(name); }
  }
  #next(name) {
    const i = this.waiters.findIndex((w) => w.name === name);
    if (i >= 0 && !this.held.has(name)) { const [w] = this.waiters.splice(i, 1); w.grant(); }
  }
  /** Simulate the other tab letting go: the next blocking request gets the lock. */
  release(name) { this.held.delete(name); this.#next(name); }
}
export const locks = new FakeLocks();
// 2 cores -> defaultPoolSize() is 1, so analysis is sequential and deterministic.
export const fakeNavigator = { hardwareConcurrency: 2, locks };
define("navigator", fakeNavigator);

// ---- Worker: a tiny UCI engine ----
export class FakeWorker {
  static instances = [];
  static onGo = null; // optional hook called synchronously when any worker receives "go"
  static reset() { FakeWorker.instances = []; FakeWorker.onGo = null; }
  constructor(url) {
    this.url = String(url);
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.fen = null;
    this.multipv = 1;
    this.received = [];
    FakeWorker.instances.push(this);
  }
  #reply(line) {
    queueMicrotask(() => { if (!this.terminated && this.onmessage) this.onmessage({ data: line }); });
  }
  postMessage(msg) {
    if (this.terminated) return;
    this.received.push(msg);
    if (msg === "uci") this.#reply("uciok");
    else if (msg === "isready") this.#reply("readyok");
    else if (msg.startsWith("setoption name MultiPV value ")) this.multipv = parseInt(msg.split(" ").pop(), 10);
    else if (msg.startsWith("position fen ")) this.fen = msg.slice("position fen ".length);
    else if (msg.startsWith("go depth ")) {
      if (FakeWorker.onGo) FakeWorker.onGo(this);
      if (this.terminated) return;
      const depth = parseInt(msg.split(" ")[2], 10);
      const moves = new Chess(this.fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ""));
      moves.slice(0, this.multipv).forEach((uci, i) => {
        this.#reply(`info depth ${depth} seldepth ${depth} multipv ${i + 1} score cp 0 nodes 1 pv ${uci}`);
      });
      this.#reply(moves.length ? "bestmove " + moves[0] : "bestmove (none)");
    }
  }
  terminate() { this.terminated = true; }
}
define("Worker", FakeWorker);

// ---- chess.com game shapes ----
export const pad2 = (n) => String(n).padStart(2, "0");
/** "YYYY-MM" of the current UTC month shifted by delta months (worked out independently of sync.js). */
export function monthStr(delta = 0, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + delta, 1));
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1);
}
/** Unix seconds for day `day` noon UTC of a "YYYY-MM" month. */
export const timeIn = (month, day = 2) => {
  const [y, m] = month.split("-").map(Number);
  return Date.UTC(y, m - 1, day, 12) / 1000;
};
export const archiveUrl = (user, month) => `https://api.chess.com/pub/player/${user}/games/${month.slice(0, 4)}/${month.slice(5)}`;

export const SCHOLARS = ["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"]; // 7 plies, ends in mate
export const QUIET = ["d4", "d5", "c4", "e6", "Nc3", "Nf6"];                // 6 plies
export const ILLEGAL = ["e4", "e4"];                                         // second ply is illegal

export function pgnOf(sans, { white = "me", black = "opp", result = "*" } = {}) {
  let text = "";
  sans.forEach((san, i) => {
    const clk = `{[%clk 0:09:${pad2(59 - i)}.0]}`;
    text += i % 2 === 0 ? `${i / 2 + 1}. ${san} ${clk} ` : `${i / 2 + 0.5}... ${san} ${clk} `;
  });
  return `[Event "Live Chess"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n[ECO "C20"]\n` +
    `[ECOUrl "https://www.chess.com/openings/Kings-Pawn-Opening"]\n\n${text}${result}`;
}

/** A chess.com API game with the user playing white. */
export function rawGame(user, id, endTime, { sans = QUIET, rules = "chess", myResult = "win", oppResult = "resigned" } = {}) {
  return {
    url: "https://www.chess.com/game/live/" + id.replace(/\W/g, ""),
    uuid: id,
    pgn: pgnOf(sans, { white: user, black: "opp", result: "1-0" }),
    time_control: "600",
    time_class: "rapid",
    rules,
    rated: true,
    end_time: endTime,
    white: { username: user, rating: 1234, result: myResult },
    black: { username: "opp", rating: 1200, result: oppResult },
  };
}

// ---- fetch stub: never touches the network; relative URLs are handled too ----
export function createFetchStub() {
  const stub = {
    calls: [],        // every requested URL, in order
    unexpected: [],   // URLs no route knew about
    players: {},      // user -> { months: { "YYYY-MM": [raw games] }, status: { "YYYY-MM": 500 } }
    seed: null,       // username named by data/seed.json, or null for 404
    seedAnalyses: {}, // game id -> body for data/analysis/<id>.json
    themed: {},       // band -> body for data/themed/<band>.json
    reset() {
      stub.calls.length = 0; stub.unexpected.length = 0;
      stub.players = {}; stub.seed = null; stub.seedAnalyses = {}; stub.themed = {};
    },
    monthCalls(user) { return stub.calls.filter((u) => u.startsWith(`https://api.chess.com/pub/player/${user}/games/2`)); },
  };
  const json = (status, body) => new Response(body === undefined ? "" : JSON.stringify(body), { status });
  globalThis.fetch = async (input) => {
    const url = String(input);
    stub.calls.push(url);
    let m;
    if ((m = /^https:\/\/api\.chess\.com\/pub\/player\/([^/]+)\/games\/archives$/.exec(url))) {
      const p = stub.players[decodeURIComponent(m[1])];
      if (!p) return json(404, { code: 0, message: "not found" });
      const user = decodeURIComponent(m[1]);
      return json(200, { archives: Object.keys(p.months).sort().map((mo) => archiveUrl(user, mo)) });
    }
    if ((m = /^https:\/\/api\.chess\.com\/pub\/player\/([^/]+)\/games\/(\d{4})\/(\d{2})$/.exec(url))) {
      const p = stub.players[decodeURIComponent(m[1])];
      const month = m[2] + "-" + m[3];
      if (!p) return json(404, {});
      if (p.status && p.status[month]) return json(p.status[month], {});
      return json(200, { games: p.months[month] || [] });
    }
    if (url === "data/seed.json") return stub.seed ? json(200, { username: stub.seed }) : json(404);
    if ((m = /^data\/analysis\/(.+)\.json$/.exec(url))) {
      const body = stub.seedAnalyses[decodeURIComponent(m[1])];
      return body ? json(200, body) : json(404);
    }
    if ((m = /^data\/themed\/(\d+)\.json$/.exec(url))) {
      const body = stub.themed[m[1]];
      return body ? json(200, body) : json(404);
    }
    stub.unexpected.push(url);
    throw new TypeError("fetch stub: unexpected request " + url);
  };
  return stub;
}

/** Resolves once pending microtasks and the next macrotask have run. */
export const tick = () => new Promise((r) => setImmediate(r));
