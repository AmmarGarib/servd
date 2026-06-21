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
  // Physical presence — included in /storefront/concepts response. NAP is
  // edited from admin CEO dashboard so the operator can fix a wrong number
  // on Google without a code deploy. brandLocations.ts merges these over a
  // hardcoded fallback so the storefront still renders sensibly while the
  // operator is filling them in for the first time.
  phone?:           string | null
  whatsapp?:        string | null
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
  stax:   '#B0B2B8',  // astroscopus grey — industrial navy-grey palette
  flipd:  '#2092E9',  // curious blue — cool diner palette
}

/** Returns the brand accent the storefront should use for this concept,
 *  preferring the per-brand override over the DB primaryColor. */
export function brandAccent(slug: string, fallback: string | null | undefined): string {
  return BRAND_ACCENT_OVERRIDES[slug] ?? fallback ?? '#22c55e'
}

// Per-brand surface palette for the dark "ink" sections (the microsite footer,
// and any full-bleed themed band). Each brand gets its OWN background + text
// colours instead of a generic black slab, so the chrome reads as that brand:
//   simmer → forest green + bone     stax  → bone/grey + ink
//   flipd  → ink-blue + light-blue   servd → deep purple + white
// The brand accent (brandAccent) still layers on top as the signal colour.
export interface BrandSurface {
  bg: string      // section background
  text: string    // primary text on that background
  muted: string   // secondary / supporting text
  border: string  // hairline dividers
}

const BRAND_SURFACE: Record<string, BrandSurface> = {
  simmer: { bg: '#06392F', text: '#F3ECDE', muted: 'rgba(243,236,222,0.62)', border: 'rgba(243,236,222,0.14)' },
  stax:   { bg: '#142834', text: '#C5C7CC', muted: '#8D8F97',                border: 'rgba(197,199,204,0.14)' },
  // flipd is a LIGHT diner page (bone surface, midnight-oil ink) — its chrome
  // integrates on bone with ink text, not the dark treatment the others use.
  flipd:  { bg: '#EDE6D3', text: '#090D17', muted: 'rgba(9,13,23,0.60)',     border: 'rgba(9,13,23,0.12)'     },
  servd:  { bg: '#4E2A4F', text: '#FFFFFF', muted: 'rgba(255,255,255,0.60)', border: 'rgba(255,255,255,0.10)' },
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
    case 'stax':   return { font: 'var(--stax-display)',   color: 'var(--stax-cream)',   weight: 700 }
    case 'flipd':  return { font: 'var(--flipd-marquee)',  color: 'var(--flipd-sky)',    weight: 400 }
    default:       return { font: 'var(--font-wordmark)',  color: 'var(--brand-accent)', weight: 800 }
  }
}

/** The Simmer wordmark is ALWAYS lowercase per brand guidelines — capital-S
 *  "Simmer" anywhere user-visible is a bug. Other brands render as stored.
 *  Wrap any user-visible brand/concept name with this. */
export function formatBrandName(name: string | null | undefined): string {
  const n = (name ?? '').trim()
  return n.toLowerCase() === 'simmer' ? 'simmer' : n
}

export function typeLabel(t: string): string {
  if (t === 'digital')    return 'Delivery'
  if (t === 'cart')       return 'Walk-up'
  if (t === 'restaurant') return 'Dine-in'
  return 'Order'
}

// Stock hero images keyed on slug.
// Replace with real photography when art direction is delivered.
// HERO_BY_SLUG — fallback hero image per concept slug. Operator can
// override per-brand via the admin once art direction is delivered.
// Only the three live brands are listed here; unknown slugs fall back
// to the generic image below.
const HERO_BY_SLUG: Record<string, string> = {
  'simmer':          'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1200&q=85',
  // Stax — rustic toasted focaccia/rye sandwich on a wood board. Matches
  // the upscale dine-in / Italian-leaning brand direction.
  'stax':            'https://images.unsplash.com/photo-1559054663-e8d23213f55c?w=1200&q=85',
  // Flipd — smash burger (was Stax's image; now belongs to Flipd, the
  // court-side smash-burger brand).
  'flipd':           'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=1200&q=85',
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
    long: 'simmer is GS Foods’ flagship plated-service concept. The menu rotates with the season — small plates built to share, hand-crafted mocktails, and a room that knows when to fade and when to glow. We cook because we care about the table. Every dish is plated as if it’s going to someone we know.',
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
    tagline: 'Game, set, smash.',
    oneLiner: 'Smash burgers cooked court-side. Order between sets, eat at the bench.',
    long: 'Flipd is the court-side burger. Dry-aged beef smashed on a cast-iron flat-top a few steps from the net, brioche toasted to order, sauces blended in-house. Built for the people who want a real burger right after they’ve put in real work. Game on, grill on, eat after the match.',
    highlights: ['Cast-iron smash, court-side', 'Open-fire, open-air kitchen', 'Order between sets', 'Pick up at the bench'],
    hours: 'Court hours — typically 10:00 AM – 10:00 PM',
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
