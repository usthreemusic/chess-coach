"""Import a generic, per-rating-band slice of the Lichess puzzle database into data/themed/.

Run by hand (it is not part of the deploy workflow):

    .venv/bin/python pipeline/lichess.py

The database (CC0, about 300 MB compressed) is downloaded once to
.cache/lichess_db_puzzle.csv.zst and stream-decompressed, never loaded whole.

The pool does not depend on any one player. For each rating band 600, 800, ..., 1800
(band b covers ratings b <= r < b + 200) and each mistake tag with Lichess themes, the
`per_tag` most-played puzzles that match any of the tag's themes and clear the popularity
and plays floors are kept (ties broken by puzzle id, so the result is deterministic). A
puzzle is used for at most one tag per band; tags with fewer candidates choose first.
Each band is written to data/themed/{band}.json as
{"source", "band", "puzzles": {tag: [puzzle, ...]}} with each tag's list most-played first;
the browser picks from it in proportion to the player's own mistakes.

Lichess format: FEN is the position before the opponent's move, and Moves is
UCI where the first move is the opponent's and the solver's moves alternate
from the second.
"""

import csv
import heapq
import io
import json
import sys
import tomllib
from pathlib import Path

import chess
import requests
import zstandard

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"
CACHE = ROOT / ".cache" / "lichess_db_puzzle.csv.zst"
OUT = DATA / "themed"
USER_AGENT = "chess-coach/0.1"
BANDS = range(600, 2000, 200)  # 600, 800, ..., 1800
BAND_WIDTH = 200
SOURCE = "Lichess puzzle database (CC0)"

TAG_THEMES = {
    "missed_mate": ["mateIn1", "mateIn2"],
    "missed_capture": ["hangingPiece"],
    "missed_fork": ["fork"],
    "hung_piece": ["hangingPiece", "defensiveMove"],
    "back_rank": ["backRankMate"],
    "endgame": ["endgame"],
}


def download(path=CACHE):
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(path.suffix + ".part")
    print(f"Downloading {URL} ...")
    with requests.get(URL, headers={"User-Agent": USER_AGENT}, stream=True, timeout=60) as resp:
        resp.raise_for_status()
        with open(part, "wb") as f:
            for chunk in resp.iter_content(1 << 20):
                f.write(chunk)
    part.rename(path)


def row_to_puzzle(row, tag):
    """Convert one CSV row (dict) to a themed puzzle, or None if it is not valid."""
    try:
        moves = row["Moves"].split()
        board = chess.Board(row["FEN"])
        first = chess.Move.from_uci(moves[0])
        if first not in board.legal_moves or len(moves) < 2:
            return None
        board.push(first)
        fen = board.fen()
        for uci in moves[1:]:
            move = chess.Move.from_uci(uci)
            if move not in board.legal_moves:
                return None
            board.push(move)
        rating = int(row["Rating"])
    except (ValueError, KeyError, IndexError):
        return None
    return {"id": row["PuzzleId"], "tag": tag, "fen": fen, "last_uci": moves[0],
            "solution": moves[1:], "rating": rating, "themes": row["Themes"].split()}


def rows(path=CACHE):
    with open(path, "rb") as f:
        reader = zstandard.ZstdDecompressor().stream_reader(f)
        yield from csv.DictReader(io.TextIOWrapper(reader, encoding="utf-8", newline=""))


def band_of(row):
    """The band (600, 800, ...) a row's rating falls in, or None outside the bands."""
    band = int(row["Rating"]) // BAND_WIDTH * BAND_WIDTH
    return band if band in BANDS else None


def qualifies(row, cfg):
    """The band of a row that clears the popularity and plays floors, else None."""
    try:
        if int(row["Popularity"]) < cfg["min_popularity"] or int(row["NbPlays"]) < cfg["min_plays"]:
            return None
        return band_of(row)
    except (ValueError, KeyError):
        return None


def select(row_iter, cfg, bands=BANDS):
    """Pick puzzles for every band and tag; returns {band: {tag: [puzzle, ...]}}.

    Each (band, tag) first keeps its most-played candidates (enough that overlaps
    between tags can still be filled), then tags with the fewest candidates take
    unused ones, so a puzzle appears under one tag per band. Lists are most-played first.
    """
    per_tag = cfg["per_tag"]
    keep = per_tag * len(TAG_THEMES)
    heaps = {b: {t: [] for t in TAG_THEMES} for b in bands}
    theme_tags = {}
    for tag, themes in TAG_THEMES.items():
        for theme in themes:
            theme_tags.setdefault(theme, []).append(tag)
    for row in row_iter:
        hit = {t for theme in row["Themes"].split() for t in theme_tags.get(theme, ())}
        if not hit:
            continue
        band = qualifies(row, cfg)
        if band not in heaps:
            continue
        key = (int(row["NbPlays"]), row["PuzzleId"])
        for tag in hit:
            heap = heaps[band][tag]
            if len(heap) < keep:
                heapq.heappush(heap, (key, row))
            elif key > heap[0][0]:
                heapq.heapreplace(heap, (key, row))
    out = {}
    for band in bands:
        used = set()
        out[band] = {tag: [] for tag in TAG_THEMES}
        for tag in sorted(TAG_THEMES, key=lambda t: (len(heaps[band][t]), t)):
            for _, row in sorted(heaps[band][tag], key=lambda h: h[0], reverse=True):
                if len(out[band][tag]) >= per_tag:
                    break
                if row["PuzzleId"] in used:
                    continue
                puzzle = row_to_puzzle(row, tag)
                if puzzle:
                    used.add(row["PuzzleId"])
                    out[band][tag].append(puzzle)
    return out


def main():
    cfg = tomllib.loads((ROOT / "pipeline" / "config.toml").read_text())["themed"]
    download()
    pool = select(rows(), cfg)
    OUT.mkdir(parents=True, exist_ok=True)
    for band, by_tag in pool.items():
        path = OUT / f"{band}.json"
        path.write_text(json.dumps({"source": SOURCE, "band": band, "puzzles": by_tag}, separators=(",", ":")))
        counts = " ".join(f"{tag}={len(p)}" for tag, p in by_tag.items())
        print(f"{path.name}: {path.stat().st_size / 1024:.0f} KB  {counts}")


if __name__ == "__main__":
    sys.exit(main())
