'use client'
// Reveal helpers for the simmer microsite.
//
// The contract (same as the hub's): the server render and a no-JS render are
// the FINAL state — everything visible. Only once the client mounts, and only
// when motion is allowed, does a section get `data-reveal="armed"` (lines sit
// under their mask), then `"shown"` the moment it scrolls into view. So there
// is no hydration swap, nothing is ever stranded invisible, and reduced-motion
// readers never see a transition.

import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react'
import s from './simmer.module.css'

export type RevealState = 'idle' | 'armed' | 'shown'

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Reduced-motion preference, read after mount so the first client render
 *  matches the server's (no hydration mismatch on motion styles). */
export function useReducedMotionAfterMount(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduce(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])
  return reduce
}

/** Arms on mount, shows once in view, never un-shows. */
export function useReveal<T extends HTMLElement = HTMLElement>(rootMargin = '0px 0px -12% 0px') {
  const ref = useRef<T | null>(null)
  const [state, setState] = useState<RevealState>('idle')
  useEffect(() => {
    const el = ref.current
    if (!el || prefersReducedMotion() || typeof IntersectionObserver === 'undefined') return
    setState('armed')
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        // One frame after arming so the armed styles are painted first and
        // the transition has somewhere to start from.
        requestAnimationFrame(() => setState('shown'))
        io.disconnect()
      }
    }, { rootMargin, threshold: 0.01 })
    io.observe(el)
    return () => io.disconnect()
  }, [rootMargin])
  return [ref, state] as const
}

/** A block whose `.line` / `.rise` / `.rule` children reveal on scroll. */
export function Reveal({
  as: Tag = 'div', className, style, children, rootMargin, ...rest
}: {
  as?: ElementType
  className?: string
  style?: CSSProperties
  children: ReactNode
  rootMargin?: string
} & Record<string, unknown>) {
  const [ref, state] = useReveal<HTMLElement>(rootMargin)
  return (
    <Tag ref={ref} data-reveal={state === 'idle' ? undefined : state} className={className} style={style} {...rest}>
      {children}
    </Tag>
  )
}

/** One masked line. `i` staggers it against its siblings. */
export function Line({ i = 0, children, className }: { i?: number, children: ReactNode, className?: string }) {
  return (
    <span className={`${s.line} ${className ?? ''}`}>
      <span style={{ ['--i' as string]: i } as CSSProperties}>{children}</span>
    </span>
  )
}

/** Letters that surface one at a time (title-card wordmark). Read as one
 *  word by assistive tech — the per-letter spans are hidden and the word is
 *  given once as a label. */
export function Letters({ text }: { text: string }) {
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <span className={s.srOnly}>{text}</span>
      <span aria-hidden="true">
        {Array.from(text).map((ch, i) => (
          <span key={i} className={s.letter} style={{ ['--i' as string]: i } as CSSProperties}>
            {ch === ' ' ? ' ' : ch}
          </span>
        ))}
      </span>
    </span>
  )
}
