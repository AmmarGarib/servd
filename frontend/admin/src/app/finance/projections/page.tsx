'use client'
// Per-brand 12-month P&L projections (replaces the legacy ProForma UI).
//
// Inputs per brand (launch month, check avg, food%, pkg%, daily covers,
// trading days) come from the operator; staff cost + opex + capex are
// pulled live from /positions, /opex, /capex so the projection always
// reflects current org state.
//
// Editing any input PUTs to /projections/:id/brands/:conceptId and
// re-fetches the computed matrix.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'

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
  staffMonthlyCents: number
  opexMonthlyCents: number
  capexTotalCents: number
  months: BrandMonth[]
  year1RevenueCents: number
  year1ProfitCents: number
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
  cumulativeCents: number
}
interface CombinedMonth {
  month: number
  revenueCents: number
  variableCents: number
  staffCents: number
  opexCents: number
  totalCostCents: number
  profitCents: number
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
function fmtPkrFull(cents: number): string {
  return `PKR ${Math.round(cents / 100).toLocaleString('en-PK')}`
}

export default function ProjectionsPage() {
  const qc = useQueryClient()

  // List concepts (for auto-seeding brand rows on first scenario)
  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['concepts-projections'],
    queryFn: () => api.get('/concepts'),
  })

  // List scenarios
  const { data: scenarios = [], isLoading: scenariosLoading } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['projections'],
    queryFn: () => api.get('/projections'),
  })

  // Active scenario selector — defaults to the most recently created one
  const [activeId, setActiveId] = useState<string | null>(null)
  useEffect(() => {
    if (!activeId && scenarios.length > 0) setActiveId(scenarios[0]!.id)
  }, [activeId, scenarios])

  // Auto-create default scenario if none exists
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

  // Fetch computed projection
  const { data: computed, isLoading: computedLoading, refetch } = useQuery<ComputedScenario>({
    queryKey: ['projection-computed', activeId],
    queryFn: () => api.get(`/projections/${activeId}/computed`),
    enabled: !!activeId,
  })

  // Add any missing concepts as brand rows (lets you add a 4th brand later)
  const missingConcepts = useMemo(() => {
    if (!computed) return []
    const have = new Set(computed.brands.map((b) => b.conceptId))
    return concepts.filter((c) => !have.has(c.id))
  }, [computed, concepts])

  const upsertBrand = useMutation({
    mutationFn: ({ conceptId, body }: { conceptId: string; body: Partial<BrandInput> }) =>
      api.put(`/projections/${activeId}/brands/${conceptId}`, body),
    onSuccess: () => void refetch(),
  })

  function patchBrand(conceptId: string, patch: Partial<BrandInput>) {
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
                Per-brand revenue + cost forecast with launch phasing and a 6-month ramp curve.
                Staff cost pulls from <Link href="/workforce" className="text-s-teal hover:underline">Positions</Link>,
                fixed opex from <Link href="/finance/opex" className="text-s-teal hover:underline">OpEx</Link>,
                capex from <Link href="/finance/capex" className="text-s-teal hover:underline">Capex</Link>.
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
            value={fmtPkrFull(summary.year1TotalRevenueCents)}
            hint={`across ${brands.length} brand${brands.length === 1 ? '' : 's'}`}
            color="#00D4B1"
          />
          <SummaryCard
            label="Year-1 combined P&L"
            value={fmtPkrFull(summary.year1CombinedProfitCents)}
            hint={summary.year1CombinedProfitCents >= 0 ? 'profit' : 'loss'}
            color={summary.year1CombinedProfitCents >= 0 ? '#00D4B1' : '#FF4D4F'}
          />
          <SummaryCard
            label="Capital ask"
            value={fmtPkrFull(summary.capitalAskCents)}
            hint={`Capex ${fmtPkr(summary.totalCapexCents)} + 3-mo WC ${fmtPkr(summary.workingCapitalCents)}`}
            color="#6366F1"
          />
          <SummaryCard
            label="Payback period"
            value={summary.paybackMonths != null ? `${(summary.paybackMonths / 12).toFixed(1)} yrs` : '—'}
            hint={summary.paybackMonths != null ? `${summary.paybackMonths} months at steady-state` : 'No profit at Month 12'}
            color="#F59E0B"
          />
        </section>

        {/* ── Brand inputs ────────────────────────────────────────────── */}
        <section>
          <h2 className="text-lg font-black mb-3">Brand inputs</h2>
          <div className="overflow-x-auto rounded-xl border border-s-border bg-s-surface">
            <table className="w-full text-xs">
              <thead className="text-s-muted">
                <tr className="border-b border-s-border">
                  <th className="text-left  px-3 py-2 font-bold">Brand</th>
                  <th className="text-right px-3 py-2 font-bold">Launch month</th>
                  <th className="text-right px-3 py-2 font-bold">Check avg (PKR)</th>
                  <th className="text-right px-3 py-2 font-bold">Days/mo</th>
                  <th className="text-right px-3 py-2 font-bold">Food %</th>
                  <th className="text-right px-3 py-2 font-bold">Pkg %</th>
                  <th className="text-right px-3 py-2 font-bold">Daily covers @ SS</th>
                  <th className="text-right px-3 py-2 font-bold" title="Sum of Position cost-share × headcount where Position.conceptId = this brand">Staff (live)</th>
                  <th className="text-right px-3 py-2 font-bold" title="Sum of OpexLine.amountCents where conceptId = this brand, normalised to monthly">OpEx (live)</th>
                </tr>
              </thead>
              <tbody>
                {brands.map((b) => (
                  <tr key={b.conceptId} className="border-t border-s-border">
                    <td className="px-3 py-2">
                      <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: b.concept.primaryColor ?? '#888' }}/>
                      <span className="font-bold">{b.concept.name}</span>
                    </td>
                    <CellNum value={b.launchMonth} min={1} max={12}
                      onCommit={(v) => patchBrand(b.conceptId, { launchMonth: v })} />
                    <CellNum value={Math.round(b.checkAverageCents / 100)}
                      onCommit={(v) => patchBrand(b.conceptId, { checkAverageCents: v * 100 })} step={50} />
                    <CellNum value={b.tradingDaysPerMonth} min={1} max={31}
                      onCommit={(v) => patchBrand(b.conceptId, { tradingDaysPerMonth: v })} />
                    <CellNum value={b.foodCostPct} step={0.5}
                      onCommit={(v) => patchBrand(b.conceptId, { foodCostPct: v })} suffix="%" />
                    <CellNum value={b.packagingCostPct} step={0.5}
                      onCommit={(v) => patchBrand(b.conceptId, { packagingCostPct: v })} suffix="%" />
                    <CellNum value={b.dailyCoversAtSS} min={0}
                      onCommit={(v) => patchBrand(b.conceptId, { dailyCoversAtSS: v })} />
                    <td className="text-right px-3 py-2 font-mono text-s-muted" title={fmtPkrFull(b.staffMonthlyCents)}>
                      {fmtPkr(b.staffMonthlyCents)}
                    </td>
                    <td className="text-right px-3 py-2 font-mono text-s-muted" title={fmtPkrFull(b.opexMonthlyCents)}>
                      {fmtPkr(b.opexMonthlyCents)}
                    </td>
                  </tr>
                ))}
                {missingConcepts.map((c) => (
                  <tr key={c.id} className="border-t border-s-border opacity-60">
                    <td className="px-3 py-2">
                      <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: c.primaryColor ?? '#888' }}/>
                      <span className="font-bold">{c.name}</span>
                    </td>
                    <td colSpan={8} className="px-3 py-2 text-right">
                      <button onClick={() => patchBrand(c.id, {})}
                        className="text-xs text-s-teal hover:underline">+ Add to projection</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-s-dim mt-2">
            Staff and OpEx are pulled live — edit them in{' '}
            <Link href="/workforce" className="text-s-teal hover:underline">Positions</Link> and{' '}
            <Link href="/finance/opex" className="text-s-teal hover:underline">OpEx</Link> respectively. They feed every brand's
            monthly P&L from its launch month forward.
          </p>
        </section>

        {/* ── Per-brand 12-month matrix ───────────────────────────────── */}
        {brands.map((b) => (
          <BrandMatrix key={b.conceptId} brand={b} months={MONTHS} />
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
                <CombinedRow label="Variable cost" months={combined} pick={(m) => m.variableCents} negative />
                <CombinedRow label="Staff" months={combined} pick={(m) => m.staffCents} negative />
                <CombinedRow label="OpEx" months={combined} pick={(m) => m.opexCents} negative />
                <CombinedRow label="Total cost" months={combined} pick={(m) => m.totalCostCents} negative bold />
                <CombinedRow label="Profit / Loss" months={combined} pick={(m) => m.profitCents} bold highlightSign />
                <CombinedRow label="Cumulative cash" months={combined} pick={(m) => m.cumulativeCents} cumulative highlightSign />
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Ramp curve display ──────────────────────────────────────── */}
        <section className="rounded-xl border border-s-border bg-s-surface p-4">
          <h3 className="text-sm font-bold mb-2">Ramp curve</h3>
          <p className="text-[11px] text-s-muted mb-3">
            Multiplier on steady-state daily covers, applied from each brand's launch month onward.
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

function CellNum({ value, onCommit, min, max, step, suffix }: {
  value: number; onCommit: (v: number) => void
  min?: number; max?: number; step?: number; suffix?: string
}) {
  const [local, setLocal] = useState(String(value))
  useEffect(() => { setLocal(String(value)) }, [value])
  return (
    <td className="text-right px-2 py-1">
      <input
        type="number" value={local} step={step ?? 1} min={min} max={max}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const n = parseFloat(local)
          if (Number.isFinite(n) && n !== value) onCommit(n)
        }}
        className="w-20 rounded bg-s-bg border border-s-border px-2 py-1 text-right text-xs font-mono"
      />
      {suffix && <span className="ml-1 text-s-dim text-[10px]">{suffix}</span>}
    </td>
  )
}

function BrandMatrix({ brand, months }: { brand: BrandInput; months: number[] }) {
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-3">
        <span className="inline-block w-3 h-3 rounded-full" style={{ background: brand.concept.primaryColor ?? '#888' }}/>
        <h2 className="text-lg font-black">{brand.concept.name}</h2>
        <span className="text-xs text-s-muted">
          Launches M{brand.launchMonth} · Steady state M12: profit {fmtPkr(brand.steadyStateMonthlyProfitCents)}/mo
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-s-border bg-s-surface">
        <table className="w-full text-xs font-mono">
          <thead className="text-s-muted">
            <tr className="border-b border-s-border">
              <th className="text-left px-3 py-2 font-bold sticky left-0 bg-s-surface">Line</th>
              {months.map((m) => (
                <th key={m} className="text-right px-3 py-2 font-bold">
                  M{m}{!brand.months[m - 1]!.live && <span className="ml-1 text-[8px] text-s-dim">pre-launch</span>}
                </th>
              ))}
              <th className="text-right px-3 py-2 font-bold">Year 1</th>
            </tr>
          </thead>
          <tbody>
            <BrandRow label="Ramp factor" brand={brand} pick={(m) => m.rampFactor * 100} suffix="%" raw />
            <BrandRow label="Orders" brand={brand} pick={(m) => m.orders} raw />
            <BrandRow label="Revenue" brand={brand} pick={(m) => m.revenueCents} />
            <BrandRow label="Variable cost" brand={brand} pick={(m) => m.variableCents} negative />
            <BrandRow label="Staff" brand={brand} pick={(m) => m.staffCents} negative />
            <BrandRow label="OpEx" brand={brand} pick={(m) => m.opexCents} negative />
            <BrandRow label="Total cost" brand={brand} pick={(m) => m.totalCostCents} negative bold />
            <BrandRow label="Profit / Loss" brand={brand} pick={(m) => m.profitCents} bold highlightSign />
            <BrandRow label="Cumulative" brand={brand} pick={(m) => m.cumulativeCents} cumulative highlightSign />
          </tbody>
        </table>
      </div>
    </section>
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
        const color = highlightSign ? (v >= 0 ? '#00D4B1' : '#FF4D4F') : negative ? '#9CA3AF' : 'inherit'
        return (
          <td key={m.month} className="text-right px-3 py-1.5" style={{ color }}>
            {v === 0 ? <span className="text-s-dim">—</span> : display(v)}
          </td>
        )
      })}
      <td className={`text-right px-3 py-1.5 ${bold || cumulative ? 'font-black' : ''}`}
          style={{ color: highlightSign ? (total >= 0 ? '#00D4B1' : '#FF4D4F') : 'inherit' }}>
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
        const color = highlightSign ? (v >= 0 ? '#00D4B1' : '#FF4D4F') : negative ? '#9CA3AF' : 'inherit'
        return (
          <td key={m.month} className="text-right px-3 py-1.5" style={{ color }}>
            {v === 0 ? <span className="text-s-dim">—</span> : fmtPkr(v)}
          </td>
        )
      })}
      <td className={`text-right px-3 py-1.5 ${bold || cumulative ? 'font-black' : ''}`}
          style={{ color: highlightSign ? (total >= 0 ? '#00D4B1' : '#FF4D4F') : 'inherit' }}>
        {cumulative ? fmtPkr(months[months.length - 1]!.cumulativeCents) : fmtPkr(total)}
      </td>
    </tr>
  )
}
