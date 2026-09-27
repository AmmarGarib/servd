'use client'
// BrandDeck: the kitchens as a hand of oversized trading cards.
//
// Each card is its brand's own colours (brandSurface), framed in the servd
// ink border and offset shadow so the three still read as one set. Cards
// tilt toward the pointer. Hovering or tapping lifts a card and makes its
// crowd character cheer (coffee → stackd, burger → Flipd).
//
// Each card also wears a live status sticker from useKitchens, written in the
// brand's own voice, with a pulsing dot while the kitchen is open. A cast
// member peeks over the top edge of the stackd card (coffee) and the Flipd
// card (burger), and dozes at night.
//
// simmer is the deliberate contrast: night-green, Amarante, a thin bone
// hairline and, only while simmer is really open, one small orange dot. It
// has no stickers and no character, and its candle only glows during
// service.
//
// There are two links per card, using the stretched-link pattern: the name
// link's ::after covers the card (→ /brand/<slug>), and "Order from X" sits
// above it (→ /<slug>).
//
// Reveal hygiene: SSR is final. Cards mounted below the fold are armed at
// opacity .4 / 24px and settle in ≤ 450 ms (useReveal).
import Link from 'next/link'
import { useRef, type CSSProperties, type PointerEvent } from 'react'
import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform } from 'framer-motion'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { brandSurface } from '../../../lib/concept'
import { useKitchens } from '../../../lib/world/kitchens'
import { useWorld } from '../../../lib/world/useWorld'
import { kitchenLine } from '../../../lib/world/voice'
import { asKitchenSlug } from '../../../lib/world/kitchenCore'
import { emitCrowd } from '../../characters/crowdBus'
import type { CharacterKind } from '../../characters/types'
import { Motes } from '../../world/Ambient'
import { DozyCameo } from '../PartyHero'
import { useReveal } from './Divider'
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

function StatusSticker({ slug, elegant }: { slug: string; elegant: boolean }) {
  const kitchens = useKitchens()
  const world = useWorld()
  const ks = asKitchenSlug(slug)
  const k = ks ? kitchens.bySlug[ks] : undefined
  if (!k) return null
  const line = world.ready ? kitchenLine(k, world.dayPart) : k.label
  return (
    <span className={`${d.status} ${elegant ? d.statusQuiet : ''}`} data-phase={k.phase}>
      {!elegant && <span className={d.statusDot} aria-hidden />}
      <span className={d.statusText}>{line}</span>
    </span>
  )
}

function BrandCard({ b, index }: { b: HomeBrand; index: number }) {
  const reduce = useReducedMotion()
  const meta = META[b.slug] ?? FALLBACK_META
  const surface = brandSurface(b.slug)
  const cardRef = useRef<HTMLDivElement>(null)
  const [slotRef, reveal] = useReveal<HTMLElement>()
  const touchTimer = useRef<number | undefined>(undefined)

  // Pointer tilt: springy, fine pointers and full motion only.
  const px = useMotionValue(0.5)
  const py = useMotionValue(0.5)
  const sx = useSpring(px, { stiffness: 220, damping: 18 })
  const sy = useSpring(py, { stiffness: 220, damping: 18 })
  const strength = meta.elegant ? 5 : 11
  const rotateY = useTransform(sx, [0, 1], [-strength, strength])
  const rotateX = useTransform(sy, [0, 1], [strength * 0.8, -strength * 0.8])
  const gx = useTransform(sx, (v) => `${v * 100}%`)
  const gy = useTransform(sy, (v) => `${v * 100}%`)
  const glare = useMotionTemplate`radial-gradient(circle at ${gx} ${gy}, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 55%)`

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
  // Touch parity: a tap gets the same lift (and cheer) that hover does.
  function onDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse') return
    const el = slotRef.current
    if (!el) return
    el.setAttribute('data-touched', '1')
    window.clearTimeout(touchTimer.current)
    touchTimer.current = window.setTimeout(() => el.removeAttribute('data-touched'), 900)
    if (meta.cheer) emitCrowd({ type: 'cheer', kind: meta.cheer })
  }

  return (
    <article
      ref={slotRef}
      className={`${d.slot} ${s.rv} ${meta.elegant ? d.elegant : ''}`}
      data-reveal={reveal}
      data-slug={b.slug}
      style={{ '--tilt': `${meta.tilt}deg`, '--ri': Math.min(index, 2) } as CSSProperties}
    >
      <motion.div
        ref={cardRef}
        className={d.card}
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

        {/* A cast member peeking over the top edge (never on simmer). */}
        {meta.cheer && !meta.elegant && (
          <span className={d.peek} aria-hidden>
            <DozyCameo kind={meta.cheer} pose="peek" size={76} delay={index * 400} className={d.peekCameo} />
          </span>
        )}

        <div className={d.photo}>
          <img src={b.img} alt="" loading="lazy" decoding="async" width={1200} height={960} />
          <span className={d.num} aria-hidden>No. 0{index + 1}</span>
          <span className={d.kind} aria-hidden>{meta.kind}</span>
          {meta.elegant && <span aria-hidden className={d.candle} />}
          <StatusSticker slug={b.slug} elegant={!!meta.elegant} />
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
          {meta.elegant && (
            <span aria-hidden className={d.hairline}>
              <span className={d.hairDot} />
            </span>
          )}
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
    </article>
  )
}

export function BrandDeck({ brands }: { brands: HomeBrand[] }) {
  const [headRef, headReveal] = useReveal<HTMLElement>()
  return (
    <section id="brands" className={d.section} aria-labelledby="brands-title">
      <Motes className={s.motes} count={8} seed={21} color="rgba(78, 42, 79, 0.28)" />
      <svg aria-hidden className={d.bgStar} viewBox="0 0 40 40"><path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" /></svg>
      <div className={s.wrap}>
        <header ref={headRef} className={`${d.head} ${s.rv}`} data-reveal={headReveal}>
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
        </header>

        <div className={d.grid}>
          {brands.map((b, i) => <BrandCard key={b.id} b={b} index={i} />)}
        </div>
      </div>
    </section>
  )
}
