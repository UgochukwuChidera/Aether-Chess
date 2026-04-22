/** @type {import('tailwindcss').Config} */
export default {
  content: ['./renderer/index.html', './renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Primary accent
        accent: '#A3E635',
        'accent-dim': '#334d00',
        // Backgrounds
        bg:      '#0A0A0A',
        surface: '#1A1A1A',
        surface2:'#262626',
        surface3:'#3A3A3A',
        // Text
        'on-surface':  '#E5E2E1',
        muted:         '#C2CAB0',
        outline:       '#8C947C',
        // Error
        error:         '#FFB4AB',
        'error-container': '#93000A',
        // Icons inactive
        inactive: '#404040',
      },
      fontFamily: {
        sans:  ['"Space Grotesk"', 'sans-serif'],
        body:  ['"Inter"', 'sans-serif'],
        mono:  ['"Inter"', 'monospace'],
      },
      spacing: {
        'gutter': '12px',
        'margin-app': '24px',
      },
      borderRadius: {
        card: '12px',
      },
      transitionTimingFunction: {
        'bounce-out': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [],
};
