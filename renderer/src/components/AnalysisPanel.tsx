/**
 * AnalysisPanel.tsx — Engine evaluation panel for the Analysis tab.
 * Shows real-time PV lines, evaluation score, move classifications,
 * accuracy progression chart, and Glicko-based Elo estimate.
 */
import React, { useEffect, useRef } from 'react';
import { useGameStore, type PVLine } from '../stores/gameStore';
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

  const classified = React.useMemo(() => moveHistory.filter((m) => m.classification), [moveHistory]);
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
    <div className="flex flex-col gap-1.5 w-full max-h-[400px] overflow-y-auto border border-surface2 rounded-lg bg-surface p-2">
      {/* Control row */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-sans text-muted flex-1">Analysis</span>
        <button
          onClick={onComputeAccuracy}
          disabled={accuracyLoading}
          className="px-2 py-0.5 rounded text-[10px] font-sans border border-surface2 text-muted
                     hover:border-accent hover:text-accent transition-all
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {accuracyLoading ? '…' : 'CAPS'}
        </button>
        <button
          onClick={running ? onStopAnalysis : onStartAnalysis}
          className={`px-2 py-0.5 rounded text-[10px] font-sans border transition-all
                      ${running
                        ? 'border-error text-error'
                        : 'border-surface2 text-muted hover:border-accent hover:text-accent'}`}
        >
          {running ? 'Stop' : 'Analyse'}
        </button>
      </div>

      {/* PV lines */}
      {pvs.length === 0 && !running && (
        <p className="text-[10px] text-muted font-body text-center py-2">
          Press Analyse to start engine evaluation.
        </p>
      )}
      {pvs.map((pv, i) => (
        <PVLineRow key={i} pv={pv} rank={i} />
      ))}

      {/* Top move + alternatives + threats inline */}
      {showAnalysisTopMoves && top?.pv_san?.[0] && (
        <div className="flex items-center gap-1 text-[10px] font-mono text-muted">
          <span className="text-accent">Best:</span>
          <span>{top.pv_san[0]}</span>
          <span className="text-muted">({formatScore(top.score_cp, top.mate)})</span>
        </div>
      )}

      {showAnalysisTopAlternatives && topAlternatives.length > 0 && (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
          <span className="text-[10px] text-muted">Alt:</span>
          {topAlternatives.slice(0, 3).map((pv, idx) => (
            <span key={idx} className="text-[10px] font-mono text-muted">
              {pv.pv_san?.[0] ?? '—'} ({formatScore(pv.score_cp, pv.mate)})
            </span>
          ))}
        </div>
      )}

      {showAnalysisThreats && threatLine.length > 0 && (
        <div className="text-[10px] font-mono text-muted truncate">
          <span className="text-yellow-400">Threat:</span> {threatLine.join(' ')}
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
    const stepX = (W - 14) / (classified.length - 1);
    ctx.strokeStyle = 'rgba(163,230,53,0.25)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = 6 + (H - 12) * (i / 4);
      ctx.beginPath();
      ctx.moveTo(7, y);
      ctx.lineTo(W - 7, y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.strokeStyle = '#A3E635';
    ctx.lineWidth = 1.5;
    classified.forEach((m, i) => {
      const x = 7 + i * stepX;
      const loss = m.cp_loss ?? 0;
      const y = 6 + ((maxLoss - loss) / maxLoss) * (H - 12);
      if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
    });
    ctx.stroke();
    ctx.fillStyle = '#A3E635';
    classified.forEach((m, i) => {
      const x = 7 + i * stepX;
      const loss = m.cp_loss ?? 0;
      const y = 6 + ((maxLoss - loss) / maxLoss) * (H - 12);
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
      if (m.classification === 'Blunder' || m.classification === 'Mistake') {
        ctx.strokeStyle = '#F87171';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
    ctx.fillStyle = '#C2CAB0';
    ctx.font = '8px Inter, sans-serif';
    ctx.fillText('Best', 8, 6);
    ctx.fillText(`${maxLoss.toFixed(0)}cp`, 8, H);
  }, [classified]);
  return (
    <div className="rounded border border-surface2 bg-surface p-1.5">
      <div className="text-[9px] text-muted mb-0.5">CP Loss Progression</div>
      <canvas ref={canvasRef} width={240} height={44} className="w-full" style={{ imageRendering: 'crisp-edges' }} />
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
    <div className="rounded border border-surface2 bg-surface p-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-mono font-bold text-accent">~{estimate.estimated_elo}</span>
        <span className="text-[9px] text-muted">CI: {estimate.confidence_interval[0]}–{estimate.confidence_interval[1]}</span>
        <span className="text-[9px] text-muted ml-auto">W:{wAcc.toFixed(0)}% B:{bAcc.toFixed(0)}%</span>
      </div>
    </div>
  );
};

const PVLineRow: React.FC<{ pv: PVLine; rank: number }> = ({ pv, rank }) => {
  const scoreLabel = formatScore(pv.score_cp, pv.mate);
  const isPositive = (pv.mate !== null ? pv.mate > 0 : pv.score_cp >= 0);

  return (
    <div
      className={`flex items-start gap-1 p-1 rounded ${rank === 0 ? 'bg-surface3/20' : ''}`}
    >
      <span
        className={`text-[11px] font-mono font-semibold flex-shrink-0 w-10 text-right
                    ${isPositive ? 'text-on-surface' : 'text-muted'}`}
      >
        {scoreLabel}
      </span>
      <span className="text-[9px] font-mono text-muted flex-shrink-0 self-center w-4">
        d{pv.depth}
      </span>
      <span className="text-[10px] font-mono text-muted flex-1 truncate">
        {pv.pv_san.slice(0, 6).join(' ')}
        {pv.pv_san.length > 6 ? ' …' : ''}
      </span>
    </div>
  );
};

const MoveClassificationTable: React.FC = () => {
  const { moveHistory } = useGameStore();
  const classified = moveHistory.filter((m) => m.classification);

  if (classified.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[9px] text-muted font-sans">Classifications</div>
      <div className="flex flex-wrap gap-x-1.5 gap-y-0.5 max-h-20 overflow-y-auto">
        {classified.map((m, i) => (
          <span key={i} className="flex items-center gap-0.5 text-[9px] font-mono">
            <span className="text-muted">{m.san}</span>
            <span
              className={`px-0.5 rounded border text-[8px] font-sans
                          ${CLASSIFICATION_COLORS[m.classification ?? ''] ?? 'text-muted border-muted'}`}
            >
              {m.classification}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
};
