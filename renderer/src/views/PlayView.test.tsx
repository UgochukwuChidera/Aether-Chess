/**
 * PlayView.test.tsx — P1-T01: makeAiMove has exactly one state owner.
 *
 * Fail-first contract: with useOpeningBook:true the opening-book branch of
 * makeAiMove returns WITHOUT calling applyMoveResult, and runAiVsAiLoop never
 * applies either — so in ai_vs_ai mode the backend advances while the store
 * does not, and the loop re-sends from the stale FEN. Both tests below assert
 * the FIXED behaviour (store advances once per AI ply) and therefore FAIL on
 * the pre-fix code (store FEN/history stay at the initial position).
 *
 * Real timers: the loop sleeps 400 ms between plies, so two plies take <1 s.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { PlayView } from "./PlayView";
import { useGameStore, type BackendMoveResult } from "../stores/gameStore";
import { useSettingsStore } from "../stores/settingsStore";
import { Sound } from "../utils/sound";

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const BOOK_PLIES = ["e2e4", "e7e5"];

function moveResult(
  fen: string,
  historyUci: string[],
  gameOver: boolean,
): BackendMoveResult {
  return {
    fen,
    turn: historyUci.length % 2 === 0 ? "white" : "black",
    legal_moves: ["e2e4", "e7e5", "g1f3", "b8c6"],
    move_history: [...historyUci],
    full_move_history: [...historyUci],
    last_move_san:
      historyUci.length > 0 ? historyUci[historyUci.length - 1] : "",
    last_move_uci:
      historyUci.length > 0 ? historyUci[historyUci.length - 1] : null,
    nav_index: -1,
    game_over: gameOver,
    result: gameOver ? "1-0" : null,
    termination: null,
    in_check: false,
  };
}

interface FakeBackend {
  api: Record<string, (...args: never[]) => unknown>;
  makeMoveMoves: string[];
  getAnalysisCb: () => ((raw: unknown) => void) | null;
}

/**
 * Minimal fake backend. makeMove advances its own ply count and hands back a
 * DISTINCT fen per ply; the loop is stopped by reporting game_over after the
 * second ply. getBookMoves feeds one deterministic legal move per ply (single
 * candidate, so the weighted-random pick is deterministic). getEngineMove
 * returns a move the test never expects — if the engine path were taken
 * instead of the book path, the makeMoveMoves assertion would catch it.
 */
function createFakeBackend(): FakeBackend {
  const played: string[] = [];
  const makeMoveMoves: string[] = [];
  let analysisCb: ((raw: unknown) => void) | null = null;
  const api: Record<string, (...args: never[]) => unknown> = {
    newGame: async () => moveResult(INITIAL_FEN, [], false),
    getBookMoves: async () => ({
      moves: [{ uci: BOOK_PLIES[played.length] ?? "g1f3", weight: 100 }],
    }),
    getLegalMoves: async () => ({
      moves: [{ uci: "e2e4" }, { uci: "e7e5" }, { uci: "g1f3" }],
    }),
    getEngineMove: async () => ({ move: "g1f3" }),
    makeMove: async (params: { move: string }) => {
      makeMoveMoves.push(params.move);
      played.push(params.move);
      return moveResult(
        `fen-after-${played.length}`,
        [...played],
        played.length >= 2,
      );
    },
    startAnalysis: async () => undefined,
    stopAnalysis: async () => undefined,
    onAnalysisUpdate: (cb: (raw: unknown) => void) => {
      analysisCb = cb;
      return () => undefined;
    },
    onBackendClosed: () => () => undefined,
    onBackendError: () => () => undefined,
    exportPgn: async () => ({ pgn: "" }),
    saveGameHistory: async () => ({ ok: true }),
    computeAndCacheElo: async () => ({ ok: true }),
    loadSettings: async () => null,
    saveSettings: async () => true,
  };
  return {
    api,
    makeMoveMoves,
    getAnalysisCb: () => analysisCb,
  };
}

function resetStoresForAiVsAi(): void {
  useGameStore.getState().resetGame();
  useGameStore.setState({
    mode: "ai_vs_ai",
    humanColor: "white",
    flipped: false,
    engineBusy: false,
    toasts: [],
  });
  useSettingsStore.setState({
    loaded: true, // P2-T01 gate: these tests model post-load state, so the game starts on mount
    useOpeningBook: true,
    openingBookDepth: 20,
    showEvalBar: false,
    soundEnabled: false,
    autoSaveGameHistory: false,
    playEngine: "stockfish",
    botStrength: 5,
    thinkProfile: "rapid",
    timeControl: { seconds: 0, increment: 0, label: "Unlimited" },
  });
}

/**
 * Count applyMoveResult calls via a setState wrapper (survives zustand's
 * state-object replacement, unlike vi.spyOn on a stale snapshot).
 */
function countApplies(): { count: () => number; restore: () => void } {
  const orig = useGameStore.getState().applyMoveResult;
  let n = 0;
  useGameStore.setState({
    applyMoveResult: (r: BackendMoveResult) => {
      n += 1;
      orig(r);
    },
  });
  return {
    count: () => n,
    restore: () => {
      useGameStore.setState({ applyMoveResult: orig });
    },
  };
}

function renderAiVsAiGame(): {
  unmount: () => void;
  backend: FakeBackend;
  counter: { count: () => number; restore: () => void };
} {
  const backend = createFakeBackend();
  window.electronAPI = backend.api as unknown as Window["electronAPI"];
  resetStoresForAiVsAi();
  const counter = countApplies();
  const { unmount } = render(<PlayView onTabChange={() => undefined} />);
  return { unmount, backend, counter };
}

describe("P1-T01 makeAiMove state ownership", () => {
  it("book-path move advances the store FEN (applied exactly once)", async () => {
    const { unmount, backend, counter } = renderAiVsAiGame();
    try {
      await waitFor(
        () => {
          expect(useGameStore.getState().fullMoveHistoryUCI).toEqual(
            BOOK_PLIES,
          );
        },
        { timeout: 4000, interval: 50 },
      );
      // Store tracks the backend board instead of sitting on the stale FEN.
      expect(useGameStore.getState().fen).toBe("fen-after-2");
      expect(backend.makeMoveMoves).toEqual(BOOK_PLIES);
      // 1 × newGame initial position + 1 per AI ply: no missing-apply, no double-apply.
      expect(counter.count()).toBe(3);
    } finally {
      counter.restore();
      unmount();
    }
  }, 15000);

  it("runAiVsAiLoop plays two distinct plies before stopping", async () => {
    const { unmount, backend, counter } = renderAiVsAiGame();
    try {
      await waitFor(
        () => {
          expect(backend.makeMoveMoves).toEqual(BOOK_PLIES);
        },
        { timeout: 4000, interval: 50 },
      );
      // Both plies landed in the store as distinct entries — the second ply
      // was computed from the advanced position, not a stale-FEN resend.
      const history = useGameStore.getState().fullMoveHistoryUCI;
      expect(history).toEqual(BOOK_PLIES);
      expect(new Set(history).size).toBe(2);
      expect(counter.count()).toBe(3);
    } finally {
      counter.restore();
      unmount();
    }
  }, 15000);
});

/**
 * P2-T01: settings load race.
 *
 * Fail-first contract: PlayView mounts (child effects run before App's
 * loadFromBackend resolves) and the mount effect calls handleNewGame from the
 * first-render settings snapshot, so newGame goes out with the DEFAULT
 * playEngine even though the backend has maia3 cached. The test below asserts
 * the FIXED behaviour (the game starts only after settings.loaded, with the
 * loaded playEngine) and therefore FAILS on the pre-fix code (newGame called
 * once with stockfish).
 */
describe("P2-T01 settings load race", () => {
  it("newGame uses the loaded playEngine (maia3), exactly once", async () => {
    const newGameCalls: Array<Record<string, unknown>> = [];
    const backend = createFakeBackend();
    backend.api.newGame = async (params?: Record<string, unknown>) => {
      if (params) newGameCalls.push(params);
      return moveResult(INITIAL_FEN, [], false);
    };
    backend.api.loadSettings = async () => ({
      playEngine: "maia3",
    });
    window.electronAPI = backend.api as unknown as Window["electronAPI"];

    // First-render snapshot: defaults, settings not yet loaded.
    useGameStore.getState().resetGame();
    useGameStore.setState({
      mode: "human_vs_human",
      humanColor: "white",
      flipped: false,
      engineBusy: false,
      toasts: [],
    });
    useSettingsStore.setState({
      playEngine: "stockfish",
      loaded: false,
      useOpeningBook: false,
      showEvalBar: false,
      soundEnabled: false,
      autoSaveGameHistory: false,
      botStrength: 5,
      thinkProfile: "rapid",
      timeControl: { seconds: 0, increment: 0, label: "Unlimited" },
    });

    const { unmount } = render(<PlayView onTabChange={() => undefined} />);
    try {
      // Simulate App.tsx startup completing after mount (child effects first).
      await useSettingsStore.getState().loadFromBackend();
      await waitFor(
        () => {
          expect(newGameCalls.length).toBeGreaterThan(0);
        },
        { timeout: 4000, interval: 50 },
      );
      // Loaded settings win: exactly one game, started as maia3.
      expect(newGameCalls.length).toBe(1);
      expect(newGameCalls[0]?.["engine_type"]).toBe("maia3");
    } finally {
      unmount();
    }
  }, 15000);
});

/**
 * P2-T02: eval bar frozen after the first move.
 *
 * Fail-first contract: the analysis listener closes over the render-scope
 * `store`, so `store.fen` is permanently the INITIAL fen. Dispatching an
 * analysis_update for a LATER fen is discarded by the stale filter and
 * `store.analysis.fen` never advances. The test below asserts the FIXED
 * behaviour (the callback compares against the live fen and accepts the
 * push) and therefore FAILS on the pre-fix code. A second phase asserts
 * the guard still works: a push for a superseded fen is ignored.
 */
describe("P2-T02 eval-bar analysis listener", () => {
  it("accepts an analysis_update for the current (later) fen; ignores stale pushes", async () => {
    const backend = createFakeBackend();
    let newGameDone = false;
    const origNewGame = backend.api.newGame;
    backend.api.newGame = async () => {
      const r = await (origNewGame as () => Promise<unknown>)();
      newGameDone = true;
      return r;
    };
    window.electronAPI = backend.api as unknown as Window["electronAPI"];

    useGameStore.getState().resetGame();
    useGameStore.setState({
      mode: "human_vs_human",
      humanColor: "white",
      flipped: false,
      engineBusy: false,
      toasts: [],
    });
    // showEvalBar:true models the real frozen-eval-bar scenario; it also
    // avoids the hidden-bar reset path (setAnalysis running:false,pvs:[])
    // racing the pvs/running assertions below.
    useSettingsStore.setState({
      loaded: true,
      useOpeningBook: false,
      showEvalBar: true,
      soundEnabled: false,
      autoSaveGameHistory: false,
      playEngine: "stockfish",
      botStrength: 5,
      thinkProfile: "rapid",
      timeControl: { seconds: 0, increment: 0, label: "Unlimited" },
    });

    const { unmount } = render(<PlayView onTabChange={() => undefined} />);
    try {
      // Mount effect starts the game async; wait until it settles so the
      // later-fen advance below cannot be clobbered by its resetGame.
      await waitFor(
        () => {
          expect(newGameDone).toBe(true);
        },
        { timeout: 4000, interval: 50 },
      );
      const cb = backend.getAnalysisCb();
      if (!cb) throw new Error("analysis listener was not registered");

      const LATER_FEN =
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
      // Advance the store past the initial position, as a real move would.
      useGameStore
        .getState()
        .applyMoveResult(moveResult(LATER_FEN, ["e2e4"], false));
      expect(useGameStore.getState().fen).toBe(LATER_FEN);

      // The backend answers for the CURRENT position — accept it.
      const pv = {
        depth: 12,
        score_cp: 34,
        mate: null,
        pv: ["e7e5"],
        pv_san: ["e5"],
      };
      act(() => {
        cb({ callback_id: "analysis-play", fen: LATER_FEN, pvs: [pv] });
      });
      await waitFor(
        () => {
          expect(useGameStore.getState().analysis.fen).toBe(LATER_FEN);
        },
        { timeout: 2000, interval: 25 },
      );
      expect(useGameStore.getState().analysis.pvs).toHaveLength(1);
      // The debounce reset (running:false) flushes after the first dispatch;
      // re-dispatch for the settled position and assert the full payload.
      act(() => {
        cb({ callback_id: "analysis-play", fen: LATER_FEN, pvs: [pv] });
      });
      expect(useGameStore.getState().analysis.fen).toBe(LATER_FEN);
      expect(useGameStore.getState().analysis.pvs).toHaveLength(1);
      expect(useGameStore.getState().analysis.running).toBe(true);

      // A push for the superseded initial fen must still be ignored.
      act(() => {
        cb({ callback_id: "analysis-play", fen: INITIAL_FEN, pvs: [] });
      });
      expect(useGameStore.getState().analysis.fen).toBe(LATER_FEN);
      expect(useGameStore.getState().analysis.pvs).toHaveLength(1);
    } finally {
      unmount();
    }
  }, 15000);
});

/**
 * P2-T07: in-flight AI moves are never cancelled.
 *
 * Fail-first contract: makeAiMove promises from commitMove/handleNewGame are
 * untracked (aiLoopRef governs only the AI-vs-AI loop), so superseding the
 * position while the engine thinks lets a late applyMoveResult write the
 * PREVIOUS position over the new one. Both tests drive a DEFERRED engine
 * promise, supersede it, then resolve and assert the store is unchanged by
 * the late result. On pre-fix code the late apply lands and both fail.
 *
 * Guard semantics (cancel-and-undo, not refuse): handleUndo PROCEEDS while
 * engineBusy. The Undo button is already disabled mid-think, and Ctrl+Z has
 * always issued undo from the keyboard — refusing in the handler would
 * remove working UX. The guard is the generation bump: the pending reply is
 * cancelled (its late result is discarded and its stale finally skips
 * clearing busy), and undo takes ownership of the busy flag. Test A asserts
 * undoMove was issued while busy was true.
 *
 * jsdom note: the board never mounts here (the ResizeObserver stub never
 * fires, so boardSize stays 0 and Board is gated off), therefore
 * square-click commitMove is undrivable. Both tests launch the AI via the
 * New Game button (Play as black), which fires the IDENTICAL untracked
 * makeAiMove + .finally(clear) shape the item names at handleNewGame;
 * commitMove's call site gets the same scoped edit by construction
 * (the generation mechanism is caller-agnostic).
 */
const FEN_AFTER_E2E4 =
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const FEN_AFTER_E7E5 =
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function createP2T07Backend() {
  const base = createFakeBackend();
  const newGameCalls: unknown[] = [];
  const aiReplyMoves: string[] = [];
  const undoCalls: unknown[] = [];
  const engineQueue: Array<{
    promise: Promise<{ move: string | null }>;
    resolve: (value: { move: string | null }) => void;
  }> = [];
  base.api.newGame = async (params?: Record<string, unknown>) => {
    newGameCalls.push(params);
    return moveResult(INITIAL_FEN, [], false);
  };
  base.api.makeMove = async (params: { move: string }) => {
    // The black-game human never moves, so the ONLY reply the AI path may
    // legitimately issue is e7e5. Track it separately: any entry here after
    // supersede is the stale-overwrite defect.
    if (params.move === "e7e5") {
      aiReplyMoves.push(params.move);
      return moveResult(FEN_AFTER_E7E5, ["e2e4", "e7e5"], false);
    }
    return moveResult(FEN_AFTER_E2E4, ["e2e4"], false);
  };
  base.api.getEngineMove = async () => {
    const d = deferred<{ move: string | null }>();
    engineQueue.push(d);
    return d.promise;
  };
  base.api.getLegalMoves = async () => ({
    moves: [{ uci: "e7e5" }, { uci: "e2e4" }, { uci: "g1f3" }],
  });
  base.api.undoMove = async () => {
    undoCalls.push("undo");
    return moveResult(INITIAL_FEN, [], false);
  };
  return { api: base.api, newGameCalls, aiReplyMoves, undoCalls, engineQueue };
}

function resetStoresHumanVsAi(): void {
  useGameStore.getState().resetGame();
  useGameStore.setState({
    mode: "human_vs_ai",
    humanColor: "white",
    flipped: false,
    engineBusy: false,
    toasts: [],
  });
  useSettingsStore.setState({
    loaded: true, // post-load state: the mount game starts immediately
    useOpeningBook: false, // force the deferred engine path, not the book path
    openingBookDepth: 20,
    showEvalBar: false,
    soundEnabled: false,
    autoSaveGameHistory: false,
    playEngine: "stockfish",
    botStrength: 5,
    thinkProfile: "rapid",
    timeControl: { seconds: 0, increment: 0, label: "Unlimited" },
  });
}

describe("P2-T07 in-flight AI cancellation", () => {
  it("undo-while-thinking cancels the pending reply: late result discarded, undo issued", async () => {
    const backend = createP2T07Backend();
    window.electronAPI = backend.api as unknown as Window["electronAPI"];
    resetStoresHumanVsAi();
    const rendered = render(<PlayView onTabChange={() => undefined} />);
    try {
      await waitFor(
        () => {
          expect(backend.newGameCalls.length).toBe(1);
        },
        { timeout: 4000, interval: 50 },
      );
      // Launch the deferred AI reply via New Game (Play as black: white AI moves first).
      const selects = rendered.container.querySelectorAll("select");
      expect(selects.length).toBeGreaterThanOrEqual(2);
      const colorSelect = selects[1];
      if (!colorSelect) throw new Error("Play-as select not rendered");
      fireEvent.change(colorSelect, { target: { value: "black" } });
      fireEvent.click(rendered.getByRole("button", { name: "New Game" }));
      await waitFor(
        () => {
          expect(backend.newGameCalls.length).toBe(2);
          expect(backend.engineQueue.length).toBe(1);
          expect(useGameStore.getState().engineBusy).toBe(true);
        },
        { timeout: 4000, interval: 50 },
      );
      expect(useGameStore.getState().fen).toBe(INITIAL_FEN);

      // Ctrl+Z while busy: cancel-and-undo issues undoMove DESPITE busy.
      expect(useGameStore.getState().engineBusy).toBe(true);
      fireEvent.keyDown(document, { key: "z", ctrlKey: true });
      await waitFor(
        () => {
          expect(backend.undoCalls.length).toBe(1);
        },
        { timeout: 4000, interval: 50 },
      );
      expect(useGameStore.getState().fen).toBe(INITIAL_FEN);
      expect(useGameStore.getState().fullMoveHistoryUCI).toEqual([]);
      expect(useGameStore.getState().engineBusy).toBe(false);

      // Resolve the superseded reply: stale means neither apply nor throw.
      const staleReply = backend.engineQueue[0];
      if (!staleReply) throw new Error("deferred engine reply missing");
      await act(async () => {
        staleReply.resolve({ move: "e7e5" });
        await sleep(100);
      });
      expect(backend.aiReplyMoves).toEqual([]);
      expect(useGameStore.getState().fen).toBe(INITIAL_FEN);
      expect(useGameStore.getState().fullMoveHistoryUCI).toEqual([]);
      expect(useGameStore.getState().engineBusy).toBe(false);
    } finally {
      rendered.unmount();
    }
  }, 15000);

  it("stale AI completion neither applies nor clears the new game busy flag", async () => {
    const backend = createP2T07Backend();
    window.electronAPI = backend.api as unknown as Window["electronAPI"];
    resetStoresHumanVsAi();
    const rendered = render(<PlayView onTabChange={() => undefined} />);
    try {
      await waitFor(
        () => {
          expect(backend.newGameCalls.length).toBe(1);
        },
        { timeout: 4000, interval: 50 },
      );
      const selects = rendered.container.querySelectorAll("select");
      expect(selects.length).toBeGreaterThanOrEqual(2);
      const colorSelect = selects[1];
      if (!colorSelect) throw new Error("Play-as select not rendered");
      fireEvent.change(colorSelect, { target: { value: "black" } });
      fireEvent.click(rendered.getByRole("button", { name: "New Game" }));
      await waitFor(
        () => {
          expect(backend.newGameCalls.length).toBe(2);
          expect(backend.engineQueue.length).toBe(1);
          expect(useGameStore.getState().engineBusy).toBe(true);
        },
        { timeout: 4000, interval: 50 },
      );

      // Supersede with a second black game: AI#2 now owns busy under the new generation.
      fireEvent.click(rendered.getByRole("button", { name: "New Game" }));
      await waitFor(
        () => {
          expect(backend.newGameCalls.length).toBe(3);
          expect(backend.engineQueue.length).toBe(2);
          expect(useGameStore.getState().engineBusy).toBe(true);
        },
        { timeout: 4000, interval: 50 },
      );

      // Resolve the STALE first reply: discarded, and the new flag survives.
      const staleReply = backend.engineQueue[0];
      if (!staleReply) throw new Error("deferred engine reply missing");
      await act(async () => {
        staleReply.resolve({ move: "e7e5" });
        await sleep(100);
      });
      expect(backend.aiReplyMoves).toEqual([]);
      expect(useGameStore.getState().fen).toBe(INITIAL_FEN);
      expect(useGameStore.getState().fullMoveHistoryUCI).toEqual([]);
      expect(useGameStore.getState().engineBusy).toBe(true);
    } finally {
      rendered.unmount();
    }
  }, 15000);
});

/**
 * P2-T13: capture sound fires on nearly every move.
 *
 * Fail-first contract: commitMove computes
 * `oldBoard.replace(/[PNBRQK]/g,'') !== newBoard.replace(/[pnbrqk]/g,'')` —
 * white pieces stripped from the old board, black pieces stripped from the
 * new one — two non-comparable strings that differ on almost any move, so
 * Sound.capture fires even for a quiet developing move. All three tests
 * below drive commitMove through real square clicks on the mounted Board
 * (human_vs_human, so no AI reply interferes) with Sound.move/capture
 * spied (no-op implementations — the real ones need AudioContext, which
 * jsdom lacks). The quiet-move and promotion silence assertions FAIL on
 * the pre-fix code; the real-capture assertion guards against
 * over-silencing (it passes both before and after).
 */
const E2E4_NEW_FEN =
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const E4D5_OLD_FEN =
  "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const E4D5_NEW_FEN =
  "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
const PROMO_OLD_FEN = "k7/4P3/8/8/8/8/8/4K3 w - - 0 1";
const PROMO_NEW_FEN = "k3Q3/8/8/8/8/8/8/4K3 b - - 0 1";

interface BoardGameHarness {
  rendered: { container: HTMLElement; unmount: () => void };
  moveSpy: { mockRestore: () => void };
  captureSpy: { mockRestore: () => void };
  cleanup: () => void;
}

async function renderBoardGame(opts: {
  oldFen: string;
  newFen: string;
  newHistory: string[];
  legalMoves: string[];
  autoQueen?: boolean;
}): Promise<BoardGameHarness> {
  const backend = createFakeBackend();
  let newGameDone = false;
  backend.api.newGame = async () => {
    const r = moveResult(INITIAL_FEN, [], false);
    newGameDone = true;
    return r;
  };
  backend.api.makeMove = async () =>
    moveResult(opts.newFen, opts.newHistory, false);
  window.electronAPI = backend.api as unknown as Window["electronAPI"];

  useGameStore.getState().resetGame();
  useGameStore.setState({
    mode: "human_vs_human",
    humanColor: "white",
    flipped: false,
    engineBusy: false,
    toasts: [],
  });
  useSettingsStore.setState({
    loaded: true,
    useOpeningBook: false,
    showEvalBar: false,
    soundEnabled: true,
    autoSaveGameHistory: false,
    autoQueen: opts.autoQueen ?? false,
    playEngine: "stockfish",
    botStrength: 5,
    thinkProfile: "rapid",
    timeControl: { seconds: 0, increment: 0, label: "Unlimited" },
  });

  const moveSpy = vi.spyOn(Sound, "move").mockImplementation(() => undefined);
  const captureSpy = vi
    .spyOn(Sound, "capture")
    .mockImplementation(() => undefined);
  const rendered = render(<PlayView onTabChange={() => undefined} />);
  // Mount effect starts a game async; wait until it settles so the preset
  // below cannot be clobbered by its resetGame.
  await waitFor(
    () => {
      expect(newGameDone).toBe(true);
    },
    { timeout: 4000, interval: 50 },
  );
  act(() => {
    useGameStore.setState({
      fen: opts.oldFen,
      turn: "white",
      legalMoves: opts.legalMoves,
    });
  });
  return {
    rendered,
    moveSpy,
    captureSpy,
    cleanup: () => {
      moveSpy.mockRestore();
      captureSpy.mockRestore();
      rendered.unmount();
    },
  };
}

function clickSquare(container: HTMLElement, sq: string): void {
  const el = container.querySelector(`[data-sq="${sq}"]`);
  if (!el) throw new Error(`square ${sq} not rendered (Board missing?)`);
  fireEvent.click(el);
}

describe("P2-T13 capture-sound condition", () => {
  it("quiet developing move e2e4: move sound yes, capture sound NO", async () => {
    const h = await renderBoardGame({
      oldFen: INITIAL_FEN,
      newFen: E2E4_NEW_FEN,
      newHistory: ["e2e4"],
      legalMoves: ["e2e4"],
    });
    try {
      clickSquare(h.rendered.container, "e2");
      clickSquare(h.rendered.container, "e4");
      await waitFor(
        () => {
          expect(h.moveSpy).toHaveBeenCalledTimes(1);
        },
        { timeout: 4000, interval: 50 },
      );
      // The buggy strip-compare reports a capture here (white-stripped old
      // vs black-stripped new always differ) — this line fails pre-fix.
      expect(h.captureSpy).not.toHaveBeenCalled();
      expect(useGameStore.getState().fen).toBe(E2E4_NEW_FEN);
    } finally {
      h.cleanup();
    }
  }, 15000);

  it("real capture e4d5: capture sound yes", async () => {
    const h = await renderBoardGame({
      oldFen: E4D5_OLD_FEN,
      newFen: E4D5_NEW_FEN,
      newHistory: ["e4d5"],
      legalMoves: ["e4d5"],
    });
    try {
      clickSquare(h.rendered.container, "e4");
      clickSquare(h.rendered.container, "d5");
      await waitFor(
        () => {
          expect(h.moveSpy).toHaveBeenCalledTimes(1);
        },
        { timeout: 4000, interval: 50 },
      );
      expect(h.captureSpy).toHaveBeenCalledTimes(1);
      expect(useGameStore.getState().fen).toBe(E4D5_NEW_FEN);
    } finally {
      h.cleanup();
    }
  }, 15000);

  it("promotion without capture e7e8: move sound yes, capture sound NO", async () => {
    const h = await renderBoardGame({
      oldFen: PROMO_OLD_FEN,
      newFen: PROMO_NEW_FEN,
      newHistory: ["e7e8q"],
      legalMoves: ["e7e8q"],
      autoQueen: true,
    });
    try {
      clickSquare(h.rendered.container, "e7");
      clickSquare(h.rendered.container, "e8");
      await waitFor(
        () => {
          expect(h.moveSpy).toHaveBeenCalledTimes(1);
        },
        { timeout: 4000, interval: 50 },
      );
      // Pawn becomes queen: total piece count unchanged, so no capture.
      // The buggy strip-compare fires here too — fails pre-fix.
      expect(h.captureSpy).not.toHaveBeenCalled();
      expect(useGameStore.getState().fen).toBe(PROMO_NEW_FEN);
    } finally {
      h.cleanup();
    }
  }, 15000);
});
