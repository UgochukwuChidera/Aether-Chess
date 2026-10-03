"""P2-T24: classical think profile varies within the 5.0s ceiling.

Fail-first proof: raw classical samples average ~22s (buckets 2-120s peak
20s), so ``clamp_time_limit`` clips ~98% of manager-resolved budgets to
exactly 5.0 -- classical is 5.00s flat, zero variability, while blitz varies
(~1-5s). The ceiling stays (comparability); the bucket is rescaled so its
shaping lands ~2-5s and varies run to run.

Design notes: sampling is stochastic via the global ``random`` module (no
seed parameter), so every assertion below pins ``random.seed`` and restores
prior RNG state (save/restore, never bare reseeding -- unittest discover
runs all files in one process). Thresholds are picked with order-of-magnitude
margins: pre-fix N=100 gives 2-3 distinct resolved values with 98-99% parked
at the ceiling; post-fix gives ~65 distinct with ~1/3 at the ceiling.
"""

from __future__ import annotations

import random
import statistics
import unittest

import chess

from aether_chess.bots.base import MAX_TIME_LIMIT_SEC, MoveRequest
from aether_chess.bots.manager import BotManager
from aether_chess.think_profile import CLASSICAL, sample_think_time

SEED = 1234
N = 100
# Pre-fix: 2-3 distinct resolved values. Post-fix: dozens (continuous
# jitter over a 2-5s bucket spread). 20 sits an order of magnitude clear
# of both sides.
MIN_DISTINCT_RESOLVED = 20
# Pre-fix: 98-99% of resolved budgets park exactly on the ceiling.
# Post-fix: roughly a third (only the deep-thought tail clips).
MAX_FRACTION_AT_CEILING = 0.5


def _resolved_classical(n: int = N, seed: int = SEED) -> list[float]:
    """Manager-resolved classical budgets (the value every bot is handed)."""
    state = random.getstate()
    try:
        random.seed(seed)
        manager = BotManager()
        return [
            manager.resolve_budget(
                MoveRequest(fen=chess.STARTING_FEN, think_profile="classical")
            )
            for _ in range(n)
        ]
    finally:
        random.setstate(state)


def _raw_classical(n: int = N, seed: int = SEED) -> list[float]:
    """Raw classical samples before the ceiling clamp (bucket shaping)."""
    state = random.getstate()
    try:
        random.seed(seed)
        board = chess.Board()
        return [sample_think_time(CLASSICAL, board=board) for _ in range(n)]
    finally:
        random.setstate(state)


class TestClassicalVariesWithinCeiling(unittest.TestCase):
    def test_every_resolved_sample_within_ceiling(self):
        samples = _resolved_classical()
        for value in samples:
            self.assertLessEqual(
                value, MAX_TIME_LIMIT_SEC, f"classical budget {value!r} exceeds ceiling"
            )
            self.assertGreater(value, 0.0)

    def test_resolved_budgets_vary_run_to_run(self):
        samples = _resolved_classical()
        distinct = len(set(samples))
        self.assertGreaterEqual(
            distinct,
            MIN_DISTINCT_RESOLVED,
            f"only {distinct} distinct classical budgets in {N} samples: "
            "the ceiling is clipping every roll to a constant",
        )
        at_ceiling = sum(1 for v in samples if v == MAX_TIME_LIMIT_SEC)
        self.assertLessEqual(
            at_ceiling / len(samples),
            MAX_FRACTION_AT_CEILING,
            f"{at_ceiling}/{len(samples)} classical budgets parked on the "
            f"{MAX_TIME_LIMIT_SEC}s ceiling: no variability within budget",
        )
        self.assertGreaterEqual(
            max(samples) - min(samples),
            1.0,
            "classical resolved range spans "
            f"{max(samples) - min(samples):.2f}s: flat within budget",
        )

    def test_raw_shaping_lands_within_ceiling(self):
        raw = _raw_classical()
        median = statistics.median(raw)
        self.assertGreaterEqual(
            median, 2.0, f"raw classical median {median:.2f}s below the 2s floor"
        )
        self.assertLessEqual(
            median,
            MAX_TIME_LIMIT_SEC,
            f"raw classical median {median:.2f}s sits above the ceiling: "
            "shaping still lands 9-35s-clipped-to-5 instead of 2-5s",
        )


if __name__ == "__main__":
    unittest.main()
