// COD custody (H5) — the pay-in hook in pos/service.ts settlePayment.
//
// When a rider hands in delivered cash that finance had booked as owed by the
// rider (accounting/codPosting.ts), settling the pending cash row at the till
// reverses that debt:
//   - own rider: 'cod.rider_debt.reversal:<paymentId>' Dr 1010 / Cr 1351 in
//     the order's company, inside the pay-in's transaction;
//   - fleet rider of another company: the inter-company 'cod' transfer is
//     reversed in both books after the pay-in commits;
//   - a period closed through today: the pay-in still succeeds, the reversal
//     is flagged posting_failed 'cod.rider_debt.reversal' (entity Payment), and
//     the re-poster posts it once the period is open again.
// A COD row with no booked debt settles exactly as before (no entry, no flag).
//
// Two companies, both with code-only delivery on. Requires a disposable
// database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { DELIVERY_CODE_ONLY_SETTING } = await import('../src/lib/deliveryRules.js')
const posting = await import('../src/modules/accounting/codPosting.js')
const { settlePayment } = await import('../src/modules/pos/service.js')

const RUN = randomBytes(3).toString('hex')
const DAY = 86_400_000
let A: string, B: string
let brandA: string, brandB: string
let riderA: string, riderB: string
let finA: { id: string }, finAB: { id: string }, cashierA: { id: string }
let drawerA: string

async function mkTenant(name: string): Promise<string> {
  const id = (await prisma.tenant.create({ data: { name, slug: `cs-${RUN}-${name.toLowerCase().replace(/\s+/g, '-')}` } })).id
  await ensureChartOfAccounts(id)
  return id
}
async function mkUser(key: string, role: string, tenants: string[]) {
  return prisma.user.create({
    data: {
      name: `cs ${key}`, email: `cs.${key}.${RUN}@cod.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as 'finance', tenantId: tenants[0]!, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((t) => ({ tenant: { connect: { id: t } }, role: 'manager' })) },
    },
    select: { id: true, role: true },
  })
}

let seq = 0
/** A delivered COD order of A with its pending cash row; its sale on the books. */
async function mkCod(riderId: string): Promise<{ orderId: string; paymentId: string; amount: number }> {
  seq += 1
  const amount = 230_000 + seq
  const now = new Date()
  const order = await prisma.order.create({
    data: {
      conceptId: brandA, source: 'servd', fulfilmentType: 'delivery', status: 'completed', totalCents: amount,
      customerName: `Customer ${seq}`, riderId, deliveryOtpVerifiedAt: now, completedAt: now, deliveredAt: now,
    },
  })
  const p = await prisma.payment.create({ data: { orderId: order.id, method: 'cash', amountCents: amount, status: 'pending' } })
  await prisma.journalEntry.create({ data: { tenantId: A, reference: `order.complete:${order.id}`, description: 'test sale' } })
  return { orderId: order.id, paymentId: p.id, amount }
}

async function entryLines(tenantId: string, reference: string) {
  const e = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return e ? e.lines.map((l) => ({ code: l.account.code, type: l.type, cents: Number(l.amountCents), conceptId: l.conceptId })) : null
}

const payIn = (paymentId: string, amount: number) =>
  settlePayment({ paymentId, via: 'till', shiftId: drawerA, tenderedCents: amount, actorId: cashierA.id })

const openFlags = (paymentId: string) => prisma.exceptionFlag.findMany({
  where: { kind: 'posting_failed', entityType: 'Payment', entityId: paymentId, status: 'open' },
})

beforeAll(async () => {
  A = await mkTenant('Settle Alpha')
  B = await mkTenant('Settle Beta')
  brandA = (await prisma.concept.create({ data: { name: 'Settle A', slug: `cs-${RUN}-a`, type: 'restaurant', tenantId: A } })).id
  brandB = (await prisma.concept.create({ data: { name: 'Settle B', slug: `cs-${RUN}-b`, type: 'restaurant', tenantId: B } })).id
  void brandB
  riderA = (await prisma.rider.create({ data: { name: 'Own Rider', phone: `92321${Date.now() % 10_000_000}`, tenantId: A } })).id
  riderB = (await prisma.rider.create({ data: { name: 'Fleet Rider', phone: `92322${Date.now() % 10_000_000}`, tenantId: B } })).id
  finA = await mkUser('fin-a', 'finance', [A])
  finAB = await mkUser('fin-ab', 'finance', [A, B])
  cashierA = await mkUser('cashier-a', 'cashier', [A])
  for (const t of [A, B]) {
    await prisma.setting.create({ data: { key: `${DELIVERY_CODE_ONLY_SETTING}:${t}`, value: new Date(Date.now() - DAY).toISOString() } })
  }
  drawerA = (await prisma.shift.create({ data: { userId: cashierA.id, tenantId: A, status: 'open', openingFloatCents: 0 } })).id
}, 60_000)

async function book(paymentId: string, actor: { id: string; role: string; memberTenantIds: string[] }) {
  return posting.bookCodRiderDebt({ paymentId, reason: 'rider kept the cash overnight', actor })
}

describe('settling a COD row whose rider debt was booked', () => {
  it('own rider: the pay-in posts the reversal Dr 1010 / Cr 1351 in the order\'s company', async () => {
    const x = await mkCod(riderA)
    const booked = await book(x.paymentId, { id: finA.id, role: 'finance', memberTenantIds: [A] })
    expect(booked).toMatchObject({ ok: true })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: x.paymentId } })).codRiderDebtEntryId).toBeTruthy()

    const r = await payIn(x.paymentId, x.amount)
    expect(r.payment.status).toBe('paid')
    expect(r.payment.shiftId).toBe(drawerA)
    expect(await entryLines(A, `cod.rider_debt.reversal:${x.paymentId}`)).toEqual(expect.arrayContaining([
      { code: '1010', type: 'debit', cents: x.amount, conceptId: brandA },
      { code: '1351', type: 'credit', cents: x.amount, conceptId: brandA },
    ]))
    expect(await prisma.journalEntry.count({ where: { tenantId: B } })).toBe(0)
    expect(await openFlags(x.paymentId)).toHaveLength(0)
    // A replayed settle changes nothing.
    const again = await payIn(x.paymentId, x.amount)
    expect(again.alreadySettled).toBe(true)
    expect(await prisma.journalEntry.count({ where: { reference: `cod.rider_debt.reversal:${x.paymentId}` } })).toBe(1)
  })

  it('fleet rider of B: the inter-company transfer is reversed in both books after the pay-in', async () => {
    const x = await mkCod(riderB)
    const booked = await book(x.paymentId, { id: finAB.id, role: 'finance', memberTenantIds: [A, B] })
    expect(booked).toMatchObject({ ok: true })
    const transferId = (await prisma.payment.findUniqueOrThrow({ where: { id: x.paymentId } })).codRiderDebtTransferId
    expect(transferId).toBeTruthy()

    const r = await payIn(x.paymentId, x.amount)
    expect(r.payment.status).toBe('paid')
    const t = await prisma.intercompanyTransfer.findUniqueOrThrow({ where: { id: transferId! } })
    expect(t.status).toBe('reversed')
    expect(await prisma.journalEntry.count({ where: { tenantId: A, reference: `ic.transfer.reversal:${transferId}` } })).toBe(1)
    expect(await prisma.journalEntry.count({ where: { tenantId: B, reference: `ic.transfer.reversal:${transferId}` } })).toBe(1)
    expect(await prisma.journalEntry.count({ where: { reference: `cod.rider_debt.reversal:${x.paymentId}` } })).toBe(0)
    expect(await openFlags(x.paymentId)).toHaveLength(0)
  })

  it('a closed period: the pay-in still succeeds, the reversal is flagged, and the re-poster posts it later', async () => {
    const x = await mkCod(riderA)
    expect(await book(x.paymentId, { id: finA.id, role: 'finance', memberTenantIds: [A] })).toMatchObject({ ok: true })
    const lock = await prisma.periodLock.create({ data: { tenantId: A, lockedThrough: new Date(Date.now() + DAY), lockedBy: finA.id } })
    try {
      const r = await payIn(x.paymentId, x.amount)
      expect(r.payment.status).toBe('paid')
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: x.paymentId } })).status).toBe('paid')
    expect(await prisma.journalEntry.count({ where: { reference: `cod.rider_debt.reversal:${x.paymentId}` } })).toBe(0)
    const flags = await openFlags(x.paymentId)
    expect(flags).toHaveLength(1)
    expect(flags[0]!.tenantId).toBe(A)
    expect(flags[0]!.metadata).toMatchObject({ sourceType: 'cod.rider_debt.reversal', sourceId: x.paymentId })

    // Once the period is open again the re-poster (registered under
    // 'cod.rider_debt.reversal' in reconciliation/backfillOrders.ts) posts it.
    const doc = await posting.codRiderDebtReversalReposter.load(x.paymentId, null)
    expect(doc).toMatchObject({ tenantId: A, amountCents: x.amount })
    expect(doc!.nothingOwed).toBeUndefined()
    const res = await doc!.post({ postedBy: finA.id })
    expect(res.posted).toBe(true)
    expect(await entryLines(A, `cod.rider_debt.reversal:${x.paymentId}`)).toEqual(expect.arrayContaining([
      { code: '1010', type: 'debit', cents: x.amount, conceptId: brandA },
      { code: '1351', type: 'credit', cents: x.amount, conceptId: brandA },
    ]))
  })

  it('a COD row with no booked debt settles as before: no reversal, no flag', async () => {
    const x = await mkCod(riderA)
    const r = await payIn(x.paymentId, x.amount)
    expect(r.payment.status).toBe('paid')
    expect(await prisma.journalEntry.count({ where: { reference: `cod.rider_debt.reversal:${x.paymentId}` } })).toBe(0)
    expect(await openFlags(x.paymentId)).toHaveLength(0)
  })
})
