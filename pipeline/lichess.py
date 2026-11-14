"""Import a slice of the Lichess puzzle database into data/themed.json.

Run by hand (it is not part of the nightly workflow):

    .venv/bin/python pipeline/lichess.py

The database (CC0, about 300 MB compressed) is downloaded once to
.cache/lichess_db_puzzle.csv.zst and stream-decompressed, never loaded whole.

How puzzles are chosen: my mistake tags are counted in data/puzzles.json and
config [themed] total is split across the tags that have Lichess themes, in
proportion to how often I make each (at least MIN_PER_TAG each). For each tag
the most-played puzzles that match any of its themes, fall in the rating range
and clear the popularity and plays floors are kept (ties broken by puzzle id,
so the result is deterministic). A puzzle is used for at most one tag; tags
with larger quotas choose first. The file interleaves the tags in proportion
to their quotas, so playing it in order mixes weaknesses.

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
from collections import Counter

import chess
import requests
import zstandard

import fetch

URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"
CACHE = fetch.ROOT / ".cache" / "lichess_db_puzzle.csv.zst"
OUT = fetch.DATA / "themed.json"
USER_AGENT = "chess-coach/0.1"
MIN_PER_TAG = 100
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


def allocate(counts, total, minimum=MIN_PER_TAG):
    """Split total across tags in proportion to counts, at least minimum each.

    Tags with a zero count get nothing. Returns {tag: quota} summing to total
    (or to minimum * number of tags when that is already more than total).
    """
    tags = [t for t, n in counts.items() if n > 0]
    quota = {}
    if not tags:
        return quota
    if minimum * len(tags) >= total:
        return {t: minimum for t in tags}
    free = list(tags)
    left = total
    while True:  # tags whose share falls below the minimum are pinned to it
        weight = sum(counts[t] for t in free)
        low = [t for t in free if left * counts[t] / weight < minimum]
        if not low:
            break
        for t in low:
            quota[t] = minimum
            free.remove(t)
            left -= minimum
    weight = sum(counts[t] for t in free)
    shares = {t: left * counts[t] / weight for t in free}
    for t in free:
        quota[t] = int(shares[t])
    spare = total - sum(quota.values())
    for t in sorted(free, key=lambda t: (-(shares[t] - int(shares[t])), t))[:spare]:
        quota[t] += 1
    return quota


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


def qualifies(row, cfg):
    try:
        return (cfg["rating_min"] <= int(row["Rating"]) <= cfg["rating_max"]
                and int(row["Popularity"]) >= cfg["min_popularity"]
                and int(row["NbPlays"]) >= cfg["min_plays"])
    except (ValueError, KeyError):
        return False


def select(row_iter, quotas, cfg):
    """Pick puzzles for each tag from an iterable of CSV rows; returns the puzzle list.

    Each tag first keeps its `total` most-played candidates (so overlaps between
    tags can still be filled), then tags in order of quota take unused ones.
    """
    keep = max(sum(quotas.values()), 1)
    heaps = {t: [] for t in quotas}
    theme_tags = {}
    for tag in quotas:
        for theme in TAG_THEMES[tag]:
            theme_tags.setdefault(theme, []).append(tag)
    for row in row_iter:
        hit = {t for theme in row["Themes"].split() for t in theme_tags.get(theme, ())}
        if not hit or not qualifies(row, cfg):
            continue
        key = (int(row["NbPlays"]), row["PuzzleId"])
        for tag in hit:
            heap = heaps[tag]
            if len(heap) < keep:
                heapq.heappush(heap, (key, row["PuzzleId"], row))
            elif key > heap[0][0]:
                heapq.heapreplace(heap, (key, row["PuzzleId"], row))
    used = set()
    out = []
    for tag in sorted(quotas, key=lambda t: (-quotas[t], t)):
        n = 0
        for _, _, row in sorted(heaps[tag], key=lambda h: h[0], reverse=True):
            if n >= quotas[tag]:
                break
            if row["PuzzleId"] in used:
                continue
            puzzle = row_to_puzzle(row, tag)
            if puzzle:
                used.add(row["PuzzleId"])
                out.append((n / quotas[tag], tag, puzzle))
                n += 1
    # Interleave the tags in proportion to their quotas, most-played first within each
    out.sort(key=lambda t: t[:2])
    return [puzzle for _, _, puzzle in out]


def my_tag_counts():
    puzzles = json.loads((fetch.DATA / "puzzles.json").read_text())["puzzles"]
    return Counter(t for p in puzzles for t in p.get("tags", ()))


def main():
    cfg = tomllib.loads((fetch.ROOT / "pipeline" / "config.toml").read_text())["themed"]
    counts = my_tag_counts()
    print("My tag counts:", dict(counts))
    quotas = allocate({t: counts[t] for t in TAG_THEMES if counts[t]}, cfg["total"])
    print("Allocation:", quotas)
    download()
    puzzles = select(rows(), quotas, cfg)
    per_tag = Counter(p["tag"] for p in puzzles)
    for tag, quota in quotas.items():
        print(f"  {tag:15s} wanted {quota:4d}  got {per_tag[tag]:4d}")
    OUT.write_text(json.dumps({"source": SOURCE, "puzzles": puzzles}, separators=(",", ":")))
    print(f"Wrote {len(puzzles)} puzzle(s) to {OUT.name}")


if __name__ == "__main__":
    sys.exit(main())
