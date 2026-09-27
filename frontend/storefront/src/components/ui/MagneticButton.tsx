'use client'
import * as React from 'react'
import { useEffect, useState, useCallback } from 'react'
import { motion, useAnimation, type AnimationControls } from 'framer-motion'
import Link, { type LinkProps } from 'next/link'
import { useIsCoarsePointer, usePrefersReducedMotion } from '../../lib/film/motion'

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
//  - Particles are invisible at rest and only fly in on hover, so a page full
//    of these stays calm until you interact.
//  - No magnet on coarse pointers (phones/tablets): there is no hover, and a
//    touch that turns into a scroll used to leave the particles stranded.
//    Any pointercancel/touchcancel releases them.

interface Particle { id: number; x: number; y: number }

function useMagnet(particleCount: number, disabled?: boolean) {
  const [particles, setParticles] = useState<Particle[]>([])
  const controls = useAnimation()
  const coarse = useIsCoarsePointer()
  const reduced = usePrefersReducedMotion()

  useEffect(() => {
    setParticles(
      Array.from({ length: particleCount }, (_, i) => ({
        id: i,
        x: Math.random() * 140 - 70,
        y: Math.random() * 90 - 45,
      })),
    )
  }, [particleCount])

  const attract = useCallback(async () => {
    if (disabled || coarse || reduced) return
    await controls.start({ x: 0, y: 0, opacity: 0.85, transition: { type: 'spring', stiffness: 50, damping: 10 } })
  }, [controls, disabled, coarse, reduced])

  const release = useCallback(async () => {
    await controls.start((i: number) => ({
      x: particles[i]?.x ?? 0,
      y: particles[i]?.y ?? 0,
      opacity: 0,
      transition: { type: 'spring', stiffness: 100, damping: 15 },
    }))
  }, [controls, particles])

  return { particles, controls, attract, release }
}

function ParticleLayer({ particles, controls }: { particles: Particle[]; controls: AnimationControls }) {
  return (
    <span aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 'inherit', pointerEvents: 'none' }}>
      <span style={{ position: 'absolute', top: '50%', left: '50%' }}>
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
  onTouchCancel,
  onPointerCancel,
  ...props
}: MagneticButtonProps) {
  const { particles, controls, attract, release } = useMagnet(particleCount, disabled)
  return (
    <button
      className={className}
      disabled={disabled}
      style={{ position: 'relative', ...style }}
      onMouseEnter={(e) => { void attract(); onMouseEnter?.(e) }}
      onMouseLeave={(e) => { void release(); onMouseLeave?.(e) }}
      onTouchStart={(e) => { void attract(); onTouchStart?.(e) }}
      onTouchEnd={(e) => { void release(); onTouchEnd?.(e) }}
      onTouchCancel={(e) => { void release(); onTouchCancel?.(e) }}
      onPointerCancel={(e) => { void release(); onPointerCancel?.(e) }}
      {...props}
    >
      <ParticleLayer particles={particles} controls={controls} />
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
  onTouchCancel,
  onPointerCancel,
  ...props
}: MagneticLinkProps) {
  const { particles, controls, attract, release } = useMagnet(particleCount, false)
  return (
    <Link
      className={className}
      style={{ position: 'relative', ...style }}
      onMouseEnter={(e) => { void attract(); onMouseEnter?.(e) }}
      onMouseLeave={(e) => { void release(); onMouseLeave?.(e) }}
      onTouchStart={(e) => { void attract(); onTouchStart?.(e) }}
      onTouchEnd={(e) => { void release(); onTouchEnd?.(e) }}
      onTouchCancel={(e) => { void release(); onTouchCancel?.(e) }}
      onPointerCancel={(e) => { void release(); onPointerCancel?.(e) }}
      {...props}
    >
      <ParticleLayer particles={particles} controls={controls} />
      <Content>{children}</Content>
    </Link>
  )
}

export default MagneticButton
