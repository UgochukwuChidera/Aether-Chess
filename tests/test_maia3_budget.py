"""P2-T10: Maia3 honors the manager-resolved time budget.

The manager resolves one aligned budget per move (``BotManager.resolve_budget``
-> ``request.time_limit_sec``) and hands it unchanged to whichever bot plays.
Maia3 must respect it: the proxy honors the MINIMUM of the profile-sampled
think time and the caller's budget (clamp, not replace), sampled once upstream.

Fail-first proof: with a classical profile (minimum bucket 2s) and a caller
budget of 0.4s, the old code ignores the budget entirely -- ``Limit(time=0.1)``
for the search plus an independent post-play resample-and-sleep -- so elapsed
lands near 2s, well past budget + tolerance. The fixed code drives the search
with the caller budget, so elapsed stays within budget + tolerance and the
played move still returns.
"""

from __future__ import annotations

import threading
import time
import unittest
from unittest import mock

import chess

from aether_chess.bots.base import MoveRequest
from aether_chess.bots.maia3_bot import Maia3Bot
from aether_chess.engines.maia3_proxy import Maia3Proxy

START = chess.STARTING_FEN
BUDGET = 0.4
TOLERANCE = 0.5


class HonestEngine:
    """Stub engine that honors Limit(time=...) exactly, like a real UCI engine.

    Sleeps for the limit it was given, then returns the first legal move.
    This is what makes the budget observable: whatever limit the proxy chose
    is what elapsed.
    """

    def __init__(self) -> None:
        self.seen_limits: list = []

    def play(self, board, limit, **kwargs):
        seconds = limit.time if limit is not None and limit.time else 0.1
        self.seen_limits.append(seconds)
        time.sleep(seconds)
        move = next(iter(board.legal_moves))
        return type("Result", (), {"move": move})()

    def ping(self):
        return True

    def quit(self):
        pass


class HangingEngine(HonestEngine):
    """Stub engine whose ping() hangs past any reasonable timeout."""

    def ping(self):
        time.sleep(5.0)
        return True


class TestMaia3BudgetClamp(unittest.TestCase):
    def test_play_elapsed_bounded_by_caller_budget(self):
        proxy = Maia3Proxy()
        engine = HonestEngine()
        proxy._ensure_engine = lambda req: engine  # type: ignore[method-assign]
        bot = Maia3Bot(proxy=proxy)
        try:
            request = MoveRequest(
                fen=START, time_limit_sec=BUDGET, think_profile="classical"
            )
            t0 = time.perf_counter()
            move = bot.play(request)
            elapsed = time.perf_counter() - t0
        finally:
            bot.close()
        self.assertIsNotNone(move.uci, "move must still return (graceful, not hang)")
        self.assertLessEqual(
            elapsed,
            BUDGET + TOLERANCE,
            f"elapsed {elapsed:.2f}s blew past budget {BUDGET}s + {TOLERANCE}s",
        )
        self.assertEqual(len(engine.seen_limits), 1)
        self.assertAlmostEqual(
            engine.seen_limits[0],
            BUDGET,
            delta=0.05,
            msg=f"engine saw limit {engine.seen_limits[0]!r}, not caller budget {BUDGET}",
        )

    def test_bot_forwards_clamped_budget_to_proxy(self):
        """The bot reads request.time_limit_sec (like mentor/stockfish) and the
        proxy receives it -- the single-source flow manager -> request -> proxy."""
        proxy = Maia3Proxy()
        engine = HonestEngine()
        proxy._ensure_engine = lambda req: engine  # type: ignore[method-assign]
        seen: dict = {}
        real_play = proxy.play

        def spy(**kwargs):
            seen.update(kwargs)
            return real_play(**kwargs)

        proxy.play = spy  # type: ignore[method-assign]
        bot = Maia3Bot(proxy=proxy)
        try:
            bot.play(MoveRequest(fen=START, time_limit_sec=BUDGET))
        finally:
            bot.close()
        self.assertIn(
            "time_limit_sec", seen, "bot must forward the resolved budget to the proxy"
        )
        self.assertAlmostEqual(seen["time_limit_sec"], BUDGET, delta=0.05)


class TestMaia3BudgetExactUnderProfiles(unittest.TestCase):
    """P2-T23: the proxy drives ``Limit`` from the resolved budget directly.

    Fail-first design: explicit budget B=3.0 with a tight clock
    (``time_remaining=10s``). The OLD proxy re-samples the profile under that
    clock (proxy-side ``safe_cap=2.0s``: classical collapses to its 2s bucket,
    blitz to 1-2s -- at the startpos both land <= 2.0s after the ~1.16x
    complexity factor and jitter) and takes ``min(sampled, B)``, so the
    engine sees ~2s instead of B: the double-discount the plan measured as
    3.23 -> 1.05. A raw classical sample (2s floor, ~9-35s typical) can never
    equal a sub-second B either, so ``Limit(time=B)`` under BOTH profiles --
    plus zero proxy-side samples -- is observed exactly only when the proxy
    stops rolling its own dice. Profile shaping lives in
    ``manager.resolve_budget`` alone; the clamp stays.
    """

    EXACT_BUDGET = 3.0
    TIGHT_CLOCK = 10.0

    def _play_with_spied_resample(self, profile):
        from aether_chess.engines import maia3_proxy as proxy_mod
        from aether_chess.think_profile import sample_think_time as orig_sample

        proxy = Maia3Proxy()
        engine = HonestEngine()
        proxy._ensure_engine = lambda req: engine  # type: ignore[method-assign]
        bot = Maia3Bot(proxy=proxy)
        try:
            # create=True: fixed code drops the proxy-side import, so the
            # attribute is ABSENT (patch creates + removes a placeholder the
            # proxy never calls -> count 0). Old code HAS it (wraps delegates
            # to the real sampler -> count 1, and the seen_limits assert
            # below already failed first). Either way the count is meaningful.
            with mock.patch.object(
                proxy_mod,
                "sample_think_time",
                wraps=orig_sample,
                create=True,
            ) as spy:
                request = MoveRequest(
                    fen=START,
                    time_limit_sec=self.EXACT_BUDGET,
                    think_profile=profile,
                    time_remaining=self.TIGHT_CLOCK,
                )
                t0 = time.perf_counter()
                move = bot.play(request)
                elapsed = time.perf_counter() - t0
        finally:
            bot.close()
        return move, engine, elapsed, spy

    def test_resolved_budget_reaches_limit_exactly_under_both_profiles(self):
        for profile in ("blitz", "classical"):
            with self.subTest(think_profile=profile):
                move, engine, elapsed, spy = self._play_with_spied_resample(
                    profile
                )
                self.assertIsNotNone(move.uci, "move must still return")
                self.assertEqual(len(engine.seen_limits), 1)
                self.assertAlmostEqual(
                    engine.seen_limits[0],
                    self.EXACT_BUDGET,
                    delta=0.05,
                    msg=(
                        f"[{profile}] engine saw limit "
                        f"{engine.seen_limits[0]!r}, not caller budget "
                        f"{self.EXACT_BUDGET}: the proxy's second roll "
                        f"min()d the budget"
                    ),
                )
                self.assertGreaterEqual(
                    elapsed,
                    self.EXACT_BUDGET - 0.15,
                    f"[{profile}] elapsed {elapsed:.2f}s under budget "
                    f"{self.EXACT_BUDGET}s: proxy cut thinking short",
                )
                self.assertLessEqual(
                    elapsed,
                    self.EXACT_BUDGET + TOLERANCE,
                    f"[{profile}] elapsed {elapsed:.2f}s blew past budget "
                    f"{self.EXACT_BUDGET}s + {TOLERANCE}s",
                )
                self.assertEqual(
                    spy.call_count,
                    0,
                    f"[{profile}] proxy re-sampled the profile "
                    f"{spy.call_count}x; shaping lives in resolve_budget alone",
                )


class TestMaia3PingBound(unittest.TestCase):
    def test_hung_ping_is_bounded_and_executor_survives(self):
        proxy = Maia3Proxy(ping_timeout=0.3)
        before = threading.active_count()
        t0 = time.perf_counter()
        with self.assertRaises(TimeoutError):
            proxy._ping_with_timeout(HangingEngine())  # type: ignore[attr-defined]
        elapsed = time.perf_counter() - t0
        self.assertLess(
            elapsed, 2.0, f"hung ping took {elapsed:.2f}s: the timeout did not bound it"
        )
        # The persistent executor must be usable after a timeout (recreated,
        # not left shut down): a healthy ping succeeds on the same proxy.
        proxy._ping_with_timeout(HonestEngine())  # type: ignore[attr-defined]
        after = threading.active_count()
        self.assertLessEqual(
            after - before, 2, f"thread leak: {before} -> {after} across ping retries"
        )
        proxy.close()


if __name__ == "__main__":
    unittest.main()
