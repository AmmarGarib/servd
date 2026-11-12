// Dish options (owner, 2026-11-12: "i cant add variation to the menu item. For
// example a single patty and double patty version"). The menu editor now saves a
// dish's option groups through POST / PATCH /menu/modifier-groups.
//
//   - create binds to the ACTIVE company; company B gets 404 on company A's dish
//   - PATCH renames / re-prices, adds and soft-removes options; B gets 404
//   - OPTIONS_REQUIRED, ONE_DEFAULT_ONLY, MAX_BELOW_MIN, OPTION_NOT_IN_GROUP
//   - the menu tree hides removed options; the till drops a removed option's id
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { menuRoutes } = await import('../src/modules/menu/routes.js')
const { prepareOrderLines } = await import('../src/modules/orders/service.js')

const P = `dop${Date.now()}`
let app: FastifyInstance
const T = { A: '', B: '' }
const C = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}
let itemA = ''
let catA = ''

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@dop.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
}
const auth = (key: string) => {
  const u = U[key]!
  return { authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}` }
}
const call = (key: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({
    method, url: `/api/v1${url}`,
    headers: { ...auth(key), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  })
const json = (r: { json(): unknown }) => r.json() as any // eslint-disable-line @typescript-eslint/no-explicit-any
const code = (r: { json(): unknown }) => json(r).error?.code

const pattyGroup = () => ({
  menuItemId: itemA, name: 'Patty', minSelect: 1, maxSelect: 1, isRequired: true,
  modifiers: [
    { name: 'Single', priceDeltaCents: 0, isDefault: true, sortOrder: 0 },
    { name: 'Double', priceDeltaCents: 40_000, isDefault: false, sortOrder: 1 },
  ],
})

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  C.A = (await prisma.concept.create({ data: { name: `${P} Diner A`, slug: `${P}-da`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} Diner B`, slug: `${P}-db`, type: 'restaurant', tenantId: T.B } })).id
  await mkUser('ownerA', 'owner', T.A)
  await mkUser('ownerB', 'owner', T.B)
  catA = (await prisma.category.create({ data: { conceptId: C.A, name: `${P} Burgers` } })).id
  itemA = (await prisma.menuItem.create({ data: { conceptId: C.A, categoryId: catA, name: `${P} Smash`, priceCents: 120_000 } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(menuRoutes, { prefix: '/menu' })
  }, { prefix: '/api/v1' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('dish options', () => {
  it('create binds to the active company; company B gets 404 on A\'s dish', async () => {
    expect((await call('ownerB', 'POST', '/menu/modifier-groups', pattyGroup())).statusCode).toBe(404)
    const r = await call('ownerA', 'POST', '/menu/modifier-groups', pattyGroup())
    expect(r.statusCode).toBe(201)
    const g = json(r)
    expect(g.modifiers).toHaveLength(2)
    const audit = await prisma.auditLog.findFirst({ where: { action: 'menu.option_group.create', entityId: g.id } })
    expect(audit?.tenantId).toBe(T.A)
  })

  it('refuses a group with no options, two defaults on a pick-one, or max below min', async () => {
    expect(code(await call('ownerA', 'POST', '/menu/modifier-groups', { ...pattyGroup(), modifiers: [] }))).toBe('OPTIONS_REQUIRED')
    const twoDefaults = { ...pattyGroup(), modifiers: pattyGroup().modifiers.map((m) => ({ ...m, isDefault: true })) }
    expect(code(await call('ownerA', 'POST', '/menu/modifier-groups', twoDefaults))).toBe('ONE_DEFAULT_ONLY')
    expect(code(await call('ownerA', 'POST', '/menu/modifier-groups', { ...pattyGroup(), minSelect: 3, maxSelect: 2 }))).toBe('MAX_BELOW_MIN')
  })

  it('PATCH renames, re-prices, adds and soft-removes; B gets 404; the tree and the till drop removed options', async () => {
    const g = json(await call('ownerA', 'POST', '/menu/modifier-groups', pattyGroup()))
    const single = g.modifiers.find((m: { name: string }) => m.name === 'Single')
    const double = g.modifiers.find((m: { name: string }) => m.name === 'Double')

    expect((await call('ownerB', 'PATCH', `/menu/modifier-groups/${g.id}`, { name: 'Hacked' })).statusCode).toBe(404)

    const r = await call('ownerA', 'PATCH', `/menu/modifier-groups/${g.id}`, {
      name: 'Patties',
      modifiers: [
        { id: single.id, name: 'One patty', priceDeltaCents: 0, isDefault: true, sortOrder: 0 },
        { name: 'Triple', priceDeltaCents: 75_000, isDefault: false, sortOrder: 2 },
      ],
    })
    expect(r.statusCode).toBe(200)
    const u = json(r)
    expect(u.name).toBe('Patties')
    expect(u.modifiers.map((m: { name: string }) => m.name)).toEqual(['One patty', 'Triple'])
    expect(u.modifiers[0].id).toBe(single.id)
    // Soft-removed, never hard-deleted.
    const gone = await prisma.modifier.findUnique({ where: { id: double.id } })
    expect(gone?.deletedAt).not.toBeNull()

    expect(code(await call('ownerA', 'PATCH', `/menu/modifier-groups/${g.id}`, { modifiers: [] }))).toBe('OPTIONS_REQUIRED')
    expect(code(await call('ownerA', 'PATCH', `/menu/modifier-groups/${g.id}`, {
      modifiers: u.modifiers.map((m: { id: string; name: string }) => ({ id: m.id, name: m.name, priceDeltaCents: 0, isDefault: true })),
    }))).toBe('ONE_DEFAULT_ONLY')
    expect(code(await call('ownerA', 'PATCH', `/menu/modifier-groups/${g.id}`, {
      modifiers: [{ id: double.id, name: 'Double', priceDeltaCents: 0, isDefault: false }],
    }))).toBe('OPTION_NOT_IN_GROUP')

    const tree = json(await call('ownerA', 'GET', `/menu/${C.A}`))
    const dish = tree.flatMap((c: { items: unknown[] }) => c.items).find((i: { id: string }) => i.id === itemA)
    const mine = dish.modifierGroups.find((x: { id: string }) => x.id === g.id)
    const names = mine.modifiers.map((m: { name: string }) => m.name)
    expect(names).not.toContain('Double')
    expect(names).toContain('Triple')

    const { modifierIdFor } = await prepareOrderLines(C.A, [{ menuItemId: itemA, quantity: 1, modifiers: [{ modifierId: double.id }, { modifierId: single.id }] }] as never, 'pos' as never)
    expect(modifierIdFor(itemA, double.id)).toBeNull()
    expect(modifierIdFor(itemA, single.id)).toBe(single.id)
  })
})
