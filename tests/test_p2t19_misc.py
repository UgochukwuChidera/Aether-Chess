"""P2-T19(h): mentor_engine.py assigns `_HAS_NUMBA = True` twice (:1175, :1180).

The duplicate (with its duplicated "End numba JIT section" comment) is dead
weight beside a module that imports numba unconditionally at the top. The fix
deletes the second assignment. `_phase` (:1220) is USED (called from
backend/chess_engine.py) and is untouched — recorded scoping, not re-litigated.

Fail-first contract: the count test FAILS on the pre-fix code (two
assignments) and passes after (one). The import test locks that the flag still
exists and the module still imports.
"""

import unittest
from pathlib import Path

MENTOR_PATH = (
    Path(__file__).resolve().parents[1]
    / "aether_chess"
    / "engines"
    / "mentor_engine.py"
)


class MentorHasNumbaTests(unittest.TestCase):
    def test_has_numba_assigned_exactly_once(self):
        src = MENTOR_PATH.read_text(encoding="utf-8")
        self.assertEqual(
            src.count("_HAS_NUMBA = True"),
            1,
            "duplicated _HAS_NUMBA assignment still present",
        )

    def test_module_still_imports_with_flag_true(self):
        import aether_chess.engines.mentor_engine as mentor

        self.assertTrue(mentor._HAS_NUMBA)


if __name__ == "__main__":
    unittest.main()
