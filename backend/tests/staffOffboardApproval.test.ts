// HR's offboard of a login waits for the CEO (owner, 2026-11-05: "Give option to
// HR for off boarding a user/employee with final approval of CEO").
//
//   - HR raises → 202 { pendingApproval, request }; the login stays active.
//   - One pending per login (409 OFFBOARD_PENDING).
//   - The CEO approves → suspended + sessions revoked + staff.offboard audit;
//     reject needs a note ≥10 and leaves the login alone; withdraw by the
//     requester; HR never approves (403).
//   - Company B's HR: 404 on company A's login and request.
//   - The CEO's own offboard applies at once and closes a pending request.
//   - Still never the CEO's login, a co-owner or your own.
//   - The approvals inbox lists the type for the CEO; the registry has it (section ceo, not delegable).
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
vi.mock('../src/lib/tokenRevocation.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/tokenRevocation.js')>()
  return { ...real, revokeAllForSubject: vi.fn(real.revokeAllForSubject) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')
const { revokeAllForSubject } = await import('../src/lib/tokenRevocation.js')
const R = await import('../src/lib/approvalRights.js')

const stamp = Date.now()
const P = `ofr${stamp}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
type U = { id: string; name: string; email: string; role: string }
const U: Record<string, U> = {}

async function mkUser(key: string, role: string, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
  return U[key]!
}
const auth = (key: string) => {
  const u = U[key]!
  return { authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}` }
}
const REASON = 'Resigned, last day was Friday'
const offboard = (key: string, id: string, reason = REASON) =>
  app.inject({ method: 'POST', url: `/api/v1/auth/staff/${id}/offboard`, headers: auth(key), payload: { reason } })
const decide = (key: string, reqId: string, action: 'approve' | 'reject' | 'withdraw', payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/api/v1/auth/staff/offboard-requests/${reqId}/${action}`, headers: auth(key), payload })
const list = (key: string, q = 'status=pending') =>
  app.inject({ method: 'GET', url: `/api/v1/auth/staff/offboard-requests?${q}`, headers: auth(key) })
const status = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id }, select: { accountStatus: true } })).accountStatus

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Offboard Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Offboard Co B', slug: `${P}-b` } })).id
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('hrA', 'hr', [T.A])
  await mkUser('hrA2', 'hr', [T.A])
  await mkUser('hrB', 'hr', [T.B])
  await mkUser('ownerA', 'owner', [T.A])
  for (const k of ['cash1', 'cash2', 'cash3', 'cash4', 'cash5']) await mkUser(k, 'cashier', [T.A])
  await mkUser('fin1', 'finance', [T.A])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const st = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(st).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(authRoutes, { prefix: '/auth' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

describe('the registry', () => {
  it('staff_offboard is a CEO-section type, never handed over', () => {
    expect(R.APPROVAL_TYPES).toContain('staff_offboard')
    expect(R.APPROVAL_RIGHTS.staff_offboard).toMatchObject({ section: 'ceo', delegable: false, roles: ['admin'] })
  })
})

describe('HR asks, the CEO decides', () => {
  let reqId = ''
  it('HR raises → 202, nothing changes on the login; a second raise is 409', async () => {
    const r = await offboard('hrA', U['cash1']!.id)
    expect(r.statusCode).toBe(202)
    expect(r.json()).toMatchObject({ pendingApproval: true, request: { status: 'pending', userId: U['cash1']!.id, tenantId: T.A, requestedById: U['hrA']!.id } })
    reqId = r.json().request.id
    expect(await status(U['cash1']!.id)).toBe('active')
    expect(await prisma.auditLog.findFirst({ where: { entityId: U['cash1']!.id, action: 'staff.offboard' } })).toBeNull()
    expect(await prisma.auditLog.findFirst({ where: { entityId: reqId, action: 'staff.offboard_request' } })).toMatchObject({ tenantId: T.A })
    const again = await offboard('hrA2', U['cash1']!.id)
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('OFFBOARD_PENDING')
    expect((await R.approvalSubject('staff_offboard', reqId))?.status).toBe('pending')
  })

  it('a short reason is refused', async () => {
    expect((await offboard('hrA', U['cash2']!.id, 'short')).statusCode).toBe(400)
  })

  it('HR lists it; company B sees nothing and gets 404 on the login and the request', async () => {
    const l = await list('hrA')
    expect(l.statusCode).toBe(200)
    const item = l.json().items.find((i: { id: string }) => i.id === reqId)
    expect(item).toMatchObject({ login: { id: U['cash1']!.id, role: 'cashier' }, companyName: 'Offboard Co A', requestedByName: U['hrA']!.name })
    expect((await list('hrB')).json().items.some((i: { id: string }) => i.id === reqId)).toBe(false)
    expect((await offboard('hrB', U['cash1']!.id)).statusCode).toBe(404)
    expect((await decide('ceoB', reqId, 'approve')).statusCode).toBe(404)
    expect((await decide('ceoB', reqId, 'reject', { note: 'Not in this company at all' })).statusCode).toBe(404)
    expect((await decide('hrB', reqId, 'withdraw')).statusCode).toBe(404)
  })

  it('HR never approves or rejects (403); the CEO sees it in the approvals inbox', async () => {
    expect((await decide('hrA', reqId, 'approve')).statusCode).toBe(403)
    expect((await decide('hrA2', reqId, 'reject', { note: 'I do not agree with this' })).statusCode).toBe(403)
    const inbox = await app.inject({ method: 'GET', url: '/api/v1/approvals', headers: auth('ceoA') })
    expect(inbox.statusCode).toBe(200)
    const item = inbox.json().items.find((i: { type: string; id: string }) => i.type === 'staff_offboard' && i.id === reqId)
    expect(item).toBeTruthy()
    expect(item.section).toBe('ceo')
    const inboxB = await app.inject({ method: 'GET', url: '/api/v1/approvals', headers: auth('ceoB') })
    expect(inboxB.json().items.some((i: { id: string }) => i.id === reqId)).toBe(false)
  })

  it('the CEO approves → suspended, every session revoked, audited; twice is 409', async () => {
    vi.mocked(revokeAllForSubject).mockClear()
    const r = await decide('ceoA', reqId, 'approve')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ approved: true, status: 'suspended', alreadyOffboarded: false })
    expect(await status(U['cash1']!.id)).toBe('suspended')
    expect(vi.mocked(revokeAllForSubject)).toHaveBeenCalledWith(U['cash1']!.id)
    const a = await prisma.auditLog.findFirst({ where: { entityId: U['cash1']!.id, action: 'staff.offboard' } })
    expect(a).toMatchObject({ tenantId: T.A, userId: U['ceoA']!.id })
    expect(a?.metadata).toMatchObject({ approvedBy: U['ceoA']!.id, requestedBy: U['hrA']!.id })
    expect(a?.after).toMatchObject({ reason: REASON })
    expect(await prisma.auditLog.findFirst({ where: { entityId: reqId, action: 'approval.decide' } })).toBeTruthy()
    const again = await decide('ceoA', reqId, 'approve')
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('REQUEST_NOT_PENDING')
    // Already switched off: HR cannot raise another.
    const more = await offboard('hrA', U['cash1']!.id)
    expect(more.statusCode).toBe(409)
    expect(more.json().error.code).toBe('ALREADY_OFFBOARDED')
  })

  it('reject needs a note ≥10 and leaves the login alone', async () => {
    const r = await offboard('hrA', U['cash2']!.id)
    const id = r.json().request.id
    expect((await decide('ceoA', id, 'reject', { note: 'no' })).statusCode).toBe(400)
    const ok = await decide('ceoA', id, 'reject', { note: 'Keep them, the move was cancelled' })
    expect(ok.statusCode).toBe(200)
    expect(await status(U['cash2']!.id)).toBe('active')
    expect(await prisma.loginOffboardRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'rejected', decidedById: U['ceoA']!.id })
    expect((await decide('ceoA', id, 'approve')).statusCode).toBe(409)
    // Rejected → a new request may be raised.
    expect((await offboard('hrA', U['cash2']!.id)).statusCode).toBe(202)
  })

  it('withdraw: the requester (another HR login may not); the login is untouched', async () => {
    const r = await offboard('hrA', U['cash3']!.id)
    const id = r.json().request.id
    const other = await decide('hrA2', id, 'withdraw')
    expect(other.statusCode).toBe(403)
    expect((await decide('hrA', id, 'withdraw')).statusCode).toBe(200)
    expect(await status(U['cash3']!.id)).toBe('active')
    expect((await prisma.loginOffboardRequest.findUniqueOrThrow({ where: { id } })).status).toBe('withdrawn')
    expect((await decide('hrA', id, 'withdraw')).statusCode).toBe(409)
    expect((await decide('ceoA', id, 'approve')).statusCode).toBe(409)
  })

  it("the CEO's own offboard is immediate and closes a pending request", async () => {
    const r = await offboard('hrA', U['cash4']!.id)
    const id = r.json().request.id
    const c = await offboard('ceoA', U['cash4']!.id)
    expect(c.statusCode).toBe(200)
    expect(c.json()).toMatchObject({ status: 'suspended', alreadyOffboarded: false })
    expect(await status(U['cash4']!.id)).toBe('suspended')
    expect(await prisma.loginOffboardRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'approved', decidedById: U['ceoA']!.id })
    // An office login too, with no request first.
    const f = await offboard('ceoA', U['fin1']!.id)
    expect(f.statusCode).toBe(200)
    expect(await status(U['fin1']!.id)).toBe('suspended')
  })

  it('still never the CEO, a co-owner or your own', async () => {
    expect((await offboard('hrA', U['ceoA']!.id)).json().error.code).toBe('CANNOT_OFFBOARD_CEO')
    expect((await offboard('hrA', U['ownerA']!.id)).json().error.code).toBe('CANNOT_OFFBOARD_OWNER')
    expect((await offboard('hrA', U['hrA']!.id)).json().error.code).toBe('CANNOT_OFFBOARD_SELF')
    expect((await offboard('ceoA', U['ownerA']!.id)).json().error.code).toBe('CANNOT_OFFBOARD_OWNER')
    expect(await prisma.loginOffboardRequest.count({ where: { userId: { in: [U['ceoA']!.id, U['ownerA']!.id, U['hrA']!.id] } } })).toBe(0)
  })

  it('approve re-checks the target now: a login that became a co-owner is refused', async () => {
    const r = await offboard('hrA', U['cash5']!.id)
    const id = r.json().request.id
    await prisma.user.update({ where: { id: U['cash5']!.id }, data: { role: 'owner' } })
    const a = await decide('ceoA', id, 'approve')
    expect(a.statusCode).toBe(403)
    expect(a.json().error.code).toBe('CANNOT_OFFBOARD_OWNER')
    expect(await status(U['cash5']!.id)).toBe('active')
    expect((await prisma.loginOffboardRequest.findUniqueOrThrow({ where: { id } })).status).toBe('pending')
  })
})
