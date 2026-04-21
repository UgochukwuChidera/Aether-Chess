from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import chess
import chess.polyglot

INF = 10**9
MATE_SCORE = 100_000

PIECE_VALUES = {
    chess.PAWN: 100,
    chess.KNIGHT: 320,
    chess.BISHOP: 330,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 0,
}

PAWN_TABLE = [
    0, 0, 0, 0, 0, 0, 0, 0,
    10, 10, 10, -20, -20, 10, 10, 10,
    5, -5, -10, 0, 0, -10, -5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, 5, 10, 25, 25, 10, 5, 5,
    10, 10, 20, 30, 30, 20, 10, 10,
    50, 50, 50, 50, 50, 50, 50, 50,
    0, 0, 0, 0, 0, 0, 0, 0,
]

KNIGHT_TABLE = [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
]

PST = {
    chess.PAWN: PAWN_TABLE,
    chess.KNIGHT: KNIGHT_TABLE,
}


@dataclass
class SearchConfig:
    max_depth: int = 4
    max_nodes: int = 200_000
    time_limit_sec: float = 1.0
    difficulty: float = 1.0


@dataclass
class TTEntry:
    depth: int
    value: int
    flag: str
    best_move: Optional[chess.Move]


class MentorEngine:
    def __init__(self, config: Optional[SearchConfig] = None):
        self.config = config or SearchConfig()
        self.tt: Dict[int, TTEntry] = {}
        self.nodes = 0
        self.start_time = 0.0

    def evaluate(self, board: chess.Board) -> int:
        if board.is_checkmate():
            return -MATE_SCORE if board.turn else MATE_SCORE
        if board.is_stalemate() or board.is_insufficient_material() or board.can_claim_draw():
            return 0

        score = 0
        for piece_type, value in PIECE_VALUES.items():
            for sq in board.pieces(piece_type, chess.WHITE):
                score += value + PST.get(piece_type, [0] * 64)[sq]
            for sq in board.pieces(piece_type, chess.BLACK):
                score -= value + PST.get(piece_type, [0] * 64)[chess.square_mirror(sq)]

        mobility = len(list(board.legal_moves))
        score += 2 * mobility if board.turn == chess.WHITE else -2 * mobility
        return score

    def _ordered_moves(self, board: chess.Board, tt_move: Optional[chess.Move]) -> List[chess.Move]:
        moves = list(board.legal_moves)

        def move_score(m: chess.Move) -> int:
            score = 0
            if tt_move and m == tt_move:
                score += 10_000
            if board.is_capture(m):
                captured_piece = board.piece_type_at(m.to_square)
                attacker_piece = board.piece_type_at(m.from_square)
                if captured_piece and attacker_piece:
                    score += 1_000 + PIECE_VALUES[captured_piece] - PIECE_VALUES[attacker_piece]
            if m.promotion:
                score += 800
            if board.gives_check(m):
                score += 120
            return score

        moves.sort(key=move_score, reverse=True)
        return moves

    def _out_of_resources(self) -> bool:
        return self.nodes >= self.config.max_nodes or (time.time() - self.start_time) >= self.config.time_limit_sec

    def _quiescence(self, board: chess.Board, alpha: int, beta: int) -> int:
        self.nodes += 1
        stand_pat = self.evaluate(board)
        if stand_pat >= beta:
            return beta
        alpha = max(alpha, stand_pat)
        for move in self._ordered_moves(board, None):
            if not board.is_capture(move):
                continue
            board.push(move)
            score = -self._quiescence(board, -beta, -alpha)
            board.pop()
            if score >= beta:
                return beta
            alpha = max(alpha, score)
        return alpha

    def _search(self, board: chess.Board, depth: int, alpha: int, beta: int, allow_null: bool = True) -> int:
        self.nodes += 1
        if self._out_of_resources():
            return self.evaluate(board)

        key = chess.polyglot.zobrist_hash(board)
        entry = self.tt.get(key)
        if entry and entry.depth >= depth:
            if entry.flag == "EXACT":
                return entry.value
            if entry.flag == "LOWER":
                alpha = max(alpha, entry.value)
            elif entry.flag == "UPPER":
                beta = min(beta, entry.value)
            if alpha >= beta:
                return entry.value

        if depth <= 0:
            return self._quiescence(board, alpha, beta)
        if board.is_game_over():
            return self.evaluate(board)

        if allow_null and depth >= 3 and not board.is_check():
            board.push(chess.Move.null())
            score = -self._search(board, depth - 3, -beta, -beta + 1, allow_null=False)
            board.pop()
            if score >= beta:
                return beta

        original_alpha = alpha
        best_move = None
        best_score = -INF
        tt_move = entry.best_move if entry else None
        moves = self._ordered_moves(board, tt_move)

        if depth == 1 and not board.is_check():
            static_eval = self.evaluate(board)
            if static_eval + 150 <= alpha:
                return static_eval

        for i, move in enumerate(moves):
            board.push(move)
            reduction = 0
            if i > 3 and depth >= 3 and not board.is_capture(move) and not board.gives_check(move):
                reduction = 1

            if i == 0:
                score = -self._search(board, depth - 1, -beta, -alpha)
            else:
                score = -self._search(board, depth - 1 - reduction, -alpha - 1, -alpha)
                if alpha < score < beta:
                    score = -self._search(board, depth - 1, -beta, -alpha)
            board.pop()

            if score > best_score:
                best_score = score
                best_move = move
            alpha = max(alpha, score)
            if alpha >= beta:
                break

        flag = "EXACT"
        if best_score <= original_alpha:
            flag = "UPPER"
        elif best_score >= beta:
            flag = "LOWER"
        self.tt[key] = TTEntry(depth=depth, value=best_score, flag=flag, best_move=best_move)
        return best_score

    def search(self, board: chess.Board) -> chess.Move:
        self.nodes = 0
        self.start_time = time.time()
        best_move = None
        candidates: List[Tuple[chess.Move, int]] = []

        for depth in range(1, self.config.max_depth + 1):
            if self._out_of_resources():
                break
            alpha, beta = -INF, INF
            local_best = None
            local_best_score = -INF
            for move in self._ordered_moves(board, None):
                board.push(move)
                score = -self._search(board, depth - 1, -beta, -alpha)
                board.pop()
                if score > local_best_score:
                    local_best_score = score
                    local_best = move
                alpha = max(alpha, score)
            if local_best is not None:
                best_move = local_best
                candidates.append((local_best, local_best_score))

        if best_move is None:
            legal = list(board.legal_moves)
            if not legal:
                raise RuntimeError("No legal moves")
            return legal[0]

        if self.config.difficulty < 0.999 and candidates:
            top = sorted(candidates, key=lambda x: x[1], reverse=True)[: max(2, int(6 * (1 - self.config.difficulty)))]
            temperature = max(0.05, 1.2 - self.config.difficulty)
            vals = [s for _, s in top]
            max_v = max(vals)
            weights = [math.exp((v - max_v) / (70 * temperature)) for v in vals]
            total = sum(weights)
            pick = random.random() * total
            cur = 0.0
            for (mv, _), w in zip(top, weights):
                cur += w
                if cur >= pick:
                    return mv
        return best_move
