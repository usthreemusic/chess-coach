// Port of pipeline/stats.py: aggregate my moves into mistake statistics.
import { Chess } from "../../vendor/chess.js";
import { openingFamily } from "./normalise.js";
import { phaseOf, playUci } from "./chessutil.js";
import { KEPT, tagsForMove } from "./themes.js";

export const CLASSES = ["inaccuracy", "mistake", "blunder"];
const PRESSURE = 0.10;
const PIECES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
export const DIMENSIONS = ["phase", "opening", "colour", "time_class", "time_pressure", "piece", "month"];
export const MISTAKE_TYPE = "mistake_type"; // counts of tagged mistakes and blunders, not a rate
const PRESSURE_LOW = "under 10% of clock";
const PRESSURE_OK = "10% or more";

/** Base time in seconds from "600", "180+2" or "1/86400"; null if not live. */
export function baseSeconds(timeControl) {
  if (typeof timeControl !== "string" || timeControl.includes("/")) return null;
  const n = Number(timeControl.split("+")[0].trim());
  return Number.isNaN(n) ? null : n;
}

function pressureOf(game, move) {
  if (game.time_class === "daily" || move.clk === undefined || move.clk === null) return null;
  const base = baseSeconds(game.time_control);
  if (!base) return null;
  return move.clk < PRESSURE * base ? PRESSURE_LOW : PRESSURE_OK;
}

export function monthOf(endTime) {
  return new Date(endTime * 1000).toISOString().slice(0, 7);
}

/** One record per move of mine: {dimension: key, ..., class: string or null}. */
function gameRecords(game, analysis) {
  const mineIsWhite = game.colour === "white";
  const family = openingFamily(game.opening ?? "");
  const month = monthOf(game.end_time);
  const board = new Chess();
  const records = [];
  analysis.moves.forEach((move, k) => {
    if ((k % 2 === 0) === mineIsWhite) {
      const record = {
        phase: phaseOf(board),
        opening: family,
        colour: game.colour,
        time_class: game.time_class,
        time_pressure: pressureOf(game, move),
        piece: PIECES[board.get(move.uci.slice(0, 2)).type],
        month,
        class: CLASSES.includes(move.class) ? move.class : null,
      };
      if (KEPT.includes(record.class)) record.tags = tagsForMove(board, analysis.moves, k, mineIsWhite);
      records.push(record);
    }
    playUci(board, move.uci);
  });
  return records;
}

const newBucket = (key) => ({ key, games: new Set(), moves: 0, inaccuracy: 0, mistake: 0, blunder: 0 });

function addGame(buckets, gameId, records) {
  for (const record of records) {
    for (const dim of DIMENSIONS) {
      const key = record[dim];
      if (key === null) continue;
      if (!buckets[dim].has(key)) buckets[dim].set(key, newBucket(key));
      const b = buckets[dim].get(key);
      b.games.add(gameId);
      b.moves += 1;
      if (record.class) b[record.class] += 1;
    }
    for (const tag of record.tags || []) {
      if (!buckets[MISTAKE_TYPE].has(tag)) buckets[MISTAKE_TYPE].set(tag, newBucket(tag));
      const b = buckets[MISTAKE_TYPE].get(tag);
      b.games.add(gameId);
      b.moves += 1;
      b[record.class] += 1;
    }
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function finish(buckets) {
  const out = {};
  for (const [dim, byKey] of Object.entries(buckets)) {
    const rows = [...byKey.values()].map((b) => ({ ...b, games: b.games.size }));
    rows.sort((a, b) => (dim === "month" ? cmp(a.key, b.key) : (b.moves - a.moves) || cmp(a.key, b.key)));
    out[dim] = rows;
  }
  return out;
}

/** pairs: [{game, analysis}]. Returns exactly what pipeline/stats.py writes to data/stats.json. */
export function buildStats(pairs) {
  const buckets = {};
  for (const dim of [...DIMENSIONS, MISTAKE_TYPE]) buckets[dim] = new Map();
  let games = 0, moves = 0;
  const totals = { inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const { game, analysis } of pairs) {
    let records;
    try {
      records = gameRecords(game, analysis);
    } catch {
      continue; // an unreadable analysis is skipped, as in Python
    }
    addGame(buckets, game.id, records);
    games += 1;
    moves += records.length;
    for (const r of records) if (r.class) totals[r.class] += 1;
  }
  return { games, moves, totals, dimensions: finish(buckets) };
}
