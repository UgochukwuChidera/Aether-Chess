/**
 * listener-leak.spec.ts — P2-T03: IPC listener leak on every tab switch.
 *
 * Fail-first contract: `PlayView.tsx:121-124` subscribes to `backend-closed`
 * / `backend-error` on every mount with no cleanup, while `App.tsx:34-42`
 * subscribes once for the app lifetime. Each Play<->Settings round trip
 * remounts PlayView, so after ~10 switches the renderer's ipcRenderer holds
 * 11+ listeners per backend channel and Node prints
 * `MaxListenersExceededWarning` (once per channel). This spec therefore
 * FAILS on the pre-fix code (warning present in the renderer console) and
 * passes after the fix (listener count constant across mounts: warning
 * absent + exactly one toast per backend failure).
 *
 * Design record: the first fix attempt kept a preload-side map keyed by the
 * caller's callback with removal by reference — and THIS spec caught it
 * still leaking (all three channels hit 11 listeners). A temporary
 * instrumented run proved why: contextBridge mints a fresh proxy per
 * crossing, so the reference handed back at cleanup never matches the one
 * stored at subscribe time. The shipped fix instead returns an unsubscribe
 * closure from each subscribe call (capturing the in-preload wrapper where
 * identity is stable); call-site cleanups invoke it. Same done-when,
 * bridge-compatible mechanism.
 *
 * Observables (chosen from what the harness actually exposes):
 * - Renderer console messages via `page.on('console')` — the probe run
 *   showed the warning lands here (`warning: MaxListenersExceededWarning:
 *   ... 11 backend-closed listeners added ... at Object.onBackendClosed`),
 *   NOT in the main-process stdio (that carries only main-side logs such
 *   as the `check-maia3-cache` fixture noise). App stdio is still captured
 *   and asserted warning-free as a belt-and-braces channel.
 * - Renderer toasts via getByText — killing the fixture backend makes main
 *   send one `backend-closed`; App's single listener pushes exactly one
 *   `Backend process closed unexpectedly` toast. PlayView's leaked
 *   listeners only call setBackendConnected (idempotent, no toast), so the
 *   toast count is 1 both before and after the fix: it is a guard against
 *   the fix introducing duplication, not the discriminating assertion.
 *   No debug APIs were added to the preload for this test.
 *
 * Failure trigger: SIGKILL of the fixture python (P0-T12's killer-fixture
 * negative-control technique, applied mid-test instead of at launch). The
 * victim is identified precisely via /proc cmdline (`python` + fixture
 * path) so the transient `sh -c pgrep` artefact is never signalled.
 *
 * Selectors: BottomNav buttons carry aria-labels (`BottomNav.tsx:41`),
 * scoped to the <nav> element so TopBar's settings button cannot collide.
 * Board presence is the existing `data-sq` attribute (zero testids in the
 * renderer, none added). Mount/unmount is proven per cycle: 0 squares on
 * Settings, 64 back on Play.
 */
import { test, expect, _electron } from "@playwright/test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const MAIN_JS = path.join(ROOT, "dist", "electron", "main.js");
// P0-T09 override: the backend script the app spawns is chosen by this env
// var (guarded by fs.existsSync in getBackendScript()).
const FIXTURE_BACKEND = path.join(ROOT, "e2e", "fixtures", "fake-backend.py");
// Actual `build:renderer` output dir (see smoke.spec.ts header: the file://
// branch points elsewhere — P2-T21 — so e2e serves the built bundle).
const RENDERER_DIST = path.join(ROOT, "renderer", "dist");
const SWITCH_ROUNDS = 10;

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
    const filePath = path.join(
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

/**
 * SIGKILL the fixture backend only. `pgrep -f` also matches its own
 * transient `sh -c` wrapper, so each candidate is checked via /proc: only
 * a `python` interpreter running the fixture path is signalled.
 */
function killFixtureBackend(): void {
  let pids: string[] = [];
  try {
    pids = execSync(`pgrep -f ${FIXTURE_BACKEND} || true`)
      .toString()
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      if (!cmdline.includes("python")) continue;
      process.kill(Number(pid), "SIGKILL");
    } catch {
      /* exited already — nothing to do */
    }
  }
}

test("tab switches do not accumulate backend listeners", async () => {
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
  // Belt-and-braces channel: the warning is observed on the renderer
  // console (see header), main stdio is captured for the evidence quote.
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const proc = app.process();
  proc.stdout?.on("data", (chunk: Buffer) =>
    stdoutChunks.push(chunk.toString()),
  );
  proc.stderr?.on("data", (chunk: Buffer) =>
    stderrChunks.push(chunk.toString()),
  );
  const consoleTexts: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on("console", (msg) => {
      consoleTexts.push(`${msg.type()}: ${msg.text()}`);
    });
    await page.waitForSelector("[data-sq]", { timeout: 30_000 });
    await expect(page.locator("[data-sq]")).toHaveCount(64, {
      timeout: 30_000,
    });

    // 10 Play<->Settings round trips; each return to Play remounts
    // PlayView (and each departure unmounts it — proven per cycle).
    const nav = page.locator("nav");
    for (let i = 0; i < SWITCH_ROUNDS; i++) {
      await nav.getByRole("button", { name: "Settings" }).click();
      await expect(page.locator("[data-sq]")).toHaveCount(0, {
        timeout: 10_000,
      });
      await nav.getByRole("button", { name: "Play" }).click();
      await expect(page.locator("[data-sq]")).toHaveCount(64, {
        timeout: 10_000,
      });
    }
    // Let the trailing newGame round trip settle before asserting.
    await page.waitForTimeout(2000);

    // (a) No listener-leak warning anywhere in the app's observable
    // output. Pre-fix this finds two warnings (one per backend channel,
    // `11 backend-closed listeners added` / `11 backend-error listeners
    // added`); post-fix the listener count is constant across mounts.
    const output = [...consoleTexts, ...stdoutChunks, ...stderrChunks].join(
      "\n",
    );
    const leakWarnings = output
      .split("\n")
      .filter((line) => line.includes("MaxListenersExceededWarning"));
    expect(
      leakWarnings,
      `listener leak: MaxListenersExceededWarning after ${SWITCH_ROUNDS} tab switches:\n${leakWarnings.join("\n")}`,
    ).toEqual([]);

    // (b) Exactly one toast per backend failure: kill the fixture (the
    // P0-T12 killer-fixture technique, mid-test) and count the App-level
    // `backend-closed` toast. Guard assertion — 1 both before and after;
    // it fails only if the fix (or a regression) duplicates surfaces.
    killFixtureBackend();
    await expect(
      page.getByText("Backend process closed unexpectedly"),
    ).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByText(/Backend error/)).toHaveCount(0);
  } finally {
    await app.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
