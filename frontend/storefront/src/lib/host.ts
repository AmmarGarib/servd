'use client'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { resolveBrandHost, isBrandRewritePath, SERVD_LINK_ORIGIN } from './brandDomains'

// Canonical servd host URL (no trailing slash). Used when navigating from a
// brand-domain cart into the servd checkout. The servd link origin
// (NEXT_PUBLIC_SITE_URL, e.g. https://servd.pk) wins — the same origin every
// other servd link on a brand domain uses — then the older
// NEXT_PUBLIC_SERVD_HOST. Empty when neither is set (local dev) → callers fall
// back to same-host navigation (the brand and servd code paths are otherwise
// identical while running on a single host).
export function getServdHost(): string {
  return SERVD_LINK_ORIGIN || (process.env['NEXT_PUBLIC_SERVD_HOST'] ?? '').replace(/\/+$/, '')
}

// Resolve the current browser's brand slug, or null if we're on the servd
// canonical host.
//
// Pass `initial` — the slug the SERVER resolved, from the request header the
// middleware stamps — whenever rendering the wrong thing for one paint would
// be visible. Without it this returns null on the first render and the real
// value only after mount, which is fine for behaviour but shows as a flash for
// anything that decides whether to render at all.
//
// The client lookup can only ADD a slug, never take the server's away. The
// host cannot change during a document's life, and the middleware's answer is
// authoritative for the document; the client's comes from GET /domains/hosts,
// which can fail (API blip, CORS, the 2.5s timeout) — and on a failure a
// brand domain resolves to null. Letting that null win put the servd nav and
// footer back on every brand microsite after hydration and swapped the brand's
// own links for /brand/<slug>/… ones, which is what Google renders. So a null
// answer keeps `initial`; only a positively resolved slug replaces it.
export function useBrandSlug(initial: string | null = null): string | null {
  const [slug, setSlug] = useState<string | null>(initial)
  useEffect(() => {
    if (typeof window === 'undefined') return
    let alive = true
    void resolveBrandHost(window.location.host).then((s) => { if (alive && s !== null) setSlug(s) })
    return () => { alive = false }
  }, [])
  return slug
}

/**
 * Is the page being rendered right now a brand microsite?
 *
 * Shared by every piece of servd chrome that has to stand down on a brand
 * domain. It exists because getting this right requires two facts that live in
 * different places, and every component that reimplemented it got it wrong:
 *
 *   the HOST  only the server knows on the first paint — a brand domain is
 *             served by an internal rewrite, so the browser's URL says nothing
 *             about it — and only the client knows after any navigation.
 *   the PATH  changes on every client-side navigation, and only SOME paths on
 *             a brand host are the microsite: /home and /login on flipd.pk
 *             are ordinary servd pages that keep their servd chrome.
 *
 * Testing `pathname.startsWith('/brand/')` — which is what the nav and the
 * footer each did independently — is correct on servd.pk/brand/flipd and wrong
 * on flipd.pk, where the browser's path is "/". Deciding it once in a layout is
 * also wrong, because a layout never re-renders on client-side navigation.
 */
export function useOnBrandMicrosite(initialBrandSlug: string | null = null): boolean {
  const pathname = usePathname() ?? '/'
  const slug = useBrandSlug(initialBrandSlug)
  return slug !== null && isBrandRewritePath(pathname)
}
