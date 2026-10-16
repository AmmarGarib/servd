'use client'
// Bank alerts at the till (spec §6.6 / §8 E): Raast transfers the bank SMS
// reported that no bill claimed on its own — nothing matched, more than one
// bill matched, or the SMS could not complete the bill. servd never guesses:
// a person attaches the transfer to the right bill, or a manager marks it
// "not a sale" (a supplier refund, an owner transfer).
//
//   list      GET  /pos/raast/alerts?shiftId          (socket raast:alert + a 15 s poll)
//   attach    POST /pos/raast/alerts/:id/attach {orderId, shiftId, paymentId?}
//   fix ref   POST /pos/raast/alerts/:id/attach {receiptId, managerOverridePin?}  (manager)
//   dismiss   POST /pos/raast/alerts/:id/dismiss {reason, managerOverridePin?}     (manager)
//
// Also: a toast when a bank SMS completes a bill on its own (socket
// raast:intent → provisional), so the floor knows the table has paid.
//
// Dark till styling (kds tokens); text labels, no emoji.

import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useDialog } from '../ui/Modal'
import { PasswordInput } from '../ui/PasswordInput'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { getSocket } from '../../lib/socket'
import { orderRef } from '../../lib/orderRef'
import { managerPinLockedMessage, WRONG_PIN_MESSAGE } from './pinErrors'
import {
  RAAST_COUNTER_WARNING, attachRaastAlert, billFor, dismissRaastAlert, fetchRaastAlerts, fixRaastReference, getRaastIntent,
  isLocalRaastPayment, paidCentsOf, storedQuote, tillErrorMessage,
  type RaastIntentView, type TillBrand, type TillOrder, type TillRaastAlert,
} from './tillApi'

const TOLERANCE_CENTS = 2 // the server's RAAST_TOLERANCE_CENTS

interface RaastAlertsProps {
  shiftId: string | null
  brand: TillBrand | undefined
  /** The brand's open tickets (the till's own list). */
  tickets: TillOrder[]
  /** The signed-in user approves with their own session (no PIN asked). */
  isManager: boolean
  /** A bill was paid from here (or by a bank SMS) — refresh the open tickets. */
  onBillPaid: () => void
}

function timeOf(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })
}

const STATUS_TEXT: Record<string, string> = {
  unmatched: 'No bill waiting for this amount',
  ambiguous: 'More than one bill could be this transfer',
  needs_attention: 'Could not complete the bill on its own',
}

function approvalError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const locked = managerPinLockedMessage(e)
    if (locked) return locked
    if (e.code === 'INVALID_MANAGER_PIN') return WRONG_PIN_MESSAGE
    if (e.code === 'MANAGER_OVERRIDE_REQUIRED') return 'This needs a manager — enter a manager’s PIN.'
  }
  return tillErrorMessage(e, fallback)
}

export function RaastAlerts({ shiftId, brand, tickets, isManager, onBillPaid }: RaastAlertsProps) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const alertsQ = useQuery({
    queryKey: ['pos', 'raast-alerts', shiftId],
    queryFn: () => fetchRaastAlerts(shiftId!),
    enabled: !!shiftId,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    retry: false,
    meta: { inlineErrors: true },
  })
  const alerts = alertsQ.data ?? []

  // Live: a new / changed bank alert, and a bill a bank SMS completed.
  useEffect(() => {
    if (!shiftId) return
    const socket = getSocket()
    const onAlert = () => { void qc.invalidateQueries({ queryKey: ['pos', 'raast-alerts', shiftId] }) }
    const onIntent = (e: { receiptId?: string; orderId?: string; status?: string; amountCents?: number; refLast4?: string }) => {
      if (!e?.orderId) return
      void qc.invalidateQueries({ queryKey: ['pos', 'raast-alerts', shiftId] })
      if (e.status !== 'provisional') return
      onBillPaid()
      if (isLocalRaastPayment(e.orderId)) return
      setToast(`Raast QR received${typeof e.amountCents === 'number' ? ` — ${fmtPkr(e.amountCents)}` : ''} — bill #${orderRef(e.orderId)} is paid${e.refLast4 ? ` (ref …${e.refLast4})` : ''}.`)
    }
    socket.on('raast:alert', onAlert)
    socket.on('raast:intent', onIntent)
    return () => {
      socket.off('raast:alert', onAlert)
      socket.off('raast:intent', onIntent)
    }
  }, [shiftId, qc, onBillPaid])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 8000)
    return () => clearTimeout(t)
  }, [toast])

  if (!shiftId) return null

  return (
    <>
      {alerts.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-11 flex shrink-0 items-center gap-2 rounded-lg border border-kds-amber px-3 py-1 text-sm font-semibold text-kds-amber hover:bg-kds-amber/10"
        >
          Bank alerts
          <span className="rounded-full bg-kds-amber px-2 text-xs font-black text-black">{alerts.length}</span>
        </button>
      )}

      {toast && (
        <div className="erp-kitchen-dark fixed bottom-5 left-5 z-[60] max-w-sm rounded-xl border border-kds-green bg-kds-card px-4 py-3 shadow-lg" role="status">
          <div className="flex items-start gap-3">
            <p className="text-sm font-semibold text-kds-green">{toast}</p>
            <button type="button" onClick={() => setToast(null)} aria-label="Dismiss"
              className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center text-kds-subtext"><X size={20} aria-hidden="true" /></button>
          </div>
          <p className="mt-1 text-xs text-kds-subtext">Provisional until the bank statement.</p>
        </div>
      )}

      {open && (
        <BankAlertsDialog onClose={() => setOpen(false)}>
            <div className="flex items-center justify-between border-b border-kds-border py-2 pl-5 pr-1">
              <div>
                <h2 className="text-lg font-bold text-kds-text">Bank alerts</h2>
                <p className="text-xs text-kds-subtext">Raast transfers no bill claimed on its own · last 48 hours</p>
              </div>
              <button type="button" data-dialog-close onClick={() => setOpen(false)} aria-label="Close"
                className="flex h-11 w-11 shrink-0 items-center justify-center text-kds-subtext hover:text-kds-text"><X size={20} aria-hidden="true" /></button>
            </div>
            <p className="border-b border-kds-border px-5 py-2 text-xs text-kds-amber">{RAAST_COUNTER_WARNING}</p>
            <div className="flex-1 overflow-y-auto">
              {alertsQ.isError ? (
                <p className="px-5 py-8 text-center text-sm text-kds-red">{tillErrorMessage(alertsQ.error, 'Could not load the bank alerts')}</p>
              ) : alerts.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-kds-subtext">No open bank alerts.</p>
              ) : (
                <ul className="divide-y divide-kds-border">
                  {alerts.map((a) => (
                    <AlertRow key={a.id} alert={a} shiftId={shiftId} brand={brand} tickets={tickets} isManager={isManager}
                      onDone={(msg) => {
                        void alertsQ.refetch()
                        onBillPaid()
                        if (msg) setToast(msg)
                      }} />
                  ))}
                </ul>
              )}
            </div>
        </BankAlertsDialog>
      )}
    </>
  )
}

function BankAlertsDialog({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null)
  useDialog(panelRef, { onClose })
  return (
    <div className="erp-kitchen-dark fixed inset-0 z-50 flex items-end justify-center bg-black/80 sm:items-center" role="presentation">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Bank alerts"
        className="flex max-h-[90dvh] w-full max-w-lg flex-col rounded-t-2xl bg-kds-card outline-none sm:rounded-2xl"
        style={{ overscrollBehavior: 'contain' }}>
        {children}
      </div>
    </div>
  )
}

type Mode = null | 'attach' | 'dismiss' | 'fix'

function AlertRow({ alert, shiftId, brand, tickets, isManager, onDone }: {
  alert: TillRaastAlert
  shiftId: string
  brand: TillBrand | undefined
  tickets: TillOrder[]
  isManager: boolean
  onDone: (toast: string | null) => void
}) {
  const [mode, setMode] = useState<Mode>(null)
  const [confirmFor, setConfirmFor] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [pin, setPin] = useState('')

  // The Raast bill of each open ticket (the card / digital rate) — the same
  // query the payment screen uses, asked only while picking a bill.
  const quotes = useQueries({
    queries: tickets.map((t) => ({
      queryKey: ['pos', 'bill', t.id, 'raast', t.totalCents, storedQuote(t).paidCents],
      queryFn: () => billFor(t, 'raast', brand),
      enabled: mode === 'attach',
      staleTime: 15_000,
      retry: false,
    })),
  })
  const rows = useMemo(() => tickets.map((t, i) => {
    const q = quotes[i]?.data
    const due = q && q.kind !== 'unavailable' ? q.quote.dueCents : null
    return { ticket: t, due, matches: due != null && Math.abs(due - alert.amountCents) <= TOLERANCE_CENTS }
  }).sort((a, b) => Number(b.matches) - Number(a.matches)), [tickets, quotes, alert.amountCents])

  const attach = useMutation({
    meta: { inlineErrors: true },
    mutationFn: (v: { orderId: string; paymentId?: string }) => attachRaastAlert(alert.id, { orderId: v.orderId, shiftId, ...(v.paymentId && { paymentId: v.paymentId }) }),
    onSuccess: (r) => {
      setConfirmFor(null)
      const paid = r.intent.status === 'provisional' || r.intent.status === 'matched'
      onDone(paid
        ? `Raast QR attached — bill #${r.intent.orderRef} is paid (ref ${r.intent.bankRef ?? '…'}).`
        : `The transfer was attached to bill #${r.intent.orderRef}, but the bill was not completed — open it and check.`)
    },
  })

  const dismiss = useMutation({
    meta: { inlineErrors: true },
    mutationFn: () => dismissRaastAlert(alert.id, { reason: reason.trim(), ...(!isManager && pin.trim() && { managerOverridePin: pin.trim() }) }),
    onSuccess: () => onDone(null),
    onError: (e) => { if (e instanceof ApiError && (e.code === 'INVALID_MANAGER_PIN' || e.code === 'MANAGER_PIN_LOCKED')) setPin('') },
  })

  const busy = attach.isPending || dismiss.isPending

  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xl font-black text-kds-text">{fmtPkr(alert.amountCents)}</p>
          <p className="text-xs text-kds-subtext">
            {[alert.payer ? `from ${alert.payer}` : null, alert.occurredAt ? `at ${timeOf(alert.occurredAt)}` : null,
              alert.bankAccount ? `${alert.bankAccount.name}${alert.bankAccount.last4 ? ` …${alert.bankAccount.last4}` : ''}` : null]
              .filter(Boolean).join(' · ')}
          </p>
          {alert.bankRef && <p className="mt-0.5 font-mono text-xs text-kds-subtext">Ref {alert.bankRef}</p>}
        </div>
        <span className="shrink-0 rounded border border-kds-amber px-1.5 py-0.5 text-[10px] font-bold uppercase text-kds-amber">
          {alert.status.replace(/_/g, ' ')}
        </span>
      </div>
      <p className="mt-1 text-xs text-kds-amber">{STATUS_TEXT[alert.status] ?? 'Needs a person'}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {(['attach', 'fix', 'dismiss'] as const).map((m) => (
          <button key={m} type="button" disabled={busy}
            onClick={() => { setMode(mode === m ? null : m); setConfirmFor(null); attach.reset(); dismiss.reset() }}
            aria-pressed={mode === m}
            className={`min-h-11 rounded-lg border px-3 py-1.5 text-xs font-bold disabled:opacity-30 ${
              mode === m ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text'
            }`}>
            {m === 'attach' ? 'Attach to a bill' : m === 'fix' ? 'Fix a typed reference' : 'Not a sale'}
          </button>
        ))}
      </div>

      {mode === 'attach' && (
        <div className="mt-3 space-y-2">
          {alert.candidates.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-kds-subtext">Bills waiting for this amount</p>
              {alert.candidates.map((c) => (
                <AttachLine key={c.receiptId}
                  label={`Bill #${c.orderRef}`} sub={`Raast requested at ${timeOf(c.createdAt)}`} dueCents={c.amountCents} matches
                  confirming={confirmFor === c.receiptId} busy={busy}
                  onAttach={() => setConfirmFor(c.receiptId)}
                  onConfirm={() => attach.mutate({ orderId: c.orderId, ...(c.paymentId && { paymentId: c.paymentId }) })}
                  onCancel={() => setConfirmFor(null)} />
              ))}
            </div>
          )}
          <p className="text-[10px] font-bold uppercase tracking-wider text-kds-subtext">
            Open tickets{brand ? ` · ${brand.name}` : ''} (switch brand at the top for another brand’s bills)
          </p>
          {rows.length === 0 ? (
            <p className="text-xs text-kds-subtext">No open tickets for this brand.</p>
          ) : rows.map(({ ticket, due, matches }) => (
            <AttachLine key={ticket.id}
              label={ticket.table?.label ? `Table ${ticket.table.label}` : `Order ${orderRef(ticket.id)}`}
              sub={paidCentsOf(ticket) > 0 ? 'part paid' : `#${orderRef(ticket.id)}`}
              dueCents={due} matches={matches}
              confirming={confirmFor === ticket.id} busy={busy}
              onAttach={() => setConfirmFor(ticket.id)}
              onConfirm={() => attach.mutate({ orderId: ticket.id })}
              onCancel={() => setConfirmFor(null)} />
          ))}
          {attach.isError && <p className="text-sm text-kds-red" role="alert">{tillErrorMessage(attach.error, 'Could not attach that transfer')}</p>}
        </div>
      )}

      {mode === 'fix' && (
        <FixReference alert={alert} brand={brand} isManager={isManager} onDone={() => onDone('The bill now carries the bank SMS reference.')} />
      )}

      {mode === 'dismiss' && (
        <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); if (!busy && reason.trim().length >= 3 && (isManager || pin.trim())) dismiss.mutate() }}>
          <p className="text-xs text-kds-subtext">
            Not a customer’s payment (a supplier refund, an owner transfer). The money stays for finance to book, and this reference can never pay a bill.
          </p>
          <label htmlFor={`raast-dismiss-reason-${alert.id}`} className="sr-only">Why it is not a sale</label>
          <input id={`raast-dismiss-reason-${alert.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Why it is not a sale (required)"
            className="min-h-11 w-full rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-sm text-kds-text" />
          {!isManager && (
            <>
              <label htmlFor={`raast-dismiss-pin-${alert.id}`} className="sr-only">Manager PIN</label>
              <PasswordInput id={`raast-dismiss-pin-${alert.id}`} numeric maxLength={8} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="Manager PIN"
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-sm text-kds-text" />
            </>
          )}
          {dismiss.isError && <p className="text-sm text-kds-red" role="alert">{approvalError(dismiss.error, 'Could not mark it not a sale')}</p>}
          <button type="submit" disabled={busy || reason.trim().length < 3 || (!isManager && !pin.trim())}
            className="min-h-11 w-full rounded-xl border border-kds-red py-2.5 text-sm font-bold text-kds-red disabled:opacity-30">
            {dismiss.isPending ? 'Saving…' : 'Mark not a sale'}
          </button>
        </form>
      )}
    </li>
  )
}

function AttachLine({ label, sub, dueCents, matches, confirming, busy, onAttach, onConfirm, onCancel }: {
  label: string
  sub: string
  dueCents: number | null
  matches: boolean
  confirming: boolean
  busy: boolean
  onAttach: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${matches ? 'border-kds-green' : 'border-kds-border'}`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-kds-text">{label}</p>
        <p className="text-xs text-kds-subtext">
          {sub}
          {dueCents != null && <> · {fmtPkr(dueCents)} due by Raast</>}
          {matches && <span className="ml-1 font-bold text-kds-green">· amount matches</span>}
        </p>
      </div>
      {confirming ? (
        <div className="flex shrink-0 gap-1">
          <button type="button" onClick={onConfirm} disabled={busy}
            className="min-h-11 rounded-lg bg-kds-green px-3 py-1 text-xs font-bold text-primary-on disabled:opacity-30">
            {busy ? 'Attaching…' : 'Confirm'}
          </button>
          <button type="button" onClick={onCancel} disabled={busy} className="min-h-11 rounded-lg border border-kds-border px-2 py-1 text-xs text-kds-subtext">
            Back
          </button>
        </div>
      ) : (
        <button type="button" onClick={onAttach} disabled={busy}
          className="min-h-11 shrink-0 rounded-lg border border-kds-green px-3 py-1 text-xs font-bold text-kds-green disabled:opacity-30">
          Attach
        </button>
      )}
    </div>
  )
}

/**
 * A manager fixes a reference the cashier mistyped: a completed bill of this
 * brand, paid by Raast for the same amount, whose receipt was typed by hand
 * and has no bank SMS yet, takes this SMS's reference.
 */
function FixReference({ alert, brand, isManager, onDone }: {
  alert: TillRaastAlert
  brand: TillBrand | undefined
  isManager: boolean
  onDone: () => void
}) {
  const [pin, setPin] = useState('')
  const [pick, setPick] = useState<string | null>(null)
  const candidates = useQuery({
    queryKey: ['pos', 'raast-fix-candidates', brand?.id, alert.id],
    enabled: !!brand,
    retry: false,
    staleTime: 15_000,
    queryFn: async (): Promise<RaastIntentView[]> => {
      const page = await api.get<{ data: TillOrder[] }>(
        `/orders?conceptId=${encodeURIComponent(brand!.id)}&source=pos&status=completed&limit=100`,
      )
      const orders = page.data.filter((o) => (o.payments ?? []).some((p) =>
        p.method === 'raast' && p.status === 'paid' && Math.abs(p.amountCents - alert.amountCents) <= TOLERANCE_CENTS)).slice(0, 10)
      const lists = await Promise.all(orders.map((o) =>
        api.get<RaastIntentView[]>(`/pos/raast/intents?orderId=${encodeURIComponent(o.id)}`).catch(() => [] as RaastIntentView[])))
      return lists.flat().filter((r) => r.status === 'provisional' && !r.smsConfirmed && r.confirmedVia === 'cashier'
        && Math.abs(r.amountCents - alert.amountCents) <= TOLERANCE_CENTS)
    },
  })
  const fix = useMutation({
    meta: { inlineErrors: true },
    mutationFn: (receiptId: string) => fixRaastReference(alert.id, { receiptId, ...(!isManager && pin.trim() && { managerOverridePin: pin.trim() }) }),
    onSuccess: () => onDone(),
    onError: (e) => { if (e instanceof ApiError && (e.code === 'INVALID_MANAGER_PIN' || e.code === 'MANAGER_PIN_LOCKED')) setPin('') },
  })

  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-kds-subtext">
        For a bill already paid by Raast where the cashier typed the reference wrong: the bill takes this bank SMS’s reference. Same amount, same bank account, recent bills of {brand?.name ?? 'this brand'} only.
      </p>
      {candidates.isLoading ? (
        <p className="text-xs text-kds-subtext">Looking for Raast bills of this amount…</p>
      ) : candidates.isError ? (
        <p className="text-xs text-kds-red">{tillErrorMessage(candidates.error, 'Could not load the bills')}</p>
      ) : (candidates.data ?? []).length === 0 ? (
        <p className="text-xs text-kds-subtext">No hand-typed Raast bill of this amount is waiting for its bank SMS.</p>
      ) : (candidates.data ?? []).map((r) => (
        <label key={r.id} className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${pick === r.id ? 'border-kds-green' : 'border-kds-border'}`}>
          <span className="text-sm text-kds-text">
            Bill #{r.orderRef} · {fmtPkr(r.amountCents)}
            <span className="block font-mono text-xs text-kds-subtext">typed: {r.bankRef ?? '—'}</span>
          </span>
          <input type="radio" name={`fix-${alert.id}`} checked={pick === r.id} onChange={() => setPick(r.id)} className="h-5 w-5" />
        </label>
      ))}
      {!isManager && (
        <>
          <label htmlFor={`raast-fix-pin-${alert.id}`} className="sr-only">Manager PIN</label>
          <PasswordInput id={`raast-fix-pin-${alert.id}`} numeric maxLength={8} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && pick && !fix.isPending && pin.trim()) { e.preventDefault(); fix.mutate(pick) } }} placeholder="Manager PIN"
            className="w-full rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-sm text-kds-text" />
        </>
      )}
      {fix.isError && <p className="text-sm text-kds-red" role="alert">{approvalError(fix.error, 'Could not fix the reference')}</p>}
      <button type="button" onClick={() => pick && fix.mutate(pick)} disabled={!pick || fix.isPending || (!isManager && !pin.trim())}
        className="min-h-11 w-full rounded-xl border border-kds-green py-2.5 text-sm font-bold text-kds-green disabled:opacity-30">
        {fix.isPending ? 'Saving…' : 'Use the bank SMS reference'}
      </button>
    </div>
  )
}
