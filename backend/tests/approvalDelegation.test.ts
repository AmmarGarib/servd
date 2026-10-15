// Hand-over (delegation) grant / revoke / list (D3; spec §7.5, A4, A12, A22).
//
//   - POST /approvals/delegations checks, in order: head office + CEO member
//     (404), company live-linked (422), section (422 SECTION_NOT_DELEGABLE /
//     SECTION_NOT_YET_DELEGABLE), types in the section (422), the delegate
//     (422 DELEGATE_NOT_ELIGIBLE / DELEGATE_LACKS_MODULE), endsAt (422), one
//     head office per (company, section) for company-owned types (409, under
//     an advisory lock — two racing grants: exactly one wins).
//   - Revoke: once (a second → 409). Audit rows for both.
//   - Lists: the CEO sees their head offices' hand-overs, a delegate their own.
//   - A12: ending a link revokes that company's hand-overs.
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { AppError } = await import('../src/lib/errors.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')
const R = await import('../src/lib/approvalRights.js')

const P = `ad${Date.now()}`
const T: Record<'C1' | 'C2' | 'C3' | 'HO' | 'HO2', string> = { C1: '', C2: '', C3: '', HO: '', HO2: '' }
const U: Record<string, { id: string; role: string; name: string; email: string }> = {}
let app: FastifyInstance

async function mkUser(key: string, role: string, members: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@ad.pk`, password: 'x', role: role as never, tenantId: members[0] ?? null,
      isActive: true, accountStatus: 'active', ...extra,
      tenantMemberships: { create: members.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
  })
  U[key] = { id: u.id, role, name: u.name!, email: u.email! }
}
function auth(key: string) {
  const u = U[key]!
  const s = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}` }
}
const grant = (body: Record<string, unknown>, key = 'ceo') =>
  app.inject({ method: 'POST', url: '/api/v1/approvals/delegations', headers: auth(key), payload: { note: 'Monthly hand-over', ...body } })
const revoke = (id: string, key = 'ceo') =>
  app.inject({ method: 'POST', url: `/api/v1/approvals/delegations/${id}/revoke`, headers: auth(key), payload: { reason: 'Back from leave' } })
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code: string } }).error?.code

beforeAll(async () => {
  for (const k of ['C1', 'C2', 'C3'] as const) T[k] = (await prisma.tenant.create({ data: { name: `${P} ${k}`, slug: `${P}-${k.toLowerCase()}` } })).id
  T.HO = (await prisma.tenant.create({ data: { name: `${P} HO`, slug: `${P}-ho`, kind: 'head_office' } })).id
  T.HO2 = (await prisma.tenant.create({ data: { name: `${P} HO2`, slug: `${P}-ho2`, kind: 'head_office' } })).id
  await mkUser('ceo', 'admin', [T.C1, T.C2, T.C3, T.HO, T.HO2])
  await mkUser('ceoNotHo', 'admin', [T.C1])
  await mkUser('buyer', 'procurement', [T.HO])
  await mkUser('deputy', 'procurement', [T.HO])
  await mkUser('buyer2', 'procurement', [T.HO2])
  await mkUser('fin', 'finance', [T.HO])
  await mkUser('fin2', 'finance', [T.HO2])
  await mkUser('mkt', 'marketing', [T.HO])
  await mkUser('outsider', 'procurement', [T.C1])
  await mkUser('gone', 'procurement', [T.HO], { isActive: false })
  await mkUser('noModule', 'procurement', [T.HO], { moduleDeny: ['procurement'] })
  for (const [ho, c] of [[T.HO, T.C1], [T.HO, T.C2], [T.HO2, T.C1], [T.HO2, T.C3]] as const) {
    await prisma.headOfficeLink.create({ data: { tenantId: ho, companyTenantId: c, createdById: U['ceo']!.id } })
  }

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => { await registerApprovalsPlugin(api) }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

describe('grant: every refusal, in order', () => {
  it('404 when it is not a head office, or the CEO is not a member of it; 403 for anyone but the CEO', async () => {
    expect((await grant({ headOfficeId: T.C1, section: 'procurement', delegateUserId: U['buyer']!.id })).statusCode).toBe(404)
    expect((await grant({ headOfficeId: T.HO, section: 'procurement', delegateUserId: U['buyer']!.id }, 'ceoNotHo')).statusCode).toBe(404)
    expect((await grant({ headOfficeId: T.HO, section: 'procurement', delegateUserId: U['buyer']!.id }, 'buyer')).statusCode).toBe(403)
  })

  it('422 COMPANY_NOT_LINKED for a company the head office does not serve', async () => {
    const res = await grant({ headOfficeId: T.HO, companyTenantId: T.C3, section: 'procurement', delegateUserId: U['buyer']!.id })
    expect([res.statusCode, code(res)]).toEqual([422, 'COMPANY_NOT_LINKED'])
  })

  it('sections: ceo never; marketing not yet; a type outside the section; journal requests not yet (A22)', async () => {
    const ceo = await grant({ headOfficeId: T.HO, section: 'ceo', delegateUserId: U['buyer']!.id })
    expect([ceo.statusCode, code(ceo)]).toEqual([422, 'SECTION_NOT_DELEGABLE'])
    const nope = await grant({ headOfficeId: T.HO, section: 'kitchen', delegateUserId: U['buyer']!.id })
    expect(code(nope)).toBe('SECTION_NOT_DELEGABLE')
    const mkt = await grant({ headOfficeId: T.HO, companyTenantId: T.C1, section: 'marketing', delegateUserId: U['mkt']!.id })
    expect([mkt.statusCode, code(mkt)]).toEqual([422, 'SECTION_NOT_YET_DELEGABLE'])
    const wrong = await grant({ headOfficeId: T.HO, section: 'finance', approvalTypes: ['purchase_order'], delegateUserId: U['fin']!.id })
    expect([wrong.statusCode, code(wrong)]).toEqual([422, 'TYPE_NOT_IN_SECTION'])
    const ceoType = await grant({ headOfficeId: T.HO, section: 'finance', approvalTypes: ['bad_debt'], delegateUserId: U['fin']!.id })
    expect(code(ceoType)).toBe('TYPE_NOT_IN_SECTION')
    const jr = await grant({ headOfficeId: T.HO, companyTenantId: T.C1, section: 'finance', approvalTypes: ['journal_request'], delegateUserId: U['fin']!.id })
    expect([jr.statusCode, code(jr)]).toEqual([422, 'SECTION_NOT_YET_DELEGABLE'])
    const rechargeScoped = await grant({ headOfficeId: T.HO, companyTenantId: T.C1, section: 'finance', approvalTypes: ['ho_recharge'], delegateUserId: U['fin']!.id })
    expect(code(rechargeScoped)).toBe('TYPE_NOT_IN_SECTION')
  })

  it('the delegate: an active, non-admin member of the head office holding the module', async () => {
    for (const who of ['outsider', 'gone', 'ceo']) {
      const res = await grant({ headOfficeId: T.HO, section: 'procurement', delegateUserId: U[who]!.id })
      expect([res.statusCode, code(res)], who).toEqual([422, 'DELEGATE_NOT_ELIGIBLE'])
    }
    const lacks = await grant({ headOfficeId: T.HO, section: 'procurement', delegateUserId: U['noModule']!.id })
    expect([lacks.statusCode, code(lacks)]).toEqual([422, 'DELEGATE_LACKS_MODULE'])
    expect((lacks.json() as { error: { message: string } }).error.message).toMatch(/procurement/)
  })

  it('endsAt must be in the future', async () => {
    const res = await grant({ headOfficeId: T.HO, companyTenantId: T.C1, section: 'procurement', delegateUserId: U['buyer']!.id, endsAt: '2020-01-01T00:00:00Z' })
    expect([res.statusCode, code(res)]).toEqual([422, 'ENDS_AT_IN_PAST'])
  })
})

describe('grant, list and revoke', () => {
  let first = ''
  it('grants, audits, and a deputy of the same head office may hold it too', async () => {
    const res = await grant({ headOfficeId: T.HO, companyTenantId: T.C1, section: 'procurement', delegateUserId: U['buyer']!.id, endsAt: new Date(Date.now() + 86_400_000).toISOString() })
    expect(res.statusCode).toBe(201)
    first = (res.json() as { delegation: { id: string } }).delegation.id
    expect(await prisma.auditLog.count({ where: { action: 'approval.delegation.grant', entityId: first, category: 'identity' } })).toBe(1)
    expect((await grant({ headOfficeId: T.HO, companyTenantId: T.C1, section: 'procurement', delegateUserId: U['deputy']!.id })).statusCode).toBe(201)
  })

  it('one head office per (company, section): another head office gets 409, company-scoped or head-office-wide', async () => {
    const scoped = await grant({ headOfficeId: T.HO2, companyTenantId: T.C1, section: 'procurement', delegateUserId: U['buyer2']!.id })
    expect([scoped.statusCode, code(scoped)]).toEqual([409, 'SECTION_HANDED_TO_OTHER_HEAD_OFFICE'])
    const wide = await grant({ headOfficeId: T.HO2, section: 'procurement', delegateUserId: U['buyer2']!.id })
    expect(code(wide)).toBe('SECTION_HANDED_TO_OTHER_HEAD_OFFICE')
    // HO2's own other company is free.
    expect((await grant({ headOfficeId: T.HO2, companyTenantId: T.C3, section: 'procurement', delegateUserId: U['buyer2']!.id })).statusCode).toBe(201)
  })

  it('A4: head-office-owned types skip the uniqueness check — HO2 holds its own recharges while HO holds C1\'s finance', async () => {
    expect((await grant({ headOfficeId: T.HO, companyTenantId: T.C1, section: 'finance', delegateUserId: U['fin']!.id })).statusCode).toBe(201)
    const own = await grant({ headOfficeId: T.HO2, section: 'finance', approvalTypes: ['ho_recharge', 'intercompany_transfer'], delegateUserId: U['fin2']!.id })
    expect(own.statusCode).toBe(201)
    // …but HO2's company-owned finance types for C1 clash.
    const clash = await grant({ headOfficeId: T.HO2, section: 'finance', approvalTypes: ['tip_pool'], delegateUserId: U['fin2']!.id })
    expect(code(clash)).toBe('SECTION_HANDED_TO_OTHER_HEAD_OFFICE')
  })

  it('"all types" of a section with a locked type stores the switched-on types (flipping a constant never widens it)', async () => {
    const row = await prisma.approvalDelegation.findFirstOrThrow({ where: { tenantId: T.HO, section: 'finance', companyTenantId: T.C1 } })
    expect(row.approvalTypes.sort()).toEqual(['ho_recharge', 'intercompany_transfer', 'tip_pool'])
    expect(row.approvalTypes).not.toContain('journal_request')
  })

  it('two racing grants for the same (company, section) from two head offices: exactly one wins', async () => {
    await mkUser('hrA', 'hr', [T.HO])
    await mkUser('hrB', 'hr', [T.HO2])
    const [x, y] = await Promise.all([
      grant({ headOfficeId: T.HO, section: 'hr', delegateUserId: U['hrA']!.id }),
      grant({ headOfficeId: T.HO2, section: 'hr', delegateUserId: U['hrB']!.id }),
    ])
    expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409])
  })

  it('lists: the CEO sees every hand-over of their head offices; a delegate their own; eligible and catalog', async () => {
    const all = (await app.inject({ method: 'GET', url: '/api/v1/approvals/delegations', headers: auth('ceo') })).json() as { delegations: Array<{ id: string; state: string; delegateName: string; scopeName: string }> }
    expect(all.delegations.find((d) => d.id === first)).toMatchObject({ state: 'live', delegateName: `${P} buyer`, scopeName: `${P} C1` })
    const mine = (await app.inject({ method: 'GET', url: '/api/v1/approvals/delegations', headers: auth('buyer') })).json() as { delegations: Array<{ delegateUserId: string }> }
    expect(mine.delegations.length).toBeGreaterThan(0)
    expect(mine.delegations.every((d) => d.delegateUserId === U['buyer']!.id)).toBe(true)
    const el = (await app.inject({ method: 'GET', url: `/api/v1/approvals/delegations/eligible?headOfficeId=${T.HO}&section=procurement`, headers: auth('ceo') })).json() as { delegates: Array<{ id: string; types: string[]; lacks: string[] }> }
    expect(el.delegates.find((d) => d.id === U['buyer']!.id)?.types).toEqual(['purchase_order'])
    expect(el.delegates.find((d) => d.id === U['noModule']!.id)?.lacks).toEqual(['purchase_order'])
    expect(el.delegates.some((d) => d.id === U['outsider']!.id)).toBe(false)
    expect((await app.inject({ method: 'GET', url: `/api/v1/approvals/delegations/eligible?headOfficeId=${T.HO}&section=procurement`, headers: auth('buyer') })).statusCode).toBe(403)
    const cat = (await app.inject({ method: 'GET', url: '/api/v1/approvals/catalog', headers: auth('buyer') })).json() as { sections: Array<{ id: string; delegable: boolean; notYet: boolean; types: Array<{ type: string; enabled: boolean }> }> }
    expect(cat.sections.find((s) => s.id === 'ceo')).toMatchObject({ delegable: false })
    expect(cat.sections.find((s) => s.id === 'marketing')).toMatchObject({ delegable: true, notYet: true })
    expect(cat.sections.find((s) => s.id === 'finance')!.types.find((t) => t.type === 'journal_request')).toMatchObject({ enabled: false })
  })

  it('revoke once; a second revoke is 409; audited; the live check stops it at once', async () => {
    const req = { headers: {}, staffUser: { id: U['buyer']!.id, email: null, name: null, role: 'procurement', tenantId: T.HO, tenantFilter: T.HO, memberTenantIds: [T.HO] } } as never
    const item = { type: 'purchase_order', tenantId: T.C1, touchesTenantIds: [T.C1], submittedByIds: [] }
    expect(await R.canApprove(req, item)).toBe(true)
    const res = await revoke(first)
    expect(res.statusCode).toBe(200)
    expect((res.json() as { delegation: { revokeReason: string } }).delegation.revokeReason).toBe('Back from leave')
    expect([(await revoke(first)).statusCode, code(await revoke(first))]).toEqual([409, 'ALREADY_REVOKED'])
    expect(await prisma.auditLog.count({ where: { action: 'approval.delegation.revoke', entityId: first } })).toBe(1)
    // The deputy still holds C1 procurement; buyer no longer does.
    expect(await R.canApprove(req, item)).toBe(false)
    expect((await revoke('00000000-0000-0000-0000-000000000000')).statusCode).toBe(404)
  })
})

describe('A12: link changes', () => {
  it('ending a link revokes that company\'s hand-overs of that head office (same transaction)', async () => {
    const before = await prisma.approvalDelegation.count({ where: { tenantId: T.HO, companyTenantId: T.C1, revokedAt: null } })
    expect(before).toBeGreaterThan(0)
    const ids = await prisma.$transaction((tx) => R.revokeDelegationsForUnlinkTx(tx, T.HO, T.C1, U['ceo']!.id))
    expect(ids.length).toBe(before)
    const rows = await prisma.approvalDelegation.findMany({ where: { id: { in: ids } } })
    expect(rows.every((r) => r.revokedAt && r.revokeReason === 'company unlinked')).toBe(true)
    // HO2's hand-overs and HO's other companies are untouched.
    expect(await prisma.approvalDelegation.count({ where: { tenantId: T.HO2, revokedAt: null } })).toBeGreaterThan(0)
  })

  it('a head-office-wide hand-over is listed for the link dialog (it would extend to a newly linked company)', async () => {
    const wide = await R.hoWideDelegationsOf(T.HO2)
    expect(wide.length).toBeGreaterThan(0)
    expect(wide.every((d) => d.companyTenantId === null && d.tenantId === T.HO2)).toBe(true)
  })

  it.todo('wave 2 (HO-A1 endLink): POST /head-offices/:id/links/:linkId/end calls revokeDelegationsForUnlinkTx and audits approval.delegation.revoke')
  it.todo('wave 2 (HO-A1 link + D-stream dialog): linking a company lists hoWideDelegationsOf and requires "extend these hand-overs" or a revoke')
})
