'use client'
// A stock item's history (owner, 2026-10-27: "add history on each stock item"): every stock movement of the item,
// newest first — deliveries, sales by plate recipe, prep, counts, waste, transfers — from GET /inventory/:id/movements
// (the ONE store, stock_movements). Read only; values are hidden from the kitchen floor by the server.
import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

interface Movement {
  id: string; at: string; kind: string; kindLabel: string; qty: number; valueCents: number | null
  location: string | null; brand: string | null; orderRef: string | null; detail: string | null; by: string | null
}
interface Page { item: { id: string; name: string; unit: string; onHand?: number }; costsHidden: boolean; rows: Movement[]; nextBefore: string | null }

const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-PK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' })
const fmtQty = (n: number) => `${n > 0 ? '+' : ''}${n.toLocaleString('en-PK', { maximumFractionDigits: 3 })}`

export function ItemStockHistory({ itemId, locationId }: { itemId: string; locationId?: string | null }) {
  const q = useInfiniteQuery({
    queryKey: ['inventory', itemId, 'movements', locationId ?? ''],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' })
      if (locationId) p.set('locationId', locationId)
      if (pageParam) p.set('before', pageParam)
      return api.get<Page>(`/inventory/${itemId}/movements?${p.toString()}`)
    },
    getNextPageParam: (last) => last.nextBefore,
  })
  if (q.isLoading) return <p className="text-xs text-s-muted">Loading history…</p>
  if (q.error || !q.data) return <p className="text-xs text-s-red">{(q.error as Error | null)?.message ?? 'History is not available.'}</p>
  const first = q.data.pages[0]!
  const rows = q.data.pages.flatMap((p) => p.rows)
  const unit = first.item.unit
  return (
    <div className="space-y-2">
      {rows.length === 0 ? <p className="text-xs text-s-muted">No stock movements yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-s-muted">
              <tr>
                <th className="py-1 text-left">When</th>
                <th className="py-1 text-left">What happened</th>
                <th className="py-1 text-right">Qty ({unit})</th>
                {!first.costsHidden && <th className="py-1 text-right">Value</th>}
                <th className="py-1 text-left pl-3">Outlet · brand</th>
                <th className="py-1 text-left">By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-s-border align-top">
                  <td className="py-1.5 whitespace-nowrap">{fmtWhen(r.at)}</td>
                  <td className="py-1.5">
                    <span className="text-s-text font-semibold">{r.kindLabel}</span>
                    {(r.detail || r.orderRef) && <span className="block text-s-muted">{[r.detail, r.orderRef ? `Order ${r.orderRef}` : null].filter(Boolean).join(' · ')}</span>}
                  </td>
                  <td className={`py-1.5 text-right font-mono whitespace-nowrap ${r.qty < 0 ? 'text-s-red' : 'text-success'}`}>{fmtQty(r.qty)}</td>
                  {!first.costsHidden && <td className="py-1.5 text-right font-mono whitespace-nowrap">{r.valueCents == null ? '—' : `PKR ${Math.round(r.valueCents / 100).toLocaleString('en-PK')}`}</td>}
                  <td className="py-1.5 pl-3 text-s-muted">{[r.location, r.brand].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="py-1.5 text-s-muted">{r.by ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && (
        <button type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}
          className="text-xs px-3 py-1.5 rounded-lg border border-s-border text-s-muted hover:border-primary hover:text-primary-ink disabled:opacity-50">
          {q.isFetchingNextPage ? 'Loading…' : 'Show older'}
        </button>
      )}
    </div>
  )
}
