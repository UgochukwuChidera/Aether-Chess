"""P2-T19(g): maia3_proxy.play must not hijack process-wide stdout.

Same class of bug as P1-T02, in a different module: `play()` wrapped
`engine.play` in `contextlib.redirect_stdout`, which rebinds `sys.stdout` for
the whole process. Every request runs on its own thread, so a concurrent
request's `_send` landed in the throwaway buffer and the client hung. The fix
bumps the per-thread depth counters on service.py's installed proxies (see
`_ThreadLocalCapture` — duck-typed, because service -> chess_engine ->
maia3_proxy -> service would be an import cycle).

Fail-first contract: the test installs the ThreadLocalStream proxies (as
main() does), stubs the engine so `play()` prints noise while a second thread
`_send`s, and asserts the FIXED behaviour — the peer reply reaches the real
stdout while the noise stays captured. FAILS on the pre-fix code (reply
swallowed by the process-wide redirect).
"""

import io
import json
import sys
import threading
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "backend"))

import chess  # noqa: E402
import service  # type: ignore[reportMissingImports]  # noqa: E402

from aether_chess.engines.maia3_proxy import Maia3Proxy  # noqa: E402

FAKE_NOISE = "maia3 inference chatter that must stay captured"


class _FakeResult:
    move = chess.Move.from_uci("e2e4")


class _FakeEngine:
    def __init__(self, during_capture):
        self._during_capture = during_capture

    def play(self, board, limit):
        print(FAKE_NOISE)
        self._during_capture()
        return _FakeResult()


def _sent_ids(real_out):
    ids = []
    for line in real_out.getvalue().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ids.append(json.loads(line).get("id"))
        except ValueError:
            continue
    return ids


class Maia3ProxyCaptureTests(unittest.TestCase):
    def test_concurrent_send_reaches_real_stdout_during_play(self):
        real_out = io.StringIO()
        real_err = io.StringIO()
        old_out, old_err = sys.stdout, sys.stderr
        sender_done = threading.Event()

        def _sender():
            service._send({"id": "g", "result": 1})
            sender_done.set()

        def _during_capture():
            worker = threading.Thread(target=_sender)
            worker.start()
            self.assertTrue(sender_done.wait(timeout=10), "sender thread never ran")
            worker.join(timeout=10)

        proxy = Maia3Proxy()
        proxy._ensure_engine = lambda req: _FakeEngine(_during_capture)  # type: ignore[method-assign]
        sys.stdout = service.ThreadLocalStream(real_out)  # type: ignore[attr-defined]
        sys.stderr = service.ThreadLocalStream(real_err)  # type: ignore[attr-defined]
        try:
            result = proxy.play(chess.STARTING_FEN)
        finally:
            sys.stdout = old_out
            sys.stderr = old_err
        self.assertEqual(result["move"], "e2e4")
        self.assertIn(
            "g", _sent_ids(real_out), "concurrent _send was swallowed by the capture"
        )
        self.assertNotIn(
            FAKE_NOISE,
            real_out.getvalue(),
            "capture must still suppress the inference thread",
        )


if __name__ == "__main__":
    unittest.main()
