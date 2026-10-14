'use client'
// The kitchen floor's read-only recipe book (wave 3, audit UI-10).
//
// The line cook (boh) reads recipes — GET /recipes and GET /recipes/:id come
// back with `costsHidden: true` and every cost, margin, food-cost and pricing
// field null. Everything else on the recipe pages (create, edit, submit,
// delete, the step editor, the costing readouts, the test log) is managers
// only, so the floor gets these read-only pieces instead: name, yield,
// ingredients with quantities, the method and the service steps. No money.
//
// The only reads here are ones the API gives every recipe reader:
// GET /recipes/:id (a sub-recipe's name) and GET /recipes/:id/steps.
//
// A dish's lines come in two sections (owner's packaging rule, 2026-10-13):
// what goes IN the dish, and what it is packed in ("Pack in"). An add-on
// (modifier) recipe may also take an ingredient OFF the dish — a negative
// quantity, shown as "Removes".

import Link from 'next/link'
import { useQueries, useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { recipeStatusMeta, type RecipeStatus } from './RecipeForm'

// ─── Units ────────────────────────────────────────────────────────────────────
// RecipeIngredient.quantity is in the MEASURE unit (g for items bought by
// weight, ml by volume, pieces for count items); the line's own `unit` column
// is only a label holding the item's PURCHASE unit (backend lib/recipeCost.ts).
// So a cook reads "150 g", never "150 kg": the measure unit comes from the
// stock item's purchase unit. Mirrors measuresPerPurchaseUnit there.
const BULK_MASS   = new Set(['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'])
const BULK_VOLUME = new Set(['l', 'lt', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters'])
const DOZEN       = new Set(['dozen', 'doz', 'dz'])

export function measureUnit(purchaseUnit: string | null | undefined): string {
  const u = (purchaseUnit ?? '').trim().toLowerCase()
  if (BULK_MASS.has(u)) return 'g'
  if (BULK_VOLUME.has(u)) return 'ml'
  if (DOZEN.has(u)) return 'pcs'
  return u
}

const qty = (n: number) => n.toLocaleString('en', { maximumFractionDigits: 2 })

// ─── Ingredients ──────────────────────────────────────────────────────────────

export interface KitchenIngredient {
  id: string
  name: string
  quantity: number
  /** Measure unit (g / ml / pcs) — see measureUnit. */
  unit: string
  /** Fraction 0–1 for a raw line; null for a sub-recipe (already yielded). */
  yieldPct: number | null
  notes: string | null
  /** Set when the line is a sub-recipe — links to its own recipe. */
  subRecipeId: string | null
  /** 'ingredients' (default) | 'packaging' — see splitBySection. */
  section?: string | null
}

/** When a dish's Packaging section is used — the one sentence every recipe screen shows. */
export const PACKAGING_USED_WHEN =
  'Used on takeaway and delivery, on every order at a brand that serves in packaging, and on dine-in when staff tap Box given.'

/** A recipe's lines split into what goes in the dish and what it is packed in. */
export function splitBySection<T extends { section?: string | null }>(rows: T[]): { ingredients: T[]; packaging: T[] } {
  return {
    ingredients: rows.filter((r) => r.section !== 'packaging'),
    packaging:   rows.filter((r) => r.section === 'packaging'),
  }
}

export function KitchenIngredients({ rows, empty = 'No ingredients on this recipe yet.' }: { rows: KitchenIngredient[]; empty?: string }) {
  if (rows.length === 0) {
    return <p className="text-xs text-s-dim">{empty}</p>
  }
  const anyNotes = rows.some((r) => r.notes)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-s-border text-[10px] uppercase tracking-wider text-s-muted">
            <th className="text-left px-3 py-2 font-bold">Ingredient</th>
            <th className="text-right px-3 py-2 font-bold">Quantity</th>
            <th className="text-right px-3 py-2 font-bold">Yield</th>
            {anyNotes && <th className="text-left px-3 py-2 font-bold">Notes</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // To end up with `quantity` usable you start with quantity ÷ yield.
            const trimmed = r.yieldPct != null && r.yieldPct > 0 && r.yieldPct < 1
            return (
              <tr key={r.id} className="border-t border-s-border first:border-t-0">
                <td className="px-3 py-2 text-s-text font-semibold">
                  {r.subRecipeId ? (
                    <span className="inline-flex items-center gap-2 flex-wrap">
                      <Link href={`/accounting/recipes/${r.subRecipeId}`} className="hover:underline">{r.name}</Link>
                      <span className="text-[9px] font-black uppercase tracking-wider rounded-full px-2 py-0.5 bg-primary/10 text-primary-ink">
                        Sub-recipe
                      </span>
                    </span>
                  ) : r.name}
                </td>
                <td className="px-3 py-2 text-right font-mono text-s-text whitespace-nowrap">
                  {r.quantity < 0 && (
                    <span className="mr-1 text-[9px] font-black uppercase tracking-wider text-s-red">Removes</span>
                  )}
                  {qty(Math.abs(r.quantity))}{r.unit ? ` ${r.unit}` : ''}
                </td>
                <td className="px-3 py-2 text-right text-xs whitespace-nowrap">
                  {r.yieldPct == null ? (
                    <span className="text-s-dim">—</span>
                  ) : trimmed && r.quantity > 0 ? (
                    <span className="text-s-amber font-semibold">
                      {Math.round(r.yieldPct * 100)}% · start with {qty(r.quantity / r.yieldPct!)}{r.unit ? ` ${r.unit}` : ''}
                    </span>
                  ) : (
                    <span className="text-s-muted">{Math.round(r.yieldPct * 100)}%</span>
                  )}
                </td>
                {anyNotes && <td className="px-3 py-2 text-xs text-s-muted">{r.notes ?? ''}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Method ───────────────────────────────────────────────────────────────────

export interface MethodStep { station: string; instruction: string }

/** The written method: station-tagged plate steps, free-text MOP, Urdu steps. */
export function KitchenMethod({ methodSteps, steps, stepsUrdu }: {
  methodSteps: MethodStep[] | null | undefined
  steps: string | null | undefined
  stepsUrdu: string | null | undefined
}) {
  const ordered = (methodSteps ?? []).filter((s) => s.instruction?.trim())
  const hasText = !!steps?.trim()
  const hasUrdu = !!stepsUrdu?.trim()
  if (ordered.length === 0 && !hasText && !hasUrdu) {
    return <p className="text-xs text-s-dim">No method written for this recipe yet.</p>
  }
  return (
    <div className="space-y-3">
      {ordered.length > 0 && (
        <ol className="space-y-2">
          {ordered.map((s, i) => (
            <li key={i} className="flex items-start gap-3 text-sm">
              <span className="font-mono text-xs text-s-dim w-5 text-right shrink-0 mt-0.5">{i + 1}.</span>
              <div className="min-w-0">
                {s.station?.trim() && (
                  <span className="text-[10px] font-black uppercase tracking-wider text-primary-ink mr-2">{s.station.trim()}</span>
                )}
                <span className="text-s-text whitespace-pre-wrap">{s.instruction.trim()}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {hasText && <p className="text-sm text-s-text whitespace-pre-wrap">{steps!.trim()}</p>}
      {hasUrdu && (
        <p dir="rtl" className="text-sm text-s-text whitespace-pre-wrap border-t border-s-border pt-3">{stepsUrdu!.trim()}</p>
      )}
    </div>
  )
}

// ─── Service steps (the KDS bump sequence), read-only ─────────────────────────

const PHASES: Array<{ id: string; label: string }> = [
  { id: 'prep_mep',         label: 'Mise en place' },
  { id: 'prep_mop',         label: 'Prep MOP' },
  { id: 'service_cook',     label: 'Service cook' },
  { id: 'service_assemble', label: 'Plate & finish' },
]

interface ServiceStep {
  id: string
  phase: string
  ordinal: number
  station?: { id: string; name: string } | null
  instruction: string
  instructionUrdu: string | null
  estimatedSeconds: number
}

const duration = (sec: number) => (sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec}s`)

/**
 * GET /recipes/:id/steps (every staff role). Same cache key as the managers'
 * RecipeStepsEditor, but nothing here writes. Renders nothing when the recipe
 * has no service steps; `section` boxes it like the detail page's other parts.
 */
export function KitchenServiceSteps({ recipeId, variant = 'inline' }: { recipeId: string; variant?: 'inline' | 'section' }) {
  const { data: steps = [] } = useQuery<ServiceStep[]>({
    queryKey: ['recipe', recipeId, 'steps'],
    queryFn:  () => api.get<ServiceStep[]>(`/recipes/${recipeId}/steps`),
    enabled:  !!recipeId,
  })
  if (steps.length === 0) return null
  const list = (
    <div className="space-y-3">
      {PHASES.map((p) => {
        const inPhase = steps.filter((s) => s.phase === p.id).sort((a, b) => a.ordinal - b.ordinal)
        if (inPhase.length === 0) return null
        return (
          <div key={p.id}>
            <p className="text-[10px] font-black uppercase tracking-wider text-s-muted mb-1">{p.label}</p>
            <ol className="space-y-1.5">
              {inPhase.map((s, i) => (
                <li key={s.id} className="flex items-start gap-3 text-sm">
                  <span className="font-mono text-xs text-s-dim w-5 text-right shrink-0 mt-0.5">{i + 1}.</span>
                  <div className="min-w-0 flex-1">
                    {s.station?.name && (
                      <span className="text-[10px] font-black uppercase tracking-wider text-primary-ink mr-2">{s.station.name}</span>
                    )}
                    <span className="text-s-text">{s.instruction}</span>
                    {s.instructionUrdu && <p dir="rtl" className="text-xs text-s-muted mt-0.5">{s.instructionUrdu}</p>}
                  </div>
                  {s.estimatedSeconds > 0 && (
                    <span className="text-[11px] text-s-dim font-mono shrink-0 mt-0.5">{duration(s.estimatedSeconds)}</span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )
      })}
    </div>
  )
  if (variant === 'section') return <Section title="Service steps">{list}</Section>
  return (
    <div>
      <p className="text-xs font-black uppercase tracking-wider text-s-muted mb-2">Service steps</p>
      {list}
    </div>
  )
}

// ─── The detail page, read-only ───────────────────────────────────────────────

/** GET /recipes/:id as a kitchen floor role receives it (costsHidden). */
export interface KitchenRecipeDetail {
  id: string
  kind: 'plate' | 'component' | 'modifier'
  status: RecipeStatus
  name: string | null
  servings: number
  yieldGrams: number | null
  /** Older plates carry a portion size instead of a total yield. */
  portionSizeG?: number | null
  steps: string | null
  stepsUrdu?: string | null
  methodSteps: MethodStep[] | null
  notes?: string | null
  menuItem: { name?: string; concept?: { name: string } | null } | null
  pendingMenuItem: { name: string } | null
  /** kind 'modifier': the add-on and the dish it belongs to. */
  modifier?: { name: string; group: { name: string; menuItem: { name: string } } } | null
  ingredients: Array<{
    id: string
    inventoryItemId: string | null
    prepRecipeId: string | null
    quantity: number
    yieldPct: number | null
    notes?: string | null
    section?: string | null
    inventoryItem?: { name: string; unit: string } | null
  }>
}

/** Kind badge text and style, one place for every recipe screen. */
export const KIND_META: Record<KitchenRecipeDetail['kind'], { label: string; cls: string }> = {
  plate:     { label: 'Plate',      cls: 'bg-accent-dim text-success' },
  component: { label: 'Sub-recipe', cls: 'bg-primary/10 text-primary-ink' },
  modifier:  { label: 'Add-on',     cls: 'bg-primary/10 text-primary-ink' },
}

/** The Ingredients and Pack in blocks of a recipe, read-only. */
export function KitchenSections({ rows, kind, Wrap }: {
  rows: KitchenIngredient[]
  kind: KitchenRecipeDetail['kind']
  Wrap: (p: { title: string; subtitle?: string; children: React.ReactNode }) => React.ReactElement
}) {
  const { ingredients, packaging } = splitBySection(rows)
  return (
    <>
      <Wrap title={kind === 'modifier' ? 'What this add-on adds or removes' : 'Ingredients'}>
        <KitchenIngredients rows={ingredients} />
      </Wrap>
      {kind === 'plate' && (
        <Wrap title="Pack in" subtitle={PACKAGING_USED_WHEN}>
          <KitchenIngredients rows={packaging} empty="No packaging on this dish." />
        </Wrap>
      )}
    </>
  )
}

export function KitchenRecipeView({ recipe }: { recipe: KitchenRecipeDetail }) {
  // GET /recipes/:id carries no sub-recipe names — look each one up by its own
  // id (a recipe reader may open it; the same read its link leads to).
  const subIds = Array.from(new Set(
    recipe.ingredients.map((i) => i.prepRecipeId).filter((x): x is string => !!x),
  ))
  const subs = useQueries({
    queries: subIds.map((sid) => ({
      queryKey: ['recipe', sid],
      queryFn:  () => api.get<{ id: string; name: string | null }>(`/recipes/${sid}`),
      retry:    false,
      // A missing name falls back to "Sub-recipe" below — no toast.
      meta:     { inlineErrors: true },
    })),
  })
  const subName = new Map<string, string>()
  subIds.forEach((sid, i) => {
    const n = subs[i]?.data?.name
    if (n) subName.set(sid, n)
  })

  const title = recipe.menuItem?.name ?? recipe.pendingMenuItem?.name ?? recipe.name ?? 'Recipe'
  const brand = recipe.menuItem?.concept?.name
    ?? (recipe.modifier ? `${recipe.modifier.group.menuItem.name} — ${recipe.modifier.group.name}` : null)
  const rows: KitchenIngredient[] = recipe.ingredients.map((ing) => ing.prepRecipeId
    ? {
        id: ing.id, name: subName.get(ing.prepRecipeId) ?? 'Sub-recipe', quantity: ing.quantity,
        unit: 'g', yieldPct: null, notes: ing.notes ?? null, subRecipeId: ing.prepRecipeId, section: ing.section,
      }
    : {
        id: ing.id, name: ing.inventoryItem?.name ?? '—', quantity: ing.quantity,
        unit: measureUnit(ing.inventoryItem?.unit), yieldPct: ing.yieldPct ?? 1,
        notes: ing.notes ?? null, subRecipeId: null, section: ing.section,
      })

  // Plates written by the recipe form carry the total yield; older ones a
  // portion size. Show whichever the recipe has.
  const totalG = recipe.yieldGrams
    ?? (recipe.portionSizeG && recipe.servings > 0 ? recipe.portionSizeG * recipe.servings : null)
  const portionG = recipe.portionSizeG
    ?? (recipe.yieldGrams && recipe.servings > 0 ? recipe.yieldGrams / recipe.servings : null)
  const facts: Array<{ label: string; value: string }> = recipe.kind === 'modifier'
    ? [{ label: 'Per', value: 'one add-on' }]
    : recipe.kind === 'plate'
    ? [
        { label: 'Portions per recipe', value: String(recipe.servings) },
        { label: 'Total yield',         value: totalG ? `${qty(totalG)} g` : '—' },
        { label: 'Portion size',        value: portionG ? `${qty(portionG)} g` : '—' },
      ]
    : [
        { label: 'Batch yield', value: recipe.yieldGrams ? `${qty(recipe.yieldGrams)} g` : '—' },
      ]

  return (
    <div className="min-h-screen bg-s-bg text-s-text">
      <header className="border-b border-s-border bg-s-surface">
        <div className="max-w-4xl mx-auto px-6 py-5">
          <div className="text-xs text-s-muted mb-1">
            <Link href="/accounting/recipes" className="hover:text-s-text">← Recipes</Link>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-black">{title}</h1>
            <span className={`text-[9px] font-black uppercase tracking-wider rounded-full px-2 py-0.5 ${KIND_META[recipe.kind].cls}`}>
              {KIND_META[recipe.kind].label}
            </span>
            {recipe.status !== 'production' && (
              <span className="text-[9px] font-black uppercase tracking-wider rounded-full px-2 py-0.5"
                style={{ background: recipeStatusMeta[recipe.status].bg, color: recipeStatusMeta[recipe.status].color }}>
                {recipeStatusMeta[recipe.status].label}
              </span>
            )}
          </div>
          {brand && <p className="text-sm text-s-muted mt-1">{brand}</p>}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-6 space-y-6">
        <section className={`grid gap-3 ${facts.length === 3 ? 'grid-cols-3' : 'grid-cols-1 sm:grid-cols-3'}`}>
          {facts.map((f) => (
            <div key={f.label} className="rounded-xl border border-s-border bg-s-surface px-4 py-3">
              <p className="text-[10px] uppercase tracking-wider text-s-muted">{f.label}</p>
              <p className="text-lg font-black mt-0.5">{f.value}</p>
            </div>
          ))}
        </section>

        <KitchenSections rows={rows} kind={recipe.kind} Wrap={Section} />

        <Section title="Method">
          <KitchenMethod methodSteps={recipe.methodSteps} steps={recipe.steps} stepsUrdu={recipe.stepsUrdu} />
        </Section>

        <KitchenServiceSteps recipeId={recipe.id} variant="section" />

        {recipe.notes?.trim() && (
          <Section title="Notes">
            <p className="text-sm text-s-muted whitespace-pre-wrap">{recipe.notes.trim()}</p>
          </Section>
        )}
      </main>
    </div>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-s-border bg-s-surface p-5">
      <h2 className={`text-base font-black ${subtitle ? '' : 'mb-3'}`}>{title}</h2>
      {subtitle && <p className="text-[11px] text-s-muted mt-0.5 mb-3">{subtitle}</p>}
      {children}
    </section>
  )
}
