// Sales-side finance fixes (finance audit, 2026-10-16; owner decisions):
//   1  a second deposit drop for the same shift no longer takes the shift's
//      safe drops (1010) again — each bag takes what EARLIER bags left;
//   2  late shift: a till closing before 05:00 PKT books to the business day
//      it opened on (lib/businessDay.ts) — the posting date, the night audit's
//      shift checks and activity days, and the close checklist's unposted tills;
//   14 one bank bag can be split across several shifts (deposit_drop_shifts);
//      the night audit's cash_not_banked compares AMOUNTS per shift;
//   28 a partial bag is compared with what is still to bank, and the bag that
//      completes the shift resolves the earlier variance flag;
//   29 the COD night block links to the till's pay-in list while code-only
//      delivery is off (Reconciliation → Cash on delivery is hidden then).
// Two companies: B never sees A's drops and cannot split onto A's shifts.
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
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { fmtPktDate, parsePktEndOfDay, parsePktStartOfDay } from '../src/modules/accounting/dates.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { dropAllocations, postDepositDrop, shiftShareSplit } from '../src/modules/accounting/depositPosting.js'
import { unpostedShiftRows } from '../src/modules/accounting/closeChecks.js'
import { cashNotBankedBetween, nightChecklist } from '../src/modules/nightAudit/checks.js'
import { activityDaysBetween } from '../src/modules/nightAudit/activity.js'
import { buildDailyReport } from '../src/modules/nightAudit/report.js'
import { salesBankUnmatchedBetween } from '../src/modules/reconciliation/service.js'
import { shiftBusinessDate, shiftBusinessDay } from '../src/lib/businessDay.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
const who: Record<string, { id: string; token: string }> = {}
interface Co { tenantId: string; bank: string; concept: string }
let A: Co, B: Co

const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:00`)

async function mkCo(name: string, slug: string): Promise<Co> {
  const tenantId = (await prisma.tenant.create({ data: { name, slug: `${slug}-${RUN}` } })).id
  await ensureChartOfAccounts(tenantId)
  const bank = (await prisma.bankAccount.create({ data: { tenantId, name: `HBL ${name}`, accountCode: '1020' } })).id
  const concept = (await prisma.concept.create({ data: { name: `${name} brand`, slug: `${slug}-brand-${RUN}`, type: 'restaurant', tenantId, taxRateCash: 15, taxRateCard: 8 } })).id
  return { tenantId, bank, concept }
}
async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@salesfix.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  who[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (w: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${who[w]!.token}` }, ...(payload !== undefined ? { payload: payload as never } : {}) })
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code

/** A closed till of `co`: `drops` taken to the safe mid-shift, `takings` counted at close (float 0). */
async function mkShift(co: Co, o: { drops?: number; takings: number; openedAt: Date; closedAt: Date }) {
  const s = await prisma.shift.create({ data: {
    userId: who.finA!.id, tenantId: co.tenantId, status: 'closed', openedAt: o.openedAt, closedAt: o.closedAt,
    openingFloatCents: 0, closingFloatCents: o.takings,
  } })
  if (o.drops) await prisma.cashMovement.create({ data: { shiftId: s.id, type: 'drop', amountCents: o.drops, reason: 'to safe', recordedById: who.finA!.id } })
  return s.id
}
async function creditsOf(tenantId: string, dropId: string): Promise<Record<string, number>> {
  const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId, reference: `deposit.drop:${dropId}` }, include: { lines: { include: { account: true } } } })
  const out: Record<string, number> = {}
  for (const l of je.lines) if (l.type === 'credit') out[l.account.code] = (out[l.account.code] ?? 0) + Number(l.amountCents)
  return out
}
const varianceFlags = (dropId: string) => prisma.exceptionFlag.findMany({ where: { entityType: 'DepositDrop', entityId: dropId, title: { startsWith: 'Deposit drop variance' } } })

beforeAll(async () => {
  A = await mkCo('Sales Fix A', 'sfa')
  B = await mkCo('Sales Fix B', 'sfb')
  await mkUser('finA', 'finance', A.tenantId)
  await mkUser('finB', 'finance', B.tenantId)
  app = Fastify({ bodyLimit: 30 * 1024 * 1024 })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(trustopsRoutes, { prefix: '/trustops' })
  await app.ready()
}, 90_000)

afterAll(async () => { await app?.close() })

describe('item 1 — two bags for one shift never credit the safe twice', () => {
  it('drops 20,000 + takings 50,000: bag 1 (20,000) is the safe, bag 2 (50,000) is all drawer', async () => {
    const shiftId = await mkShift(A, { drops: 2_000_000, takings: 5_000_000, openedAt: at('2026-02-10', '09:00'), closedAt: at('2026-02-10', '23:00') })
    const r1 = await call('finA', 'POST', '/trustops/deposit-drops', { shiftId, amountCents: 2_000_000, bankAccountId: A.bank, slipNumber: `S1-${RUN}` })
    expect(r1.statusCode, r1.body).toBe(201)
    expect(r1.json().posted).toBe(true)
    expect(await creditsOf(A.tenantId, r1.json().id)).toEqual({ '1010': 2_000_000 })
    const r2 = await call('finA', 'POST', '/trustops/deposit-drops', { shiftId, amountCents: 5_000_000, bankAccountId: A.bank, slipNumber: `S2-${RUN}` })
    expect(r2.statusCode, r2.body).toBe(201)
    expect(await creditsOf(A.tenantId, r2.json().id)).toEqual({ '1015': 5_000_000 })
    // Item 28 on the same shift: bag 2 was compared with what was still to bank.
    expect(r2.json()).toMatchObject({ expectedCents: 5_000_000, varianceCents: 0 })
    // A re-post books the same split (a pure function of the earlier bags).
    const [a1] = await dropAllocations(prisma, { tenantId: A.tenantId, dropId: r1.json().id })
    expect(await shiftShareSplit(prisma, A.tenantId, a1!)).toEqual({ fromDropsCents: 2_000_000, fromDrawerCents: 0, restCents: 0 })
    const [a2] = await dropAllocations(prisma, { tenantId: A.tenantId, dropId: r2.json().id })
    expect(await shiftShareSplit(prisma, A.tenantId, a2!)).toEqual({ fromDropsCents: 0, fromDrawerCents: 5_000_000, restCents: 0 })
  })
})

describe('item 1 (gate) — two bags for one shift at the same moment', () => {
  it('parallel bags are ordered under the per-shift lock: the safe is credited once, the drawer once', async () => {
    const shiftId = await mkShift(A, { drops: 2_000_000, takings: 5_000_000, openedAt: at('2026-02-13', '09:00'), closedAt: at('2026-02-13', '23:00') })
    const [r1, r2] = await Promise.all([
      call('finA', 'POST', '/trustops/deposit-drops', { shiftId, amountCents: 3_500_000, bankAccountId: A.bank }),
      call('finA', 'POST', '/trustops/deposit-drops', { shiftId, amountCents: 3_500_000, bankAccountId: A.bank }),
    ])
    expect(r1.statusCode, r1.body).toBe(201)
    expect(r2.statusCode, r2.body).toBe(201)
    const c1 = await creditsOf(A.tenantId, r1.json().id)
    const c2 = await creditsOf(A.tenantId, r2.json().id)
    const total = (code: string) => (c1[code] ?? 0) + (c2[code] ?? 0)
    // 70,000 banked of 70,000 cash: 20,000 from the safe's drops, 50,000 from the drawer — never 40,000 from the safe.
    expect(total('1010')).toBe(2_000_000)
    expect(total('1015')).toBe(5_000_000)
    // The two bags' expected figures add up to the shift (one saw the whole, the other the rest).
    expect(r1.json().expectedCents + r2.json().expectedCents).toBe(7_000_000 + 3_500_000)
  })

  it('an extra bag for a shift already banked in full is still flagged as cash over', async () => {
    const shiftId = await mkShift(A, { takings: 1_000_000, openedAt: at('2026-02-14', '09:00'), closedAt: at('2026-02-14', '23:00') })
    const full = await call('finA', 'POST', '/trustops/deposit-drops', { shiftId, amountCents: 1_000_000, bankAccountId: A.bank })
    expect(await varianceFlags(full.json().id)).toHaveLength(0)
    const extra = await call('finA', 'POST', '/trustops/deposit-drops', { shiftId, amountCents: 500_000, bankAccountId: A.bank })
    expect(extra.json()).toMatchObject({ expectedCents: 0, varianceCents: 500_000 })
    expect((await varianceFlags(extra.json().id)).map((f) => f.status)).toEqual(['open'])
    // The extra cash came from the safe (1010) — the shift's takings were already taken.
    expect(await creditsOf(A.tenantId, extra.json().id)).toEqual({ '1010': 500_000 })
  })
})

describe('item 28 — partial bags against what is still to bank', () => {
  it('30,000 + 20,000 of 50,000: the first is flagged short, the second ties and resolves it', async () => {
    const shiftId = await mkShift(A, { takings: 5_000_000, openedAt: at('2026-02-11', '09:00'), closedAt: at('2026-02-11', '23:00') })
    const r1 = await call('finA', 'POST', '/trustops/deposit-drops', { shiftId, amountCents: 3_000_000, bankAccountId: A.bank })
    expect(r1.json()).toMatchObject({ expectedCents: 5_000_000, varianceCents: -2_000_000 })
    expect((await varianceFlags(r1.json().id)).map((f) => f.status)).toEqual(['open'])
    const r2 = await call('finA', 'POST', '/trustops/deposit-drops', { shiftId, amountCents: 2_000_000, bankAccountId: A.bank })
    expect(r2.json()).toMatchObject({ expectedCents: 2_000_000, varianceCents: 0 })
    expect(await varianceFlags(r2.json().id)).toHaveLength(0)
    expect((await varianceFlags(r1.json().id)).map((f) => f.status)).toEqual(['resolved'])
    expect(await creditsOf(A.tenantId, r1.json().id)).toEqual({ '1015': 3_000_000 })
    expect(await creditsOf(A.tenantId, r2.json().id)).toEqual({ '1015': 2_000_000 })
  })
})

describe('item 14 — one bag split across several shifts; amounts compared', () => {
  const day = '2026-02-12'
  let s1: string, s2: string, s3: string

  it('splits one bag over two tills: one entry on the drawer, both tills banked', async () => {
    s1 = await mkShift(A, { takings: 1_000_000, openedAt: at(day, '09:00'), closedAt: at(day, '17:00') })
    s2 = await mkShift(A, { takings: 1_500_000, openedAt: at(day, '17:00'), closedAt: at(day, '23:30') })
    s3 = await mkShift(A, { takings: 1_000_000, openedAt: at(day, '10:00'), closedAt: at(day, '22:00') })
    const before = await cashNotBankedBetween(prisma, A.tenantId, parsePktStartOfDay(day), parsePktEndOfDay(day))
    expect(before).toEqual({ count: 3, cents: 3_500_000 })

    const r = await call('finA', 'POST', '/trustops/deposit-drops', {
      amountCents: 2_500_000, bankAccountId: A.bank, shifts: [{ shiftId: s1, amountCents: 1_000_000 }, { shiftId: s2, amountCents: 1_500_000 }],
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ tenantId: A.tenantId, shiftId: null, expectedCents: 2_500_000, varianceCents: 0 })
    const rows = await prisma.depositDropShift.findMany({ where: { depositDropId: r.json().id }, orderBy: { amountCents: 'asc' } })
    expect(rows.map((x) => [x.shiftId, x.amountCents, x.tenantId])).toEqual([[s1, 1_000_000, A.tenantId], [s2, 1_500_000, A.tenantId]])
    expect(await creditsOf(A.tenantId, r.json().id)).toEqual({ '1015': 2_500_000 })

    // Only the third till is still unbanked.
    expect(await cashNotBankedBetween(prisma, A.tenantId, parsePktStartOfDay(day), parsePktEndOfDay(day))).toEqual({ count: 1, cents: 1_000_000 })
    // The daily report and sales_bank_unmatched read the split too.
    const rep = await buildDailyReport(prisma, A.tenantId, day)
    expect(rep.cash.shifts.find((x) => x.shiftId === s2)?.depositDropCents).toBe(1_500_000)
    expect((await salesBankUnmatchedBetween(prisma, A.tenantId, parsePktStartOfDay(day), parsePktEndOfDay(day))).count).toBe(1)
    // The list shows each share.
    const list = (await call('finA', 'GET', '/trustops/deposit-drops')).json() as Array<{ id: string; allocations: Array<{ shiftId: string }> }>
    expect(list.find((d) => d.id === r.json().id)?.allocations).toHaveLength(2)
  })

  it('a PKR 100 bag no longer clears a whole till; the bag that completes it does', async () => {
    const small = await call('finA', 'POST', '/trustops/deposit-drops', { shiftId: s3, amountCents: 10_000, bankAccountId: A.bank })
    expect(small.statusCode, small.body).toBe(201)
    expect(await cashNotBankedBetween(prisma, A.tenantId, parsePktStartOfDay(day), parsePktEndOfDay(day))).toEqual({ count: 1, cents: 990_000 })
    // A legacy drop (shiftId, no share rows) counts as one share of its amount.
    const legacy = await prisma.depositDrop.create({ data: { tenantId: A.tenantId, shiftId: s3, bankAccountId: A.bank, amountCents: 990_000, expectedCents: 0, varianceCents: 0, droppedById: who.finA!.id } })
    expect(await cashNotBankedBetween(prisma, A.tenantId, parsePktStartOfDay(day), parsePktEndOfDay(day))).toEqual({ count: 0, cents: 0 })
    expect((await postDepositDrop(legacy.id)).posted).toBe(true)
    expect(await creditsOf(A.tenantId, legacy.id)).toEqual({ '1015': 990_000 })
  })

  it('refuses a split that does not add up, a shift twice, and both forms at once (422)', async () => {
    const base = { bankAccountId: A.bank }
    expect(code(await call('finA', 'POST', '/trustops/deposit-drops', { ...base, amountCents: 100_000, shifts: [{ shiftId: s1, amountCents: 60_000 }, { shiftId: s2, amountCents: 30_000 }] }))).toBe('SPLIT_NOT_EQUAL_DEPOSIT')
    expect(code(await call('finA', 'POST', '/trustops/deposit-drops', { ...base, amountCents: 100_000, shifts: [{ shiftId: s1, amountCents: 50_000 }, { shiftId: s1, amountCents: 50_000 }] }))).toBe('SHIFT_LISTED_TWICE')
    expect(code(await call('finA', 'POST', '/trustops/deposit-drops', { ...base, amountCents: 100_000, shiftId: s1, shifts: [{ shiftId: s1, amountCents: 100_000 }] }))).toBe('SHIFT_AND_SHIFTS')
  })

  it('company B: cannot split onto A\'s shift (422, nothing saved), never sees A\'s drops, and its own split binds to B', async () => {
    const before = await prisma.depositDrop.count({ where: { tenantId: B.tenantId } })
    const bShift = await mkShift(B, { takings: 400_000, openedAt: at(day, '09:00'), closedAt: at(day, '21:00') })
    const r = await call('finB', 'POST', '/trustops/deposit-drops', {
      amountCents: 500_000, bankAccountId: B.bank, shifts: [{ shiftId: bShift, amountCents: 400_000 }, { shiftId: s1, amountCents: 100_000 }],
    })
    expect(r.statusCode).toBe(422)
    expect(code(r)).toBe('SHIFT_NOT_IN_COMPANY')
    expect(await prisma.depositDrop.count({ where: { tenantId: B.tenantId } })).toBe(before)
    const listB = (await call('finB', 'GET', '/trustops/deposit-drops')).json() as Array<{ tenantId: string }>
    expect(listB.every((d) => d.tenantId === B.tenantId)).toBe(true)
    const ok = await call('finB', 'POST', '/trustops/deposit-drops', { amountCents: 400_000, bankAccountId: B.bank, shifts: [{ shiftId: bShift, amountCents: 400_000 }] })
    expect(ok.statusCode, ok.body).toBe(201)
    expect((await prisma.depositDropShift.findMany({ where: { depositDropId: ok.json().id } })).map((x) => x.tenantId)).toEqual([B.tenantId])
    // B's shares never count for A, nor A's for B.
    expect(await cashNotBankedBetween(prisma, B.tenantId, parsePktStartOfDay(day), parsePktEndOfDay(day))).toEqual({ count: 0, cents: 0 })
  })
})

describe('item 2 — a till closing before 05:00 PKT is the day it opened', () => {
  it('the rule', () => {
    expect(shiftBusinessDay({ openedAt: at('2026-05-31', '18:00'), closedAt: at('2026-06-01', '00:40') })).toBe('2026-05-31')
    expect(shiftBusinessDay({ openedAt: at('2026-05-31', '18:00'), closedAt: at('2026-06-01', '04:59') })).toBe('2026-05-31')
    expect(shiftBusinessDay({ openedAt: at('2026-05-31', '18:00'), closedAt: at('2026-06-01', '05:00') })).toBe('2026-06-01')
    expect(shiftBusinessDay({ openedAt: at('2026-06-01', '01:00'), closedAt: at('2026-06-01', '03:00') })).toBe('2026-06-01')
    expect(shiftBusinessDay({ openedAt: at('2026-06-01', '09:00'), closedAt: null })).toBeNull()
    const d = shiftBusinessDate({ openedAt: at('2026-05-31', '18:00'), closedAt: at('2026-06-01', '00:40') })!
    expect(d.toISOString()).toBe(parsePktEndOfDay('2026-05-31').toISOString())
    const same = at('2026-06-01', '23:00')
    expect(shiftBusinessDate({ openedAt: at('2026-06-01', '09:00'), closedAt: same })).toBe(same)
  })

  it('posts the 31 May dinner till (closed 00:40 on 1 June) on 31 May — night audit, month and close checks agree', async () => {
    const shiftId = await mkShift(A, { takings: 11_500, openedAt: at('2026-05-31', '18:00'), closedAt: at('2026-06-01', '00:40') })
    const o = await prisma.order.create({ data: {
      conceptId: A.concept, source: 'pos', fulfilmentType: 'takeout', status: 'completed', shiftId,
      totalCents: 11_500, taxCents: 1_500, placedAt: at('2026-05-31', '23:50'), completedAt: at('2026-06-01', '00:10'),
      items: { create: [{ name: 'Burger', quantity: 1, unitPriceCents: 10_000 }] },
    } as never })
    await prisma.payment.create({ data: { orderId: o.id, shiftId, method: 'cash', amountCents: 11_500, status: 'paid', processedAt: at('2026-06-01', '00:10'), createdAt: at('2026-06-01', '00:10') } })

    const may = { from: parsePktStartOfDay('2026-05-31'), to: parsePktEndOfDay('2026-05-31') }
    const june1 = { from: parsePktStartOfDay('2026-06-01'), to: parsePktEndOfDay('2026-06-01') }
    // Before posting: the close checklist lists it as unposted on 31 May, not on 1 June.
    expect((await unpostedShiftRows(prisma, A.tenantId, may.from, may.to)).map((r) => r.shiftId)).toContain(shiftId)
    expect((await unpostedShiftRows(prisma, A.tenantId, june1.from, june1.to)).map((r) => r.shiftId)).not.toContain(shiftId)

    expect((await postShiftClose(shiftId)).posted).toBe(true)
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `shift.close:${shiftId}` }, include: { lines: { include: { account: true } } } })
    expect(fmtPktDate(je.entryDate)).toBe('2026-05-31')
    expect(je.lines.some((l) => l.type === 'credit' && l.amountCents === 1_500)).toBe(true) // GST in May

    // Night audit: the till's cash belongs to 31 May.
    expect((await cashNotBankedBetween(prisma, A.tenantId, may.from, may.to)).count).toBe(1)
    expect((await cashNotBankedBetween(prisma, A.tenantId, june1.from, june1.to)).count).toBe(0)
    const rep = await buildDailyReport(prisma, A.tenantId, '2026-05-31')
    expect(rep.cash.shifts.map((s) => s.shiftId)).toContain(shiftId)
    expect((await buildDailyReport(prisma, A.tenantId, '2026-06-01')).cash.shifts.map((s) => s.shiftId)).not.toContain(shiftId)
  })

  it('activity days: a till open over midnight with nothing else after midnight leaves 1 June inactive', async () => {
    const C = await mkCo('Sales Fix C', 'sfc')
    await prisma.shift.create({ data: { userId: who.finA!.id, tenantId: C.tenantId, status: 'closed', openedAt: at('2026-07-31', '18:00'), closedAt: at('2026-08-01', '01:30'), openingFloatCents: 0, closingFloatCents: 0 } })
    expect(await activityDaysBetween(prisma, C.tenantId, '2026-07-30', '2026-08-02')).toEqual(['2026-07-31'])
    // A till closing after the cut-off keeps its close day.
    await prisma.shift.create({ data: { userId: who.finA!.id, tenantId: C.tenantId, status: 'closed', openedAt: at('2026-08-05', '18:00'), closedAt: at('2026-08-06', '06:30'), openingFloatCents: 0, closingFloatCents: 0 } })
    expect(await activityDaysBetween(prisma, C.tenantId, '2026-08-05', '2026-08-06')).toEqual(['2026-08-05', '2026-08-06'])
  })
})

describe('item 29 — the COD night block links where finance can act', () => {
  it('code-only OFF → the till\'s pay-in list; ON → Reconciliation → Cash on delivery', async () => {
    const D = await mkCo('Sales Fix D', 'sfd')
    const day = '2026-03-05'
    const o = await prisma.order.create({ data: {
      conceptId: D.concept, source: 'servd', fulfilmentType: 'delivery', status: 'completed', totalCents: 25_000, taxCents: 0,
      placedAt: at(day, '19:00'), completedAt: at(day, '19:40'),
    } as never })
    await prisma.payment.create({ data: { orderId: o.id, method: 'cash', amountCents: 25_000, status: 'pending', createdAt: at(day, '19:00') } })
    const off = (await nightChecklist(prisma, D.tenantId, day, 'night')).blocks.find((b) => b.key === 'cod_pending')
    expect(off).toMatchObject({ link: '/pos/shift', count: 1 })
    expect(off!.detail).toMatch(/Till → Rider cash-on-delivery/)
    await prisma.setting.create({ data: { key: `delivery.codeOnlyAt:${D.tenantId}`, value: new Date().toISOString() } })
    const on = (await nightChecklist(prisma, D.tenantId, day, 'night')).blocks.find((b) => b.key === 'cod_pending')
    expect(on?.link).toBe('/reconciliation?tab=cod')
    // Company A's switch is untouched by D's.
    expect(await prisma.setting.count({ where: { key: `delivery.codeOnlyAt:${A.tenantId}` } })).toBe(0)
  })
})
