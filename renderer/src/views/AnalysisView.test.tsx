/**
 * AnalysisView.test.tsx — P2-T18: duplicate analysis start + missing dep.
 *
 * Fail-first contract: `handleNavigate` (AnalysisView.tsx:107-114) calls
 * `handleStartAnalysis()` directly whenever `runningRef` is set, while the
 * FEN/settings effect (:59-80) independently stops analysis and schedules
 * a debounced restart (350 ms) on the SAME `store.fen` change — two
 * concurrent starts per navigation. The effect deps also omit
 * `settings.playEngine` (used at :91 to pick the analysis engine), so
 * switching engines mid-analysis never takes effect. Both tests below
 * assert the FIXED behaviour and therefore FAIL on the pre-fix code for
 * the stated reasons (2 starts instead of 1; 0 restarts on engine
 * switch).
 *
 * Timer design (recorded per item): vitest FAKE timers
 * (`vi.useFakeTimers()` before mount). The restart debounce is a raw
 * `setTimeout(..., 350)`, so each test mounts, flushes the initial start
 * deterministically with `await vi.advanceTimersByTimeAsync(350)` inside
 * `act`, clears the spy, drives the UI, then flushes in TWO steps: an
 * empty `await act(async () => {})` drains the async navigate handler
 * (microtasks) plus the store-driven rerender and effect rerun — only
 * then is the restart timer pending — followed by
 * `advanceTimersByTimeAsync(400)` to fire the 350 ms debounce (+50
 * boundary slack). A single exactly-350 advance was tried first and
 * MISSES the restart: passive effects flush after the advance completes,
 * so the timer lands past the window (observed pre-fix: 1 stale-fen
 * direct call instead of the true 2). No `waitFor` anywhere: it is
 * timer-driven and would hang under fake timers. Real timers are
 * restored in `finally`.
 *
 * Driver fidelity: navigation is driven the way the UI does it — a click
 * on the MoveHistory white-move button ("e4") → `onMoveClick` →
 * `handleNavigate(0)`. The `navigateToMove` stub returns a DIFFERENT fen
 * (the navigated position), which is load-bearing: without a fen change
 * the effect would not refire and the pre-fix double-start would not
 * reproduce (the direct call fires regardless of fen; the debounced
 * restart only fires on fen change).
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { AnalysisView } from "./AnalysisView";
import { useGameStore, type BackendMoveResult } from "../stores/gameStore";
import { useSettingsStore } from "../stores/settingsStore";

const FEN_AFTER_E4 =
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const FEN_AFTER_E5 =
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1";

function moveResult(
  fen: string,
  sans: string[],
  ucis: string[],
  navIndex: number,
): BackendMoveResult {
  return {
    fen,
    turn: "white",
    legal_moves: [],
    move_history: [...sans],
    full_move_history: [...ucis],
    last_move_san: sans.length > 0 ? (sans[sans.length - 1] ?? "") : "",
    last_move_uci: ucis.length > 0 ? (ucis[ucis.length - 1] ?? null) : null,
    nav_index: navIndex,
    game_over: false,
    result: null,
    termination: null,
    in_check: false,
  };
}

// Live position after 1. e4 e5; navigating to move 0 shows the e4-only position.
const LIVE_RESULT = moveResult(
  FEN_AFTER_E5,
  ["e4", "e5"],
  ["e2e4", "e7e5"],
  -1,
);
const NAV0_RESULT = moveResult(FEN_AFTER_E4, ["e4"], ["e2e4"], 0);

interface AnalysisBackend {
  startAnalysis: ReturnType<typeof vi.fn>;
  stopAnalysis: ReturnType<typeof vi.fn>;
}

/**
 * Minimal fake backend mirroring the PlayView.test.tsx mock conventions
 * (startAnalysis mock shape, onAnalysisUpdate capture + unsubscribe).
 * `navigateToMove` answers index 0 with the navigated fen and anything
 * else with the live position.
 */
function createAnalysisBackend(): AnalysisBackend {
  const startAnalysis = vi.fn(
    async (_params: Record<string, unknown>) => undefined,
  );
  const stopAnalysis = vi.fn(async () => undefined);
  const api: Record<string, (...args: never[]) => unknown> = {
    startAnalysis: startAnalysis as (...args: never[]) => unknown,
    stopAnalysis: stopAnalysis as (...args: never[]) => unknown,
    onAnalysisUpdate: (cb: (raw: unknown) => void) => {
      void cb;
      return () => undefined;
    },
    navigateToMove: async (params: { index: number }) =>
      params.index === 0 ? NAV0_RESULT : LIVE_RESULT,
    estimateElo: async () => ({
      estimated_elo: 1500,
      confidence_interval: [1400, 1600],
      rd: 100,
    }),
    calculateAccuracyFromHistory: async () => ({
      moves: [],
      white_accuracy: 0,
      black_accuracy: 0,
    }),
    loadSettings: async () => null,
    saveSettings: async () => true,
  };
  window.electronAPI = api as unknown as Window["electronAPI"];
  return { startAnalysis, stopAnalysis };
}

function resetStoresForAnalysis(): void {
  useGameStore.getState().resetGame();
  useGameStore.setState({ toasts: [] });
  useGameStore.getState().applyMoveResult(LIVE_RESULT);
  useSettingsStore.setState({
    playEngine: "stockfish",
    stockfishPath: "stockfish",
    multipv: 3,
    threads: 1,
    hashMb: 128,
    showEvalBar: false,
    showAnalysisThreats: false,
    showAnalysisTopMoves: false,
    showAnalysisTopAlternatives: false,
    soundEnabled: false,
  });
}

function lastStartParams(
  startAnalysis: AnalysisBackend["startAnalysis"],
): Record<string, unknown> {
  const calls = startAnalysis.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error("startAnalysis was never called");
  return last[0] as Record<string, unknown>;
}

describe("P4-T12 callback stabilization (no restart loops)", () => {
  it("STABLE: settings-unrelated churn + bare re-renders cause zero restarts", async () => {
    // P4-T12 stability analysis (ships in the commit): the :80 effect calls
    // the per-render `handleStartAnalysis` and reads render-scope `store`
    // without listing them, and `handleNavigate` (:112) reads `store` under
    // `useCallback([])`. Naively adding them to the dep arrays would CREATE
    // a restart loop (fresh callback identity / fresh store snapshot every
    // render -> effect refires every render -> stop + 350 ms restart churn).
    // The fix reads everything via getState() with useCallback([]), so both
    // identities are static and the effect fires only on real triggers
    // (fen / analysis settings). Honest pre-state: the count is ALREADY
    // stable pre-fix -- the warnings flag potential, not an actual loop,
    // because the unlisted callback is never re-invoked by the effect. This
    // test therefore passes pre AND post; it pins the no-restart invariant
    // while the P2-T18 pair below carries behavior and lint-zero (2 -> 0)
    // is the stabilization proof.
    const backend = createAnalysisBackend();
    resetStoresForAnalysis();
    vi.useFakeTimers();
    const rendered = render(<AnalysisView />);
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      expect(backend.startAnalysis).toHaveBeenCalledTimes(1);
      backend.startAnalysis.mockClear();

      // N settings-unrelated re-renders: toggle fields the restart effect
      // does NOT depend on (soundEnabled / showEvalBar), push toasts (game
      // store churn that must not retrigger), and force bare re-renders.
      for (let i = 0; i < 5; i++) {
        act(() => {
          useSettingsStore.getState().update({ soundEnabled: i % 2 === 0 });
          useSettingsStore.getState().update({ showEvalBar: i % 2 === 1 });
          useGameStore.getState().pushToast(`churn-${i}`, "info");
        });
        rendered.rerender(<AnalysisView />);
      }
      // Flush past the 350 ms debounce: any restart loop would have
      // scheduled (and fired) timers here.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      // No restart loop: start count stable, not growing with churn.
      expect(backend.startAnalysis).toHaveBeenCalledTimes(0);
    } finally {
      rendered.unmount();
      vi.useRealTimers();
    }
  });
});

describe("P2-T18 duplicate analysis start + missing engine dep", () => {
  it("SINGLE-START: navigating fires exactly one startAnalysis, for the navigated fen", async () => {
    const backend = createAnalysisBackend();
    resetStoresForAnalysis();
    vi.useFakeTimers();
    const rendered = render(<AnalysisView />);
    try {
      // Mount effect debounces the initial start by 350 ms — flush it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      // Sanity: the effect path actually starts analysis (no dead path).
      expect(backend.startAnalysis).toHaveBeenCalledTimes(1);
      backend.startAnalysis.mockClear();

      // Drive navigation the way the UI does: MoveHistory → handleNavigate.
      fireEvent.click(rendered.getByRole("button", { name: "e4" }));
      // Two-step flush (load-bearing — a single advance misses the
      // restart): the click handler awaits navigateToMove, so the store
      // update → rerender → effect rerun happens in microtasks whose
      // passive effects React flushes only AFTER the advance completes —
      // a timer scheduled mid-advance would land past the window (first
      // attempt: exactly-350 captured only the direct call). Drain the
      // handler + effects first (restart timer now pending at now+350),
      // THEN move the clock past the 350 ms debounce (+50 boundary slack).
      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      // Pre-fix this is 2 (direct handleStartAnalysis call + debounced
      // effect restart); post-fix the effect alone restarts, exactly once.
      expect(backend.startAnalysis).toHaveBeenCalledTimes(1);
      // The single start analyses the NAVIGATED position (not a dead path
      // that drops navigations), with the unchanged maia3→stockfish
      // engine mapping (stockfish stays stockfish).
      const params = lastStartParams(backend.startAnalysis);
      expect(params["fen"]).toBe(FEN_AFTER_E4);
      expect(params["engine_type"]).toBe("stockfish");
    } finally {
      rendered.unmount();
      vi.useRealTimers();
    }
  });

  it("ENGINE-SWITCH: changing settings.playEngine mid-analysis restarts with the new engine", async () => {
    const backend = createAnalysisBackend();
    resetStoresForAnalysis();
    vi.useFakeTimers();
    const rendered = render(<AnalysisView />);
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      expect(backend.startAnalysis).toHaveBeenCalledTimes(1);
      expect(lastStartParams(backend.startAnalysis)["engine_type"]).toBe(
        "stockfish",
      );
      backend.startAnalysis.mockClear();

      // Switch engines mid-analysis the way the settings UI does.
      act(() => {
        useSettingsStore.getState().update({ playEngine: "mentor" });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });

      // Pre-fix the effect deps omit playEngine, so nothing restarts (0
      // calls); post-fix the dep change restarts analysis exactly once
      // with the NEW engine.
      expect(backend.startAnalysis).toHaveBeenCalledTimes(1);
      expect(lastStartParams(backend.startAnalysis)["engine_type"]).toBe(
        "mentor",
      );
    } finally {
      rendered.unmount();
      vi.useRealTimers();
    }
  });
});
