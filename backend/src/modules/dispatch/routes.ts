// Rider dispatch + live location.
//
// Riders post their current location every ~10s while on shift. We persist
// to RiderLocation history (pruned weekly) and update the Rider row with the
// latest fix. The customer-facing tracking page polls /storefront/orders/:id
// and reads the rider's lastLat/lastLng — no need for a per-customer socket.
//
// Auth: rider authenticates with a phone-based PIN (kept simple — riders are
// typically third-party contractors). Staff CAN post on a rider's behalf for
// testing.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

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

      const rider = await prisma.rider.findUnique({ where: { id: req.params.id } })
      if (!rider) throw new NotFoundError('Rider', req.params.id)

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
      const sinceMin = parseInt(req.query.sinceMin ?? '60', 10)
      const since = new Date(Date.now() - sinceMin * 60_000)
      return prisma.riderLocation.findMany({
        where: { riderId: req.params.id, recordedAt: { gte: since } },
        orderBy: { recordedAt: 'desc' },
        take: 1000,
      })
    },
  )

  // GET /dispatch/board — live aggregator: every active rider + their current
  // assigned orders + last fix age. Drives the admin dispatch view.
  fastify.get('/board', { preHandler: requireAuth(...ALL_STAFF) }, async () => {
    const riders = await prisma.rider.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, phone: true, vehicleType: true, status: true,
        lastLat: true, lastLng: true, lastHeading: true, lastReportedAt: true,
        orders: {
          where: { status: { in: ['ready', 'preparing', 'confirmed'] }, deletedAt: null },
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
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      const rider = await prisma.rider.findUnique({ where: { id: body.riderId } })
      if (!rider) throw new NotFoundError('Rider', body.riderId)
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
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
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
      return prisma.rider.update({
        where: { id: req.params.id },
        data: { status: body.status as never },
      })
    },
  )
}
