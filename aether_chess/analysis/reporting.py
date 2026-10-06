from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List

import chess

_IMPORT_ERROR: Exception | None = None
try:
    from fpdf import FPDF
except ImportError as exc:
    FPDF = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


@dataclass
class ReportData:
    title: str
    white: str
    black: str
    result: str
    accuracy_white: float
    accuracy_black: float
    estimated_elo_white: float
    estimated_elo_black: float
    key_moments: List[str]
    annotated_pgn: str


# P4-T02: how many of the largest-cp_loss rows become report moments.
KEY_MOMENTS_TOP_N = 5


def key_moments_from_rows(
    rows: List[Dict[str, Any]], n: int = KEY_MOMENTS_TOP_N
) -> List[str]:
    """Format the `n` largest-`cp_loss` accuracy rows as report moments.

    Rows are the per-move dicts `backend/analysis.py::calculate` returns
    (keys: uci/fen/color/cp_loss/classification), in move order, so the
    enumeration index is the ply number. SAN is derived by replaying the
    row's own fen+uci (no caller context needed).
    """
    ranked = sorted(
        enumerate(rows),
        key=lambda pair: float(pair[1].get("cp_loss", 0.0)),
        reverse=True,
    )
    moments: List[str] = []
    for ply0, row in ranked[: max(0, n)]:
        ply = ply0 + 1
        try:
            board = chess.Board(str(row.get("fen", chess.STARTING_FEN)))
            san = board.san(chess.Move.from_uci(str(row["uci"])))
        except Exception:
            san = str(row.get("uci", "?"))
        moments.append(
            f"Ply {ply} {san} ({row.get('color', '?')}, "
            f"{row.get('classification', '?')}, "
            f"cp loss {row.get('cp_loss', '?')})"
        )
    return moments


def generate_pdf_report(output_path: str, data: ReportData) -> str:
    if FPDF is None:
        raise RuntimeError("fpdf2 is required for PDF reporting") from _IMPORT_ERROR
    from fpdf.enums import XPos, YPos

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=12)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, data.title, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Helvetica", size=11)
    pdf.multi_cell(
        0,
        7,
        f"{data.white} vs {data.black}   Result: {data.result}",
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )
    pdf.multi_cell(
        0,
        7,
        f"Accuracy: {data.white} {data.accuracy_white:.1f}% | {data.black} {data.accuracy_black:.1f}%",
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )
    pdf.multi_cell(
        0,
        7,
        f"Estimated Elo: {data.white} {data.estimated_elo_white:.0f} | {data.black} {data.estimated_elo_black:.0f}",
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )
    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Critical Moments", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Helvetica", size=10)
    for moment in data.key_moments:
        pdf.multi_cell(0, 6, f"- {moment}", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(2)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Annotated PGN", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Courier", size=9)
    pdf.multi_cell(0, 5, data.annotated_pgn, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    output = str(Path(output_path).resolve())
    pdf.output(output)
    return output
