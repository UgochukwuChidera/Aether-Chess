"""
backend/chess_engine.py — Wrapper around python-chess and Stockfish for the
Aether Chess backend service.
"""
from __future__ import annotations

import glob as globlib
import os
import sys
import threading
from typing import Any, Callable, Dict, List, Optional

import chess
import chess.engine
import chess.pgn
import chess.polyglot

# Add parent directory to path so existing aether_chess modules can be imported
_HERE = os.path.dirname(__file__)
_ROOT = os.path.join(_HERE, "..")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from aether_chess.models.game_state import GameState


class ChessEngineManager:
    """Central game-state manager for the backend service."""

    def __init__(self) -> None:
        self.game_state = GameState()
        # Snapshot of all moves from the root (for navigation)
        self._full_history: List[chess.Move] = []
        self._nav_index: int = -1  # -1 means "current position"
        self.settings: Dict[str, Any] = {
            "mode": "human_vs_ai",
            "engine_type": "stockfish",
            "human_color": "white",
            "strength": 7,
            "stockfish_path": "stockfish",
            "threads": 1,
            "hash_mb": 128,
            "multipv": 3,
        }
        self.board = self.game_state.board

        # Stockfish singleton for engine moves
        self._uci_engine: Optional[chess.engine.SimpleEngine] = None
        self._uci_path: str = "stockfish"
        self._uci_lock = threading.Lock()  # protects _uci_engine access

        # Analysis thread control
        self._analysis_stop = threading.Event()
        self._analysis_thread: Optional[threading.Thread] = None

    # ── Game lifecycle ────────────────────────────────────────────────────────

    def new_game(
        self,
        mode: str = "human_vs_ai",
        engine_type: str = "stockfish",
        human_color: str = "white",
        strength: int = 7,
        time_control: Optional[Dict[str, int]] = None,
        stockfish_path: Optional[str] = None,
        threads: Optional[int] = None,
        hash_mb: Optional[int] = None,
        multipv: Optional[int] = None,
    ) -> None:
        self.game_state.reset()
        self.board = self.game_state.board
        self._full_history = []
        self._nav_index = -1
        self.settings.update(
            mode=mode,
            engine_type=engine_type,
            human_color=human_color,
            strength=strength,
        )
        if time_control:
            self.settings["time_control"] = time_control
        if stockfish_path:
            self.settings["stockfish_path"] = stockfish_path
        if threads is not None:
            self.settings["threads"] = max(1, min(64, int(threads)))
        if hash_mb is not None:
            self.settings["hash_mb"] = max(16, min(2048, int(hash_mb)))
        if multipv is not None:
            self.settings["multipv"] = max(1, min(5, int(multipv)))

    # ── Move operations ───────────────────────────────────────────────────────

    def make_move(self, move_uci: str) -> tuple[bool, Dict[str, Any]]:
        """Push a UCI move. Returns (success, state_snapshot)."""
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

        san = self.board.san(move)
        self.game_state.push(move)
        # If we were navigating, truncate future
        self._full_history = list(self.board.move_stack)
        self._nav_index = -1

        return True, self._state_snapshot(last_san=san)

    def undo_move(self) -> Dict[str, Any]:
        self.game_state.pop()
        self._full_history = list(self.board.move_stack)
        self._nav_index = -1
        return self._state_snapshot()

    def navigate_to(self, index: int) -> Dict[str, Any]:
        """Navigate move history without modifying it."""
        moves = self._full_history
        target = max(-1, min(index, len(moves) - 1))
        # Rebuild board to target position
        self.board.reset()
        for m in moves[: target + 1]:
            self.board.push(m)
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

    def _state_snapshot(self, last_san: str = "") -> Dict[str, Any]:
        board = self.board
        is_over = board.is_game_over()
        outcome = board.outcome()

        # Determine the move that led to the current view position.
        # nav_index >= 0 → browsing a specific historical move.
        # nav_index < 0 with moves on the board stack → at live/current end.
        # nav_index < 0 with an empty board stack → navigated to start (before move 0).
        if 0 <= self._nav_index < len(self._full_history):
            last_uci: Optional[str] = self._full_history[self._nav_index].uci()
        elif self._nav_index < 0 and self._full_history and len(self.board.move_stack) > 0:
            last_uci = self._full_history[-1].uci()
        else:
            last_uci = None

        return {
            "fen": board.fen(),
            "turn": "white" if board.turn == chess.WHITE else "black",
            "legal_moves": self.legal_moves_uci(),
            "move_history": self.move_history_san(),
            "full_move_history": [m.uci() for m in self._full_history],
            "last_move_san": last_san,
            "last_move_uci": last_uci,
            "nav_index": self._nav_index,
            "game_over": is_over,
            "result": outcome.result() if outcome else None,
            "termination": outcome.termination.name if outcome else None,
            "in_check": board.is_check(),
        }

    # ── Engine integration ────────────────────────────────────────────────────

    def _ensure_uci(self, stockfish_path: str) -> chess.engine.SimpleEngine:
        """Return the shared Stockfish SimpleEngine, (re)starting it if needed.

        Must be called while holding ``_uci_lock``.
        """
        if self._uci_engine is not None and stockfish_path == self._uci_path:
            return self._uci_engine
        self._close_uci()
        self._uci_engine = chess.engine.SimpleEngine.popen_uci(stockfish_path)
        self._uci_path = stockfish_path
        return self._uci_engine

    def _close_uci(self) -> None:
        """Shut down the shared Stockfish process if running.

        Must be called while holding ``_uci_lock``.
        """
        if self._uci_engine is not None:
            try:
                self._uci_engine.quit()
            except Exception:
                pass
            self._uci_engine = None

    @staticmethod
    def _configure_uci(engine: chess.engine.SimpleEngine, threads: Optional[int], hash_mb: Optional[int]) -> None:
        options: Dict[str, int] = {}
        if threads is not None:
            options["Threads"] = max(1, min(64, int(threads)))
        if hash_mb is not None:
            options["Hash"] = max(16, min(2048, int(hash_mb)))
        if options:
            try:
                engine.configure(options)
            except Exception:
                pass

    def get_engine_move(
        self,
        fen: str,
        time_limit: float = 0.5,
        depth: Optional[int] = None,
        stockfish_path: Optional[str] = None,
        threads: Optional[int] = None,
        hash_mb: Optional[int] = None,
    ) -> Dict[str, Any]:
        sp = stockfish_path or self.settings.get("stockfish_path", "stockfish")
        board = chess.Board(fen)
        with self._uci_lock:
            engine = self._ensure_uci(sp)
            self._configure_uci(
                engine,
                threads if threads is not None else self.settings.get("threads"),
                hash_mb if hash_mb is not None else self.settings.get("hash_mb"),
            )
            limit = chess.engine.Limit(
                time=time_limit,
                depth=depth,
            )
            result = engine.play(board, limit)
        move = result.move
        if move is None:
            return {"move": None, "san": None}
        san = board.san(move)
        return {"move": move.uci(), "san": san}

    # ── Analysis streaming ────────────────────────────────────────────────────

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
                engine = chess.engine.SimpleEngine.popen_uci(stockfish_path)
                self._configure_uci(engine, threads, hash_mb)
                board = chess.Board(fen)
                with engine.analysis(board, chess.engine.Limit(time=60.0), multipv=multipv) as analysis:
                    for info in analysis:
                        if self._analysis_stop.is_set():
                            break
                        pvs = []
                        for pv_info in (info if isinstance(info, list) else [info]):
                            pv = pv_info.get("pv", [])
                            score = pv_info.get("score")
                            depth_v = pv_info.get("depth", 0)
                            if score is not None:
                                cp = score.white().score(mate_score=10000)
                                pvs.append({
                                    "depth": depth_v,
                                    "score_cp": cp,
                                    "mate": score.white().mate(),
                                    "pv": [m.uci() for m in pv[:10]],
                                    "pv_san": _moves_to_san(board, pv[:10]),
                                })
                        if pvs:
                            push_fn({
                                "type": "analysis_update",
                                "callback_id": callback_id,
                                "pvs": pvs,
                                "fen": fen,
                            })
                engine.quit()
            except Exception as exc:
                push_fn({
                    "type": "analysis_update",
                    "callback_id": callback_id,
                    "error": str(exc),
                    "pvs": [],
                    "fen": fen,
                })

        self._analysis_thread = threading.Thread(target=_run, daemon=True)
        self._analysis_thread.start()

    def stop_analysis(self) -> None:
        self._analysis_stop.set()
        if self._analysis_thread is not None:
            self._analysis_thread.join(timeout=3.0)
            self._analysis_thread = None

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

    def get_book_moves(self, fen: str, books_dir: str = "resources/books") -> Dict[str, Any]:
        bin_files = globlib.glob(os.path.join(books_dir, "*.bin"))
        if not bin_files:
            return {
                "moves": [],
                "hint": "No opening book loaded. Place a .bin file in the books directory.",
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

    # ── PGN management ────────────────────────────────────────────────────────

    def export_pgn(self) -> str:
        return self.game_state.to_pgn()

    def import_pgn(self, pgn_text: str) -> None:
        self.game_state.load_pgn(pgn_text)
        self.board = self.game_state.board
        self._full_history = list(self.board.move_stack)
        self._nav_index = -1


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
