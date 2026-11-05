// Onboarding and offboarding logins (owner, 2026-10-15).
//
// "HR should basically be allowed to onboard and offboard people from the ERP,
// same as in real life. And I can do that too. The only person HR can't fire
// is me and the only person I can't fire is me."
//
//   • HR (and the CEO through the invite route) add a FLOOR login (cashier,
//     FOH, BOH, kitchen, expediter — the code-login roles) ACTIVE at once;
//     every other role waits for the CEO in the approvals inbox (staff_login).
//     Other inviters (managers) keep "always pending".
//   • Activation has ONE set of side effects (employee link, set-password
//     link) whether the CEO approved a pending login or HR's floor login was
//     active at once: activationSideEffects below.
//   • Switching a login off is ONE write (switchOffLogin): suspended through
//     accountStatus.ts and every session revoked. The HR leaver sweep
//     (hr/separations.ts) and POST /auth/staff/:id/offboard both use it.
//   • Since 2026-11-05 (owner: "Give option to HR for off boarding a
//     user/employee with final approval of CEO") HR's offboard is a REQUEST the
//     CEO approves (offboardRequests.ts, approval type staff_offboard); the
//     CEO's own offboard applies at once. The HR leaver sweep is unchanged (a
//     separation is already an approved HR request).
import type { FastifyRequest } from 'fastify'
import type { Prisma, UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { revokeAllForSubject } from '../../lib/tokenRevocation.js'
import { disconnectUser } from '../../lib/ws.js'
import { suspendData } from './accountStatus.js'
import { isFloorRole } from './middleware.js'
import { requestPasswordReset, deliveryConfigured } from './passwordReset.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { AppError } from '../../lib/errors.js'

/** Who onboards and offboards logins: HR and the CEO. */
export const OFFBOARDERS = ['admin', 'hr'] as UserRole[]

/** HR's onboarding / offboarding runs from the HR back office: an HR login
 *  needs the staff_hr module (the CEO's untick closes it). Other roles pass. */
export async function assertHrBackOffice(req: FastifyRequest): Promise<void> {
  if (req.staffUser?.role !== 'hr') return
  const me = await prisma.user.findUnique({ where: { id: req.staffUser.id }, select: { moduleAllow: true, moduleDeny: true } })
  const mods = await effectiveModulesForUser({ role: 'hr', moduleAllow: me?.moduleAllow ?? [], moduleDeny: me?.moduleDeny ?? [] })
  if (!mods.has('staff_hr')) {
    throw new AppError('FORBIDDEN', 'Your account does not have access to this module (staff_hr). Ask the CEO to enable it in Module Access.', 403)
  }
}

/** Is a login of `role`, added by `inviterRole`, active at once (no CEO approval)? */
export function activeAtOnce(inviterRole: UserRole | string, role: UserRole | string): boolean {
  return (inviterRole === 'hr' || inviterRole === 'admin') && isFloorRole(role)
}

/**
 * What happens when a login becomes active — a CEO approval, or an HR floor
 * login made active at once. Links the HR employee (re-validated: still this
 * company's, still without a login) and sends the set-your-password link when
 * a channel exists. Never throws: a failure is logged and reported, and HR can
 * link the employee / the CEO can issue a password afterwards.
 */
export async function activationSideEffects(
  req: FastifyRequest,
  user: { id: string; email: string | null; tenantId: string | null; role?: UserRole | string | null },
  employeeId: string | null | undefined,
  opts: { sendPasswordLink?: boolean } = {},
): Promise<{ linkedEmployeeId: string | null; passwordLink: 'sent' | 'unavailable' | 'failed' }> {
  let linkedEmployeeId: string | null = null
  if (employeeId && user.tenantId) {
    const linked = await prisma.hrEmployee.updateMany({
      where: { id: employeeId, tenantId: user.tenantId, userId: null },
      data: { userId: user.id },
    }).catch((err) => { req.log.warn({ err, employeeId, userId: user.id }, 'login activation: employee link failed'); return { count: 0 } })
    if (linked.count === 1) linkedEmployeeId = employeeId
    else req.log.warn({ employeeId, userId: user.id }, 'login activation: employee no longer linkable')
  }

  let passwordLink: 'sent' | 'unavailable' | 'failed' = 'unavailable'
  // A floor login signs in with a WhatsApp code and never gets a password
  // (owner C14, 2026-10-26: "Don't give floor staff passwords").
  if (opts.sendPasswordLink !== false && user.email && await deliveryConfigured().catch(() => false)) {
    try {
      const outcome = await requestPasswordReset(user.email, req.ip ?? null)
      passwordLink = outcome.email === 'sent' || outcome.whatsapp === 'sent' ? 'sent' : 'failed'
      if (outcome.errors.length) req.log.error({ userId: user.id, outcome }, 'login activation: password link delivery failed')
    } catch (err) {
      passwordLink = 'failed'
      req.log.error({ err, userId: user.id }, 'login activation: password link failed')
    }
  }
  return { linkedEmployeeId, passwordLink }
}

/**
 * Switch a login off: suspended (accountStatus + the isActive mirror) and every
 * outstanding session revoked. Idempotent — returns false when it was already
 * suspended (sessions are revoked either way). Callers decide WHO may do it
 * (never the CEO's login through HR, never one's own) and audit it.
 */
export async function switchOffLogin(
  userId: string,
  /** Runs in the same transaction as the suspend (offboard requests: claim / close the CEO's request). */
  inTx?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<boolean> {
  const count = await prisma.$transaction(async (tx) => {
    const n = await tx.user.updateMany({
      where: { id: userId, deletedAt: null, OR: [{ isActive: true }, { accountStatus: { not: 'suspended' } }] },
      data: suspendData(),
    })
    if (inTx) await inTx(tx)
    return n.count
  })
  await revokeAllForSubject(userId)
  // The bell's per-user socket room: an offboarded login's open tab stops receiving pings.
  disconnectUser(userId)
  return count > 0
}
