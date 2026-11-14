"""Build training puzzles from my own mistakes and blunders into data/puzzles.json.

Each puzzle is the position before one of my moves classed "mistake" or
"blunder" in data/analysis/, with the engine's preferred move as the answer.
Analysis files that cannot be read (for example half-written) are skipped.
"""

import json
import sys
from collections import Counter

import chess

import fetch
import themes

ANALYSIS = fetch.DATA / "analysis"
KEPT = ("mistake", "blunder")


def build_puzzles(game, analysis):
    """Return the puzzles for one game, given its archive and analysis dicts."""
    mine_is_white = game["colour"] == "white"
    board = chess.Board()
    puzzles = []
    for k, move in enumerate(analysis["moves"]):
        mine = (k % 2 == 0) == mine_is_white
        if mine and move.get("class") in KEPT and move.get("best_uci"):
            puzzles.append({
                "id": f"{game['id']}:{k + 1}",
                "game_id": game["id"],
                "ply": k + 1,
                "fen": board.fen(),
                "best_uci": move["best_uci"],
                "best_san": move["best"],
                "pv": move["pv"],
                "alts": move.get("alts", []),
                "alts_san": move.get("alts_san", []),
                "played_san": move["san"],
                "class": move["class"],
                "drop": move["drop"],
                "end_time": game["end_time"],
                "time_class": game["time_class"],
                "opening": game.get("opening", ""),
                "opening_family": fetch.opening_family(game.get("opening", "")),
                "colour": game["colour"],
                "tags": themes.tags_for_move(board, analysis["moves"], k, mine_is_white),
            })
        board.push_uci(move["uci"])
    return puzzles


def load_games():
    games = []
    for path in sorted(fetch.ARCHIVES.glob("*.json")):
        games.extend(json.loads(path.read_text())["games"])
    return games


def main():
    puzzles = []
    for game in load_games():
        path = ANALYSIS / f"{game['id']}.json"
        if not path.exists():
            continue
        try:
            puzzles.extend(build_puzzles(game, json.loads(path.read_text())))
        except (ValueError, KeyError, OSError) as err:  # bad or half-written file
            print(f"skipped {path.name}: {type(err).__name__}: {err}")
    puzzles.sort(key=lambda p: (p["end_time"], p["ply"]))
    out = fetch.DATA / "puzzles.json"
    out.write_text(json.dumps({"puzzles": puzzles}, separators=(",", ":")))
    families = Counter(p["opening_family"] for p in puzzles)
    for family, n in families.most_common():
        print(f"  {n:4d}  {family}")
    print(f"Wrote {len(puzzles)} puzzle(s) to {out.name}")


if __name__ == "__main__":
    sys.exit(main())
