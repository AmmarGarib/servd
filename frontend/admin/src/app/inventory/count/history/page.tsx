'use client'
// Count history — every spot and opening count of the company, with its lines,
// their value and whether the books entry posted (GET /crosschecks/physical-counts).
// Values are hidden by the API for the kitchen floor (costsHidden). A count
// whose posting was refused is flagged posting_failed; finance re-posts it from
// Reconciliation → Backfill unposted.

import { CompactEmptyState } from '../../../../components/ui/CompactEmptyState'
import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../../lib/api'
import { fmtPkr, fmtPkrWhole } from '../../../../lib/money'
import { stockErrorText } from '../../../../lib/stockUi'

interface CountLine {
  id: string; inventoryItemId: string; itemName: string | null; unit: string | null
  systemQty: number; physicalQty: number; variancePct: number | null
  reason: string | null; valueCents: number | null; unitCostCents: number | null
}
interface CountRow {
  id: string; kind: 'spot' | 'opening'; countedAt: string; status: string
  notes: string | null; locationId: string | null; costsHidden?: boolean
  lines: CountLine[]
  ledger: { posted: boolean; entryId?: string; failed: boolean }
}
interface LocationRow { id: string; name: string }

const EPS = 1e-6
const fi = 'rounded-lg bg-s-bg border border-s-border px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none'
const qtyText = (q: number) => String(Math.round(q * 1000) / 1000)
const when = (iso: string) => new Date(iso).toLocaleString('en-PK', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function CountHistoryPage() {
  const [kind, setKind] = useState<'' | 'spot' | 'opening'>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const qs = new URLSearchParams()
  if (kind) qs.set('kind', kind)
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)

  const { data: counts = [], isLoading, error } = useQuery<CountRow[]>({
    queryKey: ['physical-counts', 'history', kind, from, to],
    queryFn: () => api.get(`/crosschecks/physical-counts${qs.size ? `?${qs}` : ''}`),
  })
  const { data: locations = [] } = useQuery<LocationRow[]>({
    queryKey: ['locations'], queryFn: () => api.get('/locations'), retry: false, meta: { background: true }, staleTime: 300_000,
  })
  const outlet = (id: string | null) => (id ? locations.find((l) => l.id === id)?.name ?? 'Outlet' : 'Whole company')

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="px-4 sm:px-7 py-5 border-b border-s-border">
        <Link href="/inventory/count" className="inline-flex min-h-11 items-center gap-1.5 text-xs text-s-muted hover:text-s-text"><ArrowLeft size={14} aria-hidden="true" />Physical count</Link>
        <h1 className="text-2xl font-black text-s-text mt-2">Count history</h1>
        <p className="text-sm text-s-muted mt-1 max-w-2xl">
          Every count with what was found, what it was worth and whether it reached the books. The latest 50 are shown.
        </p>
      </header>

      <div className="px-4 sm:px-7 py-5 max-w-5xl mx-auto space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex gap-1">
            {([['', 'All'], ['spot', 'Spot'], ['opening', 'Opening']] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${kind === k ? 'bg-accent-dim border-accent text-s-text' : 'bg-s-surface border-s-border text-s-muted hover:text-s-text'}`}>
                {label}
              </button>
            ))}
          </div>
          <label className="text-xs text-s-muted">From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={fi + ' block mt-1'} />
          </label>
          <label className="text-xs text-s-muted">To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={fi + ' block mt-1'} />
          </label>
          {(from || to) && <button type="button" onClick={() => { setFrom(''); setTo('') }} className="text-xs text-s-muted hover:text-s-text pb-2">Clear dates</button>}
        </div>

        {error && <p role="alert" className="text-xs text-s-red">{stockErrorText(error, 'The counts could not be loaded')}</p>}
        {isLoading && <p className="text-sm text-s-muted">Loading…</p>}
        {!isLoading && !error && counts.length === 0 && (
          <CompactEmptyState message="No counts yet. Spot counts and opening counts appear here once saved." />
        )}

        <div className="space-y-3">
          {counts.map((c) => {
            const hidden = c.costsHidden === true
            const differing = c.lines.filter((l) => Math.abs(l.physicalQty - l.systemQty) > EPS && c.kind === 'spot').length
            const netCents = hidden ? null : c.lines.reduce((s, l) => s + (l.valueCents ?? 0), 0)
            const isOpen = open === c.id
            return (
              <div key={c.id} className="rounded-xl border border-s-border bg-s-surface overflow-hidden">
                <button type="button" onClick={() => setOpen(isOpen ? null : c.id)} aria-expanded={isOpen}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 flex-wrap hover:bg-s-elevated/40">
                  <span className={c.kind === 'opening' ? 's-badge-purple' : 's-badge-muted'}>{c.kind === 'opening' ? 'Opening' : 'Spot'}</span>
                  <span className="text-sm font-semibold text-s-text">{when(c.countedAt)}</span>
                  <span className="text-xs text-s-muted">{outlet(c.locationId)} · {c.lines.length} item{c.lines.length === 1 ? '' : 's'}</span>
                  {c.kind === 'spot' && (
                    <span className="text-xs" style={{ color: differing > 0 ? 'var(--erp-warning)' : 'var(--erp-success)' }}>
                      {differing > 0 ? `${differing} difference${differing === 1 ? '' : 's'}` : 'All matched'}
                    </span>
                  )}
                  {netCents != null && netCents !== 0 && (
                    <span className="text-xs font-semibold" style={{ color: netCents < 0 ? 'var(--erp-danger)' : 'var(--erp-success)' }}>
                      {c.kind === 'opening' ? 'Found ' : 'Net '}{fmtPkrWhole(netCents)}
                    </span>
                  )}
                  <span className="ml-auto">
                    {c.ledger.failed
                      ? <span className="s-badge-red">Not posted — refused</span>
                      : c.ledger.posted
                        ? <span className="s-badge-green">Posted to the books</span>
                        : <span className="s-badge-amber">No books entry</span>}
                  </span>
                </button>

                {isOpen && (
                  <div className="border-t border-s-border px-4 py-3 space-y-2">
                    {c.ledger.failed && (
                      <p role="alert" className="text-xs" style={{ color: 'var(--erp-danger)' }}>
                        The count is saved and stock is corrected, but the ledger refused its entry. Finance can re-post it from Reconciliation → Backfill unposted.
                      </p>
                    )}
                    {!c.ledger.failed && !c.ledger.posted && (
                      <p className="text-xs text-s-muted">Nothing was booked — every line matched the books.</p>
                    )}
                    {c.notes && <p className="text-xs text-s-muted">Notes: {c.notes}</p>}
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-s-muted border-b border-s-border">
                            <th className="py-1.5 pr-3 font-semibold">Item</th>
                            <th className="py-1.5 pr-3 font-semibold text-right">{c.kind === 'opening' ? 'Found' : 'Books'}</th>
                            {c.kind === 'spot' && <th className="py-1.5 pr-3 font-semibold text-right">Counted</th>}
                            {c.kind === 'spot' && <th className="py-1.5 pr-3 font-semibold text-right">Difference</th>}
                            {!hidden && <th className="py-1.5 pr-3 font-semibold text-right">Value</th>}
                            <th className="py-1.5 font-semibold">Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.lines.map((l) => {
                            const diff = l.physicalQty - l.systemQty
                            return (
                              <tr key={l.id} className="border-b border-s-border/50 last:border-0 align-top">
                                <td className="py-2 pr-3 text-s-text font-medium">{l.itemName ?? 'Item'}</td>
                                <td className="py-2 pr-3 text-right font-mono text-s-muted whitespace-nowrap">
                                  {c.kind === 'opening' ? qtyText(l.physicalQty) : qtyText(l.systemQty)} {l.unit ?? ''}
                                </td>
                                {c.kind === 'spot' && <td className="py-2 pr-3 text-right font-mono text-s-text whitespace-nowrap">{qtyText(l.physicalQty)} {l.unit ?? ''}</td>}
                                {c.kind === 'spot' && (
                                  <td className="py-2 pr-3 text-right font-mono whitespace-nowrap"
                                    style={{ color: Math.abs(diff) <= EPS ? 'rgb(var(--fg-rgb) / 0.45)' : diff < 0 ? 'var(--erp-danger)' : 'var(--erp-success)' }}>
                                    {Math.abs(diff) <= EPS ? '—' : `${diff > 0 ? '+' : ''}${qtyText(diff)}`}
                                    {l.variancePct != null && Math.abs(diff) > EPS && <span className="text-xs ml-1">({(l.variancePct * 100).toFixed(1)}%)</span>}
                                  </td>
                                )}
                                {!hidden && (
                                  <td className="py-2 pr-3 text-right whitespace-nowrap text-s-text">
                                    {l.valueCents == null || l.valueCents === 0 ? '—' : fmtPkrWhole(l.valueCents)}
                                    {l.unitCostCents != null && l.valueCents ? <span className="block text-xs text-s-muted">at {fmtPkr(l.unitCostCents)} / {l.unit ?? 'unit'}</span> : null}
                                  </td>
                                )}
                                <td className="py-2 text-xs text-s-muted min-w-[8rem]">{l.reason ?? '—'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
