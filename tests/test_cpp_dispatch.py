"""P4-T03 Tier 2 fail-first: injectable dispatch, flag default-off.

Change 3 wires ``cpp_engine`` behind an explicit setting flag (default
OFF) with an injectable dispatch -- no module-level import in the
consumer. These tests assert the FIXED shape:

- ``_try_import_cpp(loader=...)`` honours a fake loader (success and
  failure) without ever loading a real ``.so`` in this tier,
- ``get_info()`` names the active branch on both sides,
- ``ChessEngineManager.get_mentor_eval`` takes the cpp branch only when
  the ``mentor_use_cpp`` setting is on, via an injected
  ``_cpp_evaluate`` callable (never a real ``.so`` here).

Pre-change record (2026-10-06, all fail meaningfully): ``_try_import_cpp``
takes no ``loader`` argument (``TypeError`` on every injection test),
``ChessEngineManager().settings`` has no ``mentor_use_cpp`` key
(``KeyError``), and ``get_mentor_eval`` takes no ``_cpp_evaluate``
argument (``TypeError``). Dispatch is uninjectable -- the defect.
"""

import sys
import unittest
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from chess_engine import ChessEngineManager  # type: ignore[reportMissingImports]  # noqa: E402

import cpp_engine  # noqa: E402

STARTPOS = chess.STARTING_FEN


def _fake_pair(score=42):
    calls = []

    def fake_evaluate(fen):
        calls.append(fen)
        return score

    def fake_batch(fens):
        calls.extend(fens)
        return [score] * len(fens)

    return (fake_evaluate, fake_batch), calls


class CppDispatchLoaderTests(unittest.TestCase):
    def test_loader_success_returns_fake_pair(self):
        pair, _ = _fake_pair()
        evaluate, batch = cpp_engine._try_import_cpp(
            loader=lambda: pair  # noqa: E731 - throwaway fake, not real code
        )
        self.assertIs(evaluate, pair[0])
        self.assertIs(batch, pair[1])

    def test_loader_failure_yields_none_pair(self):
        def _boom():
            raise ImportError("no native module here")

        evaluate, batch = cpp_engine._try_import_cpp(loader=_boom)
        self.assertIsNone(evaluate)
        self.assertIsNone(batch)

    def test_get_info_names_both_branches(self):
        real_has_cpp, real_eval, real_batch = (
            cpp_engine._has_cpp,
            cpp_engine._evaluate_cpp,
            cpp_engine._evaluate_batch_cpp,
        )
        try:
            cpp_engine._has_cpp = True
            self.assertIn("ACTIVE", cpp_engine.get_info())
            cpp_engine._has_cpp = False
            self.assertIn("NOT AVAILABLE", cpp_engine.get_info())
        finally:
            cpp_engine._has_cpp = real_has_cpp
            cpp_engine._evaluate_cpp = real_eval
            cpp_engine._evaluate_batch_cpp = real_batch


class CppDispatchFlagTests(unittest.TestCase):
    def test_flag_exists_and_defaults_off(self):
        mgr = ChessEngineManager()
        self.assertIn("mentor_use_cpp", mgr.settings)
        self.assertFalse(mgr.settings["mentor_use_cpp"])

    def test_flag_off_ignores_injected_dispatch(self):
        mgr = ChessEngineManager()
        mgr.settings["mentor_use_cpp"] = False
        pair, calls = _fake_pair(score=123456)
        result = mgr.get_mentor_eval(STARTPOS, _cpp_evaluate=pair[0])
        self.assertEqual(calls, [])
        self.assertIsNotNone(result.get("eval_cp"))
        self.assertNotEqual(result["eval_cp"], 123456)

    def test_flag_on_uses_injected_dispatch(self):
        mgr = ChessEngineManager()
        mgr.settings["mentor_use_cpp"] = True
        pair, calls = _fake_pair(score=777)
        result = mgr.get_mentor_eval(STARTPOS, _cpp_evaluate=pair[0])
        self.assertEqual(calls, [STARTPOS])
        self.assertEqual(result["eval_cp"], 777)


if __name__ == "__main__":
    unittest.main()
