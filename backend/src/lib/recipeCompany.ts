// THE answer to "which company owns a recipe" and "which brand is a recipe" (clean-up A4 / A5, 2026-11-14).
//
// Before this file the same questions were answered three ways for a company (Recipe.tenantId, the recipes
// module's own derived walk, lib/approvalRights.ts's walk with a depth cap, and the approvals inbox reading a dish's
// brand) and about five ways for a brand — so an old sub-recipe's approval could go to a company the recipes page did
// not show it to, and the Recipes page and the Add-ons page filtered sub-recipes differently. Every reader now calls:
//
//   recipeCompaniesOf(ids, db)    id → the recipe's companies (the approval's owner set):
//       • a recipe with an OWNER (Recipe.tenantId, kitchen flow K4)  → [that company] — unchanged;
//       • a dish (plate)   → its brand's company (its menu item's, or before approval pendingMenuItem's);
//       • an add-on recipe → its dish's brand's company;
//       • a sub-recipe     → the companies of the dishes / add-ons that use it (walking up nested sub-recipes, no
//                            depth cap) plus the companies of its own stock lines.
//       A dish of a brand with no company counts for nobody. Empty = no company of its own (the CEO's).
//   loadRecipeCompanyIndex(db)    the whole graph at once (the recipes routes' scope checks):
//       index(id)       the scope set of a sub-recipe: users ∪ stock, NO_COMPANY marking a no-company dish above it
//                       (so "used only by a no-company dish" is never "visible to everyone");
//       index.users     the companies whose dishes / add-ons consume it (NO_COMPANY left out);
//       index.drawsOn   the stock companies of it and every sub-recipe under it;
//       index.companiesOf  = recipeCompaniesOf for one id (owner first);
//       index.brandsOf  the BRANDS (concept ids) of a recipe — a dish: its brand; an add-on: its dish's brand; a
//                       sub-recipe: the brands of every dish / add-on that uses it (walking up). Owner decision
//                       (2026-11-14): a brand filter shows that brand's dishes and add-ons PLUS the sub-recipes they
//                       use, on the Recipes page and the Add-ons page alike;
//       index.recipeIdsOfBrand(conceptId)  every recipe whose brandsOf holds it.
// The db is the caller's: the recipes routes pass the request's RLS client, the approval engine serviceClient.

import type { Prisma, PrismaClient } from '@prisma/client'
import type { prisma } from './prisma.js'

type Db = PrismaClient | Prisma.TransactionClient | typeof prisma

/** A dish whose brand has no company belongs to nobody — never in any scope. */
export const NO_COMPANY = '\u0000none'

const CONCEPT = { select: { conceptId: true, concept: { select: { tenantId: true } } } } as const
const RECIPE_SELECT = {
  id: true, kind: true, tenantId: true, pendingMenuItem: true,
  menuItem: CONCEPT,
  modifier: { select: { group: { select: { menuItem: CONCEPT } } } },
} as const

type Row = {
  id: string
  kind: string
  tenantId: string | null
  pendingMenuItem: unknown
  menuItem: { conceptId: string; concept: { tenantId: string | null } } | null
  modifier: { group: { menuItem: { conceptId: string; concept: { tenantId: string | null } } } } | null
}

const pendingConceptOf = (r: Pick<Row, 'pendingMenuItem'>): string | null =>
  (r.pendingMenuItem as { conceptId?: string } | null)?.conceptId ?? null

/** The brand of a dish / add-on row itself (null for a sub-recipe). */
function ownBrandOf(r: Row): string | null {
  if (r.kind === 'plate') return r.menuItem?.conceptId ?? pendingConceptOf(r)
  if (r.kind === 'modifier') return r.modifier?.group.menuItem.conceptId ?? null
  return null
}

async function pendingTenants(db: Db, rows: Row[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.filter((r) => r.kind === 'plate' && !r.menuItem).map(pendingConceptOf).filter((x): x is string => !!x))]
  if (ids.length === 0) return new Map()
  const found = await db.concept.findMany({ where: { id: { in: ids } }, select: { id: true, tenantId: true } })
  return new Map(found.map((c) => [c.id, c.tenantId]))
}

/** The company of a dish / add-on row itself — NO_COMPANY when its brand has none. */
function ownCompanyOf(r: Row, pending: Map<string, string | null>): string {
  if (r.kind === 'plate') {
    if (r.menuItem) return r.menuItem.concept.tenantId ?? NO_COMPANY
    const cid = pendingConceptOf(r)
    return (cid && pending.get(cid)) || NO_COMPANY
  }
  if (r.kind === 'modifier') return r.modifier?.group.menuItem.concept.tenantId ?? NO_COMPANY
  return NO_COMPANY
}

export type RecipeCompanyIndex = ((recipeId: string) => Set<string>) & {
  users: (recipeId: string) => Set<string>
  drawsOn: (recipeId: string) => Set<string>
  companiesOf: (recipeId: string) => string[]
  brandsOf: (recipeId: string) => Set<string>
  recipeIdsOfBrand: (conceptId: string) => Set<string>
}

/** Every recipe and recipe line visible to `db`, indexed (see the header). */
export async function loadRecipeCompanyIndex(db: Db): Promise<RecipeCompanyIndex> {
  const [recipes, links] = await Promise.all([
    db.recipe.findMany({ select: RECIPE_SELECT }) as Promise<Row[]>,
    db.recipeIngredient.findMany({ select: { recipeId: true, prepRecipeId: true, inventoryItem: { select: { tenantId: true } } } }),
  ])
  const pending = await pendingTenants(db, recipes)
  const byId = new Map(recipes.map((r) => [r.id, r]))
  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  const rawTenants = new Map<string, Set<string>>()
  for (const l of links) {
    if (l.prepRecipeId) {
      parents.set(l.prepRecipeId, [...(parents.get(l.prepRecipeId) ?? []), l.recipeId])
      children.set(l.recipeId, [...(children.get(l.recipeId) ?? []), l.prepRecipeId])
    }
    const t = l.inventoryItem?.tenantId
    if (t) rawTenants.set(l.recipeId, new Set([...(rawTenants.get(l.recipeId) ?? []), t]))
  }

  // The dishes / add-ons above a recipe (cycle-safe walk up).
  const aboveMemo = new Map<string, Row[]>()
  const dishesAbove = (recipeId: string): Row[] => {
    const hit = aboveMemo.get(recipeId)
    if (hit) return hit
    const out: Row[] = []
    const seen = new Set<string>([recipeId])
    const stack = [...(parents.get(recipeId) ?? [])]
    while (stack.length) {
      const pid = stack.pop()!
      if (seen.has(pid)) continue
      seen.add(pid)
      const parent = byId.get(pid)
      if (!parent) continue
      if (parent.kind === 'plate' || parent.kind === 'modifier') out.push(parent)
      else stack.push(...(parents.get(pid) ?? []))
    }
    aboveMemo.set(recipeId, out)
    return out
  }
  const usersRaw = (recipeId: string): Set<string> => new Set(dishesAbove(recipeId).map((p) => ownCompanyOf(p, pending)))

  const memo = new Map<string, Set<string>>()
  const index = ((recipeId: string) => {
    const hit = memo.get(recipeId)
    if (hit) return hit
    const out = new Set<string>([...(rawTenants.get(recipeId) ?? []), ...usersRaw(recipeId)])
    memo.set(recipeId, out)
    return out
  }) as RecipeCompanyIndex
  index.users = (recipeId) => new Set([...usersRaw(recipeId)].filter((t) => t !== NO_COMPANY))
  index.drawsOn = (recipeId) => {
    const out = new Set<string>()
    const seen = new Set<string>()
    const stack = [recipeId]
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      for (const t of rawTenants.get(id) ?? []) out.add(t)
      stack.push(...(children.get(id) ?? []))
    }
    return out
  }
  index.companiesOf = (recipeId) => {
    const r = byId.get(recipeId)
    if (!r) return []
    if (r.tenantId) return [r.tenantId]
    if (r.kind === 'plate' || r.kind === 'modifier') {
      const t = ownCompanyOf(r, pending)
      return t === NO_COMPANY ? [] : [t]
    }
    return [...index(recipeId)].filter((t) => t !== NO_COMPANY)
  }
  index.brandsOf = (recipeId) => {
    const r = byId.get(recipeId)
    if (!r) return new Set()
    const own = ownBrandOf(r)
    if (r.kind !== 'component') return new Set(own ? [own] : [])
    return new Set(dishesAbove(recipeId).map(ownBrandOf).filter((x): x is string => !!x))
  }
  let brandMap: Map<string, Set<string>> | null = null
  index.recipeIdsOfBrand = (conceptId) => {
    if (!brandMap) {
      brandMap = new Map()
      for (const r of recipes) for (const b of index.brandsOf(r.id)) {
        const set = brandMap.get(b) ?? new Set<string>()
        set.add(r.id)
        brandMap.set(b, set)
      }
    }
    return brandMap.get(conceptId) ?? new Set()
  }
  return index
}

/**
 * The companies of each recipe (see the header). Ids not found are left out of the map. Only a sub-recipe with no
 * owner needs the whole graph, so it is loaded only then.
 */
export async function recipeCompaniesOf(ids: readonly string[], db: Db): Promise<Map<string, string[]>> {
  const want = [...new Set(ids)]
  const out = new Map<string, string[]>()
  if (want.length === 0) return out
  const rows = await db.recipe.findMany({ where: { id: { in: want } }, select: RECIPE_SELECT }) as Row[]
  const pending = await pendingTenants(db, rows)
  const derived: string[] = []
  for (const r of rows) {
    if (r.tenantId) out.set(r.id, [r.tenantId])
    else if (r.kind === 'plate' || r.kind === 'modifier') {
      const t = ownCompanyOf(r, pending)
      out.set(r.id, t === NO_COMPANY ? [] : [t])
    } else derived.push(r.id)
  }
  if (derived.length) {
    const index = await loadRecipeCompanyIndex(db)
    for (const id of derived) out.set(id, index.companiesOf(id))
  }
  return out
}
