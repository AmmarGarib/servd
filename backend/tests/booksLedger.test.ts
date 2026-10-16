// The books, reconciled onto one implementation of each thing.
//
// What this guards:
//   - ONE sale-to-ledger formula (computeSaleAccounting). The POS shift close
//     sums it per brand instead of carrying its own inline copy, so till
//     service charge goes to 4100 (not food revenue), and a card awaiting the
//     gateway, an open split or a rounding paisa no longer unbalances the
//     entry and drops the whole shift from the ledger. The Z-report reads the
//     same totals.
//   - ONE journal writer (postJournalEntry). The manual-entry route posts
//     through it: idempotency key, per-company chart, the same period-lock
//     rule and message, and an optional brand per line.
//   - ONE chart-of-accounts API (/setup/chart-of-accounts), readable by
//     finance, audited on the accounting trail; the starting chart is
//     lib/chartOfAccounts.ts and the old aggregator accounts retire once they
//     are at zero.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts, retireAggregatorAccounts } from '../src/lib/chartOfAccounts.js'
import { computeSaleAccounting } from '../src/modules/accounting/orderPosting.js'
import { postShiftClose, postPosCardFailure, buildShiftCloseEntry } from '../src/modules/accounting/shiftPosting.js'
import { getZReport } from '../src/modules/pos/service.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { setupRoutes } from '../src/modules/setup/routes.js'

let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.bookstest@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, activeTenant?: string) =>
  app.inject({
    method, url, payload: payload as never,
    headers: { authorization: `Bearer ${users[who]!.token}`, ...(activeTenant && { 'x-servd-active-tenant': activeTenant }) },
  })

let cashierSeq = 0
async function freshShift(openingFloatCents = 0) {
  // Each drawer its own cashier, so "one open drawer per cashier" never bites.
  const u = await prisma.user.create({
    data: { name: `till${++cashierSeq}`, email: `till${cashierSeq}.bookstest@gsfoods.pk`, password: 'x', role: 'cashier', isActive: true, accountStatus: 'active', tenantId: tenantA },
  })
  return prisma.shift.create({ data: { userId: u.id, openingFloatCents, status: 'open', tenantId: tenantA } })
}

async function closeAndPost(shiftId: string, countedCents: number) {
  await prisma.shift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: countedCents } })
  const r = await postShiftClose(shiftId)
  expect(r.posted).toBe(true)
  const je = await prisma.journalEntry.findFirstOrThrow({
    where: { reference: `shift.close:${shiftId}` },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, memo: l.memo ?? '', conceptId: l.conceptId }))
}

type Line = { code: string; type: string; amount: number; memo: string }
const sum = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
const balanced = (lines: Line[]) =>
  lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amount, 0) ===
  lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amount, 0)

// A till sale: PKR 1,000 of food, GST 15% on the pre-discount value (150),
// PKR 100 discount, then a 5% service charge on the net (52.50).
const TILL = { itemTotal: 100_000, tax: 15_000, discount: 10_000, svc: 5_250 }
const TILL_TOTAL = TILL.itemTotal + TILL.tax - TILL.discount + TILL.svc   // 110,250

async function tillOrder(conceptId = conceptA, over: Partial<{ totalCents: number; source: 'pos' | 'servd' }> = {}) {
  return prisma.order.create({
    data: {
      conceptId, source: over.source ?? 'pos', status: 'completed',
      totalCents: over.totalCents ?? TILL_TOTAL,
      taxCents: over.totalCents ? 0 : TILL.tax,
      discountCents: over.totalCents ? 0 : TILL.discount,
      serviceChargeCents: over.totalCents ? 0 : TILL.svc,
      items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: TILL.itemTotal }] },
    },
  })
}

async function pay(orderId: string, shiftId: string, method: 'cash' | 'card' | 'comp', amountCents: number, status: 'paid' | 'pending' | 'refunded' | 'failed' = 'paid', gatewayRef: string | null = null) {
  return prisma.payment.create({
    data: { orderId, shiftId, method, amountCents, status, gatewayRef, processedAt: status === 'paid' ? new Date() : null },
  })
}

beforeAll(async () => {
  tenantB = (await prisma.tenant.create({ data: { name: 'Books B', slug: 'books-b' } })).id
  tenantA = (await prisma.tenant.create({ data: { name: 'Books A', slug: 'books-a' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA = (await prisma.concept.create({ data: { name: 'Books Cafe', slug: 'books-cafe-a', type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Books Grill', slug: 'books-grill-b', type: 'restaurant', tenantId: tenantB } })).id
  await mkUser('ceo', 'admin', tenantA, [tenantA, tenantB])
  await mkUser('fin', 'finance', tenantA, [tenantA])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.register(setupRoutes, { prefix: '/setup' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

// ─── One sale formula ────────────────────────────────────────────────────────

describe('computeSaleAccounting — the one sale-to-ledger formula', () => {
  it('splits a till total into item revenue, GST, service charge and discount, and balances', () => {
    const sa = computeSaleAccounting({ totalCents: TILL_TOTAL, walletAmountCents: 0, taxCents: TILL.tax, discountCents: TILL.discount, promoDiscountCents: 0, serviceChargeCents: TILL.svc, tipCents: 0 })
    expect(sa.grossRevenueCents).toBe(TILL.itemTotal)
    expect(sa.serviceChargeCents).toBe(TILL.svc)
    expect(sa.totalChargedCents + sa.walletAppliedCents + sa.discountCents)
      .toBe(sa.grossRevenueCents + sa.taxCents + sa.serviceChargeCents + sa.tipCents)
  })
})

describe('POS shift close sums computeSaleAccounting', () => {
  it('credits till service charge to 4100, not to the brand\'s food revenue', async () => {
    const shift = await freshShift(0)
    const o = await tillOrder()
    await pay(o.id, shift.id, 'cash', TILL_TOTAL)
    const lines = await closeAndPost(shift.id, TILL_TOTAL)

    expect(balanced(lines)).toBe(true)
    expect(sum(lines, '1015', 'debit')).toBe(TILL_TOTAL)
    expect(sum(lines, '7010', 'debit')).toBe(TILL.discount)
    expect(sum(lines, '4090', 'credit')).toBe(TILL.itemTotal)      // the brand's revenue: food only
    expect(sum(lines, '4100', 'credit')).toBe(TILL.svc)
    expect(sum(lines, '2030', 'credit')).toBe(TILL.tax)
    // Revenue and service charge carry the brand, so the brand P&L measures them.
    expect(lines.filter((l) => l.code === '4100').every((l) => l.conceptId === conceptA)).toBe(true)
  })

  it('the Z-report shows the tax, discount and service charge the entry posted', async () => {
    const shift = await freshShift(0)
    const o = await tillOrder()
    await pay(o.id, shift.id, 'cash', TILL_TOTAL)
    const lines = await closeAndPost(shift.id, TILL_TOTAL)
    const z = await getZReport(shift.id)
    expect(z.taxCents).toBe(sum(lines, '2030', 'credit'))
    expect(z.discountCents).toBe(sum(lines, '7010', 'debit'))
    expect(z.serviceChargeCents).toBe(sum(lines, '4100', 'credit'))
    expect(z.ordersCount).toBe(1)
  })

  it('a card still awaiting the gateway is a receivable, and no longer unbalances the shift', async () => {
    const shift = await freshShift(0)
    const o = await tillOrder()
    await pay(o.id, shift.id, 'cash', 50_000)
    await pay(o.id, shift.id, 'card', TILL_TOTAL - 50_000, 'pending', 'TERM-001')
    const lines = await closeAndPost(shift.id, 50_000)

    expect(balanced(lines)).toBe(true)
    expect(sum(lines, '1015', 'debit')).toBe(50_000)
    const awaiting = lines.filter((l) => l.code === '1030' && l.type === 'debit')
    expect(awaiting.reduce((t, l) => t + l.amount, 0)).toBe(TILL_TOTAL - 50_000)
    expect(awaiting[0]!.memo).toMatch(/awaiting gateway confirmation/)
    expect(sum(lines, '4090', 'credit')).toBe(TILL.itemTotal)
  })

  it('an open split goes to customer receivable; a sub-tolerance paisa is rounding', async () => {
    const shift = await freshShift(0)
    const open = await tillOrder()
    await pay(open.id, shift.id, 'cash', 60_000)
    await pay(open.id, shift.id, 'cash', TILL_TOTAL - 60_000, 'pending')           // split not yet paid
    const rounded = await tillOrder(conceptA, { totalCents: 10_001 })
    await pay(rounded.id, shift.id, 'cash', 10_000)                                    // within the 2-paisa tolerance
    const lines = await closeAndPost(shift.id, 70_000)

    expect(balanced(lines)).toBe(true)
    expect(sum(lines, '1110', 'debit')).toBe(TILL_TOTAL - 60_000)
    expect(lines.some((l) => l.code === '8010' && /rounding/i.test(l.memo) && l.amount === 1)).toBe(true)
  })

  it('an order paid across two drawers is booked once — by the drawer holding its first receipt', async () => {
    const first = await freshShift(0)
    const second = await freshShift(0)
    const o = await tillOrder()
    await pay(o.id, first.id, 'cash', 40_000)
    await new Promise((r) => setTimeout(r, 5))
    await pay(o.id, second.id, 'cash', TILL_TOTAL - 40_000)

    const a = await closeAndPost(first.id, 40_000)
    const b = await closeAndPost(second.id, TILL_TOTAL - 40_000)
    expect(sum(a, '4090', 'credit')).toBe(TILL.itemTotal)
    expect(sum(a, '1110', 'debit')).toBe(TILL_TOTAL - 40_000)
    expect(sum(b, '4090', 'credit')).toBe(0)
    expect(sum(b, '1110', 'credit')).toBe(TILL_TOTAL - 40_000)
    expect(balanced(a) && balanced(b)).toBe(true)
  })

  it('an online order paid at the drawer is not booked twice — only its cash moves in', async () => {
    const shift = await freshShift(0)
    const o = await tillOrder(conceptA, { source: 'servd', totalCents: 30_000 })
    await pay(o.id, shift.id, 'cash', 30_000)
    const lines = await closeAndPost(shift.id, 30_000)
    expect(sum(lines, '4090', 'credit')).toBe(0)
    expect(sum(lines, '1015', 'debit')).toBe(30_000)
    expect(sum(lines, '1010', 'credit')).toBe(30_000)
  })

  it('books a card refund against card receivable', async () => {
    const shift = await freshShift(0)
    const o = await tillOrder()
    await pay(o.id, shift.id, 'card', TILL_TOTAL, 'paid', 'TERM-002')
    await pay(o.id, shift.id, 'card', -20_000, 'refunded')
    const lines = await closeAndPost(shift.id, 0)
    expect(balanced(lines)).toBe(true)
    expect(sum(lines, '7040', 'debit')).toBe(20_000)
    expect(sum(lines, '1030', 'credit')).toBe(20_000)
  })

  it('a card the gateway fails after the close moves from 1030 to the customer, once', async () => {
    const shift = await freshShift(0)
    const o = await tillOrder()
    const card = await pay(o.id, shift.id, 'card', TILL_TOTAL, 'pending', 'TERM-003')
    await closeAndPost(shift.id, 0)

    await prisma.payment.update({ where: { id: card.id }, data: { status: 'failed' } })
    const first = await postPosCardFailure(card.id)
    const again = await postPosCardFailure(card.id)
    expect(first.posted).toBe(true)
    expect(again.posted).toBe(false)
    const je = await prisma.journalEntry.findFirstOrThrow({
      where: { reference: `pos.card_failed:${card.id}` },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    const lines = je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, memo: l.memo ?? '' }))
    expect(sum(lines, '1110', 'debit')).toBe(TILL_TOTAL)
    expect(sum(lines, '1030', 'credit')).toBe(TILL_TOTAL)
    expect(je.tenantId).toBe(tenantA)
  })

  it('a card that fails while the drawer is still open is simply left out of the close', async () => {
    const shift = await freshShift(0)
    const o = await tillOrder()
    const card = await pay(o.id, shift.id, 'card', TILL_TOTAL, 'failed', 'TERM-004')
    expect((await postPosCardFailure(card.id)).reason).toBe('shift_not_posted')
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
    const entry = await buildShiftCloseEntry(shift.id)
    expect(entry.ok).toBe(false)   // nothing received on this drawer — no sale to book
  })
})

// ─── One journal writer ──────────────────────────────────────────────────────

describe('POST /accounting/journal posts through postJournalEntry', () => {
  it('gets an idempotency key, keeps the operator reference, and can name a brand per line', async () => {
    const accts = await prisma.account.findMany({ where: { tenantId: tenantA, code: { in: ['6060', '1020'] } } })
    const mkt = accts.find((a) => a.code === '6060')!
    const bank = accts.find((a) => a.code === '1020')!
    const res = await call('ceo', 'POST', '/accounting/journal', {
      reference: 'JV-0042',
      description: 'Flyers for the cafe',
      lines: [
        { accountId: mkt.id, type: 'debit', amountCents: 25_000, conceptId: conceptA },
        { accountId: bank.id, type: 'credit', amountCents: 25_000 },
      ],
    }, tenantA)
    expect(res.statusCode).toBe(201)
    const entry = res.json() as { id: string; reference: string; description: string; tenantId: string; lines: Array<{ accountId: string; conceptId: string | null }> }
    expect(entry.reference).toMatch(/^manual:[0-9a-f-]{36}$/)
    expect(entry.description).toContain('JV-0042')
    expect(entry.tenantId).toBe(tenantA)
    expect(entry.lines.find((l) => l.accountId === mkt.id)!.conceptId).toBe(conceptA)
    expect(entry.lines.find((l) => l.accountId === bank.id)!.conceptId).toBeNull()

    const trail = await prisma.auditLog.findFirst({ where: { action: 'journal.manual', entityId: entry.id } })
    expect(trail?.category).toBe('accounting')
  })

  it('refuses another company\'s brand on a line', async () => {
    const accts = await prisma.account.findMany({ where: { tenantId: tenantA, code: { in: ['6060', '1020'] } } })
    const res = await call('ceo', 'POST', '/accounting/journal', {
      description: 'Wrong brand',
      lines: [
        { accountId: accts[0]!.id, type: 'debit', amountCents: 1_000, conceptId: conceptB },
        { accountId: accts[1]!.id, type: 'credit', amountCents: 1_000 },
      ],
    }, tenantA)
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('BRAND_NOT_IN_COMPANY')
  })

  it('applies the one period-lock rule, with the dates in PKT', async () => {
    const lock = await prisma.periodLock.create({ data: { tenantId: tenantA, lockedThrough: new Date('2026-03-31T23:59:59.999+05:00'), lockedBy: 'test' } })
    const accts = await prisma.account.findMany({ where: { tenantId: tenantA, code: { in: ['6060', '1020'] } } })
    const res = await call('ceo', 'POST', '/accounting/journal', {
      description: 'Backdated',
      // 00:30 on 1 March PKT is still 28 Feb in UTC.
      entryDate: '2026-02-28T19:30:00.000Z',
      lines: [
        { accountId: accts[0]!.id, type: 'debit', amountCents: 1_000 },
        { accountId: accts[1]!.id, type: 'credit', amountCents: 1_000 },
      ],
    }, tenantA)
    await prisma.periodLock.delete({ where: { id: lock.id } })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('PERIOD_LOCKED')
    expect(res.json().error.message).toContain('Cannot post to 2026-03-01')
    expect(res.json().error.message).toContain('closed through 2026-03-31')
  })
})

// ─── One chart of accounts ───────────────────────────────────────────────────

describe('chart of accounts — one API, one starting chart', () => {
  it('finance can read the chart; the old /accounting/accounts copy is gone', async () => {
    const res = await call('fin', 'GET', '/setup/chart-of-accounts')
    expect(res.statusCode).toBe(200)
    const codes = (res.json() as Array<{ code: string; tenantId: string }>).map((a) => a.code)
    expect(codes).toContain('4100')
    expect((res.json() as Array<{ tenantId: string }>).every((a) => a.tenantId === tenantA)).toBe(true)
    expect((await call('fin', 'GET', '/accounting/accounts')).statusCode).toBe(404)
  })

  it('creating and editing an account goes on the accounting trail', async () => {
    const created = await call('ceo', 'POST', '/setup/chart-of-accounts', { code: '6310', name: 'Marketing software', type: 'expense' }, tenantA)
    expect(created.statusCode).toBe(201)
    const id = (created.json() as { id: string }).id
    const edited = await call('ceo', 'PATCH', `/setup/chart-of-accounts/${id}`, { isActive: false }, tenantA)
    expect(edited.statusCode).toBe(200)
    const rows = await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } })
    expect(rows.map((r) => [r.action, r.category, r.tenantId])).toEqual([
      ['account.create', 'accounting', tenantA],
      ['account.update', 'accounting', tenantA],
    ])
  })

  it('retires the old aggregator accounts only when they are at zero, and never an operator\'s own', async () => {
    const t = (await prisma.tenant.create({ data: { name: 'Books Legacy', slug: 'books-legacy' } })).id
    await ensureChartOfAccounts(t)
    const fp = await prisma.account.create({ data: { tenantId: t, code: '1120', name: 'Foodpanda Settlement Receivable', type: 'asset' } })
    const owed = await prisma.account.create({ data: { tenantId: t, code: '2070', name: 'Foodpanda Commission Payable', type: 'liability' } })
    const mine = await prisma.account.create({ data: { tenantId: t, code: '6090', name: 'Consulting', type: 'expense' } })
    const bank = await prisma.account.findFirstOrThrow({ where: { tenantId: t, code: '1020' } })
    // 2070 still carries a balance.
    await prisma.journalEntry.create({
      data: {
        tenantId: t, reference: 'test:legacy-balance', description: 'legacy',
        lines: { create: [
          { accountId: bank.id, type: 'debit', amountCents: 5_000 },
          { accountId: owed.id, type: 'credit', amountCents: 5_000 },
        ] },
      },
    })

    expect(await retireAggregatorAccounts(t)).toEqual(['1120'])
    const after = await prisma.account.findMany({ where: { id: { in: [fp.id, owed.id, mine.id] } } })
    expect(after.find((a) => a.id === fp.id)!.isActive).toBe(false)
    expect(after.find((a) => a.id === owed.id)!.isActive).toBe(true)
    expect(after.find((a) => a.id === mine.id)!.isActive).toBe(true)
  })
})
