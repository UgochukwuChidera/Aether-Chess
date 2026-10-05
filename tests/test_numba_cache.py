"""P3-T08: numba compile caching for mentor_engine's three @njit sites.

A cold python process run with a temp NUMBA_CACHE_DIR must leave one
cache-artifact family per jitted function (_bitscan, _popcount,
_eval_numba); a second (warm) process against the same dir must succeed
with identical results. Wall time is deliberately NOT asserted (it is
environment dependent); the suite-level cold-vs-warm measurement lives in
the P3-T08 commit body instead.

Note: the @njit decorators below carry explicit signatures, so numba
compiles at decoration (import) time and the ~1 MB _eval_numba dominates
cold-import cost -- subprocess timeouts are generous for that reason.
"""

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

PROBE_TIMEOUT_SEC = 900


def _probe(cache_dir):
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
    def test_cold_import_populates_cache_for_all_three_sites(self):
        with tempfile.TemporaryDirectory() as cache_dir:
            self.assertEqual(_probe(cache_dir), EXPECTED)
            for func in JIT_FUNCS:
                self.assertTrue(
                    _artifacts(cache_dir, func),
                    f"no numba cache artifacts for {func} in {cache_dir}",
                )

    def test_warm_import_reuses_cache_with_identical_results(self):
        with tempfile.TemporaryDirectory() as cache_dir:
            cold = _probe(cache_dir)
            self.assertEqual(cold, EXPECTED)
            warm = _probe(cache_dir)
            self.assertEqual(warm, cold)
            for func in JIT_FUNCS:
                self.assertTrue(
                    _artifacts(cache_dir, func),
                    f"cache artifacts for {func} missing after warm import",
                )


if __name__ == "__main__":
    unittest.main()
