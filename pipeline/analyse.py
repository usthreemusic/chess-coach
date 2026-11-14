"""Analyse cached games with Stockfish and write data/analysis/{game_id}.json.

Every position in a game is evaluated once at a fixed depth, which gives the
evaluation before and after each move. A game that already has an analysis
file is never analysed again.

Usage: analyse.py [--limit N] [--workers N]
"""

import argparse
import io
import json
import os
import shutil
import sys
import tomllib
from multiprocessing import Pool

import chess
import chess.engine
import chess.pgn

import fetch

ANALYSIS = fetch.DATA / "analysis"
CAP = 1000  # centipawn cap; mate scores are stored as +/-CAP
ALTS_VERSION = 1  # bump to recompute alternative answers for every game

_engine = None
_config = None


def classify(drop, before, after, thresholds, decided):
    """Label a move by its eval drop (centipawns, mover's perspective).

    Moves made when the game was already lost, or that leave it still
    completely won, are not labelled.
    """
    if before <= -decided or after >= decided:
        return None
    if drop >= thresholds["blunder"]:
        return "blunder"
    if drop >= thresholds["mistake"]:
        return "mistake"
    if drop >= thresholds["inaccuracy"]:
        return "inaccuracy"
    return None


def evaluate(board, engine, depth):
    """Return (cp, mate, pv) for a position, scores from White's perspective."""
    if board.is_checkmate():
        return (-CAP if board.turn == chess.WHITE else CAP), 0, []
    if board.is_game_over():
        return 0, None, []
    info = engine.analyse(board, chess.engine.Limit(depth=depth))
    score = info["score"].white()
    cp = max(-CAP, min(CAP, score.score(mate_score=100000)))
    return cp, score.mate(), info.get("pv", [])


def pv_san(board, pv, length=3):
    line, scratch = [], board.copy(stack=False)
    for move in pv[:length]:
        line.append(scratch.san(move))
        scratch.push(move)
    return line


def analyse_game(game, engine, config):
    depth = config["analysis_depth"]
    thresholds = config["thresholds"]
    decided = config["decided_cp"]
    my_colour = chess.WHITE if game["colour"] == "white" else chess.BLACK

    parsed = chess.pgn.read_game(io.StringIO(game["pgn"]))
    board = parsed.board()
    cp, mate, pv = evaluate(board, engine, depth)
    out = {"id": game["id"], "depth": depth, "start_cp": cp, "moves": []}
    counts = {"inaccuracy": 0, "mistake": 0, "blunder": 0}

    for node in parsed.mainline():
        move = node.move
        mover = board.turn
        sign = 1 if mover == chess.WHITE else -1
        entry = {"san": board.san(move), "uci": move.uci()}
        best = pv[0] if pv else None
        if best and best != move:
            entry["best"] = board.san(best)
            entry["best_uci"] = best.uci()
            entry["pv"] = pv_san(board, pv)
        before = cp * sign

        board.push(move)
        cp, mate, pv = evaluate(board, engine, depth)
        entry["cp"] = cp
        if mate is not None:
            entry["mate"] = mate
        clock = node.clock()
        if clock is not None:
            entry["clk"] = round(clock, 1)

        drop = before - cp * sign
        label = classify(drop, before, cp * sign, thresholds, decided) if best != move else None
        if label:
            entry["class"] = label
            entry["drop"] = drop
            if mover == my_colour:
                counts[label] += 1
        out["moves"].append(entry)

    out["counts"] = counts
    return out


def add_alternatives(game, analysis, engine, config):
    """Record other good answers for each of my mistakes and blunders.

    The position before the move is searched for several lines; any move
    scoring within alt_margin_cp of the top line is stored in "alts", so the
    trainer can accept it as well as the single best move.
    """
    margin = config["alt_margin_cp"]
    my_colour = chess.WHITE if game["colour"] == "white" else chess.BLACK
    board = chess.Board()
    for move in analysis["moves"]:
        if board.turn == my_colour and move.get("class") in ("mistake", "blunder") and move.get("best_uci"):
            infos = engine.analyse(board, chess.engine.Limit(depth=config["analysis_depth"]), multipv=4)
            scored = []
            for info in infos:
                if info.get("pv"):
                    cp = info["score"].pov(board.turn).score(mate_score=100000)
                    scored.append((info["pv"][0], max(-CAP, min(CAP, cp))))
            top = max((cp for _, cp in scored), default=0)
            alts = [m for m, cp in scored if cp >= top - margin and m.uci() not in (move["best_uci"], move["uci"])]
            if alts:
                move["alts"] = [m.uci() for m in alts]
                move["alts_san"] = [board.san(m) for m in alts]
        board.push_uci(move["uci"])
    analysis["alts"] = ALTS_VERSION
    return analysis


def _start_engine():
    global _engine
    path = shutil.which(_config["stockfish_path"]) or "/usr/games/stockfish"
    _engine = chess.engine.SimpleEngine.popen_uci(path)
    _engine.configure({"Threads": 1, "Hash": 64})


def _init(config):
    global _config
    _config = config
    _start_engine()


def _work(game):
    path = ANALYSIS / f"{game['id']}.json"
    try:
        # An existing file only needs its alternative answers added.
        result = json.loads(path.read_text()) if path.exists() else analyse_game(game, _engine, _config)
        if result.get("alts") != ALTS_VERSION:
            add_alternatives(game, result, _engine, _config)
    except chess.engine.EngineTerminatedError as err:
        _start_engine()  # a dead engine must not fail every later game on this worker
        return game["id"], f"engine died: {err}"
    except Exception as err:  # one bad PGN must not stop the batch
        return game["id"], f"{type(err).__name__}: {err}"
    path.write_text(json.dumps(result, separators=(",", ":")))
    return game["id"], None


def is_done(game):
    path = ANALYSIS / f"{game['id']}.json"
    if not path.exists():
        return False
    try:
        return json.loads(path.read_text()).get("alts") == ALTS_VERSION
    except ValueError:
        return False


def pending_games():
    games = []
    for path in sorted(fetch.ARCHIVES.glob("*.json")):
        games.extend(json.loads(path.read_text())["games"])
    games = [g for g in games if not is_done(g)]
    games.sort(key=lambda g: g["end_time"], reverse=True)  # newest first
    return games


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, help="analyse at most this many games")
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = parser.parse_args()

    config = tomllib.loads((fetch.ROOT / "pipeline" / "config.toml").read_text())
    ANALYSIS.mkdir(parents=True, exist_ok=True)
    games = pending_games()
    remaining = len(games)
    if args.limit:
        games = games[: args.limit]
    print(f"{remaining} game(s) awaiting analysis; analysing {len(games)} with {args.workers} worker(s)")

    failed = 0
    if games:
        with Pool(args.workers, initializer=_init, initargs=(config,)) as pool:
            for done, (game_id, error) in enumerate(pool.imap_unordered(_work, games), 1):
                if error:
                    failed += 1
                    print(f"FAILED {game_id}: {error}")
                if done % 25 == 0 or done == len(games):
                    print(f"{done}/{len(games)}", flush=True)

    total = fetch.build_index(config["username"].lower())
    print(f"Done. {failed} failure(s). Index holds {total} games.")


if __name__ == "__main__":
    sys.exit(main())
