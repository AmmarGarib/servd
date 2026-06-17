// servd's universal spinner (storefront) — a 9-cell ripple grid. Pure CSS:
// keyframes + structure live in globals.css under `.servd-loader`; each cell's
// colour is fed via the --cell-color custom property, so the same wave themes
// to any brand. Mirrors the admin loader; default palette is servd royal purple.

import React from 'react'

// servd royal-purple gradient (the storefront brand). Simmer = single orange
// signal (their rules ban gradients); Stax = blueprint blue.
export const SERVD_CELLS = ['#3A0E69', '#481E7B', '#552D8D', '#633D9F', '#714DB1', '#7E5CC4', '#8C6CD6', '#997BE8', '#A78BFA']
export const SIMMER_CELLS = Array<string>(9).fill('#E94E1B')
export const STAX_CELLS = ['#0A1857', '#1B2E6C', '#2C4380', '#3D5995', '#4F6FAA', '#6084BF', '#719AD4', '#82AFE8', '#93C5FD']

const DELAYS = [0, 100, 200, 100, 200, 200, 300, 300, 400]

type CSSVars = React.CSSProperties & Record<string, string | number>

export function Loader({
  size = 44,
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
          style={{ '--cell-color': colors[i % colors.length] ?? '#3A0E69', animationDelay: `${DELAYS[i] ?? 0}ms` } as CSSVars}
        />
      ))}
    </div>
  )
}

export function LoadingScreen({
  label,
  size = 34,
  colors,
  minHeight = '60dvh',
}: {
  label?: string
  size?: number
  colors?: string[]
  minHeight?: string | number
}) {
  return (
    <div role="status" aria-label="Loading" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.1rem', minHeight, padding: '2rem' }}>
      <Loader size={size} colors={colors} />
      {label && <p style={{ color: 'var(--servd-mute, #6b6b6b)', fontSize: '0.8rem', letterSpacing: '0.04em', margin: 0 }}>{label}</p>}
      <span className="sr-only">{label ?? 'Loading…'}</span>
    </div>
  )
}

export default Loader
