'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useCustomerAuth } from '../store/customerAuth'
import { useOnBrandMicrosite } from '../lib/host'
import { usePrefersReducedMotion } from '@/lib/play'
import { LogoBadge } from './nav/LogoBadge'
import { NavBasket } from './nav/NavBasket'
import s from './nav/nav.module.css'

// The shared "pop" spring (stiffness 520, damping 18) for every press.
const POP = { type: 'spring' as const, stiffness: 520, damping: 18 }

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
  const token = useCustomerAuth((st) => st.token)

  // Stands down on a brand microsite; see useOnBrandMicrosite for why this
  // cannot be answered by the path alone, or once in a layout.
  const onBrandMicrosite = useOnBrandMicrosite(initialBrandSlug)
  const reduced = usePrefersReducedMotion()
  const tap = reduced ? undefined : { scale: 0.94 }
  const [logoPress, setLogoPress] = useState(0)

  // On the home the nav starts transparent over the hero, then flips to the
  // blurred-glass look after the first 60vh of scroll.
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

  return (
    <nav
      aria-label="Primary"
      style={{
        // Not sticky — the header lives at the top of the page and scrolls away
        // with the content. On the home it's ABSOLUTE so the hero's full-bleed
        // background sits behind it; elsewhere a normal top-of-page header.
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
      <div className={s.bar}>
        {/* Brand-mark: the googly-eyed badge + wordmark. A normal Link; the
            badge squashes and winks on press while the route changes. */}
        <Link
          href="/"
          aria-label="servd home"
          className={s.home}
          onClick={() => setLogoPress((n) => n + 1)}
        >
          <LogoBadge pressSignal={logoPress} />
          <span className={s.wordmark}>
            servd<span style={{ color: 'var(--servd-green)' }}>.</span>
          </span>
        </Link>

        <div className={s.actions}>
          <motion.span className={s.press} whileTap={tap} transition={POP}>
            <Link href="/browse" className={`${s.browse} ${s.hoverPop}`}>
              <svg className={s.browseIcon} aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="6.5" />
                <path d="M16 16 L20.5 20.5" />
              </svg>
              <span className={s.browseLabel}>Browse</span>
            </Link>
          </motion.span>

          <NavBasket />

          {token ? (
            <motion.span className={s.press} whileTap={tap} transition={POP}>
              <Link href="/account" aria-label="account" className={`${s.account} ${s.hoverPop}`}>
                <span aria-hidden="true" className={s.avatar}>A</span>
                <span className={s.accountLabel}>Account</span>
              </Link>
            </motion.span>
          ) : (
            /* Single Sign in button — the login page already has a "create
               account" path, so a separate Sign up CTA is redundant. */
            <motion.span className={s.press} whileTap={tap} transition={POP}>
              <Link
                href="/login"
                className={`brand-pill ${s.signIn} ${s.hoverPop}`}
                style={{
                  ['--brand-accent' as string]: 'var(--servd-green)',
                  ['--brand-ink' as string]:    'white',
                }}
              >
                Sign in
              </Link>
            </motion.span>
          )}
        </div>
      </div>
    </nav>
  )
}
