// Par-sheet routes — the daily prep view.
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

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { costPerMeasureCents } from '../../lib/recipeCost.js'

// Midnight UTC of the requested service day (or today if none).
function dayKey(input?: string): Date {
  const d = input ? new Date(input) : new Date()
  if (Number.isNaN(d.getTime())) return dayKey()
  d.setUTCHours(0, 0, 0, 0)
  return d
}

/**
 * Sub-recipe ids used by the company's brands: every component recipe that a
 * plate of one of the company's brands uses, directly or through another
 * sub-recipe. Plates count whether they are on the menu or still in testing
 * (the pending menu item names the brand).
 */
export async function subRecipeIdsForCompany(tenantId: string): Promise<Set<string>> {
  const concepts = await prisma.concept.findMany({
    where: { tenantId, deletedAt: null },
    select: { id: true },
  })
  const conceptIds = concepts.map((c) => c.id)
  if (conceptIds.length === 0) return new Set()

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

  // Sub-recipe → the sub-recipes it is built from.
  const components = await prisma.recipe.findMany({
    where: { kind: 'component' },
    select: { id: true, ingredients: { select: { prepRecipeId: true } } },
  })
  const children = new Map(components.map((c) => [c.id, c.ingredients.map((i) => i.prepRecipeId).filter((x): x is string => !!x)]))

  const used = new Set<string>()
  const queue = plates.flatMap((p) => p.ingredients.map((i) => i.prepRecipeId).filter((x): x is string => !!x))
  while (queue.length) {
    const id = queue.pop()!
    if (used.has(id)) continue
    used.add(id)
    queue.push(...(children.get(id) ?? []))
  }
  return used
}

/** Grams in one batch-yield unit. Prep batches record yield in `unit`. */
function toGrams(qty: number, unit: string): number | null {
  const u = unit.trim().toLowerCase()
  if (u === 'g' || u === 'ml') return qty
  if (u === 'kg' || u === 'l' || u === 'litres') return qty * 1000
  return null
}

/**
 * Prep batches of `recipeIds` made on `date` by `tenantId`. PrepBatch has no
 * company column yet, so a batch is the company's when the stock it drew came
 * from that company's items. Replace with `where: { tenantId }` once
 * PrepBatch.tenantId exists.
 */
async function batchesForDay(tenantId: string, recipeIds: string[], date: Date) {
  if (recipeIds.length === 0) return []
  const next = new Date(date); next.setUTCDate(next.getUTCDate() + 1)
  const batches = await prisma.prepBatch.findMany({
    where: { recipeId: { in: recipeIds }, createdAt: { gte: date, lt: next } },
    orderBy: { createdAt: 'asc' },
  })
  const inputIds = new Set<string>()
  for (const b of batches) {
    for (const i of (Array.isArray(b.inputs) ? b.inputs : []) as Array<{ inventoryItemId?: string }>) {
      if (i?.inventoryItemId) inputIds.add(i.inventoryItemId)
    }
  }
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: [...inputIds] } },
    select: { id: true, tenantId: true },
  })
  const ownerOf = new Map(items.map((i) => [i.id, i.tenantId]))
  return batches.filter((b) =>
    ((Array.isArray(b.inputs) ? b.inputs : []) as Array<{ inventoryItemId?: string }>)
      .some((i) => i?.inventoryItemId && ownerOf.get(i.inventoryItemId) === tenantId),
  )
}

// The par sheet is one kitchen's day: the active company only.
function activeCompany(req: FastifyRequest): string | null {
  return req.staffUser!.tenantId ?? null
}

export async function parSheetRoutes(fastify: FastifyInstance) {

  // GET /par-sheet?date=YYYY-MM-DD
  // The active company's sub-recipes with what was made that day, from prep
  // batches. `madeGrams` sums batches recorded in g/kg/ml/l.
  fastify.get<{ Querystring: { date?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const tenantId = activeCompany(req)
      if (!tenantId) return []
      const date = dayKey(req.query.date)

      const ids = await subRecipeIdsForCompany(tenantId)
      const recipes = await prisma.recipe.findMany({
        where: { id: { in: [...ids] }, kind: 'component', isActive: true },
        select: { id: true, name: true, category: true, yieldGrams: true },
        orderBy: { name: 'asc' },
      })
      const batches = await batchesForDay(tenantId, recipes.map((r) => r.id), date)

      return recipes.map((r) => {
        const mine = batches.filter((b) => b.recipeId === r.id)
        const madeGrams = mine.reduce((s, b) => s + (toGrams(b.actualYieldQty, b.unit) ?? 0), 0)
        const last = mine[mine.length - 1]
        return {
          recipeId:    r.id,
          name:        r.name ?? '—',
          category:    r.category ?? null,
          batchYieldGrams: r.yieldGrams ?? null,
          batches:     mine.length,
          madeGrams:   Math.round(madeGrams * 10) / 10,
          lastBatchAt: last?.createdAt ?? null,
        }
      })
    },
  )

  // GET /par-sheet/preps — the prep-batch form's picker: the active company's
  // sub-recipes with one batch's raw inputs, converted to each item's stock
  // unit (so a recipe's 200 g of a kg item is drawn as 0.2). A sub-recipe line
  // that points at another company's item is matched to this company's item of
  // the same name; lines with no match come back as `missing`.
  fastify.get('/preps', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const tenantId = activeCompany(req)
    if (!tenantId) return []
    const ids = await subRecipeIdsForCompany(tenantId)
    const recipes = await prisma.recipe.findMany({
      where: { id: { in: [...ids] }, kind: 'component', isActive: true },
      select: {
        id: true, name: true, yieldGrams: true,
        ingredients: {
          select: {
            quantity: true, unit: true, yieldPct: true,
            inventoryItem: { select: { id: true, name: true, unit: true, tenantId: true, deletedAt: true } },
            prepRecipe:    { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    })

    const own = await prisma.inventoryItem.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true, unit: true },
    })
    const ownByName = new Map(own.map((i) => [i.name.trim().toLowerCase(), i]))

    return recipes.map((r) => ({
      id: r.id,
      name: r.name ?? '—',
      yieldGrams: r.yieldGrams,
      inputs: r.ingredients.filter((i) => i.inventoryItem).map((i) => {
        const src = i.inventoryItem!
        const item = (src.tenantId === tenantId || src.tenantId == null) && !src.deletedAt
          ? src
          : ownByName.get(src.name.trim().toLowerCase()) ?? null
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
