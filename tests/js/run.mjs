// Tests for the browser-side analysis pipeline (site/js/core). Run from the repo root:
//   node tests/js/run.mjs
// No dependencies. Exits non-zero on any failure.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const core = (name) => import(pathToFileURL(path.join(ROOT, "site/js/core", name)).href);
const { Chess } = await import(pathToFileURL(path.join(ROOT, "site/vendor/chess.js")).href);
const { CONFIG } = await core("config.js");
const { normaliseGame, myResult, openingName, openingFamily } = await core("normalise.js");
const { classify, clocksFromPgn, analyseGame } = await core("analyse.js");
const { terminalState } = await core("chessutil.js");
const { tagMistake } = await core("themes.js");
const { buildPuzzles } = await core("puzzles.js");
const { buildStats } = await core("stats.js");
const { ratingBand, pickThemed } = await core("themed.js");
const { explainLine } = await core("explain.js");

// ---- tiny harness ---------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

class Mismatch extends Error {}

/** Deep equality ignoring object key order; throws Mismatch naming the first differing path. */
function deepEqual(a, b, where = "$") {
  if (Object.is(a, b) || a === b) return;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    throw new Mismatch(`${where}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
  if (Array.isArray(a) !== Array.isArray(b)) throw new Mismatch(`${where}: array vs object`);
  if (Array.isArray(a)) {
    if (a.length !== b.length) throw new Mismatch(`${where}: length ${a.length} !== ${b.length}`);
    a.forEach((x, i) => deepEqual(x, b[i], `${where}[${i}]`));
    return;
  }
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) throw new Mismatch(`${where}: keys [${ka}] !== [${kb}]`);
  for (const k of ka) deepEqual(a[k], b[k], `${where}.${k}`);
}
const eq = (actual, expected, label = "value") => {
  try { deepEqual(actual, expected, label); } catch (e) { if (e instanceof Mismatch) throw e; throw e; }
};
const ok = (cond, msg) => { if (!cond) throw new Mismatch(msg); };

// ---- frozen fixture: 25 real games, their analyses, and the expected puzzles and stats ------------
// (generated once with the retired Python pipeline; see tests/fixtures)
const FIX = path.join(ROOT, "tests", "fixtures");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const games = readJson(path.join(FIX, "games.json")).games;
const pairs = [];
for (const game of games) {
  const p = path.join(FIX, "analysis", `${game.id}.json`);
  if (fs.existsSync(p)) pairs.push({ game, analysis: readJson(p) });
}
ok(pairs.length === 25, `expected 25 fixture games, found ${pairs.length}`);

test(`parity: buildPuzzles over ${pairs.length} games equals the fixture`, () => {
  const puzzles = pairs.flatMap(({ game, analysis }) => buildPuzzles(game, analysis));
  puzzles.sort((a, b) => a.end_time - b.end_time || a.ply - b.ply);
  const expected = readJson(path.join(FIX, "puzzles.json")).puzzles;
  ok(expected.length > 0, "expected fixture puzzles to be non-empty");
  eq(puzzles, expected, "puzzles");
});

test("parity: buildStats equals the fixture", () => {
  eq(buildStats(pairs), readJson(path.join(FIX, "stats.json")), "stats");
});

test("parity: chess.js replay reproduces every stored san and uci", () => {
  for (const { game, analysis } of pairs) {
    const chess = new Chess();
    analysis.moves.forEach((m, i) => {
      const mv = chess.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
      ok(mv.san === m.san, `${game.id} ply ${i + 1}: ${mv.san} !== ${m.san}`);
    });
  }
});

test("parity: clocksFromPgn equals stored clk (50 games)", () => {
  const sample = pairs.filter((_, i) => i % Math.max(1, Math.floor(pairs.length / 50)) === 0).slice(0, 50);
  ok(sample.length >= 50 || pairs.length < 50, "sample too small");
  for (const { game, analysis } of sample) {
    const clocks = clocksFromPgn(game.pgn);
    eq(clocks, analysis.moves.map((m) => m.clk ?? null), `clocks ${game.id}`);
  }
});

test("clocksFromPgn: all games, and absent clocks give null", () => {
  for (const { game, analysis } of pairs) {
    eq(clocksFromPgn(game.pgn), analysis.moves.map((m) => m.clk ?? null), `clocks ${game.id}`);
  }
  eq(clocksFromPgn('[Event "x"]\n\n1. e4 e5 2. Nf3 {[%clk 0:00:09.5]} 1-0'), [null, null, 9.5]);
});

// ---- fetch.py fixtures ----------------------------------------------------------------------
const PGN = '[Event "Live Chess"]\n[ECO "B20"]\n[ECOUrl "https://www.chess.com/openings/Sicilian-Defense"]\n\n1. e4 c5 1-0';
const rawGame = (over = {}) => ({
  url: "https://www.chess.com/game/live/123", uuid: "abc", pgn: PGN, rules: "chess", end_time: 1700000000,
  time_class: "blitz", time_control: "180", rated: true,
  white: { username: "RobboSloth", rating: 1200, result: "win" },
  black: { username: "Other", rating: 1250, result: "resigned" },
  ...over,
});

test("normaliseGame: white win", () => {
  const g = normaliseGame(rawGame(), "robbosloth");
  eq(g, {
    id: "abc", url: "https://www.chess.com/game/live/123", end_time: 1700000000, time_class: "blitz",
    time_control: "180", rated: true, colour: "white", result: "win", result_detail: "resigned",
    my_rating: 1200, opponent: "Other", opponent_rating: 1250, eco: "B20", opening: "Sicilian Defense", pgn: PGN,
  });
});

test("normaliseGame: black loss, draws, id from url, missing rating", () => {
  const asBlack = rawGame({
    white: { username: "Other", rating: 1250, result: "win" },
    black: { username: "robbosloth", rating: 1200, result: "timeout" },
  });
  const g = normaliseGame(asBlack, "robbosloth");
  eq([g.colour, g.result, g.result_detail, g.opponent], ["black", "loss", "timeout", "Other"]);
  eq(myResult("repetition"), "draw");
  eq(myResult("checkmated"), "loss");
  const noUuid = normaliseGame(rawGame({ uuid: undefined, white: { username: "robbosloth", result: "win" } }), "robbosloth");
  eq([noUuid.id, noUuid.my_rating], ["123", null]);
});

test("normaliseGame: variants, missing pgn and custom positions are skipped", () => {
  eq(normaliseGame(rawGame({ rules: "chess960" }), "robbosloth"), null);
  eq(normaliseGame(rawGame({ pgn: null }), "robbosloth"), null);
  eq(normaliseGame(rawGame({ pgn: '[SetUp "1"]\n' + PGN }), "robbosloth"), null);
});

test("openingFamily / openingName", () => {
  eq(openingFamily("Caro Kann Defense Exchange Variation 3...cxd5 4.Nf3"), "Caro Kann Defense");
  eq(openingFamily("Queens Pawn Opening Zukertort Chigorin Variation 3.Bf4 Nf6 4.e3"), "Queens Pawn Opening");
  eq(openingFamily("Englund Gambit 2.dxe5 Nc6 3.Nf3"), "Englund Gambit");
  eq(openingFamily("Old Benoni Defense 2.dxc5 e6"), "Old Benoni Defense");
  eq(openingFamily("Nimzo Larsen 1.b3 e5"), "Nimzo Larsen");
  eq(openingFamily(""), "Unknown");
  eq(openingName("https://www.chess.com/openings/Sicilian-Defense/"), "Sicilian Defense");
  eq(openingName(undefined), "");
});

// ---- classify -------------------------------------------------------------------------------
const T = CONFIG.thresholds;
test("classify: thresholds and decided positions", () => {
  eq(classify(49, 0, -49, T, 600), null);
  eq(classify(50, 0, -50, T, 600), "inaccuracy");
  eq(classify(100, 0, -100, T, 600), "mistake");
  eq(classify(200, 0, -200, T, 600), "blunder");
  eq(classify(300, -700, -1000, T, 600), null); // already lost
  eq(classify(300, 1000, 700, T, 600), null); // still winning
  eq(classify(900, 900, 0, T, 600), "blunder"); // threw a win away
});

// ---- themes (ports of tests/test_themes.py) -------------------------------------------------
const tags = (fen, played, best, ctx = {}) => tagMistake(new Chess(fen), played, best, ctx);

test("themes: missed mate, capture, fork", () => {
  const fen = "7k/8/5K2/8/8/8/8/6Q1 w - - 0 5";
  const r = tags(fen, "g1f1", "g1g7", { prev_mate: 1 });
  ok(r.includes("missed_mate") && !r.includes("back_rank"), `got ${r}`);
  ok(!tags(fen, "g1f1", "g1g7", { prev_mate: -1 }).includes("missed_mate"), "other side's mate");
  ok(!tags(fen, "g1g7", "g1g7", { prev_mate: 1 }).includes("missed_mate"), "best move played");
  eq(tags("4k3/8/8/3q4/8/8/8/3QK3 w - - 0 30", "e1f1", "d1d5"), ["missed_capture"]);
  ok(!tags("4k3/3p4/2p5/8/8/8/8/3QK3 w - - 0 30", "e1f1", "d1d7").includes("missed_capture"), "defended pawn");
  eq(tags("r3k3/8/8/1N6/8/8/8/4K3 w - - 0 5", "e1d2", "b5c7"), ["missed_fork"]);
  ok(!tags("4k3/8/8/1N6/8/8/8/4K3 w - - 0 5", "e1d2", "b5c7").includes("missed_fork"), "fork of nothing");
});

test("themes: hung piece, even trade, back rank, endgame, other", () => {
  const fen = "4k3/8/4p3/8/8/8/8/3QK3 w - - 0 30";
  ok(tags(fen, "d1d5", "e1f1", { reply: "e6d5" }).includes("hung_piece"), "hung");
  ok(!tags(fen, "d1d5", "e1f1", { reply: "e8d8" }).includes("hung_piece"), "non-capture reply");
  const trade = new Chess("r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 3");
  ok(!tagMistake(trade, "b5c6", "e1g1", { reply: "d7c6" }).includes("hung_piece"), "even trade");
  const r = tags("6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 20", "e1d2", "a1a8", { prev_mate: 1, pv: ["Ra8#"] });
  ok(r.includes("back_rank") && r.includes("missed_mate"), `got ${r}`);
  const f2 = "r5k1/8/8/8/N7/8/5PPP/6K1 w - - 0 20";
  ok(tags(f2, "a4b6", "h2h3", { reply: "a8a1", mate_after: -1 }).includes("back_rank"), "back rank suffered");
  ok(!tags(f2, "a4b6", "h2h3", { reply: "a8a1", mate_after: null }).includes("back_rank"), "no forced mate");
  eq(tags("4k3/8/8/8/8/8/4P3/4K3 w - - 0 40", "e1d2", "e2e4"), ["endgame"]);
  eq(tags("4k3/8/8/8/8/8/4P3/4K3 w - - 0 5", "e1d2", "e2e4"), ["other"]);
});

test("terminalState follows python-chess game-over rules", () => {
  eq(terminalState(new Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")), "draw"); // stalemate
  eq(terminalState(new Chess("7k/8/8/8/8/8/8/K7 w - - 0 1")), "draw"); // K v K
  eq(terminalState(new Chess("7k/8/8/8/8/8/8/KB6 w - - 0 1")), "draw"); // K+B v K
  eq(terminalState(new Chess("7k/8/8/8/8/8/8/KN4N1 w - - 0 1")), null); // two knights can still be mated
  eq(terminalState(new Chess("7k/8/8/8/8/8/8/KR6 w - - 0 1")), null);
  eq(terminalState(new Chess("5R1k/6pp/8/8/8/8/8/K7 b - - 0 1")), "checkmate");
  eq(terminalState(new Chess("7k/8/8/8/8/8/8/KR6 w - - 150 90")), "draw"); // 75-move rule
});

// ---- analyseGame with a deterministic engine stub -------------------------------------------
// Fool's mate: 1. f3 e5 2. g4 Qh4#. Scores are from the side to move's view, keyed by FEN.
const FEN_AFTER = (() => {
  const c = new Chess();
  const out = [c.fen()];
  for (const san of ["f3", "e5", "g4", "Qh4#"]) { c.move(san); out.push(c.fen()); }
  return out;
})();
const [F0, F1, F2, F3, F4] = FEN_AFTER;
const TABLE = {
  [F0]: [{ cp: 20, mate: null, pv: ["e2e4", "e7e5"] }],
  [F1]: [ // black to move: d5 best, Nf6 close, e5 (played) bad, Nc6 too far behind
    { cp: 40, mate: null, pv: ["d7d5", "e2e4"] },
    { cp: 10, mate: null, pv: ["g8f6"] },
    { cp: -30, mate: null, pv: ["b8c6"] },
    { cp: -150, mate: null, pv: ["e7e5"] },
  ],
  [F2]: [ // white to move: d4 best, e4 within 50, Nc3 not, g4 (played) far worse
    { cp: 150, mate: null, pv: ["d2d4", "d7d5", "c2c4"] },
    { cp: 120, mate: null, pv: ["e2e4"] },
    { cp: 80, mate: null, pv: ["b1c3"] },
    { cp: -200, mate: null, pv: ["g2g4"] },
  ],
  [F3]: [{ cp: null, mate: 1, pv: ["d8h4"] }], // black mates in one
};
function makeEngine(table) {
  const calls = [];
  const evaluate = async (fen, { multipv }) => {
    calls.push({ fen, multipv });
    const lines = table[fen];
    if (!lines) throw new Error(`unexpected evaluate: ${fen}`);
    return lines.slice(0, multipv);
  };
  return { evaluate, calls };
}
const FOOLS = '[Event "t"]\n\n1. f3 {[%clk 0:03:00]} e5 {[%clk 0:02:59.9]} 2. g4 {[%clk 0:02:50]} Qh4# {[%clk 0:02:40.4]} 0-1';

test("analyseGame: white's view, cp sign, mate, terminal position, classes, counts", async () => {
  const { evaluate, calls } = makeEngine(TABLE);
  const a = await analyseGame({ id: "g1", colour: "white", pgn: FOOLS }, evaluate);
  eq(a, {
    id: "g1", depth: 12, start_cp: 20,
    moves: [
      { san: "f3", uci: "f2f3", best: "e4", best_uci: "e2e4", pv: ["e4", "e5"], cp: -40, clk: 180, class: "inaccuracy", drop: 60 },
      // black's move: black's own best was d5, e5 loses 190 (stm cp 40 -> white +150). Opponent's move is labelled, not counted.
      { san: "e5", uci: "e7e5", best: "d5", best_uci: "d7d5", pv: ["d5", "e4"], cp: 150, clk: 179.9, class: "mistake", drop: 190 },
      { san: "g4", uci: "g2g4", best: "d4", best_uci: "d2d4", pv: ["d4", "d5", "c4"], cp: -1000, mate: -1, clk: 170,
        class: "blunder", drop: 1150, alts: ["e2e4"], alts_san: ["e4"] },
      { san: "Qh4#", uci: "d8h4", cp: -1000, mate: 0, clk: 160.4 },
    ],
    counts: { inaccuracy: 1, mistake: 0, blunder: 1 }, alts: 1,
  });
  ok(!calls.some((c) => c.fen === F4), "the checkmated position must not be evaluated");
  eq(calls.map((c) => c.multipv), [1, 1, 1, 1, 4]); // 4 positions, then one alternatives search
  eq(calls[4].fen, F2);
});

test("analyseGame: playing as black counts black's mistakes only and stores alts for them", async () => {
  const { evaluate, calls } = makeEngine(TABLE);
  const a = await analyseGame({ id: "g2", colour: "black", pgn: FOOLS }, evaluate);
  eq(a.counts, { inaccuracy: 0, mistake: 1, blunder: 0 });
  // alts for e5: Nf6 is within 50 of the top line (d5, 40); Nc6 is not; d5 (best) and e5 (played) are excluded.
  eq([a.moves[1].alts, a.moves[1].alts_san], [["g8f6"], ["Nf6"]]);
  ok(!("alts" in a.moves[2]), "opponent's blunder gets no alternatives");
  ok(!("alts" in a.moves[0]), "an inaccuracy gets no alternatives");
  eq(calls.filter((c) => c.multipv === 4).map((c) => c.fen), [F1]);
  eq(a.moves[3].mate, 0);
});

test("analyseGame: cap, mate sign convention, best omitted when played, key presence", async () => {
  const c = new Chess();
  const f = [c.fen()];
  c.move("e4"); f.push(c.fen());
  c.move("e5"); f.push(c.fen());
  const table = {
    [f[0]]: [{ cp: 5000, mate: null, pv: ["e2e4"] }], // capped to +1000, e4 is the engine's choice
    [f[1]]: [{ cp: null, mate: -3, pv: ["e7e5"] }], // black is mated in 3: white mate +3
    [f[2]]: [{ cp: -7000, mate: null, pv: ["g1f3"] }], // white to move, -7000 -> -1000 for white
  };
  const { evaluate } = makeEngine(table);
  const a = await analyseGame({ id: "g3", colour: "black", pgn: "1. e4 e5 *" }, evaluate);
  eq(a, {
    id: "g3", depth: 12, start_cp: 1000,
    moves: [
      { san: "e4", uci: "e2e4", cp: 1000, mate: 3 },
      { san: "e5", uci: "e7e5", cp: -1000 },
    ],
    counts: { inaccuracy: 0, mistake: 0, blunder: 0 }, alts: 1,
  });
});

test("analyseGame: black to move with a positive mate and drawn terminal position", async () => {
  // 1. e4 e5 ... then stalemate is hard to reach legally; check black-perspective conversion instead.
  const c = new Chess();
  const f = [c.fen()];
  c.move("d4"); f.push(c.fen());
  const table = { [f[0]]: [{ cp: 0, mate: null, pv: [] }], [f[1]]: [{ cp: null, mate: 2, pv: ["e7e5"] }] };
  const { evaluate } = makeEngine(table);
  const a = await analyseGame({ id: "g4", colour: "white", pgn: "1. d4 *" }, evaluate);
  // black (side to move) mates in 2: white sees mate -2 and cp -1000. Start had no pv, so no best move.
  eq(a.moves, [{ san: "d4", uci: "d2d4", cp: -1000, mate: -2, class: "blunder", drop: 1000 }]);
  eq(a.counts.blunder, 1);
});

test("parity: analyseGame reproduces every stored analysis when fed the stored scores", async () => {
  // Replay each stored analysis through a stub engine that returns the stored scores and lines,
  // then require analyseGame to rebuild the identical file (classes, drops, best/pv, alts, clk, counts).
  for (const { game, analysis } of pairs) {
    const table = new Map();
    const c = new Chess();
    let prev = { cp: analysis.start_cp, mate: undefined };
    analysis.moves.forEach((m, k) => {
      const turn = c.turn();
      const s = turn === "w" ? 1 : -1;
      const pv = [];
      if (m.best_uci) {
        const scratch = new Chess(c.fen());
        pv.push(m.best_uci);
        scratch.move({ from: m.best_uci.slice(0, 2), to: m.best_uci.slice(2, 4), promotion: m.best_uci[4] });
        for (const san of m.pv.slice(1)) { const r = scratch.move(san); pv.push(r.from + r.to + (r.promotion || "")); }
      } else pv.push(m.uci);
      const line = prev.mate !== undefined ? { cp: null, mate: prev.mate * s, pv } : { cp: prev.cp * s, mate: null, pv };
      const lines = [line];
      if (m.best_uci && (m.class === "mistake" || m.class === "blunder")) {
        for (const a of m.alts || []) lines.push({ cp: line.cp ?? 1000, mate: null, pv: [a] });
        lines.push({ cp: -1000, mate: null, pv: [m.uci] });
        if (line.mate !== null) lines[0] = { cp: 1000, mate: null, pv }; // alternatives are scored by cp only
      }
      table.set(c.fen(), { lines, mateLine: line });
      c.move(m.san);
      prev = { cp: m.cp, mate: m.mate };
    });
    const last = analysis.moves[analysis.moves.length - 1];
    const sLast = c.turn() === "w" ? 1 : -1; // the final position (evaluated unless the game is over)
    table.set(c.fen(), { lines: [], mateLine: last.mate !== undefined ? { cp: null, mate: last.mate * sLast, pv: [] } : { cp: last.cp * sLast, mate: null, pv: [] } });
    const evaluate = async (fen, { multipv }) => {
      const e = table.get(fen);
      if (!e) throw new Error(`unexpected evaluate for ${game.id}: ${fen}`);
      // stored alts can number 4: the multipv-4 search need not contain the 1-line best move
      return multipv === 1 ? [e.mateLine] : e.lines;
    };
    const got = await analyseGame(game, evaluate, { ...CONFIG, depth: analysis.depth });
    eq(got, analysis, `analysis ${game.id}`);
  }
});

// ---- ratingBand / pickThemed ----------------------------------------------------------------
const g = (time_class, my_rating, end_time) => ({ time_class, my_rating, end_time });
test("ratingBand", () => {
  eq(ratingBand([]), 1000);
  eq(ratingBand([g("blitz", null, 1)]), 1000);
  eq(ratingBand([g("blitz", 1000, 1)]), 1200); // (1000 + 300) -> 1300 -> 1200
  eq(ratingBand([g("blitz", 899, 1)]), 1000);
  eq(ratingBand([g("blitz", 300, 1)]), 600); // clamped
  eq(ratingBand([g("blitz", 2500, 1)]), 1800);
  // most-played non-daily class wins; the latest rating in it is used
  eq(ratingBand([g("rapid", 700, 1), g("blitz", 1300, 2), g("blitz", 1100, 5), g("blitz", 1500, 3), g("daily", 2000, 9), g("daily", 2000, 10), g("daily", 2000, 11)]), 1400);
  // only daily games: fall back to daily
  eq(ratingBand([g("daily", 1200, 1)]), 1400);
});

const mk = (tag, n) => Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, tag }));
test("pickThemed: proportions, minimum share, availability, interleaving", () => {
  const pool = { hung_piece: mk("h", 50), missed_fork: mk("f", 50), back_rank: mk("b", 5), endgame: mk("e", 50) };
  const out = pickThemed(pool, { hung_piece: 80, missed_fork: 19, back_rank: 1, other: 40 }, 20);
  const by = (t) => out.filter((p) => p.tag === t).length;
  // 10% minimum = 2 each for fork? shares: 16 / 3.8 / 0.2 -> back_rank lifted to 2, fork to 2 or more
  ok(out.length === 20, `length ${out.length}`);
  ok(by("hung_piece") > by("missed_fork") && by("missed_fork") >= 2 && by("back_rank") >= 2, `mix ${by("hung_piece")}/${by("missed_fork")}/${by("back_rank")}`);
  ok(by("endgame") === 0, "tags with no count are not picked");
  // front of each list, tag kept
  eq(out.filter((p) => p.tag === "hung_piece").map((p) => p.id), mk("h", by("hung_piece")).map((p) => p.id));
  // interleaved: the first few puzzles are not all one tag
  ok(new Set(out.slice(0, 4).map((p) => p.tag)).size >= 2, "first four mix tags");
  // even split when no counts
  const even = pickThemed(pool, {}, 8);
  eq([...new Set(even.map((p) => p.tag))].sort(), ["back_rank", "endgame", "hung_piece", "missed_fork"]);
  eq(even.length, 8);
  // capped by availability
  const capped = pickThemed({ back_rank: mk("b", 3) }, { back_rank: 5 }, 10);
  eq(capped.map((p) => p.id), ["b0", "b1", "b2"]);
  eq(pickThemed({}, {}, 10), []);
  // tag filled in when the pool entries lack it
  eq(pickThemed({ endgame: [{ id: "x" }] }, {}, 1), [{ id: "x", tag: "endgame" }]);
});

// ---- explainLine: plain-English "why is it best?" ---------------------------------------------
const FREE_KNIGHT = "4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1";
const LADDER = "7k/8/8/8/8/8/1R6/R5K1 w - - 0 1";
test("explain: mate in one", () => {
  eq(explainLine("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1", ["Ra8#"]), ["Ra8# is checkmate."]);
});
test("explain: forced mate in two on the back rank", () => {
  eq(explainLine(LADDER, ["Ra7", "Kg8", "Rb8#"]),
    ["Ra7 starts a forced checkmate in 2 moves, because the enemy king is trapped on its back rank."]);
});
test("explain: free capture and capture of a more valuable piece", () => {
  eq(explainLine(FREE_KNIGHT, ["Rxd5"]), ["Rxd5 wins a knight for free."]);
  eq(explainLine("4k3/8/8/4b3/8/2r5/1P6/4K3 w - - 0 1", ["bxc3"]), ["bxc3 wins the rook for your pawn."]);
});
test("explain: fork with check, even trade, castling, moving an attacked piece", () => {
  eq(explainLine("r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1", ["Nc7+"]), ["Nc7+ forks the king and rook."]);
  eq(explainLine("6k1/1p6/2n5/8/8/5B2/8/6K1 w - - 0 1", ["Bxc6"]), ["Bxc6 trades your bishop for the knight."]);
  eq(explainLine("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", ["O-O"]),
    ["O-O gets your king to safety and brings the rook into play."]);
  eq(explainLine("4k3/8/8/3p4/4N3/8/8/4K3 w - - 0 1", ["Nc3"]), ["Nc3 moves your knight away from the attack."]);
});
test("explain: sentence about the move actually played", () => {
  const at = (info) => explainLine(FREE_KNIGHT, ["Rxd5"], info)[1];
  eq(at({ playedSan: "Kd2", tags: ["hung_piece"] }), "Your move Kd2 left a piece where it could be taken.");
  eq(at({ playedSan: "Kd2", tags: ["missed_mate"], drop: 5000 }), "Your move Kd2 let a forced checkmate slip.");
  eq(at({ playedSan: "Kd2", tags: ["other"], drop: 460 }), "Your move Kd2 gave up about 4.6 pawns' worth of advantage.");
  eq(at({ playedSan: "Kd2", tags: ["other"], drop: 1200 }), "Your move Kd2 threw away a winning advantage.");
  eq(explainLine(FREE_KNIGHT, ["Rxd5"], { tags: ["hung_piece"] }).length, 1);
});
test("explain: empty or illegal lines never throw", () => {
  const none = ["No explanation is available for this position."];
  eq(explainLine(LADDER, []), none);
  eq(explainLine(LADDER, ["Qh9"]), none);
  eq(explainLine(LADDER, ["Ra7", "Qh9"]).length, 1);
});

// ---- run ------------------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err instanceof Mismatch ? err.message : err.stack}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
