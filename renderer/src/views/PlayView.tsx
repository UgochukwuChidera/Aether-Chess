/**
 * PlayView.tsx — Main game play tab.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Board } from '../components/Board';
import { EvalBar } from '../components/EvalBar';
import { PlayerCard } from '../components/PlayerCard';
import { MoveHistory } from '../components/MoveHistory';
import { GameControls } from '../components/GameControls';
import { GameOverModal } from '../components/GameOverModal';
import { PromotionDialog } from '../components/PromotionDialog';
import { useGameStore, type BackendMoveResult, type PVLine, type GameMode, type Color } from '../stores/gameStore';
import { useSettingsStore } from '../stores/settingsStore';
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
  const store = useGameStore();
  const settings = useSettingsStore();
  const [whiteTime, setWhiteTime] = useState<number | null>(null);
  const [blackTime, setBlackTime] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoSaveRef = useRef(false);

  // ── Game setup state (applied on next "New Game") ─────────────────────────
  const [setupMode, setSetupMode] = useState<GameMode>(store.mode);
  const [setupColor, setSetupColor] = useState<'white' | 'black' | 'random'>('white');

  // ── AI vs AI loop control ─────────────────────────────────────────────────
  const aiLoopRef = useRef(false);

  // ── Analysis debounce ─────────────────────────────────────────────────────
  const analysisDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stockfishDepthForStrength = (strength: number): number => {
    const s = Math.max(1, Math.min(10, strength));
    return 5 + s;
  };
  const botEloForStrength = (strength: number, engine: 'stockfish' | 'mentor' | 'maia3'): number => {
    const s = Math.max(1, Math.min(10, strength));
    if (engine === 'stockfish') return Math.round(900 + s * 180);
    if (engine === 'maia3') return Math.round(1000 + s * 150);
    return Math.round(850 + s * 170);
  };

  useEffect(() => {
    handleNewGame();
    return () => { aiLoopRef.current = false; };
  }, []);


  useEffect(() => {
    window.electronAPI.onAnalysisUpdate((raw: unknown) => {
      const data = raw as { callback_id: string; pvs?: unknown[]; fen?: string; error?: string };
      if (data.callback_id !== PLAY_ANALYSIS_CB_ID) return;
      if (data.error) {
        store.setAnalysis({ running: false });
        return;
      }
      // Only accept analysis for the current position - ignore stale results
      if (data.fen !== store.fen) {
        return;
      }
      store.setAnalysis({
        pvs: (data.pvs as PVLine[]) ?? [],
        fen: data.fen ?? store.fen,
        running: true,
      });
    });
    return () => {
      window.electronAPI.stopAnalysis().catch(() => {});
      window.electronAPI.removeAnalysisListeners();
    };
  }, []);

  // Debounced eval-bar analysis — stop immediately, restart after 350 ms of quiet.
  useEffect(() => {
    if (!settings.showEvalBar) {
      store.setAnalysis({ running: false, pvs: [] });
      window.electronAPI.stopAnalysis().catch(() => {});
      return;
    }

    void window.electronAPI.stopAnalysis().catch(() => {});
    store.setAnalysis({ running: false });

    if (analysisDebounceRef.current) clearTimeout(analysisDebounceRef.current);
    analysisDebounceRef.current = setTimeout(() => {
      analysisDebounceRef.current = null;
      window.electronAPI.startAnalysis({
        fen: store.fen,
        multipv: 1,
        callback_id: PLAY_ANALYSIS_CB_ID,
        stockfish_path: settings.stockfishPath,
        threads: settings.threads,
        hash_mb: settings.hashMb,
      }).catch(() => {});
    }, 350);

    return () => {
      if (analysisDebounceRef.current) {
        clearTimeout(analysisDebounceRef.current);
        analysisDebounceRef.current = null;
      }
    };
  }, [
    store.fen,
    settings.showEvalBar,
    settings.stockfishPath,
    settings.threads,
    settings.hashMb,
  ]);

  useEffect(() => {
    if (!store.gameResult) return;
    if (timerRef.current) clearInterval(timerRef.current);
  }, [store.gameResult]);

  useEffect(() => {
    if (!store.gameResult || !settings.autoSaveGameHistory || autoSaveRef.current) return;
    if (store.fullMoveHistoryUCI.length === 0) return;
    autoSaveRef.current = true;

    const resultMap: Record<NonNullable<typeof store.gameResult>, string> = {
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

    window.electronAPI.exportPgn()
      .then((res) => {
        const pgn = (res as { pgn?: string }).pgn ?? '';
        return window.electronAPI.saveGameHistory({
          pgn,
          meta: {
            white: whiteName,
            black: blackName,
            result: resultMap[store.gameResult],
            termination: store.termination,
            moves: store.fullMoveHistoryUCI.length,
            mode: store.mode,
            engine: settings.playEngine,
            time_control: settings.timeControl,
            played_at: new Date().toISOString(),
          },
        });
      })
      .catch(() => {
        store.pushToast('Auto-save failed', 'error');
        autoSaveRef.current = false;
      });
  }, [store.gameResult, store.fullMoveHistoryUCI.length, store.termination, store.mode, store.humanColor, settings.autoSaveGameHistory, settings.playEngine, settings.timeControl]);

  useEffect(() => {
    const tc = settings.timeControl;
    if (tc.seconds === 0 || !whiteTime) return;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      if (store.gameResult) { clearInterval(timerRef.current!); return; }
      if (store.turn === 'white') setWhiteTime((t) => t !== null ? Math.max(0, t - 1) : null);
      else setBlackTime((t) => t !== null ? Math.max(0, t - 1) : null);
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [store.turn, store.gameResult]);

  // ── AI move helper — reads fresh state so it's safe in async loops ──────────
  const makeAiMove = useCallback(async (fen: string): Promise<BackendMoveResult | null> => {
    const cfg = useSettingsStore.getState();
    const gs = useGameStore.getState();
    const isWhiteTurn = gs.turn === 'white';
    const timeRemaining = isWhiteTurn ? whiteTime : blackTime;
    const totalMoves = gs.fullMoveHistoryUCI.length;
    const requestedEngine = cfg.playEngine;
    console.log('[AI] makeAiMove called', { fen: fen?.slice(0, 30), totalMoves, playEngine: requestedEngine, botStrength: cfg.botStrength });

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
                console.log('[AI] Book move:', move.uci);
                const result = await window.electronAPI.makeMove({ move: move.uci }) as BackendMoveResult;
                return result;
              }
            }
          }
        }
      } catch (e) { console.warn('[AI] Book error:', e); }
    }

    console.log('[AI] Getting engine move, FEN:', fen);

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
    
    let enginePromise: Promise<{ move: string | null }>;
    if (cfg.playEngine === 'stockfish') {
      enginePromise = window.electronAPI.getEngineMove({
        fen,
        depth: stockfishDepthForStrength(cfg.botStrength),
        stockfish_path: cfg.stockfishPath,
        threads: cfg.threads,
        hash_mb: cfg.hashMb,
        engine_type: 'stockfish',
        think_profile: cfg.thinkProfile,
        time_remaining: timeRemaining ?? undefined,
        time_increment: cfg.timeControl.increment ?? undefined,
      }) as Promise<{ move: string | null }>;
    } else if (cfg.playEngine === 'maia3') {
      enginePromise = window.electronAPI.getEngineMove({
        fen,
        engine_type: 'maia3',
        maia3_model: cfg.maia3Model,
        maia3_device: cfg.maia3Device,
        maia3_elo: cfg.maia3Elo,
        think_profile: cfg.thinkProfile,
        time_remaining: timeRemaining ?? undefined,
        time_increment: cfg.timeControl.increment ?? undefined,
      }) as Promise<{ move: string | null }>;
    } else {
      enginePromise = window.electronAPI.getBotMove({
        fen,
        strength: cfg.botStrength,
        stockfish_path: cfg.stockfishPath,
        threads: cfg.threads,
        hash_mb: cfg.hashMb,
        time_remaining: timeRemaining ?? undefined,
        time_increment: cfg.timeControl.increment ?? undefined,
        total_moves: totalMoves,
      }) as Promise<{ move: string | null }>;
    }
    
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
    console.log('[AI] Requesting engine move', { engine: cfg.playEngine, fen });
    reply = await getEngineMoveSafe();
  } catch (e) {
    console.error('[AI] Engine call failed:', e);
    return null;
  }

  if (!reply || !reply.move) {
    console.warn('[AI] No move returned, using fallback');
    const toast = useGameStore.getState().pushToast;
    toast(`${requestedEngine === 'stockfish' ? 'Stockfish' : requestedEngine === 'maia3' ? 'Maia3' : 'Mentor'} failed — using fallback move`, 'error');
    // Fallback: return a legal move as last resort
    const legal = await window.electronAPI.getLegalMoves({ fen }) as { moves?: { uci: string }[] };
    const moves = legal?.moves;
    if (moves && moves.length > 0) {
      const fallbackMove = moves[0].uci;
      console.log('[AI] Using fallback move:', fallbackMove);
      const result = await window.electronAPI.makeMove({ move: fallbackMove }) as BackendMoveResult;
      useGameStore.getState().applyMoveResult(result);
      return result;
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
    const result = await window.electronAPI.makeMove({ move: fallbackMove }) as BackendMoveResult;
    useGameStore.getState().applyMoveResult(result);
    return result;
  }
  
  if (reply._fallback_msg) {
    const toast = useGameStore.getState().pushToast;
    toast(reply._fallback_msg, 'warning');
  }
  console.log('[AI] Engine returned:', reply.move);
  const result = await window.electronAPI.makeMove({ move: reply.move }) as BackendMoveResult;
  useGameStore.getState().applyMoveResult(result);
  return result;
  }, [whiteTime, blackTime]);

  // ── AI vs AI autonomous loop ──────────────────────────────────────────────
  const runAiVsAiLoop = useCallback(async () => {
    while (aiLoopRef.current) {
      const s = useGameStore.getState();
      if (s.gameResult) { aiLoopRef.current = false; break; }

      useGameStore.getState().setEngineBusy(true);
      try {
        const result = await makeAiMove(s.fen);
        if (!result || result.game_over) { aiLoopRef.current = false; break; }
      } catch {
        aiLoopRef.current = false;
        break;
      } finally {
        useGameStore.getState().setEngineBusy(false);
      }

      if (aiLoopRef.current) await new Promise<void>((r) => setTimeout(r, 400));
    }
  }, [makeAiMove]);

  const handleNewGame = async () => {
    // Stop any running AI loop / analysis before resetting
    aiLoopRef.current = false;
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

    try {
      const result = await window.electronAPI.newGame({
        mode: setupMode,
        engine_type: settings.playEngine,
        human_color: resolvedColor,
        strength: settings.botStrength,
        stockfish_path: settings.stockfishPath,
        maia3_path: settings.maia3Path,
        maia3_model: settings.maia3Model,
        maia3_device: settings.maia3Device,
        maia3_elo: settings.maia3Elo,
        think_profile: settings.thinkProfile,
        threads: settings.threads,
        hash_mb: settings.hashMb,
        multipv: settings.multipv,
      }) as BackendMoveResult;

      store.resetGame();
      // resetGame doesn't touch mode/humanColor; re-assert to be explicit
      useGameStore.setState({ mode: setupMode, humanColor: resolvedColor });
      // Flip board if human is playing as black
      store.setFlipped(resolvedColor === 'black');
      store.applyMoveResult(result);

      if (settings.timeControl.seconds > 0) {
        setWhiteTime(settings.timeControl.seconds);
        setBlackTime(settings.timeControl.seconds);
      }

      // Orchestrate first AI move(s) depending on mode
      if (setupMode === 'ai_vs_ai') {
        aiLoopRef.current = true;
        void runAiVsAiLoop();
      } else if (setupMode === 'human_vs_ai' && result.turn !== resolvedColor) {
        // Human chose black — AI (white) moves first.
        // Show board immediately by firing AI async so UI stays responsive.
        store.setEngineBusy(true);
        makeAiMove(result.fen).then((aiResult) => {
          if (aiResult) {
            store.applyMoveResult(aiResult);
          }
        }).finally(() => {
          store.setEngineBusy(false);
        });
      }
    } catch (err) {
      store.pushToast(`Failed to start game: ${err}`, 'error');
    }
  };

  const commitMove = async (moveUCI: string) => {
    const oldFen = store.fen;
    store.selectSquare(null);
    store.setEngineBusy(true);
    try {
      const result = await window.electronAPI.makeMove({ move: moveUCI }) as BackendMoveResult;
      
      // Determine if this was a capture for sound
      const oldBoard = oldFen.split(' ')[0];
      const newBoard = result.fen.split(' ')[0];
      const isCapture = oldBoard.replace(/[PNBRQK]/g, '') !== newBoard.replace(/[pnbrqk]/g, '');
      
      store.applyMoveResult(result);
      Sound.move();
      if (isCapture) Sound.capture();
      if (result.in_check) Sound.check();
      if (result.game_over && result.result && result.result !== '1/2-1/2') Sound.checkmate();

      // In Human vs AI, trigger the engine reply asynchronously so UI shows human move immediately
      if (!result.game_over && useGameStore.getState().mode === 'human_vs_ai') {
        makeAiMove(result.fen).then((aiResult) => {
          if (aiResult) {
            store.applyMoveResult(aiResult);
          }
        }).finally(() => {
          store.setEngineBusy(false);
        });
      } else {
        store.setEngineBusy(false);
      }
    } catch (err) {
      Sound.illegal();
      store.pushToast(`Move error: ${err}`, 'error');
      store.setEngineBusy(false);
    }
  };

  const handleSquareClick = async (sq: string) => {
    if (store.gameResult || store.engineBusy) return;

    // Block human input when it's not their turn or the mode is AI-only
    const mode = useGameStore.getState().mode;
    if (mode === 'ai_vs_ai') return;
    if (mode === 'human_vs_ai' && store.turn !== store.humanColor) return;

    const { selectedSquare, legalMoves, fen, turn } = store;

    // Only own pieces (same color as the side to move) can be selected
    const isOwnPiece = pieceColorAt(fen, sq) === turn;

    if (!selectedSquare) {
      if (isOwnPiece) store.selectSquare(sq);
      return;
    }
    if (sq === selectedSquare) { store.selectSquare(null); return; }

    const moveUCI = legalMoves.find((m) => m.startsWith(selectedSquare) && m.slice(2, 4) === sq);
    if (!moveUCI) {
      // Switch to another own piece, or deselect if clicking empty/opponent square
      if (isOwnPiece) store.selectSquare(sq);
      else store.selectSquare(null);
      return;
    }

    if (!settings.autoQueen && isPawnPromotion(fen, selectedSquare, sq)) {
      store.setPendingPromotion({ from: selectedSquare, to: sq });
      return;
    }
    await commitMove(selectedSquare + sq);
  };

  const handlePromotion = async (piece: string) => {
    const { pendingPromotion } = store;
    if (!pendingPromotion) return;
    store.setPendingPromotion(null);
    await commitMove(`${pendingPromotion.from}${pendingPromotion.to}${piece}`);
  };

  /** Drop-move: fired by Board when a drag-and-drop completes. */
  const handleDropMove = async (from: string, to: string) => {
    if (store.gameResult || store.engineBusy) return;

    // Enforce turn ownership
    const mode = useGameStore.getState().mode;
    if (mode === 'ai_vs_ai') return;
    if (mode === 'human_vs_ai' && store.turn !== store.humanColor) return;

    store.selectSquare(null);
    const { legalMoves, fen } = store;
    const moveUCI = legalMoves.find((m) => m.startsWith(from) && m.slice(2, 4) === to);
    if (!moveUCI) return;
    if (!settings.autoQueen && isPawnPromotion(fen, from, to)) {
      store.setPendingPromotion({ from, to });
      return;
    }
    await commitMove(from + to);
  };

  const handleUndo = async () => {
    try {
      const result = await window.electronAPI.undoMove() as BackendMoveResult;
      store.applyMoveResult(result);
    } catch (err) {
      store.pushToast(`Undo failed: ${err}`, 'error');
    }
  };

  const handleNavigate = useCallback(async (index: number) => {
    try {
      const result = await window.electronAPI.navigateToMove({ index }) as BackendMoveResult;
      store.applyMoveResult(result);
    } catch {/* ignore */}
  }, []);

  // ── Navigation helpers (used by both buttons and keyboard) ────────────────
  const handleNavFirst = useCallback(() => {
    if (store.fullMoveHistoryUCI.length === 0) return;
    handleNavigate(-1);
  }, [store.fullMoveHistoryUCI.length]);

  const handleNavPrev = useCallback(() => {
    const { navIndex, fullMoveHistoryUCI } = store;
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
  }, [store.navIndex, store.fullMoveHistoryUCI.length]);

  const handleNavNext = useCallback(() => {
    const { navIndex, fullMoveHistoryUCI } = store;
    const len = fullMoveHistoryUCI.length;
    if (navIndex < 0 || len === 0) return; // already at end
    if (navIndex < len - 1) handleNavigate(navIndex + 1);
    // navIndex === len-1 means we're already at the last navigated position
  }, [store.navIndex, store.fullMoveHistoryUCI.length]);

  const handleNavLast = useCallback(() => {
    const { navIndex, fullMoveHistoryUCI } = store;
    const len = fullMoveHistoryUCI.length;
    if (navIndex < 0 || len === 0) return;
    handleNavigate(len - 1);
  }, [store.navIndex, store.fullMoveHistoryUCI.length]);

  // ── Keyboard hotkeys ──────────────────────────────────────────────────────
  // ←/→ navigate, Home/Ctrl+← first, End/Ctrl+→ last, Ctrl+Z undo, F flip
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
          break;
        case 'f':
        case 'F':
          store.flipBoard();
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleNavFirst, handleNavPrev, handleNavNext, handleNavLast]);

  const handleResign = () => {
    const mode = useGameStore.getState().mode;
    if (mode === 'ai_vs_ai') return;
    if (mode === 'human_vs_human') {
      // Resign for the active player (whoever's turn it is)
      const loser = store.turn;
      store.pushToast(`${loser === 'white' ? 'White' : 'Black'} resigned.`, 'info');
      useGameStore.setState({
        gameResult: loser === 'white' ? 'black_wins' : 'white_wins',
        termination: 'RESIGN',
      });
    } else {
      store.pushToast('You resigned.', 'info');
      useGameStore.setState({
        gameResult: store.humanColor === 'white' ? 'black_wins' : 'white_wins',
        termination: 'RESIGN',
      });
    }
  };

  const handleDraw = () => store.pushToast('Draw offered (not accepted by engine)', 'info');

  const handleExportPgn = async () => {
    try {
      const res = await window.electronAPI.exportPgn() as { pgn: string };
      await navigator.clipboard.writeText(res.pgn);
      store.pushToast('PGN copied to clipboard', 'success');
    } catch (err) {
      store.pushToast(`Export failed: ${err}`, 'error');
    }
  };

  const handleSaveGame = async () => {
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
      } else {
        store.pushToast('Save failed', 'error');
      }
    } catch (err) {
      store.pushToast(`Save failed: ${err}`, 'error');
    }
  };

  const handleExportFen = async () => {
    try {
      const res = await window.electronAPI.exportFen() as { fen: string };
      await navigator.clipboard.writeText(res.fen);
      store.pushToast('FEN copied to clipboard', 'success');
    } catch (err) {
      store.pushToast(`FEN export failed: ${err}`, 'error');
    }
  };

  const handleExportFenCollection = async () => {
    try {
      const fenRes = await window.electronAPI.exportFen() as { fen: string };
      const pgnRes = await window.electronAPI.exportPgn() as { pgn: string };
      const lines: string[] = ['# FEN Collection - Aether Chess'];
      lines.push(`# Current FEN: ${fenRes.fen}`);
      lines.push(`# PGN: ${pgnRes.pgn.replace(/\n/g, ' | ')}`);
      lines.push('');
      lines.push(`0. ${fenRes.fen}`);
      if (store.fullMoveHistoryUCI.length > 0) {
        lines.push('');
        lines.push('# Move FENs (use PGN for full game):');
      }
      await navigator.clipboard.writeText(lines.join('\n'));
      store.pushToast('FEN collection copied to clipboard', 'success');
    } catch (err) {
      store.pushToast(`FEN collection export failed: ${err}`, 'error');
    }
  };

  // ── Player card labels — adapt to current game mode ───────────────────────
  const engineName = settings.playEngine === 'stockfish' ? 'Stockfish' : settings.playEngine === 'maia3' ? 'Maia3' : 'Mentor';
  const engineElo = botEloForStrength(settings.botStrength, settings.playEngine);

  let topThinking = false;
let showResignDraw: boolean;

  const flipped = store.flipped;
  const mode = store.mode;

  // Determine card data for both positions
  let whiteCard: { name: string; elo?: number; isUser: boolean; time: number | null; active: boolean };
  let blackCard: { name: string; elo?: number; isUser: boolean; time: number | null; active: boolean };

  if (mode === 'human_vs_human') {
    whiteCard = { name: 'White', elo: undefined, isUser: true, time: whiteTime, active: store.turn === 'white' };
    blackCard = { name: 'Black', elo: undefined, isUser: true, time: blackTime, active: store.turn === 'black' };
    showResignDraw = true;
  } else if (mode === 'ai_vs_ai') {
    whiteCard = { name: `${engineName} (White)`, elo: engineElo, isUser: false, time: whiteTime, active: store.turn === 'white' };
    blackCard = { name: `${engineName} (Black)`, elo: engineElo, isUser: false, time: blackTime, active: store.turn === 'black' };
    showResignDraw = false;
    topThinking = store.engineBusy;
  } else {
    // human_vs_ai
    const humanIsWhite = store.humanColor === 'white';
    whiteCard = humanIsWhite
      ? { name: 'You', elo: undefined, isUser: true, time: whiteTime, active: store.turn === 'white' }
      : { name: engineName, elo: engineElo, isUser: false, time: whiteTime, active: store.turn === 'white' };
    blackCard = humanIsWhite
      ? { name: engineName, elo: engineElo, isUser: false, time: blackTime, active: store.turn === 'black' }
      : { name: 'You', elo: undefined, isUser: true, time: blackTime, active: store.turn === 'black' };
    showResignDraw = true;
    topThinking = store.engineBusy;
  }

  // When flipped, swap white and black card data
  const topCard = flipped ? whiteCard : blackCard;
  const bottomCard = flipped ? blackCard : whiteCard;
  const topName = topCard.name;
  const topElo = topCard.elo;
  const topIsUser = topCard.isUser;
  const topTime = topCard.time;
  const topActive = topCard.active;

  const bottomName = bottomCard.name;
  const bottomIsUser = bottomCard.isUser;
  const bottomTime = bottomCard.time;

  return (
    <div className="flex flex-col gap-2 w-full">
      <PlayerCard
        name={topName}
        elo={topElo}
        online={true}
        isUser={topIsUser}
        timeSeconds={topTime}
        isActive={topActive}
        thinking={topThinking}
      />
      {settings.showEvalBar && <EvalBar />}
      <Board
        onSquareClick={handleSquareClick}
        onDropMove={handleDropMove}
      />
      <PlayerCard
        name={bottomName}
        online={true}
        isUser={bottomIsUser}
        timeSeconds={bottomTime}
        isActive={!topActive}
      />
      <GameControls
        onFlip={store.flipBoard}
        onUndo={handleUndo}
        onDraw={showResignDraw ? handleDraw : undefined}
        onResign={showResignDraw ? handleResign : undefined}
      />
      <MoveHistory
        onMoveClick={handleNavigate}
        onNavFirst={handleNavFirst}
        onNavPrev={handleNavPrev}
        onNavNext={handleNavNext}
        onNavLast={handleNavLast}
      />

      {/* ── Game Setup ────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 border border-surface2 rounded-lg p-3 bg-surface">
        <span className="text-[10px] font-sans text-muted uppercase tracking-wider">New Game Setup</span>
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
        <div className="flex gap-2">
          <button
            onClick={handleExportPgn}
            className="flex-1 py-1.5 border border-surface2 rounded text-xs text-muted font-sans
                       hover:border-accent hover:text-accent active:scale-95 transition-all"
          >
            Copy PGN
          </button>
          <button
            onClick={handleSaveGame}
            className="flex-1 py-1.5 border border-surface2 rounded text-xs text-muted font-sans
                       hover:border-accent hover:text-accent active:scale-95 transition-all"
          >
            Save Game
          </button>
          <button
            onClick={handleExportFen}
            className="flex-1 py-1.5 border border-surface2 rounded text-xs text-muted font-sans
                       hover:border-accent hover:text-accent active:scale-95 transition-all tooltip"
            data-tip="Copy current position FEN"
          >
            Copy FEN
          </button>
          <button
            onClick={handleExportFenCollection}
            className="flex-1 py-1.5 border border-surface2 rounded text-xs text-muted font-sans
                       hover:border-accent hover:text-accent active:scale-95 transition-all tooltip"
            data-tip="Copy FEN collection from game"
          >
            FEN Collect
          </button>
          <button
            onClick={handleNewGame}
            className="flex-1 py-1.5 bg-accent text-bg rounded text-xs font-sans font-semibold
                       hover:opacity-90 active:scale-95 transition-all tooltip"
            data-tip="Start a new game"
          >
            New Game
          </button>
        </div>
      </div>

      {store.pendingPromotion && (
        <PromotionDialog
          color={store.turn}
          onSelect={handlePromotion}
          onCancel={() => store.setPendingPromotion(null)}
        />
      )}
      {store.gameResult && (
        <GameOverModal
          onRematch={handleNewGame}
          onAnalyze={() => onTabChange('analysis')}
          onMenu={handleNewGame}
        />
      )}
    </div>
  );
};
