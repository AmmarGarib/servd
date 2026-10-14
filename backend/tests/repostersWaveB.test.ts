// Reconciliation → Backfill unposted: the finance wave B re-posters
// (reconciliation/backfillOrders.ts REPOSTERS + step 5).
//
// For each new kind a refused posting (a deactivated account; a closed month
// for the dated ones) is flagged by its LIVE path, then one backfill run posts
// it once — late-dated into the open month with a note (owner decision 6) when
// its own month is closed — and closes the flag; the next run finds nothing:
//   - inventory.prep_draw (ad-hoc prep batch), fixed_asset.depreciation (each
//     month late-dated on its own), prepaid.release (an OpEx prepayment — the
//     flag is on OpexPayment), giftcard.expire (multiPost: the card decides,
//     never the exact reference), ic.fleet_charge (refused for staff of one
//     company — FLEET_ASK_CEO, the flag stays open — posted by a CEO of both),
//     and the six cost-of-sales moves of an order's stock events
//     (order_item.box_given / _undo, order_item.return, order.cogs_late,
//     order.cancel_settle; order.legacy_return with nothing owed is closed);
//   - step 5: 'stock_restore_failed' flags re-run their once-only step
//     (deplete, restore, remake ×failures), and a cancelled order whose stock
//     is still out with no flag is swept ('unflagged' → 'flagged' → re-run);
//   - the unflagged sweep finds an ad-hoc prep draw nothing flagged;
//   - two companies: B's run never lists, posts or closes A's flags.
// Every journal entry this suite writes balances.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, openDrawer, type Company, type Who } from './connectorsFixtures.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import { backfillUnpostedOrders, type OrderBackfillRow } from '../src/modules/reconciliation/backfillOrders.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { flagPostingFailed, postJournalEntry } from '../src/modules/accounting/journal.js'
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import { chargeThrough } from '../src/modules/fixedAssets/service.js'
import { addMonths, currentPeriodPkt, endOfMonthPkt, startOfMonthPkt } from '../src/modules/fixedAssets/schedule.js'
import { releasePrepaidThrough } from '../src/modules/accounting/prepaidReleases.js'
import { expireOneGiftCard } from '../src/modules/giftCards/books.js'
import { chargeFleetMonth, FLEET_ASK_CEO } from '../src/modules/intercompany/fleet.js'
import { ingestOrder, deductInventoryForOrder, cancelOrder } from '../src/modules/orders/service.js'
import { markBoxGiven, flagOrderStockFailure, bookRemakeWaste } from '../src/modules/orders/stock.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { postOrderCompletion } from '../src/modules/accounting/orderPosting.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'

const DAY = 86_400_000
const cur = currentPeriodPkt()
const m = (k: number) => addMonths(cur, k)
const mid = (p: string) => new Date(startOfMonthPkt(p).getTime() + 14 * DAY + 12 * 3_600_000)
let app: FastifyInstance
let A: Company
let B: Company
let ceoAB: Who, ceoB: Who, finA: Who, chefA: Who, chefB: Who, mgrA: Who
let seq = 0
let beef = ''
let box = ''

/** Fixture ids, by what they are. */
const F: Record<string, string> = {}
let remakeLiveLogs = 0   // waste logs the live (successful) recall booked for F.remakeLive

const setActive = (tenantId: string, code: string, isActive: boolean) => prisma.account.updateMany({ where: { tenantId, code }, data: { isActive } })
async function refusing<T>(tenantId: string, code: string, fn: () => Promise<T>): Promise<T> {
  await setActive(tenantId, code, false)
  try { return await fn() } finally { await setActive(tenantId, code, true) }
}
const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

async function lot(co: Company, itemId: string, qty: number, unitCostCents: number, kind: 'count_gain' | 'receipt' = 'count_gain') {
  const src = `rpw-lot-${++seq}-${randomUUID().slice(0, 6)}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: co.tenantId, inventoryItemId: itemId, qty, unitCostCents, kind,
    lotSourceType: kind === 'receipt' ? 'goods_receipt_line' : 'count_gain', lotSourceId: src,
    movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - (kind === 'receipt' ? 0 : 5 * DAY)),
  }))
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
async function partPayAndClose(orderId: string, cents = 50_000): Promise<void> {
  const cashier = await mkUser(`rpw-cashier-${++seq}`, 'cashier', A.tenantId)
  const shiftId = await openDrawer(A, cashier)
  await prisma.payment.create({ data: { orderId, shiftId, method: 'cash', amountCents: cents, status: 'paid', processedAt: new Date() } })
  await prisma.shift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: cents } })
  expect((await postShiftClose(shiftId)).posted).toBe(true)
}

const openPostingFlag = (entityId: string, sourceType: string) => prisma.exceptionFlag.findFirst({
  where: { kind: 'posting_failed', entityId, status: { in: ['open', 'acknowledged'] }, metadata: { path: ['sourceType'], equals: sourceType } },
})
const openStockFlag = (entityId: string) => prisma.exceptionFlag.findFirst({
  where: { kind: 'stock_restore_failed', entityId, status: { in: ['open', 'acknowledged'] } },
})
const refCount = (tenantId: string, reference: string) => prisma.journalEntry.count({ where: { tenantId, reference } })

async function backfill(tenantIds: string[], dryRun: boolean, who: Who): Promise<OrderBackfillRow[]> {
  return (await backfillUnpostedOrders({ tenantIds, dryRun, postedBy: who.id, sweepFrom: new Date(Date.now() - 120 * DAY) })).rows
}
const rowOf = (rows: OrderBackfillRow[], kind: string, id: string) => rows.find((r) => r.kind === kind && r.id === id)

/** The (sourceType, entityId) of each refused posting this suite flags in A. */
const refused: Array<{ kind: string; key: string }> = []

beforeAll(async () => {
  setFiscalKicker(async () => {})
  A = await mkCompany(`rpw-a-${Date.now()}`)
  B = await mkCompany(`rpw-b-${Date.now()}`)
  for (const co of [A, B]) {
    await prisma.setting.create({ data: { key: fifoCutoverKey(co.tenantId), value: new Date(Date.now() - 200 * DAY).toISOString() } })
  }
  ceoAB = await mkUser('rpw-ceo-ab', 'admin', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: ceoAB.id } })
  ceoB = await mkUser('rpw-ceo-b', 'admin', B.tenantId)
  finA = await mkUser('rpw-fin-a', 'finance', A.tenantId)
  chefA = await mkUser('rpw-chef-a', 'boh_management', A.tenantId)
  chefB = await mkUser('rpw-chef-b', 'boh_management', B.tenantId)
  mgrA = await mkUser('rpw-mgr-a', 'foh_management', A.tenantId)

  beef = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Beef', unit: 'kg', category: 'protein' } })).id
  box = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Nihari box', unit: 'pcs', category: 'packaging' } })).id
  await lot(A, beef, 100, 100_000)
  await lot(A, box, 100, 3_000)
  await prisma.recipe.create({
    data: {
      kind: 'plate', menuItemId: A.items.nihari, servings: 1, qFactorPct: 0,
      ingredients: { create: [{ inventoryItemId: beef, quantity: 150, unit: 'kg' }, { inventoryItemId: box, quantity: 1, unit: 'pcs', section: 'packaging' }] },
    },
  })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(crosschecksRoutes, { prefix: '/crosschecks' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  const entries = await prisma.journalEntry.findMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] } }, include: { lines: { include: { account: { select: { tenantId: true } } } } } })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + Number(l.amountCents), 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + Number(l.amountCents), 0)
    expect({ ref: e.reference, d }).toEqual({ ref: e.reference, d: c })
    for (const l of e.lines) expect(l.account.tenantId).toBe(e.tenantId)
  }
  // Inter-company pair accounts must lose controlledBy before their company could go.
  await prisma.account.updateMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] }, controlledBy: 'intercompany' }, data: { controlledBy: null, counterpartyTenantId: null } })
  await app?.close()
})

describe('refused postings are flagged by their live paths', () => {
  it('inventory.prep_draw: an ad-hoc batch whose 5010 was off (in A and in B); one more with its flag gone (a miss)', async () => {
    for (const [co, chef, key] of [[A, chefA, 'prepA'], [B, chefB, 'prepB'], [A, chefA, 'prepMiss']] as const) {
      const herb = await prisma.inventoryItem.create({ data: { tenantId: co.tenantId, name: `Herbs ${++seq}`, unit: 'kg', category: 'produce', unitCostCents: 1_000 } })
      await lot(co, herb.id, 10, 5_000)
      const res = await refusing(co.tenantId, '5010', () => call(chef, 'POST', '/crosschecks/prep-batches', {
        itemName: 'Herb oil', actualYieldQty: 1, unit: 'kg', inputs: [{ inventoryItemId: herb.id, qtyDrawn: 2, unit: 'kg' }],
      }))
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json().ledger).toMatchObject({ posted: false })
      F[key] = res.json().id
      expect(await openPostingFlag(F[key]!, 'inventory.prep_draw')).toBeTruthy()
    }
    // A's batch is from a month that will be closed.
    await prisma.prepBatch.update({ where: { id: F.prepA }, data: { createdAt: mid(m(-2)) } })
    // The miss: nothing flags it any more (a crash before the flag, an old refusal).
    await prisma.exceptionFlag.deleteMany({ where: { entityId: F.prepMiss } })
    refused.push({ kind: 'inventory.prep_draw', key: F.prepA! })
  })

  it('fixed_asset.depreciation: the class accumulated account was off', async () => {
    await ensureAssetClasses(A.tenantId)
    const asset = await prisma.fixedAsset.create({
      data: {
        tenantId: A.tenantId, name: 'Combi oven', category: 'kitchen_equipment', assetTag: 'FA-RPW-1', acquiredAt: mid(m(-3)), inServiceAt: mid(m(-3)),
        costCents: 120_000, originalCostCents: 120_000, usefulLifeMonths: 12, conceptId: A.conceptId, locationId: A.locationId,
      },
    })
    F.asset = asset.id
    const run = await refusing(A.tenantId, '1591', () => chargeThrough(A.tenantId, m(-1), { postedBy: 'system' }))
    expect(run.failedCount).toBe(1)
    expect(await openPostingFlag(asset.id, 'fixed_asset.depreciation')).toMatchObject({ entityType: 'FixedAsset', tenantId: A.tenantId })
    refused.push({ kind: 'fixed_asset.depreciation', key: asset.id })
  })

  it("prepaid.release: an OpEx prepayment whose category's account was off (flag on OpexPayment)", async () => {
    const cat = await prisma.opexCategory.create({ data: { tenantId: A.tenantId, name: 'Kiosk rent', expenseAccountCode: '6030' } })
    const line = await prisma.opexLine.create({ data: { categoryId: cat.id, conceptId: A.conceptId, name: 'Kiosk rent — mall', amountCents: 60_000, cadence: 'quarterly' } })
    const paidAt = new Date(`${m(-2)}-02T12:00:00+05:00`)
    const p = await prisma.opexPayment.create({
      data: { lineId: line.id, periodStart: paidAt, periodEnd: paidAt, expectedCents: 60_000, actualCents: 60_000, paidAt, treatment: 'prepaid', coversFrom: m(-2), coversMonths: 2 },
    })
    await postJournalEntry({ tenantId: A.tenantId, sourceType: 'opex.payment', sourceId: p.id, description: 'OpEx prepaid', entryDate: paidAt, postedBy: 'test', lines: [
      { accountCode: '1310', type: 'debit', amountCents: 60_000 }, { accountCode: '1020', type: 'credit', amountCents: 60_000 },
    ] })
    F.opexPay = p.id
    await refusing(A.tenantId, '6030', () => releasePrepaidThrough(A.tenantId, m(-1)))
    expect(await openPostingFlag(p.id, 'prepaid.release')).toMatchObject({ entityType: 'OpexPayment' })
    refused.push({ kind: 'prepaid.release', key: p.id })
  })

  it('giftcard.expire: breakage refused with 4200 off; a second card whose exact key is already on the books', async () => {
    for (const key of ['card', 'cardDup']) {
      const card = await prisma.giftCard.create({
        data: { tenantId: A.tenantId, code: `GS-RPW-${key}-${Date.now()}`.toUpperCase(), issuedAmountCents: 30_000, balanceCents: 30_000, expiresAt: new Date(Date.now() - DAY), conceptId: A.conceptId },
      })
      await postJournalEntry({ tenantId: A.tenantId, sourceType: 'giftcard.issue', sourceId: card.id, description: 'Gift card sold', entryDate: new Date(Date.now() - 2 * DAY), postedBy: 'test', lines: [
        { accountCode: '1010', type: 'debit', amountCents: 30_000 }, { accountCode: '2080', type: 'credit', amountCents: 30_000 },
      ] })
      F[key] = card.id
    }
    expect(await refusing(A.tenantId, '4200', () => expireOneGiftCard(F.card!))).toMatchObject({ expired: true, breakageCents: 0, held: true })
    expect(await openPostingFlag(F.card!, 'giftcard.expire')).toBeTruthy()
    refused.push({ kind: 'giftcard.expire', key: F.card! })
    // The card and the books disagree: 'giftcard.expire:<card>' exists, the card still holds its breakage.
    await postJournalEntry({ tenantId: A.tenantId, sourceType: 'giftcard.expire', sourceId: F.cardDup!, description: 'Booked by hand', entryDate: new Date(), postedBy: 'test', lines: [
      { accountCode: '2080', type: 'debit', amountCents: 30_000 }, { accountCode: '4200', type: 'credit', amountCents: 30_000 },
    ] })
    expect(await expireOneGiftCard(F.cardDup!)).toMatchObject({ held: true })
    expect(await openPostingFlag(F.cardDup!, 'giftcard.expire')).toBeTruthy()
  })

  it("ic.fleet_charge: B's riders carried A's orders; B's 6990 was off (flag in the client company A)", async () => {
    const agreement = await prisma.fleetAgreement.create({ data: { providerTenantId: B.tenantId, clientTenantId: A.tenantId, createdById: ceoAB.id } })
    await prisma.fleetRate.create({ data: { tenantId: B.tenantId, clientTenantId: A.tenantId, agreementId: agreement.id, fromPeriod: m(-6), ratePerTripCents: 5_000, setById: ceoAB.id } })
    const rider = await prisma.rider.create({ data: { name: 'B rider', phone: `92311${String(Date.now()).slice(-7)}`, tenantId: B.tenantId } })
    const trip = await prisma.order.create({ data: { conceptId: A.conceptId, source: 'servd', fulfilmentType: 'delivery', status: 'completed', totalCents: 150_000 } })
    await prisma.riderJobEvent.create({ data: { orderId: trip.id, riderId: rider.id, tenantId: A.tenantId, riderTenantId: B.tenantId, type: 'picked_up', createdAt: mid(m(-2)) } })
    await refusing(B.tenantId, '6990', () => expect(chargeFleetMonth(agreement.id, m(-2))).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' }))
    F.fleet = `${agreement.id}:${m(-2)}`
    F.agreement = agreement.id
    expect(await openPostingFlag(F.fleet, 'ic.fleet_charge')).toMatchObject({ tenantId: A.tenantId, entityType: 'FleetCharge' })
  })

  it('cost of sales moved after the order was booked: each event refused with its cost account off', async () => {
    // order_item.box_given — an online order completed, then leftovers boxed.
    const o1 = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], { source: 'servd' })
    await prisma.order.update({ where: { id: o1.id }, data: { status: 'completed', completedAt: new Date() } })
    expect((await postOrderCompletion(o1.id)).posted).toBe(true)
    await refusing(A.tenantId, '5030', () => markBoxGiven(o1.items[0]!.id, { id: mgrA.id, tenantIds: [A.tenantId] }))
    const tap1 = (await prisma.orderItem.findUniqueOrThrow({ where: { id: o1.items[0]!.id } })).boxGivenAt!
    F.boxGiven = `${o1.items[0]!.id}@${tap1.getTime()}`
    refused.push({ kind: 'order_item.box_given', key: F.boxGiven })

    // order.cogs_late — a depletion that ran after the order was booked.
    const o2 = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'servd', status: 'completed', completedAt: new Date(), totalCents: 100_000, fulfilmentType: 'takeout',
        items: { create: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 100_000, serviceVessel: 'plate' }] },
      },
    })
    expect((await postOrderCompletion(o2.id)).posted).toBe(true)
    await refusing(A.tenantId, '5010', () => deductInventoryForOrder(o2.id))
    F.cogsLate = o2.id
    refused.push({ kind: 'order.cogs_late', key: o2.id })

    // order_item.return — a till ticket its drawer close booked, cancelled with the line unfired.
    const o3 = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], { source: 'pos' })
    await partPayAndClose(o3.id)
    await refusing(A.tenantId, '5010', () => cancelOrder(o3.id, { reason: 'Customer left', actor: { id: mgrA.id, tenantId: A.tenantId } }))
    F.ret = o3.items[0]!.id
    refused.push({ kind: 'order_item.return', key: F.ret })

    // order_item.box_given_undo — boxed on a booked open ticket, then undone.
    const o4 = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], { source: 'pos' })
    await partPayAndClose(o4.id)
    await markBoxGiven(o4.items[0]!.id, { id: mgrA.id, tenantIds: [A.tenantId] })
    const tap4 = (await prisma.orderItem.findUniqueOrThrow({ where: { id: o4.items[0]!.id } })).boxGivenAt!
    await refusing(A.tenantId, '5030', () => markBoxGiven(o4.items[0]!.id, { id: mgrA.id, tenantIds: [A.tenantId] }, { undo: true }))
    F.boxUndo = `${o4.items[0]!.id}@${tap4.getTime()}`
    refused.push({ kind: 'order_item.box_given_undo', key: F.boxUndo })

    // order.cancel_settle — a shortfall settled by a late receipt, then the (never booked) order cancelled.
    const saffron = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Saffron', unit: 'kg', category: 'dry_goods' } })).id
    await lot(A, saffron, 0.1, 1_000_000)
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })
    const dish = (await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: 'Saffron rice', priceCents: 100_000 } })).id
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: dish, servings: 1, ingredients: { create: [{ inventoryItemId: saffron, quantity: 200, unit: 'kg' }] } } })
    const o5 = await ring([{ menuItemId: dish, name: 'Saffron rice' }])
    await lot(A, saffron, 1, 1_200_000, 'receipt')
    await refusing(A.tenantId, '5010', () => cancelOrder(o5.id, { reason: 'Out of rice', actor: { id: mgrA.id, tenantId: A.tenantId } }))
    F.cancelSettle = o5.id
    refused.push({ kind: 'order.cancel_settle', key: o5.id })

    for (const r of refused.filter((x) => x.kind.startsWith('order'))) {
      expect(await openPostingFlag(r.key, r.kind), r.kind).toBeTruthy()
      expect(await refCount(A.tenantId, `${r.kind}:${r.key}`), r.kind).toBe(0)
    }

    // order.legacy_return — a flag whose event moved nothing: closed as nothing owed.
    const o6 = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }])
    F.legacy = `${o6.id}:cancel`
    await flagPostingFailed({
      tenantId: A.tenantId, sourceType: 'order.legacy_return', sourceId: F.legacy, entityType: 'OrderLegacyReturn', entityId: F.legacy,
      reason: 'ACCOUNT_INACTIVE: test', title: 'Cost of sales not moved',
    })
  })

  it('stock steps that failed: a depletion, a cancel give-back, a remake failed twice; a cancelled order nothing flagged', async () => {
    // deplete: an order whose stock never came out.
    const o7 = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'pos', status: 'received', totalCents: 100_000, fulfilmentType: 'takeout',
        items: { create: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 100_000, serviceVessel: 'plate' }] },
      },
    })
    await flagOrderStockFailure(o7.id, 'deplete', new Error('STOCK_NOT_ON_LOTS (test)'))
    F.deplete = o7.id
    // restore: cancelled, but its give-back failed.
    const o8 = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], { fulfilment: 'takeout' })
    await prisma.order.update({ where: { id: o8.id }, data: { status: 'cancelled' } })
    await flagOrderStockFailure(o8.id, 'restore', new Error('lock timeout (test)'))
    F.restore = o8.id
    // remake: two recalls of one line failed.
    const o9 = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], { fulfilment: 'takeout' })
    await flagOrderStockFailure(o9.id, 'remake', new Error('STOCK_NOT_ON_LOTS'), mgrA.id, o9.items[0]!.id)
    await flagOrderStockFailure(o9.id, 'remake', new Error('STOCK_NOT_ON_LOTS'), mgrA.id, o9.items[0]!.id)
    F.remake = o9.items[0]!.id
    // remake: one recall failed, a LATER recall of the same line succeeded (its
    // own remake booked live) — the failed one is still owed (final gate).
    const o11 = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], { fulfilment: 'takeout' })
    await flagOrderStockFailure(o11.id, 'remake', new Error('lock timeout (test)'), mgrA.id, o11.items[0]!.id)
    expect((await bookRemakeWaste(o11.items[0]!.id, mgrA.id)).wasteLogIds.length).toBeGreaterThan(0)
    F.remakeLive = o11.items[0]!.id
    remakeLiveLogs = await prisma.wasteLog.count({ where: { orderItemId: F.remakeLive, reason: 'remake' } })
    // the sweep: cancelled with its stock still out, and no flag at all.
    const o10 = await ring([{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], { fulfilment: 'takeout' })
    await prisma.order.update({ where: { id: o10.id }, data: { status: 'cancelled' } })
    F.sweep = o10.id
    expect(await openStockFlag(o10.id)).toBeNull()

    // Close A's books through the end of m(-2): the dated postings above go late.
    await prisma.periodLock.create({ data: { tenantId: A.tenantId, lockedThrough: endOfMonthPkt(m(-2)), lockedBy: ceoAB.id, note: 'test' } })
  })
})

describe('the backfill re-posts them', () => {
  it("B's run posts B's prep draw and never lists, posts or closes A's", async () => {
    const rows = await backfill([B.tenantId], false, ceoB)
    expect(rowOf(rows, 'inventory.prep_draw', F.prepB!)).toMatchObject({ outcome: 'posted', tenantId: B.tenantId })
    expect(await refCount(B.tenantId, `inventory.prep_draw:${F.prepB}`)).toBe(1)
    const aIds = new Set(Object.values(F))
    aIds.delete(F.prepB!)
    expect(rows.filter((r) => aIds.has(r.id))).toEqual([])
    for (const r of refused) expect(await openPostingFlag(r.key, r.kind), r.kind).toBeTruthy()
    expect(await openPostingFlag(F.fleet!, 'ic.fleet_charge')).toBeTruthy()
    expect(await openStockFlag(F.deplete!)).toBeTruthy()
  })

  it('the dry run lists each and writes nothing', async () => {
    const rows = await backfill([A.tenantId], true, finA)
    expect(rowOf(rows, 'inventory.prep_draw', F.prepA!)).toMatchObject({ outcome: 'would_post_into_current_month' })
    expect(rowOf(rows, 'inventory.prep_draw', F.prepMiss!)).toMatchObject({ outcome: 'unflagged' })
    for (const k of ['fixed_asset.depreciation', 'prepaid.release', 'giftcard.expire', 'order_item.box_given', 'order.cogs_late', 'order_item.return', 'order_item.box_given_undo', 'order.cancel_settle']) {
      const r = refused.find((x) => x.kind === k)!
      expect(rowOf(rows, k, r.key)?.outcome, k).toMatch(/^would_post/)
    }
    expect(rowOf(rows, 'ic.fleet_charge', F.fleet!)).toMatchObject({ outcome: 'would_post' })
    expect(rowOf(rows, 'order.legacy_return', F.legacy!)).toMatchObject({ outcome: 'would_resolve' })
    expect(rowOf(rows, 'stock.deplete', F.deplete!)).toMatchObject({ outcome: 'would_post' })
    expect(rowOf(rows, 'stock.restore', F.restore!)).toMatchObject({ outcome: 'would_post' })
    expect(rowOf(rows, 'stock.remake', F.remake!)?.detail).toMatch(/Book 2 remakes/)
    expect(rowOf(rows, 'stock.remake', F.remakeLive!)).toMatchObject({ outcome: 'would_post' })
    expect(rowOf(rows, 'stock.remake', F.remakeLive!)?.detail).toMatch(/Book 1 remake /)
    expect(rowOf(rows, 'stock.restore', F.sweep!)).toMatchObject({ outcome: 'unflagged' })
    for (const r of refused) expect(await openPostingFlag(r.key, r.kind), r.kind).toBeTruthy()
    expect(await refCount(A.tenantId, `inventory.prep_draw:${F.prepA}`)).toBe(0)
    expect(await openStockFlag(F.sweep!)).toBeNull()
  })

  it("finance of A only: everything posts once (late-dated where its month is closed) — except the fleet charge, which asks for the CEO", async () => {
    const rows = await backfill([A.tenantId], false, finA)

    // Prep draw: its month is closed → into this month, with the note.
    expect(rowOf(rows, 'inventory.prep_draw', F.prepA!)).toMatchObject({ outcome: 'posted_into_current_month' })
    const prep = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `inventory.prep_draw:${F.prepA}` } })
    expect(prep.description).toMatch(/posted late into the open month/)
    expect(prep.entryDate.getTime()).toBeGreaterThan(endOfMonthPkt(m(-2)).getTime())

    // Depreciation: each month on its own — the closed ones late, the open one on its own day.
    expect(rowOf(rows, 'fixed_asset.depreciation', F.asset!)).toMatchObject({ outcome: 'posted' })
    const dep = await prisma.fixedAssetDepreciation.findMany({ where: { assetId: F.asset }, orderBy: { period: 'asc' } })
    expect(dep.map((d) => [d.period, d.postedPeriod])).toEqual([[m(-3), cur], [m(-2), cur], [m(-1), null]])

    // Prepaid: both covered months released (m(-2) late), flag on OpexPayment closed.
    expect(rowOf(rows, 'prepaid.release', F.opexPay!)).toMatchObject({ outcome: 'posted' })
    const rel = await prisma.prepaidRelease.findMany({ where: { sourceId: F.opexPay }, orderBy: { period: 'asc' } })
    expect(rel.map((r) => [r.period, r.postedPeriod])).toEqual([[m(-2), cur], [m(-1), null]])

    // Gift card: the card decided (multiPost); the one whose key was already on the books is NOT closed as "already".
    expect(rowOf(rows, 'giftcard.expire', F.card!)).toMatchObject({ outcome: 'posted' })
    expect(await refCount(A.tenantId, `giftcard.expire:${F.card}`)).toBe(1)
    expect(await prisma.giftCard.findUniqueOrThrow({ where: { id: F.card } })).toMatchObject({ balanceCents: 0, breakageCents: 30_000 })
    expect(rowOf(rows, 'giftcard.expire', F.cardDup!)).toMatchObject({ outcome: 'error' })
    expect(await openPostingFlag(F.cardDup!, 'giftcard.expire')).toBeTruthy()

    // Fleet: one company's staff cannot post into the provider's books.
    expect(rowOf(rows, 'ic.fleet_charge', F.fleet!)).toMatchObject({ outcome: 'error', detail: FLEET_ASK_CEO })
    expect(await openPostingFlag(F.fleet!, 'ic.fleet_charge')).toBeTruthy()
    expect(await prisma.intercompanyTransfer.count({ where: { sourceRef: `fleet:${F.fleet}` } })).toBe(0)

    // Cost-of-sales moves: each posted under its own key, once.
    for (const k of ['order_item.box_given', 'order.cogs_late', 'order_item.return', 'order_item.box_given_undo', 'order.cancel_settle']) {
      const r = refused.find((x) => x.kind === k)!
      expect(rowOf(rows, k, r.key)?.outcome, k).toBe('posted')
      expect(await refCount(A.tenantId, `${k}:${r.key}`), k).toBe(1)
    }
    expect(rowOf(rows, 'order.legacy_return', F.legacy!)).toMatchObject({ outcome: 'resolved' })

    // Every refused one's flag is closed (the deliberate disagreements aside).
    for (const r of refused) expect(await openPostingFlag(r.key, r.kind), r.kind).toBeNull()
    expect(await openPostingFlag(F.legacy!, 'order.legacy_return')).toBeNull()

    // Step 5: each stock step re-ran once.
    expect(rowOf(rows, 'stock.deplete', F.deplete!)).toMatchObject({ outcome: 'posted' })
    expect(await prisma.auditLog.count({ where: { entity: 'Order', entityId: F.deplete, action: 'stock.sale_deplete' } })).toBe(1)
    expect(rowOf(rows, 'stock.restore', F.restore!)).toMatchObject({ outcome: 'posted' })
    expect(await prisma.auditLog.count({ where: { entity: 'Order', entityId: F.restore, action: 'stock.sale_restore' } })).toBe(1)
    expect(rowOf(rows, 'stock.remake', F.remake!)).toMatchObject({ outcome: 'posted' })
    expect(await prisma.wasteLog.count({ where: { orderItemId: F.remake, reason: 'remake' } })).toBe(2)
    // The live remake did not pay for the failed one: it is booked now (twice the logs).
    expect(rowOf(rows, 'stock.remake', F.remakeLive!)).toMatchObject({ outcome: 'posted' })
    expect(await prisma.wasteLog.count({ where: { orderItemId: F.remakeLive, reason: 'remake' } })).toBe(2 * remakeLiveLogs)
    for (const id of [F.deplete!, F.restore!, F.remake!, F.remakeLive!]) expect(await openStockFlag(id)).toBeNull()
    // The sweep flags the cancelled order nothing flagged; the miss is flagged for review.
    expect(rowOf(rows, 'stock.restore', F.sweep!)).toMatchObject({ outcome: 'flagged' })
    expect(await openStockFlag(F.sweep!)).toMatchObject({ tenantId: A.tenantId })
    expect(rowOf(rows, 'inventory.prep_draw', F.prepMiss!)).toMatchObject({ outcome: 'flagged' })
  })

  it('the CEO of both companies: the fleet charge posts; the swept order and the miss post; a further run finds nothing', async () => {
    const rows = await backfill([A.tenantId], false, ceoAB)
    expect(rowOf(rows, 'ic.fleet_charge', F.fleet!)).toMatchObject({ outcome: 'posted' })
    expect(await prisma.intercompanyTransfer.count({ where: { sourceRef: `fleet:${F.fleet}`, status: 'posted' } })).toBe(1)
    expect(await openPostingFlag(F.fleet!, 'ic.fleet_charge')).toBeNull()
    expect(rowOf(rows, 'stock.restore', F.sweep!)).toMatchObject({ outcome: 'posted' })
    expect(rowOf(rows, 'inventory.prep_draw', F.prepMiss!)).toMatchObject({ outcome: 'posted' })

    const again = await backfill([A.tenantId], false, ceoAB)
    const ours = new Set(Object.values(F))
    ours.delete(F.cardDup!)   // the books and the card disagree: it stays for a person
    expect(again.filter((r) => ours.has(r.id))).toEqual([])
    expect(rowOf(again, 'giftcard.expire', F.cardDup!)).toMatchObject({ outcome: 'error' })
    // Nothing was posted twice.
    for (const r of refused) {
      const refs = await prisma.journalEntry.findMany({ where: { tenantId: A.tenantId, reference: { startsWith: `${r.kind}:` }, AND: { reference: { contains: r.key } } }, select: { reference: true } })
      expect(refs.length, r.kind).toBeGreaterThan(0)
      expect(new Set(refs.map((x) => x.reference)).size, r.kind).toBe(refs.length)   // one entry per key
    }
    expect(await refCount(A.tenantId, `inventory.prep_draw:${F.prepA}`)).toBe(1)
    expect(await prisma.wasteLog.count({ where: { orderItemId: F.remake, reason: 'remake' } })).toBe(2)
    expect(await prisma.wasteLog.count({ where: { orderItemId: F.remakeLive, reason: 'remake' } })).toBe(2 * remakeLiveLogs)
  })
})
