// Shared helpers for the brand sections (server- and client-safe: no hooks,
// no 'use client' imports).
//
// Two conventions every brand section follows, so a page default can hold
// today's content verbatim and still track the live brand:
//
//   {{brand.name}} / {{brand.slug}} / {{brand.type}} in any text or link
//     → the live brand's display name, slug and service type.
//
//   Link tokens in an href → the live brand's own pages:
//     @home @menu @about @visit  the microsite pages (@visit = the kitchen's
//                                Google Maps pin when there is one)
//     @order                     the brand's ordering page
//     @book                      the reservation page — hidden when the brand
//                                does not take reservations
//     @whatsapp @email @phone    the brand's contact (Admin → Brands) —
//                                hidden when not set

import { formatBrandName, typeLabel } from '../../lib/concept'
import { locationFromConcept, whatsappLink } from '../../lib/brandLocations'
import type { SectionContext } from '../types'
import { safeHref, str } from '../safe'

export const LINK_TOKEN_HINT =
  'Tokens: @home @menu @about @visit @order @book @whatsapp @email @phone. {{brand.name}} works in text.'

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
}

/** A text field that defaults to live data: '' → the live value. */
export function orLive(v: unknown, live: string | null | undefined, ctx: SectionContext, name?: string): string {
  const s = str(v)
  return s.trim() ? fill(s, ctx, name) : (live ?? '')
}

export interface ResolvedLink { href: string; external: boolean }

/**
 * Where the microsite page links point.
 *   'base' — always /brand/<slug>/… (the nav and page CTAs did this).
 *   'host' — /menu etc. on the brand's own domain, /brand/<slug>/… on servd
 *            (the footer did this).
 */
export type PathMode = 'base' | 'host'

/** A link field's href resolved (tokens, placeholders, safety); null = hide. */
export function brandHref(
  href: unknown,
  ctx: SectionContext,
  opts: { mode?: PathMode; onBrandHost?: boolean } = {},
): ResolvedLink | null {
  const raw = str(href).trim()
  if (!raw) return null
  const c = ctx.concept
  if (raw.startsWith('@')) {
    if (!c) return null
    const base = `/brand/${c.slug}`
    const local = opts.mode === 'host' && opts.onBrandHost
    const page = (p: string) => ({ href: local ? (p ? `/${p}` : '/') : (p ? `${base}/${p}` : base), external: false })
    const loc = locationFromConcept(c)
    switch (raw.toLowerCase()) {
      case '@home':     return page('')
      case '@menu':     return page('menu')
      case '@about':    return page('about')
      case '@visit':    return loc.mapsUrl ? { href: loc.mapsUrl, external: true } : page('visit')
      case '@order':    return { href: `/${c.slug}`, external: false }
      case '@book':     return c.reservationsEnabled !== false ? { href: `/reserve/${c.slug}`, external: false } : null
      case '@whatsapp': return loc.whatsapp ? { href: whatsappLink(loc), external: true } : null
      case '@email':    return loc.email ? { href: `mailto:${loc.email}`, external: false } : null
      case '@phone':    return c.phone ? { href: `tel:${c.phone}`, external: false } : null
      default:          return null
    }
  }
  const safe = safeHref(fill(raw, ctx), '')
  if (!safe) return null
  return { href: safe, external: /^https?:\/\//i.test(safe) }
}

/**
 * A servd page (/home, /login …) linked from a brand microsite. On the
 * brand's own domain it must be absolute, or it would loop back into the
 * microsite (middleware rewrites `/` on a brand host to /brand/<slug>).
 */
export function servdHref(path: string, onBrandHost: boolean): string {
  if (!onBrandHost || !path.startsWith('/')) return path
  const host = (process.env['NEXT_PUBLIC_SERVD_HOST'] ?? '').replace(/\/$/, '')
  return host ? `${host}${path}` : path
}
