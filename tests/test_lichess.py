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


def test_allocate_proportional_with_minimum():
    quota = lichess.allocate({"a": 600, "b": 300, "c": 90, "d": 10, "e": 0}, 1000, minimum=100)
    assert sum(quota.values()) == 1000
    assert "e" not in quota
    assert quota["c"] == quota["d"] == 100  # small tags are lifted to the minimum
    assert quota["a"] > quota["b"] > 100
    assert abs(quota["a"] - 2 * quota["b"]) <= 1  # 600:300 stays in proportion


def test_allocate_edge_cases():
    assert lichess.allocate({}, 1000) == {}
    assert lichess.allocate({"a": 5, "b": 5, "c": 5}, 200, minimum=100) == {"a": 100, "b": 100, "c": 100}
    assert lichess.allocate({"a": 1, "b": 1}, 10, minimum=1) == {"a": 5, "b": 5}


def test_select_one_tag_per_puzzle_and_most_played_first():
    cfg = {"rating_min": 800, "rating_max": 1300, "min_popularity": 80, "min_plays": 500}

    def row(pid, plays, themes, rating="1000", pop="90"):
        return {**ROW, "PuzzleId": pid, "NbPlays": str(plays), "Themes": themes, "Rating": rating, "Popularity": pop}

    rows = [
        row("p1", 5000, "hangingPiece"),
        row("p2", 4000, "hangingPiece defensiveMove"),
        row("p3", 3000, "defensiveMove"),
        row("p4", 9000, "fork"),
        row("low", 100, "fork"),  # too few plays
        row("hard", 9000, "fork", rating="2000"),  # outside the rating range
        row("p5", 3000, "fork"),
    ]
    out = lichess.select(rows, {"missed_capture": 2, "hung_piece": 1, "missed_fork": 1}, cfg)
    by_tag = {}
    for p in out:
        by_tag.setdefault(p["tag"], []).append(p["id"])
    assert by_tag["missed_capture"] == ["p1", "p2"]
    assert by_tag["hung_piece"] == ["p3"]  # p1 and p2 already used; only p3 remains
    assert by_tag["missed_fork"] == ["p4"]
    assert len({p["id"] for p in out}) == len(out)
