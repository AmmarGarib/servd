'use client'
import Link from 'next/link'
import { useEffect, useRef } from 'react'
import type { HeroConfig } from '../lib/heroConfig'
import type { Concept } from '../lib/concept'
import { brandStory, formatBrandName } from '../lib/concept'
import { FALLBACK_CONCEPTS } from '../lib/fallbackBrands'
import { useScrollReveal } from './kinetic/motionHooks'
import { OpenNowPill } from './brand/parts/OpenNowPill'
import { BRAND_LOCATIONS, locationFor, whatsappLink } from '../lib/brandLocations'
import { openSearch } from './SearchSheet'

// servd home — the one consumer landing page, at /home (`/` and `/browse`
// redirect here). Apple-style: big centred type, lots of air, a full-bleed
// media panel, then one rounded tile per kitchen in that kitchen's own palette
// with two actions ("Order" and "Learn more"). Search lives in the nav sheet.
//
// The hero text + media are operator-editable (Admin → Storefront, SiteLayout
// `servd:hero`); the whole page can be wrapped by a live `servd:home` layout,
// whose `signature` block renders this component.

interface Props {
  concepts: Concept[]
  heroConfig: HeroConfig
}

const ORDER = ['stackd', 'simmer', 'flipd']

export function HomeClient({ concepts, heroConfig }: Props) {
  const pageRef = useScrollReveal<HTMLDivElement>()

  // Live brands in the fixed order; API down → the shared fallback records.
  const live = concepts.filter((c) => ORDER.includes(c.slug))
  const bySlug = new Map((live.length > 0 ? live : Object.values(FALLBACK_CONCEPTS)).map((c) => [c.slug, c]))
  const brands = ORDER.map((s) => bySlug.get(s)).filter((c): c is Concept => !!c)

  // /home?q=… (the sitelinks search box in JSON-LD) opens the search sheet.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q')
    if (q) openSearch(q)
  }, [])

  return (
    <div ref={pageRef} className="sv-home">
      <Hero config={heroConfig} />

      {/* ── The kitchens ─────────────────────────────────────────────── */}
      <section id="kitchens" className="sv-section" style={{ scrollMarginTop: 52 }}>
        <div className="sv-wrap sv-section-head reveal-on-scroll">
          <h2 className="sv-section-title">Three kitchens. Pick one, or all of them.</h2>
        </div>
        <div className="sv-tiles">
          {brands.map((c) => <BrandTile key={c.slug} concept={c} />)}
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <section className="sv-section">
        <div className="sv-wrap">
          <div className="sv-section-head reveal-on-scroll">
            <h2 className="sv-section-title">One order. Every kitchen.</h2>
          </div>
          <div className="sv-trio reveal-on-scroll">
            <div>
              <div className="sv-trio-icon" aria-hidden><IconStack /></div>
              <h3>Mix kitchens.</h3>
              <p>Add a Stackd pastry to a Flipd order. One cart, one checkout.</p>
            </div>
            <div>
              <div className="sv-trio-icon" aria-hidden><IconClock /></div>
              <h3>Timed together.</h3>
              <p>We hold the quickest dish for the slowest, so everything lands as it should.</p>
            </div>
            <div>
              <div className="sv-trio-icon" aria-hidden><IconStar /></div>
              <h3>Rewarded everywhere.</h3>
              <p>Insiders earn on every order, at every kitchen.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Insiders ─────────────────────────────────────────────────── */}
      <section id="insiders" className="sv-band" style={{ scrollMarginTop: 64 }}>
        <div className="sv-wrap">
          <div className="sv-section-head reveal-on-scroll" style={{ marginBottom: 0 }}>
            <h2 className="sv-section-title">The best stuff doesn&rsquo;t get listed.</h2>
            <p className="sv-sub">Limited drops, off-menu plates and points on every order. Insiders hear first. Free to join.</p>
            <div className="sv-ctas">
              <Link href="/signup?insider=1" className="sv-btn sv-btn-primary">Join Insiders</Link>
              <a href={whatsappLink(BRAND_LOCATIONS['simmer']!, 'add me to servd insiders')}
                target="_blank" rel="noopener noreferrer" className="sv-link">
                Join on WhatsApp <Chevron />
              </a>
            </div>
          </div>
          <div className="sv-perks reveal-on-scroll">
            {PERKS.map((p) => (
              <div key={p.tag} className="sv-perk">
                <p className="sv-perk-tag">{p.tag}</p>
                <h3>{p.head}</h3>
                <p>{p.body}</p>
              </div>
            ))}
          </div>
          <p style={{ textAlign: 'center', marginTop: 28 }}>
            <Link href="/login" className="sv-link">Already a member? Sign in <Chevron /></Link>
          </p>
        </div>
      </section>

      {/* ── Visit ────────────────────────────────────────────────────── */}
      <section id="visit" className="sv-section" style={{ scrollMarginTop: 52 }}>
        <div className="sv-wrap">
          <div className="sv-section-head reveal-on-scroll">
            <h2 className="sv-section-title">Come by.</h2>
          </div>
          <div className="sv-visit reveal-on-scroll">
            {brands.map((c) => {
              const name = formatBrandName(c.name)
              const loc = locationFor(c.slug)
              const email = c.email || loc?.email
              return (
                <div key={c.slug} className="sv-visit-card">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <h3>{name}</h3>
                    <span style={{ marginLeft: 'auto' }}><OpenNowPill slug={c.slug} fallback="Karachi" /></span>
                  </div>
                  {loc && !loc.area.startsWith('TODO') && <p>{loc.area}, {loc.city}</p>}
                  <div className="sv-visit-links">
                    <Link href={`/${c.slug}`} className="sv-link">Order <Chevron /></Link>
                    {loc && (
                      <a href={whatsappLink(loc, `hi ${name}`)} target="_blank" rel="noopener noreferrer" className="sv-link">
                        WhatsApp <Chevron />
                      </a>
                    )}
                    {email && <a href={`mailto:${email}`} className="sv-link">Email <Chevron /></a>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* ── What's next (waitlist) ───────────────────────────────────── */}
      <section className="sv-next">
        <div className="sv-wrap reveal-on-scroll">
          <h2 className="sv-section-title">There&rsquo;s another kitchen coming.</h2>
          <p>Be the first to know when it opens.</p>
          <div className="sv-ctas" style={{ marginTop: 20 }}>
            <Link href="/waitlist" className="sv-link">Join the waitlist <Chevron /></Link>
          </div>
        </div>
      </section>
    </div>
  )
}

function Hero({ config }: { config: HeroConfig }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  // Respect reduced motion: show the poster frame instead of playing.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) v.pause()
    else v.play().catch(() => { /* autoplay blocked — the poster stays */ })
  }, [])

  return (
    <>
      <section className="sv-hero sv-wrap">
        <h1 className="sv-headline">{config.title}</h1>
        {config.overview && <p className="sv-sub">{config.overview}</p>}
        <div className="sv-ctas">
          <a href="#kitchens" className="sv-btn sv-btn-primary">Order now</a>
          <button type="button" className="sv-link" style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }}
            onClick={() => openSearch('')}>
            Search the menus <Chevron />
          </button>
        </div>
      </section>
      {config.mediaSrc && (
        <div className="sv-media">
          <div className="sv-media-frame">
            {config.mediaType === 'video' ? (
              <video ref={videoRef} src={config.mediaSrc} poster={config.posterSrc}
                muted loop playsInline preload="metadata" aria-hidden />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={config.mediaSrc} alt="" />
            )}
          </div>
        </div>
      )}
    </>
  )
}

// ── Brand tiles — each kitchen in its own palette ─────────────────────────

function BrandTile({ concept }: { concept: Concept }) {
  const slug = concept.slug
  const name = formatBrandName(concept.name)
  const story = brandStory(slug)
  const t = TILE[slug] ?? TILE.default!
  return (
    <article className={`sv-tile reveal-on-scroll${slug === 'stackd' ? ' sv-tile-wide' : ''}`}
      style={{ background: t.bg, color: t.fg }} aria-label={name}>
      <h3 className="sv-tile-name">{t.mark(name)}</h3>
      <p className="sv-tile-tag" style={{ fontFamily: t.tagFont, color: t.muted }}>
        {story.tagline}
      </p>
      <div className="sv-tile-ctas">
        <Link href={`/${slug}`} className="sv-btn" style={{ background: t.btnBg, color: t.btnFg }}
          aria-label={`Order from ${name}`}>
          Order
        </Link>
        <Link href={`/brand/${slug}`} className="sv-link" style={{ color: t.fg }}
          aria-label={`Learn more about ${name}`}>
          Learn more <Chevron />
        </Link>
      </div>
      <div className="sv-tile-art" aria-hidden>{t.art}</div>
    </article>
  )
}

interface TileStyle {
  bg: string; fg: string; muted: string; btnBg: string; btnFg: string
  tagFont?: string
  mark: (name: string) => React.ReactNode
  art: React.ReactNode
}

const TILE: Record<string, TileStyle> = {
  // Stackd — Pantone 9180 cream field, Red Plum ink; the cream wordmark asset
  // is tinted plum with a mask, and the mascot gets the tile at full size.
  stackd: {
    bg: 'var(--stackd-cream)', fg: 'var(--stackd-plum)', muted: 'color-mix(in srgb, var(--stackd-plum) 78%, transparent)',
    btnBg: 'var(--stackd-plum)', btnFg: 'var(--stackd-cream)',
    mark: (name) => (
      <span role="img" aria-label={name} style={{
        display: 'block', width: 'min(340px, 70vw)', aspectRatio: '600 / 144', background: 'var(--stackd-plum)',
        WebkitMask: 'url(/brand/stackd-wordmark.png) center / contain no-repeat',
        mask: 'url(/brand/stackd-wordmark.png) center / contain no-repeat',
      }} />
    ),
    // eslint-disable-next-line @next/next/no-img-element
    art: <img src="/brand/stackd-mascot.png" alt="" style={{ maxHeight: 340, marginBottom: 32 }} />,
  },
  // Simmer — night mode: tiber green + bone, Amarante, the wordmark lowercase
  // with "simmer down." below it. One orange signal: the low sun.
  simmer: {
    bg: 'var(--simmer-green)', fg: 'var(--simmer-bone)', muted: 'color-mix(in srgb, var(--simmer-bone) 72%, transparent)',
    btnBg: 'var(--simmer-bone)', btnFg: 'var(--simmer-green)', tagFont: 'var(--simmer-display)',
    mark: (name) => (
      <span role="img" aria-label={name} style={{ display: 'block', fontFamily: 'var(--simmer-display)', fontWeight: 400 }}>
        <span style={{ display: 'block', fontSize: 'clamp(3.2rem, 7vw, 4.6rem)', letterSpacing: '0.01em' }}>simmer</span>
        <span style={{ display: 'block', fontSize: '1.05rem', marginTop: 6, opacity: 0.75 }}>simmer down.</span>
      </span>
    ),
    art: <span style={{ display: 'block', width: 'min(360px, 80%)', aspectRatio: '2 / 1', background: 'var(--simmer-orange)', borderRadius: '999px 999px 0 0' }} />,
  },
  // Flipd — Smash Mustard field, Flipd Blue type; the badge is its own sticker.
  flipd: {
    bg: 'var(--flipd-mustard)', fg: 'var(--flipd-blue)', muted: 'var(--flipd-blue-dim)',
    btnBg: 'var(--flipd-blue)', btnFg: 'var(--flipd-mustard)',
    mark: (name) => (
      <span style={{ display: 'block', fontFamily: 'var(--flipd-display)', fontSize: 'clamp(3rem, 7vw, 4.4rem)', letterSpacing: '0.01em' }}>{name}</span>
    ),
    // eslint-disable-next-line @next/next/no-img-element
    art: <img src="/brand/flipd-badge.png" alt="" style={{ maxHeight: 300, marginBottom: 28 }} />,
  },
  default: {
    bg: 'var(--servd-purple)', fg: 'var(--servd-on-purple)', muted: 'color-mix(in srgb, var(--servd-on-purple) 72%, transparent)',
    btnBg: 'var(--servd-green)', btnFg: 'var(--servd-on-green)',
    mark: (name) => <span className="sv-section-title" style={{ color: 'inherit' }}>{name}</span>,
    art: null,
  },
}

// Per-brand Insiders perks — Simmer gets recognition (no points, no coupon
// language); Stackd and Flipd get a plain points mechanic.
const PERKS = [
  { tag: 'Simmer · regulars', head: 'The regulars’ list',
    body: 'First word on the next menu. A held table when the room is full. Now and then the kitchen sends something out.' },
  { tag: 'Stackd · counter club', head: 'Five coffees in, the sixth is ours.',
    body: 'Buy five drinks and the sixth is on the house. First look at the pastry case before the morning bake goes out.' },
  { tag: 'Flipd · points', head: 'Points on every box.',
    body: '1 point per Rs. 10. Free weekday lunch delivery for members. Redeem 2,000 points for a meal.' },
]

// ── Icons (SVG, never emoji) ──────────────────────────────────────────────

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ marginTop: 1 }}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}
function IconStack() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" />
    </svg>
  )
}
function IconClock() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  )
}
function IconStar() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3z" />
    </svg>
  )
}
