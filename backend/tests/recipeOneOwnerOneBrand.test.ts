// Clean-up A4 / A5 (2026-11-14): ONE answer to "which company owns a recipe" and "which brand is a recipe"
// (lib/recipeCompany.ts), read by the recipes routes, the approval engine (approvalSubject / the inbox provider's
// recipeCompaniesBatch) and the brand filter of the Recipes and Add-ons pages.
//
// What this guards:
//   - an OLD sub-recipe (no Recipe.tenantId) deep under company A's dish — deeper than the approval walk's old 20-level
//     cap — is A's for the approval AND visible to A on the recipes page; company B gets 404 on it and nothing in its
//     list;
//   - a recipe with an owner keeps it (behaviour unchanged): a dish of B's brand owned by A is A's to approve;
//   - /recipes?conceptId=<brand> lists the brand's dishes and add-ons PLUS the sub-recipes they use (at any depth),
//     never an unused sub-recipe; each row's brandIds names the brands; company B's manager asking for A's brand gets
//     nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { recipeRoutes } from '../src/modules/recipes/routes.js'
import { recipeCompaniesOf, loadRecipeCompanyIndex } from '../src/lib/recipeCompany.js'
import { approvalSubject, recipeCompaniesBatch } from '../src/lib/approvalRights.js'

let app: FastifyInstance
let A: Company
let B: Company
let mgrA: Who
let mgrB: Who
const stamp = Date.now()
const R: Record<string, string> = {}

const get = (who: Who, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${who.token}` } })

async function component(name: string, opts: { tenantId?: string | null; status?: 'iteration' | 'pending_approval' } = {}) {
  return (await prisma.recipe.create({ data: { kind: 'component', name: `${name} ${stamp}`, yieldGrams: 1000, tenantId: opts.tenantId ?? null, status: opts.status ?? 'iteration' } })).id
}
async function uses(parentId: string, childId: string) {
  await prisma.recipeIngredient.create({ data: { recipeId: parentId, prepRecipeId: childId, quantity: 10, unit: 'g' } })
}

beforeAll(async () => {
  A = await mkCompany(`roo-a-${stamp}`)
  B = await mkCompany(`roo-b-${stamp}`)
  mgrA = await mkUser('roo-mgr-a', 'management', A.tenantId)
  mgrB = await mkUser('roo-mgr-b', 'management', B.tenantId)

  // A's dish → a chain of 22 old sub-recipes (no owner).
  R.dishA = (await prisma.recipe.create({ data: { kind: 'plate', menuItemId: A.items.nihari, tenantId: A.tenantId } })).id
  let parent = R.dishA
  for (let i = 0; i < 22; i++) {
    const id = await component(`chain-${i}`, { status: i === 21 ? 'pending_approval' : 'iteration' })
    await uses(parent, id)
    parent = id
    if (i === 0) R.top = id
  }
  R.deep = parent

  // A's add-on recipe → its own old sub-recipe.
  const group = await prisma.modifierGroup.create({ data: { menuItemId: A.items.kheer, name: 'Extras' } })
  const mod = await prisma.modifier.create({ data: { groupId: group.id, name: 'Pistachio' } })
  R.addonA = (await prisma.recipe.create({ data: { kind: 'modifier', modifierId: mod.id } })).id
  R.addonSub = await component('addon-sub')
  await uses(R.addonA, R.addonSub)

  // An unused old sub-recipe, and B's own dish + sub-recipe.
  R.unused = await component('unused')
  R.dishB = (await prisma.recipe.create({ data: { kind: 'plate', menuItemId: B.items.nihari } })).id
  R.subB = await component('sub-b')
  await uses(R.dishB, R.subB)

  // A dish of B's brand OWNED by A (K4: Flipd's dish owned by GS Foods).
  R.ownedByA = (await prisma.recipe.create({ data: { kind: 'plate', menuItemId: B.items.kheer, tenantId: A.tenantId, status: 'pending_approval' } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(recipeRoutes, { prefix: '/recipes' })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

describe('A4 — one owner rule for recipes', () => {
  it('an old sub-recipe 22 levels under A\'s dish is A\'s, for the approval and on the recipes page', async () => {
    expect((await recipeCompaniesOf([R.deep!], prisma)).get(R.deep!)).toEqual([A.tenantId])
    expect((await recipeCompaniesBatch([R.deep!])).get(R.deep!)).toEqual([A.tenantId])
    const subj = await approvalSubject('recipe', R.deep!)
    expect(subj).toMatchObject({ companyIds: [A.tenantId], ownerTenantId: A.tenantId })
    const idx = await loadRecipeCompanyIndex(prisma)
    expect(idx.companiesOf(R.deep!)).toEqual([A.tenantId])

    const seen = await get(mgrA, `/recipes/${R.deep}`)
    expect(seen.statusCode, seen.body).toBe(200)
    expect((await get(mgrB, `/recipes/${R.deep}`)).statusCode).toBe(404)
    const listB = (await get(mgrB, '/recipes')).json() as Array<{ id: string }>
    expect(listB.map((r) => r.id)).not.toContain(R.deep)
  })

  it('an owned recipe keeps its owner: B\'s brand dish owned by A is A\'s; plates and add-ons follow their brand', async () => {
    const m = await recipeCompaniesBatch([R.ownedByA!, R.dishB!, R.addonA!, R.unused!, 'no-such-id'])
    expect(m.get(R.ownedByA!)).toEqual([A.tenantId])
    expect(m.get(R.dishB!)).toEqual([B.tenantId])
    expect(m.get(R.addonA!)).toEqual([A.tenantId])
    expect(m.get(R.unused!)).toEqual([])          // no company of its own → the CEO's
    expect(m.get('no-such-id')).toEqual([])
    expect(await approvalSubject('recipe', R.ownedByA!)).toMatchObject({ ownerTenantId: A.tenantId })
  })
})

describe('A5 — one brand rule: a brand shows its dishes, add-ons and the sub-recipes they use', () => {
  it('?conceptId=<A\'s brand> lists the dish, the add-on and every sub-recipe under them — never an unused one', async () => {
    const res = await get(mgrA, `/recipes?conceptId=${A.conceptId}`)
    expect(res.statusCode, res.body).toBe(200)
    const rows = res.json() as Array<{ id: string; brandIds: string[] }>
    const ids = rows.map((r) => r.id)
    for (const k of ['dishA', 'top', 'deep', 'addonA', 'addonSub']) expect(ids, k).toContain(R[k])
    expect(ids).not.toContain(R.unused)
    expect(ids).not.toContain(R.subB)
    expect(rows.find((r) => r.id === R.top)!.brandIds).toEqual([A.conceptId])
    expect(rows.find((r) => r.id === R.addonSub)!.brandIds).toEqual([A.conceptId])
  })

  it('the unfiltered list carries brandIds (an unused sub-recipe has none); company B asking for A\'s brand gets nothing', async () => {
    const all = (await get(mgrA, '/recipes')).json() as Array<{ id: string; brandIds: string[] }>
    expect(all.find((r) => r.id === R.unused)?.brandIds).toEqual([])
    expect(all.find((r) => r.id === R.dishA)?.brandIds).toEqual([A.conceptId])
    const foreign = await get(mgrB, `/recipes?conceptId=${A.conceptId}`)
    expect(foreign.statusCode).toBe(200)
    expect(foreign.json()).toEqual([])
    const own = (await get(mgrB, `/recipes?conceptId=${B.conceptId}`)).json() as Array<{ id: string }>
    expect(own.map((r) => r.id)).toEqual(expect.arrayContaining([R.dishB, R.subB]))
    expect(own.map((r) => r.id)).not.toContain(R.deep)
  })
})
