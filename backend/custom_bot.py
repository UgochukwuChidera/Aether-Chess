"""
backend/custom_bot.py — Adapts the existing MentorEngine PVS bot for use as a
service command handler.
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, Optional

import chess

_HERE = os.path.dirname(__file__)
_ROOT = os.path.join(_HERE, "..")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from aether_chess.engines.mentor_engine import MentorEngine, SearchConfig


def _config_for_strength(strength: int) -> SearchConfig:
    level = min(10, max(1, strength))
    return SearchConfig(
        max_depth=2 + level // 2,
        max_nodes=30_000 + level * 35_000,
        time_limit_sec=0.15 + level * 0.18,
        difficulty=min(1.0, 0.35 + level * 0.07),
        tt_max_entries=50_000 + level * 15_000,
    )


class MentorBotAdapter:
    """Thin wrapper exposing the PVS mentor engine as a service call."""

    def __init__(self) -> None:
        self._engine = MentorEngine()
        self._last_strength: int = 7

    def get_move(self, fen: str, strength: int = 7) -> Dict[str, Any]:
        """Return the best move for *fen* at the given difficulty *strength* (1–10)."""
        if strength != self._last_strength:
            self._engine.config = _config_for_strength(strength)
            self._last_strength = strength

        board = chess.Board(fen)
        move: Optional[chess.Move] = self._engine.search(board)
        if move is None:
            return {"move": None, "san": None}
        return {
            "move": move.uci(),
            "san": board.san(move),
        }
