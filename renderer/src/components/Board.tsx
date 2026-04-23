/**
 * Board.tsx — 8×8 CSS Grid chess board with piece rendering,
 * square highlights, click/promotion handling, and drag-and-drop moves.
 */
import React, { useCallback, useRef } from 'react';
import { useGameStore } from '../stores/gameStore';
import { useSettingsStore } from '../stores/settingsStore';
import { BOARD_STYLES, PIECE_ICONS, PIECE_GLYPHS } from '../config/pieceConfig';

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
  onDropMove?: (from: string, to: string) => void;
}

export const Board: React.FC<Props> = ({ onSquareClick, onDropMove }) => {
  const {
    fen,
    selectedSquare,
    highlightedSquares,
    lastMoveFrom,
    lastMoveTo,
    flipped,
    inCheck,
    turn,
    selectSquare,
  } = useGameStore();

  const { boardStyle, pieceSet } = useSettingsStore();

  // Tracks the square where a drag originated
  const dragFromRef = useRef<string | null>(null);

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
      const style = BOARD_STYLES[boardStyle] ?? BOARD_STYLES.classic;
      const squareBackground = isLight ? style.light : style.dark;

      // Overlays (last-move < highlight < selected < check)
      const isLastMove = sq === lastMoveFrom || sq === lastMoveTo;
      const isHighlighted = highlightedSquares.includes(sq);
      const isSelected = sq === selectedSquare;
      const isKingInCheck = inCheck && sq === kingSquare;

      // Only own pieces (matching the side to move) are draggable
      const isOwnPiece = piece && (
        (turn === 'white' && piece === piece.toUpperCase()) ||
        (turn === 'black' && piece === piece.toLowerCase())
      );

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
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            e.preventDefault();
            const from = dragFromRef.current;
            dragFromRef.current = null;
            if (from && from !== sq && onDropMove) {
              onDropMove(from, sq);
            }
          }}
          className={`relative cursor-pointer select-none overflow-hidden
                      ${isLastMove ? 'sq-last-move' : ''}
                      ${isHighlighted ? 'sq-highlight' : ''}
                      ${isSelected ? 'sq-selected' : ''}
                      ${isKingInCheck ? '!bg-[#93000A]' : ''}
                      transition-colors`}
          style={{ aspectRatio: '1 / 1', background: squareBackground }}
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
          {piece && pieceSet === 'material' && (
            <div
              className="absolute inset-0 flex items-center justify-center piece-enter"
              draggable={!!isOwnPiece}
              onDragStart={(e) => {
                if (!isOwnPiece) {
                  e.preventDefault();
                  return;
                }
                dragFromRef.current = sq;
                e.dataTransfer.effectAllowed = 'move';
                selectSquare(sq);
              }}
              onDragEnd={() => {
                if (dragFromRef.current !== null) {
                  dragFromRef.current = null;
                  selectSquare(null);
                }
              }}
            >
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
          {piece && pieceSet === 'alpha' && (
            <div
              className="absolute inset-0 flex items-center justify-center piece-enter"
              draggable={!!isOwnPiece}
              onDragStart={(e) => {
                if (!isOwnPiece) {
                  e.preventDefault();
                  return;
                }
                dragFromRef.current = sq;
                e.dataTransfer.effectAllowed = 'move';
                selectSquare(sq);
              }}
              onDragEnd={() => {
                if (dragFromRef.current !== null) {
                  dragFromRef.current = null;
                  selectSquare(null);
                }
              }}
            >
              <span
                className={`${piece === piece.toUpperCase() ? 'text-white' : 'text-black'} pointer-events-none`}
                style={{
                  fontSize: 'clamp(20px, 5.5vmin, 52px)',
                  lineHeight: 1,
                  textShadow: piece === piece.toUpperCase()
                    ? '0 1px 2px rgba(0,0,0,0.8)'
                    : '0 1px 1px rgba(255,255,255,0.25)',
                }}
              >
                {PIECE_GLYPHS[piece]}
              </span>
            </div>
          )}
          {piece && pieceSet === 'neo' && (
            <div
              className="absolute inset-0 flex items-center justify-center piece-enter"
              draggable={!!isOwnPiece}
              onDragStart={(e) => {
                if (!isOwnPiece) {
                  e.preventDefault();
                  return;
                }
                dragFromRef.current = sq;
                e.dataTransfer.effectAllowed = 'move';
                selectSquare(sq);
              }}
              onDragEnd={() => {
                if (dragFromRef.current !== null) {
                  dragFromRef.current = null;
                  selectSquare(null);
                }
              }}
            >
              <span
                className="pointer-events-none"
                style={{
                  fontSize: 'clamp(20px, 5.8vmin, 54px)',
                  lineHeight: 1,
                  color: piece === piece.toUpperCase() ? '#FCD34D' : '#1E293B',
                  textShadow: piece === piece.toUpperCase()
                    ? '0 0 6px rgba(252,211,77,0.6), 0 1px 3px rgba(0,0,0,0.9)'
                    : '0 1px 2px rgba(255,255,255,0.3)',
                }}
              >
                {PIECE_GLYPHS[piece]}
              </span>
            </div>
          )}
        </div>
      );
    },
    [pieces, selectedSquare, highlightedSquares, lastMoveFrom, lastMoveTo,
     flipped, inCheck, kingSquare, boardStyle, pieceSet, onSquareClick,
     onDropMove, turn, selectSquare],
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
