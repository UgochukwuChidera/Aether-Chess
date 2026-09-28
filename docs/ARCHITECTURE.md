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
│  │                      │  │                      │  │
│  │  window.electronAPI  │  │  python-shell IPC    │  │
│  └──────────┬───────────┘  └──────────┬───────────┘  │
│             │ ipcRenderer.invoke       │              │
│             └─────────────────────────┘              │
│                                        │ stdin/stdout │
└────────────────────────────────────────┼─────────────┘
                                         │
                               ┌─────────▼──────────┐
                               │  Python Backend     │
                               │  (child process)    │
                               │                     │
                               │  service.py         │
                               │  chess_engine.py    │
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

---

## Security Model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Renderer has **no** direct Node.js or filesystem access
- All system calls go through `contextBridge` whitelisted methods
- Python backend validates all move inputs via `python-chess` before execution
- No eval(), no `shell: true` subprocess options
