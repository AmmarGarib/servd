'use client'
import * as React from 'react'
import { useEffect, useState, useCallback } from 'react'
import Link, { type LinkProps } from 'next/link'

// "Magnetize" hover effect, colour-preserving. Two drop-ins:
//   <MagneticButton …>  for <button> CTAs
//   <MagneticLink href=…> for Next <Link> CTAs
// All props pass straight through, so each call site's existing palette/styles
// are untouched — we only add a particle layer. Particles use `currentColor`,
// so they tint to whatever text colour the element already has.
//
// Notes:
//  - The element keeps overflow visible (box-shadows intact); the particle
//    layer clips itself (overflow hidden + borderRadius inherit).
//  - Particles are invisible at rest and only fly in on hover/touch, so a page
//    full of these stays calm until you interact.
//  - Plain CSS transitions, no animation library (framer-motion was ~38 KB gz
//    of shared JS for this one effect). The curves stand in for the springs it
//    used: attract was stiffness 50 / damping 10 (about 0.8 s, a small
//    overshoot), release stiffness 100 / damping 15 (quicker, barely any).
//  - Under prefers-reduced-motion the particles are not drawn at all.

interface Particle { id: number; x: number; y: number }

const ATTRACT = 'transform 800ms cubic-bezier(0.34, 1.32, 0.64, 1), opacity 500ms ease-out'
const RELEASE = 'transform 550ms cubic-bezier(0.3, 1.18, 0.6, 1), opacity 350ms ease-out'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function useMagnet(particleCount: number, disabled?: boolean) {
  const [particles, setParticles] = useState<Particle[]>([])
  const [attracted, setAttracted] = useState(false)

  useEffect(() => {
    // Client-only (random positions), so the server renders no particles and
    // hydration has nothing to disagree about.
    if (prefersReducedMotion()) { setParticles([]); return }
    setParticles(
      Array.from({ length: particleCount }, (_, i) => ({
        id: i,
        x: Math.random() * 140 - 70,
        y: Math.random() * 90 - 45,
      })),
    )
  }, [particleCount])

  const attract = useCallback(() => {
    if (disabled) return
    setAttracted(true)
  }, [disabled])

  const release = useCallback(() => {
    setAttracted(false)
  }, [])

  return { particles, attracted, attract, release }
}

function ParticleLayer({ particles, attracted }: { particles: Particle[]; attracted: boolean }) {
  if (particles.length === 0) return null
  return (
    <span aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 'inherit', pointerEvents: 'none' }}>
      <span style={{ position: 'absolute', top: '50%', left: '50%' }}>
        {particles.map((p) => (
          <span
            key={p.id}
            style={{
              position: 'absolute', top: 0, left: 0, width: 5, height: 5, borderRadius: 9999, background: 'currentColor',
              transform: attracted ? 'translate(0px, 0px)' : `translate(${p.x}px, ${p.y}px)`,
              opacity: attracted ? 0.85 : 0,
              transition: attracted ? ATTRACT : RELEASE,
            }}
          />
        ))}
      </span>
    </span>
  )
}

function Content({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', width: '100%', height: '100%' }}>
      {children}
    </span>
  )
}

interface MagneticButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  particleCount?: number
}

export function MagneticButton({
  particleCount = 10,
  className,
  children,
  style,
  disabled,
  onMouseEnter,
  onMouseLeave,
  onTouchStart,
  onTouchEnd,
  ...props
}: MagneticButtonProps) {
  const { particles, attracted, attract, release } = useMagnet(particleCount, disabled)
  return (
    <button
      className={className}
      disabled={disabled}
      style={{ position: 'relative', ...style }}
      onMouseEnter={(e) => { attract(); onMouseEnter?.(e) }}
      onMouseLeave={(e) => { release(); onMouseLeave?.(e) }}
      onTouchStart={(e) => { attract(); onTouchStart?.(e) }}
      onTouchEnd={(e) => { release(); onTouchEnd?.(e) }}
      {...props}
    >
      <ParticleLayer particles={particles} attracted={attracted} />
      <Content>{children}</Content>
    </button>
  )
}

type MagneticLinkProps = LinkProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps> & {
    particleCount?: number
    className?: string
    style?: React.CSSProperties
    children?: React.ReactNode
  }

export function MagneticLink({
  particleCount = 10,
  className,
  children,
  style,
  onMouseEnter,
  onMouseLeave,
  onTouchStart,
  onTouchEnd,
  ...props
}: MagneticLinkProps) {
  const { particles, attracted, attract, release } = useMagnet(particleCount, false)
  return (
    <Link
      className={className}
      style={{ position: 'relative', ...style }}
      onMouseEnter={(e) => { attract(); onMouseEnter?.(e) }}
      onMouseLeave={(e) => { release(); onMouseLeave?.(e) }}
      onTouchStart={(e) => { attract(); onTouchStart?.(e) }}
      onTouchEnd={(e) => { release(); onTouchEnd?.(e) }}
      {...props}
    >
      <ParticleLayer particles={particles} attracted={attracted} />
      <Content>{children}</Content>
    </Link>
  )
}

export default MagneticButton
