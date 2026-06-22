'use client'
import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Concept } from '../../lib/concept'
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
  // accents (Flipd sky blue) get black ink, dark accents (Stax purple,
  // Simmer green, servd royal blue) get white. Defaults to white when
  // we can't parse the accent (e.g. it's a CSS var name).
  const accentInk = accent.startsWith('#') && isLight(accent) ? '#0a0a0a' : 'white'
  const surface = brandSurface(concept.slug)
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
        backgroundColor: 'var(--flipd-cream)',
        backgroundImage:
          'linear-gradient(45deg, var(--flipd-ink) 25%, transparent 25%),' +
          'linear-gradient(-45deg, var(--flipd-ink) 25%, transparent 25%),' +
          'linear-gradient(45deg, transparent 75%, var(--flipd-ink) 75%),' +
          'linear-gradient(-45deg, transparent 75%, var(--flipd-ink) 75%)',
        backgroundSize: '36px 36px',
        backgroundPosition: '0 0, 0 18px, 18px -18px, -18px 0',
      }
    : { background: `linear-gradient(to bottom, ${surface.bg}F2 0%, ${surface.bg}00 100%)` }
  // The diner checker is high-contrast and shreds plain text. Instead of a
  // text outline, flipd floats its nav on light-blue "cards" (flipd-pale) with
  // a midnight-oil outline + hard drop shadow — the established flipd-card look
  // — so every label reads as flat midnight-oil ink. No-op for other brands.
  const dinerCard: React.CSSProperties = diner
    ? {
        background: 'var(--flipd-pale)',
        border: '2px solid var(--flipd-ink)',
        borderRadius: '999px',
        boxShadow: '0 3px 0 var(--flipd-ink)',
      }
    : {}

  // "Book" only appears when the brand explicitly accepts reservations.
  const acceptsReservations = concept.reservationsEnabled !== false
  const reserveLink = acceptsReservations
    ? [{ href: `/reserve/${concept.slug}`, label: 'Book' }]
    : []
  // flipd keeps the bar lean — just the useful stuff (Menu, Book, Visit). The
  // logo already covers "home" and the story lives in the footer; everything
  // else is killed. Other brands keep the fuller set.
  const links = diner
    ? [
        { href: `${base}/menu`,  label: 'Menu' },
        ...reserveLink,
        { href: `${base}/visit`, label: 'Visit' },
      ]
    : [
        { href: base,            label: 'Home' },
        { href: `${base}/menu`,  label: 'Menu' },
        { href: `${base}/about`, label: 'Story' },
        ...reserveLink,
        { href: `${base}/visit`, label: 'Visit' },
      ]

  return (
    <nav
      aria-label={`${formatBrandName(concept.name)} navigation`}
      style={{
        // Header sits at the TOP of the page and scrolls away with the content
        // (not sticky) — a top-of-page mark, not a persistent bar.
        position: 'relative',
        zIndex: 50,
        // Simmer carries the blueprint grid into the header (connects to the
        // chiller); other brands use a soft scrim of their own bg (no band).
        ...navBg,
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
          display: 'flex', alignItems: 'center', gap: '0.7rem',
          textDecoration: 'none',
          // flipd: sit the mark on a light-blue card so the wordmark reads over
          // the checker (matches the carded nav on the right).
          ...(diner ? { ...dinerCard, padding: '0.3rem 0.9rem 0.3rem 0.35rem' } : {}),
        }}>
        <span aria-hidden="true" style={{
          width: '2.5rem', height: '2.5rem',
          borderRadius: '50%',
          overflow: 'hidden',
          flexShrink: 0,
          background: accent,
          color: '#0a0a0a',
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
            : formatBrandName(concept.name).charAt(0).toUpperCase()}
        </span>
        <span style={{
          fontFamily: wordmark.font,
          fontSize: '1.6rem',
          fontWeight: wordmark.weight,
          letterSpacing: '-0.01em',
          lineHeight: 1,
          // flipd wordmark is flat midnight-oil ink on its light-blue card.
          color: diner ? 'var(--flipd-ink)' : wordmark.color,
        }}>
          {formatBrandName(concept.name)}
        </span>
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {/* Desktop nav links. flipd floats them on a light-blue card with
            midnight-oil ink so they read over the checker; other brands keep
            the plain inline row. Hidden on phones (hamburger takes over). */}
        <div
          className="hidden sm:flex"
          style={{
            alignItems: 'center',
            gap: diner ? '0.1rem' : '0.2rem',
            ...(diner ? { ...dinerCard, padding: '0.25rem 0.35rem' } : {}),
          }}
        >
          {links.map((l) => {
            const active = l.href === base
              ? pathname === l.href
              : pathname.startsWith(l.href)
            return (
              <Link
                key={l.href}
                href={l.href}
                style={{
                  padding: '0.45rem 0.9rem',
                  color: diner ? 'var(--flipd-ink)' : (active ? surface.text : surface.muted),
                  fontWeight: active ? 700 : (diner ? 600 : 500),
                  fontSize: '0.92rem',
                  textDecoration: 'none',
                  borderRadius: diner ? '999px' : '0.6rem',
                  background: diner && active ? 'rgba(9,13,23,0.12)' : 'transparent',
                  borderBottom: !diner && active ? `2px solid ${accent}` : '2px solid transparent',
                  transition: 'color 160ms ease, background 160ms ease, border-color 160ms ease',
                }}
              >
                {l.label}
              </Link>
            )
          })}

          {/* flipd: Order joins the SAME light-blue pill as the final,
              emphasized item — one pill, not a separate CTA. Bold midnight-oil
              with a curious-blue arrow so it still reads as the action. */}
          {diner && (
            <Link
              href={`/${concept.slug}`}
              aria-label={`Order from ${formatBrandName(concept.name)}`}
              style={{
                padding: '0.45rem 0.95rem',
                color: 'var(--flipd-ink)',
                fontWeight: 800,
                fontSize: '0.92rem',
                textDecoration: 'none',
                borderRadius: '999px',
                whiteSpace: 'nowrap',
              }}
            >
              Order <span style={{ color: 'var(--flipd-sky)' }}>→</span>
            </Link>
          )}
        </div>

        {/* Order CTA — non-diner brands keep it as a standalone brand-pill. */}
        {!diner && (
          <Link
            href={`/${concept.slug}`}
            aria-label={`Order from ${formatBrandName(concept.name)}`}
            className="brand-pill"
            style={{ padding: '0.55rem 1.15rem', fontSize: '0.92rem' }}
          >
            Order →
          </Link>
        )}

        {/* servd backlink — kept off flipd's lean bar (it's in the footer). */}
        {!diner && (
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
          style={{ width: '2.75rem', height: '2.75rem', marginLeft: '0.15rem', background: diner ? 'var(--flipd-pale)' : 'transparent', border: diner ? '2px solid var(--flipd-ink)' : 'none', borderRadius: diner ? '50%' : undefined, boxShadow: diner ? '0 3px 0 var(--flipd-ink)' : undefined, color: diner ? 'var(--flipd-ink)' : surface.text, cursor: 'pointer' }}
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
              <li><Link href={onBrandHost ? '/visit' : `/brand/${concept.slug}/visit`} style={linkStyle}>Find us</Link></li>
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
