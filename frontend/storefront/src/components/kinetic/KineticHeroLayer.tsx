'use client'
import type { CSSProperties, ReactNode } from 'react'
import { useScrollReveal } from './motionHooks'

/**
 * KineticHeroLayer — drop-in wrapper that:
 *   - sets --brand-accent / --brand-ink CSS vars on its root so any
 *     kinetic shape inside picks up the brand colour
 *   - wires .reveal-on-scroll children to fade-in on viewport entry
 *   - takes a `shapes` slot for the absolutely-positioned 3D motifs that
 *     should float behind the content
 *
 * Bespoke per-brand layouts wrap their hero in this so they don't have
 * to repeat the boilerplate (CSS vars, observer, overflow).
 */
export function KineticHeroLayer({
  accent,
  ink = '#0a0a0a',
  shapes,
  children,
  className = '',
  style,
}: {
  accent: string
  ink?:   string
  shapes?: ReactNode
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  const ref = useScrollReveal<HTMLDivElement>()
  return (
    <div
      ref={ref}
      className={`relative overflow-hidden ${className}`}
      style={{
        ['--brand-accent' as string]:      accent,
        ['--brand-accent-dark' as string]: accent,
        ['--brand-ink' as string]:         ink,
        ...style,
      }}
    >
      {shapes && <div className="absolute inset-0 pointer-events-none">{shapes}</div>}
      <div className="relative z-10">{children}</div>
    </div>
  )
}
