// Separation-of-duties enforcement.
//
// Block the same user from being both creator + approver of high-risk records.
// Used in: PO receiving (creator ≠ receiver), payroll (employee ≠ approver),
// bank reconciliation (poster ≠ reconciler), supplier creation (admin only).
//
// We don't block in the database — too coarse. Instead each module imports
// `assertNotSelfApproval` and calls it before the mutation. Self-approval
// attempts fire an ExceptionFlag (kind='self_approval') and throw a 403.

import { AppError } from './errors.js'
import { flagException } from './exceptions.js'

/**
 * Throw if `actorId` is the same user that created the source record. Use
 * for receiver-vs-PO-creator, approver-vs-employee, etc.
 *
 * @param actorId        User attempting the privileged action (e.g. accepting GRN)
 * @param creatorId      User who created the predecessor record (e.g. submitted PO)
 * @param action         Human label for the audit trail ("receive_goods", "approve_payroll")
 * @param entity         Entity type for the flag ("PurchaseOrder", "PayrollRun")
 * @param entityId       Entity primary key
 */
export async function assertNotSelfApproval(opts: {
  actorId:   string
  creatorId: string | null | undefined
  action:    string
  entity:    string
  entityId:  string
}): Promise<void> {
  if (!opts.creatorId) return                           // no creator on file, nothing to compare
  if (opts.creatorId !== opts.actorId) return           // different humans, fine

  // Same user. Fire a flag for audit and refuse.
  await flagException({
    kind: 'self_approval',
    severity: 'high',
    title: `Self-approval blocked: ${opts.action}`,
    description: `User attempted to ${opts.action} on a ${opts.entity} they created themselves. Blocked. Have a different staff member complete the action.`,
    entityType: opts.entity,
    entityId: opts.entityId,
    actorId: opts.actorId,
  })

  throw new AppError(
    'SELF_APPROVAL_BLOCKED',
    `You can't ${opts.action} on a ${opts.entity} you created. Have a colleague complete the action.`,
    403,
  )
}
