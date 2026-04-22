# backend.spec — PyInstaller spec for the Aether Chess Python backend.
#
# Usage (from repo root):
#   pyinstaller build/backend.spec --distpath build/backend-dist

import sys
import os
from pathlib import Path

ROOT = Path(SPECPATH).parent  # repo root

a = Analysis(
    [str(ROOT / 'backend' / 'service.py')],
    pathex=[str(ROOT), str(ROOT / 'backend')],
    binaries=[],
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
        'aether_chess.engines',
        'aether_chess.engines.mentor_engine',
        'aether_chess.engines.uci_engine',
        'aether_chess.engines.controller',
        'aether_chess.io',
        'aether_chess.io.opening_book',
        'aether_chess.io.tablebases',
        'aether_chess.models',
        'aether_chess.models.game_state',
        'aether_chess.models.settings',
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
