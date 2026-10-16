// Cash vouchers paid from cash on hand or a bank account (owner, 2026-10-16:
// "Give the option box to pay from petty cash/Cash on hand and bank accounts").
//
//   - GET /:id/pay-sources: finance sees every open box of the voucher's
//     company, cash on hand and its live linked banks; a cashier only their
//     own boxes; company B gets 404.
//   - Pay from cash on hand: ONE entry 'cashvoucher.pay:<id>' Dr 1357 /
//     Cr 1010 in the VOUCHER's company, no box movement, no float change.
//   - Pay from a bank: Cr that bank's code; two banks and none named → 422
//     BANK_ACCOUNT_REQUIRED; company B's bank → 422; a non-finance login →
//     403 PAY_SOURCE_FINANCE_ONLY; company B's finance → 404.
//   - Box path unchanged (Dr 1357 / Cr 1011, paySource 'box'); paying twice →
//     409 ALREADY_PAID; a closed period rolls the whole pay back.
//   - Verify: change goes back to the same account (Dr source / Cr 1357), an
//     overspend is paid from it (Dr 1357 / Cr source); a box id is refused;
//     1357 nets to zero per voucher; the tie-out counts these vouchers.
//
// Real route handlers through Fastify inject; needs the disposable test DB.
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
import { pettyCashTieOut } from '../src/modules/accounting/pettyCashPosting.js'

const P = `cvps${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const box: Record<string, string> = {}
const bank: Record<string, string> = {}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n')

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@cvps.pk`, password: await bcrypt.hash('x-Password-1', 4),
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
  id: string; number: string; status: string; amountCents: number; paySource: string; payAccountCode: string | null
  payBankAccountId: string | null; payJournalEntryId: string | null; pettyCashMovementId: string | null; boxId: string | null
  paidFrom: string | null; paidAccountCode?: string | null; returnedCents: number; settledCents: number
}

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
async function pay(key: string, id: string, body: Record<string, unknown>) {
  return call(key, 'POST', `${V}/${id}/pay`, body)
}
/** The holder confirms receipt and attaches one supporting document. */
async function readyToVerify(id: string) {
  await ok('cookA', 'POST', `${V}/${id}/confirm-received`)
  const d = await call('cookA', 'POST', `${V}/${id}/documents`, { fileName: 'bill.pdf', mime: 'application/pdf', dataBase64: PDF.toString('base64') })
  expect(d.statusCode, d.body).toBe(201)
}
async function entry(reference: string, tenantId = T.A) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je ? je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort() : null
}
/** Σ debit − credit on 1357 over every entry of the voucher (pay, change, overspend, verification). */
async function held1357(voucherId: string, tenantId = T.A): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: {
      account: { code: '1357', tenantId },
      journalEntry: { tenantId, reference: { in: ['pay', 'change', 'overspend', 'post'].map((k) => `cashvoucher.${k}:${voucherId}`) } },
    },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0)
}
const floatOf = async (id: string) => (await prisma.pettyCashBox.findUniqueOrThrow({ where: { id } })).floatCents

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Pay Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Pay Co B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await ensureChartOfAccounts(T.B)
  invalidateSetupCache()
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('finB', 'finance', [T.B])
  await mkUser('mgrA', 'management', [T.A])
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

  // Boxes start empty and are funded through the ledger, so the tie-out holds.
  box['A'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Head office box', custodianId: U['cashA']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  box['A2'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Finance box', custodianId: U['finA']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  box['B'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.B, name: 'B box', custodianId: U['finB']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  for (const [b, who] of [['A', 'finA'], ['A2', 'finA'], ['B', 'finB']] as const) {
    const r = await call(who, 'POST', '/trustops/petty-cash/movements', { boxId: box[b], type: 'topup', amountCents: 500_000, reason: 'Float from Garibsons', source: 'garibsons' })
    expect(r.statusCode, r.body).toBe(201)
  }
  // Two live linked banks in A (1021, 1022), one in B (1021 of B's own chart).
  for (const [key, tenantId, code, name] of [['A1', T.A, '1021', 'HBL Operations'], ['A2', T.A, '1022', 'Meezan Payroll'], ['B1', T.B, '1021', 'B Bank']] as const) {
    if (!(await prisma.account.findFirst({ where: { tenantId, code } }))) {
      await prisma.account.create({ data: { tenantId, code, name: `Bank — ${name}`, type: 'asset', isActive: true } })
    }
    bank[key] = (await prisma.bankAccount.create({ data: { tenantId, name, bankName: name.split(' ')[0], accountCode: code, isActive: true } })).id
  }
}, 120_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

describe('pay sources', () => {
  it('lists boxes, cash on hand and banks of the voucher\'s company only', async () => {
    const v = await approved()
    const fin = (await call('finA', 'GET', `${V}/${v.id}/pay-sources`)).json() as { boxes: Array<{ id: string }>; cashOnHand: boolean; banks: Array<{ id: string }> }
    expect(fin.boxes.map((b) => b.id).sort()).toEqual([box['A'], box['A2']].sort())
    expect(fin.cashOnHand).toBe(true)
    expect(fin.banks.map((b) => b.id).sort()).toEqual([bank['A1'], bank['A2']].sort())
    const cash = (await call('cashA', 'GET', `${V}/${v.id}/pay-sources`)).json() as typeof fin
    expect(cash.boxes.map((b) => b.id)).toEqual([box['A']])
    expect(cash.cashOnHand).toBe(false)
    expect(cash.banks).toEqual([])
    expect((await call('finB', 'GET', `${V}/${v.id}/pay-sources`)).statusCode).toBe(404)
    expect((await call('cookA', 'GET', `${V}/${v.id}`)).json().canPay).toBe(false)
    expect((await call('finA', 'GET', `${V}/${v.id}`)).json().canPay).toBe(true)
  })
})

describe('pay from cash on hand / a bank', () => {
  it('cash on hand: Dr 1357 / Cr 1010 in the voucher\'s company, no box, once', async () => {
    const v = await approved(12_000)
    const floats = [await floatOf(box['A']!), await floatOf(box['A2']!)]
    // Not finance / not the CEO: refused, nothing moves.
    for (const who of ['cashA', 'mgrA', 'cookA']) {
      const r = await pay(who, v.id, { source: 'cash_on_hand' })
      expect(r.statusCode, `${who} ${r.body}`).toBe(403)
      expect(r.json().error.code).toBe('PAY_SOURCE_FINANCE_ONLY')
    }
    expect((await pay('finB', v.id, { source: 'cash_on_hand' })).statusCode).toBe(404)
    expect((await pay('finA', v.id, { source: 'cash_on_hand', boxId: box['A'] })).json().error.code).toBe('BOX_NOT_FOR_SOURCE')
    expect((await pay('finA', v.id, { source: 'cash_on_hand', bankAccountId: bank['A1'] })).json().error.code).toBe('BANK_ACCOUNT_ON_CASH')

    const r = await pay('finA', v.id, { source: 'cash_on_hand' })
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json() as { voucher: Row; movement: unknown; journalEntryId: string }
    expect(body.movement).toBeNull()
    expect(body.voucher).toMatchObject({
      status: 'disbursed', paySource: 'cash_on_hand', payAccountCode: '1010', payBankAccountId: null, boxId: null,
      pettyCashMovementId: null, payJournalEntryId: body.journalEntryId, paidFrom: 'Cash on hand', paidAccountCode: '1357',
    })
    expect(await entry(`cashvoucher.pay:${v.id}`)).toEqual([['1010', 'credit', 12_000], ['1357', 'debit', 12_000]])
    expect(await entry(`cashvoucher.pay:${v.id}`, T.B)).toBeNull()
    expect([await floatOf(box['A']!), await floatOf(box['A2']!)]).toEqual(floats)
    expect(await prisma.pettyCashMovement.count({ where: { cashVoucherId: v.id } })).toBe(0)

    // Twice: 409, still one entry.
    const again = await pay('finA', v.id, { source: 'cash_on_hand' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('ALREADY_PAID')
    expect(await prisma.journalEntry.count({ where: { reference: `cashvoucher.pay:${v.id}` } })).toBe(1)

    // The export says where it came from.
    const x = await call('finA', 'GET', `${V}/${v.id}/export.xlsx`)
    expect(x.statusCode, x.body.slice(0, 200)).toBe(200)
  })

  it('bank: the named bank of the voucher\'s company; ambiguous or foreign banks are 422', async () => {
    const v = await approved(9_000)
    const amb = await pay('finA', v.id, { source: 'bank' })
    expect(amb.statusCode).toBe(422)
    expect(amb.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    const foreign = await pay('finA', v.id, { source: 'bank', bankAccountId: bank['B1'] })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect((await call('finA', 'GET', `${V}/${v.id}`)).json().status).toBe('approved')
    expect(await entry(`cashvoucher.pay:${v.id}`)).toBeNull()

    // The CEO may pay from a bank too.
    const r = await pay('ceoA', v.id, { source: 'bank', bankAccountId: bank['A2'] })
    expect(r.statusCode, r.body).toBe(200)
    expect((r.json() as { voucher: Row }).voucher).toMatchObject({ paySource: 'bank', payAccountCode: '1022', payBankAccountId: bank['A2'], paidFrom: 'Meezan Payroll' })
    expect(await entry(`cashvoucher.pay:${v.id}`)).toEqual([['1022', 'credit', 9_000], ['1357', 'debit', 9_000]])
  })

  it('box path unchanged: Dr 1357 / Cr 1011 through the box; a keeper may pick any open box', async () => {
    const v = await approved(5_000)
    expect((await pay('cashA', v.id, { source: 'box', bankAccountId: bank['A1'] })).json().error.code).toBe('BANK_NOT_FOR_SOURCE')
    // The cashier cannot pay from the finance box; finance may pay from the cashier's box.
    expect((await pay('cashA', v.id, { boxId: box['A2'] })).statusCode).toBe(403)
    const start = await floatOf(box['A']!)
    const r = await pay('finA', v.id, { boxId: box['A'] })
    expect(r.statusCode, r.body).toBe(200)
    const b = r.json() as { voucher: Row; movement: { id: string; journalEntryId: string } }
    expect(b.voucher).toMatchObject({ paySource: 'box', payAccountCode: null, payJournalEntryId: null, boxId: box['A'], paidFrom: 'Head office box' })
    expect(await floatOf(box['A']!)).toBe(start - 5_000)
    const je = await prisma.journalEntry.findUniqueOrThrow({ where: { id: b.movement.journalEntryId }, include: { lines: { include: { account: true } } } })
    expect(je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1011', 'credit', 5_000], ['1357', 'debit', 5_000]])
    expect(await entry(`cashvoucher.pay:${v.id}`)).toBeNull()
  })

  it('a closed period rolls the whole pay back', async () => {
    const v = await approved(4_000)
    const lock = await prisma.periodLock.create({ data: { tenantId: T.A, lockedThrough: new Date(Date.now() + 86_400_000), lockedBy: 'test' } })
    try {
      const r = await pay('finA', v.id, { source: 'cash_on_hand' })
      expect(r.statusCode, r.body).toBe(422)
      expect(r.json().error.code).toBe('PERIOD_LOCKED')
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
    const after = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })
    expect(after).toMatchObject({ status: 'approved', paySource: 'box', payAccountCode: null, payJournalEntryId: null, disbursedAt: null })
    expect(await entry(`cashvoucher.pay:${v.id}`)).toBeNull()
  })
})

describe('verification of a cash-on-hand / bank voucher', () => {
  it('change goes back to cash on hand: Dr 1010 / Cr 1357; 1357 nets to zero', async () => {
    const v = await approved(10_000)
    expect((await pay('finA', v.id, { source: 'cash_on_hand' })).statusCode).toBe(200)
    await readyToVerify(v.id)
    const lines = [{ categoryKey: 'transport', amountCents: 6_000, description: 'Taxi' }]
    const boxed = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, { lines, changeBoxId: box['A'] })
    expect(boxed.statusCode).toBe(422)
    expect(boxed.json().error.code).toBe('PAY_SOURCE_NOT_BOX')
    const floats = [await floatOf(box['A']!), await floatOf(box['A2']!)]
    const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, { lines, changeCents: 4_000 })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ spentCents: 6_000, changeCents: 4_000, topUpCents: 0 })
    expect(r.json().voucher).toMatchObject({ status: 'posted', settledCents: 6_000, returnedCents: 4_000 })
    expect(await entry(`cashvoucher.change:${v.id}`)).toEqual([['1010', 'debit', 4_000], ['1357', 'credit', 4_000]])
    const post = await entry(`cashvoucher.post:${v.id}`)
    expect(post!.find((l) => l[0] === '1357')).toEqual(['1357', 'credit', 6_000])
    expect(post!.some((l) => l[0] === '1011')).toBe(false)
    expect(await held1357(v.id)).toBe(0)
    expect([await floatOf(box['A']!), await floatOf(box['A2']!)]).toEqual(floats)
    expect((await call('finA', 'POST', `${V}/${v.id}/verify-docs`, { lines })).json().error.code).toBe('ALREADY_POSTED')
  })

  it('an overspend is paid from the same bank: Dr 1357 / Cr the bank; 1357 nets to zero', async () => {
    const v = await approved(10_000)
    expect((await pay('finA', v.id, { source: 'bank', bankAccountId: bank['A1'] })).statusCode).toBe(200)
    await readyToVerify(v.id)
    const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {
      lines: [{ categoryKey: 'transport', amountCents: 9_000, description: 'Taxi' }, { categoryKey: 'office', amountCents: 4_000, description: 'Paper' }],
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ spentCents: 13_000, changeCents: 0, topUpCents: 3_000 })
    expect(await entry(`cashvoucher.overspend:${v.id}`)).toEqual([['1021', 'credit', 3_000], ['1357', 'debit', 3_000]])
    const post = await entry(`cashvoucher.post:${v.id}`)
    expect(post!.find((l) => l[0] === '1357')).toEqual(['1357', 'credit', 13_000])
    expect(await held1357(v.id)).toBe(0)
  })

  it('exact spend posts no change / overspend entry', async () => {
    const v = await approved(7_000)
    expect((await pay('finA', v.id, { source: 'cash_on_hand' })).statusCode).toBe(200)
    await readyToVerify(v.id)
    const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(await entry(`cashvoucher.change:${v.id}`)).toBeNull()
    expect(await entry(`cashvoucher.overspend:${v.id}`)).toBeNull()
    expect(await held1357(v.id)).toBe(0)
  })

  it('the tie-out counts vouchers paid from cash on hand / a bank against 1357', async () => {
    const [row] = await pettyCashTieOut([T.A])
    expect(row!.heldVouchersCents).toBe(row!.ledger1357Cents)
    expect(row!.heldVouchersCents).toBeGreaterThan(0) // the cash-on-hand, bank and box vouchers above are still awaiting documents
  })
})
