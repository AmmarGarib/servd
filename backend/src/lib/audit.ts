// Audit log helper — forensic record of high-stakes mutations.
//
// Don't audit reads, list endpoints, or anything in the order ingestion path
// (the journal IS the audit record there). Audit:
//   - period close
//   - chart-of-accounts changes
//   - wage rate / concept-access updates
//   - manual journal entries
//   - cost allocation rule changes
//   - bank reconciliation adjustments

import { prisma } from './prisma.js'

export interface AuditEvent {
  action: string
  entity: string
  entityId?: string | null
  userId?: string | null
  userEmail?: string | null
  before?: unknown
  after?: unknown
  metadata?: unknown
}

export async function audit(event: AuditEvent): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
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
