"""
backend/chess_engine.py — Unified engine manager for Aether Chess.
Supports BOTH custom MentorEngine (pure Python AI) and UCI engines (Stockfish).
"""

from __future__ import annotations

import glob as globlib
import os
import random
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Optional

import chess
import chess.engine
import chess.pgn
import chess.polyglot

# Add parent directory to path so aether_chess modules can be imported
_HERE = os.path.dirname(__file__)
_ROOT = os.path.join(_HERE, "..")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# Point Hugging Face cache to a project-local directory instead of ~/.cache
_HF_CACHE = os.path.normpath(os.path.join(_ROOT, "model_cache"))
os.makedirs(_HF_CACHE, exist_ok=True)
os.environ.setdefault("HF_HOME", _HF_CACHE)
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from aether_chess.bots import (
    AUTO_BOT_ID,
    BotManager,
    BotMove,
    BotUnavailableError,
    MoveRequest,
)
from aether_chess.engines.maia3_proxy import Maia3Proxy
from aether_chess.engines.mentor_engine import MentorEngine
from aether_chess.engines.mentor_profile import mentor_search_config
from aether_chess.models.game_state import GameState


class ChessEngineManager:
    """Central game-state manager with single shared Stockfish instance."""

    def __init__(self) -> None:
        self.game_state = GameState()
        self._full_history: List[chess.Move] = []
        # Retained start position (P2-T09). Every replay helper must start
        # here, not at `chess.Board()`: a FEN-loaded game does not open
        # with White to move, so startpos replays mislabel each ply's mover
        # (and drop moves illegal from startpos). Standard startpos unless
        # `new_game(fen=...)` says otherwise; `import_pgn` resets it because
        # `load_pgn` replays from startpos.
        self._initial_fen: str = chess.STARTING_FEN
        # None == live position. Any int is a viewing window into
        # `_full_history` (P1-T05): -1 shows startpos, 0..len-1 a ply.
        # The IPC snapshot still emits -1 for live, so the renderer is
        # untouched — only this module sees None.
        self._nav_index: Optional[int] = None
        self.settings: Dict[str, Any] = {
            "mode": "human_vs_ai",
            "engine_type": "mentor",
            "human_color": "white",
            "strength": 7,
            "stockfish_path": "stockfish",
            "maia3_path": "",
            "maia3_model": "maia3-5m",
            "maia3_device": "cpu",
            "maia3_elo": 1500,
            "think_profile": "human_like",
            "threads": 1,
            "hash_mb": 128,
            "multipv": 3,
        }
        # P3-T01: backend-owned game clock (milliseconds). None == Unlimited:
        # no clock installed, no flag possible. The turn stamp is
        # `time.monotonic`, NOT wall clock — wall time jumps (NTP, DST, manual
        # changes) and would cause false flags or grant free time; monotonic
        # is guaranteed non-decreasing, which is all a countdown needs.
        self._white_ms: Optional[float] = None
        self._black_ms: Optional[float] = None
        self._increment_ms: float = 0
        self._clock_stamp: Optional[float] = None
        # Terminal latch set by flag-fall / resign / draw when the board
        # itself is not over. The snapshot prefers a board outcome, then this.
        self._terminal_result: Optional[str] = None
        self._terminal_termination: Optional[str] = None
        # Guards the clock scalars + terminal latch below. The service
        # serialises all IPC handlers under its own `_board_lock`, but the
        # tick-push thread reads/writes these fields outside it, so they get
        # their own lock. Never nested with any other lock: no lock order.
        self._clock_lock = threading.Lock()
        # Tick-push loop (P3-T01): forwards `_state_snapshot` at 1 Hz while a
        # clock runs so the renderer needs no client-side timer. Started by
        # the service on `new_game` with a live clock, never by unit tests.
        self._clock_push_fn: Optional[Callable[[Dict[str, Any]], None]] = None
        self._clock_push_thread: Optional[threading.Thread] = None
        self._clock_push_stop = threading.Event()
        self.board = self.game_state.board

        # Custom MentorEngine (pure Python chess AI - no Stockfish needed!)
        self._mentor_engine: Optional[MentorEngine] = None

        # Central bot manager. Every engine is reached through it, so the
        # move path no longer keeps its own Stockfish process.
        self._manager: Optional[BotManager] = None

        # Shared Analysis Engine (Stockfish)
        self._analysis_engine: Optional[chess.engine.SimpleEngine] = None
        self._analysis_engine_path: str = "stockfish"
        self._analysis_engine_lock = threading.Lock()

        self._maia3_proxy = Maia3Proxy()

        # Analysis thread control
        self._analysis_stop = threading.Event()
        self._analysis_thread: Optional[threading.Thread] = None

    def _get_mentor_engine(self, strength: int = 7) -> MentorEngine:
        """Get or create the custom MentorEngine with proper strength config."""
        if self._mentor_engine is None:
            self._mentor_engine = MentorEngine()

        # Same mapping the playing bot uses, so the Mentor behind the
        # evaluation bar is the Mentor the player is actually up against.
        self._mentor_engine.config = mentor_search_config(strength)
        return self._mentor_engine

    # ── Game lifecycle ─────────────────────────────────────────────────────────

    def new_game(
        self,
        mode: str = "human_vs_ai",
        engine_type: str = "stockfish",
        human_color: str = "white",
        strength: int = 7,
        time_control: Optional[Dict[str, int]] = None,
        stockfish_path: Optional[str] = None,
        maia3_path: Optional[str] = None,
        maia3_model: Optional[str] = None,
        maia3_device: Optional[str] = None,
        maia3_elo: Optional[int] = None,
        think_profile: Optional[str] = None,
        threads: Optional[int] = None,
        hash_mb: Optional[int] = None,
        multipv: Optional[int] = None,
        fen: Optional[str] = None,
    ) -> None:
        self.game_state.reset()
        self.board = self.game_state.board
        if fen is not None:
            # Raises ValueError on a bad FEN (same surface as import_pgn).
            self.game_state.load_fen(fen)
            self._initial_fen = self.game_state.to_fen()
        else:
            self._initial_fen = chess.STARTING_FEN
        self._full_history = []
        self._nav_index = None
        self.settings.update(
            mode=mode,
            engine_type=engine_type,
            human_color=human_color,
            strength=strength,
        )
        # P3-T01: `time_control` was stored-but-never-consumed (and the
        # renderer never sent it). It is now the clock authority: seconds<=0
        # or absent means Unlimited (clocks cleared, never re-armed stale).
        if time_control:
            self.settings["time_control"] = time_control
        else:
            self.settings.pop("time_control", None)
        self._install_clock(time_control)
        with self._clock_lock:
            self._terminal_result = None
            self._terminal_termination = None
        if stockfish_path:
            self.settings["stockfish_path"] = stockfish_path
        if maia3_path is not None:
            self.settings["maia3_path"] = maia3_path
        if maia3_model:
            self.settings["maia3_model"] = maia3_model
        if maia3_device:
            self.settings["maia3_device"] = maia3_device
        if maia3_elo is not None:
            self.settings["maia3_elo"] = max(0, min(5000, int(maia3_elo)))
        if think_profile is not None:
            self.settings["think_profile"] = think_profile
        if threads is not None:
            self.settings["threads"] = max(1, min(8, int(threads)))  # Cap at 8
        if hash_mb is not None:
            self.settings["hash_mb"] = max(16, min(512, int(hash_mb)))  # Cap at 512MB
        if multipv is not None:
            self.settings["multipv"] = max(1, min(5, int(multipv)))

    # ── Game clock (P3-T01: backend is the clock/termination authority) ──

    def _install_clock(self, time_control: Optional[Dict[str, Any]]) -> None:
        """(Re)arm the clock from a `new_game` time control.

        `{"seconds": N, "increment": I}` installs N seconds per side plus an
        I-second increment. Seconds <= 0 (or no control at all) is Unlimited:
        both clocks are cleared to None so no flag can ever latch.
        """
        seconds = 0
        increment = 0
        if time_control:
            try:
                seconds = int(time_control.get("seconds", 0))
            except (TypeError, ValueError):
                seconds = 0
            try:
                increment = int(time_control.get("increment", 0))
            except (TypeError, ValueError):
                increment = 0
        with self._clock_lock:
            if seconds <= 0:
                self._white_ms = None
                self._black_ms = None
                self._increment_ms = 0
                self._clock_stamp = None
                return
            self._white_ms = float(seconds * 1000)
            self._black_ms = float(seconds * 1000)
            self._increment_ms = float(max(0, increment) * 1000)
            self._clock_stamp = time.monotonic()

    def _live_ms(self) -> tuple[Optional[float], Optional[float]]:
        """Current remaining ms (white, black) with elapsed applied live.

        Pure read: the elapsed time is computed, never stored. Clamped at 0
        so the snapshot is never internally inconsistent. None pair when
        Unlimited.
        """
        with self._clock_lock:
            if self._white_ms is None or self._black_ms is None:
                return None, None
            white_ms, black_ms = self._white_ms, self._black_ms
            stamp, latched = self._clock_stamp, self._terminal_result
        if stamp is not None and latched is None:
            elapsed_ms = max(0.0, (time.monotonic() - stamp) * 1000)
            if self.board.turn == chess.WHITE:
                white_ms = max(0.0, white_ms - elapsed_ms)
            else:
                black_ms = max(0.0, black_ms - elapsed_ms)
        return white_ms, black_ms

    def _clock_snapshot(self) -> Optional[Dict[str, Any]]:
        """The `clock` object every snapshot carries (P3-T01 change 4).

        `{"white_ms", "black_ms", "increment_ms"}` as whole-millisecond ints
        with elapsed applied live and clamped at 0 — never inconsistent.
        None when Unlimited, so old producers (and the e2e fixture, which
        omits the key) mean "no clock" downstream without any fixture touch.
        """
        white_ms, black_ms = self._live_ms()
        if white_ms is None or black_ms is None:
            return None
        return {
            "white_ms": int(round(white_ms)),
            "black_ms": int(round(black_ms)),
            "increment_ms": int(self._increment_ms),
        }

    def _check_flag(self) -> None:
        """Latch a terminal result if the side to move has run out of time.

        Called at the top of every snapshot, so even a player who sits idle
        without moving is flagged by the next snapshot — the same snapshot
        the 1 Hz tick-push loop forwards. Idempotent: once latched (or when
        Unlimited) it is a no-op. The plan's "Flag falls" maps to the
        `TIME_FORFEIT` termination: the codebase vocabulary is SCREAMING
        (`CHECKMATE`, …, plus the custom `RESIGN`), and python-chess 1.11.2
        has no time member in its `Termination` enum, so a custom uppercase
        string is the consistent choice (the modal lowercases it for display).
        """
        with self._clock_lock:
            if (
                self._terminal_result is not None
                or self._white_ms is None
                or self._black_ms is None
                or self._clock_stamp is None
            ):
                return
            elapsed_ms = max(0.0, (time.monotonic() - self._clock_stamp) * 1000)
            white_to_move = self.board.turn == chess.WHITE
            mover_ms = self._white_ms if white_to_move else self._black_ms
            if mover_ms - elapsed_ms <= 0:
                if white_to_move:
                    self._white_ms = 0.0
                    self._terminal_result = "0-1"
                else:
                    self._black_ms = 0.0
                    self._terminal_result = "1-0"
                self._terminal_termination = "TIME_FORFEIT"
                self._clock_stamp = None

    def _debit_and_credit(self, mover_is_white: bool) -> None:
        """Debit the mover's elapsed thinking time, then add the increment.

        Debit happens before the move is applied; the increment after. A
        flag (debited value <= 0) latches the terminal result and skips the
        increment — a flagged player earns no bonus time.
        """
        with self._clock_lock:
            if self._white_ms is None or self._black_ms is None:
                return
            now = time.monotonic()
            if self._clock_stamp is not None:
                elapsed_ms = max(0.0, (now - self._clock_stamp) * 1000)
                if mover_is_white:
                    self._white_ms = max(0.0, self._white_ms - elapsed_ms)
                else:
                    self._black_ms = max(0.0, self._black_ms - elapsed_ms)
            if mover_is_white:
                remaining = self._white_ms
            else:
                remaining = self._black_ms
            if remaining <= 0:
                self._terminal_result = "0-1" if mover_is_white else "1-0"
                self._terminal_termination = "TIME_FORFEIT"
                self._clock_stamp = None
                return
            if mover_is_white:
                self._white_ms = remaining + self._increment_ms
            else:
                self._black_ms = remaining + self._increment_ms
            self._clock_stamp = now

    def _game_is_over(self) -> bool:
        return self.board.is_game_over() or self._terminal_result is not None

    def resign(self, side: str) -> tuple[bool, Dict[str, Any]]:
        """Record a resignation. `side` is the LOSING side.

        Mirrors the `make_move` return shape. Rejected when the game is
        already over — the backend stays the single termination authority.
        """
        if side not in ("white", "black"):
            return False, {"reason": f"Invalid resign side: {side!r}"}
        with self._clock_lock:
            if self._game_is_over():
                return False, {"reason": "Game is already over"}
            self._terminal_result = "0-1" if side == "white" else "1-0"
            # Matches the termination string the renderer already used for
            # local resigns, so the modal copy is unchanged by the move.
            self._terminal_termination = "RESIGN"
            self._clock_stamp = None
        return True, self._state_snapshot()

    def draw(self) -> tuple[bool, Dict[str, Any]]:
        """Record an agreed draw. Rejected when the game is already over."""
        with self._clock_lock:
            if self._game_is_over():
                return False, {"reason": "Game is already over"}
            self._terminal_result = "1/2-1/2"
            self._terminal_termination = "DRAW_AGREEMENT"
            self._clock_stamp = None
        return True, self._state_snapshot()

    def start_clock_push(
        self,
        push_fn: Callable[[Dict[str, Any]], None],
        interval_sec: float = 1.0,
    ) -> None:
        """Forward a `clock_tick` snapshot every `interval_sec` seconds.

        P3-T01 tick-source decision: PUSH, not poll. A renderer poll would
        need its own client-side timer — the very thing this item deletes —
        while the service already forwards id-less pushes (`analysis_update`)
        through main to the renderer, so a clock push reuses proven plumbing
        with no new channel shape. The tick carries a full snapshot (plus
        `type: clock_tick`) so the renderer applies it like any IPC result.
        Only one loop runs at a time; restarting replaces the previous one.
        """
        self.stop_clock_push()
        self._clock_push_fn = push_fn
        self._clock_push_stop.clear()

        def _run() -> None:
            while not self._clock_push_stop.wait(interval_sec):
                try:
                    snap = self._state_snapshot()
                except Exception:
                    continue
                snap["type"] = "clock_tick"
                try:
                    push_fn(snap)
                except Exception:
                    break
                if snap.get("game_over"):
                    # Terminal state delivered — no reason to tick forever.
                    break

        self._clock_push_thread = threading.Thread(target=_run, daemon=True)
        self._clock_push_thread.start()

    def stop_clock_push(self) -> None:
        self._clock_push_stop.set()
        self._clock_push_fn = None
        thread, self._clock_push_thread = self._clock_push_thread, None
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=3.0)

    # ── Move operations ───────────────────────────────────────────────────────

    def make_move(self, move_uci: str) -> tuple[bool, Dict[str, Any]]:
        """Push a UCI move. Returns (success, state_snapshot)."""
        if self._nav_index is not None:
            return False, {"reason": "Return to the live position before moving"}
        if self._terminal_result is not None:
            return False, {"reason": "Game is already over"}
        try:
            move = chess.Move.from_uci(move_uci)
        except ValueError:
            return False, {}

        # Promotion default: queen
        if (
            move.promotion is None
            and self.board.piece_type_at(move.from_square) == chess.PAWN
            and chess.square_rank(move.to_square) in (0, 7)
        ):
            move = chess.Move(move.from_square, move.to_square, promotion=chess.QUEEN)

        if move not in self.board.legal_moves:
            return False, {}

        mover_is_white = self.board.turn == chess.WHITE
        self._debit_and_credit(mover_is_white)
        san = self.board.san(move)
        self.game_state.push(move)
        self._full_history = list(self.board.move_stack)
        self._nav_index = None

        return True, self._state_snapshot(last_san=san)

    def undo_move(self) -> Dict[str, Any]:
        if self._nav_index is not None:
            self._restore_live_board()
        self.game_state.pop()
        self._full_history = list(self.board.move_stack)
        self._nav_index = None
        # Undo reopens a latched game (flag/resign/draw): the position is live
        # again. Time spent stays spent — only the latch clears — and the turn
        # clock restarts now so the side to move is not instantly re-flagged.
        with self._clock_lock:
            self._terminal_result = None
            self._terminal_termination = None
            if self._white_ms is not None and self._black_ms is not None:
                self._clock_stamp = time.monotonic()
        return self._state_snapshot()

    def _board_from_full_history(self) -> chess.Board:
        """Replay the authoritative history onto a fresh board.

        Same pattern as `history_fens_and_moves` and `move_history_san`:
        `_full_history` is the game, `board.move_stack` may be a truncated
        viewing window left behind by `navigate_to`.
        """
        board = chess.Board()
        for move in self._full_history:
            if move in board.legal_moves:
                board.push(move)
        return board

    def _restore_live_board(self) -> None:
        """Replay `_full_history` onto the shared board in place.

        The board is `game_state.board` by alias, so it is mutated, never
        rebound. Popping the truncated viewing board would snapshot the
        truncation into `_full_history` and discard the game tail.
        """
        live = self._board_from_full_history()
        self.board.reset()
        for move in live.move_stack:
            self.board.push(move)

    def navigate_to(self, index: int) -> Dict[str, Any]:
        """Navigate move history without modifying it.

        Navigating to the last ply (or past it) is the return-to-live
        transition: the board already shows the live FEN, and the
        position now counts as live, so the next move is accepted.
        Every UI go-to-end path (End, Last, arrow, click-last-move)
        lands here via `navigateToMove`.
        """
        moves = self._full_history
        target = max(-1, min(index, len(moves) - 1))
        self.board.reset()
        for m in moves[: target + 1]:
            self.board.push(m)
        if target >= len(moves) - 1:
            # At (or past) the last ply — including an empty game — this
            # is the live position, not a viewing window.
            self._nav_index = None
        else:
            self._nav_index = target
        return self._state_snapshot()

    # ── State helpers ─────────────────────────────────────────────────────────

    def fen(self) -> str:
        return self.board.fen()

    def legal_moves_uci(self) -> List[str]:
        return [m.uci() for m in self.board.legal_moves]

    def move_history_san(self) -> List[str]:
        """Return SAN list by replaying the move stack."""
        b = chess.Board()
        san_list = []
        for m in self._full_history:
            if m in b.legal_moves:
                san_list.append(b.san(m))
                b.push(m)
        return san_list

    def _history_with_colors(self) -> List[tuple[str, str, str]]:
        """Replay `_full_history` from the retained start as (uci, san, color).

        The color is the side that MOVED — `board.turn` BEFORE the push —
        never index parity. Same replay pattern as `history_fens_and_moves`:
        skip moves illegal from the replay position (unreachable for games
        played through this manager, which validates on push).
        """
        board = chess.Board(self._initial_fen)
        replayed: List[tuple[str, str, str]] = []
        for move in self._full_history:
            if move in board.legal_moves:
                color = "white" if board.turn == chess.WHITE else "black"
                replayed.append((move.uci(), board.san(move), color))
                board.push(move)
        return replayed

    def _state_snapshot(self, last_san: str = "") -> Dict[str, Any]:
        # Idle-flag path: a player who sits without moving is still on the
        # clock — latch before reading anything, so the snapshot (and the
        # tick-push loop that forwards it) ends the game all by itself.
        self._check_flag()
        board = self.board
        outcome = board.outcome()
        if outcome is not None:
            result = outcome.result()
            termination = outcome.termination.name
            is_over = True
        else:
            with self._clock_lock:
                latched = (self._terminal_result, self._terminal_termination)
            if latched[0] is not None:
                result, termination = latched
                is_over = True
            else:
                result = None
                termination = None
                is_over = False

        if self._nav_index is not None and 0 <= self._nav_index < len(
            self._full_history
        ):
            last_uci: Optional[str] = self._full_history[self._nav_index].uci()
        elif (
            self._nav_index is None
            and self._full_history
            and len(self.board.move_stack) > 0
        ):
            last_uci = self._full_history[-1].uci()
        else:
            last_uci = None

        # One replay feeds all three parallel arrays, so uci/san/color can
        # never desynchronise (P2-T09). For standard-start games this is
        # byte-identical to the old `move_history_san()` + full-history UCIs.
        replayed = self._history_with_colors()

        return {
            "fen": board.fen(),
            "turn": "white" if board.turn == chess.WHITE else "black",
            "legal_moves": self.legal_moves_uci(),
            "move_history": [san for _, san, _ in replayed],
            "full_move_history": [uci for uci, _, _ in replayed],
            "move_colors": [color for _, _, color in replayed],
            "last_move_san": last_san,
            "last_move_uci": last_uci,
            "nav_index": -1 if self._nav_index is None else self._nav_index,
            "game_over": is_over,
            "result": result,
            "termination": termination,
            "in_check": board.is_check(),
            "clock": self._clock_snapshot(),
        }

    # ── SINGLE SHARED ENGINE ACCESS ──────────────────────────────────────────

    def _ensure_analysis_uci(self, stockfish_path: str) -> chess.engine.SimpleEngine:
        """Return the shared analysis Stockfish SimpleEngine (reused for analysis)."""
        if (
            self._analysis_engine is not None
            and stockfish_path == self._analysis_engine_path
        ):
            try:
                self._analysis_engine.ping()
                return self._analysis_engine
            except Exception:
                pass
        self._close_analysis_uci()
        try:
            self._analysis_engine = chess.engine.SimpleEngine.popen_uci(stockfish_path)
            self._analysis_engine_path = stockfish_path
            return self._analysis_engine
        except Exception as e:
            print(f"[ERROR] Failed to start analysis Stockfish: {e}", file=sys.stderr)
            raise

    def _close_analysis_uci(self) -> None:
        """Shut down the shared analysis Stockfish process."""
        if self._analysis_engine is not None:
            try:
                self._analysis_engine.quit()
            except Exception:
                pass
            self._analysis_engine = None

    @staticmethod
    def _configure_uci(
        engine: chess.engine.SimpleEngine,
        threads: Optional[int] = None,
        hash_mb: Optional[int] = None,
        skill_level: Optional[int] = None,
    ) -> None:
        """Configure engine options with memory-safe defaults."""
        options: Dict[str, int] = {}

        # Cap threads to prevent memory issues
        if threads is not None:
            options["Threads"] = max(1, min(8, int(threads)))
        else:
            options["Threads"] = 1

        # Cap hash to prevent memory issues (default to 64MB if not provided)
        if hash_mb is not None:
            options["Hash"] = max(16, min(512, int(hash_mb)))
        else:
            options["Hash"] = 64

        # Skill level for weaker play (0-20)
        if skill_level is not None:
            options["Skill Level"] = max(0, min(20, int(skill_level)))

        if options:
            try:
                engine.configure(options)
            except Exception as e:
                print(f"[WARN] Engine configure failed: {e}", file=sys.stderr)

    # ── Engine move (direct Stockfish, full strength) ─────────────────────────

    def _bot_manager(self) -> BotManager:
        """The shared BotManager, created on first use.

        Bots are registered lazily so that importing this module stays cheap and
        so that a Stockfish binary installed after startup is still picked up.
        """
        if self._manager is None:
            self._manager = BotManager(default_bot_id="mentor")
            self._manager.register_default_bots(
                stockfish_path=self.settings.get("stockfish_path") or None
            )
        return self._manager

    def list_bots(self) -> List[Dict[str, Any]]:
        """Every known bot with its capabilities and availability.

        This is the single list the UI renders, so adding a bot needs no
        frontend change.
        """
        return self._bot_manager().describe()

    def _resolve_bot_id(self, engine_type: Optional[str]) -> str:
        """Map the legacy engine_type values onto bot ids.

        The renderer still sends "stockfish"/"maia3"/"mentor", and those stay
        valid. "stockfish" is the canonical bot, which resolves a binary per move
        and honours a per-request path, so a specifically configured build is
        used as given. A versioned id such as "stockfish-19" selects one exact
        discovered build. "auto" lets the manager pick the best available.
        """
        choice = engine_type or self.settings.get("engine_type") or "mentor"
        if choice in ("stockfish", "auto", "uci"):
            return AUTO_BOT_ID if choice == "auto" else "stockfish"
        return choice

    def get_engine_move(
        self,
        fen: str,
        time_limit: float = 0.5,
        depth: Optional[int] = None,
        stockfish_path: Optional[str] = None,
        threads: Optional[int] = None,
        hash_mb: Optional[int] = None,
        engine_type: Optional[str] = None,
        maia3_path: Optional[str] = None,
        maia3_model: Optional[str] = None,
        maia3_device: Optional[str] = None,
        maia3_elo: Optional[int] = None,
        think_profile: Optional[str] = None,
        time_remaining: Optional[float] = None,
        time_increment: Optional[float] = None,
        total_moves: Optional[int] = None,
        strength: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get a move from the selected bot, normalized to the standard shape.

        Every bot is reached through the BotManager, so this method no longer
        knows what Stockfish, Mentor or Maia3 do -- only that each returns the
        same result. Fallback, think-time budgeting and score normalization all
        live in the manager.
        """
        manager = self._bot_manager()
        bot_id = self._resolve_bot_id(engine_type)

        request = MoveRequest(
            fen=fen,
            # time_limit stays out of the budget on purpose: the think profile
            # and clock decide how long a human-like bot thinks, which is the
            # behaviour the renderer relies on. It remains in the signature
            # because the IPC contract still carries it.
            time_remaining=time_remaining,
            time_increment=time_increment,
            total_moves=total_moves,
            strength=int(
                strength if strength is not None else self.settings.get("strength", 7)
            ),
            think_profile=think_profile
            or self.settings.get("think_profile", "human_like"),
            depth=depth,
            options={
                # The per-request path overrides whatever the manager was built
                # with, so an explicitly configured engine is the one that plays.
                "engine_path": stockfish_path or self.settings.get("stockfish_path"),
                "threads": (
                    threads if threads is not None else self.settings.get("threads")
                ),
                "hash_mb": (
                    hash_mb if hash_mb is not None else self.settings.get("hash_mb")
                ),
                "maia3_path": maia3_path or self.settings.get("maia3_path") or None,
                "model": maia3_model or self.settings.get("maia3_model", "maia3-5m"),
                "device": maia3_device or self.settings.get("maia3_device", "cpu"),
                "elo": (
                    maia3_elo
                    if maia3_elo is not None
                    else self.settings.get("maia3_elo", 1500)
                ),
                "cache_dir": self.settings.get("maia3_cache_dir")
                or os.environ.get("HF_HOME"),
                "apply_skill_level": True,
            },
        )

        # Resolve first: "auto" legitimately becomes a concrete bot id, and
        # comparing the raw request against the answer would report that normal
        # choice as a fallback.
        requested = manager.resolve_bot_id(bot_id)
        try:
            move = manager.play(request, requested)
        except BotUnavailableError as exc:
            print(f"[ERROR] No bot could move ({exc})", file=sys.stderr)
            # Still the standard shape. A caller that reads move/bot_id/note
            # does not need a second code path for "no bot at all", which is how
            # the two shapes drifted apart in the first place.
            empty = BotMove(
                uci=None, san=None, bot_id=requested, note=f"no bot available: {exc}"
            )
            result = empty.to_dict()
            result["_fallback"] = True
            result["_fallback_msg"] = empty.note
            return result

        result = move.to_dict()
        # The renderer reads these two legacy keys, so they are kept on the way
        # out while remaining absent for a normal, unfallback move.
        if requested != move.bot_id:
            result["_fallback"] = True
            result["_fallback_msg"] = move.note or f"{requested} unavailable"
        return result

    def get_maia3_move(
        self,
        fen: str,
        model: str = "maia3-5m",
        device: str = "cpu",
        maia3_path: Optional[str] = None,
        cache_dir: Optional[str] = None,
        temperature: float = 0.0,
        top_p: float = 1.0,
        elo: int = 1500,
        think_profile: str = "human_like",
        time_remaining: Optional[float] = None,
        time_increment: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Get a move from Maia3 via its UCI engine (safely, no stdout noise)."""
        return self._maia3_proxy.play(
            fen=fen,
            model=model,
            device=device,
            maia3_path=maia3_path,
            cache_dir=cache_dir or os.environ.get("HF_HOME"),
            temperature=temperature,
            top_p=top_p,
            elo=elo,
            think_profile=think_profile,
            time_remaining=time_remaining,
            time_increment=time_increment,
        )

    # ── Mentor bot move (pure Python AI) ─────────────────────────────────────

    def get_mentor_move(
        self,
        fen: str,
        strength: int = 7,
        stockfish_path: Optional[str] = None,
        threads: Optional[int] = None,
        hash_mb: Optional[int] = None,
        time_remaining: Optional[float] = None,
        time_increment: Optional[float] = None,
        total_moves: Optional[int] = None,
        time_override: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Get move from custom MentorEngine (pure Python AI, no Stockfish)."""
        board = chess.Board(fen)
        legal_moves = list(board.legal_moves)

        # First, try opening book if enabled in settings - VALIDATE MOVE
        opening_book_path = self.settings.get("opening_book_path", "resources/books")
        use_opening_book = self.settings.get("use_opening_book", True)
        opening_depth = self.settings.get("opening_book_depth", 20)

        # Only use book in opening phase (first ~20 plies = 10 moves each)
        if (
            use_opening_book
            and opening_book_path
            and board.fullmove_number * 2 <= opening_depth
        ):
            try:
                from aether_chess.io.opening_book import OpeningBook

                book_paths = []
                if os.path.isdir(opening_book_path):
                    book_paths = [
                        os.path.join(opening_book_path, f)
                        for f in os.listdir(opening_book_path)
                        if f.endswith(".bin")
                    ]
                book = OpeningBook(paths=book_paths)
                book_move = book.choose(board)
                # VALIDATE: Check move is legal for current position
                if book_move and book_move in legal_moves:
                    # Extra safety: make sure move doesn't leave king in check
                    board_copy = board.copy()
                    board_copy.push(book_move)
                    if not board_copy.is_check():
                        return {
                            "move": book_move.uci(),
                            "san": board.san(book_move),
                            "from_book": True,
                        }
            except Exception as e:
                print(f"[WARN] Book error: {e}", file=sys.stderr)
                # Fall through to engine search

        level = max(1, min(10, int(strength)))

        # Use profile-sampled time if provided, else compute from clock
        if time_override is not None:
            think_time = time_override
        else:
            base_time = 0.4 + level * 0.25
            if time_remaining is not None and time_remaining > 0:
                move_num = total_moves or 30
                moves_left = max(1, 40 - move_num)
                share = time_remaining / moves_left
                base_time = max(0.2, min(time_remaining * 0.35, share * 0.5, 3.0))
                if time_increment and time_increment > 0:
                    base_time = max(0.2, min(base_time + time_increment * 0.3, 3.0))
            jitter = random.uniform(0.85, 1.35)
            think_time = base_time * jitter

        # Get configured mentor engine
        mentor = self._get_mentor_engine(strength)
        mentor.config.time_limit_sec = think_time

        try:
            move = mentor.search(board)
            elapsed = time.time() - mentor.start_time
            if elapsed < think_time:
                time.sleep(think_time - elapsed)
            if move is None or move not in legal_moves:
                print(f"[WARN] Engine returned illegal move {move}, selecting random")
                # Fallback: random legal move
                if legal_moves:
                    move = random.choice(legal_moves)
                else:
                    return {"move": None, "san": None}
            san = board.san(move)
            return {"move": move.uci(), "san": san, "from_book": False}
        except Exception as e:
            print(f"[ERROR] MentorEngine search failed: {e}", file=sys.stderr)
            # Fallback: random legal move
            if legal_moves:
                move = random.choice(legal_moves)
                return {"move": move.uci(), "san": board.san(move)}
            return {"move": None, "san": None}

    # ── Analysis streaming ───────────────────────────────────────────────────

    def start_analysis(
        self,
        fen: str,
        multipv: int,
        callback_id: str,
        stockfish_path: str,
        threads: Optional[int],
        hash_mb: Optional[int],
        push_fn: Callable[[Dict[str, Any]], None],
    ) -> None:
        self.stop_analysis()
        self._analysis_stop.clear()

        def _run() -> None:
            try:
                with self._analysis_engine_lock:
                    engine = self._ensure_analysis_uci(stockfish_path)
                    self._configure_uci(engine, threads, hash_mb)
                    board = chess.Board(fen)

                    with engine.analysis(
                        board, chess.engine.Limit(time=3600.0), multipv=multipv
                    ) as analysis:
                        for info in analysis:
                            if self._analysis_stop.is_set():
                                break
                            pvs = []
                            for pv_info in info if isinstance(info, list) else [info]:
                                pv = pv_info.get("pv", [])
                                score = pv_info.get("score")
                                depth_v = pv_info.get("depth", 0)
                                if score is not None:
                                    cp = score.white().score(mate_score=10000)
                                    pvs.append(
                                        {
                                            "depth": depth_v,
                                            "score_cp": cp,
                                            "mate": score.white().mate(),
                                            "pv": [m.uci() for m in pv[:10]],
                                            "pv_san": _moves_to_san(board, pv[:10]),
                                        }
                                    )
                            if pvs:
                                push_fn(
                                    {
                                        "type": "analysis_update",
                                        "callback_id": callback_id,
                                        "pvs": pvs,
                                        "fen": fen,
                                    }
                                )
            except Exception as exc:
                push_fn(
                    {
                        "type": "analysis_update",
                        "callback_id": callback_id,
                        "error": str(exc),
                        "pvs": [],
                        "fen": fen,
                    }
                )

        self._analysis_thread = threading.Thread(target=_run, daemon=True)
        self._analysis_thread.start()

    def stop_analysis(self) -> None:
        self._analysis_stop.set()
        if self._analysis_thread is not None:
            thread = self._analysis_thread
            self._analysis_thread = None
            try:
                if thread.is_alive():
                    thread.join(timeout=3.0)
            except RuntimeError:
                pass

    # ── Custom Mentor Evaluation ─────────────────────────────────────────────────

    def get_mentor_eval(self, fen: str) -> Dict[str, Any]:
        """Get position evaluation from MentorEngine's evaluation function.

        Returns evaluation from the custom Stockfish-style evaluation:
        - Material balance
        - Piece-square tables (midgame + endgame)
        - Pawn structure bonuses/penalties
        - Bishop pair bonus
        - King safety
        """
        try:
            board = chess.Board(fen)
            mentor = self._get_mentor_engine(self.settings.get("strength", 7))
            eval_score = mentor.evaluate(board)

            # Convert from perspective of side to move
            if board.turn == chess.BLACK:
                eval_score = -eval_score

            return {
                "eval_cp": eval_score,
                "phase": mentor._phase(board),
            }
        except Exception as e:
            return {"eval_cp": None, "error": str(e)}

    def history_fens_and_moves(self) -> tuple[List[str], List[str]]:
        board = chess.Board()
        fen_list: List[str] = []
        moves: List[str] = []
        for move in self._full_history:
            if move in board.legal_moves:
                fen_list.append(board.fen())
                moves.append(move.uci())
                board.push(move)
        return fen_list, moves

    # ── Opening book ──────────────────────────────────────────────────────────

    def get_book_moves(
        self, fen: str, books_dir: str = "resources/books"
    ) -> Dict[str, Any]:
        """Return all book moves with weights for a position."""

        bin_files = globlib.glob(os.path.join(books_dir, "*.bin"))
        if not bin_files:
            return {
                "moves": [],
                "hint": "No opening book found. Place .bin files in the books directory.",
            }
        board = chess.Board(fen)
        all_moves: Dict[str, Dict[str, Any]] = {}
        for bin_path in bin_files:
            try:
                with chess.polyglot.open_reader(bin_path) as reader:
                    for entry in reader.find_all(board):
                        uci = entry.move.uci()
                        if uci not in all_moves:
                            all_moves[uci] = {
                                "uci": uci,
                                "san": board.san(entry.move),
                                "weight": 0,
                            }
                        all_moves[uci]["weight"] += entry.weight
            except OSError:
                continue
        moves = sorted(all_moves.values(), key=lambda x: x["weight"], reverse=True)
        return {"moves": moves}

    # ── PGN management ───────────────────────────────────────────────────────

    def export_pgn(self) -> str:
        return self.game_state.to_pgn(moves=self._board_from_full_history().move_stack)

    def import_pgn(self, pgn_text: str) -> None:
        self.game_state.load_pgn(pgn_text)
        self.board = self.game_state.board
        # load_pgn replays from startpos (SetUp/FEN headers ignored), so the
        # effective start is standard — never inherit a stale FEN start.
        self._initial_fen = chess.STARTING_FEN
        self._full_history = list(self.board.move_stack)
        self._nav_index = None
        # An imported game carries no time control: Unlimited, latch cleared.
        with self._clock_lock:
            self._white_ms = None
            self._black_ms = None
            self._increment_ms = 0
            self._clock_stamp = None
            self._terminal_result = None
            self._terminal_termination = None

    def close(self) -> None:
        """Clean up all engine resources."""
        self.stop_clock_push()
        self.stop_analysis()
        if self._manager is not None:
            self._manager.close()
            self._manager = None
        self._close_analysis_uci()


def _moves_to_san(board: chess.Board, moves: List[chess.Move]) -> List[str]:
    b = board.copy()
    result = []
    for m in moves:
        if m in b.legal_moves:
            result.append(b.san(m))
            b.push(m)
        else:
            break
    return result
