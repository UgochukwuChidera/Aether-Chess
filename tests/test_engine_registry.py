"""Tests for Stockfish discovery.

These run without a real Stockfish installed. Instead each test drops tiny
stand-in engines into temporary directories; the stand-ins deliberately mimic
the real protocol, including refusing to identify themselves until they are
sent the ``uci`` command. That behaviour is what the discovery code actually
has to cope with, so faking it any more loosely would let the regressions back
in.
"""

import os
import stat
import sys
import tempfile
import unittest
from unittest import mock

from aether_chess.engines import registry

UCI_ENGINE_SOURCE = """#!{interpreter}
import sys

NAME = {name!r}

for _line in sys.stdin:
    _line = _line.strip()
    if _line == "uci":
        print("id name " + NAME)
        print("id author test")
        print("uciok")
        sys.stdout.flush()
    elif _line == "quit":
        break
"""


def write_engine(directory, filename, name, executable=True):
    """Create a fake UCI engine that self-reports as *name*."""
    os.makedirs(directory, exist_ok=True)
    engine_path = os.path.join(directory, filename)
    with open(engine_path, "w", encoding="utf-8") as handle:
        handle.write(UCI_ENGINE_SOURCE.format(interpreter=sys.executable, name=name))
    os.chmod(
        engine_path,
        stat.S_IRWXU if executable else stat.S_IRUSR | stat.S_IWUSR,
    )
    return engine_path


SILENT_ENGINE_SOURCE = """#!/bin/sh
# Consumes UCI commands and never answers, like a wedged engine.
exec cat >/dev/null
"""


def write_silent_engine(directory, filename):
    """Create an engine that never identifies itself."""
    os.makedirs(directory, exist_ok=True)
    engine_path = os.path.join(directory, filename)
    with open(engine_path, "w", encoding="utf-8") as handle:
        handle.write(SILENT_ENGINE_SOURCE)
    os.chmod(engine_path, stat.S_IRWXU)
    return engine_path


@unittest.skipIf(os.name == "nt", "fake engines need a POSIX shebang")
class EngineRegistryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = self._tmp.name
        self.app_dir = os.path.join(self.root, "app-engines")
        self.user_dir = os.path.join(self.root, "user-engines")
        self.path_dir = os.path.join(self.root, "bin")
        for directory in (self.app_dir, self.user_dir, self.path_dir):
            os.makedirs(directory, exist_ok=True)

        # Discovery reads these module-level functions, so redirecting them
        # keeps the tests off the real filesystem.
        patches = [
            mock.patch.object(registry, "_app_engines_dir", return_value=self.app_dir),
            mock.patch.object(
                registry, "_user_engines_dir", return_value=self.user_dir
            ),
            mock.patch.dict(os.environ, {"PATH": self.path_dir}),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

        # The identity cache is module-level and keyed on file stats, so it has
        # to be reset or results leak between tests.
        registry._IDENTITY_CACHE.clear()
        self.addCleanup(registry._IDENTITY_CACHE.clear)

    def names_by_source(self, engines):
        return sorted(engine.name for engine in engines)

    def test_bare_names_mean_auto_not_a_chosen_path(self):
        for value in (None, "", "  ", "stockfish", "STOCKFISH", "auto", "default"):
            self.assertTrue(registry.is_auto_path(value), value)

    def test_real_paths_are_not_treated_as_auto(self):
        for value in ("/usr/bin/stockfish", "./stockfish", "engines/stockfish-18"):
            self.assertFalse(registry.is_auto_path(value), value)

    def test_exec_bit_is_repaired(self):
        engine = write_engine(
            self.app_dir, "stockfish", "Stockfish 17", executable=False
        )
        mode = os.stat(engine).st_mode
        self.assertFalse(mode & stat.S_IXUSR)

        registry.ensure_executable(engine)

        self.assertTrue(os.stat(engine).st_mode & stat.S_IXUSR)

    def test_engine_without_exec_bit_is_still_discovered(self):
        engine = write_engine(
            self.app_dir, "stockfish", "Stockfish 17", executable=False
        )

        engines = registry.discover_engines()

        self.assertIn(engine, [e.path for e in engines])

    def test_identity_is_only_reported_after_uci_is_sent(self):
        """Regression: the probe must send `uci`, not just read the banner.

        A real engine says nothing about itself until it is asked, so a probe
        that skips the handshake silently loses every version.
        """
        engine = write_engine(self.app_dir, "stockfish", "Stockfish 17")

        identity = registry._probe_identity(engine)

        self.assertEqual("Stockfish 17", identity)

    def test_version_comes_from_the_engine_not_the_filename(self):
        """Regression: a mislabelled file must be reported truthfully.

        The official sf_18 release ships a "universal" binary that is really
        Stockfish 19, so believing the filename would lie to the player.
        """
        engine = write_engine(self.app_dir, "stockfish-18", "Stockfish 19")

        found = registry.discover_engines()

        self.assertEqual(1, len(found))
        self.assertEqual("Stockfish 19", found[0].name)
        self.assertEqual([19], found[0].version)

    def test_every_version_found_and_newest_first(self):
        write_engine(self.app_dir, "stockfish-16", "Stockfish 16")
        write_engine(self.app_dir, "stockfish-19", "Stockfish 19")
        write_engine(self.user_dir, "stockfish-17", "Stockfish 17")

        engines = registry.discover_engines()

        self.assertEqual(
            ["Stockfish 19", "Stockfish 17", "Stockfish 16"],
            [e.name for e in engines],
        )

    def test_sources_are_labelled(self):
        write_engine(self.path_dir, "stockfish", "Stockfish 19")
        write_engine(self.app_dir, "stockfish-18", "Stockfish 18")

        engines = {e.name: e.source for e in registry.discover_engines()}

        self.assertEqual("path", engines["Stockfish 19"])
        self.assertEqual("app-engines", engines["Stockfish 18"])

    def test_engine_on_path_is_found(self):
        engine = write_engine(self.path_dir, "stockfish", "Stockfish 19")

        self.assertEqual(engine, registry.resolve_engine_path(None))

    def test_app_folder_is_used_when_path_has_no_engine(self):
        engine = write_engine(self.app_dir, "stockfish-18", "Stockfish 18")

        self.assertEqual(engine, registry.resolve_engine_path("stockfish"))

    def test_user_folder_is_used_when_nothing_else_is_found(self):
        engine = write_engine(self.user_dir, "stockfish-18", "Stockfish 18")

        self.assertEqual(engine, registry.resolve_engine_path("stockfish"))

    def test_no_engine_anywhere_resolves_to_nothing(self):
        self.assertIsNone(registry.resolve_engine_path("stockfish"))
        self.assertEqual([], registry.discover_engines())

    def test_explicitly_chosen_engine_wins_even_when_older(self):
        write_engine(self.path_dir, "stockfish", "Stockfish 19")
        chosen = write_engine(self.app_dir, "stockfish-16", "Stockfish 16")

        self.assertEqual(chosen, registry.resolve_engine_path(chosen))

    def test_chosen_engine_is_distinguishable_from_the_newest(self):
        """The list is ordered newest-first; the user's pick is flagged, not promoted.

        A player who deliberately selects an older build must not have their
        choice silently replaced by a newer binary that happens to be installed.
        """
        write_engine(self.path_dir, "stockfish", "Stockfish 19")
        chosen = write_engine(self.app_dir, "stockfish-16", "Stockfish 16")

        found = registry.discover_engines(chosen)

        self.assertEqual("Stockfish 19", found[0].name, "newest is listed first")
        configured = [e for e in found if e.source == "configured"]
        self.assertEqual([chosen], [e.path for e in configured])

    def test_broken_configured_path_does_not_silently_substitute(self):
        write_engine(self.path_dir, "stockfish", "Stockfish 19")
        missing = os.path.join(self.root, "does-not-exist")

        self.assertIsNone(registry.resolve_engine_path(missing))

    def test_unrelated_files_in_the_folder_are_ignored(self):
        write_engine(self.app_dir, "stockfish-18", "Stockfish 18")
        write_engine(self.app_dir, "readme", "not an engine")

        found = registry.discover_engines()

        self.assertEqual(["Stockfish 18"], [e.name for e in found])

    def test_successful_probes_are_cached(self):
        engine = write_engine(self.app_dir, "stockfish-18", "Stockfish 18")
        real_probe = registry._probe_identity
        calls = []

        def counting_probe(bin_path):
            calls.append(bin_path)
            return real_probe(bin_path)

        with mock.patch.object(registry, "_probe_identity", counting_probe):
            registry.discover_engines()
            first = len(calls)
            registry.discover_engines()

        self.assertEqual(1, first)
        self.assertEqual(first, len(calls), "cached identity should not re-probe")
        self.assertEqual(engine, registry.resolve_engine_path("stockfish"))

    def test_failed_probes_are_not_cached(self):
        """Regression: a timeout must not permanently mislabel an engine."""
        wedged = write_silent_engine(self.app_dir, "stockfish-18")

        # A wedged engine burns the full production timeout, which is far too
        # slow for a test, so shorten it here. The cache must NOT be cleared
        # between the two calls: whether the failure was remembered is exactly
        # what this test is checking.
        with mock.patch.object(registry, "_PROBE_TIMEOUT_SEC", 0.4):
            first = registry._identity_cached(wedged)
        with mock.patch.object(registry, "_probe_identity", lambda _p: "Stockfish 18"):
            second = registry._identity_cached(wedged)

        self.assertIsNone(first)
        self.assertEqual(
            "Stockfish 18",
            second,
            "a failed probe must be retried, not remembered",
        )

    def test_wedged_engine_does_not_hide_a_working_one(self):
        write_silent_engine(self.app_dir, "stockfish-19")
        working = write_engine(self.app_dir, "stockfish-18", "Stockfish 18")

        with mock.patch.object(registry, "_PROBE_TIMEOUT_SEC", 0.4):
            engines = registry.discover_engines()

        self.assertIn(working, [e.path for e in engines])
        self.assertEqual(working, registry.resolve_engine_path(working))

    def test_ensure_dirs_creates_both_locations(self):
        created = registry.ensure_engine_dirs()

        self.assertEqual(
            [os.path.realpath(self.app_dir), os.path.realpath(self.user_dir)],
            [os.path.realpath(p) for p in created],
        )
        self.assertTrue(os.path.isdir(self.app_dir))
        self.assertTrue(os.path.isdir(self.user_dir))


if __name__ == "__main__":
    unittest.main()
