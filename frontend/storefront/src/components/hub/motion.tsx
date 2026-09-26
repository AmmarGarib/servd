'use client'
// servd hub motion primitives — the motion contract from
// design-system/servd/MASTER.md, in one place so every hub surface moves
// the same way:
//   • section reveals 600–800ms, expo-out, entrance order = reading order
//   • stagger step 80ms
//   • transform/opacity only
//   • prefers-reduced-motion → final state immediately, no parallax
//
//   <Reveal>         fade-rise when scrolled into view
//   <RevealGroup>    staggers its <RevealItem> children in reading order
//   <Parallax>       drift at a fraction of scroll speed (off under reduced motion)
//
// These SSR as hidden (opacity 0) until hydration, so use them for content
// BELOW the fold only. Above-the-fold entrances use the CSS `.hub-enter`
// class instead, which animates without waiting for JS.
//
// The same motion.* element renders on server and client; reduced motion
// is expressed as `initial={false}` rather than swapping to a plain tag,
// which would mismatch the server markup on hydration.

import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
  type Variants,
} from 'framer-motion'
import { useRef, type CSSProperties, type ReactNode } from 'react'

export const HUB_EASE_EXPO = [0.16, 1, 0.3, 1] as const
export const HUB_STAGGER = 0.08

interface RevealProps {
  children: ReactNode
  delay?: number
  /** Travel in px before settling. */
  y?: number
  className?: string
  style?: CSSProperties
  as?: 'div' | 'section' | 'li' | 'article' | 'header'
}

export function Reveal({ children, delay = 0, y = 28, className, style, as = 'div' }: RevealProps) {
  const reduce = useReducedMotion()
  const Tag = motion[as]
  return (
    <Tag
      className={className}
      style={style}
      initial={reduce ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2, margin: '0px 0px -8% 0px' }}
      transition={{ duration: 0.7, delay, ease: [...HUB_EASE_EXPO] }}
    >
      {children}
    </Tag>
  )
}

const groupVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: HUB_STAGGER } },
}
const itemVariants: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.65, ease: [...HUB_EASE_EXPO] } },
}

export function RevealGroup({ children, className, style, as = 'div' }: Omit<RevealProps, 'delay' | 'y'>) {
  const reduce = useReducedMotion()
  const Tag = motion[as]
  return (
    <Tag
      className={className}
      style={style}
      variants={groupVariants}
      initial={reduce ? false : 'hidden'}
      whileInView="show"
      viewport={{ once: true, amount: 0.15 }}
    >
      {children}
    </Tag>
  )
}

export function RevealItem({ children, className, style, as = 'div' }: Omit<RevealProps, 'delay' | 'y'>) {
  const Tag = motion[as]
  return (
    <Tag className={className} style={style} variants={itemVariants}>
      {children}
    </Tag>
  )
}

interface ParallaxProps {
  children: ReactNode
  /** Fraction of scroll travel; positive lags behind the page. */
  speed?: number
  className?: string
  style?: CSSProperties
}

export function Parallax({ children, speed = 0.12, className, style }: ParallaxProps) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const y = useTransform(scrollYProgress, [0, 1], [speed * -140, speed * 140])
  return (
    <motion.div ref={ref} className={className} style={{ ...style, y: reduce ? 0 : y }}>
      {children}
    </motion.div>
  )
}
