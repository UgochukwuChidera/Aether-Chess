# TODO

1. **Real download progress bar in UI** — Currently Hugging Face progress only shows in terminal stderr. Needs streaming from Python backend through Electron IPC to a `<progress>` element in SettingsPanel.

2. Fix Maia3 inference on this machine — PyTorch `c10.dll` fails to initialize (WinError 1114). Reinstall CPU-only torch: `pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cpu`

3. Compile C++ engine in `cpp_engine/` — Needs MSVC Build Tools (~2-6GB) or MinGW-w64 (~500MB). Blocked by disk space (~2GB free).
