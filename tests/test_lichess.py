import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import lichess

# Black to move in the FEN: the opponent plays e7e5, then the solver plays g1f3, the reply is b8c6.
ROW = {"PuzzleId": "abc12", "FEN": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
       "Moves": "e7e5 g1f3 b8c6", "Rating": "1000", "RatingDeviation": "75", "Popularity": "90",
       "NbPlays": "1200", "Themes": "fork opening short", "GameUrl": "", "OpeningTags": ""}


def test_row_to_puzzle():
    p = lichess.row_to_puzzle(ROW, "missed_fork")
    assert p == {
        "id": "abc12", "tag": "missed_fork", "last_uci": "e7e5", "solution": ["g1f3", "b8c6"],
        "fen": "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        "rating": 1000, "themes": ["fork", "opening", "short"],
    }


def test_invalid_rows_are_dropped():
    assert lichess.row_to_puzzle({**ROW, "Moves": "e7e5 g1g5"}, "x") is None  # illegal reply
    assert lichess.row_to_puzzle({**ROW, "Moves": "e7e5"}, "x") is None  # no solution
    assert lichess.row_to_puzzle({**ROW, "Moves": "nonsense moves"}, "x") is None
    assert lichess.row_to_puzzle({**ROW, "Rating": "high"}, "x") is None


def row(pid, plays, themes, rating="1000", pop="90"):
    return {**ROW, "PuzzleId": pid, "NbPlays": str(plays), "Themes": themes, "Rating": rating, "Popularity": pop}


CFG = {"per_tag": 2, "min_popularity": 80, "min_plays": 500}


def test_band_of_and_qualifies():
    assert lichess.band_of(row("a", 1, "x", rating="600")) == 600
    assert lichess.band_of(row("a", 1, "x", rating="799")) == 600
    assert lichess.band_of(row("a", 1, "x", rating="800")) == 800
    assert lichess.band_of(row("a", 1, "x", rating="1999")) == 1800
    assert lichess.band_of(row("a", 1, "x", rating="599")) is None
    assert lichess.band_of(row("a", 1, "x", rating="2000")) is None
    assert lichess.qualifies(row("a", 600, "x", rating="1250"), CFG) == 1200
    assert lichess.qualifies(row("a", 499, "x"), CFG) is None  # too few plays
    assert lichess.qualifies(row("a", 600, "x", pop="79"), CFG) is None  # not popular enough
    assert lichess.qualifies(row("a", 600, "x", rating="oops"), CFG) is None


def test_select_per_band_one_tag_per_puzzle_and_most_played_first():
    rows = [
        row("p1", 5000, "hangingPiece"),
        row("p2", 4000, "hangingPiece defensiveMove"),
        row("p3", 3000, "defensiveMove"),
        row("p4", 9000, "fork"),
        row("low", 100, "fork"),  # too few plays
        row("p5", 3000, "fork"),
        row("p6", 3500, "fork"),
        row("hard", 9000, "fork", rating="1250"),  # lands in another band
        row("easy", 9000, "fork", rating="500"),  # below every band
        row("none", 9000, "opening"),  # no tag has this theme
    ]
    out = lichess.select(rows, CFG, bands=[1000, 1200])
    assert set(out) == {1000, 1200}
    assert set(out[1000]) == set(lichess.TAG_THEMES)
    ids = {tag: [p["id"] for p in puzzles] for tag, puzzles in out[1000].items()}
    assert ids["missed_fork"] == ["p4", "p6"]  # per_tag caps at 2, most played first
    # tags with fewer candidates pick first: missed_capture (p1, p2) before hung_piece (p1, p2, p3)
    assert ids["missed_capture"] == ["p1", "p2"]
    assert ids["hung_piece"] == ["p3"]
    assert ids["missed_mate"] == [] and ids["back_rank"] == []
    assert all(p["tag"] == tag for tag, ps in out[1000].items() for p in ps)
    assert [p["id"] for p in out[1200]["missed_fork"]] == ["hard"]
    seen = [p["id"] for ps in out[1000].values() for p in ps]
    assert len(seen) == len(set(seen))  # a puzzle is used once per band
