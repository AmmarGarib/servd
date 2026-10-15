// On-account daily flags (workers/onAccountDaily.ts) and the on-account
// period-close check (accounting/onAccountCloseChecks.ts).
//
//   overdue    one on_account_overdue flag per client statement / invoice past
//              its Karachi due day + grace; 'high' after 30 days; refreshed,
//              never duplicated; resolved once the balance is ≤ 0;
//   unbilled   one on_account_unbilled flag per client with BOOKED charges
//              older than 35 days on no statement; an unbooked charge is not
//              flagged; resolved once billed;
//   companies  every flag carries the document's company; company B's run
//              never touches A's rows and B never sees A's flags;
//   close      on_account_tieout warns (overridable) only after the
//              till-clearing cut-over: a tie-out difference, unexplained 1110
//              lines in the period, booked charges unbilled > 35 days.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import type { CustomerAccount, Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry, ON_ACCOUNT_MEMO } from '../src/modules/accounting/journal.js'
import { tillClearingCutoverKey } from '../src/modules/accounting/tillClearingCode.js'
import {
  runOnAccountDailyForTenant, runOnAccountDailyOnce, OVERDUE_KIND, UNBILLED_KIND,
} from '../src/workers/onAccountDaily.js'
import { onAccountCloseChecks, onAccountTieoutCheck } from '../src/modules/accounting/onAccountCloseChecks.js'
import type { CloseCheckContext } from '../src/modules/accounting/closeCheckTypes.js'

const RUN = Math.random().toString(36).slice(2, 8)
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)

let tenantA: string, tenantB: string, conceptA: string, conceptB: string, userA: string, userB: string
let seq = 0

async function mkTenant(tag: string) {
  const t = (await prisma.tenant.create({ data: { name: `OAD ${tag}`, slug: `oad-${tag}-${RUN}` } })).id
  await ensureChartOfAccounts(t)
  const c = (await prisma.concept.create({ data: { name: `Kitchen ${tag}`, slug: `oad-${tag}-${RUN}`, type: 'restaurant', tenantId: t, province: 'SD' } })).id
  const u = (await prisma.user.create({ data: { name: tag, email: `oad.${tag}.${RUN}@oa.test`, password: 'x', role: 'finance', isActive: true, tenantId: t } })).id
  return { t, c, u }
}

async function mkAccount(tenantId: string, createdById: string, extra: Partial<Prisma.CustomerAccountUncheckedCreateInput> = {}): Promise<CustomerAccount> {
  seq++
  return prisma.customerAccount.create({
    data: { tenantId, number: `OA-${RUN}-${seq}`, legalName: `Client ${RUN} ${seq}`, creditLimitCents: 1_000_000, status: 'active', createdById, overdueGraceDays: 7, ...extra },
  })
}

async function mkBill(tenantId: string, accountId: string, opts: { total: number; dueDaysAgo: number; paid?: number; kind?: string }) {
  seq++
  return prisma.receivableInvoice.create({
    data: {
      tenantId, customerAccountId: accountId, kind: opts.kind ?? 'statement', number: `AR-ST-D-${RUN}-${seq}`, customerName: 'Client',
      issueDate: ago(opts.dueDaysAgo + 30), dueDate: ago(opts.dueDaysAgo), description: 'Statement',
      amountCents: opts.total, taxCents: 0, paidCents: opts.paid ?? 0, status: (opts.paid ?? 0) >= opts.total ? 'paid' : 'open',
    },
  })
}

/** A charge on a non-till order; booked = its order.complete entry Dr 1110 (ON ACCOUNT memo) / Cr revenue. */
async function mkCharge(tenantId: string, conceptId: string, account: CustomerAccount, amountCents: number, opts: { daysAgo: number; booked: boolean; userId: string }) {
  const o = await prisma.order.create({ data: { conceptId, source: 'servd', fulfilmentType: 'dine_in', status: 'completed', totalCents: amountCents, taxRatePct: 15 } })
  const p = await prisma.payment.create({ data: { orderId: o.id, method: 'on_account', amountCents, status: 'paid' } })
  const charge = await prisma.customerAccountCharge.create({
    data: { tenantId, accountId: account.id, orderId: o.id, paymentId: p.id, conceptId, amountCents, chargedById: opts.userId, chargedAt: ago(opts.daysAgo) },
  })
  if (opts.booked) {
    await postJournalEntry({
      tenantId, sourceType: 'order.complete', sourceId: o.id, description: 'On-account sale', entryDate: ago(opts.daysAgo),
      lines: [
        { accountCode: '1110', type: 'debit', amountCents, conceptId, memo: `${ON_ACCOUNT_MEMO} — ${account.number}` },
        { accountCode: '4001', type: 'credit', amountCents, conceptId },
      ],
    })
  }
  return charge
}

const openFlags = (tenantId: string, kind: string) =>
  prisma.exceptionFlag.findMany({ where: { tenantId, kind, status: { in: ['open', 'acknowledged'] } } })

beforeAll(async () => {
  ;({ t: tenantA, c: conceptA, u: userA } = await mkTenant('a'))
  ;({ t: tenantB, c: conceptB, u: userB } = await mkTenant('b'))
})

describe('daily on-account flags', () => {
  it('flags overdue bills per company (high after 30 days), never twice, and resolves them once paid', async () => {
    const acct = await mkAccount(tenantA, userA)
    const late10 = await mkBill(tenantA, acct.id, { total: 50_000, dueDaysAgo: 10 })
    const late45 = await mkBill(tenantA, acct.id, { total: 20_000, dueDaysAgo: 45, paid: 5_000 })
    const inGrace = await mkBill(tenantA, acct.id, { total: 9_000, dueDaysAgo: 3 })
    const paid = await mkBill(tenantA, acct.id, { total: 9_000, dueDaysAgo: 20, paid: 9_000 })
    const invoiceKind = await mkBill(tenantA, acct.id, { total: 7_000, dueDaysAgo: 12, kind: 'invoice' })
    const acctB = await mkAccount(tenantB, userB)
    const lateB = await mkBill(tenantB, acctB.id, { total: 11_000, dueDaysAgo: 15 })

    const r = await runOnAccountDailyForTenant(tenantA)
    expect(r.overdueFlagged).toBe(3)
    const flags = await openFlags(tenantA, OVERDUE_KIND)
    const byId = new Map(flags.map((f) => [f.entityId, f]))
    expect(byId.get(late10.id)).toMatchObject({ severity: 'medium', entityType: 'ReceivableInvoice', tenantId: tenantA })
    expect(Number(byId.get(late10.id)!.amountCents)).toBe(50_000)
    expect(byId.get(late45.id)).toMatchObject({ severity: 'high' })
    expect(Number(byId.get(late45.id)!.amountCents)).toBe(15_000)
    expect(byId.has(invoiceKind.id)).toBe(true)
    expect(byId.has(inGrace.id)).toBe(false)
    expect(byId.has(paid.id)).toBe(false)
    // A's run never touched B's bill.
    expect(byId.has(lateB.id)).toBe(false)
    expect(await prisma.exceptionFlag.count({ where: { entityId: lateB.id } })).toBe(0)

    // Running again refreshes, never duplicates.
    expect((await runOnAccountDailyForTenant(tenantA)).overdueFlagged).toBe(0)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: tenantA, kind: OVERDUE_KIND, entityId: late10.id } })).toBe(1)

    // B's own run flags B's bill in B.
    await runOnAccountDailyForTenant(tenantB)
    const fb = await openFlags(tenantB, OVERDUE_KIND)
    expect(fb.map((f) => f.entityId)).toContain(lateB.id)
    expect(fb.every((f) => f.tenantId === tenantB)).toBe(true)
    // B never sees A's flags (B's scope is its own tenantId).
    const seenByB = await prisma.exceptionFlag.findMany({ where: { tenantId: { in: [tenantB] }, kind: { in: [OVERDUE_KIND, UNBILLED_KIND] } } })
    expect(seenByB.some((f) => f.entityId === late10.id || f.entityId === late45.id)).toBe(false)

    // Paid in full → resolved on the next run.
    await prisma.receivableInvoice.update({ where: { id: late10.id }, data: { paidCents: 50_000, status: 'paid' } })
    const r2 = await runOnAccountDailyForTenant(tenantA)
    expect(r2.overdueResolved).toBe(1)
    const resolved = await prisma.exceptionFlag.findFirstOrThrow({ where: { tenantId: tenantA, kind: OVERDUE_KIND, entityId: late10.id } })
    expect(resolved.status).toBe('resolved')
    expect((await openFlags(tenantA, OVERDUE_KIND)).some((f) => f.entityId === late45.id)).toBe(true)
  })

  it('flags a client whose BOOKED charges are unbilled after 35 days, and resolves once they are billed', async () => {
    const acct = await mkAccount(tenantA, userA)
    const old = await mkCharge(tenantA, conceptA, acct, 12_000, { daysAgo: 40, booked: true, userId: userA })
    await mkCharge(tenantA, conceptA, acct, 3_000, { daysAgo: 10, booked: true, userId: userA }) // too recent
    const notBooked = await mkAccount(tenantA, userA)
    await mkCharge(tenantA, conceptA, notBooked, 8_000, { daysAgo: 50, booked: false, userId: userA })

    await runOnAccountDailyForTenant(tenantA)
    const flags = await openFlags(tenantA, UNBILLED_KIND)
    const f = flags.find((x) => x.entityId === acct.id)!
    expect(f).toMatchObject({ entityType: 'CustomerAccount', tenantId: tenantA, severity: 'medium' })
    expect(Number(f.amountCents)).toBe(12_000)
    expect(flags.some((x) => x.entityId === notBooked.id)).toBe(false)

    // Billed → resolved.
    const st = await mkBill(tenantA, acct.id, { total: 12_000, dueDaysAgo: -30 })
    await prisma.customerAccountCharge.update({ where: { id: old.id }, data: { statementInvoiceId: st.id } })
    const r = await runOnAccountDailyForTenant(tenantA)
    expect(r.unbilledResolved).toBeGreaterThanOrEqual(1)
    expect((await prisma.exceptionFlag.findFirstOrThrow({ where: { tenantId: tenantA, kind: UNBILLED_KIND, entityId: acct.id } })).status).toBe('resolved')
  })

  it('the daily pass covers every active company with a client, each in its own company', async () => {
    const acctB = await mkAccount(tenantB, userB)
    const billB = await mkBill(tenantB, acctB.id, { total: 4_000, dueDaysAgo: 60 })
    await runOnAccountDailyOnce()
    const f = await prisma.exceptionFlag.findFirstOrThrow({ where: { entityId: billB.id, kind: OVERDUE_KIND } })
    expect(f).toMatchObject({ tenantId: tenantB, severity: 'high' })
    // No flag of either kind ever names another company's document.
    const all = await prisma.exceptionFlag.findMany({ where: { kind: { in: [OVERDUE_KIND, UNBILLED_KIND] }, tenantId: { in: [tenantA, tenantB] } } })
    for (const x of all) {
      const owner = x.entityType === 'ReceivableInvoice'
        ? (await prisma.receivableInvoice.findUniqueOrThrow({ where: { id: x.entityId! } })).tenantId
        : (await prisma.customerAccount.findUniqueOrThrow({ where: { id: x.entityId! } })).tenantId
      expect(owner).toBe(x.tenantId)
    }
  })
})

describe('on_account_tieout close check', () => {
  const ctx = (tenantId: string, prevLock: Date | null = null): CloseCheckContext => ({
    db: prisma, tenantId, prevLock, newLock: new Date(Date.now() + DAY), months: [], isYearEnd: false,
  })

  it('is one warn, overridable check', () => {
    expect(onAccountCloseChecks.map((c) => c.key)).toEqual(['on_account_tieout'])
    expect(onAccountTieoutCheck).toMatchObject({ severity: 'warn', overridable: true })
  })

  it('stays silent before the cut-over; after it warns on a difference, unexplained 1110 lines and stale unbilled charges', async () => {
    const { t, c, u } = await mkTenant('c')
    const acct = await mkAccount(t, u)
    // A booked charge 40 days old on no statement (ties out: 1110 = booked unbilled).
    await mkCharge(t, c, acct, 6_000, { daysAgo: 40, booked: true, userId: u })
    // A manual 1110 line nothing explains.
    await postJournalEntry({
      tenantId: t, sourceType: 'manual', sourceId: `oad-${RUN}`, description: 'Opening balance', entryDate: ago(2),
      lines: [
        { accountCode: '1110', type: 'debit', amountCents: 2_500 },
        { accountCode: '3010', type: 'credit', amountCents: 2_500 },
      ],
    })
    expect(await onAccountTieoutCheck.run(ctx(t))).toBeNull()

    await prisma.setting.create({ data: { key: tillClearingCutoverKey(t), value: new Date().toISOString() } })
    const p = (await onAccountTieoutCheck.run(ctx(t)))!
    expect(p).toMatchObject({ key: 'on_account_tieout', severity: 'warn', overridable: true, cents: 2_500 })
    expect(p.detail).toContain('above')
    expect(p.detail).toContain('1 1110 line')
    expect(p.detail).toContain('1 booked on-account charge')
    expect(p.count).toBe(3)

    // A period that ends before both: only the difference remains (the line and the charge are outside it).
    const before = await onAccountTieoutCheck.run({ ...ctx(t, ago(60)), newLock: ago(50) })
    expect(before).toMatchObject({ count: 1 })
    expect(before!.detail).not.toContain('booked on-account charge')

    // Company A's state never leaks into another company's check: a clean, cut-over company is clear.
    const { t: clean } = await mkTenant('d')
    await prisma.setting.create({ data: { key: tillClearingCutoverKey(clean), value: new Date().toISOString() } })
    expect(await onAccountTieoutCheck.run(ctx(clean))).toBeNull()
  })
})
