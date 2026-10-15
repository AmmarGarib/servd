'use client'
// On account at the till (corporate clients; backend pos/onAccountRoutes.ts).
// A named client's whole bill is charged to its account with the client's
// card: the cashier scans the card's QR (a keyboard-wedge scanner types the
// code and Enter into the box below, or the tablet camera reads it), the
// server names the client IN THE ORDER'S COMPANY with its credit and the bill
// at the cash rate, and one tap charges it. No manager PIN: the card, the
// credit limit and the client's signature on the bill are the control.
//
// The card code is a bearer secret. It is sent only in request bodies, never
// shown back, never logged, never put in a query key, and forgotten as soon as
// the charge is sent or this panel closes.
//
// Dark till styling (kds tokens); text labels, no emoji.

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ApiError } from '../../lib/api'
import { PasswordInput } from '../ui/PasswordInput'
import { fmtPkr, fmtPkrWhole } from '../../lib/money'
import {
  chargeOnAccount, lookupOnAccount, newOnAccountKey, onAccountErrorText, onAccountQuote, tillErrorMessage,
  type FiscalView, type OnAccountLookup, type OnAccountQuote,
} from './tillApi'

/** What the done screen shows of an on-account charge. */
export interface OnAccountDone {
  number: string
  name: string
  cardLabel: string
  reference: string | null
}

interface OnAccountPanelProps {
  orderId: string
  shiftId: string
  /** The bill moved on the server (ALREADY_PAID, a re-price) — reload it. */
  onBillChanged: () => void
  /** The bill is charged and the sale completed. */
  onCharged: (r: { fiscal?: FiscalView | null; client: OnAccountDone }) => void
}

// The Shape Detection API (Chrome / Android WebView); typed here because the DOM lib does not carry it yet.
interface DetectedBarcode { rawValue: string }
interface BarcodeDetectorLike { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike

function barcodeDetector(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  return typeof ctor === 'function' ? ctor : null
}

const CODE_MAX = 40

/** One on-account submission: its idempotency key and what it was sent with. */
interface Submission {
  signature: string
  key: string
  cardId: string
  reference: string | null
  /** Sent, answer lost — the replay after the rescan re-sends this key. */
  unresolved: boolean
}

/** Refused in the browser before anything was sent. */
class NotSentError extends Error {}

/** The charge may have gone through: no answer, or the server failed after (maybe) committing. */
function outcomeUnknown(e: unknown): boolean {
  if (e instanceof NotSentError) return false
  if (!(e instanceof ApiError)) return true
  return e.status === 0 || e.status >= 500
}

function blockText(b: { code: string; message: string; details?: unknown }): string {
  return onAccountErrorText(b) ?? b.message
}

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return onAccountErrorText(e) ?? tillErrorMessage(e, fallback)
  return tillErrorMessage(e, fallback)
}

export function OnAccountPanel({ orderId, shiftId, onBillChanged, onCharged }: OnAccountPanelProps) {
  // The typed / scanned code lives only in the input until it is looked up,
  // then only in this ref until the charge is sent. Never rendered back.
  const [typed, setTyped] = useState('')
  const codeRef = useRef<string | null>(null)
  const [found, setFound] = useState<OnAccountLookup | null>(null)
  const [reference, setReference] = useState('')
  const [scanError, setScanError] = useState<string | null>(null)
  const [needsRescan, setNeedsRescan] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // One idempotency key per submission (client + bill + reference), reused only by its retry.
  // `unresolved`: the charge was sent but its answer was lost (network drop, 5xx) — the
  // server may have billed the client. The key is kept through the rescan and the SAME
  // key is sent again, so the server's replay (step 2) answers with the charge it made,
  // or the charge goes through once if it never did. Never a second bill.
  const submission = useRef<Submission | null>(null)
  const [replayNote, setReplayNote] = useState(false)

  // Forget the code when the panel closes.
  useEffect(() => () => { codeRef.current = null }, [])

  // The bill at the cash rate, before any card is scanned.
  const quote = useQuery({
    queryKey: ['pos', 'on-account-quote', orderId],
    queryFn: () => onAccountQuote(orderId),
    retry: false,
    refetchOnWindowFocus: false,
    meta: { inlineErrors: true },
  })
  const bill: OnAccountQuote | null = found?.quote ?? quote.data ?? null

  // Not a react-query mutation on purpose: a mutation keeps its variables (the code) in the cache.
  const [lookupPending, setLookupPending] = useState(false)
  const [lookupError, setLookupError] = useState<unknown>(null)
  async function runLookup(code: string) {
    setLookupPending(true)
    setLookupError(null)
    try {
      const r = await lookupOnAccount(orderId, code)
      codeRef.current = code
      setFound(r)
      setNeedsRescan(false)
      const pending = submission.current
      if (pending?.unresolved && pending.cardId === r.card.id) {
        // The same card for a charge whose answer was lost: ask again with the SAME key,
        // even though the lookup now says the bill is closed (it is, if the charge went through).
        setReference(pending.reference ?? '')
        charge.mutate({ lookup: r })
      } else {
        submission.current = null
        setReplayNote(false)
      }
    } catch (e) {
      codeRef.current = null
      setFound(null)
      setLookupError(e)
    } finally {
      setTyped('')
      setLookupPending(false)
      // A refused card: back to the scan box for the next scan.
      if (!codeRef.current) setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  function submitCode(raw: string) {
    const code = raw.trim()
    if (!code || lookupPending) return
    setScanError(null)
    charge.reset()
    if (code.length > CODE_MAX) {
      setTyped('')
      setScanError('That is not a client card code. Scan the QR on the client’s card again.')
      return
    }
    void runLookup(code)
  }

  function scanAnother() {
    codeRef.current = null
    setFound(null)
    setNeedsRescan(false)
    setLookupError(null)
    charge.reset()
    // A charge whose answer was lost keeps its key (and reference) for the replay.
    if (!submission.current?.unresolved) {
      submission.current = null
      setReference('')
    }
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  // ── Camera (BarcodeDetector) ──────────────────────────────────────────────
  const Detector = barcodeDetector()
  const [cameraOn, setCameraOn] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    if (!cameraOn || !Detector) return
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let stopped = false
    const stop = () => {
      stopped = true
      if (timer) clearInterval(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
    ;(async () => {
      try {
        const detector = new Detector({ formats: ['qr_code'] })
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()
        timer = setInterval(async () => {
          if (stopped || video.readyState < 2) return
          try {
            const codes = await detector.detect(video)
            const value = codes.find((c) => c.rawValue)?.rawValue
            if (value && !stopped) {
              stop()
              setCameraOn(false)
              submitCode(value)
            }
          } catch { /* a frame the detector could not read — try the next one */ }
        }, 300)
      } catch {
        setCameraOn(false)
        setScanError('The camera could not be opened. Use the scanner, or type the code printed under the QR.')
      }
    })()
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn])

  // ── The charge ────────────────────────────────────────────────────────────
  // Variables carry the lookup only — never the code (a mutation keeps its variables in the cache).
  const charge = useMutation({
    meta: { inlineErrors: true },
    mutationFn: async ({ lookup }: { lookup: OnAccountLookup }) => {
      const code = codeRef.current
      if (!code) throw new NotSentError('Scan the client’s card again.')
      const pending = submission.current
      if (pending?.unresolved && pending.cardId === lookup.card.id) {
        // The replay of a charge whose answer was lost: same key, same reference.
        return chargeOnAccount(orderId, { shiftId, code, reference: pending.reference, idempotencyKey: pending.key })
      }
      const ref = reference.trim()
      const signature = `${orderId}|${lookup.account.id}|${lookup.card.id}|${lookup.quote.dueCents}|${ref}`
      if (submission.current?.signature !== signature) {
        submission.current = { signature, key: newOnAccountKey(), cardId: lookup.card.id, reference: ref || null, unresolved: false }
      }
      return chargeOnAccount(orderId, { shiftId, code, reference: ref || null, idempotencyKey: submission.current.key })
    },
    onSuccess: (r, { lookup }) => {
      const client: OnAccountDone = {
        number: lookup.account.number,
        name: lookup.account.legalName,
        cardLabel: lookup.card.label,
        reference: submission.current?.reference ?? (reference.trim() || null),
      }
      submission.current = null
      setReplayNote(false)
      onCharged({ fiscal: r.fiscal, client })
    },
    onError: (e) => {
      if (outcomeUnknown(e)) {
        // The server may have billed the client: keep the key for the replay after the rescan.
        if (submission.current) submission.current.unresolved = true
        setReplayNote(true)
      } else {
        // A definite refusal: nothing was charged with this key.
        submission.current = null
        setReplayNote(false)
        // The bill moved on the server — reload it (the modal's and this panel's) and look again.
        if (e instanceof ApiError && (e.code === 'ALREADY_PAID' || e.code === 'AMOUNT_MISMATCH' || e.code === 'ON_ACCOUNT_RATE')) {
          onBillChanged()
          void quote.refetch()
        }
      }
      // The panel never re-sends a code it has let go of; a retry asks for the card again.
      setNeedsRescan(true)
    },
    onSettled: () => {
      // Sent: forget the code (a retry scans the card again).
      codeRef.current = null
    },
  })

  const account = found?.account ?? null
  const due = bill?.dueCents ?? 0
  const refRequired = !!account?.requiresReference
  const usedPct = account && account.limitCents > 0
    ? Math.min(100, Math.max(0, Math.round((account.exposureCents / account.limitCents) * 100)))
    : 100
  const availablePct = 100 - usedPct
  const fitsCredit = !!account && account.availableCents >= due
  const canCharge = !!found && !found.blocked && !needsRescan && !charge.isPending && due > 0
    && (!refRequired || reference.trim().length > 0)

  return (
    <div className="space-y-3">
      {/* The bill at the cash rate (an on-account bill's rate) */}
      <div className="space-y-1 rounded-xl border border-kds-border px-4 py-3 text-sm">
        {bill ? (
          <>
            {bill.discountCents > 0 && <Line label="Discount" value={`−${fmtPkr(bill.discountCents)}`} tone="amber" />}
            <Line label={`GST${bill.taxRatePct != null ? ` (${bill.taxRatePct}%, cash rate)` : ' (cash rate)'}`} value={fmtPkr(bill.taxCents)} />
            {bill.serviceChargeCents > 0 && <Line label="Service charge" value={fmtPkr(bill.serviceChargeCents)} />}
            <Line label="Charge to the client" value={fmtPkr(due)} strong />
          </>
        ) : quote.isError ? (
          <p className="text-sm text-kds-red">{errorText(quote.error, 'Could not get the bill from the server')}</p>
        ) : (
          <p className="text-sm text-kds-subtext">Getting the bill from the server…</p>
        )}
      </div>

      {!found ? (
        <div className="space-y-2">
          <label htmlFor="oa-code" className="block text-sm text-kds-subtext">Scan the client’s card</label>
          <PasswordInput
            id="oa-code"
            ref={inputRef}
            maxLength={CODE_MAX + 1}
            value={typed}
            onChange={(e) => setTyped(e.target.value.slice(0, CODE_MAX + 1))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitCode(typed) } }}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="text"
            placeholder="Scan the QR, or type the code under it"
            disabled={lookupPending}
            className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 text-lg font-bold text-kds-text disabled:opacity-60"
          />
          <div className="flex gap-2">
            <button type="button" onClick={() => submitCode(typed)} disabled={!typed.trim() || lookupPending}
              className="flex-1 rounded-xl border border-kds-border py-2.5 text-sm font-semibold text-kds-text disabled:opacity-30">
              {lookupPending ? 'Checking the card…' : 'Look up card'}
            </button>
            {Detector ? (
              <button type="button" onClick={() => { setScanError(null); setCameraOn((v) => !v) }} disabled={lookupPending}
                className="flex-1 rounded-xl border border-kds-border py-2.5 text-sm font-semibold text-kds-text disabled:opacity-30">
                {cameraOn ? 'Stop camera' : 'Use camera'}
              </button>
            ) : null}
          </div>
          {!Detector && (
            <p className="text-xs text-kds-subtext">This browser cannot read a QR with the camera. Use the scanner, or type the code printed under the QR.</p>
          )}
          {cameraOn && (
            <video ref={videoRef} muted playsInline className="w-full rounded-lg border border-kds-border bg-kds-bg" aria-label="Camera — hold the client’s card QR in view" />
          )}
          {scanError && <p className="text-sm text-kds-red" role="alert">{scanError}</p>}
          {lookupError != null && <p className="text-sm text-kds-red" role="alert">{errorText(lookupError, 'Could not check the card')}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {/* The client */}
          <div className="rounded-xl border border-kds-border px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-bold text-kds-text">{found.account.legalName}</p>
                <p className="text-xs text-kds-subtext">
                  Account {found.account.number} · {found.card.label} <span className="font-mono">{found.card.hint}</span>
                </p>
              </div>
              <button type="button" onClick={scanAnother} disabled={charge.isPending}
                className="shrink-0 text-xs font-semibold text-kds-green disabled:opacity-30">
                Other card
              </button>
            </div>
            {/* Available credit */}
            <div className="mt-3">
              <div className="flex justify-between text-xs">
                <span className="text-kds-subtext">Available credit</span>
                <span className={`font-bold ${fitsCredit ? 'text-kds-green' : 'text-kds-red'}`}>
                  {fmtPkrWhole(found.account.availableCents)} of {fmtPkrWhole(found.account.limitCents)}
                </span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-kds-border" role="progressbar"
                aria-label="Available credit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={availablePct}>
                <div className={`h-full rounded-full ${fitsCredit ? 'bg-kds-green' : 'bg-kds-red'}`} style={{ width: `${availablePct}%` }} />
              </div>
            </div>
          </div>

          {found.blocked && (
            <p className="rounded-lg border border-kds-red px-3 py-2 text-sm text-kds-red" role="alert">{blockText(found.blocked)}</p>
          )}

          {!found.blocked && (
            <div>
              <label htmlFor="oa-ref" className="mb-1 block text-sm text-kds-subtext">
                Reference {refRequired ? '(required — PO number or who signed)' : '(optional — PO number or who signed)'}
              </label>
              <input
                id="oa-ref"
                type="text"
                value={reference}
                maxLength={80}
                onChange={(e) => setReference(e.target.value)}
                autoComplete="off"
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text"
              />
            </div>
          )}

          {charge.isPending && found.blocked && (
            <p className="text-sm text-kds-subtext" role="status">Checking whether the charge went through…</p>
          )}
          {charge.isError && (
            replayNote ? (
              <p className="text-sm text-kds-amber" role="alert">
                The till lost the server’s answer — the charge may have gone through. Scan the same card again: the till checks with the server before anything is charged, so the client is never billed twice.
              </p>
            ) : (
              <p className="text-sm text-kds-red" role="alert">{errorText(charge.error, 'The charge did not go through')}</p>
            )
          )}
          {needsRescan && (!found.blocked || replayNote) && (
            <button type="button" onClick={scanAnother}
              className="w-full rounded-xl border border-kds-amber py-2.5 text-sm font-bold text-kds-amber">
              {replayNote ? 'Scan the same card again to check' : 'Scan the card again to retry'}
            </button>
          )}

          {!found.blocked && !needsRescan && (
            <button type="button" onClick={() => charge.mutate({ lookup: found })} disabled={!canCharge}
              className="w-full rounded-xl bg-kds-green py-4 text-lg font-bold text-white disabled:opacity-30 active:scale-95">
              {charge.isPending ? 'Charging…' : `Charge ${fmtPkrWhole(due)} to ${found.account.legalName}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Line({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'amber' }) {
  return (
    <div className={`flex justify-between ${strong ? 'pt-1 text-base font-bold text-kds-text' : tone === 'amber' ? 'text-kds-amber' : 'text-kds-subtext'}`}>
      <span>{label}</span>
      <span className={strong ? 'text-kds-green' : undefined}>{value}</span>
    </div>
  )
}
