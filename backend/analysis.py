"""
backend/analysis.py — Accuracy scoring and Elo estimation using the existing
aether_chess analysis modules.
"""
from __future__ import annotations

import math
import os
import sys
from typing import Any, Dict, List, Optional

import chess
import chess.engine

_HERE = os.path.dirname(__file__)
_ROOT = os.path.join(_HERE, "..")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from aether_chess.analysis.metrics import (
    classify_move,
    cp_to_win_pct,
    accuracy_from_losses,
    estimate_bayesian_elo,
)

_ANALYSIS_DEPTH = 18


def _score_position(engine: chess.engine.SimpleEngine, board: chess.Board) -> float:
    """Return centipawn score for *board* from the current side's perspective."""
    info = engine.analyse(board, chess.engine.Limit(depth=_ANALYSIS_DEPTH))
    score = info["score"].white()
    cp = score.score(mate_score=10_000)
    return float(cp) if cp is not None else 0.0


class GlickoRating:
    """
    Glicko-2 inspired rating system.
    https://www.glicko.net/glicko/glicko.pdf
    """

    TAU = 0.5
    RD_MIN = 30.0
    RD_MAX = 350.0
    DEFAULT_RD = 200.0

    def __init__(
        self,
        rating: float = 1500.0,
        rd: float = DEFAULT_RD,
        vol: float = 0.06,
    ) -> None:
        self.rating = rating
        self.rd = rd
        self.vol = vol

    def _g(self, phi: float) -> float:
        return 1.0 / math.sqrt(1.0 + 3.0 * (phi ** 2) / (math.pi ** 2))

    def _E(self, mu: float, mu_j: float, phi: float) -> float:
        g = self._g(phi)
        return 1.0 / (1.0 + math.exp(-g * (mu - mu_j)))

    def update_single(
        self,
        opponent_rating: float,
        opponent_rd: float,
        result: float,
    ) -> None:
        """
        Update rating after a single game.
        result: 1.0 = win, 0.5 = draw, 0.0 = loss
        """
        q = math.log(10.0) / 400.0
        phi = self.rd / 173.7178
        phi_j = opponent_rd / 173.7178
        mu = (self.rating - 1500.0) / 173.7178
        mu_j = (opponent_rating - 1500.0) / 173.7178
        g_j = self._g(phi_j)
        E_j = self._E(mu, mu_j, phi_j)
        s_j = result
        tmp = (q ** 2) * (g_j ** 2) * E_j * (1.0 - E_j)
        Phi = math.sqrt(1.0 / ((1.0 / (phi ** 2)) + tmp))
        tmp2 = (q ** 2) * (g_j ** 2) * (s_j - E_j)
        delta = (Phi ** 2) * tmp2
        a = math.log(self.vol ** 2)
        def f(x: float) -> float:
            ex = math.exp(x)
            num = ex * (delta ** 2 - phi ** 2 - tmp * ex)
            denom = 2.0 * ((phi ** 2) + tmp * ex) ** 2
            return num / denom - (x - a)
        A = a
        if delta ** 2 > phi ** 2 + tmp * math.exp(a):
            B = math.log(delta ** 2 - phi ** 2)
        else:
            k = 1
            while f(a + k * self.TAU) < 0:
                k += 1
            B = a + k * self.TAU
        fA = f(A)
        fB = f(B)
        while abs(B - A) > 0.00001:
            C = A + (A - B) * fA / (fB - fA)
            fC = f(C)
            if fC * fB < 0:
                A, fA = B, fB
            else:
                fA = fA / 2.0
            B, fB = C, fC
        new_vol = math.exp(A / 2.0)
        new_phi = math.sqrt(1.0 / ((1.0 / (phi ** 2)) + tmp))
        new_mu = mu + (q ** 2) * (g_j ** 2) * (s_j - E_j) / (1.0 / (phi ** 2) + tmp)
        self.rating = 173.7178 * new_mu + 1500.0
        self.rd = max(self.RD_MIN, min(self.RD_MAX, 173.7178 * new_phi))
        self.vol = max(0.001, min(0.1, new_vol))

    def ci95(self) -> tuple[float, float]:
        """Return 95% confidence interval."""
        return (
            max(100, self.rating - 1.96 * self.rd),
            min(3500, self.rating + 1.96 * self.rd),
        )


class AccuracyAnalyser:
    """Post-game accuracy scoring and Elo estimation."""

    def calculate(
        self,
        fen_list: List[str],
        moves: List[str],
        stockfish_path: str = "stockfish",
    ) -> Dict[str, Any]:
        """
        For each move, compute the centipawn loss and classify it.

        *fen_list* is a list of FEN strings before each move (length N).
        *moves* is the corresponding UCI move list (length N).
        Returns per-move classification and aggregate accuracy.
        """
        if len(fen_list) != len(moves):
            raise ValueError("fen_list and moves must have the same length")

        results: List[Dict[str, Any]] = []
        white_losses: List[float] = []
        black_losses: List[float] = []

        try:
            engine = chess.engine.SimpleEngine.popen_uci(stockfish_path)
        except Exception as exc:
            return {"error": f"Could not start Stockfish: {exc}", "moves": [], "white_accuracy": 0, "black_accuracy": 0}

        try:
            for fen, uci in zip(fen_list, moves):
                board = chess.Board(fen)
                is_white = board.turn == chess.WHITE

                score_before = _score_position(engine, board)

                try:
                    move = chess.Move.from_uci(uci)
                    board.push(move)
                except Exception:
                    continue

                score_after = _score_position(engine, board)

                if is_white:
                    loss = max(0.0, score_before - score_after)
                    white_losses.append(loss)
                else:
                    loss = max(0.0, -score_before - (-score_after))
                    black_losses.append(loss)

                classification = classify_move(loss)
                results.append({
                    "uci": uci,
                    "fen": fen,
                    "color": "white" if is_white else "black",
                    "cp_loss": round(loss, 1),
                    "classification": classification,
                })
        finally:
            engine.quit()

        white_acc = accuracy_from_losses(white_losses)
        black_acc = accuracy_from_losses(black_losses)
        white_avg_cp = round(sum(white_losses) / len(white_losses), 1) if white_losses else 0.0
        black_avg_cp = round(sum(black_losses) / len(black_losses), 1) if black_losses else 0.0

        return {
            "moves": results,
            "white_accuracy": round(white_acc, 1),
            "black_accuracy": round(black_acc, 1),
            "white_avg_cp_loss": white_avg_cp,
            "black_avg_cp_loss": black_avg_cp,
        }

    def estimate_elo(
        self,
        accuracy: float,
        blunder_rate: float = 0.0,
        avg_cp_loss: float = 0.0,
        num_games: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Estimate Elo using Glicko-2 model calibrated to:
          - accuracy (0-100)
          - blunder_rate (0.0-1.0)
          - avg_cp_loss (average centipawn loss per move)
          - num_games: actual game count used for averaging; if provided,
            the Glicko-2 simulation matches this count so the confidence
            interval reflects the real sample size. Falls back to an
            accuracy-based heuristic when None.

        Accuracy and avg_cp_loss are treated as performance indicators.
        Calibrated against human data.
        """
        base_acc = max(0.01, min(99.99, accuracy / 100.0))
        blunder_penalty = blunder_rate * 200
        cp_penalty = min(0.15, (avg_cp_loss / 500.0) * 0.15)
        adjusted_score = max(0.01, min(0.99, base_acc - cp_penalty - blunder_penalty))
        opponent_rating = 2000.0
        rating = GlickoRating(rating=1500.0, rd=200.0)
        if num_games is not None and num_games >= 1:
            estimated_games = num_games
        else:
            estimated_games = max(3, int((1.0 - adjusted_score) * 20 + 3))
        for _ in range(estimated_games):
            rating.update_single(opponent_rating, 200.0, adjusted_score)
        final_rating = max(400, rating.rating - blunder_penalty)
        ci = rating.ci95()
        return {
            "estimated_elo": round(final_rating),
            "confidence_interval": [
                round(max(400, ci[0] - blunder_penalty)),
                round(min(3500, ci[1])),
            ],
            "rd": round(rating.rd, 1),
            "rating_deviation": round(rating.rd, 1),
            "games_simulated": estimated_games,
        }
