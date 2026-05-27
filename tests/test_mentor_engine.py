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

    def test_pawn_endgame_pst_advancement(self):
        engine = MentorEngine()
        # White Pawn on A2
        board_a2 = chess.Board("8/8/8/8/8/8/P7/k3K3 w - - 0 1")
        # White Pawn on A7
        board_a7 = chess.Board("8/P7/8/8/8/8/8/k3K3 w - - 0 1")
        
        eval_a2 = engine.evaluate(board_a2)
        eval_a7 = engine.evaluate(board_a7)
        
        self.assertGreater(eval_a7, eval_a2)

    def test_black_rook_7th_rank_bonus(self):
        engine = MentorEngine()
        # Black Rook on A2 (7th rank for black, rank_idx == 1)
        board_rook_7th = chess.Board("k3K3/8/8/8/8/8/r7/8 b - - 0 1")
        # Black Rook on A5 (normal rank, rank_idx == 4)
        board_rook_normal = chess.Board("k3K3/8/8/8/r7/8/8/8 b - - 0 1")
        
        eval_7th = engine.evaluate(board_rook_7th)
        eval_normal = engine.evaluate(board_rook_normal)
        
        self.assertGreater(eval_7th, eval_normal)


if __name__ == "__main__":
    unittest.main()

