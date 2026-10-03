"""P3-T01: the backend owns the clock and game termination.

Fail-first contract: none of the clock state (`_white_ms`, `_black_ms`,
`_increment_ms`, monotonic turn stamp), the flag latch, `resign`/`draw`, or
the snapshot `clock` object exists yet, so every assertion below raises
AttributeError/KeyError on the pre-fix code.

Covered:
1. `new_game(time_control=...)` installs both clocks + increment.
2. Increment is debited-before-apply and credited-after (correct side only).
3. Flag-fall (debited mover <= 0) ends the game: backend reports over with
   `result`/`termination`; later moves are rejected; the snapshot agrees.
4. An idle flag (time expires with no move) latches on the next snapshot —
   this is the path the 1 Hz `clock_tick` push observes.
5. Switching to Unlimited (or omitting `time_control`) clears both clocks.
6. The snapshot clock is never inconsistent (remaining >= 0).
7. `resign(side)` records the losing side; `draw()` records 1/2-1/2.
8. `new_game` resets clocks + latch; `undo_move` reopens a latched game.
9. The tick-push loop emits `clock_tick` snapshots and stops on demand.
"""

import sys
import time
import unittest
from pathlib import Path
from unittest import mock

from backend.chess_engine import ChessEngineManager

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import service  # type: ignore[reportMissingImports]  # noqa: E402

BLITZ = {"seconds": 300, "increment": 5}
BULLET = {"seconds": 60, "increment": 1}


def _clock_of(snapshot):
    assert "clock" in snapshot, "snapshot carries no clock object"
    return snapshot["clock"]


class ClockSetupTests(unittest.TestCase):
    def test_new_game_installs_clocks_and_increment(self):
        eng = ChessEngineManager()
        with mock.patch.object(time, "monotonic", return_value=1000.0):
            eng.new_game(time_control=dict(BLITZ))
            snap = eng._state_snapshot()
        clock = _clock_of(snap)
        self.assertEqual(clock["white_ms"], 300_000)
        self.assertEqual(clock["black_ms"], 300_000)
        self.assertEqual(clock["increment_ms"], 5_000)

    def test_unlimited_clears_both_clocks(self):
        eng = ChessEngineManager()
        eng.new_game(time_control=dict(BLITZ))
        self.assertIsNotNone(_clock_of(eng._state_snapshot()))
        eng.new_game(time_control={"seconds": 0, "increment": 0})
        self.assertIsNone(_clock_of(eng._state_snapshot()))

    def test_missing_time_control_means_unlimited(self):
        eng = ChessEngineManager()
        eng.new_game(time_control=dict(BLITZ))
        eng.new_game()
        self.assertIsNone(_clock_of(eng._state_snapshot()))

    def test_service_new_game_consumes_time_control(self):
        # The renderer sends `time_control`; the service must forward it into
        # the clock rather than merely storing it in settings.
        service.engine_mgr.new_game()
        with mock.patch.object(time, "monotonic", return_value=1000.0):
            service.handle_new_game({"time_control": dict(BULLET)})
            clock = _clock_of(service.engine_mgr._state_snapshot())
        self.assertEqual(clock["white_ms"], 60_000)
        self.assertEqual(clock["increment_ms"], 1_000)
        service.engine_mgr.new_game()


class DebitAndIncrementTests(unittest.TestCase):
    def test_mover_debited_then_incremented_correct_side_only(self):
        eng = ChessEngineManager()
        with mock.patch.object(time, "monotonic", return_value=1000.0):
            eng.new_game(time_control=dict(BLITZ))
        with mock.patch.object(time, "monotonic", return_value=1010.0):
            ok, snap = eng.make_move("e2e4")
        self.assertTrue(ok)
        clock = _clock_of(snap)
        # White thought 10 s, then earned the 5 s increment.
        self.assertEqual(clock["white_ms"], 300_000 - 10_000 + 5_000)
        # Black has not moved: untouched.
        self.assertEqual(clock["black_ms"], 300_000)

    def test_snapshot_clock_never_negative(self):
        eng = ChessEngineManager()
        with mock.patch.object(time, "monotonic", return_value=1000.0):
            eng.new_game(time_control={"seconds": 30, "increment": 0})
        with mock.patch.object(time, "monotonic", return_value=1029.0):
            ok, snap = eng.make_move("e2e4")
        self.assertTrue(ok)
        clock = _clock_of(snap)
        self.assertGreaterEqual(clock["white_ms"], 0)
        self.assertGreaterEqual(clock["black_ms"], 0)


class FlagFallTests(unittest.TestCase):
    def test_flag_fall_on_move_ends_game_with_result(self):
        eng = ChessEngineManager()
        with mock.patch.object(time, "monotonic", return_value=1000.0):
            eng.new_game(time_control={"seconds": 60, "increment": 0})
        with mock.patch.object(time, "monotonic", return_value=1075.0):
            ok, snap = eng.make_move("e2e4")
        self.assertTrue(ok, "the played move still lands on the board")
        self.assertTrue(snap["game_over"], "backend alone ends the game")
        self.assertEqual(snap["result"], "0-1", "white flagged: black wins")
        self.assertTrue(snap["termination"], "a termination is recorded")
        self.assertEqual(_clock_of(snap)["white_ms"], 0)

    def test_idle_flag_latches_on_snapshot_without_any_move(self):
        eng = ChessEngineManager()
        with mock.patch.object(time, "monotonic", return_value=1000.0):
            eng.new_game(time_control={"seconds": 60, "increment": 0})
        # Nobody moves; white's clock runs out. The next snapshot — the
        # same one the tick-push loop forwards — must report the game over.
        with mock.patch.object(time, "monotonic", return_value=1075.0):
            snap = eng._state_snapshot()
        self.assertTrue(snap["game_over"])
        self.assertEqual(snap["result"], "0-1")
        self.assertTrue(snap["termination"])

    def test_black_flag_falls_symmetrically(self):
        eng = ChessEngineManager()
        with mock.patch.object(time, "monotonic", return_value=1000.0):
            eng.new_game(time_control={"seconds": 60, "increment": 0})
        with mock.patch.object(time, "monotonic", return_value=1005.0):
            ok, _ = eng.make_move("e2e4")
        self.assertTrue(ok)
        with mock.patch.object(time, "monotonic", return_value=1080.0):
            ok, snap = eng.make_move("e7e5")
        self.assertTrue(ok)
        self.assertTrue(snap["game_over"])
        self.assertEqual(snap["result"], "1-0", "black flagged: white wins")

    def test_moves_rejected_once_flagged(self):
        eng = ChessEngineManager()
        with mock.patch.object(time, "monotonic", return_value=1000.0):
            eng.new_game(time_control={"seconds": 60, "increment": 0})
        with mock.patch.object(time, "monotonic", return_value=1075.0):
            eng.make_move("e2e4")
        ok, info = eng.make_move("e7e5")
        self.assertFalse(ok, "no moves after the flag")
        self.assertTrue(info.get("reason"))
        # And the snapshot still reports the game over.
        self.assertTrue(eng._state_snapshot()["game_over"])


class ResignDrawTests(unittest.TestCase):
    def test_resign_records_losing_side(self):
        eng = ChessEngineManager()
        eng.new_game()
        ok, snap = eng.resign("white")
        self.assertTrue(ok)
        self.assertTrue(snap["game_over"])
        self.assertEqual(snap["result"], "0-1")
        self.assertTrue(snap["termination"])

    def test_resign_black(self):
        eng = ChessEngineManager()
        eng.new_game()
        ok, snap = eng.resign("black")
        self.assertTrue(ok)
        self.assertEqual(snap["result"], "1-0")

    def test_draw_records_half(self):
        eng = ChessEngineManager()
        eng.new_game()
        ok, snap = eng.draw()
        self.assertTrue(ok)
        self.assertTrue(snap["game_over"])
        self.assertEqual(snap["result"], "1/2-1/2")
        self.assertTrue(snap["termination"])

    def test_resign_rejected_after_game_over(self):
        eng = ChessEngineManager()
        eng.new_game()
        eng.draw()
        ok, info = eng.resign("white")
        self.assertFalse(ok)
        self.assertTrue(info.get("reason"))

    def test_service_resign_draw_round_trip(self):
        service.engine_mgr.new_game()
        snap = service.handle_resign({"side": "white"})
        self.assertEqual(snap["result"], "0-1")
        service.engine_mgr.new_game()
        snap = service.handle_draw({})
        self.assertEqual(snap["result"], "1/2-1/2")
        service.engine_mgr.new_game()


class LatchLifecycleTests(unittest.TestCase):
    def test_new_game_resets_clocks_and_latch(self):
        eng = ChessEngineManager()
        with mock.patch.object(time, "monotonic", return_value=1000.0):
            eng.new_game(time_control={"seconds": 60, "increment": 0})
        with mock.patch.object(time, "monotonic", return_value=1075.0):
            eng.make_move("e2e4")
        self.assertTrue(eng._state_snapshot()["game_over"])
        with mock.patch.object(time, "monotonic", return_value=2000.0):
            eng.new_game(time_control=dict(BLITZ))
            snap = eng._state_snapshot()
        self.assertFalse(snap["game_over"])
        self.assertIsNone(snap["result"])
        self.assertEqual(_clock_of(snap)["white_ms"], 300_000)

    def test_undo_reopens_latched_game(self):
        eng = ChessEngineManager()
        eng.new_game()
        eng.resign("white")
        self.assertTrue(eng._state_snapshot()["game_over"])
        snap = eng.undo_move()
        self.assertFalse(snap["game_over"])
        self.assertIsNone(snap["result"])


class TickPushTests(unittest.TestCase):
    def test_tick_push_emits_and_stops(self):
        eng = ChessEngineManager()
        eng.new_game(time_control=dict(BLITZ))
        ticks = []
        eng.start_clock_push(ticks.append, interval_sec=0.05)
        try:
            deadline = time.time() + 2.0
            while not ticks and time.time() < deadline:
                time.sleep(0.02)
        finally:
            eng.stop_clock_push()
        self.assertTrue(ticks, "no clock_tick emitted while the clock runs")
        self.assertEqual(ticks[0].get("type"), "clock_tick")
        self.assertIn("clock", ticks[0])
        count = len(ticks)
        time.sleep(0.2)
        self.assertEqual(len(ticks), count, "ticks continue after stop")


if __name__ == "__main__":
    unittest.main()
