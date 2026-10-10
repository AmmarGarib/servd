'use client'

// servd.kitchens — one rounded tile per kitchen in that kitchen's own palette,
// with "Order" and "Learn more". The tile styling (colours, wordmark, built-in
// art) is design, keyed by brand slug; the heading, taglines, labels and art
// image are fields, and the tiles are a list (reorder / hide).
//
// Each tile's h3 is the brand name (visually hidden text) beside the visual
// wordmark (aria-hidden), so the outline reads "Stackd / Simmer / Flipd".
// "Learn more" goes to the brand's own domain (stackd.pk), the canonical home
// of its microsite — not servd.pk/brand/<slug>, which canonicalises there.

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { Concept } from '../../lib/concept'
import { brandStory, formatBrandName } from '../../lib/concept'
import { brandCanonical, SERVD_LINK_ORIGIN } from '../../lib/brandDomains'
import { useScrollReveal } from '../../components/kinetic/motionHooks'
import type { SectionProps } from '../types'
import { list, safeSrc, str } from '../safe'
import { brandsInOrder } from './brands'
import { Chevron } from './icons'

interface TileFields {
  brand?: unknown; tagline?: unknown; orderText?: unknown; learnMoreText?: unknown
  art?: unknown; wide?: unknown; hidden?: unknown
}

export function Kitchens({ fields, ctx }: SectionProps) {
  const ref = useScrollReveal<HTMLElement>()
  const tiles = list<TileFields>(fields.tiles).filter((t) => t.hidden !== true && str(t.brand).trim())
  const brands = brandsInOrder(tiles.map((t) => str(t.brand).trim()), ctx.concepts)
  const heading = str(fields.heading)

  return (
    <section ref={ref} id="kitchens" className="sv-section" style={{ scrollMarginTop: 52 }}>
      {heading && (
        <div className="sv-wrap sv-section-head reveal-on-scroll">
          <h2 className="sv-section-title">{heading}</h2>
        </div>
      )}
      <div className="sv-tiles">
        {tiles.map((t, i) => {
          const c = brands.find((b) => b.slug === str(t.brand).trim())
          return c ? <BrandTile key={`${c.slug}-${i}`} concept={c} tile={t} onBrandHost={ctx.onBrandHost === true} /> : null
        })}
      </div>
    </section>
  )
}

/** Natural size of the bundled tile art, so the box is reserved before it
 *  loads. Owner uploads have no entry and size themselves as before. */
const BUNDLED_ART_SIZE: Record<string, { width: number; height: number }> = {
  '/brand/stackd-mascot.png': { width: 338, height: 453 },
  '/brand/flipd-badge.png': { width: 760, height: 760 },
}

function BrandTile({ concept, tile, onBrandHost }: { concept: Concept; tile: TileFields; onBrandHost: boolean }) {
  const slug = concept.slug
  const name = formatBrandName(concept.name)
  const tagline = str(tile.tagline).trim() || brandStory(slug).tagline
  const orderText = str(tile.orderText)
  const learnMoreText = str(tile.learnMoreText)
  const art = safeSrc(tile.art)
  const artSize = BUNDLED_ART_SIZE[art]
  const t = TILE[slug] ?? TILE.default!
  return (
    <article className={`sv-tile reveal-on-scroll${tile.wide === true ? ' sv-tile-wide' : ''}`}
      style={{ background: t.bg, color: t.fg }} aria-label={name}>
      {/* The heading is the brand name as text; the wordmark beside it is
          art (aria-hidden). Kept outside the h3 so the heading's text is
          exactly the name for crawlers too ("Simmer", not "simmersimmer
          down."). The wrapper carries the h3 type the marks inherited. */}
      <h3 className="sr-only">{name}</h3>
      <div className="sv-tile-name" aria-hidden style={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
        {t.mark(name)}
      </div>
      <p className="sv-tile-tag" style={{ fontFamily: t.tagFont, color: t.muted }}>
        {tagline}
      </p>
      <div className="sv-tile-ctas">
        {orderText && (
          <Link href={`${onBrandHost ? SERVD_LINK_ORIGIN : ''}/${slug}`} className="sv-btn" style={{ background: t.btnBg, color: t.btnFg }}
            aria-label={`Order from ${name}`}>
            {orderText}
          </Link>
        )}
        {learnMoreText && (
          // Cross-origin (the brand's own domain): a plain link, no prefetch.
          <a href={brandCanonical(slug)} className="sv-link" style={{ color: t.fg }}
            aria-label={`Learn more about ${name}`}>
            {learnMoreText} <Chevron />
          </a>
        )}
      </div>
      <div className="sv-tile-art" aria-hidden>
        {art
          // Below the fold: lazy, so it is not preloaded ahead of the hero.
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={art} alt="" loading="lazy" decoding="async" {...artSize} style={t.artStyle} />
          : t.codeArt ?? null}
      </div>
    </article>
  )
}

interface TileStyle {
  bg: string; fg: string; muted: string; btnBg: string; btnFg: string
  tagFont?: string
  /** The visual wordmark (rendered aria-hidden); the h3 carries the name. */
  mark: (name: string) => ReactNode
  /** How an art image sits in this brand's tile. */
  artStyle?: React.CSSProperties
  /** Built-in art when no image is set (Simmer's low sun). */
  codeArt?: ReactNode
}

const TILE: Record<string, TileStyle> = {
  // Stackd — Pantone 9180 cream field, Red Plum ink; the cream wordmark asset
  // is tinted plum with a mask, and the mascot gets the tile at full size.
  stackd: {
    bg: 'var(--stackd-cream)', fg: 'var(--stackd-plum)', muted: 'color-mix(in srgb, var(--stackd-plum) 78%, transparent)',
    btnBg: 'var(--stackd-plum)', btnFg: 'var(--stackd-cream)',
    mark: () => (
      <span style={{
        display: 'block', width: 'min(340px, 70vw)', aspectRatio: '600 / 144', background: 'var(--stackd-plum)',
        WebkitMask: 'url(/brand/stackd-wordmark.png) center / contain no-repeat',
        mask: 'url(/brand/stackd-wordmark.png) center / contain no-repeat',
      }} />
    ),
    artStyle: { maxHeight: 340, marginBottom: 32 },
  },
  // Simmer — night mode: tiber green + bone, Amarante, the wordmark lowercase
  // with "simmer down." below it. One orange signal: the low sun.
  simmer: {
    bg: 'var(--simmer-green)', fg: 'var(--simmer-bone)', muted: 'color-mix(in srgb, var(--simmer-bone) 72%, transparent)',
    btnBg: 'var(--simmer-bone)', btnFg: 'var(--simmer-green)', tagFont: 'var(--simmer-display)',
    mark: () => (
      <span style={{ display: 'block', fontFamily: 'var(--simmer-display)', fontWeight: 400 }}>
        <span style={{ display: 'block', fontSize: 'clamp(3.2rem, 7vw, 4.6rem)', letterSpacing: '0.01em' }}>simmer</span>
        <span style={{ display: 'block', fontSize: '1.05rem', marginTop: 6, opacity: 0.75 }}>simmer down.</span>
      </span>
    ),
    codeArt: <span style={{ display: 'block', width: 'min(360px, 80%)', aspectRatio: '2 / 1', background: 'var(--simmer-orange)', borderRadius: '999px 999px 0 0' }} />,
  },
  // Flipd — Smash Mustard field, Flipd Blue type; the badge is its own sticker.
  flipd: {
    bg: 'var(--flipd-mustard)', fg: 'var(--flipd-blue)', muted: 'var(--flipd-blue-dim)',
    btnBg: 'var(--flipd-blue)', btnFg: 'var(--flipd-mustard)',
    mark: (name) => (
      <span style={{ display: 'block', fontFamily: 'var(--flipd-display)', fontSize: 'clamp(3rem, 7vw, 4.4rem)', letterSpacing: '0.01em' }}>{name}</span>
    ),
    artStyle: { maxHeight: 300, marginBottom: 28 },
  },
  default: {
    bg: 'var(--servd-purple)', fg: 'var(--servd-on-purple)', muted: 'color-mix(in srgb, var(--servd-on-purple) 72%, transparent)',
    btnBg: 'var(--servd-green)', btnFg: 'var(--servd-on-green)',
    mark: (name) => <span className="sv-section-title" style={{ color: 'inherit' }}>{name}</span>,
  },
}
