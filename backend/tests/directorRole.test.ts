// Director logins (owner, 2026-10-18): "I need to make a new category of
// login, 'Director'. For Yusuf and Ali, partners in Flipd, to be able to see
// how business is doing." A director sees ONLY their brand(s), everything for
// that brand, strictly read-only.
//
// What this defends:
//   - GET /director/* answers a director with ONLY their brand's figures
//     (another brand of the same company is not in any total), from the
//     existing report functions (brandPnl row = the one brandPnl computes).
//   - Another brand's conceptId → 404, same company or not; a director with
//     no brands sees nothing (empty, never everything).
//   - Secure by default: a director gets 403 on every existing route (orders,
//     accounting, reports, HR, POS, procurement, approvals, permissions
//     writes, the bell, the time clock, any POST), and cannot open a socket.
//   - Only the CEO creates a director and picks the brands (own companies
//     only — 422 otherwise, at least one brand); HR can neither create one
//     (403) nor edit the director preset (403); the preset is fixed (422).
//   - Modules are fixed: director_view only, whatever moduleAllow says.
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
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { postOrderCompletion } = await import('../src/modules/accounting/orderPosting.js')
const { brandPnl } = await import('../src/modules/accounting/reports.js')
const { parsePktStartOfDay, parsePktEndOfDay } = await import('../src/modules/accounting/dates.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { permissionRoutes } = await import('../src/modules/permissions/routes.js')
const { directorRoutes } = await import('../src/modules/director/routes.js')
const { maskContacts } = await import('../src/modules/director/service.js')
const { reportRoutes } = await import('../src/modules/reports/routes.js')
const { accountingRoutes } = await import('../src/modules/accounting/routes.js')
const { orderRoutes } = await import('../src/modules/orders/routes.js')
const { hrRoutes } = await import('../src/modules/hr/routes.js')
const { posRoutes } = await import('../src/modules/pos/routes.js')
const { procurementRoutes } = await import('../src/modules/procurement/routes.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/routes.js')
const { notificationRoutes } = await import('../src/modules/notifications/routes.js')
const { timeClockRoutes } = await import('../src/modules/timeclock/routes.js')
const { reviewRoutes } = await import('../src/modules/reviews/routes.js')
const { complaintRoutes } = await import('../src/modules/complaints/routes.js')
const { conceptRoutes } = await import('../src/modules/concepts/routes.js')
const { ALL_STAFF, DIRECTOR_ROUTES } = await import('../src/modules/auth/middleware.js')
const { effectiveModulesForUser, DEFAULT_MODULE_ACCESS, PRESET_LIMITS } = await import('../src/lib/moduleAccess.js')
const { CHILD_ROLES, WORKSPACE_OF_MODULE } = await import('../src/lib/workspaces.js')

const P = `dir${Date.now()}`
const DAY = '2026-09-15'
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+05:00`)
const RANGE = `dateFrom=${DAY}&dateTo=${DAY}`

let app: FastifyInstance
let tenantA = ''
let tenantB = ''
let flipd = ''
let stackd = ''
let otherCo = ''
type U = { id: string; name: string; email: string; role: string }
const U: Record<string, U> = {}

async function mkUser(key: string, role: string, tenants: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active', ...extra,
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
}
function auth(key: string) {
  const u = U[key]!
  const s = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}` }
}
const get = (key: string, url: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: auth(key) })

async function sale(conceptId: string, totalCents: number, taxCents: number, hhmm: string) {
  const o = await prisma.order.create({
    data: {
      conceptId, source: 'servd', status: 'completed', totalCents, taxCents,
      placedAt: new Date(at(hhmm).getTime() - 20 * 60_000), completedAt: at(hhmm),
      items: { create: [{ name: `${P} burger`, quantity: 1, unitPriceCents: totalCents }] },
    },
  })
  await prisma.payment.create({ data: { orderId: o.id, method: 'cash', amountCents: totalCents, status: 'paid', processedAt: at(hhmm), createdAt: at(hhmm) } })
  expect((await postOrderCompletion(o.id)).posted).toBe(true)
  return o
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  flipd = (await prisma.concept.create({ data: { name: `${P} Flipd`, slug: `${P}-flipd`, type: 'restaurant', tenantId: tenantA } })).id
  stackd = (await prisma.concept.create({ data: { name: `${P} Stackd`, slug: `${P}-stackd`, type: 'restaurant', tenantId: tenantA } })).id
  otherCo = (await prisma.concept.create({ data: { name: `${P} Other`, slug: `${P}-other`, type: 'restaurant', tenantId: tenantB } })).id

  await mkUser('ceo', 'admin', [tenantA])
  await mkUser('ceoB', 'admin', [tenantB])
  await mkUser('hr', 'hr', [tenantA])
  await mkUser('dir', 'director', [tenantA], { directorConceptIds: [flipd], moduleAllow: ['accounting', 'orders'] })
  await mkUser('dirNone', 'director', [tenantA], { directorConceptIds: [] })
  // A director whose list names another company's brand (as if written by
  // hand): the brand is not in a company the login belongs to → dropped.
  await mkUser('dirStale', 'director', [tenantA], { directorConceptIds: [otherCo] })

  // Flipd: 10,000 + 1,500 GST. Stackd: 50,000 + 7,500 GST. Other company: 99,000.
  const f = await sale(flipd, 11_500, 1_500, '13:00')
  const s = await sale(stackd, 57_500, 7_500, '14:00')
  await sale(otherCo, 99_000, 0, '15:00')

  await prisma.orderReview.create({ data: { orderId: f.id, conceptId: flipd, rating: 5, comment: 'Great burger, call me on 0300-1234567 or mail x.y@example.com', createdAt: at('16:00') } })
  await prisma.orderReview.create({ data: { orderId: s.id, conceptId: stackd, rating: 1, comment: `${P} stackd review`, createdAt: at('16:00') } })
  await prisma.orderComplaint.create({ data: { conceptId: flipd, orderId: f.id, title: 'Cold fries', description: 'Fries were cold, my number is +92 300 7654321', category: 'quality', createdAt: at('17:00') } })
  await prisma.orderComplaint.create({ data: { conceptId: flipd, title: 'Ban appeal', description: 'appeal text', category: 'other', kind: 'ban_appeal', createdAt: at('17:00') } })
  await prisma.orderComplaint.create({ data: { conceptId: stackd, title: `${P} stackd complaint`, description: 'x', category: 'service', createdAt: at('17:00') } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(authRoutes, { prefix: '/auth' })
    await api.register(permissionRoutes, { prefix: '/permissions' })
    await api.register(directorRoutes, { prefix: '/director' })
    await api.register(reportRoutes, { prefix: '/reports' })
    await api.register(accountingRoutes, { prefix: '/accounting' })
    await api.register(orderRoutes, { prefix: '/orders' })
    await api.register(hrRoutes, { prefix: '/hr' })
    await api.register(posRoutes, { prefix: '/pos' })
    await api.register(procurementRoutes, { prefix: '/procurement' })
    await registerApprovalsPlugin(api)
    await api.register(notificationRoutes, { prefix: '/notifications' })
    await api.register(timeClockRoutes, { prefix: '/time-clock' })
    await api.register(reviewRoutes, { prefix: '/reviews' })
    await api.register(complaintRoutes, { prefix: '/complaints' })
    await api.register(conceptRoutes, { prefix: '/concepts' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
})

// ─── The role, the modules, the workspace ────────────────────────────────────

describe('Director role: one definition, secure by default', () => {
  it('is not in ALL_STAFF, not invitable by anyone, and its modules are fixed', async () => {
    expect(ALL_STAFF).not.toContain('director')
    for (const [role, list] of Object.entries(CHILD_ROLES)) expect(list, role).not.toContain('director')
    expect(DEFAULT_MODULE_ACCESS.director).toEqual(['director_view'])
    expect(WORKSPACE_OF_MODULE.get('director_view')).toBe('director')
    expect(PRESET_LIMITS.ceoOnlyRoles).toContain('director')
    // moduleAllow cannot widen a director; nobody else holds director_view.
    expect([...(await effectiveModulesForUser({ role: 'director' as never, moduleAllow: ['accounting', 'orders'] }))]).toEqual(['director_view'])
    for (const r of ['owner', 'management', 'finance', 'hr', 'fnb_manager'] as const) {
      expect(DEFAULT_MODULE_ACCESS[r], r).not.toContain('director_view')
      expect(await effectiveModulesForUser({ role: r, moduleAllow: ['director_view'] }), r).not.toContain('director_view')
    }
    expect(await effectiveModulesForUser({ role: 'admin' })).toContain('director_view')
    // The allow-list is GET-only on /director and the login's own session.
    for (const e of DIRECTOR_ROUTES) {
      if (e.path.startsWith('/director')) expect(['GET', 'HEAD']).toContain(e.method)
      else expect(e.path.startsWith('/auth/') || e.path === '/permissions/me', e.path).toBe(true)
    }
  })

  it('/permissions/me: director_view only, the Director workspace only', async () => {
    const r = await get('dir', '/permissions/me')
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json()
    expect(body.role).toBe('director')
    expect(body.modules).toEqual(['director_view'])
    expect(body.workspaces.map((w: { id: string }) => w.id)).toEqual(['director'])
    expect(body.childRoles).toEqual([])
  })
})

// ─── What a director sees ────────────────────────────────────────────────────

describe('GET /director/* — only the director\'s brand', () => {
  it('brands: only Flipd', async () => {
    const r = await get('dir', '/director/brands')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().brands.map((b: { id: string }) => b.id)).toEqual([flipd])
    expect(r.body).not.toContain(stackd)
    expect(r.body).not.toContain('Stackd')
  })

  it('sales: Flipd\'s figures only — Stackd and the other company are in no total', async () => {
    const r = await get('dir', `/director/sales?${RANGE}`)
    expect(r.statusCode, r.body).toBe(200)
    const s = r.json()
    expect(s.brand.id).toBe(flipd)
    expect(s.totals.orders).toBe(1)
    expect(s.totals.net).toBe(10_000)
    expect(s.totals.gross).toBe(11_500)
    expect(s.totals.averageBillCents).toBe(10_000)
    expect(s.daily.reduce((n: number, d: { net: number }) => n + d.net, 0)).toBe(10_000)
    expect(s.byChannel.reduce((n: number, c: { net: number }) => n + c.net, 0)).toBe(10_000)
    expect(s.byTender.totalCents).toBe(11_500)
    expect(r.body).not.toContain(stackd)
    expect(r.body).not.toContain('Stackd')
    expect(r.body).not.toContain(tenantA)
    // The same brand asked for explicitly gives the same answer.
    const again = await get('dir', `/director/sales?conceptId=${flipd}&${RANGE}`)
    expect(again.json().totals).toEqual(s.totals)
  })

  it('P&L: the brand\'s own row from brandPnl — no company or overhead rows', async () => {
    const r = await get('dir', `/director/pnl?${RANGE}`)
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json()
    expect(Object.keys(body).sort()).toEqual(['brand', 'period', 'pnl'])
    expect(body.pnl.conceptId).toBe(flipd)
    // The very row the company-wide brandPnl computes for Flipd.
    const all = await brandPnl([tenantA], parsePktStartOfDay(DAY), parsePktEndOfDay(DAY), [
      { id: flipd, name: `${P} Flipd` }, { id: stackd, name: `${P} Stackd` },
    ])
    const flipdRow = all.brands.find((b) => b.conceptId === flipd)!
    const stackdRow = all.brands.find((b) => b.conceptId === stackd)!
    expect(body.pnl.revenueCents).toBe(flipdRow.revenueCents)
    expect(body.pnl.netProfitCents).toBe(flipdRow.netProfitCents)
    expect(body.pnl.revenueCents).toBeGreaterThan(0)
    expect(body.pnl.revenueCents).toBeLessThan(stackdRow.revenueCents)
    expect(r.body).not.toContain('Company overhead')
    expect(r.body).not.toContain(stackd)
  })

  it('food cost, menu: 200, the brand\'s rows only', async () => {
    const f = await get('dir', `/director/food-cost?${RANGE}`)
    expect(f.statusCode, f.body).toBe(200)
    for (const i of f.json().items) expect(i.conceptId).toBe(flipd)
    expect(f.body).not.toContain(stackd)
    expect(f.body).not.toContain(`${P} Co A`)
    const m = await get('dir', `/director/menu?${RANGE}`)
    expect(m.statusCode, m.body).toBe(200)
    expect(m.body).not.toContain(stackd)
  })

  it('reviews and complaints: the brand\'s own, contact details masked, no ban appeals', async () => {
    const r = await get('dir', `/director/reviews?${RANGE}`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().total).toBe(1)
    expect(r.json().reviews[0].comment).toBe('Great burger, call me on [hidden] or mail [hidden]')
    expect(r.body).not.toContain('stackd review')
    expect(r.body).not.toContain('customer')
    const c = await get('dir', `/director/complaints?${RANGE}`)
    expect(c.statusCode, c.body).toBe(200)
    expect(c.json().stats.total).toBe(1)
    expect(c.json().complaints.map((x: { title: string }) => x.title)).toEqual(['Cold fries'])
    expect(c.json().complaints[0].description).toBe('Fries were cold, my number is [hidden]')
    expect(c.body).not.toContain('stackd complaint')
    expect(c.body).not.toContain('Ban appeal')
  })

  it('CSV export comes from the same handlers', async () => {
    const r = await get('dir', `/director/export.csv?view=sales-daily&${RANGE}`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['content-type']).toContain('text/csv')
    expect(r.body).toContain('100.00')
    expect(r.body).not.toContain('500.00')
    const pnl = await get('dir', `/director/export.csv?view=pnl&${RANGE}`)
    expect(pnl.statusCode).toBe(200)
    expect(pnl.body).toContain('Net profit')
    for (const v of ['journal', 'constructor', '__proto__', 'toString']) {
      expect((await get('dir', `/director/export.csv?view=${v}&${RANGE}`)).statusCode, v).toBe(400)
    }
  })

  it('another brand of the same company, another company\'s brand, a made-up id → 404', async () => {
    for (const id of [stackd, otherCo, '00000000-0000-0000-0000-000000000000']) {
      for (const path of ['sales', 'pnl', 'food-cost', 'menu', 'reviews', 'complaints']) {
        const r = await get('dir', `/director/${path}?conceptId=${id}&${RANGE}`)
        expect(r.statusCode, `${path} ${id}`).toBe(404)
      }
      expect((await get('dir', `/director/export.csv?view=sales-daily&conceptId=${id}&${RANGE}`)).statusCode).toBe(404)
    }
  })

  it('a director with no brands sees nothing — empty, never everything', async () => {
    for (const key of ['dirNone', 'dirStale']) {
      expect((await get(key, '/director/brands')).json().brands).toEqual([])
      const s = await get(key, `/director/sales?${RANGE}`)
      expect(s.statusCode, s.body).toBe(200)
      expect(s.json().brand).toBeNull()
      expect(s.json().totals).toBeNull()
      expect(s.json().topItems).toEqual([])
      expect((await get(key, `/director/pnl?${RANGE}`)).json().pnl).toBeNull()
      expect((await get(key, `/director/reviews?${RANGE}`)).json().reviews).toEqual([])
      expect((await get(key, `/director/complaints?${RANGE}`)).json().complaints).toEqual([])
      const csv = await get(key, `/director/export.csv?view=sales-daily&${RANGE}`)
      expect(csv.statusCode).toBe(200)
      expect(csv.body.replace('﻿', '').trim()).toBe('')
      // Naming a brand does not help.
      expect((await get(key, `/director/sales?conceptId=${otherCo}&${RANGE}`)).statusCode).toBe(404)
    }
  })

  it('the CEO previews any brand of their companies; not another company\'s; other roles are refused', async () => {
    const ceoBrands = (await get('ceo', '/director/brands')).json().brands.map((b: { id: string }) => b.id)
    expect(ceoBrands).toContain(flipd)
    expect(ceoBrands).toContain(stackd)
    expect(ceoBrands).not.toContain(otherCo)
    const s = await get('ceo', `/director/sales?conceptId=${stackd}&${RANGE}`)
    expect(s.statusCode, s.body).toBe(200)
    expect(s.json().totals.net).toBe(50_000)
    expect((await get('ceo', `/director/sales?conceptId=${otherCo}&${RANGE}`)).statusCode).toBe(404)
    expect((await get('ceoB', `/director/sales?conceptId=${flipd}&${RANGE}`)).statusCode).toBe(404)
    expect((await get('hr', `/director/sales?${RANGE}`)).statusCode).toBe(403)
  })

  it('bad dates are 400', async () => {
    expect((await get('dir', '/director/sales?dateFrom=2026-02-30&dateTo=2026-03-01')).statusCode).toBe(400)
    expect((await get('dir', '/director/sales?dateFrom=2026-09-20&dateTo=2026-09-01')).statusCode).toBe(400)
    expect((await get('dir', '/director/sales?dateFrom=2024-01-01&dateTo=2026-09-01')).statusCode).toBe(400)
  })

  it('maskContacts hides phones and emails, keeps short numbers', () => {
    expect(maskContacts('order 12 at table 4, ring 0321 1234567')).toBe('order 12 at table 4, ring [hidden]')
    expect(maskContacts('a.b@c.pk')).toBe('[hidden]')
    expect(maskContacts(null)).toBeNull()
  })
})

// ─── Everything else is refused ──────────────────────────────────────────────

describe('a director is refused on every other route', () => {
  const REFUSED: Array<[string, string, unknown?]> = [
    ['GET', '/orders'],
    ['POST', '/orders/00000000-0000-0000-0000-000000000000/cancel', { reason: 'x' }],
    ['POST', '/accounting/journal', { entryDate: DAY, description: 'x', lines: [] }],
    ['GET', '/accounting/pl-ledger'],
    ['GET', '/accounting/trial-balance'],
    ['GET', '/reports/sales'],
    ['GET', '/reports/top-items'],
    ['GET', `/reports/menu-engineering?conceptId=${'00000000-0000-0000-0000-000000000000'}`],
    ['GET', '/hr/employees'],
    ['GET', '/pos/shifts/current'],
    ['POST', '/pos/shifts/open', { openingFloatCents: 0 }],
    ['GET', '/procurement/suppliers'],
    ['POST', '/procurement/suppliers', { name: 'x' }],
    ['GET', '/permissions/role-modules'],
    ['PUT', '/permissions/role-modules', { role: 'director', modules: ['accounting'] }],
    ['PUT', '/permissions/role-modules', { role: 'foh', modules: ['pos'] }],
    ['GET', '/permissions/workspaces'],
    ['GET', '/approvals'],
    ['GET', '/approvals/counts'],
    ['GET', '/notifications/inbox'],
    ['GET', '/time-clock/status'],
    ['POST', '/auth/clock-in', {}],
    ['GET', '/auth/users'],
    ['POST', '/auth/users', { role: 'director', email: 'x@gsfoods.pk', directorConceptIds: [] }],
    ['PATCH', '/auth/users/00000000-0000-0000-0000-000000000000', { name: 'x' }],
    ['POST', '/auth/staff/invite', { name: 'x', email: 'x2@gsfoods.pk', role: 'cashier' }],
    ['POST', '/auth/pin/change', { pin: '9137' }],
    ['GET', '/reviews'],
    ['GET', '/complaints'],
  ]
  for (const [method, url, payload] of REFUSED) {
    it(`${method} ${url} → 403`, async () => {
      const r = await app.inject({ method: method as never, url: `/api/v1${url}`, headers: auth('dir'), ...(payload !== undefined ? { payload: payload as object } : {}) })
      expect(r.statusCode, r.body).toBe(403)
    })
  }

  it('a route that admits ANY login (bare requireAuth()) still refuses a director — the central gate', async () => {
    for (const url of ['/concepts', '/concepts?view=picker', `/concepts/${flipd}`]) {
      const r = await get('dir', url)
      expect(r.statusCode, `${url} ${r.body}`).toBe(403)
      expect(r.json().error.code).toBe('DIRECTOR_READ_ONLY')
    }
    // …while the same route still serves the CEO.
    expect((await get('ceo', '/concepts?view=picker')).statusCode).toBe(200)
  })

  it('its own session still works: account, logout', async () => {
    const acc = await get('dir', '/auth/account')
    expect(acc.statusCode, acc.body).toBe(200)
    expect(acc.json().role).toBe('director')
    expect(acc.json().canHoldPin).toBe(false)
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: auth('dir'), payload: {} })
    expect(out.statusCode, out.body).toBe(200)
  })
})

// ─── Who makes a director ────────────────────────────────────────────────────

describe('only the CEO creates a director and picks the brands', () => {
  let made = ''

  it('HR cannot create one (invite 403, staff editor 403) nor touch the director preset (403)', async () => {
    const inv = await app.inject({ method: 'POST', url: '/api/v1/auth/staff/invite', headers: auth('hr'), payload: { name: 'Yusuf', email: `${P}.yusuf.hr@gsfoods.pk`, role: 'director' } })
    expect(inv.statusCode, inv.body).toBe(403)
    const create = await app.inject({ method: 'POST', url: '/api/v1/auth/users', headers: auth('hr'), payload: { role: 'director', email: `${P}.yusuf.hr2@gsfoods.pk`, directorConceptIds: [flipd] } })
    expect(create.statusCode, create.body).toBe(403)
    const preset = await app.inject({ method: 'PUT', url: '/api/v1/permissions/role-modules', headers: auth('hr'), payload: { role: 'director', modules: ['director_view', 'accounting'] } })
    expect(preset.statusCode, preset.body).toBe(403)
    expect(preset.json().error.code).toBe('PRESET_CEO_ONLY')
    // Not the CEO either: the preset is fixed.
    const ceoPreset = await app.inject({ method: 'PUT', url: '/api/v1/permissions/role-modules', headers: auth('ceo'), payload: { role: 'director', modules: ['director_view', 'accounting'] } })
    expect(ceoPreset.statusCode, ceoPreset.body).toBe(422)
    expect(ceoPreset.json().error.code).toBe('DIRECTOR_PRESET_FIXED')
    // Even the CEO's own invite path refuses a director (it cannot carry brands).
    const ceoInv = await app.inject({ method: 'POST', url: '/api/v1/auth/staff/invite', headers: auth('ceo'), payload: { name: 'Yusuf', email: `${P}.yusuf.inv@gsfoods.pk`, role: 'director' } })
    expect(ceoInv.statusCode, ceoInv.body).toBe(403)
  })

  it('the CEO creates one: at least one brand, own companies only', async () => {
    const none = await app.inject({ method: 'POST', url: '/api/v1/auth/users', headers: auth('ceo'), payload: { name: 'Yusuf', role: 'director', email: `${P}.yusuf0@gsfoods.pk` } })
    expect(none.statusCode, none.body).toBe(422)
    expect(none.json().error.code).toBe('DIRECTOR_NEEDS_BRAND')
    const cross = await app.inject({ method: 'POST', url: '/api/v1/auth/users', headers: auth('ceo'), payload: { name: 'Yusuf', role: 'director', email: `${P}.yusuf1@gsfoods.pk`, directorConceptIds: [flipd, otherCo] } })
    expect(cross.statusCode, cross.body).toBe(422)
    expect(cross.json().error.code).toBe('BRAND_NOT_IN_COMPANY')
    const notDir = await app.inject({ method: 'POST', url: '/api/v1/auth/users', headers: auth('ceo'), payload: { name: 'Ali', role: 'finance', email: `${P}.ali0@gsfoods.pk`, directorConceptIds: [flipd] } })
    expect(notDir.statusCode, notDir.body).toBe(422)

    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/users', headers: auth('ceo'), payload: { name: 'Yusuf', role: 'director', email: `${P}.yusuf@gsfoods.pk`, directorConceptIds: [flipd] } })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().temporaryPassword).toBeTruthy()
    expect(ok.json().directorConceptIds).toEqual([flipd])
    made = ok.json().id
    const row = await prisma.user.findUniqueOrThrow({ where: { id: made }, select: { tenantId: true, role: true, tenantMemberships: { select: { tenantId: true } } } })
    expect(row.role).toBe('director')
    expect(row.tenantId).toBe(tenantA)
    expect(row.tenantMemberships.map((m) => m.tenantId)).toEqual([tenantA])
    // Another company's CEO cannot give it their brand.
    const otherCeo = await app.inject({ method: 'POST', url: '/api/v1/auth/users', headers: auth('ceoB'), payload: { name: 'Ali', role: 'director', email: `${P}.ali1@gsfoods.pk`, directorConceptIds: [flipd] } })
    expect(otherCeo.statusCode, otherCeo.body).toBe(422)
  })

  it('the CEO changes the brands (own companies only, never none); HR cannot', async () => {
    const add = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${made}`, headers: auth('ceo'), payload: { directorConceptIds: [flipd, stackd] } })
    expect(add.statusCode, add.body).toBe(200)
    expect([...add.json().directorConceptIds].sort()).toEqual([flipd, stackd].sort())
    const cross = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${made}`, headers: auth('ceo'), payload: { directorConceptIds: [otherCo] } })
    expect(cross.statusCode, cross.body).toBe(422)
    const empty = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${made}`, headers: auth('ceo'), payload: { directorConceptIds: [] } })
    expect(empty.statusCode, empty.body).toBe(422)
    const companies = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${made}`, headers: auth('ceo'), payload: { tenantIds: [tenantA] } })
    expect(companies.statusCode, companies.body).toBe(422)
    const hr = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${made}`, headers: auth('hr'), payload: { directorConceptIds: [flipd] } })
    expect(hr.statusCode, hr.body).toBe(403)
    const hrPw = await app.inject({ method: 'POST', url: `/api/v1/auth/users/${made}/reissue-password`, headers: auth('hr'), payload: {} })
    expect(hrPw.statusCode, hrPw.body).toBe(403)
    // A per-person module tick is refused for a director.
    const mods = await app.inject({ method: 'PUT', url: `/api/v1/permissions/users/${made}/modules`, headers: auth('ceo'), payload: { modules: ['director_view', 'accounting'] } })
    expect(mods.statusCode, mods.body).toBe(422)
    // Becoming another role drops the brands.
    const demote = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${made}`, headers: auth('ceo'), payload: { role: 'finance' } })
    expect(demote.statusCode, demote.body).toBe(200)
    expect(demote.json().directorConceptIds).toEqual([])
    // And back to director needs brands again.
    const back = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${made}`, headers: auth('ceo'), payload: { role: 'director' } })
    expect(back.statusCode, back.body).toBe(422)
    const back2 = await app.inject({ method: 'PATCH', url: `/api/v1/auth/users/${made}`, headers: auth('ceo'), payload: { role: 'director', directorConceptIds: [stackd] } })
    expect(back2.statusCode, back2.body).toBe(200)
  })
})
