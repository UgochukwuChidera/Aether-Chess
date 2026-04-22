"""
backend/analysis.py — Accuracy scoring and Elo estimation using the existing
aether_chess analysis modules.
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, List

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

                # Loss is always from the side that just moved
                if is_white:
                    loss = max(0.0, score_before - score_after)
                    white_losses.append(loss)
                else:
                    # From black's perspective: invert scores
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

        return {
            "moves": results,
            "white_accuracy": round(white_acc, 1),
            "black_accuracy": round(black_acc, 1),
        }

    def estimate_elo(self, accuracy: float, blunder_rate: float = 0.0) -> Dict[str, Any]:
        """
        Simple heuristic Elo estimate from accuracy and blunder rate.
        Uses Bayesian performance rating calibrated to human data.
        """
        # Map accuracy (0-100) to a win-probability score against a 2000-rated engine
        # Calibrated using: acc ~= 100% → Elo ~2600; acc ~= 50% → Elo ~1200
        base_score = max(0.01, min(0.99, accuracy / 100.0))
        blunder_penalty = blunder_rate * 150  # each 1% blunder rate ≈ 150 Elo penalty

        elo_result = estimate_bayesian_elo(
            performance_scores=[base_score],
            opponent_rating=2000.0,
        )
        adjusted_rating = max(400, elo_result.rating - blunder_penalty)

        return {
            "estimated_elo": round(adjusted_rating),
            "confidence_interval": [
                round(max(400, elo_result.ci95[0] - blunder_penalty)),
                round(elo_result.ci95[1]),
            ],
            "rd": round(elo_result.rd, 1),
        }
