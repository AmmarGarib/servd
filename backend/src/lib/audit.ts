// Audit log helper — forensic record of high-stakes mutations.
//
// TWO TRAILS, ONE TABLE, DIFFERENT AUDIENCES.
//
//   'identity'   Who exists, what access they hold, and what they did on
//                shift. User creation, role assignment, permission changes,
//                account enable/disable, credential reissues — plus the
//                operational actions staff take: refunds, voids, comps, gift
//                cards, stock moves, reservations. Read by managers.
//
//   'accounting' What hit the BOOKS. Period closes and re-openings, manual
//                journal entries, wage rates, tip-pool postings, cost
//                allocation rules, bank reconciliation adjustments. Read by
//                the CEO and exec only, behind its own module.
//
// The dividing question is "does this change the books?", not "is money
// involved". A cashier refunding an order is an operational act by a person on
// shift; closing a period is not. When a new call site is genuinely ambiguous,
// file it as 'identity': that narrows who can read it rather than widening it.
//
// Don't audit reads, list endpoints, or anything in the order ingestion path
// (the journal IS the audit record there).

import { prisma } from './prisma.js'

/** Which trail an event belongs to. See the header for the dividing line. */
export type AuditCategory = 'identity' | 'accounting'

export interface AuditEvent {
  /**
   * Required, with no default. A default would silently file every new call
   * site into one trail, and the failure would be invisible: the event still
   * appears in SOME log, just the wrong one — which is worse than not logging
   * it, because the trail that should hold it looks complete.
   */
  category: AuditCategory
  action: string
  entity: string
  entityId?: string | null
  userId?: string | null
  userEmail?: string | null
  /**
   * The company the actor was working in AT THE TIME.
   *
   * Pass req.staffUser.tenantId. It is the acting company, not the actor's
   * company: operators here belong to more than one and switch between them,
   * so reading it off the user later gives whichever they happen to be in now.
   * That is why this has to be stamped at write time and cannot be backfilled.
   */
  tenantId?: string | null
  before?: unknown
  after?: unknown
  metadata?: unknown
}

export async function audit(event: AuditEvent): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        category: event.category,
        tenantId: event.tenantId ?? null,
        action: event.action,
        entity: event.entity,
        entityId: event.entityId ?? null,
        userId: event.userId ?? null,
        userEmail: event.userEmail ?? null,
        before: (event.before ?? null) as never,
        after: (event.after ?? null) as never,
        metadata: (event.metadata ?? null) as never,
      },
    })
  } catch (err) {
    // Audit failures should NEVER break the underlying mutation. Log and move on.
    console.error('[audit] failed:', (err as Error).message, { action: event.action, entity: event.entity })
  }
}
