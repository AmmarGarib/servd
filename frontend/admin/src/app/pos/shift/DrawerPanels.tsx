'use client'
// Two drawer jobs besides the count:
//   • Pay a vendor from the till (owner decision 5) — manager PIN, under the
//     pay-out cap, booked like a petty-cash spend to the category picked.
//   • Rider cash-on-delivery pay-in (owner decision 4) — delivered COD orders
//     whose cash has not reached a drawer yet; taking it puts it on this
//     shift's Z-report and moves it from cash-on-hand to the drawer.
// Neither shows the drawer's expected cash (blind count, decision 2).
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../../lib/api'
import { fmtPkrWhole } from '../../../lib/money'
import { managerPinLockedMessage, WRONG_PIN_MESSAGE } from '../../../components/pos/pinErrors'
import { orderRef } from '../../../lib/orderRef'

interface PayoutCategory { key: string; label: string; code: string }
interface CodDue {
  id: string
  amountCents: number
  order: { id: string; completedAt: string | null; customerName: string | null; concept: { name: string } }
  rider?: { id: string; name: string } | null
  hoursSinceDelivered?: number
  overdue?: boolean
}

/** A cashier-readable line for a refused pay-out (PIN missing, wrong or locked out). */
function payoutErrorMessage(e: unknown): string {
  const locked = managerPinLockedMessage(e)
  if (locked) return locked
  if (e instanceof ApiError) {
    if (e.code === 'MANAGER_OVERRIDE_REQUIRED') return 'A pay-out needs a manager — enter a manager’s PIN.'
    if (e.code === 'INVALID_MANAGER_PIN') return WRONG_PIN_MESSAGE
    return e.message || e.code
  }
  return e instanceof Error ? e.message : 'The pay-out failed'
}

const inputCls = 'w-full rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-sm text-kds-text'

export function VendorPayoutPanel({ shiftId }: { shiftId: string }) {
  const { data } = useQuery({ queryKey: ['payout-categories'], queryFn: () => api.get<{ categories: PayoutCategory[] }>('/pos/payout-categories') })
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('')
  const [reason, setReason] = useState('')
  const [vendorName, setVendorName] = useState('')
  const [pin, setPin] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const payout = useMutation({
    mutationFn: () => api.post(`/pos/shifts/${shiftId}/cash-movements`, {
      type: 'payout',
      amountCents: Math.round(parseFloat(amount || '0') * 100),
      reason: reason.trim(),
      category,
      ...(vendorName.trim() && { vendorName: vendorName.trim() }),
      ...(pin && { managerOverridePin: pin }),
    }),
    onSuccess: () => { setDone(`Paid out PKR ${amount} — booked to ${data?.categories.find((c) => c.key === category)?.label ?? category}.`); setAmount(''); setReason(''); setVendorName(''); setPin('') },
    // A wrong PIN, or the wrong-PIN lock-out: clear the box so it is typed afresh.
    onError: (e) => { if (e instanceof ApiError && (e.code === 'INVALID_MANAGER_PIN' || e.code === 'MANAGER_PIN_LOCKED')) setPin('') },
  })
  return (
    <div className="rounded-2xl bg-kds-card p-6 space-y-3">
      <h2 className="font-bold text-kds-text">Pay a vendor from the till</h2>
      <p className="text-xs text-kds-subtext">Needs a manager PIN and stays under the pay-out cap. Larger amounts go through petty cash or the bank.</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="payout-amount" className="mb-1 block text-xs text-kds-subtext">Amount (PKR)</label>
          <input id="payout-amount" type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label htmlFor="payout-category" className="mb-1 block text-xs text-kds-subtext">For</label>
          <select id="payout-category" value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
            <option value="">Pick one</option>
            {(data?.categories ?? []).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </div>
      </div>
      <label htmlFor="payout-reason" className="block text-xs text-kds-subtext">What was bought</label>
      <input id="payout-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. 20 kg ice" className={inputCls} />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="payout-vendor" className="mb-1 block text-xs text-kds-subtext">Vendor (optional)</label>
          <input id="payout-vendor" value={vendorName} onChange={(e) => setVendorName(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label htmlFor="payout-pin" className="mb-1 block text-xs text-kds-subtext">Manager PIN</label>
          <input id="payout-pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} className={inputCls} />
        </div>
      </div>
      {payout.error && <p role="alert" className="text-xs text-kds-red">{payoutErrorMessage(payout.error)}</p>}
      {done && <p role="status" className="text-xs text-kds-green">{done}</p>}
      <button
        onClick={() => { setDone(null); payout.mutate() }}
        disabled={payout.isPending || !amount || !category || reason.trim().length < 1}
        className="w-full rounded-xl bg-kds-amber py-3 font-bold text-black disabled:opacity-50"
      >
        {payout.isPending ? 'Recording…' : 'Pay out'}
      </button>
    </div>
  )
}

export function CodPayInPanel({ shiftId }: { shiftId: string }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['cod-due'], queryFn: () => api.get<{ payments: CodDue[] }>('/pos/cod-due') })
  const take = useMutation({
    mutationFn: (paymentId: string) => api.post(`/pos/payments/${paymentId}/settle`, { shiftId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cod-due'] }),
  })
  const rows = data?.payments ?? []
  return (
    <div className="rounded-2xl bg-kds-card p-6 space-y-3">
      <h2 className="font-bold text-kds-text">Rider cash-on-delivery</h2>
      <p className="text-xs text-kds-subtext">Delivered orders paid in cash whose money has not reached a drawer. Take the rider&apos;s cash into this drawer.</p>
      {isLoading && <p className="text-xs text-kds-subtext">Loading…</p>}
      {!isLoading && rows.length === 0 && <p className="text-xs text-kds-subtext">Nothing waiting.</p>}
      <ul className="space-y-2">
        {rows.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-kds-border px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm text-kds-text truncate">{p.order.concept.name} · #{orderRef(p.order.id)}</p>
              <p className="text-xs text-kds-subtext truncate">{p.order.customerName ?? 'Customer'}{p.rider?.name && ` · rider ${p.rider.name}`}{p.order.completedAt && ` · delivered ${new Date(p.order.completedAt).toLocaleString()}`}{p.overdue && ' · overdue'}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono text-sm text-kds-text">{fmtPkrWhole(p.amountCents)}</span>
              <button onClick={() => take.mutate(p.id)} disabled={take.isPending}
                className="rounded-lg bg-kds-green px-3 py-1.5 text-xs font-bold text-black disabled:opacity-50">Take cash</button>
            </div>
          </li>
        ))}
      </ul>
      {take.error && <p role="alert" className="text-xs text-kds-red">{(take.error as Error).message}</p>}
    </div>
  )
}
