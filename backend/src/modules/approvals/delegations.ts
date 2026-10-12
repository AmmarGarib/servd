// Hand-over of approval types (D3, LATER — needs head office).
//
// Not built yet: there is no delegation table. This is the one seam the inbox
// consults per type, so when head office exists an ApprovalDelegation table
// (per company: approvalType, delegateUserId, grantedById, expiresAt?,
// revokedAt?) plugs in here without touching the providers.
//
// NOTE for whoever builds it: listing a type here only lets the inbox ASK the
// module. The module's own approve route still decides — each delegable
// type's route must also accept the delegate (an assertCanApprove(req, type,
// tenantId) helper reading the same table) before a delegate can act, and its
// queue route must list for them. Until then a delegate sees nothing, which
// is the safe failure.

import type { ApprovalType } from './types.js'

export interface ApprovalDelegations {
  /** Approval types handed to this user for any of these companies, live now. */
  typesFor(userId: string, tenantIds: readonly string[]): Promise<ReadonlySet<ApprovalType>>
}

/** Today: nobody holds a delegation. */
export const NO_DELEGATIONS: ApprovalDelegations = {
  async typesFor() { return new Set<ApprovalType>() },
}
