/**
 * Board.test.tsx — P2-T16: Board file labels are mirrored when flipped.
 *
 * Fail-first contract: `fileLabel` is derived from the raw grid index
 * (`'abcdefgh'[file]`, Board.tsx:126) instead of the flip-mapped
 * `displayFile`, so with `flipped: true` every file label is mirrored.
 * The flipped test below asserts the FIXED behaviour (top-left file
 * label `h`) and therefore FAILS on the pre-fix code (top-left reads `a`).
 * The unflipped test guards against over-correction (passes before/after).
 *
 * Board renders directly (no PlayView boardSize gate involved); the canvas
 * overlay in BoardDrawingLayer is inert in jsdom (null 2d context guard).
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Board } from "./Board";
import { useGameStore } from "../stores/gameStore";

function renderBoard(flipped: boolean) {
  useGameStore.getState().resetGame();
  useGameStore.setState({
    flipped,
    selectedSquare: null,
    highlightedSquares: [],
    lastMoveFrom: null,
    lastMoveTo: null,
    inCheck: false,
  });
  return render(<Board onSquareClick={() => undefined} />);
}

/** The file-coordinate label (`bottom-…` span) inside square `sq`. */
function fileLabelText(container: HTMLElement, sq: string): string | null {
  const el = container.querySelector(`[data-sq="${sq}"]`);
  if (!el) throw new Error(`square ${sq} not rendered (Board missing?)`);
  const fileSpan = Array.from(el.querySelectorAll("span")).find((s) =>
    s.className.includes("bottom-"),
  );
  return fileSpan ? (fileSpan.textContent ?? "").trim() : null;
}

/** All coordinate-label texts (`top-…` rank span, `bottom-…` file span). */
function labelTexts(container: HTMLElement, sq: string): string[] {
  const el = container.querySelector(`[data-sq="${sq}"]`);
  if (!el) throw new Error(`square ${sq} not rendered (Board missing?)`);
  return Array.from(el.querySelectorAll("span"))
    .filter(
      (s) => s.className.includes("top-") || s.className.includes("bottom-"),
    )
    .map((s) => (s.textContent ?? "").trim());
}

describe("P2-T16 board file labels under flip", () => {
  it("unflipped: top-left square is a8, bottom-left file label is a", () => {
    const { container, unmount } = renderBoard(false);
    try {
      expect(
        container.querySelector("[data-sq]")?.getAttribute("data-sq"),
      ).toBe("a8");
      expect(fileLabelText(container, "a1")).toBe("a");
      // Rank sanity on the same render (unflipped rank path is correct).
      expect(labelTexts(container, "a8")).toContain("8");
    } finally {
      unmount();
    }
  });

  it("flipped: top-left square is h1 and its file label is h", () => {
    const { container, unmount } = renderBoard(true);
    try {
      expect(
        container.querySelector("[data-sq]")?.getAttribute("data-sq"),
      ).toBe("h1");
      // Pre-fix this reads `a`: fileLabel ignores the 180° flip mapping.
      expect(fileLabelText(container, "h1")).toBe("h");
    } finally {
      unmount();
    }
  });
});
