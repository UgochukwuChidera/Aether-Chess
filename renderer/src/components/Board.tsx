/**
 * Board.tsx — 8×8 CSS Grid chess board with piece rendering,
 * square highlights, and click/promotion handling.
 */
import React, { useCallback } from 'react';
import { useGameStore } from '../stores/gameStore';
import { useSettingsStore } from '../stores/settingsStore';

// ── Piece icon mapping (Material Symbols names) ───────────────────────────

const PIECE_ICONS: Record<string, string> = {
  P: 'chess_pawn',
  N: 'chess_knight',
  B: 'chess_bishop',
  R: 'chess_rook',
  Q: 'chess_queen',
  K: 'chess_king',
  p: 'chess_pawn',
  n: 'chess_knight',
  b: 'chess_bishop',
  r: 'chess_rook',
  q: 'chess_queen',
  k: 'chess_king',
};

// Parse FEN board part into a 64-element array (index 0 = a8)
function parseFen(fen: string): (string | null)[] {
  const board: (string | null)[] = new Array(64).fill(null);
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, rankIndex) => {
    let fileIndex = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        fileIndex += parseInt(ch);
      } else {
        board[rankIndex * 8 + fileIndex] = ch;
        fileIndex++;
      }
    }
  });
  return board;
}

function indexToAlgebraic(index: number): string {
  const file = 'abcdefgh'[index % 8];
  const rank = 8 - Math.floor(index / 8);
  return `${file}${rank}`;
}

// ── Component ─────────────────────────────────────────────────────────────

interface Props {
  onSquareClick: (sq: string) => void;
}

export const Board: React.FC<Props> = ({ onSquareClick }) => {
  const {
    fen,
    selectedSquare,
    highlightedSquares,
    lastMoveFrom,
    lastMoveTo,
    flipped,
    inCheck,
    turn,
  } = useGameStore();

  const { boardStyle } = useSettingsStore();

  const pieces = parseFen(fen);

  // Find king square for check highlight
  const kingPiece = turn === 'white' ? 'K' : 'k';
  const kingIndex = pieces.findIndex((p) => p === kingPiece);
  const kingSquare = kingIndex >= 0 ? indexToAlgebraic(kingIndex) : null;

  const renderSquare = useCallback(
    (index: number) => {
      const displayIndex = flipped ? 63 - index : index;
      const sq = indexToAlgebraic(displayIndex);
      const piece = pieces[displayIndex];
      const file = displayIndex % 8;
      const rank = Math.floor(displayIndex / 8);
      const isLight = (file + rank) % 2 !== 0;

      // Determine square background class
      let squareClass = isLight
        ? 'bg-surface3'
        : 'bg-surface2';

      // Overlays (last-move < highlight < selected < check)
      const isLastMove = sq === lastMoveFrom || sq === lastMoveTo;
      const isHighlighted = highlightedSquares.includes(sq);
      const isSelected = sq === selectedSquare;
      const isKingInCheck = inCheck && sq === kingSquare;

      // Coordinate labels
      const showFile = flipped ? rank === 0 : rank === 7;
      const showRank = flipped ? file === 7 : file === 0;
      const fileLabel = 'abcdefgh'[file];
      const rankLabel = String(8 - rank);

      return (
        <div
          key={sq}
          data-sq={sq}
          onClick={() => onSquareClick(sq)}
          className={`relative cursor-pointer select-none overflow-hidden
                      ${squareClass}
                      ${isLastMove ? 'sq-last-move' : ''}
                      ${isHighlighted ? 'sq-highlight' : ''}
                      ${isSelected ? 'sq-selected' : ''}
                      ${isKingInCheck ? '!bg-[#93000A]' : ''}
                      transition-colors`}
          style={{ aspectRatio: '1 / 1' }}
        >
          {/* Coordinate labels */}
          {showRank && (
            <span
              className={`absolute top-0.5 left-0.5 text-[9px] font-mono font-semibold leading-none
                          ${isLight ? 'text-surface2' : 'text-surface3'} pointer-events-none`}
            >
              {rankLabel}
            </span>
          )}
          {showFile && (
            <span
              className={`absolute bottom-0.5 right-0.5 text-[9px] font-mono font-semibold leading-none
                          ${isLight ? 'text-surface2' : 'text-surface3'} pointer-events-none`}
            >
              {fileLabel}
            </span>
          )}

          {/* Legal move indicator dot (if no piece on target) */}
          {isHighlighted && !piece && (
            <div
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
            >
              <div className="w-1/3 h-1/3 rounded-full bg-accent opacity-50" />
            </div>
          )}

          {/* Legal move ring (if piece on target) */}
          {isHighlighted && piece && (
            <div className="absolute inset-0 border-2 border-accent rounded pointer-events-none" />
          )}

          {/* Chess piece */}
          {piece && (
            <div className="absolute inset-0 flex items-center justify-center piece-enter">
              <span
                className={`chess-piece material-symbols-outlined
                            ${piece === piece.toUpperCase() ? 'text-on-surface' : 'text-black opacity-90'}`}
                style={{
                  fontSize: 'clamp(20px, 6vmin, 56px)',
                  filter: piece === piece.toUpperCase()
                    ? 'drop-shadow(0 1px 2px rgba(0,0,0,0.8))'
                    : 'drop-shadow(0 1px 1px rgba(255,255,255,0.2))',
                }}
              >
                {PIECE_ICONS[piece]}
              </span>
            </div>
          )}
        </div>
      );
    },
    [pieces, selectedSquare, highlightedSquares, lastMoveFrom, lastMoveTo,
     flipped, inCheck, kingSquare, onSquareClick],
  );

  return (
    <div
      className="grid w-full border border-surface rounded-sm overflow-hidden"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(8, 1fr)',
        gridTemplateRows: 'repeat(8, 1fr)',
        aspectRatio: '1 / 1',
      }}
    >
      {Array.from({ length: 64 }, (_, i) => renderSquare(i))}
    </div>
  );
};
