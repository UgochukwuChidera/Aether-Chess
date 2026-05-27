/**
 * AnalysisView.tsx — Board + live analysis panel.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { Board } from '../components/Board';
import { EvalBar } from '../components/EvalBar';
import { MoveHistory } from '../components/MoveHistory';
import { AnalysisPanel } from '../components/AnalysisPanel';
import { useGameStore, type AccuracyMoveResult, type BackendMoveResult, type PVLine } from '../stores/gameStore';
import { useSettingsStore } from '../stores/settingsStore';

const ANALYSIS_CB_ID = 'analysis-main';

export const AnalysisView: React.FC = () => {
  const store = useGameStore();
  const settings = useSettingsStore();
  const runningRef = useRef(false);
  const [accuracyLoading, setAccuracyLoading] = React.useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    window.electronAPI.onAnalysisUpdate((raw: unknown) => {
      const data = raw as { type: string; callback_id: string; pvs?: unknown[]; fen?: string; error?: string };
      if (data.callback_id !== ANALYSIS_CB_ID) return;
      if (data.error) {
        store.pushToast(`Analysis error: ${data.error}`, 'error');
        store.setAnalysis({ running: false });
        return;
      }
      store.setAnalysis({ pvs: (data.pvs as PVLine[]) ?? [], fen: data.fen ?? store.fen, running: true });
    });
    return () => {
      window.electronAPI.stopAnalysis().catch(() => {});
      window.electronAPI.removeAnalysisListeners();
    };
  }, []);

  // Stop analysis immediately on FEN / settings change; debounce the restart
  // so rapid navigation through the move list doesn't spawn many Stockfish processes.
  useEffect(() => {
    void window.electronAPI.stopAnalysis().catch(() => {});
    store.setAnalysis({ running: false });

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void handleStartAnalysis();
    }, 350);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [store.fen, settings.multipv, settings.stockfishPath, settings.threads, settings.hashMb]);

  async function handleStartAnalysis() {
    runningRef.current = true;
    store.setAnalysis({ running: true });
    try {
    await window.electronAPI.startAnalysis({
      fen: store.fen,
      multipv: settings.multipv,
      callback_id: ANALYSIS_CB_ID,
      stockfish_path: settings.stockfishPath,
      engine_type: settings.playEngine === 'maia3' ? 'stockfish' : settings.playEngine,
      threads: settings.threads,
      hash_mb: settings.hashMb,
    });
    } catch (err) {
      store.pushToast(`Analysis failed: ${err}`, 'error');
      store.setAnalysis({ running: false });
    }
  }

  async function handleStopAnalysis() {
    runningRef.current = false;
    store.setAnalysis({ running: false });
    await window.electronAPI.stopAnalysis().catch(() => {});
  }

  const handleNavigate = useCallback(async (index: number) => {
    try {
      const result = await window.electronAPI.navigateToMove({ index }) as BackendMoveResult;
      store.applyMoveResult(result);
      if (runningRef.current) await handleStartAnalysis();
    } catch {/* ignore */}
  }, []);

  const handleComputeAccuracy = async () => {
    setAccuracyLoading(true);
    try {
      const res = await window.electronAPI.calculateAccuracyFromHistory({
        stockfish_path: settings.stockfishPath,
      }) as {
        moves: AccuracyMoveResult[];
        white_accuracy: number;
        black_accuracy: number;
        error?: string;
      };
      if (res.error) {
        store.pushToast(res.error, 'error');
        return;
      }
      store.applyAccuracyResults(res.moves ?? []);
      store.pushToast(
        `CAPS complete — White ${res.white_accuracy?.toFixed?.(1) ?? res.white_accuracy}% | Black ${res.black_accuracy?.toFixed?.(1) ?? res.black_accuracy}%`,
        'success',
      );
    } catch (err) {
      store.pushToast(`CAPS/ACPL failed: ${err}`, 'error');
    } finally {
      setAccuracyLoading(false);
    }
  };

  // ── Navigation helpers ────────────────────────────────────────────────────
  const handleNavFirst = useCallback(() => {
    if (store.fullMoveHistoryUCI.length === 0) return;
    handleNavigate(-1);
  }, [store.fullMoveHistoryUCI.length]);

  const handleNavPrev = useCallback(() => {
    const { navIndex, fullMoveHistoryUCI } = store;
    const len = fullMoveHistoryUCI.length;
    if (len === 0) return;
    if (navIndex < 0) {
      if (len >= 2) handleNavigate(len - 2);
      else handleNavigate(-1);
    } else if (navIndex === 0) {
      handleNavigate(-1);
    } else {
      handleNavigate(navIndex - 1);
    }
  }, [store.navIndex, store.fullMoveHistoryUCI.length]);

  const handleNavNext = useCallback(() => {
    const { navIndex, fullMoveHistoryUCI } = store;
    const len = fullMoveHistoryUCI.length;
    if (navIndex < 0 || len === 0) return;
    if (navIndex < len - 1) handleNavigate(navIndex + 1);
  }, [store.navIndex, store.fullMoveHistoryUCI.length]);

  const handleNavLast = useCallback(() => {
    const { navIndex, fullMoveHistoryUCI } = store;
    const len = fullMoveHistoryUCI.length;
    if (navIndex < 0 || len === 0) return;
    handleNavigate(len - 1);
  }, [store.navIndex, store.fullMoveHistoryUCI.length]);

  // ── Keyboard hotkeys ──────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) handleNavFirst();
          else handleNavPrev();
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) handleNavLast();
          else handleNavNext();
          break;
        case 'Home':
          e.preventDefault();
          handleNavFirst();
          break;
        case 'End':
          e.preventDefault();
          handleNavLast();
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleNavFirst, handleNavPrev, handleNavNext, handleNavLast]);

  return (
      <div className="flex flex-col gap-2 w-full">
      {settings.showEvalBar && <EvalBar />}
      <Board
        onSquareClick={() => {}}
        showArrowsFromAnalysis={true}
        analysisPV={store.analysis.pvs[0]?.pv ?? []}
        analysisAltPVs={store.analysis.pvs.slice(1).map((p) => p.pv)}
        showThreatPV={store.analysis.pvs[0]?.pv?.slice(1, 5) ?? []}
      />
      <MoveHistory
        onMoveClick={handleNavigate}
        onNavFirst={handleNavFirst}
        onNavPrev={handleNavPrev}
        onNavNext={handleNavNext}
        onNavLast={handleNavLast}
      />
      <AnalysisPanel
        onStartAnalysis={handleStartAnalysis}
        onStopAnalysis={handleStopAnalysis}
        onComputeAccuracy={handleComputeAccuracy}
        accuracyLoading={accuracyLoading}
      />
    </div>
  );
};
