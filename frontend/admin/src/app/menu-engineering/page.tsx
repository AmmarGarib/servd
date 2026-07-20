'use client'
// Menu Engineering — the pricing desk for plate recipes.
//
// Recipes (Kitchen → Recipes) are PURE COST: ingredients, yield, Q factor,
// plate cost. This page takes each plate's cost and owns the money side:
// selling price (editable inline, syncs to the menu), contribution margin,
// profit margin, food-cost %. One direction of data flow:
//   recipe → plate cost → [this page] → selling price → menu item.
//
// Clicking a row expands the full price STRUCTURE in place (backed by
// GET /recipes/:id/costing): plate-cost build-up on the left, and the
// price waterfall (selling price − plate cost − packaging = contribution
// margin; − opex = net profit) on the right.
import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { recipeStatusMeta } from '../accounting/recipes/RecipeForm'

interface Concept { id: string; name: string }
interface EngRecipe {
  id: string
  kind: 'plate' | 'component'
  status: 'iteration' | 'pending_approval' | 'production'
  name: string | null
  servings: number
  costPerPortionCents: number | null
  menuItem: { id: string; name: string; priceCents: number; conceptId: string; concept: { name: string } } | null
}

// GET /recipes/:id/costing — the full pricing-spec readout.
interface CostingReadout {
  recipe: { servings: number; qFactorPct: number; packagingPct: number; targetProfitPct: number }
  cost: {
    totalIngredientCents: number
    qFactorCents: number
    totalRecipeCents: number
    plateCostCents: number
    opexPerPortionCents: number
    brandForecastPortions: number
  }
  pricing: {
    breakEvenPriceCents: number
    targetPriceCents: number
    actualSellingPriceCents: number
  }
  profitability: {
    packagingCostCents: number
    contributionMarginCents: number
    contributionMarginPct: number
    netProfitCents: number
    netProfitPct: number
    foodCostPctOfSp: number
    verdict: 'profitable' | 'covers_food_loses_opex' | 'loses_every_plate'
  }
}

const VERDICT_META = {
  profitable:             { label: '✓ Profitable',              color: '#00D4B1', bg: 'rgba(0,212,177,0.10)' },
  covers_food_loses_opex: { label: '⚠ Covers food, loses opex', color: '#F59E0B', bg: 'rgba(245,158,11,0.10)' },
  loses_every_plate:      { label: '✗ Loses every plate',       color: '#FF4D4F', bg: 'rgba(255,77,79,0.10)' },
}

function fmtPKR(cents: number) {
  return `PKR ${Math.round(cents / 100).toLocaleString('en-PK')}`
}
function fmtPct(n: number) { return `${n.toFixed(1)}%` }

// Food-cost % health: same thresholds as the old recipe-page badges.
function fcColor(pct: number | null) {
  if (pct === null) return 'rgba(255,255,255,0.35)'
  if (pct <= 28)    return '#00D4B1'
  if (pct <= 35)    return '#F59E0B'
  return '#FF4D4F'
}

// One line of the expanded structure. `op` renders the −/=/÷ operator gutter.
function StructLine({ label, value, op, bold, dim, color }: {
  label: string; value: string; op?: string; bold?: boolean; dim?: boolean; color?: string
}) {
  return (
    <div className="flex items-baseline gap-2 text-xs font-mono py-1">
      <span className="w-3 text-right shrink-0 text-s-dim">{op ?? ''}</span>
      <span className={dim ? 'text-s-dim' : 'text-s-muted'}>{label}</span>
      <span className={`ml-auto ${bold ? 'font-black' : ''}`} style={{ color }}>{value}</span>
    </div>
  )
}

// Expanded pricing structure for one plate.
function PriceStructure({ recipeId }: { recipeId: string }) {
  const { data, isLoading } = useQuery<CostingReadout>({
    queryKey: ['recipe', recipeId, 'costing'],
    queryFn: () => api.get(`/recipes/${recipeId}/costing`),
  })

  if (isLoading || !data) {
    return <div className="px-6 py-6 text-xs text-s-muted">Loading price structure…</div>
  }

  const { cost, pricing, profitability: pf, recipe } = data
  const verdict = VERDICT_META[pf.verdict]

  return (
    <div className="border-t border-s-border px-5 py-4" style={{ background: 'rgba(255,255,255,0.015)' }}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left — how the plate cost is built (from the recipe) */}
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-s-muted mb-2">Plate cost build-up</p>
          <StructLine label="Ingredient subtotal" value={fmtPKR(cost.totalIngredientCents)} />
          <StructLine op="+" label={`Q factor (${recipe.qFactorPct}%)`} value={fmtPKR(cost.qFactorCents)} dim />
          <StructLine op="=" label="Total recipe cost" value={fmtPKR(cost.totalRecipeCents)} bold />
          <StructLine op="÷" label={`Portions (${recipe.servings})`} value="" dim />
          <StructLine op="=" label="Plate cost" value={fmtPKR(cost.plateCostCents)} bold color="#5EEAD4" />
          <StructLine op="" label="Opex / portion" value={cost.brandForecastPortions > 0 ? fmtPKR(cost.opexPerPortionCents) : 'set brand forecast'} dim />
          <p className="text-[10px] text-s-dim mt-2">
            Cost comes from the recipe —{' '}
            <Link href={`/accounting/recipes/${recipeId}`} className="text-s-teal hover:underline">open recipe →</Link>
          </p>
        </div>

        {/* Right — the price waterfall */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-black uppercase tracking-wider text-s-muted">Price structure</p>
            <span className="text-[10px] font-black rounded-full px-2 py-0.5"
              style={{ background: verdict.bg, color: verdict.color }}>{verdict.label}</span>
          </div>
          <StructLine label="Selling price" value={fmtPKR(pricing.actualSellingPriceCents)} bold />
          <StructLine op="−" label="Plate cost" value={fmtPKR(cost.plateCostCents)} />
          <StructLine op="−" label={`Packaging (${recipe.packagingPct}% of price)`} value={fmtPKR(pf.packagingCostCents)} dim />
          <StructLine op="=" label="Contribution margin" bold
            value={`${fmtPKR(pf.contributionMarginCents)} · ${fmtPct(pf.contributionMarginPct)}`}
            color={pf.contributionMarginCents >= 0 ? '#00D4B1' : '#FF4D4F'} />
          <StructLine op="−" label="Opex / portion" value={fmtPKR(cost.opexPerPortionCents)} dim />
          <StructLine op="=" label="Net profit / portion" bold
            value={`${fmtPKR(pf.netProfitCents)} · ${fmtPct(pf.netProfitPct)}`}
            color={pf.netProfitCents >= 0 ? '#00D4B1' : '#FF4D4F'} />
          <div className="mt-3 pt-2 border-t border-s-border/60">
            <StructLine label="Food cost % of price" value={fmtPct(pf.foodCostPctOfSp)} color={fcColor(pf.foodCostPctOfSp)} />
            <StructLine label="Break-even price" value={fmtPKR(pricing.breakEvenPriceCents)} dim />
            <StructLine label={`Target price (${recipe.targetProfitPct}% profit)`} value={fmtPKR(pricing.targetPriceCents)} dim />
          </div>
        </div>
      </div>
    </div>
  )
}

export default function MenuEngineeringPage() {
  const qc = useQueryClient()
  const [conceptFilter, setConceptFilter] = useState('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  // Local edit buffer: recipeId → price string being typed. Committed on blur/Enter.
  const [draftPrice, setDraftPrice] = useState<Record<string, string>>({})

  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })
  const { data: recipes = [], isLoading } = useQuery<EngRecipe[]>({
    queryKey: ['recipes'],
    queryFn: () => api.get('/recipes'),
  })

  const savePrice = useMutation({
    mutationFn: ({ id, priceCents }: { id: string; priceCents: number }) =>
      api.put(`/recipes/${id}`, { actualSellingPriceCents: priceCents }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['recipes'] })
      // Refresh the expanded structure so the waterfall reflects the new price.
      void qc.invalidateQueries({ queryKey: ['recipe', vars.id, 'costing'] })
    },
    onError: (e: Error) => alert(e.message),
  })

  // Plates only — components are cost inputs, not sellable items.
  const plates = recipes.filter((r) => {
    if (r.kind !== 'plate') return false
    if (conceptFilter && r.menuItem?.conceptId !== conceptFilter) return false
    if (search) {
      const hay = (r.menuItem?.name ?? r.name ?? '').toLowerCase()
      if (!hay.includes(search.toLowerCase())) return false
    }
    return true
  })

  function commitPrice(r: EngRecipe) {
    const raw = draftPrice[r.id]
    if (raw === undefined) return
    const pkr = parseFloat(raw)
    setDraftPrice((d) => { const n = { ...d }; delete n[r.id]; return n })
    if (!Number.isFinite(pkr) || pkr < 0) return
    const cents = Math.round(pkr * 100)
    if (cents === (r.menuItem?.priceCents ?? 0)) return
    savePrice.mutate({ id: r.id, priceCents: cents })
  }

  // Portfolio headline: margins across priced plates.
  const priced = plates.filter((r) => (r.menuItem?.priceCents ?? 0) > 0 && r.costPerPortionCents !== null)
  const avgFc = priced.length
    ? priced.reduce((s, r) => s + (r.costPerPortionCents! / r.menuItem!.priceCents) * 100, 0) / priced.length
    : null
  const overBudget = priced.filter((r) => (r.costPerPortionCents! / r.menuItem!.priceCents) * 100 > 35).length

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs text-s-muted">Kitchen</p>
            <h1 className="text-xl font-bold text-s-text">Menu Engineering</h1>
            <p className="text-xs text-s-dim mt-0.5">
              Click a plate to open its price structure — cost build-up + margin waterfall.
              Set the selling price in the row; it syncs to the menu.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search plates…" className="s-input text-sm h-9 w-52" />
            <select value={conceptFilter} onChange={(e) => setConceptFilter(e.target.value)}
              className="s-select text-sm h-9 w-44">
              <option value="">All Concepts</option>
              {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
      </header>

      <div className="p-6 space-y-4 max-w-7xl mx-auto">
        {/* Portfolio summary */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Priced Plates', value: `${priced.length} / ${plates.length}`, color: 'text-s-text' },
            {
              label: 'Avg Food Cost',
              value: avgFc != null ? fmtPct(avgFc) : '—',
              color: avgFc == null ? 'text-s-muted' : avgFc <= 28 ? 'text-s-teal' : avgFc <= 35 ? 'text-s-amber' : 'text-s-red',
            },
            { label: 'Over 35% FC', value: String(overBudget), color: overBudget ? 'text-s-red' : 'text-s-muted' },
          ].map(({ label, value, color }) => (
            <div key={label} className="s-card px-4 py-3">
              <p className="text-[10px] text-s-muted uppercase tracking-wider">{label}</p>
              <p className={`text-xl font-black mt-0.5 ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-14 rounded-xl" />)}
          </div>
        ) : plates.length === 0 ? (
          <div className="s-card text-center py-16">
            <p className="text-s-dim text-sm">
              No plate recipes yet — build one in <Link href="/accounting/recipes" className="text-s-teal hover:underline">Recipes</Link> and it appears here for pricing.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {plates.map((r) => {
              const isOpen = expanded === r.id
              const plateCost = r.costPerPortionCents
              const price = r.menuItem?.priceCents ?? 0
              const cm = plateCost !== null && price > 0 ? price - plateCost : null
              const cmPct = cm !== null && price > 0 ? (cm / price) * 100 : null
              const fc = plateCost !== null && price > 0 ? (plateCost / price) * 100 : null
              const draft = draftPrice[r.id]
              return (
                <div key={r.id} className="s-card overflow-hidden">
                  {/* Summary row — click to expand the price structure. */}
                  <div
                    className="flex items-center gap-4 px-4 py-3 cursor-pointer select-none"
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    style={{ transition: 'background 0.12s' }}
                  >
                    <span className="text-[10px] text-s-dim shrink-0"
                      style={{ display: 'inline-block', transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'none' }}>
                      ▶
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-s-text text-sm truncate">
                          {r.menuItem?.name ?? r.name ?? '—'}
                        </span>
                        {r.status !== 'production' && (
                          <span className="text-[9px] font-black uppercase tracking-wider rounded-full px-2 py-0.5"
                            style={{ background: recipeStatusMeta[r.status].bg, color: recipeStatusMeta[r.status].color }}>
                            {recipeStatusMeta[r.status].label}
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-s-dim">{r.menuItem?.concept.name ?? 'No menu item yet (testing)'}</p>
                    </div>

                    <div className="flex items-center gap-5 shrink-0">
                      <div className="text-right">
                        <p style={{ fontSize: '9px', letterSpacing: '0.12em' }} className="text-s-muted uppercase">Plate Cost</p>
                        <p className="text-xs font-bold text-s-text">{plateCost !== null ? fmtPKR(plateCost) : '—'}</p>
                      </div>
                      <div className="text-right" onClick={(e) => e.stopPropagation()}>
                        <p style={{ fontSize: '9px', letterSpacing: '0.12em' }} className="text-s-muted uppercase">Selling Price</p>
                        {r.menuItem ? (
                          <input
                            type="text" inputMode="decimal"
                            value={draft ?? (price > 0 ? String(Math.round(price / 100)) : '')}
                            placeholder="set price"
                            onChange={(e) => {
                              const raw = e.target.value
                              if (raw === '' || /^\d*\.?\d*$/.test(raw)) setDraftPrice((d) => ({ ...d, [r.id]: raw }))
                            }}
                            onBlur={() => commitPrice(r)}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                            className="w-24 text-right font-mono rounded-md border border-s-border bg-s-bg px-2 py-1 text-xs focus:border-s-teal focus:outline-none"/>
                        ) : (
                          <p className="text-[10px] text-s-dim">opens with approval</p>
                        )}
                      </div>
                      <div className="text-right" style={{ minWidth: 110 }}>
                        <p style={{ fontSize: '9px', letterSpacing: '0.12em' }} className="text-s-muted uppercase">Contribution</p>
                        <p className="text-xs font-bold font-mono"
                          style={{ color: cm === null ? 'rgba(255,255,255,0.3)' : cm >= 0 ? '#00D4B1' : '#FF4D4F' }}>
                          {cm !== null ? `${fmtPKR(cm)}${cmPct !== null ? ` · ${fmtPct(cmPct)}` : ''}` : '—'}
                        </p>
                      </div>
                      <div className="text-right" style={{ minWidth: 60 }}>
                        <p style={{ fontSize: '9px', letterSpacing: '0.12em' }} className="text-s-muted uppercase">Food Cost</p>
                        <p className="text-xs font-black font-mono" style={{ color: fcColor(fc) }}>
                          {fc !== null ? fmtPct(fc) : '—'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Expanded — the full structure this page exists for. */}
                  {isOpen && <PriceStructure recipeId={r.id} />}
                </div>
              )
            })}
          </div>
        )}

        <p className="text-[11px] text-s-dim">
          Contribution margin = selling price − plate cost − packaging. Net profit also subtracts opex/portion.
          Sales-mix quadrant analysis (Stars / Dogs) lives under{' '}
          <Link href="/accounting/menu-engineering" className="text-s-teal hover:underline">Finance → Sales Quadrants</Link>.
        </p>
      </div>
    </div>
  )
}
