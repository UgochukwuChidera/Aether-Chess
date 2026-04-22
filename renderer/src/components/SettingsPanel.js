"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsPanel = void 0;
/**
 * SettingsPanel.tsx — Full-page settings view with collapsible sections.
 */
const react_1 = require("react");
const settingsStore_1 = require("../stores/settingsStore");
const Section = ({ title, icon, children }) => {
    const [open, setOpen] = (0, react_1.useState)(true);
    return (<div className="border border-surface2 rounded-card overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-4 py-3 bg-surface hover:bg-surface2 transition-colors">
        <span className="material-symbols-outlined text-muted" style={{ fontSize: 18 }}>{icon}</span>
        <span className="flex-1 text-left text-sm font-sans font-semibold text-on-surface">{title}</span>
        <span className="material-symbols-outlined text-inactive" style={{ fontSize: 18 }}>
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>
      {open && <div className="px-4 py-3 bg-bg flex flex-col gap-4">{children}</div>}
    </div>);
};
const Label = ({ children }) => (<span className="text-xs font-sans text-muted">{children}</span>);
const Row = ({ label, children }) => (<div className="flex items-center gap-3">
    <Label>{label}</Label>
    <div className="flex-1 flex justify-end">{children}</div>
  </div>);
const selectClass = 'bg-surface border border-surface2 text-on-surface text-xs font-body rounded px-2 py-1.5' +
    ' hover:border-accent focus:border-accent focus:outline-none transition-colors';
const SettingsPanel = () => {
    const settings = (0, settingsStore_1.useSettingsStore)();
    const [cpuCount, setCpuCount] = (0, react_1.useState)(4);
    (0, react_1.useEffect)(() => {
        window.electronAPI.getCpuCount().then(setCpuCount);
    }, []);
    const handleStockfishPick = async () => {
        const p = await window.electronAPI.pickStockfishPath();
        if (p)
            settings.update({ stockfishPath: p });
    };
    const handleExportSettings = () => {
        const { loaded, update, loadFromBackend, saveToBackend, ...data } = settings;
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
            const file = e.target.files?.[0];
            if (!file)
                return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                settings.update(data);
            }
            catch {
                /* ignore malformed */
            }
        };
        input.click();
    };
    return (<div className="flex flex-col gap-3 w-full pb-4">
      <h2 className="text-base font-sans font-bold text-on-surface px-1">Settings</h2>

      {/* ── Appearance ──────────────────────────────────────────────────── */}
      <Section title="Appearance" icon="palette">
        <Row label="Theme">
          <select className={selectClass} value={settings.theme} onChange={(e) => settings.update({ theme: e.target.value })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="high-contrast">High Contrast</option>
          </select>
        </Row>
        <Row label="Board style">
          <select className={selectClass} value={settings.boardStyle} onChange={(e) => settings.update({ boardStyle: e.target.value })}>
            <option value="classic">Classic</option>
            <option value="wood">Wood</option>
            <option value="marble">Marble</option>
            <option value="neon">Neon</option>
          </select>
        </Row>
        <Row label="Piece set">
          <select className={selectClass} value={settings.pieceSet} onChange={(e) => settings.update({ pieceSet: e.target.value })}>
            <option value="material">Material Symbols</option>
            <option value="alpha">Alpha (SVG)</option>
          </select>
        </Row>
        <Row label="Animation speed">
          <select className={selectClass} value={settings.animationSpeed} onChange={(e) => settings.update({ animationSpeed: e.target.value })}>
            <option value="slow">Slow</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
            <option value="off">Off</option>
          </select>
        </Row>
      </Section>

      {/* ── Engine ──────────────────────────────────────────────────────── */}
      <Section title="Engine" icon="memory">
        <Row label="Stockfish path">
          <div className="flex items-center gap-1">
            <span className="text-xs font-mono text-muted truncate max-w-[120px]" title={settings.stockfishPath}>
              {settings.stockfishPath.split(/[\\/]/).pop() ?? settings.stockfishPath}
            </span>
            <button onClick={handleStockfishPick} className="px-2 py-1 border border-surface2 rounded text-xs text-muted
                         hover:border-accent hover:text-accent transition-colors">
              Browse
            </button>
          </div>
        </Row>
        <Row label={`Threads (1–${cpuCount})`}>
          <input type="range" min={1} max={cpuCount} step={1} value={settings.threads} onChange={(e) => settings.update({ threads: Number(e.target.value) })} className="w-28 accent-[#A3E635]"/>
          <span className="text-xs font-mono text-muted w-5 text-right">{settings.threads}</span>
        </Row>
        <Row label="Hash (MB)">
          <select className={selectClass} value={settings.hashMb} onChange={(e) => settings.update({ hashMb: Number(e.target.value) })}>
            {[16, 32, 64, 128, 256, 512, 1024, 2048].map((v) => (<option key={v} value={v}>{v} MB</option>))}
          </select>
        </Row>
        <Row label="Multi-PV lines">
          <select className={selectClass} value={settings.multipv} onChange={(e) => settings.update({ multipv: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5].map((v) => (<option key={v} value={v}>{v}</option>))}
          </select>
        </Row>
        <Row label="Bot difficulty">
          <input type="range" min={1} max={10} step={1} value={settings.botStrength} onChange={(e) => settings.update({ botStrength: Number(e.target.value) })} className="w-28 accent-[#A3E635]"/>
          <span className="text-xs font-mono text-muted w-5 text-right">{settings.botStrength}</span>
        </Row>
      </Section>

      {/* ── Gameplay ────────────────────────────────────────────────────── */}
      <Section title="Gameplay" icon="sports_esports">
        <Row label="Time control">
          <select className={selectClass} value={settings.timeControl.label} onChange={(e) => {
            const tc = settingsStore_1.TIME_CONTROLS.find((t) => t.label === e.target.value);
            if (tc)
                settings.update({ timeControl: tc });
        }}>
            {settingsStore_1.TIME_CONTROLS.map((tc) => (<option key={tc.label} value={tc.label}>{tc.label}</option>))}
          </select>
        </Row>
        <Row label="Auto-queen">
          <input type="checkbox" checked={settings.autoQueen} onChange={(e) => settings.update({ autoQueen: e.target.checked })} className="accent-[#A3E635] w-4 h-4"/>
        </Row>
        <Row label="Sound">
          <input type="checkbox" checked={settings.soundEnabled} onChange={(e) => settings.update({ soundEnabled: e.target.checked })} className="accent-[#A3E635] w-4 h-4"/>
        </Row>
        {settings.soundEnabled && (<Row label="Volume">
            <input type="range" min={0} max={1} step={0.05} value={settings.soundVolume} onChange={(e) => settings.update({ soundVolume: Number(e.target.value) })} className="w-28 accent-[#A3E635]"/>
          </Row>)}
      </Section>

      {/* ── Data & Privacy ──────────────────────────────────────────────── */}
      <Section title="Data & Privacy" icon="folder">
        <div className="flex gap-2">
          <button onClick={handleExportSettings} className="flex-1 py-2 border border-surface2 rounded-lg text-xs font-sans text-muted
                       hover:border-accent hover:text-accent active:scale-95 transition-all">
            Export settings
          </button>
          <button onClick={handleImportSettings} className="flex-1 py-2 border border-surface2 rounded-lg text-xs font-sans text-muted
                       hover:border-accent hover:text-accent active:scale-95 transition-all">
            Import settings
          </button>
        </div>
      </Section>
    </div>);
};
exports.SettingsPanel = SettingsPanel;
