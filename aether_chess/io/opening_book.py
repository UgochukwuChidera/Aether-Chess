from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Optional

import chess
import chess.polyglot


@dataclass
class OpeningBook:
    path: Optional[str] = None

    def choose_weighted(self, board: chess.Board) -> Optional[chess.Move]:
        if not self.path:
            return None
        try:
            with chess.polyglot.open_reader(self.path) as reader:
                entries = list(reader.find_all(board))
        except (FileNotFoundError, OSError):
            return None
        if not entries:
            return None
        total = sum(max(1, e.weight) for e in entries)
        roll = random.randint(1, total)
        running = 0
        for e in entries:
            running += max(1, e.weight)
            if running >= roll:
                return e.move
        return entries[0].move
