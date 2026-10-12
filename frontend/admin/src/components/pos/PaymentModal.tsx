'use client'
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { posApi, ApiError } from '../../lib/api'
import { compOverrideMessage, managerPinLockedMessage, tenderNeedsPinBox, WRONG_PIN_MESSAGE } from './pinErrors'
import { useIsManager } from './managerRole'
import { usePosStore } from '../../store/pos'
import { useAuthStore } from '../../store/auth'
import { fmtPkr, fmtPkrWhole } from '../../lib/money'
import {
  activeRaastIntents, activeTerminalCharges, billFor, chargeBlocks, fetchOrder, fetchOrderFiscal, fetchReceiptHtml, fiscalLine,
  isFiscalHeld, isOfflinePlaceholder, isPreBillRequired, isTillTender, newIdempotencyKey, payOrder, preBillErrorMessage, printHtml,
  printPreBill, raastIntentBlocks, ringUp, storedQuote, tillErrorMessage, useCartQuote, useTerminalConfig,
  type FiscalView, type RaastIntentView, type TerminalChargeView, type TillBrand, type TillOrder, type TillQuote,
} from './tillApi'
import { TerminalCharge } from './TerminalCharge'
import { RaastPanel, type RaastDone } from './RaastPanel'
import { orderRef } from '../../lib/orderRef'

/** What the done screen shows: change due, the sale's fiscal document, the card the machine took. */
interface Done {
  changeCents: number
  /** undefined = the API did not say (older API) — the done screen asks GET /pos/orders/:id/fiscal. */
  fiscal?: FiscalView | null
  card?: { brand: string | null; last4: string | null; approvalRef: string | null } | null
  /** A Raast QR transfer: its bank reference — provisional until the bank statement matches it. */
  raast?: RaastDone | null
  at: number
}

interface PaymentModalProps {
  /** The brand being rung (its tender GST rates come from the server's brand list). */
  brand: TillBrand | undefined
  /** An order already rung (an open ticket a waiter sent, FOH-20). Omitted →
   *  the cart is rung up first. */
  ticket?: TillOrder
  onClose: () => void
}

// F-PAY02: wallet methods removed in v1 — re-add when adapters ship.
// Owner, 2026-10-12: Raast QR replaces Keenu QR at the till (Keenu QR is
// retired; a payment made to an old Keenu QR standee is taken as Card – Keenu).
type PaymentMethod = 'cash' | 'card' | 'raast' | 'comp' | 'staff_meal'

// FOH-02: the till charges the SERVER's bill. Two steps:
//   1. Ring up — POST /pos/orders (priced by the server for the chosen tender
//      when the API takes it). The ticket fires and the cart becomes an order.
//   2. Take payment — the bill for the tender the customer pays with, from the
//      server (GET /pos/orders/:id/quote; a card or Raast QR payment is
//      re-priced at the digital rate (8%), cash 15%), and exactly that amount
//      is sent to POST /pos/payments (Raast QR: RaastPanel).
// An open ticket starts at step 2. Nothing here computes GST.
export function PaymentModal({ brand, ticket, onClose }: PaymentModalProps) {
  const qc = useQueryClient()
  const {
    cart, discountCents, discountReason, shiftId, tableId, customerId,
    clearCart, ensureCheckoutKey, lines, itemTotalCents,
  } = usePosStore()

  const [order, setOrder] = useState<TillOrder | null>(ticket ?? null)
  const [queuedOffline, setQueuedOffline] = useState(false)
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [tendered, setTendered] = useState('')
  const [compReason, setCompReason] = useState('')
  const [managerPin, setManagerPin] = useState('')
  // A manager (the server's override approvers) approves a staff meal with
  // their own session; everyone else types a manager's PIN (backend compOrder:
  // every staff meal needs a manager, at any amount).
  const isManager = useIsManager()
  const pinBoxShown = tenderNeedsPinBox(method, isManager)
  const [gatewayRef, setGatewayRef] = useState('')
  const [staffMealFor, setStaffMealFor] = useState('')
  const [billChanged, setBillChanged] = useState(false)
  const [tip, setTip] = useState('')
  // FOH-04: one key per payment submission (order, tender, amount, tip),
  // reused by its retries — a double tap or a lost response never charges
  // twice. Dropped once the payment goes through.
  const paySubmission = useRef<{ signature: string; key: string } | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  // Card machine (spec §7): the company's terminals for this drawer, whether a
  // charge is holding the order, and the manual-reference fallback.
  const [chargeBlocking, setChargeBlocking] = useState(false)
  // The charge the card machine is working on (TerminalCharge reports it).
  // While it holds the order the tip and total on screen are the CHARGE's and
  // the tip cannot be edited — the machine was sent due + that tip (W3b-R5).
  const [runningCharge, setRunningCharge] = useState<TerminalChargeView | null>(null)
  const [machineDown, setMachineDown] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [preBillMsg, setPreBillMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [preBillBusy, setPreBillBusy] = useState(false)

  const tender = isTillTender(method) ? method : null
  const cartLines = lines()

  // ── Step 1: ring up the cart ──────────────────────────────────────────────
  const preview = useCartQuote(order ? null : brand?.id ?? null, cartLines, discountCents, tender ?? 'cash')
  const ring = useMutation({
    meta: { inlineErrors: true },
    mutationFn: () => {
      if (!brand) throw new Error('Pick a brand before ringing up')
      return ringUp({
        conceptId: brand.id,
        // Same cart → same key, so a double tap or a retry after a lost
        // response returns the SAME order instead of firing a second ticket.
        idempotencyKey: ensureCheckoutKey(),
        tableId,
        customerId,
        shiftId,
        discountCents,
        ...(discountReason && { discountReason }),
        // Ask the server to price it for the tender the customer said they'll
        // use. A comp / staff meal is not a tender: priced as rung (cash).
        ...(tender && { paymentMethod: tender }),
        items: cartLines,
      })
    },
    onSuccess: (r) => {
      // The cart is now an order (or queued for one) — never ring it twice.
      clearCart()
      void qc.invalidateQueries({ queryKey: ['pos', 'open-tickets'] })
      if (isOfflinePlaceholder(r)) { setQueuedOffline(true); return }
      setOrder(r)
    },
  })

  // ── Step 2: the server's bill for the chosen tender ───────────────────────
  const stored = order ? storedQuote(order) : null
  const bill = useQuery({
    queryKey: ['pos', 'bill', order?.id, tender, order?.totalCents, stored?.paidCents],
    queryFn: () => billFor(order!, tender!, brand),
    enabled: !!order && !!tender && !done,
    retry: false,
    // The figure the cashier keys into the card machine must not change
    // under them on a focus refetch; it changes on a tender tap, or after the
    // server refuses a payment because the bill moved (shown explicitly).
    refetchOnWindowFocus: false,
  })
  // What is shown and charged: the tender's bill from the server; for a comp
  // or staff meal, the order's stored bill (a comp is not a tender, nothing is
  // re-priced).
  const shown: TillQuote | null = tender
    ? (bill.data && bill.data.kind !== 'unavailable' ? bill.data.quote : null)
    : stored
  const due = shown?.dueCents ?? 0
  const unavailable = tender && bill.data?.kind === 'unavailable' ? bill.data.message : null

  // Raast QR (RaastPanel): the request waiting for the customer's transfer,
  // or one that needs a person. While it waits nothing else may settle the
  // bill (the server's RAAST_AWAITING guard); its amount (due + tip) is fixed.
  const [raastIntent, setRaastIntent] = useState<RaastIntentView | null>(null)
  const raastBlocking = raastIntentBlocks(raastIntent)
  const raastHeld = raastIntent && (raastIntent.status === 'awaiting' || raastIntent.status === 'needs_attention') ? raastIntent : null
  /** Something on the server holds this bill: a card-machine charge or a waiting Raast request. */
  const holding = chargeBlocking || raastBlocking

  // FOH-14: a tip on a card / Raast payment rides on the charge (the terminal
  // is keyed for due + tip; the Raast transfer is due + tip). Offered only
  // when the server's bill says the API takes tips (the quote carries
  // tipCents) — never sent to an API that would read it as an overpayment.
  const tipsAccepted = (method === 'card' || method === 'raast')
    && bill.data?.kind === 'server' && bill.data.quote.tipCents !== undefined
  const tipCents = tipsAccepted ? Math.max(0, Math.round(parseFloat(tip || '0') * 100) || 0) : 0
  const chargeCents = due + tipCents
  const heldTip = chargeBlocks(runningCharge) ? runningCharge : null
  const tipLocked = chargeBlocking || !!heldTip || !!raastHeld

  const tenderedCents = method === 'cash' ? Math.round(parseFloat(tendered || '0') * 100) : 0
  const changeCents = method === 'cash' && shown ? Math.max(0, tenderedCents - due) : 0

  // ── Card machine ──────────────────────────────────────────────────────────
  // The connector on + a terminal at this drawer's outlet → "Charge on card
  // machine". Otherwise (connector off, an older API) the till is exactly the
  // manual flow: the cashier keys the machine and types its reference.
  const termConfig = useTerminalConfig(shiftId)
  const terminal = termConfig.data ?? null
  const terminalOn = !!terminal?.enabled && terminal.terminals.length > 0
  // A charge already in play on this order (a reload, the modal closed while
  // the machine waited): resume it — all state is on the server.
  // Always asked fresh when the modal opens (W3b-R2): a cached answer from an
  // earlier open would hide a charge started since, and unlock other tenders
  // on a bill the machine may already have charged. Not refetched while open
  // (the charge itself is followed by TerminalCharge).
  const active = useQuery({
    queryKey: ['pos', 'active-charge', order?.id],
    queryFn: () => activeTerminalCharges(order!.id),
    enabled: !!order && !done,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: 'always',
    retry: false,
    meta: { inlineErrors: true },
  })
  // The same for a Raast QR request waiting for the customer's transfer (or
  // one that needs a person): resume it on the Raast screen.
  const activeRaast = useQuery({
    queryKey: ['pos', 'active-raast', order?.id],
    queryFn: () => activeRaastIntents(order!.id),
    enabled: !!order && !done,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: 'always',
    retry: false,
    meta: { inlineErrors: true },
  })
  // Until the resume answers are in, no tender is offered (it may be a running charge or a waiting Raast request).
  const resumeSettled = !order || !!done || (active.isFetchedAfterMount && activeRaast.isFetchedAfterMount)
  const resumeCharge: TerminalChargeView | null =
    active.data?.find((c) => c.kind === 'charge' && (chargeBlocks(c) || c.status === 'void_pending' || c.status === 'needs_attention')) ?? null
  const resumeRaast: RaastIntentView | null =
    activeRaast.data?.find((i) => i.status === 'awaiting') ?? activeRaast.data?.find((i) => i.status === 'needs_attention') ?? null
  useEffect(() => {
    if (resumeCharge) setMethod('card')
    else if (resumeRaast) setMethod('raast')
  }, [resumeCharge, resumeRaast])
  const configSettled = !shiftId || termConfig.isSuccess || termConfig.isError
  const useTerminal = method === 'card' && (terminalOn || !!resumeCharge) && !manualOpen
  // The manual reference (spec §7.2): a collapsed link whenever the company
  // allows it — a dead card reader, a backup or standalone machine — and
  // highlighted when the machine reads offline / did not take the last attempt.
  const manualFallback = terminalOn && !!terminal?.allowManualRef
  const machineLooksDown = machineDown || terminal?.online === false
  // Raast QR takes its bank reference on its own screen (RaastPanel).
  const needsRef = method === 'card' && configSettled && !useTerminal

  const pay = useMutation({
    meta: { inlineErrors: true },
    mutationFn: async () => {
      if (!order || !shiftId) throw new Error('Open a shift before taking payment')
      // A comp is not a tender: it goes through the one comp engine (policy
      // caps, manager PIN above the cashier's cap, audit, on this drawer),
      // which completes the order once the comp covers it.
      if (method === 'comp' || method === 'staff_meal') {
        // A staff meal is a comp rung through the till (owner decision 11):
        // stock is taken and the cost booked like any other order.
        return posApi.compOrder(order.id, {
          amountCents: stored!.dueCents,
          reason: method === 'staff_meal' ? 'staff_meal' : compReason.trim(),
          shiftId,
          ...(method === 'staff_meal' && { staffMealFor: staffMealFor.trim() }),
          // Only a PIN the cashier can see on this tender is sent.
          ...(pinBoxShown && managerPin && { managerOverridePin: managerPin }),
        })
      }
      if (!shown || !tender) throw new Error('No bill from the server for this tender yet')
      const signature = `${order.id}|${tender}|${shown.dueCents}|${tipCents}`
      if (paySubmission.current?.signature !== signature) {
        paySubmission.current = { signature, key: newIdempotencyKey() }
      }
      return payOrder({
        orderId: order.id,
        shiftId,
        idempotencyKey: paySubmission.current.key,
        method: tender,
        // Exactly what the server says is due for this tender (plus the tip
        // the customer added, which the server books to tips payable).
        amountCents: shown.dueCents + tipCents,
        ...(tipCents > 0 && { tipCents }),
        ...(method === 'cash' && { tenderedCents }),
        // A card sale carries the terminal's reference (owner decision 4).
        ...(method === 'card' && { gatewayRef: gatewayRef.trim() }),
        // Keyed from the slip because the connected machine is offline (audited server-side).
        ...(method === 'card' && terminalOn && manualOpen && { manualReason: 'terminal_offline' as const }),
      })
    },
    onSuccess: (r) => {
      paySubmission.current = null
      const fiscal = r && typeof r === 'object' && 'fiscal' in r ? (r as { fiscal?: FiscalView | null }).fiscal : undefined
      setDone({ changeCents, fiscal, at: Date.now() })
      void qc.invalidateQueries({ queryKey: ['pos', 'open-tickets'] })
    },
    onError: async (e) => {
      // The bill moved on the server since it was shown (a line voided, a
      // portion paid elsewhere): reload the order and its bill, and make the
      // cashier look at the new figure before confirming again.
      if (order && e instanceof ApiError && (e.code === 'AMOUNT_MISMATCH' || e.code === 'ALREADY_PAID')) {
        await reloadBill()
      }
      // A card-machine charge is running on this bill (another till, a closed
      // modal): show it instead of taking a second tender.
      // A wrong comp PIN, or the wrong-PIN lock-out: clear the PIN box.
      if (e instanceof ApiError && (e.code === 'INVALID_MANAGER_PIN' || e.code === 'MANAGER_PIN_LOCKED')) setManagerPin('')
      if (order && e instanceof ApiError && e.code === 'TERMINAL_CHARGE_ACTIVE') {
        setMethod('card')
        setManualOpen(false)
        void active.refetch()
      }
      // A Raast QR request is waiting on this bill (another till, a closed
      // modal): show it instead of taking a second tender.
      if (order && e instanceof ApiError && e.code === 'RAAST_AWAITING') {
        setMethod('raast')
        void activeRaast.refetch()
      }
    },
  })

  /** The bill moved on the server: reload the order and its bill; the cashier looks again before confirming. */
  async function reloadBill() {
    if (!order) return
    setBillChanged(true)
    try { setOrder(await fetchOrder(order.id)) } catch { /* keep the old one; the bill refetch still runs */ }
    void qc.invalidateQueries({ queryKey: ['pos', 'bill', order.id] })
    void qc.invalidateQueries({ queryKey: ['pos', 'open-tickets'] })
  }

  function chargeRecorded(c: TerminalChargeView) {
    setDone({
      changeCents: 0,
      fiscal: c.fiscal,
      card: { brand: c.cardBrand, last4: c.cardLast4, approvalRef: c.approvalRef },
      at: Date.now(),
    })
    setChargeBlocking(false)
    void qc.invalidateQueries({ queryKey: ['pos', 'open-tickets'] })
  }

  function raastPaid(r: { fiscal?: FiscalView | null; raast: RaastDone }) {
    setDone({ changeCents: 0, fiscal: r.fiscal, raast: r.raast, at: Date.now() })
    void qc.invalidateQueries({ queryKey: ['pos', 'open-tickets'] })
  }

  // ── Printing ──────────────────────────────────────────────────────────────
  // Before payment: a PRE-BILL (never a tax invoice, never sent to the POS).
  // After payment: the FULL & FINAL bill with the fiscal block; every print
  // after the first is a DUPLICATE.
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const [preBillOffer, setPreBillOffer] = useState(false)
  const [printCount, setPrintCount] = useState(0)
  const printedWhilePending = useRef(false)

  function printFinalBill() {
    if (!order) return
    setReceiptError(null)
    setPreBillOffer(false)
    printedWhilePending.current = saleFiscal?.status === 'pending' && !isFiscalHeld(saleFiscal)
    const duplicate = printCount > 0
    printHtml(() => fetchReceiptHtml(order.id, useAuthStore.getState().token, { duplicate }))   // F43
      .then(() => setPrintCount((n) => n + 1))
      .catch((e: unknown) => {
        if (isPreBillRequired(e)) {
          setPreBillOffer(true)
          setReceiptError('This order isn’t fully paid yet — print a pre-bill instead.')
        } else {
          setReceiptError(tillErrorMessage(e, 'Could not load the bill'))
        }
      })
  }

  function preBill() {
    if (!order) return
    setPreBillMsg(null)
    setPreBillBusy(true)
    // Card and Raast QR are the one digital tax group: the pre-bill's card total.
    printPreBill(order.id, method === 'card' || method === 'raast' ? 'card' : 'cash', useAuthStore.getState().token)
      .then(() => setPreBillMsg({ ok: true, text: 'Pre-bill printed. It is not a tax invoice — the full & final bill prints after payment.' }))
      .catch((e: unknown) => setPreBillMsg({ ok: false, text: preBillErrorMessage(e) }))
      .finally(() => setPreBillBusy(false))
  }

  // The sale's fiscal document after payment: the payment's own answer, then
  // a 5 s poll for up to 60 s while it is pending ("Reprint when filed").
  const fiscalPoll = useQuery({
    queryKey: ['pos', 'order-fiscal', order?.id],
    queryFn: () => fetchOrderFiscal(order!.id),
    // A held document (company not live yet, spec §17.0) never files on its own — nothing to wait for.
    enabled: !!done && !!order && (done.fiscal === undefined || (done.fiscal?.status === 'pending' && !isFiscalHeld(done.fiscal))),
    refetchInterval: (q) => {
      const docs = q.state.data
      if (docs && docs.length === 0) return false
      const sale = docs?.find((d) => d.kind === 'sale')
      if (sale && (sale.status !== 'pending' || isFiscalHeld(sale))) return false
      return done && Date.now() - done.at < 60_000 ? 5000 : false
    },
    retry: false,
  })
  const saleFiscal: FiscalView | null = fiscalPoll.data?.find((d) => d.kind === 'sale') ?? done?.fiscal ?? null
  const fiscalNow = fiscalLine(saleFiscal)
  const filedSincePrint = printCount > 0 && printedWhilePending.current && !!saleFiscal && saleFiscal.status !== 'pending' && !isFiscalHeld(saleFiscal)

  // F-PAY02: JazzCash + Easypaisa tiles removed — no live adapter ships
  // for either, so showing them in the UI would let a cashier accept a
  // payment the server then rejects. Owner, 2026-10-12: the tills show
  // exactly Cash, Card – Keenu and Raast QR (+ Staff meal, Comp); Keenu QR
  // is retired. Text labels only — no emoji tiles.
  const METHODS: Array<{ id: PaymentMethod; label: string; hint: string }> = [
    { id: 'cash', label: 'Cash', hint: 'Cash rate' },
    { id: 'card', label: 'Card – Keenu', hint: 'Card machine' },
    { id: 'raast', label: 'Raast QR', hint: 'Bank transfer' },
    { id: 'staff_meal', label: 'Staff meal', hint: 'Manager' },
    { id: 'comp', label: 'Comp', hint: 'Reason' },
  ]

  function pickMethod(m: PaymentMethod) {
    // A card-machine charge or a waiting Raast request holds the order until
    // it settles or is resolved; until the resume answers are in, there may
    // be one we have not seen yet.
    if (holding || !resumeSettled) return
    setMethod(m)
    setBillChanged(false)
    setManualOpen(false)
    // A PIN typed under one tender is never sent, unseen, under another.
    setManagerPin('')
    pay.reset()
  }

  if (!shiftId) {
    return (
      <div className="erp-kitchen-dark fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4">
        <div className="w-full max-w-sm rounded-2xl bg-kds-card p-6 text-center space-y-4">
          <div className="text-4xl">⚠️</div>
          <h2 className="text-lg font-bold text-kds-text">No Shift Open</h2>
          <p className="text-sm text-kds-subtext">You need to open a shift before processing payments.</p>
          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 rounded-xl border border-kds-border py-3 text-kds-subtext">
              Cancel
            </button>
            <a href="/pos/shift" className="flex-1 rounded-xl bg-kds-green py-3 font-bold text-white text-center">
              Open Shift
            </a>
          </div>
        </div>
      </div>
    )
  }

  const methodPicker = (
    <div className="mb-4 grid grid-cols-3 gap-2">
      {METHODS.map((m) => (
        <button
          key={m.id}
          onClick={() => pickMethod(m.id)}
          disabled={(holding && method !== m.id) || !resumeSettled}
          aria-pressed={method === m.id}
          className={`rounded-lg border px-1 py-3 text-center text-sm font-semibold transition-colors disabled:opacity-30 ${
            method === m.id
              ? 'border-kds-green bg-kds-green/20 text-kds-green'
              : 'border-kds-border text-kds-subtext'
          }`}
        >
          <div className="leading-tight">{m.label}</div>
          <div className="mt-0.5 text-[10px] font-normal uppercase tracking-wider opacity-70">{m.hint}</div>
        </button>
      ))}
    </div>
  )

  // ── Offline: the ring-up was queued by the service worker ─────────────────
  if (queuedOffline) {
    return (
      <Shell title="Queued offline" onClose={onClose}>
        <p className="mb-4 text-sm text-kds-subtext">
          No connection. The order is queued and will reach the kitchen when the till is back online.
          Take payment from <strong className="text-kds-text">Open tickets</strong> once it appears there.
        </p>
        <button onClick={onClose} className="w-full rounded-xl bg-kds-green py-3 font-bold text-white">Done</button>
      </Shell>
    )
  }

  // ── Step 1: ring up the cart ──────────────────────────────────────────────
  if (!order) {
    const q = preview.data ?? null
    const itemCount = cart.reduce((n, i) => n + i.quantity, 0)
    return (
      <Shell title="Ring up" onClose={onClose}>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-kds-subtext">Customer pays by</p>
        {methodPicker}
        <div className="mb-4 space-y-1 rounded-xl border border-kds-border px-4 py-3 text-sm">
          <Row label={`${itemCount} item${itemCount !== 1 ? 's' : ''}`} value={fmtPkr(itemTotalCents())} />
          {discountCents > 0 && <Row label="Discount" value={`−${fmtPkr(discountCents)}`} tone="amber" />}
          {q ? (
            <>
              <Row label={`GST (${q.taxRatePct}%, ${q.tender === 'card' ? 'card / Raast' : q.tender})`} value={fmtPkr(q.taxCents)} />
              {q.serviceChargeCents > 0 && <Row label="Service charge" value={fmtPkr(q.serviceChargeCents)} />}
              <Row label="Total" value={fmtPkr(q.totalCents)} strong />
            </>
          ) : (
            preview.isError ? (
              <p className="pt-1 text-xs font-semibold text-kds-amber">
                {preview.error instanceof Error ? preview.error.message : 'The server could not price this order'}
              </p>
            ) : (
              <p className="pt-1 text-xs text-kds-subtext">
                {preview.isFetching
                  ? 'Getting the bill from the server…'
                  : 'GST for the tender and any service charge are added by the server. You will see the total before you take any money.'}
              </p>
            )
          )}
        </div>
        {ring.isError && (
          <p className="mb-3 text-sm text-kds-red">{managerPinLockedMessage(ring.error)
            ?? (ring.error instanceof ApiError && ring.error.code === 'INVALID_MANAGER_PIN' ? WRONG_PIN_MESSAGE
              : tillErrorMessage(ring.error, 'Could not ring up the order'))}</p>
        )}
        <button
          onClick={() => ring.mutate()}
          disabled={ring.isPending || cart.length === 0 || !brand}
          className="w-full rounded-xl bg-kds-green py-4 text-lg font-bold text-white disabled:opacity-30 active:scale-95"
        >
          {ring.isPending ? 'Ringing up…' : 'Ring up and send to kitchen'}
        </button>
      </Shell>
    )
  }

  // ── Step 2: take payment for the order ────────────────────────────────────
  const live = order.items.filter((i) => i.status !== 'voided')
  const title = order.table?.label ? `Table ${order.table.label}` : `Order ${orderRef(order.id)}`
  return (
    <Shell title={done ? 'Paid' : `${title} — ${shown ? fmtPkrWhole(due) : '…'}`} onClose={onClose}>
      {!done && (
        <>
          {/* What is being charged */}
          <div className="mb-3 max-h-28 overflow-y-auto text-xs text-kds-subtext">
            {live.map((i) => (
              <div key={i.id} className="flex justify-between gap-2">
                <span className="truncate">{i.quantity} × {i.name}</span>
              </div>
            ))}
          </div>

          {methodPicker}

          {/* The server's bill for this tender */}
          <div className="mb-4 space-y-1 rounded-xl border border-kds-border px-4 py-3 text-sm">
            {shown ? (
              <>
                {shown.discountCents > 0 && <Row label="Discount" value={`−${fmtPkr(shown.discountCents)}`} tone="amber" />}
                <Row label={`GST${shown.taxRatePct != null ? ` (${shown.taxRatePct}%)` : ''}`} value={fmtPkr(shown.taxCents)} />
                {shown.serviceChargeCents > 0 && <Row label="Service charge" value={fmtPkr(shown.serviceChargeCents)} />}
                <Row label="Bill total" value={fmtPkr(shown.totalCents)} />
                {shown.paidCents > 0 && <Row label="Already paid" value={`−${fmtPkr(shown.paidCents)}`} />}
                <Row label="Due now" value={fmtPkr(due)} strong />
              </>
            ) : unavailable ? (
              <p className="text-sm text-kds-amber">{unavailable}</p>
            ) : bill.isError ? (
              <p className="text-sm text-kds-red">
                {tillErrorMessage(bill.error, 'Could not get the bill from the server')}
              </p>
            ) : (
              <p className="text-sm text-kds-subtext">Getting the bill from the server…</p>
            )}
          </div>

          {billChanged && shown && (
            <p className="mb-3 text-sm font-semibold text-kds-amber">
              {due <= 0
                ? 'This bill has already been paid (at another till or as a split). Nothing more to take.'
                : `The bill changed on the server. It now reads ${fmtPkr(due)} due — check it and confirm again.`}
            </p>
          )}

          {((method === 'card' && !configSettled) || !resumeSettled) && (
            <p className="mb-4 text-sm text-kds-subtext">{!resumeSettled ? 'Checking for a card charge or Raast payment already on this bill…' : 'Checking the card machine…'}</p>
          )}
          {active.isError && (
            <p className="mb-4 text-xs font-semibold text-kds-amber" role="alert">
              Could not check whether a card charge is already running on this bill — look at the card machine before taking another tender.
            </p>
          )}
          {activeRaast.isError && (
            <p className="mb-4 text-xs font-semibold text-kds-amber" role="alert">
              Could not check whether a Raast QR payment is already waiting on this bill — check the counter phone before taking another tender.
            </p>
          )}

          {/* Terminal reference — a card / QR sale keyed on the machine by hand is settled against it */}
          {needsRef && (
            <div className="mb-4">
              {method === 'card' && terminalOn && (
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className={`text-xs font-semibold ${machineLooksDown ? 'text-kds-amber' : 'text-kds-subtext'}`}>
                    {machineLooksDown
                      ? 'Card machine offline — key the card on the machine, then enter its reference.'
                      : 'Card taken on another machine or keyed by hand — enter the reference from its slip.'}
                  </p>
                  <button type="button" onClick={() => setManualOpen(false)} className="shrink-0 text-xs font-semibold text-kds-green">
                    Use the card machine
                  </button>
                </div>
              )}
              <label className="mb-1 block text-sm text-kds-subtext">Terminal reference</label>
              <input
                type="text"
                value={gatewayRef}
                onChange={(e) => setGatewayRef(e.target.value)}
                placeholder="Reference printed by the card machine"
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 text-lg font-bold text-kds-green"
                autoFocus
              />
            </div>
          )}

          {/* Tip (card / QR) — only on an API that books tips */}
          {tipsAccepted && (
            <div className="mb-4">
              <label htmlFor="till-tip" className="mb-1 block text-sm text-kds-subtext">Tip (optional, PKR)</label>
              <input
                id="till-tip"
                type="number"
                inputMode="decimal"
                min={0}
                value={heldTip ? String(heldTip.tipCents / 100) : raastHeld ? String(raastHeld.tipCents / 100) : tip}
                onChange={(e) => setTip(e.target.value)}
                disabled={tipLocked}
                placeholder="0"
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 text-lg font-bold text-kds-text disabled:opacity-60"
              />
              {heldTip ? (
                <p className="mt-2 text-center text-sm font-semibold text-kds-amber">
                  The card machine is charging {fmtPkr(heldTip.amountCents)}
                  {heldTip.tipCents > 0 ? ` (${fmtPkr(heldTip.amountCents - heldTip.tipCents)} bill + ${fmtPkr(heldTip.tipCents)} tip)` : ''}
                  {' '}— the tip cannot change while it runs.
                </p>
              ) : raastHeld ? (
                <p className="mt-2 text-center text-sm font-semibold text-kds-amber">
                  The Raast request is for {fmtPkr(raastHeld.amountCents)}
                  {raastHeld.tipCents > 0 ? ` (${fmtPkr(raastHeld.amountCents - raastHeld.tipCents)} bill + ${fmtPkr(raastHeld.tipCents)} tip)` : ''}
                  {' '}— cancel it to change the tip.
                </p>
              ) : tipCents > 0 && method === 'raast' ? (
                <p className="mt-2 text-center text-sm font-semibold text-kds-amber">
                  The customer transfers {fmtPkr(chargeCents)} ({fmtPkr(due)} bill + {fmtPkr(tipCents)} tip)
                </p>
              ) : tipCents > 0 && (
                <p className="mt-2 text-center text-sm font-semibold text-kds-amber">
                  Charge the card {fmtPkr(chargeCents)} ({fmtPkr(due)} bill + {fmtPkr(tipCents)} tip)
                </p>
              )}
            </div>
          )}

          {/* Staff meal — who is eating; rung through as a comp */}
          {method === 'staff_meal' && (
            <div className="mb-4">
              <label className="mb-1 block text-sm text-kds-subtext">Staff member</label>
              <input
                type="text"
                value={staffMealFor}
                onChange={(e) => setStaffMealFor(e.target.value)}
                placeholder="Employee code"
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 text-lg font-bold text-kds-green"
                autoFocus
              />
              {pinBoxShown && (
                <>
                  <label className="mb-1 mt-3 block text-sm text-kds-subtext">Manager PIN (every staff meal needs a manager)</label>
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    value={managerPin}
                    onChange={(e) => setManagerPin(e.target.value)}
                    className="w-full rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text"
                  />
                </>
              )}
            </div>
          )}

          {/* Cash tendered input */}
          {method === 'cash' && shown && (
            <div className="mb-4">
              <div className="mb-1 flex items-baseline justify-between">
                <label className="block text-sm text-kds-subtext">Tendered amount (PKR)</label>
                <button
                  type="button"
                  onClick={() => setTendered((Math.ceil(due / 100)).toString())}
                  className="text-xs font-semibold text-kds-green"
                >
                  Exact
                </button>
              </div>
              <input
                type="number"
                inputMode="decimal"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                placeholder={`${Math.ceil(due / 100)}`}
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 text-xl font-bold text-kds-green"
                autoFocus
              />
              {tendered !== '' && tenderedCents < due && (
                <p className="mt-2 text-center text-sm font-semibold text-kds-red">
                  Less than the {fmtPkr(due)} due
                </p>
              )}
              {tenderedCents >= due && tenderedCents > 0 && (
                <p className="mt-2 text-center text-lg font-bold text-kds-amber">
                  Change: {fmtPkr(changeCents)}
                </p>
              )}
            </div>
          )}

          {/* Comp reason */}
          {method === 'comp' && (
            <div className="mb-4">
              <label className="mb-1 block text-sm text-kds-subtext">Reason (required)</label>
              <input
                type="text"
                value={compReason}
                onChange={(e) => setCompReason(e.target.value)}
                placeholder="Customer complaint, long wait…"
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text"
              />
              <label className="mb-1 mt-3 block text-sm text-kds-subtext">Manager PIN (needed above your comp limit)</label>
              <input
                type="password"
                inputMode="numeric"
                value={managerPin}
                onChange={(e) => setManagerPin(e.target.value)}
                className="w-full rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text"
              />
            </div>
          )}

          {pay.isError && !(pay.error instanceof ApiError && pay.error.code === 'AMOUNT_MISMATCH') && (
            <p className="mb-3 text-sm text-kds-red">
              {managerPinLockedMessage(pay.error)
                ?? (pay.error instanceof ApiError && pay.error.code === 'MANAGER_OVERRIDE_REQUIRED'
                ? compOverrideMessage(method)
                : pay.error instanceof ApiError && pay.error.code === 'INVALID_MANAGER_PIN'
                ? WRONG_PIN_MESSAGE
                : pay.error instanceof ApiError && pay.error.code === 'TERMINAL_CHARGE_ACTIVE'
                ? 'The card machine is still working on this bill — finish or resolve that charge first.'
                : tillErrorMessage(pay.error, 'Payment failed'))}
            </p>
          )}

          {!resumeSettled ? null : method === 'raast' ? (
            order && shiftId && shown && (due > 0 || raastHeld) ? (
              <RaastPanel
                orderId={order.id}
                conceptId={order.conceptId}
                brandName={brand?.name}
                shiftId={shiftId}
                dueCents={due}
                tipCents={tipCents}
                initialIntent={resumeRaast}
                onIntentChange={setRaastIntent}
                onPaid={raastPaid}
                onBillChanged={() => void reloadBill()}
              />
            ) : null
          ) : useTerminal ? (
            shown && due > 0 ? (
              <TerminalCharge
                orderId={order.id}
                shiftId={shiftId}
                config={terminal}
                dueCents={due}
                tipCents={tipCents}
                initialCharge={resumeCharge}
                onBlockingChange={setChargeBlocking}
                onChargeChange={setRunningCharge}
                onRecorded={chargeRecorded}
                onBillChanged={() => void reloadBill()}
                onMachineDown={() => setMachineDown(true)}
              />
            ) : null
          ) : (
            <button
              onClick={() => { setBillChanged(false); pay.mutate() }}
              disabled={
                pay.isPending ||
                !shown ||
                due <= 0 ||
                (method === 'card' && !configSettled) ||
                (method === 'cash' && tenderedCents < due) ||
                (method === 'comp' && !compReason.trim()) ||
                (needsRef && !gatewayRef.trim()) ||
                (method === 'staff_meal' && !staffMealFor.trim())
              }
              className="w-full rounded-xl bg-kds-green py-4 text-lg font-bold text-white disabled:opacity-30 active:scale-95"
            >
              {pay.isPending
                ? 'Processing…'
                : method === 'comp'
                ? 'Mark complimentary'
                : method === 'staff_meal'
                ? 'Ring as staff meal'
                : shown ? `Confirm — ${fmtPkrWhole(chargeCents)}` : 'Confirm'}
            </button>
          )}

          {/* The manual reference (spec §7.2): collapsed, highlighted when the machine looks down */}
          {resumeSettled && useTerminal && manualFallback && !chargeBlocking && (
            <button type="button" onClick={() => { setManualOpen(true); pay.reset() }}
              className={`mt-3 w-full text-center text-xs font-semibold underline ${machineLooksDown ? 'text-kds-amber' : 'text-kds-subtext'}`}>
              {machineLooksDown
                ? 'Card machine offline? Enter the machine reference'
                : 'Card machine not working? Enter the machine reference'}
            </button>
          )}

          {/* Pre-bill: the guest's bill before payment — never a tax invoice, never sent to the POS */}
          <button type="button" onClick={preBill} disabled={preBillBusy || holding}
            className="mt-3 w-full rounded-xl border border-kds-border py-2.5 text-sm font-semibold text-kds-text disabled:opacity-30">
            {preBillBusy ? 'Printing pre-bill…' : 'Print pre-bill'}
          </button>
          {preBillMsg && (
            <p className={`mt-2 text-xs ${preBillMsg.ok ? 'text-kds-subtext' : 'text-kds-red'}`} role={preBillMsg.ok ? 'status' : 'alert'}>
              {preBillMsg.text}
            </p>
          )}
          <p className="mt-2 text-center text-xs text-kds-subtext">
            {chargeBlocking
              ? 'The card machine is working on this bill — closing keeps the charge running; reopen the ticket to see it.'
              : raastBlocking
              ? 'This bill is waiting for a Raast transfer — closing keeps the request; reopen the ticket to see it.'
              : 'Closing leaves this order open and unpaid — it stays under Open tickets.'}
          </p>
        </>
      )}

      {done && (
        <div className="space-y-3">
          <div className="rounded-xl bg-kds-green/10 border border-kds-green/30 py-3 text-center" role="status">
            <p className="font-bold text-kds-green">{method === 'comp' || method === 'staff_meal' ? 'Comped' : 'Payment complete'}</p>
            {method === 'cash' && done.changeCents > 0 && (
              <p className="text-sm text-kds-amber mt-1">Change: {fmtPkr(done.changeCents)}</p>
            )}
            {done.card && (done.card.last4 || done.card.approvalRef) && (
              <p className="mt-1 text-xs text-kds-subtext">
                Card{done.card.brand ? ` ${done.card.brand}` : ''}{done.card.last4 ? ` •${done.card.last4}` : ''}
                {done.card.approvalRef ? ` · Ref ${done.card.approvalRef}` : ''}
              </p>
            )}
            {done.raast && (
              <p className="mt-1 px-3 text-xs text-kds-subtext">
                Raast QR — Ref <span className="font-mono font-bold text-kds-text">{done.raast.bankRef ?? '…'}</span>
                {done.raast.status === 'matched'
                  ? ' · matched to the bank statement'
                  : done.raast.smsConfirmed
                  ? ' · bank SMS seen (provisional until the bank statement)'
                  : ' (provisional until the bank statement)'}
              </p>
            )}
          </div>

          {/* The sale's fiscal number from the POS — or pending, filed automatically */}
          {fiscalNow && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-kds-border px-3 py-2">
              <p className={`text-sm font-semibold ${
                fiscalNow.tone === 'ok' ? 'text-kds-green' : fiscalNow.tone === 'muted' ? 'text-kds-subtext' : 'text-kds-amber'
              }`}>
                {fiscalNow.text}
              </p>
              {fiscalNow.test && (
                <span className="shrink-0 rounded border border-kds-amber px-1.5 py-0.5 text-[10px] font-bold uppercase text-kds-amber">Test</span>
              )}
            </div>
          )}
          {filedSincePrint && (
            <p className="text-xs font-semibold text-kds-green" role="status">
              The fiscal invoice is filed now — reprint the bill to give the guest the verification QR.
            </p>
          )}

          {receiptError && <p className="text-sm text-kds-red" role="alert">{receiptError}</p>}
          {preBillOffer && (
            <button type="button" onClick={preBill} disabled={preBillBusy}
              className="w-full rounded-xl border border-kds-amber py-2.5 text-sm font-bold text-kds-amber disabled:opacity-30">
              {preBillBusy ? 'Printing pre-bill…' : 'Print pre-bill'}
            </button>
          )}
          {preBillMsg && <p className={`text-xs ${preBillMsg.ok ? 'text-kds-subtext' : 'text-kds-red'}`}>{preBillMsg.text}</p>}
          <div className="grid grid-cols-2 gap-3">
            <button onClick={printFinalBill}
              className="rounded-xl border border-kds-border py-3 text-sm font-bold text-kds-text hover:bg-kds-border/30">
              {printCount === 0 ? 'Print final bill' : filedSincePrint ? 'Reprint with fiscal QR' : 'Reprint (duplicate)'}
            </button>
            <button onClick={onClose}
              className="rounded-xl bg-kds-green py-3 text-sm font-bold text-white">
              Done
            </button>
          </div>
        </div>
      )}
    </Shell>
  )
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="erp-kitchen-dark fixed inset-0 z-50 flex items-end justify-center bg-black/80 sm:items-center"
      role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[92dvh] w-full max-w-sm overflow-y-auto rounded-t-2xl bg-kds-card p-5 sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-kds-text">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-kds-subtext text-xl">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'amber' }) {
  return (
    <div className={`flex justify-between ${strong ? 'pt-1 text-base font-bold text-kds-text' : tone === 'amber' ? 'text-kds-amber' : 'text-kds-subtext'}`}>
      <span>{label}</span>
      <span className={strong ? 'text-kds-green' : undefined}>{value}</span>
    </div>
  )
}
