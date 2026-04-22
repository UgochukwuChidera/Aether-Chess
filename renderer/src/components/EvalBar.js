"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvalBar = void 0;
/**
 * EvalBar.tsx — Horizontal evaluation bar above the board.
 * Shows white advantage (light gray), black advantage (dark gray),
 * and a narrow glowing accent segment at the evaluation point.
 */
const react_1 = require("react");
const gameStore_1 = require("../stores/gameStore");
function evalToWhitePct(cp, mate) {
    if (mate !== null) {
        return mate > 0 ? 98 : 2;
    }
    // Logistic conversion
    return 100 / (1 + Math.exp(-cp / 400));
}
function formatScore(cp, mate) {
    if (mate !== null) {
        return mate > 0 ? `M${Math.abs(mate)}` : `-M${Math.abs(mate)}`;
    }
    const abs = Math.abs(cp);
    const sign = cp >= 0 ? '+' : '-';
    if (abs >= 1000)
        return `${sign}${(abs / 100).toFixed(0)}`;
    return `${sign}${(abs / 100).toFixed(1)}`;
}
const EvalBar = () => {
    const { analysis } = (0, gameStore_1.useGameStore)();
    const top = analysis.pvs[0];
    const cp = top?.score_cp ?? 0;
    const mate = top?.mate ?? null;
    const depth = top?.depth ?? 0;
    const whitePct = evalToWhitePct(cp, mate);
    const blackPct = 100 - whitePct;
    const GLOW_WIDTH = 2; // px
    const scoreLabel = top ? formatScore(cp, mate) : '0.0';
    return (<div className="w-full flex flex-col gap-0.5 mb-1">
      {/* Score + depth label */}
      <div className="flex justify-between items-center px-0.5">
        <span className="text-[11px] font-mono text-muted">
          {analysis.running ? `depth ${depth}` : 'eval'}
        </span>
        <span className={`text-[11px] font-mono font-semibold
                      ${cp >= 0 ? 'text-on-surface' : 'text-muted'}`}>
          {scoreLabel}
        </span>
      </div>
      {/* Bar */}
      <div className="relative w-full h-2 rounded-full overflow-hidden bg-surface2 flex">
        {/* White side */}
        <div className="eval-fill-white h-full transition-all duration-500" style={{ width: `${Math.max(0, whitePct - GLOW_WIDTH / 2)}%` }}/>
        {/* Glow segment */}
        <div className="eval-glow-segment h-full flex-shrink-0 transition-all duration-500" style={{ width: `${GLOW_WIDTH}%` }}/>
        {/* Black side */}
        <div className="eval-fill-black h-full flex-1 transition-all duration-500"/>
      </div>
    </div>);
};
exports.EvalBar = EvalBar;
