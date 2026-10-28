// Auth audit fixes, staff side (2026-10-10, the night before staff onboard):
//
//   PPL-04  one phone number = one login, at invite / approve / create / edit /
//           reactivate, across companies, without naming another company's
//           holder; phones stored normalised.
//   PPL-05  floor roles (code sign-in) cannot be invited, created or approved
//           without a phone.
//   PPL-06  list / edit / move / delete / approve / reject / reissue / 2FA
//           reset are company-scoped for EVERY admin: company B's CEO gets 404
//           on company A's logins; a login shared with a company you are not in
//           is 403; the group owner (member of every company) manages all.
//           Deletes are audited and identity rows carry the TARGET's company.
//   PPL-10  a suspended login still on HR payroll is flagged on the list.
//   PPL-11  login returns mustChangePassword for generated / reissued
//           passwords; /auth/password/change-authed replaces it and keeps this
//           device signed in.
//   PPL-14  a manager sets their own FIRST override PIN with their password.
//   FOH-19  a manager issues a one-time sign-in code for a floor-staff member
//           of their own company, redeemed through the normal code path.
//
// Real route handlers through Fastify inject, against the disposable test DB
// and Redis (the rate limiters and token revocation are real here).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return { ...real, sendText: vi.fn(async () => undefined), whatsappConfigured: vi.fn(async () => false) }
})
vi.mock('../src/lib/mailer.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/mailer.js')>()
  return { ...real, sendEmail: vi.fn(async () => undefined), emailConfigured: vi.fn(async () => false) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { tenantRoutes } = await import('../src/modules/tenants/routes.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { verifyManagerPin } = await import('../src/modules/auth/managerPin.js')
const { normalisePhone } = await import('../src/modules/auth/otp.js')
const { AppError } = await import('../src/lib/errors.js')

const PREFIX = 'aap'
const STAMP = Date.now()
const PASSWORD = 'Correct-Horse-Battery-77'
let app: FastifyInstance
let tenantA: string   // "GS Foods"
let tenantB: string   // "Karachi Bites"
const created: string[] = []

// Unique per run: the per-phone rate-limit buckets live in Redis and outlast a
// run, and one number may only be on one login.
let phoneSeq = 0
function uniquePhone(): string {
  const n = ((STAMP % 900_000_000) + 100_000_000 + phoneSeq++ * 7919) % 1_000_000_000
  return `03${String(n).padStart(9, '0')}`
}
let emailSeq = 0
const uniqueEmail = (tag: string) => `${PREFIX}.${tag}.${STAMP}.${emailSeq++}@gsfoods.pk`

async function makeUser(opts: {
  role: string; tenantId: string | null; also?: string[]; phone?: string | null
  accountStatus?: 'pending' | 'active' | 'suspended'; isActive?: boolean; pin?: string; mustChangePassword?: boolean
}) {
  const companies = [...(opts.tenantId ? [opts.tenantId] : []), ...(opts.also ?? [])]
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${opts.role} ${created.length + 1}`,
      email: uniqueEmail(opts.role),
      password: await bcrypt.hash(PASSWORD, 4),
      role: opts.role as never,
      tenantId: opts.tenantId,
      phone: opts.phone ?? null,
      accountStatus: opts.accountStatus ?? 'active',
      isActive: opts.isActive ?? true,
      pin: opts.pin ? await bcrypt.hash(opts.pin, 4) : null,
      mustChangePassword: opts.mustChangePassword ?? false,
      ...(companies.length ? { tenantMemberships: { create: companies.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) } } : {}),
    },
    select: { id: true, name: true, email: true, role: true },
  })
  created.push(u.id)
  return u
}

type U = { id: string; name: string | null; email: string | null; role: string }
function auth(u: U, extra: Record<string, string> = {}) {
  const s = issueStaffSession({ id: u.id, name: u.name ?? '', email: u.email, role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}`, ...extra }
}
const call = (u: U, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/api/v1/auth${url}`, headers: auth(u, headers), ...(payload ? { payload } : {}) })

let owner: U        // the group owner — member of A and B
let ceoB: U         // Karachi Bites' CEO — B only

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'AAP GS Foods', slug: `${PREFIX}-a-${STAMP}` }, select: { id: true } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'AAP Karachi Bites', slug: `${PREFIX}-b-${STAMP}` }, select: { id: true } })).id
  owner = await makeUser({ role: 'admin', tenantId: tenantA, also: [tenantB] })
  ceoB = await makeUser({ role: 'admin', tenantId: tenantB })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.register(tenantRoutes, { prefix: '/api/v1/tenants' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  const extra = await prisma.user.findMany({ where: { email: { startsWith: `${PREFIX}.` } }, select: { id: true } })
  const ids = Array.from(new Set([...created, ...extra.map((u) => u.id)]))
  await prisma.hrEmployee.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { userId: { in: ids } }] } })
  await prisma.staffPasswordReset.deleteMany({ where: { userId: { in: ids } } })
  await prisma.tenantMember.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

// ─── PPL-06 ──────────────────────────────────────────────────────────────────

describe('PPL-06: staff admin is company-scoped for every admin', () => {
  it('company B\'s CEO cannot list, edit, move, delete, approve, reject, reissue or reset company A\'s logins (404)', async () => {
    const aCashier = await makeUser({ role: 'cashier', tenantId: tenantA, phone: normalisePhone(uniquePhone()) })
    const aPending = await makeUser({ role: 'finance', tenantId: tenantA, accountStatus: 'pending' })

    const list = await call(ceoB, 'GET', '/users', undefined, { 'x-servd-portfolio': '1' })
    expect(list.statusCode).toBe(200)
    const ids = list.json().map((u: { id: string }) => u.id)
    expect(ids).toContain(ceoB.id)
    expect(ids).not.toContain(aCashier.id)
    expect(ids).not.toContain(aPending.id)

    expect((await call(ceoB, 'PATCH', `/users/${aCashier.id}`, { role: 'hr', tenantId: tenantB, tenantIds: [tenantB] })).statusCode).toBe(404)
    expect((await call(ceoB, 'DELETE', `/users/${aCashier.id}`)).statusCode).toBe(404)
    expect((await call(ceoB, 'POST', `/users/${aCashier.id}/reissue-password`, {})).statusCode).toBe(404)
    // Two-step sign-in is retired (owner, 2026-10-26): the reset answers 410 for everyone.
    expect((await call(ceoB, 'POST', `/users/${aCashier.id}/2fa/reset`, {})).statusCode).toBe(410)
    expect((await call(ceoB, 'PATCH', `/staff/${aPending.id}/approve`, {})).statusCode).toBe(404)
    expect((await call(ceoB, 'PATCH', `/staff/${aPending.id}/reject`, {})).statusCode).toBe(404)

    const after = await prisma.user.findUniqueOrThrow({ where: { id: aCashier.id }, select: { role: true, tenantId: true, deletedAt: true, accountStatus: true } })
    expect(after).toEqual({ role: 'cashier', tenantId: tenantA, deletedAt: null, accountStatus: 'active' })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: aPending.id } })).accountStatus).toBe('pending')
  })

  it('UI-11: the company switcher lists only companies the operator belongs to, admin or not', async () => {
    const mineB = await app.inject({ method: 'GET', url: '/api/v1/tenants/mine', headers: auth(ceoB) })
    expect(mineB.statusCode).toBe(200)
    expect(mineB.json().map((t: { id: string }) => t.id)).toEqual([tenantB])
    const mineOwner = await app.inject({ method: 'GET', url: '/api/v1/tenants/mine', headers: auth(owner) })
    expect(mineOwner.json().map((t: { id: string }) => t.id).sort()).toEqual([tenantA, tenantB].sort())
    expect(mineOwner.json().find((t: { id: string }) => t.id === tenantA).isActive).toBe(true)
    // The admin-only company list is scoped the same way.
    const listB = await app.inject({ method: 'GET', url: '/api/v1/tenants', headers: auth(ceoB) })
    expect(listB.json().map((t: { id: string }) => t.id)).toEqual([tenantB])
  })

  it('an operator with no company lists no staff (empty scope denies)', async () => {
    const stray = await makeUser({ role: 'admin', tenantId: null })
    const r = await call(stray, 'GET', '/users', undefined, { 'x-servd-portfolio': '1' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual([])
  })

  it('lists by read scope: active company only, or every company in portfolio view; the owner sees both', async () => {
    const aCook = await makeUser({ role: 'kitchen', tenantId: tenantA, phone: normalisePhone(uniquePhone()) })
    const bCook = await makeUser({ role: 'kitchen', tenantId: tenantB, phone: normalisePhone(uniquePhone()) })
    const single = (await call(owner, 'GET', '/users')).json().map((u: { id: string }) => u.id)
    expect(single).toContain(aCook.id)
    expect(single).not.toContain(bCook.id)
    const all = (await call(owner, 'GET', '/users', undefined, { 'x-servd-portfolio': '1' })).json().map((u: { id: string }) => u.id)
    expect(all).toEqual(expect.arrayContaining([aCook.id, bCook.id]))
  })

  it('a login shared with a company the operator is not in: visible, but 403 to change; the owner may', async () => {
    const shared = await makeUser({ role: 'procurement', tenantId: tenantA, also: [tenantB] })
    const row = (await call(ceoB, 'GET', '/users')).json().find((u: { id: string }) => u.id === shared.id)
    expect(row).toBeTruthy()
    // Only B's chip — A's name is not B's to read — and a flag that it spans more.
    expect(row.tenants.map((t: { id: string }) => t.id)).toEqual([tenantB])
    expect(row.inOtherCompanies).toBe(true)

    const r = await call(ceoB, 'PATCH', `/users/${shared.id}`, { isActive: false })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('LOGIN_IN_OTHER_COMPANY')
    expect((await call(ceoB, 'DELETE', `/users/${shared.id}`)).statusCode).toBe(403)
    expect((await call(owner, 'PATCH', `/users/${shared.id}`, { jobTitle: 'Head-office buyer' })).statusCode).toBe(200)
  })

  it('creates and transfers only into the operator\'s own companies (422); a create binds to the active company', async () => {
    const intoA = await call(ceoB, 'POST', '/users', { email: uniqueEmail('x'), role: 'finance', tenantId: tenantA })
    expect(intoA.statusCode).toBe(422)
    const extraA = await call(ceoB, 'POST', '/users', { email: uniqueEmail('x'), role: 'finance', tenantIds: [tenantB, tenantA] })
    expect(extraA.statusCode).toBe(422)

    const ok = await call(ceoB, 'POST', '/users', { email: uniqueEmail('kbfin'), role: 'finance' })
    expect(ok.statusCode).toBe(201)
    created.push(ok.json().id)
    expect(ok.json().tenantId).toBe(tenantB)

    const move = await call(ceoB, 'PATCH', `/users/${ok.json().id}`, { tenantIds: [tenantB, tenantA] })
    expect(move.statusCode).toBe(422)

    // The owner may give someone a second company from any active company.
    const both = await call(owner, 'PATCH', `/users/${ok.json().id}`, { tenantIds: [tenantB, tenantA] })
    expect(both.statusCode).toBe(200)
    const moves = await prisma.auditLog.findMany({ where: { entityId: ok.json().id, action: 'user.company_change' }, select: { tenantId: true } })
    // Filed under the company it was in and the one it joined.
    expect(moves.map((m) => m.tenantId).sort()).toEqual([tenantA, tenantB].sort())
  })

  it('deletes are audited, and identity rows carry the TARGET\'s company, not the actor\'s', async () => {
    const aFoh = await makeUser({ role: 'foh', tenantId: tenantA, phone: normalisePhone(uniquePhone()) })
    // The owner acting while their active company is B.
    const asB = { 'x-servd-active-tenant': tenantB }
    expect((await call(owner, 'PATCH', `/users/${aFoh.id}`, { role: 'cashier' }, asB)).statusCode).toBe(200)
    expect((await call(owner, 'POST', `/users/${aFoh.id}/reissue-password`, {}, asB)).statusCode).toBe(200)
    expect((await call(owner, 'POST', `/users/${aFoh.id}/2fa/reset`, {}, asB)).statusCode).toBe(410) // retired 2026-10-26
    expect((await call(owner, 'DELETE', `/users/${aFoh.id}`, undefined, asB)).statusCode).toBe(204)

    const rows = await prisma.auditLog.findMany({ where: { entityId: aFoh.id }, select: { action: true, tenantId: true, userId: true, metadata: true } })
    const byAction = new Map(rows.map((r) => [r.action, r]))
    for (const action of ['user.role_change', 'user.password_reissue', 'user.delete']) {
      expect(byAction.get(action), action).toMatchObject({ tenantId: tenantA, userId: owner.id })
      expect((byAction.get(action)!.metadata as { actorTenantId: string }).actorTenantId).toBe(tenantB)
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: aFoh.id } })).deletedAt).not.toBeNull()
  })
})

// ─── PPL-04 / PPL-05 ─────────────────────────────────────────────────────────

// Retired 2026-10-28 (owner: email + password for every staff login, no WhatsApp codes): the floor phone-number
// and manager sign-in-code rules this file used to test are gone; staffOtpLogin.test.ts defends the retirement.
describe('PPL-10: a switched-off login still on payroll is flagged', () => {
  it('lists the linked employee until HR separates them', async () => {
    const imran = await makeUser({ role: 'kitchen', tenantId: tenantA, phone: normalisePhone(uniquePhone()) })
    const emp = await prisma.hrEmployee.create({ data: { tenantId: tenantA, employeeCode: `${PREFIX}-${STAMP}-1`, fullName: 'Imran Shah', userId: imran.id } })
    expect((await call(owner, 'PATCH', `/users/${imran.id}`, { isActive: false })).statusCode).toBe(200)

    const row = (await call(owner, 'GET', '/users?status=suspended')).json().find((u: { id: string }) => u.id === imran.id)
    expect(row.accountStatus).toBe('suspended')
    expect(row.payroll).toMatchObject({ employeeId: emp.id, status: 'active' })

    await prisma.hrEmployee.update({ where: { id: emp.id }, data: { status: 'separated' } })
    const after = (await call(owner, 'GET', '/users?status=suspended')).json().find((u: { id: string }) => u.id === imran.id)
    expect(after.payroll).toBeNull()

    // Another company's employee record is not shown to it.
    const b = (await call(ceoB, 'GET', '/users')).json()
    expect(b.find((u: { id: string }) => u.id === imran.id)).toBeUndefined()
  })
})

// ─── PPL-11 ──────────────────────────────────────────────────────────────────

describe('PPL-11: generated passwords are flagged at sign-in and can be replaced', () => {
  it('a CEO-created login signs in with mustChangePassword, changes it, and stays signed in on this device only', async () => {
    const created_ = await call(owner, 'POST', '/users', { email: uniqueEmail('newhr'), role: 'hr' })
    expect(created_.statusCode).toBe(201)
    const { id, email, temporaryPassword } = created_.json()
    created.push(id)

    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: temporaryPassword } })
    expect(login.statusCode).toBe(200)
    expect(login.json().user.mustChangePassword).toBe(true)
    const oldToken = login.json().accessToken as string

    const acct = await app.inject({ method: 'GET', url: '/api/v1/auth/account', headers: { authorization: `Bearer ${oldToken}` } })
    expect(acct.json()).toMatchObject({ mustChangePassword: true, usesCodeLogin: false })

    // Revocation works in whole seconds; make sure the old token is older.
    await new Promise((r) => setTimeout(r, 1100))
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/password/change-authed', headers: { authorization: `Bearer ${oldToken}` }, payload: { currentPassword: 'not-it-at-all', newPassword: 'Mango-Lassi-Rooftop-42' } })
    expect(wrong.statusCode).toBe(400)
    const change = await app.inject({ method: 'POST', url: '/api/v1/auth/password/change-authed', headers: { authorization: `Bearer ${oldToken}` }, payload: { currentPassword: temporaryPassword, newPassword: 'Mango-Lassi-Rooftop-42' } })
    expect(change.statusCode).toBe(200)
    const fresh = change.json().accessToken as string
    expect(change.json().user.mustChangePassword).toBe(false)

    // This device carries on; the token from before the change is dead.
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/account', headers: { authorization: `Bearer ${fresh}` } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/account', headers: { authorization: `Bearer ${oldToken}` } })).statusCode).toBe(401)

    const again = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'Mango-Lassi-Rooftop-42' } })
    expect(again.json().user.mustChangePassword).toBe(false)
    expect(await prisma.auditLog.count({ where: { entityId: id, action: 'user.password_change' } })).toBe(1)
  })

  it('a reissued password is flagged again', async () => {
    const fin = await makeUser({ role: 'finance', tenantId: tenantA })
    const r = await call(owner, 'POST', `/users/${fin.id}/reissue-password`, {})
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: fin.email, password: r.json().temporaryPassword } })
    expect(login.json().user.mustChangePassword).toBe(true)
  })
})

// ─── PPL-14 ──────────────────────────────────────────────────────────────────

describe('PPL-14: a manager sets their own first override PIN', () => {
  it('first PIN needs the password; after that, the current PIN', async () => {
    const mgr = await makeUser({ role: 'fnb_manager', tenantId: tenantA })
    const noPw = await call(mgr, 'POST', '/pin/change', { currentPin: '0000', newPin: '482639' })
    expect(noPw.statusCode).toBe(400)
    expect(noPw.json().error.code).toBe('PASSWORD_REQUIRED')
    expect((await call(mgr, 'POST', '/pin/change', { password: 'wrong-password', newPin: '482639' })).json().error.code).toBe('WRONG_PASSWORD')
    expect((await call(mgr, 'POST', '/pin/change', { password: PASSWORD, newPin: '123456' })).json().error.code).toBe('WEAK_PIN')
    const ok = await call(mgr, 'POST', '/pin/change', { password: PASSWORD, newPin: '482639' })
    expect(ok.statusCode).toBe(200)
    expect((await verifyManagerPin('482639', tenantA))?.id).toBe(mgr.id)
    expect(await prisma.auditLog.count({ where: { entityId: mgr.id, action: 'user.pin_set', tenantId: tenantA } })).toBe(1)

    // Now there is a PIN: the password alone no longer changes it.
    expect((await call(mgr, 'POST', '/pin/change', { password: PASSWORD, newPin: '593741' })).json().error.code).toBe('BAD_PIN')
    expect((await call(mgr, 'POST', '/pin/change', { currentPin: '482639', newPin: '593741' })).statusCode).toBe(200)
    expect((await verifyManagerPin('593741', tenantA))?.id).toBe(mgr.id)
  })

  it('only override approvers get a first PIN, and wrong guesses lock out', async () => {
    const cashier = await makeUser({ role: 'cashier', tenantId: tenantA, phone: normalisePhone(uniquePhone()) })
    expect((await call(cashier, 'POST', '/pin/change', { password: PASSWORD, newPin: '482639' })).statusCode).toBe(403)

    const mgr = await makeUser({ role: 'foh_management', tenantId: tenantA })
    for (let i = 0; i < 5; i++) {
      expect((await call(mgr, 'POST', '/pin/change', { password: `wrong-${i}`, newPin: '482639' })).statusCode).toBe(400)
    }
    expect((await call(mgr, 'POST', '/pin/change', { password: PASSWORD, newPin: '482639' })).statusCode).toBe(429)
  })
})

// ─── FOH-19 ──────────────────────────────────────────────────────────────────
