// Canonical name + address + phone per brand, built from the live data:
//
//   • name, phone, WhatsApp, email, cuisine, price tier — the brand's Concept row
//     (admin → Storefront → Brands). Per brand, owner decision 18.
//   • street address + map pin — the brand's KITCHEN (Location, admin →
//     Storefront → Locations). A kitchen running several brands has one
//     address. The API mirrors the primary kitchen's address and pin onto
//     Concept.address / latitude / longitude, so a Concept row already carries
//     them; fetchBrandKitchens() lists every kitchen when a page needs all.
//
// Per the local-seo skill: NAP (name, address, phone) MUST be byte-identical
// across Google Business Profile, the website, Instagram bio and every
// directory. So everything downstream (schema.org JSON-LD, footer, brand
// microsite address line, /locations geo pages, "message us" WhatsApp links)
// reads through here.
//
// DEFAULT_BRAND_LOCATIONS is an API-DOWN FALLBACK ONLY. It is never read ahead
// of the live data: locationFromConcept() lets every live value win, and
// locationFor() — the bare fallback — is for the rare render that has no
// concept row at all. It carries no phone numbers (the old placeholder
// +92 300 1234567… numbers were live on the site) and the cuisines are the
// current ones.

import { formatBrandName, type Concept, type ServiceHourSlot } from './concept'

/**
 * A NAP value that is really there: '' for empty strings and the unfilled
 * placeholders this fallback carries (TODO_FILL_STREET / TODO_FILL_AREA) and
 * the old fake +92 300 1234567x numbers. Everything public — titles, H1s,
 * JSON-LD, the sitemap, map queries, contact links — reads NAP through this,
 * so a placeholder can never reach a customer or Google.
 */
export function filled(v: string | null | undefined): string {
  const s = (v ?? '').trim()
  if (!s || /^TODO_FILL/i.test(s) || /placeholder/i.test(s) || /^\+?92\s?300\s?123\s?456/.test(s)) return ''
  return s
}

/** True when a location has a real area — the bar for being indexed
 *  (sitemap entry, indexable /locations page). */
export function isPublishableLocation(loc: BrandLocation): boolean {
  return filled(loc.area) !== ''
}

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
  email:               string                // guest-facing contact email ('' = none)
  geo:                 { lat: number; lng: number }
  cuisine:             string
  priceRange:          string                // $ / $$ / $$$ / $$$$ for schema.org
  acceptsReservations: boolean
  locationSlug:        string                // /locations/<slug>
  // Operator's Google Maps share link. When set, the brand nav's "Visit"
  // goes straight here (new tab) instead of the internal /visit page —
  // one tap to directions is what a visitor actually wants from that word.
  mapsUrl?:            string
  // The brand's own description and service hours (Concept row), carried here
  // so every Restaurant node for the brand — on the brand site, /home and
  // /locations — describes the same entity identically.
  description?:        string
  hours?:              ServiceHourSlot[]
  // The brand's public profiles (Concept.sameAs, admin → Marketing → Brands):
  // https URLs only, for Restaurant JSON-LD sameAs and the Elsewhere links.
  sameAs?:             string[]
  // The brand's Google Maps / Business Profile place link (Concept.googleMapsUrl).
  // Unlike mapsUrl (a link to the pin) it is the listing itself: JSON-LD
  // hasMap prefers it. It says nothing about the pin, so geo still follows
  // mapsUrl.
  googleMapsUrl?:      string
}

/** A public profile URL the storefront will publish: https, a real host, no
 *  credentials. The API already enforces this on save; this keeps a bad row
 *  (or the fallback) out of JSON-LD and hrefs anyway. '' when unusable. */
export function profileUrl(v: unknown): string {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  if (!s || s.length > 500 || /\s/.test(s)) return ''
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return ''
    return s
  } catch {
    return ''
  }
}

/** The brand's profile links, cleaned and de-duplicated. */
export function profileLinksOf(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const v of list) {
    const u = profileUrl(v)
    if (u && !out.includes(u)) out.push(u)
  }
  return out
}

/** The best map link for a brand: its Google Business Profile / Maps place
 *  link when set, else the pin link. '' when neither. */
export function mapLinkOf(loc: BrandLocation): string {
  return loc.googleMapsUrl || filled(loc.mapsUrl)
}

const DEFAULT_BRAND_LOCATIONS: Record<string, BrandLocation> = {
  simmer: {
    slug:                'simmer',
    name:                'Simmer',
    street:              'TODO_FILL_STREET',
    area:                'Ittehad Commercial, DHA Phase 6',
    city:                'Karachi',
    country:             'Pakistan',
    phone:               '',
    whatsapp:            '',
    email:               'simmer@gsfoods.pk',
    // Pinned from the operator's Google Maps link (maps.app.goo.gl/gJQMwRKsZdEEfoKV6).
    geo:                 { lat: 24.8014954, lng: 67.0735636 },
    cuisine:             'Small plates',
    priceRange:          '$$$',
    acceptsReservations: true,
    locationSlug:        'ittehad-commercial',
    mapsUrl:             'https://maps.app.goo.gl/gJQMwRKsZdEEfoKV6',
  },
  stackd: {
    slug:                'stackd',
    name:                'Stackd',
    street:              'TODO_FILL_STREET',
    area:                'Ittehad Commercial, DHA Phase 6',
    city:                'Karachi',
    country:             'Pakistan',
    phone:               '',
    whatsapp:            '',
    email:               'stackd@gsfoods.pk',
    // Pinned from the operator's Google Maps link (maps.app.goo.gl/wa3fEKMevo1CZhkS8).
    geo:                 { lat: 24.8015505, lng: 67.0735747 },
    // A scratch-cooking café and small market — not a burger brand.
    cuisine:             'Café',
    priceRange:          '$$',
    acceptsReservations: false,
    locationSlug:        'stackd-kitchen',
    mapsUrl:             'https://maps.app.goo.gl/wa3fEKMevo1CZhkS8',
  },
  flipd: {
    slug:                'flipd',
    name:                'Flipd',
    street:              'TODO_FILL_STREET',
    area:                'TODO_FILL_AREA',
    city:                'Karachi',
    country:             'Pakistan',
    phone:               '',
    whatsapp:            '',
    email:               'flipd@gsfoods.pk',
    geo:                 { lat: 24.8054, lng: 67.0517 },
    cuisine:             'Burgers',
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

/** One of a brand's kitchens, as GET /locations/public returns it. */
export interface BrandKitchen {
  slug:      string
  name:      string
  address:   string | null
  city:      string | null
  latitude:  number | null
  longitude: number | null
  isPrimary: boolean
}

/** Google Maps link for a pin — the fallback when there is no share link. */
export function mapsLinkFor(geo: { lat: number; lng: number }): string {
  return `https://www.google.com/maps/search/?api=1&query=${geo.lat},${geo.lng}`
}

/**
 * Build a BrandLocation from a live Concept row (and, when the page has it,
 * the brand's primary kitchen). Live values always win; the fallback only
 * fills what the live data does not have yet, so the storefront still renders
 * sensibly during a partial setup.
 */
export function locationFromConcept(c: Concept, kitchen?: BrandKitchen | null): BrandLocation {
  const base = DEFAULT_BRAND_LOCATIONS[c.slug] ?? {
    slug:                c.slug,
    name:                formatBrandName(c.name),
    street:              'TODO_FILL_STREET',
    area:                'TODO_FILL_AREA',
    city:                'Karachi',
    country:             'Pakistan',
    phone:               '',
    whatsapp:            '',
    email:               '',
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

  // Street + pin: the kitchen, then the brand's mirror of it, then fallback.
  const street = kitchen?.address ?? c.address ?? base.street
  const liveGeo = (kitchen?.latitude != null && kitchen?.longitude != null)
    ? { lat: kitchen.latitude, lng: kitchen.longitude }
    : (c.latitude != null && c.longitude != null)
      ? { lat: c.latitude, lng: c.longitude }
      : null

  return {
    ...base,
    slug:                c.slug,
    // The canonical display name (Simmer, Stackd, Flipd) everywhere the NAP
    // name surfaces — JSON-LD, footer, /locations pages.
    name:                formatBrandName(c.name),
    street,
    area:                c.addressLocality ?? base.area,
    phone:               c.phone ?? base.phone,
    whatsapp:            whatsappDigits || base.whatsapp,
    email:               c.email?.trim() || base.email,
    geo:                 liveGeo ?? base.geo,
    // A live pin beats the fallback share link: the share link points at
    // wherever the kitchen was when it was pasted into code.
    mapsUrl:             liveGeo ? mapsLinkFor(liveGeo) : base.mapsUrl,
    cuisine:             c.cuisine ?? base.cuisine,
    priceRange:          (c.priceTier && PRICE_TIER_TO_RANGE[c.priceTier]) || base.priceRange,
    acceptsReservations: c.reservationsEnabled !== false,
    ...(c.description?.trim() && { description: c.description.trim() }),
    ...(c.serviceHours?.length && { hours: c.serviceHours }),
    sameAs:              profileLinksOf(c.sameAs),
    ...(profileUrl(c.googleMapsUrl) && { googleMapsUrl: profileUrl(c.googleMapsUrl) }),
  }
}

/**
 * Server-side helper — fetch the concept list and build the brand-location
 * map. Used by every server component that previously imported the const.
 * Falls back to DEFAULT_BRAND_LOCATIONS only if the API is unreachable.
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

/**
 * Every active kitchen a brand runs from, primary first (GET
 * /locations/public). Empty when none is linked or the API is down.
 */
export async function fetchBrandKitchens(apiBase: string, slug: string): Promise<BrandKitchen[]> {
  try {
    const res = await fetch(`${apiBase}/api/v1/locations/public?brand=${encodeURIComponent(slug)}`, { cache: 'no-store' })
    if (!res.ok) return []
    const rows = (await res.json()) as BrandKitchen[]
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** Location-page slugs that used to be live. Kept resolving so an indexed
 *  or printed URL doesn't 404 after a move — maps to the brand slug. */
export const LEGACY_LOCATION_SLUGS: Record<string, string> = {
  'bukhari-commercial': 'simmer',
}

/** API-DOWN FALLBACK: the bundled default for a slug. Only for a render that
 *  has no concept row at all — anything holding a Concept must use
 *  locationFromConcept(concept) so the admin-edited values win. */
export function locationFor(slug: string): BrandLocation | undefined {
  return DEFAULT_BRAND_LOCATIONS[slug]
}

/** API-DOWN FALLBACK, kept so existing imports keep building. Never read it
 *  ahead of the live data: use fetchBrandLocations() / locationFromConcept(). */
export const BRAND_LOCATIONS = DEFAULT_BRAND_LOCATIONS

/** "Ittehad Commercial, DHA Phase 6 · Karachi" — skips TODO_FILL parts. */
export function addressLine(loc: BrandLocation): string {
  const parts = [filled(loc.area), filled(loc.city)].filter(Boolean)
  return parts.join(' · ')
}

/** wa.me link with optional pre-filled message. With no number on file it
 *  opens WhatsApp's share sheet rather than a fake number. */
export function whatsappLink(loc: BrandLocation, prefilledText?: string): string {
  const base = `https://wa.me/${loc.whatsapp}`
  return prefilledText ? `${base}?text=${encodeURIComponent(prefilledText)}` : base
}
