// Trash providers — menu, kitchen, floor and recipes (Stream B1; contract in
// ../../README.md). Seven types:
//
//   menu_item, category, modifier_group, station, table, floor   strategy soft
//   recipe                                                       strategy snapshot
//
// The delete routes (menu / stations / tables / floors / recipes) write the
// Trash entry in the SAME transaction as their delete. Everything here is the
// other half: who sees it, what restore does, what still points at it.
//
// Restore rules (spec §2.1 / §2.4):
//   - brand in the Trash   -> 409 PARENT_IN_TRASH (the brand is the CEO's to restore)
//   - menu_item            -> category must be live; a dead / switched-off station is unset
//   - modifier_group       -> its menu item must be live
//   - table                -> its floor must be live; it comes back idle on that floor
//   - floor                -> relinks meta.tableIds that are still unplaced and live
//   - station              -> back to the on/off state it had (meta.previous.isActive)
//   - recipe               -> 409 RECIPE_SLOT_TAKEN when its dish / add-on already has
//                             another recipe; `unlink: true` restores it as an unlinked
//                             recipe under test (status `iteration`)
// "Delete forever" (CEO only) is refused (409 IN_USE) while anything still points at
// the row: sold items, cooked steps, orders / reservations on a table, and so on.

import type { TrashEntry, UserRole } from '@prisma/client'
import { AppError } from '../../../../lib/errors.js'
import { MANAGERS, ADMIN_ONLY } from '../../../auth/middleware.js'
import { restoreSnapshot, type Snapshot } from '../../snapshot.js'
import type { Clash, Reference, TrashProvider, Tx } from '../../types.js'

const managers: readonly UserRole[] = MANAGERS
const adminOnly: readonly UserRole[] = ADMIN_ONLY

const live = (refs: Reference[]) => refs.filter((r) => r.count > 0)
const ref = (label: string, count: number): Reference => ({ label, count })
const metaOf = (e: TrashEntry) => (e.meta ?? {}) as Record<string, unknown>

/** 409 PARENT_IN_TRASH when the entry's brand has been deleted. */
async function assertBrandLive(tx: Tx, entry: TrashEntry): Promise<void> {
  if (!entry.conceptId) return
  const c = await tx.concept.findUnique({ where: { id: entry.conceptId }, select: { id: true, name: true, deletedAt: true } })
  if (c && !c.deletedAt) return
  throw new AppError('PARENT_IN_TRASH', `Restore the brand "${c?.name ?? 'this item\'s brand'}" first — it is in the Trash too`, 409, {
    parent: { type: 'brand', id: entry.conceptId, title: c?.name ?? 'Brand' },
  })
}

function parentIn(entry: TrashEntry, type: string): { type: string; id: string } | null {
  return entry.parentType === type && entry.parentId ? { type, id: entry.parentId } : null
}

// ── menu_item ─────────────────────────────────────────────────────────────────

const menuItem: TrashProvider = {
  key: 'menu_item',
  label: 'Menu item',
  moduleId: 'menu',
  roles: { list: managers, restore: managers },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'MenuItem',
  linkOf: () => '/menu',
  parentOf: (e) => parentIn(e, 'category'),
  async clashOf(tx, entry) {
    await assertBrandLive(tx, entry)
    const item = await tx.menuItem.findUnique({ where: { id: entry.entityId }, select: { categoryId: true } })
    if (item) {
      const cat = await tx.category.findUnique({ where: { id: item.categoryId }, select: { id: true, name: true, deletedAt: true } })
      if (!cat || cat.deletedAt) {
        throw new AppError('PARENT_IN_TRASH', `Restore the category "${cat?.name ?? ''}" first — it is in the Trash too`, 409, {
          parent: { type: 'category', id: item.categoryId, title: cat?.name ?? 'Category' },
        })
      }
    }
    return null
  },
  async restore(tx, _ctx, entry) {
    const item = await tx.menuItem.findUnique({ where: { id: entry.entityId }, select: { stationId: true } })
    // A dish routed to a deleted / switched-off station would be cooked by nobody
    // (create and edit refuse it, 422 STATION_NOT_LIVE) — it comes back unrouted.
    let stationId = item?.stationId ?? null
    if (stationId) {
      const st = await tx.station.findFirst({ where: { id: stationId, deletedAt: null, isActive: true }, select: { id: true } })
      if (!st) stationId = null
    }
    await tx.menuItem.update({ where: { id: entry.entityId }, data: { deletedAt: null, stationId } })
    return { id: entry.entityId, link: '/menu' }
  },
  async references(tx, entry) {
    const id = entry.entityId
    return live([
      ref('Order lines (sold)', await tx.orderItem.count({ where: { menuItemId: id } })),
      ref('Recipes', await tx.recipe.count({ where: { menuItemId: id } })),
      ref('Add-on groups in the Trash', await tx.modifierGroup.count({ where: { menuItemId: id, deletedAt: { not: null } } })),
      ref('Sold add-ons', await tx.orderItemModifier.count({ where: { modifier: { group: { menuItemId: id } } } })),
      ref('Add-on recipes', await tx.recipe.count({ where: { modifier: { group: { menuItemId: id } } } })),
    ])
  },
  erasable: () => true,
  async purge(tx, entry) {
    const groups = await tx.modifierGroup.findMany({ where: { menuItemId: entry.entityId }, select: { id: true } })
    if (groups.length) {
      const ids = groups.map((g) => g.id)
      await tx.modifier.deleteMany({ where: { groupId: { in: ids } } })
      await tx.modifierGroup.deleteMany({ where: { id: { in: ids } } })
    }
    await tx.menuItem.delete({ where: { id: entry.entityId } })
  },
}

// ── category ──────────────────────────────────────────────────────────────────

const category: TrashProvider = {
  key: 'category',
  label: 'Menu category',
  moduleId: 'menu',
  roles: { list: managers, restore: managers },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'Category',
  linkOf: () => '/menu',
  async clashOf(tx, entry) {
    await assertBrandLive(tx, entry)
    return null
  },
  async references(tx, entry) {
    return live([
      ref('Menu items (including deleted)', await tx.menuItem.count({ where: { categoryId: entry.entityId } })),
      ref('Section discounts', await tx.sectionDiscount.count({ where: { categoryId: entry.entityId } })),
    ])
  },
  erasable: () => true,
}

// ── modifier_group ────────────────────────────────────────────────────────────

const modifierGroup: TrashProvider = {
  key: 'modifier_group',
  label: 'Add-on group',
  moduleId: 'menu',
  roles: { list: managers, restore: managers },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'ModifierGroup',
  linkOf: () => '/menu',
  parentOf: (e) => parentIn(e, 'menu_item'),
  async clashOf(tx, entry) {
    await assertBrandLive(tx, entry)
    const g = await tx.modifierGroup.findUnique({
      where: { id: entry.entityId },
      select: { menuItem: { select: { id: true, name: true, deletedAt: true } } },
    })
    if (g?.menuItem.deletedAt) {
      throw new AppError('PARENT_IN_TRASH', `Restore the menu item "${g.menuItem.name}" first — it is in the Trash too`, 409, {
        parent: { type: 'menu_item', id: g.menuItem.id, title: g.menuItem.name },
      })
    }
    return null
  },
  async references(tx, entry) {
    return live([
      ref('Sold add-ons', await tx.orderItemModifier.count({ where: { modifier: { groupId: entry.entityId } } })),
      ref('Add-on recipes', await tx.recipe.count({ where: { modifier: { groupId: entry.entityId } } })),
    ])
  },
  erasable: () => true,
  async purge(tx, entry) {
    await tx.modifier.deleteMany({ where: { groupId: entry.entityId } })
    await tx.modifierGroup.delete({ where: { id: entry.entityId } })
  },
}

// ── station ───────────────────────────────────────────────────────────────────

const station: TrashProvider = {
  key: 'station',
  label: 'Kitchen station',
  moduleId: 'kds_config',
  roles: { list: adminOnly, restore: adminOnly },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'Station',
  linkOf: () => '/kds/config',
  async clashOf(tx, entry) {
    await assertBrandLive(tx, entry)
    return null
  },
  async restore(tx, _ctx, entry) {
    const prev = (metaOf(entry).previous ?? {}) as { isActive?: boolean }
    await tx.station.update({ where: { id: entry.entityId }, data: { deletedAt: null, isActive: prev.isActive ?? true } })
    return { id: entry.entityId, link: '/kds/config' }
  },
  async references(tx, entry) {
    const id = entry.entityId
    return live([
      ref('Order lines routed here', await tx.orderItem.count({ where: { stationId: id } })),
      ref('Recipe steps', await tx.recipeStep.count({ where: { stationId: id } })),
      ref('Menu items', await tx.menuItem.count({ where: { stationId: id } })),
    ])
  },
  erasable: () => true,
}

// ── table ─────────────────────────────────────────────────────────────────────

/** The floor a trashed table should go back to (meta.floorId), or null. 409 while that floor is in the Trash. */
async function tableFloor(tx: Tx, entry: TrashEntry): Promise<string | null> {
  const floorId = metaOf(entry).floorId
  if (typeof floorId !== 'string') return null
  const f = await tx.floor.findUnique({ where: { id: floorId }, select: { id: true, name: true, deletedAt: true } })
  if (!f) return null // purged: the table comes back unplaced
  if (f.deletedAt) {
    throw new AppError('PARENT_IN_TRASH', `Restore the floor "${f.name}" first — it is in the Trash too`, 409, {
      parent: { type: 'floor', id: f.id, title: f.name },
    })
  }
  return f.id
}

const table: TrashProvider = {
  key: 'table',
  label: 'Table',
  moduleId: 'tables',
  roles: { list: managers, restore: managers },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'Table',
  linkOf: () => '/tables',
  parentOf: (e) => parentIn(e, 'floor'),
  async clashOf(tx, entry) {
    await assertBrandLive(tx, entry)
    await tableFloor(tx, entry)
    return null
  },
  async restore(tx, _ctx, entry) {
    const floorId = await tableFloor(tx, entry)
    // Occupancy written before the delete is stale by now: it comes back idle.
    await tx.table.update({
      where: { id: entry.entityId },
      data: {
        deletedAt: null,
        status: 'available',
        currentOrderId: null,
        currentPartySize: null,
        estimatedDepartureAt: null,
        ...(floorId ? { floorId } : {}),
      },
    })
    return { id: entry.entityId, link: '/tables' }
  },
  async references(tx, entry) {
    const id = entry.entityId
    return live([
      ref('Orders', await tx.order.count({ where: { tableId: id } })),
      ref('Reservations', await tx.reservation.count({ where: { tableId: id } })),
      ref('QR codes', await tx.qrCode.count({ where: { tableId: id } })),
    ])
  },
  erasable: () => true,
}

// ── floor ─────────────────────────────────────────────────────────────────────

const floor: TrashProvider = {
  key: 'floor',
  label: 'Floor plan',
  moduleId: 'tables',
  roles: { list: managers, restore: managers },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'Floor',
  linkOf: () => '/floorplan',
  async clashOf(tx, entry) {
    await assertBrandLive(tx, entry)
    return null
  },
  async restore(tx, _ctx, entry) {
    const f = await tx.floor.update({ where: { id: entry.entityId }, data: { deletedAt: null, isActive: true }, select: { conceptId: true } })
    const ids = metaOf(entry).tableIds
    if (Array.isArray(ids) && ids.length) {
      // Only tables still unplaced, live and of the floor's own brand.
      await tx.table.updateMany({
        where: { id: { in: ids.filter((x): x is string => typeof x === 'string') }, floorId: null, deletedAt: null, conceptId: f.conceptId },
        data: { floorId: entry.entityId },
      })
    }
    return { id: entry.entityId, link: '/floorplan' }
  },
  async references(tx, entry) {
    return live([ref('Tables on it (including deleted)', await tx.table.count({ where: { floorId: entry.entityId } }))])
  },
  erasable: () => true,
}

// ── recipe (snapshot) ─────────────────────────────────────────────────────────

const snapOf = (e: TrashEntry): Snapshot | null => (e.snapshot as unknown as Snapshot | null) ?? null

const recipe: TrashProvider = {
  key: 'recipe',
  label: 'Recipe',
  moduleId: 'recipes',
  roles: { list: managers, restore: managers },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  linkOf: (id) => `/accounting/recipes/${id}`,
  async clashOf(tx, entry, opts): Promise<Clash | null> {
    const snap = snapOf(entry)
    if (!snap) return null
    await assertBrandLive(tx, entry)
    const row = snap.row as { menuItemId?: string | null; modifierId?: string | null }

    if (!opts.unlink) {
      if (row.menuItemId) {
        const item = await tx.menuItem.findUnique({ where: { id: row.menuItemId }, select: { id: true } })
        const taken = item ? await tx.recipe.findFirst({ where: { menuItemId: row.menuItemId }, select: { id: true } }) : null
        if (!item || taken) {
          return {
            field: 'menuItemId', value: row.menuItemId, renamable: false, code: 'RECIPE_SLOT_TAKEN',
            message: item
              ? 'The dish this recipe belonged to has a newer recipe now. Restore this one unlinked, or delete the newer one first.'
              : 'The dish this recipe belonged to no longer exists. Restore it unlinked.',
          }
        }
      }
      if (row.modifierId) {
        const mod = await tx.modifier.findUnique({ where: { id: row.modifierId }, select: { id: true } })
        const taken = mod ? await tx.recipe.findFirst({ where: { modifierId: row.modifierId }, select: { id: true } }) : null
        if (!mod || taken) {
          return {
            field: 'modifierId', value: row.modifierId, renamable: false, code: 'RECIPE_SLOT_TAKEN',
            message: mod
              ? 'The add-on this recipe belonged to has a newer recipe now. Restore this one unlinked, or delete the newer one first.'
              : 'The add-on this recipe belonged to no longer exists. Restore it unlinked.',
          }
        }
      }
    }

    // Lines must still point at something that exists (a sub-recipe deleted
    // since would make the re-create fail on its foreign key).
    const lines = (snap.children?.RecipeIngredient ?? []) as Array<{ inventoryItemId?: string | null; prepRecipeId?: string | null }>
    const prepIds = [...new Set(lines.map((l) => l.prepRecipeId).filter((x): x is string => !!x && x !== entry.entityId))]
    const stockIds = [...new Set(lines.map((l) => l.inventoryItemId).filter((x): x is string => !!x))]
    const [preps, stock] = await Promise.all([
      prepIds.length ? tx.recipe.findMany({ where: { id: { in: prepIds } }, select: { id: true } }) : [],
      stockIds.length ? tx.inventoryItem.findMany({ where: { id: { in: stockIds } }, select: { id: true } }) : [],
    ])
    const missing = prepIds.filter((i) => !preps.some((p) => p.id === i)).length + stockIds.filter((i) => !stock.some((s) => s.id === i)).length
    if (missing > 0) {
      return {
        field: 'ingredients', value: String(missing), renamable: false, code: 'RECIPE_DEPENDENCY_MISSING',
        message: `${missing} ingredient line(s) point at a sub-recipe or stock item that no longer exists, so this recipe cannot be restored.`,
      }
    }
    return null
  },
  async restore(tx, _ctx, entry, opts) {
    const snap = snapOf(entry)
    if (!snap) throw new AppError('PURGED', 'This item was deleted forever', 409)
    const copy = structuredClone(snap)
    // A step whose station was erased since keeps its words and is unrouted.
    const steps = (copy.children?.RecipeStep ?? []) as Array<{ stationId?: string | null }>
    const stationIds = [...new Set(steps.map((s) => s.stationId).filter((x): x is string => !!x))]
    if (stationIds.length) {
      const have = new Set((await tx.station.findMany({ where: { id: { in: stationIds } }, select: { id: true } })).map((s) => s.id))
      for (const s of steps) if (s.stationId && !have.has(s.stationId)) s.stationId = null
    }
    const override: Record<string, unknown> = {}
    if (opts.unlink) {
      override.menuItemId = null
      override.modifierId = null
      // An unlinked plate or add-on recipe is not live: it goes back under test.
      if (copy.row.kind !== 'component') override.status = 'iteration'
    }
    const id = await restoreSnapshot(tx, copy, { tenantId: entry.tenantId, override })
    return { id, link: `/accounting/recipes/${id}` }
  },
  async references(tx, entry) {
    const snap = snapOf(entry)
    const stepIds = ((snap?.children?.RecipeStep ?? []) as Array<{ id?: string }>).map((s) => s.id).filter((x): x is string => !!x)
    return live([
      ref('Prep batches logged', await tx.prepBatch.count({ where: { recipeId: entry.entityId } })),
      ref('Kitchen-screen steps cooked', stepIds.length ? await tx.orderItemStep.count({ where: { recipeStepId: { in: stepIds } } }) : 0),
    ])
  },
  erasable: () => true,
}

export const MENU_TRASH_PROVIDERS: TrashProvider[] = [menuItem, category, modifierGroup, station, table, floor, recipe]
