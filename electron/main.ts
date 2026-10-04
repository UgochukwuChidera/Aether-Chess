import {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  dialog,
  shell,
  Menu,
} from "electron";
import { autoUpdater } from "electron-updater";
import { PythonShell, Options } from "python-shell";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  discoverEngines,
  ensureEngineDirs,
  ensureExecutable,
  isAutoPath,
  isExecutableFile as isExecutablePath,
  userEnginesDir,
  appEnginesDir,
} from "./engineRegistry";
import { isAllowedOpenUrl, isPathWithinRoots } from "./shellPolicy";
import { validateIpcParams } from "./ipcValidation";

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

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

// ── Python backend process ───────────────────────────────────────────────────

let pyShell: PythonShell | null = null;

// Pending promise resolvers keyed by request id
const pendingRequests = new Map<
  string,
  {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    command: string;
  }
>();

// Analysis streaming callbacks: callback_id → BrowserWindow webContents id
const analysisCallbacks = new Map<string, number>();

function getPythonPath(): string {
  if (app.isPackaged) {
    const ext = process.platform === "win32" ? ".exe" : "";
    return path.join(process.resourcesPath, "backend", `aether_backend${ext}`);
  }
  // In dev mode, prefer the venv Python so project packages are available
  const venvPython =
    process.platform === "win32"
      ? path.join(__dirname, "..", "..", "venv", "Scripts", "python.exe")
      : path.join(__dirname, "..", "..", "venv", "bin", "python3");
  if (fs.existsSync(venvPython)) return venvPython;
  return process.platform === "win32" ? "python" : "python3";
}

function getBackendScript(): string {
  const override = process.env.AETHER_BACKEND_SCRIPT;
  if (override && fs.existsSync(override)) return override;
  if (app.isPackaged) {
    return ""; // PyInstaller executable — no script needed
  }
  return path.join(__dirname, "..", "..", "backend", "service.py");
}

function getDefaultsPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "config", "settings.defaults.json")
    : path.join(
        __dirname,
        "..",
        "..",
        "resources",
        "config",
        "settings.defaults.json",
      );
}

function readDefaults(): Record<string, unknown> {
  try {
    const p = getDefaultsPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function normalizeSettings(
  raw: unknown,
): Promise<Record<string, unknown>> {
  const defaults = readDefaults();
  const data =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...defaults, ...data };
  const defaultTc =
    (defaults.timeControl as Record<string, unknown> | undefined) ?? {};
  const savedTc =
    (data.timeControl as Record<string, unknown> | undefined) ?? {};
  merged.timeControl = { ...defaultTc, ...savedTc };

  // An "auto" selection is deliberately left as the bare name rather than
  // rewritten to whichever binary happens to be installed today. Resolving it
  // here would freeze the choice into settings and silently stop Auto from
  // ever picking up a newer engine. The Python backend resolves bare names
  // itself, so nothing downstream needs a concrete path.
  const configured =
    typeof merged.stockfishPath === "string" ? merged.stockfishPath.trim() : "";
  if (!configured) merged.stockfishPath = "stockfish";
  return merged;
}

function startPython(mainWindow: BrowserWindow): void {
  const pythonPath = getPythonPath();
  const scriptPath = getBackendScript();

  const opts: Options = {
    mode: "json",
    pythonPath,
    stderrParser: (line: string) => {
      console.error("[Python stderr]", line);
      // P2-T22: the backend prints "[aether_backend] ready" (fixture:
      // "[fake-backend] ready") once its stdin loop is up. Forward it as
      // `backend-ready` so the renderer can re-assert `backendConnected`
      // after a (re)spawn. Fires on BOTH the boot spawn (harmless
      // re-assert of the initial true) and the P2-T05 lazy respawn. This
      // is a post-ready signal, not fire-and-forget at spawn: a spawn
      // that dies before printing ready emits nothing here, so close/error
      // still drive the flag false (respawn -> ready -> flag true;
      // spawn-fail -> closed -> flag false).
      if (!mainWindow.isDestroyed() && line.includes("] ready")) {
        mainWindow.webContents.send("backend-ready");
      }
      return line;
    },
  };

  try {
    pyShell = app.isPackaged
      ? new PythonShell(pythonPath, { ...opts, args: [] })
      : new PythonShell(scriptPath, opts);
  } catch (err) {
    console.error("Failed to start Python backend:", err);
    mainWindow.webContents.send("backend-error", String(err));
    return;
  }

  pyShell.on("message", (message: unknown) => {
    const msg = message as Record<string, unknown>;

    // Analysis streaming event
    if (msg.type === "analysis_update" && typeof msg.callback_id === "string") {
      const wcId = analysisCallbacks.get(msg.callback_id);
      if (wcId !== undefined) {
        BrowserWindow.fromId(wcId)?.webContents.send("analysis-update", msg);
      }
      return;
    }

    // P3-T01: backend clock tick (1 Hz while a clock runs). The clock is not
    // subscribed per-window like analysis — every window shows the same game,
    // so broadcast to all live windows. Push, not poll: the renderer keeps no
    // client-side timer; the backend alone advances and ends the game.
    if (msg.type === "clock_tick") {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("clock-tick", msg);
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

  pyShell.on("error", (err: Error) => {
    console.error("[Python error]", err);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("backend-error", err.message);
    }
  });

  pyShell.on("close", () => {
    console.warn("[Python] backend process closed");
    pyShell = null;
    // P2-T05: fail fast — the old code stopped here, so every in-flight
    // renderer promise waited out its full timeout and nothing respawned.
    const rejected = rejectAllPendingRequests();
    if (rejected > 0) {
      console.warn(
        `[Python] rejected ${rejected} pending request(s): backend exited`,
      );
    }
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("backend-closed");
    }
  });
}

// Commands that can take a very long time (accuracy over a full game, etc.)
const LONG_RUNNING_COMMANDS = new Set([
  "calculate_accuracy",
  "calculate_accuracy_from_history",
  "calculate_accuracy_from_pgn",
  "get_engine_move",
  "get_bot_move",
  "maia3_cache",
]);

// P2-T05: the backend can die at any time (SIGKILL, crash, OOM).
// Reject every in-flight renderer promise with a clear backend-exited
// error instead of letting each wait out its full timeout (30s, 300s for
// LONG_RUNNING tiers), and clearTimeout each entry so no dead handle
// fires into a deleted entry later. Returns the rejected count.
function rejectAllPendingRequests(): number {
  let rejected = 0;
  for (const [id, pending] of pendingRequests) {
    pendingRequests.delete(id);
    clearTimeout(pending.timer);
    pending.reject(
      new Error(`Backend exited before responding to ${pending.command}`),
    );
    rejected += 1;
  }
  return rejected;
}

function sendCommand(
  command: string,
  params: Record<string, unknown> = {},
  callbackId?: string,
  windowId?: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!pyShell) {
      // P2-T05 lazy respawn on the next IPC call. BrowserWindow is
      // already imported and the app is single-window (exactly one
      // `new BrowserWindow` site; createWindow only), so the first live
      // window is the right owner with no ref threading. With no live
      // window (shutdown) this stays null and falls through to reject.
      const live = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (live) startPython(live);
    }
    if (!pyShell) {
      reject(new Error("Python backend not running"));
      return;
    }

    const id = `${command}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    if (callbackId && windowId !== undefined) {
      analysisCallbacks.set(callbackId, windowId);
      console.log(
        `[Analysis] start_analysis: ${analysisCallbacks.size} active analysis subscription(s)`,
      );
    }

    // Long-running commands (e.g. full-game accuracy analysis) get 5 minutes;
    // everything else gets the standard 30 seconds.
    const timeoutMs = LONG_RUNNING_COMMANDS.has(command) ? 300_000 : 30_000;

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out: ${command}`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer, command });
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
    backgroundColor: "#0A0A0A",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    titleBarStyle: "hidden",
    show: false,
  });

  // Suppress default menu
  Menu.setApplicationMenu(null);

  const rendererURL = isDev
    ? "http://localhost:5173"
    : `file://${path.join(__dirname, "..", "renderer", "index.html")}`;

  win.loadURL(rendererURL);

  win.once("ready-to-show", () => {
    win.show();
    startPython(win);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // P2-T06: same shell.openExternal sink as open-external-url, so the
    // same allowlist applies. Denied either way (popup suppression).
    if (isAllowedOpenUrl(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // P2-T04: a window can own several analysis entries (callback_id →
  // webContents id); drop all of them when it closes so a stale entry can
  // never route to a recycled window id. The id is captured now because
  // the window object is half-torn-down inside the closed handler.
  const ownerWcId = win.webContents.id;
  win.on("closed", () => {
    let dropped = 0;
    for (const [callbackId, wcId] of analysisCallbacks) {
      if (wcId === ownerWcId) {
        analysisCallbacks.delete(callbackId);
        dropped += 1;
      }
    }
    console.log(
      `[Analysis] window closed: dropped ${dropped} analysis subscription(s), ${analysisCallbacks.size} active`,
    );
  });

  return win;
}

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Create the folders a player drops engine binaries into, so the path we
  // advertise in the UI always exists.
  ensureEngineDirs();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  if (!isDev) {
    autoUpdater.checkForUpdatesAndNotify();
  }
});

app.on("window-all-closed", () => {
  if (pyShell) {
    pyShell.kill();
    pyShell = null;
  }
  if (process.platform !== "darwin") app.quit();
});

// ── IPC handlers ─────────────────────────────────────────────────────────────

// Window controls
ipcMain.on("window-minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.on("window-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win?.isMaximized()) {
    win.unmaximize();
  } else {
    win?.maximize();
  }
});
ipcMain.on("window-close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle("window-is-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

// Chess backend commands — each forwarded to Python
const CHESS_COMMANDS = [
  "new_game",
  "make_move",
  "resign",
  "draw",
  "get_legal_moves",
  "undo_move",
  "navigate_to_move",
  "get_engine_move",
  "get_bot_move",
  "list_bots",
  "get_eval",
  "export_pgn",
  "import_pgn",
  "export_fen",
  "calculate_accuracy",
  "calculate_accuracy_from_history",
  "calculate_accuracy_from_pgn",
  "estimate_elo",
  "get_book_moves",
  // NOTE: no "stop_analysis" here — it has a dedicated handler below that
  // deletes the analysisCallbacks entry. ipcMain serves the FIRST handler
  // registered per channel, so listing it here would shadow the dedicated
  // one with the generic forwarder and the map would never drain.
] as const;

for (const cmd of CHESS_COMMANDS) {
  ipcMain.handle(cmd, async (_event, params: Record<string, unknown> = {}) => {
    // P3-T03: shape/presence/primitive sanity at the boundary. Garbage fails
    // here with a field-naming error and is never forwarded; valid shapes
    // (including unknown extra keys) forward byte-identically. Throw so
    // invoke() rejects — the same convention as the P2-T06 shell guards, and
    // every renderer caller already catches (toast / .catch / ignore).
    const validationError = validateIpcParams(cmd, params);
    if (validationError) throw new Error(validationError);
    return sendCommand(cmd, params);
  });
}

// Analysis streaming (needs window id for push events)
ipcMain.handle(
  "start_analysis",
  async (
    event,
    params: { fen: string; multipv: number; callback_id: string },
  ) => {
    // P3-T03: validate before touching params.callback_id — a null or
    // primitive payload would otherwise throw a bare TypeError here.
    const startValidationError = validateIpcParams("start_analysis", params);
    if (startValidationError) throw new Error(startValidationError);
    return sendCommand(
      "start_analysis",
      params,
      params.callback_id,
      event.sender.id,
    );
  },
);

// P2-T04: starting an analysis registers one map entry per callback_id;
// stopping must delete it, or the map grows for process lifetime. The
// renderer sends no callback_id on stop, so fall back to purging every
// entry owned by the sending window. This channel is NOT in CHESS_COMMANDS
// above (ipcMain keeps the first handler per channel — the generic
// forwarder would shadow this one).
ipcMain.handle(
  "stop_analysis",
  async (event, params: Record<string, unknown> = {}) => {
    const callbackId = params.callback_id;
    if (typeof callbackId === "string") {
      analysisCallbacks.delete(callbackId);
    } else {
      const senderId = event.sender.id;
      for (const [key, wcId] of analysisCallbacks) {
        if (wcId === senderId) analysisCallbacks.delete(key);
      }
    }
    console.log(
      `[Analysis] stop_analysis: ${analysisCallbacks.size} active analysis subscription(s)`,
    );
    return sendCommand("stop_analysis", params);
  },
);

// Settings persistence
const settingsPath = path.join(app.getPath("userData"), "settings.json");

function ensureDirSync(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getHistoryDir(): string {
  return path.join(app.getPath("userData"), "games");
}

// P2-T06: the only folders showItemInFolder may reveal — userData (covers
// settings.json), the game-history dir (the reveal-in-folder caller shape),
// and both engines dirs (what reveal-engines-dir opens via openPath).
function shellFileRoots(): string[] {
  return [
    app.getPath("userData"),
    getHistoryDir(),
    userEnginesDir(),
    appEnginesDir(),
  ];
}

function getHistoryIndexPath(): string {
  return path.join(getHistoryDir(), "index.json");
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
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as {
      version?: number;
      max_entries?: number;
      games?: Array<{
        id: string;
        pgn_file: string;
        meta: GameHistoryMeta & {
          time_control?: { seconds: number; increment: number; label: string };
        };
      }>;
    };
    return {
      version: raw.version ?? 1,
      max_entries: raw.max_entries ?? 1000,
      games: (raw.games ?? []).map((g) => ({
        ...g,
        // P2-T19: legacy/hand-edited entries may lack played_at; default it
        // here so `played_at.localeCompare(...)` below never throws on
        // undefined. (Static-review proof: main.ts is unimportable in
        // node:test — P0-T09 precedent; tsc build typechecks this.)
        meta: {
          ...g.meta,
          tags: g.meta?.tags ?? [],
          played_at: g.meta?.played_at ?? "",
        },
      })),
    };
  } catch {
    return { version: 1, max_entries: 1000, games: [] };
  }
}

function saveGameIndex(data: {
  version: number;
  max_entries: number;
  games: Array<{ id: string; pgn_file: string; meta: GameHistoryMeta }>;
}): void {
  const indexPath = getHistoryIndexPath();
  fs.writeFileSync(indexPath, JSON.stringify(data, null, 2), "utf-8");
}

function pruneGameIndex(data: {
  max_entries: number;
  games: Array<{ id: string; pgn_file: string }>;
}): void {
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

ipcMain.handle("settings-load", async () => {
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      return await normalizeSettings(raw);
    }
  } catch {
    /* ignore */
  }
  return await normalizeSettings(null);
});

ipcMain.handle("settings-save", async (_event, data: unknown) => {
  const normalized = await normalizeSettings(data);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(normalized, null, 2), "utf-8");
  return true;
});

// File picker for Stockfish path
ipcMain.handle("pick-stockfish-path", async (event) => {
  const win =
    BrowserWindow.fromWebContents(event.sender) ??
    BrowserWindow.getAllWindows()[0];
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: "Select Stockfish executable",
    properties: ["openFile"],
    filters:
      process.platform === "win32"
        ? [{ name: "Executables", extensions: ["exe", "bat", "cmd"] }]
        : [{ name: "All Files", extensions: [] }],
  });
  if (result.canceled) return null;
  const selected = result.filePaths[0];
  // On Unix, automatically grant execute permission so the binary is usable
  // even when downloaded directly (browsers do not preserve execute bits).
  ensureExecutable(selected);
  return isExecutablePath(selected) ? selected : null;
});

/** Read the persisted stockfishPath, if the user has ever saved settings. */
function readConfiguredEnginePath(): string | null {
  try {
    if (!fs.existsSync(settingsPath)) return null;
    const settings = JSON.parse(
      fs.readFileSync(settingsPath, "utf-8"),
    ) as Record<string, unknown>;
    const p = settings.stockfishPath;
    return typeof p === "string" && p.trim() ? p : null;
  } catch {
    return null;
  }
}

ipcMain.handle("stockfish-info", async () => {
  const configuredPath = readConfiguredEnginePath();
  // Discovery probes each candidate, so it is comparatively slow; the UI calls
  // this on open and after a change, not per frame.
  const engines = await discoverEngines(configuredPath);
  const bundled = engines.find((e) => e.source === "bundled");

  // Mirror resolveEnginePath's choice from the same discovery pass, so the
  // highlighted engine and the one the backend receives cannot disagree.
  const resolvedPath =
    configuredPath && !isAutoPath(configuredPath)
      ? isExecutablePath(path.resolve(configuredPath))
        ? path.resolve(configuredPath)
        : null
      : (engines[0]?.path ?? null);
  const chosen = resolvedPath
    ? engines.find((e) => e.path === resolvedPath)
    : undefined;
  if (chosen) chosen.selected = true;

  return {
    configuredPath,
    configuredExists: configuredPath ? isExecutablePath(configuredPath) : false,
    bundledPath: bundled?.path ?? null,
    bundledExists: Boolean(bundled),
    /** Every engine found, newest version first. */
    engines,
    /** What the app would use right now. */
    resolvedPath,
    appEnginesDir: appEnginesDir(),
    userEnginesDir: userEnginesDir(),
    settingsPath,
  };
});

/** Open the folder a player should drop downloaded binaries into. */
ipcMain.handle("reveal-engines-dir", async () => {
  ensureEngineDirs();
  const target = fs.existsSync(userEnginesDir())
    ? userEnginesDir()
    : appEnginesDir();
  await shell.openPath(target);
  return target;
});

ipcMain.handle("clipboard-copy", (_event, text: string) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle("open-external-url", async (_event, url: string) => {
  // P2-T06: renderer-supplied value reached shell.openExternal unfiltered
  // (file:// and smb:// were reachable). Throw so invoke() rejects — the
  // boolean return shape is unchanged on the allow path.
  if (!isAllowedOpenUrl(url)) {
    throw new Error(
      "open-external-url blocked: only https: and mailto: URLs are allowed",
    );
  }
  await shell.openExternal(url);
  return true;
});

ipcMain.handle(
  "maia3-cache",
  async (
    _event,
    params: {
      model?: string;
      cache_dir?: string;
      force_download?: boolean;
      hf_token?: string;
    },
  ) => {
    const maiaValidationError = validateIpcParams("maia3-cache", params ?? {});
    if (maiaValidationError) throw new Error(maiaValidationError);
    return sendCommand("maia3_cache", params ?? {});
  },
);

ipcMain.handle(
  "check-maia3-cache",
  async (_event, params: { model?: string }) => {
    const checkValidationError = validateIpcParams(
      "check-maia3-cache",
      params ?? {},
    );
    if (checkValidationError) throw new Error(checkValidationError);
    return sendCommand("check_maia3_cache", params ?? {});
  },
);

// Books directory for opening explorer
ipcMain.handle("get-books-dir", async () => {
  // Open folder picker dialog
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Select Opening Books Folder",
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// PGN export / open in file explorer
ipcMain.handle("reveal-in-folder", (_event, filePath: string) => {
  // P2-T06: renderer-supplied path reached showItemInFolder unfiltered.
  // Throw so invoke() rejects — the boolean return shape is unchanged.
  if (
    typeof filePath !== "string" ||
    !isPathWithinRoots(filePath, shellFileRoots())
  ) {
    throw new Error("reveal-in-folder blocked: path is outside known folders");
  }
  shell.showItemInFolder(filePath);
  return true;
});

// System info
ipcMain.handle("get-cpu-count", () => os.cpus().length);

// Game history persistence (index.json + per-game PGN file)
ipcMain.handle(
  "save-game-history",
  (_event, params: { pgn?: string; meta?: GameHistoryMeta }) => {
    const pgn = typeof params?.pgn === "string" ? params.pgn.trim() : "";
    const meta = params?.meta;
    if (!pgn || !meta) return { ok: false };

    const historyDir = getHistoryDir();
    ensureDirSync(historyDir);

    const index = loadGameIndex();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pgnFile = `${id}.pgn`;
    const pgnPath = path.join(historyDir, pgnFile);

    fs.writeFileSync(pgnPath, pgn, "utf-8");

    index.games.push({ id, pgn_file: pgnFile, meta });
    pruneGameIndex(index);
    saveGameIndex(index);

    return { ok: true, path: pgnPath };
  },
);

ipcMain.handle("list-game-history", () => {
  const historyDir = getHistoryDir();
  ensureDirSync(historyDir);
  return loadGameIndex();
});

ipcMain.handle("load-game-pgn", (_event, params: { id?: string }) => {
  const id = typeof params?.id === "string" ? params.id : "";
  if (!id) return { pgn: "" };
  const index = loadGameIndex();
  const entry = index.games.find((g) => g.id === id);
  if (!entry) return { pgn: "" };
  const pgnPath = path.join(getHistoryDir(), entry.pgn_file);
  if (!fs.existsSync(pgnPath)) return { pgn: "" };
  return { pgn: fs.readFileSync(pgnPath, "utf-8") };
});

ipcMain.handle("get-game-file-path", (_event, params: { id?: string }) => {
  const id = typeof params?.id === "string" ? params.id : "";
  if (!id) return { path: undefined };
  const index = loadGameIndex();
  const entry = index.games.find((g) => g.id === id);
  if (!entry) return { path: undefined };
  const pgnPath = path.join(getHistoryDir(), entry.pgn_file);
  if (!fs.existsSync(pgnPath)) return { path: undefined };
  return { path: pgnPath };
});

ipcMain.handle("delete-game-history", (_event, params: { id?: string }) => {
  const id = typeof params?.id === "string" ? params.id : "";
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

ipcMain.handle(
  "update-game-tags",
  (_event, params: { id?: string; tags?: string[] }) => {
    const id = typeof params?.id === "string" ? params.id : "";
    const tags = Array.isArray(params?.tags)
      ? params?.tags.filter((t) => typeof t === "string")
      : [];
    if (!id) return { ok: false };
    const index = loadGameIndex();
    const entry = index.games.find((g) => g.id === id);
    if (!entry) return { ok: false };
    entry.meta.tags = tags;
    saveGameIndex(index);
    return { ok: true };
  },
);

// ── Cached Elo estimation ───────────────────────────────────────────
interface AccuracyFromPgnResult {
  moves?: Array<{
    uci: string;
    color: string;
    cp_loss: number;
    classification: string;
  }>;
  white_accuracy?: number;
  black_accuracy?: number;
  white_avg_cp_loss?: number;
  black_avg_cp_loss?: number;
  error?: string;
}

/** Compute accuracy for a single saved game and store the result in index.json. */
ipcMain.handle(
  "compute-and-cache-elo",
  async (_event, params: { id: string; stockfish_path?: string }) => {
    const id = typeof params?.id === "string" ? params.id : "";
    console.log("[Elo] compute-and-cache-elo start — id:", id);
    if (!id) {
      console.warn("[Elo] Missing id");
      return { ok: false, error: "Missing id" };
    }

    const index = loadGameIndex();
    const entry = index.games.find((g) => g.id === id);
    if (!entry) {
      console.warn("[Elo] Game not found:", id);
      return { ok: false, error: "Game not found" };
    }

    const pgnPath = path.join(getHistoryDir(), entry.pgn_file);
    if (!fs.existsSync(pgnPath)) {
      console.warn("[Elo] PGN file not found:", pgnPath);
      return { ok: false, error: "PGN file not found" };
    }
    const pgn = fs.readFileSync(pgnPath, "utf-8");
    console.log(
      "[Elo]  PGN loaded —",
      entry.meta.white ?? "?",
      "vs",
      entry.meta.black ?? "?",
      "—",
      entry.meta.moves,
      "moves",
    );

    let result: AccuracyFromPgnResult;
    try {
      result = (await sendCommand("calculate_accuracy_from_pgn", {
        pgn,
        stockfish_path: params?.stockfish_path ?? "",
      })) as AccuracyFromPgnResult;
    } catch (err) {
      console.warn("[Elo]  Stockfish analysis threw:", err);
      return { ok: false, error: String(err) };
    }

    if (result.error) {
      console.warn("[Elo]  Stockfish analysis error:", result.error);
      return { ok: false, error: result.error };
    }

    const rows = result.moves ?? [];
    const blunders = rows.filter((m) => m.classification === "Blunder").length;
    const blunderRate = rows.length > 0 ? blunders / rows.length : 0;
    const whiteLosses = rows
      .filter((m) => m.color === "white")
      .map((m) => m.cp_loss);
    const blackLosses = rows
      .filter((m) => m.color === "black")
      .map((m) => m.cp_loss);
    const allLosses = [...whiteLosses, ...blackLosses];
    const avgCpLoss =
      allLosses.length > 0
        ? allLosses.reduce((a, b) => a + b, 0) / allLosses.length
        : 0;

    const eloCache = {
      white_accuracy: result.white_accuracy ?? 0,
      black_accuracy: result.black_accuracy ?? 0,
      blunder_rate: Math.round(blunderRate * 1000) / 1000,
      avg_cp_loss: Math.round(avgCpLoss * 10) / 10,
      computed_at: new Date().toISOString(),
    };
    console.log(
      "[Elo]  Result — W:",
      eloCache.white_accuracy.toFixed(1),
      "B:",
      eloCache.black_accuracy.toFixed(1),
      "BR:",
      eloCache.blunder_rate,
      "CPL:",
      eloCache.avg_cp_loss,
    );

    // Re-load index to avoid race conditions with other writes
    const freshIndex = loadGameIndex();
    const freshEntry = freshIndex.games.find((g) => g.id === id);
    if (freshEntry) {
      freshEntry.meta.elo_cache = eloCache;
      saveGameIndex(freshIndex);
      console.log("[Elo] compute-and-cache-elo done — cached for", id);
    } else {
      console.warn(
        "[Elo]  Game vanished from index between read and write:",
        id,
      );
    }

    return { ok: true, elo_cache: eloCache };
  },
);

/** Return game IDs (up to 30 most recent) that have no cached elo data. */
ipcMain.handle("get-games-needing-elo", () => {
  const index = loadGameIndex();
  const needing: Array<{ id: string; played_at: string; moves: number }> = [];
  for (const g of index.games) {
    if (!g.meta.elo_cache && g.meta.moves >= 2) {
      needing.push({
        id: g.id,
        played_at: g.meta.played_at,
        moves: g.meta.moves,
      });
    }
  }
  needing.sort((a, b) => b.played_at.localeCompare(a.played_at));
  const result = needing.slice(0, 30);
  console.log(
    "[Elo] get-games-needing-elo —",
    result.length,
    "game(s) without cache (of",
    index.games.length,
    "total)",
  );
  if (result.length > 0)
    console.log(
      "[Elo]   First few:",
      result
        .slice(0, 3)
        .map((g) => g.id)
        .join(", "),
    );
  return result;
});
