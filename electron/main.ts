import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  nativeTheme,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { PythonShell, Options } from 'python-shell';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

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
  } catch {
    console.warn('[settings] Failed to validate executable path:', filePath);
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

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out: ${command}`));
    }, 30_000);

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
  const mainWindow = createWindow();

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
  win?.isMaximized() ? win.unmaximize() : win?.maximize();
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
  'export_pgn',
  'import_pgn',
  'export_fen',
  'calculate_accuracy',
  'calculate_accuracy_from_history',
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
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: 'Select Stockfish executable',
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Executables', extensions: ['exe', 'bat', 'cmd'] }]
      : [{ name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled) return null;
  const selected = result.filePaths[0];
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

ipcMain.handle('open-external-url', async (_event, url: string) => {
  await shell.openExternal(url);
  return true;
});

// Books directory for opening explorer
ipcMain.handle('get-books-dir', () => {
  const booksDir = app.isPackaged
    ? path.join(process.resourcesPath, 'books')
    : path.join(__dirname, '..', '..', 'resources', 'books');
  return booksDir;
});

// PGN export / open in file explorer
ipcMain.handle('reveal-in-folder', (_event, filePath: string) => {
  shell.showItemInFolder(filePath);
  return true;
});

// System info
ipcMain.handle('get-cpu-count', () => os.cpus().length);
