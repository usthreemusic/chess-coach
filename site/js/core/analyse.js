// Port of pipeline/analyse.py. The engine is injected: evaluate(fen, { multipv }) resolves to
// an array of lines, best first: [{ cp, mate, pv }] with scores from the side to move's point
// of view (mate is the signed mate distance, with cp null, or null when not a forced mate) and
// pv an array of UCI moves.
import { Chess } from "../../vendor/chess.js";
import { CONFIG } from "./config.js";
import { clone, legalMove, playUci, terminalState, uciOf } from "./chessutil.js";

/**
 * Label a move by its eval drop (centipawns, mover's perspective).
 * Moves made when the game was already lost, or that leave it still completely won, are not labelled.
 */
export function classify(drop, before, after, thresholds, decided) {
  if (before <= -decided || after >= decided) return null;
  if (drop >= thresholds.blunder) return "blunder";
  if (drop >= thresholds.mistake) return "mistake";
  if (drop >= thresholds.inaccuracy) return "inaccuracy";
  return null;
}

const CLK = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d*)?)\]/;
const RESULTS = new Set(["1-0", "0-1", "1/2-1/2", "*"]);

/** Plies of a PGN's main line: [{ san, clk }] where clk is seconds (1 decimal) or null. */
export function parseMovetext(pgn) {
  const text = String(pgn).replace(/^\s*\[\w+\s+"(?:[^"\\]|\\.)*"\]\s*$/gm, "");
  const plies = [];
  let depth = 0, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "{") {
      const end = text.indexOf("}", i);
      const comment = text.slice(i + 1, end === -1 ? n : end);
      i = end === -1 ? n : end + 1;
      const last = plies[plies.length - 1];
      if (depth === 0 && last && last.clk === null) {
        const m = CLK.exec(comment);
        if (m) last.clk = Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 10) / 10;
      }
      continue;
    }
    if (c === ";") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === "(") { depth++; i++; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); i++; continue; }
    if (c === "}") { i++; continue; } // stray closer
    let j = i;
    while (j < n && !/[\s{}();]/.test(text[j])) j++;
    let token = text.slice(i, j);
    i = j;
    if (depth > 0 || token.startsWith("$")) continue;
    if (RESULTS.has(token)) break;
    token = token.replace(/^\d+\.+/, "").replace(/[!?]+$/, "");
    if (token) plies.push({ san: token, clk: null });
  }
  return plies;
}

/** One entry per ply: seconds remaining after that move, or null when the PGN has no clock. */
export function clocksFromPgn(pgn) {
  return parseMovetext(pgn).map((p) => p.clk);
}

const sign = (colour) => (colour === "w" ? 1 : -1);
const clamp = (x, cap) => Math.max(-cap, Math.min(cap, x));
const nz = (x) => (x === 0 ? 0 : x); // never -0

/** Score of an engine line from the side to move's view, capped; mate counts as +/-cap. */
function lineScore(line, cap) {
  if (line.mate !== null && line.mate !== undefined) return line.mate > 0 ? cap : -cap;
  return clamp(line.cp, cap);
}

function pvSan(chess, pvUci, length = 3) {
  const scratch = clone(chess);
  const line = [];
  for (const uci of pvUci.slice(0, length)) {
    try {
      line.push(playUci(scratch, uci).san);
    } catch {
      break;
    }
  }
  return line;
}

/**
 * Analyse one game. `game` needs { id, colour, pgn }. Returns the object analyse.py writes
 * (after add_alternatives): { id, depth, start_cp, moves, counts, alts }.
 */
export async function analyseGame(game, evaluate, config = CONFIG) {
  const { cap, thresholds } = config;
  const decided = config.decidedCp;
  const myColour = game.colour === "white" ? "w" : "b";
  const plies = parseMovetext(game.pgn);

  const chess = new Chess();
  const seen = new Map();
  const positionKey = () => chess.fen().split(" ").slice(0, 4).join(" ");
  const countPosition = () => {
    const key = positionKey();
    seen.set(key, (seen.get(key) || 0) + 1);
    return seen.get(key);
  };

  // White-perspective { cp, mate, pv } for the current position; never evaluates a finished game.
  const evaluateHere = async (repetitions) => {
    const turn = chess.turn();
    const state = terminalState(chess, repetitions);
    if (state === "checkmate") return { cp: turn === "w" ? -cap : cap, mate: 0, pv: [] };
    if (state) return { cp: 0, mate: null, pv: [] };
    const lines = await evaluate(chess.fen(), { multipv: 1 });
    const top = lines && lines[0];
    if (!top) throw new Error(`engine returned no line for ${chess.fen()}`);
    const s = sign(turn);
    const hasMate = top.mate !== null && top.mate !== undefined;
    return {
      cp: nz(lineScore(top, cap) * s),
      mate: hasMate ? nz(top.mate * s) : null,
      pv: top.pv || [],
    };
  };

  let { cp, mate, pv } = await evaluateHere(countPosition());
  const out = { id: game.id, depth: config.depth, start_cp: cp, moves: [] };
  const counts = { inaccuracy: 0, mistake: 0, blunder: 0 };

  for (const ply of plies) {
    const mover = chess.turn();
    const s = sign(mover);
    const bestUci = pv.length ? pv[0] : null;
    const bestMove = bestUci ? legalMove(chess, bestUci) : undefined;
    const pvSans = bestMove ? pvSan(chess, pv) : null; // from the position before the move
    const done = chess.move(ply.san);
    const uci = uciOf(done);
    const entry = { san: done.san, uci };
    if (bestMove && bestUci !== uci) {
      entry.best = bestMove.san;
      entry.best_uci = bestUci;
      entry.pv = pvSans;
    }
    const beforeCp = cp * s;
    ({ cp, mate, pv } = await evaluateHere(countPosition()));
    entry.cp = cp;
    if (mate !== null) entry.mate = mate;
    if (ply.clk !== null) entry.clk = ply.clk;

    const drop = nz(beforeCp - cp * s);
    // No engine best move for this position: nothing to compare against, so no label.
    const label = bestMove && bestUci !== uci ? classify(drop, beforeCp, nz(cp * s), thresholds, decided) : null;
    if (label) {
      entry.class = label;
      entry.drop = drop;
      if (mover === myColour) counts[label] += 1;
    }
    out.moves.push(entry);
  }
  out.counts = counts;
  await addAlternatives(game, out, evaluate, config);
  return out;
}

/**
 * Record other good answers for each of my mistakes and blunders: any move scoring within
 * altMarginCp of the top line (searched with multipv 4) other than the best and the played move.
 */
async function addAlternatives(game, analysis, evaluate, config) {
  const { cap } = config;
  const margin = config.altMarginCp;
  const myColour = game.colour === "white" ? "w" : "b";
  const chess = new Chess();
  for (const move of analysis.moves) {
    if (chess.turn() === myColour && (move.class === "mistake" || move.class === "blunder") && move.best_uci) {
      const lines = (await evaluate(chess.fen(), { multipv: 4 })) || [];
      const scored = [];
      for (const line of lines) {
        if (line.pv && line.pv.length) scored.push([line.pv[0], lineScore(line, cap)]);
      }
      const top = scored.length ? Math.max(...scored.map(([, s]) => s)) : 0;
      const alts = scored
        .filter(([uci, s]) => s >= top - margin && uci !== move.best_uci && uci !== move.uci)
        .map(([uci]) => legalMove(chess, uci))
        .filter(Boolean);
      if (alts.length) {
        move.alts = alts.map(uciOf);
        move.alts_san = alts.map((m) => m.san);
      }
    }
    playUci(chess, move.uci);
  }
  analysis.alts = config.analysisVersion;
  return analysis;
}
