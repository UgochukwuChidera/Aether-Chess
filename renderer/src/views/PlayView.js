"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlayView = void 0;
/**
 * PlayView.tsx — Main game play tab.
 */
const react_1 = require("react");
const Board_1 = require("../components/Board");
const EvalBar_1 = require("../components/EvalBar");
const PlayerCard_1 = require("../components/PlayerCard");
const MoveHistory_1 = require("../components/MoveHistory");
const GameControls_1 = require("../components/GameControls");
const GameOverModal_1 = require("../components/GameOverModal");
const PromotionDialog_1 = require("../components/PromotionDialog");
const gameStore_1 = require("../stores/gameStore");
const settingsStore_1 = require("../stores/settingsStore");
function isPawnPromotion(fen, from, to) {
    const rows = fen.split(' ')[0].split('/');
    const fromFile = from.charCodeAt(0) - 97;
    const fromRank = parseInt(from[1]) - 1;
    const fenRankIdx = 7 - fromRank;
    let file = 0;
    let piece = null;
    for (const ch of rows[fenRankIdx]) {
        if (/\d/.test(ch)) {
            file += parseInt(ch);
        }
        else {
            if (file === fromFile) {
                piece = ch;
                break;
            }
            file++;
        }
    }
    const toRank = parseInt(to[1]);
    return (piece === 'P' && toRank === 8) || (piece === 'p' && toRank === 1);
}
const PlayView = ({ onTabChange }) => {
    const store = (0, gameStore_1.useGameStore)();
    const settings = (0, settingsStore_1.useSettingsStore)();
    const [whiteTime, setWhiteTime] = (0, react_1.useState)(null);
    const [blackTime, setBlackTime] = (0, react_1.useState)(null);
    const timerRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => {
        handleNewGame();
    }, []);
    (0, react_1.useEffect)(() => {
        if (!store.gameResult)
            return;
        if (timerRef.current)
            clearInterval(timerRef.current);
    }, [store.gameResult]);
    (0, react_1.useEffect)(() => {
        const tc = settings.timeControl;
        if (tc.seconds === 0 || !whiteTime)
            return;
        if (timerRef.current)
            clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
            if (store.gameResult) {
                clearInterval(timerRef.current);
                return;
            }
            if (store.turn === 'white')
                setWhiteTime((t) => t !== null ? Math.max(0, t - 1) : null);
            else
                setBlackTime((t) => t !== null ? Math.max(0, t - 1) : null);
        }, 1000);
        return () => { if (timerRef.current)
            clearInterval(timerRef.current); };
    }, [store.turn, store.gameResult]);
    const handleNewGame = async () => {
        try {
            const result = await window.electronAPI.newGame({
                mode: store.mode,
                engine_type: 'mentor',
                human_color: store.humanColor,
                strength: settings.botStrength,
            });
            store.applyMoveResult(result);
            store.resetGame();
            store.applyMoveResult(result);
            if (settings.timeControl.seconds > 0) {
                setWhiteTime(settings.timeControl.seconds);
                setBlackTime(settings.timeControl.seconds);
            }
        }
        catch (err) {
            store.pushToast(`Failed to start game: ${err}`, 'error');
        }
    };
    const commitMove = async (moveUCI) => {
        store.selectSquare(null);
        store.setEngineBusy(true);
        try {
            const result = await window.electronAPI.makeMove({ move: moveUCI });
            store.applyMoveResult(result);
            if (!result.game_over && store.mode === 'human_vs_ai') {
                const reply = await window.electronAPI.getBotMove({
                    fen: result.fen,
                    strength: settings.botStrength,
                });
                if (reply.move) {
                    const engineResult = await window.electronAPI.makeMove({ move: reply.move });
                    store.applyMoveResult(engineResult);
                }
            }
        }
        catch (err) {
            store.pushToast(`Move error: ${err}`, 'error');
        }
        finally {
            store.setEngineBusy(false);
        }
    };
    const handleSquareClick = async (sq) => {
        if (store.gameResult || store.engineBusy)
            return;
        const { selectedSquare, legalMoves, fen } = store;
        if (!selectedSquare) {
            store.selectSquare(sq);
            return;
        }
        if (sq === selectedSquare) {
            store.selectSquare(null);
            return;
        }
        const moveUCI = legalMoves.find((m) => m.startsWith(selectedSquare) && m.slice(2, 4) === sq);
        if (!moveUCI) {
            store.selectSquare(sq);
            return;
        }
        if (!settings.autoQueen && isPawnPromotion(fen, selectedSquare, sq)) {
            store.setPendingPromotion({ from: selectedSquare, to: sq });
            return;
        }
        await commitMove(selectedSquare + sq);
    };
    const handlePromotion = async (piece) => {
        const { pendingPromotion } = store;
        if (!pendingPromotion)
            return;
        store.setPendingPromotion(null);
        await commitMove(`${pendingPromotion.from}${pendingPromotion.to}${piece}`);
    };
    const handleUndo = async () => {
        try {
            const result = await window.electronAPI.undoMove();
            store.applyMoveResult(result);
        }
        catch (err) {
            store.pushToast(`Undo failed: ${err}`, 'error');
        }
    };
    const handleNavigate = async (index) => {
        try {
            const result = await window.electronAPI.navigateToMove({ index });
            store.applyMoveResult(result);
        }
        catch { /* ignore */ }
    };
    const handleResign = () => {
        store.pushToast('You resigned.', 'info');
        gameStore_1.useGameStore.setState({ gameResult: store.humanColor === 'white' ? 'black_wins' : 'white_wins', termination: 'RESIGN' });
    };
    const handleDraw = () => store.pushToast('Draw offered (not accepted by engine)', 'info');
    const handleExportPgn = async () => {
        try {
            const res = await window.electronAPI.exportPgn();
            await navigator.clipboard.writeText(res.pgn);
            store.pushToast('PGN copied to clipboard', 'success');
        }
        catch (err) {
            store.pushToast(`Export failed: ${err}`, 'error');
        }
    };
    const opponentIsBlack = store.humanColor === 'white';
    const opponentTurn = store.turn !== store.humanColor;
    return (<div className="flex flex-col gap-2 w-full">
      <PlayerCard_1.PlayerCard name="Aether Bot" elo={1800} online={true} isUser={false} timeSeconds={opponentIsBlack ? blackTime : whiteTime} isActive={opponentTurn}/>
      <EvalBar_1.EvalBar />
      <Board_1.Board onSquareClick={handleSquareClick}/>
      <PlayerCard_1.PlayerCard name="You" online={true} isUser={true} timeSeconds={opponentIsBlack ? whiteTime : blackTime} isActive={!opponentTurn}/>
      <GameControls_1.GameControls onFlip={store.flipBoard} onUndo={handleUndo} onDraw={handleDraw} onResign={handleResign}/>
      <MoveHistory_1.MoveHistory onMoveClick={handleNavigate}/>
      <div className="flex gap-2">
        <button onClick={handleExportPgn} className="flex-1 py-1.5 border border-surface2 rounded text-xs text-muted font-sans
                     hover:border-accent hover:text-accent active:scale-95 transition-all">
          Copy PGN
        </button>
        <button onClick={handleNewGame} className="flex-1 py-1.5 bg-accent text-bg rounded text-xs font-sans font-semibold
                     hover:opacity-90 active:scale-95 transition-all">
          New Game
        </button>
      </div>
      {store.pendingPromotion && (<PromotionDialog_1.PromotionDialog color={store.turn} onSelect={handlePromotion} onCancel={() => store.setPendingPromotion(null)}/>)}
      {store.gameResult && (<GameOverModal_1.GameOverModal onRematch={handleNewGame} onAnalyze={() => onTabChange('analysis')} onMenu={handleNewGame}/>)}
    </div>);
};
exports.PlayView = PlayView;
