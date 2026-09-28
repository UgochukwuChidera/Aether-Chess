"""Stockfish as a bot: any discovered UCI binary, any version.

Stockfish is not special-cased here. The same class drives SF18, SF19 or any
other engine the registry finds, because from the standard's point of view a
Stockfish build *is* a bot whose implementation happens to be a subprocess
speaking UCI. The version only changes what the engine reports about itself,
which the registry already resolved.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import chess
import chess.engine

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
from aether_chess.engines.registry import resolve_engine_path


class StockfishBot(Bot):
    """Wraps a discovered Stockfish binary behind the bot standard."""

    def __init__(
        self,
        bot_id: str = "stockfish",
        display_name: str = "Stockfish",
        configured_path: Optional[str] = None,
    ) -> None:
        self._bot_id = bot_id
        self._display_name = display_name
        self._configured_path = configured_path
        self._engine: Optional[chess.engine.SimpleEngine] = None
        self._active_path: Optional[str] = None

    @property
    def capabilities(self) -> BotCapabilities:
        return BotCapabilities(
            bot_id=self._bot_id,
            display_name=self._display_name,
            kind="uci",
            requires_binary=True,
            supports_skill_level=True,
            supports_eval=True,
            supports_depth=True,
            deterministic=True,
            description="Deepest search of the available bots; limited by engine speed.",
        )

    def resolved_path(self, override: Optional[str] = None) -> Optional[str]:
        """The binary this bot will actually launch, if any.

        A request may override the configured path, so a caller pointing at one
        specific build gets exactly that build rather than the newest one found.
        """
        candidate = override if override else self._configured_path
        try:
            return resolve_engine_path(candidate)
        except Exception:  # noqa: BLE001 - availability must never raise
            return None

    def is_available(self, override: Optional[str] = None) -> bool:
        return self.resolved_path(override) is not None

    def _ensure_engine(self, path: str) -> chess.engine.SimpleEngine:
        if self._engine is not None and path == self._active_path:
            return self._engine
        self.close()
        try:
            self._engine = chess.engine.SimpleEngine.popen_uci(path)
        except Exception as exc:  # noqa: BLE001 - surfaced as a capability failure
            raise BotUnavailableError(
                f"Could not start Stockfish at {path}: {exc}"
            ) from exc
        self._active_path = path
        return self._engine

    @staticmethod
    def _build_options(request: MoveRequest) -> Dict[str, Any]:
        options: Dict[str, Any] = {}
        level = request.strength_level()
        if request.option("apply_skill_level", True):
            # Stockfish's own Skill Level is 0-20; map our 1-10 onto it so the
            # cross-bot strength scale means the same thing for every bot.
            options["Skill Level"] = max(0, min(20, level * 2))
        threads = request.option("threads")
        if threads:
            options["Threads"] = max(1, int(threads))
        hash_mb = request.option("hash_mb")
        if hash_mb:
            options["Hash"] = max(16, int(hash_mb))
        return options

    def play(self, request: MoveRequest) -> BotMove:
        path = self.resolved_path(request.option("engine_path"))
        if path is None:
            raise BotUnavailableError(
                "No Stockfish binary found. Set an engine path in Settings, or install one on PATH."
            )
        board = request.board()
        time_limit = clamp_time_limit(request.time_limit_sec)

        engine = self._ensure_engine(path)
        options = self._build_options(request)
        if options:
            try:
                engine.configure(options)
            except Exception:  # noqa: BLE001 - option support varies by build
                pass

        started = time.time()
        try:
            # INFO_ALL is required: SimpleEngine.play defaults to INFO_NONE,
            # which collects no info at all, so the standard score and depth
            # fields would silently stay empty without it.
            #
            # depth is a cap alongside the time budget, not a replacement for
            # it, so a weak-strength setting finishes quickly without needing a
            # separate code path.
            limit = chess.engine.Limit(time=time_limit, depth=request.depth)
            result = engine.play(board, limit, info=chess.engine.INFO_ALL)
        except Exception as exc:  # noqa: BLE001 - a dead binary is a capability failure
            self.close()
            raise BotUnavailableError(f"Stockfish search failed: {exc}") from exc
        elapsed = time.time() - started

        if result is None or result.move is None:
            raise BotUnavailableError(
                "Stockfish returned no move (checkmate or stalemate?)"
            )

        # Populate the standard score fields from the search info so a UCI bot
        # is as informative as the in-process engines.
        info = result.info or {}
        move = normalize_move(
            result.move, bot_id=self._bot_id, board=board, elapsed_sec=elapsed
        )
        move.eval_cp, move.is_mate, move.mate_in = normalize_score(
            info.get("score"), board.turn
        )
        depth = info.get("depth")
        if isinstance(depth, (int, float)) and not isinstance(depth, bool):
            move.depth = int(depth)
        return move

    def close(self) -> None:
        if self._engine is not None:
            try:
                self._engine.quit()
            except Exception:  # noqa: BLE001 - shutdown must not raise
                pass
            self._engine = None
            self._active_path = None


def build_stockfish_bots() -> List[StockfishBot]:
    """One bot per discovered Stockfish build, newest first.

    Each discovered version becomes its own bot id (``stockfish-19``) so the
    UI can offer them as peers, exactly as the user asked: SF18 and SF19 are
    selectable alternatives, not a special case.
    """
    from aether_chess.engines.registry import discover_engines

    bots: List[StockfishBot] = []
    try:
        candidates = discover_engines()
    except Exception:  # noqa: BLE001 - discovery failure means no UCI bots
        return bots
    for candidate in candidates:
        version = candidate.version_label
        bot_id = (
            "stockfish" if not version else f"stockfish-{version.replace('.', '-')}"
        )
        bots.append(
            StockfishBot(
                bot_id=bot_id,
                display_name=f"Stockfish {version}".strip(),
                configured_path=candidate.path,
            )
        )
    return bots
