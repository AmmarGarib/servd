// Separation-of-duties enforcement — THE one helper.
//
// Blocks the same person from being both the creator and the approver /
// receiver of a high-risk record: receiving goods against a PO you raised,
// approving or rejecting a recipe you submitted, and so on.
//
// There used to be two helpers with this name and different rules: this file
// blocked everyone (the CEO included) and raised an exception flag; a second
// copy in auth/middleware.ts exempted the CEO and raised nothing. Owner
// decision 27 (2026-09-27): the rule applies to everyone EXCEPT the CEO
// (role `admin`), who is the final authority. Every attempt that is blocked
// fires a `self_approval` ExceptionFlag so the owner sees it.
//
// We don't block in the database — too coarse. Each module calls
// `assertNotSelfApproval` before the mutation.

import { AppError } from './errors.js'
import { flagException } from './exceptions.js'

export interface SelfApprovalCheck {
  /** Who is attempting the privileged action (usually `req.staffUser!`). */
  actor:     { id: string; role: string }
  /** Who created / submitted the predecessor record. Null = predates tracking: allowed. */
  creatorId: string | null | undefined
  /** Human label for the audit trail ("receive goods", "approve recipe"). */
  action:    string
  /** Entity type for the flag ("PurchaseOrder", "Recipe"). */
  entity:    string
  /** Entity primary key. */
  entityId:  string
  /** Optional message shown to the user instead of the default. */
  message?:  string
}

/** True when this actor is exempt from separation of duties (the CEO). */
export function isSelfApprovalExempt(actor: { role: string }): boolean {
  return actor.role === 'admin'
}

/**
 * Throw 403 SELF_APPROVAL_BLOCKED (and raise a `self_approval` flag) if the
 * actor is the person who created the source record. The CEO is exempt.
 */
export async function assertNotSelfApproval(opts: SelfApprovalCheck): Promise<void> {
  if (isSelfApprovalExempt(opts.actor)) return          // CEO is the final authority
  if (!opts.creatorId) return                           // no creator on file, nothing to compare
  if (opts.creatorId !== opts.actor.id) return          // different humans, fine

  await flagException({
    kind: 'self_approval',
    severity: 'high',
    title: `Self-approval blocked: ${opts.action}`,
    description: `User attempted to ${opts.action} on a ${opts.entity} they created themselves. Blocked. Have a different staff member (or the CEO) complete the action.`,
    entityType: opts.entity,
    entityId: opts.entityId,
    actorId: opts.actor.id,
  })

  throw new AppError(
    'SELF_APPROVAL_BLOCKED',
    opts.message ?? `You can't ${opts.action} on a ${opts.entity} you created. Have a colleague or the CEO complete the action.`,
    403,
  )
}
