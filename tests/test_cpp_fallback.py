"""P4-T03 Tier 1 fail-first: pure-Python fallback is what runs in production.

Nothing outside ``cpp_engine/`` imports ``cpp_engine`` (verified by
``rg --glob '*.py' cpp_engine`` over the repo: hits only inside
``cpp_engine/`` itself), so ``evaluate_fen`` / ``evaluate_batch`` /
``get_info`` in pure Python -- MentorEngine fallback -- is the production
path TODAY. These tests lock that behaviour with the compiled kernel
forced out (module attrs patched to the no-cpp state), so they hold
whether or not a ``.so`` sits in ``cpp_engine/``.

Pre-change record: this file did not exist -- the fallback had zero
coverage (``venv/bin/python -m unittest discover -s tests`` enumerated no
cpp test). Post-change: all green, kernel or no kernel.
"""

import sys
import unittest
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cpp_engine  # noqa: E402

STARTPOS = chess.STARTING_FEN
# Black to move, midgame-ish: Italian game after 1.e4 e5 2.Nf3 Nc6 3.Bc4.
ITALIAN = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"


class CppFallbackTests(unittest.TestCase):
    def setUp(self):
        # Force the no-cpp state for one test, restoring afterwards so
        # nothing leaks into other suites in the same discover process.
        self._saved = (
            cpp_engine._has_cpp,
            cpp_engine._evaluate_cpp,
            cpp_engine._evaluate_batch_cpp,
        )
        cpp_engine._has_cpp = False
        cpp_engine._evaluate_cpp = None
        cpp_engine._evaluate_batch_cpp = None
        self.addCleanup(self._restore_cpp_state)

    def _restore_cpp_state(self):
        (
            cpp_engine._has_cpp,
            cpp_engine._evaluate_cpp,
            cpp_engine._evaluate_batch_cpp,
        ) = self._saved

    def test_fallback_evaluate_returns_int(self):
        score = cpp_engine.evaluate_fen(STARTPOS)
        self.assertIsInstance(score, int)

    def test_fallback_evaluate_is_deterministic(self):
        self.assertEqual(
            cpp_engine.evaluate_fen(ITALIAN), cpp_engine.evaluate_fen(ITALIAN)
        )

    def test_fallback_startpos_is_balanced(self):
        # The symmetric start position must score (near) zero from either
        # kernel -- a coarse sanity bound, not an exact-value contract.
        self.assertLess(abs(cpp_engine.evaluate_fen(STARTPOS)), 200)

    def test_fallback_batch_matches_elementwise(self):
        fens = [STARTPOS, ITALIAN, STARTPOS]
        self.assertEqual(
            cpp_engine.evaluate_batch(fens),
            [cpp_engine.evaluate_fen(f) for f in fens],
        )

    def test_fallback_malformed_fen_raises_not_zero(self):
        # The recorded P4-T03 defect is silent-0-on-bad-FEN in the C++
        # kernel. The Python fallback must never have it: python-chess
        # rejects bad input, so assert the raise (not a value).
        with self.assertRaises(ValueError):
            cpp_engine.evaluate_fen("not a fen")
        with self.assertRaises(ValueError):
            cpp_engine.evaluate_fen(
                "8/8/8/8/8/8/8/8 w - - 0 1"  # kingless: no legal position
            )

    def test_fallback_batch_rejects_bad_input(self):
        with self.assertRaises(ValueError):
            cpp_engine.evaluate_batch([STARTPOS, "garbage!!"])

    def test_get_info_names_fallback_branch(self):
        info = cpp_engine.get_info()
        self.assertIsInstance(info, str)
        self.assertIn("NOT AVAILABLE", info)


if __name__ == "__main__":
    unittest.main()
