/**
 * smoke.spec.ts — hermetic Electron boot smoke test (P0-T12).
 *
 * Launches the BUILT app (`dist/electron/main.js`) against the stdlib-only
 * fixture backend (`e2e/fixtures/fake-backend.py`) and asserts:
 *   1. a window opens,
 *   2. the backend-ready handshake completes,
 *   3. no `backend-error` / `backend-closed` failure surfaces,
 *   4. the board renders 8x8 squares,
 *   5. the app closes cleanly.
 *
 * Hermeticity notes:
 * - `AETHER_BACKEND_SCRIPT` points at the ABS path of the fixture. This env
 *   override is the P0-T09 feature; observing the fixture's handshake here
 *   is the DEFERRED P0-T09 proof (no dedicated unit test was added in
 *   P0-T09, so this spec delivers it).
 * - The whole file is hermetic: there are NO `@real` tags here, so P0-T10's
 *   `npm run test:e2e:real -- --grep @real` tier selects nothing until later
 *   items add tagged real-backend specs.
 * - `userDataDir` is a unique mkdtemp dir per run. It isolates
 *   `settings.json`, the game-history index and
 *   `engineRegistry.userEnginesDir`, so specs never mutate real user data.
 *
 * Why this file serves the renderer over HTTP:
 * `electron/main.ts` computes `isDev = NODE_ENV === "development" ||
 * !app.isPackaged`, and an unpackaged `electron dist/electron/main.js`
 * launch always reports `isPackaged === false` (probed 2026-09-28) — so
 * the app loads `http://localhost:5173`, never the `file://` bundle.
 * Additionally the `file://` branch points at `dist/renderer/index.html`
 * while `npm run build:renderer` actually emits `renderer/dist/` — a real
 * path mismatch, but fixing main/vite config is OUT OF SCOPE for P0-T12
 * (no main/preload/renderer source changes). Serving the BUILT bundle
 * (`renderer/dist/`) on :5173 exercises built output without touching
 * sources. If a `vite dev` server already occupies :5173 the spec fails
 * fast instead of testing the wrong bundle.
 *
 * Handshake definition (what "backend-ready" observably means):
 * `window.electronAPI.newGame(...)` invoked from the renderer resolves
 * with a snapshot whose FEN equals the start position and whose
 * `legal_moves` are non-empty. That round-trip traverses preload IPC ->
 * PythonShell stdin NDJSON -> fixture -> stdout NDJSON -> pending-request
 * resolution, so it can only succeed when the fixture speaks the protocol.
 * It is paired with an absence check for the renderer's backend-failure
 * surface (`Backend error` / `Backend process closed` / `Failed to start
 * game` toasts — the exact strings `App.tsx` / `PlayView.tsx` push when
 * the backend dies). Either half alone is weak; together they fail when
 * the backend is dead (proven by the killer-fixture negative control run
 * during development: immediate-exit backend -> `newGame` rejects and the
 * closed/failure toast appears).
 *
 * Selectors: board squares are plain `<div data-sq="e4">` elements with no
 * role or aria-label (see `Board.tsx`), so the 64-square assertion uses
 * the existing `data-sq` attribute — no `data-testid` was added and none
 * was needed (no selector proved brittle). `getByRole` covers the nav
 * buttons, which do carry aria-labels (`BottomNav`/`TopBar`).
 */
import { test, expect, _electron } from "@playwright/test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const MAIN_JS = path.join(ROOT, "dist", "electron", "main.js");
// P0-T09 proof: the backend script the app spawns is chosen by this env
// override (guarded by fs.existsSync in getBackendScript()).
const FIXTURE_BACKEND = path.join(ROOT, "e2e", "fixtures", "fake-backend.py");
// Actual `build:renderer` output dir (see header comment).
const RENDERER_DIST = path.join(ROOT, "renderer", "dist");
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/** Serve the built renderer bundle; resolves once listening. */
function serveRendererBundle(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let filePath = path.join(
      RENDERER_DIST,
      urlPath === "/" ? "index.html" : urlPath.slice(1),
    );
    if (!filePath.startsWith(RENDERER_DIST)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type":
        MIME[path.extname(filePath)] ?? "application/octet-stream",
    });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `port ${port} is already in use — stop the vite dev server so the spec serves the BUILT bundle (renderer/dist/) instead of testing the wrong renderer`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

test("boot smoke: window opens, backend handshake completes, 8x8 board renders", async () => {
  expect(
    fs.existsSync(MAIN_JS),
    `built main missing — run npm run build first (${MAIN_JS})`,
  ).toBe(true);
  expect(
    fs.existsSync(FIXTURE_BACKEND),
    `fixture backend missing (${FIXTURE_BACKEND})`,
  ).toBe(true);

  const server = await serveRendererBundle(5173);
  // Unique scratch profile per run — isolates settings.json, the
  // game-history index and engineRegistry.userEnginesDir from real data.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-e2e-"));
  const app = await _electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, AETHER_BACKEND_SCRIPT: FIXTURE_BACKEND },
  });
  try {
    const page = await app.firstWindow();
    // Board squares mount once the renderer boots and sizes the board.
    await page.waitForSelector("[data-sq]", { timeout: 30_000 });

    // 4. Board renders 8x8 squares (existing data-sq attribute; zero
    //    testids in the renderer, none added — this selector held first
    //    try, so the item's testid fallback was not triggered).
    await expect(page.locator("[data-sq]")).toHaveCount(64, {
      timeout: 30_000,
    });
    // Sanity via the accessible path: nav buttons carry aria-labels.
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible();

    // 2. Backend-ready handshake: a live newGame round-trip through the
    //    fixture (fails when the backend is dead — see header).
    const snapshot = (await page.evaluate(async () => {
      const api = (window as unknown as { electronAPI: any }).electronAPI;
      return (await api.newGame({
        mode: "human_vs_ai",
        engine_type: "stockfish",
        human_color: "white",
        strength: 1,
      })) as { fen: string; legal_moves: string[]; turn: string };
    })) as { fen: string; legal_moves: string[]; turn: string };
    expect(snapshot.fen).toBe(START_FEN);
    expect(snapshot.turn).toBe("white");
    expect(snapshot.legal_moves.length).toBeGreaterThan(0);

    // 3. No backend failure surfaced in the renderer (the exact toasts
    //    App.tsx / PlayView.tsx push on backend-error / backend-closed /
    //    newGame rejection).
    await expect(
      page.getByText(
        /Backend error|Backend process closed|Failed to start game/i,
      ),
    ).toHaveCount(0);
  } finally {
    // 5. App closes cleanly — no hanging handles (workers: 1 in config).
    await app.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
