'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Concept } from '../../lib/concept'
import { useBrandSlug, getServdHost } from '../../lib/host'
import { KineticShape } from '../kinetic/KineticShape'
import { isLight } from '../../lib/ui'

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
  const wrapperStyle = {
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

  // "Book" only appears when the brand explicitly accepts reservations.
  const acceptsReservations = concept.reservationsEnabled !== false
  const links = [
    { href: base,                       label: 'Home' },
    { href: `${base}/menu`,             label: 'Menu' },
    { href: `${base}/about`,            label: 'Story' },
    ...(acceptsReservations
      ? [{ href: `/reserve/${concept.slug}`, label: 'Book' }]
      : []),
    { href: `${base}/visit`,            label: 'Visit' },
  ]

  return (
    <nav
      aria-label={`${concept.name} navigation`}
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'rgba(255,255,255,0.88)',
        backdropFilter: 'blur(16px) saturate(160%)',
        WebkitBackdropFilter: 'blur(16px) saturate(160%)',
        borderBottom: '1px solid var(--servd-line)',
        padding: '0.95rem clamp(1rem, 4vw, 2rem)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
      }}
    >
      {/* Wordmark — chunky display weight, accent dot in brand colour. */}
      <Link
        href={base}
        style={{
          display: 'flex', alignItems: 'baseline', gap: '0.65rem',
          textDecoration: 'none', color: 'inherit',
        }}>
        <span aria-hidden="true" style={{
          width: '2.1rem', height: '2.1rem',
          borderRadius: '0.55rem',
          background: accent,
          color: '#0a0a0a',
          display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          fontSize: '1.05rem',
          fontWeight: 900,
          fontFamily: 'var(--font-display)',
          letterSpacing: '-0.02em',
        }}>
          {concept.name.charAt(0)}
        </span>
        <span style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.25rem',
          fontWeight: 800,
          letterSpacing: '-0.035em',
        }}>
          {concept.name}
        </span>
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
        {links.map((l) => {
          const active = l.href === base
            ? pathname === l.href
            : pathname.startsWith(l.href)
          return (
            <Link
              key={l.href}
              href={l.href}
              style={{
                padding: '0.5rem 0.95rem',
                color: active ? 'var(--servd-black)' : 'var(--servd-mute)',
                fontWeight: active ? 700 : 500,
                fontSize: '0.92rem',
                textDecoration: 'none',
                borderRadius: '0.6rem',
                borderBottom: active ? `2px solid ${accent}` : '2px solid transparent',
                transition: 'color 160ms ease, border-color 160ms ease',
              }}
              className="hidden sm:inline-block"
            >
              {l.label}
            </Link>
          )
        })}

        {/* Order CTA — uses the kinetic brand-pill so its colour tracks
            the brand. Sits right after the link group. */}
        <Link
          href={`/${concept.slug}`}
          aria-label={`Order from ${concept.name}`}
          className="brand-pill"
          style={{ padding: '0.55rem 1.15rem', fontSize: '0.92rem', marginLeft: '0.5rem' }}
        >
          Order →
        </Link>

        <Link
          href={servdHome}
          style={{
            color: 'var(--servd-dim)',
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
      </div>
    </nav>
  )
}

function BrandFooter({ concept, onBrandHost, accent }: { concept: Concept; onBrandHost: boolean; accent: string }) {
  const servdHome   = servdHref('/',       onBrandHost)
  const servdBrowse = servdHref('/browse', onBrandHost)
  return (
    <footer className="surface-ink relative overflow-hidden"
      style={{
        padding: 'clamp(4rem, 7vw, 6rem) 0 1.75rem',
        marginTop: '4rem',
      }}>
      <KineticShape variant="blob" size={320} color={accent} style={{ top: '-15%', right: '-10%' }} />
      <KineticShape variant="ring" size={140} color={accent} style={{ bottom: '15%', left: '-3%' }} spin />

      <div className="container relative z-10">
        {/* Brand-CTA banner at the top — call to action sits where the
            eye naturally lands when leaving a page. */}
        <div style={{ marginBottom: 'clamp(3rem, 5vw, 4rem)', maxWidth: '900px' }}>
          <p className="eyebrow" style={{ color: accent, marginBottom: '1rem' }}>
            {concept.name.toLowerCase()} · ready when you are
          </p>
          <h2 className="display" style={{
            fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
            color: 'white',
            marginBottom: '1.5rem',
          }}>
            Hungry?
            <span className="display-italic" style={{ color: accent }}> Let's eat.</span>
          </h2>
          <Link href={`/${concept.slug}`} className="brand-pill">
            Order from {concept.name} →
          </Link>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '2.5rem',
          paddingTop: '2.5rem',
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div>
            <div style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1.8rem',
              fontWeight: 800,
              letterSpacing: '-0.035em',
              color: 'white',
              marginBottom: '0.5rem',
            }}>
              {concept.name}
              <span style={{ color: accent }}>.</span>
            </div>
            <p style={{ fontSize: '0.95rem', color: 'rgba(255,255,255,0.55)', maxWidth: '20rem', lineHeight: 1.5 }}>
              {concept.description}
            </p>
          </div>

          <div>
            <h3 className="eyebrow" style={{ color: 'rgba(255,255,255,0.45)', marginBottom: '1rem' }}>
              {concept.name}
            </h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.7rem' }}>
              <li><Link href={onBrandHost ? '/menu'  : `/brand/${concept.slug}/menu`}  style={footerLinkStyle}>Menu</Link></li>
              <li><Link href={onBrandHost ? '/about' : `/brand/${concept.slug}/about`} style={footerLinkStyle}>Our story</Link></li>
              <li><Link href={onBrandHost ? '/visit' : `/brand/${concept.slug}/visit`} style={footerLinkStyle}>Find us</Link></li>
              <li><Link href={`/${concept.slug}`} style={footerLinkStyle}>Order online</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="eyebrow" style={{ color: 'rgba(255,255,255,0.45)', marginBottom: '1rem' }}>
              Powered by
            </h3>
            <Link href={servdHome} style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: '0.1rem',
              fontFamily: 'var(--font-display)',
              color: 'white',
              fontWeight: 800,
              fontSize: '1.8rem',
              letterSpacing: '-0.045em',
              textDecoration: 'none',
            }}>
              servd<span style={{ color: accent }}>.</span>
            </Link>
            <p style={{ fontSize: '0.86rem', color: 'rgba(255,255,255,0.55)', marginTop: '0.4rem' }}>
              One platform. Every GS Foods kitchen.
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
          borderTop: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
          fontSize: '0.78rem',
          color: 'rgba(255,255,255,0.4)',
        }}>
          <span>© {new Date().getFullYear()} {concept.name} · GS Foods Pvt. Ltd.</span>
          <Link href={servdHome} style={{ color: 'rgba(255,255,255,0.55)', textDecoration: 'none' }}>
            back to servd<span style={{ color: accent }}>.</span> →
          </Link>
        </div>
      </div>
    </footer>
  )
}

const footerLinkStyle: React.CSSProperties = {
  color: 'rgba(255,255,255,0.8)',
  textDecoration: 'none',
  fontSize: '0.95rem',
  fontWeight: 500,
}
