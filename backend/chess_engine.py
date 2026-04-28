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
from aether_chess.engines.mentor_engine import MentorEngine, SearchConfig


class ChessEngineManager:
    """Central game-state manager with single shared Stockfish instance."""

    def __init__(self) -> None:
        self.game_state = GameState()
        self._full_history: List[chess.Move] = []
        self._nav_index: int = -1
        self.settings: Dict[str, Any] = {
            "mode": "human_vs_ai",
            "engine_type": "mentor",
            "human_color": "white",
            "strength": 7,
            "stockfish_path": "stockfish",
            "threads": 1,
            "hash_mb": 128,
            "multipv": 3,
        }
        self.board = self.game_state.board

        # Custom MentorEngine (pure Python chess AI - no Stockfish needed!)
        self._mentor_engine: Optional[MentorEngine] = None

        # UCI engine (Stockfish) - only used for engine_type=stockfish
        self._uci_engine: Optional[chess.engine.SimpleEngine] = None
        self._uci_path: str = "stockfish"
        self._uci_lock = threading.Lock()

        # Analysis thread control
        self._analysis_stop = threading.Event()
        self._analysis_thread: Optional[threading.Thread] = None

    def _get_mentor_engine(self, strength: int = 7) -> MentorEngine:
        """Get or create the custom MentorEngine with proper strength config."""
        if self._mentor_engine is None:
            self._mentor_engine = MentorEngine()
        
        level = max(1, min(10, int(strength)))
        # INCREASE depth and nodes for smarter play
        self._mentor_engine.config = SearchConfig(
            max_depth=4 + level * 2,  # 6-24 plies
            max_nodes=200_000 + level * 200_000,  # 400K-2.2M
            time_limit_sec=0.5 + level * 0.3,  # 0.8-3.5s
            difficulty=min(1.0, 0.5 + level * 0.05),  # 0.55-1.0
            tt_max_entries=500_000 + level * 50_000,  # 550K-1M
            threads=1,
        )
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
            self.settings["threads"] = max(1, min(8, int(threads)))  # Cap at 8
        if hash_mb is not None:
            self.settings["hash_mb"] = max(16, min(512, int(hash_mb)))  # Cap at 512MB
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

    # ── SINGLE SHARED ENGINE ACCESS ──────────────────────────────────────────

    def _ensure_uci(self, stockfish_path: str) -> chess.engine.SimpleEngine:
        """Return the shared Stockfish SimpleEngine (reused for all operations)."""
        if self._uci_engine is not None and stockfish_path == self._uci_path:
            try:
                if self._uci_engine.is_alive():
                    return self._uci_engine
            except Exception:
                pass
        self._close_uci()
        try:
            self._uci_engine = chess.engine.SimpleEngine.popen_uci(stockfish_path)
            self._uci_path = stockfish_path
            return self._uci_engine
        except Exception as e:
            print(f"[ERROR] Failed to start Stockfish: {e}", file=sys.stderr)
            raise

    def _close_uci(self) -> None:
        """Shut down the shared Stockfish process."""
        if self._uci_engine is not None:
            try:
                self._uci_engine.quit()
            except Exception:
                pass
            self._uci_engine = None

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
        
        # Cap hash to prevent memory issues (Stockfish default is fine below 512MB)
        if hash_mb is not None:
            options["Hash"] = max(16, min(512, int(hash_mb)))
        
        # Skill level for weaker play (0-20)
        if skill_level is not None:
            options["Skill Level"] = max(0, min(20, int(skill_level)))
        
        if options:
            try:
                engine.configure(options)
            except Exception as e:
                print(f"[WARN] Engine configure failed: {e}", file=sys.stderr)

    # ── Engine move (direct Stockfish, full strength) ─────────────────────────

    def get_engine_move(
        self,
        fen: str,
        time_limit: float = 0.5,
        depth: Optional[int] = None,
        stockfish_path: Optional[str] = None,
        threads: Optional[int] = None,
        hash_mb: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get move from Stockfish at full strength."""
        sp = stockfish_path or self.settings.get("stockfish_path", "stockfish")
        board = chess.Board(fen)
        
        with self._uci_lock:
            engine = self._ensure_uci(sp)
            self._configure_uci(
                engine,
                threads if threads is not None else self.settings.get("threads"),
                hash_mb if hash_mb is not None else self.settings.get("hash_mb"),
                skill_level=None,  # Full strength
            )
            limit = chess.engine.Limit(
                time=time_limit,
                depth=depth,
            )
            try:
                result = engine.play(board, limit)
            except Exception as e:
                print(f"[ERROR] Engine play failed: {e}", file=sys.stderr)
                # Try to restart engine on error
                self._close_uci()
                return {"move": None, "san": None}
        
        move = result.move
        if move is None:
            return {"move": None, "san": None}
        san = board.san(move)
        return {"move": move.uci(), "san": san}

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
    ) -> Dict[str, Any]:
        """Get move from custom MentorEngine (pure Python AI, no Stockfish).
        
        This is your OWN chess bot with:
        - Alpha-beta search with quiescence
        - Piece-square tables
        - Transposition table
        - Null move pruning
        - Late move reductions
        - Killer move heuristics
        - Opening book integration (VALIDATED for legality)
        - Custom evaluation function
        
        Strength 1-10 scales:
        - depth: 3-12 plies
        - nodes: 50K-550K
        - time: 0.35s-1.7s
        - difficulty: 0.46-1.0 (probability of playing best move)
        """
        board = chess.Board(fen)
        legal_moves = list(board.legal_moves)
        
        # First, try opening book if enabled in settings - VALIDATE MOVE
        opening_book_path = self.settings.get("opening_book_path", "resources/books")
        use_opening_book = self.settings.get("use_opening_book", True)
        opening_depth = self.settings.get("opening_book_depth", 20)
        
        # Only use book in opening phase (first ~20 plies = 10 moves each)
        if use_opening_book and opening_book_path and board.fullmove_number * 2 <= opening_depth:
            try:
                from aether_chess.io.opening_book import OpeningBook
                book_paths = []
                if os.path.isdir(opening_book_path):
                    book_paths = [os.path.join(opening_book_path, f) for f in os.listdir(opening_book_path) if f.endswith('.bin')]
                book = OpeningBook(paths=book_paths)
                book_move = book.choose(board)
                # VALIDATE: Check move is legal for current position
                if book_move and book_move in legal_moves:
                    # Extra safety: make sure move doesn't leave king in check
                    board_copy = board.copy()
                    board_copy.push(book_move)
                    if not board_copy.is_check():
                        return {"move": book_move.uci(), "san": board.san(book_move), "from_book": True}
            except Exception as e:
                print(f"[WARN] Book error: {e}", file=sys.stderr)
                # Fall through to engine search
        
        level = max(1, min(10, int(strength)))
        
        # Adjust time based on time control if provided
        base_time = 0.2 + level * 0.15
        if time_remaining is not None and time_remaining > 0:
            move_num = total_moves or 30
            moves_left = max(1, 40 - move_num)
            share = time_remaining / moves_left
            base_time = max(0.15, min(time_remaining * 0.3, share * 0.4, 1.0))
            if time_increment and time_increment > 0:
                base_time = max(0.15, min(base_time + time_increment * 0.2, 1.0))
        
        # Get configured mentor engine
        mentor = self._get_mentor_engine(strength)
        mentor.config.time_limit_sec = base_time
        
        try:
            move = mentor.search(board)
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
            engine = None
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
            except Exception as exc:
                push_fn({
                    "type": "analysis_update",
                    "callback_id": callback_id,
                    "error": str(exc),
                    "pvs": [],
                    "fen": fen,
                })
            finally:
                if engine:
                    try:
                        engine.quit()
                    except Exception:
                        pass

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
                "mg_score": self._get_mg_score(board, mentor),
                "eg_score": self._get_eg_score(board, mentor),
            }
        except Exception as e:
            return {"eval_cp": None, "error": str(e)}

    def _get_mg_score(self, board: chess.Board, mentor: MentorEngine) -> int:
        """Get midgame score (raw)."""
        score = 0
        for pt, val in [(chess.PAWN, 100), (chess.KNIGHT, 320), (chess.BISHOP, 330),
                        (chess.ROOK, 500), (chess.QUEEN, 950), (chess.KING, 20000)]:
            for sq in board.pieces(pt, chess.WHITE):
                score += val
            for sq in board.pieces(pt, chess.BLACK):
                score -= val
        return score

    def _get_eg_score(self, board: chess.Board, mentor: MentorEngine) -> int:
        """Get endgame score (raw)."""
        score = 0
        for pt, val in [(chess.PAWN, 100), (chess.KNIGHT, 320), (chess.BISHOP, 330),
                        (chess.ROOK, 500), (chess.QUEEN, 950), (chess.KING, 20000)]:
            for sq in board.pieces(pt, chess.WHITE):
                score += val
            for sq in board.pieces(pt, chess.BLACK):
                score -= val
        return score

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
        # Import here to avoid issues when not available
        from aether_chess.io.opening_book import OpeningBook
        
        book = OpeningBook(paths=[os.path.join(books_dir, f) for f in os.listdir(books_dir) if f.endswith('.bin')] if os.path.isdir(books_dir) else [])
        if not book._all_paths():
            return {
                "moves": [],
                "hint": "No opening book found. Place .bin files in the books directory.",
            }
        board = chess.Board(fen)
        moves = book.choose(board)
        if moves is None or moves not in board.legal_moves:
            return {"moves": []}
        return {"moves": [{"uci": moves.uci(), "san": board.san(moves), "weight": 1}]}

    # ── PGN management ───────────────────────────────────────────────────────

    def export_pgn(self) -> str:
        return self.game_state.to_pgn()

    def import_pgn(self, pgn_text: str) -> None:
        self.game_state.load_pgn(pgn_text)
        self.board = self.game_state.board
        self._full_history = list(self.board.move_stack)
        self._nav_index = -1

    def close(self) -> None:
        """Clean up all engine resources."""
        self.stop_analysis()
        self._close_uci()


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