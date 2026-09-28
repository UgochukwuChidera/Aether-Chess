# TODO

1. **Real download progress bar in UI** — Currently Hugging Face progress only shows in terminal stderr. Needs streaming from Python backend through Electron IPC to a `<progress>` element in SettingsPanel.

2. Fix Maia3 inference on this machine — PyTorch `c10.dll` fails to initialize (WinError 1114). Reinstall CPU-only torch: `pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cpu`

3. Compile C++ engine in `cpp_engine/` — Needs MSVC Build Tools (~2-6GB) or MinGW-w64 (~500MB). Blocked by disk space (~2GB free).

4. **Maia3 ignores the resolved time limit** — `aether_chess/bots/maia3_bot.py` does not honour the `time_limit_sec` the manager resolves from the clock, so Maia3 can think longer than the budget it was given. Every other bot uses it. Until this is fixed, Maia3 is not strictly comparable to the others in timed play.

5. **`supports_skill_level` is surfaced but unused** — `list_bots` reports whether a bot exposes a native UCI `Skill Level` option, and `BotInfo` declares it in `renderer/src/electron.d.ts`, but no component reads it. Either wire it into the settings panel (hide the strength slider for bots without a skill level) or drop the field.
