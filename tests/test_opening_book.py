import os
import tempfile
import unittest
from dataclasses import dataclass
from unittest.mock import patch

import chess
import chess.polyglot

import aether_chess.io.opening_book as opening_book_mod
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


STARTING_FEN = chess.STARTING_FEN


def _write_polyglot_book(path, board, moves_weights):
    """Write a minimal sorted polyglot .bin (test-only helper).

    python-chess ships no book writer (no `open_writer` in this version),
    so tests pack entries directly: key = zobrist_hash(board), raw move =
    to | (from << 6) (no promotions in test data), weight, learn=0.
    Rows are sorted by key because `find_all` locates positions by bisection.
    """
    key = chess.polyglot.zobrist_hash(board)
    rows = []
    for uci, weight in moves_weights:
        move = chess.Move.from_uci(uci)
        raw = move.to_square | (move.from_square << 6)
        rows.append((key, raw, weight, 0))
    rows.sort(key=lambda row: row[0])
    with open(path, "wb") as fh:
        for key, raw, weight, learn in rows:
            fh.write(chess.polyglot.ENTRY_STRUCT.pack(key, raw, weight, learn))


class ChooseWeightedOrphanTests(unittest.TestCase):
    """P4-T05(a): `choose_weighted` was pure duplication of `choose`.

    Its body is `return self.choose(board, strategy="weighted")`, which is
    byte-identical to calling `choose()` with its defaults (the default
    strategy IS "weighted"), and it has zero callers repo-wide. One way to
    do it: the wrapper must be gone, the strategy must survive via `choose`.
    """

    def setUp(self):
        self.board = chess.Board()

    def test_choose_weighted_is_gone(self):
        self.assertFalse(
            hasattr(OpeningBook, "choose_weighted"),
            "orphaned OpeningBook.choose_weighted still exists: "
            "delete the wrapper, `choose(strategy='weighted')` is the one path",
        )

    def test_weighted_strategy_survives_via_choose(self):
        book = OpeningBook(paths=["bookA"])
        entries = [FakeEntry(chess.Move.from_uci("e2e4"), 10),
                   FakeEntry(chess.Move.from_uci("d2d4"), 90)]
        with patch.object(book, "_entries_for_path", return_value=entries):
            with patch("aether_chess.io.opening_book.random.randint", return_value=1):
                self.assertEqual(chess.Move.from_uci("e2e4"),
                                 book.choose(self.board, strategy="weighted"))
            with patch("aether_chess.io.opening_book.random.randint", return_value=100):
                self.assertEqual(chess.Move.from_uci("d2d4"),
                                 book.choose(self.board, strategy="weighted"))


class BooksDirPlumbingTests(unittest.TestCase):
    """P4-T05(b): `openingBookPath` must reach `get_book_moves(books_dir)`."""

    def test_custom_books_dir_honored(self):
        from backend.chess_engine import ChessEngineManager

        with tempfile.TemporaryDirectory() as tmp:
            _write_polyglot_book(
                os.path.join(tmp, "test.bin"), chess.Board(),
                [("e2e4", 10), ("d2d4", 30)],
            )
            eng = ChessEngineManager()
            res = eng.get_book_moves(STARTING_FEN, books_dir=tmp)
        by_uci = {m["uci"]: m["weight"] for m in res["moves"]}
        self.assertEqual({"e2e4": 10, "d2d4": 30}, by_uci)

    def test_default_books_dir_is_cwd_independent(self):
        # The `"resources/books"` default is repo-relative, but the backend
        # CWD is whatever spawned it. From a foreign CWD the lookup must
        # still find the shipped book (repo-anchored), not an empty hint.
        from backend.chess_engine import ChessEngineManager

        probe = tempfile.mkdtemp()
        prev = os.getcwd()
        os.chdir(probe)
        try:
            eng = ChessEngineManager()
            res = eng.get_book_moves(STARTING_FEN)
        finally:
            os.chdir(prev)
        ucis = {m["uci"] for m in res.get("moves", [])}
        self.assertIn(
            "e2e4", ucis,
            "default books_dir resolved against the process CWD: "
            f"from {probe} the shipped book was invisible (hint={res.get('hint')!r})",
        )


class BookCacheTests(unittest.TestCase):
    """P4-T05(c): open-once readers keyed on (path, mtime)."""

    def setUp(self):
        self.board = chess.Board()
        closer = getattr(opening_book_mod, "close_cached_books", None)
        if closer is not None:
            closer()

    @staticmethod
    def _counting_open_reader(counts):
        real_open = chess.polyglot.open_reader

        def counting(path, *args, **kwargs):
            counts.append(os.fspath(path))
            return real_open(path, *args, **kwargs)

        return counting

    def _write_test_book(self, tmp):
        bin_path = os.path.join(tmp, "cache.bin")
        _write_polyglot_book(
            bin_path, self.board, [("e2e4", 30), ("d2d4", 10)]
        )
        return bin_path

    def test_lookup_twice_opens_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            bin_path = self._write_test_book(tmp)
            book = OpeningBook(paths=[bin_path])
            counts = []
            with patch("chess.polyglot.open_reader",
                        new=self._counting_open_reader(counts)):
                first = book.choose(self.board, strategy="best")
                second = book.choose(self.board, strategy="best")
            self.assertEqual(chess.Move.from_uci("e2e4"), first)
            self.assertEqual(first, second)
            self.assertEqual(
                1, len(counts),
                f"reader reopened per lookup (opened {len(counts)}x): {counts}",
            )

    def test_mtime_bump_reopens(self):
        with tempfile.TemporaryDirectory() as tmp:
            bin_path = self._write_test_book(tmp)
            book = OpeningBook(paths=[bin_path])
            counts = []
            with patch("chess.polyglot.open_reader",
                        new=self._counting_open_reader(counts)):
                book.choose(self.board, strategy="best")
                self.assertEqual(1, len(counts))
                book.choose(self.board, strategy="best")
                self.assertEqual(1, len(counts))
                st = os.stat(bin_path)
                os.utime(bin_path,
                         ns=(st.st_atime_ns, st.st_mtime_ns + 2_000_000_000))
                move = book.choose(self.board, strategy="best")
            self.assertEqual(chess.Move.from_uci("e2e4"), move)
            self.assertEqual(
                2, len(counts),
                f"mtime drift did not invalidate the cache: {counts}",
            )

    def test_engine_live_path_reuses_reader(self):
        from backend.chess_engine import ChessEngineManager

        with tempfile.TemporaryDirectory() as tmp:
            self._write_test_book(tmp)
            eng = ChessEngineManager()
            counts = []
            with patch("chess.polyglot.open_reader",
                        new=self._counting_open_reader(counts)):
                first = eng.get_book_moves(STARTING_FEN, books_dir=tmp)
                second = eng.get_book_moves(STARTING_FEN, books_dir=tmp)
            self.assertEqual(first, second)
            self.assertEqual(
                1, len(counts),
                f"live get_book_moves reopened per lookup: {counts}",
            )

    def test_concurrent_lookups_do_not_corrupt(self):
        # Backend post-P1-T04 serves requests from a thread pool: two
        # threads opening the same path at once must not corrupt the cache
        # (a lock or a benign race, recorded in the commit body).
        from concurrent.futures import ThreadPoolExecutor

        with tempfile.TemporaryDirectory() as tmp:
            bin_path = self._write_test_book(tmp)
            book = OpeningBook(paths=[bin_path])
            with ThreadPoolExecutor(max_workers=4) as pool:
                moves = list(pool.map(
                    lambda _: book.choose(self.board, strategy="best"),
                    range(16),
                ))
        legal = {chess.Move.from_uci("e2e4"), chess.Move.from_uci("d2d4")}
        for move in moves:
            self.assertIn(move, legal)
