// "Resolved by journal entry" + the close block (owner, Ammar, CEO,
// 2026-10-16: "add the resolved button, and make it block the close").
//
//   - A voucher still HELD on 1357 that the conversion cannot book is cleared
//     by a manual journal (Dr the right account / Cr 1357) and marked done with
//     POST /trustops/cash-vouchers/:id/resolve-by-journal — finance (with
//     accounting) or the CEO, never the raiser / holder; posts NOTHING.
//   - The entry: the voucher's company's (else 404), manual, live, dated on or
//     after the hold, crediting 1357 by exactly the held amount under the
//     hold's brand; one entry resolves one voucher; twice → 409.
//   - After: bookedAtPay, postedJournalEntryId = the entry, the
//     'cash_voucher_hold_unconverted' flag resolved, history + audit rows; the
//     documents check then books nothing; the entry cannot be reversed.
//   - Close check 'vouchers_held_on_1357': BLOCK (CEO-overridable), per company.
//
// Needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
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
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { reverseManualJournal } from '../src/modules/accounting/manualJournal.js'
import { CLOSE_CHECKS, isOverridableKey } from '../src/modules/accounting/closeChecks.js'
import { convertHeldVoucher, HOLD_UNCONVERTED_KIND } from '../src/modules/trustops/voucherHoldConversion.js'

const P = `vhr${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const C: Record<'A' | 'B', string> = { A: '', B: '' }
const box: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const seq: Record<'A' | 'B', number> = { A: 0, B: 0 }
const V = '/trustops/cash-vouchers'

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@vhr.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const call = (key: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }, ...(payload !== undefined && { payload: payload as object }) })
const codeOf = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code

/** A voucher as the 2026-10-15 hold flow left it, paid from a box: Dr 1357 / Cr 1011 — equipment-looking, so it never converts. */
async function held(co: 'A' | 'B', amountCents: number, raiser = 'cook' + co, purpose = 'New blender for the kitchen') {
  seq[co]++
  const userId = U[raiser]!.id
  return prisma.$transaction(async (tx) => {
    const v = await tx.cashVoucher.create({
      data: {
        tenantId: T[co], seq: seq[co], number: `CV-${String(seq[co]).padStart(5, '0')}`, voucherDate: new Date(), payeeName: 'Holder',
        payeeUserId: userId, purpose, category: 'transport', conceptId: C[co], amountCents, status: 'disbursed', preparedById: userId,
        disbursedAt: new Date(), disbursedById: userId, boxId: box[co], expenseOnVerify: true, bookedAtPay: false, paySource: 'box',
        cashReceivedAt: new Date(), cashReceivedById: userId,
      },
    })
    const m = await tx.pettyCashMovement.create({
      data: {
        boxId: box[co], tenantId: T[co], type: 'spend', amountCents: -amountCents, reason: `Cash voucher ${v.number}: ${purpose}`,
        createdById: userId, source: 'box', accountCode: '1357', cashVoucherId: v.id, conceptId: C[co],
      },
    })
    const je = await postJournalEntry({
      tenantId: T[co], sourceType: 'pettycash.spend', sourceId: m.id, description: 'Cash voucher paid (held)', postedBy: userId, entryDate: new Date(),
      lines: [
        { accountCode: '1357', type: 'debit', amountCents, conceptId: C[co] },
        { accountCode: '1011', type: 'credit', amountCents, conceptId: C[co] },
      ],
    }, { tx })
    await tx.pettyCashMovement.update({ where: { id: m.id }, data: { journalEntryId: je.entryId } })
    return tx.cashVoucher.update({ where: { id: v.id }, data: { pettyCashMovementId: m.id } })
  })
}

/** A manual journal (as POST /accounting/journal books it): Dr `debit` / Cr 1357. */
async function manual(co: 'A' | 'B', amountCents: number, opts: { conceptId?: string | null; entryDate?: Date; debit?: string } = {}) {
  const concept = opts.conceptId === undefined ? C[co] : opts.conceptId
  const r = await postJournalEntry({
    tenantId: T[co], sourceType: 'manual', sourceId: randomUUID(), description: 'Correct held voucher', postedBy: U[`fin${co}`]!.id,
    entryDate: opts.entryDate ?? new Date(),
    lines: [
      { accountCode: opts.debit ?? '6170', type: 'debit', amountCents, conceptId: concept },
      { accountCode: '1357', type: 'credit', amountCents, conceptId: concept },
    ],
  })
  return r.entryId
}

const resolve = (who: string, id: string, journalEntryId: string, note = 'Booked to office expense by manual journal') =>
  call(who, 'POST', `${V}/${id}/resolve-by-journal`, { journalEntryId, note })

const closeCtx = (tenantId: string, newLock = new Date(Date.now() + 86_400_000)) =>
  ({ db: prisma, tenantId, prevLock: null, newLock, months: [], isYearEnd: false }) as Parameters<(typeof CLOSE_CHECKS)[number]['run']>[0]
const heldCheck = () => CLOSE_CHECKS.find((c) => c.key === 'vouchers_held_on_1357')!

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Resolve Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Resolve Co B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await ensureChartOfAccounts(T.B)
  invalidateSetupCache()
  C.A = (await prisma.concept.create({ data: { name: `${P} brand A`, slug: `${P}-brand-a`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} brand B`, slug: `${P}-brand-b`, type: 'restaurant', tenantId: T.B } })).id
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('finA2', 'finance', [T.A])
  await mkUser('finB', 'finance', [T.B])
  await mkUser('cookA', 'boh', [T.A])
  await mkUser('cookB', 'boh', [T.B])
  box.A = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'A box', custodianId: U['finA']!.id, floatCents: 1_000_000, topUpLimitCents: 100_000_000 } })).id
  box.B = (await prisma.pettyCashBox.create({ data: { tenantId: T.B, name: 'B box', custodianId: U['finB']!.id, floatCents: 1_000_000, topUpLimitCents: 100_000_000 } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => { await api.register(trustopsRoutes, { prefix: '/trustops' }) }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

describe('resolve a held voucher by a manual journal entry', () => {
  it('the close BLOCKS while a voucher is held on 1357 (CEO-overridable), only in its company', async () => {
    const check = heldCheck()
    expect(check).toMatchObject({ severity: 'block', overridable: true })
    expect(isOverridableKey('vouchers_held_on_1357')).toBe(true)
    expect(await check.run(closeCtx(T.A))).toBeNull()
    const v = await held('A', 4_000)
    const a = await check.run(closeCtx(T.A))
    expect(a).toMatchObject({ key: 'vouchers_held_on_1357', severity: 'block', overridable: true, count: 1, cents: 4_000 })
    expect(a!.detail).toContain(v.number)
    expect(a!.detail).toContain('Resolved by journal entry')
    expect(a!.link).toBe(`/finance/cash-vouchers/${v.id}`)
    expect(await check.run(closeCtx(T.B))).toBeNull()
    // Paid after the lock: not this period's.
    expect(await check.run(closeCtx(T.A, new Date(Date.now() - 2 * 86_400_000)))).toBeNull()
    // The warn-only documents check stays a separate key.
    expect(CLOSE_CHECKS.find((c) => c.key === 'vouchers_awaiting_docs')).toMatchObject({ severity: 'warn' })
    // Tidy: resolve it so later tests count their own.
    const je = await manual('A', 4_000)
    expect((await resolve('finA', v.id, je)).statusCode).toBe(200)
    expect(await check.run(closeCtx(T.A))).toBeNull()
  })

  it('who: finance or the CEO, never the raiser / holder; another company → 404; a short note → 400', async () => {
    const v = await held('A', 2_500)
    const own = await held('A', 2_600, 'finA2')
    const je = await manual('A', 2_500)
    expect((await call('finA', 'GET', `${V}/${v.id}`)).json()).toMatchObject({ canResolveByJournal: true })
    expect((await call('finA2', 'GET', `${V}/${own.id}`)).json()).toMatchObject({ canResolveByJournal: false })
    expect(codeOf(await resolve('cookA', v.id, je))).toBe('NOT_FINANCE')
    expect((await resolve('cookA', v.id, je)).statusCode).toBe(403)
    const ownEntry = await manual('A', 2_600)
    const self = await resolve('finA2', own.id, ownEntry)
    expect(self.statusCode).toBe(409)
    expect(codeOf(self)).toBe('SELF_APPROVE')
    expect((await resolve('finB', v.id, je)).statusCode).toBe(404)
    expect((await call('finB', 'GET', `${V}/${v.id}/resolve-candidates`)).statusCode).toBe(404)
    expect((await call('finA', 'POST', `${V}/${v.id}/resolve-by-journal`, { journalEntryId: je, note: 'short' })).statusCode).toBe(400)
    // The CEO may; another finance person resolves the one finA2 raised.
    const r = await resolve('ceoA', v.id, je)
    expect(r.statusCode, r.body).toBe(200)
    expect((await resolve('finA', own.id, ownEntry)).statusCode).toBe(200)
  })

  it('the entry: manual, live, the voucher company\'s, on/after the hold, exact 1357 credit under the hold\'s brand', async () => {
    const v = await held('A', 3_000)
    // Another company's entry: 404, never confirms it exists.
    expect((await resolve('finA', v.id, await manual('B', 3_000))).statusCode).toBe(404)
    // The hold's own (non-manual) entry.
    const holdEntry = (await prisma.pettyCashMovement.findUniqueOrThrow({ where: { id: v.pettyCashMovementId! } })).journalEntryId!
    expect(codeOf(await resolve('finA', v.id, holdEntry))).toBe('NOT_A_MANUAL_ENTRY')
    expect(codeOf(await resolve('finA', v.id, await manual('A', 2_999)))).toBe('ENTRY_AMOUNT_MISMATCH')
    expect(codeOf(await resolve('finA', v.id, await manual('A', 3_000, { conceptId: null })))).toBe('ENTRY_BRAND_MISMATCH')
    expect(codeOf(await resolve('finA', v.id, await manual('A', 3_000, { entryDate: new Date(Date.now() - 3 * 86_400_000) })))).toBe('ENTRY_BEFORE_HOLD')
    const reversed = await manual('A', 3_000)
    await reverseManualJournal(prisma, { tenantId: T.A, entryId: reversed, reason: 'Wrong account', actorId: U['finA']!.id })
    expect(codeOf(await resolve('finA', v.id, reversed))).toBe('ENTRY_REVERSED')
    expect((await resolve('finA', v.id, 'no-such-entry')).statusCode).toBe(404)
    // Still held after every refusal.
    expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ bookedAtPay: false, postedJournalEntryId: null })
    // Tidy: resolved by the right entry.
    expect((await resolve('finA', v.id, await manual('A', 3_000))).statusCode).toBe(200)
  })

  it('resolves: posts nothing, links the entry, resolves the flag, audited; twice / reused / reversal → 409; documents check books nothing', async () => {
    const v = await held('A', 5_500)
    // The boot conversion refuses it (equipment) and flags it.
    expect(await convertHeldVoucher(v.id)).toMatchObject({ outcome: 'refused', code: 'USE_CAPEX' })
    const other = await manual('A', 5_500, { debit: '6990' })
    const je = await manual('A', 5_500)
    const cand = (await call('finA', 'GET', `${V}/${v.id}/resolve-candidates`)).json() as { heldCents: number; items: Array<{ id: string; matches: boolean; creditCents: number }> }
    expect(cand.heldCents).toBe(5_500)
    expect(cand.items.map((i) => i.id)).toEqual(expect.arrayContaining([je, other]))
    expect(cand.items.find((i) => i.id === je)).toMatchObject({ matches: true, creditCents: 5_500 })

    const entries = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const r = await resolve('finA', v.id, je)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ entryId: je, amountCents: 5_500 })
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entries)
    expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ bookedAtPay: true, postedJournalEntryId: je, status: 'disbursed' })
    expect(await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: HOLD_UNCONVERTED_KIND, entityId: v.id } })).toMatchObject({ status: 'resolved', resolvedById: U['finA']!.id })
    const hist = (await call('finA', 'GET', `${V}/${v.id}/history`)).json() as { items: Array<{ action: string; after: Record<string, unknown> }> }
    expect(hist.items.find((h) => h.action === 'resolve_by_journal')?.after).toMatchObject({ journalEntryId: je, amountCents: 5_500 })
    expect(await prisma.auditLog.count({ where: { action: 'cash_voucher.hold_resolved_by_journal', entityId: je, tenantId: T.A } })).toBe(1)

    // Twice → 409; the entry never resolves a second voucher.
    expect(codeOf(await resolve('finA', v.id, je))).toBe('VOUCHER_NOT_HELD')
    const v2 = await held('A', 5_500)
    const reuse = await resolve('finA', v2.id, je)
    expect(reuse.statusCode).toBe(409)
    expect(codeOf(reuse)).toBe('JOURNAL_ALREADY_USED')
    // The resolving entry cannot be reversed (or edited) underneath the voucher.
    await expect(reverseManualJournal(prisma, { tenantId: T.A, entryId: je, reason: 'Undo it', actorId: U['finA']!.id }))
      .rejects.toMatchObject({ code: 'ENTRY_RESOLVES_VOUCHER' })
    // The documents check then books nothing.
    const beforeCheck = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    await prisma.cashVoucherAttachment.create({
      data: { voucherId: v.id, tenantId: T.A, kind: 'supporting', mime: 'application/pdf', fileName: 'bill.pdf', sizeBytes: 4, data: Buffer.from('%PDF'), uploadedById: U['cookA']!.id },
    })
    const ver = await call('finA', 'POST', `${V}/${v.id}/verify-docs`, {})
    expect(ver.statusCode, ver.body).toBe(200)
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(beforeCheck)
    expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ status: 'posted', postedJournalEntryId: je })
    // v2 resolved by its own entry; the company's 1357 is back to zero.
    expect((await resolve('finA', v2.id, other)).statusCode).toBe(200)
    expect(await heldCheck().run(closeCtx(T.A))).toBeNull()
  })

  it('company B: its own held voucher blocks only B; resolved by B\'s entry', async () => {
    const v = await held('B', 1_800)
    expect(await heldCheck().run(closeCtx(T.B))).toMatchObject({ count: 1, cents: 1_800 })
    expect(await heldCheck().run(closeCtx(T.A))).toBeNull()
    expect((await resolve('finA', v.id, await manual('A', 1_800))).statusCode).toBe(404)
    const r = await resolve('finB', v.id, await manual('B', 1_800))
    expect(r.statusCode, r.body).toBe(200)
    expect(await heldCheck().run(closeCtx(T.B))).toBeNull()
  })

  it('gate: cleared only by an entry dated AFTER the lock still blocks that close; a held row with no pay date blocks', async () => {
    const DAY = 86_400_000
    const v = await held('A', 2_600)
    const later = await manual('A', 2_600, { entryDate: new Date(Date.now() + 3 * DAY) })
    expect((await resolve('finA', v.id, later)).statusCode).toBe(200)
    const late = await heldCheck().run(closeCtx(T.A, new Date(Date.now() + DAY)))
    expect(late).toMatchObject({ key: 'vouchers_held_on_1357', count: 1, cents: 2_600 })
    expect(late!.detail).toContain('dated after')
    expect(await heldCheck().run(closeCtx(T.A, new Date(Date.now() + 4 * DAY)))).toBeNull()
    expect(await heldCheck().run(closeCtx(T.B, new Date(Date.now() + DAY)))).toBeNull()

    const w = await held('A', 1_300)
    await prisma.cashVoucher.update({ where: { id: w.id }, data: { disbursedAt: null } })
    expect(await heldCheck().run(closeCtx(T.A, new Date(Date.now() + 4 * DAY)))).toMatchObject({ count: 1, cents: 1_300 })
    expect((await resolve('finA', w.id, await manual('A', 1_300))).statusCode).toBe(200)
    expect(await heldCheck().run(closeCtx(T.A, new Date(Date.now() + 4 * DAY)))).toBeNull()
  })
})
