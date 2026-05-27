"""
Aether Chess — Python backend service (stdio JSON-RPC).

The Electron main process spawns this script and communicates over stdin/stdout
using newline-delimited JSON.  All requests have the shape:
  {"id": "<uuid>", "command": "<name>", "params": {...}}
All responses have the shape:
  {"id": "<uuid>", "result": <any>}          # success
  {"id": "<uuid>", "error": "<message>"}     # failure

Analysis streaming uses a push-style message (no id):
  {"type": "analysis_update", "callback_id": "<id>", ...}

Threading model
───────────────
Every incoming request is dispatched to a daemon thread immediately, so the
stdin reader loop is *never* blocked — the UI stays responsive even when
Stockfish is thinking or a full-game accuracy analysis is running.

  • Board-mutation commands (make_move, undo_move, new_game, …) serialise
    under _board_lock.  They are fast (< 1 ms), so holding that lock is fine.

  • Board read-only commands (get_legal_moves, export_pgn, …) also hold
    _board_lock briefly for safety.

  • Engine commands (get_engine_move, get_bot_move) use a FEN supplied in
    params — they never touch the shared board object and therefore require
    NO board lock.  They may block for several hundred ms; that is now fine.
    The shared engine singleton is protected by _uci_lock to prevent concurrent
    UCI protocol corruption when overlapping requests hit the same engine.

  • calculate_accuracy_from_history briefly acquires _board_lock to snapshot
    history, then releases it BEFORE the long Stockfish computation.

  • All stdout writes are serialised under _stdout_lock to prevent
    interleaved JSON across concurrent threads.
"""
from __future__ import annotations

import atexit
import json
import sys
import threading
import traceback
import io
from typing import Any, Dict

import chess
import chess.pgn

# Import domain modules (same package when running from source; bundled by
# PyInstaller they are included via hidden-imports in the .spec file).
from chess_engine import ChessEngineManager
from analysis import AccuracyAnalyser

# ── Global state ─────────────────────────────────────────────────────────────

engine_mgr = ChessEngineManager()
accuracy_analyser = AccuracyAnalyser()

# Protects all reads/writes to engine_mgr.board / game_state
_board_lock = threading.Lock()

# Serialises stdout writes so JSON lines never interleave across threads
_stdout_lock = threading.Lock()


def _cleanup() -> None:
    engine_mgr.close()


atexit.register(_cleanup)

# ── IO helpers ────────────────────────────────────────────────────────────────

def _send(obj: Dict[str, Any]) -> None:
    """Write a JSON object to stdout (one line) and flush — thread-safe."""
    line = json.dumps(obj) + "\n"
    with _stdout_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def _ok(request_id: str, result: Any) -> None:
    _send({"id": request_id, "result": result})


def _err(request_id: str, message: str) -> None:
    _send({"id": request_id, "error": message})


# ── Command handlers ──────────────────────────────────────────────────────────

def handle_new_game(params: Dict[str, Any]) -> Any:
    mode = params.get("mode", "human_vs_ai")
    engine_type = params.get("engine_type", "stockfish")
    human_color = params.get("human_color", "white")
    strength = int(params.get("strength", 7))
    time_control = params.get("time_control", None)  # {"seconds": int, "increment": int}
    stockfish_path = params.get("stockfish_path")
    maia3_path = params.get("maia3_path")
    maia3_model = params.get("maia3_model")
    maia3_device = params.get("maia3_device")
    maia3_elo = params.get("maia3_elo")
    think_profile = params.get("think_profile")
    threads = params.get("threads")
    hash_mb = params.get("hash_mb")
    multipv = params.get("multipv")

    engine_mgr.new_game(
        mode=mode,
        engine_type=engine_type,
        human_color=human_color,
        strength=strength,
        time_control=time_control,
        stockfish_path=stockfish_path,
        maia3_path=maia3_path,
        maia3_model=maia3_model,
        maia3_device=maia3_device,
        maia3_elo=maia3_elo,
        think_profile=think_profile,
        threads=threads,
        hash_mb=hash_mb,
        multipv=multipv,
    )
    return engine_mgr._state_snapshot()


def handle_make_move(params: Dict[str, Any]) -> Any:
    move_uci = str(params["move"])
    success, info = engine_mgr.make_move(move_uci)
    if not success:
        raise ValueError(f"Illegal move: {move_uci}")
    return info


def handle_get_legal_moves(params: Dict[str, Any]) -> Any:
    fen = params.get("fen")
    if fen:
        board = chess.Board(fen)
    else:
        board = engine_mgr.board
    moves = []
    for m in board.legal_moves:
        moves.append({
            "uci": m.uci(),
            "san": board.san(m),
            "from": chess.square_name(m.from_square),
            "to": chess.square_name(m.to_square),
            "promotion": chess.piece_name(m.promotion) if m.promotion else None,
        })
    return {"moves": moves}


def handle_undo_move(_params: Dict[str, Any]) -> Any:
    return engine_mgr.undo_move()


def handle_navigate_to_move(params: Dict[str, Any]) -> Any:
    index = int(params["index"])
    return engine_mgr.navigate_to(index)


def handle_get_engine_move(params: Dict[str, Any]) -> Any:
    # FEN comes from params — no board lock needed.
    fen = params.get("fen") or engine_mgr.fen()
    time_limit = float(params.get("time_limit", 0.5))
    depth = params.get("depth")
    stockfish_path = params.get("stockfish_path")
    threads = params.get("threads")
    hash_mb = params.get("hash_mb")
    engine_type = params.get("engine_type")
    maia3_path = params.get("maia3_path")
    maia3_model = params.get("maia3_model")
    maia3_device = params.get("maia3_device")
    maia3_elo = params.get("maia3_elo")
    think_profile = params.get("think_profile")
    time_remaining = params.get("time_remaining")
    time_increment = params.get("time_increment")
    return engine_mgr.get_engine_move(
        fen,
        time_limit=time_limit,
        depth=depth,
        stockfish_path=stockfish_path,
        threads=threads,
        hash_mb=hash_mb,
        engine_type=engine_type,
        maia3_path=maia3_path,
        maia3_model=maia3_model,
        maia3_device=maia3_device,
        maia3_elo=maia3_elo,
        think_profile=think_profile,
        time_remaining=time_remaining,
        time_increment=time_increment,
    )


def handle_get_bot_move(params: Dict[str, Any]) -> Any:
    fen = params.get("fen") or engine_mgr.fen()
    strength = int(params.get("strength", engine_mgr.settings.get("strength", 7)))
    stockfish_path = params.get("stockfish_path", engine_mgr.settings.get("stockfish_path", "stockfish"))
    threads = params.get("threads", engine_mgr.settings.get("threads"))
    hash_mb = params.get("hash_mb", engine_mgr.settings.get("hash_mb"))
    time_remaining = params.get("time_remaining")
    time_increment = params.get("time_increment")
    total_moves = params.get("total_moves")
    return engine_mgr.get_mentor_move(
        fen,
        strength=strength,
        stockfish_path=stockfish_path,
        threads=threads,
        hash_mb=hash_mb,
        time_remaining=time_remaining,
        time_increment=time_increment,
        total_moves=total_moves,
    )


def handle_check_maia3_cache(params: Dict[str, Any]) -> Any:
    import os

    model = params.get("model", "maia3-5m")
    hf_home = os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
    hub_dir = os.path.join(hf_home, "hub")

    # Map model alias to HF repo ID
    repo_map = {
        "maia3-5m": "models--UofTCSSLab--Maia3-5M",
        "maia3-23m": "models--UofTCSSLab--Maia3-23M",
        "maia3-79m": "models--UofTCSSLab--Maia3-79M",
    }
    repo_dir = repo_map.get(model)
    if repo_dir:
        model_path = os.path.join(hub_dir, repo_dir, "snapshots")
        cached = os.path.isdir(model_path) and bool(os.listdir(model_path))
    else:
        cached = False

    return {"cached": cached, "model": model}


def handle_maia3_cache(params: Dict[str, Any]) -> Any:
    import contextlib
    import io
    import os

    model = params.get("model", "maia3-5m")
    cache_dir = params.get("cache_dir")
    force_download = bool(params.get("force_download", False))
    token = params.get("hf_token")
    try:
        import maia3
        from maia3.cache import main as maia3_cache
    except Exception as exc:
        raise RuntimeError(f"Maia3 is not installed in this environment. Run: python -m pip install -e .\\inspiration [{exc}]") from exc

    args = ["--model", str(model)]
    if cache_dir:
        args += ["--cache-dir", str(cache_dir)]
    if force_download:
        args += ["--force-download"]
    if token:
        args += ["--hf-token", str(token)]

    # Suppress stdout (cache.py prints "Maia3 5M: /path" which breaks JSON protocol)
    # and filter stderr noise (symlink warnings, image.png errors),
    # but let tqdm progress bars (lines with %) show through.
    with contextlib.redirect_stdout(io.StringIO()):
        with contextlib.redirect_stderr(io.StringIO()) as err_buf:
            try:
                maia3_cache(args)
            except SystemExit:
                pass
    for line in err_buf.getvalue().splitlines():
        if "%" in line:
            print(line, file=sys.stderr)

    return {"ok": True, "model": model}


def handle_export_pgn(_params: Dict[str, Any]) -> Any:
    return {"pgn": engine_mgr.export_pgn()}


def handle_import_pgn(params: Dict[str, Any]) -> Any:
    pgn_text = str(params["pgn"])
    engine_mgr.import_pgn(pgn_text)
    san_history = engine_mgr.move_history_san()
    last_san = san_history[-1] if san_history else ""
    return engine_mgr._state_snapshot(last_san=last_san)


def handle_export_fen(_params: Dict[str, Any]) -> Any:
    return {"fen": engine_mgr.fen()}


def handle_calculate_accuracy(params: Dict[str, Any]) -> Any:
    # All data from params — no board lock needed.
    fen_list: list[str] = params["fen_list"]
    moves: list[str] = params["moves"]
    stockfish_path: str = params.get("stockfish_path", engine_mgr.settings.get("stockfish_path", "stockfish"))
    return accuracy_analyser.calculate(fen_list, moves, stockfish_path=stockfish_path)


def handle_calculate_accuracy_from_history(params: Dict[str, Any]) -> Any:
    stockfish_path: str = params.get("stockfish_path", engine_mgr.settings.get("stockfish_path", "stockfish"))
    # Snapshot history under the board lock (fast), then release before heavy computation.
    with _board_lock:
        fen_list, moves = engine_mgr.history_fens_and_moves()
    return accuracy_analyser.calculate(fen_list, moves, stockfish_path=stockfish_path)


def handle_calculate_accuracy_from_pgn(params: Dict[str, Any]) -> Any:
    pgn_text = str(params.get("pgn", ""))
    stockfish_path: str = params.get("stockfish_path", engine_mgr.settings.get("stockfish_path", "stockfish"))
    if not pgn_text.strip():
        return {"error": "Missing PGN", "moves": [], "white_accuracy": 0, "black_accuracy": 0}

    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        return {"error": "Invalid PGN", "moves": [], "white_accuracy": 0, "black_accuracy": 0}

    board = game.board()
    fen_list: list[str] = []
    moves: list[str] = []
    for move in game.mainline_moves():
        fen_list.append(board.fen())
        moves.append(move.uci())
        board.push(move)
    return accuracy_analyser.calculate(fen_list, moves, stockfish_path=stockfish_path)


def handle_estimate_elo(params: Dict[str, Any]) -> Any:
    accuracy = float(params["accuracy"])
    blunder_rate = float(params.get("blunder_rate", 0.0))
    avg_cp_loss = float(params.get("avg_cp_loss", 0.0))
    return accuracy_analyser.estimate_elo(accuracy, blunder_rate, avg_cp_loss)


def handle_get_book_moves(params: Dict[str, Any]) -> Any:
    fen = params.get("fen") or engine_mgr.fen()
    books_dir = params.get("books_dir", "resources/books")
    return engine_mgr.get_book_moves(fen, books_dir=books_dir)


def handle_get_eval(params: Dict[str, Any]) -> Any:
    """Get evaluation from MentorEngine's evaluation function (custom eval)."""
    fen = params.get("fen") or engine_mgr.fen()
    use_mentor_eval = params.get("use_mentor_eval", True)
    if not use_mentor_eval:
        return {"eval_cp": None, "note": "Mentor eval disabled"}
    return engine_mgr.get_mentor_eval(fen)


def handle_start_analysis(params: Dict[str, Any]) -> Any:
    fen = params.get("fen") or engine_mgr.fen()
    multipv = int(params.get("multipv", 3))
    callback_id = str(params["callback_id"])
    stockfish_path = params.get("stockfish_path", engine_mgr.settings.get("stockfish_path", "stockfish"))
    threads = params.get("threads")
    hash_mb = params.get("hash_mb")
    engine_mgr.start_analysis(
        fen=fen,
        multipv=multipv,
        callback_id=callback_id,
        stockfish_path=stockfish_path,
        threads=threads,
        hash_mb=hash_mb,
        push_fn=_send,
    )
    return {"started": True}


def handle_stop_analysis(_params: Dict[str, Any]) -> Any:
    engine_mgr.stop_analysis()
    return {"stopped": True}


# ── Dispatch table ────────────────────────────────────────────────────────────

HANDLERS: Dict[str, Any] = {
    "new_game":           handle_new_game,
    "make_move":          handle_make_move,
    "get_legal_moves":    handle_get_legal_moves,
    "undo_move":          handle_undo_move,
    "navigate_to_move":   handle_navigate_to_move,
    "get_engine_move":    handle_get_engine_move,
    "get_bot_move":       handle_get_bot_move,
    "get_eval":          handle_get_eval,
    "export_pgn":         handle_export_pgn,
    "import_pgn":         handle_import_pgn,
    "export_fen":         handle_export_fen,
    "calculate_accuracy": handle_calculate_accuracy,
    "calculate_accuracy_from_history": handle_calculate_accuracy_from_history,
    "calculate_accuracy_from_pgn": handle_calculate_accuracy_from_pgn,
    "estimate_elo":       handle_estimate_elo,
    "get_book_moves":     handle_get_book_moves,
    "start_analysis":     handle_start_analysis,
    "stop_analysis":      handle_stop_analysis,
    "maia3_cache":         handle_maia3_cache,
    "check_maia3_cache":   handle_check_maia3_cache,
}

# Commands that mutate board state — must hold _board_lock
_BOARD_MUTATION_CMDS = frozenset({
    "new_game", "make_move", "undo_move", "navigate_to_move", "import_pgn",
})

# Commands that read board state — also hold _board_lock (fast, safe)
_BOARD_READ_CMDS = frozenset({
    "get_legal_moves", "export_pgn", "export_fen", "get_book_moves",
})

# Commands that operate on a FEN from params + need no board lock:
#   get_engine_move, get_bot_move, calculate_accuracy,
#   estimate_elo, start_analysis, stop_analysis, maia3_cache
# calculate_accuracy_from_history acquires the lock internally (snapshot only).


# ── Per-request dispatcher (runs in its own daemon thread) ───────────────────

def _process_request(request_id: str, command: str, params: Dict[str, Any]) -> None:
    """Execute one JSON-RPC request and send the response.

    Board-mutating and board-reading commands run under *_board_lock*.
    Engine / analysis commands run without any lock so they never block
    the rest of the system while Stockfish is thinking.
    """
    handler = HANDLERS.get(command)
    if handler is None:
        _err(request_id, f"Unknown command: {command}")
        return

    try:
        if command == "new_game":
            # Stop analysis before we acquire _board_lock for new_game so
            # waiting on analysis thread teardown does not block board traffic.
            engine_mgr.stop_analysis()

        if command in _BOARD_MUTATION_CMDS or command in _BOARD_READ_CMDS:
            with _board_lock:
                result = handler(params)
        else:
            # Engine / accuracy / analysis — no board lock; may block for a while
            result = handler(params)
        _ok(request_id, result)
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        _err(request_id, str(exc))


# ── Main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    # Force UTF-8 on Windows
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

    sys.stderr.write("[aether_backend] ready\n")
    sys.stderr.flush()

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        try:
            msg = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            sys.stderr.write(f"[aether_backend] JSON parse error: {exc}\n")
            sys.stderr.flush()
            continue

        request_id: str = msg.get("id", "")
        command: str = msg.get("command", "")
        params: Dict[str, Any] = msg.get("params", {})

        # Dispatch every request to a daemon thread so stdin reading is
        # *never* blocked — the UI stays fully responsive at all times.
        t = threading.Thread(
            target=_process_request,
            args=(request_id, command, params),
            daemon=True,
        )
        t.start()


if __name__ == "__main__":
    main()
