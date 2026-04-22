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
                               │  custom_bot.py      │
                               │  analysis.py        │
                               │                     │
                               │  python-chess       │
                               │  Stockfish (UCI)    │
                               │  MentorEngine (PVS) │
                               └─────────────────────┘
```

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
