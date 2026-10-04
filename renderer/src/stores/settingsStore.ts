/**
 * settingsStore.ts — Persistent settings (synced to userData/settings.json).
 *
 * P3-T02: one settings schema. The backend (`backend/settings_schema.py`,
 * served via the `settings_defaults` command) is the single authority for
 * engine/memory limits. This store fetches those limits at boot and
 * validates EVERYTHING through the same clamps — `loadFromBackend` no
 * longer shallow-merges persisted junk unchecked — with a static fallback
 * so the app still starts when the backend is unreachable.
 */
import { create } from 'zustand';
import type { BoardStyle, PieceSet } from '../config/pieceConfig';

// Re-export so other files can keep a single import point.
export type { BoardStyle, PieceSet } from '../config/pieceConfig';

export type Theme = 'dark' | 'light' | 'high-contrast';
/**
 * The id of the bot that plays the opponent side, e.g. "mentor", "maia3",
 * "stockfish", or a discovered build such as "stockfish-19".
 *
 * This is a bot id rather than a closed union because the list of bots comes
 * from the backend at runtime, so a newly discovered Stockfish build or a new
 * bot becomes selectable without a frontend change. "mentor", "stockfish" and
 * "maia3" remain the built-in ids.
 */
export type PlayEngine = string;

/**
 * A readable label for a bot id, e.g. "stockfish-19" -> "Stockfish 19".
 *
 * Deriving the name from the id rather than matching a known list means a
 * discovered build is labelled correctly, and an unrecognised id is shown as
 * itself instead of being mislabelled as a different engine.
 */
export function botDisplayName(botId: string): string {
  if (!botId) return 'Unknown';
  return botId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ── Canonical engine limits ────────────────────────────────────────────────
// AUTHORITY: backend/settings_schema.py via the `settings_defaults`
// command (max 8 threads / 512 MB / 5 lines — the setoption safety caps).
// FALLBACK_LIMITS mirrors it for boot when the backend is unreachable
// (no `getSettingsDefaults` channel yet, or the call rejects); the backend
// remains the authority whenever reachable. If the caps ever change, update
// both here and there.
export interface SettingsLimits {
  maxThreads: number;
  maxHashMb: number;
  maxMultipv: number;
}

const FALLBACK_LIMITS: SettingsLimits = {
  maxThreads: 8,
  maxHashMb: 512,
  maxMultipv: 5,
};

/** Persisted-schema version. Mirrors settings_schema.SCHEMA_VERSION. */
const FALLBACK_SCHEMA_VERSION = 1;

/** Trailing-edge debounce for slider-driven saves (ms). */
const SAVE_DEBOUNCE_MS = 500;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
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
  /** Engine caps from the backend (or the static fallback). */
  limits: SettingsLimits;
  /** Persisted-schema version (migration stamp). */
  schemaVersion: number;
  /** Last save failure message, if any — never silently swallowed. */
  saveError: string | null;
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
  limits: { ...FALLBACK_LIMITS },
  schemaVersion: FALLBACK_SCHEMA_VERSION,
  saveError: null,

  update: (patch) => {
    // Clamp through the canonical limits before persisting.
    const safe = validatePatch(patch as Record<string, unknown>, get().limits);
    set(safe);
    // Trailing-edge debounce: slider ticks coalesce into one save with the
    // latest values. The timer is module-scoped (single store); a direct
    // saveToBackend() clears it so no save is ever duplicated or lost.
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      // Surface via saveError state (set inside); never an unhandled rejection.
      void get()
        .saveToBackend()
        .catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
  },

  loadFromBackend: async () => {
    // 1. Limits from the backend when the channel exists, static fallback
    // otherwise — boot must never block on the backend. (The channel is
    // optional until the IPC surface is wired; see P3-T03.)
    let limits: SettingsLimits = { ...FALLBACK_LIMITS };
    let schemaVersion = FALLBACK_SCHEMA_VERSION;
    try {
      const api = window.electronAPI as unknown as
        | { getSettingsDefaults?: () => Promise<BackendSettingsDefaults> }
        | undefined;
      const info = await api?.getSettingsDefaults?.();
      if (info && typeof info === 'object' && info.limits && typeof info.limits === 'object') {
        limits = {
          maxThreads: toPositiveInt(info.limits.max_threads, FALLBACK_LIMITS.maxThreads),
          maxHashMb: toPositiveInt(info.limits.max_hash_mb, FALLBACK_LIMITS.maxHashMb),
          maxMultipv: toPositiveInt(info.limits.max_multipv, FALLBACK_LIMITS.maxMultipv),
        };
      }
      if (typeof info?.schemaVersion === 'number' && Number.isFinite(info.schemaVersion)) {
        schemaVersion = Math.round(info.schemaVersion);
      }
    } catch {
      /* unreachable backend — fallback covers boot */
    }
    // 2. Persisted settings through the SAME validation as update, so a
    // hand-edited settings.json with threads:99999 can never reach the
    // engine's setoption. Unknown keys are preserved (forward-compatible).
    try {
      const saved = window.electronAPI
        ? await window.electronAPI.loadSettings()
        : null;
      if (saved && typeof saved === 'object') {
        const raw = saved as Record<string, unknown>;
        const validated = validatePatch(raw, limits);
        // A newer file keeps its stamp (never re-migrate a future version).
        const savedVer = toPositiveInt(raw.schemaVersion, 0);
        set({
          ...(validated as Partial<AppSettings>),
          limits,
          schemaVersion: savedVer > schemaVersion ? savedVer : schemaVersion,
          loaded: true,
        });
      } else {
        set({ limits, schemaVersion, loaded: true });
      }
    } catch {
      set({ limits, schemaVersion, loaded: true });
    }
  },

  saveToBackend: async () => {
    // A pending debounced save is subsumed by this immediate one — clear it
    // so the same state is never written twice.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const {
      loaded: _l,
      update: _u,
      loadFromBackend: _lf,
      saveToBackend: _sb,
      limits: _lim,
      saveError: _e,
      ...data
    } = get();
    try {
      if (window.electronAPI) {
        await window.electronAPI.saveSettings(data);
      }
      set({ saveError: null });
    } catch (err) {
      // Failures surface: in state for the UI, and to the caller.
      const message = err instanceof Error ? err.message : String(err);
      set({ saveError: message });
      throw err;
    }
  },
}));

// ── Validation (shared by update and loadFromBackend) ──────────────────────

function toClampedInt(value: unknown, min: number, max: number, fallback: number): number {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value);
  } else {
    return fallback;
  }
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? (n as number) : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function toTimeControl(value: unknown): TimeControl {
  if (!value || typeof value !== 'object') return TIME_CONTROLS[3];
  const raw = value as Record<string, unknown>;
  const seconds = toClampedInt(raw.seconds, 0, 86400, 0);
  const increment = toClampedInt(raw.increment, 0, 3600, 0);
  const label = typeof raw.label === 'string' && raw.label ? raw.label : 'Custom';
  return { seconds, increment, label };
}

/**
 * Validate a partial settings object through the canonical clamps.
 * Unknown keys pass through untouched (preserve-forward: a newer version's
 * keys must survive a round-trip through this version).
 */
function validatePatch(
  patch: Record<string, unknown>,
  lim: SettingsLimits,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch };
  if ('theme' in patch) {
    out.theme = oneOf(patch.theme, ['dark', 'light', 'high-contrast'] as const, 'dark');
  }
  if ('boardStyle' in patch) {
    out.boardStyle = typeof patch.boardStyle === 'string' ? patch.boardStyle : 'classic';
  }
  if ('pieceSet' in patch) {
    out.pieceSet = typeof patch.pieceSet === 'string' ? patch.pieceSet : 'material';
  }
  if ('animationSpeed' in patch) {
    out.animationSpeed = oneOf(
      patch.animationSpeed,
      ['slow', 'normal', 'fast', 'off'] as const,
      'normal',
    );
  }
  if ('playEngine' in patch) {
    out.playEngine =
      typeof patch.playEngine === 'string' && patch.playEngine ? patch.playEngine : 'stockfish';
  }
  if ('stockfishPath' in patch) {
    out.stockfishPath =
      typeof patch.stockfishPath === 'string' && patch.stockfishPath.trim()
        ? patch.stockfishPath
        : 'stockfish';
  }
  if ('maia3Path' in patch) {
    out.maia3Path = typeof patch.maia3Path === 'string' ? patch.maia3Path : '';
  }
  if ('maia3Model' in patch) {
    out.maia3Model = typeof patch.maia3Model === 'string' ? patch.maia3Model : 'maia3-5m';
  }
  if ('maia3Device' in patch) {
    out.maia3Device = oneOf(patch.maia3Device, ['cpu', 'cuda'] as const, 'cpu');
  }
  if ('maia3Elo' in patch) out.maia3Elo = toClampedInt(patch.maia3Elo, 0, 5000, 1500);
  if ('thinkProfile' in patch) {
    out.thinkProfile = typeof patch.thinkProfile === 'string' ? patch.thinkProfile : 'human_like';
  }
  if ('threads' in patch) out.threads = toClampedInt(patch.threads, 1, lim.maxThreads, 1);
  if ('hashMb' in patch) out.hashMb = toClampedInt(patch.hashMb, 16, lim.maxHashMb, 128);
  if ('multipv' in patch) out.multipv = toClampedInt(patch.multipv, 1, lim.maxMultipv, 3);
  if ('botStrength' in patch) out.botStrength = toClampedInt(patch.botStrength, 1, 20, 7);
  if ('useMentorEval' in patch) {
    out.useMentorEval = typeof patch.useMentorEval === 'boolean' ? patch.useMentorEval : true;
  }
  if ('useOpeningBook' in patch) {
    out.useOpeningBook = typeof patch.useOpeningBook === 'boolean' ? patch.useOpeningBook : true;
  }
  if ('openingBookPath' in patch) {
    out.openingBookPath =
      typeof patch.openingBookPath === 'string' ? patch.openingBookPath : 'resources/books';
  }
  if ('openingBookDepth' in patch) {
    out.openingBookDepth = toClampedInt(patch.openingBookDepth, 0, 200, 20);
  }
  if ('timeControl' in patch) out.timeControl = toTimeControl(patch.timeControl);
  if ('autoQueen' in patch) {
    out.autoQueen = typeof patch.autoQueen === 'boolean' ? patch.autoQueen : false;
  }
  if ('showEvalBar' in patch) {
    out.showEvalBar = typeof patch.showEvalBar === 'boolean' ? patch.showEvalBar : true;
  }
  if ('showArrowsBeforeMove' in patch) {
    out.showArrowsBeforeMove =
      typeof patch.showArrowsBeforeMove === 'boolean' ? patch.showArrowsBeforeMove : true;
  }
  if ('soundEnabled' in patch) {
    out.soundEnabled = typeof patch.soundEnabled === 'boolean' ? patch.soundEnabled : true;
  }
  if ('soundVolume' in patch) {
    out.soundVolume = Math.max(0, Math.min(1, toFiniteNumber(patch.soundVolume, 0.7)));
  }
  if ('showAnalysisThreats' in patch) {
    out.showAnalysisThreats =
      typeof patch.showAnalysisThreats === 'boolean' ? patch.showAnalysisThreats : true;
  }
  if ('showAnalysisTopMoves' in patch) {
    out.showAnalysisTopMoves =
      typeof patch.showAnalysisTopMoves === 'boolean' ? patch.showAnalysisTopMoves : true;
  }
  if ('showAnalysisTopAlternatives' in patch) {
    out.showAnalysisTopAlternatives =
      typeof patch.showAnalysisTopAlternatives === 'boolean'
        ? patch.showAnalysisTopAlternatives
        : true;
  }
  if ('clearHistoryOnNewGame' in patch) {
    out.clearHistoryOnNewGame =
      typeof patch.clearHistoryOnNewGame === 'boolean' ? patch.clearHistoryOnNewGame : false;
  }
  if ('autoSaveGameHistory' in patch) {
    out.autoSaveGameHistory =
      typeof patch.autoSaveGameHistory === 'boolean' ? patch.autoSaveGameHistory : true;
  }
  return out;
}

// Shape served by the backend `settings_defaults` command (snake_case).
interface BackendSettingsDefaults {
  schemaVersion?: unknown;
  limits?: {
    max_threads?: unknown;
    max_hash_mb?: unknown;
    max_multipv?: unknown;
  } | null;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && (n as number) > 0 ? Math.round(n as number) : fallback;
}
