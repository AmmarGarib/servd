import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // ─── 2030 Ops Design System ───────────────────────────────────────
        s: {
          bg:           '#0C0D10',   // deepest surface
          surface:      '#13151A',   // card base
          elevated:     '#1A1D24',   // raised panels
          overlay:      '#20242E',   // dropdowns, modals
          border:       '#222530',   // default border
          'border-strong': '#2E3340',
          text:         '#E8EAF0',   // primary text
          muted:        '#6B7280',   // secondary text
          dim:          '#3D4452',   // disabled / placeholder
          teal:         '#00D4B1',   // primary action
          'teal-dim':   '#004D42',   // teal bg tint
          indigo:       '#6366F1',   // secondary accent
          'indigo-dim': '#1E1F4E',
          amber:        '#F59E0B',
          'amber-dim':  '#3D2800',
          red:          '#FF4D4F',
          'red-dim':    '#3D0D0D',
          blue:         '#4F8EF7',
          'blue-dim':   '#0D1F3D',
          green:        '#22C55E',
          'green-dim':  '#0A2E18',
          purple:       '#A855F7',
          'purple-dim': '#220D3D',
          pink:         '#EC4899',
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
          servd:     '#6366F1',
          foodpanda: '#EC4899',
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
        'gradient-brand':   'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)',
        'gradient-surface': 'linear-gradient(180deg, #1A1D24 0%, #13151A 100%)',
        'gradient-teal':    'linear-gradient(135deg, #00D4B1 0%, #00897B 100%)',
        'gradient-amber':   'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)',
      },
      boxShadow: {
        'glow-teal':   '0 0 20px rgba(0,212,177,0.15)',
        'glow-indigo': '0 0 20px rgba(99,102,241,0.15)',
        'card':        '0 1px 3px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04)',
        'card-hover':  '0 4px 16px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,212,177,0.2)',
        'modal':       '0 24px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
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
