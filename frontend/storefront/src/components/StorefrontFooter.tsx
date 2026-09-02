'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Live brands only — the long historical list (Strata, Craveman, Garnish
// Station, Stax@Padel) lived in the footer when they had no concept rows,
// promising the customer kitchens they couldn't actually order from. Pulled
// down to match the live state on the home page. Add back when their
// concept rows + microsites land.
// Accents match the canonical per-brand palette (lib/concept BRAND_ACCENT_OVERRIDES).
// "simmer" is lowercase per its brand rules.
const BRANDS = [
  { slug: 'stax',   name: 'Stax',   accent: '#B0B2B8' },
  { slug: 'simmer', name: 'simmer', accent: '#E94E1B' },
  { slug: 'flipd',  name: 'Flipd',  accent: '#2092E9' },
]

export function StorefrontFooter() {
  // Brand microsites render their own BrandFooter (via BrandShell); the global
  // servd footer must hide on /brand/* or those pages show two footers.
  const pathname = usePathname() ?? '/'
  if (pathname.startsWith('/brand/')) return null
  return (
    <footer
      className="surface-ink aurora-field relative overflow-hidden"
      style={{
        padding: 'clamp(4rem, 7vw, 6rem) 0 2rem',
        marginTop: '4rem',
        // Brand-purple footer (was a black slab). Accent is a light lavender so
        // the eyebrow / "Let's go" / dot / pill read against the deep purple.
        background: 'linear-gradient(165deg, #4E2A4F 0%, #2D1E2F 55%, #1E1420 100%)',
        ['--brand-accent' as string]: '#C9A4F2',
        ['--brand-ink' as string]:    '#2D1E2F',
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
