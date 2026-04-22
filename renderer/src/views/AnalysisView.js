"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnalysisView = void 0;
/**
 * AnalysisView.tsx — Board + live analysis panel.
 */
const react_1 = require("react");
const Board_1 = require("../components/Board");
const EvalBar_1 = require("../components/EvalBar");
const MoveHistory_1 = require("../components/MoveHistory");
const AnalysisPanel_1 = require("../components/AnalysisPanel");
const gameStore_1 = require("../stores/gameStore");
const settingsStore_1 = require("../stores/settingsStore");
const ANALYSIS_CB_ID = 'analysis-main';
const AnalysisView = () => {
    const store = (0, gameStore_1.useGameStore)();
    const settings = (0, settingsStore_1.useSettingsStore)();
    const runningRef = (0, react_1.useRef)(false);
    (0, react_1.useEffect)(() => {
        window.electronAPI.onAnalysisUpdate((raw) => {
            const data = raw;
            if (data.callback_id !== ANALYSIS_CB_ID)
                return;
            if (data.error) {
                store.pushToast(`Analysis error: ${data.error}`, 'error');
                store.setAnalysis({ running: false });
                return;
            }
            store.setAnalysis({ pvs: data.pvs ?? [], fen: data.fen ?? store.fen, running: true });
        });
        return () => { window.electronAPI.removeAnalysisListeners(); };
    }, []);
    const handleStartAnalysis = async () => {
        runningRef.current = true;
        store.setAnalysis({ running: true });
        try {
            await window.electronAPI.startAnalysis({ fen: store.fen, multipv: settings.multipv, callback_id: ANALYSIS_CB_ID });
        }
        catch (err) {
            store.pushToast(`Analysis failed: ${err}`, 'error');
            store.setAnalysis({ running: false });
        }
    };
    const handleStopAnalysis = async () => {
        runningRef.current = false;
        store.setAnalysis({ running: false });
        await window.electronAPI.stopAnalysis().catch(() => { });
    };
    const handleNavigate = async (index) => {
        try {
            const result = await window.electronAPI.navigateToMove({ index });
            store.applyMoveResult(result);
            if (runningRef.current)
                await handleStartAnalysis();
        }
        catch { /* ignore */ }
    };
    return (<div className="flex flex-col gap-2 w-full">
      <EvalBar_1.EvalBar />
      <Board_1.Board onSquareClick={() => { }}/>
      <MoveHistory_1.MoveHistory onMoveClick={handleNavigate}/>
      <AnalysisPanel_1.AnalysisPanel onStartAnalysis={handleStartAnalysis} onStopAnalysis={handleStopAnalysis}/>
    </div>);
};
exports.AnalysisView = AnalysisView;
