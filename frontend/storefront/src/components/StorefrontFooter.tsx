'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useOnBrandMicrosite } from '../lib/host'

// Live brands only — the long historical list (Strata, Craveman, Garnish
// Station, Stackd@Padel) lived in the footer when they had no concept rows,
// promising the customer kitchens they couldn't actually order from. Pulled
// down to match the live state on the home page. Add back when their
// concept rows + microsites land.
// Accents match the canonical per-brand palette (lib/concept BRAND_ACCENT_OVERRIDES).
const BRANDS = [
  { slug: 'stackd', name: 'Stackd', accent: '#FCE8CE' },
  { slug: 'simmer', name: 'Simmer', accent: '#E94E1B' },
  { slug: 'flipd',  name: 'Flipd',  accent: '#2092E9' },
]

export function StorefrontFooter({ initialBrandSlug = null }: { initialBrandSlug?: string | null }) {
  // Brand microsites render their own BrandFooter (via BrandShell); the global
  // servd footer must hide there or those pages show two footers.
  //
  // The /brand/* path test alone was not enough. On a brand's OWN domain the
  // browser's path is "/", so every microsite page was ending with servd's
  // footer stacked under the brand's — 664px of it on desktop, carrying
  // servd's own CTA and named links to the two rival sibling brands, on
  // domains whose entire purpose is to read as an independent restaurant.
  // Both checks are kept: the path one covers servd.pk/brand/<slug>.
  const pathname = usePathname() ?? '/'
  const onBrandMicrosite = useOnBrandMicrosite(initialBrandSlug)
  if (onBrandMicrosite || pathname.startsWith('/brand/')) return null
  return (
    <footer
      className="surface-ink relative overflow-hidden"
      style={{
        padding: 'clamp(4rem, 7vw, 6rem) 0 2rem',
        marginTop: '4rem',
        // servd-purple footer. Accent is the servd green so the eyebrow /
        // "Let's go" / dot / pill read against the purple; text on the green
        // pill is purple (never white).
        background: 'linear-gradient(165deg, var(--servd-purple) 0%, var(--servd-black) 100%)',
        ['--brand-accent' as string]: 'var(--servd-green)',
        ['--brand-ink' as string]:    'var(--servd-on-green)',
      } as React.CSSProperties}
    >
      <div className="container relative z-10">

        {/* Headline lockup — chunky display, "ready when you are" loop */}
        <div style={{ marginBottom: 'clamp(3rem, 5vw, 4rem)', maxWidth: '900px' }}>
          <p className="eyebrow" style={{ color: 'var(--brand-accent)', marginBottom: '1rem' }}>
            One place for every kitchen
          </p>
          <h2 className="display" style={{
            fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
            color: 'white',
            marginBottom: '1.5rem',
          }}>
            Hungry now?
            <span className="display-italic" style={{ color: 'var(--brand-accent)' }}> Let's go.</span>
          </h2>
          <Link href="/browse" className="brand-pill">
            Order now <span style={{ opacity: 0.6 }}>→</span>
          </Link>
        </div>

        {/* Link columns — asymmetric, looser layout than the previous grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '2.5rem',
          paddingTop: '2.5rem',
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div>
            <Link
              href="/"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: '2rem',
                fontWeight: 800,
                letterSpacing: '-0.045em',
                color: 'white',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: '0.1rem',
                marginBottom: '0.75rem',
              }}
            >
              servd<span style={{ color: 'var(--brand-accent)' }}>.</span>
            </Link>
            <p style={{ fontSize: '0.92rem', maxWidth: '20rem', color: 'rgba(255,255,255,0.55)', lineHeight: 1.55 }}>
              Every kitchen in one place — order what you are craving, explore the brands, and join Insiders.
            </p>
          </div>

          <div>
            <h3 className="eyebrow" style={{ color: 'rgba(255,255,255,0.45)', marginBottom: '1rem' }}>
              Kitchens
            </h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.7rem' }}>
              {BRANDS.map((b) => (
                <li key={b.slug}>
                  <Link
                    href={`/brand/${b.slug}`}
                    className="kinetic-caret"
                    style={{
                      color: 'rgba(255,255,255,0.85)',
                      textDecoration: 'none',
                      fontSize: '1rem',
                      fontWeight: 600,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.55rem',
                    }}
                  >
                    <span style={{
                      width: '0.55rem', height: '0.55rem',
                      background: b.accent, borderRadius: '999px',
                      display: 'inline-block',
                    }} />
                    {b.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="eyebrow" style={{ color: 'rgba(255,255,255,0.45)', marginBottom: '1rem' }}>
              Customer
            </h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.7rem' }}>
              <li><Link href="/browse"  style={footerLinkStyle}>Browse all brands</Link></li>
              <li><Link href="/account" style={footerLinkStyle}>My account</Link></li>
              <li><Link href="/orders"  style={footerLinkStyle}>Order history</Link></li>
              <li><Link href="/login"   style={footerLinkStyle}>Sign in</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="eyebrow" style={{ color: 'rgba(255,255,255,0.45)', marginBottom: '1rem' }}>
              Company
            </h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.7rem' }}>
              <li><span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.95rem' }}>GS Foods Pvt. Ltd.</span></li>
              <li><span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.95rem' }}>Karachi · Pakistan</span></li>
              <li><a href="mailto:hello@servd.pk" style={footerLinkStyle}>hello@servd.pk</a></li>
            </ul>
          </div>
        </div>

        <div style={{
          marginTop: '3rem',
          paddingTop: '1.5rem',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
          fontSize: '0.78rem',
          color: 'rgba(255,255,255,0.4)',
        }}>
          <span>© {new Date().getFullYear()} GS Foods. All rights reserved.</span>
          <span>Made in Karachi. Cooked in Karachi. For Karachi.</span>
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
