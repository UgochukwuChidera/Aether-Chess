"""P2-T09 regression: move colour must come from the backend, not index parity.

`gameStore.ts` labelled moves `i % 2 == 0 ? 'white' : 'black'`, so a game
that does not open with White to move (FEN/PGN-loaded, black to move)
mislabels every ply, corrupting the per-side averages in AnalysisPanel.

The manager genuinely retains no start position: `new_game` takes no FEN
and always resets to startpos, `load_pgn` replays from startpos ignoring
SetUp/FEN headers, and `GameState.load_fen` has zero production callers
(repo-wide `rg load_fen` hits only `tests/test_game_state.py`). So the fix
stores the minimum required (`_initial_fen`, set by a new optional
`new_game(fen=...)`), replays `_full_history` from it recording
`board.turn` BEFORE each push (mover, never parity), and emits the
per-move `move_colors` array from the same replay that produces
`move_history`/`full_move_history` (one replay keeps the three parallel
arrays consistent — replaying SANs from startpos would DROP a black-opening
move as illegal and the renderer zips by index).

Fail-first contract: all three tests FAIL on the pre-fix manager
(`new_game(fen=...)` is a TypeError; no `move_colors` key exists).
"""

import unittest

from backend.chess_engine import ChessEngineManager

# After 1.e4, Black to move. e7e5 is legal for Black here and ILLEGAL for
# White from startpos — so a startpos replay would drop it while an
# initial-FEN replay yields san "e5" labelled black.
BLACK_TO_MOVE_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"


class StateSnapshotColorsTest(unittest.TestCase):
    def test_first_move_from_black_to_move_fen_is_black(self) -> None:
        eng = ChessEngineManager()
        eng.new_game(fen=BLACK_TO_MOVE_FEN)
        ok, snap = eng.make_move("e7e5")
        self.assertTrue(ok, "setup move e7e5 rejected from black-to-move FEN")
        self.assertEqual(snap["full_move_history"], ["e7e5"])
        self.assertEqual(snap["move_history"], ["e5"])
        self.assertEqual(snap["move_colors"], ["black"])

    def test_standard_start_colors_match_parity(self) -> None:
        eng = ChessEngineManager()
        eng.new_game()
        for uci in ("e2e4", "e7e5"):
            ok, _ = eng.make_move(uci)
            self.assertTrue(ok, f"setup move {uci} rejected")
        snap = eng._state_snapshot()
        self.assertEqual(snap["full_move_history"], ["e2e4", "e7e5"])
        self.assertEqual(snap["move_history"], ["e4", "e5"])
        self.assertEqual(snap["move_colors"], ["white", "black"])

    def test_invalid_fen_rejected(self) -> None:
        eng = ChessEngineManager()
        with self.assertRaises(ValueError):
            eng.new_game(fen="not a fen")

    def test_import_pgn_resets_start_to_standard(self) -> None:
        # import_pgn replays from startpos (load_pgn ignores SetUp headers),
        # so a stale FEN start from an earlier new_game(fen=...) must not
        # leak into the replay — colours stay white-first.
        eng = ChessEngineManager()
        eng.new_game(fen=BLACK_TO_MOVE_FEN)
        eng.import_pgn("1. e4 e5 2. Nf3 *\n")
        snap = eng._state_snapshot()
        self.assertEqual(snap["full_move_history"], ["e2e4", "e7e5", "g1f3"])
        self.assertEqual(snap["move_colors"], ["white", "black", "white"])


if __name__ == "__main__":
    unittest.main()
