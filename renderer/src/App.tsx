/**
 * App.tsx — Root component. Manages tab routing, top bar, and global UI chrome.
 */
import { useEffect, useState } from 'react';
import { TopBar } from './components/TopBar';
import { BottomNav, type Tab } from './components/BottomNav';
import { ToastStack } from './components/Toast';
import { PlayView } from './views/PlayView';
import { AnalysisView } from './views/AnalysisView';
import { SettingsView } from './views/SettingsView';
import { ExtensionsView } from './views/ExtensionsView';
import { HistoryView } from './views/HistoryView';
import { useSettingsStore } from './stores/settingsStore';
import { useGameStore } from './stores/gameStore';

const TOP_BAR_H = 64;
const BOTTOM_NAV_H = 64;

export default function App() {
  const [tab, setTab] = useState<Tab>('play');
  const settings = useSettingsStore();
  const store = useGameStore();

  // Load persisted settings on startup
  useEffect(() => {
    settings.loadFromBackend();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  // Wire backend lifecycle toasts (guard for non-Electron environments)
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onBackendError((msg) => {
      store.pushToast(`Backend error: ${msg}`, 'error');
    });
    window.electronAPI.onBackendClosed(() => {
      store.pushToast('Backend process closed unexpectedly', 'error');
    });
  }, []);

  const renderView = () => {
    switch (tab) {
      case 'play':       return <PlayView onTabChange={setTab} />;
      case 'analysis':   return <AnalysisView />;
      case 'settings':   return <SettingsView />;
      case 'extensions': return <ExtensionsView />;
       case 'history':    return <HistoryView />;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-bg overflow-hidden">
      <TopBar
        onMenuClick={() => {/* TODO: slide-out drawer */}}
        onSettingsClick={() => setTab('settings')}
      />

      {/* Scrollable main content */}
      <main
        className="flex-1 overflow-y-auto"
        style={{ marginTop: TOP_BAR_H, marginBottom: BOTTOM_NAV_H }}
      >
        <div className="max-w-lg mx-auto px-6 py-4">
          {renderView()}
        </div>
      </main>

      <BottomNav active={tab} onChange={setTab} />
      <ToastStack />
    </div>
  );
}
