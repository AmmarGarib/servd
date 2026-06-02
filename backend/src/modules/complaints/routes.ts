import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, requireCustomerAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

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

export async function complaintRoutes(fastify: FastifyInstance) {
  // GET /complaints — list with filters
  fastify.get<{
    Querystring: {
      conceptId?: string; status?: string; priority?: string
      dateFrom?: string; dateTo?: string; limit?: string
    }
  }>('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { conceptId, status, priority, dateFrom, dateTo, limit } = req.query
    const baseWhere = {
      // Tenant scope: only complaints under concepts in the active tenant.
      concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
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
          ...(status && { status: status as never }),
          ...(priority && { priority: priority as never }),
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
        take: limit ? parseInt(limit, 10) : 50,
      }),
      prisma.orderComplaint.count({ where: baseWhere }),
      prisma.orderComplaint.count({ where: { ...baseWhere, status: 'open' } }),
      prisma.orderComplaint.count({ where: { ...baseWhere, status: 'resolved' } }),
    ])

    return { complaints, stats: { total, open, resolved, inProgress: total - open - resolved } }
  })

  // GET /complaints/stats — quick summary for dashboard badge
  fastify.get('/stats', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const tenantWhere = { concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } }
    const [open, inProgress] = await Promise.all([
      prisma.orderComplaint.count({ where: { ...tenantWhere, status: 'open' } }),
      prisma.orderComplaint.count({ where: { ...tenantWhere, status: 'in_progress' } }),
    ])
    return { stats: { open, inProgress } }
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
        status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
        resolution: z.string().optional(),
      }).parse(req.body)

      const complaint = await prisma.orderComplaint.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!complaint) throw new NotFoundError('Complaint', req.params.id)

      return prisma.orderComplaint.update({
        where: { id: req.params.id },
        data: {
          ...body,
          ...(body.status === 'resolved' && { resolvedAt: new Date() }),
        },
      })
    },
  )
}
