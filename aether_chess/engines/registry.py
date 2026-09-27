"""Engine (Stockfish) discovery.

The engine executable is located in this order:

  1. An explicit path the user configured — their deliberate choice wins.
  2. A bare name such as ``stockfish`` — treated as *auto*, so it resolves
     through the search order rather than being taken literally.
  3. ``PATH``, so a system-wide install just works.
  4. The app's ``engines/`` folder (repo root, or ``resources/`` when packaged).
  5. A per-user engines folder, so someone who just wants to play can drop a
     downloaded binary somewhere writable without touching the install.

Every candidate is asked to identify itself over UCI, which is what lets
several Stockfish versions coexist and be reported individually instead of one
silently winning. This mirrors ``electron/engineRegistry.ts``; the Electron
layer resolves first and passes an absolute path down, so this module is the
fallback that keeps the backend usable on its own (PyInstaller, ``run.py``).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

# Values meaning "the user has not chosen a specific engine".
AUTO_NAMES = {"", "stockfish", "auto", "default"}

# A cold engine needs over a second just to start, and probing several at once
# on a loaded machine pushes past that, so the deadline is generous. Discovery
# only pays it once — successes are cached and candidates probe concurrently.
_PROBE_TIMEOUT_SEC = 8.0

# Probed identities, keyed by (path, size, mtime) so an edit invalidates them.
_IDENTITY_CACHE: dict = {}
_CACHE_LOCK = threading.Lock()

_SOURCE_LABELS = {
    "configured": "selected",
    "path": "system PATH",
    "app-engines": "app folder",
    "user-engines": "your engines folder",
    "bundled": "bundled",
}


@dataclass
class EngineCandidate:
    """A single engine executable found on this machine."""

    path: str
    name: str
    version: List[int] = field(default_factory=list)
    source: str = "path"

    @property
    def version_label(self) -> str:
        return ".".join(str(part) for part in self.version)

    @property
    def source_label(self) -> str:
        return _SOURCE_LABELS.get(self.source, self.source)

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "name": self.name,
            "version": self.version,
            "versionLabel": self.version_label,
            "source": self.source,
            "sourceLabel": self.source_label,
        }


def is_auto_path(candidate: Optional[str]) -> bool:
    """True when the value means "let the app decide" rather than a real path."""
    if candidate is None:
        return True
    trimmed = candidate.strip()
    if trimmed.lower() in AUTO_NAMES:
        return True
    # A bare name with no directory separator is a PATH lookup, not a real path.
    return os.sep not in trimmed and "/" not in trimmed


def is_executable_file(file_path: str) -> bool:
    path = Path(file_path)
    try:
        if not path.is_file():
            return False
    except OSError:
        return False
    if sys.platform == "win32":
        return path.suffix.lower() in {".exe", ".bat", ".cmd"}
    return os.access(path, os.X_OK)


def ensure_executable(file_path: str) -> None:
    """Grant the execute bit.

    Browsers do not preserve it, so a binary dragged straight out of a
    download folder is frequently not runnable until this runs.
    """
    if sys.platform == "win32":
        return
    path = Path(file_path)
    try:
        mode = path.stat().st_mode
        if not mode & 0o100:
            path.chmod(mode | 0o111)
    except OSError:
        pass  # not ours to change; nothing useful to do


def _app_engines_dir() -> Path:
    """The folder shipped alongside the app that players can drop binaries into."""
    # backend/ -> repo root in source runs; frozen builds sit next to the exe.
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
    return root / "engines"


def _user_engines_dir() -> Path:
    """Per-user engines folder — writable even when the app folder is not."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = str(Path.home() / "Library" / "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "AetherChess" / "engines"


def _path_command_names() -> List[str]:
    """Executable names worth probing on PATH, plain name first."""
    suffix = ".exe" if sys.platform == "win32" else ""
    names = ["stockfish"]
    # Distribution packages sometimes expose a versioned name.
    for version in range(20, 9, -1):
        names.append(f"stockfish-{version}")
    return [f"{name}{suffix}" for name in names]


def _which(command: str) -> Optional[str]:
    from shutil import which as _shutil_which

    return _shutil_which(command)


def _engine_files_in(directory) -> List[str]:
    try:
        entries = list(Path(directory).iterdir())
    except OSError:
        return []

    found: List[str] = []
    for entry in entries:
        try:
            if not (entry.is_file() or entry.is_symlink()):
                continue
        except OSError:
            continue
        if sys.platform == "win32":
            if entry.suffix.lower() in {".exe", ".bat", ".cmd"}:
                found.append(str(entry))
        elif "stockfish" in entry.name.lower():
            # No extension convention on Unix; a name containing "stockfish"
            # avoids picking up unrelated files dropped alongside.
            found.append(str(entry))
    return found


def _probe_identity(bin_path: str) -> Optional[str]:
    """Ask a binary to identify itself.

    UCI engines only emit ``id name`` in response to the ``uci`` command, so we
    send it and read until the answer arrives. A reader thread with a deadline
    keeps a wedged binary from hanging discovery.
    """
    try:
        proc = subprocess.Popen(
            [bin_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
    except OSError:
        return None

    collected: List[str] = []
    finished = threading.Event()

    def _read() -> None:
        try:
            if proc.stdin is not None:
                proc.stdin.write("uci\n")
                proc.stdin.flush()
        except (OSError, ValueError):
            pass
        try:
            if proc.stdout is not None:
                for line in proc.stdout:
                    collected.append(line)
                    if re.search(r"id name\s+", "".join(collected), re.IGNORECASE):
                        break
        except (OSError, ValueError):
            pass
        finally:
            finished.set()

    worker = threading.Thread(target=_read, daemon=True)
    worker.start()
    finished.wait(_PROBE_TIMEOUT_SEC)

    try:
        proc.kill()
        proc.wait(timeout=_PROBE_TIMEOUT_SEC)
    except (OSError, subprocess.TimeoutExpired):
        pass
    finally:
        # Closing the pipes matters: discovery re-probes whenever an engine is
        # added, and leaked descriptors would accumulate over a long session.
        for stream in (proc.stdin, proc.stdout):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass

    match = re.search(r"id name\s+(.+)", "".join(collected), re.IGNORECASE)
    return match.group(1).strip() if match else None


def _parse_version(text: str) -> List[int]:
    match = re.search(r"(\d+(?:\.\d+)*)", text)
    if not match:
        return []
    parts = []
    for piece in match.group(1).split("."):
        try:
            parts.append(int(piece))
        except ValueError:
            continue
    return parts


def _identity_cached(bin_path: str) -> Optional[str]:
    """Probe identity, memoised on the file's identity.

    Probing a 100 MB engine costs over a second, and the UI asks for the
    engine list every time Settings opens, so the answer is cached until the
    file actually changes.

    Only successful probes are cached: a timeout or a wedged binary is a
    transient condition, and remembering it would leave the engine permanently
    mislabelled until the file happened to be rewritten.
    """
    try:
        stat = os.stat(bin_path)
        signature = (os.path.abspath(bin_path), stat.st_size, stat.st_mtime_ns)
    except OSError:
        return None

    with _CACHE_LOCK:
        cached = _IDENTITY_CACHE.get(signature)
    if cached is not None:
        return cached

    identity = _probe_identity(bin_path)
    if identity:
        with _CACHE_LOCK:
            _IDENTITY_CACHE[signature] = identity
    return identity


def _build_candidate(
    bin_path: str, source: str, identity: Optional[str]
) -> EngineCandidate:
    if identity:
        name, version = identity, _parse_version(identity)
    else:
        # Engine did not identify itself; fall back to the filename.
        name, version = Path(bin_path).name, _parse_version(Path(bin_path).name)
    if not version:
        version = _parse_version(bin_path)
    return EngineCandidate(path=bin_path, name=name, version=version, source=source)


def _sort_key(candidate: EngineCandidate) -> tuple:
    # Newest version first; unknown versions sort last.
    return (
        0 if candidate.version else 1,
        [-part for part in candidate.version],
        candidate.name,
    )


def discover_engines(configured: Optional[str] = None) -> List[EngineCandidate]:
    """Every engine we can find, newest version first.

    The order of the returned list is the preference order used by
    :func:`resolve_engine_path`.
    """
    raw: List[tuple] = []
    seen: set = set()

    def add(bin_path: str, source: str) -> None:
        # Repair the execute bit before checking it: a binary dragged out of a
        # browser download folder is very often not executable yet.
        ensure_executable(bin_path)
        if not is_executable_file(bin_path):
            return
        absolute = os.path.abspath(bin_path)
        key = os.path.normcase(absolute)
        if key in seen:
            return
        seen.add(key)
        raw.append((absolute, source))

    # 1. An explicit, real path the user configured.
    if configured and not is_auto_path(configured):
        add(configured, "configured")

    # 2. PATH.
    for command in _path_command_names():
        located = _which(command)
        if located:
            add(located, "path")

    # 3. The app's own engines folder.
    for file_path in _engine_files_in(_app_engines_dir()):
        add(file_path, "app-engines")

    # 4. The per-user engines folder.
    for file_path in _engine_files_in(_user_engines_dir()):
        add(file_path, "user-engines")

    # 5. Ask every candidate to identify itself, concurrently. Starting engines
    #    is the slow part, and serial probes made opening Settings crawl.
    if not raw:
        return []
    identities: List[Optional[str]]
    if len(raw) == 1:
        identities = [_identity_cached(raw[0][0])]
    else:
        with ThreadPoolExecutor(max_workers=min(8, len(raw))) as pool:
            identities = list(pool.map(lambda item: _identity_cached(item[0]), raw))

    found = [
        _build_candidate(bin_path, source, identity)
        for (bin_path, source), identity in zip(raw, identities)
    ]
    return sorted(found, key=_sort_key)


def resolve_engine_path(configured: Optional[str] = None) -> Optional[str]:
    """The engine path to actually use, or None when none was found."""
    # An explicit path is the user's deliberate choice; honour it even if the
    # generic search would not find it, and report failure later rather than
    # silently substituting a different engine.
    if configured and not is_auto_path(configured):
        absolute = os.path.abspath(configured)
        return absolute if is_executable_file(absolute) else None

    candidates = discover_engines(configured)
    return candidates[0].path if candidates else None


def ensure_engine_dirs() -> List[Path]:
    """Create the folders a player drops binaries into. Returns both paths."""
    created: List[Path] = []
    for directory in (_app_engines_dir(), _user_engines_dir()):
        try:
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True)
            created.append(target)
        except OSError:
            continue
    return created
