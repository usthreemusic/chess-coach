import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import analyse

T = {"inaccuracy": 50, "mistake": 100, "blunder": 200}


def test_classify_thresholds():
    assert analyse.classify(49, 0, -49, T, 600) is None
    assert analyse.classify(50, 0, -50, T, 600) == "inaccuracy"
    assert analyse.classify(100, 0, -100, T, 600) == "mistake"
    assert analyse.classify(200, 0, -200, T, 600) == "blunder"


def test_classify_ignores_decided_positions():
    assert analyse.classify(300, -700, -1000, T, 600) is None  # already lost
    assert analyse.classify(300, 1000, 700, T, 600) is None  # still winning
    assert analyse.classify(900, 900, 0, T, 600) == "blunder"  # threw a win away


class FakeScore:
    def __init__(self, cp):
        self.cp = cp

    def pov(self, colour):
        return self

    def score(self, mate_score=None):
        return self.cp


class FakeEngine:
    """Returns fixed multi-line results: Nf3 best, then d4 close behind, then a3 far behind."""

    def analyse(self, board, limit, multipv=1):
        return [
            {"pv": [board.parse_san("Nf3")], "score": FakeScore(40)},
            {"pv": [board.parse_san("d4")], "score": FakeScore(10)},
            {"pv": [board.parse_san("a3")], "score": FakeScore(-80)},
        ]


def test_add_alternatives_keeps_only_close_moves():
    game = {"colour": "white"}
    analysis = {"moves": [
        {"san": "h4", "uci": "h2h4", "class": "mistake", "best": "Nf3", "best_uci": "g1f3"},
        {"san": "e5", "uci": "e7e5", "class": "mistake", "best": "d5", "best_uci": "d7d5"},
    ]}
    config = {"alt_margin_cp": 50, "analysis_depth": 1}
    analyse.add_alternatives(game, analysis, FakeEngine(), config)
    assert analysis["moves"][0]["alts"] == ["d2d4"]
    assert analysis["moves"][0]["alts_san"] == ["d4"]
    assert "alts" not in analysis["moves"][1]  # the opponent's move is left alone
    assert analysis["alts"] == analyse.ALTS_VERSION
