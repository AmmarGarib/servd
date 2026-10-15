'use client'
// Finance → Reconciliation → Cash on delivery (H5).
//
// Delivered cash-on-delivery money still with riders, by the API's one status
// rule: with rider / overdue / owed by rider / at the counter. Finance can
// "Book as owed by rider" (a reason is required). Who may do it is the API's
// decision: a 403 hides the button. The tab itself only shows while the API
// says COD custody is on (GET /reconciliation/cod/enabled).
// Admin colour tokens only; text labels, no emoji.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { Select } from '@/components/ui/Select'

type CodStatus = 'with_rider' | 'overdue' | 'rider_owes' | 'at_counter'

interface CodRow {
  paymentId: string
  orderId: string
  ref: string
  brand: string
  customerName: string | null
  amountCents: number
  deliveredAt: string | null
  hoursSinceDelivered: number
  rider: { id: string; name: string; companyName: string | null } | null
  status: CodStatus
  riderOwes: { at: string; byName: string | null } | null
}

const STATUS_LABEL: Record<CodStatus, string> = {
  with_rider: 'With rider',
  overdue: 'Overdue',
  rider_owes: 'Owed by rider',
  at_counter: 'At the counter',
}
const STATUS_CLS: Record<CodStatus, string> = {
  with_rider: 'bg-s-border text-s-muted',
  overdue: 'bg-s-amber/20 text-s-amber',
  rider_owes: 'bg-s-red/20 text-s-red',
  at_counter: 'bg-s-border text-s-muted',
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'NOT_IN_BOTH_COMPANIES') {
      return 'This rider belongs to another company. Only someone who belongs to both companies can book it.'
    }
    return e.message || e.code
  }
  return e instanceof Error ? e.message : 'That did not work'
}

export function CodTab() {
  const qc = useQueryClient()
  const [status, setStatus] = useState<'' | CodStatus>('')
  const [open, setOpen] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [legacy, setLegacy] = useState(false)
  // The legacy box appears only once the API says the order was not delivered with the code.
  const [needsLegacy, setNeedsLegacy] = useState(false)
  const [denied, setDenied] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['recon-cod', status],
    queryFn: () => api.get<{ payInHours: number; rows: CodRow[] }>(`/reconciliation/cod${status ? `?status=${status}` : ''}`),
  })

  const book = useMutation({
    mutationFn: (paymentId: string) =>
      api.post(`/reconciliation/cod/${paymentId}/rider-debt`, { reason: reason.trim(), ...(legacy && { legacy: true }) }),
    onSuccess: () => {
      setOpen(null); setReason(''); setLegacy(false); setNeedsLegacy(false)
      void qc.invalidateQueries({ queryKey: ['recon-cod'] })
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 403 && e.code !== 'NOT_IN_BOTH_COMPANIES') setDenied(true)
      if (e instanceof ApiError && e.code === 'COD_NOT_DELIVERED_WITH_CODE') setNeedsLegacy(true)
    },
  })

  const rows = data?.rows ?? []
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value as '' | CodStatus)} className="rounded-lg bg-s-bg border border-s-border px-3 py-2 text-sm text-s-text w-auto">
          <option value="">All cash on delivery</option>
          {(Object.keys(STATUS_LABEL) as CodStatus[]).map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
        </Select>
        {data && <p className="text-xs text-s-muted">Riders pay in within {data.payInHours} hours of delivery.</p>}
      </div>

      {isLoading && <p className="text-sm text-s-muted">Loading…</p>}
      {error && <p role="alert" className="text-sm text-s-red">{errorText(error)}</p>}
      {!isLoading && !error && rows.length === 0 && <p className="text-sm text-s-muted">No cash on delivery waiting.</p>}

      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.paymentId} className="s-card p-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-s-text">{r.brand} · #{r.ref}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_CLS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                </div>
                <p className="text-xs text-s-muted">
                  {r.customerName ?? 'Customer'}
                  {r.rider && ` · rider ${r.rider.name}${r.rider.companyName ? ` (${r.rider.companyName})` : ''}`}
                  {r.deliveredAt && ` · delivered ${new Date(r.deliveredAt).toLocaleString()}`}
                  {` · ${Math.floor(r.hoursSinceDelivered)}h ago`}
                </p>
                {r.riderOwes && (
                  <p className="text-xs text-s-red">
                    Booked as owed by the rider on {new Date(r.riderOwes.at).toLocaleDateString()}{r.riderOwes.byName ? ` by ${r.riderOwes.byName}` : ''}.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="font-mono text-sm text-s-text">{fmtPkr(r.amountCents)}</span>
                {!denied && !r.riderOwes && r.rider && r.status !== 'at_counter' && (
                  <button onClick={() => { setOpen(open === r.paymentId ? null : r.paymentId); setReason(''); setLegacy(false); setNeedsLegacy(false); book.reset() }}
                    className="rounded-lg border border-primary text-primary-ink px-3 py-1.5 text-xs hover:bg-primary/10 transition-colors">
                    Book as owed by rider
                  </button>
                )}
              </div>
            </div>
            {open === r.paymentId && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2 items-start">
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (at least 5 characters)"
                    className="flex-1 min-w-[200px] rounded-lg bg-s-bg border border-s-border px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none" />
                  <button onClick={() => book.mutate(r.paymentId)} disabled={reason.trim().length < 5 || book.isPending}
                    className="rounded-lg bg-primary text-primary-on font-bold px-3 py-2 text-xs disabled:opacity-50">
                    {book.isPending ? 'Booking…' : 'Book it'}
                  </button>
                  <button onClick={() => setOpen(null)} className="rounded-lg border border-s-border text-s-muted px-3 py-2 text-xs">Cancel</button>
                </div>
                {needsLegacy && (
                  <label className="flex items-start gap-2 text-xs text-s-text">
                    <input type="checkbox" checked={legacy} onChange={(e) => setLegacy(e.target.checked)} className="mt-0.5 accent-primary" />
                    <span>This order was not delivered with the customer&apos;s code. Tick to book it as an older delivery anyway.</span>
                  </label>
                )}
                {book.error && <p role="alert" className="text-xs text-s-red">{errorText(book.error)}</p>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
