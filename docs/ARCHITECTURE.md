# Aether Chess — Architecture Overview

## Process Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Electron App                       │
│                                                      │
│  ┌──────────────────────┐  ┌─────────────────────┐  │
│  │  Renderer Process    │  │   Main Process       │  │
│  │  (Chromium sandbox)  │  │   (Node.js)          │  │
│  │                      │  │                      │  │
│  │  React + Zustand     │  │  IPC handlers        │  │
│  │  Tailwind CSS UI     │◄─┤  Window management   │  │
│  │  Board rendering     │  │  Settings I/O        │  │
│  │  Analysis display    │  │  File dialogs        │  │
│  │  Clock display       │  │  Game history + Elo  │  │
│  │                      │  │                      │  │
│  │  window.electronAPI  │  │  python-shell IPC    │  │
│  └──────────┬───────────┘  └──────────┬───────────┘  │
│             │ ipcRenderer.invoke       │              │
│             └─────────────────────────┘              │
│                                        │ stdin/stdout │
│                                        │ pushes ▲     │
└────────────────────────────────────────┼─────────────┘
                                         │
                               ┌─────────▼──────────┐
                               │  Python Backend     │
                               │  (child process)    │
                               │                     │
                               │  service.py         │
                               │  chess_engine.py    │
                               │  clock/termination  │
                               │  bots/ (manager +   │
                               │  stockfish, mentor, │
                               │  maia3 adapters)    │
                               │  analysis.py        │
                               │                     │
                               │  python-chess       │
                               │  Stockfish (UCI)    │
                               │  MentorEngine (PVS) |
                               └─────────────────────┘
```

---

## Game state ownership

The backend is the single authority over the game. Everything else mirrors.

**Backend owns board, clock, termination and result.** `ChessEngineManager`
(`backend/chess_engine.py`) holds the board, both clocks (milliseconds,
`time.monotonic` stamp) and the terminal latch (`result` + `termination`).
Only it can end a game: checkmate/stalemate via `python-chess`, flag-fall via
the debit-and-credit on `make_move` (plus the idle-flag check at the top of
every snapshot), resignation via `resign` (the `side` param names the loser),
or agreement via `draw`. Every game command returns a full state snapshot
carrying `clock`, `result` and `termination` (see
[BACKEND_API](BACKEND_API.md#state-snapshot)). There is no second owner: the
renderer never sets a result locally, and autosave keys off the backend's
`result`, so a game the backend considers unfinished is never written as
finished.

**Renderer mirrors via snapshots and pushes.** The Zustand `gameStore` applies
whatever the backend sends — `new_game` / `make_move` / `resign` / `draw`
results, and two id-less push channels: `analysis_update` (streamed PVs) and
`clock_tick`, a full snapshot forwarded at 1 Hz while a clock runs. The UI
renders `store.clock` directly; no client-side timer remains (the old
`setInterval` is gone — a renderer poll would need its own timer, which is
exactly what the push replaced). `nav_index: -1` means live; anything else is
a viewing window the backend refuses moves in.

**Main routes and owns the disk.** The main process forwards chess commands to
the backend (`CHESS_COMMANDS` loop plus dedicated `start_analysis` /
`stop_analysis` / maia3-cache handlers, validated at the `ipcMain.handle`
boundary) and broadcasts both push types to every live window — no per-window
clock subscription, since every window shows the same game. It also owns all
on-disk state the backend never touches: `userData/settings.json`
(`settings-load` / `settings-save`), the game-history directory (`index.json`
plus per-game PGN files), and the cached Elo estimates (`compute-and-cache-elo`).
Settings _values and limits_ are still the backend's domain
(`settings_defaults` command, canonical schema in
`backend/settings_schema.py`); main just persists the bytes.

```
push path (no id, backend → all windows):
  backend _state_snapshot ──► main stderrParser ──► clock-tick / analysis-update
  1 Hz while a clock runs; stops at Unlimited / import / terminal delivery
```

---

## The Bot Layer

Every engine is a **bot** behind one interface. Callers ask for a move by
`bot_id` and receive one normalized `BotMove`, without knowing whether it came
from a subprocess, from pure Python, or from a neural proxy.

```
                 MoveRequest (fen, strength, clock, think profile)
                                │
                          ┌─────▼──────┐
                          │ BotManager │  resolves search budget ONCE
                          │  registry  │  handles availability + fallback
                          └─────┬──────┘
        ┌───────────────┬───────┴───────┬──────────────────┐
        ▼               ▼               ▼                  ▼
  StockfishBot     MentorBot       Maia3Bot         (new bots register
  UCI subprocess   in-process      neural proxy       themselves, no
  SF + per-build   PVS + TT        sampled, Elo       other file changes)
  ids              + QSearch
        └───────────────┴───────┬───────┘
                                ▼
                    BotMove  (one shape, always)
                    normalize_move() coerces units + types
```

### Why the budget is resolved centrally

The manager computes think time once per move, from the clock and the think
profile, then hands the same value to whichever bot plays. This is what makes
two bots comparable: switching from Stockfish to Mentor for the same position
changes _how_ the move is chosen, not _how long_ it was allowed to think.
Leaving budget resolution to each bot is how bots end up silently advantaged
over one another.

### Discovery drives the UI

`list_bots` reports every registered bot with its capabilities and whether it is
available. The frontend renders that list, so a discovered Stockfish build or a
newly added bot appears without a frontend change. The `bot_id` is an open
string rather than a closed union for the same reason.

### Mentor strength lives in one place

Mentor's 1–10 slider maps to a `SearchConfig` in
`aether_chess/engines/mentor_profile.py`. The playing bot, the evaluation bar
and the engine controller all call it, so "Mentor at strength 7" means the same
search everywhere. The clock stays out of it: budget-constrained think time is
sampled by `think_profile` and arrives already resolved.

---

## IPC Protocol

All communication between the Electron main process and the Python backend uses **newline-delimited JSON over stdin/stdout**.

### Request format

```json
{
  "id": "<unique-string>",
  "command": "<command_name>",
  "params": { ... }
}
```

### Response format (success)

```json
{
  "id": "<same-id>",
  "result": { ... }
}
```

### Response format (error)

```json
{
  "id": "<same-id>",
  "error": "Human-readable error message"
}
```

### Push event (analysis streaming)

No `id` — pushed from Python to main at any time:

```json
{
  "type": "analysis_update",
  "callback_id": "<string>",
  "pvs": [
    {
      "depth": 20,
      "score_cp": 42,
      "mate": null,
      "pv": ["e2e4"],
      "pv_san": ["e4"]
    }
  ],
  "fen": "<FEN string>"
}
```

---

## Renderer ↔ Main IPC

The renderer communicates exclusively through the `contextBridge` API defined in `electron/preload.ts`:

```ts
window.electronAPI.makeMove({ move: "e2e4" });
// → ipcMain.handle('make_move', ...)
// → Python: {"command": "make_move", "params": {"move": "e2e4"}}
// ← Python: {"id": "...", "result": { "fen": "...", "turn": "black", ... }}
// → Promise resolves with result
```

All chess commands are forwarded directly to Python. The main process also handles:

- Window controls (minimize/maximize/close)
- Settings file I/O (`userData/settings.json`)
- File dialogs (Stockfish path picker)

---

## State Management (Renderer)

Two Zustand stores:

### `gameStore`

- Board FEN, turn, legal moves
- Move history (SAN + UCI)
- Selected square, highlights
- Analysis PV data
- UI state (pending promotion, toasts, engine busy)

### `settingsStore`

- All user preferences (appearance, engine config, gameplay)
- Persists to/from `userData/settings.json` via Electron IPC

## Shipped and wired (Phase 4)

The four modules P3-T07 parked in this section as unwired have all shipped
(P4-T01/P4-T02, P4-T03 closed by P4-T06) or been decided (P4-T04). Nothing
below is unwired; each entry records what shipped and where it connects.
Contrast `aether_chess/engines/registry.py`: Stockfish discovery **is** live,
reached via `backend/analysis.py:24` (`resolve_engine_path`, used at `:155`)
and `aether_chess/bots/stockfish_bot.py:28` (used at `:68`) plus `:173`
(`discover_engines`, used at `:177`), flowing through `BotManager`
(`aether_chess/bots/manager.py:31,79`) into `ChessEngineManager`
(`backend/chess_engine.py:51,679-686`) and the service. Neither
`backend/service.py` nor `backend/chess_engine.py` imports the registry
directly — the reach is transitive, not a package re-export
(`aether_chess/engines/__init__.py` only re-exports the mentor engine).

- **Syzygy tablebases — SHIPPED (P4-T01).** `aether_chess/io/tablebases.py`:
  `TablebaseProbe` carries an injectable `opener` (default
  `chess.syzygy.open_tablebase`) plus an optional Syzygy `path`; `best_move`
  declines positions with more than 6 pieces, prefers forced mate, then WDL,
  then DTZ as a tiebreak minmaxed in the correct direction regardless of
  colour, and maps missing-table / OS errors and `None` DTZ values to `None`
  (never a `TypeError`). Wired end to end: `tablebasePath` setting (renderer
  `settingsStore`, SettingsPanel picker), `probe_tablebase` command
  (`backend/service.py:handle_probe_tablebase` → `HANDLERS`, main
  `CHESS_COMMANDS` loop, preload `probeTablebase` + `electron.d.ts`,
  `ipcValidation` rule), and `TablebaseAnnotation` in
  `renderer/src/components/AnalysisPanel.tsx`. Detect-and-report while
  unconfigured (`{configured: false}` → quiet "not configured" note). No
  tablebase data ships in the repo (see `docs/SETUP.md` §5b for download and
  layout). Covered by `tests/test_tablebases.py` (stub tablebase for both
  colours, `None`-DTZ, >6-piece, missing-table paths; opt-in real-data test
  gated on `AETHER_TABLEBASE_PATH`, never in CI).
- **PDF game reports — SHIPPED (P4-T02).** `aether_chess/analysis/reporting.py`:
  `ReportData` plus `generate_pdf_report` on fpdf2 core fonts (no font file
  ever loaded), with `key_moments` sourced from the top-5 `cp_loss` entries of
  the accuracy rows `backend/analysis.py` already computes. Wired end to end:
  `fpdf2` uncommented in `requirements.txt` (imports in CI), `export_pdf_report`
  command (`backend/service.py:handle_export_pdf_report` → `HANDLERS`;
  `pgn?` else live-history snapshot under `_board_lock`, returns
  `{path, key_moments}`), main's dedicated `export-pdf-report` handler (injects
  a history-dir destination, renderer reveals via the existing
  `reveal-in-folder` IPC — no new shell surface; long-running tier),
  `ipcValidation` rule, `Export PDF` action in AnalysisView/AnalysisPanel, and
  the `build/backend.spec` hiddenimport. Covered by `tests/test_reporting.py`
  (valid-PDF header/size/trailer, unwritable-path `OSError`, missing-fpdf2
  `RuntimeError`).
- **C++ evaluation engine — SHIPPED, default-on (P4-T03 closed by P4-T06,
  enabled by P4-T11).** `cpp_engine/`: the wrapper builds as C++ (`pymodule.cpp`),
  `npm run build:cpp` emits the ABI-tagged `.so` beside `__init__.py`, and `get_info()`
  reports `C++ accelerated evaluation ACTIVE`. The Python loader
  (`cpp_engine/__init__.py`) tries the compiled module and falls back to
  `MentorEngine`, reporting which branch is active via `get_info()`; nothing
  outside `cpp_engine/` imports it except through the injectable
  `mentor_use_cpp` dispatch (default **on** in `ChessEngineManager.settings` +
  `settings_schema.engine_defaults`; explicit `False` restores pure Python).
  Tier 3 is green (`tests/test_cpp_kernel.py`, 11 tests: the P4-T06 7 plus
  P4-T11 exact mate/stalemate/insufficient-material parity and batch
  terminal parity). The wrapper passes terminals through before dispatching
  (checkmate → `-MATE_SCORE + ply`, stalemate/insufficient → 0, mirroring
  `MentorEngine.evaluate`), so kernel and fallback are bit-identical there;
  non-terminal statics remain different evaluations under the Tier-3
  property contract. Fresh P4-T11 benchmark: ~4x end-to-end on game-like
  positions (~296 µs/eval compiled vs ~1.2 ms/eval fallback, best-of
  interleaved warmed rounds; ~1.4x through `get_mentor_eval`), parity on
  pure-terminal sets. CI Linux gcc step builds the kernel and asserts
  `_has_cpp`, so Tier 3 runs in CI. The register §2c portability shim
  (`__builtin_popcountll` / `__builtin_ctzll`) is what unblocked the gcc build;
  see also struck `TODO.md` item 3.
- **`estimate_bayesian_elo` — DECISION: REMOVE the claim, keep the function
  (P4-T04).** The math in `aether_chess/analysis/metrics.py:46-81` is sound
  for its own contract (logistic gradient/Hessian, Newton step with Laplace
  variance, prior on empty input, ±60 exponent clamps), but its input contract
  (`List[float]` per-game scores vs one fixed opponent) cannot be honestly fed
  from the aggregate summaries the Elo panel supplies (`accuracy`,
  `blunder_rate`, `avg_cp_loss`) — bridging would invent per-game scores from
  aggregates, comparing two transforms of the same heuristic rather than an
  independent estimate. So per the item's forcing rule the README no longer
  advertises it: `README.md` reads "Glicko-2-based Elo estimation ✅" — the
  production path (`backend/analysis.py` GlickoRating, wired to both panel
  callers). The orphaned function and its `tests/test_metrics.py` coverage
  stay; no unbacked marketing remains. (This supersedes the stale P3-T07 clause
  that framed the README claim as still advertised with a wiring decision
  pending — that clause is replaced by this record, not kept alongside it.)

Cross-reference: `TODO.md` (trailing block) maps each module above to its Phase 4
owner; item 3 there is struck CLOSED by P4-T06. Phase 4 items live in
`docs/REMEDIATION_PLAN.md` (Phase 4) and `docs/VERIFICATION_REGISTER.md` §2c
(the P4-T03 precondition, now satisfied).

---

## Security Model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Renderer has **no** direct Node.js or filesystem access
- All system calls go through `contextBridge` whitelisted methods
- Python backend validates all move inputs via `python-chess` before execution
- No eval(), no `shell: true` subprocess options
