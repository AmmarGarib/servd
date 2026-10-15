// Money follow-ups from the till and ledger review rounds (2026-10-11).
//
//   TILL-R2   the gift-card redeem takes the order's row lock FIRST
//       (giftCards/service redeemGiftCardTx) and reads the bill under it. A
//       card applied while a full cash tender is committing used to read the
//       bill unlocked: the card was drained AND the bill paid in full.
//   LEDGER-R5 money taken at the till on a ticket that was then cancelled is
//       handed back through the ONE refund engine (refundOrder): capped at
//       refundDueCents, re-checked under the lock, same PIN caps and drawer;
//       the order stays cancelled; no sale restores, no fiscal return (it was
//       never a sale — §17.1) unless the sale was filed directly with SRB
//       before the POS connector (then manual_required); the ledger nets 1110
//       to zero (close Cr 1110, hand-back Dr 1110).
//   R5-A/B/C whatever was posted BEFORE the cancel — a drawer close that took
//       a non-till ticket's cash as non-till cash (Dr 1015 / Cr 1010), a void
//       refund booked as a sale refund while the ticket was open, a home
//       drawer that booked the till sale — is undone once per order
//       ('order.cancel_unwind'), and each hand-back debits where its money is
//       parked (1010 / 1030 / 1110): revenue, tax, 1110 and 1010 net to zero.
//   LEDGER-R6 the sales register counts gift cards the way the ledger does:
//       gross on the pre-card value, refunds and card restores valued against
//       the full order — so its GST and net agree with the P&L. R6-A: a sale
//       booked BEFORE ONL-05 (no 2080 debit naming the order) is valued without
//       its card, exactly as the ledger's refunds value it.
//
// Two companies throughout: company B never sees or touches company A's rows.
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

// (The direct SRB filer is gone — the POS connector's fiscal outbox is the
// only filer, and these assertions read its FiscalDocument rows. Its BullMQ
// kick is a no-op here: nothing is configured, so nothing is sent.)
vi.mock('../src/lib/notify.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendPhoneMessage: async () => {},
  sendEmail: async () => {},
}))

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { setManagerPin } = await import('../src/modules/auth/managerPin.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const giftCards = await import('../src/modules/giftCards/service.js')
const { redeemGiftCard, redeemGiftCardTx } = giftCards
const { applyGiftCardTender, processPayment, refundOrder, postCancelledTicketUnwind } = await import('../src/modules/pos/service.js')
const { refundDueCents, postOrderCompletion, postOrderRefund, postRefundPayment } = await import('../src/modules/accounting/orderPosting.js')
const { postShiftClose } = await import('../src/modules/accounting/shiftPosting.js')
const { salesTotals } = await import('../src/modules/reports/service.js')
const { posRoutes } = await import('../src/modules/pos/routes.js')

const RUN = Math.random().toString(36).slice(2, 8)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptReg: string, conceptB: string
const users: Record<string, { id: string; token: string }> = {}
const PIN = '4826'

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@moneyfu.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

async function openDrawer(userKey: string, tenantId = tenantA) {
  const userId = users[userKey]!.id
  await prisma.shift.updateMany({ where: { userId, status: 'open' }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
  return prisma.shift.create({ data: { userId, openingFloatCents: 0, status: 'open', tenantId } })
}
async function closeAndPost(shiftId: string, countedCents: number) {
  await prisma.shift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: countedCents } })
  const r = await postShiftClose(shiftId)
  expect(r.posted).toBe(true)
}

type Line = { code: string; type: string; amount: number }
async function linesOf(tenantId: string, references: string[]): Promise<Line[]> {
  const rows = await prisma.journalLine.findMany({
    where: { journalEntry: { tenantId, reference: { in: references } } },
    select: { type: true, amountCents: true, account: { select: { code: true, tenantId: true } } },
  })
  for (const r of rows) expect(r.account.tenantId).toBe(tenantId)
  return rows.map((r) => ({ code: r.account.code, type: r.type, amount: r.amountCents }))
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
/** Credit-normal net over the lines whose code matches. */
const netCredit = (lines: Line[], match: (code: string) => boolean) =>
  lines.filter((l) => match(l.code)).reduce((t, l) => t + (l.type === 'credit' ? l.amount : -l.amount), 0)

let cardSeq = 0
async function card(tenantId: string, balanceCents: number) {
  return prisma.giftCard.create({ data: { tenantId, code: `MF-${RUN}-${++cardSeq}`.toUpperCase(), issuedAmountCents: balanceCents, balanceCents } })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Money A', slug: `mf-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Money B', slug: `mf-b-${RUN}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  conceptA = (await prisma.concept.create({ data: { name: 'Money Cafe', slug: `mf-cafe-${RUN}`, type: 'restaurant', tenantId: tenantA, taxRateCash: 15, taxRateCard: 8 } })).id
  conceptReg = (await prisma.concept.create({ data: { name: 'Register Cafe', slug: `mf-reg-${RUN}`, type: 'restaurant', tenantId: tenantA, taxRateCash: 15, taxRateCard: 8 } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Other Co', slug: `mf-b-${RUN}`, type: 'restaurant', tenantId: tenantB, taxRateCash: 15, taxRateCard: 8 } })).id
  await mkUser('admin', 'admin', tenantA)
  await mkUser('adminB', 'admin', tenantB)
  await mkUser('cashier', 'cashier', tenantA)
  await mkUser('cashier2', 'cashier', tenantA)
  const mgr = await mkUser('mgr', 'foh_management', tenantA)
  await setManagerPin(mgr.id, PIN)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(posRoutes, { prefix: '/pos' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  // Every entry this suite wrote, in either company, balances.
  const entries = await prisma.journalEntry.findMany({
    where: { tenantId: { in: [tenantA, tenantB] } },
    include: { lines: true },
  })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
    expect(d, `entry ${e.reference} balances`).toBe(c)
  }
  await app?.close()
})

// ─── TILL-R2 ──────────────────────────────────────────────────────────────────

describe('TILL-R2 — the redeem locks the order before it reads the bill', () => {
  let drawer: string
  beforeAll(async () => { drawer = (await openDrawer('cashier')).id })

  /** An open till bill, not priced through lib/pricing (no re-price at tender). */
  const tillBill = (totalCents: number) => prisma.order.create({
    data: { conceptId: conceptA, source: 'pos', fulfilmentType: 'dine_in', status: 'received', totalCents, taxCents: 0, shiftId: drawer, posStaffId: users['cashier']!.id },
  })
  const paidCash = (orderId: string) => prisma.payment.aggregate({ where: { orderId, method: 'cash', status: 'paid' }, _sum: { amountCents: true } }).then((a) => a._sum.amountCents ?? 0)
  const cardApplied = (orderId: string) => prisma.giftCardRedemption.aggregate({ where: { orderId }, _sum: { amountCents: true } }).then((a) => a._sum.amountCents ?? 0)

  it('exports the tx-bound redeem, so the till (and auditTillGiftCard) run the real engine, not a stand-in', () => {
    expect(typeof redeemGiftCardTx).toBe('function')
    expect(typeof redeemGiftCard).toBe('function')
  })

  it('cash commits first: the storefront / admin redeem (its own transaction) waits on the lock and leaves the card alone', async () => {
    const o = await tillBill(63_250)
    const gc = await card(tenantA, 50_000)
    // A full cash tender holding the order lock while it pays the bill.
    const cash = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${o.id} FOR UPDATE`
      await sleep(300)
      await tx.payment.create({ data: { orderId: o.id, shiftId: drawer, method: 'cash', amountCents: 63_250, status: 'paid', processedAt: new Date() } })
      await tx.order.update({ where: { id: o.id }, data: { status: 'completed', completedAt: new Date() } })
    }, { timeout: 10_000 })
    await sleep(60)
    // Before TILL-R2 this read 'received / nothing paid' unlocked and drained the card.
    const redeem = redeemGiftCard({ code: gc.code, orderId: o.id }).then(
      (r) => ({ ok: true as const, r }), (e: { code?: string }) => ({ ok: false as const, code: e.code }))
    await cash
    expect(await redeem).toEqual({ ok: false, code: 'ORDER_NOT_OPEN' })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: gc.id } })).balanceCents).toBe(50_000)
    expect(await cardApplied(o.id)).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).totalCents).toBe(63_250)
  })

  it('cash commits first while still owing nothing: a bill paid in full but still open gives NOTHING_DUE, card untouched', async () => {
    const o = await tillBill(40_000)
    const gc = await card(tenantA, 50_000)
    const cash = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${o.id} FOR UPDATE`
      await sleep(300)
      await tx.payment.create({ data: { orderId: o.id, shiftId: drawer, method: 'cash', amountCents: 40_000, status: 'paid', processedAt: new Date() } })
    }, { timeout: 10_000 })
    await sleep(60)
    const redeem = redeemGiftCard({ code: gc.code, orderId: o.id }).then(
      (r) => ({ ok: true as const, r }), (e: { code?: string }) => ({ ok: false as const, code: e.code }))
    await cash
    expect(await redeem).toEqual({ ok: false, code: 'NOTHING_DUE' })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: gc.id } })).balanceCents).toBe(50_000)
  })

  it('the card commits first: the real cash tender waits, sees the lowered bill, and is refused the full amount', async () => {
    const o = await tillBill(63_250)
    const gc = await card(tenantA, 20_000)
    const redeem = prisma.$transaction(async (tx) => {
      const r = await redeemGiftCardTx(tx, { code: gc.code, orderId: o.id })
      await sleep(300)   // hold the lock the redeem took
      return r
    }, { timeout: 10_000 })
    await sleep(60)
    const full = processPayment({ orderId: o.id, shiftId: drawer, payments: [{ method: 'cash', amountCents: 63_250 }] }).then(
      () => ({ ok: true as const }), (e: { code?: string }) => ({ ok: false as const, code: e.code }))
    expect((await redeem).appliedCents).toBe(20_000)
    expect(await full).toEqual({ ok: false, code: 'AMOUNT_MISMATCH' })
    expect(await paidCash(o.id)).toBe(0)

    // The rest is taken, and the sale completes: card + cash = the bill, once.
    const rest = await processPayment({ orderId: o.id, shiftId: drawer, payments: [{ method: 'cash', amountCents: 43_250 }] })
    expect(rest.orderCompleted).toBe(true)
    expect(await paidCash(o.id) + await cardApplied(o.id)).toBe(63_250)
  })

  it('fired together, over and over: the card is never drained on a bill the cash also paid in full', async () => {
    for (let i = 0; i < 8; i++) {
      const o = await tillBill(30_000 + i)
      const gc = await card(tenantA, 25_000)
      // Alternate the head start, and alternate the till tender with the
      // storefront's own-transaction redeem.
      const tender = i % 2 === 0
        ? () => applyGiftCardTender({ orderId: o.id, code: gc.code, staffId: users['cashier']!.id })
        : () => redeemGiftCard({ code: gc.code, orderId: o.id })
      const pay = () => processPayment({ orderId: o.id, shiftId: drawer, payments: [{ method: 'cash', amountCents: 30_000 + i }] })
      const [a, b] = await Promise.allSettled(i % 4 < 2 ? [tender(), pay()] : [sleep(5).then(tender), pay()])
      const cardOk = a.status === 'fulfilled'
      const cashOk = b.status === 'fulfilled'
      expect(cardOk && cashOk, `iteration ${i}: both the card and the full cash went through`).toBe(false)
      expect(cardOk || cashOk, `iteration ${i}: one of them must go through`).toBe(true)
      const applied = await cardApplied(o.id)
      const balance = (await prisma.giftCard.findUniqueOrThrow({ where: { id: gc.id } })).balanceCents
      expect(balance + applied).toBe(25_000)
      expect(await paidCash(o.id) + applied).toBeLessThanOrEqual(30_000 + i)
      if (cashOk) expect(applied).toBe(0)
      if (cardOk) expect(await paidCash(o.id)).toBe(0)
    }
  })

  it("company B's card is unknown on company A's bill (both entry points), and nothing moves", async () => {
    const o = await tillBill(10_000)
    const gcB = await card(tenantB, 10_000)
    await expect(redeemGiftCard({ code: gcB.code, orderId: o.id })).rejects.toMatchObject({ statusCode: 404 })
    await expect(applyGiftCardTender({ orderId: o.id, code: gcB.code, staffId: users['cashier']!.id })).rejects.toMatchObject({ statusCode: 404 })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: gcB.id } })).balanceCents).toBe(10_000)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).totalCents).toBe(10_000)
  })
})

// ─── LEDGER-R5 ────────────────────────────────────────────────────────────────

describe('LEDGER-R5 — handing back money taken on a cancelled ticket', () => {
  /** A ticket that took `cashCents` in cash on `shiftId`, then was cancelled. */
  async function cancelledTicket(shiftId: string, cashCents: number, opts: { srbInvoiceNumber?: string; card?: { cents: number; ref: string } } = {}) {
    const o = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'pos', fulfilmentType: 'dine_in', status: 'received', totalCents: 100_050, taxCents: 13_050, taxRatePct: 15,
        ...(opts.srbInvoiceNumber && { srbInvoiceNumber: opts.srbInvoiceNumber }),
        items: { create: [{ name: 'Split table', quantity: 1, unitPriceCents: 87_000 }] },
      },
    })
    if (cashCents > 0) await prisma.payment.create({ data: { orderId: o.id, shiftId, method: 'cash', amountCents: cashCents, status: 'paid', processedAt: new Date() } })
    if (opts.card) await prisma.payment.create({ data: { orderId: o.id, shiftId, method: 'card', amountCents: opts.card.cents, status: 'paid', gatewayRef: opts.card.ref, processedAt: new Date() } })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled' } })
    return o
  }
  const due = async (orderId: string) => refundDueCents(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true } }))

  it('refunds up to what is owed, keeps the order cancelled, books Dr 1110 / Cr drawer, and the close nets 1110 to zero', async () => {
    const s1 = await openDrawer('admin')
    const o = await cancelledTicket(s1.id, 50_025)
    expect(await due(o.id)).toBe(50_025)

    // More than is owed: refused before any PIN, nothing written.
    await expect(refundOrder({ orderId: o.id, amountCents: 50_026, reason: 'Table walked out', actorId: users['admin']!.id, actorRole: 'admin' }))
      .rejects.toMatchObject({ code: 'REFUND_EXCEEDS_DUE', statusCode: 422 })
    // Not the way it came: the cash was cash.
    await expect(refundOrder({ orderId: o.id, amountCents: 1_000, reason: 'Table walked out', actorId: users['admin']!.id, actorRole: 'admin', method: 'card' }))
      .rejects.toMatchObject({ code: 'REFUND_METHOD_NOT_TENDERED' })
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'refunded' } })).toBe(0)

    // Part of it back from the drawer it was taken on (the refunder's own open drawer).
    const first = await refundOrder({ orderId: o.id, amountCents: 20_000, reason: 'Table walked out', actorId: users['admin']!.id, actorRole: 'admin' })
    expect(first).toMatchObject({ orderRefunded: false, refundDueLeftCents: 30_025, shiftId: s1.id, method: 'cash', amountCents: -20_000 })
    const after1 = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after1.status).toBe('cancelled')
    const e1 = await linesOf(tenantA, [`order.refund:${first.id}`])
    expect(e1).toHaveLength(2)
    expect(amt(e1, '1110', 'debit')).toBe(20_000)
    expect(amt(e1, '1015', 'credit')).toBe(20_000)

    // The audit trail names it for what it is.
    const a1 = await prisma.auditLog.findFirst({ where: { entityId: o.id, action: 'order_refund_due' } })
    expect(a1).toBeTruthy()
    expect(await prisma.auditLog.count({ where: { entityId: o.id, action: 'order_refund' } })).toBe(0)

    // The drawer closes: it holds the full receipt as a refund due.
    await closeAndPost(s1.id, 50_025 - 20_000)
    const close = await linesOf(tenantA, [`shift.close:${s1.id}`])
    expect(amt(close, '1110', 'credit')).toBe(50_025)

    // The rest from the next drawer, after the close.
    const s2 = await openDrawer('admin')
    const second = await refundOrder({ orderId: o.id, amountCents: 30_025, reason: 'Table walked out', actorId: users['admin']!.id, actorRole: 'admin' })
    expect(second).toMatchObject({ orderRefunded: false, refundDueLeftCents: 0, shiftId: s2.id })
    const e2 = await linesOf(tenantA, [`order.refund:${second.id}`])
    expect(amt(e2, '1110', 'debit')).toBe(30_025)
    expect(amt(e2, '1015', 'credit')).toBe(30_025)

    // End to end: 1110 nets to zero, nothing ever touched revenue or tax.
    const all = await linesOf(tenantA, [`shift.close:${s1.id}`, `order.refund:${first.id}`, `order.refund:${second.id}`])
    expect(netCredit(all, (c) => c === '1110')).toBe(0)
    expect(all.filter((l) => /^(4|2030|2032|7)/.test(l.code))).toEqual([])
    expect(await due(o.id)).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')

    // Nothing left: refused. No sale restores, no SRB return for a ticket never filed.
    await expect(refundOrder({ orderId: o.id, amountCents: 1, reason: 'Again', actorId: users['admin']!.id, actorRole: 'admin' }))
      .rejects.toMatchObject({ code: 'NOTHING_TO_REFUND', statusCode: 422 })
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: { in: [`order.refund_wallet:${o.id}`] } } })).toBe(0)
    expect(await prisma.fiscalDocument.count({ where: { orderId: o.id } })).toBe(0)
    await closeAndPost(s2.id, 0)
  })

  it('a cancelled ticket that took nothing has NOTHING_TO_REFUND (422)', async () => {
    const s = await openDrawer('admin')
    const o = await cancelledTicket(s.id, 0)
    await expect(refundOrder({ orderId: o.id, amountCents: 100, reason: 'Nothing taken', actorId: users['admin']!.id, actorRole: 'admin' }))
      .rejects.toMatchObject({ code: 'NOTHING_TO_REFUND', statusCode: 422 })
  })

  it('same caps and drawer rules: a cashier needs a manager PIN; cash needs an open drawer; a card goes back to 1030', async () => {
    const s = await openDrawer('cashier2')
    const o = await cancelledTicket(s.id, 5_000, { card: { cents: 7_000, ref: 'TERM-778' } })
    expect(await due(o.id)).toBe(12_000)

    await expect(refundOrder({ orderId: o.id, amountCents: 5_000, reason: 'Cancelled', actorId: users['cashier2']!.id, actorRole: 'cashier', method: 'cash' }))
      .rejects.toMatchObject({ code: 'MANAGER_OVERRIDE_REQUIRED', statusCode: 403 })
    const cash = await refundOrder({ orderId: o.id, amountCents: 5_000, reason: 'Cancelled', actorId: users['cashier2']!.id, actorRole: 'cashier', method: 'cash', managerOverridePin: PIN })
    expect(cash.shiftId).toBe(s.id)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'order_refund_due' } })
    expect((audit.metadata as { approverId?: string }).approverId).toBe(users['mgr']!.id)

    // Cash beyond what was taken in cash is refused even though card money is still owed.
    await expect(refundOrder({ orderId: o.id, amountCents: 1, reason: 'Cancelled', actorId: users['admin']!.id, actorRole: 'admin', method: 'cash', shiftId: s.id }))
      .rejects.toMatchObject({ code: 'REFUND_EXCEEDS_TENDER' })

    // The card part: defaults to the card tender, no drawer needed, Cr 1030.
    const cardBack = await refundOrder({ orderId: o.id, amountCents: 7_000, reason: 'Cancelled', actorId: users['mgr']!.id, actorRole: 'foh_management', method: 'card' })
    const e = await linesOf(tenantA, [`order.refund:${cardBack.id}`])
    expect(amt(e, '1110', 'debit')).toBe(7_000)
    expect(amt(e, '1030', 'credit')).toBe(7_000)
    expect(await due(o.id)).toBe(0)

    // A cash hand-back by someone with no open drawer is refused.
    const s2 = await openDrawer('cashier2')
    const o2 = await cancelledTicket(s2.id, 1_000)
    await prisma.shift.updateMany({ where: { userId: users['mgr']!.id, status: 'open' }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
    await expect(refundOrder({ orderId: o2.id, amountCents: 1_000, reason: 'Cancelled', actorId: users['mgr']!.id, actorRole: 'foh_management' }))
      .rejects.toMatchObject({ code: 'OPEN_DRAWER_REQUIRED' })
  })

  it('two hand-backs fired together cannot both take the full amount (re-checked under the lock)', async () => {
    const s = await openDrawer('admin')
    const o = await cancelledTicket(s.id, 9_000)
    const fire = () => refundOrder({ orderId: o.id, amountCents: 9_000, reason: 'Double tap', actorId: users['admin']!.id, actorRole: 'admin' })
    const res = await Promise.allSettled([fire(), fire()])
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = res.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'NOTHING_TO_REFUND' })
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'refunded' } })).toBe(1)
    expect(await due(o.id)).toBe(0)
  })

  it('a cancelled ticket whose SRB invoice WAS filed (directly, pre-connector) gets its return queued to be filed by hand', async () => {
    const s = await openDrawer('admin')
    const o = await cancelledTicket(s.id, 4_000, { srbInvoiceNumber: 'SRB-ORIG-1' })
    const r = await refundOrder({ orderId: o.id, amountCents: 4_000, reason: 'Filed then cancelled', actorId: users['admin']!.id, actorRole: 'admin' })
    // Exactly one return document, for this refund, against the SRB number — never auto-sent.
    const docs = await prisma.fiscalDocument.findMany({ where: { orderId: o.id } })
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ kind: 'refund', status: 'manual_required', statusReason: 'prefiled_direct_refund', refundPaymentId: r.id, amountCents: 4_000, tenantId: tenantA })
    expect((docs[0]!.payload as { original?: { fiscalNumber?: string } }).original?.fiscalNumber).toBe('SRB-ORIG-1')
    expect(await prisma.exceptionFlag.count({ where: { tenantId: tenantA, kind: 'fiscal_manual_refund', entityId: docs[0]!.id } })).toBe(1)
    expect(r.fiscalRefund).toMatchObject({ documentId: docs[0]!.id, rawStatus: 'manual_required' })
    expect(r.srbReturnInvoiceNo).toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')
  })

  it("company B cannot refund company A's cancelled ticket (404), nor send A's money out of B's drawer", async () => {
    const s = await openDrawer('admin')
    const o = await cancelledTicket(s.id, 3_000)
    const res = await call('adminB', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 3_000, reason: 'Not mine' })
    expect(res.statusCode).toBe(404)
    const sB = await openDrawer('adminB', tenantB)
    const res2 = await call('admin', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 3_000, reason: 'Wrong drawer', shiftId: sB.id })
    expect([404, 422]).toContain(res2.statusCode)
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'refunded' } })).toBe(0)

    // Through the route, company A's own operator gets it back.
    const ok = await call('admin', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 3_000, reason: 'Cancelled ticket' })
    expect(ok.statusCode).toBe(200)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')
  })
})

// ─── R5-A / R5-B / R5-C ───────────────────────────────────────────────────────

describe('R5-A/B/C — a cancelled ticket nets to zero whatever was posted before the cancel', () => {
  /** A fresh drawer of company A, without closing the user's others. */
  const mkDrawer = (userKey = 'admin', openingFloatCents = 0) =>
    prisma.shift.create({ data: { userId: users[userKey]!.id, openingFloatCents, status: 'open', tenantId: tenantA } })
  const cancel = (id: string) => prisma.order.update({ where: { id }, data: { status: 'cancelled' } })
  const take = (orderId: string, shiftId: string, amountCents: number, method: 'cash' | 'card' = 'cash') =>
    prisma.payment.create({ data: { orderId, shiftId, method, amountCents, status: 'paid', processedAt: new Date(), ...(method === 'card' && { gatewayRef: `TERM-${RUN}-${amountCents}` }) } })
  /** A TILL-R3 void refund on a paid, still-open ticket: the engine's own row + entry (as writeRefundTx writes them). */
  const voidRefund = async (orderId: string, shiftId: string, cents: number) => {
    const r = await prisma.payment.create({ data: { orderId, shiftId, method: 'cash', amountCents: -cents, status: 'refunded', gateway: 'none', processedAt: new Date() } })
    expect((await postRefundPayment(r.id)).entryId).toBeTruthy()
    return r
  }
  const handBack = (orderId: string, amountCents: number, shiftId?: string, method?: 'cash' | 'card') =>
    refundOrder({ orderId, amountCents, reason: 'Cancelled — handed back', actorId: users['admin']!.id, actorRole: 'admin', ...(shiftId && { shiftId }), ...(method && { method }) })
  /** Every entry that touched the ticket: the given drawer closes, its refund rows, its unwind. */
  const books = async (orderId: string, closes: string[]) => {
    const refunds = await prisma.payment.findMany({ where: { orderId, status: 'refunded' }, select: { id: true } })
    return linesOf(tenantA, [...closes.map((s) => `shift.close:${s}`), ...refunds.map((r) => `order.refund:${r.id}`), `order.cancel_unwind:${orderId}`])
  }
  /** Accounts that do not net to zero (debit +). */
  const nonZero = (lines: Line[]) => {
    const net = new Map<string, number>()
    for (const l of lines) net.set(l.code, (net.get(l.code) ?? 0) + (l.type === 'debit' ? l.amount : -l.amount))
    return Object.fromEntries([...net].filter(([, v]) => v !== 0))
  }
  const unwindOf = (orderId: string) => linesOf(tenantA, [`order.cancel_unwind:${orderId}`])
  const online = (totalCents = 11_500, taxCents = 1_500) =>
    prisma.order.create({ data: { conceptId: conceptA, source: 'servd', fulfilmentType: 'takeout', status: 'preparing', totalCents, taxCents, taxRatePct: 15 } })

  it('R5-A — an online order whose drawer closed BEFORE the cancel: the hand-back debits 1010, not 1110', async () => {
    const s1 = await mkDrawer()
    const o = await online()
    await take(o.id, s1.id, 11_500)
    await closeAndPost(s1.id, 11_500)          // live then: non-till cash, Dr 1015 / Cr 1010
    await cancel(o.id)
    const s2 = await mkDrawer('admin', 20_000)
    const r = await handBack(o.id, 11_500, s2.id)
    const h = await linesOf(tenantA, [`order.refund:${r.id}`])
    expect(h).toEqual(expect.arrayContaining([
      { code: '1010', type: 'debit', amount: 11_500 },
      { code: '1015', type: 'credit', amount: 11_500 },
    ]))
    expect(h).toHaveLength(2)
    expect(await unwindOf(o.id)).toEqual([])  // nothing was booked as a sale
    expect(nonZero(await books(o.id, [s1.id]))).toEqual({})
  })

  it('R5-A — card a pre-cancel close never booked goes back against itself; cash against 1010', async () => {
    const s1 = await mkDrawer()
    const o = await online()
    await take(o.id, s1.id, 4_000, 'card')
    await take(o.id, s1.id, 7_500, 'cash')
    await closeAndPost(s1.id, 7_500)
    await cancel(o.id)
    const s2 = await mkDrawer('admin', 20_000)
    const card = await handBack(o.id, 4_000, s2.id, 'card')
    expect(await linesOf(tenantA, [`order.refund:${card.id}`])).toEqual(expect.arrayContaining([
      { code: '1030', type: 'debit', amount: 4_000 }, { code: '1030', type: 'credit', amount: 4_000 },
    ]))
    await handBack(o.id, 7_500, s2.id, 'cash')
    expect(nonZero(await books(o.id, [s1.id]))).toEqual({})
  })

  it('R5-B — a void refund while open, then the cancel: the sale-refund shares are undone once, 1110 / revenue / GST net to zero', async () => {
    const s1 = await mkDrawer()
    const o = await online()
    await take(o.id, s1.id, 11_500)
    const r1 = await voidRefund(o.id, s1.id, 2_300)   // Dr 4090 2,000 / Dr 2030 300 / Cr 1015
    await cancel(o.id)
    expect(await due(o.id)).toBe(9_200)
    // Handed back in two goes — the unwind is posted once, on the first.
    await handBack(o.id, 5_000, s1.id)
    const u = await unwindOf(o.id)
    expect(amt(u, '2030', 'credit')).toBe(300)
    expect(netCredit(u, (c) => c.startsWith('4'))).toBe(2_000)
    expect(amt(u, '1110', 'debit')).toBe(2_300)
    await handBack(o.id, 4_200, s1.id)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `order.cancel_unwind:${o.id}` } })).toBe(1)
    expect(await due(o.id)).toBe(0)
    await closeAndPost(s1.id, 0)                // after the cancel: Cr 1110 refund due, gross 11,500
    const all = await books(o.id, [s1.id])
    expect(all.some((l) => l.code === '2030')).toBe(true)   // r1's entry is in the set
    expect(nonZero(all)).toEqual({})
    void r1
  })

  it('R5-A + R5-B — void refund, the drawer closes, then the cancel: the reversal and the hand-back both clear 1010', async () => {
    const s1 = await mkDrawer()
    const o = await online()
    await take(o.id, s1.id, 11_500)
    await voidRefund(o.id, s1.id, 2_300)
    await closeAndPost(s1.id, 9_200)            // live then: non-till cash 11,500 (Cr 1010)
    await cancel(o.id)
    const s2 = await mkDrawer('admin', 20_000)
    await handBack(o.id, 9_200, s2.id)
    const u = await unwindOf(o.id)
    expect(amt(u, '1010', 'debit')).toBe(2_300)
    expect(amt(u, '1110', 'debit') + amt(u, '1110', 'credit')).toBe(0)
    expect(nonZero(await books(o.id, [s1.id]))).toEqual({})
  })

  it('R5-C — a till bill whose home drawer booked the sale, then cancelled: the sale is reversed, the 1110 receivable cleared', async () => {
    const s1 = await mkDrawer()
    const o = await prisma.order.create({ data: { conceptId: conceptA, source: 'pos', fulfilmentType: 'dine_in', status: 'preparing', shiftId: s1.id, totalCents: 11_500, taxCents: 1_500, taxRatePct: 15 } })
    await take(o.id, s1.id, 5_000)
    await closeAndPost(s1.id, 5_000)            // Cr 4090 10,000 / Cr 2030 1,500 / Dr 1015 5,000 / Dr 1110 6,500
    await cancel(o.id)
    const s2 = await mkDrawer('admin', 20_000)
    const r = await handBack(o.id, 5_000, s2.id)
    const u = await unwindOf(o.id)
    expect(amt(u, '2030', 'debit')).toBe(1_500)
    expect(netCredit(u, (c) => c.startsWith('4'))).toBe(-10_000)
    expect(amt(u, '1110', 'credit')).toBe(11_500)
    const h = await linesOf(tenantA, [`order.refund:${r.id}`])
    expect(h.filter((l) => /^(4|7|203)/.test(l.code))).toEqual([])   // the hand-back itself is never a sale refund
    expect(nonZero(await books(o.id, [s1.id]))).toEqual({})
  })

  it('R5-C — service charge and tip, home drawer closed before the cancel, card on a drawer that closes after it', async () => {
    const s1 = await mkDrawer()
    const s2 = await mkDrawer('cashier')
    const o = await prisma.order.create({
      data: { conceptId: conceptA, source: 'pos', fulfilmentType: 'dine_in', status: 'preparing', shiftId: s1.id, totalCents: 12_650, taxCents: 1_500, serviceChargeCents: 500, tipCents: 650, taxRatePct: 15 },
    })
    await take(o.id, s1.id, 3_000)
    await sleep(5)
    await take(o.id, s2.id, 2_000, 'card')
    await closeAndPost(s1.id, 3_000)            // home: books the sale, 9,650 unsettled
    await cancel(o.id)
    const s3 = await mkDrawer('admin', 20_000)
    await handBack(o.id, 3_000, s3.id, 'cash')
    await handBack(o.id, 2_000, undefined, 'card')
    await closeAndPost(s2.id, 0)                // after the cancel: Dr 1030 / Cr 1110 refund due
    const all = await books(o.id, [s1.id, s2.id])
    expect(all.some((l) => l.code === '4100')).toBe(true)
    expect(all.some((l) => l.code === '2095')).toBe(true)
    expect(nonZero(all)).toEqual({})
  })

  it('a ticket refunded in full BEFORE the cancel has no hand-back: the cancel path posts the unwind itself (idempotent)', async () => {
    const s1 = await mkDrawer()
    const o = await online(2_300, 300)
    await take(o.id, s1.id, 2_300)
    await voidRefund(o.id, s1.id, 2_300)
    await expect(postCancelledTicketUnwind(o.id)).rejects.toMatchObject({ code: 'NOT_CANCELLED' })
    await cancel(o.id)
    await expect(handBack(o.id, 1)).rejects.toMatchObject({ code: 'NOTHING_TO_REFUND' })
    const id1 = await postCancelledTicketUnwind(o.id)
    expect(id1).toBeTruthy()
    expect(await postCancelledTicketUnwind(o.id)).toBe(id1)
    await closeAndPost(s1.id, 0)
    expect(nonZero(await books(o.id, [s1.id]))).toEqual({})
    // A plain cancelled ticket (no pre-cancel posting) has nothing to undo.
    const s2 = await mkDrawer()
    const plain = await online()
    await take(plain.id, s2.id, 1_000)
    await cancel(plain.id)
    expect(await postCancelledTicketUnwind(plain.id)).toBeNull()
    // Company B's books are never touched.
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB, reference: { startsWith: 'order.cancel_unwind:' } } })).toBe(0)
  })

  const due = async (orderId: string) => refundDueCents(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true } }))
})

// ─── LEDGER-R6 ────────────────────────────────────────────────────────────────

describe('LEDGER-R6 — gift cards in the sales register agree with the P&L', () => {
  const period = () => ({ from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) })
  const register = (tenantId: string, conceptId?: string) =>
    salesTotals({ company: { tenantId }, conceptId: conceptId ?? null, ...period() })

  it('1150 with a 500 card: gross 1150; a 325 refund reverses 42 GST; refunded in full → refunds 1150, GST 0', async () => {
    // An online order: value 1150 (150 GST), a 500 gift card, the rest by card.
    const o = await prisma.order.create({
      data: { conceptId: conceptReg, source: 'servd', fulfilmentType: 'takeout', status: 'received', totalCents: 1_150, taxCents: 150 },
    })
    await prisma.payment.create({ data: { orderId: o.id, method: 'card', amountCents: 1_150, status: 'pending', gateway: 'keenu' } })
    const gc = await card(tenantA, 500)
    const applied = await redeemGiftCard({ code: gc.code, orderId: o.id })
    expect(applied.appliedCents).toBe(500)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).totalCents).toBe(650)
    await prisma.payment.updateMany({ where: { orderId: o.id, status: 'pending' }, data: { status: 'paid', gatewayRef: 'KEENU-MF-1', processedAt: new Date() } })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'completed', completedAt: new Date() } })
    expect((await postOrderCompletion(o.id)).posted).toBe(true)

    const refs = async () => {
      const refunds = await prisma.payment.findMany({ where: { orderId: o.id, status: 'refunded' }, select: { id: true } })
      const reds = await prisma.giftCardRedemption.findMany({ where: { orderId: o.id }, select: { id: true } })
      return [`order.complete:${o.id}`, ...refunds.map((r) => `order.refund:${r.id}`), ...reds.map((r) => `order.refund_giftcard:${r.id}`), `order.refund_wallet:${o.id}`]
    }
    /** The P&L for this order from the ledger: revenue (4xxx) less contra revenue (7xxx), and output GST. */
    const ledger = async () => {
      const lines = await linesOf(tenantA, await refs())
      return { net: netCredit(lines, (c) => c.startsWith('4') || c.startsWith('7')), tax: netCredit(lines, (c) => /^203\d$/.test(c)) }
    }

    let t = await register(tenantA, conceptReg)
    expect(t).toMatchObject({ orders: 1, gross: 1_150, tax: 150, refunds: 0, net: 1_000 })
    expect(await ledger()).toEqual({ net: t.net, tax: t.tax })

    // A partial refund of 325 by card: the GST share is on the FULL value (round(150 × 325 / 1150) = 42).
    await refundOrder({ orderId: o.id, amountCents: 325, reason: 'Cold fries', actorId: users['admin']!.id, actorRole: 'admin', method: 'card' })
    t = await register(tenantA, conceptReg)
    expect(t).toMatchObject({ gross: 1_150, refunds: 325, tax: 108 })
    expect(await ledger()).toEqual({ net: t.net, tax: t.tax })

    // The rest of the tender back → refunded in full → the card is re-credited too.
    await refundOrder({ orderId: o.id, amountCents: 325, reason: 'Whole order wrong', actorId: users['admin']!.id, actorRole: 'admin', method: 'card' })
    // The engine fires the restores; run them here too (idempotent) so they are done.
    await postOrderRefund(o.id, 'Order refunded', { bookWalletRestore: true })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('refunded')
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: gc.id } })).balanceCents).toBe(500)

    t = await register(tenantA, conceptReg)
    expect(t).toMatchObject({ orders: 1, gross: 1_150, refunds: 1_150, tax: 0, net: 0 })
    expect(await ledger()).toEqual({ net: t.net, tax: t.tax })

    // The per-day series and per-channel totals carry the card too.
    const { salesByChannel, dailySeries } = await import('../src/modules/reports/service.js')
    const ch = await salesByChannel({ company: { tenantId: tenantA }, conceptId: conceptReg, ...period() })
    expect(ch.find((c) => c.source === 'servd')).toMatchObject({ gross: 1_150, refunds: 1_150, tax: 0 })
    const days = await dailySeries({ company: { tenantId: tenantA }, conceptId: conceptReg, ...period() })
    expect(days.reduce((s, d) => s + d.gross, 0)).toBe(1_150)

    // Company B's register sees none of it.
    const b = await register(tenantB)
    expect(b).toMatchObject({ orders: 0, gross: 0, refunds: 0, tax: 0 })
    const bOnA = await salesTotals({ company: { tenantId: tenantB }, conceptId: conceptReg, ...period() })
    expect(bOnA.gross).toBe(0)
    void conceptB
  })

  it('R6-A — a sale booked before ONL-05 (no 2080 line) is valued without its card, as the ledger values it', async () => {
    // Its own brand, so the register for it holds only this order.
    const legacyConcept = (await prisma.concept.create({
      data: { name: 'Legacy Cafe', slug: `mf-legacy-${RUN}`, type: 'restaurant', tenantId: tenantA, taxRateCash: 15, taxRateCard: 8 },
    })).id
    // 1150 (150 GST), a 500 card, 650 by card.
    const o = await prisma.order.create({
      data: { conceptId: legacyConcept, source: 'servd', fulfilmentType: 'takeout', status: 'received', totalCents: 1_150, taxCents: 150 },
    })
    await prisma.payment.create({ data: { orderId: o.id, method: 'card', amountCents: 1_150, status: 'pending', gateway: 'keenu' } })
    const gc = await card(tenantA, 500)
    await redeemGiftCard({ code: gc.code, orderId: o.id })
    await prisma.payment.updateMany({ where: { orderId: o.id, status: 'pending' }, data: { status: 'paid', gatewayRef: 'KEENU-MF-L', processedAt: new Date() } })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'completed', completedAt: new Date() } })
    // The sale as production booked it before ONL-05: revenue on the post-card
    // total (650 − 150 GST = 500), no 2080 debit naming the order.
    const { postJournalEntry, revenueCodeForConcept } = await import('../src/modules/accounting/journal.js')
    const slug = `mf-legacy-${RUN}`
    await postJournalEntry({
      tenantId: tenantA, sourceType: 'order.complete', sourceId: o.id, description: 'legacy sale (pre ONL-05)', postedBy: 'system',
      lines: [
        { accountCode: '1030', type: 'debit', amountCents: 650, conceptId: legacyConcept },
        { accountCode: revenueCodeForConcept(slug), type: 'credit', amountCents: 500, conceptId: legacyConcept },
        { accountCode: '2030', type: 'credit', amountCents: 150, conceptId: legacyConcept },
      ],
    })
    expect((await postOrderCompletion(o.id)).posted).toBe(false)   // already booked — nothing new

    const refs = async () => {
      const refunds = await prisma.payment.findMany({ where: { orderId: o.id, status: 'refunded' }, select: { id: true } })
      const reds = await prisma.giftCardRedemption.findMany({ where: { orderId: o.id }, select: { id: true } })
      return [`order.complete:${o.id}`, ...refunds.map((r) => `order.refund:${r.id}`), ...reds.map((r) => `order.refund_giftcard:${r.id}`), `order.refund_wallet:${o.id}`]
    }
    const ledger = async () => {
      const lines = await linesOf(tenantA, await refs())
      return { net: netCredit(lines, (c) => c.startsWith('4') || c.startsWith('7')), tax: netCredit(lines, (c) => /^203\d$/.test(c)) }
    }

    // The register no longer adds the card back to a legacy sale: gross 650, net 500 = the P&L.
    let t = await register(tenantA, legacyConcept)
    expect(t).toMatchObject({ orders: 1, gross: 650, tax: 150, refunds: 0, net: 500 })
    expect(await ledger()).toEqual({ net: t.net, tax: t.tax })

    // A 325 refund is valued on 650, as postRefundPayment values it: GST round(150 × 325 / 650) = 75.
    await refundOrder({ orderId: o.id, amountCents: 325, reason: 'Cold fries', actorId: users['admin']!.id, actorRole: 'admin', method: 'card' })
    t = await register(tenantA, legacyConcept)
    expect(t).toMatchObject({ gross: 650, refunds: 325, tax: 75 })
    expect(await ledger()).toEqual({ net: t.net, tax: t.tax })

    // Refunded in full: the card is re-credited, which books nothing on a legacy
    // sale (postOrderRefund) — so the register does not count it as a refund either.
    await refundOrder({ orderId: o.id, amountCents: 325, reason: 'Whole order wrong', actorId: users['admin']!.id, actorRole: 'admin', method: 'card' })
    await postOrderRefund(o.id, 'Order refunded', { bookWalletRestore: true })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: gc.id } })).balanceCents).toBe(500)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: { startsWith: 'order.refund_giftcard:' }, lines: { some: { conceptId: legacyConcept } } } })).toBe(0)
    t = await register(tenantA, legacyConcept)
    expect(t).toMatchObject({ orders: 1, gross: 650, refunds: 650, tax: 0, net: 0 })
    expect(await ledger()).toEqual({ net: t.net, tax: t.tax })

    // The ONL-05 sale above (conceptReg) is still valued with its card.
    expect(await register(tenantA, conceptReg)).toMatchObject({ gross: 1_150, refunds: 1_150, tax: 0, net: 0 })
    // Company B sees none of it.
    expect((await salesTotals({ company: { tenantId: tenantB }, conceptId: legacyConcept, ...period() })).gross).toBe(0)
  })
})
