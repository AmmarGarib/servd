// Leaving: HR is the person master (decision 31), so an employee who has left
// loses the login linked to them — but only once they have actually gone.
//
// A resignation or termination is APPLIED at approval (the status is what
// starts the notice period), so the login cannot be switched off then: the
// person still works out their notice. It is switched off once the last
// working day has passed (Karachi calendar), and only when that login is not
// still linked to a CURRENT employee record in another company — one login may
// be an employee in each company.
//
// Nothing here runs on its own. A daily worker calls deactivateLeftLogins for
// every company (see the report: workers/ and the auth middleware belong to
// another batch).

import { serviceClient as prisma } from '../../lib/prisma.js'
import { audit } from '../../lib/audit.js'
import { revokeAllForSubject } from '../../lib/tokenRevocation.js'
import { suspendData } from '../auth/accountStatus.js'
import { applyDueEffects } from './service.js'
import { pktToday } from './logic.js'

export const LEFT_STATUSES = ['resigned', 'terminated', 'separated']
const CURRENT = ['active', 'on_leave']

/** Has this employee record left as of `now`? A leaver with no last working
 *  day on the record is gone once terminated or separated; a resignation
 *  without one is still serving notice. */
export function hasLeft(e: { status: string; lastWorkingDay: Date | null }, now = new Date()): boolean {
  if (!LEFT_STATUSES.includes(e.status)) return false
  if (e.lastWorkingDay) return e.lastWorkingDay < pktToday(now)
  return e.status !== 'resigned'
}

/** Logins of this company's leavers that should be switched off, with why. */
export async function loginsToDeactivate(tenantId: string, now = new Date()) {
  const leavers = await prisma.hrEmployee.findMany({
    where: { tenantId, status: { in: LEFT_STATUSES }, userId: { not: null } },
    select: { id: true, userId: true, fullName: true, status: true, lastWorkingDay: true },
  })
  const gone = leavers.filter((e) => hasLeft(e, now))
  if (gone.length === 0) return []
  const userIds = Array.from(new Set(gone.map((e) => e.userId!)))
  const [stillEmployed, users] = await Promise.all([
    prisma.hrEmployee.findMany({ where: { userId: { in: userIds }, status: { in: CURRENT } }, select: { userId: true } }),
    // Not yet suspended by the one status column (auth/accountStatus.ts) — a
    // row switched off through isActive alone is finished off here too.
    prisma.user.findMany({ where: { id: { in: userIds }, deletedAt: null, OR: [{ isActive: true }, { accountStatus: { not: 'suspended' } }] }, select: { id: true, email: true, role: true } }),
  ])
  const keep = new Set(stillEmployed.map((e) => e.userId!))
  const active = new Map(users.map((u) => [u.id, u]))
  // The CEO's own login is never switched off by an HR record.
  return gone
    .filter((e) => !keep.has(e.userId!) && active.has(e.userId!) && active.get(e.userId!)!.role !== 'admin')
    .map((e) => ({ employeeId: e.id, userId: e.userId!, fullName: e.fullName, status: e.status, lastWorkingDay: e.lastWorkingDay }))
}

/** Switch off the logins of this company's leavers — suspended through the
 *  standard write set (accountStatus 'suspended' + the isActive mirror), so
 *  Workforce lists them as suspended (audit PPL-15). Idempotent. */
export async function deactivateLeftLogins(tenantId: string, now = new Date()): Promise<number> {
  await applyDueEffects(tenantId, now)
  const due = await loginsToDeactivate(tenantId, now)
  for (const d of due) {
    const n = await prisma.user.updateMany({
      where: { id: d.userId, OR: [{ isActive: true }, { accountStatus: { not: 'suspended' } }] },
      data: suspendData(),
    })
    if (n.count === 0) continue
    await revokeAllForSubject(d.userId)
    await audit({
      category: 'identity', action: 'hr.separation.login_deactivated', entity: 'User', entityId: d.userId,
      userId: null, userEmail: null, tenantId,
      after: { employeeId: d.employeeId, status: d.status, lastWorkingDay: d.lastWorkingDay },
    })
  }
  return due.length
}
