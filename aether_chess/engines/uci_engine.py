from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import chess
import chess.engine

from aether_chess.engines.registry import discover_engines, resolve_engine_path


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
        """Resolve a usable Stockfish, newest version found across all sources.

        Falls back to the bare name "stockfish" so the old behaviour (whatever
        is on PATH) still applies when nothing better is installed.
        """
        return resolve_engine_path(None) or "stockfish"

    @staticmethod
    def list_engines():
        """Every engine discovered on this machine, newest version first."""
        return discover_engines(None)

    def start(self) -> None:
        # Configure before publishing self.engine: if configure() raises, the
        # manager must stay unstarted rather than hold a half-configured engine.
        engine = chess.engine.SimpleEngine.popen_uci(self.config.path)
        engine.configure(
            {
                "Skill Level": self.config.skill_level,
                "Move Overhead": self.config.move_overhead,
                "Threads": self.config.threads,
                "MultiPV": self.config.multipv,
            }
        )
        self.engine = engine

    def best_move(self, board: chess.Board, limit: chess.engine.Limit) -> chess.Move:
        if self.engine is None:
            raise RuntimeError("Engine not started")
        move = self.engine.play(board, limit).move
        if move is None:
            # play() may return no move (e.g. the side to move has already lost).
            raise RuntimeError(f"Engine returned no move for {board.fen()}")
        return move

    def analyse(
        self,
        board: chess.Board,
        limit: chess.engine.Limit,
        multipv: Optional[int] = None,
    ):
        if self.engine is None:
            raise RuntimeError("Engine not started")
        return self.engine.analyse(board, limit, multipv=multipv or self.config.multipv)

    def stop(self) -> None:
        if self.engine is not None:
            self.engine.quit()
            self.engine = None
