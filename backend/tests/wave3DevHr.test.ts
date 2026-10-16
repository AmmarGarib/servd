// Wave 3 (role <-> route alignment), stream C.
//
//   UI-08 — IT owns the Dev workspace (lib/workspaces.ts ownerRoles) and holds
//           `integrations` + `notifications` + `api_whatsapp` by default
//           (lib/moduleAccess.ts), yet the Webhooks, Email, WhatsApp and
//           Notifications pages answered 403. IT now reads and runs them;
//           secrets come back as hints/flags only; company B's IT never sees
//           or touches company A's webhooks or staff devices.
//           Review fixes: email (SMTP) is READ-only for IT — saving and the
//           test send stay the CEO's (W3C-RV-1: a host change would carry the
//           stored password to IT's server); the CEO's Module Access untick /
//           a per-login moduleDeny really closes webhooks, push and the email
//           read (W3C-RV-2); a broadcast says which company it reached and
//           how many devices in the sender's other companies it skipped
//           (W3C-RV-4).
//   UI-09 — HR holds `staff_directory` but GET /auth/users (the Workforce
//           list) refused it. HR now READS the list, scoped to its own
//           companies; every write on a login stays the CEO's.
//
// Real route handlers through Fastify inject with the real auth middleware;
// needs the disposable test DB (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

// No real messages, no real DNS, no real push.
vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return { ...real, sendText: vi.fn(async () => undefined) }
})
const sentEmails: string[] = []
vi.mock('../src/lib/mailer.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/mailer.js')>()
  return { ...real, sendEmail: vi.fn(async (m: { to: string }) => { sentEmails.push(m.to) }) }
})
vi.mock('dns', async (orig) => {
  const real = await orig<typeof import('dns')>()
  const lookup = async (host: string, opts?: unknown) =>
    host.endsWith('.hooks-w3c.example') ? [{ address: '93.184.216.34', family: 4 }] : (real.promises.lookup as (h: string, o?: unknown) => unknown)(host, opts)
  return { ...real, default: { ...real, promises: { ...real.promises, lookup } }, promises: { ...real.promises, lookup } }
})
const pushed: string[] = []
vi.mock('expo-server-sdk', () => {
  class Expo {
    static isExpoPushToken(t: string) { return t.startsWith('ExponentPushToken[') }
    chunkPushNotifications<T>(m: T[]): T[][] { return [m] }
    async sendPushNotificationsAsync(chunk: Array<{ to: string }>) {
      for (const m of chunk) pushed.push(m.to)
      return chunk.map(() => ({ status: 'ok' as const, id: 'x' }))
    }
  }
  return { Expo, default: { Expo } }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { webhookManagementRoutes } = await import('../src/modules/webhooks/routes.js')
const { notificationRoutes } = await import('../src/modules/notifications/routes.js')
const { DEFAULT_MODULE_ACCESS } = await import('../src/lib/moduleAccess.js')

const stamp = Date.now()
const P = `w3c${stamp}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}

async function mkUser(key: string, role: string, tenants: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@w3c.pk`, password: await bcrypt.hash('x-Password-1', 4),
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
const call = (key: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: auth(key), ...(payload !== undefined ? { payload: payload as never } : {}) })

let hookA = ''
let hookB = ''

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} GS Foods`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Other Co`, slug: `${P}-b` } })).id
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('itA', 'it', [T.A])
  await mkUser('itB', 'it', [T.B])
  await mkUser('hrA', 'hr', [T.A])
  await mkUser('hrB', 'hr', [T.B])
  await mkUser('hrNone', 'hr', [])
  await mkUser('cashierA', 'cashier', [T.A])
  await mkUser('marketingA', 'marketing', [T.A])
  await mkUser('financeA', 'finance', [T.A])
  await mkUser('ownerA', 'owner', [T.A])
  await mkUser('cookA', 'kitchen', [T.A])
  await mkUser('cookB', 'kitchen', [T.B])
  await mkUser('headOffice', 'procurement', [T.A, T.B])
  await mkUser('itAB', 'it', [T.A, T.B])
  await mkUser('itDenied', 'it', [T.A], { moduleDeny: ['integrations', 'notifications', 'api_whatsapp'] })
  await mkUser('itNoWa', 'it', [T.A], { moduleDeny: ['api_whatsapp'] })
  await mkUser('bohMgrA', 'boh_management', [T.A])
  await mkUser('fohMgrA', 'foh_management', [T.A])

  hookA = (await prisma.webhookSubscription.create({
    data: { tenantId: T.A, url: 'https://a.hooks-w3c.example/in', events: ['order.placed'], secret: 'secret-of-company-a-0123456789' },
  })).id
  hookB = (await prisma.webhookSubscription.create({
    data: { tenantId: T.B, url: 'https://b.hooks-w3c.example/in', events: ['order.placed'], secret: 'secret-of-company-b-0123456789' },
  })).id

  await prisma.expoPushToken.createMany({
    data: [
      { userId: U.cookA!.id, token: `ExponentPushToken[${P}-a]`, platform: 'android', device: 'tablet' },
      { userId: U.cookB!.id, token: `ExponentPushToken[${P}-b]`, platform: 'android', device: 'tablet' },
      { userId: U.headOffice!.id, token: `ExponentPushToken[${P}-ho]`, platform: 'ios', device: 'mobile' },
    ],
  })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.register(webhookManagementRoutes, { prefix: '/api/v1/webhooks' })
  await app.register(notificationRoutes, { prefix: '/api/v1/notifications' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('UI-08 IT runs the Dev workspace', () => {
  it('IT holds the modules behind these pages, so every page read answers 200', async () => {
    for (const m of ['integrations', 'notifications', 'api_whatsapp']) expect(DEFAULT_MODULE_ACCESS.it).toContain(m)
    for (const url of ['/webhooks/endpoints', '/webhooks/events', '/webhooks/deliveries', '/notifications/tokens', '/auth/integrations/email', '/auth/integrations/whatsapp']) {
      expect((await call('itA', 'GET', url)).statusCode, url).toBe(200)
    }
  })

  it('roles outside the Dev workspace keep the 403', async () => {
    for (const who of ['cashierA', 'marketingA', 'financeA', 'hrA']) {
      for (const url of ['/webhooks/endpoints', '/notifications/tokens', '/auth/integrations/email', '/auth/integrations/whatsapp']) {
        expect((await call(who, 'GET', url)).statusCode, `${who} ${url}`).toBe(403)
      }
      expect((await call(who, 'PUT', '/auth/integrations/email', { host: 'x', port: '1', user: 'x', from: 'x' })).statusCode, who).toBe(403)
    }
    // The owner was never on the email screen and still is not (CONNECTOR_ADMINS).
    expect((await call('ownerA', 'GET', '/auth/integrations/email')).statusCode).toBe(403)
  })

  it('webhooks: IT lists only its company, never the signing secret', async () => {
    const a = (await call('itA', 'GET', '/webhooks/endpoints')).json() as Array<Record<string, unknown>>
    expect(a.map((h) => h.id)).toContain(hookA)
    expect(a.map((h) => h.id)).not.toContain(hookB)
    for (const h of a) expect(h).not.toHaveProperty('secret')
    const b = (await call('itB', 'GET', '/webhooks/endpoints')).json() as Array<{ id: string }>
    expect(b.map((h) => h.id)).toContain(hookB)
    expect(b.map((h) => h.id)).not.toContain(hookA)
  })

  it('webhooks: company B\'s IT gets 404 on company A\'s endpoint (edit, test, delete)', async () => {
    expect((await call('itB', 'PATCH', `/webhooks/endpoints/${hookA}`, { isActive: false })).statusCode).toBe(404)
    expect((await call('itB', 'POST', `/webhooks/endpoints/${hookA}/test`, {})).statusCode).toBe(404)
    expect((await call('itB', 'DELETE', `/webhooks/endpoints/${hookA}`)).statusCode).toBe(404)
    const deliveries = (await call('itB', 'GET', `/webhooks/deliveries?subscriptionId=${hookA}`)).json() as unknown[]
    expect(deliveries).toEqual([])
    const still = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: hookA } })
    expect(still.isActive).toBe(true)
    expect(still.deletedAt).toBeNull()
  })

  it('webhooks: IT edits its own, and a new endpoint binds to the ACTIVE company', async () => {
    const patched = await call('itA', 'PATCH', `/webhooks/endpoints/${hookA}`, { notes: 'accountant feed' })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).not.toHaveProperty('secret')

    const created = await call('itB', 'POST', '/webhooks/endpoints', { url: 'https://new.hooks-w3c.example/in', events: ['order.placed'] })
    expect(created.statusCode).toBe(201)
    const row = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: created.json().id as string } })
    expect(row.tenantId).toBe(T.B)
    // Shown once at creation; the list never carries it.
    expect(typeof created.json().secret).toBe('string')
    expect(((await call('itA', 'GET', '/webhooks/endpoints')).json() as Array<{ id: string }>).map((h) => h.id)).not.toContain(row.id)

    // The SSRF guard still runs for IT.
    expect((await call('itA', 'POST', '/webhooks/endpoints', { url: 'https://127.0.0.1/x', events: ['order.placed'] })).statusCode).toBe(400)
  })

  it('notifications: IT sees its company\'s staff devices only', async () => {
    const a = (await call('itA', 'GET', '/notifications/tokens')).json() as Array<{ userId: string }>
    const aUsers = a.map((r) => r.userId)
    expect(aUsers).toContain(U.cookA!.id)
    expect(aUsers).toContain(U.headOffice!.id)   // a member of A as well
    expect(aUsers).not.toContain(U.cookB!.id)
    const b = (await call('itB', 'GET', '/notifications/tokens')).json() as Array<{ userId: string }>
    expect(b.map((r) => r.userId)).toContain(U.cookB!.id)
    expect(b.map((r) => r.userId)).not.toContain(U.cookA!.id)
    // No token value ever leaves the server.
    expect(JSON.stringify(a)).not.toContain('ExponentPushToken')
  })

  it('notifications: a broadcast reaches the sender\'s active company only', async () => {
    pushed.length = 0
    const r = await call('itA', 'POST', '/notifications/broadcast', { title: 'Test', body: 'Hello' })
    expect(r.statusCode).toBe(200)
    expect(pushed).toContain(`ExponentPushToken[${P}-a]`)
    expect(pushed).toContain(`ExponentPushToken[${P}-ho]`)
    expect(pushed).not.toContain(`ExponentPushToken[${P}-b]`)
    // Naming another company's staffer narrows to nobody.
    pushed.length = 0
    await call('itA', 'POST', '/notifications/broadcast', { title: 'Test', body: 'Hello', filters: { userIds: [U.cookB!.id] } })
    expect(pushed).toEqual([])
    expect((await call('cashierA', 'POST', '/notifications/broadcast', { title: 'x', body: 'y' })).statusCode).toBe(403)
  })

  it('email (SMTP): the CEO saves and tests it; IT reads it, and the password never comes back', async () => {
    const put = await call('ceoA', 'PUT', '/auth/integrations/email', { host: 'smtp.w3c.example', port: '587', user: 'mailer', pass: 'super-secret-smtp-pass', from: 'servd <no-reply@w3c.example>' })
    expect(put.statusCode).toBe(200)
    const got = await call('itA', 'GET', '/auth/integrations/email')
    expect(got.statusCode).toBe(200)
    expect(got.json().host).toBe('smtp.w3c.example')
    expect(got.json().passSet).toBe(true)
    expect(got.body).not.toContain('super-secret-smtp-pass')
    sentEmails.length = 0
    expect((await call('ceoA', 'POST', '/auth/integrations/email/test', { to: 'ceo@w3c.example' })).json().ok).toBe(true)
    expect(sentEmails).toEqual(['ceo@w3c.example'])
  })

  it('W3C-RV-1: IT cannot point the mail host at its own server or fire a test send', async () => {
    // The attack: change the host, leave `pass` out so the stored secret is
    // kept, then trigger a send so the secret goes out in SMTP AUTH.
    const put = await call('itA', 'PUT', '/auth/integrations/email', { host: 'mx.attacker.example', port: '587', user: 'mailer', from: 'noreply@servd.pk' })
    expect(put.statusCode).toBe(403)
    sentEmails.length = 0
    expect((await call('itA', 'POST', '/auth/integrations/email/test', { to: 'x@attacker.example' })).statusCode).toBe(403)
    expect(sentEmails).toEqual([])
    const host = await prisma.setting.findUnique({ where: { key: 'integrations.smtp.host' } })
    expect(host?.value ?? '').not.toBe('mx.attacker.example')
    expect((await call('itA', 'GET', '/auth/integrations/email')).json().host).toBe('smtp.w3c.example')
  })

  it('WhatsApp: IT reads the gateway as a hint only', async () => {
    const r = await call('itA', 'GET', '/auth/integrations/whatsapp')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toHaveProperty('apiKeyHint')
    expect(r.json()).not.toHaveProperty('apiKey')
  })
})

describe('W3C-RV-2 Module Access really closes what IT was given', () => {
  it('an IT login with integrations + notifications + api_whatsapp denied gets 403 on webhooks, push and the email read', async () => {
    for (const [method, url] of [
      ['GET', '/webhooks/endpoints'], ['GET', '/webhooks/events'], ['GET', '/webhooks/deliveries'],
      ['PATCH', `/webhooks/endpoints/${hookA}`],
      ['GET', '/notifications/tokens'], ['POST', '/notifications/broadcast'],
      ['GET', '/auth/integrations/email'],
    ] as const) {
      const payload = method === 'PATCH' ? { notes: 'denied' } : method === 'POST' ? { title: 'x', body: 'y' } : undefined
      expect((await call('itDenied', method, url, payload)).statusCode, `${method} ${url}`).toBe(403)
    }
    const row = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: hookA } })
    expect(row.notes).not.toBe('denied')
  })

  it('the email read follows api_whatsapp (its sidebar module); webhooks and push do not', async () => {
    expect((await call('itNoWa', 'GET', '/auth/integrations/email')).statusCode).toBe(403)
    expect((await call('itNoWa', 'GET', '/webhooks/endpoints')).statusCode).toBe(200)
    expect((await call('itNoWa', 'GET', '/notifications/tokens')).statusCode).toBe(200)
  })

  it('managers keep the pages they hold; managers without the module are refused', async () => {
    // owner holds integrations + notifications by default
    expect((await call('ownerA', 'GET', '/webhooks/endpoints')).statusCode).toBe(200)
    expect((await call('ownerA', 'GET', '/notifications/tokens')).statusCode).toBe(200)
    // foh_management holds integrations, not notifications
    expect((await call('fohMgrA', 'GET', '/webhooks/endpoints')).statusCode).toBe(200)
    expect((await call('fohMgrA', 'GET', '/notifications/tokens')).statusCode).toBe(403)
    // boh_management holds neither page
    expect((await call('bohMgrA', 'GET', '/webhooks/endpoints')).statusCode).toBe(403)
    expect((await call('bohMgrA', 'POST', '/notifications/broadcast', { title: 'x', body: 'y' })).statusCode).toBe(403)
  })
})

describe('W3C-RV-4 a broadcast says which company it reached', () => {
  it('in a two-company login, the reply names the active company and counts the other company\'s skipped devices', async () => {
    pushed.length = 0
    const r = await call('itAB', 'POST', '/notifications/broadcast', { title: 'Test', body: 'Hello' })
    expect(r.statusCode).toBe(200)
    const j = r.json() as { sent: number; company: { id: string } | null; skippedOtherCompanies: number }
    expect(j.company?.id).toBe(T.A)
    expect(pushed).toContain(`ExponentPushToken[${P}-a]`)
    expect(pushed).not.toContain(`ExponentPushToken[${P}-b]`)
    // cookB's tablet is company B only; headOffice is in A too, so it was reached.
    expect(j.skippedOtherCompanies).toBe(1)

    // The device list in "All companies" view shows B's device as well —
    // exactly what the skipped count accounts for.
    const list = await app.inject({ method: 'GET', url: '/api/v1/notifications/tokens', headers: { ...auth('itAB'), 'x-servd-portfolio': '1' } })
    expect((list.json() as Array<{ userId: string }>).map((x) => x.userId)).toContain(U.cookB!.id)
  })

  it('a single-company login skips nothing and never learns about other companies', async () => {
    const j = (await call('itB', 'POST', '/notifications/broadcast', { title: 'Test', body: 'Hello' })).json() as { company: { id: string }; skippedOtherCompanies: number }
    expect(j.company.id).toBe(T.B)
    expect(j.skippedOtherCompanies).toBe(0)
  })
})

describe('UI-09 HR reads the Workforce staff list, scoped to its companies', () => {
  it('HR lists its own company\'s logins, never the other company\'s', async () => {
    const a = await call('hrA', 'GET', '/auth/users')
    expect(a.statusCode).toBe(200)
    const aIds = (a.json() as Array<{ id: string }>).map((u) => u.id)
    expect(aIds).toContain(U.cookA!.id)
    expect(aIds).toContain(U.headOffice!.id)
    expect(aIds).not.toContain(U.cookB!.id)
    expect(aIds).not.toContain(U.itB!.id)

    const bIds = ((await call('hrB', 'GET', '/auth/users')).json() as Array<{ id: string }>).map((u) => u.id)
    expect(bIds).toContain(U.cookB!.id)
    expect(bIds).not.toContain(U.cookA!.id)
    expect(bIds).not.toContain(U.hrA!.id)
  })

  it('the list never carries a PIN hash, and another company\'s name is not shown', async () => {
    const rows = (await call('hrA', 'GET', '/auth/users')).json() as Array<Record<string, unknown>>
    for (const r of rows) expect(r.pin).toBeUndefined()
    const ho = rows.find((r) => r.id === U.headOffice!.id) as { tenants: Array<{ id: string }>; inOtherCompanies: boolean }
    expect(ho.tenants.map((t) => t.id)).toEqual([T.A])
    expect(ho.inOtherCompanies).toBe(true)
  })

  it('an HR login with no company lists nobody (empty scope denies)', async () => {
    const r = await call('hrNone', 'GET', '/auth/users')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual([])
  })

  it('HR still cannot create, edit, approve or delete logins (it may only issue a new password, within limits)', async () => {
    expect((await call('hrA', 'POST', '/auth/users', { name: 'New', role: 'hr' })).statusCode).toBe(403)
    expect((await call('hrA', 'PATCH', `/auth/users/${U.cookA!.id}`, { role: 'management' })).statusCode).toBe(403)
    expect((await call('hrA', 'DELETE', `/auth/users/${U.cookA!.id}`)).statusCode).toBe(403)
    expect((await call('hrA', 'GET', '/auth/staff/pending')).statusCode).toBe(403)
    expect((await call('hrA', 'PATCH', `/auth/staff/${U.cookA!.id}/approve`, {})).statusCode).toBe(403)
    // Reissue password is HR's too (owner, 2026-10-16: "Give this option to HR also"), with limits:
    // a normal office login of its company → 200; never the CEO's or a co-owner's; never a floor
    // (WhatsApp-code) login; never another company's.
    const cook = await call('hrA', 'POST', `/auth/users/${U.cookA!.id}/reissue-password`, {})
    expect(cook.statusCode).toBe(400)
    expect(cook.json().error.code).toBe('NOT_A_PASSWORD_LOGIN')
    for (const who of ['ceoA', 'ownerA']) {
      const r = await call('hrA', 'POST', `/auth/users/${U[who]!.id}/reissue-password`, {})
      expect(r.statusCode, who).toBe(403)
      expect(r.json().error.code, who).toBe('REISSUE_CEO_ONLY')
    }
    expect((await call('hrA', 'POST', `/auth/users/${U.cookB!.id}/reissue-password`, {})).statusCode).toBe(404)
    await mkUser('officeA', 'finance', [T.A])
    const before = await prisma.user.findUniqueOrThrow({ where: { id: U.officeA!.id }, select: { password: true } })
    const office = await call('hrA', 'POST', `/auth/users/${U.officeA!.id}/reissue-password`, {})
    expect(office.statusCode, office.body).toBe(200)
    expect(typeof office.json().temporaryPassword).toBe('string')
    const changed = await prisma.user.findUniqueOrThrow({ where: { id: U.officeA!.id }, select: { password: true, mustChangePassword: true } })
    expect(changed.password).not.toBe(before.password)
    expect(changed.mustChangePassword).toBe(true)
    const after = await prisma.user.findUniqueOrThrow({ where: { id: U.cookA!.id }, select: { role: true } })
    expect(after.role).toBe('kitchen')
  })

  it('floor roles still cannot read the staff list', async () => {
    for (const who of ['cashierA', 'cookA', 'itA', 'marketingA']) {
      expect((await call(who, 'GET', '/auth/users')).statusCode, who).toBe(403)
    }
  })
})
