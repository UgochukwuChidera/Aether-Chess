"""backend/settings_schema.py — canonical settings definition (P3-T02).

Every engine/memory limit lives HERE and nowhere else. ``chess_engine.py``
and ``service.py`` both clamp through these helpers, so there is a single
clamp implementation, not two. The renderer fetches the limits at boot via
the ``settings_defaults`` command and falls back to mirrored constants when
the backend is unreachable.

Authority decision: the caps are the backend's setoption safety limits —
8 threads / 512 MB / 5 multipv — not the renderer's 64/2048. Evidence:
``SettingsPanel`` itself calls 512 MB / 4+ threads "high-end" and warns
past 512 MB, and the threads slider is already CPU-count bound, so the
64-thread clamp never binds except on junk.

Unknown-key policy: preserve-forward. ``electron/main.ts`` merges persisted
data over defaults (``{...defaults, ...data}``) and round-trips it through
``settings.json`` untouched, so dropping unknown keys here would destroy a
newer version's settings on load. Validate what we know, keep the rest.

Migration: ``schemaVersion`` stamps the persisted JSON. Missing (v0) files
are filled from defaults and stamped v1. A *future* version is never
crashed on: known numerics are clamped best-effort and the newer stamp is
kept, so a newer app does not re-migrate on the way back.
"""

from __future__ import annotations

import math
from typing import Any, Dict

# ── Schema version ──────────────────────────────────────────────────────
SCHEMA_VERSION = 1

# ── Canonical limits (the ONE authority) ────────────────────────────────
MIN_THREADS = 1
MAX_THREADS = 8
MIN_HASH_MB = 16
MAX_HASH_MB = 512
MIN_MULTIPV = 1
MAX_MULTIPV = 5

# ── Canonical defaults (engine-owned keys) ──────────────────────────────
DEFAULT_THREADS = 1
DEFAULT_HASH_MB = 128
DEFAULT_MULTIPV = 3


def _coerce_int(value: Any, default: int) -> int:
    """Lenient int coercion: junk (text, NaN, inf, None) yields ``default``."""
    try:
        if value is None:
            return default
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, float):
            if not math.isfinite(value):
                return default
            return int(round(value))
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def clamp_threads(value: Any, default: int = DEFAULT_THREADS) -> int:
    """Clamp a thread count to [1, 8]; junk yields ``default``."""
    return max(MIN_THREADS, min(MAX_THREADS, _coerce_int(value, default)))


def clamp_hash_mb(value: Any, default: int = DEFAULT_HASH_MB) -> int:
    """Clamp a transposition-table size to [16, 512] MB; junk → ``default``."""
    return max(MIN_HASH_MB, min(MAX_HASH_MB, _coerce_int(value, default)))


def clamp_multipv(value: Any, default: int = DEFAULT_MULTIPV) -> int:
    """Clamp principal-variation lines to [1, 5]; junk yields ``default``."""
    return max(MIN_MULTIPV, min(MAX_MULTIPV, _coerce_int(value, default)))


def clamp_maia_elo(value: Any, default: int = 1500) -> int:
    """Clamp a Maia Elo rating to [0, 5000]; junk yields ``default``."""
    return max(0, min(5000, _coerce_int(value, default)))


def engine_defaults() -> Dict[str, Any]:
    """Fresh-engine settings: must equal ``ChessEngineManager().settings``."""
    return {
        "threads": DEFAULT_THREADS,
        "hash_mb": DEFAULT_HASH_MB,
        "multipv": DEFAULT_MULTIPV,
        "strength": 7,
        "think_profile": "human_like",
        "maia3_elo": 1500,
        "stockfish_path": "stockfish",
        "maia3_model": "maia3-5m",
        "maia3_device": "cpu",
    }


def settings_limits() -> Dict[str, int]:
    """The canonical limits payload served to the renderer at boot."""
    return {
        "min_threads": MIN_THREADS,
        "max_threads": MAX_THREADS,
        "min_hash_mb": MIN_HASH_MB,
        "max_hash_mb": MAX_HASH_MB,
        "min_multipv": MIN_MULTIPV,
        "max_multipv": MAX_MULTIPV,
    }


def settings_defaults() -> Dict[str, Any]:
    """Full ``settings_defaults`` command payload: version + defaults + limits."""
    return {
        "schemaVersion": SCHEMA_VERSION,
        "defaults": engine_defaults(),
        "limits": settings_limits(),
    }


def validate_settings(raw: Any) -> Dict[str, Any]:
    """Clamp the known engine keys of ``raw``; preserve everything else.

    Only keys PRESENT are touched — absent keys stay absent, so per-request
    IPC params (where missing means "don't change") can pass through this
    safely. Unknown keys are preserved-forward, never dropped.
    """
    data = dict(raw) if isinstance(raw, dict) else {}
    out = dict(data)
    if "threads" in data:
        out["threads"] = clamp_threads(data["threads"])
    if "hash_mb" in data:
        out["hash_mb"] = clamp_hash_mb(data["hash_mb"])
    if "multipv" in data:
        out["multipv"] = clamp_multipv(data["multipv"])
    if "maia3_elo" in data:
        out["maia3_elo"] = clamp_maia_elo(data["maia3_elo"])
    return out


def migrate_settings(raw: Any) -> Dict[str, Any]:
    """Bring persisted data onto the current schema (forward-compatible).

    Missing/invalid version (v0) → fill defaults, clamp, stamp v1.
    Future version → keep every key and the newer stamp, clamp only the
    known numerics best-effort. Never raises on shape: non-dicts migrate
    to fresh defaults.
    """
    data = dict(raw) if isinstance(raw, dict) else {}
    try:
        version = int(data.get("schemaVersion", 0))
    except (TypeError, ValueError):
        version = 0
    if version > SCHEMA_VERSION:
        out = validate_settings(data)
        out["schemaVersion"] = version
        return out
    merged = {**engine_defaults(), **data}
    merged["schemaVersion"] = SCHEMA_VERSION
    return validate_settings(merged)
