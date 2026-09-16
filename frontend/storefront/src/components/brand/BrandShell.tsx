'use client'
import { useState, useEffect, useMemo, type ElementType } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Concept } from '../../lib/concept'
import { locationFor } from '../../lib/brandLocations'
import { formatBrandName, brandSurface, brandWordmark } from '../../lib/concept'
import { useBrandSlug, getServdHost } from '../../lib/host'
import { isLight } from '../../lib/ui'
import { defaultBrandFooter, parseBrandFooterBlock } from '../../lib/brandFooterConfig'

// Build a link that points to the servd canonical host. On the servd host
// itself it stays relative (so client-side navigation kicks in). On a brand
// custom domain it resolves to the absolute servd URL — otherwise the link
// would loop back to the brand microsite (middleware rewrites `/` on a
// brand host to /brand/<slug>).
function servdHref(path: string, onBrandHost: boolean): string {
  if (!onBrandHost) return path
  const host = getServdHost()
  return host ? `${host}${path}` : path
}

interface Props {
  concept: Concept
  children: React.ReactNode
}

export function BrandShell({ concept, children }: Props) {
  const onBrandHost = useBrandSlug() !== null
  // Per-brand accent gets pushed onto a single wrapper so EVERY child
  // component (kinetic shapes, pills, headlines) inherits the brand's
  // colour via --brand-accent. Default to servd-green if a concept
  // doesn't define one.
  const accent = concept.primaryColor || 'var(--servd-green)'
  // Pick the text/ink colour based on luminance of the accent. Light
  // accents get black ink, dark accents (flipd blue, stackd plum, simmer
  // green, servd royal blue) get white. Defaults to white when
  // we can't parse the accent (e.g. it's a CSS var name).
  const accentInk = accent.startsWith('#') && isLight(accent) ? '#0a0a0a' : 'white'
  const surface = brandSurface(concept.slug)
  // The ?turf=muted A/B switch lived here: it overrode --flipd-sky/-green/
  // -pale/-ink so the two padel-court shade sets could be compared live.
  // That palette is gone (the brand book forbids borrowing the court's
  // identity), and with it the tokens it overrode — so the switch overrode
  // nothing. Removed rather than repointed at the blue/mustard set, which
  // has no competing shade set to compare.
  const wrapperStyle = {
    background: surface.bg,
    minHeight: '100vh',
    ['--brand-accent' as string]:      accent,
    ['--brand-accent-dark' as string]: accent,
    ['--brand-ink' as string]:         accentInk,
  } as React.CSSProperties

  return (
    <div style={wrapperStyle}>
      <BrandNav concept={concept} onBrandHost={onBrandHost} accent={accent} />
      {children}
      <BrandFooter concept={concept} onBrandHost={onBrandHost} accent={accent} />
    </div>
  )
}

function BrandNav({ concept, onBrandHost, accent }: { concept: Concept; onBrandHost: boolean; accent: string }) {
  const pathname = usePathname() ?? ''
  const base = `/brand/${concept.slug}`
  const servdHome = servdHref('/', onBrandHost)
  const [open, setOpen] = useState(false)
  const surface = brandSurface(concept.slug)
  const wordmark = brandWordmark(concept.slug)
  // Per-brand header background:
  //  • simmer extends the chiller blueprint grid into the header
  //  • flipd carries the diner checkerboard so the header is part of the tile
  //  • others use a soft scrim of their own bg colour (no band)
  const diner = concept.slug === 'flipd'
  // flipd paints its checker as a full header band. As its own box it leaves a
  // half-tile SEAM where it meets the hero checker just below. When there's no
  // announcement banner, float the header as a TRANSPARENT overlay on the hero
  // instead: the hero's checker shows through it, so the floor is one
  // continuous, seamless checker. (With a banner we keep the in-flow band.)
  const flipdOverlay = diner && !concept.announcementBanner
  const navBg: React.CSSProperties = concept.slug === 'simmer'
    ? {
        backgroundColor: surface.bg,
        backgroundImage:
          'linear-gradient(rgba(237,230,211,0.06) 1px, transparent 1px),' +
          'linear-gradient(90deg, rgba(237,230,211,0.06) 1px, transparent 1px),' +
          'linear-gradient(rgba(237,230,211,0.10) 1px, transparent 1px),' +
          'linear-gradient(90deg, rgba(237,230,211,0.10) 1px, transparent 1px)',
        backgroundSize: '40px 40px, 40px 40px, 200px 200px, 200px 200px',
      }
    : diner
    ? {
        backgroundColor: 'var(--flipd-bone)',
        backgroundImage: 'var(--flipd-checker)',
        backgroundSize: '36px 36px',
        backgroundRepeat: 'repeat',
      }
    : { background: `linear-gradient(to bottom, ${surface.bg}F2 0%, ${surface.bg}00 100%)` }
  // The diner checker is high-contrast and shreds plain text. Instead of a
  // text outline, flipd floats its nav on bone "cards" — the brand book's
  // quiet surface — outlined in Flipd Blue with a hard blue drop shadow, so
  // every label reads as flat blue ink. No-op for other brands.
  const dinerCard: React.CSSProperties = diner
    ? {
        background: 'var(--flipd-bone)',
        border: '2px solid var(--flipd-blue)',
        borderRadius: '999px',
        boxShadow: '0 3px 0 var(--flipd-blue)',
      }
    : {}

  // Carded-nav brands collapse the bar into ONE rounded pill — the lean links
  // plus Order on a single capsule. This is the flipd treatment ported to
  // simmer + stackd, in each brand's own palette: flipd keeps its high-contrast
  // bone/blue card, the dark brands get a faint glass capsule (translucent fill
  // + hairline) so labels read on their deep backgrounds.
  const pillNav = diner || concept.slug === 'simmer' || concept.slug === 'stackd'
  const pillTint = concept.slug === 'simmer' ? '243,236,222' : '197,199,204' // bone / grey
  const navPill: React.CSSProperties = diner
    ? dinerCard
    : pillNav
    ? { background: `rgba(${pillTint},0.05)`, border: `1px solid rgba(${pillTint},0.18)`, borderRadius: '999px' }
    : {}
  // Fill behind the active link inside the pill.
  const activeFill = diner ? 'rgba(9,13,23,0.12)' : pillNav ? `rgba(${pillTint},0.14)` : 'transparent'

  // "Book" only appears when the brand explicitly accepts reservations.
  const acceptsReservations = concept.reservationsEnabled !== false
  const reserveLink = acceptsReservations
    ? [{ href: `/reserve/${concept.slug}`, label: 'Book' }]
    : []
  // The carded-nav brands keep the bar lean — just the useful stuff (Menu,
  // Book, Visit). The logo already covers "home" and the story lives in the
  // footer; everything else is killed. Other brands keep the fuller set.
  // "Visit" goes straight to the operator's Google Maps link when one is
  // configured (brandLocations.mapsUrl) — opens in a new tab so the site
  // stays put. Falls back to the internal /visit page otherwise.
  const mapsUrl = locationFor(concept.slug)?.mapsUrl
  const visitLink = mapsUrl
    ? { href: mapsUrl,          label: 'Visit', external: true }
    : { href: `${base}/visit`,  label: 'Visit', external: false }
  const links = pillNav
    ? [
        { href: `${base}/menu`,  label: 'Menu',  external: false },
        ...reserveLink.map((l) => ({ ...l, external: false })),
        visitLink,
      ]
    : [
        { href: base,            label: 'Home',  external: false },
        { href: `${base}/menu`,  label: 'Menu',  external: false },
        { href: `${base}/about`, label: 'Story', external: false },
        ...reserveLink.map((l) => ({ ...l, external: false })),
        visitLink,
      ]

  return (
    <nav
      aria-label={`${formatBrandName(concept.name)} navigation`}
      style={{
        // Header sits at the TOP of the page and scrolls away with the content
        // (not sticky) — a top-of-page mark, not a persistent bar. flipd floats
        // it as a transparent overlay so the hero checker reads through it as
        // one continuous floor (no seam); other brands paint their own band.
        position: flipdOverlay ? 'absolute' : 'relative',
        ...(flipdOverlay ? { top: 0, left: 0, right: 0 } : null),
        zIndex: 50,
        // Simmer carries the blueprint grid into the header (connects to the
        // chiller); other brands use a soft scrim of their own bg (no band).
        ...(flipdOverlay ? {} : navBg),
        borderBottom: 'none',
        padding: '0.95rem clamp(1rem, 4vw, 2rem)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
      }}
    >
      {/* Brand-mark — circular logo card + brand name (brand font + colour,
          pasted on the background, no chip). Logo is a placeholder initial
          until the operator uploads a real logo. */}
      <Link
        href={base}
        aria-label={formatBrandName(concept.name)}
        style={{
          display: 'flex', alignItems: 'center', gap: diner ? 0 : '0.7rem',
          textDecoration: 'none',
          // flipd gets NO card. The badge is a die-cut stamp with its own
          // outline and its own mustard field; a rounded bone pill around a
          // square badge crops it and reads as a blob. It sits on the page
          // field directly, which is how the book uses it everywhere.
        }}>
        {/* flipd carries the real badge here rather than an initial in a disc.
            The badge already contains the wordmark — it IS the lockup — so it
            replaces both the disc and the text beside it, or the nav would say
            the brand name twice. Everyone else keeps disc + wordmark. */}
        {diner ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={concept.wordmarkUrl || '/brand/flipd-badge.png'}
            alt=""
            aria-hidden="true"
            style={{ height: 'clamp(3rem, 5vw, 3.6rem)', width: 'auto', display: 'block' }}
          />
        ) : (
        <span aria-hidden="true" style={{
          width: '2.5rem', height: '2.5rem',
          borderRadius: '50%',
          overflow: 'hidden',
          flexShrink: 0,
          // The logo disc is the one place the two brand colours meet head-on:
          // Flipd Blue field, Smash Mustard mark.
          background: diner ? 'var(--flipd-blue)' : accent,
          color: diner ? 'var(--flipd-mustard)' : '#0a0a0a',
          display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          fontSize: '1.1rem',
          fontWeight: 900,
          fontFamily: 'var(--font-display)',
          letterSpacing: '-0.02em',
          boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
        }}>
          {concept.logoUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={concept.logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            // Not force-uppercased: simmer and stackd are lowercase brands, so
            // a capital monogram breaks the same rule the wordmark follows.
            : formatBrandName(concept.name).charAt(0)}
        </span>
        )}
        {!diner && (
        <span style={{
          fontFamily: wordmark.font,
          fontSize: '1.6rem',
          fontWeight: wordmark.weight,
          letterSpacing: '-0.01em',
          lineHeight: 1,
          color: wordmark.color,
        }}>
          {formatBrandName(concept.name)}
        </span>
        )}
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {/* Desktop nav links. flipd floats them on a light-blue card with
            midnight-oil ink so they read over the checker; other brands keep
            the plain inline row. Hidden on phones (hamburger takes over). */}
        <div
          className="hidden sm:flex"
          style={{
            alignItems: 'center',
            gap: pillNav ? '0.1rem' : '0.2rem',
            ...(pillNav ? { ...navPill, padding: '0.25rem 0.35rem' } : {}),
          }}
        >
          {links.map((l) => {
            const active = !l.external && (l.href === base
              ? pathname === l.href
              : pathname.startsWith(l.href))
            // External (maps) links use a plain anchor so target/rel apply;
            // internal ones keep Next's <Link> for client-side navigation.
            const Tag: ElementType = l.external ? 'a' : Link
            const extra = l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {}
            return (
              <Tag
                key={l.href}
                href={l.href}
                {...extra}
                style={{
                  padding: '0.45rem 0.9rem',
                  color: diner ? 'var(--flipd-blue)' : (active ? surface.text : surface.muted),
                  fontWeight: active ? 700 : (pillNav ? 600 : 500),
                  fontSize: '0.92rem',
                  textDecoration: 'none',
                  borderRadius: pillNav ? '999px' : '0.6rem',
                  background: pillNav && active ? activeFill : 'transparent',
                  borderBottom: !pillNav && active ? `2px solid ${accent}` : '2px solid transparent',
                  transition: 'color 160ms ease, background 160ms ease, border-color 160ms ease',
                }}
              >
                {l.label}
              </Tag>
            )
          })}

          {/* Order joins the SAME pill as the final, emphasized item — one
              pill, not a separate CTA. Bold brand ink with an accent arrow so
              it still reads as the action (flipd green; simmer/stackd accent). */}
          {pillNav && (
            <Link
              href={`/${concept.slug}`}
              aria-label={`Order from ${formatBrandName(concept.name)}`}
              style={{
                padding: '0.45rem 0.95rem',
                color: diner ? 'var(--flipd-blue)' : surface.text,
                fontWeight: 800,
                fontSize: '0.92rem',
                textDecoration: 'none',
                borderRadius: '999px',
                whiteSpace: 'nowrap',
              }}
            >
              {/* flipd's system is two colours; there is no third signal to
                  tint the arrow with, so it stays ink like the label. */}
              Order <span style={{ color: diner ? 'var(--flipd-blue)' : accent }}>→</span>
            </Link>
          )}
        </div>

        {/* Order CTA — brands without the carded pill nav keep it as a
            standalone brand-pill. */}
        {!pillNav && (
          <Link
            href={`/${concept.slug}`}
            aria-label={`Order from ${formatBrandName(concept.name)}`}
            className="brand-pill"
            style={{ padding: '0.55rem 1.15rem', fontSize: '0.92rem' }}
          >
            Order →
          </Link>
        )}

        {/* servd backlink — kept off the lean carded bars (it's in the footer
            + the mobile sheet). */}
        {!pillNav && (
          <Link
            href={servdHome}
            style={{
              color: surface.muted,
              fontSize: '0.78rem',
              fontWeight: 600,
              letterSpacing: '0.02em',
              padding: '0.45rem 0.5rem',
              textDecoration: 'none',
            }}
            className="hidden md:inline-block"
          >
            on servd<span style={{ color: accent }}>.</span>
          </Link>
        )}

        {/* Hamburger — the link row is hidden < sm, so phones need this. */}
        <button
          type="button"
          aria-label="Menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center justify-center sm:hidden"
          style={{ width: '2.75rem', height: '2.75rem', marginLeft: '0.15rem', background: diner ? 'var(--flipd-bone)' : pillNav ? `rgba(${pillTint},0.05)` : 'transparent', border: diner ? '2px solid var(--flipd-blue)' : pillNav ? `1px solid rgba(${pillTint},0.18)` : 'none', borderRadius: pillNav ? '50%' : undefined, boxShadow: diner ? '0 3px 0 var(--flipd-blue)' : undefined, color: diner ? 'var(--flipd-blue)' : surface.text, cursor: 'pointer' }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {open
              ? <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>
              : <><path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" /></>}
          </svg>
        </button>
      </div>

      {/* Mobile dropdown — full-width sheet below the bar. */}
      {open && (
        <div
          className="sm:hidden flex flex-col"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0,
            background: surface.bg,
            borderBottom: `1px solid ${surface.border}`,
            padding: '0.4rem clamp(1rem, 4vw, 2rem) 0.9rem',
            boxShadow: '0 14px 26px rgba(0,0,0,0.35)',
          }}
        >
          {links.map((l) => {
            const active = l.href === base ? pathname === l.href : pathname.startsWith(l.href)
            return (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                style={{
                  padding: '0.85rem 0.4rem',
                  color: active ? surface.text : surface.muted,
                  fontWeight: active ? 700 : 500,
                  fontSize: '1rem',
                  textDecoration: 'none',
                  borderBottom: `1px solid ${surface.border}`,
                }}
              >
                {l.label}
              </Link>
            )
          })}
          <Link
            href={servdHome}
            onClick={() => setOpen(false)}
            style={{ padding: '0.85rem 0.4rem', color: surface.muted, fontSize: '0.85rem', fontWeight: 600, textDecoration: 'none' }}
          >
            on servd<span style={{ color: accent }}>.</span>
          </Link>
        </div>
      )}
    </nav>
  )
}

function BrandFooter({ concept, onBrandHost, accent }: { concept: Concept; onBrandHost: boolean; accent: string }) {
  const servdHome   = servdHref('/',       onBrandHost)
  const servdBrowse = servdHref('/browse', onBrandHost)

  // Operator-editable footer copy + socials (Admin → Storefront → Brand
  // Footers), stored as a SiteLayout `brand:<slug>:footer`. Defaults derive
  // from the concept so an un-configured brand looks exactly as before.
  const fallback = useMemo(() => defaultBrandFooter(concept), [concept])
  const [cfg, setCfg] = useState(fallback)
  useEffect(() => {
    let alive = true
    const base = process.env['NEXT_PUBLIC_API_URL'] ?? ''
    fetch(`${base}/api/v1/site-layouts/brand:${encodeURIComponent(concept.slug)}:footer`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { blocks?: unknown } | null) => {
        if (alive && body) setCfg(parseBrandFooterBlock(body.blocks, fallback))
      })
      .catch(() => { /* keep defaults */ })
    return () => { alive = false }
  }, [concept.slug, fallback])

  const socials = [
    { key: 'instagram', label: 'Instagram', href: cfg.social.instagram },
    { key: 'tiktok',    label: 'TikTok',    href: cfg.social.tiktok },
    { key: 'facebook',  label: 'Facebook',  href: cfg.social.facebook },
    { key: 'whatsapp',  label: 'WhatsApp',  href: cfg.social.whatsapp },
  ].filter((s) => s.href)

  const surface = brandSurface(concept.slug)
  const linkStyle: React.CSSProperties = {
    color: surface.text, opacity: 0.85, textDecoration: 'none', fontSize: '0.95rem', fontWeight: 500,
  }

  return (
    <footer className="relative overflow-hidden"
      style={{
        padding: 'clamp(4rem, 7vw, 6rem) 0 1.75rem',
        marginTop: '4rem',
        color: surface.text,
      }}>
      <div className="container relative z-10">
        {/* Brand-CTA banner at the top — call to action sits where the
            eye naturally lands when leaving a page. */}
        <div style={{ marginBottom: 'clamp(3rem, 5vw, 4rem)', maxWidth: '900px' }}>
          <p className="eyebrow" style={{ color: accent, marginBottom: '1rem' }}>
            {cfg.ctaEyebrow}
          </p>
          <h2 className="display" style={{
            fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
            color: surface.text,
            marginBottom: '1.5rem',
          }}>
            {cfg.ctaHeadline}
            <span className="display-italic" style={{ color: accent }}> {cfg.ctaAccent}</span>
          </h2>
          <Link href={`/${concept.slug}`} className="brand-pill">
            Order from {formatBrandName(concept.name)} →
          </Link>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '2.5rem',
          paddingTop: '2.5rem',
          borderTop: `1px solid ${surface.border}`,
        }}>
          <div>
            <div style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1.8rem',
              fontWeight: 800,
              letterSpacing: '-0.035em',
              color: surface.text,
              marginBottom: '0.5rem',
            }}>
              {formatBrandName(concept.name)}
              <span style={{ color: accent }}>.</span>
            </div>
            <p style={{ fontSize: '0.95rem', color: surface.muted, maxWidth: '20rem', lineHeight: 1.5 }}>
              {cfg.tagline}
            </p>
            {socials.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.9rem', marginTop: '1.1rem' }}>
                {socials.map((s) => (
                  <a key={s.key} href={s.href} target="_blank" rel="noreferrer"
                    style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: surface.muted, textDecoration: 'none' }}>
                    {s.label}
                  </a>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="eyebrow" style={{ color: surface.muted, marginBottom: '1rem' }}>
              {formatBrandName(concept.name)}
            </h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.7rem' }}>
              <li><Link href={onBrandHost ? '/menu'  : `/brand/${concept.slug}/menu`}  style={linkStyle}>Menu</Link></li>
              <li><Link href={onBrandHost ? '/about' : `/brand/${concept.slug}/about`} style={linkStyle}>Our story</Link></li>
              {/* "Find us" → the operator's Google Maps link when configured
                  (same source as the nav's Visit), else the internal page. */}
              <li>
                {(() => {
                  // Own lookup: this footer is a separate component from the
                  // nav, so the nav's mapsUrl isn't in scope here.
                  const m = locationFor(concept.slug)?.mapsUrl
                  return m
                    ? <a href={m} target="_blank" rel="noopener noreferrer" style={linkStyle}>Find us</a>
                    : <Link href={onBrandHost ? '/visit' : `/brand/${concept.slug}/visit`} style={linkStyle}>Find us</Link>
                })()}
              </li>
              <li><Link href={`/${concept.slug}`} style={linkStyle}>Order online</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="eyebrow" style={{ color: surface.muted, marginBottom: '1rem' }}>
              Powered by
            </h3>
            <Link href={servdHome} style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: '0.1rem',
              fontFamily: 'var(--font-display)',
              color: surface.text,
              fontWeight: 800,
              fontSize: '1.8rem',
              letterSpacing: '-0.045em',
              textDecoration: 'none',
            }}>
              servd<span style={{ color: accent }}>.</span>
            </Link>
            <p style={{ fontSize: '0.86rem', color: surface.muted, marginTop: '0.4rem' }}>
              One platform. Every kitchen.
            </p>
            <Link href={servdBrowse} className="kinetic-caret" style={{
              display: 'inline-block',
              marginTop: '1rem',
              color: accent,
              fontWeight: 700,
              fontSize: '0.9rem',
              textDecoration: 'none',
            }}>
              See all kitchens
            </Link>
          </div>
        </div>

        <div style={{
          marginTop: '3rem',
          paddingTop: '1.25rem',
          borderTop: `1px solid ${surface.border}`,
          display: 'flex',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
          fontSize: '0.78rem',
          color: surface.muted,
        }}>
          <span>© {new Date().getFullYear()} {formatBrandName(concept.name)} · GS Foods Pvt. Ltd.</span>
          <Link href={servdHome} style={{ color: surface.muted, textDecoration: 'none' }}>
            back to servd<span style={{ color: accent }}>.</span> →
          </Link>
        </div>
      </div>
    </footer>
  )
}
