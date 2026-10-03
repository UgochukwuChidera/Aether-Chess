/**
 * gameStore.ts — Central Zustand store for all live game state.
 */
import { create } from "zustand";

export type Color = "white" | "black";
export type GameMode = "human_vs_ai" | "human_vs_human" | "ai_vs_ai";
export type EngineType = "stockfish" | "mentor";

export interface MoveEntry {
  uci: string;
  san: string;
  color: Color;
  cp_loss?: number;
  classification?: string;
}

export interface PVLine {
  depth: number;
  score_cp: number;
  mate: number | null;
  pv: string[];
  pv_san: string[];
}

export interface AnalysisData {
  pvs: PVLine[];
  fen: string;
  running: boolean;
  mentorEval?: { eval_cp?: number; phase?: number };
}

export type GameResult = "white_wins" | "black_wins" | "draw" | null;

/**
 * P3-T01: backend-owned clock, mirrored as received. Milliseconds remaining
 * per side plus the increment. Null when Unlimited (or when the producer —
 * old backend, e2e fixture, unit mocks — omits the key).
 */
export interface ClockState {
  white_ms: number;
  black_ms: number;
  increment_ms: number;
}

export interface Toast {
  id: string;
  message: string;
  type: "info" | "error" | "success" | "warning";
}

export interface GameState {
  // Board
  fen: string;
  turn: Color;
  legalMoves: string[]; // UCI
  selectedSquare: string | null;
  highlightedSquares: string[]; // legal move targets
  lastMoveFrom: string | null;
  lastMoveTo: string | null;
  flipped: boolean;

  // History
  moveHistory: MoveEntry[]; // ordered list of all moves
  navIndex: number; // -1 = current position
  fullMoveHistoryUCI: string[]; // raw UCI for navigation

  // Game metadata
  mode: GameMode;
  engineType: EngineType;
  humanColor: Color;
  strength: number;
  gameResult: GameResult;
  termination: string | null;
  inCheck: boolean;

  // P3-T01: backend clock mirror. Set from every IPC snapshot and every
  // clock_tick push; never computed locally (no client-side timer remains).
  clock: ClockState | null;

  // Analysis
  analysis: AnalysisData;

  // Promotion
  pendingPromotion: { from: string; to: string } | null;

  // UI
  toasts: Toast[];
  engineBusy: boolean;

  // Actions
  setFen: (fen: string) => void;
  applyMoveResult: (result: BackendMoveResult) => void;
  applyClockTick: (tick: BackendMoveResult) => void;
  selectSquare: (sq: string | null) => void;
  setLegalMoves: (moves: string[]) => void;
  flipBoard: () => void;
  setFlipped: (flipped: boolean) => void;
  setPendingPromotion: (promo: { from: string; to: string } | null) => void;
  setAnalysis: (data: Partial<AnalysisData>) => void;
  fetchMentorEval: (fen: string) => Promise<void>;
  pushToast: (message: string, type?: Toast["type"]) => void;
  dismissToast: (id: string) => void;
  setEngineBusy: (busy: boolean) => void;
  applyAccuracyResults: (rows: AccuracyMoveResult[]) => void;
  setMode: (mode: GameMode) => void;
  setHumanColor: (color: Color) => void;
  setGameResult: (result: GameResult, termination?: string | null) => void;
  resetGame: () => void;
}

export interface BackendMoveResult {
  fen: string;
  turn: Color;
  legal_moves: string[];
  move_history: string[]; // SAN list
  full_move_history: string[]; // UCI list
  // Per-move mover ('white'/'black'), parallel to move_history.
  // Present on new backends; absent on old ones and the e2e fixture.
  move_colors?: Color[];
  last_move_san: string;
  last_move_uci: string | null;
  nav_index: number;
  game_over: boolean;
  result: string | null;
  termination: string | null;
  in_check: boolean;
  // P3-T01: present on new backends; absent on old ones, the e2e fixture and
  // unit mocks — always read via `?? null`, never assumed.
  clock?: ClockState | null;
}

export interface AccuracyMoveResult {
  uci: string;
  cp_loss: number;
  classification: string;
}

function parseResult(r: string | null): GameResult {
  if (!r) return null;
  if (r === "1-0") return "white_wins";
  if (r === "0-1") return "black_wins";
  return "draw";
}

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const useGameStore = create<GameState>((set, get) => ({
  fen: INITIAL_FEN,
  turn: "white",
  legalMoves: [],
  selectedSquare: null,
  highlightedSquares: [],
  lastMoveFrom: null,
  lastMoveTo: null,
  flipped: false,
  moveHistory: [],
  navIndex: -1,
  fullMoveHistoryUCI: [],
  mode: "human_vs_ai",
  engineType: "stockfish",
  humanColor: "white",
  strength: 7,
  gameResult: null,
  termination: null,
  inCheck: false,
  clock: null,
  analysis: { pvs: [], fen: INITIAL_FEN, running: false },
  pendingPromotion: null,
  toasts: [],
  engineBusy: false,

  setFen: (fen) => set({ fen }),

  applyMoveResult: (result) => {
    // P2-T09: prefer the backend-fed per-move colour (correct for games that
    // did not open with White to move); fall back to index parity for old
    // backends and producers that omit move_colors (P0-T12 fixture, P1-T01
    // mocks) — never assume the fallback, it mislabels black-open games.
    const history: MoveEntry[] = result.move_history.map((san, i) => ({
      uci: result.full_move_history[i] ?? "",
      san,
      color: result.move_colors?.[i] ?? (i % 2 === 0 ? "white" : "black"),
    }));

    const lastUCI = result.last_move_uci;
    set({
      fen: result.fen,
      turn: result.turn,
      legalMoves: result.legal_moves,
      moveHistory: history,
      fullMoveHistoryUCI: result.full_move_history,
      navIndex: result.nav_index,
      gameResult: parseResult(result.result),
      termination: result.termination,
      inCheck: result.in_check,
      clock: result.clock ?? null,
      lastMoveFrom: lastUCI ? lastUCI.slice(0, 2) : null,
      lastMoveTo: lastUCI ? lastUCI.slice(2, 4) : null,
      selectedSquare: null,
      highlightedSquares: [],
      pendingPromotion: null,
    });
  },

  applyClockTick: (tick) => {
    // P3-T01: 1 Hz backend push. Selection, highlights and pending
    // promotions survive a tick — unlike applyMoveResult, which resets them
    // because a move genuinely changed the position. A tick never moves.
    // Terminal state only ever advances towards over (a stale in-flight move
    // response must not resurrect a flagged game either — callers guard that
    // path; here the backend push IS the newest truth, so apply it whole).
    set({
      clock: tick.clock ?? null,
      gameResult: parseResult(tick.result),
      termination: tick.termination,
    });
  },

  selectSquare: (sq) => {
    const state = get();
    if (!sq) {
      set({ selectedSquare: null, highlightedSquares: [] });
      return;
    }
    // Find legal move targets from this square
    const targets = state.legalMoves
      .filter((uci) => uci.startsWith(sq))
      .map((uci) => uci.slice(2, 4));
    set({ selectedSquare: sq, highlightedSquares: targets });
  },

  setLegalMoves: (moves) => set({ legalMoves: moves }),
  flipBoard: () => set((s) => ({ flipped: !s.flipped })),
  setFlipped: (flipped: boolean) => set({ flipped }),
  setPendingPromotion: (promo) => set({ pendingPromotion: promo }),
  setAnalysis: (data) => set((s) => ({ analysis: { ...s.analysis, ...data } })),

  fetchMentorEval: async (fen) => {
    try {
      const result = await window.electronAPI.getEval({
        fen,
        use_mentor_eval: true,
      });
      const data = result as {
        eval_cp?: number;
        phase?: number;
      };
      if (data.eval_cp !== undefined) {
        set((s) => ({ analysis: { ...s.analysis, mentorEval: data } }));
      }
    } catch {
      /* ignore */
    }
  },

  pushToast: (message, type = "info") => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => get().dismissToast(id), 4000);
  },

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setEngineBusy: (busy) => set({ engineBusy: busy }),

  setMode: (mode) => set({ mode }),
  setHumanColor: (color) => set({ humanColor: color }),

  applyAccuracyResults: (rows) =>
    set((s) => {
      const rowOccurrence = new Map<string, number>();
      const byUci = new Map(
        rows.map((r) => {
          const n = rowOccurrence.get(r.uci) ?? 0;
          rowOccurrence.set(r.uci, n + 1);
          return [`${r.uci}:${n}`, r] as const;
        }),
      );
      const occurrence = new Map<string, number>();
      const moveHistory = s.moveHistory.map((m) => {
        const seen = occurrence.get(m.uci) ?? 0;
        occurrence.set(m.uci, seen + 1);
        const row = byUci.get(`${m.uci}:${seen}`);
        if (!row) return m;
        return {
          ...m,
          cp_loss: row.cp_loss,
          classification: row.classification,
        };
      });
      return { moveHistory };
    }),

  setGameResult: (result, termination = null) =>
    set({ gameResult: result, termination }),

  resetGame: () =>
    set({
      fen: INITIAL_FEN,
      turn: "white",
      legalMoves: [],
      selectedSquare: null,
      highlightedSquares: [],
      lastMoveFrom: null,
      lastMoveTo: null,
      moveHistory: [],
      navIndex: -1,
      fullMoveHistoryUCI: [],
      gameResult: null,
      termination: null,
      inCheck: false,
      clock: null,
      analysis: { pvs: [], fen: INITIAL_FEN, running: false },
      pendingPromotion: null,
    }),
}));
