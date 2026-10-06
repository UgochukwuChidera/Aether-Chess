/**
 * SettingsPanel.test.tsx — P4-T08: `supports_skill_level` is declared by the
 * backend and already reaches this panel via `listBots()` (`bots` state), but
 * nothing reads it — so the "Bot difficulty" slider renders even for bots
 * that ignore it (Maia3 is Elo-driven; `maia3_bot.play` never reads
 * `strength`), a dead-looking-live control.
 *
 * Fail-first contract: with the selected bot reporting
 * `supports_skill_level: false` the slider must hide. Pre-fix it always
 * renders, so the first test FAILS; post-fix both pass (the second guards
 * against over-deletion).
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "./SettingsPanel";
import { useSettingsStore } from "../stores/settingsStore";

function stubBackend(botFlags: { supports_skill_level: boolean }) {
  const bots = [
    {
      bot_id: "maia3",
      display_name: "Maia3",
      kind: "uci",
      description: "Fake Maia3",
      requires_binary: false,
      supports_skill_level: botFlags.supports_skill_level,
      supports_elo: true,
      supports_eval: false,
      deterministic: false,
      available: true,
      is_default: false,
    },
  ];
  Object.defineProperty(window, "electronAPI", {
    value: {
      getCpuCount: async () => 4,
      getStockfishInfo: async () => ({
        configuredPath: null,
        configuredExists: false,
        bundledPath: null,
        bundledExists: false,
        engines: [],
        resolvedPath: null,
        appEnginesDir: "/tmp/engines",
        userEnginesDir: "/tmp/engines",
        settingsPath: "/tmp/settings.json",
      }),
      listBots: async () => ({ bots }),
      checkMaia3Cache: async () => ({ cached: false, model: "maia3-5m" }),
      maia3Cache: async () => ({ ok: true }),
      onDownloadProgress: () => () => {},
      getBookMoves: async () => ({ moves: [] }),
      pickStockfishPath: async () => null,
      revealEnginesDir: async () => "",
      openExternalUrl: async () => true,
      getBooksDir: async () => "",
    },
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Select the bot under test regardless of the persisted default.
  useSettingsStore.getState().update({ playEngine: "maia3" });
});

describe("SettingsPanel (P4-T08: strength slider follows supports_skill_level)", () => {
  afterEach(() => cleanup());
  it("hides the Bot difficulty slider when the selected bot reports supports_skill_level: false", async () => {
    stubBackend({ supports_skill_level: false });
    render(<SettingsPanel />);
    // Wait for the async listBots() to land so the assertion runs against
    // the flag, not the pre-fetch empty state.
    await waitFor(() => {
      expect(screen.queryByText("Play engine")).not.toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByText("Bot difficulty")).toBeNull();
    });
  });

  it("keeps the Bot difficulty slider when the selected bot reports supports_skill_level: true", async () => {
    stubBackend({ supports_skill_level: true });
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.queryByText("Bot difficulty")).not.toBeNull();
    });
  });
});

/**
 * P4-T10: the Maia3 download must surface in-UI progress. The backend pushes
 * id-less `download_progress` events (clock_tick-shaped) through
 * `onDownloadProgress`; the panel renders a <progress> element reflecting
 * them. Fail-first contract: pre-fix there is no subscription and no
 * element, so firing progress events leaves no progressbar in the DOM.
 */
function stubBackendWithProgress() {
  let progressCb: ((data: unknown) => void) | null = null;
  const unsubscribe = vi.fn();
  stubBackend({ supports_skill_level: false });
  const api = window.electronAPI as unknown as Record<string, unknown>;
  api.onDownloadProgress = (cb: (data: unknown) => void) => {
    progressCb = cb;
    return unsubscribe;
  };
  return {
    fireProgress: (progress: number) => {
      expect(progressCb).not.toBeNull();
      act(() => {
        (progressCb as (data: unknown) => void)({
          type: "download_progress",
          model: "maia3-5m",
          progress,
        });
      });
    },
    unsubscribe,
  };
}

describe("SettingsPanel (P4-T10: in-UI download progress)", () => {
  afterEach(() => cleanup());
  it("shows no progress element before any download event", async () => {
    stubBackendWithProgress();
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.queryByText("Maia3 cache")).not.toBeNull();
    });
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("reflects pushed progress values 0->100 in order", async () => {
    const { fireProgress } = stubBackendWithProgress();
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.queryByText("Maia3 cache")).not.toBeNull();
    });
    for (const value of [0, 25, 50, 75, 100]) {
      fireProgress(value);
      const bar = screen.getByRole("progressbar") as HTMLProgressElement;
      expect(bar.value).toBe(value);
      expect(bar.max).toBe(100);
    }
  });

  it("unsubscribes from progress events on unmount", async () => {
    const { unsubscribe } = stubBackendWithProgress();
    render(<SettingsPanel />);
    await waitFor(() => {
      expect(screen.queryByText("Maia3 cache")).not.toBeNull();
    });
    expect(unsubscribe).not.toHaveBeenCalled();
    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
