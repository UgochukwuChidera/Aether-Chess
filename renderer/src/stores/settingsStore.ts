/**
 * settingsStore.ts — Persistent settings (synced to userData/settings.json).
 */
import { create } from 'zustand';

export type Theme = 'dark' | 'light' | 'high-contrast';
export type BoardStyle = 'classic' | 'wood' | 'marble' | 'neon';
export type PieceSet = 'material' | 'alpha';
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
  stockfishPath: string;
  threads: number;
  hashMb: number;
  multipv: number;
  botStrength: number;
  // Gameplay
  timeControl: TimeControl;
  autoQueen: boolean;
  soundEnabled: boolean;
  soundVolume: number;
  // Data
  clearHistoryOnNewGame: boolean;
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
  stockfishPath: 'stockfish',
  threads: 1,
  hashMb: 128,
  multipv: 3,
  botStrength: 7,
  timeControl: TIME_CONTROLS[3], // Unlimited
  autoQueen: false,
  soundEnabled: true,
  soundVolume: 0.7,
  clearHistoryOnNewGame: false,
};

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...DEFAULTS,
  loaded: false,

  update: (patch) => {
    set(patch);
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
    const { loaded, update, loadFromBackend, saveToBackend, ...data } = get();
    try {
      if (window.electronAPI) {
        await window.electronAPI.saveSettings(data);
      }
    } catch {
      /* silent */
    }
  },
}));
