import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { belowParWhere, isBelowPar } from '../../lib/recipeCost.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'

// ─── One ingredient master, per company (owner decision 30, 2026-09-27) ──────
//
// /sourcing (the catalogue + price sheet) and /inventory (stock on hand) are
// two views of the SAME InventoryItem rows and both create through POST
// /inventory, which binds the new row to the operator's active company. There
// is no "shared" item any more: a company-less item's waste never reached the
// ledger and one company's deliveries re-priced the other company's recipes.
// Legacy company-less rows stay visible (tagged "No company") until they are
// assigned with PATCH /inventory/:id { tenantId } — see GET /unassigned.
//
// Cost = the moving average of what deliveries actually cost. Only receiving
// moves it once an item has been delivered; a typed price is an opening
// estimate for an item nothing has been received for yet, and every manual
// cost write lands in ItemPriceHistory as 'manual_adjust'.
//
// ─── No stock change without a record (owner decision 28) ────────────────────
//
// Stock on hand changes only through a count (POST /crosschecks/physical-
// counts), a waste log (POST /inventory/:id/waste), a delivery (receiving) or
// a prep batch / sale deduction. The +/- and bulk "set to" adjust route is gone
// and neither create nor PATCH accepts currentStock.

// Tenant filter for inventory reads. NULL tenantId items still come through
// so legacy / orphan rows stay visible — frontend tags them "No company".
// Fails closed: an operator with no company sees no company's stock.
async function inventoryTenantWhere(req: FastifyRequest) {
  const scope = await resolveTenantScope(req)
  if (scope.tenantIds.length === 0) return { tenantId: null }
  return {
    OR: [
      { tenantId: { in: scope.tenantIds } },
      { tenantId: null },
    ],
  }
}

// Editing an existing item: allowed for any company the operator belongs to
// ('write' mode). Company-less legacy rows are editable so they can be
// assigned. A foreign item is a 404 so its id isn't confirmed.
async function assertInventoryAccess(req: FastifyRequest, itemId: string) {
  const item = await prisma.inventoryItem.findFirst({
    where: { id: itemId, deletedAt: null },
  })
  if (!item) throw new NotFoundError('InventoryItem', itemId)
  if (item.tenantId && !req.staffUser!.memberTenantIds.includes(item.tenantId)) {
    throw new NotFoundError('InventoryItem', itemId)
  }
  return item
}

// Has this item ever been delivered? Once it has, its cost is the moving
// average of deliveries and nothing typed on the sheet may overwrite it.
async function deliveredItemIds(itemIds: string[]): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set()
  const [poLines, history, dock] = await Promise.all([
    prisma.purchaseOrderLine.findMany({ where: { inventoryItemId: { in: itemIds }, quantityReceived: { gt: 0 } }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'] }),
    prisma.itemPriceHistory.findMany({ where: { inventoryItemId: { in: itemIds }, source: { in: ['po_receive', 'bill_match'] } }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'] }),
    prisma.goodsReceiptLine.findMany({ where: { inventoryItemId: { in: itemIds }, receivedQty: { gt: 0 } }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'] }),
  ])
  return new Set([...poLines, ...history, ...dock].map((r) => r.inventoryItemId).filter((x): x is string => !!x))
}

async function hasDeliveries(itemId: string): Promise<boolean> {
  return (await deliveredItemIds([itemId])).has(itemId)
}

// An item's default supplier must be one of its own company's suppliers (or a
// legacy company-less one).
async function assertSupplierFits(supplierId: string, tenantId: string) {
  const s = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { tenantId: true } })
  if (!s) throw new NotFoundError('Supplier', supplierId)
  if (s.tenantId && s.tenantId !== tenantId) {
    throw new AppError('SUPPLIER_NOT_IN_COMPANY', 'That supplier belongs to another company.', 422)
  }
}

const STOCK_NEEDS_RECORD =
  'Stock on hand can only change through a stock count, a waste log or a delivery. Use Inventory → Stock count.'

const wasteSchema = z.object({
  quantity: z.number().positive(),
  unit: z.string().min(1),
  reason: z.enum(['spoilage', 'over_prep', 'expired', 'damaged', 'other']),
  estimatedCostCents: z.number().int().min(0).optional(),
  photoUrl: z.string().url().nullable().optional(),
  notes: z.string().optional(),
})

const createItemSchema = z.object({
  name: z.string().min(1),
  unit: z.string().min(1),
  parLevel: z.number().min(0).default(0),
  // Opening cost estimate in paisa per purchase unit. Replaced by the moving
  // average at the first delivery (receiving weights it by stock, which is 0).
  unitCostCents: z.number().int().min(0).nullable().optional(),
  category: z.string().nullable().optional(),
  yieldPct: z.number().min(0).max(100).optional(),
  supplierId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  // Company the item belongs to. Optional — falls back to the operator's
  // active company. In portfolio view the frontend renders a Company picker
  // and posts the choice; it must be a company the operator belongs to.
  tenantId: z.string().min(1).optional(),
})

// General partial edit (Sourcing Master Sheet name/unit/category/notes, the
// opening cost of a never-delivered item, par, and assigning a company to a
// legacy company-less item). Absent keys are left unchanged.
const updateItemSchema = z.object({
  name: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
  unitCostCents: z.number().int().min(0).nullable().optional(),
  category: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  parLevel: z.number().min(0).optional(),
  yieldPct: z.number().min(0).max(100).optional(),
  supplierId: z.string().uuid().nullable().optional(),
  tenantId: z.string().min(1).optional(),
})

// A new item starts at zero on hand (its opening stock is a count); an existing
// item's stock is never typed in. Rejected loudly rather than stripped, so an
// old client doesn't believe it set a number it didn't.
function rejectStockWrites(body: unknown, { allowZero }: { allowZero: boolean }) {
  if (!body || typeof body !== 'object' || !('currentStock' in body)) return
  const v = (body as { currentStock?: unknown }).currentStock
  if (allowZero && (v === 0 || v == null)) return
  throw new AppError('STOCK_NEEDS_RECORD', STOCK_NEEDS_RECORD, 422)
}

export async function inventoryRoutes(fastify: FastifyInstance) {
  // GET /inventory — list with low-stock alerts. Scoped to the operator's
  // visible tenants. Items with no tenant assigned (legacy orphan rows)
  // come through tagged with a "⚠ No company" chip in the UI.
  fastify.get('/', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const tenantWhere = await inventoryTenantWhere(req)
    const items = await prisma.inventoryItem.findMany({
      where: { deletedAt: null, ...tenantWhere },
      include: {
        supplier: { select: { name: true } },
        tenant:   { select: { id: true, name: true, slug: true } },
      },
      orderBy: { name: 'asc' },
    })
    const delivered = await deliveredItemIds(items.map((i) => i.id))

    return items.map((item) => ({
      ...item,
      // 'deliveries' = the moving average of what deliveries cost, moved only
      // by receiving; 'opening' = a typed estimate for a never-delivered item.
      costSource: delivered.has(item.id) ? 'deliveries' as const : 'opening' as const,
      // THE below-par rule (lib/recipeCost.ts) — no par set is never low.
      isLowStock: isBelowPar(item),
      stockPercentage: item.parLevel > 0 ? (item.currentStock / item.parLevel) * 100 : 100,
    }))
  })

  // POST /inventory — the ONE way to add an ingredient (Sourcing sheet and
  // Inventory page both call it). Bound to one company: the active company,
  // or the portfolio picker's choice when it is a company the operator
  // belongs to. Never company-less.
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    rejectStockWrites(req.body, { allowZero: true })
    if (req.body && typeof req.body === 'object' && 'shared' in req.body) {
      throw new AppError('NO_SHARED_ITEMS', 'Ingredients belong to one company. Add it in each company that buys it.', 422)
    }
    const body = createItemSchema.parse(req.body)
    const tenantId = body.tenantId ?? req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_COMPANY', 'Pick the company this ingredient belongs to.', 422)
    if (!req.staffUser!.memberTenantIds.includes(tenantId)) {
      throw new ForbiddenError('You can only create inventory inside a company you belong to.')
    }
    if (body.supplierId) await assertSupplierFits(body.supplierId, tenantId)

    // One row per ingredient per company: a second "Chicken breast" in the
    // same company is how the duplicate items built up.
    const clash = await prisma.inventoryItem.findFirst({
      where: { tenantId, deletedAt: null, name: { equals: body.name.trim(), mode: 'insensitive' } },
      select: { id: true },
    })
    if (clash) {
      throw new AppError('DUPLICATE_ITEM', `"${body.name.trim()}" already exists in this company.`, 409)
    }

    const { tenantId: _bodyTenantId, ...rest } = body
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.inventoryItem.create({
        data: { ...rest, name: body.name.trim(), currentStock: 0, tenantId },
        include: { tenant: { select: { id: true, name: true, slug: true } } },
      })
      if (created.unitCostCents != null) {
        await tx.itemPriceHistory.create({
          data: { inventoryItemId: created.id, oldCostCents: null, newCostCents: created.unitCostCents, source: 'manual_adjust' },
        })
      }
      return created
    })
    return reply.status(201).send(item)
  })

  // PATCH /inventory/:id — partial edit: name/unit/category/notes/par/yield/
  // supplier; the opening cost of an item that has never been delivered
  // (recorded in price history); and assigning a company to a legacy
  // company-less item. Stock on hand is NOT editable here.
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      rejectStockWrites(req.body, { allowZero: false })
      const item = await assertInventoryAccess(req, req.params.id)
      const { tenantId, ...data } = updateItemSchema.parse(req.body)

      if (tenantId !== undefined && tenantId !== item.tenantId) {
        // Only a company-less item can be given a company. Moving an item that
        // already belongs to one would carry that company's deliveries, counts
        // and recipes across — that is a reviewed merge, not an edit.
        if (item.tenantId) {
          throw new AppError('ITEM_HAS_COMPANY', 'This ingredient already belongs to a company.', 422)
        }
        if (!req.staffUser!.memberTenantIds.includes(tenantId)) {
          throw new NotFoundError('Tenant', tenantId)
        }
      }
      const finalTenant = tenantId ?? item.tenantId
      if (data.supplierId && finalTenant) await assertSupplierFits(data.supplierId, finalTenant)

      const costChanges = data.unitCostCents !== undefined && data.unitCostCents !== item.unitCostCents
      if (costChanges) {
        if (await hasDeliveries(item.id)) {
          throw new AppError(
            'COST_FROM_DELIVERIES',
            `${item.name} has been delivered, so its cost is the average of what deliveries cost. It changes when stock is received, not here.`,
            422,
          )
        }
        if (data.unitCostCents == null) {
          throw new AppError('COST_REQUIRED', 'An opening cost can be changed but not cleared.', 422)
        }
      }

      return prisma.$transaction(async (tx) => {
        const updated = await tx.inventoryItem.update({
          where: { id: item.id },
          data: { ...data, ...(tenantId !== undefined && !item.tenantId ? { tenantId } : {}) },
          include: { tenant: { select: { id: true, name: true, slug: true } } },
        })
        if (costChanges) {
          await tx.itemPriceHistory.create({
            data: { inventoryItemId: item.id, oldCostCents: item.unitCostCents, newCostCents: data.unitCostCents!, source: 'manual_adjust' },
          })
        }
        return updated
      })
    },
  )

  // GET /inventory/unassigned — read-only worklist for the one-time clean-up:
  // company-less items (with which companies have received each one and which
  // recipes use it) and names that appear more than once in one company.
  // Assign with PATCH /inventory/:id { tenantId }; merging duplicates needs a
  // reviewed script that repoints the foreign keys — nothing here deletes.
  fastify.get('/unassigned', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const scope = await resolveTenantScope(req)
    const orphans = await prisma.inventoryItem.findMany({
      where: { deletedAt: null, tenantId: null },
      select: {
        id: true, name: true, unit: true, unitCostCents: true, currentStock: true,
        purchaseOrderLines: {
          where: { quantityReceived: { gt: 0 } },
          select: { purchaseOrder: { select: { supplier: { select: { tenantId: true, tenant: { select: { name: true } } } } } } },
        },
        recipeIngredients: {
          select: { recipe: { select: { id: true, name: true, kind: true, menuItem: { select: { name: true, concept: { select: { tenantId: true } } } } } } },
        },
      },
      orderBy: { name: 'asc' },
    })

    const unassigned = orphans.map((o) => {
      const received = new Map<string, string>()
      for (const l of o.purchaseOrderLines) {
        const s = l.purchaseOrder.supplier
        if (s.tenantId) received.set(s.tenantId, s.tenant?.name ?? s.tenantId)
      }
      const usedByCompanies = new Set<string>()
      for (const ri of o.recipeIngredients) {
        const t = ri.recipe.menuItem?.concept?.tenantId
        if (t) usedByCompanies.add(t)
      }
      return {
        id: o.id, name: o.name, unit: o.unit, unitCostCents: o.unitCostCents, currentStock: o.currentStock,
        receivedBy: [...received].map(([tenantId, name]) => ({ tenantId, name })),
        usedInRecipes: o.recipeIngredients.map((ri) => ({
          id: ri.recipe.id, kind: ri.recipe.kind, name: ri.recipe.menuItem?.name ?? ri.recipe.name ?? '—',
        })),
        usedByCompanyIds: [...usedByCompanies],
      }
    })

    const scoped = await prisma.inventoryItem.findMany({
      where: { deletedAt: null, tenantId: { in: scope.tenantIds } },
      select: { id: true, name: true, unit: true, tenantId: true },
    })
    const groups = new Map<string, typeof scoped>()
    for (const it of scoped) {
      const key = `${it.tenantId}::${it.name.trim().toLowerCase()}`
      groups.set(key, [...(groups.get(key) ?? []), it])
    }
    const duplicates = [...groups.values()].filter((g) => g.length > 1)

    return { unassigned, duplicates }
  })

  // GET /inventory/alerts — items below par: THE rule (lib/recipeCost.ts
  // isBelowPar / belowParWhere — par set and stock at or under it), scoped by
  // the ITEM's company. Company-less legacy rows belong to nobody's par sheet
  // (decision 30); they surface on GET /inventory for assignment instead.
  fastify.get('/alerts', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const scope = await resolveTenantScope(req)
    return prisma.inventoryItem.findMany({
      where: { deletedAt: null, tenantId: { in: scope.tenantIds }, ...belowParWhere() },
      include: {
        supplier: { select: { name: true, phone: true } },
        tenant:   { select: { id: true, name: true, slug: true } },
      },
      orderBy: { name: 'asc' },
    })
  })

  // GET /inventory/waste-logs — waste history with optional filters
  fastify.get<{ Querystring: { inventoryItemId?: string; dateFrom?: string; dateTo?: string; limit?: string } }>(
    '/waste-logs',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500)
      const from = req.query.dateFrom ? new Date(req.query.dateFrom) : undefined
      const to = req.query.dateTo ? new Date(req.query.dateTo) : undefined
      return prisma.wasteLog.findMany({
        where: {
          ...(req.query.inventoryItemId && { inventoryItemId: req.query.inventoryItemId }),
          ...(from || to ? { recordedAt: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {}),
          // Company scoping via the wasted item's tenant (null = shared item).
          inventoryItem: { OR: [{ tenantId: req.staffUser!.tenantFilter }, { tenantId: null }] },
        },
        include: {
          inventoryItem: { select: { name: true, unit: true, unitCostCents: true } },
          recordedBy: { select: { name: true } },
        },
        orderBy: { recordedAt: 'desc' },
        take: limit,
      })
    },
  )

  // GET /inventory/waste-analytics — aggregated waste for the dashboard.
  // Returns:
  //   - totalCostCents over the period
  //   - byReason: cents per cause code (spoilage / over_prep / expired / damaged / other)
  //   - topItems: top 10 most wasteful items (by cost) with qty + cost
  //   - trend: daily cents for the chart
  //   - reasonShare: cause share of total cost (% per reason)
  fastify.get<{ Querystring: { from?: string; to?: string } }>(
    '/waste-analytics',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const to   = req.query.to   ? new Date(req.query.to)   : new Date()
      const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 86_400_000)

      const logs = await prisma.wasteLog.findMany({
        where: {
          recordedAt: { gte: from, lte: to },
          // Company scoping via the wasted item's tenant (null = shared item).
          inventoryItem: { OR: [{ tenantId: req.staffUser!.tenantFilter }, { tenantId: null }] },
        },
        select: {
          quantity: true, reason: true, estimatedCostCents: true, recordedAt: true,
          inventoryItem: { select: { id: true, name: true, unit: true, unitCostCents: true } },
        },
      })

      const costFor = (l: { estimatedCostCents: number | null; quantity: number; inventoryItem: { unitCostCents: number | null } }) =>
        l.estimatedCostCents ?? Math.round(l.quantity * (l.inventoryItem.unitCostCents ?? 0))

      const totalCostCents = logs.reduce((s, l) => s + costFor(l), 0)
      const totalQty       = logs.reduce((s, l) => s + l.quantity, 0)

      // By reason
      const byReason: Record<string, { count: number; quantity: number; costCents: number }> = {}
      for (const l of logs) {
        const r = byReason[l.reason] ?? { count: 0, quantity: 0, costCents: 0 }
        r.count += 1
        r.quantity += l.quantity
        r.costCents += costFor(l)
        byReason[l.reason] = r
      }
      const reasonShare = Object.fromEntries(
        Object.entries(byReason).map(([k, v]) => [k, totalCostCents > 0 ? Number(((v.costCents / totalCostCents) * 100).toFixed(1)) : 0]),
      )

      // Top wasteful items
      const itemMap = new Map<string, { id: string; name: string; unit: string; quantity: number; costCents: number; count: number }>()
      for (const l of logs) {
        const key = l.inventoryItem.id
        const prev = itemMap.get(key) ?? { id: key, name: l.inventoryItem.name, unit: l.inventoryItem.unit, quantity: 0, costCents: 0, count: 0 }
        prev.quantity += l.quantity
        prev.costCents += costFor(l)
        prev.count += 1
        itemMap.set(key, prev)
      }
      const topItems = [...itemMap.values()].sort((a, b) => b.costCents - a.costCents).slice(0, 10)

      // Daily trend
      const trendMap: Record<string, number> = {}
      for (const l of logs) {
        const day = l.recordedAt.toISOString().slice(0, 10)
        trendMap[day] = (trendMap[day] ?? 0) + costFor(l)
      }
      const trend = Object.entries(trendMap).sort(([a], [b]) => a.localeCompare(b)).map(([day, cents]) => ({ day, costCents: cents }))

      return {
        period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        totals: { logs: logs.length, totalCostCents, totalQty: Number(totalQty.toFixed(2)) },
        byReason,
        reasonShare,
        topItems,
        trend,
      }
    },
  )

  // POST /inventory/:id/waste — record spoilage / wastage
  fastify.post<{ Params: { id: string } }>(
    '/:id/waste',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = wasteSchema.parse(req.body)
      const item = await assertInventoryAccess(req, req.params.id)
      // The quantity is taken straight off currentStock, which is held in the
      // item's own unit — 500 "g" off a kg item would remove 500 kg.
      if (body.unit.trim().toLowerCase() !== item.unit.trim().toLowerCase()) {
        throw new AppError('UNIT_MISMATCH', `Log waste of ${item.name} in ${item.unit}, the unit its stock is kept in.`, 422)
      }

      const cost = body.estimatedCostCents ?? (item.unitCostCents ? Math.round(item.unitCostCents * body.quantity) : undefined)

      // Photo enforcement — above the threshold a photo is REQUIRED. Inflated
      // waste logs are a classic theft cover-up; making the photo mandatory
      // above PKR X eliminates the easiest version of that abuse.
      const { getOperationsConfig } = await import('../../lib/setup-config.js')
      const ops = await getOperationsConfig(item.tenantId ?? req.staffUser!.tenantId)
      const threshold = ops?.photoRequiredAboveCents ?? 50000
      if (cost && cost >= threshold && !body.photoUrl) {
        throw new AppError(
          'PHOTO_REQUIRED',
          `Waste above PKR ${(threshold / 100).toFixed(0)} requires a photo. Snap the wasted product before logging.`,
          400,
        )
      }

      // Wasting more than is on hand is always a data error (or a cover-up),
      // and negative stock silently corrupts every variance and COGS figure
      // downstream. The decrement is conditional on having the quantity, so
      // two simultaneous waste logs can't both take the last of it either.
      const wasteLog = await prisma.$transaction(async (tx) => {
        const taken = await tx.inventoryItem.updateMany({
          where: { id: req.params.id, deletedAt: null, currentStock: { gte: body.quantity } },
          data: { currentStock: { decrement: body.quantity } },
        })
        if (taken.count === 0) {
          throw new AppError(
            'NEGATIVE_STOCK',
            `Cannot waste ${body.quantity} ${body.unit} of ${item.name} — only ${item.currentStock} on hand. Recount first.`,
            422,
          )
        }
        return tx.wasteLog.create({
          data: {
            inventoryItemId: req.params.id,
            quantity: body.quantity,
            unit: body.unit,
            reason: body.reason,
            estimatedCostCents: cost,
            photoUrl: body.photoUrl ?? null,
            notes: body.notes,
            recordedById: req.staffUser?.id,
          },
          include: { inventoryItem: { select: { name: true, unit: true } } },
        })
      })

      const { postWasteLog } = await import('../accounting/supplierPosting.js')
      postWasteLog(wasteLog.id).catch((err) =>
        req.log.error({ err: (err as Error).message, wasteLogId: wasteLog.id }, 'postWasteLog failed'),
      )

      return reply.status(201).send(wasteLog)
    },
  )
}
