from __future__ import annotations

from dataclasses import dataclass, field
from io import StringIO
from typing import List, Optional

import chess
import chess.pgn


@dataclass
class GameState:
    board: chess.Board = field(default_factory=chess.Board)
    move_history: List[chess.Move] = field(default_factory=list)

    def reset(self) -> None:
        self.board.reset()
        self.move_history.clear()

    def legal_moves(self) -> List[chess.Move]:
        return list(self.board.legal_moves)

    def push_uci(self, move_uci: str) -> bool:
        try:
            move = chess.Move.from_uci(move_uci)
        except ValueError:
            return False
        return self.push(move)

    def push(self, move: chess.Move) -> bool:
        if move not in self.board.legal_moves:
            return False
        self.board.push(move)
        self.move_history.append(move)
        return True

    def pop(self) -> Optional[chess.Move]:
        if not self.board.move_stack:
            return None
        move = self.board.pop()
        if self.move_history:
            self.move_history.pop()
        return move

    def load_fen(self, fen: str) -> None:
        self.board.set_fen(fen)
        self.move_history = list(self.board.move_stack)

    def to_fen(self) -> str:
        return self.board.fen()

    def to_pgn(self, event: str = "Aether Chess Game") -> str:
        game = chess.pgn.Game()
        game.headers["Event"] = event
        node = game
        replay_board = chess.Board()
        for move in self.board.move_stack:
            if move in replay_board.legal_moves:
                node = node.add_variation(move)
                replay_board.push(move)
        return str(game)

    def load_pgn(self, pgn_text: str) -> None:
        game = chess.pgn.read_game(StringIO(pgn_text))
        if game is None:
            raise ValueError("Invalid PGN")
        self.reset()
        for move in game.mainline_moves():
            self.push(move)
