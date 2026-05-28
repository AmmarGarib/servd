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
const HERO_BY_SLUG: Record<string, string> = {
  'simmer':          'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1200&q=85',
  'stax':            'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=1200&q=85',
  'strata':          'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=1200&q=85',
  'flipd':           'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58?w=1200&q=85',
  'bukhari':         'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=1200&q=85',
  'craveman':        'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=1200&q=85',
  'garnish-station': 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=1200&q=85',
  'stax-padel':      'https://images.unsplash.com/photo-1553979459-d2229ba7433b?w=1200&q=85',
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
    oneLiner: 'Double-smash burgers, loaded fries, house-made sauces. Delivery-first kitchen.',
    long: 'Stax is what happens when a Pakistani burger obsession meets the smash technique. Two smash patties, aged cheddar, pickles, and a special sauce we&rsquo;ve been refining since day one. Loaded fries that earn the name. Everything cooked to order in our dedicated ghost kitchen and delivered to your door in under 40 minutes.',
    highlights: ['Double-smash burgers', 'Loaded fries', 'House-made sauces', 'Ghost kitchen · delivery-first'],
    hours: 'Lunch 12:00 PM – 3:00 PM · Dinner 7:00 PM – 11:00 PM',
  },
  'strata': {
    tagline: 'Clean, layered, performance-built.',
    oneLiner: 'High-protein, chef-driven bowls and wraps — macros on every lid.',
    long: 'Strata is high-protein, clean-label cooking built for people who actually count. Every bowl and wrap comes with protein, carbs, fat, and kcal printed on the packaging — no guessing, no estimates. Chef-driven flavour, gym-friendly numbers. Whether you&rsquo;re cutting, maintaining, or bulking, there&rsquo;s a meal engineered for your goal.',
    highlights: ['Macros on every meal', 'CUT · MAINTAIN · BULK goals', 'Avg 42g protein per serve', 'Clean labels, no fillers'],
    hours: 'Lunch 12:00 PM – 3:00 PM · Dinner 7:00 PM – 10:30 PM',
  },
  'flipd': {
    tagline: 'Buttermilk-brined, hand-breaded, hot.',
    oneLiner: 'Crispy chicken, every piece made-to-order. No reheats, no shortcuts.',
    long: 'Flipd is GS Foods&rsquo; ode to fried chicken done right. Every piece sits in our buttermilk + spice brine for a full 24 hours before hitting the hand-breading station — that&rsquo;s why the chicken is juicy on the inside, even when the crust is loud. Sandwiches, tenders, and buckets that don&rsquo;t apologise. We&rsquo;ve tried shortcuts. We don&rsquo;t use them.',
    highlights: ['24h buttermilk brine', 'Hand-breaded, never machine', '180°C fryer, every piece', 'Zero reheats'],
    hours: 'Lunch 12:00 PM – 3:00 PM · Dinner 7:00 PM – 11:00 PM',
  },
  'bukhari': {
    tagline: 'Saffron. Lamb. Heritage.',
    oneLiner: 'Three-generation recipes. Slow-cooked meats, saffron rice, family portions.',
    long: 'Bukhari is the heritage menu — saffron rice, lamb on the bone, slow-cook patience. The family kitchen opened in Saddar in 1953. Apa&rsquo;s recipes passed from hand to hand, generation by generation. Now on the servd platform — same brass dishes, same coals, same patience. Built for the table, served for the family, made the way it was always made.',
    highlights: ['Est. 1953 · Saddar, Karachi', 'Saffron rice slow-cooked over coals', 'Family platters · catering', 'Wedding trays on 24h notice'],
    hours: 'Lunch 12:00 PM – 3:00 PM · Dinner 7:00 PM – 11:00 PM · Catering on request',
  },
  'craveman': {
    tagline: 'Karachi comfort food, sorted.',
    oneLiner: 'Karahi bowls, seekh wraps, rice plates. Ghost kitchen, Karachi speed.',
    long: 'Craveman is the desi comfort menu — butter chicken bowls, charred seekh, slow karahi, wok-tossed rice. Cooked in a dedicated ghost kitchen and delivered straight to your door. No aggregator markup, no waiting at a window. Just the food you were craving.',
    highlights: ['Karahi bowls & wraps', 'Seekh & nihari', 'Delivery-first ghost kitchen', 'Lunch & dinner'],
    hours: 'Lunch 12:00 PM – 3:00 PM · Dinner 7:00 PM – 11:00 PM',
  },
  'garnish-station': {
    tagline: 'You build it. We finish it.',
    oneLiner: 'Top-your-own bowls and wraps from an outdoor walk-up cart.',
    long: 'Garnish Station is the cart concept — pick your base, your toppings, your protein, your sauce. Quick, fresh, customisable to the gram. Great for events, outdoor spots, and anywhere you want serious food without sitting down.',
    highlights: ['Build-your-own bowls & wraps', 'Outdoor walk-up cart', 'Quick service', 'Events & pop-ups'],
    hours: 'Event hours vary — check Instagram',
  },
  'stax-padel': {
    tagline: 'Smashed at the court.',
    oneLiner: 'Container-kitchen Stax at the padel court. Same burgers, faster fire.',
    long: 'Stax @ Padel is a satellite of the flagship ghost kitchen — same smash recipes, container format, parked where you play. Order between sets, pick up at the window. No delivery from this location.',
    highlights: ['Container kitchen', 'Padel-court parked', 'Pickup-first', 'Order between sets'],
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
