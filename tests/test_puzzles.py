import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import puzzles

GAME = {"id": "g1", "colour": "black", "end_time": 1700000000, "time_class": "blitz", "opening": "Sicilian Defense"}
ANALYSIS = {
    "moves": [
        {"san": "e4", "uci": "e2e4", "class": "blunder", "drop": 300, "best": "d4", "best_uci": "d2d4", "pv": ["d4"]},  # opponent's: ignored
        {"san": "f6", "uci": "f7f6", "class": "mistake", "drop": 150, "best": "e5", "best_uci": "e7e5", "pv": ["e5", "Nf3"]},
        {"san": "Qh5+", "uci": "d1h5"},
        {"san": "g6", "uci": "g7g6", "class": "inaccuracy", "drop": 60, "best": "Kf7", "best_uci": "e8f7", "pv": ["Kf7"]},  # too small
    ]
}


def test_builds_only_my_mistakes():
    result = puzzles.build_puzzles(GAME, ANALYSIS)
    assert len(result) == 1
    p = result[0]
    assert p["id"] == "g1:2"
    assert p["ply"] == 2
    assert p["fen"] == "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    assert (p["best_uci"], p["best_san"], p["pv"]) == ("e7e5", "e5", ["e5", "Nf3"])
    assert (p["played_san"], p["class"], p["drop"]) == ("f6", "mistake", 150)
    assert p["opening"] == "Sicilian Defense"
    assert (p["opening_family"], p["colour"]) == ("Sicilian Defense", "black")


def test_puzzles_carry_tags():
    result = puzzles.build_puzzles(GAME, ANALYSIS)
    assert result[0]["tags"] == ["other"]
