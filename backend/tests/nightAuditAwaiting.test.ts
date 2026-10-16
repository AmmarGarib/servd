// H45 (the CA, 2026-10-16: "After 2 working days"): an audited sales day whose
// card payout / bank deposit is still not matched once its 2nd working day
// after the sales day is over → ONE bell warning ('night_audit.awaiting') to
// the CEO(s) + finance (accounting) of THAT company, naming what is unmatched.
// Working days: Monday–Saturday (no bank-holiday calendar; Sunday off).
// 2026-10-10 is a Saturday.
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { addWorkingDays, awaitingDueDay, notifyAwaitingSettlement, unmatchedLabel } from '../src/modules/nightAudit/service.js'
import { runNightAuditSettleOnce } from '../src/workers/nightAuditSettle.js'

const RUN = randomUUID().slice(0, 6)
let A: string
let B: string
const u: Record<string, string> = {}
const pkt = (day: string, hhmm = '12:00') => new Date(`${day}T${hhmm}:00+05:00`)

async function mk(key: string, role: string, primary: string, members: string[]) {
  const x = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}.h45@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: x.id } })
  u[key] = x.id
}

const lastCheck = (blocks: Array<{ key: string; title: string }>) => ({
  phase: 'settlement', at: new Date().toISOString(), blocks: blocks.map((b) => ({ ...b, count: 1 })), warnings: [],
})
const audited = (tenantId: string, businessDate: string, blocks: Array<{ key: string; title: string }>, extra: Record<string, unknown> = {}) =>
  prisma.nightAuditDay.create({ data: { tenantId, businessDate, status: 'audited', auditedAt: new Date(), auditedById: u.fin ?? u.finB!, lastCheck: lastCheck(blocks), ...extra } })
const awaitingFor = (userId: string) => prisma.staffNotification.findMany({ where: { userId, kind: 'night_audit.awaiting' }, orderBy: { createdAt: 'asc' } })

const CARD = { key: 'card_unsettled_day', title: 'Card sales with no bank payout' }
const CASH = { key: 'cash_not_banked', title: 'Till cash not deposited' }

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `H45 A ${RUN}`, slug: `h45-a-${RUN}` } })).id
  B = (await prisma.tenant.create({ data: { name: `H45 B ${RUN}`, slug: `h45-b-${RUN}` } })).id
  await mk('ceo', 'admin', A, [A])
  await mk('fin', 'finance', A, [A])
  await mk('ceoB', 'admin', B, [B])
  await mk('finB', 'finance', B, [B])
})

describe('working days (Sunday off)', () => {
  it('counts Monday–Saturday and never the sales day itself', () => {
    expect(addWorkingDays('2026-10-10', 1)).toBe('2026-10-12') // Sat → Mon
    expect(awaitingDueDay('2026-10-10')).toBe('2026-10-13')    // Sat → Tue
    expect(awaitingDueDay('2026-10-08')).toBe('2026-10-10')    // Thu → Sat
    expect(awaitingDueDay('2026-10-09')).toBe('2026-10-12')    // Fri → Mon (Sunday skipped)
    expect(awaitingDueDay('2026-10-11')).toBe('2026-10-13')    // Sun → Tue
    expect(awaitingDueDay('2026-12-31')).toBe('2027-01-02')    // year end
  })
  it('names what is unmatched in plain words', () => {
    expect(unmatchedLabel('card_unsettled_day', 'x')).toBe('card payout')
    expect(unmatchedLabel('card_matching_off', 'x')).toBe('card payout')
    expect(unmatchedLabel('cash_not_banked', 'x')).toBe('bank deposit')
    expect(unmatchedLabel('sales_bank_unmatched', 'x')).toBe('bank deposit')
    expect(unmatchedLabel('check_failed:foo', 'Check failed')).toBe('Check failed')
  })
})

describe('the awaiting-settlement warning', () => {
  it('Saturday audited: nothing on Tuesday, one warning from Wednesday, to A\'s CEO + finance only', async () => {
    await audited(A, '2026-10-10', [CARD, CASH])
    expect(await notifyAwaitingSettlement(A, pkt('2026-10-12'))).toBe(0)          // Monday
    expect(await notifyAwaitingSettlement(A, pkt('2026-10-13', '23:59'))).toBe(0) // Tuesday, still due
    expect(await awaitingFor(u.ceo!)).toHaveLength(0)

    expect(await notifyAwaitingSettlement(A, pkt('2026-10-14', '00:30'))).toBe(1) // Wednesday
    const [ceo] = await awaitingFor(u.ceo!)
    expect(ceo).toMatchObject({ tenantId: A, severity: 'warning', link: '/finance/night-audit?day=2026-10-10', entityId: `${A}:2026-10-10` })
    expect(ceo!.title).toMatch(/still awaiting settlement — card payout, bank deposit not matched/)
    expect(ceo!.body).toMatch(/2 working days later \(due by 13 Oct\)/)
    expect(ceo!.body).toMatch(/Card sales with no bank payout; Till cash not deposited/)
    expect(await awaitingFor(u.fin!)).toHaveLength(1)
    expect(await awaitingFor(u.ceoB!)).toHaveLength(0)
    expect(await awaitingFor(u.finB!)).toHaveLength(0)
  })

  it('is idempotent: later ticks and later days send nothing more for the same day', async () => {
    expect(await notifyAwaitingSettlement(A, pkt('2026-10-14', '01:30'))).toBe(0)
    expect(await notifyAwaitingSettlement(A, pkt('2026-10-16'))).toBe(0)
    expect(await awaitingFor(u.ceo!)).toHaveLength(1)
  })

  it('Friday audited: due Monday (Sunday skipped) — nothing on Sunday or Monday, warned on Tuesday', async () => {
    await audited(A, '2026-10-09', [CARD])
    expect(await notifyAwaitingSettlement(A, pkt('2026-10-11'))).toBe(0)
    expect(await notifyAwaitingSettlement(A, pkt('2026-10-12', '20:00'))).toBe(0)
    expect(await notifyAwaitingSettlement(A, pkt('2026-10-13', '08:00'))).toBe(1)
    const r = (await awaitingFor(u.fin!)).find((n) => n.entityId === `${A}:2026-10-09`)!
    expect(r.title).toMatch(/— card payout not matched$/)
  })

  it('closed or open days never warn; company B\'s day warns B\'s people only', async () => {
    await prisma.nightAuditDay.create({ data: { tenantId: A, businessDate: '2026-10-01', status: 'closed', auditedAt: new Date(), auditedById: u.fin!, closedAt: new Date(), closedVia: 'auto' } })
    await prisma.nightAuditDay.create({ data: { tenantId: A, businessDate: '2026-10-02', status: 'open' } })
    await audited(B, '2026-10-05', [{ key: 'sales_bank_unmatched', title: 'Sales money not on a bank statement' }])
    expect(await notifyAwaitingSettlement(A, pkt('2026-10-16'))).toBe(0)
    expect(await notifyAwaitingSettlement(B, pkt('2026-10-16'))).toBe(1)
    const b = await awaitingFor(u.finB!)
    expect(b).toHaveLength(1)
    expect(b[0]!.tenantId).toBe(B)
    expect(b[0]!.title).toMatch(/bank deposit not matched/)
    expect((await awaitingFor(u.ceo!)).some((n) => n.tenantId === B)).toBe(false)
  })

  it('a reopened and re-audited day warns again (new reopenCount)', async () => {
    await prisma.nightAuditDay.update({ where: { tenantId_businessDate: { tenantId: A, businessDate: '2026-10-10' } }, data: { reopenCount: 1 } })
    expect(await notifyAwaitingSettlement(A, pkt('2026-10-16'))).toBe(1)
    expect((await awaitingFor(u.ceo!)).filter((n) => n.entityId === `${A}:2026-10-10`)).toHaveLength(2)
  })

  it('the worker settles first: a day whose money is now matched closes and is never warned about', async () => {
    const C = (await prisma.tenant.create({ data: { name: `H45 C ${RUN}`, slug: `h45-c-${RUN}` } })).id
    await mk('ceoC', 'admin', C, [C])
    // No sales money at all on that day → every settlement check passes.
    await audited(C, '2026-10-03', [CARD])
    const r = await runNightAuditSettleOnce(pkt('2026-10-16'))
    expect(r.closed).toBeGreaterThanOrEqual(1)
    expect((await prisma.nightAuditDay.findUniqueOrThrow({ where: { tenantId_businessDate: { tenantId: C, businessDate: '2026-10-03' } } })).status).toBe('closed')
    expect(await awaitingFor(u.ceoC!)).toHaveLength(0)
  })
})
