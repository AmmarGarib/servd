// /reserve/<brand> — server shell around the booking widget (ReserveScreen,
// a client component). The server adds what search engines and AI answers
// read from the first HTML:
//
//   • a short factual paragraph — who the brand is, where, opening hours, a
//     phone number when one is on file, and how booking works — built from the
//     live brand record (admin → Marketing → Brands), never invented copy.
//     Unfilled values (filled()) are left out rather than shown as gaps.
//   • JSON-LD: the brand's Restaurant node (same @id as on its own domain and
//     /home, so it is the same entity) with a ReserveAction pointing at this
//     page, and a breadcrumb servd › Reserve › <brand>.
//
// A brand that takes no bookings (reservationsEnabled false) gets neither: the
// widget shows "not available" and the layout marks the page noindex. A test
// company's brand gets neither either (link-only, not a real restaurant).
// The layout already 404s a slug that isn't a brand.

import { SERVD_ORIGIN } from '../../../lib/brandDomains'
import { filled, locationFromConcept, type BrandLocation } from '../../../lib/brandLocations'
import { formatBrandName, type ServiceHourSlot } from '../../../lib/concept'
import { breadcrumbSchema, jsonLdScript, restaurantSchema } from '../../../lib/jsonLd'
import { fetchLiveConcepts, isServdCompanyBrand, lookupConcept } from '../../../lib/liveConcepts'
import { brandDescriptor, cityOf } from '../../brand/[slug]/meta'
import { liveSectionFields } from '../../../sections/liveFields'
import { str } from '../../../sections/safe'
import { BlockedNotice } from '../../../components/account/BlockedNotice'
import ReserveScreen from './ReserveScreen'
import { MAX_PARTY } from './partySizes'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ slug: string }> | { slug: string } }


export default async function ReserveBrandPage({ params }: Params) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const { concept } = await lookupConcept(slug)
  if (!concept) return <ReserveScreen />

  const name = formatBrandName(concept.name)
  const takesBookings = concept.reservationsEnabled !== false
  if (!takesBookings || concept.isTestCompany === true) return <ReserveScreen brandName={name} />

  const loc = locationFromConcept(concept)
  const canonical = `${SERVD_ORIGIN}/reserve/${concept.slug}`
  const live = await fetchLiveConcepts()

  const restaurant = restaurantSchema({ loc, ownedByServd: isServdCompanyBrand(concept.slug, live) })
  // Ordering stays an action alongside booking (restaurantSchema's OrderAction).
  restaurant['potentialAction'] = [
    restaurant['potentialAction'],
    {
      '@type': 'ReserveAction',
      target: {
        '@type':        'EntryPoint',
        urlTemplate:    canonical,
        inLanguage:     'en',
        actionPlatform: ['https://schema.org/DesktopWebPlatform', 'https://schema.org/MobileWebPlatform'],
      },
      result: { '@type': 'FoodEstablishmentReservation', name: `Table at ${name}` },
    },
  ].filter(Boolean)
  const ld = [
    restaurant,
    breadcrumbSchema([
      { name: 'servd',   url: `${SERVD_ORIGIN}/` },
      { name: 'Reserve', url: `${SERVD_ORIGIN}/reserve` },
      { name,            url: canonical },
    ]),
  ]

  // The sentences' words are the servd:reserve page's picker section fields
  // (Admin → Storefront), today's text as the spec defaults.
  const words = await liveSectionFields('servd:reserve', 'servd.reservePicker')
  const intro = (
    <p data-reserve-intro style={{ color: 'var(--servd-mute)', fontSize: '0.92rem', lineHeight: 1.55, maxWidth: '40rem', marginTop: '0.75rem' }}>
      {factualParagraph(name, loc, {
        address: str(words['introAddress']), phone: str(words['introPhone']), booking: str(words['introBooking']),
      })}
    </p>
  )

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <BlockedNotice conceptSlug={concept.slug} className="container-narrow" style={{ paddingTop: '1rem' }} />
      <ReserveScreen brandName={name} intro={intro} />
    </>
  )
}

/** "Simmer — small plates in DHA Phase 6, Karachi. The address is 42/C, …. Open
 *  every day, 6 pm to 1 am. Phone +92 …. Book a table online for 1 to 20
 *  people: …" — plain facts from the brand record, no exclamation marks
 *  (Simmer's rules hold on every page that names it). */
function factualParagraph(name: string, loc: BrandLocation, words: { address: string; phone: string; booking: string }): string {
  const parts: string[] = [`${name} — ${brandDescriptor(loc)}.`]
  // The full address only when a street is on file (the area alone is
  // already in the line above).
  const street = filled(loc.street)
  if (street && words.address.trim()) parts.push(words.address.trim().replace(/\{address\}/g, [street, filled(loc.area), cityOf(loc)].filter(Boolean).join(', ')))
  const hours = hoursSentence(loc.hours ?? [])
  if (hours) parts.push(hours)
  const phone = filled(loc.phone)
  if (phone && words.phone.trim()) parts.push(words.phone.trim().replace(/\{phone\}/g, phone))
  if (words.booking.trim()) parts.push(words.booking.trim().replace(/\{max\}/g, String(MAX_PARTY)))
  return parts.join(' ')
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function clock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  const h = Math.floor(m / 60)
  const mm = m % 60
  const suffix = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return mm ? `${h12}:${String(mm).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`
}

/** Opening hours as one sentence; '' when none are entered. */
function hoursSentence(slots: ServiceHourSlot[]): string {
  const valid = slots.filter((s) => s.dayOfWeek >= 0 && s.dayOfWeek <= 6 && s.closeMin !== s.openMin)
  if (valid.length === 0) return ''
  const byDay = new Map<number, string>()
  for (const s of [...valid].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.openMin - b.openMin)) {
    const w = `${clock(s.openMin)} to ${clock(s.closeMin)}`
    byDay.set(s.dayOfWeek, byDay.has(s.dayOfWeek) ? `${byDay.get(s.dayOfWeek)} and ${w}` : w)
  }
  const windows = new Set(byDay.values())
  if (byDay.size === 7 && windows.size === 1) return `Open every day, ${[...windows][0]}.`
  // Monday first, as a week reads.
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => byDay.has(d))
  return `Open ${order.map((d) => `${DAY[d]} ${byDay.get(d)}`).join('; ')}.`
}
