/**
 * AnalysisView.tsx — Board + live analysis panel.
 */
import React, { useEffect, useRef } from 'react';
import { Board } from '../components/Board';
import { EvalBar } from '../components/EvalBar';
import { MoveHistory } from '../components/MoveHistory';
import { AnalysisPanel } from '../components/AnalysisPanel';
import { useGameStore, type BackendMoveResult } from '../stores/gameStore';
import { useSettingsStore } from '../stores/settingsStore';

const ANALYSIS_CB_ID = 'analysis-main';

export const AnalysisView: React.FC = () => {
  const store = useGameStore();
  const settings = useSettingsStore();
  const runningRef = useRef(false);

  useEffect(() => {
    window.electronAPI.onAnalysisUpdate((raw: unknown) => {
      const data = raw as { type: string; callback_id: string; pvs?: unknown[]; fen?: string; error?: string };
      if (data.callback_id !== ANALYSIS_CB_ID) return;
      if (data.error) {
        store.pushToast(`Analysis error: ${data.error}`, 'error');
        store.setAnalysis({ running: false });
        return;
      }
      store.setAnalysis({ pvs: (data.pvs as any[]) ?? [], fen: data.fen ?? store.fen, running: true });
    });
    return () => { window.electronAPI.removeAnalysisListeners(); };
  }, []);

  const handleStartAnalysis = async () => {
    runningRef.current = true;
    store.setAnalysis({ running: true });
    try {
      await window.electronAPI.startAnalysis({ fen: store.fen, multipv: settings.multipv, callback_id: ANALYSIS_CB_ID });
    } catch (err) {
      store.pushToast(`Analysis failed: ${err}`, 'error');
      store.setAnalysis({ running: false });
    }
  };

  const handleStopAnalysis = async () => {
    runningRef.current = false;
    store.setAnalysis({ running: false });
    await window.electronAPI.stopAnalysis().catch(() => {});
  };

  const handleNavigate = async (index: number) => {
    try {
      const result = await window.electronAPI.navigateToMove({ index }) as BackendMoveResult;
      store.applyMoveResult(result);
      if (runningRef.current) await handleStartAnalysis();
    } catch {/* ignore */}
  };

  return (
    <div className="flex flex-col gap-2 w-full">
      <EvalBar />
      <Board onSquareClick={() => {}} />
      <MoveHistory onMoveClick={handleNavigate} />
      <AnalysisPanel onStartAnalysis={handleStartAnalysis} onStopAnalysis={handleStopAnalysis} />
    </div>
  );
};
