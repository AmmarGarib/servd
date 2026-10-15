// Ban appeals via the help desk (DLV-appeals, 2026-10-15).
//
// Two companies A and B. Blocks are servd-wide (owner, 2026-10-15) — an appeal
// is one queue that any company in the customer's history sees; ordinary
// complaints stay inside their brand's company.
//
//   - GET /storefront/account/blocks lists only the caller's blocks
//   - an appeal lands on an A brand even when the client sends a B slug
//   - B's complaints list does not show an A-only customer's appeal; B's PATCH → 404
//   - GET /complaints/stats is scoped (fail-open tenantFilter is gone)
//   - fnb_manager (complaints, no crm) lifts through the widened gate → the appeal resolves
//   - a second open appeal → 409 APPEAL_OPEN; a decline then a re-appeal → 429 APPEAL_TOO_SOON
//   - release-contact resolves the appeal
//   - PATCH 'resolved' on an appeal → 409 APPEAL_DECIDED_BY_LIFT
//   - a non-manager with the Complaints module sees no ban details; a cashier is refused
//   - WhatsApp APPEAL works only when the switch is on; the brand pick is checked
//   - with the switch off, the storefront routes → 404
//   - the switch is CEO only
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const sentWa: Array<{ to: string; text: string }> = []
vi.mock('../src/lib/whatsapp.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/whatsapp.js')>()),
  sendText: async (to: string, text: string) => { sentWa.push({ to, text }); return {} },
  sendButtons: async (to: string, text: string) => { sentWa.push({ to, text }); return {} },
  sendInteractiveList: async (to: string, _h: string, text: string) => { sentWa.push({ to, text }); return {} },
}))
const notices: Array<{ to: string; body: string }> = []
vi.mock('../src/lib/notify.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/notify.js')>()),
  sendPhoneMessage: async (to: string, body: string) => { notices.push({ to, body }) },
  sendEmail: async (to: string, _s: string, body: string) => { notices.push({ to, body }) },
}))

const Fastify = (await import('fastify')).default
const { ZodError } = await import('zod')
const bcrypt = (await import('bcryptjs')).default
const jwt = (await import('jsonwebtoken')).default
const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { complaintRoutes } = await import('../src/modules/complaints/routes.js')
const { crmRoutes } = await import('../src/modules/crm/routes.js')
const { default: banAppealRoutes, resetBanAppealRateLimit } = await import('../src/modules/storefront/banAppealRoutes.js')
const { BAN_APPEALS_SETTING } = await import('../src/modules/complaints/appeals.js')
const { handleWaMessage } = await import('../src/adapters/whatsapp/conversation.js')
const { clearSession } = await import('../src/lib/wa-session.js')

type App = Awaited<ReturnType<typeof Fastify>>
const RUN = Math.random().toString(36).slice(2, 8)
let app: App
let tenantA: string, tenantB: string, conceptA: string, conceptA2: string, conceptB: string, slugB: string
const staff: Record<string, { id: string; token: string }> = {}
let seq = 0
const newPhone = () => `92312${RUN.replace(/[^0-9]/g, '').padEnd(3, '4').slice(0, 3)}${String(1000 + ++seq).slice(-4)}`

async function mkStaff(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.${RUN}@appeals.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as 'admin', isActive: true, accountStatus: 'active', tenantId,
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const customerToken = (id: string) => jwt.sign({ sub: id, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '1h' })

const asStaff = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: { authorization: `Bearer ${staff[who]!.token}` } })
const asCustomer = (id: string, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: { authorization: `Bearer ${customerToken(id)}` } })

async function mkCustomer(key: string, conceptIds: string[], phone = newPhone()) {
  const c = await prisma.customer.create({ data: { name: key, email: `${key}.${RUN}@appeals.test`, phone } })
  for (const conceptId of conceptIds) {
    await prisma.order.create({
      data: {
        conceptId, customerId: c.id, source: 'pos', status: 'completed', totalCents: 10_000, completedAt: new Date(),
        items: { create: [{ name: 'Tea', quantity: 1, unitPriceCents: 10_000 }] },
      },
    })
  }
  return c
}

async function mkBan(customer: { id: string; email: string | null; phone: string | null }, tenantId: string | null, byStaff = false) {
  return prisma.customerBan.create({
    data: {
      customerId: customer.id, email: customer.email?.toLowerCase() ?? null, phone: customer.phone, tenantId,
      reason: byStaff ? 'Staff block' : 'Auto-banned: 3 active strikes', bannedById: byStaff ? staff['mgrA']!.id : null,
    },
  })
}

async function setAppeals(enabled: boolean) {
  await prisma.setting.upsert({
    where: { key: BAN_APPEALS_SETTING },
    create: { key: BAN_APPEALS_SETTING, value: JSON.stringify({ enabled }) },
    update: { value: JSON.stringify({ enabled }) },
  })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Appeals A', slug: `ap-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Appeals B', slug: `ap-b-${RUN}` } })).id
  const mk = async (name: string, tenantId: string) => {
    const slug = `ap-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}-${RUN}`
    const c = await prisma.concept.create({ data: { name, slug, type: 'restaurant', tenantId, taxRateCash: 15, taxRateCard: 8 } })
    const cat = await prisma.category.create({ data: { conceptId: c.id, name: 'Mains' } })
    await prisma.menuItem.create({ data: { conceptId: c.id, categoryId: cat.id, name: `${name} plate`, priceCents: 100_000 } })
    return { id: c.id, slug }
  }
  conceptA = (await mk('Alpha One', tenantA)).id
  conceptA2 = (await mk('Alpha Two', tenantA)).id
  const b = await mk('Bravo One', tenantB)
  conceptB = b.id
  slugB = b.slug

  await mkStaff('ceo', 'admin', tenantA)
  await mkStaff('mgrA', 'manager', tenantA)
  await mkStaff('mgrB', 'manager', tenantB)
  await mkStaff('fnbA', 'fnb_manager', tenantA)
  await mkStaff('mktA', 'marketing', tenantA)
  await mkStaff('cashA', 'cashier', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: (err as { details?: unknown }).details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(complaintRoutes, { prefix: '/complaints' })
  await app.register(crmRoutes, { prefix: '/crm' })
  await app.register(banAppealRoutes, { prefix: '/storefront' })
  await app.ready()
}, 60_000)

beforeEach(async () => {
  sentWa.length = 0
  notices.length = 0
  resetBanAppealRateLimit()
  await setAppeals(true)
})

afterAll(async () => {
  await app?.close()
})

const appeal = (customerId: string, banId: string, extra: object = {}) =>
  asCustomer(customerId, 'POST', '/storefront/account/ban-appeals', { banId, reason: 'new_number', message: 'This number is new to me, please review.', ...extra })

describe('the appeals switch', () => {
  it('off: storefront routes answer 404; only the CEO reads or flips it, audited', async () => {
    const c = await mkCustomer('sw', [conceptA])
    const ban = await mkBan(c, tenantA)
    await setAppeals(false)
    expect((await asCustomer(c.id, 'GET', '/storefront/account/blocks')).statusCode).toBe(404)
    expect((await appeal(c.id, ban.id)).statusCode).toBe(404)

    expect((await asStaff('mgrA', 'PUT', '/complaints/settings/appeals', { enabled: true, reason: 'go live please' })).statusCode).toBe(403)
    const put = await asStaff('ceo', 'PUT', '/complaints/settings/appeals', { enabled: true, reason: 'go live please' })
    expect(put.statusCode).toBe(200)
    expect(put.json().enabled).toBe(true)
    expect((await asStaff('ceo', 'GET', '/complaints/settings/appeals')).json().enabled).toBe(true)
    expect(await prisma.auditLog.count({ where: { action: 'ban_appeals.enable', userId: staff['ceo']!.id } })).toBe(1)
    expect((await asCustomer(c.id, 'GET', '/storefront/account/blocks')).statusCode).toBe(200)
  })
})

describe('storefront', () => {
  it('lists only the caller\'s blocks, never naming a company', async () => {
    const c = await mkCustomer('blk', [conceptA])
    const other = await mkCustomer('other', [conceptA])
    const mine = await mkBan(c, tenantA)
    await mkBan(other, tenantA)
    const lifted = await mkBan(c, tenantB, true)
    await prisma.customerBan.update({ where: { id: lifted.id }, data: { liftedAt: new Date(), liftReason: 'x' } })

    const res = await asCustomer(c.id, 'GET', '/storefront/account/blocks')
    expect(res.statusCode).toBe(200)
    const blocks = res.json().blocks as Array<{ banId: string; companyName: string | null; appeal: { status: string } }>
    expect(blocks.map((b) => b.banId)).toEqual([mine.id])
    expect(blocks[0]!.companyName).toBeNull()
    expect(blocks[0]!.appeal.status).toBe('none')
  })

  it('an appeal lands on an A brand even when the client sends a B slug; a foreign ban → 404', async () => {
    const c = await mkCustomer('slug', [conceptA2])
    const ban = await mkBan(c, tenantA)
    const res = await appeal(c.id, ban.id, { conceptSlug: slugB })
    expect(res.statusCode).toBe(201)
    const row = await prisma.orderComplaint.findUniqueOrThrow({ where: { id: res.json().appealId } })
    expect(row.kind).toBe('ban_appeal')
    expect(row.banId).toBe(ban.id)
    expect(row.conceptId).toBe(conceptA2)   // the customer's latest A brand, never B's
    expect(row.contactPhone).toBe(c.phone)  // from the session

    const stranger = await mkCustomer('stranger', [conceptA])
    expect((await appeal(stranger.id, ban.id)).statusCode).toBe(404)

    const blocks = (await asCustomer(c.id, 'GET', '/storefront/account/blocks')).json().blocks
    expect(blocks[0].appeal.status).toBe('open')
  })

  it('a second open appeal → 409; a decline then a re-appeal within 30 days → 429', async () => {
    const c = await mkCustomer('dup', [conceptA])
    const ban = await mkBan(c, tenantA)
    const first = await appeal(c.id, ban.id)
    expect(first.statusCode).toBe(201)
    const second = await appeal(c.id, ban.id)
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('APPEAL_OPEN')

    const close = await asStaff('mgrA', 'PATCH', `/complaints/${first.json().appealId}`, { status: 'closed' })
    expect(close.statusCode).toBe(200)
    expect(close.json().resolution).toBe('Block kept after review')
    expect(notices.some((n) => n.to === c.phone && /stays in place/.test(n.body))).toBe(true)

    const again = await appeal(c.id, ban.id)
    expect(again.statusCode).toBe(429)
    expect(again.json().error.code).toBe('APPEAL_TOO_SOON')
  })

  it('rate limits to 3 submissions per hour per customer', async () => {
    const c = await mkCustomer('rl', [conceptA])
    const ban = await mkBan(c, tenantA)
    const codes: number[] = []
    for (let i = 0; i < 4; i++) codes.push((await appeal(c.id, ban.id)).statusCode)
    expect(codes).toEqual([201, 409, 409, 429])
  })
})

describe('the help-desk queue', () => {
  it('is scoped: B does not see an A-only customer\'s appeal, B\'s PATCH → 404, /stats scoped', async () => {
    const c = await mkCustomer('scope', [conceptA])
    const ban = await mkBan(c, tenantA)
    const id = (await appeal(c.id, ban.id)).json().appealId as string
    // An ordinary complaint at B's brand.
    const bComplaint = await prisma.orderComplaint.create({ data: { conceptId: conceptB, title: 'Cold', description: 'cold food', category: 'quality' } })

    const listA = (await asStaff('mgrA', 'GET', '/complaints?kind=ban_appeal')).json()
    expect(listA.complaints.map((r: { id: string }) => r.id)).toContain(id)
    const listB = (await asStaff('mgrB', 'GET', '/complaints')).json()
    expect(listB.complaints.map((r: { id: string }) => r.id)).not.toContain(id)
    expect(listB.complaints.map((r: { id: string }) => r.id)).toContain(bComplaint.id)
    expect((await asStaff('mgrA', 'GET', '/complaints')).json().complaints.map((r: { id: string }) => r.id)).not.toContain(bComplaint.id)
    expect((await asStaff('mgrB', 'PATCH', `/complaints/${id}`, { status: 'closed' })).statusCode).toBe(404)
    expect((await asStaff('mgrA', 'PATCH', `/complaints/${bComplaint.id}`, { status: 'resolved' })).statusCode).toBe(404)

    const statsB = (await asStaff('mgrB', 'GET', '/complaints/stats')).json().stats
    const openAtB = await prisma.orderComplaint.count({ where: { status: 'open', concept: { tenantId: tenantB } } })
    expect(statsB.open).toBe(openAtB)

    // ?kind=complaint never returns appeals.
    const onlyComplaints = (await asStaff('mgrA', 'GET', '/complaints?kind=complaint')).json().complaints
    expect(onlyComplaints.every((r: { kind: string }) => r.kind === 'complaint')).toBe(true)
  })

  it('servd-wide: a company in the customer\'s history sees the appeal', async () => {
    const c = await mkCustomer('shared', [conceptA, conceptB])
    const ban = await mkBan(c, tenantA)
    const id = (await appeal(c.id, ban.id)).json().appealId as string
    const listB = (await asStaff('mgrB', 'GET', '/complaints?kind=ban_appeal')).json()
    expect(listB.complaints.map((r: { id: string }) => r.id)).toContain(id)
  })

  it('managers see the ban and strikes; a non-manager with Complaints does not; a cashier is refused', async () => {
    const c = await mkCustomer('details', [conceptA])
    const ban = await mkBan(c, tenantA)
    await prisma.customerStrike.create({ data: { customerId: c.id, kind: 'cod_refused', severity: 1, tenantId: tenantA, reason: 'refused at door' } })
    const id = (await appeal(c.id, ban.id)).json().appealId as string

    const mgr = (await asStaff('mgrA', 'GET', '/complaints?kind=ban_appeal')).json().complaints.find((r: { id: string }) => r.id === id)
    expect(mgr.ban.id).toBe(ban.id)
    expect(mgr.ban.auto).toBe(true)
    expect(mgr.strikes).toHaveLength(1)

    const mkt = await asStaff('mktA', 'GET', '/complaints?kind=ban_appeal')
    expect(mkt.statusCode).toBe(200)
    const row = mkt.json().complaints.find((r: { id: string }) => r.id === id)
    expect(row).toBeTruthy()
    expect(row.ban).toBeUndefined()
    expect(row.strikes).toBeUndefined()
    expect(row.contactPhone).toBeNull()

    expect((await asStaff('cashA', 'GET', '/complaints')).statusCode).toBe(403)
  })

  it('PATCH resolved on an appeal → 409 APPEAL_DECIDED_BY_LIFT', async () => {
    const c = await mkCustomer('resolve', [conceptA])
    const ban = await mkBan(c, tenantA)
    const id = (await appeal(c.id, ban.id)).json().appealId as string
    const res = await asStaff('mgrA', 'PATCH', `/complaints/${id}`, { status: 'resolved' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('APPEAL_DECIDED_BY_LIFT')
  })

  it('fnb_manager (complaints, no crm) lifts through the widened gate and the appeal resolves', async () => {
    const c = await mkCustomer('lift', [conceptA])
    const ban = await mkBan(c, tenantA)
    const id = (await appeal(c.id, ban.id)).json().appealId as string
    const lift = await asStaff('fnbA', 'POST', `/crm/bans/${ban.id}/lift`, { reason: 'Number changed hands' })
    expect(lift.statusCode).toBe(200)
    const row = await prisma.orderComplaint.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('resolved')
    expect(row.resolution).toMatch(/^Block lifted/)
    expect((await prisma.customerBan.findUniqueOrThrow({ where: { id: ban.id } })).liftedAt).not.toBeNull()
  })

  it('release-contact resolves the appeal and clears the phone on the ban and the account', async () => {
    const c = await mkCustomer('release', [conceptA])
    const ban = await mkBan(c, tenantA)
    const id = (await appeal(c.id, ban.id)).json().appealId as string
    const res = await asStaff('mgrA', 'POST', `/crm/bans/${ban.id}/release-contact`, { contact: 'phone', reason: 'recycled number' })
    expect(res.statusCode).toBe(200)
    expect((await prisma.orderComplaint.findUniqueOrThrow({ where: { id } })).status).toBe('resolved')
    expect((await prisma.customerBan.findUniqueOrThrow({ where: { id: ban.id } })).phone).toBeNull()
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).phone).toBeNull()
  })
})

describe('WhatsApp', () => {
  const text = (phone: string, body: string) => handleWaMessage(phone, { from: phone, type: 'text', text: { body } })

  it('APPEAL creates one appeal with contactPhone = the sender, only while appeals are on', async () => {
    const phone = newPhone()
    const c = await mkCustomer('wa', [conceptA], phone)
    const ban = await mkBan(c, tenantA)

    await setAppeals(false)
    await clearSession(phone)
    await text(phone, 'appeal')
    expect(await prisma.orderComplaint.count({ where: { banId: ban.id } })).toBe(0)

    await setAppeals(true)
    await clearSession(phone)
    sentWa.length = 0
    await text(phone, 'APPEAL')
    const rows = await prisma.orderComplaint.findMany({ where: { banId: ban.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.contactPhone).toBe(phone)
    expect(rows[0]!.kind).toBe('ban_appeal')
    expect(sentWa.at(-1)!.text).toMatch(/help desk/)

    await text(phone, 'appeal')
    expect(await prisma.orderComplaint.count({ where: { banId: ban.id } })).toBe(1)
    expect(sentWa.at(-1)!.text).toMatch(/already with our help desk/)
  })

  it('the brand pick is refused for a blocked number, with the APPEAL hint only while on', async () => {
    const phone = newPhone()
    const c = await mkCustomer('wapick', [conceptA], phone)
    await mkBan(c, tenantA)

    await setAppeals(true)
    await clearSession(phone)
    await text(phone, 'hi')
    sentWa.length = 0
    await handleWaMessage(phone, { from: phone, type: 'interactive', list_reply: { id: `brand:${conceptA}`, title: 'x' } })
    const on = sentWa.map((m) => m.text).join('\n')
    expect(on).toMatch(/can't order/)
    expect(on).toMatch(/Reply APPEAL/)
    expect(on).not.toMatch(/You are ordering from/)

    await setAppeals(false)
    await clearSession(phone)
    await text(phone, 'hi')
    sentWa.length = 0
    await handleWaMessage(phone, { from: phone, type: 'interactive', list_reply: { id: `brand:${conceptA}`, title: 'x' } })
    const off = sentWa.map((m) => m.text).join('\n')
    expect(off).toMatch(/can't order/)
    expect(off).not.toMatch(/APPEAL/)
  })
})
