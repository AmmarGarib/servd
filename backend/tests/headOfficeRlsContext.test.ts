// Head office (D1, spec §6.5): the request's RLS context must always hold the
// company being touched — and nothing more. The test database has no
// policies, so these assert the CONTEXT itself (lib/rlsContext.ts) after the
// auth middleware and after the helpers, on every path:
//   GET single (lens), GET portfolio, submit, passthrough, an ordinary write,
//   widenRls (what assertCanApprove calls on a proven right), and
//   appendRlsTenantIds outside a request.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { requireAuth } from '../src/modules/auth/middleware.js'
import { AppError } from '../src/lib/errors.js'
import { runWithRlsContext, getRlsContext, appendRlsTenantIds } from '../src/lib/rlsContext.js'
import { widenRls } from '../src/lib/headOffice.js'

const P = `horls-${Date.now()}`
let app: FastifyInstance
let HO: string, A: string, B: string, X: string
const tokens: Record<string, string> = {}

async function mkUser(key: string, role: UserRole, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  tokens[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
  return u.id
}

const rlsNow = () => [...(getRlsContext()?.tenantIds ?? [])].sort()
const sortIds = (...ids: string[]) => [...ids].sort()

function call(who: string, method: 'GET' | 'POST' | 'PUT', url: string, h: { lens?: string; portfolio?: boolean } = {}) {
  return app.inject({
    method, url: `/api/v1${url}`,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(h.lens ? { 'x-servd-active-tenant': h.lens } : {}),
      ...(h.portfolio ? { 'x-servd-portfolio': '1' } : {}),
    },
    ...(method === 'GET' ? {} : { payload: {} }),
  })
}

beforeAll(async () => {
  const mk = async (name: string, kind: 'company' | 'head_office') =>
    (await prisma.tenant.create({ data: { name, slug: `${P}-${name.toLowerCase().replace(/\W+/g, '-')}`, kind } })).id
  HO = await mk('HO', 'head_office')
  A = await mk('Co A', 'company')
  B = await mk('Co B', 'company')
  X = await mk('Co X', 'company')
  const hod = await mkUser('hod', 'finance', HO, [HO])
  await mkUser('mem', 'finance', B, [B, X])
  await prisma.headOfficeLink.create({ data: { tenantId: HO, companyTenantId: A, createdById: hod } })

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => reply.status((err as AppError).statusCode ?? 500).send({ error: { code: (err as AppError).code } }))
  await app.register(async (api) => {
    const auth = { preHandler: requireAuth() }
    const rls = async () => ({ rls: rlsNow() })
    api.get('/probe/rls', auth, rls)
    api.post('/probe/rls', auth, rls)                       // ordinary write
    api.put('/recipes/:id', auth, rls)                      // HO_SUBMIT_ROUTES
    api.post('/hr/payroll/runs/:id/approve', auth, rls)     // HO_PASSTHROUGH (approval)
    api.post<{ Body: unknown }>('/probe/widen', auth, async (req: FastifyRequest) => {
      const before = rlsNow()
      widenRls(req, [A, A, ''])
      const after = rlsNow()
      widenRls(req, [])
      return { before, after, again: rlsNow() }
    })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('RLS context after the auth middleware', () => {
  it('GET single, own company: [primary]', async () => {
    expect((await call('hod', 'GET', '/probe/rls')).json().rls).toEqual([HO])
  })

  it('GET single through the lens: [the reached company] only', async () => {
    expect((await call('hod', 'GET', '/probe/rls', { lens: A })).json().rls).toEqual([A])
  })

  it('GET portfolio: members ∪ reach', async () => {
    expect((await call('hod', 'GET', '/probe/rls', { portfolio: true })).json().rls).toEqual(sortIds(HO, A))
  })

  it('submit route through the lens: members ∪ [submitTenantId]', async () => {
    expect((await call('hod', 'PUT', '/recipes/r1', { lens: A })).json().rls).toEqual(sortIds(HO, A))
  })

  it('passthrough route with the lens header: members only (the approve guard widens later, if proven)', async () => {
    expect((await call('hod', 'POST', '/hr/payroll/runs/p1/approve', { lens: A })).json().rls).toEqual([HO])
  })

  it('an ordinary write without a header: members only — reach never reaches a write', async () => {
    expect((await call('hod', 'POST', '/probe/rls')).json().rls).toEqual([HO])
    expect((await call('hod', 'POST', '/probe/rls', { portfolio: true })).json().rls).toEqual([HO])
  })

  it('no head office: exactly today\'s context (GET single = primary; write and portfolio = every member)', async () => {
    expect((await call('mem', 'GET', '/probe/rls')).json().rls).toEqual([B])
    expect((await call('mem', 'GET', '/probe/rls', { portfolio: true })).json().rls).toEqual(sortIds(B, X))
    expect((await call('mem', 'POST', '/probe/rls')).json().rls).toEqual(sortIds(B, X))
    expect((await call('mem', 'GET', '/probe/rls', { lens: X })).json().rls).toEqual([X])
  })
})

describe('widenRls / appendRlsTenantIds', () => {
  it('widenRls appends (deduped, empty ids ignored) and never narrows', async () => {
    const b = (await call('hod', 'POST', '/probe/widen')).json()
    expect(b.before).toEqual([HO])
    expect(b.after).toEqual(sortIds(HO, A))
    expect(b.again).toEqual(sortIds(HO, A))
  })

  it('appendRlsTenantIds is a no-op outside a request and keeps order inside one', () => {
    expect(() => appendRlsTenantIds(['t1'])).not.toThrow()
    expect(getRlsContext()).toBeUndefined()
    runWithRlsContext({ tenantIds: ['t2'] }, () => {
      appendRlsTenantIds(['t1', 't2', 't3'])
      expect(getRlsContext()!.tenantIds).toEqual(['t2', 't1', 't3'])
    })
    runWithRlsContext({}, () => {
      appendRlsTenantIds(['t9'])
      expect(getRlsContext()!.tenantIds).toEqual(['t9'])
    })
  })

  // lib/approvalRights.ts (stream HO-B2) calls widenRls on success; its
  // tests own these once it lands.
  it.todo('delegated approve widens to the item\'s companies (approvalRights.assertCanApprove)')
  it.todo('HR non-final step through reach widens to rec.tenantId (decideRight)')
  it.todo('approvalQueueTenantIds widens to the delegation-covered companies it returns')
})
