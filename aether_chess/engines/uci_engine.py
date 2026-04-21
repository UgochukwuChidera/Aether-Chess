from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import chess
import chess.engine


@dataclass
class UCIConfig:
    path: str
    skill_level: int = 20
    move_overhead: int = 30
    threads: int = 1
    multipv: int = 1


class UCIEngineManager:
    def __init__(self, config: UCIConfig):
        self.config = config
        self.engine: Optional[chess.engine.SimpleEngine] = None

    @staticmethod
    def default_stockfish_path() -> str:
        exe = "stockfish.exe" if os.name == "nt" else "stockfish"
        return str(Path("stockfish") / exe)

    def start(self) -> None:
        self.engine = chess.engine.SimpleEngine.popen_uci(self.config.path)
        self.engine.configure(
            {
                "Skill Level": self.config.skill_level,
                "Move Overhead": self.config.move_overhead,
                "Threads": self.config.threads,
                "MultiPV": self.config.multipv,
            }
        )

    def best_move(self, board: chess.Board, limit: chess.engine.Limit) -> chess.Move:
        if self.engine is None:
            raise RuntimeError("Engine not started")
        return self.engine.play(board, limit).move

    def analyse(self, board: chess.Board, limit: chess.engine.Limit, multipv: Optional[int] = None):
        if self.engine is None:
            raise RuntimeError("Engine not started")
        return self.engine.analyse(board, limit, multipv=multipv or self.config.multipv)

    def stop(self) -> None:
        if self.engine is not None:
            self.engine.quit()
            self.engine = None
