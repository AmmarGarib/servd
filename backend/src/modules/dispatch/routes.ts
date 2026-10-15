// Rider dispatch + live location.
//
// Riders post their current location every ~10s while on shift — from the
// rider app (POST /rider/location, modules/rider) or relayed by staff here. We
// persist to RiderLocation history (pruned after 24 h by the rider-dispatch
// worker), update the Rider row with the latest fix and push `rider:location`
// over the socket (dispatch/service.ts recordRiderFix — one writer for both).
// The customer-facing tracking page polls /storefront/orders/:id and reads the
// rider's last fix.
//
// Auth + tenant model:
//   - All routes require a staff session (requireAuth ALL_STAFF).
//   - Every Rider row carries a tenantId (added in migration
//     20260602100000_rider_tenant_id). Every query in this module is scoped
//     through `scopeTenantWhere` ('read' on GETs — portfolio-aware; 'write'
//     on mutations — every company the operator belongs to) so a cashier in
//     tenant A cannot see, mutate, or geofence tenant B's fleet.
//   - An order and the rider carrying it belong to the SAME company, or the
//     rider's company has an active fleet agreement to deliver for the
//     order's company (docs/rider-app.md — the one deliberate crossing). A
//     head-office operator's write scope spans every company they are a
//     member of, so "both in scope" is not enough on assign; assignRider
//     checks the rule itself.
//   - The board shows the operator's own fleet plus any other company's rider
//     while (and only while) they carry one of the operator's orders — and
//     then only those orders.
//   - The customer's hand-over code is stripped from every order this module
//     returns unless the operator is admin / management — and from every
//     order of a company with code-only delivery on, for every role
//     (lib/deliveryOtp.ts, lib/deliveryRules.ts).
//   - Code-only delivery (per company, lib/deliveryRules.ts, default OFF):
//     ON, there is no staff "Delivered" — POST /orders/:id/delivered is 404 —
//     and the board says so per order (`codeOnly`) so the admin hides it.
//
// This is the one set of rider-assignment routes (the rules live in
// ./service.ts). /riders keeps the roster (create / edit / history / rating /
// fleet agreements); its old /riders/assign, /riders/unassign and the two
// rider-status PATCHes were removed in favour of these.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import {
  assignRider, unassignRider, markDelivered, setRiderStatus, recordRiderFix, riderFixSchema, stillWithRiderWhere, boardOverrideInfo,
} from './service.js'
import { redactDeliveryOtp } from '../../lib/deliveryOtp.js'
import { codeOnlyDelivery } from '../../lib/deliveryRules.js'

// Company-scoped rider lookup. Goes through scopeTenantWhere rather than the
// raw tenantFilter so a staff user with no company resolves to an empty
// `in: []` rather than `tenantId: null` (which would match legacy
// company-less rows).
async function findRiderInScope(req: FastifyRequest, id: string, mode: ScopeMode) {
  return prisma.rider.findFirst({
    where: { id, deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
  })
}

// Company-scoped order lookup ('write' — every mutation here acts on it).
// A foreign id 404s before anything is read or changed.
async function findOrderInScope(req: FastifyRequest, id: string) {
  const order = await prisma.order.findFirst({
    where: { id, deletedAt: null, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
    select: { id: true, concept: { select: { tenantId: true } } },
  })
  if (!order) throw notFound()
  return { id: order.id, tenantId: order.concept.tenantId }
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Order not found in your active company', 404)
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
      const body = riderFixSchema.parse(req.body)

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

      // No status change here any more: a fix used to flip an 'offline' rider
      // back to 'available'. Going on shift is the rider's own action.
      return recordRiderFix(rider, body)
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
    // Orders the board may show: still on a rider's hands — the one definition
    // (service.ts riderOpenOrderWhere: in service, or 'completed' by expo / the
    // till and still out with the rider), so the board, the rider's job list
    // and freeing a rider agree — of a brand in scope.
    const ordersInScope: Prisma.OrderWhereInput = {
      ...stillWithRiderWhere(),
      concept: { deletedAt: null, ...scope },
    }
    // serviceClient with explicit company filters on both the riders and
    // their orders: a fleet partner's rider row belongs to ANOTHER company,
    // which the RLS-scoped client would hide from this operator under
    // enforced RLS (the riders policy only shows one's own company's rows).
    const riders = await serviceClient.rider.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        // Our own fleet, plus another company's rider only while they carry
        // one of OUR orders (a fleet agreement) — never their idle riders.
        OR: [scope, { orders: { some: ordersInScope } }],
      },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, phone: true, vehicleType: true, status: true, tenantId: true,
        lastLat: true, lastLng: true, lastHeading: true, lastReportedAt: true,
        orders: {
          // Belt-and-braces: even within a tenant-scoped rider, only show
          // orders whose concept is in scope.
          where: ordersInScope,
          // An explicit field list — never deliveryOtp (the hand-over code).
          // deliveryOtpAttempts tells the board the code has locked.
          select: {
            id: true, status: true, totalCents: true, customerName: true, deliveryNotes: true,
            placedAt: true, estimatedPickup: true, fulfilmentType: true,
            riderAssignedAt: true, riderAcceptedAt: true, pickedUpAt: true, arrivedAt: true,
            deliveryOtpAttempts: true,
            // Emergency override: the code was sent to this rider — the
            // order is pinned to them until delivered.
            handoverReroutedAt: true, handoverRerouteRiderId: true,
            concept: { select: { name: true, slug: true, tenantId: true } },
          },
          orderBy: { placedAt: 'desc' },
        },
      },
    })
    const inScope = new Set(typeof scope.tenantId === 'string' ? [scope.tenantId] : scope.tenantId.in)
    // Code-only delivery per ORDER's company: the admin hides "Delivered" on
    // those orders (the route would answer 404).
    const orderTenants = [...new Set(riders.flatMap((r) => r.orders.map((o) => o.concept.tenantId)).filter((t): t is string => !!t))]
    const codeOnlyTenants = new Set<string>()
    for (const t of orderTenants) if (await codeOnlyDelivery(serviceClient, t)) codeOnlyTenants.add(t)
    const extras = await boardOverrideInfo(riders.flatMap((r) => r.orders.map((o) => ({ id: o.id, riderId: r.id }))))
    const now = Date.now()
    return riders.map(({ tenantId, orders, ...r }) => ({
      ...r,
      orders: orders.map(({ concept: { tenantId: orderTenantId, ...concept }, ...o }) => ({
        ...o,
        concept,
        codeOnly: !!orderTenantId && codeOnlyTenants.has(orderTenantId),
        handoverRerouteByName: extras.get(o.id)?.handoverRerouteByName ?? null,
        doorProblem: extras.get(o.id)?.doorProblem ?? null,
      })),
      // True for a rider of another company carrying our orders under a
      // fleet agreement — the board can label them.
      fleetPartner: !tenantId || !inScope.has(tenantId),
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
      const order = await findOrderInScope(req, req.params.id)
      // Rider must also be in scope — stops cross-tenant fleet hijacking via
      // order-assign. Same-company, active and not-offline are enforced by
      // assignRider.
      const rider = await findRiderInScope(req, body.riderId, 'write')
      if (!rider) throw new NotFoundError('Rider', body.riderId)
      const codeOnly = await codeOnlyDelivery(serviceClient, order.tenantId)
      return redactDeliveryOtp(await assignRider(order.id, rider.id), req.staffUser!.role, codeOnly)
    },
  )

  // POST /dispatch/orders/:id/unassign — take the rider off; the rider is
  // freed if it was their last active order.
  fastify.post<{ Params: { id: string } }>(
    '/orders/:id/unassign',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const order = await findOrderInScope(req, req.params.id)
      const codeOnly = await codeOnlyDelivery(serviceClient, order.tenantId)
      return redactDeliveryOtp(await unassignRider(order.id), req.staffUser!.role, codeOnly)
    },
  )

  // POST /dispatch/orders/:id/delivered — the rider dropped it off. This is
  // when a delivery completes (decision 8): a still-'ready' order goes through
  // the one completion routine; the delivery is counted once and the rider
  // freed. On a rider-app job (riderAssignedAt set) the rider closes it with
  // the customer's code, so this is a MANAGERS override, and only when the
  // code has locked or the rider never accepted — otherwise 409
  // RIDER_CLOSES_WITH_CODE (service.ts markDelivered staffClose). Older orders
  // keep the old rule. Pressing it again on a delivered order is not an error.
  // A company with code-only delivery ON has no staff "Delivered": 404, as if
  // the route did not exist (it is deleted once every live company is on).
  fastify.post<{ Params: { id: string } }>(
    '/orders/:id/delivered',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const order = await findOrderInScope(req, req.params.id)
      if (await codeOnlyDelivery(serviceClient, order.tenantId)) throw notFound()
      const r = await markDelivered(order.id, {
        actor: { id: req.staffUser!.id, email: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null },
        staffClose: { manager: MANAGERS.includes(req.staffUser!.role) },
      })
      return { ...r, order: redactDeliveryOtp(r.order, req.staffUser!.role) }
    },
  )

  // POST /dispatch/riders/:id/status — set rider availability (the one writer)
  fastify.post<{ Params: { id: string }; Body: { status: 'available' | 'busy' | 'offline' } }>(
    '/riders/:id/status',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({ status: z.enum(['available', 'busy', 'offline']) }).parse(req.body)
      const rider = await findRiderInScope(req, req.params.id, 'write')
      if (!rider) throw new NotFoundError('Rider', req.params.id)
      return setRiderStatus(rider.id, body.status)
    },
  )
}
