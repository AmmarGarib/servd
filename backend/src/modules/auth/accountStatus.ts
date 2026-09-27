import type { AccountStatus, Prisma } from '@prisma/client'

/**
 * Staff account state — ONE canonical column.
 *
 * Suspension used to live in two: `User.isActive` and
 * `accountStatus = 'suspended'`. Reject wrote both, deactivating from
 * Workforce wrote only isActive, and GET /auth/users?status=suspended read
 * only accountStatus — so anyone switched off from Workforce was missing from
 * the "suspended" list, and the page re-derived the status in the browser to
 * cover for it.
 *
 * The rule now:
 *   • accountStatus is the truth for pending / active / suspended;
 *   • deletedAt is the truth for removal;
 *   • isActive is a MIRROR, written alongside accountStatus by the helpers
 *     below and never set on its own. It stays until every reader has moved;
 *     until the backfill has run (UPDATE … SET accountStatus='suspended' WHERE
 *     isActive=false), a row with isActive=false still reads as suspended.
 *
 * Every read and write of these columns in the auth module goes through here.
 */

/** Prisma filter for "this account may sign in / act / approve". */
export const ACTIVE_ACCOUNT_WHERE = {
  isActive: true,
  accountStatus: 'active',
  deletedAt: null,
} as const satisfies Prisma.UserWhereInput

interface AccountRow {
  isActive: boolean
  accountStatus: AccountStatus
  deletedAt: Date | null
}

/** The one status everything displays and filters on. */
export function accountStateOf(u: Pick<AccountRow, 'isActive' | 'accountStatus'>): AccountStatus {
  // Legacy rows switched off through isActive alone are suspended, whatever
  // accountStatus says — until the backfill makes the two agree.
  if (u.accountStatus === 'suspended' || !u.isActive) return 'suspended'
  return u.accountStatus
}

/** May this account sign in and act? The auth middleware's gate. */
export function isAccountActive(u: AccountRow | null | undefined): boolean {
  return !!u && u.deletedAt === null && accountStateOf(u) === 'active'
}

/** Prisma filter for GET /auth/users?status=… matching accountStateOf(). */
export function whereAccountState(state: AccountStatus): Prisma.UserWhereInput {
  switch (state) {
    case 'suspended': return { OR: [{ accountStatus: 'suspended' }, { isActive: false }] }
    case 'active':    return { accountStatus: 'active', isActive: true }
    case 'pending':   return { accountStatus: 'pending', isActive: true }
  }
}

/** Write set for suspending (deactivate, reject). */
export function suspendData(): { accountStatus: AccountStatus; isActive: boolean } {
  return { accountStatus: 'suspended', isActive: false }
}

/**
 * Write set for lifting a suspension. A pending hire stays pending — switching
 * "active" on is not a back door around the CEO's approve step.
 */
export function reactivateData(current: AccountStatus): { accountStatus: AccountStatus; isActive: boolean } {
  return { accountStatus: current === 'pending' ? 'pending' : 'active', isActive: true }
}

/** Write set for approving a pending hire. */
export function approveData(): { accountStatus: AccountStatus; isActive: boolean } {
  return { accountStatus: 'active', isActive: true }
}

/** Write set for a soft delete. The row keeps its status for the record. */
export function softDeleteData(): { deletedAt: Date; isActive: boolean } {
  return { deletedAt: new Date(), isActive: false }
}
