/**
 * PlayView.tsx — Main game play tab.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Board } from '../components/Board';
import { EvalBar } from '../components/EvalBar';
import { PlayerCard } from '../components/PlayerCard';
import { MoveHistory } from '../components/MoveHistory';
import { GameControls } from '../components/GameControls';
import { GameOverModal } from '../components/GameOverModal';
import { PromotionDialog } from '../components/PromotionDialog';
import { useGameStore, type BackendMoveResult } from '../stores/gameStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { Tab } from '../components/BottomNav';

interface Props {
  onTabChange: (tab: Tab) => void;
}
const PLAY_ANALYSIS_CB_ID = 'analysis-play';

/** Return the color of the piece on a given square, or null if empty. */
function pieceColorAt(fen: string, sq: string): 'white' | 'black' | null {
  const rows = fen.split(' ')[0].split('/');
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1]) - 1;
  const fenRankIdx = 7 - rank;
  let col = 0;
  for (const ch of rows[fenRankIdx]) {
    if (/\d/.test(ch)) { col += parseInt(ch); }
    else { if (col === file) return ch === ch.toUpperCase() ? 'white' : 'black'; col++; }
  }
  return null;
}

function isPawnPromotion(fen: string, from: string, to: string): boolean {
  const rows = fen.split(' ')[0].split('/');
  const fromFile = from.charCodeAt(0) - 97;
  const fromRank = parseInt(from[1]) - 1;
  const fenRankIdx = 7 - fromRank;
  let file = 0;
  let piece: string | null = null;
  for (const ch of rows[fenRankIdx]) {
    if (/\d/.test(ch)) { file += parseInt(ch); }
    else { if (file === fromFile) { piece = ch; break; } file++; }
  }
  const toRank = parseInt(to[1]);
  return (piece === 'P' && toRank === 8) || (piece === 'p' && toRank === 1);
}

export const PlayView: React.FC<Props> = ({ onTabChange }) => {
  const store = useGameStore();
  const settings = useSettingsStore();
  const [whiteTime, setWhiteTime] = useState<number | null>(null);
  const [blackTime, setBlackTime] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stockfishDepthForStrength = (strength: number): number => {
    const s = Math.max(1, Math.min(10, strength));
    return 5 + s;
  };
  const botEloForStrength = (strength: number, engine: 'stockfish' | 'mentor'): number => {
    const s = Math.max(1, Math.min(10, strength));
    if (engine === 'stockfish') return Math.round(900 + s * 180);
    return Math.round(850 + s * 170);
  };

  useEffect(() => {
    handleNewGame();
  }, []);

  useEffect(() => {
    window.electronAPI.onAnalysisUpdate((raw: unknown) => {
      const data = raw as { callback_id: string; pvs?: unknown[]; fen?: string; error?: string };
      if (data.callback_id !== PLAY_ANALYSIS_CB_ID) return;
      if (data.error) {
        store.setAnalysis({ running: false });
        return;
      }
      store.setAnalysis({
        pvs: (data.pvs as any[]) ?? [],
        fen: data.fen ?? store.fen,
        running: true,
      });
    });
    return () => {
      window.electronAPI.stopAnalysis().catch(() => {});
      window.electronAPI.removeAnalysisListeners();
    };
  }, []);

  useEffect(() => {
    if (!settings.showEvalBar) {
      store.setAnalysis({ running: false, pvs: [] });
      window.electronAPI.stopAnalysis().catch(() => {});
      return;
    }
    // Stop any previous analysis before starting a new one to avoid
    // stacking concurrent Stockfish processes.
    window.electronAPI.stopAnalysis().catch(() => {}).then(() => {
      window.electronAPI.startAnalysis({
        fen: store.fen,
        multipv: 1,
        callback_id: PLAY_ANALYSIS_CB_ID,
        stockfish_path: settings.stockfishPath,
        threads: settings.threads,
        hash_mb: settings.hashMb,
      }).catch(() => {});
    });
    return () => {
      window.electronAPI.stopAnalysis().catch(() => {});
    };
  }, [
    store.fen,
    settings.showEvalBar,
    settings.stockfishPath,
    settings.threads,
    settings.hashMb,
  ]);

  useEffect(() => {
    if (!store.gameResult) return;
    if (timerRef.current) clearInterval(timerRef.current);
  }, [store.gameResult]);

  useEffect(() => {
    const tc = settings.timeControl;
    if (tc.seconds === 0 || !whiteTime) return;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      if (store.gameResult) { clearInterval(timerRef.current!); return; }
      if (store.turn === 'white') setWhiteTime((t) => t !== null ? Math.max(0, t - 1) : null);
      else setBlackTime((t) => t !== null ? Math.max(0, t - 1) : null);
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [store.turn, store.gameResult]);

  const handleNewGame = async () => {
    try {
      const result = await window.electronAPI.newGame({
        mode: store.mode,
        engine_type: settings.playEngine,
        human_color: store.humanColor,
        strength: settings.botStrength,
        stockfish_path: settings.stockfishPath,
        threads: settings.threads,
        hash_mb: settings.hashMb,
        multipv: settings.multipv,
      }) as BackendMoveResult;
      store.resetGame();
      store.applyMoveResult(result);
      if (settings.timeControl.seconds > 0) {
        setWhiteTime(settings.timeControl.seconds);
        setBlackTime(settings.timeControl.seconds);
      }
    } catch (err) {
      store.pushToast(`Failed to start game: ${err}`, 'error');
    }
  };

  const commitMove = async (moveUCI: string) => {
    store.selectSquare(null);
    store.setEngineBusy(true);
    try {
      const result = await window.electronAPI.makeMove({ move: moveUCI }) as BackendMoveResult;
      store.applyMoveResult(result);

      if (!result.game_over && store.mode === 'human_vs_ai') {
        const reply = settings.playEngine === 'stockfish'
          ? await window.electronAPI.getEngineMove({
            fen: result.fen,
            time_limit: 0.35,
            depth: stockfishDepthForStrength(settings.botStrength),
            stockfish_path: settings.stockfishPath,
            threads: settings.threads,
            hash_mb: settings.hashMb,
          }) as { move: string | null }
          : await window.electronAPI.getBotMove({
            fen: result.fen,
            strength: settings.botStrength,
            stockfish_path: settings.stockfishPath,
            threads: settings.threads,
            hash_mb: settings.hashMb,
          }) as { move: string | null };
        if (reply.move) {
          const engineResult = await window.electronAPI.makeMove({ move: reply.move }) as BackendMoveResult;
          store.applyMoveResult(engineResult);
        }
      }
    } catch (err) {
      store.pushToast(`Move error: ${err}`, 'error');
    } finally {
      store.setEngineBusy(false);
    }
  };

  const handleSquareClick = async (sq: string) => {
    if (store.gameResult || store.engineBusy) return;
    const { selectedSquare, legalMoves, fen, turn } = store;

    // Only own pieces (same color as the side to move) can be selected
    const isOwnPiece = pieceColorAt(fen, sq) === turn;

    if (!selectedSquare) {
      if (isOwnPiece) store.selectSquare(sq);
      return;
    }
    if (sq === selectedSquare) { store.selectSquare(null); return; }

    const moveUCI = legalMoves.find((m) => m.startsWith(selectedSquare) && m.slice(2, 4) === sq);
    if (!moveUCI) {
      // Switch to another own piece, or deselect if clicking empty/opponent square
      if (isOwnPiece) store.selectSquare(sq);
      else store.selectSquare(null);
      return;
    }

    if (!settings.autoQueen && isPawnPromotion(fen, selectedSquare, sq)) {
      store.setPendingPromotion({ from: selectedSquare, to: sq });
      return;
    }
    await commitMove(selectedSquare + sq);
  };

  const handlePromotion = async (piece: string) => {
    const { pendingPromotion } = store;
    if (!pendingPromotion) return;
    store.setPendingPromotion(null);
    await commitMove(`${pendingPromotion.from}${pendingPromotion.to}${piece}`);
  };

  /** Drop-move: fired by Board when a drag-and-drop completes. */
  const handleDropMove = async (from: string, to: string) => {
    if (store.gameResult || store.engineBusy) return;
    store.selectSquare(null);
    const { legalMoves, fen } = store;
    const moveUCI = legalMoves.find((m) => m.startsWith(from) && m.slice(2, 4) === to);
    if (!moveUCI) return;
    if (!settings.autoQueen && isPawnPromotion(fen, from, to)) {
      store.setPendingPromotion({ from, to });
      return;
    }
    await commitMove(from + to);
  };

  const handleUndo = async () => {
    try {
      const result = await window.electronAPI.undoMove() as BackendMoveResult;
      store.applyMoveResult(result);
    } catch (err) {
      store.pushToast(`Undo failed: ${err}`, 'error');
    }
  };

  const handleNavigate = useCallback(async (index: number) => {
    try {
      const result = await window.electronAPI.navigateToMove({ index }) as BackendMoveResult;
      store.applyMoveResult(result);
    } catch {/* ignore */}
  }, []);

  // ── Navigation helpers (used by both buttons and keyboard) ────────────────
  const handleNavFirst = useCallback(() => {
    if (store.fullMoveHistoryUCI.length === 0) return;
    handleNavigate(-1);
  }, [store.fullMoveHistoryUCI.length]);

  const handleNavPrev = useCallback(() => {
    const { navIndex, fullMoveHistoryUCI } = store;
    const len = fullMoveHistoryUCI.length;
    if (len === 0) return;
    if (navIndex < 0) {
      // live end → step back one
      if (len >= 2) handleNavigate(len - 2);
      else handleNavigate(-1); // single-move game → go to start
    } else if (navIndex === 0) {
      handleNavigate(-1); // before first move
    } else {
      handleNavigate(navIndex - 1);
    }
  }, [store.navIndex, store.fullMoveHistoryUCI.length]);

  const handleNavNext = useCallback(() => {
    const { navIndex, fullMoveHistoryUCI } = store;
    const len = fullMoveHistoryUCI.length;
    if (navIndex < 0 || len === 0) return; // already at end
    if (navIndex < len - 1) handleNavigate(navIndex + 1);
    // navIndex === len-1 means we're already at the last navigated position
  }, [store.navIndex, store.fullMoveHistoryUCI.length]);

  const handleNavLast = useCallback(() => {
    const { navIndex, fullMoveHistoryUCI } = store;
    const len = fullMoveHistoryUCI.length;
    if (navIndex < 0 || len === 0) return;
    handleNavigate(len - 1);
  }, [store.navIndex, store.fullMoveHistoryUCI.length]);

  // ── Keyboard hotkeys ──────────────────────────────────────────────────────
  // ←/→ navigate, Home/Ctrl+← first, End/Ctrl+→ last, Ctrl+Z undo, F flip
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when typing in a form field
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
        case 'z':
        case 'Z':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); handleUndo(); }
          break;
        case 'f':
        case 'F':
          store.flipBoard();
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleNavFirst, handleNavPrev, handleNavNext, handleNavLast]);

  const handleResign = () => {
    store.pushToast('You resigned.', 'info');
    useGameStore.setState({ gameResult: store.humanColor === 'white' ? 'black_wins' : 'white_wins', termination: 'RESIGN' });
  };

  const handleDraw = () => store.pushToast('Draw offered (not accepted by engine)', 'info');

  const handleExportPgn = async () => {
    try {
      const res = await window.electronAPI.exportPgn() as { pgn: string };
      await navigator.clipboard.writeText(res.pgn);
      store.pushToast('PGN copied to clipboard', 'success');
    } catch (err) {
      store.pushToast(`Export failed: ${err}`, 'error');
    }
  };

  const opponentIsBlack = store.humanColor === 'white';
  const opponentTurn = store.turn !== store.humanColor;
  const opponentName = settings.playEngine === 'stockfish' ? 'Stockfish' : 'Mentor';
  const opponentElo = botEloForStrength(settings.botStrength, settings.playEngine);

  return (
    <div className="flex flex-col gap-2 w-full">
      <PlayerCard
        name={opponentName}
        elo={opponentElo}
        online={true}
        isUser={false}
        timeSeconds={opponentIsBlack ? blackTime : whiteTime}
        isActive={opponentTurn}
        thinking={store.engineBusy}
      />
      {settings.showEvalBar && <EvalBar />}
      <Board onSquareClick={handleSquareClick} onDropMove={handleDropMove} />
      <PlayerCard
        name="You"
        online={true}
        isUser={true}
        timeSeconds={opponentIsBlack ? whiteTime : blackTime}
        isActive={!opponentTurn}
      />
      <GameControls
        onFlip={store.flipBoard}
        onUndo={handleUndo}
        onDraw={handleDraw}
        onResign={handleResign}
      />
      <MoveHistory
        onMoveClick={handleNavigate}
        onNavFirst={handleNavFirst}
        onNavPrev={handleNavPrev}
        onNavNext={handleNavNext}
        onNavLast={handleNavLast}
      />
      <div className="flex gap-2">
        <button
          onClick={handleExportPgn}
          className="flex-1 py-1.5 border border-surface2 rounded text-xs text-muted font-sans
                     hover:border-accent hover:text-accent active:scale-95 transition-all"
        >
          Copy PGN
        </button>
        <button
          onClick={handleNewGame}
          className="flex-1 py-1.5 bg-accent text-bg rounded text-xs font-sans font-semibold
                     hover:opacity-90 active:scale-95 transition-all"
        >
          New Game
        </button>
      </div>
      {store.pendingPromotion && (
        <PromotionDialog
          color={store.turn}
          onSelect={handlePromotion}
          onCancel={() => store.setPendingPromotion(null)}
        />
      )}
      {store.gameResult && (
        <GameOverModal
          onRematch={handleNewGame}
          onAnalyze={() => onTabChange('analysis')}
          onMenu={handleNewGame}
        />
      )}
    </div>
  );
};
