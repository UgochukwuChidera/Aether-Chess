/**
 * settingsStore.ts — Persistent settings (synced to userData/settings.json).
 */
import { create } from 'zustand';
import type { BoardStyle, PieceSet } from '../config/pieceConfig';

// Re-export so other files can keep a single import point.
export type { BoardStyle, PieceSet } from '../config/pieceConfig';

export type Theme = 'dark' | 'light' | 'high-contrast';
export type PlayEngine = 'mentor' | 'stockfish' | 'maia3';

// ── Memory/engine hard limits ────────────────────────────────────────────────
/** Maximum transposition-table size that can be saved through the settings. */
export const MAX_HASH_MB = 2048;
/** Maximum CPU-thread count that can be saved through the settings. */
export const MAX_THREADS = 64;
/** Maximum number of principal-variation lines. */
export const MAX_MULTIPV = 5;
export type AnimationSpeed = 'slow' | 'normal' | 'fast' | 'off';
export type TimeControl = {
  seconds: number;
  increment: number;
  label: string;
};

export const TIME_CONTROLS: TimeControl[] = [
  { seconds: 180, increment: 2,  label: 'Blitz 3|2' },
  { seconds: 600, increment: 0,  label: 'Rapid 10|0' },
  { seconds: 1800,increment: 20, label: 'Classical 30|20' },
  { seconds: 0,   increment: 0,  label: 'Unlimited' },
];

export interface AppSettings {
  // Appearance
  theme: Theme;
  boardStyle: BoardStyle;
  pieceSet: PieceSet;
  animationSpeed: AnimationSpeed;
  // Engine
  playEngine: PlayEngine;
  stockfishPath: string;
  maia3Path: string;
  maia3Model: string;
  maia3Device: 'cpu' | 'cuda';
  maia3Elo: number;
  thinkProfile: string;
  threads: number;
  hashMb: number;
  multipv: number;
  botStrength: number;
  // Custom Eval
  useMentorEval: boolean;
  // Opening Book
  useOpeningBook: boolean;
  openingBookPath: string;
  openingBookDepth: number; // plies to use book (e.g., 10 = 5 moves each side)
  // Gameplay
  timeControl: TimeControl;
  autoQueen: boolean;
  showEvalBar: boolean;
  showArrowsBeforeMove: boolean;
  soundEnabled: boolean;
  soundVolume: number;
  // Analysis
  showAnalysisThreats: boolean;
  showAnalysisTopMoves: boolean;
  showAnalysisTopAlternatives: boolean;
  // Data
  clearHistoryOnNewGame: boolean;
  autoSaveGameHistory: boolean;
}

interface SettingsStore extends AppSettings {
  loaded: boolean;
  update: (patch: Partial<AppSettings>) => void;
  loadFromBackend: () => Promise<void>;
  saveToBackend: () => Promise<void>;
}

const DEFAULTS: AppSettings = {
  theme: 'dark',
  boardStyle: 'classic',
  pieceSet: 'material',
  animationSpeed: 'normal',
  playEngine: 'stockfish',
  stockfishPath: 'stockfish',
  maia3Path: '',
  maia3Model: 'maia3-5m',
  maia3Device: 'cpu',
  maia3Elo: 1500,
  thinkProfile: 'human_like',
  threads: 1,
  hashMb: 128,  // Lower default to avoid allocation failures
  multipv: 3,
  botStrength: 7,
  useMentorEval: true,
  useOpeningBook: true,
  openingBookPath: 'resources/books',
  openingBookDepth: 20, // default to 20 plies (10 moves each side)
  timeControl: TIME_CONTROLS[3], // Unlimited
  autoQueen: false,
  showEvalBar: true,
  showArrowsBeforeMove: true,
  soundEnabled: true,
  soundVolume: 0.7,
  showAnalysisThreats: true,
  showAnalysisTopMoves: true,
  showAnalysisTopAlternatives: true,
  clearHistoryOnNewGame: false,
  autoSaveGameHistory: true,
};

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...DEFAULTS,
  loaded: false,

  update: (patch) => {
    // Clamp memory/engine settings to safe ranges before persisting.
    const safe: Partial<AppSettings> = { ...patch };
    if (safe.hashMb   !== undefined) safe.hashMb   = Math.max(16,  Math.min(MAX_HASH_MB, Math.round(safe.hashMb)));
    if (safe.threads  !== undefined) safe.threads  = Math.max(1,   Math.min(MAX_THREADS, Math.round(safe.threads)));
    if (safe.multipv  !== undefined) safe.multipv  = Math.max(1,   Math.min(MAX_MULTIPV, Math.round(safe.multipv)));
    if (safe.soundVolume !== undefined) safe.soundVolume = Math.max(0, Math.min(1, safe.soundVolume));
    set(safe);
    get().saveToBackend();
  },

  loadFromBackend: async () => {
    try {
      const saved = window.electronAPI
        ? await window.electronAPI.loadSettings()
        : null;
      if (saved) {
        set({ ...(saved as Partial<AppSettings>), loaded: true });
      } else {
        set({ loaded: true });
      }
    } catch {
      set({ loaded: true });
    }
  },

  saveToBackend: async () => {
    const { loaded: _l, update: _u, loadFromBackend: _lf, saveToBackend: _sb, ...data } = get();
    try {
      if (window.electronAPI) {
        await window.electronAPI.saveSettings(data);
      }
    } catch {
      /* silent */
    }
  },
}));
