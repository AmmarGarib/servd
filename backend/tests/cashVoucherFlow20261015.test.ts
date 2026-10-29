// Cash vouchers — the 2026-10-15 flow (owner): request → finance approval →
// CEO final approval → pay → supporting documents → finance checks them.
// Since 2026-10-16 (owner: "It should pass only one entry when booked by
// finance, either docs are attached or not") the PAY is the one entry —
// Dr the voucher's 6xxx / Cr 1011 — and documents + finance's check book
// nothing (bookedAtPay). A voucher already HELD on 1357 (paid before that,
// built here by holdPaid) is booked at finance's check as ONE conversion
// entry ('cashvoucher.hold_convert:<id>' Dr its expense / Cr 1357 — owner,
// 2026-10-16: nothing else posts to 1357).
//
//   - Anyone raises (status submitted at once); finance returns for
//     correction, the raiser edits and resubmits; finance approves (never its
//     own: SELF_APPROVE); the CEO gives the final approval (never the finance
//     approver: SAME_SIGNER).
//   - Pay (finance only — owner, 2026-10-16; anyone else 403 PAY_FINANCE_ONLY):
//     Dr 6xxx / Cr 1011 through recordPettyCashSpendTx, nothing on 1357.
//   - Documents: PDF / XLSX / DOCX / CSV take; HTML, SVG, an EXE named .pdf
//     are refused; verify without documents → 422 DOCS_REQUIRED.
//   - Check (booked at pay): posted, nothing booked; lines / change → 422
//     EXPENSE_BOOKED_AT_PAY; again → 409 ALREADY_POSTED.
//   - Check (held on 1357): the conversion entry, then nothing; lines / change
//     → 422 before anything posts; equipment / a locked period → 409
//     VOUCHER_STILL_HELD, flagged, still held.
//   - Finance raises a payee voucher with a discount (CHECK holds).
//   - Legacy hod_signed / draft rows keep working; a legacy H3 paid row keeps
//     its settlement rules.
//   - Company B: 404 on every route of A's voucher; dashboard per company;
//     close check (a warn for unchecked documents); tie-out.
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { readFileSync } from 'node:fs'
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
import { buildXlsx, zipStored } from '../src/lib/xlsxWriter.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { registerApprovalsPlugin } from '../src/modules/approvals/index.js'
import { cashRequestPayLine, pettyCashTieOut } from '../src/modules/accounting/pettyCashPosting.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { recordPettyCashSpendTx } from '../src/modules/trustops/pettyCash.js'
import { CLOSE_CHECKS } from '../src/modules/accounting/closeChecks.js'
import { runCashAdvanceOverdueOnce } from '../src/workers/cashAdvanceOverdue.js'

const P = `cvf${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const C: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const box: Record<string, string> = {}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n')
const XLSX = buildXlsx({ name: 'Bill', rows: [['Item', 'PKR'], ['Taxi', 90]] } as Parameters<typeof buildXlsx>[0])
const DOCX = zipStored([
  { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
  { name: 'word/document.xml', data: Buffer.from('<?xml version="1.0"?><w:document xmlns:w="w"><w:body/></w:document>') },
])
const doc = (fileName: string, bytes: Buffer, mime: string) => ({ fileName, mime, dataBase64: bytes.toString('base64') })

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@cvf.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const call = (key: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }, ...(payload !== undefined && { payload: payload as object }) })

const V = '/trustops/cash-vouchers'
type Row = {
  id: string; tenantId: string; number: string; status: string; stage: string; kind: string; amountCents: number; grossCents: number | null
  discountCents: number; totalCents: number; amountInWords: string; supportingCount: number; returnCount: number; returnNote: string | null
  financeApprovedById: string | null; financeApprovedByName: string | null; directorSignedById: string | null; directorSignedByName: string | null
  expenseOnVerify: boolean; postedJournalEntryId: string | null; settledCents: number; returnedCents: number; pettyCashMovementId: string | null
  canFinanceApprove: boolean; canApprove: boolean; canReturn: boolean; canReject: boolean; canPay: boolean; canUpload: boolean; canVerify: boolean
  spend?: { spentCents: number | null; changeDueCents: number | null; topUpDueCents: number | null } | null
}

async function raise(key: string, body: Record<string, unknown> = {}): Promise<Row> {
  // sendTo 'finance': these flows exercise the finance step (a finance raise otherwise goes straight to the CEO).
  const r = await call(key, 'POST', V, { purpose: `Market run ${Math.random().toString(36).slice(2, 7)}`, categoryKey: 'transport', amountCents: 10_000, ...(body['kind'] === 'expense' ? {} : { sendTo: 'finance' }), ...body })
  expect(r.statusCode, r.body).toBe(201)
  return r.json() as Row
}
async function ok(key: string, method: 'POST' | 'PATCH', url: string, body?: unknown): Promise<Row> {
  const r = await call(key, method, url, body ?? {})
  expect(r.statusCode, `${key} ${url} ${r.body}`).toBe(200)
  return r.json() as Row
}
/** cookA raises, finA approves, ceoA gives the final approval. */
async function approved(body: Record<string, unknown> = {}): Promise<Row> {
  const v = await raise('cookA', body)
  await ok('finA', 'POST', `${V}/${v.id}/finance-approve`)
  return ok('ceoA', 'POST', `${V}/${v.id}/approve`)
}
async function paid(body: Record<string, unknown> = {}, boxKey = 'A'): Promise<Row> {
  const v = await approved(body)
  const r = await call('payA', 'POST', `${V}/${v.id}/pay`, { boxId: box[boxKey] })
  expect(r.statusCode, r.body).toBe(200)
  // The holder confirms "Cash received" (digital receipt, owner 2026-10-15).
  return ok('cookA', 'POST', `${V}/${v.id}/confirm-received`)
}
/**
 * A voucher paid under the HOLD flow (before 2026-10-16's one-entry rule), as
 * such rows sit in the books today: a lineless 1357 box movement (Dr 1357 /
 * Cr 1011), bookedAtPay false — written directly, since nothing in the code
 * posts to 1357 any more. Then the holder confirms.
 */
async function holdPaid(body: Record<string, unknown> = {}, boxKey = 'A'): Promise<Row> {
  const v = await approved(body)
  const row = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })
  await prisma.$transaction(async (tx) => {
    await tx.pettyCashBox.update({ where: { id: box[boxKey]! }, data: { floatCents: { decrement: row.amountCents } } })
    const m = await tx.pettyCashMovement.create({
      data: {
        boxId: box[boxKey]!, tenantId: row.tenantId, type: 'spend', amountCents: -row.amountCents, reason: `Cash voucher ${row.number}: ${row.purpose}`,
        vendorName: row.payeeName, createdById: U['payA']!.id, source: 'box', accountCode: '1357', cashVoucherId: row.id, conceptId: row.conceptId,
      },
    })
    // Written directly (as the retired 'voucher_hold' nature booked it): nothing in the code posts to 1357 any more.
    const je = await postJournalEntry({
      tenantId: row.tenantId, sourceType: 'pettycash.spend', sourceId: m.id, description: 'Cash voucher paid from petty cash (held until finance verifies the documents)',
      postedBy: U['payA']!.id, entryDate: new Date(),
      lines: [
        { accountCode: '1357', type: 'debit', amountCents: row.amountCents, conceptId: row.conceptId },
        { accountCode: '1011', type: 'credit', amountCents: row.amountCents, conceptId: row.conceptId },
      ],
    }, { tx })
    await tx.pettyCashMovement.update({ where: { id: m.id }, data: { journalEntryId: je.entryId } })
    await tx.cashVoucher.update({
      where: { id: row.id },
      data: {
        status: 'disbursed', boxId: box[boxKey]!, disbursedAt: new Date(), disbursedById: U['payA']!.id, dueBy: new Date(Date.now() + 30 * 86_400_000),
        expenseOnVerify: true, bookedAtPay: false, paySource: 'box', pettyCashMovementId: m.id,
      },
    })
  })
  return ok('cookA', 'POST', `${V}/${v.id}/confirm-received`)
}
async function upload(key: string, id: string, file = doc('bill.pdf', PDF, 'application/pdf')): Promise<string> {
  const r = await call(key, 'POST', `${V}/${id}/documents`, file)
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id as string
}
async function entry(reference: string, tenantId = T.A) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je ? je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort() : null
}
/** Σ debit − credit on `code` over entries whose lines mention `voucherNumber` or that are the voucher's own. */
async function balanceOf(code: string, tenantId = T.A): Promise<number> {
  const lines = await prisma.journalLine.findMany({ where: { account: { code, tenantId } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0)
}
const floatOf = async (id: string) => (await prisma.pettyCashBox.findUniqueOrThrow({ where: { id } })).floatCents

beforeAll(async () => {
  // The migration's SQL-only CHECK (db push in tests/setup.ts does not create it): read from the migration itself.
  const mig = readFileSync(new URL('../prisma/migrations/20261015140000_petty_cash_expense_vouchers/migration.sql', import.meta.url), 'utf8')
  const chk = /ALTER TABLE "cash_vouchers" ADD CONSTRAINT "cash_vouchers_discount_chk"[\s\S]*?\);/.exec(mig)![0]
  const has = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'cash_vouchers_discount_chk'`
  if (has[0]!.n === 0) await prisma.$executeRawUnsafe(chk)
  T.A = (await prisma.tenant.create({ data: { name: 'Flow Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Flow Co B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await ensureChartOfAccounts(T.B)
  invalidateSetupCache()
  C.A = (await prisma.concept.create({ data: { name: `${P} brand A`, slug: `${P}-brand-a`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} brand B`, slug: `${P}-brand-b`, type: 'restaurant', tenantId: T.B } })).id
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('ceoA2', 'admin', [T.A])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('finA2', 'finance', [T.A])
  await mkUser('finB', 'finance', [T.B])
  // Pays approved vouchers (owner, 2026-10-16: only finance pays), from cashA's boxes.
  await mkUser('payA', 'finance', [T.A])
  await mkUser('mgrA', 'management', [T.A])
  await mkUser('cashA', 'cashier', [T.A])
  await mkUser('cashB', 'cashier', [T.B])
  await mkUser('cookA', 'boh', [T.A])
  await mkUser('waiterA', 'foh', [T.A])
  await mkUser('cookB', 'boh', [T.B])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(trustopsRoutes, { prefix: '/trustops' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()

  // Boxes start empty and are funded through the ledger, so the tie-out holds.
  box['A'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Head office box', custodianId: U['cashA']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  box['A2'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Kitchen box', custodianId: U['cashA']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  box['B'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.B, name: 'B box', custodianId: U['cashB']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  for (const [b, who] of [['A', 'finA'], ['A2', 'finA'], ['B', 'finB']] as const) {
    const r = await call(who, 'POST', '/trustops/petty-cash/movements', { boxId: box[b], type: 'topup', amountCents: 500_000, reason: 'Float from Garibsons', source: 'garibsons' })
    expect(r.statusCode, r.body).toBe(201)
  }
}, 120_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

// ─── The whole flow ───────────────────────────────────────────────────────────

describe('request → finance → CEO → pay → documents → verify', () => {
  it('runs end to end: ONE entry at pay (Dr expense / Cr 1011), documents and the check book nothing, 1357 untouched', async () => {
    const start1357 = await balanceOf('1357')
    const startFloat = await floatOf(box['A']!)

    // Raised: the voucher is created at once, waiting for finance.
    const v = await raise('cookA', { amountCents: 12_000, conceptId: C.A, purpose: 'Taxi and paper for the office' })
    expect(v).toMatchObject({ status: 'submitted', stage: 'waiting_finance', kind: 'request', amountCents: 12_000, totalCents: 12_000, discountCents: 0, grossCents: null })
    expect(v.amountInWords).toBe('Pakistani Rupees One Hundred Twenty Only')
    expect(v.number).toMatch(/^CV-\d{5}$/)

    // Finance returns it for correction; the raiser edits and resubmits.
    expect((await call('cookA', 'POST', `${V}/${v.id}/finance-approve`)).json().error.code).toBe('NOT_FINANCE')
    expect((await call('finA', 'POST', `${V}/${v.id}/return`, { note: 'x' })).statusCode).toBe(400)
    const ret = await ok('finA', 'POST', `${V}/${v.id}/return`, { note: 'Say which office' })
    expect(ret).toMatchObject({ status: 'returned', stage: 'returned', returnCount: 1, returnNote: 'Say which office' })
    expect((await call('finA', 'POST', `${V}/${v.id}/finance-approve`)).json().error.code).toBe('VOUCHER_NOT_SUBMITTED')
    await ok('cookA', 'PATCH', `${V}/${v.id}`, { purpose: 'Taxi and paper for the head office' })
    expect((await call('waiterA', 'POST', `${V}/${v.id}/resubmit`)).statusCode).toBe(403)
    const re = await ok('cookA', 'POST', `${V}/${v.id}/resubmit`)
    expect(re).toMatchObject({ status: 'submitted', stage: 'waiting_finance' })

    // Finance approves (never their own).
    const own = await raise('finA', { amountCents: 1_000 })
    const self = await call('finA', 'POST', `${V}/${own.id}/finance-approve`)
    expect(self.statusCode).toBe(409)
    expect(self.json().error.code).toBe('SELF_APPROVE')
    expect((await call('ceoA', 'POST', `${V}/${v.id}/approve`)).json().error.code).toBe('VOUCHER_NOT_FINANCE_APPROVED')
    const fa = await ok('finA', 'POST', `${V}/${v.id}/finance-approve`)
    expect(fa).toMatchObject({ status: 'finance_approved', stage: 'waiting_ceo', financeApprovedById: U['finA']!.id, financeApprovedByName: `${P} finA` })
    expect((await call('finA', 'POST', `${V}/${v.id}/approve`)).statusCode).toBe(403)

    // The CEO's final approval: never the login that gave the finance approval.
    const other = await raise('cookA', { amountCents: 1_000 })
    await ok('ceoA', 'POST', `${V}/${other.id}/finance-approve`)
    const same = await call('ceoA', 'POST', `${V}/${other.id}/approve`)
    expect(same.statusCode).toBe(409)
    expect(same.json().error.code).toBe('SAME_SIGNER')
    expect((await ok('ceoA2', 'POST', `${V}/${other.id}/approve`)).status).toBe('approved')
    const ap = await ok('ceoA', 'POST', `${V}/${v.id}/approve`)
    expect(ap).toMatchObject({ status: 'approved', directorSignedById: U['ceoA']!.id, directorSignedByName: `${P} ceoA` })
    expect(await floatOf(box['A']!)).toBe(startFloat)

    // Pay is finance's only: the box's cashier and the CEO are refused, nothing moves.
    for (const who of ['cashA', 'ceoA']) {
      const r = await call(who, 'POST', `${V}/${v.id}/pay`, { boxId: box['A'] })
      expect(r.statusCode, who).toBe(403)
      expect(r.json().error.code, who).toBe('PAY_FINANCE_ONLY')
    }
    expect(await floatOf(box['A']!)).toBe(startFloat)
    // Pay: THE one entry — Dr 6140 (transport) / Cr 1011, under the voucher's brand; nothing on 1357.
    const pay = await call('payA', 'POST', `${V}/${v.id}/pay`, { boxId: box['A'] })
    expect(pay.statusCode, pay.body).toBe(200)
    const pb = pay.json() as { voucher: Row & { bookedAtPay: boolean }; movement: { id: string; amountCents: number; journalEntryId: string }; journalEntryId: string }
    expect(pb.voucher).toMatchObject({ status: 'disbursed', stage: 'awaiting_docs', expenseOnVerify: true, bookedAtPay: true })
    expect(await entry(`pettycash.spend:${pb.movement.id}`)).toEqual([['1011', 'credit', 12_000], ['6140', 'debit', 12_000]])
    const payJe = await prisma.journalEntry.findUniqueOrThrow({ where: { id: pb.journalEntryId }, include: { lines: true } })
    expect(payJe.tenantId).toBe(T.A)
    expect(payJe.lines.every((l) => l.conceptId === C.A)).toBe(true)
    expect(await floatOf(box['A']!)).toBe(startFloat - 12_000)
    expect(await balanceOf('1357')).toBe(start1357)
    const entriesAfterPay = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    expect((await call('finA', 'POST', `${V}/${v.id}/pay`, { boxId: box['A'] })).json().error.code).toBe('ALREADY_PAID')

    // Digital receipt: the voucher shows the payer; Received by is the holder until they confirm, and finance
    // cannot verify before the holder confirms. Only the holder confirms, once.
    expect(pb.voucher).toMatchObject({ paidByName: `${P} payA`, receiverName: `${P} cookA`, cashReceivedAt: null, canConfirmReceived: false })
    const unconfirmed = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(unconfirmed.json().error.code).toBe('CASH_RECEIPT_NOT_CONFIRMED')
    expect((await call('finA', 'POST', `${V}/${v.id}/confirm-received`)).json().error.code).toBe('NOT_HOLDER')
    expect((await call('cookA', 'GET', `${V}/${v.id}`)).json()).toMatchObject({ canConfirmReceived: true })
    const conf = await ok('cookA', 'POST', `${V}/${v.id}/confirm-received`)
    expect(conf).toMatchObject({ cashReceivedById: U['cookA']!.id, cashReceivedByName: `${P} cookA`, receiverName: `${P} cookA`, canConfirmReceived: false })
    expect((await call('cookA', 'POST', `${V}/${v.id}/confirm-received`)).json().error.code).toBe('ALREADY_CONFIRMED')

    // Verify without documents → 422.
    const early = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(early.statusCode).toBe(422)
    expect(early.json().error.code).toBe('DOCS_REQUIRED')

    // Documents: PDF, XLSX, DOCX, CSV take; HTML, SVG, an EXE named .pdf, markup in .txt do not.
    const pdfId = await upload('cookA', v.id)
    const xlsxId = await upload('cookA', v.id, doc('bill.xlsx', XLSX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
    await upload('cashA', v.id, doc('note.docx', DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
    await upload('finA', v.id, doc('lines.csv', Buffer.from('item,amount\ntaxi,90\n'), 'application/vnd.ms-excel'))
    const refused: Array<[string, Buffer, string]> = [
      ['page.html', Buffer.from('<html><script>alert(1)</script></html>'), 'text/html'],
      ['logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml'],
      ['invoice.pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]), 'application/pdf'],
      ['notes.txt', Buffer.from('<!DOCTYPE html><html></html>'), 'text/plain'],
      ['bill.xlsx', DOCX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['bill.pdf', PDF, 'image/png'],
    ]
    for (const [name, bytes, mime] of refused) {
      const r = await call('cookA', 'POST', `${V}/${v.id}/documents`, doc(name, bytes, mime))
      expect(r.statusCode, name).toBe(400)
      expect(r.json().error.code, name).toBe('BAD_FILE')
    }
    expect((await call('waiterA', 'POST', `${V}/${v.id}/documents`, doc('bill.pdf', PDF, 'application/pdf'))).statusCode).toBe(403)
    const pdfGet = await call('finA', 'GET', `${V}/${v.id}/attachments/${pdfId}`)
    expect(pdfGet.headers['content-disposition']).toMatch(/^inline/)
    expect(pdfGet.headers['x-content-type-options']).toBe('nosniff')
    const xlsxGet = await call('finA', 'GET', `${V}/${v.id}/attachments/${xlsxId}`)
    expect(xlsxGet.headers['content-disposition']).toMatch(/^attachment; filename=".*\.xlsx"/)
    expect(xlsxGet.headers['cache-control']).toBe('private, no-store')

    // The documents are stored under the voucher and book nothing.
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entriesAfterPay)
    const st = await call('finA', 'GET', `${V}/${v.id}`)
    expect(st.json()).toMatchObject({ stage: 'awaiting_verification', closed: true, booksState: 'booked', canRecordSpend: false, spend: null, payEntryId: pb.journalEntryId, paidAccountCode: '6140' })
    // Nothing to record as spent: the pay booked it.
    const sp = await call('cookA', 'POST', `${V}/${v.id}/spend`, { lines: [{ categoryKey: 'transport', amountCents: 9_000, description: 'Taxi' }] })
    expect(sp.statusCode).toBe(409)
    expect(sp.json().error.code).toBe('EXPENSE_BOOKED_AT_PAY')

    // Check: not the holder, not a non-finance login; no lines, no change, no box — a manual journal corrects money.
    expect((await call('cookA', 'POST', `${V}/${v.id}/verify-docs`, {})).json().error.code).toBe('NOT_FINANCE')
    for (const bad of [{ changeCents: 1_000 }, { lines: [{ categoryKey: 'office', amountCents: 12_000, description: 'x' }] }, { changeBoxId: box['A'] }, { topUpBoxId: box['A'] }]) {
      const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, bad)
      expect(r.statusCode, JSON.stringify(bad)).toBe(422)
      expect(r.json().error.code).toBe('EXPENSE_BOOKED_AT_PAY')
    }
    const ver = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(ver.statusCode, ver.body).toBe(200)
    const vb = ver.json() as { entryId: string; spentCents: number; changeCents: number; topUpCents: number; voucher: Row }
    expect(vb).toMatchObject({ entryId: pb.journalEntryId, spentCents: 12_000, changeCents: 0, topUpCents: 0 })
    expect(vb.voucher).toMatchObject({ status: 'posted', stage: 'posted', postedJournalEntryId: null, settledCents: 12_000, returnedCents: 0 })
    // The check posted NOTHING: no verification entry, no change, the same float, 1357 untouched.
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entriesAfterPay)
    expect(await entry(`cashvoucher.post:${v.id}`)).toBeNull()
    expect(await prisma.pettyCashMovement.count({ where: { cashVoucherId: v.id } })).toBe(1)
    expect(await floatOf(box['A']!)).toBe(startFloat - 12_000)
    expect(await balanceOf('1357')).toBe(start1357)

    // Again → 409, nothing more is booked; documents stay, removing one is refused.
    const entriesAfter = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const again = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('ALREADY_POSTED')
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entriesAfter)
    expect((await call('finA', 'DELETE', `${V}/${v.id}/documents/${pdfId}`)).json().error.code).toBe('DOCUMENTS_LOCKED')
    expect((await call('cookA', 'POST', `${V}/${v.id}/documents`, doc('late.pdf', PDF, 'application/pdf'))).statusCode).toBe(403)
    await upload('finA', v.id, doc('late.pdf', PDF, 'application/pdf'))

    // The audit trail, oldest first, with names.
    const hist = (await call('cookA', 'GET', `${V}/${v.id}/history`)).json() as { items: Array<{ action: string; userName: string | null }> }
    const actions = hist.items.map((h) => h.action)
    expect(actions.slice(0, 7)).toEqual(['create', 'return', 'update', 'resubmit', 'finance_approve', 'approve', 'pay'])
    expect(actions).toEqual(expect.arrayContaining(['document_add', 'verify_docs']))
    expect(actions).not.toContain('spend')
    expect(hist.items[0]!.userName).toBe(`${P} cookA`)

    // Exports work after approval.
    expect((await call('cookA', 'GET', `${V}/${v.id}/export.pdf`)).statusCode).toBe(200)

    const [tie] = await pettyCashTieOut([T.A])
    expect(tie, JSON.stringify(tie)).toMatchObject({ ok: true, unbookedMovements: 0 })
  })

  it('held on 1357 (paid before the one-entry rule): finance\'s check books ONE conversion entry Dr expense / Cr 1357 and nothing else; lines / change refused first', async () => {
    const start1357 = await balanceOf('1357')
    const float = await floatOf(box['A2']!)
    const v = await holdPaid({ amountCents: 5_000, categoryKey: 'transport' }, 'A2')
    expect(await balanceOf('1357')).toBe(start1357 + 5_000)
    await upload('cookA', v.id)
    // Lines, change or an overspend box: refused BEFORE anything posts (a manual journal corrects a difference).
    const lines = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {
      lines: [{ categoryKey: 'transport', amountCents: 6_500, description: 'Two taxis' }], topUpBoxId: box['A2'],
    })
    expect(lines.statusCode, lines.body).toBe(422)
    expect(lines.json().error.code).toBe('EXPENSE_BOOKED_AT_PAY')
    expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ bookedAtPay: false, status: 'disbursed' })
    expect(await balanceOf('1357')).toBe(start1357 + 5_000)
    // What was spent is no longer recorded line by line.
    const spend = await call('cookA', 'POST', `${V}/${v.id}/spend`, { lines: [{ categoryKey: 'transport', amountCents: 5_000, description: 'Taxi' }] })
    expect(spend.statusCode).toBe(409)
    expect(spend.json().error.code).toBe('EXPENSE_BOOKED_AT_PAY')

    const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ spentCents: 5_000, changeCents: 0, topUpCents: 0 })
    expect(await entry(`cashvoucher.hold_convert:${v.id}`)).toEqual([['1357', 'credit', 5_000], ['6140', 'debit', 5_000]])
    expect(await entry(`cashvoucher.post:${v.id}`)).toBeNull()
    expect(await balanceOf('1357')).toBe(start1357)
    expect(await floatOf(box['A2']!)).toBe(float - 5_000)
    const row = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })
    const conv = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: T.A, reference: `cashvoucher.hold_convert:${v.id}` } })
    expect(row).toMatchObject({ status: 'posted', bookedAtPay: true, settledCents: 5_000, returnedCents: 0, postedJournalEntryId: conv.id })
    expect(r.json().entryId).toBe(conv.id)
    // Checked again: 409, nothing more.
    const again = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(again.json().error.code).toBe('ALREADY_POSTED')
    expect((await pettyCashTieOut([T.A]))[0]).toMatchObject({ ok: true })
  })

  it('a pay into a locked period rolls everything back: still approved, no movement, no entry, the float unchanged', async () => {
    const v = await approved({ amountCents: 3_000 })
    const float = await floatOf(box['A']!)
    const entries = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const lock = await prisma.periodLock.create({ data: { tenantId: T.A, lockedThrough: new Date(Date.now() + 86_400_000), lockedBy: 'test' } })
    try {
      const r = await call('payA', 'POST', `${V}/${v.id}/pay`, { boxId: box['A'] })
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('PERIOD_LOCKED')
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
    expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ status: 'approved', bookedAtPay: false, pettyCashMovementId: null })
    expect(await floatOf(box['A']!)).toBe(float)
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entries)
  })

  it('a held voucher whose conversion is refused (locked period): 409 VOUCHER_STILL_HELD, flagged in its company, nothing posted', async () => {
    const v = await holdPaid({ amountCents: 3_000 })
    await upload('cookA', v.id)
    const float = await floatOf(box['A']!)
    const entries = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const lock = await prisma.periodLock.create({ data: { tenantId: T.A, lockedThrough: new Date(Date.now() + 86_400_000), lockedBy: 'test' } })
    try {
      const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
      expect(r.statusCode).toBe(409)
      expect(r.json().error.code).toBe('VOUCHER_STILL_HELD')
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
    const row = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })
    expect(row).toMatchObject({ status: 'disbursed', bookedAtPay: false, postedAt: null, postedJournalEntryId: null, settledCents: 0, returnedCents: 0 })
    expect(await floatOf(box['A']!)).toBe(float)
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entries)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'cash_voucher_hold_unconverted', entityId: v.id, tenantId: T.A } })).toBe(1)
    // The period open again: the check converts it and books nothing else.
    expect((await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})).statusCode).toBe(200)
    expect(await entry(`cashvoucher.hold_convert:${v.id}`)).toEqual([['1357', 'credit', 3_000], ['6140', 'debit', 3_000]])
  })
})

describe('held voucher with no usable category: finance sets it, then the check books it (gate)', () => {
  it('409 VOUCHER_STILL_HELD; only finance (not the raiser, not another company) sets the account; then ONE entry in it', async () => {
    const v = await holdPaid({ amountCents: 2_700, categoryKey: 'transport' })
    // A legacy row as it may sit in the books: no category.
    await prisma.cashVoucher.update({ where: { id: v.id }, data: { category: null } })
    await upload('cookA', v.id)
    const entries = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(r.statusCode, r.body).toBe(409)
    expect(r.json().error.code).toBe('VOUCHER_STILL_HELD')
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entries)
    // The raiser / holder never sets it; another company never sees it; nothing else may change on a paid voucher.
    expect((await call('cookA', 'PATCH', `${V}/${v.id}`, { categoryKey: 'office' })).statusCode).toBe(403)
    expect((await call('finB', 'PATCH', `${V}/${v.id}`, { categoryKey: 'office' })).statusCode).toBe(404)
    const more = await call('finA', 'PATCH', `${V}/${v.id}`, { categoryKey: 'office', purpose: 'changed' })
    expect(more.statusCode).toBe(409)
    expect(more.json().error.code).toBe('VOUCHER_NOT_DRAFT')
    const set = await call('finA', 'PATCH', `${V}/${v.id}`, { categoryKey: 'office' })
    expect(set.statusCode, set.body).toBe(200)
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entries)
    const ok2 = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(ok2.statusCode, ok2.body).toBe(200)
    expect(await entry(`cashvoucher.hold_convert:${v.id}`)).toEqual([['1357', 'credit', 2_700], ['6170', 'debit', 2_700]])
    expect(await prisma.exceptionFlag.count({ where: { kind: 'cash_voucher_hold_unconverted', entityId: v.id, status: 'open' } })).toBe(0)
    // Booked: the account is fixed now (a manual journal moves it).
    expect((await call('finA', 'PATCH', `${V}/${v.id}`, { categoryKey: 'transport' })).statusCode).toBe(409)
  })
})

// ─── Finance raises a payee voucher ───────────────────────────────────────────

describe('finance raises a voucher for an outside payee, with a discount', () => {
  it('goes to the CEO at once; total = gross − discount; the CHECK holds; same flow to posted', async () => {
    expect((await call('cookA', 'POST', V, { kind: 'expense', payeeName: 'Ali Electric', purpose: 'Wiring', categoryKey: 'repairs', amountCents: 1_000 })).json().error.code)
      .toBe('EXPENSE_VOUCHER_FINANCE_ONLY')
    expect((await call('cookA', 'POST', V, { purpose: 'x', categoryKey: 'transport', grossCents: 2_000, discountCents: 100 })).json().error.code).toBe('DISCOUNT_FINANCE_ONLY')
    expect((await call('finA', 'POST', V, { kind: 'expense', purpose: 'Wiring', categoryKey: 'repairs', amountCents: 1_000 })).json().error.code).toBe('PAYEE_REQUIRED')
    expect((await call('finA', 'POST', V, { kind: 'expense', payeeName: 'Ali', purpose: 'Wiring', categoryKey: 'repairs', grossCents: 1_000, discountCents: 1_000 })).json().error.code)
      .toBe('DISCOUNT_TOO_LARGE')

    const v = await raise('finA', { kind: 'expense', payeeName: 'Ali Electric', purpose: 'Rewiring the store lights', categoryKey: 'repairs', grossCents: 50_000, discountCents: 5_000, amountCents: undefined })
    expect(v).toMatchObject({
      kind: 'expense', status: 'finance_approved', stage: 'waiting_ceo', grossCents: 50_000, discountCents: 5_000, amountCents: 45_000, totalCents: 45_000,
      financeApprovedById: U['finA']!.id,
    })
    expect(v.amountInWords).toBe('Pakistani Rupees Four Hundred Fifty Only')
    // The database refuses a total that is not gross − discount.
    await expect(prisma.cashVoucher.update({ where: { id: v.id }, data: { amountCents: 44_000 } })).rejects.toThrow()
    // Finance may still move the discount while it waits for the CEO.
    const moved = await ok('finA2', 'PATCH', `${V}/${v.id}`, { discountCents: 10_000 })
    expect(moved).toMatchObject({ grossCents: 50_000, discountCents: 10_000, amountCents: 40_000 })
    expect((await call('cookA', 'PATCH', `${V}/${v.id}`, { discountCents: 1 })).statusCode).toBe(403)

    // The CEO returns it; finance resubmits → straight back to the CEO.
    await ok('ceoA', 'POST', `${V}/${v.id}/return`, { note: 'Attach the quote' })
    const back = await ok('finA', 'POST', `${V}/${v.id}/resubmit`)
    expect(back).toMatchObject({ status: 'finance_approved', financeApprovedById: U['finA']!.id })
    await ok('ceoA', 'POST', `${V}/${v.id}/approve`)
    const pay = await call('payA', 'POST', `${V}/${v.id}/pay`, { boxId: box['A'] })
    expect(pay.statusCode, pay.body).toBe(200)
    // An outside payee has no login: the pay records the hand-over; Received by is the payee.
    expect(pay.json().voucher).toMatchObject({ receiverName: 'Ali Electric', paidByName: `${P} payA`, cashReceivedById: U['payA']!.id, canConfirmReceived: false })
    await upload('cashA', v.id, doc('quote.pdf', PDF, 'application/pdf'))
    // The preparer may not verify their own voucher; another finance person does.
    expect((await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})).json().error.code).toBe('SELF_APPROVE')
    // The pay was the one entry: Dr 6050 (repairs) / Cr 1011 for the total after discount; the check books nothing.
    expect(await entry(`pettycash.spend:${pay.json().movement.id}`)).toEqual([['1011', 'credit', 40_000], ['6050', 'debit', 40_000]])
    expect((await call('finA2', 'POST', `${V}/${v.id}/verify-docs`, {})).statusCode).toBe(200)
    expect(await entry(`cashvoucher.post:${v.id}`)).toBeNull()
  })
})

// ─── Legacy rows ──────────────────────────────────────────────────────────────

describe('legacy rows keep working', () => {
  it('a legacy draft is finance\'s; a legacy hod_signed row is the CEO\'s (never the HOD signer)', async () => {
    const base = { tenantId: T.A, voucherDate: new Date(), payeeName: 'Legacy', payeeUserId: U['cookA']!.id, purpose: 'Old request', category: 'transport', amountCents: 1_000, preparedById: U['cookA']!.id }
    const draft = await prisma.cashVoucher.create({ data: { ...base, seq: 9001, number: 'CV-09001', status: 'draft' } })
    expect((await call('finA', 'GET', `${V}/${draft.id}`)).json()).toMatchObject({ stage: 'waiting_finance', canFinanceApprove: true })
    expect((await ok('finA', 'POST', `${V}/${draft.id}/finance-approve`)).status).toBe('finance_approved')
    expect((await call('mgrA', 'POST', `${V}/${draft.id}/sign-hod`)).json().error.code).toBe('HOD_STEP_RETIRED')

    const signed = await prisma.cashVoucher.create({ data: { ...base, seq: 9002, number: 'CV-09002', status: 'hod_signed', hodSignedById: U['ceoA']!.id, hodSignedAt: new Date() } })
    expect((await call('ceoA', 'GET', `${V}/${signed.id}`)).json()).toMatchObject({ stage: 'waiting_ceo', canApprove: false, canReturn: true })
    expect((await call('ceoA', 'POST', `${V}/${signed.id}/approve`)).json().error.code).toBe('SAME_SIGNER')
    expect((await ok('ceoA2', 'POST', `${V}/${signed.id}/approve`)).status).toBe('approved')
  })

  it('a row paid under H3 keeps its receipts / settlement rules; the new routes refuse it, and the old ones refuse a new one', async () => {
    const legacy = await prisma.cashVoucher.create({
      data: {
        tenantId: T.A, seq: 9003, number: 'CV-09003', voucherDate: new Date(), payeeName: 'Legacy', payeeUserId: U['cookA']!.id,
        purpose: 'H3 run', category: 'transport', amountCents: 4_000, status: 'approved', preparedById: U['cookA']!.id,
        directorSignedById: U['ceoA']!.id, directorSignedAt: new Date(),
      },
    })
    // The old pay: one expense line in the category (H3), as it booked before 2026-10-15.
    await prisma.$transaction(async (tx) => {
      const s = await recordPettyCashSpendTx(tx, {
        box: { id: box['A']! }, amountCents: 4_000, reason: 'Cash request CV-09003', createdById: U['cashA']!.id, nature: 'expense',
        lines: [cashRequestPayLine({ ...legacy })], cashVoucherId: legacy.id, allowExplicit: true, equipmentCheck: false, stockAllowed: false,
      })
      await tx.cashVoucher.update({ where: { id: legacy.id }, data: { status: 'disbursed', boxId: box['A'], disbursedAt: new Date(), pettyCashMovementId: s.movement.id } })
    })
    expect((await call('finA', 'GET', `${V}/${legacy.id}`)).json()).toMatchObject({ stage: 'paid', expenseOnVerify: false, paidAccountCode: '6140' })
    expect((await call('finA', 'POST', `${V}/${legacy.id}/verify-docs`, {})).json().error.code).toBe('VOUCHER_NOT_AWAITING_DOCS')
    expect((await call('cookA', 'POST', `${V}/${legacy.id}/spend`, { lines: [{ categoryKey: 'office', amountCents: 100, description: 'x' }] })).json().error.code).toBe('VOUCHER_NOT_AWAITING_DOCS')
    const rc = await call('cookA', 'POST', `${V}/${legacy.id}/receipts`, { photo: PDF.toString('base64'), mime: 'application/pdf' })
    expect(rc.statusCode, rc.body).toBe(201)
    const st = await call('cookA', 'POST', `${V}/${legacy.id}/settlements`, { lines: [{ categoryKey: 'office', amountCents: 4_000, description: 'Paper' }], receiptIds: [rc.json().id] })
    expect(st.statusCode, st.body).toBe(200)
    expect(await entry(`cashvoucher.settle:${st.json().settlementId}`)).toEqual([['6140', 'credit', 4_000], ['6170', 'debit', 4_000]])
    expect(st.json().voucher.status).toBe('settled')

    const fresh = await paid({ amountCents: 1_000 })
    expect((await call('cookA', 'POST', `${V}/${fresh.id}/receipts`, { photo: PDF.toString('base64'), mime: 'application/pdf' })).json().error.code).toBe('USE_DOCUMENTS')
    expect((await call('cashA', 'POST', `${V}/${fresh.id}/return-change`, { amountCents: 100 })).json().error.code).toBe('USE_DOCUMENTS')
  })
})

// ─── Company B, dashboard, close check, inbox, worker ─────────────────────────

describe("company B never reaches company A's voucher", () => {
  it('404 on every route; the dashboard and lists are per company', async () => {
    const waiting = await raise('cookA', { amountCents: 1_000 })
    const p = await paid({ amountCents: 1_000 })
    const docId = await upload('cookA', p.id)
    const routes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown]> = [
      ['GET', `${V}/${waiting.id}`, undefined],
      ['GET', `${V}/${waiting.id}/history`, undefined],
      ['PATCH', `${V}/${waiting.id}`, { purpose: 'not ours' }],
      ['POST', `${V}/${waiting.id}/finance-approve`, {}],
      ['POST', `${V}/${waiting.id}/return`, { note: 'not ours' }],
      ['POST', `${V}/${waiting.id}/resubmit`, {}],
      ['POST', `${V}/${waiting.id}/reject`, { note: 'not ours' }],
      ['POST', `${V}/${waiting.id}/cancel`, { note: 'not ours' }],
      ['POST', `${V}/${p.id}/documents`, doc('x.pdf', PDF, 'application/pdf')],
      ['DELETE', `${V}/${p.id}/documents/${docId}`, undefined],
      ['GET', `${V}/${p.id}/attachments/${docId}`, undefined],
      ['POST', `${V}/${p.id}/spend`, { lines: [{ categoryKey: 'transport', amountCents: 100, description: 'x' }] }],
      ['POST', `${V}/${p.id}/verify-docs`, {}],
      ['GET', `${V}/${p.id}/export.pdf`, undefined],
      ['GET', `${V}/${p.id}/export.xlsx`, undefined],
    ]
    for (const [method, url, body] of routes) {
      for (const who of ['finB', 'ceoB', 'cashB']) {
        const r = await call(who, method, url, body)
        expect(r.statusCode, `${who} ${method} ${url} ${r.body}`).toBe(404)
      }
    }
    expect((await call('ceoB', 'POST', `${V}/${waiting.id}/approve`)).statusCode).toBe(404)
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe('submitted')
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('disbursed')

    const dashA = (await call('finA', 'GET', `${V}/dashboard`)).json() as Record<string, { count: number; cents: number }> & { scope: string }
    const dashB = (await call('finB', 'GET', `${V}/dashboard`)).json() as Record<string, { count: number; cents: number }> & { scope: string }
    expect(dashA.scope).toBe('company')
    const countA = await prisma.cashVoucher.count({ where: { tenantId: T.A, status: { in: ['submitted', 'draft'] } } })
    expect(dashA['waitingFinance']!.count).toBe(countA)
    expect(dashA['awaitingVerification']!.count).toBe(await prisma.cashVoucher.count({ where: { tenantId: T.A, status: 'disbursed', expenseOnVerify: true, attachments: { some: { kind: 'supporting' } } } }))
    expect(dashA['postedThisMonth']!.count).toBeGreaterThan(0)
    expect(dashB['waitingFinance']!.count).toBe(0)
    // A B voucher shows only in B's numbers.
    await raise('cookB', { amountCents: 7_000 })
    expect(((await call('finB', 'GET', `${V}/dashboard`)).json() as typeof dashB)['waitingFinance']).toEqual({ count: 1, cents: 7_000 })
    expect(((await call('finA', 'GET', `${V}/dashboard`)).json() as typeof dashA)['waitingFinance']!.count).toBe(countA)
    // Staff see only their own numbers.
    const mine = (await call('waiterA', 'GET', `${V}/dashboard`)).json() as typeof dashA
    expect(mine.scope).toBe('mine')
    expect(mine['waitingFinance']!.count).toBe(0)

    const listB = (await call('finB', 'GET', `${V}?view=finance`)).json() as { items: Row[] }
    expect(listB.items.every((x) => x.tenantId === T.B)).toBe(true)
    const listA = (await call('finA', 'GET', `${V}?view=awaiting_verification`)).json() as { items: Row[] }
    expect(listA.items.map((x) => x.id)).toContain(p.id)
    expect(listA.items.every((x) => x.tenantId === T.A && x.status === 'disbursed')).toBe(true)
    const missing = (await call('finA', 'GET', `${V}?view=missing_docs`)).json() as { items: Row[] }
    expect(missing.items.every((x) => x.supportingCount === 0)).toBe(true)
  })

  it('the close check only warns about unchecked documents (held or one-entry alike), never blocks; only in its company', async () => {
    const held = await holdPaid({ amountCents: 1_500 })
    const one = await paid({ amountCents: 1_700 })
    const check = CLOSE_CHECKS.find((c) => c.key === 'vouchers_awaiting_docs')!
    expect(check).toMatchObject({ severity: 'warn', overridable: false })
    expect(CLOSE_CHECKS.find((c) => c.key === 'voucher_docs_unchecked')).toBeUndefined()
    const ctx = (tenantId: string) => ({ db: prisma, tenantId, prevLock: null, newLock: new Date(Date.now() + 86_400_000), months: [], isYearEnd: false })
    const a = await check.run(ctx(T.A))
    expect(a).toMatchObject({ key: 'vouchers_awaiting_docs', severity: 'warn', overridable: false })
    expect(a!.count).toBe(await prisma.cashVoucher.count({ where: { tenantId: T.A, status: 'disbursed', expenseOnVerify: true } }))
    expect(a!.detail).not.toContain('1357')
    expect(await check.run(ctx(T.B))).toBeNull()
    // Before the vouchers were paid they do not count.
    expect(await check.run({ ...ctx(T.A), newLock: new Date(Date.now() - 30 * 86_400_000) })).toBeNull()
    expect([held.status, one.status]).toEqual(['disbursed', 'disbursed'])
  })

  it('approvals inbox: finance sees the finance step (approve / return / reject), the CEO the final step', async () => {
    const v = await raise('cookA', { amountCents: 2_200, purpose: 'Inbox finance step' })
    type Inbox = { items: Array<{ type: string; id: string; tenantId: string; actions: Array<{ kind: string; path: string; body: Record<string, unknown>; input?: { field: string; required: boolean }; disabledReason?: string }> }> }
    const fin = (await call('finA2', 'GET', '/approvals')).json() as Inbox
    const item = fin.items.find((i) => i.id === v.id)!
    expect(item).toMatchObject({ type: 'cash_request_finance', tenantId: T.A })
    expect(item.actions.map((a) => a.kind)).toEqual(['approve', 'return', 'reject'])
    expect(item.actions.find((a) => a.kind === 'return')).toMatchObject({ path: `${V}/${v.id}/return`, input: { field: 'note', required: true } })
    expect(((await call('finB', 'GET', '/approvals')).json() as Inbox).items.some((i) => i.id === v.id)).toBe(false)
    // The CEO's inbox does not list the finance step.
    expect(((await call('ceoA', 'GET', '/approvals')).json() as Inbox).items.some((i) => i.id === v.id)).toBe(false)
    const approve = item.actions.find((a) => a.kind === 'approve')!
    expect((await call('finA2', 'POST', approve.path, approve.body)).statusCode).toBe(200)
    const ceo = (await call('ceoA', 'GET', '/approvals')).json() as Inbox
    const step = ceo.items.find((i) => i.id === v.id)!
    expect(step.type).toBe('cash_voucher')
    expect(step.actions.map((a) => a.kind)).toEqual(['approve', 'return', 'reject'])
    expect(step.actions[0]!.disabledReason).toBeUndefined()
    const back = step.actions.find((a) => a.kind === 'return')!
    expect((await call('ceoA', 'POST', back.path, { ...back.body, note: 'Wrong brand' })).json().status).toBe('returned')
  })

  it('the daily worker flags a paid voucher with no supporting document once', async () => {
    const v = await paid({ amountCents: 1_100 })
    await prisma.cashVoucher.update({ where: { id: v.id }, data: { dueBy: new Date(Date.now() - 86_400_000) } })
    await runCashAdvanceOverdueOnce(new Date())
    const flags = await prisma.exceptionFlag.findMany({ where: { entityId: v.id, kind: 'cash_request_receipts_overdue' } })
    expect(flags).toHaveLength(1)
    expect(flags[0]!.tenantId).toBe(T.A)
    expect(flags[0]!.title).toMatch(/Supporting documents overdue/)
    await runCashAdvanceOverdueOnce(new Date())
    expect(await prisma.exceptionFlag.count({ where: { entityId: v.id, kind: 'cash_request_receipts_overdue' } })).toBe(1)
  })
})

// ─── Review gate (2026-10-15): stock / capex at verification, own money, exact change ───

describe('review gate', () => {
  it('held voucher that looks like equipment: the check is refused (VOUCHER_STILL_HELD), flagged, nothing posts; 1357 keeps only its hold', async () => {
    const start1357 = await balanceOf('1357')
    const v = await holdPaid({ amountCents: 9_000, purpose: 'Blender for the kitchen' })
    await upload('cookA', v.id)
    const entries = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(r.statusCode, r.body).toBe(409)
    expect(r.json().error.code).toBe('VOUCHER_STILL_HELD')
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entries)
    expect(await balanceOf('1357')).toBe(start1357 + 9_000)
    expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ status: 'disbursed', bookedAtPay: false })
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'cash_voucher_hold_unconverted', entityId: v.id } })
    expect(flag).toMatchObject({ tenantId: T.A, status: 'open' })
    // The tie-out still explains 1357 by the vouchers held on it.
    expect((await pettyCashTieOut([T.A]))[0]).toMatchObject({ ok: true })
  })

  it('one-entry pay runs the equipment check BEFORE money moves: refused (USE_CAPEX) until finance overrides with a reason; the override is flagged', async () => {
    const v = await approved({ amountCents: 5_000, purpose: 'Two chairs for the office' })
    const startFloat = await floatOf(box['A']!)
    const before = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const refused = await call('payA', 'POST', `${V}/${v.id}/pay`, { boxId: box['A'] })
    expect(refused.statusCode, refused.body).toBe(422)
    expect(refused.json().error.code).toBe('USE_CAPEX')
    const short = await call('payA', 'POST', `${V}/${v.id}/pay`, { boxId: box['A'], notEquipment: true, notEquipmentReason: 'rent' })
    expect(short.json().error.code).toBe('OVERRIDE_REASON_REQUIRED')
    // Nothing moved: still approved, the float and the books unchanged.
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('approved')
    expect(await floatOf(box['A']!)).toBe(startFloat)
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(before)
    const pay = await call('payA', 'POST', `${V}/${v.id}/pay`, { boxId: box['A'], notEquipment: true, notEquipmentReason: 'Hired for one event, returned the next day' })
    expect(pay.statusCode, pay.body).toBe(200)
    expect(await entry(`pettycash.spend:${pay.json().movement.id}`)).toEqual([['1011', 'credit', 5_000], ['6140', 'debit', 5_000]])
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'equipment_override', entityType: 'CashVoucher', entityId: v.id } })
    expect(flag?.tenantId).toBe(T.A)
  })

  it('whoever raised or holds a voucher never changes its money after finance approval; change at the check is refused', async () => {
    // finA2 raises a request for itself; finA approves; finA2 may not lift the gross while it waits for the CEO.
    const own = await raise('finA2', { amountCents: 4_000 })
    await ok('finA', 'POST', `${V}/${own.id}/finance-approve`)
    const up = await call('finA2', 'PATCH', `${V}/${own.id}`, { grossCents: 9_000 })
    expect(up.statusCode, up.body).toBe(409)
    expect(up.json().error.code).toBe('SELF_APPROVE')
    // Another finance person still may set a discount.
    expect((await call('finA', 'PATCH', `${V}/${own.id}`, { discountCents: 500 })).statusCode).toBe(200)

    const v = await holdPaid({ amountCents: 2_000 })
    await upload('cookA', v.id)
    const r = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, { changeCents: 300 })
    expect(r.statusCode, r.body).toBe(422)
    expect(r.json().error.code).toBe('EXPENSE_BOOKED_AT_PAY')
    expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ status: 'disbursed', bookedAtPay: false })
  })
})

// ─── Closed once the documents are in; finance checks after (owner, 2026-10-16) ───

describe('closed when the supporting documents are attached; finance checks after', () => {
  type Detail = Row & {
    closed: boolean; booksState: 'pending' | 'booked' | null; sentBack: boolean; sentBackNote: string | null
    cashReceivedById: string | null; cashReceivedAt: string | null; canSendBack: boolean; payeeUserId: string | null
    documents: Array<{ id: string; fileName: string; uploadedByName: string | null }>
  }
  const get = async (key: string, id: string) => {
    const r = await call(key, 'GET', `${V}/${id}`)
    expect(r.statusCode, r.body).toBe(200)
    return r.json() as Detail
  }
  const ids = async (key: string, view: string) => ((await call(key, 'GET', `${V}?view=${view}`)).json() as { items: Row[] }).items.map((x) => x.id)

  it('requester (not the holder) attaches after pay → receipt confirmed, CLOSED (booked at pay); send back reopens; a new upload closes; the check books nothing', async () => {
    // cookA asks for cash that waiterA takes.
    const v = await approved({ amountCents: 3_000, holderUserId: U['waiterA']!.id, purpose: 'Gas cylinder refill' })
    expect(v).toMatchObject({ status: 'approved' })
    const pay = await call('payA', 'POST', `${V}/${v.id}/pay`, { boxId: box['A'] })
    expect(pay.statusCode, pay.body).toBe(200)

    const before = await get('cookA', v.id)
    expect(before).toMatchObject({ payeeUserId: U['waiterA']!.id, canUpload: true, closed: false, booksState: 'booked', stage: 'awaiting_docs', cashReceivedAt: null })
    expect(await ids('cookA', 'open')).toContain(v.id)
    expect(await ids('cookA', 'closed')).not.toContain(v.id)

    // The requester attaches the bill: that confirms the cash was received (audited) and closes the voucher.
    const docId = await upload('cookA', v.id)
    const closed = await get('cookA', v.id)
    expect(closed).toMatchObject({
      status: 'disbursed', closed: true, booksState: 'booked', sentBack: false, stage: 'awaiting_verification',
      cashReceivedById: U['cookA']!.id, canUpload: true, canSendBack: false,
    })
    expect(closed.documents.map((d) => d.id)).toContain(docId)
    const conf = await prisma.auditLog.findFirst({ where: { entityId: v.id, action: 'cash_voucher.confirm_received' } })
    expect(conf?.after).toMatchObject({ via: 'document_upload' })
    expect(conf?.tenantId).toBe(T.A)
    expect(await ids('cookA', 'open')).not.toContain(v.id)
    expect(await ids('cookA', 'closed')).toContain(v.id)
    expect(await ids('finA', 'awaiting_verification')).toContain(v.id)
    expect(await ids('finA', 'missing_docs')).not.toContain(v.id)
    // Everyone who can see it opens and downloads the document.
    expect((await call('waiterA', 'GET', `${V}/${v.id}/attachments/${docId}`)).statusCode).toBe(200)
    // A second document by the holder does not confirm again.
    await upload('waiterA', v.id, doc('bill2.pdf', PDF, 'application/pdf'))
    expect(await prisma.auditLog.count({ where: { entityId: v.id, action: 'cash_voucher.confirm_received' } })).toBe(1)

    // Send back: finance only, never another company's, never the requester.
    expect((await get('finA', v.id)).canSendBack).toBe(true)
    expect((await call('cookA', 'POST', `${V}/${v.id}/send-back`, { note: 'Bill is unreadable' })).json().error.code).toBe('NOT_FINANCE')
    for (const who of ['finB', 'ceoB', 'cookB']) {
      expect((await call(who, 'POST', `${V}/${v.id}/send-back`, { note: 'not ours at all' })).statusCode).toBe(404)
    }
    expect((await call('finA', 'POST', `${V}/${v.id}/send-back`, { note: 'x' })).statusCode).toBe(400)
    const sb = await ok('finA', 'POST', `${V}/${v.id}/send-back`, { note: 'Bill is unreadable' })
    expect(sb).toMatchObject({ status: 'disbursed', closed: false, booksState: 'booked', sentBack: true, sentBackNote: 'Bill is unreadable', stage: 'sent_back' })
    expect((await call('finA', 'POST', `${V}/${v.id}/send-back`, { note: 'Again please' })).json().error.code).toBe('VOUCHER_NOT_CLOSED')
    expect(await ids('cookA', 'open')).toContain(v.id)
    expect(await ids('finA', 'sent_back')).toContain(v.id)
    expect(await ids('finA', 'awaiting_verification')).not.toContain(v.id)
    const dash = (await call('finA', 'GET', `${V}/dashboard`)).json() as Record<string, { count: number }>
    expect(dash['sentBack']!.count).toBeGreaterThanOrEqual(1)
    expect(await prisma.auditLog.count({ where: { entityId: v.id, action: 'cash_voucher.send_back' } })).toBe(1)

    // A new document closes it again.
    await upload('cookA', v.id, doc('bill-clear.pdf', PDF, 'application/pdf'))
    expect(await get('cookA', v.id)).toMatchObject({ closed: true, booksState: 'booked', sentBack: false, stage: 'awaiting_verification' })
    expect(await ids('cookA', 'open')).not.toContain(v.id)

    // Finance checks the documents: posted, and nothing more is booked — the pay was the one entry.
    const entries = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const ver = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(ver.statusCode, ver.body).toBe(200)
    expect((ver.json() as { voucher: Detail }).voucher).toMatchObject({ status: 'posted', closed: true, booksState: 'booked', canSendBack: false })
    expect(await entry(`cashvoucher.post:${v.id}`)).toBeNull()
    expect(await entry(`pettycash.spend:${pay.json().movement.id}`)).toEqual([['1011', 'credit', 3_000], ['6140', 'debit', 3_000]])
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entries)

    // A booked voucher is never sent back.
    const late = await call('finA', 'POST', `${V}/${v.id}/send-back`, { note: 'Too late now' })
    expect(late.statusCode).toBe(409)
    expect(late.json().error.code).toBe('VOUCHER_POSTED')
    // The documents stay on it for reference, for the requester too.
    expect((await get('cookA', v.id)).documents).toHaveLength(3)
  })

  // Owner screenshot 2026-10-29: "In cash request, it's not showing all expense heads to select". The finance picker now
  // lists every 6xxx head of the company; the approval books to any of them as accountCode.
  it('finance approval may book a cash request to any expense head of the company, not only a voucher category', async () => {
    const v = await raise('cookA', { amountCents: 2_000 })
    const fa = await ok('finA', 'POST', `${V}/${v.id}/finance-approve`, { accountCode: '6170' })
    expect(fa).toMatchObject({ status: 'finance_approved', category: '6170' })
  })
})

