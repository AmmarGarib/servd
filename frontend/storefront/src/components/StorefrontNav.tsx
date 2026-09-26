'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { User, ArrowRight } from 'lucide-react'
import { useCustomerAuth } from '../store/customerAuth'
import { useOnBrandMicrosite } from '../lib/host'

// Pages that manage their own header (full-screen splashes, brand
// microsites with their own nav, the per-concept ordering experience).
const HIDDEN_PREFIXES = ['/auth', '/login', '/signup', '/brand/']

// Hero pages start the capsule looser/quieter so the kinetic floating
// shapes behind it stay readable; everywhere else it's settled from the
// first paint.
const TRANSPARENT_PATHS = new Set(['/'])

interface Props {
  /**
   * The brand slug the server resolved for this request, or null on the servd
   * domain. Only correct for the document that was hard-loaded — see below.
   */
  initialBrandSlug?: string | null
}

export function StorefrontNav({ initialBrandSlug = null }: Props) {
  const pathname = usePathname() ?? '/'
  const token = useCustomerAuth((s) => s.token)

  // Stands down on a brand microsite; see useOnBrandMicrosite for why this
  // cannot be answered by the path alone, or once in a layout.
  const onBrandMicrosite = useOnBrandMicrosite(initialBrandSlug)

  // The hub is dark end to end now (dark hero → dark sections), so the nav
  // capsule reads the same dark-glass everywhere. This listener only decides
  // whether the capsule has settled in — past the first 60vh on the home
  // hero it condenses slightly (tighter padding, stronger glass). Passive +
  // a single scroll-position read, so it stays cheap.
  const [scrolledPastHero, setScrolledPastHero] = useState(false)
  useEffect(() => {
    if (!TRANSPARENT_PATHS.has(pathname)) return
    const threshold = window.innerHeight * 0.6
    const onScroll = () => setScrolledPastHero(window.scrollY > threshold)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [pathname])

  // Hover state for the quiet "Browse" text link (it has no CSS class of its
  // own to carry a :hover rule, so this drives its background/color inline).
  const [browseHover, setBrowseHover] = useState(false)

  if (onBrandMicrosite) return null
  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null

  // Hide nav on the per-concept ordering screen; that page has its own
  // brand-themed header.
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 1 && !['order', 'browse', 'account', 'orders', 'login', 'signup'].includes(segments[0]!)) {
    return null
  }

  // On the home hero, the capsule sits looser and a touch more transparent
  // until the reader scrolls past the first screen; everywhere else (and
  // once scrolled) it's condensed and fully settled.
  const loose = TRANSPARENT_PATHS.has(pathname) && !scrolledPastHero

  return (
    <nav
      aria-label="Primary"
      className="hub"
      style={{
        // Not sticky — the header lives at the top of the page and scrolls away
        // with the content. On the home it's ABSOLUTE so the hero's full-bleed
        // background sits behind it (the servd mark is immersed in the hero);
        // elsewhere a normal top-of-page header. Positioning is unchanged from
        // before this pass — only the capsule inside it is new.
        position: pathname === '/' ? 'absolute' : 'relative',
        top: 0, left: 0, right: 0,
        zIndex: 50,
        background: 'transparent',
        padding: loose ? '1.1rem 0 0' : '0.7rem 0 0',
        transition: 'padding 260ms var(--hub-ease)',
      }}
    >
      <div className="hub-container">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            borderRadius: '999px',
            background: loose ? 'rgba(17,11,19,0.55)' : 'rgba(17,11,19,0.72)',
            backdropFilter: 'blur(18px) saturate(160%)',
            WebkitBackdropFilter: 'blur(18px) saturate(160%)',
            border: '1px solid var(--hub-line-strong)',
            boxShadow: 'var(--hub-shadow)',
            padding: loose ? '0.55rem 0.7rem 0.55rem 1.1rem' : '0.4rem 0.55rem 0.4rem 1rem',
            transition: 'background 260ms var(--hub-ease), padding 260ms var(--hub-ease)',
          }}
        >
          {/* Brand-mark — circular plum mark + wordmark, lilac period. */}
          <Link
            href="/"
            aria-label="servd home"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem', textDecoration: 'none' }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '2.15rem', height: '2.15rem', borderRadius: '50%', flexShrink: 0,
                background: 'var(--hub-plum)', color: 'var(--hub-text)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--hub-font-display)', fontWeight: 800, fontSize: '1rem',
                letterSpacing: '-0.02em',
              }}
            >
              s
            </span>
            <span
              style={{
                fontFamily: 'var(--hub-font-display)',
                fontSize: '1.4rem',
                fontWeight: 700,
                letterSpacing: '-0.03em',
                lineHeight: 1,
                color: 'var(--hub-text)',
              }}
            >
              servd<span style={{ color: 'var(--hub-lilac)' }}>.</span>
            </span>
          </Link>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <Link
              href="/browse"
              onMouseEnter={() => setBrowseHover(true)}
              onMouseLeave={() => setBrowseHover(false)}
              style={{
                color: browseHover ? 'var(--hub-text)' : 'var(--hub-text-mute)',
                background: browseHover ? 'var(--hub-line)' : 'transparent',
                fontWeight: 600,
                fontSize: '0.92rem',
                padding: '0.7rem 0.95rem',
                textDecoration: 'none',
                borderRadius: '999px',
                transition: 'color 180ms ease, background-color 180ms ease',
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: '44px',
              }}
            >
              Browse
            </Link>

            {token ? (
              <Link href="/account" className="hub-btn-ghost">
                <User size={17} aria-hidden="true" />
                Account
              </Link>
            ) : (
              /* Single Sign in button — the login page already has a "create
                 account" path, so a separate Sign up CTA is redundant. */
              <Link href="/login" className="hub-btn">
                Sign in
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            )}
          </div>
        </div>
      </div>
    </nav>
  )
}
