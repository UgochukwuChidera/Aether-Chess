# Contributing to Aether Chess

Thank you for your interest in contributing!

---

## Development Setup

Follow [docs/SETUP.md](docs/SETUP.md) for full instructions.

Quick start:

```bash
npm install
pip install -r requirements.txt
npm run dev
```

---

## Code Standards

### Frontend (TypeScript / React)

- **Formatter:** Prettier — `npx prettier --write renderer/src/`
- **Linter:** ESLint — `npm run lint`
- Strict TypeScript (`strict: true`); no implicit `any`.
- React functional components with hooks only. No class components.
- State mutations go through Zustand store actions. No direct `setState` on shared state.
- Tailwind utility classes preferred over custom CSS. Use `globals.css` only for reusable primitives.

### Backend (Python)

- **Formatter:** Black — `black backend/ aether_chess/`
- **Linter:** Flake8 — `flake8 backend/ aether_chess/ --max-line-length 100`
- Type annotations on all public functions (`from __future__ import annotations`).
- Each new backend command must be added to the `HANDLERS` dict in `service.py` and documented in `docs/BACKEND_API.md`.

---

## Adding a New Piece Theme

1. Create a directory under `renderer/src/assets/pieces/<theme-name>/`.
2. Add SVG files named by piece code: `wP.svg`, `wN.svg`, `wB.svg`, `wR.svg`, `wQ.svg`, `wK.svg`, `bP.svg`, etc.
3. In `renderer/src/components/Board.tsx`, extend the `PIECE_ICONS` map / rendering logic to load your SVGs when `settings.pieceSet === '<theme-name>'`.
4. Add the option to the `pieceSet` select in `SettingsPanel.tsx`.

---

## Adding a New Engine Adapter

1. Create `aether_chess/engines/my_engine.py` implementing a `choose_move(board) -> chess.Move` interface.
2. Add a new value to `EngineType` enum in `aether_chess/models/settings.py`.
3. Update `EngineController.choose_move()` in `aether_chess/engines/controller.py`.
4. Update `backend/chess_engine.py` to call your adapter when `engine_type == 'my_engine'`.
5. Add unit tests in `tests/`.

---

## Commit Messages

Use conventional commits:

```
feat: add opening explorer query
fix: prevent crash on empty move history
docs: add Syzygy tablebase setup instructions
refactor: split Board component into sub-components
```

---

## Pull Request Checklist

- [ ] `npm run lint` passes
- [ ] `python -m unittest discover -s tests -v` passes
- [ ] New features documented in relevant `docs/` file
- [ ] New backend commands documented in `docs/BACKEND_API.md`
- [ ] No secrets or API keys committed

---

## License

Aether Chess is released under the MIT License.
Stockfish is distributed under **GPLv3** — if you distribute a build containing Stockfish, you must also make the Stockfish source code available. See [stockfishchess.org](https://stockfishchess.org/) for details.
