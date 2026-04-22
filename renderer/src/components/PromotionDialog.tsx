/**
 * PromotionDialog.tsx — Piece-selection overlay when a pawn reaches the back rank.
 */
import React from 'react';
import { useSettingsStore } from '../stores/settingsStore';

const PIECES = [
  { symbol: 'chess_queen',  label: 'Queen',  code: 'q' },
  { symbol: 'chess_rook',   label: 'Rook',   code: 'r' },
  { symbol: 'chess_bishop', label: 'Bishop', code: 'b' },
  { symbol: 'chess_knight', label: 'Knight', code: 'n' },
];

const PIECE_GLYPHS: Record<string, string> = {
  q: '♛',
  r: '♜',
  b: '♝',
  n: '♞',
};

interface Props {
  color: 'white' | 'black';
  onSelect: (piece: string) => void;
  onCancel: () => void;
}

export const PromotionDialog: React.FC<Props> = ({ color, onSelect, onCancel }) => (
  <PromotionContent color={color} onSelect={onSelect} onCancel={onCancel} />
);

const PromotionContent: React.FC<Props> = ({ color, onSelect, onCancel }) => {
  const pieceSet = useSettingsStore((s) => s.pieceSet);
  return (
    <div
      className="fixed inset-0 z-50 modal-backdrop flex items-center justify-center p-6"
      onClick={onCancel}
    >
      <div
        className="bg-surface border border-surface2 rounded-card p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-sans text-muted text-center mb-3">Promote pawn to:</p>
        <div className="flex gap-3">
          {PIECES.map(({ symbol, label, code }) => (
            <button
              key={code}
              onClick={() => onSelect(code)}
              className="flex flex-col items-center gap-1 p-3 rounded-lg border border-surface2
                         hover:border-accent hover:bg-accent-dim active:scale-95 transition-all group"
              aria-label={label}
            >
              {pieceSet === 'material' ? (
                <span
                  className={`material-symbols-outlined chess-piece group-hover:text-accent
                              ${color === 'white' ? 'text-on-surface' : 'text-black opacity-90'}`}
                  style={{ fontSize: 40 }}
                >
                  {symbol}
                </span>
              ) : (
                <span
                  className={`group-hover:text-accent ${color === 'white' ? 'text-on-surface' : 'text-black opacity-90'}`}
                  style={{ fontSize: 40, lineHeight: 1 }}
                >
                  {PIECE_GLYPHS[code]}
                </span>
              )}
              <span className="text-[10px] text-muted group-hover:text-accent font-sans">{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
