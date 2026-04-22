"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MoveHistory = void 0;
/**
 * MoveHistory.tsx — Scrollable two-column move list with current-move highlight.
 */
const react_1 = require("react");
const gameStore_1 = require("../stores/gameStore");
const MoveHistory = ({ onMoveClick }) => {
    const { moveHistory, navIndex } = (0, gameStore_1.useGameStore)();
    const listRef = (0, react_1.useRef)(null);
    // Scroll current move into view
    (0, react_1.useEffect)(() => {
        const el = listRef.current?.querySelector('[data-current="true"]');
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [moveHistory.length, navIndex]);
    // Pair moves: [white, black?][]
    const pairs = [];
    for (let i = 0; i < moveHistory.length; i += 2) {
        pairs.push([moveHistory[i], moveHistory[i + 1]]);
    }
    const currentMoveIndex = navIndex < 0 ? moveHistory.length - 1 : navIndex;
    return (<div ref={listRef} className="w-full overflow-y-auto rounded-card bg-surface border border-surface2" style={{ height: 160 }}>
      {pairs.length === 0 && (<div className="flex items-center justify-center h-full text-muted text-xs font-body">
          No moves yet
        </div>)}
      {pairs.map(([white, black], pairIdx) => {
            const whiteIdx = pairIdx * 2;
            const blackIdx = pairIdx * 2 + 1;
            const isWhiteCurrent = currentMoveIndex === whiteIdx;
            const isBlackCurrent = currentMoveIndex === blackIdx;
            return (<div key={pairIdx} className="flex items-stretch text-xs font-mono hover:bg-surface2 transition-colors">
            {/* Move number */}
            <span className="w-8 flex-shrink-0 flex items-center justify-end pr-2 text-muted select-none">
              {pairIdx + 1}.
            </span>

            {/* White move */}
            <button data-current={isWhiteCurrent || undefined} onClick={() => onMoveClick?.(whiteIdx)} className={`flex-1 text-left px-1 py-0.5 truncate transition-colors
                          ${isWhiteCurrent
                    ? 'text-accent border-l-2 border-accent bg-accent-dim'
                    : 'text-on-surface hover:text-accent'}`}>
              {white.san}
            </button>

            {/* Black move */}
            <button data-current={isBlackCurrent || undefined} onClick={() => black && onMoveClick?.(blackIdx)} className={`flex-1 text-left px-1 py-0.5 truncate transition-colors
                          ${isBlackCurrent
                    ? 'text-accent border-l-2 border-accent bg-accent-dim'
                    : 'text-muted hover:text-accent'}`}>
              {black?.san ?? ''}
            </button>
          </div>);
        })}
    </div>);
};
exports.MoveHistory = MoveHistory;
