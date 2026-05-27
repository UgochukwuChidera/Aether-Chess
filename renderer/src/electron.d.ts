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
      newGame: (params: {
        mode?: string;
        engine_type?: string;
        human_color?: string;
        strength?: number;
        stockfish_path?: string;
        maia3_path?: string;
        maia3_model?: string;
        maia3_device?: 'cpu' | 'cuda';
        maia3_elo?: number;
        think_profile?: string;
        threads?: number;
        hash_mb?: number;
        multipv?: number;
        time_control?: Record<string, unknown>;
      }) => Promise<unknown>;
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
        engine_type?: 'stockfish' | 'mentor' | 'maia3';
        maia3_path?: string;
        maia3_model?: string;
        maia3_device?: 'cpu' | 'cuda';
        maia3_elo?: number;
        think_profile?: string;
        time_remaining?: number;
        time_increment?: number;
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
      calculateAccuracyFromHistory: (params: {
        stockfish_path?: string;
        engine_type?: 'stockfish' | 'mentor' | 'maia3';
      }) => Promise<unknown>;
      calculateAccuracyFromPgn: (params: { pgn: string; stockfish_path?: string }) => Promise<unknown>;
      estimateElo: (params: { accuracy: number; blunder_rate: number; avg_cp_loss?: number }) => Promise<unknown>;
      getBookMoves: (params: { fen: string }) => Promise<unknown>;
      maia3Cache: (params: {
        model?: string;
        cache_dir?: string;
        force_download?: boolean;
        hf_token?: string;
      }) => Promise<unknown>;
      checkMaia3Cache: (params: { model?: string }) => Promise<{ cached: boolean; model: string }>;

      // Analysis streaming
      startAnalysis: (params: {
        fen: string;
        multipv: number;
        callback_id: string;
        stockfish_path?: string;
        threads?: number;
        hash_mb?: number;
        engine_type?: 'stockfish' | 'mentor' | 'maia3';
        maia3_model?: string;
        maia3_device?: 'cpu' | 'cuda';
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
      saveGameHistory: (params: {
        pgn: string;
        meta: {
          white: string;
          black: string;
          result: string;
          termination: string | null;
          moves: number;
          mode: string;
          engine: string;
          time_control?: { seconds: number; increment: number; label: string };
          played_at: string;
        };
      }) => Promise<{ ok: boolean; path?: string }>;
      listGameHistory: () => Promise<{
        version: number;
        max_entries: number;
        games: Array<{
          id: string;
          pgn_file: string;
          meta: {
            white: string;
            black: string;
            result: string;
            termination: string | null;
            moves: number;
            mode: string;
            engine: string;
            played_at: string;
            time_control?: { seconds: number; increment: number; label: string };
            tags?: string[];
          };
        }>;
      }>;
      loadGamePgn: (params: { id: string }) => Promise<{ pgn: string }>;
      getGameFilePath: (params: { id: string }) => Promise<{ path?: string }>;
      deleteGameHistory: (params: { id: string }) => Promise<{ ok: boolean }>;
      updateGameTags: (params: { id: string; tags: string[] }) => Promise<{ ok: boolean }>;
    };
  }
}
