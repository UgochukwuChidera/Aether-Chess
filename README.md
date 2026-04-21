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

- `M`: cycle game mode (`human_vs_ai`, `human_vs_human`, `ai_vs_ai`)
- `E`: switch engine (`mentor` / `uci`)
- `S` / `A`: increase/decrease AI strength
- `O`: cycle opening strategy (`weighted`, `best`, `random`, `off`)
- `C`: toggle human side (white/black)
- `B`: toggle book selection mode (auto-rotate vs fixed)
- `N`: cycle active book (fixed mode)
- `P`: cycle common UCI engine path candidates
- `T` / `G`: increase/decrease UCI threads
- `Y` / `H`: increase/decrease UCI move time
- `R`: rotate board, `U`: undo

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
