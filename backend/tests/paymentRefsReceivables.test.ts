// Payment reference # and Bank deposit on receivables, write-off recoveries
// and inter-company settlements (owner, 2026-10-14).
//
//   - every receipt needs a payment reference #, cash included: 422
//     PAYMENT_REFERENCE_REQUIRED with nothing saved, on every method;
//   - 'bank_deposit' lands in the INVOICE company's named bank; another
//     company's bank → 422; the old 'bank' spelling still works (stored as
//     bank_transfer);
//   - the reference is stored on the row and written into the entry's
//     description and the money line's memo — journal_entries.reference stays
//     the dedupe key (sourceType:sourceId);
//   - a reference used before SAVES and comes back as referenceUsedBefore
//     (case-insensitive); company B's references never appear in A's warning;
//   - a write-off recovery by cash or bank deposit works (card is refused) and carries its
//     reference;
//   - inter-company: a bank deposit is the paying company's CASH into the
//     receiving company's named bank (a payer bank → 422); the reference is
//     required for every method at create and never re-checked at approval.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { fmtPktDate } from '../src/modules/accounting/dates.js'
import { receivableRoutes } from '../src/modules/receivables/routes.js'
import { intercompanyRoutes } from '../src/modules/intercompany/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
// The PKT calendar day — the date a person in Karachi types.
const today = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)
const daysAgo = (n: number) => fmtPktDate(new Date(Date.now() - n * 86_400_000))

let app: FastifyInstance
let tenantA: string, tenantB: string
let bankA1: string, bankA2: string, bankB: string
const staff: Record<string, string> = {}
const userId: Record<string, string> = {}

async function mkStaff(key: string, role: UserRole, tenantId: string, alsoIn: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@payrefs.test`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId },
  })
  for (const t of [tenantId, ...alsoIn]) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  staff[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
  userId[key] = u.id
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]}` } })
const AR = '/accounting/receivables'
const WO = `${AR}/write-offs`
const IC = '/accounting/intercompany'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(48, 1)]).toString('base64')

type Line = { code: string; type: string; amount: number; memo: string | null }
async function entry(tenantId: string, reference: string): Promise<{ description: string; lines: Line[] } | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  const lines = je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents), memo: l.memo }))
  const side = (t: string) => lines.filter((l) => l.type === t).reduce((s, l) => s + l.amount, 0)
  expect(side('debit')).toBe(side('credit'))
  return { description: je.description, lines }
}
const line = (lines: Line[], code: string, type: 'debit' | 'credit') => lines.find((l) => l.code === code && l.type === type)

async function raise(who: string, extra: Record<string, unknown> = {}) {
  const res = await call(who, 'POST', AR, {
    customerName: `Client ${RUN}`, issueDate: daysAgo(10), dueDate: '2099-12-31', description: 'Event catering',
    amountCents: 100_000, taxCents: 15_000, ...extra,
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json() as { id: string; number: string }
}
const inv = (id: string) => prisma.receivableInvoice.findUniqueOrThrow({ where: { id } })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Refs A', slug: `prr-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Refs B', slug: `prr-b-${RUN}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  // A has two banks (1020 and 1021), B has one.
  await prisma.account.create({ data: { tenantId: tenantA, code: '1021', name: 'Bank — Meezan', type: 'asset', isActive: true } })
  bankA1 = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL Ops', accountCode: '1020' } })).id
  bankA2 = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'Meezan', accountCode: '1021' } })).id
  bankB = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'B Bank', accountCode: '1020' } })).id
  await mkStaff('admA', 'admin', tenantA)
  await mkStaff('admB', 'admin', tenantB)
  // Inter-company: the CEO and finance of both companies, working in A.
  await mkStaff('ceoAB', 'admin', tenantA, [tenantB])
  await mkStaff('finAB', 'finance', tenantA, [tenantB])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(receivableRoutes, { prefix: AR })
  await app.register(intercompanyRoutes, { prefix: IC })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── Receivables: Record payment ────────────────────────────────────────────

describe('a receivable payment needs a payment reference #', () => {
  it('missing or blank → 422 PAYMENT_REFERENCE_REQUIRED on every method, cash included; nothing saved', async () => {
    const i = await raise('admA')
    const cases: Array<Record<string, unknown>> = [
      { method: 'cash' },
      { method: 'bank_transfer', bankAccountId: bankA1 },
      { method: 'bank_deposit', bankAccountId: bankA1 },
      { method: 'cheque', bankAccountId: bankA2 },
      { method: 'bank', bankAccountId: bankA1 },
      { method: 'cash', reference: '   ' },
      { method: 'cheque', bankAccountId: bankA1, reference: null },
    ]
    for (const c of cases) {
      const r = await call('admA', 'POST', `${AR}/${i.id}/payments`, { amountCents: 10_000, receivedAt: today(), ...c })
      expect(r.statusCode, JSON.stringify(c)).toBe(422)
      expect(r.json().error.code).toBe('PAYMENT_REFERENCE_REQUIRED')
    }
    const tooLong = await call('admA', 'POST', `${AR}/${i.id}/payments`, { amountCents: 10_000, receivedAt: today(), method: 'cash', reference: 'x'.repeat(101) })
    expect(tooLong.statusCode).toBe(400)
    const online = await call('admA', 'POST', `${AR}/${i.id}/payments`, { amountCents: 10_000, receivedAt: today(), method: 'online', reference: 'X-1' })
    expect(online.statusCode).toBe(400)
    expect(await prisma.receivablePayment.count({ where: { invoiceId: i.id } })).toBe(0)
    expect(Number((await inv(i.id)).paidCents)).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: { startsWith: 'receivable.payment:' }, description: { contains: i.number } } })).toBe(0)
  })

  it("a bank deposit lands in A's named bank; B's bank is 422; the reference is stored and in the description and memo", async () => {
    const i = await raise('admA')
    const foreign = await call('admA', 'POST', `${AR}/${i.id}/payments`, {
      amountCents: 50_000, receivedAt: today(), method: 'bank_deposit', bankAccountId: bankB, reference: 'DEP-1',
    })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    const noPick = await call('admA', 'POST', `${AR}/${i.id}/payments`, { amountCents: 50_000, receivedAt: today(), method: 'bank_deposit', reference: 'DEP-1' })
    expect(noPick.statusCode).toBe(422)
    expect(noPick.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    expect(await prisma.receivablePayment.count({ where: { invoiceId: i.id } })).toBe(0)

    const ok = await call('admA', 'POST', `${AR}/${i.id}/payments`, {
      amountCents: 50_000, receivedAt: today(), method: 'bank_deposit', bankAccountId: bankA2, reference: '  DEP-4471 ',
    })
    expect(ok.statusCode, ok.body).toBe(201)
    const p = ok.json()
    expect(p).toMatchObject({ method: 'bank_deposit', bankAccountId: bankA2, reference: 'DEP-4471', referenceUsedBefore: [] })
    const e = (await entry(tenantA, `receivable.payment:${p.id}`))!
    // journal_entries.reference is the dedupe key; the payment reference # is in the words.
    expect(e.description).toContain(i.number)
    expect(e.description).toContain('bank deposit, ref DEP-4471')
    expect(line(e.lines, '1021', 'debit')).toMatchObject({ amount: 50_000 })
    expect(line(e.lines, '1021', 'debit')!.memo).toBe(`${i.number}: bank deposit, ref DEP-4471`)
    expect(line(e.lines, '1110', 'credit')!.amount).toBe(50_000)

    // The old 'bank' spelling still works and is stored as a bank transfer.
    const old = await call('admA', 'POST', `${AR}/${i.id}/payments`, {
      amountCents: 10_000, receivedAt: today(), method: 'bank', bankAccountId: bankA1, reference: 'IBFT-12',
    })
    expect(old.statusCode, old.body).toBe(201)
    expect(old.json().method).toBe('bank_transfer')
    expect((await entry(tenantA, `receivable.payment:${old.json().id}`))!.description).toContain('bank transfer, ref IBFT-12')

    // No card in the back office (owner, 2026-10-16): refused, nothing saved.
    const before = await prisma.receivablePayment.count({ where: { invoiceId: i.id } })
    const card = await call('admA', 'POST', `${AR}/${i.id}/payments`, { amountCents: 5_000, receivedAt: today(), method: 'card', reference: 'APPR-9' })
    expect(card.statusCode, card.body).toBe(400)
    expect(await prisma.receivablePayment.count({ where: { invoiceId: i.id } })).toBe(before)
    // Cash → 1010 with its reference.
    const cash = await call('admA', 'POST', `${AR}/${i.id}/payments`, { amountCents: 5_000, receivedAt: today(), method: 'cash', reference: 'RV-001' })
    expect(cash.statusCode, cash.body).toBe(201)
    expect(line((await entry(tenantA, `receivable.payment:${cash.json().id}`))!.lines, '1010', 'debit')!.memo).toBe(`${i.number}: cash, ref RV-001`)

    // The list shows the reference.
    const list = (await call('admA', 'GET', `${AR}?status=outstanding`)).json() as { invoices: Array<{ id: string; payments: Array<{ id: string; reference: string | null; method: string }> }> }
    expect(list.invoices.find((r) => r.id === i.id)!.payments.find((x) => x.id === p.id)).toMatchObject({ reference: 'DEP-4471', method: 'bank_deposit' })
    // B cannot record a payment on A's invoice at all.
    expect((await call('admB', 'POST', `${AR}/${i.id}/payments`, { amountCents: 1_000, receivedAt: today(), method: 'cash', reference: 'B-1' })).statusCode).toBe(404)
  })

  it("a reference used before saves and is reported; company B's references never appear in A's warning", async () => {
    const ref = `SHARED-${RUN}`
    // B records it first.
    const ib = await raise('admB')
    const pb = await call('admB', 'POST', `${AR}/${ib.id}/payments`, { amountCents: 20_000, receivedAt: today(), method: 'cash', reference: ref })
    expect(pb.statusCode, pb.body).toBe(201)
    expect(pb.json().referenceUsedBefore).toEqual([])

    // A's first use: nothing of A's yet, and B's row is not shown.
    const i1 = await raise('admA')
    const p1 = await call('admA', 'POST', `${AR}/${i1.id}/payments`, { amountCents: 20_000, receivedAt: today(), method: 'bank_transfer', bankAccountId: bankA1, reference: ref })
    expect(p1.statusCode, p1.body).toBe(201)
    expect(p1.json().referenceUsedBefore).toEqual([])

    // A's second use (another invoice; case and spaces differ): saved, with a warning naming A's first.
    const i2 = await raise('admA')
    const p2 = await call('admA', 'POST', `${AR}/${i2.id}/payments`, {
      amountCents: 20_000, receivedAt: today(), method: 'bank_transfer', bankAccountId: bankA1, reference: ` ${ref.toLowerCase()} `,
    })
    expect(p2.statusCode, p2.body).toBe(201)
    const uses = p2.json().referenceUsedBefore as Array<{ kind: string; id: string; label: string }>
    expect(uses.map((u) => u.id)).toEqual([p1.json().id])
    expect(uses[0]!.kind).toBe('receivable_payment')
    expect(uses.some((u) => u.id === pb.json().id)).toBe(false)
    expect(Number((await inv(i2.id)).paidCents)).toBe(20_000)

    // And B's second use sees only B's own row.
    const ib2 = await raise('admB')
    const pb2 = await call('admB', 'POST', `${AR}/${ib2.id}/payments`, { amountCents: 1_000, receivedAt: today(), method: 'cash', reference: ref })
    expect((pb2.json().referenceUsedBefore as Array<{ id: string }>).map((u) => u.id)).toEqual([pb.json().id])
  })
})

// ─── Write-off recovery ─────────────────────────────────────────────────────

describe('a recovery on a written-off invoice', () => {
  it('needs a reference; works by cash and by bank deposit (card refused); carries the reference into both entries', async () => {
    const i = await raise('admA')
    // The CEO's own request applies at once.
    const w = await call('admA', 'POST', WO, {
      invoiceId: i.id, amountCents: 115_000, reason: 'Client closed and stopped answering letters',
      evidence: [{ fileName: 'letter.png', mime: 'image/png', data: PNG }],
    })
    expect(w.statusCode, w.body).toBe(201)
    expect(w.json().status).toBe('approved')
    const wid = w.json().id as string

    const noRef = await call('admA', 'POST', `${WO}/${wid}/recover`, { amountCents: 10_000, receivedAt: today(), method: 'cash' })
    expect(noRef.statusCode).toBe(422)
    expect(noRef.json().error.code).toBe('PAYMENT_REFERENCE_REQUIRED')
    const foreign = await call('admA', 'POST', `${WO}/${wid}/recover`, { amountCents: 10_000, receivedAt: today(), method: 'bank_deposit', bankAccountId: bankB, reference: 'D-1' })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(await prisma.receivablePayment.count({ where: { invoiceId: i.id } })).toBe(0)
    expect(Number((await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: wid } })).recoveredCents)).toBe(0)

    // Card is the till's only (owner, 2026-10-16) — refused here.
    const byCard = await call('admA', 'POST', `${WO}/${wid}/recover`, { amountCents: 40_000, receivedAt: today(), method: 'card', reference: 'SLIP-0' })
    expect(byCard.statusCode, byCard.body).toBe(400)
    const card = await call('admA', 'POST', `${WO}/${wid}/recover`, { amountCents: 40_000, receivedAt: today(), method: 'cash', reference: 'SLIP-1' })
    expect(card.statusCode, card.body).toBe(201)
    expect(card.json().payment).toMatchObject({ method: 'cash', reference: 'SLIP-1', writeOffId: wid, bankAccountId: null })
    expect(card.json().referenceUsedBefore).toEqual([])
    const pid = card.json().payment.id as string
    const pay = (await entry(tenantA, `receivable.payment:${pid}`))!
    expect(pay.description).toContain('cash, ref SLIP-1')
    expect(line(pay.lines, '1010', 'debit')).toMatchObject({ amount: 40_000, memo: `${i.number}: cash, ref SLIP-1` })
    const rec = (await entry(tenantA, `receivable.write_off_recovery:${pid}`))!
    expect(rec.description).toContain('cash, ref SLIP-1')
    expect(line(rec.lines, '6160', 'credit')!.amount).toBe(40_000)

    const dep = await call('admA', 'POST', `${WO}/${wid}/recover`, { amountCents: 75_000, receivedAt: today(), method: 'bank_deposit', bankAccountId: bankA2, reference: 'DSLIP-88' })
    expect(dep.statusCode, dep.body).toBe(201)
    expect(dep.json().payment).toMatchObject({ method: 'bank_deposit', bankAccountId: bankA2, reference: 'DSLIP-88' })
    const dp = (await entry(tenantA, `receivable.payment:${dep.json().payment.id}`))!
    expect(line(dp.lines, '1021', 'debit')).toMatchObject({ amount: 75_000, memo: `${i.number}: bank deposit, ref DSLIP-88` })
    expect((await inv(i.id)).status).toBe('paid')

    // B never touches A's write-off.
    expect((await call('admB', 'POST', `${WO}/${wid}/recover`, { amountCents: 1, receivedAt: today(), method: 'cash', reference: 'B' })).statusCode).toBe(404)
  })
})

// ─── Inter-company settlements ──────────────────────────────────────────────

describe('inter-company settlements', () => {
  it('reference required for every method; a bank deposit is A\'s cash into B\'s named bank; never re-checked at approval', async () => {
    // A owes B 100,000.
    const charge = await call('ceoAB', 'POST', `${IC}/transfers`, {
      kind: 'charge', debtorTenantId: tenantA, creditorTenantId: tenantB, amountCents: 100_000, entryDate: daysAgo(3),
      memo: 'Shared office rent', debtorAccountCode: '6010', creditorAccountCode: '6990', postNow: true,
    })
    expect(charge.statusCode, charge.body).toBe(201)
    const base = { kind: 'settlement', debtorTenantId: tenantA, creditorTenantId: tenantB, amountCents: 30_000, entryDate: daysAgo(1), memo: 'October settlement' }
    const before = await prisma.intercompanyTransfer.count({ where: { kind: 'settlement', tenantId: tenantA } })

    for (const extra of [
      { method: 'cash' },
      { method: 'bank_transfer', creditorBankAccountId: bankB, debtorBankAccountId: bankA1 },
      { method: 'bank_deposit', creditorBankAccountId: bankB, bankReference: ' ' },
      { method: 'cheque', creditorBankAccountId: bankB, debtorBankAccountId: bankA1, bankReference: null },
    ]) {
      const r = await call('finAB', 'POST', `${IC}/transfers`, { ...base, ...extra })
      expect(r.statusCode, JSON.stringify(extra)).toBe(422)
      expect(r.json().error.code).toBe('PAYMENT_REFERENCE_REQUIRED')
    }
    // The paying company names no bank on a deposit; B's bank must be B's own.
    const payerBank = await call('finAB', 'POST', `${IC}/transfers`, { ...base, method: 'bank_deposit', debtorBankAccountId: bankA1, creditorBankAccountId: bankB, bankReference: 'ICD-1' })
    expect(payerBank.statusCode).toBe(422)
    expect(payerBank.json().error.code).toBe('BANK_ACCOUNT_ON_DEPOSIT')
    const wrongSide = await call('finAB', 'POST', `${IC}/transfers`, { ...base, method: 'bank_deposit', creditorBankAccountId: bankA1, bankReference: 'ICD-1' })
    expect(wrongSide.statusCode).toBe(422)
    expect(wrongSide.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(await prisma.intercompanyTransfer.count({ where: { kind: 'settlement', tenantId: tenantA } })).toBe(before)

    const sub = await call('finAB', 'POST', `${IC}/transfers`, { ...base, method: 'bank_deposit', creditorBankAccountId: bankB, bankReference: `ICD-${RUN}` })
    expect(sub.statusCode, sub.body).toBe(201)
    expect(sub.json()).toMatchObject({ status: 'submitted', method: 'bank_deposit', bankReference: `ICD-${RUN}`, referenceUsedBefore: [] })
    const row = await prisma.intercompanyTransfer.findUniqueOrThrow({ where: { id: sub.json().id } })
    expect(row).toMatchObject({ debtorBankAccountId: null, creditorBankAccountId: bankB })

    const ok = await call('ceoAB', 'POST', `${IC}/transfers/${row.id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    const inA = (await entry(tenantA, `ic.transfer:${row.id}`))!
    const inB = (await entry(tenantB, `ic.transfer:${row.id}`))!
    // Payer: cash out of 1010. Receiver: into its named bank (1020 = B Bank).
    expect(line(inA.lines, '1010', 'credit')!.amount).toBe(30_000)
    expect(line(inA.lines, '1010', 'credit')!.memo).toContain(`bank deposit, ref ICD-${RUN}`)
    expect(line(inB.lines, '1020', 'debit')!.amount).toBe(30_000)
    expect(line(inB.lines, '1020', 'debit')!.memo).toContain(`bank deposit, ref ICD-${RUN}`)
    expect(inA.description).toContain(`bank deposit, ref ICD-${RUN}`)
    expect(inB.description).toContain(`bank deposit, ref ICD-${RUN}`)

    // The same reference again: saved, with a warning naming the first transfer.
    const again = await call('finAB', 'POST', `${IC}/transfers`, { ...base, amountCents: 5_000, method: 'bank', debtorBankAccountId: bankA1, creditorBankAccountId: bankB, bankReference: `icd-${RUN}` })
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json().method).toBe('bank_transfer')
    const uses = again.json().referenceUsedBefore as Array<{ kind: string; id: string }>
    expect(uses.map((u) => [u.kind, u.id])).toEqual([['intercompany_transfer', row.id]])

    // A settlement waiting from before the rule (no reference, old 'bank'
    // spelling) still approves: the reference is never re-checked.
    const legacy = await prisma.intercompanyTransfer.create({
      data: {
        tenantId: tenantA, counterpartyTenantId: tenantB, kind: 'settlement', source: 'manual', amountCents: 1_000,
        entryDate: new Date(`${daysAgo(1)}T12:00:00+05:00`), memo: 'Waiting since before the rule', method: 'bank',
        debtorBankAccountId: bankA1, creditorBankAccountId: bankB, bankReference: null, status: 'submitted', preparedById: userId['finAB']!,
      },
    })
    const la = await call('ceoAB', 'POST', `${IC}/transfers/${legacy.id}/approve`, {})
    expect(la.statusCode, la.body).toBe(200)
    expect(la.json().status).toBe('posted')
    expect(line((await entry(tenantA, `ic.transfer:${legacy.id}`))!.lines, '1020', 'credit')!.memo).toContain('bank transfer')
  })
})
