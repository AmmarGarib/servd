// Night audit notices on the staff bell (owner, 2026-10-16). Audience = CEO(s) +
// finance (accounting) of the audited company, minus the runner; another
// company's people never hear of it. The "still awaiting settlement" warning is
// NOT built (TODO(H45)).
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { fmtPktDate } from '../src/modules/accounting/dates.js'
import { runNightAudit, reopenDay, settleDay, notifyNightReport } from '../src/modules/nightAudit/service.js'
import { flushNotifications } from '../src/lib/staffNotify.js'

let A: string
let B: string
const u: Record<string, string> = {}
const DAY_MS = 86_400_000
const dayAgo = (n: number) => fmtPktDate(new Date(Date.now() - n * DAY_MS))
const at = (day: string, hhmm = '13:00') => new Date(`${day}T${hhmm}:00+05:00`)
const D1 = dayAgo(2)
const D2 = dayAgo(1)

async function mk(key: string, role: string, primary: string, members: string[]) {
  const x = await prisma.user.create({
    data: { name: key, email: `${key}.nan@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: x.id } })
  u[key] = x.id
}
const rows = (userId: string, kind = 'night_audit.report') => prisma.staffNotification.findMany({ where: { userId, kind }, orderBy: { createdAt: 'asc' } })

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'Notice Foods', slug: 'nan-a' } })).id
  B = (await prisma.tenant.create({ data: { name: 'Notice Viva', slug: 'nan-b' } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  const c = await prisma.concept.create({ data: { name: 'Simmer NN', slug: 'simmer', type: 'restaurant', tenantId: A, taxRateCash: 15, taxRateCard: 8 } })
  for (const d of [D1, D2]) {
    await prisma.order.create({ data: { conceptId: c.id, source: 'pos', fulfilmentType: 'takeout', status: 'completed', totalCents: 0, taxCents: 0, placedAt: at(d, '12:00'), completedAt: at(d, '12:10') } as never })
  }
  await prisma.tenant.update({ where: { id: A }, data: { nightAuditStartDay: D1 } })
  await mk('ceo', 'admin', A, [A, B])
  await mk('ceoB', 'admin', B, [B])
  await mk('fin', 'finance', A, [A])
  await mk('fin2', 'finance', A, [A])
  await mk('finB', 'finance', B, [B])
})

describe('night audit notices', () => {
  it('a run by finance tells the CEO and the other finance login, not the runner, not company B', async () => {
    await runNightAudit({ tenantId: A, day: D1, actor: { id: u.fin! } })
    await flushNotifications()
    const ceo = await rows(u.ceo!)
    expect(ceo).toHaveLength(1)
    expect(ceo[0]!.tenantId).toBe(A)
    expect(ceo[0]!.title).toMatch(/audited — net sales PKR 0, 1 order/)
    expect(ceo[0]!.body).toMatch(/Closed/)
    expect(ceo[0]!.link).toBe(`/finance/night-audit?day=${D1}`)
    expect(await rows(u.fin2!)).toHaveLength(1)
    expect(await rows(u.fin!)).toHaveLength(0)
    expect(await rows(u.finB!)).toHaveLength(0)
    expect(await rows(u.ceoB!)).toHaveLength(0)
    // closed at once: no second "closed" notice
    expect((await prisma.staffNotification.findMany({ where: { userId: u.ceo!, dedupeKey: { startsWith: 'night_audit.closed' } } }))).toHaveLength(0)
  })

  it('reopen + rerun reports again (new dedupe key); a repeat of the same report is deduped', async () => {
    await reopenDay({ tenantId: A, day: D1, actor: { id: u.ceo! }, reason: 'Recount the day please' })
    await runNightAudit({ tenantId: A, day: D1, actor: { id: u.fin! } })
    await flushNotifications()
    expect(await rows(u.ceo!)).toHaveLength(2)
    await notifyNightReport(A, D1, u.fin!)
    expect(await rows(u.ceo!)).toHaveLength(2)
  })

  it('an audited day awaiting settlement says so; closing it later sends the closed notice once', async () => {
    await prisma.nightAuditDay.create({ data: {
      tenantId: A, businessDate: D2, status: 'audited', auditedAt: new Date(), auditedById: u.fin!,
      lastCheck: { phase: 'settlement', at: new Date().toISOString(), blocks: [{ key: 'sales_card_unsettled', title: 'Card payout not matched', count: 1 }], warnings: [] },
    } })
    await notifyNightReport(A, D2, null)
    const rep = (await rows(u.ceo!)).find((r) => r.dedupeKey.includes(D2))!
    expect(rep.body).toMatch(/Awaiting settlement: Card payout not matched/)
    expect(await rows(u.fin!)).toHaveLength(1) // actor null: everyone in the audience
    expect(await settleDay({ tenantId: A, day: D2, actor: null, auto: true })).toBe('closed')
    await flushNotifications()
    const closed = await prisma.staffNotification.findMany({ where: { userId: u.ceo!, dedupeKey: { startsWith: 'night_audit.closed' } } })
    expect(closed).toHaveLength(1)
    expect(closed[0]!.severity).toBe('success')
    expect(await prisma.staffNotification.count({ where: { userId: u.finB! } })).toBe(0)
  })

  it('the awaiting-settlement warning is not built (H45)', async () => {
    expect(await prisma.staffNotification.count({ where: { tenantId: A, kind: 'night_audit.awaiting' } })).toBe(0)
  })
})
