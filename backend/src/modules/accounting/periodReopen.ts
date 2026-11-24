// Reopening a closed period — the ONE engine, and finance's request to the CEO.
// (owner, 2026-11-24: "Where to request to open a closed period to do postings in that closed period?" → "Build both".)
//
// Reopening itself stays the CEO's (owner decision 21): it removes only the LATEST lock, needs a reason, is audited
// 'period.reopen', parks the close record in the Trash and raises a high 'period_reopened' flag.
//
//   • The CEO reopens directly: POST /accounting/period-close/reopen (routes.ts) → reopenLatestClose. The reopened
//     window is the CEO's alone (closedBooks.ts).
//   • Finance (role `finance` holding `accounting`) ASKS: POST /accounting/period-close/reopen-requests {reason ≥10}
//     for the ACTIVE company → 202, nothing changes. One pending per company (409 REOPEN_PENDING); nothing closed
//     422 NOTHING_TO_REOPEN. Approval type `period_reopen` (section ceo, never delegable):
//       POST …/reopen-requests/:id/approve   the CEO — the request is claimed and the latest close reopened in ONE
//                                            transaction; 409 CLOSE_CHANGED when the latest close is no longer the
//                                            one asked for (closed further, or already reopened). The window is then
//                                            ALSO open to finance (closedBooks.ts allowFinanceInReopened) until the
//                                            books are closed through it again.
//       POST …/reopen-requests/:id/reject    the CEO, note ≥10.
//       POST …/reopen-requests/:id/withdraw  the requester or the CEO.
//       GET  …/reopen-requests?status=       finance and the CEO, companies in view.
//     Another company's request is 404.
//   • WHICH PERIOD (owner, 2026-11-24): both doors take `from` (YYYY-MM-DD, the first day to open; 422
//     FROM_NOT_CLOSED when it is after the latest close). Every close covering that day or later is removed and the
//     days before it stay closed. None = the latest close only. A request stores it as `reopenFrom`.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { moveToTrash } from '../../lib/trash.js'
import { takeSnapshot } from '../trash/snapshot.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { allowFinanceInReopened, rememberReopened } from './closedBooks.js'
import { fmtPktDate, parsePktStartOfDay } from './dates.js'

// "Reopen from" (owner, 2026-11-24: "Not giving option to select period required to reopen"): the first day to open,
// YYYY-MM-DD. Every close covering that day or later is removed; the days BEFORE it stay closed (a lock through the
// day before is kept — written when no earlier close ends exactly there). None = the latest close only.
const FROM = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date').optional()
function fromDate(input: string | undefined): Date | undefined {
  if (!input) return undefined
  const d = parsePktStartOfDay(input)
  if (Number.isNaN(d.getTime())) throw new AppError('INVALID_DATE', 'That is not a date', 422)
  return d
}
const notClosed = (from: Date, latest: Date) =>
  new AppError('FROM_NOT_CLOSED', `${fmtPktDate(from)} is not in closed books — they are closed through ${fmtPktDate(latest)}.`, 422)

const REASON = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500)
const STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const
const notPending = () => new AppError('REQUEST_NOT_PENDING', 'This request was already decided or withdrawn — reload.', 409)

/**
 * Reopen the company's LATEST close (the caller proved the right — the CEO). `expect`: the close a request asked for —
 * refused (409 CLOSE_CHANGED) when the latest close is another one. `forFinance`: the approved request's id — the
 * reopened window is then open to finance too. `claim` runs first inside the transaction (a request's own claim).
 */
export async function reopenLatestClose(
  req: FastifyRequest, tenantId: string, reason: string,
  opts: { expect?: Date; from?: Date | null; forFinanceRequestId?: string; claim?: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void> } = {},
) {
  const latest = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext('period-reopen'))`
    if (opts.claim) await opts.claim(tx)
    const l = await tx.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' } })
    if (!l) throw new AppError('NOTHING_TO_REOPEN', 'This company has no closed period', 422)
    if (opts.expect && l.lockedThrough.getTime() !== opts.expect.getTime()) {
      throw new AppError('CLOSE_CHANGED', `The books are now closed through ${fmtPktDate(l.lockedThrough)}, not ${fmtPktDate(opts.expect)} as when this was asked — reject it and ask again.`, 409)
    }
    if (opts.from && opts.from > l.lockedThrough) throw notClosed(opts.from, l.lockedThrough)
    // Every close that covers the first day to open, newest first (none named: the latest only).
    const removed = opts.from
      ? await tx.periodLock.findMany({ where: { tenantId, lockedThrough: { gte: opts.from } }, orderBy: { lockedThrough: 'desc' } })
      : [l]
    for (const lock of removed) {
      // F4: the close record (overrides, acknowledgement reasons) is kept for ever in the Trash (type 'period_lock',
      // the CEO's — never restored: close the month again through the checklist; never erased).
      await moveToTrash(tx, req, {
        type: 'period_lock', entityId: lock.id, tenantId,
        title: `Books closed through ${fmtPktDate(lock.lockedThrough)}`,
        subtitle: lock.note ?? null, reason,
        snapshot: takeSnapshot('PeriodLock', lock),
      })
      await tx.periodLock.delete({ where: { id: lock.id } })
    }
    if (opts.from) {
      // The days before the first day to open were closed by the removed close(s): they stay closed.
      const keep = new Date(opts.from.getTime() - 1)
      const earlier = await tx.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
      if (!earlier || earlier.lockedThrough.getTime() < keep.getTime()) {
        await tx.periodLock.create({
          data: {
            tenantId, lockedThrough: keep, lockedBy: req.staffUser!.id,
            note: `Kept closed when the books were reopened from ${fmtPktDate(opts.from)} (part of the close through ${fmtPktDate(l.lockedThrough)})`,
          },
        })
      }
    }
    await rememberReopened(tx, tenantId, l.lockedThrough)
    if (opts.forFinanceRequestId) await allowFinanceInReopened(tx, tenantId, opts.forFinanceRequestId)
    return l
  })
  const now = await prisma.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
  await audit({
    category: 'accounting', action: 'period.reopen', entity: 'PeriodLock', entityId: latest.id,
    userId: req.staffUser!.id, tenantId, userEmail: req.staffUser!.email,
    before: latest, after: { lockedThrough: now?.lockedThrough ?? null },
    metadata: { reason, ip: req.ip, ...(opts.from && { reopenedFrom: opts.from }), ...(opts.forFinanceRequestId && { requestId: opts.forFinanceRequestId, openToFinance: true }) },
  })
  const { flagException } = await import('../../lib/exceptions.js')
  await flagException({
    tenantId, kind: 'period_reopened', severity: 'high',
    title: `Period reopened — books were closed through ${fmtPktDate(latest.lockedThrough)}`,
    description: `${req.staffUser!.email} reopened the books${opts.forFinanceRequestId ? " at finance's request (finance may post there until it is closed again)" : ''}. Postings dated after ${now ? fmtPktDate(now.lockedThrough) : 'the start of the ledger'} are allowed again. Reason: ${reason}. Review any new entries before re-closing.`,
    entityType: 'PeriodLock', entityId: latest.id, actorId: req.staffUser!.id,
    metadata: { lockedThrough: latest.lockedThrough, originalLockedBy: latest.lockedBy, note: latest.note, reason },
  })
  return { reopenedThrough: latest.lockedThrough, lockedThrough: now?.lockedThrough ?? null, lockId: latest.id }
}

/** What a request asks to open, in words. */
export function periodLabelOf(r: { lockedThrough: Date; reopenFrom: Date | null }): string {
  return r.reopenFrom ? `${fmtPktDate(r.reopenFrom)} to ${fmtPktDate(r.lockedThrough)}` : `the latest close (through ${fmtPktDate(r.lockedThrough)})`
}
export { fromDate as reopenFromDate }

export async function periodReopenRoutes(fastify: FastifyInstance) {
  const financeGate = [requireAuth('finance', 'admin'), requireModule('accounting')]

  // POST /reopen-requests {reason} — finance asks for the ACTIVE company's latest close to be reopened.
  fastify.post('/reopen-requests', { preHandler: financeGate }, async (req, reply) => {
    const { reason, from: fromInput } = z.object({ reason: REASON, from: FROM }).parse(req.body ?? {})
    const from = fromDate(fromInput)
    const su = req.staffUser!
    const tenantId = su.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company — books are closed per company', 422)
    if (su.role === 'admin') throw new AppError('CEO_REOPENS_DIRECTLY', 'You are the CEO — reopen the period directly on this page.', 422)
    const row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext('period-reopen'))`
      const latest = await tx.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
      if (!latest) throw new AppError('NOTHING_TO_REOPEN', 'This company has no closed period', 422)
      const open = await tx.periodReopenRequest.findFirst({ where: { tenantId, status: 'pending' }, select: { id: true } })
      if (open) throw new AppError('REOPEN_PENDING', 'A request to reopen this company\'s books is already waiting for the CEO.', 409)
      if (from && from > latest.lockedThrough) throw notClosed(from, latest.lockedThrough)
      return tx.periodReopenRequest.create({ data: { tenantId, lockedThrough: latest.lockedThrough, reopenFrom: from ?? null, reason, requestedById: su.id } })
    })
    await audit({
      category: 'accounting', action: 'period.reopen_request', entity: 'PeriodReopenRequest', entityId: row.id, tenantId,
      userId: su.id, userEmail: su.email ?? null, metadata: { lockedThrough: row.lockedThrough, reopenFrom: row.reopenFrom, reason, actorRole: su.role },
    })
    approvalWaiting('period_reopen', row.id, { round: row.createdAt.toISOString(), actorId: su.id })
    return reply.status(202).send({ pendingApproval: true, request: row })
  })

  // GET /reopen-requests?status= — the requests of the companies in view.
  fastify.get<{ Querystring: { status?: string } }>('/reopen-requests', { preHandler: financeGate }, async (req) => {
    const status = (STATUSES as readonly string[]).includes(req.query.status ?? '') ? req.query.status : undefined
    const rows = await prisma.periodReopenRequest.findMany({
      where: { ...(await scopeTenantWhere(req, 'read')), ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' }, take: 100,
    })
    const [users, tenants, locks] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
      prisma.tenant.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } }, select: { id: true, name: true } }),
      prisma.periodLock.findMany({ where: { tenantId: { in: [...new Set(rows.map((r) => r.tenantId))] } }, orderBy: { lockedThrough: 'desc' }, select: { tenantId: true, lockedThrough: true } }),
    ])
    const u = new Map<string, string | null>(users.map((x) => [x.id, x.name]))
    const t = new Map<string, string | null>(tenants.map((x) => [x.id, x.name]))
    const latestOf = new Map<string, Date>()
    for (const l of locks) if (l.tenantId && !latestOf.has(l.tenantId)) latestOf.set(l.tenantId, l.lockedThrough)
    return {
      items: rows.map((r) => {
        const latest = latestOf.get(r.tenantId) ?? null
        const changed = r.status === 'pending' && (!latest || latest.getTime() !== r.lockedThrough.getTime())
        return {
          ...r, lockedThroughLabel: fmtPktDate(r.lockedThrough),
          reopenFromLabel: r.reopenFrom ? fmtPktDate(r.reopenFrom) : null,
          periodLabel: periodLabelOf(r),
          companyName: t.get(r.tenantId) ?? null,
          requestedByName: u.get(r.requestedById) ?? null,
          decidedByName: r.decidedById ? u.get(r.decidedById) ?? null : null,
          blockedBy: changed ? (latest ? `the books are now closed through ${fmtPktDate(latest)}` : 'the books are no longer closed') : null,
          canWithdraw: r.status === 'pending' && (req.staffUser!.role === 'admin' || r.requestedById === req.staffUser!.id),
        }
      }),
    }
  })

  async function forDecision(req: FastifyRequest, id: string) {
    const r = await prisma.periodReopenRequest.findFirst({ where: { id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!r) throw new NotFoundError('Reopen request', id)
    return r
  }
  async function grantFor(req: FastifyRequest, id: string) {
    const s = await approvalSubject('period_reopen', id)
    if (!s) throw new NotFoundError('Reopen request', id)
    return assertCanApprove(req, approvalInputOf('period_reopen', id, s))
  }

  // POST /reopen-requests/:id/approve — the CEO reopens the close that was asked for.
  fastify.post<{ Params: { id: string } }>('/reopen-requests/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    if (r.status !== 'pending') throw notPending()
    const decidedAt = new Date()
    const out = await reopenLatestClose(req, r.tenantId, r.reason, {
      expect: r.lockedThrough, from: r.reopenFrom, forFinanceRequestId: r.id,
      claim: async (tx) => {
        const claimed = await tx.periodReopenRequest.updateMany({
          where: { id: r.id, status: 'pending' },
          data: { status: 'approved', decidedById: req.staffUser!.id, decidedAt, decisionNote: body.note ?? null },
        })
        if (claimed.count === 0) throw notPending()
      },
    })
    await auditApproval(req, {
      type: 'period_reopen', id: r.id, tenantId: r.tenantId, decision: 'approve', grant, entity: 'PeriodReopenRequest',
      metadata: { lockedThrough: r.lockedThrough, note: body.note ?? null, decidedAt, requestedBy: r.requestedById },
    })
    return { id: r.id, approved: true, reopenedThrough: out.reopenedThrough, lockedThrough: out.lockedThrough }
  })

  // POST /reopen-requests/:id/reject {note ≥10} — the CEO turns it down; the books stay closed.
  fastify.post<{ Params: { id: string } }>('/reopen-requests/:id/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: REASON }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    const decidedAt = new Date()
    const claimed = await prisma.periodReopenRequest.updateMany({
      where: { id: r.id, status: 'pending' },
      data: { status: 'rejected', decidedById: req.staffUser!.id, decidedAt, decisionNote: body.note },
    })
    if (claimed.count === 0) throw notPending()
    await auditApproval(req, {
      type: 'period_reopen', id: r.id, tenantId: r.tenantId, decision: 'reject', grant, entity: 'PeriodReopenRequest',
      metadata: { lockedThrough: r.lockedThrough, note: body.note, decidedAt, requestedBy: r.requestedById },
    })
    return { id: r.id, rejected: true }
  })

  // POST /reopen-requests/:id/withdraw — the requester (or the CEO) takes it back.
  fastify.post<{ Params: { id: string } }>('/reopen-requests/:id/withdraw', { preHandler: financeGate }, async (req) => {
    const r = await forDecision(req, req.params.id)
    if (req.staffUser!.role !== 'admin' && r.requestedById !== req.staffUser!.id) throw new ForbiddenError('Only the person who asked (or the CEO) may withdraw it.')
    const claimed = await prisma.periodReopenRequest.updateMany({
      where: { id: r.id, status: 'pending' },
      data: { status: 'withdrawn', decidedById: req.staffUser!.id, decidedAt: new Date() },
    })
    if (claimed.count === 0) throw notPending()
    await audit({
      category: 'accounting', action: 'period.reopen_request.withdraw', entity: 'PeriodReopenRequest', entityId: r.id, tenantId: r.tenantId,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, metadata: { requestedBy: r.requestedById },
    })
    return { id: r.id, withdrawn: true }
  })
}
