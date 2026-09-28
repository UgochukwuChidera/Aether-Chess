/**
 * backend-death.spec.ts — P2-T05: backend death hangs requests, never recovers.
 *
 * Defect: `electron/main.ts`'s `close` handler nulls `pyShell` and emits
 * `backend-closed` but never rejects `pendingRequests`, so each in-flight
 * renderer promise waits out its full timeout (30s standard tier, 300s for
 * LONG_RUNNING tiers). Nothing respawns the backend, so every later IPC
 * call rejects `Python backend not running` for the rest of the session.
 *
 * Fail-first contract: the spec holds one `newGame` open with the
 * fixture's `__hang_sec` hook (60s — far beyond the 30s tier, so the
 * pre-fix run can only resolve via the timeout, proving the hang), then
 * SIGKILLs the fixture mid-flight (the P0-T12/P2-T03 killer technique:
 * pgrep + /proc cmdline check so only the `python` running the fixture
 * is signalled). It asserts:
 *   (i)   the victim rejects PROMPTLY (<10s, well under the 30s tier),
 *   (ii)  the error is the clear backend-exited error, not a timeout,
 *   (iii) a subsequent real `newGame` round-trip SUCCEEDS post-recovery
 *         (same handshake shape as smoke.spec.ts — proves the app works,
 *         not just that it fails fast).
 * Pre-fix this fails on all three: ~30s hang, `Request timed out:
 * new_game`, and `Python backend not running` on the recovery call.
 *
 * Adjudications (all verified by direct read, recorded here):
 * - SECOND WINDOW moot: no module-level `mainWindow` global exists —
 *   `startPython(mainWindow: BrowserWindow)` takes a per-window param
 *   (main.ts:136) fed from `createWindow()`'s local `win` (:278), and
 *   there is exactly one `new BrowserWindow` site (:250), created at
 *   startup (:313) or on activate-with-zero-windows (:316). No
 *   multi-window plumbing added.
 * - RESPAWN TRIGGER is lazy-on-next-IPC: `sendCommand` (:212) has no
 *   window ref, but `BrowserWindow` is already imported, so the first
 *   non-destroyed window from `getAllWindows()` is the owner with zero
 *   ref threading. No explicit reconnect IPC, no renderer changes.
 * - TIMER HYGIENE: rejection clears each entry's timer (entry shape is
 *   resolve/reject/timer at main.ts:54-61 — a leaked timer would fire
 *   into a deleted entry).
 * - analysisCallbacks on respawn is OUT of scope (P2-T04's map, keyed by
 *   window — survives a backend swap correctly). Follow-up note only.
 * - Recovery signal is the post-respawn `newGame` resolving (existing
 *   renderer handling untouched; `backendConnected` staying false in the
 *   UI is recorded as a follow-up, not fixed here).
 *
 * Conventions (P0-T12/P2-T03): built main (`dist/electron/main.js`,
 * rebuild mandatory before running), stdlib fixture via
 * `AETHER_BACKEND_SCRIPT`, built renderer bundle served on :5173 (the
 * P2-T21 file:// gap workaround), unique mkdtemp userData dir, existing
 * `data-sq` board attribute (zero testids added).
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
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// Prompt-reject bound: well under the 30s standard IPC tier (and far under
// the 300s LONG_RUNNING tier) — a kill must fail fast, not time out.
const PROMPT_REJECT_MS = 10_000;
// Victim hold-open: far beyond the 30s tier, so pre-fix the victim can only
// resolve via the timeout path (proving the hang), never via a reply.
const VICTIM_HANG_SEC = 60;

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

test("backend death rejects in-flight promptly and the app recovers", async () => {
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
    await page.waitForSelector("[data-sq]", { timeout: 30_000 });
    await expect(page.locator("[data-sq]")).toHaveCount(64, {
      timeout: 30_000,
    });

    // Baseline handshake (smoke shape): the fixture is alive and the IPC
    // path resolves before we break it.
    const baseline = (await page.evaluate(async () => {
      const api = (window as unknown as { electronAPI: any }).electronAPI;
      return (await api.newGame({
        mode: "human_vs_ai",
        engine_type: "stockfish",
        human_color: "white",
        strength: 1,
      })) as { fen: string; legal_moves: string[]; turn: string };
    })) as { fen: string; legal_moves: string[]; turn: string };
    expect(baseline.fen).toBe(START_FEN);

    // Open the victim: a newGame the fixture holds for VICTIM_HANG_SEC via
    // the __hang_sec hook. Fired without awaiting so the kill lands
    // mid-flight; the in-page try/catch returns a plain result object.
    const victimPromise = page.evaluate(async (hangSec: number) => {
      const api = (window as unknown as { electronAPI: any }).electronAPI;
      const t0 = Date.now();
      try {
        await api.newGame({
          mode: "human_vs_ai",
          engine_type: "stockfish",
          human_color: "white",
          strength: 1,
          __hang_sec: hangSec,
        });
        return { ok: true, ms: Date.now() - t0, error: "" };
      } catch (err) {
        return { ok: false, ms: Date.now() - t0, error: String(err) };
      }
    }, VICTIM_HANG_SEC);
    // Let the request reach the fixture (now sleeping) before killing.
    await page.waitForTimeout(1500);
    killFixtureBackend();
    const victim = await victimPromise;
    console.log(
      `[P2-T05 evidence] victim ok=${victim.ok} latency=${victim.ms}ms error=${victim.error}`,
    );

    // (i) Prompt reject: well under the 30s tier. Pre-fix this is ~30s
    // (the full standard-tier timeout).
    expect(victim.ok, "in-flight request should reject on backend death").toBe(
      false,
    );
    expect(
      victim.ms,
      `in-flight reject took ${victim.ms}ms — must be < ${PROMPT_REJECT_MS}ms (pre-fix: full 30s timeout)`,
    ).toBeLessThan(PROMPT_REJECT_MS);
    // (ii) Clear backend-exited error, not a timeout string.
    expect(
      victim.error,
      `expected the backend-exited error, got: ${victim.error}`,
    ).toMatch(/backend exited/i);
    expect(
      victim.error,
      `must not be a timeout string: ${victim.error}`,
    ).not.toMatch(/timed out/i);

    // The renderer still surfaces the death toast via the existing
    // backend-closed path (App.tsx) — guard that the fix keeps it.
    await expect(
      page.getByText("Backend process closed unexpectedly"),
    ).toHaveCount(1, { timeout: 15_000 });

    // (iii) RECOVERY: a subsequent real call succeeds post-kill — the app
    // works, not just fails fast. Same round-trip shape as the smoke
    // handshake. Pre-fix this rejects `Python backend not running`.
    const snapshot = (await page.evaluate(async () => {
      const api = (window as unknown as { electronAPI: any }).electronAPI;
      return (await api.newGame({
        mode: "human_vs_ai",
        engine_type: "stockfish",
        human_color: "white",
        strength: 1,
      })) as { fen: string; legal_moves: string[]; turn: string };
    })) as { fen: string; legal_moves: string[]; turn: string };
    console.log(
      `[P2-T05 evidence] recovery newGame fen=${snapshot.fen} legal_moves=${snapshot.legal_moves.length}`,
    );
    expect(snapshot.fen).toBe(START_FEN);
    expect(snapshot.turn).toBe("white");
    expect(snapshot.legal_moves.length).toBeGreaterThan(0);
  } finally {
    await app.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
