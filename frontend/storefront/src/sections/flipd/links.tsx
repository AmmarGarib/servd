// Flipd's section links, resolved for the host the page is served on (server-
// and client-safe: no hooks, no 'use client').
//
// Every button on the Flipd pages goes through the shared brand resolver
// (../brand/util brandHref), so the tokens (@home @menu @order @book …) work
// in any of them, Flipd's own pages sit at the domain root on flipd.pk (/menu,
// not /brand/flipd/menu) and stay /brand/flipd/… on servd.pk, and servd pages
// (ordering, booking, /home) are absolute on servd's origin from flipd.pk — so
// the brand domain never links to a second copy of a page. A stored link
// written out in full (/brand/flipd/menu, /flipd) is rewritten the same way.

import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import { BRAND_ORIGIN, SERVD_LINK_ORIGIN, SERVD_ORIGIN } from '../../lib/brandDomains'
import type { Concept } from '../../lib/concept'
import { FALLBACK_CONCEPTS } from '../../lib/fallbackBrands'
import type { SectionContext } from '../types'
import { str } from '../safe'
import { brandHref, type ResolvedLink } from '../brand/util'

/** The section's brand: the live record, else the bundled one (API down). */
export function flipdConcept(ctx: SectionContext): Concept {
  return ctx.concept ?? FALLBACK_CONCEPTS['flipd'] ?? ({ id: 'flipd', slug: 'flipd', name: 'Flipd' } as Concept)
}

/**
 * A link field's target for this host. An empty href takes `fallback` (a
 * token such as '@order'); null = no usable target, so the caller hides it.
 */
export function flipdHref(href: unknown, ctx: SectionContext, fallback = ''): ResolvedLink | null {
  const raw = str(href).trim() || fallback
  return brandHref(raw, { ...ctx, concept: flipdConcept(ctx) }, { mode: 'host', onBrandHost: !!ctx.onBrandHost })
}

/** servd's own hosts and the brand domains (www. folded): a full URL to any of
 *  them is the same site, so it opens in the same tab. */
const OWN_HOSTS = new Set(
  [SERVD_ORIGIN, SERVD_LINK_ORIGIN, ...Object.values(BRAND_ORIGIN)]
    .map(hostOf)
    .filter(Boolean),
)

function hostOf(url: string): string {
  try {
    return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

/** True for a full http(s) URL that leaves servd and the brand domains. */
function leavesSite(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false
  const host = hostOf(href)
  return !host || !OWN_HOSTS.has(host)
}

/**
 * A resolved link. A path in this site ('/…') is Next's <Link>; anything else
 * (a full URL — servd's own origin from a brand domain included — mailto:,
 * tel:, #anchor) is a plain <a>, because next/link is for page navigation and
 * would swallow a mailto:/tel: click. Only a URL that leaves servd and the
 * brand domains opens in a new tab.
 */
export function FlipdLink({ to, className, style, children }: {
  to: ResolvedLink
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  const inSite = to.href.startsWith('/') && !to.href.startsWith('//')
  if (inSite) return <Link href={to.href} className={className} style={style}>{children}</Link>
  return (
    <a
      href={to.href}
      className={className}
      style={style}
      {...(leavesSite(to.href) && { target: '_blank', rel: 'noopener noreferrer' })}
    >
      {children}
    </a>
  )
}
