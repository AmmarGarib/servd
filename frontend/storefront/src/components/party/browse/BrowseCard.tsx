// A single brand card on /browse — a cream sticker card with an ink border,
// offset shadow, and a slight alternating resting tilt (browse.module.css
// .cardWrap:nth-child). Links to /brand/<slug>, tracks concept_switched,
// shows open/closed + service type, the brand's tagline, and falls back to the
// brand's editorial one-liner when the concept has no custom description.
//
// The card itself stays a plain <Link>, so the site's cut (P1 SceneCut) grows
// from the card's own rectangle. The motion lives on wrappers (DealtCard):
//   • dealt by its own 'enter' scroll progress: y 40→0, rotation ±6°→rest,
//     opacity 0.5→1 (never invisible, so any snapshot reads)
//   • fine pointers: ±6° hover tilt + 8px photo parallax
//   • coarse pointers: a tilt sweep driven by 'pass' progress
//   • reduced motion: none of it — the resting card
'use client'
import Link from 'next/link'
import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from 'framer-motion'
import type { Concept } from '../../../lib/concept'
import { typeLabel, conceptHeroImage, brandStory, brandAccent, formatBrandName } from '../../../lib/concept'
import { isOpenNow } from '../../../lib/hours'
import { track } from '../../../lib/analytics'
import { useScene, useIsCoarsePointer, usePrefersReducedMotion } from '@/lib/film/motion'
import s from './browse.module.css'

export function BrowseCard({
  concept, photoX, photoY,
}: {
  concept: Concept
  photoX?: MotionValue<number>
  photoY?: MotionValue<number>
}) {
  const story = brandStory(concept.slug)
  const status = isOpenNow(concept.type)
  const name = formatBrandName(concept.name)
  const accent = brandAccent(concept.slug, concept.primaryColor)

  return (
    <Link
      href={`/brand/${concept.slug}`}
      aria-label={`Visit ${name}${status.open ? ' — open now' : ' — closed'}`}
      className={s.card}
      onClick={() => track('concept_switched', { slug: concept.slug })}
    >
      <div className={`${s.photoWrap} ${status.open ? '' : s.photoClosed}`} style={{ backgroundColor: accent }}>
        <motion.img
          src={conceptHeroImage(concept)}
          alt=""
          loading="lazy"
          decoding="async"
          className={s.photo}
          style={photoX && photoY ? { x: photoX, y: photoY, scale: 1.08 } : undefined}
        />
        <span aria-hidden className={s.photoShade} />
        <span className={s.badge}>{typeLabel(concept.type)}</span>
        <span className={`${s.statusPill} ${status.open ? s.statusOpen : s.statusClosed}`}>
          <span aria-hidden className={s.statusDot} />
          {status.open ? 'Open now' : 'Closed'}
        </span>
      </div>
      <div className={s.cardBody}>
        <h3 className={s.cardName}>
          <span aria-hidden className={s.cardDot} style={{ backgroundColor: accent }} />
          {name}
        </h3>
        <p className={s.cardTagline}>{story.tagline}</p>
        <p className={s.cardDesc}>{concept.description || story.oneLiner}</p>
        <div className={s.cardFooter}>
          <span className={s.orderPill}>Order <span aria-hidden>→</span></span>
          <span className={s.seeMore}>See brand <span aria-hidden>→</span></span>
        </div>
      </div>
    </Link>
  )
}

const TILT = 6        // degrees, each axis
const PARALLAX = 8    // px, photo shift
const SPRING = { stiffness: 260, damping: 22, mass: 0.6 }

/** A BrowseCard dealt onto the table by scroll, with pointer/scroll tilt. */
export function DealtCard({ concept, index }: { concept: Concept; index: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = usePrefersReducedMotion()
  const coarse = useIsCoarsePointer()

  // Deal: scrubbed by this card's own enter progress.
  const enter = useScene(ref, 'enter')
  const from = index % 2 === 0 ? -6 : 6
  const dealY = useTransform(enter, [0, 1], [40, 0])
  const dealRotate = useTransform(enter, [0, 1], [from, 0])
  const dealOpacity = useTransform(enter, [0, 1], [0.5, 1])

  // Coarse pointers: a tilt sweep as the card passes through the viewport.
  const pass = useScene(ref, 'pass')
  const sweepX = useTransform(pass, [0, 0.5, 1], [TILT, 0, -TILT])
  const sweepY = useTransform(pass, [0, 1], [from * 0.5, -from * 0.5])
  const sweepPhoto = useTransform(pass, [0, 1], [-PARALLAX, PARALLAX])
  const zero = useMotionValue(0)

  // Fine pointers: hover tilt + photo parallax, sprung.
  const px = useMotionValue(0)
  const py = useMotionValue(0)
  const hoverX = useSpring(useTransform(py, (v) => -v * TILT * 2), SPRING)
  const hoverY = useSpring(useTransform(px, (v) => v * TILT * 2), SPRING)
  const photoHX = useSpring(useTransform(px, (v) => -v * PARALLAX * 2), SPRING)
  const photoHY = useSpring(useTransform(py, (v) => -v * PARALLAX * 2), SPRING)

  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (reduce || coarse || e.pointerType !== 'mouse') return
    const r = e.currentTarget.getBoundingClientRect()
    px.set(Math.max(-0.5, Math.min(0.5, (e.clientX - r.left) / r.width - 0.5)))
    py.set(Math.max(-0.5, Math.min(0.5, (e.clientY - r.top) / r.height - 0.5)))
  }
  function onLeave() {
    px.set(0)
    py.set(0)
  }

  const still = reduce
  const rotateX = still ? zero : coarse ? sweepX : hoverX
  const rotateY = still ? zero : coarse ? sweepY : hoverY
  const photoX = still ? undefined : coarse ? zero : photoHX
  const photoY = still ? undefined : coarse ? sweepPhoto : photoHY

  return (
    <motion.div
      ref={ref}
      className={s.cardWrap}
      // Under reduced motion useScene holds at 1, so this is the resting card.
      style={{ y: dealY, rotate: dealRotate, opacity: dealOpacity }}
    >
      <motion.div
        className={s.tilt}
        style={{ rotateX, rotateY, transformPerspective: 900 }}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
      >
        <BrowseCard concept={concept} photoX={photoX} photoY={photoY} />
      </motion.div>
    </motion.div>
  )
}
