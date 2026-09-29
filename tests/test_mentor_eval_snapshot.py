"""P2-T12 regression: `mg_score` / `eg_score` must be GONE from the snapshot.

Decision: DROP (not implement). Evidence recorded in the commit body:
- `MentorEngine` exposes only blended `evaluate(board) -> int` plus
  `_phase(board) -> int`; `_eval_numba` computes mg/eg internally and
  returns only the blended score. No mg/eg-capable entry point exists.
- Zero code readers branch on the values: `EvalBar.tsx:109,116` and
  `gameStore.ts:212` consume only `eval_cp`; the fields are stored /
  passed through but never reasoned about. All declarations are optional,
  so consumers tolerate absence.

Contract under test (drop):
1. `get_mentor_eval` returns exactly `{"eval_cp", "phase"}` — no
   `mg_score` / `eg_score` keys, no `_get_mg_score` / `_get_eg_score`
   helpers left on the manager.
2. `eval_cp` and `phase` stay sane finite ints (`|eval_cp| < 100000`,
   `0 <= phase <= 256`) — the KING=20000 raw-material dominance leaves
   with the dropped fields.

Fails pre-change: the snapshot contains both fields (identical raw
material sums), so the absence assertions fail.
"""

import unittest

import chess

from backend.chess_engine import ChessEngineManager

# Ruy Lopez middlegame, full material: PST-aware mg/eg would differ here,
# and the old raw-material getters returned identical KING-dominated sums.
MIDGAME_FEN = "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4"


class MentorEvalSnapshotTests(unittest.TestCase):
    def test_mg_eg_fields_absent_from_snapshot(self):
        eng = ChessEngineManager()
        result = eng.get_mentor_eval(MIDGAME_FEN)
        self.assertNotIn("mg_score", result, "mg_score must be dropped")
        self.assertNotIn("eg_score", result, "eg_score must be dropped")

    def test_getter_helpers_removed(self):
        eng = ChessEngineManager()
        self.assertFalse(
            hasattr(eng, "_get_mg_score"), "_get_mg_score helper must be gone"
        )
        self.assertFalse(
            hasattr(eng, "_get_eg_score"), "_get_eg_score helper must be gone"
        )

    def test_eval_cp_and_phase_sane(self):
        eng = ChessEngineManager()
        result = eng.get_mentor_eval(MIDGAME_FEN)
        self.assertIn("eval_cp", result)
        self.assertIn("phase", result)
        eval_cp = result["eval_cp"]
        phase = result["phase"]
        self.assertIsInstance(eval_cp, int, "eval_cp must be a finite int")
        self.assertIsInstance(phase, int, "phase must be a finite int")
        self.assertLess(abs(eval_cp), 100000, "eval_cp out of sane centipawn range")
        self.assertGreaterEqual(phase, 0)
        self.assertLessEqual(phase, 256)

    def test_snapshot_keys_exact(self):
        eng = ChessEngineManager()
        result = eng.get_mentor_eval(chess.STARTING_FEN)
        self.assertEqual(
            set(result.keys()),
            {"eval_cp", "phase"},
            f"snapshot must be exactly eval_cp+phase, got {sorted(result)}",
        )


if __name__ == "__main__":
    unittest.main()
