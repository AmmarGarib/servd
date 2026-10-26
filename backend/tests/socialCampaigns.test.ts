// Marketing answers of 2026-10-26.
//
// C18 — Facebook / Instagram page PER BRAND, Marketing connects, the CEO approves:
//   - company B's marketing never sees or connects company A's brands (404);
//   - a marketing connect is PENDING (nothing posts with it), the token is sealed
//     (enc:v1) and never returned; the CEO approves in the inbox → approved; a
//     reconnect waits again while the approved page keeps posting; approval
//     swaps them; a stale decision is 409 CONNECTION_CHANGED; marketing cannot
//     approve (403); the CEO's own connect is the approval;
//   - the old servd-wide connection moves to a `legacy` row used for nobody.
// B9 / C19 — scheduled campaigns:
//   - WhatsApp campaigns are refused (422 WHATSAPP_CAMPAIGN_NEEDS_OWN_NUMBER) to
//     schedule or send; schedule / cancel are company-scoped (B → 404);
//   - the worker sends a due campaign ONCE, to its own company's reachable
//     customers only (opt-outs left out), one CampaignSend per recipient.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'

vi.mock('../src/lib/meta-social.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/meta-social.js')>()
  return {
    ...real,
    exchangeCodeForTokens: vi.fn(async () => ({ pageId: 'page-1', pageName: 'Brand A Page', igUserId: 'ig-1', pageToken: 'EAAG-secret-page-token-1' })),
  }
})
vi.mock('../src/lib/notify.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/notify.js')>()
  return { ...real, sendEmail: vi.fn(async () => undefined) }
})

process.env['FACEBOOK_APP_ID'] = 'test-app'
process.env['FACEBOOK_APP_SECRET'] = 'test-secret'
process.env['CAMPAIGN_SEND_PAUSE_MS'] = '0'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { crmRoutes } = await import('../src/modules/crm/routes.js')
const { socialConnectionRoutes, socialCallbackRoutes } = await import('../src/modules/socialConnections/routes.js')
const { approvedConnectionFor, migrateLegacySocialConnection, socialTokenHealth } = await import('../src/modules/socialConnections/service.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')
const { sendDueCampaigns } = await import('../src/workers/campaignSchedule.js')
const { exchangeCodeForTokens } = await import('../src/lib/meta-social.js')
const { sendEmail } = await import('../src/lib/notify.js')

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
let tenantA: string, tenantB: string, conceptA: string, conceptB: string
let custA: string, custOptOut: string, custB: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: UserRole, tenantIds: string[]) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.${RUN}@soc.test`, password: await bcrypt.hash('x-Password-1', 4),
      role, isActive: true, accountStatus: 'active', tenantId: tenantIds[0] ?? null,
    } as never,
  })
  for (const t of tenantIds) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

async function customerWithOrder(key: string, conceptId: string, extra: Record<string, unknown> = {}) {
  const c = await prisma.customer.create({ data: { name: key, email: `${key}.${RUN}@soc.test`, phone: `+92300${Math.floor(1e6 + Math.random() * 8e6)}`, ...extra } as never })
  await prisma.order.create({
    data: { conceptId, customerId: c.id, source: 'pos', status: 'completed', totalCents: 1000, completedAt: new Date(), items: { create: [{ name: 'Tea', quantity: 1, unitPriceCents: 1000 }] } } as never,
  })
  return c.id
}

/** Run the OAuth flow for `who` on `conceptId` up to the callback; returns the redirect. */
async function connect(who: string, conceptId: string) {
  const r = await call(who, 'POST', `/social-connections/${conceptId}/connect`)
  expect(r.statusCode).toBe(200)
  const state = new URL(r.json().url).searchParams.get('state')!
  const cb = await app.inject({ method: 'GET', url: `/api/v1/integrations/social/callback?code=abc&state=${state}` })
  expect(cb.statusCode).toBe(302)
  return cb.headers.location as string
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Soc A', slug: `soc-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Soc B', slug: `soc-b-${RUN}` } })).id
  conceptA = (await prisma.concept.create({ data: { name: `Brand A ${RUN}`, slug: `soc-a-${RUN}`, type: 'restaurant', tenantId: tenantA } as never })).id
  conceptB = (await prisma.concept.create({ data: { name: `Brand B ${RUN}`, slug: `soc-b-${RUN}`, type: 'restaurant', tenantId: tenantB } as never })).id
  await mkUser('mktA', 'marketing', [tenantA])
  await mkUser('mktB', 'marketing', [tenantB])
  await mkUser('ceo', 'admin', [tenantA, tenantB])
  await mkUser('ceoB', 'admin', [tenantB])
  custA = await customerWithOrder('custA', conceptA)
  custOptOut = await customerWithOrder('custOut', conceptA, { marketingOptOutAt: new Date() })
  custB = await customerWithOrder('custB', conceptB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(crmRoutes, { prefix: '/crm' })
    await api.register(socialConnectionRoutes, { prefix: '/social-connections' })
    await api.register(socialCallbackRoutes, { prefix: '/integrations/social' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

describe('C18 social pages per brand', () => {
  it("company B's marketing never sees or connects company A's brand (404)", async () => {
    const list = (await call('mktB', 'GET', '/social-connections')).json()
    expect(list.brands.map((b: { conceptId: string }) => b.conceptId)).toContain(conceptB)
    expect(list.brands.map((b: { conceptId: string }) => b.conceptId)).not.toContain(conceptA)
    expect((await call('mktB', 'POST', `/social-connections/${conceptA}/connect`)).statusCode).toBe(404)
  })

  let first: string
  it('a marketing connect is pending, sealed, never returned, and posts nothing', async () => {
    const loc = await connect('mktA', conceptA)
    expect(loc).toContain('social_connected=')
    expect(loc).toContain('status=pending')
    const row = await prisma.socialConnection.findFirstOrThrow({ where: { conceptId: conceptA, status: 'pending' } })
    first = row.id
    expect(row.tenantId).toBe(tenantA)
    expect(row.token.startsWith('enc:v1:')).toBe(true)
    expect(row.tokenHint).toBe('EAAG…en-1')
    expect(await approvedConnectionFor(conceptA)).toBeNull()
    const list = await call('mktA', 'GET', '/social-connections')
    expect(list.body).not.toContain('secret-page-token')
    expect(list.json().brands.find((b: { conceptId: string }) => b.conceptId === conceptA).pending.id).toBe(first)
    // B's lists and its CEO never see it; marketing cannot approve.
    expect((await call('mktB', 'GET', '/social-connections/requests?status=pending')).json().items).toEqual([])
    expect((await call('mktA', 'POST', `/social-connections/requests/${first}/approve`, { pageId: 'page-1' })).statusCode).toBe(403)
    expect((await call('ceoB', 'POST', `/social-connections/requests/${first}/approve`, { pageId: 'page-1' })).statusCode).toBe(404)
  })

  it("the CEO's inbox lists it; approving makes it the brand's page", async () => {
    const inbox = (await call('ceo', 'GET', '/approvals')).json() as { items: Array<{ type: string; id: string; actions: Array<{ kind: string; path: string; body: unknown }> }> }
    const item = inbox.items.find((i) => i.type === 'social_connection' && i.id === first)!
    expect(item).toBeTruthy()
    const approve = item.actions.find((a) => a.kind === 'approve')!
    expect((await call('ceo', 'POST', `/social-connections/requests/${first}/approve`, { pageId: 'other' })).json().error.code).toBe('CONNECTION_CHANGED')
    const r = await call('ceo', 'POST', approve.path, approve.body)
    expect(r.statusCode).toBe(200)
    expect(await approvedConnectionFor(conceptA)).toEqual({ pageId: 'page-1', igUserId: 'ig-1', token: 'EAAG-secret-page-token-1' })
    expect((await call('ceo', 'POST', approve.path, approve.body)).json().error.code).toBe('CONNECTION_NOT_PENDING')
  })

  it('a reconnect waits for the CEO while the approved page keeps posting; approval swaps them', async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce({ pageId: 'page-2', pageName: 'New Page', igUserId: null, pageToken: 'EAAG-second-token-2' })
    await connect('mktA', conceptA)
    expect((await approvedConnectionFor(conceptA))!.pageId).toBe('page-1')
    const pending = await prisma.socialConnection.findFirstOrThrow({ where: { conceptId: conceptA, status: 'pending' } })
    expect((await call('ceo', 'POST', `/social-connections/requests/${pending.id}/reject`, { pageId: 'page-2', note: 'x' })).statusCode).toBe(400)
    expect((await call('ceo', 'POST', `/social-connections/requests/${pending.id}/approve`, { pageId: 'page-2' })).statusCode).toBe(200)
    expect((await approvedConnectionFor(conceptA))!.pageId).toBe('page-2')
    expect((await prisma.socialConnection.findUniqueOrThrow({ where: { id: first } })).status).toBe('superseded')
  })

  it("the CEO's own connect is the approval", async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce({ pageId: 'page-b', pageName: 'B Page', igUserId: null, pageToken: 'EAAG-b-token-xyz9' })
    expect(await connect('ceo', conceptB)).toContain('status=approved')
    expect((await approvedConnectionFor(conceptB))!.pageId).toBe('page-b')
    expect((await socialTokenHealth()).check).toBe('ok')
  })

  it('the old servd-wide connection becomes a legacy row used for nobody', async () => {
    for (const [key, value] of [['fb_page_id', 'old-page'], ['fb_page_name', 'Old'], ['fb_page_token', 'EAAG-old-global-1'], ['ig_user_id', 'old-ig']]) {
      await prisma.setting.upsert({ where: { key: key! }, create: { key: key!, value: value! }, update: { value: value! } })
    }
    const m = await migrateLegacySocialConnection()
    // Several live brands exist (A and B here): it cannot be tied to one.
    expect(m.moved).toBe('legacy')
    expect(await prisma.setting.count({ where: { key: { in: ['fb_page_id', 'fb_page_name', 'fb_page_token', 'ig_user_id'] } } })).toBe(0)
    const legacy = await prisma.socialConnection.findFirstOrThrow({ where: { status: 'legacy' } })
    expect(legacy.conceptId).toBeNull()
    expect(legacy.token.startsWith('enc:v1:')).toBe(true)
    expect((await migrateLegacySocialConnection()).moved).toBe('none')
    // The CEO is told.
    expect(await prisma.staffNotification.count({ where: { userId: users.ceo!.id, dedupeKey: `social_connection.legacy:${legacy.id}` } })).toBe(1)
  })
})

describe('B9 / C19 scheduled campaigns', () => {
  const inAnHour = () => new Date(Date.now() + 3600_000).toISOString()

  it('WhatsApp campaigns cannot be scheduled or sent (own number first)', async () => {
    const wa = await prisma.campaign.create({ data: { name: 'wa', channel: 'whatsapp', body: 'x', tenantId: tenantA, conceptIds: [] } })
    for (const url of [`/crm/campaigns/${wa.id}/schedule`, `/crm/campaigns/${wa.id}/send`]) {
      const r = await call('mktA', 'POST', url, { scheduledAt: inAnHour() })
      expect(r.statusCode, url).toBe(422)
      expect(r.json().error.code).toBe('WHATSAPP_CAMPAIGN_NEEDS_OWN_NUMBER')
    }
    expect((await call('mktA', 'POST', '/crm/campaigns', { name: 'wa2', channel: 'whatsapp', body: 'x', scheduledAt: inAnHour() })).json().error.code)
      .toBe('WHATSAPP_CAMPAIGN_NEEDS_OWN_NUMBER')
  })

  let campId: string
  it('schedule and cancel are company-scoped; the time must be ahead', async () => {
    campId = (await call('mktA', 'POST', '/crm/campaigns', { name: `sched-${RUN}`, channel: 'email', subject: 'Hello', body: 'Hi https://servd.pk' })).json().id
    expect((await call('mktA', 'POST', `/crm/campaigns/${campId}/schedule`, { scheduledAt: new Date(Date.now() - 1000).toISOString() })).json().error.code).toBe('SCHEDULE_IN_PAST')
    expect((await call('mktB', 'POST', `/crm/campaigns/${campId}/schedule`, { scheduledAt: inAnHour() })).statusCode).toBe(404)
    expect((await call('mktA', 'POST', `/crm/campaigns/${campId}/schedule`, { scheduledAt: inAnHour() })).json().status).toBe('scheduled')
    expect((await call('mktB', 'POST', `/crm/campaigns/${campId}/cancel-schedule`)).statusCode).toBe(404)
    expect((await call('mktA', 'POST', `/crm/campaigns/${campId}/cancel-schedule`)).json().status).toBe('draft')
    expect((await call('mktA', 'POST', `/crm/campaigns/${campId}/cancel-schedule`)).json().error.code).toBe('CAMPAIGN_NOT_SCHEDULED')
    expect((await call('mktA', 'POST', `/crm/campaigns/${campId}/schedule`, { scheduledAt: inAnHour() })).statusCode).toBe(200)
    // Not due yet: the worker leaves it.
    await sendDueCampaigns()
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campId } })).status).toBe('scheduled')
  })

  it('when due, the worker sends it once to its own company, opt-outs left out', async () => {
    vi.mocked(sendEmail).mockClear()
    const at = new Date(Date.now() + 3600_000 + 5000)
    await sendDueCampaigns(at)
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campId } })
    expect(c.status).toBe('sent')
    const sends = await prisma.campaignSend.findMany({ where: { campaignId: campId }, select: { customerId: true, status: true } })
    const ids = sends.map((s) => s.customerId)
    expect(ids).toContain(custA)
    expect(ids).not.toContain(custOptOut)
    expect(ids).not.toContain(custB)
    expect(sends.every((s) => s.status === 'sent')).toBe(true)
    expect(c.recipientCount).toBe(sends.length)
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(sends.length)
    // Never twice: a second sweep and a manual press send nothing more.
    await sendDueCampaigns(at)
    expect((await call('mktA', 'POST', `/crm/campaigns/${campId}/send`)).statusCode).toBe(409)
    expect(await prisma.campaignSend.count({ where: { campaignId: campId } })).toBe(sends.length)
  })

  it('a due WhatsApp campaign (scheduled before this rule) is marked failed, nothing sent', async () => {
    const wa = await prisma.campaign.create({ data: { name: 'wa-old', channel: 'whatsapp', body: 'x', tenantId: tenantA, conceptIds: [], status: 'scheduled', scheduledAt: new Date(Date.now() - 1000) } })
    await sendDueCampaigns()
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: wa.id } })).status).toBe('failed')
    expect(await prisma.campaignSend.count({ where: { campaignId: wa.id } })).toBe(0)
  })
})
