from __future__ import annotations

from dataclasses import dataclass, field
from io import StringIO
from typing import List, Optional

import chess
import chess.pgn


@dataclass
class GameState:
    board: chess.Board = field(default_factory=chess.Board)

    @property
    def move_history(self) -> List[chess.Move]:
        # P2-T19: one-direction derivation — the board's move stack is the
        # single source of truth and move_history is derived from it, never
        # stored beside it. Every mutation below touches the board only, so
        # the two cannot drift (the P1-T03 moves-param interplay is untouched:
        # to_pgn's explicit-moves parameter still rules export).
        return list(self.board.move_stack)

    def reset(self) -> None:
        self.board.reset()

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
        return True

    def pop(self) -> Optional[chess.Move]:
        if not self.board.move_stack:
            return None
        return self.board.pop()

    def load_fen(self, fen: str) -> None:
        self.board.set_fen(fen)

    def to_fen(self) -> str:
        return self.board.fen()

    def to_pgn(
        self,
        event: str = "Aether Chess Game",
        moves: Optional[List[chess.Move]] = None,
        initial_fen: str = chess.STARTING_FEN,
    ) -> str:
        game = chess.pgn.Game()
        game.headers["Event"] = event
        node = game
        # P4-T09: the legality-check replay starts at the game start, not
        # unconditionally at startpos -- otherwise FEN-opened moves are
        # dropped as illegal here even when the caller passed the full list.
        # Default keeps every existing caller byte-identical. The PGN root
        # is the same replay start: without `setup()` the node SANs are
        # computed from startpos (`1. exe5 Nxc3 ...` for a FEN game) and
        # re-parsing truncates at the first illegal SAN, so the conditional
        # keeps standard exports byte-identical while FEN exports parse.
        replay_board = chess.Board(initial_fen)
        if initial_fen != chess.STARTING_FEN:
            game.setup(replay_board)
        for move in self.board.move_stack if moves is None else moves:
            if move in replay_board.legal_moves:
                node = node.add_variation(move)
                replay_board.push(move)
        return str(game)

    def load_pgn(self, pgn_text: str) -> None:
        game = chess.pgn.read_game(StringIO(pgn_text))
        if game is None:
            raise ValueError("Invalid PGN")
        # P2-T19: the parser is lenient — it truncates at an illegal SAN and
        # records the drop in game.errors. Loading that truncation would be a
        # DIFFERENT legal game with no warning, so raise with the game identity.
        event = game.headers.get("Event", "?")
        if game.errors:
            details = "; ".join(str(e) for e in game.errors)
            raise ValueError(f"Corrupt PGN in game {event!r}: {details}")
        self.reset()
        for ply, move in enumerate(game.mainline_moves(), start=1):
            if move not in self.board.legal_moves:
                raise ValueError(
                    f"Illegal move at ply {ply} ({move.uci()}) in game {event!r}: "
                    "PGN does not replay from the starting position"
                )
            self.push(move)
