"""The central manager every bot is accessed through.

Callers ask for a move by bot id and get back one normalized
:class:`~aether_chess.bots.base.BotMove`. They do not know whether the answer
came from a subprocess, from pure Python, or from a neural proxy, and they do
not branch on the shape of what they got back.

The manager is where *value* alignment happens, not just interface alignment.
The search budget is resolved exactly once per move from the think profile and
the clock, then handed unchanged to whichever bot plays. That is what makes two
bots comparable: if you switch from Stockfish to Mentor for the same position,
the only thing that changes is how the move is chosen, not how much time it was
allowed to think. Leaving budget resolution to each bot is exactly how bots end
up silently advantaged over one another.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, Iterable, List, Optional

from aether_chess.bots.base import (
    Bot,
    BotMove,
    BotUnavailableError,
    MoveRequest,
    clamp_time_limit,
)
from aether_chess.bots.maia3_bot import MAIA3_BOT_ID, Maia3Bot
from aether_chess.bots.mentor_bot import MENTOR_BOT_ID, MentorBot
from aether_chess.bots.stockfish_bot import StockfishBot, build_stockfish_bots

#: Asking for this id lets the manager choose the best available bot.
AUTO_BOT_ID = "auto"

#: Search order for ``auto`` and for fallback. Deep UCI search first because it
#: is the strongest, then the always-available built-in, then the sampled model.
DEFAULT_PRIORITY = ("stockfish", MENTOR_BOT_ID, MAIA3_BOT_ID)

class BotManager:
    """Registry, resolver and fallback chain for all bots."""

    def __init__(
        self,
        *,
        default_bot_id: str = MENTOR_BOT_ID,
        fallback_bot_id: str = MENTOR_BOT_ID,
        priority: Optional[Iterable[str]] = None,
    ) -> None:
        self._bots: Dict[str, Bot] = {}
        self._default_bot_id = default_bot_id
        self._fallback_bot_id = fallback_bot_id
        self._priority: List[str] = (
            list(priority) if priority else list(DEFAULT_PRIORITY)
        )

    # ── registration ────────────────────────────────────────────────────────

    def register(self, bot: Bot, *, replace: bool = False) -> None:
        """Add a bot. A new bot id needs no changes anywhere else."""
        bot_id = bot.capabilities.bot_id
        if bot_id in self._bots and not replace:
            raise ValueError(f"Bot id {bot_id!r} is already registered")
        self._bots[bot_id] = bot
        if bot_id not in self._priority:
            self._priority.append(bot_id)

    def register_default_bots(self, *, stockfish_path: Optional[str] = None) -> None:
        """Register the built-in bots plus one entry per discovered UCI build.

        Mentor is always present, because it needs no binary and no model, so
        there is always a bot that can move.
        """
        self.register(MentorBot(), replace=True)
        # The canonical "stockfish" bot. It resolves a binary per move and
        # honours a per-request path override, so it covers both auto-detection
        # and a specifically configured build without being a special case.
        self.register(StockfishBot(configured_path=stockfish_path), replace=True)
        for bot in build_stockfish_bots():
            # Discovered builds become peers with their own ids, so SF18 and
            # SF19 are selectable alternatives rather than one ambiguous entry.
            self.register(bot, replace=True)
        self.register(Maia3Bot(), replace=True)

    def get(self, bot_id: str) -> Optional[Bot]:
        return self._bots.get(bot_id)

    @property
    def default_bot_id(self) -> str:
        return self._default_bot_id

    def ids(self) -> List[str]:
        """All registered bot ids, in priority order."""
        return self._ordered_ids()

    def available_bots(self) -> List[str]:
        """Ids of bots that can play right now, in priority order."""
        return [bot_id for bot_id in self._ordered_ids() if self._is_available(bot_id)]

    def describe(self) -> List[Dict[str, Any]]:
        """Capability records for every bot, for the UI to render as a list."""
        described: List[Dict[str, Any]] = []
        for bot_id in self._ordered_ids():
            bot = self._bots[bot_id]
            caps = bot.capabilities
            described.append(
                {
                    "bot_id": caps.bot_id,
                    "display_name": caps.display_name,
                    "kind": caps.kind,
                    "description": caps.description,
                    "requires_binary": caps.requires_binary,
                    "supports_skill_level": caps.supports_skill_level,
                    "supports_elo": caps.supports_elo,
                    "supports_eval": caps.supports_eval,
                    "deterministic": caps.deterministic,
                    "available": self._is_available(bot_id),
                    "is_default": bot_id == self._default_bot_id,
                }
            )
        return described

    # ── resolution ──────────────────────────────────────────────────────────

    def _priority_rank(self, bot_id: str) -> int:
        """Where a bot id sits in the priority list.

        A priority entry also covers its versioned variants, so the ``stockfish``
        slot matches ``stockfish-19`` and ``stockfish-18``. Without this a
        discovered build would rank below the built-in default purely because
        its id carries a version, and ``auto`` would pick the weaker bot.
        """
        for index, entry in enumerate(self._priority):
            if bot_id == entry or bot_id.startswith(f"{entry}-"):
                return index
        return len(self._priority)

    def _ordered_ids(self) -> List[str]:
        """Priority order first, then anything registered outside it.

        Registration order breaks ties, which puts newer Stockfish builds
        ahead of older ones since discovery yields them newest-first.
        """
        return sorted(self._bots, key=self._priority_rank)

    def _is_available(self, bot_id: str) -> bool:
        bot = self._bots.get(bot_id)
        if bot is None:
            return False
        try:
            return bool(bot.is_available())
        except Exception:  # noqa: BLE001 - availability must never raise
            return False

    def resolve_bot_id(self, bot_id: Optional[str] = None) -> str:
        """Turn a requested id (or ``auto``/None) into a concrete bot id."""
        requested = bot_id or self._default_bot_id
        if requested != AUTO_BOT_ID:
            return requested
        available = self.available_bots()
        if available:
            return available[0]
        return self._default_bot_id

    def resolve_budget(self, request: MoveRequest) -> float:
        """Resolve the one aligned search budget for this move.

        Delegated to the think profile so every bot is given the same budget
        under the same clock. An explicit ``time_limit_sec`` on the request
        still wins, so callers and tests stay in control.
        """
        if request.time_limit_sec is not None:
            return clamp_time_limit(request.time_limit_sec)
        from aether_chess.think_profile import get_profile, sample_think_time

        # total_moves is the current ply, and the existing clock model assumes
        # a 40-ply game, so mirror that here rather than inventing a new
        # convention the two paths would disagree about.
        moves_left = None
        if request.total_moves is not None:
            try:
                moves_left = max(1, 40 - int(request.total_moves))
            except (TypeError, ValueError):
                moves_left = None
        sampled = sample_think_time(
            get_profile(request.think_profile),
            board=request.board(),
            time_remaining=request.time_remaining,
            time_increment=request.time_increment,
            moves_left_estimate=moves_left or 30,
        )
        return clamp_time_limit(sampled)

    # ── play ────────────────────────────────────────────────────────────────

    def play(self, request: MoveRequest, bot_id: Optional[str] = None) -> BotMove:
        """Return a normalized move, falling back when the requested bot cannot play.

        The returned move is always in the same shape regardless of which bot
        produced it. If a fallback happened, ``note`` records why.
        """
        requested = self.resolve_bot_id(bot_id)
        request.time_limit_sec = self.resolve_budget(request)

        was_auto = (bot_id or self._default_bot_id) == AUTO_BOT_ID
        chain = self._candidate_chain(requested, was_auto=was_auto)
        skipped = [b for b in (requested, *self._ordered_ids()) if b not in chain]
        tried: List[str] = []
        for candidate_id in chain:
            bot = self._bots.get(candidate_id)
            if bot is None:
                continue
            tried.append(candidate_id)
            try:
                move = bot.play(request)
            except BotUnavailableError as exc:
                print(
                    f"[bot-manager] {candidate_id} unavailable ({exc}); trying fallback",
                    file=sys.stderr,
                )
                continue
            except Exception as exc:  # noqa: BLE001 - never let one bot break the game
                print(
                    f"[bot-manager] {candidate_id} failed ({type(exc).__name__}: {exc}); "
                    "trying fallback",
                    file=sys.stderr,
                )
                continue
            if candidate_id != requested:
                parts = []
                if skipped:
                    parts.append(f"unavailable: {', '.join(skipped)}")
                if tried:
                    # tried lists ATTEMPTED ids, including the one that
                    # ultimately succeeded -- "tried", not "failed".
                    parts.append(f"tried: {', '.join(tried)}")
                detail = "; ".join(parts) or "no alternative available"
                move.note = f"fell back from {requested} ({detail})"
            return move

        raise BotUnavailableError(
            f"No bot could produce a move (requested {requested!r}, tried: {tried or 'none'})"
        )

    def _candidate_chain(self, requested: str, was_auto: bool = False) -> List[str]:
        """The bots to try, in order.

        For an explicit choice this is the requested bot and then the single
        configured fallback. It deliberately does not walk the whole priority
        list: silently substituting a different Stockfish build for one the user
        specifically configured would hide a broken engine path behind a working
        answer, which is exactly what the fallback flag exists to expose.

        ``auto`` is the exception, because there the point is to take the best
        available bot, so the full priority list is in play.
        """
        candidates = (
            self._ordered_ids() if was_auto else [requested, self._fallback_bot_id]
        )
        chain: List[str] = []
        for bot_id in candidates:
            if bot_id in chain or self._bots.get(bot_id) is None:
                continue
            if self._is_available(bot_id):
                chain.append(bot_id)
        return chain

    def close(self) -> None:
        for bot in list(self._bots.values()):
            try:
                bot.close()
            except Exception:  # noqa: BLE001 - shutdown must not raise
                pass
