from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import List, Optional

import chess


@dataclass
class TimeBucket:
    seconds: float
    weight: float


@dataclass
class ThinkProfile:
    name: str
    label: str
    description: str
    buckets: List[TimeBucket] = field(default_factory=list)


# ── Pre-built profiles ──────────────────────────────────────────────────────

BLITZ = ThinkProfile(
    name="blitz",
    label="Blitz",
    description="Fast instinctual play (1–8s typical)",
    buckets=[
        TimeBucket(1, 25),
        TimeBucket(2, 30),
        TimeBucket(3, 20),
        TimeBucket(4, 12),
        TimeBucket(5, 7),
        TimeBucket(6, 3),
        TimeBucket(7, 1.5),
        TimeBucket(8, 1),
        TimeBucket(10, 0.5),
    ],
)

RAPID = ThinkProfile(
    name="rapid",
    label="Rapid",
    description="Balanced thinking (2–15s typical)",
    buckets=[
        TimeBucket(1, 2),
        TimeBucket(2, 8),
        TimeBucket(3, 12),
        TimeBucket(4, 16),
        TimeBucket(5, 18),
        TimeBucket(6, 14),
        TimeBucket(7, 10),
        TimeBucket(8, 8),
        TimeBucket(10, 6),
        TimeBucket(15, 4),
        TimeBucket(20, 1.5),
        TimeBucket(25, 0.4),
        TimeBucket(30, 0.1),
    ],
)

CLASSICAL = ThinkProfile(
    name="classical",
    label="Classical",
    description="Deep calculation (5–120s typical)",
    buckets=[
        TimeBucket(2, 1),
        TimeBucket(5, 5),
        TimeBucket(8, 8),
        TimeBucket(10, 12),
        TimeBucket(15, 18),
        TimeBucket(20, 20),
        TimeBucket(25, 14),
        TimeBucket(30, 10),
        TimeBucket(40, 7),
        TimeBucket(60, 4),
        TimeBucket(120, 1),
    ],
)

HUMAN_LIKE = ThinkProfile(
    name="human_like",
    label="Human-like",
    description="Natural varied pacing from instinct to deep calculation",
    buckets=[
        TimeBucket(1, 10),
        TimeBucket(2, 14),
        TimeBucket(3, 16),
        TimeBucket(4, 13),
        TimeBucket(5, 11),
        TimeBucket(6, 9),
        TimeBucket(7, 7),
        TimeBucket(8, 5),
        TimeBucket(10, 6),
        TimeBucket(15, 4),
        TimeBucket(20, 2.5),
        TimeBucket(25, 1.2),
        TimeBucket(30, 0.7),
        TimeBucket(40, 0.4),
        TimeBucket(60, 0.15),
        TimeBucket(120, 0.05),
    ],
)

ALL_PROFILES: dict[str, ThinkProfile] = {
    p.name: p for p in [BLITZ, RAPID, CLASSICAL, HUMAN_LIKE]
}


def get_profile(name: str) -> ThinkProfile:
    """Look up a profile by name; return Human-like as fallback."""
    return ALL_PROFILES.get(name, HUMAN_LIKE)


# ── Budget-constrained sampling ──────────────────────────────────────────────

def _compute_safe_cap(
    time_remaining: float | None,
    time_increment: float | None,
    moves_left_estimate: int = 30,
) -> float | None:
    """Compute the maximum safe think time for the current move.

    Returns None if no clock constraint applies (unlimited time).
    """
    if time_remaining is None or time_remaining <= 0:
        return None  # Unlimited / no clock

    # Panic thresholds
    if time_remaining < 15:
        return 2.0
    if time_remaining < 60:
        return 5.0

    # Budget: evenly divide remaining time across estimated remaining moves
    inc = time_increment or 0
    budget_per_move = (time_remaining + inc * moves_left_estimate) / moves_left_estimate

    # Safe cap: allow occasional deep thought, but not reckless
    safe_max = max(budget_per_move * 2, budget_per_move + 10)
    safe_max = min(safe_max, time_remaining * 0.5)  # Never burn >50% of clock on one move
    return safe_max


def _position_complexity(board: chess.Board) -> float:
    """Compute a complexity multiplier 0.7–1.5x based on position."""
    legal_moves = min(board.legal_moves.count(), 60)  # count is O(1)

    # How many legal moves (more = more options to evaluate)
    move_factor = legal_moves / 35.0  # ~1.0 at 35 moves, 0.5 at 17, 1.7 at 60

    # Piece density (more stuff on board = more complex)
    piece_count = chess.popcount(board.occupied)
    piece_factor = piece_count / 28.0  # ~1.0 at 28 pieces

    # Urgency: in check means react faster (instinct)
    urgency = 0.85 if board.is_check() else 1.0

    # Combine
    raw = 0.7 + 0.4 * move_factor + 0.2 * piece_factor
    raw = max(0.6, min(1.5, raw))
    return raw * urgency


def sample_think_time(
    profile: ThinkProfile,
    board: chess.Board | None = None,
    time_remaining: float | None = None,
    time_increment: float | None = None,
    moves_left_estimate: int = 30,
) -> float:
    """Sample a think time from the given profile under clock constraints.

    1. Compute safe cap from clock budget
    2. Filter buckets that fit within the cap
    3. Weighted random sample from eligible buckets
    4. Modulate by position complexity + jitter
    """
    safe_cap = _compute_safe_cap(time_remaining, time_increment, moves_left_estimate)

    # Filter buckets that fit within the safe cap
    eligible = profile.buckets
    if safe_cap is not None:
        eligible = [b for b in eligible if b.seconds <= safe_cap]
        if not eligible:
            # Shouldn't happen unless panic mode, use the smallest bucket
            smallest = min(profile.buckets, key=lambda b: b.seconds)
            return smallest.seconds

    # Weighted sample from eligible buckets
    buckets_pop = eligible
    weights = [b.weight for b in buckets_pop]
    bucket = random.choices(buckets_pop, weights=weights)[0]

    base_time = bucket.seconds

    # Position complexity modulation
    if board is not None:
        base_time *= _position_complexity(board)

    # Small jitter within ±15%
    jitter = random.uniform(0.85, 1.15)
    result = base_time * jitter

    # Clamp by safe cap (jitter could push it over)
    if safe_cap is not None:
        result = min(result, safe_cap)

    return max(0.2, result)  # Never less than 200ms
