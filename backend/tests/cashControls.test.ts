// Cash controls (finance gaps wave A, 2026-10-13): petty cash, deposit drops,
// cash on delivery, reservation deposits, the bank-statement import's scope.
//
// Two companies A and B; a "both" operator who belongs to A and B and works
// in B, so a row stamped with the operator's company instead of the
// document's shows up as B.
//
//   Petty cash   /movements takes topup|spend only; a top-up only by a cash
//                keeper or the custodian; INT4 bounds (422); the opening float
//                is a 'topup' movement + an audit row; box → box transfers in
//                one company (422 across companies, 404 for a stranger);
//                PATCH name / custodian / limit (raising needs a PIN); the
//                movements always add up to the float.
//   Deposits     the posting is awaited; a refused posting keeps the drop and
//                raises posting_failed in the drop's company; the bank is the
//                one resolver's (unlinked → 422, two banks unnamed → 422).
//   COD          cod-unpaid: managers only, a real unpaid COD only, one strike
//                per order, audited in the order's company, books untouched;
//                cod-due carries rider / age / overdue; by-tender keeps COD
//                not in a drawer out of Cash.
//   Reservations release audits in the reservation's company and refuses when
//                nothing is held; a no-show capture debits 1030, zeroes the
//                deposit, and a refused posting keeps the deposit held.
//   Bank import  a matched line of another company never blocks a match.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { prisma, mkCompany, mkUser, mkOrder, mkRaastAccount, type Company, type Who } from './connectorsFixtures.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { reportRoutes } from '../src/modules/reports/routes.js'
import { reservationRoutes } from '../src/modules/reservations/routes.js'
import { markNoShow } from '../src/modules/reservations/noShow.js'
import { importBankStatement } from '../src/modules/reconciliation/service.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { INT4_MAX_CENTS } from '../src/lib/money.js'

let app: FastifyInstance
let A: Company
let B: Company
let L: Company // a company whose books get locked (posting refusals)
let ceoA: Who, finA: Who, cashA: Who, cashA2: Who, ceoB: Who, ceoL: Who, finNoBooks: Who, both: Who

const PIN_A = '4719'
const DAY = '2026-10-10'

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

async function mkBoth(): Promise<Who> {
  const u = await prisma.user.create({
    data: {
      name: 'both', email: `both.${randomBytes(3).toString('hex')}@cc.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: 'admin', isActive: true, accountStatus: 'active', tenantId: B.tenantId,
      tenantMemberships: { create: [{ tenant: { connect: { id: A.tenantId } }, role: 'member' }, { tenant: { connect: { id: B.tenantId } }, role: 'member' }] },
    },
  })
  return { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken, role: 'admin', tenantId: B.tenantId }
}

const lockToday = (tenantId: string) =>
  prisma.periodLock.create({ data: { tenantId, lockedThrough: new Date(Date.now() + 86_400_000), lockedBy: 'test' } })

const sumMovements = async (boxId: string) =>
  (await prisma.pettyCashMovement.findMany({ where: { boxId }, select: { amountCents: true } })).reduce((s, m) => s + m.amountCents, 0)
const floatOf = async (boxId: string) => (await prisma.pettyCashBox.findUniqueOrThrow({ where: { id: boxId } })).floatCents

beforeAll(async () => {
  A = await mkCompany(`cc-a-${randomBytes(2).toString('hex')}`)
  B = await mkCompany(`cc-b-${randomBytes(2).toString('hex')}`)
  L = await mkCompany(`cc-l-${randomBytes(2).toString('hex')}`)
  ceoA = await mkUser('cc-ceo-a', 'admin', A.tenantId)
  finA = await mkUser('cc-fin-a', 'finance', A.tenantId)
  cashA = await mkUser('cc-cash-a', 'cashier', A.tenantId)
  cashA2 = await mkUser('cc-cash-a2', 'cashier', A.tenantId)
  ceoB = await mkUser('cc-ceo-b', 'admin', B.tenantId)
  ceoL = await mkUser('cc-ceo-l', 'admin', L.tenantId)
  finNoBooks = await mkUser('cc-fin-nobooks', 'finance', A.tenantId)
  await prisma.user.update({ where: { id: finNoBooks.id }, data: { moduleDeny: ['accounting'] } })
  await prisma.user.update({ where: { id: ceoA.id }, data: { pin: await bcrypt.hash(PIN_A, 4) } })
  both = await mkBoth()

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(trustopsRoutes, { prefix: '/trustops' })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.register(posRoutes, { prefix: '/pos' })
  await app.register(reportRoutes, { prefix: '/reports' })
  await app.register(reservationRoutes, { prefix: '/reservations' })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

// ─── Petty cash ───────────────────────────────────────────────────────────────

describe('petty cash: one movement writer, guarded doors', () => {
  let box: string
  let box2: string
  let boxB: string

  it('a new box writes its opening float as a top-up movement and an audit row', async () => {
    // An opening float above the box's own limit is an over-limit top-up:
    // refused without a manager PIN, recorded as approved with one.
    const noPin = await call(finA, 'POST', '/trustops/petty-cash/boxes', { name: 'Office box', custodianId: cashA.id, floatCents: 50_000, topUpLimitCents: 20_000 })
    expect(noPin.statusCode).toBe(403)
    expect(noPin.json().error.code).toBe('TOPUP_OVER_LIMIT')
    const r = await call(finA, 'POST', '/trustops/petty-cash/boxes', { name: 'Office box', custodianId: cashA.id, floatCents: 50_000, topUpLimitCents: 20_000, managerOverridePin: PIN_A })
    expect(r.statusCode, r.body).toBe(201)
    box = r.json().id
    expect(r.json()).toMatchObject({ tenantId: A.tenantId, floatCents: 50_000, topUpLimitCents: 20_000 })
    const moves = await prisma.pettyCashMovement.findMany({ where: { boxId: box } })
    expect(moves.map((m) => [m.type, m.amountCents, m.reason, m.createdById])).toEqual([['topup', 50_000, 'Opening float', finA.id]])
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'petty_cash.box_create', entityId: box } })
    expect(a.tenantId).toBe(A.tenantId)
    expect(a.after).toMatchObject({ floatCents: 50_000, custodianId: cashA.id })

    // A box with no float writes no movement.
    const r2 = await call(finA, 'POST', '/trustops/petty-cash/boxes', { name: 'Kitchen box', custodianId: cashA2.id })
    expect(r2.statusCode).toBe(201)
    box2 = r2.json().id
    expect(await prisma.pettyCashMovement.count({ where: { boxId: box2 } })).toBe(0)
    boxB = (await call(ceoB, 'POST', '/trustops/petty-cash/boxes', { name: 'B box', custodianId: ceoB.id, floatCents: 10_000 })).json().id
  })

  it('amounts above INT4 are 422 AMOUNT_TOO_LARGE everywhere, before anything is written', async () => {
    const big = INT4_MAX_CENTS + 1
    for (const [url, body, who] of [
      ['/trustops/petty-cash/boxes', { name: 'Huge', custodianId: cashA.id, floatCents: big }, finA],
      ['/trustops/petty-cash/boxes', { name: 'Huge', custodianId: cashA.id, topUpLimitCents: big }, finA],
      ['/trustops/petty-cash/movements', { boxId: box, type: 'topup', amountCents: big, reason: 'x' }, finA],
      ['/trustops/petty-cash/movements', { boxId: box, type: 'spend', amountCents: big, reason: 'x' }, finA],
      [`/trustops/petty-cash/boxes/${box}/reconcile`, { countedCents: big }, finA],
      ['/trustops/petty-cash/transfers', { fromBoxId: box, toBoxId: box2, amountCents: big, reason: 'x' }, finA],
      ['/trustops/deposit-drops', { amountCents: big }, finA],
    ] as const) {
      const r = await call(who, 'POST', url, body)
      expect(r.statusCode, `${url} ${r.body}`).toBe(422)
      expect(r.json().error.code).toBe('AMOUNT_TOO_LARGE')
    }
    const p = await call(finA, 'PATCH', `/trustops/petty-cash/boxes/${box}`, { topUpLimitCents: big })
    expect(p.statusCode).toBe(422)
    expect(await floatOf(box)).toBe(50_000)
    expect(await prisma.pettyCashBox.count({ where: { name: 'Huge' } })).toBe(0)
  })

  it('/movements takes only topup and spend; counts and transfers have their own routes', async () => {
    for (const type of ['reconcile', 'transfer']) {
      const r = await call(finA, 'POST', '/trustops/petty-cash/movements', { boxId: box, type, amountCents: 5_000, reason: 'sneaky' })
      expect(r.statusCode, type).toBe(400)
    }
    // A cashier could once lower a float with a negative "reconcile".
    const neg = await call(cashA2, 'POST', '/trustops/petty-cash/movements', { boxId: box, type: 'spend', amountCents: -5_000, reason: 'x' })
    expect(neg.statusCode).toBe(400)
    expect(await floatOf(box)).toBe(50_000)
  })

  it('a top-up is a cash keeper\'s or the custodian\'s; a spend any staff of the company', async () => {
    const stranger = await call(cashA2, 'POST', '/trustops/petty-cash/movements', { boxId: box, type: 'topup', amountCents: 1_000, reason: 'refill' })
    expect(stranger.statusCode).toBe(403)
    expect(stranger.json().error.code).toBe('TOPUP_NOT_ALLOWED')
    // finance without the books module is not a cash keeper
    const noBooks = await call(finNoBooks, 'POST', '/trustops/petty-cash/movements', { boxId: box, type: 'topup', amountCents: 1_000, reason: 'refill' })
    expect(noBooks.statusCode).toBe(403)
    expect(await floatOf(box)).toBe(50_000)

    const custodian = await call(cashA, 'POST', '/trustops/petty-cash/movements', { boxId: box, type: 'topup', amountCents: 1_000, reason: 'refill from safe' })
    expect(custodian.statusCode, custodian.body).toBe(201)
    expect(custodian.json().newFloatCents).toBe(51_000)
    const keeper = await call(finA, 'POST', '/trustops/petty-cash/movements', { boxId: box, type: 'topup', amountCents: 1_000, reason: 'refill' })
    expect(keeper.statusCode).toBe(201)
    // Over the limit still needs a PIN, even for the custodian.
    const over = await call(cashA, 'POST', '/trustops/petty-cash/movements', { boxId: box, type: 'topup', amountCents: 25_000, reason: 'big' })
    expect(over.json().error.code).toBe('TOPUP_OVER_LIMIT')

    const spend = await call(cashA2, 'POST', '/trustops/petty-cash/movements', { boxId: box, type: 'spend', amountCents: 2_000, reason: 'Milk' })
    expect(spend.statusCode).toBe(201)
    expect(spend.json().newFloatCents).toBe(50_000)
    // B's people never reach A's box.
    expect((await call(ceoB, 'POST', '/trustops/petty-cash/movements', { boxId: box, type: 'spend', amountCents: 1, reason: 'x' })).statusCode).toBe(404)
  })

  it('transfers move cash between two boxes of one company, with one shared reference', async () => {
    const r = await call(finA, 'POST', '/trustops/petty-cash/transfers', { fromBoxId: box, toBoxId: box2, amountCents: 7_500, reason: 'Weekend float' })
    expect(r.statusCode, r.body).toBe(201)
    const { ref, out, in: inbound, fromFloatCents, toFloatCents } = r.json()
    expect(ref).toMatch(/^TRF-[0-9A-F]{8}$/)
    expect([fromFloatCents, toFloatCents]).toEqual([42_500, 7_500])
    expect(out).toMatchObject({ boxId: box, type: 'transfer', amountCents: -7_500 })
    expect(inbound).toMatchObject({ boxId: box2, type: 'transfer', amountCents: 7_500 })
    expect(out.reason).toContain(ref)
    expect(inbound.reason).toContain(ref)
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'petty_cash.transfer', entityId: box } })
    expect(a.tenantId).toBe(A.tenantId)
    expect(a.metadata).toMatchObject({ outMovementId: out.id, inMovementId: inbound.id })

    // More than the source holds: 400, nothing written.
    const moves = await prisma.pettyCashMovement.count()
    const over = await call(finA, 'POST', '/trustops/petty-cash/transfers', { fromBoxId: box2, toBoxId: box, amountCents: 7_501, reason: 'x' })
    expect(over.statusCode).toBe(400)
    expect(over.json().error.code).toBe('INSUFFICIENT_FLOAT')
    expect((await call(finA, 'POST', '/trustops/petty-cash/transfers', { fromBoxId: box, toBoxId: box, amountCents: 1, reason: 'x' })).json().error.code).toBe('SAME_BOX')
    // A cashier is not a cash keeper.
    expect((await call(cashA, 'POST', '/trustops/petty-cash/transfers', { fromBoxId: box, toBoxId: box2, amountCents: 1, reason: 'x' })).statusCode).toBe(403)
    // Across companies: 422 for someone in both, 404 for someone in one.
    const cross = await call(both, 'POST', '/trustops/petty-cash/transfers', { fromBoxId: box, toBoxId: boxB, amountCents: 1_000, reason: 'x' })
    expect(cross.statusCode).toBe(422)
    expect(cross.json().error.code).toBe('BOX_NOT_IN_COMPANY')
    expect((await call(ceoB, 'POST', '/trustops/petty-cash/transfers', { fromBoxId: boxB, toBoxId: box, amountCents: 1_000, reason: 'x' })).statusCode).toBe(404)
    expect(await prisma.pettyCashMovement.count()).toBe(moves)
    expect([await floatOf(box), await floatOf(box2), await floatOf(boxB)]).toEqual([42_500, 7_500, 10_000])
  })

  it('PATCH renames, re-assigns within the company, and raises the limit only with a PIN', async () => {
    const r = await call(finA, 'PATCH', `/trustops/petty-cash/boxes/${box}`, { name: 'Head office box', custodianId: cashA2.id })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ name: 'Head office box', custodianId: cashA2.id })
    const foreign = await call(finA, 'PATCH', `/trustops/petty-cash/boxes/${box}`, { custodianId: ceoB.id })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('CUSTODIAN_NOT_IN_COMPANY')

    const noPin = await call(finA, 'PATCH', `/trustops/petty-cash/boxes/${box}`, { topUpLimitCents: 90_000 })
    expect(noPin.statusCode).toBe(403)
    expect(noPin.json().error.code).toBe('LIMIT_RAISE_NEEDS_PIN')
    expect((await call(finA, 'PATCH', `/trustops/petty-cash/boxes/${box}`, { topUpLimitCents: 90_000, managerOverridePin: '0000' })).json().error.code).toBe('INVALID_MANAGER_PIN')
    const ok = await call(finA, 'PATCH', `/trustops/petty-cash/boxes/${box}`, { topUpLimitCents: 90_000, managerOverridePin: PIN_A })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().topUpLimitCents).toBe(90_000)
    // Lowering needs no PIN.
    expect((await call(finA, 'PATCH', `/trustops/petty-cash/boxes/${box}`, { topUpLimitCents: 10_000 })).json().topUpLimitCents).toBe(10_000)
    const audits = await prisma.auditLog.findMany({ where: { action: 'petty_cash.box_update', entityId: box }, orderBy: { createdAt: 'asc' } })
    expect(audits.map((x) => x.tenantId)).toEqual([A.tenantId, A.tenantId, A.tenantId])
    expect(audits[1]!.metadata).toMatchObject({ approvedById: ceoA.id })

    expect((await call(ceoB, 'PATCH', `/trustops/petty-cash/boxes/${box}`, { name: 'Mine' })).statusCode).toBe(404)
    expect((await call(cashA, 'PATCH', `/trustops/petty-cash/boxes/${box}`, { name: 'Mine' })).statusCode).toBe(403)
  })

  it('a count writes the variance as a movement; every box\'s movements add up to its float', async () => {
    const r = await call(finA, 'POST', `/trustops/petty-cash/boxes/${box}/reconcile`, { countedCents: 42_000, notes: 'Monthly count' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().varianceCents).toBe(-500)
    expect(r.json().movement).toMatchObject({ type: 'reconcile', amountCents: -500, reason: 'Monthly count' })
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'petty_cash.reconcile', entityId: r.json().movement.id } })).tenantId).toBe(A.tenantId)
    for (const id of [box, box2, boxB]) expect(await sumMovements(id)).toBe(await floatOf(id))
  })
})

// ─── Deposit drops ────────────────────────────────────────────────────────────

describe('deposit drops: awaited posting, one bank resolver', () => {
  it('posts at once to the company\'s only linked bank when none is named', async () => {
    const bank = await mkRaastAccount(A, { code: '1021', name: 'A Meezan' })
    const r = await call(finA, 'POST', '/trustops/deposit-drops', { amountCents: 30_000, receiptUrl: 'https://example.com/slip.jpg' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ tenantId: A.tenantId, bankAccountId: bank.bankAccountId, posted: true, postingError: null })
    // No waiting: the entry is there when the response is.
    const je = await prisma.journalEntry.findFirstOrThrow({
      where: { tenantId: A.tenantId, reference: `deposit.drop:${r.json().id}` },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    expect(je.lines.map((l) => [l.account.code, l.type, l.amountCents]).sort()).toEqual([['1010', 'credit', 30_000], ['1021', 'debit', 30_000]])
  })

  it('two banks and none named → 422 BANK_ACCOUNT_REQUIRED; an unlinked or foreign bank → 422; nothing saved', async () => {
    await mkRaastAccount(A, { code: '1022', name: 'A HBL', isDefault: false })
    const unlinked = await prisma.bankAccount.create({ data: { tenantId: A.tenantId, name: 'A unlinked' } })
    const foreign = await mkRaastAccount(B, { code: '1021', name: 'B bank' })
    const before = await prisma.depositDrop.count({ where: { tenantId: A.tenantId } })
    const none = await call(finA, 'POST', '/trustops/deposit-drops', { amountCents: 1_000 })
    expect(none.statusCode).toBe(422)
    expect(none.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    const notLinked = await call(finA, 'POST', '/trustops/deposit-drops', { amountCents: 1_000, bankAccountId: unlinked.id })
    expect(notLinked.json().error.code).toBe('BANK_ACCOUNT_NOT_LINKED')
    const other = await call(finA, 'POST', '/trustops/deposit-drops', { amountCents: 1_000, bankAccountId: foreign.bankAccountId })
    expect(other.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(await prisma.depositDrop.count({ where: { tenantId: A.tenantId } })).toBe(before)
  })

  it('a refused posting keeps the drop and raises posting_failed in the drop\'s company', async () => {
    await lockToday(L.tenantId)
    const r = await call(ceoL, 'POST', '/trustops/deposit-drops', { amountCents: 12_300, receiptUrl: 'https://example.com/slip.jpg' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().posted).toBe(false)
    expect(r.json().postingError).toMatch(/closed/)
    expect(await prisma.depositDrop.count({ where: { id: r.json().id } })).toBe(1)
    expect(await prisma.journalEntry.count({ where: { reference: `deposit.drop:${r.json().id}` } })).toBe(0)
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'posting_failed', entityType: 'DepositDrop', entityId: r.json().id } })
    expect(flag.tenantId).toBe(L.tenantId)
    expect(flag.metadata).toMatchObject({ sourceType: 'deposit.drop', sourceId: r.json().id })
    // A PKR 0 drop is not a failed posting.
    const zero = await call(ceoL, 'POST', '/trustops/deposit-drops', { amountCents: 0 })
    expect(zero.json()).toMatchObject({ posted: false, postingError: null })
    expect(await prisma.exceptionFlag.count({ where: { kind: 'posting_failed', entityId: zero.json().id } })).toBe(0)
  })
})

// ─── Cash on delivery ─────────────────────────────────────────────────────────

describe('cash on delivery', () => {
  let rider: string
  let cod: string        // A, delivered 13 h ago, PKR 6,000 (severity 2), still pending
  let fresh: string      // A, delivered 1 h ago
  const codOrder = async (co: Company, cents: number, opts: { status?: 'completed' | 'received'; pay?: 'pending' | 'paid'; source?: 'servd' | 'pos'; deliveredHoursAgo?: number } = {}) => {
    const id = await mkOrder(co, {
      items: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: cents }], taxCents: 0, taxRatePct: 15, totalCents: cents,
      status: opts.status ?? 'completed', customer: { name: 'COD Customer' },
      payments: [{ method: 'cash', amountCents: cents, status: opts.pay ?? 'pending' }],
    })
    await prisma.order.update({
      where: { id },
      data: {
        source: opts.source ?? 'servd', riderId: co === A ? rider : null,
        ...(opts.deliveredHoursAgo !== undefined && { deliveredAt: new Date(Date.now() - opts.deliveredHoursAgo * 3_600_000) }),
      },
    })
    return id
  }

  beforeAll(async () => {
    rider = (await prisma.rider.create({ data: { name: 'Rider Rashid', phone: `923${randomBytes(4).toString('hex').replace(/[^0-9]/g, '5').slice(0, 9)}`, tenantId: A.tenantId } })).id
    cod = await codOrder(A, 600_000, { deliveredHoursAgo: 13 })
    fresh = await codOrder(A, 40_000, { deliveredHoursAgo: 1 })
  })

  it('cod-due names the rider, the age and the overdue ones', async () => {
    const r = await call(ceoA, 'GET', '/pos/cod-due')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().overdueAfterHours).toBe(12)
    const rows = r.json().payments as Array<{ order: { id: string }; rider: { id: string; name: string } | null; hoursSinceDelivered: number; overdue: boolean }>
    const late = rows.find((p) => p.order.id === cod)!
    expect(late.rider).toEqual({ id: rider, name: 'Rider Rashid' })
    expect(late.hoursSinceDelivered).toBeGreaterThanOrEqual(12.9)
    expect(late.overdue).toBe(true)
    expect(rows.find((p) => p.order.id === fresh)).toMatchObject({ overdue: false })
    expect((await call(ceoB, 'GET', '/pos/cod-due')).json().payments.map((p: { order: { id: string } }) => p.order.id)).not.toContain(cod)
  })

  it('cod-unpaid: managers only, and only a completed COD whose cash is still out', async () => {
    expect((await call(cashA, 'POST', `/orders/${cod}/cod-unpaid`, {})).statusCode).toBe(403)
    expect((await call(ceoB, 'POST', `/orders/${cod}/cod-unpaid`, {})).statusCode).toBe(404)
    const till = await codOrder(A, 10_000, { source: 'pos' })
    expect((await call(ceoA, 'POST', `/orders/${till}/cod-unpaid`, {})).json().error.code).toBe('NOT_CASH_ON_DELIVERY')
    const open = await codOrder(A, 10_000, { status: 'received' })
    expect((await call(ceoA, 'POST', `/orders/${open}/cod-unpaid`, {})).json().error.code).toBe('ORDER_NOT_COMPLETED')
    const paid = await codOrder(A, 10_000, { pay: 'paid' })
    expect((await call(ceoA, 'POST', `/orders/${paid}/cod-unpaid`, {})).json().error.code).toBe('COD_ALREADY_PAID')
    expect(await prisma.customerStrike.count({ where: { sourceId: { in: [till, open, paid] } } })).toBe(0)
  })

  it('one strike per order, audited in the order\'s company, the books untouched', async () => {
    const entriesBefore = await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })
    // "both" works in B; the order is A's.
    const first = await call(both, 'POST', `/orders/${cod}/cod-unpaid`, { reason: 'Rider says the customer refused to pay' })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ ok: true, severity: 2, duplicate: false, unpaidCents: 600_000 })
    const again = await call(ceoA, 'POST', `/orders/${cod}/cod-unpaid`, {})
    expect(again.json()).toMatchObject({ ok: true, duplicate: true })

    const strikes = await prisma.customerStrike.findMany({ where: { sourceType: 'order', sourceId: cod } })
    expect(strikes).toHaveLength(1)
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: strikes[0]!.customerId } })
    expect(customer.strikeCount).toBe(2)   // two reports of a PKR 6,000 order no longer make 4 → a ban
    expect(customer.bannedAt).toBeNull()

    const audits = await prisma.auditLog.findMany({ where: { action: 'order.cod_unpaid', entityId: cod } })
    expect(audits.map((x) => x.tenantId)).toEqual([A.tenantId, A.tenantId])
    // G1 pending: no posting, the cash row still pending.
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })).toBe(entriesBefore)
    expect((await prisma.payment.findFirstOrThrow({ where: { orderId: cod } })).status).toBe('pending')
  })

  it('by-tender keeps COD not in a drawer out of Cash: with the rider, or reported not collected', async () => {
    const r = await call(finA, 'GET', `/reports/by-tender?dateFrom=${DAY}&dateTo=${DAY}`)
    expect(r.statusCode, r.body).toBe(200)
    const by = new Map((r.json().tenders as Array<{ tender: string; amountCents: number; label: string }>).map((t) => [t.tender, t]))
    expect(by.get('cod_not_collected')).toMatchObject({ amountCents: 600_000, label: 'Cash on delivery – not collected' })
    // fresh (40,000) + the received order is not sold; the till order's
    // pending row is not money; the paid COD (10,000) is drawer cash.
    expect(by.get('cod_with_rider')).toMatchObject({ amountCents: 40_000 })
    expect(by.get('cash')).toMatchObject({ amountCents: 10_000 })
    expect(r.json().cod).toEqual({ paidInCents: 10_000, paidInCount: 1, withRiderCents: 40_000, withRiderCount: 1, notCollectedCents: 600_000, notCollectedCount: 1 })
    const total = (r.json().tenders as Array<{ amountCents: number }>).reduce((s, t) => s + t.amountCents, 0)
    expect(r.json().totalCents).toBe(total)
  })
})

// ─── Reservation deposits ─────────────────────────────────────────────────────

describe('reservation deposits', () => {
  const mkRes = (co: Company, depositCents: number) => prisma.reservation.create({
    data: {
      conceptId: co.conceptId, partySize: 2, guestName: 'Deposit Guest', source: 'staff', status: 'confirmed', depositCents, depositRef: 'KEENU-77',
      startTime: new Date(Date.now() - 3 * 3_600_000), endTime: new Date(Date.now() - 90 * 60_000),
    },
  })

  it('release: audited in the reservation\'s company; nothing held → 409; a stranger → 404', async () => {
    const r = await mkRes(A, 50_000)
    expect((await call(ceoB, 'POST', `/reservations/${r.id}/deposit-release`)).statusCode).toBe(404)
    const ok = await call(both, 'POST', `/reservations/${r.id}/deposit-release`)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ depositCents: 0, depositRef: null })
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'reservation.deposit_release', entityId: r.id } })
    expect(a.tenantId).toBe(A.tenantId)
    const again = await call(ceoA, 'POST', `/reservations/${r.id}/deposit-release`)
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('NO_DEPOSIT_HELD')
  })

  it('a no-show captures to 1030 dated now, tagged with the brand, and zeroes the deposit', async () => {
    const r = await mkRes(A, 80_000)
    const t0 = Date.now()
    const out = await markNoShow(r.id, { reason: 'No-show', actorId: ceoA.id })
    expect(out.marked).toBe(true)
    if (out.marked) expect(out.depositCapturedCents).toBe(80_000)
    const je = await prisma.journalEntry.findFirstOrThrow({
      where: { tenantId: A.tenantId, reference: `reservation.deposit_capture:${r.id}` },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    expect(je.lines.map((l) => [l.account.code, l.type, l.amountCents, l.conceptId]).sort()).toEqual([
      ['1030', 'debit', 80_000, A.conceptId], ['4100', 'credit', 80_000, A.conceptId],
    ])
    expect(je.entryDate.getTime()).toBeGreaterThanOrEqual(t0 - 1_000)
    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
    expect(after).toMatchObject({ status: 'no_show', depositCents: 0 })
    expect((await call(ceoA, 'POST', `/reservations/${r.id}/deposit-release`)).json().error.code).toBe('NO_DEPOSIT_HELD')
  })

  it('a refused capture leaves the deposit held and flags posting_failed in the brand\'s company', async () => {
    const r = await mkRes(L, 30_000)   // L's books are locked through tomorrow
    const out = await markNoShow(r.id, { reason: 'No-show', actorId: ceoL.id })
    expect(out.marked).toBe(true)
    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
    expect(after).toMatchObject({ status: 'no_show', depositCents: 30_000 })
    expect(await prisma.journalEntry.count({ where: { reference: `reservation.deposit_capture:${r.id}` } })).toBe(0)
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'posting_failed', entityType: 'Reservation', entityId: r.id } })
    expect(flag.tenantId).toBe(L.tenantId)
    expect(flag.metadata).toMatchObject({ sourceType: 'reservation.deposit_capture' })
  })
})

// ─── Bank-statement import ────────────────────────────────────────────────────

describe('bank-statement import: already-matched lines are read per company', () => {
  it('another company\'s matched line never blocks this company\'s match', async () => {
    const posted = await postJournalEntry({
      tenantId: B.tenantId, sourceType: 'test.deposit', sourceId: `cc-${randomBytes(3).toString('hex')}`, description: 'Cash to bank',
      lines: [{ accountCode: '1020', type: 'debit', amountCents: 77_700 }, { accountCode: '1010', type: 'credit', amountCents: 77_700 }],
    })
    const jl = await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: posted.entryId, type: 'debit' } })
    // A stray matched line of company A pointing at it (it must not count for B).
    const stray = await prisma.bankStatementImport.create({
      data: { tenantId: A.tenantId, source: 'csv', accountCode: '1020', statementDate: new Date(), openingBalanceCents: 0, closingBalanceCents: 0 },
    })
    await prisma.bankStatementLine.create({
      data: { importId: stray.id, postedDate: new Date(), description: 'stray', amountCents: 77_700, matchStatus: 'matched', matchedJournalLineId: jl.id },
    })
    const today = new Date().toISOString().slice(0, 10)
    const res = await importBankStatement({
      tenantId: B.tenantId, source: 'csv', accountCode: '1020', statementDate: new Date(), openingBalanceCents: 0, closingBalanceCents: 77_700,
      csv: `Date,Description,Amount\n${today},Cash deposit,777.00\n`,
    })
    expect(res.matchedCount).toBe(1)
    const line = await prisma.bankStatementLine.findFirstOrThrow({ where: { importId: res.importId } })
    expect(line.matchedJournalLineId).toBe(jl.id)
  })
})
