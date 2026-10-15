// HR onboards and offboards; the CEO decides what each person sees
// (owner, 2026-10-15).
//
//   - HR adds logins for every role but the CEO / co-owner seats. Floor logins
//     (cashier, FOH, BOH, kitchen, expediter) are ACTIVE at once with the same
//     side effects as an approval (employee linked); manager / office logins
//     wait for the CEO in the approvals inbox (staff_login). Managers' invites
//     stay pending. An invite never carries module access.
//   - Offboard / reinstate: HR and the CEO only, inside their companies (404
//     otherwise); never the CEO's login, never your own. Offboard revokes
//     every session. HR's reinstate of an office login waits for the CEO.
//   - Per-person modules: the CEO only, stored as the difference from the role
//     preset; null resets; the CEO's own row and any admin row are refused.
//   - Only the CEO changes module access: role presets, PATCH moduleAllow /
//     moduleDeny, and the per-person route are all admin-only.
//
// Real route handlers through Fastify inject; needs the disposable test DB.
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
const { permissionRoutes } = await import('../src/modules/permissions/routes.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')
const { effectiveModulesForUser, rolePresetModules } = await import('../src/lib/moduleAccess.js')
const { CHILD_ROLES } = await import('../src/lib/workspaces.js')
const { ASSIGNABLE_ROLES } = await import('../src/lib/roles.js')
const { revokeAllForSubject } = await import('../src/lib/tokenRevocation.js')

const stamp = Date.now()
const P = `onb${stamp}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
type U = { id: string; name: string; email: string; role: string }
const U: Record<string, U> = {}
let phoneSeq = 0
const phone = () => `0333${String(stamp).slice(-5)}${String(++phoneSeq).padStart(2, '0')}`
const email = (k: string) => `${P}.${k}.${++phoneSeq}@gsfoods.pk`

async function mkUser(key: string, role: string, tenants: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active', ...extra,
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
  return U[key]!
}
function auth(key: string) {
  const u = U[key]!
  const s = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}` }
}
const invite = (key: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/staff/invite', headers: auth(key), payload })
const offboard = (key: string, id: string, reason = 'Left the company') =>
  app.inject({ method: 'POST', url: `/api/v1/auth/staff/${id}/offboard`, headers: auth(key), payload: { reason } })
const reinstate = (key: string, id: string) =>
  app.inject({ method: 'POST', url: `/api/v1/auth/staff/${id}/reinstate`, headers: auth(key), payload: {} })
const getMods = (key: string, id: string) =>
  app.inject({ method: 'GET', url: `/api/v1/permissions/users/${id}/modules`, headers: auth(key) })
const putMods = (key: string, id: string, modules: string[] | null) =>
  app.inject({ method: 'PUT', url: `/api/v1/permissions/users/${id}/modules`, headers: auth(key), payload: { modules } })
const row = (id: string) => prisma.user.findUniqueOrThrow({ where: { id }, select: { accountStatus: true, isActive: true, moduleAllow: true, moduleDeny: true, inviteEmployeeId: true, tenantId: true } })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Onboarding Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Onboarding Co B', slug: `${P}-b` } })).id
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('ceoA2', 'admin', [T.A])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('hrA', 'hr', [T.A])
  await mkUser('hrB', 'hr', [T.B])
  await mkUser('ownerA', 'owner', [T.A])
  await mkUser('mgmtA', 'management', [T.A])
  await mkUser('hrNoModule', 'hr', [T.A], { moduleDeny: ['staff_hr'] })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(authRoutes, { prefix: '/auth' })
    await api.register(permissionRoutes, { prefix: '/permissions' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
})

describe('HR onboards', () => {
  it('HR may add every assignable role except the CEO and co-owner seats', () => {
    expect([...CHILD_ROLES.hr].sort()).toEqual(ASSIGNABLE_ROLES.filter((r) => r !== 'owner').sort())
    expect(CHILD_ROLES.hr).not.toContain('admin')
    expect(CHILD_ROLES.hr).not.toContain('owner')
  })

  it('a cashier HR adds is active at once and linked to the employee (no CEO step)', async () => {
    const emp = await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'New Cashier' } })
    const r = await invite('hrA', { name: 'New Cashier', email: email('cashier'), phone: phone(), role: 'cashier', employeeId: emp.id })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ status: 'active', tenantId: T.A, linkedEmployeeId: emp.id })
    const id = r.json().id as string
    U['cashier'] = { id, name: 'New Cashier', email: r.json().email, role: 'cashier' }
    expect(await row(id)).toMatchObject({ accountStatus: 'active', isActive: true, inviteEmployeeId: null, tenantId: T.A })
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emp.id } })).userId).toBe(id)
    const a = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'staff.invite' } })
    expect(a?.metadata).toMatchObject({ activeAtOnce: true })
  })

  it('a finance login HR adds waits for the CEO and shows in the approvals inbox as staff_login', async () => {
    const r = await invite('hrA', { name: 'New Finance', email: email('finance'), role: 'finance' })
    expect(r.statusCode).toBe(201)
    expect(r.json().status).toBe('pending')
    const id = r.json().id as string
    U['finance'] = { id, name: 'New Finance', email: r.json().email, role: 'finance' }

    const inboxA = await app.inject({ method: 'GET', url: '/api/v1/approvals', headers: auth('ceoA') })
    expect(inboxA.statusCode).toBe(200)
    expect(inboxA.json().items).toContainEqual(expect.objectContaining({ type: 'staff_login', id }))
    const inboxB = await app.inject({ method: 'GET', url: '/api/v1/approvals', headers: auth('ceoB') })
    expect(inboxB.json().items.map((i: { id: string }) => i.id)).not.toContain(id)
  })

  it('HR cannot add the CEO or co-owner seat', async () => {
    for (const role of ['admin', 'owner']) {
      const r = await invite('hrA', { name: 'Nope', email: email(role), role })
      expect(r.statusCode, role).toBe(403)
    }
  })

  it('an invite never carries module access', async () => {
    const r = await invite('hrA', { name: 'Sneaky', email: email('sneaky'), role: 'marketing', moduleAllow: ['accounting'], moduleDeny: ['crm'] })
    expect(r.statusCode).toBe(201)
    expect(await row(r.json().id)).toMatchObject({ moduleAllow: [], moduleDeny: [] })
  })

  it('an HR login without the staff_hr module cannot onboard', async () => {
    const r = await invite('hrNoModule', { name: 'Nope', email: email('nomod'), phone: phone(), role: 'cashier' })
    expect(r.statusCode).toBe(403)
  })

  it("a manager's floor invite still waits for the CEO; the CEO's is active at once", async () => {
    const m = await invite('mgmtA', { name: 'Mgr Cook', email: email('mgrcook'), phone: phone(), role: 'boh' })
    expect(m.statusCode).toBe(201)
    expect(m.json().status).toBe('pending')
    const c = await invite('ceoA', { name: 'Ceo Cook', email: email('ceocook'), phone: phone(), role: 'kitchen' })
    expect(c.statusCode).toBe(201)
    expect(c.json().status).toBe('active')
  })
})

describe('offboarding', () => {
  it("company B's HR gets 404 on company A's login", async () => {
    expect((await offboard('hrB', U['cashier']!.id)).statusCode).toBe(404)
    expect((await reinstate('hrB', U['cashier']!.id)).statusCode).toBe(404)
  })

  it('HR cannot offboard the CEO or themselves; the CEO cannot offboard themselves', async () => {
    const a = await offboard('hrA', U['ceoA']!.id)
    expect(a.statusCode).toBe(403)
    expect(a.json().error.code).toBe('CANNOT_OFFBOARD_CEO')
    const s = await offboard('hrA', U['hrA']!.id)
    expect(s.statusCode).toBe(403)
    expect(s.json().error.code).toBe('CANNOT_OFFBOARD_SELF')
    const c = await offboard('ceoA', U['ceoA']!.id)
    expect(c.statusCode).toBe(403)
    expect(c.json().error.code).toBe('CANNOT_OFFBOARD_SELF')
    // …nor through the staff editor.
    const p = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${U['ceoA']!.id}`, headers: auth('ceoA'), payload: { isActive: false } })
    expect(p.statusCode).toBe(403)
    expect((await row(U['ceoA']!.id)).accountStatus).toBe('active')
  })

  it('nobody offboards a co-owner — not HR, not the CEO, not through the staff editor', async () => {
    for (const who of ['hrA', 'ceoA']) {
      const r = await offboard(who, U['ownerA']!.id)
      expect(r.statusCode).toBe(403)
      expect(r.json().error.code).toBe('CANNOT_OFFBOARD_OWNER')
    }
    const p = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${U['ownerA']!.id}`, headers: auth('ceoA'), payload: { isActive: false } })
    expect(p.statusCode).toBe(403)
    expect((await row(U['ownerA']!.id)).accountStatus).toBe('active')
  })

  it('other roles cannot offboard; a reason is required', async () => {
    expect((await offboard('mgmtA', U['cashier']!.id)).statusCode).toBe(403)
    expect((await offboard('ownerA', U['cashier']!.id)).statusCode).toBe(403)
    expect((await offboard('hrA', U['cashier']!.id, 'x')).statusCode).toBe(400)
  })

  it('HR offboards a cashier: suspended, every session revoked, audited; reinstated active at once', async () => {
    const id = U['cashier']!.id
    vi.mocked(revokeAllForSubject).mockClear()
    const r = await offboard('hrA', id, 'Resigned, last day today')
    expect(r.statusCode).toBe(200)
    expect(await row(id)).toMatchObject({ accountStatus: 'suspended', isActive: false })
    expect(vi.mocked(revokeAllForSubject)).toHaveBeenCalledWith(id)
    const a = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'staff.offboard' } })
    expect(a).toMatchObject({ category: 'identity', tenantId: T.A, userId: U['hrA']!.id })
    expect(a?.after).toMatchObject({ reason: 'Resigned, last day today' })
    // The old token no longer works.
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/staff/invites', headers: auth('cashier') })
    expect(me.statusCode).toBe(401)

    const back = await reinstate('hrA', id)
    expect(back.statusCode).toBe(200)
    expect(back.json()).toMatchObject({ status: 'active', waitsForCeo: false })
    expect((await row(id)).accountStatus).toBe('active')
    expect((await reinstate('hrA', id)).statusCode).toBe(409)
  })

  it("HR's reinstate of an office login waits for the CEO; the CEO's is immediate", async () => {
    const fin = await mkUser('fin2', 'finance', [T.A])
    expect((await offboard('hrA', fin.id)).statusCode).toBe(200)
    const r = await reinstate('hrA', fin.id)
    expect(r.json()).toMatchObject({ status: 'pending', waitsForCeo: true })
    expect((await row(fin.id)).accountStatus).toBe('pending')

    expect((await offboard('ceoA', fin.id)).statusCode).toBe(200)
    const c = await reinstate('ceoA', fin.id)
    expect(c.json()).toMatchObject({ status: 'active', waitsForCeo: false })
  })

  it("HR cannot reinstate a CEO login", async () => {
    expect((await reinstate('hrA', U['ceoA2']!.id)).statusCode).toBe(403)
  })
})

describe('per-person module access', () => {
  it('the CEO ticks modules for a person; effective access follows; null resets', async () => {
    const id = U['cashier']!.id
    const g = await getMods('ceoA', id)
    expect(g.statusCode).toBe(200)
    const preset = await rolePresetModules('cashier')
    expect(g.json().rolePreset.sort()).toEqual([...preset].sort())
    expect(g.json().modules.length).toBeGreaterThan(10)
    expect(g.json().locked).toBe(false)

    const dropped = preset[0]!
    const chosen = [...preset.filter((m) => m !== dropped), 'reports', 'brands']
    const p = await putMods('ceoA', id, chosen)
    expect(p.statusCode).toBe(200)
    const db = await row(id)
    expect(db.moduleAllow).toEqual(['reports'])            // outside the preset → granted; Brands never
    expect(db.moduleDeny).toEqual([dropped])
    const eff = await effectiveModulesForUser({ role: 'cashier', moduleAllow: db.moduleAllow, moduleDeny: db.moduleDeny })
    expect(eff.has('reports')).toBe(true)
    expect(eff.has(dropped)).toBe(false)
    expect(eff.has('brands')).toBe(false)
    expect(p.json().allow).toEqual(['reports'])
    const a = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'staff.modules' }, orderBy: { createdAt: 'desc' } })
    expect(a).toMatchObject({ category: 'identity', tenantId: T.A })

    const reset = await putMods('ceoA', id, null)
    expect(reset.statusCode).toBe(200)
    expect(await row(id)).toMatchObject({ moduleAllow: [], moduleDeny: [] })
    expect((await putMods('ceoA', id, ['no_such_module'])).statusCode).toBe(400)
  })

  it('only the CEO: HR, the co-owner and management get 403; company B gets 404; admin rows are refused', async () => {
    const id = U['cashier']!.id
    for (const k of ['hrA', 'ownerA', 'mgmtA']) {
      expect((await getMods(k, id)).statusCode, k).toBe(403)
      expect((await putMods(k, id, [])).statusCode, k).toBe(403)
    }
    expect((await getMods('ceoB', id)).statusCode).toBe(404)
    expect((await putMods('ceoB', id, [])).statusCode).toBe(404)
    expect((await putMods('ceoA', U['ceoA']!.id, [])).statusCode).toBe(403)
    expect((await putMods('ceoA', U['ceoA2']!.id, [])).statusCode).toBe(403)
    expect((await getMods('ceoA', U['ceoA']!.id)).json().locked).toBe(true)
  })

  it('every other module-access writer is CEO only', async () => {
    const id = U['cashier']!.id
    for (const k of ['hrA', 'ownerA', 'mgmtA']) {
      const role = await app.inject({ method: 'PUT', url: '/api/v1/permissions/role-modules', headers: auth(k), payload: { role: 'cashier', modules: ['pos'] } })
      expect(role.statusCode, k).toBe(403)
      const patch = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${id}`, headers: auth(k), payload: { moduleAllow: ['accounting'] } })
      expect(patch.statusCode, k).toBe(403)
    }
    expect(await row(id)).toMatchObject({ moduleAllow: [], moduleDeny: [] })
  })
})
