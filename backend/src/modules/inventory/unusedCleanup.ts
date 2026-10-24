// Remove ingredients that are in no recipe (owner, 2026-10-16: "And inside the
// sheet, remove all ingredients that are not yet in a recipe" → "Delete them":
// move every unused ingredient to the Trash (recoverable); ingredients holding
// stock or with purchase history are skipped and listed).
//
//   GET  /inventory/unused-cleanup          preview: { toMove[], skipped[], counts }
//   POST /inventory/unused-cleanup {itemIds} apply:   { moved[], skipped[], counts }
//
// CEO only (role admin). Company = the ACTIVE company (activeTenantId); another
// company's ids and company-less legacy rows are never touched (they come back
// as skipped "Not an ingredient of this company").
//
// "Used" = referenced by anything that consumes the item:
//   recipe_ingredients (plate, sub-recipe and add-on recipes, both the
//   Ingredients and the Packaging sections), a recipe sitting in the Trash
//   (its snapshot's lines — restoring it would point at a trashed item), the
//   component planning library (components.baseIngredientId) and prep batch
//   inputs (prep_batches.inputs JSON).
// "Stock" = currentStock ≠ 0 or any lot with remainingQty > 0.
// "Purchase / stock history" = PO lines, goods-receipt lines, supplier bill
//   lines, petty-cash spend lines, stock lots, stock movements, count lines,
//   waste logs, stock transfers, or a non-manual price-history row.
//
// Apply runs ONE transaction PER ITEM: lock the item row (lib/stockLedger.ts
// lockItemsTx, the lock every stock write takes), re-check it, then
// moveToTrash + deletedAt in that same transaction (strategy soft, provider
// `inventory_item` in modules/trash/providers/masters/inventory.ts). Per item
// so one item that became used (or a refused write) never blocks the rest of
// a few-hundred-row clean-up; each item's park is still all-or-nothing. One
// audit row per run (`inventory.unused_cleanup`) with the counts.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { activeTenantId } from '../../lib/tenantScope.js'
import { lockItemsTx } from '../../lib/stockLedger.js'
import { moveToTrash } from '../../lib/trash.js'
import { audit } from '../../lib/audit.js'
import { AppError } from '../../lib/errors.js'

export const INVENTORY_ITEM_TRASH = 'inventory_item'
const EPS = 1e-9
const MAX_IDS = 5000
const TX_OPTS = { maxWait: 10_000, timeout: 30_000 }

type Db = Prisma.TransactionClient | typeof prisma

export interface ItemUsage {
  /** Why it counts as in use (skip). */
  used: string[]
  /** Stock on hand (skip). */
  stock: string[]
  /** Purchase / stock history (skip). */
  history: string[]
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Usage of each item id (all ids must be the caller's company's items — the
 * reference tables are keyed by item id only). Ids with no usage map to empty
 * lists. Reads only; run it inside the apply transaction after the item lock.
 */
export async function itemUsage(db: Db, items: Array<{ id: string; currentStock: number }>): Promise<Map<string, ItemUsage>> {
  const out = new Map<string, ItemUsage>(items.map((i) => [i.id, { used: [], stock: [], history: [] }]))
  const ids = items.map((i) => i.id)
  if (ids.length === 0) return out
  const add = (id: string | null, k: keyof ItemUsage, why: string) => { if (id) out.get(id)?.[k].push(why) }

  for (const i of items) if (Math.abs(i.currentStock) > EPS) add(i.id, 'stock', `Holds stock (${Math.round(i.currentStock * 1000) / 1000} on hand)`)

  const inIds = { in: ids }
  const [recipeLines, components, openLots, lots, moves, poLines, grnLines, billLines, pettyLines, countLines, waste, transfers, prices] = await Promise.all([
    db.recipeIngredient.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inIds }, _count: { _all: true } }),
    db.component.groupBy({ by: ['baseIngredientId'], where: { baseIngredientId: inIds }, _count: { _all: true } }),
    db.stockLot.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inIds, remainingQty: { gt: EPS } }, _count: { _all: true } }),
    db.stockLot.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inIds }, _count: { _all: true } }),
    db.stockMovement.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inIds }, _count: { _all: true } }),
    db.purchaseOrderLine.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inIds }, _count: { _all: true } }),
    db.goodsReceiptLine.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inIds }, _count: { _all: true } }),
    db.supplierBillLine.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inIds }, _count: { _all: true } }),
    db.pettyCashSpendLine.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inIds }, _count: { _all: true } }),
    db.physicalCountLine.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inIds }, _count: { _all: true } }),
    db.wasteLog.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inIds }, _count: { _all: true } }),
    db.stockTransfer.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inIds }, _count: { _all: true } }),
    db.itemPriceHistory.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inIds, source: { not: 'manual_adjust' } }, _count: { _all: true } }),
  ])
  for (const r of recipeLines) add(r.inventoryItemId, 'used', `In ${plural(r._count._all, 'recipe line')}`)
  for (const r of components) add(r.baseIngredientId, 'used', 'Base ingredient of a component (planning library)')
  for (const r of openLots) add(r.inventoryItemId, 'stock', `${plural(r._count._all, 'open stock lot')}`)
  for (const r of lots) add(r.inventoryItemId, 'history', `${plural(r._count._all, 'stock lot')} received`)
  for (const r of moves) add(r.inventoryItemId, 'history', `${plural(r._count._all, 'stock movement')}`)
  for (const r of poLines) add(r.inventoryItemId, 'history', `On ${plural(r._count._all, 'purchase order line')}`)
  for (const r of grnLines) add(r.inventoryItemId, 'history', `On ${plural(r._count._all, 'goods receipt line')}`)
  for (const r of billLines) add(r.inventoryItemId, 'history', `On ${plural(r._count._all, 'supplier bill line')}`)
  for (const r of pettyLines) add(r.inventoryItemId, 'history', `Bought with petty cash (${plural(r._count._all, 'line')})`)
  for (const r of countLines) add(r.inventoryItemId, 'history', `Counted (${plural(r._count._all, 'count line')})`)
  for (const r of waste) add(r.inventoryItemId, 'history', `${plural(r._count._all, 'waste log')}`)
  for (const r of transfers) add(r.inventoryItemId, 'history', `${plural(r._count._all, 'stock transfer')}`)
  for (const r of prices) add(r.inventoryItemId, 'history', 'Price set by a delivery or bill')

  // JSON references: prep batch inputs and recipes waiting in the Trash.
  const prep = await db.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT e->>'inventoryItemId' AS id
      FROM prep_batches p, jsonb_array_elements(CASE WHEN jsonb_typeof(p.inputs) = 'array' THEN p.inputs ELSE '[]'::jsonb END) e
     WHERE e->>'inventoryItemId' IN (${Prisma.join(ids)})`
  for (const r of prep) add(r.id, 'used', 'Drawn by a prep batch')
  const trashed = await db.$queryRaw<Array<{ id: string; title: string }>>`
    SELECT DISTINCT l->>'inventoryItemId' AS id, t.title
      FROM trash_entries t,
           jsonb_array_elements(CASE WHEN jsonb_typeof(t.snapshot->'children'->'RecipeIngredient') = 'array'
                                     THEN t.snapshot->'children'->'RecipeIngredient' ELSE '[]'::jsonb END) l
     WHERE t."entityType" = 'recipe' AND t."restoredAt" IS NULL AND t."purgedAt" IS NULL
       AND l->>'inventoryItemId' IN (${Prisma.join(ids)})`
  for (const r of trashed) add(r.id, 'used', `In the recipe "${r.title}" (in the Trash)`)
  return out
}

/**
 * Recipe writers call this INSIDE the transaction that writes the lines: it
 * locks the stock items the new lines use FOR SHARE (conflicts with the
 * clean-up's FOR UPDATE, so either the clean-up waits and then sees the line,
 * or the recipe waits and then sees deletedAt) and refuses one parked in the
 * Trash with 422 ITEM_IN_TRASH. Closes the race validateRecipeLines' unlocked
 * read leaves open.
 */
export async function assertItemsNotTrashedTx(tx: Prisma.TransactionClient, itemIds: Array<string | null | undefined>): Promise<void> {
  const ids = [...new Set(itemIds.filter((x): x is string => !!x))].sort()
  if (ids.length === 0) return
  const rows = await tx.$queryRaw<Array<{ id: string; name: string; deletedAt: Date | null }>>`
    SELECT id, name, "deletedAt" FROM inventory_items WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE`
  const parked = rows.find((r) => r.deletedAt)
  if (parked) {
    throw new AppError('ITEM_IN_TRASH', `${parked.name} is in the Trash — restore it from the Trash before using it in a recipe`, 422)
  }
}

const reasonsOf = (u: ItemUsage) => [...u.used, ...u.stock, ...u.history]

export interface CleanupRow { id: string; name: string; unit: string; category: string | null }
export interface SkippedRow extends CleanupRow { reasons: string[] }

async function preview(tenantId: string) {
  const items = await prisma.inventoryItem.findMany({
    // A prep item (made by prep batches, owner 2026-10-24) is never "unused stock" — it belongs to its prep recipe.
    where: { tenantId, deletedAt: null, kind: { not: 'prep' }, prepRecipeId: null },
    select: { id: true, name: true, unit: true, category: true, currentStock: true },
    orderBy: { name: 'asc' },
  })
  const usage = await itemUsage(prisma, items)
  const toMove: CleanupRow[] = []
  const skipped: SkippedRow[] = []
  let inRecipe = 0
  for (const it of items) {
    const u = usage.get(it.id)!
    const row = { id: it.id, name: it.name, unit: it.unit, category: it.category }
    if (u.used.length) { inRecipe++; continue } // in use: not a candidate at all
    if (u.stock.length || u.history.length) skipped.push({ ...row, reasons: reasonsOf(u) })
    else toMove.push(row)
  }
  const company = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } })
  return { company, toMove, skipped, counts: { total: items.length, inUse: inRecipe, toMove: toMove.length, skipped: skipped.length } }
}

const applySchema = z.object({ itemIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_IDS) })

export async function unusedCleanupRoutes(fastify: FastifyInstance) {
  fastify.get('/unused-cleanup', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req: FastifyRequest) => {
    const tenantId = activeTenantId(req, 'the clean-up runs inside one company')
    return preview(tenantId)
  })

  fastify.post('/unused-cleanup', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req: FastifyRequest) => {
    const tenantId = activeTenantId(req, 'the clean-up runs inside one company')
    const ids = [...new Set(applySchema.parse(req.body).itemIds)]
    const moved: CleanupRow[] = []
    const skipped: SkippedRow[] = []
    const reason = 'Not in any recipe — Sourcing sheet clean-up'

    for (const id of ids) {
      try {
        const res = await prisma.$transaction(async (tx) => {
          await lockItemsTx(tx, [id])
          const it = await tx.inventoryItem.findFirst({
            where: { id, tenantId, deletedAt: null, kind: { not: 'prep' }, prepRecipeId: null },
            select: { id: true, name: true, unit: true, category: true, currentStock: true },
          })
          if (!it) return { skip: { id, name: '—', unit: '', category: null, reasons: ['Not a live ingredient of this company'] } }
          const row = { id: it.id, name: it.name, unit: it.unit, category: it.category }
          const u = (await itemUsage(tx, [it])).get(it.id)!
          const why = reasonsOf(u)
          if (why.length) return { skip: { ...row, reasons: why } }
          await moveToTrash(tx, req, { type: INVENTORY_ITEM_TRASH, entityId: it.id, tenantId, title: it.name, subtitle: it.unit, reason })
          await tx.inventoryItem.update({ where: { id: it.id }, data: { deletedAt: new Date() } })
          return { moved: row }
        }, TX_OPTS)
        if ('moved' in res && res.moved) moved.push(res.moved)
        else if ('skip' in res && res.skip) skipped.push(res.skip)
      } catch (err) {
        req.log.error({ err, itemId: id }, 'unused ingredient clean-up: item not moved')
        skipped.push({ id, name: '—', unit: '', category: null, reasons: ['Could not be moved — try again'] })
      }
    }

    const counts = { requested: ids.length, moved: moved.length, skipped: skipped.length }
    await audit({
      category: 'identity', tenantId, action: 'inventory.unused_cleanup', entity: 'inventory_item',
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null,
      metadata: { ...counts, movedIds: moved.map((m) => m.id), skipped: skipped.map((s) => ({ id: s.id, reasons: s.reasons })) },
    })
    return { moved, skipped, counts }
  })
}
