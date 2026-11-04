// Task lists (owner, 2026-11-04): a board card or a content-calendar entry is a task of the people on it; they are
// emailed when put on it; it leaves their list only once marked done AND "Approved by leadership". Two companies.
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const sent: Array<{ to: string; subject: string }> = []
vi.mock('../src/lib/notify.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/notify.js')>()
  return { ...real, sendEmail: vi.fn(async (to: string, subject: string) => { sent.push({ to, subject }) }) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { flushNotifications } = await import('../src/lib/staffNotify.js')
const { marketingBoardRoutes } = await import('../src/modules/marketingBoard/routes.js')
const { myTasksRoutes } = await import('../src/modules/marketingBoard/tasks.js')
const { calendarRoutes } = await import('../src/modules/calendar/routes.js')
const { INTERN_ROUTES } = await import('../src/modules/auth/middleware.js')

const P = `mtk${Date.now()}`
let app: FastifyInstance
let A = ''
let B = ''
let boardA = ''
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}

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
const call = (key: string, method: string, url: string, payload?: unknown) => {
  const u = U[key]!
  const s = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never })
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: { authorization: `Bearer ${s.accessToken}` }, ...(payload !== undefined ? { payload: payload as never } : {}) })
}
const code = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code
type Task = { id: string; status: string; kind: string }
const list = async (key: string) => (await call(key, 'GET', '/my-tasks')).json() as { open: Task[]; awaitingApproval: Task[]; done: Task[]; toApprove: Task[]; canApprove: boolean }
const ids = (ts: Task[]) => ts.map((t) => t.id)

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `${P} A`, slug: `${P}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: `${P} B`, slug: `${P}-b` } })).id
  const concept = (await prisma.concept.create({ data: { name: `${P} Simmer`, slug: `${P}-simmer`, type: 'restaurant', tenantId: A } })).id
  boardA = (await prisma.marketingBoard.create({ data: { tenantId: A, name: 'Simmer', kind: 'brand', conceptId: concept } })).id
  await mkUser('ceo', 'admin', [A])
  await mkUser('lead', 'marketing', [A], { moduleAllow: ['marketing_lead'] })
  await mkUser('mkt', 'marketing', [A])
  await mkUser('designer', 'marketing', [A])
  await mkUser('intern', 'marketing_intern', [A])
  await mkUser('fnb', 'fnb_manager', [A])
  await mkUser('chef', 'boh_management', [A])
  await mkUser('mktB', 'marketing', [B])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(marketingBoardRoutes, { prefix: '/marketing-board' })
    await api.register(myTasksRoutes, { prefix: '/my-tasks' })
    await api.register(calendarRoutes, { prefix: '/calendar' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await flushNotifications()
  await app?.close()
})
beforeEach(() => { sent.length = 0 })

describe('a board card is a task of its people', () => {
  let card = ''
  it('putting people on a card puts it on their list and emails them (never the actor)', async () => {
    const r = await call('mkt', 'POST', '/marketing-board/cards', {
      boardId: boardA, title: `${P} reel`, type: 'design_request', deadline: '2026-12-01', resourceIds: [U.designer!.id, U.intern!.id],
    })
    expect(r.statusCode, r.body).toBe(201)
    card = r.json().id
    await flushNotifications()
    expect(sent.map((s) => s.to).sort()).toEqual([U.designer!.email, U.intern!.email].sort())
    expect(sent[0]!.subject).toContain(`${P} reel`)
    expect(ids((await list('designer')).open)).toContain(card)
    expect(ids((await list('intern')).open)).toContain(card)
    expect(ids((await list('mkt')).open)).not.toContain(card)
    expect(INTERN_ROUTES.some((x) => x.path === '/my-tasks/*' && x.method === 'POST')).toBe(true)
  })

  it('done by someone on it → waiting for leadership; only leadership approves, never before done', async () => {
    expect(code(await call('lead', 'POST', `/my-tasks/${card}/approve`, { approved: true }))).toBe('TASK_NOT_DONE')
    expect((await call('mkt', 'POST', `/my-tasks/${card}/done`, { done: true })).statusCode).toBe(404) // not on it, not a lead
    const d = await call('intern', 'POST', `/my-tasks/${card}/done`, { done: true })
    expect(d.statusCode, d.body).toBe(200)
    expect(d.json().status).toBe('awaiting_approval')
    expect(ids((await list('designer')).awaitingApproval)).toContain(card)
    expect(ids((await list('lead')).toApprove)).toContain(card)
    expect((await call('intern', 'POST', `/my-tasks/${card}/approve`, { approved: true })).statusCode).toBe(403)
    expect((await call('designer', 'POST', `/my-tasks/${card}/approve`, { approved: true })).statusCode).toBe(403)
    const a = await call('lead', 'POST', `/my-tasks/${card}/approve`, { approved: true })
    expect(a.statusCode, a.body).toBe(200)
    const mine = await list('designer')
    expect(ids(mine.open)).not.toContain(card)
    expect(ids(mine.awaitingApproval)).not.toContain(card)
    expect(ids(mine.done)).toContain(card)
    const shown = (await call('lead', 'GET', `/marketing-board/cards/${card}`)).json()
    expect(shown.taskStatus).toBe('done')
  })

  it('once approved it cannot be un-done; leadership may reopen it to the list', async () => {
    expect(code(await call('designer', 'POST', `/my-tasks/${card}/done`, { done: false }))).toBe('TASK_APPROVED')
    expect((await call('lead', 'POST', `/my-tasks/${card}/approve`, { approved: false })).statusCode).toBe(200)
    expect(ids((await list('designer')).open)).toContain(card)
  })

  it('a lead on the task never approves it; the CEO may', async () => {
    const r = await call('mkt', 'POST', '/marketing-board/cards', { boardId: boardA, title: `${P} own`, type: 'shoot', deadline: '2026-12-02', resourceIds: [U.lead!.id] })
    const id = r.json().id
    expect((await call('lead', 'POST', `/my-tasks/${id}/done`, { done: true })).statusCode).toBe(200)
    expect(code(await call('lead', 'POST', `/my-tasks/${id}/approve`, { approved: true }))).toBe('SELF_APPROVAL_BLOCKED')
    expect((await call('ceo', 'POST', `/my-tasks/${id}/approve`, { approved: true })).statusCode).toBe(200)
  })
})

describe('a content-calendar entry is a task of its assignee', () => {
  let entry = ''
  it('assigning it puts it on their list with a bell + email; whoever set it approves it', async () => {
    const r = await call('fnb', 'POST', '/calendar', { title: `${P} menu shoot`, type: 'shoot', startDate: '2026-12-05T10:00:00.000Z', assigneeId: U.chef!.id })
    expect(r.statusCode, r.body).toBe(201)
    entry = r.json().id
    await flushNotifications()
    expect(sent.map((s) => s.to)).toEqual([U.chef!.email])
    const bell = await prisma.staffNotification.findFirst({ where: { userId: U.chef!.id, entityId: entry, kind: 'marketing.task' } })
    expect(bell?.tenantId).toBe(A)
    expect((await list('chef')).open.find((t) => t.id === entry)?.kind).toBe('calendar')
    expect((await call('chef', 'POST', `/my-tasks/${entry}/done`, { done: true })).statusCode).toBe(200)
    expect(ids((await list('fnb')).toApprove)).toContain(entry)
    expect((await call('fnb', 'POST', `/my-tasks/${entry}/approve`, { approved: true })).statusCode).toBe(200)
    expect(ids((await list('chef')).done)).toContain(entry)
  })

  it('re-assigning emails the new assignee only', async () => {
    const r = await call('fnb', 'POST', '/calendar', { title: `${P} delivery`, type: 'task', startDate: '2026-12-06T10:00:00.000Z' })
    await flushNotifications()
    expect(sent).toHaveLength(0)
    expect((await call('fnb', 'PATCH', `/calendar/${r.json().id}`, { assigneeId: U.designer!.id })).statusCode).toBe(200)
    await flushNotifications()
    expect(sent.map((s) => s.to)).toEqual([U.designer!.email])
  })

  it('company B never sees or ticks company A\'s tasks', async () => {
    expect((await call('mktB', 'POST', `/my-tasks/${entry}/done`, { done: true })).statusCode).toBe(404)
    expect((await call('mktB', 'POST', `/my-tasks/${entry}/approve`, { approved: false })).statusCode).toBe(404)
    const b = await list('mktB')
    expect([...b.open, ...b.done, ...b.awaitingApproval, ...b.toApprove]).toHaveLength(0)
  })
})
