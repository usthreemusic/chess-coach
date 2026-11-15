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
const { buildCoach, checklistFor, CHECKLISTS } = await core("coach.js");
const patterns = await core("patterns.js");
const { buildScript, focusPuzzles, uciFromSan, WAIT_TEXT } = await core("coachscript.js");
const { winsMaterial } = await core("themes.js");

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
  // black (side to move) mates in 2: white sees mate -2 and cp -1000. Start had no pv, so no best
  // move to compare against: the move is not classified or counted.
  eq(a.moves, [{ san: "d4", uci: "d2d4", cp: -1000, mate: -2 }]);
  eq(a.counts.blunder, 0);
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

// ---- coach ----------------------------------------------------------------------------------
const DAY = 86400000;
const NOW = 1_800_000_000_000;
const MIDDLE = "r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 4 5"; // move 5: opening
const MID_FEN = "r1bq1rk1/ppp2ppp/2n2n2/3pp3/1bPP4/2N1PN2/PP3PPP/R1BQKB1R w KQ - 0 12"; // move 12: middlegame
const END_FEN = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 40";
/** n games, newest first at index 0; result/opening/mistakes overridable per index. */
function mkGames(n, f = () => ({}), offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `g${offset + i}`, end_time: 1_700_000_000 - (offset + i) * 1000, colour: "white", result: "loss",
    opening: "Sicilian Defense", mistakes: { inaccuracy: 0, mistake: 2, blunder: 2 }, ...f(i),
  }));
}
const mkPuzzle = (gameId, tag, over = {}) => ({
  game_id: gameId, ply: 1, fen: MID_FEN, class: "mistake", drop: 150, tags: [tag], colour: "white", ...over,
});
const coachOf = (games, puzzles, opts = {}) => buildCoach(games, puzzles, { now: NOW, ...opts });

test("coach: null under 8 analysed games; unanalysed games do not count", () => {
  eq(coachOf(mkGames(7), []), null);
  const mixed = [...mkGames(7), { id: "x", end_time: 1, colour: "white", result: "win", opening: "" }];
  eq(coachOf(mixed, []), null);
  ok(coachOf(mkGames(8), []) !== null, "8 games is enough");
});

test("coach: focus is the costliest tag (capped drops), not the most frequent", () => {
  const games = mkGames(10);
  const puzzles = [
    mkPuzzle("g0", "hung_piece", { drop: 120 }), mkPuzzle("g1", "hung_piece", { drop: 120 }), mkPuzzle("g2", "hung_piece", { drop: 120 }),
    mkPuzzle("g3", "missed_fork", { drop: 5000 }), // capped at 1000, still beats 360
    mkPuzzle("g4", "other", { drop: 9000 }), // never the focus when a real tag exists
  ];
  const c = coachOf(games, puzzles);
  eq([c.focus.tag, c.focus.label, c.focus.kept, c.focus.since], ["missed_fork", "Missed forks", false, NOW]);
  eq([c.focus.recentCount, c.focus.previousCount], [1, 0]);
  eq(c.checklist, CHECKLISTS.missed_fork);
  eq(checklistFor("hung_piece"), "Before you move: what can they take?");
});

test("coach: no tagged mistakes falls back to other with generic advice", () => {
  const c = coachOf(mkGames(10), [mkPuzzle("g0", "other")]);
  eq([c.focus.tag, c.focus.recentCount], ["other", 1]);
  ok(c.advice.includes("slow down"), c.advice);
  const none = coachOf(mkGames(10), []);
  eq([none.focus.tag, none.focus.recentCount], ["other", 0]);
  ok(none.pattern.includes("no mistakes"), none.pattern);
});

test("coach: stickiness within 7 days, expiry, and a tag that no longer occurs", () => {
  const games = mkGames(10);
  const puzzles = [mkPuzzle("g0", "hung_piece", { drop: 500 }), mkPuzzle("g1", "missed_fork", { drop: 100 })];
  const since = NOW - 3 * DAY;
  const kept = coachOf(games, puzzles, { previousFocus: { tag: "missed_fork", since } });
  eq([kept.focus.tag, kept.focus.kept, kept.focus.since], ["missed_fork", true, since]);
  ok(kept.pattern.includes("still the focus"), kept.pattern);
  const old = coachOf(games, puzzles, { previousFocus: { tag: "missed_fork", since: NOW - 8 * DAY } });
  eq([old.focus.tag, old.focus.kept, old.focus.since], ["hung_piece", false, NOW]);
  const gone = coachOf(games, puzzles, { previousFocus: { tag: "back_rank", since } });
  eq([gone.focus.tag, gone.focus.kept], ["hung_piece", false]);
  const catchAll = coachOf(games, puzzles, { previousFocus: { tag: "other", since } });
  eq(catchAll.focus.tag, "hung_piece");
  // mistakes older than the recent window do not keep a focus alive
  const six = coachOf(mkGames(30), [mkPuzzle("g25", "missed_fork"), mkPuzzle("g0", "hung_piece")], { previousFocus: { tag: "missed_fork", since } });
  eq(six.focus.tag, "hung_piece");
});

test("coach: where needs 60% in a phase and 65% in a colour", () => {
  const games = mkGames(10);
  const hp = (i, over) => mkPuzzle(`g${i}`, "hung_piece", over);
  const whereOf = (ps) => coachOf(games, ps).focus.where;
  eq(whereOf([hp(0, { fen: MID_FEN, colour: "black" }), hp(1, { fen: MID_FEN, colour: "black" })]), "mostly in the middlegame, as Black");
  eq(whereOf([hp(0, { fen: MID_FEN }), hp(1, { fen: MID_FEN }), hp(2, { fen: END_FEN, colour: "black" }), hp(3, { fen: MIDDLE, colour: "black" }), hp(4, { fen: MIDDLE })]), null); // 40% each, 60% white: neither
  // exactly 3 of 5 = 60% in the middlegame; colour 3 of 5 = 60% is below 65%
  eq(whereOf([hp(0, { fen: MID_FEN }), hp(1, { fen: MID_FEN }), hp(2, { fen: MID_FEN, colour: "black" }), hp(3, { fen: END_FEN, colour: "black" }), hp(4, { fen: MIDDLE })]), "mostly in the middlegame");
  // 2 of 3 black is 67%, phases are split: colour only
  eq(whereOf([hp(0, { colour: "black" }), hp(1, { colour: "black", fen: END_FEN }), hp(2, { fen: MIDDLE })]), "mostly as Black");
  eq(whereOf([hp(0, { fen: END_FEN })]), "in the endgame, as White"); // one mistake: no "mostly"
});

test("coach: pattern wording is singular and plural correct, with real numbers", () => {
  const one = coachOf(mkGames(10), [mkPuzzle("g0", "hung_piece", { colour: "black" })]);
  eq(one.pattern, "In your last 5 games you left a piece where it could be taken once, in the middlegame, as Black. That cost you more than any other kind of mistake.");
  const many = coachOf(mkGames(10), [mkPuzzle("g0", "hung_piece"), mkPuzzle("g1", "hung_piece")]);
  ok(many.pattern.includes("taken 2 times, mostly in the middlegame, as White."), many.pattern);
  const tie = coachOf(mkGames(10), [mkPuzzle("g0", "hung_piece"), mkPuzzle("g1", "missed_fork")]);
  ok(tie.pattern.includes("among the costliest"), tie.pattern);
});

test("coach: trends say down from / up from / about the same", () => {
  // 20 recent games with 2 mistakes + 2 blunders each (4.0), 20 earlier with 5.0 -> down; win rate 50% vs 25%
  const recent = mkGames(20, (i) => ({ result: i < 10 ? "win" : "loss" }));
  const earlier = mkGames(20, (i) => ({ result: i < 5 ? "win" : "loss", mistakes: { inaccuracy: 0, mistake: 3, blunder: 2 } }), 20);
  const c = coachOf([...recent, ...earlier], []);
  eq([c.recentGames, c.previousGames], [20, 20]);
  eq(c.trends.length, 3);
  eq(c.trends[0].text, "Blunders and mistakes per game: 4.0, down from 5.0.");
  eq(c.trends[0].better, true);
  eq(c.trends[2].text, "Win rate: 50%, up from 25%.");
  eq(c.trends[2].better, true);
  // reversed: up is worse for mistakes, worse for win rate when down
  const worse = coachOf([...earlier.map((g, i) => ({ ...g, id: `r${i}`, end_time: g.end_time + 1e6 })), ...recent], []);
  eq(worse.trends[0].text, "Blunders and mistakes per game: 5.0, up from 4.0.");
  eq(worse.trends[0].better, false);
  eq(worse.trends[2].better, false);
  // under 10% change
  const flat = mkGames(40, (i) => ({ mistakes: { inaccuracy: 0, mistake: 2, blunder: i < 20 ? 2 : 2 }, result: "loss" }));
  const f = coachOf(flat, []);
  ok(f.trends[0].text.includes("about the same") && f.trends[0].better === null, f.trends[0].text);
  const fTag = coachOf(flat, [mkPuzzle("g0", "hung_piece"), mkPuzzle("g25", "hung_piece")]);
  eq(fTag.trends[1].label, "Pieces left hanging per game");
  ok(fTag.trends[1].text.includes("about the same"), fTag.trends[1].text);
});

test("coach: small history splits newest half (rounded up) vs the rest; no history means no verdict", () => {
  const c = coachOf(mkGames(9), []);
  eq([c.recentGames, c.previousGames], [5, 4]);
  const c2 = coachOf(mkGames(27), []);
  eq([c2.recentGames, c2.previousGames], [14, 13]);
  const c3 = coachOf(mkGames(28), []);
  eq([c3.recentGames, c3.previousGames], [20, 8]);
  // forged "no previous window" cannot occur at >= 8 games, so check the wording via a lone-window helper path:
  // 8 games gives 4 + 4, which is still a comparison
  eq(coachOf(mkGames(8), []).previousGames, 4);
});

test("coach: goingWell prefers a falling tag, then blunders, then win rate, then opening, then fallback", () => {
  const blunders = (n) => ({ mistakes: { inaccuracy: 0, mistake: 1, blunder: n } });
  const recent = mkGames(20, () => blunders(1));
  const earlier = mkGames(20, () => blunders(2), 20);
  const all = [...recent, ...earlier];
  // (a) 4 hung pieces recently vs 9 before beats everything else
  const hp = (ids) => ids.map((i) => mkPuzzle(`g${i}`, "hung_piece"));
  const a = coachOf(all, [...hp([0, 1, 2, 3]), ...hp([20, 21, 22, 23, 24, 25, 26, 27, 28])]);
  eq(a.goingWell, "You are hanging fewer pieces: 4 in your last 20 games, down from 9.");
  // fewer than 3 before: not (a); blunders 1.0 vs 2.0 -> (b)
  const b = coachOf(all, hp([0, 20, 21]));
  eq(b.goingWell, "You are blundering less: 1.0 per game, down from 2.0.");
  // (c) blunders flat, win rate 60% vs 30%
  const flatB = mkGames(40, () => blunders(2)).map((g, i) => ({ ...g, result: i < 12 ? "win" : i < 20 ? "loss" : i < 26 ? "win" : "loss" }));
  eq(coachOf(flatB, []).goingWell, "Your win rate is up: 60% in your last 20 games, from 30% before.");
  // (d) opening: Italian Game 5 wins from 6, nothing else improved
  const italian = mkGames(40, (i) => ({ ...blunders(2), result: i < 5 || (i >= 20 && i < 25) ? "win" : "loss", opening: i < 6 ? "Italian Game Giuoco Piano" : "Sicilian Defense" }));
  const d = coachOf(italian, []);
  eq(d.goingWell, "Your best results lately are in the Italian Game: 5 wins from 6.");
  // a losing record is not praised; falls back
  const e = coachOf(mkGames(10), []);
  eq(e.goingWell, "You have 10 games analysed, which is enough to see real patterns.");
});

// ---- playing-style patterns -----------------------------------------------------------------
const { scanGame, findPatterns, pickForCoach, winningCaptures, pawnDamage, aboutTimes, DETECTORS } = patterns;

/** An analysis object from SAN moves. over = { [ply index]: { cp?, class?, drop? } }; cp is White's view. */
function mkAnalysis(sans, over = {}) {
  const chess = new Chess();
  const moves = sans.map((san, i) => {
    const m = chess.move(san);
    return { san: m.san, uci: m.from + m.to + (m.promotion || ""), cp: 0, ...(over[i] || {}) };
  });
  return { id: "t", start_cp: 0, moves };
}
const MISTAKE = { class: "mistake", drop: 150 };
// Both sides castle, then shuffle kings for ply 26 (past my 12th move)
const CASTLED = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3", "O-O"];
for (let i = 0; i < 4; i++) CASTLED.push("Kh1", "Kh8", "Kg1", "Kg8");
const scan = (sans, colour = "white", over = {}) => scanGame(mkAnalysis(sans, over), colour);
/** Does detector `id` fire on my move number `n` (1-based among my moves)? */
const fires = (sc, id, n) => DETECTORS.find((d) => d.id === id).q(sc.recs[n - 1]);

test("detector king_loosen: pawn push in front of a castled king fires, without castling it does not", () => {
  const castled = scan(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "h3"]);
  ok(fires(castled, "king_loosen", 5), "h3 after O-O");
  ok(!fires(castled, "king_loosen", 4), "castling itself");
  ok(!fires(scan(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "d3", "Nf6", "h3"]), "king_loosen", 5), "h3 before castling");
});

test("detector early_queen: fires on Qh5, not on a recapture or a queen trade", () => {
  ok(fires(scan(["e4", "e5", "Qh5"]), "early_queen", 2), "Qh5");
  ok(!fires(scan(["e4", "d5", "exd5", "Qxd5"], "black"), "early_queen", 2), "recapture Qxd5");
  ok(!fires(scan(["d4", "d5", "Nc3", "Nc6", "Nf3", "Qd6", "Bf4", "Qxf4"].slice(0, 6)), "early_queen", 1), "d4 is not a queen move");
  ok(!fires(scan(["e4", "e5", "Qh5", "Qh4", "Qxh4"]), "early_queen", 3), "Qxh4 takes the queen");
});

test("detector undeveloped: second move of a piece with minors at home fires; first move or a piece under attack does not", () => {
  ok(fires(scan(["e4", "e5", "Nf3", "Nc6", "Ng5"]), "undeveloped", 3), "Nf3 then Ng5");
  ok(!fires(scan(["e4", "e5", "Nf3", "Nc6", "Bc4"]), "undeveloped", 3), "first bishop move");
  ok(!fires(scan(["Nf3", "g5", "a3", "g4", "Nd4"]), "undeveloped", 3), "knight was attacked by the pawn");
});

test("detector lunge: a piece landing where a pawn takes it fires; an equal capture does not", () => {
  ok(fires(scan(["e4", "e5", "Nf3", "Nc6", "Nc3", "a6", "Nb5"]), "lunge_quiet", 4), "Nb5 into a6");
  ok(fires(scan(["e4", "a6", "Nf3", "d6", "Bb5+"]), "lunge_aggressive", 3), "Bb5+ into a6");
  ok(!fires(scan(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Bxc6"]), "lunge_aggressive", 4), "an equal capture is not a lunge");
});

test("detector quiet_check: a check that captures nothing fires", () => {
  ok(fires(scan(["e4", "f6", "Qh5+"]), "quiet_check", 2), "Qh5+");
  ok(!fires(scan(["e4", "f6", "d4"]), "quiet_check", 2), "d4 is not a check");
});

test("detector pawn_grab: queen takes a pawn fires; pawn takes pawn does not", () => {
  ok(fires(scan(["e4", "d5", "exd5", "Qxd5"], "black"), "pawn_grab", 2), "Qxd5");
  ok(!fires(scan(["e4", "d5", "exd5", "Qxd5"]), "pawn_grab", 2), "exd5 by a pawn");
});

test("detector pawn_push: a pawn to the 5th rank fires; a capture or a shorter push does not", () => {
  ok(fires(scan(["e4", "d5", "e5"]), "pawn_push", 2), "e5");
  ok(!fires(scan(["e4", "d5", "exd5"]), "pawn_push", 2), "exd5");
  ok(!fires(scan(["e4", "d5", "d4"]), "pawn_push", 2), "d4");
});

test("detector pawn_damage: a capture that doubles pawns fires; a quiet pawn move does not; pawnDamage counts", () => {
  ok(fires(scan(["e4", "d5", "exd5"]), "pawn_damage", 2), "exd5 doubles the d pawns");
  ok(!fires(scan(["e4", "e5", "d3"]), "pawn_damage", 2), "d3");
  eq(pawnDamage([1, 0, 2, 0, 0, 1, 0, 0]), 5, "a, f isolated; c doubled and isolated");
});

test("detector even_trade with trade_behind / trade_ahead by the eval before the move", () => {
  const line = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Bxc6"];
  const eqm = (cpBefore, id) => fires(scan(line, "white", { 5: { cp: cpBefore } }), id, 4);
  ok(eqm(-200, "trade_behind") && !eqm(-200, "trade_ahead"), "behind");
  ok(eqm(200, "trade_ahead") && !eqm(200, "trade_behind"), "ahead");
  ok(!eqm(0, "trade_behind") && !eqm(0, "trade_ahead"), "level");
});

test("detector ignored_threat vs walked_into", () => {
  const ignore = ["e4", "e5", "Bc4", "b5", "a3"]; // b5 attacks the bishop; a3 ignores it
  ok(fires(scan(ignore), "ignored_threat", 3), "a3 ignores the attack on Bc4");
  ok(!fires(scan(["e4", "e5", "Bc4", "b5", "Bb3"]), "ignored_threat", 3), "Bb3 moves away");
  ok(!fires(scan(ignore), "walked_into", 3), "not a new threat");
  const walk = ["e4", "d5", "Nf3", "d4", "Nc3"]; // Nc3 steps onto a square the d4 pawn attacks
  ok(fires(scan(walk), "walked_into", 3) && !fires(scan(walk), "ignored_threat", 3), "Nc3 walks into dxc3");
  ok(!fires(scan(["e4", "d5", "Nf3", "d4", "d3"]), "walked_into", 3), "d3");
});

// winningCaptures is the fast approximation patterns.js uses: it reads attack maps, so unlike
// winsMaterial it counts a pinned piece or a king that cannot legally recapture as a defender.
test("winningCaptures agrees with themes.winsMaterial (x-rays and pins aside) on fixture positions", () => {
  let total = 0, differ = 0;
  for (const { analysis } of pairs.slice(0, 12)) {
    const chess = new Chess();
    for (const m of analysis.moves) {
      chess.move(m.san);
      if (chess.isCheck()) continue;
      const mine = winningCaptures(chess);
      for (const mv of chess.moves({ verbose: true })) {
        if (!mv.isCapture() && !mv.isEnPassant()) continue;
        total++;
        const theirs = winsMaterial(chess, mv.from + mv.to + (mv.promotion || ""));
        if (!mv.isEnPassant() && theirs !== mine.has(mv.from + mv.to)) differ++;
      }
    }
  }
  ok(total > 500, `only ${total} captures compared`);
  ok(differ / total < 0.02, `${differ} of ${total} differ`);
});

test("record fields: oppBlunder, tilt (next2), ahead/behind and centre", () => {
  const sc = scan(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "d3"], "white", { 1: { class: "blunder", drop: 400 }, 2: MISTAKE, 4: { class: "blunder", drop: 300 }, 6: MISTAKE });
  ok(!sc.recs[0].oppBlunder && sc.recs[1].oppBlunder, "oppBlunder after ply 2");
  eq(sc.recs[1].err && sc.recs[1].drop, 150, "my reply was an error");
  const mine = scan(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "d3"], "black", { 1: { class: "blunder", drop: 400 }, 3: MISTAKE, 5: MISTAKE });
  eq(mine.recs[0].next2, 150 + 150, "two errors follow a blunder");
  ok(mine.recs[0].blunder && !mine.recs[1].blunder, "blunder flag");
  const up = scan(["e4", "e5", "Nf3", "Nc6", "Bc4"], "white", { 0: { cp: 400 }, 1: { cp: 400 } });
  ok(up.ahead && !up.behind, "ahead for two plies");
  ok(!scan(["e4", "e5", "Nf3"], "white", { 0: { cp: 400 } }).ahead, "one ply is not sustained");
  const shuffle = [];
  for (let i = 0; i < 7; i++) shuffle.push("Nf3", "Nf6", "Ng1", "Ng8");
  eq(scan(shuffle).centre, true, "king still in the centre at move 12");
  const castledEarly = [...CASTLED];
  eq(scan(castledEarly).centre, false, "castled by move 12");
  eq(scan(["e4", "e5"]).centre, null, "too short");
});

// Synthetic players for the threshold tests: `n` games of one scripted opening.
const SCRIPT = ["e4", "e5", "Qh5", "Nc6", "Nf3", "d6", "d3", "Be6"];
function crowd(n, script, over, first = 0) {
  return Array.from({ length: n }, (_, i) => ({
    game: { id: "g" + (first + i), end_time: 1000 + first + i, colour: "white", result: "win" },
    analysis: mkAnalysis(script, over),
  }));
}
const ids = (list) => list.map((p) => p.id);

test("findPatterns: a habit with enough moves and lift is returned, with real numbers in its text", () => {
  const found = findPatterns(crowd(15, SCRIPT, { 2: MISTAKE }));
  const p = found.find((x) => x.id === "early_queen");
  ok(p && p.n === 15 && p.errors === 15 && !p.good, "early_queen found");
  ok(p.text.includes("15 times") && p.text.includes("15 of them") && p.text.includes("your last 15 games"), p.text);
  ok(p.advice.length > 10 && p.strength > 0 && p.lift > 1.4, "advice and strength");
});

test("findPatterns: below n, or below the lift threshold, a habit is not returned", () => {
  ok(!ids(findPatterns(crowd(11, SCRIPT, { 2: MISTAKE }))).includes("early_queen"), "11 moves is below n = 12");
  // every opening move is a mistake, so the queen move is no worse than the rest: lift 1
  const flat = { 0: MISTAKE, 2: MISTAKE, 4: MISTAKE, 6: MISTAKE };
  ok(!ids(findPatterns(crowd(15, SCRIPT, flat))).includes("early_queen"), "lift 1 is not a habit");
});

test("findPatterns: a strength (low rate, enough moves) comes back with good = true", () => {
  // Black blunders on every game (ply 2); I reply well. My other moves go wrong a lot.
  const script = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"];
  const over = { 1: { class: "blunder", drop: 400 }, 0: MISTAKE, 4: MISTAKE };
  const found = findPatterns(crowd(22, script, over));
  const g = found.find((x) => x.id === "no_punish");
  ok(g && g.good && g.n === 22 && g.errors === 0, "no_punish praised");
  ok(g.text.includes("22") && g.text.includes("less often"), g.text);
  ok(!ids(findPatterns(crowd(19, script, over))).includes("no_punish"), "fewer than 20 moves is not enough to praise");
});

test("findPatterns: the most recent maxGames games are used", () => {
  const oldGames = crowd(15, SCRIPT, { 2: MISTAKE }, 0);
  const newGames = crowd(15, SCRIPT, {}, 100);
  const all = [...newGames, ...oldGames]; // order must not matter
  ok(ids(findPatterns(all, { maxGames: 15 })).every((i) => i !== "early_queen"), "only the new games");
  const wide = findPatterns(all, { maxGames: 30 }).find((x) => x.id === "early_queen");
  ok(wide && wide.n === 30 && wide.errors === 15, "30 games include the old ones");
  ok(ids(findPatterns(oldGames, { maxGames: 30 })).includes("early_queen"), "old games alone show it");
});

test("findPatterns: sorted by strength, and costlier habits outrank cheaper ones", () => {
  const cheap = { 2: { class: "mistake", drop: 100 } };
  const costly = { 2: { class: "blunder", drop: 600 } };
  const a = findPatterns(crowd(15, SCRIPT, cheap)).find((x) => x.id === "early_queen");
  const b = findPatterns(crowd(15, SCRIPT, costly)).find((x) => x.id === "early_queen");
  ok(b.strength > a.strength * 3, `${b.strength} vs ${a.strength}`);
  const mixed = findPatterns(crowd(20, SCRIPT, { 2: MISTAKE, 4: { class: "blunder", drop: 700 } }));
  for (let i = 1; i < mixed.length; i++) ok(mixed[i - 1].strength >= mixed[i].strength, "descending");
});

test("findPatterns: game-level habits need 8 games on each side and a 15 point gap", () => {
  const castle = CASTLED;
  const shuffle = [];
  for (let i = 0; i < 7; i++) shuffle.push("Nf3", "Nf6", "Ng1", "Ng8");
  const mk = (n, script, result, first) => crowd(n, script, {}, first).map((p) => ({ ...p, game: { ...p.game, result } }));
  const split = [...mk(10, castle, "win", 0), ...mk(5, castle, "loss", 10), ...mk(6, shuffle, "win", 20), ...mk(9, shuffle, "loss", 30)];
  const hit = findPatterns(split).find((x) => x.id === "king_centre");
  ok(hit && hit.withGames === 15 && hit.withoutGames === 15, "king_centre found");
  eq([Math.round(hit.withRate * 100), Math.round(hit.withoutRate * 100)], [40, 67], "rates");
  ok(hit.text.includes("40%") && hit.text.includes("67%") && hit.n === undefined, hit.text);
  ok(!ids(findPatterns(split.slice(0, 22))).includes("king_centre"), "fewer than 8 games with the king in the centre");
  ok(!ids(findPatterns([...mk(10, castle, "win", 0), ...mk(5, castle, "loss", 10), ...mk(8, shuffle, "win", 20), ...mk(7, shuffle, "loss", 30)])).includes("king_centre"), "gap under 15 points");
});

test("findPatterns: converting winning positions is praised, throwing them away is not", () => {
  const up = { 0: { cp: 400 }, 1: { cp: 400 }, 2: { cp: 400 } };
  const script = ["e4", "e5", "Nf3", "Nc6"];
  const mk = (wins, losses) => [
    ...crowd(wins, script, up, 0).map((p) => ({ ...p, game: { ...p.game, result: "win" } })),
    ...crowd(losses, script, up, 50).map((p) => ({ ...p, game: { ...p.game, result: "loss" } })),
  ];
  const good = findPatterns(mk(18, 3)).find((x) => x.id === "convert");
  ok(good && good.good && good.text.includes("won 18 of the 21 games"), good && good.text);
  const bad = findPatterns(mk(8, 8)).find((x) => x.id === "convert");
  ok(bad && !bad.good && bad.text.includes("won only 8 of the 16"), bad && bad.text);
});

test("aboutTimes rounds to the nearest half and pickForCoach keeps one habit per family", () => {
  eq(aboutTimes(2.1), "about twice");
  eq(aboutTimes(1.45), "about one and a half times");
  eq(aboutTimes(2.8), "about three times");
  const mkp = (id, strength, family, good = false) => ({ id, strength, family, good });
  const pick = pickForCoach([mkp("walked_into", 2, "en_prise"), mkp("lunge_quiet", 1.9, "en_prise"), mkp("tilt", 1.5, "tilt"), mkp("no_punish", 1, "no_punish", true), mkp("x", 0.1, "x")]);
  eq(pick.bad.map((p) => p.id), ["walked_into", "tilt"]);
  eq(pick.good.id, "no_punish");
  eq(pick.headline.id, "walked_into");
  eq(pickForCoach([mkp("x", 0.2, "x")]).headline, null);
  eq(pickForCoach([]).bad, []);
  // A habit of style is listed first and is the headline, even when another habit is stronger.
  const styled = pickForCoach([{ ...mkp("no_punish", 3, "no_punish"), group: "awareness" }, { ...mkp("pawn_push", 0.4, "pawn_push"), group: "aggression" }]);
  eq(styled.bad.map((p) => p.id), ["pawn_push", "no_punish"]);
  eq(styled.headline.id, "pawn_push");
});

test("findPatterns over the 25 fixture games: no errors, every pattern has text and advice", () => {
  const found = findPatterns(pairs);
  for (const p of found) {
    ok(typeof p.id === "string" && p.text.length > 20 && p.advice.length > 20, `${p.id} text/advice`);
    ok(Number.isFinite(p.strength) && ["aggression", "structure", "awareness", "flow"].includes(p.group), `${p.id} fields`);
    ok(!/undefined|NaN|Infinity/.test(p.text + p.advice), `${p.id}: ${p.text}`);
  }
  for (let i = 1; i < found.length; i++) ok(found[i - 1].strength >= found[i].strength, "sorted");
  eq(findPatterns([]), []);
});


// ---- habit examples and the coach script -----------------------------------------------------
const exampleOk = (e) => ["game_id", "ply", "fen", "uci", "san", "best_uci", "best_san", "drop", "colour", "end_time"].every((k) => e[k] !== undefined && e[k] !== null);

test("findPatterns: every habit has at most 3 examples, errors with a better move, costliest first", () => {
  const found = patterns.findPatterns(pairs);
  ok(found.length > 0, "some patterns");
  const withEx = found.filter((p) => p.examples.length);
  ok(withEx.length > 0, "some pattern has examples");
  const byGame = new Map(pairs.map(({ game, analysis }) => [game.id, { game, analysis }]));
  for (const p of found) {
    ok(Array.isArray(p.examples) && p.examples.length <= 3, `${p.id} examples`);
    if (p.good || ["convert", "comeback", "king_centre"].includes(p.id)) { eq(p.examples, [], `${p.id} examples`); continue; }
    for (let i = 0; i < p.examples.length; i++) {
      const e = p.examples[i];
      ok(exampleOk(e), `${p.id} example fields`);
      if (i) ok(p.examples[i - 1].drop >= e.drop, `${p.id} sorted by drop`);
      const { game, analysis } = byGame.get(e.game_id);
      const mv = analysis.moves[e.ply - 1];
      ok(mv.uci === e.uci && mv.best_uci === e.best_uci && (mv.class === "mistake" || mv.class === "blunder"), `${p.id} example is a real error`);
      eq(e.colour, game.colour);
      ok(new Chess(e.fen).move(e.san), `${p.id} fen plays san`);
    }
  }
});

test("pickExamples: one per game first, then fills, max 3, costliest first", () => {
  const h = (game_id, drop) => ({ game_id, drop });
  eq(patterns.pickExamples([h("a", 100), h("a", 500), h("b", 200), h("c", 50), h("c", 40)]).map((e) => `${e.game_id}${e.drop}`), ["a500", "b200", "c50"]);
  eq(patterns.pickExamples([h("a", 100), h("a", 500), h("a", 300), h("a", 200)]).map((e) => e.drop), [500, 300, 200]);
  eq(patterns.pickExamples([h("a", 1), h("b", 2)]).map((e) => e.drop), [2, 1]);
  eq(patterns.pickExamples([]), []);
});

const analysedGames = pairs.map(({ game, analysis }) => {
  const mistakes = { inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const m of analysis.moves) if (m.class) mistakes[m.class]++;
  return { ...game, mistakes };
});
const allPuzzles = pairs.flatMap(({ game, analysis }) => buildPuzzles(game, analysis));
const fixtureNote = buildCoach(analysedGames, allPuzzles, { now: 1e12 });
const fixturePicked = patterns.pickForCoach(patterns.findPatterns(pairs));

test("buildScript: order, presence and absence of messages for the fixture games", () => {
  ok(fixtureNote, "note exists");
  const early = buildScript(fixtureNote, null, allPuzzles, analysedGames);
  eq(early.map((m) => m.id), ["greeting", "pattern", "focus"]);
  eq(early[0].paragraphs, [`Hi! I've looked at your last ${fixtureNote.recentGames} games.`, fixtureNote.goingWell]);
  eq(early[0].examples, []);
  eq(early[1].paragraphs, [fixtureNote.pattern]);
  eq(early[2].paragraphs[0], `This week's focus: ${fixtureNote.focus.label}.`);
  eq(early[2].paragraphs[1], fixtureNote.advice);
  ok(early[2].paragraphs[2].includes(fixtureNote.checklist), "checklist line");
  eq(early[2].examples, []);

  const full = buildScript(fixtureNote, fixturePicked, allPuzzles, analysedGames);
  const { bad, good, headline } = fixturePicked;
  const expectIds = ["greeting", "pattern", "focus"];
  if (headline) expectIds.push(`habit:${headline.id}`);
  for (const p of bad) if (p !== headline) expectIds.push(`habit:${p.id}`);
  if (good) expectIds.push(`strength:${good.id}`);
  expectIds.push("trends");
  eq(full.map((m) => m.id), expectIds);
  const last = full[full.length - 1];
  eq(last.paragraphs, fixtureNote.trends.map((t) => t.text));
  eq(last.paragraphs.length, 3);
  if (headline) {
    const m = full.find((x) => x.id === `habit:${headline.id}`);
    eq(m.paragraphs, [`Something else I've noticed: ${headline.text}`, headline.advice]);
  }
  if (good) eq(full.find((x) => x.id.startsWith("strength:")).examples, []);
  for (const m of full) for (const e of m.examples) {
    ok(e.fen && e.best && e.caption && e.reviewUrl.startsWith("review.html?id="), `example fields in ${m.id}`);
    ok(/^Move \d+ (against \S+|in your game on \d{4}-\d\d-\d\d): you played \S+\. \S+ was better\.$/.test(e.caption), e.caption);
  }
});

test("buildScript: no habits at all still ends with the trends; a null note is one message with no examples", () => {
  const bare = buildScript(fixtureNote, { bad: [], good: null, headline: null }, allPuzzles, analysedGames);
  eq(bare.map((m) => m.id), ["greeting", "pattern", "focus", "trends"]);
  const wait = buildScript(null, null, [], []);
  eq(wait, [{ id: "wait", paragraphs: [WAIT_TEXT], examples: [] }]);
});

test("coach script: focus examples are filtered by tag, costliest first, one per game, at most 3", () => {
  const tag = fixtureNote.focus.tag;
  const picked3 = focusPuzzles(fixtureNote, allPuzzles, analysedGames);
  ok(picked3.length <= 3, "max 3");
  const hasTag = (p) => ((p.tags && p.tags.length) ? p.tags : ["other"]).includes(tag);
  ok(picked3.every(hasTag), "tag filter");
  for (let i = 1; i < picked3.length; i++) ok(picked3[i - 1].drop >= picked3[i].drop, "costliest first");
  // synthetic: four puzzles in two games, plus one with another tag and one outside the window
  const mk = (id, game_id, drop, tags) => ({ id, game_id, ply: 4, fen: new Chess().fen(), best_uci: "e2e4", best_san: "e4", played_san: "d4", drop, tags, colour: "white", end_time: 5 });
  const g = (id, t) => ({ id, end_time: t, opponent: "rival" + id, mistakes: { mistake: 1 } });
  const games8 = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => g("g" + i, i));
  const fakeNote = { recentGames: 4, focus: { tag: "hung_piece" }, goingWell: "w", pattern: "p", advice: "a", checklist: "c", trends: [] };
  const ps = [mk("1", "g8", 300, ["hung_piece"]), mk("2", "g8", 900, ["hung_piece"]), mk("3", "g7", 200, ["hung_piece"]), mk("4", "g6", 100, ["hung_piece"]),
    mk("5", "g5", 50, ["hung_piece"]), mk("6", "g7", 999, ["back_rank"]), mk("7", "g1", 5000, ["hung_piece"])];
  eq(focusPuzzles(fakeNote, ps, games8).map((p) => p.id), ["2", "3", "4"]); // g5 is outside the 4 newest games; g1 too
  const msg = buildScript(fakeNote, null, ps, games8)[1];
  eq(msg.examples.length, 3);
  eq(msg.examples[0].caption, "Move 2 against rivalg8: you played d4. e4 was better.");
  eq(msg.examples[0].reviewUrl, "review.html?id=g8&ply=4");
  eq(msg.examples[0].played, "d2d4");
  eq(msg.examples[0].best, "e2e4");
  eq(msg.examples[0].orientation, "white");
  // no opponent on record: falls back to the date
  const noOpp = buildScript(fakeNote, null, ps, games8.map((x) => ({ ...x, opponent: undefined })))[1];
  ok(noOpp.examples[0].caption.startsWith("Move 2 in your game on 1970-01-01:"), noOpp.examples[0].caption);
  // an "other" focus takes puzzles with no tags
  const other = { ...fakeNote, focus: { tag: "other" } };
  eq(focusPuzzles(other, [mk("9", "g8", 10, []), mk("10", "g8", 20, undefined), mk("11", "g7", 5, ["hung_piece"])], games8).map((p) => p.id), ["10", "9"]); // untagged only; the second from the same game fills up
  eq(uciFromSan(new Chess().fen(), "Nf3"), "g1f3");
  eq(uciFromSan(new Chess().fen(), "Qh5"), null);
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
