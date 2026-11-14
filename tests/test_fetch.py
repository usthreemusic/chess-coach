import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import fetch

PGN = '[Event "Live Chess"]\n[ECO "B20"]\n[ECOUrl "https://www.chess.com/openings/Sicilian-Defense"]\n\n1. e4 c5 1-0'


def game(**over):
    g = {
        "url": "https://www.chess.com/game/live/123",
        "uuid": "abc",
        "pgn": PGN,
        "rules": "chess",
        "end_time": 1700000000,
        "time_class": "blitz",
        "time_control": "180",
        "rated": True,
        "white": {"username": "RobboSloth", "rating": 1200, "result": "win"},
        "black": {"username": "Other", "rating": 1250, "result": "resigned"},
    }
    g.update(over)
    return g


def test_normalise_as_white_win():
    g = fetch.normalise(game(), "robbosloth")
    assert g["colour"] == "white"
    assert g["result"] == "win"
    assert g["result_detail"] == "resigned"
    assert g["opponent"] == "Other"
    assert g["eco"] == "B20"
    assert g["opening"] == "Sicilian Defense"


def test_normalise_as_black_loss_and_draw():
    as_black = game(
        white={"username": "Other", "rating": 1250, "result": "win"},
        black={"username": "robbosloth", "rating": 1200, "result": "timeout"},
    )
    assert fetch.normalise(as_black, "robbosloth")["result"] == "loss"
    assert fetch.my_result("repetition") == "draw"


def test_variants_and_missing_pgn_skipped():
    assert fetch.normalise(game(rules="chess960"), "robbosloth") is None
    assert fetch.normalise(game(pgn=None), "robbosloth") is None
    assert fetch.normalise(game(pgn='[SetUp "1"]\n' + PGN), "robbosloth") is None


def test_needs_fetch(tmp_path, monkeypatch):
    monkeypatch.setattr(fetch, "ARCHIVES", tmp_path)
    (tmp_path / "2024-01.json").write_text('{"complete": true, "games": []}')
    (tmp_path / "2024-02.json").write_text('{"complete": false, "games": []}')
    assert not fetch.needs_fetch("2024-01", "2024-05")  # cached and complete
    assert fetch.needs_fetch("2024-02", "2024-05")  # cached mid-month
    assert fetch.needs_fetch("2024-03", "2024-05")  # never cached
    assert fetch.needs_fetch("2024-05", "2024-05")  # current month


def test_opening_family():
    f = fetch.opening_family
    assert f("Caro Kann Defense Exchange Variation 3...cxd5 4.Nf3") == "Caro Kann Defense"
    assert f("Queens Pawn Opening Zukertort Chigorin Variation 3.Bf4 Nf6 4.e3") == "Queens Pawn Opening"
    assert f("Englund Gambit 2.dxe5 Nc6 3.Nf3") == "Englund Gambit"
    assert f("Old Benoni Defense 2.dxc5 e6") == "Old Benoni Defense"
    assert f("Nimzo Larsen 1.b3 e5") == "Nimzo Larsen"
    assert f("") == "Unknown"
