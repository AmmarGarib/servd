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
//   • Q is a PRICING allowance only (H18): never a stock quantity, never
//     posted. It applies to the ingredient lines, not the Packaging section.
//
// Sections and the packaging rule (owner's FINAL rule, 2026-10-13):
//
//   • A plate recipe's lines are 'ingredients' or 'packaging'
//     (RecipeIngredient.section). A sale consumes the Packaging section ONLY
//     when packagingApplies(order, line): takeaway / delivery (every
//     off-premise fulfilment) → yes; else the line's snapshotted brand vessel
//     (OrderItem.serviceVessel, Concept.serviceVessel at ring-up) is
//     'packaging' → yes; else (dine-in at a plate brand) → only when staff
//     tapped "Box given" on the line. THE one seam — stock depletion, the books
//     and the food-cost report all follow it.
//   • A modifier (add-on) has its own recipe (RecipeKind 'modifier',
//     Recipe.modifierId): what ONE unit of the add-on uses, per unit of the
//     dish. Only a modifier recipe may carry negative lines ('removes', e.g.
//     "no cheese"); a line's total per ingredient is clamped at zero.
//   • Prep as stock (owner, 2026-10-24, D3): a sub-recipe with a PREP ITEM
//     (InventoryItem.prepRecipeId) is stock of its own — a prep batch takes
//     its raw ingredients out and adds the prep item. A sale (and a prep batch
//     that uses another prep) draws the PREP ITEM, in its own unit, the
//     quantity on the plate — never its raw ingredients again. A sub-recipe
//     with no prep item still explodes to its raw ingredients. Costing
//     (recipeCost) and explodeRecipe (par sheet, prep list) stay raw.
//   • A sale consumes only the ORDER's company's items: an item of another
//     company, or of none, is excluded (never consumed) and reported.
//
// The costing functions are pure over a RecipeGraph so they can be unit-tested
// without a database; the loaders at the bottom build the graph with Prisma.

import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { costClassOf, COST_CLASSES, zeroByClass, type CostClass } from './inventoryClass.js'

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
  /** The item's company. Null = company-less: never consumed by a sale. Undefined = not loaded (pure costing). */
  tenantId?: string | null
  /** InventoryItem.category — its cost class (lib/inventoryClass.ts costClassOf). */
  category?: string | null
  /** The servd ingredient master it is (kitchen flow K1) — how a shared recipe's line finds another company's item. */
  masterIngredientId?: string | null
  /** Set by withLatestCosts: the latest cost (unitCostCents then carries it) and when it was paid / typed. */
  latestCostCents?: number | null
  latestCostAt?: Date | null
  /**
   * Set by localiseGraph `strict`: the viewing / selling company does not stock this ingredient — the line shows
   * no price (never another company's) and the item here is still the other company's (do not draw it).
   */
  notStocked?: boolean
}

/** RecipeIngredient.section. */
export type RecipeSection = 'ingredients' | 'packaging'
/** Concept.serviceVessel (snapshotted on OrderItem.serviceVessel at ring-up). */
export type ServiceVessel = 'plate' | 'packaging'

export interface CostLine {
  id?: string
  inventoryItemId: string | null
  prepRecipeId: string | null
  quantity: number
  yieldPct: number
  inventoryItem: CostItem | null
  /** 'ingredients' (default) | 'packaging' — packaging lines only on plate recipes. */
  section?: string | null
  /** RecipeIngredient.masterIngredientId (kitchen flow K4); falls back to the item's own master. */
  masterIngredientId?: string | null
}

export interface CostRecipe {
  id: string
  kind: string
  menuItemId?: string | null
  /** kind 'modifier': the add-on it costs. */
  modifierId?: string | null
  servings: number
  yieldGrams: number | null
  qFactorPct: number
  ingredients: CostLine[]
  /** A plate's brand vessel (Concept.serviceVessel) — decides the dine-in target MC. Null/undefined = 'plate'. */
  serviceVessel?: string | null
  /**
   * kind 'component': the stock item the recipe MAKES (InventoryItem.prepRecipeId — owner 2026-10-24, D3: "prep items
   * become stock"). When set, what consumes this sub-recipe draws THIS item (its own unit, the quantity on the plate,
   * no yield gross-up) — never its raw ingredients again: they left stock when the batch was made.
   */
  prepItem?: CostItem | null
  /**
   * Kitchen flow (2026-10-26): a sub-recipe's prep items, one per company that has made it (InventoryItem
   * @@unique([tenantId, prepRecipeId])) — only those that hold (or held) a lot. The explosion draws the one of the
   * consuming company (prepItemFor); `prepItem` is kept as the first of them for old readers.
   */
  prepItems?: CostItem[]
  /** Recipe.tenantId — the OWNER company (K4). A shared recipe's owner-company lines resolve per company (localiseGraph). */
  tenantId?: string | null
}

/** The prep item a sub-recipe draws in `tenantId` (null = explode raw). */
export function prepItemFor(r: CostRecipe | undefined, tenantId: string): CostItem | null {
  if (!r) return null
  const list = r.prepItems ?? (r.prepItem ? [r.prepItem] : [])
  return list.find((p) => p.tenantId === tenantId) ?? null
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

const isPackagingLine = (line: CostLine): boolean => line.section === 'packaging'

/** Which of the TOP recipe's lines an explosion takes (sub-recipes always explode whole). */
interface TopFilter {
  sections: 'all' | RecipeSection
  /** Negative ('removes') lines count — modifier recipes only. Elsewhere they are skipped. */
  allowNegative: boolean
}

/**
 * Prep as stock, PER SITE (owner 2026-10-24, D3): a sub-recipe draws its prep
 * item only when the item is of `tenantId` AND is in `live` — the prep items
 * the cooking site has ever held a lot of. At any other site (or for another
 * company) the sub-recipe explodes to its raw ingredients, as before.
 */
export interface PrepStock { tenantId: string; live: Set<string> }

/**
 * The prep items of `graph` live at a site: ever held a lot there (`siteId`
 * null = the company pool of a company with no location). 'any' = a lot
 * anywhere (company-level readers).
 */
export async function livePrepItems(db: Db, graph: RecipeGraph, at: 'any' | { siteId: string | null }): Promise<Set<string>> {
  const ids = [...new Set([...graph.values()].flatMap((r) => (r.prepItems ?? (r.prepItem ? [r.prepItem] : [])).map((p) => p.id)))]
  if (ids.length === 0 || at === 'any') return new Set(ids)
  const rows = await db.stockLot.findMany({
    where: { inventoryItemId: { in: ids }, locationId: at.siteId }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'],
  })
  return new Set(rows.map((r) => r.inventoryItemId))
}

function explodeBatches(
  graph: RecipeGraph, recipeId: string, batches: number, out: Map<string, number>, stack: Set<string>, top: TopFilter | null,
  /** Which prep items count as stock here (see PrepStock); false = raw. */
  prepAsStock: PrepStock | false = false,
): void {
  const r = graph.get(recipeId)
  if (!r || stack.has(recipeId) || !(batches > 0)) return   // unknown, cyclic (A→B→A) or nothing to make
  stack.add(recipeId)
  for (const line of r.ingredients) {
    if (top && top.sections !== 'all' && (isPackagingLine(line) ? 'packaging' : 'ingredients') !== top.sections) continue
    if (line.quantity < 0 && !top?.allowNegative) continue
    if (line.prepRecipeId) {
      const sub = graph.get(line.prepRecipeId)
      const own = prepAsStock ? prepItemFor(sub, prepAsStock.tenantId) : null
      if (prepAsStock && own && prepAsStock.live.has(own.id)) {
        // Prep as stock (D3): the prep ITEM, in its own unit, the quantity on the plate (no yield gross-up — the
        // batch's actual yield already carries the loss). A 'removes' line takes it back out (negative).
        const item = own
        out.set(item.id, (out.get(item.id) ?? 0) + batches * measureToPurchaseUnits(line.quantity, item.unit))
        continue
      }
      // A sub-recipe with no batch yield can't be scaled to the grams used.
      if (sub?.yieldGrams && sub.yieldGrams > 0) {
        if (line.quantity > 0) {
          explodeBatches(graph, sub.id, batches * (line.quantity / sub.yieldGrams), out, stack, null, prepAsStock)
        } else if (line.quantity < 0) {
          // A modifier that removes a sub-recipe: its exploded quantities, negated.
          const back = new Map<string, number>()
          explodeBatches(graph, sub.id, batches * (-line.quantity / sub.yieldGrams), back, stack, null, prepAsStock)
          for (const [k, v] of back) out.set(k, (out.get(k) ?? 0) - v)
        }
      }
    } else if (line.inventoryItemId && line.inventoryItem) {
      out.set(line.inventoryItemId, (out.get(line.inventoryItemId) ?? 0) + batches * linePurchaseQty(line))
    }
  }
  stack.delete(recipeId)
}

export type ExplodeBasis = 'portion' | 'batch' | 'gram'

function batchesOf(r: CostRecipe, qty: number, per: ExplodeBasis): number {
  return per === 'batch' ? qty
    : per === 'gram' ? (r.yieldGrams && r.yieldGrams > 0 ? qty / r.yieldGrams : 0)
    : qty / Math.max(r.servings || 1, 1)
}

/**
 * What `qty` of a recipe takes out of stock, per inventory item, in PURCHASE
 * units (kg / litres / pcs — the unit currentStock is held in), recursing
 * through sub-recipes. Every section (ingredients + packaging) — a sale reads
 * consumptionPerLine instead, which applies the packaging rule. `per`:
 *   'portion' (default) — qty portions of a plate (a batch makes `servings`)
 *   'batch'             — qty whole batches
 *   'gram'              — qty grams of a sub-recipe (against its yieldGrams)
 */
export function explodeRecipe(graph: RecipeGraph, recipeId: string, qty: number, per: ExplodeBasis = 'portion'): Map<string, number> {
  const out = new Map<string, number>()
  const r = graph.get(recipeId)
  if (!r) return out
  explodeBatches(graph, recipeId, batchesOf(r, qty, per), out, new Set(), { sections: 'all', allowNegative: r.kind === 'modifier' })
  return out
}

/**
 * What ONE prep batch run of `batches` whole batches of a sub-recipe draws from
 * stock, per item, in purchase units: its own raw lines (yield grossed up) and,
 * for a sub-recipe inside it that has a prep item, that prep item (D3) — never
 * the recipe's own prep item. Packaging lines are not on sub-recipes.
 */
export function explodeForPrepBatch(graph: RecipeGraph, recipeId: string, batches: number, prep: PrepStock): Map<string, number> {
  const out = new Map<string, number>()
  if (!graph.get(recipeId)) return out
  explodeBatches(graph, recipeId, batches, out, new Set(), { sections: 'all', allowNegative: false }, prep)
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
  /** Raw inventory lines of THIS recipe (both sections), before Q. */
  rawIngredientCents: number
  /** Sub-recipe lines (each already carrying its own Q). */
  componentCents: number
  /** raw + components — "ingredient cost" on the screens (packaging section included, as before). */
  ingredientCents: number
  /** This recipe's Q factor on its INGREDIENT raw lines (one batch) — a pricing allowance only (H18): never stock, never posted. */
  qCents: number
  /** One batch: ingredientCents + qCents. No labour (decision 26). */
  totalCents: number
  /** totalCents ÷ servings. */
  perPortionCents: number
  /** Sub-recipes: totalCents ÷ yieldGrams. Null without a yield. */
  perGramCents: number | null
  // ── Material cost (MC), PER PORTION, ex-Q, every depth (wave B, owner's FINAL packaging rule) ──
  /** Everything the dish can consume by cost class (food / drinks / packaging), Packaging section included. */
  stockByClass: Record<CostClass, number>
  /** The dish's Packaging section alone (plate recipes). */
  packagingCents: number
  /** The plate MC: what every sale of it consumes — stockByClass less the Packaging section (food + drinks). */
  standardCents: number
  /**
   * The TARGET MC per order type: standardCents + packagingCents where the
   * packaging applies to that order type for the recipe's brand vessel —
   * takeaway and delivery always; dine-in only at a 'packaging' brand (a
   * dine-in "Box given" is an ACTUAL, not a target).
   */
  targetMcCents: { dine_in: number; takeout: number; delivery: number }
}

const EMPTY_COST: RecipeCost = {
  lines: [], rawIngredientCents: 0, componentCents: 0, ingredientCents: 0,
  qCents: 0, totalCents: 0, perPortionCents: 0, perGramCents: null,
  stockByClass: zeroByClass(), packagingCents: 0, standardCents: 0, targetMcCents: { dine_in: 0, takeout: 0, delivery: 0 },
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
  let rawForQ = 0
  let comp = 0
  let packBatch = 0
  const byClassBatch = zeroByClass()
  const lines: RecipeLineCost[] = r.ingredients.map((line) => {
    if (line.prepRecipeId) {
      const subCost = costOf(graph, line.prepRecipeId, memo, stack)
      const cpg = subCost.perGramCents ?? 0
      const costCents = cpg * line.quantity
      comp += costCents
      // The sub-recipe's MC by class, ex-Q, scaled from its batch to the grams used.
      const sub = graph.get(line.prepRecipeId)
      if (sub?.yieldGrams && sub.yieldGrams > 0) {
        const servings = Math.max(sub.servings || 1, 1)
        for (const c of COST_CLASSES) {
          const v = (subCost.stockByClass[c] * servings / sub.yieldGrams) * line.quantity
          byClassBatch[c] += v
          if (isPackagingLine(line)) packBatch += v
        }
      }
      return {
        ingredientId: line.id ?? null, inventoryItemId: null, prepRecipeId: line.prepRecipeId,
        quantity: line.quantity, purchaseQty: 0, costPerMeasureCents: cpg, costCents,
      }
    }
    const item = line.inventoryItem
    const purchaseQty = item ? linePurchaseQty(line) : 0
    const costCents = item ? purchaseQty * (item.unitCostCents ?? 0) : 0
    raw += costCents
    if (isPackagingLine(line)) packBatch += costCents
    else rawForQ += costCents
    if (item) byClassBatch[costClassOf(item.category)] += costCents
    return {
      ingredientId: line.id ?? null, inventoryItemId: line.inventoryItemId, prepRecipeId: null,
      quantity: line.quantity, purchaseQty,
      costPerMeasureCents: item ? costPerMeasureCents(item.unit, item.unitCostCents) : 0,
      costCents,
    }
  })
  stack.delete(recipeId)

  const servings = Math.max(r.servings || 1, 1)
  const qCents = rawForQ * ((r.qFactorPct ?? 10) / 100)
  const totalCents = raw + comp + qCents
  const stockByClass = zeroByClass()
  for (const c of COST_CLASSES) stockByClass[c] = byClassBatch[c] / servings
  const packagingCents = packBatch / servings
  const allCents = COST_CLASSES.reduce((sum, c) => sum + stockByClass[c], 0)
  const standardCents = allCents - packagingCents
  const vessel = r.serviceVessel === 'packaging' ? 'packaging' : 'plate'
  const result: RecipeCost = {
    lines,
    rawIngredientCents: raw,
    componentCents: comp,
    ingredientCents: raw + comp,
    qCents,
    totalCents,
    perPortionCents: totalCents / servings,
    perGramCents: r.yieldGrams && r.yieldGrams > 0 ? totalCents / r.yieldGrams : null,
    stockByClass,
    packagingCents,
    standardCents,
    targetMcCents: {
      dine_in: standardCents + (vessel === 'packaging' ? packagingCents : 0),
      takeout: standardCents + packagingCents,
      delivery: standardCents + packagingCents,
    },
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

const COST_ITEM_SELECT = { id: true, unit: true, unitCostCents: true, tenantId: true, category: true, masterIngredientId: true } as const

const COST_RECIPE_SELECT = {
  id: true, kind: true, menuItemId: true, modifierId: true, servings: true, yieldGrams: true, qFactorPct: true, tenantId: true,
  menuItem: { select: { concept: { select: { serviceVessel: true } } } },
  // `lots` (one row): the prep item switches on only once a batch has made stock — until then the dish explodes its
  // prep to raw ingredients as before, so a kitchen that has not logged a batch yet never runs short (owner card:
  // "run it in the family kitchen first, then Flipd").
  prepItems: { where: { deletedAt: null }, select: { ...COST_ITEM_SELECT, lots: { select: { id: true }, take: 1 } } },
  ingredients: {
    select: {
      id: true, inventoryItemId: true, prepRecipeId: true, quantity: true, yieldPct: true, section: true, masterIngredientId: true,
      inventoryItem: { select: COST_ITEM_SELECT },
    },
  },
} satisfies Prisma.RecipeSelect

type LoadedRecipe = Prisma.RecipeGetPayload<{ select: typeof COST_RECIPE_SELECT }>

function toCostRecipe(r: LoadedRecipe): CostRecipe {
  const { menuItem, prepItems, ...rest } = r
  const live = prepItems.filter((p) => p.lots.length > 0).map(({ lots: _lots, ...p }) => p)
  return { ...rest, serviceVessel: menuItem?.concept.serviceVessel ?? null, prepItems: live, prepItem: live[0] ?? null }
}

/**
 * Kitchen flow (owner, 2026-10-26, K4): a SHARED recipe (Recipe.tenantId = the owner company, e.g. GS Foods) resolves
 * each of its owner-company stock lines to `tenantId`'s OWN item for the same servd master — so a Flipd sale draws
 * Flipd's stock (in Flipd's books) and Flipd sees the dish costed at Flipd's prices. The company's item is the one
 * linked to the master, else its unlinked TWIN (same normalised name, a unit of the master's family — e.g. Flipd's
 * chicken in g for GS Foods' chicken in kg; lib/ingredientMaster.ts findCompanyItemForMaster).
 *   • `create`: a company with neither gets its item made from the master on the spot (ensureCompanyItemForMasterTx
 *     — lot-less, so the sale records a shortfall and is never blocked); a twin found is linked.
 *   • `strict` (cost screens, the prep / shopping lists): EVERY line whose item is not `tenantId`'s is resolved the
 *     same way, and a line still not resolved is marked `notStocked` with NO price — a viewing company never sees
 *     another company's price. Without `strict` only the recipe OWNER's lines move (a genuinely foreign item stays
 *     foreign and is excluded / flagged by the sale as before).
 * A recipe of `tenantId` itself is untouched (unless `strict` finds a foreign line). Returns a NEW graph.
 */
export async function localiseGraph(graph: RecipeGraph, tenantId: string, db: Db, o: {
  create?: boolean
  strict?: boolean
  /** strict only: an unresolved line whose item's company passes this keeps its own item and price (the viewer belongs to it; null = company-less legacy). */
  keep?: (itemTenantId: string | null) => boolean
} = {}): Promise<RecipeGraph> {
  const movable = (r: CostRecipe, l: CostLine): boolean => {
    const t = l.inventoryItem?.tenantId
    if (!l.inventoryItem || t === tenantId) return false
    if (o.strict) return true
    return !!r.tenantId && r.tenantId !== tenantId && t === r.tenantId
  }
  const masterOf = (l: CostLine): string | null => l.masterIngredientId ?? l.inventoryItem?.masterIngredientId ?? null
  const wanted = new Set<string>()
  for (const r of graph.values()) for (const l of r.ingredients) { const m = movable(r, l) ? masterOf(l) : null; if (m) wanted.add(m) }
  let anyMovable = false
  for (const r of graph.values()) for (const l of r.ingredients) if (movable(r, l)) anyMovable = true
  if (!anyMovable) return graph
  const local = new Map<string, CostItem>()
  if (wanted.size > 0) {
    const { ensureCompanyItemForMasterTx, findCompanyItemForMaster, liveMaster } = await import('./ingredientMaster.js')
    const ids = new Map<string, string>()   // master id → the company's item id
    for (const m of wanted) {
      if (o.create) { ids.set(m, (await ensureCompanyItemForMasterTx(db, tenantId, m)).id); continue }
      const master = await liveMaster(db, m).catch(() => null)
      const hit = master ? await findCompanyItemForMaster(db, tenantId, master) : null
      if (hit) ids.set(m, hit.id)
    }
    const rows = ids.size ? await db.inventoryItem.findMany({ where: { id: { in: [...ids.values()] } }, select: COST_ITEM_SELECT }) : []
    const byId = new Map(rows.map((i) => [i.id, i as CostItem]))
    for (const [m, id] of ids) { const it = byId.get(id); if (it) local.set(m, it) }
  }
  const out: RecipeGraph = new Map()
  for (const [id, r] of graph) {
    let changed = false
    const ingredients = r.ingredients.map((l) => {
      if (!movable(r, l)) return l
      const m = masterOf(l)
      const item = m ? local.get(m) : undefined
      if (item) { changed = true; return { ...l, inventoryItemId: item.id, inventoryItem: item } }
      if (!o.strict || o.keep?.(l.inventoryItem!.tenantId ?? null)) return l
      changed = true
      return { ...l, inventoryItem: { ...l.inventoryItem!, unitCostCents: null, notStocked: true } }
    })
    out.set(id, changed ? { ...r, ingredients } : r)
  }
  return out
}

/**
 * Recipes cost at the LATEST cost (owner, 2026-10-26): every raw line of the graph priced at its item's latest cost
 * (lib/stockLedger.ts latestCostsMany — the latest purchase price, else the latest manual cost, else the typed
 * estimate) instead of the FIFO head (InventoryItem.unitCostCents). For the recipe / sub-recipe costing screens, the
 * pricing and target price, and menu engineering — call it AFTER localiseGraph so each company prices at its own
 * latest cost. NEVER for stock value, FIFO lots, cost of sales, food-cost actuals or anything posted (those stay FIFO
 * at the price paid). Returns a new graph; prep items keep their own (made) cost.
 */
export async function withLatestCosts(graph: RecipeGraph, db: Db = prisma): Promise<RecipeGraph> {
  const ids = new Set<string>()
  for (const r of graph.values()) for (const l of r.ingredients) if (l.inventoryItem && !l.inventoryItem.notStocked) ids.add(l.inventoryItem.id)
  if (ids.size === 0) return graph
  const { latestCostsMany } = await import('./stockLedger.js')
  const latest = await latestCostsMany(db, [...ids])
  const out: RecipeGraph = new Map()
  for (const [id, r] of graph) {
    out.set(id, {
      ...r,
      ingredients: r.ingredients.map((l) => {
        if (!l.inventoryItem || l.inventoryItem.notStocked) return l
        const c = latest.get(l.inventoryItem.id)
        if (!c) return l
        return { ...l, inventoryItem: { ...l.inventoryItem, unitCostCents: c.cents, latestCostCents: c.cents, latestCostAt: c.at } }
      }),
    })
  }
  return out
}

/**
 * Load the recipes matching `where` plus every sub-recipe they reach, however
 * deep. Returns the graph and the matched (root) recipes.
 */
export async function loadRecipeGraph(where: Prisma.RecipeWhereInput, db: Db = prisma): Promise<{ graph: RecipeGraph; roots: CostRecipe[] }> {
  const roots = (await db.recipe.findMany({ where, select: COST_RECIPE_SELECT })).map(toCostRecipe)
  const graph = buildRecipeGraph(roots)
  let pending = roots
  while (pending.length > 0) {
    const missing = new Set<string>()
    for (const r of pending) {
      for (const l of r.ingredients) if (l.prepRecipeId && !graph.has(l.prepRecipeId)) missing.add(l.prepRecipeId)
    }
    if (missing.size === 0) break
    pending = (await db.recipe.findMany({ where: { id: { in: [...missing] } }, select: COST_RECIPE_SELECT })).map(toCostRecipe)
    for (const r of pending) graph.set(r.id, r)
  }
  return { graph, roots }
}

/**
 * Plate cost per menu item (only items that have a recipe appear). `latest`: priced at the latest cost (menu
 * engineering / pricing); default FIFO head (the food-cost report, the legacy theoretical COGS).
 */
export async function menuItemPlateCosts(menuItemIds: string[], db: Db = prisma, o: { latest?: boolean; tenantId?: string | null } = {}): Promise<Map<string, RecipeCost>> {
  const out = new Map<string, RecipeCost>()
  if (menuItemIds.length === 0) return out
  const loaded = await loadRecipeGraph({ menuItemId: { in: menuItemIds } }, db)
  const roots = loaded.roots
  // `tenantId`: the selling company — priced at that company's OWN items only (K4); a line it does not stock costs nothing.
  const local = o.tenantId ? await localiseGraph(loaded.graph, o.tenantId, db, { strict: true }) : loaded.graph
  const graph = o.latest ? await withLatestCosts(local, db) : local
  const memo = new Map<string, RecipeCost>()
  for (const r of roots) if (r.menuItemId) out.set(r.menuItemId, recipeCost(graph, r.id, memo))
  return out
}

// ─── The packaging rule ───────────────────────────────────────────────────────

/**
 * THE packaging seam (owner's FINAL rule, 2026-10-13): does this sold line use
 * its dish's Packaging section?
 *   • takeaway / delivery (every off-premise fulfilment) → yes;
 *   • else the line's brand vessel (OrderItem.serviceVessel, snapshotted at
 *     ring-up; a legacy line with none reads `concept`, the brand's current
 *     vessel) is 'packaging' (e.g. Stackd) → yes;
 *   • else (dine-in at a plate brand) → only when staff tapped "Box given".
 * Stock depletion, the books and the food-cost report all follow it.
 */
export function packagingApplies(
  order: { fulfilmentType: string },
  line: { serviceVessel: ServiceVessel | string | null; boxGiven: boolean },
  concept?: { serviceVessel?: string | null } | null,
): boolean {
  if (order.fulfilmentType !== 'dine_in') return true
  const vessel = line.serviceVessel ?? concept?.serviceVessel ?? 'plate'
  if (vessel === 'packaging') return true
  return line.boxGiven === true
}

/**
 * Staff tapped "Box given" on a dine-in line at a plate brand (leftovers boxed),
 * or undid it. Implemented in modules/orders/stock.ts (it moves stock) — see
 * there; re-exported here because the packaging rule lives here.
 */
export async function markBoxGiven(
  orderItemId: string,
  actor: { id: string; tenantIds?: string[] },
  opts: { undo?: boolean } = {},
): Promise<{ boxGiven: boolean; depleted: boolean }> {
  const { markBoxGiven: impl } = await import('../modules/orders/stock.js')
  return impl(orderItemId, actor, opts)
}

// ─── What a sale consumes ─────────────────────────────────────────────────────

export interface SoldLine {
  /** OrderItem.id, when there is one. */
  id?: string
  menuItemId: string | null
  quantity: number
  status?: string | null
  /** OrderItemModifier.modifierId of each add-on picked — one unit of the add-on per unit of the dish. */
  modifierIds?: Array<string | null>
  /** OrderItem.serviceVessel (null on legacy lines → the brand's current vessel). */
  serviceVessel?: string | null
  boxGiven?: boolean
}

export interface NeedRow { qty: number; costClass: CostClass }
export interface ExcludedItem {
  itemId: string
  reason: 'foreign' | 'company_less'
  /** The dish that drew it (one recipe_foreign_stock flag per (menu item, company)). */
  menuItemId: string | null
}

export interface LineConsumption {
  line: SoldLine
  /** What the line takes, per item, in purchase units: its ingredients + add-ons, plus its packaging when it applies. */
  need: Map<string, NeedRow>
  /** The dish's Packaging section alone, whether or not it applies (for "Box given"). */
  packaging: Map<string, NeedRow>
  packagingApplies: boolean
  /** Items of another company or of none — never consumed. */
  excluded: ExcludedItem[]
}

export interface ConsumptionOpts {
  /** The ORDER's company: only its items are consumed. */
  tenantId: string
  /** Order.fulfilmentType — 'dine_in' | 'takeout' | 'delivery'. */
  fulfilmentType: string
  /** The brand's current vessel, read by legacy lines with no snapshot. */
  serviceVessel?: string | null
  /**
   * Prep as stock: the site that cooks the order (lib/stockSite.ts stockSiteOf) — its live prep items are drawn,
   * other sub-recipes explode raw. 'any' = live at any site (company readers). Absent = raw (pre-cut-over paths).
   */
  prepStockAt?: 'any' | { siteId: string | null }
  /**
   * Kitchen flow (K4): a shared recipe's lines resolve to the ORDER company's own items (localiseGraph); true = make
   * the company's item from the servd master when it has none (the sale paths — lot-less, a shortfall, never a block).
   */
  createMissingItems?: boolean
}

/**
 * Per sold line (same order as `lines`; a voided / empty / unmapped line gets
 * empty maps): what it takes out of stock in PURCHASE units — the dish's
 * ingredients and sub-recipes, its add-ons' modifier recipes (clamped at zero
 * per ingredient per line: a 'removes' line can only take an ingredient out of
 * the dish, never below none), and its Packaging section when
 * packagingApplies. Items not of `o.tenantId` are excluded and reported.
 */
export async function consumptionPerLine(lines: SoldLine[], db: Db, o: ConsumptionOpts): Promise<LineConsumption[]> {
  const live = (l: SoldLine) => !!l.menuItemId && l.status !== 'voided' && l.quantity > 0
  const menuItemIds = [...new Set(lines.filter(live).map((l) => l.menuItemId!))]
  const modifierIds = [...new Set(lines.filter(live).flatMap((l) => (l.modifierIds ?? []).filter((m): m is string => !!m)))]
  const empty = (line: SoldLine): LineConsumption => ({ line, need: new Map(), packaging: new Map(), packagingApplies: false, excluded: [] })
  if (menuItemIds.length === 0) return lines.map(empty)

  const loaded = await loadRecipeGraph({
    OR: [
      { menuItemId: { in: menuItemIds } },
      ...(modifierIds.length > 0 ? [{ modifierId: { in: modifierIds }, kind: 'modifier' as const }] : []),
    ],
  }, db)
  const roots = loaded.roots
  const graph = await localiseGraph(loaded.graph, o.tenantId, db, { create: !!o.createMissingItems })
  const byMenuItem = new Map(roots.filter((r) => r.menuItemId && r.kind !== 'modifier').map((r) => [r.menuItemId!, r]))
  const byModifier = new Map(roots.filter((r) => r.modifierId && r.kind === 'modifier').map((r) => [r.modifierId!, r]))
  const prep: PrepStock | false = o.prepStockAt ? { tenantId: o.tenantId, live: await livePrepItems(db, graph, o.prepStockAt) } : false
  const items = new Map<string, CostItem>()
  for (const r of graph.values()) {
    for (const l of r.ingredients) if (l.inventoryItem) items.set(l.inventoryItem.id, l.inventoryItem)
    for (const p of r.prepItems ?? (r.prepItem ? [r.prepItem] : [])) items.set(p.id, p)
  }

  return lines.map((line) => {
    if (!live(line)) return empty(line)
    const dish = byMenuItem.get(line.menuItemId!)
    const base = new Map<string, number>()
    const pack = new Map<string, number>()
    if (dish) {
      const batches = batchesOf(dish, line.quantity, 'portion')
      explodeBatches(graph, dish.id, batches, base, new Set(), { sections: 'ingredients', allowNegative: false }, prep)
      explodeBatches(graph, dish.id, batches, pack, new Set(), { sections: 'packaging', allowNegative: false }, prep)
    }
    for (const mid of line.modifierIds ?? []) {
      const mod = mid ? byModifier.get(mid) : undefined
      if (!mod) continue
      explodeBatches(graph, mod.id, batchesOf(mod, line.quantity, 'portion'), base, new Set(), { sections: 'all', allowNegative: true }, prep)
    }
    const applies = packagingApplies(
      { fulfilmentType: o.fulfilmentType },
      { serviceVessel: line.serviceVessel ?? null, boxGiven: !!line.boxGiven },
      { serviceVessel: o.serviceVessel ?? null },
    )
    const excluded: ExcludedItem[] = []
    const seen = new Set<string>()
    const keep = (src: Map<string, number>): Map<string, NeedRow> => {
      const out = new Map<string, NeedRow>()
      for (const [itemId, q] of src) {
        const qty = Math.max(0, q)           // clamp: a 'removes' line never takes below none
        if (!(qty > 0)) continue
        const item = items.get(itemId)
        const tenantId = item?.tenantId ?? null
        if (tenantId !== o.tenantId) {
          if (!seen.has(itemId)) {
            seen.add(itemId)
            excluded.push({ itemId, reason: tenantId ? 'foreign' : 'company_less', menuItemId: line.menuItemId })
          }
          continue
        }
        out.set(itemId, { qty, costClass: costClassOf(item?.category) })
      }
      return out
    }
    const baseNeed = keep(base)
    const packNeed = keep(pack)
    const need = new Map(baseNeed)
    if (applies) {
      for (const [id, r] of packNeed) {
        const cur = need.get(id)
        need.set(id, cur ? { qty: cur.qty + r.qty, costClass: cur.costClass } : { ...r })
      }
    }
    return { line, need, packaging: packNeed, packagingApplies: applies, excluded }
  })
}

/**
 * What a set of sold lines of ONE order (or one company and fulfilment) takes
 * out of stock, per inventory item, in purchase units — consumptionPerLine
 * merged. Voided lines are skipped; other companies' items are excluded.
 */
export async function consumptionForSoldLines(
  lines: SoldLine[], db: Db, o: ConsumptionOpts,
): Promise<{ need: Map<string, NeedRow>; excluded: ExcludedItem[] }> {
  const per = await consumptionPerLine(lines, db, o)
  const need = new Map<string, NeedRow>()
  const excluded: ExcludedItem[] = []
  const seen = new Set<string>()
  for (const p of per) {
    for (const [id, r] of p.need) {
      const cur = need.get(id)
      need.set(id, cur ? { qty: cur.qty + r.qty, costClass: cur.costClass } : { ...r })
    }
    for (const e of p.excluded) {
      const k = `${e.itemId}|${e.menuItemId ?? ''}`
      if (!seen.has(k)) { seen.add(k); excluded.push(e) }
    }
  }
  return { need, excluded }
}

/**
 * Theoretical cost of goods for a set of sold lines, in paisa: the plate cost
 * (lib costing, Q included) × quantity. Voided lines and items without a
 * recipe cost 0. Menu engineering and the pre-FIFO legacy COGS fallback
 * (accounting/cogs.ts) only — the books cost a FIFO order at its lots.
 */
export async function cogsForSoldLines(lines: SoldLine[], db: Db = prisma): Promise<number> {
  const live = lines.filter((l) => l.menuItemId && l.status !== 'voided' && l.quantity > 0)
  if (live.length === 0) return 0
  const costs = await menuItemPlateCosts([...new Set(live.map((l) => l.menuItemId!))], db)
  let total = 0
  for (const l of live) total += (costs.get(l.menuItemId!)?.perPortionCents ?? 0) * l.quantity
  return Math.round(total)
}

/** Theoretical COGS of one order (the legacy plate-cost rule — see cogsForSoldLines). */
export async function orderCogsCents(orderId: string, db: Db = prisma): Promise<number> {
  const items = await db.orderItem.findMany({
    where: { orderId },
    select: { menuItemId: true, quantity: true, status: true },
  })
  return cogsForSoldLines(items, db)
}
