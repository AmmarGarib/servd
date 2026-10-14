// Cross-checks module — the closed-loop inventory + exception endpoints.
// Bundled in one file because they all share the ExceptionFlag spine.
//
// Stock documents (finance wave B, food cost on FIFO lots, H16 / H19 / H20):
// every stock change here goes through lib/stockLedger.ts — never a direct
// currentStock write. The caller runs ensureFifoReady(tenantId) BEFORE its
// transaction; inside it the items are locked in id order (lockItemsTx); the
// document's posting (accounting/inventoryPosting.ts) runs behind a savepoint
// (postInventoryDocInSavepoint) so a refused posting never undoes the count or
// the batch — it is flagged posting_failed after commit and re-posted by
// Reconciliation → Backfill unposted. The response carries the ledger result.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma, UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF, ADMIN_ONLY, FINANCE_TEAM, PROCUREMENT_TEAM } from '../auth/middleware.js'
import { flagException, acknowledgeException, resolveException, kindsMatching } from '../../lib/exceptions.js'
import { receiveGoods } from '../procurement/receiving.js'
import { NotFoundError, AppError, ForbiddenError } from '../../lib/errors.js'
import { toPurchaseUnits } from '../../lib/recipeCost.js'
import { activeTenantId, resolveTenantScope, scopeTenantWhere } from '../../lib/tenantScope.js'
import { subRecipeIdsForCompany } from '../par-sheet/routes.js'
import { assertLocationOfCompany } from '../financePlanning/companyRefs.js'
import { assertInt4Fits, sumCents, toCents, zInt4Cents } from '../../lib/money.js'
import {
  addLotTx, consumeFifoTx, ensureFifoReady, latestPurchaseCostCents, lockItemsTx, STOCK_EPS, STOCK_SOURCE,
} from '../../lib/stockLedger.js'
import { postInventoryDocInSavepoint, COUNT_SOURCE_TYPE, PREP_DRAW_SOURCE_TYPE } from '../accounting/inventoryPosting.js'
import { flagPostingFailed, type PostingFailure } from '../accounting/journal.js'
import { parsePktEndOfDay, parsePktStartOfDay } from '../accounting/dates.js'
import { costsHiddenFor, OPENING_COUNT_ROLES } from '../inventory/routes.js'

type Tx = Prisma.TransactionClient

/** The ledger result every stock document's response carries. */
export interface StockDocLedger { posted: boolean; entryId?: string; reason?: string; error?: string }

const DAY_MS = 86_400_000
const TX_OPTS = { maxWait: 10_000, timeout: 30_000 }
/** A counted quantity this close to the book is a match. */
const COUNT_EPS = 1e-6
/** Every count difference line carries a reason the CEO can read (H20 — the difference waits for approval). */
const MIN_REASON = 3

/** Raise a refused posting AFTER commit, with the document's date (the period-close check reads it). */
async function flagRefused(failure: PostingFailure | null, documentDate: Date): Promise<void> {
  if (!failure) return
  await flagPostingFailed({ ...failure, metadata: { ...(failure.metadata ?? {}), documentDate: documentDate.toISOString() } })
}

/** YYYY-MM-DD (PKT) query bound, or 400 BAD_DATE. */
function pktBound(v: string | undefined, end: boolean): Date | undefined {
  if (!v) return undefined
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) throw new AppError('BAD_DATE', `${v} is not a date (YYYY-MM-DD)`, 400)
  const d = end ? parsePktEndOfDay(v) : parsePktStartOfDay(v)
  if (Number.isNaN(d.getTime())) throw new AppError('BAD_DATE', `${v} is not a date (YYYY-MM-DD)`, 400)
  return d
}

// Variance thresholds. Hardcoded for now; later config-driven.
const PRICE_DRIFT_THRESHOLD        = 0.03    // 3%
const YIELD_LOW_THRESHOLD          = 0.85    // < 85% of expected = leak
const SHRINKAGE_THRESHOLD          = 0.02    // > 2% physical vs system = flag

export async function crosschecksRoutes(fastify: FastifyInstance) {

  // ════════════════════════════════════════════════════════════════════════
  // RECEIVING — the dock-door page. Thin wrappers over procurement
  // receiveGoods(), the ONE receiving path (the PO receive route calls it
  // too): GoodsReceipt + PO line quantities + FIFO lots + the GRNI posting in
  // one transaction, variance flags after commit. `locationId` tags the
  // outlet the goods arrived at (one of the supplier's company's, else 422
  // LOCATION_NOT_IN_COMPANY — receiveGoods checks it). Manager tiers only (owner
  // decision 27) and deliberately not behind the procurement module, so a
  // kitchen manager can take a delivery at the door.
  //
  // The buyer (role procurement) holds the module whose sidebar links this
  // page (/procurement/receiving), so the page's READS admit PROCUREMENT_TEAM
  // (R2-UI-02, wave 3: a role with the module gets every read 200) — scoped
  // exactly as for a manager. Taking the delivery in (POST) stays MANAGERS:
  // whoever orders the goods does not also sign for them (decision 27).
  // ════════════════════════════════════════════════════════════════════════

  // Suppliers the operator can see: their companies' plus company-less ones
  // (which can still carry an old PO). Fails closed on an empty scope. A
  // company's system supplier ('Cash purchases' — systemKind set) is never a
  // dock supplier: its goods come in on the cash document.
  async function receivingSupplierIds(req: FastifyRequest): Promise<string[]> {
    const scope = await resolveTenantScope(req)
    if (scope.tenantIds.length === 0) return []
    const rows = await prisma.supplier.findMany({
      where:  { systemKind: null, OR: [{ tenantId: { in: scope.tenantIds } }, { tenantId: null }] },
      select: { id: true },
    })
    return rows.map((r) => r.id)
  }

  fastify.get('/receiving', { preHandler: requireAuth(...PROCUREMENT_TEAM) }, async (req) => {
    const { status } = req.query as { status?: string }
    return prisma.goodsReceipt.findMany({
      where: { supplierId: { in: await receivingSupplierIds(req) }, ...(status && { status }) },
      include: { lines: true },
      orderBy: { receivedAt: 'desc' },
      take: 100,
    })
  })

  // Suppliers a delivery WITHOUT a PO can come from: the active company's.
  fastify.get('/receiving/suppliers', { preHandler: requireAuth(...PROCUREMENT_TEAM) }, async (req) => {
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) return []
    return prisma.supplier.findMany({
      where:   { tenantId, deletedAt: null, systemKind: null },
      select:  { id: true, name: true },
      orderBy: { name: 'asc' },
    })
  })

  // POs waiting at the dock: approved and sent, or part-received.
  fastify.get('/receiving/open-pos', { preHandler: requireAuth(...PROCUREMENT_TEAM) }, async (req) => {
    return prisma.purchaseOrder.findMany({
      where: { supplierId: { in: await receivingSupplierIds(req) }, status: { in: ['sent', 'partial'] } },
      include: {
        supplier: { select: { id: true, name: true } },
        lines:    { include: { inventoryItem: { select: { id: true, name: true, unit: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
  })

  fastify.post('/receiving', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      poId:       z.string().uuid().nullable().optional(),
      supplierId: z.string().uuid().nullable().optional(),
      locationId: z.string().uuid().nullable().optional(),
      photoUrl:   z.string().url().nullable().optional(),
      notes:      z.string().max(500).nullable().optional(),
      lines: z.array(z.object({
        poLineId:          z.string().uuid().nullable().optional(),
        inventoryItemId:   z.string().uuid().nullable().optional(),
        quantityReceived:  z.number().min(0),
        unitCostCents:     z.number().int().min(0).nullable().optional(),
        discrepancyReason: z.enum(['short_shipment', 'over_shipment', 'damaged', 'wrong_item', 'quality_issue']).nullable().optional(),
        notes:             z.string().max(200).nullable().optional(),
      })).min(1),
    }).parse(req.body)

    // The supplier must be one the operator can see; a delivery without a PO
    // binds new stock, so it must be the ACTIVE company's supplier.
    const supplierId = body.poId
      ? (await prisma.purchaseOrder.findUnique({ where: { id: body.poId }, select: { supplierId: true } }))?.supplierId
      : body.supplierId
    if (!supplierId) throw body.poId ? new NotFoundError('PurchaseOrder', body.poId) : new AppError('SUPPLIER_REQUIRED', 'Pick the supplier for a delivery without a PO', 400)
    if (!(await receivingSupplierIds(req)).includes(supplierId)) {
      throw body.poId ? new NotFoundError('PurchaseOrder', body.poId) : new NotFoundError('Supplier', supplierId)
    }
    if (!body.poId) {
      const sup = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { tenantId: true } })
      if (sup?.tenantId && sup.tenantId !== req.staffUser!.tenantId) {
        throw new AppError('SUPPLIER_NOT_IN_ACTIVE_COMPANY', 'Switch to the supplier\'s company to receive a delivery without a PO', 422)
      }
    }

    const result = await receiveGoods({
      actor:      req.staffUser!,
      poId:       body.poId ?? null,
      supplierId,
      locationId: body.locationId ?? null,
      photoUrl:   body.photoUrl ?? null,
      notes:      body.notes ?? null,
      lines:      body.lines,
    })
    return reply.status(201).send({ ...result.receipt, poStatus: result.poStatus, flagged: result.flagged })
  })

  // ════════════════════════════════════════════════════════════════════════
  // PREP BATCHES — yield tracking
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/prep-batches', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const rows = await prisma.prepBatch.findMany({
      where: await scopeTenantWhere(req, 'read'),
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return costsHiddenFor(req) ? rows.map((b) => ({ ...b, drawValueCents: null, costsHidden: true as const })) : rows
  })

  fastify.post('/prep-batches', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      recipeId:         z.string().uuid().nullable().optional(),
      itemName:         z.string().min(1).max(120),
      inputs:           z.array(z.object({
        inventoryItemId: z.string().uuid(),
        qtyDrawn:        z.number().min(0),
        unit:            z.string().max(20).default('g'),
      })).min(1),
      expectedYieldQty: z.number().min(0).nullable().optional(),
      actualYieldQty:   z.number().min(0),
      unit:             z.string().max(20).default('g'),
      // The outlet the batch was made at (one of the active company's). Stock
      // is still one pool per company — per-outlet stock is the next build.
      locationId:       z.string().uuid().nullable().optional(),
      photoUrl:         z.string().url().nullable().optional(),
      notes:            z.string().max(500).nullable().optional(),
    }).parse(req.body)

    let yieldVariancePct: number | null = null
    if (body.expectedYieldQty && body.expectedYieldQty > 0) {
      yieldVariancePct = body.actualYieldQty / body.expectedYieldQty
    }

    // Inputs are weighed in the kitchen (grams by default) but stock is held
    // in PURCHASE units (kg / litres / pcs). The old code subtracted the gram
    // figure straight from kilo stock — 500 g of garlic took 500 kg. Convert
    // through lib/recipeCost.ts (the same unit rules as the recipe explosion)
    // and refuse a unit that can't be reconciled rather than guess.
    // Inputs must be the active company's own items: a batch draws that
    // company's stock, and the batch is stamped with it.
    const tenantId = activeTenantId(req, 'a prep batch draws one company\'s stock')
    if (body.locationId) await assertLocationOfCompany(tenantId, body.locationId)
    const invItems = await prisma.inventoryItem.findMany({
      where: { id: { in: body.inputs.map((i) => i.inventoryItemId) }, deletedAt: null, tenantId },
      select: { id: true, name: true, unit: true },
    })
    const invById = new Map(invItems.map((i) => [i.id, i]))
    const inputs = body.inputs.map((i) => {
      const inv = invById.get(i.inventoryItemId)
      if (!inv) throw new NotFoundError('InventoryItem', i.inventoryItemId)
      const qtyPurchaseUnits = toPurchaseUnits(i.qtyDrawn, i.unit, inv.unit)
      if (qtyPurchaseUnits == null) {
        throw new AppError('UNIT_MISMATCH', `${inv.name} is stocked in ${inv.unit}; ${i.unit} can't be converted to it`, 422)
      }
      return { ...i, qtyPurchaseUnits, stockUnit: inv.unit }
    })

    // A batch of a SUB-RECIPE (recipeId → kind 'component') is a yield record
    // only: sale-time depletion already explodes that sub-recipe into its raw
    // ingredients when the plates using it sell (the same explosion the ledger
    // costs COGS on), so taking the inputs out here as well would count them
    // twice. Ad-hoc batches (no recipe) still draw their inputs from stock —
    // FIFO, oldest lot first ('prep_draw'), posted Dr 50x0 / Cr 12x0
    // ('inventory.prep_draw:<batchId>', brand split by usage).
    //
    // The recipe is resolved inside the ACTIVE company (BOH-R2-04): a batch may
    // cite only a sub-recipe the company's brands use — the list the par sheet
    // and the prep page offer (subRecipeIdsForCompany). Any other id (another
    // company's sub-recipe, a plate, an id that does not exist) is refused 422
    // rather than stored: citing a foreign sub-recipe used to log a batch that
    // drew none of this company's stock.
    let subRecipe: { id: string } | null = null
    if (body.recipeId) {
      const companySubRecipes = await subRecipeIdsForCompany(tenantId)
      subRecipe = companySubRecipes.has(body.recipeId)
        ? await prisma.recipe.findFirst({ where: { id: body.recipeId, kind: 'component' }, select: { id: true } })
        : null
      if (!subRecipe) {
        throw new AppError('RECIPE_NOT_IN_COMPANY', 'That sub-recipe is not one of this company\'s — pick one from the prep list, or log the batch without a recipe', 422)
      }
    }

    // One draw per item (a document draws each item once — merge repeats).
    const drawByItem = new Map<string, number>()
    if (!subRecipe) {
      for (const i of inputs) {
        if (i.qtyPurchaseUnits > 0) drawByItem.set(i.inventoryItemId, (drawByItem.get(i.inventoryItemId) ?? 0) + i.qtyPurchaseUnits)
      }
      if (drawByItem.size > 0) await ensureFifoReady(tenantId)
    }

    const { batch, ledger, failure } = await prisma.$transaction(async (tx) => {
      const itemIds = [...drawByItem.keys()].sort()
      await lockItemsTx(tx, itemIds)
      const created = await tx.prepBatch.create({
        data: {
          tenantId,
          recipeId: subRecipe?.id ?? null,
          itemName: body.itemName,
          inputs,
          expectedYieldQty: body.expectedYieldQty ?? null,
          actualYieldQty: body.actualYieldQty,
          unit: body.unit,
          yieldVariancePct,
          staffId: req.staffUser!.id,
          locationId: body.locationId ?? null,
          photoUrl: body.photoUrl ?? null,
          notes: body.notes ?? null,
        },
      })
      if (itemIds.length === 0) return { batch: created, ledger: null as StockDocLedger | null, failure: null as PostingFailure | null }

      // Not enough on the lots fails the whole batch (no clamp): a draw that
      // did not happen is never recorded.
      let value = 0
      for (const id of itemIds) {
        try {
          const r = await consumeFifoTx(tx, {
            tenantId, inventoryItemId: id, qty: drawByItem.get(id)!, kind: 'prep_draw',
            sourceType: STOCK_SOURCE.prepBatch, sourceId: created.id, clamp: false,
            locationId: body.locationId ?? null, occurredAt: created.createdAt, createdById: req.staffUser!.id,
          })
          value += r.valueCents
        } catch (err) {
          if ((err as { code?: string }).code === 'NEGATIVE_STOCK') {
            throw new AppError('INSUFFICIENT_STOCK', `Not enough ${invById.get(id)?.name ?? 'stock'} on hand for this batch — ${(err as Error).message}`, 409)
          }
          throw err
        }
      }
      const saved = await tx.prepBatch.update({ where: { id: created.id }, data: { drawValueCents: value } })
      const post = await postInventoryDocInSavepoint(tx, PREP_DRAW_SOURCE_TYPE, created.id, { tenantId, actorId: req.staffUser!.id, amountCents: value })
      return { batch: saved, ledger: post.ledger as StockDocLedger, failure: post.failure }
    }, TX_OPTS)
    await flagRefused(failure, batch.createdAt)

    // Flag if yield is suspiciously low
    if (yieldVariancePct != null && yieldVariancePct < YIELD_LOW_THRESHOLD) {
      const staffUser = await prisma.user.findUnique({ where: { id: req.staffUser!.id }, select: { name: true } })
      await flagException({
        tenantId,
        kind: 'yield_low',
        severity: yieldVariancePct < 0.7 ? 'high' : 'medium',
        title: `Low yield: ${body.itemName}`,
        description: `Expected ${body.expectedYieldQty}${body.unit}, actual ${body.actualYieldQty}${body.unit} (${(yieldVariancePct * 100).toFixed(0)}% yield) — chef ${staffUser?.name ?? req.staffUser!.id}.`,
        entityType: 'PrepBatch',
        entityId: batch.id,
        actorId: req.staffUser!.id,
        metadata: { yieldPct: yieldVariancePct, inputs: body.inputs },
      })
    }

    const out = { ...batch, ledger }
    return reply.status(201).send(costsHiddenFor(req) ? { ...out, drawValueCents: null, costsHidden: true } : out)
  })

  // ════════════════════════════════════════════════════════════════════════
  // PHYSICAL COUNT — random spot counts, and the opening count (H19)
  // ════════════════════════════════════════════════════════════════════════

  // Counting is line-cook work (the Count page sits in boh's inventory
  // module; wave 3). Procurement is left out on purpose: the buyer would be
  // certifying stock it orders itself, which hides shrinkage. Variances past
  // the threshold still raise a shrinkage exception for the managers.
  //
  // No month-end stocktake is required anywhere (owner): counts are random
  // spot counts of high-value items (GET /physical-counts/suggested).
  //
  // An OPENING count (stock found by the first count of an item never counted
  // or received, H19) books the stock to the owner's capital, never to cost of
  // sales — so only finance, the CEO and management may make one (critic:
  // not the floor managers), and finance may make nothing else here.
  const STOCK_COUNTERS = [...MANAGERS, 'boh'] as UserRole[]
  const COUNT_POSTERS = [...STOCK_COUNTERS, ...OPENING_COUNT_ROLES.filter((r) => !STOCK_COUNTERS.includes(r))] as UserRole[]

  fastify.get<{ Querystring: { kind?: string; from?: string; to?: string } }>(
    '/physical-counts',
    { preHandler: requireAuth(...COUNT_POSTERS) },
    async (req) => {
      const kind = req.query.kind
      if (kind && kind !== 'spot' && kind !== 'opening') throw new AppError('BAD_KIND', 'kind is spot or opening', 400)
      const from = pktBound(req.query.from, false)
      const to = pktBound(req.query.to, true)
      const counts = await prisma.physicalCount.findMany({
        where: {
          ...(await scopeTenantWhere(req, 'read')),
          ...(kind ? { kind } : {}),
          ...(from || to ? { countedAt: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {}),
        },
        include: { lines: true },
        orderBy: { countedAt: 'desc' },
        take: 50,
      })
      return countsForResponse(req, counts)
    },
  )

  // What the signed-in operator may do on the Count page (the admin shows the
  // Opening picker only when canOpeningCount — no role list in the frontend).
  fastify.get('/physical-counts/capabilities', { preHandler: requireAuth(...COUNT_POSTERS) }, async (req) => {
    const role = req.staffUser!.role as string
    return {
      canSpotCount: (STOCK_COUNTERS as string[]).includes(role),
      canOpeningCount: (OPENING_COUNT_ROLES as string[]).includes(role),
      costsHidden: costsHiddenFor(req),
    }
  })

  // A weighted random sample of the active company's high-value items to
  // count today: weight = on-hand lot value × 30-day usage (value), so
  // expensive, fast-moving stock comes up most; items counted in the last 7
  // days are left out. Floor roles get quantities only.
  fastify.get<{ Querystring: { n?: string; locationId?: string } }>(
    '/physical-counts/suggested',
    { preHandler: requireAuth(...STOCK_COUNTERS) },
    async (req) => {
      const tenantId = activeTenantId(req, 'a count is one company\'s stock')
      if (req.query.locationId) await assertLocationOfCompany(tenantId, req.query.locationId)
      const n = Math.min(Math.max(parseInt(req.query.n ?? '8', 10) || 8, 1), 50)
      const now = Date.now()

      const [onHand, usage, recent] = await Promise.all([
        prisma.stockLot.groupBy({
          by: ['inventoryItemId'],
          where: { tenantId, remainingQty: { gt: 0.000001 } },
          _sum: { remainingQty: true, remainingValueCents: true },
        }),
        prisma.stockMovement.groupBy({
          by: ['inventoryItemId'],
          where: { tenantId, kind: { in: ['sale', 'prep_draw', 'waste', 'count_loss'] }, occurredAt: { gte: new Date(now - 30 * DAY_MS) } },
          _sum: { valueCents: true },
        }),
        prisma.physicalCountLine.findMany({
          where: { count: { tenantId, countedAt: { gte: new Date(now - 7 * DAY_MS) } } },
          select: { inventoryItemId: true },
          distinct: ['inventoryItemId'],
        }),
      ])
      const countedRecently = new Set(recent.map((r) => r.inventoryItemId))
      const usedValue = new Map(usage.map((u) => [u.inventoryItemId, Math.abs(sumCents(u._sum.valueCents))]))
      const candidates = onHand
        .filter((r) => !countedRecently.has(r.inventoryItemId) && sumCents(r._sum.remainingValueCents) > 0)
        .map((r) => ({ id: r.inventoryItemId, qty: r._sum.remainingQty ?? 0, value: sumCents(r._sum.remainingValueCents) }))
      const items = candidates.length === 0 ? [] : await prisma.inventoryItem.findMany({
        where: { id: { in: candidates.map((c) => c.id) }, tenantId, deletedAt: null },
        select: { id: true, name: true, unit: true },
      })
      const itemById = new Map(items.map((i) => [i.id, i]))
      const anyUsage = candidates.some((c) => (usedValue.get(c.id) ?? 0) > 0)
      // Efraimidis–Spirakis: key = u^(1/w), the n largest keys are a weighted
      // sample without replacement. With no usage at all, value alone weighs.
      const keyed = candidates
        .filter((c) => itemById.has(c.id))
        .map((c) => {
          const w = anyUsage ? c.value * ((usedValue.get(c.id) ?? 0) + 1) : c.value
          return { c, key: Math.log(Math.random() || Number.MIN_VALUE) / w }
        })
        .sort((a, b) => b.key - a.key)
        .slice(0, n)
      const hide = costsHiddenFor(req)
      return {
        items: keyed.map(({ c }) => {
          const it = itemById.get(c.id)!
          return {
            id: it.id, name: it.name, unit: it.unit, onHandQty: Math.round(c.qty * 1000) / 1000,
            ...(hide ? {} : { onHandValueCents: c.value }),
          }
        }),
        ...(hide ? { costsHidden: true as const } : {}),
      }
    },
  )

  fastify.get<{ Params: { id: string } }>('/physical-counts/:id', { preHandler: requireAuth(...COUNT_POSTERS) }, async (req) => {
    const count = await prisma.physicalCount.findFirst({
      where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) },
      include: { lines: true },
    })
    if (!count) throw new NotFoundError('PhysicalCount', req.params.id)
    return (await countsForResponse(req, [count]))[0]
  })

  fastify.post('/physical-counts', { preHandler: requireAuth(...COUNT_POSTERS) }, async (req, reply) => {
    const body = z.object({
      kind:       z.enum(['spot', 'opening']).default('spot'),
      locationId: z.string().uuid().nullable().optional(),
      lines: z.array(z.object({
        inventoryItemId: z.string().uuid(),
        physicalQty:     z.number().min(0),
        reason:          z.string().max(200).nullable().optional(),
        // Opening counts: the unit cost per purchase unit (paisa). Default the
        // latest purchase price, else the item's typed estimate.
        unitCostCents:   zInt4Cents('The unit cost').nullable().optional(),
      })).min(1),
      notes: z.string().max(500).nullable().optional(),
    }).parse(req.body)

    const role = req.staffUser!.role as UserRole
    if (body.kind === 'opening') {
      if (!(OPENING_COUNT_ROLES as string[]).includes(role)) {
        throw new AppError('OPENING_COUNT_ROLE', 'Only finance, the CEO or management can record an opening count — it books stock to the owner\'s capital.', 403)
      }
    } else if (!(STOCK_COUNTERS as string[]).includes(role)) {
      throw new ForbiddenError('Spot counts are made by the kitchen and the managers.')
    }

    // A count is the ONE way stock on hand is corrected (decision 28), so it
    // has to be exact: every line is an item of the ACTIVE company (another
    // company's is 404, a company-less one 422), at an outlet of that company.
    const tenantId = activeTenantId(req, 'a count is one company\'s stock')
    if (body.locationId) await assertLocationOfCompany(tenantId, body.locationId)
    const ids = body.lines.map((l) => l.inventoryItemId)
    if (new Set(ids).size !== ids.length) throw new AppError('DUPLICATE_LINE', 'An item appears twice in the count', 400)
    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, name: true, tenantId: true },
    })
    for (const id of ids) {
      const it = items.find((x) => x.id === id)
      if (!it || (it.tenantId && it.tenantId !== tenantId)) throw new NotFoundError('InventoryItem', id)
      if (!it.tenantId) throw new AppError('ITEM_HAS_NO_COMPANY', `${it.name} belongs to no company yet — assign it on the Sourcing sheet first`, 422)
    }

    await ensureFifoReady(tenantId)
    const r = await prisma.$transaction((tx) => recordPhysicalCountTx(tx, {
      tenantId, kind: body.kind, locationId: body.locationId ?? null, notes: body.notes ?? null, actorId: req.staffUser!.id,
      lines: body.lines.map((l) => ({ inventoryItemId: l.inventoryItemId, physicalQty: l.physicalQty, reason: l.reason ?? null, unitCostCents: l.unitCostCents ?? null })),
    }), TX_OPTS)
    await raiseCountFlags(r, req.staffUser!.id)

    const hide = costsHiddenFor(req)
    const lines = hide ? r.lines.map(hideLineCosts) : r.lines
    const { lines: _lines, ...countRow } = r.count
    return reply.status(201).send({ ...countRow, lines, count: countRow, ledger: r.ledger, ...(hide ? { costsHidden: true } : {}) })
  })

  // ════════════════════════════════════════════════════════════════════════
  // EXCEPTION INBOX — owner sees only what's broken
  // ════════════════════════════════════════════════════════════════════════

  // Every read and write here is scoped by ExceptionFlag.tenantId: the inbox
  // shows the operator's companies' flags only ('read' — view-aware), and a
  // flag of any other company is 404 on acknowledge / resolve / dismiss
  // ('write' — every company the operator belongs to). Company-less flags
  // (legacy rows nothing could attribute) are shown to nobody.
  //
  // Who: the manager tiers plus finance (FINANCE_TEAM). Finance holds the
  // `exceptions` module by default (lib/moduleAccess.ts) and the inbox is in
  // the Finance workspace — cash variances, refunds, manual journals land
  // here — yet the routes refused it with 403 (2026-10-10 audit, BOOKS-02).
  // Finance can read, acknowledge and resolve; dismissing stays CEO-only.

  fastify.get('/exceptions', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const { status, severity, kind } = req.query as { status?: string; severity?: string; kind?: string }
    return prisma.exceptionFlag.findMany({
      where: {
        ...(await scopeTenantWhere(req, 'read')),
        ...(status   ? { status: status as never }     : { status: 'open' }),
        ...(severity && { severity: severity as never }),
        ...(kind     && { kind }),
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    })
  })

  fastify.get('/exceptions/stats', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    const [open, ack, last24h, byKind] = await Promise.all([
      prisma.exceptionFlag.count({ where: { ...scope, status: 'open' } }),
      prisma.exceptionFlag.count({ where: { ...scope, status: 'acknowledged' } }),
      prisma.exceptionFlag.count({ where: { ...scope, createdAt: { gte: new Date(Date.now() - 86400_000) } } }),
      prisma.exceptionFlag.groupBy({
        by: ['kind'], where: { ...scope, status: 'open' }, _count: { _all: true },
      }),
    ])
    return { open, acknowledged: ack, last24h, byKind: byKind.map((b) => ({ kind: b.kind, count: b._count._all })) }
  })

  fastify.patch<{ Params: { id: string } }>('/exceptions/:id/acknowledge',
    { preHandler: requireAuth(...FINANCE_TEAM) },
    async (req, reply) => {
      const ok = await acknowledgeException(req.params.id, req.staffUser!.id, await scopeTenantWhere(req, 'write'))
      if (!ok) throw new NotFoundError('ExceptionFlag', req.params.id)
      return reply.status(204).send()
    },
  )

  fastify.patch<{ Params: { id: string } }>('/exceptions/:id/resolve',
    { preHandler: requireAuth(...FINANCE_TEAM) },
    async (req, reply) => {
      const body = z.object({ resolution: z.string().min(1).max(500) }).parse(req.body)
      const ok = await resolveException(req.params.id, req.staffUser!.id, body.resolution, await scopeTenantWhere(req, 'write'))
      if (!ok) throw new NotFoundError('ExceptionFlag', req.params.id)
      return reply.status(204).send()
    },
  )

  fastify.delete<{ Params: { id: string } }>('/exceptions/:id',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      // Dismiss only a flag of one of the operator's companies. (The old
      // `conceptId: null` branch let anyone dismiss any brand-less flag —
      // most of them — of any company.)
      const r = await prisma.exceptionFlag.updateMany({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
        data: { status: 'dismissed' },
      })
      if (r.count === 0) throw new NotFoundError('ExceptionFlag', req.params.id)
      return reply.status(204).send()
    },
  )
}

// ════════════════════════════════════════════════════════════════════════════
// THE count engine — spot counts, opening counts, and the opening count made
// when a company-less item holding stock is given a company (PATCH
// /inventory/:id { tenantId } calls this; never a second opening path).
// ════════════════════════════════════════════════════════════════════════════

export interface CountLineInput {
  inventoryItemId: string
  physicalQty: number
  /** Required (≥ 3 characters) on a spot line whose count differs from the books (H20). */
  reason: string | null
  /** Opening lines: the unit cost (paisa per purchase unit). Default the latest purchase price, else the item's estimate. */
  unitCostCents: number | null
}

export interface RecordCountInput {
  tenantId: string
  kind: 'spot' | 'opening'
  locationId: string | null
  notes: string | null
  actorId: string
  lines: CountLineInput[]
  /**
   * The company-assignment path: a company-less item's old history (pre-FIFO
   * deliveries, old counts) does not bar its opening count — only lots and
   * stock movements do (it has none: company-less stock never gets lots).
   */
  assignment?: boolean
}

type CountWithLines = Prisma.PhysicalCountGetPayload<{ include: { lines: true } }>

export interface RecordCountResult {
  count: CountWithLines
  lines: CountWithLines['lines']
  ledger: StockDocLedger
  failure: PostingFailure | null
  /** Spot lines past the shrinkage threshold (book above zero). */
  shrinkage: Array<{ itemId: string; itemName: string; sysQty: number; physicalQty: number; variancePct: number; reason: string | null }>
  /** Spot lines that found stock on a zero book ('stock_unrecorded' — never a 0 % variance line). */
  unrecorded: Array<{ itemId: string; itemName: string; unit: string; physicalQty: number; unitCostCents: number; noCost: boolean; valueCents: number }>
}

const fmtQty = (q: number) => String(Math.round(q * 1000) / 1000)

/**
 * 422 OPENING_NOT_ALLOWED unless every item is one whose stock has never been
 * on the books: no lot and no stock movement (never received, counted or cut
 * over with stock), and — outside the assignment path — no pre-FIFO history
 * (an earlier count line, a delivery against a PO or at the dock).
 */
async function assertOpeningAllowed(tx: Tx, items: Array<{ id: string; name: string }>, assignment: boolean): Promise<void> {
  const ids = items.map((i) => i.id)
  const [lots, moves, countLines, receiptLines, poLines] = await Promise.all([
    tx.stockLot.findMany({ where: { inventoryItemId: { in: ids } }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'] }),
    // Only movements that carry a lot (stock-03): a sale of a dish using an
    // item with no lots writes a lot-less 'sale' shortfall row (qty 0, value
    // 0, shortfallQty > 0) — the item was still never received or counted, so
    // its first count is an opening count (H19 → 3010), not a spot count that
    // would credit cost of sales with stock that was never bought on the books.
    tx.stockMovement.findMany({ where: { inventoryItemId: { in: ids }, lotId: { not: null } }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'] }),
    assignment ? [] : tx.physicalCountLine.findMany({ where: { inventoryItemId: { in: ids } }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'] }),
    assignment ? [] : tx.goodsReceiptLine.findMany({ where: { inventoryItemId: { in: ids }, receivedQty: { gt: 0 } }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'] }),
    assignment ? [] : tx.purchaseOrderLine.findMany({ where: { inventoryItemId: { in: ids }, quantityReceived: { gt: 0 } }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'] }),
  ])
  const seen = new Set([...lots, ...moves, ...countLines, ...receiptLines, ...poLines].map((r) => r.inventoryItemId))
  const blocked = items.find((i) => seen.has(i.id))
  if (blocked) {
    throw new AppError(
      'OPENING_NOT_ALLOWED',
      `${blocked.name} has already been received or counted — an opening count is only for stock that was never on the books. Use a spot count.`,
      422,
    )
  }
}

/**
 * Record one count in the caller's transaction (the caller ran
 * ensureFifoReady(tenantId) before opening it):
 *   • spot — the book quantity is read under the item locks; short →
 *     'count_loss' drawn FIFO (no clamp) at the lots' value; over →
 *     'count_gain' lot at the latest purchase price (else the item's
 *     estimate). A zero-book over raises 'stock_unrecorded' (variancePct null)
 *     instead of a 0 % line. A difference needs a reason (H20, ≥ 3 chars).
 *   • opening (H19) — an 'opening' lot at the entered cost (default the
 *     latest purchase price, else the estimate, else 422
 *     OPENING_COST_REQUIRED), only for items never on the books (422
 *     OPENING_NOT_ALLOWED).
 * PhysicalCountLine.valueCents (signed) / unitCostCents are stored; the count
 * posts 'inventory.count:<id>' (accounting/inventoryPosting.ts postStockCount
 * — spot Dr/Cr 5050 vs the class inventory; opening Dr class inventory / Cr
 * capital) behind a savepoint. The caller raises the flags after commit
 * (raiseCountFlags).
 */
export async function recordPhysicalCountTx(tx: Tx, input: RecordCountInput): Promise<RecordCountResult> {
  const ids = input.lines.map((l) => l.inventoryItemId)
  if (new Set(ids).size !== ids.length) throw new AppError('DUPLICATE_LINE', 'An item appears twice in the count', 400)
  await lockItemsTx(tx, ids)
  const items = await tx.inventoryItem.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, name: true, unit: true, tenantId: true, currentStock: true, unitCostCents: true },
  })
  const byId = new Map(items.map((i) => [i.id, i]))
  for (const id of ids) {
    const it = byId.get(id)
    if (!it) throw new NotFoundError('InventoryItem', id)
    if (!it.tenantId) throw new AppError('ITEM_HAS_NO_COMPANY', `${it.name} belongs to no company yet — assign it on the Sourcing sheet first`, 422)
    if (it.tenantId !== input.tenantId) throw new NotFoundError('InventoryItem', id)
  }
  if (input.kind === 'opening') await assertOpeningAllowed(tx, items, input.assignment === true)

  // Plan every line before writing anything.
  type Plan = { line: CountLineInput; item: (typeof items)[number]; book: number; op: 'none' | 'loss' | 'gain' | 'opening'; cost: number; noCost: boolean }
  const plans: Plan[] = []
  for (const line of input.lines) {
    const item = byId.get(line.inventoryItemId)!
    const book = Math.abs(item.currentStock) < COUNT_EPS ? 0 : item.currentStock
    if (input.kind === 'opening') {
      if (!(line.physicalQty > COUNT_EPS)) throw new AppError('INVALID_QTY', `The opening count of ${item.name} needs a quantity above zero`, 422)
      const cost = line.unitCostCents ?? (await latestPurchaseCostCents(tx, item.id)) ?? item.unitCostCents
      if (cost == null) {
        throw new AppError('OPENING_COST_REQUIRED', `${item.name} has no purchase price or cost estimate — enter its unit cost for the opening count`, 422)
      }
      assertInt4Fits(cost, `${item.name}'s unit cost`)
      plans.push({ line, item, book, op: 'opening', cost, noCost: false })
      continue
    }
    const diff = line.physicalQty - book
    const op = diff < -COUNT_EPS ? 'loss' : diff > COUNT_EPS ? 'gain' : 'none'
    if (op !== 'none' && (line.reason ?? '').trim().length < MIN_REASON) {
      throw new AppError(
        'COUNT_REASON_REQUIRED',
        `${item.name}: counted ${fmtQty(line.physicalQty)} ${item.unit}, the books say ${fmtQty(book)} — give a reason for the difference (at least ${MIN_REASON} characters).`,
        422,
      )
    }
    let cost = 0
    let noCost = false
    if (op === 'gain') {
      const c = (await latestPurchaseCostCents(tx, item.id)) ?? item.unitCostCents
      noCost = c == null
      cost = c ?? 0
    }
    plans.push({ line, item, book, op, cost, noCost })
  }

  const countedAt = new Date()
  const count = await tx.physicalCount.create({
    data: {
      tenantId: input.tenantId, countedById: input.actorId, countedAt, notes: input.notes, status: 'completed',
      kind: input.kind, locationId: input.locationId,
    },
  })
  const shrinkage: RecordCountResult['shrinkage'] = []
  const unrecorded: RecordCountResult['unrecorded'] = []
  let amount = 0
  for (const p of plans) {
    const physical = p.line.physicalQty
    const variancePct = p.op === 'opening' ? null
      : p.book > 0 ? (physical - p.book) / p.book
      : p.op === 'gain' ? null : 0
    const row = await tx.physicalCountLine.create({
      data: {
        countId: count.id, inventoryItemId: p.item.id, systemQty: p.book, physicalQty: physical, variancePct,
        reason: p.line.reason?.trim() || null,
      },
      select: { id: true },
    })
    let valueCents: number | null = null
    let unitCostCents: number | null = null
    if (p.op === 'loss') {
      const r = await consumeFifoTx(tx, {
        tenantId: input.tenantId, inventoryItemId: p.item.id, qty: p.book - physical, kind: 'count_loss',
        sourceType: STOCK_SOURCE.countLine, sourceId: row.id, clamp: false,
        locationId: input.locationId, occurredAt: countedAt, createdById: input.actorId,
      })
      valueCents = -r.valueCents
      unitCostCents = r.takenQty > STOCK_EPS ? Math.round(r.valueCents / r.takenQty) : null
    } else if (p.op === 'gain' || p.op === 'opening') {
      const qty = p.op === 'gain' ? physical - p.book : physical
      const kind = p.op === 'gain' ? 'count_gain' : 'opening'
      await addLotTx(tx, {
        tenantId: input.tenantId, inventoryItemId: p.item.id, qty, unitCostCents: p.cost, kind,
        lotSourceType: kind, lotSourceId: row.id, movementSourceType: STOCK_SOURCE.countLine, movementSourceId: row.id,
        locationId: input.locationId, receivedAt: countedAt, createdById: input.actorId,
      })
      valueCents = Math.round(qty * p.cost)   // = addLotTx's lot value
      unitCostCents = p.cost
    }
    if (valueCents !== null || unitCostCents !== null) {
      await tx.physicalCountLine.update({ where: { id: row.id }, data: { valueCents, unitCostCents } })
    }
    amount += Math.abs(valueCents ?? 0)

    if (input.kind === 'spot' && p.op === 'gain' && p.book <= 0) {
      unrecorded.push({
        itemId: p.item.id, itemName: p.item.name, unit: p.item.unit, physicalQty: physical,
        unitCostCents: p.cost, noCost: p.noCost, valueCents: valueCents ?? 0,
      })
    } else if (input.kind === 'spot' && variancePct != null && p.book > 0 && Math.abs(variancePct) > SHRINKAGE_THRESHOLD) {
      shrinkage.push({ itemId: p.item.id, itemName: p.item.name, sysQty: p.book, physicalQty: physical, variancePct, reason: p.line.reason ?? null })
    }
  }

  const post = await postInventoryDocInSavepoint(tx, COUNT_SOURCE_TYPE, count.id, { tenantId: input.tenantId, actorId: input.actorId, amountCents: amount })
  const full = await tx.physicalCount.findUniqueOrThrow({ where: { id: count.id }, include: { lines: { orderBy: { id: 'asc' } } } })
  return { count: full, lines: full.lines, ledger: post.ledger, failure: post.failure, shrinkage, unrecorded }
}

/** After commit: the refused posting, shrinkage and stock_unrecorded flags of a count, in the count's company. */
export async function raiseCountFlags(r: RecordCountResult, actorId: string): Promise<void> {
  const tenantId = r.count.tenantId
  await flagRefused(r.failure, r.count.countedAt)
  for (const s of r.shrinkage) {
    await flagException({
      tenantId,
      kind: 'shrinkage',
      severity: Math.abs(s.variancePct) > 0.1 ? 'high' : 'medium',
      title: `Shrinkage detected: ${s.itemName}`,
      description: `System said ${s.sysQty.toFixed(2)}, physical count ${s.physicalQty.toFixed(2)} (${(s.variancePct * 100).toFixed(1)}%).`,
      entityType: 'PhysicalCount',
      entityId: r.count.id,
      actorId,
      metadata: { itemId: s.itemId, itemName: s.itemName, sysQty: s.sysQty, physicalQty: s.physicalQty, variancePct: s.variancePct, reason: s.reason },
    })
  }
  for (const u of r.unrecorded) {
    // One open flag per item: a recount of the same unrecorded stock adds none.
    const open = await prisma.exceptionFlag.findFirst({
      where: {
        tenantId, kind: { in: kindsMatching('stock_unrecorded') }, status: { in: ['open', 'acknowledged'] },
        metadata: { path: ['itemId'], equals: u.itemId },
      },
      select: { id: true },
    })
    if (open) continue
    await flagException({
      tenantId,
      kind: 'stock_unrecorded',
      severity: u.noCost ? 'high' : 'medium',
      title: `Stock found with nothing on the books: ${u.itemName}`,
      description: `A count found ${fmtQty(u.physicalQty)} ${u.unit} of ${u.itemName} while the books held none — it was never received or counted in. `
        + (u.noCost
          ? 'It has no purchase price or estimate, so it was added at no value: record the delivery it came from or set its cost.'
          : `Added at PKR ${(u.unitCostCents / 100).toFixed(2)} per ${u.unit} (the latest purchase price, else the estimate). Find the delivery it came from.`),
      entityType: 'PhysicalCount',
      entityId: r.count.id,
      actorId,
      amountCents: u.valueCents,
      metadata: { itemId: u.itemId, itemName: u.itemName, physicalQty: u.physicalQty, unitCostCents: u.unitCostCents, noCost: u.noCost },
    })
  }
}

function hideLineCosts<T extends { valueCents: unknown; unitCostCents: unknown }>(l: T): T {
  return { ...l, valueCents: null, unitCostCents: null }
}

/** Counts with item names, line values and the ledger status ({ posted, entryId?, failed }); values hidden for floor roles. */
async function countsForResponse(req: FastifyRequest, counts: CountWithLines[]) {
  if (counts.length === 0) return []
  const ids = counts.map((c) => c.id)
  const itemIds = [...new Set(counts.flatMap((c) => c.lines.map((l) => l.inventoryItemId)))]
  const [items, entries, flags] = await Promise.all([
    prisma.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, unit: true } }),
    prisma.journalEntry.findMany({
      where: { reference: { in: ids.map((id) => `${COUNT_SOURCE_TYPE}:${id}`) } },
      select: { id: true, reference: true, tenantId: true },
    }),
    prisma.exceptionFlag.findMany({
      where: { kind: 'posting_failed', status: { in: ['open', 'acknowledged'] }, entityType: 'PhysicalCount', entityId: { in: ids } },
      select: { entityId: true },
    }),
  ])
  const itemById = new Map(items.map((i) => [i.id, i]))
  const failed = new Set(flags.map((f) => f.entityId))
  const hide = costsHiddenFor(req)
  return counts.map((c) => {
    const entry = entries.find((e) => e.reference === `${COUNT_SOURCE_TYPE}:${c.id}` && e.tenantId === c.tenantId)
    const lines = c.lines.map((l) => {
      const it = itemById.get(l.inventoryItemId)
      const row = { ...l, itemName: it?.name ?? null, unit: it?.unit ?? null, valueCents: toCents(l.valueCents) }
      return hide ? hideLineCosts(row) : row
    })
    return {
      ...c,
      lines,
      ledger: { posted: !!entry, ...(entry ? { entryId: entry.id } : {}), failed: failed.has(c.id) },
      ...(hide ? { costsHidden: true as const } : {}),
    }
  })
}
