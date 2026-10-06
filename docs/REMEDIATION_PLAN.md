# Aether Chess — Remediation Plan

**Status:** executable task list. Written to be worked through item-by-item without
conversation context. Every item is atomic: it names the files, the exact defect, the
change, the test, and the condition that closes it.

**Baseline (all currently green — nothing below is a build or type failure):**

| Check          | Command                                         | Baseline   |
| -------------- | ----------------------------------------------- | ---------- |
| Python tests   | `venv/bin/python -m unittest discover -s tests` | 122 passed |
| Electron tests | `npm run test:electron`                         | 21 passed  |
| Renderer lint  | `npm run lint`                                  | clean      |
| Python lint    | `ruff check .`                                  | clean      |
| Python types   | `pyright`                                       | 0 errors   |
| Build          | `npm run build`                                 | succeeds   |

> **Environment warning.** The bare `python -m unittest discover -s tests` fails with
> 8 `ModuleNotFoundError: No module named 'chess'` because dependencies live in `venv/`.
> That is an environment artefact, not a defect. Always use `venv/bin/python`. A correct
> toolchain (gcc 16.2.1, g++, make, cmake, `Python.h`) is present on this machine.

**Definitions of done for every item:**

1. The named test exists and fails before the change, passes after.
2. The full gate is green (table above, plus any suite added in Phase 0).
3. No unrelated behaviour is altered.

---

## Root-cause summary (read before starting)

| #   | Defect                                                                                                | Why the gate misses it                            |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | `makeAiMove` has 4 return paths, only 3 apply state — and both callers also apply it                  | No renderer test framework exists                 |
| 2   | `contextlib.redirect_stdout` is process-wide while every request runs on its own thread               | No test for `backend/service.py`                  |
| 3   | `export_pgn` reads `board.move_stack`, which history navigation truncates                             | No test for `chess_engine.py`                     |
| 4   | `_uci_lock` is documented in the service docstring but does not exist; requests are unbounded threads | No test for `service.py`                          |
| 5   | The dead stack has ~200 lines of passing tests; the live code has none                                | Coverage is concentrated on code that never ships |

**Item 5 is the meta-defect.** Fixing the tests is not housekeeping; it is what prevents
items 1-4 from recurring. Phase 0 therefore precedes all remediation.

---

# Phase 0 — Test harness

No item in Phases 1-4 is verifiable without this. Do not start Phase 1 until Phase 0 is
complete and the gate includes the new suites.

### P0-T01 — Add the renderer test stack ✅ DONE

- **Files:** `package.json` (devDependencies)
- **Change:** add `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`,
  `@testing-library/jest-dom`. Do not remove any existing dependency.
- **Done when:** `npm install` succeeds and `node_modules/vitest` exists.

### P0-T02 — Create `vitest.config.ts` ✅ DONE

- **Files:** `vitest.config.ts` (new)
- **Change:** `environment: 'jsdom'`; `include: ['renderer/src/**/*.test.{ts,tsx}']`;
  `setupFiles: ['./vitest.setup.ts']`; `resolve.alias` mapping `@` → `renderer/src` to
  match `vite.config.ts:6`.
- **Done when:** `npx vitest run` executes and reports 0 test files without a config error.

### P0-T03 — Create `vitest.setup.ts` ✅ DONE

- **Files:** `vitest.setup.ts` (new)
- **Change:** `import '@testing-library/jest-dom/vitest'`. Add stubs for `matchMedia` and
  `ResizeObserver` — both are already used by `renderer/src/views/PlayView.tsx:73` and
  `:86` and neither exists in jsdom.
- **Done when:** a smoke test that renders a component calling `useSettingsStore` runs green.

### P0-T04 — Add `test:renderer` and wire `test` ✅ DONE

- **Files:** `package.json` (scripts)
- **Change:** `"test:renderer": "vitest run"`. Replace the broken
  `"test:e2e": "playwright test"` with the two-tier scripts defined in P0-T09/P0-T10.
  Keep `test:electron` on `node --test` — it is a different runner and serves a different
  purpose; do not migrate it.
- **Done when:** `npm run test:renderer` and `npm run test:electron` both pass.

### P0-T05 — Add `typecheck:renderer` ✅ DONE

- **Files:** `package.json` (scripts)
- **Change:** `"typecheck:renderer": "tsc -p tsconfig.json --noEmit"`.
- **Why:** `tsconfig.json` covers `renderer/src/**` and today nothing ever runs it. The
  renderer is the largest part of the codebase and has zero type checking in CI.
- **Done when:** it passes now (expect this to surface pre-existing errors — fix or
  explicitly suppress each one, and record them in the PR body).

### P0-T06 — Widen `tsconfig.test.json` to include `e2e/` ✅ DONE

- **Files:** `tsconfig.test.json`
- **Change:** it currently sets `"rootDir": "electron"` and `"include": ["electron/**/*"]`,
  which excludes `renderer` and `e2e` by design. Leave it alone; create a separate
  `tsconfig.e2e.json` for Playwright specs in P0-T09 instead. Do not repurpose this file.
- **Done when:** `npm run test:electron` is unchanged and still emits to `dist-test/`.

### P0-T07 — Add `eslint-plugin-react-hooks` ✅ DONE

- **Files:** `package.json` (devDependencies), `eslint.config.js`
- **Change:** add the plugin and extend
  `reactHooks.configs['recommended-latest']` alongside `tseslint.configs.recommended`.
- **Why:** `exhaustive-deps` is the rule that would have caught P2-T02 (eval-bar
  freeze) and the duplicate analysis restart in `AnalysisView.tsx:74,105`. It is
  **expected** to report new violations. Triage each: if it is a genuine bug, fix it and
  note it in the PR; if it is intentional, add a scoped disable with a comment explaining
  why. Do not blanket-disable.
- **Done when:** `npm run lint` passes and the count of suppressions is justifiable
  line-by-line.

### P0-T08 — Create `playwright.config.ts` ✅ DONE

- **Files:** `playwright.config.ts` (new)
- **Change:** `testDir: './e2e'`, `timeout: 60_000`, `workers: 1` (Electron windows and
  scratch `userData` dirs must not race), `reporter: [['list'], ['html', {open: 'never'}]]`.
  **Critically: do not define `projects` or `use.browserName`.** Electron is driven by
  the `_electron` fixture against the app's own Chromium, so a browser-based config is the
  wrong shape and would require `npx playwright install`.
- **Done when:** `npx playwright test --list` enumerates specs without attempting a
  browser download.

### P0-T09 — Add the backend-script override for hermetic tests ✅ DONE

- **Files:** `electron/main.ts:81-85`
- **Change:** in `getBackendScript()`, read `process.env.AETHER_BACKEND_SCRIPT` first and
  return it when set. Guard with `fs.existsSync`.
- **Why:** `getPythonPath()` (`main.ts:70-79`) prefers `venv/bin/python3` and otherwise
  falls back to a bare `python3`. On a clean CI runner that interpreter has neither `chess`
  nor `numba`, so the backend dies on boot and every spec sees "Backend not connected".
  The override lets tier-1 specs point at a fixture script instead.
- **Done when:** setting the env var changes which script `PythonShell` receives, verified
  by a unit test in P0-T12 or by the smoke spec observing the fixture's handshake.

### P0-T10 — Add e2e scripts ✅ DONE

- **Files:** `package.json` (scripts)
- **Change:** `"test:e2e": "playwright test"`, `"test:e2e:real": "playwright test
--grep @real"`, and `"test:e2e:build": "npm run build && playwright test"`.
- **Done when:** `npm run test:e2e` runs against the fixture backend and
  `npm run test:e2e:real` is opt-in.
- **Verification (2026-09-28):** all three script strings verified present
  exactly as specified — installed by P0-T04's commit, no edit needed in this
  item. `npm run test:e2e` → `Error: No tests found`, exit 1 (zero specs; no
  browser download attempted; Playwright 1.59 exits 1 on empty — established in
  P0-T08). `npm run test:e2e:real` → same empty set, exit 1, `--grep @real`
  opt-in shape intact. `test:e2e:build` not run to completion (redundant: build
  gate-verified separately, spec list empty). Runnable-against-fixture proof
  lands with P0-T12 — the fixture backend + smoke spec are P0-T12 scope and do
  not exist yet, so that half of the done-when cannot be proven in this item
  (P0-T09 precedent).

### P0-T11 — Add Playwright artifacts to `.gitignore` ✅ DONE

- **Files:** `.gitignore`
- **Change:** append `test-results/`, `playwright-report/`, `blob-report/`, `.playwright/`.
- **Done when:** `git status` is clean after a full e2e run.
- **Verification (2026-09-28):** none of the four patterns existed in
  `.gitignore` (grep exit 1); all four appended under a `# Playwright e2e
artifacts` comment. Pre-change `git status --short` showed
  `?? test-results/` + `?? playwright-report/` (from earlier probe runs;
  `blob-report/` and `.playwright/` absent — preventive patterns).
  Post-change those entries vanish; `git check-ignore -v` maps all four to
  the new lines. Full `npx playwright test` (empty spec set, exit 1, no
  browser download) regenerated `test-results/.last-run.json` and
  `playwright-report/index.html` and both stay ignored — the scoped
  done-when. Residuals (expected, out of scope): `M
cpp_engine/build_msvc.bat`, `?? .spec/`, `?? e2e/` (P0-T12 owns e2e/
  content).

### P0-T12 — Write `e2e/smoke.spec.ts` ✅ DONE

- **Files:** `e2e/smoke.spec.ts` (new), `e2e/fixtures/fake-backend.py` (new)
- **Change:** the fixture speaks the same newline-delimited JSON-RPC as
  `backend/service.py` and answers `new_game`, `get_legal_moves`, `make_move`,
  `get_engine_move`, `list_bots` with canned responses. The spec launches via
  `_electron.launch({ args: ['dist/electron/main.js', `--user-data-dir=${tmpDir}`] })`.
  Assert: window opens, the backend-ready handshake completes, no `backend-error` is
  emitted, the board renders 8×8 squares, and the app closes cleanly.
- **Why the temp `userData`:** it isolates `settings.json`, the game-history index and
  `engineRegistry.userEnginesDir`, so specs never mutate real user data.
- **Selectors:** use `getByRole` and the 8 existing `aria-label`s
  (`TopBar.tsx:37,52,63,71,81`, `BottomNav.tsx:41`). There are **zero** `data-testid`
  attributes in the renderer today. Add testids only when a selector proves brittle, and
  add them in the same commit as the spec that needs them.
- **Done when:** `npm run test:e2e` passes from a clean checkout with no Python installed.

### P0-T13 — Add CI steps ✅ DONE

- **Files:** `.github/workflows/ci.yml`
- **Change:** in the `frontend` job, after `npm run build`, add
  `npm run typecheck:renderer` and `npm run test:renderer`, and add
  `npm run test:e2e` (hermetic tier — no Python install needed). In the `backend` job,
  add a step documenting that `venv/` is not required on the runner.
- **Done when:** CI is green and the new steps appear in the run log.

### P0-T14 — Document the local test invocation ✅ DONE

- **Files:** `CONTRIBUTING.md`, `docs/SETUP.md`
- **Change:** record `venv/bin/python -m unittest discover -s tests` and state explicitly
  why the bare command fails locally. Cross-reference from `docs/BACKEND_API.md`.
- **Done when:** a new contributor can reproduce the gate from the docs alone.

---

# Phase 1 — Criticals

Four independent defects. Each is one commit. Each ships with its test in the same commit.

### P1-T01 — Give `makeAiMove` exactly one state owner ✅ DONE

**Defect.** `renderer/src/views/PlayView.tsx` — `makeAiMove` returns from four places.
Three call `applyMoveResult` (`:386`, `:400`, `:410`); the opening-book branch at
`:304-305` returns without it. Both callers _also_ apply the result
(`handleNewGame:485`, `commitMove:521`). Two competing owners plus one missing call.

**Impact.** In `ai_vs_ai` mode the backend board advances while the store does not, so
`runAiVsAiLoop` (`:415-433`) re-reads the stale FEN and re-sends an already-played move.
The backend returns `ValueError: Illegal move`; the `catch` at `:424-426` silently ends
the game. `useOpeningBook` defaults to `true` with `openingBookDepth: 20`
(`settingsStore.ts:122,124`), so this fires on the first book move out of the box.

- **Change 1:** add a helper
  `const playAndApply = async (uci: string) => { const r = await window.electronAPI.makeMove({ move: uci }) as BackendMoveResult; useGameStore.getState().applyMoveResult(r); return r; };`
- **Change 2:** replace all four `makeMove` call sites inside `makeAiMove`
  (`:304`, `:385`, `:399`, `:409`) with `playAndApply`.
- **Change 3:** delete the redundant `.then((aiResult) => { if (aiResult) store.applyMoveResult(aiResult); })`
  at `handleNewGame:485` and `commitMove:521`. Keep the `.finally` that clears
  `engineBusy`.
- **Change 4:** remove the six `console.log` calls in the AI path
  (`:282`, `:303`, `:313`, `:368`, `:384`, `:408`).
- **Test:** `renderer/src/views/PlayView.test.tsx`. With `useOpeningBook: true` and a
  `getBookMoves` stub returning one legal move, assert the store FEN advanced. Separately
  assert `runAiVsAiLoop` plays two distinct plies before stopping.
- **Done when:** the book-path test fails before the change, and a repository-wide search
  shows exactly one `applyMoveResult` call site inside the AI flow.

### P1-T02 — Stop hijacking process-wide stdout ✅ DONE

**Defect.** `backend/service.py:290-298` — `handle_maia3_cache` uses
`contextlib.redirect_stdout`/`redirect_stderr`. These rebind `sys.stdout` for the **whole
process**. Every request is dispatched to its own daemon thread (`:567-572`), so any other
in-flight request that calls `_send` (`:78-83`) during a Maia download writes its JSON-RPC
response into a throwaway `StringIO`. The client never receives it and the promise hangs
until the 5-minute IPC timeout. A download takes minutes, so the collision window is wide.

- **Change 1:** add a small proxy installed **once**, before `main()`:
  a `ThreadLocalStream` class wrapping the real stream, with a thread-local depth counter.
  `write`/`flush` route to a per-thread capture buffer when that thread's depth is
  non-zero, otherwise to the wrapped real stream.
- **Change 2:** assign `sys.stdout` and `sys.stderr` to proxies at startup in `main()`.
  `_send` and all `traceback.print_exc(file=sys.stderr)` calls then work unchanged for
  every thread.
- **Change 3:** replace the `redirect_stdout` block at `:290-295` with a context manager
  that sets this thread's capture depth. Keep the existing tqdm pass-through loop at
  `:296-298` (it filters captured stderr for lines containing `%`).
- **Change 4:** delete the now-unused `import contextlib` and `import io` at the top of
  the function (`:265-266`).
- **Test:** `tests/test_service_io.py`. Monkeypatch a fake `maia3_cache` that writes to
  `stdout`; while it is inside the capture, invoke `_send({"id": "x", "result": 1})` from
  a second thread. Assert the JSON line reaches the real stdout, not the capture buffer.
  Also assert the reverse: a capture on one thread does not swallow another thread's writes.
- **Done when:** the test fails on the current code and passes after, and `rg redirect_std
backend/` returns only `aether_chess/engines/maia3_proxy.py:187` (see P2-T10).

### P1-T03 — Stop history navigation from corrupting the game ✅ DONE

**Defect.** `backend/chess_engine.py` — `navigate_to` (`:181-189`) replays moves onto
`self.board`, which **is** `self.game_state.board` (assigned at `:68`). Two consequences:

- `export_pgn` (`:750-751`) calls `self.game_state.to_pgn()`, and
  `GameState.to_pgn` (`aether_chess/models/game_state.py:57`) iterates
  `self.board.move_stack`. Navigate to ply 3, export, and the PGN is truncated to 3 plies.
  `_full_history` — the authoritative list — is never consulted.
- Worse: `make_move` at `:170` does `self._full_history = list(self.board.move_stack)`.
  Making a move while scrolled into history **permanently discards** the rest of the game.

- **Change 1:** add
  `def _board_from_full_history(self) -> chess.Board:` that replays `self._full_history`
  onto a fresh `chess.Board`. This is the pattern already used by `history_fens_and_moves`
  (`:705-714`) and `move_history_san` (`:199-207`).
- **Change 2:** make `export_pgn` build its PGN from that board, never from
  `game_state.board.move_stack`. Either give `GameState.to_pgn` an optional explicit move
  list, or construct a temporary `GameState` — prefer the explicit-moves parameter, it
  keeps the rule in one place.
- **Change 3:** in `make_move`, reject the call when `self._nav_index >= 0`. Return the
  same `(False, {})` shape the illegal-move path already uses, with a reason the renderer
  can surface. Alternatively return to the live position first — pick one and make
  `undo_move` (`:175-179`) and `navigate_to` consistent with it.
- **Test:** `tests/test_chess_engine_navigation.py`. Play 10 moves, navigate to index 3,
  assert `export_pgn()` still contains all 10 plies. Then assert `make_move` after
  navigation is rejected and `_full_history` is unchanged.
- **Done when:** both tests fail before the change; `to_pgn` is never called on the
  mutable shared board.

### P1-T04 — Establish a real concurrency boundary ✅ DONE

**Defect.** `backend/service.py`:

- The docstring at `:29-30` claims _"The shared engine singleton is protected by
  `_uci_lock`"_. `rg _uci_lock` over the entire repository returns **exactly one hit** —
  that comment. The lock does not exist. Only `_board_lock` and `_stdout_lock` do
  (`:62-66`).
- `:567-572` spawns an unbounded daemon thread per request with no pool, cap or dedup.
- `python-chess` does not support concurrent use of one `SimpleEngine`. Two overlapping
  `get_engine_move` requests, or an engine call racing `make_move`, share a handle.

- **Change 1:** declare `_uci_lock = threading.Lock()` beside the other locks at `:62-66`.
- **Change 2:** hold `_uci_lock` for the duration of every engine call: the
  `get_engine_move` / `get_bot_move` handlers and the `BotManager` call in
  `handle_start_analysis`. It may be held for the whole search — that is the point.
- **Change 3:** take `_board_lock` in the handlers that call `engine_mgr.fen()` as a
  fallback without already holding it.
- **Change 4:** replace the per-request `threading.Thread` with a module-level
  `ThreadPoolExecutor(max_workers=8)`. Submit `_process_request`; keep the stdin loop
  non-blocking, which is the property the current design is protecting.
- **Change 5:** rewrite the docstring at `:14-36` so it describes what the code now does.
  A false safety claim in the authoritative design document is itself a defect.
- **Test:** `tests/test_service_concurrency.py`. Launch 20 concurrent `get_engine_move`
  calls against a UCI stub that echoes and asserts no interleaved protocol corruption;
  assert the executor has a bound; assert two overlapping engine calls do not interleave.
- **Done when:** `rg _uci_lock backend/` returns a declaration plus every use site, and
  the docstring matches the implementation.

### P1-T05 — History navigation has no return-to-live transition ✅ DONE

Regression from P1-T03 (found live in `npm run dev`: every move after browsing
history rejected as bare `Illegal move`). P1-T03 rejects `make_move` whenever
`_nav_index >= 0`, but `navigate_to(len - 1)` — every UI "go to end" path (`End`,
`Last`, `→`, click-last-move) — replays the live FEN while storing
`_nav_index = len - 1`. The board looks live (same FEN, last move highlighted,
`MoveHistory` cannot display the difference) while all moves are rejected; the
service discards the guard `reason`, so the log is byte-identical to a genuinely
illegal move. Second hole, same root: `navigate_to(-1)` shows the startpos FEN
while storing the live sentinel, so a startpos-legal move is accepted and
silently replaces history — the tail-discard P1-T03 meant to kill.

- **Change 1:** replace the int sentinel with `Optional`: `None` == live.
  `navigate_to` with `index >= len(moves) - 1` restores the live board and sets
  `None`. `new_game` / `import_pgn` / `undo_move` / successful `make_move` clear
  to `None`. Keep the IPC snapshot shape (`-1` == live) so the renderer is
  untouched.
- **Change 2:** `handle_make_move` (`service.py`) surfaces `info.reason` instead
  of the bare `Illegal move`, so guard trips are distinguishable in logs.
- **Change 3 (only if needed):** a renderer `commitMove` auto-return-to-live.
  Prefer the backend clamp alone; record the decision.
- **Test:** extend `tests/test_chess_engine_navigation.py` — navigate-to-end
  then move accepted with history intact; `navigate(-1)` then startpos-legal
  move rejected with history intact; guard reason surfaces via the service
  handler.
- **Done when:** browse-then-return-then-move works from the UI paths above;
  both holes' tests fail before and pass after.

---

# Phase 2 — High severity

### P2-T01 — Settings load race ✅ DONE

**Defect.** `renderer/src/App.tsx:25-27` starts an async `settings.loadFromBackend()`.
`renderer/src/views/PlayView.tsx:126-129` runs `handleNewGame()` in a mount effect with
`[]` deps. React runs child effects before parent effects, so the game starts first — and
the payload at `PlayView:452-466` is built from the `settings` snapshot captured on the
first render. A user's `playEngine`, `stockfishPath`, `botStrength`, `thinkProfile`,
`threads` and `hashMb` are all ignored for the first game after launch.

`settingsStore.ts:99` already declares a `loaded: boolean` flag, set at `:159`, `:161`
and `:164`. **Nothing reads it** — the gate the code needed was built and never wired up.

- **Change:** `useEffect(() => { if (!settings.loaded) return; void handleNewGame(); return () => { aiLoopRef.current = false; }; }, [settings.loaded])`.
  `loadFromBackend` always resolves (its `catch` at `:163-165` sets `loaded: true`, and
  it handles a missing `window.electronAPI`), so this cannot deadlock startup.
- **Test:** `renderer/src/views/PlayView.test.tsx` — stub `loadSettings` to return
  `playEngine: 'maia3'`, assert `newGame` was called with `maia3`.
- **Done when:** the test fails on current code.

### P2-T02 — Eval bar frozen after the first move ✅ DONE

**Defect.** `PlayView.tsx:131-153` registers the analysis listener with `[]` deps and
filters inside the callback against `store.fen` (`:140`). `store` is the render-scope
snapshot, so `store.fen` is permanently the **initial** FEN. Every analysis push for a
later position is discarded. The debounced starter at `:156-191` does send the correct
current FEN, so requests succeed — the results are thrown away.

- **Change:** read `useGameStore.getState().fen` inside the callback instead of
  `store.fen`. Audit the other uses of `store.` inside async callbacks in this file
  (`:277`, `:280`, `:493`, `:507`) and convert the ones that must see current state.
- **Test:** dispatch an `analysis_update` for a later FEN; assert `store.analysis.fen`
  updates to it.
- **Done when:** `npm run lint` reports no `exhaustive-deps` suppression in this file.

### P2-T03 — IPC listener leak on every tab switch ✅ DONE

**Defect.** `electron/preload.ts:84-89` registers `onBackendError` / `onBackendClosed`
with `ipcRenderer.on` and **no removal counterpart**, unlike `onAnalysisUpdate` which is
paired with `removeAnalysisListeners` (`:79-81`). `App.tsx:44-68` returns a different
element per tab, so `PlayView` remounts on every Play↔Settings switch, and
`PlayView.tsx:121-124` adds two more subscriptions each time with no cleanup. After ~10
switches: `MaxListenersExceededWarning`, duplicate toasts, and `setState` on unmounted
components.

Separately, `removeAnalysisListeners` uses `removeAllListeners("analysis-update")`, so if
`PlayView` and `AnalysisView` were ever co-mounted one unmount would kill the other.

- **Change 1:** in `preload.ts`, store the wrapped listener per callback and expose
  `removeBackendListeners()`. Add it to `renderer/src/electron.d.ts`.
- **Change 2:** change `removeAnalysisListeners` to remove the specific wrapper by
  reference rather than all listeners for the channel.
- **Change 3:** add cleanup in both `PlayView.tsx:121-124` and `App.tsx:34-42`.
- **Test:** e2e — switch tabs 10×, assert no `MaxListenersExceededWarning` in the main
  process log and exactly one toast per backend failure.
- **Done when:** listener count is constant across mounts.

### P2-T04 — `analysisCallbacks` grows without bound ✅ DONE

**Defect.** `electron/main.ts:64` declares the map, `:162` reads it, `:225` writes it.
There is **no `.delete` anywhere.** One entry per `start_analysis`, retained for process
lifetime. A stale `wcId` can also route to a recycled window id.

- **Change:** delete the entry in the `stop_analysis` handler and on window close.
- **Test:** e2e — start/stop analysis 20×, assert the map size returns to 0.

### P2-T05 — Backend death hangs every request and never recovers ✅ DONE

**Defect.** `electron/main.ts:191-197` — the `close` handler sets `pyShell = null` and
emits `backend-closed`, but does **not** reject entries in `pendingRequests` (`:51-64`),
so each renderer promise waits out its full timeout. Nothing respawns the backend, so
`backendConnected` stays `false` for the session and every later IPC call hits a dead
shell. Also `mainWindow` is a module-level global, so events never reach a second window.

- **Change:** reject all pending requests with a clear "backend exited" error; respawn
  lazily on the next IPC call or expose an explicit reconnect.
- **Test:** e2e — kill the backend process, assert in-flight and subsequent calls reject
  promptly rather than hanging, and that the app recovers.

### P2-T06 — Unrestricted `shell` calls from the renderer ✅ DONE

**Defect.** `electron/main.ts:561-564` (`open-external-url` → `shell.openExternal`) and
`:601-604` (`reveal-in-folder` → `shell.showItemInFolder`) pass renderer-supplied values
through unfiltered. `file://` and `smb://` (an NTLM relay on Windows) are reachable, and
`showItemInFolder` will reveal any filesystem path. Combined with the loose `on*` bridge,
any script in the renderer can call it.

- **Change:** allowlist `https:` and `mailto:` for `openExternal`; resolve `filePath`
  against known roots (`app.getPath('userData')`, the history dir, the engines dir) and
  reject anything outside them.
- **Test:** unit-test both handlers with rejected inputs.
- **Done when:** this is fixed on its own merits regardless of the other work.

### P2-T07 — In-flight AI moves are never cancelled ✅ DONE

**Defect.** `PlayView.tsx` — `makeAiMove` promises from `commitMove` (`:521`) and
`handleNewGame` (`:488`) are not tracked, so `aiLoopRef` (which only governs the AI-vs-AI
loop) cannot cancel them. Undo or New Game while the engine thinks lets a late
`applyMoveResult` write a **previous game's FEN** over the new position.
`handleUndo` (`:599`) additionally has no `engineBusy` guard and issues no cancellation.

- **Change:** add a monotonic `gameGenerationRef`, incremented in `handleNewGame`,
  `handleUndo` and `handleNavigate`. `makeAiMove` captures it on entry and discards its
  result if it no longer matches. Guard `handleUndo` with `engineBusy`.
- **Test:** start an AI move, immediately undo, assert the store is unchanged.

### P2-T08 — Accuracy annotations keyed inconsistently ✅ DONE

**Defect.** `renderer/src/stores/gameStore.ts:227` builds `byUci` keyed by **row index**
(`${r.uci}:${i}`) but `:232` looks it up by **occurrence count** within `moveHistory`.
These coincide only while every UCI is unique. One `a2a3` double-push, a knight shuffle,
or any repeated move desynchronises the map; subsequent annotations are dropped or
attached to the wrong move.

- **Change:** compute each row's own occurrence index within `rows` and key by that.
- **Test:** a game containing a repeated move; assert every row is annotated and none
  lands on the wrong ply.

### P2-T09 — Move colour inferred by history parity ✅ DONE

**Defect.** `gameStore.ts:160` — `color: i % 2 === 0 ? 'white' : 'black'`. A game loaded
from a FEN or PGN where Black is to move labels every move with the wrong colour, which
then corrupts the per-side accuracy averages in `AnalysisPanel.tsx:62-70`.

- **Change:** derive colour from the backend per-move record. Add a `color` field per move
  in the `_state_snapshot` response (`backend/chess_engine.py:209-233`) rather than
  recomputing it in the client.
- **Test:** load a black-to-move FEN; assert the first move is labelled black.

### P2-T10 — Maia3 ignores its time budget ✅ DONE

**Defect.** `aether_chess/bots/maia3_bot.py:55-85` never reads
`request.time_limit_sec`, while every other bot clamps it. `aether_chess/engines/maia3_proxy.py:183`
hardcodes `Limit(time=0.1)` and `:206-214` **independently re-samples** a budget, so Maia3
receives a different one from the value `bots/manager.py` already resolved and passed in —
the "silently advantaged bot" the repo's contributing rules forbid. Confirms open
`TODO.md` item 4.

The hang-guard at `:124-127` also does not work: it wraps `future.result(timeout=300)` in
`with ThreadPoolExecutor(...)`, whose `__exit__` calls `shutdown(wait=True)`, so a hung
`ping()` blocks regardless. Each retry leaks a thread and a subprocess.

- **Change:** clamp the resampled think time to the caller's remaining budget; remove the
  independent resample; make the timeout an explicit `shutdown(wait=False)` on a
  persistent executor so it actually bounds the wait.
- **Test:** a slow stub proxy; assert elapsed ≤ budget + tolerance.
- **Done when:** `TODO.md` item 4 is struck.

### P2-T11 — King endgame PST applied to every piece ✅ DONE

**Defect.** `aether_chess/engines/mentor_engine.py:1065` — inside the loop over piece
types `(0,1,2,3,4)` = pawn/knight/bishop/rook/queen, the code does
`mg_score += val + pst[sq]` but `eg_score += val + pst_king_end[sq]`. `pst_king_end` is a
king-centric endgame table applied to every non-king piece, materially corrupting endgame
evaluation engine-wide. (The `phase` blend at `:1088-1093` is **correct** — do not
"fix" it. Only the table choice is wrong.)

- **Change:** per-piece-type endgame tables, or apply `pst_king_end` to kings only.
- **Test:** assert each piece type's contribution uses its own table; assert evaluation is
  antisymmetric under colour flip.

### P2-T12 — `mg_score` and `eg_score` are the same number ✅ DONE

**Decision: DROPPED** (2026-09-29). No code reader branches on the values
(`EvalBar.tsx:109,116` + `gameStore.ts:212` consume only `eval_cp`; all
`mg_score`/`eg_score` declarations were optional pass-through), and
`MentorEngine` exposes no mg/eg entry point (`_eval_numba` returns only the
blended score — exposing it would mean refactoring the numba JIT signature
for unread fields). Snapshot is now exactly `{eval_cp, phase}`; helpers
deleted; `gameStore` types, e2e fixture, and `BACKEND_API.md` updated.

**Defect.** `backend/chess_engine.py:671-703` — `_get_mg_score` and `_get_eg_score` are
byte-identical, and both sum raw material values with `KING = 20000` dominating. The
`mg_score` / `eg_score` fields consumers reason about are therefore always identical and
meaningless.

- **Change:** implement them against the mentor engine's real middlegame/endgame
  evaluation, or drop both fields from the snapshot. Prefer implementing — three consumers
  already read them.
- **Test:** assert the two differ on a middlegame position and both are finite ints.

### P2-T13 — Capture sound fires on nearly every move ✅ DONE

**Defect.** `PlayView.tsx:509-511` —
`oldBoard.replace(/[PNBRQK]/g,'') !== newBoard.replace(/[pnbrqk]/g,'')` strips _white_
pieces from the old FEN and _black_ pieces from the new one, then compares two
non-comparable strings.

- **Change:** compare piece counts (old minus new for the captured colour) or check
  whether the destination square was occupied.
- **Test:** a non-capturing move produces no capture sound; an actual capture does.

### P2-T14 — Packaged app ships all devDependencies ✅ DONE

**Defect.** `build/electron-builder.yml:9-13` — an explicit `node_modules/**/*` glob
replaces electron-builder's production-dependency filter, so `@playwright/test` (and its
browser payloads), `electron`, `typescript`, `eslint` and `tailwindcss` are all packaged
into the distributed app.

- **Change:** drop the line so electron-builder prunes, or list production deps explicitly.
- **Test:** build a package and assert the asar contents contain no devDependency.
- **Verification (2026-09-29):** defect did NOT reproduce on electron-builder 24.13.3 —
  the pre-change `--linux --dir` package already contained zero devDependencies
  (production collector prunes regardless of the glob; see `builder-debug.yml`
  `nodeModuleFilePatterns`). The glob was dropped anyway as a footgun (one-line
  removal); pre/post asar file sets are byte-identical (1044 entries, 9.8 MB),
  prod deps present (react, zustand, python-shell, electron-updater). Full gate green.

### P2-T15 — Packaged backend built from unpinned dependencies ✅ DONE

**Defect.** `build/build-backend.sh:11` runs
`pip install pyinstaller python-chess onnxruntime`, ignoring `requirements.txt`. The
frozen binary can ship different library versions from the ones the 122-test suite
validated (python-chess is verified at 1.11.2 locally).

- **Change:** install from `requirements.txt`; record resolved versions in the build log.
- **Done when:** the build script references no hard-coded package list.
- **Verification (2026-09-29):** pre-change quoted `:11`
  `pip install pyinstaller python-chess onnxruntime` with zero `requirements`
  references (grep exit 1). Post-change the script runs
  `pip install -r requirements.txt`, derives the pyinstaller pin from the same
  file (`grep '^pyinstaller' | sed 's/ *;.*//'` → `pyinstaller>=6.0`; needed
  because the `; extra == "build"` marker evaluates False under `-r`, verified
  via `packaging.markers`), and emits `pip freeze` into the build log. No
  literal `pip install <name>` remains (grep exit 1); `bash -n` clean. Live
  build skipped — pyinstaller in neither `venv/` nor PATH here; static
  assertion + log-step presence is the proof, not a built-binary proof. Full
  gate green (python 146 OK, ruff clean, pyright 0, lint 0 errors, build
  exit 0). Staged: script + this mark only; `backend-dist/` stays ignored.

### P2-T16 — Board file labels are mirrored when flipped ✅ DONE

**Defect.** `renderer/src/components/Board.tsx:126` — `const fileLabel = 'abcdefgh'[file]`
uses the grid index, ignoring the 180° mapping. `displayFile` / `displayRank` (`:95-102`)
implement the flip correctly and `rankLabel` (`:127`) is right by coincidence, but the
file label is not. Playing as Black — the default `handleNewGame` sets via
`setFlipped(resolvedColor === 'black')` — shows `a…h` reversed.

- **Change:** `'abcdefgh'[displayFile]`.
- **Test:** assert the top-left file label is `a` unflipped and `h` flipped.
- **Verification (2026-09-29):** test-first `renderer/src/components/Board.test.tsx`
  (new, Board mounted directly — no PlayView `boardSize` gate): unflipped top-left
  `a8` / file label `a` passes pre-fix; flipped top-left `h1` reads `a` pre-fix
  (recorded FAIL) and `h` post-fix. One-expression change at `:126`, nothing else
  in `Board.tsx`. Reading note: the item's "`rankLabel` right by coincidence" does
  not hold — `:127` `String(8 - rank)` uses the grid rank where the displayed square
  needs `8 - displayRank` (e.g. flipped top row labels `8` on rank-`1` squares);
  left untouched per the one-expression rule, flagged as follow-up. Full gate green.

### P2-T17 — Canvas overlay not redrawn on flip ✅ DONE

**Defect.** `renderer/src/components/BoardDrawingLayer.tsx` — the redraw effect deps
(`:438`, `[drawCanvas]`) omit `flipped` (plan anchors `:366-372`/`:427-434` drifted;
actual: `toPoint` `:370-376`, `drawCanvas` deps `:431`, redraw effect `:433-438`), so
with stable arrow/analysis props toggling flip never re-invokes the canvas painter.
`flipped` is read only via `flippedRef` (`:369`), which syncs every render and is
always current — the defect is purely the missing re-trigger, not a stale read.

- **Change (minimal variant of the prescription):** `flipped` joins the redraw-effect
  array only (`:438` → `[drawCanvas, flipped]`). Adding it to `drawCanvas`'s array too
  is redundant (either alone re-fires, since the ref read is always current) and trips
  `exhaustive-deps` (`unnecessary dependency` — the closure reads `flippedRef.current`,
  not the prop). Single dep keeps lint at baseline (0 errors, 3 pre-existing warnings),
  no suppressions, no ref-pattern disturbance (P0-T07 latest-ref mirrors untouched).
- **Test:** `renderer/src/components/BoardDrawingLayer.test.tsx` (new; separate from
  `Board.test.tsx`, which owns label assertions without canvas). Scoped `getContext`
  recording-stub + fixed 448px `getBoundingClientRect` mocks (jsdom ctx is null; no
  `canvas` package — verified absent, not installed). Stable identities for every memo
  input (naive version passed pre-fix: fresh `[]` defaults bust the memo each render).
  e2→e4 arrow paints tail at (252,364) unflipped; after flip must repaint at (196,84):
  zero paint calls pre-fix (recorded FAIL), exact flipped coords post-fix.
- **Verification (2026-09-29):** coordinate-level assertion achieved (not a mere
  effect-spy). Production nuance: PlayView/Board hand down fresh `[]` defaults, so the
  overlay currently repaints by accident on flip; the fix converts accidental repaint
  into guaranteed repaint (register §3 P2-T17 'not yet proven' now proven at unit
  level — register touch-up left to coordinator per one-item scope). Full gate green:
  python 146 OK, ruff clean, pyright 0, electron 45 pass, lint 0 errors,
  build succeeds, typecheck:renderer clean, test:renderer 17 pass, test:e2e 4 pass.

### P2-T18 — Duplicate analysis start and missing dependency ✅ DONE

**Defect.** `renderer/src/views/AnalysisView.tsx:105` calls `handleStartAnalysis()`
directly, while the effect at `:54-74` independently restarts analysis 350 ms later on
the same `store.fen` change — two concurrent starts per navigation. The effect's deps also
omit `settings.playEngine`, which `:85` uses to pick the analysis engine, so switching
engines mid-analysis never takes effect.

- **Change:** drop the direct call at `:105`; add `settings.playEngine` to the deps.

### P2-T19 — Misc latent defects ✅ DONE

- `aether_chess/bots/base.py:272-275` — a numeric score overwrites the value while
  `is_mate` stays `True`, so a position can report "mate in N" with a centipawn score.
  Clear `mate_in` whenever `is_mate` is false.
- `renderer/src/stores/gameStore.ts:212` — `toast-${Date.now()}` collides within the same
  millisecond; it is the React key and the dismiss filter. Add a random component, as
  `electron/main.ts:222` already does.
- `renderer/src/components/MoveHistory.tsx:100` — the black-move button renders and is
  clickable when `black` is undefined. Return `null` instead.
- `electron/main.ts:829` — `b.played_at.localeCompare(...)` throws on a legacy or
  hand-edited index entry. Give `played_at` a default in `loadGameIndex`.
- `backend/service.py:246-250` — `num_games` is an unclamped loop bound taken from IPC
  input. Clamp it.
- `aether_chess/models/game_state.py:52-68` — `load_pgn` silently skips illegal moves, so
  a corrupt PGN loads as a _different legal game_ with no warning. Raise instead. Also
  `move_history` and `board.move_stack` are maintained as independent sources of truth;
  derive one from the other.
- `aether_chess/engines/maia3_proxy.py:187` — the same `redirect_stdout` class of bug as
  P1-T02, in a different module. Fix alongside it.
- `aether_chess/engines/mentor_engine.py` — duplicated `_HAS_NUMBA` (`:1175`, `:1180`) and
  an unused `_phase` (`:1220`).
- `aether_chess/analysis/metrics.py:8-9` — `math.exp` overflows for very negative mate
  scores (latent; no production caller).
- `aether_chess/io/opening_book.py` — `choose_weighted` is unused; book readers reopen the
  file per lookup. See P4-T05.

### P2-T20 — `cancelled`: item P2-T09 in the original review (orphaned UCI subprocess)

**Defect.** `aether_chess/engines/uci_engine.py:41-51` — _partially_ correct already: the
code assigns to a local `engine` before `configure()` (the original review wrongly
reported an attribute-aliasing bug). But if `configure()` raises, the local is never
`quit()`, so the spawned process is orphaned while holding its Hash megabytes.

- **Status:** this file is **deleted** in Phase 3 (P3-T06), so the defect disappears with
  it. No action. If P3-T06 is descoped, add `try: ... except: engine.quit(); raise`.
- **Closure (2026-10-05, with P3-T06):** `aether_chess/engines/uci_engine.py` deleted; P2-T20 closes with it — no `try/except` needed, orphan path gone with the file.

### P2-T21 — Renderer build output never reaches the packaged path ✅ DONE

**Defect.** `package.json:12` runs `vite build renderer`, which sets the Vite root to
`renderer/` — so the bundle lands in `renderer/dist/`, empirically verified
(`dist/` contains only `electron/`; `dist/renderer/` does not exist after
`npm run build`). But the packaged path reads elsewhere: `electron/main.ts:269`
loads `file://<__dirname>/../renderer/index.html`, and
`build/electron-builder.yml:9-13` packages `dist/renderer/**/*`. `npm run dist`
therefore ships a window that loads a missing file. Found during P0-T12, which
works around it by serving the built bundle on `:5173` — so the `file://`
production path is additionally untested by e2e.

- **Change:** pick one authority and reconcile: the vite `outDir`
  (`vite.config.ts:12`), the build-script root argument (`package.json:12`), or
  the `main.ts:269` load path. Land the built bundle where main and the builder
  both read it.
- **Test:** after `npm run build`, assert `dist/renderer/index.html` is fresh.
  Retire the P0-T12 `:5173` static-server workaround in `e2e/smoke.spec.ts` so
  the smoke spec exercises the real `file://` branch.
- **Done when:** the packaged app loads its renderer, and e2e covers the
  `file://` path. Schedule with the P2-T14/P2-T15 packaging cluster, which
  already opens the builder config.
- **Verification (2026-10-03):** mechanism proven by `resolveConfig`: the
  `renderer` CLI root arg makes Vite discard the config's absolute outDir
  for the default relative `dist` (root `…/renderer`, outDir `dist` —
  lands `renderer/dist/`); no arg honors `…/dist/renderer`. Fix: drop the
  arg (`vite build`; config already sets `root`), plus `base: './'` (the
  packaged probe showed absolute `/assets/…` 404 under file://). Fresh
  `dist/renderer/index.html` post-`npm run build`; `--linux --dir` asar
  contains it; packaged binary boots
  `file://…/app.asar/dist/renderer/index.html` with the board rendered
  (backend handshake still blocked — no backend binary exists here, P2-T15).
  All 4 e2e specs serve the canonical artifact with a path-equality
  pre-flight pin; :5173 narrowed to dev-transport only. Full gate green.

### P2-T22 — `backendConnected` never restores after backend respawn ✅ DONE

Gap left by P2-T05 (found during its verification): `PlayView.tsx:119` holds
`backendConnected` in local state, set `false` on `backend-closed`/`backend-error`
(`:125-126`), and nothing ever sets it back. P2-T05 proves IPC-level recovery
(post-kill `newGame` round-trips), but the export guards (`:729`, `:789`, `:800`)
keep gating with "Backend not connected" for the rest of the session.

- **Change:** emit a `backend-ready` event from main on (re)spawn and set the
  flag `true` on it (preload + `electron.d.ts` + PlayView/App wiring). Boot spawn
  emitting ready is harmless (flag starts `true`).
- **Test:** extend `e2e/backend-death.spec.ts` — post-recovery, assert the
  export guards no longer gate (or the flag-observable equivalent the
  implementation chooses).
- **Done when:** kill → respawn → export path works without reload.
- **Verification (2026-10-03):** emission point is the post-spawn ready
  signal, not the spawn call — `stderrParser` (`main.ts`) forwards
  `backend-ready` only on a stderr line containing `"] ready"` (real:
  `[aether_backend] ready`; fixture: `[fake-backend] ready`), so a spawn
  that dies before printing ready emits nothing and close/error still
  drive the flag false (respawn → ready → flag true; spawn-fail → closed
  → flag false). Boot spawn re-asserts the initial `true` (no-op, no new
  toast, happy path unchanged). Preload `onBackendReady` mirrors the
  P2-T03 unsubscribe-handle shape (no removeAllListeners, no ref-keyed
  removal); `electron.d.ts` + PlayView flag wiring in the same commit.
  App owns no flag (toast-only block) — deliberately no subscription
  there (a no-op listener for zero effect, a toast would break the
  no-new-toasts rule). Test-first: extended `backend-death.spec.ts` step
  (iv) drives the FEN export button post-recovery — pre-fix FAIL recorded
  (`exported=false gatedToastsVisible=1`, "Backend not connected" toast,
  no IPC), post-fix green (`exported=true gatedToastsVisible=0`, first
  click). Fallout (same commit, test-only): `PlayView.test.tsx` electronAPI
  stub gains `onBackendReady` noop (9 renderer tests threw without it).
  Full gate green: python 160 OK, ruff clean, pyright 0, electron 45 pass,
  lint 0 errors (5 pre-existing warnings, byte-identical on HEAD),
  build succeeds, typecheck:renderer clean, test:renderer 23 pass,
  test:e2e 4 pass.

### P2-T23 — Maia proxy double-discounts the resolved budget ✅ DONE

Follow-up to P2-T10 (found on challenge): `manager.resolve_budget` samples the
think profile ONCE (`manager.py:185-192`), and Stockfish (`Limit(time=budget)`)
and Mentor (`search_config(strength, budget)`) consume it directly. Maia3Proxy
re-samples the profile and takes `Limit(min(sampled, budget))` (`:236`) — the
minimum of two independent rolls. Measured: budget 3.23 → limit 1.05. Maia
systematically thinks less than the aligned budget whenever its second roll
lands lower: the mirror image of the "silently advantaged bot" P2-T10 fixed,
in the disadvantaged direction. P2-T10 kept the proxy-side roll where the plan
said to remove the independent resample.

- **Change:** proxy drives `Limit` from `time_limit_sec` directly; drop its
  `sample_think_time` call. Profile shaping lives in `resolve_budget` alone.
  Keep the clamp.
- **Test:** extend `tests/test_maia3_budget.py` — budget B under profiles whose
  samples would differ → engine sees `Limit(time=B)` exactly, both profiles.
- **Done when:** Maia's elapsed matches the manager budget like the other bots;
  `rg sample_think_time aether_chess/engines/maia3_proxy.py` returns zero.

- **Verification (2026-10-03):** test-first `TestMaia3BudgetExactUnderProfiles`
  (B=3.0, time_remaining=10s, so the proxy-side safe_cap is 2.0s): pre-fix FAIL
  on both profiles (`[blitz] engine saw limit 1.2678, not caller budget 3.0`;
  `[classical] engine saw limit 2.0, not caller budget 3.0` -- the second roll
  min()d the budget); post-fix `seen_limits=[3.0]` under both profiles,
  elapsed 3.00s/3.01s, proxy-side `sample_think_time` calls 0 (wraps-spy with
  create=True, since the fixed code drops the import). `rg sample_think_time
aether_chess/engines/maia3_proxy.py` returns zero (whole import line dropped;
  both names served only the removed resample). `think_profile` /
  `time_remaining` / `time_increment` params KEPT with comment (keyword callers
  in `maia3_bot.py:73` + `backend/chess_engine.py` proxy call; the
  `_ensure_engine` key never used the profile; temperature/top_p/model/elo
  untouched). Full gate green: python 161 OK, ruff clean, pyright 0, electron
  45 pass, lint 0 errors (5 pre-existing warnings), build succeeds,
  typecheck:renderer clean, test:renderer 23 pass, test:e2e 4 pass (two earlier
  full-run UI-click flakes under memory pressure; every spec also passes solo
  and in pairs, and no e2e path executes the proxy -- fixture/renderer only
  mention maia3 in comments).

Note (no item): classical's "5–120s typical" doc vs the 5.0s ceiling is GLOBAL
(`clamp_time_limit` caps every bot) and the ceiling serves comparability — doc
describes pre-clamp buckets. Product copy, out of this track.

### P2-T24 — Classical think profile collapses to a constant 5s ✅ DONE

Conceded on challenge: raw classical samples measure 9–35s (mean ~22s), so the
global 5.0s ceiling (`clamp_time_limit`) clips EVERY classical roll — classical
is 5.00s flat, zero variability, and the profile's stated purpose (variability,
thought-ish pacing per profile) is defeated for the whole top tier, all bots.
Blitz varies (~1–5s); classical is a constant. Not Maia-specific.

- **Change:** rescale the classical bucket in `think_profile.py` so its sampled
  range varies _within_ the ceiling (e.g. shaping that lands 2–5s instead of
  9–35s-clipped-to-5), or otherwise restore variance without touching the
  global ceiling (the ceiling stays — it serves comparability). Product decision
  recorded here: variability within budget, not longer budgets.
- **Test:** sample classical N times → assert variance (not constant) and every
  sample within budget/ceiling.
- **Done when:** classical elapsed varies run to run while never exceeding the
  aligned budget.

- **Verification (2026-10-03):** test-first `tests/test_classical_profile.py`
  (new, 3 tests, seeded N=100 with RNG save/restore): pre-fix FAIL recorded
  (`only 3 distinct classical budgets in 100 samples`, raw median 20.50s >
  5.0s; 98/100 resolved budgets parked exactly on the ceiling) and the
  within-ceiling guard already green (the clamp held even before the fix).
  Post-fix all 3 green (65 distinct, 36/100 at ceiling, raw median ~4.6s,
  resolved mean 4.21s). Reshaping is bucket parameters only — sampler,
  `MAX_TIME_LIMIT_SEC`, manager and bots untouched; blitz/rapid/human_like
  seeded sequences byte-identical pre/post (BLITZ30/RAPID30 exact match).
  Classical description words corrected to the new shaping
  (`2–5s typical ... within the 5.0s ceiling`); renderer `SettingsPanel`
  `Classical (deep, 5-120s)` option copy left as product-copy follow-up
  (same track as the line-796 note). Full gate green except one
  HEAD-pre-existing e2e UI flake (`listener-leak.spec.ts` Settings-tab click
  timeout — fails identically on stashed clean HEAD `685ebf6`, hermetic
  fixture/renderer path loads no `aether_chess` code, so out of this item's
  scope by construction).

### P2-T25 — Board rank labels are mirrored when flipped ✅ DONE

Follow-up to P2-T16 (found during its verification, left out by the
one-expression rule): `Board.tsx` `rankLabel` uses `String(8 - rank)` — the
grid rank — while the displayed square's rank is `8 - displayRank`. The plan's
"right by coincidence" does not hold: flipped, the top row (true rank 1)
labels `8`, i.e. the right column reads 8…1 top-to-bottom for squares 1…8.

- **Change:** `String(8 - displayRank)` (symmetric with the P2-T16 fix).
- **Test:** extend `Board.test.tsx` — flipped rank assertions both columns.
- **Done when:** rank labels match their squares in both orientations.
- **Verification (2026-10-03):** test-first `Board.test.tsx` P2-T25 block
  (unflipped left column 8…1, flipped right column 1…8, per-square
  label-equals-rank plus absent-label checks on the unlabeled column):
  pre-fix flipped FAIL recorded (`8,7,6,5,4,3,2,1` vs expected
  `1,2,3,4,5,6,7,8`), unflipped green throughout. One-expression fix at
  `Board.tsx:127`, nothing else in `Board.tsx`. Full gate green.

### P2-T26 — Classical UI copy still promises 5–120s ✅ DONE

Left stale by P2-T24 (one line): `SettingsPanel.tsx:627` offers
`Classical (deep, 5-120s)` while the bucket now shapes 2–5s.

- **Change:** copy to `Classical (deep, 2-5s)`.
- **Test:** vacuous for copy — fail-first cannot apply; verification is the
  renderer suite staying green + the string matching the profile desc.
- **Done when:** no `120s` claim remains user-facing.

---

# Phase 3 — Structural

### P3-T01 — Backend owns the clock and game termination ✅ DONE

Today the renderer counts down a cosmetic `setInterval` (`PlayView.tsx:262-272`) that
clamps at `00:00` and does nothing else — no flag detection, so a game continues
indefinitely past the time limit. Nothing in the backend decrements a clock;
`time_remaining` is used only to size the engine search (`chess_engine.py:527-533`).
Separately, `handleResign` (`PlayView.tsx:692-710`) and `handleDraw` (`:712`) mutate the
Zustand store alone; the backend still reports the game as live, and the autosave at
`:198-260` writes a PGN for a game the backend considers unfinished.

- **Change 1:** add clock state to `chess_engine.py` — `_white_ms`, `_black_ms`,
  `_increment_ms`, and a monotonic start timestamp per turn. Confirm
  `handle_new_game` (`service.py:102-104`) already receives `time_control` and that
  `ChessEngineManager.new_game` actually consumes it; if not, wire it.
- **Change 2:** debit the mover inside `make_move` before applying the move, then add the
  increment. Detect flag-fall when the debited value is ≤ 0 and set
  `result` / `termination` (`Flag falls`).
- **Change 3:** add `resign` and `draw` commands. Resign records the losing side; draw
  records `1/2-1/2` with a termination.
- **Change 4:** include a `clock` object in every `_state_snapshot` (`:209-233`) so the
  renderer has one authority.
- **Change 5:** delete the `setInterval` at `PlayView:262-272`; render `store.clock`.
  Decide the tick source — a short poll of the snapshot, or a push channel — and document
  the choice.
- **Change 6:** key autosave off the **backend's** `result`, not the local
  `store.gameResult`.
- **Test:** `tests/test_chess_engine_clock.py` — flag-fall ends the game; increment is
  applied after each move; the clock resets on new game; switching to Unlimited clears
  both clocks; the snapshot is never internally inconsistent (time ≥ 0, correct side).
- **Done when:** no client-side timer remains and the backend alone can end a game.

### P3-T02 — One settings schema ✅ DONE

Defaults are defined **five** times, with no validation and no version field:
`resources/config/settings.defaults.json:1-26` (a strict _subset_ — no Maia3,
think-profile, Mentor-eval or opening-book keys), `settingsStore.ts:105-136`,
`electron/main.ts:87-132`, `chess_engine.py:53-67`, and the dead
`aether_chess/models/settings.py:28-40`.

Limits actively contradict: the UI offers 64 threads (`settingsStore.ts:41`) and 2048 MB
hash (`:39`), while backend paths clamp to 8 and 512.

`loadFromBackend` (`settingsStore.ts:153-166`) shallow-merges persisted data unchecked,
**bypassing** the clamping `update()` applies at `:142-151`. A hand-edited
`settings.json` with `threads: 99999` goes straight to the engine's `setoption`.

- **Change 1:** add `backend/settings_schema.py` as the canonical definition, exposing
  `settings_defaults()` and `settings_validate(raw)`. Move every clamp there.
- **Change 2:** add a `settings_defaults` command so the renderer's `DEFAULTS` comes from
  the backend at boot rather than being restated.
- **Change 3:** run `loadFromBackend` through the same validation as `update`.
- **Change 4:** add `schemaVersion` and a migration function.
- **Change 5:** reconcile the limit contradictions — pick one authority and have the UI
  read the max from the backend rather than hard-coding it.
- **Change 6:** debounce `saveToBackend` (`settingsStore.ts:150`, `:168-177`); it currently
  writes the whole file synchronously on every slider tick and swallows all errors.
- **Test:** `tests/test_settings_schema.py` (defaults, clamps, migration, unknown-key
  handling) and `renderer/src/stores/settingsStore.test.ts` (a junk `settings.json` is
  clamped; debounce coalesces; a save failure surfaces).
- **Done when:** `rg "hashMb" backend/ renderer/src electron` shows the limit in exactly
  one place.

### P3-T03 — Write a schema for the IPC surface ✅ DONE

Every payload is `Record<string, unknown>` / `unknown` with zero validation
(`electron/preload.ts:12-64`), so a malformed `maia3_model` or `fen` reaches the backend
unchecked.

- **Change:** define a schema for the commands that take structured input, validate at the
  `ipcMain.handle` boundary, and return a clear error instead of forwarding garbage.
- **Note:** keep this proportional. Do not build a full codegen pipeline.
- **Verification (2026-10-04):** pure module `electron/ipcValidation.ts` (zero
  electron deps, P2-T06 precedent) + `electron/ipcValidation.test.ts`; fail-first
  recorded as `TS2307: Cannot find module './ipcValidation'` with the module
  hidden. Wired thin in `electron/main.ts` only (CHESS_COMMANDS loop +
  `start_analysis` + both maia3-cache handlers; validate → throw so `invoke()`
  rejects, else forward byte-identically). Shape + presence + primitive sanity
  only; extra keys ignored; no FEN/UCI semantics (backend owns chess truth).
  Renderer, preload, and backend untouched; every renderer caller already
  catches, so the new throw cannot become an unhandled rejection. Full gate
  green (see commit body).

### P3-T04 — Record the ownership change in the docs ✅ DONE

- **Files:** `docs/BACKEND_API.md` (new `resign`/`draw`/`clock` commands, updated request
  shapes), `docs/ARCHITECTURE.md` (new "Game state ownership" section; the ASCII diagram at
  lines 1-42 needs a clock/termination path), `CONTRIBUTING.md` (the shared-mention rule is
  already stated at `:89` — keep it).
- **Done when:** every handler in `service.py` is documented, and an audit shows no
  drift.

### P3-T05 — Narrow the hot-path store subscriptions ✅ DONE

`PlayView.tsx:55`, `Board.tsx:74` and `App.tsx:22` subscribe to the **entire** store.
Stockfish streams update it many times per second, re-rendering the whole board subtree —
the React analogue of heavy per-frame work.

- **Change:** select only the fields each component reads, via `useGameStore(selector)`.
- **Done when:** a board re-render no longer occurs on every analysis push.

### P3-T06 — Delete the superseded stack ✅ DONE

Per the decision to keep unfinished work but remove what `BotManager` replaced. **~390
lines**, plus their tests.

Delete:

- `aether_chess/engines/controller.py` (110) — `EngineController`, replaced by
  `BotManager` + `ChessEngineManager`
- `aether_chess/engines/uci_engine.py` (76) — replaced by `bots/stockfish_bot.py`. Its
  _discovery_ half survives in the live `engines/registry.py`
- `aether_chess/models/settings.py` (80) — replaced by renderer `AppSettings`; its
  `GameMode` is one of the five duplicate settings definitions
- `aether_chess/models/__init__.py:2` (its re-export of the above)
- `backend/chess_engine.py:435-462` (`get_maia3_move`) and `:466-561` (`get_mentor_move`)
  — **zero callers** repo-wide; superseded by `get_bot_move`
- IPC commands `getBotMove` (`preload.ts:29-35`) and `calculateAccuracy` (`:45-46`), plus
  their `electron.d.ts` declarations (`:82-91`, `:97`) — **zero renderer callers**

Must also change:

- `aether_chess/engines/__init__.py` — it re-exports `EngineController` and
  `UCIEngineManager`, so **every** `import aether_chess.engines.X` pulls in the dead
  stack. Slim it to the live modules.
- `build/backend.spec:37,41,47` — remove the matching `hiddenimports` entries
- `tests/test_settings_and_controller.py` (47) — entirely about deleted code; delete
- `tests/test_mentor_profile.py:113` — imports `EngineController`; rewrite that block
- `CONTRIBUTING.md` and `docs/ARCHITECTURE.md` if either references the deleted names

> **Expected side effect:** the reported test count drops by roughly 200 lines. That is the
> dead tests leaving, not a regression — say so explicitly in the PR body, or a reviewer
> will read it as breakage.

- **Done when:** `rg -n "EngineController|UCIEngineManager|GameSettings|get_mentor_move|get_maia3_move|getBotMove|calculateAccuracy" backend/ aether_chess/ electron/ renderer/ tests/` returns only intentional hits.

### P3-T07 — Document the retained dead code ✅ DONE

Kept deliberately, with blockers recorded:

- `aether_chess/io/tablebases.py` → Phase 4, P4-T01
- `aether_chess/analysis/reporting.py` → Phase 4, P4-T02
- `cpp_engine/` → Phase 4, P4-T03
- `aether_chess/analysis/metrics.py::estimate_bayesian_elo` → Phase 4, P4-T04

- **Change:** add a "Planned, not wired" section to `docs/ARCHITECTURE.md` listing each
  module, what it does, what would connect it, and its blocker. Cross-reference from
  `TODO.md`. Add a one-line note in `aether_chess/engines/__init__.py` explaining that
  `registry.py` **is** live.

### P3-T08 — Enable numba compile caching for the test suite ✅ DONE

> Verification (2026-10-05): audit premise anchor-drifted — `_eval_numba`
> (:553) already carried `cache=True` (since pre-remediation `5fbd9a5`), so
> only `_bitscan` (:509) and `_popcount` (:544) gained the flag (decorator
> lines only, compiled logic bit-identical). `_popcount` captures global
> `np.uint64`; cache-compatibility proven empirically (its own artifact
> family appears, results identical). `NUMBA_CACHE_DIR` set as backend-job
> env in `ci.yml` (`${{ runner.temp }}/numba-cache`, no actions/cache step
> — the file uses only action-native `cache:` options); one local-dev line
> in `CONTRIBUTING.md`. No `.gitignore` change: unset `NUMBA_CACHE_DIR`
> falls back to the user cache dir (outside the repo), verified by clean
> `git status` after all runs. Measurement (`NUMBA_CACHE_DIR` cleared via
> `rm -rf` then reused): cold 191 OK / 664.78s wall vs warm 191 OK /
> 504.25s wall (~160s saved, zero result changes). New
> `tests/test_numba_cache.py` (2 tests): fail-first recorded (empty
> artifact globs for the two uncached sites), green after.

From the test-suite audit (no cuts approved — the suite is correctly sized):
every `unittest discover` process pays the numba JIT cold-compile of the three
`@njit` sites in `mentor_engine.py` (`:509,544,553`, no `cache=True`, no
`NUMBA_CACHE_DIR` anywhere). Only structural speedup that keeps every assertion.

- **Change:** `cache=True` on the three `@njit` decorators + `NUMBA_CACHE_DIR`
  set in CI (`ci.yml`) and documented for local dev (`CONTRIBUTING.md` one line).
- **Test:** cold run populates the cache dir; warm run is faster with byte-identical
  test results (record both wall times; assert cache artifacts exist, not timing).
- **Done when:** python suite measurably faster with zero result changes. Estimate
  20–40s per run; if measurement disproves the saving, record and close anyway.

### P3-T09 — Renderer never calls settings_defaults ✅ DONE

Gap from P3-T02 (found in P3-T04 verification): the backend serves
`settings_defaults` (`service.py:385-392, :639`) but zero renderer callers
exist — boot always uses the mirrored fallback constants, so P3-T02 Change 2
("DEFAULTS comes from the backend at boot") is half-done.

- **Change:** preload + `settingsStore.loadFromBackend`: fetch
  `settings_defaults` when the backend is reachable (with/before load), apply
  defaults + caps, fall back silently otherwise (existing behavior preserved).
  Fixture answers with canned defaults + caps (fixture touch, recorded) unless
  the fallback provably covers e2e boot — pick by reading.
- **Test:** extend `settingsStore.test.ts` — reachable backend → caps from the
  command; unreachable → fallback constants; junk still clamped.
- **Done when:** boot uses backend caps when available; exactly one caller.

> Verification (2026-10-05): preload `getSettingsDefaults` + main.ts
> `CHESS_COMMANDS` entry (paramless — the default validator branch passes
> it through, so no `ipcValidation` rule per the P3-T03 boundary rule) + d.ts
> declaration + store `loadFromBackend` applies backend `defaults` UNDER saved
> values through the same `validatePatch` (no validation-logic change, no
> schema change, no backend change). Test-first in `settingsStore.test.ts`:
> pre-fix 2 FAIL (distinctive backend defaults ignored — threads 1 vs 2;
> junk backend caps left engine fields static) / 6 pass; post-fix 8/8. Drift
> note: the caps half already applied in the jsdom mock env via the
> speculative optional read — the production fail mode (caps always
> fallback) held because preload had no such method, so the read was always
> undefined outside tests. Fallback proven load-bearing: unreachable-throws +
> missing-electronAPI tests resolve with `loaded:true`, and all 4 e2e specs
> stay green while the fixture answers `settings_defaults` with an error —
> NO fixture touch (fallback provably covers boot). Exactly one production
> caller (`settingsStore.ts`). Full gate green (counts/times in commit body).

---

# Phase 4 — Unfinished features and loose ends

### P4-T01 — Syzygy tablebases ✅ DONE

**Confirmed defects in `aether_chess/io/tablebases.py` (37 lines), which has no production
caller.** `best_move` uses only one method of the tablebase API, so the whole thing is
testable with a stub — no data files required.

1. **The sign test is inverted.** python-chess documents: _"Returns a positive value if
   the side to move is winning, `0` if the position is a draw, and a negative value if the
   side to move is losing."_ `best_move` probes **after** `board.push(move)` (`:26`), so the
   side to move is the **opponent** — meaning the mover always wants the most negative DTZ.
   The code instead branches on `side_to_move == WHITE` (`:31-33`) and flips the
   comparison for Black, so **every Black-to-move position selects the wrong move.**
   `side_to_move` is not needed at all.
2. **`None` is in the documented return type.** `get_dtz` returns `None` instead of
   raising and `probe_dtz` is `Optional[int]`. `:31`/`:33` compare a possibly-`None` `dtz`
   against an `int` `best_dtz` → `TypeError: '<' not supported between instances of
'NoneType' and 'int'`. The `best_dtz is None` initialiser at `:28` masks this only on
   the first iteration.
3. **Minmaxing raw DTZ is a documented anti-pattern.** python-chess: _"Minmaxing the
   DTZ50'' values guarantees winning a won position (and drawing a drawn position),
   because it makes progress keeping the win in hand. However, the lines are not always
   the most straightforward ways to win. Engines like Stockfish calculate themselves,
   checking with DTZ, but only play according to DTZ if they can not manage on their own."_
   Prefer a forced mate, then WDL, then DTZ as a tiebreak — and comment why.

- **Change 1:** inject the opener. Give `TablebaseProbe` an `opener` field defaulting to
  `chess.syzygy.open_tablebase`, rather than monkeypatching the module.
- **Change 2:** rewrite the selection: use `probe_wdl` to detect a win, `board.is_checkmate`
  for mate-in-1, and only then minmax DTZ **in the correct direction regardless of colour**.
- **Change 3:** skip `None` dtz values instead of comparing them.
- **Change 4:** wire a `tablebasePath` setting and a `probe_tablebase` command; use it to
  annotate endgames in the UI. Ship as **detect-and-report** when no path is configured.
- **Test:** `tests/test_tablebases.py` with a stub tablebase — a ~10-line fake implementing
  `probe_dtz` / `probe_wdl` and the context-manager protocol, driven by a FEN → value map.
  Cover: fastest-win selected; correct choice for **both** colours (this is the inverted-sign
  regression); `None` dtz handled without `TypeError`; `> 6` pieces returns `None`;
  `MissingTableError` / `OSError` / `FileNotFoundError` return `None`; no path configured
  returns `None`.
- **Opt-in integration test:** gated on `AETHER_TABLEBASE_PATH`, using the known-value
  fixture from the python-chess docs —
  `8/2K5/4B3/3N4/8/8/4k3/8 b - - 0 1` → `probe_dtz == -53`, `probe_wdl == -2`. Skipped when
  the env var is absent. **Never in required CI.**
- **Data policy:** the smallest useful Syzygy set (3-4-5 WDL+DTZ) is ~1 GB, and the
  generator needs 16 GB RAM for 6-piece. No tablebase data enters the repository. Document
  the download and expected layout in `docs/SETUP.md`.

### P4-T02 — PDF game reports ✅ DONE

`aether_chess/analysis/reporting.py` (54) defines `ReportData` and `generate_pdf_report`
via fpdf2. `requirements.txt:15` has `fpdf2` **commented out**, so the module can never
load in production.

- **Change 1:** uncomment `fpdf2` in `requirements.txt`.
- **Change 2:** add an `export_pdf_report` command and a "Export PDF" action in the
  analysis view.
- **Change 3:** source `key_moments` from the largest `cp_loss` entries in the accuracy rows
  already computed by `backend/analysis.py`.
- **Test:** `tests/test_reporting.py` — generate a report from a known game, assert the file
  exists, is non-empty and is a valid PDF, and that a missing font or unwritable path raises
  a clear error.
- **Done when:** the module imports in CI.
- **Verification (2026-10-06):** MAKE (54 lines of fpdf2-core-font code,
  clean lazy-import/RuntimeError path; premise confirmed, nothing
  contradicted). Test-first `tests/test_reporting.py` (8 tests): pre-fix
  FAIL recorded (`ImportError: cannot import name 'key_moments_from_rows'`;
  probe: `FPDF is None` → `RuntimeError: fpdf2 is required for PDF
reporting`). Post-fix 8/8 green: known Scholar's-mate game → `%PDF-1.3`
  magic, 1545 bytes, `%%EOF` trailer (no pypdf in venv, so header + size +
  trailer is the validity proof); unwritable path → `OSError` naming the
  path; `FPDF=None` patch → `RuntimeError`. Two minimal repairs, both
  recorded: (1) `cell(ln=1)` → `new_x/new_y` (pyright `Literal['DEPRECATED']`
  error under fpdf2 2.8.9 stubs); (2) every `multi_cell` gains
  `new_x=LMARGIN/new_y=NEXT` — the module as-shipped raised `FPDFException:
Not enough horizontal space` on the SECOND paragraph (dead code, never
  executed; default `new_x=RIGHT` left x at the page edge). Uncovered in the
  same pass: `_IMPORT_ERROR` unbound when the import succeeds (NameError on
  the RuntimeError path) — now always defined. `key_moments` = top-5
  `cp_loss` rows (`KEY_MOMENTS_TOP_N = 5`), SAN replayed from each row's own
  fen+uci, e.g. `Ply 6 Nf6 (black, Blunder, cp loss 520.0)`. Backend
  `export_pdf_report` mirrors `calculate_accuracy_from_pgn` (`pgn?` else
  live-history snapshot under `_board_lock`) and returns `{path,
key_moments}`; main `export-pdf-report` handler injects a history-dir
  destination (mirrors `save-game-history`) and the renderer reveals it via
  the EXISTING `reveal-in-folder` IPC — no new shell surface; long-running
  tier (5 min); `ipcValidation` rule + hiddenimport added. UI: `Export PDF`
  button in `AnalysisPanel` (props drilled like `onComputeAccuracy`,
  loading/error states like siblings). fpdf2 2.8.9 installed in venv;
  requirements pin uncommented (CI installs it → module imports in CI).
  Missing-font N/A: module uses core fonts only (no font file ever loaded);
  ASCII-only test data (core fonts are latin-1). Full gate green — python
  214 OK / 203.5s (2 skips: opt-in tablebase + pre-existing), ruff clean,
  pyright 0, electron 78 pass, lint 0 errors (3 warnings proven
  pre-existing via HEAD worktree), build succeeds, typecheck:renderer
  clean, test:renderer 38/38 (one AnalysisView timing flake, green solo +
  green full rerun), test:e2e 3/4 + listener-leak PASS with
  `--timeout=120000` (1.3m vs 60s budget under load ~16; HEAD equally
  marginal at 1.0m under load 14.8 — environmental, per ledger flake
  watch). Surprises: stray `=2.8` file from the pip-install shell line
  (deleted); the file-edit tool reformatted 3 TS files (whole-file
  prettier churn that broke the `set-state-in-effect` disable) — reverted
  and re-applied surgically, diffs now additive-only.

### P4-T03 — C++ evaluation engine (speed)

Requested as an experimental speed-up. **The toolchain is available** — gcc 16.2.1, g++,
make, cmake, and `/usr/include/python3.14/Python.h`, all verified present.
`cpp_engine/setup.py` already has the non-Windows branch
(`-O3 -std=c++17 -march=native`), so `python setup.py build_ext --inplace` should work
today. **`TODO.md` item 3 is stale** — it was written when MSVC was the only option and
disk was tight. Update it.

The extension is a real 234-line evaluator exporting `evaluate(fen) -> int` and
`evaluate_batch(fen_list) -> [int]` (`cpp_engine/pymodule.c:38-43`).

**Risk assessment, already partly verified.** `evaluate_fen` is
`if (!board.parse_fen(fen)) return 0;` (`cpp_engine/evaluate.cpp`), and there are **zero**
`assert` / `abort` / `exit` calls in the C++ or the wrapper. So there is **no segfault
risk** — which matters more than it might seem, because a native fault in the backend
cannot be caught by Python and would kill the whole process. The real defect is quieter:

> **`0` is indistinguishable from a genuinely dead-even position.** A malformed FEN
> silently reports "equal", so a caller cannot tell a bad input from a balanced position,
> and an evaluation bug becomes invisible.

- **Change 1:** make parse failure explicit. Preferred: have the Python wrapper validate
  with `chess.Board(fen)` before calling into C++ — free, since the caller already has
  python-chess — and raise on failure. Alternative: add a sentinel or a
  `bool evaluate_fen_checked(const char*, int*)` in C++.
- **Change 2:** add a build step. `npm run build:cpp` invoking
  `python cpp_engine/setup.py build_ext --inplace`. In CI, add it to the Linux runner
  (gcc is preinstalled on `ubuntu-latest`); Windows needs an `ilammy/msvc-dev-cmd` step.
- **Change 3:** wire `cpp_engine.evaluate_fen` behind an explicit setting flag, defaulting
  **off**, in the mentor evaluation path. Refactor the loader so the dispatch is
  injectable rather than a module-level import.
- **Change 4:** decide packaging — `build-backend.sh` must include the built extension, and
  `build/backend.spec` needs a `binaries` entry.
- **Test — three tiers, because the toolchain is only needed for the third:**

  | Tier            | Toolchain | Covers                                                                                                                                  |
  | --------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
  | Fallback        | No        | `evaluate_fen` / `evaluate_batch` / `get_info` in pure Python — **what runs in production today**, since nothing imports `cpp_engine`   |
  | Dispatch        | No        | `_try_import_cpp` success and failure → the `get_info()` string and the fallback branch. Inject a fake loader; do not load a real `.so` |
  | Compiled kernel | **Yes**   | `evaluate.cpp`'s actual math. `@unittest.skipUnless(cpp_engine._has_cpp)`                                                               |

  For the kernel, exact equality with `MentorEngine` is the wrong contract — they are
  different evaluations. Assert instead: **determinism** (same FEN twice → same int);
  **colour antisymmetry** (`evaluate(fen) == -evaluate(mirrored_fen)`); **material sanity**
  (an extra queen is worth roughly a queen); **mate = mate score**; **stalemate ≈ 0**;
  **batch equals elementwise single**; and **malformed FEN is rejected, not silently 0**
  (P4-T03 change 1). Then **benchmark** it against the Python path and report the actual
  speedup — if there is none, the feature should not ship enabled.

- **Done when:** the flag exists, the benchmark is recorded, and `TODO.md` item 3 reflects
  reality.
- **Status 2026-10-06: PARTIAL (Tier-3-blocked), not DONE — do not mark ✅ until the kernel builds.** Shipped: Tier 0 half (register §2c shim landed; `evaluate.cpp` compiles warning-free under `gcc -Wall -Wextra`) but the build still fails at `pymodule.c` (compiled as C, includes C++ `<cstdint>` — a second defect beyond the shim; STOP rule applied, no further C++ wrangling); Tiers 1-2 green (`tests/test_cpp_fallback.py` 7 tests, `tests/test_cpp_dispatch.py` 6 tests); Change 1 (wrapper validates via `chess.Board` + both-kings rule on ALL entry points — also caught the same silent-score hole in the Python fallback for kingless FEN); Change 3 (`mentor_use_cpp` default off in `ChessEngineManager.settings` + `settings_schema.engine_defaults` with strict-bool validation, injectable `_cpp_evaluate` dispatch, lazy import only); Change 2+4 (`npm run build:cpp`, HERE-anchored `setup.py`, `backend.spec` `_cpp_binaries` glob + `cpp_engine` hiddenimport, best-effort kernel step in `build-backend.sh`, `.gitignore` kernel artifacts); `TODO.md` item 3 rewritten to reality. NOT shipped: Tier 3 kernel tests (no kernel to test — file deliberately not added; `@unittest.skipUnless` tests would only skip), benchmark (nothing to time — flag stays off per the item's own exit clause), CI Linux gcc step (would fail CI while Tier 0 is red — deferred, documented here). Unblock path: build the wrapper TU as C++ (rename `pymodule.c` → `.cpp`, update `setup.py` + `build_msvc.bat`), then add Tier 3 tests + benchmark + CI step in a follow-up.

### P4-T04 — `estimate_bayesian_elo`

The README advertises Bayesian Elo, but only `tests/test_metrics.py:27-28` calls it.
Production uses `backend/analysis.py`. Note `accuracy_from_losses` and `classify_move` in
the same module **are** live (imported at `analysis.py:20-23`) — only this one function is
orphaned.

- **Change:** either wire it into the Elo panel as the primary estimator with a documented
  comparison against the Glicko figure, or remove the README claim. Pick one; do not ship
  an unbacked marketing claim.

### P4-T05 — Opening book loose ends

- `aether_chess/io/opening_book.py::choose_weighted` (`:85`) is unused. Meanwhile
  `backend/chess_engine.py:494` **does** use this module — the file is live, only the
  method is orphaned.
- Separately: `get_book_moves` (`chess_engine.py:718-746`) never receives `books_dir`, so
  it falls back to the **relative** `"resources/books"` (`:719`) globbed against the Python
  process CWD. The SettingsPanel books-directory picker (`SettingsPanel.tsx:650`) is a
  live-looking control that does nothing. Wire `openingBookPath` through, or remove the
  picker.
- Book readers reopen the file per lookup. Open once and cache, keyed on mtime.

---

# Appendix A — Unused-code inventory and disposition

| Module                                                    | Lines   | Disposition                              |
| --------------------------------------------------------- | ------- | ---------------------------------------- |
| `aether_chess/engines/controller.py`                      | 110     | **Delete** — P3-T06                      |
| `aether_chess/engines/uci_engine.py`                      | 76      | **Delete** — P3-T06 (also closes P2-T20) |
| `aether_chess/models/settings.py`                         | 80      | **Delete** — P3-T06                      |
| `backend/chess_engine.py:435-561`                         | ~130    | **Delete** — P3-T06                      |
| IPC `getBotMove`, `calculateAccuracy`                     | —       | **Delete** — P3-T06                      |
| `aether_chess/io/tablebases.py`                           | 37      | **Implement** — P4-T01                   |
| `aether_chess/analysis/reporting.py`                      | 54      | **Implement** — P4-T02                   |
| `cpp_engine/`                                             | 6 files | **Implement** — P4-T03                   |
| `aether_chess/analysis/metrics.py::estimate_bayesian_elo` | —       | **Decide** — P4-T04                      |
| `aether_chess/io/opening_book.py::choose_weighted`        | —       | **Decide** — P4-T05                      |
| `test:e2e` script, no config                              | —       | **Resolved** — P0-T04                    |

**History, for context.** The deleted stack landed in the `2026-04-21` scaffold commit;
`backend/chess_engine.py` replaced it on `2026-04-22` (Electron migration); and
`bots/base.py` + `bots/manager.py` landed on `2026-09-28` — _"Add a normalized bot layer,
and remove the retired Pygame app"_ — which is what superseded `EngineController`.

## Appendix B — Items deliberately NOT actioned

| Claim                                                                             | Why not                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Remove the clock until it is enforced"                                           | Superseded by P3-T01, which enforces it properly                                                                                                                                       |
| "Elo estimation should be replaced with a simple mapping"                         | Superseded by P4-T04; proper Glicko-2 calibration was chosen                                                                                                                           |
| `mentor_engine.py:1088-1093` phase blend is inverted                              | **False positive** — verified correct. `phase = 256 - total_pieces*16` yields 0 in the opening, and `mg*(256-phase) + eg*phase` weights middlegame → endgame properly. Do not "fix" it |
| `board.legal_moves.count()` is invalid                                            | **False positive** — valid in python-chess 1.11.2                                                                                                                                      |
| `AnalysisView` calling `removeAnalysisListeners` on unmount breaks the other view | **False positive** — `App.renderView()` mounts exactly one view at a time                                                                                                              |
| `uci_engine.py` assigns `self.engine` before `configure()`                        | **False positive** — already correct; only the process leak remains, and the file is deleted                                                                                           |
| No `dangerouslySetInnerHTML` / `innerHTML` in the renderer                        | **Verified clean** — no XSS sink exists                                                                                                                                                |
| Polyglot `.bin` parsing is an unchecked-`struct.unpack` hazard                    | **False positive** — `chess.polyglot` validates offsets                                                                                                                                |
| `contextIsolation` / `nodeIntegration` / `sandbox` flags                          | **Verified correct**                                                                                                                                                                   |

## Appendix C — New files created by this plan

| Path                                                | Item           |
| --------------------------------------------------- | -------------- |
| `vitest.config.ts`, `vitest.setup.ts`               | P0-T02, P0-T03 |
| `playwright.config.ts`                              | P0-T08         |
| `tsconfig.e2e.json`                                 | P0-T06         |
| `e2e/smoke.spec.ts`, `e2e/fixtures/fake-backend.py` | P0-T12         |
| `renderer/src/views/PlayView.test.tsx`              | P1-T01, P2-T01 |
| `renderer/src/stores/settingsStore.test.ts`         | P3-T02         |
| `backend/settings_schema.py`                        | P3-T02         |
| `tests/test_service_io.py`                          | P1-T02         |
| `tests/test_service_concurrency.py`                 | P1-T04         |
| `tests/test_chess_engine_navigation.py`             | P1-T03         |
| `tests/test_chess_engine_clock.py`                  | P3-T01         |
| `tests/test_settings_schema.py`                     | P3-T02         |
| `tests/test_tablebases.py`                          | P4-T01         |
| `tests/test_reporting.py`                           | P4-T02         |
| `cpp_engine` build test                             | P4-T03         |
