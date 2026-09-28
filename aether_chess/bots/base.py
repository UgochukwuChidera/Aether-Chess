"""The bot standard: one interface, one value shape, many implementations.

Every engine in this project is a bot. Stockfish is a bot. MentorEngine is a
bot. Maia3 is a bot. They differ only in *how* they pick a move, and that
difference is precisely what makes each one stronger or weaker at something:
Stockfish is deep but slow, MentorEngine is instant but shallow, Maia3 plays
like a human of a given rating. None of that is a reason for them to have
different interfaces.

Before this module each bot grew its own return dict. Stockfish and Maia3
returned ``{"move", "san"}``; Mentor returned ``{"move", "san", "from_book"}``
on one path, ``{"move", "san"}`` on another and ``{"move": None, "san": None}``
on a third. Callers had to know which bot had run in order to read the result.

So the standard has two halves:

*Interface alignment* -- every bot implements :class:`Bot`: a ``bot_id``, a
capability record, an availability check, ``play(request) -> BotMove``, and
``close()``. Callers depend on that and nothing else.

*Value alignment* -- :func:`normalize_move` coerces whatever a bot produced
into one :class:`BotMove`, so units and types never vary: ``uci`` is a UCI
string or ``None``, ``san`` is SAN or ``None``, ``eval_cp`` is an integer in
centipawns from the side to move, ``depth`` is an int, times are float
seconds. A search budget is resolved once by the manager and handed to
whichever bot plays, so swapping bots does not silently change how much time
each is given.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import chess

# Hard ceilings. A bot must never be told to search longer than this, whatever
# the clock or profile says, or a single move can stall the game loop.
MIN_TIME_LIMIT_SEC = 0.01
MAX_TIME_LIMIT_SEC = 5.0


class BotUnavailableError(RuntimeError):
    """A bot cannot run right now (no binary, no model, not installed)."""


@dataclass(frozen=True)
class BotCapabilities:
    """What a bot can do, so callers can degrade instead of crashing.

    This is the honest description of a bot's trade-offs. ``deterministic`` is
    false for Maia3, which samples from a distribution. ``requires_binary`` is
    true for Stockfish. ``supports_eval`` is false for Maia3, which returns no
    score. A caller that needs a score can therefore skip bots that cannot
    supply one, rather than discovering it at runtime.
    """

    bot_id: str
    display_name: str
    kind: str  # "uci" for a subprocess, "builtin" for in-process
    requires_binary: bool = False
    supports_skill_level: bool = False
    supports_elo: bool = False
    supports_eval: bool = False
    supports_depth: bool = False
    deterministic: bool = True
    description: str = ""


@dataclass
class MoveRequest:
    """A normalized request. Every bot receives exactly this.

    ``time_limit_sec`` is the aligned budget. When it is ``None`` the manager
    resolves it from ``think_profile`` and the clock fields, and then passes
    the same resolved value to whichever bot plays, so bots are comparable.
    Per-bot knobs (skill level, model name, threads) go in ``options`` rather
    than becoming new named parameters here.
    """

    fen: str
    time_limit_sec: Optional[float] = None
    time_remaining: Optional[float] = None
    time_increment: Optional[float] = None
    total_moves: Optional[int] = None
    strength: int = 7
    think_profile: str = "human_like"
    depth: Optional[int] = None
    options: Dict[str, Any] = field(default_factory=dict)

    def board(self) -> chess.Board:
        return chess.Board(self.fen)

    def option(self, key: str, default: Any = None) -> Any:
        return self.options.get(key, default)

    def strength_level(self) -> int:
        """Strength as a 1-10 level, clamped. The cross-bot strength scale."""
        return max(1, min(10, int(self.strength)))


@dataclass
class BotMove:
    """The single standard result shape. Every bot returns one of these."""

    uci: Optional[str]
    san: Optional[str]
    bot_id: str
    from_book: bool = False
    eval_cp: Optional[int] = None
    depth: Optional[int] = None
    elapsed_sec: Optional[float] = None
    ponder: Optional[str] = None
    note: Optional[str] = None
    is_mate: bool = False
    mate_in: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        """The one wire form sent to the renderer.

        Keys are always present with the same types, so the frontend never
        branches on which bot answered. ``move``/``san`` are ``None`` when the
        bot could not produce a legal move, which the UI already handles.
        A forced mate is reported as ``is_mate``/``mate_in`` rather than being
        folded into ``eval_cp``, because a mate has no centipawn value and
        inventing one would make bots disagree about the same position.
        """
        return {
            "move": self.uci,
            "san": self.san,
            "from_book": self.from_book,
            "bot_id": self.bot_id,
            "eval_cp": self.eval_cp,
            "depth": self.depth,
            "elapsed_sec": self.elapsed_sec,
            "ponder": self.ponder,
            "is_mate": self.is_mate,
            "mate_in": self.mate_in,
        }


class Bot(abc.ABC):
    """The interface every engine implements. Add a bot by implementing this."""

    @property
    @abc.abstractmethod
    def capabilities(self) -> BotCapabilities:
        """Static description of this bot."""

    def is_available(self) -> bool:
        """Whether :meth:`play` can succeed right now. Must not raise."""
        return True

    @abc.abstractmethod
    def play(self, request: MoveRequest) -> BotMove:
        """Return a move for ``request``. Raise BotUnavailableError if it cannot."""

    def close(self) -> None:  # noqa: B027 - optional hook, not abstract on purpose
        """Release any subprocess or model. Safe to call more than once.

        Intentionally concrete and empty: a bot that holds no resources should
        not have to implement this just to satisfy the interface.
        """


def clamp_time_limit(seconds: Any, ceiling: float = MAX_TIME_LIMIT_SEC) -> float:
    """Clamp a search budget into a usable range.

    This is part of value alignment: a bot must never be handed a negative,
    zero or unbounded budget, whichever side computed it. A ``None`` budget
    means "no explicit limit" and resolves to the ceiling.

    The parameter is ``Any`` on purpose. This is a boundary sanitizer: budgets
    arrive from JSON settings and request params, so a value can be a string or
    ``None`` even though the intended type is a float.
    """
    if seconds is None:
        return ceiling
    try:
        value = float(seconds)
    except (TypeError, ValueError):
        return MIN_TIME_LIMIT_SEC
    if value != value:  # NaN
        return MIN_TIME_LIMIT_SEC
    return max(MIN_TIME_LIMIT_SEC, min(value, ceiling))


def normalize_score(
    value: Any, turn: Optional[chess.Color] = None
) -> tuple[Optional[int], bool, Optional[int]]:
    """Normalize any engine score to (centipawns, is_mate, mate_in).

    Returns centipawns from the point of view of ``turn`` (the side to move),
    which is the scale every bot is aligned to. A forced mate has no
    centipawn value, so it is reported as ``is_mate``/``mate_in`` instead of
    being squashed into a huge number that would not mean the same thing to
    each bot.

    Accepts plain ints/floats, python-chess ``Cp``/``Mate`` scores, and
    ``PovScore``. Note ``Cp`` and ``Mate`` are not ``int`` subclasses in
    python-chess, so an ``isinstance(value, int)`` check alone would silently
    drop every real engine score.
    """
    from chess.engine import Cp, Mate, PovScore

    if value is None or isinstance(value, bool):
        return None, False, None

    # A PovScore is reported from one side's perspective; .pov(turn) converts
    # it to the requested side, which is exactly the alignment we need and
    # gets the mate sign right too.
    if isinstance(value, PovScore):
        value = value.pov(turn) if turn is not None else value.relative

    if isinstance(value, Mate):
        return None, True, int(value.moves)

    if isinstance(value, Cp):
        # Cp wraps the int but is not an int subclass, so read .cp off it.
        return int(value.cp), False, None

    if isinstance(value, (int, float)):
        return int(round(value)), False, None

    return None, False, None


def normalize_move(
    raw: Any,
    *,
    bot_id: str,
    board: Optional[chess.Board] = None,
    from_book: bool = False,
    elapsed_sec: Optional[float] = None,
    note: Optional[str] = None,
) -> BotMove:
    """Coerce anything a bot returned into the one standard :class:`BotMove`.

    Accepts a :class:`BotMove` (returned as-is), a move object, a UCI string,
    or a legacy dict in any of the shapes this project has used. SAN is derived
    from the board when the bot did not supply it, so ``san`` is never ``None``
    for a legal move.
    """
    if isinstance(raw, BotMove):
        return raw

    uci: Optional[str] = None
    san: Optional[str] = None
    eval_cp: Optional[int] = None
    is_mate = False
    mate_in: Optional[int] = None
    depth: Optional[int] = None
    ponder: Optional[str] = None

    if isinstance(raw, chess.Move):
        uci = raw.uci()
    elif isinstance(raw, str):
        uci = raw
    elif isinstance(raw, dict):
        uci = raw.get("move") or raw.get("uci") or None
        san = raw.get("san") or None
        ponder = raw.get("ponder") or None
        from_book = bool(raw.get("from_book", from_book))
        note = raw.get("note") or note
        if raw.get("is_mate"):
            is_mate = True
            mate_in = raw.get("mate_in")
        # Accept both the standard eval_cp and the legacy score key.
        raw_score = raw.get("eval_cp", raw.get("score"))
        if raw_score is not None:
            eval_cp, score_is_mate, mate_in = normalize_score(
                raw_score, board.turn if board else None
            )
            is_mate = is_mate or score_is_mate
        depth_raw = raw.get("depth")
        if isinstance(depth_raw, (int, float)) and not isinstance(depth_raw, bool):
            depth = int(depth_raw)

    # Derive SAN when the bot did not supply it, so san is never None for a
    # legal move regardless of which bot produced it.
    if uci and san is None and board is not None:
        try:
            san = board.san(chess.Move.from_uci(uci))
        except (ValueError, AssertionError):
            san = None

    if uci is not None and not isinstance(uci, str):
        uci = str(uci)

    return BotMove(
        uci=uci,
        san=san,
        bot_id=bot_id,
        from_book=from_book,
        eval_cp=eval_cp,
        depth=depth,
        elapsed_sec=elapsed_sec,
        ponder=ponder,
        note=note,
        is_mate=is_mate,
        mate_in=mate_in,
    )
