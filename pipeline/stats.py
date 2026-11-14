"""Aggregate my moves into mistake statistics in data/stats.json.

Every move of mine in data/analysis/ is placed into one bucket per dimension
(phase, opening, colour, time class, time pressure, piece, month). A bucket
counts my moves, the games they came from, and how many were classed
inaccuracy, mistake or blunder. Analysis files that cannot be read are skipped.
"""

import json
import sys
import time
from datetime import datetime, timezone

import chess

import fetch

ANALYSIS = fetch.DATA / "analysis"
CLASSES = ("inaccuracy", "mistake", "blunder")
VALUES = {chess.QUEEN: 9, chess.ROOK: 5, chess.BISHOP: 3, chess.KNIGHT: 3}
OPENING_MOVES = 12  # my full-move numbers below this are the opening
ENDGAME_MATERIAL = 13  # non-pawn material of both sides together
PRESSURE = 0.10
PIECES = {chess.PAWN: "pawn", chess.KNIGHT: "knight", chess.BISHOP: "bishop",
          chess.ROOK: "rook", chess.QUEEN: "queen", chess.KING: "king"}
DIMENSIONS = ("phase", "opening", "colour", "time_class", "time_pressure", "piece", "month")
PRESSURE_LOW = "under 10% of clock"
PRESSURE_OK = "10% or more"


def material(board):
    """Queens, rooks, bishops and knights of both sides, in points."""
    return sum(len(board.pieces(pt, colour)) * v
               for pt, v in VALUES.items() for colour in (chess.WHITE, chess.BLACK))


def phase_of(board):
    """Phase of the position before my move (board.fullmove_number is that move's number)."""
    if board.fullmove_number < OPENING_MOVES:
        return "opening"
    return "endgame" if material(board) <= ENDGAME_MATERIAL else "middlegame"


def base_seconds(time_control):
    """Base time in seconds from "600", "180+2" or "1/86400"; None if not live."""
    try:
        if "/" in time_control:
            return None
        return float(time_control.split("+")[0])
    except (TypeError, ValueError):
        return None


def pressure_of(game, move):
    """Time-pressure bucket for a move, or None when it does not apply."""
    if game.get("time_class") == "daily" or move.get("clk") is None:
        return None
    base = base_seconds(game.get("time_control"))
    if not base:
        return None
    return PRESSURE_LOW if move["clk"] < PRESSURE * base else PRESSURE_OK


def month_of(end_time):
    return datetime.fromtimestamp(end_time, timezone.utc).strftime("%Y-%m")


def game_records(game, analysis):
    """One record per move of mine: {dimension: key, ..., "class": str or None}."""
    mine_is_white = game["colour"] == "white"
    family = fetch.opening_family(game.get("opening", ""))
    month = month_of(game["end_time"])
    board = chess.Board()
    records = []
    for k, move in enumerate(analysis["moves"]):
        uci = chess.Move.from_uci(move["uci"])
        if (k % 2 == 0) == mine_is_white:
            record = {
                "phase": phase_of(board),
                "opening": family,
                "colour": game["colour"],
                "time_class": game["time_class"],
                "time_pressure": pressure_of(game, move),
                "piece": PIECES[board.piece_type_at(uci.from_square)],
                "month": month,
                "class": move.get("class") if move.get("class") in CLASSES else None,
            }
            records.append(record)
        board.push(uci)
    return records


def add_game(buckets, game_id, records):
    """Fold one game's records into buckets[dimension][key]."""
    for record in records:
        for dim in DIMENSIONS:
            key = record[dim]
            if key is None:
                continue
            b = buckets[dim].setdefault(key, {"key": key, "games": set(), "moves": 0,
                                              "inaccuracy": 0, "mistake": 0, "blunder": 0})
            b["games"].add(game_id)
            b["moves"] += 1
            if record["class"]:
                b[record["class"]] += 1


def finish(buckets):
    out = {}
    for dim, by_key in buckets.items():
        rows = [{**b, "games": len(b["games"])} for b in by_key.values()]
        rows.sort(key=lambda b: b["key"] if dim == "month" else (-b["moves"], b["key"]))
        out[dim] = rows
    return out


def main():
    buckets = {dim: {} for dim in DIMENSIONS}
    games = moves = 0
    totals = dict.fromkeys(CLASSES, 0)
    for game in load_games():
        path = ANALYSIS / f"{game['id']}.json"
        if not path.exists():
            continue
        try:
            records = game_records(game, json.loads(path.read_text()))
        except (ValueError, KeyError, TypeError, AttributeError, OSError) as err:
            print(f"skipped {path.name}: {type(err).__name__}: {err}")
            continue
        add_game(buckets, game["id"], records)
        games += 1
        moves += len(records)
        for r in records:
            if r["class"]:
                totals[r["class"]] += 1
    out = fetch.DATA / "stats.json"
    out.write_text(json.dumps({"generated": int(time.time()), "games": games, "moves": moves,
                               "totals": totals, "dimensions": finish(buckets)},
                              separators=(",", ":")))
    print(f"Wrote stats for {games} game(s), {moves} move(s) to {out.name}")


def load_games():
    games = []
    for path in sorted(fetch.ARCHIVES.glob("*.json")):
        games.extend(json.loads(path.read_text())["games"])
    return games


if __name__ == "__main__":
    sys.exit(main())
