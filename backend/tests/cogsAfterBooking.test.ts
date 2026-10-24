// Cost of sales once an order's cost is already booked (finance wave B, W2
// fixer — sale-01..07, ledger-cogs-*, ledger-fifo-align).
//
// An order's cost of sales is booked ONCE from its lot movements (its
// 'order.complete' entry, or a till ticket's home drawer 'shift.close'). Every
// stock event after that must move cost of sales itself, so that for each
// class the change in the GL inventory account equals the change in the lots:
//
//   - cancel after the home close: fired lines Dr 1290 (stock differences,
//     waiting for the CEO's approval into 5040 — H20) / Cr 50x0 (not 12x0),
//     unfired lines back to the lots with Dr 12x0 / Cr 50x0;
//   - a till void after the home close: the same, per line;
//   - "Box given" after completion: Dr 5030 / Cr 1230 under its own key; its
//     undo on a booked open ticket reverses it;
//   - a depletion that runs after the order was booked: 'order.cogs_late';
//   - a cancelled order never booked: the late-receipt settles of its
//     shortfalls come back out of cost of sales ('order.cancel_settle');
//   - a fully-short line voided before firing is never settled by a receipt;
//   - a repeated KDS recall of a recalled line books no second remake;
//   - a failed remake is flagged on its LINE, once per line, counting attempts;
//   - unbookedSalesCostByClass leaves out a ticket its home close booked.
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma, mkCompany, mkUser, openDrawer, type Company, type Who } from './connectorsFixtures.js'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import { ingestOrder, deductInventoryForOrder, cancelOrder, updateItemStatus, returnVoidedLineStockTx } from '../src/modules/orders/service.js'
import { markBoxGiven, flagOrderStockFailure } from '../src/modules/orders/stock.js'
import { wasteSoldLineTx } from '../src/modules/inventory/voidWaste.js'
import { unbookedSalesCostByClass } from '../src/modules/accounting/cogs.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { postOrderCompletion } from '../src/modules/accounting/orderPosting.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'

let A: Company
let mgr: Who
let beef: string
let box: string
let cola: string
let seq = 0
const DAY = 86_400_000
const CLASSES = [['food', '1210', '5010'], ['beverage', '1220', '5020'], ['packaging', '1230', '5030']] as const

async function lot(itemId: string, qty: number, unitCostCents: number, kind: 'count_gain' | 'receipt' = 'count_gain') {
  const src = `cab-lot-${++seq}-${randomUUID().slice(0, 6)}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: A.tenantId, inventoryItemId: itemId, qty, unitCostCents, kind,
    lotSourceType: kind === 'receipt' ? 'goods_receipt_line' : 'count_gain', lotSourceId: src,
    movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - (kind === 'receipt' ? 0 : 5 * DAY)),
  }))
}

/** GL net (debit − credit) of an account code in A. */
async function gl(code: string): Promise<number> {
  const ls = await prisma.journalLine.findMany({ where: { account: { tenantId: A.tenantId, code }, journalEntry: { tenantId: A.tenantId } }, select: { type: true, amountCents: true } })
  return ls.reduce((t, l) => t + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0)
}
async function lotValue(costClass: string): Promise<number> {
  const r = await prisma.stockLot.aggregate({ where: { tenantId: A.tenantId, costClass }, _sum: { remainingValueCents: true } })
  return Number(r._sum.remainingValueCents ?? 0)
}
type Snap = Record<string, number>
async function snap(): Promise<Snap> {
  const out: Snap = {}
  for (const [cls, inv, cogs] of CLASSES) {
    out[`lots:${cls}`] = await lotValue(cls)
    out[inv] = await gl(inv)
    out[cogs] = await gl(cogs)
  }
  out['5040'] = await gl('5040')
  // H20: waste waits in 1290 Stock Differences Suspense until the CEO approves it into 5040.
  out['1290'] = await gl('1290')
  return out
}
const delta = (a: Snap, b: Snap, k: string) => (b[k] ?? 0) - (a[k] ?? 0)
/** For every class: the GL inventory account moved exactly as the lots did (minus what came in outside the GL). */
function expectTies(a: Snap, b: Snap, outsideGl: Partial<Record<string, number>> = {}) {
  for (const [cls, inv] of CLASSES) expect(delta(a, b, inv), `${inv} vs ${cls} lots`).toBe(delta(a, b, `lots:${cls}`) - (outsideGl[cls] ?? 0))
}

async function ring(lines: Array<{ menuItemId: string; name: string; quantity?: number }>, opts: { fulfilment?: 'dine_in' | 'takeout'; source?: 'pos' | 'servd' } = {}) {
  const { order } = await ingestOrder({
    source: 'manual', external_id: randomUUID(), concept_id: A.conceptId, placed_at: new Date().toISOString(),
    customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
    fulfilment_type: opts.fulfilment ?? 'dine_in',
    items: lines.map((l) => ({ externalItemId: '', menuItemId: l.menuItemId, name: l.name, quantity: l.quantity ?? 1, unitPriceCents: 100_000, modifiers: [] })),
    payment: { provider: null, amountCents: 100_000 * lines.length, status: 'pending' },
  })
  await deductInventoryForOrder(order.id)
  if (opts.source) await prisma.order.update({ where: { id: order.id }, data: { source: opts.source } })
  const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } })
  return { id: order.id, items }
}

/** Part-pay a till ticket on a fresh drawer and post that drawer's close (it books the open ticket as a live sale). */
async function partPayAndClose(orderId: string, cents = 50_000): Promise<string> {
  const cashier = await mkUser(`cab-cashier-${++seq}`, 'cashier', A.tenantId)
  const shiftId = await openDrawer(A, cashier)
  await prisma.payment.create({ data: { orderId, shiftId, method: 'cash', amountCents: cents, status: 'paid', processedAt: new Date() } })
  await prisma.shift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: cents } })
  const r = await postShiftClose(shiftId)
  expect(r.posted).toBe(true)
  return shiftId
}

beforeAll(async () => {
  setFiscalKicker(async () => {})
  A = await mkCompany(`cab-a-${Date.now()}`)
  await prisma.setting.create({ data: { key: fifoCutoverKey(A.tenantId), value: new Date(Date.now() - 60 * DAY).toISOString() } })
  mgr = await mkUser('cab-mgr', 'foh_management', A.tenantId)
  beef = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Beef', unit: 'kg', category: 'protein' } })).id
  box = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Nihari box', unit: 'pcs', category: 'packaging' } })).id
  cola = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Cola', unit: 'pcs', category: 'beverage' } })).id
  await lot(beef, 100, 100_000)       // PKR 1,000 / kg
  await lot(box, 100, 3_000)
  await lot(cola, 100, 8_000)
  await prisma.recipe.create({
    data: {
      kind: 'plate', menuItemId: A.items.nihari, servings: 1, qFactorPct: 0,
      ingredients: { create: [{ inventoryItemId: beef, quantity: 150, unit: 'kg' }, { inventoryItemId: box, quantity: 1, unit: 'pcs', section: 'packaging' }] },
    },
  })
  await prisma.recipe.create({ data: { kind: 'plate', menuItemId: A.items.kheer, servings: 1, qFactorPct: 0, ingredients: { create: [{ inventoryItemId: cola, quantity: 1, unit: 'pcs' }] } } })
}, 60_000)

describe('a ticket whose home drawer close already booked its cost', () => {
  it('cancel: the fired line is wasted against cost of sales, the unfired one comes back out of it — GL ties to the lots', async () => {
    const s0 = await snap()
    const o = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 2 }, { menuItemId: A.items.kheer, name: 'Kheer' }], { source: 'pos' })
    const nihari = o.items.find((i) => i.menuItemId === A.items.nihari)!
    const kheer = o.items.find((i) => i.menuItemId === A.items.kheer)!
    await prisma.orderItem.update({ where: { id: nihari.id }, data: { status: 'bumped' } })
    await partPayAndClose(o.id)
    const s1 = await snap()
    expect(delta(s0, s1, '5010')).toBe(30_000)          // 0.3 kg beef booked by the close
    expect(delta(s0, s1, '5020')).toBe(8_000)
    expectTies(s0, s1)

    await cancelOrder(o.id, { reason: 'Walk-out', actor: { id: mgr.id, tenantId: A.tenantId }, approverId: mgr.id })
    const s2 = await snap()
    expectTies(s0, s2)
    expect(delta(s0, s2, '5010')).toBe(0)                // the close's food cost became waste
    expect(delta(s0, s2, '5020')).toBe(0)                // the cola went back on the shelf
    expect(delta(s0, s2, '1290')).toBe(30_000)          // waiting for the CEO (H20)
    expect(delta(s0, s2, '5040')).toBe(0)
    expect(delta(s0, s2, 'lots:beverage')).toBe(0)
    const ret = await prisma.journalEntry.findFirst({ where: { tenantId: A.tenantId, reference: `order_item.return:${kheer.id}` }, include: { lines: { include: { account: true } } } })
    expect(ret?.lines.map((l) => [l.account.code, l.type, Number(l.amountCents), l.conceptId]).sort()).toEqual([
      ['1220', 'debit', 8_000, A.conceptId], ['5020', 'credit', 8_000, A.conceptId],
    ].sort())
    // Not cancelled-and-never-booked: no settle entry.
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: `order.cancel_settle:${o.id}` } })).toBe(0)
  })

  it('void: a fired and an unfired line voided after the close tie the same way', async () => {
    const s0 = await snap()
    const o = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }, { menuItemId: A.items.kheer, name: 'Kheer' }], { source: 'pos' })
    const nihari = o.items.find((i) => i.menuItemId === A.items.nihari)!
    const kheer = o.items.find((i) => i.menuItemId === A.items.kheer)!
    await prisma.orderItem.update({ where: { id: nihari.id }, data: { status: 'bumped' } })
    await partPayAndClose(o.id)
    await prisma.orderItem.updateMany({ where: { id: { in: [nihari.id, kheer.id] } }, data: { status: 'voided', voidedAt: new Date() } })
    const r = await prisma.$transaction(async (tx) => ({
      ret: await returnVoidedLineStockTx(tx, { orderId: o.id, tenantId: A.tenantId, line: { id: kheer.id, quantity: 1 }, actorId: mgr.id }),
      waste: await wasteSoldLineTx(tx, { orderId: o.id, tenantId: A.tenantId, line: { id: nihari.id }, wasteReason: 'void_after_fire', actorId: mgr.id, conceptId: A.conceptId }),
    }))
    expect(r.ret.cogsFixFailure).toBeNull()
    expect(r.waste.postingError).toBeUndefined()
    const s1 = await snap()
    expectTies(s0, s1)
    expect(delta(s0, s1, '5010')).toBe(0)
    expect(delta(s0, s1, '5020')).toBe(0)
    expect(delta(s0, s1, '1290')).toBe(15_000)
    expect(delta(s0, s1, '5040')).toBe(0)
    const waste = await prisma.journalEntry.findFirst({ where: { tenantId: A.tenantId, reference: `pos.void_waste:${nihari.id}` }, include: { lines: { include: { account: true } } } })
    expect(waste?.lines.filter((l) => l.type === 'credit').map((l) => l.account.code)).toEqual(['5010'])
  })

  it('a void BEFORE the close posts no cost-of-sales fix: the close nets it', async () => {
    const s0 = await snap()
    const o = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }, { menuItemId: A.items.kheer, name: 'Kheer' }], { source: 'pos' })
    const kheer = o.items.find((i) => i.menuItemId === A.items.kheer)!
    await prisma.orderItem.update({ where: { id: kheer.id }, data: { status: 'voided', voidedAt: new Date() } })
    await prisma.$transaction((tx) => returnVoidedLineStockTx(tx, { orderId: o.id, tenantId: A.tenantId, line: { id: kheer.id, quantity: 1 } }))
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: `order_item.return:${kheer.id}` } })).toBe(0)
    await partPayAndClose(o.id)
    const s1 = await snap()
    expectTies(s0, s1)
    expect(delta(s0, s1, '5020')).toBe(0)
    expect(delta(s0, s1, '5010')).toBe(15_000)
  })

  it('"Box given" on an open ticket after its close books its own packaging cost; the undo reverses it', async () => {
    const s0 = await snap()
    const o = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], { source: 'pos' })
    await partPayAndClose(o.id)
    const line = o.items[0]!
    const tap = await markBoxGiven(line.id, { id: mgr.id, tenantIds: [A.tenantId] })
    expect(tap).toEqual({ boxGiven: true, depleted: true })
    const s1 = await snap()
    expectTies(s0, s1)
    expect(delta(s0, s1, '5030')).toBe(3_000)
    const at = (await prisma.orderItem.findUniqueOrThrow({ where: { id: line.id } })).boxGivenAt!
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: `order_item.box_given:${line.id}@${at.getTime()}` } })).toBe(1)

    await markBoxGiven(line.id, { id: mgr.id, tenantIds: [A.tenantId] }, { undo: true })
    const s2 = await snap()
    expectTies(s0, s2)
    expect(delta(s0, s2, '5030')).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: `order_item.box_given_undo:${line.id}@${at.getTime()}` } })).toBe(1)
  })
})

describe('an online order completed before its leftovers are boxed', () => {
  it('"Box given" after order.complete: Dr 5030 / Cr 1230 under the tap\'s own key, once', async () => {
    const s0 = await snap()
    const o = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], { source: 'servd' })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'completed', completedAt: new Date() } })
    expect((await postOrderCompletion(o.id)).posted).toBe(true)
    await markBoxGiven(o.items[0]!.id, { id: mgr.id, tenantIds: [A.tenantId] })
    await markBoxGiven(o.items[0]!.id, { id: mgr.id, tenantIds: [A.tenantId] })      // a second tap writes nothing
    const s1 = await snap()
    expectTies(s0, s1)
    expect(delta(s0, s1, '5030')).toBe(3_000)
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: { startsWith: `order_item.box_given:${o.items[0]!.id}@` } } })).toBe(1)
  })

  it('a depletion that runs after the order was booked books its cost late (order.cogs_late)', async () => {
    const s0 = await snap()
    const order = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'servd', status: 'completed', completedAt: new Date(), totalCents: 100_000, fulfilmentType: 'takeout',
        items: { create: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 100_000, serviceVessel: 'plate' }] },
      },
    })
    expect((await postOrderCompletion(order.id)).posted).toBe(true)        // no movements yet: no cost
    await deductInventoryForOrder(order.id)                                   // the re-run once fixed
    const s1 = await snap()
    expectTies(s0, s1)
    expect(delta(s0, s1, '5010')).toBe(15_000)
    expect(delta(s0, s1, '5030')).toBe(3_000)
    const claim = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'Order', entityId: order.id, action: 'stock.sale_deplete' } })
    expect((claim.metadata as { lateCogs?: Record<string, number> }).lateCogs).toEqual({ food: 15_000, beverage: 0, packaging: 3_000 })
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: `order.cogs_late:${order.id}` } })).toBe(1)
  })
})

describe('a shortfall settled by a late receipt, then the order is cancelled (never booked)', () => {
  async function saffronDish() {
    const saffron = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: `Saffron ${++seq}`, unit: 'kg', category: 'dry_goods' } })).id
    await lot(saffron, 0.1, 1_000_000)
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })
    const dish = (await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: `Saffron rice ${seq}`, priceCents: 100_000 } })).id
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: dish, servings: 1, ingredients: { create: [{ inventoryItemId: saffron, quantity: 200, unit: 'kg' }] } } })
    return { saffron, dish }
  }

  for (const fired of [false, true]) {
    it(`${fired ? 'fired' : 'unfired'}: the settle's cost of sales comes back out (order.cancel_settle) — GL ties to the lots`, async () => {
      const { saffron, dish } = await saffronDish()
      const s0 = await snap()
      const o = await ring([{ menuItemId: dish, name: 'Saffron rice' }])
      if (fired) await prisma.orderItem.update({ where: { id: o.items[0]!.id }, data: { status: 'bumped' } })
      await lot(saffron, 1, 1_200_000, 'receipt')                        // settles 0.1 kg (PKR 1,200): Dr 5010 / Cr 1210
      const settled = await prisma.stockMovement.findMany({ where: { orderId: o.id, kind: 'shortfall_settle' } })
      expect(settled.reduce((t, m) => t + Number(m.valueCents), 0)).toBe(-120_000)
      await cancelOrder(o.id, { reason: 'Out of rice', actor: { id: mgr.id, tenantId: A.tenantId } })
      const s1 = await snap()
      // The receipt's lot came in outside the GL here (its receiving entry is not part of this test).
      expectTies(s0, s1, { food: 1_200_000 })
      expect(delta(s0, s1, '5010')).toBe(0)
      expect(delta(s0, s1, '1290')).toBe(fired ? 220_000 : 0)
      expect(delta(s0, s1, '5040')).toBe(0)
      const je = await prisma.journalEntry.findFirst({ where: { tenantId: A.tenantId, reference: `order.cancel_settle:${o.id}` }, include: { lines: { include: { account: true } } } })
      expect(je?.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1210', 'debit', 120_000], ['5010', 'credit', 120_000]].sort())
    })
  }

  it('a fully-short line voided before firing is never settled by the next receipt', async () => {
    const pepper = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: `Pepper ${++seq}`, unit: 'kg', category: 'dry_goods' } })).id
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })
    const dish = (await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: `Pepper steak ${seq}`, priceCents: 100_000 } })).id
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: dish, servings: 1, ingredients: { create: [{ inventoryItemId: pepper, quantity: 200, unit: 'kg' }] } } })
    await lot(pepper, 1, 10_000)
    await prisma.stockLot.updateMany({ where: { inventoryItemId: pepper }, data: { remainingQty: 0, remainingValueCents: 0 } })
    await prisma.inventoryItem.update({ where: { id: pepper }, data: { currentStock: 0 } })
    await prisma.stockBalance.updateMany({ where: { inventoryItemId: pepper }, data: { qty: 0 } })   // the per-site cache too (stock by site, 2026-10-24)
    const o = await ring([{ menuItemId: dish, name: 'Pepper steak', quantity: 2 }])
    const line = o.items[0]!
    await prisma.orderItem.update({ where: { id: line.id }, data: { status: 'voided', voidedAt: new Date() } })
    const r = await prisma.$transaction((tx) => returnVoidedLineStockTx(tx, { orderId: o.id, tenantId: A.tenantId, line: { id: line.id, quantity: 2 } }))
    expect(r.skipped).toBe('nothing_taken')
    await lot(pepper, 10, 10_000, 'receipt')
    expect(await prisma.stockMovement.count({ where: { orderItemId: line.id, kind: 'shortfall_settle' } })).toBe(0)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: pepper } })).currentStock).toBeCloseTo(10, 6)
  })
})

describe('KDS remake', () => {
  it('a repeated recall of a line that is already recalled books no second remake', async () => {
    const o = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], { fulfilment: 'takeout' })
    const line = o.items[0]!
    await prisma.orderItem.update({ where: { id: line.id }, data: { status: 'bumped' } })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'ready' } })
    await updateItemStatus(line.id, 'recalled', mgr.id)
    await updateItemStatus(line.id, 'recalled', mgr.id)        // double tap / resend
    const logs = await prisma.wasteLog.findMany({ where: { orderItemId: line.id, reason: 'remake' } })
    expect(logs).toHaveLength(1)
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: { in: logs.map((l) => `inventory.waste:${l.id}`) } } })).toBe(1)
  })

  it('a failed remake is flagged on its line — once per line, counting attempts', async () => {
    const o = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }, { menuItemId: A.items.kheer, name: 'Kheer' }])
    const [l1, l2] = o.items
    await flagOrderStockFailure(o.id, 'remake', new Error('STOCK_NOT_ON_LOTS'), mgr.id, l1!.id)
    await flagOrderStockFailure(o.id, 'remake', new Error('STOCK_NOT_ON_LOTS'), mgr.id, l2!.id)
    await flagOrderStockFailure(o.id, 'remake', new Error('STOCK_NOT_ON_LOTS again'), mgr.id, l1!.id)
    const flags = await prisma.exceptionFlag.findMany({ where: { kind: 'stock_restore_failed', entityType: 'OrderItem', entityId: { in: [l1!.id, l2!.id] } } })
    expect(flags).toHaveLength(2)
    const m1 = flags.find((f) => f.entityId === l1!.id)!.metadata as Record<string, unknown>
    expect(m1).toMatchObject({ phase: 'remake', orderId: o.id, orderItemId: l1!.id, failures: 2 })
    expect(flags.every((f) => f.tenantId === A.tenantId)).toBe(true)
  })
})

describe('unbooked sales cost (the FIFO alignment\'s reconciling item)', () => {
  it('leaves out an open ticket once its home drawer close has booked it, and a completed one with a later payment on an open drawer', async () => {
    const before = await unbookedSalesCostByClass(prisma, A.tenantId)
    const o = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], { source: 'pos' })
    const open = await unbookedSalesCostByClass(prisma, A.tenantId)
    expect(open.food - before.food).toBe(15_000)
    await partPayAndClose(o.id)
    const after = await unbookedSalesCostByClass(prisma, A.tenantId)
    expect(after.food - before.food).toBe(0)

    // Completed, with its last payment on a drawer still open: its home close booked it.
    const cashier = await mkUser(`cab-cashier-${++seq}`, 'cashier', A.tenantId)
    const s2 = await openDrawer(A, cashier)
    await prisma.payment.create({ data: { orderId: o.id, shiftId: s2, method: 'cash', amountCents: 50_000, status: 'paid', processedAt: new Date() } })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'completed', completedAt: new Date() } })
    const done = await unbookedSalesCostByClass(prisma, A.tenantId)
    expect(done.food - before.food).toBe(0)
  })
})
