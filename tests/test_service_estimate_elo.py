"""P2-T19(e): num_games is an IPC-fed loop bound — clamp it, guard non-numeric.

`handle_estimate_elo` (backend/service.py) passes num_games straight into
`AccuracyAnalyser.estimate_elo`, which runs `for _ in range(estimated_games)`
(backend/analysis.py:246-250). A huge value is a CPU-DoS vector in the IPC
handler thread; a non-numeric value dies in a bare int() ValueError; negatives
are already neutralized by the `>= 1` guard in analysis.py (heuristic path).

Fail-first contract: the huge-clamp and garbage-message tests assert the FIXED
behaviour and FAIL on the pre-fix code (unclamped loop / "invalid literal"
message). The negative/zero test locks the already-correct heuristic fallback.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import service  # type: ignore[reportMissingImports]


def _elo(**kwargs):
    params = {"accuracy": 80.0, "blunder_rate": 0.05, "avg_cp_loss": 40.0}
    params.update(kwargs)
    return service.handle_estimate_elo(params)


class EstimateEloNumGamesTests(unittest.TestCase):
    def test_huge_num_games_is_clamped(self):
        result = _elo(num_games=1_000_000)
        self.assertLessEqual(result["games_simulated"], 100)
        self.assertEqual(result["games_simulated"], 100)

    def test_negative_and_zero_fall_back_to_heuristic(self):
        baseline = _elo()["games_simulated"]
        self.assertEqual(_elo(num_games=-5)["games_simulated"], baseline)
        self.assertEqual(_elo(num_games=0)["games_simulated"], baseline)

    def test_garbage_string_is_a_clean_error(self):
        with self.assertRaisesRegex(ValueError, "Invalid num_games"):
            _elo(num_games="garbage")

    def test_small_positive_passes_through(self):
        self.assertEqual(_elo(num_games=7)["games_simulated"], 7)


if __name__ == "__main__":
    unittest.main()
