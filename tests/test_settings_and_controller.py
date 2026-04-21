import unittest
from unittest.mock import patch

import chess

from aether_chess.engines.controller import EngineController
from aether_chess.models.settings import EngineType, GameMode, GameSettings


class SettingsAndControllerTests(unittest.TestCase):
    def test_game_mode_cycle(self):
        s = GameSettings()
        self.assertEqual(GameMode.HUMAN_VS_AI, s.game_mode)
        s.cycle_mode()
        self.assertEqual(GameMode.HUMAN_VS_HUMAN, s.game_mode)
        s.cycle_mode()
        self.assertEqual(GameMode.AI_VS_AI, s.game_mode)

    def test_human_turn_logic(self):
        board = chess.Board()
        s = GameSettings(game_mode=GameMode.HUMAN_VS_AI, human_color=chess.BLACK)
        self.assertFalse(s.is_human_turn(board))
        board.push(chess.Move.from_uci("e2e4"))
        self.assertTrue(s.is_human_turn(board))

    def test_strength_mapping_updates_mentor_config(self):
        settings = GameSettings(ai_strength=2)
        controller = EngineController(settings)
        low_depth = controller.mentor_engine.config.max_depth
        settings.bump_strength(6)
        controller.apply_settings(settings)
        self.assertGreaterEqual(controller.mentor_engine.config.max_depth, low_depth)
        self.assertGreater(controller.mentor_engine.config.max_nodes, 30_000)

    def test_choose_move_uses_opening_before_engine(self):
        board = chess.Board()
        settings = GameSettings(engine_type=EngineType.MENTOR, opening_books=["dummy"])
        controller = EngineController(settings)
        with patch.object(controller, "_opening_move", return_value=chess.Move.from_uci("e2e4")), patch.object(
            controller.mentor_engine, "search", return_value=chess.Move.from_uci("d2d4")
        ):
            move = controller.choose_move(board)
        self.assertEqual(chess.Move.from_uci("e2e4"), move)


if __name__ == "__main__":
    unittest.main()
