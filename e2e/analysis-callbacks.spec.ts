/**
 * analysis-callbacks.spec.ts — P2-T04: `analysisCallbacks` grows without bound.
 *
 * Defect: `electron/main.ts:64` declares the map, `:162` reads it, `:225`
 * writes it, and nothing ever deletes. One entry per `start_analysis`,
 * retained for process lifetime.
 *
 * Fail-first contract: the fix deletes the entry in the `stop_analysis`
 * handler and purges the window's entries on window close. Both deletions
 * are observable ONLY through a minimal operational `console.log` of the
 * map size on each touched path (start/stop/close) — main-process-internal
 * state with no test-only IPC surface (P2-T03 precedent: no debug APIs in
 * the preload). Pre-fix no such line is ever logged, so this spec FAILS BY
 * TIMEOUT on the old code and passes after. That failing mode is genuine:
 * the fixed behavior is unobservable pre-fix.
 *
 * Keying (read, not assumed): entries are `callback_id → webContents id`.
 * `start_analysis` registers via `sendCommand(cmd, params, callback_id,
 * event.sender.id)`; the renderer's `stopAnalysis()` sends NO params, so
 * the stop handler deletes by `callback_id` when present and otherwise
 * purges every entry owned by the sending window. Window close purges
 * every entry owned by that window's webContents id (a window can own
 * several — e.g. the PlayView boot analysis plus a spec-driven one).
 *
 * What the spec does:
 *  1. 20x start/stop cycles with a UNIQUE callback_id per start (this is
 *     what grows the map pre-fix: 20 retained entries). After the cycles it
 *     polls main-process stdio for the stop-path size-0 line and requires
 *     at least 20 of them — one per stop, each showing the map drained.
 *  2. Close path: one final start WITHOUT a stop (active registration),
 *     then `app.close()`. Requires the close-path log showing the entry
 *     dropped and 0 active. This also guards against a vacuous pass: if
 *     starts never registered (e.g. a shadowed handler), dropped would be
 *     0 and this assertion fails.
 *
 * Channels: Electron child stdout+stderr via `app.process()` stdio (probe
 * 2026-09-28: main-side `console.error` — the `[Python stderr]
 * `[fake-backend] ready`` line — reaches child stderr; `console.log` uses
 * the same pipe mechanism on stdout) plus the renderer console as a
 * belt-and-braces channel. All three are joined before matching, so the
 * assertions are stream-agnostic.
 *
 * Selectors/fixtures: same conventions as smoke.spec.ts — built main
 * (`dist/electron/main.js`, rebuild mandatory before running), stdlib
 * fixture backend via `AETHER_BACKEND_SCRIPT`, built renderer bundle
 * served on :5173 (dev-transport stand-in serving the canonical
 * dist/renderer artifact — P2-T21), unique mkdtemp
 * userData dir, existing `data-sq` board attribute (zero testids added).
 */
import { test, expect, _electron } from "@playwright/test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const MAIN_JS = path.join(ROOT, "dist", "electron", "main.js");
// P0-T09 override: the backend script the app spawns is chosen by this env
// var (guarded by fs.existsSync in getBackendScript()).
const FIXTURE_BACKEND = path.join(ROOT, "e2e", "fixtures", "fake-backend.py");
// Canonical `build:renderer` output dir (P2-T21 — config outDir, honored
// because the build script passes no CLI root arg; same artifact the
// packaged file:// branch loads — see smoke.spec.ts header).
const RENDERER_DIST = path.join(ROOT, "dist", "renderer");
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const CYCLES = 20;

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
            `port ${port} is already in use — stop the vite dev server so the spec serves the BUILT bundle (dist/renderer/) instead of testing the wrong renderer`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// Operational log lines emitted by electron/main.ts on each touched path.
// Pre-fix NONE of these lines exists anywhere in main, so every assertion
// below fails by timeout on the old code (genuine: unobservable pre-fix).
const STOP_ZERO_RE =
  /\[Analysis\] stop_analysis: 0 active analysis subscription\(s\)/;
const CLOSE_RE =
  /\[Analysis\] window closed: dropped (\d+) analysis subscription\(s\), 0 active/;

test("analysis map drains on stop (20x) and on window close", async () => {
  expect(
    fs.existsSync(MAIN_JS),
    `built main missing — run npm run build first (${MAIN_JS})`,
  ).toBe(true);
  expect(
    fs.existsSync(FIXTURE_BACKEND),
    `fixture backend missing (${FIXTURE_BACKEND})`,
  ).toBe(true);
  // P2-T21 path-equality pin: the packaged file:// branch (main.ts:309)
  // loads <__dirname>/../renderer/index.html === dist/renderer/index.html.
  expect(
    fs.existsSync(path.join(RENDERER_DIST, "index.html")),
    `canonical renderer artifact missing — run npm run build first (${path.join(RENDERER_DIST, "index.html")})`,
  ).toBe(true);

  const server = await serveRendererBundle(5173);
  // Unique scratch profile per run — isolates settings.json, the
  // game-history index and engineRegistry.userEnginesDir from real data.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-e2e-"));
  const app = await _electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, AETHER_BACKEND_SCRIPT: FIXTURE_BACKEND },
  });
  // Main-process stdio: the map lives main-side, and the size log lines
  // are the sanctioned observable (no test-only IPC surface).
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
  const combined = () =>
    [...stdoutChunks, ...stderrChunks, ...consoleTexts].join("\n");
  let closed = false;
  try {
    const page = await app.firstWindow();
    page.on("console", (msg) => {
      consoleTexts.push(`${msg.type()}: ${msg.text()}`);
    });
    await page.waitForSelector("[data-sq]", { timeout: 30_000 });
    await expect(page.locator("[data-sq]")).toHaveCount(64, {
      timeout: 30_000,
    });
    // Let boot settle (PlayView newGame + its debounced analysis start),
    // so the cycles run against a quiescent map.
    await page.waitForTimeout(3000);

    // 20x start/stop with a UNIQUE callback_id per start — pre-fix each
    // start retains one entry and no stop ever deletes, so the map grows
    // to 20+ and no size-0 stop line can appear.
    for (let i = 0; i < CYCLES; i++) {
      await page.evaluate(
        async ({ fen, id }: { fen: string; id: string }) => {
          const api = (window as unknown as { electronAPI: any }).electronAPI;
          await api.startAnalysis({ fen, multipv: 1, callback_id: id });
          await api.stopAnalysis();
        },
        { fen: START_FEN, id: `p2-t04-cycle-${i}` },
      );
    }

    // Poll for the stop-path evidence: one size-0 line per stop. Each
    // handler-side stop purges synchronously before the backend reply
    // resolves, so by loop end all 20 lines are already emitted post-fix;
    // the poll exists so that PRE-FIX this fails BY TIMEOUT (no such line
    // is ever logged) rather than by an instant count mismatch.
    const deadline = Date.now() + 15_000;
    let stopZeroCount = 0;
    while (Date.now() < deadline) {
      stopZeroCount = combined()
        .split("\n")
        .filter((l) => STOP_ZERO_RE.test(l)).length;
      if (stopZeroCount >= CYCLES) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(
      stopZeroCount,
      `expected >= ${CYCLES} stop-path size-0 lines, got ${stopZeroCount}.\n--- captured output ---\n${combined()}`,
    ).toBeGreaterThanOrEqual(CYCLES);

    // Close path: register one ACTIVE analysis (no stop), then close the
    // app. The window-closed handler must drop it and log 0 active.
    await page.evaluate(
      async ({ fen }: { fen: string }) => {
        const api = (window as unknown as { electronAPI: any }).electronAPI;
        await api.startAnalysis({
          fen,
          multipv: 1,
          callback_id: "p2-t04-close-probe",
        });
      },
      { fen: START_FEN },
    );

    await app.close();
    closed = true;
    // Give the pipe a beat to flush the close-path line before matching.
    await new Promise((r) => setTimeout(r, 1000));
    const out = combined();
    const closeMatch = out.match(CLOSE_RE);
    expect(
      closeMatch,
      `no window-close drain line in main output.\n--- captured output ---\n${out}`,
    ).not.toBeNull();
    expect(
      Number(closeMatch?.[1] ?? "0"),
      `window close dropped 0 entries — close-path purge did not fire (vacuous-pass guard).\n--- captured output ---\n${out}`,
    ).toBeGreaterThanOrEqual(1);
    // One-line evidence quote for the run log (counts, not full output).
    console.log(
      `[P2-T04 evidence] stop-size-0 lines: ${stopZeroCount}; close: ${closeMatch?.[0]}`,
    );
  } finally {
    if (!closed) await app.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
