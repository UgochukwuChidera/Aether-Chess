/**
 * MoveHistory.test.tsx — P2-T19(c): the black-move button renders and is
 * clickable when `black` is undefined.
 *
 * Recorded scoping: the button renders-but-no-ops (`onClick` guards with
 * `black &&`), so the fix is a11y hygiene — render no element at all —
 * not a phantom-click bug.
 *
 * Fail-first contract: with an odd-ply history the test asserts the FIXED
 * behaviour (zero empty buttons). FAILS on the pre-fix code (one empty
 * `<button>` for the missing black move). The even-ply test guards against
 * over-correction (passes before/after). Nav buttons always carry icon text,
 * so only the phantom cell matches the empty-text filter.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MoveHistory } from "./MoveHistory";
import { useGameStore, type BackendMoveResult } from "../stores/gameStore";

const UCIS = ["e2e4", "e7e5", "g1f3"];
const SANS = ["e4", "e5", "Nf3"];

function seedMoves(count: number): void {
  const ucis = UCIS.slice(0, count);
  const sans = SANS.slice(0, count);
  const result: BackendMoveResult = {
    fen: "fen-after-seed",
    turn: ucis.length % 2 === 0 ? "white" : "black",
    legal_moves: [],
    move_history: [...sans],
    full_move_history: [...ucis],
    last_move_san: sans.length > 0 ? (sans[sans.length - 1] as string) : "",
    last_move_uci: ucis.length > 0 ? (ucis[ucis.length - 1] as string) : null,
    nav_index: -1,
    game_over: false,
    result: null,
    termination: null,
    in_check: false,
  };
  useGameStore.getState().resetGame();
  useGameStore.getState().applyMoveResult(result);
}

/** Buttons with no text at all — the phantom black cell, if present. */
function emptyButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter(
    (b) => (b.textContent ?? "") === "",
  );
}

describe("P2-T19 missing black move", () => {
  it("renders no button element at all for a missing black move", () => {
    seedMoves(1);
    const { container, unmount } = render(<MoveHistory />);
    try {
      expect(emptyButtons(container)).toHaveLength(0);
    } finally {
      unmount();
    }
  });

  it("still renders the black move button when the move exists", () => {
    seedMoves(2);
    const { container, unmount } = render(<MoveHistory />);
    try {
      expect(emptyButtons(container)).toHaveLength(0);
      const black = Array.from(container.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "") === "e5",
      );
      expect(black).toBeDefined();
    } finally {
      unmount();
    }
  });
});
