// Finance final (owner, 2026-10-16) — cash group, vouchers and petty cash:
//
//   #6  A cash voucher's pay books what it read: a category / brand / holder /
//       amount edit committed between the pay's read and its claim makes the
//       claim miss → 409 VOUCHER_CHANGED, nothing posted, nothing paid.
//   #20 Finance (not the raiser / holder) or the CEO records "cash received"
//       on the holder's behalf with a reason (POST /:id/confirm-received-on-
//       behalf) so the documents check is not blocked for good; audited
//       'confirm_received' via 'finance_on_behalf'; company B 404.
//   #33 Only an UPLOADED receipt (receiptIds) satisfies the petty-cash photo
//       rule; a typed receiptUrl never does.
//   #34 The Cash requests sidebar hint describes today's flow (no HOD).
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { UserRole } from '@prisma/client'

// #6: run a concurrent edit exactly between the pay's read of the voucher and its claim.
const hooks = vi.hoisted(() => ({ afterResolve: null as null | (() => Promise<void>) }))
vi.mock('../src/modules/accounting/expenseCategories.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/modules/accounting/expenseCategories.js')>()
  return {
    ...m,
    resolveSpendAccount: async (...args: Parameters<typeof m.resolveSpendAccount>) => {
      const r = await m.resolveSpendAccount(...args)
      const f = hooks.afterResolve
      if (f) { hooks.afterResolve = null; await f() }
      return r
    },
  }
})

import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'

const P = `cvfx${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const box: Record<string, string> = {}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n')
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]).toString('base64')

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@cvfx.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const call = (key: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }, ...(payload !== undefined && { payload: payload as object }) })
const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
const V = '/trustops/cash-vouchers'
type Row = { id: string; number: string; status: string; category: string | null; cashReceivedAt: string | null; canConfirmReceivedOnBehalf?: boolean; canVerify?: boolean }

async function ok(key: string, method: 'POST' | 'PATCH' | 'GET', url: string, body?: unknown): Promise<Row> {
  const r = await call(key, method, url, method === 'GET' ? undefined : (body ?? {}))
  expect(r.statusCode, `${key} ${url} ${r.body}`).toBe(200)
  return r.json() as Row
}
/** cookA raises, finA approves, ceoA gives the final approval. */
async function approved(amountCents = 10_000): Promise<Row> {
  const r = await call('cookA', 'POST', V, { purpose: `Market run ${Math.random().toString(36).slice(2, 7)}`, categoryKey: 'transport', amountCents })
  expect(r.statusCode, r.body).toBe(201)
  const v = r.json() as Row
  await ok('finA', 'POST', `${V}/${v.id}/finance-approve`)
  return ok('ceoA', 'POST', `${V}/${v.id}/approve`)
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Voucher Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Voucher Co B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await ensureChartOfAccounts(T.B)
  invalidateSetupCache()
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('finA2', 'finance', [T.A])
  await mkUser('finB', 'finance', [T.B])
  await mkUser('cashA', 'cashier', [T.A])
  await mkUser('cookA', 'boh', [T.A])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => { await api.register(trustopsRoutes, { prefix: '/trustops' }) }, { prefix: '/api/v1' })
  await app.ready()

  box['A'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Head office box', custodianId: U['cashA']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  const r = await call('finA', 'POST', '/trustops/petty-cash/movements', { boxId: box['A'], type: 'topup', amountCents: 500_000, reason: 'Float from Garibsons', source: 'garibsons' })
  expect(r.statusCode, r.body).toBe(201)
}, 120_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

describe('#6 a concurrent edit between the pay\'s read and its claim', () => {
  it('a category changed mid-pay → 409 VOUCHER_CHANGED; nothing posted; paying again books the NEW account', async () => {
    const v = await approved()
    hooks.afterResolve = async () => {
      const e = await call('finA2', 'PATCH', `${V}/${v.id}`, { categoryKey: 'repairs' })
      expect(e.statusCode, e.body).toBe(200)
    }
    const r = await call('finA', 'POST', `${V}/${v.id}/pay`, { source: 'box', boxId: box['A'] })
    expect(hooks.afterResolve).toBeNull()
    expect(r.statusCode, r.body).toBe(409)
    expect(code(r)).toBe('VOUCHER_CHANGED')
    const row = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })
    expect(row.status).toBe('approved')
    expect(await prisma.pettyCashMovement.count({ where: { cashVoucherId: v.id } })).toBe(0)

    const again = await call('finA', 'POST', `${V}/${v.id}/pay`, { source: 'box', boxId: box['A'] })
    expect(again.statusCode, again.body).toBe(200)
    const je = await prisma.journalEntry.findUniqueOrThrow({ where: { id: again.json().journalEntryId }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(je.tenantId).toBe(T.A)
    expect(je.lines.find((l) => l.type === 'debit')!.account.code).toBe('6050') // repairs, not transport (6140)
  })
})

describe('#20 finance records cash received on the holder\'s behalf', () => {
  it('reason, separation, company B 404, conditional, audited; then the documents can be checked', async () => {
    const v = await approved()
    expect((await call('finA', 'POST', `${V}/${v.id}/pay`, { source: 'box', boxId: box['A'] })).statusCode).toBe(200)
    const d = await call('cookA', 'POST', `${V}/${v.id}/documents`, { fileName: 'bill.pdf', mime: 'application/pdf', dataBase64: PDF.toString('base64') })
    expect(d.statusCode, d.body).toBe(201)
    // The upload by the raiser confirms receipt — undo that to model a holder who never confirmed (left).
    await prisma.cashVoucher.update({ where: { id: v.id }, data: { cashReceivedAt: null, cashReceivedById: null } })
    expect(code(await call('finA2', 'POST', `${V}/${v.id}/verify-docs`, {}))).toBe('CASH_RECEIPT_NOT_CONFIRMED')

    const url = `${V}/${v.id}/confirm-received-on-behalf`
    expect((await call('finB', 'POST', url, { reason: 'Holder has left the company' })).statusCode).toBe(404)
    expect((await call('cashA', 'POST', url, { reason: 'Holder has left the company' })).statusCode).toBe(403)
    expect(code(await call('cookA', 'POST', url, { reason: 'Holder has left the company' }))).toBe('NOT_FINANCE')
    expect((await call('finA', 'POST', url, { reason: 'short' })).statusCode).toBe(400)
    // finA paid it: the payer never attests the hand-over for the holder (gate fix).
    expect((await ok('finA', 'GET', `${V}/${v.id}`)).canConfirmReceivedOnBehalf).toBe(false)
    expect(code(await call('finA', 'POST', url, { reason: 'Holder has left the company' }))).toBe('PAYER_CANNOT_CONFIRM')
    const detail = await ok('finA2', 'GET', `${V}/${v.id}`)
    expect(detail.canConfirmReceivedOnBehalf).toBe(true)

    const done = await call('finA2', 'POST', url, { reason: 'Holder has left the company' })
    expect(done.statusCode, done.body).toBe(200)
    const row = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })
    expect(row.cashReceivedById).toBe(U['finA2']!.id)
    expect(row.cashReceivedAt).not.toBeNull()
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: v.id, action: { contains: 'confirm_received' } }, orderBy: { createdAt: 'desc' } })
    expect(JSON.stringify(log.after)).toContain('finance_on_behalf')
    expect(JSON.stringify(log.after)).toContain('Holder has left the company')
    const twice = await call('ceoA', 'POST', url, { reason: 'Holder has left the company' })
    expect(twice.statusCode).toBe(409)
    expect(code(twice)).toBe('ALREADY_CONFIRMED')
    // The documents check now goes through (another finance person).
    expect((await call('finA2', 'POST', `${V}/${v.id}/verify-docs`, {})).statusCode).toBe(200)
  })

  it('the raiser / holder can never record it for themselves', async () => {
    // finA raises a request for themselves: finA is raiser and holder.
    const r = await call('finA', 'POST', V, { purpose: 'Own market run', categoryKey: 'transport', amountCents: 5_000 })
    expect(r.statusCode, r.body).toBe(201)
    const v = r.json() as Row
    await ok('finA2', 'POST', `${V}/${v.id}/finance-approve`)
    await ok('ceoA', 'POST', `${V}/${v.id}/approve`)
    expect((await call('finA2', 'POST', `${V}/${v.id}/pay`, { source: 'box', boxId: box['A'] })).statusCode).toBe(200)
    const own = await call('finA', 'POST', `${V}/${v.id}/confirm-received-on-behalf`, { reason: 'Recording my own receipt' })
    expect(own.statusCode).toBe(409)
    expect(code(own)).toBe('SELF_APPROVE')
    // The CEO may.
    expect((await call('ceoA', 'POST', `${V}/${v.id}/confirm-received-on-behalf`, { reason: 'Confirmed with finance by phone' })).statusCode).toBe(200)
  })
})

describe('#33 only an uploaded receipt clears the photo rule', () => {
  it('a typed receiptUrl is refused above the threshold; an uploaded receipt passes; company B 404', async () => {
    const spend = { boxId: box['A'], type: 'spend', amountCents: 60_000, reason: 'Cleaning supplies', categoryKey: 'cleaning' }
    const url = await call('cashA', 'POST', '/trustops/petty-cash/movements', { ...spend, receiptUrl: 'https://example.com/receipt.jpg' })
    expect(url.statusCode, url.body).toBe(400)
    expect(code(url)).toBe('PHOTO_REQUIRED')
    expect((await call('finB', 'POST', '/trustops/petty-cash/receipts', { boxId: box['A'], photo: JPEG, mime: 'image/jpeg' })).statusCode).toBe(404)
    const rc = await call('cashA', 'POST', '/trustops/petty-cash/receipts', { boxId: box['A'], photo: JPEG, mime: 'image/jpeg' })
    expect(rc.statusCode, rc.body).toBe(201)
    const okSpend = await call('cashA', 'POST', '/trustops/petty-cash/movements', { ...spend, receiptIds: [rc.json().id] })
    expect(okSpend.statusCode, okSpend.body).toBe(201)
    // Below the threshold no photo is needed.
    expect((await call('cashA', 'POST', '/trustops/petty-cash/movements', { ...spend, amountCents: 1_000 })).statusCode).toBe(201)
  })
})

describe('#34 the Cash requests hint', () => {
  it('describes finance → CEO → finance pays once → documents checked; no HOD', () => {
    const file = fileURLToPath(new URL('../../frontend/admin/src/lib/moduleCatalog.ts', import.meta.url))
    const line = readFileSync(file, 'utf8').split('\n').find((l) => l.includes("href: '/finance/cash-vouchers'"))!
    expect(line).toContain('finance approves, then the CEO')
    expect(line).not.toMatch(/HOD/)
  })
})
