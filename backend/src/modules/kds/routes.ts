import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'

// â”€â”€â”€ routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function kdsRoutes(fastify: FastifyInstance) {
  // GET /kds/stations?conceptId=X
  // List stations with live load â€” count of non-completed OrderItems per station.
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/stations',
    { preHandler: requireAuth(...ALL_STAFF) },
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
    { preHandler: requireAuth(...ALL_STAFF) },
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

  // Item moves (fire / bump / recall) and station queues are NOT here: the one
  // kitchen writer is PATCH /order-items/:id/status (state machine + completion
  // side effects) plus POST /expo/steps/:id/bump, and a station screen reads
  // GET /expo/station/:stationId/queue. The old /kds/items/*, /kds/queue and
  // /kds/metrics routes wrote OrderItem rows directly and completed orders
  // without the journal / rollup side effects, so they were removed (D3).
}
