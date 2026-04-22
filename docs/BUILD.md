# Aether Chess — Build & Packaging Guide

## Overview

Aether Chess is packaged as a single installer using:
- **electron-builder** for the Electron frontend
- **PyInstaller** for the Python backend (compiled to a standalone executable)

---

## 1. Build the Python backend

The Python backend must be compiled before packaging the Electron app.

```bash
# Install build tools
pip install pyinstaller

# Run the spec file
bash build/build-backend.sh
```

Or manually:

```bash
pyinstaller build/backend.spec \
  --distpath build/backend-dist \
  --workpath build/pyinstaller-work \
  --noconfirm
```

The compiled binary will be at `build/backend-dist/aether_backend` (or `aether_backend.exe` on Windows).

---

## 2. Build the Electron frontend

```bash
npm run build
```

This compiles:
- Vite renderer → `dist/renderer/`
- TypeScript electron main/preload → `dist/electron/`

---

## 3. Package for distribution

### All platforms (on appropriate CI/OS):

```bash
npm run dist
```

### Platform-specific:

```bash
npm run dist:win    # Windows NSIS installer (.exe)
npm run dist:mac    # macOS DMG (x64 + arm64)
npm run dist:linux  # Linux AppImage + .deb
```

Output goes to `dist/packages/`.

---

## 4. Bundle Stockfish

Include the Stockfish binary in `build/backend-dist/` before packaging:

```bash
# Linux
cp /usr/bin/stockfish build/backend-dist/stockfish

# macOS
cp $(which stockfish) build/backend-dist/stockfish

# Windows (copy to dist folder)
copy C:\stockfish\stockfish.exe build\backend-dist\stockfish.exe
```

The `electron-builder.yml` `extraResources` section bundles everything in `build/backend-dist/` into the app's `resources/backend/` directory.

---

## 5. macOS Code Signing & Notarization

Set environment variables before packaging:

```bash
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=your_password
export APPLE_ID=your@apple.id
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=XXXXXXXXXX
npm run dist:mac
```

electron-builder will automatically sign and notarize the DMG.

---

## 6. Auto-update (Optional)

Configure GitHub Releases as the update provider in `build/electron-builder.yml` (already set). Push a new release to trigger auto-update prompts in running app instances.

---

## CI/CD (GitHub Actions Example)

```yaml
- uses: actions/setup-node@v4
  with: { node-version: '20' }
- uses: actions/setup-python@v5
  with: { python-version: '3.12' }
- run: pip install -r requirements.txt pyinstaller
- run: bash build/build-backend.sh
- run: npm ci
- run: npm run dist:linux
  env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
```
