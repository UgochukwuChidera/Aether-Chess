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
  getEngineMove: (params: { fen: string; time_limit?: number; depth?: number }) =>
    ipcRenderer.invoke('get_engine_move', params),
  getBotMove: (params: { fen: string; strength?: number }) =>
    ipcRenderer.invoke('get_bot_move', params),
  exportPgn: () => ipcRenderer.invoke('export_pgn'),
  importPgn: (params: { pgn: string }) => ipcRenderer.invoke('import_pgn', params),
  exportFen: () => ipcRenderer.invoke('export_fen'),
  calculateAccuracy: (params: { fen_list: string[]; moves: string[] }) =>
    ipcRenderer.invoke('calculate_accuracy', params),
  estimateElo: (params: { accuracy: number; blunder_rate: number }) =>
    ipcRenderer.invoke('estimate_elo', params),
  getBookMoves: (params: { fen: string }) => ipcRenderer.invoke('get_book_moves', params),

  // ── Analysis streaming ───────────────────────────────────────────────────
  startAnalysis: (params: { fen: string; multipv: number; callback_id: string }) =>
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
  getBooksDir: () => ipcRenderer.invoke('get-books-dir'),
  revealInFolder: (filePath: string) => ipcRenderer.invoke('reveal-in-folder', filePath),
  getCpuCount: () => ipcRenderer.invoke('get-cpu-count'),
});
