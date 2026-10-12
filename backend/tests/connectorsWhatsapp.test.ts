// W2 — Dev → API: the WhatsApp connector routes and the sidebar ⇔ API rule.
//
//   - /auth/integrations/whatsapp* keep their paths; roles are CONNECTOR_ADMINS
//     (admin, it — `it` was 403 before); everyone else 403.
//   - PUT stores the key as `enc:v1:`; GET never returns it, only a hint, and
//     says `scope: 'platform'` (one gateway for every company). Without
//     SERVD_SECRET_KEY a new key is 503 SECRET_KEY_MISSING.
//   - The sidebar and the API agree (audit PPL-08) for the three new modules:
//     a role reaches api_whatsapp / api_pos / voided_prebills exactly when its
//     default modules hold it; the CEO's per-user deny closes /connectors and
//     /pre-bills; the till's pre-bill routes are never module-gated.
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'

vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return { ...real, sendText: vi.fn(async () => undefined) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError, errorResponse } = await import('../src/lib/errors.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { registerConnectorPlugins } = await import('../src/modules/connectors/index.js')
const { registerPreBillPlugins } = await import('../src/modules/prebills/index.js')
const { ALL_ROLES } = await import('../src/lib/roles.js')
const {
  DEFAULT_MODULE_ACCESS, enforceModuleAccess, applyModuleGrants, MODULE_GRANTS, MODULE_GRANTS_MARKER_KEY,
  rolesGrantedByDefault, effectiveModulesForUser, invalidateModuleAccessCache,
} = await import('../src/lib/moduleAccess.js')
const { WA_URL_KEY, WA_KEY_KEY, invalidateWhatsappConfig } = await import('../src/lib/whatsapp.js')
const { decryptSecret } = await import('../src/lib/secretBox.js')

const TEST_KEY = Buffer.alloc(32, 5).toString('base64')
const SECRET = 'sk-gateway-SECRET-0123456789abcdefghij'
const stamp = Date.now()
let app: FastifyInstance
let tenantA: string
let tenantB: string
const tokens: Record<string, string> = {}
const prevSecretKey = process.env['SERVD_SECRET_KEY']

async function mkUser(key: string, role: string, tenantId: string, extra: { moduleDeny?: string[] } = {}) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.${stamp}@w2conn.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as UserRole, isActive: true, accountStatus: 'active', tenantId, moduleDeny: extra.moduleDeny ?? [],
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  tokens[key] = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
}
const call = (who: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: tokens[who]! } })

beforeAll(async () => {
  process.env['SERVD_SECRET_KEY'] = TEST_KEY
  tenantA = (await prisma.tenant.create({ data: { name: 'W2 Co A', slug: `w2-a-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'W2 Co B', slug: `w2-b-${stamp}` } })).id
  for (const role of ALL_ROLES) await mkUser(role, role, tenantA)
  await mkUser('itB', 'it', tenantB)
  await mkUser('itDenied', 'it', tenantA, { moduleDeny: ['api_pos'] })
  await mkUser('financeDenied', 'finance', tenantA, { moduleDeny: ['voided_prebills'] })
  await mkUser('itWaDenied', 'it', tenantA, { moduleDeny: ['api_whatsapp'] })
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(authRoutes, { prefix: '/auth' })
    await registerConnectorPlugins(api)
    await registerPreBillPlugins(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY] } } })
  invalidateWhatsappConfig()
  if (prevSecretKey === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = prevSecretKey
})

describe('WhatsApp connector routes (/auth/integrations/whatsapp*)', () => {
  it('it can now read and save (was CEO only); cashier, management and owner get 403', async () => {
    expect((await call('it', 'GET', '/auth/integrations/whatsapp')).statusCode).toBe(200)
    expect((await call('admin', 'GET', '/auth/integrations/whatsapp')).statusCode).toBe(200)
    for (const r of ['cashier', 'management', 'owner', 'finance', 'foh_management']) {
      expect((await call(r, 'GET', '/auth/integrations/whatsapp')).statusCode, r).toBe(403)
      expect((await call(r, 'PUT', '/auth/integrations/whatsapp', { apiUrl: 'https://gw.example/x/send' })).statusCode, r).toBe(403)
      expect((await call(r, 'POST', '/auth/integrations/whatsapp/test', { phone: '03001234567' })).statusCode, r).toBe(403)
    }
    expect((await call('it', 'POST', '/auth/integrations/whatsapp/test', { phone: '03001234567' })).json()).toMatchObject({ ok: true })
  })

  it('PUT by it stores the key encrypted; GET returns only a hint and scope platform', async () => {
    const put = await call('it', 'PUT', '/auth/integrations/whatsapp', { apiUrl: 'https://gw.example/webhook/live/send', apiKey: SECRET })
    expect(put.statusCode).toBe(200)
    const raw = (await prisma.setting.findUniqueOrThrow({ where: { key: WA_KEY_KEY } })).value
    expect(raw.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecret(raw)).toBe(SECRET)

    const get = await call('it', 'GET', '/auth/integrations/whatsapp')
    expect(get.json()).toMatchObject({
      apiUrl: 'https://gw.example/webhook/live/send', apiKeyHint: 'sk-g…ghij',
      source: 'database', configured: true, scope: 'platform', keyAtRest: 'encrypted',
    })
    expect(get.body).not.toContain(SECRET)
    expect(get.body).not.toContain(raw)

    // The audit row records that the key changed, never the key.
    const audit = await prisma.auditLog.findFirst({ where: { action: 'integrations.whatsapp.update' }, orderBy: { createdAt: 'desc' } })
    expect(audit).not.toBeNull()
    expect(JSON.stringify(audit)).not.toContain(SECRET)
  })

  it('platform-wide: another company\'s IT sees the same single gateway', async () => {
    const b = await call('itB', 'GET', '/auth/integrations/whatsapp')
    expect(b.statusCode).toBe(200)
    expect(b.json()).toMatchObject({ apiUrl: 'https://gw.example/webhook/live/send', scope: 'platform' })
  })

  it('without SERVD_SECRET_KEY a new key is 503 SECRET_KEY_MISSING and nothing changes', async () => {
    const before = (await prisma.setting.findUniqueOrThrow({ where: { key: WA_KEY_KEY } })).value
    delete process.env['SERVD_SECRET_KEY']
    try {
      const r = await call('admin', 'PUT', '/auth/integrations/whatsapp', { apiUrl: 'https://gw.example/webhook/other/send', apiKey: 'sk-other' })
      expect(r.statusCode).toBe(503)
      expect(r.json().error.code).toBe('SECRET_KEY_MISSING')
    } finally {
      process.env['SERVD_SECRET_KEY'] = TEST_KEY
    }
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: WA_KEY_KEY } })).value).toBe(before)
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: WA_URL_KEY } })).value).toBe('https://gw.example/webhook/live/send')
  })

  it('delivery status: managers and it read it; check-now is CONNECTOR_ADMINS', async () => {
    expect((await call('it', 'GET', '/auth/integrations/delivery-status')).statusCode).toBe(200)
    expect((await call('foh_management', 'GET', '/auth/integrations/delivery-status')).statusCode).toBe(200)
    expect((await call('cashier', 'GET', '/auth/integrations/delivery-status')).statusCode).toBe(403)
    expect((await call('foh_management', 'POST', '/auth/integrations/delivery-status/check')).statusCode).toBe(403)
    expect((await call('management', 'POST', '/auth/integrations/delivery-status/check')).statusCode).toBe(403)
  })
})

describe('sidebar ⇔ API for the new modules (PPL-08)', () => {
  /** The read behind each module's page. */
  const MODULE_READS: Record<string, string> = {
    api_whatsapp: '/auth/integrations/whatsapp',
    api_pos: '/connectors',
    voided_prebills: '/pre-bills',
  }

  it('every role reaches each page exactly when its default modules hold it', async () => {
    const mismatches: string[] = []
    for (const role of ALL_ROLES) {
      for (const [mod, path] of Object.entries(MODULE_READS)) {
        const holds = role === 'admin' || (DEFAULT_MODULE_ACCESS[role] ?? []).includes(mod)
        const r = await call(role, 'GET', path)
        if (holds ? r.statusCode !== 200 : r.statusCode !== 403) mismatches.push(`${role} ${mod} ${path} → ${r.statusCode}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('the CEO\'s per-user deny is the control for /connectors and /pre-bills', async () => {
    expect((await call('itDenied', 'GET', '/connectors')).statusCode).toBe(403)
    expect((await call('it', 'GET', '/connectors')).statusCode).toBe(200)
    expect((await call('financeDenied', 'GET', '/pre-bills')).statusCode).toBe(403)
    expect((await call('finance', 'GET', '/pre-bills')).statusCode).toBe(200)
  })

  it('the CEO\'s per-user deny closes the WhatsApp gateway routes too (W2-R1), not the delivery banner', async () => {
    const before = (await prisma.setting.findUnique({ where: { key: WA_URL_KEY } }))?.value ?? null
    expect((await call('itWaDenied', 'GET', '/auth/integrations/whatsapp')).statusCode).toBe(403)
    expect((await call('itWaDenied', 'PUT', '/auth/integrations/whatsapp', { apiUrl: 'https://attacker.example/webhook/x/send' })).statusCode).toBe(403)
    expect((await call('itWaDenied', 'POST', '/auth/integrations/whatsapp/test', { phone: '03001234567' })).statusCode).toBe(403)
    // Nothing moved: the one platform gateway still points where it did.
    expect((await prisma.setting.findUnique({ where: { key: WA_URL_KEY } }))?.value ?? null).toBe(before)
    // The same user keeps the managers' delivery banner and the POS connector.
    expect((await call('itWaDenied', 'GET', '/auth/integrations/delivery-status')).statusCode).toBe(200)
    expect((await call('itWaDenied', 'GET', '/connectors')).statusCode).toBe(200)
    // A role override without the module closes it for the whole role.
    await prisma.roleModuleAccess.create({ data: { role: 'it', modules: ['api_pos', 'integrations'] } })
    invalidateModuleAccessCache()
    try {
      expect((await call('it', 'GET', '/auth/integrations/whatsapp')).statusCode).toBe(403)
      expect((await call('it', 'GET', '/connectors')).statusCode).toBe(200)
    } finally {
      await prisma.roleModuleAccess.deleteMany({ where: { role: 'it' } })
      invalidateModuleAccessCache()
    }
    expect((await call('it', 'GET', '/auth/integrations/whatsapp')).statusCode).toBe(200)
  })

  it('the till\'s pre-bill and card/fiscal routes are never module-gated', async () => {
    const deny = ['voided_prebills', 'api_pos', 'api_whatsapp']
    for (const url of [
      '/api/v1/pos/orders/o1/pre-bill', '/api/v1/pos/pre-bills/p1/html',
      '/api/v1/pos/terminal/charges', '/api/v1/pos/orders/o1/fiscal', '/api/v1/webhooks/pos/tok',
    ]) {
      await expect(enforceModuleAccess(url, { role: 'cashier', moduleDeny: deny }), url).resolves.toBeUndefined()
    }
    await expect(enforceModuleAccess('/api/v1/connectors/fiscal/documents', { role: 'management', moduleDeny: ['api_pos'] })).rejects.toThrow(/module/)
    await expect(enforceModuleAccess('/api/v1/pre-bills?format=csv', { role: 'owner', moduleDeny: ['voided_prebills'] })).rejects.toThrow(/module/)
  })
})

describe('new default modules reach saved Module Access rows once (W2-R3)', () => {
  it('grants go to exactly the roles whose defaults hold them', () => {
    expect(rolesGrantedByDefault('api_pos').sort()).toEqual(['it', 'management'])
    expect(rolesGrantedByDefault('api_whatsapp')).toEqual(['it'])
    expect(rolesGrantedByDefault('voided_prebills').sort()).toEqual(['finance', 'management', 'owner'])
    for (const m of MODULE_GRANTS) expect(rolesGrantedByDefault(m).length, m).toBeGreaterThan(0)
  })

  it('appends to saved rows once; a later CEO untick sticks; roles without a row are untouched', async () => {
    const roles = ['it', 'finance', 'management', 'foh_management'] as UserRole[]
    const saved = await prisma.roleModuleAccess.findMany({ where: { role: { in: roles } } })
    const marker = await prisma.setting.findUnique({ where: { key: MODULE_GRANTS_MARKER_KEY } })
    await prisma.roleModuleAccess.deleteMany({ where: { role: { in: roles } } })
    await prisma.setting.deleteMany({ where: { key: MODULE_GRANTS_MARKER_KEY } })
    try {
      // Rows the CEO saved before the connector shipped.
      await prisma.roleModuleAccess.createMany({ data: [
        { role: 'it', modules: ['integrations', 'audit_log'] },
        { role: 'finance', modules: ['finance_pl', 'accounting', 'voided_prebills'] },
        { role: 'foh_management', modules: ['dashboard', 'pos'] },
      ] })
      invalidateModuleAccessCache()
      const first = await applyModuleGrants()
      expect([...first.applied].sort()).toEqual([...MODULE_GRANTS].sort())
      expect([...first.roles].sort()).toEqual(['it'])   // finance already held it
      invalidateModuleAccessCache()
      expect((await effectiveModulesForUser({ role: 'it' as UserRole })).has('api_pos')).toBe(true)
      expect((await call('it', 'GET', '/connectors')).statusCode).toBe(200)
      expect((await call('it', 'GET', '/auth/integrations/whatsapp')).statusCode).toBe(200)
      expect((await applyModuleGrants()).applied).toEqual([])   // once

      const rowOf = async (role: UserRole) => (await prisma.roleModuleAccess.findUnique({ where: { role } }))?.modules ?? null
      expect((await rowOf('it'))!.sort()).toEqual(['api_pos', 'api_whatsapp', 'audit_log', 'integrations'])
      // Already held: not duplicated.
      expect((await rowOf('finance'))!.filter((m) => m === 'voided_prebills')).toHaveLength(1)
      // Not a grantee: unchanged. No row: still no row (defaults apply).
      expect(await rowOf('foh_management')).toEqual(['dashboard', 'pos'])
      expect(await rowOf('management')).toBeNull()
      const marked = await prisma.setting.findUniqueOrThrow({ where: { key: MODULE_GRANTS_MARKER_KEY } })
      expect(JSON.parse(marked.value).sort()).toEqual([...MODULE_GRANTS].sort())

      // The CEO unticks it afterwards: a re-run does not put it back.
      await prisma.roleModuleAccess.update({ where: { role: 'it' }, data: { modules: ['integrations'] } })
      expect((await applyModuleGrants()).applied).toEqual([])
      expect(await rowOf('it')).toEqual(['integrations'])
      invalidateModuleAccessCache()
      expect((await call('it', 'GET', '/connectors')).statusCode).toBe(403)

      // Fresh marker, concurrent runs: each row gains each module once.
      await prisma.setting.deleteMany({ where: { key: MODULE_GRANTS_MARKER_KEY } })
      const [a, b] = await Promise.all([applyModuleGrants(), applyModuleGrants()])
      expect(a.applied.length + b.applied.length).toBeGreaterThan(0)
      const it2 = (await rowOf('it'))!
      expect(it2.filter((m) => m === 'api_pos')).toHaveLength(1)
      expect(it2.filter((m) => m === 'api_whatsapp')).toHaveLength(1)
    } finally {
      await prisma.roleModuleAccess.deleteMany({ where: { role: { in: roles } } })
      for (const r of saved) await prisma.roleModuleAccess.create({ data: { role: r.role, modules: r.modules } })
      await prisma.setting.deleteMany({ where: { key: MODULE_GRANTS_MARKER_KEY } })
      if (marker) await prisma.setting.create({ data: { key: marker.key, value: marker.value } })
      invalidateModuleAccessCache()
    }
  })
})
