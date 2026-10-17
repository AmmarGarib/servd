// Owner, 2026-10-17: "finance can pay tip pools with CEO's approval".
//
//   - The post records who posted (TipPool.postedById, migration 20261017150000).
//   - Finance with 'accounting' pays a pool the CEO (role admin) posted:
//     Dr 2095 / Cr cash or bank of the POOL's company.
//   - A pool posted by anyone else (a co-owner — or before the
//     column existed) is 403 TIP_POOL_NEEDS_CEO_APPROVAL for finance; the
//     approvers pay it as before.
//   - Finance without 'accounting' is refused; finance never posts.
//   - Company B's finance gets 404 on company A's pool.
//   - Nobody posts or pays a pool holding their own tips, the CEO included
//     (403 OWN_TIPS_IN_POOL) — by login or by a linked HR record.
//   - The bell: a CEO-posted pool tells finance (with accounting) it is ready to pay.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { tipPoolRoutes } from '../src/modules/tipPools/routes.js'
import { flushNotifications } from '../src/lib/staffNotify.js'
import { enforceModuleAccess } from '../src/lib/moduleAccess.js'

const H = 3_600_000
const stamp = Date.now()

let app: FastifyInstance
let tenantA: string, tenantB: string
let brandA: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@tpfin.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId, ...extra },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u.id
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

// Non-overlapping windows, all over.
let slot = 0
function window() {
  const start = new Date(Date.now() - 200 * H + slot * 3 * H)
  slot++
  return { start, end: new Date(start.getTime() + 2 * H) }
}

/** A draft pool of brand A with these logins (or HR records) as members and a tipped order in its window. */
async function draftPool(name: string, members: Array<{ userId?: string; employeeId?: string; name: string }>, tipCents = 20_000) {
  const w = window()
  await prisma.order.create({ data: { conceptId: brandA, source: 'pos', status: 'completed', completedAt: new Date(w.start.getTime() + H / 2), totalCents: 100_000 + tipCents, tipCents } })
  const pool = await prisma.tipPool.create({ data: { tenantId: tenantA, conceptId: brandA, name, periodStart: w.start, periodEnd: w.end, totalTipsCents: tipCents } })
  for (const m of members) {
    await prisma.tipPoolMember.create({ data: { poolId: pool.id, userId: m.userId ?? null, employeeId: m.employeeId ?? null, userName: m.name, hoursWorked: 2, shareUnits: 2 } })
  }
  return pool.id
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (tpf)', slug: `gs-tpf-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (tpf)', slug: `kb-tpf-${stamp}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  brandA = (await prisma.concept.create({ data: { name: 'Stackd', slug: `stackd-tpf-${stamp}`, type: 'restaurant', tenantId: tenantA } })).id
  const locA = (await prisma.location.create({ data: { slug: `tpf-a-${stamp}`, name: 'Clifton', tenantId: tenantA } })).id
  await prisma.conceptLocation.create({ data: { conceptId: brandA, locationId: locA } })
  await prisma.operationsConfig.create({ data: { tenantId: tenantA, scope: 'global', scopeId: null, tipPoolEnabled: true, tipPoolDistribution: 'by_hours' } })
  invalidateSetupCache()

  await mkUser('ceo', 'admin', tenantA)
  await mkUser('coowner', 'owner', tenantA)
  await mkUser('fin', 'finance', tenantA)
  await mkUser('finNoAcct', 'finance', tenantA, { moduleDeny: ['accounting'] })
  await mkUser('finB', 'finance', tenantB)
  await mkUser('server', 'foh', tenantA)
  await mkUser('server2', 'foh', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(tipPoolRoutes, { prefix: '/api/v1/tip-pools' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('finance pays a tip pool the CEO posted', () => {
  let pool1: string

  it('the CEO\'s post records who posted; finance sees it as CEO-approved and is told it is ready to pay', async () => {
    pool1 = await draftPool('CEO-posted', [{ userId: users['server']!.id, name: 'server' }, { userId: users['server2']!.id, name: 'server2' }])
    const posted = await call('ceo', 'POST', `/tip-pools/${pool1}/post`, {})
    expect(posted.statusCode, posted.body).toBe(200)
    expect(posted.json().postedById).toBe(users['ceo']!.id)
    const list = (await call('fin', 'GET', '/tip-pools')).json() as Array<{ id: string; postedByCeo: boolean }>
    expect(list.find((p) => p.id === pool1)?.postedByCeo).toBe(true)
    expect((await call('fin', 'GET', `/tip-pools/${pool1}`)).json().postedByCeo).toBe(true)
    await flushNotifications()
    const bell = await prisma.staffNotification.findMany({ where: { entityId: pool1, kind: 'task.next' } })
    expect(bell.map((n) => n.userId)).toEqual([users['fin']!.id])
    expect(bell[0]!.tenantId).toBe(tenantA)
  })

  it('finance never posts', async () => {
    const p = await draftPool('Finance tries to post', [{ userId: users['server']!.id, name: 'server' }])
    expect((await call('fin', 'POST', `/tip-pools/${p}/post`, {})).statusCode).toBe(403)
    expect((await prisma.tipPool.findUniqueOrThrow({ where: { id: p } })).status).toBe('draft')
    await prisma.tipPool.delete({ where: { id: p } })
  })

  it('finance without accounting is refused; company B\'s finance gets 404', async () => {
    const noAcct = await call('finNoAcct', 'POST', `/tip-pools/${pool1}/pay`, { method: 'cash' })
    expect(noAcct.statusCode).toBe(403)
    expect(noAcct.json().error.code).toBe('FORBIDDEN')
    expect((await call('finB', 'POST', `/tip-pools/${pool1}/pay`, { method: 'cash' })).statusCode).toBe(404)
    expect((await call('finB', 'GET', `/tip-pools/${pool1}`)).statusCode).toBe(404)
    expect((await prisma.tipPool.findUniqueOrThrow({ where: { id: pool1 } })).status).toBe('posted')
  })

  it('finance pays it: Dr 2095 / Cr the bank of the pool\'s company', async () => {
    const paid = await call('fin', 'POST', `/tip-pools/${pool1}/pay`, { method: 'bank_transfer' })
    expect(paid.statusCode, paid.body).toBe(200)
    expect(paid.json().status).toBe('paid')
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `tippool.payout:${pool1}` }, include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } } })
    expect(je.tenantId).toBe(tenantA)
    expect(je.lines.map((l) => [l.type, l.account.code, l.amountCents]).sort()).toEqual([['credit', '1020', 20_000], ['debit', '2095', 20_000]])
    expect(je.lines.every((l) => l.account.tenantId === tenantA)).toBe(true)
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'tippool.pay', entityId: pool1 } })
    expect(a).toMatchObject({ userId: users['fin']!.id, tenantId: tenantA })
    // Paid once.
    expect((await call('fin', 'POST', `/tip-pools/${pool1}/pay`, { method: 'cash' })).statusCode).toBe(422)
  })

  it('a pool a co-owner posted is not finance\'s to pay (403 TIP_POOL_NEEDS_CEO_APPROVAL); the co-owner pays as before', async () => {
    const p = await draftPool('Co-owner-posted', [{ userId: users['server']!.id, name: 'server' }])
    expect((await call('coowner', 'POST', `/tip-pools/${p}/post`, {})).statusCode).toBe(200)
    expect((await call('fin', 'GET', `/tip-pools/${p}`)).json().postedByCeo).toBe(false)
    const r = await call('fin', 'POST', `/tip-pools/${p}/pay`, { method: 'cash' })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('TIP_POOL_NEEDS_CEO_APPROVAL')
    expect(await prisma.journalEntry.count({ where: { reference: `tippool.payout:${p}` } })).toBe(0)
    const ok = await call('coowner', 'POST', `/tip-pools/${p}/pay`, { method: 'cash' })
    expect(ok.statusCode, ok.body).toBe(200)
  })

  it('a pool posted before the column existed (no postedById) is refused to finance too', async () => {
    const p = await draftPool('Legacy', [{ userId: users['server']!.id, name: 'server' }])
    await prisma.tipPool.update({ where: { id: p }, data: { status: 'posted', postedAt: new Date() } })
    const r = await call('fin', 'POST', `/tip-pools/${p}/pay`, { method: 'cash' })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('TIP_POOL_NEEDS_CEO_APPROVAL')
  })
})

describe('nobody posts or pays a pool holding their own tips (OWN_TIPS_IN_POOL)', () => {
  it('the CEO cannot post a pool with their own tips', async () => {
    const p = await draftPool('CEO in it', [{ userId: users['ceo']!.id, name: 'ceo' }, { userId: users['server']!.id, name: 'server' }])
    const r = await call('ceo', 'POST', `/tip-pools/${p}/post`, {})
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('OWN_TIPS_IN_POOL')
    expect((await prisma.tipPool.findUniqueOrThrow({ where: { id: p } })).status).toBe('draft')
    await prisma.tipPool.delete({ where: { id: p } })
  })

  it('a co-owner cannot post a pool holding their tips through their HR record', async () => {
    const emp = await prisma.hrEmployee.create({ data: { tenantId: tenantA, employeeCode: `TPF-${stamp}`, fullName: 'Owner O', grossSalaryCents: 5_000_000, joiningDate: new Date('2025-01-01'), userId: users['coowner']!.id } })
    const p = await draftPool('Co-owner by HR record', [{ employeeId: emp.id, name: 'Owner O' }, { userId: users['server']!.id, name: 'server' }])
    const r = await call('coowner', 'POST', `/tip-pools/${p}/post`, {})
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('OWN_TIPS_IN_POOL')
    await prisma.tipPool.delete({ where: { id: p } })
    await prisma.hrEmployee.delete({ where: { id: emp.id } })
  })

  it('finance cannot pay a CEO-posted pool holding their own tips', async () => {
    const p = await draftPool('Finance in it', [{ userId: users['fin']!.id, name: 'fin' }, { userId: users['server']!.id, name: 'server' }])
    expect((await call('ceo', 'POST', `/tip-pools/${p}/post`, {})).statusCode).toBe(200)
    const r = await call('fin', 'POST', `/tip-pools/${p}/pay`, { method: 'cash' })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('OWN_TIPS_IN_POOL')
    expect(await prisma.journalEntry.count({ where: { reference: `tippool.payout:${p}` } })).toBe(0)
  })
})

describe('Module Access on /tip-pools', () => {
  it('finance with accounting but not payroll reaches pay; reading and every other write stay payroll', async () => {
    const u = { role: 'finance' as UserRole, moduleAllow: [], moduleDeny: ['payroll'] }
    await expect(enforceModuleAccess('/api/v1/tip-pools/abc/pay', u, 'POST')).resolves.toBeUndefined()
    await expect(enforceModuleAccess('/api/v1/tip-pools', u, 'GET')).rejects.toThrow()
    await expect(enforceModuleAccess('/api/v1/tip-pools/abc/post', u, 'POST')).rejects.toThrow()
    await expect(enforceModuleAccess('/api/v1/tip-pools', u, 'POST')).rejects.toThrow()
    const none = { role: 'finance' as UserRole, moduleAllow: [], moduleDeny: ['payroll', 'accounting'] }
    await expect(enforceModuleAccess('/api/v1/tip-pools/abc/pay', none, 'POST')).rejects.toThrow()
  })

  it('a co-owner without payroll (but with accounting) still cannot pay through the widened pay rule', async () => {
    const p = await draftPool('Co-owner without payroll', [{ userId: users['server']!.id, name: 'server' }])
    expect((await call('ceo', 'POST', `/tip-pools/${p}/post`, {})).statusCode).toBe(200)
    await prisma.user.update({ where: { id: users['coowner']!.id }, data: { moduleDeny: ['payroll'] } })
    try {
      const r = await call('coowner', 'POST', `/tip-pools/${p}/pay`, { method: 'cash' })
      expect(r.statusCode).toBe(403)
      expect(r.json().error.code).toBe('FORBIDDEN')
    } finally {
      await prisma.user.update({ where: { id: users['coowner']!.id }, data: { moduleDeny: [] } })
    }
  })
})
