import type { CharacterKind } from '../characters/types'
import type { DayPart } from '../../lib/world/clock'

/**
 * Where the buddy lives, and who it is on each page.
 *
 * Pure (no React, no window) so the server and the first client render agree.
 * The one thing it cannot know is whether the request came in on a brand
 * domain — `Companion` asks `useOnBrandMicrosite` for that and stands down on
 * its own.
 */
export type CompanionBrand = 'servd' | 'stackd' | 'flipd'

export interface CompanionRoute {
  show: boolean
  kind: CharacterKind
  brand: CompanionBrand
}

/** Hub kind by the hour: breakfast coffee through to a late-night shake. */
const HUB_KIND: Record<DayPart, CharacterKind> = {
  morning: 'coffee',
  lunch: 'sandwich',
  afternoon: 'croissant',
  dinner: 'burger',
  late: 'fries',
  night: 'shake',
}

/** Top-level segments that are servd pages, never a kitchen slug. */
const HUB_SEGMENTS = new Set([
  'browse', 'orders', 'account', 'group-order', 'reserve', 'order',
  'login', 'signup', 'auth', 'brand', 'brands', 'locations', 'press',
  'api', '_next',
])

/** Hub pages where the buddy keeps you company. Matched by first segment. */
const SHOW_SEGMENTS = new Set(['browse', 'orders', 'account', 'group-order', 'reserve', 'order'])

/** Under a kitchen slug, the ordering flow: /x, /x/menu, /x/order, /x/order/:id, /x/checkout. */
const SLUG_SUBPAGES = new Set(['menu', 'order', 'checkout'])

function brandOf(slug: string | undefined): CompanionBrand {
  const s = (slug ?? '').toLowerCase()
  if (s === 'stackd' || s.startsWith('stackd-')) return 'stackd'
  if (s === 'flipd' || s.startsWith('flipd-')) return 'flipd'
  return 'servd'
}

function isSimmer(slug: string | undefined): boolean {
  const s = (slug ?? '').toLowerCase()
  return s === 'simmer' || s.startsWith('simmer-')
}

export function companionFor(pathname: string, dayPart: DayPart): CompanionRoute {
  const path = (pathname || '/').split(/[?#]/)[0] ?? '/'
  const segs = path.split('/').filter(Boolean).map((s) => s.toLowerCase())
  const first = segs[0]
  const hubKind = HUB_KIND[dayPart] ?? 'sandwich'

  const hidden = (brand: CompanionBrand = 'servd'): CompanionRoute => ({ show: false, kind: hubKind, brand })

  // Home.
  if (!first) return { show: true, kind: hubKind, brand: 'servd' }

  // simmer never gets a character, anywhere: /simmer*, /brand/simmer*,
  // /reserve/simmer, …
  if (segs.slice(0, 2).some(isSimmer)) return hidden()

  // Microsites and the auth screens manage their own chrome.
  if (first === 'brand' || first === 'login' || first === 'signup' || first.startsWith('auth')) {
    return hidden(brandOf(segs[1]))
  }

  if (SHOW_SEGMENTS.has(first)) {
    // Reserving at a kitchen: dress the buddy for that kitchen.
    const brand = first === 'reserve' ? brandOf(segs[1]) : 'servd'
    return { show: true, kind: kindFor(brand, hubKind), brand }
  }

  if (HUB_SEGMENTS.has(first)) return hidden()

  // /[slug] ordering and checkout for stackd, Flipd or an unknown slug.
  if (segs.length === 1 || SLUG_SUBPAGES.has(segs[1] ?? '')) {
    const brand = brandOf(first)
    return { show: true, kind: kindFor(brand, hubKind), brand }
  }

  return hidden(brandOf(first))
}

function kindFor(brand: CompanionBrand, hubKind: CharacterKind): CharacterKind {
  // stackd is a café: its buddy is the coffee cup, never a burger.
  if (brand === 'stackd') return 'coffee'
  if (brand === 'flipd') return 'burger'
  return hubKind
}
