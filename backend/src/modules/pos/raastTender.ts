// Raast QR at the till — the receipt side of a Raast tender (spec §4, D3, D9).
//
// A Raast payment completes the sale at the till exactly like card: the
// Payment is 'paid' (gateway 'raast', gatewayRef = the NORMALISED bank
// reference), the one coverage rule completes the order and the full & final
// bill files once. The RaastReceipt written here, in the SAME transaction as
// the Payment, is the reconciliation record: 'provisional' until a
// bank-statement line matches it ('matched') — the bank statement is the
// truth, never Payment.status.
//
//   recordRaastReceiptTx      the receipt of ONE Raast tender. With an intent
//                             (the customer paid against an awaiting Raast
//                             request) it claims that row; otherwise it
//                             inserts a direct receipt on the brand's
//                             receiving account (connectors/raast/accounts).
//                             It enforces the company-wide "one transfer pays
//                             one bill" claim (tenantId, bankRef), refuses a
//                             reference a manager dismissed as "not a sale"
//                             (M4), and — SMS matching on, reference typed by
//                             the cashier — cross-checks the bank SMS.
//   chooseRaastRefundSourceTx which receipt a Raast refund goes back against:
//                             its bank account and ledger code ride on the
//                             refund row (gatewayMeta.raast), so the refund
//                             credits the bank the money came into.
//
// Lock order (M2/M3): every caller holds lockRaastTx(order's company) FIRST
// (connectors/raast/lock.ts), then the order lock. The SMS matcher, a
// cashier's typed reference, an attach and a reference fix of the same
// company are therefore serialised and never overwrite each other's receipt.
// An SMS settling an intent holds a short lease on it (settlingUntil +
// smsAlertId): only that SMS may claim it until the lease runs out.
//
// The fraud rule (D9): a Raast payment is verified on the COUNTER device
// (bank SMS / merchant app), never the customer's screen. A reference typed by
// the cashier is only accepted with cashierVerified (the till's "I saw it
// arrive" tick, server-enforced — 400 RAAST_NOT_VERIFIED).
//
// Cross-stream calls (connectors/raast/match.ts — the Raast engine) are
// dynamic imports: the engine itself calls processPayment / settlePayment,
// so a static import would be a module cycle.

import { Prisma, type RaastReceipt } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { resolveRaastAccount } from '../../connectors/raast/accounts.js'
import { normalizeBankRef, assertValidBankRef } from '../../connectors/raast/reference.js'
import { getConnector, connectorNow } from '../../connectors/registry.js'
import { TENDER_ROUNDING_CENTS } from '../accounting/shiftPosting.js'

type Tx = Prisma.TransactionClient

// ─── Tender metadata ─────────────────────────────────────────────────────────

export type RaastVia = 'cashier' | 'sms' | 'bank_api'

/**
 * What a Raast tender carries besides its money. Set by the SERVER only — the
 * till route maps its `raastVerified: true` to { via: 'cashier',
 * cashierVerified: true }; the intents and the SMS matcher set the rest. Never
 * accepted from a client body (like terminalChargeId).
 */
export interface RaastTenderMeta {
  via: RaastVia
  /** The awaiting Raast request (RaastReceipt) the customer paid against. */
  intentId?: string | null
  /** The bank SMS that settles it (via 'sms'). */
  smsAlertId?: string | null
  /** The cashier ticked "I saw it arrive on the counter device" (via 'cashier'). */
  cashierVerified?: boolean
}

/** A Raast refund's source, persisted on the refund row as gatewayMeta.raast. */
export interface RaastRefundSource {
  receiptId: string
  bankAccountId: string
  ledgerCode: string
}

/** gatewayMeta.raast of a Raast refund row, if any. */
export function raastMetaOf(meta: unknown): RaastRefundSource | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const r = (meta as Record<string, unknown>)['raast']
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const { receiptId, bankAccountId, ledgerCode } = r as Record<string, unknown>
  if (typeof receiptId !== 'string' || typeof bankAccountId !== 'string' || typeof ledgerCode !== 'string') return null
  return { receiptId, bankAccountId, ledgerCode }
}

// ─── References ──────────────────────────────────────────────────────────────

export interface RaastRefRule { min: number; max: number }

const DEFAULT_REF_RULE: RaastRefRule = { min: 6, max: 35 }

/**
 * The company's bank-reference rule — the Raast settings' refMinLength /
 * refMaxLength (the same rule GET /pos/raast/config shows the till), 6..35
 * until the company sets its own.
 */
export async function raastRefRule(tenantId: string): Promise<RaastRefRule> {
  const s = (await getConnector(tenantId, 'raast')).raastSettings
  const min = s.refMinLength > 0 ? s.refMinLength : DEFAULT_REF_RULE.min
  const max = s.refMaxLength >= min ? s.refMaxLength : Math.max(min, DEFAULT_REF_RULE.max)
  return { min, max }
}

/**
 * A bank reference typed at the till (or an outgoing refund transfer's):
 * `missing` when blank, else normalised (connectors/raast/reference.ts) and
 * validated — 422 RAAST_REF_INVALID. Returns the normalised and the raw text.
 */
export function cleanRaastRef(
  raw: string | null | undefined,
  opts: { orderId?: string; rule?: RaastRefRule; missing: () => AppError },
): { ref: string; raw: string } {
  const text = String(raw ?? '').trim()
  if (!text) throw opts.missing()
  const ref = normalizeBankRef(text)
  if (!ref) throw opts.missing()
  assertValidBankRef(ref, { orderId: opts.orderId, min: opts.rule?.min, max: opts.rule?.max })
  return { ref, raw: text.slice(0, 120) }
}

export function raastRefRequired(): AppError {
  return new AppError(
    'RAAST_REF_REQUIRED',
    'Type the bank reference (transaction ID) from the bank SMS or the merchant app on the counter phone',
    400,
  )
}

export function raastNotVerified(): AppError {
  return new AppError(
    'RAAST_NOT_VERIFIED',
    "Check the money arrived on the counter phone (bank SMS / merchant app) and tick that you saw it — never the customer's screen",
    400,
  )
}

/**
 * The "one transfer pays one bill" claim, checked BEFORE anything is written
 * (the unique index (tenantId, bankRef) is the backstop — a racing insert is
 * mapped to the same 409 outside the transaction, raastRefConflict):
 *   409 RAAST_REF_USED       — another receipt of this company has it;
 *   409 RAAST_REF_DISMISSED  — a manager marked that bank credit "not a sale",
 *                              or it is a debit's reference (M4): one transfer
 *                              is never both "not a sale" and a sale. The
 *                              Raast engine's one checker
 *                              (connectors/raast/match.ts assertRefNotClaimedTx).
 */
export async function assertRaastRefFreeTx(tx: Tx, tenantId: string, ref: string, exceptReceiptId?: string | null): Promise<void> {
  const used = await tx.raastReceipt.findFirst({
    where: { tenantId, bankRef: ref, ...(exceptReceiptId && { id: { not: exceptReceiptId } }) },
    select: { orderId: true },
  })
  if (used) throw raastRefUsed(used.orderId)
  const { assertRefNotClaimedTx } = await import('../../connectors/raast/match.js')
  await assertRefNotClaimedTx(tx, tenantId, ref)
}

function raastRefUsed(otherOrderId: string): AppError {
  const orderRef = orderRefOf(otherOrderId)
  return new AppError(
    'RAAST_REF_USED',
    `That bank reference already paid bill #${orderRef} — the same transfer can't pay two bills. Check the reference on the counter phone.`,
    409,
    { orderRef },
  )
}

/**
 * Outside the transaction: a unique violation on raast_receipts
 * (tenantId, bankRef) aborted it — a racing payment with the same reference
 * won. The same 409 the pre-check gives. Anything else is rethrown as is.
 */
export async function raastRefConflict(
  db: Pick<Tx, 'raastReceipt'>,
  err: unknown,
  tenantId: string | null,
  ref: string | null,
): Promise<never> {
  if (tenantId && ref && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = JSON.stringify(err.meta?.['target'] ?? '')
    if (target.includes('bankRef') || target.includes('raast_receipts')) {
      const other = await db.raastReceipt.findFirst({ where: { tenantId, bankRef: ref }, select: { orderId: true } })
      if (other) throw raastRefUsed(other.orderId)
    }
  }
  throw err
}

// ─── Intents ─────────────────────────────────────────────────────────────────

/** Receipt states an intent may be paid from. */
const CLAIMABLE = ['awaiting', 'needs_attention'] as const

function intentGone(status: string): AppError {
  return new AppError('RAAST_INTENT_GONE', `This Raast payment request is ${status.replace('_', ' ')} — start a new one`, 409, { status })
}

/** 409 RAAST_SETTLING — a bank SMS holds the intent's lease (M3); the same code the intent cancel gives. */
function intentSettling(): AppError {
  return new AppError('RAAST_SETTLING', 'A bank SMS is completing this Raast payment right now — wait a moment and look at the bill again', 409)
}

/**
 * The intent a Raast tender pays against, checked under the locks BEFORE any
 * money is written: this order's, this company's, for this part of the bill
 * (a check-split portion's own intent), still claimable — awaiting /
 * needs_attention with no live SMS lease, or under the lease of the SMS
 * settling it (M3: connectors/raast/match.ts leases an awaiting intent for a
 * bank SMS, and a needs_attention one for a cashier's attach) — and for
 * exactly this money (W4-MONEY-1 analogue: the bill moved while the customer
 * was paying → 409 AMOUNT_MISMATCH, the cashier takes it again).
 */
export async function assertRaastIntentUsableTx(tx: Tx, e: {
  intentId: string
  tenantId: string
  orderId: string
  amountCents: number
  tipCents: number
  targetPaymentId: string | null
  smsAlertId: string | null
}): Promise<RaastReceipt> {
  const intent = await tx.raastReceipt.findFirst({ where: { id: e.intentId, tenantId: e.tenantId, orderId: e.orderId } })
  if (!intent) throw new AppError('RAAST_INTENT_GONE', 'That Raast payment request is not one of this bill', 409, { status: 'not_found' })
  if (!(CLAIMABLE as readonly string[]).includes(intent.status)) throw intentGone(intent.status)
  const leased = !!intent.settlingUntil && intent.settlingUntil.getTime() > connectorNow().getTime()
  const ownLease = !!e.smsAlertId && intent.smsAlertId === e.smsAlertId
  if (leased && !ownLease) throw intentSettling()
  if ((intent.targetPaymentId ?? null) !== e.targetPaymentId) {
    throw new AppError('RAAST_INTENT_MISMATCH', 'That Raast payment request was started for a different part of this bill', 409)
  }
  if (intent.amountCents !== e.amountCents || intent.tipCents !== e.tipCents) {
    throw new AppError(
      'AMOUNT_MISMATCH',
      `The customer was asked to transfer ${intent.amountCents} but ${e.amountCents} would be recorded — the bill changed while they were paying`,
      409,
      { intentAmountCents: intent.amountCents, intentTipCents: intent.tipCents, amountCents: e.amountCents, tipCents: e.tipCents },
    )
  }
  return intent
}

// ─── The receipt ─────────────────────────────────────────────────────────────

export interface RecordRaastReceiptInput {
  order: { id: string; conceptId: string; tenantId: string }
  /** The Payment just written for this tender (paid). */
  payment: { id: string; amountCents: number }
  tipCents: number
  /** The drawer that took it. */
  shiftId: string | null
  /** Normalised (connectors/raast/reference.ts). */
  bankRef: string
  bankRefRaw: string | null
  via: RaastVia
  cashierVerified: boolean
  actorId: string
  intentId?: string | null
  smsAlertId?: string | null
  /** A check-split portion this tender settles. */
  targetPaymentId?: string | null
  /** Shift correction re-issue only (processPayment TillPaymentInternal.asOf): the original sale's time. */
  at?: Date
}

export type RecordedRaastReceipt = RaastReceipt & { smsConfirmed: boolean }

/**
 * THE receipt of one Raast tender, inside the payment's transaction (the
 * caller holds lockRaastTx for the order's company, then the order lock).
 * Throws — rolling the payment back with it — on a used / dismissed reference,
 * an intent that is gone or for other money, no receiving account (422
 * RAAST_NOT_SET_UP), or a bank SMS for the typed reference that names a
 * different amount (422 RAAST_AMOUNT_MISMATCH).
 */
export async function recordRaastReceiptTx(tx: Tx, input: RecordRaastReceiptInput): Promise<RecordedRaastReceipt> {
  const { order, payment } = input
  const tenantId = order.tenantId
  const now = connectorNow()
  const at = input.at ?? now
  const intentId = input.intentId ?? null
  const smsAlertId = input.smsAlertId ?? null
  const viaSms = input.via === 'sms'

  await assertRaastRefFreeTx(tx, tenantId, input.bankRef, intentId)

  let receiptId: string
  if (intentId) {
    await assertRaastIntentUsableTx(tx, {
      intentId, tenantId, orderId: order.id, amountCents: payment.amountCents, tipCents: input.tipCents,
      targetPaymentId: input.targetPaymentId ?? null, smsAlertId,
    })
    // Conditional claim (M2/M3): still claimable, and either no SMS holds a
    // live lease on it or the lease is this SMS's own.
    const claimed = await tx.raastReceipt.updateMany({
      where: {
        id: intentId, tenantId, orderId: order.id,
        OR: [
          { status: { in: [...CLAIMABLE] }, settlingUntil: null },
          { status: { in: [...CLAIMABLE] }, settlingUntil: { lte: now } },
          ...(smsAlertId ? [{ status: { in: [...CLAIMABLE] }, smsAlertId }] : []),
        ],
      },
      data: {
        status: 'provisional',
        paymentId: payment.id,
        shiftId: input.shiftId,
        bankRef: input.bankRef,
        bankRefRaw: input.bankRefRaw,
        confirmedVia: input.via,
        confirmedAt: now,
        confirmedById: input.actorId,
        cashierVerified: input.cashierVerified,
        // The SMS that settles it, or none (a lease that ran out is released).
        smsAlertId,
        smsConfirmedAt: viaSms ? now : null,
        settlingUntil: null,
        attentionReason: null,
      },
    })
    if (claimed.count === 0) {
      const cur = await tx.raastReceipt.findUnique({ where: { id: intentId }, select: { status: true, settlingUntil: true } })
      if (cur && (CLAIMABLE as readonly string[]).includes(cur.status) && !!cur.settlingUntil && cur.settlingUntil.getTime() > now.getTime()) {
        throw intentSettling()
      }
      throw intentGone(cur?.status ?? 'gone')
    }
    receiptId = intentId
  } else {
    const account = await resolveRaastAccount(tx, tenantId, order.conceptId)
    if (!account) {
      throw new AppError(
        'RAAST_NOT_SET_UP',
        'Raast is not set up for this brand — finance sets the receiving account in Finance → Bank accounts',
        422,
      )
    }
    const row = await tx.raastReceipt.create({
      data: {
        tenantId,
        orderId: order.id,
        conceptId: order.conceptId,
        shiftId: input.shiftId,
        targetPaymentId: input.targetPaymentId ?? null,
        paymentId: payment.id,
        bankAccountId: account.bankAccountId,
        ledgerCode: account.ledgerCode,
        amountCents: payment.amountCents,
        tipCents: input.tipCents,
        dueCents: payment.amountCents - input.tipCents,
        bankRef: input.bankRef,
        bankRefRaw: input.bankRefRaw,
        status: 'provisional',
        confirmedVia: input.via,
        confirmedAt: at,
        confirmedById: input.actorId,
        cashierVerified: input.cashierVerified,
        smsAlertId,
        smsConfirmedAt: viaSms ? now : null,
        idempotencyKey: `pay:${payment.id}`,
        ...(input.at && { createdAt: input.at }),
        createdById: input.actorId,
      },
      select: { id: true },
    })
    receiptId = row.id
  }

  // A reference typed by the cashier: never one of an older credit or another
  // account (whatever the SMS switch), then — SMS matching on — the bank SMS
  // for that reference (if it is in) must name the same money.
  if (input.via === 'cashier') {
    await assertRefNotStaleTx(tx, tenantId, receiptId, input.bankRef)
    await crossCheckSmsTx(tx, tenantId, receiptId, input.bankRef, input.actorId)
  }

  const receipt = await tx.raastReceipt.findUniqueOrThrow({ where: { id: receiptId } })
  return { ...receipt, smsConfirmed: !!receipt.smsConfirmedAt }
}

/**
 * M4 at the till (RV-FRAUD-1): a reference the cashier typed that a stored
 * bank-credit SMS of the company already carries — SMS matching on or off
 * (a counter phone forwards 'off' alerts too) — must be money that could be
 * this bill's: on the bill's own receiving account, and not from before the
 * order existed (minus the match window). An older credit (an owner transfer,
 * a supplier refund nobody dismissed) is never borrowable as a bill's
 * reference: 409 RAAST_REF_TOO_OLD. The statement pass applies the same
 * rule, so such a receipt could not clear as bank-confirmed either.
 */
async function assertRefNotStaleTx(tx: Tx, tenantId: string, receiptId: string, bankRef: string): Promise<void> {
  const { raastConnectorTx } = await import('../../connectors/raast/match.js')
  const alerts = await tx.bankSmsAlert.findMany({
    where: { tenantId, bankRef, kind: 'credit' },
    select: { occurredAt: true, receivedAt: true, bankAccountId: true },
    take: 5,
  })
  if (alerts.length === 0) return
  const receipt = await tx.raastReceipt.findUniqueOrThrow({ where: { id: receiptId }, select: { bankAccountId: true, order: { select: { createdAt: true } } } })
  const { settings } = await raastConnectorTx(tx, tenantId)
  const earliest = receipt.order.createdAt.getTime() - settings.matchWindowMin * 60_000
  for (const a of alerts) {
    const at = (a.occurredAt ?? a.receivedAt).getTime()
    const otherAccount = !!a.bankAccountId && a.bankAccountId !== receipt.bankAccountId
    if (at < earliest || otherAccount) {
      throw new AppError(
        'RAAST_REF_TOO_OLD',
        otherAccount
          ? 'That bank reference belongs to a transfer into a different bank account — it cannot pay this bill. Check the counter phone for this customer\'s transaction ID.'
          : 'That bank reference belongs to a transfer from before this bill — it cannot pay it. Check the counter phone for this customer\'s transaction ID.',
        409,
      )
    }
  }
}

/**
 * A reference the cashier typed, with SMS matching on (the company's raast
 * connector `enabled`, spec D5): an unlinked bank-credit SMS of the company
 * for that reference — connectors/raast/match.ts findSmsForRefTx applies the
 * M4 eligibility (credit, open status, the receipt's own bank account, not
 * older than the receipt minus the match window, not claimed "not a sale") —
 * confirms the receipt (linkAlertTx: smsAlertId + smsConfirmedAt) when it
 * names the same money (within the 2-paisa tender tolerance), and refuses the
 * payment when it names different money (422 RAAST_AMOUNT_MISMATCH: the
 * cashier typed someone else's reference, or the customer sent the wrong
 * amount). An SMS that is settling ANOTHER bill right now (it holds a live
 * lease on that bill's intent) is that customer's payment: 409
 * RAAST_SMS_IN_USE (raised by findSmsForRefTx), never moved onto this bill. No SMS yet → the receipt
 * stays unconfirmed (the engine flags it after smsConfirmMin, and confirms it
 * when the SMS arrives).
 */
async function crossCheckSmsTx(tx: Tx, tenantId: string, receiptId: string, bankRef: string, actorId: string): Promise<void> {
  const { raastConnectorTx, findSmsForRefTx, linkAlertTx } = await import('../../connectors/raast/match.js')
  if (!(await raastConnectorTx(tx, tenantId)).enabled) return
  const receipt = await tx.raastReceipt.findUniqueOrThrow({
    where: { id: receiptId },
    select: { id: true, amountCents: true, bankAccountId: true, createdAt: true, smsAlertId: true },
  })
  if (receipt.smsAlertId) return
  const alert = await findSmsForRefTx(tx, tenantId, bankRef, { bankAccountId: receipt.bankAccountId, createdAt: receipt.createdAt, id: receipt.id })
  if (!alert) return
  if (Math.abs(alert.amountCents - receipt.amountCents) > TENDER_ROUNDING_CENTS) {
    throw new AppError(
      'RAAST_AMOUNT_MISMATCH',
      `The bank SMS for that reference says PKR ${(alert.amountCents / 100).toFixed(2)}, not PKR ${(receipt.amountCents / 100).toFixed(2)} — check the reference and the amount on the counter phone`,
      422,
      { smsAmountCents: alert.amountCents, amountCents: receipt.amountCents },
    )
  }
  // An SMS holding a live lease on another bill's intent never gets here:
  // findSmsForRefTx answers 409 RAAST_SMS_IN_USE for it (every caller).
  await linkAlertTx(tx, alert.id, receipt.id, 'confirmed', actorId)
}

/** The till's view of a recorded Raast receipt (POST /pos/payments, settles). */
export function raastTenderView(r: Pick<RaastReceipt, 'id' | 'status' | 'bankRef' | 'confirmedVia' | 'smsConfirmedAt' | 'paymentId'>) {
  return {
    receiptId: r.id,
    paymentId: r.paymentId,
    status: r.status,
    bankRef: r.bankRef,
    confirmedVia: r.confirmedVia,
    smsConfirmed: !!r.smsConfirmedAt,
  }
}

// ─── Refunds ─────────────────────────────────────────────────────────────────

/**
 * Which of the order's Raast receipts a Raast refund of `amountCents` goes
 * back against, under the order lock: a receipt that is still the company's
 * money (provisional or matched — never one written off as unreceived), the
 * one with the most left (its amount less the Raast refunds already
 * attributed to it through gatewayMeta.raast.receiptId). One refund never
 * spans two receipts: more than any single receipt's remainder → 422
 * RAAST_REFUND_SPLIT (refund it in parts). The refund row carries the
 * receipt's bank account and ledger code (refundCreditAccount → that bank).
 */
export async function chooseRaastRefundSourceTx(tx: Tx, orderId: string, amountCents: number): Promise<RaastRefundSource> {
  const receipts = await tx.raastReceipt.findMany({
    where: { orderId, status: { in: ['provisional', 'matched'] }, paymentId: { not: null } },
    select: { id: true, bankAccountId: true, ledgerCode: true, amountCents: true },
    orderBy: { createdAt: 'asc' },
  })
  if (receipts.length === 0) {
    throw new AppError(
      'RAAST_REFUND_NO_RECEIPT',
      'No Raast payment on this bill can be sent back by Raast (a Raast payment written off as never received is not refunded by Raast)',
      422,
    )
  }
  const refunds = await tx.payment.findMany({
    where: { orderId, status: 'refunded', method: 'raast' },
    select: { amountCents: true, gatewayMeta: true },
  })
  const back = new Map<string, number>()
  for (const r of refunds) {
    const id = raastMetaOf(r.gatewayMeta)?.receiptId
    if (id) back.set(id, (back.get(id) ?? 0) + Math.abs(r.amountCents))
  }
  let best: { r: (typeof receipts)[number]; left: number } | null = null
  for (const r of receipts) {
    const left = r.amountCents - (back.get(r.id) ?? 0)
    if (!best || left > best.left) best = { r, left }
  }
  if (!best || amountCents > best.left) {
    const maxCents = Math.max(0, best?.left ?? 0)
    throw new AppError(
      'RAAST_REFUND_SPLIT',
      maxCents > 0
        ? `At most PKR ${(maxCents / 100).toFixed(2)} can go back against one Raast payment on this bill — refund it in parts`
        : 'The Raast payments on this bill have already been sent back',
      422,
      { maxCents },
    )
  }
  return { receiptId: best.r.id, bankAccountId: best.r.bankAccountId, ledgerCode: best.r.ledgerCode }
}

// ─── Settled another way (S6) ────────────────────────────────────────────────

/**
 * The order is now fully paid. A Raast receipt of it that still needs
 * attention (an SMS that could not complete it — wrong amount, the bill
 * changed) is a customer transfer with no bill behind it: finance either
 * refunds it or attaches it. Raised (or refreshed) for finance through the
 * Raast engine's one attention flag. Inside the settle's transaction.
 */
export async function flagRaastSettledOtherwiseTx(tx: Tx, orderId: string): Promise<void> {
  const rows = await tx.raastReceipt.findMany({
    where: { orderId, status: 'needs_attention' },
    select: { id: true, tenantId: true, amountCents: true },
  })
  if (rows.length === 0) return
  const { raiseRaastAttentionTx } = await import('../../connectors/raast/match.js')
  const ref = orderRefOf(orderId)
  for (const r of rows) {
    await raiseRaastAttentionTx(tx, {
      tenantId: r.tenantId,
      receiptId: r.id,
      reason: 'settled_otherwise',
      message: `Bill #${ref} was settled another way; the customer's Raast transfer of PKR ${(r.amountCents / 100).toFixed(2)} is to be refunded or attached`,
    })
  }
}

/**
 * Pending payment rows are about to be deleted (a re-split, a void that clears
 * the split): a Raast receipt that pointed at one of them no longer has a
 * portion to settle (S6). Live receipts never point at a deleted row — an
 * awaiting intent blocks the re-split / void (the active-tender guard), and a
 * paid portion is not pending.
 */
export async function releaseRaastTargetsTx(tx: Tx, paymentIds: string[]): Promise<void> {
  if (paymentIds.length === 0) return
  await tx.raastReceipt.updateMany({ where: { targetPaymentId: { in: paymentIds } }, data: { targetPaymentId: null } })
}
