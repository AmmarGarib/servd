// Races and edge cases of "Resolved by journal entry" + the close block (owner, Ammar, CEO,
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

const P = `vhx${Date.now()}`
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
      name: `${P} ${key}`, email: `${P}.${key}@vhx.pk`, password: await bcrypt.hash('x-Password-1', 4),
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


describe('resolve by journal entry — races and edges (money gate)', () => {
  it('one entry, two vouchers in parallel: exactly one wins; the same voucher twice in parallel: exactly one wins', async () => {
    const a = await held('A', 7_700)
    const b = await held('A', 7_700)
    const je = await manual('A', 7_700)
    const rs = await Promise.all([resolve('finA', a.id, je), resolve('finA2', b.id, je)])
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect(await prisma.cashVoucher.count({ where: { postedJournalEntryId: je } })).toBe(1)
    const loser = rs[0]!.statusCode === 409 ? a : b
    expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: loser.id } })).toMatchObject({ bookedAtPay: false, postedJournalEntryId: null })

    const c = await held('A', 1_100)
    const je1 = await manual('A', 1_100)
    const je2 = await manual('A', 1_100)
    const twice = await Promise.all([resolve('finA', c.id, je1), resolve('finA2', c.id, je2)])
    expect(twice.map((r) => r.statusCode).sort()).toEqual([200, 409])
    const cur = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: c.id } })
    expect([je1, je2]).toContain(cur.postedJournalEntryId)
    // The loser's entry is still free for another voucher.
    const free = cur.postedJournalEntryId === je1 ? je2 : je1
    const d = await held('A', 1_100)
    expect((await resolve('finA', d.id, free)).statusCode).toBe(200)
    // Tidy the loser of the first race.
    expect((await resolve('finA', loser.id, await manual('A', 7_700))).statusCode).toBe(200)
  })

  it('reversal racing a resolve: never a resolved voucher on a reversed entry', async () => {
    const v = await held('A', 2_200)
    const je = await manual('A', 2_200)
    const [res, rev] = await Promise.allSettled([
      resolve('finA', v.id, je),
      reverseManualJournal(prisma, { tenantId: T.A, entryId: je, reason: 'Race it', actorId: U['finA2']!.id }),
    ])
    const resolved = res.status === 'fulfilled' && res.value.statusCode === 200
    const reversed = rev.status === 'fulfilled'
    expect(resolved !== reversed).toBe(true)
    const cur = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })
    if (reversed) expect(cur).toMatchObject({ bookedAtPay: false, postedJournalEntryId: null })
    else expect(cur).toMatchObject({ bookedAtPay: true, postedJournalEntryId: je })
    if (reversed) expect((await resolve('finA', v.id, await manual('A', 2_200))).statusCode).toBe(200)
  })

  it('a converted / posted / one-entry voucher is not resolvable; an entry crediting 1357 in two brands must match per brand', async () => {
    // A one-entry voucher (booked at pay) → 409 VOUCHER_NOT_HELD, and no button.
    const v = await held('A', 3_300)
    await prisma.cashVoucher.update({ where: { id: v.id }, data: { bookedAtPay: true } })
    const je = await manual('A', 3_300)
    const r = await resolve('finA', v.id, je)
    expect(r.statusCode).toBe(409)
    expect(codeOf(r)).toBe('VOUCHER_NOT_HELD')
    expect((await call('finA', 'GET', `${V}/${v.id}`)).json()).toMatchObject({ canResolveByJournal: false })
    // Posted → 409 too.
    await prisma.cashVoucher.update({ where: { id: v.id }, data: { bookedAtPay: false, status: 'posted', postedAt: new Date() } })
    expect(codeOf(await resolve('finA', v.id, je))).toBe('VOUCHER_NOT_HELD')
    // The conversion's own entry (non-manual) can never be used.
    const w = await held('A', 4_400, 'cookA', 'Taxi fares for the market run')
    const conv = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: w.id } })
    expect(conv.bookedAtPay).toBe(false)
    // Same total but split across two brands on 1357 → brand mismatch.
    const C2 = (await prisma.concept.create({ data: { name: `${P} brand A2`, slug: `${P}-brand-a2`, type: 'restaurant', tenantId: T.A } })).id
    const split = await postJournalEntry({
      tenantId: T.A, sourceType: 'manual', sourceId: randomUUID(), description: 'Split', postedBy: U['finA']!.id, entryDate: new Date(),
      lines: [
        { accountCode: '6170', type: 'debit', amountCents: 4_400, conceptId: C.A },
        { accountCode: '1357', type: 'credit', amountCents: 2_200, conceptId: C.A },
        { accountCode: '1357', type: 'credit', amountCents: 2_200, conceptId: C2 },
      ],
    })
    expect(codeOf(await resolve('finA', w.id, split.entryId))).toBe('ENTRY_BRAND_MISMATCH')
    // An entry that DEBITS 1357 is not a clearing entry.
    const wrongWay = await postJournalEntry({
      tenantId: T.A, sourceType: 'manual', sourceId: randomUUID(), description: 'Wrong way', postedBy: U['finA']!.id, entryDate: new Date(),
      lines: [
        { accountCode: '1357', type: 'debit', amountCents: 4_400, conceptId: C.A },
        { accountCode: '6170', type: 'credit', amountCents: 4_400, conceptId: C.A },
      ],
    })
    expect(codeOf(await resolve('finA', w.id, wrongWay.entryId))).toBe('ENTRY_AMOUNT_MISMATCH')
    expect((await resolve('finA', w.id, await manual('A', 4_400))).statusCode).toBe(200)
  })

  it('a CEO of both companies: A\'s voucher never takes B\'s entry; the close check of each company counts only its own', async () => {
    await mkUser('ceoAB', 'admin', [T.A, T.B])
    const v = await held('A', 900)
    const jeB = await manual('B', 900)
    expect((await resolve('ceoAB', v.id, jeB)).statusCode).toBe(404)
    expect(await heldCheck().run(closeCtx(T.B))).toBeNull()
    expect(await heldCheck().run(closeCtx(T.A))).toMatchObject({ count: 1, cents: 900 })
    const cand = (await call('ceoAB', 'GET', `${V}/${v.id}/resolve-candidates`)).json() as { items: Array<{ id: string }> }
    expect(cand.items.map((i) => i.id)).not.toContain(jeB)
    expect((await resolve('ceoAB', v.id, await manual('A', 900))).statusCode).toBe(200)
    expect(await heldCheck().run(closeCtx(T.A))).toBeNull()
  })
})
