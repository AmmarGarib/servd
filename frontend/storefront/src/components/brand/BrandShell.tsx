'use client'
import type { ReactNode } from 'react'
import type { Concept } from '../../lib/concept'
import { brandSurface } from '../../lib/concept'
import { isLight } from '../../lib/ui'

// The brand microsite shell: one themed wrapper around the brand's header,
// the page, and its footer. The header and footer are content-module pages
// (`brand:<slug>:header` / `brand:<slug>:footer`, sections `brand.header` /
// `brand.footer` in src/sections/brand), rendered on the server by the brand
// layout and passed in here.

interface Props {
  concept: Concept
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
}

export function BrandShell({ concept, header, footer, children }: Props) {
  // Per-brand accent gets pushed onto a single wrapper so EVERY child
  // component (kinetic shapes, pills, headlines) inherits the brand's
  // colour via --brand-accent. Default to servd-green if a concept
  // doesn't define one.
  const accent = concept.primaryColor || 'var(--servd-green)'
  // Pick the text/ink colour based on luminance of the accent. Light
  // accents get black ink, dark accents (flipd blue, stackd plum, simmer
  // green, servd royal blue) get white. Defaults to white when
  // we can't parse the accent (e.g. it's a CSS var name).
  const accentInk = !concept.primaryColor ? 'var(--servd-on-green)'   // servd default green → purple ink
    : accent.startsWith('#') && isLight(accent) ? '#0a0a0a' : 'white'
  const surface = brandSurface(concept.slug)
  const wrapperStyle = {
    background: surface.bg,
    minHeight: '100vh',
    ['--brand-accent' as string]:      accent,
    ['--brand-accent-dark' as string]: accent,
    ['--brand-ink' as string]:         accentInk,
  } as React.CSSProperties

  return (
    <div style={wrapperStyle}>
      {header}
      {children}
      {footer}
    </div>
  )
}
