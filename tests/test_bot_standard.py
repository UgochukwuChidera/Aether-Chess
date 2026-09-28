"""Tests for the bot standard: one interface, one value shape.

The point of these tests is the promise that makes bots interchangeable: a
caller that knows only :class:`Bot` can add a new bot, switch between bots, and
read the result, without special-casing anything. Anything that drifts between
implementations is exactly the bug this module exists to prevent.
"""

import sys
import unittest
from pathlib import Path

import chess
import chess.engine

from aether_chess.bots import (
    AUTO_BOT_ID,
    Bot,
    BotManager,
    BotMove,
    BotUnavailableError,
    Maia3Bot,
    MentorBot,
    MoveRequest,
    StockfishBot,
    clamp_time_limit,
    normalize_move,
)
from aether_chess.bots.base import normalize_score
from backend.chess_engine import ChessEngineManager

START = chess.STARTING_FEN


class FakeBot(Bot):
    """A minimal third-party bot, as an outside author would write one."""

    def __init__(self, bot_id="fake", *, available=True, move="e2e4", raises=None):
        self._bot_id = bot_id
        self._available = available
        self._move = move
        self._raises = raises
        self.seen_requests = []

    @property
    def capabilities(self):
        from aether_chess.bots import BotCapabilities

        return BotCapabilities(
            bot_id=self._bot_id,
            display_name=self._bot_id.title(),
            kind="builtin",
            description="test double",
        )

    def is_available(self):
        return self._available

    def play(self, request):
        self.seen_requests.append(request)
        if self._raises is not None:
            raise self._raises
        return normalize_move(
            self._move, bot_id=self._bot_id, board=request.board(), elapsed_sec=0.01
        )


class TestInterface(unittest.TestCase):
    def test_every_bot_implements_the_same_methods(self):
        """The contract is the same for a built-in, a UCI bot and a newcomer."""
        for bot in (MentorBot(), Maia3Bot(), StockfishBot(), FakeBot()):
            for method in ("play", "close", "is_available"):
                self.assertTrue(
                    callable(getattr(bot, method)),
                    f"{type(bot).__name__} is missing {method}()",
                )
            # capabilities is a property that yields a BotCapabilities record.
            caps = bot.capabilities
            self.assertEqual(caps.bot_id, bot.capabilities.bot_id)
            self.assertIn(caps.kind, ("uci", "builtin"))

    def test_mentor_is_builtin_and_always_available(self):
        bot = MentorBot()
        caps = bot.capabilities
        self.assertEqual(caps.bot_id, "mentor")
        self.assertEqual(caps.kind, "builtin")
        self.assertFalse(caps.requires_binary)
        self.assertTrue(bot.is_available())

    def test_capabilities_declare_maia3_is_sampled_and_scoreless(self):
        caps = Maia3Bot().capabilities
        self.assertFalse(caps.deterministic)
        self.assertFalse(caps.supports_eval)
        self.assertTrue(caps.supports_elo)

    def test_capabilities_declare_stockfish_needs_a_binary(self):
        caps = StockfishBot().capabilities
        self.assertEqual(caps.kind, "uci")
        self.assertTrue(caps.requires_binary)
        self.assertTrue(caps.supports_eval)

    def test_a_bot_can_be_added_without_touching_anything_else(self):
        manager = BotManager()
        manager.register(MentorBot())
        manager.register(FakeBot("third-party"))

        self.assertIn("third-party", manager.ids())
        self.assertIn("third-party", [d["bot_id"] for d in manager.describe()])
        move = manager.play(MoveRequest(fen=START), "third-party")
        self.assertEqual(move.bot_id, "third-party")
        self.assertEqual(move.uci, "e2e4")


class TestValueAlignment(unittest.TestCase):
    def test_all_bots_return_identical_keys(self):
        manager = BotManager()
        manager.register(FakeBot("a"))
        manager.register(FakeBot("b"))
        manager.register(FakeBot("c"))

        shapes = set()
        for bot_id in ("a", "b", "c"):
            shapes.add(
                tuple(sorted(manager.play(MoveRequest(fen=START), bot_id).to_dict()))
            )
        self.assertEqual(len(shapes), 1, "bots returned different result shapes")

    def test_result_types_are_consistent_across_bots(self):
        manager = BotManager()
        manager.register(FakeBot("a"))
        manager.register(FakeBot("b"))
        populated = [
            {
                k: type(v)
                for k, v in manager.play(MoveRequest(fen=START), b).to_dict().items()
                if v is not None
            }
            for b in ("a", "b")
        ]
        self.assertEqual(populated[0], populated[1])

    def test_standard_result_has_every_key_present(self):
        result = BotMove(uci=None, san=None, bot_id="x").to_dict()
        for key in (
            "move",
            "san",
            "from_book",
            "bot_id",
            "eval_cp",
            "depth",
            "elapsed_sec",
            "ponder",
            "is_mate",
            "mate_in",
        ):
            self.assertIn(key, result)

    def test_mentor_and_stockfish_agree_on_shape(self):
        """The two real bots must produce the same keys as a fake bot."""
        manager = BotManager()
        manager.register(MentorBot())
        manager.register(FakeBot("reference"))
        request = MoveRequest(fen=START, time_limit_sec=0.2)
        mentor = manager.play(request, "mentor").to_dict()
        reference = manager.play(request, "reference").to_dict()
        self.assertEqual(sorted(mentor), sorted(reference))
        self.assertIsInstance(mentor["bot_id"], str)
        self.assertIsInstance(mentor["from_book"], bool)

    def test_same_budget_is_given_to_every_bot(self):
        """Swapping bots must not silently change how long each may think."""
        manager = BotManager()
        fast = FakeBot("fast")
        slow = FakeBot("slow")
        manager.register(fast)
        manager.register(slow)
        request = MoveRequest(fen=START, time_remaining=60.0, time_increment=0.1)
        manager.play(request, "fast")
        manager.play(request, "slow")
        self.assertEqual(
            fast.seen_requests[0].time_limit_sec, slow.seen_requests[0].time_limit_sec
        )

    def test_explicit_time_limit_overrides_the_profile(self):
        manager = BotManager()
        bot = FakeBot()
        manager.register(bot)
        manager.play(MoveRequest(fen=START, time_limit_sec=1.25), "fake")
        self.assertEqual(bot.seen_requests[0].time_limit_sec, 1.25)


class TestNormalization(unittest.TestCase):
    def test_normalizes_a_chess_move(self):
        board = chess.Board()
        move = chess.Move.from_uci("e2e4")
        result = normalize_move(move, bot_id="b", board=board)
        self.assertEqual(result.uci, "e2e4")
        self.assertEqual(result.san, "e4")

    def test_normalizes_a_uci_string(self):
        result = normalize_move("g1f3", bot_id="b", board=chess.Board())
        self.assertEqual(result.san, "Nf3")

    def test_normalizes_legacy_dict_shapes(self):
        """The three historical shapes must all collapse to the same result."""
        board = chess.Board()
        for raw in (
            {"move": "e2e4", "san": "e4"},
            {"move": "e2e4", "san": "e4", "from_book": True},
            {"move": "e2e4"},
        ):
            result = normalize_move(raw, bot_id="b", board=board)
            self.assertEqual(result.uci, "e2e4")
            self.assertEqual(result.san, "e4")

    def test_legacy_book_flag_is_preserved(self):
        result = normalize_move(
            {"move": "e2e4", "san": "e4", "from_book": True},
            bot_id="b",
            board=chess.Board(),
        )
        self.assertTrue(result.from_book)

    def test_bot_move_passes_through_unchanged(self):
        original = BotMove(uci="e2e4", san="e4", bot_id="b")
        self.assertIs(normalize_move(original, bot_id="other"), original)

    def test_missing_move_is_none_not_an_exception(self):
        result = normalize_move(
            {"move": None, "san": None}, bot_id="b", board=chess.Board()
        )
        self.assertIsNone(result.uci)
        self.assertIsNone(result.san)

    def test_unparseable_move_yields_no_san(self):
        result = normalize_move("zzzz", bot_id="b", board=chess.Board())
        self.assertEqual(result.uci, "zzzz")
        self.assertIsNone(result.san)

    def test_none_input_is_safe(self):
        result = normalize_move(None, bot_id="b", board=chess.Board())
        self.assertIsNone(result.uci)


class TestScoreNormalization(unittest.TestCase):
    def test_centipawns_pass_through(self):
        cp, is_mate, mate_in = normalize_score(35, chess.WHITE)
        self.assertEqual((cp, is_mate, mate_in), (35, False, None))

    def test_chess_engine_cp_is_read(self):
        cp, is_mate, _ = normalize_score(chess.engine.Cp(-45), chess.WHITE)
        self.assertEqual(cp, -45)
        self.assertFalse(is_mate)

    def test_mate_is_reported_separately_from_centipawns(self):
        _, is_mate, mate_in = normalize_score(chess.engine.Mate(3), chess.WHITE)
        self.assertTrue(is_mate)
        self.assertEqual(mate_in, 3)

    def test_povscore_uses_the_side_to_move(self):
        score = chess.engine.PovScore(chess.engine.Cp(50), chess.WHITE)
        cp, _, _ = normalize_score(score, chess.WHITE)
        self.assertEqual(cp, 50)

    def test_povscore_for_the_other_side_is_negated(self):
        score = chess.engine.PovScore(chess.engine.Cp(50), chess.WHITE)
        cp, _, _ = normalize_score(score, chess.BLACK)
        self.assertEqual(cp, -50, "score must be from the side to move")

    def test_povscore_mate_distance_sign_follows_side_to_move(self):
        score = chess.engine.PovScore(chess.engine.Mate(3), chess.WHITE)
        _, is_mate, mate_in = normalize_score(score, chess.BLACK)
        self.assertTrue(is_mate)
        self.assertEqual(mate_in, -3)

    def test_none_and_bool_are_not_scores(self):
        self.assertEqual(normalize_score(None), (None, False, None))
        self.assertEqual(normalize_score(True), (None, False, None))

    def test_legacy_score_key_is_accepted_in_a_dict(self):
        result = normalize_move(
            {"move": "e2e4", "score": chess.engine.Cp(12)},
            bot_id="b",
            board=chess.Board(),
        )
        self.assertEqual(result.eval_cp, 12)


class TestClampTimeLimit(unittest.TestCase):
    def test_normal_value_is_untouched(self):
        self.assertEqual(clamp_time_limit(1.5), 1.5)

    def test_none_becomes_the_ceiling(self):
        from aether_chess.bots.base import MAX_TIME_LIMIT_SEC

        self.assertEqual(clamp_time_limit(None), MAX_TIME_LIMIT_SEC)

    def test_zero_and_negative_are_raised_to_the_floor(self):
        from aether_chess.bots.base import MIN_TIME_LIMIT_SEC

        self.assertEqual(clamp_time_limit(0), MIN_TIME_LIMIT_SEC)
        self.assertEqual(clamp_time_limit(-5), MIN_TIME_LIMIT_SEC)

    def test_nan_is_handled(self):
        from aether_chess.bots.base import MIN_TIME_LIMIT_SEC

        self.assertEqual(clamp_time_limit(float("nan")), MIN_TIME_LIMIT_SEC)

    def test_huge_value_is_capped(self):
        from aether_chess.bots.base import MAX_TIME_LIMIT_SEC

        self.assertEqual(clamp_time_limit(10_000), MAX_TIME_LIMIT_SEC)

    def test_non_numeric_is_handled(self):
        from aether_chess.bots.base import MIN_TIME_LIMIT_SEC

        self.assertEqual(clamp_time_limit("nope"), MIN_TIME_LIMIT_SEC)


class TestManagerResolution(unittest.TestCase):
    def setUp(self):
        self.manager = BotManager()
        self.manager.register(MentorBot())
        self.manager.register(FakeBot("stockfish-99", move="d2d4"))
        self.manager.register(FakeBot("stockfish-98", move="c2c4"))
        self.manager.register(FakeBot("dead", available=False))

    def test_versioned_bots_rank_under_their_base_slot(self):
        """A discovered build must not rank below the built-in default."""
        self.assertEqual(self.manager.ids()[:2], ["stockfish-99", "stockfish-98"])

    def test_newest_build_wins_ties(self):
        self.assertEqual(self.manager.resolve_bot_id(AUTO_BOT_ID), "stockfish-99")

    def test_unavailable_bots_are_not_listed_as_available(self):
        self.assertNotIn("dead", self.manager.available_bots())

    def test_auto_picks_an_available_bot(self):
        self.assertIn(
            self.manager.resolve_bot_id(AUTO_BOT_ID), self.manager.available_bots()
        )

    def test_default_is_used_when_no_id_is_given(self):
        self.assertEqual(self.manager.default_bot_id, "mentor")
        move = self.manager.play(MoveRequest(fen=START))
        self.assertEqual(move.bot_id, "mentor")

    def test_duplicate_registration_is_rejected(self):
        with self.assertRaises(ValueError):
            self.manager.register(FakeBot("stockfish-99"))

    def test_replace_allows_re_registration(self):
        replacement = FakeBot("stockfish-99", move="g1f3")
        self.manager.register(replacement, replace=True)
        self.assertEqual(
            self.manager.play(MoveRequest(fen=START), "stockfish-99").uci, "g1f3"
        )

    def test_describe_marks_the_default(self):
        described = {d["bot_id"]: d for d in self.manager.describe()}
        self.assertTrue(described["mentor"]["is_default"])
        self.assertFalse(described["stockfish-99"]["is_default"])
        self.assertFalse(described["dead"]["available"])


class TestFallback(unittest.TestCase):
    """The configured fallback is used, and it is the only fallback.

    A bot reporting itself unavailable is not used at all, and the chain does
    not walk the rest of the priority list. Substituting a different engine of
    the same family for one the user specifically asked for would hide a broken
    path behind a working answer.
    """

    def _manager(self, *bots, fallback="calm"):
        manager = BotManager(fallback_bot_id=fallback)
        for bot in bots:
            manager.register(bot)
        return manager

    def test_falls_back_when_the_bot_is_unavailable(self):
        manager = self._manager(FakeBot("broken", available=False), FakeBot("calm"))
        move = manager.play(MoveRequest(fen=START), "broken")
        self.assertEqual(move.bot_id, "calm")
        self.assertEqual(move.uci, "e2e4")

    def test_fallback_is_recorded_in_the_note(self):
        manager = self._manager(FakeBot("broken", available=False), FakeBot("calm"))
        move = manager.play(MoveRequest(fen=START), "broken")
        self.assertIn("broken", move.note or "")

    def test_an_unavailable_requested_bot_is_not_used(self):
        """is_available() is honoured even for the bot that was requested."""
        manager = self._manager(FakeBot("liar", available=False), FakeBot("calm"))
        self.assertEqual(manager.play(MoveRequest(fen=START), "liar").bot_id, "calm")

    def test_another_engine_of_the_same_family_is_not_substituted(self):
        """A broken specific build must not quietly become a different build."""
        manager = self._manager(
            FakeBot("stockfish-19", available=False),
            FakeBot("stockfish-18", move="d2d4"),
            FakeBot("calm", move="g1f3"),
            fallback="calm",
        )
        self.assertEqual(
            manager.play(MoveRequest(fen=START), "stockfish-19").bot_id, "calm"
        )

    def test_falls_back_when_the_bot_raises(self):
        manager = self._manager(
            FakeBot("angry", raises=BotUnavailableError("no model")), FakeBot("calm")
        )
        self.assertEqual(manager.play(MoveRequest(fen=START), "angry").bot_id, "calm")

    def test_unexpected_exceptions_do_not_escape(self):
        manager = self._manager(
            FakeBot("crash", raises=ValueError("boom")), FakeBot("calm")
        )
        self.assertEqual(manager.play(MoveRequest(fen=START), "crash").bot_id, "calm")

    def test_no_usable_bot_raises_a_clear_error(self):
        manager = self._manager(
            FakeBot("only", available=False, raises=BotUnavailableError("x"))
        )
        with self.assertRaises(BotUnavailableError):
            manager.play(MoveRequest(fen=START), "only")

    def test_result_shape_is_identical_after_a_fallback(self):
        manager = self._manager(FakeBot("broken", available=False), FakeBot("calm"))
        fallback = manager.play(MoveRequest(fen=START), "broken").to_dict()
        direct = manager.play(MoveRequest(fen=START), "calm").to_dict()
        self.assertEqual(sorted(fallback), sorted(direct))

    def test_availability_probe_never_raises(self):
        class Exploding(FakeBot):
            def is_available(self):
                raise RuntimeError("probe blew up")

        manager = self._manager(Exploding("exploding"), FakeBot("calm"))
        self.assertNotIn("exploding", manager.available_bots())
        self.assertEqual(
            manager.play(MoveRequest(fen=START), "exploding").bot_id, "calm"
        )

    def test_auto_may_take_any_available_bot(self):
        """For auto the point is to take the best available, so no fixed fallback."""
        manager = BotManager(fallback_bot_id="calm")
        manager.register(FakeBot("strong", move="d2d4"))
        manager.register(FakeBot("strongest", move="c2c4"))
        manager.register(FakeBot("calm", move="g1f3"))
        move = manager.play(MoveRequest(fen=START), AUTO_BOT_ID)
        self.assertIn(move.bot_id, ("strong", "strongest"))
        self.assertNotEqual(move.bot_id, "calm")


class TestRequest(unittest.TestCase):
    def test_strength_is_clamped_to_the_shared_scale(self):
        self.assertEqual(MoveRequest(fen=START, strength=0).strength_level(), 1)
        self.assertEqual(MoveRequest(fen=START, strength=99).strength_level(), 10)
        self.assertEqual(MoveRequest(fen=START, strength=7).strength_level(), 7)

    def test_board_is_parsed_from_the_fen(self):
        self.assertEqual(MoveRequest(fen=START).board().turn, chess.WHITE)

    def test_options_are_read_with_a_default(self):
        request = MoveRequest(fen=START, options={"elo": 900})
        self.assertEqual(request.option("elo"), 900)
        self.assertEqual(request.option("missing", "fallback"), "fallback")

    def test_close_is_safe_to_call_repeatedly(self):
        manager = BotManager()
        manager.register(MentorBot())
        manager.close()
        manager.close()


class TestBackendContract(unittest.TestCase):
    """The backend surface the renderer depends on.

    The renderer picks a bot by id from ``list_bots`` and then asks for a move
    with that same id, so the list and the move path have to agree, and the
    "no bot" answer has to keep the standard shape.
    """

    def setUp(self):
        self.mgr = ChessEngineManager()
        self.addCleanup(self.mgr.close)

    def test_list_bots_exposes_the_built_ins(self):
        ids = {bot["bot_id"] for bot in self.mgr.list_bots()}
        self.assertIn("mentor", ids)
        self.assertIn("stockfish", ids)
        self.assertIn("maia3", ids)

    #: The keys every answer carries, whatever bot replied.
    STANDARD_KEYS = (
        "move",
        "san",
        "from_book",
        "bot_id",
        "eval_cp",
        "depth",
        "elapsed_sec",
        "ponder",
        "is_mate",
        "mate_in",
    )

    def test_every_listed_bot_can_be_asked_for_by_its_own_id(self):
        for bot in self.mgr.list_bots():
            with self.subTest(bot=bot["bot_id"]):
                result = self.mgr.get_engine_move(
                    START, engine_type=bot["bot_id"], time_limit=0.05
                )
                missing = set(self.STANDARD_KEYS) - set(result)
                self.assertEqual(missing, set(), f"missing standard keys: {missing}")

    def test_a_direct_answer_carries_exactly_the_standard_keys(self):
        """Mentor is always available, so this is a move with no fallback note."""
        result = self.mgr.get_engine_move(
            START, engine_type="mentor", strength=5, time_limit=0.05
        )
        self.assertEqual(sorted(result), sorted(self.STANDARD_KEYS))

    def test_a_versioned_id_selects_that_exact_build(self):
        """A discovered build is selectable by its own id, not just by name."""
        manager = BotManager(fallback_bot_id="calm")
        manager.register(FakeBot("stockfish-19", move="d2d4"), replace=True)
        manager.register(FakeBot("stockfish-18", move="g1f3"), replace=True)
        manager.register(FakeBot("calm", move="e2e4"), replace=True)
        self.assertEqual(manager.resolve_bot_id("stockfish-19"), "stockfish-19")
        self.assertEqual(
            manager.play(MoveRequest(fen=START), "stockfish-19").uci, "d2d4"
        )
        self.assertEqual(
            manager.play(MoveRequest(fen=START), "stockfish-18").uci, "g1f3"
        )

    def test_unavailable_bot_still_returns_the_standard_shape(self):
        """Even "no bot at all" answers with the standard keys, not a stub dict."""
        empty = BotManager(fallback_bot_id="nope")
        empty.register(FakeBot("nope", available=False), replace=True)
        self.mgr._bot_manager = lambda: empty
        result = self.mgr.get_engine_move(START, engine_type="nope")
        for key in (
            "move",
            "san",
            "from_book",
            "bot_id",
            "eval_cp",
            "depth",
            "elapsed_sec",
            "ponder",
            "is_mate",
            "mate_in",
        ):
            self.assertIn(key, result)
        self.assertIsNone(result["move"])

    def test_the_rpc_handler_returns_the_bot_list(self):
        # service.py uses flat imports, so it is imported the way it is
        # launched: with backend/ on the path.
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
        self.addCleanup(lambda: sys.path.remove(str(Path(__file__).resolve().parents[1] / "backend")))
        # Loaded by path, not by package name, so the checker cannot see it.
        import service  # type: ignore[reportMissingImports]

        self.assertIn("list_bots", service.HANDLERS)
        payload = service.handle_list_bots({})
        self.assertIn("bots", payload)
        self.assertTrue(payload["bots"])
        for bot in payload["bots"]:
            self.assertIn("bot_id", bot)
            self.assertIn("available", bot)

    def test_get_engine_move_accepts_strength_and_total_moves(self):
        result = self.mgr.get_engine_move(
            START, engine_type="mentor", strength=5, total_moves=40, time_limit=0.05
        )
        self.assertIsNotNone(result["move"])


if __name__ == "__main__":
    unittest.main()
