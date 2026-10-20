'use client'
// Reports → Food cost variance (module food_cost). THE food-cost report: what
// the recipes say the period's sales should have cost at the price actually
// paid (FIFO lots), against what the books charged — split food / drinks /
// packaging, by brand, by order type and by ingredient. One engine in the API
// (GET /reports/food-cost/*); /accounting/food-cost forwards here.
//
// Brand sales and every % are for the finance tier only; everyone else gets
// quantities and PKR at cost (`revenueHidden`). Dates are PKT days.
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { todayPktIso, startOfMonthPktIso } from '../../../lib/money'
import { usePermissions } from '../../../hooks/useCan'
import { CompanySummary } from './components/SummaryTab'
import { IngredientsTab } from './components/IngredientsTab'
import { ValuationTab } from './components/ValuationTab'
import { FlagsTab } from './components/FlagsTab'
import { ErrorNote } from './components/ui'
import type { SummaryResponse } from './components/types'
import { Select } from '@/components/ui/Select'
import { ExportMenu } from '@/components/ui/ExportMenu'

type Tab = 'summary' | 'ingredients' | 'valuation' | 'flags'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'summary', label: 'Summary' }, { key: 'ingredients', label: 'Ingredients' }, { key: 'valuation', label: 'Valuation' }, { key: 'flags', label: 'Flags' },
]

function shiftDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10)
}
const PRESETS: Array<{ label: string; range: () => { from: string; to: string } }> = [
  { label: 'Last 7 days', range: () => ({ from: shiftDays(todayPktIso(), -6), to: todayPktIso() }) },
  { label: 'Last 30 days', range: () => ({ from: shiftDays(todayPktIso(), -29), to: todayPktIso() }) },
  { label: 'This month', range: () => ({ from: startOfMonthPktIso(), to: todayPktIso() }) },
]

export default function FoodCostReportPage() {
  const [tab, setTab] = useState<Tab>('summary')
  const [range, setRange] = useState(() => PRESETS[1]!.range())
  const [conceptId, setConceptId] = useState('')
  const [companyId, setCompanyId] = useState('')
  const [csvErr, setCsvErr] = useState('')
  const { data: me } = usePermissions()

  const qs = useMemo(() => {
    const p = new URLSearchParams({ from: range.from, to: range.to })
    if (conceptId) p.set('conceptId', conceptId)
    return p.toString()
  }, [range, conceptId])

  const { data, error, isLoading } = useQuery<SummaryResponse>({
    queryKey: ['food-cost', 'summary', qs],
    queryFn: () => api.get(`/reports/food-cost/summary?${qs}`),
  })

  const companies = data?.companies ?? []
  const company = companies.find((c) => c.tenantId === companyId) ?? companies[0]
  const brands = useMemo(
    () => companies.flatMap((c) => c.brands.filter((b) => b.conceptId).map((b) => ({ id: b.conceptId!, name: companies.length > 1 ? `${b.name} (${c.companyName})` : b.name }))),
    [companies],
  )
  const companyBrands = company ? company.brands.filter((b) => b.conceptId).map((b) => ({ id: b.conceptId!, name: b.name })) : []

  const exportView = tab === 'ingredients' || tab === 'valuation' ? tab : 'summary'
  const exportQs = (() => {
    const p = new URLSearchParams(qs)
    p.set('view', exportView)
    if (exportView !== 'summary' && company) { p.set('tenantId', company.tenantId); p.delete('conceptId') }
    return p.toString()
  })()

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="border-b border-s-border px-4 py-5 sm:px-6">
        <Link href="/reports" className="text-xs text-s-muted hover:text-s-text">← Reports</Link>
        <p className="mt-2 text-xs text-success">Reports</p>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-s-text">Food cost variance</h1>
            <p className="mt-1 max-w-2xl text-sm text-s-muted">
              What the recipes say the period&apos;s sales should have cost, at the price actually paid for the stock cooked, against what the books charged.
              Food, drinks and packaging; by brand, by order type and by ingredient.
            </p>
          </div>
          <ExportMenu className="s-btn-secondary" path={`/reports/food-cost/export.csv?${exportQs}`} filename={`food-cost-${exportView}-${range.from}-${range.to}`} onError={(m) => setCsvErr(m)} />
        </div>
        {csvErr && <p className="mt-2 text-sm" style={{ color: 'var(--erp-danger)' }}>{csvErr}</p>}

        <div className="mt-4 flex flex-wrap items-end gap-2">
          {PRESETS.map((p) => (
            <button key={p.label} className="s-btn-ghost text-xs" onClick={() => setRange(p.range())}>{p.label}</button>
          ))}
          <label className="text-xs text-s-muted">
            <span className="block">From</span>
            <input type="date" className="s-input w-auto" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} />
          </label>
          <label className="text-xs text-s-muted">
            <span className="block">To</span>
            <input type="date" className="s-input w-auto" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} />
          </label>
          {tab === 'summary' && (
            <label className="text-xs text-s-muted">
              <span className="block">Brand</span>
              <Select className="s-select w-auto" value={conceptId} onChange={(e) => setConceptId(e.target.value)}>
                <option value="">All brands</option>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </label>
          )}
          {tab !== 'summary' && companies.length > 1 && (
            <label className="text-xs text-s-muted">
              <span className="block">Company</span>
              <Select className="s-select w-auto" value={company?.tenantId ?? ''} onChange={(e) => setCompanyId(e.target.value)}>
                {companies.map((c) => <option key={c.tenantId} value={c.tenantId}>{c.companyName}</option>)}
              </Select>
            </label>
          )}
        </div>
        <p className="mt-2 text-[11px] text-s-dim">Days are Pakistan time.{data?.revenueHidden ? ' Sales figures and percentages are shown to finance only — costs are in PKR at cost.' : ''}</p>

        <div className="-mb-px mt-3 flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${tab === t.key ? 'text-primary-ink' : 'border-transparent text-s-muted hover:text-s-text'}`}
              style={tab === t.key ? { borderColor: 'var(--erp-accent)' } : undefined}>
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
        <ErrorNote error={error} />
        {isLoading && <p className="py-10 text-center text-sm text-s-dim">Loading…</p>}
        {!isLoading && !error && companies.length === 0 && <p className="py-10 text-center text-sm text-s-dim">No company in view.</p>}

        {tab === 'summary' && companies.map((c) => (
          <CompanySummary key={c.tenantId} c={c} reasons={data!.wasteReasons} />
        ))}
        {tab === 'ingredients' && company && (
          <IngredientsTab tenantId={company.tenantId} range={range} brands={companyBrands} />
        )}
        {tab === 'valuation' && company && <ValuationTab tenantId={company.tenantId} isCeo={me?.role === 'admin'} />}
        {tab === 'flags' && company && <FlagsTab tenantId={company.tenantId} />}
      </div>
    </div>
  )
}
