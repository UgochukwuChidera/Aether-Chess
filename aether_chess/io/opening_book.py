from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Iterable, List, Optional

import chess
import chess.polyglot


@dataclass
class OpeningBook:
    path: Optional[str] = None
    paths: Optional[List[str]] = None

    def _all_paths(self) -> List[str]:
        if self.paths:
            return [p for p in self.paths if p]
        return [self.path] if self.path else []

    def _entries_for_path(self, board: chess.Board, book_path: str) -> List[chess.polyglot.Entry]:
        try:
            with chess.polyglot.open_reader(book_path) as reader:
                return list(reader.find_all(board))
        except (FileNotFoundError, OSError):
            return []

    @staticmethod
    def _weighted_pick(entries: Iterable[chess.polyglot.Entry]) -> Optional[chess.Move]:
        entries = list(entries)
        if not entries:
            return None
        total = sum(max(1, e.weight) for e in entries)
        roll = random.randint(1, total)
        running = 0
        for e in entries:
            running += max(1, e.weight)
            if running >= roll:
                return e.move
        return entries[0].move

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

    def choose_weighted(self, board: chess.Board) -> Optional[chess.Move]:
        return self.choose(board, strategy="weighted")
