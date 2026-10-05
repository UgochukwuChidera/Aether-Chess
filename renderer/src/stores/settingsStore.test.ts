/**
 * settingsStore.test.ts — P3-T02: one settings schema.
 *
 * Fail-first contract: `loadFromBackend` shallow-merges persisted data
 * unchecked (bypassing the clamps `update()` applies), `saveToBackend`
 * writes synchronously per tick and swallows all errors. These tests assert
 * the FIXED behaviour — junk is clamped on load through the same validation
 * as `update`, rapid updates coalesce into one debounced save, and a save
 * failure surfaces instead of vanishing — so all three FAIL on pre-fix code
 * (junk passes through; three immediate saves; no error recorded).
 *
 * The test deliberately touches only APIs that exist pre-fix
 * (`useSettingsStore`, `update`, `loadFromBackend`, `saveToBackend`) and
 * reaches the new fields (`limits`, `saveError`) through a record cast, so
 * the file imports cleanly both before and after the fix and the failures
 * are behavioural, not import errors. Fake-backend shape mirrors
 * `PlayView.test.tsx` (`window.electronAPI` stub with `loadSettings` /
 * `saveSettings`, plus the new `getSettingsDefaults` the fixed store reads
 * at boot with a static fallback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "./settingsStore";

type StoreRecord = Record<string, unknown> & {
  update: (patch: Record<string, unknown>) => void;
  loadFromBackend: () => Promise<void>;
  saveToBackend: () => Promise<void>;
};

function store(): StoreRecord {
  return useSettingsStore.getState() as unknown as StoreRecord;
}

const CANONICAL_DEFAULTS_PAYLOAD = {
  schemaVersion: 1,
  defaults: { threads: 1, hash_mb: 128, multipv: 3 },
  limits: {
    min_threads: 1,
    max_threads: 8,
    min_hash_mb: 16,
    max_hash_mb: 512,
    min_multipv: 1,
    max_multipv: 5,
  },
};

function installApi(overrides: Record<string, unknown> = {}): {
  saveSettings: ReturnType<typeof vi.fn>;
} {
  const saveSettings = vi.fn(async () => true);
  const api = {
    loadSettings: async () => null,
    saveSettings,
    getSettingsDefaults: async () => CANONICAL_DEFAULTS_PAYLOAD,
    ...overrides,
  };
  window.electronAPI = api as unknown as Window["electronAPI"];
  return { saveSettings };
}

function resetStore(): void {
  useSettingsStore.setState({
    theme: "dark",
    threads: 1,
    hashMb: 128,
    multipv: 3,
    soundVolume: 0.7,
    loaded: false,
    // Post-fix fields: harmless extra keys pre-fix (zustand setState
    // accepts them), the asserted surface post-fix.
    ...{
      limits: { maxThreads: 8, maxHashMb: 512, maxMultipv: 5 },
      schemaVersion: 1,
      saveError: null,
    },
  } as Parameters<typeof useSettingsStore.setState>[0]);
}

beforeEach(() => {
  installApi();
  resetStore();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("P3-T02 settings schema (renderer)", () => {
  it("clamps a junk settings.json on load through the update validation", async () => {
    window.electronAPI = {
      loadSettings: async () => ({
        theme: "nope",
        threads: 99999,
        hashMb: 99999,
        multipv: 99,
        soundVolume: 99,
        timeControl: { seconds: -5, increment: -1, label: 42 },
        my_future_flag: "keep-me",
      }),
      saveSettings: async () => true,
      getSettingsDefaults: async () => CANONICAL_DEFAULTS_PAYLOAD,
    } as unknown as Window["electronAPI"];

    await store().loadFromBackend();
    const s = store();
    expect(s.loaded).toBe(true);
    expect(s.threads).toBe(8);
    expect(s.hashMb).toBe(512);
    expect(s.multipv).toBe(5);
    expect(s.soundVolume).toBe(1);
    expect(s.theme).toBe("dark");
    // Unknown-key policy is preserve-forward (main.ts merge round-trips
    // keys the schema does not know).
    expect(s.my_future_flag).toBe("keep-me");
    // Limits came from the backend command, not the hard-coded fallback.
    expect(s.limits).toEqual({ maxThreads: 8, maxHashMb: 512, maxMultipv: 5 });
  });

  it("debounces rapid updates into a single save with the latest values", async () => {
    vi.useFakeTimers();
    const { saveSettings } = installApi();

    store().update({ threads: 2 });
    store().update({ threads: 3 });
    store().update({ threads: 4 });
    expect(saveSettings).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings.mock.calls[0][0]).toMatchObject({ threads: 4 });
  });

  it("surfaces a save failure instead of swallowing it", async () => {
    vi.useFakeTimers();
    installApi({
      saveSettings: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });

    store().update({ threads: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store().saveError).toMatch(/disk full/);

    // Direct saves reject to the caller as well.
    await expect(store().saveToBackend()).rejects.toThrow("disk full");
  });
});

describe("P3-T09 settings_defaults wiring (renderer)", () => {
  // Distinctive backend answer: caps deliberately ABOVE the static fallback
  // (8/512/5) and defaults deliberately OFF the static DEFAULTS (1/128/3),
  // so every assertion below can only pass when the values came from the
  // command — never from the fallback constants.
  const DISTINCTIVE_PAYLOAD = {
    schemaVersion: 1,
    defaults: {
      threads: 2,
      hash_mb: 256,
      multipv: 2,
      strength: 9,
      think_profile: "blitz",
      maia3_elo: 1200,
      stockfish_path: "stockfish",
      maia3_model: "maia3-5m",
      maia3_device: "cpu",
    },
    limits: {
      min_threads: 1,
      max_threads: 16,
      min_hash_mb: 16,
      max_hash_mb: 1024,
      min_multipv: 1,
      max_multipv: 9,
    },
  };

  it("reachable backend -> caps AND defaults come from the command", async () => {
    installApi({
      loadSettings: async () => null,
      getSettingsDefaults: async () => DISTINCTIVE_PAYLOAD,
    });
    resetStore();

    await store().loadFromBackend();
    const s = store();
    expect(s.loaded).toBe(true);
    // Caps from the command, not the fallback (8/512/5).
    expect(s.limits).toEqual({
      maxThreads: 16,
      maxHashMb: 1024,
      maxMultipv: 9,
    });
    // Defaults from the command, not the static DEFAULTS (1/128/3) —
    // P3-T02 Change 2 ("DEFAULTS comes from the backend at boot"). FAILS
    // pre-fix: the speculative read applies limits but ignores `defaults`.
    expect(s.threads).toBe(2);
    expect(s.hashMb).toBe(256);
    expect(s.multipv).toBe(2);
    expect(s.botStrength).toBe(9);
    expect(s.thinkProfile).toBe("blitz");
    expect(s.maia3Elo).toBe(1200);
  });

  it("reachable backend -> saved settings overlay backend defaults, junk clamps to the BACKEND cap", async () => {
    installApi({
      loadSettings: async () => ({ threads: 5, hashMb: 99999 }),
      getSettingsDefaults: async () => DISTINCTIVE_PAYLOAD,
    });
    resetStore();

    await store().loadFromBackend();
    const s = store();
    expect(s.loaded).toBe(true);
    // Saved value under the backend cap survives…
    expect(s.threads).toBe(5);
    // …while junk clamps to the BACKEND cap (1024), not the fallback (512):
    // boot uses backend caps when available.
    expect(s.hashMb).toBe(1024);
  });

  it("unreachable backend (command throws) -> silent fallback, boot proceeds, no rejection", async () => {
    installApi({
      loadSettings: async () => null,
      getSettingsDefaults: async () => {
        throw new Error("backend exited");
      },
    });
    resetStore();

    // Must resolve (never reject): boot must never block on the backend.
    await expect(store().loadFromBackend()).resolves.toBeUndefined();
    const s = store();
    expect(s.loaded).toBe(true);
    expect(s.limits).toEqual({ maxThreads: 8, maxHashMb: 512, maxMultipv: 5 });
    expect(s.threads).toBe(1);
    expect(s.hashMb).toBe(128);
    expect(s.multipv).toBe(3);
  });

  it("missing electronAPI -> silent fallback, boot proceeds", async () => {
    (window as unknown as Record<string, unknown>).electronAPI = undefined;
    resetStore();

    await expect(store().loadFromBackend()).resolves.toBeUndefined();
    const s = store();
    expect(s.loaded).toBe(true);
    expect(s.limits).toEqual({ maxThreads: 8, maxHashMb: 512, maxMultipv: 5 });
  });

  it("junk backend caps -> sanitized to fallback, boot proceeds", async () => {
    installApi({
      loadSettings: async () => null,
      getSettingsDefaults: async () => ({
        schemaVersion: NaN,
        defaults: { threads: 99999, hash_mb: 99999, multipv: 99 },
        limits: { max_threads: -4, max_hash_mb: "lots", max_multipv: null },
      }),
    });
    resetStore();

    await expect(store().loadFromBackend()).resolves.toBeUndefined();
    const s = store();
    expect(s.loaded).toBe(true);
    // Junk caps sanitize to the static fallback (never NaN/negative)…
    expect(s.limits).toEqual({ maxThreads: 8, maxHashMb: 512, maxMultipv: 5 });
    // …and junk defaults clamp through those caps (never reach setoption).
    // Junk *persisted-settings* clamping is P3-T02-covered (first test in
    // this file) and deliberately not duplicated here.
    expect(s.threads).toBe(8);
    expect(s.hashMb).toBe(512);
    expect(s.multipv).toBe(5);
  });
});
