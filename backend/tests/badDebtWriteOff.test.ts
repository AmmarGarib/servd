// Bad-debt write-off of an ordinary receivable invoice (wave B, G12 / H15 —
// the CEO approves every one) and its recovery.
//
//   request   reason + 1-5 evidence files (400 EVIDENCE_REQUIRED / BAD_FILE),
//             one open per invoice (409 WRITE_OFF_OPEN), never more than the
//             balance (409), never on a credit note or a void invoice (409);
//   approve   the CEO only (403 for anyone else); a finance requester and the
//             CEO approver is the normal path; a request the CEO raises applies
//             at once (decision 27). Dr 6160 / Cr 1110 in the invoice's
//             company with the invoice's brand; status written_off, out of
//             aging; a payment since the request → 409; a closed period → 422
//             with nothing saved;
//   recover   Dr 1110 / Cr 6160 + Dr bank / Cr 1110 in one transaction, the
//             counters move; reversing that payment restores writtenOff and
//             recoveredCents and reverses both entries;
//   flags     canApprove / canReject / canCancel / canRecover per role.
//   Two companies throughout: B gets 404 on every A write-off route; a write-off
//   binds to the invoice's company; a foreign bank → 422.
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
import { receivableRoutes } from '../src/modules/receivables/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
// The PKT calendar day — the date a person in Karachi types (5 h ahead of UTC).
const today = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)

let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string
let bankA: string, bankB: string
const staff: Record<string, string> = {}
const userId: Record<string, string> = {}

async function mkStaff(key: string, role: UserRole, tenantId: string, alsoIn: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@baddebt.test`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId },
  })
  for (const t of [tenantId, ...alsoIn]) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  staff[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
  userId[key] = u.id
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]}` } })
const AR = '/accounting/receivables'
const WO = `${AR}/write-offs`

// Smallest files the evidence decoder accepts (magic numbers + ≥ 32 bytes).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(48, 1)]).toString('base64')
const PDF = Buffer.from('%PDF-1.4\n' + 'x'.repeat(60)).toString('base64')
const evidence = [
  { fileName: 'demand-letter.png', mime: 'image/png', data: PNG },
  { fileName: 'closure.pdf', mime: 'application/pdf', data: `data:application/pdf;base64,${PDF}` },
]
const REASON = 'Client closed its Karachi office and stopped answering demand letters'

type Line = { code: string; type: string; amount: number; conceptId: string | null }
async function entry(tenantId: string, reference: string): Promise<Line[] | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  const lines = je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents), conceptId: l.conceptId }))
  expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
  return lines
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
const side = (lines: Line[], type: string) => lines.filter((l) => l.type === type).reduce((t, l) => t + l.amount, 0)
async function netDebit(tenantId: string, code: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { tenantId, code }, journalEntry: { tenantId } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((t, l) => t + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0)
}

async function raise(who: string, extra: Record<string, unknown> = {}) {
  const res = await call(who, 'POST', AR, {
    customerName: `Corporate ${RUN}`, issueDate: '2025-06-01', dueDate: '2025-07-01', description: 'Catering',
    amountCents: 100_000, taxCents: 15_000, conceptId: conceptA, ...extra,
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json() as { id: string; number: string }
}
const inv = (id: string) => prisma.receivableInvoice.findUniqueOrThrow({ where: { id } })
async function request(who: string, invoiceId: string, amountCents: number, files = evidence) {
  return call(who, 'POST', WO, { invoiceId, amountCents, reason: REASON, evidence: files })
}
type Row = {
  id: string; tenantId: string; status: string; amountCents: number; recoveredCents: number; decidedById: string | null
  journalEntryId: string | null; attachments: Array<{ id: string; mime: string }>; invoiceNumber: string
  canApprove: boolean; canReject: boolean; canCancel: boolean; canRecover: boolean
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'BD A', slug: `bd-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'BD B', slug: `bd-b-${RUN}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  conceptA = (await prisma.concept.create({ data: { name: 'Karachi kitchen', slug: `bd-a-${RUN}`, type: 'restaurant', tenantId: tenantA, province: 'SD', taxRateCash: 15, taxRateCard: 8 } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Other co', slug: `bd-b-${RUN}`, type: 'restaurant', tenantId: tenantB, province: 'SD' } })).id
  bankA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL Ops', accountCode: '1020' } })).id
  bankB = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'B Bank', accountCode: '1020' } })).id
  await mkStaff('ceoA', 'admin', tenantA)
  await mkStaff('finA', 'finance', tenantA)
  await mkStaff('mgmtA', 'management', tenantA)
  await mkStaff('fnbA', 'fnb_manager', tenantA)
  await mkStaff('ceoB', 'admin', tenantB)
  await mkStaff('finB', 'finance', tenantB)
  // Finance for both companies, working in A.
  await mkStaff('finAB', 'finance', tenantA, [tenantB])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(receivableRoutes, { prefix: AR })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── Request ────────────────────────────────────────────────────────────────

describe('asking for a write-off', () => {
  it('needs evidence, real files, an amount within the balance, and one open request per invoice', async () => {
    const i = await raise('finA')
    const none = await call('finA', 'POST', WO, { invoiceId: i.id, amountCents: 115_000, reason: REASON })
    expect(none.statusCode).toBe(400)
    expect(none.json().error.code).toBe('EVIDENCE_REQUIRED')
    const empty = await request('finA', i.id, 115_000, [])
    expect(empty.json().error.code).toBe('EVIDENCE_REQUIRED')
    const fake = await request('finA', i.id, 115_000, [{ fileName: 'x.png', mime: 'image/png', data: Buffer.from('<script>alert(1)</script> and some padding text').toString('base64') }])
    expect(fake.statusCode).toBe(400)
    expect(fake.json().error.code).toBe('BAD_FILE')
    const shortReason = await call('finA', 'POST', WO, { invoiceId: i.id, amountCents: 1_000, reason: 'bad', evidence })
    expect(shortReason.statusCode).toBe(400)
    const over = await request('finA', i.id, 115_001)
    expect(over.statusCode).toBe(409)
    expect(over.json().error.code).toBe('WRITE_OFF_EXCEEDS_BALANCE')
    expect(await prisma.receivableWriteOff.count({ where: { invoiceId: i.id } })).toBe(0)

    const ok = await request('finA', i.id, 115_000)
    expect(ok.statusCode, ok.body).toBe(201)
    const row = ok.json() as Row
    expect(row).toMatchObject({ status: 'requested', tenantId: tenantA, amountCents: 115_000, invoiceNumber: i.number, journalEntryId: null })
    expect(row.attachments.map((a) => a.mime)).toEqual(['image/png', 'application/pdf'])
    expect(row).toMatchObject({ canApprove: false, canReject: false, canCancel: true, canRecover: false })
    // Asking changes nothing on the invoice or in the books.
    expect(Number((await inv(i.id)).writtenOffCents)).toBe(0)
    expect(await entry(tenantA, `receivable.write_off:${row.id}`)).toBeNull()

    const again = await request('mgmtA', i.id, 1_000)
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('WRITE_OFF_OPEN')

    // A financials viewer who may not request (the F&B manager) → 403.
    expect((await request('fnbA', i.id, 1_000)).statusCode).toBe(403)

    // The evidence comes back inline, typed, never sniffed or cached.
    const file = await call('finA', 'GET', `${WO}/${row.id}/evidence/${row.attachments[1]!.id}`)
    expect(file.statusCode).toBe(200)
    expect(file.headers['content-type']).toBe('application/pdf')
    expect(file.headers['x-content-type-options']).toBe('nosniff')
    expect(file.headers['cache-control']).toBe('private, no-store')
    expect(file.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('a credit note or a void invoice cannot be written off (409)', async () => {
    const i = await raise('finA')
    const cn = await call('finA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 10_000, reason: 'price dispute', date: today() })
    expect(cn.statusCode, cn.body).toBe(201)
    const onNote = await request('finA', cn.json().id, 1_000)
    expect(onNote.statusCode).toBe(409)
    expect(onNote.json().error.code).toBe('NOT_AN_INVOICE')

    const v = await raise('finA')
    expect((await call('finA', 'POST', `${AR}/${v.id}/void`, { reason: 'raised in error' })).statusCode).toBe(200)
    const onVoid = await request('finA', v.id, 1_000)
    expect(onVoid.statusCode).toBe(409)
    expect(onVoid.json().error.code).toBe('INVOICE_VOID')
  })

  it('voiding an invoice cancels the write-off still waiting on it', async () => {
    const i = await raise('finA')
    const r = (await request('finA', i.id, 50_000)).json() as Row
    expect((await call('finA', 'POST', `${AR}/${i.id}/void`, { reason: 'raised in error' })).statusCode).toBe(200)
    const after = await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: r.id } })
    expect(after.status).toBe('cancelled')
    const approve = await call('ceoA', 'POST', `${WO}/${r.id}/approve`, {})
    expect(approve.statusCode).toBe(409)
  })
})

// ─── Approve ────────────────────────────────────────────────────────────────

describe('the CEO approves every write-off', () => {
  it('finance asks, anyone but the CEO is refused, the CEO approves: Dr 6160 / Cr 1110 with the brand; written_off and out of aging', async () => {
    const i = await raise('finA')
    const r = (await request('finA', i.id, 115_000)).json() as Row
    for (const who of ['finA', 'mgmtA']) {
      const no = await call(who, 'POST', `${WO}/${r.id}/approve`, {})
      expect(no.statusCode, who).toBe(403)
      expect((await call(who, 'POST', `${WO}/${r.id}/reject`, { note: 'not me' })).statusCode).toBe(403)
    }
    expect((await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('requested')

    const ok = await call('ceoA', 'POST', `${WO}/${r.id}/approve`, { note: 'Agreed — two years overdue' })
    expect(ok.statusCode, ok.body).toBe(200)
    const row = ok.json() as Row
    expect(row).toMatchObject({ status: 'approved', decidedById: userId.ceoA, canApprove: false, canRecover: true })
    const lines = (await entry(tenantA, `receivable.write_off:${r.id}`))!
    expect(lines).toHaveLength(2)
    expect(lines.find((l) => l.code === '6160')).toMatchObject({ type: 'debit', amount: 115_000, conceptId: conceptA })
    expect(lines.find((l) => l.code === '1110')).toMatchObject({ type: 'credit', amount: 115_000, conceptId: conceptA })
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: tenantA, reference: `receivable.write_off:${r.id}` } })
    expect(row.journalEntryId).toBe(je.id)

    const after = await inv(i.id)
    expect(after.status).toBe('written_off')
    expect(Number(after.writtenOffCents)).toBe(115_000)
    const list = (await call('finA', 'GET', `${AR}?status=outstanding`)).json() as { invoices: Array<{ id: string }>; aging: Record<string, number> }
    expect(list.invoices.some((x) => x.id === i.id)).toBe(false)
    const all = (await call('finA', 'GET', `${AR}?status=written_off`)).json() as { invoices: Array<{ id: string; balanceCents: number; bucket: string | null; writeOffs: Array<{ id: string }>; canRequestWriteOff: boolean }> }
    const listed = all.invoices.find((x) => x.id === i.id)!
    expect(listed).toMatchObject({ balanceCents: 0, bucket: null, canRequestWriteOff: false })
    expect(listed.writeOffs.map((w) => w.id)).toEqual([r.id])
    // A payment on the written-off part is refused: that is a recovery.
    const pay = await call('finA', 'POST', `${AR}/${i.id}/payments`, { amountCents: 1_000, receivedAt: today(), method: 'cash' })
    expect(pay.statusCode).toBe(409)
    // Approving twice changes nothing.
    expect((await call('ceoA', 'POST', `${WO}/${r.id}/approve`, {})).json().error.code).toBe('WRITE_OFF_NOT_PENDING')
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `receivable.write_off:${r.id}` } })).toBe(1)
    // An invoice with a write-off on it cannot be voided.
    const v = await call('finA', 'POST', `${AR}/${i.id}/void`, { reason: 'try to void' })
    expect(v.statusCode).toBe(409)
    expect(v.json().error.code).toBe('CANNOT_VOID')
  })

  it('a write-off the CEO raises applies at once', async () => {
    const i = await raise('ceoA')
    const res = await request('ceoA', i.id, 40_000)
    expect(res.statusCode, res.body).toBe(201)
    const row = res.json() as Row
    expect(row).toMatchObject({ status: 'approved', decidedById: userId.ceoA })
    expect(amt((await entry(tenantA, `receivable.write_off:${row.id}`))!, '6160', 'debit')).toBe(40_000)
    const after = await inv(i.id)
    // Partly written off, the rest still owed: partial, still aging.
    expect(after.status).toBe('partial')
    expect(Number(after.writtenOffCents)).toBe(40_000)
    const list = (await call('finA', 'GET', `${AR}?status=outstanding`)).json() as { invoices: Array<{ id: string; balanceCents: number; canRequestWriteOff: boolean }> }
    expect(list.invoices.find((x) => x.id === i.id)).toMatchObject({ balanceCents: 75_000, canRequestWriteOff: true })
  })

  it('a payment after the request leaves too little to write off: 409 and nothing changes; reject and cancel', async () => {
    const i = await raise('finA')
    const r = (await request('finA', i.id, 115_000)).json() as Row
    expect((await call('finA', 'POST', `${AR}/${i.id}/payments`, { amountCents: 50_000, receivedAt: today(), method: 'cash' })).statusCode).toBe(201)
    const no = await call('ceoA', 'POST', `${WO}/${r.id}/approve`, {})
    expect(no.statusCode).toBe(409)
    expect(no.json().error.code).toBe('WRITE_OFF_EXCEEDS_BALANCE')
    expect((await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('requested')
    expect(Number((await inv(i.id)).writtenOffCents)).toBe(0)
    expect(await entry(tenantA, `receivable.write_off:${r.id}`)).toBeNull()

    expect((await call('ceoA', 'POST', `${WO}/${r.id}/reject`, {})).statusCode).toBe(400)
    const rej = await call('ceoA', 'POST', `${WO}/${r.id}/reject`, { note: 'Ask for the rest first' })
    expect(rej.statusCode, rej.body).toBe(200)
    expect(rej.json()).toMatchObject({ status: 'rejected', canApprove: false, canCancel: false })

    const r2 = (await request('finA', i.id, 65_000)).json() as Row
    expect((await call('finA', 'POST', `${WO}/${r2.id}/cancel`, { note: 'Client paid after all' })).json()).toMatchObject({ status: 'cancelled' })
    expect((await call('ceoA', 'POST', `${WO}/${r2.id}/approve`, {})).statusCode).toBe(409)
    expect(Number((await inv(i.id)).writtenOffCents)).toBe(0)
  })

  it('a period closed through today: 422 and nothing saved', async () => {
    const i = await raise('finA')
    const r = (await request('finA', i.id, 115_000)).json() as Row
    const lock = await prisma.periodLock.create({
      data: { tenantId: tenantA, lockedThrough: new Date(Date.now() + 2 * 86_400_000), lockedBy: userId.ceoA! },
    })
    try {
      const res = await call('ceoA', 'POST', `${WO}/${r.id}/approve`, {})
      expect(res.statusCode).toBe(422)
      expect(res.json().error.code).toBe('PERIOD_LOCKED')
      expect((await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('requested')
      expect(Number((await inv(i.id)).writtenOffCents)).toBe(0)
      expect((await inv(i.id)).status).toBe('open')
      expect(await entry(tenantA, `receivable.write_off:${r.id}`)).toBeNull()
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
    expect((await call('ceoA', 'POST', `${WO}/${r.id}/approve`, {})).statusCode).toBe(200)
  })
})

// ─── Recovery ───────────────────────────────────────────────────────────────

describe('money received after a write-off', () => {
  it('a recovery reinstates and pays; never more than written off; a bounced recovery is written off again', async () => {
    const i = await raise('finA')
    const w = (await request('ceoA', i.id, 115_000)).json() as Row
    expect(w.status).toBe('approved')

    const foreignBank = await call('finA', 'POST', `${WO}/${w.id}/recover`, { amountCents: 40_000, receivedAt: today(), method: 'bank', bankAccountId: bankB })
    expect(foreignBank.statusCode).toBe(422)
    expect(foreignBank.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(await prisma.receivablePayment.count({ where: { invoiceId: i.id } })).toBe(0)

    const first = await call('finA', 'POST', `${WO}/${w.id}/recover`, { amountCents: 40_000, receivedAt: today(), method: 'bank', bankAccountId: bankA, reference: 'TT-77' })
    expect(first.statusCode, first.body).toBe(201)
    const p1 = first.json().payment as { id: string; writeOffId: string; bankAccountId: string }
    expect(p1).toMatchObject({ writeOffId: w.id, bankAccountId: bankA })
    expect(first.json().writeOff).toMatchObject({ recoveredCents: 40_000, canRecover: true })
    const rec = (await entry(tenantA, `receivable.write_off_recovery:${p1.id}`))!
    expect(amt(rec, '1110', 'debit')).toBe(40_000)
    expect(amt(rec, '6160', 'credit')).toBe(40_000)
    expect(rec.every((l) => l.conceptId === conceptA)).toBe(true)
    const pay = (await entry(tenantA, `receivable.payment:${p1.id}`))!
    expect(amt(pay, '1020', 'debit')).toBe(40_000)
    expect(amt(pay, '1110', 'credit')).toBe(40_000)
    let now = await inv(i.id)
    expect([Number(now.paidCents), Number(now.writtenOffCents), now.status]).toEqual([40_000, 75_000, 'written_off'])

    const over = await call('finA', 'POST', `${WO}/${w.id}/recover`, { amountCents: 75_001, receivedAt: today(), method: 'cash' })
    expect(over.statusCode).toBe(409)
    expect(over.json().error.code).toBe('OVER_RECOVERY')

    const rest = await call('mgmtA', 'POST', `${WO}/${w.id}/recover`, { amountCents: 75_000, receivedAt: today(), method: 'cash' })
    expect(rest.statusCode, rest.body).toBe(201)
    expect(rest.json().writeOff).toMatchObject({ recoveredCents: 115_000, canRecover: false })
    now = await inv(i.id)
    expect([Number(now.paidCents), Number(now.writtenOffCents), now.status]).toEqual([115_000, 0, 'paid'])

    // The first recovery's transfer is recalled: written off again, both entries reversed.
    const rev = await call('finA', 'POST', `${AR}/${i.id}/payments/${p1.id}/reverse`, { reason: 'transfer recalled by the bank' })
    expect(rev.statusCode, rev.body).toBe(200)
    expect(rev.json().alreadyReversed).toBe(false)
    now = await inv(i.id)
    expect([Number(now.paidCents), Number(now.writtenOffCents), now.status]).toEqual([75_000, 40_000, 'written_off'])
    expect(Number((await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: w.id } })).recoveredCents)).toBe(75_000)
    const revRec = (await entry(tenantA, `receivable.write_off_recovery.reversal:${p1.id}`))!
    expect(amt(revRec, '6160', 'debit')).toBe(40_000)
    expect(amt(revRec, '1110', 'credit')).toBe(40_000)
    const revPay = (await entry(tenantA, `receivable.payment.reversal:${p1.id}`))!
    expect(amt(revPay, '1110', 'debit')).toBe(40_000)
    expect(amt(revPay, '1020', 'credit')).toBe(40_000)
    // Idempotent.
    const twice = await call('finA', 'POST', `${AR}/${i.id}/payments/${p1.id}/reverse`, { reason: 'transfer recalled by the bank' })
    expect(twice.json().alreadyReversed).toBe(true)
    expect(Number((await inv(i.id)).writtenOffCents)).toBe(40_000)
    // The recalled 40,000 can be recovered again later.
    const again = await call('finA', 'POST', `${WO}/${w.id}/recover`, { amountCents: 40_000, receivedAt: today(), method: 'cash' })
    expect(again.statusCode, again.body).toBe(201)
    expect([Number((await inv(i.id)).writtenOffCents), (await inv(i.id)).status]).toEqual([0, 'paid'])
  })

  it('only an approved write-off can be recovered', async () => {
    const i = await raise('finA')
    const r = (await request('finA', i.id, 10_000)).json() as Row
    const res = await call('finA', 'POST', `${WO}/${r.id}/recover`, { amountCents: 1_000, receivedAt: today(), method: 'cash' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('WRITE_OFF_NOT_APPROVED')
    await call('finA', 'POST', `${WO}/${r.id}/cancel`, {})
  })
})

// ─── Capability flags ───────────────────────────────────────────────────────

describe('what each role may do comes from the server', () => {
  it('flags per role on the list, before and after approval', async () => {
    const i = await raise('finA')
    const r = (await request('mgmtA', i.id, 20_000)).json() as Row
    const rowFor = async (who: string) =>
      ((await call(who, 'GET', `${WO}?invoiceId=${i.id}`)).json() as { items: Row[] }).items.find((x) => x.id === r.id)!
    expect(await rowFor('ceoA')).toMatchObject({ canApprove: true, canReject: true, canCancel: true, canRecover: false })
    expect(await rowFor('finA')).toMatchObject({ canApprove: false, canReject: false, canCancel: true, canRecover: false })
    // The requests list the inbox reads.
    const pending = (await call('ceoA', 'GET', `${WO}?status=requested`)).json() as { items: Row[] }
    expect(pending.items.some((x) => x.id === r.id)).toBe(true)
    expect(pending.items.every((x) => x.status === 'requested')).toBe(true)
    expect((await call('ceoA', 'GET', `${WO}?status=bogus`)).statusCode).toBe(400)

    expect((await call('ceoA', 'POST', `${WO}/${r.id}/approve`, {})).statusCode).toBe(200)
    expect(await rowFor('ceoA')).toMatchObject({ canApprove: false, canReject: false, canCancel: false, canRecover: true })
    expect(await rowFor('finA')).toMatchObject({ canApprove: false, canCancel: false, canRecover: true })
    // A financials viewer who may not request (the F&B manager) sees it and may do nothing.
    expect(await rowFor('fnbA')).toMatchObject({ canApprove: false, canReject: false, canCancel: false, canRecover: false })
    expect((await call('fnbA', 'POST', `${WO}/${r.id}/recover`, { amountCents: 1_000, receivedAt: today(), method: 'cash' })).statusCode).toBe(403)
  })
})

// ─── Two companies ──────────────────────────────────────────────────────────

describe('company B never touches company A\'s write-offs', () => {
  it('every write-off route on A\'s rows is 404 for B; B\'s list does not show them', async () => {
    const i = await raise('finA')
    const r = (await request('finA', i.id, 30_000)).json() as Row
    const applied = (await request('ceoA', (await raise('ceoA')).id, 10_000)).json() as Row
    for (const who of ['ceoB', 'finB']) {
      expect((await request(who, i.id, 1_000)).statusCode, who).toBe(404)
      expect((await call(who, 'GET', `${WO}/${r.id}/evidence/${r.attachments[0]!.id}`)).statusCode).toBe(404)
      expect((await call(who, 'POST', `${WO}/${r.id}/cancel`, {})).statusCode).toBe(404)
      expect((await call(who, 'POST', `${WO}/${applied.id}/recover`, { amountCents: 1_000, receivedAt: today(), method: 'cash' })).statusCode).toBe(404)
      const list = (await call(who, 'GET', WO)).json() as { items: Row[] }
      expect(list.items.some((x) => x.tenantId === tenantA)).toBe(false)
    }
    expect((await call('ceoB', 'POST', `${WO}/${r.id}/approve`, {})).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `${WO}/${r.id}/reject`, { note: 'not mine' })).statusCode).toBe(404)
    expect((await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('requested')
    expect(Number((await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: applied.id } })).recoveredCents)).toBe(0)
    // An evidence id of another write-off under this one's path is 404 too.
    expect((await call('finA', 'GET', `${WO}/${applied.id}/evidence/${r.attachments[0]!.id}`)).statusCode).toBe(404)
  })

  it('a write-off belongs to the invoice\'s company, whatever company the requester is working in', async () => {
    const bInv = await raise('finB', { conceptId: conceptB })
    const res = await request('finAB', bInv.id, 5_000)
    expect(res.statusCode, res.body).toBe(201)
    const row = res.json() as Row
    expect(row.tenantId).toBe(tenantB)
    const files = await prisma.receivableWriteOffAttachment.findMany({ where: { writeOffId: row.id } })
    expect(files.every((f) => f.tenantId === tenantB)).toBe(true)
    const log = await prisma.auditLog.findFirst({ where: { action: 'receivable.write_off.request', entityId: row.id } })
    expect(log?.tenantId).toBe(tenantB)
    expect((await call('ceoB', 'POST', `${WO}/${row.id}/approve`, {})).statusCode).toBe(200)
    const lines = (await entry(tenantB, `receivable.write_off:${row.id}`))!
    expect(amt(lines, '6160', 'debit')).toBe(5_000)
    expect(lines.find((l) => l.code === '6160')!.conceptId).toBe(conceptB)
    expect(await entry(tenantA, `receivable.write_off:${row.id}`)).toBeNull()
  })
})

// ─── A credit note after a write-off ────────────────────────────────────────

describe('a credit note after a write-off', () => {
  it('can never credit the written-off part (409 WRITTEN_OFF_FIRST); the rest still credits and a refund stays capped at what is owed back', async () => {
    const i = await raise('finA')                                          // 100,000 + 15,000
    expect((await call('finA', 'POST', `${AR}/${i.id}/payments`, { amountCents: 57_500, receivedAt: today(), method: 'cash' })).statusCode).toBe(201)
    const w = await request('ceoA', i.id, 57_500)                           // the CEO's own request applies at once
    expect(w.statusCode, w.body).toBe(201)
    expect(Number((await inv(i.id)).writtenOffCents)).toBe(57_500)

    // Only the part not written off (57,500 — here the paid half) can be credited; the old cap allowed the whole 115,000.
    const over = await call('finA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 50_000, taxCents: 10_000, reason: 'disputed half', date: today() })
    expect(over.statusCode, over.body).toBe(409)
    expect(over.json().error.code).toBe('WRITTEN_OFF_FIRST')
    expect(over.json().error.details.leftCents).toBe(57_500)
    expect(Number((await inv(i.id)).creditedCents)).toBe(0)
    expect(await prisma.receivableInvoice.count({ where: { originalInvoiceId: i.id, kind: 'credit_note' } })).toBe(0)

    // The part that was not written off (it was paid) still credits; the customer is then in credit by that much only.
    const ok = await call('finA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 10_000, taxCents: 1_500, reason: 'late delivery discount', date: today() })
    expect(ok.statusCode, ok.body).toBe(201)
    const tooMuch = await call('finA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 40_000, taxCents: 7_000, reason: 'more', date: today() })
    expect(tooMuch.json().error.code).toBe('WRITTEN_OFF_FIRST')
    const refund = await call('finA', 'POST', `${AR}/${i.id}/refunds`, { amountCents: 11_501, date: today(), method: 'cash' })
    expect(refund.statusCode).toBe(409)
    expect((await call('finA', 'POST', `${AR}/${i.id}/refunds`, { amountCents: 11_500, date: today(), method: 'cash' })).statusCode).toBe(201)
  })
})

// ─── The subledger still ties to 1110 ───────────────────────────────────────

describe('the AR subledger ties to the 1110 balance', () => {
  it('Σ balances of A\'s invoices = A\'s 1110 net debit, write-offs and recoveries included', async () => {
    const list = (await call('finA', 'GET', AR)).json() as { invoices: Array<{ kind: string; balanceCents: number }>; outstandingCents: number; creditBalanceCents: number }
    const sum = list.invoices.filter((r) => r.kind === 'invoice').reduce((t, r) => t + r.balanceCents, 0)
    expect(await netDebit(tenantA, '1110')).toBe(sum)
    // 6160 net = everything written off − everything recovered, in A.
    const wos = await prisma.receivableWriteOff.findMany({ where: { tenantId: tenantA, status: 'approved' } })
    const expected6160 = wos.reduce((t, w) => t + Number(w.amountCents) - Number(w.recoveredCents), 0)
    expect(await netDebit(tenantA, '6160')).toBe(expected6160)
  })
})
