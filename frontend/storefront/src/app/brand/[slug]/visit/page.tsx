// Brand Visit page — the SiteLayout `brand:<slug>:visit`, edited in Admin →
// Storefront. Nothing published → the default sections (src/sections/brand:
// page header, address & hours, questions & answers).
//
// Its own canonical (stackd.pk/visit), title ("Visit · Stackd") and a
// description built from where the brand is; a breadcrumb rooted at the
// brand's home; and FAQPage structured data built from the SAME brand.faq
// fields the page renders (live layout, else the defaults), so it only ever
// marks up questions a visitor can read on the page.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchSiteLayout, pageSeo, type Block } from '../../../../lib/blocks'
import { fetchBrandKitchens, filled, locationFromConcept, type BrandLocation } from '../../../../lib/brandLocations'
import { brandAccent, formatBrandName, type Concept } from '../../../../lib/concept'
import { faqSchema, jsonLdScript } from '../../../../lib/jsonLd'
import { fetchLiveConcepts, findConceptOrThrow, fitSentences, resolveConcept } from '../../../../lib/liveConcepts'
import { mergeFields } from '../../../../sections/catalog'
import { ManagedPage } from '../../../../sections/ManagedPage'
import { faqSchemaEntries } from '../../../../sections/brand/faq'
import { str } from '../../../../sections/safe'
import { fill } from '../../../../sections/brand/util'
import { SUBPAGE_TITLE, brandBreadcrumb, brandCtx, brandPageMetadata, cityOf, pageBlocks, type Params } from '../meta'

// force-dynamic + cache: 'no-store' so a single API outage at deploy
// time can't poison the ISR cache and return 404s for the lifetime of
// the container (see CLAUDE.md "Fetch caching gotcha").
export const dynamic = 'force-dynamic'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

/** "Ittehad Commercial, DHA Phase 6, Karachi" — street first when it is
 *  filled; only the parts that are really there. */
function placeOf(loc: BrandLocation): string {
  const street = filled(loc.street).replace(/\s*\n+\s*/g, ', ')
  const parts = [street]
  for (const p of [filled(loc.area), cityOf(loc)]) {
    if (p && !parts.some((q) => q.toLowerCase().includes(p.toLowerCase()))) parts.push(p)
  }
  return parts.filter(Boolean).join(', ')
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const pageSlug = `brand:${slug}:visit`
  const [concept, layout, kitchens] = await Promise.all([
    resolveConcept(slug), fetchSiteLayout(pageSlug), fetchBrandKitchens(API_URL, slug),
  ])
  if (!concept) notFound()

  const name = formatBrandName(concept.name)
  const seo = pageSeo(layout)
  // The address the page shows is the primary kitchen's (owner decision 18).
  const loc = locationFromConcept(concept, kitchens[0] ?? null)
  // The page header's own line, when the owner has written one (empty means
  // the generic service-type line, which says nothing about this place).
  const header = pageBlocks(pageSlug, layout).find((b): b is Extract<Block, { type: 'section' }> =>
    b.type === 'section' && b.variant === 'brand.pageHeader')
  const ownLine = header ? fill(str(mergeFields(header.variant, header.fields)['body']), brandCtx(pageSlug, concept)).trim() : ''
  const hours = (loc.hours?.length ?? 0) > 0
  // "at" a street or area, "in" a city ("Flipd is in Karachi.").
  const at = filled(loc.street) || filled(loc.area) ? 'at' : 'in'
  const description = seo.description ?? fitSentences([
    `${name} is ${at} ${placeOf(loc)}.`,
    ownLine,
    `${hours ? 'Opening hours, directions' : 'Directions'} and ${loc.acceptsReservations ? 'how to book a table' : 'how to order ahead'}.`,
  ], 155)

  return brandPageMetadata({ concept, path: 'visit', title: seo.title ?? SUBPAGE_TITLE.visit, description })
}

export default async function BrandVisitPage({ params }: Params) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const pageSlug = `brand:${slug}:visit`
  const [concepts, layout] = await Promise.all([fetchLiveConcepts(), fetchSiteLayout(pageSlug)])
  const found = findConceptOrThrow(slug, concepts)
  if (!found) notFound()
  const concept: Concept = { ...found, primaryColor: brandAccent(found.slug, found.primaryColor) }

  // The questions this page shows: every brand.faq section on it, read from
  // the same blocks ManagedPage renders (it is handed this very layout read,
  // so a scheduled publish landing mid-request can't split the two), resolved
  // by the same code.
  const ctx = brandCtx(pageSlug, concept)
  const qa = pageBlocks(pageSlug, layout).flatMap((b) =>
    b.type === 'section' && b.variant === 'brand.faq' ? faqSchemaEntries(mergeFields(b.variant, b.fields), ctx) : [])

  const ld: Record<string, unknown>[] = [brandBreadcrumb(concept, SUBPAGE_TITLE.visit, 'visit')]
  if (qa.length > 0) ld.push(faqSchema(qa))

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <ManagedPage slug={pageSlug} {...(layout ? { layout } : {})} {...(concepts.length ? { concepts } : {})} />
    </>
  )
}
