// Who marketing can reach — one definition, used by campaigns and by the
// automated loyalty messages alike.
//
// OPT-OUT. Everyone we hold contact details for is reachable unless they have
// unsubscribed. The old rule was opt-in on Customer.marketingOptIn, which
// nothing in the system ever set to true — so every campaign, birthday message
// and win-back nudge reached exactly nobody, silently.
//
// Unsubscribes are honoured without exception: every campaign message carries
// a link that sets marketingOptOutAt. That is both the decent thing and the
// practical one — people who cannot stop messages report them as spam, which
// sinks email deliverability and gets WhatsApp numbers banned.

import type { Prisma } from '@prisma/client'

const API_BASE = () => process.env['API_URL'] ?? 'http://localhost:3001'

/** Base reachability: not deleted, not banned, not unsubscribed. */
export const reachableCustomer: Prisma.CustomerWhereInput = {
  deletedAt: null,
  bannedAt: null,
  marketingOptOutAt: null,
}

/**
 * Brand audience. Empty list = every brand. Otherwise a customer counts for a
 * brand if they have ordered from it or have it as their preferred brand — the
 * second matters for people who signed up through a brand's page and have not
 * ordered yet, who are exactly the ones a launch campaign is for.
 */
export function brandAudience(conceptIds: string[] | null | undefined): Prisma.CustomerWhereInput {
  if (!conceptIds || conceptIds.length === 0) return {}
  return {
    OR: [
      { preferredConceptId: { in: conceptIds } },
      { orders: { some: { conceptId: { in: conceptIds }, deletedAt: null } } },
    ],
  }
}

/** The unsubscribe link for one delivered message. */
export function unsubscribeUrl(sendId: string): string {
  return `${API_BASE()}/api/v1/t/u/${sendId}`
}
