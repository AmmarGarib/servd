// A single brand card on /browse: a cream sticker with an ink border, an
// offset shadow and a slight hand-placed tilt. It is a live object:
//   - mouse: the card tilts toward the pointer (up to ±5deg), a soft glare
//     follows the cursor, it lifts, and the photo eases in;
//   - press: it squashes into the table and springs back on release;
//   - touch: no tilt (it would fight the scroll), just the press and a
//     one-shot 2deg pop, like flicking the corner of a sticker.
// Preserves the original card's behaviour: links to /brand/<slug>, tracks
// concept_switched, shows open/closed + service type, and falls back to the
// brand's editorial one-liner when the concept has no custom description.
'use client'
import Link from 'next/link'
import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from 'framer-motion'
import type { Concept } from '../../../lib/concept'
import { typeLabel, conceptHeroImage, brandStory, formatBrandName } from '../../../lib/concept'
import { isOpenNow } from '../../../lib/hours'
import { track } from '../../../lib/analytics'
import { SPRING } from '../../../lib/tactile'
import s from './browse.module.css'

const MAX_TILT = 5
// Spring for the pointer-follow: SPRING.settle's numbers, without the `type`
// key (useSpring takes the bare spring options).
const FOLLOW = { stiffness: 260, damping: 24 }

interface Props {
  concept: Concept
  /** Position in the grid, used for the resting odd/even tilt. */
  index?: number
}

export function BrowseCard({ concept, index = 0 }: Props) {
  const story = brandStory(concept.slug)
  const status = isOpenNow(concept.type)
  const name = formatBrandName(concept.name)
  const reduce = useReducedMotion()

  // The sticker's resting tilt: alternate left/right like stickers slapped on
  // by hand.
  const restTilt = index % 2 === 0 ? -1.1 : 1.1

  const rx = useMotionValue(0)
  const ry = useMotionValue(0)
  const rz = useMotionValue(restTilt)
  const rotateX = useSpring(rx, FOLLOW)
  const rotateY = useSpring(ry, FOLLOW)
  const rotate = useSpring(rz, FOLLOW)

  const gx = useMotionValue(50)
  const gy = useMotionValue(30)
  const glareOpacity = useSpring(0, FOLLOW)
  const glare = useMotionTemplate`radial-gradient(circle at ${gx}% ${gy}%, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0) 55%)`

  const popTimer = useRef<number | undefined>(undefined)

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (reduce || e.pointerType !== 'mouse') return
    const r = e.currentTarget.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    const px = (e.clientX - r.left) / r.width
    const py = (e.clientY - r.top) / r.height
    rx.set((0.5 - py) * 2 * MAX_TILT)
    ry.set((px - 0.5) * 2 * MAX_TILT)
    gx.set(px * 100)
    gy.set(py * 100)
  }

  function onPointerEnter(e: ReactPointerEvent<HTMLDivElement>) {
    if (reduce || e.pointerType !== 'mouse') return
    rz.set(0)
    glareOpacity.set(0.18)
  }

  function settle() {
    rx.set(0)
    ry.set(0)
    rz.set(restTilt)
    glareOpacity.set(0)
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (reduce || e.pointerType === 'mouse') return
    // Touch: one-shot pop, then back to the resting tilt.
    window.clearTimeout(popTimer.current)
    rz.set(restTilt + (restTilt < 0 ? 2 : -2))
    popTimer.current = window.setTimeout(() => rz.set(restTilt), 160)
  }

  return (
    <motion.div
      className={s.shell}
      style={{
        rotateX,
        rotateY,
        rotate,
        transformPerspective: 800,
      }}
      whileHover={reduce ? undefined : { y: -6 }}
      whileTap={reduce ? undefined : { y: 2, scaleX: 1.02, scaleY: 0.97 }}
      transition={SPRING.release}
      onPointerMove={onPointerMove}
      onPointerEnter={onPointerEnter}
      onPointerLeave={settle}
      onPointerDown={onPointerDown}
    >
      <Link
        href={`/brand/${concept.slug}`}
        aria-label={`Visit ${name}${status.open ? ', open now' : ', closed'}`}
        className={s.card}
        onClick={() => track('concept_switched', { slug: concept.slug })}
      >
        <div className={`${s.photoWrap} ${status.open ? '' : s.photoClosed}`}>
          <img
            src={conceptHeroImage(concept)}
            alt=""
            loading="lazy"
            decoding="async"
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
            <span className={s.orderPill}>Order <span aria-hidden className={s.pillArrow}>→</span></span>
            <span className={s.seeMore}>See brand <span aria-hidden>→</span></span>
          </div>
        </div>
        {/* Glare: a soft sheen that follows the cursor across the sticker. */}
        <motion.span
          aria-hidden
          className={s.glare}
          style={{ backgroundImage: glare, opacity: glareOpacity }}
        />
      </Link>
    </motion.div>
  )
}
