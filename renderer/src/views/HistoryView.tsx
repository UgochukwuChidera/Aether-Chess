/**
 * HistoryView.tsx — Saved games browser with filters and Elo estimation.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useGameStore, type BackendMoveResult } from '../stores/gameStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { Tab } from '../components/BottomNav';

type EloCache = {
  white_accuracy: number;
  black_accuracy: number;
  blunder_rate: number;
  avg_cp_loss: number;
  computed_at: string;
};

type HistoryGame = {
  id: string;
  pgn_file: string;
  meta: {
    white: string;
    black: string;
    result: string;
    termination: string | null;
    moves: number;
    time_control?: { seconds: number; increment: number; label: string };
    mode: string;
    engine: string;
    played_at: string;
    tags?: string[];
    elo_cache?: EloCache;
  };
};

type HistoryIndex = {
  version: number;
  max_entries: number;
  games: HistoryGame[];
};

type ResultFilter = 'all' | 'win' | 'loss' | 'draw';

const RESULT_LABEL: Record<string, string> = {
  '1-0': 'White wins',
  '0-1': 'Black wins',
  '1/2-1/2': 'Draw',
};

const RESULT_ICON: Record<string, string> = {
  '1-0': '♔',
  '0-1': '♚',
  '1/2-1/2': '½',
};

const RESULT_BADGE: Record<string, { label: string; tone: string }> = {
  '1-0': { label: 'White', tone: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30' },
  '0-1': { label: 'Black', tone: 'bg-rose-500/15 text-rose-200 border-rose-500/30' },
  '1/2-1/2': { label: 'Draw', tone: 'bg-amber-500/15 text-amber-200 border-amber-500/30' },
};

const timeControlLabel = (tc?: { seconds: number; increment: number; label: string }) =>
  tc?.label ?? 'Unknown';

const parseDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

const formatDate = (iso: string) => {
  const d = parseDate(iso);
  if (!d) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const formatTime = (iso: string) => {
  const d = parseDate(iso);
  if (!d) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

const opponentLabel = (g: HistoryGame) => {
  if (g.meta.mode !== 'human_vs_ai') return g.meta.black;
  return g.meta.white === 'You' ? g.meta.black : g.meta.white;
};

const isWinForUser = (g: HistoryGame) => {
  if (g.meta.mode !== 'human_vs_ai') return false;
  const humanIsWhite = g.meta.white === 'You';
  if (g.meta.result === '1-0') return humanIsWhite;
  if (g.meta.result === '0-1') return !humanIsWhite;
  return false;
};

const isLossForUser = (g: HistoryGame) => {
  if (g.meta.mode !== 'human_vs_ai') return false;
  const humanIsWhite = g.meta.white === 'You';
  if (g.meta.result === '1-0') return !humanIsWhite;
  if (g.meta.result === '0-1') return humanIsWhite;
  return false;
};

const isDrawForUser = (g: HistoryGame) => g.meta.result === '1/2-1/2';

const selectClass =
  'bg-surface border border-surface2 text-on-surface text-xs font-body rounded px-2 py-1.5' +
  ' hover:border-accent focus:border-accent focus:outline-none transition-colors';

interface Props {
  onTabChange: (tab: Tab) => void;
}

export const HistoryView: React.FC<Props> = ({ onTabChange }) => {
  const store = useGameStore();
  const settings = useSettingsStore();
  const [loading, setLoading] = React.useState(true);
  const [history, setHistory] = React.useState<HistoryIndex | null>(null);
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const [timeControlFilter, setTimeControlFilter] = useState<string>('all');
  const [autoSaveBusy, setAutoSaveBusy] = useState(false);
  const [eloWindow, setEloWindow] = useState(20);
  const [eloLoading, setEloLoading] = useState(false);
  const [eloResult, setEloResult] = useState<{ estimated_elo: number; confidence_interval: [number, number] } | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);

  const [eloComputing, setEloComputing] = useState(false);
  const [eloComputed, setEloComputed] = useState(0);
  const [eloTotal, setEloTotal] = useState(0);
  const eloAbortRef = useRef(false);
  const isProcessingRef = useRef(false);

  // ── Background Elo computation (triggered once on initial load) ───
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    window.electronAPI.listGameHistory()
      .then((res) => {
        if (!mounted) return;
        const h = res as HistoryIndex;
        setHistory(h);
        // Derive overall Elo from whatever cache already exists
        const cached = h.games.filter((g) => g.meta.elo_cache);
        if (cached.length > 0) computeOverallEloFromCache(cached);
        // Start background one-time batch for games still missing cache
        if (!isProcessingRef.current) void processMissingElo();
      })
      .catch(() => {
        if (!mounted) return;
        setHistory({ version: 1, max_entries: 1000, games: [] });
      })
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, []);

  const computeOverallEloFromCache = async (games: HistoryGame[]) => {
    const cached = games.filter((g) => g.meta.elo_cache);
    if (cached.length === 0) return;
    let totalAcc = 0;
    let totalBlunderRate = 0;
    let totalCpLoss = 0;
    let counted = 0;
    for (const g of cached) {
      const c = g.meta.elo_cache!;
      const avg = (c.white_accuracy + c.black_accuracy) / 2;
      totalAcc += avg;
      totalBlunderRate += c.blunder_rate;
      totalCpLoss += c.avg_cp_loss;
      counted += 1;
    }
    const avgAccuracy = totalAcc / counted;
    const avgBlunder = totalBlunderRate / counted;
    const avgCpLoss = totalCpLoss / counted;
    try {
      const elo = await window.electronAPI.estimateElo({
        accuracy: avgAccuracy,
        blunder_rate: avgBlunder,
        avg_cp_loss: avgCpLoss,
        num_games: counted,
      }) as { estimated_elo: number; confidence_interval: [number, number] };
      setAccuracy(avgAccuracy);
      setEloResult(elo);
      console.log('[Elo] Derived from', counted, 'cached games →', elo.estimated_elo);
    } catch (e) {
      console.warn('[Elo] Cache-based estimate failed:', e);
    }
  };

  const processMissingElo = async () => {
    if (eloAbortRef.current || isProcessingRef.current) return;
    isProcessingRef.current = true;
    try {
      const needing = await window.electronAPI.getGamesNeedingElo() as Array<{ id: string; played_at: string; moves: number }>;
      if (needing.length === 0) return;
      store.pushToast(`Computing Elo for ${needing.length} game(s) in background…`, 'info');
      setEloComputing(true);
      setEloTotal(needing.length);
      setEloComputed(0);
      for (const game of needing) {
        if (eloAbortRef.current) break;
        const res = await window.electronAPI.computeAndCacheElo({
          id: game.id,
          stockfish_path: settings.stockfishPath,
        }) as { ok: boolean; error?: string; elo_cache?: EloCache };
        setEloComputed((p) => p + 1);
        if (!res.ok) continue;
        // Silently update local cache — no setHistory call that would re-trigger effects
        setHistory((prev) => {
          if (!prev) return prev;
          const games = prev.games.map((g) => {
            if (g.id === game.id && res.elo_cache) {
              return { ...g, meta: { ...g.meta, elo_cache: res.elo_cache } };
            }
            return g;
          });
          return { ...prev, games };
        });
      }
      // Recompute overall after batch completes
      if (!eloAbortRef.current) {
        const fresh = await window.electronAPI.listGameHistory() as HistoryIndex;
        const cached = fresh.games.filter((g) => g.meta.elo_cache);
        if (cached.length > 0) {
          await computeOverallEloFromCache(cached);
        }
        store.pushToast(`Elo computed for ${needing.length} game(s)`, 'success');
      }
    } catch { /* ignore */ }
    finally {
      isProcessingRef.current = false;
      setEloComputing(false);
    }
  };



  // Cleanup on unmount — abort any in-flight batch so it doesn't
  // continue processing after the component is gone
  useEffect(() => {
    return () => { eloAbortRef.current = true; };
  }, []);

  const sortedGames = useMemo(() => {
    const games = history?.games ?? [];
    return [...games].sort((a, b) => b.meta.played_at.localeCompare(a.meta.played_at));
  }, [history]);

  const timeControlOptions = useMemo(() => {
    const set = new Set<string>();
    for (const g of sortedGames) {
      set.add(timeControlLabel(g.meta.time_control));
    }
    return ['all', ...Array.from(set)];
  }, [sortedGames]);

  const filteredGames = useMemo(() => {
    return sortedGames.filter((g) => {
      if (timeControlFilter !== 'all' && timeControlLabel(g.meta.time_control) !== timeControlFilter) {
        return false;
      }
      if (resultFilter === 'all') return true;
      if (resultFilter === 'win') return isWinForUser(g);
      if (resultFilter === 'loss') return isLossForUser(g);
      return isDrawForUser(g);
    });
  }, [sortedGames, resultFilter, timeControlFilter]);

  const groupedByTimeControl = useMemo(() => {
    const map = new Map<string, HistoryGame[]>();
    for (const g of filteredGames) {
      const label = timeControlLabel(g.meta.time_control);
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(g);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredGames]);

  const recordStats = useMemo(() => {
    let wins = 0;
    let losses = 0;
    let draws = 0;
    for (const g of filteredGames) {
      if (isWinForUser(g)) wins++;
      else if (isLossForUser(g)) losses++;
      else if (isDrawForUser(g)) draws++;
    }
    const total = wins + losses + draws;
    const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
    return { wins, losses, draws, total, winPct: pct(wins), lossPct: pct(losses), drawPct: pct(draws) };
  }, [filteredGames]);

  const recentGamesForElo = useMemo(() => {
    const eligible = sortedGames.filter((g) => g.meta.moves >= 2);
    return eligible.slice(0, eloWindow);
  }, [sortedGames, eloWindow]);

  const handleReviewGame = async (game: HistoryGame) => {
    try {
      const res = await window.electronAPI.loadGamePgn({ id: game.id }) as { pgn: string };
      if (!res.pgn) {
        store.pushToast('PGN not found', 'error');
        return;
      }
      const hadMoves = store.fullMoveHistoryUCI.length > 0;
      const backend = await window.electronAPI.importPgn({ pgn: res.pgn }) as BackendMoveResult;
      store.applyMoveResult(backend);
      store.setFlipped(store.humanColor === 'black');
      if (hadMoves) {
        store.pushToast('Loaded game replaced current position', 'info');
      }
      onTabChange('play');
      store.pushToast('Game loaded — use arrow keys to review', 'success');
    } catch (err) {
      store.pushToast(`Load failed: ${err}`, 'error');
    }
  };

  const handleAnalyzeGame = async (game: HistoryGame) => {
    try {
      const res = await window.electronAPI.loadGamePgn({ id: game.id }) as { pgn: string };
      if (!res.pgn) {
        store.pushToast('PGN not found', 'error');
        return;
      }
      const backend = await window.electronAPI.importPgn({ pgn: res.pgn }) as BackendMoveResult;
      store.applyMoveResult(backend);
      store.setFlipped(store.humanColor === 'black');
      onTabChange('analysis');
      store.pushToast('Game loaded into analysis', 'success');
    } catch (err) {
      store.pushToast(`Load failed: ${err}`, 'error');
    }
  };

  const handleOpenInFolder = async (game: HistoryGame) => {
    try {
      const res = await window.electronAPI.getGameFilePath({ id: game.id }) as { path?: string };
      if (res.path) {
        await window.electronAPI.revealInFolder(res.path);
      } else {
        store.pushToast('File not found', 'error');
      }
    } catch (err) {
      store.pushToast(`Open failed: ${err}`, 'error');
    }
  };

  const handleDeleteGame = async (game: HistoryGame) => {
    try {
      const res = await window.electronAPI.deleteGameHistory({ id: game.id }) as { ok: boolean };
      if (res.ok) {
        const list = await window.electronAPI.listGameHistory() as HistoryIndex;
        setHistory(list);
        store.pushToast('Game deleted', 'success');
      } else {
        store.pushToast('Delete failed', 'error');
      }
    } catch (err) {
      store.pushToast(`Delete failed: ${err}`, 'error');
    }
  };

  const handleTagsUpdate = async (game: HistoryGame, tags: string[]) => {
    try {
      const res = await window.electronAPI.updateGameTags({ id: game.id, tags }) as { ok: boolean };
      if (res.ok) {
        const list = await window.electronAPI.listGameHistory() as HistoryIndex;
        setHistory(list);
      }
    } catch {
      /* ignore */
    }
  };

  const handleSaveCurrent = async () => {
    if (autoSaveBusy) return;
    setAutoSaveBusy(true);
    try {
      const res = await window.electronAPI.exportPgn() as { pgn: string };
      const pgn = res.pgn ?? '';
      if (!pgn) {
        store.pushToast('No PGN to save yet', 'error');
        return;
      }
      const resultMap: Record<string, string> = {
        white_wins: '1-0',
        black_wins: '0-1',
        draw: '1/2-1/2',
      };
      const engineName = settings.playEngine === 'stockfish'
        ? 'Stockfish'
        : settings.playEngine === 'maia3'
          ? 'Maia3'
          : 'Mentor';
      const whiteName = store.mode === 'human_vs_ai'
        ? (store.humanColor === 'white' ? 'You' : engineName)
        : store.mode === 'ai_vs_ai'
          ? engineName
          : 'White';
      const blackName = store.mode === 'human_vs_ai'
        ? (store.humanColor === 'black' ? 'You' : engineName)
        : store.mode === 'ai_vs_ai'
          ? engineName
          : 'Black';
      const mappedResult = store.gameResult ? resultMap[store.gameResult] : '*';
      const saveRes = await window.electronAPI.saveGameHistory({
        pgn,
        meta: {
          white: whiteName,
          black: blackName,
          result: mappedResult,
          termination: store.termination,
          moves: store.fullMoveHistoryUCI.length,
          mode: store.mode,
          engine: settings.playEngine,
          time_control: settings.timeControl,
          played_at: new Date().toISOString(),
        },
      });
      if (saveRes.ok) {
        store.pushToast('Game saved', 'success');
        const list = await window.electronAPI.listGameHistory() as HistoryIndex;
        setHistory(list);
      } else {
        store.pushToast('Save failed', 'error');
      }
    } catch (err) {
      store.pushToast(`Save failed: ${err}`, 'error');
    } finally {
      setAutoSaveBusy(false);
    }
  };

  const [eloProgress, setEloProgress] = useState('');
  const handleEstimateElo = async () => {
    if (recentGamesForElo.length === 0) return;
    setEloLoading(true);
    console.time('estimateElo');
    store.pushToast(`Analysing ${recentGamesForElo.length} game(s) — this may take several minutes…`, 'info');
    try {
      let totalAcc = 0;
      let totalBlunderRate = 0;
      let counted = 0;
      let idx = 0;
      for (const g of recentGamesForElo) {
        idx++;
        setEloProgress(`Game ${idx}/${recentGamesForElo.length}`);
        const pgnRes = await window.electronAPI.loadGamePgn({ id: g.id }) as { pgn: string };
        if (!pgnRes.pgn) { console.warn('[Elo] No PGN for', g.id); continue; }
        const accRes = await window.electronAPI.calculateAccuracyFromPgn({
          pgn: pgnRes.pgn,
          stockfish_path: settings.stockfishPath,
        }) as {
          moves?: Array<{ classification?: string }>;
          white_accuracy?: number;
          black_accuracy?: number;
          error?: string;
        };
        if (accRes.error) { console.warn('[Elo] Accuracy error for', g.id, accRes.error); continue; }
        const white = accRes.white_accuracy ?? 0;
        const black = accRes.black_accuracy ?? 0;
        const avg = (white + black) / 2;
        const rows = accRes.moves ?? [];
        const blunders = rows.filter((m) => m.classification === 'Blunder').length;
        const blunderRate = rows.length > 0 ? blunders / rows.length : 0;
        totalAcc += avg;
        totalBlunderRate += blunderRate;
        counted += 1;
      }
      setEloProgress('');
      if (!counted) {
        store.pushToast('Could not analyse any games — check Stockfish path in Settings', 'warning');
        return;
      }
      const avgAccuracy = totalAcc / counted;
      const avgBlunderRate = totalBlunderRate / counted;
      const elo = await window.electronAPI.estimateElo({
        accuracy: avgAccuracy,
        blunder_rate: avgBlunderRate,
        num_games: counted,
      }) as { estimated_elo: number; confidence_interval: [number, number] };
      setAccuracy(avgAccuracy);
      setEloResult(elo);
      console.timeEnd('estimateElo');
      store.pushToast(`Estimated from ${counted} games`, 'success');
    } catch (err) {
      store.pushToast(`Elo estimate failed: ${err}`, 'error');
      console.error('[Elo]', err);
    } finally {
      setEloLoading(false);
      setEloProgress('');
    }
  };

  return (
    <div className="flex flex-col gap-4 w-full py-2">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-sm font-sans font-semibold text-on-surface">Profile & History</span>
          <span className="text-xs text-muted">Saved games, stats, and Elo estimate</span>
        </div>
        <button
          onClick={handleSaveCurrent}
          disabled={autoSaveBusy}
          className="px-3 py-2 border border-surface2 rounded text-xs text-muted font-sans
                     hover:border-accent hover:text-accent active:scale-95 transition-all disabled:opacity-40"
        >
          {autoSaveBusy ? 'Saving…' : 'Save current game'}
        </button>
      </div>

      <div className="bg-surface rounded-card border border-surface2 p-4 flex flex-col gap-3">
        <span className="text-sm font-sans font-semibold text-on-surface">Estimated Elo</span>
        {eloResult && accuracy !== null ? (
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
        ) : eloComputing ? (
          <p className="text-xs text-muted">Computing Elo from cached games…</p>
        ) : (
          <p className="text-xs text-muted">Estimate based on your last games.</p>
        )}
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">Games</span>
          <select
            className={selectClass}
            value={String(eloWindow)}
            onChange={(e) => setEloWindow(Number(e.target.value))}
          >
            {[10, 15, 20, 25, 30].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          {eloComputing && eloTotal > 0 && (
            <span className="text-xs text-muted font-mono">{eloComputed}/{eloTotal}</span>
          )}
          <button
            onClick={handleEstimateElo}
            disabled={eloLoading || recentGamesForElo.length === 0}
            className="px-3 py-2 border border-surface2 rounded text-xs text-muted font-sans
                       hover:border-accent hover:text-accent active:scale-95 transition-all disabled:opacity-30"
          >
            {eloLoading ? (eloProgress || 'Calculating…') : 'Estimate Elo'}
          </button>
        </div>
      </div>

      <div className="bg-surface rounded-card border border-surface2 p-4 flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Result</span>
            <select
              className={selectClass}
              value={resultFilter}
              onChange={(e) => setResultFilter(e.target.value as ResultFilter)}
            >
              <option value="all">All</option>
              <option value="win">Wins</option>
              <option value="loss">Losses</option>
              <option value="draw">Draws</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Time control</span>
            <select
              className={selectClass}
              value={timeControlFilter}
              onChange={(e) => setTimeControlFilter(e.target.value)}
            >
              {timeControlOptions.map((opt) => (
                <option key={opt} value={opt}>{opt === 'all' ? 'All' : opt}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="bg-bg rounded-lg border border-surface2 p-2 text-center">
            <div className="text-xs text-muted">Wins</div>
            <div className="text-sm font-mono text-on-surface">{recordStats.wins} ({recordStats.winPct}%)</div>
          </div>
          <div className="bg-bg rounded-lg border border-surface2 p-2 text-center">
            <div className="text-xs text-muted">Losses</div>
            <div className="text-sm font-mono text-on-surface">{recordStats.losses} ({recordStats.lossPct}%)</div>
          </div>
          <div className="bg-bg rounded-lg border border-surface2 p-2 text-center">
            <div className="text-xs text-muted">Draws</div>
            <div className="text-sm font-mono text-on-surface">{recordStats.draws} ({recordStats.drawPct}%)</div>
          </div>
        </div>

        {loading ? (
          <p className="text-xs text-muted">Loading history…</p>
        ) : groupedByTimeControl.length === 0 ? (
          <p className="text-xs text-muted">No saved games yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {groupedByTimeControl.map(([label, games]) => (
              <div key={label} className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wider text-muted">{label}</span>
                  <span className="text-xs text-muted">{games.length} games</span>
                </div>
                <div className="flex flex-col gap-2">
                  {games.map((g) => {
                    const badge = RESULT_BADGE[g.meta.result];
                    return (
                      <div
                        key={g.id}
                        className="w-full border border-surface2 rounded-lg p-3 bg-bg"
                      >
                        <div className="flex flex-col gap-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm">{RESULT_ICON[g.meta.result] ?? '•'}</span>
                                <span className="text-sm font-sans text-on-surface truncate">
                                  {g.meta.white} vs {g.meta.black}
                                </span>
                                {badge && (
                                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${badge.tone} shrink-0`}>
                                    {badge.label}
                                  </span>
                                )}
                                <span className="text-[10px] text-muted shrink-0">Opponent: {opponentLabel(g)}</span>
                              </div>
                              <div className="flex items-center justify-between mt-1 text-xs text-muted">
                                <span>{RESULT_LABEL[g.meta.result] ?? g.meta.result} · {g.meta.moves} moves</span>
                                <span>{formatDate(g.meta.played_at)} · {formatTime(g.meta.played_at)}</span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              onClick={() => handleReviewGame(g)}
                              className="px-2 py-1 border border-accent rounded text-[10px] text-accent font-sans
                                         hover:bg-accent hover:text-bg transition-colors"
                            >
                              Review
                            </button>
                            <button
                              onClick={() => handleAnalyzeGame(g)}
                              className="px-2 py-1 border border-surface2 rounded text-[10px] text-muted font-sans
                                         hover:border-accent hover:text-accent transition-colors"
                            >
                              Analyze
                            </button>
                            <button
                              onClick={() => handleOpenInFolder(g)}
                              className="px-2 py-1 border border-surface2 rounded text-[10px] text-muted
                                         hover:border-accent hover:text-accent transition-colors"
                            >
                              Open in folder
                            </button>
                            <button
                              onClick={() => handleDeleteGame(g)}
                              className="px-2 py-1 border border-surface2 rounded text-[10px] text-muted
                                         hover:border-error hover:text-error transition-colors"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          {g.meta.elo_cache && (
                            <span className="text-[10px] font-mono text-accent">
                              {(() => {
                                const isHumanWhite = g.meta.mode === 'human_vs_ai' ? g.meta.white === 'You' : true;
                                const acc = isHumanWhite ? g.meta.elo_cache.white_accuracy : g.meta.elo_cache.black_accuracy;
                                return `${acc.toFixed(0)}%`;
                              })()}
                            </span>
                          )}
                          <span className="text-[10px] text-muted">Tags</span>
                          <input
                            type="text"
                            defaultValue={(g.meta.tags ?? []).join(', ')}
                            onBlur={(e) => {
                              const tags = e.target.value
                                .split(',')
                                .map((t) => t.trim())
                                .filter((t) => t.length > 0);
                              handleTagsUpdate(g, tags);
                            }}
                            placeholder="add tags…"
                            className="flex-1 bg-surface border border-surface2 rounded px-2 py-1 text-[10px] text-on-surface
                                       focus:border-accent focus:outline-none"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
