"""MentorEngine as a bot: the built-in engine, in-process, no binary.

This is the default bot. It is fast and always available, which is its
strength, and shallow, which is its weakness. Both facts are declared in its
capabilities so a caller can reason about them.
"""

from __future__ import annotations

from typing import Optional

from aether_chess.bots.base import (
    Bot,
    BotCapabilities,
    BotMove,
    BotUnavailableError,
    MoveRequest,
    clamp_time_limit,
    normalize_move,
    normalize_score,
)
from aether_chess.engines.mentor_engine import MentorEngine
from aether_chess.engines.mentor_profile import mentor_search_config

MENTOR_BOT_ID = "mentor"


class MentorBot(Bot):
    """Wraps MentorEngine behind the bot standard."""

    def __init__(self, bot_id: str = MENTOR_BOT_ID) -> None:
        self._bot_id = bot_id
        self._engine: Optional[MentorEngine] = None
        self._configured_strength: Optional[int] = None

    @property
    def capabilities(self) -> BotCapabilities:
        return BotCapabilities(
            bot_id=self._bot_id,
            display_name="Mentor",
            kind="builtin",
            requires_binary=False,
            supports_skill_level=True,
            supports_eval=True,
            supports_depth=True,
            deterministic=True,
            description="Instant in-process search. Always available, but shallow.",
        )

    def _ensure_engine(self, strength: int) -> MentorEngine:
        # Reuse the engine across moves so its transposition table survives,
        # but rebuild when the strength changes since that alters the config.
        if self._engine is None or self._configured_strength != strength:
            self._engine = MentorEngine()
            self._configured_strength = strength
        return self._engine

    def play(self, request: MoveRequest) -> BotMove:
        import time

        board = request.board()
        time_limit = clamp_time_limit(request.time_limit_sec)
        engine = self._ensure_engine(request.strength_level())
        engine.config = mentor_search_config(request.strength_level(), time_limit)

        started = time.time()
        try:
            move = engine.search(board)
        except (
            Exception
        ) as exc:  # noqa: BLE001 - a search failure is a capability failure
            raise BotUnavailableError(f"Mentor search failed: {exc}") from exc
        elapsed = time.time() - started

        if move is None:
            raise BotUnavailableError(
                "Mentor returned no move (checkmate or stalemate?)"
            )

        normalized = normalize_move(
            move, bot_id=self._bot_id, board=board, elapsed_sec=elapsed
        )
        # Report a score in the same unit the UCI bots use, so the standard
        # fields are populated for every bot. This is Mentor's static
        # evaluation rather than a search score, and depth stays None because
        # Mentor does not report the depth it actually reached.
        try:
            (
                normalized.eval_cp,
                normalized.is_mate,
                normalized.mate_in,
            ) = normalize_score(engine.evaluate(board), board.turn)
        except Exception:  # noqa: BLE001 - a score is optional, the move is not
            pass
        return normalized

    def close(self) -> None:
        self._engine = None
        self._configured_strength = None
