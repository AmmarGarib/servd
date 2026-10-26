'use client'
// Use-by — the expiring-soon list (owner B6, 2026-10-26). Reads GET /inventory/expiring (the companies in view, per
// outlet): lots past their use-by and lots due within the chosen window, soonest first. "Log waste" opens the page's
// own waste drawer with reason "expired" — this list never writes stock itself. ERP tokens only.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Select } from '@/components/ui/Select'
import { CompactEmptyState } from '../ui/CompactEmptyState'

export interface ExpiringRow {
  lotId: string; tenantId: string; inventoryItemId: string; name: string; unit: string
  locationId: string | null; locationName: string | null
  useBy: string; daysLeft: number; status: 'expired' | 'today' | 'soon'
  remainingQty: number; remainingValueCents?: number
}
interface ExpiringResponse { today: string; days: number; expiredCount: number; items: ExpiringRow[]; costsHidden?: true }

const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

function whenText(r: ExpiringRow): string {
  if (r.status === 'expired') return `Expired ${-r.daysLeft} day${r.daysLeft === -1 ? '' : 's'} ago`
  if (r.status === 'today') return 'Use today'
  return r.daysLeft === 1 ? 'Use by tomorrow' : `${r.daysLeft} days left`
}

export function ExpiringLots({ outlets, initialLocationId, canWaste, onWaste }: {
  outlets: Array<{ id: string; name: string }>
  initialLocationId?: string
  canWaste: boolean
  onWaste: (row: ExpiringRow) => void
}) {
  const [days, setDays] = useState(3)
  const [locationId, setLocationId] = useState(initialLocationId ?? '')
  const { data, isLoading, error } = useQuery<ExpiringResponse>({
    queryKey: ['inventory-expiring', days, locationId],
    queryFn: () => api.get(`/inventory/expiring?days=${days}${locationId ? `&locationId=${encodeURIComponent(locationId)}` : ''}`),
  })
  const rows = data?.items ?? []
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <p className="text-sm font-bold text-s-text">Use-by: expiring soon</p>
          <p className="text-xs text-s-muted mt-0.5">Perishable deliveries carry a use-by date. Use these first; log what cannot be used as waste (expired).</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {outlets.length > 1 && (
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="s-input w-auto text-sm" aria-label="Outlet">
              <option value="">All outlets</option>
              {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          )}
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="s-input w-auto text-sm" aria-label="Window">
            {[1, 3, 7, 14].map((d) => <option key={d} value={d}>Next {d} day{d === 1 ? '' : 's'}</option>)}
          </Select>
        </div>
      </div>
      {error ? <p className="text-sm" style={{ color: 'var(--erp-danger)' }}>{(error as Error).message}</p> : null}
      {isLoading ? <p className="text-sm text-s-muted">Loading…</p> : rows.length === 0 ? (
        <CompactEmptyState message="Nothing expiring" detail={`No stock is past its use-by or due in the next ${days} day${days === 1 ? '' : 's'}.`} />
      ) : (
        <div className="rounded-xl border border-s-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted">
              <tr>
                <th className="px-3 py-2 text-left">Item</th>
                <th className="px-3 py-2 text-left">Outlet</th>
                <th className="px-3 py-2 text-left">Use by</th>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-right">Left in lot</th>
                {!data?.costsHidden && <th className="px-3 py-2 text-right">Value</th>}
                {canWaste && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.lotId} className="border-t border-s-border">
                  <td className="px-3 py-2 text-s-text">{r.name}</td>
                  <td className="px-3 py-2 text-s-muted">{r.locationName ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.useBy}</td>
                  <td className="px-3 py-2">
                    <span className={r.status === 'expired' ? 's-badge-red' : r.status === 'today' ? 's-badge-amber' : 's-badge-purple'}>{whenText(r)}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{r.remainingQty} {r.unit}</td>
                  {!data?.costsHidden && <td className="px-3 py-2 text-right font-mono text-xs">{r.remainingValueCents != null ? pkr(r.remainingValueCents) : '—'}</td>}
                  {canWaste && (
                    <td className="px-3 py-2 text-right">
                      <button type="button" onClick={() => onWaste(r)} className="text-xs font-semibold text-primary-ink hover:underline">Log waste</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
