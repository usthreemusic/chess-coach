// Port of pipeline/themes.py: tag my mistakes by type, using simple rules and no engine.
//
// tagMistake(boardBefore, playedUci, bestUci, context): boardBefore is a chess.js Chess
// instance (not modified); moves are UCI strings. context = { prev_mate, mate_after, reply, pv }
// with the same meaning as in the Python version (reply is a UCI string or null).
import { Chess } from "../../vendor/chess.js";
import { attacksFrom, clone, kingSquare, legalMove, other, phaseOf, playUci, rankOf } from "./chessutil.js";

export { phaseOf };
export const KEPT = ["mistake", "blunder"];
export const TAGS = ["missed_mate", "missed_capture", "missed_fork", "hung_piece", "back_rank", "endgame"];
export const OTHER = "other";
export const POINTS = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

/** Points of the piece that the move captures, or 0 if it is not a capture. */
export function capturedValue(board, uci) {
  const m = legalMove(board, uci);
  if (!m || !(m.isCapture() || m.isEnPassant())) return 0;
  return m.isEnPassant() ? 1 : POINTS[m.captured];
}

/** True if the move captures a piece worth more than the capturer, or one that cannot be recaptured. */
export function winsMaterial(board, uci) {
  const m = legalMove(board, uci);
  if (!m || !(m.isCapture() || m.isEnPassant())) return false;
  const victim = m.isEnPassant() ? 1 : POINTS[m.captured];
  const attacker = POINTS[m.piece];
  if (victim > attacker) return true;
  const after = clone(board);
  playUci(after, uci);
  return !legalCaptures(after, m.to).length;
}

/** Legal moves (chess.js verbose) that capture on `square`. */
function legalCaptures(board, square) {
  return board.moves({ verbose: true }).filter((x) => x.to === square && (x.isCapture() || x.isEnPassant()));
}

/**
 * True if, after the move, the moved piece attacks two or more enemy non-pawns that are the king,
 * undefended, or worth more. `reply` is the opponent's expected answer (SAN, from the engine line):
 * if it simply takes the forking piece, there was no fork.
 */
export function forks(board, uci, reply = null) {
  const after = clone(board);
  playUci(after, uci);
  const to = uci.slice(2, 4);
  const piece = after.get(to);
  if (!piece || piece.type === "k") return false;
  const enemy = other(piece.color);
  if (reply) {
    try { if (clone(after).move(reply).to === to) return false; } catch { /* not a legal reply: ignore it */ }
  }
  let count = 0;
  for (const sq of attacksFrom(after, to)) {
    const target = after.get(sq);
    if (!target || target.color !== enemy || target.type === "p") continue;
    if (target.type === "k" || POINTS[target.type] > POINTS[piece.type] || !after.isAttacked(sq, enemy)) count++;
  }
  return count >= 2;
}

const homeRank = (colour) => (colour === "w" ? 0 : 7);

/** True if the move is a rook or queen mating a king that is still on its home rank. */
function backRankMate(board, uci) {
  const piece = board.get(uci.slice(0, 2));
  if (!piece || (piece.type !== "r" && piece.type !== "q")) return false;
  const enemy = other(board.turn());
  const king = kingSquare(board, enemy);
  if (rankOf(king) !== homeRank(enemy) || rankOf(uci.slice(2, 4)) !== homeRank(enemy)) return false;
  const after = clone(board);
  playUci(after, uci);
  return after.isCheckmate();
}

/** [board, uci] for each of my moves in the best line: the best move, then every second one. */
function myMovesInLine(board, bestUci, pv) {
  const line = [[clone(board), bestUci]];
  const cur = clone(board);
  playUci(cur, bestUci);
  for (let i = 1; i < pv.length; i++) {
    const before = clone(cur);
    let move;
    try {
      move = cur.move(pv[i]); // SAN
    } catch {
      break;
    }
    if (i % 2 === 0) line.push([before, move.from + move.to + (move.promotion || "")]);
  }
  return line;
}

const mateIsMine = (mate, colour) => Boolean(mate) && (mate > 0) === (colour === "w");

export function tagMistake(boardBefore, playedUci, bestUci, context) {
  const me = boardBefore.turn();
  const ctx = context || {};
  const tags = [];
  const missedMate = mateIsMine(ctx.prev_mate, me) && playedUci !== bestUci;
  if (missedMate) tags.push("missed_mate");
  if (bestUci && winsMaterial(boardBefore, bestUci)) tags.push("missed_capture");
  else if (bestUci && forks(boardBefore, bestUci, ctx.pv && ctx.pv.length > 1 ? ctx.pv[1] : null)) tags.push("missed_fork");

  const after = clone(boardBefore);
  playUci(after, playedUci);
  const reply = ctx.reply || null;
  const replyLegal = reply !== null && legalMove(after, reply) !== undefined;
  // An even trade (I take, they take back the same value) is not a hung piece.
  if (replyLegal && winsMaterial(after, reply) && capturedValue(after, reply) > capturedValue(boardBefore, playedUci)) {
    tags.push("hung_piece");
  }

  let backRank = false;
  if (missedMate && bestUci) {
    const pv = ctx.pv && ctx.pv.length ? ctx.pv : [bestUci];
    backRank = myMovesInLine(boardBefore, bestUci, pv).some(([b, m]) => backRankMate(b, m));
  }
  if (!backRank && replyLegal && mateIsMine(ctx.mate_after, other(me))) {
    const king = kingSquare(after, me);
    const piece = after.get(reply.slice(0, 2));
    if ((piece.type === "r" || piece.type === "q") && rankOf(king) === homeRank(me)
        && rankOf(reply.slice(2, 4)) === homeRank(me)) {
      const check = clone(after);
      playUci(check, reply);
      backRank = check.isCheck();
    }
  }
  if (backRank) tags.push("back_rank");

  if (phaseOf(boardBefore) === "endgame") tags.push("endgame");
  return tags.length ? tags : [OTHER];
}

/** Tags for my move moves[k] (analysis objects), from the position before it. */
export function tagsForMove(boardBefore, moves, k, mineIsWhite) { // eslint-disable-line no-unused-vars
  const move = moves[k];
  if (!move.best_uci) return [OTHER];
  const nxt = k + 1 < moves.length ? moves[k + 1] : null;
  const reply = nxt ? (nxt.best_uci || nxt.uci) : null;
  const ctx = {
    prev_mate: k > 0 ? (moves[k - 1].mate ?? null) : null,
    mate_after: move.mate ?? null,
    reply,
    pv: move.pv || [],
  };
  return tagMistake(boardBefore, move.uci, move.best_uci, ctx);
}
