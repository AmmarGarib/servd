// The till's Reports (owner, 2026-10-22; reports/TILL_REPORTS.md):
//   GET /reports/till/catalog | /lookups | /run/:reportId
//   - company separation: company B's manager gets 404 on company A's brand
//     (run + lookups); lookups list only the caller's own rows
//   - correctness on seeded orders: menu item summary, payment summary by
//     method / settle by / order by, cashier sections + includeNoCharge,
//     No Charge picks only comped bills, settlement detail, tax collection
//   - money cells null for a non-financial reader; ?format=pdf answers a PDF
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { tillReportRoutes } from '../src/modules/reports/tillReportsRoutes.js'
import { orderRefOf } from '../src/lib/orderRef.js'

const P = `trp${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const C: Record<string, string> = {}
const tok: Record<string, string> = {}
const U: Record<string, string> = {}
const O: Record<string, string> = {}
const S: Record<string, string> = {}
const M: Record<string, string> = {}
const cats: string[] = []
let itemA = ''
let itemB = ''
const DAY = '2026-10-21'
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00.000+05:00`)

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@trp.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  tok[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
  U[key] = u.id
  return u.id
}
const get = (who: string, path: string) => app.inject({ method: 'GET', url: `/reports/till${path}`, headers: { authorization: `Bearer ${tok[who]}` } })
const run = (who: string, id: string, qs = '') => get(who, `/run/${id}?conceptIds=${C.A}&dateFrom=${DAY}&dateTo=${DAY}${qs}`)
type Section = { title: string | null; rows: Array<Record<string, unknown>>; totals: Record<string, unknown> | null }
const sectionsOf = (r: { json: () => unknown }) => (r.json() as { sections: Section[] }).sections

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'TRP A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'TRP B', slug: `${P}-b` } })).id
  C.A = (await prisma.concept.create({ data: { name: `${P} A`, slug: `${P}-ca`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} B`, slug: `${P}-cb`, type: 'restaurant', tenantId: T.B } })).id
  await mkUser('cashier1', 'cashier', T.A)
  await mkUser('cashier2', 'cashier', T.A)
  await mkUser('finA', 'finance', T.A)
  await mkUser('mgrA', 'manager', T.A)
  await mkUser('mgrB', 'manager', T.B)
  const mains = await prisma.category.create({ data: { conceptId: C.A!, name: 'Mains' } })
  const drinks = await prisma.category.create({ data: { conceptId: C.A!, name: 'Drinks' } })
  const bCat = await prisma.category.create({ data: { conceptId: C.B!, name: 'B Only' } })
  cats.push(mains.id, drinks.id, bCat.id)
  M.burger = (await prisma.menuItem.create({ data: { conceptId: C.A!, categoryId: mains.id, name: 'Burger', priceCents: 1000_00 } })).id
  M.cola = (await prisma.menuItem.create({ data: { conceptId: C.A!, categoryId: drinks.id, name: 'Cola', priceCents: 200_00 } })).id
  M.bItem = (await prisma.menuItem.create({ data: { conceptId: C.B!, categoryId: bCat.id, name: 'B Dish', priceCents: 500_00 } })).id
  S.s1 = (await prisma.shift.create({ data: { userId: U.cashier1!, tenantId: T.A, openedAt: at('09:00') } })).id
  S.s2 = (await prisma.shift.create({ data: { userId: U.cashier2!, tenantId: T.A, openedAt: at('09:05') } })).id
  S.sB = (await prisma.shift.create({ data: { userId: U.mgrB!, tenantId: T.B, openedAt: at('09:00') } })).id

  const mk = async (k: string, d: Record<string, unknown>, items: Array<{ m: string; name: string; qty: number; price: number }>) => {
    const o = await prisma.order.create({
      data: {
        conceptId: C.A!, source: 'pos', externalId: `${P}-${k}`, status: 'completed', placedAt: at('12:00'), completedAt: at('12:10'), ...d,
        items: { create: items.map((i) => ({ menuItemId: i.m, name: i.name, quantity: i.qty, unitPriceCents: i.price })) },
      } as never,
    })
    O[k] = o.id
  }
  // O1: cashier1, dine in, Burger ×2 + Cola, discount 200, GST 15% = 300 → 2,300 cash into cashier1's drawer.
  await mk('o1', { posStaffId: U.cashier1, totalCents: 2300_00, discountCents: 200_00, taxCents: 300_00, taxRatePct: 15, customerName: 'Ali Guest' },
    [{ m: M.burger!, name: 'Burger', qty: 2, price: 1000_00 }, { m: M.cola!, name: 'Cola', qty: 1, price: 200_00 }])
  // O2: rung by cashier2, takeaway, Burger, GST 8% = 80 → 1,080 card, paid into cashier1's drawer (settle by = cashier1).
  await mk('o2', { posStaffId: U.cashier2, fulfilmentType: 'takeout', totalCents: 1080_00, taxCents: 80_00, taxRatePct: 8, settlementChannel: 'keenu' },
    [{ m: M.burger!, name: 'Burger', qty: 1, price: 1000_00 }])
  // O3: No Charge — Cola ×2 comped.
  await mk('o3', { posStaffId: U.cashier1, totalCents: 400_00 }, [{ m: M.cola!, name: 'Cola', qty: 2, price: 200_00 }])
  // Not in the report: another day, a cancelled bill, company B's bill.
  await mk('other', { posStaffId: U.cashier1, totalCents: 1000_00, placedAt: at('12:00', '2026-10-20'), completedAt: at('12:10', '2026-10-20') }, [{ m: M.burger!, name: 'Burger', qty: 1, price: 1000_00 }])
  await mk('void', { posStaffId: U.cashier1, totalCents: 1000_00, status: 'cancelled', completedAt: null }, [{ m: M.burger!, name: 'Burger', qty: 1, price: 1000_00 }])
  await mk('ob', { conceptId: C.B, posStaffId: U.mgrB, totalCents: 500_00 }, [{ m: M.bItem!, name: 'B Dish', qty: 1, price: 500_00 }])
  await prisma.payment.createMany({
    data: [
      { orderId: O.o1!, method: 'cash', amountCents: 2300_00, status: 'paid', shiftId: S.s1, processedAt: at('12:10') },
      { orderId: O.o2!, method: 'card', amountCents: 1080_00, status: 'paid', shiftId: S.s1, processedAt: at('12:10') },
      { orderId: O.o3!, method: 'comp', amountCents: 400_00, status: 'paid', processedAt: at('12:10'), gatewayMeta: { comp: { kind: 'no_charge', reason: 'VIP guest', approverId: U.mgrA } } },
      { orderId: O.ob!, method: 'cash', amountCents: 500_00, status: 'paid', shiftId: S.sB, processedAt: at('12:10') },
    ],
  })
  // Stock: one item per company, one receipt each.
  itemA = (await prisma.inventoryItem.create({ data: { tenantId: T.A, name: `${P} Flour`, unit: 'kg' } })).id
  itemB = (await prisma.inventoryItem.create({ data: { tenantId: T.B, name: `${P} B Rice`, unit: 'kg' } })).id
  for (const [tenantId, inventoryItemId] of [[T.A!, itemA], [T.B!, itemB]]) {
    await prisma.stockMovement.create({
      data: { tenantId, inventoryItemId, kind: 'receipt', qty: 10, valueCents: 5000_00, unitCostCents: 500_00, costClass: 'food', sourceType: 'test', sourceId: `${P}-${inventoryItemId}`, occurredAt: at('08:00') },
    })
  }

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(tillReportRoutes, { prefix: '/reports/till' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  const orderIds = Object.values(O)
  await prisma.stockMovement.deleteMany({ where: { inventoryItemId: { in: [itemA, itemB] } } })
  await prisma.inventoryItem.deleteMany({ where: { id: { in: [itemA, itemB] } } })
  await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } })
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
  await prisma.shift.deleteMany({ where: { id: { in: Object.values(S) } } })
  await prisma.menuItem.deleteMany({ where: { id: { in: Object.values(M) } } })
  await prisma.category.deleteMany({ where: { id: { in: cats } } })
  await app?.close()
})

describe('catalog and lookups', () => {
  it('lists the groups; Payment Summary and City Ledger Detail sit in the back office group too', async () => {
    const r = await get('mgrA', '/catalog')
    expect(r.statusCode).toBe(200)
    const c = r.json() as { groups: Array<{ key: string; reportIds: string[] }>; reports: Array<{ id: string; groupBy: string[] | null }> }
    expect(c.groups.map((g) => g.key)).toEqual(['recommended', 'menu_item', 'sales', 'no_charge', 'stock', 'back_office'])
    const bo = c.groups.find((g) => g.key === 'back_office')!
    expect(bo.reportIds).toEqual(expect.arrayContaining(['payment_summary', 'city_ledger_detail', 'settlement_detail', 'tax_collection', 'fiscal', 'driver_deliveries']))
    expect(c.reports).toHaveLength(21)
    for (const g of c.groups) for (const id of g.reportIds) expect(c.reports.some((x) => x.id === id), id).toBe(true)
    expect(c.reports.find((x) => x.id === 'payment_summary')!.groupBy).toContain('settle_by')
  })

  it('lookups list only the caller’s rows; another company’s brand is 404', async () => {
    const a = (await get('mgrA', `/lookups?conceptIds=${C.A}&dateFrom=${DAY}&dateTo=${DAY}`)).json()
    expect(a.outlets.map((o: { id: string }) => o.id)).toContain(C.A)
    expect(a.outlets.map((o: { id: string }) => o.id)).not.toContain(C.B)
    expect(a.categories.map((x: { name: string }) => x.name).sort()).toEqual(['Drinks', 'Mains'])
    expect(a.menuItems.map((x: { id: string }) => x.id)).not.toContain(M.bItem)
    expect(a.users.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([U.cashier1, U.cashier2]))
    expect(a.users.map((x: { id: string }) => x.id)).not.toContain(U.mgrB)
    expect(a.terminals.map((x: { id: string }) => x.id)).toEqual([S.s1]) // s2 took no payment for these brands and has no outlet of theirs
    expect(a.terminals.map((x: { id: string }) => x.id)).not.toContain(S.sB)
    expect(a.items.map((x: { id: string }) => x.id)).toEqual([itemA])
    expect((await get('mgrB', `/lookups?conceptIds=${C.A}`)).statusCode).toBe(404)
    const b = (await get('mgrB', '/lookups')).json()
    expect(b.outlets.map((o: { id: string }) => o.id)).toEqual([C.B])
    expect(b.categories).toEqual([])
  })
})

describe('run', () => {
  it('company B gets 404 on company A’s brand; bad input is 400; unknown report 404', async () => {
    for (const id of ['sales_detail', 'tax_collection', 'fiscal', 'closing_stock', 'driver_efficiency']) {
      expect((await run('mgrB', id)).statusCode, id).toBe(404)
    }
    expect((await run('mgrB', 'sales_detail', '&format=pdf')).statusCode).toBe(404)
    expect((await run('finA', 'nope')).statusCode).toBe(404)
    expect((await run('finA', 'sales_detail', '&orderTypes=bogus')).statusCode).toBe(400)
    expect((await run('finA', 'sales_detail', '&users=not-an-id')).statusCode).toBe(400)
    expect((await get('finA', `/run/sales_detail?dateFrom=${DAY}&dateTo=${DAY}`)).statusCode).toBe(400)
    expect((await get('finA', `/run/sales_detail?conceptIds=${C.A}&dateFrom=2026-01-01&dateTo=2026-10-21`)).statusCode).toBe(400)
    // B's own report never shows A's bills.
    const b = sectionsOf(await get('mgrB', `/run/sales_detail?conceptIds=${C.B}&dateFrom=${DAY}&dateTo=${DAY}`))
    expect(b[0]!.rows.map((r) => r.orderNo)).toEqual([orderRefOf(O.ob!)])
    const bStock = sectionsOf(await get('mgrB', `/run/closing_stock?conceptIds=${C.B}&dateFrom=${DAY}&dateTo=${DAY}`))
    expect(bStock[0]!.rows.map((r) => r.item)).toEqual([`${P} B Rice`])
  })

  it('menu item sales summary: qty and value per item within category', async () => {
    const s = sectionsOf(await run('finA', 'menu_item_sales_summary'))
    const mains = s.find((x) => x.title === 'Mains')!
    expect(mains.rows).toEqual([expect.objectContaining({ item: 'Burger', qty: 3, grossCents: 3000_00 })])
    const all = s.find((x) => x.title === 'All categories')!
    expect(all.totals).toMatchObject({ qty: 6, grossCents: 3600_00, discountCents: 200_00, netCents: 3400_00, taxCents: 380_00 })
    // The category filter narrows the lines.
    const drinks = sectionsOf(await run('finA', 'menu_item_sales_summary', `&categories=${cats[1]}`))
    expect(drinks.find((x) => x.title === 'All categories')!.totals).toMatchObject({ qty: 3, grossCents: 600_00 })
  })

  it('sales detail lists the sold bills with receipt / user / payments; the search narrows', async () => {
    const s = sectionsOf(await run('finA', 'sales_detail'))
    expect(s[0]!.rows.map((r) => r.orderNo).sort()).toEqual([O.o1, O.o2, O.o3].map((id) => orderRefOf(id!)).sort())
    const o1 = s[0]!.rows.find((r) => r.orderNo === orderRefOf(O.o1!))!
    expect(o1).toMatchObject({ user: 'cashier1', guest: 'Ali Guest', items: 3, grossCents: 2200_00, discountCents: 200_00, taxCents: 300_00, totalCents: 2300_00, payments: 'Cash' })
    expect(sectionsOf(await run('finA', 'sales_detail', '&q=ali'))[0]!.rows).toHaveLength(1)
    expect(sectionsOf(await run('finA', 'sales_detail', `&users=${U.cashier2}`))[0]!.rows.map((r) => r.orderNo)).toEqual([orderRefOf(O.o2!)])
  })

  it('payment summary groups by method, settle by and order by', async () => {
    const byMethod = sectionsOf(await run('finA', 'payment_summary'))[0]!
    expect(Object.fromEntries(byMethod.rows.map((r) => [r.group, r.amountCents]))).toEqual({ Cash: 2300_00, 'Card – Keenu': 1080_00, Comp: 400_00 })
    const settle = sectionsOf(await run('finA', 'payment_summary', '&groupBy=settle_by'))[0]!
    expect(settle.rows).toEqual(expect.arrayContaining([{ group: 'cashier1', count: 2, amountCents: 3380_00 }, { group: 'No drawer', count: 1, amountCents: 400_00 }]))
    const orderBy = sectionsOf(await run('finA', 'payment_summary', '&groupBy=order_by'))[0]!
    expect(orderBy.rows).toEqual(expect.arrayContaining([{ group: 'cashier1', count: 2, amountCents: 2700_00 }, { group: 'cashier2', count: 1, amountCents: 1080_00 }]))
    const detail = sectionsOf(await run('finA', 'payment_summary', `&opts=detail&paymentMethods=cash`))
    expect(detail).toHaveLength(2)
    expect(detail[1]!.rows[0]).toMatchObject({ orderNo: orderRefOf(O.o1!), settleBy: 'cashier1', orderBy: 'cashier1' })
    expect((await run('finA', 'sales_detail', '&groupBy=settle_by')).statusCode).toBe(400)
  })

  it('cashier sales detail: a section per user, No Charge only when ticked', async () => {
    const s = sectionsOf(await run('finA', 'cashier_sales_detail'))
    expect(s.map((x) => x.title)).toEqual(['cashier1', 'cashier2', 'All users'])
    const line = (sec: Section, l: string) => sec.rows.find((r) => r.line === l)
    expect(line(s[0]!, 'Orders')!.count).toBe(1)
    expect(line(s[0]!, 'Gross sales (incl. GST)')!.amountCents).toBe(2300_00)
    expect(line(s[2]!, 'Orders')!.count).toBe(2)
    expect(line(s[2]!, 'Payments received')!.amountCents).toBe(3380_00)
    const withNc = sectionsOf(await run('finA', 'cashier_sales_detail', '&opts=includeNoCharge,orderType,payment,category,userWise'))
    expect(withNc.map((x) => x.title)).toEqual(['By user', 'cashier1', 'cashier2', 'All users'])
    const c1 = withNc[1]!
    expect(line(c1, 'Orders')!.count).toBe(2)
    expect(c1.rows.filter((r) => r.breakdown === 'Order type').map((r) => r.line).sort()).toEqual(['Dine In', 'No Charge'])
    expect(c1.rows.find((r) => r.breakdown === 'Payment' && r.line === 'Cash')!.amountCents).toBe(2300_00)
    expect(withNc[0]!.totals).toMatchObject({ orders: 3 })
  })

  it('No Charge reports pick only the comped bill', async () => {
    const d = sectionsOf(await run('finA', 'no_charge_item_detail'))[0]!
    expect(d.rows).toEqual([expect.objectContaining({ orderNo: orderRefOf(O.o3!), item: 'Cola', qty: 2, valueCents: 400_00, reason: 'VIP guest', approvedBy: 'mgrA' })])
    const sm = sectionsOf(await run('finA', 'no_charge_item_summary'))[0]!
    expect(sm.rows).toEqual([{ item: 'Cola', category: 'Drinks', qty: 2, valueCents: 400_00 }])
    // And the No Charge order type filter on a sales report.
    expect(sectionsOf(await run('finA', 'sales_detail', '&orderTypes=no_charge'))[0]!.rows.map((r) => r.orderNo)).toEqual([orderRefOf(O.o3!)])
    expect(sectionsOf(await run('finA', 'sales_detail', '&orderTypes=dine_in'))[0]!.rows.map((r) => r.orderNo)).toEqual([orderRefOf(O.o1!)])
  })

  it('settlement detail: each bill’s tenders and channel; No Charge only when ticked', async () => {
    const s = sectionsOf(await run('finA', 'settlement_detail'))[0]!
    expect(s.rows.map((r) => r.orderNo).sort()).toEqual([O.o1, O.o2].map((id) => orderRefOf(id!)).sort())
    expect(s.rows.find((r) => r.orderNo === orderRefOf(O.o1!))).toMatchObject({ cashCents: 2300_00, cardCents: 0, channel: 'Online / other', settleBy: 'cashier1' })
    expect(s.rows.find((r) => r.orderNo === orderRefOf(O.o2!))).toMatchObject({ cardCents: 1080_00, channel: 'Pushed to Keenu', orderBy: 'cashier2', settleBy: 'cashier1' })
    expect(s.totals).toMatchObject({ totalCents: 3380_00, cashCents: 2300_00, cardCents: 1080_00 })
    expect(sectionsOf(await run('finA', 'settlement_detail', '&opts=includeNoCharge'))[0]!.rows).toHaveLength(3)
    const sum = sectionsOf(await run('finA', 'settlement_summary'))
    expect(sum[0]!.rows.find((r) => r.tender === 'Cash')!.amountCents).toBe(2300_00)
    expect(sum[1]!.totals).toMatchObject({ orders: 2 })
  })

  it('tax collection splits GST at the cash rate and the card / Raast rate', async () => {
    const s = sectionsOf(await run('finA', 'tax_collection'))[0]!
    expect(s.rows).toEqual([expect.objectContaining({
      date: DAY, cashOrders: 1, cashTaxableCents: 2000_00, cashTaxCents: 300_00, cardOrders: 1, cardTaxableCents: 1000_00, cardTaxCents: 80_00, totalTaxCents: 380_00,
    })])
    const rates = sectionsOf(await run('finA', 'tax_analysis'))[0]!
    expect(Object.fromEntries(rates.rows.map((r) => [r.rate, r.taxCents]))).toEqual({ '15%': 300_00, '8%': 80_00 })
    const cat = sectionsOf(await run('finA', 'category_tax_collection'))[0]!
    expect(cat.totals).toMatchObject({ taxCents: 380_00 })
  })

  it('stock, city ledger, fiscal, drivers answer in scope', async () => {
    const st = sectionsOf(await run('finA', 'closing_stock'))[0]!
    expect(st.rows).toEqual([expect.objectContaining({ item: `${P} Flour`, qty: 10, valueCents: 5000_00 })])
    const led = sectionsOf(await run('finA', 'stock_ledger'))[0]!
    expect(led.rows).toEqual([expect.objectContaining({ item: `${P} Flour`, openingQty: 0, inQty: 10, outQty: 0, closingQty: 10 })])
    for (const id of ['stock_transfer_summary', 'city_ledger_detail', 'city_ledger_summary', 'fiscal', 'driver_efficiency', 'driver_deliveries', 'discount_detail', 'payment_detail']) {
      expect((await run('finA', id)).statusCode, id).toBe(200)
    }
    const disc = sectionsOf(await run('finA', 'discount_detail'))[0]!
    expect(disc.rows.map((r) => r.orderNo)).toEqual([orderRefOf(O.o1!)])
  })

  it('a non-financial reader gets counts, money cells null; pdf answers a PDF', async () => {
    const s = sectionsOf(await run('mgrA', 'payment_summary'))[0]!
    expect(s.rows.every((r) => r.amountCents === null)).toBe(true)
    expect(s.totals).toMatchObject({ count: 3, amountCents: null })
    const pdf = await run('finA', 'cashier_sales_detail', '&opts=payment&format=pdf')
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/)
    const csv = await run('finA', 'menu_item_sales_summary', '&format=csv')
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('Burger')
  })
})
