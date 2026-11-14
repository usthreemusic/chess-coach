// Port of pipeline/chessutil.py plus the python-chess helpers the other ports need
// (chess.js has no attacks(), is_en_passant(), python-chess game-over rules, ...).
import { Chess } from "../../vendor/chess.js";

export const VALUES = { q: 9, r: 5, b: 3, n: 3 };
export const OPENING_MOVES = 12; // my full-move numbers below this are the opening
export const ENDGAME_MATERIAL = 13; // non-pawn material of both sides together

/** Queens, rooks, bishops and knights of both sides, in points. */
export function material(chess) {
  let total = 0;
  for (const row of chess.board()) for (const p of row) if (p) total += VALUES[p.type] || 0;
  return total;
}

/** Phase of the position before my move. */
export function phaseOf(chess) {
  if (chess.moveNumber() < OPENING_MOVES) return "opening";
  return material(chess) <= ENDGAME_MATERIAL ? "endgame" : "middlegame";
}

export const other = (colour) => (colour === "w" ? "b" : "w");
export const clone = (chess) => new Chess(chess.fen());
export const uciOf = (m) => m.from + m.to + (m.promotion || "");
export const rankOf = (sq) => Number(sq[1]) - 1; // 0 = rank 1, as python-chess
const fileOf = (sq) => sq.charCodeAt(0) - 97;
const squareName = (f, r) => String.fromCharCode(97 + f) + (r + 1);

/** The legal move (verbose chess.js object) with this UCI string, or undefined. */
export function legalMove(chess, uci) {
  return chess.moves({ verbose: true }).find((m) => uciOf(m) === uci);
}

/** Play a UCI move (throws if illegal) and return chess.js's move object. */
export function playUci(chess, uci) {
  return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

export function kingSquare(chess, colour) {
  for (const row of chess.board()) for (const p of row) if (p && p.type === "k" && p.color === colour) return p.square;
  return null;
}

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Squares attacked by the piece on `square` (python-chess board.attacks()): includes squares holding own pieces. */
export function attacksFrom(chess, square) {
  const piece = chess.get(square);
  if (!piece) return [];
  const f = fileOf(square), r = rankOf(square), out = [];
  const add = (nf, nr) => {
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) { out.push(squareName(nf, nr)); return true; }
    return false;
  };
  if (piece.type === "p") {
    const dr = piece.color === "w" ? 1 : -1;
    add(f - 1, r + dr); add(f + 1, r + dr);
  } else if (piece.type === "n" || piece.type === "k") {
    for (const [df, dr] of piece.type === "n" ? KNIGHT : KING) add(f + df, r + dr);
  } else {
    const dirs = piece.type === "b" ? DIAG : piece.type === "r" ? ORTHO : [...DIAG, ...ORTHO];
    for (const [df, dr] of dirs) {
      for (let nf = f + df, nr = r + dr; add(nf, nr); nf += df, nr += dr) {
        if (chess.get(squareName(nf, nr))) break;
      }
    }
  }
  return out;
}

// python-chess has_insufficient_material(colour)
function insufficientFor(chess, colour) {
  const mine = [], theirs = [];
  const bishops = [];
  let pawnsOrKnightsAny = false;
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p) continue;
      if (p.type === "p" || p.type === "n") pawnsOrKnightsAny = true;
      if (p.type === "b") bishops.push(p.square);
      (p.color === colour ? mine : theirs).push(p);
    }
  }
  if (mine.some((p) => p.type === "p" || p.type === "r" || p.type === "q")) return false;
  if (mine.some((p) => p.type === "n")) {
    return mine.length <= 2 && !theirs.some((p) => p.type !== "k" && p.type !== "q");
  }
  if (mine.some((p) => p.type === "b")) {
    const colours = new Set(bishops.map((sq) => (fileOf(sq) + rankOf(sq)) % 2));
    return colours.size <= 1 && !pawnsOrKnightsAny;
  }
  return true;
}

export const isInsufficientMaterial = (chess) => insufficientFor(chess, "w") && insufficientFor(chess, "b");

/**
 * Game-over state as python-chess board.is_game_over() defines it (no claimable draws):
 * "checkmate", "draw" (stalemate, insufficient material, 75-move rule, fivefold repetition) or null.
 * `repetitions` is the count of the current position so far in the game, when known.
 */
export function terminalState(chess, repetitions = 1) {
  if (chess.isCheckmate()) return "checkmate";
  if (chess.isStalemate() || isInsufficientMaterial(chess)) return "draw";
  const halfmove = Number(chess.fen().split(" ")[4]);
  if (halfmove >= 150 || repetitions >= 5) return "draw";
  return null;
}
