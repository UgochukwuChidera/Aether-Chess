from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

import chess
import chess.syzygy


@dataclass
class TablebaseProbe:
    path: Optional[str] = None
    # P4-T01 Change 1: the opener is injected (defaulting to the real one)
    # so tests drive a stub tablebase -- no data files, no monkeypatching.
    opener: Callable[..., Any] = chess.syzygy.open_tablebase

    def best_move(self, board: chess.Board) -> Optional[chess.Move]:
        if not self.path:
            return None
        if board.occupied.bit_count() > 6:
            return None
        try:
            with self.opener(self.path) as tb:
                return self._select(board, tb)
        except (KeyError, OSError):
            # MissingTableError subclasses KeyError and FileNotFoundError
            # subclasses OSError: no tables (or no directory) means no
            # probe, never a traceback -- detect-and-report upstream.
            return None

    def _select(self, board: chess.Board, tb: Any) -> Optional[chess.Move]:
        # P4-T01 Change 2: forced mate first, then WDL class, DTZ only as
        # a distance tiebreak. Raw-DTZ minmax is a documented anti-pattern
        # (python-chess): "Minmaxing the DTZ50'' values guarantees winning
        # a won position (and drawing a drawn position), because it makes
        # progress keeping the win in hand. However, the lines are not
        # always the most straightforward ways to win. Engines like
        # Stockfish calculate themselves, checking with DTZ, but only play
        # according to DTZ if they can not manage on their own."
        best: Optional[chess.Move] = None
        best_key: Optional[tuple[int, int]] = None
        for move in board.legal_moves:
            board.push(move)
            mated = board.is_checkmate()
            if mated:
                board.pop()
                return move
            try:
                wdl = tb.probe_wdl(board)
                dtz = tb.probe_dtz(board)
            except (KeyError, OSError):
                wdl, dtz = None, None
            board.pop()
            # P4-T01 Change 3: skip unknown positions instead of comparing
            # None against int (TypeError past the first iteration).
            if wdl is None or dtz is None:
                continue
            # probe_* report the side to move, which is the OPPONENT after
            # the push ("positive if the side to move is winning"). Negate
            # once to the mover's perspective, then rank with no colour
            # branch at all: wins outrank draws outrank losses, and within
            # a class the fastest win (smallest distance) -- but the most
            # delayed loss (largest distance) -- is preferred.
            mover_wdl = -wdl
            dist = abs(dtz)
            key = (mover_wdl, -dist if mover_wdl >= 0 else dist)
            if best_key is None or key > best_key:
                best, best_key = move, key
        return best
