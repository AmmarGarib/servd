// Postings that failed silently (finance gap 8 + the two log-only postings
// found beside it), 2026-10-13:
//
//   - A refused manual waste, stock count, bank deposit, void-after-fire waste,
//     cancelled-ticket unwind or failed-card move raises ONE posting_failed
//     flag in the DOCUMENT's company (never just a log line). No variance on a
//     count is not a failure.
//   - POST /reconciliation/backfill-unposted re-posts each through its own
//     poster (same key, so never twice): on its own date while that month is
//     open, else into the current open month with a memo naming the original
//     date (owner decision 6); a lock through today posts nothing. Already on
//     the books or nothing owed → the flag is closed.
//   - The older void-waste flag (metadata.source, no sourceType) is re-posted
//     too, and a new flag is never raised beside it.
//   - The dry run lists deposits / waste nothing flagged ('unflagged'); a real
//     run flags them for review; the run after posts them.
//   - Two companies: company B's backfill never lists, posts or closes A's.
// Every journal entry this suite writes is checked to balance, in one company.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'
import { flagPostingFailed, postJournalEntry } from '../src/modules/accounting/journal.js'
import { parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import { postVoidWaste } from '../src/modules/inventory/voidWaste.js'
import { cancelOrder } from '../src/modules/orders/service.js'
import { applyKeenuCallback } from '../src/modules/paymentGateways/keenuSettle.js'

let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
const users: Record<string, { id: string; token: string }> = {}
const PHOTO = 'https://example.com/waste.jpg'
const DAY = 86_400_000
const ymd = (d: Date) => new Date(d.getTime() + 5 * 3600_000).toISOString().slice(0, 10)   // PKT date

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.postingfailures@test.local`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

type BackfillRow = { kind: string; id: string; orderId: string | null; tenantId: string; date: string | null; outcome: string; detail: string }
async function backfill(who: string, dryRun: boolean): Promise<BackfillRow[]> {
  const res = await call(who, 'POST', '/reconciliation/backfill-unposted', { dryRun })
  expect(res.statusCode, res.body).toBe(200)
  return (res.json().orders.rows ?? []) as BackfillRow[]
}
const rowOf = (rows: BackfillRow[], kind: string, id: string) => rows.find((r) => r.kind === kind && r.id === id)

type Line = { code: string; type: string; amount: number; memo: string }
async function entry(tenantId: string, reference: string): Promise<{ entryDate: Date; description: string; lines: Line[] } | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  return { entryDate: je.entryDate, description: je.description, lines: je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, memo: l.memo ?? '' })) }
}
const sum = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
const countRefs = (reference: string) => prisma.journalEntry.count({ where: { reference } })

const openFlags = (entityId: string) => prisma.exceptionFlag.findMany({
  where: { kind: 'posting_failed', entityId, status: { in: ['open', 'acknowledged'] } },
})
const setActive = (tenantId: string, code: string, isActive: boolean) =>
  prisma.account.updateMany({ where: { tenantId, code }, data: { isActive } })
/** A lock straight in the table (the route refuses today); returns a remover. */
async function lockThrough(tenantId: string, through: Date) {
  const lock = await prisma.periodLock.create({ data: { tenantId, lockedThrough: through, lockedBy: users.adminA!.id, note: 'test' } })
  return () => prisma.periodLock.delete({ where: { id: lock.id } })
}

let seq = 0
/** An item whose stock on hand is held on one FIFO lot at its cost (finance wave B: stock lives on lots). */
async function inventoryItem(tenantId: string, name: string, unitCostCents: number, currentStock = 100) {
  await ensureFifoReady(tenantId)
  const item = await prisma.inventoryItem.create({ data: { name: `${name} ${++seq}`, unit: 'kg', currentStock: 0, unitCostCents, tenantId } })
  if (currentStock > 0) {
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId, inventoryItemId: item.id, qty: currentStock, unitCostCents, kind: 'fifo_cutover', lotSourceType: 'fifo_cutover',
      lotSourceId: `test-seed:${item.id}`, movementSourceType: 'test.seed', movementSourceId: item.id, receivedAt: new Date(Date.now() - DAY),
    }))
  }
  return prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })
}
async function order(conceptId: string, status: 'received' | 'completed' | 'cancelled' = 'completed', totalCents = 100_000) {
  return prisma.order.create({
    data: {
      conceptId, source: 'pos', status, totalCents, placedAt: new Date(),
      externalId: `posting-failures-${++seq}-${Date.now()}`,
      ...(status === 'completed' ? { completedAt: new Date() } : {}),
      items: { create: [{ name: 'Beef Nihari', quantity: 1, unitPriceCents: totalCents }] },
    },
    include: { items: true },
  })
}
async function depositDrop(tenantId: string, amountCents: number, droppedAt: Date) {
  return prisma.depositDrop.create({
    data: { tenantId, amountCents, expectedCents: amountCents, varianceCents: 0, droppedById: users.adminA!.id, droppedAt },
  })
}
/** The flag the deposit route raises on a refused drop (trustops/routes.ts). */
function flagDrop(drop: { id: string; tenantId: string | null; amountCents: number }) {
  return flagPostingFailed({
    tenantId: drop.tenantId, sourceType: 'deposit.drop', sourceId: drop.id,
    entityType: 'DepositDrop', entityId: drop.id, reason: 'ACCOUNT_NOT_FOUND: test', title: 'Bank deposit did not reach the ledger',
    amountCents: drop.amountCents,
  })
}
/** A line voided after firing: its waste log (void_after_fire), as wasteVoidedFiredLineTx writes it. */
async function voidedLine(tenantId: string, conceptId: string, costCents: number, at: Date) {
  const o = await order(conceptId)
  const line = o.items[0]!
  const beef = await inventoryItem(tenantId, 'Beef', 200_000)
  const log = await prisma.wasteLog.create({
    data: {
      inventoryItemId: beef.id, quantity: costCents / 200_000, unit: 'kg', reason: 'void_after_fire', estimatedCostCents: costCents,
      recordedById: users.adminA!.id, recordedAt: at,
      notes: `Voided after firing: 1 × Beef Nihari (order ${o.id}, line ${line.id}). Reason: test`,
    },
  })
  return { o, line, log }
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Postings A', slug: 'posting-failures-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Postings B', slug: 'posting-failures-b' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()
  conceptA = (await prisma.concept.create({ data: { name: 'Postings Diner', slug: 'posting-failures-a', type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Postings Grill', slug: 'posting-failures-b', type: 'restaurant', tenantId: tenantB } })).id
  await mkUser('adminA', 'admin', tenantA)
  await mkUser('adminB', 'admin', tenantB)
  await mkUser('chefA', 'boh_management', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(crosschecksRoutes, { prefix: '/crosschecks' })
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
  invalidateSetupCache()
})

// ─── Manual waste ────────────────────────────────────────────────────────────

describe('manual waste — a refused posting is flagged and re-posted', () => {
  it('flags in the item\'s company; B\'s backfill never lists, posts or closes it; A\'s posts it once on its own day', async () => {
    const beef = await inventoryItem(tenantA, 'Beef mince', 180_000, 10)
    await setActive(tenantA, '5040', false)
    let wasteId: string
    try {
      const res = await call('chefA', 'POST', `/inventory/${beef.id}/waste`, { quantity: 0.1, unit: 'kg', reason: 'spoilage', photoUrl: PHOTO })
      expect(res.statusCode, res.body).toBe(201)
      wasteId = res.json().id
    } finally {
      await setActive(tenantA, '5040', true)
    }
    expect(await entry(tenantA, `inventory.waste:${wasteId}`)).toBeNull()
    const flags = await openFlags(wasteId)
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ tenantId: tenantA, entityType: 'WasteLog', severity: 'high', amountCents: 18_000, actorId: users.chefA!.id })
    expect(flags[0]!.metadata).toMatchObject({ sourceType: 'inventory.waste', sourceId: wasteId })
    expect(flags[0]!.description).toContain('Backfill unposted')
    expect(flags[0]!.description).not.toContain('reopen the period')

    // Company B: not listed, not posted, not closed.
    expect(rowOf(await backfill('adminB', true), 'inventory.waste', wasteId)).toBeUndefined()
    expect(rowOf(await backfill('adminB', false), 'inventory.waste', wasteId)).toBeUndefined()
    expect(await openFlags(wasteId)).toHaveLength(1)
    expect(await countRefs(`inventory.waste:${wasteId}`)).toBe(0)

    const log = await prisma.wasteLog.findUniqueOrThrow({ where: { id: wasteId } })
    const dry = rowOf(await backfill('adminA', true), 'inventory.waste', wasteId)
    expect(dry).toMatchObject({ outcome: 'would_post', tenantId: tenantA, date: log.recordedAt.toISOString() })
    expect(await countRefs(`inventory.waste:${wasteId}`)).toBe(0)

    expect(rowOf(await backfill('adminA', false), 'inventory.waste', wasteId)).toMatchObject({ outcome: 'posted' })
    const je = await entry(tenantA, `inventory.waste:${wasteId}`)
    expect(sum(je!.lines, '5040', 'debit')).toBe(18_000)
    expect(sum(je!.lines, '1210', 'credit')).toBe(18_000)
    expect(je!.entryDate.toISOString()).toBe(log.recordedAt.toISOString())
    expect(await openFlags(wasteId)).toHaveLength(0)

    // A second run posts nothing.
    expect(rowOf(await backfill('adminA', false), 'inventory.waste', wasteId)).toBeUndefined()
    expect(await countRefs(`inventory.waste:${wasteId}`)).toBe(1)
  })

  it('a waste that posts raises no flag', async () => {
    const beef = await inventoryItem(tenantA, 'Lamb', 100_000, 10)
    const res = await call('chefA', 'POST', `/inventory/${beef.id}/waste`, { quantity: 0.1, unit: 'kg', reason: 'spoilage' })
    expect(res.statusCode, res.body).toBe(201)
    expect(await entry(tenantA, `inventory.waste:${res.json().id}`)).not.toBeNull()
    expect(await openFlags(res.json().id)).toHaveLength(0)
  })
})

// ─── Stock count ─────────────────────────────────────────────────────────────

describe('stock count — a refused adjustment is flagged and re-posted', () => {
  it('flags in the count\'s company (no variance is not a failure); the backfill posts it once', async () => {
    const bun = await inventoryItem(tenantA, 'Potato bun', 6_000, 35)
    const salt = await inventoryItem(tenantA, 'Salt', 5_000, 4)
    await setActive(tenantA, '5050', false)
    let countId: string
    let flatId: string
    try {
      const res = await call('chefA', 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: bun.id, physicalQty: 30, reason: 'five missing' }] })
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json().ledger).toMatchObject({ posted: false })
      countId = res.json().id
      const flat = await call('chefA', 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: salt.id, physicalQty: 4 }] })
      expect(flat.json().ledger).toMatchObject({ posted: false, reason: 'no_variance' })
      flatId = flat.json().id
    } finally {
      await setActive(tenantA, '5050', true)
    }
    const flags = await openFlags(countId)
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ tenantId: tenantA, entityType: 'PhysicalCount' })
    expect(flags[0]!.metadata).toMatchObject({ sourceType: 'inventory.count', sourceId: countId })
    expect(await openFlags(flatId)).toHaveLength(0)

    expect(rowOf(await backfill('adminB', false), 'inventory.count', countId)).toBeUndefined()
    expect(rowOf(await backfill('adminA', true), 'inventory.count', countId)).toMatchObject({ outcome: 'would_post' })
    expect(rowOf(await backfill('adminA', false), 'inventory.count', countId)).toMatchObject({ outcome: 'posted' })
    const je = await entry(tenantA, `inventory.count:${countId}`)
    expect(sum(je!.lines, '5050', 'debit')).toBe(30_000)
    expect(sum(je!.lines, '1210', 'credit')).toBe(30_000)
    expect(await openFlags(countId)).toHaveLength(0)
    expect(rowOf(await backfill('adminA', false), 'inventory.count', countId)).toBeUndefined()
    expect(await countRefs(`inventory.count:${countId}`)).toBe(1)
  })
})

// ─── Bank deposit (flagged by the deposit route) ─────────────────────────────

describe('bank deposit — re-posted on its own day, or into the open month with its date in the memo', () => {
  it('its month open: posts on the drop\'s own date (Dr 1020 / Cr 1010) and closes the flag', async () => {
    const drop = await depositDrop(tenantA, 500_000, new Date(Date.now() - 2 * DAY))
    await flagDrop(drop)
    expect((await openFlags(drop.id))[0]?.tenantId).toBe(tenantA)
    expect(rowOf(await backfill('adminB', false), 'deposit.drop', drop.id)).toBeUndefined()
    expect(rowOf(await backfill('adminA', false), 'deposit.drop', drop.id)).toMatchObject({ outcome: 'posted' })
    const je = await entry(tenantA, `deposit.drop:${drop.id}`)
    expect(je!.entryDate.toISOString()).toBe(drop.droppedAt.toISOString())
    expect(sum(je!.lines, '1020', 'debit')).toBe(500_000)
    expect(sum(je!.lines, '1010', 'credit')).toBe(500_000)
    expect(await openFlags(drop.id)).toHaveLength(0)
  })

  it('its month closed: listed, then posted into the current month with a memo naming its date; a lock through today posts nothing', async () => {
    const droppedAt = new Date(Date.now() - 40 * DAY)
    const drop = await depositDrop(tenantA, 250_000, droppedAt)
    await flagDrop(drop)
    const unlock = await lockThrough(tenantA, parsePktEndOfDay(ymd(new Date(Date.now() - 35 * DAY))))
    try {
      const dry = rowOf(await backfill('adminA', true), 'deposit.drop', drop.id)
      expect(dry).toMatchObject({ outcome: 'would_post_into_current_month' })
      expect(dry!.detail).toContain(`dated ${ymd(droppedAt)}`)

      // Books closed even through today (a legacy lock): nothing can post.
      const unlockToday = await lockThrough(tenantA, new Date(Date.now() + DAY))
      try {
        expect(rowOf(await backfill('adminA', false), 'deposit.drop', drop.id)).toMatchObject({ outcome: 'locked' })
        expect(await countRefs(`deposit.drop:${drop.id}`)).toBe(0)
        expect(await openFlags(drop.id)).toHaveLength(1)
      } finally {
        await unlockToday()
      }

      const before = Date.now()
      expect(rowOf(await backfill('adminA', false), 'deposit.drop', drop.id)).toMatchObject({ outcome: 'posted_into_current_month' })
      const je = await entry(tenantA, `deposit.drop:${drop.id}`)
      expect(je!.entryDate.getTime()).toBeGreaterThanOrEqual(before - 1000)
      expect(je!.description).toContain(`dated ${ymd(droppedAt)}`)
      for (const l of je!.lines) expect(l.memo).toContain(`dated ${ymd(droppedAt)}`)
      expect(sum(je!.lines, '1020', 'debit')).toBe(250_000)
      expect(await openFlags(drop.id)).toHaveLength(0)
      // Once only.
      expect(rowOf(await backfill('adminA', false), 'deposit.drop', drop.id)).toBeUndefined()
      expect(await countRefs(`deposit.drop:${drop.id}`)).toBe(1)
    } finally {
      await unlock()
    }
  })

  it('already on the books: the flag is closed, nothing posts twice', async () => {
    const drop = await depositDrop(tenantA, 90_000, new Date())
    const { postDepositDrop } = await import('../src/modules/accounting/depositPosting.js')
    expect((await postDepositDrop(drop.id)).posted).toBe(true)
    await flagDrop(drop)
    expect(rowOf(await backfill('adminA', true), 'deposit.drop', drop.id)).toMatchObject({ outcome: 'would_resolve' })
    expect(rowOf(await backfill('adminA', false), 'deposit.drop', drop.id)).toMatchObject({ outcome: 'resolved' })
    expect(await openFlags(drop.id)).toHaveLength(0)
    expect(await countRefs(`deposit.drop:${drop.id}`)).toBe(1)
  })

  it('a flag filed under company B for company A\'s drop is posted by neither company\'s backfill', async () => {
    const drop = await depositDrop(tenantA, 70_000, new Date())
    await flagPostingFailed({
      tenantId: tenantB, sourceType: 'deposit.drop', sourceId: drop.id,
      entityType: 'DepositDrop', entityId: drop.id, reason: 'test', title: 'misfiled',
    })
    expect(rowOf(await backfill('adminB', false), 'deposit.drop', drop.id)).toBeUndefined()
    expect(await countRefs(`deposit.drop:${drop.id}`)).toBe(0)
    expect(await openFlags(drop.id)).toHaveLength(1)
  })
})

// ─── Void-after-fire waste ───────────────────────────────────────────────────

describe('waste from a line voided after firing', () => {
  it('the older flag shape (metadata.source, no sourceType) is re-raised for review first, then re-posted through postVoidWaste — same key', async () => {
    const { o, line, log } = await voidedLine(tenantA, conceptA, 30_000, new Date(Date.now() - DAY))
    await prisma.exceptionFlag.create({
      data: {
        tenantId: tenantA, kind: 'posting_failed', severity: 'high', title: 'Waste from a voided line not posted (PERIOD_LOCKED)',
        description: 'old text: Book Dr 5040 / Cr 1210 in the open period.', entityType: 'OrderItem', entityId: line.id, conceptId: conceptA, amountCents: 30_000,
        metadata: { orderId: o.id, wasteLogIds: [log.id], source: `pos.void_waste:${line.id}`, code: 'PERIOD_LOCKED' },
      },
    })
    // A new flag is never raised beside the old one.
    await flagPostingFailed({
      tenantId: tenantA, sourceType: 'pos.void_waste', sourceId: line.id, entityType: 'OrderItem', entityId: line.id,
      reason: 'again', title: 'again', metadata: { orderId: o.id, wasteLogIds: [log.id] },
    })
    expect(await openFlags(line.id)).toHaveLength(1)

    expect(rowOf(await backfill('adminB', false), 'pos.void_waste', line.id)).toBeUndefined()
    // It told finance to book it by hand, so it is never posted straight away:
    // the first run re-raises it as a review flag (closed if it was booked by
    // hand), and only the next run posts it.
    const dry = rowOf(await backfill('adminA', true), 'pos.void_waste', line.id)
    expect(dry).toMatchObject({ outcome: 'unflagged', orderId: o.id, tenantId: tenantA })
    expect(rowOf(await backfill('adminA', false), 'pos.void_waste', line.id)).toMatchObject({ outcome: 'flagged' })
    expect(await countRefs(`pos.void_waste:${line.id}`)).toBe(0)
    const reraised = await openFlags(line.id)
    expect(reraised).toHaveLength(1)
    expect((reraised[0]!.metadata as Record<string, unknown>)['sourceType']).toBe('pos.void_waste')
    expect(rowOf(await backfill('adminA', true), 'pos.void_waste', line.id)).toMatchObject({ outcome: 'would_post', date: log.recordedAt.toISOString() })
    expect(rowOf(await backfill('adminA', false), 'pos.void_waste', line.id)).toMatchObject({ outcome: 'posted' })
    const je = await entry(tenantA, `pos.void_waste:${line.id}`)
    expect(sum(je!.lines, '5040', 'debit')).toBe(30_000)
    expect(sum(je!.lines, '1210', 'credit')).toBe(30_000)
    expect(je!.entryDate.toISOString()).toBe(log.recordedAt.toISOString())
    expect(await openFlags(line.id)).toHaveLength(0)
    // The live path's key: a second post is a no-op.
    expect((await postVoidWaste(tenantA, line.id, [log.id], conceptA)).posted).toBe(false)
    expect(await countRefs(`pos.void_waste:${line.id}`)).toBe(1)
    // The waste log itself is never booked again as a manual waste.
    const { postWasteLog } = await import('../src/modules/accounting/inventoryPosting.js')
    expect((await postWasteLog(log.id)).reason).toBe('booked_by_void')
  })

  it('a void in a closed month posts into the current month, naming the void\'s date', async () => {
    const at = new Date(Date.now() - 40 * DAY)
    const { o, line, log } = await voidedLine(tenantA, conceptA, 12_000, at)
    await flagPostingFailed({
      tenantId: tenantA, sourceType: 'pos.void_waste', sourceId: line.id, entityType: 'OrderItem', entityId: line.id,
      reason: 'PERIOD_LOCKED', title: 'Waste from a voided line not posted', conceptId: conceptA, amountCents: 12_000,
      metadata: { orderId: o.id, wasteLogIds: [log.id] },
    })
    const unlock = await lockThrough(tenantA, parsePktEndOfDay(ymd(new Date(Date.now() - 35 * DAY))))
    try {
      expect(rowOf(await backfill('adminA', false), 'pos.void_waste', line.id)).toMatchObject({ outcome: 'posted_into_current_month' })
      const je = await entry(tenantA, `pos.void_waste:${line.id}`)
      expect(je!.entryDate.getTime()).toBeGreaterThan(Date.now() - 60_000)
      for (const l of je!.lines) expect(l.memo).toContain(`dated ${ymd(at)}`)
      expect(sum(je!.lines, '5040', 'debit')).toBe(12_000)
      expect(await openFlags(line.id)).toHaveLength(0)
    } finally {
      await unlock()
    }
  })

  it('company B\'s void waste is B\'s: posted in B by B\'s backfill only', async () => {
    const { o, line, log } = await voidedLine(tenantB, conceptB, 8_000, new Date())
    await flagPostingFailed({
      tenantId: tenantB, sourceType: 'pos.void_waste', sourceId: line.id, entityType: 'OrderItem', entityId: line.id,
      reason: 'test', title: 'test', metadata: { orderId: o.id, wasteLogIds: [log.id] },
    })
    expect(rowOf(await backfill('adminA', false), 'pos.void_waste', line.id)).toBeUndefined()
    expect(await countRefs(`pos.void_waste:${line.id}`)).toBe(0)
    expect(rowOf(await backfill('adminB', false), 'pos.void_waste', line.id)).toMatchObject({ outcome: 'posted', tenantId: tenantB })
    expect(await entry(tenantB, `pos.void_waste:${line.id}`)).not.toBeNull()
    expect(await entry(tenantA, `pos.void_waste:${line.id}`)).toBeNull()
  })
})

// ─── Cancelled ticket's unwind ───────────────────────────────────────────────

describe('a cancelled ticket\'s unwind', () => {
  it('cancelOrder flags a refused unwind instead of only logging it', async () => {
    // A brand bound to no company: the unwind refuses (NO_COMPANY).
    const orphan = (await prisma.concept.create({ data: { name: 'No Company Diner', slug: `posting-failures-orphan-${Date.now()}`, type: 'restaurant' } })).id
    const o = await order(orphan, 'received')
    await cancelOrder(o.id, { reason: 'guest left', actor: { id: users.adminA!.id } })
    const flags = await openFlags(o.id)
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ entityType: 'Order' })
    expect(flags[0]!.metadata).toMatchObject({ sourceType: 'order.cancel_unwind', sourceId: o.id })
  })

  it('the backfill closes an unwind flag with nothing left to undo, and one whose order is not cancelled', async () => {
    const cancelled = await order(conceptA, 'cancelled')
    const live = await order(conceptA, 'completed')
    for (const o of [cancelled, live]) {
      await flagPostingFailed({
        tenantId: tenantA, sourceType: 'order.cancel_unwind', sourceId: o.id, entityType: 'Order', entityId: o.id, reason: 'test', title: 'test',
      })
    }
    expect(rowOf(await backfill('adminB', false), 'order.cancel_unwind', cancelled.id)).toBeUndefined()
    const dry = await backfill('adminA', true)
    expect(rowOf(dry, 'order.cancel_unwind', cancelled.id)).toMatchObject({ outcome: 'would_post', orderId: cancelled.id })
    expect(rowOf(dry, 'order.cancel_unwind', live.id)).toMatchObject({ outcome: 'would_resolve' })
    const run = await backfill('adminA', false)
    expect(rowOf(run, 'order.cancel_unwind', cancelled.id)).toMatchObject({ outcome: 'resolved' })
    expect(rowOf(run, 'order.cancel_unwind', live.id)).toMatchObject({ outcome: 'resolved' })
    expect(await openFlags(cancelled.id)).toHaveLength(0)
    expect(await openFlags(live.id)).toHaveLength(0)
    expect(await countRefs(`order.cancel_unwind:${cancelled.id}`)).toBe(0)
  })
})

// ─── Till card failed after its close ────────────────────────────────────────

describe('a till card the gateway fails after the drawer closed', () => {
  async function closedDrawerWithCard(ref: string, postClose: boolean) {
    const cashier = await prisma.user.create({
      data: { name: `till ${ref}`, email: `${ref.toLowerCase()}.postingfailures@test.local`, password: 'x', role: 'cashier', isActive: true, accountStatus: 'active', tenantId: tenantA },
    })
    const shift = await prisma.shift.create({ data: { userId: cashier.id, tenantId: tenantA, status: 'closed', closedAt: new Date(), openingFloatCents: 0, closingFloatCents: 0 } })
    const o = await order(conceptA, 'completed', 45_000)
    const card = await prisma.payment.create({
      data: { orderId: o.id, shiftId: shift.id, method: 'card', amountCents: 45_000, status: 'pending', gateway: 'keenu', gatewayRef: ref },
    })
    const bookClose = () => postJournalEntry({
      tenantId: tenantA, sourceType: 'shift.close', sourceId: shift.id, description: 'test close',
      lines: [
        { accountCode: '1030', type: 'debit', amountCents: 45_000 },
        { accountCode: '4090', type: 'credit', amountCents: 45_000 },
      ],
    })
    if (postClose) await bookClose()
    return { o, card, bookClose }
  }

  it('a refused move to 1110 is flagged in the drawer\'s company; the backfill posts Dr 1110 / Cr 1030 once', async () => {
    const { o, card } = await closedDrawerWithCard('KN-PF-1', true)
    await setActive(tenantA, '1110', false)
    try {
      expect(await applyKeenuCallback({ orderId: o.id, transactionId: 'KN-PF-1', status: 'FAILED' }, { error: () => {} }))
        .toMatchObject({ result: 'failed', paymentIds: [card.id] })
    } finally {
      await setActive(tenantA, '1110', true)
    }
    expect(await countRefs(`pos.card_failed:${card.id}`)).toBe(0)
    const flags = await openFlags(card.id)
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ tenantId: tenantA, entityType: 'Payment', amountCents: 45_000 })
    expect(flags[0]!.metadata).toMatchObject({ sourceType: 'pos.card_failed', sourceId: card.id, orderId: o.id })

    expect(rowOf(await backfill('adminB', false), 'pos.card_failed', card.id)).toBeUndefined()
    expect(rowOf(await backfill('adminA', false), 'pos.card_failed', card.id)).toMatchObject({ outcome: 'posted', orderId: o.id })
    const je = await entry(tenantA, `pos.card_failed:${card.id}`)
    expect(sum(je!.lines, '1110', 'debit')).toBe(45_000)
    expect(sum(je!.lines, '1030', 'credit')).toBe(45_000)
    expect(await openFlags(card.id)).toHaveLength(0)
    expect(rowOf(await backfill('adminA', false), 'pos.card_failed', card.id)).toBeUndefined()
    expect(await countRefs(`pos.card_failed:${card.id}`)).toBe(1)
  })

  it('a drawer booked AFTER the card failed already holds it as owed: the flag is closed, nothing moves', async () => {
    const { card, bookClose } = await closedDrawerWithCard('KN-PF-2', false)
    await prisma.payment.update({ where: { id: card.id }, data: { status: 'failed' } })
    await flagPostingFailed({
      tenantId: tenantA, sourceType: 'pos.card_failed', sourceId: card.id, entityType: 'Payment', entityId: card.id, reason: 'test', title: 'test',
    })
    await new Promise((r) => setTimeout(r, 20))
    await bookClose()
    const run = await backfill('adminA', false)
    expect(rowOf(run, 'pos.card_failed', card.id)).toMatchObject({ outcome: 'resolved' })
    expect(await countRefs(`pos.card_failed:${card.id}`)).toBe(0)
    expect(await openFlags(card.id)).toHaveLength(0)
  })
})

// ─── Misses nothing flagged ──────────────────────────────────────────────────

describe('the sweep for misses nothing flagged', () => {
  it('a deposit with no entry and no flag: A\'s preview lists it (B\'s does not); Post flags it; the next run posts it', async () => {
    const drop = await depositDrop(tenantA, 120_000, new Date())
    expect(rowOf(await backfill('adminB', true), 'deposit.drop', drop.id)).toBeUndefined()
    expect(rowOf(await backfill('adminA', true), 'deposit.drop', drop.id)).toMatchObject({ outcome: 'unflagged', tenantId: tenantA })
    expect(await openFlags(drop.id)).toHaveLength(0)

    expect(rowOf(await backfill('adminA', false), 'deposit.drop', drop.id)).toMatchObject({ outcome: 'flagged' })
    expect(await countRefs(`deposit.drop:${drop.id}`)).toBe(0)
    const flags = await openFlags(drop.id)
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ tenantId: tenantA, entityType: 'DepositDrop' })

    expect(rowOf(await backfill('adminA', true), 'deposit.drop', drop.id)).toMatchObject({ outcome: 'would_post' })
    expect(rowOf(await backfill('adminA', false), 'deposit.drop', drop.id)).toMatchObject({ outcome: 'posted' })
    expect(await countRefs(`deposit.drop:${drop.id}`)).toBe(1)
    expect(await openFlags(drop.id)).toHaveLength(0)
  })

  it('a flag a person closed (booked by hand) is never swept again or posted', async () => {
    const drop = await depositDrop(tenantA, 60_000, new Date())
    await flagDrop(drop)
    await prisma.exceptionFlag.updateMany({ where: { entityId: drop.id }, data: { status: 'dismissed', resolution: 'booked by hand' } })
    const rows = await backfill('adminA', false)
    expect(rowOf(rows, 'deposit.drop', drop.id)).toBeUndefined()
    expect(await countRefs(`deposit.drop:${drop.id}`)).toBe(0)
  })

  it('a non-void waste with no entry is swept; a void-after-fire waste log never is (it is booked with its line)', async () => {
    const beef = await inventoryItem(tenantA, 'Brisket', 150_000)
    const manual = await prisma.wasteLog.create({ data: { inventoryItemId: beef.id, quantity: 0.2, unit: 'kg', reason: 'spoilage', estimatedCostCents: 30_000 } })
    const { log } = await voidedLine(tenantA, conceptA, 9_000, new Date())
    const rows = await backfill('adminA', true)
    expect(rowOf(rows, 'inventory.waste', manual.id)).toMatchObject({ outcome: 'unflagged' })
    expect(rowOf(rows, 'inventory.waste', log.id)).toBeUndefined()
  })
})
