// Practice copy ("sandbox") mode — SERVD_SANDBOX=1 (lib/sandbox.ts).
//
// The practice copy runs on a COPY OF REAL DATA, so every outbound edge must
// stop there: WhatsApp, email (both transports), staff push, outbound
// webhooks, social posts, the payment gateway, the POS connector (fiscal +
// card machine), the Raast bank-SMS intake, uploads into the live bucket and
// the WhatsApp gateway probe. Each test runs BOTH ways: with the flag the
// effect is blocked and logged (masked, never a body or a code); without it the
// live path still reaches its transport exactly as before, and no
// `practiceCode` ever appears.
//
// Login codes: the practice copy echoes the 2FA code after a correct password
// (and the enrolment code to the signed-in user) so staff can sign in; it never
// echoes a code to an unauthenticated caller who only names a phone / email,
// and password reset is refused there.
//
// Needs a disposable database (DATABASE_URL contains "test") and Redis (the
// login rate limiters are real).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import jwt from 'jsonwebtoken'
import https from 'node:https'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

// ── Transports, captured instead of reached ──────────────────────────────────

const mail = vi.hoisted(() => ({ transports: 0, sent: [] as Array<{ to: string }> }))
vi.mock('nodemailer', () => {
  const createTransport = () => {
    mail.transports++
    return { sendMail: async (m: { to: string }) => { mail.sent.push({ to: m.to }); return { messageId: 'mock' } } }
  }
  return { default: { createTransport }, createTransport }
})

const push = vi.hoisted(() => ({ calls: 0 }))
vi.mock('expo-server-sdk', () => {
  class Expo {
    static isExpoPushToken(t: unknown) { return typeof t === 'string' && t.startsWith('ExponentPushToken[') }
    chunkPushNotifications<T>(m: T[]) { return [m] }
    async sendPushNotificationsAsync(chunk: unknown[]) { push.calls++; return chunk.map(() => ({ status: 'ok', id: 'mock' })) }
  }
  return { Expo, default: { Expo } }
})

const queued: Array<{ subscriptionId: string; event: string }> = []
vi.mock('../src/lib/queue.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/queue.js')>()),
  getWebhookQueue: () => ({
    add: async (_name: string, data: { subscriptionId: string; event: string }) => { queued.push(data); return { id: String(queued.length) } },
  }),
}))

// The webhook SSRF guard resolves the host; give it a public address offline.
vi.mock('dns', async (orig) => {
  const real = await orig<typeof import('dns')>()
  const promises = { ...real.promises, lookup: async () => [{ address: '93.184.216.34', family: 4 }] }
  return { ...real, promises, default: { ...real, promises } }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { redis } = await import('../src/lib/redis.js')
const { AppError } = await import('../src/lib/errors.js')
const sandboxLib = await import('../src/lib/sandbox.js')
const {
  isSandbox, sandboxBlocks, recentlyBlocked, sandboxBlockedCount, resetSandboxLog, practiceCodeField,
  sandboxHealthFields, sandboxUploadKey, assertSandboxBoot, sandboxMetaRoutes, practiceConnectorRow,
  practiceOriginAllowed, verifyAccessToken, registerPracticeAccessGuard, resetAccessKeyCache,
  sandboxScrub, SANDBOX_SCRUB_KEY,
} = sandboxLib
const { isAllowedOrigin } = await import('../src/lib/corsAllowlist.js')
const { riderAuthRoutes } = await import('../src/modules/riderAuth/routes.js')
const { waitlistRoutes } = await import('../src/modules/waitlist/routes.js')
const { sendText, whatsappConfigured, invalidateWhatsappConfig, WA_URL_KEY } = await import('../src/lib/whatsapp.js')
const { sendEmail, emailConfigured, invalidateMailConfig } = await import('../src/lib/mailer.js')
const { deliverToSupplier } = await import('../src/lib/supplier-channels.js')
const { emitDomainEvent } = await import('../src/lib/webhook-events.js')
const { webhookManagementRoutes } = await import('../src/modules/webhooks/routes.js')
const { notificationRoutes } = await import('../src/modules/notifications/routes.js')
const { publishInstagramPost, publishFacebookPost, getOAuthUrl, exchangeCodeForTokens } = await import('../src/lib/meta-social.js')
const { KeenuAdapter } = await import('../src/adapters/payment/keenu.js')
const { getSignedUploadUrl } = await import('../src/lib/storage.js')
const { probeDelivery, startDeliveryWatch } = await import('../src/workers/deliveryWatch.js')
const { httpCall, httpFiscalDriver, httpTerminalDriver } = await import('../src/connectors/drivers/http.js')
const { testFiscalDriver, testTerminalDriver } = await import('../src/connectors/drivers/test.js')
const { fiscalDriverOf, terminalDriverOf, listDrivers, getConnectorFresh, buildCtx, clearConnectorCache, newWebhookToken } = await import('../src/connectors/registry.js')
const { encryptSecret } = await import('../src/lib/secretBox.js')
const { connectorWebhookRoutes } = await import('../src/modules/connectors/webhookRoutes.js')
const { connectorRoutes } = await import('../src/modules/connectors/routes.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { requestSharedCode, normalisePhone } = await import('../src/modules/auth/otp.js')
const { startLoyaltyTriggerWorker } = await import('../src/workers/loyaltyTriggers.js')
const { startReservationReminderWorker } = await import('../src/workers/reservationReminders.js')
const { startReviewPromptWorker } = await import('../src/workers/reviewPrompt.js')
const { startSocialPublishWorker } = await import('../src/workers/socialPublish.js')
const { startScheduledReportsWorker } = await import('../src/workers/scheduledReports.js')
import type { ConnectorCtx } from '../src/connectors/types.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const STAMP = Date.now()
const PREFIX = `sbx-${STAMP}`
const CLIENT_IP = '10.9.9.77'
const PASSWORD = 'Practice-Copy-Pass-2026'
const TWO_FA_PHONE = '923001112233'

let tenantA = '', tenantB = ''
let conceptA = ''
let subA = ''
let ownerA: { id: string; auth: Record<string, string> }
let adminA: Record<string, string>
let twoFaUser = { id: '', email: '' }
let cashier = { id: '', phone: '' }
const users: string[] = []
let app: FastifyInstance

const fetchSpy = vi.spyOn(globalThis, 'fetch')

function practice(on: boolean): void {
  if (on) process.env['SERVD_SANDBOX'] = '1'
  else delete process.env['SERVD_SANDBOX']
}

async function makeUser(data: { role: string; tenantId: string; email: string; phone?: string; twoFactorPhone?: string }) {
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${data.role}`,
      email: data.email,
      password: await bcrypt.hash(PASSWORD, 4),
      role: data.role as never,
      tenantId: data.tenantId,
      phone: data.phone ?? null,
      isActive: true,
      accountStatus: 'active',
      ...(data.twoFactorPhone && { twoFactorPhone: data.twoFactorPhone, twoFactorEnabledAt: new Date() }),
      tenantMemberships: { create: [{ tenant: { connect: { id: data.tenantId } }, role: 'member' }] },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  users.push(u.id)
  return u
}

async function setSetting(key: string, value: string) {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function inject(method: 'GET' | 'POST', url: string, body?: object, headers?: Record<string, string>) {
  const res = await app.inject({ method, url, payload: body, headers, remoteAddress: CLIENT_IP })
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

/** No entry anywhere in the blocked log may carry this text. */
function logNeverHolds(...secrets: string[]) {
  const all = JSON.stringify(recentlyBlocked())
  for (const s of secrets) expect(all).not.toContain(s)
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Sandbox Co A', slug: `${PREFIX}-a` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Sandbox Co B', slug: `${PREFIX}-b` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Sbx A', slug: `${PREFIX}-ca`, tenantId: tenantA, type: 'restaurant' } })).id
  subA = (await prisma.webhookSubscription.create({
    data: { tenantId: tenantA, url: 'https://hooks.example.com/servd', events: ['order.confirmed'], secret: 's'.repeat(32) },
  })).id

  const o = await makeUser({ role: 'owner', tenantId: tenantA, email: `${PREFIX}.owner@gsfoods.pk` })
  ownerA = { id: o.id, auth: { authorization: `Bearer ${issueStaffSession({ id: o.id, name: o.name ?? '', email: o.email, role: o.role }).accessToken}` } }
  const ceo = await makeUser({ role: 'admin', tenantId: tenantA, email: `${PREFIX}.ceo@gsfoods.pk` })
  adminA = { authorization: `Bearer ${issueStaffSession({ id: ceo.id, name: ceo.name ?? '', email: ceo.email, role: ceo.role }).accessToken}` }
  const m = await makeUser({ role: 'management', tenantId: tenantA, email: `${PREFIX}.mgmt@gsfoods.pk`, twoFactorPhone: TWO_FA_PHONE })
  twoFaUser = { id: m.id, email: m.email! }
  cashier.phone = `0300${String(STAMP).slice(-7)}`
  const c = await makeUser({ role: 'cashier', tenantId: tenantA, email: `${PREFIX}.till@gsfoods.pk`, phone: cashier.phone })
  cashier.id = c.id

  // Both companies' connectors are what a copy of live would hold: vendor
  // driver, a real-looking URL, encrypted secrets.
  for (const tenantId of [tenantA, tenantB]) {
    for (const kind of ['fiscal', 'terminal'] as const) {
      await prisma.posConnector.create({
        data: {
          tenantId, kind, driver: 'http', enabled: true, baseUrl: 'https://pos.vendor.example.com',
          apiKeyEnc: encryptSecret('live-api-key'), webhookSecretEnc: encryptSecret('live-webhook-secret'),
          webhookToken: newWebhookToken(), settings: {},
        },
      })
    }
  }

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.register(webhookManagementRoutes, { prefix: '/api/v1/webhooks' })
  await app.register(notificationRoutes, { prefix: '/api/v1/notifications' })
  await app.register(sandboxMetaRoutes, { prefix: '/api/v1/meta' })
  await app.register(connectorWebhookRoutes, { prefix: '/api/v1/webhooks/pos' })
  await app.register(connectorRoutes, { prefix: '/api/v1/connectors' })
  await app.register(riderAuthRoutes, { prefix: '/api/v1/rider-auth' })
  await app.register(waitlistRoutes, { prefix: '/api/v1/waitlist' })
  await app.ready()
  const keys = await redis.keys(`*${CLIENT_IP}*`)
  if (keys.length) await redis.del(...keys)
}, 60_000)

afterAll(async () => {
  practice(false)
  await app?.close()
  fetchSpy.mockRestore()
  await prisma.setting.deleteMany({
    where: { key: { in: [WA_URL_KEY, 'integrations.whatsapp.apiKey', 'integrations.smtp.user', 'integrations.smtp.pass', 'fb_page_id', 'fb_page_name', 'fb_page_token', 'ig_user_id', SANDBOX_SCRUB_KEY] } },
  })
  if (!tenantA) return
  await prisma.expoPushToken.deleteMany({ where: { userId: { in: users } } })
  await prisma.staffPasswordReset.deleteMany({ where: { userId: { in: users } } })
  await prisma.webhookDelivery.deleteMany({ where: { subscriptionId: subA } })
  await prisma.webhookSubscription.deleteMany({ where: { id: subA } })
  await prisma.posConnector.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
  await prisma.tenantMember.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.concept.deleteMany({ where: { id: conceptA } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

beforeEach(() => {
  // Anything that slips past a guard fails fast here instead of reaching the network.
  fetchSpy.mockReset()
  fetchSpy.mockImplementation(async () => { throw new Error('network is not allowed in this test') })
  mail.transports = 0
  mail.sent.length = 0
  push.calls = 0
  queued.length = 0
  resetSandboxLog()
  invalidateWhatsappConfig()
  invalidateMailConfig()
  clearConnectorCache()
})

afterEach(() => {
  practice(false)
  delete process.env['SMTP_USER']
  delete process.env['SMTP_PASS']
  invalidateMailConfig()
})

// ── The helper ───────────────────────────────────────────────────────────────

describe('lib/sandbox', () => {
  it('is off unless SERVD_SANDBOX is exactly 1, and then records nothing', () => {
    for (const v of [undefined, '', '0', 'true', 'yes']) {
      if (v === undefined) delete process.env['SERVD_SANDBOX']
      else process.env['SERVD_SANDBOX'] = v
      expect(isSandbox()).toBe(false)
      expect(sandboxBlocks('whatsapp', { to: '923001234567' })).toBe(false)
    }
    expect(sandboxBlockedCount()).toBe(0)
    expect(recentlyBlocked()).toEqual([])
    expect(practiceCodeField('123456')).toEqual({})
    expect(sandboxHealthFields()).toEqual({})
  })

  it('blocks, logs one masked line and keeps a ring of the last 200', () => {
    practice(true)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    expect(sandboxBlocks('whatsapp', { to: '+92 300 1234567', summary: 'code 654321 for you' })).toBe(true)
    expect(info).toHaveBeenCalledTimes(1)
    expect(String(info.mock.calls[0]![0])).toMatch(/^\[sandbox\] blocked whatsapp/)
    info.mockRestore()
    const [e] = recentlyBlocked()
    expect(e!.kind).toBe('whatsapp')
    expect(e!.summary).toContain('…4567')
    logNeverHolds('3001234567', '654321')

    expect(sandboxBlocks('email', { to: 'sara.khan@example.com' })).toBe(true)
    expect(recentlyBlocked()[0]!.summary).toBe('to s***@example.com')
    logNeverHolds('sara.khan')

    vi.spyOn(console, 'info').mockImplementation(() => {})
    for (let i = 0; i < 250; i++) sandboxBlocks('push', { summary: `n${i}` })
    vi.mocked(console.info).mockRestore()
    expect(recentlyBlocked()).toHaveLength(200)
    expect(recentlyBlocked()[0]!.summary).toBe('n249')
    expect(sandboxBlockedCount()).toBe(252)
    expect(sandboxHealthFields()).toEqual({ sandbox: true, sandboxBlocked: 252 })
    expect(practiceCodeField('123456')).toEqual({ practiceCode: '123456' })
  })

  it('boot check refuses a malformed flag and a live database / Redis host', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => assertSandboxBoot({})).not.toThrow()
    expect(() => assertSandboxBoot({ SERVD_SANDBOX: '0' })).not.toThrow()
    expect(() => assertSandboxBoot({ SERVD_SANDBOX: 'true' })).toThrow(/must be exactly '1'/)
    // Judged exactly as isSandbox() reads it: a stray space or CR is refused,
    // never accepted as practice while the runtime reads live (final gate).
    for (const v of ['1 ', ' 1', '1\r']) expect(() => assertSandboxBoot({ SERVD_SANDBOX: v }), JSON.stringify(v)).toThrow(/must be exactly '1'/)
    const live = { SERVD_SANDBOX: '1', SERVD_PROD_HOSTS: 'db.live.example, redis.live.example' }
    expect(() => assertSandboxBoot({ ...live, DATABASE_URL: 'postgresql://u@db.live.example:5432/servd' })).toThrow(/DATABASE_URL/)
    expect(() => assertSandboxBoot({ ...live, DATABASE_URL: 'postgresql://u@db.practice.example/servd', REDIS_URL: 'redis://redis.live.example:6379' })).toThrow(/REDIS_URL/)
    expect(() => assertSandboxBoot({ ...live, DATABASE_URL: 'postgresql://u@db.practice.example/servd', REDIS_URL: 'redis://redis.practice.example:6379' })).not.toThrow()
    // Production: Cloudflare Access settings are required, and the team must be a cloudflareaccess.com domain.
    const prod = { ...live, NODE_ENV: 'production', DATABASE_URL: 'postgresql://u@db.practice.example/servd', REDIS_URL: 'redis://redis.practice.example:6379' }
    expect(() => assertSandboxBoot(prod)).toThrow(/SERVD_SANDBOX_ACCESS_TEAM and SERVD_SANDBOX_ACCESS_AUD must be set/)
    expect(() => assertSandboxBoot({ ...prod, SERVD_SANDBOX_ACCESS_TEAM: 'gsfoods.cloudflareaccess.com' })).toThrow(/must be set/)
    expect(() => assertSandboxBoot({ ...prod, SERVD_SANDBOX_ACCESS_TEAM: 'evil.example.com', SERVD_SANDBOX_ACCESS_AUD: 'aud' })).toThrow(/cloudflareaccess\.com/)
    expect(() => assertSandboxBoot({ ...prod, SERVD_SANDBOX_ACCESS_TEAM: 'https://gsfoods.cloudflareaccess.com/', SERVD_SANDBOX_ACCESS_AUD: 'aud' })).not.toThrow()
    // Live production never needs them.
    expect(() => assertSandboxBoot({ NODE_ENV: 'production' })).not.toThrow()
    vi.mocked(console.warn).mockRestore()
  })

  it('GET /meta/sandbox says which server this is (no auth)', async () => {
    expect((await inject('GET', '/api/v1/meta/sandbox')).body).toEqual({ sandbox: false })
    practice(true)
    expect((await inject('GET', '/api/v1/meta/sandbox')).body).toEqual({ sandbox: true })
  })
})

// ── Messaging ────────────────────────────────────────────────────────────────

describe('WhatsApp', () => {
  beforeEach(async () => { await setSetting(WA_URL_KEY, 'https://gw.example.com/webhook/client1/send') })
  afterEach(async () => { await prisma.setting.deleteMany({ where: { key: WA_URL_KEY } }) })

  it('live: POSTs to the configured gateway, as before', async () => {
    fetchSpy.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    await sendText('923001234567', 'hello')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://gw.example.com/webhook/client1/send')
    expect(sandboxBlockedCount()).toBe(0)
  })

  it('practice copy: a practice result, no fetch, the body never logged', async () => {
    practice(true)
    const r = await sendText('923001234567', 'Your servd code is 482913')
    expect(r).toMatchObject({ practice: true })
    expect((r as { id: string }).id).toMatch(/^sandbox-/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(recentlyBlocked()[0]).toMatchObject({ kind: 'whatsapp' })
    logNeverHolds('482913', 'servd code', '923001234567')
  })

  it('practice copy: reports configured even with no gateway, so notify / OTP never 503', async () => {
    await prisma.setting.deleteMany({ where: { key: WA_URL_KEY } })
    invalidateWhatsappConfig()
    expect(await whatsappConfigured()).toBe(false)
    practice(true)
    expect(await whatsappConfigured()).toBe(true)
  })

  it('the probe: live asks the real gateway; the practice copy never does', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ clients: { client1: 'READY' } }), { status: 200 }))
    expect((await probeDelivery()).ok).toBe(true)
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://gw.example.com/health')
    fetchSpy.mockClear()
    practice(true)
    const s = await probeDelivery()
    expect(s).toMatchObject({ ok: true, cause: 'ok', detail: 'Practice copy: messages are not sent' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('email', () => {
  beforeEach(() => { process.env['SMTP_USER'] = 'smtp-user'; process.env['SMTP_PASS'] = 'smtp-pass'; invalidateMailConfig() })

  it('live: builds the SMTP transport and sends, as before', async () => {
    await sendEmail({ to: 'guest@example.com', subject: 's', html: '<p>x</p>' })
    expect(mail.transports).toBe(1)
    expect(mail.sent).toEqual([{ to: 'guest@example.com' }])
  })

  it('practice copy: resolves without a transport, recipient masked', async () => {
    practice(true)
    await sendEmail({ to: 'guest@example.com', subject: 'Your code', html: '<p>123456</p>' })
    expect(mail.transports).toBe(0)
    expect(recentlyBlocked()[0]).toMatchObject({ kind: 'email', summary: expect.stringContaining('g***@example.com') })
    logNeverHolds('guest@', '123456')
  })

  it('practice copy: configured even with no SMTP, so notify never throws NOTIFY_NOT_CONFIGURED', async () => {
    delete process.env['SMTP_USER']; delete process.env['SMTP_PASS']; invalidateMailConfig()
    expect(await emailConfigured()).toBe(false)
    practice(true)
    expect(await emailConfigured()).toBe(true)
  })

  it('supplier chat goes through the one mail sender, blocked in a practice copy', async () => {
    const ctx = {
      conversation: { id: 'conv-1', subject: 'Order' },
      supplier: { id: 'sup-1', name: 'Fresh Farms', email: 'orders@freshfarms.example', whatsappPhone: null, phone: null },
      body: 'Please send 10kg', fromStaffName: 'Ali',
    }
    expect((await deliverToSupplier(ctx)).email).toBe('sent')
    expect(mail.transports).toBe(1)
    practice(true)
    expect((await deliverToSupplier(ctx)).email).toBe('sent')
    expect(mail.transports).toBe(1)
    expect(recentlyBlocked()[0]).toMatchObject({ kind: 'email' })
  })
})

describe('staff push broadcast', () => {
  beforeAll(async () => {
    await prisma.expoPushToken.create({ data: { userId: ownerA.id, token: `ExponentPushToken[${PREFIX}]`, platform: 'ios', device: 'tablet' } })
  })

  it('live: Expo is called; practice copy: a practice result and no Expo call', async () => {
    const live = await inject('POST', '/api/v1/notifications/broadcast', { title: 't', body: 'b' }, ownerA.auth)
    expect(live.status).toBe(200)
    expect(push.calls).toBe(1)
    expect(live.body.practice).toBeUndefined()
    practice(true)
    const p = await inject('POST', '/api/v1/notifications/broadcast', { title: 't', body: 'b' }, ownerA.auth)
    expect(p.status).toBe(200)
    expect(p.body).toMatchObject({ sent: 1, failed: 0, practice: true })
    expect(push.calls).toBe(1)
    expect(recentlyBlocked()[0]!.kind).toBe('push')
  })
})

// ── Webhooks, social, payments, storage ──────────────────────────────────────

describe('outbound webhooks', () => {
  it('live: queued for the owning company; practice copy: never queued', async () => {
    await emitDomainEvent('order.confirmed', { orderId: 'o1' }, tenantA)
    expect(queued.map((q) => q.subscriptionId)).toEqual([subA])
    queued.length = 0
    practice(true)
    await emitDomainEvent('order.confirmed', { orderId: 'o1' }, tenantA)
    expect(queued).toEqual([])
    expect(recentlyBlocked()[0]).toMatchObject({ kind: 'webhook', summary: expect.stringContaining('order.confirmed') })
  })

  it('the test ping: live POSTs to the endpoint; practice copy answers a practice result', async () => {
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }))
    const live = await inject('POST', `/api/v1/webhooks/endpoints/${subA}/test`, {}, ownerA.auth)
    expect(live.body).toMatchObject({ success: true, statusCode: 200 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockClear()
    practice(true)
    const p = await inject('POST', `/api/v1/webhooks/endpoints/${subA}/test`, {}, ownerA.auth)
    expect(p.body).toEqual({ success: true, statusCode: 0, responseMs: 0, practice: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('social pages', () => {
  beforeAll(async () => {
    await setSetting('fb_page_id', 'page-1'); await setSetting('fb_page_token', 'live-token'); await setSetting('ig_user_id', 'ig-1')
  })
  // The page is now a brand's approved connection (modules/socialConnections), passed in by the caller.
  const page = { pageId: 'page-1', igUserId: 'ig-1', token: 'live-token' }

  it('live: posts to the Graph API; practice copy: a practice id and no call', async () => {
    fetchSpy.mockResolvedValue(new Response('{"id":"fb-post-1"}', { status: 200 }))
    expect(await publishFacebookPost('hello', [], page)).toBe('fb-post-1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockClear()
    practice(true)
    expect(await publishFacebookPost('hello', [], page)).toMatch(/^sandbox-/)
    expect(await publishInstagramPost('hello', ['https://x/y.jpg'], page)).toMatch(/^sandbox-/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('practice copy: connecting a page is refused (403 SANDBOX)', async () => {
    practice(true)
    await expect(getOAuthUrl('https://cb', 'state')).rejects.toMatchObject({ code: 'SANDBOX', statusCode: 403 })
    await expect(exchangeCodeForTokens('code', 'https://cb')).rejects.toMatchObject({ code: 'SANDBOX', statusCode: 403 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('payment gateway (Keenu)', () => {
  it('live: calls the gateway; practice copy: 422 SANDBOX_NO_PAYMENTS, no call', async () => {
    fetchSpy.mockResolvedValue(new Response('{"status":"paid","amount":100}', { status: 200 }))
    await new KeenuAdapter().checkStatus('ref-1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    fetchSpy.mockClear()
    practice(true)
    await expect(new KeenuAdapter().checkStatus('ref-1')).rejects.toMatchObject({ code: 'SANDBOX_NO_PAYMENTS', statusCode: 422 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('uploads', () => {
  it('live: the key is unchanged; practice copy: sandbox/ prefix, live bucket refused', async () => {
    expect(sandboxUploadKey('menu/a.png', 'servd-media')).toBe('menu/a.png')
    practice(true)
    expect(sandboxUploadKey('menu/a.png', 'servd-practice')).toBe('sandbox/menu/a.png')
    expect(() => sandboxUploadKey('menu/a.png', 'servd-media')).toThrow(/practice bucket/)
    // This test process has no R2_BUCKET_NAME, i.e. the live default bucket.
    await expect(getSignedUploadUrl('a.png', 'image/png', 'menu')).rejects.toMatchObject({ code: 'STORAGE_NOT_CONFIGURED', statusCode: 503 })
    expect(recentlyBlocked()[0]!.kind).toBe('storage')
  })
})

// ── POS connector: fiscal POS + card machine ─────────────────────────────────

describe('POS connector', () => {
  it('drivers: live keeps the vendor driver; the practice copy only ever has the test drivers', () => {
    expect(fiscalDriverOf('http')).toBe(httpFiscalDriver)
    expect(terminalDriverOf('http')).toBe(httpTerminalDriver)
    expect(listDrivers().some((d) => d.id === 'http')).toBe(true)
    practice(true)
    expect(fiscalDriverOf('http')).toBe(testFiscalDriver)
    expect(terminalDriverOf('http')).toBe(testTerminalDriver)
    expect(fiscalDriverOf('none')).toBeNull()
    expect(fiscalDriverOf('nonsense')).toBeNull()
    expect(listDrivers().map((d) => d.id).every((id) => id === 'none' || id === 'test')).toBe(true)
  })

  it('both companies: a copied vendor connector loads as the test driver with no URL or secrets', async () => {
    for (const tenantId of [tenantA, tenantB]) {
      for (const kind of ['fiscal', 'terminal'] as const) {
        clearConnectorCache()
        practice(false)
        const live = await getConnectorFresh(tenantId, kind)
        expect(live.row.driver).toBe('http')
        expect(live.apiKey).toBe('live-api-key')
        expect(buildCtx(live, 1000).isTest).toBe(false)

        practice(true)
        const p = await getConnectorFresh(tenantId, kind)
        expect(p.row).toMatchObject({ tenantId, kind, driver: 'test', baseUrl: null, apiKeyEnc: null, webhookSecretEnc: null })
        expect(p.apiKey).toBeNull()
        expect(p.webhookSecret).toBeNull()
        const ctx = buildCtx(p, 1000)
        expect(ctx).toMatchObject({ isTest: true, driver: 'test', baseUrl: null })
      }
    }
    // The stored rows are untouched — only the practice copy's view changes.
    expect(await prisma.posConnector.count({ where: { tenantId: { in: [tenantA, tenantB] }, driver: 'http' } })).toBe(4)
  })

  it("'none' and 'test' rows pass through; a vendor row's hints are dropped too", async () => {
    practice(true)
    const row = await prisma.posConnector.findFirstOrThrow({ where: { tenantId: tenantA, kind: 'fiscal' } })
    for (const driver of ['none', 'test']) {
      const r = { ...row, driver }
      expect(practiceConnectorRow(r)).toBe(r)
    }
    expect(practiceConnectorRow({ ...row, apiKeyHint: 'live…-key' })).toMatchObject({ driver: 'test', apiKeyHint: null, webhookSecretHint: null })
  })

  it('the admin connector page shows the test driver it really runs on (live: the vendor driver)', async () => {
    const live = await inject('GET', '/api/v1/connectors', undefined, adminA)
    expect(live.status).toBe(200)
    expect(live.body.fiscal).toMatchObject({ driver: 'http', isTest: false, baseUrl: 'https://pos.vendor.example.com' })
    practice(true)
    const p = await inject('GET', '/api/v1/connectors', undefined, adminA)
    expect(p.body.fiscal).toMatchObject({ driver: 'test', isTest: true, baseUrl: null, apiKeyHint: null })
    expect(p.body.terminal).toMatchObject({ driver: 'test', isTest: true })
  })

  it('the HTTP driver itself refuses in the practice copy (backstop): no request is opened', async () => {
    const ctx = {
      tenantId: tenantA, connectorId: 'c1', driver: 'http', isTest: false,
      baseUrl: 'https://pos.vendor.example.com', apiKey: 'k', webhookSecret: null, settings: {},
      signal: AbortSignal.timeout(2000), now: () => new Date(), log: () => {},
    } as unknown as ConnectorCtx
    const reqSpy = vi.spyOn(https, 'request').mockImplementation((() => {
      const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; destroy: () => void }
      req.write = () => {}
      req.destroy = () => {}
      req.end = () => { setImmediate(() => req.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))) }
      return req
    }) as never)
    try {
      const live = await httpCall(ctx, 'POST', '/v1/sales', { a: 1 }, 'idem-1')
      expect(reqSpy).toHaveBeenCalledTimes(1)
      expect(live).toMatchObject({ kind: 'transient', code: 'ECONNREFUSED' })
      reqSpy.mockClear()
      practice(true)
      const p = await httpCall(ctx, 'POST', '/v1/sales', { a: 1 }, 'idem-2')
      expect(p).toMatchObject({ kind: 'transient', code: 'SANDBOX_BLOCKED' })
      expect(reqSpy).not.toHaveBeenCalled()
    } finally {
      reqSpy.mockRestore()
    }
  })
})

describe('Raast bank-SMS intake', () => {
  it('practice copy: 403 SANDBOX before any token lookup; live: unchanged', async () => {
    const live = await inject('POST', '/api/v1/webhooks/pos/sms', { from: 'HBL', text: 'x' })
    expect(live.body?.error?.code).not.toBe('SANDBOX')
    practice(true)
    const p = await inject('POST', '/api/v1/webhooks/pos/sms', { from: 'HBL', text: 'x' })
    expect(p.status).toBe(403)
    expect(p.body.error.code).toBe('SANDBOX')
    expect(recentlyBlocked()[0]!.kind).toBe('raast_sms')
  })
})

// ── Login codes ──────────────────────────────────────────────────────────────

describe('login codes', () => {
  // Two-step sign-in is retired (owner, 2026-10-26): an account that was enrolled
  // (the enrolment is ignored) signs straight in — live and practice alike — and
  // no code is ever sent or echoed.
  it('a formerly enrolled login signs straight in — live: no code, no practiceCode', async () => {
    const r = await inject('POST', '/api/v1/auth/login', { email: twoFaUser.email, password: PASSWORD })
    expect(r.status).toBe(200)
    expect('twoFactorRequired' in r.body).toBe(false)
    expect(r.body.accessToken).toBeTruthy()
    expect('practiceCode' in r.body).toBe(false)
  })

  it('practice copy: the same — a session, no code sent, nothing echoed; /auth/2fa/verify is gone (410)', async () => {
    practice(true)
    const r = await inject('POST', '/api/v1/auth/login', { email: twoFaUser.email, password: PASSWORD })
    expect(r.status).toBe(200)
    expect(r.body.accessToken).toBeTruthy()
    expect('practiceCode' in r.body).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mail.transports).toBe(0)
    const v = await inject('POST', '/api/v1/auth/2fa/verify', { challengeToken: 'x', code: '123456' })
    expect(v.status).toBe(410)
    expect(v.body.error.code).toBe('TWO_STEP_RETIRED')
  })

  it('a wrong password never yields a code', async () => {
    practice(true)
    const r = await inject('POST', '/api/v1/auth/login', { email: twoFaUser.email, password: 'wrong-password-123' })
    expect(r.status).toBe(401)
    expect(JSON.stringify(r.body)).not.toMatch(/practiceCode/)
  })

  it('2FA enrolment is gone (410) — live and practice', async () => {
    for (const on of [false, true]) {
      practice(on)
      const r = await inject('POST', '/api/v1/auth/2fa/start', { phone: '923001234567' })
      expect(r.status).toBe(410)
      expect('practiceCode' in (r.body ?? {})).toBe(false)
    }
  })

  it('code requests by a typed phone / email: the practice copy refuses up front (503), sends nothing, issues nothing, echoes nothing', async () => {
    practice(true)
    const phone = normalisePhone(cashier.phone)
    const before = await prisma.phoneOtp.count({ where: { phone } })
    const staff = await inject('POST', '/api/v1/auth/staff/otp/request', { phone: cashier.phone })
    expect(staff.status).toBe(503)
    expect(staff.body.error.code).toBe('OTP_UNAVAILABLE')
    expect(staff.body.error.message).toMatch(/Sign-in code/)
    // The same answer for a number that is nobody's: it says nothing about who is staff.
    const nobody = await inject('POST', '/api/v1/auth/staff/otp/request', { phone: '03009999999' })
    expect(nobody).toEqual(staff)
    expect(await prisma.phoneOtp.count({ where: { phone } })).toBe(before)

    const others: Array<[string, object, Record<string, string>?]> = [
      ['/api/v1/auth/customer/request-signup-codes', { phone: '03001234567', email: 'someone@example.com' }],
      ['/api/v1/auth/customer/request', { email: 'someone@example.com' }],
      ['/api/v1/rider-auth/otp/request', { phone: '03001234567' }],
      ['/api/v1/waitlist/request-code', { phone: '03001234567', consent: true }],
    ]
    for (const [url, body] of others) {
      const r = await inject('POST', url, body)
      expect(r.status, url).toBe(503)
      expect(r.body.error.code, url).toBe('OTP_UNAVAILABLE')
      expect(r.body.error.message, url).toMatch(/^Practice copy/)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mail.transports).toBe(0)
    expect(recentlyBlocked()).toEqual([])
  })

  it('code requests, live: the floor-staff route still answers as before (no early refusal)', async () => {
    // A number that belongs to nobody: live answers the generic 200 without sending anything.
    const r = await inject('POST', '/api/v1/auth/staff/otp/request', { phone: '03008888888' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ sent: true, message: 'If that number belongs to a staff account, a code is on its way.' })
  })

  it('codes still issue under NODE_ENV=production in the practice copy (the send resolves, no 503)', async () => {
    const prev = process.env['NODE_ENV']
    practice(true)
    process.env['NODE_ENV'] = 'production'
    try {
      const phone = `92301${String(STAMP).slice(-7)}`
      const r = await requestSharedCode({ phone, email: `${PREFIX}.signup@example.com`, purpose: 'signup' })
      expect(r).toMatchObject({ phone: 'sent', email: 'sent' })
      await prisma.phoneOtp.deleteMany({ where: { phone } })
      await prisma.emailOtp.deleteMany({ where: { email: `${PREFIX}.signup@example.com` } })
    } finally {
      process.env['NODE_ENV'] = prev
    }
  })

  it('password reset: live sends a link (202, no code); practice copy refuses (503) and issues nothing', async () => {
    process.env['SMTP_USER'] = 'smtp-user'; process.env['SMTP_PASS'] = 'smtp-pass'; invalidateMailConfig()
    const live = await inject('POST', '/api/v1/auth/password/forgot', { email: twoFaUser.email })
    expect(live.status).toBe(202)
    expect('practiceCode' in live.body).toBe(false)
    expect(mail.sent.map((m) => m.to)).toContain(twoFaUser.email)
    const before = await prisma.staffPasswordReset.count({ where: { userId: twoFaUser.id } })
    expect(before).toBe(1)

    practice(true)
    const p = await inject('POST', '/api/v1/auth/password/forgot', { email: twoFaUser.email })
    expect(p.status).toBe(503)
    expect(p.body.error.code).toBe('RESET_UNAVAILABLE')
    expect(JSON.stringify(p.body)).not.toMatch(/practiceCode|token/)
    expect(await prisma.staffPasswordReset.count({ where: { userId: twoFaUser.id } })).toBe(before)
  })
})

// ── Admin "send test" buttons ────────────────────────────────────────────────

describe('admin test sends', () => {
  it('practice copy: WhatsApp and email tests answer a practice note and send nothing', async () => {
    const auth = adminA
    practice(true)
    const wa = await inject('POST', '/api/v1/auth/integrations/whatsapp/test', { phone: '03001234567' }, auth)
    expect(wa.body).toMatchObject({ ok: true, practice: true, note: 'Practice copy: nothing was sent' })
    const em = await inject('POST', '/api/v1/auth/integrations/email/test', { to: 'it@gsfoods.pk' }, auth)
    expect(em.body).toMatchObject({ ok: true, practice: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mail.transports).toBe(0)
  })
})

// ── Workers ──────────────────────────────────────────────────────────────────

describe('workers that only message people or post outside', () => {
  it('are no-ops in the practice copy', () => {
    practice(true)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    startDeliveryWatch()
    startLoyaltyTriggerWorker()
    startReservationReminderWorker()
    startReviewPromptWorker()
    startSocialPublishWorker()
    startScheduledReportsWorker()
    vi.mocked(console.info).mockRestore()
    const workers = recentlyBlocked().filter((e) => e.kind === 'worker').map((e) => e.summary).sort()
    expect(workers).toEqual(['deliveryWatch', 'loyaltyTriggers', 'reservationReminders', 'reviewPrompt', 'scheduledReports', 'socialPublish'])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ── Browser origins ──────────────────────────────────────────────────────────

describe('CORS / socket origins', () => {
  const PRACTICE_ADMIN = 'https://servd-practice.garibsons.app'
  afterEach(() => { delete process.env['WEB_URL'] })

  it('live: the allowlist is unchanged', () => {
    for (const o of ['https://admin.servd.pk', 'https://servd.pk', 'https://stackd.pk', 'https://www.simmer.pk', undefined]) {
      expect(isAllowedOrigin(o), String(o)).toBe(true)
    }
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false)
  })

  it("practice copy: its own admin only — never live servd's admin, storefront or brand sites", () => {
    practice(true)
    process.env['WEB_URL'] = `${PRACTICE_ADMIN}/`
    expect(isAllowedOrigin(PRACTICE_ADMIN)).toBe(true)
    expect(isAllowedOrigin(PRACTICE_ADMIN.toUpperCase())).toBe(true)
    expect(isAllowedOrigin(undefined)).toBe(true) // server-to-server / healthcheck, as on live
    for (const o of ['https://admin.servd.pk', 'https://servd.pk', 'https://www.servd.pk', 'https://stackd.pk', 'https://sandbox.servd.pk', 'http://admin.localhost:3000', 'https://evil.example.com']) {
      expect(isAllowedOrigin(o), o).toBe(false)
    }
    delete process.env['WEB_URL']
    expect(practiceOriginAllowed(PRACTICE_ADMIN)).toBe(false) // no WEB_URL: nothing in a browser is trusted
  })
})

// ── Cloudflare Access ────────────────────────────────────────────────────────

describe('Cloudflare Access guard', () => {
  const TEAM = 'gsfoods-test.cloudflareaccess.com'
  const AUD = 'practice-aud-tag-0123456789abcdef'
  const KID = 'kid-practice-1'
  const signer = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const certs = { keys: [{ ...(signer.publicKey.export({ format: 'jwk' }) as object), kid: KID, alg: 'RS256', use: 'sig' }] }
  const TUNNEL = { 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '203.0.113.9' }

  function token(opts: { key?: KeyObject; aud?: string; iss?: string; expired?: boolean; kid?: string } = {}) {
    const now = Math.floor(Date.now() / 1000)
    return jwt.sign(
      { email: 'it@gsfoods.pk', type: 'app', iat: now - 120, exp: opts.expired ? now - 60 : now + 3600 },
      opts.key ?? signer.privateKey,
      { algorithm: 'RS256', keyid: opts.kid ?? KID, audience: opts.aud ?? AUD, issuer: opts.iss ?? `https://${TEAM}` },
    )
  }

  async function guarded() {
    const g = Fastify()
    g.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code } })
      return reply.status(500).send({ error: { code: 'ERR' } })
    })
    registerPracticeAccessGuard(g)
    g.get('/api/v1/meta/x', async () => ({ ok: true }))
    await g.ready()
    return g
  }
  const call = async (g: FastifyInstance, headers: Record<string, string> = {}, method: 'GET' | 'OPTIONS' = 'GET') =>
    (await g.inject({ method, url: '/api/v1/meta/x', headers })).statusCode

  beforeEach(() => {
    process.env['SERVD_SANDBOX_ACCESS_TEAM'] = TEAM
    process.env['SERVD_SANDBOX_ACCESS_AUD'] = AUD
    resetAccessKeyCache()
    fetchSpy.mockImplementation(async (url) => {
      if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify(certs), { status: 200 })
      throw new Error(`network is not allowed in this test: ${String(url)}`)
    })
  })
  afterEach(() => {
    delete process.env['SERVD_SANDBOX_ACCESS_TEAM']
    delete process.env['SERVD_SANDBOX_ACCESS_AUD']
  })

  it('live: registers nothing — tunnel traffic with no Access token is served as before', async () => {
    const g = await guarded()
    expect(await call(g, TUNNEL)).toBe(200)
    await g.close()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('practice copy: internet requests need a valid Access token; the healthcheck and preflights do not', async () => {
    practice(true)
    const g = await guarded()
    expect(await call(g)).toBe(200)                                   // inside the practice network (healthcheck)
    expect(await call(g, TUNNEL, 'OPTIONS')).not.toBe(403)            // CORS preflight, which Access passes without a token
    expect(await call(g, TUNNEL)).toBe(403)                           // through the tunnel, no token
    expect(await call(g, { ...TUNNEL, 'cf-access-jwt-assertion': 'not-a-jwt' })).toBe(403)
    expect(await call(g, { ...TUNNEL, 'cf-access-jwt-assertion': token() })).toBe(200)
    expect(await call(g, { ...TUNNEL, 'cf-access-jwt-assertion': token() })).toBe(200)
    // A client-supplied forwarding header does not make a request "internal".
    expect(await call(g, { 'x-forwarded-for': '10.0.0.5' })).toBe(403)
    await g.close()
    // The team's public keys were read once (cached).
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('refuses a token for another application, another team, expired, or signed by another key', async () => {
    practice(true)
    expect(await verifyAccessToken(token())).toBe(true)
    expect(await verifyAccessToken(token({ aud: 'some-other-app' }))).toBe(false)
    expect(await verifyAccessToken(token({ iss: 'https://other-team.cloudflareaccess.com' }))).toBe(false)
    expect(await verifyAccessToken(token({ expired: true }))).toBe(false)
    expect(await verifyAccessToken(token({ key: stranger.privateKey }))).toBe(false)
    expect(await verifyAccessToken(token({ kid: 'unknown-kid' }))).toBe(false)
    const hs = jwt.sign({ email: 'x' }, 'shared-secret', { algorithm: 'HS256', keyid: KID, audience: AUD, issuer: `https://${TEAM}` })
    expect(await verifyAccessToken(hs)).toBe(false)
  })

  it('practice copy without the Access settings (development / tests): nothing is checked, with a warning', async () => {
    practice(true)
    delete process.env['SERVD_SANDBOX_ACCESS_TEAM']
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = await guarded()
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/NOT checked/)
    warn.mockRestore()
    expect(await call(g, TUNNEL)).toBe(200)
    await g.close()
  })
})

// ── The copied live data (last: it touches every row of these tables) ───────

describe('scrub of the copied live data', () => {
  it('live: does nothing', async () => {
    await prisma.setting.deleteMany({ where: { key: SANDBOX_SCRUB_KEY } })
    const before = await prisma.posConnector.findMany({ where: { tenantId: { in: [tenantA, tenantB] } }, select: { id: true, webhookToken: true } })
    expect(await sandboxScrub()).toBeNull()
    const after = await prisma.posConnector.findMany({ where: { tenantId: { in: [tenantA, tenantB] } }, select: { id: true, webhookToken: true } })
    expect(after).toEqual(expect.arrayContaining(before))
    expect(await prisma.setting.findUnique({ where: { key: SANDBOX_SCRUB_KEY } })).toBeNull()
    expect((await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: subA } })).isActive).toBe(true)
  })

  it('practice copy: rotates connector tokens and switches off copied phones, webhooks, push tokens and credentials — once', async () => {
    await prisma.setting.deleteMany({ where: { key: SANDBOX_SCRUB_KEY } })
    const existingRaast = await prisma.posConnector.findFirst({ where: { tenantId: tenantA, kind: 'raast' } })
    const raast = existingRaast ?? await prisma.posConnector.create({
      data: { tenantId: tenantA, kind: 'raast', driver: 'none', webhookToken: newWebhookToken(), settings: {} },
    })
    const device = await prisma.bankSmsDevice.create({
      data: { tenantId: tenantA, connectorId: raast.id, label: 'Counter phone', tokenHash: `${PREFIX}-scrub-hash`, tokenEnc: 'enc', tokenHint: '…abcd', createdById: ownerA.id },
    })
    for (const key of ['fb_page_token', 'fb_page_id', 'ig_user_id', WA_URL_KEY, 'integrations.whatsapp.apiKey', 'integrations.smtp.user', 'integrations.smtp.pass']) {
      await setSetting(key, 'copied-from-live')
    }
    await setSetting('integrations.smtp.host', 'smtp.example.com') // not a credential: kept
    try {
      const pushToken = await prisma.expoPushToken.upsert({
        where: { userId_token: { userId: ownerA.id, token: `ExponentPushToken[${PREFIX}-scrub]` } },
        create: { userId: ownerA.id, token: `ExponentPushToken[${PREFIX}-scrub]`, platform: 'android', device: 'tablet' },
        update: { revokedAt: null },
      })
      // A copied vendor card machine (driver 'http', a real address and key) — final gate.
      const existingTerminal = await prisma.posConnector.findFirst({ where: { tenantId: tenantB, kind: 'terminal' } })
      const vendor = existingTerminal
        ? await prisma.posConnector.update({ where: { id: existingTerminal.id }, data: { driver: 'http', baseUrl: 'https://vendor.example.com', apiKeyEnc: 'enc-live', apiKeyHint: '…live' } })
        : await prisma.posConnector.create({ data: { tenantId: tenantB, kind: 'terminal', driver: 'http', baseUrl: 'https://vendor.example.com', apiKeyEnc: 'enc-live', apiKeyHint: '…live', webhookToken: newWebhookToken(), settings: {} } })
      const secretBefore = (await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: subA } })).secret
      const before = await prisma.posConnector.findMany({ where: { tenantId: { in: [tenantA, tenantB] } }, select: { id: true, webhookToken: true } })
      practice(true)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const result = await sandboxScrub()
      warn.mockRestore()
      expect(result).not.toBeNull()
      expect(result!.connectorTokens).toBeGreaterThanOrEqual(before.length)
      expect(result!.smsDevices).toBeGreaterThanOrEqual(1)
      expect(result!.webhooks).toBeGreaterThanOrEqual(1)
      expect(result!.pushTokens).toBeGreaterThanOrEqual(1)
      expect(result!.settings).toBeGreaterThanOrEqual(7)

      const after = await prisma.posConnector.findMany({ where: { tenantId: { in: [tenantA, tenantB] } }, select: { id: true, webhookToken: true } })
      for (const b of before) {
        const a = after.find((x) => x.id === b.id)!
        expect(a.webhookToken).not.toBe(b.webhookToken)
        expect(a.webhookToken).toMatch(/^[0-9a-f]{64}$/)
      }
      expect((await prisma.bankSmsDevice.findUniqueOrThrow({ where: { id: device.id } })).active).toBe(false)
      expect((await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: subA } })).isActive).toBe(false)
      expect((await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: subA } })).secret).not.toBe(secretBefore)
      expect(result!.vendorConnectors).toBeGreaterThanOrEqual(1)
      expect(await prisma.posConnector.findUniqueOrThrow({ where: { id: vendor.id }, select: { driver: true, baseUrl: true, apiKeyEnc: true, apiKeyHint: true } }))
        .toEqual({ driver: 'test', baseUrl: null, apiKeyEnc: null, apiKeyHint: null })
      expect((await prisma.expoPushToken.findUniqueOrThrow({ where: { id: pushToken.id } })).revokedAt).not.toBeNull()
      const left = await prisma.setting.findMany({ where: { key: { in: ['fb_page_token', WA_URL_KEY, 'integrations.smtp.pass', 'integrations.smtp.host'] } } })
      expect(left.map((r) => r.key)).toEqual(['integrations.smtp.host'])
      expect(await prisma.setting.findUnique({ where: { key: SANDBOX_SCRUB_KEY } })).not.toBeNull()

      // Once per copy: a restart does not rotate the tokens again.
      expect(await sandboxScrub()).toBeNull()
      const again = await prisma.posConnector.findMany({ where: { tenantId: { in: [tenantA, tenantB] } }, select: { id: true, webhookToken: true } })
      expect(again).toEqual(expect.arrayContaining(after))
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      await prisma.bankSmsDevice.deleteMany({ where: { id: device.id } })
      if (!existingRaast) await prisma.posConnector.deleteMany({ where: { id: raast.id } })
      await prisma.setting.deleteMany({ where: { key: { in: ['integrations.smtp.host', SANDBOX_SCRUB_KEY] } } })
      clearConnectorCache()
    }
  })
})

// ── Staff logins from a name and a role (owner, 2026-10-15) ─────────────────

describe('adding staff logins', () => {
  let fnbAuth: Record<string, string> = {}
  beforeAll(async () => {
    const f = await makeUser({ role: 'fnb_manager', tenantId: tenantA, email: `${PREFIX}.fnb@gsfoods.pk` })
    fnbAuth = { authorization: `Bearer ${issueStaffSession({ id: f.id, name: f.name ?? '', email: f.email, role: f.role }).accessToken}` }
  })
  async function track(email: string) {
    const u = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    if (u) users.push(u.id)
    return u
  }

  it('live: an invite still needs an email (and a phone for floor roles), waits for the CEO and returns no password', async () => {
    const noEmail = await inject('POST', '/api/v1/auth/staff/invite', { name: 'Live Nameonly', role: 'cashier' }, fnbAuth)
    expect(noEmail.status).toBe(400)
    const noPhone = await inject('POST', '/api/v1/auth/staff/invite', { name: 'Live Nophone', role: 'cashier', email: `${PREFIX}.live1@gsfoods.pk` }, fnbAuth)
    expect(noPhone.status).toBe(400)
    expect(noPhone.body.error.code).toBe('PHONE_REQUIRED')
    const ok = await inject('POST', '/api/v1/auth/staff/invite', { name: 'Live Invite', role: 'kitchen', email: `${PREFIX}.live2@gsfoods.pk`, phone: `0301${String(STAMP).slice(-7)}` }, fnbAuth)
    expect(ok.status).toBe(201)
    await track(ok.body.email)
    expect(ok.body.status).toBe('pending')
    expect('temporaryPassword' in ok.body).toBe(false)
  })

  it('practice copy: a name and a role make an ACTIVE login that signs in with the password shown once', async () => {
    practice(true)
    const r = await inject('POST', '/api/v1/auth/staff/invite', { name: 'Practice Cashier', role: 'cashier' }, fnbAuth)
    expect(r.status).toBe(201)
    await track(r.body.email)
    expect(r.body.status).toBe('active')
    expect(r.body.email).toMatch(/^practice\.practice\.cashier\.[0-9a-f]{6}@gsfoods\.pk$/)
    expect(r.body.temporaryPassword).toBeTruthy()
    const login = await inject('POST', '/api/v1/auth/login', { email: r.body.email, password: r.body.temporaryPassword })
    expect(login.status).toBe(200)
    expect(login.body.accessToken).toBeTruthy()

    // The same floor login on live servd still cannot use a password.
    practice(false)
    const live = await inject('POST', '/api/v1/auth/login', { email: r.body.email, password: r.body.temporaryPassword })
    expect(live.status).toBe(403)
    expect(live.body.error.code).toBe('USE_CODE_LOGIN')
  })

  it('practice copy: the CEO adds staff from a name and a role too', async () => {
    practice(true)
    const r = await inject('POST', '/api/v1/auth/users', { name: 'Practice Cook', role: 'kitchen', tenantId: tenantA }, adminA)
    expect(r.status).toBe(201)
    await track(r.body.email)
    expect(r.body.email).toMatch(/^practice\.practice\.cook\.[0-9a-f]{6}@gsfoods\.pk$/)
    expect(r.body.accountStatus).toBe('active')
    expect(r.body.temporaryPassword).toBeTruthy()
    // Live: the CEO still has to give an email.
    practice(false)
    const live = await inject('POST', '/api/v1/auth/users', { name: 'Live Cook', role: 'kitchen', tenantId: tenantA }, adminA)
    expect(live.status).toBe(400)
  })
})
