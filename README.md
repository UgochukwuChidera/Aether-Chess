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
| [CONTRIBUTING.md](CONTRIBUTING.md) | Coding standards, how to add themes/engines |

---

## Testing

```bash
# Python backend unit tests
python -m unittest discover -s tests -v
```

---

## License

MIT — see [LICENSE](LICENSE). Stockfish is GPLv3; see [stockfishchess.org](https://stockfishchess.org/).


## Implemented in this issue

- MVC-oriented package layout (`models`, `ui`, `engines`, `analysis`, `io`)
- Playable Pygame desktop app with:
  - Board rendering and move interaction
  - Cubic-easing piece animation hooks
  - Theme loading from JSON
  - Move list/HUD panel
  - Board rotation and undo hotkeys
  - Game modes: Human vs AI, Human vs Human, AI vs AI
  - AI side selection and in-app strength controls
  - Opening strategy controls (weighted/best/random/off)
- Mentor engine module with:
  - Iterative deepening
  - PVS-style search loop
  - Transposition table
  - Quiescence search
  - Null-move pruning
  - Late move reductions (LMR)
  - Futility pruning
  - Difficulty blending via weighted top-move sampling
- Stockfish/UCI integration module (configurable path, skill, multipv, threads)
- Opening book weighted move picker (`polyglot`)
- Syzygy tablebase probe helper (6-men guard)
- Analysis helpers:
  - Logistic centipawn→win% conversion
  - Accuracy and move classification
  - Bayesian Elo estimator with confidence interval
- PDF report generation with `fpdf2`
- PyInstaller spec and platform build scripts
- Focused unit tests for core logic modules

## Not yet fully implemented (remaining work)

- ONNX neural evaluator integration and model training pipeline
- Multi-threaded search scaling strategy (Lazy SMP/YBWC)
- Full Stockfish in-app version downloader/manager UI
- Complete CAPS/ACPL pipeline wired to fixed-depth Stockfish analysis
- Opening explorer database and master game browser
- Advanced variation editor UI (insert/delete/reorder full tree)
- Rich SFX asset pack, particle effects, and SVG piece rendering pipeline
- Accessibility features (screen-reader integration, high-contrast validation)
- Installer artifacts (NSIS/DMG packaging automation)

## Quick start

```bash
python -m pip install -r requirements.txt
python run.py
```

### Optional environment setup

- `AETHER_UCI_PATH`: path to UCI bot executable (default: `stockfish`)
- `AETHER_OPENING_BOOKS`: comma-separated polyglot `.bin` paths

### In-app controls

- Use the HUD **buttons** for game controls (mode, engine, strength, opening, side, books, threads, move time, path, rotate, undo, and exports).
- FEN / PGN / board image export are available directly from HUD buttons.
- The window is resizable and the layout adapts for wide and narrow (stacked) viewports.
- Keyboard shortcuts remain available for power users (`M/E/S/A/O/C/B/N/P/T/G/Y/H/R/U/F/J/I`).

## Tests

```bash
python -m unittest discover -s tests -v
```

## Build executable

Linux/macOS:

```bash
./scripts/build_linux.sh
```

Windows:

```bat
scripts\\build_windows.bat
```
