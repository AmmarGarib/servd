// Recipe view (owner, 2026-11-12: "make them in flipd. But add all flipd recipes to gs foods because I own a stake in
// flipd and I am gs foods"). Flipd owns and writes its recipes again; GS Foods READS all of them, never writes.
//
// What this guards:
//   - The migration's data step: a brand whose recipes another company owned gets them back — dishes, add-ons and the
//     sub-recipes ONLY its dishes use (nested too); a sub-recipe another brand also uses stays; the old owner becomes
//     the viewer.
//   - The view: GS Foods lists and opens every Flipd recipe, sub-recipes included, and edits none (403); Flipd edits
//     them; a third company sees nothing; GS Foods' own recipes are not shown to Flipd through the view.
//   - The CEO field: only the CEO sets it, only to one of the CEO's companies.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { recipeRoutes } from '../src/modules/recipes/routes.js'
import { conceptRoutes } from '../src/modules/concepts/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let GS: Company
let FL: Company
let C3: Company
const u: Record<string, Who> = {}
const R: Record<string, string> = {}

const call = (who: Who, method: 'GET' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

async function recipe(tenantId: string, kind: 'plate' | 'component', name: string, menuItemId?: string): Promise<string> {
  return (await prisma.recipe.create({ data: { tenantId, kind, name, status: 'production', yieldGrams: 100, ...(menuItemId ? { menuItemId } : {}) } as never })).id
}
async function uses(recipeId: string, prepRecipeId: string): Promise<void> {
  await prisma.recipeIngredient.create({ data: { recipeId, prepRecipeId, quantity: 10, unit: 'g' } as never })
}

beforeAll(async () => {
  GS = await mkCompany('rv-gs')
  FL = await mkCompany('rv-fl')
  C3 = await mkCompany('rv-c3')
  u.ceo = await mkUser('rvCeo', 'admin', GS.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: FL.tenantId, userId: u.ceo.id } })
  u.chefGS = await mkUser('rvChefGS', 'boh_management', GS.tenantId)
  u.chefFL = await mkUser('rvChefFL', 'boh_management', FL.tenantId)
  u.chefC3 = await mkUser('rvChefC3', 'boh_management', C3.tenantId)
  u.mgmtFL = await mkUser('rvMgmtFL', 'management', FL.tenantId)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(recipeRoutes, { prefix: '/recipes' })
  await app.register(conceptRoutes, { prefix: '/concepts' })
  await app.ready()

  // Today's shape: Flipd's recipes OWNED by GS Foods.
  await prisma.concept.update({ where: { id: FL.conceptId }, data: { recipeOwnerTenantId: GS.tenantId } })
  R.flPlate = await recipe(GS.tenantId, 'plate', 'Flipd smash', FL.items.nihari)
  R.flSauce = await recipe(GS.tenantId, 'component', 'Smash sauce')      // Flipd only
  R.flPickle = await recipe(GS.tenantId, 'component', 'Pickle brine')    // nested under the sauce — Flipd only
  R.shared = await recipe(GS.tenantId, 'component', 'House stock')       // Flipd AND GS Foods
  R.gsPlate = await recipe(GS.tenantId, 'plate', 'GS nihari', GS.items.nihari)
  R.gsOnly = await recipe(GS.tenantId, 'component', 'GS masala')         // GS Foods only
  await uses(R.flPlate, R.flSauce)
  await uses(R.flSauce, R.flPickle)
  await uses(R.flPlate, R.shared)
  await uses(R.gsPlate, R.shared)
  await uses(R.gsPlate, R.gsOnly)

  // The migration's data step, limited to this test's brand (the test DB is shared).
  const sql = readFileSync(join(__dirname, '../prisma/migrations/20261112100000_recipe_viewer/migration.sql'), 'utf8')
    .split('\n').filter((l) => !l.startsWith('--') && !l.startsWith('ALTER TABLE') && !l.startsWith('CREATE INDEX')).join('\n')
    .replace('WHERE "recipeOwnerTenantId" IS NOT NULL', `WHERE id = '${FL.conceptId}' AND "recipeOwnerTenantId" IS NOT NULL`)
  for (const stmt of sql.split(';').map((x) => x.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(stmt)
}, 90_000)

afterAll(async () => { await app?.close() })

describe('the switch-back (migration data step)', () => {
  it('Flipd owns its dish and the sub-recipes only it uses; shared and GS-only stay GS Foods\'; GS Foods views', async () => {
    const owner = async (id: string) => (await prisma.recipe.findUniqueOrThrow({ where: { id }, select: { tenantId: true } })).tenantId
    expect(await owner(R.flPlate!)).toBe(FL.tenantId)
    expect(await owner(R.flSauce!)).toBe(FL.tenantId)
    expect(await owner(R.flPickle!)).toBe(FL.tenantId)
    expect(await owner(R.shared!)).toBe(GS.tenantId)
    expect(await owner(R.gsPlate!)).toBe(GS.tenantId)
    expect(await owner(R.gsOnly!)).toBe(GS.tenantId)
    const c = await prisma.concept.findUniqueOrThrow({ where: { id: FL.conceptId } })
    expect(c.recipeOwnerTenantId).toBeNull()
    expect(c.recipeViewerTenantId).toBe(GS.tenantId)
  })
})

describe('the read-only view', () => {
  it('GS Foods lists and opens every Flipd recipe, edits none; Flipd edits them', async () => {
    const gs = ((await call(u.chefGS!, 'GET', '/recipes')).json() as Array<{ id: string }>).map((r) => r.id)
    expect(gs).toEqual(expect.arrayContaining([R.flPlate, R.flSauce, R.flPickle, R.shared, R.gsPlate, R.gsOnly]))
    expect((await call(u.chefGS!, 'GET', `/recipes/${R.flSauce}`)).statusCode).toBe(200)
    expect([403, 404]).toContain((await call(u.chefGS!, 'PUT', `/recipes/${R.flSauce}`, { yieldGrams: 90 })).statusCode)
    expect([403, 404]).toContain((await call(u.chefGS!, 'PUT', `/recipes/${R.flPlate}`, { servings: 2 })).statusCode)
    expect((await call(u.chefFL!, 'PUT', `/recipes/${R.flSauce}`, { yieldGrams: 90 })).statusCode).toBe(200)
  })

  it('Flipd does not see GS Foods\' own recipes through the view; a third company sees nothing', async () => {
    const fl = ((await call(u.chefFL!, 'GET', '/recipes')).json() as Array<{ id: string }>).map((r) => r.id)
    expect(fl).not.toContain(R.gsPlate)
    expect(fl).not.toContain(R.gsOnly)
    expect(fl).toContain(R.shared)   // Flipd's dish uses it
    const c3 = ((await call(u.chefC3!, 'GET', '/recipes')).json() as Array<{ id: string }>).map((r) => r.id)
    for (const id of Object.values(R)) expect(c3).not.toContain(id)
    expect((await call(u.chefC3!, 'GET', `/recipes/${R.flPlate}`)).statusCode).toBe(404)
  })
})

describe('the CEO field', () => {
  it('only the CEO sets it, only to one of the CEO\'s companies; clearing hides the view', async () => {
    expect((await call(u.mgmtFL!, 'PATCH', `/concepts/${FL.conceptId}`, { recipeViewerTenantId: null })).statusCode).toBe(403)
    const bad = await call(u.ceo!, 'PATCH', `/concepts/${FL.conceptId}`, { recipeViewerTenantId: C3.tenantId })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('RECIPE_VIEWER_NOT_IN_COMPANIES')
    expect((await call(u.ceo!, 'PATCH', `/concepts/${FL.conceptId}`, { recipeViewerTenantId: null })).statusCode).toBe(200)
    const gs = ((await call(u.chefGS!, 'GET', '/recipes')).json() as Array<{ id: string }>).map((r) => r.id)
    expect(gs).not.toContain(R.flSauce)
    expect(gs).toContain(R.shared)
    const back = await call(u.ceo!, 'PATCH', `/concepts/${FL.conceptId}`, { recipeViewerTenantId: GS.tenantId })
    expect(back.statusCode, back.body).toBe(200)
    expect(back.json().recipeViewerTenantId).toBe(GS.tenantId)
  })
})
