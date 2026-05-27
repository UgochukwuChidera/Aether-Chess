"""
backend/custom_bot.py — Mentor bot adapter implemented on top of Stockfish.
"""
from __future__ import annotations

import threading
from typing import Any, Dict, Optional, Union

import chess
import chess.engine
import random
from aether_chess.engines.mentor_engine import MentorEngine, SearchConfig


class MentorBotAdapter:
    """Mentor wrapper that plays through Stockfish with adaptive constraints."""

    def __init__(self) -> None:
        self._uci_engine: Optional[chess.engine.SimpleEngine] = None
        self._uci_path: str = "stockfish"
        self._uci_lock = threading.Lock()

    def _ensure_uci(self, stockfish_path: str) -> chess.engine.SimpleEngine:
        """Return the shared Stockfish SimpleEngine, (re)starting it if needed."""
        if self._uci_engine is not None and stockfish_path == self._uci_path:
            return self._uci_engine
        self.close()
        self._uci_engine = chess.engine.SimpleEngine.popen_uci(stockfish_path)
        self._uci_path = stockfish_path
        return self._uci_engine

    def close(self) -> None:
        """Shut down the shared Stockfish process if running."""
        if self._uci_engine is not None:
            try:
                self._uci_engine.quit()
            except Exception:
                pass
            self._uci_engine = None

    @staticmethod
    def _strength_profile(
        strength: int,
        time_remaining: Optional[float] = None,
        time_increment: Optional[float] = None,
        total_moves: Optional[int] = None,
    ) -> Dict[str, Any]:
        level = max(1, min(10, int(strength)))
        time_limit = min(0.95, 0.08 + level * 0.085)
        depth = 8 + level * 2
        skill_level = min(20, 2 + level * 2)
        if time_remaining is not None and time_remaining > 0:
            move_num = total_moves or 30
            moves_left = max(1, 40 - move_num)
            share = time_remaining / moves_left
            time_limit = max(0.08, min(time_remaining * 0.4, share * 0.6, 4.0))
            if time_increment and time_increment > 0:
                time_limit = max(0.08, min(time_limit + time_increment * 0.3, 4.0))
            if time_remaining < 10:
                time_limit = max(0.05, min(time_limit, time_remaining * 0.5))
        return {
            "time_limit": time_limit,
            "depth": depth,
            "skill_level": skill_level,
        }

    @staticmethod
    def _configure_engine(
        engine: chess.engine.SimpleEngine,
        skill_level: int,
        threads: Optional[int],
        hash_mb: Optional[int],
    ) -> None:
        options: Dict[str, int] = {"Skill Level": max(0, min(20, int(skill_level)))}
        if threads is not None:
            options["Threads"] = max(1, int(threads))
        if hash_mb is not None:
            options["Hash"] = max(16, int(hash_mb))
        try:
            engine.configure(options)
        except Exception:
            pass

    def get_move(
        self,
        fen: str,
        strength: int = 7,
        stockfish_path: str = "stockfish",
        threads: Optional[int] = None,
        hash_mb: Optional[int] = None,
        time_remaining: Optional[float] = None,
        time_increment: Optional[float] = None,
        total_moves: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Return a mentor move using Stockfish at scaled strength (1-10)."""
        board = chess.Board(fen)
        profile = self._strength_profile(
            strength,
            time_remaining=time_remaining,
            time_increment=time_increment,
            total_moves=total_moves,
        )
        # Use MentorEngine (pure Python AI) for move generation
        mentor = MentorEngine()
        # Configure search depth based on strength (similar scaling as earlier)
        level = max(1, min(10, int(strength)))
        mentor.config = SearchConfig(
            max_depth=4 + level * 2,  # 6-24 plies
            max_nodes=200_000 + level * 200_000,
            time_limit_sec=0.3 + level * 0.2,
            difficulty=min(1.0, 0.5 + level * 0.05),
            tt_max_entries=200_000 + level * 50_000,
            threads=1,
        )
        move = mentor.search(board)
        if move is None:
            # Fallback: random legal move
            move = random.choice(list(board.legal_moves))
        return {"move": move.uci(), "san": board.san(move)}

