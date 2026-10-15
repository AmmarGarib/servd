// Trash bin — menu, kitchen, floor and recipes (Stream B1; modules/trash/README.md).
//
//   - Two companies: company B gets 404 on company A's deletes, Trash entries,
//     restores and purges; a delete is stamped with the ROW's company.
//   - menu item under a trashed category -> PARENT_IN_TRASH, then restores.
//   - floor restore relinks the tables it unlinked; clearExisting is a soft delete.
//   - recipe: snapshot round trip, RECIPE_SLOT_TAKEN then unlink:true, and a
//     recipe cooked on the KDS answers 409 RECIPE_IN_USE (no more 500).
//   - a sold item is not erasable (IN_USE); an unsold one is, by the CEO only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { registerTrashPlugin } = await import('../src/modules/trash/index.js')
const { menuRoutes } = await import('../src/modules/menu/routes.js')
const { stationRoutes } = await import('../src/modules/stations/routes.js')
const { tableRoutes } = await import('../src/modules/tables/routes.js')
const { floorRoutes } = await import('../src/modules/floors/routes.js')
const { recipeRoutes } = await import('../src/modules/recipes/routes.js')

const P = `trm${Date.now()}`
let app: FastifyInstance
const T = { A: '', B: '' }
const C = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@trm.pk`, password: await bcrypt.hash('x-Password-1', 4),
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
const call = (key: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({
    method, url: `/api/v1${url}`,
    headers: { ...auth(key), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  })
const json = (r: { json(): unknown }) => r.json() as any // eslint-disable-line @typescript-eslint/no-explicit-any

const mkItem = (co: 'A' | 'B', categoryId: string, name: string, extra: Record<string, unknown> = {}) =>
  prisma.menuItem.create({ data: { conceptId: C[co], categoryId, name, priceCents: 50_000, ...extra } })
const entryOf = (type: string, id: string) =>
  prisma.trashEntry.findFirst({ where: { entityType: type, entityId: id }, orderBy: { createdAt: 'desc' } })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  C.A = (await prisma.concept.create({ data: { name: `${P} Diner A`, slug: `${P}-da`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} Diner B`, slug: `${P}-db`, type: 'restaurant', tenantId: T.B } })).id
  await mkUser('ceo', 'admin', T.A)
  await mkUser('ownerA', 'owner', T.A)
  await mkUser('ownerB', 'owner', T.B)
  await mkUser('ceoB', 'admin', T.B)
  await mkUser('cashierA', 'cashier', T.A)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await registerTrashPlugin(api)
    await api.register(menuRoutes, { prefix: '/menu' })
    await api.register(stationRoutes, { prefix: '/stations' })
    await api.register(tableRoutes, { prefix: '/tables' })
    await api.register(floorRoutes, { prefix: '/floors' })
    await api.register(recipeRoutes, { prefix: '/recipes' })
  }, { prefix: '/api/v1' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('menu item / category / modifier group', () => {
  it('delete writes a company-stamped Trash entry; company B sees, restores and deletes nothing of it', async () => {
    const cat = await prisma.category.create({ data: { conceptId: C.A, name: `${P} Mains` } })
    const item = await mkItem('A', cat.id, `${P} Burger`)

    expect((await call('ownerB', 'DELETE', `/menu/items/${item.id}`)).statusCode).toBe(404)
    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))!.deletedAt).toBeNull()

    expect((await call('ownerA', 'DELETE', `/menu/items/${item.id}?reason=wrong%20price`)).statusCode).toBe(204)
    const e = (await entryOf('menu_item', item.id))!
    expect(e.tenantId).toBe(T.A)
    expect(e.conceptId).toBe(C.A)
    expect(e.deletedById).toBe(U.ownerA!.id)
    expect(e.reason).toBe('wrong price')
    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))!.deletedAt).not.toBeNull()

    const listA = json(await call('ownerA', 'GET', '/trash?type=menu_item'))
    expect(listA.items.map((i: { id: string }) => i.id)).toContain(item.id)
    const listB = json(await call('ownerB', 'GET', '/trash?type=menu_item'))
    expect(listB.items.map((i: { id: string }) => i.id)).not.toContain(item.id)
    expect((await call('ownerB', 'GET', `/trash/menu_item/${item.id}`)).statusCode).toBe(404)
    expect((await call('ownerB', 'POST', `/trash/menu_item/${item.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/menu/items/${item.id}`)).statusCode).toBe(404) // already gone

    const r = await call('ownerA', 'POST', `/trash/menu_item/${item.id}/restore`, {})
    expect(r.statusCode).toBe(200)
    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))!.deletedAt).toBeNull()
  })

  it('a cashier cannot see the menu types in the Trash', async () => {
    const cat = await prisma.category.create({ data: { conceptId: C.A, name: `${P} Cashier cat` } })
    const item = await mkItem('A', cat.id, `${P} Cashier item`)
    await call('ownerA', 'DELETE', `/menu/items/${item.id}`)
    expect((await call('cashierA', 'POST', `/trash/menu_item/${item.id}/restore`, {})).statusCode).toBe(404)
  })

  it('restoring an item under a trashed category -> PARENT_IN_TRASH, then both restore', async () => {
    const cat = await prisma.category.create({ data: { conceptId: C.A, name: `${P} Starters` } })
    const item = await mkItem('A', cat.id, `${P} Fries`)
    await call('ownerA', 'DELETE', `/menu/items/${item.id}`)
    expect((await call('ownerA', 'DELETE', `/menu/categories/${cat.id}`)).statusCode).toBe(204)
    expect((await entryOf('category', cat.id))!.tenantId).toBe(T.A)

    const blocked = await call('ownerA', 'POST', `/trash/menu_item/${item.id}/restore`, {})
    expect(blocked.statusCode).toBe(409)
    expect(json(blocked).error.code).toBe('PARENT_IN_TRASH')
    expect(json(blocked).error.details.parent).toMatchObject({ type: 'category', id: cat.id })

    expect((await call('ownerB', 'POST', `/trash/category/${cat.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('ownerA', 'POST', `/trash/category/${cat.id}/restore`, {})).statusCode).toBe(200)
    expect((await call('ownerA', 'POST', `/trash/menu_item/${item.id}/restore`, {})).statusCode).toBe(200)
  })

  it('a restored dish whose station is gone comes back unrouted', async () => {
    const cat = await prisma.category.create({ data: { conceptId: C.A, name: `${P} Grill cat` } })
    const st = await prisma.station.create({ data: { conceptId: C.A, name: `${P} Grill` } })
    const item = await mkItem('A', cat.id, `${P} Steak`, { stationId: st.id })
    await call('ownerA', 'DELETE', `/menu/items/${item.id}`)
    await prisma.station.update({ where: { id: st.id }, data: { deletedAt: new Date(), isActive: false } })
    expect((await call('ownerA', 'POST', `/trash/menu_item/${item.id}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))!.stationId).toBeNull()
  })

  it('modifier group: trashed with its item as parent; restore blocked while the item is deleted', async () => {
    const cat = await prisma.category.create({ data: { conceptId: C.A, name: `${P} Mod cat` } })
    const item = await mkItem('A', cat.id, `${P} Wrap`)
    const group = await prisma.modifierGroup.create({
      data: { menuItemId: item.id, name: `${P} Sauce`, modifiers: { create: [{ name: 'Mayo' }] } },
    })
    expect((await call('ownerB', 'DELETE', `/menu/modifier-groups/${group.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/menu/modifier-groups/${group.id}`)).statusCode).toBe(204)
    const e = (await entryOf('modifier_group', group.id))!
    expect(e).toMatchObject({ tenantId: T.A, parentType: 'menu_item', parentId: item.id })

    await call('ownerA', 'DELETE', `/menu/items/${item.id}`)
    const blocked = await call('ownerA', 'POST', `/trash/modifier_group/${group.id}/restore`, {})
    expect(json(blocked).error.code).toBe('PARENT_IN_TRASH')
    await call('ownerA', 'POST', `/trash/menu_item/${item.id}/restore`, {})
    expect((await call('ownerA', 'POST', `/trash/modifier_group/${group.id}/restore`, {})).statusCode).toBe(200)
  })

  it('a sold item is not erasable (IN_USE); an unsold one is, by the CEO only', async () => {
    const cat = await prisma.category.create({ data: { conceptId: C.A, name: `${P} Sold cat` } })
    const sold = await mkItem('A', cat.id, `${P} Sold`)
    const unsold = await mkItem('A', cat.id, `${P} Unsold`)
    const order = await prisma.order.create({ data: { conceptId: C.A, source: 'pos', totalCents: 50_000 } })
    await prisma.orderItem.create({ data: { orderId: order.id, menuItemId: sold.id, name: 'Sold', unitPriceCents: 50_000 } })
    await call('ownerA', 'DELETE', `/menu/items/${sold.id}`)
    await call('ownerA', 'DELETE', `/menu/items/${unsold.id}`)

    const reason = encodeURIComponent('duplicate of another dish, cleaning up')
    expect((await call('ownerA', 'DELETE', `/trash/menu_item/${unsold.id}?reason=${reason}`)).statusCode).toBe(403)
    expect((await call('ceo', 'DELETE', `/trash/menu_item/${sold.id}?reason=${reason}`)).statusCode).toBe(409)
    const refused = json(await call('ceo', 'DELETE', `/trash/menu_item/${sold.id}?reason=${reason}`))
    expect(refused.error.code).toBe('IN_USE')
    expect(refused.error.details.references[0].label).toMatch(/Order lines/)
    expect(await prisma.menuItem.findUnique({ where: { id: sold.id } })).not.toBeNull()

    expect((await call('ceo', 'DELETE', `/trash/menu_item/${unsold.id}?reason=${reason}`)).statusCode).toBeLessThan(300)
    expect(await prisma.menuItem.findUnique({ where: { id: unsold.id } })).toBeNull()
    expect((await entryOf('menu_item', unsold.id))!.purgedAt).not.toBeNull()
  })
})

describe('station / table / floor', () => {
  it('station: admin-only delete, company B 404, restore brings back its previous on/off state', async () => {
    const st = await prisma.station.create({ data: { conceptId: C.A, name: `${P} Fryer`, isActive: true } })
    expect((await call('ceoB', 'DELETE', `/stations/${st.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/stations/${st.id}`)).statusCode).toBe(403)
    expect((await call('ceo', 'DELETE', `/stations/${st.id}`)).statusCode).toBe(204)
    expect((await entryOf('station', st.id))!.tenantId).toBe(T.A)
    expect((await call('ceoB', 'POST', `/trash/station/${st.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('ceo', 'POST', `/trash/station/${st.id}/restore`, {})).statusCode).toBe(200)
    const back = (await prisma.station.findUnique({ where: { id: st.id } }))!
    expect(back.deletedAt).toBeNull()
    expect(back.isActive).toBe(true)
  })

  it('table: trashed with its floor as parent, restored idle on that floor; used table not erasable', async () => {
    const floor = await prisma.floor.create({ data: { conceptId: C.A, name: `${P} Main` } })
    const tbl = await prisma.table.create({
      data: { conceptId: C.A, floorId: floor.id, label: `${P}-T1`, capacity: 4, status: 'seated' },
    })
    expect((await call('ownerB', 'DELETE', `/tables/${tbl.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/tables/${tbl.id}`)).statusCode).toBe(204)
    expect(await entryOf('table', tbl.id)).toMatchObject({ tenantId: T.A, parentType: 'floor', parentId: floor.id })

    // The floor goes too: the table's restore waits for it.
    expect((await call('ownerA', 'DELETE', `/floors/${floor.id}`)).statusCode).toBe(204)
    const blocked = await call('ownerA', 'POST', `/trash/table/${tbl.id}/restore`, {})
    expect(json(blocked).error.code).toBe('PARENT_IN_TRASH')
    expect((await call('ownerA', 'POST', `/trash/floor/${floor.id}/restore`, {})).statusCode).toBe(200)
    expect((await call('ownerA', 'POST', `/trash/table/${tbl.id}/restore`, {})).statusCode).toBe(200)
    const back = (await prisma.table.findUnique({ where: { id: tbl.id } }))!
    expect(back).toMatchObject({ deletedAt: null, floorId: floor.id, status: 'available' })

    // A table an order points at can never be erased.
    await prisma.order.create({ data: { conceptId: C.A, source: 'pos', totalCents: 1, tableId: tbl.id } })
    await call('ownerA', 'DELETE', `/tables/${tbl.id}`)
    const r = await call('ceo', 'DELETE', `/trash/table/${tbl.id}?reason=${encodeURIComponent('table was a test, removing it')}`)
    expect(json(r).error.code).toBe('IN_USE')
  })

  it('floor restore relinks the tables it unlinked (live ones only); company B 404', async () => {
    const floor = await prisma.floor.create({ data: { conceptId: C.A, name: `${P} Patio` } })
    const t1 = await prisma.table.create({ data: { conceptId: C.A, floorId: floor.id, label: `${P}-P1` } })
    const t2 = await prisma.table.create({ data: { conceptId: C.A, floorId: floor.id, label: `${P}-P2` } })
    const moved = await prisma.table.create({ data: { conceptId: C.A, floorId: floor.id, label: `${P}-P3` } })

    expect((await call('ownerB', 'DELETE', `/floors/${floor.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/floors/${floor.id}`)).statusCode).toBe(204)
    expect((await prisma.table.findUnique({ where: { id: t1.id } }))!.floorId).toBeNull()
    expect((await entryOf('floor', floor.id))!.tenantId).toBe(T.A)

    // t2 is deleted meanwhile; `moved` is placed on another floor.
    const other = await prisma.floor.create({ data: { conceptId: C.A, name: `${P} Other` } })
    await prisma.table.update({ where: { id: t2.id }, data: { deletedAt: new Date() } })
    await prisma.table.update({ where: { id: moved.id }, data: { floorId: other.id } })

    expect((await call('ownerB', 'POST', `/trash/floor/${floor.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('ownerA', 'POST', `/trash/floor/${floor.id}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.table.findUnique({ where: { id: t1.id } }))!.floorId).toBe(floor.id)
    expect((await prisma.table.findUnique({ where: { id: t2.id } }))!.floorId).toBeNull()
    expect((await prisma.table.findUnique({ where: { id: moved.id } }))!.floorId).toBe(other.id)
    expect((await prisma.floor.findUnique({ where: { id: floor.id } }))!.isActive).toBe(true)
  })

  it('apply-layout clearExisting soft-deletes tables an order points at (was a 500) and trashes them', async () => {
    const floor = await prisma.floor.create({ data: { conceptId: C.A, name: `${P} Layout` } })
    const old = await prisma.table.create({ data: { conceptId: C.A, floorId: floor.id, label: `${P}-OLD` } })
    await prisma.order.create({ data: { conceptId: C.A, source: 'pos', totalCents: 1, tableId: old.id } })
    const layout = { clearExisting: true, tables: [{ label: `${P}-NEW`, capacity: 2, x: 10, y: 10 }] }

    expect((await call('ownerB', 'POST', `/floors/${floor.id}/apply-layout`, layout)).statusCode).toBe(404)
    const r = await call('ownerA', 'POST', `/floors/${floor.id}/apply-layout`, layout)
    expect(r.statusCode).toBe(201)
    expect((await prisma.table.findUnique({ where: { id: old.id } }))!.deletedAt).not.toBeNull()
    expect(await entryOf('table', old.id)).toMatchObject({ tenantId: T.A, parentType: 'floor', parentId: floor.id })
    expect(await prisma.table.count({ where: { floorId: floor.id, deletedAt: null, label: `${P}-NEW` } })).toBe(1)
    expect((await call('ownerA', 'POST', `/trash/table/${old.id}/restore`, {})).statusCode).toBe(200)
  })
})

describe('recipe', () => {
  async function mkRecipe(co: 'A' | 'B', name: string) {
    const cat = await prisma.category.create({ data: { conceptId: C[co], name: `${P} cat ${name}` } })
    const item = await mkItem(co, cat.id, name)
    const stock = await prisma.inventoryItem.create({ data: { name: `${P} flour ${name}`, unit: 'g', tenantId: T[co] } })
    const recipe = await prisma.recipe.create({
      data: {
        kind: 'plate', status: 'production', menuItemId: item.id,
        ingredients: { create: [{ inventoryItemId: stock.id, quantity: 100, unit: 'g' }] },
        recipeSteps: { create: [{ phase: 'service_cook', instruction: 'Cook it' }] },
        testAttempts: { create: [{ version: 1, testedById: U.ceo!.id, notes: 'good' }] },
      },
    })
    return { item, recipe, stock }
  }

  it('snapshot round trip: delete -> Trash -> restore keeps ids, lines, steps and test cooks; B gets 404', async () => {
    const { recipe } = await mkRecipe('A', `${P} Pasta`)
    const step = (await prisma.recipeStep.findFirst({ where: { recipeId: recipe.id } }))!
    expect((await call('ownerB', 'DELETE', `/recipes/${recipe.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/recipes/${recipe.id}`)).statusCode).toBe(204)
    expect(await prisma.recipe.findUnique({ where: { id: recipe.id } })).toBeNull()
    const e = (await entryOf('recipe', recipe.id))!
    expect(e.tenantId).toBe(T.A)
    expect(e.snapshot).not.toBeNull()

    expect((await call('ownerB', 'GET', `/trash/recipe/${recipe.id}`)).statusCode).toBe(404)
    expect((await call('ownerB', 'POST', `/trash/recipe/${recipe.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('ownerA', 'POST', `/trash/recipe/${recipe.id}/restore`, {})).statusCode).toBe(200)

    const back = (await prisma.recipe.findUnique({
      where: { id: recipe.id }, include: { ingredients: true, recipeSteps: true, testAttempts: true },
    }))!
    expect(back.status).toBe('production')
    expect(back.menuItemId).toBe(recipe.menuItemId)
    expect(back.ingredients).toHaveLength(1)
    expect(back.recipeSteps.map((s) => s.id)).toEqual([step.id])
    expect(back.testAttempts).toHaveLength(1)
  })

  it('slot taken -> RECIPE_SLOT_TAKEN; unlink:true restores it as an unlinked recipe under test', async () => {
    const { item, recipe } = await mkRecipe('A', `${P} Lasagne`)
    await call('ownerA', 'DELETE', `/recipes/${recipe.id}`)
    const newer = await prisma.recipe.create({ data: { kind: 'plate', status: 'iteration', menuItemId: item.id } })

    const clash = await call('ownerA', 'POST', `/trash/recipe/${recipe.id}/restore`, {})
    expect(clash.statusCode).toBe(409)
    expect(json(clash).error.code).toBe('RECIPE_SLOT_TAKEN')
    expect(await prisma.recipe.findUnique({ where: { id: recipe.id } })).toBeNull()

    const ok = await call('ownerA', 'POST', `/trash/recipe/${recipe.id}/restore`, { unlink: true })
    expect(ok.statusCode).toBe(200)
    const back = (await prisma.recipe.findUnique({ where: { id: recipe.id }, include: { ingredients: true } }))!
    expect(back.menuItemId).toBeNull()
    expect(back.status).toBe('iteration')
    expect(back.ingredients).toHaveLength(1)
    expect((await prisma.recipe.findUnique({ where: { id: newer.id } }))!.menuItemId).toBe(item.id)
    // restoring twice is refused
    expect(json(await call('ownerA', 'POST', `/trash/recipe/${recipe.id}/restore`, {})).error.code).toBe('ALREADY_RESTORED')
  })

  it('a recipe whose steps were cooked on the KDS answers 409 RECIPE_IN_USE (and a step 409), not 500', async () => {
    const { item, recipe } = await mkRecipe('A', `${P} Pizza`)
    const step = (await prisma.recipeStep.findFirst({ where: { recipeId: recipe.id } }))!
    const order = await prisma.order.create({ data: { conceptId: C.A, source: 'pos', totalCents: 1 } })
    const line = await prisma.orderItem.create({ data: { orderId: order.id, menuItemId: item.id, name: 'Pizza', unitPriceCents: 1 } })
    await prisma.orderItemStep.create({ data: { orderItemId: line.id, recipeStepId: step.id } })

    const r = await call('ownerA', 'DELETE', `/recipes/${recipe.id}`)
    expect(r.statusCode).toBe(409)
    expect(json(r).error.code).toBe('RECIPE_IN_USE')
    expect(await prisma.recipe.findUnique({ where: { id: recipe.id } })).not.toBeNull()
    expect(await prisma.trashEntry.count({ where: { entityType: 'recipe', entityId: recipe.id } })).toBe(0)

    const s = await call('ownerA', 'DELETE', `/recipes/steps/${step.id}`)
    expect(s.statusCode).toBe(409)
    expect(json(s).error.code).toBe('RECIPE_STEP_IN_USE')
  })

  it('purge (CEO only) drops the snapshot but keeps the tombstone', async () => {
    const { recipe } = await mkRecipe('A', `${P} Soup`)
    await call('ownerA', 'DELETE', `/recipes/${recipe.id}`)
    const reason = encodeURIComponent('old test dish, never served')
    expect((await call('ownerA', 'DELETE', `/trash/recipe/${recipe.id}?reason=${reason}`)).statusCode).toBe(403)
    expect((await call('ownerB', 'DELETE', `/trash/recipe/${recipe.id}?reason=${reason}`)).statusCode).toBe(403)
    expect((await call('ceo', 'DELETE', `/trash/recipe/${recipe.id}?reason=${reason}`)).statusCode).toBeLessThan(300)
    const e = (await entryOf('recipe', recipe.id))!
    expect(e.purgedAt).not.toBeNull()
    expect(e.snapshot).toBeNull()
    expect(json(await call('ownerA', 'POST', `/trash/recipe/${recipe.id}/restore`, {})).error.code).toBe('PURGED')
  })
})
