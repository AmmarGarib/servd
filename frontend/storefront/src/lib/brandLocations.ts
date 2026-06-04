// Canonical name + address + phone per brand.
//
// Per the local-seo skill in the restaurant marketing bundle: NAP (name,
// address, phone) MUST be byte-identical across Google Business Profile,
// the website, Instagram bio, foodpanda, Zomato, and every directory.
// Inconsistent NAP dilutes Maps prominence. That means there's exactly
// one place — this file — that holds the canonical strings; everything
// downstream (schema.org JSON-LD, footer, brand microsite address line,
// /locations geo pages, "message us" WhatsApp links) reads from here.
//
// Fill in TODO_FILL values before launch. Update Google Business Profile
// + foodpanda + Instagram to match EXACTLY (down to the comma).

export interface BrandLocation {
  slug:            string
  name:            string                // brand name as Google + foodpanda show it
  /** Street-level address, byte-identical with GBP. */
  street:          string
  /** Neighborhood / area, e.g. "Bukhari Commercial, DHA Phase 6". */
  area:            string
  /** "Karachi" — always. */
  city:            string
  postalCode?:     string
  country:         string                // ISO name, "Pakistan"
  /** Public phone (the one guests reach). WhatsApp Business if that's how
   *  bookings run — must match GBP "phone" field. E.164, no spaces. */
  phone:           string                // e.g. "+923001234567"
  /** WhatsApp number — usually the same as `phone` but split out in case
   *  ops decides to route booking-WhatsApp to a different number than the
   *  GBP-listed phone. wa.me uses digits-only, no '+'. */
  whatsapp:        string                // e.g. "923001234567"
  /** Lat/lng for embedded map + LocalBusiness schema. */
  geo:             { lat: number; lng: number }
  /** Cuisine / category label for schema.org `servesCuisine`. */
  cuisine:         string
  /** Price range glyph for schema — `$` cheap → `$$$$` expensive. */
  priceRange:      string
  /** Whether this brand takes table reservations (true) or is delivery /
   *  counter-service only (false). Fed into schema acceptsReservations. */
  acceptsReservations: boolean
  /** URL slug for the geo landing page; e.g. /locations/bukhari-commercial */
  locationSlug:    string
}

// Real numbers + addresses go here. Where the operator hasn't given us the
// real value yet, the placeholder is clearly marked TODO_FILL so it can't
// silently ship a wrong number to Google Maps.
export const BRAND_LOCATIONS: Record<string, BrandLocation> = {
  simmer: {
    slug:                'simmer',
    name:                'Simmer',
    street:              'TODO_FILL_STREET',
    area:                'Bukhari Commercial, DHA Phase 6',
    city:                'Karachi',
    country:             'Pakistan',
    phone:               '+923001234567',   // TODO_FILL_REAL_NUMBER
    whatsapp:            '923001234567',    // TODO_FILL_REAL_NUMBER
    geo:                 { lat: 24.8054, lng: 67.0517 },  // approximate Bukhari Commercial — refine
    cuisine:             'Small plates',
    priceRange:          '$$$',
    acceptsReservations: true,
    locationSlug:        'bukhari-commercial',
  },
  stax: {
    slug:                'stax',
    name:                'Stax',
    street:              'TODO_FILL_STREET',
    area:                'TODO_FILL_AREA',
    city:                'Karachi',
    country:             'Pakistan',
    phone:               '+923001234568',   // TODO_FILL_REAL_NUMBER
    whatsapp:            '923001234568',    // TODO_FILL_REAL_NUMBER
    geo:                 { lat: 24.8054, lng: 67.0517 },  // TODO_FILL — same building as Simmer per brand bible?
    cuisine:             'Smash burger',
    priceRange:          '$$',
    acceptsReservations: false,
    locationSlug:        'stax-kitchen',
  },
  flipd: {
    slug:                'flipd',
    name:                'Flipd',
    street:              'TODO_FILL_STREET',
    area:                'TODO_FILL_AREA',
    city:                'Karachi',
    country:             'Pakistan',
    phone:               '+923001234569',   // TODO_FILL_REAL_NUMBER
    whatsapp:            '923001234569',    // TODO_FILL_REAL_NUMBER
    geo:                 { lat: 24.8054, lng: 67.0517 },  // TODO_FILL
    cuisine:             'Fried chicken',
    priceRange:          '$$',
    acceptsReservations: false,
    locationSlug:        'flipd-court',
  },
}

export function locationFor(slug: string): BrandLocation | undefined {
  return BRAND_LOCATIONS[slug]
}

/** Human-readable single-line address: "Bukhari Commercial, DHA Phase 6 · Karachi". */
export function addressLine(loc: BrandLocation): string {
  const parts = [loc.area, loc.city].filter((p) => !p.startsWith('TODO_FILL'))
  return parts.join(' · ')
}

/** wa.me link with optional pre-filled message. */
export function whatsappLink(loc: BrandLocation, prefilledText?: string): string {
  const base = `https://wa.me/${loc.whatsapp}`
  return prefilledText ? `${base}?text=${encodeURIComponent(prefilledText)}` : base
}
