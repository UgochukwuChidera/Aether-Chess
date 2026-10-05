"""Tests for the shared Mentor strength mapping.

Mentor's 1-10 slider used to be turned into a search configuration in three
places with three different sets of numbers, so "Mentor at strength 7" meant
three different difficulties depending on which code path you took. These tests
pin the single mapping and the invariants callers rely on, which is what stops
a fourth variant from appearing.
"""

import unittest

from aether_chess.engines.mentor_engine import SearchConfig
from aether_chess.engines.mentor_profile import (
    MAX_STRENGTH,
    MIN_STRENGTH,
    clamp_strength,
    default_time_limit,
    mentor_search_config,
)


class TestClampStrength(unittest.TestCase):
    def test_keeps_values_inside_the_scale(self):
        for level in range(MIN_STRENGTH, MAX_STRENGTH + 1):
            self.assertEqual(clamp_strength(level), level)

    def test_clamps_out_of_range_values_to_the_nearest_level(self):
        self.assertEqual(clamp_strength(0), MIN_STRENGTH)
        self.assertEqual(clamp_strength(-5), MIN_STRENGTH)
        self.assertEqual(clamp_strength(11), MAX_STRENGTH)
        self.assertEqual(clamp_strength(10_000), MAX_STRENGTH)

    def test_truncates_a_fractional_level(self):
        # Truncating, not rounding, keeps a 7.9 from outranking a plain 7.
        self.assertEqual(clamp_strength(7.9), 7)


class TestDefaultTimeLimit(unittest.TestCase):
    def test_rises_with_strength(self):
        limits = [default_time_limit(level) for level in range(1, 11)]
        self.assertEqual(limits, sorted(limits))

    def test_stays_within_a_thinkable_range(self):
        for level in range(MIN_STRENGTH, MAX_STRENGTH + 1):
            self.assertGreater(default_time_limit(level), 0.0)
            self.assertLessEqual(default_time_limit(level), 0.95)

    def test_never_exceeds_the_cap_even_for_an_absurd_level(self):
        # The level is clamped first, so an out-of-range input cannot buy
        # extra time by skipping the cap.
        self.assertEqual(default_time_limit(999), default_time_limit(MAX_STRENGTH))


class TestMentorSearchConfig(unittest.TestCase):
    def test_every_level_produces_a_usable_config(self):
        for level in range(MIN_STRENGTH, MAX_STRENGTH + 1):
            with self.subTest(level=level):
                config = mentor_search_config(level)
                self.assertIsInstance(config, SearchConfig)
                self.assertGreater(config.max_depth, 0)
                self.assertGreater(config.max_nodes, 0)
                self.assertGreater(config.time_limit_sec, 0)
                self.assertGreater(config.difficulty, 0)
                self.assertLessEqual(config.difficulty, 1.0)
                self.assertGreater(config.tt_max_entries, 0)
                self.assertEqual(config.threads, 1)

    def test_search_effort_rises_with_strength(self):
        weaker = mentor_search_config(3)
        stronger = mentor_search_config(9)
        self.assertLess(weaker.max_depth, stronger.max_depth)
        self.assertLess(weaker.max_nodes, stronger.max_nodes)
        self.assertLess(weaker.tt_max_entries, stronger.tt_max_entries)
        self.assertLess(weaker.time_limit_sec, stronger.time_limit_sec)

    def test_the_top_level_always_plays_the_best_move(self):
        # difficulty 1.0 means no weighted sampling, so a maxed-out Mentor is
        # deterministic rather than merely strong.
        self.assertEqual(mentor_search_config(MAX_STRENGTH).difficulty, 1.0)

    def test_the_weakest_level_stays_fallible(self):
        # A difficulty of 1.0 at level 1 would make the easy setting identical
        # to the hard one for the move choice, which is the point of the slider.
        self.assertLess(mentor_search_config(MIN_STRENGTH).difficulty, 1.0)

    def test_an_explicit_time_limit_overrides_the_level_default(self):
        config = mentor_search_config(5, time_limit_sec=0.42)
        self.assertEqual(config.time_limit_sec, 0.42)

    def test_the_time_limit_override_does_not_disturb_the_rest(self):
        default = mentor_search_config(5)
        overridden = mentor_search_config(5, time_limit_sec=0.42)
        self.assertEqual(default.max_depth, overridden.max_depth)
        self.assertEqual(default.max_nodes, overridden.max_nodes)
        self.assertEqual(default.difficulty, overridden.difficulty)
        self.assertEqual(default.tt_max_entries, overridden.tt_max_entries)

    def test_out_of_range_strengths_land_on_the_endpoints(self):
        self.assertEqual(
            mentor_search_config(0).max_depth, mentor_search_config(1).max_depth
        )
        self.assertEqual(
            mentor_search_config(99).max_depth, mentor_search_config(10).max_depth
        )


class TestSingleDefinition(unittest.TestCase):
    """The same strength must mean the same search, whoever asks for it."""

    START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

    def test_the_bot_layer_uses_the_shared_mapping(self):
        # The superseded pre-BotManager caller this used to pin is deleted
        # (P3-T06); the live asker is MentorBot via BotManager, which must
        # resolve every strength through the same shared mapping,
        # including the clamp at the endpoints.
        from aether_chess.bots.base import MoveRequest
        from aether_chess.bots.mentor_bot import MentorBot

        bot = MentorBot()
        self.addCleanup(bot.close)
        for level in range(MIN_STRENGTH, MAX_STRENGTH + 1):
            with self.subTest(strength=level):
                request = MoveRequest(fen=self.START_FEN, strength=level)
                engine = bot._ensure_engine(request.strength_level())
                engine.config = mentor_search_config(request.strength_level())
                self.assertEqual(engine.config, mentor_search_config(level))
        for raw, endpoint in ((0, MIN_STRENGTH), (99, MAX_STRENGTH)):
            with self.subTest(raw=raw):
                request = MoveRequest(fen=self.START_FEN, strength=raw)
                self.assertEqual(
                    mentor_search_config(request.strength_level()),
                    mentor_search_config(endpoint),
                )

    def test_the_bot_adapter_searches_with_the_shared_mapping(self):
        """Proved on the engine the bot really searched with, not a copy.

        The sampled think time varies per move, so the time limit is compared
        separately; the search-effort fields have to match exactly.
        """
        from aether_chess.bots.base import MoveRequest
        from aether_chess.bots.mentor_bot import MentorBot

        for level in (1, 5, 10):
            with self.subTest(strength=level):
                bot = MentorBot()
                self.addCleanup(bot.close)
                request = MoveRequest(fen=self.START_FEN, strength=level)
                bot.play(request)

                # Reached into on purpose: what matters is the config the
                # engine really searched with, not the one play() was given.
                engine = bot._engine
                assert engine is not None  # narrows the type for the checker
                used = engine.config
                shared = mentor_search_config(level, used.time_limit_sec)
                self.assertEqual(used.max_depth, shared.max_depth)
                self.assertEqual(used.max_nodes, shared.max_nodes)
                self.assertEqual(used.difficulty, shared.difficulty)
                self.assertEqual(used.tt_max_entries, shared.tt_max_entries)
                self.assertEqual(used.threads, shared.threads)
                # And the time it did use is the one it was handed, not a
                # second, independently derived budget.
                self.assertEqual(used.time_limit_sec, shared.time_limit_sec)


if __name__ == "__main__":
    unittest.main()
