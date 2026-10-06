/**
 * SettingsPanel.tsx — Full-page settings view with collapsible sections.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  useSettingsStore,
  TIME_CONTROLS,
  type Theme,
  type AnimationSpeed,
} from '../stores/settingsStore';
import { useGameStore } from '../stores/gameStore';
import { BOARD_STYLES, PIECE_SETS, type BoardStyle, type PieceSet } from '../config/pieceConfig';

interface SectionProps {
  title: string;
  icon: string;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ title, icon, children }) => {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-surface2 rounded-card overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 bg-surface hover:bg-surface2 transition-colors"
      >
        <span className="material-symbols-outlined text-muted" style={{ fontSize: 18 }}>
          {icon}
        </span>
        <span className="flex-1 text-left text-sm font-sans font-semibold text-on-surface">{title}</span>
        <span className="material-symbols-outlined text-inactive" style={{ fontSize: 18 }}>
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>
      {open && <div className="px-4 py-3 bg-bg flex flex-col gap-4">{children}</div>}
    </div>
  );
};

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-xs font-sans text-muted">{children}</span>
);

const Row: React.FC<{ label: string; children: React.ReactNode; tooltip?: string }> = ({
  label,
  children,
  tooltip,
}) => (
  <div className="flex items-center gap-3 group relative">
    <Label>{label}</Label>
    <div className="flex-1 flex justify-end">{children}</div>
    {tooltip && (
      <div className="absolute right-0 top-full mt-1 w-48 p-2 bg-surface2 border border-surface rounded text-[10px] text-muted opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none">
        {tooltip}
      </div>
    )}
  </div>
);

const selectClass =
  'bg-surface border border-surface2 text-on-surface text-xs font-body rounded px-2 py-1.5' +
  ' hover:border-accent focus:border-accent focus:outline-none transition-colors';

/**
 * Whether a stored engine path means "let the app decide". Must stay in step
 * with isAutoPath() in the main process, since this decides whether the
 * dropdown shows Auto as the active choice.
 */
const isAutoEnginePath = (value: string): boolean => {
  const trimmed = value.trim().toLowerCase();
  if (['', 'auto', 'default', 'stockfish'].includes(trimmed)) return true;
  // A bare name with no separator is a PATH lookup, not a chosen file.
  return !trimmed.includes('/') && !trimmed.includes('\\');
};

const basename = (value: string): string => value.split(/[\\/]/).pop() ?? value;

/** Friendly wording for where an engine was found, instead of the raw enum. */
const sourceLabel = (source: StockfishEngineSource): string => {
  switch (source) {
    case 'path':
      return 'on PATH';
    case 'app-engines':
      return 'in app folder';
    case 'user-engines':
      return 'in user folder';
    case 'bundled':
      return 'bundled';
    case 'configured':
      return 'your choice';
    default:
      return source;
  }
};

export const SettingsPanel: React.FC = () => {
  const settings = useSettingsStore();
  const [cpuCount, setCpuCount] = useState(4);
  const [stockfishInfo, setStockfishInfo] = useState<{
    configuredPath: string | null;
    configuredExists: boolean;
    bundledPath: string | null;
    bundledExists: boolean;
    engines: StockfishEngine[];
    resolvedPath: string | null;
    appEnginesDir: string;
    userEnginesDir: string;
    settingsPath: string;
  } | null>(null);
  const [bookMoves, setBookMoves] = useState(0);
  const [loadingBook, setLoadingBook] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [modelCached, setModelCached] = useState<Record<string, boolean>>({});
  // Discovery starts engines, so it is not instant on first use. Tracked
  // separately from stockfishInfo so a slow scan reads as "still looking"
  // rather than "no engine installed".
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // The selectable bots come from the backend rather than a hard-coded list, so
  // a discovered Stockfish build or a bot added later appears here by itself.
  const [bots, setBots] = useState<BotInfo[]>([]);

  const refreshBots = useCallback(() => {
    return window.electronAPI
      .listBots()
      .then((res) => setBots(res.bots))
      .catch((err: unknown) => {
        // Keep whatever is already listed. Emptying the list would read as
        // "this install has no bots", which is a different and wrong claim.
        console.error('Bot discovery failed', err);
      });
  }, []);

  const refreshStockfish = useCallback(() => {
    setScanning(true);
    return window.electronAPI
      .getStockfishInfo()
      .then((info) => {
        setStockfishInfo(info);
        setScanError(null);
      })
      .catch((err: unknown) => {
        // Never swallow this: without it a failed scan is indistinguishable
        // from having no engine installed.
        console.error('Stockfish discovery failed', err);
        setScanError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setScanning(false));
  }, []);

  useEffect(() => {
    window.electronAPI.getCpuCount().then(setCpuCount);
    void refreshStockfish();
    void refreshBots();
  }, [refreshStockfish, refreshBots]);

  // Changing the configured path can make a different Stockfish build available
  // or take one away, so availability is re-read rather than fixed at load.
  useEffect(() => {
    void refreshBots();
  }, [refreshBots, settings.stockfishPath]);

  // Check cache status whenever the selected model changes
  useEffect(() => {
    window.electronAPI
      .checkMaia3Cache({ model: settings.maia3Model })
      .then((res) => setModelCached((prev) => ({ ...prev, [res.model]: res.cached })))
      .catch(() => {});
  }, [settings.maia3Model]);

  // Load book moves count when opening book path changes
  useEffect(() => {
    if (!settings.useOpeningBook) {
      setBookMoves(0);
      return;
    }
    setLoadingBook(true);
    window.electronAPI
      .getBookMoves({ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' })
      .then((res) => {
        const data = res as { moves?: { uci: string; weight: number }[] };
        setBookMoves(data.moves?.length ?? 0);
      })
      .catch(() => setBookMoves(0))
      .finally(() => setLoadingBook(false));
  }, [settings.useOpeningBook, settings.openingBookPath]);

  const handleStockfishPick = async () => {
    try {
      const p = await window.electronAPI.pickStockfishPath();
      if (p) settings.update({ stockfishPath: p });
      void refreshStockfish();
    } catch (err) {
      console.error('Failed to pick Stockfish:', err);
    }
  };

  const handleUseBundledStockfish = () => {
    const path = stockfishInfo?.bundledPath;
    if (!path) return;
    settings.update({ stockfishPath: path });
    void refreshStockfish();
  };

  /** "Auto" defers to the resolver: PATH first, then the app's engines folder. */
  const handleUseAutoStockfish = () => {
    settings.update({ stockfishPath: 'stockfish' });
    void refreshStockfish();
  };

  const handleSelectDiscovered = (enginePath: string) => {
    settings.update({ stockfishPath: enginePath });
    void refreshStockfish();
  };

  const handleRevealEnginesDir = async () => {
    try {
      await window.electronAPI.revealEnginesDir();
    } catch (err) {
      console.error('Failed to open engines folder:', err);
    }
  };

  const handleExportSettings = () => {
    // P3-T02: runtime-only store fields stay out of the exported file; schemaVersion travels with it.
    const { loaded: _l, update: _u, loadFromBackend: _lf, saveToBackend: _sb, limits: _lim, saveError: _e, ...data } = settings;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aether-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportSettings = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        settings.update(data);
      } catch {
        /* ignore malformed */
      }
    };
    input.click();
  };

  return (
    <div className="flex flex-col gap-3 w-full pb-4">
      <h2 className="text-base font-sans font-bold text-on-surface px-1">Settings</h2>

      {/* ── Appearance ──────────────────────────────────────────────────── */}
      <Section title="Appearance" icon="palette">
        <Row label="Theme">
          <select
            className={selectClass}
            value={settings.theme}
            onChange={(e) => settings.update({ theme: e.target.value as Theme })}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="high-contrast">High Contrast</option>
          </select>
        </Row>
        <Row label="Board style">
          <select
            className={selectClass}
            value={settings.boardStyle}
            onChange={(e) => settings.update({ boardStyle: e.target.value as BoardStyle })}
          >
            {(Object.entries(BOARD_STYLES) as [BoardStyle, { label: string }][]).map(([key, cfg]) => (
              <option key={key} value={key}>
                {cfg.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Piece set">
          <select
            className={selectClass}
            value={settings.pieceSet}
            onChange={(e) => settings.update({ pieceSet: e.target.value as PieceSet })}
          >
            {(Object.entries(PIECE_SETS) as [PieceSet, { label: string }][]).map(([key, cfg]) => (
              <option key={key} value={key}>
                {cfg.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Animation speed">
          <select
            className={selectClass}
            value={settings.animationSpeed}
            onChange={(e) => settings.update({ animationSpeed: e.target.value as AnimationSpeed })}
          >
            <option value="slow">Slow</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
            <option value="off">Off</option>
          </select>
        </Row>
      </Section>

      {/* ── Engine ──────────────────────────────────────────────────────── */}
      <Section title="Engine" icon="memory">
        <Row label="Play engine" tooltip="Any bot this install can run. Each discovered Stockfish build is listed separately.">
          <select
            className={selectClass}
            value={settings.playEngine}
            onChange={(e) => settings.update({ playEngine: e.target.value })}
          >
            {bots.length === 0 ? (
              <option value="" disabled>Could not load the bot list</option>
            ) : (
              bots.map((bot) => (
                <option key={bot.bot_id} value={bot.bot_id} disabled={!bot.available}>
                  {bot.display_name}{bot.available ? '' : ' (unavailable)'}
                </option>
              ))
            )}
          </select>
        </Row>
        {settings.playEngine === 'mentor' && (
          <Row
            label="Use custom eval"
            tooltip="Enable MentorEngine's Stockfish-style evaluation. Disable to use Stockfish eval only."
          >
            <input
              type="checkbox"
              checked={settings.useMentorEval}
              onChange={(e) => settings.update({ useMentorEval: e.target.checked })}
              className="accent-[#A3E635] w-4 h-4"
            />
          </Row>
        )}
        <Row label="Stockfish engine" tooltip="Which Stockfish build to use">
          <div className="flex items-center gap-1">
            <select
              value={
                !settings.stockfishPath || isAutoEnginePath(settings.stockfishPath)
                  ? '__auto__'
                  : settings.stockfishPath
              }
              onChange={(e) => {
                if (e.target.value === '__auto__') handleUseAutoStockfish();
                else if (e.target.value === '__browse__') handleStockfishPick();
                else handleSelectDiscovered(e.target.value);
              }}
              className="bg-surface2 border border-surface2 rounded text-xs text-fg px-1 py-1
                         max-w-[150px] focus:border-accent outline-none
                         disabled:opacity-50 disabled:cursor-wait"
              disabled={scanning}
            >
              <option value="__auto__">
                Auto{stockfishInfo?.resolvedPath ? ` (${basename(stockfishInfo.resolvedPath)})` : ''}
              </option>
              {stockfishInfo?.engines.map((engine) => (
                <option key={engine.path} value={engine.path}>
                  {engine.name}
                  {engine.source !== 'path' ? ` — ${sourceLabel(engine.source)}` : ''}
                </option>
              ))}
              <option value="__browse__">Browse for a file…</option>
            </select>
            {scanning && <span className="text-xs text-muted">Scanning…</span>}
          </div>
        </Row>
        {stockfishInfo && stockfishInfo.engines.length > 1 && (
          <Row label="Installed versions" tooltip="Every Stockfish build found on this machine">
            <span className="text-xs text-muted">{stockfishInfo.engines.length} found</span>
          </Row>
        )}
        <Row label="Stockfish path" tooltip="Path to Stockfish executable">
          <div className="flex items-center gap-1">
            <span className="text-xs font-mono text-muted truncate max-w-[120px]" title={settings.stockfishPath}>
              {basename(settings.stockfishPath)}
            </span>
            <button
              onClick={handleStockfishPick}
              className="px-2 py-1 border border-surface2 rounded text-xs text-muted
                         hover:border-accent hover:text-accent transition-colors"
            >
              Browse
            </button>
          </div>
        </Row>
        <Row label="Stockfish status">
          <span className={`text-xs ${scanError || !stockfishInfo?.resolvedPath ? 'text-error' : 'text-accent'}`}>
            {scanning
              ? 'Looking for Stockfish builds…'
              : scanError
                ? `Could not search for Stockfish: ${scanError}`
                : stockfishInfo?.resolvedPath
                  ? `Using ${basename(stockfishInfo.resolvedPath)}`
                  : 'No Stockfish found — install one or drop a binary in the engines folder'}
          </span>
        </Row>
        <Row label="Engines folder" tooltip="Drop a downloaded Stockfish binary here">
          <div className="flex items-center gap-1">
            <span className="text-xs font-mono text-muted truncate max-w-[120px]" title={stockfishInfo?.userEnginesDir}>
              {stockfishInfo?.userEnginesDir.split(/[\\/]/).slice(-2).join('/') ?? 'engines/'}
            </span>
            <button
              onClick={handleRevealEnginesDir}
              className="px-2 py-1 border border-surface2 rounded text-xs text-muted
                         hover:border-accent hover:text-accent transition-colors"
            >
              Open
            </button>
          </div>
        </Row>
        {stockfishInfo?.bundledExists && (
          <Row label="Bundled Stockfish">
            <button
              onClick={handleUseBundledStockfish}
              className="px-2 py-1 border border-surface2 rounded text-xs text-muted
                         hover:border-accent hover:text-accent transition-colors"
            >
              Use bundled binary
            </button>
          </Row>
        )}
        <Row label="Download Stockfish">
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.electronAPI.openExternalUrl('https://stockfishchess.org/download/')}
              className="px-2 py-1 border border-surface2 rounded text-xs text-muted
                         hover:border-accent hover:text-accent transition-colors"
            >
              Open official download page
            </button>
            <span className="text-[11px] text-muted">then drop the file in the engines folder above</span>
          </div>
        </Row>
        {settings.playEngine === 'maia3' && (
          <Row label="Maia3 path" tooltip="Optional: custom maia3-uci executable path">
            <div className="flex items-center gap-1">
              <span className="text-xs font-mono text-muted truncate max-w-[120px]" title={settings.maia3Path}>
                {settings.maia3Path ? settings.maia3Path.split(/[\\/]/).pop() : 'python -m maia3.uci'}
              </span>
              <button
                onClick={async () => {
                  try {
                    const p = await window.electronAPI.pickStockfishPath();
                    if (p) settings.update({ maia3Path: p });
                  } catch (err) {
                    console.error('Failed to pick Maia3 path:', err);
                  }
                }}
                className="px-2 py-1 border border-surface2 rounded text-xs text-muted
                           hover:border-accent hover:text-accent transition-colors"
              >
                Browse
              </button>
            </div>
          </Row>
        )}
        <Row label={`Threads (1–${Math.min(cpuCount, settings.limits.maxThreads)})`} tooltip="CPU threads for Stockfish. More = faster but more CPU usage.">
          <input
            type="range"
            min={1}
            max={Math.min(cpuCount, settings.limits.maxThreads)}
            step={1}
            value={settings.threads}
            onChange={(e) => settings.update({ threads: Number(e.target.value) })}
            className="w-28 accent-[#A3E635]"
          />
          <span className="text-xs font-mono text-muted w-5 text-right">{settings.threads}</span>
        </Row>
        <Row label="Hash (MB)" tooltip="Transposition table size. Larger = deeper searches, more RAM usage.">
          <select
            className={selectClass}
            value={settings.hashMb}
            onChange={(e) => settings.update({ hashMb: Number(e.target.value) })}
          >
            {[16, 32, 64, 128, 256, 512, 1024, 2048]
              .filter((v) => v <= settings.limits.maxHashMb)
              .map((v) => (
                <option key={v} value={v}>
                  {v} MB
                </option>
              ))}
          </select>
        </Row>
        <p className="text-[10px] text-muted -mt-2 px-0.5">
          Hash = Stockfish transposition table — a RAM cache of analysed positions. Larger cache = deeper searches &amp;
          faster re-analysis, at the cost of memory.
          <br />
          <span className="font-semibold">Presets:</span> low-end 64 MB / 1 thread · mid-range 256 MB / 2 threads ·
          high-end 512 MB / 4+ threads. Max allowed: {settings.limits.maxHashMb} MB.
        </p>
        <Row
          label="Multi-PV lines"
          tooltip="Number of principal variations to show. More lines = more info but slower."
        >
          <select
            className={selectClass}
            value={settings.multipv}
            onChange={(e) => settings.update({ multipv: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="Bot difficulty"
          tooltip="AI strength 1 (Beginner) to 10 (Grandmaster). Affects search time and depth."
        >
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={settings.botStrength}
            onChange={(e) => settings.update({ botStrength: Number(e.target.value) })}
            className="w-28 accent-[#A3E635]"
          />
          <span className="text-xs font-mono text-muted w-5 text-right">{settings.botStrength}</span>
        </Row>
        {settings.playEngine === 'maia3' && (
          <>
            <Row label="Maia3 model" tooltip="Pretrained model size/strength">
              <select
                className={selectClass}
                value={settings.maia3Model}
                onChange={(e) => settings.update({ maia3Model: e.target.value })}
              >
                {['maia3-5m', 'maia3-23m', 'maia3-79m'].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Maia3 device" tooltip="CPU is slower but no GPU required">
              <select
                className={selectClass}
                value={settings.maia3Device}
                onChange={(e) => settings.update({ maia3Device: e.target.value as 'cpu' | 'cuda' })}
              >
                <option value="cpu">CPU</option>
                <option value="cuda">CUDA</option>
              </select>
            </Row>
            <Row
              label="Maia3 cache"
              tooltip="Download model weights to project_dir/model_cache/ (check console for progress)"
            >
              <div className="flex items-center gap-2">
                <button
                  disabled={downloading}
                  onClick={async () => {
                    setDownloading(true);
                    const toast = useGameStore.getState().pushToast;
                    toast(`Downloading ${settings.maia3Model}...`, 'info');
                    try {
                      const result = (await Promise.race([
                        window.electronAPI.maia3Cache({ model: settings.maia3Model }),
                        new Promise<never>((_, reject) =>
                          setTimeout(() => reject(new Error('Download timed out after 5 min')), 300_000),
                        ),
                      ])) as { ok?: boolean };
                      if (result?.ok) {
                        setModelCached((prev) => ({ ...prev, [settings.maia3Model]: true }));
                        toast(`Downloaded ${settings.maia3Model} successfully`, 'success');
                      }
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err);
                      toast(`Download failed: ${msg}`, 'error');
                      console.error('Failed to cache Maia3 model:', err);
                    } finally {
                      setDownloading(false);
                    }
                  }}
                  className={`px-2 py-1 border rounded text-xs transition-colors ${
                    downloading
                      ? 'border-accent text-accent bg-accent/10 cursor-wait'
                      : 'border-surface2 text-muted hover:border-accent hover:text-accent'
                  }`}
                >
                  {downloading
                    ? `Downloading ${settings.maia3Model}...`
                    : modelCached[settings.maia3Model]
                      ? `Cached ${settings.maia3Model}`
                      : `Download ${settings.maia3Model}`}
                </button>
              </div>
            </Row>
            <Row label="Elo rating" tooltip="Maia3 skill level from 0 (weak) to 5000 (strong). Default 1500.">
              <input
                type="range"
                min={0}
                max={3000}
                step={100}
                value={settings.maia3Elo}
                onChange={(e) => settings.update({ maia3Elo: Number(e.target.value) })}
                className="w-28 accent-[#A3E635]"
              />
              <span className="text-xs font-mono text-muted w-10 text-right">{settings.maia3Elo}</span>
            </Row>
          </>
        )}
        <Row
          label="Think profile"
          tooltip="Controls move-to-move think-time distribution. Budget-aware — won't exceed clock."
        >
          <select
            className={selectClass}
            value={settings.thinkProfile}
            onChange={(e) => settings.update({ thinkProfile: e.target.value })}
          >
            <option value="blitz">Blitz (fast, 1-8s)</option>
            <option value="rapid">Rapid (balanced, 2-15s)</option>
            <option value="classical">Classical (deep, 2-5s)</option>
            <option value="human_like">Human-like (natural varied)</option>
          </select>
        </Row>
      </Section>

      {/* ── Opening Book ────────────────────────────────────────────────────── */}
      <Section title="Opening Book" icon="menu_book">
        <Row label="Use book">
          <input
            type="checkbox"
            checked={settings.useOpeningBook}
            onChange={(e) => settings.update({ useOpeningBook: e.target.checked })}
            className="accent-[#A3E635] w-4 h-4"
          />
        </Row>
        <Row label="Book directory">
          <span className="text-xs font-mono text-muted truncate max-w-[120px]" title={settings.openingBookPath}>
            {settings.openingBookPath.split(/[\\/]/).pop() ?? settings.openingBookPath}
          </span>
          <button
            onClick={async () => {
              try {
                const dir = await window.electronAPI.getBooksDir();
                if (dir) settings.update({ openingBookPath: dir });
              } catch (err) {
                console.error('Failed to pick books folder:', err);
              }
            }}
            className="px-2 py-1 border border-surface2 rounded text-xs text-muted
                       hover:border-accent hover:text-accent transition-colors"
          >
            Browse
          </button>
        </Row>
        <Row label="Book depth (plies)">
          <select
            className={selectClass}
            value={settings.openingBookDepth}
            onChange={(e) => settings.update({ openingBookDepth: Number(e.target.value) })}
          >
            {[10, 14, 18, 20, 24, 28, 30, 40].map((v) => (
              <option key={v} value={v}>
                {v} plies ({Math.floor(v / 2)} moves)
              </option>
            ))}
          </select>
        </Row>
        <p className="text-[10px] text-muted -mt-1 px-0.5">
          How far into the opening to use book moves. 20 plies = 10 moves each side.
        </p>
        <Row label="Book status">
          <span className="text-xs text-muted font-mono">
            {loadingBook ? 'Loading...' : bookMoves > 0 ? `${bookMoves} moves` : 'No book found'}
          </span>
        </Row>
      </Section>

      {/* ── Endgame Tablebases (P4-T01: detect-and-report when unconfigured) ── */}
      <Section title="Endgame Tablebases" icon="grid_on">
        <Row label="Tablebase directory" tooltip="Folder holding Syzygy .rtbw/.rtbz files. Empty means unconfigured — endgame hints stay off.">
          <input
            type="text"
            value={settings.tablebasePath}
            onChange={(e) => settings.update({ tablebasePath: e.target.value })}
            placeholder="No tablebases (optional)"
            className="bg-surface border border-surface2 text-on-surface text-xs font-mono rounded px-2 py-1.5 w-48 hover:border-accent focus:border-accent focus:outline-none transition-colors"
          />
        </Row>
        <p className="text-[10px] text-muted -mt-1 px-0.5">
          Optional Syzygy path for endgame hints. See docs/SETUP.md — no tablebase data ships with the app.
        </p>
      </Section>

      {/* ── Gameplay ────────────────────────────────────────────────────── */}
      <Section title="Gameplay" icon="sports_esports">
        <Row label="Time control">
          <select
            className={selectClass}
            value={settings.timeControl.label}
            onChange={(e) => {
              const tc = TIME_CONTROLS.find((t) => t.label === e.target.value);
              if (tc) settings.update({ timeControl: tc });
            }}
          >
            {TIME_CONTROLS.map((tc) => (
              <option key={tc.label} value={tc.label}>
                {tc.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Auto-queen" tooltip="Automatically promote pawns to queen on promotion.">
          <input
            type="checkbox"
            checked={settings.autoQueen}
            onChange={(e) => settings.update({ autoQueen: e.target.checked })}
            className="accent-[#A3E635] w-4 h-4"
          />
        </Row>
        <Row label="Show eval bar" tooltip="Show evaluation bar above the board (white advantage vs black).">
          <input
            type="checkbox"
            checked={settings.showEvalBar}
            onChange={(e) => settings.update({ showEvalBar: e.target.checked })}
            className="accent-[#A3E635] w-4 h-4"
          />
        </Row>
        <Row label="Show arrows while thinking" tooltip="Show best move arrows before you make your move.">
          <input
            type="checkbox"
            checked={settings.showArrowsBeforeMove}
            onChange={(e) => settings.update({ showArrowsBeforeMove: e.target.checked })}
            className="accent-[#A3E635] w-4 h-4"
          />
        </Row>
        <Row label="Sound" tooltip="Enable game sounds (move, capture, check, checkmate).">
          <input
            type="checkbox"
            checked={settings.soundEnabled}
            onChange={(e) => settings.update({ soundEnabled: e.target.checked })}
            className="accent-[#A3E635] w-4 h-4"
          />
        </Row>
        {settings.soundEnabled && (
          <Row label="Volume">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.soundVolume}
              onChange={(e) => settings.update({ soundVolume: Number(e.target.value) })}
              className="w-28 accent-[#A3E635]"
            />
          </Row>
        )}
      </Section>

      {/* ── Analysis ────────────────────────────────────────────────────── */}
      <Section title="Analysis" icon="analytics">
        <Row label="Show threats" tooltip="Show opponent's threatening moves (red arrows).">
          <input
            type="checkbox"
            checked={settings.showAnalysisThreats}
            onChange={(e) => settings.update({ showAnalysisThreats: e.target.checked })}
            className="accent-[#A3E635] w-4 h-4"
          />
        </Row>
        <Row label="Show top move" tooltip="Show best move (gold arrow) from engine analysis.">
          <input
            type="checkbox"
            checked={settings.showAnalysisTopMoves}
            onChange={(e) => settings.update({ showAnalysisTopMoves: e.target.checked })}
            className="accent-[#A3E635] w-4 h-4"
          />
        </Row>
        <Row label="Show alternatives" tooltip="Show other good moves considered by the engine.">
          <input
            type="checkbox"
            checked={settings.showAnalysisTopAlternatives}
            onChange={(e) => settings.update({ showAnalysisTopAlternatives: e.target.checked })}
            className="accent-[#A3E635] w-4 h-4"
          />
        </Row>
      </Section>

      {/* ── Data & Privacy ──────────────────────────────────────────────── */}
      <Section title="Data & Privacy" icon="folder">
        <Row label="Auto-save games" tooltip="Save completed games to history automatically as PGN + metadata.">
          <input
            type="checkbox"
            checked={settings.autoSaveGameHistory}
            onChange={(e) => settings.update({ autoSaveGameHistory: e.target.checked })}
            className="accent-[#A3E635] w-4 h-4"
          />
        </Row>
        <p className="text-[11px] text-muted break-all">Settings file: {stockfishInfo?.settingsPath ?? 'loading...'}</p>
        <div className="flex gap-2">
          <button
            onClick={handleExportSettings}
            className="flex-1 py-2 border border-surface2 rounded-lg text-xs font-sans text-muted
                       hover:border-accent hover:text-accent active:scale-95 transition-all"
          >
            Export settings
          </button>
          <button
            onClick={handleImportSettings}
            className="flex-1 py-2 border border-surface2 rounded-lg text-xs font-sans text-muted
                       hover:border-accent hover:text-accent active:scale-95 transition-all"
          >
            Import settings
          </button>
        </div>
      </Section>
    </div>
  );
};
