// servd's universal spinner (storefront) — a 9-cell ripple grid. Pure CSS:
// keyframes + structure live in globals.css under `.servd-loader`; each cell's
// colour is fed via the --cell-color custom property, so the same wave themes
// to any brand. Mirrors the admin loader; default palette is servd purple → green.

import React from 'react'

// servd purple → green ramp (the storefront brand: purple #6a0dad, green
// #87c540 on bone). A brand passes its own `colors` (brand colours live in
// the brand kit, lib/brandKit.ts, not here).
export const SERVD_CELLS = ['#6a0dad', '#7c27b8', '#8f42c4', '#4f7a1c', '#6a9f2e', '#87c540', '#a3d46c', '#bfe298', '#d6eab5']

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
          style={{ '--cell-color': colors[i % colors.length] ?? '#87c540', animationDelay: `${DELAYS[i] ?? 0}ms` } as CSSVars}
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
