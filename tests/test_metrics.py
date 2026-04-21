import unittest

from aether_chess.analysis.metrics import accuracy_from_losses, classify_move, cp_to_win_pct, estimate_bayesian_elo


class MetricsTests(unittest.TestCase):
    def test_cp_to_win_pct_monotonic(self):
        self.assertGreater(cp_to_win_pct(200), cp_to_win_pct(0))
        self.assertGreater(cp_to_win_pct(0), cp_to_win_pct(-200))

    def test_accuracy_bounds(self):
        self.assertEqual(100.0, accuracy_from_losses([]))
        val = accuracy_from_losses([10, 20, 30], expected_loss=100)
        self.assertTrue(0.0 <= val <= 100.0)

    def test_classification(self):
        self.assertEqual("Book", classify_move(500, is_book=True))
        self.assertEqual("Best", classify_move(10))
        self.assertEqual("Blunder", classify_move(180))

    def test_bayesian_elo(self):
        low = estimate_bayesian_elo([0.3, 0.35, 0.25])
        high = estimate_bayesian_elo([0.75, 0.7, 0.8])
        self.assertLess(low.rating, high.rating)


if __name__ == "__main__":
    unittest.main()
