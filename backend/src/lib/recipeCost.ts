// THE recipe explosion, plate costing and below-par rule.
//
// One place answers "what does this plate consume, and what does it cost?" —
// sale-time stock depletion (orders/service.ts), ledger COGS
// (accounting/orderPosting.ts), the recipe list and costing panel, the
// food-cost report, menu engineering and the ops prep list all call it. Before
// this there were six copies that disagreed: the depletion subtracted recipe
// GRAMS from stock held in KILOS (150 g off a 20 kg sack clamped it to zero and
// auto-86'd every dish using it), several multiplied a per-kg price by grams
// (1000x high), some skipped sub-recipes, the ledger used a fixed 5% Q factor
// and applied it twice on sub-recipe lines, and three added kitchen labour at
// PKR 50/hr on top of the payroll the pricing page already charges as opex.
//
// Conventions (the ones the recipe form and costing screens already use):
//
//   • InventoryItem.unit is the PURCHASE unit and unitCostCents the price of
//     one of them. currentStock is counted in purchase units.
//   • RecipeIngredient.quantity is in the MEASURE unit: grams for items bought
//     by weight, millilitres for items bought by volume, pieces for count
//     items. (The line's own `unit` column is a display label — the recipe
//     form writes the item's purchase unit there — so it is NOT used for
//     conversion.) Grams and millilitres are treated alike (density 1), as the
//     costing has always done.
//   • RecipeIngredient.yieldPct is a fraction (0.01–1): to end up with
//     `quantity` usable you draw quantity ÷ yield. Sub-recipe lines are already
//     yielded by their own batch and are not divided again.
//   • A sub-recipe (kind 'component') is consumed by the gram against its batch
//     yieldGrams. A plate recipe makes `servings` portions per batch.
//   • Q factor (Recipe.qFactorPct, default 10) is a COST uplift for unmeasured
//     salt/oil/waste. It is applied ONCE, by the recipe that directly contains
//     a raw line — a sub-recipe's cost-per-gram carries its own Q, and the
//     plate's Q is not applied on top of it. It never changes the quantities
//     taken out of stock.
//   • No kitchen labour in plate cost (owner decision 26, 2026-09-27). Labour
//     reaches the price only through payroll, as opex per portion.
//
// The costing functions are pure over a RecipeGraph so they can be unit-tested
// without a database; the loaders at the bottom build the graph with Prisma.

import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'

// ─── Units ────────────────────────────────────────────────────────────────────

const BULK_UNITS = new Set([
  'kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms',
  'l', 'lt', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters',
])
const DOZEN_UNITS = new Set(['dozen', 'doz', 'dz'])

function norm(unit: string | null | undefined): string {
  return (unit ?? '').trim().toLowerCase()
}

/**
 * How many recipe measure units (g / ml / pieces) make one purchase unit:
 * 1000 for an item bought by the kilo or litre, 12 for one bought by the
 * dozen (recipes count eggs, not dozens), 1 otherwise (g, ml, pcs, each,
 * pack… — the recipe quantity is already in purchase units).
 */
export function measuresPerPurchaseUnit(unit: string | null | undefined): number {
  const u = norm(unit)
  if (BULK_UNITS.has(u)) return 1000
  if (DOZEN_UNITS.has(u)) return 12
  return 1
}

/** Cost of ONE recipe measure unit (per g / ml / piece) of an item. */
export function costPerMeasureCents(unit: string | null | undefined, unitCostCents: number | null | undefined): number {
  return (unitCostCents ?? 0) / measuresPerPurchaseUnit(unit)
}

/** A recipe-measure quantity (g / ml / pcs) expressed in the item's purchase unit. */
export function measureToPurchaseUnits(measureQty: number, itemUnit: string | null | undefined): number {
  return measureQty / measuresPerPurchaseUnit(itemUnit)
}

type Dim = 'mass' | 'count'
const UNIT_TABLE: Record<string, { dim: Dim; base: number }> = (() => {
  const t: Record<string, { dim: Dim; base: number }> = {}
  // Mass and volume share one dimension (density 1) — see the header.
  for (const u of ['mg']) t[u] = { dim: 'mass', base: 0.001 }
  for (const u of ['g', 'gm', 'gms', 'gr', 'gram', 'grams', 'ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters']) t[u] = { dim: 'mass', base: 1 }
  for (const u of BULK_UNITS) t[u] = { dim: 'mass', base: 1000 }
  for (const u of ['pcs', 'pc', 'piece', 'pieces', 'unit', 'units', 'each', 'ea', 'no', 'nos']) t[u] = { dim: 'count', base: 1 }
  for (const u of DOZEN_UNITS) t[u] = { dim: 'count', base: 12 }
  return t
})()

/**
 * Convert a quantity written in an explicit unit (a prep-batch input, a waste
 * log) into the item's purchase unit. An empty unit means the recipe measure
 * convention. Returns null when the two can't be reconciled (pieces of an item
 * bought by the kilo, or a unit we don't know) — the caller should refuse
 * rather than guess, since a guess is how stock ended up 1000x off.
 */
export function toPurchaseUnits(qty: number, fromUnit: string | null | undefined, itemUnit: string | null | undefined): number | null {
  const from = norm(fromUnit)
  const to = norm(itemUnit)
  if (!from) return measureToPurchaseUnits(qty, itemUnit)
  if (from === to) return qty
  const f = UNIT_TABLE[from]
  const t = UNIT_TABLE[to]
  if (!f || !t || f.dim !== t.dim) return null
  return (qty * f.base) / t.base
}

// ─── Recipe graph ─────────────────────────────────────────────────────────────

export interface CostItem {
  id: string
  unit: string | null
  unitCostCents: number | null
}

export interface CostLine {
  id?: string
  inventoryItemId: string | null
  prepRecipeId: string | null
  quantity: number
  yieldPct: number
  inventoryItem: CostItem | null
}

export interface CostRecipe {
  id: string
  kind: string
  menuItemId?: string | null
  servings: number
  yieldGrams: number | null
  qFactorPct: number
  ingredients: CostLine[]
}

/** Every recipe a costing or explosion may need, by id (plates + their sub-recipes). */
export type RecipeGraph = Map<string, CostRecipe>

export function buildRecipeGraph(recipes: CostRecipe[]): RecipeGraph {
  return new Map(recipes.map((r) => [r.id, r]))
}

/** Line yield as a fraction. Values above 1 are a percent stored by mistake. */
function lineYield(y: number | null | undefined): number {
  if (!y || y <= 0) return 1
  return y > 1 ? y / 100 : y
}

// ─── Explosion: what a recipe takes out of stock ─────────────────────────────

/** Purchase units of one raw line for one batch of its recipe. */
function linePurchaseQty(line: CostLine): number {
  return measureToPurchaseUnits(line.quantity / lineYield(line.yieldPct), line.inventoryItem?.unit)
}

function explodeBatches(graph: RecipeGraph, recipeId: string, batches: number, out: Map<string, number>, stack: Set<string>): void {
  const r = graph.get(recipeId)
  if (!r || stack.has(recipeId) || !(batches > 0)) return   // unknown, cyclic (A→B→A) or nothing to make
  stack.add(recipeId)
  for (const line of r.ingredients) {
    if (line.prepRecipeId) {
      const sub = graph.get(line.prepRecipeId)
      // A sub-recipe with no batch yield can't be scaled to the grams used.
      if (sub?.yieldGrams && sub.yieldGrams > 0) {
        explodeBatches(graph, sub.id, batches * (line.quantity / sub.yieldGrams), out, stack)
      }
    } else if (line.inventoryItemId && line.inventoryItem) {
      out.set(line.inventoryItemId, (out.get(line.inventoryItemId) ?? 0) + batches * linePurchaseQty(line))
    }
  }
  stack.delete(recipeId)
}

export type ExplodeBasis = 'portion' | 'batch' | 'gram'

/**
 * What `qty` of a recipe takes out of stock, per inventory item, in PURCHASE
 * units (kg / litres / pcs — the unit currentStock is held in), recursing
 * through sub-recipes. `per`:
 *   'portion' (default) — qty portions of a plate (a batch makes `servings`)
 *   'batch'             — qty whole batches
 *   'gram'              — qty grams of a sub-recipe (against its yieldGrams)
 */
export function explodeRecipe(graph: RecipeGraph, recipeId: string, qty: number, per: ExplodeBasis = 'portion'): Map<string, number> {
  const out = new Map<string, number>()
  const r = graph.get(recipeId)
  if (!r) return out
  const batches =
    per === 'batch' ? qty :
    per === 'gram'  ? (r.yieldGrams && r.yieldGrams > 0 ? qty / r.yieldGrams : 0) :
                      qty / Math.max(r.servings || 1, 1)
  explodeBatches(graph, recipeId, batches, out, new Set())
  return out
}

/** Add `b` into `a` (per-item quantities). */
export function mergeQuantities(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
  for (const [k, v] of b) a.set(k, (a.get(k) ?? 0) + v)
  return a
}

// ─── Costing: what a recipe costs ────────────────────────────────────────────

export interface RecipeLineCost {
  /** RecipeIngredient.id when the graph carries it. */
  ingredientId: string | null
  inventoryItemId: string | null
  prepRecipeId: string | null
  /** As written on the recipe: measure units, or grams of a sub-recipe. */
  quantity: number
  /** Raw lines: purchase units drawn per batch (after yield). 0 for sub-recipes. */
  purchaseQty: number
  /** Raw lines: cost per g / ml / piece. Sub-recipes: cost per gram (incl. its own Q). */
  costPerMeasureCents: number
  /** Unrounded. Raw lines exclude Q; sub-recipe lines include the sub-recipe's own Q. */
  costCents: number
}

export interface RecipeCost {
  lines: RecipeLineCost[]
  /** Raw inventory lines of THIS recipe, before Q. */
  rawIngredientCents: number
  /** Sub-recipe lines (each already carrying its own Q). */
  componentCents: number
  /** raw + components — "ingredient cost" on the screens. */
  ingredientCents: number
  /** This recipe's Q factor, on its raw lines only. */
  qCents: number
  /** One batch: ingredientCents + qCents. No labour (decision 26). */
  totalCents: number
  /** totalCents ÷ servings. */
  perPortionCents: number
  /** Sub-recipes: totalCents ÷ yieldGrams. Null without a yield. */
  perGramCents: number | null
}

const EMPTY_COST: RecipeCost = {
  lines: [], rawIngredientCents: 0, componentCents: 0, ingredientCents: 0,
  qCents: 0, totalCents: 0, perPortionCents: 0, perGramCents: null,
}

/**
 * Plate / batch cost of one recipe. Memoised per graph so a list of recipes
 * sharing sub-recipes costs each sub-recipe once. A cycle contributes 0.
 */
export function recipeCost(graph: RecipeGraph, recipeId: string, memo: Map<string, RecipeCost> = new Map()): RecipeCost {
  return costOf(graph, recipeId, memo, new Set())
}

function costOf(graph: RecipeGraph, recipeId: string, memo: Map<string, RecipeCost>, stack: Set<string>): RecipeCost {
  const cached = memo.get(recipeId)
  if (cached) return cached
  const r = graph.get(recipeId)
  if (!r || stack.has(recipeId)) return EMPTY_COST
  stack.add(recipeId)

  let raw = 0
  let comp = 0
  const lines: RecipeLineCost[] = r.ingredients.map((line) => {
    if (line.prepRecipeId) {
      const cpg = costOf(graph, line.prepRecipeId, memo, stack).perGramCents ?? 0
      const costCents = cpg * line.quantity
      comp += costCents
      return {
        ingredientId: line.id ?? null, inventoryItemId: null, prepRecipeId: line.prepRecipeId,
        quantity: line.quantity, purchaseQty: 0, costPerMeasureCents: cpg, costCents,
      }
    }
    const item = line.inventoryItem
    const purchaseQty = item ? linePurchaseQty(line) : 0
    const costCents = item ? purchaseQty * (item.unitCostCents ?? 0) : 0
    raw += costCents
    return {
      ingredientId: line.id ?? null, inventoryItemId: line.inventoryItemId, prepRecipeId: null,
      quantity: line.quantity, purchaseQty,
      costPerMeasureCents: item ? costPerMeasureCents(item.unit, item.unitCostCents) : 0,
      costCents,
    }
  })
  stack.delete(recipeId)

  const qCents = raw * ((r.qFactorPct ?? 10) / 100)
  const totalCents = raw + comp + qCents
  const result: RecipeCost = {
    lines,
    rawIngredientCents: raw,
    componentCents: comp,
    ingredientCents: raw + comp,
    qCents,
    totalCents,
    perPortionCents: totalCents / Math.max(r.servings || 1, 1),
    perGramCents: r.yieldGrams && r.yieldGrams > 0 ? totalCents / r.yieldGrams : null,
  }
  memo.set(recipeId, result)
  return result
}

// ─── Below par ────────────────────────────────────────────────────────────────
//
// THE low-stock rule, for every reader (inventory list flag, alerts, the
// low-stock webhook, ops anomalies, F&B metrics, the emailed report, reorder
// suggestions). InventoryItem.parLevel is the alert threshold; parLevel 0 means
// "no threshold" (catalogue items that aren't stocked) and is never below par.
// At par counts as below par. Scope is the ITEM's company.

export interface ParFields { currentStock: number; parLevel: number }

export function isBelowPar(item: ParFields, onOrder = 0): boolean {
  return item.parLevel > 0 && item.currentStock + onOrder <= item.parLevel
}

/** Prisma `where` for the same rule (without on-order netting). */
export function belowParWhere(): Prisma.InventoryItemWhereInput {
  return { parLevel: { gt: 0 }, currentStock: { lte: prisma.inventoryItem.fields.parLevel } }
}

// ─── Loaders ──────────────────────────────────────────────────────────────────

type Db = Prisma.TransactionClient

const COST_RECIPE_SELECT = {
  id: true, kind: true, menuItemId: true, servings: true, yieldGrams: true, qFactorPct: true,
  ingredients: {
    select: {
      id: true, inventoryItemId: true, prepRecipeId: true, quantity: true, yieldPct: true,
      inventoryItem: { select: { id: true, unit: true, unitCostCents: true } },
    },
  },
} satisfies Prisma.RecipeSelect

/**
 * Load the recipes matching `where` plus every sub-recipe they reach, however
 * deep. Returns the graph and the matched (root) recipes.
 */
export async function loadRecipeGraph(where: Prisma.RecipeWhereInput, db: Db = prisma): Promise<{ graph: RecipeGraph; roots: CostRecipe[] }> {
  const roots = (await db.recipe.findMany({ where, select: COST_RECIPE_SELECT })) as CostRecipe[]
  const graph = buildRecipeGraph(roots)
  let pending = roots
  while (pending.length > 0) {
    const missing = new Set<string>()
    for (const r of pending) {
      for (const l of r.ingredients) if (l.prepRecipeId && !graph.has(l.prepRecipeId)) missing.add(l.prepRecipeId)
    }
    if (missing.size === 0) break
    pending = (await db.recipe.findMany({ where: { id: { in: [...missing] } }, select: COST_RECIPE_SELECT })) as CostRecipe[]
    for (const r of pending) graph.set(r.id, r)
  }
  return { graph, roots }
}

/** Plate cost per menu item (only items that have a recipe appear). */
export async function menuItemPlateCosts(menuItemIds: string[], db: Db = prisma): Promise<Map<string, RecipeCost>> {
  const out = new Map<string, RecipeCost>()
  if (menuItemIds.length === 0) return out
  const { graph, roots } = await loadRecipeGraph({ menuItemId: { in: menuItemIds } }, db)
  const memo = new Map<string, RecipeCost>()
  for (const r of roots) if (r.menuItemId) out.set(r.menuItemId, recipeCost(graph, r.id, memo))
  return out
}

export interface SoldLine { menuItemId: string | null; quantity: number; status?: string | null }

/** What a set of sold lines takes out of stock, per inventory item, in purchase units. Voided lines are skipped. */
export async function consumptionForSoldLines(lines: SoldLine[], db: Db = prisma): Promise<Map<string, number>> {
  const live = lines.filter((l) => l.menuItemId && l.status !== 'voided' && l.quantity > 0)
  const out = new Map<string, number>()
  if (live.length === 0) return out
  const { graph, roots } = await loadRecipeGraph({ menuItemId: { in: [...new Set(live.map((l) => l.menuItemId!))] } }, db)
  const byMenuItem = new Map(roots.map((r) => [r.menuItemId, r.id]))
  for (const l of live) {
    const rid = byMenuItem.get(l.menuItemId)
    if (rid) mergeQuantities(out, explodeRecipe(graph, rid, l.quantity, 'portion'))
  }
  return out
}

/** Theoretical cost of goods for a set of sold lines, in paisa. Voided lines and items without a recipe cost 0. */
export async function cogsForSoldLines(lines: SoldLine[], db: Db = prisma): Promise<number> {
  const live = lines.filter((l) => l.menuItemId && l.status !== 'voided' && l.quantity > 0)
  if (live.length === 0) return 0
  const costs = await menuItemPlateCosts([...new Set(live.map((l) => l.menuItemId!))], db)
  let total = 0
  for (const l of live) total += (costs.get(l.menuItemId!)?.perPortionCents ?? 0) * l.quantity
  return Math.round(total)
}

/** Theoretical COGS of one order — what the ledger books at completion. */
export async function orderCogsCents(orderId: string, db: Db = prisma): Promise<number> {
  const items = await db.orderItem.findMany({
    where: { orderId },
    select: { menuItemId: true, quantity: true, status: true },
  })
  return cogsForSoldLines(items, db)
}
