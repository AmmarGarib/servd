// servd's universal spinner (storefront) — a 9-cell ripple grid. Pure CSS:
// keyframes + structure live in globals.css under `.servd-loader`; each cell's
// colour is fed via the --cell-color custom property, so the same wave themes
// to any brand. Mirrors the admin loader; default palette is servd royal purple.

import React from 'react'
import { PartyLoader } from '../party/loader/PartyLoader'

// servd obsidian-plum ramp (the storefront brand). Simmer = single orange
// signal (their rules ban gradients); stackd = red plum → cream → one sky cell.
export const SERVD_CELLS = ['#2D1E2F', '#3D2540', '#4E2A4F', '#623A63', '#774B78', '#8C5E8E', '#A375A4', '#BE96BE', '#D9BFD9']
export const SIMMER_CELLS = Array<string>(9).fill('#E94E1B')
export const STACKD_CELLS = ['#3D1122', '#5A1C33', '#7C2946', '#94405C', '#AE5D76', '#C98C98', '#E4B9B4', '#FCE8CE', '#9BD3DD']

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
          style={{ '--cell-color': colors[i % colors.length] ?? '#4E2A4F', animationDelay: `${DELAYS[i] ?? 0}ms` } as CSSVars}
        />
      ))}
    </div>
  )
}

// Inline page-level loading state. With no `colors`, it shows the compact
// servd food-crowd loader (the characters doing their wave) — the hub look.
// Passing `colors` keeps the themed ripple for brand-coloured surfaces.
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
  if (!colors) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight }}>
        <PartyLoader variant="inline" label={label} />
      </div>
    )
  }
  return (
    <div role="status" aria-label="Loading" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.1rem', minHeight, padding: '2rem' }}>
      <Loader size={size} colors={colors} />
      {label && <p style={{ color: 'var(--servd-mute, #6b6b6b)', fontSize: '0.8rem', letterSpacing: '0.04em', margin: 0 }}>{label}</p>}
      <span className="sr-only">{label ?? 'Loading…'}</span>
    </div>
  )
}

export default Loader
