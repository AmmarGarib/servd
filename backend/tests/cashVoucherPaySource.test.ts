// Cash vouchers paid from cash on hand or a bank account (owner, 2026-10-16:
// "Give the option box to pay from petty cash/Cash on hand and bank accounts").
//
//   - Only finance pays (owner, 2026-10-16: "Paying a voucher should remain at
//     Finance end"): role finance with the accounting module. A box's
//     cashier, a manager and the CEO get 403 PAY_FINANCE_ONLY on /pay and
//     /pay-sources, from every source.
//   - GET /:id/pay-sources: finance sees every open box of the voucher's
//     company, cash on hand and its live linked banks; company B gets 404.
//   - Pay from cash on hand: ONE entry 'cashvoucher.pay:<id>' Dr the voucher's
//     expense account / Cr 1010 in the VOUCHER's company (owner, 2026-10-16:
//     "It should pass only one entry when booked by finance"), no box
//     movement, no float change, nothing on 1357.
//   - Pay from a bank: Cr that bank's code; two banks and none named → 422
//     BANK_ACCOUNT_REQUIRED; company B's bank → 422; a non-finance login →
//     403 PAY_FINANCE_ONLY; company B's finance → 404.
//   - Box path: Dr the expense / Cr 1011, paySource 'box'; paying twice →
//     409 ALREADY_PAID; a closed period rolls the whole pay back.
//   - Check of a one-entry voucher: posts nothing; change / overspend → 422.
//   - Check of a voucher HELD on 1357 (paid before the one-entry rule, built
//     by holdPayDirect): ONE conversion entry Dr its expense / Cr 1357 (owner,
//     2026-10-16: nothing else posts to 1357 — no change, no overspend); the
//     source account is untouched; the tie-out counts only held vouchers.
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
import { pettyCashTieOut, postCashVoucherSourceTx } from '../src/modules/accounting/pettyCashPosting.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { forwardFinanceRaisedRequests } from '../src/modules/trustops/cashVouchers.js'
import { moneyAccountCode } from '../src/lib/bankAccounts.js'

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
/**
 * A voucher paid from cash on hand / a bank under the HOLD flow (before the
 * one-entry rule): 'cashvoucher.pay:<id>' Dr 1357 / Cr the source, bookedAtPay
 * false — as such rows sit in the books today.
 */
async function holdPayDirect(id: string, source: 'cash_on_hand' | 'bank', bankAccountId: string | null = null) {
  await prisma.$transaction(async (tx) => {
    const v = await tx.cashVoucher.findUniqueOrThrow({ where: { id } })
    const account = await moneyAccountCode(tx, v.tenantId, { method: source === 'cash_on_hand' ? 'cash' : 'bank_transfer', bankAccountId })
    await tx.cashVoucher.update({
      where: { id },
      data: {
        status: 'disbursed', disbursedAt: new Date(), disbursedById: U['finA']!.id, dueBy: new Date(Date.now() + 30 * 86_400_000),
        expenseOnVerify: true, bookedAtPay: false, boxId: null, paySource: source, payAccountCode: account.code, payBankAccountId: account.bankAccountId,
      },
    })
    // Written directly: nothing in the code posts to 1357 any more.
    const posted = await postJournalEntry({
      tenantId: v.tenantId, sourceType: 'cashvoucher.pay', sourceId: id, postedBy: U['finA']!.id,
      description: `Cash voucher ${v.number} paid — documents awaited`,
      lines: [
        { accountCode: '1357', type: 'debit', amountCents: v.amountCents, conceptId: v.conceptId },
        { accountCode: account.code, type: 'credit', amountCents: v.amountCents, conceptId: v.conceptId },
      ],
    }, { tx })
    await tx.cashVoucher.update({ where: { id }, data: { payJournalEntryId: posted.entryId } })
  })
}
async function entry(reference: string, tenantId = T.A) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je ? je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort() : null
}
/** Σ debit − credit on 1357 over every entry of the voucher (pay, change, overspend, verification, conversion). */
async function held1357(voucherId: string, tenantId = T.A): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: {
      account: { code: '1357', tenantId },
      journalEntry: { tenantId, reference: { in: ['pay', 'change', 'overspend', 'post', 'hold_convert'].map((k) => `cashvoucher.${k}:${voucherId}`) } },
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
  await mkUser('finA2', 'finance', [T.A])
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
  await app.register(async (api) => { await api.register(trustopsRoutes, { prefix: '/trustops' }); await api.register(accountingRoutes, { prefix: '/accounting' }) }, { prefix: '/api/v1' })
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

describe('a cash request raised by finance (owner, 2026-10-24)', () => {
  it('goes straight to the CEO — no finance step — and the CEO approves it; a stuck one is forwarded at boot', async () => {
    const r = await call('finA', 'POST', V, { purpose: `Extension board ${Math.random().toString(36).slice(2, 7)}`, categoryKey: 'transport', amountCents: 1_500 })
    expect(r.statusCode, r.body).toBe(201)
    const v = r.json() as Row & { financeApprovedById?: string }
    expect(v.status).toBe('finance_approved')
    expect((await ok('ceoA', 'POST', `${V}/${v.id}/approve`)).status).toBe('approved')
    // One left waiting for finance (raised before this rule): the boot step sends it to the CEO.
    const old = await call('finA', 'POST', V, { purpose: `Old request ${Math.random().toString(36).slice(2, 7)}`, categoryKey: 'transport', amountCents: 900, sendTo: 'finance' })
    expect(old.json().status).toBe('submitted')
    expect(await forwardFinanceRaisedRequests()).toBeGreaterThanOrEqual(1)
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: old.json().id } })).status).toBe('finance_approved')
    // Someone else's request still waits for finance.
    const cook = await call('cookA', 'POST', V, { purpose: `Cook ${Math.random().toString(36).slice(2, 7)}`, categoryKey: 'transport', amountCents: 700 })
    expect(cook.json().status).toBe('submitted')
  })
})

describe('pay sources', () => {
  it('lists boxes, cash on hand and banks of the voucher\'s company only', async () => {
    const v = await approved()
    const fin = (await call('finA', 'GET', `${V}/${v.id}/pay-sources`)).json() as { boxes: Array<{ id: string }>; cashOnHand: boolean; banks: Array<{ id: string }> }
    expect(fin.boxes.map((b) => b.id).sort()).toEqual([box['A'], box['A2']].sort())
    expect(fin.cashOnHand).toBe(true)
    expect(fin.banks.map((b) => b.id).sort()).toEqual([bank['A1'], bank['A2']].sort())
    // Nobody but finance gets the pay sources — not the box's cashier, a manager or the CEO.
    for (const who of ['cashA', 'mgrA', 'ceoA']) {
      const r = await call(who, 'GET', `${V}/${v.id}/pay-sources`)
      expect(r.statusCode, who).toBe(403)
      expect(r.json().error.code, who).toBe('PAY_FINANCE_ONLY')
    }
    expect((await call('finB', 'GET', `${V}/${v.id}/pay-sources`)).statusCode).toBe(404)
    expect((await call('cookA', 'GET', `${V}/${v.id}`)).json().canPay).toBe(false)
    expect((await call('cashA', 'GET', `${V}/${v.id}`)).json().canPay).toBe(false)
    expect((await call('ceoA', 'GET', `${V}/${v.id}`)).json().canPay).toBe(false)
    expect((await call('finA', 'GET', `${V}/${v.id}`)).json().canPay).toBe(true)
  })
})

describe('pay from cash on hand / a bank', () => {
  it('cash on hand: ONE entry Dr the expense / Cr 1010 in the voucher\'s company, no box, nothing on 1357, once', async () => {
    const v = await approved(12_000)
    const floats = [await floatOf(box['A']!), await floatOf(box['A2']!)]
    // Not finance (the CEO included): refused, nothing moves.
    for (const who of ['cashA', 'mgrA', 'cookA', 'ceoA']) {
      const r = await pay(who, v.id, { source: 'cash_on_hand' })
      expect(r.statusCode, `${who} ${r.body}`).toBe(403)
      expect(r.json().error.code).toBe('PAY_FINANCE_ONLY')
    }
    expect(await entry(`cashvoucher.pay:${v.id}`)).toBeNull()
    expect((await pay('finB', v.id, { source: 'cash_on_hand' })).statusCode).toBe(404)
    expect((await pay('finA', v.id, { source: 'cash_on_hand', boxId: box['A'] })).json().error.code).toBe('BOX_NOT_FOR_SOURCE')
    expect((await pay('finA', v.id, { source: 'cash_on_hand', bankAccountId: bank['A1'] })).json().error.code).toBe('BANK_ACCOUNT_ON_CASH')

    const r = await pay('finA', v.id, { source: 'cash_on_hand' })
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json() as { voucher: Row; movement: unknown; journalEntryId: string }
    expect(body.movement).toBeNull()
    expect(body.voucher).toMatchObject({
      status: 'disbursed', paySource: 'cash_on_hand', payAccountCode: '1010', payBankAccountId: null, boxId: null,
      pettyCashMovementId: null, payJournalEntryId: body.journalEntryId, paidFrom: 'Cash on hand', paidAccountCode: '6140', bookedAtPay: true,
    })
    expect(await entry(`cashvoucher.pay:${v.id}`)).toEqual([['1010', 'credit', 12_000], ['6140', 'debit', 12_000]])
    expect(await held1357(v.id)).toBe(0)
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

    // The 1010 statement shows the voucher's own narration as Particulars (owner, 2026-10-24), not the status text.
    const full = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id }, select: { purpose: true, payeeName: true } })
    const cash = await prisma.account.findFirstOrThrow({ where: { tenantId: T.A, code: '1010' } })
    const st = await call('finA', 'GET', `/accounting/ledger?accountId=${cash.id}&view=statement`)
    expect(st.statusCode, st.body).toBe(200)
    const line = (st.json().lines as Array<{ reference: string; particulars: string; description: string }>).find((l) => l.reference === `cashvoucher.pay:${v.id}`)!
    expect(line.description).toContain('paid from cash on hand')
    expect(line.particulars).toBe(full.payeeName && !full.purpose.includes(full.payeeName) ? `${full.purpose} — ${full.payeeName}` : full.purpose)
    const csv = await call('finA', 'GET', `/accounting/ledger?accountId=${cash.id}&view=statement&format=csv`)
    const row = csv.body.split('\r\n').find((r) => r.includes(full.purpose))!
    expect(row.split(',')[1]).not.toMatch(/^"?Cash voucher/)
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

    // The CEO may not pay from a bank (only finance pays); finance pays from the named bank.
    const ceo = await pay('ceoA', v.id, { source: 'bank', bankAccountId: bank['A2'] })
    expect(ceo.statusCode).toBe(403)
    expect(ceo.json().error.code).toBe('PAY_FINANCE_ONLY')
    expect(await entry(`cashvoucher.pay:${v.id}`)).toBeNull()
    const r = await pay('finA', v.id, { source: 'bank', bankAccountId: bank['A2'] })
    expect(r.statusCode, r.body).toBe(200)
    expect((r.json() as { voucher: Row }).voucher).toMatchObject({ paySource: 'bank', payAccountCode: '1022', payBankAccountId: bank['A2'], paidFrom: 'Meezan Payroll' })
    expect(await entry(`cashvoucher.pay:${v.id}`)).toEqual([['1022', 'credit', 9_000], ['6140', 'debit', 9_000]])
  })

  it('box: ONE entry Dr the expense / Cr 1011 through the box, the float drops; finance may pick any open box of the company', async () => {
    const v = await approved(5_000)
    expect((await pay('finA', v.id, { source: 'box', bankAccountId: bank['A1'] })).json().error.code).toBe('BANK_NOT_FOR_SOURCE')
    // The cashier cannot pay, not even from his own box; finance pays from the cashier's box.
    for (const boxId of [box['A'], box['A2']]) {
      const c = await pay('cashA', v.id, { boxId })
      expect(c.statusCode).toBe(403)
      expect(c.json().error.code).toBe('PAY_FINANCE_ONLY')
    }
    const start = await floatOf(box['A']!)
    const r = await pay('finA', v.id, { boxId: box['A'] })
    expect(r.statusCode, r.body).toBe(200)
    const b = r.json() as { voucher: Row; movement: { id: string; journalEntryId: string } }
    expect(b.voucher).toMatchObject({ paySource: 'box', payAccountCode: null, payJournalEntryId: null, boxId: box['A'], paidFrom: 'Head office box' })
    expect(await floatOf(box['A']!)).toBe(start - 5_000)
    const je = await prisma.journalEntry.findUniqueOrThrow({ where: { id: b.movement.journalEntryId }, include: { lines: { include: { account: true } } } })
    expect(je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1011', 'credit', 5_000], ['6140', 'debit', 5_000]])
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
  it('held on 1357 (paid before the one-entry rule) from cash on hand: the check books ONE conversion entry Dr expense / Cr 1357; no change entry; 1357 nets to zero', async () => {
    const v = await approved(10_000)
    await holdPayDirect(v.id, 'cash_on_hand')
    expect(await entry(`cashvoucher.pay:${v.id}`)).toEqual([['1010', 'credit', 10_000], ['1357', 'debit', 10_000]])
    await readyToVerify(v.id)
    const lines = [{ categoryKey: 'transport', amountCents: 6_000, description: 'Taxi' }]
    for (const bad of [{ lines, changeBoxId: box['A'] }, { lines, changeCents: 4_000 }]) {
      const b = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, bad)
      expect(b.statusCode).toBe(422)
      expect(b.json().error.code).toBe('EXPENSE_BOOKED_AT_PAY')
    }
    const floats = [await floatOf(box['A']!), await floatOf(box['A2']!)]
    const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ spentCents: 10_000, changeCents: 0, topUpCents: 0 })
    expect(r.json().voucher).toMatchObject({ status: 'posted', settledCents: 10_000, returnedCents: 0 })
    expect(await entry(`cashvoucher.hold_convert:${v.id}`)).toEqual([['1357', 'credit', 10_000], ['6140', 'debit', 10_000]])
    expect(await entry(`cashvoucher.change:${v.id}`)).toBeNull()
    expect(await entry(`cashvoucher.post:${v.id}`)).toBeNull()
    expect(await held1357(v.id)).toBe(0)
    expect([await floatOf(box['A']!), await floatOf(box['A2']!)]).toEqual(floats)
    // The paid account read back is the expense account the conversion booked.
    expect((await ok('finA', 'GET', `${V}/${v.id}`)).paidAccountCode).toBe('6140')
    expect((await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})).json().error.code).toBe('ALREADY_POSTED')
  })

  it('held on 1357 from a bank: no overspend entry is ever posted — the conversion only; the bank is untouched', async () => {
    const v = await approved(10_000)
    await holdPayDirect(v.id, 'bank', bank['A1']!)
    await readyToVerify(v.id)
    const bankBefore = await prisma.journalLine.count({ where: { account: { code: '1021', tenantId: T.A } } })
    const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(await entry(`cashvoucher.overspend:${v.id}`)).toBeNull()
    expect(await entry(`cashvoucher.hold_convert:${v.id}`)).toEqual([['1357', 'credit', 10_000], ['6140', 'debit', 10_000]])
    expect(await prisma.journalLine.count({ where: { account: { code: '1021', tenantId: T.A } } })).toBe(bankBefore)
    expect(await held1357(v.id)).toBe(0)
  })

  it('one entry: checking the documents posts nothing; change / overspend are refused (a manual journal corrects them)', async () => {
    const v = await approved(7_000)
    const r0 = await pay('finA', v.id, { source: 'bank', bankAccountId: bank['A1'] })
    expect(r0.statusCode, r0.body).toBe(200)
    await readyToVerify(v.id)
    const entries = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    for (const bad of [{ changeCents: 1_000 }, { lines: [{ categoryKey: 'transport', amountCents: 9_000, description: 'Taxi' }] }]) {
      const b = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, bad)
      expect(b.statusCode).toBe(422)
      expect(b.json().error.code).toBe('EXPENSE_BOOKED_AT_PAY')
    }
    // The posting helper refuses change / overspend for such a voucher too.
    for (const kind of ['change', 'overspend'] as const) {
      await expect(prisma.$transaction((tx) => postCashVoucherSourceTx(tx, v.id, kind, 100, U['finA']!.id))).rejects.toMatchObject({ code: 'EXPENSE_BOOKED_AT_PAY' })
    }
    const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ entryId: r0.json().journalEntryId, changeCents: 0, topUpCents: 0 })
    expect(r.json().voucher).toMatchObject({ status: 'posted', settledCents: 7_000, returnedCents: 0 })
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entries)
    expect(await entry(`cashvoucher.change:${v.id}`)).toBeNull()
    expect(await entry(`cashvoucher.overspend:${v.id}`)).toBeNull()
    expect(await entry(`cashvoucher.post:${v.id}`)).toBeNull()
    expect(await entry(`cashvoucher.pay:${v.id}`)).toEqual([['1021', 'credit', 7_000], ['6140', 'debit', 7_000]])
    expect(await held1357(v.id)).toBe(0)
  })

  it('the tie-out counts only vouchers HELD on 1357; one-entry vouchers awaiting documents hold nothing', async () => {
    const held = await approved(2_500)
    await holdPayDirect(held.id, 'cash_on_hand')
    const one = await approved(3_300)
    expect((await pay('finA', one.id, { source: 'cash_on_hand' })).statusCode).toBe(200)
    const [row] = await pettyCashTieOut([T.A])
    // The earlier one-entry vouchers (cash on hand, bank, box) are still awaiting documents and hold nothing.
    expect(row!.heldVouchersCents).toBe(2_500)
    expect(row!.ledger1357Cents).toBe(2_500)
    expect(row, JSON.stringify(row)).toMatchObject({ ok: true })
    // Company B has nothing on 1357.
    expect((await pettyCashTieOut([T.B]))[0]).toMatchObject({ heldVouchersCents: 0, ledger1357Cents: 0 })
  })
})

describe('gate: races, rollbacks and the ready-to-pay notice', () => {
  it('box and bank pay at once: exactly one wins, one entry, nothing on 1357', async () => {
    const v = await approved(3_000)
    const start = await floatOf(box['A']!)
    const [a, b, c] = await Promise.all([
      pay('finA', v.id, { source: 'box', boxId: box['A'] }),
      pay('finA', v.id, { source: 'bank', bankAccountId: bank['A1'] }),
      pay('finA2', v.id, { source: 'cash_on_hand' }),
    ])
    const codes = [a, b, c].map((r) => r.statusCode).sort()
    expect(codes, [a, b, c].map((r) => r.body).join('\n')).toEqual([200, 409, 409])
    const after = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })
    const movements = await prisma.pettyCashMovement.count({ where: { cashVoucherId: v.id } })
    const payEntries = await prisma.journalEntry.count({ where: { reference: `cashvoucher.pay:${v.id}` } })
    expect(movements + payEntries).toBe(1)
    expect(after.bookedAtPay).toBe(true)
    if (after.paySource === 'box') {
      expect(await floatOf(box['A']!)).toBe(start - 3_000)
      expect(after.payJournalEntryId).toBeNull()
    } else {
      expect(await floatOf(box['A']!)).toBe(start)
      expect(after.pettyCashMovementId).toBeNull()
    }
    expect(await held1357(v.id)).toBe(0)
  })

  it('held on 1357: a refused conversion (locked period) is 409 VOUCHER_STILL_HELD — no entry, still awaiting documents', async () => {
    const v = await approved(8_000)
    await holdPayDirect(v.id, 'cash_on_hand')
    await readyToVerify(v.id)
    const lock = await prisma.periodLock.create({ data: { tenantId: T.A, lockedThrough: new Date(Date.now() + 86_400_000), lockedBy: 'test' } })
    try {
      const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
      expect(r.statusCode, r.body).toBe(409)
      expect(r.json().error.code).toBe('VOUCHER_STILL_HELD')
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
    expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ status: 'disbursed', postedAt: null, returnedCents: 0, bookedAtPay: false })
    expect(await entry(`cashvoucher.hold_convert:${v.id}`)).toBeNull()
    expect(await entry(`cashvoucher.post:${v.id}`)).toBeNull()
    expect(await held1357(v.id)).toBe(8_000)
  })

  it('the ready-to-pay notice reaches finance of the voucher\'s company (not company B)', async () => {
    const { flushNotifications } = await import('../src/lib/staffNotify.js')
    const v = await approved(2_000)
    await flushNotifications()
    const told = await prisma.staffNotification.findMany({ where: { entityId: v.id, dedupeKey: { startsWith: `task.next:cash_voucher:${v.id}:approved` } }, select: { userId: true, tenantId: true } })
    const ids = told.map((n) => n.userId)
    // Only finance pays (owner, 2026-10-16): finance is told, the box's cashier is not.
    expect(ids).toContain(U['finA']!.id)
    expect(ids).toContain(U['finA2']!.id)
    expect(ids).not.toContain(U['cashA']!.id)
    expect(ids).not.toContain(U['finB']!.id)
    expect(ids).not.toContain(U['ceoA']!.id)
    expect(told.every((n) => n.tenantId === T.A)).toBe(true)
  })
})
