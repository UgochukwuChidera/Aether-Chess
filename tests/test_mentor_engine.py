import unittest
import time
from unittest.mock import patch

import chess

from aether_chess.engines.mentor_engine import MATE_SCORE, MentorEngine, SearchConfig


class MentorEngineTests(unittest.TestCase):
    def test_selects_legal_move(self):
        board = chess.Board()
        engine = MentorEngine(SearchConfig(max_depth=2, max_nodes=10_000, time_limit_sec=0.5))
        move = engine.search(board)
        self.assertIn(move, board.legal_moves)

    def test_checkmate_eval_is_losing_for_side_to_move(self):
        board = chess.Board()
        for uci in ("f2f3", "e7e5", "g2g4", "d8h4"):
            board.push(chess.Move.from_uci(uci))
        self.assertTrue(board.is_checkmate())
        engine = MentorEngine(SearchConfig(max_depth=1, max_nodes=1_000, time_limit_sec=0.1))
        self.assertLess(engine.evaluate(board), -MATE_SCORE + 1000)

    def test_search_does_not_hang(self):
        board = chess.Board()
        engine = MentorEngine(SearchConfig(max_depth=3, max_nodes=100_000, time_limit_sec=0.2))
        start = time.time()
        move = engine.search(board)
        elapsed = time.time() - start
        self.assertIn(move, board.legal_moves)
        self.assertLess(elapsed, 1.0)

    def test_depth_zero_calls_quiescence(self):
        board = chess.Board()
        engine = MentorEngine(SearchConfig(max_depth=1, max_nodes=10_000, time_limit_sec=10**12))
        with patch.object(engine, "_quiescence", return_value=42) as mock_quiescence:
            value = engine._search(board, 0, -100, 100)
        self.assertEqual(42, value)
        mock_quiescence.assert_called_once_with(board, -100, 100)


if __name__ == "__main__":
    unittest.main()
