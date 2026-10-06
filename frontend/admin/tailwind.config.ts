import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Tailwind's `white` is the area's foreground (globals.css --fg-rgb):
        // ink on bone, bone in the purple sidebar, white on kitchen screens.
        white: 'rgb(var(--fg-rgb) / <alpha-value>)',
        primary: { DEFAULT: '#87c540', hover: '#76b032', ink: '#4f7a1c', on: '#3d1f3b' },
        secondary: { DEFAULT: '#5a2156', on: '#f3e7cd' },
        bone: '#f3e7cd',
        // ─── 2030 Ops Design System ───────────────────────────────────────
        s: {
          bg:           '#f3e7cd',   // deepest surface
          // `bg-s-bg-soft` is used in 83 places (card headers, list-row hover)
          // but was never defined here, so Tailwind emitted no rule and all 83
          // rendered with no background — most visibly, list rows had no hover
          // feedback at all. Set one step up from the .s-card base (#13151A),
          // which is what "soft" meant: same value as `elevated`.
          'bg-soft':    '#ede0c2',   // card headers, row hover
          surface:      '#faf4e6',   // card base
          elevated:     '#ede0c2',   // raised panels
          overlay:      '#fffaf0',   // dropdowns, modals
          border:       '#e2d3b3',   // default border
          'border-strong': '#cdbb95',
          text:         '#3d1f3b',   // primary text
          muted:        '#7a6178',   // secondary text
          dim:          '#a8949f',   // disabled / placeholder
          teal:         '#87c540',   // primary action
          'teal-dim':   '#e3efcf',   // teal bg tint
          indigo:       '#5a2156',   // secondary accent
          'indigo-dim': '#e6dbe3',
          amber:        '#a15c00',
          'amber-dim':  '#f6e2bf',
          red:          '#b42318',
          'red-dim':    '#f5d6d0',
          blue:         '#1d4ed8',
          'blue-dim':   '#dbe6fb',
          green:        '#3f7d20',
          'green-dim':  '#dcebcf',
          purple:       '#6b2f68',
          'purple-dim': '#eadcea',
          pink:         '#be185d',
        },
        // ─── KDS Dark (kitchen screens — keep unchanged) ──────────────────
        kds: {
          bg:      '#1A1A1A',
          card:    '#242424',
          border:  '#333333',
          text:    '#FFFFFF',
          // F09: lifted from #999 to #C9C9C9 so secondary text passes WCAG AA
          // contrast on the #242424 ticket-card background (was 3.4:1, now 7:1).
          // A hot/warm ticket flashes the subtext further (see globals.css).
          subtext: '#C9C9C9',
          amber:   '#F59E0B',
          red:     '#EF4444',
          green:   '#22C55E',
          blue:    '#3B82F6',
        },
        // Source badge colors
        source: {
          servd:     '#5a2156',
          pos:       '#22C55E',
          cart:      '#F59E0B',
          manual:    '#8B5CF6',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      backgroundImage: {
        'gradient-brand':   'linear-gradient(135deg, #87c540 0%, #87c540 100%)',
        'gradient-surface': 'linear-gradient(180deg, #faf4e6 0%, #f3e7cd 100%)',
        'gradient-teal':    'linear-gradient(135deg, #87c540 0%, #76b032 100%)',
        'gradient-amber':   'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)',
      },
      boxShadow: {
        'glow-teal':   '0 0 20px rgba(135,197,64,0.18)',
        'glow-indigo': '0 0 20px rgba(61,31,59,0.12)',
        'card':        '0 1px 3px rgba(61,31,59,0.08), 0 0 0 1px rgba(61,31,59,0.06)',
        'card-hover':  '0 4px 16px rgba(61,31,59,0.12), 0 0 0 1px rgba(135,197,64,0.35)',
        'modal':       '0 24px 48px rgba(61,31,59,0.22), 0 0 0 1px rgba(61,31,59,0.08)',
      },
      animation: {
        'ticket-pulse': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-in':     'slideIn 0.2s ease-out',
        'fade-in':      'fadeIn 0.3s ease-out',
        'scale-in':     'scaleIn 0.15s ease-out',
        'shimmer':      'shimmer 2s linear infinite',
      },
      keyframes: {
        slideIn: {
          '0%':   { transform: 'translateY(-8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)',    opacity: '1' },
        },
        fadeIn: {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
        scaleIn: {
          '0%':   { transform: 'scale(0.96)', opacity: '0' },
          '100%': { transform: 'scale(1)',    opacity: '1' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
  darkMode: 'class',
}

export default config
