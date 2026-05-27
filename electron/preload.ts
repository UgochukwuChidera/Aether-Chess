import { contextBridge, ipcRenderer } from 'electron';

// Expose a typed, sandboxed API to the renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // ── Window controls ──────────────────────────────────────────────────────
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

  // ── Chess commands (forwarded to Python backend) ─────────────────────────
  newGame: (params: Record<string, unknown>) => ipcRenderer.invoke('new_game', params),
  makeMove: (params: { move: string }) => ipcRenderer.invoke('make_move', params),
  getLegalMoves: (params: { fen: string }) => ipcRenderer.invoke('get_legal_moves', params),
  undoMove: () => ipcRenderer.invoke('undo_move'),
  navigateToMove: (params: { index: number }) => ipcRenderer.invoke('navigate_to_move', params),
  getEngineMove: (params: {
    fen: string;
    time_limit?: number;
    depth?: number;
    stockfish_path?: string;
    threads?: number;
    hash_mb?: number;
  }) =>
    ipcRenderer.invoke('get_engine_move', params),
  getBotMove: (params: {
    fen: string;
    strength?: number;
    stockfish_path?: string;
    threads?: number;
    hash_mb?: number;
  }) =>
    ipcRenderer.invoke('get_bot_move', params),
  getEval: (params: {
    fen: string;
    use_mentor_eval?: boolean;
  }) =>
    ipcRenderer.invoke('get_eval', params),
  exportPgn: () => ipcRenderer.invoke('export_pgn'),
  importPgn: (params: { pgn: string }) => ipcRenderer.invoke('import_pgn', params),
  exportFen: () => ipcRenderer.invoke('export_fen'),
  calculateAccuracy: (params: { fen_list: string[]; moves: string[] }) =>
    ipcRenderer.invoke('calculate_accuracy', params),
  calculateAccuracyFromHistory: (params: { stockfish_path?: string }) =>
    ipcRenderer.invoke('calculate_accuracy_from_history', params),
  calculateAccuracyFromPgn: (params: { pgn: string; stockfish_path?: string }) =>
    ipcRenderer.invoke('calculate_accuracy_from_pgn', params),
  estimateElo: (params: { accuracy: number; blunder_rate: number }) =>
    ipcRenderer.invoke('estimate_elo', params),
  getBookMoves: (params: { fen: string }) => ipcRenderer.invoke('get_book_moves', params),
  maia3Cache: (params: { model?: string; cache_dir?: string; force_download?: boolean; hf_token?: string }) =>
    ipcRenderer.invoke('maia3-cache', params),
  checkMaia3Cache: (params: { model?: string }) =>
    ipcRenderer.invoke('check-maia3-cache', params),

  // ── Analysis streaming ───────────────────────────────────────────────────
  startAnalysis: (params: {
    fen: string;
    multipv: number;
    callback_id: string;
    stockfish_path?: string;
    threads?: number;
    hash_mb?: number;
  }) =>
    ipcRenderer.invoke('start_analysis', params),
  stopAnalysis: () => ipcRenderer.invoke('stop_analysis'),
  onAnalysisUpdate: (callback: (data: unknown) => void) => {
    ipcRenderer.on('analysis-update', (_event, data) => callback(data));
  },
  removeAnalysisListeners: () => {
    ipcRenderer.removeAllListeners('analysis-update');
  },

  // ── Backend lifecycle events ─────────────────────────────────────────────
  onBackendError: (callback: (msg: string) => void) => {
    ipcRenderer.on('backend-error', (_event, msg) => callback(msg));
  },
  onBackendClosed: (callback: () => void) => {
    ipcRenderer.on('backend-closed', () => callback());
  },

  // ── Settings persistence ─────────────────────────────────────────────────
  loadSettings: () => ipcRenderer.invoke('settings-load'),
  saveSettings: (data: unknown) => ipcRenderer.invoke('settings-save', data),

  // ── File system helpers ──────────────────────────────────────────────────
  pickStockfishPath: () => ipcRenderer.invoke('pick-stockfish-path'),
  getStockfishInfo: () => ipcRenderer.invoke('stockfish-info'),
  openExternalUrl: (url: string) => ipcRenderer.invoke('open-external-url', url),
  getBooksDir: () => ipcRenderer.invoke('get-books-dir'),
  revealInFolder: (filePath: string) => ipcRenderer.invoke('reveal-in-folder', filePath),
  getCpuCount: () => ipcRenderer.invoke('get-cpu-count'),
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
  }) => ipcRenderer.invoke('save-game-history', params),
  listGameHistory: () => ipcRenderer.invoke('list-game-history'),
  loadGamePgn: (params: { id: string }) => ipcRenderer.invoke('load-game-pgn', params),
  getGameFilePath: (params: { id: string }) => ipcRenderer.invoke('get-game-file-path', params),
  deleteGameHistory: (params: { id: string }) => ipcRenderer.invoke('delete-game-history', params),
  updateGameTags: (params: { id: string; tags: string[] }) => ipcRenderer.invoke('update-game-tags', params),
});
