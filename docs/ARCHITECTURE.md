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
changes *how* the move is chosen, not *how long* it was allowed to think.
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
  "pvs": [ { "depth": 20, "score_cp": 42, "mate": null, "pv": ["e2e4"], "pv_san": ["e4"] } ],
  "fen": "<FEN string>"
}
```

---

## Renderer ↔ Main IPC

The renderer communicates exclusively through the `contextBridge` API defined in `electron/preload.ts`:

```ts
window.electronAPI.makeMove({ move: 'e2e4' })
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

## Planned, not wired

Four modules ship in the tree but have no production caller. They are kept
deliberately — each has a Phase 4 owner — so this section records what each one
does, what would connect it, and what blocks it. Contrast
`aether_chess/engines/registry.py`: Stockfish discovery **is** live, reached via
`backend/analysis.py:24` (`resolve_engine_path`, used at `:155`) and
`aether_chess/bots/stockfish_bot.py:28` (used at `:68`) plus `:173`
(`discover_engines`, used at `:177`), flowing through `BotManager`
(`aether_chess/bots/manager.py:31,79`) into `ChessEngineManager`
(`backend/chess_engine.py:51,679-686`) and the service. Neither
`backend/service.py` nor `backend/chess_engine.py` imports the registry
directly — the reach is transitive, not a package re-export
(`aether_chess/engines/__init__.py` only re-exports the mentor engine).

- **Syzygy tablebases** — `aether_chess/io/tablebases.py` (37 lines).
  `TablebaseProbe` (`:11`) carries an optional Syzygy `path` (`:12`); `best_move`
  (`:14`) opens the tablebase (`:18`), declines positions with more than 6 pieces
  (`:19`), probes DTZ after each legal move (`:26`), and maps missing-table / OS
  errors to `None` (`:36`). Connecting it means a `tablebasePath` setting plus a
  `probe_tablebase` command annotating endgames in the UI (detect-and-report while
  unconfigured). Blocker: **P4-T01**, which also owns three selection-logic
  defects in this file (inverted sign branches `:31-33`, `None` DTZ compared
  against `int`, raw-DTZ minmax). No tablebase data ships in the repo.
- **PDF game reports** — `aether_chess/analysis/reporting.py` (54 lines).
  `ReportData` (`:15-25`) plus `generate_pdf_report` (`:28`), built on fpdf2's
  `FPDF` (`:8`) with an explicit `RuntimeError` when the import is absent
  (`:29-30`). Connecting it means uncommenting `fpdf2` in `requirements.txt:15`
  (currently `# fpdf2>=2.8`), adding an `export_pdf_report` command with an
  Export-PDF action, and sourcing `key_moments` from the `cp_loss` rows
  `backend/analysis.py` already computes. Blocker: **P4-T02**.
- **C++ evaluation engine** — `cpp_engine/` (7 files: `build_msvc.bat`,
  `evaluate.cpp`, `evaluate.h`, `__init__.py`, `pymodule.c`, `search.h`,
  `setup.py`). The native kernel exposes `evaluate(fen)` / `evaluate_batch`
  (`pymodule.c:39-41`, kernel entry `evaluate.cpp:230`); the Python loader
  (`cpp_engine/__init__.py:19-48`) tries the compiled module and falls back to
  `MentorEngine` (`:58-66`), reporting which branch is active via `get_info()`
  (`:53`). Nothing outside `cpp_engine/` imports it. Connecting it means a
  `build:cpp` step, CI coverage on the Linux runner, a default-off setting flag
  in the mentor path, packaging entries, and a benchmark proving the speedup.
  Blocker: **P4-T03**, hard-gated on the register §2c portability shim
  (`evaluate.h:23` `__popcnt64` and `:27` `_BitScanForward64` are MSVC-only and
  unguarded — zero `_MSC_VER` / `__builtin_` hits in the directory). See also
  TODO item 3.
- **`estimate_bayesian_elo`** — `aether_chess/analysis/metrics.py:46-81`,
  returning `BayesianEloResult` (`:40-43`). Its siblings `classify_move` (`:16`)
  and `accuracy_from_losses` (`:30`) are live (`backend/analysis.py:21-22`, used
  at `:196,207-208`); only this estimator is orphaned — the sole caller is
  `tests/test_metrics.py:27-28`, while the README still advertises "Bayesian Elo
  estimation ✅" (`README.md:87`). Connecting it means either wiring it into the
  Elo panel as the primary estimator with a documented Glicko comparison, or
  removing the README claim. Blocker: **P4-T04** (decision pending).

Cross-reference: `TODO.md` (trailing block) maps each module above to its Phase 4
owner. Phase 4 items live in `docs/REMEDIATION_PLAN.md` (Phase 4) and
`docs/VERIFICATION_REGISTER.md` §2c (the P4-T03 precondition).

---

## Security Model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Renderer has **no** direct Node.js or filesystem access
- All system calls go through `contextBridge` whitelisted methods
- Python backend validates all move inputs via `python-chess` before execution
- No eval(), no `shell: true` subprocess options
