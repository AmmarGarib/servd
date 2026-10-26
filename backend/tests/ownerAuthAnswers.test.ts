// Owner answers of 2026-10-26, auth / permissions area:
//   C1  new manager PINs are 6–8 digits (422 PIN_TOO_SHORT); a short PIN still
//       approves on its next use, is flagged, and is refused once the grace is over.
//   C2  the CEO's Module Access ticks bind manager tiers on OpEx / Positions /
//       petty cash / deposit drops (moduleGateForNewRoles) and stock counts.
//   C14 floor staff get a code-only login (no email, no password link) and use
//       My HR (/hr/me) for their own data.
//   C20 managers correct a guest's phone / email with a reason — audited,
//       sessions revoked, verification cleared, collisions refused, two companies.
//   C3  the F&B manager / chef raise a kitchen station add / change; it applies
//       only when the CEO approves (approval type station_change).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const resetSpy = vi.fn(async () => ({ email: 'sent', whatsapp: 'skipped', errors: [] as string[] }))
vi.mock('../src/modules/auth/passwordReset.js', async (orig) => {
  const real = await orig<typeof import('../src/modules/auth/passwordReset.js')>()
  return { ...real, requestPasswordReset: resetSpy, deliveryConfigured: vi.fn(async () => true) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { crmRoutes } = await import('../src/modules/crm/routes.js')
const { stationRoutes } = await import('../src/modules/stations/routes.js')
const { hrRoutes } = await import('../src/modules/hr/routes.js')
const { verifyManagerPin, setManagerPin, SHORT_PIN_GRACE_HOURS } = await import('../src/modules/auth/managerPin.js')
const { moduleGateForNewRoles } = await import('../src/modules/opex/moduleGate.js')
const { enforceModuleAccess } = await import('../src/lib/moduleAccess.js')
const { approvalSubject } = await import('../src/lib/approvalRights.js')
const { isRevoked } = await import('../src/lib/tokenRevocation.js')

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
let tenantA: string, tenantB: string, conceptA: string, conceptA2: string, conceptB: string
type U = { id: string; name: string; email: string | null; role: string }
const users: Record<string, U> = {}
const userIds: string[] = []
let seq = 0

async function mkUser(key: string, role: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `oaa ${key}`, email: `oaa.${key}.${RUN}@gsfoods.pk`, password: await bcrypt.hash('x-Password-12345', 4),
      role, isActive: true, accountStatus: 'active', tenantId,
      tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
      ...extra,
    } as never,
    select: { id: true, name: true, email: true, role: true },
  })
  users[key] = u as U
  userIds.push(u.id)
  return u as U
}
const tok = (u: U) => `Bearer ${(issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }) as { accessToken: string }).accessToken}`
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: tok(users[who]!) }, ...(payload ? { payload } : {}) })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'OAA A', slug: `oaa-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'OAA B', slug: `oaa-b-${RUN}` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'OAA Brand A', slug: `oaa-brand-a-${RUN}`, type: 'restaurant', tenantId: tenantA } as never })).id
  conceptA2 = (await prisma.concept.create({ data: { name: 'OAA Brand A2', slug: `oaa-brand-a2-${RUN}`, type: 'restaurant', tenantId: tenantA } as never })).id
  conceptB = (await prisma.concept.create({ data: { name: 'OAA Brand B', slug: `oaa-brand-b-${RUN}`, type: 'restaurant', tenantId: tenantB } as never })).id
  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('fnbA', 'fnb_manager', tenantA)
  await mkUser('chefA', 'boh_management', tenantA)
  await mkUser('fohA', 'foh_management', tenantA)
  await mkUser('mgmtA', 'management', tenantA)
  await mkUser('fohB', 'foh_management', tenantB)
  await mkUser('cashierA', 'cashier', tenantA)
  await mkUser('hrA', 'hr', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(crmRoutes, { prefix: '/crm' })
  await app.register(stationRoutes, { prefix: '/stations' })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  const ids = [...userIds, ...(await prisma.user.findMany({ where: { email: { startsWith: 'oaa.' } }, select: { id: true } })).map((u) => u.id)]
  await prisma.stationChangeRequest.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
  await prisma.station.deleteMany({ where: { conceptId: { in: [conceptA, conceptA2, conceptB] } } })
  await prisma.hrEmployee.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
  await prisma.staffNotification.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined)
  await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] } })
  await prisma.tenantMember.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
})

// ─── C1 ──────────────────────────────────────────────────────────────────────
describe('C1: manager PINs are at least 6 digits', () => {
  it('a new PIN of 4–5 digits is 422 PIN_TOO_SHORT; 6–8 digits are accepted', async () => {
    await expect(setManagerPin(users.mgmtA!.id, '4827')).rejects.toMatchObject({ code: 'PIN_TOO_SHORT', statusCode: 422 })
    await expect(setManagerPin(users.mgmtA!.id, '48271')).rejects.toMatchObject({ code: 'PIN_TOO_SHORT' })
    await expect(setManagerPin(users.mgmtA!.id, '482719')).resolves.toBeUndefined()
    const r = await call('fnbA', 'POST', '/auth/pin/change', { password: 'x-Password-12345', newPin: '5937' })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('PIN_TOO_SHORT')
  })

  it('a short PIN still approves once, is flagged, and is refused after the grace; a new PIN clears it', async () => {
    const mgr = await mkUser('shortPin', 'foh_management', tenantA, { pin: await bcrypt.hash('7351', 4) })
    expect((await verifyManagerPin('7351', tenantA, undefined, { actorId: users.cashierA!.id }))?.id).toBe(mgr.id)
    const flagged = await prisma.user.findUniqueOrThrow({ where: { id: mgr.id }, select: { pinChangeRequiredAt: true } })
    expect(flagged.pinChangeRequiredAt).not.toBeNull()
    const acct = (await call('shortPin', 'GET', '/auth/account')).json()
    expect(acct.pinChangeRequired).toBe(true)
    expect(acct.minPinLength).toBe(6)
    // Within the grace: still works.
    expect((await verifyManagerPin('7351', tenantA, undefined, { actorId: users.cashierA!.id }))?.id).toBe(mgr.id)
    // Past the grace: refused.
    await prisma.user.update({ where: { id: mgr.id }, data: { pinChangeRequiredAt: new Date(Date.now() - (SHORT_PIN_GRACE_HOURS + 1) * 3600_000) } })
    await expect(verifyManagerPin('7351', tenantA, undefined, { actorId: users.cashierA!.id })).rejects.toMatchObject({ code: 'PIN_CHANGE_REQUIRED', statusCode: 403 })
    // The holder changes it with the short PIN as the current one.
    const ch = await call('shortPin', 'POST', '/auth/pin/change', { currentPin: '7351', newPin: '735168' })
    expect(ch.statusCode).toBe(200)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: mgr.id }, select: { pinChangeRequiredAt: true } })).pinChangeRequiredAt).toBeNull()
    expect((await verifyManagerPin('735168', tenantA, undefined, { actorId: users.cashierA!.id }))?.id).toBe(mgr.id)
  })
})

// ─── C2 ──────────────────────────────────────────────────────────────────────
describe('C2: Module Access ticks bind managers too', () => {
  const req = (u: U) => ({ staffUser: { id: u.id, role: u.role } }) as never
  it('a manager without the module is refused; with it passes; the CEO always passes', async () => {
    await expect(moduleGateForNewRoles(['capital'])(req(users.fohA!))).rejects.toMatchObject({ statusCode: 403 })
    await expect(moduleGateForNewRoles(['accounting'])(req(users.chefA!))).rejects.toMatchObject({ statusCode: 403 })
    await expect(moduleGateForNewRoles(['accounting'])(req(users.fnbA!))).resolves.toBeUndefined()
    await expect(moduleGateForNewRoles(['capital'])(req(users.ceoA!))).resolves.toBeUndefined()
    await expect(moduleGateForNewRoles(['staff_directory', 'capital'])(req(users.fohA!))).resolves.toBeUndefined()
  })
  it("the CEO's per-person untick now closes it for a manager", async () => {
    await prisma.user.update({ where: { id: users.mgmtA!.id }, data: { moduleDeny: ['capital'] } })
    await expect(moduleGateForNewRoles(['capital'])(req(users.mgmtA!))).rejects.toMatchObject({ statusCode: 403 })
    await prisma.user.update({ where: { id: users.mgmtA!.id }, data: { moduleDeny: [] } })
  })
  it('stock counts are gated on inventory | accounting', async () => {
    await expect(enforceModuleAccess('/api/v1/crosschecks/physical-counts', { role: 'foh_management' as never }, 'POST')).rejects.toMatchObject({ statusCode: 403 })
    await expect(enforceModuleAccess('/api/v1/crosschecks/physical-counts', { role: 'boh_management' as never }, 'POST')).resolves.toBeUndefined()
    await expect(enforceModuleAccess('/api/v1/crosschecks/physical-counts', { role: 'boh_management' as never, moduleDeny: ['inventory'] }, 'GET')).rejects.toMatchObject({ statusCode: 403 })
    await expect(enforceModuleAccess('/api/v1/crosschecks/physical-counts', { role: 'finance' as never }, 'GET')).resolves.toBeUndefined()
  })
})

// ─── C14 ─────────────────────────────────────────────────────────────────────
describe('C14: floor staff sign in with a code and use My HR', () => {
  it('HR creates a floor login with no email — active at once, linked, no password link; office logins still need an email', async () => {
    const emp = await prisma.hrEmployee.create({ data: { tenantId: tenantA, employeeCode: `oaa-${RUN}-1`, fullName: 'Floor Cook', status: 'active' } })
    const phone = `0301${String(1_000_000 + Math.floor(Math.random() * 8_999_999)).slice(0, 7)}`
    resetSpy.mockClear()
    const r = await call('hrA', 'POST', '/auth/staff/invite', { name: 'Floor Cook', email: '', phone, role: 'kitchen', employeeId: emp.id })
    expect(r.statusCode).toBe(201)
    const body = r.json()
    expect(body.status).toBe('active')
    expect(body.email).toBeNull()
    expect(body.linkedEmployeeId).toBe(emp.id)
    expect(body.passwordLink).toBe('unavailable')
    expect(resetSpy).not.toHaveBeenCalled()
    userIds.push(body.id)

    const office = await call('hrA', 'POST', '/auth/staff/invite', { name: 'No Mail', role: 'procurement' })
    expect(office.statusCode).toBe(400)
    expect(office.json().error.code).toBe('EMAIL_REQUIRED')

    // The floor login reads its own My HR.
    const cook = { id: body.id, name: 'Floor Cook', email: null, role: 'kitchen' }
    users.cook = cook
    const me = await call('cook', 'GET', '/hr/me')
    expect(me.statusCode).toBe(200)
    expect(me.json().profile.employeeCode).toBe(`oaa-${RUN}-1`)
    expect(me.json().canRequest).toContain('leave')
  })
})

// ─── C20 ─────────────────────────────────────────────────────────────────────
describe('C20: managers correct a guest phone / email', () => {
  let guest: string, other: string
  beforeAll(async () => {
    seq++
    guest = (await prisma.customer.create({ data: { name: 'Guest', email: `g.${RUN}@oaa.test`, phone: `92300${String(Date.now()).slice(-7)}`, phoneVerifiedAt: new Date(), emailVerifiedAt: new Date() } })).id
    other = (await prisma.customer.create({ data: { name: 'Other', email: `o.${RUN}@oaa.test`, phone: `92301${String(Date.now()).slice(-7)}` } })).id
    for (const c of [guest, other]) {
      await prisma.order.create({ data: { conceptId: conceptA, customerId: c, source: 'pos', status: 'completed', totalCents: 1000, placedAt: new Date(), items: { create: [{ name: 'Tea', quantity: 1, unitPriceCents: 1000 }] } } as never })
    }
  })

  it("company B's manager gets 404; a cashier is refused; a short reason is 400", async () => {
    expect((await call('fohB', 'POST', `/crm/customers/${guest}/contact`, { phone: '03009998887', reason: 'typo in the number at sign-up' })).statusCode).toBe(404)
    expect((await call('cashierA', 'POST', `/crm/customers/${guest}/contact`, { phone: '03009998887', reason: 'typo in the number at sign-up' })).statusCode).toBe(403)
    expect((await call('fohA', 'POST', `/crm/customers/${guest}/contact`, { phone: '03009998887', reason: 'short' })).statusCode).toBe(400)
  })

  it('refuses a contact another guest holds (409)', async () => {
    const o = await prisma.customer.findUniqueOrThrow({ where: { id: other } })
    const r = await call('fohA', 'POST', `/crm/customers/${guest}/contact`, { phone: o.phone!, reason: 'guest says this is the number' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('PHONE_TAKEN')
    const e = await call('fohA', 'POST', `/crm/customers/${guest}/contact`, { email: o.email!.toUpperCase(), reason: 'guest says this is the email' })
    expect(e.json().error.code).toBe('EMAIL_TAKEN')
  })

  it('changes the phone: verification cleared, sessions revoked, audited old → new; staff logins untouched', async () => {
    const before = await prisma.customer.findUniqueOrThrow({ where: { id: guest } })
    const iat = Math.floor(Date.now() / 1000) - 5
    const newPhone = `0333${String(Date.now()).slice(-7)}`
    const r = await call('fohA', 'POST', `/crm/customers/${guest}/contact`, { phone: newPhone, reason: 'wrong digit typed at the till' })
    expect(r.statusCode).toBe(200)
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: guest } })
    expect(after.phone).toBe(`92${newPhone.slice(1)}`)
    expect(after.phoneVerifiedAt).toBeNull()
    expect(after.emailVerifiedAt).not.toBeNull()
    expect(await isRevoked('some-old-token', guest, iat)).toBe(true)
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'customer.contact_change', entityId: guest } })
    expect(a.tenantId).toBe(tenantA)
    expect(a.before).toEqual({ phone: before.phone })
    expect(a.after).toEqual({ phone: after.phone })
    expect((a.metadata as { reason: string }).reason).toBe('wrong digit typed at the till')
  })
})

// ─── C3 ──────────────────────────────────────────────────────────────────────
describe('C3: kitchen stations — the F&B manager and the chef raise, the CEO approves', () => {
  it('a raised add waits (202) and is made only on the CEO approval', async () => {
    const r = await call('fnbA', 'POST', '/stations', { conceptId: conceptA, name: 'Grill', displayOrder: 1 })
    expect(r.statusCode).toBe(202)
    expect(r.json().pendingApproval).toBe(true)
    const reqId = r.json().request.id
    expect(await prisma.station.count({ where: { conceptId: conceptA, name: 'Grill' } })).toBe(0)
    const s = await approvalSubject('station_change', reqId)
    expect(s).toMatchObject({ ownerTenantId: tenantA, status: 'pending' })

    // Company B's CEO cannot see or decide it; the requester cannot approve.
    expect((await call('ceoB', 'POST', `/stations/requests/${reqId}/approve`, {})).statusCode).toBe(404)
    expect((await call('fnbA', 'POST', `/stations/requests/${reqId}/approve`, {})).statusCode).toBe(403)
    const listB = (await call('ceoB', 'GET', '/stations/requests?status=pending')).json()
    expect(listB.items.map((i: { id: string }) => i.id)).not.toContain(reqId)
    const listA = (await call('ceoA', 'GET', '/stations/requests?status=pending')).json()
    expect(listA.items.map((i: { id: string }) => i.id)).toContain(reqId)

    const ok = await call('ceoA', 'POST', `/stations/requests/${reqId}/approve`, {})
    expect(ok.statusCode).toBe(200)
    const st = await prisma.station.findFirstOrThrow({ where: { conceptId: conceptA, name: 'Grill' } })
    expect(ok.json().stationId).toBe(st.id)
    expect((await call('ceoA', 'POST', `/stations/requests/${reqId}/approve`, {})).statusCode).toBe(409)
  })

  it('a chef rename waits; one pending per station; reject needs a note; the CEO edits at once', async () => {
    const st = await prisma.station.create({ data: { conceptId: conceptA, name: 'Fry', displayOrder: 2 } })
    const r = await call('chefA', 'PATCH', `/stations/${st.id}`, { name: 'Fryer' })
    expect(r.statusCode).toBe(202)
    expect((await call('fnbA', 'PATCH', `/stations/${st.id}`, { name: 'Fry line' })).json().error.code).toBe('STATION_CHANGE_PENDING')
    expect((await prisma.station.findUniqueOrThrow({ where: { id: st.id } })).name).toBe('Fry')
    const id = r.json().request.id
    expect((await call('ceoA', 'POST', `/stations/requests/${id}/reject`, { note: 'no' })).statusCode).toBe(400)
    expect((await call('ceoA', 'POST', `/stations/requests/${id}/reject`, { note: 'keep the name the cooks know' })).statusCode).toBe(200)
    expect((await prisma.station.findUniqueOrThrow({ where: { id: st.id } })).name).toBe('Fry')

    // The CEO's own edit applies at once.
    const ceo = await call('ceoA', 'PATCH', `/stations/${st.id}`, { name: 'Fry station' })
    expect(ceo.statusCode).toBe(200)
    expect((await prisma.station.findUniqueOrThrow({ where: { id: st.id } })).name).toBe('Fry station')
  })

  it("another company's station or brand is 404; a cashier or the FOH manager cannot raise; nothing-to-change is 409", async () => {
    const stB = await prisma.station.create({ data: { conceptId: conceptB, name: 'B Grill' } })
    expect((await call('fnbA', 'PATCH', `/stations/${stB.id}`, { name: 'Mine now' })).statusCode).toBe(404)
    expect((await call('fnbA', 'POST', '/stations', { conceptId: conceptB, name: 'X' })).statusCode).toBe(404)
    expect((await call('fohA', 'POST', '/stations', { conceptId: conceptA, name: 'Bar' })).statusCode).toBe(403)
    expect((await call('cashierA', 'POST', '/stations', { conceptId: conceptA, name: 'Bar' })).statusCode).toBe(403)
    const st = await prisma.station.create({ data: { conceptId: conceptA2, name: 'Pass' } })
    expect((await call('fnbA', 'PATCH', `/stations/${st.id}`, { name: 'Pass' })).json().error.code).toBe('NOTHING_TO_CHANGE')
    // The requester withdraws their own.
    const r = await call('fnbA', 'PATCH', `/stations/${st.id}`, { displayOrder: 5 })
    expect((await call('chefA', 'POST', `/stations/requests/${r.json().request.id}/cancel`)).statusCode).toBe(403)
    expect((await call('fnbA', 'POST', `/stations/requests/${r.json().request.id}/cancel`)).statusCode).toBe(200)
  })
})
