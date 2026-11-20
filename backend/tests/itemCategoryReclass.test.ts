// The ingredient master on FIFO lots (finance wave B) — POST/PATCH/GET /inventory.
//
// What this guards:
//   - category is the fixed list (400 otherwise); a change that moves the item
//     to another cost class moves its open lots' value with it, once:
//     'inventory.item_reclass:<itemId>:<auditLogId>' Dr new class / Cr old.
//   - unitCostCents is a typed estimate only while the item has no lots (422
//     COST_FROM_DELIVERIES after that); costSource follows.
//   - issue-on-receipt: managers, procurement and finance (that field alone), audited.
//   - GET: onHandValueCents for the financial viewers and stock keepers only;
//     the line cook sees no cost; B gets 404 on A's item.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

const DAY = 86_400_000
let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}
let seq = 0

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

async function item(co: Company, o: { qty?: number; cost?: number; category?: string } = {}) {
  await ensureFifoReady(co.tenantId)
  const it = await prisma.inventoryItem.create({ data: { name: `Master item ${++seq}`, unit: 'kg', tenantId: co.tenantId, unitCostCents: o.cost ?? 10_000, category: o.category ?? 'protein' } })
  if (o.qty) {
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: co.tenantId, inventoryItemId: it.id, qty: o.qty!, unitCostCents: o.cost ?? 10_000, kind: 'fifo_cutover', lotSourceType: 'fifo_cutover',
      lotSourceId: `seed:${it.id}`, movementSourceType: 'test.seed', movementSourceId: it.id, receivedAt: new Date(Date.now() - DAY),
    }))
  }
  return it
}
const reclassEntries = (itemId: string) => prisma.journalEntry.findMany({
  where: { reference: { startsWith: `inventory.item_reclass:${itemId}:` } },
  include: { lines: { include: { account: { select: { code: true } } } } },
  orderBy: { createdAt: 'asc' },
})

beforeAll(async () => {
  A = await mkCompany('master-a')
  B = await mkCompany('master-b')
  u.mgrA = await mkUser('mgrA', 'manager', A.tenantId)
  u.buyerA = await mkUser('buyerA', 'procurement', A.tenantId)
  u.cookA = await mkUser('cookA', 'boh', A.tenantId)
  u.finA = await mkUser('finA', 'finance', A.tenantId)
  u.mgrB = await mkUser('mgrB', 'manager', B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('category and cost class', () => {
  it('a class-crossing change moves the lots\' value once; inside a class nothing posts', async () => {
    const it0 = await item(A, { qty: 5, cost: 10_000 })
    const same = await call(u.mgrA!, 'PATCH', `/inventory/${it0.id}`, { category: 'produce' })
    expect(same.statusCode, same.body).toBe(200)
    expect(await reclassEntries(it0.id)).toHaveLength(0)

    const toDrinks = await call(u.mgrA!, 'PATCH', `/inventory/${it0.id}`, { category: 'beverage' })
    expect(toDrinks.statusCode, toDrinks.body).toBe(200)
    let es = await reclassEntries(it0.id)
    expect(es).toHaveLength(1)
    expect(es[0]!.tenantId).toBe(A.tenantId)
    expect(es[0]!.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1210', 'credit', 50_000], ['1220', 'debit', 50_000]])
    expect((await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: it0.id } })).costClass).toBe('beverage')
    const auditRow = await prisma.auditLog.findFirstOrThrow({ where: { action: 'inventory.category_change', entityId: it0.id } })
    expect(es[0]!.reference).toBe(`inventory.item_reclass:${it0.id}:${auditRow.id}`)

    // The same category again: no change, nothing posts.
    expect((await call(u.mgrA!, 'PATCH', `/inventory/${it0.id}`, { category: 'beverage' })).statusCode).toBe(200)
    expect(await reclassEntries(it0.id)).toHaveLength(1)

    expect((await call(u.buyerA!, 'PATCH', `/inventory/${it0.id}`, { category: 'packaging' })).statusCode).toBe(200)
    es = await reclassEntries(it0.id)
    expect(es).toHaveLength(2)
    expect(es[1]!.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1220', 'credit', 50_000], ['1230', 'debit', 50_000]])
  })

  it('lots of two classes (left by an earlier race) both move, and both values post (stock-02)', async () => {
    const it0 = await item(A, { qty: 5, cost: 10_000 })          // food lot, 50,000
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: A.tenantId, inventoryItemId: it0.id, qty: 2, unitCostCents: 10_000, kind: 'count_gain', lotSourceType: 'count_gain',
      lotSourceId: `gain:${it0.id}`, movementSourceType: 'test.gain', movementSourceId: it0.id, receivedAt: new Date(),
    }))
    // The second lot sits in the beverage class while the item is food (what the race left).
    await prisma.stockLot.updateMany({ where: { inventoryItemId: it0.id, sourceType: 'count_gain' }, data: { costClass: 'beverage' } })
    const r = await call(u.mgrA!, 'PATCH', `/inventory/${it0.id}`, { category: 'packaging' })
    expect(r.statusCode, r.body).toBe(200)
    const es = await reclassEntries(it0.id)
    expect(es).toHaveLength(2)
    const lines = es.flatMap((e) => e.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)])).sort()
    expect(lines).toEqual([['1210', 'credit', 50_000], ['1220', 'credit', 20_000], ['1230', 'debit', 20_000], ['1230', 'debit', 50_000]])
    const lots = await prisma.stockLot.findMany({ where: { inventoryItemId: it0.id }, select: { costClass: true } })
    expect(lots.every((l) => l.costClass === 'packaging')).toBe(true)
  })

  it('two category edits at once: the second reads the category under the item lock (stock-02)', async () => {
    const it0 = await item(A, { qty: 5, cost: 10_000 })
    let release!: () => void
    const gate = new Promise<void>((res) => { release = res })
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM inventory_items WHERE id = ${it0.id} FOR UPDATE`
      await gate
    }, { timeout: 60_000, maxWait: 10_000 })
    const waiting = async (n: number) => {
      for (let i = 0; i < 200; i++) {
        const rows = await prisma.$queryRaw<Array<{ c: bigint }>>`SELECT count(*)::bigint AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`
        if (Number(rows[0]!.c) >= n) return
        await new Promise((res) => setTimeout(res, 50))
      }
      throw new Error('the edits never queued on the item lock')
    }
    const t1 = call(u.mgrA!, 'PATCH', `/inventory/${it0.id}`, { category: 'beverage' })
    await waiting(1)
    const t2 = call(u.mgrA!, 'PATCH', `/inventory/${it0.id}`, { category: 'dairy' })
    await waiting(2)
    release()
    await holder
    const [r1, r2] = await Promise.all([t1, t2])
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200])
    const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: it0.id }, select: { category: true } })
    const lots = await prisma.stockLot.findMany({ where: { inventoryItemId: it0.id }, select: { costClass: true } })
    const cls = after.category === 'beverage' ? 'beverage' : 'food'
    expect(lots.every((l) => l.costClass === cls)).toBe(true)
    // The ledger agrees with the lots: whatever moved to 1220 came back if the item ended in food.
    const net = (await reclassEntries(it0.id)).flatMap((e) => e.lines).reduce((m, l) => {
      m[l.account.code] = (m[l.account.code] ?? 0) + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents)
      return m
    }, {} as Record<string, number>)
    expect(net['1220'] ?? 0).toBe(cls === 'beverage' ? 50_000 : 0)
  })

  it('a category off the list is 400 on create and edit', async () => {
    const it0 = await item(A)
    expect((await call(u.mgrA!, 'PATCH', `/inventory/${it0.id}`, { category: 'drinks' })).statusCode).toBe(400)
    expect((await call(u.mgrA!, 'POST', '/inventory', { name: 'Odd thing', unit: 'kg', category: 'misc' })).statusCode).toBe(400)
    const ok = await call(u.mgrA!, 'POST', '/inventory', { name: 'Cola cans', unit: 'pcs', category: 'beverage' })
    expect(ok.statusCode).toBe(201)
    expect(ok.json()).toMatchObject({ tenantId: A.tenantId, category: 'beverage' })
  })

  it('the estimate is editable only while the item has no lots', async () => {
    const fresh = await item(A, { cost: 5_000 })
    const edit = await call(u.buyerA!, 'PATCH', `/inventory/${fresh.id}`, { unitCostCents: 6_000 })
    expect(edit.statusCode, edit.body).toBe(200)
    expect(edit.json().unitCostCents).toBe(6_000)
    const listed = (await call(u.mgrA!, 'GET', `/inventory/${fresh.id}`)).json()
    expect(listed.costSource).toBe('opening')

    const held = await item(A, { qty: 2, cost: 5_000 })
    const refused = await call(u.buyerA!, 'PATCH', `/inventory/${held.id}`, { unitCostCents: 1 })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.code).toBe('COST_FROM_DELIVERIES')
    expect((await call(u.mgrA!, 'GET', `/inventory/${held.id}`)).json().costSource).toBe('deliveries')
  })

  it('issue-on-receipt: managers, the buying team and finance (that field alone), audited; B gets 404', async () => {
    const oil = await item(A)
    const res = await call(u.mgrA!, 'PATCH', `/inventory/${oil.id}`, { issueOnReceipt: true })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().issueOnReceipt).toBe(true)
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'inventory.issue_on_receipt', entityId: oil.id } })
    expect(row).toMatchObject({ tenantId: A.tenantId, userId: u.mgrA!.id })
    // The buyer (owner, 2026-11-17: no tick for the buying team).
    const buyer = await call(u.buyerA!, 'PATCH', `/inventory/${oil.id}`, { issueOnReceipt: false })
    expect(buyer.statusCode, buyer.body).toBe(200)
    expect(buyer.json().issueOnReceipt).toBe(false)
    // Finance (owner, 2026-11-17: "Show it to finance also for time being") — the tick alone.
    const fin = await call(u.finA!, 'PATCH', `/inventory/${oil.id}`, { issueOnReceipt: true })
    expect(fin.statusCode, fin.body).toBe(200)
    expect(fin.json().issueOnReceipt).toBe(true)
    expect((await call(u.finA!, 'PATCH', `/inventory/${oil.id}`, { issueOnReceipt: false, parLevel: 5 })).statusCode).toBe(403)
    expect((await call(u.finA!, 'PATCH', `/inventory/${oil.id}`, { parLevel: 5 })).statusCode).toBe(403)
    // The kitchen floor never; another company's item is 404.
    expect((await call(u.cookA!, 'PATCH', `/inventory/${oil.id}`, { issueOnReceipt: false })).statusCode).toBe(403)
    expect((await call(u.mgrB!, 'PATCH', `/inventory/${oil.id}`, { issueOnReceipt: false })).statusCode).toBe(404)
  })
})

describe('issue-on-receipt in bulk (owner, 2026-11-18)', () => {
  it('sets many items at once by the single tick\'s rule; another company\'s item is never changed; audited per item', async () => {
    const [a1, a2, a3] = [await item(A), await item(A), await item(A)]
    const b1 = await item(B)
    await prisma.inventoryItem.update({ where: { id: a3.id }, data: { issueOnReceipt: true } })
    const res = await call(u.buyerA!, 'POST', '/inventory/issue-on-receipt', { itemIds: [a1.id, a2.id, a3.id, b1.id], issueOnReceipt: true })
    expect(res.statusCode, res.body).toBe(200)
    const out = res.json()
    expect(out.changed.map((c: { id: string }) => c.id).sort()).toEqual([a1.id, a2.id].sort())
    expect(out.unchanged).toBe(1)
    expect(out.failed).toHaveLength(1)
    expect(out.failed[0]).toMatchObject({ id: b1.id, name: null })   // B's item: not found, its name never leaks
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: b1.id } })).issueOnReceipt).toBe(false)
    expect(await prisma.auditLog.count({ where: { action: 'inventory.issue_on_receipt', entityId: { in: [a1.id, a2.id] }, tenantId: A.tenantId } })).toBe(2)
    expect(await prisma.auditLog.count({ where: { action: 'inventory.issue_on_receipt', entityId: a3.id } })).toBe(0)
    // Finance (accounting) may switch them back; the kitchen floor never; company B changes nothing of A's.
    const fin = await call(u.finA!, 'POST', '/inventory/issue-on-receipt', { itemIds: [a1.id], issueOnReceipt: false })
    expect(fin.statusCode, fin.body).toBe(200)
    expect(fin.json().changed).toHaveLength(1)
    expect((await call(u.cookA!, 'POST', '/inventory/issue-on-receipt', { itemIds: [a2.id], issueOnReceipt: false })).statusCode).toBe(403)
    const other = await call(u.mgrB!, 'POST', '/inventory/issue-on-receipt', { itemIds: [a2.id], issueOnReceipt: false })
    expect(other.json().changed).toHaveLength(0)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: a2.id } })).issueOnReceipt).toBe(true)
  })
})

describe('stock already on hand goes to cost when ticked (owner, 2026-11-18)', () => {
  const issueLines = async (itemId: string) => {
    const lots = await prisma.stockLot.findMany({ where: { inventoryItemId: itemId }, select: { id: true } })
    const es = await prisma.journalEntry.findMany({
      where: { reference: { in: lots.map((l) => `inventory.issue_on_receipt:${l.id}`) } },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    return es.flatMap((e) => e.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)])).sort()
  }
  it('the single tick issues what is on hand (Dr 5010 / Cr 1210), once', async () => {
    const beef = await item(A, { qty: 8, cost: 1_700 })
    const res = await call(u.mgrA!, 'PATCH', `/inventory/${beef.id}`, { issueOnReceipt: true })
    expect(res.statusCode, res.body).toBe(200)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beef.id } })).currentStock).toBe(0)
    expect(await issueLines(beef.id)).toEqual([['1210', 'credit', 13_600], ['5010', 'debit', 13_600]])
    expect(await prisma.auditLog.count({ where: { action: 'inventory.issue_on_hand', entityId: beef.id, tenantId: A.tenantId } })).toBe(1)
    // Nothing left: the button issues nothing more.
    const again = await call(u.mgrA!, 'POST', `/inventory/${beef.id}/issue-on-hand`)
    expect(again.json()).toMatchObject({ lots: 0, valueCents: 0 })
    expect(await issueLines(beef.id)).toHaveLength(2)
  })
  it('bulk tick issues every item\'s stock, ticked before or now; the button needs the tick; B gets 404', async () => {
    const coke = await item(A, { qty: 30, cost: 75, category: 'beverage' })
    const water = await item(A, { qty: 30, cost: 55, category: 'beverage' })
    await prisma.inventoryItem.update({ where: { id: water.id }, data: { issueOnReceipt: true } })   // ticked before
    const res = await call(u.finA!, 'POST', '/inventory/issue-on-receipt', { itemIds: [coke.id, water.id], issueOnReceipt: true })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().issuedOnHand.map((x: { id: string }) => x.id).sort()).toEqual([coke.id, water.id].sort())
    expect(await issueLines(coke.id)).toEqual([['1220', 'credit', 2_250], ['5020', 'debit', 2_250]])
    expect(await issueLines(water.id)).toEqual([['1220', 'credit', 1_650], ['5020', 'debit', 1_650]])
    const plain = await item(A, { qty: 2 })
    expect((await call(u.mgrA!, 'POST', `/inventory/${plain.id}/issue-on-hand`)).json().error.code).toBe('NOT_ISSUED_ON_RECEIPT')
    expect((await call(u.mgrB!, 'POST', `/inventory/${coke.id}/issue-on-hand`)).statusCode).toBe(404)
    expect((await call(u.cookA!, 'POST', `/inventory/${coke.id}/issue-on-hand`)).statusCode).toBe(403)
  })
})

describe('issue stock on hand into a picked cost-of-sales account (owner, 2026-11-20)', () => {
  const acct = (t: { tenantId: string }, code: string, name: string, plSection: string | null, extra: object = {}) =>
    prisma.account.create({ data: { tenantId: t.tenantId, code, name, type: 'expense', plSection, ...extra } })
  it('lands in the picked account; the list is the company\'s own cost-of-sales accounts; others are refused', async () => {
    await acct(A, '5101', 'Cost of Goods Sold', 'cost_of_sales')
    await acct(A, '5102', 'IT Expenses', 'operating_expense')          // a 5-code that is NOT cost of sales
    await acct(A, '5103', 'Old COGS', 'cost_of_sales', { isActive: false })
    await acct(B, '5104', 'B Cost of Goods Sold', 'cost_of_sales')
    const butter = await item(A, { qty: 5, cost: 1_000 })
    await prisma.inventoryItem.update({ where: { id: butter.id }, data: { issueOnReceipt: true } })
    const list = await call(u.finA!, 'GET', `/inventory/${butter.id}/issue-accounts`)
    expect(list.statusCode, list.body).toBe(200)
    const codes = list.json().accounts.map((a: { code: string }) => a.code)
    expect(codes[0]).toBe('5010')                                      // the item's own class account first
    expect(list.json().defaultCode).toBe('5010')
    expect(codes).toEqual(expect.arrayContaining(['5010', '5020', '5030', '5101']))
    for (const no of ['5040', '5050', '5102', '5103', '5104']) expect(codes).not.toContain(no)
    expect((await call(u.mgrB!, 'GET', `/inventory/${butter.id}/issue-accounts`)).statusCode).toBe(404)
    // Refused accounts change nothing.
    for (const bad of ['5102', '5103', '5104', '5040', '6010', '1210']) {
      const r = await call(u.finA!, 'POST', `/inventory/${butter.id}/issue-on-hand`, { accountCode: bad })
      expect(r.statusCode, `${bad}: ${r.body}`).toBe(422)
      expect(r.json().error.code).toBe('NOT_A_COST_OF_SALES_ACCOUNT')
    }
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: butter.id } })).currentStock).toBe(5)
    const ok = await call(u.finA!, 'POST', `/inventory/${butter.id}/issue-on-hand`, { accountCode: '5101' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ accountCode: '5101', valueCents: 5_000 })
    const lots = await prisma.stockLot.findMany({ where: { inventoryItemId: butter.id }, select: { id: true } })
    const es = await prisma.journalEntry.findMany({
      where: { reference: { in: lots.map((l) => `inventory.issue_on_receipt:${l.id}`) } },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    expect(es.every((e) => e.tenantId === A.tenantId)).toBe(true)
    expect(es.flatMap((e) => e.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)])).sort()).toEqual([['1210', 'credit', 5_000], ['5101', 'debit', 5_000]])
    const au = await prisma.auditLog.findFirstOrThrow({ where: { action: 'inventory.issue_on_hand', entityId: butter.id } })
    expect((au.after as { accountCode?: string }).accountCode).toBe('5101')
  })
  it('bulk tick takes the same pick; an account the item\'s company does not have fails that item only', async () => {
    await prisma.account.upsert({ where: { tenantId_code: { tenantId: A.tenantId, code: '5105' } }, update: {}, create: { tenantId: A.tenantId, code: '5105', name: 'COGS 2', type: 'expense', plSection: 'cost_of_sales' } })
    const tea = await item(A, { qty: 10, cost: 100, category: 'beverage' })
    const res = await call(u.finA!, 'POST', '/inventory/issue-on-receipt', { itemIds: [tea.id], issueOnReceipt: true, accountCode: '5105' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().issuedOnHand).toHaveLength(1)
    const lot = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: tea.id } })
    const e = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `inventory.issue_on_receipt:${lot.id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(e.lines.map((l) => [l.account.code, l.type]).sort()).toEqual([['1220', 'credit'], ['5105', 'debit']])
    const milk = await item(A, { qty: 3, cost: 100, category: 'beverage' })
    const bad = await call(u.finA!, 'POST', '/inventory/issue-on-receipt', { itemIds: [milk.id], issueOnReceipt: true, accountCode: '6010' })
    expect(bad.json().failed[0]).toMatchObject({ id: milk.id, code: 'NOT_A_COST_OF_SALES_ACCOUNT' })
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: milk.id } }))).toMatchObject({ issueOnReceipt: false, currentStock: 3 })
  })
})

describe('reading the master', () => {
  it('on-hand value for managers and finance only; the cook sees no cost; B gets 404', async () => {
    const it0 = await item(A, { qty: 3, cost: 20_000 })
    const mgr = (await call(u.mgrA!, 'GET', `/inventory/${it0.id}`)).json()
    expect(mgr).toMatchObject({ onHandValueCents: 60_000, unitCostCents: 20_000, currentStock: 3 })
    const fin = await call(u.finA!, 'GET', '/inventory')
    expect(fin.statusCode).toBe(200)
    expect((fin.json() as Array<{ id: string; onHandValueCents?: number }>).find((r) => r.id === it0.id)!.onHandValueCents).toBe(60_000)
    const buyer = (await call(u.buyerA!, 'GET', `/inventory/${it0.id}`)).json()
    expect(buyer.unitCostCents).toBe(20_000)
    expect(buyer.onHandValueCents).toBeUndefined()
    const cook = (await call(u.cookA!, 'GET', `/inventory/${it0.id}`)).json()
    expect(cook).toMatchObject({ unitCostCents: null, costsHidden: true })
    expect(cook.onHandValueCents).toBeUndefined()

    expect((await call(u.mgrB!, 'GET', `/inventory/${it0.id}`)).statusCode).toBe(404)
    expect((await call(u.mgrB!, 'PATCH', `/inventory/${it0.id}`, { category: 'dairy' })).statusCode).toBe(404)
    expect(await reclassEntries(it0.id)).toHaveLength(0)
    expect((await call(u.finA!, 'PATCH', `/inventory/${it0.id}`, { category: 'dairy' })).statusCode).toBe(403)
  })
})
