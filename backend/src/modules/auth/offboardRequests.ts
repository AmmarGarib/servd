// HR's offboard of a login waits for the CEO (owner, 2026-11-05: "Give option to
// HR for off boarding a user/employee with final approval of CEO").
//
//   • POST /auth/staff/:id/offboard {reason ≥10} by anyone but the CEO (HR with
//     staff_hr — OFFBOARDERS) changes NOTHING on the login: it raises a
//     LoginOffboardRequest and answers 202 { pendingApproval, request }. One
//     pending per login (409 OFFBOARD_PENDING); an already switched-off login
//     409 ALREADY_OFFBOARDED. The CEO's own offboard applies at once, and closes
//     a pending request for that login as approved in the same transaction.
//   • Approval type staff_offboard (lib/approvalRights.ts: section ceo, never
//     handed over). The CEO approves / rejects here; the approvals inbox reads
//     GET /auth/staff/offboard-requests?status=pending through its provider
//     (offboardApprovalProvider.ts) and calls these routes.
//   • Approve re-checks the target (still in the CEO's companies via
//     findManagedStaff, never the CEO's own login, never an admin / co-owner),
//     then switchOffLogin (suspend + revoke every session) with the request
//     claimed in the same transaction (409 REQUEST_NOT_PENDING), and writes the
//     same `staff.offboard` audit row as a direct offboard (+ approvedBy /
//     requestedBy). Reject needs a note ≥10. Withdraw: the requester or the CEO.
//   • tenantId = the TARGET login's company (auditCompanyOf). Another company's
//     request → 404. The HR leaver sweep (hr/separations.ts) is unchanged.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY } from './middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { audit } from '../../lib/audit.js'
import { accountStateOf } from './accountStatus.js'
import { findManagedStaff, auditCompanyOf } from './staffAccounts.js'
import { OFFBOARDERS, assertHrBackOffice, switchOffLogin } from './offboarding.js'

export const OFFBOARD_REASON = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500)

const STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const

/** The refusals every offboard path shares (direct, request, approval). */
export function assertOffboardable(req: FastifyRequest, target: { id: string; role: string }): void {
  if (target.id === req.staffUser!.id) throw new AppError('CANNOT_OFFBOARD_SELF', 'You cannot offboard your own login.', 403)
  if (target.role === 'admin') throw new AppError('CANNOT_OFFBOARD_CEO', "The CEO's login cannot be offboarded.", 403)
  // Owner (2026-10-16): "Co owner cannot be fired" — by HR or the CEO.
  if (target.role === 'owner') throw new AppError('CANNOT_OFFBOARD_OWNER', "A co-owner's login cannot be offboarded.", 403)
}

/**
 * Raise HR's request (the caller checked scope and the refusals). Nothing on
 * the login changes. The CEO is told on the bell (queued, after the write).
 */
export async function raiseOffboardRequest(
  req: FastifyRequest,
  target: { id: string; name: string | null; email: string | null; role: string; tenantId: string | null; companies: string[]; accountStatus?: unknown; isActive?: unknown },
  reason: string,
) {
  if (accountStateOf(target as Parameters<typeof accountStateOf>[0]) === 'suspended') {
    throw new AppError('ALREADY_OFFBOARDED', 'This login is already switched off.', 409)
  }
  const tenantId = auditCompanyOf(target)
  // A company-less login is the CEO's alone (findManagedStaff never hands it to HR).
  if (!tenantId) throw new NotFoundError('Staff member')
  let row
  try {
    row = await prisma.loginOffboardRequest.create({
      data: { tenantId, userId: target.id, reason, requestedById: req.staffUser!.id },
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new AppError('OFFBOARD_PENDING', 'An offboard of this login is already waiting for the CEO.', 409)
    }
    throw err
  }
  await audit({
    category: 'identity', action: 'staff.offboard_request', entity: 'LoginOffboardRequest', entityId: row.id,
    userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId,
    after: { targetUserId: target.id, targetEmail: target.email, role: target.role, reason },
    metadata: { actorTenantId: req.staffUser!.tenantId ?? null, actorRole: req.staffUser!.role },
  })
  approvalWaiting('staff_offboard', row.id, { round: row.createdAt.toISOString(), actorId: req.staffUser!.id })
  return row
}

/** The CEO's direct offboard closes any pending request for the login as approved (inside switchOffLogin's tx). */
export function closePendingOffboardTx(userId: string, ceoId: string) {
  return async (tx: Prisma.TransactionClient) => {
    await tx.loginOffboardRequest.updateMany({
      where: { userId, status: 'pending' },
      data: { status: 'approved', decidedById: ceoId, decidedAt: new Date(), decisionNote: 'Offboarded by the CEO directly' },
    })
  }
}

export async function offboardRequestRoutes(fastify: FastifyInstance) {
  // GET /auth/staff/offboard-requests?status=pending&userId= — the requests of
  // the companies in view, with the login's and the requester's names. HR (with
  // staff_hr) and the CEO; the approvals inbox reads it as the CEO.
  fastify.get<{ Querystring: { status?: string; userId?: string } }>(
    '/staff/offboard-requests',
    { preHandler: requireAuth(...OFFBOARDERS) },
    async (req) => {
      await assertHrBackOffice(req)
      const scope = await scopeTenantWhere(req, 'read')
      const status = (STATUSES as readonly string[]).includes(req.query.status ?? '') ? req.query.status : undefined
      const rows = await prisma.loginOffboardRequest.findMany({
        where: { ...scope, ...(status ? { status } : {}), ...(req.query.userId ? { userId: req.query.userId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      const userIds = [...new Set(rows.flatMap((r) => [r.userId, r.requestedById, r.decidedById].filter((x): x is string => !!x)))]
      const tenantIds = [...new Set(rows.map((r) => r.tenantId))]
      const [users, tenants] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true, role: true } }),
        prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }),
      ])
      const u = new Map(users.map((x) => [x.id, x]))
      const t = new Map(tenants.map((x) => [x.id, x.name]))
      return {
        items: rows.map((r) => ({
          ...r,
          login: u.has(r.userId) ? { id: r.userId, name: u.get(r.userId)!.name, email: u.get(r.userId)!.email, role: u.get(r.userId)!.role } : null,
          companyName: t.get(r.tenantId) ?? null,
          requestedByName: u.get(r.requestedById)?.name ?? null,
          decidedByName: r.decidedById ? u.get(r.decidedById)?.name ?? null : null,
        })),
      }
    },
  )

  async function forDecision(req: FastifyRequest, id: string) {
    const scope = await scopeTenantWhere(req, 'write')
    const r = await prisma.loginOffboardRequest.findFirst({ where: { id, ...scope } })
    if (!r) throw new NotFoundError('Offboard request', id)
    return r
  }

  async function grantFor(req: FastifyRequest, id: string) {
    const s = await approvalSubject('staff_offboard', id)
    if (!s) throw new NotFoundError('Offboard request', id)
    return assertCanApprove(req, approvalInputOf('staff_offboard', id, s))
  }

  const notPending = () => new AppError('REQUEST_NOT_PENDING', 'This offboard request is no longer waiting for the CEO.', 409)

  // POST /auth/staff/offboard-requests/:id/approve — the CEO switches the login off now.
  fastify.post<{ Params: { id: string } }>(
    '/staff/offboard-requests/:id/approve',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => {
      const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {})
      const r = await forDecision(req, req.params.id)
      const grant = await grantFor(req, r.id)
      if (r.status !== 'pending') throw notPending()
      // The target as it is NOW: still in the CEO's companies, still not the CEO's own / an admin / a co-owner.
      const target = await findManagedStaff(req, r.userId, { id: true, name: true, email: true, role: true, accountStatus: true, isActive: true })
      assertOffboardable(req, target)
      const before = accountStateOf(target)
      const decidedAt = new Date()
      const changed = await switchOffLogin(target.id, async (tx) => {
        const claimed = await tx.loginOffboardRequest.updateMany({
          where: { id: r.id, status: 'pending' },
          data: { status: 'approved', decidedById: req.staffUser!.id, decidedAt, decisionNote: body.note ?? null },
        })
        if (claimed.count === 0) throw notPending()
      })
      if (changed) {
        await audit({
          category: 'identity', action: 'staff.offboard', entity: 'User', entityId: target.id,
          userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: auditCompanyOf(target),
          before: { accountStatus: before },
          after: { accountStatus: 'suspended', reason: r.reason, targetEmail: target.email, role: target.role },
          metadata: { actorTenantId: req.staffUser!.tenantId ?? null, actorRole: req.staffUser!.role, approvedBy: req.staffUser!.id, requestedBy: r.requestedById, requestId: r.id },
        })
      }
      await audit({
        category: 'identity', action: 'staff.offboard_request.approve', entity: 'LoginOffboardRequest', entityId: r.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId,
        metadata: { targetUserId: target.id, requestedBy: r.requestedById, alreadyOffboarded: !changed, note: body.note ?? null },
      })
      await auditApproval(req, {
        type: 'staff_offboard', id: r.id, tenantId: r.tenantId, decision: 'approve', grant, entity: 'LoginOffboardRequest',
        metadata: { targetUserId: target.id, note: body.note ?? null, decidedAt },
      })
      return { id: r.id, approved: true, userId: target.id, status: 'suspended' as const, alreadyOffboarded: !changed }
    },
  )

  // POST /auth/staff/offboard-requests/:id/reject {note ≥10} — the CEO turns it down; the login is untouched.
  fastify.post<{ Params: { id: string } }>(
    '/staff/offboard-requests/:id/reject',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => {
      const body = z.object({ note: OFFBOARD_REASON }).parse(req.body ?? {})
      const r = await forDecision(req, req.params.id)
      const grant = await grantFor(req, r.id)
      const decidedAt = new Date()
      const claimed = await prisma.loginOffboardRequest.updateMany({
        where: { id: r.id, status: 'pending' },
        data: { status: 'rejected', decidedById: req.staffUser!.id, decidedAt, decisionNote: body.note },
      })
      if (claimed.count === 0) throw notPending()
      await audit({
        category: 'identity', action: 'staff.offboard_request.reject', entity: 'LoginOffboardRequest', entityId: r.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId,
        metadata: { targetUserId: r.userId, requestedBy: r.requestedById, note: body.note },
      })
      await auditApproval(req, {
        type: 'staff_offboard', id: r.id, tenantId: r.tenantId, decision: 'reject', grant, entity: 'LoginOffboardRequest',
        metadata: { targetUserId: r.userId, note: body.note, decidedAt },
      })
      return { id: r.id, rejected: true }
    },
  )

  // POST /auth/staff/offboard-requests/:id/withdraw — the requester (or the CEO) takes it back.
  fastify.post<{ Params: { id: string } }>(
    '/staff/offboard-requests/:id/withdraw',
    { preHandler: requireAuth(...OFFBOARDERS) },
    async (req) => {
      await assertHrBackOffice(req)
      const r = await forDecision(req, req.params.id)
      if (req.staffUser!.role !== 'admin' && r.requestedById !== req.staffUser!.id) {
        throw new AppError('NOT_YOUR_REQUEST', 'Only the person who asked (or the CEO) may withdraw it.', 403)
      }
      const claimed = await prisma.loginOffboardRequest.updateMany({
        where: { id: r.id, status: 'pending' },
        data: { status: 'withdrawn', decidedById: req.staffUser!.id, decidedAt: new Date() },
      })
      if (claimed.count === 0) throw notPending()
      await audit({
        category: 'identity', action: 'staff.offboard_request.withdraw', entity: 'LoginOffboardRequest', entityId: r.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId,
        metadata: { targetUserId: r.userId, requestedBy: r.requestedById, actorRole: req.staffUser!.role },
      })
      return { id: r.id, withdrawn: true }
    },
  )
}
