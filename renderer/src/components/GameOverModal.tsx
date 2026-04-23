/**
 * GameOverModal.tsx — Centered result card shown when the game ends.
 */
import React from 'react';
import { useGameStore, type GameResult } from '../stores/gameStore';

const RESULT_LABELS: Record<NonNullable<GameResult>, string> = {
  white_wins: '♔ White wins!',
  black_wins: '♚ Black wins!',
  draw:       '½–½ Draw',
};

const TERMINATION_LABELS: Record<string, string> = {
  CHECKMATE: 'by checkmate',
  STALEMATE: 'by stalemate',
  INSUFFICIENT_MATERIAL: 'insufficient material',
  SEVENTYFIVE_MOVES: '75-move rule',
  FIVEFOLD_REPETITION: 'fivefold repetition',
  FIFTY_MOVES: '50-move rule',
  THREEFOLD_REPETITION: 'threefold repetition',
};

interface Props {
  onRematch: () => void;
  onAnalyze: () => void;
  onMenu: () => void;
}

export const GameOverModal: React.FC<Props> = ({ onRematch, onAnalyze, onMenu }) => {
  const { gameResult, termination, setGameResult } = useGameStore();

  if (!gameResult) return null;

  const terminationLabel = termination
    ? TERMINATION_LABELS[termination] ?? termination.toLowerCase()
    : '';

  const handleDismiss = () => {
    setGameResult(null);
    setGameResult(null);
    useGameStore.setState({ gameResult: null, termination: null });
  };

  return (
    <div className="fixed inset-0 z-50 modal-backdrop flex items-center justify-center p-6">
      <div
        className="bg-surface border border-surface2 rounded-card p-6 w-80 shadow-2xl
                   flex flex-col items-center gap-4"
      >
        {/* Result icon */}
        <div className="w-16 h-16 rounded-full bg-accent-dim flex items-center justify-center glow-accent">
          <span className="material-symbols-outlined text-accent filled" style={{ fontSize: 36 }}>
            emoji_events
          </span>
        </div>

        {/* Result text */}
        <div className="text-center">
          <h2 className="text-xl font-sans font-bold text-on-surface">
            {RESULT_LABELS[gameResult]}
          </h2>
          {terminationLabel && (
            <p className="text-sm text-muted mt-1 capitalize">{terminationLabel}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 w-full">
          <button
            onClick={onRematch}
            className="w-full py-2.5 bg-accent text-bg rounded-lg font-sans font-semibold text-sm
                       hover:opacity-90 active:scale-95 transition-all"
          >
            Rematch
          </button>
          <button
            onClick={onAnalyze}
            className="w-full py-2.5 border border-surface2 text-on-surface rounded-lg font-sans text-sm
                       hover:border-accent hover:text-accent active:scale-95 transition-all"
          >
            Analyze game
          </button>
          <button
            onClick={handleDismiss}
            className="w-full py-2 border border-surface2 text-on-surface rounded-lg font-sans text-sm
                       hover:border-accent hover:text-accent active:scale-95 transition-all"
          >
            Review game
          </button>
          <button
            onClick={onMenu}
            className="w-full py-2 text-muted font-sans text-sm hover:text-accent transition-colors"
          >
            New game
          </button>
        </div>
      </div>
    </div>
  );
};
