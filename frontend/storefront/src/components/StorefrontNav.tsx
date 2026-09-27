'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useCustomerAuth } from '../store/customerAuth'
import { useOnBrandMicrosite } from '../lib/host'
import { useKitchens } from '../lib/world/kitchens'
import s from './world/companion.module.css'

// Pages that manage their own header (full-screen splashes, brand
// microsites with their own nav, the per-concept ordering experience).
const HIDDEN_PREFIXES = ['/auth', '/login', '/signup', '/brand/']

// Hero pages keep the nav transparent so the kinetic floating shapes
// behind it stay readable; everywhere else uses the blurred-glass look.
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

  // Live kitchen state for the "right now" chip. Server + first client render
  // agree on the fallback states, then the live hours land.
  const { openCount, total } = useKitchens()
  const nowShort = openCount === 0 ? 'all asleep' : `${openCount} cooking`
  const nowAria = openCount === 0
    ? 'right now: all kitchens are closed'
    : `right now: ${openCount} of ${total} kitchens cooking`

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

  if (onBrandMicrosite) return null
  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null

  // Hide nav on the per-concept ordering screen; that page has its own
  // brand-themed header.
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 1 && !['order', 'browse', 'account', 'orders', 'login', 'signup'].includes(segments[0]!)) {
    return null
  }

  const transparent = TRANSPARENT_PATHS.has(pathname) && !scrolledPastHero
  // The home hero is the world sky: butter at lunch, plum-indigo at night. The
  // transparent nav follows the sky's ink (--world-ink, stamped per day-part on
  // <html>) so it reads at every hour; elsewhere it's ink on glass.
  const worldInk = transparent && pathname === '/'
  const ink  = worldInk ? 'var(--world-ink, var(--servd-black))' : 'var(--servd-black)'
  const soft = worldInk ? 'var(--world-ink-soft, var(--servd-mute))' : 'var(--servd-mute)'

  return (
    <nav
      aria-label="Primary"
      style={{
        // Not sticky — the header lives at the top of the page and scrolls away
        // with the content. On the home it's ABSOLUTE so the hero's full-bleed
        // background image sits behind it (the servd mark is immersed in the
        // image, video expands in front); elsewhere a normal top-of-page header.
        position: pathname === '/' ? 'absolute' : 'relative',
        top: 0, left: 0, right: 0,
        zIndex: 50,
        padding: '0.95rem clamp(1rem, 4vw, 2rem)',
        background: transparent ? 'transparent' : 'rgba(255,255,255,0.88)',
        backdropFilter: transparent ? undefined : 'blur(16px) saturate(160%)',
        WebkitBackdropFilter: transparent ? undefined : 'blur(16px) saturate(160%)',
        borderBottom: transparent ? 'none' : '1px solid var(--servd-line)',
        transition: 'background 220ms ease',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          maxWidth: 1200,
          margin: '0 auto',
          width: '100%',
        }}
      >
      {/* Brand-mark — circular logo placeholder + name (new system, matches the
          brand microsites). Name goes white over the dark hero, plum elsewhere. */}
      <Link
        href="/"
        aria-label="servd home"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem', textDecoration: 'none' }}
      >
        <span aria-hidden="true" style={{
          width: '2.3rem', height: '2.3rem', borderRadius: '50%', flexShrink: 0,
          background: 'var(--servd-green)', color: 'white',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-display)', fontWeight: 900, fontSize: '1.05rem',
          letterSpacing: '-0.02em', boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
        }}>s</span>
        <span style={{
          fontFamily: 'var(--font-wordmark)',
          fontSize: '1.5rem',
          fontWeight: 800,
          letterSpacing: '-0.03em',
          lineHeight: 1,
          color: ink,
          transition: 'color 400ms ease',
        }}>
          servd<span style={{ color: worldInk ? 'var(--world-accent, var(--servd-green))' : 'var(--servd-green)' }}>.</span>
        </span>
      </Link>

      <div className={s.navActions}>
        <Link
          href="/browse"
          className={s.navLink}
          style={{
            color: soft,
            fontWeight: 600,
            fontSize: '0.92rem',
            textDecoration: 'none',
            borderRadius: '0.6rem',
            transition: 'color 160ms ease',
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: '44px',
          }}
        >
          Browse
        </Link>

        {/* Right now: the same live kitchen state the board, the buddy and
            every brand's lamp obey. Dot-only on phones. */}
        <Link
          href="/#right-now"
          className={s.nowChip}
          aria-label={nowAria}
          title={nowAria}
          style={{ color: soft, marginRight: '0.25rem' }}
        >
          <span className={s.nowDot} data-open={openCount > 0 ? '1' : '0'} aria-hidden="true" />
          <span className={s.nowLabel} aria-hidden="true">{nowShort}</span>
        </Link>

        {token ? (
          <Link
            href="/account"
            className={s.navAccount}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              minHeight: '44px',
              borderRadius: '999px',
              background: worldInk ? 'transparent' : 'rgba(0,0,0,0.04)',
              border: worldInk ? '1.5px solid var(--world-ink, var(--servd-line))' : '1px solid var(--servd-line)',
              color: worldInk ? ink : 'var(--servd-ink)',
              fontWeight: 600,
              fontSize: '0.88rem',
              textDecoration: 'none',
            }}
          >
            {/* No name is stored client-side, so no invented initial: a
                plain person mark. */}
            <span aria-hidden="true" className={s.avatar}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
              </svg>
            </span>
            <span className={s.navAccountLabel}>Account</span>
          </Link>
        ) : (
          /* Single Sign in button — the login page already has a "create
             account" path, so a separate Sign up CTA is redundant. */
          <Link
            href="/login"
            className={`brand-pill ${s.navSignIn}`}
            style={{
              // On the home sky the pill takes the day-part's CTA pair (plum on
              // cream by day, butter on plum at night) so it never sinks into
              // the sky.
              ['--brand-accent' as string]: worldInk ? 'var(--world-cta-bg, var(--servd-green))' : 'var(--servd-green)',
              ['--brand-ink' as string]:    worldInk ? 'var(--world-cta-ink, white)' : 'white',
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
  )
}
