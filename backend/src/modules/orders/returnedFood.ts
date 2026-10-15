// Food came back — a delivery the rider brought back undelivered (Delivery &
// customers, resumed 2026-10-15; brief .handoff/parked/2026-10-14/w3-dlv-return.md).
//
// The customer refused it, could not be reached, or something else went wrong
// (our mistake). A manager (RGM / chef / F&B manager — Emergency overrides →
// Food came back; the route lives in modules/emergencyOverrides) logs it here:
//
//   - the order is CANCELLED through the one cancel path (cancelOrder) with
//     the `returned` hook: Order.returnedAt / returnCause stamped, the
//     uncollected cash on delivery (PENDING cash rows) becomes 'failed' with
//     gatewayMeta.voided { reason: 'returned_undelivered' } — nothing posted,
//     nothing was booked for money that never arrived — and the pre-bills are
//     cancelled, all in the cancel's transaction. No fiscal document: there
//     was never a sale.
//   - EVERY live line is wasted 'returned_food' (restoreInventoryForOrder
//     wasteAll — the food left the kitchen in the bag, nothing goes back to
//     the lots): one WasteLog per item and Dr 1290 Stock Differences Suspense
//     / Cr 1210 | 1220 | 1230 by class in the ORDER's company, keyed
//     'pos.void_waste:<orderItemId>' (inventory/voidWaste.ts). A refused
//     posting (closed period) leaves the cancel standing and is flagged
//     posting_failed; Reconciliation → Backfill unposted re-posts it.
//   - money the customer already PAID (a card / Raast / cash ticket) is
//     accepted: the food is wasted either way, and the money goes back through
//     the EXISTING cancelled-ticket hand-back (refundOrder) — the result names
//     refundDueCents so the manager sees it.
//   - after commit: the rider's 'returned' job event (with the manager as
//     actorId), a 'food_returned' exception in the order's company with the
//     waste cost, and — ONLY for cause 'refused' with a customer — one
//     'cod_refused' strike (lib/strikes.ts: one per order; 'unreachable' and
//     'other' are no strike — owner default Q4).
//
// A replay (the order already returned) is 409 ALREADY_RETURNED with no second
// waste, event, flag or strike.

import { serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { cancelOrder, RETURN_CAUSES, type ReturnCause } from './service.js'
import { RETURN_WASTE_REASON } from '../inventory/voidWaste.js'

export { RETURN_CAUSES, type ReturnCause }

const CAUSE_LABEL: Record<ReturnCause, string> = {
  refused: 'refused or would not pay',
  unreachable: 'customer could not be reached',
  other: 'other',
}

export interface ReturnUndeliveredInput {
  actor: { id: string; email: string | null; tenantId: string | null; role: string }
  cause: ReturnCause
  reason: string
  /** A till ('pos') order needs a manager: the actor is one, or this PIN is a same-company manager's. */
  managerOverridePin?: string
}

export interface ReturnUndeliveredResult {
  ok: true
  wasteCostCents: number
  wasteLogIds: string[]
  codVoidedCents: number
  refundDueCents: number
  strike: { recorded: boolean; duplicate: boolean } | null
}

function alreadyReturned(): AppError {
  return new AppError('ALREADY_RETURNED', 'This delivery has already been logged as returned', 409)
}

export async function returnUndeliveredOrder(orderId: string, a: ReturnUndeliveredInput): Promise<ReturnUndeliveredResult> {
  if (!(RETURN_CAUSES as readonly string[]).includes(a.cause)) {
    throw new AppError('VALIDATION_ERROR', `cause must be one of ${RETURN_CAUSES.join(', ')}`, 400)
  }
  const why = a.reason.trim()
  if (!why) throw new AppError('REASON_REQUIRED', 'A reason is required', 422)

  // serviceClient: a fleet rider (another company's) is hidden by RLS. The
  // caller (the Emergency overrides route) resolved the order through its own
  // company scope first.
  const order = await serviceClient.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: {
      id: true, status: true, source: true, fulfilmentType: true, conceptId: true, customerId: true,
      riderId: true, riderAssignedAt: true, pickedUpAt: true, deliveredAt: true, returnedAt: true,
      concept: { select: { tenantId: true } },
    },
  })
  if (!order) throw new NotFoundError('Order', orderId)
  const tenantId = order.concept.tenantId
  if (order.fulfilmentType !== 'delivery') throw new AppError('NOT_A_DELIVERY', 'This order is not a delivery', 422)
  if (order.deliveredAt) throw new AppError('ALREADY_DELIVERED', 'This order has already been delivered', 409)
  if (order.status === 'completed' || order.status === 'refunded') {
    throw new AppError('ORDER_COMPLETED_USE_REFUND', 'This order is already completed — refund it instead of logging it as returned', 409)
  }
  if (order.returnedAt) throw alreadyReturned()
  if (order.status !== 'ready') {
    throw new AppError('ORDER_NOT_ACTIVE', `This order is ${order.status} — only a delivery out with its rider can be logged as returned`, 409)
  }
  if (!order.riderId) throw new AppError('NO_RIDER', 'This order has no rider', 422)
  // An app job (offered through the rider app) must have been picked up; a
  // dispatcher's rider without the app (no riderAssignedAt) passes.
  if (order.riderAssignedAt && !order.pickedUpAt) {
    throw new AppError('NOT_PICKED_UP', 'The rider has not picked this order up yet — cancel it instead', 409)
  }
  const riderId = order.riderId

  // §17.4: a rung-up (till) order is cancelled only with a manager — recorded
  // as the approver like every other void.
  let approverId = a.actor.id
  let viaPin = false
  if (order.source === 'pos') {
    const { requireManagerApproval } = await import('../pos/service.js')
    const r = await requireManagerApproval({
      actorId: a.actor.id, actorRole: a.actor.role, managerOverridePin: a.managerOverridePin,
      tenantId, action: 'Logging a returned delivery', orderId: order.id,
    })
    approverId = r.approverId
    viaPin = r.viaPin
  }

  let claimed: { codVoidedCents: number; codPaymentIds: string[] } | null = null
  try {
    await cancelOrder(order.id, {
      reason: `Returned by rider — ${a.cause}: ${why}`.slice(0, 1000),
      actor: { id: a.actor.id, email: a.actor.email, tenantId },
      approverId,
      action: 'order.returned_by_rider',
      onlyFrom: ['ready'],
      metadata: { returnCause: a.cause, approvedByPin: viaPin, riderId },
      returned: { cause: a.cause, actorId: a.actor.id, onClaimed: (r) => { claimed = r } },
    })
  } catch (err) {
    if (err instanceof AppError && (err.code === 'ORDER_MOVED_ON' || err.code === 'INVALID_TRANSITION')) {
      const now = await serviceClient.order.findUnique({ where: { id: order.id }, select: { returnedAt: true, status: true } })
      if (now?.returnedAt) throw alreadyReturned()
      throw new AppError('ORDER_NOT_ACTIVE', `This order is ${now?.status ?? 'gone'} — only a delivery out with its rider can be logged as returned`, 409)
    }
    throw err
  }
  // Lost a race to a concurrent "Food came back" (or another cancel): the
  // other call did (or did not) do the work — never a second event or strike.
  const won = claimed as { codVoidedCents: number; codPaymentIds: string[] } | null
  if (!won) {
    const now = await serviceClient.order.findUnique({ where: { id: order.id }, select: { returnedAt: true, status: true } })
    if (now?.returnedAt) throw alreadyReturned()
    throw new AppError('ORDER_NOT_ACTIVE', `This order is ${now?.status ?? 'gone'} — only a delivery out with its rider can be logged as returned`, 409)
  }

  // ── After commit ────────────────────────────────────────────────────────
  const lineIds = (await serviceClient.orderItem.findMany({ where: { orderId: order.id }, select: { id: true } })).map((l) => l.id)
  const logs = tenantId && lineIds.length > 0
    ? await serviceClient.wasteLog.findMany({
      where: { tenantId, reason: RETURN_WASTE_REASON, orderItemId: { in: lineIds } },
      select: { id: true, estimatedCostCents: true },
      orderBy: { id: 'asc' },
    })
    : []
  const wasteLogIds = logs.map((l) => l.id)
  const wasteCostCents = logs.reduce((t, l) => t + Math.max(0, l.estimatedCostCents ?? 0), 0)

  // The rider's job event: OUTSIDE the cancel transaction, on serviceClient
  // (dispatch/service.ts) — a fleet rider belongs to another company.
  const rider = await serviceClient.rider.findUnique({ where: { id: riderId }, select: { tenantId: true } })
  const { recordJobEvent } = await import('../dispatch/service.js')
  await recordJobEvent({
    type: 'returned', riderId, orderId: order.id, tenantId, riderTenantId: rider?.tenantId,
    note: `${CAUSE_LABEL[a.cause]}: ${why}`, actorId: a.actor.id,
  }).catch((err) => console.error(`[returnedFood] job event failed for ${order.id}:`, (err as Error).message))

  const { flagException } = await import('../../lib/exceptions.js')
  await flagException({
    tenantId,
    kind: 'food_returned',
    severity: a.cause === 'refused' ? 'high' : 'medium',
    title: `Delivery ${orderRefOf(order.id)} came back — food booked as waste`,
    description: `Returned by the rider (${CAUSE_LABEL[a.cause]}): ${why}`.slice(0, 1000),
    entityType: 'Order',
    entityId: order.id,
    conceptId: order.conceptId,
    actorId: a.actor.id,
    amountCents: wasteCostCents,
    metadata: { cause: a.cause, riderId, wasteLogIds, codVoidedCents: won.codVoidedCents, approverId, approvedByPin: viaPin },
  })

  // Money already taken on the ticket: handed back through the cancelled-ticket
  // refund (refundOrder) — shown, never moved here.
  const after = await serviceClient.order.findUniqueOrThrow({
    where: { id: order.id },
    select: {
      status: true,
      payments: { select: { method: true, status: true, amountCents: true, gatewayRef: true, shiftId: true, raastReceipt: { select: { status: true } } } },
    },
  })
  const { refundDueCents } = await import('../accounting/orderPosting.js')
  const due = refundDueCents(after)

  let strike: { recorded: boolean; duplicate: boolean } | null = null
  if (a.cause === 'refused' && order.customerId) {
    const { recordStrike } = await import('../../lib/strikes.js')
    const s = await recordStrike({
      customerId: order.customerId,
      kind: 'cod_refused',
      sourceType: 'order',
      sourceId: order.id,
      severity: 1,
      reason: why,
      recordedById: a.actor.id,
      ...(tenantId ? { tenantId } : {}),
    })
    strike = { recorded: s.recorded, duplicate: s.duplicate }
  }

  return { ok: true, wasteCostCents, wasteLogIds, codVoidedCents: won.codVoidedCents, refundDueCents: due, strike }
}
