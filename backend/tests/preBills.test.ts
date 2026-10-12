// Pre-bills (spec §17.1–§17.3) — the guest check printed before payment.
//
// What this guards:
//   - a pre-bill NEVER creates a FiscalDocument (only the full & final bill
//     files, and that is completeOrder's job);
//   - its totals are THE server quote — the same numbers GET
//     /pos/orders/:id/quote returns, cash headline + card total line;
//   - numbers are per company and gap-free, even under concurrent prints;
//   - a reprint supersedes the earlier print (both stay, permanently);
//   - ALREADY_FINAL / ORDER_NOT_OPEN refusals;
//   - company separation: company B gets 404 on company A's orders and
//     pre-bills, and B's Finance list never shows A's;
//   - a part-paid order's pre-bill prints what is already paid and the
//     balance due (the quote's paidCents / dueCents);
//   - the lifecycle hooks take the order lock, so a print racing a cancel
//     can never leave an 'open' pre-bill on a cancelled order;
//   - Finance → Voided pre bills: ORPHANED (cancel, closed drawer, 12 h),
//     FINAL_LOWER (against the total for the tender actually settled),
//     LINE_VOIDS_AFTER flags, the summary (money once per order, however
//     many reprints), "flagged only", CSV;
//   - there is no delete / edit endpoint.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { lockOrderTx } from '../src/modules/pos/service.js'
import {
  registerPreBillPlugins,
  markPreBillsConvertedTx,
  markPreBillsCancelledTx,
  ORPHAN_AFTER_MS,
  type PreBillList,
  type PreBillReceipt,
} from '../src/modules/prebills/index.js'

let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string
const item: Record<string, string> = {}
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: UserRole, tenantId: string | null) {
  const u = await prisma.user.create({
    data: { name: `User ${key}`, email: `${key}.prebills@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId },
  })
  if (tenantId) await prisma.tenantMember.create({ data: { tenantId, userId: u.id } }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u
}

const call = (who: string, method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }), headers: { authorization: `Bearer ${users[who]!.token}` } })

async function drawer(who: string): Promise<string> {
  await prisma.shift.updateMany({ where: { userId: users[who]!.id, status: 'open' }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
  const r = await call(who, 'POST', '/pos/shifts/open', { openingFloatCents: 100_000 })
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id as string
}

/** Ring up an open till sale for company A (or B). */
async function ring(who: string, conceptId: string, lines: Array<{ key: string; name: string; qty: number; price: number }>) {
  const r = await call(who, 'POST', '/pos/orders', {
    conceptId,
    items: lines.map((l) => ({ menuItemId: item[l.key]!, name: l.name, quantity: l.qty, unitPriceCents: l.price, modifiers: [] })),
  })
  expect(r.statusCode, r.body).toBe(201)
  return r.json() as { id: string; totalCents: number; taxCents: number; items: Array<{ id: string; name: string }> }
}
const NIHARI = { key: 'nihari', name: 'Beef Nihari', qty: 1, price: 145_000 }
const KHEER = { key: 'kheer', name: 'Kheer', qty: 2, price: 55_000 }

async function print(who: string, orderId: string, tender?: 'cash' | 'card') {
  return call(who, 'POST', `/pos/orders/${orderId}/pre-bill`, tender ? { tender } : {})
}

async function list(who: string, query = ''): Promise<PreBillList> {
  const r = await call(who, 'GET', `/pre-bills${query}`)
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as PreBillList
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods', slug: 'prebills-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Grill Co', slug: 'prebills-b' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA = (await prisma.concept.create({ data: { name: 'Simmer', slug: 'pb-simmer', type: 'restaurant', tenantId: tenantA, taxRate: 17, taxRateCash: 15, taxRateCard: 8 } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Grill House', slug: 'pb-grill', type: 'restaurant', tenantId: tenantB, taxRate: 17, taxRateCash: 15, taxRateCard: 8 } })).id
  const catA = await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })
  const catB = await prisma.category.create({ data: { conceptId: conceptB, name: 'Mains' } })
  item['nihari'] = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: catA.id, name: 'Beef Nihari', priceCents: 145_000 } })).id
  item['kheer'] = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: catA.id, name: 'Kheer', priceCents: 55_000 } })).id
  item['chapli'] = (await prisma.menuItem.create({ data: { conceptId: conceptB, categoryId: catB.id, name: 'Chapli Burger', priceCents: 90_000 } })).id

  await mkUser('cashierA', 'cashier', tenantA)
  await mkUser('waiterA', 'foh', tenantA)
  await mkUser('mgrA', 'foh_management', tenantA)
  await mkUser('financeA', 'finance', tenantA)
  await mkUser('cashierB', 'cashier', tenantB)
  await mkUser('financeB', 'finance', tenantB)
  await mkUser('nobody', 'finance', null)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(posRoutes, { prefix: '/pos' })
  await registerPreBillPlugins(app)
  await app.ready()

  await drawer('cashierA')
  await drawer('waiterA')
  await drawer('cashierB')
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('printing a pre-bill', () => {
  it('prints the server quote — cash headline and card total — and files NOTHING', async () => {
    const o = await ring('cashierA', conceptA, [NIHARI, KHEER])
    const fiscalBefore = await prisma.fiscalDocument.count()

    const r = await print('cashierA', o.id)
    expect(r.statusCode, r.body).toBe(201)
    const { preBill, receipt } = r.json() as { preBill: { id: string; number: number; status: string; totalCents: number; cardTotalCents: number | null; tenantId: string }; receipt: PreBillReceipt }

    const cash = (await call('cashierA', 'GET', `/pos/orders/${o.id}/quote?method=cash`)).json()
    const card = (await call('cashierA', 'GET', `/pos/orders/${o.id}/quote?method=card`)).json()
    expect(preBill.totalCents).toBe(cash.totalCents)
    expect(preBill.cardTotalCents).toBe(card.totalCents)
    expect(card.totalCents).toBeLessThan(cash.totalCents) // 8% card GST vs 15% cash
    expect(receipt.taxCents).toBe(cash.taxCents)
    expect(receipt.totalCents).toBe(cash.totalCents)
    expect(receipt.subtotalCents).toBe(145_000 + 2 * 55_000)

    expect(receipt.kind).toBe('pre_bill')
    expect(receipt.banner).toBe('PRE-BILL — NOT A TAX INVOICE')
    expect(receipt.number).toBe(`PB-${preBill.number}`)
    expect(receipt).not.toHaveProperty('fiscalNumber')
    expect(receipt).not.toHaveProperty('invoiceNumber')
    expect(receipt).not.toHaveProperty('srbInvoiceNo')
    expect(receipt).not.toHaveProperty('fbrInvoiceNo')
    expect(preBill.status).toBe('open')
    expect(preBill.tenantId).toBe(tenantA)

    // Never a fiscal document, never a tax invoice.
    expect(await prisma.fiscalDocument.count()).toBe(fiscalBefore)
    expect(await prisma.fiscalDocument.count({ where: { orderId: o.id } })).toBe(0)
    expect(await prisma.taxInvoice.count({ where: { orderId: o.id } })).toBe(0)

    // Audited.
    const audit = await prisma.auditLog.findFirst({ where: { action: 'prebill.print', entityId: preBill.id } })
    expect(audit?.tenantId).toBe(tenantA)
    expect(audit?.userId).toBe(users['cashierA']!.id)
  })

  it('a card pre-bill headlines the card quote', async () => {
    const o = await ring('cashierA', conceptA, [NIHARI])
    const r = await print('cashierA', o.id, 'card')
    expect(r.statusCode, r.body).toBe(201)
    const card = (await call('cashierA', 'GET', `/pos/orders/${o.id}/quote?method=card`)).json()
    expect(r.json().preBill.totalCents).toBe(card.totalCents)
    expect(r.json().preBill.cardTotalCents).toBeNull()
    expect(r.json().receipt.tender).toBe('card')
  })

  it('waiters can print one too', async () => {
    const o = await ring('waiterA', conceptA, [KHEER])
    const r = await print('waiterA', o.id)
    expect(r.statusCode, r.body).toBe(201)
  })

  it('a reprint supersedes the earlier print; both stay', async () => {
    const o = await ring('cashierA', conceptA, [NIHARI])
    const first = (await print('cashierA', o.id)).json().preBill
    const second = (await print('cashierA', o.id)).json().preBill
    expect(second.number).toBe(first.number + 1)
    const rows = await prisma.preBill.findMany({ where: { orderId: o.id }, orderBy: { number: 'asc' } })
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'open'])
    expect(rows[0]!.statusAt).not.toBeNull()
  })

  it('numbers are per company and gap-free under 5 concurrent prints', async () => {
    const orders = await Promise.all([0, 1, 2].map(() => ring('cashierA', conceptA, [NIHARI])))
    const results = await Promise.all([
      print('cashierA', orders[0]!.id),
      print('cashierA', orders[1]!.id),
      print('waiterA', orders[2]!.id),
      print('cashierA', orders[0]!.id),
      print('waiterA', orders[1]!.id),
    ])
    for (const r of results) expect(r.statusCode, r.body).toBe(201)

    const a = await prisma.preBill.findMany({ where: { tenantId: tenantA }, select: { number: true }, orderBy: { number: 'asc' } })
    expect(a.map((p) => p.number)).toEqual(a.map((_, i) => i + 1))
    // Exactly one open pre-bill per order.
    for (const o of orders) {
      expect(await prisma.preBill.count({ where: { orderId: o.id, status: 'open' } })).toBe(1)
    }

    // Company B starts its own sequence at 1.
    const ob = await ring('cashierB', conceptB, [{ key: 'chapli', name: 'Chapli Burger', qty: 1, price: 90_000 }])
    const rb = await print('cashierB', ob.id)
    expect(rb.statusCode, rb.body).toBe(201)
    expect(rb.json().preBill.number).toBe(1)
    expect(rb.json().receipt.number).toBe('PB-1')
  })

  it('refuses a final order (ALREADY_FINAL) and a dead one (ORDER_NOT_OPEN)', async () => {
    const done = await ring('cashierA', conceptA, [KHEER])
    await prisma.order.update({ where: { id: done.id }, data: { status: 'completed', completedAt: new Date() } })
    const r1 = await print('cashierA', done.id)
    expect(r1.statusCode).toBe(409)
    expect(r1.json().error.code).toBe('ALREADY_FINAL')

    // Fully paid but not yet completed (e.g. still in the kitchen) is final too.
    const paid = await ring('cashierA', conceptA, [KHEER])
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: paid.id } })
    await prisma.payment.create({ data: { orderId: paid.id, method: 'cash', amountCents: stored.totalCents, status: 'paid', tenderedCents: stored.totalCents } })
    const r2 = await print('cashierA', paid.id)
    expect(r2.statusCode).toBe(409)
    expect(r2.json().error.code).toBe('ALREADY_FINAL')

    for (const status of ['cancelled', 'rejected', 'refunded'] as const) {
      const o = await ring('cashierA', conceptA, [KHEER])
      await prisma.order.update({ where: { id: o.id }, data: { status } })
      const r = await print('cashierA', o.id)
      expect(r.statusCode).toBe(409)
      expect(r.json().error.code).toBe('ORDER_NOT_OPEN')
    }
    expect(await prisma.preBill.count({ where: { orderId: done.id } })).toBe(0)
  })

  it('company B gets 404 on company A orders and pre-bills', async () => {
    const o = await ring('cashierA', conceptA, [NIHARI])
    const pb = (await print('cashierA', o.id)).json().preBill
    const r1 = await print('cashierB', o.id)
    expect(r1.statusCode).toBe(404)
    const r2 = await call('cashierB', 'GET', `/pos/pre-bills/${pb.id}/html`)
    expect(r2.statusCode).toBe(404)
    // Nothing was written for B.
    expect(await prisma.preBill.count({ where: { orderId: o.id } })).toBe(1)
  })

  it('validates the tender', async () => {
    const o = await ring('cashierA', conceptA, [NIHARI])
    const r = await call('cashierA', 'POST', `/pos/orders/${o.id}/pre-bill`, { tender: 'gift_card' })
    expect(r.statusCode).toBe(400)
  })

  it('a finance user (not a till role) cannot print', async () => {
    const o = await ring('cashierA', conceptA, [NIHARI])
    const r = await print('financeA', o.id)
    expect(r.statusCode).toBe(403)
  })
})

describe('the printable pre-bill', () => {
  it('prints PRE-BILL — NOT A TAX INVOICE, the PB number, no fiscal block; a re-render is a COPY', async () => {
    const o = await ring('cashierA', conceptA, [NIHARI, KHEER])
    const pb = (await print('cashierA', o.id)).json().preBill
    const r = await call('cashierA', 'GET', `/pos/pre-bills/${pb.id}/html`)
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toContain('text/html')
    expect(r.body).toContain('PRE-BILL — NOT A TAX INVOICE')
    expect(r.body).toContain(`PB-${pb.number}`)
    expect(r.body).toContain('If paid by card')
    expect(r.body).not.toMatch(/Fiscal invoice|SRB Invoice|FBR Invoice|FULL &amp; FINAL BILL<\/div>/)
    expect(r.body).not.toContain('COPY')

    const again = await call('waiterA', 'GET', `/pos/pre-bills/${pb.id}/html`)
    expect(again.statusCode).toBe(200)
    expect(again.body).toContain('COPY')
    expect(await prisma.auditLog.count({ where: { action: 'prebill.render', entityId: pb.id } })).toBe(2)
  })

  it('escapes user text', async () => {
    const o = await ring('cashierA', conceptA, [NIHARI])
    await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { name: '<script>x</script>' } })
    const pb = (await print('cashierA', o.id)).json().preBill
    const r = await call('cashierA', 'GET', `/pos/pre-bills/${pb.id}/html`)
    expect(r.body).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(r.body).not.toContain('<script>x</script>')
  })

  it('a part-paid order prints what is paid so far and the balance due — on the first print and on a COPY', async () => {
    const o = await ring('cashierA', conceptA, [NIHARI, KHEER])
    await prisma.payment.create({ data: { orderId: o.id, method: 'card', amountCents: 100_000, status: 'paid' } })
    const quote = (await call('cashierA', 'GET', `/pos/orders/${o.id}/quote?method=cash`)).json()
    expect(quote.paidCents).toBe(100_000)

    const r = await print('cashierA', o.id)
    expect(r.statusCode, r.body).toBe(201)
    const receipt = r.json().receipt as PreBillReceipt
    expect(receipt.paidCents).toBe(quote.paidCents)
    expect(receipt.dueCents).toBe(quote.dueCents)
    expect(receipt.dueCents).toBe(receipt.totalCents - 100_000)

    const pbId = r.json().preBill.id as string
    const html = await call('cashierA', 'GET', `/pos/pre-bills/${pbId}/html`)
    expect(html.body).toContain('Paid so far')
    expect(html.body).toContain('BALANCE DUE')
    // Part-paid → not re-priced, so there is no separate card total to show.
    expect(html.body).not.toContain('If paid by card')

    // A payment taken AFTER the print does not change the printed record.
    await prisma.payment.create({ data: { orderId: o.id, method: 'cash', amountCents: 20_000, status: 'paid', tenderedCents: 20_000 } })
    const copy = await call('cashierA', 'GET', `/pos/pre-bills/${pbId}/html`)
    expect(copy.body).toContain('COPY')
    expect(copy.body).toContain('BALANCE DUE')
    const again = (await call('cashierA', 'GET', `/pos/pre-bills/${pbId}/html`)).body
    expect(again).toBe(copy.body)

    // An unpaid order prints neither line.
    const unpaid = await ring('cashierA', conceptA, [NIHARI])
    const up = await print('cashierA', unpaid.id)
    expect((up.json().receipt as PreBillReceipt).paidCents).toBe(0)
    expect((up.json().receipt as PreBillReceipt).dueCents).toBe(up.json().preBill.totalCents)
    const upHtml = await call('cashierA', 'GET', `/pos/pre-bills/${up.json().preBill.id}/html`)
    expect(upHtml.body).not.toContain('Paid so far')
    expect(upHtml.body).not.toContain('BALANCE DUE')
  })
})

describe('lifecycle hooks', () => {
  it('converted: the open row converts; superseded rows carry the final total too', async () => {
    const o = await ring('cashierA', conceptA, [NIHARI])
    await print('cashierA', o.id)
    await print('cashierA', o.id)
    const at = new Date()
    const res = await prisma.$transaction((tx) => markPreBillsConvertedTx(tx, o.id, 123_456, at))
    expect(res).toEqual({ converted: 1, superseded: 1 })
    const rows = await prisma.preBill.findMany({ where: { orderId: o.id }, orderBy: { number: 'asc' } })
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'converted'])
    expect(rows.every((r) => r.finalTotalCents === 123_456 && r.finalAt?.getTime() === at.getTime())).toBe(true)
  })

  it('cancelled: open and superseded rows cancel with the approving manager', async () => {
    const o = await ring('cashierA', conceptA, [NIHARI])
    await print('cashierA', o.id)
    await print('cashierA', o.id)
    const res = await prisma.$transaction((tx) => markPreBillsCancelledTx(tx, o.id, users['mgrA']!.id, 'Guest walked out'))
    expect(res).toEqual({ cancelled: 2 })
    const rows = await prisma.preBill.findMany({ where: { orderId: o.id } })
    expect(rows.every((r) => r.status === 'cancelled' && r.cancelledById === users['mgrA']!.id && r.cancelReason === 'Guest walked out')).toBe(true)
  })

  it('a print racing the cancel never leaves an open pre-bill on the cancelled order', async () => {
    const o = await ring('cashierA', conceptA, [NIHARI])
    const first = (await print('cashierA', o.id)).json().preBill
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    // T1 = a print, exactly as createPreBill does it: lock the order,
    // supersede, insert a new open row — slowly.
    const t1 = prisma.$transaction(async (tx) => {
      await lockOrderTx(tx, o.id)
      await sleep(400)
      const [{ number }] = await tx.$queryRaw<Array<{ number: number }>>`
        INSERT INTO pre_bill_counters ("tenantId", "next") VALUES (${tenantA}, 2)
        ON CONFLICT ("tenantId") DO UPDATE SET "next" = pre_bill_counters."next" + 1
        RETURNING ("next" - 1)::int AS number`
      await tx.preBill.updateMany({ where: { orderId: o.id, status: 'open' }, data: { status: 'superseded', statusAt: new Date() } })
      return tx.preBill.create({
        data: {
          tenantId: tenantA, conceptId: conceptA, orderId: o.id, number, printedById: users['cashierA']!.id, tender: 'cash',
          lines: [], subtotalCents: first.subtotalCents, discountCents: 0, serviceChargeCents: 0, taxCents: first.taxCents, totalCents: first.totalCents,
        },
      })
    }, { timeout: 10_000 })
    // T2 = the cancel, started while T1 holds the order.
    await sleep(100)
    const t2 = prisma.$transaction(async (tx) => {
      const res = await markPreBillsCancelledTx(tx, o.id, users['mgrA']!.id, 'Walked out')
      await tx.order.update({ where: { id: o.id }, data: { status: 'cancelled' } })
      return res
    }, { timeout: 10_000 })
    const [, res] = await Promise.all([t1, t2])
    expect(res.cancelled).toBe(2)
    const rows = await prisma.preBill.findMany({ where: { orderId: o.id } })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'cancelled' && r.cancelledById === users['mgrA']!.id)).toBe(true)
  })
})

describe('Finance → Voided pre bills', () => {
  // Fresh company so the list holds only what these tests print.
  let tC: string, cC: string, cashierC: string
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    tC = (await prisma.tenant.create({ data: { name: 'Flags Co', slug: 'prebills-c' } })).id
    await ensureChartOfAccounts(tC)
    cC = (await prisma.concept.create({ data: { name: 'Flipd', slug: 'pb-flipd', type: 'restaurant', tenantId: tC, taxRate: 17, taxRateCash: 15, taxRateCard: 8 } })).id
    const cat = await prisma.category.create({ data: { conceptId: cC, name: 'Burgers' } })
    item['smash'] = (await prisma.menuItem.create({ data: { conceptId: cC, categoryId: cat.id, name: 'Smash', priceCents: 100_000 } })).id
    item['fries'] = (await prisma.menuItem.create({ data: { conceptId: cC, categoryId: cat.id, name: 'Fries', priceCents: 40_000 } })).id
    cashierC = (await mkUser('cashierC', 'cashier', tC)).id
    await mkUser('mgrC', 'foh_management', tC)
    await mkUser('financeC', 'finance', tC)
    await mkUser('ownerC', 'owner', tC)
    await mkUser('managementC', 'management', tC)
    await drawer('cashierC')

    const SMASH = { key: 'smash', name: 'Smash', qty: 1, price: 100_000 }
    const FRIES = { key: 'fries', name: 'Fries', qty: 1, price: 40_000 }

    // 1. Cancelled before FnF → ORPHANED.
    const cancelled = await ring('cashierC', cC, [SMASH])
    ids.cancelled = (await print('cashierC', cancelled.id)).json().preBill.id
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: cancelled.id }, data: { status: 'cancelled' } })
      await markPreBillsCancelledTx(tx, cancelled.id, users['mgrC']!.id, 'Guest left')
    })

    // 2. Converted lower than the pre-bill → FINAL_LOWER.
    const lower = await ring('cashierC', cC, [SMASH, FRIES])
    const lowerPb = (await print('cashierC', lower.id)).json().preBill
    ids.lower = lowerPb.id
    await prisma.payment.create({ data: { orderId: lower.id, method: 'card', amountCents: lowerPb.cardTotalCents - 10_000, status: 'paid' } })
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: lower.id }, data: { status: 'completed', completedAt: new Date() } })
      await markPreBillsConvertedTx(tx, lower.id, lowerPb.cardTotalCents - 10_000)
    })

    // 3. Converted at the card total (paid by card) → NOT lower.
    const byCard = await ring('cashierC', cC, [SMASH])
    const byCardPb = (await print('cashierC', byCard.id)).json().preBill
    ids.byCard = byCardPb.id
    await prisma.payment.create({ data: { orderId: byCard.id, method: 'card', amountCents: byCardPb.cardTotalCents, status: 'paid' } })
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: byCard.id }, data: { status: 'completed', completedAt: new Date() } })
      await markPreBillsConvertedTx(tx, byCard.id, byCardPb.cardTotalCents)
    })

    // 4. Still open, but its drawer closed → ORPHANED.
    const shiftClosed = await ring('cashierC', cC, [FRIES])
    ids.shiftClosed = (await print('cashierC', shiftClosed.id)).json().preBill.id
    const pbShift = await prisma.preBill.findUniqueOrThrow({ where: { id: ids.shiftClosed } })
    expect(pbShift.shiftId).not.toBeNull()
    await prisma.shift.update({ where: { id: pbShift.shiftId! }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
    await drawer('cashierC')

    // 5. A line voided after the print (manager-approved; on the new, open drawer) → LINE_VOIDS_AFTER.
    const voided = await ring('cashierC', cC, [SMASH, FRIES])
    ids.voided = (await print('cashierC', voided.id)).json().preBill.id
    const fries = voided.items.find((i) => i.name === 'Fries')!
    await new Promise((r) => setTimeout(r, 5))
    await prisma.orderItem.update({ where: { id: fries.id }, data: { status: 'voided', voidedAt: new Date(), voidReason: 'Cold' } })
    await prisma.auditLog.create({
      data: { category: 'identity', tenantId: tC, action: 'order_item_void', entity: 'OrderItem', entityId: fries.id, userId: cashierC, metadata: { orderId: voided.id, approverId: users['mgrC']!.id } },
    })

    // 6. Still open, drawer open, printed > 12 h ago → ORPHANED.
    const stale = await ring('cashierC', cC, [FRIES])
    ids.stale = (await print('cashierC', stale.id)).json().preBill.id
    await prisma.preBill.update({ where: { id: ids.stale }, data: { printedAt: new Date(Date.now() - ORPHAN_AFTER_MS - 60_000) } })

    // 7. Still open, fresh, drawer open → no flag.
    const fresh = await ring('cashierC', cC, [FRIES])
    ids.fresh = (await print('cashierC', fresh.id)).json().preBill.id

    // 8. Paid in CASH but completed at the card total (the PKR 1,150 → 1,080
    //    skim) → FINAL_LOWER, measured against the cash headline.
    const cashAtCard = await ring('cashierC', cC, [SMASH])
    const cashAtCardPb = (await print('cashierC', cashAtCard.id)).json().preBill
    ids.cashAtCard = cashAtCardPb.id
    await prisma.payment.create({ data: { orderId: cashAtCard.id, method: 'cash', amountCents: cashAtCardPb.cardTotalCents, status: 'paid', tenderedCents: cashAtCardPb.cardTotalCents } })
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: cashAtCard.id }, data: { status: 'completed', completedAt: new Date() } })
      await markPreBillsConvertedTx(tx, cashAtCard.id, cashAtCardPb.cardTotalCents)
    })

    // 9. Printed twice, then cancelled → two ORPHANED prints, ONE walk-out.
    const reprintCancel = await ring('cashierC', cC, [SMASH, FRIES])
    ids.reprintCancel1 = (await print('cashierC', reprintCancel.id)).json().preBill.id
    ids.reprintCancel2 = (await print('cashierC', reprintCancel.id)).json().preBill.id
    await prisma.$transaction(async (tx) => {
      await markPreBillsCancelledTx(tx, reprintCancel.id, users['mgrC']!.id, 'Guest left')
      await tx.order.update({ where: { id: reprintCancel.id }, data: { status: 'cancelled' } })
    })

    // 10. Printed twice, then one line voided → two LINE_VOIDS_AFTER prints, ONE void.
    const reprintVoid = await ring('cashierC', cC, [SMASH, FRIES])
    ids.reprintVoid1 = (await print('cashierC', reprintVoid.id)).json().preBill.id
    ids.reprintVoid2 = (await print('cashierC', reprintVoid.id)).json().preBill.id
    const rvFries = reprintVoid.items.find((i) => i.name === 'Fries')!
    await new Promise((r) => setTimeout(r, 5))
    await prisma.orderItem.update({ where: { id: rvFries.id }, data: { status: 'voided', voidedAt: new Date(), voidReason: 'Wrong order' } })
  }, 60_000)

  it('flags every pre-bill that needs a look, and only those', async () => {
    const l = await list('financeC')
    const flagsOf = (id: string) => l.rows.find((r) => r.id === id)?.flags
    expect(flagsOf(ids.cancelled!)).toEqual(['ORPHANED'])
    expect(flagsOf(ids.lower!)).toEqual(['FINAL_LOWER'])
    expect(flagsOf(ids.byCard!)).toEqual([])
    expect(flagsOf(ids.voided!)).toEqual(['LINE_VOIDS_AFTER'])
    expect(flagsOf(ids.shiftClosed!)).toEqual(['ORPHANED'])
    expect(flagsOf(ids.stale!)).toEqual(['ORPHANED'])
    expect(flagsOf(ids.fresh!)).toEqual([])
    expect(flagsOf(ids.cashAtCard!)).toEqual(['FINAL_LOWER'])
    expect(flagsOf(ids.reprintCancel1!)).toEqual(['ORPHANED'])
    expect(flagsOf(ids.reprintCancel2!)).toEqual(['ORPHANED'])
    expect(flagsOf(ids.reprintVoid1!)).toEqual(['LINE_VOIDS_AFTER'])
    expect(flagsOf(ids.reprintVoid2!)).toEqual(['LINE_VOIDS_AFTER'])
    expect(l.rows).toHaveLength(12)
  })

  it('names the cancelling manager, the voiding approver and the final difference', async () => {
    const l = await list('financeC')
    const cancelled = l.rows.find((r) => r.id === ids.cancelled)!
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelledBy).toBe('User mgrC')
    expect(cancelled.cancelReason).toBe('Guest left')
    expect(cancelled.orderStatus).toBe('cancelled')

    const voided = l.rows.find((r) => r.id === ids.voided)!
    expect(voided.lineVoidsAfter.count).toBe(1)
    expect(voided.lineVoidsAfter.cents).toBe(40_000)
    expect(voided.lineVoidsAfter.items[0]).toMatchObject({ name: 'Fries', approver: 'User mgrC', reason: 'Cold' })

    const lower = l.rows.find((r) => r.id === ids.lower)!
    expect(lower.differenceCents).toBe(lower.finalTotalCents! - lower.totalCents)
    expect(lower.differenceCents).toBeLessThan(0)
    expect(lower.printedBy).toBe('User cashierC')
    expect(lower.brand).toBe('Flipd')
    expect(lower.label).toBe(`PB-${lower.number}`)
    expect(lower.lines.map((x) => x.name).sort()).toEqual(['Fries', 'Smash'])
  })

  it('summarises the whole selection — prints and orders counted, money once per order', async () => {
    const l = await list('financeC')
    const row = (id: string) => l.rows.find((r) => r.id === id)!
    expect(l.summary.count).toBe(12)
    expect(l.summary.orders).toBe(10)
    // A reprint is not more money: each order's latest print, once.
    expect(l.summary.valueCents).toBe(
      l.rows.reduce((s, r) => s + r.totalCents, 0) - row(ids.reprintCancel1!).totalCents - row(ids.reprintVoid1!).totalCents,
    )
    expect(l.summary.orphaned.count).toBe(5)
    expect(l.summary.orphaned.orders).toBe(4)
    expect(l.summary.orphaned.cents).toBe(
      row(ids.cancelled!).totalCents + row(ids.shiftClosed!).totalCents + row(ids.stale!).totalCents + row(ids.reprintCancel2!).totalCents,
    )
    const cashAtCard = row(ids.cashAtCard!)
    expect(cashAtCard.cardTotalCents).toBeLessThan(cashAtCard.totalCents)
    expect(l.summary.finalLower).toEqual({ count: 2, orders: 2, diffCents: 10_000 + (cashAtCard.totalCents - cashAtCard.cardTotalCents!) })
    expect(l.summary.lineVoidsAfter).toEqual({ count: 3, orders: 2, cents: 40_000 + 40_000 })
  })

  it('filters: flagged only (totals unchanged), status, printed by, brand', async () => {
    const flagged = await list('financeC', '?flagged=1')
    expect(flagged.rows).toHaveLength(10)
    expect(flagged.summary.count).toBe(12)
    expect((await list('financeC', '?status=cancelled')).rows.map((r) => r.id).sort()).toEqual([ids.cancelled, ids.reprintCancel1, ids.reprintCancel2].sort())
    expect((await list('financeC', `?printedById=${users['mgrC']!.id}`)).rows).toHaveLength(0)
    expect((await list('financeC', `?conceptId=${cC}`)).rows).toHaveLength(12)
    expect(flagged.facets.concepts.map((c) => c.id)).toEqual([cC])
    expect(flagged.facets.printers.map((p) => p.id)).toEqual([cashierC])
  })

  it('a date range in the past shows nothing; a bad date is a 400', async () => {
    expect((await list('financeC', '?from=2020-01-01&to=2020-01-31')).rows).toHaveLength(0)
    const bad = await call('financeC', 'GET', '/pre-bills?from=2026-02-30')
    expect(bad.statusCode).toBe(400)
  })

  it('owner and management read it too; till roles do not', async () => {
    expect((await list('ownerC')).rows).toHaveLength(12)
    expect((await list('managementC')).rows).toHaveLength(12)
    expect((await call('cashierC', 'GET', '/pre-bills')).statusCode).toBe(403)
    expect((await call('mgrC', 'GET', '/pre-bills')).statusCode).toBe(403)
  })

  it('company separation: B never sees A; a foreign brand filter 404s; no company → nothing', async () => {
    const b = await list('financeB')
    expect(b.rows.every((r) => r.tenantId === tenantB)).toBe(true)
    expect(b.rows.length).toBeGreaterThan(0)
    const a = await list('financeA')
    expect(a.rows.every((r) => r.tenantId === tenantA)).toBe(true)
    expect(a.rows.some((r) => r.tenantId === tenantB)).toBe(false)
    const foreign = await call('financeB', 'GET', `/pre-bills?conceptId=${conceptA}`)
    expect(foreign.statusCode).toBe(404)
    const none = await list('nobody')
    expect(none.rows).toHaveLength(0)
    expect(none.facets.concepts).toHaveLength(0)
  })

  it('downloads the same rows as CSV', async () => {
    const r = await call('financeC', 'GET', '/pre-bills?format=csv&flagged=1')
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toContain('text/csv')
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="voided-pre-bills-.*\.csv"/)
    const lines = r.body.trim().split(/\r?\n/)
    expect(lines[0]).toContain('Pre-bill')
    expect(lines[0]).toContain('Flags')
    expect(lines).toHaveLength(1 + 10)
    expect(r.body).toContain('ORPHANED')
    expect(r.body).toContain('FINAL_LOWER')
    expect(r.body).toContain('LINE_VOIDS_AFTER')
    expect(r.body).toContain('User mgrC')
  })

  it('there is no way to delete, hide or edit a pre-bill', async () => {
    for (const method of ['DELETE', 'PATCH', 'PUT'] as const) {
      const r1 = await call('financeC', method, `/pre-bills/${ids.cancelled}`, {})
      expect(r1.statusCode).toBe(404)
      const r2 = await call('financeC', method, `/pos/pre-bills/${ids.cancelled}`, {})
      expect(r2.statusCode).toBe(404)
    }
    expect(await prisma.preBill.count({ where: { id: ids.cancelled } })).toBe(1)
  })
})
