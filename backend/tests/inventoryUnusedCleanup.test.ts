// Sourcing sheet: "Remove ingredients not in a recipe" (owner, 2026-10-16;
// modules/inventory/unusedCleanup.ts, trash provider inventory_item).
//
//   - CEO only (owner / procurement 403); company = the ACTIVE company: company
//     B's items never appear in A's preview and are never moved by A's apply.
//   - Used (recipe line, a recipe in the Trash), stocked and purchased items
//     are skipped with reasons; unused ones go to the Trash (one entry each,
//     stamped with the item's company) and the Sourcing list drops them.
//   - Race: an item put into a recipe between preview and apply is skipped.
//   - One audit row per run with the counts. Restore brings it back (B: 404);
//     a recipe cannot take a trashed ingredient (ITEM_IN_TRASH).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { registerTrashPlugin } = await import('../src/modules/trash/index.js')
const { inventoryRoutes } = await import('../src/modules/inventory/routes.js')
const { recipeRoutes } = await import('../src/modules/recipes/routes.js')
const { trashProvider } = await import('../src/modules/trash/registry.js')

const stamp = Date.now()
const P = `tst${stamp}`
let app: FastifyInstance
const T = { A: '', B: '' }
const tokens: Record<string, string> = {}
const I: Record<string, string> = {}

async function mkUser(key: string, role: string, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@gsfoods.pk`.toLowerCase(), password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  tokens[key] = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken
}
const call = (key: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({
    method, url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${tokens[key]}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  })
const code = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code
const item = async (key: string, tenantId: string, extra: Record<string, unknown> = {}) => {
  I[key] = (await prisma.inventoryItem.create({ data: { tenantId, name: `${P} ${key}`, unit: 'g', ...extra } })).id
  return I[key]
}
type Preview = { toMove: Array<{ id: string }>; skipped: Array<{ id: string; reasons: string[] }>; counts: Record<string, number> }
type Applied = { moved: Array<{ id: string }>; skipped: Array<{ id: string; reasons: string[] }>; counts: Record<string, number> }

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('ownerA', 'owner', [T.A])
  await mkUser('buyerA', 'procurement', [T.A])

  await item('unusedA', T.A)
  await item('unused2A', T.A)
  await item('racedA', T.A)
  await item('inRecipeA', T.A)
  await item('inTrashedRecipeA', T.A)
  await item('stockedA', T.A, { currentStock: 5 })
  await item('boughtA', T.A)
  await item('unusedB', T.B)
  await prisma.recipe.create({
    data: { kind: 'component', name: `${P} sauce`, yieldGrams: 1000, ingredients: { create: [{ inventoryItemId: I.inRecipeA, quantity: 10, unit: 'g' }] } },
  })
  await prisma.itemPriceHistory.create({ data: { inventoryItemId: I.boughtA, newCostCents: 500, source: 'po_receive' } })
  // A recipe waiting in the Trash still counts (restoring it would point at a trashed item).
  await prisma.trashEntry.create({
    data: {
      tenantId: T.A, entityType: 'recipe', entityId: `${P}-gone-recipe`, title: `${P} old sauce`,
      snapshot: { v: 1, model: 'Recipe', row: { id: `${P}-gone-recipe` }, children: { RecipeIngredient: [{ id: `${P}-l1`, inventoryItemId: I.inTrashedRecipeA, quantity: 1, unit: 'g' }] } },
    },
  })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await registerTrashPlugin(api)
    await api.register(inventoryRoutes, { prefix: '/inventory' })
    await api.register(recipeRoutes, { prefix: '/recipes' })
  }, { prefix: '/api/v1' })
  await app.ready()
})

afterAll(async () => { await app?.close() })

describe('unused ingredient clean-up', () => {
  it('registers the inventory_item trash type', () => {
    const p = trashProvider('inventory_item')
    expect(p?.strategy).toBe('soft')
    expect(p?.moduleId).toBe('inventory')
  })

  it('is the CEO\'s only', async () => {
    for (const k of ['ownerA', 'buyerA']) {
      expect((await call(k, 'GET', '/inventory/unused-cleanup')).statusCode).toBe(403)
      expect((await call(k, 'POST', '/inventory/unused-cleanup', { itemIds: [I.unusedA] })).statusCode).toBe(403)
    }
    expect(await prisma.inventoryItem.findUnique({ where: { id: I.unusedA }, select: { deletedAt: true } })).toEqual({ deletedAt: null })
  })

  it('previews only the active company, with skip reasons', async () => {
    const r = await call('ceoA', 'GET', '/inventory/unused-cleanup')
    expect(r.statusCode).toBe(200)
    const body = r.json() as Preview
    const move = body.toMove.map((x) => x.id)
    expect(move).toEqual(expect.arrayContaining([I.unusedA, I.unused2A, I.racedA]))
    for (const k of ['inRecipeA', 'inTrashedRecipeA', 'stockedA', 'boughtA', 'unusedB']) expect(move, k).not.toContain(I[k])
    const skipped = new Map(body.skipped.map((s) => [s.id, s.reasons.join(' | ')]))
    expect(skipped.get(I.stockedA)).toMatch(/stock/i)
    expect(skipped.get(I.boughtA)).toMatch(/delivery or bill/)
    // In use = not a candidate at all.
    expect(skipped.has(I.inRecipeA)).toBe(false)
    expect(skipped.has(I.unusedB)).toBe(false)
    const bView = (await call('ceoB', 'GET', '/inventory/unused-cleanup')).json() as Preview
    expect(bView.toMove.map((x) => x.id)).toEqual([I.unusedB])
  })

  it('moves only unused items of the active company; a raced item is skipped; one audit row', async () => {
    // Between preview and apply, racedA goes into a recipe.
    await prisma.recipe.create({
      data: { kind: 'component', name: `${P} late sauce`, yieldGrams: 500, ingredients: { create: [{ inventoryItemId: I.racedA, quantity: 1, unit: 'g' }] } },
    })
    const ids = [I.unusedA, I.unused2A, I.racedA, I.stockedA, I.boughtA, I.inRecipeA, I.unusedB]
    const r = await call('ceoA', 'POST', '/inventory/unused-cleanup', { itemIds: ids })
    expect(r.statusCode).toBe(200)
    const body = r.json() as Applied
    expect(body.moved.map((m) => m.id).sort()).toEqual([I.unusedA, I.unused2A].sort())
    expect(body.counts).toEqual({ requested: 7, moved: 2, skipped: 5 })
    const sk = new Map(body.skipped.map((s) => [s.id, s.reasons.join(' | ')]))
    expect(sk.get(I.racedA)).toMatch(/recipe line/)
    expect(sk.get(I.unusedB)).toMatch(/Not a live ingredient of this company/)

    expect((await prisma.inventoryItem.findUnique({ where: { id: I.unusedB } }))!.deletedAt).toBeNull()
    expect((await prisma.inventoryItem.findUnique({ where: { id: I.racedA } }))!.deletedAt).toBeNull()
    expect((await prisma.inventoryItem.findUnique({ where: { id: I.unusedA } }))!.deletedAt).not.toBeNull()
    const e = await prisma.trashEntry.findFirst({ where: { entityType: 'inventory_item', entityId: I.unusedA, restoredAt: null } })
    expect(e?.tenantId).toBe(T.A)
    expect(await prisma.trashEntry.count({ where: { entityType: 'inventory_item', entityId: I.unusedB } })).toBe(0)

    const audits = await prisma.auditLog.findMany({ where: { tenantId: T.A, action: 'inventory.unused_cleanup' } })
    expect(audits).toHaveLength(1)
    expect((audits[0].metadata as { moved: number }).moved).toBe(2)

    // The Sourcing sheet no longer lists it.
    const list = (await call('ceoA', 'GET', '/inventory')).json() as Array<{ id: string }>
    expect(list.map((x) => x.id)).not.toContain(I.unusedA)
  })

  it('a trashed ingredient cannot go into a recipe', async () => {
    const r = await call('ceoA', 'POST', '/recipes', { kind: 'component', name: `${P} new sauce`, yieldGrams: 500, ingredients: [{ inventoryItemId: I.unusedA, quantity: 1, unit: 'g' }] })
    expect(r.statusCode).toBe(422)
    expect(code(r)).toBe('ITEM_IN_TRASH')
  })

  it('lands in the Trash and restores (B blind; name clash renames)', async () => {
    const listA = (await call('ceoA', 'GET', '/trash?type=inventory_item&limit=100')).json() as { items: Array<{ id: string }> }
    expect(listA.items.map((i) => i.id)).toContain(I.unusedA)
    const listB = (await call('ceoB', 'GET', '/trash?type=inventory_item&limit=100')).json() as { items: Array<{ id: string }> }
    expect(listB.items.map((i) => i.id)).not.toContain(I.unusedA)
    expect((await call('ceoB', 'POST', `/trash/inventory_item/${I.unusedA}/restore`, {})).statusCode).toBe(404)

    expect((await call('ownerA', 'POST', `/trash/inventory_item/${I.unusedA}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.inventoryItem.findUnique({ where: { id: I.unusedA } }))!.deletedAt).toBeNull()

    // A live twin took the name meanwhile → clash, then a rename wins.
    await prisma.inventoryItem.create({ data: { tenantId: T.A, name: `${P} unused2A`, unit: 'g' } })
    const clash = await call('ceoA', 'POST', `/trash/inventory_item/${I.unused2A}/restore`, {})
    expect(clash.statusCode).toBe(409)
    expect(code(clash)).toBe('TRASH_CLASH')
    const ok = await call('ceoA', 'POST', `/trash/inventory_item/${I.unused2A}/restore`, { rename: { name: `${P} unused2A old` } })
    expect(ok.statusCode).toBe(200)
    const back = await prisma.inventoryItem.findUnique({ where: { id: I.unused2A } })
    expect(back).toMatchObject({ deletedAt: null, name: `${P} unused2A old`, tenantId: T.A })
  })
})
