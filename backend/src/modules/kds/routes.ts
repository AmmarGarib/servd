import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, requireAuthOrPin, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { getIOSafe } from '../../lib/ws.js'

// â”€â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function safeEmitKds(label: string, tenantId: string | null, event: string, data: unknown) {
  const ws = getIOSafe()
  if (!ws) {
    console.warn(`[kds-routes] ${label} skipped â€” WebSocket not initialised`)
    return
  }
  try {
    // Broadcast to the all-orders room (expediters + managers) and to the
    // station-specific room so the individual KDS screen refreshes instantly.
    ws.to('all-orders').emit(event, data)
    if ((data as { stationId?: string }).stationId) {
      ws.to(`station:${(data as { stationId: string }).stationId}`).emit(event, data)
    }
  } catch (err) {
    console.error(`[kds-routes] ${label} emit failed:`, (err as Error).message)
  }
}

// â”€â”€â”€ routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function kdsRoutes(fastify: FastifyInstance) {
  // GET /kds/stations?conceptId=X
  // List stations with live load â€” count of non-completed OrderItems per station.
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/stations',
    { preHandler: requireAuthOrPin(...ALL_STAFF) },
    async (req) => {
      // tenantId stays a single string so writes (safeEmit / order updates)
      // can use it; reads filter via tenantFilter which expands to an IN-clause
      // when the operator is in portfolio mode.
      const tenantId = req.staffUser!.tenantId
      const tenantFilter = req.staffUser!.tenantFilter

      const stations = await prisma.station.findMany({
        where: {
          deletedAt: null,
          concept: { tenantId: tenantFilter, deletedAt: null },
          ...(req.query.conceptId && { conceptId: req.query.conceptId }),
        },
        orderBy: [{ conceptId: 'asc' }, { displayOrder: 'asc' }],
        include: {
          concept: { select: { name: true, slug: true } },
          _count: {
            select: {
              orderItems: {
                where: { status: { notIn: ['bumped', 'voided'] } },
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
  //   - "Station-bound" roles (kitchen line, boh) — see ONLY their
  //     assigned stations. Empty stationIds means the cook hasn't been
  //     rostered yet, so the dashboard is intentionally empty and the UI
  //     tells them to ask their manager.
  //
  // The response carries `restricted` so the frontend's empty-state copy
  // can tell "no stations in this tenant" (unrestricted, zero rows) apart
  // from "no stations assigned to you yet" (restricted, zero rows).
  const UNRESTRICTED_ROLES = new Set<string>([
    'admin', 'management', 'foh_management', 'boh_management', 'expediter',
  ])
  fastify.get(
    '/my-stations',
    { preHandler: requireAuthOrPin(...ALL_STAFF) },
    async (req) => {
      const tenantFilter = req.staffUser!.tenantFilter
      const role = req.staffUser!.role
      const isUnrestricted = UNRESTRICTED_ROLES.has(role)

      // Station-bound roles need their roster — refetch so we get the
      // canonical list (the auth middleware doesn't decorate this field).
      let assigned: string[] = []
      if (!isUnrestricted) {
        const me = await prisma.user.findUnique({
          where: { id: req.staffUser!.id },
          select: { stationIds: true },
        })
        assigned = me?.stationIds ?? []
        // Roster empty → empty list, no point hitting Station at all.
        if (assigned.length === 0) {
          return { restricted: true, stations: [] }
        }
      }

      const stations = await prisma.station.findMany({
        where: {
          deletedAt: null,
          isActive: true,
          concept: { tenantId: tenantFilter, deletedAt: null },
          ...(isUnrestricted ? {} : { id: { in: assigned } }),
        },
        orderBy: [{ conceptId: 'asc' }, { displayOrder: 'asc' }],
        include: {
          concept: { select: { id: true, name: true, slug: true } },
          _count: {
            select: {
              orderItems: { where: { status: { notIn: ['bumped', 'voided'] } } },
            },
          },
        },
      })

      return {
        restricted: !isUnrestricted,
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

  // GET /kds/queue/:stationId
  // All active OrderItems routed to this station (not bumped or voided).
  fastify.get<{ Params: { stationId: string } }>(
    '/queue/:stationId',
    { preHandler: requireAuthOrPin(...ALL_STAFF) },
    async (req) => {
      const { stationId } = req.params
      // tenantId stays a single string so writes (safeEmit / order updates)
      // can use it; reads filter via tenantFilter which expands to an IN-clause
      // when the operator is in portfolio mode.
      const tenantId = req.staffUser!.tenantId
      const tenantFilter = req.staffUser!.tenantFilter

      // Verify station belongs to requester's tenant
      const station = await prisma.station.findFirst({
        where: {
          id: stationId,
          deletedAt: null,
          concept: { tenantId: tenantFilter, deletedAt: null },
        },
      })
      if (!station) throw new NotFoundError('Station', stationId)

      const items = await prisma.orderItem.findMany({
        where: {
          stationId,
          status: { notIn: ['bumped', 'voided'] },
          order: { deletedAt: null },
        },
        orderBy: [{ order: { placedAt: 'asc' } }, { course: 'asc' }, { createdAt: 'asc' }],
        include: {
          order: {
            select: {
              id: true,
              source: true,
              placedAt: true,
              table: { select: { label: true } },
            },
          },
          modifiers: { select: { name: true, priceDeltaCents: true } },
        },
      })

      return items.map((item) => ({
        id: item.id,
        orderId: item.orderId,
        name: item.name,
        quantity: item.quantity,
        status: item.status,
        notes: item.notes,
        course: item.course,
        firedAt: item.firedAt,
        completedAt: item.completedAt,
        createdAt: item.createdAt,
        modifiers: item.modifiers,
        order: {
          id: item.order.id,
          source: item.order.source,
          placedAt: item.order.placedAt,
          tableLabel: item.order.table?.label ?? null,
        },
      }))
    },
  )

  // POST /kds/items/:itemId/fire
  // Transition item to 'preparing' (fire), stamp firedAt, broadcast kds:item_fired.
  fastify.post<{ Params: { itemId: string } }>(
    '/items/:itemId/fire',
    { preHandler: requireAuthOrPin(...ALL_STAFF) },
    async (req) => {
      const { itemId } = req.params
      // tenantId stays a single string so writes (safeEmit / order updates)
      // can use it; reads filter via tenantFilter which expands to an IN-clause
      // when the operator is in portfolio mode.
      const tenantId = req.staffUser!.tenantId
      const tenantFilter = req.staffUser!.tenantFilter

      const existing = await prisma.orderItem.findFirst({
        where: {
          id: itemId,
          order: { concept: { tenantId: tenantFilter }, deletedAt: null },
        },
        select: { id: true, stationId: true, status: true },
      })
      if (!existing) throw new NotFoundError('OrderItem', itemId)

      const updated = await prisma.orderItem.update({
        where: { id: itemId },
        data: { status: 'preparing', firedAt: new Date() },
        select: { id: true, orderId: true, status: true, stationId: true, firedAt: true },
      })

      safeEmitKds('kds:item_fired', tenantId, 'kds:item_fired', {
        itemId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
        stationId: updated.stationId,
        firedAt: updated.firedAt,
      })

      return updated
    },
  )

  // POST /kds/items/:itemId/bump
  // Transition item to 'bumped', stamp completedAt, broadcast kds:item_bumped.
  fastify.post<{ Params: { itemId: string } }>(
    '/items/:itemId/bump',
    { preHandler: requireAuthOrPin(...ALL_STAFF) },
    async (req) => {
      const { itemId } = req.params
      // tenantId stays a single string so writes (safeEmit / order updates)
      // can use it; reads filter via tenantFilter which expands to an IN-clause
      // when the operator is in portfolio mode.
      const tenantId = req.staffUser!.tenantId
      const tenantFilter = req.staffUser!.tenantFilter

      const existing = await prisma.orderItem.findFirst({
        where: {
          id: itemId,
          order: { concept: { tenantId: tenantFilter }, deletedAt: null },
        },
        select: { id: true, stationId: true, orderId: true },
      })
      if (!existing) throw new NotFoundError('OrderItem', itemId)

      const updated = await prisma.orderItem.update({
        where: { id: itemId },
        data: { status: 'bumped', completedAt: new Date() },
        select: { id: true, orderId: true, status: true, stationId: true, completedAt: true },
      })

      safeEmitKds('kds:item_bumped', tenantId, 'kds:item_bumped', {
        itemId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
        stationId: updated.stationId,
        completedAt: updated.completedAt,
      })

      // Check if all items in the order are now bumped or voided â€” if so the
      // order moves to 'completed' automatically. Best-effort only: a failure
      // here must never roll back the bump.
      try {
        const order = await prisma.order.findUnique({
          where: { id: updated.orderId },
          select: { id: true, status: true, items: { select: { status: true } } },
        })
        if (order && order.status !== 'completed') {
          const allDone = order.items.every((i) => ['bumped', 'voided'].includes(i.status))
          if (allDone) {
            await prisma.order.update({
              where: { id: order.id },
              data: { status: 'completed', completedAt: new Date() },
            })
          }
        }
      } catch {
        // Non-fatal â€” order status will catch up via the polling fallback
      }

      return updated
    },
  )

  // POST /kds/items/:itemId/recall
  // Pull a bumped item back to 'preparing', clear completedAt, broadcast kds:item_recalled.
  fastify.post<{ Params: { itemId: string } }>(
    '/items/:itemId/recall',
    { preHandler: requireAuthOrPin(...ALL_STAFF) },
    async (req) => {
      const { itemId } = req.params
      // tenantId stays a single string so writes (safeEmit / order updates)
      // can use it; reads filter via tenantFilter which expands to an IN-clause
      // when the operator is in portfolio mode.
      const tenantId = req.staffUser!.tenantId
      const tenantFilter = req.staffUser!.tenantFilter

      const existing = await prisma.orderItem.findFirst({
        where: {
          id: itemId,
          order: { concept: { tenantId: tenantFilter }, deletedAt: null },
        },
        select: { id: true, stationId: true },
      })
      if (!existing) throw new NotFoundError('OrderItem', itemId)

      const updated = await prisma.orderItem.update({
        where: { id: itemId },
        data: { status: 'preparing', completedAt: null },
        select: { id: true, orderId: true, status: true, stationId: true },
      })

      safeEmitKds('kds:item_recalled', tenantId, 'kds:item_recalled', {
        itemId: updated.id,
        orderId: updated.orderId,
        status: updated.status,
        stationId: updated.stationId,
      })

      return updated
    },
  )

  // GET /kds/metrics/:stationId?hours=2
  // Station performance stats for the last N hours.
  fastify.get<{ Params: { stationId: string }; Querystring: { hours?: string } }>(
    '/metrics/:stationId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { stationId } = req.params
      const hours = Math.min(Math.max(parseInt(req.query.hours ?? '2', 10) || 2, 1), 168)
      // tenantId stays a single string so writes (safeEmit / order updates)
      // can use it; reads filter via tenantFilter which expands to an IN-clause
      // when the operator is in portfolio mode.
      const tenantId = req.staffUser!.tenantId
      const tenantFilter = req.staffUser!.tenantFilter

      const station = await prisma.station.findFirst({
        where: {
          id: stationId,
          deletedAt: null,
          concept: { tenantId: tenantFilter, deletedAt: null },
        },
        select: { name: true },
      })
      if (!station) throw new NotFoundError('Station', stationId)

      const since = new Date(Date.now() - hours * 60 * 60 * 1000)

      // Items fired in the window
      const firedItems = await prisma.orderItem.findMany({
        where: {
          stationId,
          firedAt: { gte: since },
          status: { notIn: ['voided'] },
        },
        select: { id: true, firedAt: true, completedAt: true, status: true },
      })

      const itemsFired = firedItems.length
      const itemsPending = firedItems.filter((i) => i.status !== 'bumped').length

      const bumpedItems = firedItems.filter(
        (i) => i.status === 'bumped' && i.firedAt !== null && i.completedAt !== null,
      )

      const avgBumpSecs =
        bumpedItems.length === 0
          ? 0
          : Math.round(
              bumpedItems.reduce((acc, i) => {
                const diff = (i.completedAt!.getTime() - i.firedAt!.getTime()) / 1000
                return acc + diff
              }, 0) / bumpedItems.length,
            )

      return {
        stationName: station.name,
        stationId,
        hoursWindow: hours,
        itemsFired,
        itemsPending,
        avgBumpSecs,
      }
    },
  )
}
