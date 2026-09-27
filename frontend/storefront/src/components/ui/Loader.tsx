// servd's universal spinner (storefront): a 9-cell ripple grid. Pure CSS:
// keyframes + structure live in globals.css under `.servd-loader`; each cell's
// colour is fed via the --cell-color custom property, so the same wave themes
// to any brand. Mirrors the admin loader; default palette is servd plum.
//
// `size="sm"` is the inline variant for buttons and pills: an 18px ripple that
// sits on the text baseline and, unless `colors` is passed, takes the
// button's own text colour, so it reads on any fill.

import React from 'react'
import { PartyLoader } from '../party/loader/PartyLoader'

// servd obsidian-plum ramp (the storefront brand). simmer = single orange
// signal (their rules ban gradients); stackd = red plum into cream.
export const SERVD_CELLS = ['#2D1E2F', '#3D2540', '#4E2A4F', '#623A63', '#774B78', '#8C5E8E', '#A375A4', '#BE96BE', '#D9BFD9']
export const SIMMER_CELLS = Array<string>(9).fill('#E94E1B')
export const STACKD_CELLS = ['#5A1C32', '#6B223C', '#7C2946', '#8E3C57', '#A3566E', '#BA7688', '#D39BA4', '#EAC4BE', '#FCE8CE']

const DELAYS = [0, 100, 200, 100, 200, 200, 300, 300, 400]

type CSSVars = React.CSSProperties & Record<string, string | number>

// Inline variant geometry: 3 × (4px cell + 2 × 1px gap) = 18px square.
const SM_CELL = 4

export function Loader({
  size = 44,
  colors,
  className = '',
}: {
  /** Cell size in px, or 'sm' for the 18px inline button variant. */
  size?: number | 'sm'
  colors?: string[]
  className?: string
}) {
  if (size === 'sm') {
    const palette = colors ?? ['currentColor']
    return (
      <span
        className={`servd-loader ${className}`.trim()}
        style={{
          '--cell-size': `${SM_CELL}px`,
          display: 'inline-flex',
          flex: '0 0 auto',
          verticalAlign: 'middle',
        } as CSSVars}
        aria-hidden="true"
      >
        {Array.from({ length: 9 }).map((_, i) => (
          <span
            key={i}
            className="servd-loader-cell"
            style={{
              '--cell-color': palette[i % palette.length] ?? 'currentColor',
              animationDelay: `${DELAYS[i] ?? 0}ms`,
              borderRadius: '1.5px',
            } as CSSVars}
          />
        ))}
      </span>
    )
  }

  const palette = colors ?? SERVD_CELLS
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
          style={{ '--cell-color': palette[i % palette.length] ?? '#4E2A4F', animationDelay: `${DELAYS[i] ?? 0}ms` } as CSSVars}
        />
      ))}
    </div>
  )
}

// Inline page-level loading state. With no `colors`, it shows the compact
// servd food-crowd loader (the characters doing their wave), the hub look.
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
