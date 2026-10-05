"""P3-T08: numba compile caching for mentor_engine's three @njit sites.

Fails-first design (revised — the original used a fresh temp dir per run,
so EVERY suite run paid full cold compiles: self-defeating):
- test_njit_sites_enable_cache: AST assertion that all three decorators
  carry cache=True. Instant, no compile, guards flag removal.
- test_cached_probe_matches_and_populates: ONE subprocess probe against a
  PERSISTENT cache dir (system temp, survives runs; numba auto-invalidates
  on version/source change). First-ever run warms it; later runs are warm.
  Wall time is deliberately NOT asserted; suite-level cold-vs-warm numbers
  live in the P3-T08 commit body.
"""

import ast
import glob
import os
import subprocess
import sys
import tempfile
import unittest

PROBE = (
    "from aether_chess.engines.mentor_engine import "
    "_bitscan, _popcount, _eval_numba; "
    "print(_bitscan(12345), _popcount(12345), "
    "_eval_numba(1,0,0,0,0,0,0,0,0,0,0,0,0))"
)

# _bitscan(12345): lowest set bit of 0x3039 is bit 0.
# _popcount(12345): 12345 = 2^13+2^12+2^5+2^4+2^3+2^0 -> six bits.
# _eval_numba(...): lone-white-king vs lone-black-king baseline.
EXPECTED = "0 6 20039"

JIT_FUNCS = ("_bitscan", "_popcount", "_eval_numba")

# Persistent across runs: warms once, fast forever. Fresh-temp-dir-per-run
# is what made the original version cost minutes on EVERY suite run.
CACHE_DIR = os.path.join(tempfile.gettempdir(), "aether-numba-cache-test")

PROBE_TIMEOUT_SEC = 900


def _njit_sites_with_cache():
    path = os.path.join(
        os.path.dirname(__file__), "..", "aether_chess", "engines",
        "mentor_engine.py",
    )
    tree = ast.parse(open(path).read())
    found = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in JIT_FUNCS:
            for dec in node.decorator_list:
                if isinstance(dec, ast.Call):
                    for kw in dec.keywords:
                        if kw.arg == "cache" and isinstance(kw.value, ast.Constant):
                            found[node.name] = kw.value.value
    return found


def _probe(cache_dir):
    os.makedirs(cache_dir, exist_ok=True)
    env = dict(os.environ)
    env["NUMBA_CACHE_DIR"] = cache_dir
    proc = subprocess.run(
        [sys.executable, "-c", PROBE],
        capture_output=True,
        text=True,
        timeout=PROBE_TIMEOUT_SEC,
        env=env,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"numba cache probe failed: {proc.stderr[-2000:]}")
    return proc.stdout.strip()


def _artifacts(cache_dir, func):
    return glob.glob(os.path.join(cache_dir, "*", f"mentor_engine.{func}-*"))


class NumbaCacheTests(unittest.TestCase):
    def test_njit_sites_enable_cache(self):
        found = _njit_sites_with_cache()
        for func in JIT_FUNCS:
            self.assertTrue(
                found.get(func) is True,
                f"@{func} must carry cache=True",
            )

    def test_cached_probe_matches_and_populates(self):
        self.assertEqual(_probe(CACHE_DIR), EXPECTED)
        for func in JIT_FUNCS:
            self.assertTrue(
                _artifacts(CACHE_DIR, func),
                f"no numba cache artifacts for {func} in {CACHE_DIR}",
            )


if __name__ == "__main__":
    unittest.main()
