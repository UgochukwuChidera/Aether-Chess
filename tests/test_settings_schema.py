"""P3-T02 fail-first: one canonical settings schema.

The backend has no validation layer today: ``backend/chess_engine.py``
clamps ``threads``/``hash_mb`` inline (8/512) while the renderer clamps to
64/2048, and ``service.py`` forwards IPC params straight into ``new_game``
unchecked. These tests assert the FIXED behaviour — a canonical
``backend/settings_schema.py`` module exposing defaults, clamps, migration
and unknown-key handling, consumed by both the engine and the service
boundary — so every test below FAILS on the pre-fix code (the import
itself raises ``ModuleNotFoundError``: there is no schema module).
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import service  # type: ignore[reportMissingImports]
import settings_schema as schema  # type: ignore[reportMissingImports]
from chess_engine import ChessEngineManager  # type: ignore[reportMissingImports]


class SettingsDefaultsTests(unittest.TestCase):
    def test_schema_defaults_match_engine_defaults(self):
        """Canonical defaults must equal what a fresh engine actually uses."""
        engine = ChessEngineManager()
        defaults = schema.engine_defaults()
        self.assertEqual(engine.settings["threads"], defaults["threads"])
        self.assertEqual(engine.settings["hash_mb"], defaults["hash_mb"])
        self.assertEqual(engine.settings["multipv"], defaults["multipv"])

    def test_canonical_limits_are_the_backend_caps(self):
        """Authority decision: 8 threads / 512 MB / 5 multipv (the setoption
        safety caps), not the renderer's 64/2048."""
        limits = schema.settings_limits()
        self.assertEqual(limits["max_threads"], 8)
        self.assertEqual(limits["max_hash_mb"], 512)
        self.assertEqual(limits["max_multipv"], 5)


class SettingsClampTests(unittest.TestCase):
    def test_threads_junk_clamped(self):
        self.assertEqual(schema.clamp_threads(99999), 8)
        self.assertEqual(schema.clamp_threads(-3), 1)
        self.assertEqual(schema.clamp_threads("abc"), 1)
        self.assertEqual(schema.clamp_threads(None), 1)
        self.assertEqual(schema.clamp_threads(float("nan")), 1)
        self.assertEqual(schema.clamp_threads(4), 4)

    def test_hash_junk_clamped(self):
        self.assertEqual(schema.clamp_hash_mb(99999), 512)
        self.assertEqual(schema.clamp_hash_mb(4), 16)
        self.assertEqual(schema.clamp_hash_mb("junk"), 128)
        self.assertEqual(schema.clamp_hash_mb(256), 256)

    def test_multipv_junk_clamped(self):
        self.assertEqual(schema.clamp_multipv(99), 5)
        self.assertEqual(schema.clamp_multipv(0), 1)
        self.assertEqual(schema.clamp_multipv(3), 3)


class SettingsMigrationTests(unittest.TestCase):
    def test_v0_empty_dict_migrates_to_v1_defaults(self):
        """Persisted files predate the version field: fill + stamp, no crash."""
        out = schema.migrate_settings({})
        self.assertEqual(out["schemaVersion"], schema.SCHEMA_VERSION)
        self.assertEqual(out["threads"], 1)
        self.assertEqual(out["hash_mb"], 128)

    def test_v0_junk_clamped_during_migration(self):
        out = schema.migrate_settings({"threads": 99999})
        self.assertEqual(out["threads"], 8)
        self.assertEqual(out["schemaVersion"], schema.SCHEMA_VERSION)

    def test_future_version_never_crashes(self):
        """Forward-compatible: a newer file must load, keeping its stamp."""
        out = schema.migrate_settings({"schemaVersion": 99, "threads": 4})
        self.assertEqual(out["threads"], 4)
        self.assertEqual(out["schemaVersion"], 99)


class SettingsUnknownKeyTests(unittest.TestCase):
    def test_unknown_keys_preserved_forward(self):
        """Policy: preserve-forward (matches main.ts merge round-trip —
        settings.json must survive keys this version does not know)."""
        out = schema.validate_settings({"threads": 4, "my_future_flag": True})
        self.assertEqual(out["threads"], 4)
        self.assertTrue(out["my_future_flag"])


class SettingsServiceBoundaryTests(unittest.TestCase):
    def test_new_game_clamps_junk_before_engine(self):
        """Junk IPC params must never reach setoption: the service boundary
        clamps before the engine manager stores them."""
        service.handle_new_game({"threads": 99999, "hash_mb": 99999, "multipv": 99})
        self.assertEqual(service.engine_mgr.settings["threads"], 8)
        self.assertEqual(service.engine_mgr.settings["hash_mb"], 512)
        self.assertEqual(service.engine_mgr.settings["multipv"], 5)

    def test_settings_defaults_command_registered(self):
        self.assertIn("settings_defaults", service.HANDLERS)
        payload = service.handle_settings_defaults({})
        self.assertEqual(payload["limits"]["max_threads"], 8)
        self.assertEqual(payload["limits"]["max_hash_mb"], 512)
        self.assertEqual(payload["schemaVersion"], schema.SCHEMA_VERSION)


if __name__ == "__main__":
    unittest.main()
