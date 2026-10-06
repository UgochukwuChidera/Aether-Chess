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

# P4-T03: build the compiled C++ eval kernel next to cpp_engine/__init__.py
# so backend.spec picks it up via _cpp_binaries. Best-effort: the gcc build
# is BLOCKED (pymodule.c compiled as C includes C++ <cstdint>; see
# cpp_engine/setup.py), and the backend runs fine without it (pure-Python
# fallback, flag defaults off) -- so warn and continue, never fail packaging
# for an experiment that ships disabled.
echo "→ Building C++ eval kernel (best-effort)…"
if python "$ROOT/cpp_engine/setup.py" build_ext --inplace; then
  echo "✓ C++ eval kernel built."
else
  echo "⚠ C++ eval kernel build failed -- continuing without it (fallback active)."
fi

echo "→ Running PyInstaller…"
pyinstaller "$ROOT/build/backend.spec" \
  --distpath "$DIST" \
  --workpath "$ROOT/build/pyinstaller-work" \
  --noconfirm

echo "✓ Backend binary written to $DIST"
