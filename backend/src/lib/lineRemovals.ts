// Removals on an order line (owner, 2026-10-27: "removals = any item that is
// being deducted from stock will be adjusted if customer asks to remove").
//
// A customer may ask for an ingredient of a dish to be left out ("No onions").
// The line carries what was removed (OrderItem.removedIngredients, JSON) and
// the sale explosion (lib/recipeCost.ts consumptionPerLine) leaves exactly
// that line of the dish's plate recipe out — a sub-recipe line with its whole
// explosion — for that order line (× its quantity). Nothing goes negative,
// nothing else on the line changes, and cost of sales follows by itself
// because it is costed from what was drawn. The price never changes.
//
//   • What may be removed: the TOP-LEVEL ingredient lines (raw ingredients and
//     sub-recipes / prep items) of the dish's APPROVED plate recipe (status
//     'production'). Packaging lines are never removable. removableIngredients
//     is the one list — the till reads it (GET /menu/items/:id/removable) and
//     the ring-up checks against it (orders/service.ts prepareOrderLines, 422
//     INGREDIENT_NOT_ON_RECIPE).
//   • How a removal names a line, stable across companies and recipe edits:
//     a raw line by its servd ingredient master (kitchen flow K1) — or, with
//     no master, by its stock item — and a sub-recipe line by its recipe. A
//     shared recipe's line localised to the selling company's own item still
//     matches its master.
//   • Add-ons (modifier recipes, incl. their own 'removes' lines) are NOT this
//     feature and are unchanged.

import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { AppError } from './errors.js'

type Db = Prisma.TransactionClient | typeof prisma

/** One removal as stored on OrderItem.removedIngredients (exactly one id set). */
export interface LineRemoval {
  masterIngredientId?: string
  inventoryItemId?: string
  prepRecipeId?: string
  name: string
}

/** A removable ingredient of a dish (GET /menu/items/:id/removable). `key` is a stable id for the till's tick boxes. */
export interface RemovableIngredient extends LineRemoval {
  key: string
  kind: 'ingredient' | 'prep'
}

/** What a client may send for one removal: any of the ids (the server fills in the name). */
export interface LineRemovalInput {
  masterIngredientId?: string | null
  inventoryItemId?: string | null
  prepRecipeId?: string | null
  key?: string | null
  name?: string | null
}

const keyOf = (r: Pick<LineRemoval, 'masterIngredientId' | 'inventoryItemId' | 'prepRecipeId'>): string =>
  r.prepRecipeId ? `r:${r.prepRecipeId}` : r.masterIngredientId ? `m:${r.masterIngredientId}` : `i:${r.inventoryItemId}`

/**
 * The removable ingredients of each dish in `menuItemIds`: the top-level, non-packaging, positive lines of its
 * APPROVED plate recipe, one entry per ingredient (the same ingredient on two lines is one tick box that removes
 * both). A dish with no approved recipe has none.
 */
export async function removableIngredientsMany(db: Db, menuItemIds: string[]): Promise<Map<string, RemovableIngredient[]>> {
  const out = new Map<string, RemovableIngredient[]>()
  for (const id of menuItemIds) out.set(id, [])
  if (menuItemIds.length === 0) return out
  const recipes = await db.recipe.findMany({
    where: { menuItemId: { in: menuItemIds }, kind: 'plate', status: 'production' },
    select: {
      menuItemId: true,
      ingredients: {
        select: {
          inventoryItemId: true, prepRecipeId: true, quantity: true, section: true, masterIngredientId: true,
          inventoryItem: { select: { name: true, masterIngredientId: true } },
          prepRecipe: { select: { name: true } },
        },
      },
    },
  })
  for (const r of recipes) {
    const list: RemovableIngredient[] = []
    const seen = new Set<string>()
    for (const l of r.ingredients) {
      if (l.section === 'packaging' || !(l.quantity > 0)) continue
      let entry: RemovableIngredient | null = null
      if (l.prepRecipeId) {
        entry = { key: '', kind: 'prep', prepRecipeId: l.prepRecipeId, name: l.prepRecipe?.name?.trim() || 'Sub-recipe' }
      } else if (l.inventoryItemId) {
        const master = l.masterIngredientId ?? l.inventoryItem?.masterIngredientId ?? null
        entry = master
          ? { key: '', kind: 'ingredient', masterIngredientId: master, name: l.inventoryItem?.name?.trim() || 'Ingredient' }
          : { key: '', kind: 'ingredient', inventoryItemId: l.inventoryItemId, name: l.inventoryItem?.name?.trim() || 'Ingredient' }
      }
      if (!entry) continue
      entry.key = keyOf(entry)
      if (seen.has(entry.key)) continue
      seen.add(entry.key)
      list.push(entry)
    }
    list.sort((a, b) => a.name.localeCompare(b.name))
    if (r.menuItemId) out.set(r.menuItemId, list)
  }
  return out
}

export async function removableIngredients(db: Db, menuItemId: string): Promise<RemovableIngredient[]> {
  return (await removableIngredientsMany(db, [menuItemId])).get(menuItemId) ?? []
}

const matches = (want: LineRemovalInput, have: RemovableIngredient): boolean =>
  (!!want.key && want.key === have.key)
  || (!!want.prepRecipeId && want.prepRecipeId === have.prepRecipeId)
  || (!!want.masterIngredientId && want.masterIngredientId === have.masterIngredientId)
  || (!!want.inventoryItemId && want.inventoryItemId === have.inventoryItemId)

/**
 * The removals of each line, checked against its dish's removable list (THE check — prepareOrderLines calls it).
 * Returns the stored form per line (same order as `items`; null = none). 422 INGREDIENT_NOT_ON_RECIPE for anything
 * not on the list (a custom line has no recipe, so no removal). `trusted` (a shift correction re-issue copying a bill
 * already sold) keeps what was sent without re-checking today's recipe.
 */
export async function resolveLineRemovals(
  items: Array<{ menuItemId: string | null; name?: string; removedIngredients?: LineRemovalInput[] | null }>,
  o: { trusted?: boolean; db?: Db } = {},
): Promise<Array<LineRemoval[] | null>> {
  const asked = items.map((i) => (i.removedIngredients ?? []).filter(Boolean))
  if (asked.every((a) => a.length === 0)) return items.map(() => null)
  if (o.trusted) {
    return asked.map((a) => (a.length === 0 ? null : a.map((r) => storedOf(r)).filter((r): r is LineRemoval => !!r)))
  }
  const dishIds = [...new Set(items.filter((_, i) => asked[i]!.length > 0).map((i) => i.menuItemId).filter((x): x is string => !!x))]
  const lists = await removableIngredientsMany(o.db ?? prisma, dishIds)
  return items.map((item, i) => {
    const want = asked[i]!
    if (want.length === 0) return null
    const list = item.menuItemId ? lists.get(item.menuItemId) ?? [] : []
    const picked = new Map<string, LineRemoval>()
    for (const w of want) {
      const hit = list.find((h) => matches(w, h))
      if (!hit) {
        throw new AppError('INGREDIENT_NOT_ON_RECIPE',
          `"${w.name?.trim() || 'That ingredient'}" is not on the recipe of ${item.name ?? 'this dish'} — it cannot be removed`, 422)
      }
      const { key, kind: _kind, ...stored } = hit
      picked.set(key, stored)
    }
    return [...picked.values()]
  })
}

function storedOf(r: LineRemovalInput): LineRemoval | null {
  const name = r.name?.trim() || 'Ingredient'
  if (r.prepRecipeId) return { prepRecipeId: r.prepRecipeId, name }
  if (r.masterIngredientId) return { masterIngredientId: r.masterIngredientId, name }
  if (r.inventoryItemId) return { inventoryItemId: r.inventoryItemId, name }
  return null
}

/** Read OrderItem.removedIngredients (JSON) safely. */
export function lineRemovalsOf(json: unknown): LineRemoval[] {
  if (!Array.isArray(json)) return []
  const out: LineRemoval[] = []
  for (const r of json) {
    if (!r || typeof r !== 'object') continue
    const s = storedOf(r as LineRemovalInput)
    if (s) out.push(s)
  }
  return out
}

/** "No onions" labels of a line, for the kitchen ticket, KDS, KOT and receipts. */
export function removalLabels(json: unknown): string[] {
  return lineRemovalsOf(json).map((r) => `No ${r.name}`)
}

/**
 * Does a TOP-LEVEL recipe line fall under one of `removals`? Raw lines match by master (the line's own, else its
 * item's), or by stock item when the removal has no master; sub-recipe lines by recipe.
 */
export function isLineRemoved(
  line: { inventoryItemId: string | null; prepRecipeId: string | null; masterIngredientId?: string | null; inventoryItem?: { masterIngredientId?: string | null } | null },
  removals: LineRemoval[] | null | undefined,
): boolean {
  if (!removals || removals.length === 0) return false
  const master = line.masterIngredientId ?? line.inventoryItem?.masterIngredientId ?? null
  return removals.some((r) =>
    (r.prepRecipeId ? line.prepRecipeId === r.prepRecipeId
      : r.masterIngredientId ? !line.prepRecipeId && master === r.masterIngredientId
      : !!r.inventoryItemId && !line.prepRecipeId && line.inventoryItemId === r.inventoryItemId))
}
