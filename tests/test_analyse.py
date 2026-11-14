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
