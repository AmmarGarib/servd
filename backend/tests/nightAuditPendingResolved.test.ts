// Regression (found by the simulated month, tests/sim/sales.sim.test.ts): the
// hourly worker raises ONE 'night_audit_pending' flag ("Night audit of <day>
// not run") after 06:00 PKT for yesterday's unaudited sales day — and nothing
// ever resolved it, so it stayed open in Exceptions (and on the CEO's /
// finance's bell) after finance ran the day. The run now resolves it, for
// that company and that day only.
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { flagPendingYesterday, runNightAudit, todayPkt } from '../src/modules/nightAudit/service.js'
import { fmtPktDate } from '../src/modules/accounting/dates.js'

const RUN = randomUUID().slice(0, 6)
let A: string
let B: string
let finA: string
const DAY_MS = 86_400_000
const now = new Date()
const yesterday = fmtPktDate(new Date(now.getTime() - DAY_MS))
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:00`)
// The worker's hour must be past 06:00 PKT; run it "at 07:00 today".
const sevenToday = at(todayPkt(now), '07:00')

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `Pending A ${RUN}`, slug: `pend-a-${RUN}`, nightAuditStartDay: fmtPktDate(new Date(now.getTime() - 5 * DAY_MS)) } })).id
  B = (await prisma.tenant.create({ data: { name: `Pending B ${RUN}`, slug: `pend-b-${RUN}`, nightAuditStartDay: fmtPktDate(new Date(now.getTime() - 5 * DAY_MS)) } })).id
  finA = (await prisma.user.create({ data: { name: 'fin', email: `fin.${RUN}@pending.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'finance', isActive: true, accountStatus: 'active', tenantId: A } })).id
  // Yesterday had a (money-free) sale in both companies: an active day with no blocks.
  for (const t of [A, B]) {
    const c = await prisma.concept.create({ data: { name: `Brand ${t.slice(0, 4)}`, slug: `pend-${t === A ? 'a' : 'b'}-${RUN}`, type: 'restaurant', tenantId: t } })
    await prisma.order.create({ data: { conceptId: c.id, source: 'pos', fulfilmentType: 'takeout', status: 'completed', totalCents: 0, taxCents: 0, placedAt: at(yesterday, '12:00'), completedAt: at(yesterday, '12:10') } })
  }
})

describe('the "night audit not run" flag is answered by the run', () => {
  it('the worker flags both companies; running A resolves A\'s flag only', async () => {
    if (todayPkt(sevenToday) !== todayPkt(now)) return // (never: same PKT day by construction)
    expect(await flagPendingYesterday(A, sevenToday)).toBe(true)
    expect(await flagPendingYesterday(B, sevenToday)).toBe(true)
    const flagOf = (t: string) => prisma.exceptionFlag.findFirstOrThrow({ where: { tenantId: t, kind: 'night_audit_pending', entityId: `${t}:${yesterday}` } })
    expect((await flagOf(A)).status).toBe('open')

    await runNightAudit({ tenantId: A, day: yesterday, actor: { id: finA, role: 'finance' } })

    const a = await flagOf(A)
    expect(a.status).toBe('resolved')
    expect(a.resolvedById).toBe(finA)
    expect(a.resolution).toContain(yesterday)
    // B's day is still not run — its flag stays open.
    expect((await flagOf(B)).status).toBe('open')
    // Never raised again for A's day.
    expect(await flagPendingYesterday(A, sevenToday)).toBe(false)
  })
})
