// Rider roster: CRUD, history and ratings. Assigning, unassigning, marking
// delivered and setting a rider's availability are /dispatch (the one set of
// rules, dispatch/service.ts) — this module used to carry its own
// /riders/assign, /riders/unassign and two status PATCHes that disagreed
// with it.
//
// Tenant model: every Rider carries a tenantId (added in migration
// 20260602100000_rider_tenant_id) so a manager in tenant A cannot enumerate,
// mutate, rate, or unassign tenant B's riders. Every query in this module is
// scoped through `scopeTenantWhere` ('read' on GETs — portfolio-aware; 'write'
// on mutations — every company the operator belongs to). Creates bind to the
// ACTIVE company only, and an order may only be handed to a rider of the
// order's own company — or of a company with an active fleet agreement to
// deliver for it (docs/rider-app.md; the agreements are managed here too:
// GET/PUT /riders/fleet/agreements).
//
// Rider.phone is the rider-app sign-in identity (a WhatsApp code to it), so it
// is stored normalised (auth/otp.ts normalisePhone, 92… digits) and is unique
// across companies — one person, one login.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { normalisePhone } from '../auth/otp.js'
import { revokeAllForSubject } from '../../lib/tokenRevocation.js'
import { audit } from '../../lib/audit.js'
import { withdrawOffer } from '../dispatch/service.js'

const riderSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(7).max(20).transform((v, ctx) => {
    const n = normalisePhone(v)
    if (n.length < 11) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Phone number looks too short' })
      return z.NEVER
    }
    return n
  }),
  vehicleType: z.enum(['bike', 'car', 'bicycle', 'foot']).default('bike'),
  notes: z.string().optional(),
})

/** Turn the unique-phone violation into a clear 409. */
function phoneTaken(err: unknown): never {
  if ((err as { code?: string }).code === 'P2002') {
    throw new AppError('PHONE_TAKEN', 'Another rider already uses this phone number', 409)
  }
  throw err
}

// Helper: assert a Rider exists in the caller's company scope, or throw 404.
// Goes through scopeTenantWhere rather than the raw tenantFilter so a staff
// user with no company resolves to an empty `in: []` rather than
// `tenantId: null` (which would match legacy company-less rows).
async function loadRiderInScope(req: FastifyRequest, riderId: string, mode: ScopeMode) {
  const rider = await prisma.rider.findFirst({
    where: { id: riderId, deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
  })
  if (!rider) throw new NotFoundError('Rider', riderId)
  return rider
}

// ─── Fleet agreements ────────────────────────────────────────────────────────
//
// The one deliberate crossing of company separation (owner, 2026-10-10): a
// provider company's riders may carry a client company's orders while an
// active agreement exists (lib/fleet.ts holds the rule). An agreement touches
// TWO companies, so it is read and written with the operator's membership as
// the explicit filter — every company they belong to (User.tenantId plus
// TenantMember rows, the same set as the 'write' scope) — rather than the
// single-company RLS view of a GET.

type AgreementRow = {
  id: string; providerTenantId: string; clientTenantId: string; isActive: boolean; updatedAt: Date
  provider: { name: string }; client: { name: string }
}

function agreementShape(a: AgreementRow) {
  return {
    id: a.id,
    providerTenantId: a.providerTenantId,
    providerName: a.provider.name,
    clientTenantId: a.clientTenantId,
    clientName: a.client.name,
    isActive: a.isActive,
    updatedAt: a.updatedAt,
  }
}

const AGREEMENT_INCLUDE = { provider: { select: { name: true } }, client: { select: { name: true } } } as const

/** What a rider's delivery history shows (GET /riders/:id/history). */
const HISTORY_SELECT = {
  id: true, status: true, source: true, fulfilmentType: true, customerName: true, totalCents: true,
  placedAt: true, completedAt: true, deliveredAt: true, riderId: true,
  riderAssignedAt: true, riderAcceptedAt: true, pickedUpAt: true, arrivedAt: true,
  concept: { select: { name: true } },
} as const

export async function riderRoutes(fastify: FastifyInstance) {
  // GET /riders/fleet/agreements — agreements touching any company the
  // operator belongs to, and those companies (the choices in the form).
  fastify.get('/fleet/agreements', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const memberIds = req.staffUser!.memberTenantIds
    if (memberIds.length === 0) return { agreements: [], companies: [] }
    const [rows, companies] = await Promise.all([
      serviceClient.fleetAgreement.findMany({
        where: { OR: [{ providerTenantId: { in: memberIds } }, { clientTenantId: { in: memberIds } }] },
        include: AGREEMENT_INCLUDE,
        orderBy: { updatedAt: 'desc' },
      }),
      serviceClient.tenant.findMany({
        where: { id: { in: memberIds }, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ])
    return { agreements: rows.map(agreementShape), companies }
  })

  // PUT /riders/fleet/agreements — start or end "provider's fleet also
  // delivers for client". Only an operator who belongs to BOTH companies may:
  // it lets one company's riders see the other's customers' names, phones and
  // addresses for the orders they carry.
  fastify.put('/fleet/agreements', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      providerTenantId: z.string().min(1),
      clientTenantId: z.string().min(1),
      isActive: z.boolean(),
    }).parse(req.body)
    if (body.providerTenantId === body.clientTenantId) {
      throw new AppError('SAME_COMPANY', "A company's own riders already deliver its orders — pick two different companies", 422)
    }
    const member = new Set(req.staffUser!.memberTenantIds)
    if (!member.has(body.providerTenantId) || !member.has(body.clientTenantId)) {
      throw new AppError('NOT_IN_BOTH_COMPANIES', 'Only someone who belongs to both companies can start or end a fleet agreement between them', 403)
    }
    const tenants = await serviceClient.tenant.count({
      where: { id: { in: [body.providerTenantId, body.clientTenantId] }, deletedAt: null },
    })
    if (tenants !== 2) throw new NotFoundError('Company')

    const key = { providerTenantId: body.providerTenantId, clientTenantId: body.clientTenantId }
    const before = await serviceClient.fleetAgreement.findUnique({
      where: { providerTenantId_clientTenantId: key },
      select: { isActive: true },
    })
    const row = await serviceClient.fleetAgreement.upsert({
      where: { providerTenantId_clientTenantId: key },
      create: { ...key, isActive: body.isActive, createdById: req.staffUser!.id },
      update: { isActive: body.isActive },
      include: AGREEMENT_INCLUDE,
    })

    // Ending it withdraws every offer the provider's riders still hold on the
    // client's orders and have not accepted — an offer is not a delivery under
    // way (decision 3 keeps those going), and nothing else would ever take it
    // back: manual offers never time out. Run on every "inactive" PUT, not
    // just the transition, so a retry also sweeps an offer made in a race.
    let withdrawn = 0
    if (!body.isActive) {
      const offers = await serviceClient.order.findMany({
        where: {
          riderId: { not: null }, riderAcceptedAt: null, deliveredAt: null, deletedAt: null,
          concept: { tenantId: body.clientTenantId },
          rider: { tenantId: body.providerTenantId },
        },
        select: { id: true, riderId: true },
      })
      for (const o of offers) {
        if (await withdrawOffer(o.id, o.riderId!, { event: 'unassigned', note: 'fleet agreement ended' })) withdrawn += 1
      }
    }

    if (!before || before.isActive !== body.isActive || withdrawn > 0) {
      // Recorded in BOTH companies' logs — they are the two whose data is
      // shared — not the operator's active company, which may be neither.
      for (const tenantId of [body.providerTenantId, body.clientTenantId]) {
        await audit({
          category: 'identity',
          action: body.isActive ? 'fleet_agreement.start' : 'fleet_agreement.end',
          entity: 'FleetAgreement',
          entityId: row.id,
          userId: req.staffUser!.id,
          userEmail: req.staffUser!.email,
          tenantId,
          before: before ? { isActive: before.isActive } : null,
          after: { ...key, isActive: body.isActive },
          ...(withdrawn > 0 ? { metadata: { offersWithdrawn: withdrawn } } : {}),
        })
      }
    }
    return agreementShape(row)
  })

  // GET /riders — the roster: each rider row, their latest live order, their
  // company's name (head office sees several companies' fleets) and their
  // latest job event ({ type, createdAt } only — no order, no customer, never
  // the hand-over code).
  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    return prisma.rider.findMany({
      where: { deletedAt: null, ...scope },
      include: {
        tenant: { select: { name: true } },
        // The rider's own company's view of its rider: events stamped with a
        // provider company in scope (a fleet job for another company counts —
        // it is still this rider's work).
        jobEvents: {
          where: { riderTenantId: scope.tenantId },
          select: { type: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        orders: {
          where: {
            status: { in: ['confirmed', 'preparing', 'ready'] },
            concept: { deletedAt: null, ...scope },
          },
          select: { id: true, status: true, conceptId: true, placedAt: true,
            concept: { select: { name: true } }, customer: { select: { name: true } }, customerName: true },
          take: 1,
          orderBy: { placedAt: 'desc' },
        },
      },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    })
  })

  // POST /riders — a new rider belongs to the ACTIVE company (honours
  // x-servd-active-tenant). tenantFilter is the wrong source here: on a
  // non-GET it expands to every company the operator belongs to.
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = riderSchema.parse(req.body)
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before adding a rider', 422)
    const rider = await prisma.rider.create({ data: { ...body, tenantId } }).catch(phoneTaken)
    return reply.status(201).send(rider)
  })

  // PATCH /riders/:id
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = riderSchema.partial().parse(req.body)
      const rider = await loadRiderInScope(req, req.params.id, 'write')
      const updated = await prisma.rider.update({ where: { id: rider.id }, data: body }).catch(phoneTaken)
      // A new number is a new sign-in identity: whoever held the old one is out.
      if (body.phone && body.phone !== rider.phone) await revokeAllForSubject(rider.id)
      return updated
    },
  )

  // DELETE /riders/:id (soft)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const rider = await loadRiderInScope(req, req.params.id, 'write')
      await prisma.rider.update({ where: { id: rider.id }, data: { deletedAt: new Date(), isActive: false } })
      // Their rider-app session ends now, not when the token expires (the
      // rider guard re-checks the row too — this is the belt to its braces).
      await revokeAllForSubject(rider.id)
      return reply.status(204).send()
    },
  )

  // GET /riders/:id/history — delivery history for a rider
  fastify.get<{ Params: { id: string } }>(
    '/:id/history',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const rider = await loadRiderInScope(req, req.params.id, 'read')

      const orders = await prisma.order.findMany({
        where: {
          riderId: rider.id,
          status: 'completed',
          // Defence in depth: rider tenant === order tenant should always
          // hold, but enforce on the query so a mis-assigned legacy row
          // never leaks across tenants.
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
        },
        // An explicit field list, never the whole row: this route is open to
        // every staff role, and a 'completed' order can still be on the road
        // (till-paid, or expo-completed as the bag went out) with a live
        // hand-over code — which only admin / management may read.
        select: HISTORY_SELECT,
        orderBy: { completedAt: 'desc' },
        take: 50,
      })

      return { rider, orders, totalDeliveries: rider.totalDeliveries }
    },
  )

  // POST /riders/:id/rate — rate a rider after delivery
  fastify.post<{ Params: { id: string } }>(
    '/:id/rate',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({
        orderId: z.string().uuid(),
        rating: z.number().int().min(1).max(5),
        comment: z.string().max(500).optional(),
      }).parse(req.body)

      const rider = await loadRiderInScope(req, req.params.id, 'write')

      const order = await prisma.order.findFirst({
        where: {
          id: body.orderId,
          riderId: rider.id,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
      })
      if (!order) {
        return reply.status(400).send({ error: { code: 'INVALID_ORDER', message: 'Order not found or not assigned to this rider' } })
      }

      const ratingRecord = await prisma.riderRating.create({
        data: {
          riderId: rider.id,
          orderId: body.orderId,
          rating: body.rating,
          comment: body.comment,
        },
      }).catch((err: { code?: string }) => {
        if (err.code === 'P2002') {
          throw Object.assign(new Error('Order already rated'), { statusCode: 409, code: 'ALREADY_RATED' })
        }
        throw err
      })

      const agg = await prisma.riderRating.aggregate({
        where: { riderId: rider.id },
        _avg: { rating: true },
        _count: { rating: true },
      })
      await prisma.rider.update({
        where: { id: rider.id },
        data: { avgRating: agg._avg.rating ?? null },
      })

      return reply.status(201).send({
        rating: ratingRecord,
        avgRating: agg._avg.rating,
        totalRatings: agg._count.rating,
      })
    },
  )

  // GET /riders/:id/ratings — rating history for a rider (managers)
  fastify.get<{ Params: { id: string } }>(
    '/:id/ratings',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const rider = await loadRiderInScope(req, req.params.id, 'read')

      const ratings = await prisma.riderRating.findMany({
        where: { riderId: rider.id },
        include: {
          rider: { select: { name: true, avgRating: true } },
        },
        orderBy: { createdAt: 'desc' },
      })

      const orderIds = ratings.map((r) => r.orderId)
      const orders = await prisma.order.findMany({
        where: {
          id: { in: orderIds },
          // Same defence in depth as /:id/history — a legacy mis-assigned
          // rating must not surface another company's order.
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
        },
        select: { id: true, status: true, placedAt: true, completedAt: true, concept: { select: { name: true } } },
      })
      const orderMap = new Map(orders.map((o) => [o.id, o]))

      return {
        rider: { id: rider.id, name: rider.name, avgRating: rider.avgRating, totalDeliveries: rider.totalDeliveries },
        ratings: ratings.map((r) => ({ ...r, order: orderMap.get(r.orderId) ?? null })),
      }
    },
  )

  // GET /riders/available — list riders who are currently available
  fastify.get(
    '/available',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      return prisma.rider.findMany({
        where: {
          deletedAt: null,
          isActive: true,
          status: 'available',
          ...(await scopeTenantWhere(req, 'read')),
        },
        select: {
          id: true,
          name: true,
          phone: true,
          vehicleType: true,
          status: true,
          avgRating: true,
          totalDeliveries: true,
          lastLat: true,
          lastLng: true,
          lastHeading: true,
          lastReportedAt: true,
        },
        orderBy: { name: 'asc' },
      })
    },
  )
}
