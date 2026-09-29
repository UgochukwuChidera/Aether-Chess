#!/usr/bin/env bash
# build/build-backend.sh — Build the Python backend with PyInstaller.
# Run from the repo root.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST="$ROOT/build/backend-dist"

echo "→ Installing Python dependencies…"
pip install -r "$ROOT/requirements.txt"
# pyinstaller is pinned in requirements.txt as a build extra (`extra == "build"`),
# which `pip install -r` skips — install its pinned spec from the file (no version hard-coded here).
pip install "$(grep '^pyinstaller' "$ROOT/requirements.txt" | sed 's/ *;.*//')"

echo "→ Resolved package versions…"
pip freeze

echo "→ Running PyInstaller…"
pyinstaller "$ROOT/build/backend.spec" \
  --distpath "$DIST" \
  --workpath "$ROOT/build/pyinstaller-work" \
  --noconfirm

echo "✓ Backend binary written to $DIST"
