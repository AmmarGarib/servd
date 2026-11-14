// The servd supplier list (owner, 2026-11-14: "we need to make suppliers belong to servd. just like the ingredient
// master list"): one servd supplier, one account per company; details shared, money per company.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company
let B: Company
let ceo: Who       // member of A and B
let buyerA: Who    // procurement, A only
let mgrB: Who      // manager, B only
const stamp = Date.now()
const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, tenant?: string) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { authorization: `Bearer ${who.token}`, ...(tenant ? { 'x-servd-active-tenant': tenant } : {}) } })

beforeAll(async () => {
  A = await mkCompany('supm-a')
  B = await mkCompany('supm-b')
  ceo = await mkUser('supmCeo', 'admin', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: ceo.id } })
  buyerA = await mkUser('supmBuyer', 'procurement', A.tenantId)
  mgrB = await mkUser('supmMgrB', 'manager', B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.ready()
}, 60_000)
afterAll(async () => { await app?.close() })

describe('one servd supplier, one account per company', () => {
  let aId = ''
  let masterId = ''

  it('a new supplier joins the servd list; the same name again in the same company is refused', async () => {
    const r = await call(buyerA, 'POST', '/procurement/suppliers', { name: `  Paradise   Store ${stamp} `, phone: '0300111', filerStatus: 'filer', paymentTermsDays: 15 })
    expect(r.statusCode, r.body).toBe(201)
    aId = r.json().id
    const row = await prisma.supplier.findUniqueOrThrow({ where: { id: aId } })
    expect(row).toMatchObject({ tenantId: A.tenantId, name: `Paradise Store ${stamp}`, paymentTermsDays: 15, filerStatus: 'filer' })
    masterId = row.masterSupplierId!
    expect(masterId).toBeTruthy()
    const dup = await call(buyerA, 'POST', '/procurement/suppliers', { name: `paradise store ${stamp}` })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('SUPPLIER_ALREADY_IN_COMPANY')
  })

  it('company B adding the same name opens ITS account on the same servd supplier, with servd\'s details', async () => {
    const r = await call(mgrB, 'POST', '/procurement/suppliers', { name: `PARADISE STORE ${stamp}`, phone: '0999', paymentTermsDays: 45 })
    expect(r.statusCode, r.body).toBe(201)
    const row = await prisma.supplier.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(row).toMatchObject({ tenantId: B.tenantId, masterSupplierId: masterId, name: `Paradise Store ${stamp}`, phone: '0300111', filerStatus: 'filer', paymentTermsDays: 45 })
    expect(toNum(row.openingBalanceCents)).toBe(0)
  })

  it('the servd list shows it once, with the active company\'s account; from-master is idempotent', async () => {
    const list = (await call(ceo, 'GET', `/procurement/supplier-masters?q=${encodeURIComponent(`paradise store ${stamp}`)}`, undefined, A.tenantId)).json()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: masterId, companySupplierId: aId })
    expect(list[0].openingBalanceCents).toBeUndefined()
    const again = await call(buyerA, 'POST', '/procurement/suppliers/from-master', { masterSupplierId: masterId })
    expect(again.statusCode).toBe(200)
    expect(again.json().id).toBe(aId)
  })

  it('details are servd-wide: B\'s phone edit reaches A\'s account; terms stay per company; a rename is the CEO\'s', async () => {
    const b = await prisma.supplier.findFirstOrThrow({ where: { tenantId: B.tenantId, masterSupplierId: masterId } })
    const r = await call(mgrB, 'PATCH', `/procurement/suppliers/${b.id}`, { phone: '0311222', paymentTermsDays: 60 })
    expect(r.statusCode, r.body).toBe(200)
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: aId } })).toMatchObject({ phone: '0311222', paymentTermsDays: 15 })
    const no = await call(mgrB, 'PATCH', `/procurement/suppliers/${b.id}`, { name: `Paradise Mart ${stamp}` })
    expect(no.statusCode).toBe(403)
    const yes = await call(ceo, 'PATCH', `/procurement/suppliers/${aId}`, { name: `Paradise Mart ${stamp}` }, A.tenantId)
    expect(yes.statusCode, yes.body).toBe(200)
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: b.id } })).name).toBe(`Paradise Mart ${stamp}`)
    // Company B never sees or edits A's account itself.
    expect((await call(mgrB, 'PATCH', `/procurement/suppliers/${aId}`, { notes: 'x' })).statusCode).toBe(404)
  })

  it('merge: two servd entries become one; refused while a company has an account on both', async () => {
    const x = (await call(buyerA, 'POST', '/procurement/suppliers', { name: `Paradise Stores ${stamp}` })).json()
    const xMaster = (await prisma.supplier.findUniqueOrThrow({ where: { id: x.id } })).masterSupplierId!
    const blocked = await call(ceo, 'POST', `/procurement/supplier-masters/${xMaster}/merge`, { intoId: masterId }, A.tenantId)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error.code).toBe('MERGE_NEEDS_ACCOUNT_MERGE')
    expect((await call(buyerA, 'POST', `/procurement/supplier-masters/${xMaster}/merge`, { intoId: masterId })).statusCode).toBe(403)
    await prisma.supplier.update({ where: { id: x.id }, data: { deletedAt: new Date() } })
    const ok = await call(ceo, 'POST', `/procurement/supplier-masters/${xMaster}/merge`, { intoId: masterId }, A.tenantId)
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await prisma.supplierMaster.findUniqueOrThrow({ where: { id: xMaster } })).mergedIntoId).toBe(masterId)
    const list = (await call(ceo, 'GET', `/procurement/supplier-masters?q=${encodeURIComponent(`paradise stores ${stamp}`)}`, undefined, A.tenantId)).json()
    expect(list).toHaveLength(0)
  })
})

describe('the backfill migration', () => {
  it('links same-name suppliers of two companies to ONE servd supplier; a second same-name account in one company gets its own', async () => {
    const mk = (tenantId: string, name: string) => prisma.supplier.create({ data: { tenantId, name } })
    const a1 = await mk(A.tenantId, `Backfill  Co ${stamp}`)
    const b1 = await mk(B.tenantId, `backfill co ${stamp}`)
    await new Promise((r) => setTimeout(r, 5))
    const a2 = await mk(A.tenantId, `Backfill Co ${stamp}`)
    const sql = readFileSync(join(__dirname, '../prisma/migrations/20261114120000_supplier_master/migration.sql'), 'utf8')
    const from = sql.indexOf('CREATE TABLE "_supplier_master_backfill"')
    const to = sql.indexOf('-- ─── SQL-only objects')
    // Only the three test rows: the rest of the table is already linked by the routes above.
    const body = sql.slice(from, to).replace('AND btrim(regexp_replace(s.name, \'\\s+\', \' \', \'g\')) <> \'\';', `AND s.id IN ('${a1.id}','${b1.id}','${a2.id}');`)
    for (const stmt of body.split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) await prisma.$executeRawUnsafe(stmt)
    const [ra1, rb1, ra2] = await Promise.all([a1, b1, a2].map((x) => prisma.supplier.findUniqueOrThrow({ where: { id: x.id } })))
    expect(ra1.masterSupplierId).toBeTruthy()
    expect(rb1.masterSupplierId).toBe(ra1.masterSupplierId)
    expect(ra2.masterSupplierId).not.toBe(ra1.masterSupplierId)
    expect((await prisma.supplierMaster.findUniqueOrThrow({ where: { id: ra2.masterSupplierId! } })).name).toBe(`Backfill Co ${stamp} (duplicate 1)`)
  })
})

function toNum(v: unknown): number { return Number(v) }
