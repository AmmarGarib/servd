// Per-brand ordering page (/<concept>). A server component so the page's
// heading AND its menu are in the server HTML: it resolves the brand, reads
// its menu (orderingData.ts) and hands both to the client ordering screen
// (OrderingScreen.tsx), which paints the hero and the dishes, prices and
// sections from them, then refreshes the menu in the browser (availability)
// and runs the basket exactly as before.
//
// lookupConcept is the same no-store GET /storefront/concepts the layout makes
// (Next memoises it within the request), so this costs no extra API call.
// 'missing' is a 404 (below). 'unverified' (the API
// didn't answer and the slug isn't a bundled brand) passes null, and the
// screen names the page from the slug until its own lookup. A menu the server
// couldn't read passes null too: the screen shows its skeleton and fetches.
//
// Structured data (search engines + AI answers): the brand's Restaurant node
// (same @id as on its own domain), its Menu node when a menu is published,
// and a breadcrumb servd › Order <brand>. Never for a test company's brand
// (reachable by link only, not a real restaurant to list).

// The 404 for a slug that is not a brand, and the page's own title / description / canonical, live here (they were
// in a `(menu)` route-group layout until 2026-11-23: a folder name with brackets put "(menu)" in the page's script
// address, which some requests reached as %28menu%29 and got a 404, so the ordering screen showed "Something broke").
// It 404s only when the API ANSWERED without the slug; an API that did not answer renders as before.
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'
import { filled, locationFromConcept } from '../../lib/brandLocations'
import { formatBrandName, type Concept } from '../../lib/concept'
import { brandImageUrl, breadcrumbSchema, jsonLdScript, menuSchema, restaurantSchema } from '../../lib/jsonLd'
import { asSentence, fitSentences, lookupConcept, fetchLiveConcepts, isServdCompanyBrand } from '../../lib/liveConcepts'
import OrderingScreen, { type OrderingConcept, type OrderingMenu } from './OrderingScreen'
import { fetchOrderingMenu } from './orderingData'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ concept: string }> }

export default async function ConceptOrderPage({ params }: Params) {
  const { concept: slug } = await params
  const [{ status, concept }, initialMenu] = await Promise.all([lookupConcept(slug), fetchOrderingMenu(slug)])
  if (status === 'missing') notFound()
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

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { concept: slug } = await params
  const { status, concept } = await lookupConcept(slug)
  if (status === 'missing') notFound()
  // The API didn't answer and this isn't a bundled brand: render (above), but
  // keep an unconfirmed path out of the index until the API can vouch for it.
  if (!concept) return { title: 'Order online', robots: { index: false, follow: true } }

  const name = formatBrandName(concept.name)
  const loc = locationFromConcept(concept)
  const city = filled(loc.city) || 'Karachi'
  // 'DHA Phase 6, Karachi' — the district (last part of the area) keeps the
  // lead sentence short enough to leave room for the brand's description.
  // (An area typed as '…, Karachi' would otherwise read 'Karachi, Karachi'.)
  const district = filled(loc.area).split(',').map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== city.toLowerCase()).slice(-1)[0] ?? ''
  const place = [district, city].filter(Boolean).join(', ')
  return pageMetadata({
    // Distinct from the microsite's own title ('Stackd' on stackd.pk): this
    // is the ordering screen. The city is the brand's own, as in the
    // description.
    title:       `Order ${name} online in ${city}`,
    // Live data: the brand's own description (admin → Marketing → Brands)
    // and its kitchen's area.
    description: fitSentences([
      `Order ${name} online from ${place}.`,
      asSentence(concept.description),
      'Check out once on servd.',
    ]),
    canonical:   `${SERVD_ORIGIN}/${concept.slug}`,
    image:       brandImageUrl(concept.slug),
  })
}
