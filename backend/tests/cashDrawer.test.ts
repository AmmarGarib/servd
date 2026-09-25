// The cash drawer, reconciled onto one implementation of each thing.
//
// What this guards:
//   - ONE expected-cash formula (lib/drawer.ts): opening + cash sales − cash
//     refunds − drops − pay-outs + adds + pay-ins. The close's variance alert,
//     the Z-report, the ledger post, /reconciliation and deposit drops all use
//     it, so a drop to the safe is not a "cash variance" anywhere any more.
//   - The shift journal entry books each drawer movement as its own balanced
//     pair; 8010 carries only the true over/short (and, until pay-outs get
//     their own posting, pay-outs on their own labelled line).
//   - ONE shift close: /reconciliation's old close is gone, the POS close
//     posts every shift, and a drawer closed from admin frees the till via
//     GET /pos/shifts/current.
//   - ONE shift→company rule (Shift.tenantId, then location, then cashier —
//     each only when the field above is null).
//   - ONE comp engine: compOrder, on the drawer, never more than is due; the
//     'comp' tender is gone.
//   - Bank accounts hang off chart codes; a deposit posts to its bank's code,
//     so the statement line auto-matches.
//   - The scheduled shift summary is the Z-report.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { drawerExpectationOf } from '../src/lib/drawer.js'
import { shiftOfCompany, shiftTenantId } from '../src/lib/tenantScope.js'
import { closeShift, getZReport, compOrder, processPayment } from '../src/modules/pos/service.js'
import { buildShiftCloseEntry } from '../src/modules/accounting/shiftPosting.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { buildShiftSummaryReport } from '../src/workers/scheduledReports.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { setupRoutes } from '../src/modules/setup/routes.js'

let tenantA: string
let tenantB: string
let conceptA: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
    v = await read()
  }
  return v
}

async function mkUser(key: string, role: string, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.cashtest@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, activeTenant?: string) =>
  app.inject({
    method, url, payload: payload as never,
    headers: { authorization: `Bearer ${users[who]!.token}`, ...(activeTenant && { 'x-servd-active-tenant': activeTenant }) },
  })

async function openShift(tenantId: string | null, openingFloatCents: number, userId = users['cashier']!.id) {
  // One open drawer per cashier: close any left over from a previous test.
  await prisma.shift.updateMany({ where: { userId, status: 'open' }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
  return prisma.shift.create({ data: { userId, openingFloatCents, status: 'open', tenantId } })
}

async function cashSale(shiftId: string, cents: number) {
  const o = await prisma.order.create({
    data: { conceptId: conceptA, source: 'pos', status: 'completed', totalCents: cents, items: { create: [{ name: 'Latte', quantity: 1, unitPriceCents: cents }] } },
  })
  await prisma.payment.create({ data: { orderId: o.id, shiftId, method: 'cash', amountCents: cents, status: 'paid', processedAt: new Date() } })
  return o
}

async function shiftEntryLines(shiftId: string) {
  const je = await waitFor(
    () => prisma.journalEntry.findFirst({ where: { reference: `shift.close:${shiftId}` }, include: { lines: { include: { account: { select: { code: true } } } } } }),
    (x) => !!x,
  )
  expect(je).toBeTruthy()
  return je!.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, memo: l.memo ?? '' }))
}

const sum = (lines: Array<{ code: string; type: string; amount: number }>, code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)

beforeAll(async () => {
  // B is created first so it is the "primary" company a company-less read
  // would fall back on; everything below must land on A.
  tenantB = (await prisma.tenant.create({ data: { name: 'Cash B', slug: 'cash-b' } })).id
  tenantA = (await prisma.tenant.create({ data: { name: 'Cash A', slug: 'cash-a' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA = (await prisma.concept.create({
    data: { name: 'Cash Cafe', slug: 'cash-cafe-a', type: 'restaurant', tenantId: tenantA, taxRateCash: 0, taxRateCard: 0 },
  })).id
  await mkUser('mgrA', 'admin', tenantA, [tenantA])
  await mkUser('mgrB', 'admin', tenantB, [tenantB])
  // The cashier's PRIMARY company is B, but they work A's till too.
  await mkUser('cashier', 'cashier', tenantB, [tenantA, tenantB])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(posRoutes, { prefix: '/pos' })
  await app.register(reconciliationRoutes, { prefix: '/reconciliation' })
  await app.register(trustopsRoutes, { prefix: '/trustops' })
  await app.register(setupRoutes, { prefix: '/setup' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

// ─── The formula ──────────────────────────────────────────────────────────────

describe('drawerExpectationOf — the one expected-cash formula', () => {
  it('a drop to the safe is not missing cash', () => {
    // PKR 5,000 float, PKR 50,000 cash sales, PKR 20,000 dropped, PKR 35,000 counted.
    const d = drawerExpectationOf({
      openingFloatCents: 500_000,
      payments: [
        { method: 'cash', status: 'paid', amountCents: 5_000_000 },
        { method: 'card', status: 'paid', amountCents: 900_000 },      // never in the drawer
        { method: 'cash', status: 'pending', amountCents: 70_000 },    // not taken yet
      ],
      cashMovements: [{ type: 'drop', amountCents: 2_000_000 }],
    })
    expect(d.expectedCents).toBe(3_500_000)
  })

  it('refunds, pay-outs, adds and pay-ins all move it', () => {
    const d = drawerExpectationOf({
      openingFloatCents: 100_000,
      payments: [
        { method: 'cash', status: 'paid', amountCents: 1_000_000 },
        { method: 'cash', status: 'refunded', amountCents: -200_000 },  // refunds carry a negative amount
        { method: 'card', status: 'refunded', amountCents: -50_000 },   // card refunds leave the drawer alone
      ],
      cashMovements: [
        { type: 'payout', amountCents: 30_000 },
        { type: 'add', amountCents: 10_000 },
        { type: 'payin', amountCents: 5_000 },
      ],
    })
    expect(d.cashRefundsCents).toBe(200_000)
    expect(d.expectedCents).toBe(100_000 + 1_000_000 - 200_000 - 30_000 + 10_000 + 5_000)
  })
})

// ─── Shift → company ─────────────────────────────────────────────────────────

describe('shift → company — one precedence chain', () => {
  it('Shift.tenantId wins; each fallback only when the field above is null', () => {
    expect(shiftTenantId({ tenantId: 'A', locationId: 'L', location: { tenantId: 'L-co' }, user: { tenantId: 'B' } })).toBe('A')
    expect(shiftTenantId({ tenantId: null, locationId: 'L', location: { tenantId: 'L-co' }, user: { tenantId: 'B' } })).toBe('L-co')
    expect(shiftTenantId({ tenantId: null, locationId: null, location: null, user: { tenantId: 'B' } })).toBe('B')
    // A location without a company does NOT fall through to the cashier.
    expect(shiftTenantId({ tenantId: null, locationId: 'L', location: { tenantId: null }, user: { tenantId: 'B' } })).toBeNull()
  })

  it("a drawer opened in A is not B's because the cashier's primary company is B", async () => {
    const shift = await openShift(tenantA, 0)
    const inA = await prisma.shift.findFirst({ where: { id: shift.id, ...shiftOfCompany({ tenantId: tenantA }) } })
    const inB = await prisma.shift.findFirst({ where: { id: shift.id, ...shiftOfCompany({ tenantId: tenantB }) } })
    expect(inA?.id).toBe(shift.id)
    expect(inB).toBeNull()
  })
})

// ─── The close and the ledger ────────────────────────────────────────────────

describe('closeShift — one formula for the alert, the Z-report and the ledger', () => {
  it('a drop balances: no variance flag, Z-report balanced, drop booked 1010/1015, no 8010', async () => {
    const shift = await openShift(tenantA, 500_000)
    await cashSale(shift.id, 5_000_000)
    await prisma.cashMovement.create({ data: { shiftId: shift.id, type: 'drop', amountCents: 2_000_000, reason: 'Safe drop', recordedById: users['cashier']!.id } })

    const z = await closeShift(shift.id, 3_500_000)
    expect(z.expectedCashCents).toBe(3_500_000)
    expect(z.varianceCents).toBe(0)
    expect(z.isBalanced).toBe(true)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'cash_variance', entityId: shift.id } })).toBe(0)

    const lines = await shiftEntryLines(shift.id)
    expect(sum(lines, '1010', 'debit')).toBe(2_000_000)
    expect(sum(lines, '1015', 'credit')).toBe(2_000_000)
    expect(sum(lines, '1015', 'debit')).toBe(5_000_000)
    expect(lines.filter((l) => l.code === '8010')).toHaveLength(0)
    const debits = lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amount, 0)
    const credits = lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amount, 0)
    expect(debits).toBe(credits)
  })

  it('books a cash refund to 7040, a pay-out on its own line, and only the true short to variance', async () => {
    const shift = await openShift(tenantA, 100_000)
    const o = await cashSale(shift.id, 1_000_000)
    await prisma.payment.create({ data: { orderId: o.id, shiftId: shift.id, method: 'cash', amountCents: -200_000, status: 'refunded', processedAt: new Date() } })
    await prisma.cashMovement.create({ data: { shiftId: shift.id, type: 'payout', amountCents: 30_000, reason: 'Ice', recordedById: users['cashier']!.id } })
    // expected = 100k + 1,000k − 200k − 30k = 870k; counted 5k short (inside the 20k default tolerance)
    const z = await closeShift(shift.id, 865_000)
    expect(z.expectedCashCents).toBe(870_000)
    expect(z.varianceCents).toBe(-5_000)
    expect(z.isBalanced).toBe(true)

    const lines = await shiftEntryLines(shift.id)
    expect(sum(lines, '7040', 'debit')).toBe(200_000)
    const payout = lines.filter((l) => l.code === '8010' && l.memo.includes('pay-outs'))
    expect(payout.map((l) => l.amount)).toEqual([30_000])
    const short = lines.filter((l) => l.code === '8010' && l.memo.includes('short'))
    expect(short.map((l) => l.amount)).toEqual([5_000])
    // The drawer account moves by exactly what was counted, less the float.
    expect(sum(lines, '1015', 'debit') - sum(lines, '1015', 'credit')).toBe(865_000 - 100_000)
  })

  it('never books a refund that already has its own journal entry', async () => {
    const shift = await openShift(tenantA, 0)
    const o = await cashSale(shift.id, 300_000)
    const refund = await prisma.payment.create({ data: { orderId: o.id, shiftId: shift.id, method: 'cash', amountCents: -100_000, status: 'refunded', processedAt: new Date() } })
    await postJournalEntry({
      tenantId: tenantA, sourceType: 'order.refund', sourceId: refund.id, description: 'refund', postedBy: 'test',
      lines: [
        { accountCode: '7040', type: 'debit', amountCents: 100_000 },
        { accountCode: '1015', type: 'credit', amountCents: 100_000 },
      ],
    })
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 200_000 } })
    const entry = await buildShiftCloseEntry(shift.id)
    expect(entry.ok).toBe(true)
    if (!entry.ok) return
    expect(entry.lines.filter((l) => l.accountCode === '7040')).toHaveLength(0)
    expect(entry.debits).toBe(entry.credits)
  })

  it('flags a real shortage against the shift company\'s own tolerance', async () => {
    await prisma.receiptConfig.deleteMany({ where: { tenantId: tenantA } })
    await prisma.receiptConfig.create({ data: { scope: 'global', scopeId: null, tenantId: tenantA, cashVarianceLimitCents: 1_000 } })
    invalidateSetupCache()
    const shift = await openShift(tenantA, 0)
    await cashSale(shift.id, 100_000)
    const z = await closeShift(shift.id, 95_000)
    expect(z.varianceCents).toBe(-5_000)
    expect(z.varianceLimitCents).toBe(1_000)
    expect(z.isBalanced).toBe(false)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'cash_variance', entityId: shift.id } })).toBe(1)
    await prisma.receiptConfig.updateMany({ where: { tenantId: tenantA }, data: { cashVarianceLimitCents: 20_000 } })
    invalidateSetupCache()
  })

  it('a drawer closes once — the second close is refused', async () => {
    const shift = await openShift(tenantA, 0)
    await closeShift(shift.id, 0)
    await expect(closeShift(shift.id, 0)).rejects.toMatchObject({ code: 'SHIFT_CLOSED' })
  })
})

// ─── Comps ───────────────────────────────────────────────────────────────────

describe('comps — one engine', () => {
  it('a comp is not a tender', async () => {
    const shift = await openShift(tenantA, 0)
    const o = await prisma.order.create({ data: { conceptId: conceptA, source: 'pos', status: 'received', totalCents: 100_000 } })
    await expect(processPayment({ orderId: o.id, shiftId: shift.id, payments: [{ method: 'comp', amountCents: 100_000 }] }))
      .rejects.toMatchObject({ code: 'COMP_NOT_A_TENDER' })
  })

  it('sits on the drawer, never exceeds what is due, and settles the order once covered', async () => {
    const shift = await openShift(tenantA, 0)
    const o = await prisma.order.create({ data: { conceptId: conceptA, source: 'pos', status: 'received', totalCents: 100_000 } })
    const actor = { actorId: users['mgrA']!.id, actorRole: 'admin' }

    const first = await compOrder({ orderId: o.id, shiftId: shift.id, amountCents: 40_000, reason: 'Cold coffee', ...actor })
    expect(first.shiftId).toBe(shift.id)
    expect(first.orderCompleted).toBe(false)
    await expect(compOrder({ orderId: o.id, shiftId: shift.id, amountCents: 70_000, reason: 'Too much', ...actor }))
      .rejects.toMatchObject({ code: 'COMP_EXCEEDS_DUE' })

    const rest = await compOrder({ orderId: o.id, shiftId: shift.id, amountCents: 60_000, reason: 'Birthday', ...actor })
    expect(rest.orderCompleted).toBe(true)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(order.status).toBe('completed')
    expect(await prisma.financialEntry.count({ where: { orderId: o.id } })).toBe(1)
    await expect(compOrder({ orderId: o.id, shiftId: shift.id, amountCents: 1, reason: 'Again', ...actor }))
      .rejects.toMatchObject({ code: 'ALREADY_PAID' })

    const z = await getZReport(shift.id)
    expect(z.compCents).toBe(100_000)
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
    const entry = await buildShiftCloseEntry(shift.id)
    expect(entry.ok).toBe(true)
    if (!entry.ok) return
    expect(entry.lines.filter((l) => l.accountCode === '7030').reduce((t, l) => t + l.amountCents, 0)).toBe(100_000)
    expect(entry.debits).toBe(entry.credits)
  })
})

// ─── Through the API ─────────────────────────────────────────────────────────

describe('one close, and the till lets go of a drawer closed elsewhere', () => {
  it('the /reconciliation close is gone; a manager closes through /pos and the till re-syncs', async () => {
    const shift = await openShift(tenantA, 0)
    await cashSale(shift.id, 50_000)

    const current = await call('cashier', 'GET', '/pos/shifts/current', undefined, tenantA)
    expect(current.statusCode).toBe(200)
    expect(current.json().shift.id).toBe(shift.id)

    expect((await call('mgrA', 'GET', `/reconciliation/shift/${shift.id}`)).statusCode).toBe(404)
    expect((await call('mgrA', 'POST', `/reconciliation/shift/${shift.id}/complete`, { closingFloat: 50_000 })).statusCode).toBe(404)

    // B's manager cannot close A's drawer just because the cashier's primary company is B.
    expect((await call('mgrB', 'POST', `/pos/shifts/${shift.id}/close`, { closingFloatCents: 50_000 })).statusCode).toBe(404)

    const closed = await call('mgrA', 'POST', `/pos/shifts/${shift.id}/close`, { closingFloatCents: 50_000 })
    expect(closed.statusCode).toBe(200)
    expect(closed.json().isBalanced).toBe(true)
    // …and it reached the books.
    await shiftEntryLines(shift.id)

    const after = await call('cashier', 'GET', '/pos/shifts/current', undefined, tenantA)
    expect(after.json().shift).toBeNull()
  })

  it('/reconciliation/summary lists A\'s drawer under A only, with the server\'s verdict', async () => {
    const shift = await openShift(tenantA, 0)
    await cashSale(shift.id, 10_000)
    await closeShift(shift.id, 10_000)
    const a = (await call('mgrA', 'GET', '/reconciliation/summary')).json()
    const row = a.shifts.find((s: { shiftId: string }) => s.shiftId === shift.id)
    expect(row).toBeTruthy()
    expect(row.isBalanced).toBe(true)
    expect(row.varianceLimitCents).toBe(20_000)
    const b = (await call('mgrB', 'GET', '/reconciliation/summary')).json()
    expect(b.shifts.find((s: { shiftId: string }) => s.shiftId === shift.id)).toBeUndefined()
  })

  it('a comp must name an open drawer of the order\'s company', async () => {
    const o = await prisma.order.create({ data: { conceptId: conceptA, source: 'pos', status: 'received', totalCents: 10_000 } })
    expect((await call('mgrA', 'POST', `/pos/orders/${o.id}/comp`, { amountCents: 1_000, reason: 'x' })).statusCode).toBe(400)
    const foreign = await prisma.shift.create({ data: { userId: users['mgrB']!.id, openingFloatCents: 0, status: 'open', tenantId: tenantB } })
    const r = await call('mgrA', 'POST', `/pos/orders/${o.id}/comp`, { amountCents: 1_000, reason: 'x', shiftId: foreign.id })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('SHIFT_NOT_IN_COMPANY')
    const tender = await call('mgrA', 'POST', '/pos/payments', { orderId: o.id, shiftId: foreign.id, payments: [{ method: 'comp', amountCents: 10_000 }] })
    expect(tender.statusCode).toBe(400)
  })
})

describe('bank accounts hang off the ledger; deposits post and match', () => {
  it('links the first bank to 1020 and a second to a new 102x child', async () => {
    const hbl = await call('mgrA', 'POST', '/setup/bank-accounts', { name: 'HBL Ops', bankName: 'HBL' })
    expect(hbl.statusCode).toBe(201)
    expect(hbl.json().accountCode).toBe('1020')
    const meezan = await call('mgrA', 'POST', '/setup/bank-accounts', { name: 'Meezan', bankName: 'Meezan' })
    expect(meezan.json().accountCode).toBe('1021')
    expect(await prisma.account.count({ where: { tenantId: tenantA, code: '1021', type: 'asset' } })).toBe(1)
    const bad = await call('mgrA', 'POST', '/setup/bank-accounts', { name: 'Wrong', accountCode: '4090' })
    expect(bad.statusCode).toBe(422)
  })

  it('a deposit expects drops + counted close − float, posts to its bank, and the statement matches it', async () => {
    const bank = (await call('mgrA', 'GET', '/setup/bank-accounts')).json().find((b: { name: string }) => b.name === 'Meezan')
    const shift = await openShift(tenantA, 100_000)
    await cashSale(shift.id, 1_000_000)
    await prisma.cashMovement.create({ data: { shiftId: shift.id, type: 'drop', amountCents: 400_000, reason: 'Safe', recordedById: users['cashier']!.id } })
    await closeShift(shift.id, 700_000)       // expected 100k + 1,000k − 400k = 700k

    // A foreign drawer is refused, not peeked at.
    const foreign = await prisma.shift.create({ data: { userId: users['mgrB']!.id, openingFloatCents: 0, status: 'closed', tenantId: tenantB } })
    expect((await call('mgrA', 'POST', '/trustops/deposit-drops', { shiftId: foreign.id, amountCents: 1 })).statusCode).toBe(422)

    const dep = await call('mgrA', 'POST', '/trustops/deposit-drops', { shiftId: shift.id, bankAccountId: bank.id, amountCents: 1_000_000 })
    expect(dep.statusCode).toBe(201)
    expect(dep.json().expectedCents).toBe(400_000 + 700_000 - 100_000)
    expect(dep.json().varianceCents).toBe(0)
    expect(dep.json().tenantId).toBe(tenantA)

    const je = await waitFor(
      () => prisma.journalEntry.findFirst({ where: { reference: `deposit.drop:${dep.json().id}` }, include: { lines: { include: { account: { select: { code: true } } } } } }),
      (x) => !!x,
    )
    const lines = je!.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents }))
    expect(sum(lines, '1021', 'debit')).toBe(1_000_000)
    expect(sum(lines, '1010', 'credit')).toBe(400_000)
    expect(sum(lines, '1015', 'credit')).toBe(600_000)

    const list = (await call('mgrA', 'GET', '/trustops/deposit-drops')).json()
    expect(list.find((d: { id: string }) => d.id === dep.json().id).withinTolerance).toBe(true)
    expect((await call('mgrB', 'GET', '/trustops/deposit-drops')).json().find((d: { id: string }) => d.id === dep.json().id)).toBeUndefined()

    const today = new Date().toISOString().slice(0, 10)
    const imp = await call('mgrA', 'POST', '/reconciliation/bank/imports', {
      bankAccountId: bank.id, statementDate: today, openingBalanceCents: 0, closingBalanceCents: 1_000_000,
      filename: 'meezan.csv', fileUrl: 'https://example.com/meezan.csv',
      csv: `date,description,amount\n${today},Cash deposit,10000\n${today},Bank charges,-50`,
    })
    expect(imp.statusCode).toBe(201)
    expect(imp.json().matchedCount).toBe(1)
    const row = await prisma.bankStatementImport.findUniqueOrThrow({ where: { id: imp.json().importId } })
    expect(row.accountCode).toBe('1021')
    expect(row.tenantId).toBe(tenantA)
    expect(row.bankAccountId).toBe(bank.id)

    // Another company can neither see the import nor clear its lines.
    expect((await call('mgrB', 'GET', '/reconciliation/bank/imports')).json().find((i: { id: string }) => i.id === row.id)).toBeUndefined()
    const unmatched = await prisma.bankStatementLine.findFirstOrThrow({ where: { importId: row.id, matchStatus: 'unmatched' } })
    expect((await call('mgrB', 'POST', `/reconciliation/bank/lines/${unmatched.id}/ignore`, {})).statusCode).toBe(404)
    const adj = await call('mgrA', 'POST', `/reconciliation/bank/lines/${unmatched.id}/adjust`, { contraAccountCode: '6081', memo: 'Bank charges' })
    expect(adj.statusCode).toBe(200)
    expect(await prisma.journalEntry.count({ where: { reference: `reconciliation.adjustment:${unmatched.id}`, tenantId: tenantA } })).toBe(1)
  })
})

describe('the scheduled shift summary is the Z-report', () => {
  it('lists the company\'s drawers closed since the last run, and nothing else', async () => {
    const since = new Date(Date.now() - 1000)
    const shift = await openShift(tenantA, 0)
    await cashSale(shift.id, 25_000)
    await closeShift(shift.id, 25_000)
    const report = await buildShiftSummaryReport(tenantA, since)
    expect(report).not.toBeNull()
    expect(report!.html).toContain('cashier')
    expect(report!.html).toContain('Expected cash')
    expect(await buildShiftSummaryReport(tenantB, since)).toBeNull()
  })
})
