"""P4-T01 fail-first: Syzygy tablebase selection is broken three ways.

`aether_chess/io/tablebases.py::TablebaseProbe.best_move` (37 lines, no
production caller) probes after `board.push(move)`, so the side to move is
the OPPONENT and python-chess values read from the opponent's perspective
(positive = opponent winning):

1. The sign test is inverted: `side_to_move == WHITE -> min DTZ` is right
   for White but `BLACK -> max DTZ` picks the most opponent-winning move,
   so every Black-to-move position selects the wrong move. `side_to_move`
   is not needed at all -- the mover always wants the most negative DTZ.
2. `probe_dtz` may yield `None` (unknown position); `:31`/`:33` compare it
   against an `int` -> `TypeError` past the first iteration.
3. Raw-DTZ minmax is the documented anti-pattern (python-chess:
   "Minmaxing the DTZ50'' values guarantees winning a won position ...
   However, the lines are not always the most straightforward ways to
   win"): prefer forced mate, then WDL, then DTZ as a tiebreak.

These tests assert the FIXED behaviour against a ~10-line stub tablebase
(FEN -> value map, probe_dtz/probe_wdl + context-manager protocol), so no
tablebase data is needed. Every defect test below FAILS on the pre-fix
code for the stated reason; the guard tests (path/pieces/errors) pass
before and after and lock the detect-and-report contract.
"""

import os
import sys
import unittest
from pathlib import Path

import chess
import chess.syzygy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aether_chess.io.tablebases import TablebaseProbe  # noqa: E402


class StubTablebase:
    """FEN -> (wdl, dtz) map with the probe + context-manager protocol."""

    def __init__(self, values, exc=None):
        self.values = values
        self.exc = exc

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def probe_wdl(self, board):
        if self.exc is not None:
            raise self.exc("stub: no table")
        return self.values[board.fen()][0]

    def probe_dtz(self, board):
        if self.exc is not None:
            raise self.exc("stub: no table")
        return self.values[board.fen()][1]


def _make_opener(tablebase=None, exc=None, calls=None):
    """Injectable opener replacing chess.syzygy.open_tablebase."""

    def opener(path):
        if calls is not None:
            calls.append(path)
        if exc is not None:
            raise exc("stub opener: %s" % path)
        return tablebase

    return opener


def _after(board, uci):
    """FEN reached after playing `uci` on a copy (stub map key)."""
    probe = board.copy()
    probe.push(chess.Move.from_uci(uci))
    return probe.fen()


def _mates(board):
    out = []
    for move in board.legal_moves:
        board.push(move)
        if board.is_checkmate():
            out.append(move.uci())
        board.pop()
    return out


# White: KQ vs k, three mates in the position (b6d8/b6b7/b6a7).
WHITE_FEN = "k7/8/KQ6/8/8/8/8/8 w - - 0 1"
# Black: kq vs K mirror, mates b3b2/b3a2/b3d1.
BLACK_FEN = "8/8/8/8/8/kq6/8/K7 b - - 0 1"
# Mate-free positions for win/fastest/None tests: mate-first short-circuit
# would otherwise dominate (any mate beats any stub win), so WDL/DTZ
# selection needs positions with zero mates to be observable.
WHITE_NOMATE_FEN = "8/8/4k3/8/8/4K3/4Q3/8 w - - 0 1"
BLACK_NOMATE_FEN = "8/4q3/4K3/8/8/4k3/8/8 b - - 0 1"
# Over the 6-piece Syzygy limit: full startpos.
BIG_FEN = chess.STARTING_FEN


class OpenerInjectionTests(unittest.TestCase):
    def test_opener_defaults_to_syzygy_open_tablebase(self):
        """Change 1: the opener is a field defaulting to the real one."""
        self.assertIs(TablebaseProbe().opener, chess.syzygy.open_tablebase)

    def test_injected_opener_receives_the_configured_path(self):
        calls = []
        probe = TablebaseProbe(
            path="/fake/syzygy",
            opener=_make_opener(StubTablebase({}), calls=calls),
        )
        board = chess.Board("k7/8/KQ6/8/8/8/8/8 w - - 0 1")
        for _move in board.legal_moves:
            probe.best_move(board)
            break
        self.assertEqual(calls, ["/fake/syzygy"])


class WinningMoveTests(unittest.TestCase):
    def _win_loss_values(self, board, win_uci, loss_uci):
        """One winning move (opponent wdl -2), one losing (opponent +2)."""
        values = {_after(board, win_uci): (-2, -5), _after(board, loss_uci): (2, 30)}
        for move in board.legal_moves:
            key = _after(board, move.uci())
            values.setdefault(key, (0, 0))
        return values

    def test_white_selects_winning_move(self):
        board = chess.Board(WHITE_NOMATE_FEN)
        moves = [mv.uci() for mv in board.legal_moves]
        values = self._win_loss_values(board, moves[0], moves[1])
        probe = TablebaseProbe(
            path="/fake/syzygy", opener=_make_opener(StubTablebase(values))
        )
        best = probe.best_move(board)
        assert best is not None
        self.assertEqual(best.uci(), moves[0])

    def test_black_selects_winning_move(self):
        """Defect 1 regression: pre-fix max-DTZ picks the losing move."""
        board = chess.Board(BLACK_NOMATE_FEN)
        moves = [mv.uci() for mv in board.legal_moves]
        values = self._win_loss_values(board, moves[0], moves[1])
        probe = TablebaseProbe(
            path="/fake/syzygy", opener=_make_opener(StubTablebase(values))
        )
        best = probe.best_move(board)
        assert best is not None
        self.assertEqual(best.uci(), moves[0])


class FastestWinTests(unittest.TestCase):
    def test_fastest_win_selected(self):
        """Defect 3: pre-fix raw-DTZ minmax takes the slowest win (-50)."""
        board = chess.Board(WHITE_NOMATE_FEN)
        moves = [mv.uci() for mv in board.legal_moves]
        values = {
            _after(board, moves[0]): (-2, -5),
            _after(board, moves[1]): (-2, -50),
        }
        for move in board.legal_moves:
            values.setdefault(_after(board, move.uci()), (0, 0))
        probe = TablebaseProbe(
            path="/fake/syzygy", opener=_make_opener(StubTablebase(values))
        )
        best = probe.best_move(board)
        assert best is not None
        self.assertEqual(best.uci(), moves[0])


class MatePreferenceTests(unittest.TestCase):
    def test_mate_in_1_beats_better_dtz(self):
        """Change 2: is_checkmate first, even when the mate's DTZ is worse."""
        board = chess.Board(WHITE_FEN)
        mates = _mates(board)
        self.assertTrue(mates, "fixture must contain a mate in 1")
        nonmates = [m for m in (mv.uci() for mv in board.legal_moves) if m not in mates]
        # Every mate reads as a near-zero DTZ win -- raw-DTZ minmax then
        # prefers the "more negative" non-mating win, missing the mate.
        values = {_after(board, nonmates[0]): (-2, -5)}
        for mate in mates:
            values[_after(board, mate)] = (-2, -1)
        for move in board.legal_moves:
            values.setdefault(_after(board, move.uci()), (0, 0))
        probe = TablebaseProbe(
            path="/fake/syzygy", opener=_make_opener(StubTablebase(values))
        )
        best = probe.best_move(board)
        assert best is not None
        self.assertIn(best.uci(), mates)


class NoneSafetyTests(unittest.TestCase):
    def test_none_dtz_skipped_without_type_error(self):
        """Defect 2: pre-fix `None < int` raises TypeError past move one."""
        board = chess.Board(WHITE_NOMATE_FEN)
        moves = [mv.uci() for mv in board.legal_moves]
        values = {
            _after(board, moves[0]): (-2, -20),
            _after(board, moves[1]): (-2, None),
        }
        for move in board.legal_moves:
            values.setdefault(_after(board, move.uci()), (0, 0))
        probe = TablebaseProbe(
            path="/fake/syzygy", opener=_make_opener(StubTablebase(values))
        )
        best = probe.best_move(board)
        assert best is not None
        self.assertEqual(best.uci(), moves[0])


class GuardTests(unittest.TestCase):
    def test_more_than_six_pieces_returns_none(self):
        calls = []
        probe = TablebaseProbe(
            path="/fake/syzygy",
            opener=_make_opener(StubTablebase({}), calls=calls),
        )
        self.assertIsNone(probe.best_move(chess.Board(BIG_FEN)))

    def test_no_path_configured_returns_none(self):
        calls = []
        probe = TablebaseProbe(opener=_make_opener(StubTablebase({}), calls=calls))
        self.assertIsNone(probe.best_move(chess.Board(WHITE_FEN)))
        self.assertEqual(calls, [])

    def test_missing_table_error_returns_none(self):
        # Mate-free FEN: mate-first would otherwise return before probing,
        # so the probe-error path would never execute.
        probe = TablebaseProbe(
            path="/fake/syzygy",
            opener=_make_opener(StubTablebase({}, exc=chess.syzygy.MissingTableError)),
        )
        self.assertIsNone(probe.best_move(chess.Board(WHITE_NOMATE_FEN)))

    def test_os_error_returns_none(self):
        probe = TablebaseProbe(
            path="/fake/syzygy", opener=_make_opener(StubTablebase({}, exc=OSError))
        )
        self.assertIsNone(probe.best_move(chess.Board(WHITE_NOMATE_FEN)))

    def test_file_not_found_returns_none(self):
        probe = TablebaseProbe(
            path="/fake/syzygy",
            opener=_make_opener(StubTablebase({}, exc=FileNotFoundError)),
        )
        self.assertIsNone(probe.best_move(chess.Board(WHITE_NOMATE_FEN)))

    def test_opener_failure_returns_none(self):
        probe = TablebaseProbe(path="/missing/dir", opener=_make_opener(exc=OSError))
        self.assertIsNone(probe.best_move(chess.Board(WHITE_FEN)))


@unittest.skipUnless(
    os.environ.get("AETHER_TABLEBASE_PATH"),
    "opt-in: set AETHER_TABLEBASE_PATH to a Syzygy directory (never in CI)",
)
class RealTablebaseTests(unittest.TestCase):
    """Opt-in integration: known-value fixture from the python-chess docs."""

    def test_known_fixture_values(self):
        import chess.syzygy

        board = chess.Board("8/2K5/4B3/3N4/8/8/4k3/8 b - - 0 1")
        with chess.syzygy.open_tablebase(
            os.environ["AETHER_TABLEBASE_PATH"]
        ) as tablebase:
            self.assertEqual(tablebase.probe_dtz(board), -53)
            self.assertEqual(tablebase.probe_wdl(board), -2)

    def test_best_move_with_real_tables(self):
        board = chess.Board("8/2K5/4B3/3N4/8/8/4k3/8 b - - 0 1")
        probe = TablebaseProbe(path=os.environ["AETHER_TABLEBASE_PATH"])
        best = probe.best_move(board)
        self.assertIsNotNone(best)
        self.assertIn(best, board.legal_moves)


if __name__ == "__main__":
    unittest.main()
