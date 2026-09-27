import time
import unittest
from unittest.mock import patch

import chess

from aether_chess.engines.mentor_engine import MATE_SCORE, MentorEngine, SearchConfig


class MentorEngineTests(unittest.TestCase):
    def test_selects_legal_move(self):
        board = chess.Board()
        engine = MentorEngine(
            SearchConfig(max_depth=2, max_nodes=10_000, time_limit_sec=0.5)
        )
        move = engine.search(board)
        self.assertIn(move, board.legal_moves)

    def test_checkmate_eval_is_losing_for_side_to_move(self):
        board = chess.Board()
        for uci in ("f2f3", "e7e5", "g2g4", "d8h4"):
            board.push(chess.Move.from_uci(uci))
        self.assertTrue(board.is_checkmate())
        engine = MentorEngine(
            SearchConfig(max_depth=1, max_nodes=1_000, time_limit_sec=0.1)
        )
        self.assertLess(engine.evaluate(board), -MATE_SCORE + 1000)

    def test_search_does_not_hang(self):
        board = chess.Board()
        engine = MentorEngine(
            SearchConfig(max_depth=3, max_nodes=100_000, time_limit_sec=0.2)
        )
        start = time.time()
        move = engine.search(board)
        elapsed = time.time() - start
        self.assertIn(move, board.legal_moves)
        self.assertLess(elapsed, 1.0)

    def test_depth_zero_calls_quiescence(self):
        board = chess.Board()
        engine = MentorEngine(
            SearchConfig(max_depth=1, max_nodes=10_000, time_limit_sec=10**12)
        )
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
        """A rook on its own 7th must be an advantage for its own colour.

        This previously asserted only that 7th scored higher than a neutral
        rank, which passed on 1 centipawn of piece-square interpolation noise
        while the bonus was actually being awarded on the wrong rank.
        """
        engine = MentorEngine()

        def black_rook_on(rank: int) -> int:
            # Black rook on a<rank>; a2 is black's own 7th, a7 is white's.
            squares = ["8"] * 8
            squares[8 - rank] = "r7"
            squares[0] = "k3K3" if rank != 1 else "K3k3"
            return engine.evaluate(chess.Board("/".join(squares) + " b - - 0 1"))

        neutral = black_rook_on(5)
        own_seventh = black_rook_on(2) - neutral
        white_seventh = black_rook_on(7) - neutral

        self.assertGreaterEqual(
            own_seventh, 50, "black rook on its own 7th must get the bonus"
        )
        self.assertLess(
            white_seventh, 50, "bonus must not leak onto white's 7th for black"
        )

    def test_white_rook_7th_rank_bonus(self):
        """The white side of the same rule, which was already correct."""
        engine = MentorEngine()

        def white_rook_on(rank: int) -> int:
            squares = ["8"] * 8
            squares[8 - rank] = "R7"
            squares[7] = "4K3" if rank != 8 else "4K2k"
            return engine.evaluate(chess.Board("/".join(squares) + " w - - 0 1"))

        neutral = white_rook_on(5)
        self.assertGreaterEqual(
            white_rook_on(7) - neutral, 50, "white rook on its own 7th"
        )
        self.assertLess(
            white_rook_on(2) - neutral,
            50,
            "bonus must not leak onto black's 7th for white",
        )


if __name__ == "__main__":
    unittest.main()
