// Stock on hand, the ingredient master and prep — reconciled (owner decisions
// 28, 29 and 30, 2026-09-27).
//
// What this guards:
//   - No stock change without a record: PATCH /inventory/:id/adjust is gone,
//     and neither create nor PATCH accepts currentStock. Counts, waste logs
//     and deliveries are the only writers.
//   - One ingredient master, per company: POST /inventory binds to a company
//     the operator belongs to, never "shared"/company-less, one name per
//     company. A company-less legacy item can be assigned once.
//   - Cost = the moving average of deliveries: a typed cost is an opening
//     estimate only for an item never delivered, and it is recorded in
//     ItemPriceHistory ('manual_adjust'); after a delivery it is refused.
//   - Waste is logged in the item's own stock unit and only on own items.
//   - The par sheet lists the recipe sub-recipes the company's brands use and
//     reads "made" from prep batches; the hand-typed par writers and the
//     Component library's write routes are gone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { parSheetRoutes } from '../src/modules/par-sheet/routes.js'
import { kitchenRoutes } from '../src/modules/kitchen/routes.js'

let app: FastifyInstance
let tenantA: string
let tenantB: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.stocktest@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin' as never, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Stock A', slug: 'stock-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Stock B', slug: 'stock-b' } })).id
  await mkUser('mgrA', tenantA, [tenantA])
  await mkUser('mgrB', tenantB, [tenantB])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(parSheetRoutes, { prefix: '/par-sheet' })
  await app.register(kitchenRoutes, { prefix: '/kitchen' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

// ─── Decision 28: no stock change without a record ───────────────────────────

describe('stock on hand', () => {
  it('has no silent adjust route', async () => {
    const item = await prisma.inventoryItem.create({ data: { name: 'Flour', unit: 'kg', currentStock: 10, tenantId: tenantA } })
    const res = await call('mgrA', 'PATCH', `/inventory/${item.id}/adjust`, { delta: -3 })
    expect(res.statusCode).toBe(404)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock).toBe(10)
  })

  it('PATCH refuses currentStock and leaves stock alone', async () => {
    const item = await prisma.inventoryItem.create({ data: { name: 'Sugar', unit: 'kg', currentStock: 4, tenantId: tenantA } })
    const res = await call('mgrA', 'PATCH', `/inventory/${item.id}`, { currentStock: 40 })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('STOCK_NEEDS_RECORD')
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock).toBe(4)
  })

  it('a new item starts at zero; opening stock is a count', async () => {
    const withStock = await call('mgrA', 'POST', '/inventory', { name: 'Rice', unit: 'kg', currentStock: 25 })
    expect(withStock.statusCode).toBe(422)
    expect(withStock.json().error.code).toBe('STOCK_NEEDS_RECORD')

    const ok = await call('mgrA', 'POST', '/inventory', { name: 'Rice', unit: 'kg', currentStock: 0, parLevel: 5 })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().currentStock).toBe(0)
  })

  it('waste is logged in the item’s own unit, on own items only', async () => {
    const item = await prisma.inventoryItem.create({ data: { name: 'Butter', unit: 'kg', currentStock: 2, tenantId: tenantA } })
    const grams = await call('mgrA', 'POST', `/inventory/${item.id}/waste`, { quantity: 500, unit: 'g', reason: 'spoilage' })
    expect(grams.statusCode).toBe(422)
    expect(grams.json().error.code).toBe('UNIT_MISMATCH')

    const foreign = await call('mgrB', 'POST', `/inventory/${item.id}/waste`, { quantity: 0.5, unit: 'kg', reason: 'spoilage' })
    expect(foreign.statusCode).toBe(404)

    const ok = await call('mgrA', 'POST', `/inventory/${item.id}/waste`, { quantity: 0.5, unit: 'kg', reason: 'spoilage' })
    expect(ok.statusCode).toBe(201)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock).toBeCloseTo(1.5)
    expect(await prisma.wasteLog.count({ where: { inventoryItemId: item.id } })).toBe(1)
  })
})

// ─── Decision 30: one ingredient master, per company; cost from deliveries ───

describe('ingredient master', () => {
  it('creates bind to the active company, never shared', async () => {
    const shared = await call('mgrA', 'POST', '/inventory', { name: 'Salt', unit: 'kg', shared: true })
    expect(shared.statusCode).toBe(422)
    expect(shared.json().error.code).toBe('NO_SHARED_ITEMS')

    const ok = await call('mgrA', 'POST', '/inventory', { name: 'Salt', unit: 'kg' })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().tenantId).toBe(tenantA)

    const foreignCompany = await call('mgrA', 'POST', '/inventory', { name: 'Pepper', unit: 'kg', tenantId: tenantB })
    expect(foreignCompany.statusCode).toBe(403)
  })

  it('one row per ingredient per company', async () => {
    expect((await call('mgrA', 'POST', '/inventory', { name: 'Cumin', unit: 'kg' })).statusCode).toBe(201)
    const dup = await call('mgrA', 'POST', '/inventory', { name: '  cumin ', unit: 'g' })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('DUPLICATE_ITEM')
    // The other company keeps its own row.
    expect((await call('mgrB', 'POST', '/inventory', { name: 'Cumin', unit: 'kg' })).statusCode).toBe(201)
  })

  it('an opening cost is recorded; after a delivery the cost is the delivery average only', async () => {
    const created = await call('mgrA', 'POST', '/inventory', { name: 'Paprika', unit: 'kg', unitCostCents: 90_000 })
    expect(created.statusCode).toBe(201)
    const id = created.json().id as string

    const edit = await call('mgrA', 'PATCH', `/inventory/${id}`, { unitCostCents: 95_000 })
    expect(edit.statusCode).toBe(200)
    const hist = await prisma.itemPriceHistory.findMany({ where: { inventoryItemId: id }, orderBy: { recordedAt: 'asc' } })
    expect(hist.map((h) => [h.source, h.oldCostCents, h.newCostCents])).toEqual([
      ['manual_adjust', null, 90_000],
      ['manual_adjust', 90_000, 95_000],
    ])

    // A delivery lands (receiving is procurement's; simulate its footprint).
    const supplier = await prisma.supplier.create({ data: { name: 'Spice Co', tenantId: tenantA } })
    await prisma.purchaseOrder.create({
      data: { supplierId: supplier.id, status: 'received', lines: { create: [{ inventoryItemId: id, quantityOrdered: 2, quantityReceived: 2, unitCostCents: 100_000 }] } },
    })

    const list = await call('mgrA', 'GET', '/inventory')
    expect(list.json().find((i: { id: string }) => i.id === id).costSource).toBe('deliveries')

    const overwrite = await call('mgrA', 'PATCH', `/inventory/${id}`, { unitCostCents: 80_000 })
    expect(overwrite.statusCode).toBe(422)
    expect(overwrite.json().error.code).toBe('COST_FROM_DELIVERIES')
    // Names and notes stay editable.
    expect((await call('mgrA', 'PATCH', `/inventory/${id}`, { notes: 'Smoked' })).statusCode).toBe(200)
  })

  it('a company-less item can be assigned once, only to an own company', async () => {
    const orphan = await prisma.inventoryItem.create({ data: { name: 'Legacy Oil', unit: 'litres' } })
    const unassigned = await call('mgrA', 'GET', '/inventory/unassigned')
    expect(unassigned.statusCode).toBe(200)
    expect(unassigned.json().unassigned.some((u: { id: string }) => u.id === orphan.id)).toBe(true)

    expect((await call('mgrA', 'PATCH', `/inventory/${orphan.id}`, { tenantId: tenantB })).statusCode).toBe(404)
    const ok = await call('mgrA', 'PATCH', `/inventory/${orphan.id}`, { tenantId: tenantA })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().tenantId).toBe(tenantA)

    // Now it is A's: B cannot see or move it, and A cannot re-home it.
    expect((await call('mgrB', 'PATCH', `/inventory/${orphan.id}`, { tenantId: tenantB })).statusCode).toBe(404)
    const move = await call('mgrA', 'PATCH', `/inventory/${orphan.id}`, { tenantId: tenantB })
    expect(move.statusCode).toBe(422)
  })
})

// ─── Decision 29: par sheet = the company's sub-recipes, made from batches ───

describe('par sheet and prep', () => {
  let locParA: string
let locParB: string
let subX: string
  let subY: string
  let subZ: string
  let flourA: string

  beforeAll(async () => {
    const mkBrand = async (tenantId: string, slug: string) => {
      const concept = await prisma.concept.create({ data: { name: slug, slug, type: 'restaurant', tenantId } })
      const cat = await prisma.category.create({ data: { conceptId: concept.id, name: 'Mains' } })
      return { concept, cat }
    }
    const a = await mkBrand(tenantA, 'stock-brand-a')
    const b = await mkBrand(tenantB, 'stock-brand-b')
    locParA = (await prisma.location.create({ data: { slug: 'stock-loc-a', name: 'Stock outlet A', tenantId: tenantA } })).id
    locParB = (await prisma.location.create({ data: { slug: 'stock-loc-b', name: 'Stock outlet B', tenantId: tenantB } })).id
    await prisma.conceptLocation.create({ data: { conceptId: a.concept.id, locationId: locParA, isPrimary: true } })
    await prisma.conceptLocation.create({ data: { conceptId: b.concept.id, locationId: locParB, isPrimary: true } })

    flourA = (await prisma.inventoryItem.create({ data: { name: 'Par Flour', unit: 'kg', currentStock: 10, tenantId: tenantA } })).id
    const flourB = (await prisma.inventoryItem.create({ data: { name: 'Par Flour', unit: 'kg', currentStock: 10, tenantId: tenantB } })).id

    // Y is inside X; X is on A's plate. Z is only on B's plate. W is unused.
    subY = (await prisma.recipe.create({ data: { kind: 'component', name: 'Roux', yieldGrams: 300, ingredients: { create: [{ inventoryItemId: flourA, quantity: 150, unit: 'g' }] } } })).id
    subX = (await prisma.recipe.create({
      data: {
        kind: 'component', name: 'Bechamel', yieldGrams: 1000,
        ingredients: { create: [
          // Points at B's flour: the prep form maps it to A's same-name item.
          { inventoryItemId: flourB, quantity: 200, unit: 'g', yieldPct: 0.8 },
          { prepRecipeId: subY, quantity: 100, unit: 'g' },
        ] },
      },
    })).id
    subZ = (await prisma.recipe.create({ data: { kind: 'component', name: 'Salsa', yieldGrams: 500 } })).id
    await prisma.recipe.create({ data: { kind: 'component', name: 'Unused Stock', yieldGrams: 500 } })

    const plateA = await prisma.menuItem.create({ data: { conceptId: a.concept.id, categoryId: a.cat.id, name: 'Lasagne', priceCents: 150_000 } })
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: plateA.id, ingredients: { create: [{ prepRecipeId: subX, quantity: 120, unit: 'g' }] } } })
    const plateB = await prisma.menuItem.create({ data: { conceptId: b.concept.id, categoryId: b.cat.id, name: 'Nachos', priceCents: 90_000 } })
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: plateB.id, ingredients: { create: [{ prepRecipeId: subZ, quantity: 80, unit: 'g' }] } } })

    // Today's batches: one of A's, one drawn from B's stock (not A's prep).
    await prisma.prepBatch.create({ data: { tenantId: tenantA, locationId: locParA, recipeId: subX, itemName: 'Bechamel', inputs: [{ inventoryItemId: flourA, qtyDrawn: 0.25, unit: 'kg' }], actualYieldQty: 950, unit: 'g', staffId: users['mgrA']!.id } })
    await prisma.prepBatch.create({ data: { tenantId: tenantB, locationId: locParB, recipeId: subX, itemName: 'Bechamel', inputs: [{ inventoryItemId: flourB, qtyDrawn: 0.25, unit: 'kg' }], actualYieldQty: 1000, unit: 'g', staffId: users['mgrB']!.id } })
  })

  it('the par board lists only the sub-recipes the company’s brands use, transitively; another company’s outlet 404', async () => {
    const res = await call('mgrA', 'GET', `/kitchen/par-board?locationId=${locParA}`)
    expect(res.statusCode).toBe(200)
    const ids = res.json().rows.map((r: { recipeId: string }) => r.recipeId).sort()
    expect(ids).toEqual([subX, subY].sort())

    const idsB = (await call('mgrB', 'GET', `/kitchen/par-board?locationId=${locParB}`)).json().rows.map((r: { recipeId: string }) => r.recipeId)
    expect(idsB).toEqual([subZ])
    expect((await call('mgrB', 'GET', `/kitchen/par-board?locationId=${locParA}`)).statusCode).toBe(404)
    // The old "made today" list is gone (one board).
    expect((await call('mgrA', 'GET', '/par-sheet')).statusCode).toBe(404)
  })

  it('reads "made today" from the outlet’s prep batches', async () => {
    const rows = (await call('mgrA', 'GET', `/kitchen/par-board?locationId=${locParA}`)).json().rows as Array<{ recipeId: string; madeTodayQty: number; batchesMadeToday: number }>
    const x = rows.find((r) => r.recipeId === subX)!
    expect(x.batchesMadeToday).toBe(1)
    expect(x.madeTodayQty).toBe(950)
    expect(rows.find((r) => r.recipeId === subY)!.batchesMadeToday).toBe(0)
  })

  it('the prep form gets inputs in each item’s stock unit, from the company’s own items', async () => {
    const preps = (await call('mgrA', 'GET', '/par-sheet/preps')).json() as Array<{ id: string; inputs: Array<{ inventoryItemId: string; qtyDrawn: number; unit: string }>; subPreps: Array<{ id: string }> }>
    const x = preps.find((p) => p.id === subX)!
    // 200 g usable at 80% yield = 250 g raw = 0.25 kg of A's flour.
    expect(x.inputs).toEqual([expect.objectContaining({ inventoryItemId: flourA, qtyDrawn: 0.25, unit: 'kg', missing: false })])
    expect(x.subPreps.map((s) => s.id)).toEqual([subY])
  })

  it('the hand-typed par writers and the Component library are gone (K7: tables kept, no API)', async () => {
    const comp = await prisma.component.create({ data: { name: 'Chicken skin crisp', type: 'trim_waste' } })
    expect((await call('mgrA', 'PUT', `/par-sheet/${comp.id}`, { actual: 5 })).statusCode).toBe(404)
    expect((await call('mgrA', 'POST', `/par-sheet/${comp.id}/adjust`, { delta: 1 })).statusCode).toBe(404)
    expect((await call('mgrA', 'POST', '/par-sheet/rollover', {})).statusCode).toBe(404)
    expect((await call('mgrA', 'POST', '/components', { name: 'x', type: 'hero' })).statusCode).toBe(404)
    expect((await call('mgrA', 'GET', `/components/${comp.id}`)).statusCode).toBe(404)
  })
})
