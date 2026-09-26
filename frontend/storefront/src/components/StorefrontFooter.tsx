'use client'
import Link from 'next/link'
import type { CSSProperties } from 'react'
import { usePathname } from 'next/navigation'
import { useOnBrandMicrosite } from '../lib/host'
import { FooterWave } from './party/footer/FooterWave'
import s from './party/footer/footer.module.css'

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

interface StorefrontFooterProps {
  initialBrandSlug?: string | null
  /**
   * The background colour of whatever section sits directly above the
   * footer on THIS page, so the scalloped top edge reads as that ground
   * dipping onto the plum rather than a mismatched shape. Defaults to the
   * party system's cream (`--servd-*` pages typically end on a cream
   * section — see home's Insiders strip and browse's grid). Pass this when
   * a page's last section is a different colour (e.g. a legacy white
   * surface) instead of the wave staying hardcoded to one page's ground.
   */
  groundColor?: string
}

export function StorefrontFooter({ initialBrandSlug = null, groundColor }: StorefrontFooterProps) {
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
      className={s.footer}
      style={groundColor ? ({ ['--wave-color' as string]: groundColor } as CSSProperties) : undefined}
    >
      <FooterWave />

      {/* Doodles — decoration only. */}
      <svg aria-hidden className={`${s.doodle} ${s.doodleStar}`} viewBox="0 0 40 40">
        <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
      </svg>
      <svg aria-hidden className={`${s.doodle} ${s.doodleDot}`} viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="8" />
      </svg>

      <div className={s.inner}>

        {/* Headline lockup */}
        <div className={s.lockup}>
          <p className={s.eyebrow}>One place for every kitchen</p>
          <h2 className={s.title}>
            Hungry now?<span className={s.titleItalic}> Let's go.</span>
          </h2>
          <Link href="/browse" className={s.cta}>
            Order now
            <svg aria-hidden viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </Link>
        </div>

        {/* Link columns */}
        <div className={s.columns}>
          <div>
            <Link href="/" className={s.wordmark}>
              servd<span style={{ color: 'var(--party-butter)' }}>.</span>
            </Link>
            <p className={s.blurb}>
              Every kitchen in one place — order what you are craving, explore the brands, and join Insiders.
            </p>
          </div>

          <div>
            <h3 className={s.columnLabel}>Kitchens</h3>
            <ul className={s.linkList}>
              {BRANDS.map((b) => (
                <li key={b.slug}>
                  <Link href={`/brand/${b.slug}`} className={s.linkRow}>
                    <span aria-hidden className={s.dot} style={{ background: b.accent }} />
                    {b.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className={s.columnLabel}>Customer</h3>
            <ul className={s.linkList}>
              <li><Link href="/browse"  className={s.linkRow}>Browse all brands</Link></li>
              <li><Link href="/account" className={s.linkRow}>My account</Link></li>
              <li><Link href="/orders"  className={s.linkRow}>Order history</Link></li>
              <li><Link href="/login"   className={s.linkRow}>Sign in</Link></li>
            </ul>
          </div>

          <div>
            <h3 className={s.columnLabel}>Company</h3>
            <ul className={s.linkList}>
              <li><span className={s.staticRow}>GS Foods Pvt. Ltd.</span></li>
              <li><span className={s.staticRow}>Karachi · Pakistan</span></li>
              <li><a href="mailto:hello@servd.pk" className={s.linkRow}>hello@servd.pk</a></li>
            </ul>
          </div>
        </div>

        <div className={s.bottomBar}>
          <span>© {new Date().getFullYear()} GS Foods. All rights reserved.</span>
          <span>Made in Karachi. Cooked in Karachi. For Karachi.</span>
        </div>
      </div>
    </footer>
  )
}
