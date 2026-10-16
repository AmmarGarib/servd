'use client'
// Raast QR at the till (spec §8 E, owner decisions 2026-10-12). Raast is an
// instant bank transfer to the company's receiving account; it completes the
// sale like card, and the receipt stays 'provisional' until finance matches
// it to the bank statement.
//
// THE rule on every Raast screen (D9): the cashier checks the money on the
// COUNTER phone (bank SMS / merchant app) — never the customer's phone screen
// or a screenshot — and types the bank reference with an "I saw it arrive"
// tick the server enforces.
//
//   Bank-SMS matching OFF (the default):
//     reference + tick → POST /pos/payments {method 'raast', gatewayRef, raastVerified: true}
//   Bank-SMS matching ON:
//     "Customer is paying — wait for the bank SMS" → POST /pos/raast/intents
//     → waiting (expiry clock; socket raast:intent + a 3 s poll) → the SMS
//     settles it by itself, or "Enter the reference by hand" (same tick) →
//     POST /pos/raast/intents/:id/confirm, or "Cancel Raast".
//     S1: an unmatched transfer of the same amount that arrived just BEFORE
//     the request is never attached on its own — it is listed as a "possible
//     earlier payment" the cashier attaches by hand.
//
// Dark till styling (kds tokens); text labels, no emoji.

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { getSocket } from '../../lib/socket'
import { orderRef } from '../../lib/orderRef'
import {
  KEENU_QR_CUTOVER_NOTE, RAAST_COUNTER_WARNING,
  activeRaastIntents, attachRaastAlert, cancelRaastIntent, confirmRaastIntent, createRaastIntent, getRaastIntent,
  newIdempotencyKey, noteLocalRaastPayment, payOrder, raastIntentBlocks, raastRefProblem, normalizeRaastRef,
  tillErrorMessage, useRaastConfig,
  type FiscalView, type RaastConfig, type RaastIntentView, type RaastReceiptStatus,
} from './tillApi'

/** What the done screen shows of a Raast payment. */
export interface RaastDone {
  bankRef: string | null
  status: RaastReceiptStatus
  smsConfirmed: boolean
  confirmedVia: 'cashier' | 'sms' | 'bank_api' | null
}

interface RaastPanelProps {
  orderId: string
  conceptId: string
  brandName?: string
  shiftId: string
  /** The server's Raast bill (card rate) — what is due now. */
  dueCents: number
  /** The tip the customer adds (rides on the transfer). */
  tipCents: number
  /** A Raast request already in play on this order (resumed after a reload / a closed modal). */
  initialIntent?: RaastIntentView | null
  /** Every state of the request this screen follows (null = none) — the modal locks the tip and other tenders while it waits. */
  onIntentChange: (intent: RaastIntentView | null) => void
  /** The payment went through (provisional until the bank statement). */
  onPaid: (r: { fiscal?: FiscalView | null; raast: RaastDone }) => void
  /** The bill moved on the server (409 AMOUNT_MISMATCH / ALREADY_PAID) — reload it. */
  onBillChanged: () => void
}

const PAID: readonly RaastReceiptStatus[] = ['provisional', 'matched']

function secondsLeft(iso: string | null, now: number): number | null {
  if (!iso) return null
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000))
}
function clock(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}
function timeOf(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })
}

export function RaastPanel({
  orderId, conceptId, brandName, shiftId, dueCents, tipCents, initialIntent, onIntentChange, onPaid, onBillChanged,
}: RaastPanelProps) {
  const qc = useQueryClient()
  const config = useRaastConfig(shiftId, conceptId)
  const cfg: RaastConfig | null = config.data ?? null
  const transferCents = dueCents + tipCents

  // ── The request (SMS matching ON) ─────────────────────────────────────────
  const [intentId, setIntentId] = useState<string | null>(initialIntent?.id ?? null)
  const intentQ = useQuery({
    queryKey: ['pos', 'raast-intent', intentId],
    queryFn: () => getRaastIntent(intentId!),
    enabled: !!intentId,
    initialData: initialIntent && initialIntent.id === intentId ? initialIntent : undefined,
    refetchInterval: (q) => (q.state.data?.status === 'awaiting' ? 3000 : false),
    retry: false,
    meta: { inlineErrors: true },
  })
  const intent: RaastIntentView | null = intentId ? intentQ.data ?? null : null

  // A request found on the server after this mounted (the resume query answered late).
  useEffect(() => {
    if (!intentId && initialIntent) setIntentId(initialIntent.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialIntent?.id])

  // The bank SMS (or another till) moved the request: follow it at once.
  useEffect(() => {
    if (!intentId) return
    const socket = getSocket()
    const onEvent = (e: { receiptId?: string }) => {
      if (e?.receiptId === intentId) void qc.invalidateQueries({ queryKey: ['pos', 'raast-intent', intentId] })
    }
    socket.on('raast:intent', onEvent)
    return () => { socket.off('raast:intent', onEvent) }
  }, [intentId, qc])

  // Tell the modal; hand over a success once.
  const reported = useRef<string | null>(null)
  useEffect(() => {
    onIntentChange(intent)
    if (intent && PAID.includes(intent.status) && reported.current !== intent.id) {
      reported.current = intent.id
      onPaid({
        // undefined (not null) when the view has none yet: the done screen asks for it.
        fiscal: intent.fiscal ?? undefined,
        raast: { bankRef: intent.bankRef, status: intent.status, smsConfirmed: intent.smsConfirmed, confirmedVia: intent.confirmedVia },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.id, intent?.status, intent?.bankRef])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => onIntentChange(null), [])

  // The expiry clock.
  const [now, setNow] = useState(() => Date.now())
  const waiting = intent?.status === 'awaiting'
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [waiting])

  // One idempotency key per request attempt (order, due, tip); a fresh one after a cancel / expiry.
  const intentKey = useRef<{ signature: string; key: string } | null>(null)
  const start = useMutation({
    meta: { inlineErrors: true },
    mutationFn: async () => {
      const signature = `${orderId}|${dueCents}|${tipCents}`
      if (intentKey.current?.signature !== signature) intentKey.current = { signature, key: newIdempotencyKey().replace(/^pos-/, 'raast-') }
      return createRaastIntent({ orderId, shiftId, tipCents, expectedDueCents: dueCents, idempotencyKey: intentKey.current.key })
    },
    onSuccess: (r) => {
      qc.setQueryData(['pos', 'raast-intent', r.id], r)
      setIntentId(r.id)
      setHandOpen(false)
    },
    onError: async (e) => {
      if (e instanceof ApiError && (e.code === 'AMOUNT_MISMATCH' || e.code === 'ALREADY_PAID')) onBillChanged()
      // Another till (or a closed modal) already put this bill up for Raast: follow that request.
      if (e instanceof ApiError && e.code === 'RAAST_AWAITING') {
        const rid = (e.details as { receiptId?: string } | undefined)?.receiptId
        if (rid) { setIntentId(rid); return }
        const open = await activeRaastIntents(orderId).catch(() => [])
        const waitingOne = open.find((i) => i.status === 'awaiting')
        if (waitingOne) { qc.setQueryData(['pos', 'raast-intent', waitingOne.id], waitingOne); setIntentId(waitingOne.id) }
      }
    },
  })

  const cancel = useMutation({
    meta: { inlineErrors: true },
    mutationFn: () => cancelRaastIntent(intentId!, 'cancelled_by_cashier'),
    onSuccess: (r) => {
      qc.setQueryData(['pos', 'raast-intent', r.id], r)
      intentKey.current = null
    },
    onError: () => { void intentQ.refetch() },
  })

  // ── The reference typed by hand (any mode) ────────────────────────────────
  const [handOpen, setHandOpen] = useState(false)
  const [ref, setRef] = useState('')
  const [seen, setSeen] = useState(false)
  // UI-2: the tick attests ONE amount. When the amount it names changes (a
  // tip typed after ticking, a reloaded bill, a request of another amount)
  // the cashier must look at the counter phone again and re-tick.
  const attestedCents = intent?.amountCents ?? transferCents
  useEffect(() => { setSeen(false) }, [attestedCents])
  const rule = cfg?.refRule ?? { min: 6, max: 35 }
  const refProblem = raastRefProblem(ref, rule, orderId)
  const payKey = useRef<{ signature: string; key: string } | null>(null)

  const confirm = useMutation({
    meta: { inlineErrors: true },
    mutationFn: async (): Promise<{ fiscal?: FiscalView | null; raast: RaastDone } | null> => {
      const bankRef = normalizeRaastRef(ref)
      noteLocalRaastPayment(orderId)
      if (intent && (intent.status === 'awaiting' || intent.status === 'needs_attention')) {
        // Confirm the request: the server takes the money through it.
        const r = await confirmRaastIntent(intent.id, bankRef)
        qc.setQueryData(['pos', 'raast-intent', r.intent.id], r.intent)
        return null // the request's own state change reports the success
      }
      const signature = `${orderId}|raast|${dueCents}|${tipCents}`
      if (payKey.current?.signature !== signature) payKey.current = { signature, key: newIdempotencyKey() }
      const r = await payOrder({
        orderId, shiftId, idempotencyKey: payKey.current.key, method: 'raast',
        amountCents: transferCents, ...(tipCents > 0 && { tipCents }),
        gatewayRef: bankRef, raastVerified: true,
      })
      payKey.current = null
      const t = r.raast?.[0]
      return {
        fiscal: r.fiscal,
        raast: { bankRef: t?.bankRef ?? bankRef, status: t?.status ?? 'provisional', smsConfirmed: !!t?.smsConfirmed, confirmedVia: t?.confirmedVia ?? 'cashier' },
      }
    },
    onSuccess: (done) => { if (done) onPaid(done) },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'AMOUNT_MISMATCH' || e.code === 'ALREADY_PAID' || e.code === 'RAAST_AMOUNT_MISMATCH')) setSeen(false)
      if (e instanceof ApiError && (e.code === 'AMOUNT_MISMATCH' || e.code === 'ALREADY_PAID')) onBillChanged()
      if (e instanceof ApiError && e.code === 'RAAST_INTENT_GONE') void intentQ.refetch()
      // UI-3: another till put this bill up for Raast meanwhile — follow that
      // request (it shows here, and the other tenders lock as for a card charge).
      if (e instanceof ApiError && e.code === 'RAAST_AWAITING') {
        const rid = (e.details as { receiptId?: string } | undefined)?.receiptId
        if (rid) { setHandOpen(false); setIntentId(rid) }
      }
    },
  })

  // ── S1: attach a possible earlier payment ─────────────────────────────────
  const attach = useMutation({
    meta: { inlineErrors: true },
    mutationFn: (alertId: string) => attachRaastAlert(alertId, {
      orderId, shiftId, ...(intent?.targetPaymentId && { paymentId: intent.targetPaymentId }),
    }),
    onSuccess: (r) => {
      qc.setQueryData(['pos', 'raast-intent', r.intent.id], r.intent)
      setIntentId(r.intent.id)
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'AMOUNT_MISMATCH' || e.code === 'ALREADY_PAID')) onBillChanged()
      void intentQ.refetch()
    },
  })

  // ── Render ────────────────────────────────────────────────────────────────
  const warning = (
    <div className="mb-3 rounded-xl border border-kds-amber/60 bg-kds-amber/10 px-3 py-2" role="note">
      <p className="text-xs font-bold uppercase tracking-wider text-kds-amber">Check the counter phone</p>
      <p className="mt-1 text-sm text-kds-text">{cfg?.warning || RAAST_COUNTER_WARNING}</p>
    </div>
  )
  const cutover = (
    <p className="mb-3 text-xs text-kds-subtext">{cfg?.keenuQrNote || KEENU_QR_CUTOVER_NOTE}</p>
  )

  if (config.isLoading) return <p className="mb-4 text-sm text-kds-subtext">Checking Raast QR…</p>
  if (config.isError) {
    return <p className="mb-4 text-sm text-kds-red" role="alert">{tillErrorMessage(config.error, 'Could not load the Raast QR settings')}</p>
  }
  if (!cfg) {
    return <p className="mb-4 text-sm text-kds-amber">Raast QR is not on this server yet — ask IT to update the API. Take cash or Card – Keenu.</p>
  }
  if (!cfg.available || !cfg.account) {
    return (
      <div className="mb-4">
        <p className="mb-3 text-sm font-semibold text-kds-amber" role="alert">
          Raast is not set up for {brandName ?? 'this brand'} — finance sets the receiving account in Finance → Bank accounts.
          Take cash or Card – Keenu.
        </p>
        {cutover}
      </div>
    )
  }

  const account = cfg.account
  const payee = (
    <div className="mb-3 rounded-xl border border-kds-border px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-kds-subtext">Customer transfers exactly</p>
      <p className="text-2xl font-black text-kds-green">{fmtPkr(intent?.amountCents ?? transferCents)}</p>
      {(intent?.tipCents ?? tipCents) > 0 && (
        <p className="text-xs text-kds-subtext">
          {fmtPkr((intent?.amountCents ?? transferCents) - (intent?.tipCents ?? tipCents))} bill + {fmtPkr(intent?.tipCents ?? tipCents)} tip
        </p>
      )}
      <div className="mt-2 space-y-0.5 text-sm text-kds-text">
        {account.accountTitle && <p><span className="text-kds-subtext">To </span>{account.accountTitle}</p>}
        <p className="text-kds-subtext">
          {[account.bankName, account.last4 ? `account ending ${account.last4}` : null].filter(Boolean).join(' · ')}
        </p>
        {account.raastId && <p><span className="text-kds-subtext">Raast ID </span><span className="font-mono font-bold">{account.raastId}</span></p>}
      </div>
    </div>
  )

  const handForm = (
    <form
      className="mb-3 space-y-2"
      onSubmit={(e) => { e.preventDefault(); if (!confirm.isPending && seen && ref.trim() && !refProblem) confirm.mutate() }}
    >
      <label htmlFor="raast-ref" className="block text-sm text-kds-subtext">Bank reference (transaction ID) from the counter phone</label>
      <input
        id="raast-ref"
        type="text"
        value={ref}
        onChange={(e) => { setRef(e.target.value); confirm.reset() }}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={64}
        placeholder="From the bank SMS or the merchant app"
        className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 font-mono text-lg font-bold text-kds-green"
        autoFocus
      />
      {ref.trim() && refProblem && <p className="text-xs font-semibold text-kds-amber">{refProblem}</p>}
      <label className="flex items-start gap-2 text-sm text-kds-text">
        <input type="checkbox" checked={seen} onChange={(e) => setSeen(e.target.checked)} className="mt-1 h-5 w-5 shrink-0" />
        <span>I saw {fmtPkr(intent?.amountCents ?? transferCents)} arrive on the counter phone (not the customer’s screen).</span>
      </label>
      {confirm.isError && <p className="text-sm text-kds-red" role="alert">{tillErrorMessage(confirm.error, 'The Raast payment was not taken')}</p>}
      <button
        type="submit"
        disabled={confirm.isPending || !seen || !ref.trim() || !!refProblem || transferCents <= 0}
        className="w-full rounded-xl bg-kds-green py-4 text-lg font-bold text-primary-on disabled:opacity-30 active:scale-95"
      >
        {confirm.isPending ? 'Recording…' : `Confirm Raast — ${fmtPkr(intent?.amountCents ?? transferCents)}`}
      </button>
    </form>
  )

  // SMS matching OFF: the reference by hand is the only way.
  if (!cfg.smsMatching && !intent) {
    return (
      <div className="mb-2">
        {payee}
        {warning}
        {handForm}
        {cutover}
      </div>
    )
  }

  // SMS matching ON, no request yet (or the last one ended without money).
  const ended = intent && (intent.status === 'cancelled' || intent.status === 'unreceived')
  if (!intent || ended) {
    return (
      <div className="mb-2">
        {payee}
        {warning}
        {ended && (
          <p className="mb-3 text-sm font-semibold text-kds-amber">
            {intent!.cancelReason === 'expired'
              ? 'The last Raast request expired with no bank SMS. Start again, or enter the reference by hand.'
              : 'The last Raast request was cancelled.'}
          </p>
        )}
        {handOpen ? handForm : (
          <>
            {start.isError && <p className="mb-2 text-sm text-kds-red" role="alert">{tillErrorMessage(start.error, 'Could not start the Raast payment')}</p>}
            <button
              type="button"
              onClick={() => { if (ended) { setIntentId(null); intentKey.current = null } start.mutate() }}
              disabled={start.isPending || transferCents <= 0}
              className="w-full rounded-xl bg-kds-green py-4 text-lg font-bold text-primary-on disabled:opacity-30 active:scale-95"
            >
              {start.isPending ? 'Starting…' : 'Customer is paying — wait for the bank SMS'}
            </button>
          </>
        )}
        <button type="button" onClick={() => { setHandOpen((v) => !v); confirm.reset() }}
          className="mt-2 w-full text-center text-xs font-semibold text-kds-subtext underline">
          {handOpen ? 'Wait for the bank SMS instead' : 'Already paid? Enter the reference by hand'}
        </button>
        <div className="mt-3">{cutover}</div>
      </div>
    )
  }

  // Paid: the modal's done screen takes over (onPaid fired).
  if (PAID.includes(intent.status)) {
    return <p className="mb-4 text-sm font-semibold text-kds-green" role="status">Raast QR received — Ref {intent.bankRef ?? '…'}.</p>
  }

  // Waiting for the bank SMS, or it needs a person.
  const left = secondsLeft(intent.expiresAt, now)
  const earlier = intent.possibleEarlier ?? []
  return (
    <div className="mb-2">
      {payee}
      {warning}
      {intent.status === 'awaiting' ? (
        <div className="mb-3 rounded-xl border border-kds-border px-4 py-3 text-center" role="status" aria-live="polite">
          <p className="font-bold text-kds-text">{intent.settling ? 'Bank SMS received — completing the bill…' : 'Waiting for the bank SMS…'}</p>
          <p className="text-xs text-kds-subtext">
            Bill #{intent.orderRef || orderRef(orderId)}
            {left != null && ` · expires in ${clock(left)}`}
          </p>
        </div>
      ) : (
        <div className="mb-3 rounded-xl border border-kds-amber px-4 py-3" role="alert">
          <p className="font-bold text-kds-amber">This Raast payment needs a person</p>
          <p className="text-sm text-kds-text">
            {attentionText(intent.attentionReason)} Check the counter phone, then enter the reference by hand — or take another tender and tell a manager.
          </p>
        </div>
      )}

      {/* S1: transfers of this amount that arrived just before the request — never attached on their own */}
      {earlier.length > 0 && (
        <div className="mb-3 rounded-xl border border-kds-border px-3 py-2">
          <p className="mb-1 text-xs font-bold uppercase tracking-wider text-kds-subtext">Possible earlier payment</p>
          <p className="mb-2 text-xs text-kds-subtext">
            A transfer of this amount arrived before you started. Attach it only if the counter phone shows it is this customer’s.
          </p>
          {earlier.map((p) => (
            <div key={p.alertId} className="flex items-center justify-between gap-2 py-1">
              <span className="text-sm text-kds-text">
                {fmtPkr(p.amountCents)}{p.payer ? ` from ${p.payer}` : ''}{p.occurredAt ? ` at ${timeOf(p.occurredAt)}` : ''}
                {p.bankRefLast4 && <span className="text-kds-subtext"> · ref …{p.bankRefLast4}</span>}
              </span>
              <button type="button" onClick={() => attach.mutate(p.alertId)} disabled={attach.isPending}
                className="min-h-11 shrink-0 rounded-lg border border-kds-green px-3 py-1 text-xs font-bold text-kds-green disabled:opacity-30">
                Attach
              </button>
            </div>
          ))}
          {attach.isError && <p className="mt-1 text-xs text-kds-red" role="alert">{tillErrorMessage(attach.error, 'Could not attach that transfer')}</p>}
        </div>
      )}

      {handOpen || intent.status === 'needs_attention' ? handForm : (
        <button type="button" onClick={() => { setHandOpen(true); confirm.reset() }}
          className="mb-2 w-full rounded-xl border border-kds-border py-3 text-sm font-bold text-kds-text">
          Enter the reference by hand
        </button>
      )}

      {intent.status === 'awaiting' && (
        <>
          {cancel.isError && <p className="mb-2 text-sm text-kds-red" role="alert">{tillErrorMessage(cancel.error, 'Could not cancel the Raast payment')}</p>}
          <button type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending || !!intent.settling}
            className="min-h-11 w-full rounded-xl border border-kds-red/60 py-2.5 text-sm font-bold text-kds-red disabled:opacity-30">
            {cancel.isPending ? 'Cancelling…' : 'Cancel Raast'}
          </button>
          <p className="mt-2 text-center text-xs text-kds-subtext">
            Nothing else can be taken on this bill while it waits for the transfer.
          </p>
        </>
      )}
      {intentQ.isError && (
        <p className="mt-2 text-xs font-semibold text-kds-amber" role="alert">
          Could not refresh the Raast payment — check the counter phone; the screen retries.
        </p>
      )}
      <div className="mt-3">{cutover}</div>
    </div>
  )
}

function attentionText(reason: string | null): string {
  switch (reason) {
    case 'RAAST_AMOUNT_MISMATCH':
    case 'AMOUNT_MISMATCH':
      return 'The bank SMS was for a different amount than this bill.'
    case 'ALREADY_PAID':
      return 'The bill was already paid when the bank SMS came in.'
    case 'ORDER_NOT_OPEN':
      return 'The order was closed when the bank SMS came in.'
    case null:
    case undefined:
      return 'The bank SMS could not complete this bill on its own.'
    default:
      if (reason.startsWith('SHIFT')) return 'The drawer was closed when the bank SMS came in.'
      return `The bank SMS could not complete this bill (${reason.replace(/_/g, ' ').toLowerCase()}).`
  }
}

/** True while this Raast request holds the bill (no other tender until it settles or is cancelled). */
export function raastBlocks(intent: RaastIntentView | null | undefined): boolean {
  return raastIntentBlocks(intent)
}
