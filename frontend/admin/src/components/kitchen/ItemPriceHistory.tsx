'use client'
// A company stock item's price history (owner, 2026-10-26: "the ingredient sheet shows price history").
// Reads the ONE store (ItemPriceHistory) through the inventory route's own auth — GET /inventory/:id/price-history —
// and highlights the latest cost as "Cost used in recipes" (recipes cost at the latest cost; the books stay FIFO).
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtUnitCost, priceSourceLabel } from '../../lib/unitCost'

interface PriceHistory {
  item: { id: string; name: string; unit: string; masterName?: string | null }
  costsHidden?: boolean
  latest: { costCents: number | null; at: string | null; source: string | null } | null
  rows: Array<{ id: string; at: string; oldCostCents: number | null; newCostCents: number; changePct: number | null; source: string; sourceLabel: string; supplier: { id: string; name: string } | null }>
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' })

export function ItemPriceHistory({ itemId }: { itemId: string }) {
  const { data, isLoading, error } = useQuery<PriceHistory>({
    queryKey: ['inventory', itemId, 'price-history'],
    queryFn: () => api.get<PriceHistory>(`/inventory/${itemId}/price-history`),
  })
  if (isLoading) return <p className="text-xs text-s-muted">Loading price history…</p>
  if (error || !data) return <p className="text-xs text-s-muted">Price history is not available.</p>
  if (data.costsHidden) return null
  const unit = data.item.unit
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-accent px-3 py-2" style={{ background: 'rgb(var(--erp-accent-rgb) / 0.12)' }}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-success">Cost used in recipes</p>
        <p className="text-base font-bold text-s-text">{fmtUnitCost(data.latest?.costCents ?? null, unit)}</p>
        <p className="text-[11px] text-s-muted">
          {data.latest?.at ? `${data.latest.source === 'manual' ? 'Manual cost edit' : data.latest.source === 'estimate' ? 'Typed estimate' : 'Latest purchase'} · ${fmtDate(data.latest.at)}` : data.latest?.source === 'estimate' ? 'Typed estimate (nothing bought yet)' : 'No cost yet'}
        </p>
      </div>
      {data.rows.length === 0 ? <p className="text-xs text-s-muted">No price changes recorded yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-s-muted">
              <tr>
                <th className="py-1 text-left">Date</th>
                <th className="py-1 text-right">Old → new</th>
                <th className="py-1 text-right">Change</th>
                <th className="py-1 text-left pl-3">Source</th>
                <th className="py-1 text-left">Supplier</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="border-t border-s-border">
                  <td className="py-1 whitespace-nowrap">{fmtDate(r.at)}</td>
                  <td className="py-1 text-right font-mono whitespace-nowrap">{fmtUnitCost(r.oldCostCents, null)} → {fmtUnitCost(r.newCostCents, unit)}</td>
                  <td className={`py-1 text-right ${r.changePct == null ? 'text-s-muted' : r.changePct > 0 ? 'text-s-red' : 'text-success'}`}>{r.changePct == null ? '—' : `${r.changePct > 0 ? '+' : ''}${r.changePct}%`}</td>
                  <td className="py-1 pl-3">{priceSourceLabel(r.source, !!r.supplier)}</td>
                  <td className="py-1 text-s-muted">{r.supplier?.name ?? (r.source === 'manual_adjust' ? '—' : 'Manual cost edit')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
