# Aether Chess — Developer Setup Guide

## Prerequisites

| Tool    | Version    | Notes                                                       |
| ------- | ---------- | ----------------------------------------------------------- |
| Node.js | **20 LTS** | `.nvmrc` pins this; newer majors break the Electron install |
| npm     | 9+         | Included with Node.js                                       |
| Python  | 3.10+      | python.org or pyenv                                         |
| pip     | 23+        | `python -m pip install --upgrade pip`                       |

> **Use Node 20.** `npm install` fails on Node 22+ / 24+ with an
> `extract-zip` error while fetching the Electron binary:
>
> ```
> Error: end of central directory record signature not found
> ```
>
> This is a known incompatibility between newer Node and the `extract-zip`
> version Electron 28 depends on, not a corrupt download. Switch versions:
>
> ```bash
> nvm install && nvm use      # reads .nvmrc
> rm -rf node_modules package-lock.json && npm install
> ```
>
> Check with `node -v` (expect `v20.x`) before installing.

> **No database required.** All data (settings, PGN, opening books) is stored in flat files (JSON, PGN, Polyglot `.bin`).

---

## 1. Clone the repository

```bash
git clone https://github.com/UgochukwuChidera/Aether-Chess.git
cd Aether-Chess
```

---

## 2. Install Node dependencies

```bash
nvm use          # if you have nvm; otherwise install Node 20 LTS first
npm install
```

---

## 3. Install Python dependencies

A virtual environment is strongly recommended — several dependencies (numba,
onnxruntime) are compiled wheels and behave badly when installed system-wide.

```bash
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
pip install -r requirements-dev.txt   # ruff + pyright, dev only
```

`numba` is a **required** dependency: the mentor bot's evaluation kernel is
JIT-compiled with it, and `backend/chess_engine.py` imports it unconditionally,
so the backend will not start without it.

`requirements-dev.txt` holds the dev-only tooling (ruff, pyright) so packaged
builds do not pull it in via `requirements.txt`.

The editor type-checker is configured to read this environment via
`pyrightconfig.json`; no extra setup is needed once `venv/` exists.

---

## 4. Add a Stockfish binary (optional but recommended for full engine play)

The app finds Stockfish automatically — you do not have to set `PATH`. It looks,
in order, at:

1. an explicit path you choose in **Settings → Stockfish engine**
2. `stockfish` / `stockfish-NN` on your `PATH`
3. the app's `engines/` folder
4. your per-user engines folder (shown in **Settings → Stockfish folder → Open**)
5. a binary bundled with a packaged build

Every candidate is asked to identify itself over UCI, so several versions can be
installed at once and are listed individually in the dropdown. The engine's own
answer wins over the filename — release archives have shipped binaries whose
version tag disagrees with what they actually are.

A downloaded binary often arrives without its execute bit; the app repairs that
automatically. On Unix you can also do it yourself:

```bash
chmod +x ~/Downloads/stockfish
```

If nothing is found, **Settings → Stockfish status** says so explicitly, and a
failed scan is reported as an error rather than being mistaken for "no engine".

---

## 4b. Install Maia3 (optional)

Maia3 is the only bot that needs a Python package of its own. Its inference
code lives in the vendored `inspiration/` subproject, which is not installed by
`requirements.txt` because it pulls in PyTorch.

```bash
source venv/bin/activate
pip install -e ./inspiration
```

Then download a model from **Settings → Engine** in the app, or headless:

```bash
python -m maia3.cache --model maia3-5m      # 5M  — ~smallest, fastest
python -m maia3.cache --model maia3-23m     # 23M
python -m maia3.cache --model maia3-79m     # 79M — strongest
```

If you skip this, Maia3 still appears in the Play engine list marked
**(unavailable)** and the rest of the app is unaffected. Mentor and Stockfish
need nothing here.

> Download progress shows in the Settings → Engine panel while downloading
> (and is also printed to the terminal).

---

## 5. Add an opening book (optional)

Place any Polyglot `.bin` book file in `resources/books/`. Example:

```bash
cp ~/Perfect2023.bin resources/books/
```

If no book is present, the opening explorer will display:

> "No opening book loaded. Place a .bin file in the books directory."

---

## 5b. Add Syzygy endgame tablebases (optional, P4-T01)

Tablebases are **never** stored in the repository: the smallest useful
Syzygy set (3-4-5-piece WDL+DTZ) is ~1 GB, and generating 6-piece tables
needs ~16 GB RAM. Download them separately (e.g. from
https://syzygy-tables.info/ or a mirror) into a local folder with the
standard layout (`*.rtbw` + `*.rtbz` side by side, e.g.
`~/syzygy/3-4-5/KQvK.rtbw`), then point the app at it via
**Settings → Endgame Tablebases** (or pass the folder as
`tablebase_path` to the `probe_tablebase` command).

When no path is configured the backend answers `{"configured": false}`
and the Analysis view shows a quiet "Tablebase: not configured" note —
endgame hints stay off and everything else works. The opt-in integration
test (`tests/test_tablebases.py::RealTablebaseTests`, gated on
`AETHER_TABLEBASE_PATH`) uses the python-chess known-value fixture
`8/2K5/4B3/3N4/8/8/4k3/8 b - - 0 1` → `probe_dtz == -53`,
`probe_wdl == -2`; it never runs in required CI.

---

## 6. Run in development mode

The development server starts the Vite renderer and Electron concurrently:

```bash
npm run dev
```

This will:

1. Start the Vite dev server at `http://localhost:5173`
2. Compile the Electron main/preload TypeScript
3. Launch Electron, which spawns the Python backend from `backend/service.py`

---

## 7. Run the tests

```bash
npm test                 # everything below
npm run test:electron    # Stockfish discovery (Node, no Electron needed)
npm run test:python      # Python resolver + backend routing

# or the full Python suite directly (always via venv/ — see §3 above):
venv/bin/python -m unittest discover -s tests
```

Run the Python suite with `venv/bin/python`, not bare `python`: dependencies
live in `venv/`, so the bare command fails with 8× `ModuleNotFoundError: No
module named 'chess'` — an environment artefact, not a defect. The hermetic
e2e tier (`npm run test:e2e`) needs no third-party Python packages, but the
`python3` interpreter itself is still required — the fixture backend is
stdlib-only.

Neither suite needs a real Stockfish binary: each writes throwaway UCI stubs
that speak the real handshake. The one test that does use a real engine skips
itself automatically when none is installed, so the suite is safe to run on CI.

### Linting and type checking

The two halves of the codebase are linted separately, because they need
different toolchains:

```bash
npm run lint            # eslint, TypeScript/TSX (renderer/ + electron/)
npm run lint:python     # ruff, Python
npx pyright             # pyright, Python type check (uses venv/)
```

Ruff is the Python linter. It is configured by `ruff.toml`; `npm run lint` is
deliberately TypeScript-only so the Node-only CI job does not need a Python
toolchain. The two linters run in separate CI steps for the same reason.

`ruff.toml` excludes `notebooks/`. It also relaxes three rules where the
existing style is deliberate:

- `E701`/`E702` in `aether_chess/engines/mentor_engine.py`, whose bit-twiddling
  helpers and evaluation kernel are `@numba.njit` and are written compactly
  on purpose.
- `E402` in `backend/analysis.py` and `backend/chess_engine.py`, which extend
  `sys.path` and set `HF_HOME` before importing `aether_chess`.
- `E402` in `tests/`, which import the module under test after arranging
  `sys.path`.

To fix what ruff can fix automatically:

```bash
ruff check --fix .
```

---

## Environment Variables

| Variable   | Default       | Description                             |
| ---------- | ------------- | --------------------------------------- |
| `NODE_ENV` | `development` | Set to `production` for packaged builds |

---

## Troubleshooting

| Symptom                                                                                | Cause                             | Fix                                                                   |
| -------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| `extract-zip` / `end of central directory record signature not found` on `npm install` | Node newer than 20                | `nvm use`, then reinstall `node_modules`                              |
| `ModuleNotFoundError: numba`                                                           | Deps installed outside the venv   | `source venv/bin/activate && pip install -r requirements.txt`         |
| Editor shows `Import "chess" could not be resolved`                                    | venv missing or not selected      | Create `venv/`, install deps; `pyrightconfig.json` points at it       |
| "No Stockfish found"                                                                   | No engine in any search location  | Drop a binary in the user engines folder shown in Settings            |
| Settings dropdown stays on "Scanning…"                                                 | An engine is slow to answer `uci` | Wait; a wedged binary is given up on after 8s and the rest still load |

---

## Project Structure

```
aether-chess/
├── electron/          # Electron main process & preload
├── renderer/          # React + TypeScript frontend
│   ├── src/
│   │   ├── components/  # UI components
│   │   ├── stores/      # Zustand state stores
│   │   ├── views/       # Page-level views (Play, Analysis, Settings…)
│   │   └── styles/      # Tailwind + global CSS
│   └── index.html
├── backend/           # Python stdio JSON-RPC service
├── aether_chess/      # Core Python chess library (reused by backend)
│   ├── bots/          # Bot interface, BotManager, per-bot adapters
│   ├── engines/       # Mentor, UCI, engine controller
│   ├── models/        # Settings + game models
│   └── io/            # Opening book, PGN helpers
├── inspiration/       # Vendored Maia-3 (optional bot, installed with -e)
├── engines/           # Drop Stockfish binaries here (gitignored, .gitkeep only)
├── resources/         # Config defaults, icons
│   └── books/         # Polyglot opening books (.bin)
├── build/             # Build configs (electron-builder, PyInstaller)
├── docs/              # Documentation
├── typings/           # Type stubs for optional deps not installed locally
├── tests/             # Python unit tests + TypeScript engine-discovery tests
├── package.json
├── requirements.txt
├── requirements-dev.txt   # ruff + pyright, dev only
└── README.md
```
