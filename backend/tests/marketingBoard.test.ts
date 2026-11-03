// Marketing board + intern tracker (owner, 2026-11-03). Two companies, real route handlers through Fastify inject.
//
// What this defends:
//   - Visibility: an intern sees ONLY cards they are a resource / owner on (another intern's card 404), never another
//     intern's tracker record, notes or reviews; sees their own notes at once and their own review only once shared.
//   - Only the CEO and marketing_lead holders move stages / manage boards; interns never move, delete or create.
//   - Every non-marketing role (finance, HR, BOH, cashier, procurement, IT, director) is refused the board, the tracker
//     and the report; the intern role is refused centrally outside INTERN_ROUTES.
//   - Company separation: company B gets 404 on A's boards / cards / tracker; resources must be the board company's
//     staff (422); links to another company's dish / promo / campaign are refused (422).
//   - The weekly report counts published (on time / late), slipped and open; the attendance summary reads HR records.
//   - Board seeding: the brand boards per brand, beanzbakes as a PLATFORM board in GS Foods (never a brand).
//   - Delete parks the card in the Trash with its children; restore brings them back.
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
const { flushNotifications } = await import('../src/lib/staffNotify.js')
const { permissionRoutes } = await import('../src/modules/permissions/routes.js')
const { marketingBoardRoutes } = await import('../src/modules/marketingBoard/routes.js')
const { marketingTrackerRoutes, marketingProgressRoutes } = await import('../src/modules/marketingBoard/tracker.js')
const { ensureMarketingBoards } = await import('../src/modules/marketingBoard/boards.js')
const { weeklyReport } = await import('../src/modules/marketingBoard/weekly.js')
const { calendarRoutes } = await import('../src/modules/calendar/routes.js')
const { mediaRoutes } = await import('../src/modules/media/routes.js')
const { trashRoutes } = await import('../src/modules/trash/routes.js')
const { timeClockRoutes } = await import('../src/modules/timeclock/routes.js')
const { notificationRoutes } = await import('../src/modules/notifications/routes.js')
const { crmRoutes } = await import('../src/modules/crm/routes.js')
const { INTERN_ROUTES } = await import('../src/modules/auth/middleware.js')
const { effectiveModulesForUser, DEFAULT_MODULE_ACCESS, PER_PERSON_MODULES, PRESET_LIMITS } = await import('../src/lib/moduleAccess.js')
const { CHILD_ROLES, WORKSPACE_OF_MODULE } = await import('../src/lib/workspaces.js')

const P = `mkb${Date.now()}`
let app: FastifyInstance
let A = ''
let B = ''
let simmerA = ''
let brandB = ''
let boardA = ''
let boardB = ''
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
const call = (key: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: auth(key), ...(payload !== undefined ? { payload: payload as never } : {}) })

async function newCard(key: string, boardId: string, extra: Record<string, unknown> = {}) {
  const r = await call(key, 'POST', '/marketing-board/cards', { boardId, title: `${P} card`, type: 'design_request', deadline: '2026-12-01', ...extra })
  expect(r.statusCode, r.body).toBe(201)
  return r.json() as { id: string; stage: string; resources: Array<{ id: string }> }
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'GS Foods', slug: `${P}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  simmerA = (await prisma.concept.create({ data: { name: 'Simmer', slug: `${P}-simmer`, type: 'restaurant', tenantId: A } })).id
  brandB = (await prisma.concept.create({ data: { name: `${P} Other`, slug: `${P}-other`, type: 'restaurant', tenantId: B } })).id

  await mkUser('ceo', 'admin', [A])
  await mkUser('ceoB', 'admin', [B])
  // Anusha: marketing manager, ticked marketing_lead + marketing_tracker by the CEO.
  await mkUser('lead', 'marketing', [A], { moduleAllow: ['marketing_lead', 'marketing_tracker'] })
  await mkUser('mkt', 'marketing', [A])
  await mkUser('mktB', 'marketing', [B])
  await mkUser('internA', 'marketing_intern', [A], { moduleAllow: ['marketing_lead', 'marketing_tracker'] })
  await mkUser('internB', 'marketing_intern', [A])
  await mkUser('internOther', 'marketing_intern', [B])
  for (const role of ['finance', 'hr', 'boh', 'cashier', 'procurement', 'it', 'fnb_manager', 'foh_management']) await mkUser(role, role, [A])
  await mkUser('director', 'director', [A], { directorConceptIds: [simmerA] })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(permissionRoutes, { prefix: '/permissions' })
    await api.register(marketingBoardRoutes, { prefix: '/marketing-board' })
    await api.register(marketingTrackerRoutes, { prefix: '/marketing-tracker' })
    await api.register(marketingProgressRoutes, { prefix: '/marketing-progress' })
    await api.register(calendarRoutes, { prefix: '/calendar' })
    await api.register(mediaRoutes, { prefix: '/media' })
    await api.register(trashRoutes, { prefix: '/trash' })
    await api.register(timeClockRoutes, { prefix: '/time-clock' })
    await api.register(notificationRoutes, { prefix: '/notifications' })
    await api.register(crmRoutes, { prefix: '/crm' })
  }, { prefix: '/api/v1' })
  await app.ready()

  await ensureMarketingBoards(() => undefined)
  boardA = (await prisma.marketingBoard.findFirstOrThrow({ where: { tenantId: A, conceptId: simmerA } })).id
  boardB = (await prisma.marketingBoard.create({ data: { tenantId: B, name: 'Other', kind: 'brand', conceptId: brandB } })).id
}, 180_000)

afterAll(async () => {
  await flushNotifications()
  await app?.close()
})

// ─── Definitions ──────────────────────────────────────────────────────────────

describe('role and modules', () => {
  it('the intern role is fixed, invitable only by marketing / brand manager / HR / the CEO; lead + tracker are per person', async () => {
    expect(DEFAULT_MODULE_ACCESS.marketing_intern).toEqual(['marketing_board'])
    expect(PRESET_LIMITS.ceoOnlyRoles).toContain('marketing_intern')
    const inviters = Object.entries(CHILD_ROLES).filter(([, l]) => l.includes('marketing_intern' as never)).map(([r]) => r).sort()
    expect(inviters).toEqual(['admin', 'brand_manager', 'hr', 'marketing'])
    for (const m of ['marketing_board', 'marketing_tracker', 'marketing_lead']) expect(WORKSPACE_OF_MODULE.get(m)).toBe('marketing')
    // No role holds the per-person modules by default — not even owner / management ("every module except …").
    for (const [role, mods] of Object.entries(DEFAULT_MODULE_ACCESS)) {
      if (role === 'admin') continue
      for (const m of PER_PERSON_MODULES) expect(mods, `${role} ${m}`).not.toContain(m)
    }
    for (const role of ['marketing', 'brand_manager', 'owner', 'management']) expect(DEFAULT_MODULE_ACCESS[role as 'marketing'], role).toContain('marketing_board')
    for (const role of ['finance', 'hr', 'boh', 'cashier', 'procurement', 'it', 'director', 'fnb_manager', 'foh_management', 'boh_management', 'kitchen', 'foh', 'expediter'])
      expect(DEFAULT_MODULE_ACCESS[role as 'marketing'], role).not.toContain('marketing_board')
    // An intern's moduleAllow never widens it (fixed); the lead's per-person ticks are real.
    expect([...(await effectiveModulesForUser({ role: 'marketing_intern' as never, moduleAllow: ['marketing_lead'], moduleDeny: [] }))]).toEqual(['marketing_board'])
    expect((await effectiveModulesForUser({ role: 'marketing', moduleAllow: ['marketing_lead'], moduleDeny: [] })).has('marketing_lead')).toBe(true)
    expect((await effectiveModulesForUser({ role: 'management', moduleAllow: [], moduleDeny: [] })).has('marketing_tracker')).toBe(false)
  })

  it('a preset save cannot hand the per-person modules to a role; the intern preset and person are fixed', async () => {
    const r = await call('ceo', 'PUT', '/permissions/role-modules', { role: 'marketing', modules: ['crm', 'marketing_board', 'marketing_lead'] })
    expect(r.statusCode, r.body).toBe(200)
    const row = await prisma.roleModuleAccess.findUnique({ where: { role: 'marketing' } })
    expect(row?.modules).not.toContain('marketing_lead')
    await prisma.roleModuleAccess.deleteMany({ where: { role: 'marketing' } })
    expect((await call('ceo', 'PUT', '/permissions/role-modules', { role: 'marketing_intern', modules: ['crm'] })).json().error.code).toBe('INTERN_PRESET_FIXED')
    expect((await call('ceo', 'PUT', `/permissions/users/${U.internA!.id}/modules`, { modules: ['crm'] })).json().error.code).toBe('INTERN_MODULES_FIXED')
  })
})

// ─── Central refusal ──────────────────────────────────────────────────────────

describe('the intern login is refused outside its allow-list', () => {
  it('refuses calendar, media, CRM, the tracker and board deletes; admits the board, its own progress, clock and bell', async () => {
    expect(INTERN_ROUTES.some((r) => r.method === 'DELETE')).toBe(false)
    for (const [m, url] of [['GET', '/calendar'], ['GET', '/media'], ['GET', '/media/upload-url?filename=a.png&contentType=image/png'], ['GET', '/crm/customers'], ['GET', '/marketing-tracker'], ['GET', '/trash']] as const) {
      const r = await call('internA', m, url)
      // 403 either way: the route's own role list (FORBIDDEN) or the central allow-list (INTERN_ROUTE_NOT_ALLOWED).
      expect(r.statusCode, url).toBe(403)
      expect(['INTERN_ROUTE_NOT_ALLOWED', 'FORBIDDEN'], url).toContain(r.json().error.code)
    }
    // ALL_STAFF routes (the role list admits every role) are refused by the central allow-list itself.
    expect((await call('internA', 'GET', '/calendar')).json().error.code).toBe('INTERN_ROUTE_NOT_ALLOWED')
    expect((await call('internA', 'GET', '/media')).json().error.code).toBe('INTERN_ROUTE_NOT_ALLOWED')
    expect((await call('internA', 'GET', '/marketing-board/cards')).statusCode).toBe(200)
    expect((await call('internA', 'GET', '/marketing-progress/me')).statusCode).toBe(200)
    expect((await call('internA', 'GET', '/notifications/unread-count')).statusCode).toBe(200)
    expect((await call('internA', 'GET', '/permissions/me')).statusCode).toBe(200)
  })
})

describe('non-marketing roles never reach the board, tracker or report', () => {
  it('403 for finance, HR, BOH, cashier, procurement, IT, director, F&B and floor managers', async () => {
    for (const key of ['finance', 'hr', 'boh', 'cashier', 'procurement', 'it', 'director', 'fnb_manager', 'foh_management']) {
      for (const url of ['/marketing-board/boards', '/marketing-board/cards', '/marketing-board/report/weekly', '/marketing-tracker', '/marketing-progress/me']) {
        expect((await call(key, 'GET', url)).statusCode, `${key} ${url}`).toBe(403)
      }
      expect((await call(key, 'POST', '/marketing-board/cards', { boardId: boardA, title: 'x', type: 'shoot', deadline: '2026-12-01' })).statusCode, key).toBe(403)
    }
    // A plain marketing login (no per-person tick) holds the board but not the tracker.
    expect((await call('mkt', 'GET', '/marketing-board/boards')).statusCode).toBe(200)
    expect((await call('mkt', 'GET', '/marketing-tracker')).statusCode).toBe(403)
  })
})

// ─── Boards ───────────────────────────────────────────────────────────────────

describe('boards', () => {
  it('seeds the brand board in the brand\'s company and beanzbakes as a platform board of GS Foods, once', async () => {
    const boards = await prisma.marketingBoard.findMany({ where: { tenantId: A }, orderBy: { sort: 'asc' } })
    expect(boards.map((b) => [b.name, b.kind, b.conceptId])).toEqual([['Simmer', 'brand', simmerA], ['beanzbakes (Instagram)', 'platform', null]])
    expect((await ensureMarketingBoards(() => undefined)).created).toBe(0)
    // Renamed, then re-seeded: still one.
    await prisma.marketingBoard.updateMany({ where: { tenantId: A, kind: 'platform' }, data: { name: 'beanz' } })
    await ensureMarketingBoards(() => undefined)
    expect(await prisma.marketingBoard.count({ where: { tenantId: A, kind: 'platform' } })).toBe(1)
    await prisma.marketingBoard.updateMany({ where: { tenantId: A, kind: 'platform' }, data: { name: 'beanzbakes (Instagram)' } })
  })

  it('only the lead / CEO manage boards; a platform has no brand; another company 404', async () => {
    expect((await call('mkt', 'POST', '/marketing-board/boards', { name: 'X', kind: 'platform' })).json().error.code).toBe('BOARD_LEAD_ONLY')
    expect((await call('lead', 'POST', '/marketing-board/boards', { name: 'TikTok', kind: 'platform', conceptId: simmerA })).json().error.code).toBe('PLATFORM_HAS_NO_BRAND')
    const r = await call('lead', 'POST', '/marketing-board/boards', { name: 'TikTok', kind: 'platform' })
    expect(r.statusCode, r.body).toBe(201)
    expect((await call('lead', 'PATCH', `/marketing-board/boards/${r.json().id}`, { archived: true })).json().archivedAt).toBeTruthy()
    expect((await call('lead', 'POST', '/marketing-board/boards', { name: 'B brand', kind: 'brand', conceptId: brandB })).statusCode).toBe(404)
    expect((await call('lead', 'PATCH', `/marketing-board/boards/${boardB}`, { name: 'Mine' })).statusCode).toBe(404)
    const list = (await call('mktB', 'GET', '/marketing-board/boards')).json() as Array<{ id: string }>
    expect(list.map((b) => b.id)).toEqual([boardB])
  })
})

// ─── Cards, visibility, stages ────────────────────────────────────────────────

describe('cards', () => {
  let cardA = ''
  let cardB = ''
  it('board staff create cards; resources must be the company\'s staff; links checked to the company', async () => {
    expect((await call('mkt', 'POST', '/marketing-board/cards', { boardId: boardA, title: 'x', type: 'campaign', deadline: '2026-12-01', resourceIds: [U.mktB!.id] })).json().error.code).toBe('RESOURCE_NOT_IN_COMPANY')
    const menuB = await prisma.menuItem.create({ data: { conceptId: brandB, categoryId: (await prisma.category.create({ data: { conceptId: brandB, name: 'Mains' } })).id, name: 'B dish', priceCents: 100 } as never })
    expect((await call('mkt', 'POST', '/marketing-board/cards', { boardId: boardA, title: 'x', type: 'campaign', deadline: '2026-12-01', link: { kind: 'menu_item', id: menuB.id } })).json().error.code).toBe('LINK_NOT_IN_COMPANY')
    const promoB = await prisma.promoCode.create({ data: { tenantId: B, code: `${P}B`, discountValue: 10, startAt: new Date(), endAt: new Date(Date.now() + 864e5) } as never })
    expect((await call('mkt', 'POST', '/marketing-board/cards', { boardId: boardA, title: 'x', type: 'campaign', deadline: '2026-12-01', link: { kind: 'promo', id: promoB.id } })).json().error.code).toBe('LINK_NOT_IN_COMPANY')
    const campB = await prisma.campaign.create({ data: { tenantId: B, name: 'B camp', channel: 'email', body: 'x' } })
    expect((await call('mkt', 'POST', '/marketing-board/cards', { boardId: boardA, title: 'x', type: 'campaign', deadline: '2026-12-01', link: { kind: 'campaign', id: campB.id } })).json().error.code).toBe('LINK_NOT_IN_COMPANY')
    expect((await call('mkt', 'POST', '/marketing-board/cards', { boardId: boardA, title: 'x', type: 'campaign', deadline: '2026-12-01', referenceLinks: ['javascript:alert(1)'] })).statusCode).toBe(400)
    const promoA = await prisma.promoCode.create({ data: { tenantId: A, code: `${P}A`, discountValue: 10, startAt: new Date(), endAt: new Date(Date.now() + 864e5) } as never })
    const c = await newCard('mkt', boardA, { resourceIds: [U.internA!.id], ownerId: U.mkt!.id, link: { kind: 'promo', id: promoA.id }, referenceLinks: ['https://instagram.com/x'] })
    cardA = c.id
    expect(c.stage).toBe('idea')
    cardB = (await newCard('mkt', boardA, { resourceIds: [U.internB!.id] })).id
    // A card on B's board from company A: 404. An intern cannot create.
    expect((await call('mkt', 'POST', '/marketing-board/cards', { boardId: boardB, title: 'x', type: 'shoot', deadline: '2026-12-01' })).statusCode).toBe(404)
    expect((await call('internA', 'POST', '/marketing-board/cards', { boardId: boardA, title: 'x', type: 'shoot', deadline: '2026-12-01' })).statusCode).toBe(403)
    await flushNotifications()
    expect(await prisma.staffNotification.count({ where: { userId: U.internA!.id, kind: 'marketing.card' } })).toBe(1)
  })

  it('an intern sees only their own cards; another intern\'s card is 404', async () => {
    const mine = (await call('internA', 'GET', '/marketing-board/cards')).json() as Array<{ id: string }>
    expect(mine.map((c) => c.id)).toEqual([cardA])
    expect((await call('internA', 'GET', `/marketing-board/cards/${cardB}`)).statusCode).toBe(404)
    expect((await call('internA', 'PATCH', `/marketing-board/cards/${cardB}`, { title: 'hijack' })).statusCode).toBe(404)
    expect((await call('internA', 'POST', `/marketing-board/cards/${cardB}/comments`, { body: 'hi' })).statusCode).toBe(404)
    const boards = (await call('internA', 'GET', '/marketing-board/boards')).json() as Array<{ id: string; openCards: number }>
    expect(boards.find((b) => b.id === boardA)?.openCards).toBe(1)
    // Company B never sees A's card.
    expect((await call('mktB', 'GET', `/marketing-board/cards/${cardA}`)).statusCode).toBe(404)
    expect((await call('internOther', 'GET', `/marketing-board/cards/${cardA}`)).statusCode).toBe(404)
  })

  it('an intern edits content, comments and uploads; never resources, deadline, stage or delete', async () => {
    const r = await call('internA', 'PATCH', `/marketing-board/cards/${cardA}`, { title: 'New title', brief: 'Draft 2', referenceLinks: ['https://example.com/ref'] })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().brief).toBe('Draft 2')
    expect((await call('internA', 'PATCH', `/marketing-board/cards/${cardA}`, { resourceIds: [U.internA!.id, U.internB!.id] })).json().error.code).toBe('INTERN_CONTENT_ONLY')
    expect((await call('internA', 'PATCH', `/marketing-board/cards/${cardA}`, { deadline: '2027-01-01' })).json().error.code).toBe('INTERN_CONTENT_ONLY')
    expect((await call('internA', 'POST', `/marketing-board/cards/${cardA}/comments`, { body: 'First cut uploaded' })).statusCode).toBe(201)
    expect((await call('internA', 'POST', `/marketing-board/cards/${cardA}/stage`, { stage: 'in_review' })).json().error.code).toBe('STAGE_MOVE_LEAD_ONLY')
    expect((await call('internA', 'DELETE', `/marketing-board/cards/${cardA}`)).statusCode).toBe(403)
    // The card-scoped upload is the intern's file path (R2 not configured in tests → 503 from the one media upload,
    // proving the route reached it); /media itself stays closed to them (above).
    const up = await call('internA', 'GET', `/marketing-board/cards/${cardA}/upload-url?filename=a.png&contentType=image/png`)
    expect([200, 503]).toContain(up.statusCode)
  })

  it('only the lead and the CEO move stages; revisions and publishedAt are recorded', async () => {
    expect((await call('mkt', 'POST', `/marketing-board/cards/${cardA}/stage`, { stage: 'brief_ready' })).json().error.code).toBe('STAGE_MOVE_LEAD_ONLY')
    for (const s of ['brief_ready', 'in_progress', 'in_review']) expect((await call('lead', 'POST', `/marketing-board/cards/${cardA}/stage`, { stage: s })).statusCode).toBe(200)
    expect((await call('ceo', 'POST', `/marketing-board/cards/${cardA}/stage`, { stage: 'in_progress' })).json().revisionCount).toBe(1)
    await call('lead', 'POST', `/marketing-board/cards/${cardA}/stage`, { stage: 'approved' })
    expect((await call('lead', 'POST', `/marketing-board/cards/${cardA}/stage`, { stage: 'in_progress' })).json().revisionCount).toBe(2)
    const pub = (await call('lead', 'POST', `/marketing-board/cards/${cardA}/stage`, { stage: 'published' })).json()
    expect(pub.publishedAt).toBeTruthy()
    expect(pub.outcome).toBe('on_time')
    await flushNotifications()
    expect(await prisma.staffNotification.count({ where: { userId: U.internA!.id, kind: 'marketing.card' } })).toBeGreaterThan(2)
    // Company B's CEO cannot move A's card.
    expect((await call('ceoB', 'POST', `/marketing-board/cards/${cardA}/stage`, { stage: 'idea' })).statusCode).toBe(404)
  })

  it('the calendar shows board cards only to board holders, and refuses to change them', async () => {
    const ceoCal = (await call('ceo', 'GET', '/calendar?from=2026-11-01T00:00:00Z&to=2026-12-31T00:00:00Z')).json() as Array<{ id: string; stage: string | null }>
    expect(ceoCal.some((e) => e.id === cardA && e.stage === 'published')).toBe(true)
    const finCal = (await call('finance', 'GET', '/calendar?from=2026-11-01T00:00:00Z&to=2026-12-31T00:00:00Z')).json() as Array<{ id: string }>
    expect(finCal.some((e) => e.id === cardA)).toBe(false)
    expect((await call('ceo', 'PATCH', `/calendar/${cardA}`, { title: 'x' })).json().error.code).toBe('USE_MARKETING_BOARD')
  })

  it('delete parks the card with its resources and comments in the Trash; restore brings them back', async () => {
    expect((await call('mkt', 'DELETE', `/marketing-board/cards/${cardA}`)).statusCode).toBe(204)
    expect(await prisma.contentEvent.count({ where: { id: cardA } })).toBe(0)
    const entry = await prisma.trashEntry.findFirstOrThrow({ where: { entityId: cardA } })
    const r = await call('ceo', 'POST', `/trash/content_event/${entry.entityId}/restore`, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(await prisma.contentEventResource.count({ where: { eventId: cardA } })).toBe(1)
    expect(await prisma.contentEventComment.count({ where: { eventId: cardA } })).toBe(1)
    expect((await prisma.contentEvent.findUniqueOrThrow({ where: { id: cardA } })).boardId).toBe(boardA)
  })
})

// ─── Weekly report ────────────────────────────────────────────────────────────

describe('weekly report', () => {
  it('counts published on time / late, slipped and open for the week', async () => {
    const board = (await prisma.marketingBoard.create({ data: { tenantId: A, name: `${P} report`, kind: 'platform' } })).id
    const mk = (title: string, deadline: string, stage: string, publishedAt: string | null) => prisma.contentEvent.create({
      data: { tenantId: A, boardId: board, title, type: 'campaign', startDate: new Date(deadline), stage: stage as never, publishedAt: publishedAt ? new Date(publishedAt) : null, createdById: U.mkt!.id },
    })
    // Week of Mon 2026-10-05 (PKT). "now" = Fri 2026-10-09 12:00 PKT.
    await mk('on time', '2026-10-07T12:00:00+05:00', 'published', '2026-10-06T12:00:00+05:00')
    await mk('late pub', '2026-10-06T12:00:00+05:00', 'published', '2026-10-08T12:00:00+05:00')
    await mk('slipped', '2026-10-07T12:00:00+05:00', 'in_review', null)
    await mk('open', '2026-10-10T12:00:00+05:00', 'in_progress', null)
    await mk('next week', '2026-10-13T12:00:00+05:00', 'idea', null)
    const r = await weeklyReport({ id: board }, '2026-10-05', new Date('2026-10-09T12:00:00+05:00'))
    expect(r.totals).toEqual({ published: 2, publishedOnTime: 1, slipped: 2, open: 1 })
    expect(r.boards[0]!.cards.map((c) => [c.title, c.status]).sort()).toEqual([
      ['late pub', 'published_late'], ['on time', 'published_on_time'], ['open', 'open'], ['slipped', 'slipped'],
    ])
    const csv = await call('lead', 'GET', `/marketing-board/report/weekly?weekOf=2026-10-07&boardId=${board}&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('slipped')
    expect((await call('internA', 'GET', '/marketing-board/report/weekly')).statusCode).toBe(403)
    expect(((await call('mktB', 'GET', `/marketing-board/report/weekly?weekOf=2026-10-07&boardId=${board}`)).json()).boards).toEqual([])
  })
})

describe('Monday bell', () => {
  it('tells the company\'s CEO and marketing leads once a week; never interns or plain marketing', async () => {
    const { runMarketingWeeklyForCompany } = await import('../src/modules/marketingBoard/weekly.js')
    const monday = new Date('2026-11-09T09:40:00+05:00')
    expect(await runMarketingWeeklyForCompany(A, monday)).toBe(2)
    expect(await runMarketingWeeklyForCompany(A, monday)).toBe(0)
    const to = (await prisma.staffNotification.findMany({ where: { kind: 'marketing.weekly' }, select: { userId: true, tenantId: true } }))
    expect(to.map((n) => n.userId).sort()).toEqual([U.ceo!.id, U.lead!.id].sort())
    expect(to.every((n) => n.tenantId === A)).toBe(true)
  })
})

// ─── Tracker ──────────────────────────────────────────────────────────────────

describe('tracker', () => {
  let recA = ''
  let recB = ''
  let empA = ''
  it('records per intern (their company\'s HR employees only); another company 404', async () => {
    empA = (await prisma.hrEmployee.create({ data: { tenantId: A, employeeCode: `${P}-1`, fullName: 'Intern A', userId: U.internA!.id } })).id
    const empB = (await prisma.hrEmployee.create({ data: { tenantId: A, employeeCode: `${P}-2`, fullName: 'Intern B', userId: U.internB!.id } })).id
    const empOther = (await prisma.hrEmployee.create({ data: { tenantId: B, employeeCode: `${P}-3`, fullName: 'Other', userId: U.internOther!.id } })).id
    const r = await call('lead', 'POST', '/marketing-tracker', { employeeId: empA, roleLabel: 'Design intern', startDate: '2026-10-01' })
    expect(r.statusCode, r.body).toBe(201)
    recA = r.json().id
    recB = (await call('lead', 'POST', '/marketing-tracker', { employeeId: empB, roleLabel: 'Designer', startDate: '2026-10-01' })).json().id
    expect((await call('lead', 'POST', '/marketing-tracker', { employeeId: empOther, roleLabel: 'x', startDate: '2026-10-01' })).statusCode).toBe(404)
    expect((await call('ceoB', 'GET', `/marketing-tracker/${recA}`)).statusCode).toBe(404)
    // Owner / management without the per-person tick: refused; the CEO: always.
    expect((await call('mkt', 'GET', `/marketing-tracker/${recA}`)).statusCode).toBe(403)
    expect((await call('ceo', 'GET', `/marketing-tracker/${recA}`)).statusCode).toBe(200)
  })

  it('notes show to the intern at once; a review only once shared; never another intern\'s', async () => {
    expect((await call('lead', 'POST', `/marketing-tracker/${recA}/check-ins`, { note: 'Good week, faster turnarounds' })).statusCode).toBe(201)
    expect((await call('lead', 'POST', `/marketing-tracker/${recB}/check-ins`, { note: 'B private note' })).statusCode).toBe(201)
    const rev = await call('lead', 'POST', `/marketing-tracker/${recA}/reviews`, { month: '2026-10', strengths: 'Layouts', improvements: 'Deadlines', recommendation: 'extend' })
    expect(rev.statusCode, rev.body).toBe(201)
    await call('lead', 'POST', `/marketing-tracker/${recB}/reviews`, { month: '2026-10', strengths: 'B', improvements: 'B', recommendation: 'keep' })

    let me = (await call('internA', 'GET', '/marketing-progress/me')).json()
    expect(me.records).toHaveLength(1)
    expect(me.records[0].checkIns.map((c: { note: string }) => c.note)).toEqual(['Good week, faster turnarounds'])
    expect(me.records[0].reviews).toEqual([])
    expect(JSON.stringify(me)).not.toContain('B private note')
    expect(me.records[0].stats.onTime).toBe(1)
    expect(me.records[0].stats.revisions).toBe(2)

    expect((await call('lead', 'POST', `/marketing-tracker/reviews/${rev.json().id}/share`, {})).json().sharedAt).toBeTruthy()
    me = (await call('internA', 'GET', '/marketing-progress/me')).json()
    expect(me.records[0].reviews.map((r: { recommendation: string }) => r.recommendation)).toEqual(['extend'])
    // Intern B sees nothing of A's, and has no shared review of their own.
    const meB = (await call('internB', 'GET', '/marketing-progress/me')).json()
    expect(meB.records[0].reviews).toEqual([])
    expect(JSON.stringify(meB)).not.toContain('faster turnarounds')
    // Interns never reach the manager side.
    expect((await call('internA', 'GET', `/marketing-tracker/${recB}`)).statusCode).toBe(403)
  })

  it('reads attendance from HR records: present / late / absent (incl. a working day with no punch)', async () => {
    const rec = (day: string, category: string, quantity?: number) => prisma.hrRecord.create({
      data: { tenantId: A, section: 'attendance', formVersion: 0, employeeId: empA, status: 'approved', category, startDate: new Date(`${day}T00:00:00Z`), ...(quantity ? { quantity } : {}) } as never,
    })
    // Tue 6 Oct present, Wed 7 late 45 min, Thu 8 no record (rota shift → absent), Fri 9 absent.
    await rec('2026-10-06', 'present')
    await rec('2026-10-07', 'late', 45)
    await rec('2026-10-09', 'absent')
    const a = (await call('lead', 'GET', `/marketing-tracker/${recA}/attendance?from=2026-10-06&to=2026-10-09`)).json()
    expect(a.present).toBe(2)
    expect(a.late).toBe(1)
    expect(a.absent).toBe(2)
  })
})
