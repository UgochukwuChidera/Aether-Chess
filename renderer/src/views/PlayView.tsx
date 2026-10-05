/**
 * PlayView.tsx — Main game play tab.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Board } from '../components/Board';
import { EvalBar } from '../components/EvalBar';
import { MoveHistory } from '../components/MoveHistory';
import { GameControls } from '../components/GameControls';
import { GameOverModal } from '../components/GameOverModal';
import { PromotionDialog } from '../components/PromotionDialog';
import { useGameStore, type BackendMoveResult, type PVLine, type GameMode, type Color } from '../stores/gameStore';
import { useSettingsStore, botDisplayName } from '../stores/settingsStore';
import { Sound } from '../utils/sound';
import type { Tab } from '../components/BottomNav';

interface Props {
  onTabChange: (tab: Tab) => void;
}
const PLAY_ANALYSIS_CB_ID = 'analysis-play';

/** Return the color of the piece on a given square, or null if empty. */
function pieceColorAt(fen: string, sq: string): 'white' | 'black' | null {
  const rows = fen.split(' ')[0].split('/');
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1]) - 1;
  const fenRankIdx = 7 - rank;
  let col = 0;
  for (const ch of rows[fenRankIdx]) {
    if (/\d/.test(ch)) { col += parseInt(ch); }
    else { if (col === file) return ch === ch.toUpperCase() ? 'white' : 'black'; col++; }
  }
  return null;
}

function isPawnPromotion(fen: string, from: string, to: string): boolean {
  const rows = fen.split(' ')[0].split('/');
  const fromFile = from.charCodeAt(0) - 97;
  const fromRank = parseInt(from[1]) - 1;
  const fenRankIdx = 7 - fromRank;
  let file = 0;
  let piece: string | null = null;
  for (const ch of rows[fenRankIdx]) {
    if (/\d/.test(ch)) { file += parseInt(ch); }
    else { if (file === fromFile) { piece = ch; break; } file++; }
  }
  const toRank = parseInt(to[1]);
  return (piece === 'P' && toRank === 8) || (piece === 'p' && toRank === 1);
}

const setupSelectClass =
  'bg-surface border border-surface2 text-on-surface text-xs font-body rounded px-2 py-1.5' +
  ' hover:border-accent focus:border-accent focus:outline-none transition-colors flex-1';

export const PlayView: React.FC<Props> = ({ onTabChange }) => {
  // P3-T05: select only the fields this component reads. The Stockfish
  // stream writes `analysis` many times/sec via setAnalysis - the previous
  // whole-store subscriptions re-rendered this view (and its Board subtree)
  // per push although this view never reads `analysis`. Every selector below
  // is a primitive, a stable array/object identity that analysis pushes never
  // replace, or a stable store action - no fresh-object selector, so no
  // shallow wrapper is needed for referential stability.
  const mode = useGameStore((s) => s.mode);
  const humanColor = useGameStore((s) => s.humanColor);
  const turn = useGameStore((s) => s.turn);
  const fen = useGameStore((s) => s.fen);
  const clock = useGameStore((s) => s.clock);
  const flipped = useGameStore((s) => s.flipped);
  const engineBusy = useGameStore((s) => s.engineBusy);
  const gameResult = useGameStore((s) => s.gameResult);
  const termination = useGameStore((s) => s.termination);
  const selectedSquare = useGameStore((s) => s.selectedSquare);
  const legalMoves = useGameStore((s) => s.legalMoves);
  const pendingPromotion = useGameStore((s) => s.pendingPromotion);
  const fullMoveHistoryLength = useGameStore((s) => s.fullMoveHistoryUCI.length);
  const resetGame = useGameStore((s) => s.resetGame);
  const setFlipped = useGameStore((s) => s.setFlipped);
  const applyMoveResult = useGameStore((s) => s.applyMoveResult);
  const setEngineBusy = useGameStore((s) => s.setEngineBusy);
  const pushToast = useGameStore((s) => s.pushToast);
  const selectSquare = useGameStore((s) => s.selectSquare);
  const setPendingPromotion = useGameStore((s) => s.setPendingPromotion);
  const flipBoard = useGameStore((s) => s.flipBoard);
  const loaded = useSettingsStore((s) => s.loaded);
  const showEvalBar = useSettingsStore((s) => s.showEvalBar);
  const stockfishPath = useSettingsStore((s) => s.stockfishPath);
  const threads = useSettingsStore((s) => s.threads);
  const hashMb = useSettingsStore((s) => s.hashMb);
  const autoSaveGameHistory = useSettingsStore((s) => s.autoSaveGameHistory);
  const playEngine = useSettingsStore((s) => s.playEngine);
  const timeControl = useSettingsStore((s) => s.timeControl);
  const botStrength = useSettingsStore((s) => s.botStrength);
  const maia3Path = useSettingsStore((s) => s.maia3Path);
  const maia3Model = useSettingsStore((s) => s.maia3Model);
  const maia3Device = useSettingsStore((s) => s.maia3Device);
  const maia3Elo = useSettingsStore((s) => s.maia3Elo);
  const thinkProfile = useSettingsStore((s) => s.thinkProfile);
  const multipv = useSettingsStore((s) => s.multipv);
  const autoQueen = useSettingsStore((s) => s.autoQueen);
  const autoSaveRef = useRef(false);
  const boardAreaRef = useRef<HTMLDivElement>(null);
  const [boardSize, setBoardSize] = useState(0);
  const [zenMode, setZenMode] = useState(false);
  const zenBoardRef = useRef<HTMLDivElement>(null);
  const [zenBoardSize, setZenBoardSize] = useState(0);

  // Maximize board to fill available space
  useEffect(() => {
    const el = boardAreaRef.current;
    if (!el) return;
    const calc = () => {
      setBoardSize(Math.max(100, Math.min(el.clientWidth, el.clientHeight)));
    };
    calc();
    const observer = new ResizeObserver(calc);
    observer.observe(el);
    return () => observer.disconnect();
  }, [zenMode]);

  // Zen mode board sizing
  useEffect(() => {
    const el = zenBoardRef.current;
    if (!el) return;
    const calc = () => {
      setZenBoardSize(Math.max(100, Math.min(el.clientWidth, el.clientHeight)));
    };
    calc();
    const observer = new ResizeObserver(calc);
    observer.observe(el);
    return () => observer.disconnect();
  }, [zenMode]);

  const toggleZenMode = useCallback(() => setZenMode((p) => !p), []);

  // ── Game setup state (applied on next "New Game") ─────────────────────────
  const [setupMode, setSetupMode] = useState<GameMode>(mode);
  const [setupColor, setSetupColor] = useState<'white' | 'black' | 'random'>('white');

  // ── AI vs AI loop control ─────────────────────────────────────────────────
  const aiLoopRef = useRef(false);

  // P2-T07: monotonic game generation. Bumped on every superseding action
  // (new game, undo, navigate); in-flight AI work captures it on entry and
  // discards its result when it no longer matches. Refs need no effect deps.
  const gameGenerationRef = useRef(0);

  // ── Analysis debounce ─────────────────────────────────────────────────────
  const analysisDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stockfishDepthForStrength = (strength: number): number => {
    const s = Math.max(1, Math.min(10, strength));
    return 5 + s;
  };
  const botEloForStrength = (strength: number, engine: string): number => {
    const s = Math.max(1, Math.min(10, strength));
    // Matched by id prefix, so a discovered build such as "stockfish-19" is
    // rated on the Stockfish curve instead of falling through to Mentor.
    if (engine.startsWith('stockfish')) return Math.round(900 + s * 180);
    if (engine === 'maia3') return Math.round(1000 + s * 150);
    return Math.round(850 + s * 170);
  };

  // ── Backend connectivity tracking ────────────────────────────────────────
  const [backendConnected, setBackendConnected] = useState(true);

  // P2-T03: each subscribe call returns its own unsubscribe closure —
  // without invoking it here, every Play<->Settings switch (which remounts
  // this view) would leak two ipcRenderer listeners per backend channel.
  useEffect(() => {
    const handleBackendClosed = () => setBackendConnected(false);
    const handleBackendError = () => setBackendConnected(false);
    // P2-T22: main emits `backend-ready` when the backend's ready signal
    // is observed (boot spawn re-asserts the initial true — a no-op; the
    // P2-T05 lazy respawn flips the flag back after a death).
    const handleBackendReady = () => setBackendConnected(true);
    const unsubscribeClosed = window.electronAPI.onBackendClosed(handleBackendClosed);
    const unsubscribeError = window.electronAPI.onBackendError(handleBackendError);
    const unsubscribeReady = window.electronAPI.onBackendReady(handleBackendReady);
    return () => {
      unsubscribeClosed();
      unsubscribeError();
      unsubscribeReady();
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    void handleNewGame();
    return () => { aiLoopRef.current = false; };
  }, [loaded]);

  // P2-T03: subscribe returns an unsubscribe closure, so cleanup removes
  // exactly this mount's wrapper (bare removeAllListeners would kill a
  // co-mounted view's subscription on the shared channel).
  useEffect(() => {
    const handleAnalysisUpdate = (raw: unknown) => {
      const data = raw as { callback_id: string; pvs?: unknown[]; fen?: string; error?: string };
      if (data.callback_id !== PLAY_ANALYSIS_CB_ID) return;
      // P2-T02: read the live fen via getState() — the render-scope `store`
      // snapshot is permanently the mount-time position.
      const gs = useGameStore.getState();
      if (data.error) {
        gs.setAnalysis({ running: false });
        return;
      }
      // Only accept analysis for the current position - ignore stale results
      if (data.fen !== gs.fen) {
        return;
      }
      gs.setAnalysis({
        pvs: (data.pvs as PVLine[]) ?? [],
        fen: data.fen ?? gs.fen,
        running: true,
      });
    };
    const unsubscribeAnalysis = window.electronAPI.onAnalysisUpdate(handleAnalysisUpdate);
    return () => {
      window.electronAPI.stopAnalysis().catch(() => {});
      unsubscribeAnalysis();
    };
  }, []);

  // Debounced eval-bar analysis — stop immediately, restart after 350 ms of quiet.
  // P2-T02: the timeout body re-reads via getState() so it fires with live
  // values; the deps below are retrigger keys (restart the debounce when any
  // of them changes), not values consumed by the body.
  useEffect(() => {
    if (!showEvalBar) {
      useGameStore.getState().setAnalysis({ running: false, pvs: [] });
      window.electronAPI.stopAnalysis().catch(() => {});
      return;
    }

    void window.electronAPI.stopAnalysis().catch(() => {});
    useGameStore.getState().setAnalysis({ running: false });

    if (analysisDebounceRef.current) clearTimeout(analysisDebounceRef.current);
    analysisDebounceRef.current = setTimeout(() => {
      analysisDebounceRef.current = null;
      // P2-T02: re-read at fire time — the render-scope snapshot can be 350 ms stale.
      const gs = useGameStore.getState();
      const cfg = useSettingsStore.getState();
      window.electronAPI.startAnalysis({
        fen: gs.fen,
        multipv: 1,
        callback_id: PLAY_ANALYSIS_CB_ID,
        stockfish_path: cfg.stockfishPath,
        threads: cfg.threads,
        hash_mb: cfg.hashMb,
      }).catch(() => {});
    }, 350);

    return () => {
      if (analysisDebounceRef.current) {
        clearTimeout(analysisDebounceRef.current);
        analysisDebounceRef.current = null;
      }
    };
  }, [
    fen,
    showEvalBar,
    stockfishPath,
    threads,
    hashMb,
  ]);

  // P3-T01: backend clock push (1 Hz while a clock runs). This
  // subscription is the only clock tick in the client - no client-side timer
  // remains anywhere in the renderer. The tick carries a full snapshot;
  // applyClockTick refreshes the clock mirror and terminal state without
  // disturbing selection/highlights (a tick never moves).
  useEffect(() => {
    const handleClockTick = (raw: unknown) => {
      useGameStore.getState().applyClockTick(raw as BackendMoveResult);
    };
    const unsubscribe = window.electronAPI.onClockTick(handleClockTick);
    return () => {
      unsubscribe();
    };
  }, []);

  // P3-T01 change 6: autosave keys off the BACKEND's result.
  // gameResult/termination now originate only from backend snapshots
  // (applyMoveResult via IPC, applyClockTick via push) - handleResign /
  // handleDraw no longer write local state, so observing gameResult
  // IS observing the backend's result.
  useEffect(() => {
    if (!gameResult || !autoSaveGameHistory || autoSaveRef.current) return;
    if (fullMoveHistoryLength === 0) return;
    autoSaveRef.current = true;

    const resultMap: Record<NonNullable<typeof gameResult>, string> = {
      white_wins: '1-0',
      black_wins: '0-1',
      draw: '1/2-1/2',
    };

    const engineName = botDisplayName(playEngine);

    const whiteName = mode === 'human_vs_ai'
      ? (humanColor === 'white' ? 'You' : engineName)
      : mode === 'ai_vs_ai'
        ? engineName
        : 'White';
    const blackName = mode === 'human_vs_ai'
      ? (humanColor === 'black' ? 'You' : engineName)
      : mode === 'ai_vs_ai'
        ? engineName
        : 'Black';

    window.electronAPI.exportPgn()
      .then((res) => {
        const pgn = (res as { pgn?: string }).pgn ?? '';
        return window.electronAPI.saveGameHistory({
          pgn,
          meta: {
            white: whiteName,
            black: blackName,
            result: resultMap[gameResult!],
            termination: termination,
            moves: fullMoveHistoryLength,
            mode: mode,
            engine: playEngine,
            time_control: timeControl,
            played_at: new Date().toISOString(),
          },
        });
      })
      .then((saveRes) => {
        // Auto-compute Elo for the saved game in the background (fire-and-forget)
        const res = saveRes as { ok: boolean; path?: string };
        if (res.ok) {
          // Derive game id from the path (last component without .pgn)
          const gameId = res.path
            ? res.path.split(/[\\/]/).pop()?.replace(/\.pgn$/i, '') ?? ''
            : '';
          if (gameId) {
            window.electronAPI.computeAndCacheElo({
              id: gameId,
              stockfish_path: useSettingsStore.getState().stockfishPath,
            }).catch(() => {});
          }
        }
      })
      .catch(() => {
        useGameStore.getState().pushToast('Auto-save failed', 'error');
        autoSaveRef.current = false;
      });
  // P2-T02: async continuations above re-read via getState(); the sync reads justify the retrigger deps below.
  }, [gameResult, fullMoveHistoryLength, termination, mode, humanColor, autoSaveGameHistory, playEngine, timeControl]);

  // ── AI move helper — reads fresh state so it's safe in async loops ──────────
  const makeAiMove = useCallback(async (fen: string): Promise<BackendMoveResult | null> => {
    const cfg = useSettingsStore.getState();
    const gs = useGameStore.getState();
    const isWhiteTurn = gs.turn === 'white';
    // P3-T01: engine budgets read the backend clock mirror, never local
    // countdown state (deleted with the client-side countdown). Null = Unlimited.
    const clock = gs.clock;
    const timeRemaining = clock
      ? (isWhiteTurn ? clock.white_ms : clock.black_ms) / 1000
      : undefined;
    const totalMoves = gs.fullMoveHistoryUCI.length;
    const requestedEngine = cfg.playEngine;
    // P2-T07: captured on entry; a superseded call discards its result.
    const gen = gameGenerationRef.current;

    // Single state owner for every AI move: play through the backend, then
    // apply the result to the store exactly once. All four paths below use it.
    const playAndApply = async (uci: string): Promise<BackendMoveResult | null> => {
      const r = await window.electronAPI.makeMove({ move: uci }) as BackendMoveResult;
      if (gen !== gameGenerationRef.current) return null;
      // P3-T01: a flag/resign/draw may have ended the game (via tick or
      // IPC) while this move was in flight. The move was legal when sent
      // so the position still advances, but a stale non-terminal response
      // must not resurrect the backend-recorded terminal state.
      const prev = useGameStore.getState();
      const prevResult = prev.gameResult;
      const prevTermination = prev.termination;
      useGameStore.getState().applyMoveResult(r);
      if (prevResult && !r.game_over) {
        useGameStore.setState({ gameResult: prevResult, termination: prevTermination });
      }
      return r;
    };

// Try opening book first if enabled and we're in the opening (first 20 moves total)
    if (cfg.useOpeningBook && totalMoves < cfg.openingBookDepth) {
      try {
        const bookData = await window.electronAPI.getBookMoves({
          fen,
        }) as { moves?: { uci: string; weight: number }[] };
        if (bookData.moves && bookData.moves.length > 0) {
          // Validate each candidate move against fresh legal moves before playing
          const freshLegal = await window.electronAPI.getLegalMoves({ fen }) as { moves: { uci: string }[] };
          const legalSet = new Set((freshLegal.moves || []).map((m) => typeof m === 'string' ? m : m.uci));
          // Filter to only legal moves from book
          const legalBookMoves = bookData.moves.filter(m => legalSet.has(m.uci));
          if (legalBookMoves.length > 0) {
            // Pick a random move weighted by book popularity
            const totalWeight = legalBookMoves.reduce((sum, m) => sum + m.weight, 0);
            let rand = Math.random() * totalWeight;
            for (const move of legalBookMoves) {
              rand -= move.weight;
              if (rand <= 0) {
                return playAndApply(move.uci);
              }
            }
          }
        }
      } catch (e) { console.warn('[AI] Book error:', e); }
    }

    // Get engine move with fallback if timeout - simple promise race wrapper
    async function getEngineMoveSafe(): Promise<{ move: string | null }> {
    const cfg = useSettingsStore.getState();
    // Timeout per think profile (covers max bucket * complexity * jitter)
    const profileTimeouts: Record<string, number> = {
      blitz: 15_000,
      rapid: 30_000,
      classical: 180_000,
      human_like: 180_000,
    };
    const ms = profileTimeouts[cfg.thinkProfile] ?? 180_000;
    
    // One call for every bot. The backend resolves the id in engine_type and
    // ignores the parameters that do not apply to the bot it picked, so a newly
    // added bot needs no branch here. Only the response is narrowed, because
    // the move is all this function needs.
    const enginePromise = window.electronAPI.getEngineMove({
      fen,
      engine_type: cfg.playEngine,
      depth: stockfishDepthForStrength(cfg.botStrength),
      strength: cfg.botStrength,
      stockfish_path: cfg.stockfishPath,
      threads: cfg.threads,
      hash_mb: cfg.hashMb,
      maia3_model: cfg.maia3Model,
      maia3_device: cfg.maia3Device,
      maia3_elo: cfg.maia3Elo,
      think_profile: cfg.thinkProfile,
      time_remaining: timeRemaining ?? undefined,
      time_increment: cfg.timeControl.increment ?? undefined,
      total_moves: totalMoves,
    }) as Promise<{ move: string | null }>;
    
    // Simple timeout wrapper using Promise.race
    return new Promise<{ move: string | null }>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('[AI] Engine timed out after', ms, 'ms');
        resolve({ move: null });
      }, ms);
      enginePromise.then((result) => {
        clearTimeout(timeout);
        resolve(result);
      }).catch((err) => {
        clearTimeout(timeout);
        console.error('[AI] Engine error:', err);
        resolve({ move: null });
      });
    });
  }

  // Get engine move - always try this as fallback
  let reply: { move: string | null; _fallback_msg?: string };
  try {
    reply = await getEngineMoveSafe();
  } catch (e) {
    console.error('[AI] Engine call failed:', e);
    return null;
  }

  // P2-T07: superseded while thinking (new game / undo / navigate) — stay
  // silent instead of toasting or falling back onto the new position.
  if (gen !== gameGenerationRef.current) return null;

  if (!reply || !reply.move) {
    console.warn('[AI] No move returned, using fallback');
    const toast = useGameStore.getState().pushToast;
    toast(`${botDisplayName(requestedEngine)} failed — using fallback move`, 'error');
    // Fallback: return a legal move as last resort
    const legal = await window.electronAPI.getLegalMoves({ fen }) as { moves?: { uci: string }[] };
    const moves = legal?.moves;
    if (moves && moves.length > 0) {
      const fallbackMove = moves[0].uci;
      return playAndApply(fallbackMove);
    }
    return null;
  }
  
  // Validate move is legal before pushing (critical!)
  const legalMoves = await window.electronAPI.getLegalMoves({ fen }) as { moves: { uci: string }[] };
  const legalUcis = (legalMoves.moves || []).map((m) => typeof m === 'string' ? m : m.uci);
  if (!legalUcis.includes(reply.move)) {
    console.error('[AI] Illegal engine move:', reply.move, 'legal:', legalUcis);
    const fallbackMove = legalUcis[Math.floor(Math.random() * legalUcis.length)];
    if (!fallbackMove) return null;
    return playAndApply(fallbackMove);
  }
  
  if (reply._fallback_msg) {
    const toast = useGameStore.getState().pushToast;
    toast(reply._fallback_msg, 'warning');
  }
  return playAndApply(reply.move);
  }, []);

  // ── AI vs AI autonomous loop ──────────────────────────────────────────────
  const runAiVsAiLoop = useCallback(async () => {
    while (aiLoopRef.current) {
      const s = useGameStore.getState();
      if (s.gameResult) { aiLoopRef.current = false; break; }

      const iterGen = gameGenerationRef.current;
      useGameStore.getState().setEngineBusy(true);
      try {
        const result = await makeAiMove(s.fen);
        if (!result || result.game_over) { aiLoopRef.current = false; break; }
      } catch {
        aiLoopRef.current = false;
        break;
      } finally {
        // P2-T07: a superseded loop must not clear the new owner's busy flag.
        if (iterGen === gameGenerationRef.current) useGameStore.getState().setEngineBusy(false);
      }

      if (aiLoopRef.current) await new Promise<void>((r) => setTimeout(r, 400));
    }
  }, [makeAiMove]);

  const handleNewGame = async () => {
    // Stop any running AI loop / analysis before resetting
    aiLoopRef.current = false;
    // P2-T07: cancel any in-flight AI work from the previous game.
    gameGenerationRef.current += 1;
    autoSaveRef.current = false;
    if (analysisDebounceRef.current) {
      clearTimeout(analysisDebounceRef.current);
      analysisDebounceRef.current = null;
    }

    // Resolve 'random' side selection
    const resolvedColor: Color =
      setupColor === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : setupColor;

    // Apply mode/color to store before the backend call so resetGame won't clobber them
    useGameStore.setState({ mode: setupMode, humanColor: resolvedColor });

    const newGameGen = gameGenerationRef.current;
    try {
      const result = await window.electronAPI.newGame({
        mode: setupMode,
        engine_type: playEngine,
        human_color: resolvedColor,
        strength: botStrength,
        stockfish_path: stockfishPath,
        maia3_path: maia3Path,
        maia3_model: maia3Model,
        maia3_device: maia3Device,
        maia3_elo: maia3Elo,
        think_profile: thinkProfile,
        threads: threads,
        hash_mb: hashMb,
        multipv: multipv,
        time_control: timeControl,
      }) as BackendMoveResult;

      // P2-T07: a second New Game superseded this one mid-flight — stay silent.
      if (newGameGen !== gameGenerationRef.current) return;

      resetGame();
      // resetGame doesn't touch mode/humanColor; re-assert to be explicit
      useGameStore.setState({ mode: setupMode, humanColor: resolvedColor });
      // Flip board if human is playing as black
      setFlipped(resolvedColor === 'black');
      applyMoveResult(result);

      // Orchestrate first AI move(s) depending on mode
      if (setupMode === 'ai_vs_ai') {
        aiLoopRef.current = true;
        void runAiVsAiLoop();
      } else if (setupMode === 'human_vs_ai' && result.turn !== resolvedColor) {
        // Human chose black — AI (white) moves first.
        // Show board immediately by firing AI async so UI stays responsive.
        setEngineBusy(true);
        makeAiMove(result.fen).finally(() => {
          // P2-T07: only the owning generation clears busy.
          if (newGameGen === gameGenerationRef.current) setEngineBusy(false);
        });
      }
    } catch (err) {
      if (newGameGen !== gameGenerationRef.current) return;
      pushToast(`Failed to start game: ${err}`, 'error');
    }
  };

  const commitMove = async (moveUCI: string) => {
    const oldFen = fen;
    selectSquare(null);
    setEngineBusy(true);
    const commitGen = gameGenerationRef.current;
    try {
      const result = await window.electronAPI.makeMove({ move: moveUCI }) as BackendMoveResult;
      // P2-T07: superseded mid-flight (new game / undo / navigate) — the new
      // position owns the store now; discard silently without touching busy.
      if (commitGen !== gameGenerationRef.current) return;
      
      // P2-T13: a capture removes a piece, so the total piece-letter count
      // drops. Count both boards with the SAME class (the old code stripped
      // white from old and black from new — non-comparable strings that
      // differ on nearly every move). Unchanged counts stay silent:
      // promotions swap one piece for another, castles move two pieces.
      // En passant still reports (the taken pawn leaves the count).
      const oldBoard = oldFen.split(' ')[0];
      const newBoard = result.fen.split(' ')[0];
      const countPieces = (board: string): number =>
        (board.match(/[pnbrqkPNBRQK]/g) ?? []).length;
      const isCapture = countPieces(newBoard) < countPieces(oldBoard);
      
      // P3-T01: same stale-terminal guard as playAndApply above - a flag
      // tick may have ended the game while the human move was in flight.
      const prevResult = useGameStore.getState().gameResult;
      const prevTermination = useGameStore.getState().termination;
      applyMoveResult(result);
      if (prevResult && !result.game_over) {
        useGameStore.setState({ gameResult: prevResult, termination: prevTermination });
      }
      Sound.move();
      if (isCapture) Sound.capture();
      if (result.in_check) Sound.check();
      if (result.game_over && result.result && result.result !== '1/2-1/2') Sound.checkmate();

      // In Human vs AI, trigger the engine reply asynchronously so UI shows human move immediately
      if (!result.game_over && useGameStore.getState().mode === 'human_vs_ai') {
        makeAiMove(result.fen).finally(() => {
          if (commitGen === gameGenerationRef.current) setEngineBusy(false);
        });
      } else if (commitGen === gameGenerationRef.current) {
        setEngineBusy(false);
      }
    } catch (err) {
      if (commitGen !== gameGenerationRef.current) return;
      Sound.illegal();
      pushToast(`Move error: ${err}`, 'error');
      setEngineBusy(false);
    }
  };

  const handleSquareClick = async (sq: string) => {
    if (gameResult || engineBusy) return;

    // Block human input when it's not their turn or the mode is AI-only
    const mode = useGameStore.getState().mode;
    if (mode === 'ai_vs_ai') return;
    if (mode === 'human_vs_ai' && turn !== humanColor) return;


    // Only own pieces (same color as the side to move) can be selected
    const isOwnPiece = pieceColorAt(fen, sq) === turn;

    if (!selectedSquare) {
      if (isOwnPiece) selectSquare(sq);
      return;
    }
    if (sq === selectedSquare) { selectSquare(null); return; }

    const moveUCI = legalMoves.find((m) => m.startsWith(selectedSquare) && m.slice(2, 4) === sq);
    if (!moveUCI) {
      // Switch to another own piece, or deselect if clicking empty/opponent square
      if (isOwnPiece) selectSquare(sq);
      else selectSquare(null);
      return;
    }

    if (!autoQueen && isPawnPromotion(fen, selectedSquare, sq)) {
      setPendingPromotion({ from: selectedSquare, to: sq });
      return;
    }
    await commitMove(selectedSquare + sq);
  };

  const handlePromotion = async (piece: string) => {
    if (!pendingPromotion) return;
    setPendingPromotion(null);
    await commitMove(`${pendingPromotion.from}${pendingPromotion.to}${piece}`);
  };

  /** Drop-move: fired by Board when a drag-and-drop completes. */
  const handleDropMove = async (from: string, to: string) => {
    if (gameResult || engineBusy) return;

    // Enforce turn ownership
    const mode = useGameStore.getState().mode;
    if (mode === 'ai_vs_ai') return;
    if (mode === 'human_vs_ai' && turn !== humanColor) return;

    selectSquare(null);
    const moveUCI = legalMoves.find((m) => m.startsWith(from) && m.slice(2, 4) === to);
    if (!moveUCI) return;
    if (!autoQueen && isPawnPromotion(fen, from, to)) {
      setPendingPromotion({ from, to });
      return;
    }
    await commitMove(from + to);
  };

  // P2-T07: undo cancels any in-flight AI reply (generation bump) and takes
  // ownership of the busy flag — cancel-and-undo, not refuse. The Undo button
  // is already disabled mid-think and Ctrl+Z has always issued undo, so
  // refusing here would remove working UX. Late replies discard via the
  // generation check in playAndApply.
  const handleUndo = async () => {
    gameGenerationRef.current += 1;
    const undoGen = gameGenerationRef.current;
    const gs = useGameStore.getState();
    try {
      const result = await window.electronAPI.undoMove() as BackendMoveResult;
      if (undoGen !== gameGenerationRef.current) return;
      gs.applyMoveResult(result);
    } catch (err) {
      if (undoGen !== gameGenerationRef.current) return;
      gs.pushToast(`Undo failed: ${err}`, 'error');
    } finally {
      if (undoGen === gameGenerationRef.current) gs.setEngineBusy(false);
    }
  };

  const handleNavigate = useCallback(async (index: number) => {
    // P2-T07: navigating supersedes any in-flight AI reply; rapid repeats
    // resolve latest-wins via the same check.
    gameGenerationRef.current += 1;
    const navGen = gameGenerationRef.current;
    try {
      const result = await window.electronAPI.navigateToMove({ index }) as BackendMoveResult;
      if (navGen !== gameGenerationRef.current) return;
      useGameStore.getState().applyMoveResult(result);
    } catch {/* ignore */} finally {
      // No AI work survives the bump, so the owner releases busy; a
      // superseding navigation owns it instead. Never leaves busy stuck.
      if (navGen === gameGenerationRef.current) useGameStore.getState().setEngineBusy(false);
    }
  }, []);

  // ── Navigation helpers (used by both buttons and keyboard) ────────────────
  const handleNavFirst = useCallback(() => {
    if (useGameStore.getState().fullMoveHistoryUCI.length === 0) return;
    handleNavigate(-1);
  }, [handleNavigate]);

  const handleNavPrev = useCallback(() => {
    const { navIndex, fullMoveHistoryUCI } = useGameStore.getState();
    const len = fullMoveHistoryUCI.length;
    if (len === 0) return;
    if (navIndex < 0) {
      // live end → step back one
      if (len >= 2) handleNavigate(len - 2);
      else handleNavigate(-1); // single-move game → go to start
    } else if (navIndex === 0) {
      handleNavigate(-1); // before first move
    } else {
      handleNavigate(navIndex - 1);
    }
  }, [handleNavigate]);

  const handleNavNext = useCallback(() => {
    const { navIndex, fullMoveHistoryUCI } = useGameStore.getState();
    const len = fullMoveHistoryUCI.length;
    if (navIndex < 0 || len === 0) return; // already at end
    if (navIndex < len - 1) handleNavigate(navIndex + 1);
    // navIndex === len-1 means we're already at the last navigated position
  }, [handleNavigate]);

  const handleNavLast = useCallback(() => {
    const { navIndex, fullMoveHistoryUCI } = useGameStore.getState();
    const len = fullMoveHistoryUCI.length;
    if (navIndex < 0 || len === 0) return;
    handleNavigate(len - 1);
  }, [handleNavigate]);

  // ── Keyboard hotkeys ──────────────────────────────────────────────────────
  // ←/→ navigate, Home/Ctrl+← first, End/Ctrl+→ last, Ctrl+Z undo, Z zen, Esc exit zen, F flip
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when typing in a form field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) handleNavFirst();
          else handleNavPrev();
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) handleNavLast();
          else handleNavNext();
          break;
        case 'Home':
          e.preventDefault();
          handleNavFirst();
          break;
        case 'End':
          e.preventDefault();
          handleNavLast();
          break;
        case 'z':
        case 'Z':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); handleUndo(); }
          else toggleZenMode();
          break;

        case 'f':
        case 'F':
          useGameStore.getState().flipBoard();
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  // P2-T02: flipBoard via getState(); handleUndo left as-is (P2-T07 owns its rewrite).
  }, [handleNavFirst, handleNavPrev, handleNavNext, handleNavLast, zenMode, toggleZenMode]);

  // P3-T01: resign/draw are backend commands now. The renderer forwards
  // intent (losing side for resign); result/termination come back in the
  // snapshot, so the backend stays the single termination authority and
  // autosave (keyed off gameResult) observes backend truth.
  const handleResign = async () => {
    const gs = useGameStore.getState();
    if (gs.gameResult || gs.mode === 'ai_vs_ai') return;
    // P2-T07 generation bump: resign supersedes any in-flight AI reply,
    // whose late apply must not resurrect the terminal position.
    gameGenerationRef.current += 1;
    const loser = gs.mode === 'human_vs_human' ? gs.turn : gs.humanColor;
    try {
      const result = await window.electronAPI.resign({ side: loser }) as BackendMoveResult;
      const st = useGameStore.getState();
      st.applyMoveResult(result);
      st.setEngineBusy(false);
      st.pushToast(`${loser === 'white' ? 'White' : 'Black'} resigned.`, 'info');
    } catch (err) {
      useGameStore.getState().pushToast(`Resign failed: ${err}`, 'error');
    }
  };

  const handleDraw = async () => {
    const gs = useGameStore.getState();
    if (gs.gameResult || gs.mode === 'ai_vs_ai') return;
    gameGenerationRef.current += 1;
    try {
      const result = await window.electronAPI.draw() as BackendMoveResult;
      const st = useGameStore.getState();
      st.applyMoveResult(result);
      st.setEngineBusy(false);
      st.pushToast('Draw agreed.', 'info');
    } catch (err) {
      useGameStore.getState().pushToast(`Draw failed: ${err}`, 'error');
    }
  };

  const handleExportPgn = async () => {
    if (!backendConnected) { pushToast('Backend not connected', 'error'); return; }
    try {
      const res = await window.electronAPI.exportPgn() as { pgn: string };
      await window.electronAPI.copyToClipboard(res.pgn);
      pushToast('PGN copied to clipboard', 'success');
    } catch (err) {
      pushToast(`Export failed: ${err}`, 'error');
    }
  };

  const handleSaveGame = async () => {
    try {
      const res = await window.electronAPI.exportPgn() as { pgn: string };
      const pgn = res.pgn ?? '';
      if (!pgn) {
        pushToast('No PGN to save yet', 'error');
        return;
      }
      const resultMap: Record<string, string> = {
        white_wins: '1-0',
        black_wins: '0-1',
        draw: '1/2-1/2',
      };
      const engineName = botDisplayName(playEngine);
      const whiteName = mode === 'human_vs_ai'
        ? (humanColor === 'white' ? 'You' : engineName)
        : mode === 'ai_vs_ai'
          ? engineName
          : 'White';
      const blackName = mode === 'human_vs_ai'
        ? (humanColor === 'black' ? 'You' : engineName)
        : mode === 'ai_vs_ai'
          ? engineName
          : 'Black';
      const mappedResult = gameResult ? resultMap[gameResult] : '*';
      const saveRes = await window.electronAPI.saveGameHistory({
        pgn,
        meta: {
          white: whiteName,
          black: blackName,
          result: mappedResult,
          termination: termination,
          moves: fullMoveHistoryLength,
          mode: mode,
          engine: playEngine,
          time_control: timeControl,
          played_at: new Date().toISOString(),
        },
      });
      if (saveRes.ok) {
        pushToast('Game saved', 'success');
      } else {
        pushToast('Save failed', 'error');
      }
    } catch (err) {
      pushToast(`Save failed: ${err}`, 'error');
    }
  };

  const handleExportFen = async () => {
    if (!backendConnected) { pushToast('Backend not connected', 'error'); return; }
    try {
      const res = await window.electronAPI.exportFen() as { fen: string };
      await window.electronAPI.copyToClipboard(res.fen);
      pushToast('FEN copied to clipboard', 'success');
    } catch (err) {
      pushToast(`FEN export failed: ${err}`, 'error');
    }
  };

  const handleExportFenCollection = async () => {
    if (!backendConnected) { pushToast('Backend not connected', 'error'); return; }
    try {
      const fenRes = await window.electronAPI.exportFen() as { fen: string };
      const pgnRes = await window.electronAPI.exportPgn() as { pgn: string };
      const lines: string[] = ['# FEN Collection - Aether Chess'];
      lines.push(`# Current FEN: ${fenRes.fen}`);
      lines.push(`# PGN: ${pgnRes.pgn.replace(/\n/g, ' | ')}`);
      lines.push('');
      lines.push(`0. ${fenRes.fen}`);
      if (fullMoveHistoryLength > 0) {
        lines.push('');
        lines.push('# Move FENs (use PGN for full game):');
      }
      await window.electronAPI.copyToClipboard(lines.join('\n'));
      pushToast('FEN collection copied to clipboard', 'success');
    } catch (err) {
      pushToast(`FEN collection export failed: ${err}`, 'error');
    }
  };

  // ── Player card labels — adapt to current game mode ───────────────────────
  const engineName = botDisplayName(playEngine);
  const engineElo = botEloForStrength(botStrength, playEngine);

  let topThinking = false;
let showResignDraw: boolean;

  // P3-T01: cards render the backend clock mirror (whole seconds, ceil so
  // a fresh 180 s clock reads 03:00). Null clock (Unlimited) -> '--:--'.
  const whiteSecs = clock ? Math.max(0, Math.ceil(clock.white_ms / 1000)) : null;
  const blackSecs = clock ? Math.max(0, Math.ceil(clock.black_ms / 1000)) : null;


  // Determine card data for both positions
  let whiteCard: { name: string; elo?: number; isUser: boolean; time: number | null; active: boolean };
  let blackCard: { name: string; elo?: number; isUser: boolean; time: number | null; active: boolean };

  if (mode === 'human_vs_human') {
    whiteCard = { name: 'White', elo: undefined, isUser: true, time: whiteSecs, active: turn === 'white' };
    blackCard = { name: 'Black', elo: undefined, isUser: true, time: blackSecs, active: turn === 'black' };
    showResignDraw = true;
  } else if (mode === 'ai_vs_ai') {
    whiteCard = { name: `${engineName} (White)`, elo: engineElo, isUser: false, time: whiteSecs, active: turn === 'white' };
    blackCard = { name: `${engineName} (Black)`, elo: engineElo, isUser: false, time: blackSecs, active: turn === 'black' };
    showResignDraw = false;
    topThinking = engineBusy;
  } else {
    // human_vs_ai
    const humanIsWhite = humanColor === 'white';
    whiteCard = humanIsWhite
      ? { name: 'You', elo: undefined, isUser: true, time: whiteSecs, active: turn === 'white' }
      : { name: engineName, elo: engineElo, isUser: false, time: whiteSecs, active: turn === 'white' };
    blackCard = humanIsWhite
      ? { name: engineName, elo: engineElo, isUser: false, time: blackSecs, active: turn === 'black' }
      : { name: 'You', elo: undefined, isUser: true, time: blackSecs, active: turn === 'black' };
    showResignDraw = true;
    topThinking = engineBusy;
  }

  // When flipped, swap white and black card data
  const topCard = flipped ? whiteCard : blackCard;
  const bottomCard = flipped ? blackCard : whiteCard;
  const topName = topCard.name;
  const topElo = topCard.elo;
  const topTime = topCard.time;
  const topActive = topCard.active;

  const bottomName = bottomCard.name;
  const bottomTime = bottomCard.time;
  const bottomElo = bottomCard.elo;

  const formatTime = (s: number | null | undefined): string => {
    if (s == null || s < 0) return '--:--';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const bottomActive = !topActive;

  const zenTimerOverlay = (active: boolean, name: string, elo: number | undefined, time: number | null, top: boolean) => (
    <div
      className={`absolute ${top ? 'top-0' : 'bottom-0'} left-0 right-0 flex items-center gap-2 px-2 py-0.5 text-[11px] font-mono ${top ? 'bg-gradient-to-b from-[rgba(0,0,0,0.55)] to-transparent rounded-t-[3px]' : 'bg-gradient-to-t from-[rgba(0,0,0,0.55)] to-transparent rounded-b-[3px]'}`}
    >
      <span className={`w-2 h-2 rounded-full ${active ? 'bg-accent' : 'bg-surface2'}`} />
      <span className="flex-1 truncate font-medium text-on-surface">{name}</span>
      {elo != null && <span className="text-muted">({elo})</span>}
      <span className={`tabular-nums font-semibold ${active ? 'text-accent' : 'text-on-surface'}`}>
        {formatTime(time)}
      </span>
    </div>
  );

  if (zenMode) {
    return (
      <div ref={zenBoardRef} className="fixed inset-0 z-[60] bg-bg flex items-center justify-center">
        {zenBoardSize > 0 && (
          <div className="relative" style={{ width: zenBoardSize, height: zenBoardSize }}>
            <Board
              onSquareClick={handleSquareClick}
              onDropMove={handleDropMove}
            />
            {zenTimerOverlay(topActive, topName, topElo, topTime, true)}
            {zenTimerOverlay(bottomActive, bottomName, bottomElo, bottomTime, false)}
          </div>
        )}
        <button
          onClick={toggleZenMode}
          className="fixed top-2 right-2 z-[70] flex items-center gap-1 px-2 py-1 rounded text-[10px] text-muted hover:text-on-surface bg-surface/60 hover:bg-surface/90 transition-colors"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 12 }}>close</span>
          Exit zen
        </button>
        {pendingPromotion && (
          <PromotionDialog
            color={turn}
            onSelect={handlePromotion}
            onCancel={() => setPendingPromotion(null)}
          />
        )}
        {gameResult && (
          <GameOverModal
            onRematch={handleNewGame}
            onAnalyze={() => onTabChange('analysis')}
            onMenu={handleNewGame}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-row gap-3 h-full w-full px-3 py-2">
      {/* LEFT COLUMN: Board + Eval + Controls */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        {/* Board area - fills available vertical space */}
        <div ref={boardAreaRef} className="flex-1 min-h-0 flex items-center justify-center overflow-hidden">
          {boardSize > 0 && (
            <div className="relative" style={{ width: boardSize, height: boardSize }}>
              <Board
                onSquareClick={handleSquareClick}
                onDropMove={handleDropMove}
              />
            </div>
          )}
        </div>

        {/* Eval bar */}
        {showEvalBar && <EvalBar />}

        {/* Game controls */}
        <GameControls
          onFlip={flipBoard}
          onUndo={handleUndo}
          onDraw={showResignDraw ? handleDraw : undefined}
          onResign={showResignDraw ? handleResign : undefined}
        />
      </div>

      {/* RIGHT COLUMN: Side panel */}
      <div className="w-[260px] flex-shrink-0 flex flex-col gap-2">
        {/* Top player info */}
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-card bg-surface border border-surface2">
          <div className="w-7 h-7 rounded-full bg-surface2 flex items-center justify-center border border-surface3 overflow-hidden">
            <span className="material-symbols-outlined text-muted" style={{ fontSize: 16 }}>person</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-sans font-medium text-on-surface truncate">{topName}</div>
            {topElo != null && <div className="text-[10px] font-body text-muted">{topElo}</div>}
          </div>
          {topThinking && (
            <span className="flex gap-0.5 items-center">
              <span className="w-1 h-1 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1 h-1 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          )}
          <span className={`w-1.5 h-1.5 rounded-full ${topActive ? 'bg-accent' : 'bg-surface2'}`} />
          <span className={`tabular-nums font-semibold text-[11px] font-mono ${topActive ? 'text-accent' : 'text-on-surface'}`}>
            {formatTime(topTime)}
          </span>
        </div>

        {/* Move history - fills remaining space */}
        <div className="flex-1 min-h-0 flex flex-col">
          <MoveHistory
            onMoveClick={handleNavigate}
            onNavFirst={handleNavFirst}
            onNavPrev={handleNavPrev}
            onNavNext={handleNavNext}
            onNavLast={handleNavLast}
            fillHeight
          />
        </div>

        {/* Bottom player info */}
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-card bg-surface border border-surface2">
          <div className="w-7 h-7 rounded-full bg-surface2 flex items-center justify-center border border-surface3 overflow-hidden">
            <span className="material-symbols-outlined text-muted" style={{ fontSize: 16 }}>person</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-sans font-medium text-on-surface truncate">{bottomName}</div>
            {bottomElo != null && <div className="text-[10px] font-body text-muted">{bottomElo}</div>}
          </div>
          <span className={`w-1.5 h-1.5 rounded-full ${bottomActive ? 'bg-accent' : 'bg-surface2'}`} />
          <span className={`tabular-nums font-semibold text-[11px] font-mono ${bottomActive ? 'text-accent' : 'text-on-surface'}`}>
            {formatTime(bottomTime)}
          </span>
        </div>

        {/* Action buttons row */}
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={handleExportPgn}
            className="flex flex-col items-center gap-0.5 py-1.5 border border-surface2 rounded text-[10px] text-muted font-sans hover:border-accent hover:text-accent active:scale-95 transition-all"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>content_copy</span>
            PGN
          </button>
          <button
            onClick={handleSaveGame}
            className="flex flex-col items-center gap-0.5 py-1.5 border border-surface2 rounded text-[10px] text-muted font-sans hover:border-accent hover:text-accent active:scale-95 transition-all"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>save</span>
            Save
          </button>
          <button
            onClick={handleExportFen}
            className="flex flex-col items-center gap-0.5 py-1.5 border border-surface2 rounded text-[10px] text-muted font-sans hover:border-accent hover:text-accent active:scale-95 transition-all"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span>
            FEN
          </button>
          <button
            onClick={handleExportFenCollection}
            className="flex flex-col items-center gap-0.5 py-1.5 border border-surface2 rounded text-[10px] text-muted font-sans hover:border-accent hover:text-accent active:scale-95 transition-all"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>collections_bookmark</span>
            Collect
          </button>
        </div>

        {/* New Game Setup */}
        <div className="flex flex-col gap-2 border border-surface2 rounded-lg p-3 bg-surface">
          <span className="text-[10px] font-sans text-muted uppercase tracking-wider">New Game</span>
          <div className="flex gap-2">
            <div className="flex flex-col gap-1 flex-1">
              <span className="text-[10px] text-inactive font-sans">Mode</span>
              <select
                className={setupSelectClass}
                value={setupMode}
                onChange={(e) => setSetupMode(e.target.value as GameMode)}
              >
                <option value="human_vs_ai">vs AI</option>
                <option value="human_vs_human">vs Human</option>
                <option value="ai_vs_ai">AI vs AI</option>
              </select>
            </div>
            {setupMode !== 'ai_vs_ai' && (
              <div className="flex flex-col gap-1 flex-1">
                <span className="text-[10px] text-inactive font-sans">Play as</span>
                <select
                  className={setupSelectClass}
                  value={setupColor}
                  onChange={(e) => setSetupColor(e.target.value as typeof setupColor)}
                >
                  <option value="white">White</option>
                  <option value="black">Black</option>
                  <option value="random">Random</option>
                </select>
              </div>
            )}
          </div>
          <button
            onClick={handleNewGame}
            className="w-full py-1.5 bg-accent text-bg rounded-lg text-xs font-sans font-semibold hover:opacity-90 active:scale-95 transition-all"
          >
            New Game
          </button>
        </div>
      </div>

      {pendingPromotion && (
        <PromotionDialog
          color={turn}
          onSelect={handlePromotion}
          onCancel={() => setPendingPromotion(null)}
        />
      )}
      {gameResult && (
        <GameOverModal
          onRematch={handleNewGame}
          onAnalyze={() => onTabChange('analysis')}
          onMenu={handleNewGame}
        />
      )}
    </div>
  );
};
