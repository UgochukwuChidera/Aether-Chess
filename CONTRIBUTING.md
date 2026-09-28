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

- **Linter + formatter:** [Ruff](https://docs.astral.sh/ruff/) — `ruff check .` and `ruff format .`
  (There is no Black or Flake8 config in this repo; Ruff replaced both.)
- **Type checker:** [Pyright](https://microsoft.github.io/pyright/) — `pyright` (must report 0 errors)
- Both are dev-only and live in `requirements-dev.txt`, so packaged builds do not pull them in.
- Type annotations on all public functions (`from __future__ import annotations`).
- Each new backend command must be added to the `HANDLERS` dict in `service.py` and documented in `docs/BACKEND_API.md`.

---

## Adding a New Piece Theme

1. Create a directory under `renderer/src/assets/pieces/<theme-name>/`.
2. Add SVG files named by piece code: `wP.svg`, `wN.svg`, `wB.svg`, `wR.svg`, `wQ.svg`, `wK.svg`, `bP.svg`, etc.
3. In `renderer/src/components/Board.tsx`, extend the `PIECE_ICONS` map / rendering logic to load your SVGs when `settings.pieceSet === '<theme-name>'`.
4. Add the option to the `pieceSet` select in `SettingsPanel.tsx`.

---

## Adding a New Bot

Every engine in this app is a **bot** behind one interface, and a new bot needs
**no changes outside its own file** — no enum, no dispatcher branch, no
frontend edit.

1. Create `aether_chess/bots/my_bot.py` with a class implementing the `Bot`
   protocol from `aether_chess/bots/base.py`:
   - `capabilities` — a `BotCapabilities` record with your `bot_id`,
     `display_name`, `description`, and honest flags (`requires_binary`,
     `supports_eval`, `deterministic`, ...). These flags let callers degrade
     gracefully instead of crashing.
   - `is_available()` — whether it can play right now.
   - `play(request: MoveRequest) -> BotMove` — return a normalized move.
   - `close()` — release any subprocess or model.
2. Register it in `BotManager.register_default_bots()` in
   `aether_chess/bots/manager.py`. Add it to `DEFAULT_PRIORITY` too if it
   should be eligible for `auto` and for the fallback chain.
3. Build the result with `normalize_move(...)` from `base.py` rather than
   hand-rolling a dict, so units and types stay identical across bots.
4. Add the module to the `hiddenimports` list in `build/backend.spec` if it
   imports anything dynamically, or the packaged backend will miss it.
5. Add unit tests in `tests/`.

Once registered, the bot appears automatically in the UI — the Play engine
dropdown is populated from the `list_bots` command, not a hard-coded list.

### Rules that keep bots comparable

- **Do not resolve your own search budget.** The manager resolves think time
  once per move from the clock and think profile, and passes it to you in
  `request.time_limit_sec`. Re-deriving it per bot is exactly how bots end up
  silently advantaged over one another.
- **Do not add a new return shape.** Extend `BotMove` if you need a field.
- **Raise `BotUnavailableError`** when you cannot run. The manager will fall
  back; returning a fake move hides the problem.
- **Reuse existing mappings.** If your bot has a 1–10 strength scale, keep the
  mapping in one shared function (see `aether_chess/engines/mentor_profile.py`)
  rather than re-deriving it at each call site.

---

## Adding a New Stockfish Build

Stockfish needs no code at all. Drop the binary in `engines/` (or set
`Stockfish engine` in Settings → Engine) and it is discovered on the next
`list_bots`, appearing as its own id like `stockfish-19`. Pinning that id
selects that exact build.

`engines/` is gitignored — do not commit binaries. CI fails if any file other
than `engines/.gitkeep` is tracked there.

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

These mirror what CI actually runs, so a green local run means a green pipeline.

- [ ] `ruff check .` passes
- [ ] `pyright` reports 0 errors
- [ ] `venv/bin/python -m unittest discover -s tests -v` passes (via `venv/` — see `docs/SETUP.md` §3; bare `python` fails with `ModuleNotFoundError: No module named 'chess'` because dependencies live in `venv/`, an environment artefact, not a defect)
- [ ] `npm run lint` passes
- [ ] `npm run test:electron` passes
- [ ] `npm run build` succeeds
- [ ] New features documented in relevant `docs/` file
- [ ] New backend commands documented in `docs/BACKEND_API.md`
- [ ] Nothing under `engines/` committed except `.gitkeep`
- [ ] No secrets or API keys committed

---

## License

Aether Chess is released under the MIT License.
Stockfish is distributed under **GPLv3** — if you distribute a build containing Stockfish, you must also make the Stockfish source code available. See [stockfishchess.org](https://stockfishchess.org/) for details.
