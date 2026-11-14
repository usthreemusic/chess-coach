// Plain-English "why is it best?" sentences for a best line, from chess rules only (no engine).
//
// explainLine(fen, line, info): fen is the position before the best move (player to move), line is the
// best line in SAN (my move, their reply, my move, ...), info is optional { playedSan, drop, tags }.
// Returns 1 to 4 short sentences, most important first. Never throws.
import { Chess } from "../../vendor/chess.js";
import { attacksFrom, clone, kingSquare, other, phaseOf } from "./chessutil.js";
import { POINTS, forks, winsMaterial } from "./themes.js";

const NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const NONE = "No explanation is available for this position.";
const MAX_ACHIEVE_PLIES = 5; // quote at most the best move plus four more

const uciOf = (m) => m.from + m.to + (m.promotion || "");
const a = (name) => (name === "queen" || name === "rook" || name === "pawn" || name === "knight" || name === "bishop" || name === "king" ? `a ${name}` : name);

/** Material (pawn 1, knight 3, bishop 3, rook 5, queen 9) for `colour` minus the other side. */
function balance(chess, colour) {
  let total = 0;
  for (const row of chess.board()) {
    for (const p of row) {
      if (p && p.type !== "k") total += (p.color === colour ? 1 : -1) * POINTS[p.type];
    }
  }
  return total;
}

/** Value of the cheapest `colour` piece attacking `square` (Infinity if none). */
function cheapestAttacker(chess, square, colour) {
  let best = Infinity;
  for (const row of chess.board()) {
    for (const p of row) {
      if (p && p.color === colour && attacksFrom(chess, p.square).includes(square)) best = Math.min(best, POINTS[p.type]);
    }
  }
  return best;
}

/** The same position with the other side to move, or null if chess.js rejects it (e.g. a king in check). */
function flipTurn(chess) {
  try {
    const parts = chess.fen().split(" ");
    parts[1] = other(chess.turn());
    parts[3] = "-";
    return new Chess(parts.join(" "));
  } catch {
    return null;
  }
}

/** Squares of my pieces that the enemy could take to win material right now (square -> piece type). */
function threatenedPieces(chess) {
  const flipped = flipTurn(chess);
  const out = {};
  if (!flipped) return out;
  try {
    for (const m of flipped.moves({ verbose: true })) {
      if (!(m.isCapture() || m.isEnPassant()) || m.captured === "k") continue;
      if (winsMaterial(flipped, uciOf(m))) out[m.to] = flipped.get(m.to)?.type ?? "p";
    }
  } catch { /* ignore */ }
  return out;
}

/** Names of the enemy pieces a forking move attacks, using the same criteria as themes.forks. */
function forkTargets(after, to) {
  const piece = after.get(to);
  const enemy = other(piece.color);
  const names = [];
  for (const sq of attacksFrom(after, to)) {
    const t = after.get(sq);
    if (!t || t.color !== enemy || t.type === "p") continue;
    if (t.type === "k" || POINTS[t.type] > POINTS[piece.type] || !after.isAttacked(sq, enemy)) names.push(NAMES[t.type]);
  }
  return names;
}

function listNames(names) {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  const parts = [...counts].map(([n, c]) => (c > 1 ? `two ${n}s` : n));
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const homeRank = (colour) => (colour === "w" ? "1" : "8");

/** Sentence about the best move itself. `steps` = [{san, move, before, after}] of the processed line. */
function describeBestMove(steps, me, tags) {
  const { san, move: m, before, after } = steps[0];
  const uci = uciOf(m);
  const enemy = other(me);

  if (after.isCheckmate()) { return { text: `${san} is checkmate.`, mate: true }; }

  const last = steps[steps.length - 1];
  if (steps.length >= 2 && last.after.isCheckmate() && last.move.color === me) {
    const n = Math.ceil(steps.length / 2);
    const king = kingSquare(last.before, enemy);
    const backRank = tags.includes("back_rank")
      || ((last.move.piece === "r" || last.move.piece === "q") && king && king[1] === homeRank(enemy) && last.move.to[1] === homeRank(enemy));
    const tail = backRank ? ", because the enemy king is trapped on its back rank" : "";
    return { text: `${san} starts a forced checkmate in ${n} moves${tail}.`, mate: true };
  }

  const isCapture = m.isCapture() || m.isEnPassant();
  const victim = m.isEnPassant() ? "p" : m.captured;
  if (isCapture && winsMaterial(before, uci)) {
    const free = !after.isAttacked(m.to, enemy);
    const text = free
      ? `${san} wins ${a(NAMES[victim])} for free.`
      : `${san} wins the ${NAMES[victim]} for your ${NAMES[m.piece]}.`;
    return { text, wins: true, gain: POINTS[victim] };
  }

  if (forks(before, uci)) {
    const names = forkTargets(after, m.to);
    return { text: `${san} forks the ${listNames(names)}.` };
  }

  if (isCapture) {
    if (POINTS[victim] < POINTS[m.piece]) return { text: `${san} takes the ${NAMES[victim]} on ${m.to}.` };
    return { text: `${san} trades your ${NAMES[m.piece]} for the ${NAMES[victim]}.` };
  }

  if (after.isCheck()) return { text: `${san} gives check, so your opponent must respond to it.` };

  if (m.promotion) return { text: `${san} promotes your pawn to ${a(NAMES[m.promotion])}.` };

  if (m.isKingsideCastle() || m.isQueensideCastle()) {
    return { text: `${san} gets your king to safety and brings the rook into play.` };
  }

  // A piece (not a pawn) that was under attack steps out of danger.
  if (m.piece !== "p" && before.isAttacked(m.from, enemy)) {
    const val = POINTS[m.piece];
    const wasInDanger = !before.isAttacked(m.from, me) || cheapestAttacker(before, m.from, enemy) < val;
    const nowSafe = !after.isAttacked(m.to, enemy)
      || (cheapestAttacker(after, m.to, enemy) >= val && after.isAttacked(m.to, me));
    if (wasInDanger && nowSafe) return { text: `${san} moves your ${NAMES[m.piece]} away from the attack.` };
  }

  // Defends a piece that the enemy could otherwise have won.
  const threats = threatenedPieces(before);
  const targets = Object.keys(threats).filter((sq) => sq !== m.from);
  let defended = null;
  for (const sq of targets) {
    const piece = after.get(sq);
    if (!piece || piece.color !== me || piece.type !== threats[sq]) continue;
    let stillLoses = false;
    for (const r of after.moves({ verbose: true })) {
      if (r.to === sq && (r.isCapture() || r.isEnPassant()) && winsMaterial(after, uciOf(r))) stillLoses = true;
    }
    if (!stillLoses && (!defended || POINTS[piece.type] > POINTS[defended.type])) defended = { type: piece.type, sq };
  }
  if (defended) return { text: `${san} defends your ${NAMES[defended.type]} on ${defended.sq}.` };

  if (phaseOf(before) === "opening" && (m.piece === "n" || m.piece === "b") && m.from[1] === homeRank(me) && m.to[1] !== homeRank(me)) {
    return { text: `${san} develops a piece.` };
  }

  // Attacks a piece the enemy cannot comfortably hold.
  const hits = [];
  const oldTargets = new Set(attacksFrom(before, m.from));
  for (const sq of attacksFrom(after, m.to)) {
    const t = after.get(sq);
    if (!t || t.color !== enemy || t.type === "k" || oldTargets.has(sq)) continue;
    if (POINTS[t.type] > POINTS[m.piece] || !after.isAttacked(sq, enemy)) hits.push(t.type);
  }
  if (hits.length === 1) return { text: `${san} attacks the ${NAMES[hits[0]]}, so your opponent has to deal with it.` };

  if (m.piece === "p" && "de".includes(m.to[0]) && "45".includes(m.to[1])) {
    return { text: `${san} stakes a claim in the centre.` };
  }
  if (m.piece === "k" && phaseOf(before) === "endgame") return { text: `${san} brings your king into the action.` };
  if (m.piece === "r") {
    let pawnsOnFile = 0;
    for (let r = 1; r <= 8; r++) if (after.get(m.to[0] + r)?.type === "p") pawnsOnFile++;
    if (pawnsOnFile === 0) return { text: `${san} puts your rook on an open file.` };
  }

  return { text: `${san} is the engine's top choice: a quiet move that keeps your position healthy.`, fallback: true };
}

function describePlayed(info) {
  const san = info.playedSan;
  if (!san) return null;
  const tags = Array.isArray(info.tags) ? info.tags : [];
  const hung = tags.includes("hung_piece");
  const missed = tags.includes("missed_mate");
  const hasDrop = typeof info.drop === "number" && Number.isFinite(info.drop);
  if (hung || missed) {
    const parts = [];
    if (hung) parts.push("left a piece where it could be taken");
    if (missed) parts.push("let a forced checkmate slip");
    let text = `Your move ${san} ${parts.join(" and ")}`;
    if (!missed && hasDrop && info.drop >= 1000) text += ", throwing away a winning advantage";
    else if (!missed && hasDrop && info.drop >= 10) text += `, costing you about ${pawns(info.drop)} worth of advantage`;
    return `${text}.`;
  }
  if (hasDrop && info.drop >= 1000) return `Your move ${san} threw away a winning advantage.`;
  if (hasDrop && info.drop > 0) return `Your move ${san} gave up about ${pawns(info.drop)} worth of advantage.`;
  return null;
}

function pawns(drop) {
  const v = (Math.round(drop / 10) / 10).toFixed(1);
  return v === "1.0" ? "1.0 pawn's" : `${v} pawns'`;
}

export function explainLine(fen, line, info = {}) {
  try {
    const moves = Array.isArray(line) ? line : [];
    const start = new Chess(fen);
    const me = start.turn();
    const tags = Array.isArray(info?.tags) ? info.tags : [];

    // Play the line, stopping quietly at the first illegal move.
    const steps = [];
    let cur = start;
    for (const san of moves) {
      const before = cur;
      const next = clone(before);
      let move;
      try { move = next.move(san); } catch { break; }
      if (!move) break;
      steps.push({ san: move.san, move, before, after: next });
      cur = next;
    }
    if (!steps.length) return [NONE];

    const out = [];
    const best = describeBestMove(steps, me, tags);
    // The stored line can stop short of a mate the engine saw; the missed_mate tag still tells us it is there.
    const hiddenMate = !best.mate && tags.includes("missed_mate");
    out.push(hiddenMate ? `${steps[0].san} is the first move of a forced checkmate.` : best.text);

    if (steps.length >= 3 && !best.mate && !hiddenMate) {
      const used = steps.slice(0, MAX_ACHIEVE_PLIES);
      const gain = balance(used[used.length - 1].after, me) - balance(start, me);
      const samePickup = best.wins && gain === best.gain;
      if (gain >= 1 && !samePickup) {
        const rest = used.slice(1).map((s) => s.san).join(" ");
        out.push(`After ${rest} you come out ${gain} point${gain === 1 ? "" : "s"} of material ahead.`);
      }
    }

    if (info && info.playedSan) {
      const played = describePlayed(info);
      if (played) out.push(played);
    }
    return out.slice(0, 4);
  } catch {
    return [NONE];
  }
}
