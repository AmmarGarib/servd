import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { requireAuth, requireCustomerAuth, ALL_STAFF, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { customerOfCompanies } from '../crm/customerScope.js'
import { customerScope } from '../../lib/outboundScope.js'
import { sendEmail, sendPhoneMessage } from '../../lib/notify.js'
import { audit } from '../../lib/audit.js'
import { readBanAppealsSetting, writeBanAppealsSetting } from './appeals.js'

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
 * are servd-wide (owner, 2026-10-15): every active strike on the account.
 */
async function appealDetails(rows: Array<{ id: string; kind: string; banId: string | null }>) {
  const banIds = [...new Set(rows.filter((r) => r.kind === 'ban_appeal' && r.banId).map((r) => r.banId!))]
  if (banIds.length === 0) return new Map<string, unknown>()
  const now = new Date()
  const bans = await prisma.customerBan.findMany({
    where: { id: { in: banIds } },
    select: {
      id: true, reason: true, bannedAt: true, bannedById: true, liftedAt: true, expiresAt: true, customerId: true,
      customer: { select: { id: true, name: true, phone: true, email: true } },
    },
  })
  const customerIds = [...new Set(bans.map((b) => b.customerId).filter((x): x is string => !!x))]
  const strikes = customerIds.length === 0 ? [] : await prisma.customerStrike.findMany({
    where: { customerId: { in: customerIds }, ...activeStrikeWhere(now) },
    select: { customerId: true, kind: true, recordedAt: true, reason: true, severity: true },
    orderBy: { recordedAt: 'desc' },
  })
  const out = new Map<string, unknown>()
  for (const b of bans) {
    out.set(b.id, {
      ban: {
        id: b.id, reason: b.reason, bannedAt: b.bannedAt, auto: b.bannedById === null,
        active: !b.liftedAt && (!b.expiresAt || b.expiresAt > now),
        customer: b.customer,
      },
      strikes: strikes.filter((s) => s.customerId === b.customerId)
        .map((s) => ({ kind: s.kind, at: s.recordedAt, reason: s.reason, severity: s.severity })),
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
      ...(kind && { kind }),
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
    const details = isManager ? await appealDetails(complaints) : new Map<string, unknown>()
    const rows = complaints.map((c) => {
      if (c.kind !== 'ban_appeal') return c
      // Non-managers never see the block or the strikes, nor the contact on it.
      if (!isManager) return { ...c, contactPhone: null }
      return { ...c, ...(c.banId ? (details.get(c.banId) as object | undefined) ?? {} : {}) }
    })

    return { complaints: rows, stats: { total, open, resolved, inProgress: total - open - resolved } }
  })

  // GET /complaints/stats — quick summary for dashboard badge
  fastify.get('/stats', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const tenantWhere: Prisma.OrderComplaintWhereInput = { AND: [await complaintScopeWhere(req, 'read')] }
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
          ban: { select: { id: true, phone: true, email: true, customer: { select: { phone: true, email: true } } } },
        },
      })
      if (!complaint) throw new NotFoundError('Complaint', req.params.id)

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
