"""P4-T02 fail-first: PDF game reports via fpdf2.

`aether_chess/analysis/reporting.py` (54 lines) defines `ReportData` and
`generate_pdf_report`, but `requirements.txt:15` has `fpdf2` commented out,
so the module's `FPDF` is always None and every call raises
`RuntimeError("fpdf2 is required for PDF reporting")`.

These tests assert the FIXED behaviour:

- a known game yields a file that exists, is non-empty and is a valid PDF
  (`%PDF` magic bytes, `%%EOF` trailer; parsed with pypdf when available --
  it is NOT installed in venv, so header + size + trailer is the proof here),
- `key_moments` sourcing picks the LARGEST `cp_loss` entries from the
  accuracy rows `backend/analysis.py::AccuracyAnalyser.calculate` already
  computes (row keys: uci/fen/color/cp_loss/classification), top-N with
  N=5 recorded,
- an unwritable destination raises a clear `OSError` (the module's actual
  error path: `pdf.output()` propagates the OS error with the path in the
  message),
- with fpdf2 absent the module raises the documented `RuntimeError`.

Missing-font note: the module uses fpdf2 CORE fonts only
(Helvetica/Courier -- no font file is ever loaded), so there is no
missing-font path to test; the unwritable-path test above is the "or" half
of the plan's error-path clause. Test data is ASCII-only because core
fonts are latin-1 (non-ASCII titles would raise UnicodeEncodeError -- a
documented fpdf2 limitation, not this module's defect).
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

import chess

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from aether_chess.analysis import reporting  # noqa: E402
from aether_chess.analysis.reporting import (  # noqa: E402
    ReportData,
    generate_pdf_report,
    key_moments_from_rows,
)

# Scholar's mate fragment -- short, known, legal.
SCHOLARS_MATE_UCI = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"]
SCHOLARS_MATE_SAN = ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"]
SCHOLARS_MATE_PGN = (
    '[White "Scholar"]\n[Black "Opponent"]\n[Result "1-0"]\n\n'
    "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0"
)

# cp_loss values aligned with SCHOLARS_MATE_UCI (fabricated analysis rows).
CP_LOSSES = [4.0, 6.5, 12.0, 310.5, 8.0, 520.0, 0.0]


def _known_rows():
    """Accuracy-shaped rows (uci/fen/color/cp_loss/classification) for the
    known game, replayed so every fen is legal."""
    board = chess.Board()
    rows = []
    for uci, loss in zip(SCHOLARS_MATE_UCI, CP_LOSSES, strict=True):
        rows.append(
            {
                "uci": uci,
                "fen": board.fen(),
                "color": "white" if board.turn == chess.WHITE else "black",
                "cp_loss": loss,
                "classification": "Best" if loss < 50 else "Blunder",
            }
        )
        board.push(chess.Move.from_uci(uci))
    return rows


def _known_report_data():
    return ReportData(
        title="Aether Chess Game Report",
        white="Scholar",
        black="Opponent",
        result="1-0",
        accuracy_white=96.4,
        accuracy_black=71.2,
        estimated_elo_white=1650,
        estimated_elo_black=1210,
        key_moments=key_moments_from_rows(_known_rows()),
        annotated_pgn="1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0",
    )


class TestGeneratePdfReport(unittest.TestCase):
    def test_valid_pdf_from_known_game(self):
        out = Path(self._tmp_dir()) / "report.pdf"
        returned = generate_pdf_report(str(out), _known_report_data())
        self.assertEqual(returned, str(out.resolve()))
        self.assertTrue(out.exists(), "report file must exist")
        data = out.read_bytes()
        self.assertGreater(
            len(data), 1000, f"report must be non-empty (got {len(data)} bytes)"
        )
        self.assertTrue(
            data.startswith(b"%PDF-"),
            f"valid PDF magic bytes, got {data[:8]!r}",
        )
        self.assertIn(b"%%EOF", data, "PDF trailer must be present")

    def test_unwritable_path_raises_clear_error(self):
        bad = Path("/nonexistent-dir-p4t02-no-such-dir/report.pdf")
        with self.assertRaises(OSError) as ctx:
            generate_pdf_report(str(bad), _known_report_data())
        self.assertTrue(
            str(ctx.exception),
            "error message must be non-empty",
        )
        self.assertIn(
            "nonexistent-dir-p4t02-no-such-dir",
            str(ctx.exception),
            "error must name the offending path",
        )

    def test_fpdf2_absent_raises_runtime_error(self):
        with mock.patch.object(reporting, "FPDF", None):
            with self.assertRaises(RuntimeError) as ctx:
                generate_pdf_report(
                    str(Path(self._tmp_dir()) / "x.pdf"), _known_report_data()
                )
        self.assertIn("fpdf2", str(ctx.exception))

    def _tmp_dir(self):
        tmp = Path(__file__).resolve().parent / ".tmp-p4t02"
        tmp.mkdir(exist_ok=True)
        self.addCleanup(lambda: [p.unlink(missing_ok=True) for p in tmp.glob("*.pdf")])
        return tmp


class TestKeyMoments(unittest.TestCase):
    def test_largest_cp_loss_first(self):
        moments = key_moments_from_rows(_known_rows())
        # N=5 recorded: 7 rows in, 5 moments out.
        self.assertEqual(len(moments), 5)
        # Largest losses first: 520.0 (Nf6, ply 6), 310.5 (Nc6, ply 4), ...
        self.assertIn("Nf6", moments[0])
        self.assertIn("520", moments[0])
        self.assertIn("Nc6", moments[1])
        self.assertIn("310", moments[1])
        # Smallest losses (Qxf7# at 0.0, e4 at 4.0) are cut by top-5.
        joined = "\n".join(moments)
        self.assertNotIn("Qxf7#", joined)
        self.assertNotIn(" e4 ", f" {joined} ")

    def test_top_n_respected_and_ply_numbered(self):
        moments = key_moments_from_rows(_known_rows(), n=2)
        self.assertEqual(len(moments), 2)
        self.assertTrue(moments[0].startswith("Ply 6"))
        self.assertTrue(moments[1].startswith("Ply 4"))

    def test_empty_rows(self):
        self.assertEqual(key_moments_from_rows([]), [])


class TestExportPdfReportHandler(unittest.TestCase):
    """`backend/service.py::handle_export_pdf_report` wiring: PGN in (mirrors
    `handle_calculate_accuracy_from_pgn`), accuracy rows from the stubbed
    analyser (no Stockfish), PDF out to the caller-supplied path."""

    def test_pgn_to_pdf_path(self):
        import service  # type: ignore[reportMissingImports]

        canned = {
            "moves": _known_rows(),
            "white_accuracy": 96.4,
            "black_accuracy": 71.2,
            "white_avg_cp_loss": 6.1,
            "black_avg_cp_loss": 212.3,
        }
        tmp = Path(__file__).resolve().parent / ".tmp-p4t02"
        tmp.mkdir(exist_ok=True)
        out = tmp / "handler-report.pdf"
        if out.exists():
            out.unlink()
        self.addCleanup(lambda: out.unlink(missing_ok=True))
        with mock.patch.object(
            service.accuracy_analyser, "calculate", return_value=canned
        ):
            res = service.handle_export_pdf_report(
                {"pgn": SCHOLARS_MATE_PGN, "output_path": str(out)}
            )
        self.assertEqual(res["path"], str(out))
        self.assertEqual(len(res["key_moments"]), 5)
        data = out.read_bytes()
        self.assertTrue(data.startswith(b"%PDF-"), f"magic bytes, got {data[:8]!r}")
        self.assertGreater(len(data), 1000)

    def test_accuracy_error_raises(self):
        import service  # type: ignore[reportMissingImports]

        canned = {"error": "No Stockfish found.", "moves": []}
        with mock.patch.object(
            service.accuracy_analyser, "calculate", return_value=canned
        ):
            with self.assertRaises(ValueError) as ctx:
                service.handle_export_pdf_report({"pgn": SCHOLARS_MATE_PGN})
        self.assertIn("No Stockfish", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
