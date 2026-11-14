"""Chess helpers shared by stats.py and themes.py."""

import chess

VALUES = {chess.QUEEN: 9, chess.ROOK: 5, chess.BISHOP: 3, chess.KNIGHT: 3}
OPENING_MOVES = 12  # my full-move numbers below this are the opening
ENDGAME_MATERIAL = 13  # non-pawn material of both sides together


def material(board):
    """Queens, rooks, bishops and knights of both sides, in points."""
    return sum(len(board.pieces(pt, colour)) * v
               for pt, v in VALUES.items() for colour in (chess.WHITE, chess.BLACK))


def phase_of(board):
    """Phase of the position before my move (board.fullmove_number is that move's number)."""
    if board.fullmove_number < OPENING_MOVES:
        return "opening"
    return "endgame" if material(board) <= ENDGAME_MATERIAL else "middlegame"
