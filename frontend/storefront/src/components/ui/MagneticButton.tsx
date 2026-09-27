'use client'
import * as React from 'react'
import { useEffect, useState, useCallback, useRef } from 'react'
import {
  motion,
  useAnimation,
  useReducedMotion,
  type AnimationControls,
  type HTMLMotionProps,
} from 'framer-motion'
import Link, { type LinkProps } from 'next/link'
import { useSquish } from '../tactile/useSquish'

// "Magnetize" hover effect, colour-preserving, with the rubber press. Two
// drop-ins:
//   <MagneticButton …>  for <button> CTAs
//   <MagneticLink href=…> for Next <Link> CTAs
// All props pass straight through, so each call site's existing palette/styles
// are untouched — we add a particle layer and the shared squash (useSquish).
// Particles use `currentColor`, so they tint to the element's text colour.
//
// Notes:
//  - The element keeps overflow visible (box-shadows intact); the particle
//    layer clips itself (overflow hidden + borderRadius inherit).
//  - Particles are invisible at rest and only fly in on hover/touch, so a page
//    full of these stays calm until you interact. Under reduced motion they
//    never fly at all.
//  - Particle count follows the element's measured width (about 5 on a small
//    pill, 12 on a wide bar) unless the caller passes particleCount.
//  - A primary commit (a submit button, or a .servd-btn-primary) squashes a
//    little deeper than an ordinary press.

interface Particle { id: number; x: number; y: number }

function countForWidth(width: number): number {
  if (width <= 0) return 8
  if (width < 140) return 5
  if (width > 220) return 12
  return Math.round(5 + ((width - 140) / 80) * 7)
}

function useMeasuredCount<T extends HTMLElement>(explicit: number | undefined) {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState<{ count: number; w: number; h: number }>({ count: explicit ?? 8, w: 140, h: 90 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      const count = explicit ?? countForWidth(r.width)
      setSize((prev) =>
        prev.count === count && Math.abs(prev.w - r.width) < 8 && Math.abs(prev.h - r.height) < 8
          ? prev
          : { count, w: r.width, h: r.height },
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [explicit])

  return { ref, ...size }
}

function useMagnet(particleCount: number, spreadX: number, spreadY: number, disabled?: boolean) {
  const [particles, setParticles] = useState<Particle[]>([])
  const controls = useAnimation()
  const reduced = useReducedMotion()
  const off = disabled || !!reduced

  useEffect(() => {
    setParticles(
      Array.from({ length: particleCount }, (_, i) => ({
        id: i,
        x: (Math.random() - 0.5) * spreadX,
        y: (Math.random() - 0.5) * spreadY,
      })),
    )
  }, [particleCount, spreadX, spreadY])

  const attract = useCallback(async () => {
    if (off) return
    await controls.start({ x: 0, y: 0, opacity: 0.85, transition: { type: 'spring', stiffness: 50, damping: 10 } })
  }, [controls, off])

  const release = useCallback(async () => {
    if (off) return
    await controls.start((i: number) => ({
      x: particles[i]?.x ?? 0,
      y: particles[i]?.y ?? 0,
      opacity: 0,
      transition: { type: 'spring', stiffness: 100, damping: 15 },
    }))
  }, [controls, particles, off])

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

const isCommit = (className: string | undefined, type?: string) =>
  type === 'submit' || /\bservd-btn-primary\b/.test(className ?? '')

interface MagneticButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  particleCount?: number
}

export function MagneticButton({
  particleCount,
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
  const measured = useMeasuredCount<HTMLButtonElement>(particleCount)
  const { particles, controls, attract, release } = useMagnet(measured.count, measured.w, measured.h, disabled)
  const squish = useSquish({ strength: isCommit(className, props.type) ? 1.35 : 1 })
  const pressable = !disabled && props['aria-busy'] !== true && props['aria-busy'] !== 'true'
  return (
    <motion.button
      {...(props as HTMLMotionProps<'button'>)}
      ref={measured.ref}
      className={className}
      disabled={disabled}
      style={{ position: 'relative', ...style } as HTMLMotionProps<'button'>['style']}
      onMouseEnter={(e) => { void attract(); onMouseEnter?.(e) }}
      onMouseLeave={(e) => { void release(); onMouseLeave?.(e) }}
      onTouchStart={(e) => { void attract(); onTouchStart?.(e) }}
      onTouchEnd={(e) => { void release(); onTouchEnd?.(e) }}
      whileHover={pressable ? squish.whileHover : undefined}
      whileTap={pressable ? squish.whileTap : undefined}
      transition={squish.transition}
      onTapStart={pressable ? squish.onTapStart : undefined}
    >
      <ParticleLayer particles={particles} controls={controls} />
      <Content>{children}</Content>
    </motion.button>
  )
}

type MagneticLinkProps = LinkProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps> & {
    particleCount?: number
    className?: string
    style?: React.CSSProperties
    children?: React.ReactNode
  }

// Next's Link forwards its ref to the <a>, so framer can drive it directly.
const MotionLink = motion(Link)

export function MagneticLink({
  particleCount,
  className,
  children,
  style,
  onMouseEnter,
  onMouseLeave,
  onTouchStart,
  onTouchEnd,
  ...props
}: MagneticLinkProps) {
  const measured = useMeasuredCount<HTMLAnchorElement>(particleCount)
  const { particles, controls, attract, release } = useMagnet(measured.count, measured.w, measured.h, false)
  const squish = useSquish({ strength: isCommit(className) ? 1.2 : 1 })
  const motionProps = {
    ...props,
    ref: measured.ref,
    className,
    style: { position: 'relative', ...style },
    onMouseEnter: (e: React.MouseEvent<HTMLAnchorElement>) => { void attract(); onMouseEnter?.(e) },
    onMouseLeave: (e: React.MouseEvent<HTMLAnchorElement>) => { void release(); onMouseLeave?.(e) },
    onTouchStart: (e: React.TouchEvent<HTMLAnchorElement>) => { void attract(); onTouchStart?.(e) },
    onTouchEnd: (e: React.TouchEvent<HTMLAnchorElement>) => { void release(); onTouchEnd?.(e) },
    whileHover: squish.whileHover,
    whileTap: squish.whileTap,
    transition: squish.transition,
    onTapStart: squish.onTapStart,
  } as unknown as React.ComponentProps<typeof MotionLink>
  return (
    <MotionLink {...motionProps}>
      <ParticleLayer particles={particles} controls={controls} />
      <Content>{children}</Content>
    </MotionLink>
  )
}

export default MagneticButton
