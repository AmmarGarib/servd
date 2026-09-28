// A/B variant assignment for SiteLayout pages.
//
// Every visitor gets a stable random id cookie (set by middleware.ts when
// missing). The variant is a pure function of (visitor, slug, version), so a
// visitor sees the same variant on every load of the same published version,
// and a new version re-deals the split. Edge-safe: middleware imports this.

export const VISITOR_COOKIE = 'sv_vid'
export const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export type Variant = 'a' | 'b'

/** FNV-1a 32-bit. Stable across runtimes, no crypto needed. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function pickVariant(visitorId: string, slug: string, version: number, splitPct: number): Variant {
  const pct = Math.max(0, Math.min(100, Math.round(splitPct)))
  if (pct <= 0) return 'a'
  return fnv1a(`${visitorId}${slug}${version}`) % 100 < pct ? 'b' : 'a'
}
