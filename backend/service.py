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
Every incoming request is submitted to a module-level ThreadPoolExecutor
(max_workers=8, _REQUEST_POOL) immediately, so the stdin reader loop is
*never* blocked — the UI stays responsive even when Stockfish is thinking
or a full-game accuracy analysis is running.

  • Board-mutation commands (make_move, undo_move, new_game, …) serialise
    under _board_lock.  They are fast (< 1 ms), so holding that lock is fine.

  • Board read-only commands (get_legal_moves, export_pgn, …) also hold
    _board_lock briefly for safety.

  • Engine commands (get_engine_move, get_bot_move, start_analysis) hold
    _uci_lock for the whole search.  python-chess engine handles are not
    safe for concurrent use: overlapping searches interleave the UCI
    protocol and corrupt replies, so searches serialise — that wait is
    the point.

  • Engine handlers that fall back to the shared board FEN
    (get_engine_move, get_bot_move, get_eval, start_analysis) snapshot it
    under _board_lock first and release BEFORE taking _uci_lock, so board
    traffic never blocks on a search.

  • Lock order: _board_lock is outer, _uci_lock is inner — never the
    reverse.  No path holds both at once.

  • calculate_accuracy_from_history briefly acquires _board_lock to snapshot
    history, then releases it BEFORE the long Stockfish computation.

  • All stdout writes are serialised under _stdout_lock to prevent
    interleaved JSON across concurrent threads.
"""

from __future__ import annotations

import atexit
import io
import json
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict

import chess
import chess.pgn
from analysis import AccuracyAnalyser

# Import domain modules (same package when running from source; bundled by
# PyInstaller they are included via hidden-imports in the .spec file).
from chess_engine import ChessEngineManager

# P3-T02: canonical settings schema — the service boundary clamps IPC
# numerics through it before the engine stores them, and serves the
# canonical defaults/limits to the renderer via `settings_defaults`.
from settings_schema import settings_defaults, validate_settings

# ── Global state ─────────────────────────────────────────────────────────────

engine_mgr = ChessEngineManager()
accuracy_analyser = AccuracyAnalyser()

# Protects all reads/writes to engine_mgr.board / game_state
_board_lock = threading.Lock()

# Serialises the shared UCI engine handle(s) behind BotManager and the
# analysis engine. python-chess handles are not safe for concurrent use:
# overlapping searches interleave the protocol and corrupt replies, so every
# engine call holds this for the whole search.
_uci_lock = threading.Lock()

# Serialises stdout writes so JSON lines never interleave across threads
_stdout_lock = threading.Lock()

# Lock order (deadlock safety): _board_lock is outer, _uci_lock is inner,
# never the reverse. In practice no path holds both at once: handlers
# snapshot the FEN under _board_lock, release it, then take _uci_lock for
# the search, so board traffic never blocks on a search.

# Bounded pool for request handling (replaces one unbounded daemon thread
# per request). The stdin loop only submits and never blocks on a search.
_REQUEST_POOL = ThreadPoolExecutor(max_workers=8)


class ThreadLocalStream:
    """A per-thread routing proxy around a real text stream.

    Installed once over sys.stdout / sys.stderr at startup. While the calling
    thread holds a capture (see _ThreadCapture), write/flush go to that
    thread's buffer; otherwise they go to the wrapped real stream. Threads
    never observe each other's captures, so one request's download chatter
    cannot swallow another request's JSON-RPC reply.
    """

    def __init__(self, wrapped: Any) -> None:
        self._wrapped = wrapped
        self._local: Any = threading.local()

    def _route(self) -> Any:
        if getattr(self._local, "depth", 0) > 0:
            buf = getattr(self._local, "buffer", None)
            if buf is not None:
                return buf
        return self._wrapped

    def write(self, data: Any) -> Any:
        return self._route().write(data)

    def writelines(self, lines: Any) -> None:
        self._route().writelines(lines)

    def flush(self) -> None:
        self._route().flush()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._wrapped, name)


class _ThreadCapture:
    """Capture this thread's stdout/stderr on the installed proxies.

    A plain with-block (no contextlib needed): __exit__ always runs, so the
    depth counter resets even when the captured call raises. The captured
    stderr text stays available for the tqdm pass-through filter.
    """

    def __init__(self) -> None:
        self.stdout_buf = io.StringIO()
        self.stderr_buf = io.StringIO()
        self._entered: list[Any] = []

    def __enter__(self) -> _ThreadCapture:
        for stream, buf in (
            (sys.stdout, self.stdout_buf),
            (sys.stderr, self.stderr_buf),
        ):
            if isinstance(stream, ThreadLocalStream):
                local = stream._local
                local.depth = getattr(local, "depth", 0) + 1
                self._entered.append((local, getattr(local, "buffer", None)))
                local.buffer = buf
        return self

    def __exit__(self, *exc_info: Any) -> bool:
        for local, prev in reversed(self._entered):
            local.buffer = prev
            local.depth = getattr(local, "depth", 1) - 1
        self._entered = []
        return False

    @property
    def stderr_text(self) -> str:
        return self.stderr_buf.getvalue()


def _cleanup() -> None:
    _REQUEST_POOL.shutdown(wait=True)
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
    # P3-T02: clamp the engine numerics at the IPC boundary (junk like
    # threads=99999 becomes 8 here, before the engine stores anything).
    # Absent keys stay absent (validate only touches present keys).
    params = validate_settings(params)
    mode = params.get("mode", "human_vs_ai")
    engine_type = params.get("engine_type", "stockfish")
    human_color = params.get("human_color", "white")
    strength = int(params.get("strength", 7))
    time_control = params.get(
        "time_control", None
    )  # {"seconds": int, "increment": int}
    stockfish_path = params.get("stockfish_path")
    maia3_path = params.get("maia3_path")
    maia3_model = params.get("maia3_model")
    maia3_device = params.get("maia3_device")
    maia3_elo = params.get("maia3_elo")
    think_profile = params.get("think_profile")
    threads = params.get("threads")
    hash_mb = params.get("hash_mb")
    multipv = params.get("multipv")
    # P2-T09: optional custom start position (black-to-move FEN loads).
    # Absent → standard startpos; the renderer sends nothing today.
    fen = params.get("fen")

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
        fen=fen,
    )
    # P3-T01 tick-push lifecycle (called under _board_lock by the
    # dispatcher): a live clock gets a 1 Hz `clock_tick` push loop so the
    # renderer needs no client-side timer; Unlimited (or a missing control)
    # stops any previous loop. `_send` is stdout-locked, safe from the thread.
    if engine_mgr._white_ms is not None:
        engine_mgr.start_clock_push(_send)
    else:
        engine_mgr.stop_clock_push()
    return engine_mgr._state_snapshot()


def handle_make_move(params: Dict[str, Any]) -> Any:
    move_uci = str(params["move"])
    success, info = engine_mgr.make_move(move_uci)
    if not success:
        raise ValueError(info.get("reason") or f"Illegal move: {move_uci}")
    return info


def handle_resign(params: Dict[str, Any]) -> Any:
    """Record a resignation. `params["side"]` is the LOSING side."""
    side = str(params.get("side", ""))
    success, info = engine_mgr.resign(side)
    if not success:
        raise ValueError(info.get("reason") or f"Resign failed: {side!r}")
    return info


def handle_draw(_params: Dict[str, Any]) -> Any:
    """Record an agreed draw (1/2-1/2)."""
    success, info = engine_mgr.draw()
    if not success:
        raise ValueError(info.get("reason") or "Draw failed")
    return info


def handle_get_legal_moves(params: Dict[str, Any]) -> Any:
    fen = params.get("fen")
    if fen:
        board = chess.Board(fen)
    else:
        board = engine_mgr.board
    moves = []
    for m in board.legal_moves:
        moves.append(
            {
                "uci": m.uci(),
                "san": board.san(m),
                "from": chess.square_name(m.from_square),
                "to": chess.square_name(m.to_square),
                "promotion": chess.piece_name(m.promotion) if m.promotion else None,
            }
        )
    return {"moves": moves}


def handle_undo_move(_params: Dict[str, Any]) -> Any:
    return engine_mgr.undo_move()


def handle_navigate_to_move(params: Dict[str, Any]) -> Any:
    index = int(params["index"])
    return engine_mgr.navigate_to(index)


def handle_get_engine_move(params: Dict[str, Any]) -> Any:
    # Snapshot the shared-board FEN under _board_lock, then release before
    # the search so board traffic never blocks on the engine.
    fen = params.get("fen")
    if not fen:
        with _board_lock:
            fen = engine_mgr.fen()
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
    total_moves = params.get("total_moves")
    strength = params.get("strength")
    with _uci_lock:
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
            total_moves=total_moves,
            strength=strength,
        )


def handle_get_bot_move(params: Dict[str, Any]) -> Any:
    """The mentor-bot entry point the renderer still calls.

    It now goes through the same dispatcher as every other bot instead of
    reaching into MentorEngine directly, so there is one move path with one
    result shape rather than two that could drift.
    """
    fen = params.get("fen")
    if not fen:
        with _board_lock:
            fen = engine_mgr.fen()
    strength = int(params.get("strength", engine_mgr.settings.get("strength", 7)))
    with _uci_lock:
        return engine_mgr.get_engine_move(
            fen,
            engine_type=params.get("engine_type", "mentor"),
            stockfish_path=params.get("stockfish_path"),
            threads=params.get("threads"),
            hash_mb=params.get("hash_mb"),
            strength=strength,
            think_profile=params.get("think_profile"),
            time_remaining=params.get("time_remaining"),
            time_increment=params.get("time_increment"),
            total_moves=params.get("total_moves"),
        )


def handle_list_bots(_params: Dict[str, Any]) -> Any:
    """The bots this install can actually run, with availability.

    The UI renders this list instead of hard-coding engine names, so a newly
    discovered Stockfish build or a new bot shows up without frontend changes.
    """
    return {"bots": engine_mgr.list_bots()}


def handle_settings_defaults(_params: Dict[str, Any]) -> Any:
    """Canonical settings defaults, limits and schema version (P3-T02).

    The renderer reads its DEFAULTS/limits from here at boot instead of
    restating them; when the backend is unreachable the renderer falls back
    to mirrored static constants (same numbers) so boot never blocks.
    """
    return settings_defaults()


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
    model = params.get("model", "maia3-5m")
    cache_dir = params.get("cache_dir")
    force_download = bool(params.get("force_download", False))
    token = params.get("hf_token")
    try:
        from maia3.cache import main as maia3_cache
    except Exception as exc:
        raise RuntimeError(
            f"Maia3 is not installed in this environment. Run: python -m pip install -e .\\inspiration [{exc}]"
        ) from exc

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
    with _ThreadCapture() as cap:
        try:
            maia3_cache(args)
        except SystemExit:
            pass
    for line in cap.stderr_text.splitlines():
        if "%" in line:
            print(line, file=sys.stderr)

    return {"ok": True, "model": model}


def handle_export_pgn(_params: Dict[str, Any]) -> Any:
    return {"pgn": engine_mgr.export_pgn()}


def handle_import_pgn(params: Dict[str, Any]) -> Any:
    pgn_text = str(params["pgn"])
    engine_mgr.stop_clock_push()
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
    stockfish_path: str = params.get(
        "stockfish_path", engine_mgr.settings.get("stockfish_path", "stockfish")
    )
    return accuracy_analyser.calculate(fen_list, moves, stockfish_path=stockfish_path)


def handle_calculate_accuracy_from_history(params: Dict[str, Any]) -> Any:
    stockfish_path: str = params.get(
        "stockfish_path", engine_mgr.settings.get("stockfish_path", "stockfish")
    )
    # Snapshot history under the board lock (fast), then release before heavy computation.
    with _board_lock:
        fen_list, moves = engine_mgr.history_fens_and_moves()
    return accuracy_analyser.calculate(fen_list, moves, stockfish_path=stockfish_path)


def handle_calculate_accuracy_from_pgn(params: Dict[str, Any]) -> Any:
    pgn_text = str(params.get("pgn", ""))
    stockfish_path: str = params.get(
        "stockfish_path", engine_mgr.settings.get("stockfish_path", "stockfish")
    )
    if not pgn_text.strip():
        print("[Elo] PGN empty", file=sys.stderr)
        return {
            "error": "Missing PGN",
            "moves": [],
            "white_accuracy": 0,
            "black_accuracy": 0,
        }

    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        print("[Elo] PGN invalid", file=sys.stderr)
        return {
            "error": "Invalid PGN",
            "moves": [],
            "white_accuracy": 0,
            "black_accuracy": 0,
        }

    board = game.board()
    fen_list: list[str] = []
    moves: list[str] = []
    for move in game.mainline_moves():
        fen_list.append(board.fen())
        moves.append(move.uci())
        board.push(move)
    print(
        f"[Elo] Analysing {len(moves)} moves with Stockfish (path: {stockfish_path}) …",
        file=sys.stderr,
    )
    result = accuracy_analyser.calculate(fen_list, moves, stockfish_path=stockfish_path)
    if result.get("error"):
        print(f"[Elo]  Error: {result['error']}", file=sys.stderr)
    else:
        print(
            f"[Elo]  Done — W:{result.get('white_accuracy', '?')} B:{result.get('black_accuracy', '?')}",
            file=sys.stderr,
        )
    return result


# P2-T19: num_games feeds `range(estimated_games)` in analysis.estimate_elo,
# so it is an IPC-fed loop bound — clamp it (a huge value is a CPU-DoS vector
# in the handler thread).
_MAX_ESTIMATE_ELO_GAMES = 100


def handle_estimate_elo(params: Dict[str, Any]) -> Any:
    accuracy = float(params["accuracy"])
    blunder_rate = float(params.get("blunder_rate", 0.0))
    avg_cp_loss = float(params.get("avg_cp_loss", 0.0))
    raw_num_games = params.get("num_games")
    num_games: Any = None
    if raw_num_games is not None:
        try:
            num_games = int(raw_num_games)
        except (TypeError, ValueError):
            raise ValueError(
                f"Invalid num_games: {raw_num_games!r} (expected an integer)"
            ) from None
        if num_games < 1:
            # analysis.py treats < 1 the same way (accuracy-based heuristic),
            # so normalize to None and let the heuristic path own it.
            num_games = None
        else:
            num_games = min(num_games, _MAX_ESTIMATE_ELO_GAMES)
    print(
        f"[Elo] estimate_elo — acc:{accuracy:.1f} blunder:{blunder_rate:.3f} cpl:{avg_cp_loss:.1f} games:{num_games}",
        file=sys.stderr,
    )
    result = accuracy_analyser.estimate_elo(
        accuracy,
        blunder_rate,
        avg_cp_loss,
        num_games=num_games,
    )
    print(
        f"[Elo]  → {result.get('estimated_elo', '?')}  CI:{result.get('confidence_interval', '?')}",
        file=sys.stderr,
    )
    return result


def handle_get_book_moves(params: Dict[str, Any]) -> Any:
    fen = params.get("fen") or engine_mgr.fen()
    books_dir = params.get("books_dir", "resources/books")
    return engine_mgr.get_book_moves(fen, books_dir=books_dir)


def handle_get_eval(params: Dict[str, Any]) -> Any:
    """Get evaluation from MentorEngine's evaluation function (custom eval)."""
    fen = params.get("fen")
    if not fen:
        with _board_lock:
            fen = engine_mgr.fen()
    use_mentor_eval = params.get("use_mentor_eval", True)
    if not use_mentor_eval:
        return {"eval_cp": None, "note": "Mentor eval disabled"}
    return engine_mgr.get_mentor_eval(fen)


def handle_start_analysis(params: Dict[str, Any]) -> Any:
    fen = params.get("fen")
    if not fen:
        with _board_lock:
            fen = engine_mgr.fen()
    multipv = int(params.get("multipv", 3))
    callback_id = str(params["callback_id"])
    stockfish_path = params.get(
        "stockfish_path", engine_mgr.settings.get("stockfish_path", "stockfish")
    )
    threads = params.get("threads")
    hash_mb = params.get("hash_mb")
    with _uci_lock:
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
    "new_game": handle_new_game,
    "make_move": handle_make_move,
    "resign": handle_resign,
    "draw": handle_draw,
    "get_legal_moves": handle_get_legal_moves,
    "undo_move": handle_undo_move,
    "navigate_to_move": handle_navigate_to_move,
    "get_engine_move": handle_get_engine_move,
    "get_bot_move": handle_get_bot_move,
    "list_bots": handle_list_bots,
    "settings_defaults": handle_settings_defaults,
    "get_eval": handle_get_eval,
    "export_pgn": handle_export_pgn,
    "import_pgn": handle_import_pgn,
    "export_fen": handle_export_fen,
    "calculate_accuracy": handle_calculate_accuracy,
    "calculate_accuracy_from_history": handle_calculate_accuracy_from_history,
    "calculate_accuracy_from_pgn": handle_calculate_accuracy_from_pgn,
    "estimate_elo": handle_estimate_elo,
    "get_book_moves": handle_get_book_moves,
    "start_analysis": handle_start_analysis,
    "stop_analysis": handle_stop_analysis,
    "maia3_cache": handle_maia3_cache,
    "check_maia3_cache": handle_check_maia3_cache,
}

# Commands that mutate board state — must hold _board_lock
_BOARD_MUTATION_CMDS = frozenset(
    {
        "new_game",
        "make_move",
        "undo_move",
        "navigate_to_move",
        "import_pgn",
        "resign",
        "draw",
    }
)

# Commands that read board state — also hold _board_lock (fast, safe)
_BOARD_READ_CMDS = frozenset(
    {
        "get_legal_moves",
        "export_pgn",
        "export_fen",
        "get_book_moves",
    }
)

# Engine / accuracy / analysis commands run without the dispatcher board
# lock (handlers snapshot the shared-board FEN under _board_lock only when
# params carry no FEN, and take _uci_lock for the search itself):
#   get_engine_move, get_bot_move, get_eval, start_analysis,
#   calculate_accuracy, estimate_elo, stop_analysis, maia3_cache.
# calculate_accuracy_from_history acquires the lock internally (snapshot only).


# ── Per-request dispatcher (runs in its own daemon thread) ───────────────────


def _process_request(request_id: str, command: str, params: Dict[str, Any]) -> None:
    """Execute one JSON-RPC request and send the response.

    Board-mutating and board-reading commands run under *_board_lock*.
    Engine commands take *_uci_lock* for the search (serialised whole
    searches) and snapshot any fallback FEN under *_board_lock* first;
    they never hold the board lock while Stockfish is thinking.
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
    # Install per-thread routing first, before any request thread can exist,
    # so a capture on one thread never observes another thread's writes.
    sys.stdout = ThreadLocalStream(sys.stdout)
    sys.stderr = ThreadLocalStream(sys.stderr)

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

        # Submit every request to the bounded pool so stdin reading is
        # *never* blocked — the UI stays fully responsive at all times.
        _REQUEST_POOL.submit(_process_request, request_id, command, params)


if __name__ == "__main__":
    main()
