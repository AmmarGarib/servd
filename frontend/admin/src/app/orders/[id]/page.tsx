'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { api, paymentMethodLabel, RAAST_STATUS_LABEL, RAAST_STATUS_SHORT, type RaastReceiptState } from '../../../lib/api'
import { useAuthStore } from '../../../store/auth'
import { canOpenPath } from '../../../lib/moduleCatalog'
import { usePermissions } from '../../../hooks/useCan'
import { formatDistanceToNowStrict, format } from 'date-fns'
import Link from 'next/link'
import { fmtPkr, fmtPkrWhole } from '../../../lib/money'
import {
  cancelledCardRefundOffer, fetchReceiptHtml, fetchTerminalConfig, isPreBillRequired, preBillErrorMessage, printHtml, printPreBill,
  terminalChargesFor, tillErrorMessage,
  type TerminalChargeView,
} from '../../../components/pos/tillApi'
import { useIsManager } from '../../../components/pos/managerRole'
import { VoidLineDialog, type VoidLineResult } from '../../../components/pos/VoidLineDialog'
import { OrderFiscalPanel } from '../../../components/pos/OrderFiscalPanel'
import { OWN_DRAWER, cashDrawerChoices, parsePkrToCents } from '../../../components/pos/handBack'
import { useCanPrintBill } from '../../../components/pos/useCanPrintBill'
import { usePosStore } from '../../../store/pos'
import {
  RefundOptions, defaultRefundChoice, performRefund, refundChoiceReady, refundErrorMessage, refundOutcomeText, useRefundPolicy,
  type RefundChoice,
} from '../../refunds/RefundOptions'
import {
  approvalErrorMessage, cancelOrderWithApproval, keepFollowingTerminalRefund, raastRefundRefProblem, refundOnCardMachine, refundThroughEngine,
  terminalRefundFinal, terminalRefundText, uploadEvidencePhoto,
  type RefundResult, type RefundTender,
} from '../../refunds/refundEngine'
import { ApiError } from '../../../lib/api'
import { orderRef } from '../../../lib/orderRef'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrderDetail {
  id: string
  source: string
  status: string
  totalCents: number
  discountCents: number
  taxCents: number
  tipCents: number
  serviceChargeCents: number
  walletAmountCents: number
  loyaltyPointsEarned: number | null
  placedAt: string
  completedAt: string | null
  cancelledAt: string | null
  cancellationReason: string | null
  deliveryNotes: string | null
  curbsideVehicle: string | null
  curbsidePlate: string | null
  curbsideSpot: string | null
  curbsideArrivedAt: string | null
  concept: { name: string; slug: string }
  table: { label: string } | null
  customer: {
    id: string; name: string; phone: string | null; email: string | null
  } | null
  customerName: string | null
  rider: { id: string; name: string; phone: string } | null
  posStaff: { name: string } | null
  items: Array<{
    id: string
    name: string
    quantity: number
    unitPriceCents: number
    status: string
    course: number | null
    notes: string | null
    modifiers: Array<{ id: string; name: string; priceDeltaCents: number }>
    station: { name: string } | null
    menuItem: { imageUrl: string | null; nameUrdu: string | null } | null
  }>
  payments: Array<{
    id: string
    method: string
    amountCents: number
    status: string
    changeCents: number | null
    gateway?: string | null
    gatewayRef?: string | null
    shiftId?: string | null
    processedAt?: string | null
    createdAt?: string
    /** Raast QR: provisional until a bank-statement line matches it. */
    raastReceipt?: RaastReceiptState | null
  }>
  taxInvoices?: Array<{ id: string; invoiceNumber: string; type: 'invoice' | 'credit_note'; issuedAt: string }>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Orders that can still change: they print a PRE-BILL (never a tax invoice,
// never sent to the POS). Only a paid / completed order has a full & final
// bill (spec §17.1).
const NOT_FINAL = new Set(['received', 'confirmed', 'preparing', 'ready'])
const ENDED = new Set(['cancelled', 'rejected'])

// The numbered tax invoice / credit note, as issued (backend invoices/service).
async function openInvoice(invoiceId: string) {
  const token = useAuthStore.getState().token
  const res = await fetch(`${API_URL}/api/v1/invoices/${invoiceId}/html`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) { alert('Invoice not available'); return }
  const blob = new Blob([await res.text()], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank', 'width=720,height=900')
  if (!win) URL.revokeObjectURL(url)
}

const STATUS_COLORS: Record<string, string> = {
  received:  'bg-s-blue/20 text-s-blue',
  confirmed: 'bg-s-amber/20 text-s-amber',
  preparing: 'bg-s-amber/20 text-s-amber',
  ready:     'bg-primary/20 text-primary-ink',
  completed: 'bg-s-muted/20 text-s-muted',
  cancelled: 'bg-s-red/20 text-s-red',
  rejected:  'bg-s-red/30 text-s-red',
  refunded:  'bg-s-indigo/20 text-s-indigo',
}

const SOURCE_COLORS: Record<string, string> = {
  pos:       'bg-purple-100/40 text-purple-700',
  servd:     'bg-blue-100/40 text-s-blue',
  cart:      'bg-orange-100 text-orange-700',
  manual:    'bg-s-surface text-s-muted',
}

const ITEM_STATUS_COLORS: Record<string, string> = {
  pending:   'text-s-muted bg-s-bg',
  preparing: 'text-s-amber bg-s-amber/10',
  ready:     'text-primary-ink bg-primary/10',
  bumped:    'text-s-muted/60 bg-s-bg',
  held:      'text-s-blue bg-s-blue/10',
  recalled:  'text-s-amber bg-s-amber/10',
  voided:    'text-s-red bg-s-red/10',
}

const PAYMENT_COLORS: Record<string, string> = {
  cash:             'text-primary-ink bg-primary/10',
  card:             'text-s-blue bg-s-blue/10',
  // F-PAY02: jazzcash/easypaisa keys kept here only for historical rows that
  // existed before the enum drop — the map is a defensive lookup, dead values
  // are harmless. New rows land as cash / card / raast / split / comp;
  // keenu_qr is retired (old rows only, shown muted).
  jazzcash:         'text-orange-700 bg-orange-100',
  easypaisa:        'text-green-700 bg-green-100/20',
  raast:            'text-success bg-s-teal/15',
  keenu_qr:         'text-s-muted bg-s-surface',
  comp:             'text-s-muted bg-s-surface',
  wallet:           'text-s-amber bg-s-amber/10',
}

const STATUS_NEXT: Record<string, string> = {
  received: 'confirmed',
  confirmed: 'preparing',
  preparing: 'ready',
  ready: 'completed',
}
const STATUS_CTA: Record<string, string> = {
  received: 'Confirm',
  confirmed: 'Fire to Kitchen',
  preparing: 'Mark Ready',
  ready: 'Complete',
}

// ─── Money taken on a cancelled / rejected ticket (LEDGER-R5) ───────────────
//
// A ticket cancelled or rejected after the till took money still owes it back.
// The server's rule (backend accounting/orderPosting.ts refundDueCents, and
// pos/service.ts refundDueOf per tender): drawer receipts — a paid row, or a
// card / Keenu QR row the gateway referenced, on a shift, comps excluded —
// less the refunds already handed back. Shown here to offer the hand-back; the
// server re-checks it under the order lock (NOTHING_TO_REFUND /
// REFUND_EXCEEDS_DUE). Money an online gateway took is not in it — it never
// reached a drawer.
//
// A card the CARD MACHINE took can go back to the card on the machine (POST
// /pos/terminal/refunds, managers): the server checks it against the ticket's
// refund due before the machine moves money, then books it as the hand-back —
// never a sale refund, never a fiscal document. cancelledCardRefundOffer
// (tillApi) says whether to offer it and its most. A card taken by a manual
// slip is refunded by hand and only recorded here ("Card — record only").
//
// Raast QR money goes back by Raast: the manager sends it back from the bank
// first and records the outgoing transfer's reference (required); the server
// books it against the bank account that received it (never 1030).

const HAND_BACK_TENDERS: readonly RefundTender[] = ['cash', 'card', 'raast', 'keenu_qr']
const HAND_BACK_LABEL: Record<RefundTender, string> = { cash: 'Cash', card: 'Card – Keenu', raast: 'Raast QR', keenu_qr: 'Keenu QR (retired)' }

type OrderPayment = OrderDetail['payments'][number]

function isDrawerReceipt(p: OrderPayment): boolean {
  if (p.amountCents <= 0 || !p.shiftId || p.method === 'comp') return false
  return p.status === 'paid' || (p.status === 'pending' && (p.method === 'card' || p.method === 'keenu_qr') && !!p.gatewayRef)
}

function moneyTakenOf(order: OrderDetail): { dueCents: number; byTender: Array<{ method: RefundTender; leftCents: number }>; latest: RefundTender | null } {
  if (!ENDED.has(order.status)) return { dueCents: 0, byTender: [], latest: null }
  const receipts = order.payments.filter(isDrawerReceipt)
  const refunds = order.payments.filter((p) => p.status === 'refunded' && p.amountCents < 0)
  const taken = receipts.reduce((t, p) => t + p.amountCents, 0)
  const handedBack = refunds.reduce((t, p) => t + Math.abs(p.amountCents), 0)
  const left = new Map<string, number>()
  for (const p of receipts) left.set(p.method, (left.get(p.method) ?? 0) + p.amountCents)
  for (const r of refunds) left.set(r.method, (left.get(r.method) ?? 0) - Math.abs(r.amountCents))
  const byTender = HAND_BACK_TENDERS
    .map((method) => ({ method, leftCents: Math.max(0, left.get(method) ?? 0) }))
    .filter((t) => t.leftCents > 0)
  const latest = [...receipts]
    .filter((p) => (HAND_BACK_TENDERS as readonly string[]).includes(p.method))
    .sort((a, b) => +new Date(b.processedAt ?? b.createdAt ?? 0) - +new Date(a.processedAt ?? a.createdAt ?? 0))[0]
  return { dueCents: Math.max(0, taken - handedBack), byTender, latest: (latest?.method as RefundTender | undefined) ?? null }
}

function handBackErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'NOTHING_TO_REFUND': return 'Nothing taken at the till is still owed back on this ticket — it may already have been handed back. Reload the order.'
      case 'REFUND_EXCEEDS_DUE': return 'That is more than is still owed back on this ticket — reload the order and refund what it shows.'
      case 'REFUND_METHOD_NOT_TENDERED': return e.message || 'Hand the money back the way it was taken.'
      case 'REFUND_EXCEEDS_TENDER': return 'That is more than was taken by this tender — refund the rest on the other tender.'
      case 'OPEN_DRAWER_REQUIRED': return 'Cash comes out of an open drawer — pick the open drawer the cash leaves from (or open your shift at the till), then refund.'
      case 'SHIFT_CLOSED': return 'That drawer has been closed — pick another open drawer for the cash to leave from.'
      case 'SHIFT_NOT_IN_COMPANY': return 'That drawer is not an open drawer of this order’s company — pick another one.'
      case 'NOT_YOUR_SHIFT': return 'That is another cashier’s drawer — only a manager can pay cash out of it. Pick your own drawer.'
      // The card-machine refund's one answer for "more than is left" (its message is in paisa — never shown).
      case 'AMOUNT_EXCEEDS_REFUNDABLE': {
        const left = (e.details as { refundableCents?: unknown } | null | undefined)?.refundableCents
        return typeof left === 'number'
          ? `Only ${fmtPkr(Math.max(0, left))} of this card payment can still go back to the card — some of it is already refunded or on its way back. Refund that much, or reload the order.`
          : 'That is more than can still go back to the card on this ticket — some of it may already be refunded or on its way back to the card. Reload the order and refund what it shows.'
      }
    }
  }
  return refundErrorMessage(e)
}

function MoneyTakenModal({
  order,
  onClose,
  onDone,
}: { order: OrderDetail; onClose: () => void; onDone: (message: string) => void }) {
  const qc = useQueryClient()
  const taken = moneyTakenOf(order)
  const policy = useRefundPolicy()
  const needsPhoto = !!policy.data?.requirePhotoEvidence
  const [method, setMethod] = useState<RefundTender | ''>(() =>
    taken.byTender.length === 1 ? taken.byTender[0]!.method
      : taken.byTender.find((t) => t.method === taken.latest)?.method ?? taken.byTender[0]?.method ?? '')
  const leftOnMethod = taken.byTender.find((t) => t.method === method)?.leftCents ?? 0

  // ── Card: back to the card on the card machine, or record a refund done by hand.
  // Only a card the machine took (gateway card_terminal) can go back through
  // it, and only while a card machine is connected — at the till's drawer or
  // the drawer that took the card. The offer is recomputed from the order as
  // it is now, so a hand-back booked meanwhile lowers it at once.
  const tillShiftId = usePosStore.getState().shiftId
  const machineReceipt = order.payments.find((p) => isDrawerReceipt(p) && p.method === 'card' && p.gateway === 'card_terminal' && p.status === 'paid')
  const terminalShifts = [...new Set([tillShiftId, machineReceipt?.shiftId].filter((s): s is string => !!s))]
  const machine = useQuery({
    queryKey: ['order-card-machine', order.id, ...terminalShifts],
    queryFn: async () => {
      const [charges, configs] = await Promise.all([
        terminalChargesFor(order.id),
        Promise.all(terminalShifts.map(async (shiftId) => ({ shiftId, config: await fetchTerminalConfig(shiftId).catch(() => null) }))),
      ])
      // The first drawer whose outlet has a usable card machine (the refund's fallback machine).
      const on = configs.find((c) => c.config?.enabled)
      return { charges, shiftId: on?.shiftId ?? null }
    },
    enabled: method === 'card' && !!machineReceipt && terminalShifts.length > 0,
    retry: false,
  })
  const offer = method === 'card' && machine.data
    ? cancelledCardRefundOffer({ status: order.status, payments: order.payments, charges: machine.data.charges, terminalEnabled: machine.data.shiftId !== null })
    : null
  // null = not picked yet: the card machine when it is offered, else record only.
  const [cardVia, setCardVia] = useState<'machine' | 'record' | null>(null)
  const viaMachine = method === 'card' && !!offer && cardVia !== 'record'
  // The machine refund being followed: its state as the machine reports it, and
  // one still not answered after ~2 minutes (Refund then keeps following the
  // SAME refund — never a second one).
  const [progress, setProgress] = useState<TerminalChargeView | null>(null)
  const [following, setFollowing] = useState<{ charge: TerminalChargeView; paymentId: string } | null>(null)
  // The machine gave the money back but servd could not book it: no further
  // refund from this dialog (a manager has been alerted to book it).
  const [machineStuck, setMachineStuck] = useState(false)

  const maxCents = viaMachine && offer
    ? Math.min(offer.maxCents, taken.dueCents, leftOnMethod)
    : Math.min(taken.dueCents, leftOnMethod)
  // null = untouched: the most allowed for the way picked (follows it when the way changes).
  const [amountInput, setAmountInput] = useState<string | null>(null)
  const amount = amountInput ?? (maxCents / 100).toFixed(2)
  const [reason, setReason] = useState('')
  // Raast: the reference of the transfer the manager already sent back from the bank.
  const [raastRef, setRaastRef] = useState('')
  const raastRefIssue = method === 'raast' ? raastRefundRefProblem(raastRef) : null
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)
  // Cash leaves an OPEN drawer of the order's company. A back-office manager
  // usually has none of their own, so the dialog names one (I3-RV-1): this
  // till's drawer, else the drawer that took the cash. Drawers the server
  // reports closed are marked and skipped.
  const [closedDrawers, setClosedDrawers] = useState<Set<string>>(() => new Set())
  const drawers = cashDrawerChoices({
    tillShiftId: usePosStore.getState().shiftId,
    receipts: order.payments.filter(isDrawerReceipt),
    closed: closedDrawers,
  })
  const [drawerPick, setDrawerPick] = useState<string>(drawers.defaultValue)
  const drawerChoice = drawers.choices.find((c) => c.value === drawerPick)
  const shiftId = drawerChoice && !drawerChoice.closed ? drawerChoice.value : drawers.defaultValue

  // "1,500" is PKR 1,500 — never PKR 1 — and "1500abc" is not an amount (I3-RV-2).
  const amountCents = parsePkrToCents(amount)
  const amountOk = Number.isSafeInteger(amountCents) && amountCents > 0 && amountCents <= maxCents

  async function pickPhoto(file: File | undefined) {
    if (!file) return
    setPhotoError(null)
    setUploading(true)
    try { setPhotoUrl(await uploadEvidencePhoto(file)) } catch (e) {
      setPhotoError(e instanceof Error ? e.message : 'The photo upload failed')
    } finally { setUploading(false) }
  }

  const handBack = useMutation({
    mutationFn: () => refundThroughEngine(order.id, {
      amountCents,
      reason: reason.trim(),
      method: method as RefundTender,
      ...(method === 'cash' && shiftId !== OWN_DRAWER && { shiftId }),
      ...(photoUrl && { photoUrl }),
      ...(method === 'raast' && { gatewayRef: raastRef.trim() }),
    }) as Promise<RefundResult & { refundDueLeftCents?: number }>,
    onSuccess: (r) => {
      const how = HAND_BACK_LABEL[method as RefundTender] ?? method
      const left = r.refundDueLeftCents ?? Math.max(0, taken.dueCents - amountCents)
      onDone(`Refunded ${fmtPkr(amountCents)} by ${method === 'raast' ? `Raast QR (ref ${raastRef.trim().toUpperCase()})` : how.toLowerCase()} and booked. ${left > 0 ? `${fmtPkr(left)} is still owed back on this ticket.` : 'Nothing more is owed back on this ticket.'}`)
      onClose()
    },
    onError: (e) => {
      // The drawer named has closed since: mark it and move to the next one.
      if (e instanceof ApiError && e.code === 'SHIFT_CLOSED' && method === 'cash' && shiftId !== OWN_DRAWER) {
        const next = new Set(closedDrawers).add(shiftId)
        setClosedDrawers(next)
        setDrawerPick(cashDrawerChoices({ tillShiftId: usePosStore.getState().shiftId, receipts: order.payments.filter(isDrawerReceipt), closed: next }).defaultValue)
      }
    },
  })

  // Back to the card on the card machine (managers; the server checks the
  // refund due, the policy and the cap BEFORE the machine moves money, and
  // books it as the hand-back once the machine approves).
  const cardRefund = useMutation({
    mutationFn: async (): Promise<{ charge: TerminalChargeView; paymentId: string }> => {
      if (following) {
        return { charge: await keepFollowingTerminalRefund(following.charge, following.paymentId, setProgress), paymentId: following.paymentId }
      }
      if (!offer) throw new Error('No card machine is connected for this card payment — refund it by hand and record it as a card refund.')
      const paid = order.payments.find((p) => p.id === offer.paymentId)
      const charge = await refundOnCardMachine(order.id, {
        payment: { id: offer.paymentId, method: 'card', amountCents: paid?.amountCents ?? amountCents, status: 'paid', gateway: 'card_terminal' },
        amountCents,
        reason: reason.trim(),
        ...(photoUrl && { photoUrl }),
        shiftId: machine.data?.shiftId ?? null,
      }, setProgress)
      return { charge, paymentId: offer.paymentId }
    },
    onSuccess: ({ charge, paymentId }) => {
      setProgress(charge)
      if (!terminalRefundFinal(charge)) { setFollowing({ charge, paymentId }); return }
      setFollowing(null)
      if (charge.status === 'needs_attention') setMachineStuck(true)
      if (charge.status !== 'recorded') return // declined / not completed / needs attention: the progress line says why
      const left = Math.max(0, taken.dueCents - charge.amountCents)
      onDone(`Refunded ${fmtPkr(charge.amountCents)} to the card on ${charge.terminalLabel} and booked — nothing goes to the fiscal POS, the ticket was never a sale. ${left > 0 ? `${fmtPkr(left)} is still owed back on this ticket.` : 'Nothing more is owed back on this ticket.'}`)
      onClose()
    },
    onSettled: () => {
      // Whatever the machine answered, the order (its hand-backs) and its card refunds have moved.
      void qc.invalidateQueries({ queryKey: ['order-detail', order.id] })
      void qc.invalidateQueries({ queryKey: ['order-card-machine', order.id] })
    },
  })
  const machineState = progress ? terminalRefundText(progress) : null

  /** A new way to hand it back: the amount follows the new most; an old machine answer is cleared. */
  function changeWay(next: { method?: RefundTender; cardVia?: 'machine' | 'record' }) {
    if (next.method) setMethod(next.method)
    if (next.cardVia) setCardVia(next.cardVia)
    setAmountInput(null)
    if (!following && !machineStuck) { setProgress(null); cardRefund.reset() }
    handBack.reset()
  }

  return (
    <div className="fixed inset-0 bg-secondary/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-label="Refund money taken">
      <div className="bg-s-surface border border-s-border rounded-2xl p-6 max-w-sm w-full space-y-4">
        <div>
          <p className="font-bold text-s-text text-lg">Refund money taken</p>
          <p className="text-xs text-s-muted mt-1">
            This ticket was {order.status} after the till took {fmtPkr(taken.dueCents)}. It was never a sale: the refund is booked
            against the money held for it, and nothing goes to the fiscal POS.
          </p>
        </div>

        {taken.byTender.length > 1 && (
          <div>
            <label htmlFor="due-method" className="text-xs text-s-muted block mb-1">Hand it back by</label>
            <select id="due-method" value={method} disabled={!!following || cardRefund.isPending}
              onChange={(e) => changeWay({ method: e.target.value as RefundTender })}
              className="w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none disabled:opacity-60">
              {taken.byTender.map((t) => (
                <option key={t.method} value={t.method}>{HAND_BACK_LABEL[t.method]} — {fmtPkr(Math.min(t.leftCents, taken.dueCents))} taken</option>
              ))}
            </select>
          </div>
        )}
        {taken.byTender.length === 1 && (
          <p className="text-sm text-s-text">Hand it back by <strong>{HAND_BACK_LABEL[taken.byTender[0]!.method].toLowerCase()}</strong>, the way it was taken.</p>
        )}
        {method === 'cash' && (
          <div>
            <label htmlFor="due-drawer" className="text-xs text-s-muted block mb-1">The cash leaves from</label>
            <select id="due-drawer" value={shiftId} onChange={(e) => setDrawerPick(e.target.value)}
              className="w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none">
              {drawers.choices.map((c) => (
                <option key={c.value || 'own'} value={c.value} disabled={c.closed}>
                  {c.label}{c.closed ? ' — closed' : ''}
                </option>
              ))}
            </select>
            <p className="text-xs text-s-muted mt-1">
              {shiftId === OWN_DRAWER
                ? 'The drawer you have open at the till pays it out.'
                : 'Hand the cash over from this drawer — its close will count it out.'}
            </p>
          </div>
        )}
        {method === 'card' && offer && (
          <fieldset className="space-y-1.5" disabled={!!following || cardRefund.isPending}>
            <legend className="text-xs text-s-muted mb-1">How the card money goes back</legend>
            <label className="flex items-start gap-2 text-sm text-s-text">
              <input type="radio" name="due-card-via" className="mt-1" checked={viaMachine}
                onChange={() => changeWay({ cardVia: 'machine' })} />
              <span>Refund to card (card machine) <span className="text-s-muted">— up to {fmtPkr(Math.min(offer.maxCents, taken.dueCents))}</span></span>
            </label>
            <label className="flex items-start gap-2 text-sm text-s-text">
              <input type="radio" name="due-card-via" className="mt-1" checked={!viaMachine}
                onChange={() => changeWay({ cardVia: 'record' })} />
              <span>Card — record only <span className="text-s-muted">(refunded by hand)</span></span>
            </label>
          </fieldset>
        )}
        {method === 'card' && viaMachine && (
          <p className="text-xs text-s-muted">
            The guest taps or inserts the card on the card machine; servd books the refund once the machine approves it.
          </p>
        )}
        {method === 'card' && !viaMachine && !following && !machineStuck && (
          <p className="text-xs text-s-muted">
            {offer
              ? 'For a card taken with a manual slip (or refunded on the machine outside servd): refund it on the card machine or the bank’s portal by hand first — servd only records the refund here.'
              : machine.isFetching
                ? 'Checking for a card machine…'
                : 'Refund the card on the card machine (or the bank’s portal) by hand first — servd records the refund here.'}
          </p>
        )}
        {method === 'keenu_qr' && <p className="text-xs text-s-muted">Keenu QR is retired — this older payment goes back through Keenu: send it there first, servd records the refund here.</p>}
        {method === 'raast' && (
          <div className="space-y-1.5 rounded-lg border border-s-amber/40 bg-s-amber-dim p-2.5">
            <p className="text-xs text-s-text">
              Send the money back to the guest from the company&rsquo;s bank (internet banking or the merchant app) first, then type that
              outgoing transfer&rsquo;s reference. servd books it against the bank account that received the Raast payment.
            </p>
            <label htmlFor="due-raast-ref" className="text-xs text-s-muted block">Outgoing transfer reference (required)</label>
            <input id="due-raast-ref" value={raastRef} onChange={(e) => setRaastRef(e.target.value)} autoComplete="off" spellCheck={false}
              placeholder="e.g. the transaction ID from the bank"
              className="w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text font-mono uppercase focus:border-primary focus:outline-none" />
            {raastRef.trim() !== '' && raastRefIssue && <p className="text-xs text-s-red">{raastRefIssue}</p>}
          </div>
        )}

        <div>
          <label htmlFor="due-amount" className="text-xs text-s-muted block mb-1">Amount (PKR) — up to {fmtPkr(maxCents)}</label>
          <input id="due-amount" inputMode="decimal" value={amount} onChange={(e) => setAmountInput(e.target.value)}
            disabled={!!following || cardRefund.isPending}
            className="w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text font-mono focus:border-primary focus:outline-none disabled:opacity-60" />
          {!following && amount.trim() !== '' && !amountOk && (
            <p className="text-xs text-s-amber mt-1">Enter an amount between PKR 0.01 and {fmtPkr(maxCents)}.</p>
          )}
        </div>

        {needsPhoto && (
          <div className="space-y-1">
            <label htmlFor="due-photo" className="text-xs text-s-muted block">Photo evidence (required by the refund policy)</label>
            <input id="due-photo" type="file" accept="image/*" capture="environment"
              onChange={(e) => void pickPhoto(e.target.files?.[0])} className="block w-full text-xs text-s-text" />
            {uploading && <p className="text-xs text-s-muted">Uploading…</p>}
            {photoUrl && !uploading && <p className="text-xs text-primary-ink">Photo attached.</p>}
            {photoError && <p className="text-xs text-s-red">{photoError}</p>}
          </div>
        )}

        <div>
          <label htmlFor="due-reason" className="text-xs text-s-muted block mb-1">Reason (required)</label>
          <textarea id="due-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={200}
            disabled={!!following || cardRefund.isPending}
            placeholder="e.g. Order cancelled — guest left before it was served"
            className="w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none resize-none disabled:opacity-60" />
        </div>

        {machineState && (
          <p className={`text-sm ${machineState.ok ? 'text-s-muted' : 'text-s-red'}`} role="status">{machineState.text}</p>
        )}
        {handBack.isError && <p className="text-sm text-s-red" role="alert">{handBackErrorMessage(handBack.error)}</p>}
        {cardRefund.isError && <p className="text-sm text-s-red" role="alert">{handBackErrorMessage(cardRefund.error)}</p>}

        <div className="flex gap-3">
          <button
            onClick={() => (viaMachine || following ? cardRefund.mutate() : handBack.mutate())}
            disabled={handBack.isPending || cardRefund.isPending || (!following && (
              !method || !amountOk || reason.trim().length < 3 || uploading || (needsPhoto && !photoUrl) || machineStuck || !!raastRefIssue
            ))}
            className="flex-1 rounded-xl bg-s-red text-bone text-sm font-bold py-2 hover:opacity-90 disabled:opacity-40">
            {cardRefund.isPending ? 'On the card machine…'
              : following ? 'Keep following the refund'
              : handBack.isPending ? 'Refunding…'
              : `Refund ${amountOk ? fmtPkr(amountCents) : ''}${viaMachine ? ' to card' : ''}`.replace(/\s+/g, ' ').trim()}
          </button>
          <button onClick={onClose} className="flex-1 rounded-xl border border-s-border text-s-muted text-sm py-2 hover:border-s-text">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Raast QR state per payment ──────────────────────────────────────────────
// A Raast payment completes the sale at the till; the bank statement is the
// truth. 'Provisional' until finance (or the statement import) matches it.

const RAAST_CHIP: Record<string, string> = {
  provisional:     'text-s-amber bg-s-amber/10',
  matched:         'text-success bg-s-teal/15',
  needs_attention: 'text-s-red bg-s-red/10',
  unreceived:      'text-s-red bg-s-red/10',
  awaiting:        'text-s-muted bg-s-bg',
  cancelled:       'text-s-muted bg-s-bg',
}

function RaastPaymentNote({ payment }: { payment: OrderPayment }) {
  const r = payment.raastReceipt
  // A refund row carries the OUTGOING transfer's reference; a sale row its receipt.
  if (!r) {
    return payment.gatewayRef
      ? <p className="text-[10px] text-s-muted mt-1 font-mono">Ref {payment.gatewayRef}</p>
      : null
  }
  const via = r.confirmedVia === 'sms' ? 'bank SMS' : r.confirmedVia === 'bank_api' ? 'bank' : 'cashier'
  return (
    <div className="mt-1 space-y-0.5">
      <span title={RAAST_STATUS_LABEL[r.status]} className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${RAAST_CHIP[r.status] ?? 'text-s-muted bg-s-bg'}`}>
        {RAAST_STATUS_SHORT[r.status] ?? r.status}
      </span>
      <p className="text-[10px] text-s-muted">
        {r.bankRef && <span className="font-mono">Ref {r.bankRef}</span>}
        {r.bankRef && ' · '}
        confirmed by {via}{r.smsConfirmedAt && r.confirmedVia !== 'sms' ? ', bank SMS seen' : ''}
        {r.matchedAt && <> · on the statement {format(new Date(r.matchedAt), 'dd MMM')}</>}
      </p>
    </div>
  )
}

// ─── Refund modal ─────────────────────────────────────────────────────────────

/** A cancel refusal in plain words (R2-UI-06): the order moved on (sold,
 *  already cancelled) since the page loaded, so the state machine's raw
 *  "Cannot move order … from completed → cancelled" is never shown. */
function cancelErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.code === 'INVALID_TRANSITION') {
    return /completed/.test(e.message ?? '')
      ? 'This order has already been sold, so it cannot be cancelled. Refund it instead.'
      : 'This order can no longer be cancelled — it has moved on since you opened it. Reload the page to see where it is.'
  }
  return approvalErrorMessage(e, 'cancel')
}

function RefundModal({
  order,
  onClose,
  onDone,
}: { order: OrderDetail; onClose: () => void; onDone: (message: string) => void }) {
  const [reason, setReason] = useState('')
  // A sold order is refunded; one not sold yet is cancelled (a manager approves).
  const [mode, setMode] = useState<'refund' | 'cancel'>(order.status === 'completed' ? 'refund' : 'cancel')
  const [choice, setChoice] = useState<RefundChoice>(() => defaultRefundChoice(order.payments, order.source))
  const [pin, setPin] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  const isManager = useIsManager()
  const policy = useRefundPolicy()

  const refund = useMutation({
    // Refund in full through the ONE refund engine (caps, manager PIN prompt
    // above your limit, cash out of your open drawer) — or back to the card on
    // the card machine; part refunds are on /refunds.
    mutationFn: async () => {
      if (mode === 'cancel') {
        await cancelOrderWithApproval(order.id, reason.trim(), isManager ? undefined : pin.trim())
        return 'Order cancelled — nothing was sent to the fiscal POS; any pre-bill is listed under Finance → Voided pre bills.'
      }
      const outcome = await performRefund(order.id, order.payments, { amountCents: order.totalCents, reason: reason.trim(), choice }, (c) => {
        setProgress(terminalRefundText(c).text)
      })
      // Not answered yet: still in flight — the modal stays open; Refund again follows the SAME refund (never a second).
      if (outcome.kind === 'machine' && !terminalRefundFinal(outcome.charge)) {
        throw new Error(`The refund of ${fmtPkr(outcome.charge.amountCents)} is still in flight on ${outcome.charge.terminalLabel} — do not refund again. Tap Refund to keep following it.`)
      }
      const t = refundOutcomeText(outcome)
      if (!t.ok) throw new Error(t.text)
      return t.text
    },
    onSuccess: (msg) => { onDone(msg); onClose() },
  })

  const ready = mode === 'cancel'
    ? isManager || pin.trim().length > 0
    : order.status === 'completed' && refundChoiceReady(order.payments, choice, !!policy.data?.requirePhotoEvidence, order.source)

  return (
    <div className="fixed inset-0 bg-secondary/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-label="Refund or cancel order">
      <div className="bg-s-surface border border-s-border rounded-2xl p-6 max-w-sm w-full space-y-4">
        <p className="font-bold text-s-text text-lg">Refund / Cancel Order</p>
        <div className="flex gap-2">
          {/* R2-UI-06: a completed sale is refunded, never cancelled — the
              state machine refuses completed → cancelled, so the option is
              not offered. */}
          {(order.status === 'completed' ? (['refund'] as const) : (['refund', 'cancel'] as const)).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                mode === m
                  ? 'bg-primary text-primary-on border-primary'
                  : 'border-s-border text-s-muted hover:text-s-text'
              }`}>
              {m === 'refund' ? 'Refund' : 'Cancel (no refund)'}
            </button>
          ))}
        </div>
        {mode === 'refund' && order.status !== 'completed' && (
          <p className="text-xs text-s-amber">This order has not been sold yet — cancel it instead.</p>
        )}
        {mode === 'refund' && order.status === 'completed' && (
          <div className="space-y-2">
            <p className="text-xs text-s-muted">Refunds the whole bill ({fmtPkr(order.totalCents)}). Part refunds are on Refunds.</p>
            <RefundOptions payments={order.payments} source={order.source} amountCents={order.totalCents} value={choice} onChange={setChoice} idPrefix="order-refund" />
          </div>
        )}
        {mode === 'cancel' && !isManager && (
          <div>
            <label htmlFor="cancel-pin" className="text-xs text-s-muted block mb-1">Manager PIN (a manager approves every cancel)</label>
            <input id="cancel-pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)}
              className="w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none" />
          </div>
        )}
        <div>
          <label htmlFor="refund-reason" className="text-xs text-s-muted block mb-1">Reason (required)</label>
          <textarea
            id="refund-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Explain the reason for this refund/cancellation…"
            className="w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none resize-none"
          />
        </div>
        {refund.isPending && progress && <p className="text-sm text-s-muted" role="status">{progress}</p>}
        {refund.isError && (
          <p className="text-sm text-s-red" role="alert">
            {mode === 'cancel' ? cancelErrorMessage(refund.error) : refundErrorMessage(refund.error)}
          </p>
        )}
        <div className="flex gap-3">
          <button
            onClick={() => refund.mutate()}
            disabled={refund.isPending || reason.trim().length < 3 || !ready}
            className="flex-1 rounded-xl bg-s-red text-bone text-sm font-bold py-2 hover:opacity-90 disabled:opacity-40">
            {refund.isPending ? 'Processing…' : mode === 'refund' ? 'Refund' : 'Cancel order'}
          </button>
          <button onClick={onClose} className="flex-1 rounded-xl border border-s-border text-s-muted text-sm py-2 hover:border-s-text">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()

  const [refundOpen, setRefundOpen] = useState(false)
  const [handBackOpen, setHandBackOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  // Voids: every void needs a manager (spec §17.4) — the dialog asks for a
  // PIN unless the signed-in user is one.
  const isManager = useIsManager()
  // The customer's name links to their CRM profile only for a login that can
  // open /crm (cashier, foh, finance and the kitchen roles cannot).
  const { data: me } = usePermissions()
  const canOpenCrm = !!me && canOpenPath('/crm', me.role, me.modules ?? [])
  // Bills and pre-bills print through the till's routes (CASHIERS only):
  // expediter and finance read orders here but would only get a 403.
  const canPrint = useCanPrintBill()
  const [voidTarget, setVoidTarget] = useState<{ id: string; name: string; quantity: number; lineCents: number } | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string; splitLink?: boolean } | null>(null)
  const [printNote, setPrintNote] = useState<{ text: string; offerPreBill: boolean } | null>(null)
  const [printCount, setPrintCount] = useState(0)

  const { data: order, isLoading, isError } = useQuery<OrderDetail>({
    queryKey: ['order-detail', id],
    queryFn: () => api.get<OrderDetail>(`/orders/${id}`),
  })

  const updateStatus = useMutation({
    mutationFn: (status: string) => api.patch(`/orders/${id}/status`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['order-detail', id] }),
  })

  // A line voided through the POS void — the only void path (caps at
  // /configuration/refund-policy, reason, manager approval, audited). The
  // answer carries the bill it leaves: shown at once, then re-read.
  function lineVoided(r: VoidLineResult) {
    setVoidTarget(null)
    qc.setQueryData<OrderDetail>(['order-detail', id], (old) => old && {
      ...old,
      totalCents: r.order.totalCents,
      taxCents: r.order.taxCents,
      serviceChargeCents: r.order.serviceChargeCents,
      discountCents: r.order.discountCents,
      items: old.items.map((i) => (i.id === r.id ? { ...i, status: 'voided' } : i)),
    })
    void qc.invalidateQueries({ queryKey: ['order-detail', id] })
    const parts = [`Voided — ${fmtPkr(r.removedCents)} off the bill. New total ${fmtPkr(r.order.totalCents)}.`]
    if (r.refund) parts.push(`${fmtPkr(r.refund.amountCents)} refunded by ${paymentMethodLabel(r.refund.method)}.`)
    if (r.splitCleared) parts.push('The split was cleared because the bill changed. Re-split it.')
    setNotice({ tone: r.splitCleared ? 'warn' : 'ok', text: parts.join(' '), splitLink: r.splitCleared })
  }

  // Printing: an order still open prints a PRE-BILL; a paid one its full &
  // final bill (the server refuses a final bill for an open order with 409
  // PRE_BILL_REQUIRED). Every final-bill print after the first is a DUPLICATE.
  function printFinalBill(orderId: string) {
    setPrintNote(null)
    printHtml(() => fetchReceiptHtml(orderId, useAuthStore.getState().token, { duplicate: printCount > 0 }), { width: 420, height: 600 })
      .then(() => setPrintCount((n) => n + 1))
      .catch((e: unknown) => {
        if (isPreBillRequired(e)) setPrintNote({ text: 'This order isn’t paid yet — print a pre-bill instead.', offerPreBill: true })
        else setPrintNote({ text: tillErrorMessage(e, 'The bill is not available for this order'), offerPreBill: false })
      })
  }
  function printOrderPreBill(orderId: string) {
    setPrintNote(null)
    printPreBill(orderId, 'cash', useAuthStore.getState().token)
      .then(() => setPrintNote({ text: 'Pre-bill printed — not a tax invoice. It is listed under Finance → Voided pre bills until the bill is paid.', offerPreBill: false }))
      .catch((e: unknown) => setPrintNote({ text: preBillErrorMessage(e), offerPreBill: false }))
  }

  const saveNote = useMutation({
    mutationFn: (note: string) => api.patch(`/orders/${id}/notes`, { notes: note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['order-detail', id] })
      setNoteOpen(false)
    },
  })

  if (isLoading) {
    return (
      <div className="min-h-screen bg-s-bg flex items-center justify-center">
        <p className="text-s-muted">Loading order…</p>
      </div>
    )
  }

  if (isError || !order) {
    return (
      <div className="min-h-screen bg-s-bg flex items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-s-red font-semibold">Order not found</p>
          <Link href="/orders" className="text-sm text-s-muted hover:text-s-text">
            ← Back to orders
          </Link>
        </div>
      </div>
    )
  }

  // Compute financials
  const itemsSubtotal = order.items.reduce(
    (s, item) =>
      s + item.unitPriceCents * item.quantity +
      item.modifiers.reduce((ms, m) => ms + m.priceDeltaCents * item.quantity, 0),
    0,
  )
  const nextStatus = STATUS_NEXT[order.status]
  // A cancelled / rejected ticket that took money at the till: a manager hands it back.
  const moneyTaken = moneyTakenOf(order)
  const canHandBack = isManager && moneyTaken.dueCents > 0 && moneyTaken.byTender.length > 0

  // Timeline events
  const timeline: { label: string; time: string | null }[] = [
    { label: 'Placed', time: order.placedAt },
    { label: 'Completed', time: order.completedAt ?? null },
    { label: 'Cancelled', time: order.cancelledAt ?? null },
  ].filter((e) => e.time !== null)

  return (
    <div className="min-h-screen bg-s-bg">
      {refundOpen && (
        <RefundModal
          order={order}
          onClose={() => setRefundOpen(false)}
          onDone={(message) => {
            setNotice({ tone: 'ok', text: message })
            void qc.invalidateQueries({ queryKey: ['order-detail', id] })
            void qc.invalidateQueries({ queryKey: ['order-fiscal', id] })
          }}
        />
      )}
      {handBackOpen && canHandBack && (
        <MoneyTakenModal
          order={order}
          onClose={() => setHandBackOpen(false)}
          onDone={(message) => {
            setNotice({ tone: 'ok', text: message })
            void qc.invalidateQueries({ queryKey: ['order-detail', id] })
            void qc.invalidateQueries({ queryKey: ['order-fiscal', id] })
          }}
        />
      )}
      {voidTarget && (
        <VoidLineDialog
          orderId={order.id}
          item={voidTarget}
          isManager={isManager}
          onClose={() => setVoidTarget(null)}
          onVoided={lineVoided}
        />
      )}

      {/* ── Header ── */}
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Link href="/orders" className="text-xs text-s-muted hover:text-s-text">
              ← Orders
            </Link>
            <div className="flex items-center gap-3 mt-0.5">
              <h1 className="text-xl font-bold text-s-text font-mono">
                #{orderRef(order.id)}
              </h1>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold uppercase ${STATUS_COLORS[order.status] ?? ''}`}>
                {order.status}
              </span>
              <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${SOURCE_COLORS[order.source] ?? ''}`}>
                {order.source}
              </span>
            </div>
            <p className="text-xs text-s-muted mt-0.5">
              {order.concept.name} ·{' '}
              {formatDistanceToNowStrict(new Date(order.placedAt))} ago ·{' '}
              {format(new Date(order.placedAt), 'dd MMM yyyy, HH:mm')}
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 flex-wrap justify-end">
            {nextStatus && (
              <button
                onClick={() => updateStatus.mutate(nextStatus)}
                disabled={updateStatus.isPending}
                className="rounded-xl bg-primary text-primary-on text-sm font-bold px-4 py-2 hover:opacity-90 disabled:opacity-50">
                {updateStatus.isPending ? '…' : STATUS_CTA[order.status]}
              </button>
            )}
            <button
              onClick={() => {
                setNoteDraft(order.deliveryNotes ?? '')
                setNoteOpen(!noteOpen)
              }}
              className="rounded-xl border border-s-border text-s-muted text-sm px-4 py-2 hover:border-primary hover:text-primary-ink transition-colors">
              {order.deliveryNotes ? 'Edit Note' : '+ Note'}
            </button>
            {!canPrint ? null : NOT_FINAL.has(order.status) ? (
              <button
                onClick={() => printOrderPreBill(order.id)}
                className="rounded-xl border border-s-border text-s-muted text-sm px-4 py-2 hover:border-primary hover:text-primary-ink transition-colors">
                Print pre-bill
              </button>
            ) : !ENDED.has(order.status) && (
              <button
                onClick={() => printFinalBill(order.id)}
                className="rounded-xl border border-s-border text-s-muted text-sm px-4 py-2 hover:border-primary hover:text-primary-ink transition-colors">
                {printCount === 0 ? 'Print bill' : 'Reprint bill'}
              </button>
            )}
            {!['cancelled', 'rejected', 'refunded'].includes(order.status) && (
              <button
                onClick={() => setRefundOpen(true)}
                className="rounded-xl border border-s-red/40 bg-s-red/10 text-s-red text-sm font-semibold px-4 py-2 hover:bg-s-red/20 transition-colors">
                Refund
              </button>
            )}
          </div>
        </div>

        {canHandBack && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-s-amber/40 bg-s-amber-dim px-3 py-2 text-sm" role="status">
            <span className="text-s-text">
              Money taken: <strong className="font-mono">{fmtPkr(moneyTaken.dueCents)}</strong>
              <span className="text-s-muted"> — this ticket was {order.status}; the guest is owed it back.</span>
            </span>
            <button onClick={() => setHandBackOpen(true)}
              className="ml-auto rounded-lg border border-s-red/40 bg-s-red/10 px-3 py-1.5 text-xs font-semibold text-s-red hover:bg-s-red/20">
              Refund
            </button>
          </div>
        )}
        {printNote && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm" role="status">
            <span className="text-s-amber">{printNote.text}</span>
            {printNote.offerPreBill && canPrint && (
              <button onClick={() => printOrderPreBill(order.id)}
                className="rounded-lg border border-s-border px-3 py-1.5 text-xs font-semibold text-s-text hover:border-primary">
                Print pre-bill
              </button>
            )}
          </div>
        )}
        {notice && (
          <div className={`mt-3 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
            notice.tone === 'ok' ? 'border-s-green/40 bg-s-green-dim text-s-green'
              : notice.tone === 'warn' ? 'border-s-amber/40 bg-s-amber-dim text-s-amber'
              : 'border-s-red/40 bg-s-red-dim text-s-red'
          }`} role="status">
            <span>{notice.text}</span>
            {notice.splitLink && (
              <Link href={`/orders/${order.id}/split`} className="font-semibold underline">Re-split the bill</Link>
            )}
            <button onClick={() => setNotice(null)} className="ml-auto text-xs underline">Dismiss</button>
          </div>
        )}

        {/* Inline note editor */}
        {noteOpen && (
          <div className="mt-3 flex items-center gap-3">
            <input
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Add a note about this order…"
              className="flex-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none"
              autoFocus
            />
            <button
              onClick={() => saveNote.mutate(noteDraft)}
              disabled={saveNote.isPending}
              className="rounded-lg bg-primary text-primary-on font-bold px-4 py-2 text-xs hover:opacity-90 disabled:opacity-50">
              {saveNote.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => setNoteOpen(false)}
              className="text-xs text-s-muted hover:text-s-text">
              Cancel
            </button>
          </div>
        )}
      </header>

      <div className="p-6 max-w-5xl mx-auto space-y-5">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* ── Left column: Customer + Fulfilment + Timeline ── */}
          <div className="space-y-5">

            {/* Customer */}
            <div className="rounded-xl border border-s-border bg-s-surface p-4">
              <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-3">Customer</p>
              {order.customer ? (
                <div className="space-y-1">
                  {canOpenCrm ? (
                    <Link
                      href={`/crm?customer=${order.customer.id}`}
                      className="text-sm font-semibold text-primary-ink hover:underline">
                      {order.customer.name}
                    </Link>
                  ) : (
                    <p className="text-sm font-semibold text-s-text">{order.customer.name}</p>
                  )}
                  {order.customer.phone && (
                    <p className="text-sm text-s-muted">{order.customer.phone}</p>
                  )}
                  {order.customer.email && (
                    <p className="text-xs text-s-muted">{order.customer.email}</p>
                  )}
                  {order.loyaltyPointsEarned != null && (
                    <p className="text-xs text-s-amber mt-1">
                      +{order.loyaltyPointsEarned} loyalty pts earned
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-s-text">
                    {order.customerName ?? order.table?.label ?? 'Guest'}
                  </p>
                  <p className="text-xs text-s-muted">No linked account</p>
                </div>
              )}
              {order.posStaff && (
                <p className="text-xs text-s-muted mt-2">
                  Served by: <span className="text-s-text">{order.posStaff.name}</span>
                </p>
              )}
            </div>

            {/* Fulfilment */}
            <div className="rounded-xl border border-s-border bg-s-surface p-4">
              <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-3">Fulfilment</p>
              {order.curbsideVehicle ? (
                <div className="space-y-1.5 text-sm">
                  <p className="font-semibold text-primary-ink">Curbside pickup</p>
                  <p className="text-s-muted">Vehicle: {order.curbsideVehicle}</p>
                  {order.curbsidePlate && <p className="text-s-muted">Plate: {order.curbsidePlate}</p>}
                  {order.curbsideSpot && <p className="text-s-muted">Spot: {order.curbsideSpot}</p>}
                  {order.curbsideArrivedAt ? (
                    <p className="text-xs text-primary-ink">
                      Arrived {formatDistanceToNowStrict(new Date(order.curbsideArrivedAt))} ago
                    </p>
                  ) : (
                    <p className="text-xs text-s-amber">En route</p>
                  )}
                </div>
              ) : order.rider ? (
                <div className="space-y-1 text-sm">
                  <p className="font-semibold text-s-text">Delivery</p>
                  {order.deliveryNotes && <p className="text-s-muted text-xs">{order.deliveryNotes}</p>}
                  <div className="pt-2 border-t border-s-border/50 mt-2">
                    <p className="text-xs text-s-muted">Rider: <span className="text-s-text font-semibold">{order.rider.name}</span></p>
                    <p className="text-xs text-s-muted">{order.rider.phone}</p>
                  </div>
                </div>
              ) : order.table ? (
                <div className="text-sm">
                  <p className="font-semibold text-s-text">Dine-in</p>
                  <p className="text-s-muted">Table {order.table.label}</p>
                </div>
              ) : (
                <p className="text-sm text-s-muted capitalize">{order.source === 'pos' ? 'Point of sale' : 'Takeaway / pickup'}</p>
              )}
              {order.deliveryNotes && (
                <div className="mt-3 pt-3 border-t border-s-border/50">
                  <p className="text-xs text-s-muted">Note:</p>
                  <p className="text-sm text-s-text mt-0.5">{order.deliveryNotes}</p>
                </div>
              )}
            </div>

            {/* Timeline */}
            {timeline.length > 0 && (
              <div className="rounded-xl border border-s-border bg-s-surface p-4">
                <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-3">Timeline</p>
                <div className="relative pl-4">
                  {timeline.map((ev, i) => (
                    <div key={ev.label} className="relative mb-3 last:mb-0">
                      {/* Line */}
                      {i < timeline.length - 1 && (
                        <div className="absolute left-[-9px] top-4 w-px h-full bg-s-border" />
                      )}
                      {/* Dot */}
                      <div className="absolute left-[-13px] top-1.5 h-2 w-2 rounded-full bg-primary" />
                      <p className="text-xs font-semibold text-s-text">{ev.label}</p>
                      <p className="text-[11px] text-s-muted">
                        {ev.time ? format(new Date(ev.time), 'dd MMM yyyy, HH:mm') : '—'}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Right column: Items + Financials ── */}
          <div className="lg:col-span-2 space-y-5">

            {/* Items table */}
            <div className="rounded-xl border border-s-border overflow-hidden">
              <div className="px-4 py-3 bg-s-surface border-b border-s-border flex items-center justify-between">
                <p className="text-xs font-bold text-s-muted uppercase tracking-widest">
                  Items ({order.items.length})
                </p>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-s-surface/50 border-b border-s-border">
                  <tr>
                    {['Item', 'Qty', 'Unit Price', 'Subtotal', 'Status', ''].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-s-muted">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-s-border">
                  {order.items.map((item) => {
                    const modifiersTotal = item.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)
                    const effectivePrice = item.unitPriceCents + modifiersTotal
                    const lineTotal = effectivePrice * item.quantity
                    return (
                      <tr key={item.id} className="hover:bg-s-surface/40">
                        <td className="px-4 py-3">
                          <p className="font-medium text-s-text">{item.name}</p>
                          {item.modifiers.length > 0 && (
                            <p className="text-xs text-s-muted mt-0.5">
                              {item.modifiers.map((m) =>
                                `${m.name}${m.priceDeltaCents !== 0 ? ` (${m.priceDeltaCents > 0 ? '+' : ''}${fmtPkrWhole(m.priceDeltaCents)})` : ''}`
                              ).join(', ')}
                            </p>
                          )}
                          {item.notes && (
                            <p className="text-xs text-s-amber mt-0.5 italic">{item.notes}</p>
                          )}
                          {item.station && (
                            <p className="text-[10px] text-s-muted/60 mt-0.5">{item.station.name}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-s-muted">{item.quantity}</td>
                        <td className="px-4 py-3 font-mono text-xs text-s-text">{fmtPkrWhole(effectivePrice)}</td>
                        <td className="px-4 py-3 font-mono text-xs font-bold text-primary-ink">{fmtPkrWhole(lineTotal)}</td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${ITEM_STATUS_COLORS[item.status] ?? 'text-s-muted'}`}>
                            {item.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {item.status !== 'voided' && !['cancelled', 'rejected', 'refunded'].includes(order.status) && (
                            <button
                              onClick={() => setVoidTarget({ id: item.id, name: item.name, quantity: item.quantity, lineCents: lineTotal })}
                              className="rounded-lg border border-s-red/40 text-s-red text-[11px] font-semibold px-2 py-1 hover:bg-s-red/10 transition-colors">
                              Void
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </div>

            {/* The fiscal invoice (full & final bill) and any fiscal refunds */}
            <OrderFiscalPanel
              orderId={order.id}
              canRetry={isManager}
              onReprint={canPrint ? () => printFinalBill(order.id) : undefined}
            />

            {/* Financials */}
            <div className="rounded-xl border border-s-border bg-s-surface p-4">
              <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-3">Financials</p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-s-muted">Items subtotal</span>
                  <span className="font-mono text-s-text">{fmtPkrWhole(itemsSubtotal)}</span>
                </div>
                {order.taxCents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-s-muted">Tax</span>
                    <span className="font-mono text-s-text">{fmtPkrWhole(order.taxCents)}</span>
                  </div>
                )}
                {order.tipCents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-s-muted">Tip</span>
                    <span className="font-mono text-s-text">{fmtPkrWhole(order.tipCents)}</span>
                  </div>
                )}
                {order.serviceChargeCents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-s-muted">Service charge</span>
                    <span className="font-mono text-s-text">{fmtPkrWhole(order.serviceChargeCents)}</span>
                  </div>
                )}
                {order.discountCents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-s-muted">Discount</span>
                    <span className="font-mono text-s-red">-{fmtPkrWhole(order.discountCents)}</span>
                  </div>
                )}
                {order.walletAmountCents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-s-muted">Wallet used</span>
                    <span className="font-mono text-s-amber">-{fmtPkrWhole(order.walletAmountCents)}</span>
                  </div>
                )}
                <div className="flex justify-between pt-2 border-t border-s-border">
                  <span className="font-bold text-s-text">Total</span>
                  <span className="font-mono font-bold text-primary-ink text-base">{fmtPkrWhole(order.totalCents)}</span>
                </div>
              </div>

              {/* Payments */}
              {order.payments.length > 0 && (
                <div className="mt-4 pt-4 border-t border-s-border space-y-2">
                  <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-2">Payments</p>
                  {order.payments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${PAYMENT_COLORS[p.method] ?? 'text-s-muted bg-s-bg'}`}>
                          {paymentMethodLabel(p.method)}
                        </span>
                        {p.method === 'raast' && <RaastPaymentNote payment={p} />}
                      </div>
                      <div className="text-right">
                        <span className="font-mono text-sm font-bold text-primary-ink">{fmtPkrWhole(p.amountCents)}</span>
                        {p.changeCents != null && p.changeCents > 0 && (
                          <p className="text-xs text-s-muted">Change: {fmtPkrWhole(p.changeCents)}</p>
                        )}
                        <p className="text-[10px] text-s-muted capitalize">{p.status}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Tax documents — the numbered invoice and any credit notes */}
              {(order.taxInvoices?.length ?? 0) > 0 && (
                <div className="mt-4 pt-4 border-t border-s-border space-y-2">
                  <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-2">Tax documents</p>
                  {order.taxInvoices!.map((inv) => (
                    <div key={inv.id} className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-mono text-sm text-s-text">{inv.invoiceNumber}</p>
                        <p className="text-[10px] text-s-muted">
                          {inv.type === 'credit_note' ? 'Credit note' : 'Tax invoice'} · {format(new Date(inv.issuedAt), 'dd MMM yyyy, HH:mm')}
                        </p>
                      </div>
                      <button
                        onClick={() => void openInvoice(inv.id)}
                        className="rounded-lg border border-s-border text-s-muted text-xs px-3 py-1.5 hover:border-primary hover:text-primary-ink transition-colors">
                        View
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}
