'use client'
// "Charge on card machine" at the till (spec §7). The server pushes the
// amount to the machine, re-quoting the bill first; this component starts the
// charge, follows it live, lets the cashier cancel it, and — when the machine
// did not answer — asks the cashier to READ the machine instead of charging
// again ("Check the card machine"). The Payment is written by the server on
// approval, never by this screen.
//
//   start    POST /pos/terminal/charges   (one idempotency key per attempt,
//            kept in sessionStorage — a double tap or a reload replays it)
//   follow   GET  /pos/terminal/charges/:id   every pollMs, 2 s after 30 s
//   cancel   POST /pos/terminal/charges/:id/cancel
//   resolve  POST /pos/terminal/charges/:id/resolve   (unknown outcome only)
//
// Dark till styling (kds tokens) — the till stays dark.

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../lib/api'
import { fmtPkr, fmtPkrWhole } from '../../lib/money'
import {
  activeTerminalCharges, cancelTerminalCharge, chargeBlocks, chargeKeyFor, chargeSucceeded, dropChargeKey,
  getTerminalCharge, rememberTerminal, rememberedTerminal, resolveTerminalCharge, startTerminalCharge,
  terminalErrorMessage,
  type TerminalChargeStatus, type TerminalChargeView, type TerminalConfig,
} from './tillApi'

interface TerminalChargeProps {
  orderId: string
  shiftId: string
  /** The company's card-machine settings for this drawer (null: the connector was switched off mid-charge). */
  config: TerminalConfig | null
  /** The server's card bill — what is due now (the server re-checks it, 2 paisa tolerance). */
  dueCents: number
  tipCents: number
  /** A charge already in play on this order (resumed after a reload / a closed modal). */
  initialCharge?: TerminalChargeView | null
  /** The charge holds the order (no other tender until it settles or is resolved). */
  onBlockingChange: (blocking: boolean) => void
  /** Every state of the charge this screen follows (null = none) — the modal shows its amount and tip. */
  onChargeChange?: (charge: TerminalChargeView | null) => void
  /** The server recorded the payment (approved, or recorded from the slip). */
  onRecorded: (charge: TerminalChargeView) => void
  /** The bill moved on the server (409 AMOUNT_MISMATCH / ALREADY_PAID) — reload it. */
  onBillChanged: () => void
  /** The machine (or its vendor API) could not be reached, or did not take the card — highlight the manual reference. */
  onMachineDown: () => void
}

/** Statuses the till keeps following on its own. */
const FOLLOW: readonly TerminalChargeStatus[] = ['pending', 'sent', 'approved', 'cancel_requested', 'unknown', 'void_pending']
/** Attempt over with no money taken: a retry needs a NEW idempotency key. */
const NO_MONEY: readonly TerminalChargeStatus[] = ['declined', 'cancelled', 'expired', 'unverified', 'voided']

const REFUSAL_TEXT: Record<string, string> = {
  AMOUNT_MISMATCH: 'the bill changed while the card was being charged',
  ALREADY_PAID: 'the bill had already been paid',
  ORDER_NOT_OPEN: 'the order was closed',
  NOT_YOUR_SHIFT: 'the drawer belongs to another cashier',
  SHIFT_NOT_OPEN: 'the drawer was closed',
  TERMINAL_AMOUNT_MISMATCH: 'the machine charged a different amount',
  ORDER_HAS_ACTIVE_CHARGE: 'another card charge was already running on this bill',
}

function refusalText(code: string | null): string {
  return (code && REFUSAL_TEXT[code]) ?? 'the sale could not take it'
}

function secondsLeft(iso: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000))
}

export function TerminalCharge({
  orderId, shiftId, config, dueCents, tipCents, initialCharge, onBlockingChange, onChargeChange, onRecorded, onBillChanged, onMachineDown,
}: TerminalChargeProps) {
  const qc = useQueryClient()
  const terminals = config?.terminals ?? []
  const [terminalId, setTerminalId] = useState<string>(() => {
    const kept = rememberedTerminal()
    return (kept && terminals.some((t) => t.id === kept) ? kept : terminals[0]?.id) ?? ''
  })
  const [charge, setCharge] = useState<TerminalChargeView | null>(initialCharge ?? null)
  const [starting, setStarting] = useState(false)
  const [acting, setActing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [slipOpen, setSlipOpen] = useState(false)
  const [slipRef, setSlipRef] = useState('')
  const [now, setNow] = useState(() => Date.now())
  // The poll was refused for good (403 / 404): stop asking; reopening the ticket resumes from the server.
  const [pollStopped, setPollStopped] = useState(false)
  const followSince = useRef<number>(Date.now())
  const reported = useRef<string | null>(null)
  // The (due, tip) the current attempt's key was made for — dropped with it.
  const attempt = useRef<{ due: number; tip: number }>({ due: dueCents, tip: tipCents })

  const label = terminals.find((t) => t.id === (charge?.terminalId ?? terminalId))?.label ?? charge?.terminalLabel ?? 'the card machine'
  const pollMs = Math.max(500, config?.pollMs ?? 1500)

  // A charge found on the server after this mounted (the resume query
  // answered late): follow it instead of offering a second charge.
  useEffect(() => {
    if (!charge && initialCharge) { followSince.current = Date.now(); setCharge(initialCharge) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCharge?.id])

  // Gone from the screen: the modal no longer shows this charge's figures.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => onChargeChange?.(null), [])

  // Keep the picked terminal valid when the list changes.
  useEffect(() => {
    if (terminals.length > 0 && !terminals.some((t) => t.id === terminalId)) setTerminalId(terminals[0]!.id)
  }, [terminals, terminalId])

  // Tell the modal whether the order is held, and hand over a success once.
  useEffect(() => {
    onBlockingChange(chargeBlocks(charge))
    onChargeChange?.(charge)
    if (!charge) return
    if (chargeSucceeded(charge) && reported.current !== charge.id) {
      reported.current = charge.id
      dropChargeKey(orderId, attempt.current.due, attempt.current.tip)
      onRecorded(charge)
    }
    if ((NO_MONEY as readonly string[]).includes(charge.status)) {
      dropChargeKey(orderId, attempt.current.due, attempt.current.tip)
      if (charge.status === 'cancelled' && charge.message === 'TERMINAL_UNREACHABLE') onMachineDown()
      // A dead card reader (or a card the machine would not take): the reference link is highlighted.
      if (charge.status === 'expired' || charge.status === 'declined') onMachineDown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charge?.id, charge?.status])

  // Follow the charge: pollMs, slowing to 2 s after 30 s (spec §7.4).
  useEffect(() => {
    if (!charge || pollStopped || !(FOLLOW as readonly string[]).includes(charge.status)) return
    const slow = Date.now() - followSince.current > 30_000 || charge.status === 'unknown' || charge.status === 'void_pending'
    const t = setTimeout(async () => {
      try {
        const next = await getTerminalCharge(charge.id)
        setError(null)
        setCharge(next)
      } catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
          // Not this user's to follow (or gone): never retry forever.
          setPollStopped(true)
          setError(e.status === 403
            ? 'You cannot follow this card charge — ask the cashier who started it, or a manager.'
            : 'This card charge is no longer on the server — close and reopen the ticket.')
          return
        }
        // A network blip: keep the last state and try again on the next tick.
        setError(terminalErrorMessage(e))
        setCharge((c) => (c ? { ...c } : c))
      }
    }, slow ? Math.max(2000, pollMs) : pollMs)
    return () => clearTimeout(t)
  }, [charge, pollMs, pollStopped])

  // The countdown while the machine waits for the card.
  useEffect(() => {
    if (!charge || !['pending', 'sent', 'cancel_requested'].includes(charge.status)) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [charge])

  async function start() {
    if (!terminalId) { setError('Pick a card machine first'); return }
    setError(null)
    setStarting(true)
    attempt.current = { due: dueCents, tip: tipCents }
    try {
      const view = await startTerminalCharge({
        orderId, shiftId, terminalId, tipCents, expectedDueCents: dueCents,
        idempotencyKey: chargeKeyFor(orderId, dueCents, tipCents),
      })
      followSince.current = Date.now()
      setCharge(view)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CHARGE_IN_PROGRESS') {
        // The machine is already on this bill (another tab, a lost answer): follow that charge.
        const active = await activeTerminalCharges(orderId).catch(() => [])
        const running = active.find((c) => c.kind === 'charge' && chargeBlocks(c)) ?? active[0] ?? null
        if (running) { followSince.current = Date.now(); setCharge(running) }
        else setError('The card machine is already working on this bill — wait a moment and try again.')
      } else if (e instanceof ApiError && (e.code === 'AMOUNT_MISMATCH' || e.code === 'ALREADY_PAID')) {
        dropChargeKey(orderId, dueCents, tipCents)
        onBillChanged()
      } else {
        if (e instanceof ApiError && (e.code === 'TERMINAL_NOT_CONFIGURED' || e.status === 0)) onMachineDown()
        // Switched off mid-shift: ask for the config again — it now reads
        // enabled:false and the till falls back to the reference field.
        if (e instanceof ApiError && e.code === 'TERMINAL_NOT_CONFIGURED') {
          void qc.invalidateQueries({ queryKey: ['pos', 'terminal-config', shiftId] })
        }
        setError(terminalErrorMessage(e))
      }
    } finally {
      setStarting(false)
    }
  }

  async function act(fn: () => Promise<TerminalChargeView>) {
    setError(null)
    setActing(true)
    try {
      setCharge(await fn())
    } catch (e) {
      setError(terminalErrorMessage(e))
      if (charge) setCharge(await getTerminalCharge(charge.id).catch(() => charge))
    } finally {
      setActing(false)
    }
  }

  function startOver() {
    setPollStopped(false)
    setCharge(null)
    setSlipOpen(false)
    setSlipRef('')
    setError(null)
  }

  const s = charge?.status
  const left = charge ? secondsLeft(charge.expiresAt, now) : 0
  const resolvable = !!charge && (s === 'unknown' || (s === 'cancel_requested' && left === 0))

  return (
    <div className="space-y-3">
      {config?.isTest && (
        <p className="inline-block rounded border border-kds-amber px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-kds-amber">
          Test card machine — no real money moves
        </p>
      )}
      {config?.online === false && !charge && (
        <p className="text-sm font-semibold text-kds-amber">Card machine offline — it did not answer the last check.</p>
      )}

      {/* ── No charge yet: pick the machine, charge ───────────────────────── */}
      {!charge && (
        <>
          {terminals.length > 1 && (
            <div>
              <p className="mb-1 text-sm text-kds-subtext">Card machine</p>
              <div className="flex flex-wrap gap-2">
                {terminals.map((t) => (
                  <button key={t.id} type="button"
                    onClick={() => { setTerminalId(t.id); rememberTerminal(t.id) }}
                    aria-pressed={terminalId === t.id}
                    className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                      terminalId === t.id ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-subtext'
                    }`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => void start()}
            disabled={starting || dueCents <= 0 || !terminalId}
            className="w-full rounded-xl bg-kds-green py-4 text-lg font-bold text-white disabled:opacity-30 active:scale-95"
          >
            {starting ? 'Sending to the card machine…' : `Charge ${fmtPkrWhole(dueCents + tipCents)} on ${label}`}
          </button>
        </>
      )}

      {/* ── Waiting for the card ──────────────────────────────────────────── */}
      {charge && (s === 'pending' || s === 'sent') && (
        <div className="rounded-xl border border-kds-blue/50 bg-kds-blue/10 p-4 text-center" role="status" aria-live="polite">
          <p className="text-lg font-bold text-kds-text">Insert / tap card on {label}…</p>
          <p className="mt-1 text-sm text-kds-subtext">{fmtPkr(charge.amountCents)} · {left > 0 ? `${left}s left` : 'checking with the machine…'}</p>
          <button type="button" onClick={() => void act(() => cancelTerminalCharge(charge.id))} disabled={acting}
            className="mt-3 rounded-lg border border-kds-border px-4 py-2 text-sm font-semibold text-kds-subtext disabled:opacity-40">
            {acting ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      )}

      {charge && s === 'cancel_requested' && !resolvable && (
        <div className="rounded-xl border border-kds-border p-4 text-center" role="status">
          <p className="font-semibold text-kds-text">Cancelling on the card machine…</p>
          <p className="mt-1 text-xs text-kds-subtext">If the card was already approved, the payment is still recorded — nothing is lost.</p>
        </div>
      )}

      {charge && s === 'approved' && (
        <p className="rounded-xl border border-kds-green/40 bg-kds-green/10 p-4 text-center font-semibold text-kds-green" role="status">
          Approved — recording the payment…
        </p>
      )}

      {/* ── The machine did not answer: read the machine, never charge again ─ */}
      {charge && resolvable && (
        <div className="space-y-3 rounded-xl border border-kds-amber bg-kds-amber/10 p-4" role="alert">
          <p className="font-bold text-kds-amber">Check the card machine</p>
          <p className="text-sm text-kds-text">
            The card machine did not answer. Look at {label} and tell servd what it shows.
            Do not charge the card again on the machine.
          </p>
          {!slipOpen ? (
            <div className="grid gap-2">
              <button type="button" onClick={() => setSlipOpen(true)} disabled={acting}
                className="rounded-lg border border-kds-green px-3 py-3 text-sm font-bold text-kds-green disabled:opacity-40">
                It shows APPROVED — enter the slip reference
              </button>
              <button type="button" disabled={acting}
                onClick={() => void act(() => resolveTerminalCharge(charge.id, { outcome: 'not_charged' }))}
                className="rounded-lg border border-kds-border px-3 py-3 text-sm font-bold text-kds-subtext disabled:opacity-40">
                {acting ? 'Saving…' : 'Declined / nothing on the machine'}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <label htmlFor="slip-ref" className="block text-sm text-kds-subtext">Reference printed on the machine slip</label>
              <input id="slip-ref" type="text" value={slipRef} onChange={(e) => setSlipRef(e.target.value)} autoFocus
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 text-lg font-bold text-kds-green" />
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setSlipOpen(false)} disabled={acting}
                  className="rounded-lg border border-kds-border py-2 text-sm text-kds-subtext">Back</button>
                <button type="button" disabled={acting || slipRef.trim().length < 3}
                  onClick={() => void act(() => resolveTerminalCharge(charge.id, { outcome: 'approved_manual', gatewayRef: slipRef.trim() }))}
                  className="rounded-lg bg-kds-green py-2 text-sm font-bold text-white disabled:opacity-30">
                  {acting ? 'Recording…' : 'Record payment'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Over, no money taken ──────────────────────────────────────────── */}
      {charge && (s === 'declined' || s === 'cancelled' || s === 'expired' || s === 'unverified') && (
        <div className="space-y-2 rounded-xl border border-kds-border p-4" role="status">
          <p className="font-semibold text-kds-text">
            {s === 'declined' ? 'Declined — the card was not charged.'
              : s === 'expired' ? 'Timed out — the card was not charged.'
              : s === 'unverified' ? 'Marked as not charged — take the payment another way.'
              : charge.message === 'TERMINAL_UNREACHABLE' ? 'Card machine offline — nothing was sent to it.'
              : 'Cancelled — the card was not charged.'}
          </p>
          {charge.message && charge.message !== 'TERMINAL_UNREACHABLE' && s !== 'unverified' && (
            <p className="text-xs text-kds-subtext">{charge.message}</p>
          )}
          <button type="button" onClick={startOver}
            className="w-full rounded-lg border border-kds-green py-2 text-sm font-bold text-kds-green">
            Try the card machine again
          </button>
        </div>
      )}

      {/* ── Charged, but the sale refused it: reversed (or failing to) ─────── */}
      {charge && s === 'void_pending' && (
        <p className="rounded-xl border border-kds-amber bg-kds-amber/10 p-4 text-sm font-semibold text-kds-amber" role="alert">
          The card was charged but {refusalText(charge.refusalCode)} — reversing it on the machine automatically…
        </p>
      )}
      {charge && s === 'voided' && (
        <div className="space-y-2 rounded-xl border border-kds-border p-4" role="status">
          <p className="text-sm font-semibold text-kds-text">
            The card was charged but {refusalText(charge.refusalCode)} — reversed automatically. Nothing was taken.
          </p>
          <button type="button" onClick={startOver}
            className="w-full rounded-lg border border-kds-green py-2 text-sm font-bold text-kds-green">
            Check the bill and charge again
          </button>
        </div>
      )}
      {charge && s === 'needs_attention' && (
        <p className="rounded-xl border border-kds-red bg-kds-red/10 p-4 text-sm font-semibold text-kds-red" role="alert">
          {charge.refusalCode
            ? `The card was charged but ${refusalText(charge.refusalCode)} — the reversal FAILED. A manager has been alerted.`
            : 'This card charge needs a manager — they have been alerted.'}
          {charge.message ? ` (${charge.message})` : ''}
        </p>
      )}

      {charge && chargeSucceeded(charge) && (
        <p className="rounded-xl border border-kds-green/40 bg-kds-green/10 p-3 text-center text-sm font-semibold text-kds-green" role="status">
          {s === 'manual_resolved' ? 'Recorded from the machine slip.' : 'Card approved.'}
        </p>
      )}

      {error && <p className="text-sm text-kds-red" role="alert">{error}</p>}
    </div>
  )
}
