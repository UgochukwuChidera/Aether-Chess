/**
 * SettingsPanel.tsx — Full-page settings view with collapsible sections.
 */
import React, { useEffect, useState } from 'react';
import {
  useSettingsStore,
  TIME_CONTROLS,
  MAX_HASH_MB,
  type Theme,
  type PlayEngine,
  type AnimationSpeed,
} from '../stores/settingsStore';
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
        <span className="material-symbols-outlined text-muted" style={{ fontSize: 18 }}>{icon}</span>
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

const Row: React.FC<{ label: string; children: React.ReactNode; tooltip?: string }> = ({ label, children, tooltip }) => (
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

export const SettingsPanel: React.FC = () => {
  const settings = useSettingsStore();
  const [cpuCount, setCpuCount] = useState(4);
  const [stockfishInfo, setStockfishInfo] = useState<{
    configuredPath: string | null;
    configuredExists: boolean;
    bundledPath: string | null;
    bundledExists: boolean;
    settingsPath: string;
  } | null>(null);
  const [bookMoves, setBookMoves] = useState(0);
  const [loadingBook, setLoadingBook] = useState(false);

  useEffect(() => {
    window.electronAPI.getCpuCount().then(setCpuCount);
    window.electronAPI.getStockfishInfo().then(setStockfishInfo).catch(() => {});
  }, []);

  // Load book moves count when opening book path changes
  useEffect(() => {
    if (!settings.useOpeningBook) {
      setBookMoves(0);
      return;
    }
    setLoadingBook(true);
    window.electronAPI.getBookMoves({ fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' })
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
      window.electronAPI.getStockfishInfo().then(setStockfishInfo).catch(() => {});
    } catch (err) {
      console.error('Failed to pick Stockfish:', err);
    }
  };

  const handleUseBundledStockfish = () => {
    const path = stockfishInfo?.bundledPath;
    if (!path) return;
    settings.update({ stockfishPath: path });
    window.electronAPI.getStockfishInfo().then(setStockfishInfo).catch(() => {});
  };

  const handleExportSettings = () => {
    const { loaded: _l, update: _u, loadFromBackend: _lf, saveToBackend: _sb, ...data } = settings;
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
              <option key={key} value={key}>{cfg.label}</option>
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
              <option key={key} value={key}>{cfg.label}</option>
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
        <Row 
          label="Play engine" 
          tooltip="Mentor plays like human mistakes. Stockfish is pure engine."
        >
          <select
            className={selectClass}
            value={settings.playEngine}
            onChange={(e) => settings.update({ playEngine: e.target.value as PlayEngine })}
          >
            <option value="mentor">Mentor (your bot)</option>
            <option value="stockfish">Stockfish</option>
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
        <Row label="Stockfish path" tooltip="Path to Stockfish executable">
          <div className="flex items-center gap-1">
            <span className="text-xs font-mono text-muted truncate max-w-[120px]" title={settings.stockfishPath}>
              {settings.stockfishPath.split(/[\\/]/).pop() ?? settings.stockfishPath}
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
          <span className={`text-xs ${stockfishInfo?.configuredExists ? 'text-accent' : 'text-error'}`}>
            {stockfishInfo?.configuredExists ? 'Configured path is valid' : 'Configured path not found'}
          </span>
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
        {!stockfishInfo?.bundledExists && (
          <Row label="Download Stockfish">
            <button
              onClick={() => window.electronAPI.openExternalUrl('https://stockfishchess.org/download/')}
              className="px-2 py-1 border border-surface2 rounded text-xs text-muted
                         hover:border-accent hover:text-accent transition-colors"
            >
              Open official download page
            </button>
          </Row>
        )}
        <Row label={`Threads (1–${cpuCount})`} tooltip="CPU threads for Stockfish. More = faster but more CPU usage.">
          <input
            type="range" min={1} max={cpuCount} step={1}
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
            {[16, 32, 64, 128, 256, 512, 1024, 2048].map((v) => (
              <option key={v} value={v}>{v} MB</option>
            ))}
          </select>
        </Row>
        <p className="text-[10px] text-muted -mt-2 px-0.5">
          Hash = Stockfish transposition table — a RAM cache of analysed positions.
          Larger cache = deeper searches &amp; faster re-analysis, at the cost of memory.
          <br />
          <span className="font-semibold">Presets:</span>{' '}
          low-end 64 MB / 1 thread · mid-range 256 MB / 2 threads · high-end 512 MB / 4+ threads.
          Max allowed: {MAX_HASH_MB} MB.
          {settings.hashMb > 512 && (
            <span className="text-yellow-400"> ⚠ Large cache — ensure you have enough free RAM.</span>
          )}
        </p>
        <Row label="Multi-PV lines" tooltip="Number of principal variations to show. More lines = more info but slower.">
          <select
            className={selectClass}
            value={settings.multipv}
            onChange={(e) => settings.update({ multipv: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </Row>
        <Row label="Bot difficulty" tooltip="AI strength 1 (Beginner) to 10 (Grandmaster). Affects search time and depth.">
          <input
            type="range" min={1} max={10} step={1}
            value={settings.botStrength}
            onChange={(e) => settings.update({ botStrength: Number(e.target.value) })}
            className="w-28 accent-[#A3E635]"
          />
          <span className="text-xs font-mono text-muted w-5 text-right">{settings.botStrength}</span>
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
              <option key={v} value={v}>{v} plies ({Math.floor(v/2)} moves)</option>
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
              <option key={tc.label} value={tc.label}>{tc.label}</option>
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
              type="range" min={0} max={1} step={0.05}
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
