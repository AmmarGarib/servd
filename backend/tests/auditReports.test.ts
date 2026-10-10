// Simulated-shift audit (2026-10-10), the books findings in the reports and
// reconciliation modules. Every case is two-company.
//
//   BOOKS-01  Sales reports, sales by channel, the CEO overview and the daily
//             sales email read the FinancialEntry register, which nothing has
//             written since owner decision 39 — they showed PKR 0. They read
//             the orders now, and their net sales IS the ledger P&L's net
//             revenue for the same day (sales posted by the real posting
//             paths: online completion, till shift close, refunds, the wallet
//             restore, loyalty redemption, comps).
//   BOOKS-02  The finance role holds the reconciliation module but every
//             reconciliation route refused it (MANAGERS only).
//   BOOKS-06  A bank statement with a balance of PKR 21.47M or more 500'd
//             (INT4 balance columns).
//   BOOKS-11  A card settlement net of its MDR could not be booked: one contra
//             account only, so 1030 never cleared. A balanced split can.
//   BOOKS-12  /reports and /reconciliation/summary read UTC days, and a
//             date-only range collapsed to one instant. They are PKT days now.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { postOrderCompletion, postRefundPayment, refundDebitLines } from '../src/modules/accounting/orderPosting.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { profitAndLoss } from '../src/modules/accounting/reports.js'
import { parsePktStartOfDay, parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import { reportDateRange } from '../src/modules/reports/service.js'
import { buildDailySalesReport } from '../src/workers/scheduledReports.js'
import { reportRoutes } from '../src/modules/reports/routes.js'
import { managementRoutes } from '../src/modules/management/routes.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'

let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

// A day far from "now", so nothing else posts into it.
const DAY = '2026-05-20'
const PREV = '2026-05-19'
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:00`)
const RANGE = `dateFrom=${DAY}&dateTo=${DAY}`

async function mkUser(key: string, role: UserRole, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.auditrep@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

interface SaleInput {
  conceptId: string
  source?: 'servd' | 'pos'
  status?: 'completed' | 'refunded'
  completedAt: Date
  totalCents: number
  taxCents?: number
  discountCents?: number
  serviceChargeCents?: number
  tipCents?: number
  walletAmountCents?: number
  customerId?: string
  pay?: Array<{ method: 'cash' | 'card' | 'comp'; amountCents: number; shiftId?: string }>
}

async function sale(s: SaleInput) {
  const o = await prisma.order.create({
    data: {
      conceptId: s.conceptId, source: s.source ?? 'servd', status: s.status ?? 'completed',
      totalCents: s.totalCents, taxCents: s.taxCents ?? 0, discountCents: s.discountCents ?? 0,
      serviceChargeCents: s.serviceChargeCents ?? 0, tipCents: s.tipCents ?? 0,
      walletAmountCents: s.walletAmountCents ?? 0, customerId: s.customerId ?? null,
      placedAt: new Date(s.completedAt.getTime() - 20 * 60_000), completedAt: s.completedAt,
      items: { create: [{ name: 'Club sandwich', quantity: 1, unitPriceCents: s.totalCents }] },
    },
  })
  for (const p of s.pay ?? []) {
    await prisma.payment.create({ data: { orderId: o.id, method: p.method, amountCents: p.amountCents, status: 'paid', shiftId: p.shiftId ?? null, processedAt: s.completedAt, createdAt: s.completedAt } })
  }
  return o
}

async function refund(orderId: string, method: 'cash' | 'card', amountCents: number, when: Date) {
  const p = await prisma.payment.create({
    data: { orderId, method, amountCents: -amountCents, status: 'refunded', processedAt: when, createdAt: when },
  })
  const r = await postRefundPayment(p.id)
  expect(r.posted).toBe(true)
  return p
}

let o1: { id: string }
let o5: { id: string }
let shiftDay: { id: string }

beforeAll(async () => {
  // B first, so it is the "oldest" company a company-less read would land on.
  tenantB = (await prisma.tenant.create({ data: { name: 'Audit B', slug: 'audit-b' } })).id
  tenantA = (await prisma.tenant.create({ data: { name: 'Audit A', slug: 'audit-a' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA = (await prisma.concept.create({ data: { name: 'Audit Cafe', slug: 'audit-cafe-a', type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Audit Grill', slug: 'audit-grill-b', type: 'restaurant', tenantId: tenantB } })).id

  await mkUser('ceo', 'admin', tenantA, [tenantA])
  await mkUser('fin', 'finance', tenantA, [tenantA])
  await mkUser('cashier', 'cashier', tenantA, [tenantA])
  await mkUser('ceoB', 'admin', tenantB, [tenantB])
  await mkUser('finB', 'finance', tenantB, [tenantB])
  // Head office: works in both, primary company B.
  await mkUser('both', 'admin', tenantB, [tenantA, tenantB])

  const customer = await prisma.customer.create({ data: { name: 'Audit Customer', phone: '+923001234500' } })
  const loyalty = await prisma.loyaltyAccount.create({ data: { tenantId: tenantA, customerId: customer.id } })

  // ── A's day, through the real posting paths ────────────────────────────
  // O1 online, cash: 10,000 + 1,500 GST. Partly refunded (2,300 cash) at 20:00.
  o1 = await sale({ conceptId: conceptA, completedAt: at(DAY, '13:00'), totalCents: 11_500, taxCents: 1_500, pay: [{ method: 'cash', amountCents: 11_500 }] })
  // O2 online, card: 10,000 items − 1,000 discount + 1,350 GST + 500 service + 300 tip;
  // 50 loyalty points (PKR 5) paid part of the discount.
  const o2 = await sale({ conceptId: conceptA, completedAt: at(DAY, '14:00'), totalCents: 11_150, taxCents: 1_350, discountCents: 1_000, serviceChargeCents: 500, tipCents: 300, customerId: customer.id, pay: [{ method: 'card', amountCents: 11_150 }] })
  const redeem = await prisma.loyaltyTransaction.create({ data: { loyaltyAccountId: loyalty.id, orderId: o2.id, type: 'redeem', pointsDelta: -50, createdAt: at(DAY, '14:00') } })
  // O3 online, rung at 00:30 PKT — the PKT day, though still the 19th in UTC.
  await sale({ conceptId: conceptA, completedAt: at(DAY, '00:30'), totalCents: 5_750, taxCents: 750, pay: [{ method: 'cash', amountCents: 5_750 }] })
  // O4 online at 23:30 PKT the night before — not this day.
  await sale({ conceptId: conceptA, completedAt: at(PREV, '23:30'), totalCents: 9_999, pay: [{ method: 'cash', amountCents: 9_999 }] })
  // O5 online: 3,000 card + 2,750 wallet (5,000 + 750 GST), refunded in full at 21:00.
  o5 = await sale({ conceptId: conceptA, completedAt: at(DAY, '15:00'), totalCents: 3_000, walletAmountCents: 2_750, taxCents: 750, customerId: customer.id, pay: [{ method: 'card', amountCents: 3_000 }] })

  for (const id of [o1.id, o2.id, o5.id]) expect((await postOrderCompletion(id)).posted).toBe(true)
  const o3 = await prisma.order.findFirstOrThrow({ where: { conceptId: conceptA, totalCents: 5_750 } })
  const o4 = await prisma.order.findFirstOrThrow({ where: { conceptId: conceptA, totalCents: 9_999 } })
  expect((await postOrderCompletion(o3.id)).posted).toBe(true)
  expect((await postOrderCompletion(o4.id)).posted).toBe(true)
  // The redemption's own entry, as loyaltyPosting.postLoyaltyRedeem books it
  // (Dr 2060 / Cr 7020 at the company's point value — PKR 0.10 by default —
  // dated when the points were spent). Booked directly so this suite does not
  // ride on changes to how that function finds the company.
  await postJournalEntry({
    tenantId: tenantA, sourceType: 'loyalty.redeem', sourceId: redeem.id, description: 'points redeemed', entryDate: at(DAY, '14:00'),
    lines: [
      { accountCode: '2060', type: 'debit',  amountCents: 500 },
      { accountCode: '7020', type: 'credit', amountCents: 500 },
    ],
  })

  await refund(o1.id, 'cash', 2_300, at(DAY, '20:00'))
  const r5 = await refund(o5.id, 'card', 3_000, at(DAY, '21:00'))
  // Refunded in full: status, and the wallet restore exactly as postOrderRefund books it.
  const full5 = await prisma.order.update({ where: { id: o5.id }, data: { status: 'refunded' }, include: { concept: { select: { slug: true } } } })
  await prisma.walletTransaction.create({ data: { customerId: customer.id, type: 'refund', amountCents: 2_750, balanceAfter: 2_750, orderId: o5.id, createdAt: at(DAY, '21:00') } })
  await postJournalEntry({
    tenantId: tenantA, sourceType: 'order.refund_wallet', sourceId: o5.id, description: 'wallet restore', entryDate: at(DAY, '21:00'),
    lines: [
      ...refundDebitLines(full5, Math.abs(r5.amountCents), 2_750, 'wallet restore'),
      { accountCode: '2050', type: 'credit', amountCents: 2_750, conceptId: conceptA },
    ],
  })

  // O6 at the till: 2,000 + 300 GST, half cash, half comped. The drawer
  // opened 10:00 and closed 23:00 PKT; the shift close books it.
  shiftDay = await prisma.shift.create({ data: { userId: users['cashier']!.id, tenantId: tenantA, openingFloatCents: 0, status: 'open', openedAt: at(DAY, '10:00') } })
  await sale({ conceptId: conceptA, source: 'pos', completedAt: at(DAY, '16:00'), totalCents: 2_300, taxCents: 300, pay: [{ method: 'cash', amountCents: 1_150, shiftId: shiftDay.id }, { method: 'comp', amountCents: 1_150, shiftId: shiftDay.id }] })
  await prisma.shift.update({ where: { id: shiftDay.id }, data: { status: 'closed', closedAt: at(DAY, '23:00'), closingFloatCents: 1_150 } })
  expect((await postShiftClose(shiftDay.id)).posted).toBe(true)
  // Two more drawers: one opened 02:00 PKT on DAY (still the 19th in UTC), one the night before.
  await prisma.shift.create({ data: { userId: users['cashier']!.id, tenantId: tenantA, openingFloatCents: 0, status: 'closed', openedAt: at(DAY, '02:00'), closedAt: at(DAY, '04:00'), closingFloatCents: 0 } })
  await prisma.shift.create({ data: { userId: users['cashier']!.id, tenantId: tenantA, openingFloatCents: 0, status: 'closed', openedAt: at(PREV, '23:00'), closedAt: at(PREV, '23:30'), closingFloatCents: 0 } })

  // ── B's day: must never show in A ──────────────────────────────────────
  const ob = await sale({ conceptId: conceptB, completedAt: at(DAY, '13:00'), totalCents: 99_000, pay: [{ method: 'cash', amountCents: 99_000 }] })
  expect((await postOrderCompletion(ob.id)).posted).toBe(true)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(reportRoutes, { prefix: '/reports' })
  await app.register(managementRoutes, { prefix: '/management' })
  await app.register(reconciliationRoutes, { prefix: '/reconciliation' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

interface Totals { orders: number; gross: number; net: number; tax: number; tips: number; comps: number; refunds: number; discount: number; loyaltyRedeemed: number }

// ─── BOOKS-01 ────────────────────────────────────────────────────────────────

describe('BOOKS-01 — sales come from the orders and agree with the ledger P&L', () => {
  it('the register is empty, and the sales report is not', async () => {
    expect(await prisma.financialEntry.count()).toBe(0)
    const res = await call('fin', 'GET', `/reports/sales?${RANGE}`)
    expect(res.statusCode).toBe(200)
    const t = (res.json() as { totals: Totals }).totals
    // O1, O2, O3, O5 (refunded since), O6 — not O4 (the 19th), not B's.
    expect(t.orders).toBe(5)
    expect(t.gross).toBe(11_500 + 11_150 + 5_750 + (3_000 + 2_750) + 2_300)
    expect(t.refunds).toBe(2_300 + 3_000 + 2_750)
    expect(t.comps).toBe(1_150)
    expect(t.discount).toBe(1_000)
    expect(t.loyaltyRedeemed).toBe(500)
    expect(t.tips).toBe(300)
  })

  it('net sales = the P&L net revenue for the same company and day, to the paisa', async () => {
    const pl = await profitAndLoss([tenantA], parsePktStartOfDay(DAY), parsePktEndOfDay(DAY))
    const ledgerNet = pl.totals.revenueCents - pl.totals.contraRevenueCents
    expect(ledgerNet).toBe(23_850)          // worked by hand in the setup comments
    const t = ((await call('fin', 'GET', `/reports/sales?${RANGE}`)).json() as { totals: Totals }).totals
    expect(t.net).toBe(ledgerNet)
    // GST: sales GST less the refunds' GST share = the ledger's 2030 movement.
    const gst = await prisma.journalLine.findMany({
      where: { account: { code: '2030', tenantId: tenantA }, journalEntry: { tenantId: tenantA, entryDate: { gte: parsePktStartOfDay(DAY), lte: parsePktEndOfDay(DAY) } } },
      select: { type: true, amountCents: true },
    })
    expect(t.tax).toBe(gst.reduce((s, l) => s + (l.type === 'credit' ? l.amountCents : -l.amountCents), 0))
  })

  it('by channel and by hour add up to the totals', async () => {
    const totals = ((await call('fin', 'GET', `/reports/sales?${RANGE}`)).json() as { totals: Totals; byHour: Record<string, { orders: number; net: number }> })
    const channels = (await call('fin', 'GET', `/reports/by-source?${RANGE}`)).json() as Array<Totals & { source: string }>
    expect(channels.map((c) => c.source).sort()).toEqual(['pos', 'servd'])
    expect(channels.reduce((s, c) => s + c.net, 0)).toBe(totals.totals.net)
    expect(channels.reduce((s, c) => s + c.orders, 0)).toBe(5)
    expect(channels.find((c) => c.source === 'pos')).toMatchObject({ orders: 1, gross: 2_300, comps: 1_150, net: 850 })
    expect(Object.values(totals.byHour).reduce((s, h) => s + h.net, 0)).toBe(totals.totals.net)
    // The 00:30 PKT order is hour 0 of the PKT day.
    expect(totals.byHour['0']).toMatchObject({ orders: 1 })
  })

  it('company B sees only its own sales; a foreign brand or kitchen is a 404', async () => {
    const b = ((await call('finB', 'GET', `/reports/sales?${RANGE}`)).json() as { totals: Totals }).totals
    expect(b).toMatchObject({ orders: 1, gross: 99_000, net: 99_000 })
    expect((await call('fin', 'GET', `/reports/sales?${RANGE}&conceptId=${conceptB}`)).statusCode).toBe(404)
    expect((await call('fin', 'GET', `/reports/by-source?${RANGE}&conceptId=${conceptB}`)).statusCode).toBe(404)
    const locB = await prisma.location.create({ data: { name: 'B kitchen', slug: 'audit-b-kitchen', tenantId: tenantB } })
    expect((await call('fin', 'GET', `/reports/sales?${RANGE}&locationId=${locB.id}`)).statusCode).toBe(404)
    // Own brand narrows; an unknown channel matches nothing rather than everything.
    const own = ((await call('fin', 'GET', `/reports/sales?${RANGE}&conceptId=${conceptA}`)).json() as { totals: Totals }).totals
    expect(own.orders).toBe(5)
    const nothing = ((await call('fin', 'GET', `/reports/sales?${RANGE}&channel=foodpanda`)).json() as { totals: Totals }).totals
    expect(nothing.orders).toBe(0)
  })

  it('the CEO overview and the dashboards read the same figures', async () => {
    const ov = (await call('ceo', 'GET', `/management/executive-overview?${RANGE}`)).json() as {
      sales: { totals: { gross: number; net: number; orders: number; refunds: number }; basis: string }
      netRevenueCents: number
      series: Array<{ date: string; gross: number; net: number; orders: number }>
    }
    expect(ov.sales.basis).toBe('completed_orders')
    expect(ov.sales.totals).toMatchObject({ orders: 5, net: 23_850, refunds: 8_050 })
    // The order figure and the ledger figure on the same page agree.
    expect(ov.sales.totals.net).toBe(ov.netRevenueCents)
    expect(ov.series).toEqual([{ date: DAY, gross: ov.sales.totals.gross, net: 23_850, orders: 5 }])

    const brand = (await call('ceo', 'GET', `/management/brand-metrics?${RANGE}`)).json() as { revenue: { grossCents: number; netCents: number; orders: number } }
    expect(brand.revenue).toMatchObject({ grossCents: ov.sales.totals.gross, netCents: 23_850, orders: 5 })
    const fnb = (await call('ceo', 'GET', `/management/fnb-metrics?${RANGE}`)).json() as { sales: { grossCents: number; orders: number } }
    expect(fnb.sales).toMatchObject({ grossCents: ov.sales.totals.gross, orders: 5 })
    expect((await call('ceo', 'GET', `/management/executive-overview?${RANGE}&conceptId=${conceptB}`)).statusCode).toBe(404)
  })

  it('the daily sales email shows the day\'s orders, for one company', async () => {
    const { html } = await buildDailySalesReport(null, tenantA, at('2026-05-21', '00:05'))
    expect(html).toContain('<strong>5</strong> completed orders')
    expect(html).toContain('PKR 365')          // 36,450 paisa billed
    expect(html).toContain('Net sales (ex-GST): PKR 239')   // 23,850 paisa
    expect(html).not.toContain('PKR 990')      // B's order
    const b = await buildDailySalesReport(null, tenantB, at('2026-05-21', '00:05'))
    expect(b.html).toContain('<strong>1</strong> completed orders')
  })
})

// ─── BOOKS-12 ────────────────────────────────────────────────────────────────

describe('BOOKS-12 — finance date filters are PKT business days', () => {
  it('a date-only range is the whole PKT day; the admin\'s old UTC pair means the same day', async () => {
    const plain = ((await call('fin', 'GET', `/reports/sales?${RANGE}`)).json() as { totals: Totals }).totals
    const utc = ((await call('fin', 'GET', `/reports/sales?dateFrom=${DAY}T00:00:00Z&dateTo=${DAY}T23:59:59Z`)).json() as { totals: Totals }).totals
    expect(utc).toEqual(plain)
    // The 19th holds O4 only (23:30 PKT), not O3 (00:30 PKT on the 20th).
    const prev = ((await call('fin', 'GET', `/reports/sales?dateFrom=${PREV}&dateTo=${PREV}`)).json() as { totals: Totals }).totals
    expect(prev).toMatchObject({ orders: 1, gross: 9_999 })
  })

  it('/reconciliation/summary lists the drawers opened on that PKT day', async () => {
    const res = await call('fin', 'GET', `/reconciliation/summary?${RANGE}`)
    expect(res.statusCode).toBe(200)
    const s = res.json() as { totalShifts: number; shifts: Array<{ shiftId: string; totalSalesCents: number }> }
    expect(s.totalShifts).toBe(2)           // 10:00 and 02:00 PKT — not 23:00 on the 19th
    expect(s.shifts.find((x) => x.shiftId === shiftDay.id)?.totalSalesCents).toBe(1_150)
    expect(((await call('finB', 'GET', `/reconciliation/summary?${RANGE}`)).json() as { totalShifts: number }).totalShifts).toBe(0)
  })

  it('bad dates are a 400, not an empty report', async () => {
    expect((await call('fin', 'GET', '/reports/sales?dateFrom=yesterday')).statusCode).toBe(400)
    expect((await call('fin', 'GET', `/reports/sales?dateFrom=${DAY}&dateTo=${PREV}`)).statusCode).toBe(400)
    expect((await call('fin', 'GET', '/reconciliation/summary?dateTo=2026-02-30x')).statusCode).toBe(400)
  })

  it('reportDateRange: whole PKT days, defaulting to today in PKT', () => {
    // 20:30 UTC on the 20th is 01:30 PKT on the 21st — "today" is the 21st.
    const now = new Date('2026-05-20T20:30:00Z')
    const r = reportDateRange(undefined, undefined, 7, now)
    expect(r.to.toISOString()).toBe('2026-05-21T18:59:59.999Z')
    expect(r.from.toISOString()).toBe('2026-05-13T19:00:00.000Z')
    expect(reportDateRange(DAY, DAY, 7).from.toISOString()).toBe('2026-05-19T19:00:00.000Z')
  })
})

// ─── BOOKS-02 / BOOKS-06 / BOOKS-11 ──────────────────────────────────────────

describe('bank statements — finance reconciles, big balances import, card settlements split', () => {
  let bankA: string
  let importId: string

  beforeAll(async () => {
    bankA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL Operating', bankName: 'HBL', accountCode: '1020' } })).id
    // Card sales awaiting settlement in 1030: PKR 4,630.
    await postJournalEntry({
      tenantId: tenantA, sourceType: 'test.card_sales', sourceId: 'keenu-1', description: 'card sales', entryDate: at(DAY, '22:00'),
      lines: [
        { accountCode: '1030', type: 'debit',  amountCents: 463_000 },
        { accountCode: '4090', type: 'credit', amountCents: 463_000 },
      ],
    })
  })

  it('BOOKS-02 + 06: finance imports a PKR 25M statement and reads it back as numbers', async () => {
    const res = await call('fin', 'POST', '/reconciliation/bank/imports', {
      bankAccountId: bankA, statementDate: '2026-05-21',
      openingBalanceCents: 2_500_000_000, closingBalanceCents: 2_500_100_000,
      filename: 'hbl.csv', fileUrl: 'https://files.example.invalid/hbl.csv',
      csv: 'Date,Description,Reference,Amount\n2026-05-21,KEENU MERCHANT SETTLEMENT 20-MAY,KSET-0520,4537.40\n2026-05-21,Bank charges,,-150.00\n2026-05-21,Unknown credit,,10.00',
    })
    expect(res.statusCode).toBe(201)
    importId = (res.json() as { importId: string }).importId
    const list = (await call('fin', 'GET', '/reconciliation/bank/imports')).json() as Array<{ id: string; openingBalanceCents: number; closingBalanceCents: number }>
    expect(list.find((i) => i.id === importId)).toMatchObject({ openingBalanceCents: 2_500_000_000, closingBalanceCents: 2_500_100_000 })
    const row = await prisma.bankStatementImport.findUniqueOrThrow({ where: { id: importId } })
    expect(row.tenantId).toBe(tenantA)
    expect(row.closingBalanceCents).toBe(2_500_100_000n)
    // Finance reads the lines and ignores one.
    const lines = (await call('fin', 'GET', `/reconciliation/bank/imports/${importId}/lines`)).json() as Array<{ id: string; description: string }>
    expect(lines).toHaveLength(3)
    const unknown = lines.find((l) => l.description === 'Unknown credit')!
    expect((await call('fin', 'POST', `/reconciliation/bank/lines/${unknown.id}/ignore`, {})).statusCode).toBe(200)
    // Booking an adjustment journal stays with the approvers.
    const fee = lines.find((l) => l.description === 'Bank charges')!
    expect((await call('fin', 'POST', `/reconciliation/bank/lines/${fee.id}/adjust`, { contraAccountCode: '6081', memo: 'charges' })).statusCode).toBe(403)
    // Another company's finance sees none of it.
    expect(((await call('finB', 'GET', '/reconciliation/bank/imports')).json() as Array<{ id: string }>).some((i) => i.id === importId)).toBe(false)
    expect((await call('finB', 'GET', `/reconciliation/bank/imports/${importId}/lines`)).statusCode).toBe(404)
    expect((await call('finB', 'POST', `/reconciliation/bank/lines/${unknown.id}/ignore`, {})).statusCode).toBe(404)
  })

  it('BOOKS-02: a role without the reconciliation module is still refused', async () => {
    expect((await call('cashier', 'GET', '/reconciliation/summary')).statusCode).toBe(403)
    expect((await call('cashier', 'GET', '/reconciliation/bank/imports')).statusCode).toBe(403)
  })

  it('BOOKS-06: out-of-range figures are clear 4xx, never a 500', async () => {
    const base = { bankAccountId: bankA, statementDate: '2026-05-21', filename: 'x.csv', fileUrl: 'https://files.example.invalid/x.csv' }
    const tooBig = await call('fin', 'POST', '/reconciliation/bank/imports', { ...base, openingBalanceCents: 2 ** 60, closingBalanceCents: 0, csv: 'Date,Description,Amount\n2026-05-21,x,1' })
    expect(tooBig.statusCode).toBe(400)
    const bigLine = await call('fin', 'POST', '/reconciliation/bank/imports', { ...base, openingBalanceCents: 0, closingBalanceCents: 0, csv: 'Date,Description,Amount\n2026-05-21,Property sale,25000000.00' })
    expect(bigLine.statusCode).toBe(422)
    expect((bigLine.json() as { error: { code: string } }).error.code).toBe('CSV_AMOUNT_TOO_LARGE')
    const badDate = await call('fin', 'POST', '/reconciliation/bank/imports', { ...base, statementDate: 'soon', openingBalanceCents: 0, closingBalanceCents: 0, csv: 'Date,Description,Amount\n2026-05-21,x,1' })
    expect(badDate.statusCode).toBe(400)
  })

  it('BOOKS-11: a card settlement net of MDR books Dr bank + Dr 6080 / Cr 1030 in full, in the statement\'s company', async () => {
    const lines = (await call('ceo', 'GET', `/reconciliation/bank/imports/${importId}/lines`)).json() as Array<{ id: string; description: string; matchStatus: string }>
    const keenu = lines.find((l) => /KEENU/.test(l.description))!
    expect(keenu.matchStatus).toBe('unmatched')

    // Unbalanced: refused, the line stays open, nothing posts.
    const off = await call('both', 'POST', `/reconciliation/bank/lines/${keenu.id}/adjust`, {
      memo: 'Keenu settlement', lines: [{ accountCode: '1030', type: 'credit', amountCents: 463_000 }, { accountCode: '6080', type: 'debit', amountCents: 9_000 }],
    })
    expect(off.statusCode).toBe(422)
    expect((off.json() as { error: { code: string } }).error.code).toBe('ADJUSTMENT_UNBALANCED')
    // A code that isn't in the chart: 422, not a 500.
    const typo = await call('both', 'POST', `/reconciliation/bank/lines/${keenu.id}/adjust`, {
      memo: 'Keenu settlement', lines: [{ accountCode: '1030', type: 'credit', amountCents: 463_000 }, { accountCode: '6999', type: 'debit', amountCents: 9_260 }],
    })
    expect(typo.statusCode).toBe(422)
    // Not both shapes at once.
    expect((await call('both', 'POST', `/reconciliation/bank/lines/${keenu.id}/adjust`, { memo: 'x', contraAccountCode: '1030', lines: [{ accountCode: '1030', type: 'credit', amountCents: 453_740 }] })).statusCode).toBe(400)
    expect(await prisma.journalEntry.count({ where: { reference: `reconciliation.adjustment:${keenu.id}` } })).toBe(0)
    // B's CEO can't touch A's line.
    expect((await call('ceoB', 'POST', `/reconciliation/bank/lines/${keenu.id}/adjust`, { memo: 'x', contraAccountCode: '1030' })).statusCode).toBe(404)

    // The split, by an operator whose ACTIVE company is B: it still posts to A.
    const ok = await call('both', 'POST', `/reconciliation/bank/lines/${keenu.id}/adjust`, {
      memo: 'Keenu settlement for 20 May card sales',
      lines: [
        { accountCode: '1030', type: 'credit', amountCents: 463_000, memo: 'card sales 20 May' },
        { accountCode: '6080', type: 'debit',  amountCents: 9_260,   memo: 'MDR 2%' },
      ],
    })
    expect(ok.statusCode).toBe(200)
    const je = await prisma.journalEntry.findFirstOrThrow({
      where: { reference: `reconciliation.adjustment:${keenu.id}` },
      include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
    })
    expect(je.tenantId).toBe(tenantA)
    const legs = je.lines.map((l) => [l.account.code, l.type, l.amountCents]).sort()
    expect(legs).toEqual([['1020', 'debit', 453_740], ['1030', 'credit', 463_000], ['6080', 'debit', 9_260]].sort())
    expect(je.lines.every((l) => l.account.tenantId === tenantA)).toBe(true)
    // 1030 clears in full.
    const ar = await prisma.journalLine.findMany({ where: { account: { code: '1030', tenantId: tenantA }, journalEntry: { reference: { in: ['test.card_sales:keenu-1', `reconciliation.adjustment:${keenu.id}`] } } } })
    expect(ar.reduce((s, l) => s + (l.type === 'debit' ? l.amountCents : -l.amountCents), 0)).toBe(0)
    const after = await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: keenu.id } })
    expect(after.matchStatus).toBe('adjusted')
    // A second go is refused — the line is cleared.
    expect((await call('both', 'POST', `/reconciliation/bank/lines/${keenu.id}/adjust`, { memo: 'again', contraAccountCode: '1030' })).statusCode).toBe(422)
  })

  it('BOOKS-11: the single-account adjustment still works', async () => {
    const lines = (await call('ceo', 'GET', `/reconciliation/bank/imports/${importId}/lines`)).json() as Array<{ id: string; description: string }>
    const fee = lines.find((l) => l.description === 'Bank charges')!
    expect((await call('ceo', 'POST', `/reconciliation/bank/lines/${fee.id}/adjust`, { contraAccountCode: '6081', memo: 'HBL SMS charges' })).statusCode).toBe(200)
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `reconciliation.adjustment:${fee.id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(je.lines.map((l) => [l.account.code, l.type, l.amountCents]).sort()).toEqual([['1020', 'credit', 15_000], ['6081', 'debit', 15_000]])
  })
})
