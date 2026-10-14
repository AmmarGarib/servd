// Fixed-asset requests — the register's own queue (events.ts is the engine).
//
//   POST /accounting/fixed-assets/:id/requests          raise a request on an asset (FA_WRITERS)
//   POST /accounting/fixed-assets/:id/dispose           alias: a 'disposal' request (FA_WRITERS)
//   GET  /accounting/fixed-assets/requests              the queue — what the approvals inbox reads (READERS)
//   POST /accounting/fixed-assets/requests/:id/approve  the CEO applies it (events.applyEvent)
//   POST /accounting/fixed-assets/requests/:id/reject   the CEO rejects it with a note
//   POST /accounting/fixed-assets/requests/:id/cancel   the requester (or the CEO) withdraws it
//
// Owner (2026-10-13): disposals, scraps and write-downs — finance requests,
// the CEO (role admin) approves; the F&B manager does NOT. Approval kinds
// answer 202 (pending) for everyone but the CEO, whose own request applies at
// once (201). A transfer applies at once (201). Every row is resolved to its
// company first: another company's asset or request is 404; a brand or outlet
// of another company named in a transfer is 422. Audits carry the ROW's
// company. Smallwares pool requests and counts are in pools.routes.ts.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { FixedAssetEvent, UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { toCents, zMoneyCents } from '../../lib/money.js'
import {
  createRequest, applyEvent, rejectEvent, cancelEvent, needsApproval,
  FA_WRITER_ROLES, FA_APPROVER_ROLE, ALLOC_KINDS, REQUEST_KINDS, DISPOSAL_KINDS, type RequestKind,
} from './events.js'
import type { Db } from './classes.js'

const READERS = FINANCIALS_VIEWERS
const FA_WRITERS = [...FA_WRITER_ROLES] as UserRole[]
const APPROVER = ADMIN_ONLY as UserRole[]

/** The asset kinds a request on an asset may be (pool kinds go through /pools). */
export const ASSET_REQUEST_KINDS = ['disposal', 'impairment', 'change_estimate', 'void', 'undispose', 'transfer'] as const

export const REQUEST_KIND_LABELS: Record<string, string> = {
  capitalise: 'Capitalise from CapEx',
  disposal: 'Dispose (sale / scrap / lost / stolen)',
  undispose: 'Undo a disposal',
  impairment: 'Write down (impairment)',
  change_estimate: 'Change of life / salvage',
  void: 'Void (capitalised in error)',
  transfer: 'Move to another outlet / brand',
  pool_write_off: 'Write off smallwares units',
  pool_transfer: 'Move smallwares units',
  count: 'Smallwares count',
}

const MIN_REASON = 10

// ─── Shared helpers (routes.ts and pools.routes.ts use them too) ────────────

export interface Actor { id: string; email: string | null; role: string }

export function actorOf(req: FastifyRequest): Actor {
  return { id: req.staffUser!.id, email: req.staffUser!.email, role: req.staffUser!.role }
}

/** 'YYYY-MM-DD' → 12:00 PKT that day; an ISO instant as given. 422 EFFECTIVE_DATE otherwise. */
export function parseEffectiveDate(s: string | undefined): Date | undefined {
  if (s === undefined) return undefined
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00+05:00`) : new Date(s)
  if (Number.isNaN(d.getTime())) throw new AppError('EFFECTIVE_DATE', 'That date is not valid — use 2026-09-30', 422)
  return d
}

export const dateInput = z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])

/** An event for the screens / the approvals inbox: names, company and what the caller may do with it. */
export async function shapeEvents(db: Db, events: FixedAssetEvent[], who: { id: string; role: string }) {
  if (events.length === 0) return []
  const ids = <T>(f: (e: FixedAssetEvent) => T | null) => [...new Set(events.map(f).filter((x): x is T => x !== null))]
  const [assets, pools, lines, users, tenants] = await Promise.all([
    db.fixedAsset.findMany({ where: { id: { in: ids((e) => e.assetId) as string[] } }, select: { id: true, assetTag: true, name: true, category: true, status: true } }),
    db.fixedAssetPool.findMany({ where: { id: { in: ids((e) => e.poolId) as string[] } }, select: { id: true, label: true } }),
    db.capexLine.findMany({ where: { id: { in: ids((e) => e.capexLineId) as string[] } }, select: { id: true, item: true, project: { select: { id: true, name: true } } } }),
    db.user.findMany({ where: { id: { in: [...ids((e) => e.requestedById), ...ids((e) => e.decidedById)] as string[] } }, select: { id: true, name: true, email: true } }),
    db.tenant.findMany({ where: { id: { in: ids((e) => e.tenantId) as string[] } }, select: { id: true, name: true } }),
  ])
  const asset = new Map(assets.map((a) => [a.id, a]))
  const pool = new Map(pools.map((p) => [p.id, p]))
  const line = new Map(lines.map((l) => [l.id, l]))
  const user = new Map(users.map((u) => [u.id, u.name ?? u.email]))
  const company = new Map(tenants.map((t) => [t.id, t.name]))
  const isCeo = who.role === FA_APPROVER_ROLE
  return events.map((e) => {
    const a = e.assetId ? asset.get(e.assetId) : undefined
    const l = e.capexLineId ? line.get(e.capexLineId) : undefined
    const pending = e.status === 'pending'
    return {
      id: e.id,
      tenantId: e.tenantId,
      companyName: company.get(e.tenantId) ?? '',
      kind: e.kind,
      kindLabel: REQUEST_KIND_LABELS[e.kind] ?? e.kind,
      status: e.status,
      effectiveDate: e.effectiveDate,
      payload: e.payload,
      amountCents: toCents(e.amountCents),
      costOutCents: toCents(e.costOutCents),
      accumOutCents: toCents(e.accumOutCents),
      reason: e.reason,
      assetId: e.assetId,
      asset: a ? { id: a.id, assetTag: a.assetTag, name: a.name, classKey: a.category, status: a.status } : null,
      poolId: e.poolId,
      pool: e.poolId ? { id: e.poolId, label: pool.get(e.poolId)?.label ?? '' } : null,
      capexLineId: e.capexLineId,
      capexLine: l ? { id: l.id, item: l.item, projectId: l.project.id, projectName: l.project.name } : null,
      parentEventId: e.parentEventId,
      requestedById: e.requestedById,
      requestedByName: user.get(e.requestedById) ?? null,
      requestedAt: e.requestedAt,
      decidedById: e.decidedById,
      decidedByName: e.decidedById ? user.get(e.decidedById) ?? null : null,
      decidedAt: e.decidedAt,
      decisionNote: e.decisionNote,
      postedAt: e.postedAt,
      journalEntryId: e.journalEntryId,
      errorMessage: e.errorMessage,
      needsApproval: needsApproval(e.kind),
      // What the caller may do (the screens show buttons from these, never a local role list).
      canDecide: pending && isCeo,
      canCancel: pending && (isCeo || e.requestedById === who.id),
    }
  })
}

/** An event in the caller's companies ('write' scope) or 404. */
async function eventInScope(req: FastifyRequest, id: string): Promise<FixedAssetEvent> {
  const ev = await prisma.fixedAssetEvent.findFirst({ where: { id, ...(await scopeTenantWhere(req, 'write')) } })
  if (!ev) throw new NotFoundError('FixedAssetEvent', id)
  return ev
}

/**
 * Raise a request through the engine and answer the way the inbox expects:
 * 202 + status 'pending' while it waits for the CEO, 201 + 'posted' when it
 * was applied at once. Audited on the request's company.
 */
export async function raiseRequest(
  req: FastifyRequest,
  input: Parameters<typeof createRequest>[0],
): Promise<{ statusCode: 201 | 202; body: Record<string, unknown> }> {
  const actor = actorOf(req)
  const { event, applied } = await createRequest(input, { id: actor.id, role: actor.role })
  await audit({
    category: 'accounting',
    action: applied ? `fixed_asset.${event.kind}` : `fixed_asset.request.${event.kind}`,
    entity: 'FixedAssetEvent', entityId: event.id,
    userId: actor.id, userEmail: actor.email, tenantId: event.tenantId,
    after: { kind: event.kind, status: event.status, assetId: event.assetId, poolId: event.poolId, payload: event.payload, effectiveDate: event.effectiveDate },
  })
  const [shaped] = await shapeEvents(prisma, [event], actor)
  return { statusCode: applied ? 201 : 202, body: { event: shaped, applied, status: applied ? 'posted' : 'pending' } }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const requestBody = z.object({
  kind: z.enum(ASSET_REQUEST_KINDS),
  effectiveDate: dateInput.optional(),
  reason: z.string().max(1000).default(''),
  payload: z.record(z.unknown()).default({}),
})

export async function fixedAssetRequestRoutes(fastify: FastifyInstance) {
  // POST /:id/requests — raise a request on an individual asset (or a layer:
  // the engine sends layers to their pool).
  fastify.post<{ Params: { id: string } }>('/:id/requests', { preHandler: requireAuth(...FA_WRITERS) }, async (req, reply) => {
    const body = requestBody.parse(req.body)
    const asset = await prisma.fixedAsset.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) }, select: { id: true, tenantId: true } })
    if (!asset) throw new NotFoundError('FixedAsset', req.params.id)
    if (body.reason.trim().length < MIN_REASON) throw new AppError('REASON_REQUIRED', `Give a reason (at least ${MIN_REASON} characters)`, 422)
    const r = await raiseRequest(req, {
      kind: body.kind as RequestKind,
      assetId: asset.id,
      tenantId: asset.tenantId,
      effectiveDate: parseEffectiveDate(body.effectiveDate),
      reason: body.reason.trim(),
      payload: body.payload,
    })
    return reply.status(r.statusCode).send(r.body)
  })

  // POST /:id/dispose — the old direct disposal, now a disposal REQUEST
  // (202 pending for finance, 201 applied for the CEO).
  fastify.post<{ Params: { id: string } }>('/:id/dispose', { preHandler: requireAuth(...FA_WRITERS) }, async (req, reply) => {
    const body = z.object({
      disposedAt: dateInput,
      kind: z.enum(DISPOSAL_KINDS).optional(),
      proceedsCents: zMoneyCents('The disposal proceeds').default(0),
      method: z.enum(['bank', 'bank_transfer', 'cheque', 'online', 'cash']).optional(),
      bankAccountId: z.string().min(1).max(64).nullable().optional(),
      reason: z.string().max(1000).optional(),
    }).parse(req.body)
    const asset = await prisma.fixedAsset.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) }, select: { id: true, tenantId: true } })
    if (!asset) throw new NotFoundError('FixedAsset', req.params.id)
    const reason = (body.reason ?? '').trim()
    const r = await raiseRequest(req, {
      kind: 'disposal',
      assetId: asset.id,
      tenantId: asset.tenantId,
      effectiveDate: parseEffectiveDate(body.disposedAt),
      reason: reason.length >= MIN_REASON ? reason : 'Disposal raised from the register',
      payload: {
        kind: body.kind ?? (body.proceedsCents > 0 ? 'sale' : 'scrap'),
        proceedsCents: body.proceedsCents,
        ...(body.method ? { method: body.method } : {}),
        ...(body.bankAccountId !== undefined ? { bankAccountId: body.bankAccountId } : {}),
      },
    })
    return reply.status(r.statusCode).send(r.body)
  })

  // GET /requests?status&kind&assetId&poolId — the module's queue (the
  // approvals inbox provider reads ?status=pending). Allocation rows of a pool
  // write-off / transfer are history, not requests: never listed here.
  fastify.get('/requests', { preHandler: requireAuth(...READERS) }, async (req) => {
    const q = z.object({
      status: z.string().max(80).optional(),
      kind: z.string().max(200).optional(),
      assetId: z.string().max(64).optional(),
      poolId: z.string().max(64).optional(),
      capexLineId: z.string().max(64).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query)
    const statuses = q.status && q.status !== 'all' ? q.status.split(',').map((s) => s.trim()).filter(Boolean) : null
    const kinds = q.kind ? q.kind.split(',').map((s) => s.trim()).filter((k) => (REQUEST_KINDS as readonly string[]).includes(k)) : null
    const rows = await prisma.fixedAssetEvent.findMany({
      where: {
        ...(await scopeTenantWhere(req, 'read')),
        kind: kinds ? { in: kinds } : { notIn: [...ALLOC_KINDS] },
        ...(statuses ? { status: { in: statuses } } : {}),
        ...(q.assetId ? { assetId: q.assetId } : {}),
        ...(q.poolId ? { poolId: q.poolId } : {}),
        ...(q.capexLineId ? { capexLineId: q.capexLineId } : {}),
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
      take: q.limit,
    })
    const requests = await shapeEvents(prisma, rows, actorOf(req))
    return { requests, pendingCount: requests.filter((r) => r.status === 'pending').length }
  })

  // POST /requests/:id/approve — the CEO. Applied in one transaction; a
  // refusal leaves it pending with the reason kept on the request.
  fastify.post<{ Params: { id: string } }>('/requests/:id/approve', { preHandler: requireAuth(...APPROVER) }, async (req) => {
    const ev = await eventInScope(req, req.params.id)
    const actor = actorOf(req)
    const done = await applyEvent(ev.id, actor.id)
    await audit({
      category: 'accounting', action: `fixed_asset.request.approve`, entity: 'FixedAssetEvent', entityId: done.id,
      userId: actor.id, userEmail: actor.email, tenantId: done.tenantId,
      before: { status: ev.status }, after: { kind: done.kind, status: done.status, journalEntryId: done.journalEntryId, payload: done.payload },
    })
    const [shaped] = await shapeEvents(prisma, [done], actor)
    return { event: shaped, applied: true, status: 'posted' }
  })

  // POST /requests/:id/reject { note } — the CEO, with a note (422 NOTE_REQUIRED).
  fastify.post<{ Params: { id: string } }>('/requests/:id/reject', { preHandler: requireAuth(...APPROVER) }, async (req) => {
    const body = z.object({ note: z.string().max(1000).optional() }).parse(req.body ?? {})
    const ev = await eventInScope(req, req.params.id)
    const actor = actorOf(req)
    const done = await rejectEvent(ev.id, actor.id, body.note ?? '')
    await audit({
      category: 'accounting', action: 'fixed_asset.request.reject', entity: 'FixedAssetEvent', entityId: done.id,
      userId: actor.id, userEmail: actor.email, tenantId: done.tenantId,
      before: { status: ev.status }, after: { status: done.status, decisionNote: done.decisionNote },
    })
    const [shaped] = await shapeEvents(prisma, [done], actor)
    return { event: shaped, status: 'rejected' }
  })

  // POST /requests/:id/cancel — whoever raised it, or the CEO.
  fastify.post<{ Params: { id: string } }>('/requests/:id/cancel', { preHandler: requireAuth(...FA_WRITERS) }, async (req) => {
    const ev = await eventInScope(req, req.params.id)
    const actor = actorOf(req)
    const done = await cancelEvent(ev.id, actor.id)
    await audit({
      category: 'accounting', action: 'fixed_asset.request.cancel', entity: 'FixedAssetEvent', entityId: done.id,
      userId: actor.id, userEmail: actor.email, tenantId: done.tenantId,
      before: { status: ev.status }, after: { status: done.status },
    })
    const [shaped] = await shapeEvents(prisma, [done], actor)
    return { event: shaped, status: 'cancelled' }
  })
}
