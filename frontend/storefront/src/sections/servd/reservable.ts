// The brands that take table bookings — one definition for /reserve. The
// picker's cards, the page header's {bookable} placeholder and the page title
// all read it, so they always name the same kitchens. (Next memoises the
// identical GET within a request, so asking twice costs one API call.)

import type { Concept } from '../../lib/concept'
import { formatBrandName } from '../../lib/concept'
import { fetchConceptList, inBrandOrder, joinNames } from '../../lib/liveConcepts'

/** A brand that takes reservations: dine-in, bookings not switched off. */
export function takesReservations(c: Pick<Concept, 'reservationsEnabled' | 'type'>): boolean {
  return c.reservationsEnabled !== false && c.type === 'restaurant'
}

/** The live brands that take bookings. [] when the API is down: the page then
 *  says nobody is taking bookings rather than offering the bundled brands. */
export async function reservableConcepts(): Promise<Concept[]> {
  return ((await fetchConceptList()) ?? []).filter(takesReservations)
}

/** "Simmer", "Simmer or Stackd", "Simmer, Stackd or Flipd" — '' for none, or
 *  for more than three (a title can't list them all). */
export function bookableNames(concepts: Concept[]): string {
  const names = inBrandOrder(concepts).map((c) => formatBrandName(c.name))
  return names.length > 0 && names.length <= 3 ? joinNames(names, 'or') : ''
}

/** What `{bookable}` reads when no list can be named. */
export const BOOKABLE_FALLBACK = 'a servd kitchen'
