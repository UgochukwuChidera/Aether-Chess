"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlayerCard = void 0;
/**
 * PlayerCard.tsx — Player profile strip with avatar, name, Elo, and timer.
 */
const react_1 = require("react");
function formatTime(seconds) {
    if (seconds == null || seconds < 0)
        return '--:--';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
const PlayerCard = ({ name, elo, flag, online = false, isUser = false, timeSeconds, isActive = false, }) => {
    return (<div className={`flex items-center gap-3 px-3 py-2 rounded-card
                  ${isUser ? 'bg-surface' : 'bg-surface'}`}>
      {/* Avatar + status dot */}
      <div className="relative flex-shrink-0">
        <div className="w-9 h-9 rounded-full bg-surface2 flex items-center justify-center
                     border border-surface3 overflow-hidden">
          <span className="material-symbols-outlined text-muted" style={{ fontSize: 22 }}>
            person
          </span>
        </div>
        <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-bg
                      ${online ? 'bg-accent' : 'bg-error'}`}/>
      </div>

      {/* Name + Elo */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          {flag && <span className="text-sm">{flag}</span>}
          <span className="text-sm font-sans font-medium text-on-surface truncate">{name}</span>
        </div>
        {elo != null && (<span className="text-xs font-body text-muted">{elo}</span>)}
      </div>

      {/* Timer */}
      {timeSeconds !== undefined && (<div className={`px-2 py-1 rounded font-mono text-base font-semibold tabular-nums
                      transition-all
                      ${isActive && isUser
                ? 'bg-accent text-bg glow-accent-sm'
                : 'bg-surface2 text-on-surface'}`} style={{ minWidth: 64, textAlign: 'right' }}>
          {formatTime(timeSeconds)}
        </div>)}
    </div>);
};
exports.PlayerCard = PlayerCard;
