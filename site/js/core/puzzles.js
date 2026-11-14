// Port of pipeline/puzzles.py build_puzzles: puzzles from my own mistakes and blunders.
import { Chess } from "../../vendor/chess.js";
import { openingFamily } from "./normalise.js";
import { playUci } from "./chessutil.js";
import { tagsForMove } from "./themes.js";

const KEPT = ["mistake", "blunder"];

/** Return the puzzles for one game, given its game (archive) and analysis objects. */
export function buildPuzzles(game, analysis) {
  const mineIsWhite = game.colour === "white";
  const board = new Chess();
  const puzzles = [];
  analysis.moves.forEach((move, k) => {
    const mine = (k % 2 === 0) === mineIsWhite;
    if (mine && KEPT.includes(move.class) && move.best_uci) {
      puzzles.push({
        id: `${game.id}:${k + 1}`,
        game_id: game.id,
        ply: k + 1,
        fen: board.fen(),
        best_uci: move.best_uci,
        best_san: move.best,
        pv: move.pv,
        alts: move.alts ?? [],
        alts_san: move.alts_san ?? [],
        played_san: move.san,
        class: move.class,
        drop: move.drop,
        end_time: game.end_time,
        time_class: game.time_class,
        opening: game.opening ?? "",
        opening_family: openingFamily(game.opening ?? ""),
        colour: game.colour,
        tags: tagsForMove(board, analysis.moves, k, mineIsWhite),
      });
    }
    playUci(board, move.uci);
  });
  return puzzles;
}
