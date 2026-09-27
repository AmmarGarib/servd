'use client'
// BrandDeck — act ii, "the deal". The kitchens as a hand of oversized
// trading cards, dealt by the scroll.
//
// Each card is its brand's own colours (brandSurface) framed in the servd
// ink border + offset shadow so the three still read as one set. simmer is
// the deliberate contrast: night-green, Amarante, one orange hairline, a
// slow candle glow — no stickers, no cartoon, no cheer.
//
// Choreography (all scrubbed by scroll position, never by time, so every
// frame is populated — the snapshot-proof rule):
//   - Three columns: p = the deck's 'enter' progress. At p = 0 the cards sit
//     stacked at the deck's centre, fully opaque, rotated -8/2/10deg at 0.92
//     scale; by p = 1 each has been dealt (with a little arc) to its slot and
//     its resting tilt.
//   - Stacked layout (≤ 980px): each card slides in from alternating sides
//     (x ±30% → 0) on its own 'enter' progress while its rotation settles.
//   - Heading words rise by position only (y 30% → 0), always fully opaque.
//
// Interaction:
//   - Mouse: springy pointer tilt + radial glare; hovering a playful card
//     makes its crowd character cheer (coffee → stackd, burger → Flipd).
//   - Touch twin: each card's tilt (rotateY -10 → 10deg) and a glare stripe
//     follow its own 'pass' progress, sweeping as it crosses the middle of
//     the viewport. A tap gives a 300ms tilt pulse toward the tap point, the
//     cheer and a haptic tick.
//   - Reduced motion: the final dealt state, flat cards, no glare.
//
// Two links per card, stretched-link pattern: the name link's ::after
// covers the card (→ /brand/<slug>), and "Order from X" sits above it
// (→ /<slug>). Both are plain Links, so the film cut (SceneCut) intercepts
// them and grows its slate from the card.
import Link from 'next/link'
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import {
  animate,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  type MotionValue,
} from 'framer-motion'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { brandSurface } from '../../../lib/concept'
import { lerp, seg, useIsCoarsePointer, usePrefersReducedMotion, useScene } from '../../../lib/film/motion'
import { haptic } from '../../../lib/haptics'
import { emitCrowd } from '../../characters/crowdBus'
import type { CharacterKind } from '../../characters/types'
import { Slate } from '../../film/Slate'
import s from './home.module.css'
import d from './deck.module.css'

export interface HomeBrand {
  id: string
  name: string
  slug: string
  accent: string
  tagline: string
  highlights: string[]
  img: string
}

interface CardMeta {
  kind: string
  tab: { bg: string; fg: string }
  tilt: number
  sticker?: { src: string; w: number; h: number; className: string }
  wordmark?: { src: string; w: number; h: number }
  cheer?: CharacterKind
  elegant?: boolean
}

const META: Record<string, CardMeta> = {
  stackd: {
    kind: 'scratch café · market',
    tab: { bg: '#FCE8CE', fg: '#7C2946' },
    tilt: -2.5,
    sticker: { src: '/brand/stackd-mascot.png', w: 338, h: 453, className: d.stickerMascot ?? '' },
    wordmark: { src: '/brand/stackd-wordmark.png', w: 599, h: 148 },
    cheer: 'coffee',
  },
  simmer: {
    kind: 'small plates · mocktails',
    tab: { bg: '#F3ECDE', fg: '#06392F' },
    tilt: 0,
    elegant: true,
  },
  flipd: {
    kind: 'smash burgers',
    tab: { bg: '#FED561', fg: '#294375' },
    tilt: 2.5,
    sticker: { src: '/brand/flipd-badge.png', w: 760, h: 760, className: d.stickerBadge ?? '' },
    cheer: 'burger',
  },
}

const FALLBACK_META: CardMeta = { kind: 'kitchen', tab: { bg: '#FFF4D6', fg: '#4E2A4F' }, tilt: 0 }

/** Rotation of each card while it still sits in the deck (by position in the hand). */
const DECK_ROT = [-8, 2, 10]
/** One column + gap, as a % of a slot's own width (gap ≈ 3vw on a ~1200px row). */
const COLUMN_STEP = 108
/** Touch twin: max pass-tilt; simmer stays calmer. */
const PASS_TILT = 10

// Mode bits, fed to the transforms as a MotionValue so a layout/pointer
// change recomputes the styles without re-creating any hook.
const STACKED = 1
const COARSE = 2
const REDUCE = 4

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

function BrandCard({ b, index, count, deckP, mode }: {
  b: HomeBrand
  index: number
  count: number
  deckP: MotionValue<number>
  mode: MotionValue<number>
}) {
  const reduce = usePrefersReducedMotion()
  const coarse = useIsCoarsePointer()
  const meta = META[b.slug] ?? FALLBACK_META
  const surface = brandSurface(b.slug)
  const slotRef = useRef<HTMLElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // Own scene progress: 'enter' drives the stacked-layout slide-in, 'pass'
  // drives the touch tilt + glare sweep.
  const ownEnter = useScene(slotRef, 'enter')
  const ownPass = useScene(slotRef, 'pass')

  // ── The deal ─────────────────────────────────────────────────────────
  const centre = (count - 1) / 2
  const offset = (centre - index) * COLUMN_STEP // % of the slot's width
  const deckRot = DECK_ROT[index] ?? 0
  const side = index % 2 === 0 ? -1 : 1
  const window0 = index * 0.1
  const window1 = 0.7 + index * 0.1

  const dealt = useTransform([deckP, ownEnter, mode], ([dp, op, m]: number[]) => {
    const flags = m ?? 0
    if (flags & REDUCE) return 1
    return easeOut(flags & STACKED ? seg(op ?? 1, 0, 1) : seg(dp ?? 1, window0, window1))
  })
  const x = useTransform([dealt, mode], ([e, m]: number[]) => {
    const t = e ?? 1
    return (m ?? 0) & STACKED ? `${lerp(side * 30, 0, t)}%` : `${lerp(offset, 0, t)}%`
  })
  // A small flick: the card lifts off the deck and lands in its slot.
  const y = useTransform([dealt, mode], ([e, m]: number[]) =>
    (m ?? 0) & STACKED ? 0 : -Math.sin(Math.PI * (e ?? 1)) * 36,
  )
  const rotate = useTransform([dealt, mode], ([e, m]: number[]) => {
    const t = e ?? 1
    return (m ?? 0) & STACKED ? lerp(side * 7, meta.tilt, t) : lerp(deckRot, meta.tilt, t)
  })
  const scale = useTransform([dealt, mode], ([e, m]: number[]) =>
    (m ?? 0) & STACKED ? lerp(0.96, 1, e ?? 1) : lerp(0.92, 1, e ?? 1),
  )

  // ── Tilt: mouse pointer, or the touch twin ───────────────────────────
  const px = useMotionValue(0.5)
  const py = useMotionValue(0.5)
  const sx = useSpring(px, { stiffness: 220, damping: 18 })
  const sy = useSpring(py, { stiffness: 220, damping: 18 })
  const pulseX = useMotionValue(0)
  const pulseY = useMotionValue(0)
  const strength = meta.elegant ? 5 : 11
  const passTilt = meta.elegant ? 4 : PASS_TILT

  const rotateY = useTransform([sx, ownPass, pulseY, mode], ([mx, pp, pu, m]: number[]) => {
    const flags = m ?? 0
    if (flags & REDUCE) return 0
    if (flags & COARSE) return lerp(-passTilt, passTilt, pp ?? 0.5) + (pu ?? 0)
    return lerp(-strength, strength, mx ?? 0.5)
  })
  const rotateX = useTransform([sy, pulseX, mode], ([my, pu, m]: number[]) => {
    const flags = m ?? 0
    if (flags & REDUCE) return 0
    if (flags & COARSE) return pu ?? 0
    return lerp(strength * 0.8, -strength * 0.8, my ?? 0.5)
  })

  // Glare: a radial hotspot under the mouse, or a stripe sweeping across
  // the card as it crosses the middle of the viewport (touch). simmer's
  // card keeps its candle and gets no sweep.
  const glare = useTransform([sx, sy, ownPass, mode], ([mx, my, pp, m]: number[]) => {
    if (!((m ?? 0) & COARSE)) {
      return `radial-gradient(circle at ${(mx ?? 0.5) * 100}% ${(my ?? 0.5) * 100}%, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 55%)`
    }
    if (meta.elegant) return 'none'
    const pos = lerp(-40, 140, seg(pp ?? 0.5, 0.28, 0.72))
    return `linear-gradient(105deg, rgba(255,255,255,0) ${pos - 16}%, rgba(255,255,255,0.3) ${pos}%, rgba(255,255,255,0) ${pos + 16}%)`
  })

  function onMove(e: PointerEvent<HTMLDivElement>) {
    if (reduce || e.pointerType !== 'mouse') return
    const r = cardRef.current?.getBoundingClientRect()
    if (!r) return
    px.set((e.clientX - r.left) / r.width)
    py.set((e.clientY - r.top) / r.height)
  }
  function onLeave() {
    px.set(0.5)
    py.set(0.5)
  }
  function onEnter(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse' && meta.cheer) emitCrowd({ type: 'cheer', kind: meta.cheer })
  }
  // Touch twin of hover: a 300ms tilt pulse toward the tap, the cheer, a tick.
  function onDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse') return
    if (meta.cheer) emitCrowd({ type: 'cheer', kind: meta.cheer })
    if (reduce) return
    haptic(8)
    const r = cardRef.current?.getBoundingClientRect()
    if (!r) return
    const nx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const ny = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    const k = meta.elegant ? 4 : 9
    animate(pulseY, [0, (nx - 0.5) * 2 * k, 0], { duration: 0.3, ease: 'easeOut' })
    animate(pulseX, [0, (0.5 - ny) * 2 * k, 0], { duration: 0.3, ease: 'easeOut' })
  }

  return (
    <motion.article
      ref={slotRef}
      className={`${d.slot} ${meta.elegant ? d.elegant : ''}`}
      style={{ x, y, rotate, scale, zIndex: count - index }}
    >
      <motion.div
        ref={cardRef}
        className={d.card}
        data-coarse={coarse ? 'true' : undefined}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onPointerEnter={onEnter}
        onPointerDown={onDown}
        style={{
          rotateX,
          rotateY,
          background: surface.bg,
          color: surface.text,
          '--text': surface.text,
          '--surface': surface.bg,
        } as never}
      >
        <span className={d.tab} style={{ background: meta.tab.bg, color: meta.tab.fg }}>
          /{b.slug}
        </span>

        <div className={d.photo}>
          <img src={b.img} alt="" loading="lazy" decoding="async" width={1200} height={960} />
          <span className={d.num} aria-hidden>No. 0{index + 1}</span>
          <span className={d.kind} aria-hidden>{meta.kind}</span>
          {meta.elegant && <span aria-hidden className={d.candle} />}
        </div>

        {meta.sticker && (
          <span aria-hidden className={`${d.sticker} ${meta.sticker.className}`}>
            <img
              alt=""
              src={meta.sticker.src}
              width={meta.sticker.w}
              height={meta.sticker.h}
              loading="lazy"
              decoding="async"
            />
          </span>
        )}

        <div className={d.body}>
          <h3 className={d.name}>
            <Link href={`/brand/${b.slug}`} className={d.stretch} aria-label={`Visit ${b.name}'s landing page`}>
              {meta.wordmark ? (
                <img src={meta.wordmark.src} alt={b.name} width={meta.wordmark.w} height={meta.wordmark.h} className={d.wordmark} loading="lazy" decoding="async" />
              ) : (
                b.name
              )}
            </Link>
          </h3>
          {meta.elegant && <span aria-hidden className={d.hairline} />}
          <p className={d.tagline}>{b.tagline}</p>
          {b.highlights.length > 0 && (
            <ul className={d.chips} aria-label={`${b.name} highlights`}>
              {b.highlights.slice(0, 3).map((h) => <li key={h}>{h}</li>)}
            </ul>
          )}
          <div className={d.actions}>
            <Link
              href={`/${b.slug}`}
              aria-label={`Order from ${b.name}`}
              className={meta.elegant ? d.orderQuiet : `${s.btn} ${s.btnCream} ${d.order}`}
              onMouseEnter={() => meta.cheer && emitCrowd({ type: 'cheer', kind: meta.cheer })}
            >
              {meta.elegant ? `order from ${b.name}` : `Order from ${b.name}`}
              <ArrowRight aria-hidden size={18} strokeWidth={2.6} />
            </Link>
            <span aria-hidden className={d.visit}>
              <ArrowUpRight size={20} strokeWidth={2.4} />
            </span>
          </div>
        </div>

        <motion.span aria-hidden className={d.glare} style={{ background: glare }} />
      </motion.div>
    </motion.article>
  )
}

/** One heading word, rising by position only (y 30% → 0), never faded. */
function Word({ p, i, children }: { p: MotionValue<number>; i: number; children: ReactNode }) {
  const y = useTransform(p, (v) => `${lerp(30, 0, easeOut(seg(v, i * 0.06, 0.5 + i * 0.06)))}%`)
  return <motion.span className={d.word} style={{ y }}>{children}</motion.span>
}

function Words({ text, p, from }: { text: string; p: MotionValue<number>; from: number }) {
  const words = text.split(' ')
  return (
    <>
      {words.map((w, i) => (
        <span key={`${w}-${i}`}>
          <Word p={p} i={from + i}>{w}</Word>
          {i < words.length - 1 ? ' ' : null}
        </span>
      ))}
    </>
  )
}

export function BrandDeck({ brands }: { brands: HomeBrand[] }) {
  const reduce = usePrefersReducedMotion()
  const coarse = useIsCoarsePointer()
  const stacked = useMedia('(max-width: 980px)')
  const sectionRef = useRef<HTMLElement>(null)
  const deckRef = useRef<HTMLDivElement>(null)

  // The heading plays on the section's entrance; the deal plays on the
  // deck's own entrance so it happens on screen, not above the fold.
  const headP = useScene(sectionRef, 'enter')
  const deckP = useScene(deckRef, 'enter')

  const mode = useMotionValue(0)
  useEffect(() => {
    mode.set((stacked ? STACKED : 0) | (coarse ? COARSE : 0) | (reduce ? REDUCE : 0))
  }, [mode, stacked, coarse, reduce])

  const LINE_ONE = 'Pick one. Pick two.'
  const LINE_TWO = 'Pick all of them.'
  const lineOneCount = LINE_ONE.split(' ').length

  return (
    <section ref={sectionRef} id="brands" className={d.section} aria-labelledby="brands-title">
      <svg aria-hidden className={d.bgStar} viewBox="0 0 40 40"><path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" /></svg>
      <div className={s.wrap}>
        <div className={d.slate}>
          <Slate act="ii" title="the kitchens" />
        </div>
        <header className={d.head}>
          <div>
            <h2 id="brands-title" className={s.h2}>
              <Words text={LINE_ONE} p={headP} from={0} />
              <br />
              <em><Words text={LINE_TWO} p={headP} from={lineOneCount} /></em>
            </h2>
            <p className={s.lead}>
              One bag, one delivery. We hold the slowest dish so the salad stays cold and the burger stays hot.
            </p>
          </div>
          <p className={d.note} aria-hidden>
            <span>{coarse ? 'tap a card to meet the kitchen' : 'pick a card to meet the kitchen'}</span>
            <svg viewBox="0 0 120 80"><path d="M8 10 C 40 4, 88 14, 96 46 M84 36 L97 50 L108 34" /></svg>
          </p>
        </header>

        <div ref={deckRef} className={d.grid}>
          {brands.map((b, i) => (
            <BrandCard key={b.id} b={b} index={i} count={brands.length} deckP={deckP} mode={mode} />
          ))}
        </div>
      </div>
    </section>
  )
}
