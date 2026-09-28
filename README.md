# Aether Chess

A professional desktop chess application built with **Electron + React** (frontend) and **Python** (backend), featuring a polished dark UI, a custom mentor chess engine, Stockfish integration, and full post-game analysis.

---

## Architecture

```
Electron (renderer) ←── contextBridge IPC ──→ Electron (main) ←── stdio JSON-RPC ──→ Python backend
```

- **Frontend:** React 18 + TypeScript + Tailwind CSS + Zustand
- **Backend:** Python service exposing a JSON-RPC protocol over stdin/stdout
- **Chess logic:** python-chess, custom PVS mentor engine, Stockfish UCI
- **Bots:** Stockfish, Mentor and Maia3 behind one `Bot` interface and one
  normalized result shape, so no caller branches on which engine ran. The
  playable list comes from the backend (`list_bots`), not a hard-coded array.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full diagram and IPC protocol.

---

## Quick Start (Development)

```bash
# 1. Install Node dependencies
npm install

# 2. Install Python dependencies
pip install -r requirements.txt

# 3. Start development (Vite + Electron)
npm run dev
```

Full instructions: [docs/SETUP.md](docs/SETUP.md)

---

## Build & Distribution

```bash
# Build Python backend executable
bash build/build-backend.sh

# Build Electron app + package installer
npm run dist          # all platforms
npm run dist:win      # Windows NSIS
npm run dist:mac      # macOS DMG
npm run dist:linux    # Linux AppImage + deb
```

Full instructions: [docs/BUILD.md](docs/BUILD.md)

---

## Features

| Feature | Status |
|---------|--------|
| Dark futuristic UI (Aether design system) | ✅ |
| Frameless window with custom title bar | ✅ |
| 8×8 CSS Grid board with Material Symbols pieces | ✅ |
| Legal move highlights + selected square overlay | ✅ |
| Piece animation (CSS transitions) | ✅ |
| Board flip | ✅ |
| Evaluation bar (real-time) | ✅ |
| Player profile cards + timers | ✅ |
| Move history (SAN, two-column, clickable) | ✅ |
| Promotion dialog | ✅ |
| Game over modal | ✅ |
| Toast notifications | ✅ |
| Analysis tab (Stockfish PV lines, depth, score) | ✅ |
| Settings tab (appearance, engine, gameplay, data) | ✅ |
| Persistent settings (userData/settings.json) | ✅ |
| Centralized defaults (`resources/config/settings.defaults.json`) | ✅ |
| PGN export/import | ✅ |
| Opening book (Polyglot .bin, no database) | ✅ |
| Custom mentor bot (PVS + TT + QSearch) | ✅ |
| Stockfish integration (UCI) | ✅ |
| Per-Engine Stockfish builds (SF18, SF19, ...) selectable individually | ✅ |
| Maia3 neural bot (plays like a human of a chosen Elo) | ✅ |
| Unified bot interface + one normalized move result | ✅ |
| Dynamic engine picker driven by backend discovery | ✅ |
| Accuracy scoring (centipawn loss) | ✅ |
| Bayesian Elo estimation | ✅ |
| electron-builder packaging (Win/Mac/Linux) | ✅ |
| PyInstaller backend bundling | ✅ |

---

## Documentation

| Document | Contents |
|----------|----------|
| [docs/SETUP.md](docs/SETUP.md) | Developer setup, env vars, prerequisites |
| [docs/BUILD.md](docs/BUILD.md) | Production builds, code signing, CI |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process diagram, IPC protocol, state management |
| [docs/USER_MANUAL.md](docs/USER_MANUAL.md) | End-user guide, keyboard shortcuts |
| [docs/BACKEND_API.md](docs/BACKEND_API.md) | All JSON-RPC commands with examples |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Coding standards, how to add themes/bots, CI-equivalent checklist |

---

## Testing

The full gate matches what CI runs:

```bash
# Python
ruff check .                                  # lint
pyright                                       # types (must be 0 errors)
venv/bin/python -m unittest discover -s tests -v  # backend unit tests (via venv/; bare `python` misses deps — see docs/SETUP.md §7)

# Node
npm run lint                                  # ESLint
npm run test:electron                         # Stockfish discovery
npm run build                                 # renderer + Electron
```

---

## License

MIT — see [LICENSE](LICENSE). Stockfish is GPLv3; see [stockfishchess.org](https://stockfishchess.org/).
