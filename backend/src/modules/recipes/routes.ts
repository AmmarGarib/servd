import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import type { UserRole } from '@prisma/client'
import { requireAuth, MANAGERS, ALL_STAFF, FINANCE_TEAM } from '../auth/middleware.js'
import { costsHiddenFor } from '../inventory/routes.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import {
  buildRecipeGraph, loadRecipeGraph, recipeCost,
  type CostRecipe, type RecipeCost, type RecipeGraph, type RecipeLineCost,
} from '../../lib/recipeCost.js'
import { costClassOf } from '../../lib/inventoryClass.js'
import { scopeTenantWhere, assertConceptOwned, resolveTenantScope, type ScopeMode, type TenantIdWhere } from '../../lib/tenantScope.js'
import { serviceClient } from '../../lib/prisma.js'
import { ForbiddenError } from '../../lib/errors.js'
import { assertHoMayPropose, isReachOnly, viaHeadOfficeForSubmit } from '../../lib/headOffice.js'
import { assertNotAmongSubmitters } from '../../lib/separation-of-duties.js'
import { approvalWaiting } from '../approvals/notify.js'
import {
  APPROVAL_RIGHTS, approvalInputOf, approvalQueueTenantIds, approvalSubject, assertCanApprove, auditApproval, canApprove, decideApproval,
  delegatedTenantsByType, throughHeadOfficeBatch, type ApprovalGrant, type ApprovalSubject, type ApprovalType,
} from '../../lib/approvalRights.js'
import { toCents } from '../../lib/money.js'
import { audit } from '../../lib/audit.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { takeSnapshot } from '../trash/snapshot.js'
import { assertItemsNotTrashedTx } from '../inventory/unusedCleanup.js'

// Every cost on this module comes from lib/recipeCost.ts — THE plate cost the
// ledger books as COGS and the stock depletion explodes. That is: each
// recipe's own Q factor (default 10%) applied once, on its own raw lines;
// sub-recipes costed at any depth at their cost-per-gram; count items divided
// by yield like weighed ones; and NO kitchen labour (owner decision 26 — the
// PKR 50/hr that the list and every sub-recipe used to add). Labour reaches
// the price only as payroll, in /:id/costing's opex per portion.
//
// Recipe.laborMinutes stays: it is prep TIME (course pacing, prep planning),
// not a cost input.

/** Cost lines keyed by RecipeIngredient.id so a route can decorate its own rows. */
function linesById(cost: RecipeCost): Map<string, RecipeLineCost> {
  return new Map(cost.lines.filter((l) => l.ingredientId).map((l) => [l.ingredientId!, l]))
}

const SEASON_KEYS = ['spring', 'summer', 'monsoon', 'autumn', 'winter', 'ramadan', 'year-round'] as const
const SEASON_DATE_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

// Single schema for every kind. The kind-specific requirements (plate must
// have a menu item, component must have name + yieldGrams, modifier must name
// its modifier) are enforced via .superRefine below — that lets us produce
// per-field error messages instead of a generic "invalid payload".
//
// Ingredient rows are also disjoint: either inventoryItemId (raw stock)
// or prepRecipeId (a component sub-recipe). The mutual exclusion
// is checked client-side via the picker, server-side via the schema, and
// at the DB layer via the CHECK constraint in the migration.
//
// `section` (wave B, owner's FINAL packaging rule): a PLATE recipe's lines are
// 'ingredients' or 'packaging'. Packaging-class stock goes ONLY in the
// Packaging section and nothing else does; components and modifier recipes
// have no Packaging section. Whether a sale uses the packaging is decided at
// the sale (lib/recipeCost.ts packagingApplies), never per line here.
//
// `quantity` may be negative ("removes", e.g. "no cheese") ONLY on a modifier
// recipe — checked in validateRecipeLines (422 NEGATIVE_QTY_NOT_ALLOWED); the
// sale clamps each ingredient at zero per line.
const ingredientSchema = z.object({
  inventoryItemId: z.string().uuid().optional(),
  prepRecipeId:    z.string().uuid().optional(),
  quantity:        z.number().finite().refine((q) => q !== 0, { message: 'Quantity cannot be zero' }),
  yieldPct:        z.number().min(0.01).max(1).default(1),
  unit:            z.string().min(1),
  notes:           z.string().optional(),
  section:         z.enum(['ingredients', 'packaging']).default('ingredients'),
}).refine(
  (i) => Boolean(i.inventoryItemId) !== Boolean(i.prepRecipeId),
  { message: 'Each ingredient must reference exactly one of inventoryItem or prepRecipe' },
)
type IngredientInput = z.infer<typeof ingredientSchema>

/** The RecipeIngredient row an input line is written as (create and PUT). */
function ingredientRow(i: IngredientInput) {
  return {
    quantity: i.quantity,
    yieldPct: i.yieldPct,
    unit:     i.unit,
    notes:    i.notes,
    section:  i.section,
    inventoryItemId: i.inventoryItemId ?? null,
    prepRecipeId:    i.prepRecipeId ?? null,
  }
}

// Split the schema into a plain object + a refined wrapper so PUT (full-replace
// update) can use .partial() — zod's .superRefine wraps the schema in
// ZodEffects, which doesn't expose .partial. We keep the refinement on POST
// (where every required field is enforced) and skip it on PUT (where partial
// edits are allowed by design).
//
// `packagingPct` is RETIRED (wave B): packaging is the recipe's Packaging
// section. A client that still sends it is ignored (zod strips the key) and
// the column is never written.
const recipeShape = {
  kind:         z.enum(['plate', 'component', 'modifier']).default('plate'),
  menuItemId:   z.string().uuid().optional(),
  // kind 'modifier': the add-on this recipe costs (one recipe per modifier).
  modifierId:   z.string().uuid().optional(),
  name:         z.string().min(1).optional(),
  yieldGrams:   z.number().positive().nullable().optional(),  // component batch yield OR plate total yield (g)
  // A prep recipe's yield unit (owner 2026-10-24, D3): grams (default), millilitres or pieces — its prep item's unit.
  yieldUnit:    z.enum(['g', 'ml', 'pcs']).optional(),
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
  // and inherit the operator-level defaults (10/25/30) — see spec.
  // qFactorPct is THE one pricing allowance (H18: plate wear, garnish, oil) —
  // pricing only, never a stock quantity, never posted.
  qFactorPct:              z.number().min(0).max(100).default(10),
  targetProfitPct:         z.number().min(0).max(100).default(25),
  targetFoodCostPct:       z.number().min(1).max(100).default(30),
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
  if (r.kind !== 'modifier' && r.modifierId) {
    ctx.addIssue({ code: 'custom', path: ['modifierId'], message: 'Only modifier recipes link to a modifier' })
  }
  if (r.kind === 'component') {
    if (!r.name || !r.name.trim()) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'Component recipes need a name' })
    }
    if (!r.yieldGrams || r.yieldGrams <= 0) {
      ctx.addIssue({ code: 'custom', path: ['yieldGrams'], message: 'Component recipes need a batch yield in grams (drives cost-per-gram)' })
    }
  }
  if (r.kind === 'component' || r.kind === 'modifier') {
    if (r.menuItemId || r.newMenuItem) {
      ctx.addIssue({ code: 'custom', path: ['menuItemId'], message: `${r.kind === 'component' ? 'Component' : 'Modifier'} recipes do not link to a menu item` })
    }
  }
  if (r.kind === 'modifier' && !r.modifierId) {
    ctx.addIssue({ code: 'custom', path: ['modifierId'], message: 'Pick the modifier (add-on) this recipe is for' })
  }
})
// PUT-time schema — same fields, but every one optional so partial updates
// (e.g. just tweaking servings) don't require resending the whole recipe.
// kind / menuItemId / modifierId are immutable here (never written by PUT).
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

// ── Tenant scoping ──────────────────────────────────────────────────────────
// Recipes have no tenant column. A company is derived:
//   • PLATE → its menu item's brand — or, pre-approval, pendingMenuItem's
//     brand (a Json payload, so it can't be filtered in SQL; we post-filter).
//   • COMPONENT (sub-recipe) → every company that uses it: the companies of
//     the plates that include it (directly or through other sub-recipes),
//     plus the companies of the raw inventory items it is made from. A
//     sub-recipe no plate uses and made only from shared (company-less) stock
//     has no derivable owner and stays visible to everyone until
//     Recipe.tenantId exists (reported as a schema follow-up).
//   • MODIFIER (wave B) → its modifier → group → menu item → brand.
// Components used to pass unconditionally, so any company could read, edit,
// approve or delete another company's sub-recipes — and editing one re-costs
// the other company's plates.
//
// Reads: a component is in scope when ANY company using it is in view.
// Writes: only when EVERY company using it is one the operator belongs to —
// otherwise one company's edit silently changes another company's costs.
async function scopedConceptIdSet(req: FastifyRequest, mode: ScopeMode = 'read'): Promise<Set<string>> {
  // This used to read `tenantId: (tenantFilter ?? undefined)`, and Prisma
  // treats `undefined` as "no filter" — so a null tenantFilter returned EVERY
  // company's concepts instead of none. That is the one fail-open scope helper
  // in the codebase; every other one returns `{ tenantId: { in: [] } }` and
  // denies. It mattered because a staff account CAN have a null tenant:
  // /auth/staff/signup creates users with no tenantId and no TenantMember row,
  // and approving them only flips accountStatus. Such an account saw every
  // company's recipes with their costs and margins, and assertRecipeInScope —
  // the guard added specifically to stop cross-company recipe writes — passed
  // for every recipe id, so edit, delete, approve and reject all went through.
  // Approving overwrites the live menu price of the other company's item.
  const concepts = await prisma.concept.findMany({
    where: { deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
    select: { id: true },
  })
  return new Set(concepts.map((c) => c.id))
}

/**
 * Companies (tenant ids) of each component recipe: the companies of the dishes
 * and add-ons that use it (walking up nested sub-recipes) plus the companies
 * of its own stock lines. `.users(id)` is only the first part — the companies
 * whose sales consume it, NO_COMPANY left out — which is what its stock lines
 * and stations must belong to. `.drawsOn(id)` is the companies of the stock it
 * and every sub-recipe under it use.
 */
type ComponentCompanies = ((recipeId: string) => Set<string>) & {
  users: (recipeId: string) => Set<string>
  drawsOn: (recipeId: string) => Set<string>
}

// A plate whose brand has no company belongs to nobody — never in any scope.
const NO_COMPANY = '\u0000none'

/** The brand of a modifier recipe: modifier → group → menu item → brand. */
const MODIFIER_BRAND = {
  select: {
    group: { select: { menuItem: { select: { conceptId: true, concept: { select: { tenantId: true, serviceVessel: true } } } } } },
  },
} satisfies Prisma.ModifierDefaultArgs

async function loadComponentCompanies(): Promise<ComponentCompanies> {
  const [recipes, links] = await Promise.all([
    prisma.recipe.findMany({
      select: {
        id: true, kind: true, pendingMenuItem: true,
        menuItem: { select: { concept: { select: { tenantId: true } } } },
        modifier: MODIFIER_BRAND,
      },
    }),
    prisma.recipeIngredient.findMany({
      select: { recipeId: true, prepRecipeId: true, inventoryItem: { select: { tenantId: true } } },
    }),
  ])
  const pendingConceptIds = new Set<string>()
  for (const r of recipes) {
    const cid = (r.pendingMenuItem as { conceptId?: string } | null)?.conceptId
    if (!r.menuItem && cid) pendingConceptIds.add(cid)
  }
  const pendingTenant = new Map(
    (await prisma.concept.findMany({ where: { id: { in: [...pendingConceptIds] } }, select: { id: true, tenantId: true } }))
      .map((c) => [c.id, c.tenantId]),
  )
  const byId = new Map(recipes.map((r) => [r.id, r]))
  const plateCompany = (r: (typeof recipes)[number]): string => {
    if (r.menuItem) return r.menuItem.concept.tenantId ?? NO_COMPANY
    const cid = (r.pendingMenuItem as { conceptId?: string } | null)?.conceptId
    return (cid && pendingTenant.get(cid)) || NO_COMPANY
  }
  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  const rawTenants = new Map<string, Set<string>>()
  for (const l of links) {
    if (l.prepRecipeId) {
      const list = parents.get(l.prepRecipeId) ?? []
      list.push(l.recipeId)
      parents.set(l.prepRecipeId, list)
      const kids = children.get(l.recipeId) ?? []
      kids.push(l.prepRecipeId)
      children.set(l.recipeId, kids)
    }
    const t = l.inventoryItem?.tenantId
    if (t) {
      const set = rawTenants.get(l.recipeId) ?? new Set<string>()
      set.add(t)
      rawTenants.set(l.recipeId, set)
    }
  }
  // The companies of the dishes and add-ons above a recipe (cycle-safe walk up).
  const userMemo = new Map<string, Set<string>>()
  const usersOf = (recipeId: string): Set<string> => {
    const hit = userMemo.get(recipeId)
    if (hit) return hit
    const out = new Set<string>()
    const seen = new Set<string>([recipeId])
    const stack = [...(parents.get(recipeId) ?? [])]
    while (stack.length) {
      const pid = stack.pop()!
      if (seen.has(pid)) continue
      seen.add(pid)
      const parent = byId.get(pid)
      if (!parent) continue
      if (parent.kind === 'plate') out.add(plateCompany(parent))
      else if (parent.kind === 'modifier') out.add(parent.modifier?.group.menuItem.concept.tenantId ?? NO_COMPANY)
      else stack.push(...(parents.get(pid) ?? []))
    }
    userMemo.set(recipeId, out)
    return out
  }
  const memo = new Map<string, Set<string>>()
  const all = ((recipeId: string) => {
    const hit = memo.get(recipeId)
    if (hit) return hit
    const out = new Set<string>([...(rawTenants.get(recipeId) ?? []), ...usersOf(recipeId)])
    memo.set(recipeId, out)
    return out
  }) as ComponentCompanies
  all.users = (recipeId) => new Set([...usersOf(recipeId)].filter((t) => t !== NO_COMPANY))
  // The stock companies of a recipe and every sub-recipe under it (cycle-safe walk down).
  all.drawsOn = (recipeId) => {
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
  return all
}

interface RecipeScope {
  mode:       ScopeMode
  conceptIds: Set<string>
  tenantIds:  Set<string>
  components: () => Promise<ComponentCompanies>
}

async function recipeScope(req: FastifyRequest, mode: ScopeMode = 'read'): Promise<RecipeScope> {
  const where = await scopeTenantWhere(req, mode)
  const tenantIds = new Set(typeof where.tenantId === 'string' ? [where.tenantId] : where.tenantId.in)
  let index: Promise<ComponentCompanies> | null = null
  return {
    mode,
    conceptIds: await scopedConceptIdSet(req, mode),
    tenantIds,
    components: () => (index ??= loadComponentCompanies()),
  }
}

type ScopableRecipe = {
  id: string
  kind: string
  menuItem?: { conceptId: string } | null
  pendingMenuItem?: unknown
  /** kind 'modifier': the chain to its brand. Undefined = not loaded (looked up). */
  modifier?: { group: { menuItem: { conceptId: string } } } | null
}

/** The brand (concept id) of a modifier recipe, or null. */
async function modifierConceptOf(r: ScopableRecipe): Promise<string | null> {
  if (r.modifier !== undefined) return r.modifier?.group.menuItem.conceptId ?? null
  const row = await prisma.recipe.findUnique({ where: { id: r.id }, select: { modifier: MODIFIER_BRAND } })
  return row?.modifier?.group.menuItem.conceptId ?? null
}

async function recipeInScope(r: ScopableRecipe, scope: RecipeScope): Promise<boolean> {
  if (r.kind === 'component') {
    const companies = (await scope.components())(r.id)
    if (companies.size === 0) return true   // no derivable owner — see header
    const inScope = [...companies].map((t) => scope.tenantIds.has(t))
    return scope.mode === 'read' ? inScope.some(Boolean) : inScope.every(Boolean)
  }
  if (r.kind === 'modifier') {
    const cid = await modifierConceptOf(r)
    return cid != null && scope.conceptIds.has(cid)
  }
  const pending = r.pendingMenuItem as { conceptId?: string } | null
  const cid = r.menuItem?.conceptId ?? pending?.conceptId ?? null
  return cid != null && scope.conceptIds.has(cid)
}

async function filterInScope<T extends ScopableRecipe>(rows: T[], scope: RecipeScope): Promise<T[]> {
  const keep = await Promise.all(rows.map((r) => recipeInScope(r, scope)))
  return rows.filter((_, i) => keep[i])
}

/** What a write route knows about the recipe it acts on. */
interface OwnedRecipe {
  id: string
  kind: string
  status: string
  /** A plate's brand company, or a modifier recipe's (modifier → … → brand); null for a component. */
  ownerTenantId: string | null
  /** A plate's brand vessel ('plate' | 'packaging'); null for components and modifier recipes. */
  serviceVessel: string | null
  /** The recipe's current lines — an untouched one is never re-validated (legacy rows). */
  lines: ExistingLine[]
}

/**
 * Resolve a recipe the operator may act on, or 404. Returns the recipe's
 * kind and — for a plate or modifier recipe — the company of its brand (null
 * for a component), so callers can check that stations and ingredients
 * belong to it. Reads were already scoped; the write handlers looked recipes
 * up by bare id, so a manager at one company could edit, approve, reject or
 * delete another company's recipes — and approving one overwrites the live
 * menu price of that company's item.
 */
async function assertRecipeInScope(
  req: FastifyRequest,
  recipeId: string,
  notFound: () => Error = () => new NotFoundError('Recipe', recipeId),
): Promise<OwnedRecipe> {
  const r = await loadRecipeForOwner(recipeId)
  if (!r) throw notFound()
  // 'write': editing an existing row is allowed for any company the operator
  // belongs to, independent of which one the portfolio header is viewing.
  if (!(await recipeInScope(r, await recipeScope(req, 'write')))) throw notFound()
  return ownedOf(r)
}

/** The recipe with what OwnedRecipe needs — no scope check (callers prove the right first). */
async function loadRecipeForOwner(recipeId: string) {
  return prisma.recipe.findUnique({
    where: { id: recipeId },
    select: {
      id: true, kind: true, status: true, pendingMenuItem: true,
      menuItem: { select: { conceptId: true, concept: { select: { tenantId: true, serviceVessel: true } } } },
      modifier: MODIFIER_BRAND,
      ingredients: { select: { inventoryItemId: true, prepRecipeId: true, section: true } },
    },
  })
}

async function ownedOf(r: NonNullable<Awaited<ReturnType<typeof loadRecipeForOwner>>>): Promise<OwnedRecipe> {
  let ownerTenantId: string | null = null
  let serviceVessel: string | null = null
  if (r.kind === 'plate') {
    const pendingCid = (r.pendingMenuItem as { conceptId?: string } | null)?.conceptId
    const concept = r.menuItem?.concept
      ?? (pendingCid ? await prisma.concept.findUnique({ where: { id: pendingCid }, select: { tenantId: true, serviceVessel: true } }) : null)
    ownerTenantId = concept?.tenantId ?? null
    serviceVessel = concept?.serviceVessel ?? null
  } else if (r.kind === 'modifier') {
    ownerTenantId = r.modifier?.group.menuItem.concept.tenantId ?? null
  }
  return { id: r.id, kind: r.kind, status: r.status, ownerTenantId, serviceVessel, lines: r.ingredients }
}

// ─── Head office (D1/D3, spec §6.4 + A6, A21) ────────────────────────────────
//
// A recipe has no tenantId: its companies are derived (a plate's / add-on's
// brand company; a component's users and stock). Through a head-office lens a
// caller may only PROPOSE: create (bound to the lens company), edit and log
// test cooks on a recipe THEY created while it is in iteration, and submit.
// Every editor is remembered (createdById, editedByIds), so a recipe any
// head-office person touched goes to the CEO (or the Operations hand-over),
// never to a company owner. With no head office none of this changes anything.

const RECIPE_TYPE: ApprovalType = 'recipe'

/** The recipe's companies for the lens check (no-company markers left out). */
async function recipeTenantSet(owned: Pick<OwnedRecipe, 'id' | 'kind' | 'ownerTenantId'>): Promise<string[]> {
  if (owned.ownerTenantId) return [owned.ownerTenantId]
  if (owned.kind !== 'component') return []
  return [...(await loadComponentCompanies())(owned.id)].filter((t) => t !== NO_COMPANY)
}

/** The first of the recipe's companies the caller sees only through a head office, or null. */
async function lensCompanyOf(req: FastifyRequest, owned: Pick<OwnedRecipe, 'id' | 'kind' | 'ownerTenantId'>): Promise<string | null> {
  if ((req.staffUser?.reachTenantIds ?? []).length === 0) return null
  return (await recipeTenantSet(owned)).find((t) => isReachOnly(req, t)) ?? null
}

/** Append the caller to the recipe's editors (A6) — inside the write's own transaction. */
async function noteEditor(tx: Prisma.TransactionClient, recipeId: string, userId: string): Promise<void> {
  const row = await tx.recipe.findUnique({ where: { id: recipeId }, select: { editedByIds: true } })
  if (!row || row.editedByIds.includes(userId)) return
  await tx.recipe.update({ where: { id: recipeId }, data: { editedByIds: { push: userId } } })
}

/**
 * The approve / reject / queue routes admit the type's role list (APPROVERS)
 * or a live hand-over of the type; anyone else gets exactly the 403 the old
 * requireAuth(...APPROVERS) gave.
 */
async function assertApproverRoleOrDelegate(req: FastifyRequest, type: ApprovalType): Promise<void> {
  const su = req.staffUser!
  if ((APPROVAL_RIGHTS[type].roles as readonly string[]).includes(su.role)) return
  if (((await delegatedTenantsByType(su.id)).get(type)?.size ?? 0) > 0) return
  throw new ForbiddenError(`Role '${su.role}' is not allowed for this resource`)
}

const OWN_WORK_MESSAGE = 'You submitted this — it needs the CEO to approve. Owners cannot approve their own work.'

/**
 * A5 + A21: the right to decide a recipe. Its companies / submitters come from
 * serviceClient (approvalSubject) BEFORE the right is proven; submitters are
 * createdById ∪ editedByIds ∪ submittedById. The owner rule keeps its own
 * message (and flag); a no-company recipe is CEO only; a 404 keeps the old
 * shape. The handler re-reads the row through `prisma` afterwards.
 */
async function recipeDecisionRight(req: FastifyRequest, recipeId: string, action: 'approve' | 'reject'): Promise<{ s: ApprovalSubject; grant: ApprovalGrant }> {
  await assertApproverRoleOrDelegate(req, RECIPE_TYPE)
  const s = await approvalSubject(RECIPE_TYPE, recipeId)
  if (!s) throw new NotFoundError('Recipe', recipeId)
  const input = approvalInputOf(RECIPE_TYPE, recipeId, s, { entity: 'Recipe', action })
  const d = await decideApproval(req, input)
  if (!d.ok && d.status === 404) throw new NotFoundError('Recipe', recipeId)
  if (s.status !== 'pending_approval') {
    throw new AppError('BAD_STATUS', action === 'approve'
      ? `Only recipes pending approval can be promoted (this one is ${s.status})`
      : `Only recipes pending approval can be rejected (this one is ${s.status})`, 409)
  }
  if (!d.ok && d.selfApproval) {
    // A co-owner cannot sign off their own (or their edited) work — it escalates to the CEO.
    await assertNotAmongSubmitters(req.staffUser!, s.submitterIds, { tenantId: s.ownerTenantId, action, entity: 'Recipe', entityId: recipeId, message: OWN_WORK_MESSAGE })
  }
  let grant: ApprovalGrant
  try {
    grant = await assertCanApprove(req, input)
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) throw new NotFoundError('Recipe', recipeId)
    throw err
  }
  return { s, grant }
}

/** A RecipeScope over an explicit set of companies (the approval queue's role part). */
async function recipeScopeFor(tenantIds: string[], mode: ScopeMode): Promise<RecipeScope> {
  const concepts = tenantIds.length === 0 ? [] : await prisma.concept.findMany({
    where: { deletedAt: null, tenantId: { in: tenantIds } },
    select: { id: true },
  })
  let index: Promise<ComponentCompanies> | null = null
  return {
    mode,
    conceptIds: new Set(concepts.map((c) => c.id)),
    tenantIds: new Set(tenantIds),
    components: () => (index ??= loadComponentCompanies()),
  }
}

/** True when `tenantId` is inside a scopeTenantWhere result. */
function whereHas(where: TenantIdWhere, tenantId: string): boolean {
  return typeof where.tenantId === 'string' ? where.tenantId === tenantId : where.tenantId.in.includes(tenantId)
}

/**
 * The modifier a new modifier recipe attaches to, resolved to its company
 * through modifier → group → menu item → brand. A modifier of a company the
 * operator does not belong to is 404; one of another of their companies than
 * the ACTIVE one ('create' binds to the active company) is 422
 * MODIFIER_NOT_IN_COMPANY.
 */
async function resolveModifierForCreate(req: FastifyRequest, modifierId: string): Promise<{ id: string; name: string; tenantId: string }> {
  const m = await prisma.modifier.findFirst({
    where: { id: modifierId, deletedAt: null, group: { deletedAt: null, menuItem: { deletedAt: null, concept: { deletedAt: null } } } },
    select: { id: true, name: true, group: { select: { name: true, menuItem: { select: { name: true, concept: { select: { tenantId: true } } } } } } },
  })
  const tenantId = m?.group.menuItem.concept.tenantId ?? null
  if (!m || !tenantId || !whereHas(await scopeTenantWhere(req, 'write'), tenantId)) throw new NotFoundError('Modifier', modifierId)
  if (!whereHas(await scopeTenantWhere(req, 'create'), tenantId)) {
    throw new AppError('MODIFIER_NOT_IN_COMPANY', 'That add-on belongs to another of your companies — switch to it first', 422)
  }
  return { id: m.id, name: `${m.group.menuItem.name} — ${m.name}`, tenantId }
}

/** One of a recipe's lines as stored (for "is this line new or changed?"). */
interface ExistingLine { inventoryItemId: string | null; prepRecipeId: string | null; section: string }

/** Who a recipe's lines must belong to (validateRecipeLines). */
interface LineOwner {
  kind: string
  /** Companies its stock may come from: a plate / modifier → its brand's company; a component → the companies allowed. */
  tenantIds: string[]
}

const lineKey = (l: { inventoryItemId?: string | null; prepRecipeId?: string | null; section?: string | null }) =>
  `${l.inventoryItemId ?? ''}|${l.prepRecipeId ?? ''}|${l.section ?? 'ingredients'}`

/**
 * THE line rules of a recipe (create, PUT and costing-preview call it):
 *   • a negative quantity ('removes') only on a modifier recipe → else 422 NEGATIVE_QTY_NOT_ALLOWED;
 *   • a Packaging section only on a plate → else 422 PACKAGING_ON_PLATES_ONLY
 *     (also a packaging-class item anywhere in a sub-recipe or modifier recipe);
 *   • a plate's packaging-class item only in Packaging → else 422 PACKAGING_SECTION_ONLY;
 *   • nothing else in Packaging (no food, drinks or sub-recipes) → else 422 NOT_PACKAGING;
 *   • a stock item of the recipe's company → else 422 ITEM_NOT_IN_COMPANY, or
 *     422 ITEM_HAS_NO_COMPANY for company-less stock (a sale never consumes it);
 *   • a sub-recipe the operator can see → else 422 INGREDIENT_NOT_IN_COMPANY.
 * Only NEW or CHANGED lines are refused: a line already on the recipe (same
 * item or sub-recipe, same section — e.g. a packaging item the wave-B
 * backfill left in a sub-recipe's ingredients) passes with a warning, so a
 * save is never refused because of a line the user did not touch. Returns
 * those warnings (codes).
 */
async function validateRecipeLines(
  req: FastifyRequest,
  owner: LineOwner,
  lines: Array<Pick<IngredientInput, 'inventoryItemId' | 'prepRecipeId' | 'quantity' | 'section'>>,
  existing: ExistingLine[] = [],
): Promise<string[]> {
  const warnings = new Set<string>()
  const untouched = new Set(existing.map(lineKey))
  const isPlate = owner.kind === 'plate'
  const itemIds = [...new Set(lines.map((l) => l.inventoryItemId).filter((x): x is string => !!x))]
  const items = new Map((itemIds.length
    ? await prisma.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, tenantId: true, category: true, deletedAt: true } })
    : []).map((i) => [i.id, i]))
  const allowed = new Set(owner.tenantIds)
  for (const l of lines) {
    const section = l.section ?? 'ingredients'
    if (l.quantity < 0 && owner.kind !== 'modifier') {
      throw new AppError('NEGATIVE_QTY_NOT_ALLOWED', 'Only an add-on (modifier) recipe can remove an ingredient — use a positive quantity', 422)
    }
    const legacy = untouched.has(lineKey(l))
    const refuse = (code: string, message: string) => {
      if (legacy) { warnings.add(code); return }
      throw new AppError(code, message, 422)
    }
    if (section === 'packaging' && !isPlate) {
      refuse('PACKAGING_ON_PLATES_ONLY', 'Only a dish (plate recipe) has a Packaging section — sub-recipes and add-ons do not')
      continue
    }
    if (l.prepRecipeId) {
      if (section === 'packaging') refuse('NOT_PACKAGING', 'A sub-recipe is not packaging — put it under Ingredients')
      continue
    }
    const item = l.inventoryItemId ? items.get(l.inventoryItemId) : undefined
    if (!item) throw new AppError('ITEM_NOT_IN_COMPANY', 'That stock item is not part of this recipe\'s company', 422)
    if (item.deletedAt) {
      // Parked in the Trash (Sourcing sheet clean-up) — restore it from the Trash first.
      refuse('ITEM_IN_TRASH', `${item.name} is in the Trash — restore it from the Trash before using it in a recipe`)
      continue
    }
    if (item.tenantId == null) {
      refuse('ITEM_HAS_NO_COMPANY', `${item.name} belongs to no company — a sale never uses it. Pick this company's own stock item.`)
    } else if (!allowed.has(item.tenantId)) {
      refuse('ITEM_NOT_IN_COMPANY', `${item.name} is another company's stock — pick this company's own item`)
    }
    const isPackagingItem = costClassOf(item.category) === 'packaging'
    if (isPackagingItem && !isPlate) {
      refuse('PACKAGING_ON_PLATES_ONLY', `${item.name} is packaging — packaging goes only in a dish's Packaging section, never in a ${owner.kind === 'modifier' ? 'add-on' : 'sub-recipe'}`)
    } else if (isPackagingItem && section !== 'packaging') {
      refuse('PACKAGING_SECTION_ONLY', `${item.name} is packaging — move it to the Packaging section`)
    } else if (!isPackagingItem && section === 'packaging') {
      refuse('NOT_PACKAGING', `${item.name} is not a packaging item — put it under Ingredients`)
    }
  }
  const subIds = [...new Set(lines.filter((l) => !untouched.has(lineKey(l))).map((l) => l.prepRecipeId).filter((x): x is string => !!x))]
  if (subIds.length) {
    const subs = await prisma.recipe.findMany({
      where: { id: { in: subIds }, kind: 'component' },
      select: { id: true, kind: true },
    })
    const scope = await recipeScope(req, 'read')
    if (subs.length !== subIds.length || (await filterInScope(subs, scope)).length !== subIds.length) {
      throw new AppError('INGREDIENT_NOT_IN_COMPANY', 'One or more sub-recipes are not available to this company', 422)
    }
    // A sub-recipe already used by, or made from the stock of, a company this
    // recipe does not belong to would put that company's stock into this
    // company's dish — a sale skips foreign stock, so its cost would be
    // missing and the other company's lots would never move (stock-01).
    const comps = await scope.components()
    for (const sub of subs) {
      const others = [...comps(sub.id), ...comps.drawsOn(sub.id)].filter((t) => t !== NO_COMPANY && !allowed.has(t))
      if (others.length > 0) {
        throw new AppError('INGREDIENT_NOT_IN_COMPANY', 'That sub-recipe belongs to another company — use one of this company\'s own', 422)
      }
    }
  }
  return [...warnings]
}

/** Save-time warning codes: the line warnings plus PACKAGING_MISSING (never a block). */
function saveWarnings(
  lineWarnings: string[], kind: string, serviceVessel: string | null | undefined,
  lines: Array<{ section?: string | null }>,
): string[] {
  const out = [...lineWarnings]
  if (kind === 'plate' && serviceVessel === 'packaging' && !lines.some((l) => l.section === 'packaging')) out.push('PACKAGING_MISSING')
  return out
}

/** 422 unless `stationId` is a live station of one of `tenantIds`. */
async function assertStationIn(stationId: string, tenantIds: string[]): Promise<void> {
  const st = await prisma.station.findFirst({
    where: { id: stationId, deletedAt: null, concept: { tenantId: { in: tenantIds }, deletedAt: null } },
    select: { id: true, name: true, isActive: true },
  })
  if (!st) throw new AppError('STATION_NOT_IN_COMPANY', 'That station is not part of this recipe\'s company', 422)
  // A switched-off station shows no screen: a step routed there reaches nobody.
  if (!st.isActive) throw new AppError('STATION_NOT_LIVE', `${st.name} is switched off — pick a live station`, 422)
}

/**
 * Companies a recipe's stations and stock lines may come from. A dish or an
 * add-on: its brand's company. A component (sub-recipe): the companies of the
 * dishes and add-ons that use it (walking up nested sub-recipes) — never the
 * operator's whole write scope, which let a manager of two companies put
 * company B's cheese into a sub-recipe only A's dishes use (stock-01). A
 * component nothing uses yet — and a new one (`owned` null) — binds to the
 * ACTIVE company, as create does (422 NO_ACTIVE_COMPANY without one).
 */
async function recipeCompanies(req: FastifyRequest, owned: Pick<OwnedRecipe, 'id' | 'kind' | 'ownerTenantId'> | null): Promise<string[]> {
  if (owned?.ownerTenantId) return [owned.ownerTenantId]
  if (owned?.kind === 'component') {
    const users = [...(await loadComponentCompanies()).users(owned.id)]
    if (users.length > 0) return users
  }
  const active = req.staffUser?.tenantId
  if (!active) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
  return [active]
}

// ─── Material cost readout (wave B) ───────────────────────────────────────────
//
// Every number comes from lib/recipeCost.ts (RecipeCost) — PER PORTION, in
// whole paisa:
//   stockByClass   food / drinks (beverage) / packaging the dish can consume, ex-Q
//   packagingCents the dish's Packaging section alone
//   standardCents  the plate MC = food + drinks (what every sale of it uses)
//   targetMcCents  plate MC + packaging where it applies to that order type for
//                  the brand's vessel (takeaway / delivery always; dine-in only
//                  at a 'packaging' brand — a dine-in "Box given" is an actual)
//   qCents         the Q factor allowance (this recipe's and its sub-recipes'):
//                  pricing only, never stock, never posted, never inside MC

interface McReadout {
  stockByClass:   { food: number; beverage: number; packaging: number }
  packagingCents: number
  standardCents:  number
  qCents:         number
  targetMcCents:  { dine_in: number; takeout: number; delivery: number }
}

function mcReadout(cost: RecipeCost): McReadout {
  const standardCents = Math.round(cost.standardCents)
  const packagingCents = Math.round(cost.packagingCents)
  // Whether the packaging applies to an order type is the library's rule
  // (targetMcCents) — read it, never restate it.
  const applies = (t: number) => t - cost.standardCents > 1e-9
  return {
    stockByClass: {
      food:      Math.round(cost.stockByClass.food),
      beverage:  Math.round(cost.stockByClass.beverage),
      packaging: Math.round(cost.stockByClass.packaging),
    },
    packagingCents,
    standardCents,
    qCents: Math.max(0, Math.round(cost.perPortionCents - cost.standardCents - cost.packagingCents)),
    targetMcCents: {
      dine_in:  standardCents + (applies(cost.targetMcCents.dine_in) ? packagingCents : 0),
      takeout:  standardCents + (applies(cost.targetMcCents.takeout) ? packagingCents : 0),
      delivery: standardCents + (applies(cost.targetMcCents.delivery) ? packagingCents : 0),
    },
  }
}

export interface RecipeCostWarnings {
  /** Stock lines (any depth) of another company, or of none — a sale never consumes them. */
  outsideCompany: Array<{ lineId: string; itemName: string; recipeId: string; reason: 'foreign' | 'company_less' }>
  /** Not approved (status ≠ production) yet a live dish / add-on is costed and depleted from it. */
  costedWhileUnapproved: boolean
  /** A plate of a PACKAGING-vessel brand with no Packaging line (never for plate brands). */
  noPackaging: boolean
}

/** Stock lines (any depth below `rootId`) whose item is not of `owners`. */
function linesOutside(graph: RecipeGraph, rootId: string, owners: Set<string>): Array<{ lineId: string; itemId: string; recipeId: string; reason: 'foreign' | 'company_less' }> {
  const out: Array<{ lineId: string; itemId: string; recipeId: string; reason: 'foreign' | 'company_less' }> = []
  const seen = new Set<string>()
  const walk = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    const r = graph.get(id)
    if (!r) return
    for (const l of r.ingredients) {
      if (l.prepRecipeId) { walk(l.prepRecipeId); continue }
      const t = l.inventoryItem?.tenantId
      if (!l.inventoryItemId || !l.inventoryItem || t === undefined) continue
      if (t == null) out.push({ lineId: l.id ?? '', itemId: l.inventoryItemId, recipeId: r.id, reason: 'company_less' })
      else if (!owners.has(t)) out.push({ lineId: l.id ?? '', itemId: l.inventoryItemId, recipeId: r.id, reason: 'foreign' })
    }
  }
  walk(rootId)
  return out
}

/** Item names for the outsideCompany warnings, one query. */
async function itemNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await prisma.inventoryItem.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } })
  return new Map(rows.map((r) => [r.id, r.name]))
}

/**
 * The costing warnings of one recipe. `owners` = the companies its stock
 * must be (null = no derivable owner: a sub-recipe nothing uses yet — no
 * outsideCompany check); `live` = it costs a live dish / add-on today.
 */
function costWarnings(
  graph: RecipeGraph, rootId: string,
  o: { owners: Set<string> | null; kind: string; status: string; live: boolean; serviceVessel: string | null | undefined },
  names: Map<string, string>,
): RecipeCostWarnings {
  const root = graph.get(rootId)
  return {
    outsideCompany: o.owners
      ? linesOutside(graph, rootId, o.owners).map((x) => ({ lineId: x.lineId, itemName: names.get(x.itemId) ?? '—', recipeId: x.recipeId, reason: x.reason }))
      : [],
    costedWhileUnapproved: o.live && o.status !== 'production',
    noPackaging: o.kind === 'plate' && o.serviceVessel === 'packaging' && !(root?.ingredients ?? []).some((l) => l.section === 'packaging'),
  }
}

/** What the costing warnings need about a recipe's owner, vessel and liveness. */
const LIVE_ITEM = { select: { conceptId: true, deletedAt: true, isAvailable: true, concept: { select: { tenantId: true, serviceVessel: true } } } } as const
const RECIPE_OWNER_SELECT = {
  id: true, kind: true, status: true, pendingMenuItem: true,
  menuItem: LIVE_ITEM,
  modifier: { select: { name: true, deletedAt: true, group: { select: { name: true, deletedAt: true, menuItem: { select: { ...LIVE_ITEM.select, name: true } } } } } },
} satisfies Prisma.RecipeSelect
type OwnerRow = Prisma.RecipeGetPayload<{ select: typeof RECIPE_OWNER_SELECT }>

interface OwnerContext {
  /** Companies its stock must be; null = no derivable owner (a sub-recipe nothing uses yet). */
  owners: Set<string> | null
  /** A plate's brand vessel; null otherwise. */
  serviceVessel: string | null
  /** A sale costs and depletes from it today (see recipeIsLive). */
  live: boolean
}

/** Owner, vessel and liveness of each recipe — one extra query for testing plates' pending brands. */
async function ownerContexts(rows: OwnerRow[], scope: RecipeScope): Promise<Map<string, OwnerContext>> {
  const pendingIds = rows
    .map((r) => (!r.menuItem ? (r.pendingMenuItem as { conceptId?: string } | null)?.conceptId : undefined))
    .filter((x): x is string => !!x)
  const pending = new Map(pendingIds.length
    ? (await prisma.concept.findMany({ where: { id: { in: [...new Set(pendingIds)] } }, select: { id: true, tenantId: true, serviceVessel: true } })).map((c) => [c.id, c])
    : [])
  const out = new Map<string, OwnerContext>()
  for (const r of rows) {
    if (r.kind === 'component') {
      const companies = [...(await scope.components())(r.id)].filter((t) => t !== NO_COMPANY)
      out.set(r.id, { owners: companies.length ? new Set(companies) : null, serviceVessel: null, live: false })
    } else if (r.kind === 'modifier') {
      const m = r.modifier
      const item = m?.group.menuItem
      out.set(r.id, {
        owners: new Set(item?.concept.tenantId ? [item.concept.tenantId] : []),
        serviceVessel: null,
        live: !!m && !m.deletedAt && !m.group.deletedAt && !!item && !item.deletedAt && item.isAvailable,
      })
    } else {
      const cid = (r.pendingMenuItem as { conceptId?: string } | null)?.conceptId
      const concept = r.menuItem?.concept ?? (cid ? pending.get(cid) : undefined)
      out.set(r.id, {
        owners: new Set(concept?.tenantId ? [concept.tenantId] : []),
        serviceVessel: concept?.serviceVessel ?? null,
        live: !!r.menuItem && !r.menuItem.deletedAt && r.menuItem.isAvailable,
      })
    }
  }
  return out
}

/**
 * True when a sale costs and depletes from this recipe today: a plate linked
 * to a menu item that is on sale (not deleted, available), or a modifier
 * recipe whose add-on, group and dish are all live. Sales read the recipe
 * whatever its status — so an unapproved one is flagged costedWhileUnapproved.
 */
async function recipeIsLive(recipeId: string): Promise<boolean> {
  const n = await prisma.recipe.count({
    where: {
      id: recipeId,
      OR: [
        { menuItem: { deletedAt: null, isAvailable: true } },
        { modifier: { deletedAt: null, group: { deletedAt: null, menuItem: { deletedAt: null, isAvailable: true } } } },
      ],
    },
  })
  return n > 0
}

// ─── Who reads what here (wave 3, audit UI-10 / UI-07) ───────────────────────
//
// The sidebar and the API agree (lib/moduleAccess.ts defaults):
//   • boh (line cook, holds `recipes`) READS the recipe book — the list and a
//     recipe's detail — with every cost, margin and supplier price taken out
//     (costsHidden; same rule as the KDS card). It does not create, edit,
//     submit, delete, approve or cost recipes, and opens no costing page.
//   • finance (holds `accounting`) reads the recipe list and the food-cost
//     analysis behind Finance → Food cost, with costs: it is a cost viewer.
//     It edits nothing here.
// Writes, the pricing readout (/:id/costing, /costing-preview) and the test
// log stay with managers; approval stays with APPROVERS.
const RECIPE_LIST_READERS = [...FINANCE_TEAM, 'boh'] as UserRole[]
const RECIPE_DETAIL_READERS = [...MANAGERS, 'boh'] as UserRole[]

// A recipe's pricing inputs — what it should earn and sell for. A kitchen floor
// role reads none of them, on the recipe itself or on any sub-recipe it uses.
const RECIPE_PRICING_NULLED = {
  qFactorPct:              null,
  targetProfitPct:         null,
  targetFoodCostPct:       null,
  packagingPct:            null,
  actualSellingPriceCents: null,
} as const

/** A GET /recipes row for a kitchen floor role: the method and quantities, no money. */
function recipeRowWithoutCosts<R extends { ingredients: Array<Record<string, unknown>> }>(r: R) {
  return {
    ...r,
    ingredients: r.ingredients.map((ing) => {
      const inv = ing.inventoryItem as Record<string, unknown> | null | undefined
      const prep = ing.prepRecipe as { ingredients?: Array<Record<string, unknown>> } & Record<string, unknown> | null | undefined
      return {
        ...ing,
        inventoryItem: inv ? { ...inv, unitCostCents: null } : inv ?? null,
        prepRecipe: prep
          ? {
              ...prep,
              ...RECIPE_PRICING_NULLED,
              ingredients: (prep.ingredients ?? []).map((pi) => {
                const pinv = pi.inventoryItem as Record<string, unknown> | null | undefined
                return { ...pi, inventoryItem: pinv ? { ...pinv, unitCostCents: null } : pinv ?? null }
              }),
            }
          : prep ?? null,
        costPerUnit: null,
        ingredientCostCents: null,
      }
    }),
    ingredientCostCents: null,
    qFactorCents:        null,
    laborCostCents:      null,
    totalCostCents:      null,
    costPerPortionCents: null,
    grossMarginPct:      null,
    foodCostPct:         null,
    costPerGramCents:    null,
    batchCostCents:      null,
    mc:                  null,
    ...RECIPE_PRICING_NULLED,
    costsHidden:         true as const,
  }
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
    { preHandler: requireAuth(...RECIPE_LIST_READERS) },
    async (req) => {
      const { conceptId, q, activeOnly } = req.query
      let { season } = req.query
      if (season === 'current') season = currentSeasonsForDate(new Date())[0]

      // Company scoping: resolve the concepts visible to this request up
      // front. An explicitly requested conceptId outside the scope returns
      // nothing rather than leaking another company's recipes.
      const scope = await recipeScope(req, 'read')
      if (conceptId && !scope.conceptIds.has(conceptId)) return []

      // Each filter is its own AND term (two ORs spread into one object
      // used to overwrite each other: ?season&q dropped the season filter).
      const and: Prisma.RecipeWhereInput[] = []
      // A brand's recipes: its dishes and its add-ons (modifier recipes).
      if (conceptId) and.push({ OR: [{ menuItem: { conceptId } }, { modifier: { group: { menuItem: { conceptId } } } }] })
      if (activeOnly === 'true') and.push({ isActive: true })
      // Season filter: include the requested season OR explicit "year-round" OR
      // empty seasons array (which we treat as year-round).
      if (season) {
        and.push({ OR: [{ seasons: { has: season } }, { seasons: { has: 'year-round' } }, { seasons: { isEmpty: true } }] })
      }
      if (q) {
        and.push({
          OR: [
            { menuItem: { name: { contains: q, mode: 'insensitive' } } },
            { name: { contains: q, mode: 'insensitive' } },
            { notes: { contains: q, mode: 'insensitive' } },
          ],
        })
      }
      const fetched = await prisma.recipe.findMany({
        where: { AND: and },
        include: {
          menuItem: {
            select: {
              id: true, name: true, priceCents: true, conceptId: true, deletedAt: true, isAvailable: true,
              concept: {
                select: {
                  name: true, tenantId: true, serviceVessel: true,
                  tenant: { select: { id: true, name: true, slug: true } },
                },
              },
            },
          },
          // kind 'modifier': the add-on, its group and dish (brand + company).
          modifier: RECIPE_OWNER_SELECT.modifier,
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

      // Post-filter to the visible companies (testing plates match via
      // pendingMenuItem; components via the companies that use them).
      const recipes = await filterInScope(fetched, scope)

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

      // THE plate cost (lib/recipeCost.ts) for every listed recipe, sub-recipes
      // at any depth, one memo so shared sub-recipes are costed once.
      const { graph } = await loadRecipeGraph({ id: { in: recipes.map((r) => r.id) } })
      const memo = new Map<string, RecipeCost>()
      const hideCosts = costsHiddenFor(req)
      // Warnings per row (outside company / costed while unapproved / no
      // packaging at a packaging brand) — the 'No packaging' badge and filter.
      const contexts = await ownerContexts(recipes, scope)
      const names = await itemNames(recipes.flatMap((r) => {
        const owners = contexts.get(r.id)?.owners
        return owners ? linesOutside(graph, r.id, owners).map((x) => x.itemId) : []
      }))

      const rows = recipes.map((r) => {
        const cost = recipeCost(graph, r.id, memo)
        const byLine = linesById(cost)
        const ingDetails = r.ingredients.map((ing) => {
          const line = byLine.get(ing.id)
          return {
            ...ing,
            // Raw lines: purchase units drawn per batch after yield (kg / L /
            // pcs — what you actually buy). Sub-recipes: grams used.
            purchaseQty:         ing.prepRecipeId ? ing.quantity : (line?.purchaseQty ?? 0),
            // Per g / ml / piece for raw lines; per gram for sub-recipes.
            costPerUnit:         line?.costPerMeasureCents ?? 0,
            ingredientCostCents: Math.round(line?.costCents ?? 0),
          }
        })

        const ingredientCostCents = Math.round(cost.ingredientCents)
        const qFactorCents        = Math.round(cost.qCents)
        // No kitchen labour in plate cost (owner decision 26). Kept at 0 for
        // clients that still render the row.
        const laborCostCents      = 0
        const totalCostCents      = Math.round(cost.totalCents)

        // Per-kind headline numbers.
        //   plate     → plate cost (total ÷ servings) + margin vs. menu price.
        //   modifier  → cost of one unit of the add-on (no margin here).
        //   component → cost per gram (total ÷ yieldGrams) + cost per batch.
        // We keep both fields populated where they make sense so the frontend
        // can read whichever it needs without conditional branching.
        const costPerPortionCents = (r.kind === 'plate' || r.kind === 'modifier') && r.servings > 0
          ? Math.round(cost.perPortionCents)
          : null
        const costPerGramCents = r.kind === 'component'
          ? cost.perGramCents                                      // sub-cent precision — fractions matter at gram scale
          : null
        const priceCents     = r.menuItem?.priceCents ?? null
        const grossMarginPct = (priceCents && priceCents > 0 && costPerPortionCents !== null)
          ? Math.round(((priceCents - costPerPortionCents) / priceCents) * 100)
          : null
        const foodCostPct    = (priceCents && priceCents > 0 && costPerPortionCents !== null)
          ? Math.round((costPerPortionCents / priceCents) * 100)
          : null

        const ctx = contexts.get(r.id)!
        return {
          ...r,
          ingredients: ingDetails,
          serviceVessel: ctx.serviceVessel,
          // Material cost per portion (food / drinks / packaging, target MC per order type, Q apart).
          mc: mcReadout(cost),
          warnings: costWarnings(graph, r.id, { owners: ctx.owners, kind: r.kind, status: r.status, live: ctx.live, serviceVessel: ctx.serviceVessel }, names),
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
      return hideCosts ? rows.map(recipeRowWithoutCosts) : rows
    },
  )

  // POST /recipes/costing-preview — cost an UNSAVED recipe with the same
  // function as everything else, so the recipe form's live preview stops
  // carrying its own copy of the maths (it divided count items by yield on a
  // 0–100 scale and skipped nothing else the server did — close, but a copy).
  // Nothing is written.
  //
  // Lines go through THE line rules (validateRecipeLines) for the recipe's
  // company, which the preview derives from (first match): `recipeId` (an
  // existing recipe in write scope — its untouched lines pass as on save),
  // `menuItemId`, `conceptId`, `modifierId`, else the operator's companies
  // (a sub-recipe). Lines with no item picked yet, or quantity 0, are costed
  // as nothing and never refused (the form previews while typing).
  const previewSchema = z.object({
    kind:       z.enum(['plate', 'component', 'modifier']).default('plate'),
    recipeId:   z.string().uuid().optional(),
    menuItemId: z.string().uuid().optional(),
    conceptId:  z.string().uuid().optional(),
    modifierId: z.string().uuid().optional(),
    servings:   z.number().int().min(1).default(1),
    yieldGrams: z.number().positive().nullable().optional(),
    qFactorPct: z.number().min(0).max(100).default(10),
    ingredients: z.array(z.object({
      inventoryItemId: z.string().uuid().optional(),
      prepRecipeId:    z.string().uuid().optional(),
      quantity:        z.number().finite(),
      yieldPct:        z.number().min(0.01).max(1).default(1),
      section:         z.enum(['ingredients', 'packaging']).default('ingredients'),
    })).max(200),
  })
  fastify.post('/costing-preview', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = previewSchema.parse(req.body)

    // The recipe's company (and a plate's brand vessel).
    let owners: string[]
    let serviceVessel: string | null = null
    let existing: ExistingLine[] = []
    let live = false
    let status = 'iteration'
    if (body.recipeId) {
      const owned = await assertRecipeInScope(req, body.recipeId)
      owners = await recipeCompanies(req, owned)
      serviceVessel = owned.serviceVessel
      existing = owned.lines
      status = owned.status
      live = await recipeIsLive(owned.id)
    } else if (body.kind === 'plate' && (body.menuItemId || body.conceptId)) {
      const concept = body.menuItemId
        ? (await prisma.menuItem.findFirst({
            where: { id: body.menuItemId, deletedAt: null, concept: { ...(await scopeTenantWhere(req, 'write')), deletedAt: null } },
            select: { concept: { select: { tenantId: true, serviceVessel: true } } },
          }))?.concept
        : await prisma.concept.findFirst({
            where: { id: body.conceptId, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
            select: { tenantId: true, serviceVessel: true },
          })
      if (!concept?.tenantId) throw new NotFoundError(body.menuItemId ? 'MenuItem' : 'Concept', (body.menuItemId ?? body.conceptId)!)
      owners = [concept.tenantId]
      serviceVessel = concept.serviceVessel
    } else if (body.kind === 'modifier' && body.modifierId) {
      owners = [(await resolveModifierForCreate(req, body.modifierId)).tenantId]
    } else {
      owners = await recipeCompanies(req, null)
    }
    const kind = body.kind
    const picked = body.ingredients.filter((i) => (i.inventoryItemId || i.prepRecipeId) && i.quantity !== 0)
    const lineWarnings = await validateRecipeLines(req, { kind, tenantIds: owners }, picked, existing)

    const itemIds = picked.map((i) => i.inventoryItemId).filter((x): x is string => !!x)
    const subIds  = picked.map((i) => i.prepRecipeId).filter((x): x is string => !!x)
    const [items, { graph }] = await Promise.all([
      prisma.inventoryItem.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, unit: true, unitCostCents: true, tenantId: true, category: true },
      }),
      loadRecipeGraph({ id: { in: subIds }, kind: 'component' }),
    ])
    const itemById = new Map(items.map((i) => [i.id, i]))
    const PREVIEW = '__preview__'
    const draft: CostRecipe = {
      id: PREVIEW, kind, servings: body.servings,
      yieldGrams: body.yieldGrams ?? null, qFactorPct: body.qFactorPct,
      serviceVessel,
      ingredients: body.ingredients.map((i, idx) => {
        const counted = (i.inventoryItemId || i.prepRecipeId) && i.quantity !== 0
        return {
          id: String(idx),
          inventoryItemId: counted ? (i.inventoryItemId ?? null) : null,
          prepRecipeId: counted && i.prepRecipeId && graph.has(i.prepRecipeId) ? i.prepRecipeId : null,
          quantity: i.quantity,
          yieldPct: i.prepRecipeId ? 1 : i.yieldPct,
          section: i.section,
          inventoryItem: counted && i.inventoryItemId ? (itemById.get(i.inventoryItemId) ?? null) : null,
        }
      }),
    }
    const previewGraph = buildRecipeGraph([draft, ...graph.values()])
    const cost = recipeCost(previewGraph, PREVIEW)
    const outside = linesOutside(previewGraph, PREVIEW, new Set(owners))
    const names = await itemNames(outside.map((o) => o.itemId))
    return {
      lines: cost.lines.map((l) => ({
        index: Number(l.ingredientId),
        purchaseQty: l.purchaseQty,
        costPerMeasureCents: l.costPerMeasureCents,
        costCents: Math.round(l.costCents),
        section: draft.ingredients[Number(l.ingredientId)]?.section ?? 'ingredients',
      })),
      ingredientCents: Math.round(cost.ingredientCents),
      qFactorCents:    Math.round(cost.qCents),
      totalCents:      Math.round(cost.totalCents),
      // The plate MC (food + drinks) — Q and packaging are shown apart.
      plateCostCents:  Math.round(cost.standardCents),
      perPortionCents: Math.round(cost.perPortionCents),
      costPerGramCents: cost.perGramCents,
      serviceVessel,
      ...mcReadout(cost),
      warnings: costWarnings(previewGraph, PREVIEW, { owners: new Set(owners), kind, status, live, serviceVessel }, names),
      lineWarnings: saveWarnings(lineWarnings, kind, serviceVessel, picked),
    }
  })

  // GET /recipes/pending-approval — CEO/owner inbox. Recipes a manager has
  // submitted for promotion and that are waiting on sign-off. Defined before
  // GET /:id so the static segment isn't swallowed by the param route.
  fastify.get('/pending-approval', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    // Who may list (D3, spec §7.4.5): the approver roles (APPROVERS), over the
    // companies in view that they belong to — an approver at one company must
    // not see (or learn the existence of) another company's pending recipes —
    // plus, for a live Operations hand-over, the recipes it lets them decide
    // (never their own, never one that came through another head office).
    // A non-admin approver no longer sees a recipe a head-office person
    // created, edited or submitted: that one goes to the CEO.
    await assertApproverRoleOrDelegate(req, RECIPE_TYPE)
    const su = req.staffUser!
    // Widens RLS to the companies a live hand-over covers (A5), before any read.
    await approvalQueueTenantIds(req, RECIPE_TYPE)
    const pending = await prisma.recipe.findMany({
      where: { status: 'pending_approval' },
      include: {
        menuItem: { select: { name: true, conceptId: true, concept: { select: { name: true } } } },
        modifier: { select: { group: { select: { menuItem: { select: { conceptId: true, concept: { select: { name: true } } } } } } } },
      },
      orderBy: { submittedAt: 'asc' },
    })
    const roleAllows = (APPROVAL_RIGHTS[RECIPE_TYPE].roles as readonly string[]).includes(su.role)
    let roleRows: typeof pending = []
    if (roleAllows) {
      const members = new Set(su.memberTenantIds ?? [])
      const roleIds = (await resolveTenantScope(req)).tenantIds.filter((t) => members.has(t))
      roleRows = await filterInScope(pending, await recipeScopeFor(roleIds, 'read'))
      if (su.role !== 'admin' && roleRows.length > 0) {
        let subjects = await Promise.all(roleRows.map((r) => approvalSubject(RECIPE_TYPE, r.id)))
        // A21: a recipe with no company of its own (an unused, line-less
        // sub-recipe) is the CEO's — it sits in no listed company, so a
        // non-admin approver must not see a row whose buttons would 403.
        const owned = subjects.map((x) => (x?.companyIds.length ?? 0) > 0)
        roleRows = roleRows.filter((_, i) => owned[i])
        subjects = subjects.filter((_, i) => owned[i])
        // Through head office (A3/A6): only when a head office is linked at all.
        if (roleRows.length > 0 && (await serviceClient.headOfficeLink.findFirst({ select: { id: true } }))) {
          const through = await throughHeadOfficeBatch(subjects.map((x) => ({
            tenantId: x?.ownerTenantId ?? null, submittedByIds: x?.submitterIds ?? [], submittedAt: x?.submittedAt ?? null, viaHeadOfficeId: x?.viaHeadOfficeId ?? null,
          })))
          roleRows = roleRows.filter((_, i) => (through[i] ?? []).length === 0 && !subjects[i]?.viaHeadOfficeId)
        }
      }
    }
    const listed = new Set(roleRows.map((r) => r.id))
    const delegated = (await delegatedTenantsByType(su.id)).get(RECIPE_TYPE)
    const extra = delegated && delegated.size > 0
      ? (await Promise.all(pending.filter((r) => !listed.has(r.id)).map(async (r) => {
          const subj = await approvalSubject(RECIPE_TYPE, r.id)
          return subj && (await canApprove(req, approvalInputOf(RECIPE_TYPE, r.id, subj))) ? r : null
        }))).filter((r): r is (typeof pending)[number] => r !== null)
      : []
    const keep = new Set([...listed, ...extra.map((r) => r.id)])
    return pending.filter((r) => keep.has(r.id)).map((r) => ({
      id:            r.id,
      kind:          r.kind,
      name:          r.menuItem?.name ?? r.name ?? '—',
      brand:         r.menuItem?.concept?.name ?? r.modifier?.group.menuItem.concept.name ?? null,
      submittedById: r.submittedById,
      submittedAt:   r.submittedAt,
    }))
  })

  // GET /recipes/:id
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...RECIPE_DETAIL_READERS) },
    async (req) => {
      const recipe = await prisma.recipe.findUnique({
        where: { id: req.params.id },
        include: {
          menuItem: { select: { id: true, name: true, priceCents: true, conceptId: true, concept: { select: { name: true, serviceVessel: true } } } },
          // kind 'modifier': the add-on, its group and dish (the form's pickers).
          modifier: { select: { id: true, name: true, groupId: true, group: { select: { name: true, menuItemId: true, menuItem: { select: { name: true, conceptId: true } } } } } },
          ingredients: {
            include: { inventoryItem: { select: { id: true, name: true, unit: true, unitCostCents: true, currentStock: true, category: true } } },
          },
        },
      })
      if (!recipe) throw new NotFoundError('Recipe', req.params.id)
      // Cross-company guard — 404 (not 403) so ids don't leak existence.
      if (!(await recipeInScope(recipe, await recipeScope(req)))) throw new NotFoundError('Recipe', req.params.id)
      if (!costsHiddenFor(req)) return recipe
      return {
        ...recipe,
        ingredients: recipe.ingredients.map((ing) => ({
          ...ing,
          inventoryItem: ing.inventoryItem ? { ...ing.inventoryItem, unitCostCents: null } : null,
        })),
        ...RECIPE_PRICING_NULLED,
        costsHidden: true as const,
      }
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
          menuItem: { select: { id: true, name: true, conceptId: true, priceCents: true, deletedAt: true, isAvailable: true, concept: { select: { id: true, name: true, tenantId: true, forecastPortionsPerMonth: true, serviceVessel: true } } } },
          modifier: RECIPE_OWNER_SELECT.modifier,
          ingredients: {
            include: {
              inventoryItem: { select: { id: true, name: true, unit: true, unitCostCents: true, yieldPct: true, allergens: true, category: true } },
              prepRecipe: { select: { id: true, name: true } },
            },
          },
        },
      })
      if (!recipe) throw new NotFoundError('Recipe', req.params.id)
      // Cross-company guard — 404 so ids don't leak existence.
      const scope = await recipeScope(req)
      if (!(await recipeInScope(recipe, scope))) throw new NotFoundError('Recipe', req.params.id)
      const ctx = (await ownerContexts([recipe], scope)).get(recipe.id)!

      // Sections 2 + 3 — THE plate cost (lib/recipeCost.ts): the number the
      // recipe list shows and the ledger books as COGS. Count items are
      // divided by yield like weighed ones (this handler used not to), and
      // sub-recipes carry their own Q, so the plate's Q covers its raw lines.
      const { graph } = await loadRecipeGraph({ id: recipe.id })
      const cost = recipeCost(graph, recipe.id)
      const mc = mcReadout(cost)
      const byLine = linesById(cost)
      const ingredients = recipe.ingredients.map((ri) => {
        const inv = ri.inventoryItem
        const line = byLine.get(ri.id)
        return {
          id:               ri.id,
          name:             inv?.name ?? ri.prepRecipe?.name ?? '—',
          unit:             ri.unit,
          quantity:         ri.quantity,
          // 'ingredients' | 'packaging' — the waterfall lists the packaging lines apart.
          section:          ri.section,
          costClass:        inv ? costClassOf(inv.category) : null,
          // Displayed yield as a percent (ri.yieldPct is stored as a fraction).
          yieldPct:         ri.yieldPct != null ? Math.round(ri.yieldPct * 100) : (inv?.yieldPct ?? 100),
          // Per g / ml / piece for raw lines; per gram for sub-recipes.
          costPerGramCents: line?.costPerMeasureCents ?? 0,
          ingredientCostCents: Math.round(line?.costCents ?? 0),
          allergens:        inv?.allergens ?? [],
        }
      })
      const names = await itemNames(ctx.owners ? linesOutside(graph, recipe.id, ctx.owners).map((x) => x.itemId) : [])
      const warnings = costWarnings(graph, recipe.id, { owners: ctx.owners, kind: recipe.kind, status: recipe.status, live: ctx.live, serviceVessel: ctx.serviceVessel }, names)

      const totalIngredientCents = Math.round(cost.ingredientCents)
      const qFactorCents         = Math.round(cost.qCents)
      const totalRecipeCents     = Math.round(cost.totalCents)
      // The plate MC (food + drinks, ex-Q) — packaging and Q are shown apart.
      const plateCostCents       = mc.standardCents

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
          const amt = toCents(l.amountCents)
          const monthly =
            l.cadence === 'monthly'   ? amt :
            l.cadence === 'quarterly' ? Math.round(amt / 3) :
            l.cadence === 'annual'    ? Math.round(amt / 12) :
            amt
          return s + monthly
        }, 0)

        if (tenantId) {
          const since = new Date(Date.now() - 90 * 24 * 3600 * 1000)
          // Locked HR payroll months in the last 90 days, averaged per month.
          const sincePeriod = since.toISOString().slice(0, 7)
          const hrRuns = await prisma.hrPayrollRun.findMany({ where: { tenantId, status: 'locked', period: { gte: sincePeriod } }, select: { totals: true } })
          const paid = hrRuns.reduce((s, r) => s + (((r.totals ?? {}) as { earningsCents?: number }).earningsCents ?? 0), 0)
          payrollTenantMonthlyCents = hrRuns.length ? Math.round(paid / hrRuns.length) : 0
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

      // Section 4 — pricing. The cost a price must cover is the brand's MAIN
      // order type's target MC (dine-in: the plate MC at a plate brand; plate
      // MC + packaging at a packaging brand, where every order type is the
      // same) plus the Q allowance (plate wear, garnish, oil — pricing only,
      // never stock, never posted). The old packaging % is retired: packaging
      // is the recipe's own Packaging lines.
      const targetProfitFactor = recipe.targetProfitPct / 100
      const mainMcCents = mc.targetMcCents.dine_in
      const pricedCostCents = mainMcCents + mc.qCents
      // Legacy: 30% food cost rule of thumb, opex not included
      const foodCostPriceCents = Math.round(pricedCostCents / 0.30)
      // Price that hits the operator's chosen target food-cost %:
      // price = cost ÷ (target% / 100).
      const targetFoodCostPct  = recipe.targetFoodCostPct ?? 30
      const fcTargetPriceCents = Math.round(pricedCostCents / Math.max(targetFoodCostPct / 100, 0.01))
      // Break-even: MC + Q + opex
      const breakEvenPriceCents = Math.round(pricedCostCents + opexPerPortionCents)
      // Target: (MC + Q + Opex) / (1 - TargetProfit%)
      const targetDenominator = Math.max(0.01, 1 - targetProfitFactor)
      const targetPriceCents = Math.round((pricedCostCents + opexPerPortionCents) / targetDenominator)
      const actualSellingPriceCents = recipe.actualSellingPriceCents ?? targetPriceCents

      // Section 5 — profitability readout, at the main order type and per order type.
      const pct = (n: number) => (actualSellingPriceCents > 0 ? (n / actualSellingPriceCents) * 100 : 0)
      const atOrderType = (mcCents: number) => {
        const cm = actualSellingPriceCents - mcCents - mc.qCents
        const net = cm - opexPerPortionCents
        return {
          mcCents,
          packagingCents: mcCents - mc.standardCents,
          contributionMarginCents: cm,
          contributionMarginPct: pct(cm),
          netProfitCents: net,
          netProfitPct: pct(net),
          mcPctOfSp: pct(mcCents),
        }
      }
      const packagingCostCents      = mainMcCents - mc.standardCents
      const contributionMarginCents = actualSellingPriceCents - pricedCostCents
      const contributionMarginPct   = pct(contributionMarginCents)
      const netProfitCents          = contributionMarginCents - opexPerPortionCents
      const netProfitPct            = pct(netProfitCents)
      const foodCostPctOfSp         = pct(pricedCostCents)
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
          serviceVessel:            ctx.serviceVessel,
          modifierId:               recipe.modifierId,
          actualSellingPriceCents:  recipe.actualSellingPriceCents,
          photoUrl:                 recipe.photoUrl,
          menuItemName:             recipe.menuItem?.name ?? recipe.name ?? null,
          modifierName:             recipe.modifier ? `${recipe.modifier.group.menuItem.name} — ${recipe.modifier.name}` : null,
          status:                   recipe.status,
        },
        brand: recipe.menuItem?.concept ?? null,
        ingredients,
        // Material cost (MC) per portion — see mcReadout. qCents is apart, never inside an MC.
        ...mc,
        warnings,
        cost: {
          totalIngredientCents,
          qFactorCents,
          totalRecipeCents,
          plateCostCents,
          perPortionCents:          Math.round(cost.perPortionCents),
          qCents:                   mc.qCents,
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
          byOrderType: {
            dine_in:  atOrderType(mc.targetMcCents.dine_in),
            takeout:  atOrderType(mc.targetMcCents.takeout),
            delivery: atOrderType(mc.targetMcCents.delivery),
          },
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
        where: { id: req.params.menuItemId, concept: await scopeTenantWhere(req, 'read') },
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
      type Ing = (typeof recipe.ingredients)[number]
      const row = (ing: Ing) => ({
        id:           ing.id,
        quantity:     ing.quantity,
        yieldPct:     ing.yieldPct,
        unit:         ing.unit,
        notes:        ing.notes,
        section:      ing.section,
        // Component name comes from whichever source the row points at —
        // a raw inventory item or a prep recipe used as a sub-component.
        name:         ing.inventoryItem?.name ?? ing.prepRecipe?.name ?? '—',
      })
      // The dish's add-on recipes (kind 'modifier'): what each add-on adds
      // (or removes — a negative quantity) per unit.
      const addOnRecipes = await prisma.recipe.findMany({
        where: { kind: 'modifier', modifier: { deletedAt: null, group: { menuItemId: req.params.menuItemId, deletedAt: null } } },
        include: {
          modifier: { select: { id: true, name: true, sortOrder: true, group: { select: { name: true, sortOrder: true } } } },
          ingredients: {
            include: { inventoryItem: { select: { name: true, unit: true } }, prepRecipe: { select: { name: true } } },
            orderBy: { inventoryItem: { name: 'asc' } },
          },
        },
      })
      addOnRecipes.sort((a, b) => (a.modifier!.group.sortOrder - b.modifier!.group.sortOrder) || (a.modifier!.sortOrder - b.modifier!.sortOrder))
      return {
        id:          recipe.id,
        steps:       recipe.steps,
        stepsUrdu:   recipe.stepsUrdu,
        notes:       recipe.notes,
        servings:    recipe.servings,
        laborMinutes: recipe.laborMinutes,
        ingredients: recipe.ingredients.map(row),
        // The same lines grouped by section: what goes in the dish, and what
        // it is packed in (used on takeaway / delivery, every order at a
        // packaging brand, and dine-in when staff tap Box given).
        sections: {
          ingredients: recipe.ingredients.filter((i) => i.section !== 'packaging').map(row),
          packaging:   recipe.ingredients.filter((i) => i.section === 'packaging').map(row),
        },
        addOns: addOnRecipes.map((r) => ({
          recipeId:   r.id,
          modifierId: r.modifier!.id,
          name:       r.modifier!.name,
          group:      r.modifier!.group.name,
          ingredients: r.ingredients.map(row),
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

  // POST /recipes — plate, component and modifier recipes (kind defaults to plate).
  // Answers 201 with the recipe plus `warnings` (codes, never a block):
  // PACKAGING_MISSING when a plate of a packaging-vessel brand has no
  // Packaging line.
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = recipeSchema.parse(req.body)

    // Company checks first (before the 409s below, which would otherwise
    // confirm that another company's item or add-on has a recipe). A new
    // recipe binds to the ACTIVE company: an existing menu item, the brand and
    // category of a deferred new one, or a modifier's brand must be that
    // company's; stock must be its own and sub-recipes ones it can see.
    let ownerTenantId: string
    let serviceVessel: string | null = null
    let modifierName: string | null = null
    if (body.kind === 'plate' && body.menuItemId) {
      const item = await prisma.menuItem.findFirst({
        where: { id: body.menuItemId, deletedAt: null, concept: { ...(await scopeTenantWhere(req, 'create')), deletedAt: null } },
        select: { concept: { select: { tenantId: true, serviceVessel: true } } },
      })
      if (!item?.concept.tenantId) throw new NotFoundError('MenuItem', body.menuItemId)
      ownerTenantId = item.concept.tenantId
      serviceVessel = item.concept.serviceVessel
    } else if (body.kind === 'plate' && body.newMenuItem) {
      const concept = await assertConceptOwned(req, body.newMenuItem.conceptId, 'create')
      const cat = await prisma.category.findFirst({
        where: { id: body.newMenuItem.categoryId, conceptId: concept.id, deletedAt: null },
        select: { id: true },
      })
      if (!cat) throw new AppError('CATEGORY_NOT_IN_BRAND', 'That category is not part of this brand', 422)
      ownerTenantId = concept.tenantId!
      serviceVessel = (await prisma.concept.findUnique({ where: { id: concept.id }, select: { serviceVessel: true } }))?.serviceVessel ?? null
    } else if (body.kind === 'modifier') {
      const mod = await resolveModifierForCreate(req, body.modifierId!)
      ownerTenantId = mod.tenantId
      modifierName = mod.name
    } else {
      const t = req.staffUser?.tenantId
      if (!t) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
      ownerTenantId = t
    }
    const lineWarnings = await validateRecipeLines(req, { kind: body.kind, tenantIds: [ownerTenantId] }, body.ingredients)

    // Through a head-office lens (A21): the new recipe must belong to the lens
    // company — a new dish of one of its brands, or a recipe whose every line
    // is that company's own stock. Anything else is 422.
    if (isReachOnly(req, ownerTenantId)) {
      const newDish = body.kind === 'plate' && !body.menuItemId && !!body.newMenuItem
      let ownStock = body.ingredients.length > 0 && body.ingredients.every((i) => !!i.inventoryItemId && !i.prepRecipeId)
      if (!newDish && ownStock) {
        const ids = [...new Set(body.ingredients.map((i) => i.inventoryItemId!))]
        const items = await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, select: { tenantId: true } })
        ownStock = items.length === ids.length && items.every((it) => it.tenantId === ownerTenantId)
      }
      if (!newDish && !ownStock) {
        throw new AppError('RECIPE_NOT_IN_LENS_COMPANY', 'Through head office a new recipe must belong to the company you are viewing: a new dish of one of its brands, or a recipe that uses only its own stock.', 422)
      }
    }

    // Plate recipes are 1:1 with a MenuItem, modifier recipes with a Modifier —
    // check for an existing recipe to surface a clean 409 instead of a Prisma
    // unique-violation. Component recipes have neither (several components
    // may share a name; the operator distinguishes them by id).
    if (body.kind === 'plate' && body.menuItemId) {
      const existing = await prisma.recipe.findUnique({ where: { menuItemId: body.menuItemId } })
      if (existing) throw new AppError('RECIPE_EXISTS', 'Recipe for this menu item already exists', 409)
    }
    if (body.kind === 'modifier') {
      const existing = await prisma.recipe.findUnique({ where: { modifierId: body.modifierId! }, select: { id: true } })
      if (existing) throw new AppError('MODIFIER_HAS_RECIPE', 'This add-on already has a recipe — open it instead', 409)
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

    let recipe
    try {
      // One transaction: the stock items are locked FOR SHARE and re-checked
      // against the Sourcing clean-up (ITEM_IN_TRASH) before the lines go in.
      recipe = await prisma.$transaction(async (tx) => {
        await assertItemsNotTrashedTx(tx, body.ingredients.map((i) => i.inventoryItemId))
        return tx.recipe.create({
          data: {
            kind:         body.kind,
            menuItemId:   resolvedMenuItemId,
            modifierId:   body.kind === 'modifier' ? body.modifierId! : null,
            pendingMenuItem: pendingMenuItem ?? Prisma.DbNull,
            // Plate recipes normally inherit their name from the menu item, but a
            // testing plate has none yet — carry the pending name so it's readable
            // in the list/editor until approval creates the item. A modifier
            // recipe is named after its add-on ("Burger — Extra cheese").
            name: body.kind === 'plate' ? (pendingMenuItem?.name ?? null)
              : body.kind === 'modifier' ? (body.name?.trim() || modifierName)
              : body.name,
            yieldGrams:   body.yieldGrams ?? null,  // total recipe yield (g) — batch yield for components, cooked total for plates
            ...(body.yieldUnit !== undefined && { yieldUnit: body.yieldUnit }),
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
            actualSellingPriceCents: body.actualSellingPriceCents ?? null,
            category:                body.category ?? null,
            photoUrl:                body.photoUrl ?? null,
            methodSteps:             body.methodSteps ?? Prisma.DbNull,
            createdById:             req.staffUser!.id,
            ingredients:  { create: body.ingredients.map(ingredientRow) },
          },
          include: {
            ingredients: { include: { inventoryItem: true, prepRecipe: { select: { id: true, name: true } } } },
            menuItem: true,
          },
        })
      })
    } catch (err) {
      // Two creates racing for one menu item / add-on: the unique index wins.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw body.kind === 'modifier'
          ? new AppError('MODIFIER_HAS_RECIPE', 'This add-on already has a recipe — open it instead', 409)
          : new AppError('RECIPE_EXISTS', 'Recipe for this menu item already exists', 409)
      }
      throw err
    }
    return reply.status(201).send({ ...recipe, warnings: saveWarnings(lineWarnings, body.kind, serviceVessel, body.ingredients) })
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
      const owned = await assertRecipeInScope(req, req.params.id)
      // Prep as stock (2026-10-24): once a prep recipe has its stock item, its yield unit is that item's unit — fixed.
      if (body.yieldUnit !== undefined) {
        const cur = await prisma.recipe.findUnique({ where: { id: req.params.id }, select: { yieldUnit: true, prepItem: { select: { id: true } } } })
        if (cur?.prepItem && cur.yieldUnit !== body.yieldUnit) {
          throw new AppError('PREP_UNIT_LOCKED', 'This prep is already kept in stock in its yield unit — its unit can no longer change', 409)
        }
      }
      // Through a head-office lens (A6): only a recipe you created, while it
      // is in iteration, and never the live menu price of a linked dish.
      const lens = await lensCompanyOf(req, owned)
      if (lens) {
        const meta = await prisma.recipe.findUnique({ where: { id: req.params.id }, select: { createdById: true, menuItemId: true } })
        await assertHoMayPropose(req, lens, meta?.createdById === req.staffUser!.id && owned.status === 'iteration', "changing a recipe you didn't create")
        await assertHoMayPropose(req, lens, !(body.actualSellingPriceCents != null && meta?.menuItemId), 'changing the live menu price')
      }
      // Only new or changed lines are refused (validateRecipeLines): a line the
      // user did not touch never blocks the save.
      const lineWarnings = body.ingredients
        ? await validateRecipeLines(req, { kind: owned.kind, tenantIds: await recipeCompanies(req, owned) }, body.ingredients, owned.lines)
        : []
      const warnings = saveWarnings(lineWarnings, owned.kind, owned.serviceVessel, body.ingredients ?? owned.lines)
      return prisma.$transaction(async (tx) => {
        await noteEditor(tx, req.params.id, req.staffUser!.id)
        if (body.ingredients) {
          // New stock items only (a line the user kept is never refused) — locked
          // FOR SHARE and re-checked against the Sourcing clean-up (ITEM_IN_TRASH).
          const kept = new Set(owned.lines.map((l) => l.inventoryItemId).filter(Boolean))
          await assertItemsNotTrashedTx(tx, body.ingredients.map((i) => i.inventoryItemId).filter((id) => !id || !kept.has(id)))
          await tx.recipeIngredient.deleteMany({ where: { recipeId: req.params.id } })
        }
        return tx.recipe.update({
          where: { id: req.params.id },
          data: {
            ...(body.name         !== undefined && { name: body.name }),
            ...(body.yieldGrams   !== undefined && { yieldGrams: body.yieldGrams }),
            ...(body.yieldUnit    !== undefined && { yieldUnit: body.yieldUnit }),
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
            ...(body.actualSellingPriceCents !== undefined && { actualSellingPriceCents: body.actualSellingPriceCents }),
            ...(body.category                !== undefined && { category:                body.category }),
            ...(body.photoUrl                !== undefined && { photoUrl:                body.photoUrl }),
            ...(body.methodSteps             !== undefined && { methodSteps:             body.methodSteps ?? Prisma.DbNull }),
            ...(body.ingredients  && { ingredients: { create: body.ingredients.map(ingredientRow) } }),
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
        return { ...updated, warnings }
      })
    },
  )

  // DELETE /recipes/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await assertRecipeInScope(req, req.params.id)
      // A prep recipe another recipe still uses can't go: deleting it would
      // null that ingredient line, which the recipe_ingredients_one_source
      // check rejects (a 500), and silently dropping the line would change
      // the other recipe's cost anyway. Say which recipes use it instead.
      const usedBy = await prisma.recipeIngredient.findMany({
        where: { prepRecipeId: req.params.id, recipeId: { not: req.params.id } },
        select: { recipe: { select: { name: true, menuItem: { select: { name: true } } } } },
        take: 5,
      })
      if (usedBy.length > 0) {
        const names = [...new Set(usedBy.map((u) => u.recipe.name ?? u.recipe.menuItem?.name ?? 'a recipe'))]
        throw new AppError('RECIPE_IN_USE', `This prep recipe is used in ${names.join(', ')}. Remove it from ${names.length === 1 ? 'that recipe' : 'those recipes'} first.`, 409)
      }
      // A step that was ever fired on the KDS has OrderItemStep rows (FK
      // restrict): the cascade would throw P2003 -> 500. Say so instead.
      const fired = await prisma.orderItemStep.count({ where: { recipeStep: { recipeId: req.params.id } } })
      if (fired > 0) {
        throw new AppError('RECIPE_IN_USE', 'This recipe has been cooked on the kitchen screens, so it cannot be deleted. Take it off the menu (set it inactive) instead.', 409)
      }
      // The recipe, its lines, steps and test cooks go to the Trash as a
      // snapshot (same ids on restore) in the same transaction as the delete.
      // deleteMany for idempotency — repeated DELETEs on an already-gone row
      // would throw Prisma P2025 -> 500.
      await prisma.$transaction(async (tx) => {
        const recipe = await tx.recipe.findUnique({
          where: { id: req.params.id },
          include: {
            ingredients: true, recipeSteps: true, testAttempts: true,
            menuItem: { select: { name: true, conceptId: true, concept: { select: { tenantId: true } } } },
          },
        })
        if (!recipe) return
        const { ingredients, recipeSteps, testAttempts, menuItem, ...row } = recipe
        const companies = await recipeCompanies(req, owned)
        const conceptId = menuItem?.conceptId
          ?? (recipe.pendingMenuItem as { conceptId?: string } | null)?.conceptId
          ?? null
        await moveToTrash(tx, req, {
          type: 'recipe', entityId: recipe.id, tenantId: owned.ownerTenantId ?? companies[0] ?? null, conceptId,
          title: recipe.name ?? menuItem?.name ?? 'Recipe',
          subtitle: recipe.kind === 'plate' ? 'Plate recipe' : recipe.kind === 'component' ? 'Sub-recipe' : 'Add-on recipe',
          reason: trashReasonOf(req),
          snapshot: takeSnapshot('Recipe', row as Record<string, unknown>, {
            RecipeIngredient: ingredients as Array<Record<string, unknown>>,
            RecipeStep: recipeSteps as Array<Record<string, unknown>>,
            RecipeTestAttempt: testAttempts as Array<Record<string, unknown>>,
          }),
        })
        await tx.recipe.deleteMany({ where: { id: req.params.id } })
      })
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
  // The submitter joins the recipe's editors (A6). Through a head office the
  // recipe is stamped with it (A3) and goes to the CEO / the hand-over.
  fastify.post<{ Params: { id: string } }>(
    '/:id/submit',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const owned = await assertRecipeInScope(req, req.params.id)
      const recipe = await prisma.recipe.findUnique({ where: { id: req.params.id } })
      if (!recipe) throw new NotFoundError('Recipe', req.params.id)
      if (recipe.status !== 'iteration') {
        throw new AppError('BAD_STATUS', `Only recipes in iteration can be submitted (this one is ${recipe.status})`, 409)
      }
      const companies = await recipeTenantSet(owned)
      let via: string | null = null
      for (const t of companies) { via = await viaHeadOfficeForSubmit(req, t); if (via) break }
      const updated = await prisma.$transaction(async (tx) => {
        await noteEditor(tx, req.params.id, req.staffUser!.id)
        const claimed = await tx.recipe.updateMany({
          where: { id: req.params.id, status: 'iteration' },
          data: {
            status:          'pending_approval',
            submittedById:   req.staffUser!.id,
            submittedAt:     new Date(),
            rejectionReason: null,   // clear any prior rejection note on re-submit
            ...(via ? { viaHeadOfficeId: via } : {}),
          },
        })
        if (claimed.count === 0) throw new AppError('BAD_STATUS', 'This recipe changed meanwhile — reload it', 409)
        return tx.recipe.findUniqueOrThrow({ where: { id: req.params.id } })
      })
      if (via) {
        await audit({
          category: 'identity', action: 'recipe.submit', entity: 'Recipe', entityId: req.params.id,
          userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: companies[0] ?? null,
          metadata: { viaHeadOfficeId: via, companies },
        })
      }
      // The bell (queued, after the commit): round = this submit's own stamp.
      approvalWaiting(RECIPE_TYPE, req.params.id, { round: `submit:${(updated.submittedAt ?? new Date()).toISOString()}`, actorId: req.staffUser!.id })
      return { ...updated, warnings: saveWarnings([], owned.kind, owned.serviceVessel, owned.lines) }
    },
  )

  // POST /recipes/:id/approve — pending_approval → production.
  // Who (D3, spec §7.3 + A5/A6/A21): the CEO/owner role path in the recipe's
  // companies (an owner never their own or edited work, nor one that came
  // through a head office), or a live Operations hand-over covering every
  // company of the recipe. The decision is claimed on the status (409 if
  // someone decided it meanwhile).
  fastify.post<{ Params: { id: string } }>(
    '/:id/approve',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { s: subj, grant } = await recipeDecisionRight(req, req.params.id, 'approve')
      // A packaging-vessel brand's dish with no Packaging line is approved
      // with warning PACKAGING_MISSING — never refused (owner's FINAL rule).
      const row = await loadRecipeForOwner(req.params.id)
      if (!row) throw new NotFoundError('Recipe', req.params.id)
      const owned = await ownedOf(row)
      const recipe = await prisma.recipe.findUnique({ where: { id: req.params.id } })
      if (!recipe) throw new NotFoundError('Recipe', req.params.id)

      const approved = await prisma.$transaction(async (tx) => {
        const claimed = await tx.recipe.updateMany({
          where: { id: req.params.id, status: 'pending_approval' },
          data:  { status: 'production', approvedById: req.staffUser!.id, approvedAt: new Date(), rejectionReason: null },
        })
        if (claimed.count === 0) {
          throw new AppError('BAD_STATUS', 'This recipe was decided meanwhile — reload it', 409)
        }
        // Approval is when a testing plate finally opens its menu item. If this
        // plate deferred creation (has a pendingMenuItem and no menuItem yet),
        // create the MenuItem now — seeded with the recipe's selling price and
        // availability — link it, and clear the pending payload + carried name.
        if (recipe.kind === 'plate' && !recipe.menuItemId && recipe.pendingMenuItem) {
          const pm = recipe.pendingMenuItem as { conceptId: string; categoryId: string; name: string; description: string | null }
          // The deferred item opens under its brand's own category only (the
          // brand itself is one of the companies the right was proven for).
          const cat = await tx.category.findFirst({
            where: { id: pm.categoryId, conceptId: pm.conceptId, deletedAt: null },
            select: { id: true },
          })
          if (!cat) throw new AppError('CATEGORY_NOT_IN_BRAND', 'The category this dish was filed under is no longer part of its brand — edit the recipe first', 422)
          const item = await tx.menuItem.create({
            data: {
              conceptId:   pm.conceptId,
              categoryId:  pm.categoryId,
              name:        pm.name,
              description: pm.description ?? null,
              priceCents:  recipe.actualSellingPriceCents ?? 0,
              isAvailable: recipe.isActive,
            },
          })
          return tx.recipe.update({
            where: { id: req.params.id },
            data:  { menuItem: { connect: { id: item.id } }, pendingMenuItem: Prisma.DbNull, name: null },   // plate now inherits its name from the menu item
          })
        }
        return tx.recipe.findUniqueOrThrow({ where: { id: req.params.id } })
      })
      await auditApproval(req, { type: RECIPE_TYPE, id: req.params.id, tenantId: subj.ownerTenantId, decision: 'approve', grant, entity: 'Recipe', metadata: { companies: subj.companyIds } })
      // Prep as stock (owner, 2026-10-24, D3): an approved prep recipe gets its prep stock item (never fails the approval).
      if (recipe.kind === 'component') {
        const { prepItemOnApproval } = await import('../inventory/prepItems.js')
        await prepItemOnApproval(req.params.id, subj.companyIds)
      }
      return { ...approved, warnings: saveWarnings([], owned.kind, owned.serviceVessel, owned.lines) }
    },
  )

  // POST /recipes/:id/reject — pending_approval → iteration (same right as approve).
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/reject',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { reason } = z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {})
      const { s: subj, grant } = await recipeDecisionRight(req, req.params.id, 'reject')
      const claimed = await prisma.recipe.updateMany({
        where: { id: req.params.id, status: 'pending_approval' },
        data: {
          status:          'iteration',
          rejectionReason: reason?.trim() || null,
        },
      })
      if (claimed.count === 0) throw new AppError('BAD_STATUS', 'This recipe was decided meanwhile — reload it', 409)
      await auditApproval(req, { type: RECIPE_TYPE, id: req.params.id, tenantId: subj.ownerTenantId, decision: 'reject', grant, entity: 'Recipe', metadata: { companies: subj.companyIds, reason: reason?.trim() || null } })
      return prisma.recipe.findUniqueOrThrow({ where: { id: req.params.id } })
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
        select: { id: true, kind: true, pendingMenuItem: true, menuItem: { select: { conceptId: true } } },
      })
      if (!parent || !(await recipeInScope(parent, await recipeScope(req)))) {
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
      const owned = await assertRecipeInScope(req, req.params.id)
      const recipe = await prisma.recipe.findUnique({ where: { id: req.params.id }, select: { id: true, createdById: true } })
      if (!recipe) throw new NotFoundError('Recipe', req.params.id)
      // Through a head-office lens (A6): only on a recipe you created, in iteration.
      const lens = await lensCompanyOf(req, owned)
      if (lens) await assertHoMayPropose(req, lens, recipe.createdById === req.staffUser!.id && owned.status === 'iteration', "logging a test cook on a recipe you didn't create")

      // Next version = current max + 1. The (recipeId, version) unique index
      // guards against a duplicate if two cooks log at the same instant.
      const last = await prisma.recipeTestAttempt.findFirst({
        where: { recipeId: req.params.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      })
      const attempt = await prisma.$transaction(async (tx) => {
        await noteEditor(tx, req.params.id, req.staffUser!.id)
        return tx.recipeTestAttempt.create({
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
      })
      return reply.status(201).send(attempt)
    },
  )

  // GET /recipes/food-cost is gone (wave B): the food-cost report is ONE
  // engine at /reports/food-cost (reports/foodCost.ts). This path answers 404;
  // the admin's old /accounting/food-cost link forwards to the report.

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
        select: { id: true, kind: true, pendingMenuItem: true, menuItem: { select: { conceptId: true } } },
      })
      if (!parent || !(await recipeInScope(parent, await recipeScope(req)))) return []
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
      const recipe = await assertRecipeInScope(req, req.params.recipeId)
      if (body.stationId) await assertStationIn(body.stationId, await recipeCompanies(req, recipe))
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
      // Scope through the parent recipe — another company's step is 404.
      const recipe = await assertRecipeInScope(req, existing.recipeId, () => new NotFoundError('RecipeStep', req.params.stepId))
      if (body.stationId) await assertStationIn(body.stationId, await recipeCompanies(req, recipe))
      // No self-dependency.
      if (body.dependsOnIds?.includes(existing.id)) {
        throw new AppError('SELF_DEP', 'A step cannot depend on itself', 400)
      }
      // Dependencies must be steps of this same recipe.
      if (body.dependsOnIds && body.dependsOnIds.length > 0) {
        const valid = await prisma.recipeStep.count({ where: { recipeId: existing.recipeId, id: { in: body.dependsOnIds } } })
        if (valid !== new Set(body.dependsOnIds).size) {
          throw new AppError('INVALID_DEPS', 'One or more dependency step IDs do not belong to this recipe', 400)
        }
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
      await assertRecipeInScope(req, step.recipeId, () => new NotFoundError('RecipeStep', req.params.stepId))
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
      // Fired on the KDS before? OrderItemStep keeps the row (FK restrict) —
      // answer 409 instead of a 500.
      const fired = await prisma.orderItemStep.count({ where: { recipeStepId: req.params.stepId } })
      if (fired > 0) {
        return reply.status(409).send({ error: {
          code: 'RECIPE_STEP_IN_USE',
          message: 'This step has already been cooked on the kitchen screens, so it cannot be removed. Edit its words instead.',
        } })
      }
      await prisma.recipeStep.delete({ where: { id: req.params.stepId } })
      return reply.status(204).send()
    },
  )
}
