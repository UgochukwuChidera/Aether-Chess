import { contextBridge, ipcRenderer } from "electron";

// Expose a typed, sandboxed API to the renderer
contextBridge.exposeInMainWorld("electronAPI", {
  // ── Window controls ──────────────────────────────────────────────────────
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
  isMaximized: () => ipcRenderer.invoke("window-is-maximized"),

  // ── Chess commands (forwarded to Python backend) ─────────────────────────
  newGame: (params: Record<string, unknown>) =>
    ipcRenderer.invoke("new_game", params),
  makeMove: (params: { move: string }) =>
    ipcRenderer.invoke("make_move", params),
  // P3-T01: termination commands. Same shape as the other chess commands
  // above (`ipcRenderer.invoke` on the snake_case channel); the backend is
  // the single termination authority, the renderer only forwards intent.
  resign: (params: { side: string }) => ipcRenderer.invoke("resign", params),
  draw: () => ipcRenderer.invoke("draw"),
  getLegalMoves: (params: { fen: string }) =>
    ipcRenderer.invoke("get_legal_moves", params),
  undoMove: () => ipcRenderer.invoke("undo_move"),
  navigateToMove: (params: { index: number }) =>
    ipcRenderer.invoke("navigate_to_move", params),
  getEngineMove: (params: {
    fen: string;
    time_limit?: number;
    depth?: number;
    stockfish_path?: string;
    threads?: number;
    hash_mb?: number;
  }) => ipcRenderer.invoke("get_engine_move", params),
  // The backend decides which bots exist (discovered Stockfish builds, Mentor,
  // Maia3, anything registered later), so the UI never hard-codes the list.
  listBots: () => ipcRenderer.invoke("list_bots"),
  getEval: (params: { fen: string; use_mentor_eval?: boolean }) =>
    ipcRenderer.invoke("get_eval", params),
  exportPgn: () => ipcRenderer.invoke("export_pgn"),
  importPgn: (params: { pgn: string }) =>
    ipcRenderer.invoke("import_pgn", params),
  exportFen: () => ipcRenderer.invoke("export_fen"),
  calculateAccuracyFromHistory: (params: { stockfish_path?: string }) =>
    ipcRenderer.invoke("calculate_accuracy_from_history", params),
  calculateAccuracyFromPgn: (params: {
    pgn: string;
    stockfish_path?: string;
  }) => ipcRenderer.invoke("calculate_accuracy_from_pgn", params),
  estimateElo: (params: { accuracy: number; blunder_rate: number }) =>
    ipcRenderer.invoke("estimate_elo", params),
  getBookMoves: (params: { fen: string; books_dir?: string }) =>
    ipcRenderer.invoke("get_book_moves", params),
  // P4-T01: Syzygy endgame probe — detect-and-report when unconfigured
  // (backend returns configured:false; the UI degrades to a quiet note).
  probeTablebase: (params: { fen?: string; tablebase_path?: string }) =>
    ipcRenderer.invoke("probe_tablebase", params),
  // P4-T02: PDF game report. Main injects the history-dir destination and
  // returns it; the renderer reveals it via the existing revealInFolder
  // IPC (no new shell surface).
  exportPdfReport: (params: { pgn?: string; stockfish_path?: string }) =>
    ipcRenderer.invoke("export-pdf-report", params),
  maia3Cache: (params: {
    model?: string;
    cache_dir?: string;
    force_download?: boolean;
    hf_token?: string;
  }) => ipcRenderer.invoke("maia3-cache", params),
  checkMaia3Cache: (params: { model?: string }) =>
    ipcRenderer.invoke("check-maia3-cache", params),

  // ── Analysis streaming ───────────────────────────────────────────────────
  startAnalysis: (params: {
    fen: string;
    multipv: number;
    callback_id: string;
    stockfish_path?: string;
    threads?: number;
    hash_mb?: number;
  }) => ipcRenderer.invoke("start_analysis", params),
  stopAnalysis: () => ipcRenderer.invoke("stop_analysis"),
  // P2-T03: every subscribe function returns its own unsubscribe closure.
  // The closure captures the in-preload wrapper, so cleanup removes exactly
  // this subscription. A preload-side map keyed by the caller's callback
  // cannot work here: contextBridge mints a fresh proxy per crossing, so the
  // reference handed back at cleanup never matches the one stored at
  // subscribe time (probed: every lookup missed while entries accumulated).
  // Returning the remover is also what keeps co-mounted views safe — no
  // removeAllListeners anywhere, so one unmount can never kill a sibling's
  // subscription on the shared "analysis-update" channel.
  onAnalysisUpdate: (callback: (data: unknown) => void) => {
    const wrapped = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("analysis-update", wrapped);
    return () => {
      ipcRenderer.removeListener("analysis-update", wrapped);
    };
  },

  // ── Backend lifecycle events ─────────────────────────────────────────────
  onBackendError: (callback: (msg: string) => void) => {
    const wrapped = (_event: unknown, msg: unknown) => callback(msg as string);
    ipcRenderer.on("backend-error", wrapped);
    return () => {
      ipcRenderer.removeListener("backend-error", wrapped);
    };
  },
  onBackendClosed: (callback: () => void) => {
    const wrapped = () => callback();
    ipcRenderer.on("backend-closed", wrapped);
    return () => {
      ipcRenderer.removeListener("backend-closed", wrapped);
    };
  },
  // P2-T22: emitted by main when the backend's ready signal is observed
  // (boot spawn and P2-T05 lazy respawn alike). Same unsubscribe-handle
  // shape as onBackendClosed/onBackendError (P2-T03) — no
  // removeAllListeners, no ref-keyed removal.
  onBackendReady: (callback: () => void) => {
    const wrapped = () => callback();
    ipcRenderer.on("backend-ready", wrapped);
    return () => {
      ipcRenderer.removeListener("backend-ready", wrapped);
    };
  },
  // P3-T01: backend clock tick (1 Hz while a clock runs). Same
  // unsubscribe-handle shape as the backend-lifecycle events above.
  onClockTick: (callback: (data: unknown) => void) => {
    const wrapped = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("clock-tick", wrapped);
    return () => {
      ipcRenderer.removeListener("clock-tick", wrapped);
    };
  },

  // ── Settings persistence ─────────────────────────────────────────────────
  loadSettings: () => ipcRenderer.invoke("settings-load"),
  saveSettings: (data: unknown) => ipcRenderer.invoke("settings-save", data),
  // P3-T09: canonical defaults + engine caps from the backend
  // (`settings_defaults` command, single authority in
  // backend/settings_schema.py). Paramless forward, same shape as the other
  // chess commands above; the store falls back silently when the backend is
  // unreachable, so boot never blocks on this.
  getSettingsDefaults: () => ipcRenderer.invoke("settings_defaults"),

  // ── Clipboard ───────────────────────────────────────────────────────────
  copyToClipboard: (text: string) => ipcRenderer.invoke("clipboard-copy", text),

  // ── File system helpers ──────────────────────────────────────────────────
  pickStockfishPath: () => ipcRenderer.invoke("pick-stockfish-path"),
  getStockfishInfo: () => ipcRenderer.invoke("stockfish-info"),
  revealEnginesDir: () => ipcRenderer.invoke("reveal-engines-dir"),
  openExternalUrl: (url: string) =>
    ipcRenderer.invoke("open-external-url", url),
  getBooksDir: () => ipcRenderer.invoke("get-books-dir"),
  revealInFolder: (filePath: string) =>
    ipcRenderer.invoke("reveal-in-folder", filePath),
  getCpuCount: () => ipcRenderer.invoke("get-cpu-count"),
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
  }) => ipcRenderer.invoke("save-game-history", params),
  listGameHistory: () => ipcRenderer.invoke("list-game-history"),
  loadGamePgn: (params: { id: string }) =>
    ipcRenderer.invoke("load-game-pgn", params),
  getGameFilePath: (params: { id: string }) =>
    ipcRenderer.invoke("get-game-file-path", params),
  deleteGameHistory: (params: { id: string }) =>
    ipcRenderer.invoke("delete-game-history", params),
  updateGameTags: (params: { id: string; tags: string[] }) =>
    ipcRenderer.invoke("update-game-tags", params),
  computeAndCacheElo: (params: { id: string; stockfish_path?: string }) =>
    ipcRenderer.invoke("compute-and-cache-elo", params),
  getGamesNeedingElo: () => ipcRenderer.invoke("get-games-needing-elo"),
});
