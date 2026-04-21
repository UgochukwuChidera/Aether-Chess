from __future__ import annotations

from dataclasses import dataclass


def cubic_ease_in_out(t: float) -> float:
    t = max(0.0, min(1.0, t))
    if t < 0.5:
        return 4 * t * t * t
    return 1 - pow(-2 * t + 2, 3) / 2


@dataclass
class PieceAnimation:
    start_x: float
    start_y: float
    end_x: float
    end_y: float
    duration_ms: int
    elapsed_ms: int = 0

    def tick(self, dt_ms: int) -> tuple[float, float, bool]:
        self.elapsed_ms += dt_ms
        progress = min(1.0, self.elapsed_ms / max(self.duration_ms, 1))
        eased = cubic_ease_in_out(progress)
        x = self.start_x + (self.end_x - self.start_x) * eased
        y = self.start_y + (self.end_y - self.start_y) * eased
        return x, y, progress >= 1.0
