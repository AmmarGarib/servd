// ONE copy rule from the servd ingredient master to company stock items (owner, 2026-11-14 — clean-up step 1, A3):
// lib/ingredientMaster.ts applyMasterToItemsTx / itemFieldsFromMaster, called by every path, so an item never drifts
// from the sheet (the bug where one ingredient showed another's name).
//   - a new item (from-master) takes the whole definition;
//   - a master edit reaches EVERY company's linked item (allergens, yield, use-by, rename, unit/buying rules) — and an
//     item that had drifted is brought back on the next edit;
//   - the twin a company already stocked takes the definition when linked (keeps its own name, unit, buying unit);
//   - a merge gives the moved items the kept ingredient's definition and name;
//   - two companies: each company's item is updated, never another company's unlinked item.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { ingredientMasterRoutes } from '../src/modules/ingredientMaster/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}
const P = `mic${Date.now().toString(36)}`
const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })
const def = (id: string) => prisma.inventoryItem.findUniqueOrThrow({
  where: { id }, select: { name: true, unit: true, category: true, allergens: true, yieldPct: true, perishable: true, shelfLifeDays: true, purchaseUnit: true, purchaseUnitFactor: true, masterIngredientId: true },
})
async function master(who: Who, body: Record<string, unknown>): Promise<string> {
  const r = await call(who, 'POST', '/ingredient-master', body)
  expect(r.statusCode, r.body).toBeLessThan(300)
  return r.json().id as string
}
async function fromMaster(who: Who, masterIngredientId: string) {
  const r = await call(who, 'POST', '/inventory/from-master', { masterIngredientId })
  expect(r.statusCode, r.body).toBeLessThan(300)
  return r.json() as { id: string; created: boolean }
}

beforeAll(async () => {
  A = await mkCompany(`${P}-a`)
  B = await mkCompany(`${P}-b`)
  u.ceo = await mkUser(`${P}Ceo`, 'admin', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: u.ceo.id } })
  u.chefA = await mkUser(`${P}ChefA`, 'boh_management', A.tenantId)
  u.chefB = await mkUser(`${P}ChefB`, 'boh_management', B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    return reply.status(status && status < 500 ? status : 500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(ingredientMasterRoutes, { prefix: '/ingredient-master' })
  await app.ready()
}, 90_000)

afterAll(async () => { await app?.close() })

describe('master → company items: one copy rule', () => {
  let saffron = ''
  let itemA = ''
  let itemB = ''

  it('a new item takes the whole definition (both companies)', async () => {
    saffron = await master(u.chefA!, { name: `${P} Saffron`, unit: 'g', category: 'spices', allergens: ['none'], yieldPct: 95, perishable: false, purchaseUnit: 'tin', purchaseUnitFactor: 50 })
    itemA = (await fromMaster(u.chefA!, saffron)).id
    itemB = (await fromMaster(u.chefB!, saffron)).id
    for (const id of [itemA, itemB]) {
      expect(await def(id)).toMatchObject({ name: `${P} Saffron`, unit: 'g', category: 'spices', allergens: ['none'], yieldPct: 95, perishable: false, purchaseUnit: 'tin', purchaseUnitFactor: 50, masterIngredientId: saffron })
    }
  })

  it('a master edit reaches every company\'s item: allergens, yield, use-by, name', async () => {
    const r = await call(u.chefA!, 'PATCH', `/ingredient-master/${saffron}`, { name: `${P} Saffron threads`, allergens: ['sulphites'], yieldPct: 90, perishable: true, shelfLifeDays: 30 })
    expect(r.statusCode, r.body).toBe(200)
    for (const id of [itemA, itemB]) {
      expect(await def(id)).toMatchObject({ name: `${P} Saffron threads`, allergens: ['sulphites'], yieldPct: 90, perishable: true, shelfLifeDays: 30 })
    }
  })

  it('an item that drifted from the sheet is brought back on the next master edit', async () => {
    await prisma.inventoryItem.update({ where: { id: itemB }, data: { allergens: [], yieldPct: 50, perishable: false, shelfLifeDays: null } })
    const r = await call(u.chefA!, 'PATCH', `/ingredient-master/${saffron}`, { spec: 'Grade 1, Iranian' })
    expect(r.statusCode, r.body).toBe(200)
    expect(await def(itemB)).toMatchObject({ allergens: ['sulphites'], yieldPct: 90, perishable: true, shelfLifeDays: 30 })
  })

  it('the buying unit reaches only items buying in the master\'s old one', async () => {
    await prisma.inventoryItem.update({ where: { id: itemB }, data: { purchaseUnit: 'jar', purchaseUnitFactor: 20 } })
    const r = await call(u.ceo!, 'PATCH', `/ingredient-master/${saffron}`, { purchaseUnit: 'box', purchaseUnitFactor: 100 })
    expect(r.statusCode, r.body).toBe(200)
    expect(await def(itemA)).toMatchObject({ purchaseUnit: 'box', purchaseUnitFactor: 100 })
    expect(await def(itemB)).toMatchObject({ purchaseUnit: 'jar', purchaseUnitFactor: 20 })
  })

  it('a twin the company already stocked takes the definition when linked; keeps its own name, unit and buying unit', async () => {
    const pepper = await master(u.chefA!, { name: `${P} Black pepper`, unit: 'kg', category: 'spices', allergens: ['pepper'], yieldPct: 98, perishable: true, shelfLifeDays: 365 })
    const twin = await prisma.inventoryItem.create({ data: { name: `${P} black pepper`, unit: 'g', category: 'spices', tenantId: B.tenantId, allergens: [], yieldPct: 100, purchaseUnit: 'pack', purchaseUnitFactor: 500 } })
    const linked = await fromMaster(u.chefB!, pepper)
    expect(linked.id).toBe(twin.id)
    expect(await def(twin.id)).toMatchObject({ name: `${P} black pepper`, unit: 'g', allergens: ['pepper'], yieldPct: 98, perishable: true, shelfLifeDays: 365, purchaseUnit: 'pack', purchaseUnitFactor: 500, masterIngredientId: pepper })
  })

  it('a merge gives the moved items the kept ingredient\'s definition and name; company A\'s unlinked item is untouched', async () => {
    const chilli = await master(u.chefA!, { name: `${P} Chilli`, unit: 'g', category: 'produce', allergens: [], yieldPct: 100 })
    const birdsEye = await master(u.chefA!, { name: `${P} Birds eye chili`, unit: 'kg', category: 'produce', allergens: ['capsicum'], yieldPct: 85, perishable: true, shelfLifeDays: 7 })
    const moved = (await fromMaster(u.chefB!, chilli)).id
    const bystander = await prisma.inventoryItem.create({ data: { name: `${P} Chilli`, unit: 'g', category: 'produce', tenantId: A.tenantId, allergens: [], yieldPct: 100 } })
    const r = await call(u.ceo!, 'POST', `/ingredient-master/${chilli}/merge`, { intoId: birdsEye })
    expect(r.statusCode, r.body).toBe(200)
    expect(await def(moved)).toMatchObject({ name: `${P} Birds eye chili`, unit: 'g', allergens: ['capsicum'], yieldPct: 85, perishable: true, shelfLifeDays: 7, masterIngredientId: birdsEye })
    expect(await def(bystander.id)).toMatchObject({ name: `${P} Chilli`, allergens: [], yieldPct: 100, masterIngredientId: null })
  })
})
