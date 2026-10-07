'use client'
import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { useOnBrandMicrosite } from '../lib/host'
import { SearchSheet } from './SearchSheet'

// The gate for the servd global header. The header itself is content — the
// `servd:header` page (section `servd.nav`), rendered on the server by
// app/layout.tsx and passed in as children — so the owner edits it in
// Admin → Storefront. This decides, on every navigation, whether it shows,
// and mounts the search sheet with it.

// Pages that manage their own header (full-screen splashes, brand
// microsites with their own nav, the per-concept ordering experience).
const HIDDEN_PREFIXES = ['/auth', '/login', '/signup', '/brand/']

interface Props {
  /**
   * The brand slug the server resolved for this request, or null on the servd
   * domain. Only correct for the document that was hard-loaded — see below.
   */
  initialBrandSlug?: string | null
  children: ReactNode
}

export function StorefrontNav({ initialBrandSlug = null, children }: Props) {
  const pathname = usePathname() ?? '/'

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
      {/* The header is sticky as a whole: a published layout wraps its blocks
          in a tracking <div>, which would otherwise pin .sv-nav's own sticky
          to that wrapper's height. */}
      <div style={{ position: 'sticky', top: 0, zIndex: 50 }}>{children}</div>
      <SearchSheet />
    </>
  )
}
