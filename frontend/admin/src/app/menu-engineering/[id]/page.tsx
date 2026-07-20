'use client'
// Menu Engineering — per-plate pricing workspace.
//
// The recipe owns the COST; this page owns the MONEY. It pulls the plate's
// cost build-up + real opex (opex lines + workforce payroll share) from
// GET /recipes/:id/costing, lets the operator set the target food-cost %
// they want from this item (→ suggested price that hits it), tune packaging
// and profit targets, and set the selling price. Everything recomputes live;
// Save writes the pricing back (price syncs to the menu item).
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { recipeStatusMeta, type RecipeStatus } from '../../accounting/recipes/RecipeForm'

interface CostingReadout {
  recipe: {
    servings: number; qFactorPct: number; packagingPct: number
    targetProfitPct: number; targetFoodCostPct: number
    actualSellingPriceCents: number | null
    menuItemName: string | null
    status: RecipeStatus
  }
  brand: { id: string; name: string; forecastPortionsPerMonth: number } | null
  cost: {
    totalIngredientCents: number
    qFactorCents: number
    totalRecipeCents: number
    plateCostCents: number
    opexPerPortionCents: number
    brandForecastPortions: number
    opexLinesMonthlyCents: number
    payrollShareMonthlyCents: number
    payrollTenantMonthlyCents: number
  }
  pricing: { actualSellingPriceCents: number }
}

function fmtPKR(cents: number) {
  return `PKR ${Math.round(cents / 100).toLocaleString('en-PK')}`
}
function fmtPct(n: number) { return `${n.toFixed(1)}%` }
function fcColor(pct: number | null) {
  if (pct === null) return 'rgba(255,255,255,0.35)'
  if (pct <= 28)    return '#00D4B1'
  if (pct <= 35)    return '#F59E0B'
  return '#FF4D4F'
}

function Line({ label, value, op, bold, dim, color }: {
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

// Free-hand percent/number input (no spinner arrows, blank-friendly).
function Num({ value, onChange, className, placeholder }: {
  value: number | null; onChange: (v: number | null) => void; className?: string; placeholder?: string
}) {
  const [buf, setBuf] = useState<string | null>(null)
  const shown = buf ?? (value == null ? '' : String(value))
  return (
    <input type="text" inputMode="decimal" value={shown} placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value
        if (raw !== '' && !/^\d*\.?\d*$/.test(raw)) return
        setBuf(raw)
        if (raw.trim() === '') { onChange(null); return }
        const n = parseFloat(raw)
        if (Number.isFinite(n)) onChange(n)
      }}
      onBlur={() => setBuf(null)}
      className={className}/>
  )
}

const inputCls = 'w-full rounded-md border border-s-border bg-s-bg px-3 py-2 text-sm font-mono focus:border-s-teal focus:outline-none'

export default function PlatePricingPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()

  const { data, isLoading, isError } = useQuery<CostingReadout>({
    queryKey: ['recipe', id, 'costing'],
    queryFn: () => api.get(`/recipes/${id}/costing`),
  })

  // Editable pricing state, seeded from the readout once loaded.
  const [targetFc, setTargetFc]       = useState<number | null>(null)
  const [targetProfit, setTargetProfit] = useState<number | null>(null)
  const [packaging, setPackaging]     = useState<number | null>(null)
  const [pricePkr, setPricePkr]       = useState<number | null>(null)
  const [seeded, setSeeded]           = useState(false)
  useEffect(() => {
    if (data && !seeded) {
      setTargetFc(data.recipe.targetFoodCostPct)
      setTargetProfit(data.recipe.targetProfitPct)
      setPackaging(data.recipe.packagingPct)
      setPricePkr(data.pricing.actualSellingPriceCents ? Math.round(data.pricing.actualSellingPriceCents / 100) : null)
      setSeeded(true)
    }
  }, [data, seeded])

  const save = useMutation({
    mutationFn: () => api.put(`/recipes/${id}`, {
      targetFoodCostPct: targetFc ?? 30,
      targetProfitPct:   targetProfit ?? 25,
      packagingPct:      packaging ?? 8,
      ...(pricePkr != null ? { actualSellingPriceCents: Math.round(pricePkr * 100) } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recipe', id, 'costing'] })
      void qc.invalidateQueries({ queryKey: ['recipes'] })
    },
    onError: (e: Error) => alert(e.message),
  })

  if (isLoading) return <div className="p-12 text-center text-sm text-s-muted">Loading pricing workspace…</div>
  if (isError || !data) {
    return (
      <div className="p-12 text-center">
        <p className="text-sm text-s-muted">Couldn&apos;t load this plate.</p>
        <button onClick={() => router.push('/menu-engineering')}
          className="mt-3 rounded-lg bg-s-teal text-black px-4 py-2 text-xs font-black">Back to Menu Engineering</button>
      </div>
    )
  }

  const { cost, recipe } = data
  const plate = cost.plateCostCents
  const opex  = cost.opexPerPortionCents

  // ── Live pricing math (client-side, matches the backend formulas) ────────
  const fcPct        = targetFc ?? 30
  const packPct      = (packaging ?? 8) / 100
  const profitPct    = (targetProfit ?? 25) / 100
  const fcTargetCents   = Math.round(plate / Math.max(fcPct / 100, 0.01))
  const breakEvenCents  = Math.round((plate + opex) / Math.max(0.01, 1 - packPct))
  const profitTargetCents = Math.round((plate + opex) / Math.max(0.01, 1 - packPct - profitPct))

  const priceCents = pricePkr != null ? Math.round(pricePkr * 100) : 0
  const packagingCost = Math.round(priceCents * packPct)
  const cm      = priceCents - plate - packagingCost
  const cmPct   = priceCents > 0 ? (cm / priceCents) * 100 : 0
  const net     = cm - opex
  const netPct  = priceCents > 0 ? (net / priceCents) * 100 : 0
  const actualFc = priceCents > 0 ? (plate / priceCents) * 100 : null
  const verdict = priceCents <= 0
    ? { label: 'Set a selling price', color: 'rgba(255,255,255,0.4)', bg: 'rgba(255,255,255,0.04)' }
    : net > 0 ? { label: '✓ Profitable', color: '#00D4B1', bg: 'rgba(0,212,177,0.10)' }
    : cm > 0  ? { label: '⚠ Covers food, loses opex', color: '#F59E0B', bg: 'rgba(245,158,11,0.10)' }
    :           { label: '✗ Loses every plate', color: '#FF4D4F', bg: 'rgba(255,77,79,0.10)' }

  return (
    <div className="min-h-screen bg-s-bg text-s-text">
      <header className="border-b border-s-border bg-s-surface">
        <div className="max-w-6xl mx-auto px-6 py-5">
          <div className="text-xs text-s-muted mb-1">
            <Link href="/menu-engineering" className="hover:text-s-text">← Menu Engineering</Link>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-black">{recipe.menuItemName ?? 'Unnamed plate'}</h1>
            {recipe.status !== 'production' && (
              <span className="text-[10px] font-black uppercase tracking-wider rounded-full px-2 py-0.5"
                style={{ background: recipeStatusMeta[recipe.status].bg, color: recipeStatusMeta[recipe.status].color }}>
                {recipeStatusMeta[recipe.status].label}
              </span>
            )}
            <span className="text-[10px] font-black rounded-full px-2.5 py-1 ml-auto"
              style={{ background: verdict.bg, color: verdict.color }}>{verdict.label}</span>
          </div>
          <p className="text-xs text-s-dim mt-1">
            {data.brand?.name ?? '—'} · cost comes from the{' '}
            <Link href={`/accounting/recipes/${id}`} className="text-s-teal hover:underline">recipe</Link> — this page owns the pricing.
          </p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Left: what the plate costs (read-only here) ────────────────── */}
        <div className="space-y-4">
          <section className="rounded-xl border border-s-border bg-s-surface p-5">
            <h2 className="text-base font-black mb-2">Plate cost</h2>
            <Line label="Ingredient subtotal" value={fmtPKR(cost.totalIngredientCents)} />
            <Line op="+" label={`Q factor (${recipe.qFactorPct}%)`} value={fmtPKR(cost.qFactorCents)} dim />
            <Line op="=" label="Total recipe cost" value={fmtPKR(cost.totalRecipeCents)} bold />
            <Line op="÷" label={`Portions (${recipe.servings})`} value="" dim />
            <Line op="=" label="Plate cost" value={fmtPKR(plate)} bold color="#5EEAD4" />
          </section>

          <section className="rounded-xl border border-s-border bg-s-surface p-5">
            <h2 className="text-base font-black mb-1">OpEx per portion</h2>
            <p className="text-[11px] text-s-muted mb-2">
              Real overheads: brand opex lines + your workforce payroll (last 90 days of posted payroll,
              monthly-ized, this brand&apos;s share by forecast portions).
            </p>
            <Line label="Opex lines (rent, utilities…)" value={fmtPKR(cost.opexLinesMonthlyCents)} dim />
            <Line op="+" label="Workforce payroll (brand share)" value={fmtPKR(cost.payrollShareMonthlyCents)} dim />
            <Line op="=" label="Monthly opex" value={fmtPKR(cost.opexLinesMonthlyCents + cost.payrollShareMonthlyCents)} bold />
            <Line op="÷" label={`Forecast portions / month (${cost.brandForecastPortions || '—'})`} value="" dim />
            <Line op="=" label="OpEx / portion" value={cost.brandForecastPortions > 0 ? fmtPKR(opex) : '—'} bold color="#A5B4FC" />
            {cost.payrollTenantMonthlyCents === 0 && (
              <p className="text-[10px] text-s-dim mt-2">
                No posted payroll runs in the last 90 days — run payroll in{' '}
                <Link href="/payroll" className="text-s-teal hover:underline">Workforce → Payroll</Link> and this fills in automatically.
              </p>
            )}
            {cost.brandForecastPortions === 0 && (
              <p className="text-[10px] mt-2" style={{ color: '#FDB022' }}>
                Set the brand&apos;s forecast portions/month in <Link href="/settings" className="text-s-teal hover:underline">Tenants &amp; Brands</Link> to spread opex per plate.
              </p>
            )}
          </section>

          {/* Break-even volume — where labor/rent stops costing and plates
              become pure margin. Overheads are fixed per month; each plate
              contributes (price − plate cost − packaging); the crossover is
              overheads ÷ contribution. */}
          <section className="rounded-xl border border-s-border bg-s-surface p-5">
            <h2 className="text-base font-black mb-1">Break-even volume</h2>
            <p className="text-[11px] text-s-muted mb-2">
              The plate count where this month&apos;s overheads are fully paid — beyond it,
              every plate&apos;s contribution is pure profit.
            </p>
            {priceCents <= 0 || cm <= 0 ? (
              <p className="text-xs" style={{ color: '#FDB022' }}>
                {priceCents <= 0
                  ? 'Set a selling price to see the break-even volume.'
                  : 'Contribution per plate is zero or negative at this price — no volume breaks even. Raise the price or cut plate cost.'}
              </p>
            ) : (() => {
              const overheadMonthly = cost.opexLinesMonthlyCents + cost.payrollShareMonthlyCents
              const beMonthly = Math.ceil(overheadMonthly / cm)
              const beDaily   = beMonthly / 30
              const forecast  = cost.brandForecastPortions
              const coverage  = forecast > 0 ? forecast / beMonthly : null
              return (
                <>
                  <Line label="Contribution / plate (at this price)" value={fmtPKR(cm)} />
                  <Line op="÷" label="into brand overheads / month" value={fmtPKR(overheadMonthly)} dim />
                  <Line op="=" label="Plates to break even" bold color="#5EEAD4"
                    value={`${beMonthly.toLocaleString('en')} / month · ~${beDaily < 10 ? beDaily.toFixed(1) : Math.ceil(beDaily)} / day`} />
                  <Line label="After that, each plate earns" value={`${fmtPKR(cm)} pure margin`} dim />
                  {coverage !== null && (
                    <p className="text-[10px] mt-2" style={{ color: coverage >= 1 ? '#00D4B1' : '#FF6B6B' }}>
                      {coverage >= 1
                        ? `Your forecast (${forecast.toLocaleString('en')}/month) covers break-even ${coverage.toFixed(1)}× — if this plate alone carried all overheads.`
                        : `Your forecast (${forecast.toLocaleString('en')}/month) is below break-even — this plate alone couldn't carry the overheads.`}
                    </p>
                  )}
                  <p className="text-[10px] text-s-dim mt-1">
                    In reality the whole menu shares the overheads — this shows the pace at which
                    <strong className="text-s-muted"> this plate</strong> pays them down.
                  </p>
                </>
              )
            })()}
          </section>
        </div>

        {/* ── Right: the pricing controls ─────────────────────────────────── */}
        <div className="space-y-4">
          <section className="rounded-xl border border-s-border bg-s-surface p-5">
            <h2 className="text-base font-black mb-1">Price to hit your food-cost target</h2>
            <p className="text-[11px] text-s-muted mb-3">
              Set the food-cost % you want from this item — the price that achieves it updates live.
            </p>
            <div className="flex items-end gap-3 flex-wrap">
              <label className="block">
                <span className="text-[10px] font-bold uppercase tracking-wider text-s-muted block mb-1">Target food cost %</span>
                <Num value={targetFc} onChange={setTargetFc} placeholder="30" className={inputCls + ' w-24 text-right'} />
              </label>
              <div className="flex-1 min-w-[140px]">
                <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-1">Price that hits it</p>
                <p className="text-xl font-black" style={{ color: '#5EEAD4' }}>{fmtPKR(fcTargetCents)}</p>
              </div>
              <button type="button" onClick={() => setPricePkr(Math.round(fcTargetCents / 100))}
                className="rounded-lg bg-s-teal text-black px-3 py-2 text-xs font-black hover:opacity-90">
                Use this price
              </button>
            </div>
            <div className="mt-3 pt-3 border-t border-s-border grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[10px] font-bold uppercase tracking-wider text-s-muted block mb-1">Packaging % of price</span>
                <Num value={packaging} onChange={setPackaging} placeholder="8" className={inputCls + ' text-right'} />
              </label>
              <label className="block">
                <span className="text-[10px] font-bold uppercase tracking-wider text-s-muted block mb-1">Target net profit %</span>
                <Num value={targetProfit} onChange={setTargetProfit} placeholder="25" className={inputCls + ' text-right'} />
              </label>
            </div>
            <div className="mt-2">
              <Line label="Break-even price (covers plate + opex + packaging)" value={fmtPKR(breakEvenCents)} dim />
              <Line label={`Price for ${targetProfit ?? 25}% net profit`} value={fmtPKR(profitTargetCents)} dim />
            </div>
          </section>

          <section className="rounded-xl border border-s-border bg-s-surface p-5">
            <div className="flex items-end gap-3 flex-wrap mb-3">
              <label className="block flex-1 min-w-[140px]">
                <span className="text-[10px] font-bold uppercase tracking-wider text-s-muted block mb-1">Selling price (PKR)</span>
                <Num value={pricePkr} onChange={setPricePkr} placeholder="set price" className={inputCls + ' text-right text-lg font-black'} />
              </label>
              <div className="text-right">
                <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-1">Actual food cost</p>
                <p className="text-xl font-black" style={{ color: fcColor(actualFc) }}>
                  {actualFc !== null ? fmtPct(actualFc) : '—'}
                </p>
              </div>
            </div>
            <Line label="Selling price" value={fmtPKR(priceCents)} bold />
            <Line op="−" label="Plate cost" value={fmtPKR(plate)} />
            <Line op="−" label={`Packaging (${packaging ?? 8}%)`} value={fmtPKR(packagingCost)} dim />
            <Line op="=" label="Contribution margin" bold
              value={`${fmtPKR(cm)} · ${fmtPct(cmPct)}`} color={cm >= 0 ? '#00D4B1' : '#FF4D4F'} />
            <Line op="−" label="OpEx / portion" value={fmtPKR(opex)} dim />
            <Line op="=" label="Net profit / portion" bold
              value={`${fmtPKR(net)} · ${fmtPct(netPct)}`} color={net >= 0 ? '#00D4B1' : '#FF4D4F'} />

            <button onClick={() => save.mutate()} disabled={save.isPending}
              className="mt-4 w-full rounded-lg bg-s-teal text-black py-2.5 text-sm font-black hover:opacity-90 disabled:opacity-50">
              {save.isPending ? 'Saving…' : 'Save pricing'}
            </button>
            <p className="text-[10px] text-s-dim mt-2">Saving syncs the selling price to the menu item.</p>
          </section>
        </div>
      </main>
    </div>
  )
}
