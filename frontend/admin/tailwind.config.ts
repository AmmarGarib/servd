import type { Config } from 'tailwindcss'

// A colour from a globals.css channel variable (`R G B`), opacity-aware.
const ch = (v: string) => `rgb(var(${v}) / <alpha-value>)`

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Every theme colour is a channel variable from globals.css (the ONE
        // definition of the ERP palette), so opacity modifiers work and an
        // area that redefines a colour (the purple sidebar, the dark kitchen
        // screens) restyles these utilities too.
        // Tailwind's `white` is the area's foreground (globals.css --fg-rgb):
        // ink on white, white in the purple sidebar and on kitchen screens.
        white: ch('--fg-rgb'),
        primary: { DEFAULT: ch('--erp-primary-rgb'), hover: ch('--erp-primary-hover-rgb'), ink: ch('--erp-primary-ink-rgb'), on: ch('--erp-on-primary-rgb') },
        secondary: { DEFAULT: ch('--erp-secondary-rgb'), on: ch('--erp-on-secondary-rgb') },
        // The servd green from the logo — accents (dots, bars, the sidebar's
        // active item); `text-success` is the readable green on white.
        accent: { DEFAULT: ch('--erp-accent-rgb'), on: ch('--erp-on-accent-rgb'), dim: ch('--erp-accent-dim-rgb') },
        success: ch('--erp-success-rgb'),
        // Light text on a coloured fill (red/amber/purple buttons).
        bone: '#ffffff',
        // ─── 2030 Ops Design System ───────────────────────────────────────
        s: {
          bg:           ch('--bg-rgb'),            // page
          // `bg-s-bg-soft` (card headers, list-row hover) — same as `elevated`.
          'bg-soft':    ch('--elevated-rgb'),
          surface:      ch('--surface-rgb'),       // card base
          elevated:     ch('--elevated-rgb'),      // raised panels
          overlay:      ch('--overlay-rgb'),       // dropdowns, modals
          border:       ch('--border-rgb'),        // default border
          'border-strong': ch('--border-strong-rgb'),
          text:         ch('--text-rgb'),          // primary text
          muted:        ch('--muted-rgb'),         // secondary text
          dim:          ch('--dim-rgb'),           // disabled / placeholder
          // Legacy "teal" = the accent: the servd green (on / done / live /
          // good), never a button. Buttons are `primary` (purple).
          teal:         ch('--erp-accent-rgb'),
          'teal-dim':   ch('--erp-accent-dim-rgb'),
          indigo:       ch('--erp-secondary-rgb'), // secondary accent (legacy name)
          'indigo-dim': ch('--erp-secondary-dim-rgb'),
          amber:        '#a15c00',
          'amber-dim':  '#f6e2bf',
          red:          '#b42318',
          'red-dim':    '#f5d6d0',
          blue:         '#1d4ed8',
          'blue-dim':   '#dbe6fb',
          green:        '#3f7d20',
          'green-dim':  '#dcebcf',
          purple:       '#7b2cbf',
          'purple-dim': '#efe4fa',
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
          servd:     '#6a0dad',
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
        'gradient-brand':   'linear-gradient(135deg, var(--erp-primary) 0%, var(--erp-primary) 100%)',
        'gradient-surface': 'linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%)',
        'gradient-teal':    'linear-gradient(135deg, var(--erp-primary) 0%, var(--erp-primary-hover) 100%)',
        'gradient-amber':   'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)',
      },
      boxShadow: {
        'glow-teal':   '0 0 20px rgb(var(--erp-primary-rgb) / 0.18)',
        'glow-indigo': '0 0 20px rgb(var(--ink-rgb) / 0.12)',
        'card':        '0 1px 3px rgb(var(--ink-rgb) / 0.08), 0 0 0 1px rgb(var(--ink-rgb) / 0.06)',
        'card-hover':  '0 4px 16px rgb(var(--ink-rgb) / 0.12), 0 0 0 1px rgb(var(--erp-primary-rgb) / 0.35)',
        'modal':       '0 24px 48px rgb(var(--ink-rgb) / 0.22), 0 0 0 1px rgb(var(--ink-rgb) / 0.08)',
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
