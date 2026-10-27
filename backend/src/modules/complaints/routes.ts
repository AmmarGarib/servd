import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma, serviceClient } from '../../lib/prisma.js'
import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { requireAuth, requireCustomerAuth, ALL_STAFF, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { customerOfCompanies, banCompanies, strikeCompanies, inCompanies, tenantIdsOf } from '../crm/customerScope.js'
import { customerScope } from '../../lib/outboundScope.js'
import { sendEmail, sendPhoneMessage } from '../../lib/notify.js'
import { audit } from '../../lib/audit.js'
import { readBanAppealsSetting, writeBanAppealsSetting } from './appeals.js'
import { COMPENSATION_TYPES, COMPENSATION_LABEL, FLAG_ROLES, syncCompensationTickets, type CompensationType } from './compensation.js'
import { flagException } from '../../lib/exceptions.js'
import { orderRefOf } from '../../lib/orderRef.js'

const createSchema = z.object({
  orderId: z.string().uuid().optional(),
  conceptId: z.string().uuid(),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  category: z.enum(['wrong_item', 'missing_item', 'quality', 'service', 'delivery', 'other']),
  // priority is NOT accepted from the client. Anonymous submitters used to be
  // able to pin every fake complaint to the top of the staff inbox by sending
  // priority='urgent'. We force 'medium' here and let staff re-classify on
  // PATCH if needed.
})

// ─── Company scope (2026-10-15) ──────────────────────────────────────────────
//
// An ordinary complaint belongs to the company of its brand. A ban appeal is
// about the customer's servd ACCOUNT (owner, 2026-10-15: strikes and bans are
// servd-wide), so it is one queue: any company in scope that raised the ban,
// owns the appeal's brand, or has the customer in its history (an order or a
// reservation at one of its brands) sees it. An empty scope denies everything
// (scopeTenantWhere returns { tenantId: { in: [] } }).
//
// DECIDING an appeal (keep the block = close it; lift / release go through
// /crm/bans) is for a manager of the company that RAISED the block (the CEO
// through their membership of it; a legacy NULL-company block: the CEO only) —
// anyone else in the queue gets 403 APPEAL_RAISED_ELSEWHERE.
// A company that did not raise the block sees it, and the strikes of other
// companies, only as "Another servd kitchen" (no reason, no brand, no staff).

const OTHER_KITCHEN = 'Another servd kitchen'

/** True when the ban was raised by one of `scope`'s companies (legacy NULL rows attributed the old way). */
async function banRaisedIn(
  bans: Array<{ id: string; customerId: string | null; bannedById: string | null; tenantId: string | null }>,
  scope: string[],
): Promise<Map<string, boolean>> {
  const bc = await banCompanies(bans)
  return new Map(bans.map((b) => [b.id, inCompanies(bc.get(b.id), scope, true)]))
}

async function complaintScopeWhere(req: FastifyRequest, mode: ScopeMode): Promise<Prisma.OrderComplaintWhereInput> {
  const t = await scopeTenantWhere(req, mode)
  return {
    OR: [
      { concept: { ...t, deletedAt: null } },
      {
        kind: 'ban_appeal',
        ban: { OR: [{ ...t }, { customer: customerOfCompanies(t) }] },
      },
    ],
  }
}

const KIND = z.enum(['complaint', 'ban_appeal'])
const STATUS = z.enum(['open', 'in_progress', 'resolved', 'closed'])
const PRIORITY = z.enum(['low', 'medium', 'high', 'urgent'])

const activeStrikeWhere = (now: Date): Prisma.CustomerStrikeWhereInput => ({
  reversedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
})

/**
 * Ban details for appeal rows — MANAGERS only (a marketing or brand login with
 * the Complaints module sees the appeal, not the block or the strikes). Strikes
 * are servd-wide (owner, 2026-10-15): every active strike on the account, but
 * one another company recorded keeps only its kind, weight and date
 * ("Another servd kitchen"); a block raised elsewhere shows no reason.
 * `canDecide` = this caller may decide the appeal (its company raised the block;
 * a legacy NULL-company block: the CEO only).
 */
async function appealDetails(rows: Array<{ id: string; kind: string; banId: string | null }>, scope: string[], isAdmin: boolean) {
  const banIds = [...new Set(rows.filter((r) => r.kind === 'ban_appeal' && r.banId).map((r) => r.banId!))]
  if (banIds.length === 0) return new Map<string, { raisedHere: boolean; details: unknown }>()
  const now = new Date()
  const bans = await prisma.customerBan.findMany({
    where: { id: { in: banIds } },
    select: {
      id: true, reason: true, bannedAt: true, bannedById: true, liftedAt: true, expiresAt: true, customerId: true, tenantId: true,
      customer: { select: { id: true, name: true, phone: true, email: true } },
    },
  })
  const customerIds = [...new Set(bans.map((b) => b.customerId).filter((x): x is string => !!x))]
  const strikes = customerIds.length === 0 ? [] : await prisma.customerStrike.findMany({
    where: { customerId: { in: customerIds }, ...activeStrikeWhere(now) },
    select: { id: true, customerId: true, kind: true, recordedAt: true, reason: true, severity: true, sourceType: true, sourceId: true, recordedById: true, tenantId: true },
    orderBy: { recordedAt: 'desc' },
  })
  const [raised, sc] = await Promise.all([banRaisedIn(bans, scope), strikeCompanies(strikes)])
  const out = new Map<string, { raisedHere: boolean; details: unknown }>()
  for (const b of bans) {
    const here = raised.get(b.id) ?? false
    out.set(b.id, {
      raisedHere: here,
      details: {
        ban: {
          id: b.id, reason: here ? b.reason : `Blocked by ${OTHER_KITCHEN.toLowerCase()}`, bannedAt: b.bannedAt, auto: b.bannedById === null,
          active: !b.liftedAt && (!b.expiresAt || b.expiresAt > now),
          customer: b.customer,
          raisedHere: here,
          otherKitchen: !here,
          canDecide: here && (!!b.tenantId || isAdmin),
        },
        strikes: strikes.filter((st) => st.customerId === b.customerId).map((st) => {
          const mine = inCompanies(sc.get(st.id), scope, true)
          return mine
            ? { kind: st.kind, at: st.recordedAt, reason: st.reason, severity: st.severity, otherKitchen: false, where: null }
            : { kind: st.kind, at: st.recordedAt, reason: null, severity: st.severity, otherKitchen: true, where: OTHER_KITCHEN }
        }),
      },
    })
  }
  return out
}

export async function complaintRoutes(fastify: FastifyInstance) {
  // GET /complaints — list with filters
  fastify.get<{
    Querystring: {
      conceptId?: string; status?: string; priority?: string
      dateFrom?: string; dateTo?: string; limit?: string; kind?: string
    }
  }>('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { conceptId, dateFrom, dateTo, limit } = req.query
    const status = req.query.status ? STATUS.parse(req.query.status) : undefined
    const priority = req.query.priority ? PRIORITY.parse(req.query.priority) : undefined
    const kind = req.query.kind ? KIND.parse(req.query.kind) : undefined
    const take = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200)
    const baseWhere: Prisma.OrderComplaintWhereInput = {
      // Company scope (read): see complaintScopeWhere.
      AND: [await complaintScopeWhere(req, 'read')],
      // Compensation tickets have their own list (GET /complaints/compensation).
      kind: kind ?? { in: ['complaint', 'ban_appeal'] },
      ...(conceptId && { conceptId }),
      ...(dateFrom || dateTo ? {
        createdAt: {
          ...(dateFrom && { gte: new Date(dateFrom) }),
          ...(dateTo && { lte: new Date(dateTo) }),
        },
      } : {}),
    }

    const [complaints, total, open, resolved] = await Promise.all([
      prisma.orderComplaint.findMany({
        where: {
          ...baseWhere,
          ...(status && { status }),
          ...(priority && { priority }),
        },
        include: {
          // Concept relation also pulls the tenant so the frontend can render
          // the indigo brand chip on each complaint row in portfolio view.
          concept: {
            select: {
              name: true, slug: true, tenantId: true,
              tenant: { select: { id: true, name: true, slug: true } },
            },
          },
          // Pull customer ids/contact through the order — the "Reach out" CTA
          // on the complaint card needs these to spawn a CustomerConversation
          // without an extra round-trip lookup.
          order: {
            select: {
              id: true, source: true, placedAt: true, customerName: true,
              customer: { select: { id: true, name: true, email: true, phone: true } },
            },
          },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        take,
      }),
      prisma.orderComplaint.count({ where: baseWhere }),
      prisma.orderComplaint.count({ where: { ...baseWhere, status: 'open' } }),
      prisma.orderComplaint.count({ where: { ...baseWhere, status: 'resolved' } }),
    ])

    const isManager = MANAGERS.includes(req.staffUser!.role)
    const scope = tenantIdsOf(await scopeTenantWhere(req, 'read'))
    const details = await appealDetails(complaints, scope, req.staffUser!.role === 'admin')
    const rows = complaints.map((c) => {
      if (c.kind !== 'ban_appeal') return c
      const d = c.banId ? details.get(c.banId) : undefined
      // A block another company raised: its brand is not shown either.
      const anon = !d?.raisedHere
      const base = anon ? { ...c, concept: { name: OTHER_KITCHEN, slug: null, tenantId: null, tenant: null } } : c
      // Non-managers never see the block or the strikes, nor the contact on it.
      if (!isManager) return { ...base, contactPhone: null }
      return { ...base, ...((d?.details as object | undefined) ?? {}) }
    })

    return { complaints: rows, stats: { total, open, resolved, inProgress: total - open - resolved } }
  })

  // ─── Compensation tickets (owner, 2026-10-27; complaints/compensation.ts) ───
  //
  // GET /complaints/compensation — managers (and the CEO) of the companies in
  // view; scoped by the ticket's brand (the order's). Filters: type, status,
  // flagged (1 | 0), dateFrom / dateTo, conceptId; cursor-paged by id.
  fastify.get<{
    Querystring: { type?: string; status?: string; flagged?: string; dateFrom?: string; dateTo?: string; conceptId?: string; limit?: string; cursor?: string }
  }>('/compensation', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const q = z.object({
      type: z.enum(COMPENSATION_TYPES).optional(),
      status: STATUS.optional(),
      flagged: z.enum(['1', '0', 'true', 'false']).optional(),
      dateFrom: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
      dateTo: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
      conceptId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cursor: z.string().uuid().optional(),
    }).parse(req.query)
    const t = await scopeTenantWhere(req, 'read')
    const scope = tenantIdsOf(t)
    // Bring the caller's companies up to date first (the worker does the rest).
    if (scope.length > 0) await syncCompensationTickets(scope, { throttleMs: 15_000 })
    const flagged = q.flagged === '1' || q.flagged === 'true' ? true : q.flagged ? false : undefined
    // A bare date is the Karachi day: from 00:00 PKT / to 23:59:59.999 PKT.
    const from = q.dateFrom ? new Date(q.dateFrom.length === 10 ? `${q.dateFrom}T00:00:00+05:00` : q.dateFrom) : undefined
    const to = q.dateTo ? new Date(q.dateTo.length === 10 ? `${q.dateTo}T23:59:59.999+05:00` : q.dateTo) : undefined
    const where: Prisma.OrderComplaintWhereInput = {
      kind: 'compensation',
      concept: { ...t },
      ...(q.type && { compType: q.type }),
      ...(q.status && { status: q.status }),
      ...(flagged === true && { compFlaggedAt: { not: null } }),
      ...(flagged === false && { compFlaggedAt: null }),
      ...(q.conceptId && { conceptId: q.conceptId }),
      ...((from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
    }
    const take = q.limit ?? 50
    const [rows, totals, flaggedCount] = await Promise.all([
      prisma.orderComplaint.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
        select: {
          id: true, orderId: true, conceptId: true, status: true, description: true, createdAt: true,
          compType: true, compValueCents: true, compApproverId: true, compActorId: true,
          compFlaggedAt: true, compFlaggedById: true, compFlagNote: true,
          concept: { select: { name: true, tenantId: true } },
        },
      }),
      prisma.orderComplaint.aggregate({ where, _count: { _all: true }, _sum: { compValueCents: true } }),
      prisma.orderComplaint.count({ where: { ...where, compFlaggedAt: { not: null } } }),
    ])
    const page = rows.slice(0, take)
    const userIds = [...new Set(page.flatMap((r) => [r.compApproverId, r.compActorId, r.compFlaggedById]).filter((x): x is string => !!x))]
    const users = new Map((userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, role: true } }) : []).map((u) => [u.id, u]))
    const person = (id: string | null) => (id ? { id, name: users.get(id)?.name ?? 'Unknown login', role: users.get(id)?.role ?? null } : null)
    return {
      tickets: page.map((r) => ({
        id: r.id,
        type: r.compType as CompensationType,
        typeLabel: COMPENSATION_LABEL[r.compType as CompensationType] ?? r.compType,
        valueCents: r.compValueCents ?? 0,
        orderId: r.orderId,
        orderRef: r.orderId ? orderRefOf(r.orderId) : null,
        brand: { id: r.conceptId, name: r.concept.name },
        tenantId: r.concept.tenantId,
        reason: r.description,
        status: r.status,
        createdAt: r.createdAt,
        approver: person(r.compApproverId),
        actor: person(r.compActorId),
        flagged: r.compFlaggedAt ? { at: r.compFlaggedAt, by: person(r.compFlaggedById), note: r.compFlagNote } : null,
      })),
      nextCursor: rows.length > take ? page[page.length - 1]!.id : null,
      stats: { total: totals._count._all, valueCents: totals._sum.compValueCents ?? 0, flagged: flaggedCount },
      canFlag: (FLAG_ROLES as readonly string[]).includes(req.staffUser!.role),
    }
  })

  // POST /complaints/:id/flag { note ≥10 } — the CEO only (FLAG_ROLES). Raises
  // an ExceptionFlag 'compensation_flagged' in the ticket's company naming the
  // approving manager (actorId = that manager; the bell tells the CEO(s)).
  fastify.post<{ Params: { id: string } }>('/:id/flag', { preHandler: requireAuth(...(FLAG_ROLES as unknown as typeof ADMIN_ONLY)) }, async (req) => {
    const { note } = z.object({ note: z.string().trim().min(10).max(1000) }).parse(req.body)
    const t = await scopeTenantWhere(req, 'write')
    const ticket = await prisma.orderComplaint.findFirst({
      where: { id: req.params.id, kind: 'compensation', concept: { ...t } },
      select: {
        id: true, orderId: true, conceptId: true, description: true, compType: true, compValueCents: true,
        compApproverId: true, compActorId: true, compFlaggedAt: true, concept: { select: { tenantId: true, name: true } },
      },
    })
    if (!ticket) throw new NotFoundError('Compensation ticket', req.params.id)
    if (ticket.compFlaggedAt) throw new AppError('ALREADY_FLAGGED', 'This ticket is already flagged.', 409)
    const now = new Date()
    const claimed = await prisma.orderComplaint.updateMany({
      where: { id: ticket.id, compFlaggedAt: null },
      data: { compFlaggedAt: now, compFlaggedById: req.staffUser!.id, compFlagNote: note },
    })
    if (claimed.count === 0) throw new AppError('ALREADY_FLAGGED', 'This ticket is already flagged.', 409)
    const manager = ticket.compApproverId ?? ticket.compActorId
    const managerName = manager ? (await prisma.user.findUnique({ where: { id: manager }, select: { name: true } }))?.name ?? 'Unknown login' : 'a manager PIN (not recorded)'
    const label = COMPENSATION_LABEL[ticket.compType as CompensationType] ?? ticket.compType
    const ref = ticket.orderId ? orderRefOf(ticket.orderId) : '—'
    const flag = await flagException({
      tenantId: ticket.concept.tenantId,
      kind: 'compensation_flagged',
      severity: 'medium',
      title: `${label} on order #${ref} flagged — approved by ${managerName}`,
      description: `The CEO flagged a ${label.toLowerCase()} of PKR ${((ticket.compValueCents ?? 0) / 100).toFixed(0)} at ${ticket.concept.name} (order #${ref}), approved by ${managerName}. Note: ${note}. Reason given at the till: ${ticket.description}`.slice(0, 2000),
      entityType: 'OrderComplaint',
      entityId: ticket.id,
      conceptId: ticket.conceptId,
      actorId: manager,
      amountCents: ticket.compValueCents ?? 0,
      metadata: { ticketId: ticket.id, orderId: ticket.orderId, type: ticket.compType, approverId: ticket.compApproverId, actorId: ticket.compActorId, flaggedById: req.staffUser!.id, note },
    })
    if (flag) await prisma.orderComplaint.update({ where: { id: ticket.id }, data: { compFlagExceptionId: flag.id } })
    await audit({
      category: 'identity', action: 'compensation.flag', entity: 'OrderComplaint', entityId: ticket.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: ticket.concept.tenantId,
      metadata: { note, exceptionFlagId: flag?.id ?? null, approverId: ticket.compApproverId, type: ticket.compType, valueCents: ticket.compValueCents },
    })
    return { ok: true, flaggedAt: now, exceptionFlagId: flag?.id ?? null }
  })

  // POST /complaints/:id/unflag { note? } — the CEO only. Clears the mark and
  // resolves the exception flag it raised.
  fastify.post<{ Params: { id: string } }>('/:id/unflag', { preHandler: requireAuth(...(FLAG_ROLES as unknown as typeof ADMIN_ONLY)) }, async (req) => {
    const { note } = z.object({ note: z.string().trim().max(1000).optional() }).parse(req.body ?? {})
    const t = await scopeTenantWhere(req, 'write')
    const ticket = await prisma.orderComplaint.findFirst({
      where: { id: req.params.id, kind: 'compensation', concept: { ...t } },
      select: { id: true, compFlaggedAt: true, compFlagExceptionId: true, compFlagNote: true, concept: { select: { tenantId: true } } },
    })
    if (!ticket) throw new NotFoundError('Compensation ticket', req.params.id)
    if (!ticket.compFlaggedAt) throw new AppError('NOT_FLAGGED', 'This ticket is not flagged.', 409)
    const cleared = await prisma.orderComplaint.updateMany({
      where: { id: ticket.id, compFlaggedAt: { not: null } },
      data: { compFlaggedAt: null, compFlaggedById: null, compFlagNote: null, compFlagExceptionId: null },
    })
    if (cleared.count === 0) throw new AppError('NOT_FLAGGED', 'This ticket is not flagged.', 409)
    if (ticket.compFlagExceptionId) {
      await serviceClient.exceptionFlag.updateMany({
        where: { id: ticket.compFlagExceptionId, status: { in: ['open', 'acknowledged'] } },
        data: { status: 'resolved', resolvedById: req.staffUser!.id, resolvedAt: new Date(), resolution: note?.trim() || 'Unflagged by the CEO' },
      })
    }
    await audit({
      category: 'identity', action: 'compensation.unflag', entity: 'OrderComplaint', entityId: ticket.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: ticket.concept.tenantId,
      metadata: { note: note ?? null, previousNote: ticket.compFlagNote, exceptionFlagId: ticket.compFlagExceptionId },
    })
    return { ok: true }
  })

  // GET /complaints/stats — quick summary for dashboard badge
  fastify.get('/stats', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const tenantWhere: Prisma.OrderComplaintWhereInput = { AND: [await complaintScopeWhere(req, 'read')], kind: { in: ['complaint', 'ban_appeal'] } }
    const [open, inProgress] = await Promise.all([
      prisma.orderComplaint.count({ where: { ...tenantWhere, status: 'open' } }),
      prisma.orderComplaint.count({ where: { ...tenantWhere, status: 'in_progress' } }),
    ])
    return { stats: { open, inProgress } }
  })

  // GET /complaints/settings/appeals — the customer-facing appeals switch
  // (platform-wide: blocks are servd-wide). CEO only.
  fastify.get('/settings/appeals', { preHandler: requireAuth(...ADMIN_ONLY) }, async () => {
    return readBanAppealsSetting()
  })

  // PUT /complaints/settings/appeals { enabled, reason } — CEO only, audited.
  // Off (the default): storefront appeal routes 404, WhatsApp keeps today's
  // BANNED reply. Staff screens work either way.
  fastify.put('/settings/appeals', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({
      enabled: z.boolean(),
      reason: z.string().trim().min(5).max(300),
    }).parse(req.body)
    const before = await readBanAppealsSetting()
    const after = await writeBanAppealsSetting({ enabled: body.enabled, reason: body.reason, actorId: req.staffUser!.id })
    await audit({
      category: 'identity', action: body.enabled ? 'ban_appeals.enable' : 'ban_appeals.disable',
      entity: 'Setting', entityId: 'crm.banAppealsEnabled',
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: req.staffUser!.tenantId ?? null,
      before: { enabled: before.enabled }, after: { enabled: after.enabled }, metadata: { reason: body.reason },
    })
    return after
  })

  // POST /complaints — create (authenticated customers only).
  //
  // Originally accepted unauthenticated submissions with a client-supplied
  // `priority='urgent'` field, which spam attackers used to pin fake red-
  // priority rows to the top of the staff inbox. Now: customer auth required,
  // priority is server-controlled, and the complaint must reference a real
  // order owned by the caller so a single account can't open complaints
  // against arbitrary concepts.
  fastify.post('/', {
    preHandler: requireCustomerAuth,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = createSchema.parse(req.body)

    // If the complaint references an Order, prove the caller owns it (and
    // pull conceptId from the order so the body's conceptId can't be used
    // to file complaints against a brand the customer never visited).
    let conceptId = body.conceptId
    let customerId: string | null = req.customer!.id
    if (body.orderId) {
      const order = await prisma.order.findFirst({
        where: { id: body.orderId, customerId: req.customer!.id },
        select: { id: true, conceptId: true, customerId: true },
      })
      if (!order) {
        throw new AppError('ORDER_NOT_FOUND', 'No order with that id on your account', 404)
      }
      conceptId = order.conceptId
      customerId = order.customerId ?? req.customer!.id
    }

    const complaint = await prisma.orderComplaint.create({
      data: {
        orderId:       body.orderId,
        conceptId,
        customerId,
        title:         body.title,
        description:   body.description,
        category:      body.category,
        // Server-controlled — never client. Staff can re-prioritise on PATCH.
        priority:      'medium',
      },
    })

    // Cross-module: refresh the customer's rollups so the host stand sees
    // the complaint reflected on their next reservation render.
    if (complaint.customerId) {
      const { bumpCustomerRollups } = await import('../../lib/customerRollups.js')
      bumpCustomerRollups(complaint.customerId)
    }
    return reply.status(201).send(complaint)
  })

  // PATCH /complaints/:id — update status/resolution
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        status: STATUS.optional(),
        priority: PRIORITY.optional(),
        resolution: z.string().max(4000).optional(),
      }).parse(req.body)

      const complaint = await prisma.orderComplaint.findFirst({
        where: { id: req.params.id, AND: [await complaintScopeWhere(req, 'write')] },
        include: {
          concept: { select: { tenantId: true } },
          ban: { select: { id: true, phone: true, email: true, tenantId: true, customerId: true, bannedById: true, customer: { select: { phone: true, email: true } } } },
        },
      })
      if (!complaint) throw new NotFoundError('Complaint', req.params.id)
      if (complaint.kind === 'compensation') {
        throw new AppError('COMPENSATION_TICKET_READ_ONLY', 'A compensation ticket records what happened at the till — it is not edited. The CEO may flag it.', 409)
      }

      // A ban appeal is decided by the company that raised the block (a legacy
      // NULL-company block: the CEO only, as liftBanTx).
      if (complaint.kind === 'ban_appeal') {
        const scope = tenantIdsOf(await scopeTenantWhere(req, 'write'))
        const here = complaint.ban ? (await banRaisedIn([complaint.ban], scope)).get(complaint.ban.id) : false
        if (!here || (!complaint.ban?.tenantId && req.staffUser!.role !== 'admin')) {
          throw new AppError('APPEAL_RAISED_ELSEWHERE', 'This block was raised by another servd kitchen — only that kitchen or the CEO can decide the appeal.', 403)
        }
      }

      if (complaint.kind !== 'ban_appeal') {
        return prisma.orderComplaint.update({
          where: { id: complaint.id },
          data: {
            ...body,
            ...(body.status === 'resolved' && { resolvedAt: new Date() }),
          },
        })
      }

      // ── A ban appeal ──
      // Granting it is lifting the block (or releasing one contact) through
      // /crm/bans — those resolve the appeal. 'closed' = the block stays.
      if (body.status === 'resolved') {
        throw new AppError('APPEAL_DECIDED_BY_LIFT', 'An appeal is granted by lifting the block (or releasing the number). Use "Lift the block" or "Release this number only"; "Keep the block" closes it.', 409)
      }
      const decided = complaint.status === 'resolved' || complaint.status === 'closed'
      if (decided && body.status && body.status !== complaint.status) {
        throw new AppError('APPEAL_ALREADY_DECIDED', 'This appeal has been decided. The customer can send a new one.', 409)
      }
      const closing = body.status === 'closed' && complaint.status !== 'closed'
      const resolution = body.resolution?.trim() || (closing ? 'Block kept after review' : undefined)
      // Conditional on the status we read: a lift (/crm/bans/:id/lift →
      // resolveOpenAppealsTx) or another reviewer may have decided the appeal
      // since the read. Then nothing is written, no audit and no notice — the
      // customer is never told "the block stays" for a block just lifted, and
      // two concurrent declines send one notice.
      let hit
      try {
        hit = await prisma.orderComplaint.updateMany({
          where: { id: complaint.id, status: complaint.status },
          data: {
            ...(body.status && { status: body.status }),
            ...(body.priority && { priority: body.priority }),
            ...(resolution !== undefined && { resolution }),
            ...(closing && { resolvedAt: new Date() }),
          },
        })
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          throw new AppError('APPEAL_OPEN', 'Another appeal on this block is already open.', 409)
        }
        throw err
      }
      if (hit.count === 0) {
        throw new AppError('APPEAL_ALREADY_DECIDED', 'This appeal has been decided. The customer can send a new one.', 409)
      }
      const updated = await prisma.orderComplaint.findUniqueOrThrow({ where: { id: complaint.id } })

      if (closing) {
        await audit({
          category: 'identity', action: 'ban_appeal.decline', entity: 'OrderComplaint', entityId: complaint.id,
          userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: req.staffUser!.tenantId ?? null,
          metadata: { banId: complaint.banId, resolution },
        })
        // Tell the customer (after commit; best effort). The appeal's brand's
        // company is the send scope — a test company never messages a customer.
        const scope = customerScope(complaint.concept.tenantId)
        const phone = complaint.contactPhone ?? complaint.ban?.customer?.phone ?? complaint.ban?.phone ?? null
        const email = complaint.ban?.customer?.email ?? complaint.ban?.email ?? null
        const text = 'We reviewed your request and the block on your servd account stays in place.'
        const send = async () => {
          if (phone) await sendPhoneMessage(phone, text, 'ban_appeal.declined', scope)
          else if (email) await sendEmail(email, 'Your servd account review', `<p>${text}</p>`, 'ban_appeal.declined', scope)
        }
        send().catch((err) => console.error(`[complaints] appeal decline notice failed for ${complaint.id}:`, (err as Error).message))
      }
      return updated
    },
  )
}
