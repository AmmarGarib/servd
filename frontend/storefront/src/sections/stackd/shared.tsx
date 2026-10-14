// Shared bits for the Stackd sections: the page frame every section sits in,
// the live brand the section renders against, {{brand.name}} filling, and
// link resolution for the host the page is served on.

import type { ReactNode } from 'react'
import type { Concept } from '../../lib/concept'
import { formatBrandName } from '../../lib/concept'
import { FALLBACK_CONCEPTS } from '../../lib/fallbackBrands'
import type { SectionContext } from '../types'
import { safeSrc, str } from '../safe'
import { brandHref } from '../brand/util'
import { sectionKitImage } from '../brand/kitImage'
import './stackd.css'

// Bundled artwork. Used until the operator uploads a replacement in
// admin -> Marketing -> Brands -> Storefront (or sets one on the section).
// These files ship in public/brand/ so the page never depends on the uploads
// host being up.
export const FALLBACK_WORDMARK = '/brand/stackd-wordmark-tagline.png'
export const FALLBACK_MASCOT = '/brand/stackd-mascot.png'

/** The brand this section renders against: live row, else the bundled record. */
export function stackdConcept(ctx: SectionContext): Concept {
  return ctx.concept ?? FALLBACK_CONCEPTS['stackd'] ?? ({ id: 'stackd', slug: 'stackd', name: 'Stackd' } as Concept)
}

export function brandName(concept: Concept): string {
  return formatBrandName(concept.name)
}

/** A text field with {{brand.name}} filled from the live brand. */
export function fill(v: unknown, concept: Concept): string {
  return str(v).replace(/\{\{brand\.name\}\}/g, brandName(concept))
}

/**
 * A link field's href for the host the page is served on (the shared brand
 * resolver, ../brand/util brandHref): the tokens (@menu, @order, @book …)
 * resolve, this brand's own pages sit at the domain root on stackd.pk (/menu,
 * not /brand/stackd/menu) and stay /brand/stackd/… on servd, and servd pages
 * (ordering, booking, /home) are absolute on servd's origin from stackd.pk, so
 * the brand domain never links to a second copy of a page. Resolved against
 * the section's brand, which falls back to the bundled record when the API is
 * down, so the tokens still work then. null = no usable target: hide the link.
 */
export function stackdHref(href: unknown, ctx: SectionContext, concept: Concept): string | null {
  return brandHref(href, { ...ctx, concept }, { mode: 'host', onBrandHost: !!ctx.onBrandHost })?.href ?? null
}

/**
 * The wordmark: the section's own image, else the brand kit's, else the Concept's uploaded one, else
 * the bundled file. `|| fallback` on purpose: an empty string is what a
 * cleared admin field sends, and it must fall back too.
 *
 * width/height declare the INTRINSIC ratio so the browser reserves the right
 * space before the file arrives — known only for the bundled file, so the hint
 * is given only then (stating it for an upload of another shape shifts the page).
 */
export function wordmark(field: unknown, concept: Concept, ctx?: SectionContext): { src: string; dims: { width?: number; height?: number } } {
  // Section field → brand kit wordmark → Concept wordmark → bundled file
  // (the kit resolves the last three, in that order).
  const kit = ctx ? sectionKitImage(ctx, 'wordmark', concept) : null
  const src = safeSrc(field) || safeSrc(kit) || safeSrc(concept.wordmarkUrl) || FALLBACK_WORDMARK
  return { src, dims: src === FALLBACK_WORDMARK ? { width: 599, height: 195 } : {} }
}

/** Visually hidden, still read by search engines and screen readers. */
export const SR_ONLY = {
  position: 'absolute', width: 1, height: 1, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap',
} as const

/**
 * The page frame. Every Stackd section paints inside `.stackd-page` (the
 * globals.css rules are scoped to it) over the fixed plum field. Each section
 * carries the field; stackd.css shows only the first one on the page, so the
 * soft pool of light doesn't stack up section by section, and whichever
 * section the owner puts first still has it.
 */
export function StackdFrame({ children }: { children: ReactNode }) {
  return (
    <div className="stackd-page">
      {/* The plum field: fixed, full-bleed, with a soft pool of warm light at
          the top and nothing else — no grid. z-index 0 keeps it under the nav. */}
      <div aria-hidden className="stackd-bg-fixed" />
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  )
}
