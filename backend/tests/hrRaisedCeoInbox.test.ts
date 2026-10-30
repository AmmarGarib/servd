// HR-raised requests at the CEO's step reach the CEO's inbox, and HR re-raises
// (owner, 2026-10-30: "whatever it is needs to show up on my approval page";
// "if approved and HR needs to re-raise something, give him rights to re-raise
// to me").
//
//   - An employee who reports to the CEO: the CEO signs the HOD step, then the
//     LAST step of an HR-raised leave is the CEO's too — it must still be listed
//     (it used to count as an "override" and vanish from the inbox).
//   - An employee with no manager login and only one HR login (who raised it):
//     nobody but the CEO can take the HOD step — listed for the CEO, never
//     stranded out of sight.
//   - Both in GET /hr/approvals AND the approvals inbox, decided through
//     POST /hr/records/:section/:id/decide.
//   - Re-raise: HR raises a rejected / cancelled request again in the record's
//     own company (another company 404); approved → cancel first; one live copy.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return { ...real, sendText: vi.fn(async () => undefined) }
})
vi.mock('../src/lib/mailer.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/mailer.js')>()
  return { ...real, sendEmail: vi.fn(async () => undefined) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { hrRoutes } = await import('../src/modules/hr/routes.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')
const { approverIdsFor } = await import('../src/lib/approvalRights.js')

const P = `hrci${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}
const E: Record<string, string> = {}
let leaveType = ''

async function mkUser(key: string, role: string, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@hrci.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
}
const auth = (key: string) => {
  const u = U[key]!
  return { authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}` }
}
const hr = (key: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1/hr${url}`, headers: auth(key), ...(payload !== undefined && { payload: payload as never }) })
type Inbox = { items: Array<{ type: string; id: string; actions: Array<{ kind: string; path: string }> }> }
const inboxIds = async (key: string) => {
  const r = await app.inject({ method: 'GET', url: '/api/v1/approvals', headers: auth(key) })
  expect(r.statusCode, r.body).toBe(200)
  return (r.json() as Inbox).items.filter((i) => i.type === 'hr_request').map((i) => i.id)
}
const hrQueueIds = async (key: string) => {
  const r = await hr(key, 'GET', '/approvals')
  expect(r.statusCode, r.body).toBe(200)
  return (r.json() as Array<{ id: string }>).map((x) => x.id)
}
const raiseLeave = async (emp: string, from: string, to: string) => {
  const r = await hr('hr', 'POST', '/records/leave', { data: { employee: emp, leaveType, from, to, reason: 'Family matter' } })
  expect(r.statusCode, r.body).toBe(201)
  return r.json() as { id: string; status: string; currentStep: number }
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'HRCI A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'HRCI B', slug: `${P}-b` } })).id
  await mkUser('ceo', 'admin', [T.A, T.B])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('hr', 'hr', [T.A, T.B])
  await mkUser('hrB', 'hr', [T.B])
  // Reports to the CEO (who has no HR record): the CEO signs the HOD step.
  E.anusha = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'Anusha Siddiqui', status: 'active', data: { reportsToCeo: true } } })).id
  // No reporting manager at all: HR stands in for the HOD — but HR raised it.
  E.danish = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-2`, fullName: 'Muhammad Danish', status: 'active' } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(hrRoutes, { prefix: '/hr' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
  const lt = await app.inject({ method: 'POST', url: '/api/v1/hr/records/leave_type', headers: { ...auth('hr'), 'x-servd-active-tenant': T.A }, payload: { data: { name: 'Casual', entitlementDays: 10, pay: 'paid' } } })
  expect(lt.statusCode, lt.body).toBe(201)
  leaveType = lt.json().id
}, 120_000)

afterAll(async () => {
  await prisma.hrRecord.deleteMany({ where: { tenantId: { in: [T.A, T.B] } } })
  await prisma.hrEmployee.deleteMany({ where: { tenantId: { in: [T.A, T.B] } } })
  await app?.close()
})

describe('HR-raised leave reaches the CEO', () => {
  let anushaLeave = ''
  it("the CEO signs the HOD step, then the last (CEO) step is still in the CEO's inbox", async () => {
    const rec = await raiseLeave(E.anusha!, '2026-11-02', '2026-11-03')
    anushaLeave = rec.id
    expect(rec).toMatchObject({ status: 'submitted', currentStep: 0 })
    expect(await hrQueueIds('ceo')).toContain(rec.id)
    expect(await inboxIds('ceo')).toContain(rec.id)
    const s1 = await hr('ceo', 'POST', `/records/leave/${rec.id}/decide`, { decision: 'approved' })
    expect(s1.statusCode, s1.body).toBe(200)
    expect(s1.json()).toMatchObject({ status: 'submitted', currentStep: 1 })
    // The final step: the CEO's (raised by HR), even though the CEO signed step 1.
    expect(await hrQueueIds('ceo')).toContain(rec.id)
    expect(await inboxIds('ceo')).toContain(rec.id)
    expect(await hrQueueIds('hr')).not.toContain(rec.id)
    expect((await approverIdsFor('hr_request', rec.id))?.userIds).toEqual([U.ceo!.id])
    // HR never gives the final sign-off on what HR raised.
    expect((await hr('hr', 'POST', `/records/leave/${rec.id}/decide`, { decision: 'approved' })).statusCode).toBe(403)
    // Another company's CEO never sees it.
    expect(await inboxIds('ceoB')).not.toContain(rec.id)
    const rej = await hr('ceo', 'POST', `/records/leave/${rec.id}/decide`, { decision: 'rejected', note: 'Wrong dates' })
    expect(rej.statusCode, rej.body).toBe(200)
    expect(rej.json().status).toBe('rejected')
    const last = rej.json().approvals.at(-1)
    expect(last.override).toBeUndefined()
  })

  let danishLeave = ''
  it('a step nobody but the CEO can take (no manager, HR raised it) shows to the CEO', async () => {
    const rec = await raiseLeave(E.danish!, '2026-11-09', '2026-11-09')
    danishLeave = rec.id
    expect(rec).toMatchObject({ status: 'submitted', currentStep: 0 })
    expect(await hrQueueIds('hr')).not.toContain(rec.id)
    expect(await hrQueueIds('ceo')).toContain(rec.id)
    expect(await inboxIds('ceo')).toContain(rec.id)
    expect((await hr('ceo', 'POST', `/records/leave/${rec.id}/decide`, { decision: 'approved' })).json()).toMatchObject({ status: 'submitted', currentStep: 1 })
    expect(await inboxIds('ceo')).toContain(rec.id)
    const ok = await hr('ceo', 'POST', `/records/leave/${rec.id}/decide`, { decision: 'approved' })
    expect(ok.json().status).toBe('approved')
    expect(await inboxIds('ceo')).not.toContain(rec.id)
  })

  it('HR re-raises a rejected request in its own company; it goes back to the CEO', async () => {
    // Another company's HR / CEO: 404.
    expect((await hr('hrB', 'POST', `/records/leave/${anushaLeave}/reraise`, {})).statusCode).toBe(404)
    expect((await hr('ceoB', 'POST', `/records/leave/${anushaLeave}/reraise`, {})).statusCode).toBe(404)
    const r = await hr('hr', 'POST', `/records/leave/${anushaLeave}/reraise`, { data: { to: '2026-11-04' }, note: 'Corrected dates' })
    expect(r.statusCode, r.body).toBe(201)
    const copy = r.json()
    expect(copy).toMatchObject({ tenantId: T.A, status: 'submitted', currentStep: 0, createdById: U.hr!.id, employeeId: E.anusha })
    expect(copy.data._reraisedFrom).toBe(anushaLeave)
    expect(copy.endDate.slice(0, 10)).toBe('2026-11-04')
    expect(await inboxIds('ceo')).toContain(copy.id)
    // One live copy.
    expect((await hr('hr', 'POST', `/records/leave/${anushaLeave}/reraise`, {})).statusCode).toBe(409)
    // The original is history, unchanged.
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id: anushaLeave } })).status).toBe('rejected')
  })

  it('an approved request is cancelled first, then re-raised', async () => {
    const r = await hr('hr', 'POST', `/records/leave/${danishLeave}/reraise`, {})
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('CANCEL_FIRST')
    const c = await hr('hr', 'POST', `/records/leave/${danishLeave}/cancel`, {})
    expect(c.statusCode, c.body).toBe(200)
    const again = await hr('hr', 'POST', `/records/leave/${danishLeave}/reraise`, {})
    expect(again.statusCode, again.body).toBe(201)
    expect(await inboxIds('ceo')).toContain(again.json().id)
  })
})
