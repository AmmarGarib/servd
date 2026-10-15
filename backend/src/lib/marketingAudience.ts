// Who marketing can reach — ONE definition, used by campaigns and by every
// automated message (workers/loyaltyTriggers.ts). Nothing else may filter an
// audience on marketingOptOutAt / a ban flag by hand; the triggers used to, and
// banned customers kept getting birthday and win-back messages while the
// milestone note even went to people who had unsubscribed.
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

/**
 * Platform-level reachability, for automated messages that no one company
 * sends (activation, first-order welcome, second-order nudge): not deleted
 * and not unsubscribed. Bans (servd-wide since 2026-10-15) are NOT read here;
 * a caller that knows the sending company checks activeBanAtCompany /
 * reachableAtCompany, which read every active ban.
 */
export const reachableCustomer: Prisma.CustomerWhereInput = {
  deletedAt: null,
  marketingOptOutAt: null,
}

/**
 * Reachability for a message ONE company sends (campaigns, win-back): not
 * deleted, not unsubscribed, and not banned anywhere on servd (owner,
 * 2026-10-15: a ban is on the customer's servd account). Combine with
 * `companyAudience` for the brand audience.
 */
export async function reachableAtCompany(tenantId: string): Promise<Prisma.CustomerWhereInput> {
  const { bannedCustomerIdsAtCompany } = await import('./strikes.js')
  const banned = await bannedCustomerIdsAtCompany(tenantId)
  return {
    deletedAt: null,
    marketingOptOutAt: null,
    ...(banned.length > 0 && { id: { notIn: banned } }),
  }
}

/**
 * Brand audience. Empty list = every brand ON THE PLATFORM (every company) —
 * so a company-owned send must go through `companyAudience` below. Otherwise a customer counts for a
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

/**
 * Brand audience bounded to ONE company. `companyConceptIds` is every brand
 * of the company that owns the campaign; `picked` narrows it to some of those
 * brands (ids outside the company are dropped, never trusted). An empty pick
 * means every brand OF THAT COMPANY — never platform-wide — and a company with
 * no brands reaches nobody. Campaigns must use this, not `brandAudience`,
 * whose empty list means "everyone".
 */
export function companyAudience(companyConceptIds: string[], picked?: string[] | null): Prisma.CustomerWhereInput {
  const own = new Set(companyConceptIds)
  const ids = picked && picked.length > 0 ? picked.filter((id) => own.has(id)) : [...own]
  if (ids.length === 0) return { id: { in: [] } }
  return brandAudience(ids)
}

/** The unsubscribe link for one delivered message. */
export function unsubscribeUrl(sendId: string): string {
  return `${API_BASE()}/api/v1/t/u/${sendId}`
}
