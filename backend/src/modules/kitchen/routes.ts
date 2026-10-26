// Operations → kitchen flow (owner, 2026-10-26): "master data → recipe → prep list → spec list → procurement →
// inventory → par level set → sales → deduction basis plate recipe." Every number here comes from ONE engine,
// modules/kitchen/prepPlan.ts (buildPrepPlan); this file is the routes over it. Company separation: an outlet is
// resolved to ITS company first (another company's outlet is 404); everything is that company's.
//
//   GET  /kitchen/prep-list?locationId&date        the prep list (replaces /ops/prep-list and the par sheet's list)
//   GET  /kitchen/par-board?locationId&date        per prep: target, on hand, made today, still to prep — portions
//   GET  /kitchen/par-targets?locationId           the daily par per weekday + the forecast's suggestion
//   PUT  /kitchen/par-targets                      set the par (kitchen managers)            — ParTarget
//   GET  /kitchen/shopping-list?locationId&date&days  raw stock the prep list + dishes need, − on hand − on order, by
//                                                  supplier, with each item's spec (procurement's ONE suggester)
//   POST /kitchen/shopping-list/draft-pos          draft POs from it through procurement's own createPo
//   GET  /kitchen/spec-list?format=                every ingredient the company buys with its spec, by supplier
// Readers: any staff holding the kitchen / stock modules (par_sheet, inventory, ops, recipes, procurement); money
// (unit costs) only for roles that see costs.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS, PROCUREMENT_TEAM } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, resolveTenantScope, type ScopeMode } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { toPurchaseUnits } from '../../lib/recipeCost.js'
import { portionSizeOf } from '../../lib/portions.js'
import { exportFormatOf, sendReportFor } from '../../lib/reportExport.js'
import { costsHiddenFor } from '../inventory/routes.js'
import { buildPrepPlan } from './prepPlan.js'
import { subRecipeIdsForCompany } from '../par-sheet/routes.js'
import { createPo, reorderSuggestions } from '../procurement/service.js'

/** Who sets the daily par: the kitchen managers (the recipe editors). */
export const PAR_SETTERS = MANAGERS as UserRole[]
// The prep list's old gate (ops, inventory, par_sheet) — the kitchen's modules.
const KITCHEN_READ = ['par_sheet', 'inventory', 'ops'] as const
const PKT_MS = 5 * 3_600_000

/** Today's Karachi date (YYYY-MM-DD). */
function pktToday(): string {
  return new Date(Date.now() + PKT_MS).toISOString().slice(0, 10)
}
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10)
}
/** The UTC instants of a Karachi day. */
function pktDayBounds(date: string): { from: Date; to: Date } {
  const [y, m, d] = date.split('-').map(Number)
  const from = new Date(Date.UTC(y!, m! - 1, d!) - PKT_MS)
  return { from, to: new Date(from.getTime() + 86_400_000) }
}

/** The outlet, in the caller's scope (404 otherwise), with its company. */
async function outletOf(req: FastifyRequest, locationId: string | undefined, mode: ScopeMode = 'read'): Promise<{ id: string; name: string; tenantId: string }> {
  if (!locationId) throw new AppError('LOCATION_REQUIRED', 'Pick the outlet', 400)
  const loc = await prisma.location.findFirst({
    where: { id: locationId, deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
    select: { id: true, name: true, tenantId: true },
  })
  if (!loc?.tenantId) throw new NotFoundError('Location', locationId)
  return { id: loc.id, name: loc.name, tenantId: loc.tenantId }
}

/** What the prep list and the forecast dishes need of raw stock over `days` days from `date` (stock units). */
async function shoppingDemand(tenantId: string, locationId: string, date: string, days: number): Promise<{ demand: Map<string, number>; notStocked: Array<{ masterIngredientId: string | null; name: string; unit: string; qty: number }> }> {
  const demand = new Map<string, number>()
  const missing = new Map<string, { masterIngredientId: string | null; name: string; unit: string; qty: number }>()
  for (let i = 0; i < days; i++) {
    const plan = await buildPrepPlan({ tenantId, locationId, date: addDays(date, i) })
    for (const r of [...plan.rawForPrep, ...plan.directRaw]) demand.set(r.inventoryItemId, (demand.get(r.inventoryItemId) ?? 0) + r.qty)
    // Needed but never stocked by this company: listed ("Not stocked yet — create"), never dropped, never ordered.
    for (const n of plan.notStocked) {
      const k = n.masterIngredientId ?? n.name
      const cur = missing.get(k)
      missing.set(k, cur ? { ...cur, qty: Math.round((cur.qty + n.qty) * 1000) / 1000 } : { ...n })
    }
  }
  // Consumables issued on receipt (oil, salt) are never counted — they are bought by par, not by recipe.
  if (demand.size > 0) {
    const ior = await prisma.inventoryItem.findMany({ where: { id: { in: [...demand.keys()] }, issueOnReceipt: true }, select: { id: true } })
    for (const i of ior) demand.delete(i.id)
  }
  return { demand, notStocked: [...missing.values()] }
}

const listQuery = z.object({ locationId: z.string().min(1), date: dateSchema.optional() })

export async function kitchenRoutes(fastify: FastifyInstance) {
  const readers = { preHandler: [requireAuth(...ALL_STAFF), requireModule(...KITCHEN_READ)] }

  // ── The prep list ─────────────────────────────────────────────────────────
  fastify.get('/prep-list', readers, async (req) => {
    const q = listQuery.parse(req.query)
    const outlet = await outletOf(req, q.locationId)
    const plan = await buildPrepPlan({ tenantId: outlet.tenantId, locationId: outlet.id, date: q.date ?? pktToday() })
    return { outlet: { id: outlet.id, name: outlet.name }, ...plan }
  })

  // ── The par board: target, on hand (counts down as sales deduct), made today, still to prep — in portions ──
  fastify.get('/par-board', readers, async (req) => {
    const q = listQuery.parse(req.query)
    const outlet = await outletOf(req, q.locationId)
    const date = q.date ?? pktToday()
    const plan = await buildPrepPlan({ tenantId: outlet.tenantId, locationId: outlet.id, date })
    const { from, to } = pktDayBounds(date)
    const batches = await prisma.prepBatch.findMany({
      where: { tenantId: outlet.tenantId, locationId: outlet.id, recipeId: { in: plan.components.map((c) => c.recipeId) }, createdAt: { gte: from, lt: to } },
      select: { recipeId: true, actualYieldQty: true, unit: true, createdAt: true },
    })
    const madeQty = new Map<string, number>()
    const lastAt = new Map<string, Date>()
    for (const b of batches) {
      const c = plan.components.find((x) => x.recipeId === b.recipeId)!
      const q2 = toPurchaseUnits(b.actualYieldQty, b.unit, c.unit) ?? 0
      madeQty.set(b.recipeId!, (madeQty.get(b.recipeId!) ?? 0) + q2)
      if (!lastAt.has(b.recipeId!) || lastAt.get(b.recipeId!)! < b.createdAt) lastAt.set(b.recipeId!, b.createdAt)
    }
    return {
      outlet: { id: outlet.id, name: outlet.name }, date, weekday: plan.weekday,
      rows: plan.components.map((c) => {
        const made = madeQty.get(c.recipeId) ?? 0
        return {
          recipeId: c.recipeId, name: c.name, unit: c.unit, portionLabel: c.portionLabel, portionSize: c.portionSize,
          targetPortions: c.targetPortions, parPortions: c.parPortions, needPortions: c.needPortions,
          onHandPortions: c.onHandPortions, madeTodayPortions: c.portionSize ? Math.round((made / c.portionSize) * 10) / 10 : null,
          stillToPrepPortions: c.toPrepPortions,
          targetQty: c.targetQty, onHandQty: c.onHandQty, madeTodayQty: Math.round(made * 1000) / 1000, stillToPrepQty: c.toPrepQty,
          batchesMadeToday: batches.filter((b) => b.recipeId === c.recipeId).length, lastBatchAt: lastAt.get(c.recipeId) ?? null,
        }
      }),
    }
  })

  // ── Daily par per outlet ──────────────────────────────────────────────────
  fastify.get('/par-targets', readers, async (req) => {
    const { locationId } = z.object({ locationId: z.string().min(1) }).parse(req.query)
    const outlet = await outletOf(req, locationId)
    const ids = [...(await subRecipeIdsForCompany(outlet.tenantId))]
    const recipes = await prisma.recipe.findMany({
      where: { id: { in: ids }, kind: 'component', isActive: true },
      select: { id: true, name: true, yieldUnit: true, yieldGrams: true, portionsPerBatch: true, portionLabel: true },
      orderBy: { name: 'asc' },
    })
    const targets = await prisma.parTarget.findMany({ where: { tenantId: outlet.tenantId, locationId: outlet.id }, select: { recipeId: true, weekday: true, portions: true } })
    // The forecast's suggestion: the portions the next 7 days' dishes need, per weekday.
    const suggested = new Map<string, Array<number | null>>()
    const today = pktToday()
    for (let i = 0; i < 7; i++) {
      const plan = await buildPrepPlan({ tenantId: outlet.tenantId, locationId: outlet.id, date: addDays(today, i) })
      for (const c of plan.components) {
        const row = suggested.get(c.recipeId) ?? [null, null, null, null, null, null, null]
        row[plan.weekday] = c.needPortions != null ? Math.ceil(c.needPortions) : null
        suggested.set(c.recipeId, row)
      }
    }
    return {
      outlet: { id: outlet.id, name: outlet.name },
      rows: recipes.map((r) => {
        const week: Array<number | null> = [null, null, null, null, null, null, null]
        for (const t of targets) if (t.recipeId === r.id) week[t.weekday] = t.portions
        return {
          recipeId: r.id, name: r.name ?? '—', unit: r.yieldUnit, portionLabel: r.portionLabel,
          portionSize: portionSizeOf(r), portionsPerBatch: r.portionsPerBatch,
          targets: week, suggested: suggested.get(r.id) ?? [null, null, null, null, null, null, null],
        }
      }),
    }
  })

  fastify.put('/par-targets', { preHandler: [requireAuth(...PAR_SETTERS), requireModule(...KITCHEN_READ)] }, async (req) => {
    const body = z.object({
      locationId: z.string().min(1),
      targets: z.array(z.object({
        recipeId: z.string().min(1),
        weekday: z.number().int().min(0).max(6),
        portions: z.number().min(0).max(1_000_000).nullable(),
      })).min(1).max(7 * 200),
    }).parse(req.body)
    // Editing a company's par: any company the manager belongs to; another company's outlet is 404.
    const outlet = await outletOf(req, body.locationId, 'write')
    const allowed = await subRecipeIdsForCompany(outlet.tenantId)
    for (const t of body.targets) {
      if (!allowed.has(t.recipeId)) throw new AppError('RECIPE_NOT_IN_COMPANY', 'That prep is not one of this outlet\'s company\'s', 422)
    }
    await prisma.$transaction(async (tx) => {
      for (const t of body.targets) {
        const key = { tenantId_locationId_recipeId_weekday: { tenantId: outlet.tenantId, locationId: outlet.id, recipeId: t.recipeId, weekday: t.weekday } }
        if (t.portions == null) await tx.parTarget.deleteMany({ where: key.tenantId_locationId_recipeId_weekday })
        else {
          await tx.parTarget.upsert({
            where: key,
            create: { ...key.tenantId_locationId_recipeId_weekday, portions: t.portions, updatedById: req.staffUser!.id },
            update: { portions: t.portions, updatedById: req.staffUser!.id },
          })
        }
      }
    })
    await audit({
      category: 'identity', action: 'kitchen.par_targets', entity: 'Location', entityId: outlet.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: outlet.tenantId,
      after: { targets: body.targets },
    })
    return { ok: true, saved: body.targets.length }
  })

  // ── The shopping list (raw stock to buy, by supplier, with specs) ─────────
  const shoppingQuery = listQuery.extend({ days: z.coerce.number().int().min(1).max(7).optional() })
  fastify.get('/shopping-list', { preHandler: [requireAuth(...ALL_STAFF), requireModule('procurement', 'inventory', 'par_sheet')] }, async (req) => {
    const q = shoppingQuery.parse(req.query)
    const outlet = await outletOf(req, q.locationId)
    const date = q.date ?? pktToday()
    const days = q.days ?? 1
    const { demand, notStocked } = await shoppingDemand(outlet.tenantId, outlet.id, date, days)
    const groups = await reorderSuggestions([outlet.tenantId], { demand, locationId: outlet.id })
    const hide = costsHiddenFor(req)
    return {
      outlet: { id: outlet.id, name: outlet.name }, date, days,
      groups: hide
        ? groups.map((g) => ({ ...g, estimatedTotalCents: null, lines: g.lines.map((l) => ({ ...l, unitCostCents: null })) }))
        : groups,
      // Not stocked yet — create (POST /inventory/from-master {masterIngredientId}); no PO until it is a stock item.
      notStocked,
    }
  })

  fastify.post('/shopping-list/draft-pos', { preHandler: [requireAuth(...PROCUREMENT_TEAM), requireModule('procurement')] }, async (req, reply) => {
    const body = z.object({ locationId: z.string().min(1), date: dateSchema.optional(), days: z.number().int().min(1).max(7).optional() }).parse(req.body)
    // Draft POs bind to the ACTIVE company (create).
    const outlet = await outletOf(req, body.locationId, 'create')
    const date = body.date ?? pktToday()
    const days = body.days ?? 1
    const { demand, notStocked } = await shoppingDemand(outlet.tenantId, outlet.id, date, days)
    // Draft POs only for stocked items; the not-stocked ones come back to be created first.
    const groups = await reorderSuggestions([outlet.tenantId], { demand, locationId: outlet.id })
    const created: Array<{ purchaseOrderId: string; supplierId: string; supplierName: string; lineCount: number }> = []
    const unassigned: Array<{ inventoryItemId: string; name: string; suggestedQty: number }> = []
    for (const g of groups) {
      if (!g.supplierId) { unassigned.push(...g.lines.map((l) => ({ inventoryItemId: l.inventoryItemId, name: l.name, suggestedQty: l.suggestedQty }))); continue }
      const po = await createPo({
        supplierId: g.supplierId,
        createdBy: req.staffUser!.id,
        notes: `Shopping list for ${outlet.name}, ${date}${days > 1 ? ` (+${days - 1} day${days > 2 ? 's' : ''})` : ''}`,
        lines: g.lines.map((l) => ({ inventoryItemId: l.inventoryItemId, quantityOrdered: l.suggestedQty, unitCostCents: l.unitCostCents, notes: l.spec ? `Spec: ${l.spec}`.slice(0, 500) : null })),
      })
      created.push({ purchaseOrderId: po.id, supplierId: g.supplierId, supplierName: g.supplierName, lineCount: g.lines.length })
    }
    await audit({
      category: 'identity', action: 'kitchen.shopping_list_pos', entity: 'Location', entityId: outlet.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: outlet.tenantId,
      after: { date, days, purchaseOrderIds: created.map((c) => c.purchaseOrderId), unassigned: unassigned.length },
    })
    return reply.status(201).send({ created, unassigned, notStocked })
  })

  // ── The spec list (K6) ────────────────────────────────────────────────────
  fastify.get<{ Querystring: { format?: string } }>('/spec-list', { preHandler: [requireAuth(...ALL_STAFF), requireModule('procurement', 'inventory', 'recipes', 'par_sheet')] }, async (req, reply) => {
    const scope = await resolveTenantScope(req)
    const items = scope.tenantIds.length === 0 ? [] : await prisma.inventoryItem.findMany({
      where: { tenantId: { in: scope.tenantIds }, deletedAt: null, kind: 'stock', masterIngredientId: { not: null } },
      select: {
        id: true, name: true, unit: true, purchaseUnit: true, purchaseUnitFactor: true, tenantId: true,
        supplier: { select: { id: true, name: true, tenantId: true } },
        masterIngredient: { select: { id: true, name: true, spec: true, specFields: true, status: true, category: true } },
      },
      orderBy: { name: 'asc' },
    })
    const rows = items.map((i) => {
      const sup = i.supplier && i.supplier.tenantId === i.tenantId ? i.supplier : null
      const fields = (i.masterIngredient?.specFields ?? null) as Record<string, string> | null
      return {
        supplier: sup?.name ?? 'No supplier set',
        supplierId: sup?.id ?? null,
        ingredient: i.name,
        masterIngredientId: i.masterIngredient?.id ?? null,
        unit: i.unit,
        boughtBy: i.purchaseUnit ? `${i.purchaseUnit} (${i.purchaseUnitFactor} ${i.unit})` : i.unit,
        spec: i.masterIngredient?.spec ?? '',
        specDetails: fields ? Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
        status: i.masterIngredient?.status === 'needs_review' ? 'needs review' : '',
      }
    }).sort((a, b) => a.supplier.localeCompare(b.supplier) || a.ingredient.localeCompare(b.ingredient))
    const format = exportFormatOf(req.query.format)
    if (!format) return { rows }
    return sendReportFor(req, reply, format, 'spec-list', {
      title: 'Spec list — what we buy',
      rows: rows.map(({ supplierId: _s, masterIngredientId: _m, ...r }) => r),
      sectionKey: 'supplier',
      labels: { supplier: 'Supplier', ingredient: 'Ingredient', unit: 'Stock unit', boughtBy: 'Bought by', spec: 'Spec', specDetails: 'Spec details', status: 'Review' },
      wrapKeys: ['spec', 'specDetails'],
    })
  })
}
