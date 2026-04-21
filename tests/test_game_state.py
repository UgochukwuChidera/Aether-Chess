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


if __name__ == "__main__":
    unittest.main()
