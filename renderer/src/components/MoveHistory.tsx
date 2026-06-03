/**
 * MoveHistory.tsx — Scrollable two-column move list with current-move highlight
 * and |< < > >| navigation controls.
 */
import React, { useEffect, useRef } from 'react';
import { useGameStore, type MoveEntry } from '../stores/gameStore';

interface Props {
  onMoveClick?: (index: number) => void;
  onNavFirst?: () => void;
  onNavPrev?: () => void;
  onNavNext?: () => void;
  onNavLast?: () => void;
  fillHeight?: boolean;
}

export const MoveHistory: React.FC<Props> = ({
  onMoveClick,
  onNavFirst,
  onNavPrev,
  onNavNext,
  onNavLast,
  fillHeight = false,
}) => {
  const { moveHistory, navIndex } = useGameStore();
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll current move into view — confined to the container only,
  // so the page viewport never jumps when a move is played.
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>('[data-current="true"]');
    if (!el) return;
    const parentTop = container.scrollTop;
    const parentBot = parentTop + container.clientHeight;
    const childTop  = el.offsetTop;
    const childBot  = childTop + el.offsetHeight;
    if (childTop < parentTop) {
      container.scrollTop = childTop;
    } else if (childBot > parentBot) {
      container.scrollTop = childBot - container.clientHeight;
    }
  }, [moveHistory.length, navIndex]);

  // Pair moves: [white, black?][]
  const pairs: [MoveEntry, MoveEntry | undefined][] = [];
  for (let i = 0; i < moveHistory.length; i += 2) {
    pairs.push([moveHistory[i], moveHistory[i + 1]]);
  }

  const currentMoveIndex = navIndex < 0 ? moveHistory.length - 1 : navIndex;
  const atStart = navIndex < 0 && moveHistory.length === 0;
  const atEnd   = navIndex < 0;

  return (
    <div className={`flex flex-col w-full gap-1 ${fillHeight ? 'flex-1 min-h-0' : ''}`}>
      {/* Move list */}
      <div
        ref={listRef}
        className={`w-full overflow-y-auto rounded-card bg-surface border border-surface2 ${fillHeight ? 'flex-1 min-h-0' : ''}`}
        style={fillHeight ? undefined : { height: 160 }}
      >
        {pairs.length === 0 && (
          <div className="flex items-center justify-center h-full text-muted text-xs font-body">
            No moves yet
          </div>
        )}
        {pairs.map(([white, black], pairIdx) => {
          const whiteIdx = pairIdx * 2;
          const blackIdx = pairIdx * 2 + 1;
          const isWhiteCurrent = currentMoveIndex === whiteIdx;
          const isBlackCurrent = currentMoveIndex === blackIdx;

          return (
            <div
              key={pairIdx}
              className="flex items-stretch text-xs font-mono hover:bg-surface2 transition-colors"
            >
              {/* Move number */}
              <span className="w-8 flex-shrink-0 flex items-center justify-end pr-2 text-muted select-none">
                {pairIdx + 1}.
              </span>

              {/* White move */}
              <button
                data-current={isWhiteCurrent || undefined}
                onClick={() => onMoveClick?.(whiteIdx)}
                className={`flex-1 text-left px-1 py-0.5 truncate transition-colors
                            ${isWhiteCurrent
                              ? 'text-accent border-l-2 border-accent bg-accent-dim'
                              : 'text-on-surface hover:text-accent'}`}
              >
                {white.san}
              </button>

              {/* Black move */}
              <button
                data-current={isBlackCurrent || undefined}
                onClick={() => black && onMoveClick?.(blackIdx)}
                className={`flex-1 text-left px-1 py-0.5 truncate transition-colors
                            ${isBlackCurrent
                              ? 'text-accent border-l-2 border-accent bg-accent-dim'
                              : 'text-muted hover:text-accent'}`}
              >
                {black?.san ?? ''}
              </button>
            </div>
          );
        })}
      </div>

      {/* Navigation controls */}
      <div className="flex gap-1 w-full">
        {(
          [
            { icon: 'skip_previous',    label: 'First',    fn: onNavFirst, disabled: atStart || moveHistory.length === 0 },
            { icon: 'navigate_before',  label: 'Prev',     fn: onNavPrev,  disabled: atStart || moveHistory.length === 0 },
            { icon: 'navigate_next',    label: 'Next',     fn: onNavNext,  disabled: atEnd },
            { icon: 'skip_next',        label: 'Last',     fn: onNavLast,  disabled: atEnd },
          ] as const
        ).map(({ icon, label, fn, disabled }) => (
          <button
            key={label}
            onClick={fn}
            disabled={disabled || !fn}
            title={label}
            aria-label={label}
            className="flex-1 flex items-center justify-center py-1
                       border border-surface2 rounded text-muted bg-surface
                       hover:border-accent hover:text-accent active:scale-95
                       disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{icon}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
