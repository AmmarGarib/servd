'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCustomerAuth } from '../store/customerAuth'
import { useOnBrandMicrosite } from '../lib/host'
import { SearchSheet, openSearch } from './SearchSheet'

// The servd global nav — Apple-style glass bar: wordmark, section links
// (desktop), then search, account and Order. Search opens the SearchSheet.

// Pages that manage their own header (full-screen splashes, brand
// microsites with their own nav, the per-concept ordering experience).
const HIDDEN_PREFIXES = ['/auth', '/login', '/signup', '/brand/']

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

  if (onBrandMicrosite) return null
  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null

  // Hide nav on the per-concept ordering screen; that page has its own
  // brand-themed header.
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 1 && !['order', 'home', 'account', 'orders', 'login', 'signup'].includes(segments[0]!)) {
    return null
  }

  return (
    <>
      <nav aria-label="Primary" className="sv-nav">
        <div className="sv-nav-inner">
          <Link href="/home" aria-label="servd home" className="sv-nav-mark">
            servd<span>.</span>
          </Link>

          <div className="sv-nav-links">
            <Link href="/home#kitchens">Kitchens</Link>
            <Link href="/home#insiders">Insiders</Link>
            <Link href="/home#visit">Visit</Link>
            {token && <Link href="/orders">Orders</Link>}
          </div>

          <button type="button" className="sv-icon-btn" aria-label="Search" onClick={() => openSearch('')}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
          </button>
          <Link href={token ? '/account' : '/login'} className="sv-icon-btn" aria-label={token ? 'Your account' : 'Sign in'}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
            </svg>
          </Link>
          <Link href="/home#kitchens" className="sv-nav-cta">Order</Link>
        </div>
      </nav>
      <SearchSheet />
    </>
  )
}
