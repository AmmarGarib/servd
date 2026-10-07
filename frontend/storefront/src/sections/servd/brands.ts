// Shared by the servd home sections: the brands a section lists, in the
// section's own order, from the live rows (API down → the fallback records).

import type { Concept } from '../../lib/concept'
import { FALLBACK_CONCEPTS } from '../../lib/fallbackBrands'

/** Concepts for `slugs`, in that order; a slug with no row is skipped. */
export function brandsInOrder(slugs: string[], concepts: Concept[]): Concept[] {
  const live = concepts.filter((c) => slugs.includes(c.slug))
  const pool = live.length > 0 ? live : Object.values(FALLBACK_CONCEPTS)
  const bySlug = new Map(pool.map((c) => [c.slug, c]))
  return slugs.map((s) => bySlug.get(s)).filter((c): c is Concept => !!c)
}
