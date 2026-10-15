// HO-B3b — staff logins, tip pools and website changes under head office (D1)
// and hand-over (D3): spec §7.3, §7.4, §7.7.
//
//   - Logins: an HOD invites through the lens (pending in the LENS company,
//     within childRoles, stamped viaHeadOfficeId); an Operations delegate
//     approves a FLOOR login, never a password login (CEO only); never their
//     own invite; another company → 404.
//   - Tip pools: a delegated post / pay books into the POOL's company; a pool
//     created through head office stays with the CEO (not the company's
//     owners); the creator never posts their own pool.
//   - Website: while storefront_publish is switched off only the CEO
//     decides; switched on, a Marketing delegate decides a company's brand
//     page but never a servd:* page; rollback stays CEO; lens draft / submit
//     only on the lens company's rows (servd:* refused), submit stamps
//     viaHeadOfficeId.
//   - No row carries the head office's tenantId.
//
// Real route handlers through Fastify inject on the disposable test DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { runWithRlsContext } from '../src/lib/rlsContext.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { DELEGATION_ENABLED } from '../src/lib/approvalRights.js'
import { authRoutes } from '../src/modules/auth/routes.js'
import { tipPoolRoutes } from '../src/modules/tipPools/routes.js'
import { siteLayoutRoutes } from '../src/modules/siteLayouts/routes.js'

const P = `hb3b${Date.now()}`
let app: FastifyInstance
let HO: string, A: string, B: string
let brandA: string, brandB: string
const users: Record<string, { id: string; token: string }> = {}

async function tenant(name: string, kind: 'company' | 'head_office') {
  return (await prisma.tenant.create({ data: { name: `${P} ${name}`, slug: `${P}-${name.toLowerCase()}`, kind } })).id
}
async function mkUser(key: string, role: UserRole, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u.id
}
async function delegate(key: string, section: string, types: string[] = [], companyTenantId: string | null = A) {
  return prisma.approvalDelegation.create({
    data: { tenantId: HO, companyTenantId, section, approvalTypes: types, delegateUserId: users[key]!.id, grantedById: users['ceo']!.id, note: 'test hand-over' },
  })
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
function call(who: string, method: Method, url: string, opts: { lens?: string; payload?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${users[who]!.token}` }
  if (opts.lens) headers['x-servd-active-tenant'] = opts.lens
  return app.inject({ method, url: `/api/v1${url}`, headers, ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}) })
}
const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
const enc = encodeURIComponent
const blocks = (label: string) => [{ id: `b-${label}`, type: 'text', body: label }]

let phoneN = 0
const phone = () => `0300${String(1_000_000 + Date.now() % 1_000_000 + (++phoneN)).slice(-7)}`

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tip_pool_members_one_person') THEN
      ALTER TABLE "tip_pool_members" ADD CONSTRAINT "tip_pool_members_one_person" CHECK (("userId" IS NULL) <> ("employeeId" IS NULL));
    END IF; END $$`)

  HO = await tenant('HO', 'head_office')
  A = await tenant('A', 'company')
  B = await tenant('B', 'company')
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  brandA = (await prisma.concept.create({ data: { name: 'A Cafe', slug: `${P}-acafe`, type: 'restaurant', tenantId: A } })).slug
  brandB = (await prisma.concept.create({ data: { name: 'B Cafe', slug: `${P}-bcafe`, type: 'restaurant', tenantId: B } })).slug

  await mkUser('ceo', 'admin', A, [HO, A, B])
  await mkUser('hodOps', 'fnb_manager', HO, [HO])    // HO Operations HOD: invites through the lens
  await mkUser('opsDel', 'fnb_manager', HO, [HO])    // HO Operations approver (hand-over)
  await mkUser('finDel', 'finance', HO, [HO])        // HO Finance approver (tip pools)
  await mkUser('dualFin', 'finance', HO, [HO, A])    // HO finance, also a member of A
  await mkUser('mktDel', 'marketing', HO, [HO])      // HO Marketing (lens drafts; delegate when switched on)
  await mkUser('ownerA', 'owner', A, [A])
  await mkUser('ownerA2', 'owner', A, [A])
  await mkUser('mgmtA', 'management', A, [A])
  await mkUser('mktA', 'marketing', A, [A])
  await mkUser('ownerB', 'owner', B, [B])
  await mkUser('cashierA', 'cashier', A, [A])

  await prisma.headOfficeLink.create({ data: { tenantId: HO, companyTenantId: A, createdById: users['ceo']!.id } })
  await delegate('opsDel', 'operations')
  await delegate('finDel', 'finance', ['tip_pool'])
  await delegate('mktDel', 'marketing')

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(authRoutes, { prefix: '/auth' })
    await api.register(tipPoolRoutes, { prefix: '/tip-pools' })
    await api.register(siteLayoutRoutes, { prefix: '/site-layouts' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  ;(DELEGATION_ENABLED as Record<string, boolean>)['storefront_publish'] = false
  await app?.close()
})

// ─── Logins ──────────────────────────────────────────────────────────────────

describe('staff logins', () => {
  const invite = (who: string, role: string, opts: { lens?: string } = {}) => call(who, 'POST', '/auth/staff/invite', {
    ...opts, payload: { name: `${role} ${++phoneN}`, email: `${role}.${phoneN}.${P}@gsfoods.pk`, phone: phone(), role },
  })
  let floorId = '', mgrId = '', ownInviteId = '', bLoginId = ''

  it('an HOD invites through the lens: pending in the LENS company, stamped with the head office, within childRoles', async () => {
    const floor = await invite('hodOps', 'cashier', { lens: A })
    expect(floor.statusCode, floor.body).toBe(201)
    floorId = floor.json().id
    const row = await prisma.user.findUniqueOrThrow({ where: { id: floorId }, select: { tenantId: true, accountStatus: true, viaHeadOfficeId: true, invitedById: true, tenantMemberships: { select: { tenantId: true } } } })
    expect(row).toMatchObject({ tenantId: A, accountStatus: 'pending', viaHeadOfficeId: HO, invitedById: users['hodOps']!.id })
    expect(row.tenantMemberships.map((m) => m.tenantId)).toEqual([A])

    const mgr = await invite('hodOps', 'foh_management', { lens: A })
    expect(mgr.statusCode, mgr.body).toBe(201)
    mgrId = mgr.json().id

    // Outside the HOD's own childRoles: refused, through the lens too.
    const owner = await invite('hodOps', 'owner', { lens: A })
    expect([owner.statusCode, code(owner)]).toEqual([403, 'ROLE_NOT_ALLOWED'])
    // A company the head office does not serve: the header is not honoured.
    const foreign = await invite('hodOps', 'cashier', { lens: B })
    expect(foreign.statusCode).toBe(403)

    // The delegate's own invite (for the separation-of-duties check below).
    const own = await invite('opsDel', 'cashier', { lens: A })
    expect(own.statusCode, own.body).toBe(201)
    ownInviteId = own.json().id

    // A plain company invite in B (no head office anywhere): unchanged.
    const bInvite = await prisma.user.create({
      data: { name: 'b floor', email: `bfloor.${P}@gsfoods.pk`, phone: phone(), password: 'x', role: 'cashier', tenantId: B, accountStatus: 'pending', isActive: true,
        invitedById: users['ownerB']!.id, tenantMemberships: { create: [{ tenantId: B }] } },
    })
    bLoginId = bInvite.id
  })

  it('the pending list: the delegate sees the floor logins of A they may decide, never a password login nor their own invite', async () => {
    const del = await call('opsDel', 'GET', '/auth/staff/pending')
    expect(del.statusCode, del.body).toBe(200)
    const ids = (del.json() as Array<{ id: string; viaHeadOfficeId: string | null }>).map((r) => r.id)
    expect(ids).toContain(floorId)
    expect(ids).not.toContain(mgrId)
    expect(ids).not.toContain(ownInviteId)
    expect(ids).not.toContain(bLoginId)
    // No hand-over, not the CEO → 403 (the inbox drops the type).
    expect((await call('hodOps', 'GET', '/auth/staff/pending')).statusCode).toBe(403)
    expect((await call('ownerA', 'GET', '/auth/staff/pending')).statusCode).toBe(403)
    // The CEO's list is today's: every pending login of their companies, with the stamp.
    const ceo = await call('ceo', 'GET', '/auth/staff/pending')
    const rows = ceo.json() as Array<{ id: string; viaHeadOfficeId: string | null }>
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([floorId, mgrId, ownInviteId]))
    expect(rows.find((r) => r.id === floorId)?.viaHeadOfficeId).toBe(HO)
  })

  it('an Operations delegate approves a floor login, not a manager login; never their own invite', async () => {
    const mgr = await call('opsDel', 'PATCH', `/auth/staff/${mgrId}/approve`, { payload: {} })
    expect([mgr.statusCode, code(mgr)]).toEqual([403, 'APPROVAL_NOT_YOURS'])
    const own = await call('opsDel', 'PATCH', `/auth/staff/${ownInviteId}/approve`, { payload: {} })
    expect([own.statusCode, code(own)]).toEqual([403, 'SELF_APPROVAL_BLOCKED'])

    const floor = await call('opsDel', 'PATCH', `/auth/staff/${floorId}/approve`, { payload: {} })
    expect(floor.statusCode, floor.body).toBe(200)
    expect(floor.json()).toMatchObject({ accountStatus: 'active' })
    const decide = await prisma.auditLog.findFirst({ where: { action: 'approval.decide', entityId: floorId } })
    expect(decide?.tenantId).toBe(A)
    expect(decide?.metadata).toMatchObject({ type: 'staff_login', decision: 'approve', via: 'delegation' })
    // Already decided → 409 for the delegate.
    const again = await call('opsDel', 'PATCH', `/auth/staff/${floorId}/approve`, { payload: {} })
    expect([again.statusCode, code(again)]).toEqual([409, 'NOT_PENDING'])
  })

  it('through-HO logins stay with the CEO: the company\'s own staff never decide them; the CEO does', async () => {
    const owner = await call('ownerA', 'PATCH', `/auth/staff/${mgrId}/approve`, { payload: {} })
    expect([owner.statusCode, code(owner)]).toEqual([403, 'APPROVAL_NOT_YOURS'])
    const ceo = await call('ceo', 'PATCH', `/auth/staff/${mgrId}/approve`, { payload: {} })
    expect(ceo.statusCode, ceo.body).toBe(200)
    expect((await prisma.auditLog.findFirst({ where: { action: 'approval.decide', entityId: mgrId } }))?.metadata).toMatchObject({ via: 'role' })
  })

  it('company B gets 404 on A\'s login; the delegate gets 404 on B\'s (not covered)', async () => {
    const r = await call('ownerB', 'PATCH', `/auth/staff/${ownInviteId}/reject`, { payload: {} })
    expect(r.statusCode).toBe(404)
    const d = await call('opsDel', 'PATCH', `/auth/staff/${bLoginId}/approve`, { payload: {} })
    expect(d.statusCode).toBe(404)
    const d2 = await call('opsDel', 'PATCH', `/auth/staff/${bLoginId}/reject`, { payload: {} })
    expect(d2.statusCode).toBe(404)
  })

  it('a delegate may reject a floor login (pending only); the CEO rejects the delegate\'s own invite', async () => {
    const pending = await call('hodOps', 'POST', '/auth/staff/invite', { lens: A, payload: { name: 'reject me', email: `rej.${P}@gsfoods.pk`, phone: phone(), role: 'kitchen' } })
    expect(pending.statusCode, pending.body).toBe(201)
    const id = pending.json().id
    const rej = await call('opsDel', 'PATCH', `/auth/staff/${id}/reject`, { payload: {} })
    expect(rej.statusCode, rej.body).toBe(200)
    expect(rej.json()).toMatchObject({ accountStatus: 'suspended' })
    expect((await call('opsDel', 'PATCH', `/auth/staff/${id}/reject`, { payload: {} })).statusCode).toBe(409)
    expect((await call('ceo', 'PATCH', `/auth/staff/${ownInviteId}/reject`, { payload: {} })).statusCode).toBe(200)
  })
})

// ─── Tip pools ───────────────────────────────────────────────────────────────

describe('tip pools', () => {
  const H = 3_600_000
  let n = 0
  async function pool(createdBy: string, tenantId = A) {
    const start = new Date(Date.now() - (100 + 10 * ++n) * H)
    const p = await prisma.tipPool.create({
      data: { tenantId, name: `${P} pool ${n}`, periodStart: start, periodEnd: new Date(start.getTime() + 8 * H), totalTipsCents: 30_000, status: 'draft', createdById: users[createdBy]!.id },
    })
    await prisma.tipPoolMember.create({ data: { poolId: p.id, userId: users[tenantId === A ? 'cashierA' : 'ownerB']!.id, userName: 'member', hoursWorked: 8, roleWeight: 1, shareUnits: 8 } })
    return p.id
  }

  it('a delegated post and pay book into the POOL\'s company', async () => {
    const id = await pool('mgmtA')
    const post = await call('finDel', 'POST', `/tip-pools/${id}/post`, { payload: {} })
    expect(post.statusCode, post.body).toBe(200)
    expect(post.json()).toMatchObject({ status: 'posted' })
    const pay = await call('finDel', 'POST', `/tip-pools/${id}/pay`, { payload: { paidFromAccountCode: '1010' } })
    expect(pay.statusCode, pay.body).toBe(200)
    const je = await prisma.journalEntry.findFirst({ where: { reference: `tippool.payout:${id}` }, select: { tenantId: true } })
    expect(je?.tenantId).toBe(A)
    const decided = await prisma.auditLog.findMany({ where: { action: 'approval.decide', entityId: id }, select: { tenantId: true, metadata: true } })
    expect(decided.map((d) => (d.metadata as { decision: string }).decision).sort()).toEqual(['pay', 'post'])
    expect(decided.every((d) => d.tenantId === A && (d.metadata as { via: string }).via === 'delegation')).toBe(true)
  })

  it('the delegate sees the pools handed to them on the list and the detail', async () => {
    const id = await pool('mgmtA')
    const list = await call('finDel', 'GET', '/tip-pools')
    expect(list.statusCode, list.body).toBe(200)
    expect((list.json() as Array<{ id: string }>).map((p) => p.id)).toContain(id)
    expect((await call('finDel', 'GET', `/tip-pools/${id}`)).statusCode).toBe(200)
    const bPool = await pool('ownerB', B)
    expect((await call('finDel', 'GET', `/tip-pools/${bPool}`)).statusCode).toBe(404)
  })

  it('a pool created through head office stays with the CEO (or that head office\'s delegate), never the company\'s owners', async () => {
    const id = await pool('dualFin')
    const owner = await call('ownerA', 'POST', `/tip-pools/${id}/post`, { payload: {} })
    expect([owner.statusCode, code(owner)]).toEqual([403, 'APPROVAL_NOT_YOURS'])
    const ceo = await call('ceo', 'POST', `/tip-pools/${id}/post`, { payload: {} })
    expect(ceo.statusCode, ceo.body).toBe(200)
  })

  it('separation of duties: the creator never posts their own pool; another owner may (today\'s role path)', async () => {
    const id = await pool('ownerA')
    const own = await call('ownerA', 'POST', `/tip-pools/${id}/post`, { payload: {} })
    expect([own.statusCode, code(own)]).toEqual([403, 'SELF_APPROVAL_BLOCKED'])
    const other = await call('ownerA2', 'POST', `/tip-pools/${id}/post`, { payload: {} })
    expect(other.statusCode, other.body).toBe(200)
  })

  it('company B gets 404 on A\'s pool; A\'s management (not an approver) gets 403', async () => {
    const id = await pool('mgmtA')
    expect((await call('ownerB', 'POST', `/tip-pools/${id}/post`, { payload: {} })).statusCode).toBe(404)
    expect((await call('ownerB', 'POST', `/tip-pools/${id}/pay`, { payload: {} })).statusCode).toBe(404)
    const mgmt = await call('mgmtA', 'POST', `/tip-pools/${id}/post`, { payload: {} })
    expect(mgmt.statusCode).toBe(403)
  })
})

// ─── Website changes ─────────────────────────────────────────────────────────

describe('storefront publishing', () => {
  const brandSlug = () => `brand:${brandA}`
  const pageSlug = () => `brand:${brandA}:offers`

  it('lens drafts only the lens company\'s rows: servd:* and another company are refused; submit stamps viaHeadOfficeId', async () => {
    const draft = await call('mktDel', 'PUT', `/site-layouts/${enc(pageSlug())}/draft`, { lens: A, payload: { blocks: blocks('ho') } })
    expect(draft.statusCode, draft.body).toBe(200)
    expect(draft.json()).toMatchObject({ tenantId: A, draftStatus: 'draft' })

    const shared = await call('mktDel', 'PUT', `/site-layouts/${enc('servd:press')}/draft`, { lens: A, payload: { blocks: blocks('no') } })
    expect([shared.statusCode, code(shared)]).toEqual([403, 'HEAD_OFFICE_SUBMIT_ONLY'])
    const other = await call('mktDel', 'PUT', `/site-layouts/${enc(`brand:${brandB}`)}/draft`, { lens: A, payload: { blocks: blocks('no') } })
    expect(other.statusCode).toBe(404)

    const sub = await call('mktDel', 'POST', `/site-layouts/${enc(pageSlug())}/submit`, { lens: A, payload: {} })
    expect(sub.statusCode, sub.body).toBe(200)
    const row = await prisma.siteLayout.findUniqueOrThrow({ where: { slug: pageSlug() } })
    expect(row).toMatchObject({ tenantId: A, draftStatus: 'pending', viaHeadOfficeId: HO, submittedById: users['mktDel']!.id })
  })

  it('a servd:* row through the lens: submit and discard refused', async () => {
    // The CEO drafts and submits a shared page (shared rows are everyone's outside the lens).
    expect((await call('mktA', 'PUT', `/site-layouts/${enc('servd:waitlist')}/draft`, { payload: { blocks: blocks('w') } })).statusCode).toBe(200)
    const sub = await call('mktDel', 'POST', `/site-layouts/${enc('servd:waitlist')}/submit`, { lens: A, payload: {} })
    expect([sub.statusCode, code(sub)]).toEqual([403, 'HEAD_OFFICE_SUBMIT_ONLY'])
    const del = await call('mktDel', 'DELETE', `/site-layouts/${enc('servd:waitlist')}/draft`, { lens: A })
    expect([del.statusCode, code(del)]).toEqual([403, 'HEAD_OFFICE_SUBMIT_ONLY'])
    expect((await call('mktA', 'POST', `/site-layouts/${enc('servd:waitlist')}/submit`, { payload: {} })).statusCode).toBe(200)
  })

  it('switched off (today): only the CEO decides; the delegate and the company\'s marketer get 403', async () => {
    expect((await call('mktA', 'PUT', `/site-layouts/${enc(brandSlug())}/draft`, { payload: { blocks: blocks('a') } })).statusCode).toBe(200)
    expect((await call('mktA', 'POST', `/site-layouts/${enc(brandSlug())}/submit`, { payload: {} })).statusCode).toBe(200)
    const del = await call('mktDel', 'POST', `/site-layouts/${enc(brandSlug())}/approve`, { payload: {} })
    expect([del.statusCode, code(del)]).toEqual([403, 'APPROVAL_NOT_YOURS'])
    const mkt = await call('mktA', 'POST', `/site-layouts/${enc(brandSlug())}/approve`, { payload: {} })
    expect(mkt.statusCode).toBe(403)
    // B never sees A's page.
    expect((await call('ownerB', 'POST', `/site-layouts/${enc(brandSlug())}/reject`, { payload: { note: 'no' } })).statusCode).toBe(404)
    // The delegate's queue holds nothing of A while switched off.
    const q = await call('mktDel', 'GET', '/site-layouts?status=pending')
    expect((q.json() as Array<{ slug: string }>).map((r) => r.slug)).not.toContain(brandSlug())
  })

  it('switched on: the Marketing delegate decides a company brand page — never a servd:* page, never their own, never rollback', async () => {
    ;(DELEGATION_ENABLED as Record<string, boolean>)['storefront_publish'] = true
    try {
      const q = await call('mktDel', 'GET', '/site-layouts?status=pending')
      expect((q.json() as Array<{ slug: string }>).map((r) => r.slug)).toContain(brandSlug())

      const ok = await call('mktDel', 'POST', `/site-layouts/${enc(brandSlug())}/approve`, { payload: {} })
      expect(ok.statusCode, ok.body).toBe(200)
      expect(ok.json()).toMatchObject({ liveVersion: 1, draftStatus: 'none' })
      expect((await prisma.auditLog.findFirst({ where: { action: 'approval.decide', metadata: { path: ['type'], equals: 'storefront_publish' }, tenantId: A } }))?.metadata)
        .toMatchObject({ decision: 'approve', via: 'delegation' })

      const shared = await call('mktDel', 'POST', `/site-layouts/${enc('servd:waitlist')}/approve`, { payload: {} })
      expect(shared.statusCode).toBeGreaterThanOrEqual(403)
      expect(shared.statusCode).toBeLessThanOrEqual(404)
      expect((await prisma.siteLayout.findUniqueOrThrow({ where: { slug: 'servd:waitlist' } })).liveVersion).toBe(0)

      const own = await call('mktDel', 'POST', `/site-layouts/${enc(pageSlug())}/approve`, { payload: {} })
      expect([own.statusCode, code(own)]).toEqual([403, 'SELF_APPROVAL_BLOCKED'])

      const rb = await call('mktDel', 'POST', `/site-layouts/${enc(brandSlug())}/rollback`, { payload: { version: 1 } })
      expect(rb.statusCode).toBe(403)
      expect((await call('mktDel', 'DELETE', `/site-layouts/${enc(brandSlug())}`)).statusCode).toBe(403)
    } finally {
      ;(DELEGATION_ENABLED as Record<string, boolean>)['storefront_publish'] = false
    }
    // The CEO decides the shared page and the delegate's own submission.
    expect((await call('ceo', 'POST', `/site-layouts/${enc('servd:waitlist')}/approve`, { payload: {} })).statusCode).toBe(200)
    expect((await call('ceo', 'POST', `/site-layouts/${enc(pageSlug())}/reject`, { payload: { note: 'Not yet' } })).statusCode).toBe(200)
  })
})

// ─── Company separation ─────────────────────────────────────────────────────

describe('no row carries the head office\'s company', () => {
  it('logins, pools, journal entries and pages made through head office belong to the companies they serve', async () => {
    expect(await prisma.user.count({ where: { tenantId: HO, invitedById: { not: null } } })).toBe(0)
    expect(await prisma.tipPool.count({ where: { tenantId: HO } })).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: HO } })).toBe(0)
    expect(await prisma.siteLayout.count({ where: { tenantId: HO } })).toBe(0)
    expect(await prisma.tenantMember.count({ where: { tenantId: HO, user: { invitedById: { not: null } } } })).toBe(0)
  })
})
