'use client'
import * as React from 'react'
import { useEffect, useState, useCallback } from 'react'
import { motion, useAnimation, type AnimationControls } from 'framer-motion'
import Link, { type LinkProps } from 'next/link'
import { usePrefersReducedMotion } from '../../lib/play/motion'

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
//  - Particles are invisible at rest and only fly in on hover/touch/focus, so a
//    page full of these stays calm until you interact.
//  - attract/release are fire-and-forget: the latest controls.start() simply
//    interrupts the one before it, so fast hover in/out never queues up.
//  - Reduced motion: no particle springs. A static currentColor wash shows the
//    active state instead.

interface Particle { id: number; x: number; y: number }

// Keyboard focus only: a tap also focuses the element, and the particles must
// not stay gathered after a touch ends.
function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return true
  }
}

function useMagnet(particleCount: number, disabled?: boolean) {
  const [particles, setParticles] = useState<Particle[]>([])
  const [active, setActive] = useState(false)
  const reduced = usePrefersReducedMotion()
  const controls = useAnimation()

  useEffect(() => {
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
    setActive(true)
    if (reduced) return
    void controls.start({ x: 0, y: 0, opacity: 0.85, transition: { type: 'spring', stiffness: 50, damping: 10 } })
  }, [controls, disabled, reduced])

  const release = useCallback(() => {
    setActive(false)
    if (reduced) return
    void controls.start((i: number) => ({
      x: particles[i]?.x ?? 0,
      y: particles[i]?.y ?? 0,
      opacity: 0,
      transition: { type: 'spring', stiffness: 100, damping: 15 },
    }))
  }, [controls, particles, reduced])

  return { particles, controls, attract, release, active, reduced }
}

function ParticleLayer({
  particles,
  controls,
  active,
  reduced,
}: {
  particles: Particle[]
  controls: AnimationControls
  active: boolean
  reduced: boolean
}) {
  return (
    <span aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 'inherit', pointerEvents: 'none' }}>
      {reduced ? (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            background: 'currentColor',
            opacity: active ? 0.12 : 0,
          }}
        />
      ) : null}
      <span style={{ position: 'absolute', top: '50%', left: '50%', display: reduced ? 'none' : undefined }}>
        {particles.map((p, i) => (
          <motion.span
            key={p.id}
            custom={i}
            initial={{ x: p.x, y: p.y, opacity: 0 }}
            animate={controls}
            style={{ position: 'absolute', width: 5, height: 5, borderRadius: 9999, background: 'currentColor' }}
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
  onFocus,
  onBlur,
  ...props
}: MagneticButtonProps) {
  const { particles, controls, attract, release, active, reduced } = useMagnet(particleCount, disabled)
  return (
    <button
      className={className}
      disabled={disabled}
      style={{ position: 'relative', ...style }}
      onMouseEnter={(e) => { attract(); onMouseEnter?.(e) }}
      onMouseLeave={(e) => { release(); onMouseLeave?.(e) }}
      onTouchStart={(e) => { attract(); onTouchStart?.(e) }}
      onTouchEnd={(e) => { release(); onTouchEnd?.(e) }}
      onFocus={(e) => { if (focusVisible(e.currentTarget)) attract(); onFocus?.(e) }}
      onBlur={(e) => { release(); onBlur?.(e) }}
      {...props}
    >
      <ParticleLayer particles={particles} controls={controls} active={active} reduced={reduced} />
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
  onFocus,
  onBlur,
  ...props
}: MagneticLinkProps) {
  const { particles, controls, attract, release, active, reduced } = useMagnet(particleCount, false)
  return (
    <Link
      className={className}
      style={{ position: 'relative', ...style }}
      onMouseEnter={(e) => { attract(); onMouseEnter?.(e) }}
      onMouseLeave={(e) => { release(); onMouseLeave?.(e) }}
      onTouchStart={(e) => { attract(); onTouchStart?.(e) }}
      onTouchEnd={(e) => { release(); onTouchEnd?.(e) }}
      onFocus={(e) => { if (focusVisible(e.currentTarget)) attract(); onFocus?.(e) }}
      onBlur={(e) => { release(); onBlur?.(e) }}
      {...props}
    >
      <ParticleLayer particles={particles} controls={controls} active={active} reduced={reduced} />
      <Content>{children}</Content>
    </Link>
  )
}

export default MagneticButton
