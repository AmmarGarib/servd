'use client'
// BrandDeck — the kitchens as a hand of oversized trading cards.
//
// Each card is its brand's own colours (brandSurface) framed in the servd
// ink border + offset shadow so the three still read as one set. Cards slap
// in with a springy entrance (and their crowd character cheers as each one
// lands), tilt toward the pointer, and a tap on a phone gives the card a
// quick peek-tilt. simmer is the deliberate contrast: night-green, Amarante,
// one orange hairline, a slow candle glow — no stickers, no cartoon, no
// cheers.
//
// The '/slug' tab on top of each card is a real button that FLIPS the card
// to a trading-card stat block on its back, built only from the brand's own
// highlights and hours. Flip all three in a session for the 'deck-flip'
// sticker.
//
// Two links per card front, stretched-link pattern: the name link's ::after
// covers the front face (→ /brand/<slug>), and "Order from X" sits above it
// (→ /<slug>).
import Link from 'next/link'
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { animate, motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform } from 'framer-motion'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { collect, sfx } from '@/lib/play'
import { brandSurface, formatBrandName } from '../../../lib/concept'
import { emitCrowd, type CrowdEvent } from '../../characters/crowdBus'
import type { CharacterKind } from '../../characters/types'
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
  /** Service hours line, shown on the back of the card. */
  hours?: string
}

interface CardMeta {
  kind: string
  tab: { bg: string; fg: string }
  /** The back face: the card's own accent as a stat-card ground. */
  back: { bg: string; fg: string; rule: string }
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
    back: { bg: '#7C2946', fg: '#FCE8CE', rule: '#9BD3DD' },
    tilt: -2.5,
    sticker: { src: '/brand/stackd-mascot.png', w: 338, h: 453, className: d.stickerMascot ?? '' },
    wordmark: { src: '/brand/stackd-wordmark.png', w: 599, h: 148 },
    cheer: 'coffee',
  },
  simmer: {
    kind: 'small plates · mocktails',
    tab: { bg: '#F3ECDE', fg: '#06392F' },
    back: { bg: '#06392F', fg: '#EDE6D3', rule: '#E94E1B' },
    tilt: 0,
    elegant: true,
  },
  flipd: {
    kind: 'smash burgers',
    tab: { bg: '#FED561', fg: '#294375' },
    back: { bg: '#294375', fg: '#FED561', rule: '#F9F0E1' },
    tilt: 2.5,
    sticker: { src: '/brand/flipd-badge.png', w: 760, h: 760, className: d.stickerBadge ?? '' },
    cheer: 'burger',
  },
}

const FALLBACK_META: CardMeta = {
  kind: 'kitchen',
  tab: { bg: '#FFF4D6', fg: '#4E2A4F' },
  back: { bg: '#4E2A4F', fg: '#FFF4D6', rule: '#FFD447' },
  tilt: 0,
}

/** "settle" spring from the play motion vocabulary. */
const SETTLE = { stiffness: 260, damping: 22 }
/** "pop" spring — presses. */
const POP = { type: 'spring' as const, stiffness: 520, damping: 18 }

// ── Session memory (sessionStorage with an in-memory fallback) ───────────

const memory = new Map<string, Set<string>>()

function readSet(key: string): Set<string> {
  const mem = memory.get(key) ?? new Set<string>()
  memory.set(key, mem)
  try {
    const raw = window.sessionStorage.getItem(key)
    if (raw) {
      const arr: unknown = JSON.parse(raw)
      if (Array.isArray(arr)) arr.forEach((v) => typeof v === 'string' && mem.add(v))
    }
  } catch {
    /* memory copy is enough */
  }
  return mem
}

/** Adds `value` to the session set; returns true if it was new. */
function addToSet(key: string, value: string): boolean {
  const set = readSet(key)
  if (set.has(value)) return false
  set.add(value)
  try {
    window.sessionStorage.setItem(key, JSON.stringify([...set]))
  } catch {
    /* memory copy is enough */
  }
  return true
}

const PEEK_KEY = 'servd-deck-peek-cheer'
const FLIP_KEY = 'servd-deck-flips'

function cheerFor(kind: CharacterKind, big = false): CrowdEvent {
  return big ? { type: 'cheer', kind, big: true } : { type: 'cheer', kind }
}

// ── One card ─────────────────────────────────────────────────────────────

function BrandCard({ b, index, total }: { b: HomeBrand; index: number; total: number }) {
  const reduce = useReducedMotion()
  const meta = META[b.slug] ?? FALLBACK_META
  const surface = brandSurface(b.slug)
  const name = formatBrandName(b.name)
  const cardRef = useRef<HTMLDivElement>(null)
  const frontRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLDivElement>(null)
  const tabRef = useRef<HTMLButtonElement>(null)
  const flipBackRef = useRef<HTMLButtonElement>(null)
  const [flipped, setFlipped] = useState(false)
  const flipIntent = useRef<'none' | 'toBack' | 'toFront'>('none')
  const hoverCheers = useRef<number[]>([])
  const landed = useRef(false)

  // Pointer tilt — springy, only for fine pointers and full motion.
  const px = useMotionValue(0.5)
  const py = useMotionValue(0.5)
  const sx = useSpring(px, { stiffness: 220, damping: 18 })
  const sy = useSpring(py, { stiffness: 220, damping: 18 })
  const strength = meta.elegant ? 5 : 11
  const tiltY = useTransform(sx, [0, 1], [-strength, strength])
  const tiltX = useTransform(sy, [0, 1], [strength * 0.8, -strength * 0.8])
  // Touch peek, added on top of the tilt.
  const peekX = useMotionValue(0)
  const peekY = useMotionValue(0)
  // The flip itself, on the "settle" spring.
  const flipTarget = useMotionValue(0)
  const flipY = useSpring(flipTarget, SETTLE)
  const rotateX = useTransform([tiltX, peekX], ([a, p]: number[]) => (a ?? 0) + (p ?? 0))
  const rotateY = useTransform([tiltY, peekY, flipY], ([a, p, f]: number[]) => (a ?? 0) + (p ?? 0) + (f ?? 0))
  const gx = useTransform(sx, (v) => `${v * 100}%`)
  const gy = useTransform(sy, (v) => `${v * 100}%`)
  const glare = useMotionTemplate`radial-gradient(circle at ${gx} ${gy}, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 55%)`

  // Hidden face is inert (React 18 has no typed `inert` prop), and focus
  // follows the flip so keyboard users land on the face they can see.
  useEffect(() => {
    const front = frontRef.current
    const back = backRef.current
    if (front) {
      if (flipped) front.setAttribute('inert', '')
      else front.removeAttribute('inert')
    }
    if (back) {
      if (flipped) back.removeAttribute('inert')
      else back.setAttribute('inert', '')
    }
    if (flipIntent.current === 'toBack') flipBackRef.current?.focus({ preventScroll: true })
    else if (flipIntent.current === 'toFront') tabRef.current?.focus({ preventScroll: true })
    flipIntent.current = 'none'
  }, [flipped])

  useEffect(() => {
    flipTarget.set(!reduce && flipped ? 180 : 0)
    if (reduce) flipY.jump(0)
  }, [flipped, reduce, flipTarget, flipY])

  function hoverCheer() {
    if (!meta.cheer) return
    const now = Date.now()
    hoverCheers.current = hoverCheers.current.filter((t) => now - t < 10_000)
    hoverCheers.current.push(now)
    emitCrowd(cheerFor(meta.cheer, hoverCheers.current.length >= 3))
  }

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
    if (e.pointerType === 'mouse') hoverCheer()
  }
  function onDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType !== 'touch') return
    if (!reduce) {
      // Spring to a fixed peek, then ease back over 320ms. simmer peeks
      // at half the angle — it is the quiet card.
      const k = meta.elegant ? 0.5 : 1
      const back = { duration: 0.32, ease: [0.22, 1, 0.36, 1] as const }
      void animate(peekX, 6 * k, POP).then(() => animate(peekX, 0, back))
      void animate(peekY, -8 * k, POP).then(() => animate(peekY, 0, back))
    }
    if (meta.cheer && addToSet(PEEK_KEY, b.slug)) emitCrowd(cheerFor(meta.cheer))
  }

  function flipTo(next: boolean) {
    flipIntent.current = next ? 'toBack' : 'toFront'
    setFlipped(next)
    sfx('whoosh')
    if (!next) return
    const fresh = addToSet(FLIP_KEY, b.slug)
    const seen = readSet(FLIP_KEY)
    if (fresh && total > 0 && seen.size >= total) {
      const r = cardRef.current?.getBoundingClientRect()
      collect('deck-flip', r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined)
    }
  }

  function onTab(e: MouseEvent<HTMLButtonElement>) {
    // The tab sits over the card's stretched link — never let it navigate.
    e.preventDefault()
    e.stopPropagation()
    flipTo(!flipped)
  }

  function onLanded() {
    if (landed.current) return
    landed.current = true
    if (meta.cheer) emitCrowd(cheerFor(meta.cheer))
  }

  const entrance = meta.elegant
    ? { initial: { opacity: 0, y: 40 }, transition: { duration: 1.1, ease: [0.22, 1, 0.36, 1], delay: 0.15 + index * 0.12 } }
    : {
        initial: { opacity: 0, y: 90, rotate: meta.tilt * 4, scale: 0.88 },
        transition: { type: 'spring' as const, stiffness: 170, damping: 13, delay: index * 0.12 },
      }

  const isQuiet = !!meta.elegant
  const stats = b.highlights.slice(0, 3)
  const hours = b.hours?.trim()
  const lc = (v: string) => (isQuiet ? v.toLowerCase() : v)

  return (
    <motion.article
      className={`${d.slot} ${meta.elegant ? d.elegant : ''}`}
      style={{ '--tilt': `${meta.tilt}deg` } as CSSProperties}
      initial={entrance.initial}
      whileInView={{ opacity: 1, y: 0, rotate: meta.tilt, scale: 1 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={reduce ? { duration: 0 } : entrance.transition}
      onAnimationComplete={onLanded}
    >
      <motion.div
        ref={cardRef}
        className={`${d.card} ${reduce ? d.calm : ''}`}
        data-flipped={flipped || undefined}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onPointerEnter={onEnter}
        onPointerDown={onDown}
        style={{
          rotateX,
          rotateY,
          transformPerspective: 1200,
          '--text': surface.text,
          '--surface': surface.bg,
          '--back-bg': meta.back.bg,
          '--back-fg': meta.back.fg,
          '--back-rule': meta.back.rule,
        } as never}
      >
        {/* ── Front ──────────────────────────────────────────────────── */}
        <div
          ref={frontRef}
          className={`${d.face} ${d.front}`}
          style={{ background: surface.bg, color: surface.text }}
          aria-hidden={flipped || undefined}
        >
          <button
            ref={tabRef}
            type="button"
            className={d.tab}
            style={{ background: meta.tab.bg, color: meta.tab.fg }}
            data-toy="flip"
            aria-label={`flip the ${name} card`}
            onClick={onTab}
            onPointerDown={(e) => e.stopPropagation()}
          >
            /{b.slug}
            <svg aria-hidden viewBox="0 0 16 16" className={d.tabIcon} focusable="false">
              <path d="M3 6.5a5 5 0 0 1 9-1.5M13 9.5a5 5 0 0 1-9 1.5M12 2v3h-3M4 14v-3h3" />
            </svg>
          </button>

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
              <Link href={`/brand/${b.slug}`} className={d.stretch} aria-label={`Visit ${name}'s landing page`}>
                {meta.wordmark ? (
                  <img src={meta.wordmark.src} alt={name} width={meta.wordmark.w} height={meta.wordmark.h} className={d.wordmark} loading="lazy" decoding="async" />
                ) : (
                  name
                )}
              </Link>
            </h3>
            {meta.elegant && <span aria-hidden className={d.hairline} />}
            <p className={d.tagline}>{b.tagline}</p>
            {b.highlights.length > 0 && (
              <ul className={d.chips} aria-label={`${name} highlights`}>
                {b.highlights.slice(0, 3).map((h) => <li key={h}>{h}</li>)}
              </ul>
            )}
            <div className={d.actions}>
              <Link
                href={`/${b.slug}`}
                aria-label={`Order from ${name}`}
                className={meta.elegant ? d.orderQuiet : `${s.btn} ${s.btnCream} ${d.order}`}
                onMouseEnter={hoverCheer}
              >
                Order from {name}
                <ArrowRight aria-hidden size={18} strokeWidth={2.6} />
              </Link>
              <span aria-hidden className={d.visit}>
                <ArrowUpRight size={20} strokeWidth={2.4} />
              </span>
            </div>
          </div>

          <motion.span aria-hidden className={d.glare} style={{ background: glare }} />
        </div>

        {/* ── Back: the trading-card stat block ──────────────────────── */}
        <div
          ref={backRef}
          className={`${d.face} ${d.back}`}
          aria-hidden={!flipped || undefined}
          role="group"
          aria-label={`${name} kitchen stats`}
        >
          <span aria-hidden className={`${d.tab} ${d.backTab}`} style={{ background: meta.tab.bg, color: meta.tab.fg }}>
            /{b.slug}
          </span>
          <div className={d.backHead}>
            <span className={d.backNum}>{lc(`No. 0${index + 1}`)}</span>
            <span className={d.backKind}>{meta.kind}</span>
          </div>
          <p className={d.backName}>{name}</p>
          <span aria-hidden className={d.backRule} />
          <p className={d.backLabel}>kitchen stats</p>
          <ul className={d.stats}>
            {stats.map((h, i) => (
              <li key={h}>
                <span className={d.statKey} aria-hidden>{String(i + 1).padStart(2, '0')}</span>
                <span className={d.statVal}>{lc(h)}</span>
              </li>
            ))}
            {hours && (
              <li>
                <span className={d.statKey}>hours</span>
                <span className={d.statVal}>{lc(hours)}</span>
              </li>
            )}
          </ul>
          <p className={d.backFoot}>collect all three</p>
          <div className={d.backActions}>
            <button
              ref={flipBackRef}
              type="button"
              className={d.flipBack}
              data-toy="flip"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                flipTo(false)
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              flip back
            </button>
            <Link href={`/${b.slug}`} className={d.backOrder} aria-label={`Order from ${name}`}>
              {isQuiet ? `order from ${name}` : `Order from ${name}`}
              <ArrowRight aria-hidden size={16} strokeWidth={2.6} />
            </Link>
          </div>
        </div>
      </motion.div>
    </motion.article>
  )
}

export function BrandDeck({ brands }: { brands: HomeBrand[] }) {
  return (
    <section id="brands" className={d.section} aria-labelledby="brands-title">
      <svg aria-hidden className={d.bgStar} viewBox="0 0 40 40"><path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" /></svg>
      <div className={s.wrap}>
        <motion.header
          className={d.head}
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ type: 'spring', stiffness: 160, damping: 16 }}
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
            <span>tap a card to meet the kitchen</span>
            <svg viewBox="0 0 120 80"><path d="M8 10 C 40 4, 88 14, 96 46 M84 36 L97 50 L108 34" /></svg>
          </p>
        </motion.header>

        <div className={d.grid}>
          {brands.map((b, i) => <BrandCard key={b.id} b={b} index={i} total={brands.length} />)}
        </div>
      </div>
    </section>
  )
}
