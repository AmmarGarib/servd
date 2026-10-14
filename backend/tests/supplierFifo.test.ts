// Supplier bills on FIFO lots (finance wave B) — procurement/service.ts createBill
// + accounting/supplierPosting.ts.
//
//   - A stock line needs a PO line or a receipt line: 422 STOCK_LINE_NEEDS_RECEIPT
//     ("receive it at the dock first"); a receipt line must be this
//     supplier's receipt of the same item (422 RECEIPT_LINE_MISMATCH); billing
//     more than arrived (and was ordered) is 422 OVER_BILLED.
//   - A line that is not stock books to its own 6xxx account (422
//     EXPENSE_ACCOUNT_REQUIRED without one, 422 NOT_AN_EXPENSE_CODE for a
//     balance-sheet code) — never 1210.
//   - Drinks and packaging are their own classes: received to 1220 / 1230, a
//     bill's price difference re-prices them there.
//   - A system supplier (Cash purchases) is never billed (422 SYSTEM_SUPPLIER);
//     a stock line's unit cost above INT4 is 422 AMOUNT_TOO_LARGE.
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { INT4_MAX_CENTS } from '../src/lib/money.js'
import { createBill } from '../src/modules/procurement/service.js'
import { receiveGoods, ensureCashPurchaseSupplier } from '../src/modules/procurement/receiving.js'

const RUN = Math.random().toString(36).slice(2, 8)
const PHOTO = 'https://example.com/dock.jpg'
let tenantA: string, supA: string, supA2: string, userId: string
let n = 0

const mkItem = async (name: string, category: string | null = null) =>
  (await prisma.inventoryItem.create({ data: { name: `${name} ${RUN}`, unit: 'kg', tenantId: tenantA, currentStock: 0, unitCostCents: 100, category } })).id
const dock = async (supplierId: string, item: string, qty: number, cost: number) =>
  (await receiveGoods({ actor: { id: userId, role: 'admin' }, supplierId, photoUrl: PHOTO, lines: [{ inventoryItemId: item, quantityReceived: qty, unitCostCents: cost }] })).receipt.lines[0]!.id
const bill = (supplierId: string, lines: Parameters<typeof createBill>[0]['lines']) =>
  createBill({ supplierId, billNumber: `SF-${++n}-${RUN}`, billDate: new Date().toISOString(), lines, createdBy: userId, actorRole: 'admin' })
async function entryOf(billId: string) {
  const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: tenantA, reference: `supplier.bill:${billId}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
  const out: Record<string, number> = {}
  for (const l of je.lines) out[l.account.code] = (out[l.account.code] ?? 0) + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents))
  return out
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'SF A', slug: `sf-a-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  invalidateSetupCache()
  userId = (await prisma.user.create({
    data: { name: 'sf ceo', email: `ceo.${RUN}@sf.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId: tenantA },
  })).id
  supA = (await prisma.supplier.create({ data: { name: `SF Foods ${RUN}`, tenantId: tenantA } })).id
  supA2 = (await prisma.supplier.create({ data: { name: `SF Other ${RUN}`, tenantId: tenantA } })).id
})

describe('stock lines bill what was received', () => {
  it('a stock line with neither a PO line nor a receipt line is 422 STOCK_LINE_NEEDS_RECEIPT; nothing saved', async () => {
    const flour = await mkItem('Flour')
    await expect(bill(supA, [{ inventoryItemId: flour, description: 'flour', quantity: 1, unitCostCents: 100 }]))
      .rejects.toMatchObject({ code: 'STOCK_LINE_NEEDS_RECEIPT', statusCode: 422, message: expect.stringMatching(/receive it at the dock first/) })
    expect(await prisma.supplierBill.count({ where: { supplierId: supA } })).toBe(0)
  })

  it('a receipt line of another supplier or another item is 422 RECEIPT_LINE_MISMATCH', async () => {
    const sugar = await mkItem('Sugar')
    const salt = await mkItem('Salt')
    const rl = await dock(supA2, sugar, 5, 200)
    await expect(bill(supA, [{ inventoryItemId: sugar, receiptLineId: rl, description: 'sugar', quantity: 5, unitCostCents: 200 }]))
      .rejects.toMatchObject({ code: 'RECEIPT_LINE_MISMATCH', statusCode: 422 })
    await expect(bill(supA2, [{ inventoryItemId: salt, receiptLineId: rl, description: 'salt', quantity: 5, unitCostCents: 200 }]))
      .rejects.toMatchObject({ code: 'RECEIPT_LINE_MISMATCH', statusCode: 422 })
  })

  it('billing a receipt line beyond what it received is 422 OVER_BILLED; what it received bills once', async () => {
    const rice = await mkItem('Rice')
    const rl = await dock(supA, rice, 4, 300)
    await expect(bill(supA, [{ inventoryItemId: rice, receiptLineId: rl, description: 'rice', quantity: 5, unitCostCents: 300 }]))
      .rejects.toMatchObject({ code: 'OVER_BILLED', statusCode: 422 })
    const ok = await bill(supA, [{ inventoryItemId: rice, receiptLineId: rl, description: 'rice', quantity: 4, unitCostCents: 300 }])
    expect(await entryOf(ok.id)).toMatchObject({ '2015': 1_200, '2010': -1_200 })
    await expect(bill(supA, [{ inventoryItemId: rice, receiptLineId: rl, description: 'rice again', quantity: 1, unitCostCents: 300 }]))
      .rejects.toMatchObject({ code: 'OVER_BILLED' })
  })

  it('a stock line\'s unit cost above INT4 is 422 AMOUNT_TOO_LARGE', async () => {
    const saffron = await mkItem('Saffron')
    const rl = await dock(supA, saffron, 1, 100)
    await expect(bill(supA, [{ inventoryItemId: saffron, receiptLineId: rl, description: 'saffron', quantity: 1, unitCostCents: INT4_MAX_CENTS + 1 }]))
      .rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE', statusCode: 422 })
  })
})

describe('lines that are not stock book to their own expense account', () => {
  it('a 6xxx line: Dr 6040, never 1210', async () => {
    const b = await bill(supA, [{ description: 'Degreaser', quantity: 2, unitCostCents: 1_500, expenseAccountCode: '6040' }])
    expect(await entryOf(b.id)).toEqual({ '6040': 3_000, '2010': -3_000 })
    expect((await prisma.supplierBillLine.findFirstOrThrow({ where: { billId: b.id } })).expenseAccountCode).toBe('6040')
  })

  it('no account → 422 EXPENSE_ACCOUNT_REQUIRED; a balance-sheet code → 422 NOT_AN_EXPENSE_CODE', async () => {
    await expect(bill(supA, [{ description: 'Degreaser', quantity: 1, unitCostCents: 100 }]))
      .rejects.toMatchObject({ code: 'EXPENSE_ACCOUNT_REQUIRED', statusCode: 422 })
    await expect(bill(supA, [{ description: 'Degreaser', quantity: 1, unitCostCents: 100, expenseAccountCode: '1210' }]))
      .rejects.toMatchObject({ code: 'NOT_AN_EXPENSE_CODE', statusCode: 422 })
  })
})

describe('drinks and packaging are their own classes', () => {
  it('received to 1220 / 1230; a bill above the receipt price re-prices them in their own account', async () => {
    const cola = await mkItem('Cola', 'beverage')
    const cups = await mkItem('Cups 12oz', 'packaging')
    const r = await receiveGoods({
      actor: { id: userId, role: 'admin' }, supplierId: supA, photoUrl: PHOTO,
      lines: [{ inventoryItemId: cola, quantityReceived: 10, unitCostCents: 500 }, { inventoryItemId: cups, quantityReceived: 100, unitCostCents: 20 }],
    })
    const [rlCola, rlCups] = [r.receipt.lines.find((l) => l.inventoryItemId === cola)!.id, r.receipt.lines.find((l) => l.inventoryItemId === cups)!.id]
    const receiptEntry = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: tenantA, reference: `procurement.receipt:${r.receipt.id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(receiptEntry.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1220', 'debit', 5_000], ['1230', 'debit', 2_000], ['2015', 'credit', 7_000]])
    const b = await bill(supA, [
      { inventoryItemId: cola, receiptLineId: rlCola, description: 'cola', quantity: 10, unitCostCents: 550 },
      { inventoryItemId: cups, receiptLineId: rlCups, description: 'cups', quantity: 100, unitCostCents: 22 },
    ])
    expect(await entryOf(b.id)).toEqual({ '2015': 7_000, '1220': 500, '1230': 200, '2010': -7_700 })
  })
})

describe('the system supplier', () => {
  it('Cash purchases is never billed (422 SYSTEM_SUPPLIER)', async () => {
    const cash = await prisma.$transaction((tx) => ensureCashPurchaseSupplier(tx, tenantA))
    await expect(bill(cash.id, [{ description: 'anything', quantity: 1, unitCostCents: 100, expenseAccountCode: '6040' }]))
      .rejects.toMatchObject({ code: 'SYSTEM_SUPPLIER', statusCode: 422 })
  })
})
