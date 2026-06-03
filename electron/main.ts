import {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  dialog,
  shell,
  Menu,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { PythonShell, Options } from 'python-shell';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

type EloCache = {
  white_accuracy: number;
  black_accuracy: number;
  blunder_rate: number;
  avg_cp_loss: number;
  computed_at: string;
};

type GameHistoryMeta = {
  white: string;
  black: string;
  result: string;
  termination: string | null;
  moves: number;
  mode: string;
  engine: string;
  time_control?: { seconds: number; increment: number; label: string };
  played_at: string;
  tags?: string[];
  elo_cache?: EloCache;
};

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const EXECUTABLE_PERMISSION_MASK = 0o111;

// ── Python backend process ───────────────────────────────────────────────────

let pyShell: PythonShell | null = null;

// Pending promise resolvers keyed by request id
const pendingRequests = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

// Analysis streaming callbacks: callback_id → BrowserWindow webContents id
const analysisCallbacks = new Map<string, number>();

function getPythonPath(): string {
  if (app.isPackaged) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    return path.join(process.resourcesPath, 'backend', `aether_backend${ext}`);
  }
  // In dev mode, prefer the venv Python so project packages are available
  const venvPython = process.platform === 'win32'
    ? path.join(__dirname, '..', '..', 'venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '..', '..', 'venv', 'bin', 'python3');
  if (fs.existsSync(venvPython)) return venvPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function getBackendScript(): string {
  if (app.isPackaged) {
    return ''; // PyInstaller executable — no script needed
  }
  return path.join(__dirname, '..', '..', 'backend', 'service.py');
}

function getDefaultsPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'config', 'settings.defaults.json')
    : path.join(__dirname, '..', '..', 'resources', 'config', 'settings.defaults.json');
}

function readDefaults(): Record<string, unknown> {
  try {
    const p = getDefaultsPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeSettings(raw: unknown): Record<string, unknown> {
  const defaults = readDefaults();
  if (app.isPackaged && (defaults.stockfishPath === 'stockfish' || !defaults.stockfishPath)) {
    const bundled = getPackagedStockfishPath();
    if (bundled) defaults.stockfishPath = bundled;
  }
  const data = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const merged: Record<string, unknown> = { ...defaults, ...data };
  const defaultTc = (defaults.timeControl as Record<string, unknown> | undefined) ?? {};
  const savedTc = (data.timeControl as Record<string, unknown> | undefined) ?? {};
  merged.timeControl = { ...defaultTc, ...savedTc };
  return merged;
}

function getPackagedStockfishPath(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    path.join(process.resourcesPath, 'backend', `stockfish${ext}`),
    path.join(process.resourcesPath, `stockfish${ext}`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isExecutablePath(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;
    if (process.platform === 'win32') {
      const ext = path.extname(filePath).toLowerCase();
      return ['.exe', '.bat', '.cmd'].includes(ext);
    }
    return (stats.mode & EXECUTABLE_PERMISSION_MASK) !== 0;
  } catch (error) {
    console.warn('[settings] Failed to validate executable path:', filePath, error);
    return false;
  }
}

function startPython(mainWindow: BrowserWindow): void {
  const pythonPath = getPythonPath();
  const scriptPath = getBackendScript();

  const opts: Options = {
    mode: 'json',
    pythonPath,
    stderrParser: (line: string) => {
      console.error('[Python stderr]', line);
      return line;
    },
  };

  try {
    pyShell = app.isPackaged
      ? new PythonShell(pythonPath, { ...opts, args: [] })
      : new PythonShell(scriptPath, opts);
  } catch (err) {
    console.error('Failed to start Python backend:', err);
    mainWindow.webContents.send('backend-error', String(err));
    return;
  }

  pyShell.on('message', (message: unknown) => {
    const msg = message as Record<string, unknown>;

    // Analysis streaming event
    if (msg.type === 'analysis_update' && typeof msg.callback_id === 'string') {
      const wcId = analysisCallbacks.get(msg.callback_id);
      if (wcId !== undefined) {
        BrowserWindow.fromId(wcId)?.webContents.send('analysis-update', msg);
      }
      return;
    }

    // Regular JSON-RPC response
    const id = msg.id as string | undefined;
    if (!id) return;
    const pending = pendingRequests.get(id);
    if (!pending) return;
    pendingRequests.delete(id);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(new Error(String(msg.error)));
    } else {
      pending.resolve(msg.result ?? msg);
    }
  });

  pyShell.on('error', (err: Error) => {
    console.error('[Python error]', err);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend-error', err.message);
    }
  });

  pyShell.on('close', () => {
    console.warn('[Python] backend process closed');
    pyShell = null;
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend-closed');
    }
  });
}

// Commands that can take a very long time (accuracy over a full game, etc.)
const LONG_RUNNING_COMMANDS = new Set([
  'calculate_accuracy',
  'calculate_accuracy_from_history',
  'calculate_accuracy_from_pgn',
  'get_engine_move',
  'get_bot_move',
  'maia3_cache',
]);

function sendCommand(
  command: string,
  params: Record<string, unknown> = {},
  callbackId?: string,
  windowId?: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!pyShell) {
      reject(new Error('Python backend not running'));
      return;
    }

    const id = `${command}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    if (callbackId && windowId !== undefined) {
      analysisCallbacks.set(callbackId, windowId);
    }

    // Long-running commands (e.g. full-game accuracy analysis) get 5 minutes;
    // everything else gets the standard 30 seconds.
    const timeoutMs = LONG_RUNNING_COMMANDS.has(command) ? 300_000 : 30_000;

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out: ${command}`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });
    pyShell.send({ id, command, params });
  });
}

// ── Window creation ──────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0A0A0A',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    titleBarStyle: 'hidden',
    show: false,
  });

  // Suppress default menu
  Menu.setApplicationMenu(null);

  const rendererURL = isDev
    ? 'http://localhost:5173'
    : `file://${path.join(__dirname, '..', 'renderer', 'index.html')}`;

  win.loadURL(rendererURL);

  win.once('ready-to-show', () => {
    win.show();
    startPython(win);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  if (!isDev) {
    autoUpdater.checkForUpdatesAndNotify();
  }
});

app.on('window-all-closed', () => {
  if (pyShell) {
    pyShell.kill();
    pyShell = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC handlers ─────────────────────────────────────────────────────────────

// Window controls
ipcMain.on('window-minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win?.isMaximized()) { win.unmaximize(); } else { win?.maximize(); }
});
ipcMain.on('window-close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle('window-is-maximized', (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

// Chess backend commands — each forwarded to Python
const CHESS_COMMANDS = [
  'new_game',
  'make_move',
  'get_legal_moves',
  'undo_move',
  'navigate_to_move',
  'get_engine_move',
  'get_bot_move',
  'get_eval',
  'export_pgn',
  'import_pgn',
  'export_fen',
  'calculate_accuracy',
  'calculate_accuracy_from_history',
  'calculate_accuracy_from_pgn',
  'estimate_elo',
  'get_book_moves',
  'stop_analysis',
] as const;

for (const cmd of CHESS_COMMANDS) {
  ipcMain.handle(cmd, async (_event, params: Record<string, unknown> = {}) => {
    return sendCommand(cmd, params);
  });
}

// Analysis streaming (needs window id for push events)
ipcMain.handle(
  'start_analysis',
  async (event, params: { fen: string; multipv: number; callback_id: string }) => {
    return sendCommand('start_analysis', params, params.callback_id, event.sender.id);
  },
);

// Settings persistence
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function ensureDirSync(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getHistoryDir(): string {
  return path.join(app.getPath('userData'), 'games');
}

function getHistoryIndexPath(): string {
  return path.join(getHistoryDir(), 'index.json');
}

function loadGameIndex(): {
  version: number;
  max_entries: number;
  games: Array<{
    id: string;
    pgn_file: string;
    meta: GameHistoryMeta;
  }>;
} {
  const indexPath = getHistoryIndexPath();
  if (!fs.existsSync(indexPath)) {
    return { version: 1, max_entries: 1000, games: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      version?: number;
      max_entries?: number;
      games?: Array<{ id: string; pgn_file: string; meta: GameHistoryMeta & { time_control?: { seconds: number; increment: number; label: string } } }>;
    };
    return {
      version: raw.version ?? 1,
      max_entries: raw.max_entries ?? 1000,
      games: (raw.games ?? []).map((g) => ({
        ...g,
        meta: { ...g.meta, tags: g.meta?.tags ?? [] },
      })),
    };
  } catch {
    return { version: 1, max_entries: 1000, games: [] };
  }
}

function saveGameIndex(data: { version: number; max_entries: number; games: Array<{ id: string; pgn_file: string; meta: GameHistoryMeta }> }): void {
  const indexPath = getHistoryIndexPath();
  fs.writeFileSync(indexPath, JSON.stringify(data, null, 2), 'utf-8');
}

function pruneGameIndex(data: { max_entries: number; games: Array<{ id: string; pgn_file: string }> }): void {
  const overflow = data.games.length - data.max_entries;
  if (overflow <= 0) return;
  const toRemove = data.games.slice(0, overflow);
  for (const entry of toRemove) {
    const filePath = path.join(getHistoryDir(), entry.pgn_file);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
  data.games.splice(0, overflow);
}

ipcMain.handle('settings-load', () => {
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return normalizeSettings(raw);
    }
  } catch {
    /* ignore */
  }
  return normalizeSettings(null);
});

ipcMain.handle('settings-save', (_event, data: unknown) => {
  const normalized = normalizeSettings(data);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(normalized, null, 2), 'utf-8');
  return true;
});

// File picker for Stockfish path
ipcMain.handle('pick-stockfish-path', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
    ?? BrowserWindow.getAllWindows()[0];
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: 'Select Stockfish executable',
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Executables', extensions: ['exe', 'bat', 'cmd'] }]
      : [{ name: 'All Files', extensions: [] }],
  });
  if (result.canceled) return null;
  const selected = result.filePaths[0];
  // On Unix, automatically grant execute permission so the binary is usable
  // even when downloaded directly (browsers do not preserve execute bits).
  if (process.platform !== 'win32') {
    try {
      const stats = fs.statSync(selected);
      if (stats.isFile() && (stats.mode & 0o100) === 0) {
        fs.chmodSync(selected, stats.mode | 0o111);
      }
    } catch (err) {
      console.warn('[stockfish] Could not chmod executable:', err);
    }
  }
  return isExecutablePath(selected) ? selected : null;
});

ipcMain.handle('stockfish-info', () => {
  const bundledPath = app.isPackaged ? getPackagedStockfishPath() : null;
  const configuredPath = (() => {
    try {
      if (!fs.existsSync(settingsPath)) return null;
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      const p = settings.stockfishPath;
      return typeof p === 'string' && p.trim() ? p : null;
    } catch {
      return null;
    }
  })();
  return {
    configuredPath,
    configuredExists: configuredPath ? fs.existsSync(configuredPath) : false,
    bundledPath,
    bundledExists: bundledPath ? fs.existsSync(bundledPath) : false,
    settingsPath,
  };
});

ipcMain.handle('clipboard-copy', (_event, text: string) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('open-external-url', async (_event, url: string) => {
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('maia3-cache', async (_event, params: { model?: string; cache_dir?: string; force_download?: boolean; hf_token?: string }) => {
  return sendCommand('maia3_cache', params ?? {});
});

ipcMain.handle('check-maia3-cache', async (_event, params: { model?: string }) => {
  return sendCommand('check_maia3_cache', params ?? {});
});

// Books directory for opening explorer
ipcMain.handle('get-books-dir', async () => {
  // Open folder picker dialog
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Opening Books Folder',
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// PGN export / open in file explorer
ipcMain.handle('reveal-in-folder', (_event, filePath: string) => {
  shell.showItemInFolder(filePath);
  return true;
});

// System info
ipcMain.handle('get-cpu-count', () => os.cpus().length);

// Game history persistence (index.json + per-game PGN file)
ipcMain.handle('save-game-history', (_event, params: { pgn?: string; meta?: GameHistoryMeta }) => {
  const pgn = typeof params?.pgn === 'string' ? params.pgn.trim() : '';
  const meta = params?.meta;
  if (!pgn || !meta) return { ok: false };

  const historyDir = getHistoryDir();
  ensureDirSync(historyDir);

  const index = loadGameIndex();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pgnFile = `${id}.pgn`;
  const pgnPath = path.join(historyDir, pgnFile);

  fs.writeFileSync(pgnPath, pgn, 'utf-8');

  index.games.push({ id, pgn_file: pgnFile, meta });
  pruneGameIndex(index);
  saveGameIndex(index);

  return { ok: true, path: pgnPath };
});

ipcMain.handle('list-game-history', () => {
  const historyDir = getHistoryDir();
  ensureDirSync(historyDir);
  return loadGameIndex();
});

ipcMain.handle('load-game-pgn', (_event, params: { id?: string }) => {
  const id = typeof params?.id === 'string' ? params.id : '';
  if (!id) return { pgn: '' };
  const index = loadGameIndex();
  const entry = index.games.find((g) => g.id === id);
  if (!entry) return { pgn: '' };
  const pgnPath = path.join(getHistoryDir(), entry.pgn_file);
  if (!fs.existsSync(pgnPath)) return { pgn: '' };
  return { pgn: fs.readFileSync(pgnPath, 'utf-8') };
});

ipcMain.handle('get-game-file-path', (_event, params: { id?: string }) => {
  const id = typeof params?.id === 'string' ? params.id : '';
  if (!id) return { path: undefined };
  const index = loadGameIndex();
  const entry = index.games.find((g) => g.id === id);
  if (!entry) return { path: undefined };
  const pgnPath = path.join(getHistoryDir(), entry.pgn_file);
  if (!fs.existsSync(pgnPath)) return { path: undefined };
  return { path: pgnPath };
});

ipcMain.handle('delete-game-history', (_event, params: { id?: string }) => {
  const id = typeof params?.id === 'string' ? params.id : '';
  if (!id) return { ok: false };
  const index = loadGameIndex();
  const next = index.games.filter((g) => g.id !== id);
  const removed = index.games.find((g) => g.id === id);
  if (removed) {
    const pgnPath = path.join(getHistoryDir(), removed.pgn_file);
    try {
      if (fs.existsSync(pgnPath)) fs.unlinkSync(pgnPath);
    } catch {
      /* ignore */
    }
  }
  index.games = next;
  saveGameIndex(index);
  return { ok: true };
});

ipcMain.handle('update-game-tags', (_event, params: { id?: string; tags?: string[] }) => {
  const id = typeof params?.id === 'string' ? params.id : '';
  const tags = Array.isArray(params?.tags) ? params?.tags.filter((t) => typeof t === 'string') : [];
  if (!id) return { ok: false };
  const index = loadGameIndex();
  const entry = index.games.find((g) => g.id === id);
  if (!entry) return { ok: false };
  entry.meta.tags = tags;
  saveGameIndex(index);
  return { ok: true };
});

// ── Cached Elo estimation ───────────────────────────────────────────
interface AccuracyFromPgnResult {
  moves?: Array<{ uci: string; color: string; cp_loss: number; classification: string }>;
  white_accuracy?: number;
  black_accuracy?: number;
  white_avg_cp_loss?: number;
  black_avg_cp_loss?: number;
  error?: string;
}

/** Compute accuracy for a single saved game and store the result in index.json. */
ipcMain.handle('compute-and-cache-elo', async (_event, params: { id: string; stockfish_path?: string }) => {
  const id = typeof params?.id === 'string' ? params.id : '';
  console.log('[Elo] compute-and-cache-elo start — id:', id);
  if (!id) { console.warn('[Elo] Missing id'); return { ok: false, error: 'Missing id' }; }

  const index = loadGameIndex();
  const entry = index.games.find((g) => g.id === id);
  if (!entry) { console.warn('[Elo] Game not found:', id); return { ok: false, error: 'Game not found' }; }

  const pgnPath = path.join(getHistoryDir(), entry.pgn_file);
  if (!fs.existsSync(pgnPath)) { console.warn('[Elo] PGN file not found:', pgnPath); return { ok: false, error: 'PGN file not found' }; }
  const pgn = fs.readFileSync(pgnPath, 'utf-8');
  console.log('[Elo]  PGN loaded —', (entry.meta.white ?? '?'), 'vs', (entry.meta.black ?? '?'), '—', entry.meta.moves, 'moves');

  let result: AccuracyFromPgnResult;
  try {
    result = await sendCommand('calculate_accuracy_from_pgn', {
      pgn,
      stockfish_path: params?.stockfish_path ?? '',
    }) as AccuracyFromPgnResult;
  } catch (err) {
    console.warn('[Elo]  Stockfish analysis threw:', err);
    return { ok: false, error: String(err) };
  }

  if (result.error) { console.warn('[Elo]  Stockfish analysis error:', result.error); return { ok: false, error: result.error }; }

  const rows = result.moves ?? [];
  const blunders = rows.filter((m) => m.classification === 'Blunder').length;
  const blunderRate = rows.length > 0 ? blunders / rows.length : 0;
  const whiteLosses = rows.filter((m) => m.color === 'white').map((m) => m.cp_loss);
  const blackLosses = rows.filter((m) => m.color === 'black').map((m) => m.cp_loss);
  const allLosses = [...whiteLosses, ...blackLosses];
  const avgCpLoss = allLosses.length > 0
    ? allLosses.reduce((a, b) => a + b, 0) / allLosses.length
    : 0;

  const eloCache = {
    white_accuracy: result.white_accuracy ?? 0,
    black_accuracy: result.black_accuracy ?? 0,
    blunder_rate: Math.round(blunderRate * 1000) / 1000,
    avg_cp_loss: Math.round(avgCpLoss * 10) / 10,
    computed_at: new Date().toISOString(),
  };
  console.log('[Elo]  Result — W:', eloCache.white_accuracy.toFixed(1), 'B:', eloCache.black_accuracy.toFixed(1), 'BR:', eloCache.blunder_rate, 'CPL:', eloCache.avg_cp_loss);

  // Re-load index to avoid race conditions with other writes
  const freshIndex = loadGameIndex();
  const freshEntry = freshIndex.games.find((g) => g.id === id);
  if (freshEntry) {
    freshEntry.meta.elo_cache = eloCache;
    saveGameIndex(freshIndex);
    console.log('[Elo] compute-and-cache-elo done — cached for', id);
  } else {
    console.warn('[Elo]  Game vanished from index between read and write:', id);
  }

  return { ok: true, elo_cache: eloCache };
});

/** Return game IDs (up to 30 most recent) that have no cached elo data. */
ipcMain.handle('get-games-needing-elo', () => {
  const index = loadGameIndex();
  const needing: Array<{ id: string; played_at: string; moves: number }> = [];
  for (const g of index.games) {
    if (!g.meta.elo_cache && g.meta.moves >= 2) {
      needing.push({ id: g.id, played_at: g.meta.played_at, moves: g.meta.moves });
    }
  }
  needing.sort((a, b) => b.played_at.localeCompare(a.played_at));
  const result = needing.slice(0, 30);
  console.log('[Elo] get-games-needing-elo —', result.length, 'game(s) without cache (of', index.games.length, 'total)');
  if (result.length > 0) console.log('[Elo]   First few:', result.slice(0, 3).map((g) => g.id).join(', '));
  return result;
});
