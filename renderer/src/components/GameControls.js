"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GameControls = void 0;
/**
 * GameControls.tsx — Row of four action buttons: Flip, Undo, Draw, Resign.
 */
const react_1 = require("react");
const gameStore_1 = require("../stores/gameStore");
const GameControls = ({ onFlip, onUndo, onDraw, onResign }) => {
    const { engineBusy, gameResult } = (0, gameStore_1.useGameStore)();
    const [confirm, setConfirm] = (0, react_1.useState)({ type: null });
    const gameOver = gameResult !== null;
    const buttons = [
        { icon: 'flip', label: 'Flip', action: onFlip, disabled: false },
        { icon: 'undo', label: 'Undo', action: onUndo, disabled: engineBusy || gameOver },
        { icon: 'handshake', label: 'Draw', action: () => setConfirm({ type: 'draw' }), disabled: gameOver },
        { icon: 'flag', label: 'Resign', action: () => setConfirm({ type: 'resign' }), disabled: gameOver },
    ];
    const handleConfirm = () => {
        if (confirm.type === 'draw')
            onDraw();
        if (confirm.type === 'resign')
            onResign();
        setConfirm({ type: null });
    };
    return (<>
      <div className="flex gap-2 w-full">
        {buttons.map(({ icon, label, action, disabled }) => (<button key={label} onClick={action} disabled={disabled} className="flex-1 flex flex-col items-center justify-center gap-0.5 py-1.5
                       border border-surface2 rounded-lg text-muted bg-surface
                       hover:border-accent hover:text-accent active:scale-95
                       disabled:opacity-30 disabled:cursor-not-allowed transition-all text-xs font-sans">
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{icon}</span>
            {label}
          </button>))}
      </div>

      {/* Confirmation mini-modal */}
      {confirm.type && (<div className="fixed inset-0 z-50 modal-backdrop flex items-center justify-center p-6">
          <div className="bg-surface border border-surface2 rounded-card p-5 w-72 shadow-2xl">
            <p className="text-on-surface font-sans font-semibold text-base mb-4">
              {confirm.type === 'draw' ? 'Offer a draw?' : 'Resign the game?'}
            </p>
            <div className="flex gap-3">
              <button onClick={handleConfirm} className="flex-1 py-2 bg-accent text-bg rounded-lg font-sans font-semibold text-sm
                           hover:opacity-90 active:scale-95 transition-all">
                {confirm.type === 'draw' ? 'Offer' : 'Resign'}
              </button>
              <button onClick={() => setConfirm({ type: null })} className="flex-1 py-2 border border-surface2 text-muted rounded-lg font-sans text-sm
                           hover:border-accent hover:text-accent active:scale-95 transition-all">
                Cancel
              </button>
            </div>
          </div>
        </div>)}
    </>);
};
exports.GameControls = GameControls;
