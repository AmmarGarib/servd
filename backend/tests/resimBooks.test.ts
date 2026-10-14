// Re-simulation fixes, books stream B (2026-10-12):
//
//   - BOOKS-R2-01: the latest lockable date is YESTERDAY (PKT); an order
//     completion, refund restore or loyalty earn the ledger refuses raises a
//     high posting_failed exception with the order id in the order's company;
//     POST /reconciliation/backfill-unposted re-posts them per company,
//     idempotently, respecting locks (dry run first).
//   - BOOKS-06: journal_lines.amountCents is BIGINT — a PKR 25m line posts;
//     only a line above PKR 900bn (MAX_MONEY_CENTS) is 422 AMOUNT_TOO_LARGE.
//   - BOH-R2-02 (on FIFO lots since wave B): a supplier bill posted before its
//     goods are all received prices only the received quantity (re-pricing its
//     lot) and bills the rest ahead (Dr 2015 at the billed price; the receipt
//     opens that lot at the billed price); voiding it takes back out exactly
//     what it put in and re-opens GRNI.
// Every journal entry this suite writes is checked to balance, in one company.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { MAX_MONEY_CENTS } from '../src/lib/money.js'
import { pktToday, parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import { completeOrder, postRefundOrFlag } from '../src/modules/orders/service.js'
import { receiveGoods, receiveGoodsTx } from '../src/modules/procurement/receiving.js'
import { createBill, voidBill } from '../src/modules/procurement/service.js'
import { addLotTx, consumeFifoTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { backfillUnpostedOrders } from '../src/modules/reconciliation/backfillOrders.js'

let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.resimbooks@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

const ymd = (d: Date) => new Date(d.getTime() + 5 * 3600_000).toISOString().slice(0, 10)   // PKT date
const DAY = 86_400_000

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 6000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) { await new Promise((r) => setTimeout(r, 50)); v = await read() }
  return v
}

type Row = { code: string; type: string; amount: number }
async function entry(tenantId: string, reference: string): Promise<Row[] | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  return je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents }))
}
const sumOf = (rows: Row[], code: string, type: 'debit' | 'credit') =>
  rows.filter((r) => r.code === code && r.type === type).reduce((t, r) => t + r.amount, 0)
async function netDebit(tenantId: string, code: string, reference: string): Promise<number> {
  const rows = await entry(tenantId, reference)
  return rows ? sumOf(rows, code, 'debit') - sumOf(rows, code, 'credit') : 0
}
const flagsOf = (entityId: string, sourceType?: string) => prisma.exceptionFlag.findMany({
  where: { kind: 'posting_failed', entityId, ...(sourceType && { metadata: { path: ['sourceType'], equals: sourceType } }) },
})

/** A lock straight in the table — the route refuses today now, but a lock through today may already exist. */
async function lockThroughToday(tenantId: string) {
  return prisma.periodLock.create({ data: { tenantId, lockedThrough: pktToday().to, lockedBy: users.adminA!.id, note: 'legacy lock through today' } })
}

let seq = 0
async function onlineOrder(conceptId: string, totalCents = 149_500, taxCents = 19_500) {
  seq += 1
  const customer = await prisma.customer.create({ data: { name: `cust${seq}`, email: `c${seq}.${Date.now()}@resimbooks.test` } })
  return prisma.order.create({
    data: {
      conceptId, customerId: customer.id, source: 'servd', status: 'completed', completedAt: new Date(),
      totalCents, taxCents,
      items: { create: [{ name: 'Loaded Fries', quantity: 2, unitPriceCents: (totalCents - taxCents) / 2 }] },
    },
  })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Resim Books A', slug: 'resim-books-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Resim Books B', slug: 'resim-books-b' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()
  conceptA = (await prisma.concept.create({ data: { name: 'Flipd A', slug: 'flipd', type: 'restaurant', tenantId: tenantA, taxRateCash: 15, taxRateCard: 8 } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Simmer B', slug: 'simmer', type: 'restaurant', tenantId: tenantB, taxRateCash: 15, taxRateCard: 8 } })).id
  await mkUser('adminA', 'admin', tenantA)
  await mkUser('adminB', 'admin', tenantB)
  await mkUser('mgrA', 'fnb_manager', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.register(reconciliationRoutes, { prefix: '/reconciliation' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  const entries = await prisma.journalEntry.findMany({
    where: { tenantId: { in: [tenantA, tenantB] } },
    include: { lines: { include: { account: { select: { tenantId: true } } } } },
  })
  expect(entries.length).toBeGreaterThan(0)
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
    expect({ ref: e.reference, d }).toEqual({ ref: e.reference, d: c })
    for (const l of e.lines) expect(l.account.tenantId).toBe(e.tenantId)
  }
  await app?.close()
})

// ─── BOOKS-R2-01 (1): the latest lockable date is yesterday ─────────────────

describe('BOOKS-R2-01: books close through yesterday at the latest (PKT)', () => {
  it('refuses today and tomorrow with LOCK_IN_FUTURE; yesterday is accepted', async () => {
    const today = pktToday()
    for (const d of [ymd(today.from), ymd(new Date(today.from.getTime() + DAY))]) {
      const r = await call('adminA', 'POST', '/accounting/period-close', { lockedThrough: d, note: 'Day closed at 8pm' })
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('LOCK_IN_FUTURE')
      expect(r.json().error.message).toMatch(/still trading.*yesterday/)
    }
    expect(await prisma.periodLock.count({ where: { tenantId: tenantA } })).toBe(0)

    const yesterday = ymd(new Date(today.from.getTime() - 1))
    const ok = await call('adminA', 'POST', '/accounting/period-close', { lockedThrough: yesterday })
    expect(ok.statusCode).toBe(201)
    expect(new Date(ok.json().lockedThrough).getTime()).toBe(parsePktEndOfDay(yesterday).getTime())
    // Company B's books are untouched.
    expect(await prisma.periodLock.count({ where: { tenantId: tenantB } })).toBe(0)

    // An online order completed today still posts under the lock through yesterday.
    const o = await onlineOrder(conceptA)
    await completeOrder(o.id, null, { via: 'status_update' })
    const je = await waitFor(() => entry(tenantA, `order.complete:${o.id}`), (v) => !!v)
    expect(je).not.toBeNull()
    expect(await flagsOf(o.id)).toHaveLength(0)

    expect((await call('adminA', 'POST', '/accounting/period-close/reopen', { reason: 'test cleanup' })).statusCode).toBe(200)
  })
})

// ─── BOOKS-R2-01 (2 + 3): refused postings flagged, then backfilled ─────────

describe('BOOKS-R2-01: a refused completion / loyalty earn / refund is flagged and re-posted by the backfill', () => {
  it('flags, lists in the dry run of its own company only, posts after the reopen, and is idempotent', async () => {
    const lockA = await lockThroughToday(tenantA)
    await lockThroughToday(tenantB)

    // Company A: online order completed under the lock.
    const oA = await onlineOrder(conceptA)
    await completeOrder(oA.id, null, { via: 'status_update' })
    const flagsA = await waitFor(() => flagsOf(oA.id), (f) => f.length >= 2)
    const complete = flagsA.find((f) => (f.metadata as { sourceType?: string }).sourceType === 'order.complete')
    const earnFlag = flagsA.find((f) => (f.metadata as { sourceType?: string }).sourceType === 'loyalty.earn')
    expect(complete).toMatchObject({ tenantId: tenantA, severity: 'high', entityType: 'Order', entityId: oA.id, status: 'open' })
    expect(complete!.description).toMatch(/books are closed through/)
    expect(earnFlag).toMatchObject({ tenantId: tenantA, severity: 'high', entityType: 'Order', entityId: oA.id })
    expect(await entry(tenantA, `order.complete:${oA.id}`)).toBeNull()
    const earn = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId: oA.id, type: 'earn' } })
    expect(earn.pointsDelta).toBeGreaterThan(0)
    expect(await prisma.journalEntry.count({ where: { reference: `loyalty.earn:${earn.id}` } })).toBe(0)

    // A second refusal of the same posting does not stack a second flag.
    const { postCompletionOrFlag } = await import('../src/modules/orders/service.js')
    expect((await postCompletionOrFlag(oA.id)).posted).toBe(false)
    expect(await flagsOf(oA.id, 'order.complete')).toHaveLength(1)

    // Company B: its own order, its own flag in its own company.
    const oB = await onlineOrder(conceptB)
    await completeOrder(oB.id, null, { via: 'status_update' })
    const flagsB = await waitFor(() => flagsOf(oB.id, 'order.complete'), (f) => f.length >= 1)
    expect(flagsB[0]!.tenantId).toBe(tenantB)

    // Dry run while still locked: listed as locked, nothing written.
    const dry = await call('adminA', 'POST', '/reconciliation/backfill-unposted', {})
    expect(dry.statusCode).toBe(200)
    const dryRows = dry.json().orders.rows as Array<{ kind: string; id: string; orderId: string | null; tenantId: string; outcome: string; detail: string }>
    expect(dryRows.find((r) => r.kind === 'order.complete' && r.id === oA.id)).toMatchObject({ outcome: 'locked', tenantId: tenantA })
    expect(dryRows.find((r) => r.kind === 'loyalty.earn' && r.id === earn.id)).toMatchObject({ outcome: 'locked' })
    // Company separation: A's run never lists B's rows.
    expect(dryRows.every((r) => r.tenantId === tenantA)).toBe(true)
    expect(dryRows.some((r) => r.orderId === oB.id)).toBe(false)

    // Real run while locked posts nothing into the closed day.
    const lockedRun = await call('adminA', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })
    expect((lockedRun.json().orders.rows as Array<{ id: string; outcome: string }>).find((r) => r.id === oA.id)!.outcome).toBe('locked')
    expect(await entry(tenantA, `order.complete:${oA.id}`)).toBeNull()

    // Reopen A (the route deletes the latest lock), then a dry run says would_post.
    expect((await call('adminA', 'POST', '/accounting/period-close/reopen', { reason: 'post the late online sales' })).statusCode).toBe(200)
    expect(await prisma.periodLock.findUnique({ where: { id: lockA.id } })).toBeNull()
    const dry2 = (await call('adminA', 'POST', '/reconciliation/backfill-unposted', {})).json()
    expect(dry2.dryRun).toBe(true)
    expect((dry2.orders.rows as Array<{ id: string; outcome: string }>).find((r) => r.id === oA.id)!.outcome).toBe('would_post')
    expect(await entry(tenantA, `order.complete:${oA.id}`)).toBeNull()

    // Real run: the completion and the earn post in A's books, the flags resolve.
    const run = (await call('adminA', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })).json()
    const runRows = run.orders.rows as Array<{ kind: string; id: string; outcome: string }>
    expect(runRows.find((r) => r.kind === 'order.complete' && r.id === oA.id)!.outcome).toBe('posted')
    expect(runRows.find((r) => r.kind === 'loyalty.earn' && r.id === earn.id)!.outcome).toBe('posted')
    const je = (await entry(tenantA, `order.complete:${oA.id}`))!
    expect(sumOf(je, '2030', 'credit')).toBe(19_500)                                     // output tax of THIS sale
    expect(sumOf(je, '4004', 'credit')).toBe(130_000)                                    // Flipd revenue ex-GST
    expect(sumOf(je, '2030', 'credit') + sumOf(je, '4004', 'credit')).toBeLessThanOrEqual(149_500)
    const earnJe = (await entry(tenantA, `loyalty.earn:${earn.id}`))!
    expect(sumOf(earnJe, '2060', 'credit')).toBeGreaterThan(0)
    expect(sumOf(earnJe, '6060', 'debit')).toBe(sumOf(earnJe, '2060', 'credit'))
    expect((await flagsOf(oA.id)).every((f) => f.status === 'resolved')).toBe(true)

    // B is untouched by A's run: still unposted, still flagged open.
    expect(await entry(tenantB, `order.complete:${oB.id}`)).toBeNull()
    expect((await flagsOf(oB.id, 'order.complete'))[0]!.status).toBe('open')

    // Idempotent: a second run posts nothing for A.
    const again = (await call('adminA', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })).json()
    expect((again.orders.rows as Array<{ outcome: string }>).filter((r) => r.outcome === 'posted')).toHaveLength(0)
    expect(await prisma.journalEntry.count({ where: { reference: `order.complete:${oA.id}` } })).toBe(1)

    // B's own admin, after B's reopen, posts B's order into B's books.
    expect((await call('adminB', 'POST', '/accounting/period-close/reopen', { reason: 'post the late online sales' })).statusCode).toBe(200)
    const runB = (await call('adminB', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })).json()
    expect((runB.orders.rows as Array<{ id: string; tenantId: string; outcome: string }>).find((r) => r.id === oB.id)).toMatchObject({ outcome: 'posted', tenantId: tenantB })
    expect(await entry(tenantB, `order.complete:${oB.id}`)).not.toBeNull()
    expect(await prisma.journalEntry.count({ where: { reference: `order.complete:${oB.id}`, tenantId: tenantA } })).toBe(0)
  })

  it('a refused refund restore is flagged with the order id and re-posted by the backfill', async () => {
    // A cancelled order whose redeemed points were booked; the restore is
    // refused while the books are closed through today.
    const o = await onlineOrder(conceptA, 50_000, 6_522)
    await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled', completedAt: null } })
    const account = await prisma.loyaltyAccount.create({ data: { customerId: o.customerId!, tenantId: tenantA, pointsBalance: 0 } as never })
    const redeem = await prisma.loyaltyTransaction.create({ data: { loyaltyAccountId: account.id, orderId: o.id, type: 'redeem', pointsDelta: -200, description: 'redeemed' } })
    const { postLoyaltyRedeem } = await import('../src/modules/accounting/loyaltyPosting.js')
    expect((await postLoyaltyRedeem(redeem.id)).posted).toBe(true)

    const lock = await lockThroughToday(tenantA)
    const r = await postRefundOrFlag(o.id, 'Order cancelled', false)
    expect(r.failed.length).toBeGreaterThan(0)
    const flag = (await flagsOf(o.id, 'order.refund'))[0]!
    expect(flag).toMatchObject({ tenantId: tenantA, severity: 'high', entityId: o.id, status: 'open' })
    // Nothing moved: the claim rolled back with the refused entry.
    expect((await prisma.loyaltyTransaction.findUniqueOrThrow({ where: { id: redeem.id } })).reversedAt).toBeNull()
    expect((await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: account.id } })).pointsBalance).toBe(0)

    // Company B's admin cannot see or post it.
    const dryB = (await call('adminB', 'POST', '/reconciliation/backfill-unposted', {})).json()
    expect((dryB.orders.rows as Array<{ orderId: string | null }>).some((x) => x.orderId === o.id)).toBe(false)

    await prisma.periodLock.delete({ where: { id: lock.id } })
    const run = (await call('adminA', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })).json()
    expect((run.orders.rows as Array<{ kind: string; id: string; outcome: string }>).find((x) => x.kind === 'order.refund' && x.id === o.id)!.outcome).toBe('posted')
    expect((await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: account.id } })).pointsBalance).toBe(200)
    const rev = (await entry(tenantA, `loyalty.redeem.reversal:${redeem.id}`))!
    expect(sumOf(rev, '2060', 'credit')).toBeGreaterThan(0)
    expect(sumOf(rev, '7020', 'debit')).toBe(sumOf(rev, '2060', 'credit'))
    expect((await flagsOf(o.id, 'order.refund'))[0]!.status).toBe('resolved')
    // Re-run moves nothing twice.
    await call('adminA', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })
    expect((await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: account.id } })).pointsBalance).toBe(200)
  })
})

// ─── BOOKS-06 ───────────────────────────────────────────────────────────────

describe('BOOKS-06: a ledger line above INT4 posts (BIGINT); only above PKR 900bn is it a 422', () => {
  const accountId = async (tenantId: string, code: string) =>
    (await prisma.account.findFirstOrThrow({ where: { tenantId, code } })).id

  it('a PKR 25m opening-balance line posts (201) and its review flag carries the exact amount', async () => {
    const r = await call('adminA', 'POST', '/accounting/journal', {
      description: 'Opening balance — bank',
      lines: [
        { accountId: await accountId(tenantA, '1020'), type: 'debit',  amountCents: 2_500_000_000 },
        { accountId: await accountId(tenantA, '3010'), type: 'credit', amountCents: 2_500_000_000 },
      ],
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().lines.every((l: { amountCents: unknown }) => l.amountCents === 2_500_000_000)).toBe(true)
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'manual_journal', entityId: r.json().id } })
    expect(flag!.amountCents).toBe(2_500_000_000)
  })

  it('the same PKR 25m split into two lines per side posts, balanced, and its flag amount is not null', async () => {
    const bank = await accountId(tenantA, '1020')
    const equity = await accountId(tenantA, '3010')
    const r = await call('adminA', 'POST', '/accounting/journal', {
      description: 'Opening balance — bank (split)',
      lines: [
        { accountId: bank,   type: 'debit',  amountCents: 1_250_000_000 },
        { accountId: bank,   type: 'debit',  amountCents: 1_250_000_000 },
        { accountId: equity, type: 'credit', amountCents: 1_250_000_000 },
        { accountId: equity, type: 'credit', amountCents: 1_250_000_000 },
      ],
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().tenantId).toBe(tenantA)
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'manual_journal', entityId: r.json().id } })
    expect(flag).not.toBeNull()
    expect(flag!.amountCents).toBe(2_500_000_000)
    expect((flag!.metadata as { debits: number }).debits).toBe(2_500_000_000)
  })

  it('every posting path is guarded at the engine: one line over PKR 900bn throws AMOUNT_TOO_LARGE (422)', async () => {
    await expect(postJournalEntry({
      tenantId: tenantB, sourceType: 'test.big', sourceId: 'x1', description: 'too big',
      lines: [
        { accountCode: '1020', type: 'debit',  amountCents: MAX_MONEY_CENTS + 1 },
        { accountCode: '3010', type: 'credit', amountCents: MAX_MONEY_CENTS + 1 },
      ],
    })).rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE', statusCode: 422 })
    // Exactly the ceiling is fine.
    const ok = await postJournalEntry({
      tenantId: tenantB, sourceType: 'test.big', sourceId: 'x2', description: 'at the ceiling',
      lines: [
        { accountCode: '1020', type: 'debit',  amountCents: MAX_MONEY_CENTS },
        { accountCode: '3010', type: 'credit', amountCents: MAX_MONEY_CENTS },
      ],
    })
    expect(ok.posted).toBe(true)
  })
})

// ─── BOH-R2-02 ──────────────────────────────────────────────────────────────

describe('BOH-R2-02: a bill before full receipt prices only what was received; a void reverses exactly', () => {
  let supplierA: string
  let supplierB: string
  const item = (id: string) => prisma.inventoryItem.findUniqueOrThrow({ where: { id } })
  let seq = 0

  /** A stock item of company A, with `qty` already on hand at `cost` (an opening lot). */
  async function stockItem(name: string, qty: number, cost: number) {
    const id = (await prisma.inventoryItem.create({ data: { name, unit: 'kg', tenantId: tenantA, currentStock: 0, unitCostCents: cost } })).id
    await ensureFifoReady(tenantA)
    if (qty > 0) {
      await prisma.$transaction((tx) => addLotTx(tx, {
        tenantId: tenantA, inventoryItemId: id, qty, unitCostCents: cost, kind: 'opening', lotSourceType: 'opening', lotSourceId: `resim-open-${id}`,
        movementSourceType: 'test.opening', movementSourceId: id, receivedAt: new Date(Date.now() - DAY),
      }))
    }
    return id
  }
  const use = (inventoryItemId: string, qty: number) => prisma.$transaction((tx) => consumeFifoTx(tx, {
    tenantId: tenantA, inventoryItemId, qty, kind: 'waste', sourceType: 'test.use', sourceId: `resim-use-${++seq}`, clamp: false, occurredAt: new Date(),
  }))
  const lotValue = async (id: string) => (await prisma.stockLot.findMany({ where: { inventoryItemId: id } })).reduce((s, l) => s + Number(l.remainingValueCents), 0)

  async function sentPo(supplierId: string, _tenantId: string, inventoryItemId: string, qty: number, cost: number) {
    const po = await prisma.purchaseOrder.create({
      data: {
        supplierId, status: 'sent',
        totalCents: Math.round(qty * cost),
        lines: { create: [{ inventoryItemId, quantityOrdered: qty, unitCostCents: cost }] },
      },
      include: { lines: true },
    })
    return { poId: po.id, poLineId: po.lines[0]!.id }
  }
  async function receive(poId: string, poLineId: string, qty: number) {
    const r = await receiveGoods({ actor: { id: users.mgrA!.id, role: 'fnb_manager' }, poId, photoUrl: 'https://cdn.example/grn.jpg', lines: [{ poLineId, quantityReceived: qty }] })
    return r.receipt.id
  }
  async function bill(number: string, supplierId: string, poId: string, poLineId: string, inventoryItemId: string, qty: number, cost: number) {
    const b = await createBill({
      supplierId, poId, billNumber: number, billDate: new Date().toISOString(),
      lines: [{ inventoryItemId, poLineId, description: number, quantity: qty, unitCostCents: cost }],
      createdBy: users.adminA!.id,
    })
    return b.id as string
  }
  const refsOf = (billId: string, receiptIds: string[]) => [`supplier.bill:${billId}`, `supplier.bill.void:${billId}`, `supplier.bill.void.price:${billId}`, ...receiptIds.map((r) => `procurement.receipt:${r}`)]
  const netOver = async (code: string, refs: string[]) => {
    let t = 0
    for (const r of refs) t += await netDebit(tenantA, code, r)
    return t
  }

  beforeAll(async () => {
    supplierA = (await prisma.supplier.create({ data: { name: 'Karachi Poultry', tenantId: tenantA, paymentTermsDays: 10 } })).id
    supplierB = (await prisma.supplier.create({ data: { name: 'B Poultry', tenantId: tenantB, paymentTermsDays: 10 } })).id
  })

  it('partial receipt + full bill: the 40 kg received re-price their lot, the 20 kg are billed ahead; the late receipt nets 2015; void re-opens GRNI', async () => {
    const chicken = await stockItem('Chicken', 8, 95_000)
    const chickenB = (await prisma.inventoryItem.create({ data: { name: 'Chicken', unit: 'kg', tenantId: tenantB, currentStock: 8, unitCostCents: 95_000 } })).id
    const { poId, poLineId } = await sentPo(supplierA, tenantA, chicken, 60, 95_000)
    const r1 = await receive(poId, poLineId, 40)
    expect(await item(chicken)).toMatchObject({ currentStock: 48, unitCostCents: 95_000 })

    const billId = await bill('KP-60', supplierA, poId, poLineId, chicken, 60, 100_000)
    const ref = `supplier.bill:${billId}`
    // 40 kg × PKR 50 re-prices the received lot (all still on hand); 20 kg are billed ahead.
    expect(await netDebit(tenantA, '1210', ref)).toBe(200_000)
    expect(await netDebit(tenantA, '5060', ref)).toBe(0)
    expect(await netDebit(tenantA, '2015', ref)).toBe(40 * 95_000 + 20 * 100_000)
    expect(await netDebit(tenantA, '2010', ref)).toBe(-6_000_000)
    const matches = await prisma.grniMatch.findMany({ where: { billId }, orderBy: { status: 'asc' } })
    expect(matches.map((m) => [m.status, m.qty, m.tenantId])).toEqual([['live', 40, tenantA], ['pending', 20, tenantA]])
    // The FIFO head is still the 8 kg on hand before.
    expect((await item(chicken)).unitCostCents).toBe(95_000)

    // The other 20 kg arrive: their lot opens at the billed price and 2015 nets out.
    const r2 = await receive(poId, poLineId, 20)
    expect((await item(chicken)).currentStock).toBe(68)
    expect(await lotValue(chicken)).toBe(8 * 95_000 + 60 * 100_000)
    expect(await netOver('2015', [ref, `procurement.receipt:${r1}`, `procurement.receipt:${r2}`])).toBe(0)

    // Void: the 40 kg lot goes back to the PO price; the 20 kg that arrived at
    // the billed price wait for a bill at that value; nothing to 5060.
    await voidBill(billId, users.adminA!.id, 'wrong bill')
    expect(await lotValue(chicken)).toBe(8 * 95_000 + 40 * 95_000 + 20 * 100_000)
    expect(await netOver('5060', refsOf(billId, []))).toBe(0)
    expect(await netOver('1210', refsOf(billId, []))).toBe(0)
    expect(await netOver('2015', refsOf(billId, [r1, r2]))).toBe(-(40 * 95_000 + 20 * 100_000))
    expect(await prisma.grniMatch.count({ where: { billId, status: { not: 'void' } } })).toBe(0)

    // Company B's same-named item is never touched.
    expect(await item(chickenB)).toMatchObject({ currentStock: 8, unitCostCents: 95_000 })
    expect(await prisma.itemPriceHistory.count({ where: { inventoryItemId: chickenB } })).toBe(0)
  })

  it('bill on a PO never received: no 5060, stock already on hand is not re-priced, all of it billed ahead', async () => {
    const beef = await stockItem('Beef', 8.4, 180_000)
    const { poId, poLineId } = await sentPo(supplierA, tenantA, beef, 20, 180_000)
    const billId = await bill('KP-BEEF', supplierA, poId, poLineId, beef, 20, 185_000)
    expect((await item(beef)).unitCostCents).toBe(180_000)
    expect(await netDebit(tenantA, '5060', `supplier.bill:${billId}`)).toBe(0)
    expect(await netDebit(tenantA, '1210', `supplier.bill:${billId}`)).toBe(0)
    expect(await netDebit(tenantA, '2015', `supplier.bill:${billId}`)).toBe(3_700_000)
    expect(await prisma.itemPriceHistory.count({ where: { inventoryItemId: beef, source: 'bill_match' } })).toBe(0)

    // Received later: the lot opens at the billed price.
    const r = await receive(poId, poLineId, 20)
    expect(await lotValue(beef)).toBe(Math.round(8.4 * 180_000) + 20 * 185_000)

    // Void after the receipt: the received goods wait for a bill at what the receipt booked.
    await voidBill(billId, users.adminA!.id, 'duplicate')
    expect(await netOver('2015', refsOf(billId, [r]))).toBe(-3_700_000)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `supplier.bill.void.price:${billId}` } })).toBe(0)
  })

  it('two bills on one PO line never bill the same received kilos twice (over-billing is refused)', async () => {
    const rice = await stockItem('Rice', 0, 30_000)
    const { poId, poLineId } = await sentPo(supplierA, tenantA, rice, 40, 30_000)
    await receive(poId, poLineId, 40)
    await bill('KP-RICE-1', supplierA, poId, poLineId, rice, 20, 31_000)
    await expect(bill('KP-RICE-2', supplierA, poId, poLineId, rice, 40, 31_000)).rejects.toMatchObject({ code: 'OVER_BILLED', statusCode: 422 })
    expect(await prisma.supplierBill.count({ where: { billNumber: 'KP-RICE-2' } })).toBe(0)
    const b2 = await bill('KP-RICE-2B', supplierA, poId, poLineId, rice, 20, 31_000)
    expect(await netDebit(tenantA, '5060', `supplier.bill:${b2}`)).toBe(0)
    expect((await prisma.goodsReceiptLine.findFirstOrThrow({ where: { poLineId } })).billedQty).toBe(40)
    expect(await lotValue(rice)).toBe(40 * 31_000)
  })

  it('RB-3: receiving settles a bill booked first by itself (no manual call)', async () => {
    const lamb = await stockItem('Lamb', 0, 200_000)
    const { poId, poLineId } = await sentPo(supplierA, tenantA, lamb, 10, 200_000)
    await bill('KP-LAMB', supplierA, poId, poLineId, lamb, 10, 210_000)
    await receiveGoods({ actor: { id: users.mgrA!.id, role: 'fnb_manager' }, poId, photoUrl: 'https://cdn.example/grn.jpg', lines: [{ poLineId, quantityReceived: 10 }] })
    expect((await item(lamb)).unitCostCents).toBe(210_000)
  })

  it('RB-2: a void after the billed stock was used and restocked leaves the new stock at its PO price; 5060 gives the used difference back', async () => {
    const chicken = await stockItem('Chicken RB2', 0, 95_000)
    const { poId, poLineId } = await sentPo(supplierA, tenantA, chicken, 20, 95_000)
    await receive(poId, poLineId, 10)
    const billId = await bill('KP-RB2', supplierA, poId, poLineId, chicken, 10, 100_000)
    expect((await item(chicken)).unitCostCents).toBe(100_000)
    // The kitchen uses all 10 kg (costed out at PKR 1,000/kg) ...
    await use(chicken, 10)
    // ... and the next 10 kg arrive at the PO price.
    await receive(poId, poLineId, 10)
    expect(await item(chicken)).toMatchObject({ currentStock: 10, unitCostCents: 95_000 })

    await voidBill(billId, users.adminA!.id, 'wrong bill')
    expect(await item(chicken)).toMatchObject({ currentStock: 10, unitCostCents: 95_000 })
    // The 50,000 of difference that was consumed comes back: Dr 1210 / Cr 5060.
    expect(await netDebit(tenantA, '5060', `supplier.bill.void.price:${billId}`)).toBe(-50_000)
    expect(await netDebit(tenantA, '1210', `supplier.bill.void.price:${billId}`)).toBe(50_000)
  })

  it('RB-2: a void with part of the billed stock still on hand and a later delivery takes back only the part still there', async () => {
    const flour = await stockItem('Flour RB2', 0, 10_000)
    const { poId, poLineId } = await sentPo(supplierA, tenantA, flour, 30, 10_000)
    await receive(poId, poLineId, 10)
    const billId = await bill('KP-FLOUR', supplierA, poId, poLineId, flour, 10, 12_000)   // +20,000 over 10 kg
    expect((await item(flour)).unitCostCents).toBe(12_000)
    // 6 kg used, 4 kg of the billed stock left; then 10 kg more at the PO price.
    await use(flour, 6)
    await receive(poId, poLineId, 10)
    // FIFO head: the 4 kg of the billed lot are cooked first.
    expect((await item(flour)).unitCostCents).toBe(12_000)
    await voidBill(billId, users.adminA!.id, 'wrong price')
    // The 4 kg's share (8,000) comes off the lot: every kg is back at 10,000.
    expect((await item(flour)).unitCostCents).toBe(10_000)
    expect(await lotValue(flour)).toBe(14 * 10_000)
    // The 6 kg used (12,000) comes back through 5060.
    expect(await netDebit(tenantA, '5060', `supplier.bill.void.price:${billId}`)).toBe(-12_000)
  })

  it('RB-4: two lines of one bill on the same PO line never match the same received kilos', async () => {
    const beef = await stockItem('Beef RB4', 0, 180_000)
    const { poId, poLineId } = await sentPo(supplierA, tenantA, beef, 20, 180_000)
    await receive(poId, poLineId, 10)
    const b = await createBill({
      supplierId: supplierA, poId, billNumber: 'KP-RB4', billDate: new Date().toISOString(),
      lines: [
        { inventoryItemId: beef, poLineId, description: 'beef part 1', quantity: 10, unitCostCents: 190_000 },
        { inventoryItemId: beef, poLineId, description: 'beef part 2', quantity: 10, unitCostCents: 190_000 },
      ],
      createdBy: users.adminA!.id,
    })
    const ms = await prisma.grniMatch.findMany({ where: { billId: b.id as string }, include: { billLine: { select: { description: true } } } })
    expect(ms.map((m) => [m.billLine.description, m.status, m.qty]).sort()).toEqual([['beef part 1', 'live', 10], ['beef part 2', 'pending', 10]])
    expect((await item(beef)).unitCostCents).toBe(190_000)
    // The other 10 kg arrive at the billed price.
    await receive(poId, poLineId, 10)
    expect((await item(beef)).unitCostCents).toBe(190_000)
    // Void: the first lot back at the PO price, nothing left in 5060.
    await voidBill(b.id as string, users.adminA!.id, 'duplicate')
    expect((await item(beef)).unitCostCents).toBe(180_000)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `supplier.bill.void.price:${b.id}` } })).toBe(0)
  })

  it('RB-5: a void racing a receipt that settles its billed-ahead quantity waits for it and re-opens that receipt too', async () => {
    const veal = await stockItem('Veal RB5', 0, 150_000)
    const { poId, poLineId } = await sentPo(supplierA, tenantA, veal, 10, 150_000)
    const billId = await bill('KP-RB5', supplierA, poId, poLineId, veal, 10, 160_000)    // all billed ahead
    let lockTaken!: () => void
    const taken = new Promise<void>((r) => { lockTaken = r })
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let receiptId = ''
    // A receipt in flight: PO locked, lots in, the pending match settled — not yet committed.
    const receipt = prisma.$transaction(async (tx) => {
      const r = await receiveGoodsTx(tx, {
        tenantId: tenantA, poId, receivedById: users.mgrA!.id,
        lines: [{ inventoryItemId: veal, receivedQty: 10, unit: 'kg', poLineId }],
      })
      receiptId = r.receiptId
      lockTaken()
      await held
    }, { timeout: 20_000 })
    await taken
    let voided = false
    const v = voidBill(billId, users.adminA!.id, 'wrong bill').then(() => { voided = true })
    await new Promise((r) => setTimeout(r, 400))
    expect(voided).toBe(false)          // the void waits on the PO lock
    release()
    await receipt
    await v
    // The void saw the receipt: its line is unbilled again, GRNI open at the lot value.
    expect(await item(veal)).toMatchObject({ currentStock: 10, unitCostCents: 160_000 })
    expect((await prisma.goodsReceiptLine.findFirstOrThrow({ where: { receiptId } })).billedQty).toBe(0)
    expect(await netOver('2015', refsOf(billId, [receiptId]))).toBe(-1_600_000)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `supplier.bill.void.price:${billId}` } })).toBe(0)
  })

  it("company B's bill against company A's PO line is refused, and A's stock is not re-priced", async () => {
    const oil = await stockItem('Oil', 10, 50_000)
    const { poId, poLineId } = await sentPo(supplierA, tenantA, oil, 10, 50_000)
    await expect(bill('B-OIL', supplierB, poId, poLineId, oil, 10, 60_000)).rejects.toBeTruthy()
    expect((await item(oil)).unitCostCents).toBe(50_000)
  })
})

// ─── RB-1: concurrent posting / backfill never double-books ────────────────

describe('RB-1: a reference posts once however many callers race', () => {
  it('ten concurrent postJournalEntry calls with one reference write one entry', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => postJournalEntry({
      tenantId: tenantA, sourceType: 'test.race', sourceId: 'r1', description: 'race',
      lines: [
        { accountCode: '1020', type: 'debit',  amountCents: 1_000 },
        { accountCode: '3010', type: 'credit', amountCents: 1_000 },
      ],
    })))
    expect(results.filter((r) => r.posted)).toHaveLength(1)
    expect(new Set(results.map((r) => r.entryId)).size).toBe(1)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: 'test.race:r1' } })).toBe(1)
    // The same reference in company B is its own entry (the lock is per company).
    await postJournalEntry({
      tenantId: tenantB, sourceType: 'test.race', sourceId: 'r1', description: 'race B',
      lines: [
        { accountCode: '1020', type: 'debit',  amountCents: 1_000 },
        { accountCode: '3010', type: 'credit', amountCents: 1_000 },
      ],
    })
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB, reference: 'test.race:r1' } })).toBe(1)
  })

  it('two backfill runs at once post every completion and earn once; the route answers 409 BACKFILL_RUNNING to the second', async () => {
    const lock = await lockThroughToday(tenantA)
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const o = await onlineOrder(conceptA)
      await completeOrder(o.id, null, { via: 'status_update' })
      ids.push(o.id)
    }
    await waitFor(() => prisma.exceptionFlag.count({ where: { kind: 'posting_failed', entityId: { in: ids }, metadata: { path: ['sourceType'], equals: 'order.complete' } } }), (n) => n >= ids.length)
    await prisma.periodLock.delete({ where: { id: lock.id } })

    // The engine: two real runs side by side (no route guard) still book once.
    const [a, b] = await Promise.all([
      backfillUnpostedOrders({ tenantIds: [tenantA], dryRun: false }),
      backfillUnpostedOrders({ tenantIds: [tenantA], dryRun: false }),
    ])
    const postedBoth = [...a.rows, ...b.rows].filter((r) => r.kind === 'order.complete' && ids.includes(r.id) && r.outcome === 'posted')
    expect(postedBoth).toHaveLength(ids.length)
    for (const id of ids) {
      expect(await prisma.journalEntry.count({ where: { reference: `order.complete:${id}` } })).toBe(1)
      const earns = await prisma.loyaltyTransaction.findMany({ where: { orderId: id, type: 'earn' }, select: { id: true } })
      for (const e of earns) expect(await prisma.journalEntry.count({ where: { reference: `loyalty.earn:${e.id}` } })).toBe(1)
    }

    // The route: a second real run for the same company while one is running is a 409.
    const [r1, r2] = await Promise.all([
      call('adminA', 'POST', '/reconciliation/backfill-unposted', { dryRun: false }),
      call('adminA', 'POST', '/reconciliation/backfill-unposted', { dryRun: false }),
    ])
    const codes = [r1.statusCode, r2.statusCode].sort()
    expect(codes[0]).toBe(200)
    expect([200, 409]).toContain(codes[1])
    for (const r of [r1, r2]) if (r.statusCode === 409) expect(r.json().error.code).toBe('BACKFILL_RUNNING')
    // Company B's run is never blocked by A's.
    const [ra, rb] = await Promise.all([
      call('adminA', 'POST', '/reconciliation/backfill-unposted', { dryRun: false }),
      call('adminB', 'POST', '/reconciliation/backfill-unposted', { dryRun: false }),
    ])
    expect(ra.statusCode).toBe(200)
    expect(rb.statusCode).toBe(200)
  })
})

// ─── RB-6: a loyalty flag whose earn was reversed before it was booked ──────

describe('RB-6: the backfill closes a loyalty posting_failed flag once the earn is reversed unbooked', () => {
  it('earn refused under a lock, order cancelled, flag resolved by the backfill (own company only)', async () => {
    const lock = await lockThroughToday(tenantA)
    const o = await onlineOrder(conceptA)
    await completeOrder(o.id, null, { via: 'status_update' })
    const earnFlag = (await waitFor(() => flagsOf(o.id, 'loyalty.earn'), (f) => f.length >= 1))[0]!
    expect(earnFlag.status).toBe('open')
    const earn = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId: o.id, type: 'earn' } })

    // Cancelled before the books reopen: the earn is clawed back unbooked.
    await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled' } })
    await postRefundOrFlag(o.id, 'Order cancelled', false)
    expect((await prisma.loyaltyTransaction.findUniqueOrThrow({ where: { id: earn.id } })).reversedAt).not.toBeNull()
    expect(await prisma.journalEntry.count({ where: { reference: `loyalty.earn:${earn.id}` } })).toBe(0)
    await prisma.periodLock.delete({ where: { id: lock.id } })

    // Company B's run never touches A's flag.
    await call('adminB', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: earnFlag.id } })).status).toBe('open')

    // Dry run lists it; the real run resolves it and posts nothing for it.
    const dry = (await call('adminA', 'POST', '/reconciliation/backfill-unposted', {})).json()
    expect((dry.orders.rows as Array<{ kind: string; id: string; outcome: string }>).find((r) => r.kind === 'loyalty.earn' && r.id === earn.id)!.outcome).toBe('would_resolve')
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: earnFlag.id } })).status).toBe('open')
    const run = (await call('adminA', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })).json()
    expect((run.orders.rows as Array<{ kind: string; id: string; outcome: string }>).find((r) => r.kind === 'loyalty.earn' && r.id === earn.id)!.outcome).toBe('resolved')
    const after = await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: earnFlag.id } })
    expect(after.status).toBe('resolved')
    expect(after.resolution).toMatch(/Reversed before it was booked/)
    expect(await prisma.journalEntry.count({ where: { reference: `loyalty.earn:${earn.id}` } })).toBe(0)
  })
})
