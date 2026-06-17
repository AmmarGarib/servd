// servd's universal spinner — a 9-cell ripple grid. Cells fade in/out in a
// diagonal wave. Pure CSS: the keyframes + structure live in globals.css under
// `.servd-loader`; each cell's colour is fed in via the --cell-color custom
// property, so the same animation themes to any brand palette. No
// styled-components / external deps.
//
// Usage:
//   <Loader />                          default servd teal→indigo, 52px cells
//   <Loader size={18} />                inline / button-sized
//   <Loader colors={SIMMER_CELLS} />    brand-themed
//   <LoadingScreen label="Loading…" />  centred full-area loading state

import React from 'react'

// 9-cell brand palettes. SERVD is the house gradient used everywhere by default.
export const SERVD_CELLS = ['#00D4B1', '#0CC6B9', '#19B9C1', '#25ABC9', '#329DD1', '#3E8FD9', '#4A82E1', '#5774E9', '#6366F1']
// Simmer's brand rules ban gradients → a single orange signal that ripples by
// timing alone (still reads as a wave, stays brand-compliant).
export const SIMMER_CELLS = Array<string>(9).fill('#E94E1B')
// Stax — blueprint blue, deep → bright.
export const STAX_CELLS = ['#0A1857', '#1B2E6C', '#2C4380', '#3D5995', '#4F6FAA', '#6084BF', '#719AD4', '#82AFE8', '#93C5FD']

// Diagonal wave delays (ms) — matches the original loader-4 ripple ordering.
const DELAYS = [0, 100, 200, 100, 200, 200, 300, 300, 400]

type CSSVars = React.CSSProperties & Record<string, string | number>

export function Loader({
  size = 52,
  colors = SERVD_CELLS,
  className = '',
}: {
  size?: number
  colors?: string[]
  className?: string
}) {
  return (
    <div
      className={`servd-loader ${className}`.trim()}
      style={{ '--cell-size': `${size}px` } as CSSVars}
      role="status"
      aria-label="Loading"
    >
      {Array.from({ length: 9 }).map((_, i) => (
        <span
          key={i}
          className="servd-loader-cell"
          aria-hidden
          style={{ '--cell-color': colors[i % colors.length] ?? '#00D4B1', animationDelay: `${DELAYS[i] ?? 0}ms` } as CSSVars}
        />
      ))}
    </div>
  )
}

// Centred loading state with an optional label — drop into any route, panel, or
// modal body waiting on data.
export function LoadingScreen({
  label,
  size = 34,
  colors,
  minHeight = '60vh',
}: {
  label?: string
  size?: number
  colors?: string[]
  minHeight?: string | number
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.1rem', minHeight }}>
      <Loader size={size} colors={colors} />
      {label && <p style={{ color: '#6E7186', fontSize: '0.8rem', letterSpacing: '0.04em', margin: 0 }}>{label}</p>}
    </div>
  )
}

export default Loader
