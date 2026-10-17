// Loyalty revaluation (owner, 2026-10-17: "Yes to loyalty revaluation"; H48 —
// points are valued at TODAY's point value). A change of a company's point
// value posts ONE entry 'loyalty.revalue:<auditId>' in that company's books:
// rise Dr 6060 / Cr 2060, fall Dr 2060 / Cr 6060, for the points in 2060 ×
// (new − old). So the 2060 tie-out (intercompany/legacy.ts controlTieOut)
// stays clean after a change.
//   - rise and fall post the right entry; the tie-out is clean after each
//   - no change (same value, or another key) → no entry
//   - two companies: A's change posts only in A; B's books untouched
//   - the route's existing rule stands: a login outside it cannot change the value
//   - a refused posting (closed books) is flagged; the backfill re-poster books
//     the STORED delta once
//   - a reversal after a value change moves 2060 at TODAY's value; the other
//     side mirrors the original; the difference goes to 6060 (same value →
//     the plain mirror)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { loyaltyRoutes } from '../src/modules/loyalty/routes.js'
import { postLoyaltyEarn, postLoyaltyRedeem, postLoyaltyReversal } from '../src/modules/accounting/loyaltyPosting.js'
import { controlTieOut } from '../src/modules/intercompany/legacy.js'
import { backfillUnpostedOrders } from '../src/modules/reconciliation/backfillOrders.js'
import { invalidateLoyaltySettings } from '../src/lib/loyaltySettings.js'

const P = `lrv${Date.now()}`
let A: string
let B: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({
    method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    headers: { authorization: `Bearer ${users[who]!.token}` },
  })

const setValue = (who: string, v: number) => call(who, 'PATCH', '/loyalty/settings', { 'loyalty.point_value_cents': v })

let cust = 0
/** A customer of `tenantId` who earned `earn` points (booked) and redeemed `redeem` (booked). */
async function customerWithPoints(tenantId: string, earn: number, redeem = 0) {
  const c = await prisma.customer.create({ data: { name: `Cust ${cust}`, phone: `92300${String(Date.now()).slice(-6)}${cust++}` } })
  const acc = await prisma.loyaltyAccount.create({ data: { tenantId, customerId: c.id, pointsBalance: earn - redeem, lifetimePoints: earn } })
  const e = await prisma.loyaltyTransaction.create({ data: { loyaltyAccountId: acc.id, type: 'earn', pointsDelta: earn } })
  expect((await postLoyaltyEarn(e.id)).posted).toBe(true)
  if (redeem > 0) {
    const r = await prisma.loyaltyTransaction.create({ data: { loyaltyAccountId: acc.id, type: 'redeem', pointsDelta: -redeem } })
    expect((await postLoyaltyRedeem(r.id)).posted).toBe(true)
  }
  return acc.id
}

async function revalueEntries(tenantId: string) {
  return prisma.journalEntry.findMany({
    where: { tenantId, reference: { startsWith: 'loyalty.revalue:' } },
    include: { lines: { include: { account: { select: { code: true } } } } },
    orderBy: { createdAt: 'asc' },
  })
}
const shape = (e: Awaited<ReturnType<typeof revalueEntries>>[number]) =>
  e.lines.map((l) => `${l.account.code} ${l.type} ${Number(l.amountCents)}`).sort()

async function tie2060(tenantId: string) {
  const t = await controlTieOut(prisma as never, tenantId, new Date(Date.now() + 1000))
  return t.rows.find((r) => r.code === '2060')!
}

async function ledgerAll(tenantId: string) {
  return prisma.journalEntry.count({ where: { tenantId } })
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'LRV A', slug: `${P}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: 'LRV B', slug: `${P}-b` } })).id
  for (const t of [A, B]) await ensureChartOfAccounts(t)
  await mkUser('ceoA', 'admin', A, [A])
  await mkUser('ceoB', 'admin', B, [B])
  await mkUser('cashierA', 'cashier', A, [A])
  await mkUser('finA', 'finance', A, [A])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(loyaltyRoutes, { prefix: '/loyalty' })
  await app.ready()

  // A: 1,000 earned, 200 redeemed → 800 outstanding at PKR 0.10 (default). B: 500 outstanding.
  await customerWithPoints(A, 1_000, 200)
  await customerWithPoints(B, 500)
}, 60_000)

afterAll(async () => {
  await app?.close()
  invalidateLoyaltySettings()
})

describe('loyalty revaluation', () => {
  it('starts tied: 2060 = 800 × 10 in A, 500 × 10 in B', async () => {
    expect((await tie2060(A))).toMatchObject({ ledgerCents: 8_000, subledgerCents: 8_000, differenceCents: 0 })
    expect((await tie2060(B))).toMatchObject({ ledgerCents: 5_000, differenceCents: 0 })
  })

  it('a rise (10 → 25) posts Dr 6060 / Cr 2060 for 800 × 15 in A only; the tie-out is clean', async () => {
    const bBefore = await ledgerAll(B)
    const res = await setValue('ceoA', 25)
    expect(res.statusCode, res.body).toBe(200)
    const es = await revalueEntries(A)
    expect(es).toHaveLength(1)
    expect(shape(es[0]!)).toEqual(['2060 credit 12000', '6060 debit 12000'])
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { id: es[0]!.reference!.split(':')[1]!, action: 'loyalty.revalue' } })
    expect(audit.tenantId).toBe(A)
    expect(audit.userId).toBe(users['ceoA']!.id)
    expect(audit.metadata).toMatchObject({ oldValueCents: 10, newValueCents: 25, points: 800, deltaCents: 12_000, posted: true })
    expect(await tie2060(A)).toMatchObject({ ledgerCents: 20_000, subledgerCents: 20_000, differenceCents: 0 })
    // B untouched
    expect(await ledgerAll(B)).toBe(bBefore)
    expect(await revalueEntries(B)).toHaveLength(0)
    expect(await tie2060(B)).toMatchObject({ ledgerCents: 5_000, differenceCents: 0 })
  })

  it('a fall (25 → 20) posts Dr 2060 / Cr 6060 for 800 × 5; the tie-out is clean', async () => {
    expect((await setValue('ceoA', 20)).statusCode).toBe(200)
    const es = await revalueEntries(A)
    expect(es).toHaveLength(2)
    expect(shape(es[1]!)).toEqual(['2060 debit 4000', '6060 credit 4000'])
    expect(await tie2060(A)).toMatchObject({ ledgerCents: 16_000, subledgerCents: 16_000, differenceCents: 0 })
  })

  it('an earn after the change posts at the new value and the tie-out stays clean', async () => {
    await customerWithPoints(A, 300)
    expect(await tie2060(A)).toMatchObject({ ledgerCents: 22_000, subledgerCents: 22_000, differenceCents: 0 })
  })

  it('no change → no entry (the same value again; another key)', async () => {
    const before = await ledgerAll(A)
    expect((await setValue('ceoA', 20)).statusCode).toBe(200)
    expect((await call('ceoA', 'PATCH', '/loyalty/settings', { 'loyalty.min_redeem_points': 75 })).statusCode).toBe(200)
    expect(await ledgerAll(A)).toBe(before)
    expect(await prisma.auditLog.count({ where: { tenantId: A, action: 'loyalty.revalue' } })).toBe(2)
  })

  it('B changes its own value: posts in B (500 × 2) only; A untouched', async () => {
    const aBefore = await ledgerAll(A)
    expect((await setValue('ceoB', 12)).statusCode).toBe(200)
    const es = await revalueEntries(B)
    expect(es).toHaveLength(1)
    expect(shape(es[0]!)).toEqual(['2060 credit 1000', '6060 debit 1000'])
    expect(await ledgerAll(A)).toBe(aBefore)
    expect(await tie2060(B)).toMatchObject({ ledgerCents: 6_000, differenceCents: 0 })
    expect(await tie2060(A)).toMatchObject({ differenceCents: 0 })
  })

  it('a login outside the route\'s rule (cashier, finance) still cannot change the value; nothing posts', async () => {
    const before = await ledgerAll(A)
    for (const who of ['cashierA', 'finA']) {
      expect((await setValue(who, 50)).statusCode, who).toBe(403)
    }
    expect(await ledgerAll(A)).toBe(before)
    const v = (await call('ceoA', 'GET', '/loyalty/settings')).json().values['loyalty.point_value_cents']
    expect(v).toBe(20)
  })

  it('a refused posting (books closed through tomorrow) keeps the change, is flagged, and the re-poster books the stored delta once', async () => {
    const lock = await prisma.periodLock.create({ data: { tenantId: A, lockedThrough: new Date(Date.now() + 36 * 3600_000), lockedBy: users['ceoA']!.id } })
    const before = await revalueEntries(A)
    const res = await setValue('ceoA', 30)
    expect(res.statusCode, res.body).toBe(200)
    expect((await call('ceoA', 'GET', '/loyalty/settings')).json().values['loyalty.point_value_cents']).toBe(30)
    expect(await revalueEntries(A)).toHaveLength(before.length)
    const rec = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: A, action: 'loyalty.revalue' }, orderBy: { createdAt: 'desc' } })
    // 1,100 points in 2060 × (30 − 20)
    expect(rec.metadata).toMatchObject({ oldValueCents: 20, newValueCents: 30, points: 1_100, deltaCents: 11_000, posted: false })
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { tenantId: A, kind: 'posting_failed', entityType: 'LoyaltyRevaluation', entityId: rec.id } })
    expect(flag.status).toBe('open')
    expect((flag.metadata as Record<string, unknown>)['documentDate']).toBeTruthy()
    expect((flag.metadata as Record<string, unknown>)['sourceType']).toBe('loyalty.revalue')

    // The tie-out shows the difference until it posts.
    expect((await tie2060(A)).differenceCents).toBe(-11_000)

    // A later earn changes the points — the re-poster must NOT recompute.
    await prisma.periodLock.delete({ where: { id: lock.id } })
    await customerWithPoints(A, 100)

    const run = await backfillUnpostedOrders({ tenantIds: [A], dryRun: false, postedBy: users['ceoA']!.id })
    const row = run.rows.find((r) => r.kind === 'loyalty.revalue')
    expect(row?.outcome, JSON.stringify(run.rows)).toBe('posted')
    const after = await revalueEntries(A)
    expect(after).toHaveLength(before.length + 1)
    expect(shape(after.at(-1)!)).toEqual(['2060 credit 11000', '6060 debit 11000'])
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: flag.id } })).status).toBe('resolved')
    expect(await tie2060(A)).toMatchObject({ differenceCents: 0 })

    // Once only.
    const again = await backfillUnpostedOrders({ tenantIds: [A], dryRun: false, postedBy: users['ceoA']!.id })
    expect(again.rows.find((r) => r.kind === 'loyalty.revalue')).toBeUndefined()
    expect(await revalueEntries(A)).toHaveLength(before.length + 1)
  })
})

describe('reversals after a value change (2060 at today\'s value)', () => {
  async function account(tenantId: string) {
    const c = await prisma.customer.create({ data: { name: `Rev ${cust}`, phone: `92311${String(Date.now()).slice(-6)}${cust++}` } })
    return (await prisma.loyaltyAccount.create({ data: { tenantId, customerId: c.id } })).id
  }
  async function earn(accId: string, pts: number) {
    const t = await prisma.loyaltyTransaction.create({ data: { loyaltyAccountId: accId, type: 'earn', pointsDelta: pts } })
    await prisma.loyaltyAccount.update({ where: { id: accId }, data: { pointsBalance: { increment: pts } } })
    expect((await postLoyaltyEarn(t.id)).posted).toBe(true)
    return t.id
  }
  async function redeem(accId: string, pts: number) {
    const t = await prisma.loyaltyTransaction.create({ data: { loyaltyAccountId: accId, type: 'redeem', pointsDelta: -pts } })
    await prisma.loyaltyAccount.update({ where: { id: accId }, data: { pointsBalance: { decrement: pts } } })
    expect((await postLoyaltyRedeem(t.id)).posted).toBe(true)
    return t.id
  }
  /** The refund / cancel: claim the transaction, undo its points, reverse its entry — one transaction. */
  async function reverse(txId: string) {
    return prisma.$transaction(async (db) => {
      const t = await db.loyaltyTransaction.update({ where: { id: txId }, data: { reversedAt: new Date() } })
      await db.loyaltyAccount.update({ where: { id: t.loyaltyAccountId }, data: { pointsBalance: { increment: -t.pointsDelta } } })
      await db.loyaltyTransaction.create({ data: { loyaltyAccountId: t.loyaltyAccountId, type: 'reversal', pointsDelta: -t.pointsDelta } })
      return postLoyaltyReversal(txId, { tx: db, reason: 'test' })
    })
  }
  async function reversalShape(tenantId: string, kind: 'earn' | 'redeem', txId: string) {
    const e = await prisma.journalEntry.findFirstOrThrow({
      where: { tenantId, reference: `loyalty.${kind}.reversal:${txId}` },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    return e.lines.map((l) => `${l.account.code} ${l.type} ${Number(l.amountCents)}`).sort()
  }

  it('earn before a rise, refund after: Dr 2060 at today\'s value, Cr 6060 the original + the difference; tie-out clean', async () => {
    expect((await setValue('ceoA', 30)).statusCode).toBe(200)   // already 30: no entry
    const acc = await account(A)
    const e = await earn(acc, 400)                              // Dr 6060 / Cr 2060 12,000
    expect((await setValue('ceoA', 40)).statusCode).toBe(200)   // revalued: +4,000 on these points
    expect(await tie2060(A)).toMatchObject({ differenceCents: 0 })
    const bBefore = await ledgerAll(B)
    expect((await reverse(e)).posted).toBe(true)
    expect(await reversalShape(A, 'earn', e)).toEqual(['2060 debit 16000', '6060 credit 12000', '6060 credit 4000'])
    expect(await tie2060(A)).toMatchObject({ differenceCents: 0 })
    expect(await ledgerAll(B)).toBe(bBefore)
  })

  it('redemption before a fall, cancel after: Cr 2060 at today\'s value, Dr 7020 the original, the difference to 6060; tie-out clean', async () => {
    const acc = await account(A)
    await earn(acc, 500)
    const r = await redeem(acc, 200)                            // Dr 2060 / Cr 7020 8,000 at 40
    expect((await setValue('ceoA', 35)).statusCode).toBe(200)
    expect(await tie2060(A)).toMatchObject({ differenceCents: 0 })
    const bBefore = await ledgerAll(B)
    expect((await reverse(r)).posted).toBe(true)
    expect(await reversalShape(A, 'redeem', r)).toEqual(['2060 credit 7000', '6060 credit 1000', '7020 debit 8000'])
    expect(await tie2060(A)).toMatchObject({ differenceCents: 0 })
    expect(await ledgerAll(B)).toBe(bBefore)
    expect(await tie2060(B)).toMatchObject({ differenceCents: 0 })
  })

  it('same value: the plain mirror', async () => {
    const acc = await account(A)
    const e = await earn(acc, 100)                              // at 35
    expect((await reverse(e)).posted).toBe(true)
    expect(await reversalShape(A, 'earn', e)).toEqual(['2060 debit 3500', '6060 credit 3500'])
    expect(await tie2060(A)).toMatchObject({ differenceCents: 0 })
  })

  it('B: a reversal after B\'s own change posts in B only; A untouched', async () => {
    const acc = await account(B)
    const e = await earn(acc, 100)                              // at 12
    expect((await setValue('ceoB', 15)).statusCode).toBe(200)
    const aBefore = await ledgerAll(A)
    expect((await reverse(e)).posted).toBe(true)
    expect(await reversalShape(B, 'earn', e)).toEqual(['2060 debit 1500', '6060 credit 1200', '6060 credit 300'])
    expect(await ledgerAll(A)).toBe(aBefore)
    expect(await tie2060(B)).toMatchObject({ differenceCents: 0 })
    expect(await tie2060(A)).toMatchObject({ differenceCents: 0 })
  })
})
