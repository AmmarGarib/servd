// Ledger follow-ups — regression tests for the review round and the earlier
// fix agents' follow-ups.
//
//   LEDGER-R5  money taken on a cancelled ticket is held at the close as a
//       refund due (Cr 1110). Handing it back clears exactly that (Dr 1110 /
//       Cr drawer); refundDueCents is what is still owed, for the refund
//       engine's cap.
//   F1  the referral bonus is credited by the company of the referee's FIRST
//       completed order (not their latest), on that company's books.
//   F2  a B2B invoice's tax follows the brand's authority (2032 SRB for a
//       Sindh brand), like a sale; no brand stays on 2030.
//   F3  the sales-tax-return CSV carries the per-authority nets, the per-rate
//       breakdown and the 2030 reclassification list.
//   F4  a WhatsApp order is placed (source 'servd', raw_payload.channel =
//       'whatsapp' — 'whatsapp' was never an order source, so every one
//       failed), priced at the brand's cash GST rate, idempotent per summary.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const sentWa: Array<{ to: string; text: string }> = []
vi.mock('../src/lib/whatsapp.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/whatsapp.js')>()),
  sendText: async (to: string, text: string) => { sentWa.push({ to, text }); return {} },
  sendButtons: async (to: string, text: string) => { sentWa.push({ to, text }); return {} },
  sendInteractiveList: async (to: string, _h: string, text: string) => { sentWa.push({ to, text }); return {} },
}))
vi.mock('../src/lib/notify.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/notify.js')>()),
  sendPhoneMessage: async () => {},
  sendEmail: async () => {},
}))

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
const { postOrderCompletion, postRefundPayment, refundDueCents } = await import('../src/modules/accounting/orderPosting.js')
const { postShiftClose } = await import('../src/modules/accounting/shiftPosting.js')
const { runReferralRewardTrigger } = await import('../src/workers/loyaltyTriggers.js')
const { receivableRoutes } = await import('../src/modules/receivables/routes.js')
const { accountingRoutes } = await import('../src/modules/accounting/routes.js')
const { handleWaMessage, placeOrder } = await import('../src/adapters/whatsapp/conversation.js')
const { getSession, saveSession, newSession, clearSession } = await import('../src/lib/wa-session.js')

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptSD: string, conceptB: string
let slugSD: string
const staff: Record<string, { id: string; token: string }> = {}

async function mkStaff(key: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@ledgerfollow.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]!.token}` } })

type Line = { code: string; type: string; amount: number; conceptId: string | null }
async function entry(tenantId: string, reference: string): Promise<Line[] | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  return je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, conceptId: l.conceptId }))
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
const side = (lines: Line[], type: string) => lines.filter((l) => l.type === type).reduce((t, l) => t + l.amount, 0)

async function netCredit(tenantId: string, code: string, where: Record<string, unknown> = {}): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { tenantId, code }, journalEntry: { tenantId, ...where } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((t, l) => t + (l.type === 'credit' ? l.amountCents : -l.amountCents), 0)
}

let cashierSeq = 0
async function freshShift(tenantId: string) {
  const u = await prisma.user.create({
    data: { name: `till${++cashierSeq}`, email: `till${cashierSeq}.${RUN}@ledgerfollow.test`, password: 'x', role: 'cashier', isActive: true, accountStatus: 'active', tenantId },
  })
  return prisma.shift.create({ data: { userId: u.id, openingFloatCents: 0, status: 'open', tenantId } })
}
async function closeAndPost(shiftId: string, countedCents: number, mustPost = true) {
  await prisma.shift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: countedCents } })
  const r = await postShiftClose(shiftId)
  if (mustPost) expect(r.posted).toBe(true)
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Follow A', slug: `lf-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Follow B', slug: `lf-b-${RUN}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  conceptA = (await prisma.concept.create({ data: { name: 'No province', slug: `lf-np-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
  slugSD = `lf-sd-${RUN}`
  conceptSD = (await prisma.concept.create({ data: { name: 'Karachi kitchen', slug: slugSD, type: 'restaurant', tenantId: tenantA, province: 'SD' } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Other co', slug: `lf-b-${RUN}`, type: 'restaurant', tenantId: tenantB, province: 'SD' } })).id
  await mkStaff('mgrA', tenantA)
  await mkStaff('mgrB', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.register(receivableRoutes, { prefix: '/accounting/receivables' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── LEDGER-R5 ────────────────────────────────────────────────────────────────

describe('money taken on a cancelled ticket can be handed back against the refund due', () => {
  it('the close holds it in 1110; the hand-back on a later drawer clears exactly that, never revenue or tax', async () => {
    const shift = await freshShift(tenantA)
    const order = await prisma.order.create({
      data: {
        conceptId: conceptSD, source: 'pos', status: 'received', totalCents: 100_050, taxCents: 13_050, taxRatePct: 15,
        items: { create: [{ name: 'Split table', quantity: 1, unitPriceCents: 87_000 }] },
      },
    })
    // One half of a split settled in cash, then the manager cancels the ticket.
    await prisma.payment.create({ data: { orderId: order.id, shiftId: shift.id, method: 'cash', amountCents: 50_025, status: 'paid', processedAt: new Date() } })
    await prisma.order.update({ where: { id: order.id }, data: { status: 'cancelled' } })

    const withPayments = () => prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } })
    expect(refundDueCents(await withPayments())).toBe(50_025)

    await closeAndPost(shift.id, 50_025)
    const close = (await entry(tenantA, `shift.close:${shift.id}`))!
    expect(amt(close, '1110', 'credit')).toBe(50_025)
    expect(amt(close, '2032', 'credit')).toBe(0)

    // Handed back from the next drawer — what the refund engine writes.
    const next = await freshShift(tenantA)
    const refund = await prisma.payment.create({
      data: { orderId: order.id, shiftId: next.id, method: 'cash', amountCents: -50_025, status: 'refunded', processedAt: new Date() },
    })
    const r = await postRefundPayment(refund.id)
    expect(r.posted).toBe(true)
    const back = (await entry(tenantA, `order.refund:${refund.id}`))!
    expect(back).toHaveLength(2)
    expect(amt(back, '1110', 'debit')).toBe(50_025)
    expect(amt(back, '1015', 'credit')).toBe(50_025)
    expect(side(back, 'debit')).toBe(side(back, 'credit'))

    // 1110 nets to zero for this order; nothing is owed any more.
    expect(await netCredit(tenantA, '1110', { reference: { in: [`shift.close:${shift.id}`, `order.refund:${refund.id}`] } })).toBe(0)
    expect(refundDueCents(await withPayments())).toBe(0)

    // The next drawer's close does not book the hand-back a second time (no
    // 7040 refunds-issued line for it), and it reconciles at zero.
    await closeAndPost(next.id, 0, false)
    const nextClose = await entry(tenantA, `shift.close:${next.id}`)
    expect(nextClose ? amt(nextClose, '7040', 'debit') : 0).toBe(0)

    // Replay is a no-op.
    expect((await postRefundPayment(refund.id)).posted).toBe(false)
  })

  it('refundDueCents is 0 for a sale, ignores comps and open portions, and counts only drawer receipts', () => {
    const paid = { method: 'cash', status: 'paid', amountCents: 1_000, gatewayRef: null, shiftId: 'S1' }
    expect(refundDueCents({ status: 'completed', payments: [paid] })).toBe(0)
    expect(refundDueCents({ status: 'rejected', payments: [paid, { method: 'comp', status: 'paid', amountCents: 500, gatewayRef: null, shiftId: 'S1' }] })).toBe(1_000)
    // An open check-split portion (pending, no terminal ref) is not money taken.
    expect(refundDueCents({ status: 'cancelled', payments: [{ method: 'cash', status: 'pending', amountCents: 700, gatewayRef: null, shiftId: 'S1' }] })).toBe(0)
    // A card tender the till took (terminal ref) is.
    expect(refundDueCents({ status: 'cancelled', payments: [{ method: 'card', status: 'pending', amountCents: 700, gatewayRef: 'T-1', shiftId: 'S1' }] })).toBe(700)
    // An online gateway's receipt (no drawer) goes back through the gateway, not here.
    expect(refundDueCents({ status: 'cancelled', payments: [{ method: 'card', status: 'paid', amountCents: 700, gatewayRef: 'KEENU-1', shiftId: null }] })).toBe(0)
    // Part already handed back.
    expect(refundDueCents({ status: 'cancelled', payments: [paid, { method: 'cash', status: 'refunded', amountCents: -400, gatewayRef: null, shiftId: 'S2' }] })).toBe(600)
    // An on-account charge is not money taken — nothing to hand back.
    expect(refundDueCents({ status: 'cancelled', payments: [paid, { method: 'on_account', status: 'paid', amountCents: 900, gatewayRef: 'OA-0001', shiftId: 'S1' }] })).toBe(1_000)
  })

  it('after the company\'s till-clearing cut-over the refund due and its hand-back use 1115, not 1110', async () => {
    const tenantX = (await prisma.tenant.create({ data: { name: 'Follow X', slug: `lf-x-${RUN}` } })).id
    await ensureChartOfAccounts(tenantX)
    const conceptX = (await prisma.concept.create({ data: { name: 'Cut over', slug: `lf-x-${RUN}`, type: 'restaurant', tenantId: tenantX, province: 'SD' } })).id
    const { tillClearingCutoverKey } = await import('../src/modules/accounting/tillClearingCode.js')
    await prisma.setting.create({ data: { key: tillClearingCutoverKey(tenantX), value: new Date().toISOString() } })
    const shift = await freshShift(tenantX)
    const order = await prisma.order.create({
      data: {
        conceptId: conceptX, source: 'pos', status: 'received', totalCents: 11_500, taxCents: 1_500, taxRatePct: 15,
        items: { create: [{ name: 'Cancelled', quantity: 1, unitPriceCents: 10_000 }] },
      },
    })
    await prisma.payment.create({ data: { orderId: order.id, shiftId: shift.id, method: 'cash', amountCents: 11_500, status: 'paid', processedAt: new Date() } })
    await prisma.order.update({ where: { id: order.id }, data: { status: 'cancelled' } })
    await closeAndPost(shift.id, 11_500)
    const close = (await entry(tenantX, `shift.close:${shift.id}`))!
    expect(amt(close, '1115', 'credit')).toBe(11_500)
    expect(amt(close, '1110', 'credit')).toBe(0)
    const next = await freshShift(tenantX)
    const refund = await prisma.payment.create({
      data: { orderId: order.id, shiftId: next.id, method: 'cash', amountCents: -11_500, status: 'refunded', processedAt: new Date() },
    })
    expect((await postRefundPayment(refund.id)).posted).toBe(true)
    const back = (await entry(tenantX, `order.refund:${refund.id}`))!
    expect(amt(back, '1115', 'debit')).toBe(11_500)
    expect(amt(back, '1110', 'debit')).toBe(0)
    // Company A (no marker) is unaffected.
    const { tillClearingCodeTx } = await import('../src/modules/accounting/tillClearingCode.js')
    expect(await tillClearingCodeTx(prisma, tenantA)).toBe('1110')
  })
})

// ─── F1 ───────────────────────────────────────────────────────────────────────

describe('the referral bonus is given by the company of the referee\'s first order', () => {
  it('credits both sides at that company and books its liability there — not at the latest order\'s company', async () => {
    const referrer = await prisma.customer.create({ data: { name: 'Referrer', email: `referrer.${RUN}@ledgerfollow.test` } })
    const referee = await prisma.customer.create({
      data: { name: 'Referee', email: `referee.${RUN}@ledgerfollow.test`, referredById: referrer.id, phoneVerifiedAt: new Date(), firstOrderAt: new Date(Date.now() - 3_600_000) },
    })
    // First completed order at company B, a later one at company A.
    await prisma.order.create({
      data: { conceptId: conceptB, customerId: referee.id, source: 'servd', status: 'completed', totalCents: 80_000, placedAt: new Date(Date.now() - 3_600_000), completedAt: new Date(Date.now() - 3_600_000), items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: 80_000 }] } },
    })
    await prisma.order.create({
      data: { conceptId: conceptA, customerId: referee.id, source: 'servd', status: 'completed', totalCents: 90_000, placedAt: new Date(), completedAt: new Date(), items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: 90_000 }] } },
    })

    await runReferralRewardTrigger()

    for (const customerId of [referee.id, referrer.id]) {
      const accounts = await prisma.loyaltyAccount.findMany({ where: { customerId } })
      expect(accounts.map((a) => a.tenantId)).toEqual([tenantB])
      expect(accounts[0]!.pointsBalance).toBe(200)
      const earn = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { loyaltyAccountId: accounts[0]!.id, type: 'earn' } })
      const je = await entry(tenantB, `loyalty.earn:${earn.id}`)
      expect(je).not.toBeNull()
      expect(amt(je!, '2060', 'credit')).toBe(amt(je!, '6060', 'debit'))
      expect(amt(je!, '2060', 'credit')).toBeGreaterThan(0)
      expect(await entry(tenantA, `loyalty.earn:${earn.id}`)).toBeNull()
    }
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: referee.id } })).referralRewardCreditedAt).not.toBeNull()

    // Run again: nothing more.
    await runReferralRewardTrigger()
    expect((await prisma.loyaltyAccount.findFirstOrThrow({ where: { customerId: referrer.id } })).pointsBalance).toBe(200)
  })
})

// ─── F2 ───────────────────────────────────────────────────────────────────────

describe('a B2B invoice\'s tax goes to the brand\'s authority', () => {
  const invoice = (conceptId: string | null) => ({
    // Issued today, so the issue and its void fall in the same return period.
    customerName: 'Corporate client', conceptId, issueDate: new Date().toISOString().slice(0, 10), dueDate: '2099-12-31',
    description: 'Catering', amountCents: 100_000, taxCents: 15_000,
  })

  it('a Sindh brand\'s invoice credits 2032 SRB, tagged with the brand; the void reverses it there', async () => {
    const res = await call('mgrA', 'POST', '/accounting/receivables', invoice(conceptSD))
    expect(res.statusCode).toBe(201)
    const inv = res.json() as { id: string }
    const lines = (await entry(tenantA, `receivable.issue:${inv.id}`))!
    expect(amt(lines, '2032', 'credit')).toBe(15_000)
    expect(amt(lines, '2030', 'credit')).toBe(0)
    expect(lines.find((l) => l.code === '2032')!.conceptId).toBe(conceptSD)
    expect(amt(lines, '1110', 'debit')).toBe(115_000)

    const voided = await call('mgrA', 'POST', `/accounting/receivables/${inv.id}/void`, { reason: 'raised in error' })
    expect(voided.statusCode).toBe(200)
    expect(await netCredit(tenantA, '2032', { reference: { in: [`receivable.issue:${inv.id}`, `receivable.issue.reversal:${inv.id}`] } })).toBe(0)
  })

  it('an invoice with no brand (or a brand with no province) stays on 2030 FBR; a zero-tax invoice has no tax line', async () => {
    const res = await call('mgrA', 'POST', '/accounting/receivables', invoice(null))
    expect(res.statusCode).toBe(201)
    const lines = (await entry(tenantA, `receivable.issue:${(res.json() as { id: string }).id}`))!
    expect(amt(lines, '2030', 'credit')).toBe(15_000)

    const np = await call('mgrA', 'POST', '/accounting/receivables', invoice(conceptA))
    expect(amt((await entry(tenantA, `receivable.issue:${(np.json() as { id: string }).id}`))!, '2030', 'credit')).toBe(15_000)

    const zero = await call('mgrA', 'POST', '/accounting/receivables', { ...invoice(conceptSD), taxCents: 0 })
    const zl = (await entry(tenantA, `receivable.issue:${(zero.json() as { id: string }).id}`))!
    expect(zl.some((l) => l.code === '2032' || l.code === '2030')).toBe(false)
    expect(side(zl, 'debit')).toBe(side(zl, 'credit'))
  })

  it('company B cannot raise an invoice against company A\'s brand', async () => {
    const res = await call('mgrB', 'POST', '/accounting/receivables', invoice(conceptSD))
    expect([404, 422]).toContain(res.statusCode)
    expect(await prisma.receivableInvoice.count({ where: { tenantId: tenantB } })).toBe(0)
  })
})

// ─── F3 ───────────────────────────────────────────────────────────────────────

describe('the sales-tax-return CSV carries what the return files', () => {
  it('per-authority nets, the per-rate breakdown and the 2030 reclassification list — for the active company only', async () => {
    // A Sindh sale at the cash rate (books 2032), and old Sindh tax still in 2030.
    const o = await prisma.order.create({
      data: {
        conceptId: conceptSD, source: 'servd', status: 'completed', completedAt: new Date(), totalCents: 115_000, taxCents: 15_000, taxRatePct: 15,
        items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: 100_000 }] },
      },
    })
    await prisma.payment.create({ data: { orderId: o.id, method: 'cash', amountCents: 115_000, status: 'pending' } })
    expect((await postOrderCompletion(o.id)).posted).toBe(true)
    await postJournalEntry({
      tenantId: tenantA, sourceType: 'test.legacy_sindh_sale', sourceId: RUN, description: 'pre-routing sale', postedBy: 'test',
      lines: [
        { accountCode: '1010', type: 'debit', amountCents: 2_300 },
        { accountCode: '2030', type: 'credit', amountCents: 2_300, conceptId: conceptSD },
      ],
    })

    // Yesterday..today in PKT: the route reads Karachi days, and just after
    // PKT midnight the sale books to its shift's business day (yesterday)
    // while the manual entry books to today — a one-day window (UTC or PKT)
    // missed one of them between 19:00 UTC and the business-day cutoff.
    const pktDay = (offsetDays: number) => new Date(Date.now() + 5 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10)
    const since = pktDay(-1)
    const today = pktDay(0)
    const json = await call('mgrA', 'GET', `/accounting/sales-tax-return?dateFrom=${since}&dateTo=${today}`)
    expect(json.statusCode).toBe(200)
    const report = json.json() as { byAuthority: Array<{ authority: string; netPayableCents: number }>; reclassification: Array<{ conceptSlug: string; amountCents: number }> }
    expect(report.byAuthority.find((a) => a.authority === 'SRB')!.netPayableCents).toBeGreaterThanOrEqual(15_000)
    expect(report.reclassification.find((r) => r.conceptSlug === slugSD)!.amountCents).toBe(2_300)

    const res = await call('mgrA', 'GET', `/accounting/sales-tax-return?dateFrom=${since}&dateTo=${today}&format=csv`)
    expect(res.statusCode).toBe(200)
    const csv = res.body
    expect(csv).toContain('By authority — SRB')
    expect(csv).toContain('Net payable')
    expect(csv).toMatch(/By rate,SRB,SRB Standard-rated cash 15% — output tax to declare/)
    expect(csv).toMatch(/By rate,SRB,SRB Standard-rated cash 15% — taxable value to declare/)
    expect(csv).toContain(`Reclassify,${slugSD},Karachi kitchen: Dr 2030 / Cr 2032`)
    expect(csv).toContain('EXCESS INPUT CARRIED FORWARD')
    // Company B's return never shows A's brand.
    const other = await call('mgrB', 'GET', `/accounting/sales-tax-return?dateFrom=${since}&dateTo=${today}&format=csv`)
    expect(other.body).not.toContain(slugSD)
  })
})

// ─── F4 ───────────────────────────────────────────────────────────────────────

describe('a WhatsApp order is placed', () => {
  const phone = `92300${Math.floor(1_000_000 + Math.random() * 8_999_999)}`
  let itemId: string

  beforeAll(async () => {
    const cat = await prisma.category.create({ data: { conceptId: conceptSD, name: 'Mains' } })
    itemId = (await prisma.menuItem.create({ data: { conceptId: conceptSD, categoryId: cat.id, name: 'Biryani', priceCents: 50_000 } })).id
    process.env['WHATSAPP_DEFAULT_CONCEPT'] = slugSD
  })
  afterAll(async () => { await clearSession(phone) })

  it('as a servd order from the whatsapp channel, priced at the brand\'s cash GST rate, idempotent per summary', async () => {
    const s = newSession(phone, conceptSD, slugSD)
    // A stale price in the session: the summary re-reads today's menu price.
    s.cart = [{ menuItemId: itemId, name: 'Biryani', priceCents: 1, quantity: 2 }]
    s.step = 'cart'
    await saveSession(s)

    sentWa.length = 0
    await handleWaMessage(phone, { from: phone, type: 'interactive', button_reply: { id: 'action:confirm', title: 'Confirm' } })
    const summary = sentWa.map((m) => m.text).join('\n')
    expect(summary).toContain('GST 15%')
    expect(summary).not.toContain('17%')
    const confirmed = (await getSession(phone))!
    expect(confirmed.step).toBe('confirm')
    expect(confirmed.cart[0]!.priceCents).toBe(50_000)

    await handleWaMessage(phone, { from: phone, type: 'interactive', button_reply: { id: 'action:place', title: 'Place' } })
    const placed = sentWa.map((m) => m.text).join('\n')
    expect(placed).toContain('Order Placed')

    const orders = await prisma.order.findMany({ where: { conceptId: conceptSD, externalId: { startsWith: 'whatsapp-' } }, include: { payments: true } })
    expect(orders).toHaveLength(1)
    const order = orders[0]!
    expect(order.source).toBe('servd')
    expect((order.rawPayload as { channel?: string }).channel).toBe('whatsapp')
    expect(order.taxRatePct).toBe(15)
    expect(order.taxCents).toBe(15_000)                 // 15% of 2 × 50,000
    expect(order.totalCents).toBe(115_000 + order.serviceChargeCents)
    expect(order.fulfilmentType).toBe('takeout')
    expect(order.deliveryOtp).toBeNull()
    expect(order.payments).toHaveLength(1)
    expect(order.payments[0]!.method).toBe('cash')
    expect(order.payments[0]!.amountCents).toBe(order.totalCents)

    // The same summary placed again (a re-delivered webhook) gets the SAME order.
    await placeOrder(phone, confirmed)
    expect(await prisma.order.count({ where: { conceptId: conceptSD, externalId: { startsWith: 'whatsapp-' } } })).toBe(1)
  })

  it('an item 86\'d after it went in the cart is dropped from the summary, and an empty cart places nothing', async () => {
    const off = await prisma.menuItem.create({ data: { conceptId: conceptSD, categoryId: (await prisma.category.findFirstOrThrow({ where: { conceptId: conceptSD } })).id, name: 'Kheer', priceCents: 20_000, isAvailable: false } })
    const s = newSession(phone, conceptSD, slugSD)
    s.cart = [{ menuItemId: off.id, name: 'Kheer', priceCents: 20_000, quantity: 1 }]
    s.step = 'cart'
    await saveSession(s)
    const before = await prisma.order.count({ where: { conceptId: conceptSD } })
    sentWa.length = 0
    await handleWaMessage(phone, { from: phone, type: 'interactive', button_reply: { id: 'action:confirm', title: 'Confirm' } })
    expect(sentWa.map((m) => m.text).join('\n')).toContain('nothing in your cart is available')
    await placeOrder(phone, { ...s, step: 'confirm' })
    expect(await prisma.order.count({ where: { conceptId: conceptSD } })).toBe(before)
  })
})
