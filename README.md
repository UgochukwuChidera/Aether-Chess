# Aether Chess

Aether Chess is a standalone Python chess application scaffold with a modern Pygame UI, python-chess backend, and modular architecture designed for advanced engine/analysis expansion.

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
