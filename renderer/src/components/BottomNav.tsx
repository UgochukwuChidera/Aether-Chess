/**
 * BottomNav.tsx — Fixed 64px bottom navigation bar with five tabs.
 */
import React from 'react';

export type Tab = 'play' | 'analysis' | 'extensions' | 'profile' | 'settings';

interface NavItem {
  id: Tab;
  icon: string;
  label: string;
}

const ITEMS: NavItem[] = [
  { id: 'play',       icon: 'sports_esports', label: 'Play'       },
  { id: 'analysis',   icon: 'analytics',      label: 'Analysis'   },
  { id: 'extensions', icon: 'extension',      label: 'Extensions' },
  { id: 'profile',    icon: 'person',         label: 'Profile'    },
  { id: 'settings',   icon: 'settings',       label: 'Settings'   },
];

interface Props {
  active: Tab;
  onChange: (tab: Tab) => void;
}

export const BottomNav: React.FC<Props> = ({ active, onChange }) => (
  <nav
    className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around
               bg-bg border-t border-surface2"
    style={{ height: 64 }}
  >
    {ITEMS.map((item) => {
      const isActive = item.id === active;
      return (
        <button
          key={item.id}
          onClick={() => onChange(item.id)}
          className={`relative flex flex-col items-center justify-center gap-0.5 flex-1 h-full
                      transition-colors ${isActive ? 'text-accent' : 'text-inactive hover:text-muted'}`}
          aria-label={item.label}
          aria-current={isActive ? 'page' : undefined}
        >
          {isActive && (
            <span
              className="absolute top-0 left-1/2 -translate-x-1/2 w-6 h-0.5 bg-accent rounded-b"
            />
          )}
          <span
            className={`material-symbols-outlined ${isActive ? 'filled' : ''}`}
            style={{ fontSize: 22 }}
          >
            {item.icon}
          </span>
          <span className="text-[10px] font-sans font-medium">{item.label}</span>
        </button>
      );
    })}
  </nav>
);
