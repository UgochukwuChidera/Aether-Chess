/**
 * TopBar.test.tsx — P4-T08: the hamburger opens nothing (its onMenuClick is a
 * TODO stub for a slide-out drawer that was never built), so the button and
 * the prop go away instead of shipping a dead-looking-live control.
 *
 * Fail-first contract: on pre-fix code the Menu button renders, so the
 * absence assertion FAILS; post-fix it passes. The Settings-button assertion
 * guards against over-deletion.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TopBar } from "./TopBar";

function stubWindowChrome() {
  Object.defineProperty(window, "electronAPI", {
    value: {
      isMaximized: async () => false,
      minimize: () => undefined,
      maximize: () => undefined,
      close: () => undefined,
    },
    writable: true,
    configurable: true,
  });
}

describe("TopBar (P4-T08: no-op drawer removed)", () => {
  afterEach(() => cleanup());
  it("renders no Menu hamburger button", () => {
    stubWindowChrome();
    // Post-fix props: onMenuClick is gone; only the settings affordance stays.
    render(<TopBar onSettingsClick={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
  });

  it("keeps the Settings button", () => {
    stubWindowChrome();
    const onSettingsClick = vi.fn();
    render(<TopBar onSettingsClick={onSettingsClick} />);
    const settings = screen.getByRole("button", { name: "Settings" });
    settings.click();
    expect(onSettingsClick).toHaveBeenCalledTimes(1);
  });
});
