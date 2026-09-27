'use client'
// Reveal helpers for the simmer microsite.
//
// The contract (same as the hub's): the server render and a no-JS render are
// the FINAL state — everything visible. Only once the client mounts, only
// when motion is allowed, and only for a block that is still below the fold,
// does it get `data-reveal="armed"` (lines sit under their mask), then
// `"shown"` the moment its first sliver comes within 8% of the viewport.
//
// Hygiene, because a jump-scroll is photographed 900 ms later:
//   • the attribute is written straight onto the element from the observer
//     callback — no React render sits between "in view" and "moving";
//   • a block already on screen (or above it) at mount is never armed;
//   • every entrance in simmer.module.css lands within 450 ms of the trigger,
//     stagger included, so no section is ever an empty tiber or bone screen.
// Nothing is ever stranded invisible, and reduced-motion readers never see a
// transition.

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
  return useMediaAfterMount('(prefers-reduced-motion: reduce)')
}

/** Any media query, read after mount (false on the server and first render). */
export function useMediaAfterMount(query: string): boolean {
  const [match, setMatch] = useState(false)
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia(query)
    const sync = () => setMatch(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [query])
  return match
}

const DEFAULT_MARGIN = '0px 0px 8% 0px'
/** How far below the fold (as a share of the viewport) the trigger reaches. */
const MARGIN_SHARE = 0.08

/**
 * Arms on mount (below the fold only), shows once in view, never un-shows.
 * `staticQuery`: a media query that, when it matches at mount, keeps the
 * block static — the reduced-motion treatment — e.g. on touch.
 */
export function useReveal<T extends HTMLElement = HTMLElement>(rootMargin = DEFAULT_MARGIN, staticQuery?: string) {
  const ref = useRef<T | null>(null)
  const [state, setState] = useState<RevealState>('idle')
  useEffect(() => {
    const el = ref.current
    if (!el || prefersReducedMotion() || typeof IntersectionObserver === 'undefined') return
    if (staticQuery && window.matchMedia?.(staticQuery).matches) return
    const vh = window.innerHeight || document.documentElement.clientHeight
    // Already on screen, or scrolled past: stay as painted.
    if (el.getBoundingClientRect().top < vh * (1 + MARGIN_SHARE)) return

    el.dataset.reveal = 'armed'
    setState('armed')
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      el.dataset.reveal = 'shown'
      setState('shown')
    }, { rootMargin, threshold: 0.01 })
    io.observe(el)
    return () => {
      io.disconnect()
      // Unmounting mid-way (or a StrictMode re-run) must not strand it hidden.
      if (el.dataset.reveal === 'armed') delete el.dataset.reveal
    }
  }, [rootMargin, staticQuery])
  return [ref, state] as const
}

/** A block whose `.line` / `.rise` / `.rule` / `.letter` / `.frame` / `.ink` /
 *  `.sentence` children reveal on scroll. */
export function Reveal({
  as: Tag = 'div', className, style, children, rootMargin, staticQuery, ...rest
}: {
  as?: ElementType
  className?: string
  style?: CSSProperties
  children: ReactNode
  rootMargin?: string
  staticQuery?: string
} & Record<string, unknown>) {
  // The data-reveal attribute is owned by useReveal (written on the element),
  // never rendered by React, so a re-render can't reset it.
  const [ref] = useReveal<HTMLElement>(rootMargin, staticQuery)
  return (
    <Tag ref={ref} className={className} style={style} {...rest}>
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
            {ch === ' ' ? '\u00a0' : ch}
          </span>
        ))}
      </span>
    </span>
  )
}
