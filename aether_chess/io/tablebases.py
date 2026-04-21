from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import chess
import chess.syzygy


@dataclass
class TablebaseProbe:
    path: Optional[str] = None

    def best_move(self, board: chess.Board) -> Optional[chess.Move]:
        if not self.path:
            return None
        try:
            with chess.syzygy.open_tablebase(self.path) as tb:
                if board.occupied.bit_count() > 6:
                    return None
                best = None
                best_dtz = None
                side_to_move = board.turn
                for move in board.legal_moves:
                    board.push(move)
                    dtz = tb.probe_dtz(board)
                    board.pop()
                    if best_dtz is None:
                        best, best_dtz = move, dtz
                        continue
                    if side_to_move == chess.WHITE and dtz < best_dtz:
                        best, best_dtz = move, dtz
                    if side_to_move == chess.BLACK and dtz > best_dtz:
                        best, best_dtz = move, dtz
                return best
        except (FileNotFoundError, OSError, chess.syzygy.MissingTableError):
            return None
