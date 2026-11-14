import sys
from collections import defaultdict
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import stats


def test_phase_opening_middlegame_endgame():
    board = chess.Board()
    assert stats.phase_of(board) == "opening"
    board.fullmove_number = 11
    assert stats.phase_of(board) == "opening"
    board.fullmove_number = 12
    assert stats.phase_of(board) == "middlegame"
    # R+R vs R+R = 20 > 13; R+R+N = 13
    assert stats.phase_of(chess.Board("r3k2r/8/8/8/8/8/8/R3K2R w - - 0 30")) == "middlegame"
    assert stats.phase_of(chess.Board("r3k3/8/8/8/8/8/8/R3K1N1 w - - 0 30")) == "endgame"
    # the opening wins over low material
    assert stats.phase_of(chess.Board("4k3/8/8/8/8/8/8/4K3 w - - 0 5")) == "opening"


def test_base_seconds():
    assert stats.base_seconds("600") == 600
    assert stats.base_seconds("180+2") == 180
    assert stats.base_seconds("1/86400") is None
    assert stats.base_seconds(None) is None


GAME = {"id": "g", "colour": "white", "end_time": 1700000000, "time_class": "blitz",
        "time_control": "600", "opening": "Italian Game"}


def analysis(*moves):
    return {"moves": list(moves)}


def test_time_pressure_split():
    a = analysis({"uci": "e2e4", "clk": 59.9}, {"uci": "e7e5", "clk": 10},
                 {"uci": "g1f3", "clk": 60}, {"uci": "b8c6", "clk": 5},
                 {"uci": "f1c4"})  # no clk: excluded
    recs = stats.game_records(GAME, a)
    assert [r["time_pressure"] for r in recs] == [stats.PRESSURE_LOW, stats.PRESSURE_OK, None]


def test_daily_excluded_from_time_pressure():
    game = {**GAME, "time_class": "daily", "time_control": "1/86400"}
    recs = stats.game_records(game, analysis({"uci": "e2e4", "clk": 1}))
    assert recs[0]["time_pressure"] is None
    assert recs[0]["time_class"] == "daily"


def test_only_my_moves_counted():
    a = analysis({"uci": "e2e4", "class": "blunder"}, {"uci": "e7e5", "class": "mistake"},
                 {"uci": "g1f3", "class": "inaccuracy"}, {"uci": "b8c6"})
    recs = stats.game_records(GAME, a)
    assert [r["class"] for r in recs] == ["blunder", "inaccuracy"]
    assert [r["piece"] for r in recs] == ["pawn", "knight"]
    black = stats.game_records({**GAME, "colour": "black"}, a)
    assert [r["class"] for r in black] == ["mistake", None]
    assert stats.game_records(GAME, a)[0]["month"] == "2023-11"


def test_castling_counts_as_king_and_buckets():
    a = analysis({"uci": "e2e4"}, {"uci": "e7e5"}, {"uci": "g1f3"}, {"uci": "b8c6"},
                 {"uci": "f1c4"}, {"uci": "g8f6"}, {"uci": "e1g1", "class": "mistake"})
    recs = stats.game_records(GAME, a)
    assert recs[-1]["piece"] == "king"
    buckets = {d: {} for d in stats.DIMENSIONS}
    stats.add_game(buckets, "g", recs)
    stats.add_game(buckets, "h", recs[:1])
    rows = {b["key"]: b for b in stats.finish(buckets)["piece"]}
    assert rows["pawn"]["moves"] == 2 and rows["pawn"]["games"] == 2
    assert rows["king"] == {"key": "king", "games": 1, "moves": 1,
                            "inaccuracy": 0, "mistake": 1, "blunder": 0}
