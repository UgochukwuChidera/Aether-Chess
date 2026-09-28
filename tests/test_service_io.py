'''P1-T02 regression: the maia3_cache stdout capture must be thread-local.

`handle_maia3_cache` used `contextlib.redirect_stdout` / `redirect_stderr`,
which rebind `sys.stdout` for the whole process. Every request runs on its own
daemon thread, so a concurrent request `_send` landed in the capture buffer
instead of the real stdout and the client hung until the IPC timeout. The fix
routes capture per-thread via `ThreadLocalStream`.
'''

import io
import json
import sys
import threading
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import service  # type: ignore[reportMissingImports]

FAKE_NOISE = 'Maia3 5M: /fake/cache/path'
FAKE_PROGRESS = 'fetching model.safetensors: 50%|##| 1/2'
FAKE_QUIET = 'a plain symlink warning with no progress in it'


def _install_fake_cache(during_capture):
    '''Point `maia3.cache.main` at a fake that writes while captured.'''
    pkg_name = 'maia3'
    mod_name = 'maia3.cache'
    old_pkg = sys.modules.get(pkg_name)
    old_mod = sys.modules.get(mod_name)
    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = []
    mod = types.ModuleType(mod_name)

    def fake_main(args):
        print(FAKE_NOISE)
        print(FAKE_PROGRESS, file=sys.stderr)
        print(FAKE_QUIET, file=sys.stderr)
        during_capture()

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
    '''Mimic main(): route through proxies when the fix is present.'''
    if hasattr(service, 'ThreadLocalStream'):
        sys.stdout = service.ThreadLocalStream(real_out)  # type: ignore[attr-defined]
        sys.stderr = service.ThreadLocalStream(real_err)  # type: ignore[attr-defined]
    else:
        sys.stdout = real_out  # type: ignore[assignment]
        sys.stderr = real_err  # type: ignore[assignment]


def _sent_ids(real_out):
    ids = []
    for line in real_out.getvalue().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ids.append(json.loads(line).get('id'))
        except ValueError:
            continue
    return ids


class ServiceIoTests(unittest.TestCase):
    def test_concurrent_send_reaches_real_stdout(self):
        '''A second thread _send during capture must reach real stdout.'''
        real_out = io.StringIO()
        real_err = io.StringIO()
        old_out, old_err = sys.stdout, sys.stderr
        sender_done = threading.Event()

        def _sender():
            service._send({'id': 'x', 'result': 1})
            sender_done.set()

        def _during_capture():
            worker = threading.Thread(target=_sender)
            worker.start()
            self.assertTrue(sender_done.wait(timeout=10), 'sender thread never ran')
            worker.join(timeout=10)

        restore_cache = _install_fake_cache(_during_capture)
        _install_streams(real_out, real_err)
        try:
            result = service.handle_maia3_cache({'model': 'maia3-5m'})
        finally:
            sys.stdout = old_out
            sys.stderr = old_err
            restore_cache()
        self.assertEqual(result, {'ok': True, 'model': 'maia3-5m'})
        self.assertIn(
            'x', _sent_ids(real_out), 'concurrent _send was swallowed by the capture'
        )
        self.assertNotIn(
            FAKE_NOISE,
            real_out.getvalue(),
            'capture must still suppress the caching thread',
        )
        self.assertIn('50%', real_err.getvalue())
        self.assertNotIn(FAKE_QUIET, real_err.getvalue())

    def test_capture_does_not_swallow_other_threads(self):
        '''Reverse: capture on a worker thread must not take our _send.'''
        real_out = io.StringIO()
        real_err = io.StringIO()
        old_out, old_err = sys.stdout, sys.stderr
        entered = threading.Event()
        release = threading.Event()
        errors = []

        def _during_capture():
            entered.set()
            self.assertTrue(
                release.wait(timeout=10), 'main thread never released capture'
            )

        def _run_handler():
            try:
                service.handle_maia3_cache({'model': 'maia3-5m'})
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        restore_cache = _install_fake_cache(_during_capture)
        _install_streams(real_out, real_err)
        worker = threading.Thread(target=_run_handler)
        worker.start()
        try:
            self.assertTrue(entered.wait(timeout=10), 'handler never entered capture')
            service._send({'id': 'y', 'result': 2})
        finally:
            release.set()
            worker.join(timeout=10)
            sys.stdout = old_out
            sys.stderr = old_err
            restore_cache()
        self.assertEqual(errors, [])
        self.assertIn(
            'y',
            _sent_ids(real_out),
            'main-thread _send was swallowed by a worker capture',
        )
        self.assertNotIn(
            FAKE_NOISE,
            real_out.getvalue(),
            'capture must still suppress the caching thread',
        )
        self.assertIn('50%', real_err.getvalue())
        self.assertNotIn(FAKE_QUIET, real_err.getvalue())


if __name__ == '__main__':
    unittest.main()
