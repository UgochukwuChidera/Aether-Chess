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

from aether_chess.engines.maia3_proxy import Maia3Proxy, Maia3UnavailableError
from aether_chess.think_profile import get_profile, sample_think_time

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
            "maia3_path": "",
            "maia3_model": "maia3-5m",
            "maia3_device": "cpu",
            "maia3_elo": 1500,
            "think_profile": "human_like",
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
        
        level = max(1, min(10, int(strength)))
        # Realistic depth for nodes budget - depth 18 needs millions of nodes
        self._mentor_engine.config = SearchConfig(
            max_depth=max(4, level + 2),  # 6-12 plies only (was 6-24)
            max_nodes=200_000 * level,  # 200K-2M nodes (was 100K-1.1M)
            time_limit_sec=max(0.3, min(2.0, 0.3 + level * 0.2)),  # 0.5-2.3s but capped at 2s
            difficulty=min(1.0, 0.5 + level * 0.05),
            tt_max_entries=500_000,  # Fixed size, not scaling
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
        maia3_path: Optional[str] = None,
        maia3_model: Optional[str] = None,
        maia3_device: Optional[str] = None,
        maia3_elo: Optional[int] = None,
        think_profile: Optional[str] = None,
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

    def _ensure_analysis_uci(self, stockfish_path: str) -> chess.engine.SimpleEngine:
        """Return the shared analysis Stockfish SimpleEngine (reused for analysis)."""
        if self._analysis_engine is not None and stockfish_path == self._analysis_engine_path:
            try:
                if self._analysis_engine.is_alive():
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
    ) -> Dict[str, Any]:
        """Get move from selected engine. Falls back to mentor with logged reason."""
        engine_choice = engine_type or self.settings.get("engine_type", "stockfish")
        profile_name = think_profile or self.settings.get("think_profile", "human_like")
        profile = get_profile(profile_name)
        board = chess.Board(fen)
        fallback_from: Optional[str] = None

        if engine_choice == "maia3":
            try:
                result = self.get_maia3_move(
                    fen=fen,
                    model=maia3_model or self.settings.get("maia3_model", "maia3-5m"),
                    device=maia3_device or self.settings.get("maia3_device", "cpu"),
                    maia3_path=maia3_path or self.settings.get("maia3_path") or None,
                    cache_dir=self.settings.get("maia3_cache_dir") or os.environ.get("HF_HOME"),
                    elo=maia3_elo if maia3_elo is not None else self.settings.get("maia3_elo", 1500),
                    think_profile=profile_name,
                    time_remaining=time_remaining,
                    time_increment=time_increment,
                )
                if result and result.get("move"):
                    return result
            except Maia3UnavailableError as e:
                print(f"[ERROR] Maia3 unavailable: {e}, falling back", file=sys.stderr)
            except Exception as e:
                print(f"[ERROR] Maia3 failed: {e}, falling back", file=sys.stderr)
            fallback_from = "maia3"

        if engine_choice == "mentor":
            target = sample_think_time(
                profile, board=board,
                time_remaining=time_remaining,
                time_increment=time_increment,
            )
            return self.get_mentor_move(fen=fen, strength=self.settings.get("strength", 7), time_override=target)

        # Stockfish path
        sp = stockfish_path or self.settings.get("stockfish_path", "stockfish")
        if os.path.isfile(sp):
            try:
                target = sample_think_time(
                    profile, board=board,
                    time_remaining=time_remaining,
                    time_increment=time_increment,
                )
                with self._uci_lock:
                    engine = self._ensure_uci(sp)
                    self._configure_uci(
                        engine,
                        threads if threads is not None else self.settings.get("threads"),
                        hash_mb if hash_mb is not None else self.settings.get("hash_mb"),
                        skill_level=None,
                    )
                    limit = chess.engine.Limit(time=target, depth=depth)
                    result = engine.play(board, limit)
                if result and result.move:
                    san = board.san(result.move)
                    ret: Dict[str, Any] = {"move": result.move.uci(), "san": san}
                    if fallback_from:
                        ret["_fallback_msg"] = f"Maia3 unavailable — using Stockfish"
                    return ret
            except Exception as e:
                print(f"[ERROR] Stockfish failed: {e}, falling back to mentor", file=sys.stderr)
                self._close_uci()
        else:
            print(f"[ERROR] Stockfish binary not found at: {sp}, falling back to mentor", file=sys.stderr)

        # Fallback to mentor engine
        print("[WARN] Using mentor engine as fallback", file=sys.stderr)
        result = self.get_mentor_move(fen=fen, strength=self.settings.get("strength", 7))
        result["_fallback"] = True
        if fallback_from:
            result["_fallback_msg"] = "Maia3 unavailable — using Mentor"
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
                    
                    with engine.analysis(board, chess.engine.Limit(time=3600.0), multipv=multipv) as analysis:
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
        """Return all book moves with weights for a position."""
        import glob as globlib
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
