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

import sys
import unittest
from io import StringIO
from pathlib import Path

import chess
import chess.pgn

from backend.chess_engine import ChessEngineManager

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import service  # type: ignore[reportMissingImports]

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
        # P1-T05: the live sentinel is None now (was -1); the IPC shape
        # is unchanged — snapshots still emit -1 for live.
        self.assertIsNone(eng._nav_index)
        self.assertEqual(len(eng.board.move_stack), 9)


class ReturnToLiveTests(unittest.TestCase):
    """P1-T05 regression: navigation needs a return-to-live transition.

    P1-T03 rejects `make_move` whenever the nav index is set, but
    `navigate_to(len - 1)` — every UI go-to-end path — replays the live
    FEN while keeping the index set, so every later move is rejected.
    And `navigate_to(-1)` shows the startpos FEN while holding the live
    sentinel, so a startpos-legal move is accepted and replaces history.
    """

    def test_navigate_to_end_then_live_legal_move_accepted(self):
        eng = _engine_with_ten_plies()
        before = list(eng._full_history)
        eng.navigate_to(3)
        snap = eng.navigate_to(len(before) - 1)
        self.assertEqual(snap['nav_index'], -1)
        live_uci = eng.legal_moves_uci()[0]
        ok, _ = eng.make_move(live_uci)
        self.assertTrue(ok, 'move after return-to-live must be accepted')
        self.assertEqual(eng._full_history[:10], before)
        self.assertEqual(len(eng._full_history), 11)
        self.assertEqual(len(eng.board.move_stack), 11)
        self.assertEqual(eng._state_snapshot()['nav_index'], -1)

    def test_navigate_to_start_then_startpos_move_rejected(self):
        eng = _engine_with_ten_plies()
        before = list(eng._full_history)
        eng.navigate_to(-1)
        self.assertEqual(eng.fen(), chess.Board().fen())
        ok, info = eng.make_move('e2e4')
        self.assertFalse(ok, 'move while viewing startpos must be rejected')
        self.assertIn('reason', info)
        self.assertTrue(info['reason'])
        self.assertEqual(eng._full_history, before)


class ServiceReasonTests(unittest.TestCase):
    """P1-T05 Change 2: the guard reason must surface through the service."""

    def test_guard_reason_surfaces_through_handle_make_move(self):
        service.engine_mgr.new_game()
        for uci in TEN_PLIES:
            ok, _ = service.engine_mgr.make_move(uci)
            assert ok, f'setup move {uci} rejected'
        live_uci = service.engine_mgr.legal_moves_uci()[0]
        service.engine_mgr.navigate_to(3)
        with self.assertRaises(ValueError) as ctx:
            service.handle_make_move({'move': live_uci})
        self.assertIn('Return to the live position', str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
