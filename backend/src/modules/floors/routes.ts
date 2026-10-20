// Floor plan API.
//
// A Floor groups Tables onto a 2D canvas. Operators edit positions through
// the admin UI; the live status board renders the same layout with status
// colors. Multiple floors per concept (Main, Patio, Mezzanine, Bar).
//
// Concept access is enforced — kitchen / cashier roles only see floors for
// concepts they're scoped to.
//
// Company scoping: floors and tables are brand-anchored (conceptId), so
// ownership is resolved through the brand: floor → concept → tenant. Every
// handler that takes an id from the client goes through `scopeTenantWhere`
// (reads are view-aware, edits span every company the operator belongs to,
// creates bind to the active company only). `assertConceptAccess` is the
// per-user brand whitelist and is a no-op for managers — it is NOT a company
// check, which is why each handler carries both.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { assertConceptAccess } from '../../lib/conceptAccess.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertConceptOwned, scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { orderRefOf } from '../../lib/orderRef.js'

const floorSchema = z.object({
  conceptId:     z.string().uuid(),
  name:          z.string().min(1).max(64),
  displayOrder:  z.number().int().min(0).default(0),
  width:         z.number().int().min(400).max(4000).default(1200),
  height:        z.number().int().min(300).max(4000).default(800),
  backgroundUrl: z.string().url().nullable().optional(),
})

// A floor's brand is fixed at creation — re-parenting it would leave its
// tables (conceptId) on a different brand than the floor, or worse, hand the
// floor to another company. `conceptId` in a PATCH body is ignored.
const floorUpdateSchema = floorSchema.omit({ conceptId: true }).partial()

const positionSchema = z.object({
  shape:    z.enum(['rectangle', 'square', 'round', 'banquette', 'counter', 'barstool']).optional(),
  x:        z.number().int().min(0).max(4000).optional(),
  y:        z.number().int().min(0).max(4000).optional(),
  width:    z.number().int().min(20).max(800).optional(),
  height:   z.number().int().min(20).max(800).optional(),
  rotation: z.number().int().min(0).max(359).optional(),
  floorId:  z.string().uuid().nullable().optional(),
})

// Bulk layout save — fewer round-trips while the operator drags tables around.
const bulkLayoutSchema = z.object({
  floorId: z.string().uuid(),
  tables: z.array(z.object({
    id: z.string().uuid(),
    x:  z.number().int(),
    y:  z.number().int(),
    width:    z.number().int().optional(),
    height:   z.number().int().optional(),
    rotation: z.number().int().optional(),
    shape:    z.enum(['rectangle', 'square', 'round', 'banquette', 'counter', 'barstool']).optional(),
  })).max(200),
})

/**
 * Resolve a floor the operator may act on in `mode`, or 404. Ownership is
 * through the brand (floor.concept.tenantId); the per-user brand whitelist
 * is checked afterwards so a foreign id never confirms the floor exists.
 */
async function findOwnedFloor(req: FastifyRequest, id: string, mode: ScopeMode) {
  const floor = await prisma.floor.findFirst({
    where: {
      id,
      deletedAt: null, // a trashed floor is restored from the Trash, not edited
      concept: { deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
    },
  })
  if (!floor) throw new NotFoundError('Floor', id)
  await assertConceptAccess(req.staffUser!, floor.conceptId)
  return floor
}

export async function floorRoutes(fastify: FastifyInstance) {
  // List floors for a concept, with their tables embedded — tenant-scoped
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { conceptId } = req.query
      if (conceptId) {
        // Company check first (404 for a foreign brand), then the per-user
        // brand whitelist (403).
        await assertConceptOwned(req, conceptId, 'read')
        await assertConceptAccess(req.staffUser!, conceptId)
      }
      return prisma.floor.findMany({
        where: {
          deletedAt: null,
          isActive: true,
          // View-aware scope: floor's concept must belong to the active
          // company (or every member company in "All companies" view).
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
          ...(conceptId && { conceptId }),
        },
        include: {
          tables: { where: { deletedAt: null }, orderBy: { label: 'asc' } },
        },
        orderBy: { displayOrder: 'asc' },
      })
    },
  )

  // Create a floor — the brand must belong to the ACTIVE company
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = floorSchema.parse(req.body)
    if (!req.staffUser!.tenantId) {
      throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before adding a floor', 422)
    }
    // 'create' mode: the active company only — never let a new floor land
    // under a brand of another company the operator happens to belong to.
    await assertConceptOwned(req, body.conceptId, 'create')
    await assertConceptAccess(req.staffUser!, body.conceptId)
    const floor = await prisma.floor.create({ data: body })
    return reply.status(201).send(floor)
  })

  // Update a floor — must belong to a company the operator is in
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = floorUpdateSchema.parse(req.body)
      const existing = await findOwnedFloor(req, req.params.id, 'write')
      return prisma.floor.update({ where: { id: existing.id }, data: body })
    },
  )

  // Soft-delete a floor — tables are unassigned (floorId set null), not deleted
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const existing = await findOwnedFloor(req, req.params.id, 'write')
      const concept = await prisma.concept.findUnique({ where: { id: existing.conceptId }, select: { tenantId: true } })
      await prisma.$transaction(async (tx) => {
        // Restore relinks exactly the live tables that sat on it (Trash meta).
        const liveTables = await tx.table.findMany({ where: { floorId: existing.id, deletedAt: null }, select: { id: true } })
        await moveToTrash(tx, req, {
          type: 'floor', entityId: existing.id, tenantId: concept?.tenantId ?? null, conceptId: existing.conceptId,
          title: existing.name, reason: trashReasonOf(req),
          meta: { tableIds: liveTables.map((t) => t.id), previous: { isActive: existing.isActive } },
        })
        await tx.table.updateMany({ where: { floorId: existing.id }, data: { floorId: null } })
        await tx.floor.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isActive: false } })
      })
      return reply.status(204).send()
    },
  )

  // Update a single table's position / shape — fast feedback during drag.
  fastify.patch<{ Params: { id: string } }>(
    '/tables/:id/position',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = positionSchema.parse(req.body)
      const existing = await prisma.table.findFirst({
        where: {
          id: req.params.id,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
      })
      if (!existing) throw new NotFoundError('Table', req.params.id)
      await assertConceptAccess(req.staffUser!, existing.conceptId)
      // A table may only sit on a floor of its own brand — otherwise a
      // guessed floorId would drop it onto another company's floor plan.
      if (body.floorId) {
        const floor = await prisma.floor.findFirst({
          where: { id: body.floorId, conceptId: existing.conceptId, deletedAt: null },
          select: { id: true },
        })
        if (!floor) throw new NotFoundError('Floor', body.floorId)
      }
      return prisma.table.update({ where: { id: existing.id }, data: body })
    },
  )

  // Apply a layout template — bulk-creates tables on a floor from a template.
  // Optional `clearExisting=true` deletes current tables on the floor first
  // (operator confirms in UI). Used by the "Layouts" gallery to drop-in a
  // pre-built configuration: QSR / café / fine-dining / cloud-kitchen.
  fastify.post<{ Params: { id: string } }>('/:id/apply-layout',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        clearExisting: z.boolean().default(false),
        tables: z.array(z.object({
          label:    z.string().min(1).max(20),
          capacity: z.number().int().min(1).max(50),
          shape:    z.enum(['rectangle', 'square', 'round', 'banquette', 'counter']).default('rectangle'),
          x:        z.number().int().min(0),
          y:        z.number().int().min(0),
          width:    z.number().int().min(40).max(400).default(120),
          height:   z.number().int().min(40).max(400).default(80),
          rotation: z.number().int().min(0).max(359).default(0),
          floorSection: z.string().max(40).optional(),
        })).min(1).max(100),
      }).parse(req.body)

      const floor = await findOwnedFloor(req, req.params.id, 'write')
      const concept = body.clearExisting
        ? await prisma.concept.findUnique({ where: { id: floor.conceptId }, select: { tenantId: true } })
        : null

      await prisma.$transaction(async (tx) => {
        if (body.clearExisting) {
          // Soft delete (was a hard deleteMany that threw P2003 -> 500 for any
          // table an order or reservation pointed at). Each replaced table goes
          // to the Trash under its floor, so "Apply layout" can be undone.
          const old = await tx.table.findMany({ where: { floorId: floor.id, deletedAt: null } })
          for (const t of old) {
            await moveToTrash(tx, req, {
              type: 'table', entityId: t.id, tenantId: concept?.tenantId ?? null, conceptId: t.conceptId,
              title: t.label, subtitle: t.floorSection || null, parent: { type: 'floor', id: floor.id },
              reason: 'Replaced by a layout template', meta: { floorId: floor.id },
            })
          }
          if (old.length) await tx.table.updateMany({ where: { id: { in: old.map((t) => t.id) } }, data: { deletedAt: new Date() } })
        }
        for (const t of body.tables) {
          await tx.table.create({
            data: {
              conceptId: floor.conceptId,
              floorId: floor.id,
              label: t.label,
              capacity: t.capacity,
              shape: t.shape,
              x: t.x, y: t.y, width: t.width, height: t.height, rotation: t.rotation,
              floorSection: t.floorSection ?? '',
            },
          })
        }
      })

      return reply.status(201).send({ ok: true, count: body.tables.length })
    },
  )

  // Bulk save layout — one transaction, used on the editor's "Save layout" button.
  fastify.put('/layout', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = bulkLayoutSchema.parse(req.body)
    const floor = await findOwnedFloor(req, body.floorId, 'write')

    // Every table in the payload must already belong to the floor's brand —
    // the save re-parents them onto this floor, so an unchecked id would pull
    // another company's table onto our plan.
    const tableIds = Array.from(new Set(body.tables.map((t) => t.id)))
    if (tableIds.length > 0) {
      const owned = await prisma.table.count({
        where: { id: { in: tableIds }, conceptId: floor.conceptId },
      })
      if (owned !== tableIds.length) {
        throw new AppError('TABLE_NOT_IN_BRAND', 'One or more tables do not belong to this floor\'s brand', 422)
      }
    }

    await prisma.$transaction(
      body.tables.map((t) =>
        prisma.table.update({
          where: { id: t.id },
          data: {
            x: t.x, y: t.y,
            ...(t.width    !== undefined && { width:    t.width }),
            ...(t.height   !== undefined && { height:   t.height }),
            ...(t.rotation !== undefined && { rotation: t.rotation }),
            ...(t.shape    !== undefined && { shape:    t.shape }),
            floorId: floor.id,
          },
        }),
      ),
    )
    return { ok: true, count: body.tables.length }
  })

  // GET /floors/board?conceptId&floorId — the till's Dine In grid (till flow,
  // owner 2026-10-20; pos/TILL_FLOW.md §2): every floor with occupied / vacant
  // counts, the tables (of `floorId`, else all) with their open ticket, pax and
  // waiter. Occupied = an OPEN order sits on the table (the truth); a foreign
  // brand 404s.
  fastify.get('/board', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const q = z.object({ conceptId: z.string().uuid(), floorId: z.string().uuid().optional() }).parse(req.query ?? {})
    await assertConceptOwned(req, q.conceptId, 'read')
    await assertConceptAccess(req.staffUser!, q.conceptId)
    const [floors, tables] = await Promise.all([
      prisma.floor.findMany({
        where: { conceptId: q.conceptId, deletedAt: null, isActive: true },
        orderBy: { displayOrder: 'asc' },
        select: { id: true, name: true, displayOrder: true },
      }),
      prisma.table.findMany({
        where: { conceptId: q.conceptId, deletedAt: null },
        orderBy: { label: 'asc' },
        select: { id: true, label: true, capacity: true, floorId: true, status: true, shape: true, x: true, y: true, width: true, height: true, rotation: true },
      }),
    ])
    const open = tables.length > 0
      ? await prisma.order.findMany({
          where: { conceptId: q.conceptId, tableId: { in: tables.map((t) => t.id) }, status: { in: ['received', 'confirmed', 'preparing', 'ready'] }, deletedAt: null },
          orderBy: { placedAt: 'asc' },
          select: {
            id: true, tableId: true, status: true, totalCents: true, placedAt: true, partySize: true, customerName: true,
            waiter: { select: { id: true, employeeCode: true, fullName: true } },
          },
        })
      : []
    const byTable = new Map<string, typeof open>()
    for (const o of open) byTable.set(o.tableId!, [...(byTable.get(o.tableId!) ?? []), o])
    const count = (ts: typeof tables) => {
      const occupied = ts.filter((t) => byTable.has(t.id)).length
      return { tables: ts.length, occupied, vacant: ts.length - occupied }
    }
    const floorRows = floors.map((f) => ({ ...f, totals: count(tables.filter((t) => t.floorId === f.id)) }))
    const known = new Set(floors.map((f) => f.id))
    const loose = tables.filter((t) => !t.floorId || !known.has(t.floorId))
    if (loose.length > 0) floorRows.push({ id: null as unknown as string, name: 'No floor', displayOrder: 9999, totals: count(loose) })
    const shown = q.floorId ? tables.filter((t) => t.floorId === q.floorId) : tables
    return {
      conceptId: q.conceptId,
      totals: count(tables),
      floors: floorRows,
      tables: shown.map((t) => {
        const os = byTable.get(t.id) ?? []
        const first = os[0]
        return {
          ...t,
          occupied: os.length > 0,
          openOrders: os.length,
          openOrderIds: os.map((o) => o.id),
          order: first
            ? {
                id: first.id, ref: orderRefOf(first.id), status: first.status, totalCents: first.totalCents,
                placedAt: first.placedAt, partySize: first.partySize, customerName: first.customerName,
                waiter: first.waiter ? { id: first.waiter.id, code: first.waiter.employeeCode, name: first.waiter.fullName } : null,
              }
            : null,
        }
      }),
    }
  })

  // Live status — combines tables + currently-open orders + active reservations.
  // The live floor plan polls this every 5–10s.
  fastify.get<{ Querystring: { conceptId: string; floorId?: string } }>(
    '/status',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      // conceptId is mandatory: an absent value would drop the filter and
      // return every company's tables.
      const { conceptId, floorId } = z.object({
        conceptId: z.string().min(1),
        floorId:   z.string().optional(),
      }).parse(req.query)
      // Company check first (404 for a foreign brand — assertConceptAccess is
      // a no-op for managers and never was a company check).
      await assertConceptOwned(req, conceptId, 'read')
      await assertConceptAccess(req.staffUser!, conceptId)

      const tables = await prisma.table.findMany({
        where: {
          conceptId,
          deletedAt: null,
          ...(floorId && { floorId }),
        },
        select: { id: true, label: true, capacity: true, status: true, floorId: true, shape: true, x: true, y: true, width: true, height: true, rotation: true },
      })

      // Open orders per table (lookup by tableId)
      const tableIds = tables.map((t) => t.id)
      const openOrders = tableIds.length > 0
        ? await prisma.order.findMany({
            where: {
              tableId: { in: tableIds },
              status:  { in: ['received', 'confirmed', 'preparing', 'ready'] },
              deletedAt: null,
            },
            select: { id: true, tableId: true, status: true, totalCents: true, placedAt: true, customerName: true },
            orderBy: { placedAt: 'desc' },
          })
        : []
      const orderByTable = new Map<string, typeof openOrders>()
      for (const o of openOrders) {
        if (!o.tableId) continue
        const arr = orderByTable.get(o.tableId) ?? ([] as typeof openOrders)
        arr.push(o)
        orderByTable.set(o.tableId, arr)
      }

      // Imminent reservations (next 2 hours)
      const now    = new Date()
      const horizon = new Date(now.getTime() + 2 * 3600_000)
      const reservations = tableIds.length > 0
        ? await prisma.reservation.findMany({
            where: {
              tableId: { in: tableIds },
              status:  { in: ['booked', 'confirmed', 'seated'] },
              endTime: { gte: now },
              startTime: { lte: horizon },
            },
            select: { id: true, tableId: true, partySize: true, startTime: true, endTime: true, status: true, guestName: true, isVip: true },
          })
        : []
      const resByTable = new Map<string, typeof reservations>()
      for (const r of reservations) {
        if (!r.tableId) continue
        const arr = resByTable.get(r.tableId) ?? ([] as typeof reservations)
        arr.push(r)
        resByTable.set(r.tableId, arr)
      }

      return tables.map((t) => ({
        ...t,
        openOrders:    orderByTable.get(t.id) ?? [],
        reservations:  resByTable.get(t.id)   ?? [],
      }))
    },
  )
}
