// Raast QR at the till — intents, bank alerts, attach / dismiss (spec §6.6).
//
// With bank-SMS matching ON the cashier puts the bill up for Raast: an
// INTENT (RaastReceipt 'awaiting', amount = due + tip, expires after
// intentTtlMin) that the matching bank SMS settles by itself — or the cashier
// confirms by hand after checking the COUNTER phone (never the customer's
// screen) and typing the bank reference. While an intent waits nothing else
// may settle the bill (connectors/terminal/guard.ts). With SMS matching OFF
// the till takes Raast straight through POST /pos/payments (reference +
// "I saw it arrive" tick) — no intent.
//
// Company scope: the order, the drawer, the intent and the alert are each
// resolved through the operator's companies first (foreign → 404); the drawer
// must be an OPEN shift of the ORDER's company (422). Every write takes
// lockRaastTx first (M2), then the order lock.

import { randomBytes } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { Prisma, type RaastReceipt } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { emitTill } from '../../lib/ws.js'
import { toCents } from '../../lib/money.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { KEENU_QR_RETIRED } from '../../lib/tenders.js'
import { scopeTenantWhere, assertShiftOf, assertConceptOwned, shiftWhere, shiftTenantId, SHIFT_COMPANY_INCLUDE } from '../../lib/tenantScope.js'
import { MANAGERS } from '../../modules/auth/middleware.js'
import {
  processPayment, settlePayment, lockOrderTx, quoteOrderForTender, assertDrawerOperator, requireManagerApproval, assertAmountsFit,
  type ProcessPaymentInput, type SettleInput,
} from '../../modules/pos/service.js'
import { fiscalViewForOrder, type FiscalView } from '../fiscal/view.js'
import { connectorNow } from '../registry.js'
import { assertNoActiveTerminalChargeTx } from '../terminal/guard.js'
import { lockRaastTx } from './lock.js'
import { resolveRaastAccount } from './accounts.js'
import { cleanBankRef } from './reference.js'
import {
  raastConnectorTx, matchOnIntentCreated, possibleEarlierPayments, settleClaimed, leaseIntentForAlertTx, creditOfAlert, linkAlertTx,
  assertRefNotClaimedTx, resolveRaastFlagsTx, isUniqueViolation, RAAST_TOLERANCE_CENTS, OPEN_ALERT_STATUSES, PAID_RECEIPT_STATUSES,
  type EarlierPayment,
} from './match.js'

type Tx = Prisma.TransactionClient
const TX_OPTS = { maxWait: 10_000, timeout: 15_000 } as const

/** The rule every Raast screen at the till repeats (D9). */
export const RAAST_COUNTER_WARNING =
  'Check the money on the counter phone (bank SMS / merchant app). Never accept the customer\'s phone screen or a screenshot — fake payment screens are common.'
/** S5: the old Keenu QR standees may still be on counters after the cutover. */
export const KEENU_QR_CUTOVER_NOTE = 'A payment made to the old Keenu QR is recorded as Card – Keenu.'

const isManager = (role: string) => (MANAGERS as readonly string[]).includes(role)
const within = (a: number, b: number) => Math.abs(a - b) <= RAAST_TOLERANCE_CENTS

function actorOf(req: FastifyRequest): { id: string; role: string; tenantId: string | null; email: string | null } {
  const su = req.staffUser
  if (!su) throw new ForbiddenError('Sign in first')
  return { id: su.id, role: su.role, tenantId: su.tenantId, email: su.email }
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface RaastConfigView {
  available: boolean
  reason: null | 'NOT_SET_UP'
  account: { bankName: string | null; accountTitle: string | null; raastId: string | null; last4: string | null } | null
  smsMatching: boolean
  intentTtlMin: number
  refRule: { min: number; max: number }
  warning: string
  keenuQrNote: string
}

/** GET /pos/raast/config?shiftId&conceptId — the receiving account for this brand at this drawer's company. */
export async function raastConfigForShift(req: FastifyRequest, q: { shiftId: string; conceptId?: string }): Promise<RaastConfigView> {
  const shift = await prisma.shift.findFirst({ where: { id: q.shiftId, ...(await shiftWhere(req, 'write')) }, include: SHIFT_COMPANY_INCLUDE })
  if (!shift) throw new NotFoundError('Shift', q.shiftId)
  const tenantId = shiftTenantId(shift)
  if (!tenantId) throw new NotFoundError('Shift', q.shiftId)
  let conceptId = q.conceptId
  if (conceptId) {
    const c = await assertConceptOwned(req, conceptId, 'write')
    if (c.tenantId !== tenantId) throw new NotFoundError('Concept', conceptId)
  } else {
    const first = await prisma.concept.findFirst({ where: { tenantId, deletedAt: null, isActive: true }, select: { id: true }, orderBy: { name: 'asc' } })
    conceptId = first?.id
  }
  const account = conceptId ? await resolveRaastAccount(prisma, tenantId, conceptId) : null
  const state = await raastConnectorTx(prisma, tenantId)
  return {
    available: !!account,
    reason: account ? null : 'NOT_SET_UP',
    account: account ? { bankName: account.bankName, accountTitle: account.accountTitle, raastId: account.raastId, last4: account.last4 } : null,
    smsMatching: state.enabled,
    intentTtlMin: state.settings.intentTtlMin,
    refRule: { min: state.settings.refMinLength, max: state.settings.refMaxLength },
    warning: RAAST_COUNTER_WARNING,
    keenuQrNote: KEENU_QR_CUTOVER_NOTE,
  }
}

// ─── Views ────────────────────────────────────────────────────────────────────

export interface RaastIntentView {
  id: string
  status: RaastReceipt['status']
  orderId: string
  orderRef: string
  amountCents: number
  tipCents: number
  dueCents: number
  expiresAt: string | null
  bankRef: string | null
  confirmedVia: RaastReceipt['confirmedVia']
  smsConfirmed: boolean
  settling: boolean
  attentionReason: string | null
  cancelReason: string | null
  targetPaymentId: string | null
  createdAt: string
  possibleEarlier: EarlierPayment[]
  fiscal: FiscalView | null
}

export async function intentView(r: RaastReceipt, opts: { staff?: boolean } = {}): Promise<RaastIntentView> {
  const now = connectorNow()
  const completed = r.status === 'provisional' || r.status === 'matched'
  return {
    id: r.id,
    status: r.status,
    orderId: r.orderId,
    orderRef: orderRefOf(r.orderId),
    amountCents: r.amountCents,
    tipCents: r.tipCents,
    dueCents: r.dueCents,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    bankRef: r.bankRef,
    confirmedVia: r.confirmedVia,
    smsConfirmed: !!r.smsConfirmedAt,
    settling: !!r.settlingUntil && r.settlingUntil > now,
    attentionReason: r.attentionReason,
    cancelReason: r.cancelReason,
    targetPaymentId: r.targetPaymentId,
    createdAt: r.createdAt.toISOString(),
    possibleEarlier: r.status === 'awaiting' || r.status === 'needs_attention' ? await possibleEarlierPayments(prisma, r) : [],
    fiscal: completed ? await fiscalViewForOrder(r.orderId, 'sale', { staff: !!opts.staff }) : null,
  }
}

/** The intent if it is in the operator's companies (write scope), else 404. */
export async function intentInScope(req: FastifyRequest, id: string): Promise<RaastReceipt> {
  const r = await prisma.raastReceipt.findFirst({ where: { id, ...(await scopeTenantWhere(req, 'write')) } })
  if (!r) throw new NotFoundError('Raast payment', id)
  return r
}

function assertOwnOrManager(req: FastifyRequest, r: RaastReceipt): void {
  const a = actorOf(req)
  if (r.createdById !== a.id && !isManager(a.role)) {
    throw new AppError('NOT_YOUR_PAYMENT', 'Only the cashier who started this Raast payment, or a manager, can do that', 403)
  }
}

function emitIntent(r: Pick<RaastReceipt, 'id' | 'tenantId' | 'orderId' | 'status' | 'amountCents' | 'bankRef' | 'attentionReason' | 'cancelReason'>): void {
  emitTill(r.tenantId, 'raast:intent', {
    receiptId: r.id, orderId: r.orderId, status: r.status, amountCents: r.amountCents,
    ...(r.bankRef && { refLast4: r.bankRef.slice(-4) }),
    ...((r.attentionReason || r.cancelReason) && { reason: r.attentionReason ?? r.cancelReason }),
  })
}

// ─── The amount due by Raast ─────────────────────────────────────────────────

async function raastDueTx(tx: Tx, orderId: string, paymentId: string | null | undefined): Promise<number> {
  if (paymentId) {
    const p = await tx.payment.findFirst({ where: { id: paymentId, orderId }, select: { status: true, method: true, amountCents: true } })
    if (!p) throw new NotFoundError('Payment', paymentId)
    if (p.status !== 'pending') throw new AppError('ALREADY_PAID', 'That part of the bill is already settled', 409)
    if (p.method === 'keenu_qr') {
      throw new AppError(KEENU_QR_RETIRED.code, 'Keenu QR is retired — take the rest with Pay (cash, Card – Keenu or Raast QR)', KEENU_QR_RETIRED.status)
    }
    if (p.method !== 'raast') throw new AppError('NOT_A_RAAST_PORTION', 'Only a Raast QR part of a split bill can be paid by Raast — pay this part with its own tender', 422)
    return p.amountCents
  }
  return (await quoteOrderForTender(orderId, 'raast')).dueCents
}

// ─── Create ───────────────────────────────────────────────────────────────────

export interface CreateIntentInput {
  orderId: string
  shiftId: string
  paymentId?: string
  tipCents: number
  expectedDueCents: number
  idempotencyKey: string
}

/** POST /pos/raast/intents — 201 view | 200 replay. */
export async function createRaastIntent(req: FastifyRequest, input: CreateIntentInput): Promise<{ view: RaastIntentView; replay: boolean }> {
  const actor = actorOf(req)
  assertAmountsFit(input.tipCents, input.expectedDueCents, input.tipCents + input.expectedDueCents)
  const order = await prisma.order.findFirst({
    where: { id: input.orderId, deletedAt: null, concept: await scopeTenantWhere(req, 'write') },
    select: { id: true, conceptId: true, concept: { select: { tenantId: true } } },
  })
  if (!order || !order.concept.tenantId) throw new NotFoundError('Order', input.orderId)
  const tenantId = order.concept.tenantId
  const state = await raastConnectorTx(prisma, tenantId)
  if (!state.enabled) {
    throw new AppError('RAAST_SMS_OFF', 'Bank-SMS matching is off for this company — check the counter phone and take Raast with its reference', 409)
  }
  await assertShiftOf(tenantId, input.shiftId, true)
  await assertDrawerOperator(input.shiftId, actor)
  if (input.paymentId && input.tipCents > 0) {
    throw new AppError('INVALID_TIP', 'A tip cannot be added while settling one part of a split bill', 400)
  }

  const prior = await prisma.raastReceipt.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } } })
  if (prior) {
    if (prior.orderId !== input.orderId) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key belongs to a different request — generate a new one', 409)
    return { view: await intentView(prior), replay: true }
  }

  const now = connectorNow()
  let receipt: RaastReceipt
  let replay = false
  try {
    receipt = await prisma.$transaction(async (tx) => {
      await lockRaastTx(tx, tenantId)
      await lockOrderTx(tx, input.orderId)
      const same = await tx.raastReceipt.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } } })
      if (same) {
        if (same.orderId !== input.orderId) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key belongs to a different request — generate a new one', 409)
        replay = true
        return same
      }
      const o = await tx.order.findUniqueOrThrow({ where: { id: input.orderId }, select: { status: true } })
      if (['completed', 'cancelled', 'rejected', 'refunded'].includes(o.status)) {
        throw new AppError('ORDER_NOT_OPEN', `This order is ${o.status} — it cannot take a Raast payment`, 409)
      }
      // A card charge or another waiting Raast intent on this bill → 409.
      await assertNoActiveTerminalChargeTx(tx, input.orderId)
      const due = await raastDueTx(tx, input.orderId, input.paymentId)
      if (due <= 0) throw new AppError('ALREADY_PAID', 'Nothing is due on this order', 409)
      if (Math.abs(input.expectedDueCents - due) > RAAST_TOLERANCE_CENTS) {
        throw new AppError('AMOUNT_MISMATCH', `The bill changed: ${due} is due by Raast, not ${input.expectedDueCents} — check the amount and try again`, 409, { dueCents: due })
      }
      const account = await resolveRaastAccount(tx, tenantId, order.conceptId)
      if (!account) throw new AppError('RAAST_NOT_SET_UP', 'Raast is not set up for this brand — finance sets the receiving account in Finance → Bank accounts', 422)
      return tx.raastReceipt.create({
        data: {
          tenantId, orderId: input.orderId, conceptId: order.conceptId, shiftId: input.shiftId, targetPaymentId: input.paymentId ?? null,
          bankAccountId: account.bankAccountId, ledgerCode: account.ledgerCode,
          amountCents: due + input.tipCents, tipCents: input.tipCents, dueCents: due, status: 'awaiting',
          expiresAt: new Date(now.getTime() + state.settings.intentTtlMin * 60_000),
          idempotencyKey: input.idempotencyKey, createdById: actor.id,
        },
      })
    }, TX_OPTS)
  } catch (err) {
    if (isUniqueViolation(err)) {
      const same = await prisma.raastReceipt.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } } })
      if (same && same.orderId === input.orderId) return { view: await intentView(same), replay: true }
      const waiting = await prisma.raastReceipt.findFirst({ where: { orderId: input.orderId, status: 'awaiting' }, select: { id: true } })
      throw new AppError('RAAST_AWAITING', 'This bill is already waiting for a Raast QR transfer', 409, { receiptId: waiting?.id ?? null })
    }
    throw err
  }
  if (replay) return { view: await intentView(receipt), replay: true }

  await audit({
    category: 'identity', action: 'raast.intent.create', entity: 'RaastReceipt', entityId: receipt.id, userId: actor.id, userEmail: actor.email, tenantId,
    metadata: { orderId: receipt.orderId, amountCents: receipt.amountCents, tipCents: receipt.tipCents, shiftId: receipt.shiftId, paymentId: receipt.targetPaymentId },
  })
  emitIntent(receipt)
  // An SMS that arrived just before the intent (within the clock skew) settles
  // it now. Best effort: the intent stands either way (the SMS stays for the
  // cashier to attach).
  try {
    await matchOnIntentCreated(receipt.id)
  } catch (err) {
    console.error(`[raast] match on intent ${receipt.id} failed:`, (err as Error).message)
  }
  const fresh = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: receipt.id } })
  return { view: await intentView(fresh, { staff: isManager(actor.role) }), replay: false }
}

/** GET /pos/raast/intents?orderId&active=1 — the order's Raast payments (active = awaiting / needs_attention). */
export async function intentsForOrder(req: FastifyRequest, orderId: string, activeOnly: boolean): Promise<RaastIntentView[]> {
  const scope = await scopeTenantWhere(req, 'write')
  const order = await prisma.order.findFirst({ where: { id: orderId, concept: scope }, select: { id: true } })
  if (!order) throw new NotFoundError('Order', orderId)
  const rows = await prisma.raastReceipt.findMany({
    where: { orderId, ...scope, ...(activeOnly && { status: { in: ['awaiting', 'needs_attention'] } }) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  const staff = isManager(actorOf(req).role)
  return Promise.all(rows.map((r) => intentView(r, { staff })))
}

// ─── Confirm by hand ─────────────────────────────────────────────────────────

/** POST /pos/raast/intents/:id/confirm — the cashier saw it on the counter phone and types the reference. */
export async function confirmRaastIntent(req: FastifyRequest, id: string, body: { bankRef: string; counterVerified: true }): Promise<{ intent: RaastIntentView; payment: unknown }> {
  const actor = actorOf(req)
  const r = await intentInScope(req, id)
  assertOwnOrManager(req, r)
  if (body.counterVerified !== true) throw new AppError('RAAST_NOT_VERIFIED', 'Tick that you saw the money arrive on the counter phone', 400)
  const state = await raastConnectorTx(prisma, r.tenantId)
  const ref = cleanBankRef(body.bankRef, { orderId: r.orderId, min: state.settings.refMinLength, max: state.settings.refMaxLength })
  if ((r.status === 'provisional' || r.status === 'matched') && r.bankRef === ref) {
    return { intent: await intentView(r), payment: null }
  }
  if (r.status !== 'awaiting' && r.status !== 'needs_attention') {
    throw new AppError('RAAST_INTENT_GONE', `This Raast payment is ${r.status} — start a new one`, 409, { status: r.status })
  }
  if (!r.shiftId) throw new AppError('SHIFT_REQUIRED', 'The Raast payment has no drawer', 422)
  await assertShiftOf(r.tenantId, r.shiftId, true)
  await assertDrawerOperator(r.shiftId, actor)
  const raast = { intentId: r.id, via: 'cashier' as const, cashierVerified: true }
  let payment: unknown
  if (r.targetPaymentId) {
    const input: SettleInput = { paymentId: r.targetPaymentId, via: 'till', shiftId: r.shiftId, gatewayRef: ref, actorId: actor.id, raast }
    payment = await settlePayment(input)
  } else {
    const input: ProcessPaymentInput = {
      orderId: r.orderId, shiftId: r.shiftId, actorId: actor.id, idempotencyKey: `raast:${r.id}`,
      payments: [{ method: 'raast', amountCents: r.amountCents, tipCents: r.tipCents, gatewayRef: ref, raast }],
    }
    payment = await processPayment(input)
  }
  const fresh = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })
  emitIntent(fresh)
  await audit({
    category: 'identity', action: 'raast.intent.confirm', entity: 'RaastReceipt', entityId: r.id, userId: actor.id, userEmail: actor.email, tenantId: r.tenantId,
    metadata: { orderId: r.orderId, amountCents: r.amountCents, bankRef: ref },
  })
  return { intent: await intentView(fresh, { staff: isManager(actor.role) }), payment }
}

// ─── Cancel / expire ─────────────────────────────────────────────────────────

/** POST /pos/raast/intents/:id/cancel — own intent or a manager; awaiting only. */
export async function cancelRaastIntent(req: FastifyRequest, id: string, reason?: string): Promise<RaastIntentView> {
  const actor = actorOf(req)
  const r = await intentInScope(req, id)
  assertOwnOrManager(req, r)
  const now = connectorNow()
  const out = await prisma.$transaction(async (tx) => {
    await lockRaastTx(tx, r.tenantId)
    const c = await tx.raastReceipt.updateMany({
      where: { id: r.id, status: 'awaiting', OR: [{ settlingUntil: null }, { settlingUntil: { lt: now } }] },
      data: { status: 'cancelled', cancelReason: (reason?.trim() || 'cancelled_by_cashier').slice(0, 200), expiresAt: null, settlingUntil: null, smsAlertId: null },
    })
    const fresh = await tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })
    if (c.count === 0) {
      if (fresh.status === 'cancelled') return fresh
      if (fresh.status === 'awaiting') throw new AppError('RAAST_SETTLING', 'A bank SMS is completing this bill right now — wait a moment', 409)
      throw new AppError('NOT_AWAITING', `This Raast payment is ${fresh.status} — it cannot be cancelled`, 409, { status: fresh.status })
    }
    return fresh
  }, TX_OPTS)
  emitIntent(out)
  await audit({
    category: 'identity', action: 'raast.intent.cancel', entity: 'RaastReceipt', entityId: r.id, userId: actor.id, userEmail: actor.email, tenantId: r.tenantId,
    metadata: { orderId: r.orderId, amountCents: r.amountCents, reason: reason ?? null },
  })
  return intentView(out)
}

/** The worker: awaiting intents past expiresAt → cancelled 'expired' (never one an SMS is settling). */
export async function expireRaastIntents(limit = 200): Promise<number> {
  const now = connectorNow()
  const due = await prisma.raastReceipt.findMany({ where: { status: 'awaiting', expiresAt: { lt: now } }, select: { id: true, tenantId: true }, take: limit })
  let n = 0
  for (const d of due) {
    const r = await prisma.$transaction(async (tx) => {
      await lockRaastTx(tx, d.tenantId)
      const c = await tx.raastReceipt.updateMany({
        where: { id: d.id, status: 'awaiting', expiresAt: { lt: now }, OR: [{ settlingUntil: null }, { settlingUntil: { lt: now } }] },
        data: { status: 'cancelled', cancelReason: 'expired', settlingUntil: null, smsAlertId: null },
      })
      return c.count === 1 ? tx.raastReceipt.findUnique({ where: { id: d.id } }) : null
    }, TX_OPTS)
    if (r) { n++; emitIntent(r) }
  }
  return n
}

// ─── Bank alerts at the till ─────────────────────────────────────────────────

export interface TillAlertView {
  id: string
  status: string
  amountCents: number
  bankRef: string | null
  occurredAt: string | null
  payer: string | null
  bankAccount: { name: string; last4: string | null } | null
  /** paymentId = the split portion the waiting request is for (null = the whole bill), sent back on attach. */
  candidates: Array<{ receiptId: string; orderId: string; orderRef: string; amountCents: number; createdAt: string; paymentId: string | null }>
}

/** GET /pos/raast/alerts?shiftId — the shift's company's open bank alerts (its outlet's devices, or any with no outlet), last 48 h. */
export async function raastAlertsForShift(req: FastifyRequest, shiftId: string): Promise<TillAlertView[]> {
  const shift = await prisma.shift.findFirst({ where: { id: shiftId, ...(await shiftWhere(req, 'write')) }, include: SHIFT_COMPANY_INCLUDE })
  if (!shift) throw new NotFoundError('Shift', shiftId)
  const tenantId = shiftTenantId(shift)
  if (!tenantId) throw new NotFoundError('Shift', shiftId)
  const since = new Date(connectorNow().getTime() - 48 * 3_600_000)
  const rows = await prisma.bankSmsAlert.findMany({
    where: {
      tenantId, kind: 'credit', status: { in: ['unmatched', 'ambiguous', 'needs_attention'] }, receivedAt: { gte: since },
      ...(shift.locationId && { OR: [{ locationId: null }, { locationId: shift.locationId }] }),
    },
    orderBy: { receivedAt: 'desc' },
    take: 50,
  })
  const accountIds = [...new Set(rows.map((a) => a.bankAccountId).filter((x): x is string => !!x))]
  const accounts = await prisma.bankAccount.findMany({ where: { id: { in: accountIds }, tenantId }, select: { id: true, name: true, accountNumber: true, iban: true } })
  const accById = new Map(accounts.map((a) => [a.id, a]))
  const candIds = [...new Set(rows.flatMap((a) => a.candidateIds))]
  const cands = await prisma.raastReceipt.findMany({ where: { id: { in: candIds }, tenantId }, select: { id: true, orderId: true, amountCents: true, createdAt: true, targetPaymentId: true } })
  const candById = new Map(cands.map((c) => [c.id, c]))
  return rows.map((a) => {
    const acc = a.bankAccountId ? accById.get(a.bankAccountId) : undefined
    const digits = String(acc?.accountNumber ?? acc?.iban ?? '').replace(/[^0-9A-Za-z]/g, '')
    return {
      id: a.id,
      status: a.status,
      amountCents: toCents(a.amountCents) ?? 0,
      bankRef: a.bankRef,
      occurredAt: a.occurredAt?.toISOString() ?? null,
      payer: a.payer,
      bankAccount: acc ? { name: acc.name, last4: digits ? digits.slice(-4) : null } : null,
      candidates: a.candidateIds.map((id) => candById.get(id)).filter((c): c is NonNullable<typeof c> => !!c).map((c) => ({
        receiptId: c.id, orderId: c.orderId, orderRef: orderRefOf(c.orderId), amountCents: c.amountCents, createdAt: c.createdAt.toISOString(), paymentId: c.targetPaymentId,
      })),
    }
  })
}

const ATTACHABLE = ['unmatched', 'ambiguous', 'needs_attention'] as const

/** An alert in a still-open status that is not linked to a paid receipt (under the lock). */
async function openAlertTx(tx: Tx, alertId: string, tenantId: string) {
  const a = await tx.bankSmsAlert.findFirst({ where: { id: alertId, tenantId }, include: { receipt: { select: { id: true, status: true, orderId: true } } } })
  if (!a) throw new NotFoundError('Bank alert', alertId)
  if (a.kind !== 'credit' || !a.bankRef || !(ATTACHABLE as readonly string[]).includes(a.status)) {
    throw new AppError('RAAST_ALERT_NOT_OPEN', `This bank alert is ${a.status} — it cannot be used now`, 409, { status: a.status })
  }
  if (a.receipt && PAID_RECEIPT_STATUSES.includes(a.receipt.status)) {
    throw new AppError('RAAST_SMS_ALREADY_USED', `That bank SMS already paid bill #${orderRefOf(a.receipt.orderId)}`, 409)
  }
  return a
}

/**
 * POST /pos/raast/alerts/:id/attach {orderId, shiftId, paymentId?} — pay a
 * bill with a bank credit no intent claimed (the SMS is the evidence; the
 * cashier is the actor). The alert's account must be the bill's Raast
 * account and its amount the bill's due (or the portion / the waiting
 * intent's amount).
 */
export async function attachRaastAlert(req: FastifyRequest, alertId: string, body: { orderId: string; shiftId: string; paymentId?: string }): Promise<{ outcome: string; intent: RaastIntentView }> {
  const actor = actorOf(req)
  const shift = await prisma.shift.findFirst({ where: { id: body.shiftId, ...(await shiftWhere(req, 'write')) }, include: SHIFT_COMPANY_INCLUDE })
  if (!shift) throw new NotFoundError('Shift', body.shiftId)
  const shiftCo = shiftTenantId(shift)
  const alert = shiftCo ? await prisma.bankSmsAlert.findFirst({ where: { id: alertId, tenantId: shiftCo } }) : null
  if (!alert || !shiftCo) throw new NotFoundError('Bank alert', alertId)
  const order = await prisma.order.findFirst({
    where: { id: body.orderId, deletedAt: null, concept: await scopeTenantWhere(req, 'write') },
    select: { id: true, conceptId: true, createdAt: true, concept: { select: { tenantId: true } } },
  })
  if (!order || !order.concept.tenantId) throw new NotFoundError('Order', body.orderId)
  const tenantId = order.concept.tenantId
  await assertShiftOf(tenantId, body.shiftId, true)
  await assertDrawerOperator(body.shiftId, actor)
  const account = await resolveRaastAccount(prisma, tenantId, order.conceptId)
  if (!account) throw new AppError('RAAST_NOT_SET_UP', 'Raast is not set up for this brand — finance sets the receiving account in Finance → Bank accounts', 422)
  if (alert.bankAccountId !== account.bankAccountId) {
    throw new AppError('RAAST_ACCOUNT_MISMATCH', 'That transfer went to a different bank account than this brand\'s Raast account — it cannot pay this bill', 422)
  }
  const state = await raastConnectorTx(prisma, tenantId)
  const smsAmount = toCents(alert.amountCents) ?? 0

  const claim = await prisma.$transaction(async (tx) => {
    await lockRaastTx(tx, tenantId)
    await lockOrderTx(tx, body.orderId)
    const a = await openAlertTx(tx, alertId, tenantId)
    await assertRefNotClaimedTx(tx, tenantId, a.bankRef!)
    const used = await tx.raastReceipt.findUnique({ where: { tenantId_bankRef: { tenantId, bankRef: a.bankRef! } }, select: { orderId: true } })
    if (used) throw new AppError('RAAST_REF_USED', `That bank reference already paid bill #${orderRefOf(used.orderId)}`, 409, { orderRef: orderRefOf(used.orderId) })
    const o = await tx.order.findUniqueOrThrow({ where: { id: body.orderId }, select: { status: true } })
    if (['completed', 'cancelled', 'rejected', 'refunded'].includes(o.status)) throw new AppError('ORDER_NOT_OPEN', `This order is ${o.status} — it cannot take a Raast payment`, 409)
    const existing = await tx.raastReceipt.findFirst({
      where: { orderId: body.orderId, tenantId, status: { in: ['awaiting', 'needs_attention'] }, ...(body.paymentId ? { targetPaymentId: body.paymentId } : { targetPaymentId: null }) },
      orderBy: { createdAt: 'desc' },
    })
    // M4 (RV-FRAUD-4): a credit from before this bill (its waiting request,
    // else the order itself) minus the match window is another customer's or
    // nobody's — an old unbooked credit never pays today's bill.
    const anchor = existing ? existing.createdAt : order.createdAt
    const nowT = connectorNow().getTime()
    if (!a.occurredAt
      || a.occurredAt.getTime() < anchor.getTime() - state.settings.matchWindowMin * 60_000
      || a.occurredAt.getTime() > nowT + state.settings.clockSkewMin * 60_000) {
      throw new AppError('RAAST_ALERT_TOO_OLD', 'That bank SMS is older than this bill — it cannot be this bill\'s payment', 422)
    }
    let receipt: RaastReceipt
    let createdForAttach = false
    if (existing) {
      if (existing.bankAccountId !== account.bankAccountId) throw new AppError('RAAST_ACCOUNT_MISMATCH', 'That transfer went to a different bank account than this bill\'s Raast payment', 422)
      if (!within(existing.amountCents, smsAmount)) {
        throw new AppError('RAAST_AMOUNT_MISMATCH', `The bank SMS is for PKR ${(smsAmount / 100).toFixed(2)} but this bill's Raast payment is PKR ${(existing.amountCents / 100).toFixed(2)}`, 422, { dueCents: existing.amountCents, smsAmountCents: smsAmount })
      }
      // The intent's own guard exception: everything else on the bill stays blocked.
      await assertNoActiveTerminalChargeTx(tx, body.orderId, null, existing.id)
      receipt = existing
    } else {
      await assertNoActiveTerminalChargeTx(tx, body.orderId)
      const due = await raastDueTx(tx, body.orderId, body.paymentId)
      if (due <= 0) throw new AppError('ALREADY_PAID', 'Nothing is due on this order', 409)
      if (!within(due, smsAmount)) {
        throw new AppError('RAAST_AMOUNT_MISMATCH', `The bank SMS is for PKR ${(smsAmount / 100).toFixed(2)} but PKR ${(due / 100).toFixed(2)} is due`, 422, { dueCents: due, smsAmountCents: smsAmount })
      }
      receipt = await tx.raastReceipt.create({
        data: {
          tenantId, orderId: body.orderId, conceptId: order.conceptId, shiftId: body.shiftId, targetPaymentId: body.paymentId ?? null,
          bankAccountId: account.bankAccountId, ledgerCode: account.ledgerCode, amountCents: due, tipCents: 0, dueCents: due, status: 'awaiting',
          expiresAt: new Date(connectorNow().getTime() + state.settings.intentTtlMin * 60_000),
          idempotencyKey: `attach:${alertId}:${randomBytes(4).toString('hex')}`, createdById: actor.id,
        },
      })
      createdForAttach = true
    }
    if (!(await leaseIntentForAlertTx(tx, receipt.id, alertId, true))) {
      throw new AppError('RAAST_SETTLING', 'A bank SMS is completing this bill right now — wait a moment', 409)
    }
    const took = await tx.bankSmsAlert.updateMany({ where: { id: alertId, status: a.status }, data: { status: 'processing' } })
    if (took.count !== 1) throw new AppError('RAAST_ALERT_NOT_OPEN', 'This bank alert changed — refresh and try again', 409)
    return {
      receipt: await tx.raastReceipt.findUniqueOrThrow({ where: { id: receipt.id } }),
      alert: a,
      prior: { alertStatus: a.status, receiptStatus: receipt.status, createdForAttach },
    }
  }, TX_OPTS)

  const outcome = await settleClaimed(claim.receipt, alertId, creditOfAlert(claim.alert), { mode: 'attach', actorId: actor.id, prior: claim.prior })
  const fresh = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: claim.receipt.id } })
  return { outcome, intent: await intentView(fresh, { staff: isManager(actor.role) }) }
}

/**
 * POST /pos/raast/alerts/:id/attach {receiptId} — a manager fixes a mistyped
 * reference: the cashier's provisional receipt (no SMS yet) takes the alert's
 * reference (and the payment's gatewayRef). Same company, same bank account,
 * same amount, SMS not older than the receipt minus matchWindowMin (M4).
 */
export async function fixReferenceFromAlert(req: FastifyRequest, alertId: string, body: { receiptId: string; managerOverridePin?: string }): Promise<RaastIntentView> {
  const actor = actorOf(req)
  const r = await intentInScope(req, body.receiptId)
  const alert = await prisma.bankSmsAlert.findFirst({ where: { id: alertId, tenantId: r.tenantId } })
  if (!alert) throw new NotFoundError('Bank alert', alertId)
  if (r.status !== 'provisional' || r.smsAlertId) {
    throw new AppError('RAAST_NOT_FIXABLE', 'Only a Raast payment the cashier recorded, with no bank SMS yet and not on a statement, can take another reference', 409)
  }
  const smsAmount = toCents(alert.amountCents) ?? 0
  if (alert.bankAccountId !== r.bankAccountId) throw new AppError('RAAST_ACCOUNT_MISMATCH', 'That transfer went to a different bank account than this bill\'s Raast payment', 422)
  if (!within(r.amountCents, smsAmount)) {
    throw new AppError('RAAST_AMOUNT_MISMATCH', `The bank SMS is for PKR ${(smsAmount / 100).toFixed(2)} but this bill's Raast payment is PKR ${(r.amountCents / 100).toFixed(2)}`, 422, { dueCents: r.amountCents, smsAmountCents: smsAmount })
  }
  const state = await raastConnectorTx(prisma, r.tenantId)
  const now = connectorNow()
  if (!alert.occurredAt || alert.occurredAt.getTime() < r.createdAt.getTime() - state.settings.matchWindowMin * 60_000 || alert.occurredAt.getTime() > now.getTime() + state.settings.clockSkewMin * 60_000) {
    throw new AppError('RAAST_ALERT_TOO_OLD', 'That bank SMS is older than this bill — it cannot be this bill\'s payment', 422)
  }
  const { approverId, viaPin } = await requireManagerApproval({
    actorId: actor.id, actorRole: actor.role, managerOverridePin: body.managerOverridePin ?? null, tenantId: r.tenantId,
    action: 'Fixing a Raast reference', orderId: r.orderId,
  })
  const before = r.bankRef
  const fresh = await prisma.$transaction(async (tx) => {
    await lockRaastTx(tx, r.tenantId)
    const a = await openAlertTx(tx, alertId, r.tenantId)
    const cur = await tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })
    if (cur.status !== 'provisional' || cur.smsAlertId) throw new AppError('RAAST_NOT_FIXABLE', 'This Raast payment changed — refresh and try again', 409)
    await assertRefNotClaimedTx(tx, r.tenantId, a.bankRef!)
    const used = await tx.raastReceipt.findUnique({ where: { tenantId_bankRef: { tenantId: r.tenantId, bankRef: a.bankRef! } }, select: { id: true, orderId: true } })
    if (used && used.id !== r.id) throw new AppError('RAAST_REF_USED', `That bank reference already paid bill #${orderRefOf(used.orderId)}`, 409, { orderRef: orderRefOf(used.orderId) })
    await tx.raastReceipt.update({ where: { id: r.id }, data: { bankRef: a.bankRef, bankRefRaw: a.bankRef } })
    if (cur.paymentId) await tx.payment.update({ where: { id: cur.paymentId }, data: { gatewayRef: a.bankRef } })
    await linkAlertTx(tx, alertId, r.id, 'attached', approverId)
    return tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })
  }, TX_OPTS)
  emitIntent(fresh)
  await audit({
    category: 'identity', action: 'raast.reference.fix', entity: 'RaastReceipt', entityId: r.id, userId: actor.id, userEmail: actor.email, tenantId: r.tenantId,
    before: { bankRef: before }, after: { bankRef: fresh.bankRef },
    metadata: { orderId: r.orderId, alertId, approverId, viaPin },
  })
  return intentView(fresh, { staff: true })
}

/**
 * POST /pos/raast/alerts/:id/dismiss {reason, managerOverridePin?} — a
 * manager marks a bank credit "not a sale" (a supplier refund, an owner
 * transfer). The money stays unbooked (finance handles the statement line)
 * and its reference is CLAIMED: it can never pay a bill (M4).
 */
export async function dismissRaastAlert(req: FastifyRequest, alertId: string, body: { reason: string; managerOverridePin?: string }): Promise<{ id: string; status: string }> {
  const actor = actorOf(req)
  const alert = await prisma.bankSmsAlert.findFirst({ where: { id: alertId, ...(await scopeTenantWhere(req, 'write')) } })
  if (!alert) throw new NotFoundError('Bank alert', alertId)
  if (!(ATTACHABLE as readonly string[]).includes(alert.status)) {
    throw new AppError('RAAST_ALERT_NOT_OPEN', `This bank alert is ${alert.status} — it cannot be dismissed`, 409, { status: alert.status })
  }
  const { approverId, viaPin } = await requireManagerApproval({
    actorId: actor.id, actorRole: actor.role, managerOverridePin: body.managerOverridePin ?? null, tenantId: alert.tenantId,
    action: 'Marking a bank transfer "not a sale"',
  })
  const now = connectorNow()
  await prisma.$transaction(async (tx) => {
    await lockRaastTx(tx, alert.tenantId)
    const a = await tx.bankSmsAlert.findFirst({ where: { id: alertId, tenantId: alert.tenantId }, include: { receipt: { select: { id: true, status: true, orderId: true } } } })
    if (!a || !(ATTACHABLE as readonly string[]).includes(a.status)) throw new AppError('RAAST_ALERT_NOT_OPEN', 'This bank alert changed — refresh and try again', 409)
    if (a.receipt && PAID_RECEIPT_STATUSES.includes(a.receipt.status)) {
      throw new AppError('RAAST_SMS_ALREADY_USED', `That bank SMS already paid bill #${orderRefOf(a.receipt.orderId)}`, 409)
    }
    let claimedRef: string | null = null
    if (a.bankRef) {
      const used = await tx.raastReceipt.findUnique({ where: { tenantId_bankRef: { tenantId: a.tenantId, bankRef: a.bankRef } }, select: { orderId: true } })
      if (used) throw new AppError('RAAST_REF_USED', `That transfer is booked as the payment of bill #${orderRefOf(used.orderId)} — it is a sale`, 409)
      const taken = await tx.bankSmsAlert.findFirst({ where: { tenantId: a.tenantId, claimedRef: a.bankRef }, select: { id: true } })
      claimedRef = taken ? null : a.bankRef
    }
    await tx.raastReceipt.updateMany({ where: { smsAlertId: alertId, status: { in: ['awaiting', 'cancelled', 'needs_attention'] } }, data: { smsAlertId: null, settlingUntil: null } })
    await tx.bankSmsAlert.update({
      where: { id: alertId },
      data: { status: 'dismissed', claimedRef, resolvedById: approverId, resolvedAt: now, resolution: `Not a sale: ${body.reason.trim()}`.slice(0, 300), candidateIds: [] },
    })
    await resolveRaastFlagsTx(tx, a.tenantId, ['raast_sms_unmatched', 'raast_needs_attention'], 'BankSmsAlert', alertId, `Dismissed as not a sale: ${body.reason.trim()}`)
  }, TX_OPTS)
  emitTill(alert.tenantId, 'raast:alert', { alertId, status: 'dismissed', amountCents: toCents(alert.amountCents) ?? 0, occurredAt: alert.occurredAt?.toISOString() ?? null, locationId: alert.locationId })
  await audit({
    category: 'identity', action: 'raast.alert.dismiss', entity: 'BankSmsAlert', entityId: alertId, userId: actor.id, userEmail: actor.email, tenantId: alert.tenantId,
    metadata: { reason: body.reason.trim(), approverId, viaPin, amountCents: toCents(alert.amountCents) ?? 0, bankRef: alert.bankRef },
  })
  return { id: alertId, status: 'dismissed' }
}

/** Open alert statuses (re-exported for the routes' docs). */
export { OPEN_ALERT_STATUSES }
