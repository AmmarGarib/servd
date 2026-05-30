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
  description: string | null
  logoUrl: string | null
  primaryColor: string | null
  // Operator-editable strings returned by the API but optional in the type
  // — used for the brand-page promo strip and hero subhead respectively.
  heroTagline?: string | null
  announcementBanner?: string | null
  // Physical presence — included in /storefront/concepts response
  phone?:    string | null
  address?:  string | null
  latitude?:  number | null
  longitude?: number | null
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
  stax:   '#0A1857',  // deep royal blue — industrial blueprint palette
  flipd:  '#3AA8FF',  // sky blue — cool diner palette
}

/** Returns the brand accent the storefront should use for this concept,
 *  preferring the per-brand override over the DB primaryColor. */
export function brandAccent(slug: string, fallback: string | null | undefined): string {
  return BRAND_ACCENT_OVERRIDES[slug] ?? fallback ?? '#22c55e'
}

export function typeLabel(t: string): string {
  if (t === 'digital')    return 'Delivery'
  if (t === 'cart')       return 'Walk-up'
  if (t === 'restaurant') return 'Dine-in'
  return 'Order'
}

export function typeIcon(t: string): string {
  if (t === 'digital')    return '🛵'
  if (t === 'cart')       return '🚚'
  if (t === 'restaurant') return '🍽️'
  return '•'
}

// Stock hero images keyed on slug.
// Replace with real photography when art direction is delivered.
// HERO_BY_SLUG — fallback hero image per concept slug. Operator can
// override per-brand via the admin once art direction is delivered.
// Only the three live brands are listed here; unknown slugs fall back
// to the generic image below.
const HERO_BY_SLUG: Record<string, string> = {
  'simmer':          'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1200&q=85',
  'stax':            'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=1200&q=85',
  'flipd':           'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58?w=1200&q=85',
}

export function conceptHeroImage(concept: Concept): string {
  return HERO_BY_SLUG[concept.slug] ?? 'https://images.unsplash.com/photo-1495195134817-aeb325a55b65?w=1200&q=85'
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
    long: 'Simmer is GS Foods&rsquo; flagship plated-service concept. The menu rotates with the season — small plates built to share, hand-crafted mocktails, and a room that knows when to fade and when to glow. We cook because we care about the table. Every dish is plated as if it&rsquo;s going to someone we know.',
    highlights: ['Plated table service', 'Hand-built mocktails', 'Seasonal small plates', 'Mains & desserts', 'Reservations welcome'],
    hours: 'Dinner 7:00 PM – 10:30 PM · Late Night 10:30 PM – 2:30 AM',
  },
  'stax': {
    tagline: 'Smashed, stacked, sauced.',
    oneLiner: 'Upscale smash-burger room — dry-aged patties, house-baked brioche, table service.',
    long: 'Stax is a sit-down burger concept. Dry-aged beef on the cast iron, brioche we bake here every morning, sauces blended in-house. The room is built for a long lunch or a slow dinner — you bring people for the burger, you stay for the table.',
    highlights: ['Dry-aged smash patties', 'House-baked brioche', 'Premium sides', 'Dine-in service'],
    hours: 'Lunch 12:00 PM – 3:00 PM · Dinner 7:00 PM – 11:00 PM',
  },
  'flipd': {
    tagline: 'Open air, smashes, smash burgers.',
    oneLiner: 'Smash burgers cooked court-side. Order between sets, eat at the bench.',
    long: 'Flipd is the court-side burger. Dry-aged beef smashed on a cast-iron flat-top a few steps from the net, brioche toasted to order, sauces blended in-house. Built for the people who want a real burger right after they’ve put in real work. Open air, open fire, open all day.',
    highlights: ['Cast-iron smash, court-side', 'Open-fire, open-air kitchen', 'Order between sets', 'Pick up at the bench'],
    hours: 'Court hours — typically 10:00 AM – 10:00 PM',
  },
}

export function brandStory(slug: string): BrandStory {
  return BRAND_STORIES[slug] ?? {
    tagline: 'Direct from the kitchen.',
    oneLiner: 'A GS Foods brand on servd.',
    long: 'Order direct, no aggregator, fresh every time.',
    highlights: ['Direct ordering', 'Fresh daily'],
    hours: 'Check our page for current hours',
  }
}
