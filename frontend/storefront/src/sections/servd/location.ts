// The location a /locations/[loc] section renders (servd:location is one
// template for every location: the route passes params={{ loc }}).

import { addressLine, fetchBrandLocations, filled, LEGACY_LOCATION_SLUGS, type BrandLocation } from '../../lib/brandLocations'
import { brandStory, formatBrandName } from '../../lib/concept'
import { BrandListUnavailableError, fetchConceptList } from '../../lib/liveConcepts'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

/**
 * Match by locationSlug first (operator-friendly URL like
 * /locations/ittehad-commercial), fall back to the concept slug
 * (/locations/simmer). A retired slug (e.g. bukhari-commercial, still on old
 * links/GBP) resolves to its brand. Undefined when nothing matches.
 */
export async function findLocation(loc: string | undefined): Promise<BrandLocation | undefined> {
  if (!loc) return undefined
  // The same GET twice — Next memoises it within the request.
  const [brands, list] = await Promise.all([fetchBrandLocations(API_URL), fetchConceptList()])
  const want = LEGACY_LOCATION_SLUGS[loc] ?? loc
  const found = Object.values(brands).find((b) => b.locationSlug === want || b.slug === want)
  // Not a bundled brand's, and the API didn't answer: a 500 search engines
  // retry, not a 404 that drops another company's location page from Google.
  if (!found && !list?.length) throw new BrandListUnavailableError(loc)
  return found
}

const PLACEHOLDER = /\{(name|area|district|city|address|street|tagline)\}/g
// Stands in for a placeholder with no value, so the separator next to it can
// go with it. A control character never typed into a template.
const EMPTY = '\u0000'
// " · ", ", ", " | ", " — ", " – ", " - " (spacing optional).
const SEP = String.raw`\s*[·,|—–-]\s*`
// Neighbouring empties ("{area} · {district}") act as one.
const EMPTY_RUN = new RegExp(`${EMPTY}(?:${SEP}${EMPTY})+`, 'g')
const EMPTY_WITH_SEPS = new RegExp(`(${SEP})?${EMPTY}(${SEP})?`, 'g')

/**
 * Fills {name} {area} {district} {city} {address} {street} {tagline}.
 *
 * Only real values go in: an unfilled address part (TODO_FILL_…, empty) is
 * left out, and the separator next to it goes too — "{name} · {area}" reads
 * "Flipd", not "Flipd · TODO_FILL_AREA" or "Flipd · ". Between two values one
 * separator is kept ("A · {area} · C" → "A · C").
 */
export function fillLocation(template: string, b: BrandLocation): string {
  const area = filled(b.area)
  const values: Record<string, string> = {
    name: formatBrandName(b.name),
    area,
    district: area.split(',').slice(-1)[0]?.trim() ?? '',
    city: filled(b.city),
    address: addressLine(b),
    street: filled(b.street),
    tagline: brandStory(b.slug).tagline,
  }
  return template
    .replace(PLACEHOLDER, (_, k: string) => values[k] || EMPTY)
    .replace(EMPTY_RUN, EMPTY)
    .replace(EMPTY_WITH_SEPS, (_, before?: string, after?: string) => (before && after ? before : ''))
    .replace(/ {2,}/g, ' ')
    .trim()
}
