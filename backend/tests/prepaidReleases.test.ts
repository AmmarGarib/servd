// Prepaid releases — ONE engine for CapEx and OpEx prepayments (H25, P7;
// accounting/prepaidReleases.ts).
//
//   • A CapEx rent advance (Dr 1310) is released month by month to 6010 on
//     the project's brand, in the project's company: floor a month, the
//     remainder in the last month; running it again posts nothing.
//   • New rent advances must say which months they cover
//     (422 PREPAID_TERM_REQUIRED); once releasing has started the payment is
//     locked (409 PREPAID_RELEASING).
//   • An OpEx prepaid payment (treatment 'prepaid', its 1310 debit) releases
//     to its category's expense account through the same engine.
//   • A month already closed posts into the open month with the note, and the
//     row records postedPeriod.
//   • A refused release flags 'prepaid.release' on the payment.
//   • The close check blocks while a covered month is unreleased, then clears.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { financePlanningRoutes } from '../src/modules/financePlanning/routes.js'
import { releasePrepaidThrough, releaseSourceThrough, prepaidCloseChecks, releaseSchedule, unscheduledCapexPrepaids } from '../src/modules/accounting/prepaidReleases.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { addMonths, currentPeriodPkt, lastCompletedPeriodPkt, lastDayPkt, periodOfPkt } from '../src/modules/fixedAssets/schedule.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
const staff: Record<string, { id: string; token: string }> = {}
let tenantA: string, tenantB: string
let conceptA: string
const m = (n: number) => addMonths(currentPeriodPkt(), n)
const midOf = (period: string) => `${period}-05`

async function company(name: string) {
  const id = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  return id
}
async function mkStaff(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@prepaid.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]!.token}` } })

async function entry(reference: string) {
  const je = await prisma.journalEntry.findFirst({ where: { reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je ? { ...je, rows: je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, conceptId: l.conceptId, memo: l.memo ?? '' })) } : null
}
const amt = (rows: Array<{ code: string; type: string; amount: number }>, code: string, type: 'debit' | 'credit') =>
  rows.filter((r) => r.code === code && r.type === type).reduce((t, r) => t + r.amount, 0)

/** A CapEx rent advance paid through the route. */
async function rentAdvance(tenantId: string, who: string, amountCents: number, coversFrom: string, coversMonths: number, paidOn: string) {
  const project = await prisma.capexProject.create({ data: { tenantId, conceptId: tenantId === tenantA ? conceptA : null, name: `Shop ${RUN} ${Math.random()}` } })
  const line = await prisma.capexLine.create({ data: { projectId: project.id, scope: 'SoftCosts', item: 'Rent advance', unitCostCents: amountCents } })
  const r = await call(who, 'POST', `/finance/capex/lines/${line.id}/payments`, { label: 'deposit', amountCents, paidAt: paidOn, coversFrom, coversMonths })
  expect(r.statusCode, r.body).toBe(201)
  return { paymentId: r.json().id as string, lineId: line.id, projectId: project.id }
}

/** An OpEx prepaid payment and its 1310 debit (the fixture w2-taxbooks' posting writes). */
async function opexPrepaid(tenantId: string, categoryName: string, expenseAccountCode: string | null, cents: number, coversFrom: string, coversMonths: number) {
  const cat = await prisma.opexCategory.create({ data: { tenantId, name: categoryName, expenseAccountCode } })
  const line = await prisma.opexLine.create({ data: { categoryId: cat.id, conceptId: tenantId === tenantA ? conceptA : null, name: `${categoryName} — kiosk`, amountCents: cents, cadence: 'quarterly' } })
  const paidAt = new Date(`${coversFrom}-02T12:00:00+05:00`)
  const p = await prisma.opexPayment.create({
    data: { lineId: line.id, periodStart: paidAt, periodEnd: paidAt, expectedCents: cents, actualCents: cents, paidAt, treatment: 'prepaid', coversFrom, coversMonths },
  })
  await postJournalEntry({ tenantId, sourceType: 'opex.payment', sourceId: p.id, description: 'OpEx prepaid', entryDate: paidAt, postedBy: 'test', lines: [
    { accountCode: '1310', type: 'debit', amountCents: cents }, { accountCode: '1020', type: 'credit', amountCents: cents },
  ] })
  return p.id
}

beforeAll(async () => {
  tenantA = await company('Prepaid A')
  tenantB = await company('Prepaid B')
  conceptA = (await prisma.concept.create({ data: { name: 'Prepaid Cafe', slug: `prepaid-cafe-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
  await mkStaff('finA', 'finance', tenantA)
  await mkStaff('ceoA', 'admin', tenantA)
  await mkStaff('finB', 'finance', tenantB)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(financePlanningRoutes, { prefix: '/finance' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  const entries = await prisma.journalEntry.findMany({ where: { tenantId: { in: [tenantA, tenantB] } }, include: { lines: true } })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
    expect({ ref: e.reference, d }).toEqual({ ref: e.reference, d: c })
  }
  await app.close()
})

describe('the schedule', () => {
  it('floor a month, the remainder in the last', () => {
    expect(releaseSchedule(1_000_001, '2026-11', 3)).toEqual([
      { period: '2026-11', amountCents: 333_333 }, { period: '2026-12', amountCents: 333_333 }, { period: '2027-01', amountCents: 333_335 },
    ])
    expect(releaseSchedule(0, '2026-11', 3)).toEqual([])
  })
})

describe('CapEx rent advance', () => {
  it('needs its months; releases monthly to 6010 in the project\'s company, idempotently; then it is locked', async () => {
    // No coverage on a new rent advance: refused, nothing saved.
    const project = await prisma.capexProject.create({ data: { tenantId: tenantA, name: `Bare ${RUN}` } })
    const line = await prisma.capexLine.create({ data: { projectId: project.id, scope: 'SoftCosts', item: 'Rent advance', unitCostCents: 10 } })
    const bare = await call('finA', 'POST', `/finance/capex/lines/${line.id}/payments`, { label: 'deposit', amountCents: 10, paidAt: midOf(m(-3)) })
    expect(bare.json().error.code).toBe('PREPAID_TERM_REQUIRED')
    expect(await prisma.capexPayment.count({ where: { lineId: line.id } })).toBe(0)

    const { paymentId } = await rentAdvance(tenantA, 'finA', 1_000_001, m(-3), 3, midOf(m(-3)))
    const b = await rentAdvance(tenantB, 'finB', 600_000, m(-2), 2, midOf(m(-2)))
    const r = await releasePrepaidThrough(tenantA, lastCompletedPeriodPkt(), { postedBy: staff.finA!.id })
    expect(r).toEqual({ released: 3, cents: 1_000_001 })
    const rows = await prisma.prepaidRelease.findMany({ where: { sourceId: paymentId }, orderBy: { period: 'asc' } })
    expect(rows.map((x) => [x.period, x.amountCents, x.tenantId])).toEqual([
      [m(-3), 333_333, tenantA], [m(-2), 333_333, tenantA], [m(-1), 333_335, tenantA],
    ])
    const je = await entry(`prepaid.release:capex_payment:${paymentId}:${m(-1)}`)
    expect(je!.tenantId).toBe(tenantA)
    expect(amt(je!.rows, '6010', 'debit')).toBe(333_335)
    expect(amt(je!.rows, '1310', 'credit')).toBe(333_335)
    expect(je!.rows.find((x) => x.code === '6010')!.conceptId).toBe(conceptA)
    expect(je!.entryDate.getTime()).toBe(lastDayPkt(m(-1)).getTime())
    // B's advance was not touched by A's run.
    expect(await prisma.prepaidRelease.count({ where: { sourceId: b.paymentId } })).toBe(0)

    // Again: nothing more.
    expect(await releasePrepaidThrough(tenantA, lastCompletedPeriodPkt())).toEqual({ released: 0, cents: 0 })
    // The current month is never released early.
    await releasePrepaidThrough(tenantA, m(2))
    expect(await prisma.prepaidRelease.count({ where: { sourceId: paymentId } })).toBe(3)

    // Locked now: amount, months, un-pay, delete.
    expect((await call('finA', 'PATCH', `/finance/capex/payments/${paymentId}`, { paidAmountCents: 900_000 })).json().error.code).toBe('PREPAID_RELEASING')
    expect((await call('finA', 'PATCH', `/finance/capex/payments/${paymentId}`, { coversMonths: 6 })).json().error.code).toBe('PREPAID_RELEASING')
    expect((await call('finA', 'PATCH', `/finance/capex/payments/${paymentId}`, { paidAt: null })).json().error.code).toBe('PREPAID_RELEASING')
    expect((await call('finA', 'DELETE', `/finance/capex/payments/${paymentId}`)).json().error.code).toBe('PREPAID_RELEASING')

    // B's run, through the route, releases B's only.
    const run = await call('finB', 'POST', '/finance/prepaid-releases', {})
    expect(run.statusCode, run.body).toBe(200)
    expect(run.json()).toMatchObject({ tenantId: tenantB, released: 2, cents: 600_000 })
    // Another company's id in the body: 404.
    expect((await call('finB', 'POST', '/finance/prepaid-releases', { tenantId: tenantA })).statusCode).toBe(404)
    // The tracker shows what was released.
    const view = (await call('finB', 'GET', `/finance/capex/${b.projectId}`)).json()
    expect(view.books.releasedCents).toBe(600_000)
    expect(view.lines[0].payments[0].releasedCents).toBe(600_000)
  })
})

describe('OpEx prepaid payments use the same engine', () => {
  it('release to the category\'s expense account and brand', async () => {
    const id = await opexPrepaid(tenantA, 'Electricity deposit plan', '6020', 300_000, m(-2), 3)
    await releasePrepaidThrough(tenantA, lastCompletedPeriodPkt())
    const rows = await prisma.prepaidRelease.findMany({ where: { sourceType: 'opex_payment', sourceId: id }, orderBy: { period: 'asc' } })
    expect(rows.map((x) => [x.period, x.amountCents])).toEqual([[m(-2), 100_000], [m(-1), 100_000]])
    const je = await entry(`prepaid.release:opex_payment:${id}:${m(-2)}`)
    expect(amt(je!.rows, '6020', 'debit')).toBe(100_000)
    expect(amt(je!.rows, '1310', 'credit')).toBe(100_000)
    expect(je!.rows.find((x) => x.code === '6020')!.conceptId).toBe(conceptA)
  })
})

describe('a closed month, a refusal, the close check', () => {
  it('a closed month posts into the open month with its note and postedPeriod', async () => {
    const { paymentId } = await rentAdvance(tenantB, 'finB', 200_000, m(-2), 2, midOf(m(-2)))
    const lock = await prisma.periodLock.create({ data: { tenantId: tenantB, lockedThrough: lastDayPkt(m(-2)), lockedBy: staff.finB!.id } })
    try {
      await releaseSourceThrough('capex_payment', paymentId, lastCompletedPeriodPkt())
      const late = await prisma.prepaidRelease.findFirstOrThrow({ where: { sourceId: paymentId, period: m(-2) } })
      expect(late.postedPeriod).toBe(currentPeriodPkt())
      const je = await entry(`prepaid.release:capex_payment:${paymentId}:${m(-2)}`)
      expect(je!.entryDate.getTime()).toBeGreaterThan(lock.lockedThrough.getTime())
      expect(je!.rows.every((x) => /posted late/.test(x.memo))).toBe(true)
      const onTime = await prisma.prepaidRelease.findFirstOrThrow({ where: { sourceId: paymentId, period: m(-1) } })
      expect(onTime.postedPeriod).toBeNull()
      expect(periodOfPkt((await entry(`prepaid.release:capex_payment:${paymentId}:${m(-1)}`))!.entryDate)).toBe(m(-1))
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
  })

  it('a refused release flags prepaid.release on the payment; the close check blocks, then clears', async () => {
    const odd = await opexPrepaid(tenantA, 'Miscellany', null, 90_000, m(-1), 3)
    const ctx = { db: prisma, tenantId: tenantA, prevLock: null, newLock: lastDayPkt(m(-1)), months: [m(-1)], isYearEnd: false }
    const blocked = await prepaidCloseChecks[0]!.run(ctx)
    expect(blocked).toMatchObject({ key: 'prepaid_release', severity: 'block', count: 1, cents: 30_000, months: [m(-1)] })
    expect(blocked!.fix).toMatchObject({ method: 'POST', path: '/finance/prepaid-releases' })
    // A lock part-way through m(-1) leaves that month's release (dated its last day) outside the close.
    const midMonth = await prepaidCloseChecks[0]!.run({ ...ctx, newLock: new Date(lastDayPkt(m(-1)).getTime() - 10 * 86_400_000) })
    expect((midMonth as { months?: string[] } | null)?.months ?? []).not.toContain(m(-1))

    await releasePrepaidThrough(tenantA, lastCompletedPeriodPkt())
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'posting_failed', entityType: 'OpexPayment', entityId: odd } })
    expect(flag.tenantId).toBe(tenantA)
    expect(flag.metadata).toMatchObject({ sourceType: 'prepaid.release', sourceId: odd })
    await expect(releaseSourceThrough('opex_payment', odd, lastCompletedPeriodPkt())).rejects.toMatchObject({ code: 'CATEGORY_NOT_MAPPED' })

    // Named: the re-poster's path releases it and the close check clears.
    await prisma.opexCategory.updateMany({ where: { tenantId: tenantA, name: 'Miscellany' }, data: { expenseAccountCode: '6040' } })
    await releaseSourceThrough('opex_payment', odd, lastCompletedPeriodPkt())
    expect(amt((await entry(`prepaid.release:opex_payment:${odd}:${m(-1)}`))!.rows, '6040', 'debit')).toBe(30_000)
    expect(await prepaidCloseChecks[0]!.run(ctx)).toBeNull()
  })

  it('a legacy rent advance with no months is listed for the worker\'s flag, and released once its months are given', async () => {
    const project = await prisma.capexProject.create({ data: { tenantId: tenantB, name: `Legacy rent ${RUN}` } })
    const line = await prisma.capexLine.create({ data: { projectId: project.id, scope: 'SoftCosts', item: 'Rent advance', unitCostCents: 120_000 } })
    const pay = await prisma.capexPayment.create({ data: { lineId: line.id, label: 'deposit', amountCents: 120_000, paidAmountCents: 120_000, paidAt: new Date(`${midOf(m(-1))}T12:00:00+05:00`) } })
    await postJournalEntry({ tenantId: tenantB, sourceType: 'capex.payment', sourceId: pay.id, description: 'Legacy rent advance', entryDate: new Date(`${midOf(m(-1))}T12:00:00+05:00`), postedBy: 'test', lines: [
      { accountCode: '1310', type: 'debit', amountCents: 120_000 }, { accountCode: '1020', type: 'credit', amountCents: 120_000 },
    ] })
    expect((await unscheduledCapexPrepaids(tenantB)).map((x) => [x.paymentId, x.heldCents])).toEqual([[pay.id, 120_000]])
    expect(await unscheduledCapexPrepaids(tenantA)).toEqual([])
    const patched = await call('finB', 'PATCH', `/finance/capex/payments/${pay.id}`, { coversFrom: m(-1), coversMonths: 2 })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(await unscheduledCapexPrepaids(tenantB)).toEqual([])
    await releasePrepaidThrough(tenantB, lastCompletedPeriodPkt())
    expect((await prisma.prepaidRelease.findMany({ where: { sourceId: pay.id } })).map((x) => [x.period, x.amountCents])).toEqual([[m(-1), 60_000]])
  })
})
