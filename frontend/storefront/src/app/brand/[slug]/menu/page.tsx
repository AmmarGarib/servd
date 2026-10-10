// Brand menu page — the SiteLayout `brand:<slug>:menu`, edited in Admin →
// Storefront. Nothing published → the brand's default menu sections: the
// generic `brand.menu` (src/sections/brand), or a brand's own bespoke menu
// section where it registers one (e.g. `brand:simmer:menu`).
//
// Its own canonical (stackd.pk/menu), title ("Menu · Stackd") and
// description; a breadcrumb rooted at the brand's home; and the Menu
// structured data — only when the kitchen has published a menu, never an
// empty one.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchSiteLayout, pageSeo } from '../../../../lib/blocks'
import { locationFromConcept } from '../../../../lib/brandLocations'
import { formatBrandName } from '../../../../lib/concept'
import { jsonLdScript, menuSchema } from '../../../../lib/jsonLd'
import { asSentence, fetchLiveConcepts, findConceptOrThrow, fitSentences, joinNames, resolveConcept } from '../../../../lib/liveConcepts'
import { fetchBrandMenu, hasMenuItems } from '../../../../sections/data'
import { ManagedPage } from '../../../../sections/ManagedPage'
import { SUBPAGE_TITLE, brandBreadcrumb, brandCtx, brandPageMetadata, leadText, pageBlocks, brandDescriptor, type Params } from '../meta'

// Force-dynamic + no-store so a single bad fetch at first request
// doesn't get baked into the ISR cache for the next 60s.
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const pageSlug = `brand:${slug}:menu`
  const [concept, layout, menu] = await Promise.all([resolveConcept(slug), fetchSiteLayout(pageSlug), fetchBrandMenu(slug)])
  if (!concept) notFound()

  const name = formatBrandName(concept.name)
  const seo = pageSeo(layout)
  // The menu's own intro (brand.menu "Line", flipd.menu "Intro") — the
  // owner's words — after a line that says whose menu and where it is.
  const lead = leadText(pageBlocks(pageSlug, layout), brandCtx(pageSlug, concept))
  const sections = menu.filter((c) => (c.items?.length ?? 0) > 0).map((c) => c.name.trim()).filter(Boolean)
  const description = seo.description ?? fitSentences([
    `${name} menu — ${brandDescriptor(locationFromConcept(concept))}.`,
    lead,
    sections.length ? `On the menu: ${joinNames(sections.slice(0, 5), 'and')}.` : '',
    asSentence(concept.description),
  ], 155)

  return brandPageMetadata({ concept, path: 'menu', title: seo.title ?? SUBPAGE_TITLE.menu, description })
}

export default async function BrandMenuPage({ params }: Params) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const [concepts, menu] = await Promise.all([fetchLiveConcepts(), fetchBrandMenu(slug)])
  const concept = findConceptOrThrow(slug, concepts)
  if (!concept) notFound()

  const ld: Record<string, unknown>[] = [brandBreadcrumb(concept, SUBPAGE_TITLE.menu, 'menu')]
  if (hasMenuItems(menu)) {
    ld.push(menuSchema({
      loc: locationFromConcept(concept),
      sections: menu.map((c) => ({ name: c.name, items: c.items ?? [] })),
    }))
  }

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <ManagedPage slug={`brand:${slug}:menu`} {...(concepts.length ? { concepts } : {})} />
    </>
  )
}
