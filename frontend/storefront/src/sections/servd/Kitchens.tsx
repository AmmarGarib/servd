'use client'

// servd.kitchens — the kitchens as a hand of oversized trading cards.
//
// A port of Hasham's BrandDeck (playful-arena/team-b), rebuilt without
// framer-motion and without his game hooks (sticker tin, sounds, crowd
// characters, session flip memory, touch peek, live open/closed status).
// Motion is CSS: a slap-in entrance when the section scrolls into view, a
// static resting tilt per card, and a pointer tilt + glare that a small
// handler writes into CSS variables (no per-frame React state). Reduced
// motion = no tilt, no sway, and the flip becomes a cross-fade (.calm).
//
// Each card is its brand's own colours (brandSurface + the META below, design
// keyed by slug) inside the servd ink border + hard offset shadow. The
// '/slug' tab is a real button that flips the card to a stat block built from
// the brand's own highlights and hours. Two links per front, stretched-link
// pattern: the name goes to the brand's own domain, "Order from X" sits above
// it and goes to /<slug>.
//
// Fields: eyebrow, heading (last line of 2+ lines is the italic accent),
// lead, note, backLabel, hoursLabel, backFoot, flipBackText, tiles[]
// (brand, kind, tagline, highlights, photo, art, orderText, learnMoreText,
// hidden). Old stored blocks lack the new keys: a missing key takes the
// default, an explicit '' hides/clears it.

import Link from 'next/link'
import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import type { Concept } from '../../lib/concept'
import { brandStory, brandSurface, conceptHeroImage, formatBrandName } from '../../lib/concept'
import { brandCanonical, SERVD_LINK_ORIGIN } from '../../lib/brandDomains'
import { useScrollReveal } from '../../components/kinetic/motionHooks'
import type { SectionProps } from '../types'
import { list, safeSrc, str } from '../safe'
import { brandsInOrder } from './brands'
import { hoursSummary } from './brandFacts'
import d from './deck.module.css'

interface TileFields {
  brand?: unknown; kind?: unknown; tagline?: unknown; highlights?: unknown; photo?: unknown
  art?: unknown; orderText?: unknown; learnMoreText?: unknown; hidden?: unknown
}

interface CardMeta {
  kind: string
  tab: { bg: string; fg: string }
  /** The back face: the brand's own colours as a stat-card ground. */
  back: { bg: string; fg: string; rule: string }
  tilt: number
  elegant?: boolean
}

const META: Record<string, CardMeta> = {
  stackd: {
    kind: 'scratch café · market',
    tab: { bg: 'var(--stackd-cream)', fg: 'var(--stackd-plum)' },
    back: { bg: 'var(--stackd-plum)', fg: 'var(--stackd-cream)', rule: 'var(--stackd-sky, #9BD3DD)' },
    tilt: -2.5,
  },
  simmer: {
    kind: 'small plates · mocktails',
    tab: { bg: 'var(--simmer-bone)', fg: 'var(--simmer-green)' },
    back: { bg: 'var(--simmer-green)', fg: 'var(--simmer-bone)', rule: 'var(--simmer-orange)' },
    tilt: 0,
    elegant: true,
  },
  flipd: {
    kind: 'smash burgers',
    tab: { bg: 'var(--flipd-mustard)', fg: 'var(--flipd-blue)' },
    back: { bg: 'var(--flipd-blue)', fg: 'var(--flipd-mustard)', rule: 'var(--flipd-bone, #F9F0E1)' },
    tilt: 2.5,
  },
}

const FALLBACK_META: CardMeta = {
  kind: 'kitchen',
  tab: { bg: 'var(--servd-surface)', fg: 'var(--servd-black)' },
  back: { bg: 'var(--servd-purple)', fg: 'var(--servd-on-purple)', rule: 'var(--servd-green)' },
  tilt: 0,
}

/** Natural size of the bundled sticker art; owner uploads have no entry. */
const BUNDLED_ART: Record<string, { width: number; height: number; badge: boolean }> = {
  '/brand/stackd-mascot.png': { width: 338, height: 453, badge: false },
  '/brand/flipd-badge.png': { width: 760, height: 760, badge: true },
}

/** A missing key takes the default; an explicit '' stays '' (hidden). */
function opt(v: unknown, def: string): string {
  return typeof v === 'string' ? v : def
}

function linesOf(v: unknown): string[] {
  return str(v).split('\n').map((l) => l.trim()).filter(Boolean)
}

export function Kitchens({ fields, ctx }: SectionProps) {
  const titleId = useId()
  const ref = useScrollReveal<HTMLElement>()
  const tiles = list<TileFields>(fields.tiles).filter((t) => t.hidden !== true && str(t.brand).trim())
  const brands = brandsInOrder(tiles.map((t) => str(t.brand).trim()), ctx.concepts)

  const eyebrow = opt(fields.eyebrow, '')
  const lead = opt(fields.lead, '')
  const note = opt(fields.note, '')
  const backLabel = opt(fields.backLabel, 'kitchen stats')
  const hoursLabel = opt(fields.hoursLabel, 'hours')
  const backFoot = opt(fields.backFoot, 'collect all three')
  const flipBackText = opt(fields.flipBackText, 'flip back')
  const headLines = linesOf(fields.heading)
  const accent = headLines.length >= 2 ? headLines[headLines.length - 1] : ''
  const plain = headLines.length >= 2 ? headLines.slice(0, -1) : headLines

  let n = 0
  return (
    <section ref={ref} id="kitchens" className={d.section} style={{ scrollMarginTop: 52 }} aria-labelledby={headLines.length ? titleId : undefined}>
      <svg aria-hidden className={d.bgStar} viewBox="0 0 40 40"><path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" /></svg>
      <div className={d.wrap}>
        {(eyebrow || headLines.length > 0 || lead || note) && (
        <header className={`${d.head} reveal-on-scroll`}>
          <div>
            {eyebrow && <p className={d.eyebrow}>{eyebrow}</p>}
            {headLines.length > 0 && (
              <h2 id={titleId} className={d.h2}>
                {plain.map((l, i) => (<span key={i}>{l}{(i < plain.length - 1 || accent) && <br />}</span>))}
                {accent && <em>{accent}</em>}
              </h2>
            )}
            {lead && <p className={d.lead}>{lead}</p>}
          </div>
          {note && (
            <p className={d.note} aria-hidden>
              <span>{note}</span>
              <svg viewBox="0 0 120 80"><path d="M8 10 C 40 4, 88 14, 96 46 M84 36 L97 50 L108 34" /></svg>
            </p>
          )}
        </header>
        )}

        <div className={d.grid}>
          {tiles.map((t, i) => {
            const c = brands.find((b) => b.slug === str(t.brand).trim())
            if (!c) return null
            const index = n++
            return (
              <BrandCard
                key={`${c.slug}-${i}`}
                concept={c}
                tile={t}
                index={index}
                onBrandHost={ctx.onBrandHost === true}
                labels={{ backLabel, hoursLabel, backFoot, flipBackText }}
              />
            )
          })}
        </div>
      </div>
    </section>
  )
}

function BrandCard({ concept, tile, index, onBrandHost, labels }: {
  concept: Concept
  tile: TileFields
  index: number
  onBrandHost: boolean
  labels: { backLabel: string; hoursLabel: string; backFoot: string; flipBackText: string }
}) {
  const slug = concept.slug
  const meta = META[slug] ?? FALLBACK_META
  const isQuiet = !!meta.elegant
  const surface = brandSurface(slug)
  const name = formatBrandName(concept.name)
  const kind = str(tile.kind).trim() || meta.kind
  const tagline = str(tile.tagline).trim() || brandStory(slug).tagline
  const own = linesOf(tile.highlights)
  const highlights = (own.length ? own : brandStory(slug).highlights).slice(0, 3)
  const photo = safeSrc(tile.photo) || conceptHeroImage(concept, 'card') || ''
  const art = safeSrc(tile.art)
  const bundled = BUNDLED_ART[art]
  const orderText = str(tile.orderText).replaceAll('{name}', name).trim()
  const learnMoreText = str(tile.learnMoreText).replaceAll('{name}', name).trim()
  const hours = hoursSummary(concept.serviceHours)
  const orderHref = `${onBrandHost ? SERVD_LINK_ORIGIN : ''}/${slug}`
  const lc = (v: string) => (isQuiet ? v.toLowerCase() : v)

  const cardRef = useRef<HTMLDivElement>(null)
  const frontRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLDivElement>(null)
  const tabRef = useRef<HTMLButtonElement>(null)
  const flipBackRef = useRef<HTMLButtonElement>(null)
  const flipIntent = useRef<'none' | 'toBack' | 'toFront'>('none')
  const [flipped, setFlipped] = useState(false)
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  // The hidden face is inert, and focus follows the flip so keyboard users
  // land on the face they can see.
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

  const strength = isQuiet ? 5 : 11
  function onMove(e: PointerEvent<HTMLDivElement>) {
    if (reduced || e.pointerType !== 'mouse') return
    const el = cardRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    el.style.setProperty('--ry', `${((px - 0.5) * 2 * strength).toFixed(2)}deg`)
    el.style.setProperty('--rx', `${(-(py - 0.5) * 2 * strength * 0.8).toFixed(2)}deg`)
    el.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`)
    el.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`)
  }
  function onLeave() {
    const el = cardRef.current
    if (!el) return
    el.style.setProperty('--rx', '0deg')
    el.style.setProperty('--ry', '0deg')
    el.style.setProperty('--gx', '50%')
    el.style.setProperty('--gy', '50%')
  }

  function flipTo(next: boolean) {
    flipIntent.current = next ? 'toBack' : 'toFront'
    setFlipped(next)
  }
  function onTab(e: MouseEvent<HTMLButtonElement>) {
    // The tab sits over the card's stretched link — never let it navigate.
    e.preventDefault()
    e.stopPropagation()
    flipTo(!flipped)
  }

  const slotStyle = { '--tilt': `${meta.tilt}deg`, '--i': index } as CSSProperties
  const cardStyle = {
    '--text': surface.text,
    '--surface': surface.bg,
    '--back-bg': meta.back.bg,
    '--back-fg': meta.back.fg,
    '--back-rule': meta.back.rule,
  } as CSSProperties

  const nameInner = slug === 'stackd'
    ? (
      <>
        <span aria-hidden className={d.wordmark} />
        <span className="sr-only">{name}</span>
      </>
    )
    : name

  return (
    <article className={`${d.slot} ${isQuiet ? d.elegant : ''} reveal-on-scroll`} style={slotStyle}>
      <div
        ref={cardRef}
        className={`${d.card} ${reduced ? d.calm : ''}`}
        data-flipped={flipped || undefined}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        style={cardStyle}
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
            aria-label={`Flip the ${name} card`}
            aria-pressed={flipped}
            onClick={onTab}
          >
            /{slug}
            <svg aria-hidden viewBox="0 0 16 16" className={d.tabIcon} focusable="false">
              <path d="M3 6.5a5 5 0 0 1 9-1.5M13 9.5a5 5 0 0 1-9 1.5M12 2v3h-3M4 14v-3h3" />
            </svg>
          </button>

          <div className={d.photo}>
            {photo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo} alt="" loading="lazy" decoding="async" width={1200} height={960} />
            )}
            <span className={d.num} aria-hidden>No. 0{index + 1}</span>
            <span className={d.kind} aria-hidden>{kind}</span>
            {isQuiet && <span aria-hidden className={d.candle} />}
          </div>

          {art && (
            <span aria-hidden className={`${d.sticker} ${bundled?.badge ? d.stickerBadge : d.stickerMascot}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="" aria-hidden src={art} width={bundled?.width} height={bundled?.height} loading="lazy" decoding="async" />
            </span>
          )}

          <div className={d.body}>
            <h3 className={d.name}>
              {learnMoreText ? (
                // Cross-origin (the brand's own domain): a plain link.
                <a href={brandCanonical(slug)} className={d.stretch} aria-label={learnMoreText}>{nameInner}</a>
              ) : nameInner}
            </h3>
            {isQuiet && <span aria-hidden className={d.hairline} />}
            <p className={d.tagline}>{tagline}</p>
            {highlights.length > 0 && (
              <ul className={d.chips} aria-label={`${name} highlights`}>
                {highlights.map((h, i) => <li key={i}>{h}</li>)}
              </ul>
            )}
            <div className={d.actions}>
              {orderText && (
                <Link
                  href={orderHref}
                  className={isQuiet ? d.orderQuiet : `sv-btn ${d.order}`}
                >
                  {isQuiet ? orderText.toLowerCase() : orderText}
                  <ArrowRight aria-hidden size={18} strokeWidth={2.6} />
                </Link>
              )}
              {learnMoreText && (
                <span aria-hidden className={d.visit}>
                  <ArrowUpRight size={20} strokeWidth={2.4} />
                </span>
              )}
            </div>
          </div>

          <span aria-hidden className={d.glare} />
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
            /{slug}
          </span>
          <div className={d.backHead}>
            <span className={d.backNum}>{lc(`No. 0${index + 1}`)}</span>
            <span className={d.backKind}>{kind}</span>
          </div>
          <p className={d.backName}>{name}</p>
          <span aria-hidden className={d.backRule} />
          {labels.backLabel && <p className={d.backLabel}>{labels.backLabel}</p>}
          <ul className={d.stats}>
            {highlights.map((h, i) => (
              <li key={i}>
                <span className={d.statKey} aria-hidden>{String(i + 1).padStart(2, '0')}</span>
                <span className={d.statVal}>{lc(h)}</span>
              </li>
            ))}
            {hours && (
              <li>
                <span className={d.statKey}>{labels.hoursLabel}</span>
                <span className={d.statVal}>{lc(hours)}</span>
              </li>
            )}
          </ul>
          {labels.backFoot && <p className={d.backFoot}>{labels.backFoot}</p>}
          <div className={d.backActions}>
            <button
              ref={flipBackRef}
              type="button"
              className={d.flipBack}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                flipTo(false)
              }}
            >
              {labels.flipBackText || 'flip back'}
            </button>
            {orderText && (
              <Link href={orderHref} className={d.backOrder}>
                {isQuiet ? orderText.toLowerCase() : orderText}
                <ArrowRight aria-hidden size={16} strokeWidth={2.6} />
              </Link>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}
