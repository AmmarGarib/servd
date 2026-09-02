'use client'
// Liquid-glass motion primitives — the shared physical-motion vocabulary
// for the redesigned storefront. Everything here respects
// prefers-reduced-motion (render static, skip springs) and uses the same
// easing curve as the CSS layer (cubic-bezier(0.22, 1, 0.36, 1)) so JS-
// and CSS-driven motion feel like one system.
//
//   <Reveal>      — blur-up entrance when the element scrolls into view
//   <Parallax>    — child drifts at a fraction of scroll speed
//   <TiltCard>    — pointer-tracked 3D tilt with specular glare
//   <FloatY>      — endless gentle bob (mascots, decorative objects)
//
// Keep these dumb: no data fetching, no business logic — motion only.

import {
  motion,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from 'framer-motion'
import { useRef, type CSSProperties, type ReactNode } from 'react'

export const GLASS_EASE = [0.22, 1, 0.36, 1] as const

// ─── Reveal ──────────────────────────────────────────────────────────────

interface RevealProps {
  children: ReactNode
  /** Seconds to wait after entering the viewport (use for stagger). */
  delay?: number
  /** Entrance travel in px. Negative rises from above. */
  y?: number
  /** Add the blur-up treatment (heavier, use on hero-level content). */
  blur?: boolean
  /** Framer viewport amount — how much must be visible before firing. */
  amount?: number
  duration?: number
  className?: string
  style?: CSSProperties
  as?: 'div' | 'section' | 'span'
}

export function Reveal({
  children, delay = 0, y = 30, blur = false, amount = 0.2,
  duration = 0.75, className, style, as = 'div',
}: RevealProps) {
  const reduce = useReducedMotion()
  const Tag = motion[as]
  if (reduce) {
    const Static = as
    return <Static className={className} style={style}>{children}</Static>
  }
  return (
    <Tag
      className={className}
      style={style}
      initial={blur ? { opacity: 0, y, filter: 'blur(12px)' } : { opacity: 0, y }}
      whileInView={blur ? { opacity: 1, y: 0, filter: 'blur(0px)' } : { opacity: 1, y: 0 }}
      viewport={{ once: true, amount, margin: '0px 0px -8% 0px' }}
      transition={{ duration, delay, ease: [...GLASS_EASE] }}
    >
      {children}
    </Tag>
  )
}

// ─── Parallax ────────────────────────────────────────────────────────────

interface ParallaxProps {
  children: ReactNode
  /** Fraction of scroll travel, roughly -0.5..0.5. Positive lags behind. */
  speed?: number
  className?: string
  style?: CSSProperties
}

export function Parallax({ children, speed = 0.16, className, style }: ParallaxProps) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start end', 'end start'],
  })
  const y = useTransform(scrollYProgress, [0, 1], [speed * -160, speed * 160])
  return (
    <motion.div ref={ref} className={className} style={{ ...style, y: reduce ? 0 : y }}>
      {children}
    </motion.div>
  )
}

// ─── TiltCard ────────────────────────────────────────────────────────────

interface TiltCardProps {
  children: ReactNode
  /** Max tilt in degrees. */
  max?: number
  className?: string
  style?: CSSProperties
}

export function TiltCard({ children, max = 6, className, style }: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const rx = useMotionValue(0)
  const ry = useMotionValue(0)
  const srx = useSpring(rx, { stiffness: 180, damping: 18, mass: 0.6 })
  const sry = useSpring(ry, { stiffness: 180, damping: 18, mass: 0.6 })

  function onPointerMove(e: React.PointerEvent) {
    if (reduce || e.pointerType === 'touch') return
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const px = (e.clientX - rect.left) / rect.width - 0.5   // -0.5..0.5
    const py = (e.clientY - rect.top) / rect.height - 0.5
    ry.set(px * max * 2)
    rx.set(-py * max * 2)
  }
  function onPointerLeave() {
    rx.set(0)
    ry.set(0)
  }

  return (
    <motion.div
      ref={ref}
      className={className}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      style={{
        ...style,
        rotateX: srx,
        rotateY: sry,
        transformStyle: 'preserve-3d',
        transformPerspective: 900,
      }}
    >
      {children}
    </motion.div>
  )
}

// ─── FloatY ──────────────────────────────────────────────────────────────

interface FloatYProps {
  children: ReactNode
  /** Bob distance in px. */
  distance?: number
  /** Seconds per half-cycle. */
  duration?: number
  /** Slow continuous rotation in degrees (0 = none). */
  rotate?: number
  className?: string
  style?: CSSProperties
}

export function FloatY({
  children, distance = 12, duration = 3.2, rotate = 0, className, style,
}: FloatYProps) {
  const reduce = useReducedMotion()
  if (reduce) return <div className={className} style={style}>{children}</div>
  return (
    <motion.div
      className={className}
      style={style}
      animate={{
        y: [0, -distance, 0],
        ...(rotate ? { rotate: [0, rotate, 0] } : {}),
      }}
      transition={{ duration: duration * 2, ease: 'easeInOut', repeat: Infinity }}
    >
      {children}
    </motion.div>
  )
}
