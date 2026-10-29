'use client'
// Shared recipe form — used by both /accounting/recipes/new (create) and
// /accounting/recipes/[id] (edit). Implements the Pricing Spec layout end
// to end: type picker, 5 sections, live cost preview, verdict badge.
//
// In edit mode the parent fetches the existing recipe and passes it as
// `initial`; the form seeds its state from that and PUTs to /recipes/:id on
// save. In create mode no `initial` is passed and we POST to /recipes.
//
// Three kinds (finance wave B): a finished plate (a dish), a sub-recipe, and
// an add-on (a menu modifier — what ONE unit of it adds, or removes).
// Every plate has an optional Packaging section (owner's packaging rule,
// 2026-10-13): packaging-class stock only, no order-type choice per line —
// whether a sale uses it is decided at the sale (takeaway / delivery, a brand
// that serves in packaging, or "Box given" on a dine-in line). The material
// cost (MC) readout and the warnings come from the server's
// POST /recipes/costing-preview — the same costing everything else uses.

import { Button, Field, FieldLabel, Input, LinkButton, Textarea } from '@/components/finance/ui'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { RecipeTestLog, type DraftAttempt } from '../../../components/recipe/RecipeTestLog'
import { fmtPkrWhole } from '../../../lib/money'
import { useKitchenRole } from '../../inventory/kitchenView'
import { MasterIngredientPicker } from '../../../components/kitchen/MasterIngredientPicker'
import { PACKAGING_USED_WHEN } from './KitchenRecipe'
import { Select } from '@/components/ui/Select'
import { FIcon } from '../../../components/finance/ui/icons'

type Kind = 'plate' | 'component' | 'modifier'
type LineSection = 'ingredients' | 'packaging'
type Category = 'main' | 'side' | 'sauce' | 'sub_recipe'
// A finished-plate method step: what happens, and which station does it.
interface MethodStep { station: string; instruction: string }

interface InventoryItem {
  id: string
  name: string
  unit: string
  unitCostCents: number | null
  yieldPct: number
  allergens: string[]
  category: string | null
  /** null = a legacy item with no company (a sale never takes it) — fixable here. */
  tenantId?: string | null
  currentStock?: number
}
interface Concept { id: string; name: string; slug: string; forecastPortionsPerMonth: number; serviceVessel?: string; tenantId?: string | null }
interface MenuItem { id: string; name: string; conceptId: string; priceCents: number }

// GET /menu/:conceptId — the brand's menu tree (categories → dishes → add-on groups → add-ons).
interface MenuTreeGroup { id: string; name: string; modifiers: Array<{ id: string; name: string }> }
interface MenuTreeItem { id: string; name: string; modifierGroups?: MenuTreeGroup[] }
interface MenuTreeCategory { id: string; name: string; items: MenuTreeItem[] }

interface IngredientRow {
  key: string
  source: 'raw' | 'component'        // raw inventory item, or a sub-recipe (component) used by the gram
  inventoryItemId: string
  prepRecipeId: string
  quantity: number | null            // null = empty field (renders blank, not "0")
  yieldPctOverride: number | null    // UI percent 0–100; null = use the inventory default
  section: LineSection               // a dish's Packaging section, or its ingredients
  removes: boolean                   // add-on recipes only: takes the quantity OFF the dish (sent negative)
}

/** Packaging-class stock — the server's lib/inventoryClass.ts costClassOf (packing → packaging). */
function isPackagingItem(i: { category: string | null } | undefined): boolean {
  const c = (i?.category ?? '').trim().toLowerCase()
  return c === 'packaging' || c === 'packing'
}

// ─── The server's material-cost readout (GET /recipes/:id/costing, POST /recipes/costing-preview) ──

/** Per portion, whole paisa. standardCents = the plate MC (food + drinks); Q is apart, never inside an MC. */
export interface McFields {
  stockByClass:   { food: number; beverage: number; packaging: number }
  packagingCents: number
  standardCents:  number
  qCents:         number
  targetMcCents:  { dine_in: number; takeout: number; delivery: number }
  /** The same draft at servd's 90-day average ingredient prices (a line with no recent delivery keeps its latest). */
  avgStandardCents?: number
  avgPerGramCents?: number | null
}
export interface CostWarnings {
  outsideCompany: Array<{ lineId: string; itemName: string }>
  costedWhileUnapproved: boolean
  noPackaging: boolean
}
interface PreviewResult extends McFields {
  warnings: CostWarnings
  /** Save-time codes: PACKAGING_MISSING, or an untouched older line that breaks today's rules. */
  lineWarnings: string[]
  serviceVessel: string | null
  perPortionCents: number
  costPerGramCents: number | null
  /** Price per g / ml / pcs of each picked stock item, as the server costed it (servd's ingredient price). */
  itemCostPerMeasure?: Record<string, number>
}

// Component (sub-recipe) option for the ingredient picker. Cost-per-gram is
// precomputed by GET /par-sheet/preps?for=recipe — the one component picker,
// company-scoped (already batch-yield-adjusted).
interface PrepOption { id: string; name: string; costPerGramCents: number }

export type RecipeStatus = 'iteration' | 'pending_approval' | 'production'

// Shared status badge styling — reused by the recipe list + approvals inbox.
export const recipeStatusMeta: Record<RecipeStatus, { label: string; color: string; bg: string }> = {
  iteration:        { label: 'Testing',          color: 'var(--erp-warning)', bg: 'color-mix(in srgb, var(--erp-warning) 12%, transparent)' },
  pending_approval: { label: 'Pending approval',  color: 'var(--erp-primary-ink)', bg: 'rgb(var(--ink-rgb) / 0.15)' },
  production:       { label: 'Live',              color: 'var(--erp-success)', bg: 'rgb(var(--erp-accent-rgb) / 0.15)' },
}

export interface RecipeFormInitial {
  id: string
  kind: Kind
  status: RecipeStatus
  rejectionReason: string | null
  name: string | null
  menuItemId: string | null
  servings: number
  yieldGrams: number | null
  /** A prep's yield unit (g / ml / pcs) — its prep stock item's unit (2026-10-24). */
  yieldUnit?: 'g' | 'ml' | 'pcs'
  /** A prep's "Portions per recipe" (kitchen flow, 2026-10-26) and what a portion is called. */
  portionsPerBatch?: number | null
  portionLabel?: string | null
  category: Category | null
  photoUrl: string | null
  steps: string | null
  methodSteps: MethodStep[] | null
  qFactorPct: number
  targetProfitPct: number
  actualSellingPriceCents: number | null
  brandId: string | null
  /** kind 'modifier': the add-on, and the dish and group it hangs off (fixed once created). */
  modifierId?: string | null
  modifierPath?: { menuItemId: string; groupId: string; label: string } | null
  // Deferred new-menu-item details for a testing plate that hasn't opened its
  // menu item yet. Used to prefill the menu-item fields when editing.
  pendingMenuItem: { conceptId: string; categoryId: string; name: string; description: string | null } | null
  ingredients: Array<{
    id: string
    inventoryItemId: string | null
    prepRecipeId: string | null
    quantity: number
    yieldPct: number | null
    section?: string | null
  }>
}

const blankRow = (section: LineSection = 'ingredients'): IngredientRow => ({
  key: Math.random().toString(36).slice(2),
  source: 'raw',
  inventoryItemId: '',
  prepRecipeId: '',
  quantity: null,
  yieldPctOverride: null,
  section,
  removes: false,
})

// Per-gram cost to 3 decimals (cents → PKR/g). Gram-scale costs are tiny, so
// whole-rupee rounding would erase them.
function fmtPkrPerG(cents: number): string { return `PKR ${(cents / 100).toFixed(3)}` }
function fmtPct(pct: number): string { return `${pct.toFixed(1)}%` }

// Raw inventory cost normalised to cost-per-gram (paisa/g). Items priced per
// kg/litre divide by 1000; per g/ml are already per-gram; count units (pcs)
// return 0 here and are costed per-unit by the caller instead.
function invCostPerGramCents(inv: InventoryItem): number {
  const u = inv.unit.toLowerCase()
  if (u === 'kg' || u === 'litres' || u === 'l') return (inv.unitCostCents ?? 0) / 1000
  if (u === 'g'  || u === 'ml')                  return (inv.unitCostCents ?? 0)
  return 0
}

interface RecipeFormProps {
  initial?: RecipeFormInitial
  // Optional URL-driven pre-selection — used when the Menu Editor's
  // 'Add via Recipe' link is clicked, so the operator lands inside the
  // brand + category they were already looking at.
  prefillBrandId?: string
  prefillCategoryId?: string
  // Configuration → Modifiers' "Ingredients" action: a new add-on recipe for this add-on.
  prefillModifier?: { menuItemId: string; groupId: string; modifierId: string }
}

// The kitchen floor (boh, kitchen, expediter) reads recipes but never creates,
// edits or costs them — this form's component picker (costed), brand list,
// save and test log are all managers only. A cook who lands on
// /accounting/recipes/new by URL gets a plain notice, not a form full of 403s;
// the [id] page shows them the read-only recipe instead of this form. The page
// guard has already waited for the role, so managers never see the wait.
export function RecipeForm(props: RecipeFormProps) {
  const { settled, kitchen } = useKitchenRole()
  if (!settled) return <div className="p-12 text-center text-sm text-s-muted">Loading…</div>
  if (kitchen) {
    return (
      <div className="p-12 text-center">
        <p className="text-sm text-s-muted">Recipes are written and costed by managers. You can read every recipe in the recipe book.</p>
        <Link href="/accounting/recipes"
          className="inline-block mt-3 rounded-lg bg-primary text-primary-on px-4 py-2 text-xs font-black">Back to recipes</Link>
      </div>
    )
  }
  return <RecipeFormBody {...props} />
}

function RecipeFormBody({ initial, prefillBrandId, prefillCategoryId, prefillModifier }: RecipeFormProps) {
  const router = useRouter()
  const qc = useQueryClient()
  const isEdit = !!initial

  // ── Reference data ──────────────────────────────────────────────────────
  const { data: inventory = [] } = useQuery<InventoryItem[]>({
    queryKey: ['recipes', 'inventory'],
    queryFn: () => api.get('/inventory'),
  })
  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['recipes', 'concepts'],
    queryFn: () => api.get('/concepts'),
  })
  const { data: menuItems = [] } = useQuery<MenuItem[]>({
    queryKey: ['recipes', 'menu-items'],
    queryFn: () => api.get('/menu/items'),
  })

  // ── Form state, seeded from `initial` on edit ───────────────────────────
  const [kind, setKind]                 = useState<Kind>(initial?.kind ?? (prefillModifier ? 'modifier' : 'plate'))
  // Add-on recipes: the dish → add-on group → add-on chain (fixed on edit).
  const [modMenuItemId, setModMenuItemId] = useState(initial?.modifierPath?.menuItemId ?? prefillModifier?.menuItemId ?? '')
  const [modGroupId, setModGroupId]       = useState(initial?.modifierPath?.groupId ?? prefillModifier?.groupId ?? '')
  const [modifierId, setModifierId]       = useState(initial?.modifierId ?? prefillModifier?.modifierId ?? '')
  const [name, setName]                 = useState(initial?.name ?? '')
  const [brandId, setBrandId]           = useState<string>(initial?.brandId ?? prefillBrandId ?? '')
  // 'new' = create a new menu item inline (default for fresh recipes);
  // 'existing' = retrofit an existing menu item with a recipe.
  const [menuItemId, setMenuItemId]     = useState<string>(initial?.menuItemId ?? '')
  // A testing plate hasn't opened its menu item yet — seed the new-item fields
  // from its pendingMenuItem so editing pre-approval prefills correctly.
  const [newItemName, setNewItemName]                 = useState(initial?.pendingMenuItem?.name ?? '')
  const [newItemDescription, setNewItemDescription]   = useState(initial?.pendingMenuItem?.description ?? '')
  const [newItemCategoryId, setNewItemCategoryId]     = useState(initial?.pendingMenuItem?.categoryId ?? prefillCategoryId ?? '')
  const [portions, setPortions]         = useState<number | null>(initial?.servings ?? 1)
  const [yieldGrams, setYieldGrams]     = useState<number | null>(initial?.yieldGrams ?? null)
  const [yieldUnit, setYieldUnit]       = useState<'g' | 'ml' | 'pcs'>(initial?.yieldUnit ?? 'g')
  // Kitchen flow (owner, 2026-10-26): portions ONE batch of a prep makes — the par and the prep log count in them.
  const [portionsPerBatch, setPortionsPerBatch] = useState<number | null>(initial?.portionsPerBatch ?? null)
  const [portionLabel, setPortionLabel] = useState(initial?.portionLabel ?? '')
  // Sub-recipe MOP (free text). Plates use `methodSteps` instead.
  const [method, setMethod]             = useState(initial?.steps ?? '')
  // Finished-plate station-tagged method steps.
  const [methodSteps, setMethodSteps]   = useState<MethodStep[]>(initial?.methodSteps ?? [])
  const [qFactor, setQFactor]           = useState(initial?.qFactorPct ?? 10)
  const [ings, setIngs] = useState<IngredientRow[]>(
    initial?.ingredients.length
      ? initial.ingredients.map((i) => ({
          key: i.id,
          source: i.prepRecipeId ? 'component' : 'raw',
          inventoryItemId: i.inventoryItemId ?? '',
          prepRecipeId: i.prepRecipeId ?? '',
          // An add-on line that removes an ingredient is stored negative.
          quantity: Math.abs(i.quantity),
          removes: i.quantity < 0,
          section: i.section === 'packaging' ? 'packaging' : 'ingredients',
          // stored as a fraction (0–1) → show as a percent (0–100).
          yieldPctOverride: i.yieldPct != null ? Math.round(i.yieldPct * 100) : null,
        }))
      : [blankRow()],
  )
  const [err, setErr] = useState('')
  // New-recipe test log: attempts logged before the recipe exists. Persisted
  // right after the create POST returns an id.
  const [draftAttempts, setDraftAttempts] = useState<DraftAttempt[]>([])

  // If creating + menu item is picked, infer the brand from it
  useEffect(() => {
    if (!isEdit && kind === 'plate' && menuItemId && !brandId) {
      const m = menuItems.find((mi) => mi.id === menuItemId)
      if (m) setBrandId(m.conceptId)
    }
  }, [menuItemId, menuItems, isEdit, kind, brandId])

  const activeConcept = concepts.find((c) => c.id === brandId)

  // The picked brand's menu tree: its categories (the "new menu item" mode's
  // category dropdown) and its dishes' add-on groups (the add-on pickers).
  // Fetched lazily when a brand is selected.
  const { data: brandMenu = [] } = useQuery<MenuTreeCategory[]>({
    queryKey: ['recipes', 'brand-menu', brandId],
    queryFn: () => api.get<MenuTreeCategory[]>(`/menu/${brandId}`),
    enabled: !!brandId,
  })
  const brandCategories = brandMenu.map((c) => ({ id: c.id, name: c.name }))
  const brandDishes = brandMenu.flatMap((c) => c.items)
  const modGroups = brandDishes.find((d) => d.id === modMenuItemId)?.modifierGroups ?? []
  const modOptions = modGroups.find((g) => g.id === modGroupId)?.modifiers ?? []

  // Components (sub-recipes) available to use as ingredients. Both plates AND
  // components can pull a finished component in — e.g. a "Caramel" component
  // used while building a "Millionaire's Shortbread" component. A component
  // can't reference itself (filtered below); deeper cycles are cost-guarded
  // server-side.
  const { data: prepOptions = [] } = useQuery<PrepOption[]>({
    queryKey: ['recipes', 'prep-options'],
    queryFn: () => api.get('/par-sheet/preps?for=recipe'),
  })
  // Exclude the component being edited from its own picker (no self-reference).
  const availablePreps = useMemo(
    () => prepOptions.filter((p) => p.id !== initial?.id),
    [prepOptions, initial?.id],
  )

  // Stations for the selected brand — used to autocomplete the "station" field
  // on finished-plate method steps (grill, assemble, expo, …). Free text still
  // works if a station isn't formally configured yet.
  const { data: brandStations = [] } = useQuery<Array<{ id: string; name: string }>>({  // plates only
    queryKey: ['recipes', 'stations', brandId],
    queryFn: () => api.get(`/kds/stations?conceptId=${brandId}`),
    enabled: kind === 'plate' && !!brandId,
  })

  // The lines as the API takes them (save and the live preview). A row with
  // nothing picked or no quantity is not a line.
  const linesPayload = ings
    // Only a dish has a Packaging section (rows left there by a kind switch are dropped).
    .filter((r) => kind === 'plate' || r.section !== 'packaging')
    .filter((r) => (r.quantity ?? 0) > 0 && (r.source === 'component' ? r.prepRecipeId : r.inventoryItemId))
    .map((r) => {
      const quantity = (r.quantity ?? 0) * (kind === 'modifier' && r.removes ? -1 : 1)
      if (r.source === 'component') {
        // Components are consumed by the gram and already yield-adjusted.
        return { prepRecipeId: r.prepRecipeId, quantity, unit: 'g', yieldPct: 1, section: 'ingredients' as const }
      }
      const inv = inventory.find((i) => i.id === r.inventoryItemId)
      // Persist yield as a fraction (0.01–1.0) per the schema; UI holds a percent.
      const yieldFraction = r.section === 'packaging'
        ? 1
        : Math.min(1, Math.max(0.01, ((r.yieldPctOverride ?? inv?.yieldPct ?? 100)) / 100))
      return {
        inventoryItemId: r.inventoryItemId,
        quantity,
        unit:            inv?.unit ?? 'g',
        yieldPct:        yieldFraction,
        section:         kind === 'plate' ? r.section : 'ingredients' as const,
      }
    })

  // ── Server preview: MC by class, target MC per order type, warnings ─────
  // Debounced: the server costs the draft 400 ms after the last keystroke.
  const previewKey = JSON.stringify({
    kind,
    ...(isEdit ? { recipeId: initial!.id } : {}),
    ...(kind === 'plate' && brandId ? { conceptId: brandId } : {}),
    ...(kind === 'modifier' && !isEdit && modifierId ? { modifierId } : {}),
    servings: Math.max(1, Math.round(portions ?? 1)),
    yieldGrams: yieldGrams && yieldGrams > 0 ? yieldGrams : null,
    qFactorPct: Math.min(100, Math.max(0, qFactor)),
    ingredients: linesPayload.map(({ unit: _unit, ...l }) => l),
  })
  const [debouncedKey, setDebouncedKey] = useState(previewKey)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(previewKey), 400)
    return () => clearTimeout(t)
  }, [previewKey])
  const preview = useQuery<PreviewResult>({
    queryKey: ['recipes', 'costing-preview', debouncedKey],
    queryFn: () => api.post<PreviewResult>('/recipes/costing-preview', JSON.parse(debouncedKey)),
    // An add-on is costed for its company: wait for the add-on to be picked.
    enabled: linesPayload.length > 0 && (kind !== 'modifier' || isEdit || !!modifierId),
    placeholderData: keepPreviousData,
    retry: false,
    // The 422s (a line that breaks the rules) show in the form, not as a toast.
    meta: { inlineErrors: true },
  })
  const previewError = preview.error instanceof Error ? preview.error.message : null

  // ── Live cost preview ───────────────────────────────────────────────────
  // Per-line figures, computed here so the table answers as you type. The
  // headline numbers (MC by class, target MC per order type, Q, warnings)
  // come from the server's preview below — the one costing.
  const serverCpm = preview.data?.itemCostPerMeasure
  const computed = useMemo(() => {
    const invById = new Map(inventory.map((i) => [i.id, i]))
    const prepById = new Map(prepOptions.map((p) => [p.id, p]))
    const rows = ings.map((row) => {
      // Component (sub-recipe) row: cost-per-gram is precomputed by the batch
      // (already yield-adjusted), so cost = cost/g × grams used. No row yield.
      // An add-on line that removes an ingredient takes its cost off.
      const qty = (row.quantity ?? 0) * (row.removes ? -1 : 1)
      if (row.source === 'component') {
        const prep = prepById.get(row.prepRecipeId)
        const cpgCents  = prep?.costPerGramCents ?? 0
        const costCents = Math.round(cpgCents * qty)
        return {
          ...row, inv: null, name: prep?.name ?? '— component —', isCount: false,
          cpgCents, yieldPctApplied: 100, rawUsedG: qty,
          costCents, portionCostCents: Math.round(costCents / Math.max(portions ?? 1, 1)),
          allergens: [] as string[],
        }
      }
      const inv = invById.get(row.inventoryItemId)
      if (!inv) {
        return { ...row, inv: null, name: '—', isCount: false, cpgCents: 0,
                 yieldPctApplied: 100, rawUsedG: 0, costCents: 0, portionCostCents: 0, allergens: [] as string[] }
      }
      const u = inv.unit.toLowerCase()
      const isCount = (u === 'pcs' || u === 'unit' || u === 'each')
      // Yield (0–100) raises cost: to get `quantity` usable you buy quantity ÷ yield.
      // Packaging is used whole (saved at yield 1).
      const yieldPct    = row.section === 'packaging' ? 100 : ((row.yieldPctOverride ?? inv.yieldPct) || 100)
      const yieldFactor = Math.max(yieldPct / 100, 0.01)
      // For count items, "cpg" is really cost-per-unit; for weighed items it's per gram.
      // The server's price for the item (servd's ingredient price) once the preview has answered; the item's own
      // cost until then.
      const served      = serverCpm?.[inv.id]
      const cpgCents    = served != null ? served : isCount ? (inv.unitCostCents ?? 0) : invCostPerGramCents(inv)
      const costCents   = Math.round((qty * cpgCents) / yieldFactor)
      return {
        ...row, inv, name: inv.name, isCount, cpgCents, yieldPctApplied: yieldPct,
        rawUsedG: qty / yieldFactor, costCents,
        portionCostCents: Math.round(costCents / Math.max(portions ?? 1, 1)),
        allergens: inv.allergens,
      }
    })
    const inDish = rows.filter((r) => r.section !== 'packaging')
    const totalIngredient = inDish.reduce((s, r) => s + r.costCents, 0)
    const packagingTotal  = rows.reduce((s, r) => s + (r.section === 'packaging' ? r.costCents : 0), 0)
    // The Q factor is a pricing allowance on the dish's ingredients (never
    // its packaging) — the server's rule.
    const qFactorCents    = Math.round(totalIngredient * (qFactor / 100))
    const totalRecipe     = totalIngredient + qFactorCents
    const plateCost       = Math.round(totalIngredient / Math.max(portions ?? 1, 1))
    // Recipe weight = sum of gram-based ingredient quantities (count items and packaging excluded).
    const recipeWeightG   = inDish.reduce((s, r) => s + (r.isCount ? 0 : (r.quantity ?? 0) * (r.removes ? -1 : 1)), 0)
    const portionSizeG    = recipeWeightG / Math.max(portions ?? 1, 1)

    return { rows, totalIngredient, packagingTotal, qFactorCents, totalRecipe, plateCost,
             recipeWeightG, portionSizeG }
  }, [ings, inventory, prepOptions, qFactor, portions, serverCpm])

  const allAllergens = useMemo(() => {
    const set = new Set<string>()
    for (const r of computed.rows) r.allergens.forEach((a) => set.add(a))
    return Array.from(set).sort()
  }, [computed.rows])


  // ── Save (POST on create, PUT on edit) ─────────────────────────────────
  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...(isEdit ? {} : { kind }),
        // Plate recipes always create their own menu item, deferred until the
        // recipe is approved to production. Sub-recipes carry their own name +
        // yield; an add-on recipe names its add-on (its name comes from it).
        // On edit we don't touch the menu or add-on linkage.
        ...(kind === 'plate'
          ? (isEdit ? {} : {
              newMenuItem: {
                conceptId:   brandId,
                categoryId:  newItemCategoryId,
                name:        newItemName.trim(),
                description: newItemDescription.trim() || null,
              },
            })
          : kind === 'modifier'
          ? (isEdit ? {} : { modifierId })
          : { name: name.trim() }),
        // Total recipe yield in grams — batch yield for components, total cooked
        // weight for plates. Optional for plates, required (>0) for components,
        // none for an add-on (costed per unit).
        yieldGrams: kind === 'modifier' ? null : (yieldGrams ?? (kind === 'component' ? 0 : null)),
        // A prep counts its yield in grams, millilitres or pieces (a bun batch makes 24 pcs) — its stock item's unit.
        ...(kind === 'component' ? { yieldUnit, portionsPerBatch: portionsPerBatch && portionsPerBatch >= 1 ? Math.round(portionsPerBatch) : null, portionLabel: portionLabel.trim() || null } : {}),
        servings: kind === 'modifier' ? 1 : (portions ?? 1),
        // Recipe-type tag is derived from the picker (no duplicate field): a
        // finished plate is a "main"; a sub-recipe is a "sub_recipe".
        category: kind === 'plate' ? (initial?.category ?? 'main') : kind === 'component' ? 'sub_recipe' : null,
        // Sub-recipes and add-ons carry a free-text MOP in `steps`; finished
        // plates carry an ordered, station-tagged step list in `methodSteps`.
        steps: kind !== 'plate' ? (method.trim() || null) : null,
        methodSteps: kind === 'plate'
          ? methodSteps.map((s) => ({ station: s.station.trim(), instruction: s.instruction.trim() }))
                       .filter((s) => s.instruction)
          : null,
        qFactorPct: qFactor,
        // Pricing (selling price, target profit) is intentionally NOT sent
        // from the recipe form — recipes are pure cost. The Menu Engineering
        // page owns the selling price and writes it via its own PUT.
        ingredients: linesPayload,
      }
      if (isEdit) return api.put(`/recipes/${initial!.id}`, payload)
      // Create, then persist any test attempts logged before the recipe had an
      // id (the New-recipe test log buffers them). Sequential so the backend's
      // auto version numbers follow the order they were logged.
      return api.post<{ id: string }>('/recipes', payload).then(async (created) => {
        for (const d of draftAttempts) {
          await api.post(`/recipes/${created.id}/test-attempts`, {
            notes: d.notes,
            ...(d.outcome ? { outcome: d.outcome } : {}),
            ...(d.rating !== '' ? { rating: Number(d.rating) } : {}),
          })
        }
        return created
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recipes'] })
      router.push('/accounting/recipes')
    },
    onError: (e: Error) => setErr(e.message),
  })

  // Submit an iteration for the CEO's production sign-off.
  const submitForProd = useMutation({
    mutationFn: () => api.post(`/recipes/${initial!.id}/submit`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recipes'] })
      router.push('/accounting/recipes')
    },
    onError: (e: Error) => setErr(e.message),
  })

  function submit() {
    setErr('')
    if (kind === 'plate' && !brandId) return setErr('Pick a brand for this recipe.')
    // Menu-item name/category only required when actually creating one (i.e. a
    // new plate recipe — an existing plate's item is already set and read-only).
    if (kind === 'plate' && !isEdit && !newItemName.trim()) return setErr('Name the menu item.')
    if (kind === 'plate' && !isEdit && !newItemCategoryId) return setErr('Pick a menu category for the item.')
    if (kind === 'modifier' && !isEdit && !modifierId) return setErr('Pick the dish, the add-on group and the add-on this recipe is for.')
    if (kind === 'component' && !name.trim()) return setErr('Give the recipe a name.')
    if (kind === 'component' && (yieldGrams ?? 0) <= 0) return setErr('Set a positive batch yield (grams) for component recipes.')
    if (linesPayload.length === 0) return setErr('Add at least one ingredient with quantity > 0.')
    save.mutate()
  }

  // One table per section (a render function, not a component, so inputs keep
  // focus while typing). Ingredients: raw stock that is NOT packaging, or a
  // sub-recipe; an add-on line may remove (sent negative). Packaging:
  // packaging-class stock only — the server refuses anything else (422).
  const updateRow = (key: string, patch: Partial<IngredientRow>) =>
    setIngs((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const lineTable = (section: LineSection) => {
    const indexed = ings.map((row, i) => ({ row, cr: computed.rows[i]! })).filter(({ row }) => row.section === section)
    const isPack = section === 'packaging'
    const pickable = inventory.filter((it) => isPackagingItem(it) === isPack)
    if (isPack && indexed.length === 0) {
      return <p className="text-xs text-s-muted">No packaging on this dish. A dish served only on a plate needs none.</p>
    }
    return (
      <div className="overflow-x-auto rounded-lg border border-s-border">
        {/* Scrolls sideways on a phone rather than squeezing the columns. */}
        <table className="w-full min-w-[720px] text-xs">
          <thead className="text-s-muted">
            <tr className="border-b border-s-border">
              <th className="text-left  px-2 py-2 font-bold">{isPack ? 'Packaging item' : 'Ingredient'}</th>
              {kind === 'modifier' && <th className="text-left px-2 py-2 font-bold">Adds / removes</th>}
              {!isPack && <th className="text-right px-2 py-2 font-bold">Yield %</th>}
              <th className="text-right px-2 py-2 font-bold">{isPack ? 'Cost / unit' : 'Cost / g'}</th>
              <th className="text-right px-2 py-2 font-bold">{isPack ? 'Qty' : 'Recipe qty (g)'}</th>
              {!isPack && <th className="text-right px-2 py-2 font-bold">Raw used (g)</th>}
              <th className="text-right px-2 py-2 font-bold">Recipe cost</th>
              <th className="text-right px-2 py-2 font-bold">Portion cost</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {indexed.map(({ row, cr }) => {
              const isComp = row.source === 'component'
              // An older line whose item is no longer in the right list stays visible.
              const options = row.inventoryItemId && !pickable.some((it) => it.id === row.inventoryItemId)
                ? [...pickable, ...inventory.filter((it) => it.id === row.inventoryItemId)]
                : pickable
              return (
                <tr key={row.key} className="border-t border-s-border">
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      {/* Raw vs Component source (ingredients only). Both plates
                          and components can pull in a finished component. */}
                      {!isPack && (
                        <Select value={row.source}
                          onChange={(e) => updateRow(row.key, { source: e.target.value as 'raw' | 'component', inventoryItemId: '', prepRecipeId: '' })}
                          className={inputCls + ' w-[5.5rem]'} title="Raw inventory item, or a finished component sub-recipe">
                          <option value="raw">Raw</option>
                          <option value="component">Component</option>
                        </Select>
                      )}
                      {isComp ? (
                        <Select value={row.prepRecipeId}
                          onChange={(e) => updateRow(row.key, { prepRecipeId: e.target.value })}
                          className={inputCls + ' min-w-[150px]'}>
                          <option value="">— Pick component —</option>
                          {availablePreps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </Select>
                      ) : isPack ? (
                        <Select value={row.inventoryItemId}
                          onChange={(e) => updateRow(row.key, { inventoryItemId: e.target.value })}
                          className={inputCls + ' min-w-[150px]'}>
                          <option value="">— Pick packaging —</option>
                          {options.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                        </Select>
                      ) : (
                        // Kitchen flow (2026-10-26, K3): search servd's ingredient master; picking one makes sure this
                        // company stocks it and fills its unit, category, yield and allergens; "Add new" joins the
                        // master at once for review (K2).
                        <MasterIngredientPicker className="min-w-[180px]"
                          label={inventory.find((it) => it.id === row.inventoryItemId)?.name ?? ''}
                          onPicked={(item) => {
                            qc.setQueryData<InventoryItem[]>(['recipes', 'inventory'], (prev = []) => prev.some((it) => it.id === item.id) ? prev : [...prev, { ...(item as unknown as InventoryItem) }])
                            void qc.invalidateQueries({ queryKey: ['recipes', 'inventory'] })
                            updateRow(row.key, { inventoryItemId: item.id })
                          }} />
                      )}
                    </div>
                  </td>
                  {kind === 'modifier' && (
                    <td className="px-2 py-1.5">
                      <Select value={row.removes ? 'removes' : 'adds'}
                        onChange={(e) => updateRow(row.key, { removes: e.target.value === 'removes' })}
                        className={inputCls + ' w-[6.5rem]'}>
                        <option value="adds">Adds</option>
                        <option value="removes">Removes</option>
                      </Select>
                    </td>
                  )}
                  {!isPack && (
                    <td className="px-2 py-1.5 text-right">
                      {isComp ? <span className="text-s-dim">n/a</span> : (
                        <NumInput value={row.yieldPctOverride}
                          placeholder={String(cr.inv?.yieldPct ?? 100)}
                          onChange={(v) => updateRow(row.key, { yieldPctOverride: v })}
                          className={inputCls + ' w-16 text-right'}/>
                      )}
                    </td>
                  )}
                  <td className="px-2 py-1.5 text-right font-mono text-s-muted">
                    {cr.isCount ? `${fmtPkrWhole(cr.cpgCents)}/u` : fmtPkrPerG(cr.cpgCents)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <NumInput value={row.quantity} placeholder="0"
                      onChange={(v) => updateRow(row.key, { quantity: v })}
                      className={inputCls + ' w-20 text-right'}/>
                  </td>
                  {!isPack && (
                    <td className="px-2 py-1.5 text-right font-mono text-s-dim">
                      {cr.rawUsedG ? cr.rawUsedG.toLocaleString('en', { maximumFractionDigits: 0 }) : '—'}
                    </td>
                  )}
                  <td className="px-2 py-1.5 text-right font-mono font-bold">{fmtPkrWhole(cr.costCents)}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-s-muted">{fmtPkrWhole(cr.portionCostCents)}</td>
                  <td className="px-2 py-1.5">
                    <button onClick={() => setIngs(ings.filter((r) => r.key !== row.key))}
                      disabled={!isPack && indexed.length === 1}
                      aria-label="Remove line"
                      className="text-s-red hover:bg-s-red/10 rounded px-2 disabled:opacity-30"><FIcon name="x" size={14} /></button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-s-bg text-s-text">
      <header className="border-b border-s-border bg-s-surface">
        <div className="max-w-6xl mx-auto px-6 py-5">
          <div className="text-xs text-s-muted mb-1">
            <Link href="/accounting/recipes" className="hover:text-s-text">← Recipes</Link>
          </div>
          <h1 className="text-2xl font-black">{isEdit ? 'Edit recipe' : 'New recipe'}</h1>
          <p className="text-sm text-s-muted mt-1 max-w-2xl">
            Pure cost: ingredients in, plate cost (or cost-per-gram) out — numbers update live as you edit.
            Selling price &amp; margins are set in <Link href="/menu-engineering" className="text-primary-ink hover:underline">Menu Engineering</Link>.
          </p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">

        <div className="lg:col-span-2 space-y-6">
          {/* Type picker */}
          <section className="rounded-xl border border-s-border bg-s-surface p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-s-muted mb-2">Recipe type</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {([
                { v: 'plate' as Kind,     label: 'Finished plate', hint: 'Menu Item' },
                { v: 'component' as Kind, label: 'Sub recipe',      hint: 'prep recipe or component recipe' },
                { v: 'modifier' as Kind,  label: 'Add-on',          hint: 'what one add-on adds or removes' },
              ]).map((t) => (
                <button key={t.v} type="button" disabled={isEdit}
                  onClick={() => setKind(t.v)}
                  className="text-left rounded-xl px-3 py-2 border transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  style={{
                    background:  kind === t.v ? 'rgb(var(--erp-accent-rgb) / 0.14)' : 'rgb(var(--fg-rgb) / 0.02)',
                    borderColor: kind === t.v ? 'var(--erp-accent)' : 'rgb(var(--fg-rgb) / 0.08)',
                  }}>
                  <div className="text-sm font-bold">{t.label}</div>
                  <div className="text-xs text-s-muted">{t.hint}</div>
                </button>
              ))}
            </div>
            {isEdit && <p className="text-xs text-s-muted mt-2">Kind is locked on edit — to change it, delete and re-create.</p>}
          </section>

          {/* Lifecycle status — edit mode only. Iteration recipes can be
              submitted for production; sign-off is the CEO's (see approvals). */}
          {isEdit && initial && (
            <section className="rounded-xl border border-s-border bg-s-surface p-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-s-muted">Status</span>
                  <span className="text-xs font-black uppercase tracking-wider rounded-full px-2 py-0.5"
                    style={{ background: recipeStatusMeta[initial.status].bg, color: recipeStatusMeta[initial.status].color }}>
                    {recipeStatusMeta[initial.status].label}
                  </span>
                </div>
                {initial.status === 'iteration' && (
                  <Button size="sm" type="button" onClick={() => submitForProd.mutate()} disabled={submitForProd.isPending}>
                    {submitForProd.isPending ? 'Submitting…' : 'Submit for production'}
                  </Button>
                )}
                {initial.status === 'pending_approval' && (
                  <span className="text-xs text-s-muted">Submitted — awaiting CEO approval.</span>
                )}
              </div>
              {initial.status === 'iteration' && initial.rejectionReason && (
                <p className="mt-2 text-xs" style={{ color: 'var(--erp-warning)' }}>
                  Previously sent back by the CEO: “{initial.rejectionReason}”
                </p>
              )}
            </section>
          )}

          {/* Section 1 — Header */}
          <Section title="1 · Recipe header">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Brand always first — it scopes everything below. */}
              <Field label="Brand *" hint={kind === 'plate' && activeConcept?.serviceVessel === 'packaging' ? 'This brand serves in packaging — every order uses the dish\'s Packaging section.' : undefined}>
                <Select value={brandId} onChange={(e) => { setBrandId(e.target.value); if (!isEdit) { setMenuItemId(''); setNewItemCategoryId(''); setModMenuItemId(''); setModGroupId(''); setModifierId('') } }} className={inputCls} disabled={isEdit}>
                  <option value="">— Pick brand —</option>
                  {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>

              {/* Plate recipes always create their own menu item (opened on
                  approval). An already-live plate shows its item read-only. */}
              {kind === 'plate' ? (
                (isEdit && initial?.menuItemId) ? (
                  <Field label="Menu item">
                    <Input value={menuItems.find((m) => m.id === menuItemId)?.name ?? '—'} disabled className={inputCls}/>
                  </Field>
                ) : (
                  <Field label="Menu item name *">
                    <Input value={newItemName} onChange={(e) => setNewItemName(e.target.value)}
                      placeholder="e.g. Chimi Shimi" className={inputCls}/>
                  </Field>
                )
              ) : kind === 'modifier' ? (
                (isEdit && initial?.modifierPath) ? (
                  <Field label="Add-on">
                    <Input value={initial.modifierPath.label} disabled className={inputCls}/>
                  </Field>
                ) : (
                  <Field label="Dish *" hint={brandId ? 'The menu item the add-on belongs to' : 'Pick a brand first'}>
                    <Select value={modMenuItemId} disabled={!brandId}
                      onChange={(e) => { setModMenuItemId(e.target.value); setModGroupId(''); setModifierId('') }} className={inputCls}>
                      <option value="">{brandId ? '— Pick dish —' : '— Pick brand first —'}</option>
                      {brandDishes.filter((d) => (d.modifierGroups ?? []).length > 0).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </Select>
                  </Field>
                )
              ) : (
                <Field label="Recipe name *">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Burger sauce" className={inputCls}/>
                </Field>
              )}

              {/* New add-on recipe: the group, then the add-on itself. */}
              {kind === 'modifier' && !isEdit && (
                <>
                  <Field label="Add-on group *">
                    <Select value={modGroupId} disabled={!modMenuItemId}
                      onChange={(e) => { setModGroupId(e.target.value); setModifierId('') }} className={inputCls}>
                      <option value="">{modMenuItemId ? '— Pick group —' : '— Pick dish first —'}</option>
                      {modGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Add-on *" hint="One recipe per add-on: what one of it adds to the dish, or takes off it">
                    <Select value={modifierId} disabled={!modGroupId} onChange={(e) => setModifierId(e.target.value)} className={inputCls}>
                      <option value="">{modGroupId ? '— Pick add-on —' : '— Pick group first —'}</option>
                      {modOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </Select>
                  </Field>
                </>
              )}

              {/* New plate only: description + category for the menu item it'll open */}
              {kind === 'plate' && !isEdit && (
                <>
                  <Field label="Menu category *" hint={brandId ? '' : 'Pick a brand first'}>
                    <Select value={newItemCategoryId} onChange={(e) => setNewItemCategoryId(e.target.value)}
                      className={inputCls} disabled={!brandId}>
                      <option value="">{brandId ? '— Pick category —' : '— Pick brand first —'}</option>
                      {brandCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </Select>
                  </Field>
                  <div className="md:col-span-2">
                    <Field label="Menu description (optional)" hint="Shows under the item on the customer menu">
                      <Input value={newItemDescription} onChange={(e) => setNewItemDescription(e.target.value)}
                        placeholder="e.g. House Brioche | Smash Beef | Chimichurri | American Cheese" className={inputCls}/>
                    </Field>
                  </div>
                </>
              )}
              {kind === 'plate' ? (
                <>
                  <Field label="Portions per recipe">
                    <NumInput value={portions} onChange={setPortions} placeholder="1" className={inputCls}/>
                  </Field>
                  <Field label="Total yield (g)" hint="Total cooked weight this recipe makes">
                    <NumInput value={yieldGrams} onChange={setYieldGrams} placeholder="e.g. 1200" className={inputCls}/>
                  </Field>
                </>
              ) : kind === 'component' ? (
                <>
                  <Field label={`Batch yield (${yieldUnit === 'pcs' ? 'pieces' : yieldUnit === 'ml' ? 'millilitres' : 'grams'})`}>
                    <NumInput value={yieldGrams} onChange={setYieldGrams} placeholder="e.g. 500" className={inputCls}/>
                  </Field>
                  <Field label="Yield counted in" hint="The prep is kept in stock in this unit; it cannot change once the prep is in stock">
                    <Select value={yieldUnit} onChange={(e) => setYieldUnit(e.target.value as 'g' | 'ml' | 'pcs')} className={inputCls}>
                      <option value="g">Grams</option>
                      <option value="ml">Millilitres</option>
                      <option value="pcs">Pieces</option>
                    </Select>
                  </Field>
                  <Field label="Portions per recipe" hint="How many portions one batch makes — the par and the prep log count in portions">
                    <NumInput value={portionsPerBatch} onChange={setPortionsPerBatch} placeholder="e.g. 20" className={inputCls}/>
                  </Field>
                  <Field label="A portion is called" hint="Optional — e.g. bun, cup">
                    <input value={portionLabel} onChange={(e) => setPortionLabel(e.target.value)} placeholder="portion" className={inputCls} maxLength={30} />
                  </Field>
                </>
              ) : null}
            </div>
          </Section>

          {/* Section 2 — Ingredients + costing */}
          <Section title="2 · Ingredients & costing" subtitle={kind === 'modifier'
            ? 'What ONE of this add-on adds to the dish — or takes off it (pick "Removes", e.g. "No onion"). Costed per add-on.'
            : 'Raw items pull cost from the latest PO; components (sub-recipes) pull their cost-per-gram. Yield raises cost — to get the recipe qty you buy qty ÷ yield.'}>
            {lineTable('ingredients')}
            <LinkButton type="button" onClick={() => setIngs([...ings, blankRow()])}
              className="mt-2">+ Add ingredient</LinkButton>

            {/* Recipe-level rollup + pricing knobs (folded in from the old Section 3) */}
            <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-3 pt-3 border-t border-s-border">
              <div className="text-xs">
                <p className="text-s-dim">Recipe weight</p>
                <p className="font-mono font-bold text-s-text">{computed.recipeWeightG.toLocaleString('en', { maximumFractionDigits: 0 })} g</p>
              </div>
              <div className="text-xs">
                <p className="text-s-dim">Portion size {kind === 'plate' ? `(÷ ${portions})` : ''}</p>
                <p className="font-mono font-bold text-s-text">{computed.portionSizeG.toLocaleString('en', { maximumFractionDigits: 1 })} g</p>
              </div>
              <div className="text-xs">
                <p className="text-s-dim">Total recipe cost</p>
                <p className="font-mono font-bold text-s-text">{fmtPkrWhole(computed.totalRecipe)}</p>
              </div>
              {kind === 'component' && (
                <>
                  <div className="text-xs">
                    <p className="text-s-dim">Portions / recipe</p>
                    <p className="font-mono font-bold text-s-text">{portionsPerBatch && portionsPerBatch >= 1 ? `${portionsPerBatch}${yieldGrams ? ` × ${(yieldGrams / portionsPerBatch).toLocaleString('en', { maximumFractionDigits: 1 })} ${yieldUnit}` : ''}` : '—'}</p>
                  </div>
                  <div className="text-xs">
                    <p className="text-s-dim">Cost / portion</p>
                    <p className="font-mono font-bold text-s-text">{portionsPerBatch && portionsPerBatch >= 1 ? fmtPkrWhole(Math.round(computed.totalRecipe / portionsPerBatch)) : '—'}</p>
                  </div>
                </>
              )}
            </div>
            {/* The Q factor is the ONE pricing allowance (plate wear, garnish,
                oil): it goes into menu pricing, never into stock or the books.
                Target profit and the selling price live in Menu Engineering. */}
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <Field label="Q factor — pricing allowance (plate wear, garnish, oil); not stock" hint="% of the ingredients (never the packaging). Used in menu pricing only.">
                  <NumInput value={qFactor} onChange={(v) => setQFactor(v ?? 0)} placeholder="10" className={inputCls}/>
                </Field>
              </div>
            </div>
            {allAllergens.length > 0 && (
              <div className="mt-3 text-xs text-s-muted">
                Allergens (auto): {allAllergens.map((a) => (
                  <span key={a} className="ml-1 rounded px-1.5 py-0.5 text-xs"
                    style={{ background: 'color-mix(in srgb, var(--erp-warning) 15%, transparent)', color: 'var(--erp-warning)' }}>{a}</span>
                ))}
              </div>
            )}
          </Section>

          {/* Packaging — every dish has one (optional), whatever the brand. */}
          {kind === 'plate' && (
            <Section title="Packaging" subtitle={PACKAGING_USED_WHEN}>
              {lineTable('packaging')}
              <LinkButton type="button" onClick={() => setIngs([...ings, blankRow('packaging')])}
                className="mt-2">+ Add packaging</LinkButton>
              {computed.packagingTotal !== 0 && (
                <p className="mt-2 text-xs text-s-muted">
                  Packaging per portion: <span className="font-mono font-bold text-s-text">{fmtPkrWhole(Math.round(computed.packagingTotal / Math.max(portions ?? 1, 1)))}</span>
                </p>
              )}
            </Section>
          )}

          {/* Section 3 — Method (its own section, below costing) */}
          <Section title="3 · Method"
            subtitle={kind === 'plate'
              ? 'Step-by-step, tagged by station. Read top-to-bottom — e.g. Grill cooks the protein → Assemble builds the bowl → Expo checks it and hands off.'
              : kind === 'modifier'
              ? 'How the kitchen adds (or leaves out) this add-on — optional.'
              : 'General method of preparation (MOP) for this sub-recipe.'}>
            {kind !== 'plate' ? (
              <Textarea value={method} onChange={(e) => setMethod(e.target.value)} rows={5}
                placeholder="e.g. Blend garlic, lemon and olive oil; season; rest 30 min…"
                className={inputCls + ' min-h-[120px]'}/>
            ) : (
              <div className="space-y-2">
                <datalist id="station-suggestions">
                  {brandStations.map((s) => <option key={s.id} value={s.name} />)}
                </datalist>
                {methodSteps.length === 0 && (
                  <p className="text-xs text-s-muted">No steps yet — add the first stop on the plate's journey through the kitchen.</p>
                )}
                {methodSteps.map((step, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="mt-2 text-xs font-mono text-s-muted w-5 text-right shrink-0">{i + 1}.</span>
                    <Input list="station-suggestions" value={step.station}
                      onChange={(e) => {
                        const next = [...methodSteps]; next[i] = { ...next[i]!, station: e.target.value }; setMethodSteps(next)
                      }}
                      placeholder="Station (e.g. Grill)"
                      className={controlCls + ' w-40 shrink-0'}/>
                    <Textarea value={step.instruction} rows={2}
                      onChange={(e) => {
                        const next = [...methodSteps]; next[i] = { ...next[i]!, instruction: e.target.value }; setMethodSteps(next)
                      }}
                      placeholder="What happens at this station…"
                      className={controlCls + ' flex-1 min-w-0 min-h-[42px]'}/>
                    <div className="flex flex-col gap-0.5 shrink-0">
                      <button type="button" title="Move up" disabled={i === 0}
                        onClick={() => { const n = [...methodSteps]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; setMethodSteps(n) }}
                        className="text-s-muted hover:text-s-text disabled:opacity-20 text-xs px-1">↑</button>
                      <button type="button" title="Move down" disabled={i === methodSteps.length - 1}
                        onClick={() => { const n = [...methodSteps]; [n[i + 1], n[i]] = [n[i]!, n[i + 1]!]; setMethodSteps(n) }}
                        className="text-s-muted hover:text-s-text disabled:opacity-20 text-xs px-1">↓</button>
                    </div>
                    <button type="button" title="Remove step"
                      onClick={() => setMethodSteps(methodSteps.filter((_, j) => j !== i))}
                      className="mt-1 text-s-red hover:bg-s-red/10 rounded px-2 shrink-0"><FIcon name="x" size={14} /></button>
                  </div>
                ))}
                <LinkButton type="button" onClick={() => setMethodSteps([...methodSteps, { station: '', instruction: '' }])}
                  className="mt-1">+ Add step</LinkButton>
              </div>
            )}
          </Section>

          {/* Test log — live-backed on edit; on create it buffers attempts
              locally and they save with the recipe. */}
          {isEdit && initial
            ? <RecipeTestLog recipeId={initial.id} />
            : <RecipeTestLog drafts={draftAttempts} onDraftsChange={setDraftAttempts} />}
        </div>

        {/* Cost panel (right) */}
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <NoCompanyItems items={inventory.filter((it) => !it.tenantId && ings.some((r) => r.source !== 'component' && r.inventoryItemId === it.id))}
            defaultTenantId={activeConcept?.tenantId ?? null}
            onAssigned={() => { void qc.invalidateQueries({ queryKey: ['recipes', 'inventory'] }); void qc.invalidateQueries({ queryKey: ['inventory'] }); void preview.refetch() }} />
          <CostWarningBanners warnings={preview.data?.warnings} lineWarnings={preview.data?.lineWarnings} brandName={activeConcept?.name} />
          {previewError && (
            <div className="rounded-xl border p-3 text-xs" style={dangerBox}>{previewError}</div>
          )}
          <CostPanel computed={computed} kind={kind} yieldGrams={yieldGrams} portionsPerBatch={portionsPerBatch} mc={preview.data ?? null} loading={preview.isFetching} />
          {kind === 'plate' && <div className="rounded-xl border border-s-border bg-s-surface p-4 text-xs text-s-muted">
            <strong className="text-s-text">Heads-up:</strong> Live Opex/Portion isn't shown until save.
            The backend reads current OpexLine entries for {activeConcept?.name ?? 'your brand'} and divides by{' '}
            <strong className="text-s-text">forecast portions/month</strong> ({activeConcept?.forecastPortionsPerMonth ?? '—'}).
            Set that on the brand in <Link href="/settings" className="text-primary-ink hover:underline">Tenants &amp; Brands</Link>.
          </div>}
          {err && (
            <div className="rounded-xl border p-3 text-xs" style={dangerBox}>{err}</div>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" type="submit" onClick={() => router.push('/accounting/recipes')}
              className="flex-1">
              Cancel
            </Button>
            <Button type="submit" onClick={submit} disabled={save.isPending}
              className="flex-1">
              {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Save recipe'}
            </Button>
          </div>
        </aside>
      </main>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-s-border bg-s-surface p-5">
      <h2 className="text-base font-black">{title}</h2>
      {subtitle && <p className="text-xs text-s-muted mt-0.5 mb-3">{subtitle}</p>}
      {!subtitle && <div className="mb-3"/>}
      {children}
    </section>
  )
}


interface ComputedShape {
  totalIngredient: number; packagingTotal: number; qFactorCents: number; totalRecipe: number; plateCost: number
  recipeWeightG: number; portionSizeG: number
}

// Banner styles from the tokens: red = something is wrong, amber = a warning
// that never blocks (Approve stays enabled).
const dangerBox: React.CSSProperties = {
  color: 'var(--erp-danger)',
  background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)',
  borderColor: 'color-mix(in srgb, var(--erp-danger) 35%, transparent)',
}
const warnBox: React.CSSProperties = {
  color: 'var(--erp-warning)',
  background: 'color-mix(in srgb, var(--erp-warning) 8%, transparent)',
  borderColor: 'color-mix(in srgb, var(--erp-warning) 35%, transparent)',
}

/**
 * Stock items on this recipe that belong to no company (legacy rows). The
 * recipe cannot save with them, so the fix is offered right here: give the
 * item its company — the same PATCH /inventory/:id { tenantId } as Inventory →
 * "Assign a company" (an item holding stock needs its opening unit cost).
 */
function NoCompanyItems({ items, defaultTenantId, onAssigned }: {
  items: InventoryItem[]
  defaultTenantId: string | null
  onAssigned: () => void
}) {
  const { data: tenants = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['my-tenants'],
    queryFn: () => api.get('/tenants/mine'),
    enabled: items.length > 0,
  })
  const [pick, setPick] = useState<Record<string, { tenantId: string; costPkr: string }>>({})
  const [err, setErr] = useState<Record<string, string>>({})
  const assign = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/inventory/${id}`, body),
  })
  if (items.length === 0) return null
  const fallback = defaultTenantId ?? (tenants.length === 1 ? tenants[0]!.id : '')
  return (
    <div className="space-y-2">
      {items.map((it) => {
        const p = pick[it.id] ?? { tenantId: fallback, costPkr: it.unitCostCents != null ? String(it.unitCostCents / 100) : '' }
        const holdsStock = (it.currentStock ?? 0) > 0
        const ready = !!p.tenantId && (!holdsStock || p.costPkr.trim() !== '')
        return (
          <div key={it.id} className="rounded-xl border p-3 text-xs space-y-2" style={dangerBox}>
            <p><strong>{it.name}</strong> has no company yet, so this recipe can&rsquo;t use it. Give it its company:</p>
            <div className="flex flex-wrap items-end gap-2">
              <Select value={p.tenantId} onChange={(e) => setPick({ ...pick, [it.id]: { ...p, tenantId: e.target.value } })}
                className="rounded-lg border border-s-border bg-s-surface px-2 py-1.5 text-xs text-s-text" aria-label={`Company for ${it.name}`}>
                <option value="">— Pick company —</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
              {holdsStock && (
                <FieldLabel>Opening cost (PKR per {it.unit})
                  <Input type="number" min={0} step="any" value={p.costPkr}
                    onChange={(e) => setPick({ ...pick, [it.id]: { ...p, costPkr: e.target.value } })}
                    className="ml-1 w-24" />
                </FieldLabel>
              )}
              <Button type="button" disabled={!ready || assign.isPending}
                onClick={() => {
                  setErr({ ...err, [it.id]: '' })
                  assign.mutate(
                    { id: it.id, body: { tenantId: p.tenantId, ...(holdsStock ? { unitCostCents: Math.round(Number(p.costPkr) * 100) } : {}) } },
                    { onSuccess: onAssigned, onError: (e: Error) => setErr({ ...err, [it.id]: e.message || 'Could not assign the company' }) },
                  )
                }}>
                {assign.isPending ? 'Assigning…' : 'Assign company'}
              </Button>
            </div>
            {holdsStock && <p className="text-xs opacity-80">It holds {it.currentStock} {it.unit}: that stock is booked as an opening count in the company you pick.</p>}
            {err[it.id] && <p role="alert" className="font-bold">{err[it.id]}</p>}
          </div>
        )
      })}
    </div>
  )
}

/** Older lines that break today's rules — they still save (only new or changed lines are refused). */
const LEGACY_LINE_TEXT: Record<string, string> = {
  PACKAGING_ON_PLATES_ONLY: 'A packaging item sits in this sub-recipe or add-on from before. Packaging belongs in a dish\'s Packaging section — move it when you can.',
  PACKAGING_SECTION_ONLY: 'A packaging item sits under Ingredients from before — move it to the Packaging section.',
  NOT_PACKAGING: 'A line under Packaging is not a packaging item — move it to Ingredients.',
  ITEM_NOT_IN_COMPANY: 'A line uses another company\'s stock — replace it with this company\'s own item.',
  ITEM_HAS_NO_COMPANY: 'A line uses stock that belongs to no company — a sale never takes it. Replace it with this company\'s own item.',
}

/**
 * The recipe's warnings as banners: stock of another company and a live dish
 * costed while unapproved are RED; no packaging at a brand that serves in
 * packaging is AMBER and never blocks saving or approval.
 */
export function CostWarningBanners({ warnings, lineWarnings, brandName }: {
  warnings?: CostWarnings | null
  lineWarnings?: string[] | null
  brandName?: string | null
}) {
  const legacy = (lineWarnings ?? []).filter((c) => c in LEGACY_LINE_TEXT && !(c === 'ITEM_NOT_IN_COMPANY' && warnings?.outsideCompany.length))
  if (!warnings && legacy.length === 0) return null
  return (
    <div className="space-y-2">
      {!!warnings?.outsideCompany.length && (
        <div className="rounded-xl border p-3 text-xs" style={dangerBox}>
          <strong>Stock of another company:</strong> {warnings.outsideCompany.map((o) => o.itemName).join(', ')}.
          {' '}A sale never takes it, so this cost is wrong — replace it with this company&apos;s own item.
        </div>
      )}
      {warnings?.costedWhileUnapproved && (
        <div className="rounded-xl border p-3 text-xs" style={dangerBox}>
          <strong>On sale, not approved:</strong> this dish is on the menu and every sale is costed and taken from stock with this recipe, but the recipe is not approved yet. Submit it for approval.
        </div>
      )}
      {warnings?.noPackaging && (
        <div className="rounded-xl border p-3 text-xs" style={warnBox}>
          <strong>No packaging:</strong> {brandName ?? 'This brand'} serves in packaging — add the vessel to the Packaging section. You can still save and approve.
        </div>
      )}
      {legacy.map((c) => (
        <div key={c} className="rounded-xl border p-3 text-xs" style={warnBox}>{LEGACY_LINE_TEXT[c]}</div>
      ))}
    </div>
  )
}

/**
 * Material cost per portion: Food / Drinks / Packaging, the plate MC (food +
 * drinks), the target MC per order type, and the Q allowance on its own line
 * (in menu pricing, not stock). Used by the form's live panel and the
 * recipe page's "as saved" card.
 */
export function McBreakdown({ mc, kind }: { mc: McFields; kind: Kind }) {
  if (kind === 'modifier') {
    return (
      <div>
        <Line label="Food" value={fmtPkrWhole(mc.stockByClass.food)} />
        <Line label="Drinks" value={fmtPkrWhole(mc.stockByClass.beverage)} dim />
        <Line label="Cost of one add-on" value={fmtPkrWhole(mc.standardCents)} bold highlight highlightColor="var(--erp-success)" />
        <Line label="Q allowance — in menu pricing, not stock" value={fmtPkrWhole(mc.qCents)} dim />
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-s-muted mb-1">Per portion</p>
        <Line label="Food" value={fmtPkrWhole(mc.stockByClass.food)} />
        <Line label="Drinks" value={fmtPkrWhole(mc.stockByClass.beverage)} />
        <Line label="Plate MC (food + drinks)" value={fmtPkrWhole(mc.standardCents)} bold />
        <Line label="Packaging" value={fmtPkrWhole(mc.packagingCents)} dim />
        <Line label="Q allowance — in menu pricing, not stock" value={fmtPkrWhole(mc.qCents)} dim />
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-s-muted mb-1">Target MC by order type</p>
        <Line label="Dine-in" value={fmtPkrWhole(mc.targetMcCents.dine_in)} highlight highlightColor="var(--erp-success)" />
        <Line label="Takeaway" value={fmtPkrWhole(mc.targetMcCents.takeout)} highlight highlightColor="var(--erp-success)" />
        <Line label="Delivery" value={fmtPkrWhole(mc.targetMcCents.delivery)} highlight highlightColor="var(--erp-success)" />
        <p className="text-xs text-s-muted mt-1">Food + drinks + the packaging where that order type uses it. A dine-in box handed over (Box given) shows in actual cost, not here.</p>
      </div>
    </div>
  )
}

// Pure cost — no pricing here. Recipes carry cost only; selling price,
// contribution margin and profitability live on the Menu Engineering page.
function CostPanel({ computed, kind, yieldGrams, portionsPerBatch, mc, loading }: {
  computed: ComputedShape
  kind: Kind
  yieldGrams: number | null
  portionsPerBatch?: number | null
  /** The server's preview of this draft (null until it answers). */
  mc: McFields | null
  loading: boolean
}) {
  const v = computed

  // Sub-recipes: batch cost + cost-per-gram (what flows into parents).
  if (kind === 'component') {
    const cpg = yieldGrams && yieldGrams > 0 ? v.totalRecipe / yieldGrams : null
    return (
      <div className="rounded-xl border border-s-border bg-s-surface overflow-hidden">
        <header className="px-4 py-3 border-b border-s-border" style={{ background: 'rgb(var(--ink-rgb) / 0.10)' }}>
          <p className="text-xs uppercase tracking-wider text-s-muted">Sub recipe</p>
          <p className="text-base font-black mt-0.5" style={{ color: 'var(--erp-primary-ink)' }}>Costed per gram — not sold directly</p>
        </header>
        <div className="p-4 space-y-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-s-muted mb-1">Batch cost build-up</p>
            <Line label="Total ingredient" value={fmtPkrWhole(v.totalIngredient)} />
            <Line label="Q factor" value={fmtPkrWhole(v.qFactorCents)} dim />
            <Line label="Batch cost" value={fmtPkrWhole(v.totalRecipe)} bold />
            <Line label="Batch yield" value={yieldGrams && yieldGrams > 0 ? `${yieldGrams.toLocaleString('en')} g` : 'set batch yield'} dim />
            <Line label="Cost per gram" value={cpg != null ? fmtPkrPerG(cpg) : '—'} bold highlight />
            {mc?.avgPerGramCents != null && <Line label="Cost per gram — 90-day average" value={fmtPkrPerG(mc.avgPerGramCents)} dim />}
            <Line label="Portions / recipe" value={portionsPerBatch && portionsPerBatch >= 1 ? String(portionsPerBatch) : 'not set'} dim />
            <Line label="Cost / portion" value={portionsPerBatch && portionsPerBatch >= 1 ? fmtPkrWhole(Math.round(v.totalRecipe / portionsPerBatch)) : '—'} bold />
          </div>
          <p className="text-xs text-s-muted">
            This cost-per-gram flows automatically into any plate or sub recipe that uses this component.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-s-border bg-s-surface overflow-hidden">
      <header className="px-4 py-3 border-b border-s-border" style={{ background: 'rgb(var(--erp-primary-rgb) / 0.08)' }}>
        <p className="text-xs uppercase tracking-wider text-s-muted">{kind === 'modifier' ? 'Add-on cost' : 'Material cost (MC)'}</p>
        <p className="text-base font-black mt-0.5" style={{ color: 'var(--erp-success)' }}>
          {fmtPkrWhole(mc ? mc.standardCents : v.plateCost)} {kind === 'modifier' ? '/ add-on' : '/ plate'}
        </p>
      </header>

      <div className="p-4 space-y-3">
        {mc ? <McBreakdown mc={mc} kind={kind} /> : (
          <div>
            <Line label="Ingredients" value={fmtPkrWhole(v.totalIngredient)} />
            <Line label="Packaging" value={fmtPkrWhole(v.packagingTotal)} dim />
            <Line label="Q allowance — in menu pricing, not stock" value={fmtPkrWhole(v.qFactorCents)} dim />
          </div>
        )}
        {mc?.avgStandardCents != null && (
          <Line label={`At 90-day average prices ${kind === 'modifier' ? '/ add-on' : '/ plate'}`} value={fmtPkrWhole(mc.avgStandardCents)} dim />
        )}
        <p className="text-xs text-s-muted">Costed at the latest price paid anywhere in servd (Operations → Ingredients).</p>
        {loading && <p className="text-xs text-s-muted">Updating…</p>}
        <p className="text-xs text-s-muted">
          Selling price, contribution margin and profitability live in{' '}
          <Link href="/menu-engineering" className="text-primary-ink hover:underline">Menu Engineering</Link>.
        </p>
      </div>
    </div>
  )
}

function Line({ label, value, dim, bold, highlight, highlightColor }: {
  label: string; value: string; dim?: boolean; bold?: boolean; highlight?: boolean; highlightColor?: string
}) {
  return (
    <div className="flex justify-between items-baseline gap-2 text-xs font-mono py-0.5">
      <span className={dim ? 'text-s-dim' : 'text-s-muted'}>{label}</span>
      <span className={`${bold ? 'font-black' : ''}`} style={{ color: highlight ? (highlightColor ?? 'var(--erp-primary-ink)') : undefined }}>
        {value}
      </span>
    </div>
  )
}

// Free-hand numeric input. Renders as a text field (no spinner arrows), accepts
// decimals, and shows BLANK when empty — no hardcoded "0" to clear first. Commits
// a parsed number (or null when cleared) to the parent, while keeping an internal
// buffer so mid-typing states like "1." or "" aren't clobbered by re-render.
function NumInput({ value, onChange, placeholder, className }: {
  value: number | null
  onChange: (v: number | null) => void
  placeholder?: string
  className?: string
}) {
  const [buf, setBuf] = useState<string | null>(null)
  const shown = buf ?? (value == null || Number.isNaN(value) ? '' : String(value))
  return (
    <Input
      type="text"
      inputMode="decimal"
      value={shown}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value
        if (raw !== '' && !/^\d*\.?\d*$/.test(raw)) return  // digits + one dot only
        setBuf(raw)
        if (raw.trim() === '') { onChange(null); return }
        const n = parseFloat(raw)
        if (Number.isFinite(n)) onChange(n)
      }}
      onBlur={() => setBuf(null)}
      className={`${`${className} w-auto`} w-auto`}
    />
  )
}

const inputCls = 's-input w-full'
// Same as inputCls but WITHOUT w-full — for controls inside a flex row where
// width is governed by flex (w-40/flex-1). w-full there fights flex sizing and
// collapses siblings (the method-step instruction box was being crushed).
const controlCls = 's-input'
