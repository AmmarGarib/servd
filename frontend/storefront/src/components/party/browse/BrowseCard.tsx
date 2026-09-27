// A single brand card on /browse — a cream sticker card with an ink border,
// offset shadow, and a slight alternating tilt (see browse.module.css
// .cardWrap:nth-child) plus a stable per-card jitter seeded from its id.
// Preserves the original card's behaviour: links to /brand/<slug>, tracks
// concept_switched, shows open/closed + service type, and falls back to the
// brand's editorial one-liner when the concept has no custom description.
//
// It is also a sticker you can peel:
// - fine pointer: drag it and it lifts off the page (rotation and shadow grow
//   with the distance), then settles back on release. A press that moves
//   less than 6px is still a click.
// - touch: dragging would steal the scroll, so a 350ms long-press curls the
//   bottom-right corner instead; letting go lays it flat again.
'use client'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { motion, useMotionValue, useTransform } from 'framer-motion'
import type { Concept } from '../../../lib/concept'
import { typeLabel, conceptHeroImage, brandStory, formatBrandName } from '../../../lib/concept'
import { isOpenNow } from '../../../lib/hours'
import { track } from '../../../lib/analytics'
import { buzz, usePlay, usePrefersReducedMotion } from '@/lib/play'
import s from './browse.module.css'

const CLICK_SLOP = 6
const LONG_PRESS_MS = 350

/** Stable ±0.6deg from the concept id (FNV-1a), so SSR and client agree. */
function jitterFor(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (((h >>> 0) % 1201) / 1000 - 0.6)
}

function useFinePointer(): boolean {
  const [fine, setFine] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)')
    const on = () => setFine(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return fine
}

export function BrowseCard({ concept }: { concept: Concept }) {
  const story = brandStory(concept.slug)
  const status = isOpenNow(concept.type)
  const name = formatBrandName(concept.name)
  const jitter = useMemo(() => jitterFor(concept.id), [concept.id])

  const reduce = usePrefersReducedMotion()
  const fine = useFinePointer()
  const canDrag = fine && !reduce

  // Drag-to-peel (fine pointer).
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const dist = useTransform<number, number>([x, y], ([a = 0, b = 0]) => Math.hypot(a, b))
  const rotate = useTransform<number, number>([x, y], ([a = 0, b = 0]) => {
    const d = Math.hypot(a, b)
    return Math.max(-14, Math.min(14, a * 0.05 + (a >= 0 ? 1 : -1) * d * 0.02))
  })
  const scale = useTransform(dist, [0, 240], [1, 1.04])
  const filter = useTransform(dist, (d) => {
    if (d < 0.5) return 'none'
    const k = Math.min(1, d / 220)
    return `drop-shadow(0 ${(4 + k * 26).toFixed(1)}px ${(6 + k * 28).toFixed(1)}px rgba(42, 26, 43, ${(0.12 + k * 0.28).toFixed(2)}))`
  })
  const [dragging, setDragging] = useState(false)
  const travelled = useRef(0)

  // Long-press curl (touch / coarse pointer).
  const [curled, setCurled] = useState(false)
  const press = useRef<{ id: number; x: number; y: number; timer: number } | null>(null)
  const swallowClick = useRef(false)

  useEffect(() => () => { if (press.current) window.clearTimeout(press.current.timer) }, [])

  function endPress() {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
    setCurled(false)
  }

  function onPointerDown(e: ReactPointerEvent<HTMLAnchorElement>) {
    travelled.current = 0
    swallowClick.current = false
    if (canDrag || e.pointerType === 'mouse') return
    const id = e.pointerId
    const timer = window.setTimeout(() => {
      if (!press.current || press.current.id !== id) return
      setCurled(true)
      swallowClick.current = true
      buzz(12)
    }, LONG_PRESS_MS)
    press.current = { id, x: e.clientX, y: e.clientY, timer }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLAnchorElement>) {
    const p = press.current
    if (!p || p.id !== e.pointerId) return
    // The thumb is scrolling, not pressing.
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) endPress()
  }

  const curlOn = curled || dragging

  return (
    <motion.div
      className={s.peel}
      data-dragging={dragging || undefined}
      drag={canDrag}
      dragSnapToOrigin
      dragMomentum={false}
      dragTransition={{ bounceStiffness: 260, bounceDamping: 22 }}
      style={canDrag ? { x, y, rotate, scale, filter } : undefined}
      onDragStart={() => setDragging(true)}
      onDrag={(_, info) => { travelled.current = Math.max(travelled.current, Math.hypot(info.offset.x, info.offset.y)) }}
      onDragEnd={() => setDragging(false)}
    >
      <Link
        href={`/brand/${concept.slug}`}
        aria-label={`Visit ${name}${status.open ? ' — open now' : ' — closed'}`}
        className={s.card}
        data-toy={canDrag ? 'peel' : undefined}
        data-curl={curlOn || undefined}
        draggable={false}
        style={{ '--jitter': `${jitter.toFixed(3)}deg` } as CSSProperties}
        onDragStart={(e) => e.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onPointerLeave={endPress}
        onContextMenu={(e) => { if (curled) e.preventDefault() }}
        onClick={(e) => {
          if (travelled.current >= CLICK_SLOP || swallowClick.current) {
            swallowClick.current = false
            e.preventDefault()
            return
          }
          track('concept_switched', { slug: concept.slug })
          try { usePlay.getState().markKitchen(concept.slug) } catch { /* cosmetic */ }
        }}
      >
        <div className={`${s.photoWrap} ${status.open ? '' : s.photoClosed}`}>
          <img
            src={conceptHeroImage(concept)}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className={s.photo}
          />
          <span aria-hidden className={s.photoShade} />
          <span className={s.badge}>{typeLabel(concept.type)}</span>
          <span className={`${s.statusPill} ${status.open ? s.statusOpen : s.statusClosed}`}>
            <span aria-hidden className={s.statusDot} />
            {status.open ? 'Open now' : 'Closed'}
          </span>
        </div>
        <div className={s.cardBody}>
          <h3 className={s.cardName}>{name}</h3>
          <p className={s.cardDesc}>{concept.description || story.oneLiner}</p>
          <div className={s.cardFooter}>
            <span className={s.orderPill}>Order <span aria-hidden>→</span></span>
            <span className={s.seeMore}>See brand <span aria-hidden>→</span></span>
          </div>
        </div>
      </Link>
    </motion.div>
  )
}
