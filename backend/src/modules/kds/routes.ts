import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { conceptIdsInScope, conceptWhere, scopeTenantWhere } from '../../lib/tenantScope.js'
import { NotFoundError } from '../../lib/errors.js'
import { listAutoEightySixedBackInStock, recallBlock, kitchenDueWhere } from '../orders/service.js'
import { KITCHEN_WORK_LINE, SERVICE_PHASES } from '../expo/fire.js'

// ─── routes ────────────────────────────────────────────────────────────────
//
// Company scope: every read goes through lib/tenantScope (view-aware 'read'
// mode). An empty scope denies (`tenantId: { in: [] }`); a staff member with
// no company sees nothing — never the company-less rows.

/** Order statuses whose kitchen work is still live (a till sale is 'completed' at payment, often before it is cooked). */
const OPEN_FOR_KITCHEN = ['received', 'confirmed', 'preparing', 'ready', 'completed'] as const

/**
 * A station's live load (O-RV-3): unfinished lines, except the pending lines
 * of a pre-order whose prep window has not opened — tomorrow's ticket is not
 * today's work. A line already fired counts however early it was fired.
 */
function liveLoadWhere() {
  return {
    status: { notIn: ['bumped', 'voided'] as Array<'bumped' | 'voided'> },
    OR: [{ status: { not: 'pending' as const } }, { order: kitchenDueWhere() }],
  }
}

export async function kdsRoutes(fastify: FastifyInstance) {
  // GET /kds/stations?conceptId=X
  // List stations with live load — count of non-completed OrderItems per station.
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/stations',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const stations = await prisma.station.findMany({
        where: {
          deletedAt: null,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
          ...(req.query.conceptId && { conceptId: req.query.conceptId }),
        },
        orderBy: [{ conceptId: 'asc' }, { displayOrder: 'asc' }],
        include: {
          concept: { select: { name: true, slug: true } },
          _count: {
            select: {
              orderItems: {
                where: liveLoadWhere(),
              },
            },
          },
        },
      })

      return stations.map((s) => ({
        id: s.id,
        conceptId: s.conceptId,
        name: s.name,
        displayOrder: s.displayOrder,
        isActive: s.isActive,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        concept: s.concept,
        liveLoad: s._count.orderItems,
      }))
    },
  )

  // GET /kds/my-stations
  // Data source for the line-cook dashboard at /kds. Two regimes:
  //
  //   - "Unrestricted" roles (admin/CEO, management tiers, expediter) —
  //     see every active station in their tenant scope regardless of what
  //     User.stationIds contains. These roles are oversight surfaces, not
  //     station-bound work.
  //
  //   - Line roles (kitchen, boh, …) — see their assigned stations. An EMPTY
  //     roster means "not restricted": every active station of the company,
  //     which is what Workforce tells the manager ("Empty = not restricted").
  //     It used to mean "nothing", so every new cook opened /kds to "No
  //     stations assigned to you yet" (UI-14). Stations are always limited to
  //     the caller's company scope.
  //
  // The response carries `restricted` (true only when a roster narrowed the
  // list) so the frontend's empty-state copy can tell "no stations in this
  // company" apart from "your assigned stations are all switched off".
  const UNRESTRICTED_ROLES = new Set<string>([
    'admin', 'management', 'foh_management', 'boh_management', 'expediter',
  ])
  fastify.get(
    '/my-stations',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const role = req.staffUser!.role

      // Line roles need their roster — refetch so we get the canonical list
      // (the auth middleware doesn't decorate this field).
      let assigned: string[] = []
      if (!UNRESTRICTED_ROLES.has(role)) {
        const me = await prisma.user.findUnique({
          where: { id: req.staffUser!.id },
          select: { stationIds: true },
        })
        assigned = me?.stationIds ?? []
      }
      const restricted = assigned.length > 0

      const stations = await prisma.station.findMany({
        where: {
          deletedAt: null,
          isActive: true,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
          ...(restricted ? { id: { in: assigned } } : {}),
        },
        orderBy: [{ conceptId: 'asc' }, { displayOrder: 'asc' }],
        include: {
          concept: { select: { id: true, name: true, slug: true } },
          _count: {
            select: {
              orderItems: { where: liveLoadWhere() },
            },
          },
        },
      })

      return {
        restricted,
        stations: stations.map((s) => ({
          id: s.id,
          conceptId: s.conceptId,
          name: s.name,
          displayOrder: s.displayOrder,
          isActive: s.isActive,
          concept: s.concept,
          liveLoad: s._count.orderItems,
        })),
      }
    },
  )

  // GET /kds/unrouted — open tickets no station screen shows (BOH-03): items
  // with no station, or routed to a station that has since been retired
  // (soft-deleted or switched off) — e.g. rung up before the routing fix, or
  // a brand with no expo / pass station to fall back to. The kitchen
  // dashboard lists them with a Bump so the order can still reach 'ready'.
  // Items on recipe steps are routed per step and are not listed — fired or
  // not (an unfired step-routed dish has no steps yet, but its recipe has).
  fastify.get(
    '/unrouted',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const conceptIds = await conceptIdsInScope(req, 'read')
      if (conceptIds.length === 0) return { items: [] }
      const items = await prisma.orderItem.findMany({
        where: {
          status: { in: ['pending', 'preparing', 'held', 'recalled'] },
          steps: { none: {} },
          AND: [
            {
              OR: [
                { stationId: null },
                { station: { OR: [{ deletedAt: { not: null } }, { isActive: false }] } },
              ],
            },
            {
              // A step-routed dish has no steps until it is fired — firing
              // lays them out on their stations, so it is not unrouted (R5).
              OR: [
                { menuItemId: null },
                { menuItem: { is: { recipe: { is: null } } } },
                { menuItem: { is: { recipe: { is: { recipeSteps: { none: { phase: { in: [...SERVICE_PHASES] } } } } } } } },
              ],
            },
          ],
          order: {
            conceptId: { in: conceptIds },
            deletedAt: null,
            status: { in: [...OPEN_FOR_KITCHEN] },
            // The 12-hour window runs on the order's EFFECTIVE time —
            // greatest(placedAt, scheduledFor) — so a pre-order placed days
            // ahead is listed once its window opens (OK2-RV-6), the same rule
            // as rider dispatch.
            AND: [{
              OR: [
                { placedAt: { gte: new Date(Date.now() - 12 * 3_600_000) } },
                { scheduledFor: { gte: new Date(Date.now() - 12 * 3_600_000) } },
              ],
            }],
            // A till sale paid with nothing to cook on it (a bottled drink, a
            // market chiller item — R3) is done at payment: its lines are no
            // stuck ticket. Same rule as expo's paid-order column.
            OR: [{ status: { not: 'completed' } }, { items: { some: KITCHEN_WORK_LINE } }],
          },
          // A pending line of a pre-order before its prep window (O-RV-3) is
          // not a stuck ticket yet; a line fired early is listed as usual.
          OR: [{ status: { not: 'pending' } }, { order: kitchenDueWhere() }],
        },
        select: {
          id: true, name: true, quantity: true, notes: true, status: true, firedAt: true,
          station: { select: { name: true } },
          order: {
            select: {
              id: true, status: true, source: true, fulfilmentType: true, placedAt: true, customerName: true,
              concept: { select: { id: true, name: true, slug: true } },
              table: { select: { label: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
      })
      return {
        items: items.map((it) => ({
          itemId:      it.id,
          itemName:    it.name,
          qty:         it.quantity,
          itemNotes:   it.notes,
          status:      it.status,
          firedAt:     it.firedAt,
          /** The retired station it was routed to; null = never routed. */
          retiredStation: it.station?.name ?? null,
          order: {
            id:             it.order.id,
            status:         it.order.status,
            source:         it.order.source,
            fulfilmentType: it.order.fulfilmentType,
            placedAt:       it.order.placedAt,
            customerName:   it.order.customerName,
            tableLabel:     it.order.table?.label ?? null,
            concept:        it.order.concept,
          },
        })),
      }
    },
  )

  // GET /kds/stations/:stationId/recent-bumped — what this station bumped in
  // the last 30 minutes that can still be recalled for a remake (BOH-04): the
  // order has not ended and its food has not left (recallBlock — the same
  // rule PATCH /order-items/:id/status { status: 'recalled' } enforces). The
  // station screen's Recall strip reads this. A station outside the caller's
  // companies is 404.
  fastify.get<{ Params: { stationId: string } }>(
    '/stations/:stationId/recent-bumped',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const station = await prisma.station.findFirst({
        where: { id: req.params.stationId, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) } },
        select: { id: true },
      })
      if (!station) throw new NotFoundError('Station', req.params.stationId)
      const items = await prisma.orderItem.findMany({
        where: {
          stationId: station.id,
          status: { in: ['ready', 'bumped'] },
          completedAt: { gte: new Date(Date.now() - 30 * 60_000) },
          order: { deletedAt: null, status: { in: [...OPEN_FOR_KITCHEN] } },
        },
        select: {
          id: true, name: true, quantity: true, status: true, completedAt: true,
          order: {
            select: {
              id: true, status: true, source: true, fulfilmentType: true, rawPayload: true,
              pickedUpAt: true, deliveredAt: true, customerName: true,
              table: { select: { label: true } },
            },
          },
        },
        orderBy: { completedAt: 'desc' },
        take: 30,
      })
      const handedOff = new Set((await prisma.auditLog.findMany({
        where: { entity: 'Order', action: 'expo.handoff', entityId: { in: [...new Set(items.map((i) => i.order.id))] } },
        select: { entityId: true },
      })).map((a) => a.entityId))
      return {
        items: items
          .filter((it) => recallBlock(it.order, handedOff.has(it.order.id)) === null)
          .map((it) => ({
            itemId:      it.id,
            itemName:    it.name,
            qty:         it.quantity,
            status:      it.status,
            completedAt: it.completedAt,
            order: {
              id:           it.order.id,
              status:       it.order.status,
              customerName: it.order.customerName,
              tableLabel:   it.order.table?.label ?? null,
            },
          })),
      }
    },
  )

  // GET /kds/auto-86/back-in-stock?conceptId=X — dishes the stock switched
  // off (auto-86) that can be cooked again now the delivery is in (BOH-15).
  // Nothing turns them back on by itself (a manual 86 may stand on top); a
  // manager puts each back with one tap: PATCH /menu/items/:id/availability.
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/auto-86/back-in-stock',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const scope = await conceptWhere(req, req.query.conceptId, 'read')
      const conceptIds = typeof scope.conceptId === 'string' ? [scope.conceptId] : scope.conceptId.in
      return { items: await listAutoEightySixedBackInStock(conceptIds) }
    },
  )

  // Item moves (fire / bump / hold / recall) and station queues are NOT here:
  // the one kitchen writer is PATCH /order-items/:id/status (state machine +
  // completion side effects) plus POST /expo/steps/:id/bump, and a station
  // screen reads GET /expo/station/:stationId/queue. The old /kds/items/*,
  // /kds/queue and /kds/metrics routes wrote OrderItem rows directly and
  // completed orders without the journal / rollup side effects, so they were
  // removed (D3).
}
