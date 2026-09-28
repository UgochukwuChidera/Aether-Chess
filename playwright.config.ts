import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // workers: 1 — each spec launches its own Electron window with a scratch
  // userData dir; parallel workers would race window creation and profile setup.
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  // NOTE: no `projects` and no `use.browserName` on purpose. Electron specs
  // drive the app's own Chromium via the `_electron` fixture, so a
  // browser-based config is the wrong shape — adding one would force every
  // checkout through `npx playwright install`. Do not "fix" this.
});
