"""Maia3 as a bot: a neural proxy that plays like a human of a given rating.

Maia3 is the odd one out and that is the point of declaring capabilities
honestly. It is non-deterministic (it samples), it returns no score, and it
needs a downloaded model. A caller that needs an evaluation must therefore
skip it, which it can only know by asking.
"""

from __future__ import annotations

import time
from typing import Optional

from aether_chess.bots.base import (
    Bot,
    BotCapabilities,
    BotMove,
    BotUnavailableError,
    MoveRequest,
    clamp_time_limit,
    normalize_move,
)
from aether_chess.engines.maia3_proxy import Maia3Proxy, Maia3UnavailableError

MAIA3_BOT_ID = "maia3"


class Maia3Bot(Bot):
    """Wraps Maia3Proxy behind the bot standard."""

    def __init__(
        self, bot_id: str = MAIA3_BOT_ID, proxy: Optional[Maia3Proxy] = None
    ) -> None:
        self._bot_id = bot_id
        self._proxy = proxy or Maia3Proxy()

    @property
    def capabilities(self) -> BotCapabilities:
        return BotCapabilities(
            bot_id=self._bot_id,
            display_name="Maia3",
            kind="uci",
            requires_binary=False,  # needs a model, not a binary
            supports_elo=True,
            supports_eval=False,
            deterministic=False,
            description="Plays like a human of a chosen Elo. Sampled, and returns no score.",
        )

    def is_available(self) -> bool:
        try:
            return self._proxy.is_available()
        except Exception:  # noqa: BLE001 - availability must never raise
            return False

    def play(self, request: MoveRequest) -> BotMove:
        board = request.board()
        # The manager resolves one aligned budget per move; read it here like
        # every other bot (mentor_bot, stockfish_bot) so Maia3 is comparable
        # in timed play instead of silently advantaged.
        time_limit = clamp_time_limit(request.time_limit_sec)
        started = time.time()
        try:
            raw = self._proxy.play(
                fen=request.fen,
                model=request.option("model", "maia3-5m"),
                device=request.option("device", "cpu"),
                maia3_path=request.option("maia3_path"),
                cache_dir=request.option("cache_dir"),
                temperature=request.option("temperature"),
                top_p=request.option("top_p", 1.0),
                elo=request.option("elo", 1500),
                think_profile=request.think_profile,
                time_remaining=request.time_remaining,
                time_increment=request.time_increment,
                time_limit_sec=time_limit,
            )
        except Maia3UnavailableError as exc:
            raise BotUnavailableError(str(exc)) from exc
        except (
            Exception
        ) as exc:  # noqa: BLE001 - any proxy failure is a capability failure
            raise BotUnavailableError(f"Maia3 failed: {exc}") from exc
        elapsed = time.time() - started

        move = normalize_move(
            raw, bot_id=self._bot_id, board=board, elapsed_sec=elapsed
        )
        if move.uci is None:
            raise BotUnavailableError("Maia3 returned no move")
        return move

    def close(self) -> None:
        try:
            self._proxy.close()
        except Exception:  # noqa: BLE001 - shutdown must not raise
            pass
