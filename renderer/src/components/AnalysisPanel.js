"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnalysisPanel = void 0;
/**
 * AnalysisPanel.tsx — Engine evaluation panel for the Analysis tab.
 * Shows real-time PV lines, evaluation score, and move classifications.
 */
const react_1 = require("react");
const gameStore_1 = require("../stores/gameStore");
const CLASSIFICATION_COLORS = {
    Brilliant: 'text-[#00b0ff] border-[#00b0ff]',
    Great: 'text-accent border-accent',
    Best: 'text-accent border-accent',
    Inaccuracy: 'text-yellow-400 border-yellow-400',
    Mistake: 'text-orange-400 border-orange-400',
    Blunder: 'text-error border-error',
    Book: 'text-muted border-muted',
};
function formatScore(cp, mate) {
    if (mate !== null)
        return mate > 0 ? `M${Math.abs(mate)}` : `-M${Math.abs(mate)}`;
    const sign = cp >= 0 ? '+' : '';
    return `${sign}${(cp / 100).toFixed(2)}`;
}
const AnalysisPanel = ({ onStartAnalysis, onStopAnalysis }) => {
    const { analysis, moveHistory } = (0, gameStore_1.useGameStore)();
    const { pvs, running } = analysis;
    return (<div className="flex flex-col gap-3 w-full">
      {/* Control row */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-sans text-muted flex-1">Stockfish Analysis</span>
        <button onClick={running ? onStopAnalysis : onStartAnalysis} className={`px-3 py-1 rounded text-xs font-sans border transition-all active:scale-95
                      ${running
            ? 'border-error text-error hover:bg-[#93000A]'
            : 'border-surface2 text-muted hover:border-accent hover:text-accent'}`}>
          {running ? 'Stop' : 'Analyse'}
        </button>
      </div>

      {/* PV lines */}
      {pvs.length === 0 && !running && (<p className="text-xs text-muted font-body text-center py-4">
          Press Analyse to start engine evaluation.
        </p>)}
      {pvs.map((pv, i) => (<PVLineRow key={i} pv={pv} rank={i}/>))}

      {/* Move classification table */}
      {moveHistory.length > 0 && (<MoveClassificationTable />)}
    </div>);
};
exports.AnalysisPanel = AnalysisPanel;
const PVLineRow = ({ pv, rank }) => {
    const scoreLabel = formatScore(pv.score_cp, pv.mate);
    const isPositive = (pv.mate !== null ? pv.mate > 0 : pv.score_cp >= 0);
    return (<div className={`flex items-start gap-2 p-2 rounded-lg bg-surface border
                  ${rank === 0 ? 'border-surface3' : 'border-surface2'}`}>
      {/* Score */}
      <span className={`text-sm font-mono font-semibold flex-shrink-0 w-12 text-right
                    ${isPositive ? 'text-on-surface' : 'text-muted'}`}>
        {scoreLabel}
      </span>
      {/* Depth */}
      <span className="text-[10px] font-mono text-muted flex-shrink-0 self-center">
        d{pv.depth}
      </span>
      {/* PV moves */}
      <span className="text-xs font-mono text-muted flex-1 leading-relaxed break-all">
        {pv.pv_san.slice(0, 8).join(' ')}
        {pv.pv_san.length > 8 ? ' …' : ''}
      </span>
    </div>);
};
const MoveClassificationTable = () => {
    const { moveHistory } = (0, gameStore_1.useGameStore)();
    const classified = moveHistory.filter((m) => m.classification);
    if (classified.length === 0)
        return null;
    return (<div className="flex flex-col gap-1 mt-2">
      <span className="text-xs font-sans text-muted">Move Classifications</span>
      <div className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto">
        {classified.map((m, i) => (<div key={i} className="flex items-center gap-1.5 text-xs font-mono">
            <span className="text-muted w-10 truncate">{m.san}</span>
            <span className={`px-1 py-0 rounded border text-[10px] font-sans
                          ${CLASSIFICATION_COLORS[m.classification ?? ''] ?? 'text-muted border-muted'}`}>
              {m.classification}
            </span>
          </div>))}
      </div>
    </div>);
};
