// Brand microsite home — the SiteLayout `brand:<slug>`, edited in Admin →
// Storefront. Nothing published → the brand's default sections (its bespoke
// design with today's content, from src/sections/<brand>). Title, canonical
// and share card come from the brand layout (./layout.tsx).

import { notFound } from 'next/navigation'
import { brandAccent, formatBrandName, type Concept } from '../../../lib/concept'
import { ManagedPage } from '../../../sections/ManagedPage'
import { getLiveKits } from '../../../lib/brandKitFetch'
import ConceptViewTracker from '../../../components/ConceptViewTracker'
import { locationFromConcept } from '../../../lib/brandLocations'
import { brandCanonical } from '../../../lib/brandDomains'
import { restaurantSchema, websiteSchema, jsonLdScript } from '../../../lib/jsonLd'
import { conceptsOrFallback, fetchLiveConcepts, findConceptOrThrow, isServdCompanyBrand } from '../../../lib/liveConcepts'
import { fetchBrandMenu, hasMenuItems } from '../../../sections/data'
import type { Params } from './meta'

export const dynamic = 'force-dynamic'

export default async function BrandHome({ params }: Params) {
  const { slug } = await params

  const [live, menu, kits] = await Promise.all([fetchLiveConcepts(), fetchBrandMenu(slug), getLiveKits()])
  const found = findConceptOrThrow(slug, live)
  if (!found) notFound()
  // API empty/down → the bundled brand records, so the cross-brand sections
  // still have a list to draw from.
  const concepts = conceptsOrFallback(live)
  const concept: Concept = { ...found, primaryColor: brandAccent(found.slug, found.primaryColor, kits) }

  // JSON-LD: the brand's Restaurant (its own description, hours and address
  // from the live Concept row — the same node /home and /locations emit, by
  // @id) and the brand site's WebSite node, which gives Google the site name
  // for stackd.pk / simmer.pk / flipd.pk. The Restaurant points at its Menu
  // node only when a menu is published (the menu page emits that node). No
  // breadcrumb here: a one-level trail says nothing.
  const ours = isServdCompanyBrand(slug, live)
  const ld = [
    restaurantSchema({ loc: locationFromConcept(concept), hasMenu: hasMenuItems(menu), ownedByServd: ours }),
    websiteSchema({ name: formatBrandName(concept.name), url: brandCanonical(slug), ownedByServd: ours }),
  ]

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <ConceptViewTracker conceptId={concept.id} slug={slug} />
      <ManagedPage slug={`brand:${slug}`} concepts={concepts} />
    </>
  )
}
