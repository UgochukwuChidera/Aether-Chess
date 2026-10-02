import unittest

import chess

from aether_chess.models.game_state import GameState


class GameStateTests(unittest.TestCase):
    def test_push_and_fen_roundtrip(self):
        g = GameState()
        self.assertTrue(g.push_uci("e2e4"))
        self.assertTrue(g.push_uci("e7e5"))
        fen = g.to_fen()

        g2 = GameState()
        g2.load_fen(fen)
        self.assertEqual(g2.to_fen(), fen)

    def test_to_pgn_contains_moves(self):
        g = GameState()
        g.push(chess.Move.from_uci("d2d4"))
        g.push(chess.Move.from_uci("d7d5"))
        pgn = g.to_pgn()
        self.assertIn("1. d4 d5", pgn)

    def test_load_pgn_raises_on_illegal_move_with_game_identity(self):
        """P2-T19(f): a corrupt PGN must raise, naming the game — never load
        as a different legal game with no warning."""
        g = GameState()
        bad = '[Event "Club Night"]\n\n1. e4 e4 *\n'
        with self.assertRaisesRegex(ValueError, "Club Night"):
            g.load_pgn(bad)

    def test_load_pgn_raises_when_moves_fit_only_a_setup_fen(self):
        """Moves legal from the header FEN but not from startpos also raise:
        load_pgn replays from startpos (SetUp headers ignored)."""
        g = GameState()
        pgn = (
            '[Event "Midgame"]\n[SetUp "1"]\n'
            '[FEN "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1"]\n'
            "\n1. Bb5 *\n"
        )
        with self.assertRaisesRegex(ValueError, "Midgame"):
            g.load_pgn(pgn)

    def test_move_history_is_derived_from_the_board(self):
        """P2-T19(f): one-direction derivation — the board move stack is the
        single source of truth; move_history follows it through every path."""
        g = GameState()
        self.assertEqual(g.move_history, [])
        g.push_uci("e2e4")
        g.push_uci("e7e5")
        self.assertEqual(g.move_history, g.board.move_stack)
        g.pop()
        self.assertEqual(g.move_history, g.board.move_stack)
        g.load_fen(chess.STARTING_FEN)
        self.assertEqual(g.move_history, [])
        g.push_uci("d2d4")
        self.assertEqual([m.uci() for m in g.move_history], ["d2d4"])


if __name__ == "__main__":
    unittest.main()
