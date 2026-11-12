// Trash provider — stock items (ingredients). One type:
//
//   inventory_item   strategy soft (InventoryItem.deletedAt)
//
// Written by the CEO's "Remove ingredients not in a recipe" clean-up on the
// Sourcing sheet (modules/inventory/unusedCleanup.ts), which parks only items
// with no recipe line, no stock and no purchase / stock history, each with
// moveToTrash in the SAME transaction as its deletedAt.
//
// Restore: clears deletedAt. A live ingredient of the same company with the
// same name (case-insensitive — POST /inventory refuses that duplicate) →
// 409 TRASH_CLASH, renamable with `rename.name`.
// Delete forever (CEO): refused while anything points at the row (recipe
// lines, stock, purchase history); the price history it may carry cascades.

import type { UserRole } from '@prisma/client'
import { PROCUREMENT_TEAM } from '../../../auth/middleware.js'
import type { Reference, TrashProvider } from '../../types.js'
import { AppError } from '../../../../lib/errors.js'
import { restoreSnapshot, type Snapshot } from '../../snapshot.js'

// = the item master's own edit guard (inventory/routes.ts ITEM_MASTER_EDITORS).
const editors: readonly UserRole[] = PROCUREMENT_TEAM

const ref = (label: string, count: number): Reference => ({ label, count })

const inventoryItem: TrashProvider = {
  key: 'inventory_item',
  label: 'Ingredient',
  moduleId: 'inventory',
  roles: { list: editors, restore: editors },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'InventoryItem',
  linkOf: () => '/sourcing',
  async clashOf(tx, entry, opts) {
    const item = await tx.inventoryItem.findUnique({ where: { id: entry.entityId }, select: { name: true, tenantId: true } })
    if (!item) return null
    const name = (opts.rename?.name ?? item.name).trim()
    const twin = await tx.inventoryItem.findFirst({
      where: { id: { not: entry.entityId }, tenantId: item.tenantId, deletedAt: null, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    })
    if (!twin) return null
    return {
      field: 'name', value: name, suggestion: `${item.name} (restored)`, renamable: true,
      message: `Another ingredient in this company is already called "${name}" — restore it under a new name`,
    }
  },
  async restore(tx, _ctx, entry, opts) {
    const name = opts.rename?.name?.trim()
    // Kitchen flow (2026-10-26): one live stock item per servd ingredient per company. When the company already
    // stocks this ingredient (another live item linked to the same master — also on a "(restored)" rename), the item
    // comes back UNLINKED and is flagged for a reviewer (ingredient_master_unlinked) — never a unique-key 500.
    const item = await tx.inventoryItem.findUnique({ where: { id: entry.entityId }, select: { name: true, tenantId: true, masterIngredientId: true } })
    const twin = item?.masterIngredientId
      ? await tx.inventoryItem.findFirst({ where: { id: { not: entry.entityId }, tenantId: item.tenantId, masterIngredientId: item.masterIngredientId, deletedAt: null }, select: { id: true, name: true } })
      : null
    await tx.inventoryItem.update({
      where: { id: entry.entityId },
      data: { deletedAt: null, ...(name ? { name: name.slice(0, 200) } : {}), ...(twin ? { masterIngredientId: null } : {}) },
    })
    if (twin && item) {
      await tx.exceptionFlag.create({
        data: {
          tenantId: item.tenantId, kind: 'ingredient_master_unlinked', severity: 'low',
          title: `Restored ingredient not linked: ${name ?? item.name}`,
          description: `"${name ?? item.name}" came back from the Trash, but this company already stocks the same servd ingredient as "${twin.name}". It was restored without its servd ingredient — merge the two stock items, or link it on Operations → Ingredients.`,
          entityType: 'InventoryItem', entityId: entry.entityId,
          metadata: { masterIngredientId: item.masterIngredientId, twinItemId: twin.id },
        },
      })
    }
    return { id: entry.entityId, link: '/sourcing' }
  },
  async references(tx, entry) {
    const id = entry.entityId
    const [recipes, lots, moves, po, grn, bills, petty, counts, waste, transfers, components] = await Promise.all([
      tx.recipeIngredient.count({ where: { inventoryItemId: id } }),
      tx.stockLot.count({ where: { inventoryItemId: id } }),
      tx.stockMovement.count({ where: { inventoryItemId: id } }),
      tx.purchaseOrderLine.count({ where: { inventoryItemId: id } }),
      tx.goodsReceiptLine.count({ where: { inventoryItemId: id } }),
      tx.supplierBillLine.count({ where: { inventoryItemId: id } }),
      tx.pettyCashSpendLine.count({ where: { inventoryItemId: id } }),
      tx.physicalCountLine.count({ where: { inventoryItemId: id } }),
      tx.wasteLog.count({ where: { inventoryItemId: id } }),
      tx.stockTransfer.count({ where: { inventoryItemId: id } }),
      tx.component.count({ where: { baseIngredientId: id } }),
    ])
    return [
      ref('Recipe lines', recipes), ref('Stock lots', lots), ref('Stock movements', moves), ref('Purchase order lines', po),
      ref('Goods receipt lines', grn), ref('Supplier bill lines', bills), ref('Petty cash lines', petty),
      ref('Count lines', counts), ref('Waste logs', waste), ref('Stock transfers', transfers), ref('Components', components),
    ].filter((r) => r.count > 0)
  },
  // Stock and purchase history keep it (references → 409 IN_USE); an unused one may go.
  erasable: (_e, refs) => refs.length === 0,
}

// ── servd ingredient (owner, 2026-11-12: delete from the Ingredients sheet) ───────────────────────────────────
//
//   ingredient_master   strategy snapshot (IngredientMaster + its typed IngredientMasterPrice rows)
//
// Written by DELETE /ingredient-master/:id (modules/ingredientMaster/routes.ts) for an UNUSED ingredient only, under the
// deleter's active company. Restore re-creates it with the same id and re-links the company stock items it had
// (meta.linkedItemIds) that are still unlinked — a stock item restored before it stays unlinked only if its company
// linked another item to this ingredient meanwhile. Clash: a live ingredient with the same name and unit (409).
// Roles = ingredientMaster/routes.ts MASTER_REVIEWERS (literal here: that route file imports lib/trash — a cycle).
const INGREDIENT_REVIEWERS: readonly UserRole[] = ['admin', 'fnb_manager']
const snapOf = (e: { snapshot: unknown }) => e.snapshot as Snapshot | null

const ingredientMaster: TrashProvider = {
  key: 'ingredient_master',
  label: 'servd ingredient',
  moduleId: 'recipes',
  roles: { list: INGREDIENT_REVIEWERS, restore: INGREDIENT_REVIEWERS },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  model: 'IngredientMaster',
  linkOf: () => '/kitchen/ingredients',
  async clashOf(tx, entry) {
    const row = snapOf(entry)?.row
    if (!row) return null
    const twin = await tx.ingredientMaster.findFirst({
      where: { mergedIntoId: null, normalizedName: String(row.normalizedName ?? ''), stockUnit: String(row.stockUnit ?? '') },
      select: { id: true },
    })
    if (!twin) return null
    return {
      field: 'name', value: String(row.name ?? ''), renamable: false, code: 'INGREDIENT_EXISTS',
      message: `servd already has "${String(row.name ?? '')}" (${String(row.stockUnit ?? '')}) — use that one`,
    }
  },
  async restore(tx, _ctx, entry) {
    const snap = snapOf(entry)
    if (!snap) throw new AppError('PURGED', 'This item was deleted forever', 409)
    const id = await restoreSnapshot(tx, snap)
    const linked = ((entry.meta as { linkedItemIds?: unknown } | null)?.linkedItemIds ?? []) as string[]
    if (Array.isArray(linked) && linked.length) {
      // One live stock item per ingredient per company: never re-link where the company already linked another.
      const items = await tx.inventoryItem.findMany({ where: { id: { in: linked }, masterIngredientId: null }, select: { id: true, tenantId: true, deletedAt: true } })
      const taken = new Set((await tx.inventoryItem.findMany({ where: { masterIngredientId: id, deletedAt: null }, select: { tenantId: true } })).map((i) => i.tenantId))
      for (const it of items) {
        if (!it.deletedAt && taken.has(it.tenantId)) continue
        await tx.inventoryItem.update({ where: { id: it.id }, data: { masterIngredientId: id } })
        if (!it.deletedAt) taken.add(it.tenantId)
      }
    }
    return { id, link: '/kitchen/ingredients' }
  },
  erasable: () => true,
}

export const INVENTORY_TRASH_PROVIDERS: TrashProvider[] = [inventoryItem, ingredientMaster]
