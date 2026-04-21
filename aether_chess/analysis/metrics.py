from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, List, Tuple


def cp_to_win_pct(cp: float) -> float:
    return 100.0 / (1.0 + math.exp(-cp / 120.0))


def classify_move(cp_loss: float, is_book: bool = False) -> str:
    if is_book:
        return "Book"
    if cp_loss <= 15:
        return "Best"
    if cp_loss <= 35:
        return "Great"
    if cp_loss <= 75:
        return "Inaccuracy"
    if cp_loss <= 150:
        return "Mistake"
    return "Blunder"


def accuracy_from_losses(cp_losses: Iterable[float], expected_loss: float = 65.0) -> float:
    losses = [max(0.0, x) for x in cp_losses]
    if not losses:
        return 100.0
    avg_loss = sum(losses) / len(losses)
    acc = 100.0 * (1.0 - (avg_loss / max(expected_loss, 1e-6)))
    return max(0.0, min(100.0, acc))


@dataclass
class BayesianEloResult:
    rating: float
    rd: float
    ci95: Tuple[float, float]


def estimate_bayesian_elo(
    performance_scores: List[float],
    opponent_rating: float = 2000.0,
    prior_mean: float = 1500.0,
    prior_sd: float = 350.0,
) -> BayesianEloResult:
    if not performance_scores:
        return BayesianEloResult(prior_mean, prior_sd, (prior_mean - 1.96 * prior_sd, prior_mean + 1.96 * prior_sd))

    r = prior_mean
    prior_var = prior_sd * prior_sd

    for _ in range(30):
        grad = -(r - prior_mean) / prior_var
        hess = -1.0 / prior_var
        for s in performance_scores:
            x = math.log(10) * (opponent_rating - r) / 400.0
            x = max(-60.0, min(60.0, x))
            e = 1.0 / (1.0 + math.exp(x))
            d = math.log(10) / 400.0
            grad += (s - e) * d
            hess -= e * (1 - e) * (d * d)
        if hess == 0:
            break
        step = grad / hess
        r -= step
        if abs(step) < 1e-4:
            break

    posterior_var = max(1.0, -1.0 / hess) if hess < 0 else prior_var
    rd = math.sqrt(posterior_var)
    return BayesianEloResult(rating=r, rd=rd, ci95=(r - 1.96 * rd, r + 1.96 * rd))
