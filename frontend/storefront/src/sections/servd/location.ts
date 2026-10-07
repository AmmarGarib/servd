// The location a /locations/[loc] section renders (servd:location is one
// template for every location: the route passes params={{ loc }}).

import { addressLine, fetchBrandLocations, LEGACY_LOCATION_SLUGS, type BrandLocation } from '../../lib/brandLocations'
import { brandStory, formatBrandName } from '../../lib/concept'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

/**
 * Match by locationSlug first (operator-friendly URL like
 * /locations/ittehad-commercial), fall back to the concept slug
 * (/locations/simmer). A retired slug (e.g. bukhari-commercial, still on old
 * links/GBP) resolves to its brand. Undefined when nothing matches.
 */
export async function findLocation(loc: string | undefined): Promise<BrandLocation | undefined> {
  if (!loc) return undefined
  const brands = await fetchBrandLocations(API_URL)
  const want = LEGACY_LOCATION_SLUGS[loc] ?? loc
  return Object.values(brands).find((b) => b.locationSlug === want || b.slug === want)
}

/** Fills {name} {area} {district} {city} {address} {street} {tagline}. */
export function fillLocation(template: string, b: BrandLocation): string {
  const values: Record<string, string> = {
    name: formatBrandName(b.name),
    area: b.area,
    district: b.area.split(',').slice(-1)[0]?.trim() ?? '',
    city: b.city,
    address: addressLine(b),
    street: b.street.startsWith('TODO') ? '' : b.street,
    tagline: brandStory(b.slug).tagline,
  }
  return template.replace(/\{(name|area|district|city|address|street|tagline)\}/g, (_, k: string) => values[k] ?? '')
}
