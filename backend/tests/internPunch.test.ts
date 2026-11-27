// An intern's own check-in / check-out records their attendance (owner, 2026-11-27; hr/internPunch.ts).
//   • check-in → today's row `present`, source 'clock', with the time; check-out → the time on that row;
//   • HR's mark wins: a day HR marked absent keeps its status;
//   • company separation: a punch in company B never writes company A's intern attendance;
//   • a login that is not an intern, or an intern not active, records nothing.
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { clockIn, clockOut } from '../src/modules/timeclock/service.js'
import { recordInternPunch, backfillInternPunches } from '../src/modules/hr/internPunch.js'

const RUN = Math.random().toString(36).slice(2, 8)
let A: string, B: string
const u: Record<string, string> = {}
const interns: Record<string, string> = {}
const today = () => { const k = new Date(Date.now() + 5 * 3_600_000); return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate())) }
const rowOf = (key: string) => prisma.internAttendance.findUnique({ where: { internId_date: { internId: interns[key]!, date: today() } } })

async function mkUser(key: string, tenantId: string) {
  const x = await prisma.user.create({ data: { name: key, email: `${key}.${RUN}@internpunch.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'marketing_intern' as never, isActive: true, accountStatus: 'active', tenantId } })
  u[key] = x.id
}
async function mkIntern(key: string, tenantId: string, userId: string | null, status = 'active') {
  const i = await prisma.intern.create({ data: { tenantId, internCode: `INT-${key}-${RUN}`, fullName: `Intern ${key}`, startDate: new Date(today().getTime() - 10 * 86_400_000), status, userId } })
  interns[key] = i.id
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `IP A ${RUN}`, slug: `ip-a-${RUN}` } })).id
  B = (await prisma.tenant.create({ data: { name: `IP B ${RUN}`, slug: `ip-b-${RUN}` } })).id
  await mkUser('one', A); await mkUser('two', A); await mkUser('draft', A); await mkUser('plain', A)
  await mkIntern('one', A, u.one!); await mkIntern('two', A, u.two!); await mkIntern('draft', A, u.draft!, 'pending_approval')
}, 120_000)

describe('intern attendance from the time clock', () => {
  it('check-in marks today present; check-out adds the time', async () => {
    const r = await clockIn({ id: u.one!, role: 'marketing_intern', tenantId: A }, {}) as { hrLinked?: boolean; internAttendance?: { status: string } }
    expect(r.hrLinked).toBe(true)
    expect(r.internAttendance).toEqual({ status: 'present' })
    const row = await rowOf('one')
    expect(row).toMatchObject({ status: 'present', source: 'clock', tenantId: A, checkOut: null })
    expect(row!.checkIn).toMatch(/^\d\d:\d\d$/)
    await clockOut({ id: u.one!, role: 'marketing_intern', tenantId: A }, {})
    expect((await rowOf('one'))!.checkOut).toMatch(/^\d\d:\d\d$/)
    expect(await prisma.internAttendance.count({ where: { internId: interns.one! } })).toBe(1)
  })

  it("HR's mark wins: an absent day stays absent, only the empty time is filled", async () => {
    await prisma.internAttendance.create({ data: { tenantId: A, internId: interns.two!, date: today(), status: 'absent', source: 'hr' } })
    await clockIn({ id: u.two!, role: 'marketing_intern', tenantId: A }, {})
    expect(await rowOf('two')).toMatchObject({ status: 'absent', source: 'hr' })
  })

  it('another company, a non-intern and an intern not approved record nothing', async () => {
    expect(await recordInternPunch({ userId: u.one!, tenantId: B, kind: 'in', at: new Date() })).toMatchObject({ recorded: false })
    expect(await prisma.internAttendance.count({ where: { tenantId: B } })).toBe(0)
    const p = await clockIn({ id: u.plain!, role: 'marketing_intern', tenantId: A }, {}) as { hrLinked?: boolean }
    expect(p.hrLinked).toBe(false)
    await clockIn({ id: u.draft!, role: 'marketing_intern', tenantId: A }, {})
    expect(await rowOf('draft')).toBeNull()
  })

  it('back-fill: past check-ins with no attendance become days; marked days and another company are left alone', async () => {
    await mkUser('old', A); await mkIntern('old', A, u.old!)
    const at = (daysAgo: number, hhmmUtc: string) => new Date(`${new Date(today().getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10)}T${hhmmUtc}:00Z`)
    const dayOf = (n: number) => new Date(today().getTime() - n * 86_400_000)
    // 3 days ago: in 11:00 PKT, out 19:00 PKT. 2 days ago: in only. 4 days ago: HR marked absent but a punch exists.
    // 5 days ago: a punch in company B (not this intern's company). 20 days ago: before the internship.
    await prisma.clockLog.createMany({ data: [
      { userId: u.old!, type: 'in', recordedAt: at(3, '06:00'), tenantId: A }, { userId: u.old!, type: 'out', recordedAt: at(3, '14:00'), tenantId: A },
      { userId: u.old!, type: 'in', recordedAt: at(2, '06:30'), tenantId: A },
      { userId: u.old!, type: 'in', recordedAt: at(4, '06:00'), tenantId: A }, { userId: u.old!, type: 'out', recordedAt: at(4, '13:00'), tenantId: A },
      { userId: u.old!, type: 'in', recordedAt: at(5, '06:00'), tenantId: B }, { userId: u.old!, type: 'out', recordedAt: at(5, '13:00'), tenantId: B },
      { userId: u.old!, type: 'in', recordedAt: at(20, '06:00'), tenantId: A }, { userId: u.old!, type: 'out', recordedAt: at(20, '13:00'), tenantId: A },
    ] })
    await prisma.internAttendance.create({ data: { tenantId: A, internId: interns.old!, date: dayOf(4), status: 'absent', source: 'hr' } })
    const r = await backfillInternPunches()
    expect(r.find((x) => x.tenantId === A)).toMatchObject({ days: 2 })
    const rows = await prisma.internAttendance.findMany({ where: { internId: interns.old! }, orderBy: { date: 'asc' } })
    expect(rows.map((x) => [x.date.getTime(), x.status, x.source, x.checkIn, x.checkOut])).toEqual([
      [dayOf(4).getTime(), 'absent', 'hr', null, null],
      [dayOf(3).getTime(), 'present', 'clock', '11:00', '19:00'],
      [dayOf(2).getTime(), 'present', 'clock', '11:30', null],
    ])
    // Running it again adds nothing.
    expect((await backfillInternPunches()).find((x) => x.tenantId === A)).toBeUndefined()
  })
})
