// Changes to servd's Ingredients sheet wait for the CEO (owner, 2026-11-17: "remove the 'needs review' … changes in
// this sheet need to be approved by me"). Contract:
//
//   • Who asks: anyone who may edit the sheet today (recipe editors on PATCH /ingredient-master/:id, the buyer and up on
//     PUT /:id/price and PUT /:id/group). Their edit answers 202 { pendingApproval, request } and NOTHING changes. The
//     CEO's own edit applies at once. Filling a blank applies at once too: an ingredient's FIRST price, and putting an
//     ungrouped ingredient in a group (a new ingredient is priced / grouped as it is added from a recipe or a PO).
//     Adding a new ingredient is not a change of the sheet and stays at once. Deleting and merging are the CEO's only.
//   • One pending request per ingredient (IngredientMasterChangeRequest, servd-wide like the master — no tenantId,
//     deliberately). The same person's further edits add to it; someone else's edit while it waits is 409
//     CHANGE_PENDING. An edit back to the current value drops that field from the request.
//   • Approval type ingredient_change (lib/approvalRights.ts): section ceo, the CEO only, never handed over, no
//     company. Approve applies it through the sheet's own engines (routes.ts applyMasterPatch / applyMasterGroup /
//     applyMasterPrice) with the CEO as the actor — every check re-runs now (unit in use, category reclass, name taken,
//     group fits); a refusal leaves the request pending with the reason. Reject needs a note ≥10. The requester may
//     withdraw their own (POST /requests/:id/cancel).
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { audit } from '../../lib/audit.js'
import { normalizeUnit } from '../../lib/units.js'
import { displayUnitOf, masterPricesMany } from '../../lib/ingredientPrices.js'
import { costsHiddenFor } from '../inventory/routes.js'
import {
  applyMasterGroup, applyMasterPatch, applyMasterPrice, assertGroupFits, loadLive, patchSchema, type MasterDb,
} from './routes.js'

type Patch = z.infer<typeof patchSchema>
export interface ChangeSet {
  patch?: Patch
  price?: { perBaseCents: number; priceCents: number; displayUnit: string }
  group?: { groupId: string | null }
}
export interface PendingChange {
  id: string
  requestedById: string
  requestedByName: string | null
  requestedAt: Date
  changes: Array<{ field: string; label: string; from: string; to: string }>
}

const LABEL: Record<string, string> = {
  name: 'Name', unit: 'Unit', category: 'Category', allergens: 'Allergens', yieldPct: 'Yield %', purchaseUnit: 'Bought by',
  purchaseUnitFactor: 'Stock units in one buying unit', spec: 'Spec', specFields: 'Spec details', perishable: 'Perishable',
  shelfLifeDays: 'Shelf life (days)', pieceGrams: 'One piece weighs', pieceLabel: 'A piece is called',
}

/** The value of a patch field as the master holds it now (for "changed?" and "from → to"). */
function currentOf(m: MasterDb, k: string): unknown {
  if (k === 'unit') return normalizeUnit(displayUnitOf(m.stockUnit, m.priceUnit).unit) ?? displayUnitOf(m.stockUnit, m.priceUnit).unit
  if (k === 'spec' || k === 'purchaseUnit' || k === 'pieceLabel') return ((m as Record<string, unknown>)[k] as string | null)?.trim() || null
  return (m as Record<string, unknown>)[k] ?? null
}
function asked(k: string, v: unknown): unknown {
  if (k === 'unit') return normalizeUnit(String(v)) ?? v
  if (k === 'spec' || k === 'purchaseUnit' || k === 'pieceLabel' || k === 'name') return typeof v === 'string' ? v.trim() || null : v ?? null
  return v ?? null
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The fields of a sheet edit that really change the ingredient (marking reviewed is retired — dropped). */
export function changedPatchFields(m: MasterDb, body: Patch): { changed: Patch; unchanged: string[] } {
  const changed: Record<string, unknown> = {}
  const unchanged: string[] = []
  for (const [k, v] of Object.entries(body)) {
    if (k === 'status' || v === undefined) continue
    if (same(asked(k, v), currentOf(m, k))) unchanged.push(k)
    else changed[k] = v
  }
  return { changed: changed as Patch, unchanged }
}

const text = (v: unknown): string => {
  if (v == null || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—'
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([a, b]) => `${a}: ${b}`).join('; ') || '—'
  return String(v).replace(/_/g, ' ')
}
const pkr = (cents: number | null | undefined, unit: string) => (cents == null ? '—' : `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: Math.abs(cents) < 100 ? 4 : 2 })} / ${unit}`)

/** "from → to" lines of a request, against the ingredient as it is now. */
async function describe(m: MasterDb, c: ChangeSet, opts: { hidePrices: boolean; latestPerBase?: number | null; groupNames: Map<string, string> }) {
  const out: PendingChange['changes'] = []
  for (const [k, v] of Object.entries(c.patch ?? {})) {
    if (v === undefined) continue
    out.push({ field: k, label: LABEL[k] ?? k, from: text(currentOf(m, k)), to: text(asked(k, v)) })
  }
  if (c.group) {
    out.push({ field: 'group', label: 'Group', from: m.groupId ? opts.groupNames.get(m.groupId) ?? '—' : 'No group', to: c.group.groupId ? opts.groupNames.get(c.group.groupId) ?? '—' : 'No group' })
  }
  if (c.price && !opts.hidePrices) {
    const d = displayUnitOf(m.stockUnit, m.priceUnit)
    const now = opts.latestPerBase != null ? Math.round(opts.latestPerBase * d.baseUnits * 100) / 100 : null
    out.push({ field: 'price', label: 'Price', from: pkr(now, d.unit), to: pkr(Math.round(c.price.perBaseCents * d.baseUnits * 100) / 100, d.unit) })
  }
  return out
}

/** The pending request of each ingredient, described against today's values (the sheet's "waiting for the CEO"). */
export async function pendingChangesOf(masterIds: string[], opts: { hidePrices: boolean }): Promise<Map<string, PendingChange>> {
  if (masterIds.length === 0) return new Map()
  const rows = await prisma.ingredientMasterChangeRequest.findMany({ where: { masterIngredientId: { in: masterIds }, status: 'pending' } })
  return describeRows(rows, opts)
}

async function describeRows(
  rows: Array<{ id: string; masterIngredientId: string; changes: Prisma.JsonValue; requestedById: string; requestedAt: Date }>, opts: { hidePrices: boolean },
): Promise<Map<string, PendingChange>> {
  if (rows.length === 0) return new Map()
  const masterIds = [...new Set(rows.map((r) => r.masterIngredientId))]
  const sets = rows.map((r) => r.changes as ChangeSet)
  const groupIds = [...new Set(sets.flatMap((c) => (c.group?.groupId ? [c.group.groupId] : [])))]
  const [masters, users, prices] = await Promise.all([
    prisma.ingredientMaster.findMany({ where: { id: { in: masterIds } } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.requestedById))] } }, select: { id: true, name: true } }),
    opts.hidePrices ? Promise.resolve(new Map()) : masterPricesMany(masterIds),
  ])
  const groupRows = await prisma.ingredientGroup.findMany({ where: { id: { in: [...groupIds, ...masters.map((m) => m.groupId).filter((x): x is string => !!x)] } }, select: { id: true, name: true } })
  const groupNames = new Map(groupRows.map((g) => [g.id, g.name]))
  const mById = new Map(masters.map((m) => [m.id, m]))
  const uName = new Map(users.map((u) => [u.id, u.name]))
  // Keyed by ingredient (one pending request each).
  const out = new Map<string, PendingChange>()
  for (const r of rows) {
    const m = mById.get(r.masterIngredientId)
    if (!m) continue
    out.set(r.masterIngredientId, {
      id: r.id, requestedById: r.requestedById, requestedByName: uName.get(r.requestedById) ?? null, requestedAt: r.requestedAt,
      changes: await describe(m, r.changes as ChangeSet, { hidePrices: opts.hidePrices, latestPerBase: prices.get(m.id)?.latestPerBase ?? null, groupNames }),
    })
  }
  return out
}

/**
 * Add a sheet edit to the ingredient's pending request (or open one). Fields edited back to today's value leave it;
 * an empty request is withdrawn. 409 CHANGE_PENDING while someone else's waits; 409 NOTHING_TO_CHANGE.
 */
export async function raiseIngredientChange(
  req: FastifyRequest, m: MasterDb, part: { patch?: { changed: Patch; unchanged: string[] }; price?: ChangeSet['price']; group?: ChangeSet['group'] },
) {
  const me = req.staffUser!.id
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'ingredient_change:' + m.id}))`
    const open = await tx.ingredientMasterChangeRequest.findFirst({ where: { masterIngredientId: m.id, status: 'pending' } })
    if (open && open.requestedById !== me) {
      const who = await tx.user.findUnique({ where: { id: open.requestedById }, select: { name: true } })
      throw new AppError('CHANGE_PENDING', `${who?.name ?? 'Someone'}'s change to ${m.name} is already waiting for the CEO — it must be decided first.`, 409)
    }
    const prev = (open?.changes ?? {}) as ChangeSet
    const patch: Record<string, unknown> = { ...(prev.patch ?? {}) }
    for (const k of part.patch?.unchanged ?? []) delete patch[k]
    Object.assign(patch, part.patch?.changed ?? {})
    const next: ChangeSet = {
      ...(Object.keys(patch).length ? { patch: patch as Patch } : {}),
      ...(part.group !== undefined ? (part.group.groupId === m.groupId ? {} : { group: part.group }) : prev.group ? { group: prev.group } : {}),
      ...(part.price ?? prev.price ? { price: part.price ?? prev.price } : {}),
    }
    const empty = !next.patch && !next.group && !next.price
    if (!open) {
      if (empty) throw new AppError('NOTHING_TO_CHANGE', 'That is how the ingredient is already.', 409)
      const row = await tx.ingredientMasterChangeRequest.create({ data: { masterIngredientId: m.id, changes: next as Prisma.InputJsonValue, requestedById: me } })
      return { row, created: true, withdrawn: false }
    }
    if (empty) {
      const row = await tx.ingredientMasterChangeRequest.update({ where: { id: open.id }, data: { status: 'cancelled', decidedAt: new Date(), changes: next as Prisma.InputJsonValue } })
      return { row, created: false, withdrawn: true }
    }
    const row = await tx.ingredientMasterChangeRequest.update({ where: { id: open.id }, data: { changes: next as Prisma.InputJsonValue } })
    return { row, created: false, withdrawn: false }
  })
  await audit({
    category: 'identity', action: result.withdrawn ? 'ingredient_master.change_cancelled' : 'ingredient_master.change_requested',
    entity: 'IngredientMasterChangeRequest', entityId: result.row.id,
    userId: me, userEmail: req.staffUser!.email ?? null, tenantId: null,
    metadata: { masterIngredientId: m.id, name: m.name, changes: result.row.changes, actorRole: req.staffUser!.role },
  })
  // The bell: the CEO is told once per request (queued, after the commit).
  if (result.created) approvalWaiting('ingredient_change', result.row.id, { round: result.row.requestedAt.toISOString(), actorId: me })
  const described = result.withdrawn ? null : (await describeRows([result.row], { hidePrices: costsHiddenFor(req) })).get(m.id) ?? null
  return { id: result.row.id, status: result.row.status, ingredientId: m.id, ingredient: m.name, changes: described?.changes ?? [] }
}

export async function ingredientChangeRoutes(fastify: FastifyInstance, opts: { readers: RouteShorthandOptions }) {
  // GET /ingredient-master/requests?status=pending — the sheet's changes (the approvals inbox reads it as the CEO).
  fastify.get<{ Querystring: { status?: string } }>('/requests', opts.readers, async (req) => {
    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status ?? '') ? req.query.status! : 'pending'
    const rows = await prisma.ingredientMasterChangeRequest.findMany({ where: { status }, orderBy: { requestedAt: 'desc' }, take: 200 })
    const hidePrices = costsHiddenFor(req)
    const byMaster = status === 'pending' ? await describeRows(rows, { hidePrices }) : new Map<string, PendingChange>()
    const names = new Map((await prisma.ingredientMaster.findMany({ where: { id: { in: rows.map((r) => r.masterIngredientId) } }, select: { id: true, name: true } })).map((m) => [m.id, m.name]))
    return {
      items: rows.map((r) => ({
        id: r.id, status: r.status, ingredientId: r.masterIngredientId, ingredient: names.get(r.masterIngredientId) ?? null,
        requestedById: r.requestedById, requestedAt: r.requestedAt, decidedAt: r.decidedAt, decisionNote: r.decisionNote,
        requestedByName: byMaster.get(r.masterIngredientId)?.requestedByName ?? null,
        changes: byMaster.get(r.masterIngredientId)?.changes ?? [],
      })),
    }
  })

  async function pendingOf(id: string) {
    const r = await prisma.ingredientMasterChangeRequest.findUnique({ where: { id } })
    if (!r) throw new NotFoundError('Ingredient change', id)
    return r
  }
  async function grantFor(req: FastifyRequest, id: string) {
    const s = await approvalSubject('ingredient_change', id)
    if (!s) throw new NotFoundError('Ingredient change', id)
    return assertCanApprove(req, approvalInputOf('ingredient_change', id, s, { ceoOnly: true }))
  }
  const notPending = () => new AppError('NOT_PENDING', 'This change is no longer waiting for approval.', 409)

  // POST /requests/:id/approve — the CEO applies it now through the sheet's own engines (every check re-runs).
  fastify.post<{ Params: { id: string } }>('/requests/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {})
    const r = await pendingOf(req.params.id)
    const grant = await grantFor(req, r.id)
    const claimed = await prisma.ingredientMasterChangeRequest.updateMany({
      where: { id: r.id, status: 'pending' }, data: { status: 'approved', decidedById: req.staffUser!.id, decidedAt: new Date(), decisionNote: body.note ?? null },
    })
    if (claimed.count === 0) throw notPending()
    const c = r.changes as ChangeSet
    const by = { id: r.requestedById, requestId: r.id }
    try {
      let m = await loadLive(r.masterIngredientId)
      if (m.mergedIntoId) throw new AppError('MASTER_MERGED', `${m.name} was merged into another ingredient — reject this change`, 409)
      // The definition first (its checks are the likeliest to refuse), then the group (it must fit the category as it
      // is now), then the price.
      if (c.patch && Object.keys(c.patch).length) m = await applyMasterPatch(req, m.id, patchSchema.parse(c.patch), by)
      if (c.group) {
        const g = c.group.groupId ? await assertGroupFits(c.group.groupId, m.category) : null
        m = await applyMasterGroup(req, m, c.group.groupId, g, by)
      }
      if (c.price) await applyMasterPrice(req, m, c.price, r.requestedById, by)
    } catch (err) {
      // Refused now: the request waits again (whatever already applied stays — applying it again changes nothing).
      await prisma.ingredientMasterChangeRequest.update({ where: { id: r.id }, data: { status: 'pending', decidedById: null, decidedAt: null, decisionNote: null } })
      throw err
    }
    await auditApproval(req, {
      type: 'ingredient_change', id: r.id, tenantId: null, decision: 'approve', grant, entity: 'IngredientMasterChangeRequest',
      metadata: { masterIngredientId: r.masterIngredientId, changes: c, note: body.note ?? null },
    })
    return { id: r.id, approved: true, ingredientId: r.masterIngredientId }
  })

  // POST /requests/:id/reject {note ≥10} — nothing changes.
  fastify.post<{ Params: { id: string } }>('/requests/:id/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500) }).parse(req.body ?? {})
    const r = await pendingOf(req.params.id)
    const grant = await grantFor(req, r.id)
    const claimed = await prisma.ingredientMasterChangeRequest.updateMany({
      where: { id: r.id, status: 'pending' }, data: { status: 'rejected', decidedById: req.staffUser!.id, decidedAt: new Date(), decisionNote: body.note },
    })
    if (claimed.count === 0) throw notPending()
    await auditApproval(req, {
      type: 'ingredient_change', id: r.id, tenantId: null, decision: 'reject', grant, entity: 'IngredientMasterChangeRequest',
      metadata: { masterIngredientId: r.masterIngredientId, note: body.note },
    })
    return { id: r.id, rejected: true }
  })

  // POST /requests/:id/cancel — the requester withdraws their own.
  fastify.post<{ Params: { id: string } }>('/requests/:id/cancel', opts.readers, async (req) => {
    const r = await pendingOf(req.params.id)
    if (r.requestedById !== req.staffUser!.id) throw new ForbiddenError('Only the person who asked for it may withdraw it')
    const claimed = await prisma.ingredientMasterChangeRequest.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'cancelled', decidedAt: new Date() } })
    if (claimed.count === 0) throw notPending()
    await audit({
      category: 'identity', action: 'ingredient_master.change_cancelled', entity: 'IngredientMasterChangeRequest', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: null, metadata: { masterIngredientId: r.masterIngredientId },
    })
    return { id: r.id, cancelled: true }
  })
}
