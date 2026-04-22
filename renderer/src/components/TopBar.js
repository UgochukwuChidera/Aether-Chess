"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TopBar = void 0;
/**
 * TopBar.tsx — Fixed 64px frameless app bar with drag region, window controls,
 * and nav hamburger.
 */
const react_1 = require("react");
const TopBar = ({ title = 'AETHER CHESS', onMenuClick, onSettingsClick }) => {
    const [maximized, setMaximized] = (0, react_1.useState)(false);
    (0, react_1.useEffect)(() => {
        window.electronAPI.isMaximized().then(setMaximized);
    }, []);
    const handleMaximize = async () => {
        window.electronAPI.maximize();
        const m = await window.electronAPI.isMaximized();
        setMaximized(m);
    };
    return (<header className="drag-region fixed top-0 left-0 right-0 z-50 flex items-center h-16
                 bg-bg border-b border-surface2 px-4" style={{ height: 64 }}>
      {/* Hamburger menu */}
      <button className="no-drag w-10 h-10 flex items-center justify-center rounded-lg
                   text-muted hover:text-accent transition-colors mr-2" onClick={onMenuClick} aria-label="Menu">
        <span className="material-symbols-outlined" style={{ fontSize: 24 }}>menu</span>
      </button>

      {/* App title */}
      <span className="flex-1 font-sans font-bold text-base tracking-widest text-accent text-glow-accent">
        {title}
      </span>

      {/* Settings icon */}
      <button className="no-drag w-10 h-10 flex items-center justify-center rounded-lg
                   text-muted hover:text-accent transition-colors" onClick={onSettingsClick} aria-label="Settings">
        <span className="material-symbols-outlined" style={{ fontSize: 22 }}>settings</span>
      </button>

      {/* Window controls */}
      <div className="no-drag flex items-center ml-2 gap-1">
        <button onClick={() => window.electronAPI.minimize()} className="w-8 h-8 flex items-center justify-center rounded text-inactive
                     hover:text-on-surface hover:bg-surface2 transition-colors" aria-label="Minimize">
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>remove</span>
        </button>
        <button onClick={handleMaximize} className="w-8 h-8 flex items-center justify-center rounded text-inactive
                     hover:text-on-surface hover:bg-surface2 transition-colors" aria-label={maximized ? 'Restore' : 'Maximize'}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
            {maximized ? 'filter_none' : 'crop_square'}
          </span>
        </button>
        <button onClick={() => window.electronAPI.close()} className="w-8 h-8 flex items-center justify-center rounded text-inactive
                     hover:text-error hover:bg-[#93000A] transition-colors" aria-label="Close">
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
        </button>
      </div>
    </header>);
};
exports.TopBar = TopBar;
