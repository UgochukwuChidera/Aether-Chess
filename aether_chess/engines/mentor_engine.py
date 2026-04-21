from __future__ import annotations

import math
import random
import time
import threading
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
    chess.QUEEN: 950,
    chess.KING: 20000,
}

# Piece‑square tables (midgame)
PAWN_TABLE = [
    0,  0,  0,  0,  0,  0,  0,  0,
    5, 10, 10,-20,-20, 10, 10,  5,
    2,  4,  8, 12, 12,  8,  4,  2,
    0,  2,  6, 10, 10,  6,  2,  0,
    0,  0,  4,  8,  8,  4,  0,  0,
    2,  2,  2,  4,  4,  2,  2,  2,
    5,  5,  5,  5,  5,  5,  5,  5,
    0,  0,  0,  0,  0,  0,  0,  0,
]
KNIGHT_TABLE = [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
]
BISHOP_TABLE = [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10,  0, 10, 15, 15, 10,  0,-10,
    -10,  5, 10, 15, 15, 10,  5,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
]
ROOK_TABLE = [
    0,  0,  0,  5,  5,  0,  0,  0,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
    5, 10, 10, 10, 10, 10, 10,  5,
    0,  0,  0,  0,  0,  0,  0,  0,
]
QUEEN_TABLE = [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  5,  5,  5,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
     -5,  5, 10, 10, 10, 10,  5, -5,
      0,  5, 10, 10, 10, 10,  5, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
]
KING_MID_TABLE = [
    20, 30, 10,  0,  0, 10, 30, 20,
    20, 20,  0,  0,  0,  0, 20, 20,
   -10,-20,-20,-20,-20,-20,-20,-10,
   -20,-30,-30,-40,-40,-30,-30,-20,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
]
KING_END_TABLE = [
    -50,-30,-30,-30,-30,-30,-30,-50,
    -30,-20,  0,  5,  5,  0,-20,-30,
    -30,  5, 20, 30, 30, 20,  5,-30,
    -30,  5, 30, 40, 40, 30,  5,-30,
    -30,  5, 30, 40, 40, 30,  5,-30,
    -30,  5, 20, 30, 30, 20,  5,-30,
    -30,-20,  0,  0,  0,  0,-20,-30,
    -50,-30,-30,-30,-30,-30,-30,-50,
]

PST = {
    chess.PAWN: PAWN_TABLE,
    chess.KNIGHT: KNIGHT_TABLE,
    chess.BISHOP: BISHOP_TABLE,
    chess.ROOK: ROOK_TABLE,
    chess.QUEEN: QUEEN_TABLE,
}


@dataclass
class SearchConfig:
    max_depth: int = 6
    max_nodes: int = 10_000_000        # added to match controller
    time_limit_sec: float = 1.0
    difficulty: float = 1.0
    tt_max_entries: int = 2_000_000
    threads: int = 1                   # keep 1 to avoid threading issues


class TTEntry:
    __slots__ = ("depth", "value", "flag", "best_move")
    def __init__(self, depth: int, value: int, flag: str, best_move: Optional[chess.Move]):
        self.depth = depth
        self.value = value
        self.flag = flag
        self.best_move = best_move


class MentorEngine:
    def __init__(self, config: Optional[SearchConfig] = None):
        self.config = config or SearchConfig()
        self.tt: Dict[int, TTEntry] = {}
        self.tt_lock = threading.Lock()
        self.nodes = 0
        self.nodes_lock = threading.Lock()
        self.start_time = 0.0
        self.killers: Dict[int, List[Optional[chess.Move]]] = {}
        self.history: Dict[Tuple[bool, int, int], int] = {}
        self.stop_flag = False

    # ------------------------ Evaluation ------------------------
    def _phase(self, board: chess.Board) -> int:
        total = 0
        for pt in [chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT, chess.PAWN]:
            total += len(board.pieces(pt, chess.WHITE)) + len(board.pieces(pt, chess.BLACK))
        phase = max(0, min(256, 256 - total * 16))
        return phase

    def evaluate(self, board: chess.Board) -> int:
        if board.is_checkmate():
            return -MATE_SCORE + (board.ply() if board.turn else -board.ply())
        if board.is_stalemate() or board.is_insufficient_material():
            return 0

        mg_score = 0
        eg_score = 0

        for piece_type, val in PIECE_VALUES.items():
            pst = PST.get(piece_type, [0]*64)
            for sq in board.pieces(piece_type, chess.WHITE):
                mg_score += val + pst[sq]
                eg_score += val + KING_END_TABLE[sq]   # rough endgame pst
            for sq in board.pieces(piece_type, chess.BLACK):
                mg_score -= val + pst[chess.square_mirror(sq)]
                eg_score -= val + KING_END_TABLE[chess.square_mirror(sq)]

        wk = board.king(chess.WHITE)
        bk = board.king(chess.BLACK)
        if wk:
            mg_score += KING_MID_TABLE[wk]
            eg_score += KING_END_TABLE[wk]
        if bk:
            mg_score -= KING_MID_TABLE[bk]
            eg_score -= KING_END_TABLE[bk]

        phase = self._phase(board)
        score = (mg_score * (256 - phase) + eg_score * phase) // 256

        # Pawn structure
        for color in (chess.WHITE, chess.BLACK):
            pawns = board.pieces(chess.PAWN, color)
            files = [chess.square_file(p) for p in pawns]
            for sq in pawns:
                f = chess.square_file(sq)
                if (f-1 not in files) and (f+1 not in files):
                    if color == chess.WHITE:
                        score -= 15
                    else:
                        score += 15
                if files.count(f) > 1:
                    if color == chess.WHITE:
                        score -= 10
                    else:
                        score += 10

        if len(board.pieces(chess.BISHOP, chess.WHITE)) >= 2:
            score += 50
        if len(board.pieces(chess.BISHOP, chess.BLACK)) >= 2:
            score -= 50

        return score

    # ------------------------ Move Ordering ------------------------
    def see(self, board: chess.Board, move: chess.Move) -> int:
        if not board.is_capture(move):
            return 0
        from_piece = board.piece_type_at(move.from_square)
        to_piece = board.piece_type_at(move.to_square)
        if from_piece is None or to_piece is None:
            return 0
        gain = PIECE_VALUES[to_piece] - PIECE_VALUES[from_piece]
        return max(0, gain)

    def _move_score(self, board: chess.Board, move: chess.Move, tt_move: Optional[chess.Move], ply: int) -> int:
        score = 0
        if tt_move and move == tt_move:
            score += 20000
        if board.is_capture(move):
            victim = board.piece_type_at(move.to_square)
            attacker = board.piece_type_at(move.from_square)
            if victim and attacker:
                score += 10000 + PIECE_VALUES[victim] - PIECE_VALUES[attacker]
            score += self.see(board, move) * 5
        if move.promotion:
            score += 5000
        if board.gives_check(move):
            score += 300
        killers = self.killers.get(ply, [None, None])
        if killers[0] == move:
            score += 1000
        elif killers[1] == move:
            score += 500
        score += self.history.get((board.turn, move.from_square, move.to_square), 0)
        return score

    def _ordered_moves(self, board: chess.Board, tt_move: Optional[chess.Move], ply: int) -> List[chess.Move]:
        moves = list(board.legal_moves)
        moves.sort(key=lambda m: self._move_score(board, m, tt_move, ply), reverse=True)
        return moves

    # ------------------------ TT Helpers ------------------------
    def _store_tt(self, key: int, depth: int, value: int, flag: str, move: Optional[chess.Move]):
        with self.tt_lock:
            if len(self.tt) >= self.config.tt_max_entries:
                min_key = min(self.tt.items(), key=lambda kv: kv[1].depth)[0]
                del self.tt[min_key]
            self.tt[key] = TTEntry(depth, value, flag, move)

    def _probe_tt(self, key: int, depth: int, alpha: int, beta: int) -> Tuple[Optional[int], Optional[chess.Move]]:
        entry = self.tt.get(key)
        if entry and entry.depth >= depth:
            if entry.flag == "EXACT":
                return entry.value, entry.best_move
            if entry.flag == "LOWER" and entry.value >= beta:
                return entry.value, entry.best_move
            if entry.flag == "UPPER" and entry.value <= alpha:
                return entry.value, entry.best_move
        return None, None

    # ------------------------ Search ------------------------
    def _out_of_resources(self) -> bool:
        if self.stop_flag:
            return True
        if (time.time() - self.start_time) >= self.config.time_limit_sec:
            return True
        with self.nodes_lock:
            if self.nodes >= self.config.max_nodes:
                return True
        return False

    def _inc_nodes(self):
        with self.nodes_lock:
            self.nodes += 1

    def _quiescence(self, board: chess.Board, alpha: int, beta: int, depth: int = 0) -> int:
        self._inc_nodes()
        if self._out_of_resources():
            return self.evaluate(board)

        stand_pat = self.evaluate(board)
        if stand_pat >= beta:
            return beta
        alpha = max(alpha, stand_pat)

        for move in board.legal_moves:
            if not board.is_capture(move) and not move.promotion:
                continue
            if depth >= 3 and stand_pat + 300 < alpha:
                break
            board.push(move)
            score = -self._quiescence(board, -beta, -alpha, depth + 1)
            board.pop()
            if score >= beta:
                return beta
            alpha = max(alpha, score)
        return alpha

    def _search(self, board: chess.Board, depth: int, alpha: int, beta: int,
                ply: int = 0, allow_null: bool = True) -> int:
        self._inc_nodes()
        if self._out_of_resources():
            return self.evaluate(board)

        if board.is_repetition(3) or board.is_fifty_moves() or board.is_stalemate():
            return 0
        if board.is_game_over():
            return self.evaluate(board)

        key = chess.polyglot.zobrist_hash(board)
        tt_val, tt_move = self._probe_tt(key, depth, alpha, beta)
        if tt_val is not None:
            return tt_val

        if allow_null and depth >= 3 and not board.is_check():
            R = 2 + depth // 4
            board.push(chess.Move.null())
            score = -self._search(board, depth - R, -beta, -beta + 1, ply + 1, False)
            board.pop()
            if score >= beta:
                return beta

        if depth <= 2 and not board.is_check():
            static = self.evaluate(board)
            margin = 100 * depth
            if static + margin <= alpha:
                return static

        original_alpha = alpha
        best_move = None
        best_score = -INF
        moves = self._ordered_moves(board, tt_move, ply)

        for i, move in enumerate(moves):
            is_capture = board.is_capture(move)
            gives_check = board.gives_check(move)
            board.push(move)

            reduction = 0
            if depth >= 3 and i >= 4 and not is_capture and not gives_check:
                reduction = 1 + (i // 8)
                reduction = min(reduction, depth - 1)

            if i == 0:
                score = -self._search(board, depth - 1, -beta, -alpha, ply + 1)
            else:
                score = -self._search(board, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1)
                if score > alpha and reduction != 0:
                    score = -self._search(board, depth - 1, -beta, -alpha, ply + 1)
                elif score > alpha and score < beta:
                    score = -self._search(board, depth - 1, -beta, -alpha, ply + 1)
            board.pop()

            if score > best_score:
                best_score = score
                best_move = move
            alpha = max(alpha, score)
            if alpha >= beta:
                if not is_capture:
                    killers = self.killers.get(ply, [None, None])
                    if move != killers[0]:
                        self.killers[ply] = [move, killers[0]]
                    self.history[(board.turn, move.from_square, move.to_square)] = (
                        self.history.get((board.turn, move.from_square, move.to_square), 0) + depth * depth
                    )
                break

        if abs(best_score) > MATE_SCORE - 100:
            if best_score > 0:
                best_score -= ply
            else:
                best_score += ply

        flag = "EXACT"
        if best_score <= original_alpha:
            flag = "UPPER"
        elif best_score >= beta:
            flag = "LOWER"
        self._store_tt(key, depth, best_score, flag, best_move)
        return best_score

    # ------------------------ Main Search (single thread) ------------------------
    def search(self, board: chess.Board) -> chess.Move:
        self.stop_flag = False
        self.start_time = time.time()
        self.nodes = 0
        self.killers.clear()
        self.history.clear()
        self.tt.clear()

        best_move = None
        best_score = -INF
        candidates = []

        for depth in range(1, self.config.max_depth + 1):
            if self._out_of_resources():
                break
            window = 50
            alpha = best_score - window if depth > 1 else -INF
            beta = best_score + window if depth > 1 else INF
            while True:
                local_best = None
                local_best_score = -INF
                moves = self._ordered_moves(board, None, 0)
                for move in moves:
                    board.push(move)
                    score = -self._search(board, depth - 1, -beta, -alpha, 1)
                    board.pop()
                    if score > local_best_score:
                        local_best_score = score
                        local_best = move
                    alpha = max(alpha, score)
                    if alpha >= beta:
                        break
                if local_best_score <= alpha and depth > 1:
                    alpha = max(-INF, alpha - window)
                    window *= 2
                elif local_best_score >= beta and depth > 1:
                    beta = min(INF, beta + window)
                    window *= 2
                else:
                    break
            if local_best is not None:
                best_move = local_best
                best_score = local_best_score
                candidates.append((local_best, local_best_score))

        if best_move is None:
            legal = list(board.legal_moves)
            if not legal:
                raise RuntimeError("No legal moves")
            return random.choice(legal)

        # Difficulty adjustment
        if self.config.difficulty < 0.999 and candidates:
            top_n = max(2, int(6 * (1 - self.config.difficulty)))
            top = sorted(candidates, key=lambda x: x[1], reverse=True)[:top_n]
            temperature = max(0.1, 1.5 - self.config.difficulty)
            vals = [s for _, s in top]
            max_v = max(vals)
            weights = [math.exp((v - max_v) / (70 * temperature)) for v in vals]
            total = sum(weights)
            r = random.random() * total
            cur = 0.0
            for (mv, _), w in zip(top, weights):
                cur += w
                if cur >= r:
                    return mv
        return best_move