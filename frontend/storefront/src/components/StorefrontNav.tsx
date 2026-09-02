'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useCustomerAuth } from '../store/customerAuth'

// Pages that manage their own header (full-screen splashes, brand
// microsites with their own nav, the per-concept ordering experience).
const HIDDEN_PREFIXES = ['/auth', '/login', '/signup', '/brand/']

// Hero pages keep the nav transparent so the full-bleed hero art stays
// immersive; everywhere else (and once scrolled) it's the floating
// liquid-glass capsule.
const TRANSPARENT_PATHS = new Set(['/'])

export function StorefrontNav() {
  const pathname = usePathname() ?? '/'
  const token = useCustomerAuth((s) => s.token)

  // Over the home hero the capsule is clear with white text; after the
  // first stretch of scroll it condenses into the frosted-glass pill.
  // Non-hero pages are glass from the first paint.
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const heroPage = TRANSPARENT_PATHS.has(pathname)
    const threshold = heroPage ? window.innerHeight * 0.55 : 8
    const onScroll = () => setScrolled(window.scrollY > threshold)
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

  const clear      = TRANSPARENT_PATHS.has(pathname) && !scrolled
  const onDarkHero = clear   // home hero is dark; nav text goes white over it

  return (
    <>
      <nav aria-label="Primary" className="nav-shell">
        <div
          className={`nav-pill ${clear ? 'is-clear' : 'is-glass'}`}
          style={clear ? {
            // Legibility scrim over the hero image — a soft top gradient on
            // the shell itself, not the pill, would spill wide; a subtle
            // text-shadow via filter keeps it clean instead.
          } : undefined}
        >
          {/* Brand-mark — circular logo + wordmark. White over the dark
              hero, ink on glass. */}
          <Link
            href="/"
            aria-label="servd home"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem', textDecoration: 'none' }}
          >
            <span aria-hidden="true" style={{
              width: '2.2rem', height: '2.2rem', borderRadius: '50%', flexShrink: 0,
              background: 'var(--servd-green)', color: 'white',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--font-display)', fontWeight: 900, fontSize: '1rem',
              letterSpacing: '-0.02em', boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
            }}>s</span>
            <span style={{
              fontFamily: 'var(--font-wordmark)',
              fontSize: '1.4rem',
              fontWeight: 800,
              letterSpacing: '-0.03em',
              lineHeight: 1,
              color: onDarkHero ? 'white' : 'var(--servd-black)',
              textShadow: onDarkHero ? '0 1px 12px rgba(0,0,0,0.45)' : undefined,
              transition: 'color 250ms ease',
            }}>
              servd<span style={{ color: onDarkHero ? '#C9A4F2' : 'var(--servd-green)' }}>.</span>
            </span>
          </Link>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <Link
              href="/browse"
              style={{
                color: onDarkHero ? 'rgba(255,255,255,0.85)' : 'var(--servd-mute)',
                fontWeight: 600,
                fontSize: '0.92rem',
                padding: '0.7rem 0.95rem',
                textDecoration: 'none',
                borderRadius: '999px',
                transition: 'color 200ms ease, background 200ms ease',
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: '44px',
                textShadow: onDarkHero ? '0 1px 8px rgba(0,0,0,0.4)' : undefined,
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
                  padding: '0.55rem 1rem',
                  minHeight: '44px',
                  borderRadius: '999px',
                  background: onDarkHero ? 'rgba(255,255,255,0.14)' : 'rgba(78,42,79,0.08)',
                  border: onDarkHero ? '1px solid rgba(255,255,255,0.28)' : '1px solid var(--servd-line)',
                  backdropFilter: 'blur(10px)',
                  WebkitBackdropFilter: 'blur(10px)',
                  color: onDarkHero ? 'white' : 'var(--servd-ink)',
                  fontWeight: 600,
                  fontSize: '0.88rem',
                  textDecoration: 'none',
                  transition: 'background 200ms ease, color 200ms ease',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: '1.4rem',
                    height: '1.4rem',
                    borderRadius: '50%',
                    background: 'var(--servd-green)', color: 'white',
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
              /* Single Sign in button — the login page already has a "create
                 account" path, so a separate Sign up CTA is redundant. */
              <Link
                href="/login"
                className="brand-pill"
                style={{
                  ['--brand-accent' as string]: 'var(--servd-green)',
                  ['--brand-ink' as string]:    'white',
                  padding: '0.65rem 1.3rem',
                  fontSize: '0.92rem',
                  minHeight: '44px',
                }}
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </nav>

      {/* The nav is fixed; non-hero pages need the flow space it used to
          occupy so headers don't slide underneath the capsule. */}
      {!TRANSPARENT_PATHS.has(pathname) && <div aria-hidden style={{ height: '4.75rem' }} />}
    </>
  )
}
