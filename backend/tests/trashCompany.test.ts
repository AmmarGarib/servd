// Trash — company masters & identity (stream B2; modules/trash/README.md).
//
//   - Two companies: company B (its own CEO, its own managers) never sees or
//     restores company A's brand, login, location, domain, rider or webhook.
//   - Deletes keep answering 204 and file one entry stamped with the ROW's company.
//   - A restored brand is INACTIVE; a restored login is SUSPENDED and its old
//     sessions stay dead; a restored domain is `pending`; a rider / webhook
//     comes back inactive; a location gets its live same-company brand links back.
//   - Brand and login are the CEO's: a non-CEO cannot restore them.
//   - A create whose unique value is held by a row in the Trash → 409 IN_TRASH
//     (domain hostname, rider phone, login email, brand slug) — named only to
//     someone in that row's company.
//   - Brand / login never erasable; a rider with jobs is not erasable.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { registerTrashPlugin } = await import('../src/modules/trash/index.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { conceptRoutes } = await import('../src/modules/concepts/routes.js')
const { locationRoutes } = await import('../src/modules/locations/routes.js')
const { domainRoutes } = await import('../src/modules/domains/routes.js')
const { riderRoutes } = await import('../src/modules/riders/routes.js')
const { webhookManagementRoutes } = await import('../src/modules/webhooks/routes.js')
const { trashProvider } = await import('../src/modules/trash/registry.js')

const stamp = Date.now()
const P = `tcm${stamp}`
let app: FastifyInstance
const T = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}
const tokens: Record<string, string> = {}

async function mkUser(key: string, role: string, tenants: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@gsfoods.pk`.toLowerCase(), password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active', ...extra,
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
  tokens[key] = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken
}
const hdr = (key: string, body: boolean) => ({
  authorization: `Bearer ${tokens[key]}`,
  ...(body ? { 'content-type': 'application/json' } : {}),
})
const call = (key: string, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: hdr(key, payload !== undefined), ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) })
const code = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code
const openEntry = (type: string, id: string) =>
  prisma.trashEntry.findFirst({ where: { entityType: type, entityId: id, restoredAt: null, purgedAt: null } })

async function mkBrand(co: 'A' | 'B', tag: string) {
  return prisma.concept.create({ data: { name: `${P} ${tag}`, slug: `${P}-${tag}`.toLowerCase(), type: 'restaurant', tenantId: T[co] } })
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('ownerA', 'owner', [T.A])
  await mkUser('mgmtA', 'management', [T.A])
  await mkUser('mgmtB', 'management', [T.B])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await registerTrashPlugin(api)
    await api.register(authRoutes, { prefix: '/auth' })
    await api.register(conceptRoutes, { prefix: '/concepts' })
    await api.register(locationRoutes, { prefix: '/locations' })
    await api.register(domainRoutes, { prefix: '/domains' })
    await api.register(riderRoutes, { prefix: '/riders' })
    await api.register(webhookManagementRoutes, { prefix: '/webhooks' })
  }, { prefix: '/api/v1' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('registry', () => {
  it('registers the six company types with their rules', () => {
    for (const k of ['brand', 'location', 'domain', 'login', 'rider', 'webhook']) expect(trashProvider(k), k).toBeTruthy()
    expect(trashProvider('brand')!.ceoOnly).toBe(true)
    expect(trashProvider('login')!.ceoOnly).toBe(true)
    expect(trashProvider('brand')!.erasable(null, [])).toBe(false)
    expect(trashProvider('login')!.erasable(null, [])).toBe(false)
  })
})

describe('brand', () => {
  it('B cannot delete, see or restore A\'s brand; A\'s restored brand is inactive; non-CEO cannot restore', async () => {
    const b = await mkBrand('A', 'brand1')
    expect((await call('ceoB', 'DELETE', `/concepts/${b.id}`)).statusCode).toBe(404)

    const del = await call('ceoA', 'DELETE', `/concepts/${b.id}?reason=closing%20the%20brand`)
    expect(del.statusCode).toBe(204)
    const e = await openEntry('brand', b.id)
    expect(e?.tenantId).toBe(T.A)
    expect(e?.reason).toBe('closing the brand')
    const audit = await prisma.auditLog.findFirst({ where: { action: 'trash.move', entityId: b.id } })
    expect(audit?.tenantId).toBe(T.A)

    // B: nothing listed, 404 on detail and restore.
    const listB = await call('ceoB', 'GET', '/trash?type=brand&limit=100')
    expect(listB.statusCode).toBe(200)
    expect((listB.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).not.toContain(b.id)
    expect((await call('ceoB', 'GET', `/trash/brand/${b.id}`)).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/trash/brand/${b.id}/restore`, {})).statusCode).toBe(404)

    // A non-CEO never reaches a CEO-only type (refused: the type is invisible to them).
    const own = await call('ownerA', 'POST', `/trash/brand/${b.id}/restore`, {})
    expect([403, 404]).toContain(own.statusCode)
    expect((await prisma.concept.findUnique({ where: { id: b.id } }))!.deletedAt).not.toBeNull()

    // Purge refused: never erasable.
    const purge = await call('ceoA', 'DELETE', `/trash/brand/${b.id}`, { reason: 'trying to erase it' })
    expect(purge.statusCode).toBe(409)
    expect(code(purge)).toBe('NOT_ERASABLE')

    const res = await call('ceoA', 'POST', `/trash/brand/${b.id}/restore`, {})
    expect(res.statusCode).toBe(200)
    const back = await prisma.concept.findUnique({ where: { id: b.id } })
    expect(back!.deletedAt).toBeNull()
    expect(back!.isActive).toBe(false)
  })

  it('creating a brand with a slug held by a trashed brand → IN_TRASH', async () => {
    const b = await mkBrand('A', 'brand2')
    expect((await call('ceoA', 'DELETE', `/concepts/${b.id}`)).statusCode).toBe(204)
    const r = await call('ceoA', 'POST', '/concepts', { name: 'Again', slug: b.slug, type: 'restaurant', serviceVessel: 'plate' })
    expect(r.statusCode).toBe(409)
    expect(code(r)).toBe('IN_TRASH')
    expect((r.json() as { error: { details: { id: string; type: string } } }).error.details).toMatchObject({ type: 'brand', id: b.id })
  })
})

describe('login', () => {
  it('B cannot restore A\'s login; a restored login is suspended and its old sessions stay dead', async () => {
    await mkUser('victimA', 'management', [T.A])
    const oldToken = tokens['victimA']!
    // Works before.
    expect((await call('victimA', 'GET', '/auth/users')).statusCode).toBe(200)

    expect((await call('ceoB', 'DELETE', `/auth/users/${U['victimA']!.id}`)).statusCode).toBe(404)
    expect((await call('ceoA', 'DELETE', `/auth/users/${U['victimA']!.id}`)).statusCode).toBe(204)
    expect((await openEntry('login', U['victimA']!.id))?.tenantId).toBe(T.A)

    expect((await call('ceoB', 'POST', `/trash/login/${U['victimA']!.id}/restore`, {})).statusCode).toBe(404)
    expect([403, 404]).toContain((await call('ownerA', 'POST', `/trash/login/${U['victimA']!.id}/restore`, {})).statusCode)

    const r = await call('ceoA', 'POST', `/trash/login/${U['victimA']!.id}/restore`, {})
    expect(r.statusCode).toBe(200)
    const u = await prisma.user.findUnique({ where: { id: U['victimA']!.id } })
    expect(u!.deletedAt).toBeNull()
    expect(u!.accountStatus).toBe('suspended')
    expect(u!.isActive).toBe(false)

    const again = await app.inject({ method: 'GET', url: '/api/v1/auth/users', headers: { authorization: `Bearer ${oldToken}` } })
    expect([401, 403]).toContain(again.statusCode)
  })

  it('a new login with a trashed login\'s email → IN_TRASH (own company) / EMAIL_TAKEN (other company)', async () => {
    await mkUser('goneA', 'management', [T.A])
    expect((await call('ceoA', 'DELETE', `/auth/users/${U['goneA']!.id}`)).statusCode).toBe(204)
    const mine = await call('ceoA', 'POST', '/auth/users', { name: 'Again', email: U['goneA']!.email, role: 'management', tenantId: T.A })
    expect(mine.statusCode).toBe(409)
    expect(code(mine)).toBe('IN_TRASH')
    const theirs = await call('ceoB', 'POST', '/auth/users', { name: 'Again', email: U['goneA']!.email, role: 'management', tenantId: T.B })
    expect(theirs.statusCode).toBe(409)
    expect(code(theirs)).toBe('EMAIL_TAKEN')
  })
})

describe('location', () => {
  it('B cannot delete A\'s location; a restored location gets its live brand links back', async () => {
    const keep = await mkBrand('A', 'locbrand1')
    const gone = await mkBrand('A', 'locbrand2')
    const loc = await prisma.location.create({ data: { name: `${P} kitchen`, slug: `${P}-kitchen`, tenantId: T.A } })
    await prisma.conceptLocation.createMany({ data: [
      { conceptId: keep.id, locationId: loc.id, isPrimary: true },
      { conceptId: gone.id, locationId: loc.id },
    ] })

    expect((await call('mgmtB', 'DELETE', `/locations/${loc.id}`)).statusCode).toBe(404)
    expect((await call('mgmtA', 'DELETE', `/locations/${loc.id}`)).statusCode).toBe(204)
    expect(await prisma.conceptLocation.count({ where: { locationId: loc.id } })).toBe(0)
    const e = await openEntry('location', loc.id)
    expect(e?.tenantId).toBe(T.A)

    // A brand deleted meanwhile is not relinked.
    expect((await call('ceoA', 'DELETE', `/concepts/${gone.id}`)).statusCode).toBe(204)

    expect((await call('mgmtB', 'POST', `/trash/location/${loc.id}/restore`, {})).statusCode).toBe(404)
    const r = await call('mgmtA', 'POST', `/trash/location/${loc.id}/restore`, {})
    expect(r.statusCode).toBe(200)
    const back = await prisma.location.findUnique({ where: { id: loc.id }, include: { concepts: true } })
    expect(back!.deletedAt).toBeNull()
    expect(back!.isActive).toBe(true)
    expect(back!.concepts.map((c) => c.conceptId)).toEqual([keep.id])
    expect(back!.concepts[0]!.isPrimary).toBe(true)
  })
})

describe('domain', () => {
  it('delete → Trash; create with that hostname → IN_TRASH; restore → pending', async () => {
    const host = `${P}.example.pk`
    const created = await call('mgmtA', 'POST', '/domains', { hostname: host })
    expect(created.statusCode).toBe(201)
    const id = (created.json() as { id: string }).id

    expect((await call('mgmtB', 'DELETE', `/domains/${id}`)).statusCode).toBe(404)
    expect((await call('mgmtA', 'DELETE', `/domains/${id}`)).statusCode).toBe(204)
    expect((await openEntry('domain', id))?.tenantId).toBe(T.A)

    const again = await call('mgmtA', 'POST', '/domains', { hostname: host })
    expect(again.statusCode).toBe(409)
    expect(code(again)).toBe('IN_TRASH')
    expect((again.json() as { error: { details: { id: string } } }).error.details.id).toBe(id)
    // Another company is never told whose it is.
    const other = await call('mgmtB', 'POST', '/domains', { hostname: host })
    expect(other.statusCode).toBe(409)
    expect(code(other)).toBe('HOSTNAME_TAKEN')

    // Only the CEO holds the Domains module (tenants) — the CEO restores it.
    const r = await call('ceoA', 'POST', `/trash/domain/${id}/restore`, {})
    expect(r.statusCode).toBe(200)
    const d = await prisma.domain.findUnique({ where: { id } })
    expect(d!.deletedAt).toBeNull()
    expect(d!.status).toBe('pending')
  })
})

describe('rider', () => {
  it('delete → Trash; same phone → IN_TRASH; restore → inactive and offline; erasable when unused', async () => {
    const phone = `0321${String(stamp).slice(-7)}`
    const created = await call('mgmtA', 'POST', '/riders', { name: `${P} rider`, phone })
    expect(created.statusCode).toBe(201)
    const id = (created.json() as { id: string }).id
    const stored = (created.json() as { phone: string }).phone

    expect((await call('mgmtB', 'DELETE', `/riders/${id}`)).statusCode).toBe(404)
    expect((await call('mgmtA', 'DELETE', `/riders/${id}`)).statusCode).toBe(204)
    expect((await openEntry('rider', id))?.tenantId).toBe(T.A)

    const again = await call('mgmtA', 'POST', '/riders', { name: 'Again', phone })
    expect(again.statusCode).toBe(409)
    expect(code(again)).toBe('IN_TRASH')
    const other = await call('mgmtB', 'POST', '/riders', { name: 'Again', phone })
    expect(other.statusCode).toBe(409)
    expect(code(other)).toBe('PHONE_TAKEN')

    expect((await call('mgmtB', 'POST', `/trash/rider/${id}/restore`, {})).statusCode).toBe(404)
    const r = await call('mgmtA', 'POST', `/trash/rider/${id}/restore`, {})
    expect(r.statusCode).toBe(200)
    const back = await prisma.rider.findUnique({ where: { id } })
    expect(back!.deletedAt).toBeNull()
    expect(back!.isActive).toBe(false)
    expect(back!.status).toBe('offline')
    expect(back!.phone).toBe(stored)

    // Unused → the CEO may erase it after a second delete.
    expect((await call('mgmtA', 'DELETE', `/riders/${id}`)).statusCode).toBe(204)
    const purge = await call('ceoA', 'DELETE', `/trash/rider/${id}`, { reason: 'never worked a shift' })
    expect(purge.statusCode).toBe(204)
    expect(await prisma.rider.findUnique({ where: { id } })).toBeNull()
  })
})

describe('webhook', () => {
  it('delete → Trash; B cannot restore; restore → inactive', async () => {
    const hook = await prisma.webhookSubscription.create({ data: { tenantId: T.A, url: `https://${P}.example.com/h`, secret: 's', events: ['order.placed'], isActive: true } })
    expect((await call('mgmtB', 'DELETE', `/webhooks/endpoints/${hook.id}`)).statusCode).toBe(404)
    expect((await call('mgmtA', 'DELETE', `/webhooks/endpoints/${hook.id}`)).statusCode).toBe(204)
    expect((await openEntry('webhook', hook.id))?.tenantId).toBe(T.A)
    expect((await call('mgmtB', 'POST', `/trash/webhook/${hook.id}/restore`, {})).statusCode).toBe(404)
    const r = await call('mgmtA', 'POST', `/trash/webhook/${hook.id}/restore`, {})
    expect(r.statusCode).toBe(200)
    const back = await prisma.webhookSubscription.findUnique({ where: { id: hook.id } })
    expect(back!.deletedAt).toBeNull()
    expect(back!.isActive).toBe(false)
  })
})
