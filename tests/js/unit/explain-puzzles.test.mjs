// Unit tests for site/js/core/explain.js (explainLine) and site/js/core/puzzles.js (buildPuzzles).
// Run from the repo root: node --test tests/js/unit/explain-puzzles.test.mjs
// Positions were built by hand and are checked for legality when used. Most explainLine cases are
// written for white and replayed mirrored (ranks flipped, colours swapped) with black to move.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { Chess } = await load("site/vendor/chess.js");
const { explainLine } = await load("site/js/core/explain.js");
const { buildPuzzles } = await load("site/js/core/puzzles.js");

const NONE = ["No explanation is available for this position."];

// ---- mirroring: white-to-move scenario -> the same scenario with black to move -----------------
const swapCase = (s) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
const flipSquares = (text) => text.replace(/([a-h])([1-8])/g, (_, f, r) => f + (9 - Number(r)));
const mirrorFen = (fen) => {
  const [placement, turn, castle, ep, half, full] = fen.split(" ");
  return [
    placement.split("/").reverse().map(swapCase).join("/"),
    turn === "w" ? "b" : "w",
    castle === "-" ? "-" : swapCase(castle),
    ep === "-" ? "-" : flipSquares(ep),
    half,
    full,
  ].join(" ");
};

/** Assert the whole line is playable from fen, so a typo in a test position cannot hide behind the "never throws" fallback. */
function assertPlayable(fen, line) {
  const c = new Chess(fen);
  for (const san of line) c.move(san);
}

/**
 * Check explainLine for white-to-move `fen`, and for the mirrored position with black to move.
 * `expected` is the full list of sentences (white version); the black version flips the squares in it.
 */
function bothSides(name, fen, line, expected, info) {
  test(`${name} (white)`, () => {
    assertPlayable(fen, line);
    assert.deepEqual(explainLine(fen, line, info), expected);
  });
  test(`${name} (black)`, () => {
    const bfen = mirrorFen(fen);
    const bline = line.map(flipSquares);
    assertPlayable(bfen, bline);
    const binfo = info && { ...info, playedSan: info.playedSan && flipSquares(info.playedSan) };
    assert.deepEqual(explainLine(bfen, bline, binfo), expected.map(flipSquares));
  });
}

const FREE_KNIGHT = "4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1"; // Rxd5 wins a knight for free

describe("explainLine: the best move itself", () => {
  bothSides("gives check", "4k3/8/8/8/8/8/8/R3K3 w - - 0 30", ["Ra8+"],
    ["Ra8+ gives check, so your opponent must respond to it."]);

  bothSides("promotion to a queen", "8/P7/4k3/8/8/8/8/4K3 w - - 0 30", ["a8=Q"],
    ["a8=Q promotes your pawn to a queen."]);

  bothSides("underpromotion to a knight", "8/P7/4k3/8/8/8/8/4K3 w - - 0 30", ["a8=N"],
    ["a8=N promotes your pawn to a knight."]);

  bothSides("en passant that wins a pawn for free is worded as a pawn win", "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 30", ["exd6"],
    ["exd6 wins a pawn for free."]);

  bothSides("en passant that the king can retake is a pawn trade", "8/4k3/8/3pP3/8/8/8/4K3 w - d6 0 30", ["exd6+"],
    ["exd6+ trades your pawn for the pawn."]);

  bothSides("takes the X on sq: a queen taking a defended pawn", "4k3/8/4p3/3p4/8/8/8/3QK3 w - - 0 30", ["Qxd5"],
    ["Qxd5 takes the pawn on d5."]);

  bothSides("pawn fork of two knights lists both", "4k3/8/8/2n1n3/8/3P4/8/R3K3 w - - 0 8", ["d4"],
    ["d4 forks the two knights."]);

  bothSides("moving a king out of check does not crash and is worded as moving away", "4r1k1/8/8/8/8/8/8/4K3 w - - 0 30", ["Kd2"],
    ["Kd2 moves your king away from the attack."]);

  bothSides("defends your X on sq: a king guards a knight a rook was about to take",
    "3rk3/8/8/8/3N4/8/4K3/8 w - - 0 30", ["Ke3"],
    ["Ke3 defends your knight on d4."]);

  bothSides("develops a piece (opening)", new Chess().fen(), ["Nf3"], ["Nf3 develops a piece."]);

  bothSides("the same knight move after move 11 is no longer 'develops a piece'",
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 12", ["Nf3"],
    ["Nf3 is the engine's top choice: a quiet move that keeps your position healthy."]);

  bothSides("attacks the X, so your opponent has to deal with it: an undefended bishop",
    "4k3/8/6b1/8/8/5N2/8/4K3 w - - 0 20", ["Ne5"],
    ["Ne5 attacks the bishop, so your opponent has to deal with it."]);

  bothSides("attacks a rook even though it is defended (worth more than the knight)",
    "4k3/8/5pr1/8/8/5N2/8/4K3 w - - 0 20", ["Ne5"],
    ["Ne5 attacks the rook, so your opponent has to deal with it."]);

  bothSides("centre pawn", new Chess().fen(), ["e4"], ["e4 stakes a claim in the centre."]);

  bothSides("a wing pawn move is just the fallback", new Chess().fen(), ["c4"],
    ["c4 is the engine's top choice: a quiet move that keeps your position healthy."]);

  bothSides("king activity in the endgame", "4k3/8/8/8/8/8/8/4K3 w - - 0 30", ["Kd2"],
    ["Kd2 brings your king into the action."]);

  bothSides("the same king move in the opening is the quiet fallback", "4k3/8/8/8/8/8/8/4K3 w - - 0 5", ["Kd2"],
    ["Kd2 is the engine's top choice: a quiet move that keeps your position healthy."]);

  bothSides("rook to an open file", "4k3/8/8/8/8/8/8/R3K3 w - - 0 5", ["Rd1"],
    ["Rd1 puts your rook on an open file."]);

  bothSides("rook to a file with a pawn on it (even its own) is not an open file",
    "4k3/8/8/8/8/8/3P4/R3K3 w - - 0 5", ["Rd1"],
    ["Rd1 is the engine's top choice: a quiet move that keeps your position healthy."]);

  bothSides("rook to a file holding an enemy pawn is not an open file either (it attacks the pawn instead)",
    "4k3/8/3p4/8/8/8/8/R3K3 w - - 0 5", ["Rd1"],
    ["Rd1 attacks the pawn, so your opponent has to deal with it."]);

  bothSides("a quiet knight move outside the opening falls back to the generic sentence", "4k3/8/8/8/8/8/8/N3K3 w - - 0 30", ["Nc2"],
    ["Nc2 is the engine's top choice: a quiet move that keeps your position healthy."]);
});

describe("explainLine: the material-gain sentence", () => {
  bothSides("a fork that nets a rook: 'After ... you come out N points ahead'",
    "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 30", ["Nc7+", "Kd7", "Nxa8"],
    ["Nc7+ forks the king and rook.", "After Kd7 Nxa8 you come out 5 points of material ahead."]);

  bothSides("exactly one point is singular", "4k3/8/8/3p4/8/8/8/R3K3 w - - 0 30", ["Rd1", "Kf7", "Rxd5"],
    ["Rd1 attacks the pawn, so your opponent has to deal with it.",
      "After Kf7 Rxd5 you come out 1 point of material ahead."]);

  bothSides("suppressed when it only restates the first capture", "4k3/8/8/3p4/8/8/8/3RK3 w - - 0 30", ["Rxd5", "Kf7", "Kd2"],
    ["Rxd5 wins a pawn for free."]);

  bothSides("but shown when the line wins more than the first capture", "4k3/8/8/3pp3/8/8/8/3RK3 w - - 0 30", ["Rxd5", "Kf7", "Rxe5"],
    ["Rxd5 wins a pawn for free.", "After Kf7 Rxe5 you come out 2 points of material ahead."]);

  test("not shown for a two-move line, or when the line gains nothing", () => {
    assert.deepEqual(explainLine("4k3/8/8/3p4/8/8/8/R3K3 w - - 0 30", ["Rd1", "Kf7"]),
      ["Rd1 attacks the pawn, so your opponent has to deal with it."]);
    assert.deepEqual(explainLine("4k3/8/8/8/8/8/8/R3K3 w - - 0 5", ["Rd1", "Kd7", "Ra1"]),
      ["Rd1 puts your rook on an open file."]);
  });

  test("only the first five plies are counted", () => {
    // the pawn is not won until ply 7
    const fen = "4k3/8/8/3p4/8/8/8/3RK3 w - - 0 30";
    const line = ["Ke2", "Kd7", "Kf3", "Kc6", "Kf4", "Kb6", "Rxd5"];
    assertPlayable(fen, line);
    assert.deepEqual(explainLine(fen, line), ["Ke2 brings your king into the action."]);
  });
});

describe("explainLine: mates and the hidden mate", () => {
  bothSides("hidden mate: the stored line is short but the missed_mate tag says there is a mate",
    "4k3/8/8/8/8/8/8/R3K3 w - - 0 5", ["Rd1"], ["Rd1 is the first move of a forced checkmate."], { tags: ["missed_mate"] });

  bothSides("a visible mate keeps its own sentence even with the missed_mate tag",
    "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 5", ["Ra8#"], ["Ra8# is checkmate."], { tags: ["missed_mate"] });

  test("the hidden-mate sentence replaces the material sentence", () => {
    const fen = "4k3/8/8/3p4/8/8/8/R3K3 w - - 0 30";
    assert.deepEqual(explainLine(fen, ["Rd1", "Kf7", "Rxd5"], { tags: ["missed_mate"] }),
      ["Rd1 is the first move of a forced checkmate."]);
  });

  test("other tags do not trigger the hidden-mate sentence", () => {
    assert.deepEqual(explainLine("4k3/8/8/8/8/8/8/R3K3 w - - 0 5", ["Rd1"], { tags: ["missed_capture"] }),
      ["Rd1 puts your rook on an open file."]);
  });
});

describe("explainLine: the sentence about the move that was played", () => {
  const second = (info, line = ["Rxd5"], fen = FREE_KNIGHT) => explainLine(fen, line, info)[1];
  const HUNG = "left a piece where it could be taken";

  test("hung_piece: with a huge drop, a big drop, a small drop and no drop", () => {
    assert.equal(second({ playedSan: "Kd2", tags: ["hung_piece"], drop: 1000 }),
      `Your move Kd2 ${HUNG}, throwing away a winning advantage.`);
    assert.equal(second({ playedSan: "Kd2", tags: ["hung_piece"], drop: 460 }),
      `Your move Kd2 ${HUNG}, costing you about 4.6 pawns' worth of advantage.`);
    assert.equal(second({ playedSan: "Kd2", tags: ["hung_piece"], drop: 9 }), `Your move Kd2 ${HUNG}.`);
    assert.equal(second({ playedSan: "Kd2", tags: ["hung_piece"] }), `Your move Kd2 ${HUNG}.`);
  });

  test("missed_mate ignores the drop", () => {
    assert.equal(second({ playedSan: "Kd2", tags: ["missed_mate"], drop: 300 }), "Your move Kd2 let a forced checkmate slip.");
    assert.equal(second({ playedSan: "Kd2", tags: ["missed_mate"] }), "Your move Kd2 let a forced checkmate slip.");
  });

  test("hung_piece together with missed_mate joins both", () => {
    assert.equal(second({ playedSan: "Kd2", tags: ["hung_piece", "missed_mate"], drop: 5000 }),
      `Your move Kd2 ${HUNG} and let a forced checkmate slip.`);
  });

  test("a plain drop: exactly 1000 is a thrown-away win, 999 is still a number of pawns", () => {
    assert.equal(second({ playedSan: "Kd2", tags: ["other"], drop: 1000 }), "Your move Kd2 threw away a winning advantage.");
    assert.equal(second({ playedSan: "Kd2", tags: ["other"], drop: 999 }), "Your move Kd2 gave up about 10.0 pawns' worth of advantage.");
  });

  test("a drop of 100 centipawns is '1.0 pawn's', others are plural", () => {
    assert.equal(second({ playedSan: "Kd2", tags: [], drop: 100 }), "Your move Kd2 gave up about 1.0 pawn's worth of advantage.");
    assert.equal(second({ playedSan: "Kd2", tags: [], drop: 150 }), "Your move Kd2 gave up about 1.5 pawns' worth of advantage.");
    assert.equal(second({ playedSan: "Kd2", tags: [], drop: 20 }), "Your move Kd2 gave up about 0.2 pawns' worth of advantage.");
  });

  test("no drop, a zero drop or a non-numeric drop says nothing", () => {
    for (const info of [
      { playedSan: "Kd2", tags: ["other"] },
      { playedSan: "Kd2", tags: ["other"], drop: 0 },
      { playedSan: "Kd2", tags: ["other"], drop: "300" },
      { playedSan: "Kd2", tags: ["other"], drop: NaN },
      { playedSan: "Kd2", tags: ["other"], drop: null },
      { playedSan: "Kd2", tags: "hung_piece" }, // tags is not an array: ignored
      { tags: ["hung_piece"], drop: 900 }, // no playedSan
    ]) assert.equal(explainLine(FREE_KNIGHT, ["Rxd5"], info).length, 1, JSON.stringify(info));
  });

  test("black's played move is described the same way", () => {
    const fen = "3rk3/8/8/8/3N4/8/8/4K3 b - - 0 1"; // ...Rxd4 wins a knight for free
    assert.deepEqual(explainLine(fen, ["Rxd4"], { playedSan: "Ke7", tags: ["hung_piece"], drop: 300 }),
      ["Rxd4 wins a knight for free.", `Your move Ke7 ${HUNG}, costing you about 3.0 pawns' worth of advantage.`]);
  });

  test("never more than four sentences (here: best move, material, played = 3)", () => {
    const out = explainLine("4k3/8/8/3pp3/8/8/8/3RK3 w - - 0 30", ["Rxd5", "Kf7", "Rxe5"],
      { playedSan: "Kd2", tags: ["hung_piece"], drop: 500 });
    assert.ok(out.length <= 4);
    assert.equal(out.length, 3);
  });
});

describe("explainLine: black to move uses black's pieces", () => {
  test("black bishop takes a defended knight: a trade of black's bishop, not white's", () => {
    // white Nc3 is defended by the pawn b2; Bxc3+ is an even trade
    assert.deepEqual(explainLine("4k3/8/8/4b3/8/2N5/1P6/4K3 b - - 0 20", ["Bxc3+"]),
      ["Bxc3+ trades your bishop for the knight."]);
  });

  test("black wins a queen with a pawn: the pawn is black's", () => {
    // ...bxc3+ is recaptured by the king on d2, but a pawn for a queen is a bargain
    assert.deepEqual(explainLine("4k3/8/8/8/1p6/2Q5/3K4/8 b - - 0 20", ["bxc3+"]),
      ["bxc3+ wins the queen for your pawn."]);
  });
});

describe("explainLine: garbage input never throws", () => {
  test("null, undefined, non-string and invalid fen", () => {
    for (const fen of [null, 42, {}, "", "not a fen", "8/8/8/8/8/8/8/8 w - - 0 1"]) {
      assert.deepEqual(explainLine(fen, ["e4"]), NONE, String(fen));
    }
  });

  test("line that is not an array, empty, or starts with an illegal move", () => {
    for (const line of [null, undefined, "Rxd5", 5, {}, [], ["Qh9"], [null], [42]]) {
      assert.deepEqual(explainLine(FREE_KNIGHT, line), NONE, JSON.stringify(line));
    }
  });

  test("a line that goes illegal later keeps the legal prefix", () => {
    assert.deepEqual(explainLine(FREE_KNIGHT, ["Rxd5", "Qh9"]), ["Rxd5 wins a knight for free."]);
  });

  test("null or odd info is tolerated", () => {
    assert.deepEqual(explainLine(FREE_KNIGHT, ["Rxd5"], null), ["Rxd5 wins a knight for free."]);
    assert.deepEqual(explainLine(FREE_KNIGHT, ["Rxd5"], undefined), ["Rxd5 wins a knight for free."]);
    assert.deepEqual(explainLine(FREE_KNIGHT, ["Rxd5"], {}), ["Rxd5 wins a knight for free."]);
    assert.deepEqual(explainLine(FREE_KNIGHT, ["Rxd5"], { tags: null, playedSan: "Kd2" }), ["Rxd5 wins a knight for free."]);
  });
});

// ---- buildPuzzles ------------------------------------------------------------------------------
// A ten-ply Ruy Lopez: 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7
const mv = (san, uci, extra = {}) => ({ san, uci, cp: 0, ...extra });
const MOVES = () => [
  mv("e4", "e2e4", { class: "mistake", best: "d4", best_uci: "d2d4", pv: ["d4", "d5"], drop: 150 }), //  1 white: puzzle (ply 1)
  mv("e5", "e7e5", { class: "blunder", best: "c5", best_uci: "c7c5", pv: ["c5"], drop: 400 }), //        2 black: puzzle
  mv("Nf3", "g1f3", { class: "inaccuracy", best: "Nc3", best_uci: "b1c3", pv: ["Nc3"], drop: 60 }), //    3 white: inaccuracy, no
  mv("Nc6", "b8c6", { class: "mistake", best: "Nf6", best_uci: "g8f6", pv: ["Nf6"], drop: 180, alts: ["d7d6"], alts_san: ["d6"] }), // 4 black: puzzle
  mv("Bb5", "f1b5", { class: "mistake", best: "Bc4", best_uci: "f1c4", pv: ["Bc4", "Nf6"], drop: 200 }), //  5 white: puzzle
  mv("a6", "a7a6", { class: "blunder", best: "Nf6", best_uci: "g8f6", pv: ["Nf6"], drop: 500 }), //       6 black: puzzle
  mv("Ba4", "b5a4", { class: "blunder", drop: 700 }), //                                                   7 white: blunder but no best_uci
  mv("Nf6", "g8f6", { class: "inaccuracy", best: "b5", best_uci: "b7b5", pv: ["b5"], drop: 70 }), //      8 black: inaccuracy, no
  mv("O-O", "e1g1", { class: "blunder", best: "d3", best_uci: "d2d3", pv: ["d3", "d6"], drop: 900 }), //  9 white: puzzle
  mv("Be7", "f8e7", { class: "mistake", best: "b5", best_uci: "b7b5", pv: ["b5"], drop: 120 }), //       10 black: puzzle
  // (non-problem moves would have no class key at all)
];
const GAME = (over = {}) => ({
  id: "abc-123", colour: "white", end_time: 1700000000, time_class: "blitz",
  opening: "Sicilian Defense Najdorf Variation", ...over,
});
const ANALYSIS = (moves = MOVES()) => ({ id: "abc-123", moves });

// Positions (FENs, hand-built) before the plies that become puzzles.
const FEN_BEFORE = {
  1: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  2: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  4: "r1bqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2".replace("r1bqkbnr", "rnbqkbnr"),
  5: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
  6: "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
  9: "r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 5",
  10: "r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 3 5",
};

describe("buildPuzzles", () => {
  test("white: only my mistakes and blunders that carry a best_uci", () => {
    const ps = buildPuzzles(GAME(), ANALYSIS());
    assert.deepEqual(ps.map((p) => p.ply), [1, 5, 9]);
    // not: inaccuracy (3), opponent's (2, 4, 6, 8, 10), blunder without best_uci (7)
  });

  test("black: the even plies", () => {
    const ps = buildPuzzles(GAME({ colour: "black" }), ANALYSIS());
    assert.deepEqual(ps.map((p) => p.ply), [2, 4, 6, 10]);
  });

  test("id is game id and 1-based ply; game_id and ply are filled", () => {
    const [first, second] = buildPuzzles(GAME(), ANALYSIS());
    assert.equal(first.id, "abc-123:1");
    assert.equal(first.ply, 1);
    assert.equal(second.id, "abc-123:5");
    assert.equal(second.game_id, "abc-123");
  });

  test("fen is the position BEFORE the bad move, with the player to move (white)", () => {
    const ps = buildPuzzles(GAME(), ANALYSIS());
    for (const p of ps) {
      assert.equal(p.fen, FEN_BEFORE[p.ply], `ply ${p.ply}`);
      assert.equal(new Chess(p.fen).turn(), "w");
    }
  });

  test("fen is the position BEFORE the bad move, with the player to move (black)", () => {
    const ps = buildPuzzles(GAME({ colour: "black" }), ANALYSIS());
    for (const p of ps) {
      assert.equal(p.fen, FEN_BEFORE[p.ply], `ply ${p.ply}`);
      assert.equal(new Chess(p.fen).turn(), "b");
    }
  });

  test("the puzzle's best move is legal in its fen, and the played move is the one that follows", () => {
    for (const colour of ["white", "black"]) {
      const moves = MOVES();
      for (const p of buildPuzzles(GAME({ colour }), ANALYSIS(moves))) {
        const c = new Chess(p.fen);
        assert.equal(c.move({ from: p.best_uci.slice(0, 2), to: p.best_uci.slice(2, 4) }).san, p.best_san);
        assert.equal(p.played_san, moves[p.ply - 1].san);
      }
    }
  });

  test("copies the move and game fields through", () => {
    const [p] = buildPuzzles(GAME(), ANALYSIS());
    assert.equal(p.best_uci, "d2d4");
    assert.equal(p.best_san, "d4");
    assert.deepEqual(p.pv, ["d4", "d5"]);
    assert.equal(p.played_san, "e4");
    assert.equal(p.class, "mistake");
    assert.equal(p.drop, 150);
    assert.equal(p.end_time, 1700000000);
    assert.equal(p.time_class, "blitz");
    assert.equal(p.colour, "white");
    assert.equal(p.opening, "Sicilian Defense Najdorf Variation");
  });

  test("alts default to [] and are kept when the analysis has them", () => {
    const white = buildPuzzles(GAME(), ANALYSIS());
    assert.deepEqual(white[0].alts, []);
    assert.deepEqual(white[0].alts_san, []);
    const black = buildPuzzles(GAME({ colour: "black" }), ANALYSIS());
    const nc6 = black.find((p) => p.ply === 4);
    assert.deepEqual(nc6.alts, ["d7d6"]);
    assert.deepEqual(nc6.alts_san, ["d6"]);
  });

  test("opening_family is derived from the opening name; a missing opening is Unknown", () => {
    assert.equal(buildPuzzles(GAME(), ANALYSIS())[0].opening_family, "Sicilian Defense");
    assert.equal(buildPuzzles(GAME({ opening: "Italian Game Giuoco Piano" }), ANALYSIS())[0].opening_family, "Italian Game");
    const none = buildPuzzles(GAME({ opening: undefined }), ANALYSIS())[0];
    assert.equal(none.opening, "");
    assert.equal(none.opening_family, "Unknown");
  });

  test("tags are an array of known tags; a quiet opening move is other", () => {
    const ps = buildPuzzles(GAME(), ANALYSIS());
    const bb5 = ps.find((p) => p.ply === 5); // Bb5 instead of Bc4: nothing to tag
    assert.deepEqual(bb5.tags, ["other"]);
    for (const p of ps) assert.ok(Array.isArray(p.tags) && p.tags.length > 0);
  });

  test("a hung-piece blunder is tagged from the next move", () => {
    // 1.e4 e5 2.Qh5 Nc6 3.Qxe5+?? -- ply 5 loses the queen to ...Nxe5
    const moves = [
      mv("e4", "e2e4"), mv("e5", "e7e5"), mv("Qh5", "d1h5"), mv("Nc6", "b8c6"),
      mv("Qxe5+", "h5e5", { class: "blunder", best: "Bc4", best_uci: "f1c4", pv: ["Bc4"], drop: 700 }),
      mv("Nxe5", "c6e5"),
    ];
    const ps = buildPuzzles(GAME(), ANALYSIS(moves));
    assert.equal(ps.length, 1);
    assert.deepEqual(ps[0].tags, ["hung_piece"]);
    assert.equal(ps[0].fen, "r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3");
  });

  test("no puzzles from a clean game, or from an empty one", () => {
    assert.deepEqual(buildPuzzles(GAME(), ANALYSIS([mv("e4", "e2e4"), mv("e5", "e7e5")])), []);
    assert.deepEqual(buildPuzzles(GAME(), ANALYSIS([])), []);
  });

  test("a mistake without best_uci (best move was what was played) is skipped", () => {
    const moves = [mv("e4", "e2e4", { class: "mistake", drop: 120 })];
    assert.deepEqual(buildPuzzles(GAME(), ANALYSIS(moves)), []);
  });

  // data.js loadPuzzles (data.js:92-98) calls buildPuzzles without a try/catch, so an illegal uci in one
  // stored analysis makes the whole puzzle load reject (memo() then drops the cached rejection).
  test("an illegal uci in the analysis throws rather than yielding wrong puzzles", () => {
    const bad = MOVES();
    bad[2] = mv("Nf3", "g1g5"); // a knight cannot go from g1 to g5
    assert.throws(() => buildPuzzles(GAME(), ANALYSIS(bad)));
    const late = MOVES();
    late[9] = mv("Be7", "f8f1"); // illegal only at the last ply, after puzzles were already built
    assert.throws(() => buildPuzzles(GAME(), ANALYSIS(late)));
  });
});
