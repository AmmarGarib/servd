'use client'
// Recipe creator — per the Pricing Spec PDF.
//   Section 1: header (name, category, brand, portions, photo, method)
//   Section 2: ingredients table (live cost preview per row)
//   Section 3: cost calculation (Total + Q factor + Plate cost + Opex/portion)
//   Section 4: pricing & margins (Break-even, Target, Actual SP)
//   Section 5: profitability readout (CM, Net Profit, Food Cost %, verdict)
//
// All Section 3-5 numbers preview LIVE as the operator types. On save we POST
// the input fields; the backend recomputes and returns the canonical numbers
// from GET /recipes/:id/costing.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'

type Kind = 'plate' | 'prep' | 'component'
type Category = 'main' | 'side' | 'sauce' | 'sub_recipe'

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
  key: string                 // local React key
  inventoryItemId: string
  quantity: number            // in unit-of-inventory (e.g. grams if unit=g)
  yieldPctOverride: number | null
}

const blankRow = (): IngredientRow => ({
  key: Math.random().toString(36).slice(2),
  inventoryItemId: '',
  quantity: 0,
  yieldPctOverride: null,
})

function fmtPkr(cents: number): string {
  return `PKR ${Math.round(cents / 100).toLocaleString('en-PK')}`
}
function fmtPct(pct: number): string {
  return `${pct.toFixed(1)}%`
}

// Mirrors the backend formula in /recipes/:id/costing so the page can show
// numbers live as the user types. The backend is the source of truth on save.
function costPerGramCents(inv: InventoryItem): number {
  const u = inv.unit.toLowerCase()
  if (u === 'kg' || u === 'litres' || u === 'l') return (inv.unitCostCents ?? 0) / 1000
  if (u === 'g'  || u === 'ml')                 return (inv.unitCostCents ?? 0)
  return 0  // 'pcs' etc.
}

export default function NewRecipePage() {
  const router = useRouter()
  const qc = useQueryClient()

  // ── Data sources ────────────────────────────────────────────────────────
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

  // ── Form state ──────────────────────────────────────────────────────────
  const [kind, setKind]                 = useState<Kind>('plate')
  const [name, setName]                 = useState('')
  const [category, setCategory]         = useState<Category>('main')
  const [brandId, setBrandId]           = useState<string>('')
  const [menuItemId, setMenuItemId]     = useState<string>('')
  const [portions, setPortions]         = useState(1)
  const [yieldGrams, setYieldGrams]     = useState(0)   // for prep/component
  const [photoUrl, setPhotoUrl]         = useState('')
  const [method, setMethod]             = useState('')
  const [qFactor, setQFactor]           = useState(10)
  const [targetProfit, setTargetProfit] = useState(25)
  const [packaging, setPackaging]       = useState(8)
  const [actualSpPkr, setActualSpPkr]   = useState<string>('')   // empty = use target
  const [ings, setIngs]                 = useState<IngredientRow[]>([blankRow()])
  const [err, setErr]                   = useState('')

  // Filter menu items down to the picked brand
  const conceptMenu = useMemo(
    () => brandId ? menuItems.filter((m) => m.conceptId === brandId) : menuItems,
    [menuItems, brandId],
  )
  const activeConcept = concepts.find((c) => c.id === brandId)

  // ── Live cost computation (mirrors backend formulas) ───────────────────
  const computed = useMemo(() => {
    const invById = new Map(inventory.map((i) => [i.id, i]))
    const rows = ings.map((row) => {
      const inv = invById.get(row.inventoryItemId)
      if (!inv) return { ...row, inv: null, costCents: 0, allergens: [] as string[] }
      let costCents = 0
      const u = inv.unit.toLowerCase()
      if (u === 'pcs' || u === 'unit' || u === 'each') {
        costCents = (inv.unitCostCents ?? 0) * row.quantity
      } else {
        const cpg = costPerGramCents(inv)
        const yieldFactor = ((row.yieldPctOverride ?? inv.yieldPct) || 100) / 100
        costCents = (row.quantity * cpg) / Math.max(yieldFactor, 0.01)
      }
      return { ...row, inv, costCents: Math.round(costCents), allergens: inv.allergens }
    })
    const totalIngredient = rows.reduce((s, r) => s + r.costCents, 0)
    const qFactorCents    = Math.round(totalIngredient * (qFactor / 100))
    const totalRecipe     = totalIngredient + qFactorCents
    const plateCost       = Math.round(totalRecipe / Math.max(portions, 1))

    // Opex/portion only matters for plate recipes
    const forecastPortions = activeConcept?.forecastPortionsPerMonth ?? 0
    // We don't know brand opex on the client — leave at 0 client-side, the
    // backend fills in the real number from OpexLine. The card on the right
    // shows a "Recomputed on save" hint.
    const opexPerPortion = 0

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
             opexPerPortion, forecastPortions,
             foodCostPrice, breakEven, target, actualSp,
             packagingCost, contribMargin, contribMarginPct,
             netProfit, netProfitPct, foodCostPctOfSp, verdict }
  }, [ings, inventory, qFactor, portions, packaging, targetProfit, actualSpPkr, activeConcept])

  // Aggregate allergens from selected ingredients
  const allAllergens = useMemo(() => {
    const set = new Set<string>()
    for (const r of computed.rows) r.allergens.forEach((a) => set.add(a))
    return Array.from(set).sort()
  }, [computed.rows])

  // ── Save ────────────────────────────────────────────────────────────────
  const save = useMutation({
    mutationFn: () => api.post('/recipes', {
      kind,
      ...(kind === 'plate'
        ? { menuItemId }
        : { name: name.trim(), yieldGrams }),
      servings: portions,
      category,
      photoUrl: photoUrl.trim() || undefined,
      steps: method.trim() || undefined,
      qFactorPct: qFactor,
      targetProfitPct: targetProfit,
      packagingPct: packaging,
      actualSellingPriceCents: actualSpPkr.trim() ? Math.round(parseFloat(actualSpPkr) * 100) : undefined,
      ingredients: ings
        .filter((r) => r.inventoryItemId && r.quantity > 0)
        .map((r) => ({
          inventoryItemId: r.inventoryItemId,
          quantity:        r.quantity,
          unit:            inventory.find((i) => i.id === r.inventoryItemId)?.unit ?? 'g',
          yieldPct:        r.yieldPctOverride ?? null,
        })),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recipes'] })
      router.push('/accounting/recipes')
    },
    onError: (e: Error) => setErr(e.message),
  })

  function submit() {
    setErr('')
    if (kind === 'plate' && !menuItemId) return setErr('Pick a menu item this plate recipe is for.')
    if (kind !== 'plate' && !name.trim()) return setErr('Give the recipe a name.')
    if (kind !== 'plate' && yieldGrams <= 0) return setErr('Set a positive batch yield (grams) for prep/component recipes.')
    if (computed.rows.every((r) => !r.inventoryItemId || r.quantity <= 0)) return setErr('Add at least one ingredient with quantity > 0.')
    save.mutate()
  }

  return (
    <div className="min-h-screen bg-s-bg text-s-text">
      <header className="border-b border-s-border bg-s-surface">
        <div className="max-w-6xl mx-auto px-6 py-5">
          <div className="text-xs text-s-muted mb-1">
            <Link href="/accounting/recipes" className="hover:text-s-text">← Recipes</Link>
          </div>
          <h1 className="text-2xl font-black">New recipe</h1>
          <p className="text-sm text-s-muted mt-1 max-w-2xl">
            One page in, plate cost + suggested price + profitability out. Numbers update live as you edit;
            on save the backend recomputes with current OpEx + ingredient prices.
          </p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* ── LEFT: input columns (2/3 width) ─────────────────────────── */}
        <div className="lg:col-span-2 space-y-6">

          {/* Recipe type chooser */}
          <section className="rounded-xl border border-s-border bg-s-surface p-4">
            <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-2">Recipe type</p>
            <div className="flex gap-2 flex-wrap">
              {([
                { v: 'plate' as Kind,     label: 'Finished plate', hint: 'Goes on a menu, gets sold' },
                { v: 'prep' as Kind,      label: 'Prep',           hint: 'Batch made ahead, sold by gram into plates' },
                { v: 'component' as Kind, label: 'Component',      hint: 'Sub-recipe used inside plates (sauces, doughs)' },
              ]).map((t) => (
                <button key={t.v} type="button" onClick={() => setKind(t.v)}
                  className="text-left rounded-xl px-3 py-2 border transition-colors"
                  style={{
                    background:  kind === t.v ? 'rgba(0,212,177,0.10)' : 'rgba(255,255,255,0.02)',
                    borderColor: kind === t.v ? '#00D4B1' : 'rgba(255,255,255,0.08)',
                  }}>
                  <div className="text-sm font-bold">{t.label}</div>
                  <div className="text-[10px] text-s-muted">{t.hint}</div>
                </button>
              ))}
            </div>
          </section>

          {/* SECTION 1 — Header */}
          <Section title="1 · Recipe header">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {kind === 'plate' ? (
                <Field label="Menu item *">
                  <select value={menuItemId} onChange={(e) => setMenuItemId(e.target.value)} className={inputCls}>
                    <option value="">— Pick from menu —</option>
                    {conceptMenu.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </Field>
              ) : (
                <Field label="Recipe name *">
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Burger sauce" className={inputCls}/>
                </Field>
              )}
              <Field label="Brand *">
                <select value={brandId} onChange={(e) => { setBrandId(e.target.value); setMenuItemId('') }} className={inputCls}>
                  <option value="">— Pick brand —</option>
                  {concepts.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Category">
                <select value={category} onChange={(e) => setCategory(e.target.value as Category)} className={inputCls}>
                  <option value="main">Main</option>
                  <option value="side">Side</option>
                  <option value="sauce">Sauce</option>
                  <option value="sub_recipe">Sub-recipe</option>
                </select>
              </Field>
              <Field label={kind === 'plate' ? 'Portions per recipe *' : 'Batch yield (grams) *'}>
                {kind === 'plate'
                  ? <input type="number" min={1} value={portions} onChange={(e) => setPortions(parseInt(e.target.value) || 1)} className={inputCls}/>
                  : <input type="number" min={0} value={yieldGrams} onChange={(e) => setYieldGrams(parseFloat(e.target.value) || 0)} className={inputCls}/>}
              </Field>
              <Field label="Photo URL (optional)">
                <input value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} placeholder="https://…" className={inputCls}/>
              </Field>
              <div className="md:col-span-2">
                <Field label="Method / instructions (optional)">
                  <textarea value={method} onChange={(e) => setMethod(e.target.value)} rows={3}
                    placeholder="Marinate chicken 12 hrs, char-grill at high heat 4 min/side…"
                    className={inputCls + ' min-h-[80px]'}/>
                </Field>
              </div>
            </div>
          </Section>

          {/* SECTION 2 — Ingredients */}
          <Section title="2 · Ingredients" subtitle="Pick from inventory; cost auto-pulls from latest PO. Edit yield % only if this prep differs from the inventory default.">
            <div className="overflow-x-auto rounded-lg border border-s-border">
              <table className="w-full text-xs">
                <thead className="text-s-muted">
                  <tr className="border-b border-s-border">
                    <th className="text-left  px-2 py-2 font-bold">Ingredient</th>
                    <th className="text-right px-2 py-2 font-bold">Unit</th>
                    <th className="text-right px-2 py-2 font-bold">Cost / unit</th>
                    <th className="text-right px-2 py-2 font-bold">Yield %</th>
                    <th className="text-right px-2 py-2 font-bold">Recipe qty</th>
                    <th className="text-right px-2 py-2 font-bold">Cost</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {ings.map((row, i) => {
                    const inv = inventory.find((it) => it.id === row.inventoryItemId)
                    const computedRow = computed.rows[i]!
                    return (
                      <tr key={row.key} className="border-t border-s-border">
                        <td className="px-2 py-1.5">
                          <select value={row.inventoryItemId}
                            onChange={(e) => {
                              const next = [...ings]
                              next[i] = { ...next[i]!, inventoryItemId: e.target.value }
                              setIngs(next)
                            }}
                            className={inputCls + ' min-w-[180px]'}>
                            <option value="">— Pick ingredient —</option>
                            {inventory.map((it) => (
                              <option key={it.id} value={it.id}>{it.name}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1.5 text-right text-s-muted">{inv?.unit ?? '—'}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-s-muted">
                          {inv?.unitCostCents != null ? fmtPkr(inv.unitCostCents) : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <input type="number" min={0} max={100} step={1}
                            value={row.yieldPctOverride ?? inv?.yieldPct ?? 100}
                            onChange={(e) => {
                              const v = parseFloat(e.target.value)
                              const next = [...ings]
                              next[i] = { ...next[i]!, yieldPctOverride: Number.isFinite(v) ? v : null }
                              setIngs(next)
                            }}
                            className={inputCls + ' w-16 text-right'}/>
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <input type="number" min={0} step={1} value={row.quantity}
                            onChange={(e) => {
                              const next = [...ings]
                              next[i] = { ...next[i]!, quantity: parseFloat(e.target.value) || 0 }
                              setIngs(next)
                            }}
                            className={inputCls + ' w-20 text-right'}/>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono font-bold">
                          {fmtPkr(computedRow.costCents)}
                        </td>
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
            {allAllergens.length > 0 && (
              <div className="mt-3 text-[11px] text-s-muted">
                Allergens (auto): {allAllergens.map((a) => (
                  <span key={a} className="ml-1 rounded px-1.5 py-0.5 text-[10px]"
                    style={{ background: 'rgba(245,158,11,0.15)', color: '#FDB022' }}>{a}</span>
                ))}
              </div>
            )}
          </Section>

          {/* SECTION 3 + 4 — Pricing knobs */}
          <Section title="3 · Pricing knobs">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Q factor %" hint="Waste buffer">
                <input type="number" min={0} max={100} step={0.5} value={qFactor}
                  onChange={(e) => setQFactor(parseFloat(e.target.value) || 0)} className={inputCls}/>
              </Field>
              <Field label="Target profit %" hint="Pre-opex">
                <input type="number" min={0} max={100} step={0.5} value={targetProfit}
                  onChange={(e) => setTargetProfit(parseFloat(e.target.value) || 0)} className={inputCls}/>
              </Field>
              <Field label="Packaging %" hint="Of selling price">
                <input type="number" min={0} max={100} step={0.5} value={packaging}
                  onChange={(e) => setPackaging(parseFloat(e.target.value) || 0)} className={inputCls}/>
              </Field>
            </div>
          </Section>
        </div>

        {/* ── RIGHT: live cost panel (1/3 width) ──────────────────────── */}
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <CostPanel computed={computed} kind={kind} activeConcept={activeConcept} actualSpPkr={actualSpPkr} setActualSpPkr={setActualSpPkr} />
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
              {save.isPending ? 'Saving…' : 'Save recipe'}
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
  opexPerPortion: number; forecastPortions: number
  foodCostPrice: number; breakEven: number; target: number; actualSp: number
  packagingCost: number; contribMargin: number; contribMarginPct: number
  netProfit: number; netProfitPct: number; foodCostPctOfSp: number
  verdict: 'profitable' | 'covers_food_loses_opex' | 'loses_every_plate'
}
function CostPanel({ computed, kind, activeConcept, actualSpPkr, setActualSpPkr }: {
  computed: ComputedShape
  kind: Kind
  activeConcept: Concept | undefined
  actualSpPkr: string
  setActualSpPkr: (v: string) => void
}) {
  const v = computed
  const verdictMeta = {
    profitable:              { label: '✓ Profitable',           color: '#00D4B1', bg: 'rgba(0,212,177,0.10)' },
    covers_food_loses_opex:  { label: '⚠ Covers food, loses opex', color: '#F59E0B', bg: 'rgba(245,158,11,0.10)' },
    loses_every_plate:       { label: '✗ Loses every plate',    color: '#FF4D4F', bg: 'rgba(255,77,79,0.10)' },
  }[v.verdict]

  return (
    <div className="rounded-xl border border-s-border bg-s-surface overflow-hidden">
      <header className="px-4 py-3 border-b border-s-border" style={{ background: verdictMeta.bg }}>
        <p className="text-[10px] uppercase tracking-wider text-s-muted">Verdict</p>
        <p className="text-base font-black mt-0.5" style={{ color: verdictMeta.color }}>{verdictMeta.label}</p>
      </header>

      <div className="p-4 space-y-3">
        {/* Section 3 readout */}
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

        {/* Section 4 readout */}
        <div className="pt-3 border-t border-s-border">
          <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-1">Suggested pricing</p>
          <Line label="Food-cost price (legacy)" value={fmtPkr(v.foodCostPrice)} dim />
          <Line label="Break-even" value={fmtPkr(v.breakEven)} />
          <Line label="Target" value={fmtPkr(v.target)} bold highlight />
        </div>

        {/* Actual SP input */}
        <div className="pt-3 border-t border-s-border">
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-s-muted block mb-1">Actual selling price (PKR)</span>
            <input type="number" min={0} step={50} value={actualSpPkr}
              placeholder={String(Math.round(v.target / 100))}
              onChange={(e) => setActualSpPkr(e.target.value)}
              className="w-full rounded-md border border-s-border bg-s-bg px-3 py-2 text-sm font-mono"/>
            <span className="text-[10px] text-s-dim mt-1 block">Blank = use Target ({fmtPkr(v.target)}).</span>
          </label>
        </div>

        {/* Section 5 readout */}
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

const inputCls = 'w-full rounded-md border border-s-border bg-s-bg px-3 py-2 text-sm focus:border-s-teal focus:outline-none'
