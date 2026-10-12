// TILL-R2 (2026-10-11) — the gift-card tender and a cash tender landing on
// the same bill at once. The redeem used to read the bill unlocked in a
// transaction of its own: a cash payment committing alongside it left the
// bill paid in full AND the card drained (guest charged twice, 2080 cleared
// for nothing).
//
// The till's tender (pos/service.applyGiftCardTender) now runs the redeem,
// the bill and the coverage in ONE transaction under the order lock, through
// the engine's tx-bound redeem `redeemGiftCardTx` (giftCards/service.ts).
// Until that module exports it, this file supplies a reference version (the
// engine's own rules, plus the order lock and a re-read under it) so the
// till's side is proven now; once the real one lands it is used instead.
//
// Two companies: company B's card is unknown on company A's bill.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'

type Tx = Prisma.TransactionClient
type RedeemInput = { code: string; orderId: string; amountCents?: number; redeemedById?: string | null }

vi.mock('../src/modules/giftCards/service.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>()
  if (typeof orig['redeemGiftCardTx'] === 'function') return orig
  const { AppError, NotFoundError } = await import('../src/lib/errors.js')
  /** Reference: the engine's redeem inside the caller's tx, under the order lock. */
  async function redeemGiftCardTx(tx: Tx, input: RedeemInput) {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${input.orderId} FOR UPDATE`
    const code = input.code.trim().toUpperCase()
    const order = await tx.order.findFirst({
      where: { id: input.orderId, deletedAt: null },
      select: { id: true, status: true, totalCents: true, concept: { select: { tenantId: true } }, payments: { where: { status: 'paid' }, select: { amountCents: true } } },
    })
    if (!order || !order.concept.tenantId) throw new NotFoundError('Order', input.orderId)
    if (['completed', 'cancelled', 'rejected', 'refunded'].includes(order.status)) {
      throw new AppError('ORDER_NOT_OPEN', 'That order is already closed — a gift card cannot be applied to it.', 422)
    }
    const tenantId = order.concept.tenantId
    const outstanding = Math.max(0, order.totalCents - order.payments.reduce((s, p) => s + p.amountCents, 0))
    const card = await tx.giftCard.findFirst({ where: { code, tenantId } })
    if (!card) throw new NotFoundError('GiftCard', code)
    const apply = Math.min(input.amountCents ?? card.balanceCents, card.balanceCents, outstanding)
    if (apply <= 0) throw new AppError(outstanding <= 0 ? 'NOTHING_DUE' : 'INSUFFICIENT_BALANCE', 'Nothing to apply', 422)
    const dec = await tx.giftCard.updateMany({ where: { id: card.id, tenantId, status: 'active', balanceCents: { gte: apply } }, data: { balanceCents: { decrement: apply } } })
    if (dec.count === 0) throw new AppError('INSUFFICIENT_BALANCE', 'The card balance changed — try again', 409)
    const after = await tx.giftCard.findUniqueOrThrow({ where: { id: card.id }, select: { balanceCents: true } })
    const redemption = await tx.giftCardRedemption.create({ data: { giftCardId: card.id, orderId: order.id, amountCents: apply, balanceAfter: after.balanceCents, redeemedById: input.redeemedById ?? null } })
    await tx.order.update({ where: { id: order.id }, data: { totalCents: { decrement: apply } } })
    return { appliedCents: apply, remainingDueCents: outstanding - apply, cardBalanceCents: after.balanceCents, redemptionId: redemption.id, orderTenantId: tenantId }
  }
  return { ...orig, redeemGiftCardTx }
})

const { applyGiftCardTender } = await import('../src/modules/pos/service.js')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let tenantA: string, tenantB: string, conceptA: string, cashierA: string, drawerA: string

async function tillBill(totalCents: number) {
  return prisma.order.create({
    data: { conceptId: conceptA, source: 'pos', fulfilmentType: 'dine_in', status: 'received', totalCents, taxCents: 0, shiftId: drawerA, posStaffId: cashierA },
  })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods', slug: 'tillgc-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Grill Co', slug: 'tillgc-b' } })).id
  await ensureChartOfAccounts(tenantA)
  conceptA = (await prisma.concept.create({ data: { name: 'Simmer', slug: 'simmer-gc', type: 'restaurant', tenantId: tenantA, taxRate: 17, taxRateCash: 15, taxRateCard: 8 } })).id
  cashierA = (await prisma.user.create({ data: { name: 'cashier', email: 'cashier.tillgc@gsfoods.pk', password: 'x', role: 'cashier', isActive: true, accountStatus: 'active', tenantId: tenantA } })).id
  drawerA = (await prisma.shift.create({ data: { userId: cashierA, openingFloatCents: 0, status: 'open', tenantId: tenantA } })).id
}, 60_000)

describe('TILL-R2 — a gift-card tender racing a cash tender on the same bill', () => {
  it('the cash commits first: the card is not touched and the bill stands', async () => {
    const o = await tillBill(63_250)
    await prisma.giftCard.create({ data: { tenantId: tenantA, code: 'GS-RACE-0001', issuedAmountCents: 50_000, balanceCents: 50_000 } })

    // The cash tender: holds the order lock while it pays the bill in full.
    const cash = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${o.id} FOR UPDATE`
      await sleep(250)
      await tx.payment.create({ data: { orderId: o.id, shiftId: drawerA, method: 'cash', amountCents: 63_250, status: 'paid', processedAt: new Date() } })
      await tx.order.update({ where: { id: o.id }, data: { status: 'completed', completedAt: new Date() } })
    }, { timeout: 10_000 })
    await sleep(60)
    // The gift card arrives while the cash is still in flight.
    const card = applyGiftCardTender({ orderId: o.id, code: 'GS-RACE-0001', staffId: cashierA }).then(
      (r) => ({ ok: true as const, r }),
      (e: { code?: string }) => ({ ok: false as const, code: e.code }),
    )
    await cash
    const res = await card

    expect(res).toEqual({ ok: false, code: 'ORDER_NOT_OPEN' })
    const gc = await prisma.giftCard.findFirstOrThrow({ where: { code: 'GS-RACE-0001' } })
    expect(gc.balanceCents).toBe(50_000)
    expect(await prisma.giftCardRedemption.count({ where: { orderId: o.id } })).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).totalCents).toBe(63_250)
  })

  it('the card goes first: it pays its share, the bill comes down, and covering it completes the sale', async () => {
    const o = await tillBill(63_250)
    await prisma.giftCard.create({ data: { tenantId: tenantA, code: 'GS-RACE-0002', issuedAmountCents: 20_000, balanceCents: 20_000 } })
    const r = await applyGiftCardTender({ orderId: o.id, code: 'GS-RACE-0002', staffId: cashierA })
    expect(r).toMatchObject({ appliedCents: 20_000, remainingDueCents: 43_250, completed: false })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).totalCents).toBe(43_250)

    // A card that covers everything left completes the till sale in the same transaction.
    const o2 = await tillBill(15_000)
    await prisma.giftCard.create({ data: { tenantId: tenantA, code: 'GS-RACE-0003', issuedAmountCents: 20_000, balanceCents: 20_000 } })
    const r2 = await applyGiftCardTender({ orderId: o2.id, code: 'GS-RACE-0003', staffId: cashierA })
    expect(r2).toMatchObject({ appliedCents: 15_000, remainingDueCents: 0, completed: true })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o2.id } })).status).toBe('completed')
  })

  it("company B's card is unknown on company A's bill, and nothing moves", async () => {
    const o = await tillBill(10_000)
    await prisma.giftCard.create({ data: { tenantId: tenantB, code: 'KG-RACE-0001', issuedAmountCents: 10_000, balanceCents: 10_000 } })
    await expect(applyGiftCardTender({ orderId: o.id, code: 'KG-RACE-0001', staffId: cashierA })).rejects.toMatchObject({ statusCode: 404 })
    expect((await prisma.giftCard.findFirstOrThrow({ where: { code: 'KG-RACE-0001' } })).balanceCents).toBe(10_000)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).totalCents).toBe(10_000)
  })
})
