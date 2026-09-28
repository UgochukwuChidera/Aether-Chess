#!/usr/bin/env python3
"""Fake backend fixture for hermetic Electron e2e tests (P0-T12).

Speaks the same newline-delimited JSON-RPC wire format as
``backend/service.py``: one JSON object per stdin line shaped
``{"id": ..., "command": ..., "params": {...}}``, one JSON object per
stdout line shaped ``{"id": ..., "result": ...}`` (or
``{"id": ..., "error": ...}``), flushed per line.

STDLIB ONLY (``json``/``sys``/``re``). This is what makes the smoke
spec's "no Python deps" done-when true: any bare ``python3`` can run
this file. ("No Python installed" in the plan means no third-party
packages need installing — the interpreter itself is still required to
execute the fixture, exactly as it is to execute the real backend.)

Rules mirrored from the real service:
- Unknown commands answer ``{"id": ..., "error": ...}`` — never crash,
  never print stray stdout (stray prints break python-shell's JSON
  framing). Diagnostics go to stderr only.
- Malformed input lines are logged to stderr and skipped.
- EOF on stdin (backend shutdown) exits cleanly with status 0.

Canned state is deliberately minimal: the fixture tracks a move list
and always reports the starting position FEN. That is enough for the
renderer to complete its boot handshake (``new_game`` ->
``applyMoveResult`` -> board render) without a chess library. Field
names copy ``backend/chess_engine.py::_state_snapshot`` exactly
(``fen``/``turn``/``legal_moves``/``move_history``/``full_move_history``/
``last_move_san``/``last_move_uci``/``nav_index``/``game_over``/
``result``/``termination``/``in_check``) so consumers never branch on
which backend answered.
"""

from __future__ import annotations

import json
import re
import sys
import time
from typing import Any, Dict, List

START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

_UCI_RE = re.compile(r"^[a-h][1-8][a-h][1-8][qrbnQRBN]?$")

# A few plausible white/black opening UCIs. Only prefix/shape behaviour
# matters to the renderer (square selection filters legalMoves by
# startsWith(square)); legality is NOT enforced — there is no chess
# library here by design.
_OPENING_UCIS = [
    "e2e4",
    "d2d4",
    "g1f3",
    "c2c4",
    "e7e5",
    "e2e3",
]


def _log(msg: str) -> None:
    sys.stderr.write(f"[fake-backend] {msg}\n")
    sys.stderr.flush()


def _send(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


# Fake game state: ordered list of UCI strings played so far.
_moves: List[str] = []


def _snapshot(last_san: str = "") -> Dict[str, Any]:
    turn = "white" if len(_moves) % 2 == 0 else "black"
    return {
        "fen": START_FEN,
        "turn": turn,
        "legal_moves": list(_OPENING_UCIS),
        "move_history": [],
        "full_move_history": list(_moves),
        "last_move_san": last_san,
        "last_move_uci": _moves[-1] if _moves else None,
        "nav_index": -1,
        "game_over": False,
        "result": None,
        "termination": None,
        "in_check": False,
    }


def _handle_new_game(_params: Dict[str, Any]) -> Any:
    del _moves[:]
    return _snapshot()


def _handle_get_legal_moves(_params: Dict[str, Any]) -> Any:
    return {
        "moves": [
            {
                "uci": uci,
                "san": uci,
                "from": uci[:2],
                "to": uci[2:4],
                "promotion": None,
            }
            for uci in _OPENING_UCIS
        ]
    }


def _handle_make_move(params: Dict[str, Any]) -> Any:
    move = params.get("move")
    if not isinstance(move, str) or not _UCI_RE.match(move):
        raise ValueError(f"Illegal move: {move}")
    _moves.append(move)
    return _snapshot(last_san=move)


def _engine_move_result(bot_id: str) -> Dict[str, Any]:
    # Same keys as aether_chess/bots/base.py::BotMove.to_dict(), which is
    # the wire form the renderer reads (it only needs ``move``).
    return {
        "move": "e7e5",
        "san": "e5",
        "from_book": False,
        "bot_id": bot_id,
        "eval_cp": 20,
        "depth": 12,
        "elapsed_sec": 0.01,
        "ponder": None,
        "is_mate": False,
        "mate_in": None,
    }


def _handle_get_engine_move(_params: Dict[str, Any]) -> Any:
    return _engine_move_result("stockfish")


def _handle_get_bot_move(_params: Dict[str, Any]) -> Any:
    return _engine_move_result("mentor")


def _handle_list_bots(_params: Dict[str, Any]) -> Any:
    # Same keys as BotManager.describe() / renderer BotInfo.
    return {
        "bots": [
            {
                "bot_id": "stockfish",
                "display_name": "Stockfish",
                "kind": "uci",
                "description": "Fake Stockfish (e2e fixture)",
                "requires_binary": True,
                "supports_skill_level": True,
                "supports_elo": False,
                "supports_eval": True,
                "deterministic": False,
                "available": True,
                "is_default": True,
            },
            {
                "bot_id": "mentor",
                "display_name": "Mentor",
                "kind": "builtin",
                "description": "Fake Mentor (e2e fixture)",
                "requires_binary": False,
                "supports_skill_level": True,
                "supports_elo": False,
                "supports_eval": True,
                "deterministic": True,
                "available": True,
                "is_default": False,
            },
        ]
    }


def _handle_get_book_moves(_params: Dict[str, Any]) -> Any:
    # Empty book: the renderer's AI path falls through to get_engine_move.
    return {"moves": []}


def _handle_start_analysis(_params: Dict[str, Any]) -> Any:
    # The renderer tolerates a backend that never pushes analysis_update
    # events; answering {started: True} keeps the boot analysis handshake
    # from logging errors.
    return {"started": True}


def _handle_stop_analysis(_params: Dict[str, Any]) -> Any:
    return {"stopped": True}


def _handle_get_eval(_params: Dict[str, Any]) -> Any:
    return {"eval_cp": 24, "phase": 1.0, "mg_score": 0, "eg_score": 0}


def _handle_export_pgn(_params: Dict[str, Any]) -> Any:
    return {"pgn": ""}


def _handle_export_fen(_params: Dict[str, Any]) -> Any:
    return {"fen": START_FEN}


def _handle_undo_move(_params: Dict[str, Any]) -> Any:
    if _moves:
        _moves.pop()
    return _snapshot()


def _handle_navigate_to_move(_params: Dict[str, Any]) -> Any:
    return _snapshot()


HANDLERS = {
    "new_game": _handle_new_game,
    "get_legal_moves": _handle_get_legal_moves,
    "make_move": _handle_make_move,
    "get_engine_move": _handle_get_engine_move,
    "get_bot_move": _handle_get_bot_move,
    "list_bots": _handle_list_bots,
    "get_book_moves": _handle_get_book_moves,
    "start_analysis": _handle_start_analysis,
    "stop_analysis": _handle_stop_analysis,
    "get_eval": _handle_get_eval,
    "export_pgn": _handle_export_pgn,
    "export_fen": _handle_export_fen,
    "undo_move": _handle_undo_move,
    "navigate_to_move": _handle_navigate_to_move,
}


def main() -> None:
    _log("ready")
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            _log(f"JSON parse error: {exc}")
            continue
        request_id = msg.get("id", "")
        command = msg.get("command", "")
        params = msg.get("params", {}) or {}
        # P2-T05 test hook: `__hang_sec` holds the request open so the
        # backend-death spec can SIGKILL mid-flight deterministically.
        # Absent (every other spec) this is a no-op.
        hang_s = params.get("__hang_sec")
        if isinstance(hang_s, (int, float)) and hang_s > 0:
            time.sleep(hang_s)
        handler = HANDLERS.get(command)
        if handler is None:
            _send({"id": request_id, "error": f"Unknown command: {command}"})
            continue
        try:
            _send({"id": request_id, "result": handler(params)})
        except Exception as exc:  # never let one bad request kill the loop
            _send({"id": request_id, "error": str(exc)})
    # EOF on stdin: the host closed the pipe — exit quietly.
    _log("stdin closed, exiting")


if __name__ == "__main__":
    main()
