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
import { Breadcrumbs } from '../../../../components/Breadcrumbs'
import { fetchSiteLayout, pageSeo } from '../../../../lib/blocks'
import { locationFromConcept } from '../../../../lib/brandLocations'
import { brandSurface, formatBrandName } from '../../../../lib/concept'
import { brandCanonical } from '../../../../lib/brandDomains'
import { jsonLdScript, menuSchema } from '../../../../lib/jsonLd'
import { asSentence, fetchLiveConcepts, findConceptOrThrow, fitSentences, joinNames, resolveConcept } from '../../../../lib/liveConcepts'
import { fetchBrandMenu, hasMenuItems } from '../../../../sections/data'
import { ManagedPage } from '../../../../sections/ManagedPage'
import { SUBPAGE_TITLE, brandCtx, brandPageMetadata, leadText, pageBlocks, brandDescriptor, type Params } from '../meta'

// Force-dynamic + no-store so a single bad fetch at first request
// doesn't get baked into the ISR cache for the next 60s.
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const pageSlug = `brand:${slug}:menu`
  const [concept, layout, menu] = await Promise.all([resolveConcept(slug), fetchSiteLayout(pageSlug), fetchBrandMenu(slug)])
  if (!concept) notFound()

  const name = formatBrandName(concept.name)
  const seo = pageSeo(layout)
  // The menu's own intro (brand.menu "Line", flipd.menu "Intro") — the
  // owner's words — after a line that says whose menu and where it is.
  const lead = leadText((await pageBlocks(pageSlug, layout)), brandCtx(pageSlug, concept))
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
  const { slug } = await params
  const [concepts, menu] = await Promise.all([fetchLiveConcepts(), fetchBrandMenu(slug)])
  const concept = findConceptOrThrow(slug, concepts)
  if (!concept) notFound()

  const ld: Record<string, unknown>[] = []
  if (hasMenuItems(menu)) {
    ld.push(menuSchema({
      loc: locationFromConcept(concept),
      sections: menu.map((c) => ({ name: c.name, items: c.items ?? [] })),
    }))
  }

  return (
    <>
      {ld.length > 0 && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />}
      <ManagedPage slug={`brand:${slug}:menu`} {...(concepts.length ? { concepts } : {})} />
      {/* The visible trail sits under the page, above the footer (Apple-style):
          the top of every brand page is its own header — Flipd's is fixed and
          would sit on top of it. */}
      <Breadcrumbs color={brandSurface(slug).text} items={[
        { name: formatBrandName(concept.name), href: brandCanonical(slug) },
        { name: SUBPAGE_TITLE.menu, href: brandCanonical(slug, 'menu') },
      ]} />
    </>
  )
}
