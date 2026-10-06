from __future__ import annotations

import os
import random
import threading
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple

import chess
import chess.polyglot

# ── Open-once reader cache (P4-T05) ──────────────────────────────────────────
# Book readers used to reopen the file on every lookup. Readers are now cached
# open, keyed on the absolute path, with the file's mtime (nanoseconds) stored
# alongside: every lookup stats the path and reopens only on drift. The cache
# holds one mmap reader per book file (a handful of fds for a books dir).
#
# Thread account: the backend serves requests from a ThreadPoolExecutor
# (P1-T04), so two threads can open the same path concurrently. All
# cache check-and-open work happens under `_book_cache_lock` (the open
# itself included), so the second thread always sees the first thread's
# fresh entry instead of opening twice. Cached readers are read-only mmaps
# and `find_all` mutates no reader state, so concurrent lookups on a shared
# reader are safe. `get_book_moves` is additionally serialized under the
# service `_board_lock` (it is a board-read command), so the live path never
# even reaches this lock concurrently — the lock exists for direct
# `OpeningBook` users.

_book_cache: Dict[str, Tuple[int, Any]] = {}
_book_cache_lock = threading.Lock()


def _cached_reader_for_path(book_path: str) -> Optional[Any]:
    """Return the cached open reader for `book_path`, opening on first use.

    Stats the path on every call; a changed mtime closes the stale reader
    and reopens. Returns None when the path cannot be opened (missing file,
    invalid book size) after dropping any stale entry.
    """
    key = os.path.abspath(book_path)
    try:
        mtime_ns = os.stat(key).st_mtime_ns
    except OSError:
        with _book_cache_lock:
            stale = _book_cache.pop(key, None)
        if stale is not None:
            try:
                stale[1].close()
            except Exception:
                pass
        return None
    with _book_cache_lock:
        cached = _book_cache.get(key)
        if cached is not None and cached[0] == mtime_ns:
            return cached[1]
        old = cached[1] if cached is not None else None
        try:
            reader = chess.polyglot.open_reader(key)
        except (FileNotFoundError, OSError):
            if cached is not None:
                _book_cache.pop(key, None)
                if old is not None:
                    try:
                        old.close()
                    except Exception:
                        pass
            return None
        _book_cache[key] = (mtime_ns, reader)
        if old is not None:
            try:
                old.close()
            except Exception:
                pass
        return reader


def find_entries_cached(
    book_path: str, board: chess.Board
) -> List[chess.polyglot.Entry]:
    """All entries for `board` in `book_path` via the open-once cache."""
    reader = _cached_reader_for_path(book_path)
    if reader is None:
        return []
    try:
        return list(reader.find_all(board))
    except OSError:
        return []


def close_cached_books() -> None:
    """Close and drop every cached reader (tests; long-lived otherwise)."""
    with _book_cache_lock:
        readers = [reader for _, reader in _book_cache.values()]
        _book_cache.clear()
    for reader in readers:
        try:
            reader.close()
        except Exception:
            pass


@dataclass
class OpeningBook:
    path: Optional[str] = None
    paths: Optional[List[str]] = None

    def _all_paths(self) -> List[str]:
        if self.paths:
            return [p for p in self.paths if p]
        return [self.path] if self.path else []

    def _entries_for_path(self, board: chess.Board, book_path: str) -> List[chess.polyglot.Entry]:
        return find_entries_cached(book_path, board)

    @staticmethod
    def _weighted_pick(entries_iterable: Iterable[chess.polyglot.Entry]) -> Optional[chess.Move]:
        entries_list = list(entries_iterable)
        if not entries_list:
            return None
        total = sum(max(1, e.weight) for e in entries_list)
        roll = random.randint(1, total)
        running = 0
        for e in entries_list:
            running += max(1, e.weight)
            if running >= roll:
                return e.move
        return entries_list[0].move

    def choose(
        self,
        board: chess.Board,
        strategy: str = "weighted",
        auto_rotate_books: bool = True,
        active_book_index: int = 0,
    ) -> Optional[chess.Move]:
        if strategy == "off":
            return None
        all_paths = self._all_paths()
        if not all_paths:
            return None

        book_paths: List[str]
        if auto_rotate_books:
            book_paths = all_paths[:]
            random.shuffle(book_paths)
        else:
            idx = max(0, min(active_book_index, len(all_paths) - 1))
            book_paths = [all_paths[idx]]

        entries: List[chess.polyglot.Entry] = []
        if strategy == "random":
            candidate_sets = [self._entries_for_path(board, p) for p in book_paths]
            candidate_sets = [s for s in candidate_sets if s]
            if not candidate_sets:
                return None
            chosen_set = random.choice(candidate_sets)
            return random.choice(chosen_set).move

        for p in book_paths:
            found = self._entries_for_path(board, p)
            if found:
                entries.extend(found)
                if not auto_rotate_books:
                    break
        if not entries:
            return None

        if strategy == "best":
            return max(entries, key=lambda e: e.weight).move
        return self._weighted_pick(entries)

