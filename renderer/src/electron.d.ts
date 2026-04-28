/**
 * electron.d.ts — Type declarations for the contextBridge API.
 */
export {};

declare global {
  interface Window {
    electronAPI: {
      // Window controls
      minimize: () => void;
      maximize: () => void;
      close: () => void;
      isMaximized: () => Promise<boolean>;

      // Chess commands
      newGame: (params: Record<string, unknown>) => Promise<unknown>;
      makeMove: (params: { move: string }) => Promise<unknown>;
      getLegalMoves: (params: { fen: string }) => Promise<unknown>;
      undoMove: () => Promise<unknown>;
      navigateToMove: (params: { index: number }) => Promise<unknown>;
      getEngineMove: (params: {
        fen: string;
        time_limit?: number;
        depth?: number;
        stockfish_path?: string;
        threads?: number;
        hash_mb?: number;
      }) => Promise<unknown>;
      getBotMove: (params: {
        fen: string;
        strength?: number;
        stockfish_path?: string;
        threads?: number;
        hash_mb?: number;
        time_remaining?: number;
        time_increment?: number;
        total_moves?: number;
      }) => Promise<unknown>;
      getEval: (params: {
        fen: string;
        use_mentor_eval?: boolean;
      }) => Promise<unknown>;
      exportPgn: () => Promise<unknown>;
      importPgn: (params: { pgn: string }) => Promise<unknown>;
      exportFen: () => Promise<unknown>;
      calculateAccuracy: (params: { fen_list: string[]; moves: string[] }) => Promise<unknown>;
      calculateAccuracyFromHistory: (params: { stockfish_path?: string }) => Promise<unknown>;
      estimateElo: (params: { accuracy: number; blunder_rate: number; avg_cp_loss?: number }) => Promise<unknown>;
      getBookMoves: (params: { fen: string }) => Promise<unknown>;

      // Analysis streaming
      startAnalysis: (params: {
        fen: string;
        multipv: number;
        callback_id: string;
        stockfish_path?: string;
        threads?: number;
        hash_mb?: number;
      }) => Promise<unknown>;
      stopAnalysis: () => Promise<unknown>;
      onAnalysisUpdate: (callback: (data: unknown) => void) => void;
      removeAnalysisListeners: () => void;

      // Backend events
      onBackendError: (callback: (msg: string) => void) => void;
      onBackendClosed: (callback: () => void) => void;

      // Settings
      loadSettings: () => Promise<unknown>;
      saveSettings: (data: unknown) => Promise<boolean>;

      // File helpers
      pickStockfishPath: () => Promise<string | null>;
      getStockfishInfo: () => Promise<{
        configuredPath: string | null;
        configuredExists: boolean;
        bundledPath: string | null;
        bundledExists: boolean;
        settingsPath: string;
      }>;
      openExternalUrl: (url: string) => Promise<boolean>;
      getBooksDir: () => Promise<string>;
      revealInFolder: (filePath: string) => Promise<boolean>;
      getCpuCount: () => Promise<number>;
    };
  }
}
