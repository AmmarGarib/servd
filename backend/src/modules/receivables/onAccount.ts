// On-account clients — the core rules every on-account path shares (the till's
// charge, refunds, statements, the client screens, the daily worker).
//
// A named corporate client (CustomerAccount, per company) runs a tab: each
// bill charged at the till is a CustomerAccountCharge (per ticket, INT4);
// finance bills the BOOKED charges on a monthly statement (ReceivableInvoice
// kind 'statement'), settled like any invoice.
//
// What a client owes right now (exposure) = unbilled charges net of refunds
// + what its open / part-paid invoices and statements still owe. A new charge
// must fit under the credit limit, and nothing is charged while any of the
// client's bills is past its due day plus the grace days (Karachi days).
//
// LOCK ORDER (every path, so two writers never deadlock):
//     order → client account (lockAccountTx) → invoice / statement (lockInvoice)
//
// Parked behind a switch: on-account needs the company's till clearing split
// off 1110 first (accounting/tillClearingCode.ts — the CEO's cut-over), so
// assertChargeableTx refuses every charge (409 TILL_CLEARING_NOT_SPLIT) until
// that company is cut over. Nothing here posts to the ledger.

import type { CustomerAccount, CustomerAccountCharge, Prisma, PrismaClient, UserRole } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { karachiDay } from '../../connectors/util.js'
import { tillClearingCutoverAt } from '../accounting/tillClearingCode.js'
import { LIVE_KINDS, balanceOf, lockInvoice, restatus } from './ledger.js'

type Tx = Prisma.TransactionClient
type Db = PrismaClient | Tx

/** Who may create / edit clients, cards and limits (a limit increase still waits for the CEO). */
export const CLIENT_EDITORS: UserRole[] = ['admin', 'owner', 'management', 'finance']
/** Who may see clients (NTNs, limits, exposure). */
export const CLIENT_VIEWERS: UserRole[] = ['admin', 'owner', 'management', 'finance']

/** Every refusal an on-account path can give: code → the message shown. */
export const ON_ACCOUNT_ERRORS = {
  TILL_CLEARING_NOT_SPLIT: 'On-account billing is not switched on for this company yet — till clearing must be split off customer receivables first',
  ON_ACCOUNT_NOT_ACTIVE: 'This client account is not active',
  ON_ACCOUNT_BRAND_NOT_ALLOWED: 'This client may not be billed on account at this brand',
  ON_ACCOUNT_OVERDUE: 'This client has an overdue bill — take payment another way until it is settled',
  ON_ACCOUNT_OVER_LIMIT: 'This bill would take the client over its credit limit',
  ON_ACCOUNT_REFERENCE_REQUIRED: 'This client requires a reference (PO number or who signed) on every bill',
} as const
export type OnAccountErrorCode = keyof typeof ON_ACCOUNT_ERRORS

const refuse = (code: OnAccountErrorCode, status: number, details?: unknown): AppError =>
  new AppError(code, ON_ACCOUNT_ERRORS[code], status, details)

const DAY = 86_400_000

/** Lock the client account row for the rest of `tx` and read it fresh (see LOCK ORDER above). */
export async function lockAccountTx(tx: Tx, id: string): Promise<CustomerAccount> {
  await tx.$queryRaw`SELECT id FROM customer_accounts WHERE id = ${id} FOR UPDATE`
  return tx.customerAccount.findUniqueOrThrow({ where: { id } })
}

/** A charge's value after refunds. */
export function chargeNetCents(c: Pick<CustomerAccountCharge, 'amountCents' | 'refundedCents'>): number {
  return c.amountCents - c.refundedCents
}

/**
 * Is the charge's sale in the ledger yet (only booked charges may go on a
 * statement — otherwise a statement could be paid, Cr 1110, before 1110 was
 * debited)? A till (POS) order is booked by its drawer's close
 * ('shift.close:<payment.shiftId>'); any other order by 'order.complete:<orderId>'.
 * Read in the CHARGE's company only.
 */
export async function isChargeBookedTx(
  db: Db,
  charge: Pick<CustomerAccountCharge, 'tenantId' | 'orderId' | 'paymentId'>,
): Promise<boolean> {
  const [order, payment] = await Promise.all([
    db.order.findUnique({ where: { id: charge.orderId }, select: { source: true } }),
    db.payment.findUnique({ where: { id: charge.paymentId }, select: { shiftId: true } }),
  ])
  if (!order) return false
  let reference: string
  if (order.source === 'pos') {
    if (!payment?.shiftId) return false
    reference = `shift.close:${payment.shiftId}`
  } else {
    reference = `order.complete:${charge.orderId}`
  }
  const entry = await db.journalEntry.findFirst({ where: { tenantId: charge.tenantId, reference }, select: { id: true } })
  return !!entry
}

export interface OverdueBill {
  invoiceId: string
  number: string
  kind: string
  /** YYYY-MM-DD (Karachi). */
  dueDate: string
  balanceCents: number
}

export interface Exposure {
  /** Σ (amount − refunded) of charges not yet on a statement. */
  unbilledCents: number
  /** Σ max(0, balance) of the client's open / part-paid invoices and statements. */
  invoicesDueCents: number
  exposureCents: number
  /** The earliest-due bill past its due day + the client's grace days, or null. */
  overdue: OverdueBill | null
}

/** YYYY-MM-DD + n days. */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
}

/**
 * What the client owes right now, in the CLIENT's company only (another
 * company's invoices never count, even with the same customerAccountId).
 * A bill is overdue when its Karachi due day + overdueGraceDays is before
 * today's Karachi day.
 */
export async function exposureOfTx(db: Db, accountId: string, now: Date = new Date()): Promise<Exposure> {
  const account = await db.customerAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { tenantId: true, overdueGraceDays: true },
  })
  const [unbilled, bills] = await Promise.all([
    db.customerAccountCharge.aggregate({
      where: { tenantId: account.tenantId, accountId, statementInvoiceId: null },
      _sum: { amountCents: true, refundedCents: true },
    }),
    db.receivableInvoice.findMany({
      where: { tenantId: account.tenantId, customerAccountId: accountId, kind: { in: [...LIVE_KINDS] }, status: { in: ['open', 'partial'] } },
      orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
    }),
  ])
  const unbilledCents = (unbilled._sum.amountCents ?? 0) - (unbilled._sum.refundedCents ?? 0)
  const today = karachiDay(now)
  let invoicesDueCents = 0
  let overdue: OverdueBill | null = null
  for (const b of bills) {
    const balance = balanceOf(b)
    if (balance <= 0) continue
    invoicesDueCents += balance
    const due = karachiDay(b.dueDate)
    if (!overdue && addDays(due, account.overdueGraceDays) < today) {
      overdue = { invoiceId: b.id, number: b.number, kind: b.kind, dueDate: due, balanceCents: balance }
    }
  }
  return { unbilledCents, invoicesDueCents, exposureCents: unbilledCents + invoicesDueCents, overdue }
}

/**
 * Refuse a charge the client may not take, in this order:
 *   409 TILL_CLEARING_NOT_SPLIT (the company is not cut over to 1115)
 *   409 ON_ACCOUNT_NOT_ACTIVE
 *   409 ON_ACCOUNT_BRAND_NOT_ALLOWED (conceptIds set and this brand not in it)
 *   409 ON_ACCOUNT_OVERDUE {statementNumber, dueDate, balanceCents}
 *   409 ON_ACCOUNT_OVER_LIMIT {limitCents, exposureCents, availableCents, billCents}
 *   422 ON_ACCOUNT_REFERENCE_REQUIRED
 * Call with the account LOCKED (lockAccountTx) so two tills cannot both fit
 * under the same headroom. Returns the exposure before this bill.
 */
export async function assertChargeableTx(
  tx: Tx,
  account: CustomerAccount,
  input: { conceptId: string; billCents: number; reference?: string | null },
  now: Date = new Date(),
): Promise<Exposure> {
  if (!(await tillClearingCutoverAt(tx, account.tenantId))) throw refuse('TILL_CLEARING_NOT_SPLIT', 409)
  if (account.status !== 'active') throw refuse('ON_ACCOUNT_NOT_ACTIVE', 409, { status: account.status })
  if (account.conceptIds.length > 0 && !account.conceptIds.includes(input.conceptId)) throw refuse('ON_ACCOUNT_BRAND_NOT_ALLOWED', 409)
  const exposure = await exposureOfTx(tx, account.id, now)
  if (exposure.overdue) {
    throw refuse('ON_ACCOUNT_OVERDUE', 409, {
      statementNumber: exposure.overdue.number,
      dueDate: exposure.overdue.dueDate,
      balanceCents: exposure.overdue.balanceCents,
    })
  }
  const limitCents = toCents(account.creditLimitCents)
  if (exposure.exposureCents + input.billCents > limitCents) {
    throw refuse('ON_ACCOUNT_OVER_LIMIT', 409, {
      limitCents,
      exposureCents: exposure.exposureCents,
      availableCents: Math.max(0, limitCents - exposure.exposureCents),
      billCents: input.billCents,
    })
  }
  if (account.requiresReference && !input.reference?.trim()) throw refuse('ON_ACCOUNT_REFERENCE_REQUIRED', 422)
  return exposure
}

/**
 * Record one on-account bill, in the CLIENT's company, and mark the card used.
 * The caller has already passed assertChargeableTx with the account locked.
 */
export async function recordChargeTx(
  tx: Tx,
  input: {
    account: Pick<CustomerAccount, 'id' | 'tenantId'>
    cardId?: string | null
    orderId: string
    paymentId: string
    conceptId: string
    shiftId?: string | null
    amountCents: number
    taxCents?: number
    reference?: string | null
    chargedById: string
    chargedAt?: Date
  },
): Promise<CustomerAccountCharge> {
  const chargedAt = input.chargedAt ?? new Date()
  const charge = await tx.customerAccountCharge.create({
    data: {
      tenantId: input.account.tenantId,
      accountId: input.account.id,
      cardId: input.cardId ?? null,
      orderId: input.orderId,
      paymentId: input.paymentId,
      conceptId: input.conceptId,
      shiftId: input.shiftId ?? null,
      amountCents: input.amountCents,
      taxCents: input.taxCents ?? 0,
      reference: input.reference?.trim() || null,
      chargedById: input.chargedById,
      chargedAt,
    },
  })
  if (input.cardId) {
    await tx.customerAccountCard.updateMany({
      where: { id: input.cardId, accountId: input.account.id, tenantId: input.account.tenantId },
      data: { lastUsedAt: chargedAt },
    })
  }
  return charge
}

export interface ChargeRefundResult {
  /** Cents added to the charge's refundedCents by THIS call (0 on a repeat or no charge). */
  appliedCents: number
  chargeId: string | null
  statementInvoiceId: string | null
  /** True when this refund payment had already been applied. */
  alreadyApplied: boolean
}

/**
 * A refund on an order that was charged on account: add min(amount, net) to
 * the charge's refundedCents and, when the charge is already on a statement,
 * credit the statement (creditedCents) and re-status it. A no-op when the
 * order has no charge. Idempotent per refund payment: the marker
 * Payment.gatewayMeta.onAccountApplied on the refund row.
 * Lock order: (the caller holds the order) → account → refund payment → statement.
 */
export async function applyChargeRefundTx(
  tx: Tx,
  input: { orderId: string; refundPaymentId: string; amountCents: number },
): Promise<ChargeRefundResult> {
  const found = await tx.customerAccountCharge.findFirst({ where: { orderId: input.orderId }, select: { id: true, accountId: true } })
  if (!found) return { appliedCents: 0, chargeId: null, statementInvoiceId: null, alreadyApplied: false }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new AppError('INVALID_AMOUNT', 'A refund applied to an on-account charge must be a positive whole number of paisa', 422)
  }

  await lockAccountTx(tx, found.accountId)
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${input.refundPaymentId} FOR UPDATE`
  const payment = await tx.payment.findUnique({ where: { id: input.refundPaymentId }, select: { id: true, orderId: true, gatewayMeta: true } })
  if (!payment || payment.orderId !== input.orderId) {
    throw new AppError('REFUND_PAYMENT_MISMATCH', 'The refund row does not belong to this order', 409)
  }
  const meta = (payment.gatewayMeta && typeof payment.gatewayMeta === 'object' && !Array.isArray(payment.gatewayMeta))
    ? (payment.gatewayMeta as Record<string, unknown>)
    : {}
  const prior = meta.onAccountApplied as { chargeId?: string; cents?: number; statementInvoiceId?: string | null } | undefined
  if (prior) {
    return { appliedCents: 0, chargeId: prior.chargeId ?? found.id, statementInvoiceId: prior.statementInvoiceId ?? null, alreadyApplied: true }
  }

  const charge = await tx.customerAccountCharge.findUniqueOrThrow({ where: { id: found.id } })
  const add = Math.max(0, Math.min(input.amountCents, chargeNetCents(charge)))
  if (add > 0) {
    // Conditional: never past the charge's amount, whatever ran in between.
    const moved = await tx.customerAccountCharge.updateMany({
      where: { id: charge.id, refundedCents: { lte: charge.amountCents - add } },
      data: { refundedCents: { increment: add } },
    })
    if (moved.count !== 1) throw new AppError('CHARGE_CHANGED', 'The on-account charge changed while refunding — try again', 409)
  }

  let statementInvoiceId: string | null = null
  if (add > 0 && charge.statementInvoiceId) {
    const inv = await lockInvoice(tx, charge.statementInvoiceId)
    if (inv.tenantId === charge.tenantId && inv.status !== 'void') {
      await tx.receivableInvoice.update({ where: { id: inv.id }, data: { creditedCents: { increment: add } } })
      await restatus(tx, inv.id)
      statementInvoiceId = inv.id
    }
  }

  const marker = { chargeId: charge.id, cents: add, statementInvoiceId, at: new Date().toISOString() }
  await tx.payment.update({
    where: { id: payment.id },
    data: { gatewayMeta: { ...meta, onAccountApplied: marker } as Prisma.InputJsonValue },
  })
  return { appliedCents: add, chargeId: charge.id, statementInvoiceId, alreadyApplied: false }
}
