import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, APPROVERS, ALL_STAFF, assertNotSelfApproval } from '../auth/middleware.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import { costPerMeasureCents } from '../../lib/recipeCost.js'

const Q_FACTOR = 0.05 // 5% miscellaneous surcharge (salt, oil, unmeasured items)

// Normalise a raw inventory item's cost to per-gram (paisa/g): items priced
// per kg/litre divide by 1000; per g/ml (and per-unit pcs) are already per
// measure. Used wherever a raw line is costed so weighed items priced per kg
// aren't ~1000x off — including inside component (prep) batch costing.
const cpgCents = costPerMeasureCents

// Components can be composed of other components (one sub-recipe used as an
// ingredient inside another). Costing therefore recurses: a component's
// cost-per-gram includes the cost-per-gram of any sub-components it contains.
// We resolve EVERY component's cost-per-gram in one pass over the whole
// component set, memoised, with a cycle guard so a mis-authored loop
// (A→B→A) can't blow the stack — a cyclic back-edge just contributes 0.
// Each component's batch cost uses ITS OWN qFactorPct (the recipe's waste
// buffer, default 10) — not the legacy hardcoded 5% — so the cost-per-gram
// that flows into parent recipes matches the component's own detail view.
async function buildComponentCpgMap(): Promise<Map<string, number>> {
  const comps = await prisma.recipe.findMany({
    where: { kind: 'component' },
    select: {
      id: true, yieldGrams: true, laborMinutes: true, qFactorPct: true,
      ingredients: {
        select: {
          quantity: true, yieldPct: true, prepRecipeId: true,
          inventoryItem: { select: { unit: true, unitCostCents: true } },
        },
      },
    },
  })
  const byId = new Map(comps.map((c) => [c.id, c]))
  const memo = new Map<string, number>()
  function cpg(id: string, stack: Set<string>): number {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (stack.has(id)) return 0            // cycle — break the back-edge
    const c = byId.get(id)
    if (!c || !c.yieldGrams || c.yieldGrams <= 0) { memo.set(id, 0); return 0 }
    stack.add(id)
    let ingCost = 0
    for (const i of c.ingredients) {
      if (i.prepRecipeId) {
        // Sub-component consumed by the gram (already yield-adjusted by its batch).
        ingCost += cpg(i.prepRecipeId, stack) * i.quantity
      } else {
        const yp = i.yieldPct > 0 ? i.yieldPct : 1
        ingCost += cpgCents(i.inventoryItem?.unit, i.inventoryItem?.unitCostCents) * (i.quantity / yp)
      }
    }
    stack.delete(id)
    const labor = (c.laborMinutes / 60) * 50_00
    const result = (ingCost * (1 + (c.qFactorPct ?? 10) / 100) + labor) / c.yieldGrams
    memo.set(id, result)
    return result
  }
  const out = new Map<string, number>()
  for (const c of comps) out.set(c.id, cpg(c.id, new Set()))
  return out
}

const SEASON_KEYS = ['spring', 'summer', 'monsoon', 'autumn', 'winter', 'ramadan', 'year-round'] as const
const SEASON_DATE_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

// Single schema for both kinds. The kind-specific requirements (plate
// must have menuItemId, component must have name + yieldGrams) are enforced
// via .superRefine below — that lets us produce per-field error messages
// instead of a generic "invalid payload".
//
// Ingredient rows are also disjoint: either inventoryItemId (raw stock)
// or prepRecipeId (a component sub-recipe). The mutual exclusion
// is checked client-side via the picker, server-side via the schema, and
// at the DB layer via the CHECK constraint in the migration.
const ingredientSchema = z.object({
  inventoryItemId: z.string().uuid().optional(),
  prepRecipeId:    z.string().uuid().optional(),
  quantity:        z.number().positive(),
  yieldPct:        z.number().min(0.01).max(1).default(1),
  unit:            z.string().min(1),
  notes:           z.string().optional(),
}).refine(
  (i) => Boolean(i.inventoryItemId) !== Boolean(i.prepRecipeId),
  { message: 'Each ingredient must reference exactly one of inventoryItem or prepRecipe' },
)

// Split the schema into a plain object + a refined wrapper so PUT (full-replace
// update) can use .partial() — zod's .superRefine wraps the schema in
// ZodEffects, which doesn't expose .partial. We keep the refinement on POST
// (where every required field is enforced) and skip it on PUT (where partial
// edits are allowed by design).
const recipeShape = {
  kind:         z.enum(['plate', 'component']).default('plate'),
  menuItemId:   z.string().uuid().optional(),
  name:         z.string().min(1).optional(),
  yieldGrams:   z.number().positive().nullable().optional(),  // component batch yield OR plate total yield (g)
  servings:     z.number().int().min(1).default(1),
  portionSizeG: z.number().positive().optional(),
  laborMinutes: z.number().int().min(0).default(0),
  notes:        z.string().nullable().optional(),
  steps:        z.string().nullable().optional(),   // null when a plate has no MOP (plates use methodSteps)
  stepsUrdu:    z.string().nullable().optional(),
  seasons:      z.array(z.enum(SEASON_KEYS)).default([]),
  seasonStart:  z.string().regex(SEASON_DATE_RE, 'Use MM-DD format').nullable().optional(),
  seasonEnd:    z.string().regex(SEASON_DATE_RE, 'Use MM-DD format').nullable().optional(),
  isActive:     z.boolean().default(true),
  // Pricing-spec fields. All have schema defaults so callers can omit them
  // and inherit the operator-level defaults (10/25/8) — see spec.
  qFactorPct:              z.number().min(0).max(100).default(10),
  targetProfitPct:         z.number().min(0).max(100).default(25),
  targetFoodCostPct:       z.number().min(1).max(100).default(30),
  packagingPct:            z.number().min(0).max(100).default(8),
  actualSellingPriceCents: z.number().int().min(0).nullable().optional(),
  category:                z.enum(['main', 'side', 'sauce', 'sub_recipe']).nullable().optional(),
  // ── Inline menu-item creation for plate recipes ──────────────────────
  // When kind='plate' and no `menuItemId` is supplied, the operator is
  // creating the recipe AND the menu item in one shot. The new MenuItem
  // gets its name, description, and category from this object; the price
  // comes from actualSellingPriceCents (so the operator sets the menu
  // price by setting the recipe's selling price). conceptId is required
  // since menu items are brand-scoped.
  newMenuItem: z.object({
    conceptId:   z.string().uuid(),
    categoryId:  z.string().uuid(),
    name:        z.string().min(1).max(200),
    description: z.string().max(500).nullable().optional(),
  }).optional(),
  photoUrl:                z.string().url().nullable().optional(),
  // Finished-plate method: ordered, station-tagged steps. `station` is a free
  // text label (matched loosely against the brand's stations in the UI, not an
  // FK) so a method can be authored before stations are formally configured.
  methodSteps: z.array(z.object({
    station:     z.string().max(80).default(''),
    instruction: z.string().min(1).max(1000),
  })).nullable().optional(),
  ingredients:  z.array(ingredientSchema).min(1),
}
const recipeBase = z.object(recipeShape)
const recipeSchema = recipeBase.superRefine((r, ctx) => {
  if (r.kind === 'plate' && !r.menuItemId && !r.newMenuItem) {
    ctx.addIssue({ code: 'custom', path: ['menuItemId'], message: 'Plate recipes must link to an existing menu item or supply a new one' })
  }
  if (r.kind === 'component') {
    if (!r.name || !r.name.trim()) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'Component recipes need a name' })
    }
    if (!r.yieldGrams || r.yieldGrams <= 0) {
      ctx.addIssue({ code: 'custom', path: ['yieldGrams'], message: 'Component recipes need a batch yield in grams (drives cost-per-gram)' })
    }
    if (r.menuItemId) {
      ctx.addIssue({ code: 'custom', path: ['menuItemId'], message: 'Component recipes do not link to a menu item' })
    }
  }
})
// PUT-time schema — same fields, but every one optional so partial updates
// (e.g. just tweaking servings) don't require resending the whole recipe.
const recipeUpdateSchema = recipeBase.partial()

// Map a calendar month → the seasons that month belongs to. Pakistan-leaning
// (no spring proper; monsoon is mid-Jun → Sep; summer = Apr → mid-Jun + post-monsoon).
function currentSeasonsForDate(d: Date): string[] {
  const m = d.getMonth() + 1   // 1-12
  if (m >= 3 && m <= 4)   return ['spring']
  if (m === 5 || m === 6) return ['summer']
  if (m >= 7 && m <= 9)   return ['monsoon']
  if (m === 10)           return ['autumn']
  if (m >= 11 || m <= 2)  return ['winter']
  return []
}

const poSchema = z.object({
  supplierId:   z.string().uuid(),
  expectedDate: z.string().datetime().optional(),
  reference:    z.string().optional(),
  notes:        z.string().optional(),
  lines: z.array(z.object({
    inventoryItemId: z.string().uuid(),
    quantityOrdered: z.number().positive(),
    unitCostCents:   z.number().int().positive(),
    notes:           z.string().optional(),
  })).min(1),
})

// ── Tenant scoping ──────────────────────────────────────────────────────────
// Recipes have no tenant column: plates scope through their menu item's
// concept — or, pre-approval, through pendingMenuItem.conceptId (a Json
// payload, so it can't be filtered in SQL; we post-filter). Components are
// shared across every brand by design and always pass.
async function scopedConceptIdSet(req: { staffUser?: { tenantFilter: unknown } | null }): Promise<Set<string>> {
  const concepts = await prisma.concept.findMany({
    where: { tenantId: (req.staffUser!.tenantFilter ?? undefined) as string, deletedAt: null },
    select: { id: true },
  })
  return new Set(concepts.map((c) => c.id))
}
/**
 * Resolve a recipe the operator may act on, or 404. A recipe belongs to a
 * company through its menu item's brand (or, before approval, through
 * pendingMenuItem.conceptId). Reads were already scoped; the write handlers
 * looked recipes up by bare id, so a manager at one company could edit,
 * approve, reject or delete another company's recipes — and approving one
 * overwrites the live menu price of that company's item.
 */
async function assertRecipeInScope(
  req: { staffUser?: { tenantFilter: unknown } | null },
  recipeId: string,
): Promise<void> {
  const r = await prisma.recipe.findUnique({
    where: { id: recipeId },
    select: { kind: true, pendingMenuItem: true, menuItem: { select: { conceptId: true } } },
  })
  if (!r) throw new NotFoundError('Recipe', recipeId)
  const ids = await scopedConceptIdSet(req)
  if (!recipeInScope(r, ids)) throw new NotFoundError('Recipe', recipeId)
}

function recipeInScope(
  r: { kind: string; menuItem?: { conceptId: string } | null; pendingMenuItem?: unknown },
  conceptIds: Set<string>,
): boolean {
  if (r.kind === 'component') return true
  const pending = r.pendingMenuItem as { conceptId?: string } | null
  const cid = r.menuItem?.conceptId ?? pending?.conceptId ?? null
  return cid != null && conceptIds.has(cid)
}

export async function recipeRoutes(fastify: FastifyInstance) {

  // ── Recipes ────────────────────────────────────────────────────────────────

  // GET /recipes — list all with cost calc.
  // Filters:
  //   ?conceptId=…          — only recipes belonging to this concept
  //   ?season=summer        — only recipes tagged for this season (or year-round)
  //   ?season=current       — auto-detect current season from server date
  //   ?q=mango              — substring search on menu item name + recipe notes
  //   ?activeOnly=true      — exclude isActive=false (off-season seasonal items)
  fastify.get<{ Querystring: { conceptId?: string; season?: string; q?: string; activeOnly?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, q, activeOnly } = req.query
      let { season } = req.query
      if (season === 'current') season = currentSeasonsForDate(new Date())[0]

      // Company scoping: resolve the concepts visible to this request up
      // front. An explicitly requested conceptId outside the scope returns
      // nothing rather than leaking another company's recipes.
      const visibleConceptIds = await scopedConceptIdSet(req)
      if (conceptId && !visibleConceptIds.has(conceptId)) return []

      const fetched = await prisma.recipe.findMany({
        where: {
          ...(conceptId && { menuItem: { conceptId } }),
          ...(activeOnly === 'true' && { isActive: true }),
          // Season filter: include the requested season OR explicit "year-round" OR
          // empty seasons array (which we treat as year-round).
          ...(season && {
            OR: [
              { seasons: { has: season } },
              { seasons: { has: 'year-round' } },
              { seasons: { isEmpty: true } },
            ],
          }),
          ...(q && {
            OR: [
              { menuItem: { name: { contains: q, mode: 'insensitive' } } },
              { notes: { contains: q, mode: 'insensitive' } },
            ],
          }),
        },
        include: {
          menuItem: {
            select: {
              id: true, name: true, priceCents: true, conceptId: true,
              concept: {
                select: {
                  name: true, tenantId: true,
                  tenant: { select: { id: true, name: true, slug: true } },
                },
              },
            },
          },
          ingredients: {
            include: {
              inventoryItem: { select: { name: true, unit: true, unitCostCents: true } },
              // Prep recipe components — pull enough to compute their cost-per-gram
              // inline so plate recipes get accurate totals in one round-trip.
              prepRecipe: {
                include: {
                  ingredients: { include: { inventoryItem: { select: { unit: true, unitCostCents: true } } } },
                },
              },
            },
          },
        },
        // Order by either menuItem name (plate) or recipe name (prep). Postgres
        // sorts NULLs last by default so plate recipes group naturally.
        orderBy: [{ menuItem: { name: 'asc' } }, { name: 'asc' }],
      })

      // Post-filter to the visible companies (components always pass — they're
      // shared across brands; testing plates match via pendingMenuItem).
      const recipes = fetched.filter((r) => recipeInScope(r, visibleConceptIds))

      // Recipe library is the operator's IP. Bulk reads above the threshold
      // signal exfiltration and fire a flag.
      if (recipes.length >= 50) {
        const { getOperationsConfig } = await import('../../lib/setup-config.js')
        const ops = await getOperationsConfig(req.staffUser!.tenantId)
        const threshold = ops?.pii_export_row_threshold ?? 100
        if (recipes.length >= threshold) {
          const { flagException } = await import('../../lib/exceptions.js')
          await flagException({
            kind: 'pii_export',
            severity: recipes.length >= 200 ? 'high' : 'medium',
            title: `Bulk recipe read: ${recipes.length} recipes`,
            description: `${req.staffUser!.email} read ${recipes.length} recipes in one request from IP ${req.ip}. Recipes are operator IP — investigate if unexpected.`,
            actorId: req.staffUser!.id,
            metadata: { rowCount: recipes.length, conceptId: conceptId ?? null, q: q ?? null, ip: req.ip },
          })
        }
      }

      // Recursive component cost-per-gram map — one query, reused for every
      // component-ingredient line below.
      const cpgMap = await buildComponentCpgMap()

      return recipes.map((r) => {
        const ingDetails = r.ingredients.map((ing) => {
          let costPerUnit = 0
          let ingredientCostCents = 0
          const yp = ing.yieldPct > 0 ? ing.yieldPct : 1
          const purchaseQty = ing.quantity / yp     // what you actually buy

          if (ing.prepRecipeId) {
            // Prep component — cost = the component's (recursive) cost-per-gram ×
            // quantity. Uses the shared map so components built from other
            // components cost correctly instead of silently dropping the nested cost.
            const costPerGram = cpgMap.get(ing.prepRecipeId) ?? 0
            costPerUnit = costPerGram                       // "per unit" of this component = per gram
            ingredientCostCents = Math.round(costPerGram * ing.quantity)
          } else if (ing.inventoryItem) {
            // Normalise to a per-gram cost so weighed items priced per kg/litre
            // aren't ~1000x off (must match the /costing handler). Count units
            // (pcs/unit/each) cost per unit. purchaseQty already = qty ÷ yield.
            const u = (ing.inventoryItem.unit ?? '').toLowerCase()
            const raw = ing.inventoryItem.unitCostCents ?? 0
            costPerUnit = (u === 'kg' || u === 'litres' || u === 'l') ? raw / 1000
                        : (u === 'g'  || u === 'ml')                  ? raw
                        : raw   // pcs / unit / each — priced per unit
            ingredientCostCents = Math.round(costPerUnit * purchaseQty)
          }
          return { ...ing, purchaseQty, costPerUnit, ingredientCostCents }
        })

        const ingredientCostCents = ingDetails.reduce((s, i) => s + i.ingredientCostCents, 0)
        // Use the recipe's own Q-factor (default 10%) so the list matches the
        // detail/costing view; the old hardcoded 5% disagreed with both.
        const qFactorCents        = Math.round(ingredientCostCents * (r.qFactorPct / 100))
        const laborCostCents      = Math.round((r.laborMinutes / 60) * 50_00) // PKR 50/hr
        const totalCostCents      = ingredientCostCents + qFactorCents + laborCostCents

        // Per-kind headline numbers.
        //   plate     → plate cost (total ÷ servings) + margin vs. menu price.
        //   component → cost per gram (total ÷ yieldGrams) + cost per batch.
        // We keep both fields populated where they make sense so the frontend
        // can read whichever it needs without conditional branching.
        const costPerPortionCents = r.kind === 'plate' && r.servings > 0
          ? Math.round(totalCostCents / r.servings)
          : null
        const costPerGramCents = r.kind === 'component' && r.yieldGrams && r.yieldGrams > 0
          ? totalCostCents / r.yieldGrams                          // sub-cent precision — fractions matter at gram scale
          : null
        const priceCents     = r.menuItem?.priceCents ?? null
        const grossMarginPct = (priceCents && priceCents > 0 && costPerPortionCents !== null)
          ? Math.round(((priceCents - costPerPortionCents) / priceCents) * 100)
          : null
        const foodCostPct    = (priceCents && priceCents > 0 && costPerPortionCents !== null)
          ? Math.round((costPerPortionCents / priceCents) * 100)
          : null

        return {
          ...r,
          ingredients: ingDetails,
          ingredientCostCents,
          qFactorCents,
          laborCostCents,
          totalCostCents,
          // Plate headline:
          costPerPortionCents,
          grossMarginPct,
          foodCostPct,
          // Component headline:
          costPerGramCents,
          batchCostCents: r.kind === 'component' ? totalCostCents : null,
        }
      })
    },
  )

  // GET /recipes/prep — compact list of component recipes for the ingredient
  // picker on plate-recipe forms. Returns precomputed cost-per-gram so the
  // picker can preview "PKR 0.85/g" next to each option without N+1 queries.
  // (Path kept as /prep for backwards-compatibility; it now lists components.)
  fastify.get('/prep', { preHandler: requireAuth(...MANAGERS) }, async () => {
    // Recursive cost-per-gram for the whole component set — correctly costs
    // components that are themselves built from other components.
    const cpgMap = await buildComponentCpgMap()
    const preps = await prisma.recipe.findMany({
      where: { kind: 'component', isActive: true },
      select: { id: true, name: true, yieldGrams: true },
      orderBy: { name: 'asc' },
    })

    return preps.map((p) => {
      const costPerGramCents = cpgMap.get(p.id) ?? 0
      const batchCost = (p.yieldGrams && p.yieldGrams > 0) ? costPerGramCents * p.yieldGrams : 0
      return {
        id:               p.id,
        name:             p.name ?? '—',
        yieldGrams:       p.yieldGrams,
        batchCostCents:   Math.round(batchCost),
        costPerGramCents,                 // sub-cent precision deliberately preserved
      }
    })
  })

  // GET /recipes/pending-approval — CEO/owner inbox. Recipes a manager has
  // submitted for promotion and that are waiting on sign-off. Defined before
  // GET /:id so the static segment isn't swallowed by the param route.
  fastify.get('/pending-approval', { preHandler: requireAuth(...APPROVERS) }, async () => {
    const recipes = await prisma.recipe.findMany({
      where: { status: 'pending_approval' },
      include: { menuItem: { select: { name: true, concept: { select: { name: true } } } } },
      orderBy: { submittedAt: 'asc' },
    })
    return recipes.map((r) => ({
      id:            r.id,
      kind:          r.kind,
      name:          r.menuItem?.name ?? r.name ?? '—',
      brand:         r.menuItem?.concept?.name ?? null,
      submittedById: r.submittedById,
      submittedAt:   r.submittedAt,
    }))
  })

  // GET /recipes/:id
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const recipe = await prisma.recipe.findUnique({
        where: { id: req.params.id },
        include: {
          menuItem: { select: { id: true, name: true, priceCents: true, conceptId: true, concept: { select: { name: true } } } },
          ingredients: {
            include: { inventoryItem: { select: { id: true, name: true, unit: true, unitCostCents: true, currentStock: true } } },
          },
        },
      })
      if (!recipe) throw new NotFoundError('Recipe', req.params.id)
      // Cross-company guard — 404 (not 403) so ids don't leak existence.
      if (!recipeInScope(recipe, await scopedConceptIdSet(req))) throw new NotFoundError('Recipe', req.params.id)
      return recipe
    },
  )

  // GET /recipes/:id/costing — full pricing-spec readout (sections 3-5).
  // Returns plate cost, opex/portion, suggested prices, profitability +
  // verdict. Used by the Recipe page to show the live cost panel.
  fastify.get<{ Params: { id: string } }>(
    '/:id/costing',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const recipe = await prisma.recipe.findUnique({
        where: { id: req.params.id },
        include: {
          menuItem: { select: { id: true, name: true, conceptId: true, priceCents: true, concept: { select: { id: true, name: true, tenantId: true, forecastPortionsPerMonth: true } } } },
          ingredients: {
            include: {
              inventoryItem: { select: { id: true, name: true, unit: true, unitCostCents: true, yieldPct: true, allergens: true } },
              // Component sub-recipes need their own ingredients to compute a
              // cost-per-gram here (mirrors the GET / list handler) — otherwise
              // component lines used to silently cost zero.
              prepRecipe: {
                select: {
                  id: true, name: true, yieldGrams: true, laborMinutes: true,
                  ingredients: { select: { quantity: true, yieldPct: true, inventoryItem: { select: { unit: true, unitCostCents: true } } } },
                },
              },
            },
          },
        },
      })
      if (!recipe) throw new NotFoundError('Recipe', req.params.id)
      // Cross-company guard — 404 so ids don't leak existence.
      if (!recipeInScope(recipe, await scopedConceptIdSet(req))) throw new NotFoundError('Recipe', req.params.id)

      // Recursive component cost-per-gram map — correctly costs a component that
      // is itself built from other components.
      const cpgMap = await buildComponentCpgMap()

      // Section 2 — per-ingredient cost
      const ingredients = recipe.ingredients.map((ri) => {
        const inv = ri.inventoryItem
        // Cost per gram for raw inventory items. unit is e.g. "kg" with
        // unitCostCents priced per kg, so /1000 gives cost-per-gram. For
        // 'pcs', cost per gram doesn't apply; ingredient cost = qty * cost.
        let costPerGramCents = 0
        let ingredientCostCents = 0
        if (ri.prepRecipeId) {
          // Component: cost flows in at the batch's cost-per-gram × grams used
          // (the component is already yield-adjusted by its own batch).
          costPerGramCents = cpgMap.get(ri.prepRecipeId) ?? 0
          ingredientCostCents = costPerGramCents * ri.quantity
        } else if (inv) {
          if (inv.unit === 'kg' || inv.unit === 'litres' || inv.unit === 'l') {
            costPerGramCents = (inv.unitCostCents ?? 0) / 1000
          } else if (inv.unit === 'g' || inv.unit === 'ml') {
            costPerGramCents = inv.unitCostCents ?? 0
          } else {
            // 'pcs' / other → quantity is in units, not grams. Cost is qty * unitCost.
            ingredientCostCents = (inv.unitCostCents ?? 0) * ri.quantity
          }
          if (costPerGramCents > 0) {
            // Yield raises cost. ri.yieldPct is a fraction (0–1); the inventory
            // default is 0–100 — normalise both to a fraction before dividing.
            const yieldFactor = ri.yieldPct ?? ((inv.yieldPct ?? 100) / 100)
            ingredientCostCents = (ri.quantity * costPerGramCents) / Math.max(yieldFactor, 0.01)
          }
        }
        return {
          id:               ri.id,
          name:             inv?.name ?? ri.prepRecipe?.name ?? '—',
          unit:             ri.unit,
          quantity:         ri.quantity,
          // Displayed yield as a percent (ri.yieldPct is stored as a fraction).
          yieldPct:         ri.yieldPct != null ? Math.round(ri.yieldPct * 100) : (inv?.yieldPct ?? 100),
          costPerGramCents,
          ingredientCostCents: Math.round(ingredientCostCents),
          allergens:        inv?.allergens ?? [],
        }
      })

      // Section 3 — cost calculation
      const totalIngredientCents = ingredients.reduce((s, i) => s + i.ingredientCostCents, 0)
      const qFactorCents         = Math.round(totalIngredientCents * (recipe.qFactorPct / 100))
      const totalRecipeCents     = totalIngredientCents + qFactorCents
      const plateCostCents       = Math.round(totalRecipeCents / Math.max(recipe.servings, 1))

      // Opex/Portion — only applies to plate recipes (sub-recipes never carry
      // opex; their cost rolls into the plate that uses them). Monthly opex =
      //   • OpexLine entries for the brand (rent, utilities, …), monthly-ized —
      //     excluding any line already sourced from payroll, and
      //   • REAL workforce cost: posted/paid payroll runs over the last 90 days
      //     for the brand's company, monthly-ized (÷3) and allocated to this
      //     brand by its share of forecast portions (even split if no forecasts).
      // Divided by the brand's forecast monthly portions.
      let opexPerPortionCents = 0
      let brandMonthlyOpexCents = 0
      let brandForecastPortions = 0
      let opexLinesMonthlyCents = 0
      let payrollShareMonthlyCents = 0
      let payrollTenantMonthlyCents = 0
      if (recipe.kind === 'plate' && recipe.menuItem?.conceptId) {
        const conceptId = recipe.menuItem.conceptId
        const tenantId  = recipe.menuItem.concept?.tenantId ?? null
        const opexLines = await prisma.opexLine.findMany({
          // source='payroll' lines are excluded — real payroll is added below.
          where: { conceptId, isActive: true, source: { not: 'payroll' } },
          select: { amountCents: true, cadence: true },
        })
        opexLinesMonthlyCents = opexLines.reduce((s, l) => {
          const monthly =
            l.cadence === 'monthly'   ? l.amountCents :
            l.cadence === 'quarterly' ? Math.round(l.amountCents / 3) :
            l.cadence === 'annual'    ? Math.round(l.amountCents / 12) :
            l.amountCents
          return s + monthly
        }, 0)

        if (tenantId) {
          const since = new Date(Date.now() - 90 * 24 * 3600 * 1000)
          const payrollLines = await prisma.payrollRunLine.findMany({
            where: {
              payrollRun: { status: { in: ['posted', 'paid'] }, periodEnd: { gte: since } },
              user: { tenantId },
            },
            select: { grossCents: true },
          })
          payrollTenantMonthlyCents = Math.round(payrollLines.reduce((s, l) => s + l.grossCents, 0) / 3)
          // Allocate company payroll to this brand by forecast-portion share.
          const siblings = await prisma.concept.findMany({
            where: { tenantId, deletedAt: null, isActive: true },
            select: { id: true, forecastPortionsPerMonth: true },
          })
          const totalForecast = siblings.reduce((s, c) => s + (c.forecastPortionsPerMonth ?? 0), 0)
          const mine = siblings.find((c) => c.id === conceptId)?.forecastPortionsPerMonth ?? 0
          const share = totalForecast > 0 ? mine / totalForecast : (siblings.length > 0 ? 1 / siblings.length : 1)
          payrollShareMonthlyCents = Math.round(payrollTenantMonthlyCents * share)
        }

        brandMonthlyOpexCents = opexLinesMonthlyCents + payrollShareMonthlyCents
        brandForecastPortions = recipe.menuItem.concept?.forecastPortionsPerMonth ?? 0
        opexPerPortionCents = brandForecastPortions > 0
          ? Math.round(brandMonthlyOpexCents / brandForecastPortions)
          : 0
      }

      // Section 4 — pricing
      const packagingFactor = recipe.packagingPct / 100
      const targetProfitFactor = recipe.targetProfitPct / 100
      // Legacy: 30% food cost rule of thumb, opex not included
      const foodCostPriceCents = Math.round(plateCostCents / 0.30)
      // Price that hits the operator's chosen target food-cost %:
      // price = plate cost ÷ (target% / 100).
      const targetFoodCostPct  = recipe.targetFoodCostPct ?? 30
      const fcTargetPriceCents = Math.round(plateCostCents / Math.max(targetFoodCostPct / 100, 0.01))
      // Break-even: (Plate + Opex) / (1 - Packaging%)
      const breakEvenDenominator = Math.max(0.01, 1 - packagingFactor)
      const breakEvenPriceCents = Math.round((plateCostCents + opexPerPortionCents) / breakEvenDenominator)
      // Target: (Plate + Opex) / (1 - Packaging% - TargetProfit%)
      const targetDenominator = Math.max(0.01, 1 - packagingFactor - targetProfitFactor)
      const targetPriceCents = Math.round((plateCostCents + opexPerPortionCents) / targetDenominator)
      const actualSellingPriceCents = recipe.actualSellingPriceCents ?? targetPriceCents

      // Section 5 — profitability readout
      const packagingCostCents     = Math.round(actualSellingPriceCents * packagingFactor)
      const contributionMarginCents = actualSellingPriceCents - plateCostCents - packagingCostCents
      const contributionMarginPct  = actualSellingPriceCents > 0
        ? (contributionMarginCents / actualSellingPriceCents) * 100
        : 0
      const netProfitCents         = contributionMarginCents - opexPerPortionCents
      const netProfitPct           = actualSellingPriceCents > 0
        ? (netProfitCents / actualSellingPriceCents) * 100
        : 0
      const foodCostPctOfSp        = actualSellingPriceCents > 0
        ? (plateCostCents / actualSellingPriceCents) * 100
        : 0
      const verdict: 'profitable' | 'covers_food_loses_opex' | 'loses_every_plate' =
        netProfitCents > 0          ? 'profitable' :
        contributionMarginCents > 0 ? 'covers_food_loses_opex' :
                                      'loses_every_plate'

      return {
        recipe: {
          id:                       recipe.id,
          kind:                     recipe.kind,
          name:                     recipe.name ?? recipe.menuItem?.id ?? null,
          category:                 recipe.category,
          servings:                 recipe.servings,
          yieldGrams:               recipe.yieldGrams,
          qFactorPct:               recipe.qFactorPct,
          targetProfitPct:          recipe.targetProfitPct,
          targetFoodCostPct,
          packagingPct:             recipe.packagingPct,
          actualSellingPriceCents:  recipe.actualSellingPriceCents,
          photoUrl:                 recipe.photoUrl,
          menuItemName:             recipe.menuItem?.name ?? recipe.name ?? null,
          status:                   recipe.status,
        },
        brand: recipe.menuItem?.concept ?? null,
        ingredients,
        cost: {
          totalIngredientCents,
          qFactorCents,
          totalRecipeCents,
          plateCostCents,
          opexPerPortionCents,
          brandMonthlyOpexCents,
          brandForecastPortions,
          // Opex provenance — so the UI can show where the number comes from.
          opexLinesMonthlyCents,
          payrollShareMonthlyCents,
          payrollTenantMonthlyCents,
        },
        pricing: {
          foodCostPriceCents,
          fcTargetPriceCents,
          breakEvenPriceCents,
          targetPriceCents,
          actualSellingPriceCents,
        },
        profitability: {
          packagingCostCents,
          contributionMarginCents,
          contributionMarginPct,
          netProfitCents,
          netProfitPct,
          foodCostPctOfSp,
          verdict,
        },
      }
    },
  )

  // GET /recipes/by-item/:menuItemId — KDS instruction panel fetches this
  // when the cook taps a card. Includes both the legacy free-text steps
  // (steps / stepsUrdu) AND the structured per-step list (recipeSteps with
  // station + estimated seconds), plus the menu item's photo for picture-
  // mode kitchens.
  fastify.get<{ Params: { menuItemId: string } }>(
    '/by-item/:menuItemId',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      // Cross-company guard: the menu item must belong to a concept in the
      // caller's tenant scope (null result mirrors "no recipe" — no leak).
      const inScope = await prisma.menuItem.findFirst({
        where: { id: req.params.menuItemId, concept: { tenantId: req.staffUser!.tenantFilter } },
        select: { id: true },
      })
      if (!inScope) return null
      const recipe = await prisma.recipe.findUnique({
        where: { menuItemId: req.params.menuItemId },
        include: {
          ingredients: {
            include: {
              inventoryItem: { select: { name: true, unit: true } },
              prepRecipe:    { select: { name: true } },
            },
            orderBy: { inventoryItem: { name: 'asc' } },
          },
          recipeSteps: {
            include: { station: { select: { name: true } } },
            orderBy: [{ phase: 'asc' }, { ordinal: 'asc' }],
          },
          menuItem: { select: { name: true, imageUrl: true } },
        },
      })
      if (!recipe) return null
      return {
        id:          recipe.id,
        steps:       recipe.steps,
        stepsUrdu:   recipe.stepsUrdu,
        notes:       recipe.notes,
        servings:    recipe.servings,
        laborMinutes: recipe.laborMinutes,
        ingredients: recipe.ingredients.map((ing) => ({
          id:           ing.id,
          quantity:     ing.quantity,
          yieldPct:     ing.yieldPct,
          unit:         ing.unit,
          notes:        ing.notes,
          // Component name comes from whichever source the row points at —
          // a raw inventory item or a prep recipe used as a sub-component.
          name:         ing.inventoryItem?.name ?? ing.prepRecipe?.name ?? '—',
        })),
        recipeSteps: recipe.recipeSteps.map((s) => ({
          id:               s.id,
          phase:            s.phase,
          ordinal:          s.ordinal,
          instruction:      s.instruction,
          instructionUrdu:  s.instructionUrdu,
          estimatedSeconds: s.estimatedSeconds,
          stationName:      s.station?.name ?? null,
        })),
        // This endpoint is gated by menuItemId in the query above, so menuItem
        // is always present here — but Prisma's type is now nullable since
        // prep recipes leave it null. Fall back defensively just in case.
        menuItem: recipe.menuItem
          ? { name: recipe.menuItem.name, imageUrl: recipe.menuItem.imageUrl }
          : { name: recipe.name ?? '—', imageUrl: null },
      }
    },
  )

  // POST /recipes — handles both plate and component recipes (kind defaults to plate).
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = recipeSchema.parse(req.body)

    // Plate recipes are 1:1 with a MenuItem — check for an existing recipe on
    // that menu item to surface a clean 409 instead of a Prisma unique-violation.
    // Component recipes have no menuItemId, so no uniqueness check needed (multiple
    // components with the same name are allowed; operator distinguishes by id).
    if (body.kind === 'plate' && body.menuItemId) {
      const existing = await prisma.recipe.findUnique({ where: { menuItemId: body.menuItemId } })
      if (existing) throw new AppError('RECIPE_EXISTS', 'Recipe for this menu item already exists', 409)
    }

    // New recipes start in `iteration` (testing). A testing plate must NOT
    // open a menu item — only an approved (production) recipe does. So when
    // kind='plate' + newMenuItem (no existing menuItemId), we DEFER creation:
    // stash the intended item in `pendingMenuItem` and create the real
    // MenuItem at approval time (see POST /:id/approve). Plates attached to an
    // EXISTING menuItemId just link to it (no new item opened either way).
    const resolvedMenuItemId = body.kind === 'plate' ? (body.menuItemId ?? null) : null
    const pendingMenuItem = (body.kind === 'plate' && !resolvedMenuItemId && body.newMenuItem)
      ? {
          conceptId:   body.newMenuItem.conceptId,
          categoryId:  body.newMenuItem.categoryId,
          name:        body.newMenuItem.name,
          description: body.newMenuItem.description ?? null,
        }
      : null

    const recipe = await prisma.recipe.create({
      data: {
        kind:         body.kind,
        menuItemId:   resolvedMenuItemId,
        pendingMenuItem: pendingMenuItem ?? Prisma.DbNull,
        // Plate recipes normally inherit their name from the menu item, but a
        // testing plate has none yet — carry the pending name so it's readable
        // in the list/editor until approval creates the item.
        name:         body.kind === 'plate' ? (pendingMenuItem?.name ?? null) : body.name,
        yieldGrams:   body.yieldGrams ?? null,  // total recipe yield (g) — batch yield for components, cooked total for plates
        servings:     body.servings,
        portionSizeG: body.portionSizeG,
        laborMinutes: body.laborMinutes,
        notes:        body.notes,
        steps:        body.steps,
        stepsUrdu:    body.stepsUrdu,
        seasons:      body.seasons,
        seasonStart:  body.seasonStart ?? null,
        seasonEnd:    body.seasonEnd ?? null,
        isActive:     body.isActive,
        qFactorPct:              body.qFactorPct,
        targetProfitPct:         body.targetProfitPct,
        targetFoodCostPct:       body.targetFoodCostPct,
        packagingPct:            body.packagingPct,
        actualSellingPriceCents: body.actualSellingPriceCents ?? null,
        category:                body.category ?? null,
        photoUrl:                body.photoUrl ?? null,
        methodSteps:             body.methodSteps ?? Prisma.DbNull,
        ingredients:  { create: body.ingredients.map((i) => ({
          quantity: i.quantity,
          yieldPct: i.yieldPct,
          unit:     i.unit,
          notes:    i.notes,
          inventoryItemId: i.inventoryItemId ?? null,
          prepRecipeId:    i.prepRecipeId ?? null,
        })) },
      },
      include: {
        ingredients: { include: { inventoryItem: true, prepRecipe: { select: { id: true, name: true } } } },
        menuItem: true,
      },
    })
    return reply.status(201).send(recipe)
  })

  // PUT /recipes/:id — full replace.
  // .partial().parse() loses the superRefine cross-field validation (zod
  // strips it). That's OK here because we accept partial updates — the
  // operator might only be patching servings or one ingredient. Kind itself
  // is treated as immutable from this endpoint; a plate can't become a component
  // without re-creation since downstream consumers (MenuItem unique, KDS
  // pathway, FBR posting) assume the original shape.
  fastify.put<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = recipeUpdateSchema.parse(req.body)
      await assertRecipeInScope(req, req.params.id)
      return prisma.$transaction(async (tx) => {
        if (body.ingredients) {
          await tx.recipeIngredient.deleteMany({ where: { recipeId: req.params.id } })
        }
        return tx.recipe.update({
          where: { id: req.params.id },
          data: {
            ...(body.name         !== undefined && { name: body.name }),
            ...(body.yieldGrams   !== undefined && { yieldGrams: body.yieldGrams }),
            ...(body.servings     != null && { servings: body.servings }),
            ...(body.portionSizeG != null && { portionSizeG: body.portionSizeG }),
            ...(body.laborMinutes != null && { laborMinutes: body.laborMinutes }),
            ...(body.notes        != null && { notes: body.notes }),
            ...(body.steps        != null && { steps: body.steps }),
            ...(body.stepsUrdu    != null && { stepsUrdu: body.stepsUrdu }),
            ...(body.seasons      != null && { seasons: body.seasons }),
            ...(body.seasonStart  !== undefined && { seasonStart: body.seasonStart }),
            ...(body.seasonEnd    !== undefined && { seasonEnd: body.seasonEnd }),
            ...(body.isActive     != null && { isActive: body.isActive }),
            ...(body.qFactorPct              != null      && { qFactorPct:              body.qFactorPct }),
            ...(body.targetProfitPct         != null      && { targetProfitPct:         body.targetProfitPct }),
            ...(body.targetFoodCostPct       != null      && { targetFoodCostPct:       body.targetFoodCostPct }),
            ...(body.packagingPct            != null      && { packagingPct:            body.packagingPct }),
            ...(body.actualSellingPriceCents !== undefined && { actualSellingPriceCents: body.actualSellingPriceCents }),
            ...(body.category                !== undefined && { category:                body.category }),
            ...(body.photoUrl                !== undefined && { photoUrl:                body.photoUrl }),
            ...(body.methodSteps             !== undefined && { methodSteps:             body.methodSteps ?? Prisma.DbNull }),
            ...(body.ingredients  && {
              ingredients: {
                create: body.ingredients.map((i) => ({
                  quantity: i.quantity,
                  yieldPct: i.yieldPct,
                  unit:     i.unit,
                  notes:    i.notes,
                  inventoryItemId: i.inventoryItemId ?? null,
                  prepRecipeId:    i.prepRecipeId ?? null,
                })),
              },
            }),
          },
          include: {
            ingredients: { include: { inventoryItem: true, prepRecipe: { select: { id: true, name: true } } } },
            menuItem: true,
          },
        })
      }).then(async (updated) => {
        // Plate recipes are the price source for their menu item — sync the
        // operator's actualSellingPriceCents to MenuItem.priceCents whenever
        // it changes. Menu Editor still lets the operator override the price
        // there afterwards if they want it to deviate from the recipe.
        if (
          body.actualSellingPriceCents != null &&
          updated.kind === 'plate' &&
          updated.menuItemId &&
          updated.menuItem?.priceCents !== body.actualSellingPriceCents
        ) {
          await prisma.menuItem.update({
            where: { id: updated.menuItemId },
            data:  { priceCents: body.actualSellingPriceCents },
          })
        }
        return updated
      })
    },
  )

  // DELETE /recipes/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      await assertRecipeInScope(req, req.params.id)
      // deleteMany for idempotency — repeated DELETEs (React Query refetch
      // race, browser preflight oddities) on an already-gone row would throw
      // Prisma P2025 → 500. deleteMany silently no-ops.
      await prisma.recipe.deleteMany({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )

  // ── Recipe lifecycle: iteration → pending_approval → production ──────────────
  //
  // A recipe under testing (`iteration`) is submitted for promotion by any
  // manager, then approved or rejected by the CEO/owner (`admin` role, shown
  // as "CEO" in the admin UI). Approval flips status in place (the same record
  // goes live, keeping its history). Rejection drops it back to `iteration`
  // with a note.

  // POST /recipes/:id/submit — iteration → pending_approval (any manager).
  fastify.post<{ Params: { id: string } }>(
    '/:id/submit',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      await assertRecipeInScope(req, req.params.id)
      const recipe = await prisma.recipe.findUnique({ where: { id: req.params.id } })
      if (!recipe) throw new NotFoundError('Recipe', req.params.id)
      if (recipe.status !== 'iteration') {
        throw new AppError('BAD_STATUS', `Only recipes in iteration can be submitted (this one is ${recipe.status})`, 409)
      }
      return prisma.recipe.update({
        where: { id: req.params.id },
        data: {
          status:          'pending_approval',
          submittedById:   req.staffUser!.id,
          submittedAt:     new Date(),
          rejectionReason: null,   // clear any prior rejection note on re-submit
        },
      })
    },
  )

  // POST /recipes/:id/approve — pending_approval → production (CEO/owner only).
  fastify.post<{ Params: { id: string } }>(
    '/:id/approve',
    { preHandler: requireAuth(...APPROVERS) },
    async (req) => {
      await assertRecipeInScope(req, req.params.id)
      const recipe = await prisma.recipe.findUnique({ where: { id: req.params.id } })
      if (!recipe) throw new NotFoundError('Recipe', req.params.id)
      if (recipe.status !== 'pending_approval') {
        throw new AppError('BAD_STATUS', `Only recipes pending approval can be promoted (this one is ${recipe.status})`, 409)
      }
      // A co-owner cannot sign off their own submission — escalates to the CEO.
      assertNotSelfApproval(req, recipe.submittedById)

      const data: Prisma.RecipeUpdateInput = {
        status:          'production',
        approvedById:    req.staffUser!.id,
        approvedAt:      new Date(),
        rejectionReason: null,
      }

      // Approval is when a testing plate finally opens its menu item. If this
      // plate deferred creation (has a pendingMenuItem and no menuItem yet),
      // create the MenuItem now — seeded with the recipe's selling price and
      // availability — link it, and clear the pending payload + carried name.
      if (recipe.kind === 'plate' && !recipe.menuItemId && recipe.pendingMenuItem) {
        const pm = recipe.pendingMenuItem as { conceptId: string; categoryId: string; name: string; description: string | null }
        const item = await prisma.menuItem.create({
          data: {
            conceptId:   pm.conceptId,
            categoryId:  pm.categoryId,
            name:        pm.name,
            description: pm.description ?? null,
            priceCents:  recipe.actualSellingPriceCents ?? 0,
            isAvailable: recipe.isActive,
          },
        })
        data.menuItem = { connect: { id: item.id } }
        data.pendingMenuItem = Prisma.DbNull
        data.name = null   // plate now inherits its name from the menu item
      }

      return prisma.recipe.update({ where: { id: req.params.id }, data })
    },
  )

  // POST /recipes/:id/reject — pending_approval → iteration (CEO/owner only).
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/reject',
    { preHandler: requireAuth(...APPROVERS) },
    async (req) => {
      const { reason } = z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {})
      await assertRecipeInScope(req, req.params.id)
      const recipe = await prisma.recipe.findUnique({ where: { id: req.params.id } })
      if (!recipe) throw new NotFoundError('Recipe', req.params.id)
      if (recipe.status !== 'pending_approval') {
        throw new AppError('BAD_STATUS', `Only recipes pending approval can be rejected (this one is ${recipe.status})`, 409)
      }
      // Same escalation rule as approve — an owner can't rule on their own work.
      assertNotSelfApproval(req, recipe.submittedById)
      return prisma.recipe.update({
        where: { id: req.params.id },
        data: {
          status:          'iteration',
          rejectionReason: reason?.trim() || null,
        },
      })
    },
  )

  // ── Recipe test attempts (versioned test-cook log) ──────────────────────────
  //
  // Each attempt is a dated record of a test cook while a recipe is being
  // iterated, numbered v1, v2, … per recipe so the kitchen can see how it
  // evolved before promotion.

  // GET /recipes/:id/test-attempts — newest first.
  fastify.get<{ Params: { id: string } }>(
    '/:id/test-attempts',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      // Cross-company guard on the parent recipe.
      const parent = await prisma.recipe.findUnique({
        where: { id: req.params.id },
        select: { kind: true, pendingMenuItem: true, menuItem: { select: { conceptId: true } } },
      })
      if (!parent || !recipeInScope(parent, await scopedConceptIdSet(req))) {
        throw new NotFoundError('Recipe', req.params.id)
      }
      return prisma.recipeTestAttempt.findMany({
        where: { recipeId: req.params.id },
        orderBy: { version: 'desc' },
      })
    },
  )

  const testAttemptSchema = z.object({
    notes:   z.string().min(1, 'Add a note describing the test').max(4000),
    outcome: z.enum(['promising', 'needs_work', 'rejected']).optional(),
    rating:  z.number().int().min(1).max(5).optional(),
  })

  // POST /recipes/:id/test-attempts — log a test cook. Auto-numbers the version.
  fastify.post<{ Params: { id: string } }>(
    '/:id/test-attempts',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = testAttemptSchema.parse(req.body)
      await assertRecipeInScope(req, req.params.id)
      const recipe = await prisma.recipe.findUnique({ where: { id: req.params.id }, select: { id: true } })
      if (!recipe) throw new NotFoundError('Recipe', req.params.id)

      // Next version = current max + 1. The (recipeId, version) unique index
      // guards against a duplicate if two cooks log at the same instant.
      const last = await prisma.recipeTestAttempt.findFirst({
        where: { recipeId: req.params.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      })
      const attempt = await prisma.recipeTestAttempt.create({
        data: {
          recipeId:     req.params.id,
          version:      (last?.version ?? 0) + 1,
          notes:        body.notes.trim(),
          outcome:      body.outcome ?? null,
          rating:       body.rating ?? null,
          testedById:   req.staffUser!.id,
          testedByName: req.staffUser!.name ?? req.staffUser!.email ?? null,
        },
      })
      return reply.status(201).send(attempt)
    },
  )

  // ── Food Cost Analysis ─────────────────────────────────────────────────────

  // GET /recipes/food-cost?conceptId&dateFrom&dateTo
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/food-cost',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const from = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 30 * 86_400_000)
      const to   = dateTo   ? new Date(dateTo)   : new Date()

      // Company scoping: restrict everything to the concepts visible to this
      // request. An out-of-scope conceptId behaves like an unknown one.
      const visibleConceptIds = await scopedConceptIdSet(req)
      if (conceptId && !visibleConceptIds.has(conceptId)) {
        return {
          period: { from: from.toISOString(), to: to.toISOString() },
          revenue: { grossCents: 0, netCents: 0 },
          cost: { theoreticalCents: 0, actualPurchasesCents: 0, theoreticalFoodCostPct: 0, targetFoodCostPct: 30, variance: -30, status: 'good' },
          byItem: [], itemsWithoutRecipe: [],
        }
      }
      const conceptScope = conceptId ? [conceptId] : Array.from(visibleConceptIds)

      // Sales in period
      const salesData = await prisma.financialEntry.aggregate({
        where: {
          conceptId: { in: conceptScope },
          entryDate: { gte: from, lte: to },
        },
        _sum: { grossCents: true, netCents: true },
        _count: true,
      })
      const grossRevenue = salesData._sum.grossCents ?? 0
      const netRevenue   = salesData._sum.netCents   ?? 0

      // Items sold in period
      const soldItems = await prisma.orderItem.groupBy({
        by: ['menuItemId', 'name'],
        where: {
          order: {
            conceptId: { in: conceptScope },
            status: 'completed',
            placedAt: { gte: from, lte: to },
          },
          menuItemId: { not: null },
        },
        _sum: { quantity: true },
      })

      // Recipes with costs
      const recipes = await prisma.recipe.findMany({
        where: { menuItem: { conceptId: { in: conceptScope } } },
        include: {
          menuItem: { select: { id: true, name: true, priceCents: true } },
          ingredients: { include: { inventoryItem: { select: { unitCostCents: true } } } },
        },
      })

      const recipeMap = new Map(recipes.map((r) => [r.menuItemId, r]))

      let theoreticalCostCents = 0
      const byItem: Array<{
        menuItemId: string; name: string; qtySold: number
        costPerPortion: number; totalCost: number
        revenue: number; foodCostPct: number; marginPct: number
      }> = []

      for (const sold of soldItems) {
        if (!sold.menuItemId) continue
        const qty = sold._sum.quantity ?? 0
        const recipe = recipeMap.get(sold.menuItemId)
        if (!recipe) continue

        const ingCost = recipe.ingredients.reduce((s, ing) => {
          const yp = ing.yieldPct > 0 ? ing.yieldPct : 1
          // Only raw inventory rows count here — prep components are rare on
          // a plate sold today (zero in the current dataset) and the food-cost
          // endpoint is approximate by design (theoretical, not actual COGS).
          if (!ing.inventoryItem) return s
          return s + Math.round((ing.inventoryItem.unitCostCents ?? 0) * (ing.quantity / yp))
        }, 0)
        const totalWithQ     = Math.round(ingCost * (1 + Q_FACTOR))
        const costPerPortion = recipe.servings > 0 ? Math.round(totalWithQ / recipe.servings) : totalWithQ
        const totalCost = costPerPortion * qty
        // recipe.menuItem can now be null on prep recipes — but a "sold"
        // order item by definition has a menuItem, so this is a Prisma type
        // narrowing concern, not a real null. Default to 0 revenue if absent.
        const itemRevenue = (recipe.menuItem?.priceCents ?? 0) * qty

        theoreticalCostCents += totalCost
        byItem.push({
          menuItemId:   sold.menuItemId,
          name:         sold.name,
          qtySold:      qty,
          costPerPortion,
          totalCost,
          revenue:      itemRevenue,
          foodCostPct:  itemRevenue > 0 ? Math.round((totalCost / itemRevenue) * 100) : 0,
          marginPct:    itemRevenue > 0 ? Math.round(((itemRevenue - totalCost) / itemRevenue) * 100) : 0,
        })
      }

      byItem.sort((a, b) => b.totalCost - a.totalCost)

      // Actual food cost from purchases in period. POs scope through their
      // supplier's tenant (legacy suppliers with no tenant count for everyone).
      const purchases = await prisma.purchaseOrderLine.aggregate({
        where: {
          purchaseOrder: {
            status: 'received',
            receivedDate: { gte: from, lte: to },
            supplier: { OR: [{ tenantId: req.staffUser!.tenantFilter }, { tenantId: null }] },
          },
        },
        _sum: { unitCostCents: true },
      })
      const actualPurchasesCents = purchases._sum.unitCostCents ?? 0

      const theoreticalFoodCostPct = grossRevenue > 0
        ? parseFloat(((theoreticalCostCents / grossRevenue) * 100).toFixed(1))
        : 0

      return {
        period:     { from: from.toISOString(), to: to.toISOString() },
        revenue:    { grossCents: grossRevenue, netCents: netRevenue },
        cost: {
          theoreticalCents:       theoreticalCostCents,
          actualPurchasesCents,
          theoreticalFoodCostPct,
          targetFoodCostPct:      30,   // industry standard for restaurant
          variance:               parseFloat((theoreticalFoodCostPct - 30).toFixed(1)),
          status:                 theoreticalFoodCostPct <= 30 ? 'good' : theoreticalFoodCostPct <= 35 ? 'warning' : 'critical',
        },
        byItem,
        itemsWithoutRecipe: soldItems.filter((s) => s.menuItemId && !recipeMap.has(s.menuItemId)).map((s) => ({
          menuItemId: s.menuItemId,
          name: s.name,
          qtySold: s._sum.quantity ?? 0,
        })),
      }
    },
  )

  // ── Vendors / Purchase Orders ──────────────────────────────────────────────

  // GET /recipes/vendors — scoped to the active company's suppliers (legacy
  // rows with no tenant stay visible everywhere until assigned).
  fastify.get('/vendors', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.supplier.findMany({
      where: {
        deletedAt: null,
        OR: [{ tenantId: req.staffUser!.tenantFilter }, { tenantId: null }],
      },
      include: { _count: { select: { purchaseOrders: true, inventoryItems: true } } },
      orderBy: { name: 'asc' },
    })
  })

  // POST /recipes/vendors
  fastify.post('/vendors', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:    z.string().min(1),
      phone:   z.string().optional(),
      email:   z.string().email().optional(),
      address: z.string().optional(),
      taxId:   z.string().optional(),
      notes:   z.string().optional(),
    }).parse(req.body)
    const vendor = await prisma.supplier.create({ data: body })
    return reply.status(201).send(vendor)
  })

  // PATCH /recipes/vendors/:id
  fastify.patch<{ Params: { id: string } }>(
    '/vendors/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        name:    z.string().min(1).optional(),
        phone:   z.string().optional(),
        email:   z.string().email().optional(),
        address: z.string().optional(),
        taxId:   z.string().optional(),
        notes:   z.string().optional(),
      }).parse(req.body)
      // Suppliers are company data (Supplier.tenantId) — editing one by bare
      // id let a manager rename or re-point another company's vendor.
      const owned = await prisma.supplier.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter },
        select: { id: true },
      })
      if (!owned) throw new NotFoundError('Supplier', req.params.id)
      return prisma.supplier.update({ where: { id: owned.id }, data: body })
    },
  )

  // GET /recipes/purchase-orders
  fastify.get<{ Querystring: { supplierId?: string; status?: string; limit?: string } }>(
    '/purchase-orders',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200)
      return prisma.purchaseOrder.findMany({
        where: {
          ...(req.query.supplierId && { supplierId: req.query.supplierId }),
          ...(req.query.status    && { status: req.query.status }),
          // POs scope through their supplier's tenant (null = legacy/shared).
          supplier: { OR: [{ tenantId: req.staffUser!.tenantFilter }, { tenantId: null }] },
        },
        include: {
          supplier: { select: { name: true } },
          lines:    { include: { inventoryItem: { select: { name: true, unit: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
    },
  )

  // POST /recipes/purchase-orders
  fastify.post('/purchase-orders', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = poSchema.parse(req.body)
    const totalCents = body.lines.reduce((s, l) => s + Math.round(l.unitCostCents * l.quantityOrdered), 0)
    const po = await prisma.purchaseOrder.create({
      data: {
        supplierId:   body.supplierId,
        expectedDate: body.expectedDate ? new Date(body.expectedDate) : null,
        reference:    body.reference,
        notes:        body.notes,
        totalCents,
        createdBy:    req.staffUser!.id,
        lines: { create: body.lines },
      },
      include: { supplier: true, lines: { include: { inventoryItem: true } } },
    })
    return reply.status(201).send(po)
  })

  // POST /recipes/purchase-orders/:id/receive — mark as received, update inventory + costs
  fastify.post<{ Params: { id: string }; Body: { lines: { lineId: string; quantityReceived: number }[] } }>(
    '/purchase-orders/:id/receive',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { lines } = z.object({
        lines: z.array(z.object({
          lineId:           z.string().uuid(),
          quantityReceived: z.number().positive(),
        })),
      }).parse(req.body)

      // Receiving stock against another company's PO would post their goods
      // (and their liability) from this company's screen.
      const po = await prisma.purchaseOrder.findFirst({
        where: { id: req.params.id, supplier: { tenantId: req.staffUser!.tenantFilter } },
        include: { lines: true },
      })
      if (!po) throw new NotFoundError('PurchaseOrder', req.params.id)
      if (po.status === 'cancelled') throw new AppError('PO_CANCELLED', 'Cannot receive a cancelled PO', 400)

      await prisma.$transaction(async (tx) => {
        for (const recv of lines) {
          const poLine = po.lines.find((l) => l.id === recv.lineId)
          if (!poLine) continue

          // Update line received qty
          await tx.purchaseOrderLine.update({
            where: { id: recv.lineId },
            data: { quantityReceived: { increment: recv.quantityReceived } },
          })

          // Update inventory stock + unit cost (weighted average)
          const item = await tx.inventoryItem.findUnique({ where: { id: poLine.inventoryItemId } })
          if (item) {
            const oldStock   = item.currentStock
            const newStock   = oldStock + recv.quantityReceived
            const oldCost    = item.unitCostCents ?? poLine.unitCostCents
            const newUnitCost = newStock > 0
              ? Math.round((oldCost * oldStock + poLine.unitCostCents * recv.quantityReceived) / newStock)
              : poLine.unitCostCents

            await tx.inventoryItem.update({
              where: { id: poLine.inventoryItemId },
              data: { currentStock: { increment: recv.quantityReceived }, unitCostCents: newUnitCost },
            })
          }
        }

        const allReceived = po.lines.every((l) => {
          const recv = lines.find((r) => r.lineId === l.id)
          const total = l.quantityReceived + (recv?.quantityReceived ?? 0)
          return total >= l.quantityOrdered
        })

        await tx.purchaseOrder.update({
          where: { id: req.params.id },
          data: {
            status:       allReceived ? 'received' : 'partial',
            receivedDate: new Date(),
          },
        })
      })

      return prisma.purchaseOrder.findUnique({
        where: { id: req.params.id },
        include: { supplier: true, lines: { include: { inventoryItem: true } } },
      })
    },
  )

  // PATCH /recipes/purchase-orders/:id/cancel
  fastify.patch<{ Params: { id: string } }>(
    '/purchase-orders/:id/cancel',
    { preHandler: requireAuth(...APPROVERS) },
    async (req) => {
      const owned = await prisma.purchaseOrder.findFirst({
        where: { id: req.params.id, supplier: { tenantId: req.staffUser!.tenantFilter } },
        select: { id: true },
      })
      if (!owned) throw new NotFoundError('PurchaseOrder', req.params.id)
      return prisma.purchaseOrder.update({
        where: { id: owned.id },
        data: { status: 'cancelled' },
      })
    },
  )

  // ─── Recipe steps (per-station service sequence) ────────────────────────
  //
  // A recipe has 0..n steps. Each step is tagged by phase (mise/MOP/cook/
  // assemble), pinned to a station, has an instruction, an ETA, and may
  // depend on prior steps. The expo-fire engine reads these on order
  // confirmation; the cascade engine walks them on each bump.

  // GET /recipes/:recipeId/steps — list ordered by phase then ordinal
  fastify.get<{ Params: { recipeId: string } }>(
    '/:recipeId/steps',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      // Cross-company guard on the parent recipe (empty list, no leak).
      const parent = await prisma.recipe.findUnique({
        where: { id: req.params.recipeId },
        select: { kind: true, pendingMenuItem: true, menuItem: { select: { conceptId: true } } },
      })
      if (!parent || !recipeInScope(parent, await scopedConceptIdSet(req))) return []
      return prisma.recipeStep.findMany({
        where: { recipeId: req.params.recipeId },
        orderBy: [{ phase: 'asc' }, { ordinal: 'asc' }],
        include: { station: { select: { id: true, name: true } } },
      })
    },
  )

  const stepInputSchema = z.object({
    phase:            z.enum(['prep_mep', 'prep_mop', 'service_cook', 'service_assemble']),
    ordinal:          z.number().int().min(0).default(0),
    stationId:        z.string().uuid().nullable().optional(),
    instruction:      z.string().min(1).max(2000),
    instructionUrdu:  z.string().max(2000).nullable().optional(),
    estimatedSeconds: z.number().int().min(0).default(60),
    // Other step IDs (from the same recipe) that must complete first.
    dependsOnIds:     z.array(z.string().uuid()).default([]),
  })

  // POST /recipes/:recipeId/steps
  fastify.post<{ Params: { recipeId: string } }>(
    '/:recipeId/steps',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = stepInputSchema.parse(req.body)
      const recipe = await prisma.recipe.findUnique({ where: { id: req.params.recipeId } })
      if (!recipe) throw new NotFoundError('Recipe', req.params.recipeId)
      // Dependency-self / cycle guard: only allow deps that already exist on
      // this recipe. Future steps in the editor will be added one-at-a-time
      // so cycles are impossible by construction.
      if (body.dependsOnIds.length > 0) {
        const valid = await prisma.recipeStep.findMany({
          where: { recipeId: req.params.recipeId, id: { in: body.dependsOnIds } },
          select: { id: true },
        })
        if (valid.length !== body.dependsOnIds.length) {
          throw new AppError('INVALID_DEPS', 'One or more dependency step IDs do not belong to this recipe', 400)
        }
      }
      const created = await prisma.recipeStep.create({
        data: { ...body, recipeId: req.params.recipeId },
        include: { station: { select: { id: true, name: true } } },
      })
      return reply.status(201).send(created)
    },
  )

  // PATCH /recipes/steps/:stepId
  fastify.patch<{ Params: { stepId: string } }>(
    '/steps/:stepId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = stepInputSchema.partial().parse(req.body)
      const existing = await prisma.recipeStep.findUnique({ where: { id: req.params.stepId } })
      if (!existing) throw new NotFoundError('RecipeStep', req.params.stepId)
      // No self-dependency.
      if (body.dependsOnIds?.includes(existing.id)) {
        throw new AppError('SELF_DEP', 'A step cannot depend on itself', 400)
      }
      const updated = await prisma.recipeStep.update({
        where: { id: req.params.stepId },
        data:  body,
        include: { station: { select: { id: true, name: true } } },
      })
      return reply.status(200).send(updated)
    },
  )

  // DELETE /recipes/steps/:stepId — refuses if other steps depend on this one
  // so the editor surfaces a clear "remove this dep first" error.
  fastify.delete<{ Params: { stepId: string } }>(
    '/steps/:stepId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const step = await prisma.recipeStep.findUnique({ where: { id: req.params.stepId } })
      if (!step) throw new NotFoundError('RecipeStep', req.params.stepId)
      const dependents = await prisma.recipeStep.findMany({
        where: { recipeId: step.recipeId, dependsOnIds: { has: req.params.stepId } },
        select: { id: true, instruction: true },
      })
      if (dependents.length > 0) {
        return reply.status(409).send({
          error: {
            code: 'HAS_DEPENDENTS',
            message: `${dependents.length} other step(s) depend on this one — remove those deps first.`,
            dependents,
          },
        })
      }
      await prisma.recipeStep.delete({ where: { id: req.params.stepId } })
      return reply.status(204).send()
    },
  )
}
