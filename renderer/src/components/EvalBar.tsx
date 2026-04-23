/**
 * EvalBar.tsx — Horizontal evaluation bar above the board.
 * Shows white advantage (light gray), black advantage (dark gray),
 * and a narrow glowing accent segment at the evaluation point.
 * Also shows captured pieces and material advantage.
 */
import React from 'react';
import { useGameStore } from '../stores/gameStore';
import { PIECE_GLYPHS } from '../config/pieceConfig';

const PIECE_VALUES: Record<string, number> = {
  P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0,
  p: -1, n: -3, b: -3, r: -5, q: -9, k: 0,
};

const PIECE_POINTS: Record<string, number> = {
  P: 1, N: 3, B: 3, R: 5, Q: 9,
  p: 1, n: 3, b: 3, r: 5, q: 9,
};

function evalToWhitePct(cp: number, mate: number | null): number {
  if (mate !== null) {
    return mate > 0 ? 98 : 2;
  }
  return 100 / (1 + Math.exp(-cp / 400));
}

function formatScore(cp: number, mate: number | null): string {
  if (mate !== null) {
    return mate > 0 ? `M${Math.abs(mate)}` : `-M${Math.abs(mate)}`;
  }
  const abs = Math.abs(cp);
  const sign = cp >= 0 ? '+' : '-';
  if (abs >= 1000) return `${sign}${(abs / 100).toFixed(0)}`;
  return `${sign}${(abs / 100).toFixed(1)}`;
}

interface CapturedPieces {
  white: string[];
  black: string[];
}

function computeCapturedPieces(fen: string): CapturedPieces {
  const board = fen.split(' ')[0];
  const counts: Record<string, number> = {};
  for (const ch of board) {
    if (PIECE_POINTS[ch]) counts[ch] = (counts[ch] || 0) + 1;
  }
  
  const whiteHave = (counts['K'] || 0) + (counts['Q'] || 0) + (counts['R'] || 0) + 
                (counts['B'] || 0) + (counts['N'] || 0) + (counts['P'] || 0);
  const blackHave = (counts['k'] || 0) + (counts['q'] || 0) + (counts['r'] || 0) + 
                 (counts['b'] || 0) + (counts['n'] || 0) + (counts['p'] || 0);
  
  const white: string[] = [];
  const black: string[] = [];
  
  // Queen: 1 each side
  if (whiteHave < 1) white.push('Q');
  if (blackHave < 1) black.push('q');
  // Rooks: 2 each side  
  for (let i = 0; i < 2 - (counts['R'] || 0); i++) white.push('R');
  for (let i = 0; i < 2 - (counts['r'] || 0); i++) black.push('r');
  // Bishops: 2 each side
  for (let i = 0; i < 2 - (counts['B'] || 0); i++) white.push('B');
  for (let i = 0; i < 2 - (counts['b'] || 0); i++) black.push('b');
  // Knights: 2 each side
  for (let i = 0; i < 2 - (counts['N'] || 0); i++) white.push('N');
  for (let i = 0; i < 2 - (counts['n'] || 0); i++) black.push('n');
  // Pawns: 8 each side
  for (let i = 0; i < 8 - (counts['P'] || 0); i++) white.push('P');
  for (let i = 0; i < 8 - (counts['p'] || 0); i++) black.push('p');
  
  return { white, black };
}

function computeMaterialAdvantage(fen: string): number {
  const board = fen.split(' ')[0];
  let material = 0;
  for (const ch of board) {
    const val = PIECE_VALUES[ch];
    if (val !== undefined) material += val;
  }
  return material;
}

function formatMaterial(cp: number): string {
  const sign = cp >= 0 ? '+' : '';
  return `${sign}${Math.abs(cp)}`;
}

export const EvalBar: React.FC = () => {
  const { analysis, fen } = useGameStore();
  const top = analysis.pvs[0];

  const cp   = top?.score_cp ?? 0;
  const mate = top?.mate ?? null;
  const depth = top?.depth ?? 0;

  const whitePct = evalToWhitePct(cp, mate);
  const GLOW_WIDTH = 2;

  const scoreLabel = top ? formatScore(cp, mate) : '0.0';
  const material = computeMaterialAdvantage(fen);
  const captured = computeCapturedPieces(fen);
  const materialLabel = formatMaterial(material);

  return (
    <div className="w-full flex flex-col gap-0.5 mb-1">
      {/* Captured pieces row */}
      <div className="flex justify-between items-center text-[10px]">
        <div className="flex gap-0.5 text-black-piece">
          {captured.black.map((p, i) => (
            <span key={`b${i}`} className="leading-none">{PIECE_GLYPHS[p]}</span>
          ))}
        </div>
        <span className={`text-[10px] font-bold ${material > 0 ? 'text-on-surface' : material < 0 ? 'text-muted' : 'text-muted'}`}>
          {materialLabel}
        </span>
        <div className="flex gap-0.5 text-white-piece">
          {captured.white.map((p, i) => (
            <span key={`w${i}`} className="leading-none">{PIECE_GLYPHS[p]}</span>
          ))}
        </div>
      </div>
      {/* Score + depth label */}
      <div className="flex justify-between items-center px-0.5">
        <span className="text-[11px] font-mono text-muted">
          {analysis.running ? `depth ${depth}` : 'eval'}
        </span>
        <span
          className={`text-[11px] font-mono font-semibold
                      ${cp >= 0 ? 'text-on-surface' : 'text-muted'}`}
        >
          {scoreLabel}
        </span>
      </div>
      {/* Bar */}
      <div className="relative w-full h-2 rounded-full overflow-hidden bg-surface2 flex">
        {/* White side */}
        <div
          className="eval-fill-white h-full transition-all duration-500"
          style={{ width: `${Math.max(0, whitePct - GLOW_WIDTH / 2)}%` }}
        />
        {/* Glow segment */}
        <div
          className="eval-glow-segment h-full flex-shrink-0 transition-all duration-500"
          style={{ width: `${GLOW_WIDTH}%` }}
        />
        {/* Black side */}
        <div
          className="eval-fill-black h-full flex-1 transition-all duration-500"
        />
      </div>
    </div>
  );
};
