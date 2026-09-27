'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { motion, useMotionTemplate, useScroll, useTransform } from 'framer-motion'
import { useCustomerAuth } from '../store/customerAuth'
import { useOnBrandMicrosite } from '../lib/host'
import { cutThemeFor, type CutTheme } from '../lib/film/cut'
import { usePrefersReducedMotion } from '../lib/film/motion'
import { FoleyToggle } from './film/FoleyToggle'

// Pages that manage their own header (full-screen splashes, brand
// microsites with their own nav, the per-concept ordering experience).
const HIDDEN_PREFIXES = ['/auth', '/login', '/signup', '/brand/']

// Hero pages start with a clear nav over the stage and frost into glass as
// the scene scrolls; everywhere else uses the blurred-glass look.
const TRANSPARENT_PATHS = new Set(['/'])

// Chapter tint: the logo dot takes the accent of the scene you're in.
const ACCENT: Record<CutTheme, string> = {
  servd: '#4E2A4F',
  stackd: '#7C2946',
  flipd: '#294375',
  simmer: '#06392F',
}

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

  const reduced = usePrefersReducedMotion()
  const accent = ACCENT[cutThemeFor(pathname)]

  // Continuous glass on the home: over the first half-viewport of scroll the
  // nav frosts from clear to glass — background alpha 0→0.88, blur 0→16px.
  // Scroll-linked MotionValues only; no React state per frame. The viewport
  // height is measured on mount and resize, never inside the scroll path.
  const [vh, setVh] = useState(800)
  useEffect(() => {
    const measure = () => setVh(window.innerHeight || 800)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  const { scrollY } = useScroll()
  const glass = useTransform(scrollY, [0, Math.max(1, vh * 0.5)], [0, 1], { clamp: true })
  const bgAlpha = useTransform(glass, (g) => g * 0.88)
  const blurPx = useTransform(glass, (g) => g * 16)
  const satPct = useTransform(glass, (g) => 100 + g * 60)
  const lineAlpha = useTransform(glass, (g) => g * 0.08)
  const glassBg = useMotionTemplate`rgba(255,255,255,${bgAlpha})`
  const glassBlur = useMotionTemplate`blur(${blurPx}px) saturate(${satPct}%)`
  const glassLine = useMotionTemplate`1px solid rgba(0,0,0,${lineAlpha})`

  if (onBrandMicrosite) return null
  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null

  // Hide nav on the per-concept ordering screen; that page has its own
  // brand-themed header.
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 1 && !['order', 'browse', 'account', 'orders', 'login', 'signup'].includes(segments[0]!)) {
    return null
  }

  const home = TRANSPARENT_PATHS.has(pathname)
  // The home hero is a light butter-yellow stage (the food crowd), so the
  // clear nav stays ink-on-light — no white text, no dark scrim.
  const onDarkHero  = false
  const tint = reduced ? 'none' : 'background-color 500ms var(--film-ease-settle), color 500ms var(--film-ease-settle)'

  return (
    <motion.nav
      aria-label="Primary"
      style={home ? {
        // On the home the header floats over the pinned opening shot and
        // stays with the viewer through the film, frosting as it scrolls.
        position: 'fixed',
        top: 0, left: 0, right: 0,
        zIndex: 50,
        padding: '0.95rem clamp(1rem, 4vw, 2rem)',
        background: glassBg,
        backdropFilter: glassBlur,
        WebkitBackdropFilter: glassBlur,
        borderBottom: glassLine,
      } : {
        // Elsewhere a normal top-of-page header that scrolls away.
        position: 'relative',
        top: 0, left: 0, right: 0,
        zIndex: 50,
        padding: '0.95rem clamp(1rem, 4vw, 2rem)',
        background: 'rgba(255,255,255,0.88)',
        backdropFilter: 'blur(16px) saturate(160%)',
        WebkitBackdropFilter: 'blur(16px) saturate(160%)',
        borderBottom: '1px solid var(--servd-line)',
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
          background: accent, color: 'white',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-display)', fontWeight: 900, fontSize: '1.05rem',
          letterSpacing: '-0.02em', boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
          transition: tint,
        }}>s</span>
        <span className="film-nav-word" style={{
          fontFamily: 'var(--font-wordmark)',
          fontSize: '1.5rem',
          fontWeight: 800,
          letterSpacing: '-0.03em',
          lineHeight: 1,
          color: onDarkHero ? 'white' : 'var(--servd-black)',
        }}>
          servd<span style={{ color: accent, transition: tint }}>.</span>
        </span>
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
        {/* Foley: optional synthesized sound, off by default. Icon-only on phones. */}
        <FoleyToggle tone="light" />
        <Link
          href="/browse"
          style={{
            color: onDarkHero ? 'rgba(255,255,255,0.75)' : 'var(--servd-mute)',
            fontWeight: 600,
            fontSize: '0.92rem',
            padding: '0.7rem clamp(0.55rem, 2vw, 0.95rem)',
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

        {token ? (
          <Link
            href="/account"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.6rem 1rem',
              minHeight: '44px',
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
              padding: '0.7rem 1.3rem',
              fontSize: '0.92rem',
              minHeight: '44px',
            }}
          >
            Sign in
          </Link>
        )}
      </div>
      </div>
    </motion.nav>
  )
}
