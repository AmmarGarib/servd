// Non-food stock items (owner, 2026-11-03: "want to use this system for non food purposes. create other categories
// like packaging and non food"; "Expense on receipt"). Category 'non_food' (cleaning, stationery, gas …):
//   - a receipt (PO or dock) books Dr 6045 Operating Supplies / Cr 2015 GRNI — never a 12x0, never 50x0;
//   - the lot (class 'non_food') is issued at once: no stock value, no issue entry;
//   - bought with petty cash: Dr 6045 / Cr 1011;
//   - a bill priced above the receipt: the difference to 6045, never 5060;
//   - never in the food-cost report, the variance, or a recipe; never counted, wasted or shipped;
//   - an item holding stock (or on a recipe) cannot become non-food; becoming non-food makes it issue-on-receipt;
//   - company separation: B's lots and entries are untouched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { createBill } from '../src/modules/procurement/service.js'
import { consumeFifoTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { recordPettyCashSpendTx } from '../src/modules/trustops/pettyCash.js'
import { foodCostSummary, ingredientVariance } from '../src/modules/reports/foodCost.js'
import { moveItemLotsToCategoryTx } from '../src/modules/inventory/routes.js'
import { lotClassOf, costClassOf, isNonFoodCategory, normalizeInventoryCategory, INVENTORY_CATEGORIES } from '../src/lib/inventoryClass.js'

const P = `nf${Date.now()}`
const T: Record<'A' | 'B', string> = { A: '', B: '' }
let ceo = '', fin = ''
let supA = '', supB = '', soap = '', gas = '', flour = '', soapB = '', locA = '', boxA = ''
const FROM = new Date(Date.now() - 86_400_000)
const TO = new Date(Date.now() + 86_400_000)

async function entryLines(reference: string, tenantId = T.A) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je ? je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort() : null
}
async function netDebit(tenantId: string, code: string): Promise<number> {
  const acct = await prisma.account.findFirstOrThrow({ where: { tenantId, code } })
  const sums = await prisma.journalLine.groupBy({ by: ['type'], where: { accountId: acct.id }, _sum: { amountCents: true } })
  return Number(sums.find((s) => s.type === 'debit')?._sum.amountCents ?? 0) - Number(sums.find((s) => s.type === 'credit')?._sum.amountCents ?? 0)
}
const dock = (supplierId: string, lines: Array<{ item: string; qty: number; cost: number }>, locationId: string | null = locA) => receiveGoods({
  actor: { id: ceo, role: 'admin' }, supplierId, locationId, photoUrl: 'https://example.com/dock.jpg',
  lines: lines.map((l) => ({ inventoryItemId: l.item, quantityReceived: l.qty, unitCostCents: l.cost })),
})

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'NonFood A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'NonFood B', slug: `${P}-b` } })).id
  for (const t of [T.A, T.B]) { await ensureChartOfAccounts(t); await ensureFifoReady(t) }
  invalidateSetupCache()
  const mk = async (key: string, role: string) => (await prisma.user.create({
    data: { name: `${P} ${key}`, email: `${P}.${key}@nf.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, tenantId: T.A, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: [{ tenant: { connect: { id: T.A } }, role: 'member' }] } },
  })).id
  ceo = await mk('ceo', 'admin')
  fin = await mk('fin', 'finance')
  supA = (await prisma.supplier.create({ data: { name: `${P} Metro`, tenantId: T.A, paymentTermsDays: 0, filerStatus: 'filer' } })).id
  supB = (await prisma.supplier.create({ data: { name: `${P} B Mart`, tenantId: T.B, paymentTermsDays: 0, filerStatus: 'filer' } })).id
  locA = (await prisma.location.create({ data: { slug: `${P}-la`, name: 'NF outlet', tenantId: T.A } })).id
  soap = (await prisma.inventoryItem.create({ data: { name: `${P} Soap`, unit: 'pcs', tenantId: T.A, category: 'non_food', currentStock: 0 } })).id
  // Gas is non-food WITHOUT the issue-on-receipt flag set: the ledger issues it anyway.
  gas = (await prisma.inventoryItem.create({ data: { name: `${P} Gas cylinder`, unit: 'pcs', tenantId: T.A, category: 'non_food', issueOnReceipt: false, currentStock: 0 } })).id
  flour = (await prisma.inventoryItem.create({ data: { name: `${P} Flour`, unit: 'kg', tenantId: T.A, category: 'flour_grain', currentStock: 0 } })).id
  soapB = (await prisma.inventoryItem.create({ data: { name: `${P} B Soap`, unit: 'pcs', tenantId: T.B, category: 'non_food', currentStock: 0 } })).id
  boxA = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'NF box', custodianId: fin, floatCents: 0 } })).id
}, 120_000)

afterAll(() => { invalidateSetupCache() })

describe('the category', () => {
  it('non_food is on the one list, is not a stock cost class, and takes the lot class non_food', () => {
    expect(INVENTORY_CATEGORIES).toContain('non_food')
    expect(normalizeInventoryCategory('Non-Food')).toBe('non_food')
    expect(isNonFoodCategory('non_food')).toBe(true)
    expect(isNonFoodCategory('packaging')).toBe(false)
    expect(lotClassOf('non_food')).toBe('non_food')
    expect(lotClassOf('packaging')).toBe('packaging')
    expect(costClassOf('packaging')).toBe('packaging')
  })

  it('6045 Operating Supplies is in every company\'s chart', async () => {
    for (const t of [T.A, T.B]) expect(await prisma.account.findFirst({ where: { tenantId: t, code: '6045', type: 'expense' } })).not.toBeNull()
  })
})

describe('expensed on receipt', () => {
  it('a dock receipt books Dr 6045 for non-food and Dr 1210 for food, all against 2015; the non-food lot holds nothing', async () => {
    const r = await dock(supA, [{ item: soap, qty: 10, cost: 150 }, { item: gas, qty: 2, cost: 250_000 }, { item: flour, qty: 5, cost: 400 }])
    expect(await entryLines(`procurement.receipt:${r.receipt.id}`)).toEqual([
      ['1210', 'debit', 2_000], ['2015', 'credit', 503_500], ['6045', 'debit', 501_500],
    ])
    for (const id of [soap, gas]) {
      const lot = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: id } })
      expect(lot).toMatchObject({ costClass: 'non_food', remainingQty: 0, remainingValueCents: 0 })
      expect(await prisma.stockMovement.count({ where: { lotId: lot.id, kind: 'issue_on_receipt', costClass: 'non_food' } })).toBe(1)
      expect(await prisma.journalEntry.count({ where: { tenantId: T.A, reference: `inventory.issue_on_receipt:${lot.id}` } })).toBe(0)
      expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock).toBe(0)
    }
    expect(await netDebit(T.A, '5010')).toBe(0)
    expect(await netDebit(T.A, '1230')).toBe(0)
    expect(await netDebit(T.A, '1210')).toBe(2_000)
  })

  it('billed above the receipt price: the difference goes to 6045, never 5060', async () => {
    const r = await dock(supA, [{ item: soap, qty: 4, cost: 100 }])
    const line = r.receipt.lines[0]!
    const bill = await createBill({
      supplierId: supA, billNumber: `${P}-B1`, billDate: new Date().toISOString().slice(0, 10), createdBy: fin,
      lines: [{ receiptLineId: line.id, inventoryItemId: soap, description: 'Soap', quantity: 4, unitCostCents: 125 }],
    } as never)
    expect(await entryLines(`supplier.bill:${(bill as { id: string }).id}`)).toEqual([
      ['2010', 'credit', 500], ['2015', 'debit', 400], ['6045', 'debit', 100],
    ])
    expect(await netDebit(T.A, '5060')).toBe(0)
  })

  it('bought with petty cash: Dr 6045 / Cr 1011, a settled receipt, no stock', async () => {
    await prisma.pettyCashBox.update({ where: { id: boxA }, data: { floatCents: 10_000 } })
    const done = await prisma.$transaction((tx) => recordPettyCashSpendTx(tx, {
      box: { id: boxA }, amountCents: 900, reason: 'Soap from the corner shop', createdById: fin, actor: { id: fin, role: 'finance' }, stockAllowed: true,
      lines: [{ kind: 'stock', inventoryItemId: soap, quantity: 3, unit: 'pcs', amountCents: 900, description: 'Soap' }],
    }))
    expect(await entryLines(`pettycash.spend:${done.movementId}`)).toEqual([['1011', 'credit', 900], ['6045', 'debit', 900]])
    expect(done.lines[0]!.accountCode).toBe('6045')
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: soap } })).currentStock).toBe(0)
  })

  it('never counted, wasted or shipped: nothing to draw', async () => {
    await expect(prisma.$transaction((tx) => consumeFifoTx(tx, {
      tenantId: T.A, inventoryItemId: soap, qty: 1, kind: 'waste', sourceType: 'test', sourceId: `${P}-w`, clamp: false, locationId: null, occurredAt: new Date(),
    }))).rejects.toMatchObject({ code: 'NON_FOOD_NOT_STOCK', statusCode: 422 })
  })
})

describe('never food cost', () => {
  it('the food-cost report and the ingredient variance leave non-food out', async () => {
    const block = (await foodCostSummary(prisma, { tenantIds: [T.A], from: FROM, to: TO, revenueVisible: true }))[0]!
    expect(JSON.stringify(block)).not.toContain(`${P} Soap`)
    expect(JSON.stringify(block)).not.toContain(`${P} Gas`)
    const rows = await ingredientVariance(prisma, { tenantId: T.A, from: FROM, to: TO })
    const ids = rows.map((r) => r.inventoryItemId)
    expect(ids).not.toContain(soap)
    expect(ids).not.toContain(gas)
    expect(ids).toContain(flour)
  })
})

describe('changing a category', () => {
  it('an item holding stock cannot become non-food; one with none can, and becomes issue-on-receipt; nothing posts', async () => {
    const actor = { id: ceo, email: null }
    await expect(prisma.$transaction((tx) => moveItemLotsToCategoryTx(tx, { itemId: flour, itemName: 'Flour', tenantId: T.A, fromCategory: 'flour_grain', toCategory: 'non_food', actor })))
      .rejects.toMatchObject({ code: 'NON_FOOD_HAS_STOCK' })
    const mop = (await prisma.inventoryItem.create({ data: { name: `${P} Mop`, unit: 'pcs', tenantId: T.A, category: 'other', currentStock: 0 } })).id
    const before = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    await prisma.$transaction((tx) => moveItemLotsToCategoryTx(tx, { itemId: mop, itemName: 'Mop', tenantId: T.A, fromCategory: 'other', toCategory: 'non_food', actor }))
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: mop } })).issueOnReceipt).toBe(true)
    // …and back out of non-food moves nothing either.
    await prisma.$transaction((tx) => moveItemLotsToCategoryTx(tx, { itemId: soap, itemName: 'Soap', tenantId: T.A, fromCategory: 'non_food', toCategory: 'other', actor }))
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(before)
  })
})

describe('company separation', () => {
  it("B's non-food receipt books in B only; A's numbers are unchanged", async () => {
    const a6045 = await netDebit(T.A, '6045')
    // receiveGoods books in the SUPPLIER's company (the routes scope the caller first).
    const r = await dock(supB, [{ item: soapB, qty: 2, cost: 500 }], null)
    expect(r.receipt.tenantId).toBe(T.B)
    expect(await entryLines(`procurement.receipt:${r.receipt.id}`, T.B)).toEqual([['2015', 'credit', 1_000], ['6045', 'debit', 1_000]])
    expect(await netDebit(T.A, '6045')).toBe(a6045)
  })
})
