from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List

import chess


class GameMode(str, Enum):
    HUMAN_VS_AI = "human_vs_ai"
    HUMAN_VS_HUMAN = "human_vs_human"
    AI_VS_AI = "ai_vs_ai"


class EngineType(str, Enum):
    MENTOR = "mentor"
    UCI = "uci"


class OpeningStrategy(str, Enum):
    WEIGHTED = "weighted"
    BEST = "best"
    RANDOM = "random"
    OFF = "off"


@dataclass
class GameSettings:
    game_mode: GameMode = GameMode.HUMAN_VS_AI
    engine_type: EngineType = EngineType.MENTOR
    human_color: bool = chess.WHITE
    ai_strength: int = 7
    opening_strategy: OpeningStrategy = OpeningStrategy.WEIGHTED
    opening_books: List[str] = field(default_factory=list)
    auto_rotate_books: bool = True
    active_book_index: int = 0
    uci_path: str = "stockfish"
    uci_threads: int = 1
    uci_movetime_ms: int = 500

    def cycle_mode(self) -> None:
        order = [GameMode.HUMAN_VS_AI, GameMode.HUMAN_VS_HUMAN, GameMode.AI_VS_AI]
        self.game_mode = order[(order.index(self.game_mode) + 1) % len(order)]

    def cycle_engine_type(self) -> None:
        order = [EngineType.MENTOR, EngineType.UCI]
        self.engine_type = order[(order.index(self.engine_type) + 1) % len(order)]

    def cycle_opening_strategy(self) -> None:
        order = [OpeningStrategy.WEIGHTED, OpeningStrategy.BEST, OpeningStrategy.RANDOM, OpeningStrategy.OFF]
        self.opening_strategy = order[(order.index(self.opening_strategy) + 1) % len(order)]

    def bump_strength(self, delta: int = 1) -> None:
        self.ai_strength = min(10, max(1, self.ai_strength + delta))

    def bump_threads(self, delta: int = 1) -> None:
        self.uci_threads = min(16, max(1, self.uci_threads + delta))

    def bump_movetime(self, delta_ms: int = 100) -> None:
        self.uci_movetime_ms = min(10_000, max(100, self.uci_movetime_ms + delta_ms))

    def cycle_human_color(self) -> None:
        self.human_color = not self.human_color

    def cycle_book_mode(self) -> None:
        self.auto_rotate_books = not self.auto_rotate_books

    def cycle_active_book(self) -> None:
        if not self.opening_books:
            self.active_book_index = 0
            return
        self.active_book_index = (self.active_book_index + 1) % len(self.opening_books)

    def is_human_turn(self, board: chess.Board) -> bool:
        if self.game_mode == GameMode.HUMAN_VS_HUMAN:
            return True
        if self.game_mode == GameMode.AI_VS_AI:
            return False
        return board.turn == self.human_color
