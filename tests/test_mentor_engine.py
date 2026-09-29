import time
import unittest
from unittest.mock import patch

import chess

from aether_chess.engines.mentor_engine import (
    BISHOP_TABLE,
    KING_END_TABLE,
    KNIGHT_TABLE,
    MATE_SCORE,
    PAWN_TABLE,
    QUEEN_TABLE,
    ROOK_TABLE,
    MentorEngine,
    SearchConfig,
)


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

    def test_endgame_pst_per_piece_type(self):
        """P2-T11: each non-king piece's eg term must use its own PST.

        Fix shape (decided by reading _eval_numba): the file has NO
        per-piece endgame tables — only pst_king_end exists beside the five
        middlegame tables. So the fix selects each non-king piece's own
        table for its eg term; kings keep pst_king_end.

        Each probe board holds one extra white piece plus rank-mirrored
        cancellers (Bc1/Bc8, or Nf1/Ng8) whose mg+eg cancel exactly, and
        symmetric kings (g1/g8) whose king-table terms cancel. Expected is
        therefore V + OWN_TABLE[sq] (+ one documented exact extra).
        Pre-fix the eg term uses KING_END_TABLE and every case fails.
        """
        engine = MentorEngine()
        # (fen, own_table, probe_square, material, non_king_pieces, extra)
        cases = [
            ("2b3k1/8/8/8/4P3/8/8/2B3K1 w - - 0 1", PAWN_TABLE, chess.E4, 100, 3, -15),
            ("2b3k1/8/8/8/4N3/8/8/2B3K1 w - - 0 1", KNIGHT_TABLE, chess.E4, 350, 3, 0),
            ("5nk1/8/8/8/3B4/8/8/5NK1 w - - 0 1", BISHOP_TABLE, chess.D4, 350, 3, 0),
            ("2b3k1/8/8/8/4R3/8/8/2B3K1 w - - 0 1", ROOK_TABLE, chess.E4, 550, 3, 70),
            ("2b3k1/8/8/8/4Q3/8/8/2B3K1 w - - 0 1", QUEEN_TABLE, chess.E4, 950, 3, 0),
        ]
        # Extras, each exact: pawn -15 (lone pawn is isolated, no doublers);
        # rook +70 (open file, zero pawns on board, rank 4 so no 7th bonus);
        # knight/bishop/queen 0 (no pawn/rook extras apply; single bishops
        # dodge the pair bonus; kings on g1/g8 net the queen-shelter to
        # +25/-25 = 0; the queen stands unattacked so safety/hanging add 0).
        for fen, table, sq, material, n_pieces, extra in cases:
            with self.subTest(fen=fen):
                # Guard against the test going vacuous if tables are retuned:
                # the probe square must discriminate own-table from king-end.
                self.assertNotEqual(
                    table[sq],
                    KING_END_TABLE[sq],
                    "probe square must differ between own table and king end table",
                )
                mg = material + table[sq]
                eg = material + table[sq]  # fixed behaviour under test
                phase = 256 - n_pieces * 16
                expected = (mg * (256 - phase) + eg * phase) // 256 + extra
                self.assertEqual(expected, engine.evaluate(chess.Board(fen)))

    def test_eval_antisymmetric_under_colour_flip(self):
        """P2-T11: a colour flip (same side to move) must negate the eval.

        Bound, not exact equality: the phase blend ends in `// 256`, and
        (-X) // 256 is either -(X // 256) or one less, so |a + b| <= 1
        always holds for a genuinely symmetric eval. Anything larger is a
        real defect. (The mg/eg terms, pawn/rook/bishop extras, shelter and
        queen safety/hanging all negate exactly under colour+rank flip.)
        """
        engine = MentorEngine()
        fens = [
            "2b3k1/8/8/8/4P3/8/8/2B3K1 w - - 0 1",
            "2b3k1/8/8/8/4N3/8/8/2B3K1 w - - 0 1",
            "5nk1/8/8/8/3B4/8/8/5NK1 w - - 0 1",
            "2b3k1/8/8/8/4R3/8/8/2B3K1 w - - 0 1",
            "2b3k1/8/8/8/4Q3/8/8/2B3K1 w - - 0 1",
            "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
        ]
        for fen in fens:
            with self.subTest(fen=fen):
                board = chess.Board(fen)
                flipped = board.mirror()
                flipped.turn = board.turn  # mirror() flips turn; hold it constant
                total = engine.evaluate(board) + engine.evaluate(flipped)
                self.assertLessEqual(abs(total), 1, f"colour-flip asymmetry {total}")


if __name__ == "__main__":
    unittest.main()
