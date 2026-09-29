/**
 * gameStore.accuracy.test.ts — P2-T08: accuracy annotations keyed inconsistently.
 *
 * Fail-first contract: `applyAccuracyResults` builds `byUci` keyed by ROW INDEX
 * (`${r.uci}:${i}`) but looks it up by OCCURRENCE COUNT within `moveHistory`
 * (`${m.uci}:${seen}`). The two coincide only while every UCI is unique; any
 * repeated move desynchronises the map and later annotations are dropped or
 * attached to the wrong ply. Both tests below assert the FIXED behaviour
 * (every row annotated on its own ply) and therefore FAIL on the pre-fix code.
 *
 * Collision design (old key `${uci}:${i}` vs lookup `${uci}:${seen}`):
 * - Test 1 (drop): moves [g1f3, g8f6, f3g1, g1f3] — knight out-and-back with a
 *   black filler, so the repeat is a legal-looking game. Old row keys are
 *   g1f3:0, g8f6:1, f3g1:2, g1f3:3; lookups are g1f3:0 (hit), g8f6:0 (MISS —
 *   row holds g8f6:1), f3g1:0 (MISS — row holds f3g1:2), g1f3:1 (MISS — rows
 *   hold g1f3:0/g1f3:3). Only ply 0 is annotated; plies 1-3 are dropped.
 * - Test 2 (misattach): moves [e2e4, g1f3, g1f3] with distinct cp per row.
 *   Old row keys are e2e4:0, g1f3:1, g1f3:2; lookups are e2e4:0 (hit),
 *   g1f3:0 (MISS → dropped), g1f3:1 (HIT on the FIRST g1f3 row → the second
 *   occurrence wears the first occurrence's cp_loss/classification).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  useGameStore,
  type AccuracyMoveResult,
  type BackendMoveResult,
} from "./gameStore";

function seedHistory(ucis: string[]): void {
  const result: BackendMoveResult = {
    fen: "fen-after-seed",
    turn: ucis.length % 2 === 0 ? "white" : "black",
    legal_moves: [],
    move_history: ucis.map((_, i) => `San${i}`),
    full_move_history: [...ucis],
    last_move_san: ucis.length > 0 ? `San${ucis.length - 1}` : "",
    last_move_uci: ucis.length > 0 ? (ucis[ucis.length - 1] as string) : null,
    nav_index: -1,
    game_over: false,
    result: null,
    termination: null,
    in_check: false,
  };
  useGameStore.getState().applyMoveResult(result);
}

function accuracyRows(cpLosses: number[]): AccuracyMoveResult[] {
  return cpLosses.map((cp_loss, i) => ({
    uci: "",
    cp_loss,
    classification: `Class${i}`,
  }));
}

beforeEach(() => {
  useGameStore.getState().resetGame();
});

describe("P2-T08 accuracy annotation keying", () => {
  it("annotates every ply of a knight out-and-back game on its own ply", () => {
    const ucis = ["g1f3", "g8f6", "f3g1", "g1f3"];
    seedHistory(ucis);
    const rows = accuracyRows([5, 15, 25, 60]).map((r, i) => ({
      ...r,
      uci: ucis[i] as string,
    }));
    useGameStore.getState().applyAccuracyResults(rows);

    const history = useGameStore.getState().moveHistory;
    expect(history).toHaveLength(ucis.length);
    // Every row carries its annotation AND sits on the correct ply (by index).
    history.forEach((m, i) => {
      expect(m.uci).toBe(ucis[i]);
      expect(m.cp_loss).toBe(rows[i]?.cp_loss);
      expect(m.classification).toBe(rows[i]?.classification);
    });
    // The repeated knight move's two occurrences wear distinct annotations.
    expect(history[0]?.cp_loss).toBe(5);
    expect(history[3]?.cp_loss).toBe(60);
  });

  it("does not misattach the first occurrence's annotation onto a repeated UCI", () => {
    const ucis = ["e2e4", "g1f3", "g1f3"];
    seedHistory(ucis);
    const rows = accuracyRows([7, 11, 99]).map((r, i) => ({
      ...r,
      uci: ucis[i] as string,
    }));
    useGameStore.getState().applyAccuracyResults(rows);

    const history = useGameStore.getState().moveHistory;
    expect(history).toHaveLength(ucis.length);
    history.forEach((m, i) => {
      expect(m.uci).toBe(ucis[i]);
      expect(m.cp_loss).toBe(rows[i]?.cp_loss);
      expect(m.classification).toBe(rows[i]?.classification);
    });
    // Second g1f3 occurrence must wear its OWN cp (99), not the first's (11).
    expect(history[2]?.cp_loss).toBe(99);
    expect(history[2]?.classification).toBe("Class2");
  });
});
