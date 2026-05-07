'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCustomerAuth } from '../store/customerAuth'

// Pages that manage their own header (full-screen splashes, brand microsites
// with their own nav, the per-concept ordering experience).
const HIDDEN_PREFIXES = ['/auth', '/login', '/signup', '/brand/']

// Use a transparent variant on the home page; solid on inner pages.
const TRANSPARENT_PATHS = new Set(['/'])

export function StorefrontNav() {
  const pathname = usePathname() ?? '/'
  const token = useCustomerAuth((s) => s.token)

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null

  // Hide nav on the per-concept ordering screen; that page has its own
  // brand-themed header.
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 1 && !['order', 'browse', 'account', 'orders', 'login', 'signup'].includes(segments[0]!)) {
    return null
  }

  const transparent = TRANSPARENT_PATHS.has(pathname)

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
        padding: '0.85rem clamp(1rem, 4vw, 2rem)',
        background: transparent ? 'transparent' : 'rgba(255,255,255,0.92)',
        backdropFilter: transparent ? undefined : 'blur(14px)',
        WebkitBackdropFilter: transparent ? undefined : 'blur(14px)',
        borderBottom: transparent ? 'none' : '1px solid var(--servd-line)',
        transition: 'background 200ms ease',
      }}
    >
      <Link
        href="/"
        aria-label="servd home"
        style={{
          fontSize: '1.5rem',
          fontWeight: 900,
          letterSpacing: '-0.04em',
          color: 'var(--servd-black)',
          textDecoration: 'none',
        }}
      >
        servd
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Link
          href="/browse"
          style={{
            color: 'var(--servd-mute)',
            fontWeight: 600,
            fontSize: '0.9rem',
            padding: '0.5rem 0.85rem',
            textDecoration: 'none',
            borderRadius: '0.5rem',
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
              padding: '0.5rem 0.85rem',
              borderRadius: '999px',
              background: 'rgba(0,0,0,0.04)',
              border: '1px solid var(--servd-line)',
              color: 'var(--servd-ink)',
              fontWeight: 600,
              fontSize: '0.875rem',
              textDecoration: 'none',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '1.25rem',
                height: '1.25rem',
                borderRadius: '50%',
                background: 'var(--servd-green)',
                color: 'var(--servd-black)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.65rem',
                fontWeight: 900,
              }}
            >
              A
            </span>
            Account
          </Link>
        ) : (
          <>
            <Link
              href="/login"
              style={{
                color: 'var(--servd-mute)',
                fontWeight: 600,
                fontSize: '0.875rem',
                padding: '0.5rem 0.85rem',
                textDecoration: 'none',
                borderRadius: '0.5rem',
              }}
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="servd-cta"
              style={{
                background: 'var(--servd-green)',
                color: 'var(--servd-black)',
                fontWeight: 800,
                fontSize: '0.875rem',
                padding: '0.55rem 1.1rem',
                borderRadius: '999px',
                textDecoration: 'none',
              }}
            >
              Sign up
            </Link>
          </>
        )}
      </div>
    </nav>
  )
}
