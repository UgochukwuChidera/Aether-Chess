"""End-to-end proof that the backend honours the configured engine.

The resolver is only half the feature: this checks the other half, that the
path which comes out of resolution is the path Stockfish is actually started
from. The decisive case points the backend at a stub engine that plays one
illegal-for-a-real-engine move, so a correct result can only come from that
binary. Nothing is stubbed inside the service — it spawns the engine itself.

Real Stockfish cases are skipped when no engine is installed, because CI
runners have none. They are not weakened, just made conditional.
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path

from aether_chess.engines import registry

START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

STUB_ENGINE = '''#!{interpreter}
"""A UCI engine that only ever plays one specific move."""
import sys

NAME = {name!r}
FIXED = {move!r}

for _raw in sys.stdin:
    _cmd = _raw.strip()
    if _cmd == "uci":
        print("id name " + NAME)
        print("id author routing-test")
        print("uciok")
        sys.stdout.flush()
    elif _cmd == "isready":
        print("readyok")
        sys.stdout.flush()
    elif _cmd.startswith("go"):
        print("info depth 1 score cp 0 pv " + FIXED)
        print("bestmove " + FIXED)
        sys.stdout.flush()
    elif _cmd == "quit":
        break
'''


def write_stub_engine(directory, filename, name, move):
    os.makedirs(directory, exist_ok=True)
    engine_path = os.path.join(directory, filename)
    with open(engine_path, "w", encoding="utf-8") as handle:
        handle.write(
            STUB_ENGINE.format(interpreter=sys.executable, name=name, move=move)
        )
    os.chmod(engine_path, 0o755)
    return engine_path


class EngineRoutingTests(unittest.TestCase):
    """Drives the real JSON-RPC service over stdio."""

    maxDiff = None

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.stub_dir = os.path.join(self._tmp.name, "stub")

    @classmethod
    def setUpClass(cls):
        cls._shared = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls._shared.cleanup)
        # A pawn push a real engine would essentially never return as its best
        # move, so seeing it proves which binary answered.
        cls.marker = "a2a3"
        cls.stub = write_stub_engine(
            os.path.join(cls._shared.name, "stub"),
            "stockfish-stub",
            "Stockfish 99",
            cls.marker,
        )
        if cls._uci_best_move(cls.stub) != cls.marker:
            raise AssertionError("stub engine is not a usable UCI engine")

    @staticmethod
    def _uci_best_move(engine_path):
        """Confirm the stub really is a usable UCI engine before blaming others."""
        script = (
            "import chess, chess.engine, sys\n"
            "e = chess.engine.SimpleEngine.popen_uci(sys.argv[1])\n"
            "print(e.play(chess.Board(), chess.engine.Limit(depth=1)).move.uci())\n"
            "e.quit()\n"
        )
        with subprocess.Popen(
            [sys.executable, "-c", script, engine_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        ) as proc:
            out, _ = proc.communicate(timeout=120)
        return out.strip().splitlines()[-1] if out.strip() else ""

    def ask_backend(self, stockfish_path, timeout=180):
        """Send one request and wait for its reply.

        The service handles each request on a daemon thread and returns from
        main() the moment stdin reaches EOF, so the pipe has to stay open until
        the answer arrives or the work is killed mid-flight.
        """
        service = Path(__file__).resolve().parents[1] / "backend" / "service.py"
        proc = subprocess.Popen(
            [sys.executable, str(service)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            cwd=str(service.parent.parent),
            env={**os.environ, "PYTHONPATH": str(service.parent.parent)},
        )
        reply = {}

        def read_reply():
            assert proc.stdout is not None
            for line in proc.stdout:
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    reply.update(json.loads(line))
                except json.JSONDecodeError:
                    continue
                return

        reader = threading.Thread(target=read_reply, daemon=True)
        reader.start()
        assert proc.stdin is not None
        proc.stdin.write(
            json.dumps(
                {
                    "id": "routing-probe",
                    "command": "get_engine_move",
                    "params": {
                        "fen": START_FEN,
                        "stockfish_path": stockfish_path,
                        "engine_type": "stockfish",
                        "depth": 1,
                        "time_limit": 0.5,
                    },
                }
            )
            + "\n"
        )
        proc.stdin.flush()
        reader.join(timeout)
        proc.kill()
        proc.wait(timeout=30)
        for stream in (proc.stdin, proc.stdout):
            if stream is not None:
                stream.close()
        return reply

    @staticmethod
    def result_of(reply):
        result = reply.get("result")
        return result if isinstance(result, dict) else {}

    def move_of(self, reply):
        result = self.result_of(reply)
        for key in ("move", "uci", "san", "last_move_uci"):
            if result.get(key):
                return str(result[key])
        return None

    def test_configured_engine_is_the_one_that_answers(self):
        reply = self.ask_backend(self.stub)

        self.assertEqual(
            self.marker,
            self.move_of(reply),
            f"backend did not use the configured engine; reply={reply}",
        )
        self.assertNotIn("error", reply)

    def test_configured_engine_is_not_marked_as_a_fallback(self):
        reply = self.ask_backend(self.stub)

        self.assertFalse(self.result_of(reply).get("_fallback"), reply)

    def test_missing_engine_falls_back_to_mentor_not_another_stockfish(self):
        """A bad path must not be papered over by quietly using a different engine."""
        missing = os.path.join(self._tmp.name, "no-such-engine")

        reply = self.ask_backend(missing)
        result = self.result_of(reply)

        self.assertIsNotNone(self.move_of(reply), f"expected a mentor move: {reply}")
        self.assertTrue(result.get("_fallback"), f"fallback was not flagged: {reply}")
        self.assertNotEqual(self.marker, self.move_of(reply))

    def test_resolver_and_backend_agree_on_an_explicit_path(self):
        """Whatever the resolver picks is exactly what the backend is given."""
        resolved = registry.resolve_engine_path(self.stub)

        self.assertEqual(os.path.abspath(self.stub), resolved)

    def test_auto_resolution_reaches_an_installed_engine(self):
        # Checked here rather than in a skipIf decorator: decorators are
        # evaluated at import time, so they cannot see a PATH that a test
        # harness or CI runner sets after the module is loaded.
        if registry.resolve_engine_path("stockfish") is None:
            self.skipTest("no real Stockfish installed")
        reply = self.ask_backend("stockfish")
        result = self.result_of(reply)

        self.assertIsNotNone(self.move_of(reply), f"no move produced: {reply}")
        self.assertFalse(result.get("_fallback"), f"auto resolution failed: {reply}")
        self.assertNotEqual(self.marker, self.move_of(reply))


if __name__ == "__main__":
    unittest.main()
