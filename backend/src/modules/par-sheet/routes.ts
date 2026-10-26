// Par-sheet routes. Since the kitchen flow (owner, 2026-10-26) the daily view is the par board (GET /kitchen/par-board)
// and this file keeps only the prep pickers (GET /par-sheet/preps) and THE company sub-recipe set
// (subRecipeIdsForCompany). Older history of the par sheet below.
//
// Owner decision 29 (2026-09-27): the par sheet lists the recipe library's
// sub-recipes (Recipe kind='component') that the active company's brands
// actually use, and prep is logged ONCE, through prep batches
// (POST /crosschecks/prep-batches), which deduct the inputs and record the
// yield. "Made today" on the sheet is read from those batches — there is no
// second, hand-typed actual any more.
//
// What went away: the sheet used to list the Component library (a separate,
// uncosted catalogue) and let cooks type or +/- an `actualCount` that deducted
// nothing, so the sheet and the stock drifted apart. The Component library is
// now a read-only planning reference (GET /components); its
// component_par_levels rows are kept, untouched, but nothing reads or writes
// them. Daily per-recipe TARGETS need a recipe-keyed par table (see the
// ComponentParLevel.recipeId migration in the reconcile notes) and come back
// with it.

import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { ForbiddenError } from '../../lib/errors.js'
import { costPerMeasureCents, loadRecipeGraph, localiseGraph, recipeCost, withLatestCosts, type RecipeCost } from '../../lib/recipeCost.js'

/**
 * Sub-recipe ids used by the company's brands: every component recipe that a
 * plate — or an add-on (modifier recipe) of a dish — of one of the company's
 * brands uses, directly or through another sub-recipe. Plates count whether they are on the menu or still in testing
 * (the pending menu item names the brand).
 */
export async function subRecipeIdsForCompany(tenantId: string): Promise<Set<string>> {
  const concepts = await prisma.concept.findMany({
    where: { tenantId, deletedAt: null },
    select: { id: true },
  })
  const conceptIds = concepts.map((c) => c.id)

  const plates = await prisma.recipe.findMany({
    where: {
      kind: 'plate',
      isActive: true,
      OR: [
        { menuItem: { conceptId: { in: conceptIds }, deletedAt: null } },
        ...conceptIds.map((id) => ({ menuItemId: null, pendingMenuItem: { path: ['conceptId'], equals: id } })),
      ],
    },
    select: { ingredients: { select: { prepRecipeId: true } } },
  })
  // Add-on (modifier) recipes of the company's dishes: a sub-recipe used only
  // by an add-on is still prepped (orders/stock.ts depletes it through the
  // modifier's recipe — lib/recipeCost.ts consumptionPerLine). The company is
  // the brand's, via modifier → group → menu item.
  const addOns = await prisma.recipe.findMany({
    where: {
      kind: 'modifier',
      isActive: true,
      modifier: {
        deletedAt: null,
        group: { deletedAt: null, menuItem: { conceptId: { in: conceptIds }, deletedAt: null } },
      },
    },
    select: { ingredients: { select: { prepRecipeId: true } } },
  })

  // Sub-recipe → the sub-recipes it is built from.
  const components = await prisma.recipe.findMany({
    where: { kind: 'component' },
    select: { id: true, ingredients: { select: { prepRecipeId: true } } },
  })
  const children = new Map(components.map((c) => [c.id, c.ingredients.map((i) => i.prepRecipeId).filter((x): x is string => !!x)]))

  const used = new Set<string>()
  // Kitchen flow (K4): the sub-recipes the company OWNS are its too (GS Foods preps what Flipd's dishes use).
  const owned = (await prisma.recipe.findMany({ where: { kind: 'component', tenantId, isActive: true }, select: { id: true } })).map((r) => r.id)
  const queue = [...owned, ...[...plates, ...addOns].flatMap((p) => p.ingredients.map((i) => i.prepRecipeId).filter((x): x is string => !!x))]
  while (queue.length) {
    const id = queue.pop()!
    if (used.has(id)) continue
    used.add(id)
    queue.push(...(children.get(id) ?? []))
  }
  return used
}

// The par sheet is one kitchen's day: the active company only.

export async function parSheetRoutes(fastify: FastifyInstance) {

  // GET /par-sheet (the "made today" list) was REPLACED by the par board, GET /kitchen/par-board (kitchen flow, owner
  // 2026-10-26: target, on hand, made today and still to prep, in portions — modules/kitchen/prepPlan.ts).

  // GET /par-sheet/preps — the prep-batch form's picker: the active company's
  // sub-recipes with one batch's raw inputs, converted to each item's stock
  // unit (so a recipe's 200 g of a kg item is drawn as 0.2). A sub-recipe line
  // that points at another company's item is matched to this company's item of
  // the same name; lines with no match come back as `missing`.
  //
  // `?for=recipe` is the recipe builder's ingredient picker (RecipeForm and the
  // recipes page) — the ONE component picker (D7; GET /recipes/prep, which
  // listed every company's sub-recipes, is retired). Managers only, because it
  // carries cost: each option's THE cost-per-gram (lib/recipeCost.ts, nested
  // sub-recipes included). It lists the company's sub-recipes PLUS components
  // no recipe uses yet — a new sub-recipe has to be pickable before the first
  // plate that uses it exists. A sub-recipe only another company's plates use,
  // or an unused one built from another company's stock items, never appears.
  fastify.get<{ Querystring: { for?: string } }>('/preps', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const tenantId = req.staffUser?.tenantId ?? null
    if (!tenantId) return []
    const ids = await subRecipeIdsForCompany(tenantId)

    if (req.query.for === 'recipe') {
      if (!MANAGERS.includes(req.staffUser!.role)) throw new ForbiddenError('Recipe costs are for managers')
      const candidates = await prisma.recipe.findMany({
        where: {
          kind: 'component',
          isActive: true,
          OR: [{ id: { in: [...ids] } }, { usedInPlates: { none: {} } }],
        },
        select: {
          id: true, name: true, yieldGrams: true,
          ingredients: { select: { inventoryItem: { select: { tenantId: true } } } },
        },
        orderBy: { name: 'asc' },
      })
      // An unused sub-recipe built from another company's stock items is that
      // company's, not ours (same attribution the recipe library uses).
      const preps = candidates.filter((p) => {
        if (ids.has(p.id)) return true
        const owners = new Set(p.ingredients.map((i) => i.inventoryItem?.tenantId).filter((t): t is string => !!t))
        return owners.size === 0 || owners.has(tenantId)
      })
      // A cost screen: the company's own items (K4) at their LATEST cost (owner, 2026-10-26), never the FIFO head.
      const graph = await withLatestCosts(await localiseGraph((await loadRecipeGraph({ id: { in: preps.map((p) => p.id) } })).graph, tenantId, prisma, { strict: true }))
      const memo = new Map<string, RecipeCost>()
      return preps.map((p) => {
        const cost = recipeCost(graph, p.id, memo)
        return {
          id:               p.id,
          name:             p.name ?? '—',
          yieldGrams:       p.yieldGrams,
          batchCostCents:   Math.round(cost.totalCents),
          costPerGramCents: cost.perGramCents ?? 0,   // sub-cent precision deliberately preserved
        }
      })
    }

    const recipes = await prisma.recipe.findMany({
      where: { id: { in: [...ids] }, kind: 'component', isActive: true },
      select: {
        id: true, name: true, yieldGrams: true, yieldUnit: true,
        ingredients: {
          select: {
            quantity: true, unit: true, yieldPct: true,
            inventoryItem: { select: { id: true, name: true, unit: true, tenantId: true, deletedAt: true, masterIngredientId: true } },
            prepRecipe:    { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    })

    const own = await prisma.inventoryItem.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true, unit: true, masterIngredientId: true },
    })
    const ownByName = new Map(own.map((i) => [i.name.trim().toLowerCase(), i]))
    // K4: a shared sub-recipe's line is this company's item of the same servd master (then the same name).
    const ownByMaster = new Map(own.filter((i) => i.masterIngredientId).map((i) => [i.masterIngredientId!, i]))

    return recipes.map((r) => ({
      id: r.id,
      name: r.name ?? '—',
      yieldGrams: r.yieldGrams,
      // The unit the batch yield is counted in — the prep stock item's unit (prep as stock, 2026-10-24).
      yieldUnit: r.yieldUnit,
      inputs: r.ingredients.filter((i) => i.inventoryItem).map((i) => {
        const src = i.inventoryItem!
        const item = (src.tenantId === tenantId || src.tenantId == null) && !src.deletedAt
          ? src
          : (src.masterIngredientId ? ownByMaster.get(src.masterIngredientId) : undefined) ?? ownByName.get(src.name.trim().toLowerCase()) ?? null
        // RecipeIngredient.quantity is the usable (post-yield) measure; the
        // raw draw is quantity ÷ yield. yieldPct is a 0–1 fraction.
        const y = i.yieldPct > 1 ? i.yieldPct / 100 : i.yieldPct
        const rawMeasure = y > 0 ? i.quantity / y : i.quantity
        return item
          ? { inventoryItemId: item.id, name: item.name, unit: item.unit, qtyDrawn: Math.round(rawMeasure * costPerMeasureCents(item.unit, 1) * 1000) / 1000, missing: false }
          : { inventoryItemId: null, name: src.name, unit: src.unit, qtyDrawn: 0, missing: true }
      }),
      // Sub-recipes inside this one are drawn from prepared stock, not from
      // inventory, so they are listed for the cook but not deducted.
      subPreps: r.ingredients.filter((i) => i.prepRecipe).map((i) => ({ id: i.prepRecipe!.id, name: i.prepRecipe!.name, grams: i.quantity })),
    }))
  })
}
