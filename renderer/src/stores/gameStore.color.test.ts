/**
 * gameStore.color.test.ts — P2-T09: move colour inferred by history parity.
 *
 * Fail-first contract: `applyMoveResult` labels moves
 * `i % 2 === 0 ? 'white' : 'black'`, so a game that opens with Black to move
 * (FEN/PGN-loaded) mislabels every ply, corrupting the per-side accuracy
 * averages in AnalysisPanel. The fix prefers the backend-fed per-move
 * `move_colors` record when present and falls back to index parity otherwise
 * (old-backend tolerance — the P0-T12 fixture and P1-T01 mocks emit no
 * `move_colors`, so they must keep working unchanged).
 *
 * - Test 1 forces the field (black-to-move mock WITH move_colors → first move
 *   labelled black) and therefore FAILS on the pre-fix code (parity says
 *   white). It asserts the backend-fed value, not the fallback.
 * - Test 2 pins the fallback (mock WITHOUT move_colors → parity) and passes
 *   before and after — the compat contract for existing producers.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore, type BackendMoveResult, type Color } from "./gameStore";

const BLACK_TO_MOVE_FEN =
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

function backendResult(
  ucis: string[],
  sans: string[],
  moveColors?: Color[],
): BackendMoveResult {
  return {
    fen: BLACK_TO_MOVE_FEN,
    turn: "black",
    legal_moves: [],
    move_history: [...sans],
    full_move_history: [...ucis],
    // Backend-fed per-move colour record (P2-T09). Absent on old backends.
    move_colors: moveColors,
    last_move_san: sans.length > 0 ? (sans[sans.length - 1] as string) : "",
    last_move_uci: ucis.length > 0 ? (ucis[ucis.length - 1] as string) : null,
    nav_index: -1,
    game_over: false,
    result: null,
    termination: null,
    in_check: false,
  };
}

beforeEach(() => {
  useGameStore.getState().resetGame();
});

describe("P2-T09 move colour from backend record", () => {
  it("labels the first move black for a black-to-move game", () => {
    useGameStore
      .getState()
      .applyMoveResult(backendResult(["e7e5"], ["e5"], ["black"]));

    const history = useGameStore.getState().moveHistory;
    expect(history).toHaveLength(1);
    expect(history[0]?.uci).toBe("e7e5");
    expect(history[0]?.color).toBe("black");
  });

  it("falls back to index parity when the backend sends no colours", () => {
    useGameStore
      .getState()
      .applyMoveResult(backendResult(["e2e4", "e7e5"], ["e4", "e5"]));

    const history = useGameStore.getState().moveHistory;
    expect(history).toHaveLength(2);
    expect(history[0]?.color).toBe("white");
    expect(history[1]?.color).toBe("black");
  });
});
