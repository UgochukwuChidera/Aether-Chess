from __future__ import annotations

from dataclasses import replace
from typing import Optional

import chess
import chess.engine

from aether_chess.engines.mentor_engine import MentorEngine, SearchConfig
from aether_chess.engines.uci_engine import UCIConfig, UCIEngineManager
from aether_chess.io.opening_book import OpeningBook
from aether_chess.models.settings import EngineType, GameSettings, OpeningStrategy


class EngineController:
    def __init__(self, settings: Optional[GameSettings] = None):
        self.settings = settings or GameSettings()
        self.mentor_engine = MentorEngine()
        self.uci_manager: Optional[UCIEngineManager] = None
        self.status = "Mentor engine ready"
        self.last_error = ""
        self._apply_strength()

    def _mentor_config_for_strength(self, strength: int) -> SearchConfig:
        level = min(10, max(1, strength))
        return SearchConfig(
            max_depth=2 + level // 2,
            max_nodes=30_000 + level * 35_000,
            time_limit_sec=0.15 + level * 0.18,
            difficulty=min(1.0, 0.35 + level * 0.07),
            tt_max_entries=50_000 + level * 15_000,
        )

    def _uci_config_for_strength(self, strength: int) -> UCIConfig:
        level = min(10, max(1, strength))
        skill = min(20, max(0, int(round(level * 2))))
        return UCIConfig(
            path=self.settings.uci_path,
            skill_level=skill,
            move_overhead=30,
            threads=self.settings.uci_threads,
            multipv=1,
        )

    def _apply_strength(self) -> None:
        self.mentor_engine.config = self._mentor_config_for_strength(self.settings.ai_strength)
        if self.uci_manager and self.uci_manager.engine:
            try:
                self.uci_manager.engine.configure(
                    {
                        "Skill Level": self._uci_config_for_strength(self.settings.ai_strength).skill_level,
                        "Threads": self.settings.uci_threads,
                    }
                )
            except Exception:
                self.last_error = "Failed to reconfigure UCI engine"

    def apply_settings(self, settings: GameSettings) -> None:
        self.settings = replace(settings)
        self._apply_strength()
        if self.settings.engine_type == EngineType.UCI:
            self.ensure_uci_ready()

    def ensure_uci_ready(self) -> bool:
        if self.uci_manager and self.uci_manager.engine:
            return True
        self.stop_uci()
        cfg = self._uci_config_for_strength(self.settings.ai_strength)
        self.uci_manager = UCIEngineManager(cfg)
        try:
            self.uci_manager.start()
            self.status = f"UCI ready ({self.settings.uci_path})"
            self.last_error = ""
            return True
        except Exception as exc:
            self.last_error = f"UCI start failed: {exc}"
            self.status = self.last_error
            self.stop_uci()
            return False

    def stop_uci(self) -> None:
        if self.uci_manager:
            try:
                self.uci_manager.stop()
            finally:
                self.uci_manager = None

    def _opening_move(self, board: chess.Board) -> Optional[chess.Move]:
        strategy = self.settings.opening_strategy
        if strategy == OpeningStrategy.OFF:
            return None
        book = OpeningBook(paths=self.settings.opening_books)
        return book.choose(
            board=board,
            strategy=strategy.value,
            auto_rotate_books=self.settings.auto_rotate_books,
            active_book_index=self.settings.active_book_index,
        )

    def choose_move(self, board: chess.Board) -> Optional[chess.Move]:
        opening = self._opening_move(board)
        if opening and opening in board.legal_moves:
            self.status = f"Book move ({self.settings.opening_strategy.value})"
            return opening

        if self.settings.engine_type == EngineType.MENTOR:
            self.status = f"Mentor strength {self.settings.ai_strength}"
            return self.mentor_engine.search(board)

        if not self.ensure_uci_ready():
            return None
        assert self.uci_manager is not None
        move = self.uci_manager.best_move(board, chess.engine.Limit(time=self.settings.uci_movetime_ms / 1000.0))
        self.status = f"UCI strength {self.settings.ai_strength}"
        return move
