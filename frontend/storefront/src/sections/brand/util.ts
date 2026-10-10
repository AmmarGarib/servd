// Shared helpers for the brand sections (server- and client-safe: no hooks,
// no 'use client' imports).
//
// Two conventions every brand section follows, so a page default can hold
// today's content verbatim and still track the live brand:
//
//   {{brand.name}} / {{brand.slug}} / {{brand.type}} / {{brand.place}} in any
//     text or link → the live brand's display name, slug, service type and
//     where it is ("Ittehad Commercial, DHA Phase 6, Karachi").
//
//   Link tokens in an href → the live brand's own pages:
//     @home @menu @about @visit  the microsite pages (@visit = the kitchen's
//                                Google Maps pin when there is one)
//     @visitpage                 always the microsite's own Visit page
//     @order                     the brand's ordering page
//     @book                      the reservation page — hidden when the brand
//                                does not take reservations
//     @location                  the brand's servd location page
//     @whatsapp @email @phone    the brand's contact (Admin → Brands) —
//                                hidden when not set
//
// Where links point depends on the host. On the brand's own domain
// (stackd.pk) the microsite pages are /, /menu, …, and every servd page
// (ordering, booking, /home) is absolute on servd's origin, so the brand
// domain never serves a second copy of a servd page. On servd.pk the
// microsite pages are /brand/<slug>/….

import { formatBrandName, typeLabel } from '../../lib/concept'
import { filled, locationFromConcept, whatsappLink } from '../../lib/brandLocations'
import { BRAND_ORIGIN, SERVD_LINK_ORIGIN, brandCanonical, isBrandRewritePath } from '../../lib/brandDomains'
import type { SectionContext } from '../types'
import { safeHref, str } from '../safe'

export const LINK_TOKEN_HINT =
  'Tokens: @home @menu @about @visit @visitpage @order @book @location @whatsapp @email @phone. {{brand.name}} works in text.'

/**
 * What a text section (page header, address & hours, Q&A, story hero, call to
 * action) paints behind itself when its colour field is empty: servd bone.
 * Brand pages sit inside BrandShell's dark brand field (tiber, plum, Flipd
 * blue), and these sections set their type in servd's ink and mute — on the
 * bare field that is unreadable. Same convention as the menu (white) and the
 * pillars (servd surface), which already paint their own.
 */
export const TEXT_SURFACE = 'var(--servd-bg)'

/** The brand's display name: the override when set, else the live name. */
export function brandNameOf(ctx: SectionContext, override?: unknown): string {
  const o = str(override).trim()
  if (o) return o
  return ctx.concept ? formatBrandName(ctx.concept.name) : ''
}

/** Text with the {{brand.*}} placeholders filled from the live brand. */
export function fill(text: unknown, ctx: SectionContext, name?: string): string {
  const s = str(text)
  const c = ctx.concept
  if (!c || !s.includes('{{')) return s
  return s
    .replace(/\{\{brand\.name\}\}/g, name ?? formatBrandName(c.name))
    .replace(/\{\{brand\.slug\}\}/g, c.slug)
    .replace(/\{\{brand\.type\}\}/g, typeLabel(c.type))
    .replace(/\{\{brand\.place\}\}/g, () => {
      const loc = locationFromConcept(c)
      return [filled(loc.area), filled(loc.city)].filter(Boolean).join(', ') || 'Karachi'
    })
}

/** A text field that defaults to live data: '' → the live value. */
export function orLive(v: unknown, live: string | null | undefined, ctx: SectionContext, name?: string): string {
  const s = str(v)
  return s.trim() ? fill(s, ctx, name) : (live ?? '')
}

export interface ResolvedLink { href: string; external: boolean }

/**
 * Where the microsite page links point.
 *   'host' — (default) /menu etc. on the brand's own domain, /brand/<slug>/…
 *            on servd.
 *   'base' — always /brand/<slug>/….
 */
export type PathMode = 'base' | 'host'

/**
 * A servd page (/home, /login, /<slug> ordering …) linked from a brand
 * microsite. On the brand's own domain it must be absolute on servd's origin,
 * or it would land on a second copy of the servd page on the brand domain (or
 * loop back into the microsite: the middleware rewrites `/` on a brand host).
 * Unchanged on servd, for anything that is not a path, and in local dev
 * (SERVD_LINK_ORIGIN is empty when NEXT_PUBLIC_SITE_URL is unset).
 */
export function servdHref(path: string, onBrandHost: boolean): string {
  if (!onBrandHost || !path.startsWith('/') || path.startsWith('//')) return path
  return SERVD_LINK_ORIGIN ? `${SERVD_LINK_ORIGIN}${path}` : path
}

/** The path part of an href (no query or hash). */
function pathOf(href: string): string {
  return href.split(/[?#]/)[0] || '/'
}

/** A link field's href resolved (tokens, placeholders, host, safety); null = hide. */
export function brandHref(
  href: unknown,
  ctx: SectionContext,
  opts: { mode?: PathMode; onBrandHost?: boolean } = {},
): ResolvedLink | null {
  const raw = str(href).trim()
  if (!raw) return null
  const c = ctx.concept
  const onBrandHost = opts.onBrandHost ?? !!ctx.onBrandHost
  // Microsite pages at the domain root only in host mode on the brand domain.
  const local = (opts.mode ?? 'host') === 'host' && onBrandHost
  const servd = (path: string): ResolvedLink => ({ href: servdHref(path, onBrandHost), external: false })
  if (raw.startsWith('@')) {
    if (!c) return null
    const base = `/brand/${c.slug}`
    const page = (p: string) => ({ href: local ? (p ? `/${p}` : '/') : (p ? `${base}/${p}` : base), external: false })
    const loc = locationFromConcept(c)
    switch (raw.toLowerCase()) {
      case '@home':      return page('')
      case '@menu':      return page('menu')
      case '@about':     return page('about')
      case '@visit':     return loc.mapsUrl ? { href: loc.mapsUrl, external: true } : page('visit')
      case '@visitpage': return page('visit')
      case '@order':     return servd(`/${c.slug}`)
      case '@book':      return c.reservationsEnabled !== false ? servd(`/reserve/${c.slug}`) : null
      case '@location':  return servd(`/locations/${loc.locationSlug}`)
      case '@whatsapp':  return loc.whatsapp ? { href: whatsappLink(loc), external: true } : null
      case '@email':     return loc.email ? { href: `mailto:${loc.email}`, external: false } : null
      case '@phone':     return c.phone ? { href: `tel:${c.phone}`, external: false } : null
      default:           return null
    }
  }
  const safe = safeHref(fill(raw, ctx), '')
  if (!safe) return null
  if (/^https?:\/\//i.test(safe)) return { href: safe, external: true }
  if (!safe.startsWith('/') || safe.startsWith('//')) return { href: safe, external: false }
  const p = pathOf(safe)
  const rest = safe.slice(p.length)
  // A microsite page written out in full (/brand/<slug>[/menu …]).
  const m = /^\/brand\/([a-z0-9-]+)(\/.*)?$/i.exec(p)
  if (m?.[1]) {
    const tail = m[2] || '/'
    if (isBrandRewritePath(tail)) {
      // Another brand with its own domain: link to that domain, so the brand
      // sites link to each other rather than serve each other's pages.
      if (m[1] !== c?.slug && BRAND_ORIGIN[m[1]]) {
        return { href: brandCanonical(m[1], tail === '/' ? '' : tail) + rest, external: false }
      }
      // This brand's own page: the domain-root path on its own domain.
      if (m[1] === c?.slug && local) return { href: tail + rest, external: false }
    }
    return { href: safe, external: false }
  }
  if (!onBrandHost) return { href: safe, external: false }
  // A plain path on the brand's own domain: the microsite paths (/, /menu …)
  // stay; every other path is a servd page.
  return isBrandRewritePath(p) ? { href: safe, external: false } : servd(safe)
}
