/**
 * electron.d.ts — Type declarations for the contextBridge API.
 */
export {};

declare global {
  /** Where a discovered engine executable was found. */
  type StockfishEngineSource = 'configured' | 'path' | 'app-engines' | 'user-engines' | 'bundled';

  /** A single engine executable found on this machine. */
  type StockfishEngine = {
    path: string;
    name: string;
    version: number[];
    versionLabel: string;
    source: StockfishEngineSource;
    selected: boolean;
  };

  /** A bot the backend can actually run, as reported by the `list_bots` command. */
  type BotInfo = {
    bot_id: string;
    display_name: string;
    kind: string;
    description: string;
    requires_binary: boolean;
    supports_skill_level: boolean;
    supports_elo: boolean;
    supports_eval: boolean;
    deterministic: boolean;
    available: boolean;
    is_default: boolean;
  };

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
      resign: (params: { side: string }) => Promise<unknown>;
      draw: () => Promise<unknown>;
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
        engine_type?: string;
        maia3_path?: string;
        maia3_model?: string;
        maia3_device?: 'cpu' | 'cuda';
        maia3_elo?: number;
        think_profile?: string;
        time_remaining?: number;
        time_increment?: number;
        total_moves?: number;
        strength?: number;
      }) => Promise<unknown>;
      listBots: () => Promise<{ bots: BotInfo[] }>;
      getEval: (params: { fen: string; use_mentor_eval?: boolean }) => Promise<unknown>;
      exportPgn: () => Promise<unknown>;
      importPgn: (params: { pgn: string }) => Promise<unknown>;
      exportFen: () => Promise<unknown>;
      calculateAccuracyFromHistory: (params: {
        stockfish_path?: string;
        engine_type?: string;
      }) => Promise<unknown>;
      calculateAccuracyFromPgn: (params: { pgn: string; stockfish_path?: string }) => Promise<unknown>;
      estimateElo: (params: {
        accuracy: number;
        blunder_rate: number;
        avg_cp_loss?: number;
        num_games?: number;
      }) => Promise<unknown>;
      getBookMoves: (params: { fen: string }) => Promise<unknown>;
      // P4-T01: Syzygy endgame probe (detect-and-report when unconfigured).
      probeTablebase: (params: { fen?: string; tablebase_path?: string }) => Promise<unknown>;
      // P4-T02: PDF game report (main injects the destination; backend
      // returns { path, key_moments }).
      exportPdfReport: (params: { pgn?: string; stockfish_path?: string }) => Promise<{ path: string; key_moments?: string[] }>;
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
        engine_type?: string;
        maia3_model?: string;
        maia3_device?: 'cpu' | 'cuda';
      }) => Promise<unknown>;
      stopAnalysis: () => Promise<unknown>;
      onAnalysisUpdate: (callback: (data: unknown) => void) => () => void;

      // Backend events
      onBackendError: (callback: (msg: string) => void) => () => void;
      onBackendClosed: (callback: () => void) => () => void;
      onBackendReady: (callback: () => void) => () => void;
      onClockTick: (callback: (data: unknown) => void) => () => void;

      // Settings
      loadSettings: () => Promise<unknown>;
      saveSettings: (data: unknown) => Promise<boolean>;
      // P3-T09: canonical defaults + caps. Shape is whatever
      // backend/settings_schema.py::settings_defaults() serves
      // ({schemaVersion, defaults (snake_case), limits (snake_case)});
      // the store reads it defensively and falls back silently.
      getSettingsDefaults: () => Promise<unknown>;

      // Clipboard
      copyToClipboard: (text: string) => Promise<boolean>;

      // File helpers
      pickStockfishPath: () => Promise<string | null>;
      getStockfishInfo: () => Promise<{
        configuredPath: string | null;
        configuredExists: boolean;
        bundledPath: string | null;
        bundledExists: boolean;
        engines: StockfishEngine[];
        resolvedPath: string | null;
        appEnginesDir: string;
        userEnginesDir: string;
        settingsPath: string;
      }>;
      revealEnginesDir: () => Promise<string>;
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
      computeAndCacheElo: (params: { id: string; stockfish_path?: string }) => Promise<{
        ok: boolean;
        error?: string;
        elo_cache?: {
          white_accuracy: number;
          black_accuracy: number;
          blunder_rate: number;
          avg_cp_loss: number;
          computed_at: string;
        };
      }>;
      getGamesNeedingElo: () => Promise<Array<{ id: string; played_at: string; moves: number }>>;
    };
  }
}
