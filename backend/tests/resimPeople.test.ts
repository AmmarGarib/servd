// People re-simulation, round 2 (.handoff/resim/people-online.json).
//
//   PPL-R2-01  an HR login with staff_hr switched off in Module Access still
//              listed, exported, created and approved payroll adjustments
//              under /hr/records/*.
//   PPL-R2-02  the rota and labour cost showed staff working on approved leave
//              days (standing roster and shifts set before the leave).
//   PPL-R2-03  a tip-pool payout accepted any account as the paying account
//              (a revenue code booked paid-out tips as revenue; an unknown
//              code was a 500).
//   PPL-R2-04  a tip pool could be posted and paid while the till holding its
//              tips was still open (Tips Payable 2095 in debit until close).
//   RV-P-01    …or closed with its close posting refused / not run yet.
//   RV-P-02    leave approved over an approved shift swap left a shift
//              uncovered with nothing flagged.
//   RV-P-03    /hr/logins, /hr/people-reconcile and /hr/separations/logins
//              stayed open to an HR login without staff_hr.
//
// Two companies throughout: company B never sees or touches A's rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { schedulingRoutes } from '../src/modules/scheduling/routes.js'
import { tipPoolRoutes } from '../src/modules/tipPools/routes.js'
import { rotaDay } from '../src/modules/hr/rota.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'

const H = 3_600_000
const stamp = Date.now()
let app: FastifyInstance
let tA: string, tB: string, stackd: string, flipd: string, bunKebab: string, clifton: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@resimppl.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId, ...extra },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

beforeAll(async () => {
  tA = (await prisma.tenant.create({ data: { name: 'GS Foods (resim ppl)', slug: `gs-rp-${stamp}` } })).id
  tB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (resim ppl)', slug: `kb-rp-${stamp}` } })).id
  await ensureChartOfAccounts(tA)
  await ensureChartOfAccounts(tB)
  stackd = (await prisma.concept.create({ data: { name: 'Stackd', slug: `stackd-rp-${stamp}`, type: 'restaurant', tenantId: tA } })).id
  flipd = (await prisma.concept.create({ data: { name: 'Flipd', slug: `flipd-rp-${stamp}`, type: 'restaurant', tenantId: tA } })).id
  bunKebab = (await prisma.concept.create({ data: { name: 'Bun Kebab', slug: `bk-rp-${stamp}`, type: 'restaurant', tenantId: tB } })).id
  clifton = (await prisma.location.create({ data: { slug: `clifton-rp-${stamp}`, name: 'Clifton', tenantId: tA } })).id
  const saddar = (await prisma.location.create({ data: { slug: `saddar-rp-${stamp}`, name: 'Saddar', tenantId: tB } })).id
  await prisma.conceptLocation.create({ data: { conceptId: stackd, locationId: clifton } })
  await prisma.conceptLocation.create({ data: { conceptId: flipd, locationId: clifton } })
  await prisma.conceptLocation.create({ data: { conceptId: bunKebab, locationId: saddar } })

  await mkUser('ceo', 'admin', tA)
  await mkUser('sana', 'hr', tA)
  await mkUser('hina', 'hr', tA)
  await mkUser('mehwish', 'hr', tA, { moduleDeny: ['staff_hr', 'payroll'] })
  await mkUser('omar', 'foh_management', tA)
  await mkUser('ali', 'cashier', tA)
  await mkUser('rabia', 'cashier', tA)
  await mkUser('hrB', 'hr', tB)
  await mkUser('ceoB', 'admin', tB)
  const omarEmp = (await prisma.hrEmployee.create({ data: { tenantId: tA, employeeCode: 'RP-OMAR', fullName: 'Omar Sheikh', grossSalaryCents: 9_000_000, basicSalaryCents: 6_000_000, joiningDate: new Date('2025-01-01'), userId: users['omar']!.id, locationId: clifton } })).id
  emps['Omar'] = omarEmp
  emps['Ali'] = (await prisma.hrEmployee.create({ data: { tenantId: tA, employeeCode: 'RP-ALI', fullName: 'Ali Raza', grossSalaryCents: 6_000_000, basicSalaryCents: 4_000_000, joiningDate: new Date('2025-01-01'), userId: users['ali']!.id, locationId: clifton, managerId: omarEmp } })).id
  emps['Rabia'] = (await prisma.hrEmployee.create({ data: { tenantId: tA, employeeCode: 'RP-RABIA', fullName: 'Rabia', grossSalaryCents: 6_000_000, basicSalaryCents: 4_000_000, joiningDate: new Date('2025-01-01'), userId: users['rabia']!.id, locationId: clifton, managerId: omarEmp } })).id
  for (const t of [tA, tB]) {
    const cur = await prisma.operationsConfig.findFirst({ where: { tenantId: t, scope: 'global', scopeId: null } })
    if (cur) await prisma.operationsConfig.update({ where: { id: cur.id }, data: { tipPoolEnabled: true } })
    else await prisma.operationsConfig.create({ data: { tenantId: t, scope: 'global', scopeId: null, tipPoolEnabled: true } })
  }
  invalidateSetupCache()

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/api/v1/hr' })
  await app.register(schedulingRoutes, { prefix: '/api/v1/scheduling' })
  await app.register(tipPoolRoutes, { prefix: '/api/v1/tip-pools' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── PPL-R2-01 ───────────────────────────────────────────────────────────────

describe('PPL-R2-01 Module Access closes the HR record back office', () => {
  let bonusId: string
  let leaveTypeId: string

  it('an HR login without staff_hr is refused list, read, create, edit, stage and export', async () => {
    const seed = await call('sana', 'POST', '/hr/records/payroll_adjustment', { data: { employee: emps['Ali'], month: '2026-10-20', kind: 'bonus', amount: 2_500_000 } })
    expect(seed.statusCode).toBe(201)
    for (const s of ['payroll_adjustment', 'loan', 'final_settlement', 'termination', 'leave', 'attendance', 'offer']) {
      expect((await call('mehwish', 'GET', `/hr/records/${s}`)).statusCode, s).toBe(403)
    }
    expect((await call('mehwish', 'GET', `/hr/records/payroll_adjustment/${seed.json().id}`)).statusCode).toBe(403)
    expect((await call('mehwish', 'GET', '/hr/records/payroll_adjustment/export.csv')).statusCode).toBe(403)
    expect((await call('mehwish', 'POST', '/hr/records/payroll_adjustment', { data: { employee: emps['Ali'], month: '2026-10-20', kind: 'bonus', amount: 100_000 } })).statusCode).toBe(403)
    expect((await call('mehwish', 'PATCH', `/hr/records/payroll_adjustment/${seed.json().id}`, { data: { reason: 'x' } })).statusCode).toBe(403)
    expect((await call('mehwish', 'POST', `/hr/records/payroll_adjustment/${seed.json().id}/stage`, { stage: 'x' })).statusCode).toBe(403)
    expect((await call('mehwish', 'POST', `/hr/records/payroll_adjustment/${seed.json().id}/cancel`, {})).statusCode).toBe(403)
    // Nothing was created by the refused login.
    expect(await prisma.hrRecord.count({ where: { tenantId: tA, section: 'payroll_adjustment', createdById: users['mehwish']!.id } })).toBe(0)
    // HR with the module still works.
    expect((await call('sana', 'GET', '/hr/records/payroll_adjustment')).statusCode).toBe(200)
    expect((await call('hina', 'GET', '/hr/records/payroll_adjustment/export.csv')).statusCode).toBe(200)
  })

  it('the HR people lists (logins, people-reconcile, leavers\' logins) need staff_hr too (RV-P-03)', async () => {
    for (const url of ['/hr/logins', '/hr/people-reconcile', '/hr/separations/logins']) {
      expect((await call('mehwish', 'GET', url)).statusCode, url).toBe(403)
      expect((await call('sana', 'GET', url)).statusCode, url).toBe(200)
    }
    // Company B's HR sees B's logins only.
    const b = (await call('hrB', 'GET', '/hr/logins')).json() as Array<{ id: string }>
    expect(b.some((u) => u.id === users['ali']!.id)).toBe(false)
    expect(b.some((u) => u.id === users['hrB']!.id)).toBe(true)
  })

  it('an HR step is refused without staff_hr, and the HR queue no longer lists it', async () => {
    const bonus = await call('sana', 'POST', '/hr/records/payroll_adjustment', { data: { employee: emps['Rabia'], month: '2026-10-20', kind: 'bonus', amount: 2_500_000 } })
    expect(bonus.json().status).toBe('submitted')
    bonusId = bonus.json().id
    const queue = (await call('mehwish', 'GET', '/hr/approvals')).json() as Array<{ id: string }>
    expect(queue.some((r) => r.id === bonusId)).toBe(false)
    const dec = await call('mehwish', 'POST', `/hr/records/payroll_adjustment/${bonusId}/decide`, { decision: 'approved' })
    expect(dec.statusCode).toBe(403)
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id: bonusId } })).status).toBe('submitted')
    // Company B's HR sees nothing of A's record.
    expect((await call('hrB', 'POST', `/hr/records/payroll_adjustment/${bonusId}/decide`, { decision: 'approved' })).statusCode).toBe(404)
    // HR who holds the module approves it.
    expect(((await call('hina', 'GET', '/hr/approvals')).json() as Array<{ id: string }>).some((r) => r.id === bonusId)).toBe(true)
    const ok = await call('hina', 'POST', `/hr/records/payroll_adjustment/${bonusId}/decide`, { decision: 'approved' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('approved')
  })

  it('self-service and a reporting manager\'s (HOD) step stay open to everyone', async () => {
    const lt = await call('sana', 'POST', '/hr/records/leave_type', { data: { name: 'Casual', entitlementDays: 10, pay: 'paid' } })
    expect(lt.statusCode).toBe(201)
    leaveTypeId = lt.json().id
    const lv = await call('rabia', 'POST', '/hr/me/records/leave', { data: { leaveType: leaveTypeId, from: '2026-11-02', to: '2026-11-02', reason: 'Errand' } })
    expect(lv.statusCode).toBe(201)
    // Omar (FOH management, no staff_hr) decides his report's HOD step.
    const hod = await call('omar', 'POST', `/hr/records/leave/${lv.json().id}/decide`, { decision: 'approved' })
    expect(hod.statusCode).toBe(200)
    expect(hod.json().status).toBe('submitted')
    // The HR step needs the module.
    expect((await call('mehwish', 'POST', `/hr/records/leave/${lv.json().id}/decide`, { decision: 'approved' })).statusCode).toBe(403)
    expect((await call('sana', 'POST', `/hr/records/leave/${lv.json().id}/decide`, { decision: 'approved' })).json().status).toBe('approved')
  })
})

// ─── PPL-R2-02 ───────────────────────────────────────────────────────────────

describe('PPL-R2-02 approved leave takes the day off the rota and labour cost', () => {
  it('roster and exception days on leave become leave cells with no minutes, and the exception is removed (audited)', async () => {
    const shift = await call('sana', 'POST', '/hr/records/shift', { data: { name: 'Lunch', start: '11:00', end: '19:00' } })
    expect(shift.json().status).toBe('approved')
    const lt = await call('sana', 'POST', '/hr/records/leave_type', { data: { name: 'Annual', entitlementDays: 14, pay: 'paid' } })
    const roster = await call('sana', 'POST', '/hr/records/roster', { data: { employee: emps['Ali'], shift: shift.json().id, from: '2026-10-01', weeklyOff: ['monday'] } })
    expect((await call('omar', 'POST', `/hr/records/roster/${roster.json().id}/decide`, { decision: 'approved' })).json().status).toBe('approved')
    // An exception shift set before the leave.
    const exc = await call('omar', 'POST', '/scheduling', { conceptId: stackd, employeeId: emps['Ali'], date: '2026-10-21', startTime: '12:00', endTime: '20:00' })
    expect(exc.statusCode).toBe(201)

    const before = (await call('omar', 'GET', `/scheduling/labor-cost?conceptId=${stackd}&weekStart=2026-10-19`)).json() as { byEmployee: Array<{ employeeId?: string; name: string; hours: number }> }
    const aliBefore = before.byEmployee.find((e) => e.name === 'Ali Raza')!.hours

    const lv = await call('ali', 'POST', '/hr/me/records/leave', { data: { leaveType: lt.json().id, from: '2026-10-20', to: '2026-10-21', reason: 'Family' } })
    expect(lv.statusCode).toBe(201)
    expect((await call('omar', 'POST', `/hr/records/leave/${lv.json().id}/decide`, { decision: 'approved' })).json().status).toBe('submitted')
    const final = await call('sana', 'POST', `/hr/records/leave/${lv.json().id}/decide`, { decision: 'approved' })
    expect(final.json().status).toBe('approved')
    // The removed exception is listed on the leave, and audited.
    const removed = (final.json().data as Record<string, unknown>)['_shiftsRemoved'] as Array<{ id: string; date: string; startTime: string }>
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatchObject({ id: exc.json().id, date: '2026-10-21', startTime: '12:00' })
    expect(await prisma.scheduledShift.findUnique({ where: { id: exc.json().id } })).toBeNull()
    const auditRow = await prisma.auditLog.findFirst({ where: { action: 'hr.leave.shifts_removed', entityId: lv.json().id } })
    expect(auditRow?.tenantId).toBe(tA)

    const week = await call('omar', 'GET', `/scheduling?conceptId=${stackd}&weekStart=2026-10-19`)
    expect(week.statusCode).toBe(200)
    const cells = (week.json().cells as Array<{ employeeId: string; date: string; kind: string; minutes: number; leaveId?: string }>).filter((c) => c.employeeId === emps['Ali'])
    const c20 = cells.find((c) => c.date === '2026-10-20')!
    const c21 = cells.find((c) => c.date === '2026-10-21')!
    expect(c20).toMatchObject({ kind: 'leave', minutes: 0, leaveId: lv.json().id })
    expect(c21).toMatchObject({ kind: 'leave', minutes: 0 })
    // The day after the leave is the roster again.
    expect(cells.find((c) => c.date === '2026-10-22')).toMatchObject({ kind: 'shift', minutes: 480 })

    const after = (await call('omar', 'GET', `/scheduling/labor-cost?conceptId=${stackd}&weekStart=2026-10-19`)).json() as { byEmployee: Array<{ name: string; hours: number }> }
    const aliAfter = after.byEmployee.find((e) => e.name === 'Ali Raza')?.hours ?? 0
    // 10-20 roster (8 h) and 10-21 exception (8 h) are gone.
    expect(aliBefore - aliAfter).toBe(16)

    expect((await rotaDay(tA, { id: emps['Ali']!, userId: users['ali']!.id }, '2026-10-20')).kind).toBe('leave')
    // Company B sees nothing of A's week.
    expect((await call('hrB', 'GET', `/scheduling?conceptId=${stackd}&weekStart=2026-10-19`)).statusCode).toBe(404)
  })

  it('leave approved over an approved shift swap lists the uncovered shift on the leave, and audits it (RV-P-02)', async () => {
    const lunch = await prisma.hrRecord.findFirstOrThrow({ where: { tenantId: tA, section: 'shift', status: 'approved' } })
    const dinner = await call('sana', 'POST', '/hr/records/shift', { data: { name: 'Dinner', start: '17:00', end: '01:00' } })
    expect(dinner.json().status).toBe('approved')
    // Ali hands his Lunch to Rabia and takes her Dinner on 2026-11-10.
    const swap = await prisma.hrRecord.create({
      data: {
        tenantId: tA, section: 'shift_swap', status: 'approved', employeeId: emps['Ali'], refId: dinner.json().id,
        startDate: new Date('2026-11-10T00:00:00Z'), formVersion: 1,
        data: { swapWith: emps['Rabia'], fromShift: lunch.id, date: '2026-11-10' },
      },
    })
    // Another company's swap naming the same ids is never touched.
    const swapB = await prisma.hrRecord.create({
      data: { tenantId: tB, section: 'shift_swap', status: 'approved', startDate: new Date('2026-11-10T00:00:00Z'), formVersion: 1, data: { swapWith: emps['Rabia'] } },
    })
    const lt = await prisma.hrRecord.findFirstOrThrow({ where: { tenantId: tA, section: 'leave_type', status: 'approved' } })
    const lv = await call('rabia', 'POST', '/hr/me/records/leave', { data: { leaveType: lt.id, from: '2026-11-10', to: '2026-11-10', reason: 'Sick' } })
    expect(lv.statusCode).toBe(201)
    expect((await call('omar', 'POST', `/hr/records/leave/${lv.json().id}/decide`, { decision: 'approved' })).json().status).toBe('submitted')
    const final = await call('hina', 'POST', `/hr/records/leave/${lv.json().id}/decide`, { decision: 'approved' })
    expect(final.json().status).toBe('approved')
    const affected = (final.json().data as Record<string, unknown>)['_swapsAffected'] as Array<Record<string, unknown>>
    expect(affected).toHaveLength(1)
    // Rabia (the partner) is off; the Lunch she took over has nobody on it.
    expect(affected[0]).toMatchObject({ swapId: swap.id, date: '2026-11-10', side: 'partner', colleagueId: emps['Ali'], colleagueName: 'Ali Raza', shiftId: lunch.id })
    expect(String(affected[0]!['shiftName'])).toContain('Lunch')
    const auditRow = await prisma.auditLog.findFirst({ where: { action: 'hr.leave.swaps_affected', entityId: lv.json().id } })
    expect(auditRow?.tenantId).toBe(tA)
    // The swap itself is left as approved.
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id: swap.id } })).status).toBe('approved')
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id: swapB.id } })).status).toBe('approved')

    // The requester's side: Ali on leave the day he swapped onto Dinner.
    const swap2 = await prisma.hrRecord.create({
      data: {
        tenantId: tA, section: 'shift_swap', status: 'approved', employeeId: emps['Ali'], refId: dinner.json().id,
        startDate: new Date('2026-11-12T00:00:00Z'), formVersion: 1, data: { swapWith: emps['Rabia'], fromShift: lunch.id },
      },
    })
    const lv2 = await call('ali', 'POST', '/hr/me/records/leave', { data: { leaveType: lt.id, from: '2026-11-12', to: '2026-11-12', reason: 'Family' } })
    await call('omar', 'POST', `/hr/records/leave/${lv2.json().id}/decide`, { decision: 'approved' })
    const final2 = await call('sana', 'POST', `/hr/records/leave/${lv2.json().id}/decide`, { decision: 'approved' })
    expect(final2.json().status).toBe('approved')
    expect((final2.json().data as Record<string, unknown>)['_swapsAffected']).toEqual([
      expect.objectContaining({ swapId: swap2.id, side: 'requester', colleagueId: emps['Rabia'], shiftId: dinner.json().id }),
    ])
    await prisma.hrRecord.deleteMany({ where: { id: { in: [swap.id, swap2.id, swapB.id] } } })
  })

  it('a half-day leave is not overlaid (the other half is worked)', async () => {
    const lt = await prisma.hrRecord.findFirstOrThrow({ where: { tenantId: tA, section: 'leave_type', status: 'approved' } })
    const half = await prisma.hrRecord.create({
      data: { tenantId: tA, section: 'leave', status: 'approved', employeeId: emps['Ali'], refId: lt.id, startDate: new Date('2026-10-23T00:00:00Z'), endDate: new Date('2026-10-23T00:00:00Z'), quantity: 0.5, data: {}, formVersion: 1 },
    })
    const cell = await rotaDay(tA, { id: emps['Ali']!, userId: users['ali']!.id }, '2026-10-23')
    expect(cell.kind).toBe('shift')
    await prisma.hrRecord.delete({ where: { id: half.id } })
  })
})

// ─── PPL-R2-03 / PPL-R2-04 ───────────────────────────────────────────────────

async function postedPool(conceptId: string, start: Date, end: Date, tips: number) {
  const { tenantId } = await prisma.concept.findUniqueOrThrow({ where: { id: conceptId }, select: { tenantId: true } })
  return prisma.tipPool.create({ data: { tenantId: tenantId!, conceptId, name: `Pool ${start.toISOString()}`, periodStart: start, periodEnd: end, totalTipsCents: tips, status: 'posted', postedAt: new Date() } })
}
async function payoutLines(poolId: string) {
  const je = await prisma.journalEntry.findFirst({ where: { reference: `tippool.payout:${poolId}` }, include: { lines: { include: { account: true } } } })
  return je?.lines.map((l) => `${l.type[0]}:${l.account.code}:${l.amountCents}`).sort() ?? null
}

describe('PPL-R2-03 a tip payout comes from a cash or bank account of the pool\'s company', () => {
  it('refuses a revenue code, an unknown code and another company\'s bank; pays from cash', async () => {
    const t0 = new Date(Date.now() - 300 * H)
    const pool = await postedPool(flipd, t0, new Date(t0.getTime() + H), 40_000)
    const revenue = await call('ceo', 'POST', `/tip-pools/${pool.id}/pay`, { paidFromAccountCode: '4003' })
    expect(revenue.statusCode).toBe(422)
    expect(revenue.json().error.code).toBe('NOT_A_CASH_ACCOUNT')
    const unknown = await call('ceo', 'POST', `/tip-pools/${pool.id}/pay`, { paidFromAccountCode: '9999' })
    expect(unknown.statusCode).toBe(422)
    expect(unknown.json().error.code).toBe('ACCOUNT_NOT_IN_CHART')
    // A liability (Tips Payable itself) is not a paying account either.
    expect((await call('ceo', 'POST', `/tip-pools/${pool.id}/pay`, { paidFromAccountCode: '2095' })).statusCode).toBe(422)
    // Company B's own bank code (1021 in B's chart) is not in A's chart.
    await prisma.account.create({ data: { tenantId: tB, code: '1021', name: 'Bank — Meezan (B)', type: 'asset' } })
    await prisma.bankAccount.create({ data: { tenantId: tB, name: 'Meezan', accountCode: '1021' } })
    expect((await call('ceo', 'POST', `/tip-pools/${pool.id}/pay`, { paidFromAccountCode: '1021' })).json().error.code).toBe('ACCOUNT_NOT_IN_CHART')
    expect((await prisma.tipPool.findUniqueOrThrow({ where: { id: pool.id } })).status).toBe('posted')
    expect(await payoutLines(pool.id)).toBeNull()

    const paid = await call('ceo', 'POST', `/tip-pools/${pool.id}/pay`, { paidFromAccountCode: '1010' })
    expect(paid.statusCode).toBe(200)
    expect(paid.json().status).toBe('paid')
    expect(await payoutLines(pool.id)).toEqual(['c:1010:40000', 'd:2095:40000'])
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `tippool.payout:${pool.id}` } })
    expect(je.tenantId).toBe(tA)
  })

  it('a bank set up in Configuration on its own code is accepted; the default is the operating bank', async () => {
    await prisma.account.create({ data: { tenantId: tA, code: '1150', name: 'Bank — HBL Payroll', type: 'asset' } })
    await prisma.bankAccount.create({ data: { tenantId: tA, name: 'HBL Payroll', accountCode: '1150' } })
    await prisma.account.create({ data: { tenantId: tA, code: '1160', name: 'Staff advances', type: 'asset' } })
    const t0 = new Date(Date.now() - 280 * H)
    const p1 = await postedPool(flipd, t0, new Date(t0.getTime() + H), 10_000)
    // An asset that is not cash or a bank is refused.
    expect((await call('ceo', 'POST', `/tip-pools/${p1.id}/pay`, { paidFromAccountCode: '1160' })).json().error.code).toBe('NOT_A_CASH_ACCOUNT')
    expect((await call('ceo', 'POST', `/tip-pools/${p1.id}/pay`, { paidFromAccountCode: '1150' })).statusCode).toBe(200)
    expect(await payoutLines(p1.id)).toEqual(['c:1150:10000', 'd:2095:10000'])
    const p2 = await postedPool(flipd, new Date(t0.getTime() + 2 * H), new Date(t0.getTime() + 3 * H), 5_000)
    expect((await call('ceo', 'POST', `/tip-pools/${p2.id}/pay`, {})).statusCode).toBe(200)
    // No code named → moneyAccountCode (finance fix wave, tip payouts, owner
    // 2026-10-16; CLAUDE.md "Which money account"): the company's ONLY live
    // bank — here HBL Payroll on 1150 — never a silent 1020.
    expect(await payoutLines(p2.id)).toEqual(['c:1150:5000', 'd:2095:5000'])
  })
})

describe('PPL-R2-04 a pool waits for the till holding its tips to close', () => {
  it('review blocks posting, /pay refuses, and both clear once the till is closed', async () => {
    const t0 = new Date(Date.now() - 200 * H)
    const t1 = new Date(t0.getTime() + 4 * H)
    const till = await prisma.shift.create({ data: { userId: users['ali']!.id, tenantId: tA, locationId: clifton, status: 'open', openedAt: new Date(t0.getTime() - H) } })
    for (const [tip, method] of [[30_000, 'card'], [20_000, 'cash']] as const) {
      const o = await prisma.order.create({ data: { conceptId: stackd, source: 'pos', status: 'completed', completedAt: new Date(t0.getTime() + H), totalCents: 100_000 + tip, tipCents: tip, shiftId: till.id } })
      await prisma.payment.create({ data: { orderId: o.id, shiftId: till.id, method, amountCents: 100_000 + tip, status: 'paid' } })
    }
    // Another company's open till, with tips at its own brand, never blocks A.
    const tillB = await prisma.shift.create({ data: { userId: users['ceoB']!.id, tenantId: tB, status: 'open' } })
    const ob = await prisma.order.create({ data: { conceptId: bunKebab, source: 'pos', status: 'completed', completedAt: new Date(t0.getTime() + H), totalCents: 10_000, tipCents: 1_000, shiftId: tillB.id } })
    await prisma.payment.create({ data: { orderId: ob.id, shiftId: tillB.id, method: 'cash', amountCents: 10_000, status: 'paid' } })

    const draft = await call('sana', 'POST', '/tip-pools', { conceptId: stackd, name: 'Stackd lunch', periodStart: t0.toISOString(), periodEnd: t1.toISOString() })
    expect(draft.statusCode).toBe(201)
    expect(draft.json().totalTipsCents).toBe(50_000)
    const review = (await call('sana', 'GET', `/tip-pools/${draft.json().id}`)).json().review as { blockers: string[] }
    expect(review.blockers.some((b) => b.includes('close the till first') && b.includes("ali's till"))).toBe(true)
    const post = await call('ceo', 'POST', `/tip-pools/${draft.json().id}/post`, {})
    expect(post.statusCode).toBe(409)
    expect(post.json().error.message).toContain('close the till first')

    // A pool already posted (e.g. before this rule) is not paid either.
    const posted = await postedPool(stackd, new Date(t1.getTime()), new Date(t1.getTime() + H), 50_000)
    await prisma.order.create({ data: { conceptId: stackd, source: 'pos', status: 'completed', completedAt: new Date(t1.getTime() + 10 * 60_000), totalCents: 100_500, tipCents: 500, shiftId: till.id, payments: { create: { shiftId: till.id, method: 'cash', amountCents: 100_500, status: 'paid' } } } })
    const pay = await call('ceo', 'POST', `/tip-pools/${posted.id}/pay`, {})
    expect(pay.statusCode).toBe(409)
    expect(pay.json().error.code).toBe('TILL_OPEN')
    expect(await payoutLines(posted.id)).toBeNull()

    // B's pool over its own open till is blocked by B's till only.
    const bPool = await postedPool(bunKebab, t0, t1, 1_000)
    expect((await call('ceoB', 'POST', `/tip-pools/${bPool.id}/pay`, {})).json().error.code).toBe('TILL_OPEN')
    // And A's CEO cannot reach B's pool at all.
    expect((await call('ceo', 'POST', `/tip-pools/${bPool.id}/pay`, {})).statusCode).toBe(404)

    // The till closes but its close posting is refused or has not run yet
    // (RV-P-01): no shift.close entry, so the tips are not in 2095 — still blocked.
    await prisma.shift.update({ where: { id: till.id }, data: { status: 'closed', closedAt: new Date() } })
    const review2 = (await call('sana', 'GET', `/tip-pools/${draft.json().id}`)).json().review as { blockers: string[] }
    expect(review2.blockers.some((b) => b.includes('close the till first'))).toBe(false)
    expect(review2.blockers.some((b) => b.includes('did not reach the books') && b.includes("ali's till"))).toBe(true)
    const unposted = await call('ceo', 'POST', `/tip-pools/${posted.id}/pay`, {})
    expect(unposted.statusCode).toBe(409)
    expect(unposted.json().error.code).toBe('TILL_OPEN')
    expect(unposted.json().error.message).toContain('did not reach the books')
    expect(await payoutLines(posted.id)).toBeNull()
    expect((await prisma.tipPool.findUniqueOrThrow({ where: { id: posted.id } })).status).toBe('posted')
    // The close reaches A's books: the blocker is gone and the payout goes through.
    await postJournalEntry({
      tenantId: tA, sourceType: 'shift.close', sourceId: till.id, description: 'till close', postedBy: 'system',
      lines: [
        { accountCode: '1010', type: 'debit', amountCents: 50_500, memo: 'cash' },
        { accountCode: '2095', type: 'credit', amountCents: 50_500, memo: 'tips' },
      ],
    })
    const review3 = (await call('sana', 'GET', `/tip-pools/${draft.json().id}`)).json().review as { blockers: string[] }
    expect(review3.blockers.some((b) => b.includes('did not reach the books') || b.includes('close the till first'))).toBe(false)
    const pay2 = await call('ceo', 'POST', `/tip-pools/${posted.id}/pay`, {})
    expect(pay2.statusCode).toBe(200)
    // Default = the company's only live bank (1150, set up in PPL-R2-03) via moneyAccountCode.
    expect(await payoutLines(posted.id)).toEqual(['c:1150:50000', 'd:2095:50000'])
  })
})
