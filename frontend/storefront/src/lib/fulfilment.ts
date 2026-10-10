// How each brand takes web orders — the ONE list. The ordering screen reads
// it (a brand that only seats people says so instead of dead-ending) and so
// does checkout (it builds the fulfilment chooser from it). The strings are
// what POST /storefront/orders accepts as `type`.
//
// The brand's operating model decides the modes: Simmer is plated dining only
// (the QR card is at the table); Stackd is a twenty-seat café with a
// grab-and-go counter, so it adds pickup + curbside; Flipd ships hot from the
// kitchen, so it also opens up delivery. Slugs not listed (legacy / generic
// brand pages) take pickup, curbside and delivery.

export type FulfilmentOption = 'dine-in' | 'pickup' | 'curbside' | 'delivery'

const BRAND_FULFILMENT: Record<string, FulfilmentOption[]> = {
  simmer: ['dine-in'],
  stackd: ['dine-in', 'pickup', 'curbside'],
  flipd:  ['dine-in', 'pickup', 'curbside', 'delivery'],
}

const DEFAULT_FULFILMENT: FulfilmentOption[] = ['pickup', 'curbside', 'delivery']

export function fulfilmentFor(slug: string): FulfilmentOption[] {
  return BRAND_FULFILMENT[slug] ?? DEFAULT_FULFILMENT
}

/** True when the brand only takes orders from people seated at its tables. */
export function takesTableOrdersOnly(slug: string): boolean {
  return fulfilmentFor(slug).every((t) => t === 'dine-in')
}
