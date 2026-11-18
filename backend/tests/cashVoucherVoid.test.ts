// Void a PAID cash voucher (owner, 2026-11-18): finance asks, the CEO approves; cash back / the pay reversed.
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

const P = `cvvd${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const box: Record<string, string> = {}
const bank: Record<string, string> = {}
const loc: Record<string, string> = {}
const cls: Record<string, string> = {}
let brandA = ''
const sup: Record<string, string> = {}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n')

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@cvvd.pk`, password: await bcrypt.hash('x-Password-1', 4),
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
  sup['A'] = (await prisma.supplier.create({ data: { name: 'Cool Tech Traders', tenantId: T.A, paymentTermsDays: 30, filerStatus: 'filer' } })).id
  sup['B'] = (await prisma.supplier.create({ data: { name: 'B Traders', tenantId: T.B, paymentTermsDays: 30, filerStatus: 'filer' } })).id
  cls['A_small'] = (await prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId: T.A, key: 'smallwares' } })).id
}, 120_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})


async function raise(body: Record<string, unknown>): Promise<Row & Record<string, unknown>> {
  const r = await call('finA', 'POST', V, { kind: 'expense', payeeName: 'Fast Couriers', purpose: `Courier charges ${Math.random().toString(36).slice(2, 7)}`, categoryKey: 'transport', amountCents: 30_000, ...body })
  expect(r.statusCode, r.body).toBe(201)
  return r.json()
}
async function approve(id: string): Promise<void> {
  const a = await call('ceoA', 'POST', `${V}/${id}/approve`, {})
  expect(a.statusCode, a.body).toBe(200)
}
const voucherEntries = async (id: string) =>
  prisma.journalEntry.count({ where: { tenantId: T.A, reference: { startsWith: 'cashvoucher.' }, AND: { reference: { contains: id } } } })


const detail = async (who: string, id: string) => { const b = (await call(who, 'GET', `${V}/${id}`)).json(); return b.voucher ?? b }
async function paidVoucher(pay: Record<string, unknown>, raiseBody: Record<string, unknown> = {}) {
  const v = await raise(raiseBody)
  await approve(v.id)
  const r = await call('finA', 'POST', `${V}/${v.id}/pay`, pay)
  expect(r.statusCode, r.body).toBe(200)
  return v
}

describe('void a paid cash voucher (owner, 2026-11-18)', () => {
  it('box: finance asks (nothing moves) → the CEO approves → cash back in the box, expense undone, voided', async () => {
    const f0 = await floatOf(box['A']!)
    const v = await paidVoucher({ source: 'box', boxId: box['A'] }, { conceptId: brandA })
    expect(await floatOf(box['A']!)).toBe(f0 - 30_000)
    const d0 = await detail('finA', v.id)
    expect(d0.canRequestVoid).toBe(true)
    // Too short a reason; someone without finance rights.
    expect((await call('finA', 'POST', `${V}/${v.id}/void`, { reason: 'short' })).statusCode).toBe(400)
    expect((await call('cookA', 'POST', `${V}/${v.id}/void`, { reason: 'Paid twice by mistake' })).statusCode).toBeGreaterThanOrEqual(403)
    // Company B never reaches it.
    expect((await call('finB', 'POST', `${V}/${v.id}/void`, { reason: 'Paid twice by mistake' })).statusCode).toBe(404)
    const ask = await call('finA', 'POST', `${V}/${v.id}/void`, { reason: 'Paid twice by mistake' })
    expect(ask.statusCode, ask.body).toBe(202)
    const reqId = ask.json().request.id as string
    expect((await call('finA', 'POST', `${V}/${v.id}/void`, { reason: 'Paid twice by mistake' })).json().error.code).toBe('VOID_PENDING')
    expect(await floatOf(box['A']!)).toBe(f0 - 30_000)
    expect((await detail('finA', v.id)).voidRequest).toMatchObject({ id: reqId, canWithdraw: true, canDecide: false })
    // The CEO's list; B's finance sees nothing; finance cannot approve.
    const list = await call('ceoA', 'GET', `${V}/void-requests?status=pending`)
    expect(list.json().items.map((i: { id: string }) => i.id)).toContain(reqId)
    expect((await call('finB', 'GET', `${V}/void-requests?status=pending`)).json().items.map((i: { id: string }) => i.id)).not.toContain(reqId)
    expect((await call('finA', 'POST', `${V}/void-requests/${reqId}/approve`, {})).statusCode).toBe(403)
    const ok = await call('ceoA', 'POST', `${V}/void-requests/${reqId}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await floatOf(box['A']!)).toBe(f0)
    const row = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })
    expect(row).toMatchObject({ status: 'voided', voidedById: U['ceoA']!.id, voidReason: 'Paid twice by mistake' })
    const back = await prisma.journalEntry.findUniqueOrThrow({ where: { id: row.voidEntryId! }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(back.tenantId).toBe(T.A)
    expect(back.lines.map((l) => [l.account.code, l.type, Number(l.amountCents), l.conceptId]).sort())
      .toEqual([['1011', 'debit', 30_000, brandA], ['6140', 'credit', 30_000, brandA]])
    // Twice: refused; a voided spend line cannot be moved.
    expect((await call('ceoA', 'POST', `${V}/void-requests/${reqId}/approve`, {})).json().error.code).toBe('REQUEST_NOT_PENDING')
    expect((await call('ceoA', 'POST', `${V}/${v.id}/void`, { reason: 'Again, just to be sure' })).json().error.code).toBe('ALREADY_VOIDED')
    const mv = await prisma.pettyCashMovement.findUniqueOrThrow({ where: { id: row.pettyCashMovementId! }, include: { lines: true } })
    const re = await call('finA', 'PATCH', `/trustops/petty-cash/movements/${mv.id}/lines/${mv.lines[0]!.id}`, { categoryKey: 'repairs' })
    expect(re.json().error?.code).toBe('VOUCHER_VOIDED')
    expect((await detail('finA', v.id)).stage).toBe('voided')
  })

  it('cash on hand: the CEO voids at once — the pay entry is reversed', async () => {
    const v = await paidVoucher({ source: 'cash_on_hand' })
    const r = await call('ceoA', 'POST', `${V}/${v.id}/void`, { reason: 'Vendor refunded the cash' })
    expect(r.statusCode, r.body).toBe(200)
    expect(await entryLines(`cashvoucher.pay.reversal:${v.id}`)).toEqual([['1010', 'debit', 30_000], ['6140', 'credit', 30_000]])
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('voided')
  })

  it('bank: reject keeps it; withdraw by the asker; then approved → reversed', async () => {
    const v = await paidVoucher({ source: 'bank', bankAccountId: bank['A'] })
    const a1 = (await call('finA', 'POST', `${V}/${v.id}/void`, { reason: 'Wrong payee entirely' })).json().request.id
    expect((await call('ceoA', 'POST', `${V}/void-requests/${a1}/reject`, { note: 'no' })).statusCode).toBe(400)
    expect((await call('ceoA', 'POST', `${V}/void-requests/${a1}/reject`, { note: 'Payee was right, keep it' })).statusCode).toBe(200)
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).status).not.toBe('voided')
    const a2 = (await call('finA', 'POST', `${V}/${v.id}/void`, { reason: 'Wrong payee entirely' })).json().request.id
    expect((await call('finA', 'POST', `${V}/void-requests/${a2}/withdraw`, {})).statusCode).toBe(200)
    const a3 = (await call('finA', 'POST', `${V}/${v.id}/void`, { reason: 'Wrong payee entirely' })).json().request.id
    expect((await call('ceoA', 'POST', `${V}/void-requests/${a3}/approve`, {})).statusCode).toBe(200)
    expect(await entryLines(`cashvoucher.pay.reversal:${v.id}`)).toEqual([['1021', 'debit', 30_000], ['6140', 'credit', 30_000]])
  })

  it('refused: not paid yet, and on credit (its supplier bill is voided instead)', async () => {
    const v = await raise({})
    expect((await call('ceoA', 'POST', `${V}/${v.id}/void`, { reason: 'Not paid yet at all' })).json().error.code).toBe('VOUCHER_NOT_PAID')
    const c = await paidVoucher({}, { payFrom: 'credit', supplierId: sup['A'] })
    const d = await detail('finA', c.id)
    expect(d.canRequestVoid).toBe(false)
    expect(d.voidBlockedReason).toContain('supplier bill')
    expect((await call('finA', 'POST', `${V}/${c.id}/void`, { reason: 'Booked on credit by mistake' })).json().error.code).toBe('VOID_USE_SUPPLIER_BILL')
  })
})
