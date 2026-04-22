"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToastStack = void 0;
/**
 * Toast.tsx — Auto-dismissing notification messages.
 */
const react_1 = require("react");
const gameStore_1 = require("../stores/gameStore");
const TOAST_ICONS = {
    info: 'info',
    success: 'check_circle',
    error: 'error',
};
const TOAST_COLORS = {
    info: 'border-surface3 text-muted',
    success: 'border-accent text-accent',
    error: 'border-error text-error',
};
const ToastStack = () => {
    const { toasts, dismissToast } = (0, gameStore_1.useGameStore)();
    if (toasts.length === 0)
        return null;
    return (<div className="fixed bottom-20 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (<div key={t.id} className={`toast-enter flex items-center gap-2 px-3 py-2 rounded-lg
                      bg-surface border shadow-lg pointer-events-auto max-w-xs
                      ${TOAST_COLORS[t.type]}`} onClick={() => dismissToast(t.id)}>
          <span className="material-symbols-outlined filled" style={{ fontSize: 18 }}>
            {TOAST_ICONS[t.type]}
          </span>
          <span className="text-xs font-body text-on-surface flex-1">{t.message}</span>
        </div>))}
    </div>);
};
exports.ToastStack = ToastStack;
