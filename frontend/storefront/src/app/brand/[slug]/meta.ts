// Shared by the brand microsite routes (layout, home, menu, about, visit,
// custom pages): the brand lookup, titles, descriptions, canonicals and the
// breadcrumb, so every page of a brand describes itself the same way.
//
// Titles: the home is `<Brand> — <cuisine> in <district>, <city>` (absolute);
// every other page is its own short title through the brand layout's
// template, `%s · <Brand>`. A page's settings.seo (Admin → Storefront → the
// page → Page tab) overrides both its title and its description.

import type { Metadata } from 'next'
import { brandCanonical, metaDescription, pageMetadata } from '../../../lib/brandDomains'
import type { Block, SiteLayoutRead } from '../../../lib/blocks'
import { filled, type BrandLocation } from '../../../lib/brandLocations'
import { formatBrandName, type Concept } from '../../../lib/concept'
import { brandImageUrl, breadcrumbSchema } from '../../../lib/jsonLd'
import { mergeFields } from '../../../sections/catalog'
import { defaultBlocks } from '../../../sections/ManagedPage'
import { resolveVariant } from '../../../components/blocks/SiteLayoutView'
import type { SectionContext } from '../../../sections/types'
import { fill } from '../../../sections/brand/util'

export type Params = { params: Promise<{ slug: string }> | { slug: string } }

/** The microsite pages with a fixed path, and their short titles (also the
 *  breadcrumb labels). */
export const SUBPAGE_TITLE = { menu: 'Menu', about: 'About', visit: 'Visit' } as const
export type Subpage = keyof typeof SUBPAGE_TITLE

/** "Ittehad Commercial, DHA Phase 6" → "DHA Phase 6": the district a place is
 *  known by (the last part of the area), '' when the area is not filled. */
export function districtOf(loc: BrandLocation): string {
  const parts = filled(loc.area).split(',').map((p) => p.trim()).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** The city, never a placeholder. */
export function cityOf(loc: BrandLocation): string {
  return filled(loc.city) || 'Karachi'
}

/** "Small plates" → "small plates"; an all-caps word (BBQ) is kept. */
function lowerCuisine(cuisine: string): string {
  return cuisine.split(/\s+/).map((w) => (/^[A-Z0-9&]{2,}$/.test(w) ? w : w.toLowerCase())).join(' ')
}

/** "café in DHA Phase 6, Karachi" / "burgers in Karachi" — from live data. */
export function brandDescriptor(loc: BrandLocation): string {
  const cuisine = lowerCuisine(filled(loc.cuisine) || 'restaurant')
  const district = districtOf(loc)
  return `${cuisine} in ${district ? `${district}, ` : ''}${cityOf(loc)}`
}

/** The brand home's title: "Stackd — café in DHA Phase 6, Karachi". */
export function brandHomeTitle(concept: Concept, loc: BrandLocation): string {
  return `${formatBrandName(concept.name)} — ${brandDescriptor(loc)}`
}

/** A section context for reading a brand page's fields outside a render. */
export function brandCtx(pageSlug: string, concept: Concept): SectionContext {
  return { pageSlug, concept, concepts: [concept] }
}

/** The blocks a brand page renders for this visitor: its live layout (the
 *  visitor's A/B variant), else its default sections. Hidden blocks are left
 *  out, as the renderer does. */
export function pageBlocks(pageSlug: string, layout: SiteLayoutRead | null): Block[] {
  const blocks = layout?.blocks?.length ? resolveVariant(layout).blocks : defaultBlocks(pageSlug)
  return blocks.filter((b) => b && !b.hidden)
}

/** Plain text of an owner-written field (tags and markdown marks dropped). */
function plain(v: unknown): string {
  return typeof v === 'string'
    ? v.replace(/<[^>]*>/g, ' ').replace(/[#*_`>[\]]+/g, ' ').replace(/\s+/g, ' ').trim()
    : ''
}

/**
 * The page's lead text: the first of `keys` that is filled on the first
 * section (of `variants`, when given) that has one — with {{brand.*}} filled.
 * '' when the page has none. Owner-editable, since it is the page's own copy.
 */
export function leadText(
  blocks: Block[],
  ctx: SectionContext,
  opts: { variants?: string[]; keys?: string[]; min?: number } = {},
): string {
  const keys = opts.keys ?? ['body', 'intro', 'subtitle']
  for (const b of blocks) {
    let text = ''
    if (b.type === 'section') {
      if (opts.variants && !opts.variants.includes(b.variant)) continue
      const f = mergeFields(b.variant, b.fields)
      for (const k of keys) {
        text = plain(fill(f[k], ctx))
        if (text) break
      }
    } else if (!opts.variants) {
      if (b.type === 'hero' || b.type === 'banner') text = plain(b.subtitle)
      else if (b.type === 'text') text = plain(b.body)
    }
    if (text.length >= (opts.min ?? 1)) return text
  }
  return ''
}

/**
 * Metadata for a brand page: its own canonical on the brand's domain, its
 * title through the brand template, its description, and a share card in the
 * brand's name with the brand's image (og:title/twitter:title carry the
 * resolved "<title> · <Brand>", the same as the tab).
 */
export function brandPageMetadata(m: {
  concept: Concept
  /** Path under the brand ('menu', 'pages/x'); '' = the home. */
  path: string
  title: string
  description: string
  noindex?: boolean
}): Metadata {
  const name = formatBrandName(m.concept.name)
  const share = `${m.title} · ${name}`
  const meta = pageMetadata({
    title:       m.title,
    description: metaDescription(m.description),
    canonical:   brandCanonical(m.concept.slug, m.path),
    siteName:    name,
    image:       brandImageUrl(m.concept.slug),
    ...(m.noindex && { noindex: true }),
  })
  return {
    ...meta,
    openGraph: { ...meta.openGraph, title: share, images: shareImages(m.concept) },
    twitter:   { ...meta.twitter, title: share },
  }
}

/** The brand's share image, described. */
export function shareImages(concept: Concept) {
  const name = formatBrandName(concept.name)
  const about = (concept.description ?? '').trim()
  return [{
    url:    brandImageUrl(concept.slug),
    width:  1200,
    height: 630,
    alt:    about ? `${name} — ${metaDescription(about, 100)}` : name,
  }]
}

/** BreadcrumbList for a microsite page: the brand home, then the page — both
 *  on the brand's own domain. */
export function brandBreadcrumb(concept: Concept, label: string, path: string): Record<string, unknown> {
  return breadcrumbSchema([
    { name: formatBrandName(concept.name), url: brandCanonical(concept.slug) },
    { name: label,                         url: brandCanonical(concept.slug, path) },
  ])
}
