// Unit tests for site/js/core/chessutil.js and site/js/core/themes.js.
// Run from the repo root: node --test tests/js/unit/chessutil-themes.test.mjs
// Every FEN below was built by hand; `board()` refuses to use an illegal one.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { Chess } = await load("site/vendor/chess.js");
const cu = await load("site/js/core/chessutil.js");
const th = await load("site/js/core/themes.js");
const { material, phaseOf, attacksFrom, kingSquare, legalMove, playUci, uciOf, rankOf, isInsufficientMaterial, terminalState } = cu;
const { capturedValue, winsMaterial, forks, tagMistake, tagsForMove } = th;

const board = (fen) => new Chess(fen); // chess.js throws on an illegal position
const sorted = (xs) => [...xs].sort();

// Mirror a position top-to-bottom with colours swapped (white<->black), so every
// white-to-move scenario can be replayed with black to move. No castling/ep in these FENs.
const swapCase = (s) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
const mirrorFen = (fen) => {
  const [placement, turn, castle, ep, half, full] = fen.split(" ");
  assert.equal(castle, "-");
  assert.equal(ep, "-");
  return [placement.split("/").reverse().map(swapCase).join("/"), turn === "w" ? "b" : "w", "-", "-", half, full].join(" ");
};
const mirrorSq = (sq) => sq[0] + (9 - Number(sq[1]));
const mirrorUci = (u) => mirrorSq(u.slice(0, 2)) + mirrorSq(u.slice(2, 4)) + u.slice(4);

describe("material and phaseOf", () => {
  test("material counts only Q/R/B/N of both sides", () => {
    assert.equal(material(board(new Chess().fen())), 62); // 2 x (9 + 5+5 + 3+3 + 3+3)
    assert.equal(material(board("4k3/pppp4/8/8/8/8/PPPP4/4K3 w - - 0 1")), 0); // only kings and pawns
    assert.equal(material(board("r3k3/8/8/8/8/8/8/R2QK3 w - - 0 1")), 19); // 5 + 5 + 9
    assert.equal(material(board("2b1k3/8/8/8/8/8/8/2N1K3 w - - 0 1")), 6);
  });

  test("opening below full-move 12, whatever the material", () => {
    assert.equal(phaseOf(board("4k3/8/8/8/8/8/8/4K3 w - - 0 11")), "opening");
    assert.equal(phaseOf(board(new Chess().fen())), "opening");
    assert.equal(phaseOf(board("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 11")), "opening");
  });

  test("move 12 is the first non-opening move: middlegame with full material, endgame with none", () => {
    assert.equal(phaseOf(board("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 12")), "middlegame");
    assert.equal(phaseOf(board("4k3/8/8/8/8/8/8/4K3 w - - 0 12")), "endgame");
  });

  test("endgame at non-pawn material 13 (both sides together), middlegame at 14", () => {
    // white R+N (8) + black R (5) = 13
    assert.equal(phaseOf(board("r3k3/8/8/8/8/8/8/R3K1N1 w - - 0 30")), "endgame");
    // white Q (9) + black R (5) = 14
    assert.equal(phaseOf(board("r3k3/8/8/8/8/8/8/3QK3 w - - 0 30")), "middlegame");
    // 13 all on one side: R+R+N
    assert.equal(phaseOf(board("4k3/8/8/8/8/8/8/RR2K1N1 b - - 0 30")), "endgame");
  });
});

describe("small helpers", () => {
  test("uciOf and rankOf", () => {
    assert.equal(uciOf({ from: "e2", to: "e4" }), "e2e4");
    assert.equal(uciOf({ from: "e7", to: "e8", promotion: "q" }), "e7e8q");
    assert.equal(rankOf("a1"), 0);
    assert.equal(rankOf("h8"), 7);
    assert.equal(rankOf("d4"), 3);
  });

  test("kingSquare finds either colour's king", () => {
    const b = board("6k1/8/8/8/8/8/8/R3K3 w - - 0 1");
    assert.equal(kingSquare(b, "w"), "e1");
    assert.equal(kingSquare(b, "b"), "g8");
  });

  test("legalMove finds a legal uci and returns undefined otherwise", () => {
    const b = board(new Chess().fen());
    assert.equal(legalMove(b, "e2e4").san, "e4");
    assert.equal(legalMove(b, "g1f3").san, "Nf3");
    assert.equal(legalMove(b, "e2e5"), undefined); // pawn cannot move three
    assert.equal(legalMove(b, "e7e5"), undefined); // not my pawn
    assert.equal(legalMove(b, "zz"), undefined);
  });

  test("legalMove needs the promotion letter", () => {
    const b = board("k7/4P3/8/8/8/8/8/4K3 w - - 0 1");
    assert.equal(legalMove(b, "e7e8q").san, "e8=Q+");
    assert.equal(legalMove(b, "e7e8n").promotion, "n");
    assert.equal(legalMove(b, "e7e8"), undefined);
  });

  test("playUci plays plain moves and promotions, and throws on an illegal one", () => {
    const b = board(new Chess().fen());
    const m = playUci(b, "e2e4");
    assert.equal(m.san, "e4");
    assert.equal(b.turn(), "b");
    assert.equal(b.get("e4").type, "p");
    const p = board("k7/4P3/8/8/8/8/8/4K3 w - - 0 1");
    playUci(p, "e7e8r");
    assert.equal(p.get("e8").type, "r");
    assert.equal(p.get("e8").color, "w");
    assert.throws(() => playUci(board(new Chess().fen()), "e2e5"));
    assert.throws(() => playUci(board(new Chess().fen()), "e7e5")); // wrong side to move
  });
});

describe("attacksFrom", () => {
  test("pawns attack diagonally forward: white up, black down", () => {
    assert.deepEqual(sorted(attacksFrom(board("4k3/8/8/8/4P3/8/8/4K3 w - - 0 1"), "e4")), ["d5", "f5"]);
    assert.deepEqual(sorted(attacksFrom(board("4k3/8/8/4p3/8/8/8/4K3 w - - 0 1"), "e5")), ["d4", "f4"]);
  });

  test("pawns on edge files attack one square only", () => {
    assert.deepEqual(attacksFrom(board("4k3/8/8/8/8/8/P7/4K3 w - - 0 1"), "a2"), ["b3"]);
    assert.deepEqual(attacksFrom(board("4k3/7p/8/8/8/8/8/4K3 w - - 0 1"), "h7"), ["g6"]);
  });

  test("a pawn's attacks include squares holding its own pieces and ignore the square ahead", () => {
    const b = board("4k3/8/8/3P4/4P3/8/8/4K3 w - - 0 1");
    assert.deepEqual(sorted(attacksFrom(b, "e4")), ["d5", "f5"]); // d5 is a friendly pawn
  });

  test("knight in the corner and in the open", () => {
    assert.deepEqual(sorted(attacksFrom(board("4k3/8/8/8/8/8/8/N3K3 w - - 0 1"), "a1")), ["b3", "c2"]);
    assert.deepEqual(sorted(attacksFrom(board("4k3/8/8/8/3N4/8/8/4K3 w - - 0 1"), "d4")),
      ["b3", "b5", "c2", "c6", "e2", "e6", "f3", "f5"]);
  });

  test("king on an edge has five squares", () => {
    assert.deepEqual(sorted(attacksFrom(board("4k3/8/8/8/8/8/8/4K3 w - - 0 1"), "e1")), ["d1", "d2", "e2", "f1", "f2"]);
    assert.deepEqual(sorted(attacksFrom(board("7k/8/8/8/8/8/8/4K3 w - - 0 1"), "h8")), ["g7", "g8", "h7"]);
  });

  test("rook rays stop at the first blocker, including a blocker of its own colour", () => {
    // white Rd4; own pawn d6, enemy knight b4, own knight g4; nothing else on its lines
    const b = board("4k3/8/3P4/8/1n1R2N1/8/8/4K3 w - - 0 1");
    assert.deepEqual(sorted(attacksFrom(b, "d4")), sorted([
      "d5", "d6", // up, stops on own pawn (included)
      "d3", "d2", "d1", // down
      "c4", "b4", // left, stops on enemy knight (included)
      "e4", "f4", "g4", // right, stops on own knight (included)
    ]));
  });

  test("bishop rays stop at blockers", () => {
    // white Bd4, black pawn f6 (enemy), white pawn b2 (own)
    const b = board("4k3/8/5p2/8/3B4/8/1P6/4K3 w - - 0 1");
    assert.deepEqual(sorted(attacksFrom(b, "d4")), sorted([
      "e5", "f6", // NE ends at enemy pawn
      "c5", "b6", "a7", // NW
      "e3", "f2", "g1", // SE
      "c3", "b2", // SW ends at own pawn (included)
    ]));
  });

  test("queen combines both and works for black; a rook-line blocker of the other colour is included", () => {
    // black Qa1; white Bd1 blocks the first rank; white king off all its lines
    const b = board("4k3/8/8/8/8/6K1/8/q2B4 b - - 0 1");
    assert.deepEqual(sorted(attacksFrom(b, "a1")), sorted([
      "b1", "c1", "d1",
      "a2", "a3", "a4", "a5", "a6", "a7", "a8",
      "b2", "c3", "d4", "e5", "f6", "g7", "h8",
    ]));
  });

  test("an empty square has no attacks", () => {
    assert.deepEqual(attacksFrom(board(new Chess().fen()), "e4"), []);
  });
});

describe("isInsufficientMaterial and terminalState", () => {
  const insufficient = (fen) => isInsufficientMaterial(board(fen));

  test("K+N v K and K+B v K cannot mate", () => {
    assert.equal(insufficient("7k/8/8/8/8/8/8/KN6 w - - 0 1"), true);
    assert.equal(insufficient("7k/8/8/8/8/8/8/KB6 w - - 0 1"), true);
    assert.equal(insufficient("n6k/8/8/8/8/8/8/K7 w - - 0 1"), true); // the lone minor can be black's
  });

  test("one bishop each: same-coloured bishops are a dead draw, opposite-coloured ones are not", () => {
    // Bc1 and Bf8 are both dark-squared; Bc8 is light-squared
    assert.equal(insufficient("5b2/7k/8/8/8/8/8/K1B5 w - - 0 1"), true);
    assert.equal(insufficient("2b5/7k/8/8/8/8/8/K1B5 w - - 0 1"), false);
  });

  test("two bishops on opposite colours can mate; knight pairings and extra knights are not dead draws", () => {
    assert.equal(insufficient("7k/8/8/8/8/8/8/K1B2B2 w - - 0 1"), false); // Bc1 dark + Bf1 light
    assert.equal(insufficient("n6k/8/8/8/8/8/8/KN6 w - - 0 1"), false); // K+N v K+N
    assert.equal(insufficient("b6k/8/8/8/8/8/8/KN6 w - - 0 1"), false); // K+N v K+B
    assert.equal(insufficient("7k/8/8/8/8/8/8/KN1N4 w - - 0 1"), false); // K+N+N v K
  });

  test("any pawn, rook or queen means mate is still possible", () => {
    assert.equal(insufficient("7k/8/8/8/8/8/P7/K7 w - - 0 1"), false);
    assert.equal(insufficient("7k/p7/8/8/8/8/8/K7 w - - 0 1"), false);
    assert.equal(insufficient("7k/8/8/8/8/8/8/KR6 w - - 0 1"), false);
    assert.equal(insufficient("7k/8/8/8/8/8/8/KQ6 w - - 0 1"), false);
  });

  test("stalemate is a draw, also with white to move and black's pieces doing it", () => {
    // white Kh8 has no move: Qf7 covers g8/h7/g7, Kg6 covers g7/h7; h8 itself is not attacked
    const b = board("7K/5q2/6k1/8/8/8/8/8 w - - 0 1");
    assert.equal(b.isCheck(), false);
    assert.equal(terminalState(b), "draw");
  });

  test("75-move rule: halfmove clock 149 is still live, 150 is drawn", () => {
    assert.equal(terminalState(board("7k/8/8/8/8/8/8/KR6 w - - 149 90")), null);
    assert.equal(terminalState(board("7k/8/8/8/8/8/8/KR6 w - - 150 90")), "draw");
    assert.equal(terminalState(board("7k/8/8/8/8/8/8/KR6 w - - 151 91")), "draw");
  });

  test("fivefold repetition: 4 is live, 5 is drawn", () => {
    const b = board("7k/8/8/8/8/8/8/KR6 w - - 3 90");
    assert.equal(terminalState(b, 1), null);
    assert.equal(terminalState(b, 4), null);
    assert.equal(terminalState(b, 5), "draw");
    assert.equal(terminalState(b, 6), "draw");
  });

  test("checkmate takes priority over the draw rules", () => {
    const mate = board("5R1k/6pp/8/8/8/8/8/K7 b - - 150 90");
    assert.equal(mate.isCheckmate(), true);
    assert.equal(terminalState(mate, 5), "checkmate");
    assert.equal(terminalState(board("5R1k/6pp/8/8/8/8/8/K7 b - - 0 90")), "checkmate");
  });
});

describe("capturedValue", () => {
  // White Rd1 on an open d-file captures whatever stands on d5.
  const victim = (letter) => board(`4k3/8/8/3${letter}4/8/8/8/3RK3 w - - 0 1`);

  test("a non-capture is worth 0", () => {
    assert.equal(capturedValue(victim("p"), "d1d2"), 0);
  });

  test("each captured piece type is worth its points", () => {
    assert.equal(capturedValue(victim("p"), "d1d5"), 1);
    assert.equal(capturedValue(victim("n"), "d1d5"), 3);
    assert.equal(capturedValue(victim("b"), "d1d5"), 3);
    assert.equal(capturedValue(victim("r"), "d1d5"), 5);
    assert.equal(capturedValue(victim("q"), "d1d5"), 9);
  });

  test("works for black capturing white pieces", () => {
    assert.equal(capturedValue(board("3rk3/8/8/3Q4/8/8/8/4K3 b - - 0 1"), "d8d5"), 9);
  });

  test("en passant is worth one pawn (the target square is empty)", () => {
    assert.equal(capturedValue(board("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2"), "e5d6"), 1);
    assert.equal(capturedValue(board("4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1"), "d4e3"), 1);
  });

  test("capture-promotion is worth the captured piece, a quiet promotion nothing", () => {
    const b = board("3rk3/4P3/8/8/8/8/8/4K3 w - - 0 1");
    assert.equal(capturedValue(b, "e7d8q"), 5);
    assert.equal(capturedValue(board("k7/4P3/8/8/8/8/8/4K3 w - - 0 1"), "e7e8q"), 0);
  });

  test("an illegal or unknown move is worth 0", () => {
    assert.equal(capturedValue(victim("q"), "d1d9"), 0);
    assert.equal(capturedValue(victim("q"), "a1a2"), 0);
  });
});

describe("winsMaterial", () => {
  test("a more valuable victim wins material even when the capturer is recaptured", () => {
    // pawn b5 takes knight c6, which is defended by the pawn d7
    assert.equal(winsMaterial(board("4k3/3p4/2n5/1P6/8/8/8/4K3 w - - 0 1"), "b5c6"), true);
  });

  test("an equal-value capture of an undefended piece wins material", () => {
    assert.equal(winsMaterial(board("4k3/8/8/3n4/8/2N5/8/4K3 w - - 0 1"), "c3d5"), true);
  });

  test("an equal-value capture of a defended piece does not (pawn e6 defends d5)", () => {
    assert.equal(winsMaterial(board("4k3/8/4p3/3n4/8/2N5/8/4K3 w - - 0 1"), "c3d5"), false);
  });

  test("a queen taking a defended pawn loses material, taking an undefended one does not", () => {
    assert.equal(winsMaterial(board("4k3/8/4p3/3p4/8/8/8/3QK3 w - - 0 1"), "d1d5"), false);
    assert.equal(winsMaterial(board("4k3/8/8/3p4/8/8/8/3QK3 w - - 0 1"), "d1d5"), true);
  });

  test("en passant: undefended pawn wins, a pawn the king can retake does not", () => {
    assert.equal(winsMaterial(board("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2"), "e5d6"), true);
    assert.equal(winsMaterial(board("8/4k3/8/3pP3/8/8/8/4K3 w - d6 0 2"), "e5d6"), false); // Kxd6
  });

  test("non-captures and illegal moves are false; black captures work too", () => {
    assert.equal(winsMaterial(board("4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1"), "d1d2"), false);
    assert.equal(winsMaterial(board("4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1"), "d1d9"), false);
    assert.equal(winsMaterial(board("3rk3/8/8/3Q4/8/8/8/4K3 b - - 0 1"), "d8d5"), true);
  });
});

describe("forks", () => {
  test("a knight forking king and rook (black knight too)", () => {
    assert.equal(forks(board("r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1"), "b5c7"), true);
    assert.equal(forks(board("4k3/8/8/8/3n4/8/8/R3K3 b - - 0 1"), "d4c2"), true);
  });

  test("two undefended bishops are a fork; if both are defended by pawns and not worth more, it is not", () => {
    assert.equal(forks(board("4k3/8/1b3b2/8/8/4N3/8/4K3 w - - 0 1"), "e3d5"), true);
    assert.equal(forks(board("4k3/p4pp1/1b3b2/8/8/4N3/8/4K3 w - - 0 1"), "e3d5"), false);
  });

  test("a pawn forking two knights", () => {
    assert.equal(forks(board("4k3/8/8/2n1n3/8/3P4/8/4K3 w - - 0 1"), "d3d4"), true);
    assert.equal(forks(board("4k3/3p4/8/8/2N1N3/8/8/4K3 b - - 0 1"), "d7d5"), true);
  });

  test("a king move is never a fork", () => {
    // Kd2 attacks two undefended rooks on c3 and e3 (and gets out of check from Re3)
    const b = board("k7/8/8/8/8/2r1r3/8/4K3 w - - 0 1");
    assert.equal(forks(b, "e1d2"), false);
  });

  test("attacks on pawns do not count", () => {
    // Nc7+ hits the king and the pawn on e6 only
    assert.equal(forks(board("4k3/8/4p3/1N6/8/8/8/4K3 w - - 0 1"), "b5c7"), false);
  });
});

describe("tagMistake: each scenario for white and (mirrored) for black", () => {
  // Each scenario is written for white to move; the black version is the mirrored position.
  // Mate signs are from White's point of view: positive = White mates, negative = Black mates.
  const run = (fen, played, best, ctx, colour) => {
    if (colour === "w") return tagMistake(board(fen), played, best, ctx);
    return tagMistake(board(mirrorFen(fen)), mirrorUci(played), mirrorUci(best), {
      ...ctx,
      reply: ctx.reply ? mirrorUci(ctx.reply) : ctx.reply,
    });
  };
  const sign = (colour) => (colour === "w" ? 1 : -1); // "my" mate sign

  for (const colour of ["w", "b"]) {
    const side = colour === "w" ? "white" : "black";

    test(`${side}: missed_mate only when the mate was mine and the best move was not played`, () => {
      const fen = "7k/8/5K2/8/8/8/8/6Q1 w - - 0 5"; // Qg7#
      assert.deepEqual(run(fen, "f6e6", "g1g7", { prev_mate: sign(colour) }, colour), ["missed_mate"]);
      assert.deepEqual(run(fen, "f6e6", "g1g7", { prev_mate: -sign(colour) }, colour), ["other"]); // opponent's mate
      assert.deepEqual(run(fen, "f6e6", "g1g7", { prev_mate: null }, colour), ["other"]);
      assert.deepEqual(run(fen, "g1g7", "g1g7", { prev_mate: sign(colour) }, colour), ["other"]); // played it
    });

    test(`${side}: missed_capture, and it takes precedence over missed_fork`, () => {
      // Nxb5 wins a rook (defended by pawn c6) with a knight
      const cap = "r3k3/8/2p5/1r6/8/2N5/8/3QK3 w - - 0 8";
      assert.deepEqual(run(cap, "e1f1", "c3b5", {}, colour), ["missed_capture"]);
      // Nxc7+ takes an undefended pawn AND forks king and rook: only missed_capture is given
      const both = "r3k3/2p5/8/1N6/8/8/8/4K3 w - - 0 8";
      assert.deepEqual(run(both, "e1f1", "b5c7", {}, colour), ["missed_capture"]);
    });

    test(`${side}: missed_fork when the best move forks without winning material outright`, () => {
      assert.deepEqual(run("r3k3/8/8/2n1n3/8/3P4/8/R3K3 w - - 0 8", "e1f1", "d3d4", {}, colour), ["missed_fork"]);
    });

    test(`${side}: hung_piece when the reply wins more than my move took`, () => {
      // Ra5?? loses the rook to ...bxa5
      const fen = "r3k3/8/1p6/8/8/8/8/R3K3 w - - 0 8";
      assert.deepEqual(run(fen, "a1a5", "e1d2", { reply: "b6a5" }, colour), ["hung_piece"]);
      assert.deepEqual(run(fen, "a1a5", "e1d2", { reply: "e8d8" }, colour), ["other"]); // reply is not a capture
      assert.deepEqual(run(fen, "a1a5", "e1d2", {}, colour), ["other"]); // no reply known
      assert.deepEqual(run(fen, "a1a5", "e1d2", { reply: "b6b5" }, colour), ["other"]); // reply not even legal-capturing
    });

    test(`${side}: back_rank delivered (missed back-rank mate)`, () => {
      const fen = "6k1/5ppp/8/8/8/8/8/3QK3 w - - 0 8"; // Qd8#
      const r = run(fen, "e1e2", "d1d8", { prev_mate: sign(colour), pv: ["Qd8#"] }, colour);
      assert.deepEqual(r, ["missed_mate", "back_rank"]);
      // the pv may be absent: the best move alone is checked
      assert.deepEqual(run(fen, "e1e2", "d1d8", { prev_mate: sign(colour) }, colour), ["missed_mate", "back_rank"]);
      // with the wrong mate sign there is no missed mate and therefore no back-rank tag
      assert.deepEqual(run(fen, "e1e2", "d1d8", { prev_mate: -sign(colour), pv: ["Qd8#"] }, colour), ["other"]);
    });

    test(`${side}: back_rank suffered (the reply mates my uncastled back rank)`, () => {
      // ...Qd1# is coming; Na3 does nothing about it
      const fen = "3q2k1/8/8/8/8/8/5PPP/1N4K1 w - - 0 8";
      const theirMate = -sign(colour); // the opponent mates
      assert.deepEqual(run(fen, "b1a3", "f2f3", { reply: "d8d1", mate_after: theirMate }, colour), ["back_rank"]);
      assert.deepEqual(run(fen, "b1a3", "f2f3", { reply: "d8d1", mate_after: null }, colour), ["other"]);
      assert.deepEqual(run(fen, "b1a3", "f2f3", { reply: "d8d1", mate_after: sign(colour) }, colour), ["other"]); // my mate, not theirs
    });

    test(`${side}: endgame tag from move 12 with little material, otherwise other`, () => {
      const end = "4k3/6p1/8/8/8/8/6P1/R3K3 w - - 0 40";
      assert.deepEqual(run(end, "e1d2", "e1f1", {}, colour), ["endgame"]);
      assert.deepEqual(run(end.replace(" 40", " 8"), "e1d2", "e1f1", {}, colour), ["other"]);
    });

    test(`${side}: endgame is added after the other tags`, () => {
      const fen = "r3k3/8/1p6/8/8/8/8/R3K3 w - - 0 40";
      assert.deepEqual(run(fen, "a1a5", "e1d2", { reply: "b6a5" }, colour), ["hung_piece", "endgame"]);
    });
  }

  test("black, written by hand: start position after 1.e4, quiet moves are other", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    assert.deepEqual(tagMistake(board(fen), "e7e5", "c7c5", {}), ["other"]);
    assert.deepEqual(tagMistake(board(fen), "e7e5", "c7c5", null), ["other"]);
  });

  test("tagMistake does not modify the board it is given", () => {
    const b = board("r3k3/8/1p6/8/8/8/8/R3K3 w - - 0 8");
    const before = b.fen();
    tagMistake(b, "a1a5", "e1d2", { reply: "b6a5" });
    assert.equal(b.fen(), before);
  });
});

describe("tagsForMove", () => {
  test("a move without best_uci is just other", () => {
    const b = board("7k/8/5K2/8/8/8/8/6Q1 w - - 0 5");
    assert.deepEqual(tagsForMove(b, [{ uci: "f6e6" }], 0, true), ["other"]);
  });

  test("white at k = 0: no previous move, so no missed_mate even if the best move mates", () => {
    const b = board("7k/8/5K2/8/8/8/8/6Q1 w - - 0 5");
    assert.deepEqual(tagsForMove(b, [{ uci: "f6e6", best_uci: "g1g7", mate: 1 }], 0, true), ["other"]);
  });

  test("white mate: the previous move's mate is prev_mate (positive = white mates)", () => {
    // moves[0] was black's, moves[1] is mine (white), so k = 1 on a board with white to move
    const b = board("7k/8/5K2/8/8/8/8/6Q1 w - - 0 5");
    const mv = (prevMate) => [{ uci: "h7h8", mate: prevMate }, { uci: "f6e6", best_uci: "g1g7" }];
    assert.deepEqual(tagsForMove(b, mv(1), 1, true), ["missed_mate"]);
    assert.deepEqual(tagsForMove(b, mv(-1), 1, true), ["other"]);
    assert.deepEqual(tagsForMove(b, mv(undefined), 1, true), ["other"]);
  });

  test("black mate: negative previous mate counts for black, positive does not", () => {
    const b = board("6q1/8/8/8/8/5k2/8/7K b - - 0 5"); // ...Qg1#
    const mv = (prevMate) => [{ uci: "h2h1", mate: prevMate }, { uci: "f3e3", best_uci: "g8g1" }];
    assert.deepEqual(tagsForMove(b, mv(-1), 1, false), ["missed_mate"]);
    assert.deepEqual(tagsForMove(b, mv(1), 1, false), ["other"]);
  });

  test("the reply is the next move's best_uci, else its played uci; none at the last index", () => {
    const b = board("r3k3/8/1p6/8/8/8/8/R3K3 w - - 0 8");
    const mine = { uci: "a1a5", best_uci: "e1d2" };
    assert.deepEqual(tagsForMove(b, [mine, { uci: "e8d8", best_uci: "b6a5" }], 0, true), ["hung_piece"]);
    assert.deepEqual(tagsForMove(b, [mine, { uci: "b6a5" }], 0, true), ["hung_piece"]); // falls back to uci
    assert.deepEqual(tagsForMove(b, [mine, { uci: "b6a5", best_uci: "e8d8" }], 0, true), ["other"]); // best_uci wins
    assert.deepEqual(tagsForMove(b, [mine], 0, true), ["other"]); // last move: no reply
  });

  test("the black version of the hung piece, at a middle index", () => {
    const b = board(mirrorFen("r3k3/8/1p6/8/8/8/8/R3K3 w - - 0 8")); // black Ra8?, white pawn b3
    const moves = [
      { uci: "e2e4" },
      { uci: mirrorUci("a1a5"), best_uci: mirrorUci("e1d2") },
      { uci: mirrorUci("b6a5") },
    ];
    assert.deepEqual(tagsForMove(b, moves, 1, false), ["hung_piece"]);
  });

  test("the back-rank pv comes from the move's own pv", () => {
    const b = board("6k1/5ppp/8/8/8/8/8/3QK3 w - - 0 8");
    const moves = [{ uci: "g8h8", mate: 1 }, { uci: "e1e2", best_uci: "d1d8", pv: ["Qd8#"] }];
    assert.deepEqual(tagsForMove(b, moves, 1, true), ["missed_mate", "back_rank"]);
  });

  test("mate_after is this move's own mate (white-perspective): back_rank suffered", () => {
    const b = board("3q2k1/8/8/8/8/8/5PPP/1N4K1 w - - 0 8");
    const moves = [{ uci: "b1a3", best_uci: "f2f3", mate: -2 }, { uci: "d8d1", best_uci: "d8d1" }];
    assert.deepEqual(tagsForMove(b, moves, 0, true), ["back_rank"]);
    moves[0].mate = 2; // white mates: that cannot be a back-rank suffering
    assert.deepEqual(tagsForMove(b, moves, 0, true), ["other"]);
  });
});
