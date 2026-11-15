// Regression tests for tagging bugs found in review and since fixed.
// Run from the repo root: node --test tests/js/unit/known-bugs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { Chess } = await load("site/vendor/chess.js");
const themes = await load("site/js/core/themes.js");

// A board at `fen`, having checked that `uci` is legal there.
function position(fen, uci) {
  const board = new Chess(fen);
  const legal = board.moves({ verbose: true }).some((m) => m.from + m.to === uci);
  assert.ok(legal, `${uci} must be legal in ${fen}`);
  return board;
}

test("winsMaterial: a piece whose only defender is pinned is free",
  () => {
    // Black queen e6 is pinned to the king by the rook on e1, so it cannot recapture on d5.
    const board = position("4k3/8/4q3/3n4/8/8/3R4/4R1K1 w - - 0 1", "d2d5");
    assert.equal(themes.winsMaterial(board, "d2d5"), true);
  });

test("winsMaterial: a pawn defended only by a king that cannot legally recapture is free",
  () => {
    // After Qxd7+ the bishop on f5 covers d7, so Kxd7 is illegal.
    const board = position("4k3/3p4/8/5B2/8/8/8/3QK3 w - - 0 1", "d1d7");
    assert.equal(themes.winsMaterial(board, "d1d7"), true);
  });

// Nc7+ attacks king and rook, but the bishop on d8 can take the knight.
const FORK_FEN = "r2bk3/8/8/1N6/8/8/8/4K3 w - - 0 1";

test("forks: no fork when the engine's expected reply takes the forking piece", () => {
  const board = position(FORK_FEN, "b5c7");
  assert.equal(themes.forks(board, "b5c7", "Bxc7"), false);
  assert.deepEqual(themes.tagMistake(board, "b5a3", "b5c7", { pv: ["Nc7+", "Bxc7"] }), ["other"]);
});

test("forks: still a fork when the expected reply leaves the forking piece alone", () => {
  // A real game shape: the forker could be taken, but that loses to a deeper tactic, so the engine moves the king.
  const board = position(FORK_FEN, "b5c7");
  assert.equal(themes.forks(board, "b5c7", "Kd7"), true);
  assert.equal(themes.forks(board, "b5c7"), true);
  assert.deepEqual(themes.tagMistake(board, "b5a3", "b5c7", { pv: ["Nc7+", "Kd7", "Nxa8"] }), ["missed_fork"]);
});

test("forks: an unreadable reply is ignored", () => {
  const board = position(FORK_FEN, "b5c7");
  assert.equal(themes.forks(board, "b5c7", "Zz9"), true);
});
