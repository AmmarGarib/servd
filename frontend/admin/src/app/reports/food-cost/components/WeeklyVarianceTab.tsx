'use client'
// Weekly variance (owner card, 2026-10-24: "weekly variance of recipe against
// actual usage"). One company, one Monday–Sunday PKT week, one outlet or the
// whole company: per tracked item, opening + received + transfers in −
// transfers out − closing = actual usage, against what the recipes of the
// dishes sold say; waste, staff meals, comps and prep draws explained; the
// gap in quantity and PKR, worst first. GET /reports/food-cost/variance.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { todayPktIso } from '../../../../lib/money'
import { ErrorNote, Section, pkr, qtyText } from './ui'
import { Select } from '@/components/ui/Select'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { CompactEmptyState } from '../../../../components/ui/CompactEmptyState'

interface QC { qty: number; cents: number }
interface VarianceRow {
  inventoryItemId: string; name: string; unit: string; kind: string; classLabel: string
  opening: QC; received: QC; transfersIn: QC; transfersOut: QC; closing: QC; actual: QC; recipe: QC
  explained: { waste: QC; staffMeals: QC; comps: QC; prep: QC; other: QC; total: QC }
  gap: QC; counted: boolean
}
interface VarianceResponse {
  tenantId: string; locationId: string | null
  week: { startDate: string; endDate: string }
  rows: VarianceRow[]
  totals: { actualCents: number; recipeCents: number; explainedCents: number; gapCents: number }
  sites: Array<{ locationId: string; name: string; totals: { gapCents: number; actualCents: number; recipeCents: number } }>
}
interface LocationLite { id: string; name: string; tenantId?: string | null }

function QtyCell({ v, unit }: { v: QC; unit: string }) {
  if (Math.abs(v.qty) < 1e-9 && v.cents === 0) return <td className="text-right text-s-dim">—</td>
  return <td className="text-right">{qtyText(v.qty, unit)}</td>
}

/** A gap above zero is a loss (red); below zero more was found than the recipes say (amber). */
function gapColor(cents: number): string {
  if (cents > 0) return 'var(--erp-danger)'
  if (cents < 0) return 'var(--erp-warning)'
  return 'var(--erp-success)'
}

export function WeeklyVarianceTab({ tenantId }: { tenantId: string }) {
  const [weekOf, setWeekOf] = useState(() => todayPktIso())
  const [locationId, setLocationId] = useState('')
  const [exportErr, setExportErr] = useState('')

  const { data: locations = [] } = useQuery({ queryKey: ['locations'], queryFn: () => api.get<LocationLite[]>('/locations') })
  const sites = locations.filter((l) => !l.tenantId || l.tenantId === tenantId)

  const qs = new URLSearchParams({ weekOf, ...(locationId ? { locationId } : { tenantId }) }).toString()
  const { data, error, isLoading } = useQuery<VarianceResponse>({
    queryKey: ['food-cost', 'variance', qs],
    queryFn: () => api.get(`/reports/food-cost/variance?${qs}`),
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-s-muted">
          <span className="block">Week of</span>
          <input type="date" className="s-input w-auto" value={weekOf} max={todayPktIso()} onChange={(e) => e.target.value && setWeekOf(e.target.value)} />
        </label>
        <label className="text-xs text-s-muted">
          <span className="block">Outlet</span>
          <Select className="s-select w-auto" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Whole company</option>
            {sites.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </label>
        <ExportMenu className="s-btn-secondary text-sm" path={`/reports/food-cost/variance?${qs}`}
          filename={`weekly-variance-${data?.week.startDate ?? weekOf}`} onError={(m) => setExportErr(m)} />
      </div>
      {exportErr && <p className="text-sm" style={{ color: 'var(--erp-danger)' }}>{exportErr}</p>}
      <ErrorNote error={error} />
      {isLoading && <p className="py-10 text-center text-sm text-s-dim">Loading…</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="metric-card"><p className="metric-label">Actual usage</p><p className="metric-value">{pkr(data.totals.actualCents)}</p></div>
            <div className="metric-card"><p className="metric-label">Recipe usage</p><p className="metric-value">{pkr(data.totals.recipeCents)}</p></div>
            <div className="metric-card"><p className="metric-label">Explained</p><p className="metric-value">{pkr(data.totals.explainedCents)}</p></div>
            <div className="metric-card"><p className="metric-label">Gap</p><p className="metric-value" style={{ color: gapColor(data.totals.gapCents) }}>{pkr(data.totals.gapCents)}</p></div>
          </div>

          {data.sites.length > 0 && (
            <Section title="By outlet" hint="Each outlet's gap for the week, from its own stock.">
              <div className="flex flex-wrap gap-2">
                {data.sites.map((s) => (
                  <button key={s.locationId} className="s-btn-ghost text-xs" onClick={() => setLocationId(s.locationId)}>
                    {s.name}: <span className="ml-1 font-mono" style={{ color: gapColor(s.totals.gapCents) }}>{pkr(s.totals.gapCents)}</span>
                  </button>
                ))}
              </div>
            </Section>
          )}

          <Section title={`Week ${data.week.startDate} to ${data.week.endDate}`}
            hint="Actual = opening + received + transfers in − transfers out − closing. Gap = actual − recipe − explained; worst first. An item not counted this week shows no count difference.">
            {data.rows.length === 0 ? <CompactEmptyState message="Nothing moved this week." /> : (
              <div className="overflow-x-auto">
                <table className="s-table">
                  <thead>
                    <tr>
                      <th>Item</th><th className="text-right">Opening</th><th className="text-right">Received</th>
                      <th className="text-right">Transfers in</th><th className="text-right">Transfers out</th><th className="text-right">Closing</th>
                      <th className="text-right">Actual</th><th className="text-right">Recipe</th><th className="text-right">Explained</th>
                      <th className="text-right">Gap</th><th className="text-right">Gap PKR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.inventoryItemId}>
                        <td>
                          <span className="font-medium">{r.name}</span>
                          <p className="text-[10px] text-s-dim">
                            {r.classLabel}{r.kind === 'prep' ? ' · prep' : ''}{r.counted ? '' : ' · not counted this week'}
                          </p>
                        </td>
                        <QtyCell v={r.opening} unit={r.unit} />
                        <QtyCell v={r.received} unit={r.unit} />
                        <QtyCell v={r.transfersIn} unit={r.unit} />
                        <QtyCell v={r.transfersOut} unit={r.unit} />
                        <QtyCell v={r.closing} unit={r.unit} />
                        <QtyCell v={r.actual} unit={r.unit} />
                        <QtyCell v={r.recipe} unit={r.unit} />
                        <td className="text-right" title={`Waste ${qtyText(r.explained.waste.qty)} · staff meals ${qtyText(r.explained.staffMeals.qty)} · comps ${qtyText(r.explained.comps.qty)} · prep ${qtyText(r.explained.prep.qty)}`}>
                          {qtyText(r.explained.total.qty, r.unit)}
                        </td>
                        <td className="text-right" style={{ color: gapColor(r.gap.cents) }}>{qtyText(r.gap.qty, r.unit)}</td>
                        <td className="text-right font-mono" style={{ color: gapColor(r.gap.cents) }}>{pkr(r.gap.cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  )
}
