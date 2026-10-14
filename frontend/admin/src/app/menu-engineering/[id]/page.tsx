'use client'
// Menu Engineering — per-plate pricing workspace.
//
// The recipe owns the COST; this page owns the MONEY. It pulls the plate's
// cost build-up + real opex (opex lines + workforce payroll share) from
// GET /recipes/:id/costing, lets the operator set the target food-cost %
// they want from this item (→ suggested price that hits it) and the profit
// target, and set the selling price. Everything recomputes live; Save writes
// the pricing back (price syncs to the menu item).
//
// Packaging is the recipe's own Packaging section (real items at the price
// paid), used by order type: takeaway and delivery always, dine-in only at a
// brand that serves in packaging. The retired "packaging % of price" is gone.
// The Q factor is a pricing allowance — in menu pricing, not stock.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { recipeStatusMeta, type RecipeStatus } from '../../accounting/recipes/RecipeForm'
import { fmtPkrWhole } from '../../../lib/money'
import { useKitchenRole } from '../../inventory/kitchenView'

// Material cost per portion (wave B, GET /recipes/:id/costing — read at the
// top level or inside `cost`; absent on an older API).
interface McFields {
  stockByClass?: { food: number; beverage: number; packaging: number }
  packagingCents?: number
  standardCents?: number
  qCents?: number
  targetMcCents?: { dine_in: number; takeout: number; delivery: number }
}

interface CostingReadout extends McFields {
  ingredients?: Array<{ id: string; name: string; quantity: number; unit: string; ingredientCostCents: number; section?: string | null }>
  recipe: {
    servings: number; qFactorPct: number
    targetProfitPct: number; targetFoodCostPct: number
    actualSellingPriceCents: number | null
    menuItemName: string | null
    status: RecipeStatus
  }
  brand: { id: string; name: string; forecastPortionsPerMonth: number } | null
  cost: McFields & {
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

function fmtPct(n: number) { return `${n.toFixed(1)}%` }
/** Plate cost % against the item's own target: green on/under, amber within 5 points, red over. */
function fcColor(pct: number | null, target: number) {
  if (pct === null) return 'rgb(var(--fg-rgb) / 0.35)'
  if (pct <= target)     return 'var(--erp-success)'
  if (pct <= target + 5) return 'var(--erp-warning)'
  return 'var(--erp-danger)'
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

const inputCls = 'w-full rounded-md border border-s-border bg-s-bg px-3 py-2 text-sm font-mono focus:border-primary focus:outline-none'

export default function PlatePricingPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()

  // The pricing readout is managers' (GET /:id/costing); a line cook is not
  // sent to ask for it.
  const role = useKitchenRole()
  const { data, isLoading, isError } = useQuery<CostingReadout>({
    queryKey: ['recipe', id, 'costing'],
    queryFn: () => api.get(`/recipes/${id}/costing`),
    enabled: role.settled && !role.kitchen,
  })

  // Editable pricing state, seeded from the readout once loaded.
  const [targetFc, setTargetFc]       = useState<number | null>(null)
  const [targetProfit, setTargetProfit] = useState<number | null>(null)
  const [pricePkr, setPricePkr]       = useState<number | null>(null)
  const [seeded, setSeeded]           = useState(false)
  useEffect(() => {
    if (data && !seeded) {
      setTargetFc(data.recipe.targetFoodCostPct)
      setTargetProfit(data.recipe.targetProfitPct)
      setPricePkr(data.pricing.actualSellingPriceCents ? Math.round(data.pricing.actualSellingPriceCents / 100) : null)
      setSeeded(true)
    }
  }, [data, seeded])

  const save = useMutation({
    mutationFn: () => api.put(`/recipes/${id}`, {
      targetFoodCostPct: targetFc ?? 30,
      targetProfitPct:   targetProfit ?? 25,
      ...(pricePkr != null ? { actualSellingPriceCents: Math.round(pricePkr * 100) } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recipe', id, 'costing'] })
      void qc.invalidateQueries({ queryKey: ['recipes'] })
    },
    onError: (e: Error) => alert(e.message),
  })

  if (role.kitchen) {
    return (
      <div className="p-12 text-center">
        <p className="text-sm text-s-muted">Plate pricing is kept by managers.</p>
        <Link href="/accounting/recipes" className="mt-3 inline-block text-xs text-primary-ink hover:underline">Open the recipe book</Link>
      </div>
    )
  }
  if (!role.settled || isLoading) return <div className="p-12 text-center text-sm text-s-muted">Loading pricing workspace…</div>
  if (isError || !data) {
    return (
      <div className="p-12 text-center">
        <p className="text-sm text-s-muted">Couldn&apos;t load this plate.</p>
        <button onClick={() => router.push('/menu-engineering')}
          className="mt-3 rounded-lg bg-primary text-primary-on px-4 py-2 text-xs font-black">Back to Menu Engineering</button>
      </div>
    )
  }

  const { cost, recipe } = data
  const opex  = cost.opexPerPortionCents

  // ── Material cost (MC) per portion ───────────────────────────────────────
  // standard = food + drinks every sale uses; packaging = the Packaging
  // section; target MC per order type = standard + packaging where it applies.
  // The Q factor is priced in, never stock. An older API without these fields
  // falls back to the plate cost (Q included, no packaging lines).
  const mc: McFields = { ...cost, ...data }
  const hasMc = mc.standardCents != null && mc.targetMcCents != null
  const standard  = hasMc ? mc.standardCents! : cost.plateCostCents
  const packCents = hasMc ? (mc.packagingCents ?? 0) : 0
  const qCents    = hasMc ? (mc.qCents ?? 0) : 0
  const target    = hasMc ? mc.targetMcCents! : { dine_in: standard, takeout: standard, delivery: standard }
  const servesInPackaging = hasMc && packCents > 0 && target.dine_in > standard
  const packagingLines = (data.ingredients ?? []).filter((l) => l.section === 'packaging')
  // The brand's main order type prices the plate: dine-in at a plate brand,
  // and the box always at a brand that serves in packaging.
  const plate = target.dine_in + qCents

  // ── Live pricing math (client-side, matches the backend formulas) ────────
  const fcPct        = targetFc ?? 30
  const profitPct    = (targetProfit ?? 25) / 100
  const fcTargetCents   = Math.round(plate / Math.max(fcPct / 100, 0.01))
  const breakEvenCents  = Math.round(plate + opex)
  const profitTargetCents = Math.round((plate + opex) / Math.max(0.01, 1 - profitPct))

  const priceCents = pricePkr != null ? Math.round(pricePkr * 100) : 0
  const cm      = priceCents - plate
  const cmPct   = priceCents > 0 ? (cm / priceCents) * 100 : 0
  const net     = cm - opex
  const netPct  = priceCents > 0 ? (net / priceCents) * 100 : 0
  const platePct = priceCents > 0 ? (plate / priceCents) * 100 : null
  const byType: Array<{ label: string; mc: number }> = [
    { label: 'Dine-in', mc: target.dine_in }, { label: 'Takeaway', mc: target.takeout }, { label: 'Delivery', mc: target.delivery },
  ]
  const verdict = priceCents <= 0
    ? { label: 'Set a selling price', color: 'rgb(var(--fg-rgb) / 0.4)', bg: 'rgb(var(--fg-rgb) / 0.04)' }
    : net > 0 ? { label: 'Profitable', color: 'var(--erp-success)', bg: 'rgb(var(--erp-accent-rgb) / 0.16)' }
    : cm > 0  ? { label: 'Covers food, loses opex', color: 'var(--erp-warning)', bg: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)' }
    :           { label: 'Loses every plate', color: 'var(--erp-danger)', bg: 'color-mix(in srgb, var(--erp-danger) 10%, transparent)' }

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
            <Link href={`/accounting/recipes/${id}`} className="text-primary-ink hover:underline">recipe</Link> — this page owns the pricing.
          </p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Left: what the plate costs (read-only here) ────────────────── */}
        <div className="space-y-4">
          <section className="rounded-xl border border-s-border bg-s-surface p-5">
            <h2 className="text-base font-black mb-2">Plate cost</h2>
            <Line label="Food and drinks (every sale)" value={fmtPkrWhole(standard)} />
            {packagingLines.length > 0
              ? packagingLines.map((l) => (
                <Line key={l.id} op="+" label={`Packaging: ${l.name} (${l.quantity} ${l.unit})`} value={fmtPkrWhole(l.ingredientCostCents)} dim />
              ))
              : hasMc && <Line op="+" label="Packaging section" value={packCents > 0 ? fmtPkrWhole(packCents) : 'none'} dim />}
            {hasMc && (
              <p className="text-[10px] text-s-dim pl-5 pb-1">
                {servesInPackaging
                  ? 'This brand serves in packaging — every order uses it.'
                  : 'Used on takeaway and delivery, and on dine-in when staff tap Box given.'}
              </p>
            )}
            {hasMc && <Line op="+" label={`Q factor (${recipe.qFactorPct}%) — in menu pricing, not stock`} value={fmtPkrWhole(qCents)} dim />}
            <Line op="=" label={servesInPackaging ? 'Plate cost (with its packaging)' : 'Plate cost (dine-in)'} value={fmtPkrWhole(plate)} bold color="var(--erp-success)" />
            {hasMc && (
              <div className="mt-2 border-t border-s-border pt-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-1">Material cost by order type (Q not included)</p>
                {byType.map((t) => <Line key={t.label} label={t.label} value={fmtPkrWhole(t.mc)} dim />)}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-s-border bg-s-surface p-5">
            <h2 className="text-base font-black mb-1">OpEx per portion</h2>
            <p className="text-[11px] text-s-muted mb-2">
              Real overheads: brand opex lines + your workforce payroll (last 90 days of posted payroll,
              monthly-ized, this brand&apos;s share by forecast portions).
            </p>
            <Line label="Opex lines (rent, utilities…)" value={fmtPkrWhole(cost.opexLinesMonthlyCents)} dim />
            <Line op="+" label="Workforce payroll (brand share)" value={fmtPkrWhole(cost.payrollShareMonthlyCents)} dim />
            <Line op="=" label="Monthly opex" value={fmtPkrWhole(cost.opexLinesMonthlyCents + cost.payrollShareMonthlyCents)} bold />
            <Line op="÷" label={`Forecast portions / month (${cost.brandForecastPortions || '—'})`} value="" dim />
            <Line op="=" label="OpEx / portion" value={cost.brandForecastPortions > 0 ? fmtPkrWhole(opex) : '—'} bold color="var(--erp-primary-ink)" />
            {cost.payrollTenantMonthlyCents === 0 && (
              <p className="text-[10px] text-s-dim mt-2">
                No posted payroll runs in the last 90 days — run payroll in{' '}
                <Link href="/hr/payroll" className="text-primary-ink hover:underline">HR → Payroll</Link> and this fills in automatically.
              </p>
            )}
            {cost.brandForecastPortions === 0 && (
              <p className="text-[10px] mt-2" style={{ color: 'var(--erp-warning)' }}>
                Set the brand&apos;s forecast portions/month in <Link href="/settings" className="text-primary-ink hover:underline">Tenants &amp; Brands</Link> to spread opex per plate.
              </p>
            )}
          </section>

          {/* Break-even volume — where labor/rent stops costing and plates
              become pure margin. Overheads are fixed per month; each plate
              contributes (price − plate cost); the crossover is
              overheads ÷ contribution. */}
          <section className="rounded-xl border border-s-border bg-s-surface p-5">
            <h2 className="text-base font-black mb-1">Break-even volume</h2>
            <p className="text-[11px] text-s-muted mb-2">
              The plate count where this month&apos;s overheads are fully paid — beyond it,
              every plate&apos;s contribution is pure profit.
            </p>
            {priceCents <= 0 || cm <= 0 ? (
              <p className="text-xs" style={{ color: 'var(--erp-warning)' }}>
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
                  <Line label="Contribution / plate (at this price)" value={fmtPkrWhole(cm)} />
                  <Line op="÷" label="into brand overheads / month" value={fmtPkrWhole(overheadMonthly)} dim />
                  <Line op="=" label="Plates to break even" bold color="var(--erp-success)"
                    value={`${beMonthly.toLocaleString('en')} / month · ~${beDaily < 10 ? beDaily.toFixed(1) : Math.ceil(beDaily)} / day`} />
                  <Line label="After that, each plate earns" value={`${fmtPkrWhole(cm)} pure margin`} dim />
                  {coverage !== null && (
                    <p className="text-[10px] mt-2" style={{ color: coverage >= 1 ? 'var(--erp-success)' : 'var(--erp-danger)' }}>
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
                <p className="text-xl font-black" style={{ color: 'var(--erp-success)' }}>{fmtPkrWhole(fcTargetCents)}</p>
              </div>
              <button type="button" onClick={() => setPricePkr(Math.round(fcTargetCents / 100))}
                className="rounded-lg bg-primary text-primary-on px-3 py-2 text-xs font-black hover:opacity-90">
                Use this price
              </button>
            </div>
            <div className="mt-3 pt-3 border-t border-s-border grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[10px] font-bold uppercase tracking-wider text-s-muted block mb-1">Target net profit %</span>
                <Num value={targetProfit} onChange={setTargetProfit} placeholder="25" className={inputCls + ' text-right'} />
              </label>
            </div>
            <div className="mt-2">
              <Line label="Break-even price (covers plate + opex)" value={fmtPkrWhole(breakEvenCents)} dim />
              <Line label={`Price for ${targetProfit ?? 25}% net profit`} value={fmtPkrWhole(profitTargetCents)} dim />
            </div>
          </section>

          <section className="rounded-xl border border-s-border bg-s-surface p-5">
            <div className="flex items-end gap-3 flex-wrap mb-3">
              <label className="block flex-1 min-w-[140px]">
                <span className="text-[10px] font-bold uppercase tracking-wider text-s-muted block mb-1">Selling price (PKR)</span>
                <Num value={pricePkr} onChange={setPricePkr} placeholder="set price" className={inputCls + ' text-right text-lg font-black'} />
              </label>
              <div className="text-right">
                <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-1">Plate cost % of price</p>
                <p className="text-xl font-black" style={{ color: fcColor(platePct, fcPct) }}>
                  {platePct !== null ? fmtPct(platePct) : '—'}
                </p>
              </div>
            </div>
            <Line label="Selling price" value={fmtPkrWhole(priceCents)} bold />
            <Line op="−" label="Plate cost" value={fmtPkrWhole(plate)} />
            <Line op="=" label="Contribution margin" bold
              value={`${fmtPkrWhole(cm)} · ${fmtPct(cmPct)}`} color={cm >= 0 ? 'var(--erp-success)' : 'var(--erp-danger)'} />
            <Line op="−" label="OpEx / portion" value={fmtPkrWhole(opex)} dim />
            <Line op="=" label="Net profit / portion" bold
              value={`${fmtPkrWhole(net)} · ${fmtPct(netPct)}`} color={net >= 0 ? 'var(--erp-success)' : 'var(--erp-danger)'} />
            {hasMc && priceCents > 0 && !servesInPackaging && packCents > 0 && (
              <p className="text-[10px] text-s-dim mt-1">
                Takeaway and delivery also use the packaging: contribution {fmtPkrWhole(priceCents - target.takeout - qCents)} a portion.
              </p>
            )}

            <button onClick={() => save.mutate()} disabled={save.isPending}
              className="mt-4 w-full rounded-lg bg-primary text-primary-on py-2.5 text-sm font-black hover:opacity-90 disabled:opacity-50">
              {save.isPending ? 'Saving…' : 'Save pricing'}
            </button>
            <p className="text-[10px] text-s-dim mt-2">Saving syncs the selling price to the menu item.</p>
          </section>
        </div>
      </main>
    </div>
  )
}
