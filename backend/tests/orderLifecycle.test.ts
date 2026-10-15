// Order lifecycle: the one cancel path, same-state writes, and the till's
// policy readers.
//
// What this guards:
//   - cancelOrder is the only way an order ends without a sale, and every
//     entry point (manager cancel, expo reject, food a rider brought back —
//     orders/returnedFood.ts, see foodReturned.test.ts — the auto-cancel
//     sweep) gets the same effects: cancelledAt + reason on the
//     order, the wallet / gift card given back, a promo usage released, one
//     audit entry — exactly once, however often it is called.
//   - 'rejected' restores what the customer paid, like 'cancelled'.
//   - A same-state status write is a no-op: a second 'completed' does not
//     award the loyalty points again.
//   - The auto-cancel sweep leaves an order alone once the kitchen has moved it.
//   - The till reads its policies (service charge, void caps, drawer-variance
//     limit) through lib/setup-config for the order's / shift's own company.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { cancelOrder, updateOrderStatus, updateItemStatus } from '../src/modules/orders/service.js'
import { runCancelSweep } from '../src/workers/orderAutoCancel.js'
import { createPosOrder, voidOrderItem, closeShift } from '../src/modules/pos/service.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'

let tenantA: string
let tenantB: string
let conceptId: string
let staffId: string

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 4000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
    v = await read()
  }
  return v
}
const settle = () => new Promise((r) => setTimeout(r, 300))

// The customer's wallet at the brand's company (ONL-R2-01: the wallet is per
// company; Customer.walletBalance is retired).
async function walletOf(customerId: string) {
  const concept = await prisma.concept.findUniqueOrThrow({ where: { id: conceptId }, select: { tenantId: true } })
  const w = await prisma.customerWallet.findUnique({ where: { tenantId_customerId: { tenantId: concept.tenantId!, customerId } } })
  return { walletBalance: w?.balanceCents ?? 0 }
}

async function customer(walletBalance = 0) {
  return prisma.customer.create({
    data: { name: 'Guest', phone: `+92300${Math.floor(Math.random() * 1e7)}`, walletBalance },
  })
}

async function order(data: Partial<{ status: 'received' | 'confirmed' | 'preparing' | 'ready' | 'completed'; customerId: string; walletAmountCents: number; promoCodeId: string; placedAt: Date; source: 'servd' | 'pos' }> = {}) {
  return prisma.order.create({
    data: {
      conceptId,
      source: data.source ?? 'servd',
      status: data.status ?? 'received',
      totalCents: 100_000,
      customerId: data.customerId ?? null,
      walletAmountCents: data.walletAmountCents ?? 0,
      promoCodeId: data.promoCodeId ?? null,
      placedAt: data.placedAt ?? new Date(),
      items: { create: [{ name: 'Club sandwich', quantity: 1, unitPriceCents: 100_000 }] },
    },
    include: { items: true },
  })
}

beforeAll(async () => {
  // B is created first so it is the "primary" company — the fallback a
  // company-less read would land on. Everything below must read A's rows.
  tenantB = (await prisma.tenant.create({ data: { name: 'Lifecycle B', slug: 'lifecycle-b' } })).id
  tenantA = (await prisma.tenant.create({ data: { name: 'Lifecycle A', slug: 'lifecycle-a' } })).id
  conceptId = (await prisma.concept.create({
    data: { name: 'Lifecycle Cafe', slug: 'lifecycle-cafe', type: 'restaurant', tenantId: tenantA, taxRateCash: 0, taxRateCard: 0 },
  })).id
  staffId = (await prisma.user.create({
    data: { name: 'Cashier', email: 'lifecycle-cashier@test.local', password: 'x', role: 'cashier', tenantId: tenantB },
  })).id
})

afterAll(async () => {
  invalidateSetupCache()
})

describe('cancelOrder — the one way an order ends without a sale', () => {
  it('stamps the reason, gives back the wallet, releases the promo, audits once', async () => {
    const c = await customer(0)
    const promo = await prisma.promoCode.create({
      data: { code: 'LIFE10', discountValue: 10, startAt: new Date(Date.now() - 1e7), endAt: new Date(Date.now() + 1e7), maxUsageCount: 5, usedCount: 1 },
    })
    const o = await order({ customerId: c.id, walletAmountCents: 25_000, promoCodeId: promo.id })
    await prisma.promoCodeUsage.create({ data: { promoCodeId: promo.id, customerId: c.id, orderId: o.id, discountCents: 10_000 } })

    const actor = { id: staffId, email: 'lifecycle-cashier@test.local', tenantId: tenantA }
    const updated = await cancelOrder(o.id, { reason: 'Customer called to cancel', actor })
    expect(updated.status).toBe('cancelled')
    expect(updated.cancelledAt).toBeInstanceOf(Date)
    expect(updated.cancellationReason).toBe('Customer called to cancel')

    const cust = await waitFor(() => walletOf(c.id), (x) => x.walletBalance === 25_000)
    expect(cust.walletBalance).toBe(25_000)
    const p = await waitFor(() => prisma.promoCode.findUniqueOrThrow({ where: { id: promo.id } }), (x) => x.usedCount === 0)
    expect(p.usedCount).toBe(0)
    expect(await prisma.promoCodeUsage.count({ where: { orderId: o.id } })).toBe(0)

    // Again: a no-op, not a second cancellation.
    await cancelOrder(o.id, { reason: 'Double tap', actor })
    await settle()
    expect((await walletOf(c.id)).walletBalance).toBe(25_000)
    expect((await prisma.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).usedCount).toBe(0)
    expect(await prisma.walletTransaction.count({ where: { orderId: o.id, type: 'refund' } })).toBe(1)
    const audits = await prisma.auditLog.findMany({ where: { entity: 'Order', entityId: o.id } })
    expect(audits.map((a) => a.action)).toEqual(['order.cancel'])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).cancellationReason).toBe('Customer called to cancel')
  })

  it('a rejected order gives back the wallet and gift card too', async () => {
    const c = await customer(0)
    const o = await order({ customerId: c.id, walletAmountCents: 5_000 })
    const card = await prisma.giftCard.create({ data: { code: 'GS-LIFE-0001', issuedAmountCents: 50_000, balanceCents: 30_000 } })
    await prisma.giftCardRedemption.create({ data: { giftCardId: card.id, orderId: o.id, amountCents: 20_000, balanceAfter: 30_000 } })

    const updated = await cancelOrder(o.id, { status: 'rejected', reason: 'Out of bread', actor: null, action: 'expo.reject' })
    expect(updated.status).toBe('rejected')
    expect(updated.cancellationReason).toBe('Out of bread')

    const g = await waitFor(() => prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } }), (x) => x.balanceCents === 50_000)
    expect(g.balanceCents).toBe(50_000)
    const cust = await waitFor(() => walletOf(c.id), (x) => x.walletBalance === 5_000)
    expect(cust.walletBalance).toBe(5_000)
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: o.id } })).action).toBe('expo.reject')
  })

  it('requires a reason', async () => {
    const o = await order()
    await expect(cancelOrder(o.id, { reason: '   ', actor: null })).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('received')
  })

  it('refuses to cancel a completed sale — that is a refund', async () => {
    const o = await order({ status: 'completed' })
    await expect(cancelOrder(o.id, { reason: 'Changed mind', actor: null })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
  })

  it('onlyFrom: leaves an order alone once it has moved on', async () => {
    const o = await order({ status: 'confirmed' })
    await expect(cancelOrder(o.id, { reason: 'auto_cancelled_timeout', actor: null, onlyFrom: ['received'] }))
      .rejects.toMatchObject({ code: 'ORDER_MOVED_ON' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('confirmed')
  })
})

describe('auto-cancel sweep', () => {
  it('cancels a stalled digital order through cancelOrder, restoring the wallet', async () => {
    const c = await customer(0)
    const o = await order({ customerId: c.id, walletAmountCents: 7_500, placedAt: new Date(Date.now() - 45 * 60_000) })
    const fresh = await order({ placedAt: new Date() })

    await runCancelSweep()

    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.status).toBe('cancelled')
    expect(after.cancellationReason).toBe('auto_cancelled_timeout')
    expect(after.cancelledAt).toBeInstanceOf(Date)
    const cust = await waitFor(() => walletOf(c.id), (x) => x.walletBalance === 7_500)
    expect(cust.walletBalance).toBe(7_500)
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: o.id } })).action).toBe('order.auto_cancel')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('received')
  })
})

describe('same-state writes are no-ops', () => {
  it('a second "completed" does not award the loyalty points again', async () => {
    const c = await customer(0)
    const o = await order({ status: 'ready', customerId: c.id })

    await updateOrderStatus(o.id, 'completed')
    const earned = await waitFor(
      () => prisma.loyaltyTransaction.findMany({ where: { orderId: o.id, type: 'earn' } }),
      (x) => x.length > 0,
    )
    expect(earned).toHaveLength(1)
    const first = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })

    const again = await updateOrderStatus(o.id, 'completed')
    await settle()
    expect(again.status).toBe('completed')
    expect(await prisma.loyaltyTransaction.count({ where: { orderId: o.id, type: 'earn' } })).toBe(1)
    // One account per company; this customer only has the order's company's.
    const account = await prisma.loyaltyAccount.findFirstOrThrow({ where: { customerId: c.id } })
    expect(account.pointsBalance).toBe(earned[0]!.pointsDelta)
    // completedAt is not re-stamped either.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).completedAt).toEqual(first.completedAt)
  })
})

describe('item voids go through the POS void only', () => {
  it('the kitchen status path refuses a void (no cap, PIN, reason or audit there)', async () => {
    const o = await order({ status: 'preparing' })
    await expect(updateItemStatus(o.items[0]!.id, 'voided' as never)).rejects.toMatchObject({ code: 'USE_POS_VOID' })
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } })
    expect(item.status).toBe('pending')
    expect(item.voidedAt).toBeNull()
  })
})

describe('till policy readers — lib/setup-config, for the right company', () => {
  it('service charge comes from the brand company\'s operations config', async () => {
    await prisma.operationsConfig.create({ data: { scope: 'global', scopeId: null, tenantId: tenantA, serviceChargePct: 0.1 } })
    await prisma.operationsConfig.create({ data: { scope: 'global', scopeId: null, tenantId: tenantB, serviceChargePct: 0 } })
    invalidateSetupCache()
    const o = await createPosOrder({
      conceptId, staffId, staffRole: 'cashier',
      items: [{ menuItemId: null, name: 'Latte', quantity: 2, unitPriceCents: 50_000, modifiers: [] }],
    })
    expect(o.serviceChargeCents).toBe(10_000)
    expect(o.totalCents).toBe(110_000)
  })

  it('void caps come from the order company\'s refund policy (and a cashier never voids alone — §17.4)', async () => {
    // A's manager cap covers the line, B's does not: the ORDER's company decides.
    await prisma.refundPolicy.create({ data: { scope: 'global', scopeId: null, tenantId: tenantA, cashierVoidLimitCents: 200_000, managerVoidLimitCents: 200_000 } })
    await prisma.refundPolicy.create({ data: { scope: 'global', scopeId: null, tenantId: tenantB, cashierVoidLimitCents: 0, managerVoidLimitCents: 0 } })
    invalidateSetupCache()
    const o = await order({ status: 'preparing', source: 'pos' })
    // Even under a generous cashier cap, a cashier with no manager PIN is refused (the cashier void cap is treated as 0).
    await expect(voidOrderItem({
      orderId: o.id, orderItemId: o.items[0]!.id, reason: 'Wrong item rung', actorId: staffId, actorRole: 'cashier',
    })).rejects.toMatchObject({ code: 'MANAGER_OVERRIDE_REQUIRED', statusCode: 403 })
    const voided = await voidOrderItem({
      orderId: o.id, orderItemId: o.items[0]!.id, reason: 'Wrong item rung', actorId: staffId, actorRole: 'foh_management',
    })
    expect(voided.status).toBe('voided')
    expect(voided.voidReason).toBe('Wrong item rung')
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order_item_void', entityId: o.items[0]!.id } })
    expect((log.metadata as { approverId?: string }).approverId).toBe(staffId)
    expect(await prisma.auditLog.count({ where: { action: 'order_item_void', entityId: o.items[0]!.id } })).toBe(1)
  })

  it('shift close reads the drawer-variance limit of the shift\'s own company', async () => {
    // The cashier's primary company is B (limit huge); the shift was opened in
    // A (limit 0). Any variance must be judged by A's limit.
    await prisma.receiptConfig.create({ data: { scope: 'global', scopeId: null, tenantId: tenantA, cashVarianceLimitCents: 0 } })
    await prisma.receiptConfig.create({ data: { scope: 'global', scopeId: null, tenantId: tenantB, cashVarianceLimitCents: 10_000_000 } })
    invalidateSetupCache()
    const shift = await prisma.shift.create({ data: { userId: staffId, openingFloatCents: 0, status: 'open', tenantId: tenantA } })
    await closeShift(shift.id, 5_000)
    const flags = await prisma.exceptionFlag.findMany({ where: { kind: 'cash_variance', entityId: shift.id } })
    expect(flags).toHaveLength(1)
  })
})
