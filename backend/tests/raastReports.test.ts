// Raast QR — sales by tender (spec §7.6; stream D).
//
//   - GET /reports/by-tender: paid receipts by method (Cash paid into a
//     drawer, Card – Keenu, Raast QR, the retired Keenu QR's old rows), cash
//     on delivery not yet in a drawer as its own row, wallet, gift cards;
//     sharePct of the money tenders; comps apart;
//     Raast split provisional / matched / not received; refunds by tender
//   - volume only for report readers who don't see revenue
//   - company scope: B never sees A's sales; a foreign brand is 404
//   - getOrder carries each payment's Raast receipt state
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomBytes } from 'node:crypto'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { prisma, mkCompany, mkUser, mkOrder, mkRaastAccount, type Company, type Who } from './connectorsFixtures.js'
import { reportRoutes } from '../src/modules/reports/routes.js'
import { getOrder } from '../src/modules/orders/service.js'

let app: FastifyInstance
let A: Company
let B: Company
let financeA: Who, managerA: Who, financeB: Who
let bankA: { bankAccountId: string; ledgerCode: string }

const DAY = '2026-10-10'
const call = (who: Who, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${who.token}` } })

const item = (co: Company, cents: number) => [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: cents }]

async function raastSale(co: Company, cents: number, status: 'provisional' | 'matched' | 'unreceived') {
  const orderId = await mkOrder(co, { items: item(co, cents), taxCents: 0, taxRatePct: 8, totalCents: cents, payments: [{ method: 'raast', amountCents: cents }] })
  const p = await prisma.payment.findFirstOrThrow({ where: { orderId } })
  const ref = `RPT${randomBytes(5).toString('hex').replace(/[^0-9]/g, '4').slice(0, 9)}`
  await prisma.payment.update({ where: { id: p.id }, data: { gateway: 'raast', gatewayRef: ref } })
  await prisma.raastReceipt.create({
    data: {
      tenantId: co.tenantId, orderId, conceptId: co.conceptId, paymentId: p.id, bankAccountId: bankA.bankAccountId, ledgerCode: bankA.ledgerCode,
      amountCents: cents, dueCents: cents, bankRef: ref, status, confirmedVia: 'cashier', confirmedAt: new Date(), cashierVerified: true,
      idempotencyKey: `pay:${p.id}`, createdById: financeA.id, ...(status === 'matched' && { matchedAt: new Date() }),
    },
  })
  return orderId
}

beforeAll(async () => {
  A = await mkCompany('rrep-a')
  B = await mkCompany('rrep-b')
  financeA = await mkUser('rp-fin-a', 'finance', A.tenantId)
  managerA = await mkUser('rp-mgr-a', 'manager', A.tenantId)
  financeB = await mkUser('rp-fin-b', 'finance', B.tenantId)
  bankA = await mkRaastAccount(A, { code: '1021' })

  // Company A, 2026-10-10:
  //   cash 1,000 · card 2,000 · Raast 3,000 (provisional) + 1,500 (matched) + 500 (not received)
  //   keenu_qr (retired, old row) 400 · comp 700 · wallet 600 on a cash order of 100
  //   a split bill: card 800 + Raast 200 (provisional)
  //   a delivery order with cash on delivery still pending: 900
  await mkOrder(A, { items: item(A, 100_000), taxCents: 0, taxRatePct: 15, totalCents: 100_000, payments: [{ method: 'cash', amountCents: 100_000 }] })
  await mkOrder(A, { items: item(A, 200_000), taxCents: 0, taxRatePct: 8, totalCents: 200_000, payments: [{ method: 'card', amountCents: 200_000 }] })
  await raastSale(A, 300_000, 'provisional')
  await raastSale(A, 150_000, 'matched')
  await raastSale(A, 50_000, 'unreceived')
  await mkOrder(A, { items: item(A, 40_000), taxCents: 0, taxRatePct: 8, totalCents: 40_000, payments: [{ method: 'keenu_qr', amountCents: 40_000 }] })
  await mkOrder(A, { items: item(A, 70_000), taxCents: 0, taxRatePct: 0, totalCents: 70_000, payments: [{ method: 'comp', amountCents: 70_000 }] })
  const walletOrder = await mkOrder(A, { items: item(A, 70_000), taxCents: 0, taxRatePct: 15, totalCents: 10_000, payments: [{ method: 'cash', amountCents: 10_000 }] })
  await prisma.order.update({ where: { id: walletOrder }, data: { walletAmountCents: 60_000 } })

  const split = await mkOrder(A, {
    items: item(A, 100_000), taxCents: 0, taxRatePct: 8, totalCents: 100_000,
    payments: [{ method: 'card', amountCents: 80_000 }, { method: 'raast', amountCents: 20_000 }],
  })
  const sp = await prisma.payment.findFirstOrThrow({ where: { orderId: split, method: 'raast' } })
  await prisma.raastReceipt.create({
    data: {
      tenantId: A.tenantId, orderId: split, conceptId: A.conceptId, paymentId: sp.id, bankAccountId: bankA.bankAccountId, ledgerCode: bankA.ledgerCode,
      amountCents: 20_000, dueCents: 20_000, bankRef: 'SPLITREF123', status: 'provisional', confirmedVia: 'cashier', confirmedAt: new Date(),
      cashierVerified: true, idempotencyKey: `pay:${sp.id}`, createdById: financeA.id,
    },
  })

  const cod = await mkOrder(A, { items: item(A, 90_000), taxCents: 0, taxRatePct: 15, totalCents: 90_000, payments: [{ method: 'cash', amountCents: 90_000, status: 'pending' }] })
  await prisma.order.update({ where: { id: cod }, data: { source: 'servd' } })
  // A pending cash row on a TILL order is not money (an unfinished split).
  await mkOrder(A, { items: item(A, 5_000), taxCents: 0, taxRatePct: 15, totalCents: 5_000, payments: [{ method: 'cash', amountCents: 5_000, status: 'pending' }] })
  // Not sold: an open order's paid Raast row never counts.
  await mkOrder(A, { items: item(A, 33_000), taxCents: 0, taxRatePct: 8, totalCents: 33_000, status: 'received', payments: [{ method: 'raast', amountCents: 33_000 }] })

  // A Raast refund on the matched sale, handed back in the period.
  const matched = await prisma.raastReceipt.findFirstOrThrow({ where: { tenantId: A.tenantId, status: 'matched' } })
  await prisma.payment.create({
    data: { orderId: matched.orderId, method: 'raast', amountCents: -25_000, status: 'refunded', gateway: 'raast', gatewayRef: 'OUTREF123456', processedAt: new Date(`${DAY}T11:00:00Z`) },
  })

  // Company B, same day: one Raast sale it alone owns.
  await mkOrder(B, { items: item(B, 999_900), taxCents: 0, taxRatePct: 8, totalCents: 999_900, payments: [{ method: 'raast', amountCents: 999_900 }] })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(reportRoutes, { prefix: '/reports' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

type Row = { tender: string; label: string; amountCents: number; payments: number; orders: number; sharePct: number }

describe('GET /reports/by-tender', () => {
  it('splits the money by tender with shares, comps apart, Raast by reconciliation state, refunds by tender', async () => {
    const res = await call(financeA, `/reports/by-tender?dateFrom=${DAY}&dateTo=${DAY}`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    const by = new Map<string, Row>(body.tenders.map((t: Row) => [t.tender, t]))

    // Cash = cash in a drawer; the pending COD is its own row (finance gaps item 1).
    expect(by.get('cash')).toMatchObject({ amountCents: 100_000 + 10_000, payments: 2, orders: 2, label: 'Cash' })
    expect(by.get('cod_with_rider')).toMatchObject({ amountCents: 90_000, payments: 1, orders: 1, label: 'Cash on delivery – with rider' })
    // riderOwes* (H5: booked to the rider); notCollected* are the deprecated aliases (same values).
    expect(body.cod).toEqual({ paidInCents: 0, paidInCount: 0, withRiderCents: 90_000, withRiderCount: 1, riderOwesCents: 0, riderOwesCount: 0, notCollectedCents: 0, notCollectedCount: 0 })
    expect(by.get('card')).toMatchObject({ amountCents: 200_000 + 80_000, orders: 2, label: 'Card – Keenu' })
    expect(by.get('raast')).toMatchObject({ amountCents: 300_000 + 150_000 + 50_000 + 20_000, payments: 4, orders: 4, label: 'Raast QR' })
    expect(by.get('keenu_qr')).toMatchObject({ amountCents: 40_000, label: 'Keenu QR (retired)' })
    expect(by.get('wallet')).toMatchObject({ amountCents: 60_000, orders: 1 })
    expect(by.has('comp')).toBe(false)
    expect(body.comp).toEqual({ amountCents: 70_000, orders: 1 })

    const total = 110_000 + 90_000 + 280_000 + 520_000 + 40_000 + 60_000
    expect(body.totalCents).toBe(total)
    expect(by.get('raast')!.sharePct).toBe(Math.round((520_000 / total) * 1000) / 10)
    // Order: Cash, COD not in a drawer, Card – Keenu, Raast QR, then the retired Keenu QR, wallet.
    expect(body.tenders.map((t: Row) => t.tender)).toEqual(['cash', 'cod_with_rider', 'card', 'raast', 'keenu_qr', 'wallet'])

    expect(body.raast).toEqual({
      provisionalCents: 320_000, provisionalCount: 2,
      matchedCents: 150_000, matchedCount: 1,
      unreceivedCents: 50_000, unreceivedCount: 1,
    })
    expect(body.refunds).toEqual([{ tender: 'raast', label: 'Raast QR', amountCents: 25_000, count: 1 }])
  })

  it('a report reader without revenue gets order counts per tender only', async () => {
    const res = await call(managerA, `/reports/by-tender?dateFrom=${DAY}&dateTo=${DAY}`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.volumeOnly).toBe(true)
    expect(JSON.stringify(body)).not.toContain('amountCents')
    expect(body.tenders.find((t: { tender: string }) => t.tender === 'raast')).toEqual({ tender: 'raast', label: 'Raast QR', orders: 4 })
    expect(body.comp).toEqual({ orders: 1 })
  })

  it("company scope: B sees only its own; A's brand is 404 for B; another day is empty", async () => {
    const b = await call(financeB, `/reports/by-tender?dateFrom=${DAY}&dateTo=${DAY}`)
    expect(b.statusCode).toBe(200)
    expect(b.json().tenders).toEqual([expect.objectContaining({ tender: 'raast', amountCents: 999_900, sharePct: 100 })])
    expect(b.json().raast.provisionalCents).toBe(999_900) // no receipt row → provisional
    expect((await call(financeB, `/reports/by-tender?dateFrom=${DAY}&dateTo=${DAY}&conceptId=${A.conceptId}`)).statusCode).toBe(404)

    const a = await call(financeA, `/reports/by-tender?dateFrom=${DAY}&dateTo=${DAY}&conceptId=${A.conceptId}`)
    expect(a.json().tenders.some((t: Row) => t.amountCents === 999_900)).toBe(false)

    const empty = await call(financeA, '/reports/by-tender?dateFrom=2026-10-01&dateTo=2026-10-02')
    expect(empty.json()).toMatchObject({ tenders: [], totalCents: 0, refunds: [] })
  })

  it('COD booked to the rider is its own row (cod_rider_owes), and on-account bills list after Raast', async () => {
    // Another day, so the first test's figures are untouched.
    const DAY2 = '2026-10-11'
    const at = (h: number) => new Date(`${DAY2}T${String(h).padStart(2, '0')}:00:00Z`)
    const move = (id: string) => prisma.order.update({ where: { id }, data: { placedAt: at(9), completedAt: at(10) } })
    const rider = await prisma.rider.create({ data: { name: 'Report Rider', phone: `92340${Date.now() % 10_000_000}`, tenantId: A.tenantId } })
    // Delivered COD finance booked as owed by the rider (1351).
    const owed = await mkOrder(A, { items: item(A, 45_000), taxCents: 0, taxRatePct: 15, totalCents: 45_000, payments: [{ method: 'cash', amountCents: 45_000, status: 'pending' }] })
    await prisma.order.update({ where: { id: owed }, data: { source: 'servd', fulfilmentType: 'delivery', riderId: rider.id, deliveredAt: at(10) } })
    await prisma.payment.updateMany({ where: { orderId: owed }, data: { codRiderDebtAt: at(23), codRiderDebtById: financeA.id } })
    await move(owed)
    // Delivered COD still with the rider.
    const withRider = await mkOrder(A, { items: item(A, 15_000), taxCents: 0, taxRatePct: 15, totalCents: 15_000, payments: [{ method: 'cash', amountCents: 15_000, status: 'pending' }] })
    await prisma.order.update({ where: { id: withRider }, data: { source: 'servd', fulfilmentType: 'delivery', riderId: rider.id, deliveredAt: at(10) } })
    await move(withRider)
    // An on-account bill and a Raast sale.
    const oa = await mkOrder(A, { items: item(A, 25_000), taxCents: 0, taxRatePct: 15, totalCents: 25_000 })
    await prisma.payment.create({ data: { orderId: oa, method: 'on_account', amountCents: 25_000, status: 'paid', processedAt: at(10) } })
    await move(oa)
    await move(await mkOrder(A, { items: item(A, 10_000), taxCents: 0, taxRatePct: 8, totalCents: 10_000, payments: [{ method: 'raast', amountCents: 10_000 }] }))

    const r = await call(financeA, `/reports/by-tender?dateFrom=${DAY2}&dateTo=${DAY2}`)
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json()
    expect(body.tenders.map((t: Row) => t.tender)).toEqual(['cod_with_rider', 'cod_rider_owes', 'raast', 'on_account'])
    const by = new Map<string, Row>(body.tenders.map((t: Row) => [t.tender, t]))
    expect(by.get('cod_rider_owes')).toMatchObject({ amountCents: 45_000, payments: 1, orders: 1, label: 'Cash on delivery – owed by rider' })
    expect(by.get('cod_with_rider')).toMatchObject({ amountCents: 15_000, label: 'Cash on delivery – with rider' })
    expect(by.get('on_account')).toMatchObject({ amountCents: 25_000, orders: 1, label: 'On account' })
    expect(body.cod).toEqual({
      paidInCents: 0, paidInCount: 0, withRiderCents: 15_000, withRiderCount: 1,
      riderOwesCents: 45_000, riderOwesCount: 1, notCollectedCents: 45_000, notCollectedCount: 1,
    })
    expect(body.totalCents).toBe(45_000 + 15_000 + 25_000 + 10_000)
    expect(by.has('cod_not_collected')).toBe(false)
  })
})

describe('getOrder', () => {
  it('payments carry their Raast receipt state', async () => {
    const r = await prisma.raastReceipt.findFirstOrThrow({ where: { tenantId: A.tenantId, status: 'matched' } })
    const order = await getOrder(r.orderId, { concept: { tenantId: A.tenantId } })
    const raast = order.payments.find((p) => p.method === 'raast' && p.amountCents > 0)!
    expect(raast.raastReceipt).toMatchObject({ status: 'matched', bankRef: r.bankRef, confirmedVia: 'cashier' })
    expect(raast.raastReceipt!.matchedAt).toBeInstanceOf(Date)
    const refund = order.payments.find((p) => p.amountCents < 0)!
    expect(refund.raastReceipt).toBeNull()
  })
})
