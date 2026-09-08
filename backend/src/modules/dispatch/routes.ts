// Rider dispatch + live location.
//
// Riders post their current location every ~10s while on shift. We persist
// to RiderLocation history (pruned weekly) and update the Rider row with the
// latest fix. The customer-facing tracking page polls /storefront/orders/:id
// and reads the rider's lastLat/lastLng — no need for a per-customer socket.
//
// Auth + tenant model:
//   - All routes require a staff session (requireAuth ALL_STAFF).
//   - Every Rider row carries a tenantId (added in migration
//     20260602100000_rider_tenant_id). Every query in this module is scoped
//     through `scopeTenantWhere` ('read' on GETs — portfolio-aware; 'write'
//     on mutations — every company the operator belongs to) so a cashier in
//     tenant A cannot see, mutate, or geofence tenant B's fleet.
//   - An order and the rider carrying it must belong to the SAME company. A
//     head-office operator's write scope spans every company they are a
//     member of, so "both in scope" is not enough on assign.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'

// Company-scoped rider lookup. Goes through scopeTenantWhere rather than the
// raw tenantFilter so a staff user with no company resolves to an empty
// `in: []` rather than `tenantId: null` (which would match legacy
// company-less rows).
async function findRiderInScope(req: FastifyRequest, id: string, mode: ScopeMode) {
  return prisma.rider.findFirst({
    where: { id, deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
  })
}

export async function dispatchRoutes(fastify: FastifyInstance) {
  // POST /dispatch/riders/:id/location — post a fix
  fastify.post<{ Params: { id: string } }>(
    '/riders/:id/location',
    {
      preHandler: requireAuth(...ALL_STAFF),
      config: { rateLimit: { max: 600, timeWindow: '10 minutes' } },  // ~1/sec ceiling
    },
    async (req) => {
      const body = z.object({
        lat:      z.number().min(-90).max(90),
        lng:      z.number().min(-180).max(180),
        heading:  z.number().min(0).max(359).optional(),
        accuracy: z.number().min(0).max(10_000).optional(),
        speedMps: z.number().min(0).optional(),
        orderId:  z.string().uuid().optional(),
      }).parse(req.body)

      const rider = await findRiderInScope(req, req.params.id, 'write')
      if (!rider) throw new NotFoundError('Rider', req.params.id)

      // A fix may only be pinned to an order this rider is actually carrying,
      // under a brand of a company the operator can act in — never a guessed
      // foreign order id on the GPS trail.
      if (body.orderId) {
        const order = await prisma.order.findFirst({
          where: {
            id: body.orderId,
            riderId: rider.id,
            deletedAt: null,
            concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
          },
          select: { id: true },
        })
        if (!order) throw new AppError('ORDER_NOT_ASSIGNED', 'Order is not assigned to this rider', 422)
      }

      const now = new Date()
      await prisma.$transaction([
        prisma.riderLocation.create({
          data: {
            riderId: rider.id,
            orderId: body.orderId ?? null,
            lat: body.lat, lng: body.lng,
            heading: body.heading ?? null,
            accuracy: body.accuracy ?? null,
            speedMps: body.speedMps ?? null,
            recordedAt: now,
          },
        }),
        prisma.rider.update({
          where: { id: rider.id },
          data: {
            lastLat: body.lat, lastLng: body.lng,
            lastHeading: body.heading ?? null,
            lastAccuracy: body.accuracy ?? null,
            lastReportedAt: now,
            // Auto-flip to 'available' if rider was offline
            ...(rider.status === 'offline' && { status: 'available' as never }),
          },
        }),
      ])

      return { ok: true, recordedAt: now.toISOString() }
    },
  )

  // GET /dispatch/riders/:id/track — recent location history (last 1h default)
  fastify.get<{ Params: { id: string }; Querystring: { sinceMin?: string } }>(
    '/riders/:id/track',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      // Verify the rider belongs to the caller's tenant before returning their
      // GPS trail — otherwise this is a competitor-fleet-tracking endpoint.
      const rider = await findRiderInScope(req, req.params.id, 'read')
      if (!rider) throw new NotFoundError('Rider', req.params.id)
      const sinceMin = parseInt(req.query.sinceMin ?? '60', 10)
      const since = new Date(Date.now() - sinceMin * 60_000)
      return prisma.riderLocation.findMany({
        where: { riderId: rider.id, recordedAt: { gte: since } },
        orderBy: { recordedAt: 'desc' },
        take: 1000,
      })
    },
  )

  // GET /dispatch/board — live aggregator: every active rider in this tenant
  // + their current assigned orders + last fix age. Drives the admin dispatch
  // view. Riders with no tenantId (legacy / unassigned) are excluded — they
  // shouldn't appear on any dispatch board until an admin assigns them.
  fastify.get('/board', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    const riders = await prisma.rider.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        ...scope,
      },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, phone: true, vehicleType: true, status: true,
        lastLat: true, lastLng: true, lastHeading: true, lastReportedAt: true,
        orders: {
          where: {
            status: { in: ['ready', 'preparing', 'confirmed'] },
            deletedAt: null,
            // Belt-and-braces: even within a tenant-scoped rider, only show
            // orders whose concept is in scope.
            concept: { deletedAt: null, ...scope },
          },
          select: {
            id: true, status: true, totalCents: true, customerName: true, deliveryNotes: true,
            placedAt: true, estimatedPickup: true,
            concept: { select: { name: true, slug: true } },
          },
          orderBy: { placedAt: 'desc' },
        },
      },
    })
    const now = Date.now()
    return riders.map((r) => ({
      ...r,
      lastFixAgeMs: r.lastReportedAt ? (now - new Date(r.lastReportedAt).getTime()) : null,
      stale: r.lastReportedAt ? (now - new Date(r.lastReportedAt).getTime()) > 5 * 60_000 : true,
    }))
  })

  // POST /dispatch/orders/:id/assign — assign an order to a rider
  fastify.post<{ Params: { id: string }; Body: { riderId: string } }>(
    '/orders/:id/assign',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({ riderId: z.string().uuid() }).parse(req.body)
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.id,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
        select: { id: true, concept: { select: { tenantId: true } } },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      // Rider must also be in the same tenant — stops cross-tenant fleet
      // hijacking via order-assign.
      const rider = await findRiderInScope(req, body.riderId, 'write')
      if (!rider) throw new NotFoundError('Rider', body.riderId)
      // Write scope spans every company a head-office operator belongs to,
      // so "both in scope" is not "same company": the rider must belong to
      // the ORDER's company or one fleet ends up carrying the other's orders.
      if (rider.tenantId !== order.concept.tenantId) {
        throw new AppError('RIDER_NOT_IN_COMPANY', "Rider does not belong to the order's company", 422)
      }
      if (rider.status === 'offline') throw new AppError('RIDER_OFFLINE', 'Rider is offline', 422)

      return prisma.$transaction(async (tx) => {
        const updated = await tx.order.update({
          where: { id: order.id },
          data: { riderId: rider.id },
        })
        await tx.rider.update({
          where: { id: rider.id },
          data: { status: 'busy' as never },
        })
        return updated
      })
    },
  )

  // POST /dispatch/orders/:id/unassign
  fastify.post<{ Params: { id: string } }>(
    '/orders/:id/unassign',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const owned = await prisma.order.findFirst({
        where: {
          id: req.params.id,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      return prisma.order.update({
        where: { id: req.params.id },
        data: { riderId: null },
      })
    },
  )

  // POST /dispatch/riders/:id/status — set rider availability
  fastify.post<{ Params: { id: string }; Body: { status: 'available' | 'busy' | 'offline' } }>(
    '/riders/:id/status',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({ status: z.enum(['available', 'busy', 'offline']) }).parse(req.body)
      const rider = await findRiderInScope(req, req.params.id, 'write')
      if (!rider) throw new NotFoundError('Rider', req.params.id)
      return prisma.rider.update({
        where: { id: rider.id },
        data: { status: body.status as never },
      })
    },
  )
}
