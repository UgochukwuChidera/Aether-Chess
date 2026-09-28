"""P1-T03 regression: history navigation must not corrupt the game.

Two defects lived in `backend/chess_engine.py`:

1. `export_pgn` read `board.move_stack`, which `navigate_to` truncates, so
   exporting mid-history produced a truncated PGN. The authoritative move
   list is `_full_history`, which navigation never touches.
2. `make_move` rebuilt `_full_history` from `board.move_stack`, so moving
   while scrolled into history permanently discarded the game tail.

A third, same-class defect: `undo_move` popped the truncated board and then
snapshotted it into `_full_history`, discarding the tail the same way.
Undo while navigating must return to the live position first, then pop.
"""

import unittest
from io import StringIO

import chess
import chess.pgn

from backend.chess_engine import ChessEngineManager

# Ten legal plies with no captures or promotions: knights bounce out and
# home again. Boring on purpose — the line must stay legal move-for-move.
TEN_PLIES = [
    "g1f3",
    "g8f6",
    "f3g1",
    "f6g8",
    "b1c3",
    "b8c6",
    "c3b1",
    "c6b8",
    "g1f3",
    "g8f6",
]


def _engine_with_ten_plies() -> ChessEngineManager:
    eng = ChessEngineManager()
    eng.new_game()
    for uci in TEN_PLIES:
        ok, _ = eng.make_move(uci)
        assert ok, f"setup move {uci} rejected"
    assert len(eng._full_history) == 10
    return eng


def _pgn_ply_count(pgn_text: str) -> int:
    game = chess.pgn.read_game(StringIO(pgn_text))
    assert game is not None, "export_pgn did not produce a parseable game"
    return sum(1 for _ in game.mainline_moves())


class NavigationExportTests(unittest.TestCase):
    def test_export_pgn_keeps_full_game_while_navigating(self):
        eng = _engine_with_ten_plies()
        eng.navigate_to(3)
        self.assertEqual(_pgn_ply_count(eng.export_pgn()), 10)

    def test_make_move_rejected_while_navigating(self):
        eng = _engine_with_ten_plies()
        before = list(eng._full_history)
        eng.navigate_to(3)
        ok, info = eng.make_move("e2e4")
        self.assertFalse(ok, "move while navigating must be rejected")
        self.assertIn("reason", info)
        self.assertTrue(info["reason"])
        self.assertEqual(eng._full_history, before)

    def test_undo_while_navigating_returns_to_live_then_pops(self):
        eng = _engine_with_ten_plies()
        eng.navigate_to(3)
        eng.undo_move()
        self.assertEqual(len(eng._full_history), 9)
        self.assertEqual(eng._nav_index, -1)
        self.assertEqual(len(eng.board.move_stack), 9)


if __name__ == "__main__":
    unittest.main()
