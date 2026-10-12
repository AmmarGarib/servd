// W4 — Keenu callbacks never touch a card-machine payment (spec D12, §7.12).
//
// A payment taken on the card machine (gateway 'card_terminal', or a legacy
// 'none' row carrying gatewayMeta.terminalChargeId) is settled by the POS
// connector alone. If the processor behind the machine is also Keenu, a Keenu
// callback can carry the same transaction id as the machine's approval
// reference — it must never settle, fail or mark that payment refunded (a
// double settlement, or a sale knocked back to "failed"). Keenu's own rows
// still settle exactly as before. Two companies: B's callbacks never reach A.
import { describe, it, expect, beforeAll } from 'vitest'
import { applyKeenuCallback, isKeenuRow } from '../src/modules/paymentGateways/keenuSettle.js'
import { prisma, mkCompany, type Company } from './connectorsFixtures.js'

let A: Company, B: Company

beforeAll(async () => {
  A = await mkCompany('keenusep-a', { srbPosId: 9101 })
  B = await mkCompany('keenusep-b', { srbPosId: 9102 })
}, 60_000)

async function order(co: Company, payment: { gateway: 'card_terminal' | 'keenu' | 'none'; status: 'paid' | 'pending'; ref: string; meta?: Record<string, unknown> }) {
  return prisma.order.create({
    data: {
      conceptId: co.conceptId, source: 'pos', fulfilmentType: 'takeout',
      status: payment.status === 'paid' ? 'completed' : 'received', completedAt: payment.status === 'paid' ? new Date() : null,
      totalCents: 59_400, taxCents: 4_400, taxRatePct: 8,
      items: { create: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000 }] },
      payments: { create: [{ method: 'card', amountCents: 59_400, status: payment.status, gateway: payment.gateway, gatewayRef: payment.ref, ...(payment.meta && { gatewayMeta: payment.meta }), processedAt: payment.status === 'paid' ? new Date() : null }] },
    },
    include: { payments: true },
  })
}

describe('a Keenu callback and a card-machine payment with the same reference', () => {
  it('SUCCESS / FAILED / REFUNDED never touch a card_terminal payment', async () => {
    const ref = 'TSTAPPROVAL1'
    const o = await order(A, { gateway: 'card_terminal', status: 'paid', ref, meta: { terminalChargeId: 'tc-1', authCode: '123456' } })
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: o.payments[0]!.id } })
    for (const status of ['SUCCESS', 'FAILED', 'REFUNDED']) {
      expect(await applyKeenuCallback({ orderId: o.id, transactionId: ref, status, amount: 59_400 })).toEqual({ result: 'unmatched' })
    }
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: o.payments[0]!.id } })
    expect(after).toMatchObject({ status: 'paid', gateway: 'card_terminal', gatewayRef: ref })
    expect(after.gatewayMeta).toEqual(before.gatewayMeta)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
  })

  it('a still-pending card_terminal row is not settled by a Keenu SUCCESS either', async () => {
    const ref = 'TSTAPPROVAL2'
    const o = await order(A, { gateway: 'card_terminal', status: 'pending', ref, meta: { terminalChargeId: 'tc-2' } })
    expect(await applyKeenuCallback({ orderId: o.id, transactionId: ref, status: 'SUCCESS', amount: 59_400 })).toEqual({ result: 'unmatched' })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: o.payments[0]!.id } })).status).toBe('pending')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('received')
  })

  it('a legacy \'none\' row that is a card-machine charge (terminalChargeId in its meta) is ignored too', async () => {
    const ref = 'TSTAPPROVAL3'
    const o = await order(A, { gateway: 'none', status: 'paid', ref, meta: { terminalChargeId: 'tc-3' } })
    expect(await applyKeenuCallback({ orderId: o.id, transactionId: ref, status: 'FAILED' })).toEqual({ result: 'unmatched' })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: o.payments[0]!.id } })).status).toBe('paid')
  })

  it('Keenu\'s own rows still settle (and a REFUNDED note keeps the row\'s own meta)', async () => {
    const o = await order(A, { gateway: 'keenu', status: 'pending', ref: 'KN-OWN-1', meta: { idempotencyKey: 'keep-me' } })
    expect(await applyKeenuCallback({ orderId: o.id, transactionId: 'KN-OWN-1', status: 'SUCCESS', amount: 59_400 }))
      .toMatchObject({ result: 'settled', orderCompleted: true })
    expect(await applyKeenuCallback({ orderId: o.id, transactionId: 'KN-OWN-1', status: 'REFUNDED' })).toMatchObject({ result: 'refunded' })
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: o.payments[0]!.id } })
    expect(p.status).toBe('paid')
    expect(p.gatewayMeta).toMatchObject({ idempotencyKey: 'keep-me', keenu: { status: 'REFUNDED' } })
    // A legacy manual card slip (gateway none, no charge) is still Keenu's to confirm.
    expect(isKeenuRow({ gateway: 'none', gatewayMeta: { idempotencyKey: 'x' } })).toBe(true)
    expect(isKeenuRow({ gateway: 'card_terminal', gatewayMeta: null })).toBe(false)
  })

  it('a callback naming company A\'s order with B\'s reference matches nothing in A', async () => {
    const a = await order(A, { gateway: 'keenu', status: 'pending', ref: 'KN-A-1' })
    const b = await order(B, { gateway: 'keenu', status: 'pending', ref: 'KN-B-1' })
    expect(await applyKeenuCallback({ orderId: a.id, transactionId: 'KN-B-1', status: 'SUCCESS' })).toEqual({ result: 'unmatched' })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: a.payments[0]!.id } })).status).toBe('pending')
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: b.payments[0]!.id } })).status).toBe('pending')
  })
})
