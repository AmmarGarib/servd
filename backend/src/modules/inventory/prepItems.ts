// Prep items as stock (owner, 2026-10-24, D3: "A prep batch takes its raw
// ingredients out of stock (FIFO) and ADDS the prep item to stock as a lot at
// the ACTUAL yield, valued at the raw value drawn … A prep item's raw
// ingredients leave stock when the batch is made, never again when the dish
// sells").
//
// A prep (sub-recipe, RecipeKind 'component') recipe gets ONE stock item of
// its own: InventoryItem.kind 'prep', prepRecipeId = the recipe (@unique — one
// item per recipe, in ONE company: the company whose brands use it), unit = the
// recipe's yield unit (Recipe.yieldUnit g / ml / pcs — yieldGrams counts in
// it; fixed once the item exists, 409 PREP_UNIT_LOCKED), cost class from its inputs'
// dominant class by cost (food unless its inputs are mostly drinks or
// packaging). Created:
//   • when the recipe is approved into production (recipes routes, after the
//     approval commits — a failure never undoes the approval);
//   • on the first prep batch of the recipe (POST /prep-batches);
//   • at boot for every production prep recipe of every company (the go-live
//     of this build: ensureAllPrepItems).
// From then on the sale explosion (lib/recipeCost.ts) draws THIS item for the
// recipe, never its raw ingredients — only for a prep item of the order's own
// company (another company's prep explodes raw, so nothing is counted twice or
// missed). Never written outside this file.

import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { costClassOf, zeroByClass, type CostClass } from '../../lib/inventoryClass.js'
import { explodeForPrepBatch, livePrepItems, loadRecipeGraph } from '../../lib/recipeCost.js'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

/** The category a prep item takes for a cost class (costClassOf maps it back). */
const CATEGORY_FOR_CLASS: Record<CostClass, string> = { food: 'other', beverage: 'beverage', packaging: 'packaging' }

export interface PrepItem { id: string; name: string; unit: string; tenantId: string; category: string | null }

/** The dominant cost class (by one batch's cost) of what a prep recipe draws. Food when nothing is costed. */
export async function prepRecipeClass(db: Db, recipeId: string, tenantId: string): Promise<CostClass> {
  const { graph } = await loadRecipeGraph({ id: recipeId }, db as Tx)
  const need = explodeForPrepBatch(graph, recipeId, 1, { tenantId, live: await livePrepItems(db as Tx, graph, 'any') })
  if (need.size === 0) return 'food'
  const items = await db.inventoryItem.findMany({ where: { id: { in: [...need.keys()] } }, select: { id: true, category: true, unitCostCents: true } })
  const by = zeroByClass()
  for (const it of items) by[costClassOf(it.category)] += Math.max(0, need.get(it.id) ?? 0) * (it.unitCostCents ?? 0)
  const top = (Object.entries(by) as Array<[CostClass, number]>).sort((a, b) => b[1] - a[1])[0]!
  return top[1] > 0 ? top[0] : 'food'
}

/**
 * The prep item of a prep recipe in `tenantId`, created when missing (see the
 * header). 422 RECIPE_NOT_PREP for a recipe that is not a sub-recipe; 422
 * RECIPE_NOT_IN_COMPANY when its prep item belongs to another company; 422
 * PREP_ITEM_IN_TRASH when it was parked in the Trash (restore it first).
 * Race-safe: a concurrent create keeps the first row (ON CONFLICT).
 */
export async function ensurePrepItemTx(db: Db, recipeId: string, tenantId: string): Promise<PrepItem> {
  const recipe = await db.recipe.findUnique({ where: { id: recipeId }, select: { id: true, kind: true, name: true, yieldUnit: true } })
  if (!recipe || recipe.kind !== 'component') throw new AppError('RECIPE_NOT_PREP', 'Only a prep (sub-recipe) has a prep stock item', 422)
  const read = () => db.inventoryItem.findUnique({
    where: { prepRecipeId: recipeId }, select: { id: true, name: true, unit: true, tenantId: true, category: true, deletedAt: true },
  })
  let row = await read()
  if (!row) {
    const cls = await prepRecipeClass(db, recipeId, tenantId)
    const name = `${(recipe.name ?? 'Prep').trim() || 'Prep'} (prep)`.slice(0, 200)
    await db.$executeRaw`
      INSERT INTO inventory_items (id, "tenantId", name, unit, category, kind, "prepRecipeId", "yieldPct", "countFrequency", "updatedAt")
      VALUES (${randomUUID()}, ${tenantId}, ${name}, ${recipe.yieldUnit || 'g'}, ${CATEGORY_FOR_CLASS[cls]}, 'prep', ${recipeId}, 100, 'daily', now())
      ON CONFLICT ("prepRecipeId") DO NOTHING`
    row = await read()
    if (!row) throw new AppError('PREP_ITEM_MISSING', 'The prep item could not be created', 500)
  }
  if (row.tenantId !== tenantId) {
    throw new AppError('RECIPE_NOT_IN_COMPANY', 'That prep recipe\'s stock belongs to another company — sub-recipes are never shared across companies', 422)
  }
  if (row.deletedAt) throw new AppError('PREP_ITEM_IN_TRASH', `${row.name} is in the Trash — restore it before making a batch`, 422)
  return { id: row.id, name: row.name, unit: row.unit, tenantId, category: row.category }
}

/** The company a prep recipe belongs to: the one whose brands use it (null when none, or more than one). */
export async function prepRecipeCompany(recipeId: string): Promise<string | null> {
  const { subRecipeIdsForCompany } = await import('../par-sheet/routes.js')
  const tenants = await prisma.tenant.findMany({ where: { kind: 'company', deletedAt: null }, select: { id: true } })
  const owners: string[] = []
  for (const t of tenants) if ((await subRecipeIdsForCompany(t.id)).has(recipeId)) owners.push(t.id)
  return owners.length === 1 ? owners[0]! : null
}

/** Every production prep recipe of a company gets its prep item (idempotent). Returns how many were created. */
export async function ensurePrepItemsForCompany(tenantId: string): Promise<number> {
  const { subRecipeIdsForCompany } = await import('../par-sheet/routes.js')
  const ids = [...(await subRecipeIdsForCompany(tenantId))]
  if (ids.length === 0) return 0
  const recipes = await prisma.recipe.findMany({ where: { id: { in: ids }, kind: 'component', status: 'production', prepItem: null }, select: { id: true } })
  let made = 0
  for (const r of recipes) {
    try {
      await ensurePrepItemTx(prisma, r.id, tenantId)
      made += 1
    } catch (err) {
      console.warn(`[prepItems] ${r.id} in ${tenantId}: ${(err as Error).message}`)
    }
  }
  return made
}

/** The go-live step (boot): every active trading company. */
export async function ensureAllPrepItems(): Promise<Array<{ tenantId: string; created: number }>> {
  const tenants = await prisma.tenant.findMany({ where: { kind: 'company', isActive: true, deletedAt: null }, select: { id: true } })
  const out: Array<{ tenantId: string; created: number }> = []
  for (const t of tenants) out.push({ tenantId: t.id, created: await ensurePrepItemsForCompany(t.id) })
  return out
}

/** After a recipe's approval (never throws): a production prep recipe of one company gets its prep item. */
export async function prepItemOnApproval(recipeId: string, companyIds: string[]): Promise<void> {
  try {
    const r = await prisma.recipe.findUnique({ where: { id: recipeId }, select: { kind: true, status: true } })
    if (!r || r.kind !== 'component' || r.status !== 'production') return
    const tenantId = companyIds.length === 1 ? companyIds[0]! : await prepRecipeCompany(recipeId)
    if (tenantId) await ensurePrepItemTx(prisma, recipeId, tenantId)
  } catch (err) {
    console.warn(`[prepItems] approval of ${recipeId}: ${(err as Error).message}`)
  }
}
