// Kitchen flow, part A (owner, 2026-10-26): servd's ONE ingredient master (K1–K3, K6) and the companies' stock items.
//
// What this guards:
//   - A chef's new ingredient joins the master at once as needs_review (K2); typing it again (other case / spaces)
//     returns the existing row, never a duplicate.
//   - Search is server-side; it says only whether the CALLER's active company stocks it.
//   - POST /inventory/from-master makes the ACTIVE company's item from the master (K3 auto-fill), idempotent; company B
//     gets its own item, never A's. An unlinked same-name item is linked instead of a second row.
//   - POST /inventory links a new item to its master; a linked item's definition fields are locked (422
//     MASTER_FIELD_LOCKED) while its company fields (par) stay editable.
//   - PATCH master: allergens reach every company's item; a category change moves each company's lots with its own
//     posting; a unit change with stock is 409 MASTER_UNIT_IN_USE; only a reviewer marks it reviewed.
//   - Merge: reviewers only; a company holding both is 409 MERGE_NEEDS_STOCK_MERGE; otherwise items follow.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { ingredientMasterRoutes } from '../src/modules/ingredientMaster/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

beforeAll(async () => {
  A = await mkCompany('imA')
  B = await mkCompany('imB')
  u.chefA = await mkUser('imChefA', 'boh_management', A.tenantId)
  u.buyerA = await mkUser('imBuyerA', 'procurement', A.tenantId)
  u.cookA = await mkUser('imCookA', 'boh', A.tenantId)
  u.cashA = await mkUser('imCashA', 'cashier', A.tenantId)
  u.fnbA = await mkUser('imFnbA', 'fnb_manager', A.tenantId)
  u.ceo = await mkUser('imCeo', 'admin', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: u.ceo.id } })
  u.chefB = await mkUser('imChefB', 'boh_management', B.tenantId)
  await ensureFifoReady(A.tenantId)
  await ensureFifoReady(B.tenantId)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(ingredientMasterRoutes, { prefix: '/ingredient-master' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

let beefId: string

describe('the master', () => {
  it('a chef adds a new ingredient: needs_review at once; the same name again returns it', async () => {
    const r = await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Beef  Mince', unit: 'Kg', category: 'protein', spec: '80/20, coarse ground', allergens: [] })
    expect(r.statusCode, r.body).toBe(201)
    // Kept in the family's base unit (kg → g).
    expect(r.json()).toMatchObject({ name: 'Beef Mince', stockUnit: 'g', status: 'needs_review', spec: '80/20, coarse ground', existing: false })
    beefId = r.json().id
    const again = await call(u.chefB!, 'POST', '/ingredient-master', { name: 'beef mince', unit: 'kg' })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ id: beefId, existing: true })
    expect(await prisma.ingredientMaster.count({ where: { normalizedName: 'beef mince' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { action: 'ingredient_master.create', entityId: beefId } })).toBe(1)
  })

  it('search is server-side and module-gated; a cashier (no kitchen module) is refused', async () => {
    const r = await call(u.cookA!, 'GET', '/ingredient-master?q=beef')
    expect(r.statusCode).toBe(200)
    expect(r.json().map((m: { id: string }) => m.id)).toContain(beefId)
    expect((await call(u.cashA!, 'GET', '/ingredient-master?q=beef')).statusCode).toBe(403)
    expect((await call(u.cookA!, 'POST', '/ingredient-master', { name: 'X', unit: 'kg' })).statusCode).toBe(403)
  })
})

describe('company items from the master', () => {
  let itemA: string
  it('from-master makes the ACTIVE company\'s item with the master\'s definition (K3), idempotent', async () => {
    const r = await call(u.chefA!, 'POST', '/inventory/from-master', { masterIngredientId: beefId })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ tenantId: A.tenantId, unit: 'g', category: 'protein', masterIngredientId: beefId, unitCostCents: null, parLevel: 0 })
    itemA = r.json().id
    const again = await call(u.chefA!, 'POST', '/inventory/from-master', { masterIngredientId: beefId })
    expect(again.statusCode).toBe(200)
    expect(again.json().id).toBe(itemA)
  })

  it('a backfilled master (md5 id, not a UUID) can be picked — owner screenshot 2026-10-27 "Validation failed"', async () => {
    const id = 'f'.repeat(32)
    await prisma.ingredientMaster.create({ data: { id, name: 'Flour (All-Purpose / Maida)', normalizedName: 'flour (all-purpose / maida)', stockUnit: 'g', category: 'dry_goods', status: 'approved' } })
    const r = await call(u.chefA!, 'POST', '/inventory/from-master', { masterIngredientId: id })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ tenantId: A.tenantId, masterIngredientId: id })
  })

  it('company B gets its own item, never A\'s; the search shows each company only its own', async () => {
    const r = await call(u.chefB!, 'POST', '/inventory/from-master', { masterIngredientId: beefId })
    expect(r.statusCode).toBe(201)
    expect(r.json().tenantId).toBe(B.tenantId)
    expect(r.json().id).not.toBe(itemA)
    const seenA = (await call(u.chefA!, 'GET', `/ingredient-master/${beefId}`)).json()
    const seenB = (await call(u.chefB!, 'GET', `/ingredient-master/${beefId}`)).json()
    expect(seenA.companyItemId).toBe(itemA)
    expect(seenB.companyItemId).toBe(r.json().id)
  })

  it('an unlinked item of the same name and unit is linked, never duplicated', async () => {
    const legacy = await prisma.inventoryItem.create({ data: { name: 'Cheddar', unit: 'kg', tenantId: A.tenantId, category: 'dairy' } })
    const m = (await call(u.chefB!, 'POST', '/ingredient-master', { name: 'cheddar', unit: 'kg', category: 'dairy' })).json()
    const r = await call(u.chefA!, 'POST', '/inventory/from-master', { masterIngredientId: m.id })
    expect(r.statusCode).toBe(200)
    expect(r.json().id).toBe(legacy.id)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: legacy.id } })).masterIngredientId).toBe(m.id)
  })

  it('POST /inventory links the new item to its master (new name → needs_review)', async () => {
    const r = await call(u.buyerA!, 'POST', '/inventory', { name: 'Brioche flour', unit: 'kg', category: 'dry_goods' })
    expect(r.statusCode, r.body).toBe(201)
    const m = await prisma.ingredientMaster.findUniqueOrThrow({ where: { id: r.json().masterIngredientId } })
    expect(m).toMatchObject({ normalizedName: 'brioche flour', status: 'needs_review', category: 'dry_goods' })
    // Company B's same ingredient joins the same master.
    const rb = await call(u.chefB!, 'POST', '/inventory', { name: 'brioche flour', unit: 'kg' })
    expect(rb.statusCode).toBe(201)
    expect(rb.json().masterIngredientId).toBe(m.id)
    expect(rb.json().category).toBe('dry_goods')
  })

  it('a linked item\'s definition is locked (422 MASTER_FIELD_LOCKED); its par stays the company\'s', async () => {
    const lock = await call(u.chefA!, 'PATCH', `/inventory/${itemA}`, { category: 'dairy' })
    expect(lock.statusCode).toBe(422)
    expect(lock.json().error.code).toBe('MASTER_FIELD_LOCKED')
    const same = await call(u.chefA!, 'PATCH', `/inventory/${itemA}`, { category: 'protein', parLevel: 4 })
    expect(same.statusCode, same.body).toBe(200)
    expect(same.json().parLevel).toBe(4)
  })
})

describe('editing and merging the master', () => {
  it('allergens reach every company\'s item; only a reviewer marks it reviewed', async () => {
    const r = await call(u.chefA!, 'PATCH', `/ingredient-master/${beefId}`, { allergens: ['beef'], spec: '80/20, coarse, no sinew' })
    expect(r.statusCode, r.body).toBe(200)
    const items = await prisma.inventoryItem.findMany({ where: { masterIngredientId: beefId } })
    expect(items).toHaveLength(2)
    for (const it of items) expect(it.allergens).toEqual(['beef'])
    expect((await call(u.chefA!, 'PATCH', `/ingredient-master/${beefId}`, { status: 'approved' })).statusCode).toBe(403)
    const ok = await call(u.fnbA!, 'PATCH', `/ingredient-master/${beefId}`, { status: 'approved' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('approved')
  })

  it('a category change moves each company\'s lots with its own posting', async () => {
    const itemA = (await prisma.inventoryItem.findFirstOrThrow({ where: { masterIngredientId: beefId, tenantId: A.tenantId } })).id
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: A.tenantId, inventoryItemId: itemA, qty: 2, unitCostCents: 100_000, kind: 'opening', lotSourceType: 'opening',
      lotSourceId: 'im-1', movementSourceType: 'test', movementSourceId: 'im-1', receivedAt: new Date(), locationId: A.locationId,
    }))
    // Beef is not a drink, but the class move is what we are testing.
    // Category is the reviewers' — and only one who belongs to every company that stocks it (A and B here).
    expect((await call(u.chefA!, 'PATCH', `/ingredient-master/${beefId}`, { category: 'beverage' })).statusCode).toBe(403)
    const notAll = await call(u.fnbA!, 'PATCH', `/ingredient-master/${beefId}`, { category: 'beverage' })
    expect(notAll.statusCode).toBe(409)
    expect(notAll.json().error.code).toBe('MASTER_CATEGORY_NEEDS_MEMBERSHIP')
    const r = await call(u.ceo!, 'PATCH', `/ingredient-master/${beefId}`, { category: 'beverage' })
    expect(r.statusCode, r.body).toBe(200)
    const items = await prisma.inventoryItem.findMany({ where: { masterIngredientId: beefId } })
    for (const it of items) expect(it.category).toBe('beverage')
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: { startsWith: `inventory.item_reclass:${itemA}:` } } })).toBe(1)
    expect(await prisma.journalEntry.count({ where: { tenantId: B.tenantId, reference: { startsWith: 'inventory.item_reclass:' } } })).toBe(0)
    await call(u.ceo!, 'PATCH', `/ingredient-master/${beefId}`, { category: 'protein' })
  })

  it('a unit change once a company holds stock is 409 MASTER_UNIT_IN_USE', async () => {
    expect((await call(u.chefA!, 'PATCH', `/ingredient-master/${beefId}`, { unit: 'pcs' })).statusCode).toBe(403)
    const r = await call(u.ceo!, 'PATCH', `/ingredient-master/${beefId}`, { unit: 'pcs' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('MASTER_UNIT_IN_USE')
  })

  it('merge: reviewers only; a company holding both is refused; otherwise the items follow', async () => {
    const dup = (await call(u.chefB!, 'POST', '/ingredient-master', { name: 'Minced beef', unit: 'kg', category: 'protein' })).json()
    expect((await call(u.chefA!, 'POST', `/ingredient-master/${dup.id}/merge`, { intoId: beefId })).statusCode).toBe(403)
    const itemB = (await call(u.chefB!, 'POST', '/inventory/from-master', { masterIngredientId: dup.id }))
    expect(itemB.statusCode).toBe(201)
    // B already stocks beefId too → refused, listing B's two items to a member of B.
    const refused = await call(u.ceo!, 'POST', `/ingredient-master/${dup.id}/merge`, { intoId: beefId })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.code).toBe('MERGE_NEEDS_STOCK_MERGE')
    expect(refused.json().error.details.companies[0].tenantId).toBe(B.tenantId)
    // A clean duplicate (only A stocks it, A has no beefId twin… use a fresh pair).
    const keep = (await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Sesame seeds', unit: 'kg' })).json()
    const twin = (await call(u.chefB!, 'POST', '/ingredient-master', { name: 'Seeds sesame', unit: 'kg' })).json()
    const tItem = (await call(u.chefB!, 'POST', '/inventory/from-master', { masterIngredientId: twin.id })).json()
    const ok = await call(u.fnbA!, 'POST', `/ingredient-master/${twin.id}/merge`, { intoId: keep.id })
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: tItem.id } })).masterIngredientId).toBe(keep.id)
    expect((await prisma.ingredientMaster.findUniqueOrThrow({ where: { id: twin.id } })).mergedIntoId).toBe(keep.id)
    // The merged row leaves the search; a stale id still resolves to the kept one.
    expect((await call(u.chefA!, 'GET', '/ingredient-master?q=seeds sesame')).json()).toHaveLength(0)
    const viaOld = await call(u.chefA!, 'POST', '/inventory/from-master', { masterIngredientId: twin.id })
    expect(viaOld.json().masterIngredientId).toBe(keep.id)
    expect(await prisma.auditLog.count({ where: { action: 'ingredient_master.merge', entityId: twin.id } })).toBe(1)
  })
})

describe('units, whitespace and twins (owner review)', () => {
  it('one normalise rule: tabs / NBSP collapse; kg and g are ONE master, pcs is another', async () => {
    const a = (await call(u.chefA!, 'POST', '/ingredient-master', { name: '\u00a0Basmati\tRice ', unit: 'kg' })).json()
    const b = (await call(u.chefB!, 'POST', '/ingredient-master', { name: 'basmati rice', unit: 'g' }))
    expect(b.json().id).toBe(a.id)
    expect(a).toMatchObject({ name: 'Basmati Rice', stockUnit: 'g' })
    const eggsKg = (await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Duck eggs', unit: 'kg' })).json()
    const eggsPcs = await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Duck eggs', unit: 'pcs' })
    expect(eggsPcs.statusCode).toBe(201)
    expect(eggsPcs.json().id).not.toBe(eggsKg.id)
    expect(eggsPcs.json().stockUnit).toBe('pcs')
  })

  it('POST /inventory keeps the typed unit and cost (kg on a g master); a picked master of another family is 409', async () => {
    const m = (await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Jasmine rice', unit: 'g' })).json()
    const r = await call(u.buyerA!, 'POST', '/inventory', { name: 'Jasmine rice', unit: 'kg', unitCostCents: 30_000 })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ unit: 'kg', unitCostCents: 30_000, masterIngredientId: m.id })
    const bad = await call(u.chefB!, 'POST', '/inventory', { name: 'Jasmine rice sack', unit: 'pcs', masterIngredientId: m.id })
    expect(bad.statusCode).toBe(409)
    expect(bad.json().error.code).toBe('MASTER_UNIT_MISMATCH')
  })

  it('merge: different unit families 409 MERGE_UNIT_MISMATCH; different categories 409 MERGE_CATEGORY_MISMATCH', async () => {
    const x = (await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Quail eggs', unit: 'pcs', category: 'dairy' })).json()
    const y = (await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Quail egg pulp', unit: 'kg', category: 'dairy' })).json()
    const z = (await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Quail egg', unit: 'pcs', category: 'protein' })).json()
    const r1 = await call(u.ceo!, 'POST', `/ingredient-master/${x.id}/merge`, { intoId: y.id })
    expect(r1.statusCode).toBe(409)
    expect(r1.json().error.code).toBe('MERGE_UNIT_MISMATCH')
    const r2 = await call(u.ceo!, 'POST', `/ingredient-master/${x.id}/merge`, { intoId: z.id })
    expect(r2.statusCode).toBe(409)
    expect(r2.json().error.code).toBe('MERGE_CATEGORY_MISMATCH')
  })

  it('giving a company-less item a company that already stocks its ingredient is 409 MASTER_TWIN_EXISTS', async () => {
    const m = (await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Saffron', unit: 'g' })).json()
    await call(u.chefA!, 'POST', '/inventory/from-master', { masterIngredientId: m.id })
    const orphan = await prisma.inventoryItem.create({ data: { name: 'Saffron', unit: 'g', tenantId: null, masterIngredientId: m.id } })
    const r = await call(u.ceo!, 'PATCH', `/inventory/${orphan.id}`, { tenantId: A.tenantId })
    expect(r.statusCode, r.body).toBe(409)
    expect(r.json().error.code).toBe('MASTER_TWIN_EXISTS')
  })

  it('a Trash restore whose ingredient the company already stocks comes back unlinked and flagged, never a 500', async () => {
    const { INVENTORY_TRASH_PROVIDERS } = await import('../src/modules/trash/providers/masters/inventory.js')
    const m = (await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Star anise', unit: 'g' })).json()
    const parked = await prisma.inventoryItem.create({ data: { name: 'Star anise', unit: 'g', tenantId: A.tenantId, masterIngredientId: m.id, deletedAt: new Date() } })
    const live = (await call(u.chefA!, 'POST', '/inventory/from-master', { masterIngredientId: m.id })).json()
    expect(live.id).not.toBe(parked.id)
    const provider = INVENTORY_TRASH_PROVIDERS[0]!
    await prisma.$transaction((tx) => provider.restore!(tx, {} as never, { entityId: parked.id } as never, { rename: { name: 'Star anise (restored)' } } as never))
    const back = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: parked.id } })
    expect(back).toMatchObject({ deletedAt: null, masterIngredientId: null, name: 'Star anise (restored)' })
    expect(await prisma.exceptionFlag.count({ where: { kind: 'ingredient_master_unlinked', entityId: parked.id } })).toBe(1)
  })
})

describe('buying units and the twin trail (owner review N3, N4)', () => {
  it('a buying-unit change is the reviewers\', needs its factor, and leaves a company buying in its own unit alone', async () => {
    const m = (await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Sea salt', unit: 'g', purchaseUnit: 'case', purchaseUnitFactor: 24_000 })).json()
    const itA = (await call(u.chefA!, 'POST', '/inventory/from-master', { masterIngredientId: m.id })).json()
    const itB = (await call(u.chefB!, 'POST', '/inventory/from-master', { masterIngredientId: m.id })).json()
    await prisma.inventoryItem.update({ where: { id: itB.id }, data: { purchaseUnit: 'bag', purchaseUnitFactor: 5_000 } })
    expect((await call(u.chefA!, 'PATCH', `/ingredient-master/${m.id}`, { purchaseUnitFactor: 12_000 })).statusCode).toBe(403)
    const noFactor = await call(u.ceo!, 'PATCH', `/ingredient-master/${m.id}`, { purchaseUnit: 'carton' })
    expect(noFactor.statusCode).toBe(400)
    expect(noFactor.json().error.code).toBe('FACTOR_REQUIRED')
    const ok = await call(u.ceo!, 'PATCH', `/ingredient-master/${m.id}`, { purchaseUnit: 'carton', purchaseUnitFactor: 12_000 })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itA.id } })).toMatchObject({ purchaseUnit: 'carton', purchaseUnitFactor: 12_000 })
    expect(await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itB.id } })).toMatchObject({ purchaseUnit: 'bag', purchaseUnitFactor: 5_000 })
  })

  it('a twin linked by servd leaves an audit row and, when filed differently, a category flag; its company can re-file it', async () => {
    const m = (await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Smoked paprika', unit: 'g', category: 'dry_goods' })).json()
    const twin = await prisma.inventoryItem.create({ data: { name: 'smoked  paprika', unit: 'kg', tenantId: B.tenantId, category: 'sauce' } })
    const r = await call(u.chefB!, 'POST', '/inventory/from-master', { masterIngredientId: m.id })
    expect(r.json().id).toBe(twin.id)
    expect(await prisma.auditLog.count({ where: { action: 'inventory.link_master', entityId: twin.id, tenantId: B.tenantId } })).toBe(1)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'ingredient_master_category_mismatch', entityId: twin.id } })).toBe(1)
    // Filed differently from servd's: its company may re-file it; aligning to servd's is always allowed.
    expect((await call(u.chefB!, 'PATCH', `/inventory/${twin.id}`, { category: 'dairy' })).statusCode).toBe(200)
    expect((await call(u.chefB!, 'PATCH', `/inventory/${twin.id}`, { category: 'dry_goods' })).statusCode).toBe(200)
    // Once aligned, it is servd's again.
    const locked = await call(u.chefB!, 'PATCH', `/inventory/${twin.id}`, { category: 'protein' })
    expect(locked.statusCode).toBe(422)
    expect(locked.json().error.code).toBe('MASTER_FIELD_LOCKED')
  })
})

describe('the servd price (owner, 2026-10-29: "a pure ingredient availability and pricing sheet")', () => {
  it('latest = the newest delivery anywhere in servd; average = 90-day quantity-weighted; history names company', async () => {
    const m = await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Pricing Saffron', unit: 'g', category: 'dry_goods' })
    expect(m.statusCode, m.body).toBe(201)
    const id = m.json().id as string
    // Not stocked anywhere yet: no price, never an error.
    const none = await call(u.chefA!, 'GET', `/ingredient-master/${id}`)
    expect(none.json().price).toMatchObject({ displayUnit: 'kg', latestCents: null, averageCents: null })

    const a = (await call(u.chefA!, 'POST', '/inventory/from-master', { masterIngredientId: id })).json().id as string
    const b = (await call(u.chefB!, 'POST', '/inventory/from-master', { masterIngredientId: id })).json().id as string
    await prisma.inventoryItem.update({ where: { id: b }, data: { unit: 'kg' } })   // B buys by the kg — same family
    const day = (n: number) => new Date(Date.now() - n * 86_400_000)
    const lot = (tenantId: string, item: string, qty: number, cost: number, at: Date, key: string, locationId: string) =>
      prisma.$transaction((tx) => addLotTx(tx, {
        tenantId, inventoryItemId: item, qty, unitCostCents: cost, kind: 'receipt', lotSourceType: 'goods_receipt_line',
        lotSourceId: key, movementSourceType: 'test', movementSourceId: key, receivedAt: at, locationId,
      }))
    await lot(A.tenantId, a, 1000, 1, day(120), 'px-old', A.locationId)        // PKR 10 / kg, outside 90 days
    await lot(A.tenantId, a, 1000, 3, day(50), 'px-mid', A.locationId)         // PKR 30 / kg
    await lot(B.tenantId, b, 2, 4500, day(10), 'px-new', B.locationId)         // PKR 45 / kg — the newest, company B

    const r = await call(u.chefA!, 'GET', `/ingredient-master/${id}`)
    expect(r.statusCode, r.body).toBe(200)
    const p = r.json().price
    expect(p.latestCents).toBe(4500)                    // B's delivery, though A is asking
    expect(p.latestSource).toBe('delivery')
    expect(p.averageCents).toBe(4000)                   // (1 kg × 3000 + 2 kg × 4500) / 3 kg
    expect(p.averageDeliveries).toBe(2)

    const h = await call(u.chefA!, 'GET', `/ingredient-master/${id}/prices`)
    expect(h.statusCode, h.body).toBe(200)
    expect(h.json().points.map((x: { priceCents: number }) => x.priceCents)).toEqual([4500, 3000, 1000])
    expect(h.json().points[0].company).toBeTruthy()

    // The kitchen floor never sees prices.
    const cook = await call(u.cookA!, 'GET', `/ingredient-master/${id}`)
    expect(cook.json().price).toBeNull()
    const cookH = await call(u.cookA!, 'GET', `/ingredient-master/${id}/prices`)
    expect(cookH.json()).toMatchObject({ costsHidden: true, points: [] })
  })

  it('a price typed on the sheet is the latest until a newer delivery; history keeps it; the floor cannot type one', async () => {
    const id = (await call(u.chefA!, 'GET', '/ingredient-master?q=pricing saffron')).json()[0].id as string
    const cook = await call(u.cookA!, 'PUT', `/ingredient-master/${id}/price`, { priceCents: 5_000_00 })
    expect(cook.statusCode).toBe(403)
    const r = await call(u.buyerA!, 'PUT', `/ingredient-master/${id}/price`, { priceCents: 5_000_00 })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().price).toMatchObject({ latestCents: 5_000_00, latestSource: 'sheet', averageCents: 4000 })
    // Editing the name keeps the price on the row the table puts back.
    const renamed = await call(u.chefA!, 'PATCH', `/ingredient-master/${id}`, { name: 'Pricing Saffron Threads' })
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect(renamed.json().price.latestCents).toBe(5_000_00)
    const h = (await call(u.chefA!, 'GET', `/ingredient-master/${id}/prices`)).json()
    expect(h.points[0]).toMatchObject({ source: 'sheet', priceCents: 5_000_00, company: null })
    expect(await prisma.auditLog.count({ where: { action: 'ingredient_master.price', entityId: id } })).toBe(1)
    // A delivery after the typed price takes over.
    const b = (await prisma.inventoryItem.findFirstOrThrow({ where: { masterIngredientId: id, tenantId: B.tenantId } })).id
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: B.tenantId, inventoryItemId: b, qty: 1, unitCostCents: 4_200, kind: 'receipt', lotSourceType: 'goods_receipt_line',
      lotSourceId: 'px-after', movementSourceType: 'test', movementSourceId: 'px-after', receivedAt: new Date(Date.now() + 1000), locationId: B.locationId,
    }))
    const after = (await call(u.chefA!, 'GET', `/ingredient-master/${id}`)).json().price
    expect(after).toMatchObject({ latestCents: 4_200, latestSource: 'delivery' })
  })

  it('an ingredient no company stocks takes its typed price; recipes would cost it at that price', async () => {
    const m = (await call(u.chefA!, 'POST', '/ingredient-master', { name: 'Typed Only Sumac', unit: 'kg' })).json()
    const r = await call(u.chefA!, 'PUT', `/ingredient-master/${m.id}/price`, { priceCents: 2_500_00 })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().price).toMatchObject({ displayUnit: 'kg', latestCents: 2_500_00, latestSource: 'sheet' })
    const { masterPricesMany } = await import('../src/lib/ingredientPrices.js')
    expect((await masterPricesMany([m.id])).get(m.id)!.latestPerBase).toBeCloseTo(250)   // paisa per g
    expect((await call(u.chefA!, 'PUT', `/ingredient-master/${m.id}/price`, { priceCents: 0 })).statusCode).toBe(400)
  })
})

