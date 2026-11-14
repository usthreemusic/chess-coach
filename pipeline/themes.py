"""Tag my mistakes by type, using simple rules and no engine.

tag_mistake() takes the position before my move, the move I played, the
engine's best move, and a context dict:

  prev_mate  signed mate of the position before my move (White's perspective,
             the previous ply's "mate"), or None
  mate_after signed mate of the position after my move (this ply's "mate"), or None
  reply      the opponent's best reply to my move (chess.Move), or None
  pv         SAN moves of the best line, starting with the best move

Tags: missed_mate, missed_capture, missed_fork, hung_piece, back_rank, endgame;
a mistake with none of them is tagged "other".
"""

import chess

from chessutil import phase_of

KEPT = ("mistake", "blunder")
TAGS = ("missed_mate", "missed_capture", "missed_fork", "hung_piece", "back_rank", "endgame")
OTHER = "other"
POINTS = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}


def captured_value(board, move):
    """Points of the piece that move captures, or 0 if it is not a capture."""
    if not board.is_capture(move):
        return 0
    return 1 if board.is_en_passant(move) else POINTS[board.piece_type_at(move.to_square)]


def wins_material(board, move):
    """True if move is a capture of a piece worth more than the capturer, or
    one the capturer cannot be recaptured after (the captured piece is not defended)."""
    if not board.is_capture(move):
        return False
    if board.is_en_passant(move):
        victim = 1
    else:
        victim = POINTS[board.piece_type_at(move.to_square)]
    attacker = POINTS[board.piece_type_at(move.from_square)]
    if victim > attacker:
        return True
    after = board.copy()
    after.push(move)
    return not after.is_attacked_by(board.turn ^ 1, move.to_square)


def forks(board, move):
    """True if, after move, the moved piece attacks two or more enemy pieces that
    are not pawns and are each the king, undefended, or worth more than the moved piece."""
    after = board.copy()
    after.push(move)
    piece = after.piece_at(move.to_square)
    if piece is None or piece.piece_type == chess.KING:
        return False
    enemy = not piece.color
    count = 0
    for sq in after.attacks(move.to_square):
        target = after.piece_at(sq)
        if target is None or target.color != enemy or target.piece_type == chess.PAWN:
            continue  # attacking a pawn is not what makes a fork
        if (target.piece_type == chess.KING or POINTS[target.piece_type] > POINTS[piece.piece_type]
                or not after.is_attacked_by(enemy, sq)):
            count += 1
    return count >= 2


def _home_rank(colour):
    return 0 if colour == chess.WHITE else 7


def _back_rank_mate(board, move):
    """True if move is a rook or queen mating a king that is still on its home rank."""
    piece = board.piece_type_at(move.from_square)
    if piece not in (chess.ROOK, chess.QUEEN):
        return False
    enemy = not board.turn
    king = board.king(enemy)
    if chess.square_rank(king) != _home_rank(enemy) or chess.square_rank(move.to_square) != _home_rank(enemy):
        return False
    after = board.copy()
    after.push(move)
    return after.is_checkmate()


def _my_moves_in_line(board, best_move, pv):
    """(board, move) for each of my moves in the best line: the best move, then every second one."""
    line = [(board.copy(), best_move)]
    cur = board.copy()
    cur.push(best_move)
    for i, san in enumerate(pv[1:], start=1):
        try:
            move = cur.parse_san(san)
        except ValueError:
            break
        if i % 2 == 0:
            line.append((cur.copy(), move))
        cur.push(move)
    return line


def _mate_is_mine(mate, colour):
    return bool(mate) and (mate > 0) == (colour == chess.WHITE)


def tag_mistake(board_before, played_move, best_move, context):
    me = board_before.turn
    ctx = context or {}
    tags = []
    missed_mate = _mate_is_mine(ctx.get("prev_mate"), me) and played_move != best_move
    if missed_mate:
        tags.append("missed_mate")
    if best_move is not None and wins_material(board_before, best_move):
        tags.append("missed_capture")
    elif best_move is not None and forks(board_before, best_move):
        tags.append("missed_fork")

    after = board_before.copy()
    after.push(played_move)
    reply = ctx.get("reply")
    # An even trade (I take, they take back the same value) is not a hung piece.
    if (reply is not None and reply in after.legal_moves and wins_material(after, reply)
            and captured_value(after, reply) > captured_value(board_before, played_move)):
        tags.append("hung_piece")

    back_rank = False
    if missed_mate and best_move is not None:
        back_rank = any(_back_rank_mate(b, m) for b, m in _my_moves_in_line(board_before, best_move, ctx.get("pv") or [best_move.uci()]))
    if not back_rank and reply is not None and reply in after.legal_moves and _mate_is_mine(ctx.get("mate_after"), not me):
        king = after.king(me)
        piece = after.piece_type_at(reply.from_square)
        if (piece in (chess.ROOK, chess.QUEEN) and chess.square_rank(king) == _home_rank(me)
                and chess.square_rank(reply.to_square) == _home_rank(me)):
            check = after.copy()
            check.push(reply)
            back_rank = check.is_check()
    if back_rank:
        tags.append("back_rank")

    if phase_of(board_before) == "endgame":
        tags.append("endgame")
    return tags or [OTHER]


def tags_for_move(board_before, moves, k, mine_is_white):
    """Tags for my move moves[k] (analysis dicts), from the position before it."""
    move = moves[k]
    if not move.get("best_uci"):
        return [OTHER]
    nxt = moves[k + 1] if k + 1 < len(moves) else None
    reply = None
    if nxt:
        reply = chess.Move.from_uci(nxt.get("best_uci") or nxt["uci"])
    ctx = {
        "prev_mate": moves[k - 1].get("mate") if k > 0 else None,
        "mate_after": move.get("mate"),
        "reply": reply,
        "pv": move.get("pv") or [],
    }
    return tag_mistake(board_before, chess.Move.from_uci(move["uci"]),
                       chess.Move.from_uci(move["best_uci"]), ctx)
