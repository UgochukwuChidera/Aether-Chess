"""P1-T04 regression: engine calls must serialize under a real lock.

`backend/service.py` claimed the shared engine was protected by `_uci_lock`,
but the lock did not exist, and every request ran on its own unbounded daemon
thread. `python-chess` handles are not safe for concurrent use, so overlapping
searches interleave the UCI protocol and corrupt replies. The fix adds
`_uci_lock`, holds it for whole searches, and bounds dispatch with a
module-level `ThreadPoolExecutor(max_workers=8)`.
"""

import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import service  # type: ignore[reportMissingImports]

START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def _install_stub(tracker, hold=0.05):
    """Point `engine_mgr.get_engine_move` at a UCI-protocol stub.

    The stub models one shared engine handle: it records how many searches
    are inside the protocol at once. Overlapping entries mean interleaved
    UCI traffic, which is the corruption the lock must prevent.
    """
    orig = service.engine_mgr.get_engine_move

    def fake(fen, **kwargs):
        with tracker["guard"]:
            tracker["active"] += 1
            tracker["max_active"] = max(tracker["max_active"], tracker["active"])
        time.sleep(hold)
        with tracker["guard"]:
            tracker["active"] -= 1
        return {"move": "e2e4", "san": "e4"}

    service.engine_mgr.get_engine_move = fake  # type: ignore[method-assign]

    def _restore():
        service.engine_mgr.get_engine_move = orig  # type: ignore[method-assign]

    return _restore


def _fresh_tracker():
    return {"guard": threading.Lock(), "active": 0, "max_active": 0}


class ServiceConcurrencyTests(unittest.TestCase):
    def test_request_pool_is_bounded(self):
        """Dispatch must go through a module-level pool capped at 8 workers."""
        pools = [v for v in vars(service).values() if isinstance(v, ThreadPoolExecutor)]
        self.assertTrue(
            pools, "no module-level ThreadPoolExecutor: requests are unbounded threads"
        )
        for pool in pools:
            self.assertEqual(
                pool._max_workers, 8, "request pool must be capped at 8 workers"
            )

    def test_concurrent_engine_moves_do_not_interleave(self):
        """20 overlapping get_engine_move calls must serialize on _uci_lock."""
        tracker = _fresh_tracker()
        restore = _install_stub(tracker)
        errors = []
        try:

            def _call():
                try:
                    service.handle_get_engine_move({"fen": START_FEN})
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

            workers = [threading.Thread(target=_call) for _ in range(20)]
            for w in workers:
                w.start()
            for w in workers:
                w.join(timeout=60)
        finally:
            restore()
        self.assertEqual(errors, [])
        self.assertEqual(
            tracker["max_active"],
            1,
            "engine protocol interleaved: %d concurrent searches"
            % tracker["max_active"],
        )

    def test_two_overlapping_engine_calls_serialized(self):
        """One get_engine_move racing one get_bot_move must not overlap."""
        tracker = _fresh_tracker()
        restore = _install_stub(tracker, hold=0.1)
        errors = []
        gate = threading.Barrier(2)
        try:

            def _engine():
                try:
                    gate.wait(timeout=10)
                    service.handle_get_engine_move({"fen": START_FEN})
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

            def _bot():
                try:
                    gate.wait(timeout=10)
                    service.handle_get_bot_move({"fen": START_FEN})
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

            first = threading.Thread(target=_engine)
            second = threading.Thread(target=_bot)
            first.start()
            second.start()
            first.join(timeout=60)
            second.join(timeout=60)
        finally:
            restore()
        self.assertEqual(errors, [])
        self.assertEqual(
            tracker["max_active"],
            1,
            "overlapping engine calls interleaved on the shared handle",
        )


if __name__ == "__main__":
    unittest.main()
