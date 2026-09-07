// Canonical name + address + phone per brand, with a hardcoded fallback
// shape but the live values pulled from the admin-editable Concept fields.
//
// Per the local-seo skill in the marketing bundle: NAP (name, address,
// phone) MUST be byte-identical across Google Business Profile, the
// website, Instagram bio, foodpanda, Zomato, and every directory.
// Inconsistent NAP dilutes Maps prominence. So there's exactly one place
// — the Concept row, edited from the CEO dashboard — that holds the
// canonical strings; everything downstream (schema.org JSON-LD, footer,
// brand microsite address line, /locations geo pages, "message us"
// WhatsApp links) reads from here.
//
// The DEFAULT_BRAND_LOCATIONS block below is a fallback used when the
// operator hasn't filled the admin fields yet — clearly marked TODO_FILL
// so a wrong value can't silently ship to Google.

import type { Concept } from './concept'

export interface BrandLocation {
  slug:                string
  name:                string
  street:              string                // street address line (Concept.address)
  area:                string                // neighborhood (Concept.addressLocality)
  city:                string                // "Karachi" — operator-wide for now
  postalCode?:         string
  country:             string                // "Pakistan"
  phone:               string                // E.164, with +
  whatsapp:            string                // digits only, no +
  geo:                 { lat: number; lng: number }
  cuisine:             string
  priceRange:          string                // $ / $$ / $$$ / $$$$ for schema.org
  acceptsReservations: boolean
  locationSlug:        string                // /locations/<slug>
  // Operator's Google Maps share link. When set, the brand nav's "Visit"
  // goes straight here (new tab) instead of the internal /visit page —
  // one tap to directions is what a visitor actually wants from that word.
  mapsUrl?:            string
}

const DEFAULT_BRAND_LOCATIONS: Record<string, BrandLocation> = {
  simmer: {
    slug:                'simmer',
    name:                'Simmer',
    street:              'TODO_FILL_STREET',
    area:                'Ittehad Commercial, DHA Phase 6',
    city:                'Karachi',
    country:             'Pakistan',
    phone:               '+923001234567',
    whatsapp:            '923001234567',
    // Pinned from the operator's Google Maps link (maps.app.goo.gl/gJQMwRKsZdEEfoKV6).
    geo:                 { lat: 24.8014954, lng: 67.0735636 },
    cuisine:             'Small plates',
    priceRange:          '$$$',
    acceptsReservations: true,
    locationSlug:        'ittehad-commercial',
    mapsUrl:             'https://maps.app.goo.gl/gJQMwRKsZdEEfoKV6',
  },
  stax: {
    slug:                'stax',
    name:                'Stax',
    street:              'TODO_FILL_STREET',
    area:                'Ittehad Commercial, DHA Phase 6',
    city:                'Karachi',
    country:             'Pakistan',
    phone:               '+923001234568',
    whatsapp:            '923001234568',
    // Pinned from the operator's Google Maps link (maps.app.goo.gl/wa3fEKMevo1CZhkS8).
    geo:                 { lat: 24.8015505, lng: 67.0735747 },
    cuisine:             'Smash burger',
    priceRange:          '$$',
    acceptsReservations: false,
    locationSlug:        'stax-kitchen',
    mapsUrl:             'https://maps.app.goo.gl/wa3fEKMevo1CZhkS8',
  },
  flipd: {
    slug:                'flipd',
    name:                'Flipd',
    street:              'TODO_FILL_STREET',
    area:                'TODO_FILL_AREA',
    city:                'Karachi',
    country:             'Pakistan',
    phone:               '+923001234569',
    whatsapp:            '923001234569',
    geo:                 { lat: 24.8054, lng: 67.0517 },
    cuisine:             'Fried chicken',
    priceRange:          '$$',
    acceptsReservations: false,
    locationSlug:        'flipd-court',
  },
}

const PRICE_TIER_TO_RANGE: Record<string, string> = {
  budget:  '$',
  mid:     '$$',
  premium: '$$$',
  luxury:  '$$$$',
}

/**
 * Build a BrandLocation from a live Concept row + the fallback baseline.
 * Live admin-edited values win; missing values fall back to the defaults
 * so the storefront still renders sensibly during a partial setup.
 */
export function locationFromConcept(c: Concept): BrandLocation {
  const base = DEFAULT_BRAND_LOCATIONS[c.slug] ?? {
    slug:                c.slug,
    name:                c.name,
    street:              'TODO_FILL_STREET',
    area:                'TODO_FILL_AREA',
    city:                'Karachi',
    country:             'Pakistan',
    phone:               '',
    whatsapp:            '',
    geo:                 { lat: 24.8607, lng: 67.0011 },  // Karachi centroid
    cuisine:             'Restaurant',
    priceRange:          '$$',
    acceptsReservations: c.reservationsEnabled !== false,
    locationSlug:        c.slug,
  }

  // Normalise the operator's WhatsApp input: strip spaces, strip leading +
  // so the value is wa.me-ready. Falls back to phone digits if WhatsApp is
  // unset and the public dial number is a WhatsApp Business one (common).
  const whatsappDigits = (c.whatsapp ?? c.phone ?? '').replace(/[^\d]/g, '')

  return {
    ...base,
    slug:                c.slug,
    name:                c.name,
    street:              c.address ?? base.street,
    area:                c.addressLocality ?? base.area,
    phone:               c.phone ?? base.phone,
    whatsapp:            whatsappDigits || base.whatsapp,
    geo: (c.latitude != null && c.longitude != null)
      ? { lat: c.latitude, lng: c.longitude }
      : base.geo,
    cuisine:             c.cuisine ?? base.cuisine,
    priceRange:          (c.priceTier && PRICE_TIER_TO_RANGE[c.priceTier]) || base.priceRange,
    acceptsReservations: c.reservationsEnabled !== false,
  }
}

/**
 * Server-side helper — fetch the concept list and build the brand-location
 * map. Used by every server component that previously imported the const.
 * Falls back to DEFAULT_BRAND_LOCATIONS if the API is unreachable.
 */
export async function fetchBrandLocations(apiBase: string): Promise<Record<string, BrandLocation>> {
  try {
    const res = await fetch(`${apiBase}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (!res.ok) return DEFAULT_BRAND_LOCATIONS
    const concepts: Concept[] = await res.json()
    if (concepts.length === 0) return DEFAULT_BRAND_LOCATIONS
    const map: Record<string, BrandLocation> = {}
    for (const c of concepts) map[c.slug] = locationFromConcept(c)
    return { ...DEFAULT_BRAND_LOCATIONS, ...map }
  } catch {
    return DEFAULT_BRAND_LOCATIONS
  }
}

/** Location-page slugs that used to be live. Kept resolving so an indexed
 *  or printed URL doesn't 404 after a move — maps to the brand slug. */
export const LEGACY_LOCATION_SLUGS: Record<string, string> = {
  'bukhari-commercial': 'simmer',
}

/** Synchronous lookup of the fallback default for a given slug. Use for
 *  client components that don't have access to the live concept list. */
export function locationFor(slug: string): BrandLocation | undefined {
  return DEFAULT_BRAND_LOCATIONS[slug]
}

/** Backwards-compat const export so existing imports keep building. New
 *  code should prefer fetchBrandLocations() to get live admin-edited data. */
export const BRAND_LOCATIONS = DEFAULT_BRAND_LOCATIONS

/** "Ittehad Commercial, DHA Phase 6 · Karachi" — skips TODO_FILL parts. */
export function addressLine(loc: BrandLocation): string {
  const parts = [loc.area, loc.city].filter((p) => !p.startsWith('TODO_FILL'))
  return parts.join(' · ')
}

/** wa.me link with optional pre-filled message. */
export function whatsappLink(loc: BrandLocation, prefilledText?: string): string {
  const base = `https://wa.me/${loc.whatsapp}`
  return prefilledText ? `${base}?text=${encodeURIComponent(prefilledText)}` : base
}
