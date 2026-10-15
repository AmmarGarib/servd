// COD custody (H5, Delivery & customers — stream DLV-custody):
//
//   - workers/codCustody.ts flags overdue COD cash ('cod_cash_overdue') and
//     deliveries on the road too long ('delivery_on_road_overdue') — only in
//     a company whose code-only switch is on, only for its own rows, once per
//     payment / order (a re-run raises nothing), never pickup / counter cash,
//     never COD already booked to the rider;
//   - reconciliation/codCloseCheck.ts blocks the close (CEO-overridable) in
//     any company with COD still pending at the close date, and only there;
//   - GET /pos/cod-due: every row carries its status (all four) and
//     riderOwes; company B's cashier sees none of A's rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { prisma, mkCompany, mkUser, buildApp, caller, type Company, type Who } from './connectorsFixtures.js'
import { DELIVERY_CODE_ONLY_SETTING } from '../src/lib/deliveryRules.js'
import { runCodCustodyOnce, codeOnlyCompanyIds } from '../src/workers/codCustody.js'
import { codCloseCheck } from '../src/modules/reconciliation/codCloseCheck.js'
import type { CloseCheckContext } from '../src/modules/accounting/closeCheckTypes.js'

const RUN = randomBytes(3).toString('hex')
const H = 3_600_000
const NOW = new Date()
const ago = (h: number) => new Date(NOW.getTime() - h * H)

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company, C: Company
let cashierA: Who, cashierB: Who, financeA: Who
let riderA: string, riderB: string

type OrderOpts = {
  fulfilmentType?: 'delivery' | 'takeout'
  rider?: string | null
  status?: 'completed' | 'ready' | 'cancelled'
  source?: 'servd' | 'pos'
  completedAt?: Date | null
  deliveredAt?: Date | null
  pickedUpAt?: Date | null
  returnedAt?: Date | null
  pay?: { cents: number; status?: 'pending' | 'paid'; debtAt?: Date | null; debtBy?: string | null } | null
}

async function mkCodOrder(co: Company, o: OrderOpts): Promise<{ orderId: string; paymentId: string | null }> {
  const order = await prisma.order.create({
    data: {
      conceptId: co.conceptId,
      locationId: co.locationId,
      source: o.source ?? 'servd',
      fulfilmentType: o.fulfilmentType ?? 'delivery',
      status: o.status ?? 'completed',
      riderId: o.rider === undefined ? null : o.rider,
      totalCents: o.pay?.cents ?? 10_000,
      placedAt: ago(30),
      completedAt: o.completedAt === undefined ? ((o.status ?? 'completed') === 'completed' ? ago(20) : null) : o.completedAt,
      deliveredAt: o.deliveredAt ?? null,
      pickedUpAt: o.pickedUpAt ?? null,
      returnedAt: o.returnedAt ?? null,
      items: { create: [{ name: 'Kheer', quantity: 1, unitPriceCents: o.pay?.cents ?? 10_000 }] },
    },
  })
  let paymentId: string | null = null
  if (o.pay) {
    paymentId = (await prisma.payment.create({
      data: {
        orderId: order.id, method: 'cash', amountCents: o.pay.cents, status: o.pay.status ?? 'pending',
        codRiderDebtAt: o.pay.debtAt ?? null, codRiderDebtById: o.pay.debtBy ?? null,
      },
    })).id
  }
  return { orderId: order.id, paymentId }
}

const flagsOf = (tenantId: string, kind: string) =>
  prisma.exceptionFlag.findMany({ where: { tenantId, kind }, select: { entityType: true, entityId: true, amountCents: true, severity: true } })

const ctxFor = (tenantId: string, newLock: Date): CloseCheckContext =>
  ({ db: prisma, tenantId, prevLock: null, newLock, months: [], isYearEnd: false })

// A's rows
let aOverdue: { orderId: string; paymentId: string | null }
let aFresh: { orderId: string; paymentId: string | null }
let aPickup: { orderId: string; paymentId: string | null }
let aOwed: { orderId: string; paymentId: string | null }
let aPos: { orderId: string; paymentId: string | null }
let aPaid: { orderId: string; paymentId: string | null }
let aRoadLate: string, aRoadFresh: string, aRoadReturned: string, aRoadCancelled: string, aRoadDone: string
// B's rows (switch off)
let bOverdue: { orderId: string; paymentId: string | null }
let bRoadLate: string

beforeAll(async () => {
  A = await mkCompany(`codc-a-${RUN}`)
  B = await mkCompany(`codc-b-${RUN}`)
  C = await mkCompany(`codc-c-${RUN}`)
  cashierA = await mkUser(`codc-cash-a-${RUN}`, 'cashier', A.tenantId)
  cashierB = await mkUser(`codc-cash-b-${RUN}`, 'cashier', B.tenantId)
  financeA = await mkUser(`codc-fin-a-${RUN}`, 'finance', A.tenantId)
  riderA = (await prisma.rider.create({ data: { name: 'Asif Rider', phone: `92331${Date.now() % 10_000_000}`, tenantId: A.tenantId } })).id
  riderB = (await prisma.rider.create({ data: { name: 'Bilal Rider', phone: `92332${Date.now() % 10_000_000}`, tenantId: B.tenantId } })).id

  // Code-only ON for A only.
  await prisma.setting.create({ data: { key: `${DELIVERY_CODE_ONLY_SETTING}:${A.tenantId}`, value: ago(48).toISOString() } })

  aOverdue = await mkCodOrder(A, { rider: riderA, deliveredAt: ago(13), pay: { cents: 120_000 } })
  aFresh = await mkCodOrder(A, { rider: riderA, deliveredAt: ago(1), completedAt: ago(1), pay: { cents: 30_000 } })
  aPickup = await mkCodOrder(A, { fulfilmentType: 'takeout', rider: null, completedAt: ago(20), pay: { cents: 40_000 } })
  aOwed = await mkCodOrder(A, { rider: riderA, deliveredAt: ago(15), pay: { cents: 50_000, debtAt: ago(2), debtBy: financeA.id } })
  aPos = await mkCodOrder(A, { source: 'pos', fulfilmentType: 'takeout', rider: null, pay: { cents: 60_000 } })
  aPaid = await mkCodOrder(A, { rider: riderA, deliveredAt: ago(14), pay: { cents: 70_000, status: 'paid' } })

  aRoadLate = (await mkCodOrder(A, { status: 'ready', rider: riderA, pickedUpAt: ago(4), pay: null })).orderId
  aRoadFresh = (await mkCodOrder(A, { status: 'ready', rider: riderA, pickedUpAt: ago(1), pay: null })).orderId
  aRoadReturned = (await mkCodOrder(A, { status: 'ready', rider: riderA, pickedUpAt: ago(5), returnedAt: ago(1), pay: null })).orderId
  aRoadCancelled = (await mkCodOrder(A, { status: 'cancelled', rider: riderA, pickedUpAt: ago(5), pay: null })).orderId
  aRoadDone = (await mkCodOrder(A, { status: 'completed', rider: riderA, pickedUpAt: ago(5), deliveredAt: ago(4), pay: null })).orderId

  bOverdue = await mkCodOrder(B, { rider: riderB, deliveredAt: ago(13), pay: { cents: 99_000 } })
  bRoadLate = (await mkCodOrder(B, { status: 'ready', rider: riderB, pickedUpAt: ago(4), pay: null })).orderId

  app = await buildApp()
  call = caller(app)
}, 60_000)

afterAll(async () => { await app?.close() })

describe('codCustody worker', () => {
  it('runs only for companies whose code-only switch is on', async () => {
    const ids = await codeOnlyCompanyIds()
    expect(ids).toContain(A.tenantId)
    expect(ids).not.toContain(B.tenantId)
    expect(ids).not.toContain(C.tenantId)
  })

  it("flags the company's own overdue rider COD only — never pickup, till, booked-to-rider, paid or fresh cash", async () => {
    const r = await runCodCustodyOnce(NOW)
    expect(r.codOverdue).toBe(1)
    const flags = await flagsOf(A.tenantId, 'cod_cash_overdue')
    expect(flags).toEqual([{ entityType: 'Payment', entityId: aOverdue.paymentId, amountCents: 120_000, severity: 'medium' }])
    const ids = flags.map((f) => f.entityId)
    for (const p of [aFresh, aPickup, aOwed, aPos, aPaid]) expect(ids).not.toContain(p.paymentId)
    // B's switch is off: its overdue COD is not flagged (today's behaviour).
    expect(await flagsOf(B.tenantId, 'cod_cash_overdue')).toEqual([])
    expect(await prisma.exceptionFlag.count({ where: { entityId: bOverdue.paymentId! } })).toBe(0)
  })

  it('flags a delivery on the road over 3 h — not a fresh, returned, cancelled or delivered one', async () => {
    const flags = await flagsOf(A.tenantId, 'delivery_on_road_overdue')
    expect(flags.map((f) => [f.entityType, f.entityId])).toEqual([['Order', aRoadLate]])
    for (const id of [aRoadFresh, aRoadReturned, aRoadCancelled, aRoadDone]) expect(flags.map((f) => f.entityId)).not.toContain(id)
    expect(await flagsOf(B.tenantId, 'delivery_on_road_overdue')).toEqual([])
    expect(await prisma.exceptionFlag.count({ where: { entityId: bRoadLate } })).toBe(0)
  })

  it('raises nothing twice on a re-run — even after the flag was resolved', async () => {
    await prisma.exceptionFlag.updateMany({ where: { tenantId: A.tenantId, kind: 'cod_cash_overdue' }, data: { status: 'resolved', resolvedAt: new Date() } })
    const r = await runCodCustodyOnce(NOW)
    expect(r).toMatchObject({ codOverdue: 0, onRoad: 0 })
    expect(await flagsOf(A.tenantId, 'cod_cash_overdue')).toHaveLength(1)
    expect(await flagsOf(A.tenantId, 'delivery_on_road_overdue')).toHaveLength(1)
  })

  it('a later run flags COD that has since gone overdue (once)', async () => {
    const later = new Date(NOW.getTime() + 12 * H)
    const r = await runCodCustodyOnce(later)
    expect(r.codOverdue).toBe(1) // aFresh (now 13 h)
    const ids = (await flagsOf(A.tenantId, 'cod_cash_overdue')).map((f) => f.entityId).sort()
    expect(ids).toEqual([aOverdue.paymentId, aFresh.paymentId].sort())
    expect(ids).not.toContain(aPickup.paymentId)
    expect((await runCodCustodyOnce(later)).codOverdue).toBe(0)
  })
})

describe('codCloseCheck (owner DLV-COD-close: block, CEO override)', () => {
  it('is a blocking, overridable check keyed cod_with_rider', () => {
    expect(codCloseCheck).toMatchObject({ key: 'cod_with_rider', severity: 'block', overridable: true })
  })

  it("blocks A's close while A's COD is pending (all pending COD up to the date, by status), reading only A", async () => {
    const p = await codCloseCheck.run(ctxFor(A.tenantId, NOW))
    expect(p).not.toBeNull()
    // overdue 1,200 + fresh 300 + pickup 400 + owed 500 (till and paid excluded)
    expect(p).toMatchObject({ key: 'cod_with_rider', severity: 'block', overridable: true, count: 4, cents: 120_000 + 30_000 + 40_000 + 50_000, link: '/reconciliation?tab=cod' })
    expect(p!.detail).toMatch(/booked as owed by the rider/)
    expect(p!.detail).toMatch(/pickup cash/)
    expect(p!.detail).not.toMatch(/990/) // nothing of B's
  })

  it('B (switch off) with pending COD is blocked too; C with none is clear', async () => {
    const pb = await codCloseCheck.run(ctxFor(B.tenantId, NOW))
    expect(pb).toMatchObject({ count: 1, cents: 99_000 })
    expect(await codCloseCheck.run(ctxFor(C.tenantId, NOW))).toBeNull()
  })

  it('only orders completed on or before the close date count', async () => {
    // Before A's fresh order completed: overdue, pickup and owed (completed 20 h ago) count; fresh does not.
    const p = await codCloseCheck.run(ctxFor(A.tenantId, ago(10)))
    expect(p).toMatchObject({ count: 3, cents: 120_000 + 40_000 + 50_000 })
    expect(await codCloseCheck.run(ctxFor(A.tenantId, ago(40)))).toBeNull()
  })
})

describe('GET /pos/cod-due', () => {
  it('each row carries its status (all four) and riderOwes; overdue stays for older clients', async () => {
    const r = await call(cashierA, 'GET', '/pos/cod-due')
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json() as { overdueAfterHours: number; payments: Array<{ id: string; status: string; overdue: boolean; riderOwes: { at: string; byName: string | null } | null; codRiderDebtById?: unknown }> }
    expect(body.overdueAfterHours).toBe(12)
    const by = new Map(body.payments.map((p) => [p.id, p]))
    expect(by.get(aOverdue.paymentId!)).toMatchObject({ status: 'overdue', overdue: true, riderOwes: null })
    expect(by.get(aFresh.paymentId!)).toMatchObject({ status: 'with_rider', overdue: false, riderOwes: null })
    expect(by.get(aPickup.paymentId!)).toMatchObject({ status: 'at_counter', riderOwes: null })
    expect(by.get(aOwed.paymentId!)).toMatchObject({ status: 'rider_owes', riderOwes: { byName: `codc-fin-a-${RUN}` } })
    expect(typeof by.get(aOwed.paymentId!)!.riderOwes!.at).toBe('string')
    expect(by.get(aOwed.paymentId!)!.codRiderDebtById).toBeUndefined()
    expect(by.has(aPos.paymentId!)).toBe(false)
    expect(by.has(aPaid.paymentId!)).toBe(false)
    expect(by.has(bOverdue.paymentId!)).toBe(false)
  })

  it("B's cashier sees none of A's rows", async () => {
    const r = await call(cashierB, 'GET', '/pos/cod-due')
    expect(r.statusCode, r.body).toBe(200)
    const ids = (r.json().payments as Array<{ id: string }>).map((p) => p.id)
    expect(ids).toContain(bOverdue.paymentId)
    for (const p of [aOverdue, aFresh, aPickup, aOwed]) expect(ids).not.toContain(p.paymentId)
  })
})
