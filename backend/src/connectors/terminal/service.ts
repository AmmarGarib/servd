// The card-machine flow (spec §7, D11).
//
// The server re-quotes the bill before anything is pushed to the machine,
// persists a TerminalCharge (client idempotency key; at most one active
// charge per order — partial unique index), and the SERVER records the
// Payment on approval through the existing processPayment / settlePayment
// (idempotency key `term:<chargeId>`), so a closed browser never loses a
// charge. One forward-only state machine (applyChargeState) is fed by the
// cashier's poll, the vendor's webhook and the reconciler alike.
//
// Approved but refused by servd (bill changed, already paid, order closed)
// → automatic void / referenced refund → `needs_attention` + manager alert
// when the reversal fails. An "unknown" outcome blocks the order until the
// cashier resolves it from the machine's screen; the reconciler keeps
// verifying for 24 h either way.

import { randomBytes } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { Prisma, type TerminalCharge, type TerminalChargeStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError, ForbiddenError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { scopeTenantWhere, assertShiftOf, shiftTenantId, SHIFT_COMPANY_INCLUDE, shiftWhere } from '../../lib/tenantScope.js'
import { MANAGERS } from '../../modules/auth/middleware.js'
import {
  processPayment, settlePayment, refundOrder, lockOrderTx, quoteOrderForTender, assertDrawerOperator, assertRefundAllowed,
  inFlightTerminalRefundCents,
  type ProcessPaymentInput, type SettleInput, type RefundInput,
} from '../../modules/pos/service.js'
import type { ChargeRequest, ChargeState, ConnectorCtx, Outcome, TerminalDriver } from '../types.js'
import { buildCtx, connectorNow, getConnector, getConnectorFresh, terminalDriverOf, type LoadedConnector } from '../registry.js'
import { karachiDay, scrubMessage, withTimeout } from '../util.js'
import { alertTerminalCharge, notifyConnectorPeople } from '../alerts.js'
import { fiscalViewForOrder, toFiscalView, FISCAL_VIEW_SELECT, type FiscalView } from '../fiscal/view.js'
import { ACTIVE_CHARGE_STATUSES } from './guard.js'
import { orderRefOf } from '../fiscal/payload.js'

// processPayment / settlePayment / refundOrder carry the card-machine fields
// (terminalChargeId — which skips the active-charge guard for the charge
// being recorded and is persisted in Payment.gatewayMeta — gateway,
// manualReason, authCode, cardBrand, cardLast4) natively since the W4 cutover.

type TerminalTender = ProcessPaymentInput['payments'][number]
type TerminalProcessPaymentInput = ProcessPaymentInput
type TerminalSettleInput = SettleInput
type TerminalRefundInput = RefundInput

type Tx = Prisma.TransactionClient

const FINAL: ReadonlySet<TerminalChargeStatus> = new Set(['recorded', 'declined', 'cancelled', 'expired', 'voided', 'manual_resolved', 'unverified'])
const POLLABLE: TerminalChargeStatus[] = ['pending', 'sent', 'cancel_requested', 'unknown', 'unverified', 'manual_resolved']
const START_BUDGET_MS = 8000
const CALL_BUDGET_MS = 4000
const REVERSE_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000]
const VERIFY_WINDOW_MS = 24 * 3_600_000
const TOLERANCE_CENTS = 2

const isManager = (role: string) => (MANAGERS as readonly string[]).includes(role)

function actorOf(req: FastifyRequest): { id: string; role: string; tenantId: string | null; email: string | null } {
  const su = req.staffUser
  if (!su) throw new ForbiddenError('Sign in first')
  return { id: su.id, role: su.role, tenantId: su.tenantId, email: su.email }
}

export function isFinalStatus(s: TerminalChargeStatus): boolean {
  return FINAL.has(s)
}

// ─── Config ───────────────────────────────────────────────────────────────────

const onlineCache = new Map<string, { at: number; online: boolean | null }>()

export interface TerminalConfigView {
  enabled: boolean
  driver: string
  isTest: boolean
  allowManualRef: boolean
  chargeTimeoutSec: number
  pollMs: number
  terminals: Array<{ id: string; label: string }>
  online: boolean | null
}

function usable(conn: LoadedConnector): boolean {
  return conn.row.enabled && conn.row.driver !== 'none' && !!terminalDriverOf(conn.row.driver)
}

/** GET /pos/terminal/config?shiftId= — the terminals at this drawer's outlet. */
export async function terminalConfigForShift(req: FastifyRequest, shiftId: string): Promise<TerminalConfigView> {
  const shift = await prisma.shift.findFirst({ where: { id: shiftId, ...(await shiftWhere(req, 'write')) }, include: SHIFT_COMPANY_INCLUDE })
  if (!shift) throw new NotFoundError('Shift', shiftId)
  const tenantId = shiftTenantId(shift)
  if (!tenantId) throw new NotFoundError('Shift', shiftId)
  const conn = await getConnector(tenantId, 'terminal')
  const s = conn.terminalSettings
  const terminals = s.terminals.filter((t) => t.active && (!shift.locationId || t.locationId === shift.locationId))
  const on = usable(conn) && terminals.length > 0
  let online: boolean | null = null
  if (on) {
    const key = `${tenantId}:${shift.locationId ?? '*'}`
    const hit = onlineCache.get(key)
    if (hit && Date.now() - hit.at < 15_000) online = hit.online
    else {
      const driver = terminalDriverOf(conn.row.driver)!
      try {
        const h = await withTimeout(driver.health(buildCtx(conn, 5000), terminals[0]!.terminalId), 5250, 'terminal health')
        online = h.kind === 'ok' ? h.value.online : false
      } catch { online = false }
      onlineCache.set(key, { at: Date.now(), online })
    }
  }
  return {
    enabled: on,
    driver: conn.row.driver,
    isTest: conn.row.driver === 'test',
    allowManualRef: s.allowManualRef || !on,
    chargeTimeoutSec: s.chargeTimeoutSec,
    pollMs: s.pollMs,
    terminals: on ? terminals.map((t) => ({ id: t.id, label: t.label })) : [],
    online,
  }
}

// ─── Views ────────────────────────────────────────────────────────────────────

export interface TerminalChargeView {
  id: string
  kind: 'charge' | 'refund'
  status: TerminalChargeStatus
  final: boolean
  orderId: string
  terminalId: string
  terminalLabel: string
  amountCents: number
  tipCents: number
  quoteDueCents: number
  approvalRef: string | null
  cardBrand: string | null
  cardLast4: string | null
  message: string | null
  refusalCode: string | null
  expiresAt: string
  createdAt: string
  /**
   * The payment this charge settles (kind 'charge': a split-bill card
   * portion) or refunds (kind 'refund'); null on a whole-order sale charge.
   * Test `kind === 'refund'` to tell a refund — never `targetPaymentId != null`.
   */
  targetPaymentId: string | null
  payment: { id: string; method: string; amountCents: number } | null
  fiscal: FiscalView | null
}

export async function chargeView(c: TerminalCharge, opts: { staff?: boolean } = {}): Promise<TerminalChargeView> {
  const conn = await getConnector(c.tenantId, 'terminal')
  const t = conn.terminalSettings.terminals.find((x) => x.id === c.terminalId)
  const payment = c.paymentId
    ? await prisma.payment.findUnique({ where: { id: c.paymentId }, select: { id: true, method: true, amountCents: true } })
    : null
  let fiscal: FiscalView | null = null
  if (c.paymentId && c.kind === 'charge') fiscal = await fiscalViewForOrder(c.orderId, 'sale', opts)
  if (c.paymentId && c.kind === 'refund') {
    const doc = await prisma.fiscalDocument.findFirst({ where: { tenantId: c.tenantId, refundPaymentId: c.paymentId }, select: FISCAL_VIEW_SELECT })
    fiscal = doc ? toFiscalView(doc, opts) : null
  }
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    final: FINAL.has(c.status),
    orderId: c.orderId,
    terminalId: c.terminalId,
    terminalLabel: t?.label ?? c.terminalId,
    amountCents: c.amountCents,
    tipCents: c.tipCents,
    quoteDueCents: c.quoteDueCents,
    approvalRef: c.approvalRef,
    cardBrand: c.cardBrand,
    cardLast4: c.cardLast4,
    message: c.message,
    refusalCode: c.refusalCode,
    expiresAt: c.expiresAt.toISOString(),
    createdAt: c.createdAt.toISOString(),
    targetPaymentId: c.targetPaymentId ?? null,
    payment: payment ? { id: payment.id, method: payment.method, amountCents: payment.amountCents } : null,
    fiscal,
  }
}

/** A charge the operator may act on (write scope), or 404. */
export async function chargeInScope(req: FastifyRequest, id: string, mode: 'read' | 'write' = 'write'): Promise<TerminalCharge> {
  const c = await prisma.terminalCharge.findFirst({ where: { id, ...(await scopeTenantWhere(req, mode)) } })
  if (!c) throw new NotFoundError('Card charge', id)
  return c
}

// ─── Driver plumbing ──────────────────────────────────────────────────────────

function callbackUrl(token: string): string {
  const base = (process.env['API_URL'] ?? 'https://api.servd.pk').replace(/\/+$/, '')
  return `${base}/api/v1/webhooks/pos/${token}`
}

async function chargeRequestOf(c: TerminalCharge, conn: LoadedConnector): Promise<ChargeRequest> {
  const t = conn.terminalSettings.terminals.find((x) => x.id === c.terminalId)
  const order = await prisma.order.findUnique({ where: { id: c.orderId }, select: { concept: { select: { name: true } } } })
  let original: ChargeRequest['original']
  if (c.kind === 'refund' && c.originalChargeId) {
    const o = await prisma.terminalCharge.findFirst({ where: { id: c.originalChargeId, tenantId: c.tenantId }, select: { id: true, providerRef: true, approvalRef: true } })
    if (o) original = { chargeId: o.id, ...(o.providerRef && { providerRef: o.providerRef }), ...(o.approvalRef && { approvalRef: o.approvalRef }) }
  }
  return {
    chargeId: c.id,
    terminalId: t?.terminalId ?? c.terminalId,
    amountCents: c.amountCents,
    currency: 'PKR',
    kind: c.kind,
    startedAt: c.createdAt,
    description: `${order?.concept.name ?? 'servd'} order ${orderRefOf(c.orderId)}${c.kind === 'refund' ? ' refund' : ''}`,
    ...(original && { original }),
    callbackUrl: callbackUrl(conn.row.webhookToken),
  }
}

async function call<T>(p: () => Promise<Outcome<T>>, budgetMs: number, label: string, onThrow: 'unknown' | 'transient'): Promise<Outcome<T>> {
  try {
    return await withTimeout(p(), budgetMs + 250, label)
  } catch (err) {
    return { kind: onThrow, code: 'TIMEOUT', message: scrubMessage(err) }
  }
}

function driverFor(conn: LoadedConnector): TerminalDriver | null {
  return terminalDriverOf(conn.row.driver)
}

function ctxOf(conn: LoadedConnector, budgetMs: number): ConnectorCtx {
  return buildCtx(conn, budgetMs)
}

// ─── Start ────────────────────────────────────────────────────────────────────

export interface StartChargeInput {
  orderId: string
  shiftId: string
  terminalId: string
  tipCents: number
  expectedDueCents: number
  idempotencyKey: string
  paymentId?: string
}

export async function startTerminalCharge(req: FastifyRequest, input: StartChargeInput): Promise<{ view: TerminalChargeView; replay: boolean }> {
  const actor = actorOf(req)
  // 1. The order in scope (foreign → 404), its company, the drawer (422), the operator (403), the terminal (422).
  const order = await prisma.order.findFirst({
    where: { id: input.orderId, deletedAt: null, concept: await scopeTenantWhere(req, 'write') },
    select: { id: true, concept: { select: { tenantId: true } } },
  })
  if (!order || !order.concept.tenantId) throw new NotFoundError('Order', input.orderId)
  const tenantId = order.concept.tenantId
  await assertShiftOf(tenantId, input.shiftId, true)
  await assertDrawerOperator(input.shiftId, actor)

  const conn = await getConnector(tenantId, 'terminal')
  if (!usable(conn)) throw new AppError('TERMINAL_NOT_CONFIGURED', 'No card machine is set up for this company — take the card on the machine and enter its reference', 503)
  const shift = await prisma.shift.findUniqueOrThrow({ where: { id: input.shiftId }, select: { locationId: true } })
  const terminal = conn.terminalSettings.terminals.find((t) => t.id === input.terminalId && t.active)
  if (!terminal || (shift.locationId && terminal.locationId !== shift.locationId)) {
    throw new AppError('TERMINAL_NOT_IN_COMPANY', 'That card machine is not set up at this outlet', 422)
  }
  if (input.paymentId && input.tipCents > 0) {
    throw new AppError('INVALID_TIP', 'A tip cannot be added while settling one part of a split bill', 400)
  }

  // 2. Replay of the same tap.
  const prior = await prisma.terminalCharge.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } } })
  if (prior) {
    if (prior.orderId !== input.orderId || prior.kind !== 'charge') {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key belongs to a different request — generate a new one', 409)
    }
    return { view: await chargeView(prior), replay: true }
  }

  // 3. Re-quote under the order lock and insert.
  const now = connectorNow()
  let charge: TerminalCharge
  let replayed = false
  try {
    charge = await prisma.$transaction(async (tx) => {
      await lockOrderTx(tx, input.orderId)
      // A concurrent tap with the same key committed while we waited for the lock.
      const same = await tx.terminalCharge.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } } })
      if (same) {
        if (same.orderId !== input.orderId || same.kind !== 'charge') throw new AppError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key belongs to a different request — generate a new one', 409)
        replayed = true
        return same
      }
      const o = await tx.order.findUniqueOrThrow({ where: { id: input.orderId }, select: { status: true } })
      if (['completed', 'cancelled', 'rejected', 'refunded'].includes(o.status)) {
        throw new AppError('ORDER_NOT_OPEN', `This order is ${o.status} — it cannot take a card payment`, 409)
      }
      const active = await tx.terminalCharge.findFirst({
        where: { orderId: input.orderId, kind: 'charge', status: { in: ACTIVE_CHARGE_STATUSES } },
        select: { id: true },
      })
      if (active) throw chargeInProgress(active.id)
      let due: number
      if (input.paymentId) {
        const p = await tx.payment.findFirst({ where: { id: input.paymentId, orderId: input.orderId }, select: { status: true, method: true, amountCents: true } })
        if (!p) throw new NotFoundError('Payment', input.paymentId)
        if (p.status !== 'pending') throw new AppError('ALREADY_PAID', 'That part of the bill is already settled', 409)
        if (p.method !== 'card') throw new AppError('NOT_A_CARD_PORTION', 'Only a card portion of a split bill can be charged on the card machine', 409)
        due = p.amountCents
      } else {
        due = (await quoteOrderForTender(input.orderId, 'card')).dueCents
      }
      if (due <= 0) throw new AppError('ALREADY_PAID', 'Nothing is due on this order', 409)
      if (Math.abs(input.expectedDueCents - due) > TOLERANCE_CENTS) {
        throw new AppError('AMOUNT_MISMATCH', `The bill changed: ${due} is due by card, not ${input.expectedDueCents} — check the amount and try again`, 409, { dueCents: due })
      }
      return tx.terminalCharge.create({
        data: {
          tenantId,
          kind: 'charge',
          connectorId: conn.row.id,
          terminalId: terminal.id,
          orderId: input.orderId,
          shiftId: input.shiftId,
          targetPaymentId: input.paymentId ?? null,
          amountCents: due + input.tipCents,
          tipCents: input.tipCents,
          quoteDueCents: due,
          idempotencyKey: input.idempotencyKey,
          status: 'pending',
          expiresAt: new Date(now.getTime() + conn.terminalSettings.chargeTimeoutSec * 1000),
          createdById: actor.id,
        },
      })
    }, { maxWait: 10_000, timeout: 15_000 })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const same = await prisma.terminalCharge.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } } })
      if (same) return { view: await chargeView(same), replay: true }
      const active = await prisma.terminalCharge.findFirst({ where: { orderId: input.orderId, kind: 'charge', status: { in: ACTIVE_CHARGE_STATUSES } }, select: { id: true } })
      throw chargeInProgress(active?.id ?? null)
    }
    throw err
  }

  if (replayed) return { view: await chargeView(charge), replay: true }

  // 4. After commit: push to the machine.
  await pushToMachine(charge, conn)
  const fresh = await prisma.terminalCharge.findUniqueOrThrow({ where: { id: charge.id } })
  return { view: await chargeView(fresh), replay: false }
}

function chargeInProgress(chargeId: string | null): AppError {
  return new AppError('CHARGE_IN_PROGRESS', 'The card machine is already working on this bill', 409, { chargeId })
}

async function pushToMachine(charge: TerminalCharge, conn: LoadedConnector): Promise<void> {
  const driver = driverFor(conn)
  if (!driver) return
  const r = await chargeRequestOf(charge, conn)
  const out = charge.kind === 'refund'
    ? await call(() => driver.refund(ctxOf(conn, START_BUDGET_MS), r), START_BUDGET_MS, 'terminal refund', 'unknown')
    : await call(() => driver.startCharge(ctxOf(conn, START_BUDGET_MS), r), START_BUDGET_MS, 'terminal start', 'unknown')
  const now = connectorNow()
  switch (out.kind) {
    case 'ok':
      await prisma.terminalCharge.updateMany({ where: { id: charge.id, status: 'pending' }, data: { status: 'sent', providerRef: out.value.providerRef ?? null, lastPolledAt: null } })
      return
    case 'transient':
      // The vendor never received it: nothing to wait for. Retry with a new key, or the manual reference.
      await prisma.terminalCharge.updateMany({ where: { id: charge.id, status: 'pending' }, data: { status: 'cancelled', message: 'TERMINAL_UNREACHABLE', resolvedAt: now, vendorMeta: { start: out.code } } })
      return
    case 'unknown':
      await prisma.terminalCharge.updateMany({ where: { id: charge.id, status: 'pending' }, data: { status: 'unknown', message: `No answer from the card machine (${out.code})`, nextActionAt: now } })
      return
    case 'rejected':
      await prisma.terminalCharge.updateMany({ where: { id: charge.id, status: 'pending' }, data: { status: 'declined', message: scrubMessage(`${out.code}: ${out.message}`, 300), resolvedAt: now } })
      return
  }
}

// ─── The state machine ────────────────────────────────────────────────────────

export type ChargeVia = 'poll' | 'webhook' | 'reconciler' | 'cancel' | 'simulate'

interface Applied { charge: TerminalCharge; next: 'record' | 'reverse' | null }

/**
 * THE state machine (spec §7.5). Forward only, under a row lock. Returns what
 * must happen after commit (record the payment, or reverse the charge).
 */
export async function applyChargeStateTx(tx: Tx, chargeId: string, state: ChargeState): Promise<Applied | null> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM terminal_charges WHERE id = ${chargeId} FOR UPDATE`
  if (locked.length === 0) return null
  const c = await tx.terminalCharge.findUniqueOrThrow({ where: { id: chargeId } })
  const now = connectorNow()
  const set = async (data: Prisma.TerminalChargeUpdateInput, next: Applied['next'] = null): Promise<Applied> => ({
    charge: await tx.terminalCharge.update({ where: { id: c.id }, data }),
    next,
  })

  switch (state.state) {
    case 'pending':
    case 'awaiting_card':
      if (c.status === 'pending') return set({ status: 'sent' })
      return { charge: c, next: null }

    case 'approved': {
      const card = {
        providerRef: state.providerRef, approvalRef: state.approvalRef, authCode: state.authCode ?? null,
        cardBrand: state.cardBrand ?? null, cardLast4: state.last4 && /^\d{4}$/.test(state.last4) ? state.last4 : null,
      }
      if (c.status === 'manual_resolved') {
        // The vendor confirms what the cashier recorded from the slip.
        return set({ ...card, vendorMeta: { verified: 'approved' } })
      }
      if (!['pending', 'sent', 'cancel_requested', 'unknown', 'unverified', 'expired', 'cancelled'].includes(c.status)) return { charge: c, next: null }
      if (state.amountCents !== c.amountCents) {
        if (c.kind === 'refund') {
          // W1-R5: a card REFUND is never reversed (that would push a second
          // refund, or void the refund). The vendor reports a different amount
          // than servd asked for: a person reconciles it.
          const charge = await tx.terminalCharge.update({
            where: { id: c.id },
            data: {
              ...card, status: 'needs_attention', refusalCode: 'TERMINAL_AMOUNT_MISMATCH', nextActionAt: null,
              message: scrubMessage(`The card processor reports a refund of ${state.amountCents}, not ${c.amountCents}`, 300),
            },
          })
          setImmediate(() => {
            void alertTerminalCharge(c, 'terminal_unreconciled', 'Card refund amount does not match',
              `A card refund of PKR ${(c.amountCents / 100).toFixed(2)} on order ${orderRefOf(c.orderId)} was reported by the card processor as PKR ${(state.amountCents / 100).toFixed(2)}. Nothing was booked — check the machine's settlement report and record the refund by hand.`)
          })
          return { charge, next: null }
        }
        return set({ ...card, status: 'void_pending', refusalCode: 'TERMINAL_AMOUNT_MISMATCH', nextActionAt: now }, 'reverse')
      }
      if (c.kind === 'charge' && ['unverified', 'expired', 'cancelled'].includes(c.status)) {
        // A late approval on a charge the order was released from: only
        // 'approved' if the order is not already busy with another charge
        // (partial unique index); otherwise reverse it.
        const other = await tx.terminalCharge.findFirst({ where: { orderId: c.orderId, kind: 'charge', id: { not: c.id }, status: { in: ACTIVE_CHARGE_STATUSES } }, select: { id: true } })
        if (other) return set({ ...card, status: 'void_pending', refusalCode: 'ORDER_HAS_ACTIVE_CHARGE', nextActionAt: now }, 'reverse')
      }
      return set({ ...card, status: 'approved', message: null }, 'record')
    }

    case 'declined':
    case 'cancelled':
    case 'expired': {
      if (c.status === 'manual_resolved') return unreconciled(tx, c, state.state)
      if (!['pending', 'sent', 'cancel_requested', 'unknown', 'unverified'].includes(c.status)) return { charge: c, next: null }
      const status: TerminalChargeStatus = state.state === 'declined' ? 'declined' : state.state === 'cancelled' ? 'cancelled' : 'expired'
      return set({ status, resolvedAt: now, ...(state.state === 'declined' && { message: scrubMessage(state.reason, 300) }) })
    }

    case 'not_found': {
      if (c.status === 'sent' || c.status === 'cancel_requested') return set({ status: 'unknown', message: 'The card machine has no record of this charge', nextActionAt: now })
      if ((c.status === 'unknown' || c.status === 'unverified') && now > c.expiresAt) {
        return set({ status: 'expired', resolvedAt: now, message: 'NOT_FOUND_AT_VENDOR' })
      }
      if (c.status === 'manual_resolved' && now > c.expiresAt) return unreconciled(tx, c, 'not_found')
      return { charge: c, next: null }
    }
  }
}

async function unreconciled(tx: Tx, c: TerminalCharge, vendorSays: string): Promise<Applied> {
  const charge = await tx.terminalCharge.update({ where: { id: c.id }, data: { status: 'needs_attention', message: `Recorded from the slip, but the card processor says ${vendorSays}`, vendorMeta: { verified: vendorSays } } })
  setImmediate(() => {
    void alertTerminalCharge(c, 'terminal_unreconciled',
      'Card payment recorded but not charged',
      `A card payment of PKR ${(c.amountCents / 100).toFixed(2)} on order ${orderRefOf(c.orderId)} was recorded from the machine slip, but the card processor says ${vendorSays}. Check the machine's settlement report and collect or correct it.`)
  })
  return { charge, next: null }
}

/** Apply a vendor state and run the follow-up (now, or in setImmediate for webhooks). */
export async function applyChargeState(chargeId: string, state: ChargeState, via: ChargeVia): Promise<TerminalCharge | null> {
  const applied = await prisma.$transaction((tx) => applyChargeStateTx(tx, chargeId, state), { maxWait: 10_000, timeout: 15_000 })
  if (!applied) return null
  const follow = async () => {
    if (applied.next === 'record') await recordApprovedCharge(chargeId)
    else if (applied.next === 'reverse') await reverseCharge(chargeId)
  }
  if (applied.next) {
    if (via === 'webhook') setImmediate(() => { void follow().catch((e: Error) => console.error(`[terminal] ${chargeId} follow-up failed:`, e.message)) })
    else await follow()
  }
  return prisma.terminalCharge.findUnique({ where: { id: chargeId } })
}

// ─── Record ───────────────────────────────────────────────────────────────────

function isRefusal(err: unknown): err is AppError {
  return err instanceof AppError && err.statusCode >= 400 && err.statusCode < 500
}

/** Payment already written for this charge (persisted by W4 in gatewayMeta.terminalChargeId). */
async function paymentOfCharge(c: TerminalCharge): Promise<string | null> {
  const p = await prisma.payment.findFirst({
    where: { orderId: c.orderId, gatewayMeta: { path: ['terminalChargeId'], equals: c.id }, ...(c.kind === 'refund' ? { status: 'refunded' } : {}) },
    select: { id: true },
  })
  return p?.id ?? null
}

/**
 * Write the Payment for an approved charge (or the refund for an approved
 * card refund). Idempotent: processPayment dedupes on `term:<chargeId>`;
 * the refund path claims the row first and looks for its own Payment.
 */
export async function recordApprovedCharge(chargeId: string): Promise<TerminalCharge | null> {
  const c = await prisma.terminalCharge.findUnique({ where: { id: chargeId } })
  if (!c || c.paymentId || c.status !== 'approved') return c
  const now = connectorNow()
  // Claim (single flight between webhook, poll and reconciler). An approved
  // charge is never reconciler-due, so nextActionAt doubles as the record lease.
  const claim = await prisma.terminalCharge.updateMany({
    where: { id: c.id, status: 'approved', paymentId: null, OR: [{ nextActionAt: null }, { nextActionAt: { lt: now } }] },
    data: { nextActionAt: new Date(now.getTime() + 30_000) },
  })
  if (claim.count === 0) return prisma.terminalCharge.findUnique({ where: { id: chargeId } })

  try {
    const existing = await paymentOfCharge(c)
    const paymentId = existing ?? (c.kind === 'refund' ? await recordRefund(c) : await recordCharge(c))
    await prisma.terminalCharge.updateMany({
      where: { id: c.id, status: 'approved' },
      data: { status: 'recorded', paymentId, resolvedAt: connectorNow(), nextActionAt: null },
    })
  } catch (err) {
    if (c.kind === 'refund') {
      // The money is already back on the card; servd could not book it.
      const code = err instanceof AppError ? err.code : 'RECORD_FAILED'
      if (isRefusal(err)) {
        await prisma.terminalCharge.updateMany({ where: { id: c.id, status: 'approved' }, data: { status: 'needs_attention', refusalCode: code, message: scrubMessage(err, 300), nextActionAt: null } })
        await alertTerminalCharge(c, 'terminal_unreconciled', 'Card refund given but not booked',
          `The card machine refunded PKR ${(c.amountCents / 100).toFixed(2)} on order ${orderRefOf(c.orderId)}, but servd refused to book it (${code}). Record the refund by hand.`)
      } else {
        await prisma.terminalCharge.updateMany({ where: { id: c.id }, data: { nextActionAt: null } })
        console.error(`[terminal] refund ${c.id} could not be recorded yet (will retry):`, (err as Error).message)
      }
    } else if (isRefusal(err)) {
      // Approved but servd refused the payment → give the money back.
      await prisma.terminalCharge.updateMany({
        where: { id: c.id, status: 'approved' },
        data: { status: 'void_pending', refusalCode: err.code.slice(0, 64), message: scrubMessage(err.message, 300), nextActionAt: connectorNow() },
      })
      await reverseCharge(c.id)
    } else {
      await prisma.terminalCharge.updateMany({ where: { id: c.id }, data: { nextActionAt: null } })
      console.error(`[terminal] charge ${c.id} could not be recorded yet (will retry):`, (err as Error).message)
    }
  }
  return prisma.terminalCharge.findUnique({ where: { id: chargeId } })
}

async function recordCharge(c: TerminalCharge): Promise<string> {
  if (!c.shiftId) throw new AppError('SHIFT_REQUIRED', 'The charge has no drawer', 422)
  const order = await prisma.order.findUniqueOrThrow({ where: { id: c.orderId }, select: { concept: { select: { tenantId: true } } } })
  await assertShiftOf(order.concept.tenantId, c.shiftId, true)
  const gatewayRef = c.approvalRef ?? `TERM-${c.id}`
  if (c.targetPaymentId) {
    const input: TerminalSettleInput = {
      paymentId: c.targetPaymentId, via: 'till', shiftId: c.shiftId, gatewayRef, gateway: 'card_terminal', terminalChargeId: c.id,
    }
    const r = await settlePayment(input)
    return r.payment.id
  }
  const input: TerminalProcessPaymentInput = {
    orderId: c.orderId,
    shiftId: c.shiftId,
    idempotencyKey: `term:${c.id}`,
    terminalChargeId: c.id,
    payments: [{
      method: 'card', amountCents: c.amountCents, tipCents: c.tipCents, gateway: 'card_terminal', gatewayRef,
      terminalChargeId: c.id, authCode: c.authCode, cardBrand: c.cardBrand, cardLast4: c.cardLast4,
    }],
  }
  const r = await processPayment(input)
  const p = r.payments[0]
  if (!p) throw new AppError('RECORD_FAILED', 'No payment was written', 500)
  return p.id
}

async function recordRefund(c: TerminalCharge): Promise<string> {
  const actor = await prisma.user.findUnique({ where: { id: c.createdById }, select: { role: true } })
  const meta = (c.vendorMeta ?? {}) as { reason?: unknown; photoUrl?: unknown }
  const input: TerminalRefundInput = {
    orderId: c.orderId,
    amountCents: c.amountCents,
    reason: typeof meta.reason === 'string' && meta.reason.length >= 3 ? meta.reason : 'Card refund on the card machine',
    ...(typeof meta.photoUrl === 'string' && meta.photoUrl && { photoUrl: meta.photoUrl }),
    actorId: c.createdById,
    actorRole: actor?.role ?? 'cashier',
    shiftId: c.shiftId,
    method: 'card',
    gateway: 'card_terminal',
    gatewayRef: c.approvalRef ?? `TERM-${c.id}`,
    terminalChargeId: c.id,
  }
  const r = await refundOrder(input)
  return r.id
}

// ─── Reverse ──────────────────────────────────────────────────────────────────

/** Void (same Karachi day, driver can void) or referenced refund. Backoff 30 s, 2 m, 10 m, 30 m; then needs_attention. */
export async function reverseCharge(chargeId: string): Promise<TerminalCharge | null> {
  const now = connectorNow()
  const claim = await prisma.terminalCharge.updateMany({
    where: { id: chargeId, status: 'void_pending', OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }] },
    data: { nextActionAt: new Date(now.getTime() + 60_000) },
  })
  if (claim.count === 0) return prisma.terminalCharge.findUnique({ where: { id: chargeId } })
  const c = await prisma.terminalCharge.findUniqueOrThrow({ where: { id: chargeId } })
  if (c.kind === 'refund') {
    // W1-R5: a card refund is never reversed — reversing it would push a
    // second refund to the card, or void the refund. A person reconciles it.
    await prisma.terminalCharge.updateMany({
      where: { id: c.id, status: 'void_pending' },
      data: { status: 'needs_attention', nextActionAt: null, message: 'A card refund is never reversed automatically — reconcile it on the machine' },
    })
    return prisma.terminalCharge.findUnique({ where: { id: c.id } })
  }
  const conn = await getConnectorFresh(c.tenantId, 'terminal')
  const driver = driverFor(conn)
  const meta: Record<string, Prisma.JsonValue> = isObj(c.vendorMeta) ? { ...c.vendorMeta } : {}
  const started = reversalOf(meta)

  let out: Outcome<unknown> = { kind: 'transient', code: 'NO_DRIVER', message: 'The card machine connector is off' }
  if (driver && started) {
    // W1-R7: a referenced refund was already started — confirm it, never start a second one.
    const st = await confirmReversal(c, conn, driver, started)
    if (st === 'wait') return reversalWait(c, started, now)
    out = st
  } else if (driver) {
    const r = await chargeRequestOf(c, conn)
    const caps = driver.capabilities(ctxOf(conn, CALL_BUDGET_MS))
    const sameDay = karachiDay(c.createdAt) === karachiDay(now)
    if (caps.void && sameDay && c.providerRef) {
      // A void is final when the vendor says { voided: true }.
      const providerRef = c.providerRef
      out = await call(() => driver.voidCharge(ctxOf(conn, CALL_BUDGET_MS), { ...r, providerRef }), CALL_BUDGET_MS, 'terminal void', 'transient')
    } else if (caps.referencedRefund) {
      // A referenced refund only STARTS here ("poll like a charge"): it is
      // recorded on the row and confirmed by status polls before the charge
      // counts as reversed (W1-R7).
      const seq = typeof meta['reversalSeq'] === 'number' ? meta['reversalSeq'] : 0
      const rev: StartedReversal = { chargeId: seq === 0 ? `${c.id}-rev` : `${c.id}-rev${seq}`, startedAt: now.toISOString() }
      const refundReq = reversalRequest(r, c, rev)
      const res = await call(() => driver.refund(ctxOf(conn, CALL_BUDGET_MS), refundReq), CALL_BUDGET_MS, 'terminal reverse refund', 'transient')
      if (res.kind === 'ok') {
        const recorded: StartedReversal = { ...rev, ...(res.value.providerRef && { providerRef: res.value.providerRef }) }
        await prisma.terminalCharge.updateMany({
          where: { id: c.id, status: 'void_pending' },
          data: { vendorMeta: { ...meta, reversal: { ...recorded }, reversalSeq: seq + 1 } },
        })
        const st = await confirmReversal(c, conn, driver, recorded)
        if (st === 'wait') return reversalWait(c, recorded, now)
        out = st
      } else {
        out = res
      }
    } else {
      out = { kind: 'rejected', code: 'CANNOT_REVERSE', message: 'This card machine cannot void or refund by reference' }
    }
  }

  if (out.kind === 'ok') {
    await prisma.terminalCharge.updateMany({ where: { id: c.id, status: 'void_pending' }, data: { status: 'voided', resolvedAt: now, nextActionAt: null } })
    if (c.refusalCode === 'ALREADY_PAID' || c.refusalCode === 'ORDER_HAS_ACTIVE_CHARGE') {
      void notifyConnectorPeople(c.tenantId, 'terminal',
        `servd: a late card approval of PKR ${(c.amountCents / 100).toFixed(2)} on order ${orderRefOf(c.orderId)} came after the bill was paid another way — it was reversed automatically.`)
    }
  } else {
    const attempts = c.reverseAttempts + 1
    const giveUp = attempts >= REVERSE_BACKOFF_MS.length || now.getTime() - c.updatedAt.getTime() > 3_600_000 && attempts > 1
    if (giveUp) {
      await prisma.terminalCharge.updateMany({
        where: { id: c.id, status: 'void_pending' },
        data: { status: 'needs_attention', reverseAttempts: attempts, nextActionAt: null, message: scrubMessage(`Reversal failed: ${'message' in out ? out.message : ''}`, 300) },
      })
      await alertTerminalCharge(c, 'terminal_void_failed', 'Card charged but the reversal FAILED',
        `PKR ${(c.amountCents / 100).toFixed(2)} was charged on order ${orderRefOf(c.orderId)} but servd could not take it (${c.refusalCode ?? 'refused'}) and the automatic reversal failed. Refund the customer on the machine, then mark it reversed in Dev → API → POS connector → Status.`)
    } else {
      await prisma.terminalCharge.updateMany({
        where: { id: c.id, status: 'void_pending' },
        data: { reverseAttempts: attempts, nextActionAt: new Date(now.getTime() + REVERSE_BACKOFF_MS[attempts - 1]!) },
      })
    }
  }
  return prisma.terminalCharge.findUnique({ where: { id: c.id } })
}

/** A referenced refund servd started to reverse a charge (TerminalCharge.vendorMeta.reversal). */
interface StartedReversal { chargeId: string; providerRef?: string; startedAt: string }

function reversalOf(meta: Record<string, Prisma.JsonValue>): StartedReversal | null {
  const r = meta['reversal']
  if (!isObj(r) || typeof r['chargeId'] !== 'string' || typeof r['startedAt'] !== 'string') return null
  return { chargeId: r['chargeId'], startedAt: r['startedAt'], ...(typeof r['providerRef'] === 'string' && { providerRef: r['providerRef'] }) }
}

function reversalRequest(r: ChargeRequest, c: TerminalCharge, rev: StartedReversal): ChargeRequest & { providerRef?: string } {
  return {
    ...r,
    chargeId: rev.chargeId,
    kind: 'refund',
    startedAt: new Date(rev.startedAt),
    original: { chargeId: c.id, ...(c.providerRef && { providerRef: c.providerRef }), ...(c.approvalRef && { approvalRef: c.approvalRef }) },
    ...(rev.providerRef && { providerRef: rev.providerRef }),
  }
}

/**
 * Is the reversing refund done? 'ok' when the processor approved it; 'wait'
 * while it is still pending (or the processor cannot be asked right now); a
 * failure (declined / cancelled / expired / not found after the timeout) clears
 * it from the row so the next attempt starts a new one — on the backoff, and
 * then needs_attention + terminal_void_failed.
 */
async function confirmReversal(c: TerminalCharge, conn: LoadedConnector, driver: TerminalDriver, rev: StartedReversal): Promise<Outcome<unknown> | 'wait'> {
  const r = reversalRequest(await chargeRequestOf(c, conn), c, rev)
  const st = await call(() => driver.getChargeStatus(ctxOf(conn, CALL_BUDGET_MS), r), CALL_BUDGET_MS, 'terminal reverse status', 'transient')
  if (st.kind !== 'ok') return 'wait'
  const s = st.value
  if (s.state === 'approved') return { kind: 'ok', value: { reversal: rev.chargeId } }
  if (s.state === 'pending' || s.state === 'awaiting_card') return 'wait'
  const age = connectorNow().getTime() - new Date(rev.startedAt).getTime()
  if (s.state === 'not_found' && age < conn.terminalSettings.chargeTimeoutSec * 1000) return 'wait'
  const fresh = await prisma.terminalCharge.findUnique({ where: { id: c.id }, select: { vendorMeta: true } })
  const meta: Record<string, Prisma.JsonValue> = isObj(fresh?.vendorMeta) ? { ...fresh.vendorMeta } : {}
  delete meta['reversal']
  await prisma.terminalCharge.updateMany({ where: { id: c.id, status: 'void_pending' }, data: { vendorMeta: meta } })
  const why = s.state === 'declined' ? `declined: ${s.reason}` : s.state
  return { kind: 'transient', code: 'REVERSAL_NOT_APPROVED', message: `The reversing refund was ${why}` }
}

/** The reversing refund is still in flight: look again soon; a human after 24 h. */
async function reversalWait(c: TerminalCharge, rev: StartedReversal, now: Date): Promise<TerminalCharge | null> {
  if (now.getTime() - new Date(rev.startedAt).getTime() > VERIFY_WINDOW_MS) {
    const r = await prisma.terminalCharge.updateMany({
      where: { id: c.id, status: 'void_pending' },
      data: { status: 'needs_attention', nextActionAt: null, message: 'The reversing refund was never confirmed by the card processor' },
    })
    if (r.count > 0) {
      await alertTerminalCharge(c, 'terminal_void_failed', 'Card charged but the reversal was never confirmed',
        `PKR ${(c.amountCents / 100).toFixed(2)} was charged on order ${orderRefOf(c.orderId)} but servd could not take it (${c.refusalCode ?? 'refused'}); the reversing refund was never confirmed. Check the machine, refund the customer if needed, then mark it reversed in Dev → API → POS connector → Status.`)
    }
  } else {
    await prisma.terminalCharge.updateMany({ where: { id: c.id, status: 'void_pending' }, data: { nextActionAt: new Date(now.getTime() + REVERSE_BACKOFF_MS[0]!) } })
  }
  return prisma.terminalCharge.findUnique({ where: { id: c.id } })
}

// ─── Poll / timeout ───────────────────────────────────────────────────────────

/**
 * Refresh a charge from the vendor (single flight via pollLeaseUntil; at most
 * once a second unless forced). Handles the timeout: past expiresAt a still
 * pending charge is cancelled; an unreachable vendor makes it 'unknown'.
 */
export async function refreshCharge(chargeId: string, opts: { force?: boolean; via?: ChargeVia } = {}): Promise<TerminalCharge | null> {
  const now = connectorNow()
  const claim = await prisma.terminalCharge.updateMany({
    where: {
      id: chargeId,
      status: { in: POLLABLE },
      OR: [{ pollLeaseUntil: null }, { pollLeaseUntil: { lt: now } }],
      ...(!opts.force && { AND: [{ OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: new Date(now.getTime() - 1000) } }] }] }),
    },
    data: { pollLeaseUntil: new Date(now.getTime() + 10_000), lastPolledAt: now },
  })
  if (claim.count === 0) return prisma.terminalCharge.findUnique({ where: { id: chargeId } })
  const c = await prisma.terminalCharge.findUniqueOrThrow({ where: { id: chargeId } })
  try {
    await pollVendor(c, opts.via ?? 'poll')
  } finally {
    await prisma.terminalCharge.updateMany({ where: { id: chargeId }, data: { pollLeaseUntil: null } })
  }
  return prisma.terminalCharge.findUnique({ where: { id: chargeId } })
}

async function pollVendor(c: TerminalCharge, via: ChargeVia): Promise<void> {
  const conn = await getConnectorFresh(c.tenantId, 'terminal')
  const driver = driverFor(conn)
  if (!driver) return
  const r = await chargeRequestOf(c, conn)
  const st = await call(() => driver.getChargeStatus(ctxOf(conn, CALL_BUDGET_MS), { ...r, ...(c.providerRef && { providerRef: c.providerRef }) }), CALL_BUDGET_MS, 'terminal status', 'transient')
  const now = connectorNow()
  const expired = now > c.expiresAt
  const waitingStatuses: TerminalChargeStatus[] = ['pending', 'sent', 'cancel_requested']
  if (st.kind === 'ok') {
    await prisma.terminalCharge.updateMany({ where: { id: c.id }, data: { vendorMeta: { ...(isObj(c.vendorMeta) ? c.vendorMeta : {}), last: st.value.state } } })
    const s = st.value
    if ((s.state === 'pending' || s.state === 'awaiting_card') && expired && waitingStatuses.includes(c.status)) {
      await timeOut(c, conn, driver, r)
      return
    }
    await applyChargeState(c.id, s, via)
    return
  }
  if (expired && waitingStatuses.includes(c.status)) {
    await prisma.terminalCharge.updateMany({
      where: { id: c.id, status: { in: waitingStatuses } },
      data: { status: 'unknown', message: 'The card machine did not answer', nextActionAt: now },
    })
  }
}

function isObj(v: unknown): v is Record<string, Prisma.JsonValue> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

async function timeOut(c: TerminalCharge, conn: LoadedConnector, driver: TerminalDriver, r: ChargeRequest): Promise<void> {
  await prisma.terminalCharge.updateMany({ where: { id: c.id, status: { in: ['pending', 'sent'] } }, data: { status: 'cancel_requested' } })
  const out = await call(() => driver.cancelCharge(ctxOf(conn, CALL_BUDGET_MS), { ...r, ...(c.providerRef && { providerRef: c.providerRef }) }), CALL_BUDGET_MS, 'terminal cancel', 'transient')
  if (out.kind === 'ok' && out.value.state !== 'pending' && out.value.state !== 'awaiting_card') {
    await applyChargeState(c.id, out.value, 'cancel')
    return
  }
  await prisma.terminalCharge.updateMany({
    where: { id: c.id, status: 'cancel_requested' },
    data: { status: 'unknown', message: 'The card machine did not answer', nextActionAt: connectorNow() },
  })
}

// ─── Cashier actions ──────────────────────────────────────────────────────────

function assertOwnOrManager(req: FastifyRequest, c: TerminalCharge): void {
  const a = actorOf(req)
  if (c.createdById !== a.id && !isManager(a.role)) {
    throw new AppError('NOT_YOUR_CHARGE', 'Only the cashier who started this charge, or a manager, can do that', 403)
  }
}

export async function cancelTerminalCharge(req: FastifyRequest, id: string): Promise<TerminalChargeView> {
  const c = await chargeInScope(req, id, 'write')
  assertOwnOrManager(req, c)
  if (!['pending', 'sent', 'cancel_requested'].includes(c.status)) return chargeView(c)
  await prisma.terminalCharge.updateMany({ where: { id: c.id, status: { in: ['pending', 'sent'] } }, data: { status: 'cancel_requested' } })
  const conn = await getConnectorFresh(c.tenantId, 'terminal')
  const driver = driverFor(conn)
  if (driver) {
    const r = await chargeRequestOf(c, conn)
    const out = await call(() => driver.cancelCharge(ctxOf(conn, CALL_BUDGET_MS), { ...r, ...(c.providerRef && { providerRef: c.providerRef }) }), CALL_BUDGET_MS, 'terminal cancel', 'transient')
    // 'approved' (too late) is recorded, not lost; unreachable stays cancel_requested.
    if (out.kind === 'ok' && out.value.state !== 'pending' && out.value.state !== 'awaiting_card') await applyChargeState(c.id, out.value, 'cancel')
  }
  await audit({ category: 'identity', action: 'terminal.cancel', entity: 'TerminalCharge', entityId: c.id, userId: actorOf(req).id, tenantId: c.tenantId, metadata: { orderId: c.orderId, amountCents: c.amountCents } })
  return chargeView(await prisma.terminalCharge.findUniqueOrThrow({ where: { id: c.id } }))
}

export type ResolveInput = { outcome: 'approved_manual'; gatewayRef: string } | { outcome: 'not_charged'; note?: string }

/** The cashier reads the machine when servd could not (spec §7.9). */
export async function resolveTerminalCharge(req: FastifyRequest, id: string, input: ResolveInput): Promise<TerminalChargeView> {
  const a = actorOf(req)
  const c = await chargeInScope(req, id, 'write')
  assertOwnOrManager(req, c)
  const now = connectorNow()
  const resolvable = c.status === 'unknown'
    || (c.status === 'cancel_requested' && now > c.expiresAt)
    || (c.status === 'needs_attention' && isManager(a.role) && !c.paymentId && c.kind === 'charge' && !c.approvalRef)
  if (!resolvable || c.kind !== 'charge') {
    throw new AppError('NOT_RESOLVABLE', `This charge is ${c.status} — it cannot be resolved by hand now`, 409)
  }
  if (input.outcome === 'approved_manual') {
    if (!c.shiftId) throw new AppError('SHIFT_REQUIRED', 'The charge has no drawer', 422)
    const tender: TerminalTender = {
      method: 'card', amountCents: c.amountCents, tipCents: c.tipCents, gateway: 'card_terminal',
      gatewayRef: input.gatewayRef.trim(), terminalChargeId: c.id, manualReason: 'unknown_outcome',
    }
    const pay: TerminalProcessPaymentInput = { orderId: c.orderId, shiftId: c.shiftId, idempotencyKey: `term:${c.id}`, terminalChargeId: c.id, payments: [tender] }
    const r = await processPayment(pay)
    const paymentId = r.payments[0]?.id ?? null
    await prisma.terminalCharge.updateMany({
      where: { id: c.id, status: c.status },
      data: { status: 'manual_resolved', paymentId, manualReason: 'unknown_outcome', resolvedAt: now, nextActionAt: now, message: `Recorded from the machine slip (${input.gatewayRef.trim().slice(0, 64)})` },
    })
  } else {
    await prisma.terminalCharge.updateMany({
      where: { id: c.id, status: c.status },
      data: { status: 'unverified', manualReason: 'cashier_not_charged', resolvedAt: now, nextActionAt: now, message: input.note ? scrubMessage(input.note, 300) : 'Cashier: the machine shows no charge' },
    })
  }
  await audit({
    category: 'identity', action: 'terminal.resolve', entity: 'TerminalCharge', entityId: c.id, userId: a.id, userEmail: a.email, tenantId: c.tenantId,
    before: { status: c.status }, metadata: { outcome: input.outcome, orderId: c.orderId, amountCents: c.amountCents },
  })
  return chargeView(await prisma.terminalCharge.findUniqueOrThrow({ where: { id: c.id } }), { staff: true })
}

/** Managers: retry the reversal of a needs_attention charge, or mark it refunded on the machine. */
export async function manualReverseCharge(req: FastifyRequest, id: string, input: { markRefundedOnMachine?: boolean; note?: string }): Promise<TerminalChargeView> {
  const a = actorOf(req)
  const c = await chargeInScope(req, id, 'write')
  if (c.status !== 'needs_attention') throw new AppError('NOT_REVERSIBLE', `This charge is ${c.status} — only a charge that needs attention can be reversed here`, 409)
  if (c.kind === 'refund') {
    // A card refund is never reversed (W1-R5): that would refund the card twice or undo the refund.
    throw new AppError('NOT_REVERSIBLE', 'A card refund cannot be reversed — check the machine and record the refund on the order by hand', 409)
  }
  if (input.markRefundedOnMachine) {
    await prisma.terminalCharge.updateMany({ where: { id: c.id, status: 'needs_attention' }, data: { status: 'voided', resolvedAt: connectorNow(), message: input.note ? scrubMessage(`Refunded on the machine: ${input.note}`, 300) : 'Refunded on the machine (manager)' } })
  } else {
    await prisma.terminalCharge.updateMany({ where: { id: c.id, status: 'needs_attention', kind: 'charge' }, data: { status: 'void_pending', reverseAttempts: 0, nextActionAt: connectorNow() } })
    await reverseCharge(c.id)
  }
  await audit({
    category: 'identity', action: 'terminal.reverse', entity: 'TerminalCharge', entityId: c.id, userId: a.id, userEmail: a.email, tenantId: c.tenantId,
    metadata: { manual: !!input.markRefundedOnMachine, note: input.note ?? null, orderId: c.orderId, amountCents: c.amountCents },
  })
  return chargeView(await prisma.terminalCharge.findUniqueOrThrow({ where: { id: c.id } }), { staff: true })
}

// ─── Refund to card ───────────────────────────────────────────────────────────

export interface StartRefundInput { paymentId: string; amountCents: number; terminalId: string; idempotencyKey: string; reason: string; photoUrl?: string }

/**
 * Orders whose card money may go back on the card machine: a completed sale
 * (refundOrder → a sale refund + its fiscal refund document), and a ticket
 * cancelled / rejected after the till took the card (LEDGER-R5: only up to
 * what it still owes back, booked as the hand-back — never a sale refund, and
 * nothing goes to the fiscal POS, since a ticket cancelled before the full &
 * final bill never filed a sale). Anything else is refused NOT_REFUNDABLE.
 */
const CARD_REFUNDABLE_ORDER: ReadonlySet<string> = new Set(['completed', 'cancelled', 'rejected'])
function assertCardRefundableOrder(status: string): void {
  if (!CARD_REFUNDABLE_ORDER.has(status)) throw new AppError('NOT_REFUNDABLE', `A ${status} order cannot be refunded`, 409)
}
/** The refusals that mean "more than is left" — the card-refund API's one answer for them (spec §8.2). */
const EXCEEDS_CODES: ReadonlySet<string> = new Set(['REFUND_EXCEEDS_PAID', 'REFUND_EXCEEDS_TENDER', 'REFUND_EXCEEDS_DUE', 'NOTHING_TO_REFUND'])

export async function startTerminalRefund(req: FastifyRequest, input: StartRefundInput): Promise<{ view: TerminalChargeView; replay: boolean }> {
  const a = actorOf(req)
  const payment = await prisma.payment.findFirst({
    where: { id: input.paymentId, order: { concept: await scopeTenantWhere(req, 'write') } },
    select: { id: true, orderId: true, gateway: true, status: true, method: true, amountCents: true, gatewayMeta: true, order: { select: { status: true, concept: { select: { tenantId: true } } } } },
  })
  if (!payment || !payment.order.concept.tenantId) throw new NotFoundError('Payment', input.paymentId)
  const tenantId = payment.order.concept.tenantId
  if (payment.gateway !== 'card_terminal' || payment.status !== 'paid' || payment.amountCents <= 0) {
    throw new AppError('NOT_A_TERMINAL_PAYMENT', 'Only a card payment taken on the card machine can be refunded to the card — refund this one the usual way', 409)
  }
  const key = `refund:${input.idempotencyKey}`
  const prior = await prisma.terminalCharge.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } })
  if (prior) {
    if (prior.targetPaymentId !== payment.id) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key belongs to a different request — generate a new one', 409)
    return { view: await chargeView(prior, { staff: true }), replay: true }
  }
  assertCardRefundableOrder(payment.order.status)

  const conn = await getConnector(tenantId, 'terminal')
  if (!usable(conn)) throw new AppError('TERMINAL_NOT_CONFIGURED', 'No card machine is set up for this company', 503)
  const terminal = conn.terminalSettings.terminals.find((t) => t.id === input.terminalId && t.active)
  if (!terminal) throw new AppError('TERMINAL_NOT_IN_COMPANY', 'That card machine is not set up for this company', 422)

  const meta = (payment.gatewayMeta ?? {}) as { terminalChargeId?: unknown }
  const original = await prisma.terminalCharge.findFirst({
    where: { tenantId, kind: 'charge', OR: [{ paymentId: payment.id }, ...(typeof meta.terminalChargeId === 'string' ? [{ id: meta.terminalChargeId }] : [])] },
    select: { id: true },
  })
  // Every refusal refundOrder would make when booking it, BEFORE the machine
  // moves money (W1-R1) — THE engine's own check (pos/service
  // assertRefundAllowed), never a copy; run below under the order lock. The
  // machine flow has no PIN step, so above the actor's own cap a manager must
  // start it.
  const refundCheck = { orderId: payment.orderId, amountCents: input.amountCents, method: 'card' as const, reason: input.reason, photoUrl: input.photoUrl, actorRole: a.role, tenantId }

  const now = connectorNow()
  let replayed = false
  let charge: TerminalCharge
  try {
    charge = await prisma.$transaction(async (tx) => {
      await lockOrderTx(tx, payment.orderId)
      // A double tap with the same key committed while this one waited for the
      // lock: the same refund, never a second one pushed to the card.
      const same = await tx.terminalCharge.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } })
      if (same) {
        if (same.targetPaymentId !== payment.id) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key belongs to a different request — generate a new one', 409)
        replayed = true
        return same
      }
      const current = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId }, select: { status: true } })
      assertCardRefundableOrder(current.status)
      const others = await tx.terminalCharge.findMany({
        where: { tenantId, kind: 'refund', targetPaymentId: payment.id, status: { in: ['pending', 'sent', 'approved', 'cancel_requested', 'unknown', 'recorded', 'needs_attention'] } },
        select: { amountCents: true },
      })
      const refundedOrInFlight = others.reduce((s, o) => s + o.amountCents, 0)
      const ofPayment = payment.amountCents - refundedOrInFlight
      if (input.amountCents > ofPayment) {
        throw new AppError('AMOUNT_EXCEEDS_REFUNDABLE', `Only ${Math.max(0, ofPayment)} of this card payment can still be refunded`, 409, { refundableCents: Math.max(0, ofPayment) })
      }
      // The order-level check refundOrder makes, counting card refunds given on
      // the machine but not booked yet (no refund Payment exists for them) —
      // THE count refundOrder itself uses (pos/service inFlightTerminalRefundCents),
      // here with the ones servd refused to book: that money is already back.
      const inFlight = await inFlightTerminalRefundCents(tx, payment.orderId, { includeNeedsAttention: true })
      try {
        await assertRefundAllowed({ ...refundCheck, extraInFlightCents: inFlight })
      } catch (err) {
        // The card-refund API's own answer for "more than is left" (spec §8.2) —
        // for a cancelled ticket, more than it still owes back by card.
        if (err instanceof AppError && EXCEEDS_CODES.has(err.code)) {
          throw new AppError('AMOUNT_EXCEEDS_REFUNDABLE', err.message, 409)
        }
        throw err
      }
      return tx.terminalCharge.create({
        data: {
          tenantId,
          kind: 'refund',
          connectorId: conn.row.id,
          terminalId: terminal.id,
          orderId: payment.orderId,
          shiftId: null,
          targetPaymentId: payment.id,
          originalChargeId: original?.id ?? null,
          amountCents: input.amountCents,
          tipCents: 0,
          quoteDueCents: input.amountCents,
          idempotencyKey: key,
          status: 'pending',
          expiresAt: new Date(now.getTime() + conn.terminalSettings.chargeTimeoutSec * 1000),
          createdById: a.id,
          vendorMeta: { reason: input.reason.slice(0, 300), ...(input.photoUrl && { photoUrl: input.photoUrl }) },
        },
      })
    }, { maxWait: 10_000, timeout: 15_000 })
  } catch (err) {
    // Two taps with the same key raced past the lock check: the first one's refund.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const same = await prisma.terminalCharge.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } })
      if (same && same.targetPaymentId === payment.id) return { view: await chargeView(same, { staff: true }), replay: true }
    }
    throw err
  }
  if (replayed) return { view: await chargeView(charge, { staff: true }), replay: true }

  await pushToMachine(charge, conn)
  await audit({
    category: 'identity', action: 'terminal.refund_start', entity: 'TerminalCharge', entityId: charge.id, userId: a.id, userEmail: a.email, tenantId,
    metadata: { orderId: payment.orderId, paymentId: payment.id, amountCents: input.amountCents, reason: input.reason, photoUrl: input.photoUrl ?? null },
  })
  return { view: await chargeView(await prisma.terminalCharge.findUniqueOrThrow({ where: { id: charge.id } }), { staff: true }), replay: false }
}

// ─── Lists ────────────────────────────────────────────────────────────────────

export async function chargesForOrder(req: FastifyRequest, orderId: string, activeOnly: boolean): Promise<TerminalChargeView[]> {
  const order = await prisma.order.findFirst({ where: { id: orderId, concept: await scopeTenantWhere(req, 'write') }, select: { id: true } })
  if (!order) throw new NotFoundError('Order', orderId)
  const rows = await prisma.terminalCharge.findMany({
    where: {
      orderId,
      ...(await scopeTenantWhere(req, 'write')),
      ...(activeOnly && { status: { in: [...ACTIVE_CHARGE_STATUSES, 'void_pending', 'needs_attention'] } }),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return Promise.all(rows.map((r) => chargeView(r)))
}

// ─── Reconciler (worker) ──────────────────────────────────────────────────────

export interface ReconcileStats { polled: number; recorded: number; reversed: number; escalated: number }

export async function reconcileTerminal(): Promise<ReconcileStats> {
  const now = connectorNow()
  const stats: ReconcileStats = { polled: 0, recorded: 0, reversed: 0, escalated: 0 }
  const dayAgo = new Date(now.getTime() - VERIFY_WINDOW_MS)
  const tenants = await prisma.terminalCharge.findMany({
    where: { status: { in: ['pending', 'sent', 'cancel_requested', 'unknown', 'unverified', 'manual_resolved', 'approved', 'void_pending'] }, createdAt: { gte: new Date(now.getTime() - 2 * VERIFY_WINDOW_MS) } },
    select: { tenantId: true },
    distinct: ['tenantId'],
  })
  for (const { tenantId } of tenants) {
    // Unknown for more than 24 h → a human.
    const stale = await prisma.terminalCharge.findMany({ where: { tenantId, status: 'unknown', createdAt: { lt: dayAgo } }, take: 100 })
    for (const c of stale) {
      const r = await prisma.terminalCharge.updateMany({ where: { id: c.id, status: 'unknown' }, data: { status: 'needs_attention', message: 'No answer from the card processor for 24 hours' } })
      if (r.count > 0) {
        stats.escalated++
        await alertTerminalCharge(c, 'terminal_unreconciled', 'Card charge outcome unknown for 24 hours',
          `servd never learned whether PKR ${(c.amountCents / 100).toFixed(2)} on order ${orderRefOf(c.orderId)} was charged. Check the machine's settlement report, then resolve it in Dev → API → POS connector → Status.`)
      }
    }
    const toPoll = await prisma.terminalCharge.findMany({
      where: {
        tenantId,
        OR: [
          { status: { in: ['sent', 'pending'] }, createdAt: { lt: new Date(now.getTime() - 10_000) } },
          { status: 'cancel_requested' },
          { status: { in: ['unknown', 'unverified', 'manual_resolved'] }, createdAt: { gte: dayAgo } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
      select: { id: true },
    })
    for (const c of toPoll) {
      try { await refreshCharge(c.id, { force: true, via: 'reconciler' }); stats.polled++ } catch (err) { console.warn(`[terminal] poll ${c.id}:`, (err as Error).message) }
    }
    const approved = await prisma.terminalCharge.findMany({ where: { tenantId, status: 'approved', paymentId: null, updatedAt: { lt: new Date(now.getTime() - 5000) } }, take: 100, select: { id: true } })
    for (const c of approved) {
      try { await recordApprovedCharge(c.id); stats.recorded++ } catch (err) { console.warn(`[terminal] record ${c.id}:`, (err as Error).message) }
    }
    const reversing = await prisma.terminalCharge.findMany({ where: { tenantId, status: 'void_pending', OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }] }, take: 100, select: { id: true } })
    for (const c of reversing) {
      try { await reverseCharge(c.id); stats.reversed++ } catch (err) { console.warn(`[terminal] reverse ${c.id}:`, (err as Error).message) }
    }
  }
  return stats
}

/** A new random idempotency key (server-side callers, tests). */
export function newChargeKey(): string {
  return randomBytes(12).toString('hex')
}

// ─── Inbound events (webhook + test simulate) ─────────────────────────────────

/** terminal.charge.updated for THIS connector's company. Foreign / unknown ids are ignored. */
export async function applyTerminalEvent(tenantId: string, chargeId: string, state: ChargeState, via: ChargeVia): Promise<'applied' | 'ignored'> {
  const c = await prisma.terminalCharge.findFirst({ where: { id: chargeId, tenantId }, select: { id: true } })
  if (!c) return 'ignored'
  await applyChargeState(c.id, state, via)
  return 'applied'
}
