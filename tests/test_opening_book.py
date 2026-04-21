import unittest
from dataclasses import dataclass
from unittest.mock import patch

import chess

from aether_chess.io.opening_book import OpeningBook


@dataclass
class FakeEntry:
    move: chess.Move
    weight: int


class OpeningBookTests(unittest.TestCase):
    def setUp(self):
        self.board = chess.Board()
        self.e4 = chess.Move.from_uci("e2e4")
        self.d4 = chess.Move.from_uci("d2d4")

    def test_choose_best_uses_highest_weight(self):
        book = OpeningBook(paths=["bookA"])
        with patch.object(book, "_entries_for_path", return_value=[FakeEntry(self.e4, 5), FakeEntry(self.d4, 20)]):
            move = book.choose(self.board, strategy="best")
        self.assertEqual(self.d4, move)

    def test_choose_off_disables_book(self):
        book = OpeningBook(paths=["bookA"])
        move = book.choose(self.board, strategy="off")
        self.assertIsNone(move)

    def test_choose_fixed_book_uses_selected_index(self):
        book = OpeningBook(paths=["bookA", "bookB"])

        def entries_for(path):
            return [FakeEntry(self.e4, 10)] if path == "bookB" else []

        with patch.object(book, "_entries_for_path", side_effect=lambda board, p: entries_for(p)):
            move = book.choose(self.board, strategy="weighted", auto_rotate_books=False, active_book_index=1)
        self.assertEqual(self.e4, move)


if __name__ == "__main__":
    unittest.main()
