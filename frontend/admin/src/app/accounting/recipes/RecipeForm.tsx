'use client'
// Shared recipe form — used by both /accounting/recipes/new (create) and
// /accounting/recipes/[id] (edit). Implements the Pricing Spec layout end
// to end: type picker, 5 sections, live cost preview, verdict badge.
//
// In edit mode the parent fetches the existing recipe and passes it as
// `initial`; the form seeds its state from that and PUTs to /recipes/:id on
// save. In create mode no `initial` is passed and we POST to /recipes.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { RecipeTestLog } from '../../../components/recipe/RecipeTestLog'

type Kind = 'plate' | 'component'
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
}
interface Concept { id: string; name: string; slug: string; forecastPortionsPerMonth: number }
interface MenuItem { id: string; name: string; conceptId: string; priceCents: number }

interface IngredientRow {
  key: string
  source: 'raw' | 'component'        // raw inventory item, or a sub-recipe (component) used by the gram
  inventoryItemId: string
  prepRecipeId: string
  quantity: number | null            // null = empty field (renders blank, not "0")
  yieldPctOverride: number | null    // UI percent 0–100; null = use the inventory default
}

// Component (sub-recipe) option for the ingredient picker. Cost-per-gram is
// precomputed by GET /recipes/prep (already batch-yield-adjusted).
interface PrepOption { id: string; name: string; costPerGramCents: number }

export type RecipeStatus = 'iteration' | 'pending_approval' | 'production'

// Shared status badge styling — reused by the recipe list + approvals inbox.
export const recipeStatusMeta: Record<RecipeStatus, { label: string; color: string; bg: string }> = {
  iteration:        { label: 'Testing',          color: '#FDB022', bg: 'rgba(245,158,11,0.12)' },
  pending_approval: { label: 'Pending approval',  color: '#A5B4FC', bg: 'rgba(99,102,241,0.15)' },
  production:       { label: 'Live',              color: '#5EEAD4', bg: 'rgba(0,212,177,0.12)' },
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
  category: Category | null
  photoUrl: string | null
  steps: string | null
  methodSteps: MethodStep[] | null
  qFactorPct: number
  targetProfitPct: number
  packagingPct: number
  actualSellingPriceCents: number | null
  brandId: string | null
  // Deferred new-menu-item details for a testing plate that hasn't opened its
  // menu item yet. Used to prefill the menu-item fields when editing.
  pendingMenuItem: { conceptId: string; categoryId: string; name: string; description: string | null } | null
  ingredients: Array<{
    id: string
    inventoryItemId: string | null
    prepRecipeId: string | null
    quantity: number
    yieldPct: number | null
  }>
}

const blankRow = (): IngredientRow => ({
  key: Math.random().toString(36).slice(2),
  source: 'raw',
  inventoryItemId: '',
  prepRecipeId: '',
  quantity: null,
  yieldPctOverride: null,
})

function fmtPkr(cents: number): string {
  return `PKR ${Math.round(cents / 100).toLocaleString('en-PK')}`
}
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

export function RecipeForm({ initial, prefillBrandId, prefillCategoryId }: {
  initial?: RecipeFormInitial
  // Optional URL-driven pre-selection — used when the Menu Editor's
  // 'Add via Recipe' link is clicked, so the operator lands inside the
  // brand + category they were already looking at.
  prefillBrandId?: string
  prefillCategoryId?: string
}) {
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
  const [kind, setKind]                 = useState<Kind>(initial?.kind ?? 'plate')
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
  // Sub-recipe MOP (free text). Plates use `methodSteps` instead.
  const [method, setMethod]             = useState(initial?.steps ?? '')
  // Finished-plate station-tagged method steps.
  const [methodSteps, setMethodSteps]   = useState<MethodStep[]>(initial?.methodSteps ?? [])
  const [qFactor, setQFactor]           = useState(initial?.qFactorPct ?? 10)
  const [targetProfit, setTargetProfit] = useState(initial?.targetProfitPct ?? 25)
  const [packaging, setPackaging]       = useState(initial?.packagingPct ?? 8)
  const [actualSpPkr, setActualSpPkr]   = useState<string>(
    initial?.actualSellingPriceCents ? String(Math.round(initial.actualSellingPriceCents / 100)) : '',
  )
  const [ings, setIngs] = useState<IngredientRow[]>(
    initial?.ingredients.length
      ? initial.ingredients.map((i) => ({
          key: i.id,
          source: i.prepRecipeId ? 'component' : 'raw',
          inventoryItemId: i.inventoryItemId ?? '',
          prepRecipeId: i.prepRecipeId ?? '',
          quantity: i.quantity,
          // stored as a fraction (0–1) → show as a percent (0–100).
          yieldPctOverride: i.yieldPct != null ? Math.round(i.yieldPct * 100) : null,
        }))
      : [blankRow()],
  )
  const [err, setErr] = useState('')

  // If creating + menu item is picked, infer the brand from it
  useEffect(() => {
    if (!isEdit && kind === 'plate' && menuItemId && !brandId) {
      const m = menuItems.find((mi) => mi.id === menuItemId)
      if (m) setBrandId(m.conceptId)
    }
  }, [menuItemId, menuItems, isEdit, kind, brandId])

  const activeConcept = concepts.find((c) => c.id === brandId)

  // Categories under the picked brand (for the "new menu item" mode's
  // category dropdown). Fetched lazily when a brand is selected.
  const { data: brandCategories = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['recipes', 'brand-categories', brandId],
    queryFn: async () => {
      const cats = await api.get<Array<{ id: string; name: string; items: unknown[] }>>(`/menu/${brandId}`)
      return cats.map((c) => ({ id: c.id, name: c.name }))
    },
    enabled: !!brandId,
  })

  // Components (sub-recipes) available to use as ingredients on a plate. Plate
  // recipes can pull any active component; components don't nest components.
  const { data: prepOptions = [] } = useQuery<PrepOption[]>({
    queryKey: ['recipes', 'prep-options'],
    queryFn: () => api.get('/recipes/prep'),
    enabled: kind === 'plate',
  })

  // Stations for the selected brand — used to autocomplete the "station" field
  // on finished-plate method steps (grill, assemble, expo, …). Free text still
  // works if a station isn't formally configured yet.
  const { data: brandStations = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['recipes', 'stations', brandId],
    queryFn: () => api.get(`/kds/stations?conceptId=${brandId}`),
    enabled: kind === 'plate' && !!brandId,
  })

  // ── Live cost preview ───────────────────────────────────────────────────
  const computed = useMemo(() => {
    const invById = new Map(inventory.map((i) => [i.id, i]))
    const prepById = new Map(prepOptions.map((p) => [p.id, p]))
    const rows = ings.map((row) => {
      // Component (sub-recipe) row: cost-per-gram is precomputed by the batch
      // (already yield-adjusted), so cost = cost/g × grams used. No row yield.
      const qty = row.quantity ?? 0
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
      const yieldPct    = (row.yieldPctOverride ?? inv.yieldPct) || 100
      const yieldFactor = Math.max(yieldPct / 100, 0.01)
      // For count items, "cpg" is really cost-per-unit; for weighed items it's per gram.
      const cpgCents    = isCount ? (inv.unitCostCents ?? 0) : invCostPerGramCents(inv)
      const costCents   = Math.round((qty * cpgCents) / yieldFactor)
      return {
        ...row, inv, name: inv.name, isCount, cpgCents, yieldPctApplied: yieldPct,
        rawUsedG: qty / yieldFactor, costCents,
        portionCostCents: Math.round(costCents / Math.max(portions ?? 1, 1)),
        allergens: inv.allergens,
      }
    })
    const totalIngredient = rows.reduce((s, r) => s + r.costCents, 0)
    const qFactorCents    = Math.round(totalIngredient * (qFactor / 100))
    const totalRecipe     = totalIngredient + qFactorCents
    const plateCost       = Math.round(totalRecipe / Math.max(portions ?? 1, 1))
    // Recipe weight = sum of gram-based recipe quantities (count items excluded).
    const recipeWeightG   = rows.reduce((s, r) => s + (r.isCount ? 0 : (r.quantity ?? 0)), 0)
    const portionSizeG    = recipeWeightG / Math.max(portions ?? 1, 1)
    const opexPerPortion  = 0   // live-on-save (server computes from OpexLine)

    const packagingFactor = packaging / 100
    const targetFactor    = targetProfit / 100
    const foodCostPrice   = Math.round(plateCost / 0.30)
    const breakEven       = Math.round((plateCost + opexPerPortion) / Math.max(0.01, 1 - packagingFactor))
    const target          = Math.round((plateCost + opexPerPortion) / Math.max(0.01, 1 - packagingFactor - targetFactor))
    const actualSp        = actualSpPkr.trim() ? Math.round(parseFloat(actualSpPkr) * 100) : target

    const packagingCost   = Math.round(actualSp * packagingFactor)
    const contribMargin   = actualSp - plateCost - packagingCost
    const contribMarginPct = actualSp > 0 ? (contribMargin / actualSp) * 100 : 0
    const netProfit       = contribMargin - opexPerPortion
    const netProfitPct    = actualSp > 0 ? (netProfit / actualSp) * 100 : 0
    const foodCostPctOfSp = actualSp > 0 ? (plateCost / actualSp) * 100 : 0
    const verdict: 'profitable' | 'covers_food_loses_opex' | 'loses_every_plate' =
      netProfit > 0     ? 'profitable' :
      contribMargin > 0 ? 'covers_food_loses_opex' : 'loses_every_plate'

    return { rows, totalIngredient, qFactorCents, totalRecipe, plateCost,
             recipeWeightG, portionSizeG,
             opexPerPortion, forecastPortions: activeConcept?.forecastPortionsPerMonth ?? 0,
             foodCostPrice, breakEven, target, actualSp,
             packagingCost, contribMargin, contribMarginPct,
             netProfit, netProfitPct, foodCostPctOfSp, verdict }
  }, [ings, inventory, prepOptions, qFactor, portions, packaging, targetProfit, actualSpPkr, activeConcept])

  const allAllergens = useMemo(() => {
    const set = new Set<string>()
    for (const r of computed.rows) r.allergens.forEach((a) => set.add(a))
    return Array.from(set).sort()
  }, [computed.rows])

  // Resolve the actual selling price the operator wants saved. If they
  // didn't override, fall back to the live-computed target — the backend
  // mirrors this into MenuItem.priceCents so the menu price auto-fills
  // from the recipe spec.
  const resolvedActualSpCents = actualSpPkr.trim()
    ? Math.round(parseFloat(actualSpPkr) * 100)
    : computed.target

  // ── Save (POST on create, PUT on edit) ─────────────────────────────────
  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...(isEdit ? {} : { kind }),
        // Plate recipes always create their own menu item, deferred until the
        // recipe is approved to production. Non-plate recipes carry their own
        // name + yield. On edit we don't touch the menu linkage.
        ...(kind === 'plate'
          ? (isEdit ? {} : {
              newMenuItem: {
                conceptId:   brandId,
                categoryId:  newItemCategoryId,
                name:        newItemName.trim(),
                description: newItemDescription.trim() || null,
              },
            })
          : { name: name.trim(), yieldGrams: yieldGrams ?? 0 }),
        servings: portions ?? 1,
        // Recipe-type tag is derived from the picker (no duplicate field): a
        // finished plate is a "main"; a sub-recipe is a "sub_recipe".
        category: kind === 'plate' ? (initial?.category ?? 'main') : 'sub_recipe',
        // Sub-recipes carry a free-text MOP in `steps`; finished plates carry an
        // ordered, station-tagged step list in `methodSteps`.
        steps: kind === 'component' ? (method.trim() || null) : null,
        methodSteps: kind === 'plate'
          ? methodSteps.map((s) => ({ station: s.station.trim(), instruction: s.instruction.trim() }))
                       .filter((s) => s.instruction)
          : null,
        qFactorPct: qFactor,
        targetProfitPct: targetProfit,
        packagingPct: packaging,
        actualSellingPriceCents: actualSpPkr.trim() ? Math.round(parseFloat(actualSpPkr) * 100) : null,
        ingredients: ings
          .filter((r) => (r.quantity ?? 0) > 0 && (r.source === 'component' ? r.prepRecipeId : r.inventoryItemId))
          .map((r) => {
            if (r.source === 'component') {
              // Components are consumed by the gram and already yield-adjusted.
              return { prepRecipeId: r.prepRecipeId, quantity: r.quantity ?? 0, unit: 'g', yieldPct: 1 }
            }
            const inv = inventory.find((i) => i.id === r.inventoryItemId)
            // Persist yield as a fraction (0.01–1.0) per the schema; UI holds a percent.
            const yieldFraction = Math.min(1, Math.max(0.01, ((r.yieldPctOverride ?? inv?.yieldPct ?? 100)) / 100))
            return {
              inventoryItemId: r.inventoryItemId,
              quantity:        r.quantity ?? 0,
              unit:            inv?.unit ?? 'g',
              yieldPct:        yieldFraction,
            }
          }),
      }
      return isEdit
        ? api.put(`/recipes/${initial!.id}`, payload)
        : api.post('/recipes', payload)
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
    if (kind !== 'plate' && !name.trim()) return setErr('Give the recipe a name.')
    if (kind !== 'plate' && (yieldGrams ?? 0) <= 0) return setErr('Set a positive batch yield (grams) for component recipes.')
    const hasIngredient = computed.rows.some((r) =>
      (r.quantity ?? 0) > 0 && (r.source === 'component' ? !!r.prepRecipeId : !!r.inventoryItemId))
    if (!hasIngredient) return setErr('Add at least one ingredient with quantity > 0.')
    save.mutate()
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
            One page in, plate cost + suggested price + profitability out. Numbers update live as you edit;
            on save the backend recomputes with current OpEx + ingredient prices.
          </p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">

        <div className="lg:col-span-2 space-y-6">
          {/* Type picker */}
          <section className="rounded-xl border border-s-border bg-s-surface p-4">
            <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-2">Recipe type</p>
            <div className="grid grid-cols-2 gap-2">
              {([
                { v: 'plate' as Kind,     label: 'Finished plate', hint: 'Menu Item' },
                { v: 'component' as Kind, label: 'Sub recipe',      hint: 'prep recipe or component recipe' },
              ]).map((t) => (
                <button key={t.v} type="button" disabled={isEdit}
                  onClick={() => setKind(t.v)}
                  className="text-left rounded-xl px-3 py-2 border transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  style={{
                    background:  kind === t.v ? 'rgba(0,212,177,0.10)' : 'rgba(255,255,255,0.02)',
                    borderColor: kind === t.v ? '#00D4B1' : 'rgba(255,255,255,0.08)',
                  }}>
                  <div className="text-sm font-bold">{t.label}</div>
                  <div className="text-[10px] text-s-muted">{t.hint}</div>
                </button>
              ))}
            </div>
            {isEdit && <p className="text-[10px] text-s-dim mt-2">Kind is locked on edit — to change it, delete and re-create.</p>}
          </section>

          {/* Lifecycle status — edit mode only. Iteration recipes can be
              submitted for production; sign-off is the CEO's (see approvals). */}
          {isEdit && initial && (
            <section className="rounded-xl border border-s-border bg-s-surface p-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-s-muted">Status</span>
                  <span className="text-[10px] font-black uppercase tracking-wider rounded-full px-2 py-0.5"
                    style={{ background: recipeStatusMeta[initial.status].bg, color: recipeStatusMeta[initial.status].color }}>
                    {recipeStatusMeta[initial.status].label}
                  </span>
                </div>
                {initial.status === 'iteration' && (
                  <button type="button" onClick={() => submitForProd.mutate()} disabled={submitForProd.isPending}
                    className="rounded-lg bg-s-teal text-black px-3 py-1.5 text-xs font-black hover:opacity-90 disabled:opacity-50">
                    {submitForProd.isPending ? 'Submitting…' : 'Submit for production'}
                  </button>
                )}
                {initial.status === 'pending_approval' && (
                  <span className="text-[11px] text-s-muted">Submitted — awaiting CEO approval.</span>
                )}
              </div>
              {initial.status === 'iteration' && initial.rejectionReason && (
                <p className="mt-2 text-[11px]" style={{ color: '#FDB022' }}>
                  Previously sent back by the CEO: “{initial.rejectionReason}”
                </p>
              )}
            </section>
          )}

          {/* Section 1 — Header */}
          <Section title="1 · Recipe header">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Brand always first — it scopes everything below. */}
              <Field label="Brand *">
                <select value={brandId} onChange={(e) => { setBrandId(e.target.value); if (!isEdit) { setMenuItemId(''); setNewItemCategoryId('') } }} className={inputCls} disabled={isEdit}>
                  <option value="">— Pick brand —</option>
                  {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>

              {/* Plate recipes always create their own menu item (opened on
                  approval). An already-live plate shows its item read-only. */}
              {kind === 'plate' ? (
                (isEdit && initial?.menuItemId) ? (
                  <Field label="Menu item">
                    <input value={menuItems.find((m) => m.id === menuItemId)?.name ?? '—'} disabled className={inputCls}/>
                  </Field>
                ) : (
                  <Field label="Menu item name *">
                    <input value={newItemName} onChange={(e) => setNewItemName(e.target.value)}
                      placeholder="e.g. Chimi Shimi" className={inputCls}/>
                  </Field>
                )
              ) : (
                <Field label="Recipe name *">
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Burger sauce" className={inputCls}/>
                </Field>
              )}

              {/* New plate only: description + category for the menu item it'll open */}
              {kind === 'plate' && !isEdit && (
                <>
                  <Field label="Menu category *" hint={brandId ? '' : 'Pick a brand first'}>
                    <select value={newItemCategoryId} onChange={(e) => setNewItemCategoryId(e.target.value)}
                      className={inputCls} disabled={!brandId}>
                      <option value="">{brandId ? '— Pick category —' : '— Pick brand first —'}</option>
                      {brandCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </Field>
                  <div className="md:col-span-2">
                    <Field label="Menu description (optional)" hint="Shows under the item on the customer menu">
                      <input value={newItemDescription} onChange={(e) => setNewItemDescription(e.target.value)}
                        placeholder="e.g. House Brioche | Smash Beef | Chimichurri | American Cheese" className={inputCls}/>
                    </Field>
                  </div>
                </>
              )}
              <Field label={kind === 'plate' ? 'Portions per recipe' : 'Batch yield (grams)'}>
                {kind === 'plate'
                  ? <NumInput value={portions} onChange={setPortions} placeholder="1" className={inputCls}/>
                  : <NumInput value={yieldGrams} onChange={setYieldGrams} placeholder="e.g. 500" className={inputCls}/>}
              </Field>
            </div>
          </Section>

          {/* Section 2 — Ingredients + costing */}
          <Section title="2 · Ingredients & costing" subtitle="Raw items pull cost from the latest PO; components (sub-recipes) pull their cost-per-gram. Yield raises cost — to get the recipe qty you buy qty ÷ yield.">
            <div className="overflow-x-auto rounded-lg border border-s-border">
              <table className="w-full text-xs">
                <thead className="text-s-muted">
                  <tr className="border-b border-s-border">
                    <th className="text-left  px-2 py-2 font-bold">Ingredient</th>
                    <th className="text-right px-2 py-2 font-bold">Yield %</th>
                    <th className="text-right px-2 py-2 font-bold">Cost / g</th>
                    <th className="text-right px-2 py-2 font-bold">Recipe qty (g)</th>
                    <th className="text-right px-2 py-2 font-bold">Raw used (g)</th>
                    <th className="text-right px-2 py-2 font-bold">Recipe cost</th>
                    <th className="text-right px-2 py-2 font-bold">Portion cost</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {ings.map((row, i) => {
                    const cr = computed.rows[i]!
                    const isComp = row.source === 'component'
                    return (
                      <tr key={row.key} className="border-t border-s-border">
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-1">
                            {/* Raw vs Component source — components only on plates. */}
                            {kind === 'plate' ? (
                              <select value={row.source}
                                onChange={(e) => {
                                  const src = e.target.value as 'raw' | 'component'
                                  const next = [...ings]
                                  next[i] = { ...next[i]!, source: src, inventoryItemId: '', prepRecipeId: '' }
                                  setIngs(next)
                                }}
                                className={inputCls + ' w-[5.5rem]'} title="Raw inventory item, or a component sub-recipe">
                                <option value="raw">Raw</option>
                                <option value="component">Component</option>
                              </select>
                            ) : <span className="text-[10px] text-s-dim px-1">Raw</span>}
                            {isComp ? (
                              <select value={row.prepRecipeId}
                                onChange={(e) => {
                                  const next = [...ings]
                                  next[i] = { ...next[i]!, prepRecipeId: e.target.value }
                                  setIngs(next)
                                }}
                                className={inputCls + ' min-w-[150px]'}>
                                <option value="">— Pick component —</option>
                                {prepOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                              </select>
                            ) : (
                              <select value={row.inventoryItemId}
                                onChange={(e) => {
                                  const next = [...ings]
                                  next[i] = { ...next[i]!, inventoryItemId: e.target.value }
                                  setIngs(next)
                                }}
                                className={inputCls + ' min-w-[150px]'}>
                                <option value="">— Pick ingredient —</option>
                                {inventory.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                              </select>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {isComp ? <span className="text-s-dim">n/a</span> : (
                            <NumInput value={row.yieldPctOverride}
                              placeholder={String(cr.inv?.yieldPct ?? 100)}
                              onChange={(v) => {
                                const next = [...ings]
                                next[i] = { ...next[i]!, yieldPctOverride: v }
                                setIngs(next)
                              }}
                              className={inputCls + ' w-16 text-right'}/>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-s-muted">
                          {cr.isCount ? `${fmtPkr(cr.cpgCents)}/u` : fmtPkrPerG(cr.cpgCents)}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <NumInput value={row.quantity} placeholder="0"
                            onChange={(v) => {
                              const next = [...ings]
                              next[i] = { ...next[i]!, quantity: v }
                              setIngs(next)
                            }}
                            className={inputCls + ' w-20 text-right'}/>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-s-dim">
                          {cr.rawUsedG ? cr.rawUsedG.toLocaleString('en', { maximumFractionDigits: 0 }) : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono font-bold">{fmtPkr(cr.costCents)}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-s-muted">{fmtPkr(cr.portionCostCents)}</td>
                        <td className="px-2 py-1.5">
                          <button onClick={() => setIngs(ings.filter((_, j) => j !== i))}
                            disabled={ings.length === 1}
                            className="text-red-400 hover:bg-red-400/10 rounded px-2 disabled:opacity-30">×</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <button onClick={() => setIngs([...ings, blankRow()])}
              className="mt-2 text-xs text-s-teal hover:underline font-bold">+ Add ingredient</button>

            {/* Recipe-level rollup + pricing knobs (folded in from the old Section 3) */}
            <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-3 pt-3 border-t border-s-border">
              <div className="text-[11px]">
                <p className="text-s-dim">Recipe weight</p>
                <p className="font-mono font-bold text-s-text">{computed.recipeWeightG.toLocaleString('en', { maximumFractionDigits: 0 })} g</p>
              </div>
              <div className="text-[11px]">
                <p className="text-s-dim">Portion size {kind === 'plate' ? `(÷ ${portions})` : ''}</p>
                <p className="font-mono font-bold text-s-text">{computed.portionSizeG.toLocaleString('en', { maximumFractionDigits: 1 })} g</p>
              </div>
              <div className="text-[11px]">
                <p className="text-s-dim">Total recipe cost</p>
                <p className="font-mono font-bold text-s-text">{fmtPkr(computed.totalRecipe)}</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <Field label="Q factor %" hint="Waste buffer on total">
                <NumInput value={qFactor} onChange={(v) => setQFactor(v ?? 0)} placeholder="10" className={inputCls}/>
              </Field>
              <Field label="Target profit %" hint="Pre-opex">
                <NumInput value={targetProfit} onChange={(v) => setTargetProfit(v ?? 0)} placeholder="25" className={inputCls}/>
              </Field>
              <Field label="Packaging %" hint="Of selling price">
                <NumInput value={packaging} onChange={(v) => setPackaging(v ?? 0)} placeholder="8" className={inputCls}/>
              </Field>
            </div>
            {allAllergens.length > 0 && (
              <div className="mt-3 text-[11px] text-s-muted">
                Allergens (auto): {allAllergens.map((a) => (
                  <span key={a} className="ml-1 rounded px-1.5 py-0.5 text-[10px]"
                    style={{ background: 'rgba(245,158,11,0.15)', color: '#FDB022' }}>{a}</span>
                ))}
              </div>
            )}
          </Section>

          {/* Section 3 — Method (its own section, below costing) */}
          <Section title="3 · Method"
            subtitle={kind === 'plate'
              ? 'Step-by-step, tagged by station. Read top-to-bottom — e.g. Grill cooks the protein → Assemble builds the bowl → Expo checks it and hands off.'
              : 'General method of preparation (MOP) for this sub-recipe.'}>
            {kind === 'component' ? (
              <textarea value={method} onChange={(e) => setMethod(e.target.value)} rows={5}
                placeholder="e.g. Blend garlic, lemon and olive oil; season; rest 30 min…"
                className={inputCls + ' min-h-[120px]'}/>
            ) : (
              <div className="space-y-2">
                <datalist id="station-suggestions">
                  {brandStations.map((s) => <option key={s.id} value={s.name} />)}
                </datalist>
                {methodSteps.length === 0 && (
                  <p className="text-[11px] text-s-dim">No steps yet — add the first stop on the plate's journey through the kitchen.</p>
                )}
                {methodSteps.map((step, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="mt-2 text-[11px] font-mono text-s-dim w-5 text-right shrink-0">{i + 1}.</span>
                    <input list="station-suggestions" value={step.station}
                      onChange={(e) => {
                        const next = [...methodSteps]; next[i] = { ...next[i]!, station: e.target.value }; setMethodSteps(next)
                      }}
                      placeholder="Station (e.g. Grill)"
                      className={inputCls + ' w-40 shrink-0'}/>
                    <textarea value={step.instruction} rows={2}
                      onChange={(e) => {
                        const next = [...methodSteps]; next[i] = { ...next[i]!, instruction: e.target.value }; setMethodSteps(next)
                      }}
                      placeholder="What happens at this station…"
                      className={inputCls + ' flex-1 min-h-[42px]'}/>
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
                      className="mt-1 text-red-400 hover:bg-red-400/10 rounded px-2 shrink-0">×</button>
                  </div>
                ))}
                <button type="button" onClick={() => setMethodSteps([...methodSteps, { station: '', instruction: '' }])}
                  className="mt-1 text-xs text-s-teal hover:underline font-bold">+ Add step</button>
              </div>
            )}
          </Section>

          {/* Test log — only once the recipe exists (edit mode). */}
          {isEdit && initial && <RecipeTestLog recipeId={initial.id} />}
        </div>

        {/* Cost panel (right) */}
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <CostPanel computed={computed} kind={kind} actualSpPkr={actualSpPkr} setActualSpPkr={setActualSpPkr} />
          <div className="rounded-xl border border-s-border bg-s-surface p-4 text-[11px] text-s-muted">
            <strong className="text-s-text">Heads-up:</strong> Live Opex/Portion isn't shown until save.
            The backend reads current OpexLine entries for {activeConcept?.name ?? 'your brand'} and divides by{' '}
            <strong className="text-s-text">forecast portions/month</strong> ({activeConcept?.forecastPortionsPerMonth ?? '—'}).
            Set that on the brand in <Link href="/settings" className="text-s-teal hover:underline">Tenants &amp; Brands</Link>.
          </div>
          {err && (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400">{err}</div>
          )}
          <div className="flex gap-2">
            <button onClick={() => router.push('/accounting/recipes')}
              className="flex-1 rounded-lg border border-s-border text-s-text py-2.5 text-sm font-bold hover:bg-s-bg">
              Cancel
            </button>
            <button onClick={submit} disabled={save.isPending}
              className="flex-1 rounded-lg bg-s-teal text-black py-2.5 text-sm font-black hover:opacity-90 disabled:opacity-50">
              {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Save recipe'}
            </button>
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
      {subtitle && <p className="text-[11px] text-s-muted mt-0.5 mb-3">{subtitle}</p>}
      {!subtitle && <div className="mb-3"/>}
      {children}
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] font-bold uppercase tracking-wider text-s-muted block mb-1">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-s-dim block mt-1">{hint}</span>}
    </label>
  )
}

interface ComputedShape {
  totalIngredient: number; qFactorCents: number; totalRecipe: number; plateCost: number
  recipeWeightG: number; portionSizeG: number
  opexPerPortion: number; forecastPortions: number
  foodCostPrice: number; breakEven: number; target: number; actualSp: number
  packagingCost: number; contribMargin: number; contribMarginPct: number
  netProfit: number; netProfitPct: number; foodCostPctOfSp: number
  verdict: 'profitable' | 'covers_food_loses_opex' | 'loses_every_plate'
}
function CostPanel({ computed, kind, actualSpPkr, setActualSpPkr }: {
  computed: ComputedShape
  kind: Kind
  actualSpPkr: string
  setActualSpPkr: (v: string) => void
}) {
  const v = computed
  const verdictMeta = {
    profitable:              { label: '✓ Profitable',              color: '#00D4B1', bg: 'rgba(0,212,177,0.10)' },
    covers_food_loses_opex:  { label: '⚠ Covers food, loses opex', color: '#F59E0B', bg: 'rgba(245,158,11,0.10)' },
    loses_every_plate:       { label: '✗ Loses every plate',       color: '#FF4D4F', bg: 'rgba(255,77,79,0.10)' },
  }[v.verdict]

  return (
    <div className="rounded-xl border border-s-border bg-s-surface overflow-hidden">
      <header className="px-4 py-3 border-b border-s-border" style={{ background: verdictMeta.bg }}>
        <p className="text-[10px] uppercase tracking-wider text-s-muted">Verdict</p>
        <p className="text-base font-black mt-0.5" style={{ color: verdictMeta.color }}>{verdictMeta.label}</p>
      </header>

      <div className="p-4 space-y-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-1">Cost build-up</p>
          <Line label="Total ingredient" value={fmtPkr(v.totalIngredient)} />
          <Line label="Q factor" value={fmtPkr(v.qFactorCents)} dim />
          <Line label="Total recipe" value={fmtPkr(v.totalRecipe)} bold />
          <Line label="Plate cost" value={fmtPkr(v.plateCost)} highlight />
          {kind === 'plate' && (
            <Line label="Opex / portion (live on save)" value={v.forecastPortions > 0 ? '—' : 'forecast=0'} dim />
          )}
        </div>

        <div className="pt-3 border-t border-s-border">
          <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-1">Suggested pricing</p>
          <Line label="Food-cost price (legacy)" value={fmtPkr(v.foodCostPrice)} dim />
          <Line label="Break-even" value={fmtPkr(v.breakEven)} />
          <Line label="Target" value={fmtPkr(v.target)} bold highlight />
        </div>

        <div className="pt-3 border-t border-s-border">
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-s-muted block mb-1">Actual selling price (PKR)</span>
            <input type="text" inputMode="decimal" value={actualSpPkr}
              placeholder={String(Math.round(v.target / 100))}
              onChange={(e) => { const raw = e.target.value; if (raw === '' || /^\d*\.?\d*$/.test(raw)) setActualSpPkr(raw) }}
              className="w-full rounded-md border border-s-border bg-s-bg px-3 py-2 text-sm font-mono"/>
            <span className="text-[10px] text-s-dim mt-1 block">Blank = use Target ({fmtPkr(v.target)}).</span>
          </label>
        </div>

        <div className="pt-3 border-t border-s-border">
          <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-1">Profitability</p>
          <Line label="Packaging cost" value={fmtPkr(v.packagingCost)} dim />
          <Line label="Contribution margin" value={`${fmtPkr(v.contribMargin)} · ${fmtPct(v.contribMarginPct)}`} />
          <Line label="Net profit / portion" value={`${fmtPkr(v.netProfit)} · ${fmtPct(v.netProfitPct)}`} bold
            highlightColor={v.netProfit >= 0 ? '#00D4B1' : '#FF4D4F'} />
          <Line label="Food cost % of SP" value={fmtPct(v.foodCostPctOfSp)} dim />
        </div>
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
      <span className={`${bold ? 'font-black' : ''}`} style={{ color: highlight ? (highlightColor ?? '#00D4B1') : undefined }}>
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
    <input
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
      className={className}
    />
  )
}

const inputCls = 'w-full rounded-md border border-s-border bg-s-bg px-3 py-2 text-sm focus:border-s-teal focus:outline-none'
