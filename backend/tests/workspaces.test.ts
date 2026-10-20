// Workspaces, team invites and the user audit log (owner decision 47).
//
//   - Every module id lives in exactly one workspace (lib/workspaces.ts).
//   - Invites: a workspace owner adds logins only for roles under them, the
//     account is pending in the ACTIVE company, another company's CEO cannot
//     see it, and the CEO's approve activates it (and links the employee).
//   - Sign-in trail: failed and good logins are written to the identity log.
//   - /hr/team returns the whole tree, indirect reports included.
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

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { permissionRoutes } = await import('../src/modules/permissions/routes.js')
const { hrRoutes } = await import('../src/modules/hr/routes.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { MODULE_IDS, DEFAULT_MODULE_ACCESS, MODULE_GRANTS, rolesGrantedByDefault } = await import('../src/lib/moduleAccess.js')
const { WORKSPACES, UNASSIGNED_MODULE_IDS, CHILD_ROLES } = await import('../src/lib/workspaces.js')
const { ALL_ROLES } = await import('../src/lib/roles.js')
const { APPROVAL_SECTIONS, APPROVAL_RIGHTS, APPROVAL_TYPES } = await import('../src/lib/approvalRights.js')

const PREFIX = 'ws-test'
const PASSWORD = 'CorrectHorse-Battery-9'
let app: FastifyInstance
let tenantA: string
let tenantB: string
const created: string[] = []

async function makeUser(role: string, tenantId: string | null, extraTenant?: string) {
  const n = created.length + 1
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${role} ${n}`,
      email: `${PREFIX}.${role}.${n}.${Date.now()}@gsfoods.pk`,
      password: await bcrypt.hash(PASSWORD, 4),
      role: role as never,
      tenantId,
      ...(tenantId ? { tenantMemberships: { create: [tenantId, ...(extraTenant ? [extraTenant] : [])].map((id) => ({ tenant: { connect: { id } }, role: 'member' })) } } : {}),
    },
    select: { id: true, name: true, email: true, role: true },
  })
  created.push(u.id)
  return u
}
function auth(u: { id: string; name: string | null; email: string | null; role: string }) {
  const s = issueStaffSession({ id: u.id, name: u.name ?? '', email: u.email, role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}` }
}

beforeAll(async () => {
  const a = await prisma.tenant.create({ data: { name: 'WS Co A', slug: `${PREFIX}-a-${Date.now()}` }, select: { id: true } })
  const b = await prisma.tenant.create({ data: { name: 'WS Co B', slug: `${PREFIX}-b-${Date.now()}` }, select: { id: true } })
  tenantA = a.id
  tenantB = b.id
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.register(permissionRoutes, { prefix: '/api/v1/permissions' })
  await app.register(hrRoutes, { prefix: '/api/v1/hr' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  const invited = await prisma.user.findMany({ where: { email: { startsWith: `${PREFIX}.` } }, select: { id: true } })
  const ids = Array.from(new Set([...created, ...invited.map((u) => u.id)]))
  await prisma.hrEmployee.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { userId: { in: ids } }, { userEmail: { startsWith: `${PREFIX}.` } }] } })
  await prisma.staffPasswordReset.deleteMany({ where: { userId: { in: ids } } })
  await prisma.tenantMember.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

describe('workspace definitions (lib/workspaces.ts)', () => {
  it('every MODULE_ID is in exactly one workspace (retired ones may be unassigned)', () => {
    const count = new Map<string, number>()
    for (const w of WORKSPACES) for (const s of w.sections) for (const m of s.modules) count.set(m, (count.get(m) ?? 0) + 1)
    for (const m of MODULE_IDS) {
      if ((UNASSIGNED_MODULE_IDS as readonly string[]).includes(m)) { expect(count.get(m) ?? 0).toBe(0); continue }
      expect(count.get(m), `module ${m}`).toBe(1)
    }
    // …and no workspace names a module that does not exist.
    for (const m of count.keys()) expect(MODULE_IDS as readonly string[]).toContain(m)
  })

  it('role it has its defaults and a childRoles entry; every role has one', () => {
    expect(DEFAULT_MODULE_ACCESS.it).toEqual(['api_whatsapp', 'api_pos', 'integrations', 'audit_log', 'notifications', 'help'])
    for (const r of ALL_ROLES) expect(CHILD_ROLES[r], r).toBeDefined()
    expect(CHILD_ROLES.owner).toEqual([])
  })

  it('Dev opens with the API section: exactly the WhatsApp and POS connectors (spec D13)', () => {
    const dev = WORKSPACES.find((w) => w.id === 'dev')!
    expect(dev.sections[0]).toEqual({ key: 'api', title: 'API', modules: ['api_whatsapp', 'api_pos'] })
    expect(dev.sections.find((s) => s.key === 'systems')?.modules).toEqual(['integrations', 'notifications'])
  })

  it('D3: every approval section is a workspace id (plus procurement, the buying module of Operations); workspaces carry no approvalSection', () => {
    const ids = new Set(WORKSPACES.map((w) => w.id as string))
    for (const s of APPROVAL_SECTIONS) {
      if (s === 'procurement') {
        const ops = WORKSPACES.find((w) => w.id === 'operations')!
        expect(ops.sections.some((x) => x.modules.includes('procurement'))).toBe(true)
      } else expect(ids.has(s), s).toBe(true)
    }
    for (const w of WORKSPACES) for (const sec of w.sections) expect((sec as Record<string, unknown>)['approvalSection']).toBeUndefined()
    // Every approval type's queue module and hand-over module are workspace modules.
    const inSome = (m: string) => WORKSPACES.some((w) => w.sections.some((x) => x.modules.includes(m)))
    for (const t of APPROVAL_TYPES) {
      const r = APPROVAL_RIGHTS[t]
      expect(inSome(r.queueModule), `${t} ${r.queueModule}`).toBe(true)
      if (r.mustHoldModule) expect(inSome(r.mustHoldModule), `${t} ${r.mustHoldModule}`).toBe(true)
    }
  })

  it('Voided pre bills sits in Finance with the controls (spec §17.5)', () => {
    const finance = WORKSPACES.find((w) => w.id === 'finance')!
    const books = finance.sections.find((s) => s.key === 'books')!
    expect(books.modules).toContain('voided_prebills')
    expect(books.modules).toEqual(expect.arrayContaining(['reconciliation', 'exceptions']))
    for (const r of ['owner', 'management', 'finance'] as const) expect(DEFAULT_MODULE_ACCESS[r], r).toContain('voided_prebills')
  })

  it('/permissions/me returns workspaces + childRoles; /permissions/workspaces the full definition', async () => {
    const it_ = await makeUser('it', tenantA)
    const me = await app.inject({ method: 'GET', url: '/api/v1/permissions/me', headers: auth(it_) })
    expect(me.statusCode).toBe(200)
    const body = me.json()
    expect(body.childRoles).toEqual([])
    expect(body.workspaces.map((w: { id: string }) => w.id)).toEqual(['dev'])
    expect(body.workspaces[0].owner).toBe(true)

    const all = await app.inject({ method: 'GET', url: '/api/v1/permissions/workspaces', headers: auth(it_) })
    expect(all.statusCode).toBe(200)
    expect(all.json().map((w: { id: string }) => w.id)).toEqual(['ceo', 'operations', 'finance', 'marketing', 'hr', 'dev', 'director'])
  })
})

describe('D2: the CEO section and Operations for the F&B manager (2026-10-11)', () => {
  const ws = (id: string) => WORKSPACES.find((w) => w.id === id)!

  it('CEO holds Approvals, Companies & head offices, Logins & access and Company rules — owned by admin only', () => {
    const ceo = ws('ceo')
    expect(ceo.ownerRoles).toEqual(['admin'])
    // Brands moved to Marketing (owner, 2026-10-20).
    expect(ceo.sections.map((s) => s.title)).toEqual(['Overview', 'Approvals', 'Trash', 'Companies & head offices', 'Logins & access', 'Company rules'])
    const of = (key: string) => ceo.sections.find((s) => s.key === key)!.modules
    expect(of('approvals')).toEqual(['approvals'])
    expect(of('companies')).toEqual(['tenants', 'business_info', 'onboarding'])
    // Role presets moved to HR (owner, 2026-10-16); logins stay the CEO's.
    expect(of('access')).toEqual(['role_management'])
    const hr = ws('hr')
    expect(hr.sections.find((s) => s.key === 'access')!.modules).toEqual(['role_modules'])
    expect(DEFAULT_MODULE_ACCESS.hr).toContain('role_modules')
    expect(MODULE_GRANTS).toContain('role_modules')
    expect(of('rules')).toEqual(['configuration', 'settings'])
  })

  it('Operations is owned by the F&B manager and holds F&B work only — no company governance', () => {
    const ops = ws('operations')
    expect(ops.ownerRoles).toEqual(['fnb_manager'])
    const mods = ops.sections.flatMap((s) => s.modules)
    for (const m of ['menu', 'recipes', 'inventory', 'procurement', 'pos', 'kds_all', 'kds_config', 'food_safety']) expect(mods, m).toContain(m)
    for (const m of ['tenants', 'business_info', 'role_management', 'role_modules', 'configuration', 'settings', 'onboarding', 'ceo_overview', 'approvals']) {
      expect(mods, m).not.toContain(m)
    }
  })

  it('PPL-09 still holds: the workspace that holds configuration is the CEO\'s alone', () => {
    // setup/routes.ts lets APPROVERS plus that workspace's owner roles edit the
    // company-wide rules (selfie / geofence, tip split, service charge).
    const holder = WORKSPACES.find((w) => w.sections.some((s) => s.modules.includes('configuration')))!
    expect(holder.id).toBe('ceo')
    expect(holder.ownerRoles).toEqual(['admin'])
  })

  it('the F&B manager owns Operations in /permissions/me and does not get a CEO section', async () => {
    const fnb = await makeUser('fnb_manager', tenantA)
    const me = (await app.inject({ method: 'GET', url: '/api/v1/permissions/me', headers: auth(fnb) })).json()
    const ids = me.workspaces.map((w: { id: string }) => w.id)
    expect(ids).toContain('operations')
    expect(ids).not.toContain('ceo')
    expect(me.workspaces.find((w: { id: string }) => w.id === 'operations').owner).toBe(true)

    const ceo = await makeUser('admin', tenantA)
    const meCeo = (await app.inject({ method: 'GET', url: '/api/v1/permissions/me', headers: auth(ceo) })).json()
    // The CEO still sees everything: the CEO section first, Operations too,
    // and the Director page last (a preview; owner, 2026-10-18).
    expect(meCeo.workspaces.map((w: { id: string }) => w.id)).toEqual(['ceo', 'operations', 'finance', 'marketing', 'hr', 'dev', 'director'])
    expect(meCeo.workspaces.find((w: { id: string }) => w.id === 'ceo').owner).toBe(true)
    expect(meCeo.workspaces.find((w: { id: string }) => w.id === 'operations').owner).toBe(false)
  })

  it('the approvals module reaches the governance roles by default, and saved rows once (MODULE_GRANTS)', () => {
    for (const r of ['owner', 'management', 'manager'] as const) expect(DEFAULT_MODULE_ACCESS[r], r).toContain('approvals')
    for (const r of ['fnb_manager', 'foh_management', 'boh_management', 'finance', 'hr', 'marketing', 'brand_manager', 'it', 'cashier', 'foh', 'boh', 'kitchen', 'expediter', 'procurement'] as const) {
      expect(DEFAULT_MODULE_ACCESS[r], r).not.toContain('approvals')
    }
    expect(MODULE_GRANTS).toContain('approvals')
    expect(rolesGrantedByDefault('approvals').sort()).toEqual(['management', 'manager', 'owner'])
  })
})

describe('team invites', () => {
  it('fnb_manager can invite a line cook, not finance and not admin', async () => {
    const fnb = await makeUser('fnb_manager', tenantA)
    const ok = await app.inject({
      method: 'POST', url: '/api/v1/auth/staff/invite', headers: auth(fnb),
      payload: { name: 'New Cook', email: `${PREFIX}.cook.${Date.now()}@gsfoods.pk`, role: 'boh', phone: `0300${String(Date.now()).slice(-7)}` },
    })
    expect(ok.statusCode).toBe(201)
    const row = await prisma.user.findUniqueOrThrow({ where: { id: ok.json().id }, select: { tenantId: true, accountStatus: true, invitedById: true } })
    expect(row).toEqual({ tenantId: tenantA, accountStatus: 'pending', invitedById: fnb.id })

    for (const role of ['finance', 'admin']) {
      const r = await app.inject({
        method: 'POST', url: '/api/v1/auth/staff/invite', headers: auth(fnb),
        payload: { name: 'Nope', email: `${PREFIX}.nope.${role}.${Date.now()}@gsfoods.pk`, role },
      })
      expect(r.statusCode, role).toBe(403)
    }

    const mine = await app.inject({ method: 'GET', url: '/api/v1/auth/staff/invites', headers: auth(fnb) })
    expect(mine.json()).toEqual([expect.objectContaining({ id: ok.json().id, role: 'boh', status: 'pending' })])

    // A role with no childRoles cannot invite at all.
    const cook = await makeUser('boh', tenantA)
    const r = await app.inject({
      method: 'POST', url: '/api/v1/auth/staff/invite', headers: auth(cook),
      payload: { name: 'Nope', email: `${PREFIX}.nope2.${Date.now()}@gsfoods.pk`, role: 'boh' },
    })
    expect(r.statusCode).toBe(403)
  })

  it('binds to the active company; company B\'s CEO cannot see or approve it; A\'s CEO approves and the employee links', async () => {
    const mgr = await makeUser('management', tenantA)
    const emp = await prisma.hrEmployee.create({ data: { tenantId: tenantA, employeeCode: `${PREFIX}-1`, fullName: 'Invited Cashier' } })
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/staff/invite', headers: auth(mgr),
      payload: { name: 'Invited Cashier', email: `${PREFIX}.cashier.${Date.now()}@gsfoods.pk`, role: 'cashier', employeeId: emp.id, phone: `0301${String(Date.now()).slice(-7)}` },
    })
    expect(res.statusCode).toBe(201)
    const inviteId = res.json().id as string
    expect(res.json().tenantId).toBe(tenantA)
    // Held on the login until approval — not linked yet.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: inviteId } })).inviteEmployeeId).toBe(emp.id)
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emp.id } })).userId).toBeNull()

    // An employee of another company is refused.
    const empB = await prisma.hrEmployee.create({ data: { tenantId: tenantB, employeeCode: `${PREFIX}-2`, fullName: 'Other Co' } })
    const cross = await app.inject({
      method: 'POST', url: '/api/v1/auth/staff/invite', headers: auth(mgr),
      payload: { name: 'X', email: `${PREFIX}.x.${Date.now()}@gsfoods.pk`, role: 'cashier', employeeId: empB.id },
    })
    expect(cross.statusCode).toBe(422)

    const ceoB = await makeUser('admin', tenantB)
    const pendingB = await app.inject({ method: 'GET', url: '/api/v1/auth/staff/pending', headers: auth(ceoB) })
    expect(pendingB.statusCode).toBe(200)
    expect(pendingB.json().map((p: { id: string }) => p.id)).not.toContain(inviteId)
    const approveB = await app.inject({ method: 'PATCH', url: `/api/v1/auth/staff/${inviteId}/approve`, headers: auth(ceoB) })
    expect(approveB.statusCode).toBe(404)

    const ceoA = await makeUser('admin', tenantA)
    const pendingA = await app.inject({ method: 'GET', url: '/api/v1/auth/staff/pending', headers: auth(ceoA) })
    const row = pendingA.json().find((p: { id: string }) => p.id === inviteId)
    expect(row).toMatchObject({ tenantId: tenantA, invitedBy: { id: mgr.id, name: mgr.name } })

    const approve = await app.inject({ method: 'PATCH', url: `/api/v1/auth/staff/${inviteId}/approve`, headers: auth(ceoA) })
    expect(approve.statusCode).toBe(200)
    expect(approve.json()).toMatchObject({ accountStatus: 'active', linkedEmployeeId: emp.id })
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emp.id } })).userId).toBe(inviteId)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: inviteId } })).inviteEmployeeId).toBeNull()
  })
})

describe('sign-in audit', () => {
  it('a failed login writes auth.login_failed and a good one auth.login — no secrets', async () => {
    const fin = await makeUser('finance', tenantA)
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: fin.email, password: 'definitely-wrong-1' } })
    expect(bad.statusCode).toBe(401)
    const good = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: fin.email, password: PASSWORD } })
    expect(good.statusCode).toBe(200)

    const rows = await prisma.auditLog.findMany({ where: { userId: fin.id, action: { startsWith: 'auth.' } }, orderBy: { createdAt: 'asc' } })
    expect(rows.map((r) => r.action)).toEqual(['auth.login_failed', 'auth.login'])
    expect(rows.every((r) => r.category === 'identity' && r.tenantId === tenantA)).toBe(true)
    expect((rows[0]!.metadata as { reason: string }).reason).toBe('unauthorized')
    expect(JSON.stringify(rows)).not.toContain('definitely-wrong-1')
    expect(JSON.stringify(rows)).not.toContain(PASSWORD)

    // Unknown email: no userId, typed email kept.
    const ghost = `${PREFIX}.ghost.${Date.now()}@gsfoods.pk`
    await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: ghost, password: 'whatever-123' } })
    const g = await prisma.auditLog.findFirst({ where: { action: 'auth.login_failed', userEmail: ghost } })
    expect(g).toMatchObject({ userId: null, tenantId: null })

    // IT reads the trail, filtered, and the per-user summary.
    const it_ = await makeUser('it', tenantA)
    const list = await app.inject({ method: 'GET', url: `/api/v1/auth/audit-log?userId=${fin.id}&action=auth.`, headers: auth(it_) })
    expect(list.statusCode).toBe(200)
    expect(list.json().data).toHaveLength(2)
    const sum = await app.inject({ method: 'GET', url: `/api/v1/auth/audit-log/users/${fin.id}/summary`, headers: auth(it_) })
    expect(sum.statusCode).toBe(200)
    expect(sum.json()).toMatchObject({ user: { id: fin.id }, signInsLast30d: 1, failedLast30d: 1, actionsLast30d: 2 })
    expect(sum.json().lastSignInAt).toBeTruthy()

    // Company B's reader cannot see company A's user.
    const itB = await makeUser('it', tenantB)
    const foreign = await app.inject({ method: 'GET', url: `/api/v1/auth/audit-log/users/${fin.id}/summary`, headers: auth(itB) })
    expect(foreign.statusCode).toBe(404)
  })
})

describe('/hr/team', () => {
  it('returns indirect reports with depth, managerId and pendingApprovals', async () => {
    const boss = await makeUser('management', tenantA)
    const lead = await makeUser('boh_management', tenantA)
    const top = await prisma.hrEmployee.create({ data: { tenantId: tenantA, employeeCode: `${PREFIX}-T`, fullName: 'Top', userId: boss.id } })
    const mid = await prisma.hrEmployee.create({ data: { tenantId: tenantA, employeeCode: `${PREFIX}-M`, fullName: 'Mid', managerId: top.id, userId: lead.id } })
    const low = await prisma.hrEmployee.create({ data: { tenantId: tenantA, employeeCode: `${PREFIX}-L`, fullName: 'Low', managerId: mid.id } })
    // A loop in the data must not hang the walk.
    await prisma.hrEmployee.update({ where: { id: top.id }, data: { managerId: low.id } })

    const res = await app.inject({ method: 'GET', url: '/api/v1/hr/team', headers: auth(boss) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.pendingApprovals).toBe('number')
    const byId = new Map(body.team.map((t: { id: string }) => [t.id, t]))
    expect(byId.get(mid.id)).toMatchObject({ depth: 1, managerId: top.id, userId: lead.id })
    expect(byId.get(low.id)).toMatchObject({ depth: 2, managerId: mid.id, userId: null, todayStatus: null })
    expect(byId.has(top.id)).toBe(false)
  })
})
