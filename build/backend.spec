# backend.spec — PyInstaller spec for the Aether Chess Python backend.
#
# Usage (from repo root):
#   pyinstaller build/backend.spec --distpath build/backend-dist

import sys
import os
from pathlib import Path

ROOT = Path(SPECPATH).parent  # repo root

# P4-T03: ship the compiled C++ eval kernel alongside the frozen backend
# when present (built via `npm run build:cpp`, which places
# cpp_engine.*.so / .pyd beside cpp_engine/__init__.py). Glob matches
# nothing when unbuilt, so the entry is inert and the frozen backend keeps
# working on the pure-Python fallback (flag defaults off).
_CPP_LIB = ROOT / "cpp_engine"
_cpp_binaries = [
    (str(p), ".")
    for pattern in ("cpp_engine*.so", "cpp_engine*.pyd")
    for p in sorted(_CPP_LIB.glob(pattern))
]

a = Analysis(
    [str(ROOT / 'backend' / 'service.py')],
    pathex=[str(ROOT), str(ROOT / 'backend')],
    binaries=_cpp_binaries,
    datas=[
        (str(ROOT / 'aether_chess'), 'aether_chess'),
        (str(ROOT / 'resources' / 'books'), 'resources/books'),
    ],
    hiddenimports=[
        'chess',
        'chess.engine',
        'chess.pgn',
        'chess.polyglot',
        'aether_chess',
        'aether_chess.analysis',
        'aether_chess.analysis.metrics',
        # P4-T02: imported lazily inside handle_export_pdf_report (same
        # shape as the tablebases probe above), so it needs the explicit
        # entry or the frozen backend cannot build the report.
        'aether_chess.analysis.reporting',
        # Every bot is chosen dynamically by id at runtime, so PyInstaller sees
        # no import of these from any single static call site.
        'aether_chess.bots',
        'aether_chess.bots.base',
        'aether_chess.bots.manager',
        'aether_chess.bots.maia3_bot',
        'aether_chess.bots.mentor_bot',
        'aether_chess.bots.stockfish_bot',
        'aether_chess.engines',
        'aether_chess.engines.maia3_proxy',
        'aether_chess.engines.mentor_engine',
        'aether_chess.engines.registry',
        'aether_chess.io',
        'aether_chess.io.opening_book',
        'aether_chess.io.tablebases',
        'aether_chess.models',
        'aether_chess.models.game_state',
        'aether_chess.think_profile',
        # P4-T03: wrapper package for the compiled eval kernel. Imported
        # lazily in the flag branch (never module-level), so static analysis
        # misses it; the native library itself arrives via _cpp_binaries.
        'cpp_engine',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['pygame', 'tkinter', 'PyQt5'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='aether_backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # backend needs stdin/stdout
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / 'resources' / 'icons' / 'icon.ico') if sys.platform == 'win32' else None,
)
