/**
 * Board.rerender.test.tsx — P3-T05: narrow the hot-path store subscriptions.
 *
 * Fail-first contract: Board subscribes to the ENTIRE game store, so every
 * Stockfish `setAnalysis` push (many/sec, distinct pvs arrays) re-renders the
 * whole board subtree. The test renders Board isolated at a mid-game position
 * inside a React Profiler, dispatches three analysis pushes with DISTINCT pvs
 * arrays (the real high-frequency shape — defeats naive fresh-object
 * selectors), and asserts the Board commit count does NOT increase. FAILS on
 * the pre-fix whole-store subscription (count rises per push); PASSES once
 * Board selects only the fields it reads.
 */
import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { Profiler } from "react";
import { Board } from "./Board";
import { useGameStore } from "../stores/gameStore";

const MID_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

function presetMidGame(): void {
  useGameStore.getState().resetGame();
  useGameStore.setState({
    fen: MID_FEN,
    turn: "black",
    legalMoves: ["e7e5", "b8c6", "g8f6"],
    selectedSquare: null,
    highlightedSquares: [],
    lastMoveFrom: "e2",
    lastMoveTo: "e4",
    flipped: false,
    inCheck: false,
    analysis: { pvs: [], fen: MID_FEN, running: true },
  });
}

function pv(depth: number, seed: string) {
  return {
    depth,
    score_cp: 30 + depth,
    mate: null,
    pv: [seed, "g1f3"],
    pv_san: [seed, "Nf3"],
  };
}

describe("P3-T05 board skips analysis-push re-renders", () => {
  it("three distinct-pvs setAnalysis pushes cause zero Board commits", async () => {
    presetMidGame();
    let commits = 0;
    const { unmount } = render(
      <Profiler
        id="board-p3-t05"
        onRender={() => {
          commits += 1;
        }}
      >
        <Board onSquareClick={() => undefined} />
      </Profiler>,
    );
    try {
      // Flush the mount commit through the Profiler callback.
      await act(async () => undefined);
      const baseline = commits;
      expect(baseline).toBeGreaterThan(0);

      // Mirror the Stockfish stream: three pushes, fresh pvs array each time.
      for (let depth = 14; depth <= 16; depth += 1) {
        await act(async () => {
          useGameStore.getState().setAnalysis({
            pvs: [pv(depth, `e7e${depth}`)],
            fen: MID_FEN,
            running: true,
          });
        });
      }

      expect(commits).toBe(baseline);
    } finally {
      unmount();
    }
  });
});
