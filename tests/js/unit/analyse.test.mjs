// Unit tests for site/js/core/analyse.js: classify, parseMovetext, clocksFromPgn, analyseGame.
// Run from the repo root: node --test tests/js/unit/analyse.test.mjs
// analyseGame is driven by a stub engine keyed by FEN; nothing here needs a real Stockfish.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { Chess } = await load("site/vendor/chess.js");
const { CONFIG } = await load("site/js/core/config.js");
const { classify, parseMovetext, clocksFromPgn, analyseGame } = await load("site/js/core/analyse.js");

const T = { inaccuracy: 50, mistake: 100, blunder: 200 };
const sansOf = (pgn) => parseMovetext(pgn).map((p) => p.san);
const clksOf = (pgn) => parseMovetext(pgn).map((p) => p.clk);

/**
 * Run parseMovetext from the real source text inside a vm with a 50 ms CPU limit, so an
 * infinite loop shows up as a failed test instead of hanging the whole run.
 */
function guardedParse(pgn) {
  const src = fs.readFileSync(path.join(ROOT, "site/js/core/analyse.js"), "utf8");
  const a = src.indexOf("const CLK");
  const b = src.indexOf("/** One entry per ply");
  if (a < 0 || b < a) throw new Error("analyse.js layout changed: update guardedParse markers");
  const code = src.slice(a, b).replace(/export /g, "");
  return vm.runInNewContext(`${code}\nJSON.stringify(parseMovetext(${JSON.stringify(pgn)}))`, {}, { timeout: 50 });
}

// ---- classify -------------------------------------------------------------------------------
describe("classify", () => {
  it("has exact boundaries at 49/50, 99/100 and 199/200", () => {
    const at = (drop) => classify(drop, 0, -drop, T, 600);
    assert.equal(at(0), null);
    assert.equal(at(49), null);
    assert.equal(at(50), "inaccuracy");
    assert.equal(at(99), "inaccuracy");
    assert.equal(at(100), "mistake");
    assert.equal(at(199), "mistake");
    assert.equal(at(200), "blunder");
    assert.equal(at(1000), "blunder");
  });

  it("uses the thresholds it is given", () => {
    const custom = { inaccuracy: 10, mistake: 20, blunder: 30 };
    assert.equal(classify(9, 0, -9, custom, 600), null);
    assert.equal(classify(10, 0, -10, custom, 600), "inaccuracy");
    assert.equal(classify(20, 0, -20, custom, 600), "mistake");
    assert.equal(classify(30, 0, -30, custom, 600), "blunder");
  });

  it("does not label a move made when already lost: before === -600 is null, -599 is labelled", () => {
    assert.equal(classify(300, -600, -900, T, 600), null);
    assert.equal(classify(300, -601, -901, T, 600), null);
    assert.equal(classify(300, -599, -899, T, 600), "blunder");
  });

  it("does not label a move that leaves the game won: after === 600 is null, 599 is labelled", () => {
    assert.equal(classify(300, 900, 600, T, 600), null);
    assert.equal(classify(300, 900, 601, T, 600), null);
    assert.equal(classify(300, 899, 599, T, 600), "blunder");
  });

  it("still labels throwing away a win (before >= 600 but after well below)", () => {
    assert.equal(classify(600, 600, 0, T, 600), "blunder");
  });

  it("respects a custom decided threshold", () => {
    assert.equal(classify(300, -300, -600, T, 300), null);
    assert.equal(classify(300, -299, -599, T, 300), "blunder");
  });

  it("returns null for a negative drop (the move improved the position)", () => {
    assert.equal(classify(-1, 0, 1, T, 600), null);
    assert.equal(classify(-500, 0, 500, T, 600), null);
  });
});

// ---- parseMovetext --------------------------------------------------------------------------
describe("parseMovetext", () => {
  it("returns { san, clk } per ply with clk null when absent", () => {
    assert.deepStrictEqual(parseMovetext("1. e4 e5 *"), [{ san: "e4", clk: null }, { san: "e5", clk: null }]);
  });

  it("strips headers, including values with escaped quotes and brackets", () => {
    const pgn = [
      '[Event "A \\"quoted\\" [bracketed] name"]',
      '[White "Bob]"]',
      '[Site "1. e4 e5"]',
      '[Path "C:\\\\dir\\\\"]',
      "",
      "1. e4 e5 *",
    ].join("\n");
    assert.deepEqual(sansOf(pgn), ["e4", "e5"]);
  });

  it("handles move numbers attached or separated, with one or three dots", () => {
    assert.deepEqual(
      sansOf("1.e4 e5 2. Nf3 Nc6 3... Bb5 3...a6 10.O-O 10... O-O-O *"),
      ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "O-O", "O-O-O"],
    );
  });

  it("drops NAGs and annotation suffixes but keeps check marks", () => {
    assert.deepEqual(
      sansOf("1. e4! e5? 2. Nf3!? Nc6?? 3. Bb5 $1 $14 a6!! 4. Bxc6+?! dxc6 *"),
      ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Bxc6+", "dxc6"],
    );
  });

  it("skips {...} comments, whatever they contain", () => {
    assert.deepEqual(sansOf("1. e4 {e5 is best; ( or ) maybe 2. Nf3} e5 {} 2. Nf3 *"), ["e4", "e5", "Nf3"]);
  });

  it("parses a comment attached directly to a move and the move after it", () => {
    assert.deepEqual(parseMovetext("1. e4{[%clk 0:03:00]}e5 *"), [{ san: "e4", clk: 180 }, { san: "e5", clk: null }]);
  });

  it("skips ; line comments up to the end of the line only", () => {
    const pgn = "1. e4 e5 ; the rest, 2. Nf3, is ignored { not a comment\n2. Nc3 Nc6 ;trailing, no newline";
    assert.deepEqual(sansOf(pgn), ["e4", "e5", "Nc3", "Nc6"]);
  });

  it("a ; inside a {} comment does not start a line comment", () => {
    assert.deepEqual(sansOf("1. e4 { a ; b } e5 *"), ["e4", "e5"]);
  });

  it("skips nested ( ) variations, including their clocks", () => {
    const pgn = "1. e4 e5 (1... c5 {[%clk 0:01:00]} 2. Nf3 (2. c3 {[%clk 0:00:50]}) 2... d6) 2. Nf3 {[%clk 0:02:00]} Nc6 *";
    assert.deepStrictEqual(parseMovetext(pgn), [
      { san: "e4", clk: null },
      { san: "e5", clk: null },
      { san: "Nf3", clk: 120 },
      { san: "Nc6", clk: null },
    ]);
  });

  it("a result token inside a variation does not end the game", () => {
    assert.deepEqual(sansOf("1. e4 (1. d4 1-0) e5 *"), ["e4", "e5"]);
  });

  it("a stray closing parenthesis is ignored", () => {
    assert.deepEqual(sansOf("1. e4 ) e5 *"), ["e4", "e5"]);
  });

  it("attaches a clock to the preceding main-line ply only", () => {
    assert.deepStrictEqual(
      parseMovetext("1. e4 {[%clk 0:03:00]} e5 {[%clk 0:02:59.9]} 2. Nf3 Nc6 {[%clk 0:02:50]} *"),
      [
        { san: "e4", clk: 180 },
        { san: "e5", clk: 179.9 },
        { san: "Nf3", clk: null },
        { san: "Nc6", clk: 170 },
      ],
    );
  });

  it("a clock comment that follows a closed variation belongs to the main-line move before it", () => {
    assert.deepStrictEqual(parseMovetext("1. e4 e5 (1... c5) {[%clk 0:02:30]} 2. Nf3 *"), [
      { san: "e4", clk: null }, { san: "e5", clk: 150 }, { san: "Nf3", clk: null },
    ]);
  });

  it("converts hours, minutes, seconds, with and without a decimal, rounding to one decimal", () => {
    assert.deepEqual(
      clksOf("1. e4 {[%clk 1:02:03.4]} e5 {[%clk 0:00:07]} 2. Nf3 {[%clk 0:00:09.96]} Nc6 {[%clk 10:00:00]} *"),
      [3723.4, 7, 10, 36000],
    );
  });

  it("finds the clock among other command tags in the same comment", () => {
    assert.deepEqual(clksOf("1. e4 {[%eval 0.3] [%clk 0:01:00]} *"), [60]);
  });

  it("ignores comments without a clock and a clock before any move", () => {
    assert.deepStrictEqual(parseMovetext("{[%clk 0:03:00]} 1. e4 {just text} *"), [{ san: "e4", clk: null }]);
  });

  it("with two clock comments after one move, the first wins (the code only fills an empty clk)", () => {
    assert.deepEqual(clksOf("1. e4 {[%clk 0:03:00]} {[%clk 0:02:00]} e5 *"), [180, null]);
  });

  it("a clock-less comment followed by a clock comment still gives the move its clock", () => {
    assert.deepEqual(clksOf("1. e4 { opening } {[%clk 0:01:00]} *"), [60]);
  });

  it("stops at each result token and ignores everything after it", () => {
    for (const result of ["1-0", "0-1", "1/2-1/2", "*"]) {
      assert.deepEqual(sansOf(`1. e4 e5 ${result} 2. Nf3 Nc6`), ["e4", "e5"], result);
    }
  });

  it("works with no result token", () => {
    assert.deepEqual(sansOf("1. e4 e5 2. Nf3"), ["e4", "e5", "Nf3"]);
  });

  it("handles CRLF line endings in headers, comments and movetext", () => {
    const pgn = '[Event "x"]\r\n[Site "y"]\r\n\r\n1. e4 {[%clk 0:03:00]}\r\ne5 ; c\r\n2. Nf3 {[%clk 0:02:00]}\r\n*\r\n';
    assert.deepStrictEqual(parseMovetext(pgn), [
      { san: "e4", clk: 180 }, { san: "e5", clk: null }, { san: "Nf3", clk: 120 },
    ]);
  });

  it("returns [] for empty, whitespace-only, header-only and result-only input", () => {
    for (const pgn of ["", "  \n\t ", '[Event "x"]\n[Site "y"]\n', '[Event "x"]\n\n*', "1-0"]) {
      assert.deepStrictEqual(parseMovetext(pgn), [], JSON.stringify(pgn));
    }
  });

  it("an unterminated comment swallows the rest and does not hang", () => {
    assert.deepEqual(JSON.parse(guardedParse("1. e4 { never closed e5 2. Nf3")).map((p) => p.san), ["e4"]);
  });

  it("an unterminated variation swallows the rest and does not hang", () => {
    assert.deepEqual(JSON.parse(guardedParse("1. e4 (1. d4 e5")).map((p) => p.san), ["e4"]);
  });

  it("ignores a stray closing brace instead of looping forever", () => {
    assert.deepEqual(JSON.parse(guardedParse("1. e4 } e5 *")).map((p) => p.san), ["e4", "e5"]);
  });

  it("ignores a stray closing parenthesis and nested braces in a comment", () => {
    assert.deepEqual(JSON.parse(guardedParse("1. e4 ) e5 *")).map((p) => p.san), ["e4", "e5"]);
    assert.deepEqual(JSON.parse(guardedParse("1. e4 { a { b } } e5 *")).map((p) => p.san), ["e4", "e5"]);
  });
});

describe("clocksFromPgn", () => {
  it("gives one entry per ply: seconds, or null when the ply has no clock", () => {
    assert.deepStrictEqual(clocksFromPgn("1. e4 {[%clk 0:03:00]} e5 2. Nf3 {[%clk 0:02:00.5]} *"), [180, null, 120.5]);
  });

  it("is all nulls for a clockless game, and [] for no moves", () => {
    assert.deepStrictEqual(clocksFromPgn("1. e4 e5 *"), [null, null]);
    assert.deepStrictEqual(clocksFromPgn(""), []);
  });
});

// ---- analyseGame helpers --------------------------------------------------------------------
/** FENs of the start position and after each SAN. */
function fensAfter(sans) {
  const c = new Chess();
  const out = [c.fen()];
  for (const san of sans) { c.move(san); out.push(c.fen()); }
  return out;
}

/** Engine stub: position index -> lines (sliced to multipv like a real engine). Records every call. */
function tableEngine(sans, perPosition) {
  const fens = fensAfter(sans);
  const table = new Map();
  perPosition.forEach((lines, i) => { if (lines) table.set(fens[i], lines); });
  const calls = [];
  const evaluate = async (fen, { multipv }) => {
    calls.push({ fen, multipv });
    const lines = table.get(fen);
    if (lines === undefined) throw new Error("unexpected evaluate: " + fen);
    return lines.slice(0, multipv);
  };
  return { evaluate, calls, fens };
}

/** Engine stub answering every position with the same lines. */
function constantEngine(lines) {
  const calls = [];
  const evaluate = async (fen, { multipv }) => { calls.push({ fen, multipv }); return lines.slice(0, multipv); };
  return { evaluate, calls };
}

const cpLine = (cp, ...pv) => ({ cp, mate: null, pv });
const mateLine = (mate, ...pv) => ({ cp: null, mate, pv });
const key = (fen) => fen.split(" ").slice(0, 4).join(" ");

// ---- analyseGame: terminal positions --------------------------------------------------------
describe("analyseGame terminal positions", () => {
  it("a game ending in stalemate stores cp 0 and never evaluates the final position", async () => {
    const sans = "e3 a5 Qh5 Ra6 Qxa5 h5 h4 Rah6 Qxc7 f6 Qxd7+ Kf7 Qxb7 Qd3 Qxb8 Qh7 Qxc8 Kg6 Qe6".split(" ");
    const check = new Chess();
    for (const s of sans) check.move(s);
    assert.ok(check.isStalemate(), "precondition: Sam Loyd's ten-move stalemate");
    const { evaluate, calls, fens } = tableless(sans, 500);
    const a = await analyseGame({ id: "s", colour: "white", pgn: sans.map((s, i) => (i % 2 ? "" : `${i / 2 + 1}. `) + s).join(" ") + " 1/2-1/2" }, evaluate);
    assert.equal(a.moves.length, sans.length);
    const last = a.moves[a.moves.length - 1];
    assert.equal(last.san, "Qe6");
    assert.ok(Object.is(last.cp, 0), "cp is exactly +0");
    assert.ok(!("mate" in last));
    assert.equal(calls.length, sans.length, "positions 0..18 evaluated, position 19 (stalemate) not");
    assert.ok(!calls.some((c) => c.fen === fens[sans.length]));
  });

  it("a game ending by insufficient material stores cp 0 and never evaluates the final position", async () => {
    // Capture-heavy 95-ply game that ends king and bishop v king.
    const sans = ("Nc3 Nc6 Rb1 Ne5 d3 Nxd3+ exd3 Rb8 Nd5 c6 Nxe7 h5 Be3 Qa5+ Ke2 Qxa2 Nxc6 Qxb2 Nxb8 Qxb1 Qxb1 b6 " +
      "Nxd7 Bxd7 Qxb6 axb6 Bxb6 Bd6 d4 Bxh2 Rxh2 Ke7 Rxh5 Rxh5 c4 Rh6 g4 Rxb6 g5 Nf6 gxf6+ Rxf6 Nf3 Rxf3 Kxf3 f5 " +
      "Ke3 Be8 Kd2 Kd6 Kc1 Bd7 f3 f4 Bd3 Ke7 Kd2 g6 Bxg6 Kf8 Bd3 Kg8 Kd1 Bc6 Bb1 Bxf3+ Ke1 Bh1 Kd2 Kf7 d5 Bxd5 " +
      "Kd1 Bxc4 Bg6+ Kxg6 Ke1 Bg8 Ke2 Ba2 Kf1 Kh6 Ke2 Bf7 Ke1 Bg8 Ke2 Bh7 Kf1 Bg6 Ke2 Kh5 Kf2 f3 Kxf3").split(" ");
    const c = new Chess();
    for (const s of sans) c.move(s);
    assert.equal(c.fen(), "8/8/6b1/7k/8/5K2/8/8 b - - 0 48", "precondition: K+B v K");
    const { evaluate, calls, fens } = tableless(sans, 500);
    const pgn = sans.map((s, i) => (i % 2 ? "" : `${i / 2 + 1}. `) + s).join(" ") + " 1/2-1/2";
    const a = await analyseGame({ id: "i", colour: "black", pgn }, evaluate);
    const last = a.moves[a.moves.length - 1];
    assert.equal(last.san, "Kxf3");
    assert.ok(Object.is(last.cp, 0));
    assert.ok(!("mate" in last));
    assert.equal(calls.length, sans.length);
    assert.ok(!calls.some((c2) => c2.fen === fens[sans.length]));
    assert.equal(a.moves[sans.length - 2].cp !== 0, true, "earlier positions were evaluated normally");
  });

  it("a constant engine score flips sign with the side to move (white's point of view)", async () => {
    const { evaluate } = constantEngine([cpLine(30)]);
    const a = await analyseGame({ id: "x", colour: "white", pgn: "1. e4 e5 2. Nf3 *" }, evaluate);
    assert.equal(a.start_cp, 30);
    assert.deepEqual(a.moves.map((m) => m.cp), [-30, 30, -30]);
  });
});

/** constantEngine variant that also exposes position FENs for a SAN list. */
function tableless(sans, cp) {
  const { evaluate, calls } = constantEngine([cpLine(cp)]);
  return { evaluate, calls, fens: fensAfter(sans) };
}

// ---- analyseGame: repetition ----------------------------------------------------------------
describe("analyseGame repetition", () => {
  const shuffle = Array.from({ length: 4 }, (_, i) =>
    `${i * 2 + 1}. Nf3 Nf6 ${i * 2 + 2}. Ng1 Ng8`).join(" ");

  it("scores the fifth occurrence of a position 0 without calling the engine, but evaluates the third", async () => {
    const pgn = shuffle + " *";
    assert.equal(parseMovetext(pgn).length, 16);
    const { evaluate, calls } = constantEngine([cpLine(30)]);
    const a = await analyseGame({ id: "rep", colour: "white", pgn }, evaluate);

    const startKey = key(new Chess().fen());
    const startCalls = calls.filter((c) => key(c.fen) === startKey).length;
    // Occurrences of the start position: before ply 1, then after plies 4, 8, 12 (all evaluated), and after ply 16 (the fifth).
    assert.equal(startCalls, 4, "occurrences 1-4 are evaluated, the 5th is not");
    assert.equal(calls.length, 16, "only positions 0..15 reach the engine");

    // Third occurrence = after ply 8 (white to move): a constant +30 score, not 0.
    assert.equal(a.moves[7].cp, 30);
    assert.equal(a.moves[11].cp, 30);
    // Fifth occurrence = after ply 16.
    assert.ok(Object.is(a.moves[15].cp, 0));
    assert.ok(!("mate" in a.moves[15]));
  });

  it("does not stop a game at a threefold repetition", async () => {
    const pgn = "1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 *"; // start position occurs 3 times, after ply 8
    const { evaluate, calls } = constantEngine([cpLine(30)]);
    const a = await analyseGame({ id: "three", colour: "white", pgn }, evaluate);
    assert.equal(calls.length, 9, "all nine positions evaluated, including the third occurrence");
    assert.equal(a.moves[7].cp, 30);
  });
});

// ---- analyseGame: errors --------------------------------------------------------------------
describe("analyseGame errors", () => {
  it("rejects on an illegal SAN instead of returning a partial result", async () => {
    // sync.js catches this per game: it logs "Analysis failed for game <id>", marks the game
    // failed for the session (failedThisSession), stores no analysis and moves on to the next game.
    const { evaluate } = constantEngine([cpLine(10)]);
    await assert.rejects(analyseGame({ id: "bad", colour: "white", pgn: "1. e4 e5 2. Ke4 *" }, evaluate), /Ke4/);
    await assert.rejects(analyseGame({ id: "bad2", colour: "white", pgn: "1. e5 *" }, evaluate));
  });

  it("rejects with the 'no line' error when the engine returns []", async () => {
    const evaluate = async () => [];
    await assert.rejects(
      analyseGame({ id: "n", colour: "white", pgn: "1. e4 *" }, evaluate),
      (err) => err instanceof Error && /engine returned no line for rnbqkbnr\/pppppppp\/8\/8\/8\/8\/PPPPPPPP\/RNBQKBNR w KQkq - 0 1/.test(err.message),
    );
  });

  it("rejects with the 'no line' error for a null or undefined engine answer, and mid-game", async () => {
    await assert.rejects(analyseGame({ id: "n", colour: "white", pgn: "1. e4 *" }, async () => null), /no line/);
    await assert.rejects(analyseGame({ id: "n", colour: "white", pgn: "1. e4 *" }, async () => undefined), /no line/);
    const fens = fensAfter(["e4"]);
    const evaluate = async (fen) => (fen === fens[0] ? [cpLine(0)] : []);
    await assert.rejects(analyseGame({ id: "n", colour: "white", pgn: "1. e4 *" }, evaluate), /no line/);
  });

  it("propagates an engine rejection", async () => {
    const evaluate = async () => { throw new Error("Engine terminated"); };
    await assert.rejects(analyseGame({ id: "n", colour: "white", pgn: "1. e4 *" }, evaluate), /Engine terminated/);
  });
});

// ---- analyseGame: best move handling --------------------------------------------------------
describe("analyseGame best moves", () => {
  it("an engine pv whose first move is illegal gives no best/best_uci/pv, and the move is not classified or counted", async () => {
    const { evaluate, calls } = tableEngine(["e4"], [[cpLine(100, "a1a5")], [cpLine(10, "e7e5")]]);
    const a = await analyseGame({ id: "ill", colour: "white", pgn: "1. e4 *" }, evaluate);
    assert.deepStrictEqual(a.moves, [{ san: "e4", uci: "e2e4", cp: -10 }]);
    assert.deepEqual(a.counts, { inaccuracy: 0, mistake: 0, blunder: 0 });
    assert.equal(calls.length, 2, "no alternatives search without a best_uci");
  });

  it("an empty pv (engine gave no best move) leaves the move unclassified and uncounted", async () => {
    const { evaluate } = tableEngine(["e4"], [[cpLine(100)], [cpLine(10, "e7e5")]]);
    const a = await analyseGame({ id: "nopv", colour: "white", pgn: "1. e4 *" }, evaluate);
    assert.deepStrictEqual(a.moves, [{ san: "e4", uci: "e2e4", cp: -10 }]);
    assert.deepEqual(a.counts, { inaccuracy: 0, mistake: 0, blunder: 0 });
  });

  it("a move equal to the engine's best is never labelled, even when the eval swings", async () => {
    // Before: +300 for white. After 1. e4 black stands at +300, i.e. white -300: a 600 swing.
    const { evaluate } = tableEngine(["e4"], [[cpLine(300, "e2e4")], [cpLine(300, "e7e5")]]);
    const a = await analyseGame({ id: "b", colour: "white", pgn: "1. e4 *" }, evaluate);
    assert.deepStrictEqual(a.moves, [{ san: "e4", uci: "e2e4", cp: -300 }]);
    assert.deepEqual(a.counts, { inaccuracy: 0, mistake: 0, blunder: 0 });
  });

  it("the first move uses start_cp and the first pv; a move with a legal best differing from it gets best, best_uci and pv", async () => {
    const { evaluate } = tableEngine(["e4"], [[cpLine(25, "d2d4", "d7d5", "c2c4", "e7e6")], [cpLine(25, "e7e5")]]);
    const a = await analyseGame({ id: "p", colour: "white", pgn: "1. e4 *" }, evaluate);
    assert.equal(a.start_cp, 25);
    assert.deepStrictEqual(a.moves[0], {
      san: "e4", uci: "e2e4", best: "d4", best_uci: "d2d4", pv: ["d4", "d5", "c4"], cp: -25, class: "inaccuracy", drop: 50,
    });
  });
});

// ---- analyseGame: counts and colours --------------------------------------------------------
describe("analyseGame counts", () => {
  const sans = ["e4", "e5", "Nf3"];
  const rows = () => [
    [cpLine(0, "d2d4")],                 // white to move, +0
    [cpLine(60, "c7c5")],                // black to move +60: white -60
    [cpLine(200, "g1f3")],               // white to move +200
    [cpLine(0)],                         // black to move 0
  ];

  it("counts only the player's own colour while the opponent's moves still get a class", async () => {
    const { evaluate, calls } = tableEngine(sans, rows());
    const a = await analyseGame({ id: "w", colour: "white", pgn: "1. e4 e5 2. Nf3 *" }, evaluate);
    assert.deepStrictEqual(a.moves, [
      { san: "e4", uci: "e2e4", best: "d4", best_uci: "d2d4", pv: ["d4"], cp: -60, class: "inaccuracy", drop: 60 },
      // black: before +60 (own view), after -200 (white +200): a 260 drop for the opponent
      { san: "e5", uci: "e7e5", best: "c5", best_uci: "c7c5", pv: ["c5"], cp: 200, class: "blunder", drop: 260 },
      { san: "Nf3", uci: "g1f3", cp: 0 },
    ]);
    assert.deepEqual(a.counts, { inaccuracy: 1, mistake: 0, blunder: 0 });
    assert.ok(!calls.some((c) => c.multipv === 4), "an inaccuracy and an opponent blunder trigger no alternatives search");
  });

  it("with the other colour, the same game counts the other side", async () => {
    const { evaluate, calls, fens } = tableEngine(sans, rows());
    const a = await analyseGame({ id: "b", colour: "black", pgn: "1. e4 e5 2. Nf3 *" }, evaluate);
    assert.deepEqual(a.counts, { inaccuracy: 0, mistake: 0, blunder: 1 });
    assert.equal(a.moves[0].class, "inaccuracy", "the opponent's move keeps its class");
    assert.equal(a.moves[1].class, "blunder");
    // alternatives are searched for the player's blunder only; the only line is the best move, so none are recorded
    assert.deepEqual(calls.filter((c) => c.multipv === 4).map((c) => c.fen), [fens[1]]);
    assert.ok(!("alts" in a.moves[1]) && !("alts_san" in a.moves[1]));
  });
});

// ---- analyseGame: cap and mate --------------------------------------------------------------
describe("analyseGame cap and mate", () => {
  it("clamps cp to config.cap and turns mate into +/-cap with a white-perspective signed mate", async () => {
    const config = { ...CONFIG, cap: 300 };
    const { evaluate } = tableEngine(["e4", "e5", "Nf3"], [
      [cpLine(-5000)],      // white to move, far behind: -300 (capped)
      [mateLine(2, "d7d5")],  // black to move, black mates in 2: white mate -2, cp -300
      [mateLine(3)],        // white to move, white mates in 3: white mate 3, cp +300
      [mateLine(-4)],       // black to move, black is mated in 4: white mate 4, cp +300
    ]);
    const a = await analyseGame({ id: "c", colour: "white", pgn: "1. e4 e5 2. Nf3 *" }, evaluate, config);
    assert.equal(a.start_cp, -300);
    assert.deepStrictEqual(a.moves, [
      { san: "e4", uci: "e2e4", cp: -300, mate: -2 },
      { san: "e5", uci: "e7e5", best: "d5", best_uci: "d7d5", pv: ["d5"], cp: 300, mate: 3, class: "blunder", drop: 600 },
      { san: "Nf3", uci: "g1f3", cp: 300, mate: 4 },
    ]);
  });

  it("caps a large positive and negative cp for either side to move", async () => {
    const config = { ...CONFIG, cap: 250 };
    const { evaluate } = tableEngine(["e4"], [[cpLine(9999)], [cpLine(-9999)]]);
    const a = await analyseGame({ id: "c2", colour: "white", pgn: "1. e4 *" }, evaluate, config);
    assert.equal(a.start_cp, 250);
    assert.equal(a.moves[0].cp, 250, "black to move at -9999 is white +250");
  });

  it("never produces negative zero", async () => {
    const { evaluate } = tableEngine(["e4"], [[cpLine(0)], [cpLine(0)]]);
    const a = await analyseGame({ id: "z", colour: "white", pgn: "1. e4 *" }, evaluate);
    assert.ok(Object.is(a.moves[0].cp, 0));
    assert.ok(Object.is(a.start_cp, 0));
  });
});

// ---- analyseGame: alternatives --------------------------------------------------------------
describe("analyseGame alternatives", () => {
  it("includes a line exactly at top - margin, excludes top - margin - 1, drops illegal alts and the best move", async () => {
    // White plays 1. a3 (blunder). Best e4 at 100; d4 at exactly top-50 is kept; c4 at top-51 is not;
    // e7e5 (black's pawn move) scores 100 but is illegal for white.
    const lines = [cpLine(100, "e2e4"), cpLine(50, "d2d4"), cpLine(49, "c2c4"), cpLine(100, "e7e5")];
    const { evaluate, calls, fens } = tableEngine(["a3"], [lines, [cpLine(150, "e7e5")]]);
    const a = await analyseGame({ id: "a", colour: "white", pgn: "1. a3 *" }, evaluate);
    assert.deepStrictEqual(a.moves[0], {
      san: "a3", uci: "a2a3", best: "e4", best_uci: "e2e4", pv: ["e4"], cp: -150, class: "blunder", drop: 250,
      alts: ["d2d4"], alts_san: ["d4"],
    });
    assert.deepEqual(calls.filter((c) => c.multipv === 4).map((c) => c.fen), [fens[0]]);
  });

  it("excludes the played move and the best move, keeps the others in engine order", async () => {
    const lines = [cpLine(100, "e2e4"), cpLine(90, "d2d4"), cpLine(80, "c2c4"), cpLine(70, "g1f3")];
    const { evaluate } = tableEngine(["d4"], [lines, [cpLine(10, "d7d5")]]);
    const a = await analyseGame({ id: "a2", colour: "white", pgn: "1. d4 *" }, evaluate);
    assert.equal(a.moves[0].class, "mistake");
    assert.deepEqual(a.moves[0].alts, ["c2c4", "g1f3"]);
    assert.deepEqual(a.moves[0].alts_san, ["c4", "Nf3"]);
  });

  it("respects a custom altMarginCp exactly at the margin", async () => {
    const lines = [cpLine(100, "e2e4"), cpLine(90, "d2d4"), cpLine(80, "c2c4"), cpLine(70, "g1f3")];
    const run = async (altMarginCp) => {
      const { evaluate } = tableEngine(["d4"], [lines, [cpLine(10, "d7d5")]]);
      return analyseGame({ id: "m", colour: "white", pgn: "1. d4 *" }, evaluate, { ...CONFIG, altMarginCp });
    };
    assert.deepEqual((await run(20)).moves[0].alts, ["c2c4"], "c4 at top-20 is in, Nf3 at top-30 is out");
    const none = (await run(19)).moves[0];
    assert.ok(!("alts" in none) && !("alts_san" in none), "nothing within the margin: no alts keys at all");
    assert.deepEqual((await run(30)).moves[0].alts, ["c2c4", "g1f3"]);
  });

  it("scores alternatives with the cap, so capped lines tie with the top line", async () => {
    const lines = [cpLine(5000, "e2e4"), cpLine(4000, "d2d4"), cpLine(120, "c2c4")];
    const { evaluate } = tableEngine(["a3"], [lines, [cpLine(5000, "e7e5")]]);
    const a = await analyseGame({ id: "cap", colour: "white", pgn: "1. a3 *" }, evaluate);
    assert.equal(a.moves[0].class, "blunder");
    assert.deepEqual(a.moves[0].alts, ["d2d4"], "d4 caps to 1000 like the top line; c4 at 120 is out");
  });

  it("uses the mate score as +cap when ranking alternatives", async () => {
    const lines = [mateLine(3, "e2e4"), cpLine(990, "d2d4"), cpLine(900, "c2c4")];
    const { evaluate } = tableEngine(["a3"], [lines, [cpLine(5000, "e7e5")]]);
    const a = await analyseGame({ id: "mate", colour: "white", pgn: "1. a3 *" }, evaluate);
    assert.deepEqual(a.moves[0].alts, ["d2d4"]);
  });

  it("only searches alternatives for the player's mistakes and blunders that have a best move", async () => {
    // white inaccuracy (own, no search), black blunder (opponent, no search), white move with an illegal pv (no best_uci, not classified)
    const sans = ["e4", "e5", "Nf3"];
    const { evaluate, calls } = tableEngine(sans, [
      [cpLine(0, "d2d4")],
      [cpLine(60, "c7c5")],
      [cpLine(200, "a1a5")],     // illegal best for white
      [cpLine(100, "e5e4")],     // black to move +100: white -100, a 300 drop for white's Nf3
    ]);
    const a = await analyseGame({ id: "only", colour: "white", pgn: "1. e4 e5 2. Nf3 *" }, evaluate);
    assert.equal(a.moves[0].class, "inaccuracy");
    assert.equal(a.moves[1].class, "blunder");
    assert.ok(!("class" in a.moves[2]), "no best move for the position: not classified");
    assert.ok(!("best_uci" in a.moves[2]));
    assert.equal(calls.filter((c) => c.multipv === 4).length, 0);
  });

  it("searches the position before the player's move, once per eligible move", async () => {
    const sans = ["a3", "e5", "b3"];
    const lines0 = [cpLine(100, "e2e4"), cpLine(80, "d2d4")];
    const { evaluate, calls, fens } = tableEngine(sans, [
      lines0,
      [cpLine(150, "e7e5")],          // black to move after a3: white -150 (blunder for a3: drop 250)
      lines0,                          // white to move after ...e5: +100
      [cpLine(150, "e7e5")],          // black to move after b3: white -150 (drop 250 again)
    ]);
    // Black's ...e5 is the engine's own best (pv e7e5 at position 1), so only white's two moves are labelled.
    const a = await analyseGame({ id: "two", colour: "white", pgn: "1. a3 e5 2. b3 *" }, evaluate);
    assert.equal(a.moves[0].class, "blunder");
    assert.equal(a.moves[2].class, "blunder");
    assert.deepEqual(calls.filter((c) => c.multipv === 4).map((c) => c.fen), [fens[0], fens[2]]);
    assert.deepEqual(a.moves[0].alts, ["d2d4"]);
    assert.deepEqual(a.moves[2].alts_san, ["d4"]);
    assert.deepEqual(a.counts, { inaccuracy: 0, mistake: 0, blunder: 2 });
  });

  it("works for black: alternatives are legal black moves in the position before the move", async () => {
    const sans = ["e4", "a6"];
    const { evaluate } = tableEngine(sans, [
      [cpLine(0, "e2e4")],
      [cpLine(100, "e7e5"), cpLine(60, "c7c5"), cpLine(40, "g8f6"), cpLine(-50, "a7a6")],
      [cpLine(90, "g1f3")],        // white to move after ...a6: +90 for white
    ]);
    const a = await analyseGame({ id: "blk", colour: "black", pgn: "1. e4 a6 *" }, evaluate);
    const m = a.moves[1];
    assert.equal(m.class, "mistake");           // black: before 100, after -90: a 190 drop
    assert.deepEqual(m.alts, ["c7c5"]);
    assert.deepEqual(m.alts_san, ["c5"]);
    assert.equal(m.best, "e5");
  });

  it("carries alts: config.analysisVersion and depth: config.depth", async () => {
    const config = { ...CONFIG, analysisVersion: 7, depth: 9 };
    const { evaluate } = tableEngine(["e4"], [[cpLine(0)], [cpLine(0)]]);
    const a = await analyseGame({ id: "v", colour: "white", pgn: "1. e4 *" }, evaluate, config);
    assert.equal(a.alts, 7);
    assert.equal(a.depth, 9);
    const dflt = await analyseGame({ id: "v", colour: "white", pgn: "1. e4 *" }, tableEngine(["e4"], [[cpLine(0)], [cpLine(0)]]).evaluate);
    assert.equal(dflt.alts, CONFIG.analysisVersion);
    assert.equal(dflt.depth, CONFIG.depth);
  });

  it("returns the id and an empty moves list shape for a game with no moves", async () => {
    const { evaluate, calls } = constantEngine([cpLine(20)]);
    const a = await analyseGame({ id: "empty", colour: "white", pgn: '[Event "x"]\n\n*' }, evaluate);
    assert.deepStrictEqual(a, {
      id: "empty", depth: CONFIG.depth, start_cp: 20, moves: [],
      counts: { inaccuracy: 0, mistake: 0, blunder: 0 }, alts: CONFIG.analysisVersion,
    });
    assert.equal(calls.length, 1);
  });

  it("includes clk on a move only when the PGN has one", async () => {
    const { evaluate } = constantEngine([cpLine(0)]);
    const a = await analyseGame({ id: "clk", colour: "white", pgn: "1. e4 {[%clk 0:03:00]} e5 *" }, evaluate);
    assert.equal(a.moves[0].clk, 180);
    assert.ok(!("clk" in a.moves[1]));
  });
});
