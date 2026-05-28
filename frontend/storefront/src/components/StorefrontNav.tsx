'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useCustomerAuth } from '../store/customerAuth'

// Pages that manage their own header (full-screen splashes, brand
// microsites with their own nav, the per-concept ordering experience).
const HIDDEN_PREFIXES = ['/auth', '/login', '/signup', '/brand/']

// Hero pages keep the nav transparent so the kinetic floating shapes
// behind it stay readable; everywhere else uses the blurred-glass look.
const TRANSPARENT_PATHS = new Set(['/'])

export function StorefrontNav() {
  const pathname = usePathname() ?? '/'
  const token = useCustomerAuth((s) => s.token)

  // On dark-hero pages, the sticky nav is transparent and renders white
  // text. Once the user scrolls past the hero into the white sections,
  // the white text becomes invisible — so flip to the blurred-glass look
  // (white bg + ink text) after the first 60vh of scroll.
  const [scrolledPastHero, setScrolledPastHero] = useState(false)
  useEffect(() => {
    if (!TRANSPARENT_PATHS.has(pathname)) return
    const threshold = window.innerHeight * 0.6
    const onScroll = () => setScrolledPastHero(window.scrollY > threshold)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [pathname])

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null

  // Hide nav on the per-concept ordering screen; that page has its own
  // brand-themed header.
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 1 && !['order', 'browse', 'account', 'orders', 'login', 'signup'].includes(segments[0]!)) {
    return null
  }

  const transparent = TRANSPARENT_PATHS.has(pathname) && !scrolledPastHero
  const onDarkHero  = transparent     // home page is ink-on-dark, nav goes white

  return (
    <nav
      aria-label="Primary"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0.95rem clamp(1rem, 4vw, 2rem)',
        // On the dark hero (home page, scroll near top): solid dark nav so the
        // white brand text reads against it — body bg is white by default, so
        // a truly transparent nav would render white-on-white. Once scrolled
        // past the hero, flip to the blurred-glass look against the white
        // section underneath.
        background: transparent ? '#0a0a0a' : 'rgba(255,255,255,0.88)',
        backdropFilter: transparent ? undefined : 'blur(16px) saturate(160%)',
        WebkitBackdropFilter: transparent ? undefined : 'blur(16px) saturate(160%)',
        borderBottom: transparent ? 'none' : '1px solid var(--servd-line)',
        transition: 'background 220ms ease',
      }}
    >
      {/* Wordmark — chunky display weight. On dark surfaces the dot
          becomes the brand-accent (servd-green by default). */}
      <Link
        href="/"
        aria-label="servd home"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.6rem',
          fontWeight: 800,
          letterSpacing: '-0.045em',
          color: onDarkHero ? 'white' : 'var(--servd-black)',
          textDecoration: 'none',
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: '0.1rem',
        }}
      >
        servd
        <span style={{ color: 'var(--servd-green)' }}>.</span>
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <Link
          href="/browse"
          style={{
            color: onDarkHero ? 'rgba(255,255,255,0.75)' : 'var(--servd-mute)',
            fontWeight: 600,
            fontSize: '0.92rem',
            padding: '0.5rem 0.95rem',
            textDecoration: 'none',
            borderRadius: '0.6rem',
            transition: 'color 160ms ease',
          }}
        >
          Browse
        </Link>

        {token ? (
          <Link
            href="/account"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.5rem 1rem',
              borderRadius: '999px',
              background: onDarkHero ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.04)',
              border: onDarkHero ? '1px solid rgba(255,255,255,0.18)' : '1px solid var(--servd-line)',
              color: onDarkHero ? 'white' : 'var(--servd-ink)',
              fontWeight: 600,
              fontSize: '0.88rem',
              textDecoration: 'none',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '1.4rem',
                height: '1.4rem',
                borderRadius: '50%',
                background: 'var(--servd-green)',
                color: 'var(--servd-black)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.7rem',
                fontWeight: 900,
              }}
            >A</span>
            Account
          </Link>
        ) : (
          <>
            <Link
              href="/login"
              style={{
                color: onDarkHero ? 'rgba(255,255,255,0.75)' : 'var(--servd-mute)',
                fontWeight: 600,
                fontSize: '0.88rem',
                padding: '0.5rem 0.95rem',
                textDecoration: 'none',
                borderRadius: '0.6rem',
              }}
            >
              Sign in
            </Link>
            {/* CTA — uses the kinetic brand-pill so it matches every
                other "primary action" pill across the site. */}
            <Link
              href="/signup"
              className="brand-pill"
              style={{
                ['--brand-accent' as string]: 'var(--servd-green)',
                // royal-blue accent → text must be white for contrast
                ['--brand-ink' as string]:    'white',
                padding: '0.55rem 1.2rem',
                fontSize: '0.92rem',
              }}
            >
              Sign up →
            </Link>
          </>
        )}
      </div>
    </nav>
  )
}
