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


class FenStartNavigationTests(unittest.TestCase):
    """P4-T09: navigation replay must start from the retained `_initial_fen`.

    `navigate_to` / `_board_from_full_history` replayed from startpos, so a
    game opened with `new_game(fen=...)` (Black to move here) showed wrong
    squares mid-history, dropped FEN-legal moves as illegal, and exported a
    truncated PGN. Pre-fix proof (4 plies from the FEN below, navigate_to(1)):

      expected: rnbqkbnr/pppp1ppp/8/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR b KQkq - 1 2
      viewed:   rnbqkbnr/pppp1ppp/8/4P3/8/2n5/PPPPPPPP/R1BQKBNR w KQkq - 0 2

    (white pawn back on e2, a BLACK knight on c3, wrong side to move), plus
    `history_fens_and_moves` 3/3 instead of 4/4, `move_history_san`
    `['Nc3', 'Nf6', 'Nf3']` (e5 dropped), and `export_pgn` missing e5.
    """

    # After 1.e4, Black to move. e7e5 is legal for Black here and ILLEGAL
    # for White from startpos -- a startpos replay drops it (same FEN as
    # the snapshot-colors suite, so the two suites agree on the fixture).
    BLACK_TO_MOVE_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
    FOUR_PLIES = ['e7e5', 'b1c3', 'g8f6', 'g1f3']

    def _engine_with_four_plies(self):
        eng = ChessEngineManager()
        eng.new_game(fen=self.BLACK_TO_MOVE_FEN)
        for uci in self.FOUR_PLIES:
            ok, _ = eng.make_move(uci)
            assert ok, f'setup move {uci} rejected'
        assert len(eng._full_history) == 4
        return eng

    def _expected_fen_after(self, plies):
        board = chess.Board(self.BLACK_TO_MOVE_FEN)
        for uci in self.FOUR_PLIES[:plies]:
            board.push(chess.Move.from_uci(uci))
        return board.fen()

    def test_navigate_mid_shows_fen_replay_position(self):
        eng = self._engine_with_four_plies()
        snap = eng.navigate_to(1)
        self.assertEqual(snap['fen'], self._expected_fen_after(2))
        self.assertEqual(snap['nav_index'], 1)

    def test_return_to_live_restores_full_position_and_export(self):
        eng = self._engine_with_four_plies()
        live_fen = self._expected_fen_after(4)
        eng.navigate_to(1)
        snap = eng.navigate_to(len(self.FOUR_PLIES) - 1)
        self.assertEqual(snap['nav_index'], -1)
        self.assertEqual(eng.fen(), live_fen)
        self.assertEqual(len(eng.board.move_stack), 4)
        pgn_text = eng.export_pgn()
        self.assertEqual(_pgn_ply_count(pgn_text), 4)
        self.assertIn('e5', pgn_text)

    def test_empty_fen_game_navigate_does_not_crash(self):
        eng = ChessEngineManager()
        eng.new_game(fen=self.BLACK_TO_MOVE_FEN)
        for index in (-1, 0):
            snap = eng.navigate_to(index)
            self.assertEqual(eng.fen(), chess.Board(self.BLACK_TO_MOVE_FEN).fen())
            self.assertEqual(snap['nav_index'], -1)
            self.assertEqual(snap['fen'], chess.Board(self.BLACK_TO_MOVE_FEN).fen())

    def test_history_fens_and_moves_uses_initial_fen(self):
        eng = self._engine_with_four_plies()
        fen_list, moves = eng.history_fens_and_moves()
        self.assertEqual(moves, self.FOUR_PLIES)
        self.assertEqual(len(fen_list), 4)
        self.assertEqual(fen_list[0], chess.Board(self.BLACK_TO_MOVE_FEN).fen())

    def test_move_history_san_uses_initial_fen(self):
        eng = self._engine_with_four_plies()
        self.assertEqual(eng.move_history_san(), ['e5', 'Nc3', 'Nf6', 'Nf3'])



if __name__ == "__main__":
    unittest.main()
