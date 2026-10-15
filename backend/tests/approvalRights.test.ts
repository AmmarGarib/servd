// Approval rights registry and the who-may-approve decision (D3; spec §7.2,
// §7.4, §7.7 as amended by A3, A4, A5, A13, A21, A22, A23).
//
//   - Registry invariants: one entry per APPROVAL_TYPES type; sections are the
//     workspaces' (+ procurement, + ceo); the hand-over table is the spec's.
//   - approvalSubject resolves every type on serviceClient (A5).
//   - Role path, through-head-office (A3), delegation coverage (live checks:
//     not started, expired, revoked, left the head office, lost the module,
//     link ended), A4 head-office ownership, A13 the submitter's head office.
//   - Separation of duties for delegates; the CEO-only items and routes.
//
// Real database (the disposable test DB); route checks through Fastify inject.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { ZodError } from 'zod'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { AppError } = await import('../src/lib/errors.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const R = await import('../src/lib/approvalRights.js')
const { WORKSPACES, WORKSPACE_OF_MODULE } = await import('../src/lib/workspaces.js')
const { MODULE_IDS } = await import('../src/lib/moduleAccess.js')
const { APPROVAL_TYPES: INBOX_TYPES } = await import('../src/modules/approvals/types.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')
const { accountingRoutes } = await import('../src/modules/accounting/routes.js')
const { permissionRoutes } = await import('../src/modules/permissions/routes.js')
const { tenantRoutes } = await import('../src/modules/tenants/routes.js')
const { connectorRoutes } = await import('../src/modules/connectors/routes.js')

const P = `ar${Date.now()}`
const T: Record<'C1' | 'C2' | 'HO' | 'HO2', string> = { C1: '', C2: '', HO: '', HO2: '' }
const U: Record<string, { id: string; role: string; members: string[]; name: string; email: string }> = {}
let app: FastifyInstance

async function mkUser(key: string, role: string, members: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@ar.pk`, password: 'x', role: role as never, tenantId: members[0] ?? null,
      isActive: true, accountStatus: 'active', ...extra,
      tenantMemberships: { create: members.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
  })
  U[key] = { id: u.id, role, members, name: u.name!, email: u.email! }
  return U[key]!
}
/** A request as the auth middleware would leave it (no head-office reach in this stream's tests). */
function reqAs(key: string): FastifyRequest {
  const u = U[key]!
  return { headers: {}, staffUser: { id: u.id, email: u.email, name: u.name, role: u.role, tenantId: u.members[0] ?? null, tenantFilter: u.members[0] ?? null, memberTenantIds: u.members } } as unknown as FastifyRequest
}
async function delegate(user: string, ho: string, section: string, extra: Record<string, unknown> = {}) {
  return prisma.approvalDelegation.create({
    data: { tenantId: ho, section, delegateUserId: U[user]!.id, grantedById: U['ceo']!.id, note: 'test', ...extra },
  })
}
const decide = (key: string, input: Parameters<typeof R.decideApproval>[1]) => R.decideApproval(reqAs(key), input)
const po = (tenantId: string, submitters: string[], extra: Partial<Parameters<typeof R.decideApproval>[1]> = {}) =>
  ({ type: 'purchase_order', tenantId, touchesTenantIds: [tenantId], submittedByIds: submitters, entity: 'PurchaseOrder', entityId: 'po-1', ...extra })

beforeAll(async () => {
  T.C1 = (await prisma.tenant.create({ data: { name: `${P} C1`, slug: `${P}-c1` } })).id
  T.C2 = (await prisma.tenant.create({ data: { name: `${P} C2`, slug: `${P}-c2` } })).id
  T.HO = (await prisma.tenant.create({ data: { name: `${P} HO`, slug: `${P}-ho`, kind: 'head_office' } })).id
  T.HO2 = (await prisma.tenant.create({ data: { name: `${P} HO2`, slug: `${P}-ho2`, kind: 'head_office' } })).id
  await mkUser('ceo', 'admin', [T.C1, T.C2, T.HO, T.HO2])
  await mkUser('gm', 'owner', [T.C1])                       // a company co-owner (recipe role path)
  await mkUser('buyer', 'procurement', [T.HO])               // HO procurement HOD
  await mkUser('buyer2', 'procurement', [T.HO])              // HO procurement deputy
  await mkUser('dualHod', 'procurement', [T.HO, T.C1])        // A3: still a member of C1 too
  await mkUser('ho2Buyer', 'procurement', [T.HO2])           // HO2's procurement HOD
  await mkUser('fin', 'finance', [T.HO])                     // HO finance HOD
  await mkUser('fin2', 'finance', [T.HO2])                   // HO2 finance HOD
  await mkUser('itHod', 'it', [T.HO])
  await mkUser('hrHod', 'hr', [T.HO])
  await mkUser('ops', 'fnb_manager', [T.HO])
  for (const [ho, c] of [[T.HO, T.C1], [T.HO, T.C2], [T.HO2, T.C1]] as const) {
    await prisma.headOfficeLink.create({ data: { tenantId: ho, companyTenantId: c, createdById: U['ceo']!.id, startedAt: new Date('2026-01-01') } })
  }

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(accountingRoutes, { prefix: '/accounting' })
    await api.register(permissionRoutes, { prefix: '/permissions' })
    await api.register(tenantRoutes, { prefix: '/tenants' })
    await api.register(connectorRoutes, { prefix: '/connectors' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

describe('the registry (APPROVAL_RIGHTS is the one copy)', () => {
  it('covers every approval type, and the inbox re-exports the same list', () => {
    expect([...INBOX_TYPES]).toEqual([...R.APPROVAL_TYPES])
    for (const t of R.APPROVAL_TYPES) {
      const r = R.APPROVAL_RIGHTS[t]
      expect(r, t).toBeDefined()
      expect(R.APPROVAL_SECTIONS, t).toContain(r.section)
      expect((MODULE_IDS as readonly string[]).includes(r.queueModule), `${t} queue module ${r.queueModule}`).toBe(true)
      if (r.mustHoldModule) expect((MODULE_IDS as readonly string[]).includes(r.mustHoldModule), `${t} ${r.mustHoldModule}`).toBe(true)
      if (r.delegable) {
        expect(r.mustHoldModule, t).not.toBeNull()
        expect(r.section, t).not.toBe('ceo')
      }
    }
    for (const t of ['journal_request', 'ho_recharge', 'connector_change', 'on_account_client'] as const) expect(R.APPROVAL_RIGHTS[t]).toBeDefined()
  })

  it('section ids derive from WORKSPACES: every workspace id, plus procurement (the buying module in Operations)', () => {
    const workspaceIds = WORKSPACES.map((w) => w.id as string).sort()
    expect(R.APPROVAL_SECTIONS.filter((s) => s !== 'procurement').sort()).toEqual(workspaceIds)
    expect(WORKSPACE_OF_MODULE.get('procurement')).toBe('operations')
    expect(R.APPROVAL_SECTION_TITLES.procurement).toBe('Procurement')
    for (const w of WORKSPACES) expect(R.APPROVAL_SECTION_TITLES[w.id as 'hr']).toBe(w.title)
    expect(R.DELEGABLE_SECTIONS).not.toContain('ceo')
  })

  it('the hand-over table is the spec\'s', () => {
    const delegable = R.APPROVAL_TYPES.filter((t) => R.APPROVAL_RIGHTS[t].delegable).sort()
    expect(delegable).toEqual(['connector_change', 'ho_recharge', 'hr_request', 'intercompany_transfer', 'journal_request',
      'payroll_run', 'purchase_order', 'recipe', 'staff_login', 'storefront_publish', 'tip_pool'])
    // Never delegable: stock transfers, the HOD signature, and the CEO section.
    for (const t of ['stock_transfer', 'cash_request_hod', 'cash_voucher', 'fixed_asset_request', 'bad_debt', 'raast_void',
      'grni_writeoff', 'stock_difference', 'on_account_client'] as const) expect(R.APPROVAL_RIGHTS[t].delegable, t).toBe(false)
    for (const t of ['cash_voucher', 'fixed_asset_request', 'bad_debt', 'raast_void', 'grni_writeoff', 'stock_difference', 'on_account_client'] as const) {
      expect(R.APPROVAL_RIGHTS[t].section, t).toBe('ceo')
    }
    // Locked until the owner confirms (A22 + spec §7.2 marketing).
    expect(R.delegationEnabled('journal_request')).toBe(false)
    expect(R.delegationEnabled('storefront_publish')).toBe(false)
    expect(R.delegationEnabled('purchase_order')).toBe(true)
    expect(R.APPROVAL_RIGHTS.ho_recharge).toMatchObject({ ownership: 'head_office', hoWideOnly: true })
    expect(R.APPROVAL_RIGHTS.intercompany_transfer.ownership).toBe('head_office')
    expect(R.APPROVAL_RIGHTS.stock_transfer.exemptThroughHeadOffice).toBe(true)
    expect(R.APPROVAL_RIGHTS.purchase_order.section).toBe('procurement')
    expect(R.APPROVAL_RIGHTS.stock_transfer.section).toBe('operations')   // A23: explicit, not the "Stock & buying" workspace section
  })

  it('sectionOf moves an item to ceo by what it is', () => {
    expect(R.sectionOf('staff_login', { role: 'cashier' })).toBe('operations')
    expect(R.sectionOf('staff_login', { role: 'finance' })).toBe('ceo')
    expect(R.sectionOf('storefront_publish', { tenantId: null })).toBe('ceo')
    expect(R.sectionOf('storefront_publish', { tenantId: 'x' })).toBe('marketing')
    expect(R.sectionOf('journal_request', { kind: 'reverse' })).toBe('ceo')
    expect(R.sectionOf('journal_request', { kind: 'post' })).toBe('finance')
    expect(R.sectionOf('recipe', { tenantId: null })).toBe('ceo')
  })

  it('approvalSubject reads every type on serviceClient (null for an unknown id)', async () => {
    for (const t of R.APPROVAL_TYPES) expect(await R.approvalSubject(t, '00000000-0000-0000-0000-000000000000'), t).toBeNull()
    const s = await prisma.supplier.create({ data: { name: `${P} sup`, tenantId: T.C1 } })
    const p = await prisma.purchaseOrder.create({ data: { supplierId: s.id, status: 'pending_approval', totalCents: 100, createdBy: U['buyer']!.id, viaHeadOfficeId: T.HO } })
    expect(await R.approvalSubject('purchase_order', p.id)).toMatchObject({ companyIds: [T.C1], ownerTenantId: T.C1, submitterIds: [U['buyer']!.id], viaHeadOfficeId: T.HO, status: 'pending_approval' })
  })

  it('A21: a recipe with no company is CEO-only; a plate takes its brand\'s company', async () => {
    const orphan = await prisma.recipe.create({ data: { kind: 'component', status: 'pending_approval', name: `${P} sauce` } })
    const s = await R.approvalSubject('recipe', orphan.id)
    expect(s).toMatchObject({ companyIds: [], ownerTenantId: null })
    expect(R.approvalInputOf('recipe', orphan.id, s!).ceoOnly).toBe(true)
    const concept = await prisma.concept.create({ data: { name: `${P} brand`, slug: `${P}-brand`, type: 'restaurant', tenantId: T.C1 } })
    const plate = await prisma.recipe.create({ data: { status: 'pending_approval', pendingMenuItem: { conceptId: concept.id, name: 'x' }, submittedById: U['gm']!.id } })
    expect((await R.approvalSubject('recipe', plate.id))!.companyIds).toEqual([T.C1])
  })
})

describe('the role path', () => {
  it('the CEO approves in a member company; a company approver in theirs; 404 for a stranger', async () => {
    expect(await decide('ceo', po(T.C1, [U['gm']!.id]))).toMatchObject({ ok: true, grant: { via: 'role' } })
    expect(await decide('gm', { type: 'recipe', tenantId: T.C1, touchesTenantIds: [T.C1], submittedByIds: [U['ceo']!.id] })).toMatchObject({ ok: true })
    // A buyer (no role path for POs, no hand-over) never confirms C2's id.
    expect(await decide('buyer', po(T.C2, []))).toMatchObject({ ok: false, status: 404 })
    // gm belongs to C1 only: a recipe touching C2 too is not theirs.
    expect(await decide('gm', { type: 'recipe', tenantId: T.C1, touchesTenantIds: [T.C1, T.C2], submittedByIds: [] })).toMatchObject({ ok: false, status: 403, code: 'APPROVAL_NOT_YOURS' })
  })

  it('A3: an item a head-office member submitted goes to the CEO — even when they are a member of the company too', async () => {
    const submittedAt = new Date()
    const r = { type: 'recipe', tenantId: T.C1, touchesTenantIds: [T.C1], submittedByIds: [U['dualHod']!.id], submittedAt }
    expect(await decide('gm', r)).toMatchObject({ ok: false, status: 403, code: 'APPROVAL_NOT_YOURS', message: 'This needs the Operations approver' })
    expect(await decide('ceo', r)).toMatchObject({ ok: true, grant: { via: 'role' } })
    // A stored viaHeadOfficeId is enough on its own.
    expect(await decide('gm', { ...r, submittedByIds: [], viaHeadOfficeId: T.HO })).toMatchObject({ ok: false, status: 403 })
    // Not through head office: the company's own staff.
    expect(await decide('gm', { ...r, submittedByIds: [U['ceo']!.id] })).toMatchObject({ ok: true })
  })

  it('A3: ending the link after submission keeps the item with the CEO; a submission after the end does not', async () => {
    const link = await prisma.headOfficeLink.create({ data: { tenantId: T.HO2, companyTenantId: T.C2, createdById: U['ceo']!.id, startedAt: new Date('2026-01-01') } })
    const before = new Date()
    await prisma.headOfficeLink.update({ where: { id: link.id }, data: { endedAt: new Date(Date.now() + 1) } })
    await new Promise((res) => setTimeout(res, 5))
    expect(await R.submittedThroughHeadOffice({ tenantId: T.C2, submittedByIds: [U['ho2Buyer']!.id], submittedAt: before })).toBe(true)
    expect(await R.submittedThroughHeadOffice({ tenantId: T.C2, submittedByIds: [U['ho2Buyer']!.id], submittedAt: new Date() })).toBe(false)
    expect(await R.submittedThroughHeadOffice({ tenantId: T.C2, submittedByIds: [U['ceo']!.id], submittedAt: before })).toBe(false) // admins never count
  })

  it('stock transfers are exempt: the company\'s managers decide whoever asked', async () => {
    await mkUser('chef', 'fnb_manager', [T.C1])
    expect(await decide('chef', { type: 'stock_transfer', tenantId: T.C1, touchesTenantIds: [T.C1], submittedByIds: [U['dualHod']!.id] })).toMatchObject({ ok: true })
  })
})

describe('the delegation path (checked live on every use)', () => {
  it('a procurement hand-over for C1 lets the HOD approve C1\'s POs (not C2\'s); the CEO keeps the role path', async () => {
    const d = await delegate('buyer', T.HO, 'procurement', { companyTenantId: T.C1 })
    expect(await decide('buyer', po(T.C1, [U['gm']!.id]))).toMatchObject({ ok: true, grant: { via: 'delegation', delegationId: d.id } })
    expect(await decide('buyer', po(T.C2, [U['gm']!.id]))).toMatchObject({ ok: false })
    expect(await decide('ceo', po(T.C1, [U['gm']!.id]))).toMatchObject({ ok: true, grant: { via: 'role' } })
    // A through-HO item submitted by a colleague of the same head office.
    expect(await decide('buyer', po(T.C1, [U['buyer2']!.id], { viaHeadOfficeId: T.HO }))).toMatchObject({ ok: true })
    expect(await R.approvalQueueTenantIds(reqAs('buyer'), 'purchase_order')).toEqual([T.C1])
    expect(await R.approvalQueueTenantIds(reqAs('buyer'), 'recipe')).toEqual([])
    await prisma.approvalDelegation.update({ where: { id: d.id }, data: { revokedAt: new Date(), revokeReason: 'test' } })
  })

  it('not started, expired, revoked, left the head office, lost the module, link ended: each stops it at once', async () => {
    const live = () => decide('buyer2', po(T.C2, [U['gm']!.id]))
    const d = await delegate('buyer2', T.HO, 'procurement', { companyTenantId: T.C2, startsAt: new Date(Date.now() + 3_600_000) })
    expect((await live()).ok).toBe(false)                                        // not started
    await prisma.approvalDelegation.update({ where: { id: d.id }, data: { startsAt: new Date(Date.now() - 1000) } })
    expect((await live()).ok).toBe(true)
    await prisma.approvalDelegation.update({ where: { id: d.id }, data: { endsAt: new Date(Date.now() - 1) } })
    expect((await live()).ok).toBe(false)                                        // expired
    await prisma.approvalDelegation.update({ where: { id: d.id }, data: { endsAt: null } })
    expect((await live()).ok).toBe(true)
    await prisma.user.update({ where: { id: U['buyer2']!.id }, data: { moduleDeny: ['procurement'] } })
    expect((await live()).ok).toBe(false)                                        // lost the module
    await prisma.user.update({ where: { id: U['buyer2']!.id }, data: { moduleDeny: [] } })
    expect((await live()).ok).toBe(true)
    await prisma.tenantMember.deleteMany({ where: { userId: U['buyer2']!.id, tenantId: T.HO } })
    await prisma.user.update({ where: { id: U['buyer2']!.id }, data: { tenantId: null } })
    expect((await live()).ok).toBe(false)                                        // left the head office
    await prisma.tenantMember.create({ data: { userId: U['buyer2']!.id, tenantId: T.HO, role: 'member' } })
    expect((await live()).ok).toBe(true)
    const link = await prisma.headOfficeLink.findFirstOrThrow({ where: { tenantId: T.HO, companyTenantId: T.C2, endedAt: null } })
    await prisma.headOfficeLink.update({ where: { id: link.id }, data: { endedAt: new Date() } })
    expect((await live()).ok).toBe(false)                                        // link ended
    await prisma.headOfficeLink.update({ where: { id: link.id }, data: { endedAt: null } })
    expect((await live()).ok).toBe(true)
    await prisma.approvalDelegation.update({ where: { id: d.id }, data: { revokedAt: new Date() } })
    expect((await live()).ok).toBe(false)                                        // revoked
  })

  it('separation of duties: a delegate never approves what they submitted (403 + a self_approval flag)', async () => {
    const d = await delegate('buyer', T.HO, 'procurement', { companyTenantId: T.C1 })
    const input = po(T.C1, [U['buyer']!.id], { entityId: `${P}-self` })
    expect(await R.canApprove(reqAs('buyer'), input)).toBe(false)
    await expect(R.assertCanApprove(reqAs('buyer'), input)).rejects.toMatchObject({ code: 'SELF_APPROVAL_BLOCKED', statusCode: 403 })
    expect(await prisma.exceptionFlag.count({ where: { kind: 'self_approval', entityId: `${P}-self` } })).toBe(1)
    // The CEO is exempt.
    expect(await R.canApprove(reqAs('ceo'), po(T.C1, [U['ceo']!.id]))).toBe(true)
    await prisma.approvalDelegation.update({ where: { id: d.id }, data: { revokedAt: new Date() } })
  })

  it('A13: an item that came through ANOTHER head office stays with the CEO', async () => {
    const d = await delegate('buyer', T.HO, 'procurement', { companyTenantId: T.C1 })
    // HO2's HOD submitted it (HO2 also serves C1).
    expect(await decide('buyer', po(T.C1, [U['ho2Buyer']!.id], { submittedAt: new Date() }))).toMatchObject({ ok: false, status: 403 })
    expect(await decide('buyer', po(T.C1, [U['gm']!.id], { viaHeadOfficeId: T.HO2 }))).toMatchObject({ ok: false })
    expect(await decide('ceo', po(T.C1, [U['ho2Buyer']!.id]))).toMatchObject({ ok: true })
    // C1's own staff's item: the (C1, procurement) holder decides.
    expect(await decide('buyer', po(T.C1, [U['gm']!.id]))).toMatchObject({ ok: true })
    await prisma.approvalDelegation.update({ where: { id: d.id }, data: { revokedAt: new Date() } })
  })

  it('A4: head-office-owned types — a recharge needs a head-office-wide hand-over of ITS head office', async () => {
    const run = { type: 'ho_recharge', tenantId: T.HO, touchesTenantIds: [T.HO, T.C1, T.C2], submittedByIds: [] }
    const scoped = await delegate('fin', T.HO, 'finance', { companyTenantId: T.C1, approvalTypes: ['intercompany_transfer'] })
    expect((await decide('fin', run)).ok).toBe(false)
    const wide = await delegate('fin', T.HO, 'finance', { approvalTypes: ['ho_recharge'] })
    expect(await decide('fin', run)).toMatchObject({ ok: true, grant: { via: 'delegation', delegationId: wide.id } })
    // HO2's own finance delegate holds HO2's runs, never HO's.
    await delegate('fin2', T.HO2, 'finance', { approvalTypes: ['ho_recharge', 'intercompany_transfer'] })
    expect((await decide('fin2', run)).ok).toBe(false)
    expect((await decide('fin2', { ...run, tenantId: T.HO2, touchesTenantIds: [T.HO2, T.C1] })).ok).toBe(true)

    // Inter-company: a company-scoped (C1) delegate of HO approves HO↔C1, not HO↔C2,
    // and never a company ↔ company transfer (CEO-only item).
    const ic = (other: string) => ({ type: 'intercompany_transfer', tenantId: T.HO, companyTenantId: other, touchesTenantIds: [other, T.HO], submittedByIds: [] })
    expect(await decide('fin', ic(T.C1))).toMatchObject({ ok: true, grant: { via: 'delegation', delegationId: scoped.id } })
    expect((await decide('fin', ic(T.C2))).ok).toBe(false)
    expect((await decide('fin', { type: 'intercompany_transfer', tenantId: T.C1, touchesTenantIds: [T.C1, T.C2], submittedByIds: [], ceoOnly: true })).ok).toBe(false)
  })

  it('CEO-only items are never a delegate\'s, whatever is handed over', async () => {
    await delegate('ops', T.HO, 'operations', { companyTenantId: T.C1 })
    const login = (role: string) => ({ type: 'staff_login', tenantId: T.C1, touchesTenantIds: [T.C1], submittedByIds: [], ceoOnly: role !== 'cashier', role })
    expect((await decide('ops', login('cashier'))).ok).toBe(true)
    expect(await decide('ops', login('finance'))).toMatchObject({ ok: false, message: 'This needs the CEO' })
    // A recipe with no company.
    expect((await decide('ops', { type: 'recipe', tenantId: null, touchesTenantIds: [], submittedByIds: [] })).ok).toBe(false)
    // Stock transfers are never handed over (the delegate is not a C1 manager).
    expect((await decide('ops', { type: 'stock_transfer', tenantId: T.C1, touchesTenantIds: [T.C1], submittedByIds: [] })).ok).toBe(false)
    // Locked types: even a matching row does nothing until the constant is flipped.
    await delegate('fin', T.HO, 'finance', { companyTenantId: T.C1, approvalTypes: ['journal_request'] })
    expect((await decide('fin', { type: 'journal_request', tenantId: T.C1, touchesTenantIds: [T.C1], submittedByIds: [], kind: 'post' })).ok).toBe(false)
    // The CEO section.
    for (const t of ['cash_voucher', 'bad_debt', 'raast_void', 'grni_writeoff', 'stock_difference', 'fixed_asset_request', 'on_account_client']) {
      expect((await decide('fin', { type: t, tenantId: T.C1, touchesTenantIds: [T.C1], submittedByIds: [] })).ok, t).toBe(false)
    }
  })

  it('every CEO-only route answers 403 to a delegate (spec §7.7)', async () => {
    await delegate('itHod', T.HO, 'dev', { companyTenantId: T.C1 })
    await delegate('hrHod', T.HO, 'hr', { companyTenantId: T.C1 })
    const as = (key: string) => {
      const u = U[key]!
      const s = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never })
      return { authorization: `Bearer ${s.accessToken}` }
    }
    const routes: Array<[string, 'POST' | 'PUT' | 'PATCH', string]> = [
      ['fin', 'POST', '/accounting/journal'],
      ['fin', 'POST', '/accounting/journal/x/reverse'],
      ['fin', 'POST', '/accounting/period-close'],
      ['fin', 'POST', '/accounting/period-close/reopen'],
      ['hrHod', 'PUT', '/permissions/role-modules'],
      ['fin', 'POST', '/tenants/merge'],
      ['fin', 'PATCH', `/tenants/${T.C1}`],
      ['itHod', 'POST', '/connectors/fiscal/go-live'],
      ['itHod', 'POST', '/connectors/fiscal/switch-off'],
      ['itHod', 'PUT', '/connectors/fiscal/reporting-required'],
      ['itHod', 'POST', '/connectors/fiscal/documents/release'],
      ['buyer', 'POST', '/approvals/delegations'],
      ['buyer', 'POST', '/approvals/delegations/x/revoke'],
    ]
    for (const [key, method, url] of routes) {
      const res = await app.inject({ method, url: `/api/v1${url}`, headers: as(key), payload: {} })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
  })

  it.todo('wave 2: POST /tenants (ADMIN_ONLY after X-TENANTS), /head-offices/*, /hr/head-office-transfers*, /intercompany reverse routes and /site-layouts/:slug/rollback answer 403 to a delegate')
})
