#!/usr/bin/env bash
# build/build-backend.sh — Build the Python backend with PyInstaller.
# Run from the repo root.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST="$ROOT/build/backend-dist"

echo "→ Installing Python dependencies…"
pip install pyinstaller python-chess onnxruntime

echo "→ Running PyInstaller…"
pyinstaller "$ROOT/build/backend.spec" \
  --distpath "$DIST" \
  --workpath "$ROOT/build/pyinstaller-work" \
  --noconfirm

echo "✓ Backend binary written to $DIST"
