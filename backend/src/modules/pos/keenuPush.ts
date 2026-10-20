// "Push to Keenu" (till flow, owner 2026-10-20 — TILL_FLOW.md §Settle).
//
// One of the two ways a till bill is closed. The bill is sent through the POS
// connector (connectors/, kind 'fiscal' — Keenu is the fiscal POS vendor) to
// the Keenu POS, which takes the money on its own device and settles it; Keenu
// files it with FBR / SRB. servd then:
//   1. records the tender Keenu reports through THE payment path
//      (processPayment, keyed 'keenu:<pushId>' so a retry never pays twice);
//   2. completes the order the usual way (completeOrder) — which creates the
//      sale's ONE FiscalDocument through the outbox; its payload carries
//      `settlement: { channel 'keenu', pushId, providerRef }`, so the Keenu
//      driver files THE bill it settled (never a second invoice). With the
//      TEST driver it is filed with a TEST number.
//   3. revenue → the brand's MAIN sales account (Order.settlementChannel 'keenu').
//
// The vendor seam: FiscalDriver.pushBill / getBillPush (connectors/types.ts).
// The real Keenu driver is one file in connectors/drivers/ + one line in
// registry.ts; until Keenu's API exists the built-in TEST driver settles a
// push at once (settings.test.push: 'settle' | 'decline' | 'pending').
//
// States on Order.settlementMeta.keenu: pending (sent, outcome not known) →
// settled (payment recorded) | declined | failed (vendor never acted) |
// needs_attention (Keenu settled but servd could not record it — flagged).
// A pending push is looked up with checkKeenuPush (the till's "Check" button,
// or a future inbound webhook calling applyKeenuPushOutcome).

import type { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { flagException } from '../../lib/exceptions.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { buildCtx, getConnectorFresh, fiscalDriverOf, connectorNow } from '../../connectors/registry.js'
import { reportingRequiredOf } from '../../connectors/config.js'
import { resolveRegistrations } from '../../connectors/fiscal/payload.js'
import type { BillPushState, Outcome } from '../../connectors/types.js'
import { withTimeout } from '../../connectors/util.js'
import { lockOrderTx, processPayment, repriceForTenderTx, assertTakesMoney } from './service.js'
import { stampSettlementChannelTx } from './tillFlow.js'

export interface KeenuMeta {
  pushId: string
  state: 'pending' | 'settled' | 'declined' | 'failed' | 'needs_attention'
  method: 'cash' | 'card'
  amountCents: number
  tipCents: number
  shiftId: string
  actorId: string
  at: string
  providerRef?: string | null
  approvalRef?: string | null
  reason?: string | null
}

export function keenuMetaOf(meta: unknown): KeenuMeta | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const k = (meta as { keenu?: unknown }).keenu
  return k && typeof k === 'object' && typeof (k as KeenuMeta).pushId === 'string' ? (k as KeenuMeta) : null
}

function withKeenu(meta: unknown, k: KeenuMeta): Prisma.InputJsonObject {
  const base = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {}
  return JSON.parse(JSON.stringify({ ...base, keenu: k })) as Prisma.InputJsonObject
}

async function writeMeta(orderId: string, k: KeenuMeta, clearChannel = false): Promise<void> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { settlementMeta: true } })
  await prisma.order.update({
    where: { id: orderId },
    data: { settlementMeta: withKeenu(o?.settlementMeta, k), ...(clearChannel && { settlementChannel: null }) },
  })
}

/** The company's fiscal connector, able to take a push — else 409. */
async function pushConnector(tenantId: string) {
  const conn = await getConnectorFresh(tenantId, 'fiscal')
  if (!reportingRequiredOf(conn.row.settings)) {
    throw new AppError('KEENU_REPORTING_OFF', 'Fiscal reporting is switched off for this company — close the bill in servd', 409)
  }
  const driver = fiscalDriverOf(conn.row.driver)
  if (!conn.row.enabled || !driver) throw new AppError('KEENU_NOT_AVAILABLE', 'The Keenu POS is not connected for this company — close the bill in servd', 409)
  const caps = (() => { try { return driver.capabilities(buildCtx(conn, 1000)) } catch { return { billPush: false } } })() as { billPush?: boolean }
  if (!driver.pushBill || !caps.billPush) throw new AppError('KEENU_PUSH_UNSUPPORTED', 'This fiscal POS driver cannot take a pushed bill yet — close the bill in servd', 409)
  return { conn, driver }
}

export interface KeenuPushInput {
  orderId: string
  shiftId: string
  method: 'cash' | 'card'
  tipCents?: number
  actor: { id: string; role: string }
}

export type KeenuPushResult =
  | { state: 'settled'; pushId: string; providerRef: string | null; approvalRef: string | null; payments: unknown[]; orderCompleted: boolean; fiscal: unknown; srb: unknown; replayed: boolean }
  | { state: 'pending'; pushId: string }

/**
 * Push the bill to Keenu. The order must be open, unpaid and with nothing
 * pending on it (409 KEENU_WHOLE_BILL — the whole bill goes to Keenu). The
 * bill is re-priced for `method` (cash 15% / card 8% — decision 9) and stamped
 * 'keenu'. A retry while a push is pending re-sends THE SAME push (its pushId);
 * a settled push answers what it recorded.
 */
export async function pushToKeenu(input: KeenuPushInput): Promise<KeenuPushResult> {
  const tip = input.tipCents ?? 0
  if (!Number.isInteger(tip) || tip < 0) throw new AppError('INVALID_TIP', 'A tip is a whole, non-negative amount', 400)
  const head = await prisma.order.findUnique({ where: { id: input.orderId }, select: { concept: { select: { tenantId: true } } } })
  if (!head?.concept.tenantId) throw new NotFoundError('Order', input.orderId)
  const tenantId = head.concept.tenantId
  const { conn, driver } = await pushConnector(tenantId)

  const prepared = await prisma.$transaction(async (tx) => {
    await lockOrderTx(tx, input.orderId)
    const order = await tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      include: {
        payments: { select: { status: true, amountCents: true } },
        items: { where: { status: { not: 'voided' } }, select: { name: true, quantity: true, unitPriceCents: true, modifiers: { select: { priceDeltaCents: true } } } },
        concept: { select: { id: true, name: true, fbrPosId: true, srbPosId: true } },
      },
    })
    const prior = keenuMetaOf(order.settlementMeta)
    if (order.settlementChannel === 'keenu' && prior?.state === 'settled') return { replay: prior }
    if (order.settlementChannel === 'keenu' && prior?.state === 'pending') return { resend: prior, order }
    assertTakesMoney(order.status)
    if (order.status === 'completed') throw new AppError('ORDER_NOT_OPEN', 'This order is already completed', 409)
    if (order.payments.some((p) => (p.status === 'paid' || p.status === 'pending') && p.amountCents > 0)) {
      throw new AppError('KEENU_WHOLE_BILL', 'Money is already taken or waiting on this bill — the whole bill goes to Keenu, or close it in servd', 409)
    }
    if (order.promoDiscountCents > 0 || order.walletAmountCents > 0) {
      throw new AppError('KEENU_WHOLE_BILL', 'A bill carrying wallet or promo credit is closed in servd', 409)
    }
    const due = await repriceForTenderTx(tx, order, [input.method])
    if (due <= 0) throw new AppError('NOTHING_DUE', 'Nothing is due on this order — cancel the ticket instead', 409)
    await stampSettlementChannelTx(tx, order.id, 'keenu')
    const k: KeenuMeta = {
      pushId: `kp_${randomUUID()}`, state: 'pending', method: input.method, amountCents: due + tip, tipCents: tip,
      shiftId: input.shiftId, actorId: input.actor.id, at: connectorNow().toISOString(),
    }
    const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { settlementMeta: true, taxCents: true } })
    await tx.order.update({ where: { id: order.id }, data: { settlementMeta: withKeenu(fresh.settlementMeta, k) } })
    return { push: k, order: { ...order, taxCents: fresh.taxCents } }
  }, { maxWait: 10_000, timeout: 15_000 })

  if ('replay' in prepared && prepared.replay) return settledView(input.orderId, prepared.replay, true)
  const k = 'push' in prepared ? prepared.push! : prepared.resend!
  const order = prepared.order!
  const settings = conn.fiscalSettings
  const outcome = await callDriver(() => driver.pushBill!(buildCtx(conn, settings.syncTimeoutMs), {
    pushId: k.pushId,
    orderId: order.id,
    orderRef: orderRefOf(order.id),
    description: `${order.concept.name} order ${orderRefOf(order.id)}`,
    method: k.method,
    amountCents: k.amountCents,
    tipCents: k.tipCents,
    currency: 'PKR',
    lines: order.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents + i.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0) })),
    taxCents: order.taxCents,
    registrations: resolveRegistrations(settings.outlets, order.concept, order.locationId),
  }), settings.syncTimeoutMs)
  return applyKeenuPushOutcome(order.id, k.pushId, outcome)
}

async function callDriver(fn: () => Promise<Outcome<BillPushState>>, budgetMs: number): Promise<Outcome<BillPushState>> {
  try {
    return await withTimeout(fn(), budgetMs + 250, 'keenu push')
  } catch (err) {
    return { kind: 'unknown', code: 'TIMEOUT', message: (err as Error).message.slice(0, 200) }
  }
}

/**
 * Apply what Keenu answered for a push (the push itself, a lookup, or — later —
 * an inbound webhook). Only the CURRENT push of the order is applied.
 */
export async function applyKeenuPushOutcome(orderId: string, pushId: string, outcome: Outcome<BillPushState>): Promise<KeenuPushResult> {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { settlementMeta: true, settlementChannel: true, conceptId: true, concept: { select: { tenantId: true } } } })
  const k = keenuMetaOf(o.settlementMeta)
  if (!k || k.pushId !== pushId) throw new AppError('KEENU_PUSH_STALE', 'That push is not this bill\'s current push', 409)
  if (k.state === 'settled') return settledView(orderId, k, true)

  if (outcome.kind === 'unknown') {
    // Keenu may have it: stays pending; the till checks it again.
    return { state: 'pending', pushId }
  }
  if (outcome.kind === 'transient') {
    await writeMeta(orderId, { ...k, state: 'failed', reason: outcome.message.slice(0, 200) }, true)
    throw new AppError('KEENU_UNAVAILABLE', `Keenu did not take the bill (${outcome.message.slice(0, 120)}) — try again or close it in servd`, 503)
  }
  if (outcome.kind === 'rejected') {
    await writeMeta(orderId, { ...k, state: 'declined', reason: outcome.message.slice(0, 200) }, true)
    throw new AppError('KEENU_DECLINED', `Keenu refused the bill: ${outcome.message.slice(0, 200)}`, 422)
  }
  const v = outcome.value
  if (v.state === 'declined' || v.state === 'not_found') {
    const reason = v.state === 'declined' ? v.reason : 'Keenu has no such bill'
    await writeMeta(orderId, { ...k, state: 'declined', reason: reason.slice(0, 200) }, true)
    throw new AppError('KEENU_DECLINED', `Keenu did not settle the bill: ${reason.slice(0, 200)}`, 422)
  }
  if (v.state === 'pending') return { state: 'pending', pushId }

  // Settled: what Keenu took must be exactly what was pushed.
  if (v.method !== k.method || Math.abs(v.amountCents - k.amountCents) > 2) {
    await writeMeta(orderId, { ...k, state: 'needs_attention', providerRef: v.providerRef, approvalRef: v.approvalRef, reason: `Keenu settled ${v.method} ${v.amountCents} for a ${k.method} ${k.amountCents} push` })
    await flagException({
      tenantId: o.concept.tenantId, kind: 'fiscal_failed', severity: 'high',
      title: 'Keenu settled a bill for a different amount',
      description: `Order ${orderRefOf(orderId)}: pushed ${k.method} PKR ${(k.amountCents / 100).toFixed(2)}, Keenu settled ${v.method} PKR ${(v.amountCents / 100).toFixed(2)} (ref ${v.approvalRef}). Nothing was recorded in servd — check the Keenu POS and settle the bill by hand.`,
      entityType: 'Order', entityId: orderId, conceptId: o.conceptId, amountCents: v.amountCents,
    })
    throw new AppError('KEENU_AMOUNT_MISMATCH', 'Keenu settled a different amount than the bill — a manager must check it', 409)
  }
  const tip = v.tipCents ?? k.tipCents
  let result: Awaited<ReturnType<typeof processPayment>>
  try {
    result = await processPayment({
      orderId,
      shiftId: k.shiftId,
      actorId: k.actorId,
      idempotencyKey: `keenu:${pushId}`,
      keenuPushId: pushId,
      payments: [{
        method: v.method, amountCents: v.amountCents, tipCents: tip, gatewayRef: v.approvalRef, gateway: 'none', keenuPushId: pushId,
        ...(v.method === 'cash' && { tenderedCents: v.amountCents }),
      }],
    })
  } catch (err) {
    await writeMeta(orderId, { ...k, state: 'needs_attention', providerRef: v.providerRef, approvalRef: v.approvalRef, reason: (err as Error).message.slice(0, 200) })
    await flagException({
      tenantId: o.concept.tenantId, kind: 'fiscal_failed', severity: 'high',
      title: 'Keenu settled a bill servd could not record',
      description: `Order ${orderRefOf(orderId)}: Keenu settled PKR ${(v.amountCents / 100).toFixed(2)} (${v.method}, ref ${v.approvalRef}) but servd refused the payment (${(err as Error).message.slice(0, 200)}). Fix the cause and press Check on the till.`,
      entityType: 'Order', entityId: orderId, conceptId: o.conceptId, amountCents: v.amountCents,
    })
    throw err
  }
  const settled: KeenuMeta = { ...k, state: 'settled', providerRef: v.providerRef, approvalRef: v.approvalRef, reason: null }
  await writeMeta(orderId, settled)
  return { state: 'settled', pushId, providerRef: v.providerRef, approvalRef: v.approvalRef, payments: result.payments, orderCompleted: result.orderCompleted, fiscal: result.fiscal, srb: result.srb, replayed: result.replayed }
}

/** Look a pending push up (getBillPush) and apply the answer. */
export async function checkKeenuPush(orderId: string): Promise<KeenuPushResult | { state: KeenuMeta['state']; pushId: string }> {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { settlementMeta: true, concept: { select: { tenantId: true } } } })
  const k = keenuMetaOf(o.settlementMeta)
  if (!k) throw new AppError('NO_KEENU_PUSH', 'This bill was not pushed to Keenu', 404)
  if (k.state === 'settled') return settledView(orderId, k, true)
  if (k.state !== 'pending' && k.state !== 'needs_attention') return { state: k.state, pushId: k.pushId }
  const { conn, driver } = await pushConnector(o.concept.tenantId!)
  if (!driver.getBillPush) return { state: 'pending', pushId: k.pushId }
  const outcome = await callDriver(() => driver.getBillPush!(buildCtx(conn, conn.fiscalSettings.syncTimeoutMs), { pushId: k.pushId, ...(k.providerRef && { providerRef: k.providerRef }) }), conn.fiscalSettings.syncTimeoutMs)
  if (k.state === 'needs_attention') await writeMeta(orderId, { ...k, state: 'pending' })
  return applyKeenuPushOutcome(orderId, k.pushId, outcome)
}

async function settledView(orderId: string, k: KeenuMeta, replayed: boolean): Promise<KeenuPushResult> {
  const { fiscalViewForOrder, legacySrbAlias } = await import('../../connectors/fiscal/view.js')
  const [payments, order, fiscal] = await Promise.all([
    prisma.payment.findMany({ where: { orderId, gatewayMeta: { path: ['keenuPush', 'pushId'], equals: k.pushId } } }),
    prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } }),
    fiscalViewForOrder(orderId, 'sale', { staff: true }).catch(() => null),
  ])
  return {
    state: 'settled', pushId: k.pushId, providerRef: k.providerRef ?? null, approvalRef: k.approvalRef ?? null,
    payments, orderCompleted: order.status === 'completed', fiscal, srb: legacySrbAlias(fiscal), replayed,
  }
}

/** The till's view of a bill's Keenu push (GET). */
export async function keenuPushView(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { settlementChannel: true, settlementMeta: true } })
  const k = keenuMetaOf(o.settlementMeta)
  return {
    settlementChannel: o.settlementChannel,
    push: k ? { pushId: k.pushId, state: k.state, method: k.method, amountCents: k.amountCents, tipCents: k.tipCents, at: k.at, approvalRef: k.approvalRef ?? null, reason: k.reason ?? null } : null,
  }
}
