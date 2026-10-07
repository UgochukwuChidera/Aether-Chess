"""P4-T06 Tier 3: compiled-kernel property tests (needs the real ``.so``).

Runs ONLY on the compiled path: ``skipUnless(cpp_engine._has_cpp)`` skips
without a toolchain, and ``setUp`` asserts ``_has_cpp`` so a run that
reaches the bodies is provably the COMPILED kernel, never the fallback.

What is asserted (P4-T03 kernel contract -- properties, never
exact-equality with ``MentorEngine``; the two are different evaluations):

- determinism (same FEN twice -> same int),
- colour antisymmetry (``evaluate(fen) == -evaluate(mirror(fen))`` with a
  colour-swapped, rank-mirrored FEN that KEEPS the side to move -- exact,
  integer math is symmetric),
- material sanity (one extra queen is worth ~a queen: 950 +/- 250),
- mate: the mated side to move scores against itself (Scholar's mate,
  black to move and mated, scores < 0),
- stalemate ~= 0 for near-equal material (pawn-up stalemate, |.| < 200),
- batch equals elementwise singles,
- malformed FEN raises ``ValueError`` (Change-1 wrapper), never silent 0.

Deliberate non-assertions (P4-T06 record; CLOSED by P4-T11 -- the
probes below are the pre-fix blindness, kept as history; the parity
tests above now assert what was documented-not-asserted):

- "mate = mate score" did NOT hold pre-P4-T11 and was not asserted:
  the kernel is a static evaluator with no legal-move generation, so a
  mate scored its material/PST value, not a mate constant (Scholar's:
  kernel -80 vs fallback -MATE_SCORE+ply = -99995; Fool's mate, equal
  material: kernel 0 vs fallback -99996 -- sign-blind, not just
  magnitude-blind). P4-T11 adds a wrapper-level terminal passthrough
  (``cpp_engine`` checks checkmate/stalemate/insufficient-material via
  python-chess before dispatching, mirroring ``MentorEngine.evaluate``),
  so mate parity now holds EXACTLY and is asserted. The internal
  +/-100000 king-absence arms of ``evaluate()`` remain unreachable by
  design -- the wrapper rejects kingless FEN before C++ runs -- so no
  mate-score constant exists on the C++ public path; the passthrough
  lives in the Python wrapper, where movegen exists.
- "stalemate ~= 0" held only for near-equal material pre-P4-T11 and was
  asserted only there (pawn-up stalemate: kernel -133, fallback exactly
  0). Queen-up stalemate scored -1002 on the kernel (fallback 0) -- the
  kernel could not see the stalemate, only the queen. P4-T11 closes
  this the same way: stalemate and insufficient-material (KB-vs-K 350,
  KN-vs-K 350 pre-fix) now return exactly 0 via the passthrough and
  are asserted, including in batch.
- Antisymmetry mirror keeps the side to move, so it NEGATES the score
  but does NOT preserve terminal states (mate/stalemate are
  turn-relative): mirrored Scholar's scores +80 and is not mate;
  mirrored pawn-up stalemate scores +133 and is not stalemate. The
  antisymmetry test therefore uses non-terminal positions only, and the
  mate/stalemate tests pin ``is_checkmate()``/``is_stalemate()`` on the
  UNmirrored FEN via python-chess.

Fallback-first record (same properties, kernel forced out --
``_has_cpp False``): antisymmetry exact on every FEN (incl. midgame
334/-334, extra queen 955/-955); queen diff 955; mates exactly
-MATE_SCORE+ply; stalemates exactly 0. Every Tier-3 property either
holds in Python too or (mate/stalemate magnitude) is strictly stronger
there -- the kernel matches the shared properties on the compiled path.

Pre-change record: this file did not exist; without the P4-T06 build the
class skips (no kernel to test -- same reason P4-T03 shipped no Tier 3).
"""

import sys
import unittest
from pathlib import Path

import chess

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cpp_engine  # noqa: E402

STARTPOS = chess.STARTING_FEN
ITALIAN = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"
MIDGAME = "r1bqk2r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"
BARE_KINGS = "4k3/8/8/8/8/8/8/4K3 w - - 0 1"
EXTRA_QUEEN = "4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1"
# Scholar's mate, Black mated and to move (kernel probed at -80).
SCHOLARS_MATE = "r1bqkbnr/pppp1Qpp/2n5/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 3"
# Fool's mate, White mated and to move (kernel probed at 0 -- dead-even
# on a mated position: not just magnitude-blind, sign-blind).
FOOLS_MATE = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"
# KQ-vs-K back-rank mate, Black mated and to move (kernel probed -997).
MATE_KQ = "k7/1Q6/2K5/8/8/8/8/8 b - - 0 1"
# Pawn-up stalemate, Black to move (kernel probed at -133).
STALEMATE_PAWN = "5k2/5P2/5K2/8/8/8/8/8 b - - 0 1"
# Queen-up stalemate, Black to move (kernel probed at -1002).
STALEMATE_QUEEN = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"
# Insufficient material (kernel probed: bare kings 0, KB-vs-K 350,
# KN-vs-K 350 -- a lone minor scores a full piece in a dead draw).
KB_VS_K = "4k3/8/8/8/8/8/5B2/4K3 w - - 0 1"
KN_VS_K = "4k3/8/8/8/8/8/5N2/4K3 w - - 0 1"

# Fixed set shared with the P4-T06 benchmark (commit body).
BENCH_FENS = [STARTPOS, ITALIAN, MIDGAME, BARE_KINGS, EXTRA_QUEEN, SCHOLARS_MATE]

# P4-T11 quality-bar terminal set: every FEN here must score EXACTLY
# what MentorEngine.evaluate returns (mate magnitude / 0), on singles
# and in batch. Pre-fix probes (2026-10-06, compiled .so, _has_cpp
# True) -- the blindness this item closes:
#   SCHOLARS_MATE -80 vs -99995 | FOOLS_MATE 0 vs -99996 (sign-blind)
#   MATE_KQ -997 vs -99999 | STALEMATE_PAWN -133 vs 0
#   STALEMATE_QUEEN -1002 vs 0 | KB_VS_K 350 vs 0 | KN_VS_K 350 vs 0.
TERM_FENS = [
    SCHOLARS_MATE,
    FOOLS_MATE,
    MATE_KQ,
    STALEMATE_PAWN,
    STALEMATE_QUEEN,
    BARE_KINGS,
    KB_VS_K,
    KN_VS_K,
]


def mirror_keep_turn(fen: str) -> str:
    """Colour-swap + rank-mirror a FEN, keeping the side to move.

    Under this mirror the kernel score negates exactly (piece values,
    PST indexing, pawn-structure files, rook-rank bonuses and king
    tables are all symmetric in it). Terminal states are NOT preserved
    (they are turn-relative) -- see module docstring.
    """
    board = chess.Board(fen)
    mirrored = chess.Board.empty()
    for sq, piece in board.piece_map().items():
        mirrored.set_piece_at(
            chess.square_mirror(sq), chess.Piece(piece.piece_type, not piece.color)
        )
    mirrored.turn = board.turn
    # Mirror the rights (K<->k) into canonical order; the kernel ignores
    # everything past the turn flag, but the mirror should be faithful.
    swapped = {c.swapcase() for c in board.castling_xfen() if c != "-"}
    mirrored.set_castling_fen("".join(c for c in "KQkq" if c in swapped) or "-")
    return mirrored.fen()


@unittest.skipUnless(cpp_engine._has_cpp, "needs the compiled C++ kernel (P4-T06)")
class CppKernelTests(unittest.TestCase):
    def setUp(self):
        # Fail-fast compiled-path proof: reaching a body means the REAL
        # .so answered, never the MentorEngine fallback. (skipUnless
        # skips when absent; this asserts when present.)
        self.assertTrue(
            cpp_engine._has_cpp, "Tier 3 must run on the compiled kernel, not fallback"
        )

    def test_evaluate_is_deterministic(self):
        for fen in (ITALIAN, MIDGAME, SCHOLARS_MATE):
            with self.subTest(fen=fen):
                self.assertEqual(
                    cpp_engine.evaluate_fen(fen), cpp_engine.evaluate_fen(fen)
                )

    def test_colour_antisymmetry(self):
        for fen in (STARTPOS, ITALIAN, MIDGAME, BARE_KINGS, EXTRA_QUEEN):
            with self.subTest(fen=fen):
                self.assertEqual(
                    cpp_engine.evaluate_fen(fen),
                    -cpp_engine.evaluate_fen(mirror_keep_turn(fen)),
                )

    def test_extra_queen_worth_about_a_queen(self):
        diff = cpp_engine.evaluate_fen(EXTRA_QUEEN) - cpp_engine.evaluate_fen(
            BARE_KINGS
        )
        self.assertGreater(diff, 700)
        self.assertLess(diff, 1200)

    def test_mated_side_to_move_loses(self):
        board = chess.Board(SCHOLARS_MATE)
        self.assertTrue(board.is_checkmate(), "premise: the FEN must be checkmate")
        # Static kernel: no mate constant on the public path (see module
        # docstring). What must hold -- and survives a future mate term --
        # is that the mated side to move scores against itself.
        self.assertLess(cpp_engine.evaluate_fen(SCHOLARS_MATE), 0)

    def test_stalemate_near_equal_material_scores_near_zero(self):
        board = chess.Board(STALEMATE_PAWN)
        self.assertTrue(board.is_stalemate(), "premise: the FEN must be stalemate")
        self.assertLess(abs(cpp_engine.evaluate_fen(STALEMATE_PAWN)), 200)

    def test_checkmate_reports_mate_score_parity(self):
        # P4-T11 QB1: the kernel must REPORT mate when mated -- exactly
        # what MentorEngine.evaluate returns (-MATE_SCORE + ply,
        # side-to-move-relative), not a static material score. Fails
        # pre-fix (Scholar's -80, Fool's 0, KQ-mate -997).
        from aether_chess.engines.mentor_engine import MATE_SCORE

        for fen in (SCHOLARS_MATE, FOOLS_MATE, MATE_KQ):
            with self.subTest(fen=fen):
                board = chess.Board(fen)
                self.assertTrue(board.is_checkmate(), "premise: FEN must be mate")
                self.assertEqual(
                    cpp_engine.evaluate_fen(fen), -MATE_SCORE + board.ply()
                )

    def test_stalemate_scores_zero(self):
        # P4-T11 QB2: stalemate is 0, whatever the material imbalance.
        # Fails pre-fix (pawn-up -133, queen-up -1002).
        for fen in (STALEMATE_PAWN, STALEMATE_QUEEN):
            with self.subTest(fen=fen):
                board = chess.Board(fen)
                self.assertTrue(board.is_stalemate(), "premise: FEN must be stale")
                self.assertEqual(cpp_engine.evaluate_fen(fen), 0)

    def test_insufficient_material_scores_zero(self):
        # P4-T11 QB3: dead-draw material is 0, not a piece value. Fails
        # pre-fix (KB-vs-K 350, KN-vs-K 350; bare kings 0 by coincidence).
        for fen in (BARE_KINGS, KB_VS_K, KN_VS_K):
            with self.subTest(fen=fen):
                board = chess.Board(fen)
                self.assertTrue(
                    board.is_insufficient_material(), "premise: dead material"
                )
                self.assertEqual(cpp_engine.evaluate_fen(fen), 0)

    def test_batch_terminal_parity(self):
        # P4-T11: batch must agree with singles AND with the fallback on
        # every terminal in the set (batch takes its own C++ path, so a
        # singles-only fix would leave it blind). Fails pre-fix.
        from aether_chess.engines.mentor_engine import MATE_SCORE

        expected = []
        for fen in TERM_FENS:
            board = chess.Board(fen)
            if board.is_checkmate():
                expected.append(-MATE_SCORE + board.ply())
            else:
                expected.append(0)
        self.assertEqual(cpp_engine.evaluate_batch(TERM_FENS), expected)
        self.assertEqual(
            cpp_engine.evaluate_batch(TERM_FENS),
            [cpp_engine.evaluate_fen(f) for f in TERM_FENS],
        )

    def test_batch_matches_elementwise_singles(self):
        fens = BENCH_FENS + [STALEMATE_PAWN]
        self.assertEqual(
            cpp_engine.evaluate_batch(fens), [cpp_engine.evaluate_fen(f) for f in fens]
        )

    def test_malformed_fen_raises_not_zero(self):
        # Change-1 wrapper: python-chess validation + both-kings rule on
        # ALL entry points. Assert the raise, never a value.
        with self.assertRaises(ValueError):
            cpp_engine.evaluate_fen("not a fen")
        with self.assertRaises(ValueError):
            cpp_engine.evaluate_fen("8/8/8/8/8/8/8/8 w - - 0 1")
        with self.assertRaises(ValueError):
            cpp_engine.evaluate_batch([STARTPOS, "garbage!!"])


if __name__ == "__main__":
    unittest.main()
