import unittest

import chess

from aether_chess.engines.mentor_engine import MentorEngine, SearchConfig


class MentorEngineTests(unittest.TestCase):
    def test_selects_legal_move(self):
        board = chess.Board()
        engine = MentorEngine(SearchConfig(max_depth=2, max_nodes=10_000, time_limit_sec=0.5))
        move = engine.search(board)
        self.assertIn(move, board.legal_moves)


if __name__ == "__main__":
    unittest.main()
