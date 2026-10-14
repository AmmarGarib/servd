import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import type { Prisma, UserRole } from '@prisma/client'
import { requireAuth, MANAGERS, PROCUREMENT_TEAM, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { assertConceptOwned, resolveTenantScope } from '../../lib/tenantScope.js'
import { belowParWhere, isBelowPar } from '../../lib/recipeCost.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { INVENTORY_CATEGORIES, costClassOf, COST_CLASSES } from '../../lib/inventoryClass.js'
import { assertInt4Fits, sumCents } from '../../lib/money.js'
import { consumeFifoTx, ensureFifoReady, lockItemsTx, reclassItemLotsTx, STOCK_SOURCE } from '../../lib/stockLedger.js'
import { postInventoryDocInSavepoint, postItemReclassTx, WASTE_SOURCE_TYPE } from '../accounting/inventoryPosting.js'
import { flagPostingFailed, type PostingFailure } from '../accounting/journal.js'
import { assertLocationOfCompany } from '../financePlanning/companyRefs.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { audit } from '../../lib/audit.js'

// ─── One ingredient master, per company (owner decision 30, 2026-09-27) ──────
//
// /sourcing (the catalogue + price sheet) and /inventory (stock on hand) are
// two views of the SAME InventoryItem rows and both create through POST
// /inventory, which binds the new row to the operator's active company. There
// is no "shared" item any more: a company-less item's waste never reached the
// ledger and one company's deliveries re-priced the other company's recipes.
// Legacy company-less rows stay visible (tagged "No company") until they are
// assigned with PATCH /inventory/:id { tenantId } — see GET /unassigned. An
// item that holds stock gets an OPENING count in its new company in the same
// transaction (crosschecks/routes.ts recordPhysicalCountTx — the one opening
// path), so its stock lands on FIFO lots and in the books at once.
//
// Cost = the price actually paid (finance wave B, FIFO lots, H16):
// unitCostCents is the FIFO HEAD cost — the oldest open lot, kept fresh by
// lib/stockLedger.ts. A typed price is an opening estimate only while the item
// has no lots and no deliveries (422 COST_FROM_DELIVERIES after that), and
// every manual cost write lands in ItemPriceHistory as 'manual_adjust'.
// costSource: 'deliveries' = from lots / deliveries, 'opening' = the estimate.
//
// ─── No stock change without a record (owner decision 28) ────────────────────
//
// Stock on hand changes only through a count (POST /crosschecks/physical-
// counts), a waste log (POST /inventory/:id/waste), a delivery (receiving), a
// prep batch, a transfer's transit loss or a sale — every one through
// lib/stockLedger.ts. The +/- and bulk "set to" adjust route is gone and
// neither create nor PATCH accepts currentStock.

// ─── Who does what here (wave 3, audit UI-10) ───────────────────────────────
//
// The sidebar and the API agree: a role that holds the `inventory` module by
// default (lib/moduleAccess.ts) can use the Inventory pages.
//   • boh (line cook) — reads stock, the low-stock list and the waste log,
//     and logs waste. Counts and prep batches are /crosschecks. It sees NO
//     cost and NO supplier: those fields come back null with costsHidden.
//   • procurement (the buyer) — reads stock with costs, and keeps the item
//     master: the Sourcing sheet's add / edit (name, unit, supplier, par,
//     opening cost of a never-delivered item). It does not log waste.
//   • managers — everything, including the waste cost dashboard and the
//     company-less legacy rows (seeing them, assigning them a company).
//   boh and procurement never see, edit or waste a company-less row (see
//   inventoryTenantWhere / assertInventoryAccess), and nobody wastes one
//   until it has a company — its waste could not reach any ledger.
// kitchen / expediter hold no inventory module and stay out.
export const STOCK_READERS = [...PROCUREMENT_TEAM, 'boh'] as UserRole[]
export const ITEM_MASTER_EDITORS = PROCUREMENT_TEAM
export const WASTE_LOGGERS = [...MANAGERS, 'boh'] as UserRole[]

/**
 * Who may record an OPENING count (H19 — stock found by the first count books
 * to the owner's capital, never cost of sales; critic: not the floor
 * managers), and who may give a company to a company-less item that holds
 * stock (that creates the opening count). crosschecks/routes.ts reads it.
 */
export const OPENING_COUNT_ROLES = ['admin', 'owner', 'management', 'finance'] as UserRole[]
// Finance reads stock and its value (read-only), and gives a company-less
// item its company — nothing else here.
const ITEM_READERS = [...STOCK_READERS, 'finance'] as UserRole[]
const ITEM_PATCHERS = [...ITEM_MASTER_EDITORS, 'finance'] as UserRole[]
// The waste dashboard: managers, finance, and the kitchen (quantities only).
const WASTE_ANALYTICS_READERS = [...MANAGERS, 'finance', 'boh'] as UserRole[]
// The value of stock on hand: the financial viewers and the stock keepers.
const VALUE_VIEWERS = new Set<string>([...FINANCIALS_VIEWERS, ...MANAGERS])
/** Waste reasons staff may log. The sold-line reasons, transit_loss and remake are written by the system only. */
export const STAFF_WASTE_REASONS = ['spoilage', 'over_prep', 'expired', 'damaged', 'other'] as const
const TX_OPTS = { maxWait: 10_000, timeout: 30_000 }
const STOCK_EPS = 1e-9

// Kitchen floor roles see stock and recipes without what they cost, what
// they sell for against cost, or who supplies them — the same rule as the
// KDS recipe card (GET /recipes/by-item). Exported for the recipe routes.
const COSTS_HIDDEN_ROLES = new Set<string>(['boh', 'kitchen', 'expediter'])
export function costsHiddenFor(req: FastifyRequest): boolean {
  return COSTS_HIDDEN_ROLES.has(req.staffUser!.role)
}

/** An inventory row with cost and supplier taken out, for a kitchen floor role. */
function withoutCosts<T extends object>(item: T) {
  return {
    ...item,
    unitCostCents: null, listPriceCents: null, supplierId: null, supplier: null, costSource: null,
    costsHidden: true as const,
  }
}

// Company-less legacy rows are a manager's clean-up worklist (assign a company
// via PATCH, see GET /inventory/unassigned). The roles let in by wave 3 — boh
// and procurement — never see, edit or waste them: those rows are shared stock
// another company's recipes may draw on, and a write to one reaches no ledger.
function isInventoryManager(req: FastifyRequest): boolean {
  return (MANAGERS as string[]).includes(req.staffUser!.role)
}

// Tenant filter for inventory reads (GET /inventory, GET /inventory/waste-logs).
// View-aware company scope; managers also get the company-less legacy rows
// (tagged "No company" in the UI). An empty scope DENIES for everyone.
async function inventoryTenantWhere(req: FastifyRequest) {
  const scope = await resolveTenantScope(req)
  if (scope.tenantIds.length === 0) return { tenantId: { in: [] as string[] } }
  if (!isInventoryManager(req)) return { tenantId: { in: scope.tenantIds } }
  return {
    OR: [
      { tenantId: { in: scope.tenantIds } },
      { tenantId: null },
    ],
  }
}

const NO_COMPANY_MESSAGE = 'This ingredient has no company yet. A manager assigns it one first (Inventory → Unassigned).'

// Editing an existing item: allowed for any company the operator belongs to
// ('write' mode). A foreign item is a 404 so its id isn't confirmed.
// Company-less legacy rows are editable by managers only, so they can be
// assigned; anyone else gets 422 ITEM_HAS_NO_COMPANY.
async function assertInventoryAccess(req: FastifyRequest, itemId: string) {
  const item = await prisma.inventoryItem.findFirst({
    where: { id: itemId, deletedAt: null },
  })
  if (!item) throw new NotFoundError('InventoryItem', itemId)
  if (item.tenantId && !req.staffUser!.memberTenantIds.includes(item.tenantId)) {
    throw new NotFoundError('InventoryItem', itemId)
  }
  if (!item.tenantId && !isInventoryManager(req) && !(OPENING_COUNT_ROLES as string[]).includes(req.staffUser!.role)) {
    throw new AppError('ITEM_HAS_NO_COMPANY', NO_COMPANY_MESSAGE, 422)
  }
  return item
}

/** Items that hold (or held) FIFO lots — their cost comes from those lots. */
async function itemIdsWithLots(itemIds: string[]): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set()
  const rows = await prisma.stockLot.findMany({ where: { inventoryItemId: { in: itemIds } }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'] })
  return new Set(rows.map((r) => r.inventoryItemId))
}

/** Σ open lot value per item (paisa). */
async function onHandValueByItem(itemIds: string[]): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map()
  const rows = await prisma.stockLot.groupBy({
    by: ['inventoryItemId'],
    where: { inventoryItemId: { in: itemIds }, remainingQty: { gt: 0.000001 } },
    _sum: { remainingValueCents: true },
  })
  return new Map(rows.map((r) => [r.inventoryItemId, sumCents(r._sum.remainingValueCents)]))
}

/** Raise a refused stock posting AFTER commit, with the document's date (the period-close check reads it). */
async function flagRefused(failure: PostingFailure | null, documentDate: Date): Promise<void> {
  if (!failure) return
  await flagPostingFailed({ ...failure, metadata: { ...(failure.metadata ?? {}), documentDate: documentDate.toISOString() } })
}

// Has this item ever been delivered? Once it has (or it holds lots), its cost
// is what deliveries cost and nothing typed on the sheet may overwrite it.
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

// No cost field: what wasted stock cost is the server's figure (the FIFO value
// of the lots it was taken from), never the client's. A typed
// `estimatedCostCents` used to win — PKR 1 typed for 5 kg of beef dodged the
// photo rule and booked PKR 1 to the ledger (2026-10-10 audit, BOH-07). An old
// client that still sends one has it ignored; the response carries the real
// figure. `reason` is required — the CEO reads it before the cost is settled
// (H20).
const wasteSchema = z.object({
  quantity: z.number().positive(),
  unit: z.string().min(1),
  reason: z.enum(STAFF_WASTE_REASONS),
  photoUrl: z.string().url().nullable().optional(),
  notes: z.string().max(1000).optional(),
  // The brand charged (one of the item's company's, through the active
  // company). Without it the cost is split by each brand's recipe use (H20).
  conceptId: z.string().uuid().nullable().optional(),
  // The outlet (one of the item's company's). Per-outlet stock is the next build.
  locationId: z.string().uuid().nullable().optional(),
})

const createItemSchema = z.object({
  name: z.string().min(1),
  unit: z.string().min(1),
  parLevel: z.number().min(0).default(0),
  // Opening cost estimate in paisa per purchase unit. The FIFO head cost
  // replaces it once the item has lots.
  unitCostCents: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
  // The category decides the cost class (lib/inventoryClass.ts): food /
  // drinks / packaging and their ledger accounts. Anything else is 400.
  category: z.enum(INVENTORY_CATEGORIES).nullable().optional(),
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
  // The estimate of an item with no lots / deliveries; when assigning a
  // company to a company-less item that holds stock, the opening unit cost.
  unitCostCents: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
  category: z.enum(INVENTORY_CATEGORIES).nullable().optional(),
  // Unmeasured consumables (oil, salt): each receipt is issued straight to
  // cost of sales. Managers with the inventory module; audited.
  issueOnReceipt: z.boolean().optional(),
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
  // come through tagged with a "No company" chip in the UI (managers only).
  // unitCostCents is the FIFO head cost; onHandValueCents (Σ open lot value)
  // only for the financial viewers and the stock keepers.
  type ListedItem = Prisma.InventoryItemGetPayload<{ include: { supplier: { select: { name: true } }; tenant: { select: { id: true; name: true; slug: true } } } }>
  async function shapeItems(req: FastifyRequest, items: ListedItem[]) {
    const hide = costsHiddenFor(req)
    const ids = items.map((i) => i.id)
    const [delivered, withLots, values] = hide
      ? [new Set<string>(), new Set<string>(), new Map<string, number>()]
      : await Promise.all([
          deliveredItemIds(ids),
          itemIdsWithLots(ids),
          VALUE_VIEWERS.has(req.staffUser!.role) ? onHandValueByItem(ids) : Promise.resolve(new Map<string, number>()),
        ])
    const showValue = !hide && VALUE_VIEWERS.has(req.staffUser!.role)
    return items.map((item) => {
      const row = {
        ...item,
        // 'deliveries' = the cost comes from FIFO lots / what deliveries cost;
        // 'opening' = a typed estimate for an item with neither.
        costSource: delivered.has(item.id) || withLots.has(item.id) ? 'deliveries' as const : 'opening' as const,
        ...(showValue ? { onHandValueCents: values.get(item.id) ?? 0 } : {}),
        // THE below-par rule (lib/recipeCost.ts) — no par set is never low.
        isLowStock: isBelowPar(item),
        stockPercentage: item.parLevel > 0 ? (item.currentStock / item.parLevel) * 100 : 100,
      }
      return hide ? withoutCosts(row) : row
    })
  }
  const LIST_INCLUDE = {
    supplier: { select: { name: true } },
    tenant:   { select: { id: true, name: true, slug: true } },
  } as const

  fastify.get('/', { preHandler: requireAuth(...ITEM_READERS) }, async (req) => {
    const tenantWhere = await inventoryTenantWhere(req)
    const items = await prisma.inventoryItem.findMany({
      where: { deletedAt: null, ...tenantWhere },
      include: LIST_INCLUDE,
      orderBy: { name: 'asc' },
    })
    return shapeItems(req, items)
  })

  // POST /inventory — the ONE way to add an ingredient (Sourcing sheet and
  // Inventory page both call it). Bound to one company: the active company,
  // or the portfolio picker's choice when it is a company the operator
  // belongs to. Never company-less.
  fastify.post('/', { preHandler: requireAuth(...ITEM_MASTER_EDITORS) }, async (req, reply) => {
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
  // supplier; the estimate of an item with no lots and no deliveries
  // (recorded in price history); issue-on-receipt (managers with the
  // inventory module, audited); and assigning a company to a legacy
  // company-less item. Stock on hand is NOT editable here.
  //   • A category change that moves the item to another cost class moves the
  //     value of its open lots with it, in the same transaction:
  //     'inventory.item_reclass:<itemId>:<auditLogId>' Dr new class / Cr old.
  //   • Assigning a company to an item that HOLDS stock (CEO, owner,
  //     management, finance) records an opening count in that company in the
  //     same transaction (the one opening path) — its stock goes onto a lot
  //     and Dr class inventory / Cr capital, once.
  //   Finance may do only the assignment here.
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...ITEM_PATCHERS) },
    async (req) => {
      rejectStockWrites(req.body, { allowZero: false })
      const role = req.staffUser!.role
      const item = await assertInventoryAccess(req, req.params.id)
      const { tenantId, issueOnReceipt, ...data } = updateItemSchema.parse(req.body)
      const assigning = tenantId !== undefined && tenantId !== item.tenantId

      if (!(ITEM_MASTER_EDITORS as string[]).includes(role)) {
        const others = Object.keys(data).filter((k) => k !== 'unitCostCents')
        if (!assigning || item.tenantId || others.length > 0 || issueOnReceipt !== undefined) {
          throw new ForbiddenError('Finance can only give a company-less ingredient its company here.')
        }
      }

      if (assigning) {
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
      const holdsStock = assigning && item.currentStock > STOCK_EPS
      if (assigning) {
        if (holdsStock && !(OPENING_COUNT_ROLES as string[]).includes(role)) {
          throw new AppError(
            'OPENING_COUNT_ROLE',
            `${item.name} holds stock: giving it a company books that stock as an opening count, which only finance, the CEO or management can do.`,
            403,
          )
        }
        // Giving a legacy row a company is the managers' (and finance's)
        // clean-up job, never the buyer's.
        if (!holdsStock && !isInventoryManager(req) && !(OPENING_COUNT_ROLES as string[]).includes(role)) {
          throw new ForbiddenError('Only a manager assigns a company to an ingredient.')
        }
      }
      const finalTenant = tenantId ?? item.tenantId
      if (data.supplierId && finalTenant) await assertSupplierFits(data.supplierId, finalTenant)

      // On an assignment with stock, unitCostCents is the opening unit cost
      // (the lot sets the item's cost) — never a typed estimate.
      const openingCost = holdsStock ? data.unitCostCents ?? null : null
      if (holdsStock) delete data.unitCostCents
      const costChanges = data.unitCostCents !== undefined && data.unitCostCents !== item.unitCostCents
      if (costChanges) {
        if (await hasDeliveries(item.id) || (await itemIdsWithLots([item.id])).has(item.id)) {
          throw new AppError(
            'COST_FROM_DELIVERIES',
            `${item.name} has stock lots or deliveries, so its cost is the price actually paid for them. It changes when stock is received, not here.`,
            422,
          )
        }
        if (data.unitCostCents == null) {
          throw new AppError('COST_REQUIRED', 'An opening cost can be changed but not cleared.', 422)
        }
      }

      const iorChanges = issueOnReceipt !== undefined && issueOnReceipt !== item.issueOnReceipt
      if (iorChanges) {
        if (!isInventoryManager(req)) throw new ForbiddenError('Only a manager sets an ingredient to be issued on receipt.')
        const u = await prisma.user.findUnique({ where: { id: req.staffUser!.id }, select: { moduleAllow: true, moduleDeny: true } })
        const modules = await effectiveModulesForUser({ role: role as UserRole, moduleAllow: u?.moduleAllow ?? [], moduleDeny: u?.moduleDeny ?? [] })
        if (!modules.has('inventory')) throw new ForbiddenError('Your account does not have the inventory module. Ask the CEO to enable it in Module Access.')
      }

      // A category change across cost classes on an item of a company: its lots move class.
      const fromClass = costClassOf(item.category)
      const toClass = data.category !== undefined ? costClassOf(data.category) : fromClass
      const reclass = !!item.tenantId && fromClass !== toClass
      if (reclass) await ensureFifoReady(item.tenantId!)
      if (holdsStock) await ensureFifoReady(tenantId!)

      const { updated, opening } = await prisma.$transaction(async (tx) => {
        await lockItemsTx(tx, [item.id])
        if (assigning) {
          const fresh = await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id }, select: { tenantId: true } })
          if (fresh.tenantId) throw new AppError('ITEM_HAS_COMPANY', 'This ingredient already belongs to a company.', 422)
        }
        if (reclass) {
          const auditRow = await tx.auditLog.create({
            data: {
              category: 'accounting', tenantId: item.tenantId, action: 'inventory.category_change', entity: 'InventoryItem', entityId: item.id,
              userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null,
              before: { category: item.category, costClass: fromClass }, after: { category: data.category ?? null, costClass: toClass },
            },
            select: { id: true },
          })
          const moved = await reclassItemLotsTx(tx, {
            tenantId: item.tenantId!, itemId: item.id, toClass, sourceType: 'inventory.item_reclass', sourceId: auditRow.id, createdById: req.staffUser!.id,
          })
          for (const c of COST_CLASSES) {
            if (moved.byFromClass[c] !== 0) {
              await postItemReclassTx(tx, { itemId: item.id, auditLogId: auditRow.id, fromClass: c, toClass, valueCents: moved.byFromClass[c] })
            }
          }
        }
        const row = await tx.inventoryItem.update({
          where: { id: item.id },
          data: {
            ...data,
            ...(iorChanges ? { issueOnReceipt } : {}),
            ...(assigning ? { tenantId } : {}),
            // A company-less row's negative stock was never real: it starts at zero in its company.
            ...(assigning && item.currentStock < -STOCK_EPS ? { currentStock: 0 } : {}),
          },
          include: { tenant: { select: { id: true, name: true, slug: true } } },
        })
        if (costChanges) {
          await tx.itemPriceHistory.create({
            data: { inventoryItemId: item.id, oldCostCents: item.unitCostCents, newCostCents: data.unitCostCents!, source: 'manual_adjust' },
          })
        }
        if (!holdsStock) return { updated: row, opening: null }
        const { recordPhysicalCountTx } = await import('../crosschecks/routes.js')
        const r = await recordPhysicalCountTx(tx, {
          tenantId: tenantId!, kind: 'opening', assignment: true, locationId: null, actorId: req.staffUser!.id,
          notes: `Opening stock: ${item.name} was given its company (it held ${item.currentStock} ${item.unit} with no company)`,
          lines: [{ inventoryItemId: item.id, physicalQty: item.currentStock, reason: 'company assigned', unitCostCents: openingCost }],
        })
        const after = await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id }, include: { tenant: { select: { id: true, name: true, slug: true } } } })
        return { updated: after, opening: r }
      }, TX_OPTS)

      if (opening) {
        const { raiseCountFlags } = await import('../crosschecks/routes.js')
        await raiseCountFlags(opening, req.staffUser!.id)
      }
      if (assigning) {
        await audit({
          category: 'identity', action: 'inventory.assign_company', entity: 'InventoryItem', entityId: item.id,
          userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: tenantId!,
          before: { tenantId: null, currentStock: item.currentStock }, after: { tenantId, openingCountId: opening?.count.id ?? null },
        })
      }
      if (iorChanges) {
        await audit({
          category: 'identity', action: 'inventory.issue_on_receipt', entity: 'InventoryItem', entityId: item.id,
          userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: updated.tenantId,
          before: { issueOnReceipt: item.issueOnReceipt }, after: { issueOnReceipt },
        })
      }
      return opening ? { ...updated, openingCount: { id: opening.count.id, ledger: opening.ledger } } : updated
    },
  )

  // GET /inventory/:id — one item, same shape as the list (404 for another
  // company's; company-less rows to managers only).
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ITEM_READERS) }, async (req) => {
    const item = await prisma.inventoryItem.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await inventoryTenantWhere(req)) },
      include: LIST_INCLUDE,
    })
    if (!item) throw new NotFoundError('InventoryItem', req.params.id)
    return (await shapeItems(req, [item]))[0]
  })

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
  fastify.get('/alerts', { preHandler: requireAuth(...STOCK_READERS) }, async (req) => {
    const scope = await resolveTenantScope(req)
    const rows = await prisma.inventoryItem.findMany({
      where: { deletedAt: null, tenantId: { in: scope.tenantIds }, ...belowParWhere() },
      include: {
        supplier: { select: { name: true, phone: true } },
        tenant:   { select: { id: true, name: true, slug: true } },
      },
      orderBy: { name: 'asc' },
    })
    return costsHiddenFor(req) ? rows.map(withoutCosts) : rows
  })

  // GET /inventory/waste-logs — waste history with optional filters
  fastify.get<{ Querystring: { inventoryItemId?: string; dateFrom?: string; dateTo?: string; limit?: string } }>(
    '/waste-logs',
    { preHandler: requireAuth(...STOCK_READERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10) || 100, 500)
      const from = req.query.dateFrom ? new Date(req.query.dateFrom) : undefined
      const to = req.query.dateTo ? new Date(req.query.dateTo) : undefined
      const logs = await prisma.wasteLog.findMany({
        where: {
          ...(req.query.inventoryItemId && { inventoryItemId: req.query.inventoryItemId }),
          ...(from || to ? { recordedAt: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {}),
          // Company scoping via the wasted item's tenant — the same view-aware
          // scope as GET /inventory: an empty scope denies, and company-less
          // legacy items show to managers only.
          inventoryItem: await inventoryTenantWhere(req),
        },
        include: {
          inventoryItem: { select: { name: true, unit: true, unitCostCents: true } },
          recordedBy: { select: { name: true } },
        },
        orderBy: { recordedAt: 'desc' },
        take: limit,
      })
      if (!costsHiddenFor(req)) return logs
      return logs.map((l) => ({
        ...l,
        estimatedCostCents: null,
        inventoryItem: { ...l.inventoryItem, unitCostCents: null },
        costsHidden: true as const,
      }))
    },
  )

  // GET /inventory/waste-analytics — aggregated waste for the dashboard.
  // Returns:
  //   - totalCostCents over the period
  //   - byReason: cents per cause code (spoilage / over_prep / expired / damaged / other,
  //     and the system reasons: void_after_fire, cancelled_after_fire, remake, transit_loss)
  //   - topItems: top 10 most wasteful items (by cost) with qty + cost
  //   - trend: daily cents for the chart
  //   - reasonShare: cause share of total cost (% per reason)
  // Company scope: the view-aware scope by the waste log's own company (a
  // pre-wave-B log without one: its item's) — an empty scope sees nothing, and
  // company-less items are never included. Floor roles get quantities only.
  fastify.get<{ Querystring: { from?: string; to?: string } }>(
    '/waste-analytics',
    { preHandler: requireAuth(...WASTE_ANALYTICS_READERS) },
    async (req) => {
      const to   = req.query.to   ? new Date(req.query.to)   : new Date()
      const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 86_400_000)
      if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) throw new AppError('BAD_DATE', 'from / to must be dates', 400)
      const scope = await resolveTenantScope(req)
      const inScope = { in: scope.tenantIds }

      const logs = await prisma.wasteLog.findMany({
        where: {
          recordedAt: { gte: from, lte: to },
          inventoryItem: { tenantId: inScope },
          OR: [{ tenantId: inScope }, { tenantId: null }],
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
      const topItems = [...itemMap.values()].sort((a, b) => b.costCents - a.costCents || b.quantity - a.quantity).slice(0, 10)

      // Daily trend
      const trendMap: Record<string, { costCents: number; count: number }> = {}
      for (const l of logs) {
        const day = l.recordedAt.toISOString().slice(0, 10)
        const t = trendMap[day] ?? { costCents: 0, count: 0 }
        t.costCents += costFor(l)
        t.count += 1
        trendMap[day] = t
      }
      const trend = Object.entries(trendMap).sort(([a], [b]) => a.localeCompare(b)).map(([day, t]) => ({ day, costCents: t.costCents, count: t.count }))

      const period = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
      if (costsHiddenFor(req)) {
        return {
          period,
          totals: { logs: logs.length, totalCostCents: null, totalQty: Number(totalQty.toFixed(2)) },
          byReason: Object.fromEntries(Object.entries(byReason).map(([k, v]) => [k, { count: v.count, quantity: v.quantity, costCents: null }])),
          reasonShare: null,
          topItems: topItems.map((t) => ({ ...t, costCents: null })),
          trend: trend.map((t) => ({ day: t.day, costCents: null, count: t.count })),
          costsHidden: true as const,
        }
      }
      return {
        period,
        totals: { logs: logs.length, totalCostCents, totalQty: Number(totalQty.toFixed(2)) },
        byReason,
        reasonShare,
        topItems,
        trend,
      }
    },
  )

  // POST /inventory/:id/waste — record spoilage / wastage. The quantity
  // leaves the item's FIFO lots, oldest first ('waste'), at the value of
  // those lots: that value is the WasteLog's estimatedCostCents, drives the
  // photo rule, and posts 'inventory.waste:<id>' (Dr 5040 / Cr the class
  // inventory — accounting/inventoryPosting.ts postWasteLog, the one waste
  // posting) behind a savepoint: a refused posting never undoes the waste the
  // kitchen logged — it is flagged posting_failed and re-posted by
  // Reconciliation → Backfill unposted.
  fastify.post<{ Params: { id: string } }>(
    '/:id/waste',
    { preHandler: requireAuth(...WASTE_LOGGERS) },
    async (req, reply) => {
      const body = wasteSchema.parse(req.body)
      const item = await assertInventoryAccess(req, req.params.id)
      // Waste on a company-less item would drop shared stock with no journal
      // entry (it has no company to post to, and no lots). Assign it first.
      if (!item.tenantId) throw new AppError('ITEM_HAS_NO_COMPANY', NO_COMPANY_MESSAGE, 422)
      const tenantId = item.tenantId
      // The quantity is taken straight off the lots, which are held in the
      // item's own unit — 500 "g" off a kg item would remove 500 kg.
      if (body.unit.trim().toLowerCase() !== item.unit.trim().toLowerCase()) {
        throw new AppError('UNIT_MISMATCH', `Log waste of ${item.name} in ${item.unit}, the unit its stock is kept in.`, 422)
      }
      // A brand charged must be one the operator can create under (the active
      // company — 404 otherwise) AND the item's company (422).
      let conceptId: string | null = null
      if (body.conceptId) {
        const c = await assertConceptOwned(req, body.conceptId, 'create')
        if (c.tenantId !== tenantId) {
          throw new AppError('BRAND_NOT_IN_COMPANY', 'That brand belongs to another company than this ingredient — waste is charged inside the item\'s company.', 422)
        }
        conceptId = c.id
      }
      const locationId = body.locationId ?? null
      if (locationId) await assertLocationOfCompany(tenantId, locationId)

      // Photo enforcement — above the threshold a photo is REQUIRED. Inflated
      // waste logs are a classic theft cover-up; making the photo mandatory
      // above PKR X eliminates the easiest version of that abuse.
      const { getOperationsConfig } = await import('../../lib/setup-config.js')
      const ops = await getOperationsConfig(tenantId)
      const threshold = ops?.photoRequiredAboveCents ?? 50000
      const hide = costsHiddenFor(req)
      const actorId = req.staffUser?.id ?? null

      await ensureFifoReady(tenantId)
      const wasteLogId = randomUUID()
      const { log, ledger, failure } = await prisma.$transaction(async (tx) => {
        await lockItemsTx(tx, [item.id])
        const recordedAt = new Date()
        // Wasting more than is on hand is always a data error (or a cover-up):
        // no clamp — 422 NEGATIVE_STOCK and nothing is written.
        const r = await consumeFifoTx(tx, {
          tenantId, inventoryItemId: item.id, qty: body.quantity, kind: 'waste', sourceType: STOCK_SOURCE.wasteLog, sourceId: wasteLogId,
          clamp: false, conceptId, locationId, occurredAt: recordedAt, createdById: actorId,
        })
        const cost = r.valueCents
        if (cost >= threshold && !body.photoUrl) {
          throw new AppError(
            'PHOTO_REQUIRED',
            hide
              // A line cook is not told what the item costs — only that a photo is needed.
              ? `Waste of ${body.quantity} ${item.unit} of ${item.name} needs a photo. Snap the wasted product before logging.`
              : `Waste of ${body.quantity} ${item.unit} of ${item.name} is worth PKR ${Math.round(cost / 100).toLocaleString('en-PK')}. `
                + `Waste above PKR ${(threshold / 100).toFixed(0)} requires a photo. Snap the wasted product before logging.`,
            400,
          )
        }
        assertInt4Fits(cost, `The waste of ${item.name}`)
        const created = await tx.wasteLog.create({
          data: {
            id: wasteLogId, tenantId, conceptId, locationId,
            inventoryItemId: item.id,
            quantity: body.quantity,
            unit: body.unit,
            reason: body.reason,
            estimatedCostCents: cost,
            photoUrl: body.photoUrl ?? null,
            notes: body.notes,
            recordedById: actorId,
            recordedAt,
          },
          include: { inventoryItem: { select: { name: true, unit: true } } },
        })
        const post = await postInventoryDocInSavepoint(tx, WASTE_SOURCE_TYPE, created.id, { tenantId, actorId, conceptId, amountCents: cost })
        return { log: created, ledger: post.ledger, failure: post.failure }
      }, TX_OPTS)
      if (failure) {
        req.log.error({ err: failure.reason, wasteLogId: log.id }, 'postWasteLog failed')
        await flagRefused({ ...failure, title: `Waste of ${item.name} did not reach the ledger` }, log.recordedAt)
      }

      const out = { ...log, ledger }
      return reply.status(201).send(hide ? { ...out, estimatedCostCents: null, costsHidden: true } : out)
    },
  )

}
