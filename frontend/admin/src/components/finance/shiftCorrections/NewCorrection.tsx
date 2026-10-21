'use client'
// New correction: pick a CLOSED drawer, tick the bills / open tickets to fix, give each a reason,
// send ONE set to the CEO. Nothing changes until the CEO approves.
import { useMutation, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import { type CorrectionSet, type ShiftCandidates, MIN_REASON, KIND_LABEL, fmtDateTime, fmtDay, tenderText } from './types'

interface ShiftRow { shiftId: string; cashier: string; openedAt: string; closedAt: string | null; status: string; totalSalesCents: number; varianceCents: number | null }
interface Summary { shifts: ShiftRow[] }

interface Pick { reason: string; moneyReturned: boolean; foodMade: boolean }

function daysAgo(n: number) {
  const d = new Date(`${todayPktIso()}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

export function NewCorrection({ onCreated, onCancel }: { onCreated: (set: CorrectionSet) => void; onCancel: () => void }) {
  const [from, setFrom] = useState(() => daysAgo(14))
  const [to, setTo] = useState(() => todayPktIso())
  const [shiftId, setShiftId] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['shift-corrections', 'closed-shifts', from, to],
    queryFn: () => api.get<Summary>(`/reconciliation/summary?dateFrom=${from}&dateTo=${to}`),
  })
  const closed = (list.data?.shifts ?? []).filter((s) => s.status === 'closed')

  return (
    <div className="s-card p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-s-text">New correction</h2>
        <button type="button" className="s-btn-secondary text-sm" onClick={onCancel}>Back to the list</button>
      </div>

      {!shiftId && (
        <>
          <p className="text-xs text-s-muted">Pick the closed shift that has the mistake. Only shifts the cashier has already closed can be corrected.</p>
          <div className="flex flex-wrap gap-2 items-end">
            <div>
              <label htmlFor="sc-from" className="block text-xs text-s-muted">Opened from</label>
              <input id="sc-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
            </div>
            <div>
              <label htmlFor="sc-to" className="block text-xs text-s-muted">Opened to</label>
              <input id="sc-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
            </div>
          </div>
          {list.isLoading && <p className="text-xs text-s-muted">Loading shifts…</p>}
          {list.error && <p role="alert" className="text-xs text-s-red">{(list.error as Error).message}</p>}
          {list.data && closed.length === 0 && <p className="text-sm text-s-muted">No closed shifts in these dates.</p>}
          <ul className="divide-y divide-s-border">
            {closed.map((s) => (
              <li key={s.shiftId}>
                <button type="button" onClick={() => setShiftId(s.shiftId)} className="w-full text-left py-2.5 px-1 flex flex-wrap items-center justify-between gap-2 hover:bg-s-bg rounded">
                  <span>
                    <span className="block text-sm font-medium text-s-text">{s.cashier}</span>
                    <span className="block text-xs text-s-muted">Opened {fmtDateTime(s.openedAt)} · closed {fmtDateTime(s.closedAt)}</span>
                  </span>
                  <span className="text-xs text-s-muted tabular-nums">Sales {fmtPkr(s.totalSalesCents)}{s.varianceCents ? ` · cash difference ${fmtPkr(s.varianceCents)}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {shiftId && <Builder shiftId={shiftId} onBack={() => setShiftId(null)} onCreated={onCreated} />}
    </div>
  )
}

function Builder({ shiftId, onBack, onCreated }: { shiftId: string; onBack: () => void; onCreated: (set: CorrectionSet) => void }) {
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['shift-corrections', 'shift', shiftId],
    queryFn: () => api.get<ShiftCandidates>(`/pos/shift-corrections/shift/${shiftId}`),
  })

  const blocked = data?.booksClosed ?? (data?.pendingCorrectionId ? { code: 'CORRECTION_PENDING', message: 'This shift already has a correction waiting for the CEO. Add to it after it is decided.' } : null)
  const chosen = useMemo(() => (data?.orders ?? []).filter((o) => picks[o.orderId]), [data, picks])
  const ready = !blocked && chosen.length > 0 && reason.trim().length >= MIN_REASON && chosen.every((o) => picks[o.orderId]!.reason.trim().length >= MIN_REASON)

  const toggle = (id: string) => setPicks((p) => {
    const n = { ...p }
    if (n[id]) delete n[id]; else n[id] = { reason: '', moneyReturned: false, foodMade: false }
    return n
  })
  const patch = (id: string, v: Partial<Pick>) => setPicks((p) => ({ ...p, [id]: { ...p[id]!, ...v } }))

  const send = useMutation({
    mutationFn: () => api.post<CorrectionSet>('/pos/shift-corrections', {
      shiftId,
      reason: reason.trim(),
      items: chosen.map((o) => {
        const p = picks[o.orderId]!
        return {
          orderId: o.orderId, kind: o.kind, reason: p.reason.trim(),
          ...(o.kind === 'void_bill' ? { moneyReturned: p.moneyReturned, foodMade: p.foodMade } : {}),
        }
      }),
    }),
    onSuccess: onCreated,
    onError: (e: Error) => setErr(e.message || 'Could not send the correction'),
  })

  if (isLoading) return <p className="text-xs text-s-muted">Loading the shift…</p>
  if (error) return <p role="alert" className="text-xs text-s-red">{(error as Error).message}</p>
  if (!data) return null
  const sh = data.shift

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-s-text">{sh.cashierName ?? 'Cashier'}{sh.locationName ? ` · ${sh.locationName}` : ''}</p>
          <p className="text-xs text-s-muted">Business day {fmtDay(sh.businessDay)} · opened {fmtDateTime(sh.openedAt)} · closed {fmtDateTime(sh.closedAt)}</p>
        </div>
        <button type="button" className="s-btn-secondary text-sm" onClick={onBack}>Pick another shift</button>
      </div>

      {blocked && <div role="alert" className="rounded-lg border border-s-border p-3 text-sm text-s-red">{blocked.message}</div>}

      <p className="text-xs text-s-muted rounded-lg bg-s-bg p-3">
        Wrong payment method? Void the bill here, then ring the correct bill on an open till.
      </p>

      {data.orders.length === 0 && <p className="text-sm text-s-muted">This shift has no bills or tickets.</p>}
      <ul className="space-y-2">
        {data.orders.map((o) => {
          const p = picks[o.orderId]
          const canPick = !!o.kind && !o.blockedBy && !blocked
          return (
            <li key={o.orderId} className={`rounded-lg border p-3 ${p ? 'border-primary' : 'border-s-border'}`}>
              <label className="flex items-start gap-3">
                <input type="checkbox" className="accent-primary mt-1" checked={!!p} disabled={!canPick} onChange={() => toggle(o.orderId)} aria-label={`Fix order ${o.orderRef}`} />
                <span className="flex-1 min-w-0">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-s-text">#{o.orderRef} · {o.brand}</span>
                    <span className="text-sm tabular-nums text-s-text">{fmtPkr(o.totalCents)}</span>
                  </span>
                  <span className="block text-xs text-s-muted">
                    {fmtDateTime(o.completedAt ?? o.placedAt)} · {o.status === 'completed' ? 'Final bill' : 'Open ticket'} · {tenderText(o.tenders)}{o.settlementChannel === 'servd' ? ' · closed in servd' : ''}
                  </span>
                  <span className="block text-xs text-s-muted truncate">{o.lines.map((l) => `${l.quantity}× ${l.name}`).join(', ') || 'No items'}</span>
                  {o.kind && !o.blockedBy && <span className="block text-xs text-success mt-0.5">Can be fixed: {KIND_LABEL[o.kind].toLowerCase()}</span>}
                  {o.blockedBy && <span className="block text-xs text-s-red mt-0.5">Cannot be fixed: {o.blockedBy.message}</span>}
                </span>
              </label>
              {p && o.kind && (
                <div className="mt-3 ml-7 space-y-2">
                  <div>
                    <label htmlFor={`sc-r-${o.orderId}`} className="block text-xs text-s-muted">Why is this being fixed? (at least {MIN_REASON} characters)</label>
                    <textarea id={`sc-r-${o.orderId}`} rows={2} value={p.reason} onChange={(e) => patch(o.orderId, { reason: e.target.value })}
                      className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
                  </div>
                  {o.kind === 'void_bill' && (
                    <div className="flex flex-col gap-1">
                      <label className="flex items-center gap-2 text-xs text-s-text">
                        <input type="checkbox" className="accent-primary" checked={p.moneyReturned} onChange={(e) => patch(o.orderId, { moneyReturned: e.target.checked })} />
                        Money was handed back to the customer
                      </label>
                      <label className="flex items-center gap-2 text-xs text-s-text">
                        <input type="checkbox" className="accent-primary" checked={p.foodMade} onChange={(e) => patch(o.orderId, { foodMade: e.target.checked })} />
                        Food was made (waste it)
                      </label>
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <div>
        <label htmlFor="sc-reason" className="block text-xs text-s-muted">What happened on this shift? Reason for the whole correction (at least {MIN_REASON} characters)</label>
        <textarea id="sc-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
      </div>

      {err && <p role="alert" className="text-sm text-s-red">{err}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="s-btn-primary text-sm" disabled={!ready || send.isPending} onClick={() => { setErr(null); send.mutate() }}>
          {send.isPending ? 'Sending…' : `Send ${chosen.length || ''} ${chosen.length === 1 ? 'fix' : 'fixes'} to the CEO`}
        </button>
        <span className="text-xs text-s-muted">Nothing changes until the CEO approves.</span>
      </div>
    </div>
  )
}
