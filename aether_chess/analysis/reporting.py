from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List

try:
    from fpdf import FPDF
except ImportError as exc:
    FPDF = None
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


def generate_pdf_report(output_path: str, data: ReportData) -> str:
    if FPDF is None:
        raise RuntimeError("fpdf2 is required for PDF reporting") from _IMPORT_ERROR

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=12)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, data.title, ln=1)
    pdf.set_font("Helvetica", size=11)
    pdf.multi_cell(0, 7, f"{data.white} vs {data.black}   Result: {data.result}")
    pdf.multi_cell(0, 7, f"Accuracy: {data.white} {data.accuracy_white:.1f}% | {data.black} {data.accuracy_black:.1f}%")
    pdf.multi_cell(0, 7, f"Estimated Elo: {data.white} {data.estimated_elo_white:.0f} | {data.black} {data.estimated_elo_black:.0f}")
    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Critical Moments", ln=1)
    pdf.set_font("Helvetica", size=10)
    for moment in data.key_moments:
        pdf.multi_cell(0, 6, f"- {moment}")
    pdf.ln(2)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Annotated PGN", ln=1)
    pdf.set_font("Courier", size=9)
    pdf.multi_cell(0, 5, data.annotated_pgn)
    output = str(Path(output_path).resolve())
    pdf.output(output)
    return output
