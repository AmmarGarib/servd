// THE prep plan (owner, 2026-10-26 — kitchen flow, part D): one engine behind the prep list, the par board and the
// shopping list. "master data → recipe → prep list → spec list → procurement → inventory → par level set → sales →
// deduction basis plate recipe."
//
// For ONE outlet and ONE Karachi date:
//   1. demand: per dish of the outlet's brands, the average sold on that weekday over the last 4 weeks
//      (reports/demand-forecast.ts forecastDishesForDay — the one forecast; orders of the outlet when the brand cooks at
//      more than one).
//   2. explode the dishes' plate recipes (in the outlet's company — a shared recipe resolves to its own items,
//      lib/recipeCost.ts localiseGraph) into what each prep (sub-recipe) is NEEDED for, in its yield unit, and the raw
//      items the plates draw directly.
//   3. per prep: target = max(the par for that weekday (ParTarget, portions), the forecast need); on hand = the prep
//      item's stock AT THAT OUTLET (prep as stock); TO PREP = target − on hand (≥ 0), in portions and whole-recipe
//      batches. A prep inside a prep is needed for what its parent will be made from (parents first, any depth).
//   4. the raw items the batches to prep will draw (their recipe lines, yield grossed up) — the shopping list's input.
// Quantities: preps in their yield unit (g / ml / pcs) and portions (lib/portions.ts: batch yield ÷ portions per
// recipe); raw items in their stock (purchase) unit, as stock is held. Reads only — nothing is written.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { loadRecipeGraph, localiseGraph, measureToPurchaseUnits, prepItemFor, type CostLine, type RecipeGraph } from '../../lib/recipeCost.js'
import { portionSizeOf } from '../../lib/portions.js'
import { siteOnHandMany } from '../../lib/stockLedger.js'
import { forecastDishesForDay, pktWeekdayOf } from '../reports/demand-forecast.js'
import { subRecipeIdsForCompany } from '../par-sheet/routes.js'

type Db = Prisma.TransactionClient | typeof prisma

export interface PrepPlanDish { menuItemId: string; name: string; conceptId: string; brand: string; forecast: number; hasRecipe: boolean }
export interface PrepPlanComponent {
  recipeId: string
  name: string
  unit: string
  portionLabel: string | null
  portionSize: number | null
  batchYield: number | null
  needQty: number
  parPortions: number | null
  targetQty: number
  onHandQty: number
  toPrepQty: number
  needPortions: number | null
  targetPortions: number | null
  onHandPortions: number | null
  toPrepPortions: number | null
  batches: number | null
  /** The prep item this outlet's stock is counted on (null until the company has made it). */
  prepItemId: string | null
}
export interface PrepPlanRaw { inventoryItemId: string; name: string; unit: string; qty: number }
/** An ingredient the plan needs that this company does not stock yet (by servd master; qty in the master's base unit). */
export interface PrepPlanNotStocked { masterIngredientId: string | null; name: string; unit: string; qty: number }
export interface PrepPlan {
  tenantId: string
  locationId: string
  date: string
  weekday: number
  dishes: PrepPlanDish[]
  components: PrepPlanComponent[]
  /** Raw stock the batches TO PREP will draw (purchase units). */
  rawForPrep: PrepPlanRaw[]
  /** Raw stock the forecast dishes draw directly (purchase units, Ingredients section). */
  directRaw: PrepPlanRaw[]
  /** Ingredients needed that this company has never stocked — "Not stocked yet — create" (POST /inventory/from-master). */
  notStocked: PrepPlanNotStocked[]
}

const lineYield = (y: number | null | undefined) => (!y || y <= 0 ? 1 : y > 1 ? y / 100 : y)
const linePurchaseQty = (l: CostLine) => measureToPurchaseUnits(l.quantity / lineYield(l.yieldPct), l.inventoryItem?.unit)

/** The brands cooked at an outlet (its company's, live). */
async function outletBrands(db: Db, tenantId: string, locationId: string) {
  const links = await db.conceptLocation.findMany({
    where: { locationId, concept: { tenantId, deletedAt: null } },
    select: { conceptId: true, concept: { select: { name: true, _count: { select: { locations: true } } } } },
  })
  return links.map((l) => ({ id: l.conceptId, name: l.concept.name, outlets: l.concept._count.locations }))
}

/** What forecast dishes need of each prep (yield unit) and of raw stock directly (purchase units). */
/** A line the company does not stock: keyed by its master (else the other company's item), qty in recipe measure. */
function addNotStocked(map: Map<string, { masterId: string | null; itemId: string; qty: number }>, l: CostLine, times: number) {
  const masterId = l.masterIngredientId ?? l.inventoryItem?.masterIngredientId ?? null
  const key = masterId ?? `item:${l.inventoryItemId}`
  const cur = map.get(key) ?? { masterId, itemId: l.inventoryItemId!, qty: 0 }
  cur.qty += times * (l.quantity / lineYield(l.yieldPct))
  map.set(key, cur)
}

export function needsForDishes(graph: RecipeGraph, dishes: Array<{ recipeId: string; qty: number }>, notStocked = new Map<string, { masterId: string | null; itemId: string; qty: number }>()): { prep: Map<string, number>; raw: Map<string, number> } {
  const prep = new Map<string, number>()
  const raw = new Map<string, number>()
  for (const d of dishes) {
    const r = graph.get(d.recipeId)
    if (!r || !(d.qty > 0)) continue
    const batches = d.qty / Math.max(r.servings || 1, 1)
    for (const l of r.ingredients) {
      if (l.section === 'packaging' || l.quantity <= 0) continue
      if (l.prepRecipeId) prep.set(l.prepRecipeId, (prep.get(l.prepRecipeId) ?? 0) + batches * l.quantity)
      else if (l.inventoryItem?.notStocked) addNotStocked(notStocked, l, batches)
      else if (l.inventoryItemId && l.inventoryItem) raw.set(l.inventoryItemId, (raw.get(l.inventoryItemId) ?? 0) + batches * linePurchaseQty(l))
    }
  }
  return { prep, raw }
}

/** Preps in an order where every parent comes before the preps it is made from (cycle-safe). */
function parentsFirst(graph: RecipeGraph, ids: string[]): string[] {
  const seen = new Set<string>()
  const post: string[] = []
  const visit = (id: string, stack: Set<string>) => {
    if (seen.has(id) || stack.has(id)) return
    stack.add(id)
    for (const l of graph.get(id)?.ingredients ?? []) if (l.prepRecipeId) visit(l.prepRecipeId, stack)
    stack.delete(id)
    seen.add(id)
    post.push(id)
  }
  for (const id of ids) visit(id, new Set())
  return post.reverse()
}

export async function buildPrepPlan(input: { tenantId: string; locationId: string; date: string; db?: Db }): Promise<PrepPlan> {
  const db = input.db ?? prisma
  const { tenantId, locationId, date } = input
  const weekday = pktWeekdayOf(date)

  // 1. Demand per dish of the outlet's brands.
  const brands = await outletBrands(db, tenantId, locationId)
  const fc = new Map<string, { name: string; qty: number; conceptId: string; brand: string }>()
  for (const b of brands) {
    for (const [id, v] of await forecastDishesForDay({ conceptId: b.id, locationId: b.outlets > 1 ? locationId : null, weekday })) {
      fc.set(id, { ...v, conceptId: b.id, brand: b.name })
    }
  }

  // 2. The company's preps and the dishes' plates, in the company (shared recipes localised).
  const companyPreps = [...(await subRecipeIdsForCompany(tenantId))]
  const loaded = await loadRecipeGraph({ OR: [{ menuItemId: { in: [...fc.keys()] } }, { id: { in: companyPreps } }] }, db as Prisma.TransactionClient)
  // strict: ONLY this company's items — a line it has never stocked is listed apart, never drawn from another company.
  const graph = await localiseGraph(loaded.graph, tenantId, db as Prisma.TransactionClient, { strict: true })
  const notStockedMap = new Map<string, { masterId: string | null; itemId: string; qty: number }>()
  const plateOf = new Map(loaded.roots.filter((r) => r.menuItemId && r.kind === 'plate').map((r) => [r.menuItemId!, r.id]))
  const dishes: PrepPlanDish[] = [...fc.entries()].map(([menuItemId, v]) => ({
    menuItemId, name: v.name, conceptId: v.conceptId, brand: v.brand, forecast: Math.round(v.qty * 10) / 10, hasRecipe: plateOf.has(menuItemId),
  })).sort((a, b) => b.forecast - a.forecast)
  const needs = needsForDishes(graph, dishes.filter((d) => d.hasRecipe).map((d) => ({ recipeId: plateOf.get(d.menuItemId)!, qty: d.forecast })), notStockedMap)

  // 3. Per prep: par, need, on hand, to prep — parents first so a prep inside a prep is needed for what is made.
  const ids = [...new Set([...companyPreps, ...needs.prep.keys()])].filter((id) => graph.get(id)?.kind === 'component')
  const meta = new Map((await db.recipe.findMany({
    where: { id: { in: ids } }, select: { id: true, name: true, yieldUnit: true, yieldGrams: true, portionsPerBatch: true, portionLabel: true, isActive: true },
  })).map((r) => [r.id, r]))
  const pars = new Map((await db.parTarget.findMany({ where: { tenantId, locationId, weekday, recipeId: { in: ids } }, select: { recipeId: true, portions: true } })).map((p) => [p.recipeId, p.portions]))
  const prepItems = new Map((await db.inventoryItem.findMany({ where: { tenantId, prepRecipeId: { in: ids }, deletedAt: null }, select: { id: true, prepRecipeId: true } })).map((i) => [i.prepRecipeId!, i.id]))
  const onHand = await siteOnHandMany(db as Prisma.TransactionClient, [...prepItems.values()], locationId)
  const need = new Map(needs.prep)
  const rawForPrep = new Map<string, number>()
  const components: PrepPlanComponent[] = []
  for (const id of parentsFirst(graph, ids)) {
    const r = graph.get(id)!
    const m = meta.get(id)
    if (!m || !m.isActive) continue
    const size = portionSizeOf(m)
    const needQty = need.get(id) ?? 0
    const parPortions = pars.get(id) ?? null
    const parQty = parPortions != null && size ? parPortions * size : 0
    const targetQty = Math.max(parQty, needQty)
    const itemId = prepItems.get(id) ?? prepItemFor(r, tenantId)?.id ?? null
    const have = Math.max(0, itemId ? onHand.get(itemId) ?? 0 : 0)
    const toPrepQty = Math.max(0, targetQty - have)
    const batchYield = m.yieldGrams && m.yieldGrams > 0 ? m.yieldGrams : null
    const batches = batchYield ? toPrepQty / batchYield : null
    if (batches && batches > 0) {
      for (const l of r.ingredients) {
        if (l.quantity <= 0) continue
        if (l.prepRecipeId) need.set(l.prepRecipeId, (need.get(l.prepRecipeId) ?? 0) + batches * l.quantity)
        else if (l.inventoryItem?.notStocked) addNotStocked(notStockedMap, l, batches)
        else if (l.inventoryItemId && l.inventoryItem) rawForPrep.set(l.inventoryItemId, (rawForPrep.get(l.inventoryItemId) ?? 0) + batches * linePurchaseQty(l))
      }
    }
    const p = (q: number) => (size ? Math.round((q / size) * 10) / 10 : null)
    const q = (x: number) => Math.round(x * 1000) / 1000
    components.push({
      recipeId: id, name: m.name ?? '—', unit: m.yieldUnit, portionLabel: m.portionLabel, portionSize: size ? q(size) : null, batchYield,
      needQty: q(needQty), parPortions, targetQty: q(targetQty), onHandQty: q(have), toPrepQty: q(toPrepQty),
      needPortions: p(needQty), targetPortions: p(targetQty), onHandPortions: p(have), toPrepPortions: p(toPrepQty),
      batches: batches != null ? Math.round(batches * 100) / 100 : null, prepItemId: itemId,
    })
  }
  components.sort((a, b) => b.toPrepQty - a.toPrepQty || a.name.localeCompare(b.name))

  // 4. Name the raw lines.
  const rawIds = [...new Set([...rawForPrep.keys(), ...needs.raw.keys()])]
  const items = new Map((await db.inventoryItem.findMany({ where: { id: { in: rawIds } }, select: { id: true, name: true, unit: true } })).map((i) => [i.id, i]))
  const rows = (m: Map<string, number>): PrepPlanRaw[] => [...m.entries()]
    .filter(([, qty]) => qty > 1e-9)
    .map(([id, qty]) => ({ inventoryItemId: id, name: items.get(id)?.name ?? '—', unit: items.get(id)?.unit ?? '', qty: Math.round(qty * 1000) / 1000 }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const masterIds = [...notStockedMap.values()].map((v) => v.masterId).filter((x): x is string => !!x)
  const masters = new Map((masterIds.length ? await db.ingredientMaster.findMany({ where: { id: { in: masterIds } }, select: { id: true, name: true, stockUnit: true } }) : []).map((m) => [m.id, m]))
  const otherItems = new Map((await db.inventoryItem.findMany({ where: { id: { in: [...notStockedMap.values()].map((v) => v.itemId) } }, select: { id: true, name: true } })).map((i) => [i.id, i]))
  const notStocked: PrepPlanNotStocked[] = [...notStockedMap.values()].filter((v) => v.qty > 1e-9).map((v) => {
    const m = v.masterId ? masters.get(v.masterId) : undefined
    // Recipe quantities are in measure units (g / ml / pcs) — the master's base unit.
    return { masterIngredientId: m?.id ?? null, name: m?.name ?? otherItems.get(v.itemId)?.name ?? '—', unit: m?.stockUnit ?? 'g', qty: Math.round(v.qty * 1000) / 1000 }
  }).sort((a, b) => a.name.localeCompare(b.name))
  return { tenantId, locationId, date, weekday, dishes, components, rawForPrep: rows(rawForPrep), directRaw: rows(needs.raw), notStocked }
}
