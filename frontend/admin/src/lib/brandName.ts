// Canonical display names for the GS Foods brands (owner decision, 2026-10-06):
// written in normal capitalisation everywhere a customer sees them — "Simmer",
// "Stackd", "Flipd" — whatever case the Concept row holds (the stax → stackd
// rename migration stored "stackd"). Kept in step with formatBrandName in
// frontend/storefront/src/lib/concept.ts, backend/src/lib/brandName.ts and
// mobile/src/lib/brandName.ts
// (each app builds on its own, so each has a copy). Wrap brand names shown
// from data with it.

const CANONICAL_BRAND_NAMES: Record<string, string> = {
  simmer: 'Simmer',
  stackd: 'Stackd',
  flipd:  'Flipd',
}

/** The three GS Foods brands map to their canonical capitalised name
 *  (case-insensitive, trimmed); any other name is returned trimmed, as stored. */
export function formatBrandName(name: string | null | undefined): string {
  const n = (name ?? '').trim()
  return CANONICAL_BRAND_NAMES[n.toLowerCase()] ?? n
}
