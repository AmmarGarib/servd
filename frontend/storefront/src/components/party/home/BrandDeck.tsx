'use client'
// BrandDeck — the kitchens as a hand of oversized trading cards.
//
// Each card is its brand's own colours (brandSurface) framed in the servd
// ink border + offset shadow so the three still read as one set. Cards slap
// in with a springy entrance, tilt toward the pointer, and hovering a
// playful one makes its crowd character cheer (coffee → stackd, burger →
// Flipd). simmer is the deliberate contrast: night-green, Amarante, one
// orange hairline, a slow candle glow — no stickers, no cartoon.
//
// Two links per card, stretched-link pattern: the name link's ::after
// covers the card (→ /brand/<slug>), and "Order from X" sits above it
// (→ /<slug>).
import Link from 'next/link'
import { useRef, type CSSProperties, type PointerEvent } from 'react'
import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform } from 'framer-motion'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { brandSurface } from '../../../lib/concept'
import { emitCrowd } from '../../characters/crowdBus'
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

function BrandCard({ b, index }: { b: HomeBrand; index: number }) {
  const reduce = useReducedMotion()
  const meta = META[b.slug] ?? FALLBACK_META
  const surface = brandSurface(b.slug)
  const cardRef = useRef<HTMLDivElement>(null)

  // Pointer tilt — springy, only for fine pointers and full motion.
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

  const entrance = meta.elegant
    ? { initial: { opacity: 0, y: 40 }, transition: { duration: 1.1, ease: [0.22, 1, 0.36, 1], delay: 0.15 + index * 0.12 } }
    : {
        initial: { opacity: 0, y: 90, rotate: meta.tilt * 4, scale: 0.88 },
        transition: { type: 'spring' as const, stiffness: 170, damping: 13, delay: index * 0.12 },
      }

  return (
    <motion.article
      className={`${d.slot} ${meta.elegant ? d.elegant : ''}`}
      style={{ '--tilt': `${meta.tilt}deg` } as CSSProperties}
      initial={entrance.initial}
      whileInView={{ opacity: 1, y: 0, rotate: meta.tilt, scale: 1 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={reduce ? { duration: 0 } : entrance.transition}
    >
      <motion.div
        ref={cardRef}
        className={d.card}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onPointerEnter={onEnter}
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
          {brands.map((b, i) => <BrandCard key={b.id} b={b} index={i} />)}
        </div>
      </div>
    </section>
  )
}
