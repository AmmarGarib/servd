// Per-brand ordering page (/<concept>). A server component so the page's
// heading AND its menu are in the server HTML: it resolves the brand, reads
// its menu (orderingData.ts) and hands both to the client ordering screen
// (OrderingScreen.tsx), which paints the hero and the dishes, prices and
// sections from them, then refreshes the menu in the browser (availability)
// and runs the basket exactly as before.
//
// lookupConcept is the same no-store GET /storefront/concepts the layout makes
// (Next memoises it within the request), so this costs no extra API call.
// 'missing' never reaches here — the layout 404s it. 'unverified' (the API
// didn't answer and the slug isn't a bundled brand) passes null, and the
// screen names the page from the slug until its own lookup. A menu the server
// couldn't read passes null too: the screen shows its skeleton and fetches.
//
// Structured data (search engines + AI answers): the brand's Restaurant node
// (same @id as on its own domain), its Menu node when a menu is published,
// and a breadcrumb servd › Order <brand>. Never for a test company's brand
// (reachable by link only, not a real restaurant to list).

import { SERVD_ORIGIN } from '../../../lib/brandDomains'
import { locationFromConcept } from '../../../lib/brandLocations'
import { formatBrandName, type Concept } from '../../../lib/concept'
import { breadcrumbSchema, jsonLdScript, menuSchema, restaurantSchema } from '../../../lib/jsonLd'
import { fetchLiveConcepts, isServdCompanyBrand, lookupConcept } from '../../../lib/liveConcepts'
import OrderingScreen, { type OrderingConcept, type OrderingMenu } from './OrderingScreen'
import { fetchOrderingMenu } from './orderingData'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ concept: string }> }

export default async function ConceptOrderPage({ params }: Params) {
  const { concept: slug } = await params
  const [{ status, concept }, initialMenu] = await Promise.all([lookupConcept(slug), fetchOrderingMenu(slug)])
  // Only the fields the hero needs, so the props stay small and serialisable
  // (the live record also carries hours, contacts and coordinates).
  const initialConcept: OrderingConcept | null = concept && {
    id:           concept.id,
    slug:         concept.slug,
    name:         concept.name,
    type:         concept.type,
    description:  concept.description ?? null,
    logoUrl:      concept.logoUrl ?? null,
    primaryColor: concept.primaryColor ?? null,
    // false hides "Book a table" on a table-only brand that takes no bookings.
    reservationsEnabled: concept.reservationsEnabled,
    isTestCompany: concept.isTestCompany === true,
  }

  const isTest = concept?.isTestCompany === true || initialMenu?.isTestCompany === true
  const ld = concept && !isTest ? await orderingJsonLd(concept, initialMenu) : null

  // Keyed on the slug so moving between brands starts a fresh screen.
  // 'fallback' is the bundled record (the server's lookup got no answer —
  // often the API's shared per-IP rate limit, which the browser's own request
  // doesn't share): the screen still asks for the live record.
  return (
    <>
      {ld && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />}
      <OrderingScreen key={slug} initialConcept={initialConcept} initialMenu={initialMenu} verified={status === 'live'} />
    </>
  )
}

async function orderingJsonLd(concept: Concept, menu: OrderingMenu | null): Promise<Record<string, unknown>[]> {
  // Memoised by Next within the request (the same GET lookupConcept made).
  const live = await fetchLiveConcepts()
  const loc = locationFromConcept(concept)
  const sections = (menu?.categories ?? [])
    .map((c) => ({ name: c.name, items: c.items ?? [] }))
    .filter((s) => s.items.length > 0)
  const hasMenu = sections.length > 0
  const ld: Record<string, unknown>[] = [
    restaurantSchema({ loc, hasMenu, ownedByServd: isServdCompanyBrand(concept.slug, live) }),
  ]
  if (hasMenu) ld.push(menuSchema({ loc, sections }))
  ld.push(breadcrumbSchema([
    { name: 'servd', url: `${SERVD_ORIGIN}/` },
    { name: `Order ${formatBrandName(concept.name)}`, url: `${SERVD_ORIGIN}/${concept.slug}` },
  ]))
  return ld
}
