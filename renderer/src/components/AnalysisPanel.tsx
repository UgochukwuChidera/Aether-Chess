/**
 * AnalysisPanel.tsx — Engine evaluation panel for the Analysis tab.
 * Shows real-time PV lines, evaluation score, move classifications,
 * accuracy progression chart, and Glicko-based Elo estimate.
 */
import React, { useEffect, useRef } from 'react';
import { useGameStore, type PVLine, type AccuracyMoveResult } from '../stores/gameStore';
import { useSettingsStore } from '../stores/settingsStore';

const CLASSIFICATION_COLORS: Record<string, string> = {
  Brilliant:  'text-[#00b0ff] border-[#00b0ff]',
  Great:      'text-accent border-accent',
  Best:       'text-accent border-accent',
  Inaccuracy: 'text-yellow-400 border-yellow-400',
  Mistake:    'text-orange-400 border-orange-400',
  Blunder:    'text-error border-error',
  Book:       'text-muted border-muted',
};

function formatScore(cp: number, mate: number | null): string {
  if (mate !== null) return mate > 0 ? `M${Math.abs(mate)}` : `-M${Math.abs(mate)}`;
  const sign = cp >= 0 ? '+' : '';
  return `${sign}${(cp / 100).toFixed(2)}`;
}

interface Props {
  onStartAnalysis: () => void;
  onStopAnalysis: () => void;
  onComputeAccuracy: () => void;
  accuracyLoading?: boolean;
}

interface EloEstimate {
  estimated_elo: number;
  confidence_interval: [number, number];
  rd: number;
  games_simulated?: number;
}

export const AnalysisPanel: React.FC<Props> = ({
  onStartAnalysis,
  onStopAnalysis,
  onComputeAccuracy,
  accuracyLoading = false,
}) => {
  const { analysis, moveHistory } = useGameStore();
  const {
    showAnalysisThreats,
    showAnalysisTopMoves,
    showAnalysisTopAlternatives,
  } = useSettingsStore();
  const { pvs, running } = analysis;
  const top = pvs[0];
  const topAlternatives = pvs.slice(1);
  const threatLine = top?.pv_san?.slice(1, 5) ?? [];

  const classified = moveHistory.filter((m) => m.classification);
  const hasAccuracy = classified.length > 0;
  const [eloEstimate, setEloEstimate] = React.useState<EloEstimate | null>(null);

  useEffect(() => {
    if (!hasAccuracy) { setEloEstimate(null); return; }
    const whites = classified.filter((m) => m.color === 'white');
    const blacks = classified.filter((m) => m.color === 'black');
    const whiteAcc = whites.length > 0
      ? (whites.filter((m) => ['Best', 'Brilliant', 'Great'].includes(m.classification ?? '')).length / whites.length) * 100
      : 0;
    const blackAcc = blacks.length > 0
      ? (blacks.filter((m) => ['Best', 'Brilliant', 'Great'].includes(m.classification ?? '')).length / blacks.length) * 100
      : 0;
    const avgAcc = (whiteAcc + blackAcc) / 2;
    const allLosses = classified.filter((m) => m.cp_loss !== undefined).map((m) => m.cp_loss as number);
    const avgCpLoss = allLosses.length > 0
      ? allLosses.reduce((a, b) => a + b, 0) / allLosses.length
      : 0;
    const blunderCount = classified.filter((m) => m.classification === 'Blunder').length;
    const blunderRate = classified.length > 0 ? blunderCount / classified.length : 0;
    window.electronAPI.estimateElo({
      accuracy: avgAcc,
      blunder_rate: blunderRate,
      avg_cp_loss: avgCpLoss,
    }).then((res: unknown) => {
      setEloEstimate(res as EloEstimate);
    }).catch(() => {});
  }, [hasAccuracy, classified]);

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Control row */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-sans text-muted flex-1">Stockfish Analysis</span>
        <button
          onClick={onComputeAccuracy}
          disabled={accuracyLoading}
          className="px-3 py-1 rounded text-xs font-sans border border-surface2 text-muted
                     hover:border-accent hover:text-accent transition-all active:scale-95
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {accuracyLoading ? 'Analysing…' : 'CAPS/ACPL'}
        </button>
        <button
          onClick={running ? onStopAnalysis : onStartAnalysis}
          className={`px-3 py-1 rounded text-xs font-sans border transition-all active:scale-95
                      ${running
                        ? 'border-error text-error hover:bg-[#93000A]'
                        : 'border-surface2 text-muted hover:border-accent hover:text-accent'}`}
        >
          {running ? 'Stop' : 'Analyse'}
        </button>
      </div>

      {/* PV lines */}
      {pvs.length === 0 && !running && (
        <p className="text-xs text-muted font-body text-center py-4">
          Press Analyse to start engine evaluation.
        </p>
      )}
      {pvs.map((pv, i) => (
        <PVLineRow key={i} pv={pv} rank={i} />
      ))}

      {showAnalysisTopMoves && (
        <div className="rounded-lg border border-surface2 bg-surface p-2">
          <div className="text-xs text-muted mb-1">Top Move</div>
          {top?.pv_san?.[0] ? (
            <div className="text-sm font-mono text-on-surface">
              {top.pv_san[0]} <span className="text-xs text-muted ml-2">({formatScore(top.score_cp, top.mate)})</span>
            </div>
          ) : (
            <div className="text-xs text-muted">No top move available yet.</div>
          )}
        </div>
      )}

      {showAnalysisTopAlternatives && (
        <div className="rounded-lg border border-surface2 bg-surface p-2">
          <div className="text-xs text-muted mb-1">Top Alternatives</div>
          {topAlternatives.length > 0 ? (
            <div className="flex flex-col gap-1">
              {topAlternatives.map((pv, idx) => (
                <div key={idx} className="text-xs font-mono text-muted">
                  {pv.pv_san?.[0] ?? '—'}{' '}
                  <span className="text-[10px]">({formatScore(pv.score_cp, pv.mate)})</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted">No alternatives available yet.</div>
          )}
        </div>
      )}

      {showAnalysisThreats && (
        <div className="rounded-lg border border-surface2 bg-surface p-2">
          <div className="text-xs text-muted mb-1">Threats</div>
          {threatLine.length > 0 ? (
            <div className="text-xs font-mono text-muted break-all">{threatLine.join(' ')}</div>
          ) : (
            <div className="text-xs text-muted">No concrete threat line available yet.</div>
          )}
        </div>
      )}

      {/* Accuracy progression chart */}
      {hasAccuracy && (
        <AccuracyProgressionChart classified={classified} />
      )}

      {/* Estimated Elo */}
      {eloEstimate && (
        <EloDisplay estimate={eloEstimate} />
      )}

      {/* Move classification table */}
      {moveHistory.length > 0 && (
        <MoveClassificationTable />
      )}
    </div>
  );
};

const AccuracyProgressionChart: React.FC<{ classified: { san: string; color: string; cp_loss?: number; classification?: string }[] }> = ({ classified }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (classified.length < 2) return;
    const maxLoss = Math.max(...classified.map((m) => m.cp_loss ?? 0), 50);
    const stepX = (W - 20) / (classified.length - 1);
    ctx.strokeStyle = 'rgba(163,230,53,0.3)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = 10 + (H - 20) * (i / 4);
      ctx.beginPath();
      ctx.moveTo(10, y);
      ctx.lineTo(W - 10, y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.strokeStyle = '#A3E635';
    ctx.lineWidth = 2;
    classified.forEach((m, i) => {
      const x = 10 + i * stepX;
      const loss = m.cp_loss ?? 0;
      const y = 10 + ((maxLoss - loss) / maxLoss) * (H - 20);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = '#A3E635';
    classified.forEach((m, i) => {
      const x = 10 + i * stepX;
      const loss = m.cp_loss ?? 0;
      const y = 10 + ((maxLoss - loss) / maxLoss) * (H - 20);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      const colorClass = m.classification ?? '';
      if (colorClass === 'Blunder' || colorClass === 'Mistake') {
        ctx.fillStyle = '#F87171';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#A3E635';
      }
    });
    ctx.fillStyle = '#C2CAB0';
    ctx.font = '9px Inter, sans-serif';
    ctx.fillText('Best', 12, 8);
    ctx.fillText(`${maxLoss.toFixed(0)}cp loss`, 12, H);
  }, [classified]);
  return (
    <div className="rounded-lg border border-surface2 bg-surface p-2">
      <div className="text-xs text-muted mb-1">Accuracy Progression (centipawn loss per move)</div>
      <canvas ref={canvasRef} width={280} height={70} className="w-full" style={{ imageRendering: 'crisp-edges' }} />
    </div>
  );
};

const EloDisplay: React.FC<{ estimate: EloEstimate }> = ({ estimate }) => {
  const { moveHistory } = useGameStore();
  const classified = moveHistory.filter((m) => m.classification);
  const whites = classified.filter((m) => m.color === 'white');
  const blacks = classified.filter((m) => m.color === 'black');
  const wAcc = whites.length > 0
    ? (whites.filter((m) => ['Best', 'Brilliant', 'Great'].includes(m.classification ?? '')).length / whites.length) * 100
    : 0;
  const bAcc = blacks.length > 0
    ? (blacks.filter((m) => ['Best', 'Brilliant', 'Great'].includes(m.classification ?? '')).length / blacks.length) * 100
    : 0;
  return (
    <div className="rounded-lg border border-surface2 bg-surface p-2">
      <div className="text-xs text-muted mb-1">Estimated Rating (Glicko-2)</div>
      <div className="flex items-center gap-4">
        <div className="text-lg font-mono font-bold text-accent">
          ~{estimate.estimated_elo}
        </div>
        <div className="flex flex-col gap-0.5">
          <div className="text-[10px] text-muted">
            CI: {estimate.confidence_interval[0]}–{estimate.confidence_interval[1]}
          </div>
          <div className="flex gap-3 text-[10px] text-muted">
            <span>W: {wAcc.toFixed(0)}%</span>
            <span>B: {bAcc.toFixed(0)}%</span>
            <span>RD: {estimate.rd}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

const PVLineRow: React.FC<{ pv: PVLine; rank: number }> = ({ pv, rank }) => {
  const scoreLabel = formatScore(pv.score_cp, pv.mate);
  const isPositive = (pv.mate !== null ? pv.mate > 0 : pv.score_cp >= 0);

  return (
    <div
      className={`flex items-start gap-2 p-2 rounded-lg bg-surface border
                  ${rank === 0 ? 'border-surface3' : 'border-surface2'}`}
    >
      {/* Score */}
      <span
        className={`text-sm font-mono font-semibold flex-shrink-0 w-12 text-right
                    ${isPositive ? 'text-on-surface' : 'text-muted'}`}
      >
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
    </div>
  );
};

const MoveClassificationTable: React.FC = () => {
  const { moveHistory } = useGameStore();
  const classified = moveHistory.filter((m) => m.classification);

  if (classified.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 mt-2">
      <span className="text-xs font-sans text-muted">Move Classifications</span>
      <div className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto">
        {classified.map((m, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs font-mono">
            <span className="text-muted w-10 truncate">{m.san}</span>
            <span
              className={`px-1 py-0 rounded border text-[10px] font-sans
                          ${CLASSIFICATION_COLORS[m.classification ?? ''] ?? 'text-muted border-muted'}`}
            >
              {m.classification}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
