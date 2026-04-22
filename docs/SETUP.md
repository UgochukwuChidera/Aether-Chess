# Aether Chess — Developer Setup Guide

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 18+ | Download from nodejs.org |
| npm | 9+ | Included with Node.js |
| Python | 3.10+ | python.org or pyenv |
| pip | 23+ | `python -m pip install --upgrade pip` |

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
npm install
```

---

## 3. Install Python dependencies

```bash
pip install -r requirements.txt
```

---

## 4. Add a Stockfish binary (optional but recommended for full engine play)

Download Stockfish from https://stockfishchess.org/download/ and place the executable anywhere on your `PATH`:

```bash
export PATH=/path/to/stockfish-directory:$PATH  # Linux/macOS
```

You can also configure and validate the path in-app via **Settings → Engine → Stockfish path**.

---

## 5. Add an opening book (optional)

Place any Polyglot `.bin` book file in `resources/books/`. Example:

```bash
cp ~/Perfect2023.bin resources/books/
```

If no book is present, the opening explorer will display:
> "No opening book loaded. Place a .bin file in the books directory."

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

## 7. Run Python backend tests

```bash
python -m unittest discover -s tests -v
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Set to `production` for packaged builds |

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
├── resources/books/   # Polyglot opening books (.bin)
├── build/             # Build configs (electron-builder, PyInstaller)
├── docs/              # Documentation
├── tests/             # Python unit tests
├── package.json
├── requirements.txt
└── README.md
```
