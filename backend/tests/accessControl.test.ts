// Access control & staff accounts — the 2026-09-27 duplicate reconcile.
//
// What these defend, one source of truth each:
//   - ONE role list (lib/roles.ts, derived from the Prisma enum): Workforce's
//     roles are all assignable, legacy 'manager' is not, and every role can
//     still sign in (no lockout from the derivation).
//   - Module access is THE control: the per-action matrix API is gone, /me
//     returns the caller's effective modules, owner is editable, and the new
//     HR gating hits the HR back office but never self-service.
//   - ONE manager-PIN verifier (company-scoped, active approvers per owner
//     decision 7) and ONE setter (format, weak list, per-company collision).
//   - ONE account-status column (accountStatus; isActive mirrored).
//   - Pending signups: no public self-signup; approve/reject are audited.
//   - Customer codes: the old request-otp/verify-otp pair is gone; a
//     per-contact daily cap sits under every sender.
//   - Clock logs are scoped by company, not the unused brand whitelist.
//
// Drives the real route handlers through Fastify inject. Needs the disposable
// test database (DATABASE_URL must contain "test") and Redis.
import { timeClockRoutes } from '../src/modules/timeclock/routes.js'
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
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { permissionRoutes } = await import('../src/modules/permissions/routes.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const roles = await import('../src/lib/roles.js')
const { ALL_STAFF, MANAGERS } = await import('../src/modules/auth/middleware.js')
const { DEFAULT_MODULE_ACCESS, enforceModuleAccess, MODULE_IDS, RETIRED_MODULE_IDS } = await import('../src/lib/moduleAccess.js')
const { verifyManagerPin, setManagerPin, isWeakPin } = await import('../src/modules/auth/managerPin.js')
const { accountStateOf, isAccountActive } = await import('../src/modules/auth/accountStatus.js')
const { requestSharedCode, normalisePhone } = await import('../src/modules/auth/otp.js')

let app: FastifyInstance
let tenantA: string
let tenantB: string
let ceoToken: string
const created: string[] = []
const PREFIX = 'acl-test'

async function makeUser(opts: {
  role: string; tenantId: string | null; pin?: string; email?: string; phone?: string
  isActive?: boolean; accountStatus?: 'pending' | 'active' | 'suspended'
}) {
  const n = created.length + 1
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${opts.role} ${n}`,
      email: opts.email ?? `${PREFIX}.${opts.role}.${n}.${Date.now()}@gsfoods.pk`,
      password: await bcrypt.hash('NotUsedInThisTest123', 4),
      role: opts.role as never,
      tenantId: opts.tenantId,
      ...(opts.phone ? { phone: opts.phone } : {}),
      isActive: opts.isActive ?? true,
      accountStatus: opts.accountStatus ?? 'active',
      pin: opts.pin ? await bcrypt.hash(opts.pin, 4) : null,
      ...(opts.tenantId ? { tenantMemberships: { create: [{ tenant: { connect: { id: opts.tenantId } }, role: 'member' }] } } : {}),
    },
    select: { id: true, name: true, email: true, role: true },
  })
  created.push(u.id)
  return u
}

function bearer(u: { id: string; name: string | null; email: string | null; role: string }) {
  const s = issueStaffSession({ id: u.id, name: u.name ?? '', email: u.email, role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}` }
}

beforeAll(async () => {
  const a = await prisma.tenant.create({ data: { name: 'ACL Co A', slug: `${PREFIX}-a-${Date.now()}` }, select: { id: true } })
  const b = await prisma.tenant.create({ data: { name: 'ACL Co B', slug: `${PREFIX}-b-${Date.now()}` }, select: { id: true } })
  tenantA = a.id
  tenantB = b.id
  const ceo = await makeUser({ role: 'admin', tenantId: tenantA })
  ceoToken = bearer(ceo).authorization

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.register(permissionRoutes, { prefix: '/api/v1/permissions' })
  await app.register(timeClockRoutes, { prefix: '/api/v1/time-clock' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await prisma.clockLog.deleteMany({ where: { userId: { in: created } } })
  await prisma.auditLog.deleteMany({ where: { entityId: { in: created } } })
  await prisma.roleModuleAccess.deleteMany({ where: { role: 'owner' } })
  await prisma.tenantMember.deleteMany({ where: { userId: { in: created } } })
  await prisma.user.deleteMany({ where: { id: { in: created } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: `${PREFIX}.` } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

// ── D2 / D3 (2026-10-11): the CEO section moved modules, it changed no one ──

describe('module defaults after the CEO section (D2) and the approvals inbox (D3)', () => {
  // Moving module ids between workspaces is a regrouping, not an access
  // change: every role the move does not involve keeps exactly its defaults.
  const UNCHANGED: Record<string, string[]> = {
    fnb_manager: ['fnb_dashboard', 'dashboard', 'ops', 'orders', 'refunds', 'curbside', 'kds_all', 'kds_dashboard', 'expo_station', 'menu', 'components', 'recipes', 'par_sheet', 'inventory', 'kds_config', 'food_safety', 'pos', 'reservations', 'reservations_admin', 'scheduling', 'tables', 'dispatch', 'riders', 'complaints', 'reviews', 'staff_directory', 'finance_pl', 'accounting', 'reports'],
    foh_management: ['dashboard', 'ops', 'orders', 'refunds', 'curbside', 'kds_all', 'expo_station', 'pos', 'reservations', 'reservations_admin', 'scheduling', 'tables', 'dispatch', 'riders', 'crm', 'complaints', 'reviews', 'campaigns', 'staff_directory', 'reports', 'integrations'],
    boh_management: ['dashboard', 'ops', 'orders', 'kds_all', 'kds_dashboard', 'expo_station', 'menu', 'components', 'recipes', 'par_sheet', 'inventory', 'kds_config', 'food_safety', 'procurement', 'staff_directory', 'scheduling', 'reports'],
    foh: ['pos', 'reservations', 'tables', 'dispatch', 'orders', 'curbside'],
    boh: ['kds_all', 'kds_dashboard', 'inventory', 'recipes', 'par_sheet', 'food_safety'],
    kitchen: ['kds_dashboard', 'par_sheet', 'food_safety'],
    expediter: ['kds_all', 'expo_station', 'orders', 'par_sheet', 'food_safety'],
    cashier: ['dashboard', 'pos', 'orders', 'curbside', 'tables'],
    procurement: ['procurement', 'inventory', 'reports'],
    marketing: ['marketing_workspace', 'crm', 'campaigns', 'complaints', 'reviews', 'calendar', 'media', 'promos', 'brands', 'analytics', 'storefront'],
    brand_manager: ['brand_dashboard', 'marketing_workspace', 'crm', 'campaigns', 'complaints', 'reviews', 'calendar', 'media', 'promos', 'brands', 'analytics', 'storefront'],
    finance: ['dashboard', 'orders', 'finance_pl', 'payroll', 'accounting', 'gift_cards', 'reconciliation', 'exceptions', 'capital', 'projections', 'reports', 'voided_prebills'],
    hr: ['staff_directory', 'staff_hr', 'payroll', 'scheduling'],
    it: ['api_whatsapp', 'api_pos', 'integrations', 'audit_log', 'notifications', 'help'],
  }

  it('roles the move does not involve keep exactly their defaults', () => {
    for (const [role, mods] of Object.entries(UNCHANGED)) {
      expect(DEFAULT_MODULE_ACCESS[role as keyof typeof DEFAULT_MODULE_ACCESS], role).toEqual(mods)
    }
  })

  it('the governance roles gain only the approvals entry; governance stays withheld from owner', () => {
    const all = [...MODULE_IDS] as string[]
    expect(DEFAULT_MODULE_ACCESS.admin).toEqual(all)
    for (const r of ['owner', 'management', 'manager'] as const) expect(DEFAULT_MODULE_ACCESS[r], r).toContain('approvals')
    for (const m of ['role_management', 'role_modules', 'accounting_audit']) expect(DEFAULT_MODULE_ACCESS.owner).not.toContain(m)
  })

  it('the inbox is not module-gated — it grants nothing, each module\'s own routes do', async () => {
    for (const role of ['cashier', 'boh_management', 'hr', 'finance']) {
      await expect(enforceModuleAccess('/api/v1/approvals', { role: role as never })).resolves.toBeUndefined()
      await expect(enforceModuleAccess('/api/v1/approvals/counts', { role: role as never })).resolves.toBeUndefined()
    }
  })
})

// ── One role list ────────────────────────────────────────────────────────────

describe('role list (lib/roles.ts)', () => {
  it('every enum role can still sign in — ALL_STAFF is the enum', () => {
    expect([...ALL_STAFF].sort()).toEqual([...roles.ALL_ROLES].sort())
    for (const r of ['admin', 'owner', 'manager', 'fnb_manager', 'brand_manager', 'hr', 'cashier']) {
      expect(ALL_STAFF).toContain(r)
    }
  })

  it('assignable = enum minus the CEO seat and legacy manager', () => {
    expect(roles.ASSIGNABLE_ROLES).not.toContain('admin')
    expect(roles.ASSIGNABLE_ROLES).not.toContain('manager')
    for (const r of ['owner', 'fnb_manager', 'brand_manager', 'management', 'foh_management', 'boh_management']) {
      expect(roles.ASSIGNABLE_ROLES).toContain(r)
    }
    expect(roles.ASSIGNABLE_ROLES_WITH_ADMIN).toContain('admin')
  })

  it('PIN approvers are exactly owner decision 7', () => {
    expect([...roles.OVERRIDE_APPROVERS].sort()).toEqual(
      ['admin', 'owner', 'management', 'fnb_manager', 'foh_management', 'boh_management'].sort(),
    )
    expect(roles.isOverrideApprover('manager')).toBe(false)
    expect(roles.isOverrideApprover('cashier')).toBe(false)
  })

  it('the management tier matches the middleware MANAGERS set', () => {
    expect([...roles.MANAGEMENT_TIER].sort()).toEqual([...MANAGERS].sort())
  })
})

// ── Module access is the control ─────────────────────────────────────────────

describe('module access', () => {
  it('has a default module set for every role, with no retired ids', () => {
    for (const r of roles.ALL_ROLES) {
      expect(DEFAULT_MODULE_ACCESS[r]).toBeDefined()
      for (const m of DEFAULT_MODULE_ACCESS[r]) expect(MODULE_IDS as readonly string[]).toContain(m)
    }
    for (const m of RETIRED_MODULE_IDS) expect(MODULE_IDS as readonly string[]).not.toContain(m)
  })

  it('HR gating: every HR_ADMIN role keeps staff_hr by default (no lockout)', () => {
    for (const r of ['owner', 'management', 'hr'] as const) {
      expect(DEFAULT_MODULE_ACCESS[r]).toContain('staff_hr')
    }
  })

  it('HR gating hits the back office but never self-service or HOD approvals', async () => {
    const cashier = { role: 'cashier' as const, moduleAllow: [], moduleDeny: [] }
    for (const p of ['/api/v1/hr/me', '/api/v1/hr/me/payslips/x', '/api/v1/hr/approvals', '/api/v1/hr/lookups',
      '/api/v1/hr/org', '/api/v1/hr/team', '/api/v1/hr/records/leave/abc/submit', '/api/v1/hr/records/leave/abc/decide']) {
      await expect(enforceModuleAccess(p, cashier)).resolves.toBeUndefined()
    }
    await expect(enforceModuleAccess('/api/v1/hr/employees', { role: 'foh_management' })).rejects.toThrow(/module/)
    await expect(enforceModuleAccess('/api/v1/hr/payroll/runs', { role: 'hr' })).resolves.toBeUndefined()
    await expect(enforceModuleAccess('/api/v1/hr/employees', { role: 'hr', moduleDeny: ['staff_hr'] })).rejects.toThrow()
  })

  it('the per-action matrix API is gone', async () => {
    for (const [method, url] of [['GET', '/matrix'], ['PATCH', '/matrix'], ['GET', '/catalogue'], ['POST', '/reset']] as const) {
      const r = await app.inject({ method, url: `/api/v1/permissions${url}`, headers: { authorization: ceoToken }, payload: {} })
      expect(r.statusCode).toBe(404)
    }
  })

  it('GET /permissions/me returns the caller\'s effective modules, including per-user overrides', async () => {
    const hr = await makeUser({ role: 'hr', tenantId: tenantA })
    await prisma.user.update({ where: { id: hr.id }, data: { moduleAllow: ['reports'], moduleDeny: ['scheduling'] } })
    const r = await app.inject({ method: 'GET', url: '/api/v1/permissions/me', headers: bearer(hr) })
    expect(r.statusCode).toBe(200)
    const body = r.json() as { role: string; modules: string[] }
    expect(body.role).toBe('hr')
    expect(body.modules).toContain('staff_hr')
    expect(body.modules).toContain('reports')
    expect(body.modules).not.toContain('scheduling')
  })

  it('GET /permissions/role-modules serves defaults, module ids and the role lists', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/permissions/role-modules', headers: { authorization: ceoToken } })
    const body = r.json() as { defaults: Record<string, string[]>; modules: string[]; roles: { assignable: string[]; editable: string[] } }
    expect(body.defaults['fnb_manager']).toEqual(DEFAULT_MODULE_ACCESS.fnb_manager)
    expect(body.modules).toEqual([...MODULE_IDS])
    expect(body.roles.assignable).toEqual([...roles.ASSIGNABLE_ROLES])
    expect(body.roles.editable).toContain('owner')
    expect(body.roles.editable).not.toContain('admin')
  })

  it('PUT /permissions/role-modules saves owner, strips retired ids, refuses typos and admin', async () => {
    const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/v1/permissions/role-modules', headers: { authorization: ceoToken }, payload })
    const ok = await put({ role: 'owner', modules: ['dashboard', 'staff_foh', 'reports'] })
    expect(ok.statusCode).toBe(200)
    const row = await prisma.roleModuleAccess.findUnique({ where: { role: 'owner' } })
    expect(row?.modules.sort()).toEqual(['dashboard', 'reports'])
    expect((await put({ role: 'owner', modules: ['dashbord'] })).statusCode).toBe(400)
    expect((await put({ role: 'admin', modules: ['dashboard'] })).statusCode).toBe(400)
    expect((await put({ role: 'owner', modules: null })).statusCode).toBe(200)
    expect(await prisma.roleModuleAccess.findUnique({ where: { role: 'owner' } })).toBeNull()
  })
})

// ── Staff editor role validation ─────────────────────────────────────────────

describe('staff editor accepts the roles Workforce offers', () => {
  it('creates fnb_manager, brand_manager and owner accounts (were 400) and refuses legacy manager', async () => {
    for (const role of ['fnb_manager', 'brand_manager', 'owner']) {
      const r = await app.inject({
        method: 'POST', url: '/api/v1/auth/users', headers: { authorization: ceoToken },
        payload: { email: `${PREFIX}.create.${role}.${Date.now()}@gsfoods.pk`, role, tenantId: tenantA },
      })
      expect(r.statusCode, role).toBe(201)
      const body = r.json() as { id: string; hasPin: boolean }
      created.push(body.id)
      // No phantom PIN any more — nothing is generated that nobody ever sees.
      expect(body.hasPin).toBe(false)
    }
    const legacy = await app.inject({
      method: 'POST', url: '/api/v1/auth/users', headers: { authorization: ceoToken },
      payload: { email: `${PREFIX}.create.manager.${Date.now()}@gsfoods.pk`, role: 'manager', tenantId: tenantA },
    })
    expect(legacy.statusCode).toBe(400)
  })
})

// ── Manager PIN: one verifier, one setter ────────────────────────────────────

describe('manager override PIN', () => {
  it('rejects guessable PINs', () => {
    for (const p of ['1111', '1234', '4321', '1998', '000000']) expect(isWeakPin(p)).toBe(true)
    expect(isWeakPin('7351')).toBe(false)
  })

  it('verifies only active approvers of the company the action happens in', async () => {
    const floorMgr = await makeUser({ role: 'foh_management', tenantId: tenantA, pin: '7351' })
    await makeUser({ role: 'cashier', tenantId: tenantA, pin: '8462' })
    await makeUser({ role: 'manager', tenantId: tenantA, pin: '9573' })            // legacy
    await makeUser({ role: 'management', tenantId: tenantA, pin: '6284', accountStatus: 'suspended', isActive: false })
    await makeUser({ role: 'management', tenantId: tenantB, pin: '5195' })

    expect((await verifyManagerPin('7351', tenantA))?.id).toBe(floorMgr.id)
    expect(await verifyManagerPin('8462', tenantA)).toBeNull()      // cashier is not an approver
    expect(await verifyManagerPin('9573', tenantA)).toBeNull()      // legacy role: migrate first
    expect(await verifyManagerPin('6284', tenantA)).toBeNull()      // suspended
    expect(await verifyManagerPin('5195', tenantA)).toBeNull()      // other company's manager
    expect(await verifyManagerPin('5195', tenantB)).not.toBeNull()
    expect(await verifyManagerPin('7351', null)).toBeNull()         // no company → nobody
  })

  it('refuses a PIN already held in the same company, allows it in another', async () => {
    const a1 = await makeUser({ role: 'boh_management', tenantId: tenantA })
    const a2 = await makeUser({ role: 'fnb_manager', tenantId: tenantA })
    const b1 = await makeUser({ role: 'fnb_manager', tenantId: tenantB })
    await setManagerPin(a1.id, '2468')
    await expect(setManagerPin(a2.id, '2468')).rejects.toMatchObject({ code: 'PIN_COLLISION' })
    await expect(setManagerPin(b1.id, '2468')).resolves.toBeUndefined()
    await expect(setManagerPin(a1.id, '2468')).resolves.toBeUndefined()   // own PIN is not a collision
    await expect(setManagerPin(a2.id, '12')).rejects.toMatchObject({ code: 'INVALID_PIN' })
  })

  it('PATCH /auth/users goes through the same setter', async () => {
    const a = await makeUser({ role: 'management', tenantId: tenantA })
    const b = await makeUser({ role: 'management', tenantId: tenantA })
    const patch = (id: string, pin: string) => app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${id}`, headers: { authorization: ceoToken }, payload: { pin } })
    expect((await patch(a.id, '8024')).statusCode).toBe(200)
    expect((await patch(b.id, '8024')).statusCode).toBe(409)
    expect((await patch(b.id, '1234')).statusCode).toBe(400)
  })

  it('issue-pin (no caller) is gone', async () => {
    const u = await makeUser({ role: 'management', tenantId: tenantA })
    const r = await app.inject({ method: 'POST', url: `/api/v1/auth/staff/${u.id}/issue-pin`, headers: { authorization: ceoToken }, payload: {} })
    expect(r.statusCode).toBe(404)
  })
})

// ── Account status: one column ───────────────────────────────────────────────

describe('account status', () => {
  it('derives suspended from either column until the backfill runs', () => {
    expect(accountStateOf({ isActive: false, accountStatus: 'active' })).toBe('suspended')
    expect(accountStateOf({ isActive: true, accountStatus: 'suspended' })).toBe('suspended')
    expect(accountStateOf({ isActive: true, accountStatus: 'pending' })).toBe('pending')
    expect(isAccountActive({ isActive: true, accountStatus: 'active', deletedAt: null })).toBe(true)
    expect(isAccountActive({ isActive: true, accountStatus: 'active', deletedAt: new Date() })).toBe(false)
  })

  it('deactivating from Workforce writes accountStatus, and the suspended filter finds it', async () => {
    const u = await makeUser({ role: 'cashier', tenantId: tenantA })
    const legacy = await makeUser({ role: 'cashier', tenantId: tenantA, isActive: false, accountStatus: 'active' })
    const r = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${u.id}`, headers: { authorization: ceoToken }, payload: { isActive: false } })
    expect(r.statusCode).toBe(200)
    expect((r.json() as { accountStatus: string }).accountStatus).toBe('suspended')
    const row = await prisma.user.findUnique({ where: { id: u.id }, select: { isActive: true, accountStatus: true } })
    expect(row).toEqual({ isActive: false, accountStatus: 'suspended' })

    const list = await app.inject({ method: 'GET', url: '/api/v1/auth/users?status=suspended', headers: { authorization: ceoToken } })
    const ids = (list.json() as Array<{ id: string; accountStatus: string }>).map((x) => x.id)
    expect(ids).toContain(u.id)
    expect(ids).toContain(legacy.id)   // switched off through isActive alone

    const back = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${u.id}`, headers: { authorization: ceoToken }, payload: { isActive: true } })
    expect((back.json() as { accountStatus: string }).accountStatus).toBe('active')
  })

  it('reactivating a pending hire does not skip the approve step', async () => {
    const p = await makeUser({ role: 'cashier', tenantId: tenantA, accountStatus: 'pending' })
    const r = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${p.id}`, headers: { authorization: ceoToken }, payload: { isActive: true } })
    expect((r.json() as { accountStatus: string }).accountStatus).toBe('pending')
  })
})

// ── Pending signups ──────────────────────────────────────────────────────────

describe('pending signups', () => {
  it('public self-signup is gone', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/v1/auth/staff/signup',
      payload: { name: 'X', email: `${PREFIX}.signup@gsfoods.pk`, phone: '03001112222', role: 'manager' },
    })
    expect(r.statusCode).toBe(404)
  })

  it('approve and reject are audited', async () => {
    const p1 = await makeUser({ role: 'cashier', tenantId: tenantA, accountStatus: 'pending', phone: '923001234567' })
    const p2 = await makeUser({ role: 'cashier', tenantId: tenantA, accountStatus: 'pending' })
    const pending = await app.inject({ method: 'GET', url: '/api/v1/auth/staff/pending', headers: { authorization: ceoToken } })
    expect((pending.json() as Array<{ id: string }>).map((x) => x.id)).toEqual(expect.arrayContaining([p1.id, p2.id]))

    expect((await app.inject({ method: 'PATCH', url: `/api/v1/auth/staff/${p1.id}/approve`, headers: { authorization: ceoToken }, payload: {} })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/auth/staff/${p2.id}/reject`, headers: { authorization: ceoToken }, payload: {} })).statusCode).toBe(200)
    const logs = await prisma.auditLog.findMany({ where: { entityId: { in: [p1.id, p2.id] } }, select: { action: true, entityId: true } })
    expect(logs).toEqual(expect.arrayContaining([
      { action: 'user.approve', entityId: p1.id },
      { action: 'user.reject', entityId: p2.id },
    ]))
    const rejected = await prisma.user.findUnique({ where: { id: p2.id }, select: { isActive: true, accountStatus: true } })
    expect(rejected).toEqual({ isActive: false, accountStatus: 'suspended' })
  })
})

// ── Customer signup codes ────────────────────────────────────────────────────

describe('customer signup codes', () => {
  it('the old single-channel request-otp / verify-otp pair is gone', async () => {
    for (const url of ['/customer/request-otp', '/customer/verify-otp']) {
      const r = await app.inject({ method: 'POST', url: `/api/v1/auth${url}`, payload: { phone: '03001234567', code: '123456' } })
      expect(r.statusCode).toBe(404)
    }
  })

  it('caps codes per contact per day, whatever IP asks', async () => {
    const phone = normalisePhone('03117770001')
    const email = `${PREFIX}.cap@example.com`
    // Ten earlier codes today (older than the 30s resend cooldown).
    const at = new Date(Date.now() - 60 * 60_000)
    await prisma.phoneOtp.createMany({
      data: Array.from({ length: 10 }, () => ({ phone, code: '000000', purpose: 'signup', expiresAt: at, createdAt: at })),
    })
    await expect(requestSharedCode({ phone, email, purpose: 'signup' })).rejects.toMatchObject({ code: 'OTP_DAILY_LIMIT' })
    // A fresh email must not reopen a capped phone.
    await expect(requestSharedCode({ phone, email: `${PREFIX}.cap2@example.com`, purpose: 'signup' })).rejects.toMatchObject({ code: 'OTP_DAILY_LIMIT' })
    await prisma.phoneOtp.deleteMany({ where: { phone } })
    await prisma.emailOtp.deleteMany({ where: { email: { startsWith: `${PREFIX}.cap` } } })
  })
})

// ── Clock logs: company scope ────────────────────────────────────────────────

describe('clock logs', () => {
  it('a manager sees their company\'s punches — and not another company\'s', async () => {
    const mgr = await makeUser({ role: 'foh_management', tenantId: tenantA })
    const mine = await makeUser({ role: 'cashier', tenantId: tenantA })
    const theirs = await makeUser({ role: 'cashier', tenantId: tenantB })
    await prisma.clockLog.createMany({ data: [{ userId: mine.id, type: 'in' }, { userId: theirs.id, type: 'in' }] })

    const r = await app.inject({ method: 'GET', url: '/api/v1/time-clock/logs', headers: bearer(mgr) })
    expect(r.statusCode).toBe(200)
    const ids = ((r.json() as { rows: Array<{ userId: string | null }> }).rows).map((l) => l.userId)
    expect(ids).toContain(mine.id)          // was always empty: read a whitelist nobody writes
    expect(ids).not.toContain(theirs.id)

    // The report is company-scoped and takes no per-user filter: there is no
    // id a manager can pass to reach another company's punches.
    const probe = await app.inject({ method: 'GET', url: `/api/v1/time-clock/logs?userId=${theirs.id}`, headers: bearer(mgr) })
    expect(((probe.json() as { rows: Array<{ userId: string | null }> }).rows).map((l) => l.userId)).not.toContain(theirs.id)
  })
})
