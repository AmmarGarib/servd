// Concept-related shared utilities for storefront components.

export interface ServiceHourSlot {
  dayOfWeek: number   // 0 = Sun … 6 = Sat
  openMin:   number   // minutes since midnight
  closeMin:  number
}

export interface Concept {
  id: string
  name: string
  slug: string
  type: string
  /** The operating company. Brands only cross-promote within one company. */
  tenantId?: string | null
  description: string | null
  logoUrl: string | null
  primaryColor: string | null
  // Brand microsite artwork, uploaded from admin → Marketing → Brands →
  // Storefront. Null means "use the asset bundled in this build", which is how
  // every brand behaved before these existed — so a brand page must always
  // supply a fallback rather than rendering a broken image.
  wordmarkUrl?: string | null
  mascotUrl?: string | null
  // Operator-editable strings returned by the API but optional in the type
  // — used for the brand-page promo strip and hero subhead respectively.
  heroTagline?: string | null
  // Physical presence — included in /storefront/concepts response.
  //   phone / whatsapp / email / addressLocality / cuisine / priceTier — per brand,
  //     edited in admin → Storefront → Brands.
  //   address / latitude / longitude — the brand's primary KITCHEN
  //     (Location, admin → Storefront → Locations), mirrored onto the brand
  //     by the API; never edited on the brand (owner decision 18).
  // brandLocations.ts lets these win over its bundled API-down fallback.
  phone?:           string | null
  whatsapp?:        string | null
  email?:           string | null   // guest-facing (owner, 2026-10-07: <brand>@gsfoods.pk)
  address?:         string | null
  addressLocality?: string | null
  cuisine?:         string | null
  priceTier?:       string | null
  latitude?:        number | null
  longitude?:       number | null
  // Service hours from DB
  serviceHours?: ServiceHourSlot[]
  // Per-brand reservations master toggle. Controlled from
  // admin → Marketing → Brands → Storefront. When false, customer-facing
  // surfaces hide the "Book a table" CTA.
  reservationsEnabled?: boolean
}

// Per-brand visual override applied at the BrandLayout level. Lets a brand
// page run its own visual language without depending on whatever color is
// in the DB. Until the operator UI grows a real palette field, this map
// is the source of truth for /brand/<slug> chrome.
const BRAND_ACCENT_OVERRIDES: Record<string, string> = {
  simmer: '#E94E1B',  // fiery orange — the simmer brand bible's signal color
  stackd: '#FCE8CE',  // Pantone 9180 cream — the wordmark colour on the plum field
  flipd:  '#294375',  // Flipd Blue (Pantone 19-4057) — the brand book's ink
}

/** Returns the brand accent the storefront should use for this concept,
 *  preferring the per-brand override over the DB primaryColor. */
export function brandAccent(slug: string, fallback: string | null | undefined): string {
  return BRAND_ACCENT_OVERRIDES[slug] ?? fallback ?? '#22c55e'
}

// Per-brand surface palette for the dark "ink" sections (the microsite footer,
// and any full-bleed themed band). Each brand gets its OWN background + text
// colours instead of a generic black slab, so the chrome reads as that brand:
//   simmer → forest green + bone     stackd → red plum + cream
//   flipd  → Flipd Blue + mustard    servd → purple + white
// The brand accent (brandAccent) still layers on top as the signal colour.
export interface BrandSurface {
  bg: string      // section background
  text: string    // primary text on that background
  muted: string   // secondary / supporting text
  border: string  // hairline dividers
}

const BRAND_SURFACE: Record<string, BrandSurface> = {
  simmer: { bg: '#06392F', text: '#F3ECDE', muted: 'rgba(243,236,222,0.62)', border: 'rgba(243,236,222,0.14)' },
  stackd: { bg: '#7C2946', text: '#FCE8CE', muted: 'rgba(252,232,206,0.72)', border: 'rgba(252,232,206,0.20)' },
  // flipd's dark band is Flipd Blue with mustard type — the inverse of the
  // page, which is mustard with blue type. Both halves of the brand book.
  flipd:  { bg: '#294375', text: '#FED561', muted: 'rgba(254,213,97,0.72)',  border: 'rgba(254,213,97,0.22)'  },
  servd:  { bg: '#6a0dad', text: '#ffffff', muted: 'rgba(255,255,255,0.72)', border: 'rgba(255,255,255,0.16)' },
}

/** The dark-section surface palette for a brand (falls back to near-black). */
export function brandSurface(slug: string): BrandSurface {
  return BRAND_SURFACE[slug] ?? { bg: '#0B0B0E', text: '#FFFFFF', muted: 'rgba(255,255,255,0.60)', border: 'rgba(255,255,255,0.10)' }
}

/** Per-brand wordmark styling for the nav brand-mark — the brand name renders
 *  in that brand's own type + colour, pasted straight on the page background
 *  (no chip behind it). The circular logo card carries the accent separately. */
export function brandWordmark(slug: string): { font: string; color: string; weight: number } {
  switch (slug) {
    case 'simmer': return { font: 'var(--simmer-display)', color: 'var(--simmer-bone)',  weight: 400 }
    case 'stackd':   return { font: 'var(--stackd-display)',   color: 'var(--stackd-cream)',   weight: 700 }
    case 'flipd':  return { font: 'var(--flipd-display)', color: 'var(--flipd-blue)',   weight: 400 }
    default:       return { font: 'var(--font-wordmark)',  color: 'var(--brand-accent)', weight: 800 }
  }
}

/** Canonical display names for the GS Foods brands — written in normal
 *  capitalisation everywhere user-visible (owner decision, 2026-10-06; this
 *  reverses the earlier all-lowercase rule). Keyed on the lowercased stored
 *  name so a row saved as "simmer" or "STACKD" still renders correctly.
 *  Text-rendered logotypes (a wordmark set in the brand font) are not routed
 *  through here. */
const CANONICAL_BRAND_NAMES: Record<string, string> = {
  simmer: 'Simmer',
  stackd: 'Stackd',
  flipd:  'Flipd',
}

/** The single place brand/concept names are normalised for display. The three
 *  GS Foods brands map to their canonical capitalised name (case-insensitive,
 *  trimmed); any other name renders as stored. Wrap any user-visible
 *  brand/concept name with this. */
export function formatBrandName(name: string | null | undefined): string {
  const n = (name ?? '').trim()
  return CANONICAL_BRAND_NAMES[n.toLowerCase()] ?? n
}

export function typeLabel(t: string): string {
  if (t === 'digital')    return 'Delivery'
  if (t === 'cart')       return 'Walk-up'
  if (t === 'restaurant') return 'Dine-in'
  return 'Order'
}

// Brand hero image keyed on slug — ONLY the brand's own assets from /public,
// never stock photography. A brand without one gets null and callers paint
// its accent / a token background instead. Real photography goes in through
// the storefront content module (Admin → Storefront → Library).
//
// Stackd's is its sticker art (plum field, cream/sky stickers, the mascot and
// the bread illustrations): 2880x960, made for the wide bands it fills (the
// About image break, the ordering hero) with everything in the middle 640px.
const HERO_BY_SLUG: Record<string, string> = {
  'stackd': '/brand/stackd-stickers.webp',
}

// Card-sized art (640x480) for the small brand cards (cross-brand strip,
// kitchens grid, reserve picker, group order) — the mascot at size on one
// sticker, rather than a crop of the wide band.
const CARD_BY_SLUG: Record<string, string> = {
  'stackd': '/brand/stackd-stickers-card.webp',
}

/** A brand's hero art: 'full' for full-bleed bands, 'card' for small cards. */
export function conceptHeroImage(concept: Pick<Concept, 'slug'>, size: 'full' | 'card' = 'full'): string | null {
  return (size === 'card' ? CARD_BY_SLUG[concept.slug] : undefined) ?? HERO_BY_SLUG[concept.slug] ?? null
}

/** `url(...) center/cover` for a CSS background shorthand, or '' when there is no image. */
export function heroCover(img: string | null): string {
  return img ? ` url(${img}) center/cover` : ''
}

// Editorial copy per brand for marketing pages.
interface BrandStory {
  tagline: string
  oneLiner: string
  long: string
  highlights: string[]
  hours: string
}

export const BRAND_STORIES: Record<string, BrandStory> = {
  'simmer': {
    tagline: 'Slow nights, plated softly.',
    oneLiner: 'Fine-casual mocktail bar and small-plates kitchen — intimate room, seasonal menu.',
    long: 'Simmer is GS Foods’ flagship plated-service concept. The menu rotates with the season — small plates built to share, hand-crafted mocktails, and a room that knows when to fade and when to glow. We cook because we care about the table. Every dish is plated as if it’s going to someone we know.',
    highlights: ['Plated table service', 'Hand-built mocktails', 'Seasonal small plates', 'Mains & desserts', 'Reservations welcome'],
    hours: 'Dinner 7:00 PM – 10:30 PM · Late Night 10:30 PM – 2:30 AM',
  },
  'stackd': {
    tagline: 'Cooked here. Wrapped, not plated.',
    oneLiner: 'A twenty-seat scratch-cooking café and small market — sandwiches, pastries, light bites and craft mocktails.',
    long: 'Stackd is a scratch cooking café: sandwiches, pastries, light bites and craft mocktails, made here rather than assembled. Service is a deliberate choice — the food comes in packaging, not on plates. Not throwaway pieces, but a vessel built for the dish it carries and branded like everything else we make. Twenty seats, and a small market folded into the cashier and barista bar: a chiller for grab-and-go and drinks, and a case for the morning’s pastries.',
    highlights: ['Scratch cooking', 'Sandwiches & pastries', 'Craft mocktails', 'Grab-and-go market'],
    hours: 'Daily 8:00 AM – 11:00 PM',
  },
  'flipd': {
    tagline: 'A gourmet burger joint that happens to be at a padel court.',
    oneLiner: 'Every burger built on a fixed spec. Same burger, every time — whether you came off the court or came only for the food.',
    long: 'Every burger is built on quality ingredients and a fixed spec, whether you just came off the court or came only for the food. Same burger, every time. Consistency isn’t a value-add here; it’s the product. Patties are seasoned with salt and pepper, nothing else, because you should taste the meat. We build with real components, not sauce, going against where the market’s headed. Drinks follow the same logic: electrolytes, coconut water, sparkling water — fuel that fits the food and fits the court.',
    highlights: ['Smashed & grilled', 'Salt and pepper, nothing else', 'House-made jams and aiolis', 'Hand-cut, triple-cooked'],
    hours: 'Daily 12:00 PM – 12:00 AM',
  },
}

export function brandStory(slug: string): BrandStory {
  return BRAND_STORIES[slug] ?? {
    tagline: 'Direct from the kitchen.',
    oneLiner: 'A brand on servd.',
    long: 'Fresh from the kitchen, every time.',
    highlights: ['Direct ordering', 'Fresh daily'],
    hours: 'Check our page for current hours',
  }
}
