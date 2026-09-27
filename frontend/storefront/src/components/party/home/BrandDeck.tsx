'use client'
// BrandDeck — the kitchens as a hand of oversized trading cards.
//
// Each card is its brand's own colours (brandSurface) framed in the servd
// ink border + offset shadow so the three still read as one set. Cards slap
// in with a springy entrance and tilt toward the mouse. They can also be
// picked up: press anywhere outside the Order button and the card lifts
// (scale 1.04, up 12px, deeper shadow) and follows the pointer on a short
// leash (±14px, tilting with it). Let go and it springs back with a jelly
// wobble while the matching characters in the crowd cheer. Hovering a card
// with a mouse perks those characters up.
//
// simmer is the deliberate contrast: night-green, Amarante, one orange
// hairline, a slow candle glow. It is never picked up and never cheered; the
// crowd only glances at it.
//
// Two links per card, stretched-link pattern: the name link's ::after
// covers the card (→ /brand/<slug>), and "Order from X" sits above it
// (→ /<slug>). A pickup that travels more than 6px swallows the click, so a
// fidget never navigates by accident; a plain tap still does.
import Link from 'next/link'
import { useEffect, useRef, useState, type CSSProperties, type FocusEvent, type MouseEvent, type PointerEvent } from 'react'
import {
  animate,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionStyle,
  type Transition,
} from 'framer-motion'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { brandSurface } from '../../../lib/concept'
import { JELLY, SPRING, tick } from '../../../lib/tactile'
import { brandKinds, emitCrowd } from '../../characters/crowdBus'
import s from './home.module.css'
import d from './deck.module.css'

/** SPRING is typed as a component Transition; animate() on a bare motion
 *  value wants a value transition. Same numbers, narrower type. */
function springOf(t: Transition) {
  const { stiffness, damping, mass } = t as { stiffness?: number; damping?: number; mass?: number }
  return { type: 'spring' as const, stiffness, damping, mass }
}

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
  elegant?: boolean
}

const META: Record<string, CardMeta> = {
  stackd: {
    kind: 'scratch café · market',
    tab: { bg: '#FCE8CE', fg: '#7C2946' },
    tilt: -2.5,
    sticker: { src: '/brand/stackd-mascot.png', w: 338, h: 453, className: d.stickerMascot ?? '' },
    wordmark: { src: '/brand/stackd-wordmark.png', w: 599, h: 148 },
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
  },
}

const FALLBACK_META: CardMeta = { kind: 'kitchen', tab: { bg: '#FFF4D6', fg: '#4E2A4F' }, tilt: 0 }

/** Leash length: the card never strays further than this from its slot. */
const LEASH_PX = 14
/** Early vertical travel that means "I'm scrolling", not "I'm holding". */
const SCROLL_INTENT_PX = 10
const SCROLL_INTENT_MS = 120
/** Travel beyond which a release is a drag, not a tap. */
const CLICK_SLOP_PX = 6

/** Soft clamp: follows 1:1 near the slot, then stretches toward ±LEASH_PX. */
function leash(v: number): number {
  return LEASH_PX * Math.tanh(v / (LEASH_PX * 1.6))
}

interface Gesture {
  id: number
  x0: number
  y0: number
  t0: number
  moved: number
}

function BrandCard({ b, index }: { b: HomeBrand; index: number }) {
  const reduce = useReducedMotion()
  const meta = META[b.slug] ?? FALLBACK_META
  const elegant = !!meta.elegant
  const kinds = brandKinds(b.slug)
  const surface = brandSurface(b.slug)
  const cardRef = useRef<HTMLDivElement>(null)

  const [held, setHeld] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [seen, setSeen] = useState(false)
  const gesture = useRef<Gesture | null>(null)
  const lastMoved = useRef(0)
  const lastDropAt = useRef(0)
  const detach = useRef<(() => void) | null>(null)
  const liftTimer = useRef<number | undefined>(undefined)

  // Pointer tilt — springy, only for fine pointers and full motion.
  const px = useMotionValue(0.5)
  const py = useMotionValue(0.5)
  const sx = useSpring(px, { stiffness: 220, damping: 18 })
  const sy = useSpring(py, { stiffness: 220, damping: 18 })
  const strength = elegant ? 5 : 11

  // Pickup: lift 0 → 1, leash offsets in px, hover 0 → 1, jelly scales.
  const lift = useMotionValue(0)
  const hov = useMotionValue(0)
  const lx = useMotionValue(0)
  const ly = useMotionValue(0)
  const jx = useMotionValue(1)
  const jy = useMotionValue(1)

  const rotateY = useTransform([sx, lx], ([p, l]: number[]) => ((p ?? 0.5) * 2 - 1) * strength + ((l ?? 0) / LEASH_PX) * 7)
  const rotateX = useTransform([sy, ly], ([p, l]: number[]) => (1 - (p ?? 0.5) * 2) * strength * 0.8 - ((l ?? 0) / LEASH_PX) * 5)
  const rotate = useTransform(lx, (l) => l * 0.22)
  const y = useTransform([hov, lift, ly], ([h, l, o]: number[]) => (h ?? 0) * -8 + (l ?? 0) * -12 + (o ?? 0))
  const scale = useTransform(lift, (l) => 1 + l * 0.04)
  const gx = useTransform(sx, (v) => `${v * 100}%`)
  const gy = useTransform(sy, (v) => `${v * 100}%`)
  const glare = useMotionTemplate`radial-gradient(circle at ${gx} ${gy}, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 55%)`

  useEffect(
    () => () => {
      detach.current?.()
      window.clearTimeout(liftTimer.current)
    },
    [],
  )

  function lookAtCard() {
    const r = cardRef.current?.getBoundingClientRect()
    if (r) emitCrowd({ type: 'look', x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }

  function setHover(on: boolean) {
    if (reduce) return
    animate(hov, on ? 1 : 0, springOf(on ? SPRING.settle : SPRING.release))
  }

  function onMove(e: PointerEvent<HTMLDivElement>) {
    if (reduce || e.pointerType !== 'mouse') return
    const r = cardRef.current?.getBoundingClientRect()
    if (!r) return
    px.set((e.clientX - r.left) / r.width)
    py.set((e.clientY - r.top) / r.height)
  }
  function onLeave(e: PointerEvent<HTMLDivElement>) {
    px.set(0.5)
    py.set(0.5)
    if (e.pointerType === 'mouse') setHover(false)
  }
  function onEnter(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType !== 'mouse') return
    setHover(true)
    if (elegant) lookAtCard()
    else emitCrowd({ type: 'perk', kinds })
  }
  function onFocusIn() {
    setHover(true)
  }
  function onFocusOut(e: FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(false)
  }

  /** Put the card down. `celebrate` is false when the hold was abandoned
   *  (scroll intent, pointercancel) — then it just settles, no party. */
  function drop(celebrate: boolean) {
    window.clearTimeout(liftTimer.current)
    detach.current?.()
    detach.current = null
    lastMoved.current = gesture.current?.moved ?? 0
    lastDropAt.current = performance.now()
    gesture.current = null
    setHeld(false)
    setPressed(false)
    if (reduce) {
      if (celebrate && kinds.length) emitCrowd({ type: 'cheer', kinds })
      return
    }
    animate(lift, 0, springOf(SPRING.release))
    animate(lx, 0, springOf(SPRING.release))
    animate(ly, 0, springOf(SPRING.release))
    if (!celebrate) return
    animate(jx, JELLY.scaleX, { duration: 0.5, ease: 'easeOut' })
    animate(jy, JELLY.scaleY, { duration: 0.5, ease: 'easeOut' })
    if (kinds.length) emitCrowd({ type: 'cheer', kinds })
    tick('light')
  }

  function onDown(e: PointerEvent<HTMLDivElement>) {
    lastMoved.current = 0
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if ((e.target as Element).closest('[data-nolift]')) return
    if (elegant) {
      // simmer: the crowd glances over, nothing else moves.
      lookAtCard()
      return
    }
    detach.current?.()
    gesture.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: 0 }

    const move = (ev: globalThis.PointerEvent) => {
      const g = gesture.current
      if (!g || ev.pointerId !== g.id) return
      const dx = ev.clientX - g.x0
      const dy = ev.clientY - g.y0
      g.moved = Math.max(g.moved, Math.hypot(dx, dy))
      if (performance.now() - g.t0 < SCROLL_INTENT_MS && Math.abs(dy) > SCROLL_INTENT_PX) {
        drop(false)
        return
      }
      if (reduce) return
      animate(lx, leash(dx), springOf(SPRING.leash))
      animate(ly, leash(dy), springOf(SPRING.leash))
    }
    const up = (ev: globalThis.PointerEvent) => {
      if (gesture.current && ev.pointerId === gesture.current.id) drop(true)
    }
    const cancel = (ev: globalThis.PointerEvent) => {
      if (gesture.current && ev.pointerId === gesture.current.id) drop(false)
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    detach.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }

    const pickUp = () => {
      if (reduce) {
        setPressed(true)
        return
      }
      setHeld(true)
      animate(lift, 1, springOf(SPRING.leash))
    }
    // Touch waits out the scroll-intent window first, so swiping the page
    // past the deck doesn't make every card jump as the finger crosses it.
    if (e.pointerType === 'mouse') pickUp()
    else {
      const id = e.pointerId
      liftTimer.current = window.setTimeout(() => {
        if (gesture.current?.id === id) pickUp()
      }, SCROLL_INTENT_MS)
    }
  }

  // Mouse only: stop the browser starting a text selection or a native
  // link/image drag when the card is grabbed.
  function onMouseDown(e: MouseEvent<HTMLDivElement>) {
    if (elegant || e.button !== 0) return
    if ((e.target as Element).closest('[data-nolift]')) return
    e.preventDefault()
  }

  function onClickCapture(e: MouseEvent<HTMLDivElement>) {
    // Only the click that ends this very gesture can be swallowed.
    if (lastMoved.current > CLICK_SLOP_PX && performance.now() - lastDropAt.current < 400) {
      e.preventDefault()
      e.stopPropagation()
    }
    lastMoved.current = 0
  }

  const entrance = elegant
    ? {
        initial: { opacity: 0.001, y: 24 },
        transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: index * 0.06 },
      }
    : {
        initial: { opacity: 0.001, y: 24, rotate: meta.tilt * 1.2, scale: 0.96 },
        transition: {
          default: { type: 'spring' as const, stiffness: 260, damping: 15, delay: index * 0.06 },
          opacity: { duration: 0.22, delay: index * 0.06 },
        },
      }

  const cardStyle = {
    x: lx,
    y,
    scale,
    rotate,
    rotateX,
    rotateY,
    scaleX: jx,
    scaleY: jy,
    background: surface.bg,
    color: surface.text,
    '--text': surface.text,
    '--surface': surface.bg,
    '--lift': lift,
    '--hov': hov,
  } as MotionStyle

  return (
    <motion.article
      className={`${d.slot} ${elegant ? d.elegant : ''}`}
      style={{ '--tilt': `${meta.tilt}deg` } as CSSProperties}
      data-seen={seen || undefined}
      initial={entrance.initial}
      whileInView={{ opacity: 1, y: 0, rotate: meta.tilt, scale: 1 }}
      viewport={{ once: true, amount: 0.2, margin: '0px 0px -8% 0px' }}
      transition={reduce ? { duration: 0 } : entrance.transition}
      onViewportEnter={() => setSeen(true)}
    >
      <motion.div
        ref={cardRef}
        className={d.card}
        data-held={held || undefined}
        data-pressed={pressed || undefined}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onPointerEnter={onEnter}
        onPointerDown={onDown}
        onMouseDown={onMouseDown}
        onClickCapture={onClickCapture}
        onFocus={onFocusIn}
        onBlur={onFocusOut}
        style={cardStyle}
      >
        <span className={d.tab} style={{ background: meta.tab.bg, color: meta.tab.fg }}>
          /{b.slug}
        </span>

        <div className={d.photo}>
          <img src={b.img} alt="" loading="lazy" decoding="async" width={1200} height={960} draggable={false} />
          <span className={d.num} aria-hidden>No. 0{index + 1}</span>
          <span className={d.kind} aria-hidden>{meta.kind}</span>
          {elegant && <span aria-hidden className={d.candle} />}
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
              draggable={false}
            />
          </span>
        )}

        <div className={d.body}>
          <h3 className={d.name}>
            <Link href={`/brand/${b.slug}`} className={d.stretch} aria-label={`Visit ${b.name}'s landing page`} draggable={false}>
              {meta.wordmark ? (
                <img src={meta.wordmark.src} alt={b.name} width={meta.wordmark.w} height={meta.wordmark.h} className={d.wordmark} loading="lazy" decoding="async" draggable={false} />
              ) : (
                b.name
              )}
            </Link>
          </h3>
          {elegant && <span aria-hidden className={d.hairline} />}
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
              className={elegant ? d.orderQuiet : `${s.btn} ${s.btnCream} ${d.order}`}
              data-nolift=""
              draggable={false}
            >
              Order from {b.name}
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

export function BrandDeck({ brands }: { brands: HomeBrand[] }) {
  const reduce = useReducedMotion()
  return (
    <section id="brands" className={d.section} aria-labelledby="brands-title">
      <svg aria-hidden className={d.bgStar} viewBox="0 0 40 40"><path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" /></svg>
      <div className={s.wrap}>
        <motion.header
          className={d.head}
          initial={{ opacity: 0.001, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2, margin: '0px 0px -8% 0px' }}
          transition={reduce ? { duration: 0 } : { default: { type: 'spring', stiffness: 220, damping: 20 }, opacity: { duration: 0.22 } }}
        >
          <div>
            <p className={s.eyebrow}>The kitchens</p>
            <h2 id="brands-title" className={s.h2}>
              Pick one. Pick two.<br />
              <em>Pick all of them.</em>
            </h2>
            <p className={s.lead}>
              One bag, one delivery. We hold the slowest dish so the salad stays cold and the burger stays hot.
            </p>
          </div>
          <p className={d.note} aria-hidden>
            <span>pick a card up, or tap to meet the kitchen</span>
            <svg viewBox="0 0 120 80"><path d="M8 10 C 40 4, 88 14, 96 46 M84 36 L97 50 L108 34" /></svg>
          </p>
        </motion.header>

        <div className={d.grid}>
          {brands.map((b, i) => <BrandCard key={b.id} b={b} index={i} />)}
        </div>
      </div>
    </section>
  )
}
