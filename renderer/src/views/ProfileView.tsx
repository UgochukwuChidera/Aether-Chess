import React from 'react';
import { useGameStore } from '../stores/gameStore';

export const ProfileView: React.FC = () => {
  const { moveHistory } = useGameStore();
  const [accuracy, setAccuracy] = React.useState<number | null>(null);
  const [eloResult, setEloResult] = React.useState<{ estimated_elo: number; confidence_interval: [number, number] } | null>(null);
  const [loading, setLoading] = React.useState(false);

  const handleCalculate = async () => {
    if (moveHistory.length < 2) return;
    setLoading(true);
    try {
      const res = await window.electronAPI.estimateElo({ accuracy: 60, blunder_rate: 0 }) as any;
      setAccuracy(60);
      setEloResult(res);
    } catch {/* ignore */}
    setLoading(false);
  };

  return (
    <div className="flex flex-col gap-4 w-full py-4">
      <div className="flex flex-col items-center gap-2">
        <div className="w-20 h-20 rounded-full bg-surface2 border border-surface3 flex items-center justify-center">
          <span className="material-symbols-outlined text-muted" style={{ fontSize: 44 }}>person</span>
        </div>
        <span className="font-sans font-semibold text-on-surface">Guest Player</span>
        <span className="text-xs text-muted">Local play only</span>
      </div>
      <div className="bg-surface rounded-card border border-surface2 p-4 flex flex-col gap-3">
        <span className="text-sm font-sans font-semibold text-on-surface">Performance</span>
        {accuracy !== null && eloResult ? (
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted">Accuracy</span>
              <span className="font-mono text-accent">{accuracy.toFixed(1)}%</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Estimated Elo</span>
              <span className="font-mono text-on-surface">
                {eloResult.estimated_elo}
                <span className="text-xs text-muted ml-1">
                  ({eloResult.confidence_interval[0]}–{eloResult.confidence_interval[1]})
                </span>
              </span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted">Play a game to see your performance stats.</p>
        )}
        <button
          onClick={handleCalculate}
          disabled={loading || moveHistory.length < 2}
          className="w-full py-2 border border-surface2 rounded-lg text-xs font-sans text-muted
                     hover:border-accent hover:text-accent active:scale-95 disabled:opacity-30
                     disabled:cursor-not-allowed transition-all"
        >
          {loading ? 'Calculating…' : 'Estimate Elo'}
        </button>
      </div>
    </div>
  );
};
