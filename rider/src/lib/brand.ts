// Brand names in normal capitalisation (owner, 2026-10-06): Simmer, Stackd,
// Flipd. A copy of formatBrandName() from frontend/storefront/src/lib/concept.ts
// — the Expo app cannot import from the storefront. Keep the two in step.

const CANONICAL_BRAND_NAMES: Record<string, string> = {
  simmer: 'Simmer',
  stackd: 'Stackd',
  flipd:  'Flipd',
}

/** Wrap every user-visible brand/concept name with this. */
export function formatBrandName(name: string | null | undefined): string {
  const n = (name ?? '').trim()
  return CANONICAL_BRAND_NAMES[n.toLowerCase()] ?? n
}
