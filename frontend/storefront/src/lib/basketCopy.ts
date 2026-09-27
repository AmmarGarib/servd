// Brand-voiced copy for an empty basket. Shared by the ordering drawer
// (/[concept]) and the checkout empty state (/[concept]/checkout) so the two
// never drift apart.
//
//   simmer: lowercase, calm, never an exclamation mark (simmer-brand SKILL.md)
//   stackd: lowercase café-and-market voice (sandwiches, pastries, the chiller)
//   flipd:  terse diner voice
//   others: the generic servd line

export interface EmptyBasketCopy {
  title: string
  body: string
  cta: string
}

const COPY: Record<string, EmptyBasketCopy> = {
  simmer: {
    title: 'nothing on the table yet.',
    body: 'the menu is a short walk away.',
    cta: 'see the menu',
  },
  stackd: {
    title: 'the tray’s empty.',
    body: 'pick a sandwich, a pastry or something cold from the chiller.',
    cta: 'back to the counter',
  },
  flipd: {
    title: 'Grill’s waiting.',
    body: 'Nothing on the ticket yet.',
    cta: 'Back to the menu',
  },
}

const DEFAULT_COPY: EmptyBasketCopy = {
  title: 'Basket’s empty.',
  body: 'Try another craving.',
  cta: 'See the menu',
}

export function emptyBasketCopy(slug: string | null | undefined): EmptyBasketCopy {
  const key = (slug ?? '').trim().toLowerCase()
  return COPY[key] ?? DEFAULT_COPY
}
