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

  useEffect(() => {
    handleNewGame();
  }, []);

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

  const handleUndo = async () => {
    try {
      const result = await window.electronAPI.undoMove() as BackendMoveResult;
      store.applyMoveResult(result);
    } catch (err) {
      store.pushToast(`Undo failed: ${err}`, 'error');
    }
  };

  const handleNavigate = async (index: number) => {
    try {
      const result = await window.electronAPI.navigateToMove({ index }) as BackendMoveResult;
      store.applyMoveResult(result);
    } catch {/* ignore */}
  };

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

  return (
    <div className="flex flex-col gap-2 w-full">
      <PlayerCard
        name="Aether Bot"
        elo={1800}
        online={true}
        isUser={false}
        timeSeconds={opponentIsBlack ? blackTime : whiteTime}
        isActive={opponentTurn}
      />
      <EvalBar />
      <Board onSquareClick={handleSquareClick} />
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
      <MoveHistory onMoveClick={handleNavigate} />
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
