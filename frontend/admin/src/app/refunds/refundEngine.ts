// The ONE refund engine, from the admin side: POST /pos/orders/:id/refund
// (backend pos/service.ts refundOrder). Refund-policy caps apply; above the
// signed-in user's cap the server answers 403 MANAGER_OVERRIDE_REQUIRED and
// we ask for a manager PIN and resend. A cash refund comes out of the drawer
// open now (owner decision 3) — the refunder's own open shift unless one is
// named. Used by /refunds and the order page (through RefundOptions).
//
// A card payment taken ON THE CARD MACHINE (gateway 'card_terminal') is
// refunded back to the card through the machine (spec §7.11): POST
// /pos/terminal/refunds (managers), then the server books the refund through
// the same refundOrder once the machine approves. Policy (reason, photo,
// caps) is checked before the machine moves any money.
//
// Raast QR (2026-10-12): a Raast sale is refunded by Raast — the money is SENT
// BACK FROM THE BANK FIRST, then recorded here with that outgoing transfer's
// reference (`gatewayRef`, required: 400 RAAST_REFUND_REF_REQUIRED). A manager
// always approves a Raast refund (403 MANAGER_OVERRIDE_REQUIRED for anyone
// else → the PIN prompt below). The ledger credits the receiving bank account,
// never 1030. Keenu QR is retired: an OLD keenu_qr sale is still refunded by
// keenu_qr exactly as before.
import { api, ApiError } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import {
  dropRefundKey, fetchTerminalConfig, getTerminalCharge, refundKeyFor, startTerminalRefund, terminalChargesFor, terminalErrorMessage,
  type FiscalView, type TerminalChargeView,
} from '../../components/pos/tillApi'
import { managerPinLockedMessage, WRONG_PIN_MESSAGE } from '../../components/pos/pinErrors'

export type RefundTender = 'cash' | 'card' | 'raast' | 'keenu_qr'

export interface RefundRequest {
  amountCents: number
  reason: string
  method?: RefundTender
  shiftId?: string
  /** Required when the company's refund policy asks for photo evidence. */
  photoUrl?: string
  /** Raast QR: the reference of the transfer already sent back from the bank. */
  gatewayRef?: string
}

export interface RefundResult {
  id: string
  amountCents: number
  shiftId: string | null
  entryId: string
  orderRefunded: boolean
  /** The refund's fiscal document (credit note at the POS) — null when none is needed. */
  fiscalRefund?: FiscalView | null
  /** @deprecated always null once the API files through the POS connector. */
  srbReturnInvoiceNo?: string | null
}

const PIN_CODES = new Set(['MANAGER_OVERRIDE_REQUIRED', 'INVALID_MANAGER_PIN'])
/** How many times we ask for a manager PIN. Every PIN typed is sent: the loop
 *  makes one more request than it has prompts, and the last refusal is shown
 *  as itself (refundErrorMessage), never as a generic "not accepted". */
export const REFUND_PIN_PROMPTS = 3

export async function refundThroughEngine(orderId: string, req: RefundRequest): Promise<RefundResult> {
  let pin: string | undefined
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.post<RefundResult>(`/pos/orders/${orderId}/refund`, {
        amountCents: req.amountCents,
        reason: req.reason,
        ...(req.method && { method: req.method }),
        ...(req.shiftId && { shiftId: req.shiftId }),
        ...(req.photoUrl && { photoUrl: req.photoUrl }),
        ...(req.gatewayRef && { gatewayRef: req.gatewayRef }),
        ...(pin && { managerOverridePin: pin }),
      })
    } catch (err) {
      // A 429 MANAGER_PIN_LOCKED is not in PIN_CODES: the server compares no
      // PIN while locked, so we stop asking and refundErrorMessage says why.
      if (!(err instanceof ApiError) || !PIN_CODES.has(err.code) || typeof window === 'undefined') throw err
      // Out of prompts: show this refusal (a wrong PIN reads WRONG_PIN_MESSAGE).
      if (attempt >= REFUND_PIN_PROMPTS) throw err
      const entered = window.prompt(
        err.code === 'INVALID_MANAGER_PIN'
          ? 'That PIN is not right. Manager PIN:'
          : req.method === 'raast'
            ? 'A manager approves every Raast refund. Manager PIN:'
            : 'This refund is above your limit. Manager PIN:',
      )
      if (!entered) throw err
      pin = entered.trim()
    }
  }
}

// ─── Which tenders a refund may go back on (ONL-16 / F1) ────────────────────

export interface RefundPayment {
  id: string
  method: string
  amountCents: number
  status: string
  gateway?: string | null
}

/** The server's REFUND_TENDERS (backend lib/tenders.ts): the way a sale was paid, incl. the retired Keenu QR's old rows. */
const REFUND_TENDERS: readonly RefundTender[] = ['cash', 'card', 'raast', 'keenu_qr']
/** The server's PENDING_GATEWAY_TENDERS: pending rows a processor may still confirm — never Raast. */
const DIGITAL_TENDERS: readonly string[] = ['card', 'keenu_qr']

/**
 * The payment rows a refund may go back on — the server's refundableOf
 * (backend pos/service.ts): the paid receipts (cash / card / Raast QR / the
 * retired Keenu QR, positive amounts); when there are none, a completed ONLINE
 * order (source not 'pos') whose card / QR row the gateway never confirmed
 * counts its pending card / QR rows. A till order with nothing paid has
 * nothing to refund.
 */
export function refundBaseOf(payments: RefundPayment[], source?: string | null): RefundPayment[] {
  const receipts = payments.filter((p) => p.status === 'paid' && p.amountCents > 0 && (REFUND_TENDERS as readonly string[]).includes(p.method))
  if (receipts.length > 0) return receipts
  if (source != null && source !== 'pos') {
    return payments.filter((p) => p.status === 'pending' && p.amountCents > 0 && DIGITAL_TENDERS.includes(p.method))
  }
  return []
}

/** The tenders the order was actually paid with — the only ones a refund may use (the server's rule, refundBaseOf). */
export function refundTendersOf(payments: RefundPayment[], source?: string | null): RefundTender[] {
  const seen = new Set<RefundTender>(refundBaseOf(payments, source).map((p) => p.method as RefundTender))
  return REFUND_TENDERS.filter((t) => seen.has(t))
}

/** The card-machine payment a card refund of `amountCents` goes back on (the largest that covers it), or null. */
export function terminalPaymentFor(payments: RefundPayment[], amountCents: number): RefundPayment | null {
  const machine = payments
    .filter((p) => p.method === 'card' && p.gateway === 'card_terminal' && p.status === 'paid' && p.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents)
  return machine.find((p) => p.amountCents >= amountCents) ?? null
}

export const TENDER_LABEL: Record<RefundTender, string> = {
  cash: 'Cash (from my open drawer)',
  card: 'Card – Keenu',
  raast: 'Raast QR — send it back from the bank first',
  keenu_qr: 'Keenu QR (retired)',
}

/**
 * Why an outgoing Raast refund reference would be refused (the server's
 * format rule — normalised, letters/digits, 3+ digits, not one repeated
 * character; the length is the company rule, checked by the server), or null. A refund reference is not unique: one outgoing
 * transfer is the bank's, not a sale's.
 */
export function raastRefundRefProblem(raw: string): string | null {
  const ref = raw.trim().toUpperCase().replace(/[\s\-_./#:]+/g, '')
  if (!ref) return 'Type the reference of the transfer you sent back from the bank.'
  // Length is the company's own rule (refMinLength / refMaxLength) — the
  // server checks it (RAAST_REF_INVALID); only rule-independent checks here (UI-4).
  if (!/^[A-Z0-9]+$/.test(ref)) return 'A bank reference is letters and digits only.'
  if ((ref.match(/[0-9]/g) ?? []).length < 3) return 'A bank reference has at least 3 digits.'
  if (/^(.)\1*$/.test(ref)) return 'That is one repeated character, not a bank reference.'
  return null
}

// ─── Evidence photo (refund policy: requirePhotoEvidence) ───────────────────

/** Upload a photo through the media presigner; returns its public URL. */
export async function uploadEvidencePhoto(file: File): Promise<string> {
  const type = file.type || 'image/jpeg'
  const ext = type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'jpg'
  const filename = `refund-evidence-${Date.now()}.${ext}`
  const { uploadUrl, publicUrl } = await api.get<{ uploadUrl: string; publicUrl: string }>(
    `/media/upload-url?filename=${encodeURIComponent(filename)}&contentType=${encodeURIComponent(type)}&category=refunds&kind=image`,
  )
  const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': type } })
  if (!put.ok) throw new Error(`The photo upload failed (${put.status}) — try again`)
  return publicUrl
}

// ─── Refund to the card on the card machine ─────────────────────────────────

const REFUND_FINAL = new Set(['recorded', 'declined', 'cancelled', 'expired', 'voided', 'needs_attention'])
/** Still on its way back to the card: the money may yet move — never start a second refund beside it. */
const REFUND_IN_FLIGHT = new Set(['pending', 'sent', 'approved', 'cancel_requested', 'unknown'])
/** Over: booked, or nothing moved — the next tap is a new attempt (a new key). */
const REFUND_KEY_DONE = new Set(['recorded', 'declined', 'cancelled', 'expired'])

/** True once a card-machine refund has a final answer (booked, refused, or handed to a manager). */
export function terminalRefundFinal(c: TerminalChargeView): boolean {
  return REFUND_FINAL.has(c.status)
}

/** A card-machine refund still in flight on this payment (or on the order, when the API does not say which payment). */
export function inFlightRefundFor(charges: TerminalChargeView[], paymentId: string): TerminalChargeView[] {
  return charges.filter((c) => c.kind === 'refund' && REFUND_IN_FLIGHT.has(c.status)
    && (c.targetPaymentId == null || c.targetPaymentId === paymentId))
}

/** Follow a card-machine refund until it is final or `ms` pass. */
export async function followTerminalRefund(
  start: TerminalChargeView,
  onProgress?: (c: TerminalChargeView) => void,
  ms = 120_000,
  isCancelled?: () => boolean,
): Promise<TerminalChargeView> {
  let c = start
  onProgress?.(c)
  const until = Date.now() + ms
  while (!REFUND_FINAL.has(c.status) && Date.now() < until && !isCancelled?.()) {
    await new Promise((r) => setTimeout(r, 1500))
    try { c = await getTerminalCharge(c.id) } catch { /* a blip: keep following */ }
    onProgress?.(c)
  }
  return c
}

/**
 * Refund a card-machine payment back to the card and follow it until the
 * machine answers (or ~2 minutes pass — the reconciler finishes it then).
 * `onProgress` gets every state the machine reports.
 *
 * Exactly once (spec §7.3): a refund already in flight on this payment is
 * FOLLOWED, never doubled; the attempt's idempotency key is kept per payment
 * and amount, so a lost response or a second tap replays the same refund on
 * the server. The key is dropped only once the attempt is over.
 */
export async function refundOnCardMachine(
  orderId: string,
  input: { payment: RefundPayment; amountCents: number; reason: string; photoUrl?: string; shiftId?: string | null },
  onProgress?: (c: TerminalChargeView) => void,
): Promise<TerminalChargeView> {
  const charges = await terminalChargesFor(orderId)

  // A refund already on its way back to this card: follow it.
  const inFlight = inFlightRefundFor(charges, input.payment.id)
  const same = inFlight.find((c) => c.amountCents === input.amountCents)
  if (same) return finish(input.payment.id, input.amountCents, await followTerminalRefund(same, onProgress))
  if (inFlight.length > 0) {
    throw new Error(
      `A card refund of ${fmtPkr(inFlight[0]!.amountCents)} is still in flight on the card machine for this order — `
      + 'wait for it to finish (or resolve it in Dev → API → POS connector → Card charges) before refunding again.',
    )
  }

  // The machine that took the payment, else one at the refunder's drawer.
  let terminalId = charges.find((c) => c.kind === 'charge' && c.payment?.id === input.payment.id)?.terminalId
  if (!terminalId && input.shiftId) terminalId = (await fetchTerminalConfig(input.shiftId).catch(() => null))?.terminals[0]?.id
  if (!terminalId) throw new Error('No card machine was found for this payment — refund it on the machine by hand, then record it as a card refund.')

  const started = await startTerminalRefund({
    paymentId: input.payment.id,
    amountCents: input.amountCents,
    terminalId,
    idempotencyKey: refundKeyFor(input.payment.id, input.amountCents),
    reason: input.reason,
    ...(input.photoUrl && { photoUrl: input.photoUrl }),
  })
  return finish(input.payment.id, input.amountCents, await followTerminalRefund(started, onProgress))
}

function finish(paymentId: string, amountCents: number, c: TerminalChargeView): TerminalChargeView {
  if (REFUND_KEY_DONE.has(c.status)) dropRefundKey(paymentId, amountCents)
  return c
}

/** Keep following a refund that was still in flight (the page's "keep following"); drops the key when it ends. */
export async function keepFollowingTerminalRefund(
  c: TerminalChargeView,
  paymentId: string,
  onProgress?: (c: TerminalChargeView) => void,
  ms = 120_000,
  isCancelled?: () => boolean,
): Promise<TerminalChargeView> {
  return finish(paymentId, c.amountCents, await followTerminalRefund(c, onProgress, ms, isCancelled))
}

/** One line for a card-machine refund's state. */
export function terminalRefundText(c: TerminalChargeView): { ok: boolean; text: string } {
  switch (c.status) {
    case 'pending':
    case 'sent':
      return { ok: true, text: `Hand the card to the guest: refund ${c.terminalLabel} is waiting for the card…` }
    case 'approved':
      return { ok: true, text: 'The machine approved the refund — booking it…' }
    case 'recorded':
      return { ok: true, text: 'Refunded to the card on the card machine and booked.' }
    case 'declined':
      return { ok: false, text: `The card machine declined the refund${c.message ? ` (${c.message})` : ''}. Nothing was refunded.` }
    case 'cancelled':
    case 'expired':
      return { ok: false, text: 'The refund was not completed on the card machine. Nothing was refunded.' }
    case 'needs_attention':
      return { ok: false, text: 'The machine refunded the card but servd could not book it — a manager has been alerted. Do not refund again.' }
    default:
      return { ok: false, text: 'The refund is still in flight on the card machine — it has not answered yet. Do not refund again; servd keeps following it (Dev → API → POS connector → Card charges).' }
  }
}

export function refundErrorMessage(e: unknown): string {
  const locked = managerPinLockedMessage(e)
  if (locked) return locked
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'INVALID_MANAGER_PIN': return WRONG_PIN_MESSAGE
      case 'PHOTO_REQUIRED': return 'The refund policy needs a photo — attach one and try again.'
      case 'REASON_REQUIRED': return 'The refund policy needs a reason.'
      case 'OVER_CAP': return 'This refund is above the manager limit — the CEO must approve it.'
      case 'MANAGER_OVERRIDE_REQUIRED': return e.message || 'A manager must approve this refund.'
      case 'NOT_A_TERMINAL_PAYMENT': return 'This card payment was not taken on the card machine — refund it as a card refund instead.'
      case 'AMOUNT_EXCEEDS_REFUNDABLE': return e.message || 'That is more than can still be refunded on this payment.'
      case 'TERMINAL_NOT_CONFIGURED':
      case 'TERMINAL_NOT_IN_COMPANY':
        return terminalErrorMessage(e)
      case 'RAAST_REFUND_REF_REQUIRED':
        return 'A Raast refund is sent back from the bank first — type that outgoing transfer’s reference.'
      case 'RAAST_REF_INVALID':
        return e.message || 'That bank reference doesn’t look right — type the reference of the transfer you sent back.'
      case 'RAAST_REFUND_SPLIT':
        return e.message || 'That is more than any single Raast payment on this order can take back — refund it in parts, one per Raast payment.'
      case 'RAAST_ACCOUNT_UNKNOWN':
        return 'servd cannot tell which bank account received this Raast payment — finance must check it before it is refunded.'
      case 'KEENU_QR_RETIRED':
        return 'Keenu QR is retired — refund the sale the way it was paid.'
      case 'REFUND_METHOD_NOT_TENDERED':
        return e.message || 'Refund the way the sale was paid.'
    }
    return e.message || e.code
  }
  return e instanceof Error ? e.message : 'Refund failed'
}

// ─── Cancelling a whole order (spec §17.4: a manager approves) ──────────────

/**
 * POST /orders/:id/cancel — the one staff cancel. A non-manager sends a
 * manager's PIN (the manager is recorded as the approver, and every pre-bill
 * of the order lands in Finance → Voided pre bills with their name).
 */
export function cancelOrderWithApproval(orderId: string, reason: string, managerOverridePin?: string) {
  return api.post<{ ok: true }>(`/orders/${encodeURIComponent(orderId)}/cancel`, {
    reason,
    ...(managerOverridePin && { managerOverridePin }),
  })
}

/** A readable line for a void / cancel refusal that needs a manager. */
export function approvalErrorMessage(e: unknown, what: 'void' | 'cancel'): string {
  const locked = managerPinLockedMessage(e)
  if (locked) return locked
  if (e instanceof ApiError) {
    if (e.code === 'MANAGER_OVERRIDE_REQUIRED') {
      return what === 'void'
        ? 'Every void needs a manager — enter a manager’s PIN.'
        : 'Cancelling an order needs a manager — enter a manager’s PIN.'
    }
    if (e.code === 'INVALID_MANAGER_PIN') return WRONG_PIN_MESSAGE
    if (e.status === 403 && (e.code === 'FORBIDDEN' || !e.code)) {
      return what === 'void' ? 'Your role cannot void here — ask a manager.' : 'Only a manager can cancel an order — ask a manager to do it.'
    }
    return e.message || e.code
  }
  return e instanceof Error ? e.message : 'Something went wrong'
}

/** The refund's fiscal line ("credit note" at the POS). */
export function fiscalRefundText(f: FiscalView | null | undefined): string | null {
  if (!f) return null
  const auth = (f.authority ?? '').toUpperCase()
  if (f.status === 'filed') return `Fiscal refund: ${auth ? `${auth} ` : ''}${f.fiscalNumber ?? ''}`.trim()
  if (f.status === 'test') return 'Fiscal refund: TEST — not filed with the tax authority'
  if (f.status === 'not_required') return null
  return 'Fiscal refund: pending — filed with the POS automatically'
}
