#!/usr/bin/env bash
set -euo pipefail
python -m pip install -r requirements.txt pyinstaller
pyinstaller --clean --noconfirm aether_chess.spec
