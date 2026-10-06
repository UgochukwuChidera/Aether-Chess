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
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
