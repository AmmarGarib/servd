// Equipment on a finance payee voucher (owner, 2026-10-19): a payee voucher
// (kind 'expense') may name a fixed-asset class instead of an expense account.
// Finance's pay books it through the CapEx Quick-buy engine
// (financePlanning/capexPosting.ts recordEquipmentPurchaseTx):
//   - from a bank / cash on hand: 'capex.payment:<id>' Dr 1340 / Cr the source;
//   - from a box: the one spend path, its capex line → Dr 1340 / Cr 1011, the float drops;
//   - the SAME capitalisation request Quick buy raises; the CEO's approval
//     posts Dr class cost / Cr 1340, the asset joins the register and
//     depreciates through the existing monthly charge.
// Guards: another company's class 422, a cash request (kind 'request') 422
// ASSET_ONLY_ON_PAYEE_VOUCHER, shared equipment with no outlet 422
// LOCATION_REQUIRED_FOR_SHARED, the documents check books nothing, company B
// gets 404 on company A's voucher.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import { applyEvent, rejectEvent } from '../src/modules/fixedAssets/events.js'
import { chargeThrough } from '../src/modules/fixedAssets/service.js'
import { lastCompletedPeriodPkt } from '../src/modules/fixedAssets/schedule.js'

const P = `cva${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const box: Record<string, string> = {}
const bank: Record<string, string> = {}
const loc: Record<string, string> = {}
const cls: Record<string, string> = {}
let brandA = ''

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n')

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@cva.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const call = (key: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }, ...(payload !== undefined && { payload: payload as object }) })

const V = '/trustops/cash-vouchers'
type Row = {
  id: string; number: string; status: string; amountCents: number; category: string | null; assetClassId: string | null
  assetLocationId: string | null; capexLineId: string | null; capitaliseEventId: string | null; bookedAtPay: boolean
  payJournalEntryId: string | null; pettyCashMovementId: string | null; assetClassLabel: string | null; paidAccountCode?: string | null
}

/** finA raises a payee voucher for equipment; it goes straight to the CEO, who approves. */
async function approvedAsset(extra: Record<string, unknown>, amountCents = 250_000): Promise<Row> {
  const r = await call('finA', 'POST', V, { kind: 'expense', payeeName: 'Cool Tech Traders', purpose: `Chiller ${Math.random().toString(36).slice(2, 7)}`, amountCents, ...extra })
  expect(r.statusCode, r.body).toBe(201)
  const v = r.json() as Row
  const a = await call('ceoA', 'POST', `${V}/${v.id}/approve`, {})
  expect(a.statusCode, a.body).toBe(200)
  return a.json() as Row
}
async function entryLines(reference: string, tenantId = T.A) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, orderBy: { createdAt: 'desc' }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je ? je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort() : null
}
const floatOf = async (id: string) => (await prisma.pettyCashBox.findUniqueOrThrow({ where: { id } })).floatCents
async function capexPaymentsOf(lineId: string) {
  return prisma.capexPayment.findMany({ where: { lineId }, select: { id: true, source: true, whtCents: true } })
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Asset Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Asset Co B', slug: `${P}-b` } })).id
  for (const t of [T.A, T.B]) { await ensureChartOfAccounts(t); await ensureAssetClasses(t) }
  invalidateSetupCache()
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('finB', 'finance', [T.B])
  await mkUser('cookA', 'boh', [T.A])
  await mkUser('cashA', 'cashier', [T.A])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => { await api.register(trustopsRoutes, { prefix: '/trustops' }) }, { prefix: '/api/v1' })
  await app.ready()

  box['A'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Finance box', custodianId: U['finA']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  const r = await call('finA', 'POST', '/trustops/petty-cash/movements', { boxId: box['A'], type: 'topup', amountCents: 1_000_000, reason: 'Float from Garibsons', source: 'garibsons' })
  expect(r.statusCode, r.body).toBe(201)
  if (!(await prisma.account.findFirst({ where: { tenantId: T.A, code: '1021' } }))) {
    await prisma.account.create({ data: { tenantId: T.A, code: '1021', name: 'Bank — HBL', type: 'asset', isActive: true } })
  }
  bank['A'] = (await prisma.bankAccount.create({ data: { tenantId: T.A, name: 'HBL Ops', bankName: 'HBL', accountCode: '1021', isActive: true } })).id
  loc['A'] = (await prisma.location.create({ data: { slug: `${P}-la`, name: 'Clifton', tenantId: T.A } })).id
  loc['B'] = (await prisma.location.create({ data: { slug: `${P}-lb`, name: 'B outlet', tenantId: T.B } })).id
  brandA = (await prisma.concept.create({ data: { name: 'Asset Cafe', slug: `${P}-c`, type: 'restaurant', tenantId: T.A, taxRateCash: 15, taxRateCard: 8 } })).id
  for (const t of ['A', 'B'] as const) {
    cls[t] = (await prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId: T[t], key: 'kitchen_equipment' } })).id
  }
  cls['A_small'] = (await prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId: T.A, key: 'smallwares' } })).id
}, 120_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

describe('raising an asset voucher', () => {
  it('offers the active company\'s non-pooled classes and outlets to finance only', async () => {
    const r = await call('finA', 'GET', `${V}/raise-options`)
    expect(r.statusCode, r.body).toBe(200)
    const o = r.json() as { classes: Array<{ id: string; key: string }>; locations: Array<{ id: string }> }
    expect(o.classes.map((c) => c.id)).toContain(cls['A'])
    expect(o.classes.some((c) => c.key === 'smallwares')).toBe(false)
    const general = await prisma.location.findUniqueOrThrow({ where: { slug: `general-${T.A}` } })
    expect(general).toMatchObject({ tenantId: T.A, isActive: false, name: 'General — to be assigned' })
    // The General holding place first, then the company's outlets.
    expect(o.locations.map((l) => l.id)).toEqual([general.id, loc['A']])
    expect((await call('cookA', 'GET', `${V}/raise-options`)).statusCode).toBe(403)
  })

  it('General — to be assigned: one per company, usable only by its own company, paid and capitalised there', async () => {
    await call('finA', 'GET', `${V}/raise-options`)
    const ob = (await call('finB', 'GET', `${V}/raise-options`)).json() as { locations: Array<{ id: string; general?: boolean }> }
    const genA = (await prisma.location.findUniqueOrThrow({ where: { slug: `general-${T.A}` } })).id
    const genB = (await prisma.location.findUniqueOrThrow({ where: { slug: `general-${T.B}` } })).id
    expect(ob.locations[0]).toMatchObject({ id: genB, general: true })
    expect(ob.locations.map((l) => l.id)).not.toContain(genA)
    expect(await prisma.location.count({ where: { slug: { in: [`general-${T.A}`, `general-${T.B}`] } } })).toBe(2)
    // Company A cannot park its equipment at company B's General.
    const bad = await call('finA', 'POST', V, { kind: 'expense', payeeName: 'X Traders', purpose: 'Oven', amountCents: 10_000, assetClassId: cls['A'], assetLocationId: genB })
    expect(bad.json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
    const v = await approvedAsset({ assetClassId: cls['A'], assetLocationId: genA })
    const r = await call('finA', 'POST', `${V}/${v.id}/pay`, { source: 'bank', bankAccountId: bank['A'] })
    expect(r.statusCode, r.body).toBe(200)
    const paid = (r.json() as { voucher: Row }).voucher
    const line = await prisma.capexLine.findUniqueOrThrow({ where: { id: paid.capexLineId! }, include: { project: true } })
    expect(line.project).toMatchObject({ tenantId: T.A, locationId: genA })
    await applyEvent(paid.capitaliseEventId!, U['ceoA']!.id)
    const asset = await prisma.fixedAsset.findFirstOrThrow({ where: { tenantId: T.A, capexLineId: paid.capexLineId } })
    expect(asset).toMatchObject({ locationId: genA, conceptId: null })
  })

  it('refuses another company\'s class, a cash request, shared with no outlet, pooled, class + account', async () => {
    const base = { kind: 'expense', payeeName: 'X Traders', purpose: 'Oven', amountCents: 10_000 }
    const code = async (who: string, body: Record<string, unknown>) => (await call(who, 'POST', V, body)).json().error?.code
    expect(await code('finA', { ...base, assetClassId: cls['B'], assetLocationId: loc['A'] })).toBe('ASSET_CLASS_NOT_IN_COMPANY')
    expect(await code('finA', { ...base, assetClassId: cls['A'], assetLocationId: loc['B'] })).toBe('LOCATION_NOT_IN_COMPANY')
    expect(await code('finA', { ...base, assetClassId: cls['A'] })).toBe('LOCATION_REQUIRED_FOR_SHARED')
    expect(await code('finA', { ...base, assetClassId: cls['A_small'], assetLocationId: loc['A'] })).toBe('POOLED_CLASS_USE_QUICK_BUY')
    expect(await code('finA', { ...base, assetClassId: cls['A'], assetLocationId: loc['A'], categoryKey: 'repairs' })).toBe('ASSET_OR_EXPENSE')
    expect(await code('cookA', { purpose: 'Oven', amountCents: 10_000, assetClassId: cls['A'], assetLocationId: loc['A'] })).toBe('ASSET_ONLY_ON_PAYEE_VOUCHER')
    expect(await code('finA', { kind: 'request', purpose: 'Oven', amountCents: 10_000, assetClassId: cls['A'], assetLocationId: loc['A'] })).toBe('ASSET_ONLY_ON_PAYEE_VOUCHER')
    // Branded equipment needs no outlet.
    const ok = await call('finA', 'POST', V, { ...base, assetClassId: cls['A'], conceptId: brandA })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json()).toMatchObject({ category: null, assetClassId: cls['A'], assetClassLabel: 'Kitchen equipment' })
    // Removing the brand of a shared item with no outlet is refused.
    expect((await call('finA', 'PATCH', `${V}/${ok.json().id}`, { conceptId: null })).json().error.code).toBe('LOCATION_REQUIRED_FOR_SHARED')
  })
})

describe('finance pays an asset voucher', () => {
  it('bank: ONE entry Dr 1340 / Cr the bank, the capitalisation request; CEO approves → register, 1340 cleared; depreciation runs', async () => {
    const v = await approvedAsset({ assetClassId: cls['A'], assetLocationId: loc['A'], grossCents: 260_000, discountCents: 10_000, amountCents: undefined })
    expect(v.amountCents).toBe(250_000)
    // Company B never sees it.
    expect((await call('finB', 'POST', `${V}/${v.id}/pay`, { source: 'bank', bankAccountId: bank['A'] })).statusCode).toBe(404)
    expect((await call('finB', 'GET', `${V}/${v.id}`)).statusCode).toBe(404)
    const r = await call('finA', 'POST', `${V}/${v.id}/pay`, { source: 'bank', bankAccountId: bank['A'] })
    expect(r.statusCode, r.body).toBe(200)
    const paid = (r.json() as { voucher: Row }).voucher
    expect(paid).toMatchObject({ status: 'disbursed', bookedAtPay: true, paidAccountCode: '1340' })
    expect(paid.capexLineId).toBeTruthy()
    expect(paid.capitaliseEventId).toBeTruthy()
    const pays = await capexPaymentsOf(paid.capexLineId!)
    expect(pays).toHaveLength(1)
    expect(Number(pays[0]!.whtCents)).toBe(0)
    expect(await entryLines(`capex.payment:${pays[0]!.id}`)).toEqual([['1021', 'credit', 250_000], ['1340', 'debit', 250_000]])
    expect(paid.payJournalEntryId).toBe((await prisma.journalEntry.findFirst({ where: { reference: `capex.payment:${pays[0]!.id}` } }))!.id)
    // Nothing else: no expense entry, nothing on 1357.
    expect(await entryLines(`cashvoucher.pay:${v.id}`)).toBeNull()
    const ev = await prisma.fixedAssetEvent.findUniqueOrThrow({ where: { id: paid.capitaliseEventId! } })
    expect(ev).toMatchObject({ kind: 'capitalise', status: 'pending', tenantId: T.A, capexLineId: paid.capexLineId })
    const line = await prisma.capexLine.findUniqueOrThrow({ where: { id: paid.capexLineId! }, include: { project: true } })
    expect(line.project).toMatchObject({ tenantId: T.A, locationId: loc['A'], isStanding: true })

    // Paying again: 409.
    expect((await call('finA', 'POST', `${V}/${v.id}/pay`, { source: 'bank', bankAccountId: bank['A'] })).json().error.code).toBe('ALREADY_PAID')

    // Documents check books nothing.
    const before = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const d = await call('finA', 'POST', `${V}/${v.id}/documents`, { fileName: 'invoice.pdf', mime: 'application/pdf', dataBase64: PDF.toString('base64') })
    expect(d.statusCode, d.body).toBe(201)
    // finA paid it, so another finance login would check; the route's own rules apply — the CEO may.
    const chk = await call('ceoA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(chk.statusCode, chk.body).toBe(200)
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(before)

    // The CEO approves the capitalisation (in service last completed month, so a month can be charged).
    const period = lastCompletedPeriodPkt()
    await prisma.fixedAssetEvent.update({
      where: { id: ev.id },
      data: { payload: { ...(ev.payload as Record<string, unknown>), inServiceAt: `${period}-01` } },
    })
    await applyEvent(ev.id, U['ceoA']!.id)
    const asset = await prisma.fixedAsset.findFirstOrThrow({ where: { tenantId: T.A, capexLineId: paid.capexLineId } })
    expect(Number(asset.costCents)).toBe(250_000)
    expect(asset).toMatchObject({ category: 'kitchen_equipment', locationId: loc['A'], conceptId: null })
    const adv = await prisma.journalLine.findMany({ where: { account: { tenantId: T.A, code: '1340' }, journalEntry: { tenantId: T.A } } })
    expect(adv.reduce((t, l) => t + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0)).toBe(0)

    const run = await chargeThrough(T.A, period, { postedBy: U['ceoA']!.id, assetIds: [asset.id] })
    expect(run.chargedCents ?? 0).toBeGreaterThan(0)
  })

  it('box: Dr 1340 / Cr 1011 through the spend path, the float drops; branded with no outlet', async () => {
    const v = await approvedAsset({ assetClassId: cls['A'], conceptId: brandA }, 40_000)
    const f0 = await floatOf(box['A']!)
    const r = await call('finA', 'POST', `${V}/${v.id}/pay`, { source: 'box', boxId: box['A'] })
    expect(r.statusCode, r.body).toBe(200)
    const paid = (r.json() as { voucher: Row }).voucher
    expect(await floatOf(box['A']!)).toBe(f0 - 40_000)
    const pays = await capexPaymentsOf(paid.capexLineId!)
    expect(pays).toHaveLength(1)
    expect(pays[0]!.source).toBe('cash')
    expect(await entryLines(`capex.payment:${pays[0]!.id}`)).toEqual([['1011', 'credit', 40_000], ['1340', 'debit', 40_000]])
    // The movement posts no entry of its own (its line is the capex payment's).
    expect(await entryLines(`pettycash.spend:${paid.pettyCashMovementId}`)).toBeNull()
    const ev = await prisma.fixedAssetEvent.findUniqueOrThrow({ where: { id: paid.capitaliseEventId! } })
    expect((ev.payload as { conceptId?: string }).conceptId).toBe(brandA)
    // Rejected by the CEO: the cost stays on 1340 as an advance (as a rejected Quick buy does).
    await rejectEvent(ev.id, U['ceoA']!.id, 'Not equipment we keep')
    expect(await prisma.fixedAsset.count({ where: { capexLineId: paid.capexLineId } })).toBe(0)
    expect(await entryLines(`capex.payment:${pays[0]!.id}`)).toEqual([['1011', 'credit', 40_000], ['1340', 'debit', 40_000]])
  })

  it('a voucher returned or rejected before pay books nothing', async () => {
    const r = await call('finA', 'POST', V, { kind: 'expense', payeeName: 'Y', purpose: 'Fryer', amountCents: 9_000, assetClassId: cls['A'], assetLocationId: loc['A'] })
    const v = r.json() as Row
    const n0 = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    expect((await call('ceoA', 'POST', `${V}/${v.id}/reject`, { note: 'Not now please' })).statusCode).toBe(200)
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(n0)
    expect(await prisma.capexLine.count({ where: { notes: { contains: v.number } } })).toBe(0)
  })
})
