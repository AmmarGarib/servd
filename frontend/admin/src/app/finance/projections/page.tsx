'use client'
// Per-brand 12-month P&L projections, laid out to match the ops model sheet:
//
//   TIMING & CAPACITY INPUTS  (per brand: seats, turn time, utilization,
//     daypart hours → total operating hours → Daily Covers CALCULATED, tax rate)
//   Per-brand block:
//     Inputs (editable) — check avg, trading days, food %, daily covers at SS
//       (pulled from the timing block), packaging %
//     12-Month Projection — Ramp Factor, Monthly Orders, Revenue, MC (Variable
//       Cost), Fixed Costs, Total Opex, Profit, Profit After Tax, Cumulative
//       Cashflow
//
// Staff cost + opex + capex pull live from /positions, /opex, /capex.
// Editing any input PUTs to /projections/:id/brands/:conceptId and re-fetches.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkrWhole } from '../../../lib/money'

interface Concept { id: string; name: string; slug: string; primaryColor: string | null }
interface BrandInput {
  inputId: string
  conceptId: string
  concept: Concept
  launchMonth: number
  checkAverageCents: number
  tradingDaysPerMonth: number
  foodCostPct: number
  packagingCostPct: number
  dailyCoversAtSS: number
  seats: number
  tableTurnHours: number
  seatUtilizationPct: number
  breakfastHours: number
  lunchHours: number
  dinnerHours: number
  taxRatePct: number
  totalOperatingHours: number
  dailyCoversCalculated: number | null
  effectiveDailyCovers: number
  staffMonthlyCents: number
  opexMonthlyCents: number
  capexTotalCents: number
  months: BrandMonth[]
  year1RevenueCents: number
  year1ProfitCents: number
  year1ProfitAfterTaxCents: number
  steadyStateMonthlyProfitCents: number
  steadyStateMonthlyCostCents: number
}
interface BrandMonth {
  month: number
  live: boolean
  rampFactor: number
  orders: number
  revenueCents: number
  variableCents: number
  staffCents: number
  opexCents: number
  totalCostCents: number
  profitCents: number
  profitAfterTaxCents: number
  cumulativeCents: number
}
interface CombinedMonth {
  month: number
  revenueCents: number
  variableCents: number
  staffCents: number
  headOfficeLabourCents?: number
  opexCents: number
  totalCostCents: number
  profitCents: number
  profitAfterTaxCents: number
  cumulativeCents: number
}
interface ComputedScenario {
  projection: { id: string; name: string; rampCurve: number[]; updatedAt: string }
  brands: BrandInput[]
  combined: CombinedMonth[]
  summary: {
    totalCapexCents: number
    workingCapitalCents: number
    capitalAskCents: number
    steadyStateMonthlyCostCents: number
    steadyStateMonthlyProfitCents: number
    year1TotalRevenueCents: number
    year1CombinedProfitCents: number
    paybackMonths: number | null
  }
}

function fmtPkr(cents: number): string {
  const v = cents / 100
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (Math.abs(v) >= 1_000) return `${Math.round(v / 1_000)}k`
  return `${Math.round(v)}`
}

export default function ProjectionsPage() {
  const qc = useQueryClient()

  // Brand list from GET /concepts?view=picker (every staff role, the active
  // brands of its own companies, id + name) — plain /concepts is managers /
  // till only and 403'd for the roles that hold this page (R2-UI-04).
  // Shares the shell BrandPicker's cache key and shape.
  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<Concept[]>('/concepts?view=picker'),
    staleTime: 60_000,
  })

  const { data: scenarios = [], isLoading: scenariosLoading } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['projections'],
    queryFn: () => api.get('/projections'),
  })

  const [activeId, setActiveId] = useState<string | null>(null)
  useEffect(() => {
    if (!activeId && scenarios.length > 0) setActiveId(scenarios[0]!.id)
  }, [activeId, scenarios])

  const createScenario = useMutation({
    mutationFn: (body: { name: string; brands: Array<{ conceptId: string }> }) =>
      api.post<{ id: string }>('/projections', body),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['projections'] })
      setActiveId(created.id)
    },
  })
  useEffect(() => {
    if (!scenariosLoading && scenarios.length === 0 && concepts.length > 0 && !createScenario.isPending) {
      createScenario.mutate({
        name: 'Default scenario',
        brands: concepts.map((c) => ({ conceptId: c.id })),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenariosLoading, scenarios.length, concepts.length])

  const { data: computed, isLoading: computedLoading, refetch } = useQuery<ComputedScenario>({
    queryKey: ['projection-computed', activeId],
    queryFn: () => api.get(`/projections/${activeId}/computed`),
    enabled: !!activeId,
  })

  const missingConcepts = useMemo(() => {
    if (!computed) return []
    const have = new Set(computed.brands.map((b) => b.conceptId))
    return concepts.filter((c) => !have.has(c.id))
  }, [computed, concepts])

  const upsertBrand = useMutation({
    mutationFn: ({ conceptId, body }: { conceptId: string; body: Record<string, number> }) =>
      api.put(`/projections/${activeId}/brands/${conceptId}`, body),
    onSuccess: () => void refetch(),
  })

  function patchBrand(conceptId: string, patch: Record<string, number>) {
    upsertBrand.mutate({ conceptId, body: patch })
  }

  if (scenariosLoading || (!computed && computedLoading)) {
    return <div className="p-12 text-center text-sm text-s-muted">Loading projections…</div>
  }
  if (!computed) {
    return <div className="p-12 text-center text-sm text-s-muted">Creating default scenario…</div>
  }

  const { brands, combined, summary, projection } = computed
  const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

  return (
    <div className="min-h-screen bg-s-bg text-s-text">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <header className="border-b border-s-border bg-s-surface">
        <div className="max-w-7xl mx-auto px-6 py-5">
          <div className="text-xs text-s-muted mb-1">
            <Link href="/finance/capex" className="hover:text-s-text">Project Tracker</Link>
            <span className="mx-2">/</span>
            <span className="text-s-text">Projections</span>
          </div>
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-black">12-month P&L projections</h1>
              <p className="text-sm text-s-muted mt-1 max-w-2xl">
                Timing &amp; capacity drive daily covers; covers × check avg drive revenue.
                Staff cost pulls from <Link href="/workforce" className="text-primary-ink hover:underline">Positions</Link>,
                fixed opex from <Link href="/finance/opex" className="text-primary-ink hover:underline">OpEx</Link>,
                capex from <Link href="/finance/capex" className="text-primary-ink hover:underline">Capex</Link>.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {scenarios.length > 1 && (
                <select value={activeId ?? ''} onChange={(e) => setActiveId(e.target.value)}
                  className="rounded-lg bg-s-surface border border-s-border text-xs px-2 py-1.5">
                  {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
              <span className="text-[10px] text-s-dim">Updated {new Date(projection.updatedAt).toLocaleString()}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-8">

        {/* ── Summary cards ───────────────────────────────────────────── */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard
            label="Year-1 revenue"
            value={fmtPkrWhole(summary.year1TotalRevenueCents)}
            hint={`across ${brands.length} brand${brands.length === 1 ? '' : 's'}`}
            color="var(--erp-primary-ink)"
          />
          <SummaryCard
            label="Year-1 combined P&L"
            value={fmtPkrWhole(summary.year1CombinedProfitCents)}
            hint={summary.year1CombinedProfitCents >= 0 ? 'profit (pre-tax)' : 'loss'}
            color={summary.year1CombinedProfitCents >= 0 ? 'var(--erp-success)' : '#b42318'}
          />
          <SummaryCard
            label="Capital ask"
            value={fmtPkrWhole(summary.capitalAskCents)}
            hint={`Capex ${fmtPkr(summary.totalCapexCents)} + 3-mo WC ${fmtPkr(summary.workingCapitalCents)}`}
            color="var(--erp-secondary)"
          />
          <SummaryCard
            label="Payback period"
            value={summary.paybackMonths != null ? `${(summary.paybackMonths / 12).toFixed(1)} yrs` : '—'}
            hint={summary.paybackMonths != null ? `${summary.paybackMonths} months at steady-state` : 'No profit at Month 12'}
            color="#a15c00"
          />
        </section>

        {/* ── Timing & capacity inputs (per the ops sheet) ─────────────── */}
        <section>
          <h2 className="text-lg font-black mb-1">Timing &amp; capacity inputs</h2>
          <p className="text-[11px] text-s-muted mb-3">
            Daily covers are <strong>calculated</strong>: seats × seat utilization × (total operating hours ÷ table turn time).
            Fill this block in and every brand&apos;s covers flow into its projection automatically. Leave seats at 0 to fall
            back to a manually entered covers number below.
          </p>
          <div className="overflow-x-auto rounded-xl border border-s-border bg-s-surface">
            <table className="w-full text-xs">
              <thead className="text-s-muted">
                <tr className="border-b border-s-border">
                  <th className="text-left px-3 py-2 font-bold min-w-[220px]">Input</th>
                  {brands.map((b) => (
                    <th key={b.conceptId} className="text-right px-3 py-2 font-bold">
                      <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: b.concept.primaryColor ?? '#888' }}/>
                      {b.concept.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <TimingRow label="Seats (max capacity)" brands={brands}
                  get={(b) => b.seats} commit={(b, v) => patchBrand(b.conceptId, { seats: Math.round(v) })} />
                <TimingRow label="Avg table turn time (hrs)" brands={brands} step={0.25}
                  get={(b) => b.tableTurnHours} commit={(b, v) => patchBrand(b.conceptId, { tableTurnHours: v })} />
                <TimingRow label="Seat utilization %" brands={brands} step={1}
                  get={(b) => b.seatUtilizationPct} commit={(b, v) => patchBrand(b.conceptId, { seatUtilizationPct: v })} suffix="%" />
                <TimingRow label="Breakfast (8–12) hrs" brands={brands} step={0.5}
                  get={(b) => b.breakfastHours} commit={(b, v) => patchBrand(b.conceptId, { breakfastHours: v })} />
                <TimingRow label="Lunch (12–4) hrs" brands={brands} step={0.5}
                  get={(b) => b.lunchHours} commit={(b, v) => patchBrand(b.conceptId, { lunchHours: v })} />
                <TimingRow label="Dinner (4–2) hrs" brands={brands} step={0.5}
                  get={(b) => b.dinnerHours} commit={(b, v) => patchBrand(b.conceptId, { dinnerHours: v })} />
                {/* Calculated rows — read-only */}
                <tr className="border-t border-s-border bg-s-bg/40">
                  <td className="px-3 py-2 font-bold">Total operating hours / day</td>
                  {brands.map((b) => (
                    <td key={b.conceptId} className="text-right px-3 py-2 font-mono font-bold">{b.totalOperatingHours}</td>
                  ))}
                </tr>
                <tr className="border-t border-s-border bg-s-bg/40">
                  <td className="px-3 py-2 font-bold">Daily covers (calculated)</td>
                  {brands.map((b) => (
                    <td key={b.conceptId} className="text-right px-3 py-2 font-mono font-black" style={{ color: 'var(--erp-primary-ink)' }}>
                      {b.dailyCoversCalculated ?? <span className="text-s-dim font-normal">— (manual: {b.dailyCoversAtSS})</span>}
                    </td>
                  ))}
                </tr>
                <TimingRow label="Tax rate % (on profit)" brands={brands} step={0.5}
                  get={(b) => b.taxRatePct} commit={(b, v) => patchBrand(b.conceptId, { taxRatePct: v })} suffix="%" />
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Per-brand blocks: inputs + 12-month projection ───────────── */}
        {brands.map((b) => (
          <BrandBlock key={b.conceptId} brand={b} months={MONTHS} patchBrand={patchBrand} />
        ))}
        {missingConcepts.map((c) => (
          <div key={c.id} className="rounded-xl border border-s-border bg-s-surface px-4 py-3 flex items-center justify-between">
            <span className="text-sm">
              <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: c.primaryColor ?? '#888' }}/>
              <span className="font-bold">{c.name}</span>
              <span className="text-s-dim ml-2 text-xs">not in this projection</span>
            </span>
            <button onClick={() => patchBrand(c.id, {})} className="text-xs text-primary-ink hover:underline">+ Add to projection</button>
          </div>
        ))}

        {/* ── Combined view ────────────────────────────────────────────── */}
        <section>
          <h2 className="text-lg font-black mb-3">Combined — all brands</h2>
          <div className="overflow-x-auto rounded-xl border border-s-border bg-s-surface">
            <table className="w-full text-xs font-mono">
              <thead className="text-s-muted">
                <tr className="border-b border-s-border">
                  <th className="text-left px-3 py-2 font-bold sticky left-0 bg-s-surface">Line</th>
                  {MONTHS.map((m) => <th key={m} className="text-right px-3 py-2 font-bold">M{m}</th>)}
                  <th className="text-right px-3 py-2 font-bold">Year 1</th>
                </tr>
              </thead>
              <tbody>
                <CombinedRow label="Revenue" months={combined} pick={(m) => m.revenueCents} />
                <CombinedRow label="MC (variable cost)" months={combined} pick={(m) => m.variableCents} negative />
                <CombinedRow label="Fixed costs" months={combined} pick={(m) => m.staffCents + m.opexCents} negative />
                {/* Head-office seats, net of the JV contribution (owner decision 25) —
                    a company cost no brand carries. Frozen seats are never counted. */}
                <CombinedRow label="Head office labour (net of JV)" months={combined} pick={(m) => m.headOfficeLabourCents ?? 0} negative />
                <CombinedRow label="Total opex" months={combined} pick={(m) => m.totalCostCents} negative bold />
                <CombinedRow label="Profit" months={combined} pick={(m) => m.profitCents} bold highlightSign />
                <CombinedRow label="Profit after tax" months={combined} pick={(m) => m.profitAfterTaxCents} bold highlightSign />
                <CombinedRow label="Cumulative cashflow" months={combined} pick={(m) => m.cumulativeCents} cumulative highlightSign />
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Ramp curve display ──────────────────────────────────────── */}
        <section className="rounded-xl border border-s-border bg-s-surface p-4">
          <h3 className="text-sm font-bold mb-2">Ramp curve</h3>
          <p className="text-[11px] text-s-muted mb-3">
            Multiplier on steady-state daily covers, applied from each brand&apos;s launch month onward.
          </p>
          <div className="grid grid-cols-6 md:grid-cols-12 gap-2">
            {projection.rampCurve.map((r, i) => (
              <div key={i} className="rounded-lg bg-s-bg border border-s-border px-2 py-2 text-center">
                <div className="text-[9px] text-s-dim font-bold uppercase">M{i + 1}</div>
                <div className="text-sm font-black mt-0.5">{(r * 100).toFixed(0)}%</div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SummaryCard({ label, value, hint, color }: { label: string; value: string; hint?: string; color: string }) {
  return (
    <div className="rounded-xl border border-s-border bg-s-surface p-4">
      <p className="text-[10px] uppercase tracking-wider text-s-muted font-bold">{label}</p>
      <p className="text-xl font-black mt-1" style={{ color }}>{value}</p>
      {hint && <p className="text-[10px] text-s-dim mt-0.5">{hint}</p>}
    </div>
  )
}

// One editable row in the timing & capacity table (label + a cell per brand).
function TimingRow({ label, brands, get, commit, step, suffix }: {
  label: string
  brands: BrandInput[]
  get: (b: BrandInput) => number
  commit: (b: BrandInput, v: number) => void
  step?: number
  suffix?: string
}) {
  return (
    <tr className="border-t border-s-border">
      <td className="px-3 py-1.5 text-s-muted">{label}</td>
      {brands.map((b) => (
        <EditCell key={b.conceptId} value={get(b)} onCommit={(v) => commit(b, v)} step={step} suffix={suffix} />
      ))}
    </tr>
  )
}

function EditCell({ value, onCommit, step, suffix }: {
  value: number; onCommit: (v: number) => void; step?: number; suffix?: string
}) {
  const [local, setLocal] = useState(String(value))
  useEffect(() => { setLocal(String(value)) }, [value])
  return (
    <td className="text-right px-2 py-1">
      <input
        type="text" inputMode="decimal" value={local}
        onChange={(e) => { const raw = e.target.value; if (raw === '' || /^\d*\.?\d*$/.test(raw)) setLocal(raw) }}
        onBlur={() => {
          const n = parseFloat(local)
          if (Number.isFinite(n) && n !== value) onCommit(n)
          else setLocal(String(value))
        }}
        className="w-20 rounded bg-s-bg border border-s-border px-2 py-1 text-right text-xs font-mono"
        style={{ color: '#7DB8F0' }}   /* editable = blue, like the sheet */
      />
      {suffix && <span className="ml-1 text-s-dim text-[10px]">{suffix}</span>}
    </td>
  )
}

// Per-brand block: editable inputs strip + the 12-month projection matrix.
function BrandBlock({ brand: b, months, patchBrand }: {
  brand: BrandInput
  months: number[]
  patchBrand: (conceptId: string, patch: Record<string, number>) => void
}) {
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-3">
        <span className="inline-block w-3 h-3 rounded-full" style={{ background: b.concept.primaryColor ?? '#888' }}/>
        <h2 className="text-lg font-black uppercase tracking-wide">{b.concept.name}</h2>
        <span className="text-xs text-s-muted">
          Launches M{b.launchMonth} · Steady state M12: profit {fmtPkr(b.steadyStateMonthlyProfitCents)}/mo
        </span>
      </div>

      {/* Inputs (editable — blue) */}
      <div className="rounded-xl border border-s-border bg-s-surface px-4 py-3 mb-3">
        <p className="text-[10px] uppercase tracking-wider text-s-muted font-bold mb-2">
          {b.concept.name} inputs <span className="normal-case font-normal">(editable — blue)</span>
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <InputPair label="Check avg (PKR)" value={Math.round(b.checkAverageCents / 100)}
            onCommit={(v) => patchBrand(b.conceptId, { checkAverageCents: Math.round(v * 100) })} />
          <InputPair label="Trading days / month" value={b.tradingDaysPerMonth}
            onCommit={(v) => patchBrand(b.conceptId, { tradingDaysPerMonth: Math.round(v) })} />
          <InputPair label="Food cost %" value={b.foodCostPct}
            onCommit={(v) => patchBrand(b.conceptId, { foodCostPct: v })} />
          <InputPair label="Packaging cost %" value={b.packagingCostPct}
            onCommit={(v) => patchBrand(b.conceptId, { packagingCostPct: v })} />
          <InputPair label="Launch month" value={b.launchMonth}
            onCommit={(v) => patchBrand(b.conceptId, { launchMonth: Math.round(v) })} />
          {/* Daily covers: derived from the timing block when filled; manual otherwise */}
          {b.dailyCoversCalculated != null ? (
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] text-s-muted">Daily covers at SS</span>
              <span className="font-mono text-sm font-black" style={{ color: 'var(--erp-primary-ink)' }}>{b.dailyCoversCalculated}</span>
              <span className="text-[10px] text-s-dim">(from timing block)</span>
            </div>
          ) : (
            <InputPair label="Daily covers at SS (manual)" value={b.dailyCoversAtSS}
              onCommit={(v) => patchBrand(b.conceptId, { dailyCoversAtSS: Math.round(v) })} />
          )}
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] text-s-muted">Staff (live)</span>
            <span className="font-mono text-sm text-s-muted" title={fmtPkrWhole(b.staffMonthlyCents)}>{fmtPkr(b.staffMonthlyCents)}/mo</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] text-s-muted">OpEx (live)</span>
            <span className="font-mono text-sm text-s-muted" title={fmtPkrWhole(b.opexMonthlyCents)}>{fmtPkr(b.opexMonthlyCents)}/mo</span>
          </div>
        </div>
      </div>

      {/* 12-Month Projection */}
      <div className="overflow-x-auto rounded-xl border border-s-border bg-s-surface">
        <table className="w-full text-xs font-mono">
          <thead className="text-s-muted">
            <tr className="border-b border-s-border">
              <th className="text-left px-3 py-2 font-bold sticky left-0 bg-s-surface">12-month projection</th>
              {months.map((m) => (
                <th key={m} className="text-right px-3 py-2 font-bold">
                  M{m}{!b.months[m - 1]!.live && <span className="ml-1 text-[8px] text-s-dim">pre-launch</span>}
                </th>
              ))}
              <th className="text-right px-3 py-2 font-bold">Year 1</th>
            </tr>
          </thead>
          <tbody>
            <BrandRow label="Ramp factor" brand={b} pick={(m) => m.rampFactor * 100} suffix="%" raw />
            <BrandRow label="Monthly orders" brand={b} pick={(m) => m.orders} raw />
            <BrandRow label="Revenue" brand={b} pick={(m) => m.revenueCents} />
            <BrandRow label="MC (variable cost)" brand={b} pick={(m) => m.variableCents} negative />
            <BrandRow label="Fixed costs" brand={b} pick={(m) => m.staffCents + m.opexCents} negative />
            <BrandRow label="Total opex" brand={b} pick={(m) => m.totalCostCents} negative bold />
            <BrandRow label="Profit" brand={b} pick={(m) => m.profitCents} bold highlightSign />
            <BrandRow label="Profit after tax" brand={b} pick={(m) => m.profitAfterTaxCents} bold highlightSign />
            <BrandRow label="Cumulative cashflow" brand={b} pick={(m) => m.cumulativeCents} cumulative highlightSign />
          </tbody>
        </table>
      </div>
    </section>
  )
}

function InputPair({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [local, setLocal] = useState(String(value))
  useEffect(() => { setLocal(String(value)) }, [value])
  return (
    <label className="flex items-baseline gap-2">
      <span className="text-[11px] text-s-muted">{label}</span>
      <input
        type="text" inputMode="decimal" value={local}
        onChange={(e) => { const raw = e.target.value; if (raw === '' || /^\d*\.?\d*$/.test(raw)) setLocal(raw) }}
        onBlur={() => {
          const n = parseFloat(local)
          if (Number.isFinite(n) && n !== value) onCommit(n)
          else setLocal(String(value))
        }}
        className="w-20 rounded bg-s-bg border border-s-border px-2 py-1 text-right text-xs font-mono"
        style={{ color: '#7DB8F0' }}
      />
    </label>
  )
}

interface BrandRowProps {
  label: string
  brand: BrandInput
  pick: (m: BrandMonth) => number
  suffix?: string
  raw?: boolean
  negative?: boolean
  bold?: boolean
  cumulative?: boolean
  highlightSign?: boolean
}

function BrandRow({ label, brand, pick, suffix, raw, negative, bold, cumulative, highlightSign }: BrandRowProps) {
  const total = brand.months.reduce((s, m) => s + pick(m), 0)
  const display = (v: number) => {
    if (raw) return suffix === '%' ? v.toFixed(0) + suffix : v.toLocaleString('en-PK')
    return fmtPkr(v)
  }
  return (
    <tr className={`border-t border-s-border ${bold ? 'bg-s-bg/40' : ''}`}>
      <td className={`text-left px-3 py-1.5 sticky left-0 bg-s-surface ${bold ? 'font-black' : ''}`}>{label}</td>
      {brand.months.map((m) => {
        const v = pick(m)
        const color = highlightSign ? (v >= 0 ? 'var(--erp-success)' : '#b42318') : negative ? 'var(--muted)' : 'inherit'
        return (
          <td key={m.month} className="text-right px-3 py-1.5" style={{ color }}>
            {v === 0 ? <span className="text-s-dim">—</span> : display(v)}
          </td>
        )
      })}
      <td className={`text-right px-3 py-1.5 ${bold || cumulative ? 'font-black' : ''}`}
          style={{ color: highlightSign ? (total >= 0 ? 'var(--erp-success)' : '#b42318') : 'inherit' }}>
        {cumulative ? display(brand.months[brand.months.length - 1]!.cumulativeCents) : display(total)}
      </td>
    </tr>
  )
}

function CombinedRow({ label, months, pick, negative, bold, cumulative, highlightSign }: {
  label: string
  months: CombinedMonth[]
  pick: (m: CombinedMonth) => number
  negative?: boolean
  bold?: boolean
  cumulative?: boolean
  highlightSign?: boolean
}) {
  const total = months.reduce((s, m) => s + pick(m), 0)
  return (
    <tr className={`border-t border-s-border ${bold ? 'bg-s-bg/40' : ''}`}>
      <td className={`text-left px-3 py-1.5 sticky left-0 bg-s-surface ${bold ? 'font-black' : ''}`}>{label}</td>
      {months.map((m) => {
        const v = pick(m)
        const color = highlightSign ? (v >= 0 ? 'var(--erp-success)' : '#b42318') : negative ? 'var(--muted)' : 'inherit'
        return (
          <td key={m.month} className="text-right px-3 py-1.5" style={{ color }}>
            {v === 0 ? <span className="text-s-dim">—</span> : fmtPkr(v)}
          </td>
        )
      })}
      <td className={`text-right px-3 py-1.5 ${bold || cumulative ? 'font-black' : ''}`}
          style={{ color: highlightSign ? (total >= 0 ? 'var(--erp-success)' : '#b42318') : 'inherit' }}>
        {cumulative ? fmtPkr(months[months.length - 1]!.cumulativeCents) : fmtPkr(total)}
      </td>
    </tr>
  )
}
