// Kitchen stations raised by the F&B manager or the chef, applied when the CEO
// approves (owner C3, 2026-10-26: "F&B manager and kitchen managers may add or
// change kitchen stations, with CEO approval" — "Approval stays with me").
//
//   • Who raises: STATION_REQUESTERS (fnb_manager, boh_management — the chef)
//     holding 'kds_config', through the station routes themselves: POST
//     /stations and PATCH /stations/:id answer 202 { pendingApproval, request }
//     for them. The CEO's own create / edit applies at once (routes.ts).
//     Deleting a station stays the CEO's.
//   • One row per request (StationChangeRequest, tenantId = the brand's
//     company). One pending request per station (409 STATION_CHANGE_PENDING).
//   • Approval type station_change (lib/approvalRights.ts): section ceo, the
//     CEO only, never handed over. Approve re-runs the station rules
//     (brand still live in that company; switch-off / brand move need an idle
//     station) and applies the change in the same transaction as the claim;
//     reject needs a note ≥10. The requester may cancel their own pending one.
//   • Company scope: reads are view-aware; a request of another company is 404.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma, UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY, MANAGERS } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { audit } from '../../lib/audit.js'
import { checkStationUpdate, createStationSchema, updateStationSchema } from './rules.js'

/** Who raises a station add / change for the CEO (owner C3): the F&B manager and the chef. */
export const STATION_REQUESTERS: UserRole[] = ['fnb_manager', 'boh_management'] as UserRole[]

type StationChanges = z.infer<typeof updateStationSchema>

/** Keep only the fields that really change (an update), or the whole create body. */
function changedFields(station: { name: string; displayOrder: number; isActive: boolean; conceptId: string } | null, body: StationChanges): StationChanges {
  if (!station) return body
  const out: StationChanges = {}
  if (body.name !== undefined && body.name !== station.name) out.name = body.name
  if (body.displayOrder !== undefined && body.displayOrder !== station.displayOrder) out.displayOrder = body.displayOrder
  if (body.isActive !== undefined && body.isActive !== station.isActive) out.isActive = body.isActive
  if (body.conceptId !== undefined && body.conceptId !== station.conceptId) out.conceptId = body.conceptId
  return out
}

/** Raise a request (the caller checked scope and the station rules). 409 when nothing changes or one is pending. */
export async function raiseStationChange(
  req: FastifyRequest,
  input: {
    kind: 'create' | 'update'
    conceptId: string
    station?: { id: string; name: string; displayOrder: number; isActive: boolean; conceptId: string } | null
    changes: StationChanges
  },
) {
  const concept = await prisma.concept.findFirst({ where: { id: input.conceptId, deletedAt: null }, select: { tenantId: true } })
  if (!concept?.tenantId) throw new NotFoundError('Concept', input.conceptId)
  const changes = changedFields(input.station ?? null, input.changes)
  if (Object.keys(changes).length === 0) throw new AppError('NOTHING_TO_CHANGE', 'That is how the station is already.', 409)
  let row
  try {
    row = await prisma.stationChangeRequest.create({
      data: {
        tenantId: concept.tenantId,
        conceptId: input.conceptId,
        stationId: input.station?.id ?? null,
        kind: input.kind,
        changes: changes as Prisma.InputJsonValue,
        requestedById: req.staffUser!.id,
      },
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new AppError('STATION_CHANGE_PENDING', 'A change to this station is already waiting for the CEO.', 409)
    }
    throw err
  }
  await audit({
    category: 'identity', action: 'station.change_requested', entity: 'StationChangeRequest', entityId: row.id,
    userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: row.tenantId,
    metadata: { kind: row.kind, stationId: row.stationId, conceptId: row.conceptId, changes, actorRole: req.staffUser!.role },
  })
  // The bell: the CEO is told (queued, after the commit).
  approvalWaiting('station_change', row.id, { round: row.requestedAt.toISOString(), actorId: req.staffUser!.id })
  return row
}

export async function stationChangeRoutes(fastify: FastifyInstance) {
  // GET /stations/requests?status=pending — the requests of the companies in
  // view (the approvals inbox reads this as the CEO), with brand, station and
  // requester names.
  fastify.get<{ Querystring: { status?: string } }>('/requests', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    const status = req.query.status && ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : undefined
    const rows = await prisma.stationChangeRequest.findMany({
      where: { ...scope, ...(status ? { status } : {}) },
      orderBy: { requestedAt: 'desc' },
      take: 200,
    })
    const conceptIds = [...new Set(rows.flatMap((r) => [r.conceptId, (r.changes as StationChanges).conceptId].filter((x): x is string => !!x)))]
    const stationIds = [...new Set(rows.map((r) => r.stationId).filter((x): x is string => !!x))]
    const userIds = [...new Set(rows.map((r) => r.requestedById))]
    const [concepts, stations, users] = await Promise.all([
      prisma.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, name: true } }),
      prisma.station.findMany({ where: { id: { in: stationIds } }, select: { id: true, name: true, displayOrder: true, isActive: true, conceptId: true } }),
      prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    ])
    const cName = new Map(concepts.map((c) => [c.id, c.name]))
    const st = new Map(stations.map((s) => [s.id, s]))
    const uName = new Map(users.map((u) => [u.id, u.name]))
    return {
      items: rows.map((r) => ({
        ...r,
        brandName: cName.get(r.conceptId) ?? null,
        moveToBrandName: (r.changes as StationChanges).conceptId ? cName.get((r.changes as StationChanges).conceptId!) ?? null : null,
        station: r.stationId ? st.get(r.stationId) ?? null : null,
        requestedByName: uName.get(r.requestedById) ?? null,
      })),
    }
  })

  async function forDecision(req: FastifyRequest, id: string) {
    const scope = await scopeTenantWhere(req, 'write')
    const r = await prisma.stationChangeRequest.findFirst({ where: { id, ...scope } })
    if (!r) throw new NotFoundError('Station change request', id)
    return r
  }

  async function grantFor(req: FastifyRequest, id: string) {
    const s = await approvalSubject('station_change', id)
    if (!s) throw new NotFoundError('Station change request', id)
    return assertCanApprove(req, approvalInputOf('station_change', id, s))
  }

  // POST /stations/requests/:id/approve — the CEO applies it (rules re-checked now).
  fastify.post<{ Params: { id: string } }>('/requests/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    if (r.status !== 'pending') throw new AppError('NOT_PENDING', 'This station change is no longer waiting for approval.', 409)
    const changes = r.changes as StationChanges

    // The station rules, as at the edit: the brand is still a live brand of the
    // request's company; an update's station is still live and idle when it is
    // switched off or moved.
    let stationId: string
    if (r.kind === 'create') {
      const create = createStationSchema.parse(changes)
      const brand = await prisma.concept.findFirst({ where: { id: create.conceptId, deletedAt: null, tenantId: r.tenantId }, select: { id: true } })
      if (!brand) throw new AppError('BRAND_NOT_IN_COMPANY', 'The brand of this station is gone or no longer in this company.', 422)
      stationId = await prisma.$transaction(async (tx) => {
        const claimed = await tx.stationChangeRequest.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'approved', decidedById: req.staffUser!.id, decidedAt: new Date(), decisionNote: body.note ?? null } })
        if (claimed.count === 0) throw new AppError('NOT_PENDING', 'This station change is no longer waiting for approval.', 409)
        const st = await tx.station.create({ data: { conceptId: create.conceptId, name: create.name, displayOrder: create.displayOrder } })
        await tx.stationChangeRequest.update({ where: { id: r.id }, data: { appliedStationId: st.id } })
        return st.id
      })
    } else {
      const owned = await prisma.station.findFirst({
        where: { id: r.stationId!, deletedAt: null, concept: { deletedAt: null, tenantId: r.tenantId } },
        select: { id: true, name: true, isActive: true, conceptId: true, displayOrder: true, concept: { select: { tenantId: true } } },
      })
      if (!owned) throw new AppError('STATION_GONE', 'This station was deleted or moved out of the company — reject the request.', 409)
      await checkStationUpdate(owned, changes)
      stationId = owned.id
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.stationChangeRequest.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'approved', decidedById: req.staffUser!.id, decidedAt: new Date(), decisionNote: body.note ?? null } })
        if (claimed.count === 0) throw new AppError('NOT_PENDING', 'This station change is no longer waiting for approval.', 409)
        await tx.station.update({ where: { id: owned.id }, data: changes })
        await tx.stationChangeRequest.update({ where: { id: r.id }, data: { appliedStationId: owned.id } })
      })
    }
    await auditApproval(req, {
      type: 'station_change', id: r.id, tenantId: r.tenantId, decision: 'approve', grant, entity: 'StationChangeRequest',
      metadata: { kind: r.kind, stationId, changes, note: body.note ?? null },
    })
    return { id: r.id, approved: true, stationId }
  })

  // POST /stations/requests/:id/reject {note ≥10} — the CEO turns it down; nothing changes.
  fastify.post<{ Params: { id: string } }>('/requests/:id/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500) }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    const claimed = await prisma.stationChangeRequest.updateMany({
      where: { id: r.id, status: 'pending' },
      data: { status: 'rejected', decidedById: req.staffUser!.id, decidedAt: new Date(), decisionNote: body.note },
    })
    if (claimed.count === 0) throw new AppError('NOT_PENDING', 'This station change is no longer waiting for approval.', 409)
    await auditApproval(req, {
      type: 'station_change', id: r.id, tenantId: r.tenantId, decision: 'reject', grant, entity: 'StationChangeRequest',
      metadata: { kind: r.kind, stationId: r.stationId, note: body.note },
    })
    return { id: r.id, rejected: true }
  })

  // POST /stations/requests/:id/cancel — the requester withdraws their own pending request.
  fastify.post<{ Params: { id: string } }>('/requests/:id/cancel', { preHandler: requireAuth(...STATION_REQUESTERS) }, async (req) => {
    const r = await forDecision(req, req.params.id)
    if (r.requestedById !== req.staffUser!.id) throw new ForbiddenError('Only the person who raised it may cancel it')
    const claimed = await prisma.stationChangeRequest.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'cancelled', decidedAt: new Date() } })
    if (claimed.count === 0) throw new AppError('NOT_PENDING', 'This station change is no longer waiting for approval.', 409)
    await audit({
      category: 'identity', action: 'station.change_cancelled', entity: 'StationChangeRequest', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId, metadata: { kind: r.kind, stationId: r.stationId },
    })
    return { id: r.id, cancelled: true }
  })
}
