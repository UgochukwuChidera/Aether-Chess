/**
 * AnalysisPanel.tsx — Engine evaluation panel for the Analysis tab.
 * Shows real-time PV lines, evaluation score, and move classifications.
 */
import React from 'react';
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
}

export const AnalysisPanel: React.FC<Props> = ({ onStartAnalysis, onStopAnalysis, onComputeAccuracy }) => {
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

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Control row */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-sans text-muted flex-1">Stockfish Analysis</span>
        <button
          onClick={onComputeAccuracy}
          className="px-3 py-1 rounded text-xs font-sans border border-surface2 text-muted
                     hover:border-accent hover:text-accent transition-all active:scale-95"
        >
          CAPS/ACPL
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

      {/* Move classification table */}
      {moveHistory.length > 0 && (
        <MoveClassificationTable />
      )}
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
