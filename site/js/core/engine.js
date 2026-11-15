// Stockfish in a Web Worker, speaking UCI. One search at a time per engine.
import { CONFIG } from "./config.js";

const WORKER_URL = new URL("../../vendor/stockfish/stockfish-18-lite-single.js", import.meta.url);
const TIMEOUT_MS = 60000;
const INIT_TIMEOUT_MS = 30000;

/**
 * Parse one UCI "info" line. Returns { depth, multipv, cp, mate, pv } or null
 * when the line carries no usable score/pv (e.g. "info string", lowerbound /
 * upperbound lines, currmove lines). Scores are from the side to move's view.
 */
export function parseInfo(line) {
  if (typeof line !== "string" || !line.startsWith("info ")) return null;
  const t = line.trim().split(/\s+/);
  if (t[1] === "string") return null; // free text, not a search line
  let depth = null, multipv = 1, cp = null, mate = null, pv = null, scored = false;
  for (let i = 1; i < t.length; i++) {
    const k = t[i];
    if (k === "depth") depth = parseInt(t[++i], 10);
    else if (k === "multipv") multipv = parseInt(t[++i], 10);
    else if (k === "score") {
      const kind = t[++i];
      const val = parseInt(t[++i], 10);
      if (kind === "cp") { cp = val; mate = null; scored = true; }
      else if (kind === "mate") { mate = val; cp = null; scored = true; }
      else return null;
      if (t[i + 1] === "lowerbound" || t[i + 1] === "upperbound") return null;
    } else if (k === "pv") { pv = t.slice(i + 1); break; }
  }
  if (!scored || !pv || !pv.length || !Number.isFinite(depth) || !Number.isFinite(multipv)) return null;
  return { depth, multipv, cp, mate, pv };
}

/**
 * Fold a parsed info into `best` (Map multipv -> info), keeping the deepest
 * depth per multipv index. Returns true when stored.
 */
export function collectInfo(best, info) {
  if (!info) return false;
  const prev = best.get(info.multipv);
  if (prev && prev.depth > info.depth) return false;
  best.set(info.multipv, info);
  return true;
}

/** Ordered result lines in the contract shape [{ cp, mate, pv }], best first. */
export function finishLines(best) {
  return [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ cp: v.cp, mate: v.mate, pv: v.pv }));
}

export function createEngine() {
  let worker = null;
  let ready = null;          // Promise resolved when worker is initialised
  let multipvSet = null;     // MultiPV value last sent to the current worker
  let listener = null;       // current message line handler
  let failCurrent = null;    // rejects the in-flight operation
  let chain = Promise.resolve();
  let terminated = false;

  function kill() {
    if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } }
    worker = null; ready = null; multipvSet = null; listener = null;
  }

  function send(msg) { worker.postMessage(msg); }

  // Wait for a line satisfying `pred`, rejecting on worker error / timeout.
  function waitFor(pred, ms, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        failCurrent = null; listener = null;
        reject(new Error("Engine timed out waiting for " + what));
      }, ms);
      failCurrent = (err) => { clearTimeout(timer); failCurrent = null; listener = null; reject(err); };
      listener = (line) => {
        if (pred(line)) { clearTimeout(timer); failCurrent = null; listener = null; resolve(line); }
      };
    });
  }

  function start() {
    if (terminated) return Promise.reject(new Error("Engine terminated"));
    if (ready) return ready;
    let w;
    try { w = new Worker(WORKER_URL); } catch (e) { return Promise.reject(e); }
    worker = w;
    multipvSet = null;
    w.onmessage = (ev) => {
      if (w !== worker) return;
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      if (listener) listener(data);
    };
    w.onerror = (ev) => {
      if (w !== worker) return;
      const err = new Error("Engine worker error: " + (ev && ev.message ? ev.message : "unknown"));
      const f = failCurrent;
      kill();
      if (f) f(err);
    };
    ready = (async () => {
      try {
        const p1 = waitFor((l) => l === "uciok", INIT_TIMEOUT_MS, "uciok");
        send("uci"); await p1;
        const p2 = waitFor((l) => l === "readyok", INIT_TIMEOUT_MS, "readyok");
        send("isready"); await p2;
      } catch (e) { kill(); throw e; }
    })();
    return ready;
  }

  async function search(fen, multipv, depth) {
    await start();
    if (multipvSet !== multipv) {
      send("setoption name MultiPV value " + multipv);
      multipvSet = multipv;
    }
    const best = new Map();
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        failCurrent = null; listener = null;
        reject(new Error("Engine search timed out"));
      }, TIMEOUT_MS);
      failCurrent = (err) => { clearTimeout(timer); failCurrent = null; listener = null; reject(err); };
      listener = (line) => {
        if (line.startsWith("info ")) collectInfo(best, parseInfo(line));
        else if (line.startsWith("bestmove")) {
          clearTimeout(timer); failCurrent = null; listener = null; resolve();
        }
      };
    });
    send("position fen " + fen);
    send("go depth " + depth);
    try { await done; }
    catch (e) { kill(); throw e; }   // restart a fresh worker on the next call
    return finishLines(best);
  }

  function evaluate(fen, opts = {}) {
    const multipv = Math.max(1, opts.multipv | 0 || 1);
    const depth = opts.depth || CONFIG.depth;
    const run = () => search(fen, multipv, depth);
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  function terminate() {
    terminated = true;
    const f = failCurrent;
    kill();
    if (f) f(new Error("Engine terminated"));
  }

  return { evaluate, terminate };
}

export function defaultPoolSize() {
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2;
  return Math.min(4, Math.max(1, Math.floor(cores / 2)));
}

/** N engines, created lazily. evaluatorFor(i) gives the evaluate function for slot i. */
export function createPool(size = defaultPoolSize()) {
  const n = Math.max(1, size | 0);
  const engines = new Array(n).fill(null);
  let closed = false;
  function evaluatorFor(i) {
    return (fen, opts) => {
      if (closed) return Promise.reject(new Error("Engine pool terminated"));
      const slot = ((i % n) + n) % n;
      if (!engines[slot]) engines[slot] = createEngine();
      return engines[slot].evaluate(fen, opts);
    };
  }
  function terminate() {
    closed = true;
    for (const e of engines) if (e) e.terminate();
    engines.fill(null);
  }
  return { evaluatorFor, size: n, terminate };
}
