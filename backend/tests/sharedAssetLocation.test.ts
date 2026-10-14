// Shared equipment must name its location (owner, 2026-10-14, from the old
// Add-asset form: "when Brand is Shared, ask for the location").
//
//   • Capitalise (POST /finance/capex/lines/:lineId/capitalise): an individual
//     asset takes `conceptId` (omitted = the project's brand; null = shared
//     across brands). The resulting asset with NO brand and NO location (the
//     project's outlet counts) is 422 LOCATION_REQUIRED_FOR_SHARED — raised
//     by finance or by the CEO. With a location it posts and the register and
//     the asset page show the outlet.
//   • A brand or outlet of company B on A's line → 422; B's finance on A's
//     line → 404.
//   • A capitalisation already pending (raised before the rule) approves as
//     before — the rule is checked when the request is raised only.
//   • Transfer: moving an asset to Shared while it has no location, or a
//     shared asset off its outlet → 422; naming the outlet → posted.
//   • Pooled smallwares still need an outlet (POOL_NEEDS_LOCATION).
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { FixedAsset, UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import { postAcquisition, nextAssetTag } from '../src/modules/fixedAssets/service.js'
import { fixedAssetRoutes } from '../src/modules/fixedAssets/routes.js'
import { financePlanningRoutes } from '../src/modules/financePlanning/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
const FA = '/accounting/fixed-assets'
let app: FastifyInstance
const who: Record<string, { id: string; token: string }> = {}
interface Co { tenantId: string; brand: string; brand2: string; outlet: string; outlet2: string }
let A: Co, B: Co
let seq = 0

async function mkCo(name: string): Promise<Co> {
  const tenantId = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(tenantId)
  await ensureAssetClasses(tenantId)
  const s = `${++seq}-${RUN}`
  return {
    tenantId,
    brand: (await prisma.concept.create({ data: { name: `${name} brand`, slug: `sal-b-${s}`, type: 'restaurant', tenantId } })).id,
    brand2: (await prisma.concept.create({ data: { name: `${name} brand 2`, slug: `sal-b2-${s}`, type: 'restaurant', tenantId } })).id,
    outlet: (await prisma.location.create({ data: { name: `${name} Clifton`, slug: `sal-l-${s}`, tenantId } })).id,
    outlet2: (await prisma.location.create({ data: { name: `${name} DHA`, slug: `sal-l2-${s}`, tenantId } })).id,
  }
}
async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@sharedloc.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  who[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (w: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${who[w]!.token}` }, ...(payload !== undefined ? { payload: payload as never } : {}) })
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code

const delivered = () => ({ status: 'delivered', actualDeliveryDate: new Date(Date.now() - 5 * 86_400_000) })
async function project(co: Co, extra: { conceptId?: string; locationId?: string } = {}) {
  return (await prisma.capexProject.create({ data: { tenantId: co.tenantId, name: `Fit-out ${++seq} ${RUN}`, ...extra } })).id
}
async function line(projectId: string, item: string, extra: Record<string, unknown> = {}) {
  return (await prisma.capexLine.create({ data: { projectId, scope: 'Equipment', item, unitCostCents: 400_000, ...delivered(), ...extra } })).id
}
async function mkAsset(co: Co, name: string, at: { conceptId: string | null; locationId: string | null }): Promise<FixedAsset> {
  const inService = new Date(Date.now() - 40 * 86_400_000)
  return prisma.$transaction(async (tx) => {
    const asset = await tx.fixedAsset.create({
      data: {
        tenantId: co.tenantId, name, category: 'kitchen_equipment', assetTag: await nextAssetTag(tx, co.tenantId), acquiredAt: inService, inServiceAt: inService,
        costCents: 120_000, originalCostCents: 120_000, usefulLifeMonths: 12, conceptId: at.conceptId, locationId: at.locationId, acquisitionCreditCode: '2012',
      },
    })
    await postAcquisition(tx, asset, { advancedCents: 0, owedCents: 120_000, inputTaxCents: 0, inputTaxCode: null, natural: inService })
    return asset
  })
}

beforeAll(async () => {
  A = await mkCo('Shared Loc A')
  B = await mkCo('Shared Loc B')
  await mkUser('ceoA', 'admin', A.tenantId)
  await mkUser('finA', 'finance', A.tenantId)
  await mkUser('ceoB', 'admin', B.tenantId)
  await mkUser('finB', 'finance', B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(financePlanningRoutes, { prefix: '/finance' })
  await app.register(fixedAssetRoutes, { prefix: FA })
  await app.ready()
}, 90_000)

afterAll(async () => {
  // Every entry this suite wrote balances.
  const entries = await prisma.journalEntry.findMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] } }, include: { lines: true } })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + Number(l.amountCents), 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + Number(l.amountCents), 0)
    expect({ ref: e.reference, d }).toEqual({ ref: e.reference, d: c })
  }
  await app?.close()
})

describe('capitalising shared equipment needs its location', () => {
  it('no brand and no outlet → 422 for finance and the CEO; naming the outlet posts and shows it', async () => {
    const p = await project(A)
    const oven = await line(p, 'Combi oven')
    for (const w of ['finA', 'ceoA']) {
      const r = await call(w, 'POST', `/finance/capex/lines/${oven}/capitalise`, { classKey: 'kitchen_equipment' })
      expect(r.statusCode, r.body).toBe(422)
      expect(code(r)).toBe('LOCATION_REQUIRED_FOR_SHARED')
      expect(code(await call(w, 'POST', `/finance/capex/lines/${oven}/capitalise`, { classKey: 'kitchen_equipment', conceptId: null }))).toBe('LOCATION_REQUIRED_FOR_SHARED')
      expect(code(await call(w, 'POST', `/finance/capex/lines/${oven}/capitalise`, { classKey: 'kitchen_equipment', conceptId: null, locationId: null }))).toBe('LOCATION_REQUIRED_FOR_SHARED')
    }
    expect(await prisma.fixedAssetEvent.count({ where: { capexLineId: oven } })).toBe(0)

    // Finance names the outlet: the request waits for the CEO and carries the location.
    const prep = await call('finA', 'POST', `/finance/capex/lines/${oven}/capitalise`, { classKey: 'kitchen_equipment', conceptId: null, locationId: A.outlet })
    expect(prep.statusCode, prep.body).toBe(202)
    const ev = await prisma.fixedAssetEvent.findUniqueOrThrow({ where: { id: prep.json().eventId } })
    expect(ev.payload).toMatchObject({ conceptId: null, locationId: A.outlet })
    const ok = await call('ceoA', 'POST', `${FA}/requests/${ev.id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    const asset = await prisma.fixedAsset.findFirstOrThrow({ where: { capexLineId: oven } })
    expect(asset).toMatchObject({ tenantId: A.tenantId, conceptId: null, locationId: A.outlet, status: 'active' })
    // The acquisition posted, the cost line on no brand (shared).
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `fixed_asset.acquire:${asset.id}` }, include: { lines: true } })
    expect(je.lines.filter((l) => l.type === 'debit').map((l) => l.conceptId)).toEqual([null])
    // The register and the asset page show where it is.
    const reg = (await call('finA', 'GET', `${FA}?status=all`)).json().assets.find((a: { id: string }) => a.id === asset.id)
    expect(reg).toMatchObject({ conceptId: null, conceptName: null, locationId: A.outlet, locationName: 'Shared Loc A Clifton' })
    const one = (await call('finA', 'GET', `${FA}/${asset.id}`)).json().asset
    expect(one).toMatchObject({ locationId: A.outlet, locationName: 'Shared Loc A Clifton' })
    // B never sees it.
    expect((await call('finB', 'GET', `${FA}/${asset.id}`)).statusCode).toBe(404)
  })

  it('the project\'s outlet counts; a brand needs no outlet; a project brand made shared needs one', async () => {
    // Project at an outlet, no brand: shared is fine — the asset sits at the project's outlet.
    const atOutlet = await project(A, { locationId: A.outlet2 })
    const fryer = await line(atOutlet, 'Fryer')
    const r1 = await call('ceoA', 'POST', `/finance/capex/lines/${fryer}/capitalise`, { classKey: 'kitchen_equipment', conceptId: null })
    expect(r1.statusCode, r1.body).toBe(201)
    expect(await prisma.fixedAsset.findFirstOrThrow({ where: { capexLineId: fryer } })).toMatchObject({ conceptId: null, locationId: A.outlet2 })

    // Project with a brand, no outlet: the brand's asset needs no outlet…
    const branded = await project(A, { conceptId: A.brand })
    const mixer = await line(branded, 'Mixer')
    const r2 = await call('ceoA', 'POST', `/finance/capex/lines/${mixer}/capitalise`, { classKey: 'kitchen_equipment' })
    expect(r2.statusCode, r2.body).toBe(201)
    expect(await prisma.fixedAsset.findFirstOrThrow({ where: { capexLineId: mixer } })).toMatchObject({ conceptId: A.brand, locationId: null })
    // …but made shared it does.
    const grill = await line(branded, 'Grill')
    expect(code(await call('ceoA', 'POST', `/finance/capex/lines/${grill}/capitalise`, { classKey: 'kitchen_equipment', conceptId: null }))).toBe('LOCATION_REQUIRED_FOR_SHARED')
    // Another brand of the same company: taken as given.
    const r3 = await call('ceoA', 'POST', `/finance/capex/lines/${grill}/capitalise`, { classKey: 'kitchen_equipment', conceptId: A.brand2 })
    expect(r3.statusCode, r3.body).toBe(201)
    const g = await prisma.fixedAsset.findFirstOrThrow({ where: { capexLineId: grill } })
    expect(g).toMatchObject({ conceptId: A.brand2, locationId: null })
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `fixed_asset.acquire:${g.id}` }, include: { lines: true } })
    // The cost line carries the asset's brand.
    expect(je.lines.filter((l) => l.type === 'debit').every((l) => l.conceptId === A.brand2)).toBe(true)

    // A line of 2 units shared at an outlet: both assets carry the outlet.
    const pair = await line(branded, 'Prep fridge', { quantity: 2 })
    const r4 = await call('ceoA', 'POST', `/finance/capex/lines/${pair}/capitalise`, { classKey: 'kitchen_equipment', conceptId: null, locationId: A.outlet })
    expect(r4.statusCode, r4.body).toBe(201)
    const both = await prisma.fixedAsset.findMany({ where: { capexLineId: pair } })
    expect(both.map((a) => [a.conceptId, a.locationId])).toEqual([[null, A.outlet], [null, A.outlet]])
  })

  it('another company\'s brand or outlet → 422; B\'s finance on A\'s line → 404; pooled still needs an outlet', async () => {
    const p = await project(A, { conceptId: A.brand })
    const hood = await line(p, 'Extraction hood')
    expect(code(await call('ceoA', 'POST', `/finance/capex/lines/${hood}/capitalise`, { classKey: 'kitchen_equipment', conceptId: B.brand }))).toBe('CONCEPT_NOT_IN_COMPANY')
    expect(code(await call('ceoA', 'POST', `/finance/capex/lines/${hood}/capitalise`, { classKey: 'kitchen_equipment', conceptId: null, locationId: B.outlet }))).toBe('LOCATION_NOT_IN_COMPANY')
    expect((await call('finB', 'POST', `/finance/capex/lines/${hood}/capitalise`, { classKey: 'kitchen_equipment', conceptId: null, locationId: B.outlet })).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/finance/capex/lines/${hood}/capitalise`, { classKey: 'kitchen_equipment', conceptId: B.brand, locationId: B.outlet })).statusCode).toBe(404)
    expect(await prisma.fixedAssetEvent.count({ where: { capexLineId: hood } })).toBe(0)

    // Smallwares: a pool lives at an outlet, whatever the brand.
    const plates = await line(p, 'Dinner plates', { quantity: 50, unitCostCents: 500 })
    expect(code(await call('ceoA', 'POST', `/finance/capex/lines/${plates}/capitalise`, { classKey: 'smallwares', pool: { typeKey: 'plates', conceptId: A.brand } }))).toBe('POOL_NEEDS_LOCATION')
    const ok = await call('ceoA', 'POST', `/finance/capex/lines/${plates}/capitalise`, { classKey: 'smallwares', locationId: A.outlet, pool: { typeKey: 'plates', conceptId: null } })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(await prisma.fixedAsset.findFirstOrThrow({ where: { capexLineId: plates } })).toMatchObject({ kind: 'pool_layer', conceptId: null, locationId: A.outlet })
  })

  it('a capitalisation already pending (raised before the rule) approves as before', async () => {
    const p = await project(A)
    const range = await line(p, 'Old range')
    const ev = await prisma.fixedAssetEvent.create({
      data: {
        tenantId: A.tenantId, capexLineId: range, kind: 'capitalise', status: 'pending', effectiveDate: new Date(),
        payload: { classKey: 'kitchen_equipment' }, reason: 'Delivered before the location rule', requestedById: who.finA!.id,
      },
    })
    const ok = await call('ceoA', 'POST', `${FA}/requests/${ev.id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await prisma.fixedAsset.findFirstOrThrow({ where: { capexLineId: range } })).toMatchObject({ conceptId: null, locationId: null })
  })
})

describe('moving an asset to Shared needs its location', () => {
  it('to Shared with no location → 422; off its outlet while shared → 422; with the outlet → posted', async () => {
    const noOutlet = await mkAsset(A, 'Branded blender', { conceptId: A.brand, locationId: null })
    const r = await call('finA', 'POST', `${FA}/${noOutlet.id}/requests`, { kind: 'transfer', reason: 'Moved by finance today', payload: { toConceptId: null } })
    expect(r.statusCode, r.body).toBe(422)
    expect(code(r)).toBe('LOCATION_REQUIRED_FOR_SHARED')
    expect(await prisma.fixedAssetEvent.count({ where: { assetId: noOutlet.id } })).toBe(0)
    // Another company's outlet → 422; B on A's asset → 404.
    expect(code(await call('finA', 'POST', `${FA}/${noOutlet.id}/requests`, { kind: 'transfer', reason: 'Moved by finance today', payload: { toConceptId: null, toLocationId: B.outlet } }))).toBe('LOCATION_NOT_IN_COMPANY')
    expect((await call('finB', 'POST', `${FA}/${noOutlet.id}/requests`, { kind: 'transfer', reason: 'Moved by finance today', payload: { toConceptId: null, toLocationId: B.outlet } })).statusCode).toBe(404)

    const moved = await call('finA', 'POST', `${FA}/${noOutlet.id}/requests`, { kind: 'transfer', reason: 'Moved by finance today', payload: { toConceptId: null, toLocationId: A.outlet } })
    expect(moved.statusCode, moved.body).toBe(201)
    expect(await prisma.fixedAsset.findUniqueOrThrow({ where: { id: noOutlet.id } })).toMatchObject({ conceptId: null, locationId: A.outlet })
    // The brand changed: cost moved off the brand (zero net).
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `fixed_asset.transfer:${moved.json().event.id}` }, include: { lines: true } })
    expect(je.lines.some((l) => l.conceptId === A.brand && l.type === 'credit')).toBe(true)
    expect(je.lines.some((l) => l.conceptId === null && l.type === 'debit')).toBe(true)

    // Now shared at an outlet: taking it off the outlet is refused; moving outlets is fine.
    expect(code(await call('finA', 'POST', `${FA}/${noOutlet.id}/requests`, { kind: 'transfer', reason: 'Moved by finance today', payload: { toLocationId: null } }))).toBe('LOCATION_REQUIRED_FOR_SHARED')
    const next = await call('finA', 'POST', `${FA}/${noOutlet.id}/requests`, { kind: 'transfer', reason: 'Moved by finance today', payload: { toLocationId: A.outlet2 } })
    expect(next.statusCode, next.body).toBe(201)
    expect(await prisma.fixedAsset.findUniqueOrThrow({ where: { id: noOutlet.id } })).toMatchObject({ conceptId: null, locationId: A.outlet2 })

    // An asset with a brand may leave its outlet (it still says whose it is).
    const branded = await mkAsset(A, 'Branded toaster', { conceptId: A.brand, locationId: A.outlet })
    expect((await call('finA', 'POST', `${FA}/${branded.id}/requests`, { kind: 'transfer', reason: 'Moved by finance today', payload: { toLocationId: null } })).statusCode).toBe(201)
  })
})

// Final gate (receipts-1 / receipts-2, 2026-10-14).
describe('the rule holds between raise and apply', () => {
  it('a capitalisation carries the outlet it was checked against: the project\'s outlet cleared while it waits changes nothing', async () => {
    const p = await project(A, { locationId: A.outlet })
    const fryer = await line(p, 'Waiting fryer')
    const raised = await call('finA', 'POST', `/finance/capex/lines/${fryer}/capitalise`, { classKey: 'kitchen_equipment' })
    expect(raised.statusCode, raised.body).toBe(202)
    const ev = await prisma.fixedAssetEvent.findFirstOrThrow({ where: { capexLineId: fryer, kind: 'capitalise', status: 'pending' } })
    expect(ev.payload).toMatchObject({ locationId: A.outlet, conceptId: null })
    // The project is edited while the request waits.
    await prisma.capexProject.update({ where: { id: p }, data: { locationId: null } })
    const ok = await call('ceoA', 'POST', `${FA}/requests/${ev.id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await prisma.fixedAsset.findFirstOrThrow({ where: { capexLineId: fryer } })).toMatchObject({ conceptId: null, locationId: A.outlet })
  })

  it('two transfers sent together (one clears the outlet, one the brand): one applies, the other is refused — never shared with no location', async () => {
    const { createRequest } = await import('../src/modules/fixedAssets/events.js')
    const asset = await mkAsset(A, 'Raced mixer', { conceptId: A.brand, locationId: A.outlet })
    const r = await Promise.allSettled([
      createRequest({ kind: 'transfer', assetId: asset.id, tenantId: A.tenantId, reason: 'Moved to the central store', payload: { toLocationId: null } } as never, { id: who.finA!.id, role: 'finance' }),
      createRequest({ kind: 'transfer', assetId: asset.id, tenantId: A.tenantId, reason: 'Shared across brands now', payload: { toConceptId: null } } as never, { id: who.ceoA!.id, role: 'admin' }),
    ])
    const after = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: asset.id } })
    expect(after.conceptId !== null || after.locationId !== null).toBe(true)
    const refused = r.filter((x) => x.status === 'rejected').map((x) => (x as PromiseRejectedResult).reason?.code)
    expect(refused.length).toBeLessThanOrEqual(1)
    if (refused.length === 1) expect(refused[0]).toBe('LOCATION_REQUIRED_FOR_SHARED')
  })
})
