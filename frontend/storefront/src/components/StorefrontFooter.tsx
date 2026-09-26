'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { useOnBrandMicrosite } from '../lib/host'

// Live brands only — the long historical list (Strata, Craveman, Garnish
// Station, Stackd@Padel) lived in the footer when they had no concept rows,
// promising the customer kitchens they couldn't actually order from. Pulled
// down to match the live state on the home page. Add back when their
// concept rows + microsites land.
// Accents match the canonical per-brand palette (lib/concept BRAND_ACCENT_OVERRIDES).
// "simmer" and "stackd" are lowercase per their brand rules.
const BRANDS = [
  { slug: 'stackd', name: 'stackd', accent: '#FCE8CE' },
  { slug: 'simmer', name: 'simmer', accent: '#E94E1B' },
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
    <footer className="hub hub-grain" style={{ position: 'relative', overflow: 'hidden', paddingTop: 'clamp(4rem, 7vw, 6rem)', paddingBottom: '2rem' }}>
      {/* Ambient glow, matches the hub hero treatment — lilac for interaction. */}
      <div
        aria-hidden="true"
        className="hub-glow"
        style={{ width: '620px', height: '620px', top: '-260px', right: '-160px', background: 'var(--hub-plum)', opacity: 0.5 }}
      />

      <div className="hub-container" style={{ position: 'relative', zIndex: 1 }}>

        {/* Closing CTA — chunky display headline, "hungry now?" hook. */}
        <div style={{ marginBottom: 'clamp(3rem, 5vw, 4rem)', maxWidth: '900px' }}>
          <p className="hub-eyebrow" style={{ marginBottom: '1rem' }}>
            One place for every kitchen
          </p>
          <h2 className="hub-display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', marginBottom: '1.5rem' }}>
            Hungry now? <em>Let&rsquo;s go.</em>
          </h2>
          <Link href="/browse" className="hub-btn">
            Order now
            <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </div>

        {/* Link columns */}
        <div
          className="hub-rule"
          style={{ marginBottom: '2.5rem' }}
        />
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '2.5rem',
        }}>
          <div>
            <Link
              href="/"
              style={{
                fontFamily: 'var(--hub-font-display)',
                fontSize: '2rem',
                fontWeight: 700,
                letterSpacing: '-0.045em',
                color: 'var(--hub-text)',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: '0.1rem',
                marginBottom: '0.75rem',
              }}
            >
              servd<span style={{ color: 'var(--hub-lilac)' }}>.</span>
            </Link>
            <p className="hub-meta" style={{ maxWidth: '20rem' }}>
              Every kitchen in one place — order what you are craving, explore the brands, and join Insiders.
            </p>
          </div>

          <div>
            <h3 className="hub-eyebrow" style={{ marginBottom: '1rem' }}>Kitchens</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid' }}>
              {BRANDS.map((b) => (
                <li key={b.slug}>
                  <Link href={`/brand/${b.slug}`} style={footerRowStyle}>
                    <span
                      aria-hidden="true"
                      style={{ width: '0.55rem', height: '0.55rem', background: b.accent, borderRadius: '999px', display: 'inline-block', flexShrink: 0 }}
                    />
                    {b.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="hub-eyebrow" style={{ marginBottom: '1rem' }}>Customer</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid' }}>
              <li><Link href="/browse"  style={footerRowStyle}>Browse all brands</Link></li>
              <li><Link href="/account" style={footerRowStyle}>My account</Link></li>
              <li><Link href="/orders"  style={footerRowStyle}>Order history</Link></li>
              <li><Link href="/login"   style={footerRowStyle}>Sign in</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="hub-eyebrow" style={{ marginBottom: '1rem' }}>Company</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid' }}>
              <li><span className="hub-meta" style={footerRowStyle}>GS Foods Pvt. Ltd.</span></li>
              <li><span className="hub-meta" style={footerRowStyle}>Karachi &middot; Pakistan</span></li>
              <li><a href="mailto:hello@servd.pk" style={footerRowStyle}>hello@servd.pk</a></li>
            </ul>
          </div>
        </div>

        <div
          className="hub-rule"
          style={{ marginTop: '3rem', marginBottom: '1.5rem' }}
        />
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}>
          <span className="hub-meta">© {new Date().getFullYear()} GS Foods. All rights reserved.</span>
          <span className="hub-meta">Made in Karachi. Cooked in Karachi. For Karachi.</span>
        </div>
      </div>
    </footer>
  )
}

// Shared row style for the link columns — full-width tap target, ≥44px tall
// on mobile so the list reads as a proper touch menu, not compressed text.
const footerRowStyle: React.CSSProperties = {
  color: 'var(--hub-text-mute)',
  textDecoration: 'none',
  fontSize: '0.95rem',
  fontWeight: 500,
  display: 'flex',
  alignItems: 'center',
  gap: '0.55rem',
  minHeight: '44px',
}
