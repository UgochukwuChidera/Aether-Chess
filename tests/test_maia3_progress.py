"""P4-T10: maia3_cache must push download_progress events 0->100 in order.

Fail-first contract: `handle_maia3_cache` currently takes only `params`,
captures the downloader's stderr and re-prints tqdm %-lines to the terminal,
but emits zero push events. A stubbed downloader (fake maia3.cache source
emitting tqdm-style progress lines) observed through a push_fn/callback
capture therefore sees nothing, so the ordered-progress assertion FAILS
pre-fix (TypeError on the unexpected push_fn kwarg, or zero events).

Covered (mirrors P3-T01 TickPushTests: capture-list + stop assertion):
1. Progress events observed 0->100 in order via the push_fn capture.
2. Every event is an id-less push with a `type` field
   (`download_progress`, the clock_tick/analysis_update convention).
3. Push stops when the download ends (count finite after completion).
4. Terminal passthrough preserved (tqdm %-lines still reach real stderr;
   stdout noise still suppressed) -- the P1-T02 property must not regress.
"""

import io
import sys
import time
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import service  # type: ignore[reportMissingImports]

FAKE_NOISE = "Maia3 5M: /fake/cache/path"
FAKE_QUIET = "a plain symlink warning with no progress in it"

# tqdm-style stderr lines the real hf_hub_download emits (percent token
# embedded in a redraw, carriage-return separated in production; newlines
# here -- the parser must handle both since str.splitlines splits \\r too).
FAKE_PROGRESS_LINES = [
    "maia3-5m.pt:   0%|          | 0.00/20.0M [00:00<?, ?B/s]",
    "maia3-5m.pt:  25%|██▌       | 5.00M/20.0M [00:01<00:03, 4.50MB/s]",
    "maia3-5m.pt:  50%|█████     | 10.0M/20.0M [00:02<00:02, 4.70MB/s]",
    "maia3-5m.pt:  75%|███████▌  | 15.0M/20.0M [00:03<00:01, 4.80MB/s]",
    "maia3-5m.pt: 100%|██████████| 20.0M/20.0M [00:04<00:00, 4.85MB/s]",
]


def _install_fake_cache():
    """Point `maia3.cache.main` at a fake emitting tqdm progress lines."""
    pkg_name = "maia3"
    mod_name = "maia3.cache"
    old_pkg = sys.modules.get(pkg_name)
    old_mod = sys.modules.get(mod_name)
    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = []
    mod = types.ModuleType(mod_name)

    def fake_main(args):
        print(FAKE_NOISE)
        for line in FAKE_PROGRESS_LINES:
            print(line, file=sys.stderr)
        print(FAKE_QUIET, file=sys.stderr)

    mod.main = fake_main  # type: ignore[attr-defined]
    pkg.cache = mod  # type: ignore[attr-defined]
    sys.modules[pkg_name] = pkg
    sys.modules[mod_name] = mod

    def _restore():
        if old_mod is None:
            sys.modules.pop(mod_name, None)
        else:
            sys.modules[mod_name] = old_mod
        if old_pkg is None:
            sys.modules.pop(pkg_name, None)
        else:
            sys.modules[pkg_name] = old_pkg

    return _restore


def _install_streams(real_out, real_err):
    """Mimic main(): route through proxies (same helper as test_service_io)."""
    sys.stdout = service.ThreadLocalStream(real_out)  # type: ignore[attr-defined]
    sys.stderr = service.ThreadLocalStream(real_err)  # type: ignore[attr-defined]


class Maia3ProgressTests(unittest.TestCase):
    def _run_handler(self, pushes):
        real_out = io.StringIO()
        real_err = io.StringIO()
        old_out, old_err = sys.stdout, sys.stderr
        restore_cache = _install_fake_cache()
        _install_streams(real_out, real_err)
        try:
            result = service.handle_maia3_cache(
                {"model": "maia3-5m"}, push_fn=pushes.append
            )
        finally:
            sys.stdout = old_out
            sys.stderr = old_err
            restore_cache()
        return result, real_out, real_err

    def test_progress_pushed_zero_to_hundred_in_order(self):
        """Stubbed downloader -> push events observed 0->100 in order."""
        pushes = []
        result, real_out, real_err = self._run_handler(pushes)
        self.assertEqual(result, {"ok": True, "model": "maia3-5m"})
        self.assertTrue(pushes, "no download_progress events observed")
        for evt in pushes:
            self.assertEqual(evt.get("type"), "download_progress")
            self.assertEqual(evt.get("model"), "maia3-5m")
        progress = [evt["progress"] for evt in pushes]
        self.assertEqual(
            progress,
            [0, 25, 50, 75, 100],
            f"progress not observed 0->100 in order: {progress}",
        )

    def test_push_stops_when_download_ends(self):
        """No orphaned push loop: count is finite after completion."""
        pushes = []
        self._run_handler(pushes)
        count = len(pushes)
        self.assertTrue(count > 0, "no events to assert stoppage on")
        time.sleep(0.2)
        self.assertEqual(len(pushes), count, "push events continue after download end")

    def test_terminal_passthrough_preserved(self):
        """P1-T02 property: %-lines still reach stderr, noise stays out."""
        pushes = []
        _result, real_out, real_err = self._run_handler(pushes)
        self.assertIn("50%", real_err.getvalue())
        self.assertNotIn(FAKE_QUIET, real_err.getvalue())
        self.assertNotIn(FAKE_NOISE, real_out.getvalue())


if __name__ == "__main__":
    unittest.main()
