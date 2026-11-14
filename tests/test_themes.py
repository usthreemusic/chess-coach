import sys
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import themes


def tags(fen, played, best, **context):
    return themes.tag_mistake(chess.Board(fen), chess.Move.from_uci(played),
                              chess.Move.from_uci(best), context)


def test_missed_mate():
    # White to move can mate with Qg7; plays Qf1 instead. Previous ply said mate for White.
    fen = "7k/8/5K2/8/8/8/8/6Q1 w - - 0 5"
    result = tags(fen, "g1f1", "g1g7", prev_mate=1)
    assert "missed_mate" in result
    assert "back_rank" not in result  # Qg7 is not on the home rank
    # a mate for the other side (negative = Black) is not mine to miss
    assert "missed_mate" not in tags(fen, "g1f1", "g1g7", prev_mate=-1)
    # playing the best move is not a miss
    assert "missed_mate" not in tags(fen, "g1g7", "g1g7", prev_mate=1)


def test_missed_capture():
    # Qxd5+ wins the undefended queen; White played Kf1 instead.
    result = tags("4k3/8/8/3q4/8/8/8/3QK3 w - - 0 30", "e1f1", "d1d5")
    assert result == ["missed_capture"]
    # a defended pawn taken by a queen is not a won piece
    assert "missed_capture" not in tags("4k3/3p4/2p5/8/8/8/8/3QK3 w - - 0 30", "e1f1", "d1d7")


def test_missed_fork():
    # Nc7+ forks the king on e8 and the undefended rook on a8.
    result = tags("r3k3/8/8/1N6/8/8/8/4K3 w - - 0 5", "e1d2", "b5c7")
    assert result == ["missed_fork"]
    # the same knight move forking nothing is not tagged
    assert "missed_fork" not in tags("4k3/8/8/1N6/8/8/8/4K3 w - - 0 5", "e1d2", "b5c7")


def test_hung_piece():
    # Qd5 walks into ...exd5, the opponent's best reply.
    result = tags("4k3/8/4p3/8/8/8/8/3QK3 w - - 0 30", "d1d5", "e1f1", reply=chess.Move.from_uci("e6d5"))
    assert "hung_piece" in result
    # a reply that is not a capture does not count
    assert "hung_piece" not in tags("4k3/8/4p3/8/8/8/8/3QK3 w - - 0 30", "d1d5", "e1f1",
                                    reply=chess.Move.from_uci("e8d8"))


def test_back_rank_missed_mate():
    result = tags("6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 20", "e1d2", "a1a8", prev_mate=1, pv=["Ra8#"])
    assert "back_rank" in result and "missed_mate" in result


def test_back_rank_suffered():
    fen = "r5k1/8/8/8/N7/8/5PPP/6K1 w - - 0 20"
    reply = chess.Move.from_uci("a8a1")
    result = tags(fen, "a4b6", "h2h3", reply=reply, mate_after=-1)
    assert "back_rank" in result
    # without a forced mate for them it is not tagged
    assert "back_rank" not in tags(fen, "a4b6", "h2h3", reply=reply, mate_after=None)


def test_endgame_and_other():
    assert tags("4k3/8/8/8/8/8/4P3/4K3 w - - 0 40", "e1d2", "e2e4") == ["endgame"]
    # the opening is never an endgame, and no rule fires: other
    assert tags("4k3/8/8/8/8/8/4P3/4K3 w - - 0 5", "e1d2", "e2e4") == ["other"]


def test_even_trade_is_not_a_hung_piece():
    # Bishop takes knight on c6, pawn takes back: a trade, not a hung piece.
    board = chess.Board("r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 3")
    played = chess.Move.from_uci("b5c6")
    reply = chess.Move.from_uci("d7c6")
    tags = themes.tag_mistake(board, played, chess.Move.from_uci("e1g1"), {"reply": reply})
    assert "hung_piece" not in tags
