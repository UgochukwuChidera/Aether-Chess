/**
 * Toast.tsx — Auto-dismissing notification messages.
 */
import React from 'react';
import { useGameStore, type Toast } from '../stores/gameStore';

const TOAST_ICONS: Record<Toast['type'], string> = {
  info:    'info',
  success: 'check_circle',
  error:   'error',
};

const TOAST_COLORS: Record<Toast['type'], string> = {
  info:    'border-surface3 text-muted',
  success: 'border-accent text-accent',
  error:   'border-error text-error',
};

export const ToastStack: React.FC = () => {
  const { toasts, dismissToast } = useGameStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-20 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast-enter flex items-center gap-2 px-3 py-2 rounded-lg
                      bg-surface border shadow-lg pointer-events-auto max-w-xs
                      ${TOAST_COLORS[t.type]}`}
          onClick={() => dismissToast(t.id)}
        >
          <span className="material-symbols-outlined filled" style={{ fontSize: 18 }}>
            {TOAST_ICONS[t.type]}
          </span>
          <span className="text-xs font-body text-on-surface flex-1">{t.message}</span>
        </div>
      ))}
    </div>
  );
};
