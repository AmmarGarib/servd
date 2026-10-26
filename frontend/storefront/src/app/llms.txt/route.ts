// /llms.txt — a plain-text map of the site for language models
// (https://llmstxt.org): what the site is, and the URLs worth reading.
//
// Per host, like robots.txt and the sitemap. servd.pk describes servd and
// lists every kitchen on it; stackd.pk / simmer.pk / flipd.pk describe that
// one brand. Built from the live Concept rows (admin → Marketing → Brands) on
// every request, so a brand's description, address or booking switch is
// current here too; FALLBACK_CONCEPTS covers an API outage.
//
// This is a route handler rather than a page: without it /llms.txt fell into
// the [concept] ordering screen as a brand called "llms.txt" — an indexable
// 200 HTML page on every host.

import type { NextRequest } from 'next/server'
import { BRAND_ORIGIN, SERVD_ORIGIN, brandCanonical, brandOrigin, hostBrand } from '../../lib/brandDomains'
import { filled, isPublishableLocation, locationFromConcept, type BrandLocation } from '../../lib/brandLocations'
import { formatBrandName, type Concept } from '../../lib/concept'
import { conceptsOrFallback, fetchLiveConcepts, findConcept } from '../../lib/liveConcepts'
import { simmerText } from '../../sections/simmer/shared'
import { hoursSummary, priceWords } from '../../sections/servd/brandFacts'

const SERVD_EMAIL = 'servd@gsfoods.pk'

export const dynamic = 'force-dynamic'


interface Brand {
  slug: string
  name: string
  description: string
  loc: BrandLocation
  /** Opening hours on file ('' = none; never invented). */
  hours: string
}

/** One line of text. Simmer's copy keeps Simmer's rules (no exclamation
 *  marks, no emoji) wherever it appears. */
function oneLine(slug: string, text: string | null | undefined): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim()
  return slug === 'simmer' ? simmerText(s) : s
}

/** Text safe inside a markdown link label. */
function label(text: string): string {
  return text.replace(/[[\]]/g, '')
}

function toBrand(c: Concept): Brand {
  const loc = locationFromConcept(c)
  return {
    slug: c.slug,
    name: formatBrandName(c.name),
    // The bundled record's line when the live row has none (findConcept with
    // no live rows looks only there, own properties only).
    description: oneLine(c.slug, c.description || findConcept(c.slug, [])?.description),
    loc,
    hours: hoursSummary(c.serviceHours),
  }
}

/** "Ittehad Commercial, DHA Phase 6, Karachi" — only the parts on file. */
function place(loc: BrandLocation): string {
  return [filled(loc.area), filled(loc.city)].filter(Boolean).join(', ')
}

/** "Simmer, Stackd and Flipd". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** " Cuisine, price range, area, hours." — only what is on file. */
function facts(b: Brand): string {
  const bits = [
    filled(b.loc.cuisine) && `${filled(b.loc.cuisine)}`,
    filled(b.loc.priceRange) && `price range ${priceWords(b.loc.priceRange)}`,
    place(b.loc),
    b.hours && `open ${b.hours} (Karachi time)`,
    filled(b.loc.phone) && `phone ${filled(b.loc.phone)}`,
  ].filter(Boolean)
  return bits.length ? ` (${bits.join('; ')})` : ''
}

function servdText(brands: Brand[]): string {
  const names = listNames(brands.map((b) => b.name))
  const reservable = brands.filter((b) => b.loc.acceptsReservations)
  const out: string[] = [
    '# servd',
    '',
    `> servd is GS Foods' online ordering platform in Karachi, Pakistan: one place to order from ${names}, see each kitchen's menu,${reservable.length ? ' book a table,' : ''} and join Insiders for rewards on every order.`,
    '',
    'servd is run by GS Foods, a restaurant group in Karachi. Each kitchen has its own site for its menu, story and address; ordering for every kitchen happens on servd.',
    '',
    '## Kitchens',
    '',
    ...brands.map((b) => `- [${label(b.name)}](${brandCanonical(b.slug)})${b.description ? `: ${b.description}` : ''}${facts(b)}`),
    '',
    '## Menus and ordering',
    '',
    `- [servd home](${SERVD_ORIGIN}/): every kitchen on servd in one place`,
    `- [Full menus, prices and details](${SERVD_ORIGIN}/llms-full.txt): every kitchen's complete menu in PKR, addresses, hours, phones and the FAQ in one plain-text file`,
    ...brands.flatMap((b) => [
      `- [${label(b.name)} menu](${brandCanonical(b.slug, 'menu')}): the ${label(b.name)} menu`,
      `- [Order from ${label(b.name)}](${SERVD_ORIGIN}/${b.slug}): order online on servd`,
    ]),
    '',
    '## Reservations',
    '',
    `- [Book a table](${SERVD_ORIGIN}/reserve): pick a kitchen, a date and a time${reservable.length ? ` (taking bookings: ${listNames(reservable.map((b) => b.name))})` : ''}`,
    ...reservable.map((b) => `- [Book at ${label(b.name)}](${SERVD_ORIGIN}/reserve/${b.slug})`),
    `- [Waitlist](${SERVD_ORIGIN}/waitlist): hear first when a new kitchen opens on servd`,
  ]

  const located = brands.filter((b) => isPublishableLocation(b.loc))
  if (located.length) {
    out.push('', '## Locations', '')
    for (const b of located) {
      out.push(`- [${label(b.name)}, ${label(place(b.loc))}](${SERVD_ORIGIN}/locations/${b.loc.locationSlug})`)
    }
  }

  out.push(
    '',
    '## About servd',
    '',
    `- [What is servd](${SERVD_ORIGIN}/about): who servd is and the kitchens on it`,
    `- [FAQ](${SERVD_ORIGIN}/faq): ordering, delivery, payment (Cash, Card, Raast QR), Insiders rewards, reservations and refunds`,
    `- [Contact](${SERVD_ORIGIN}/contact): contact servd`,
    `- [Press](${SERVD_ORIGIN}/press): press information and media contact`,
    `- [Email servd](mailto:${SERVD_EMAIL}): ${SERVD_EMAIL}`,
    '',
  )
  return out.join('\n')
}

function brandText(b: Brand): string {
  const where = place(b.loc)
  const email = filled(b.loc.email)
  const out: string[] = [
    `# ${b.name}`,
    '',
    ...(b.description ? [`> ${b.description}`, ''] : []),
    `${b.name} is in ${where || 'Karachi'}.${filled(b.loc.cuisine) ? ` Cuisine: ${filled(b.loc.cuisine)}.` : ''} Orders are taken online through servd (${SERVD_ORIGIN}/), GS Foods' ordering platform in Karachi.`,
    '',
    '## At a glance',
    '',
    `- Address: ${[filled(b.loc.street), place(b.loc)].filter(Boolean).join(', ') || 'Karachi, Pakistan'}`,
    `- Opening hours (Karachi time): ${b.hours || 'not listed'}`,
    `- Phone: ${filled(b.loc.phone) || 'not listed'}`,
    ...(filled(b.loc.priceRange) ? [`- Price range: ${priceWords(b.loc.priceRange)}`] : []),
    '',
    '## Pages',
    '',
    `- [Home](${brandCanonical(b.slug)}): ${label(b.name)}'s website`,
    `- [Menu](${brandCanonical(b.slug, 'menu')}): the ${label(b.name)} menu`,
    `- [About](${brandCanonical(b.slug, 'about')}): the story behind ${label(b.name)}`,
    `- [Visit](${brandCanonical(b.slug, 'visit')}): address, opening hours and directions`,
    '',
    '## Order and book',
    '',
    `- [Order online](${SERVD_ORIGIN}/${b.slug}): order from ${label(b.name)} on servd`,
    `- [Full menu and details](${brandOrigin(b.slug)}/llms-full.txt): the complete ${label(b.name)} menu in PKR, address, hours, phone and the FAQ in one plain-text file`,
    `- [FAQ](${SERVD_ORIGIN}/faq): ordering, delivery, payment, rewards, reservations and refunds`,
    ...(b.loc.acceptsReservations
      ? [`- [Book a table](${SERVD_ORIGIN}/reserve/${b.slug}): reserve at ${label(b.name)}`]
      : []),
    ...(isPublishableLocation(b.loc)
      ? [`- [Location](${SERVD_ORIGIN}/locations/${b.loc.locationSlug}): ${label(b.name)} on the map`]
      : []),
  ]
  out.push('', '## Contact', '', `- [Contact servd](${SERVD_ORIGIN}/contact)`)
  if (email) out.push(`- [Email ${label(b.name)}](mailto:${email}): ${email}`)
  out.push('')
  return out.join('\n')
}

export async function GET(req: NextRequest) {
  const [slug, live] = await Promise.all([hostBrand(req.headers.get('host') ?? ''), fetchLiveConcepts()])
  const brands = conceptsOrFallback(live).map(toBrand)
  // A brand host gets its own brand (live, else the bundled record); any
  // other slug — unknown, or a prototype key like constructor.localhost —
  // falls back to servd's file.
  const ownConcept = slug ? findConcept(slug, live) : null
  const own = ownConcept ? toBrand(ownConcept) : undefined

  return new Response(own ? brandText(own) : servdText(brands), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      // For language models, not for the search results page.
      'X-Robots-Tag': 'noindex',
    },
  })
}
