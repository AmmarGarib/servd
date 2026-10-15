// COD custody money (H5) — lib/cod.ts, accounting/codPosting.ts,
// reconciliation/codRoutes.ts.
//
// Two companies A and B, both with code-only delivery switched on. What this
// defends:
//   - B's finance user gets 404 on A's payment (write scope through the brand);
//   - an own rider's debt posts Dr 1351 / Cr 1010 in A under
//     'cod.rider_debt:<paymentId>' (brand on both lines); a replay is a no-op;
//   - refusals: a POS order, a paid row, a pickup (at_counter), a delivery
//     completed without the code, a sale not on the books, a cashier (403), a
//     role without the reconciliation module (403), a company with COD custody
//     off (409), a closed period (422, nothing saved);
//   - the legacy path: finance with a reason books it (and leaves a note);
//     management is 403 LEGACY_NEEDS_FINANCE;
//   - a fleet rider of B on A's order: an A-only finance user is 403; a finance
//     user of A and B books an inter-company transfer (source 'cod') in both books;
//   - reverseCodRiderDebtTx posts 'cod.rider_debt.reversal:<pid>' Dr 1010 /
//     Cr 1351; the fleet reversal runs after commit; the re-poster posts a
//     reversal that was refused and closes one already done.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { DELIVERY_CODE_ONLY_SETTING } = await import('../src/lib/deliveryRules.js')
const cod = await import('../src/lib/cod.js')
const posting = await import('../src/modules/accounting/codPosting.js')
const { default: codRoutes } = await import('../src/modules/reconciliation/codRoutes.js')

const PREFIX = `cod-${Date.now()}`
let app: FastifyInstance
let A: string, B: string
let brandA: string, brandB: string
let riderA: string, riderB: string

interface Who { id: string; token: string }
let finA: Who, finB: Who, finAB: Who, mgmtA: Who, cashierA: Who, fnbA: Who, adminA: Who

const DAY = 86_400_000
const switchOnAt = new Date(Date.now() - DAY)

async function mkTenant(name: string): Promise<string> {
  const id = (await prisma.tenant.create({ data: { name, slug: `${PREFIX}-${name.toLowerCase().replace(/\s+/g, '-')}` } })).id
  await ensureChartOfAccounts(id)
  return id
}

async function mkUser(key: string, role: string, tenants: string[], active = tenants[0]!): Promise<Who> {
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${key}`, email: `${PREFIX}.${key}@cod.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as 'finance', tenantId: active, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((t) => ({ tenant: { connect: { id: t } }, role: 'manager' })) },
    },
  })
  return { id: u.id, token: `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}` }
}

const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/reconciliation/cod${url}`, headers: { authorization: who.token }, ...(payload !== undefined ? { payload: payload as object } : {}) })

let seq = 0
interface CodOpts {
  conceptId?: string
  riderId?: string | null
  fulfilmentType?: 'delivery' | 'takeout' | 'dine_in'
  source?: 'servd' | 'pos'
  code?: boolean
  completedAt?: Date
  status?: 'pending' | 'paid'
  booked?: boolean
  tenantId?: string
}
/** A completed order with one cash payment; its sale on the books unless booked: false. */
async function mkCod(o: CodOpts = {}): Promise<{ orderId: string; paymentId: string; amount: number }> {
  seq += 1
  const amount = 150_000 + seq
  const completedAt = o.completedAt ?? new Date()
  const order = await prisma.order.create({
    data: {
      conceptId: o.conceptId ?? brandA, source: o.source ?? 'servd', fulfilmentType: o.fulfilmentType ?? 'delivery',
      status: 'completed', totalCents: amount, customerName: `Customer ${seq}`,
      riderId: o.riderId === undefined ? riderA : o.riderId,
      deliveryOtpVerifiedAt: o.code === false ? null : completedAt,
      completedAt, deliveredAt: completedAt,
    },
  })
  const p = await prisma.payment.create({ data: { orderId: order.id, method: 'cash', amountCents: amount, status: o.status ?? 'pending' } })
  if (o.booked !== false) {
    await prisma.journalEntry.create({ data: { tenantId: o.tenantId ?? A, reference: `order.complete:${order.id}`, description: 'test sale' } })
  }
  return { orderId: order.id, paymentId: p.id, amount }
}

async function entryLines(tenantId: string, reference: string) {
  const e = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return e ? e.lines.map((l) => ({ code: l.account.code, type: l.type, cents: Number(l.amountCents), conceptId: l.conceptId })) : null
}

beforeAll(async () => {
  A = await mkTenant('Cod Alpha')
  B = await mkTenant('Cod Beta')
  brandA = (await prisma.concept.create({ data: { name: 'Alpha Brand', slug: `${PREFIX}-a`, type: 'restaurant', tenantId: A } })).id
  brandB = (await prisma.concept.create({ data: { name: 'Beta Brand', slug: `${PREFIX}-b`, type: 'restaurant', tenantId: B } })).id
  riderA = (await prisma.rider.create({ data: { name: 'Asif Rider', phone: `92311${Date.now() % 10_000_000}`, tenantId: A } })).id
  riderB = (await prisma.rider.create({ data: { name: 'Bilal Rider', phone: `92312${Date.now() % 10_000_000}`, tenantId: B } })).id
  finA = await mkUser('fin-a', 'finance', [A])
  finB = await mkUser('fin-b', 'finance', [B])
  finAB = await mkUser('fin-ab', 'finance', [A, B])
  mgmtA = await mkUser('mgmt-a', 'management', [A])
  cashierA = await mkUser('cashier-a', 'cashier', [A])
  fnbA = await mkUser('fnb-a', 'fnb_manager', [A])
  adminA = await mkUser('admin-a', 'admin', [A])
  for (const t of [A, B]) {
    await prisma.setting.create({ data: { key: `${DELIVERY_CODE_ONLY_SETTING}:${t}`, value: switchOnAt.toISOString() } })
  }

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(codRoutes, { prefix: '/reconciliation/cod' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('lib/cod.ts — the one definition', () => {
  const now = new Date('2026-10-15T12:00:00Z')
  const p = { codRiderDebtAt: null, createdAt: new Date('2026-10-15T00:00:00Z') }
  it('classifies at_counter, rider_owes, overdue and with_rider', () => {
    expect(cod.codStatusOf(p, { fulfilmentType: 'takeout', riderId: 'r', completedAt: now }, now)).toBe('at_counter')
    expect(cod.codStatusOf(p, { fulfilmentType: 'delivery', riderId: null, completedAt: now }, now)).toBe('at_counter')
    expect(cod.codStatusOf({ ...p, codRiderDebtAt: now }, { fulfilmentType: 'delivery', riderId: 'r', completedAt: now }, now)).toBe('rider_owes')
    const late = new Date(now.getTime() - cod.COD_PAY_IN_HOURS * 3_600_000)
    expect(cod.codStatusOf(p, { fulfilmentType: 'delivery', riderId: 'r', deliveredAt: late, completedAt: now }, now)).toBe('overdue')
    expect(cod.codStatusOf(p, { fulfilmentType: 'delivery', riderId: 'r', deliveredAt: new Date(now.getTime() - 3_600_000), completedAt: null }, now)).toBe('with_rider')
  })

  it('riderCashHeldCents sums the rider\'s pending delivered COD only', async () => {
    const rider = (await prisma.rider.create({ data: { name: 'Held', phone: `92319${Date.now() % 10_000_000}`, tenantId: A } })).id
    const one = await mkCod({ riderId: rider })
    const two = await mkCod({ riderId: rider, conceptId: brandB, tenantId: B })
    await mkCod({ riderId: rider, status: 'paid' })
    await mkCod({ riderId: rider, source: 'pos' })
    expect(await cod.riderCashHeldCents(prisma, rider)).toBe(one.amount + two.amount)
  })
})

describe('POST /reconciliation/cod/:paymentId/rider-debt — own rider', () => {
  let own: { orderId: string; paymentId: string; amount: number }

  it('B finance → 404 on A\'s payment', async () => {
    own = await mkCod()
    const r = await call(finB, 'POST', `/${own.paymentId}/rider-debt`, { reason: 'rider kept the cash' })
    expect(r.statusCode).toBe(404)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: own.paymentId } })).codRiderDebtAt).toBeNull()
  })

  it('A finance books Dr 1351 / Cr 1010 under cod.rider_debt:<pid>; a replay is a no-op', async () => {
    const r = await call(finA, 'POST', `/${own.paymentId}/rider-debt`, { reason: 'rider kept the cash' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.ok).toBe(true)
    expect(body.entryId).toBeTruthy()
    const lines = await entryLines(A, `cod.rider_debt:${own.paymentId}`)
    expect(lines).toHaveLength(2)
    expect(lines).toEqual(expect.arrayContaining([
      { code: '1351', type: 'debit', cents: own.amount, conceptId: brandA },
      { code: '1010', type: 'credit', cents: own.amount, conceptId: brandA },
    ]))
    const pay = await prisma.payment.findUniqueOrThrow({ where: { id: own.paymentId } })
    expect(pay.codRiderDebtAt).toBeTruthy()
    expect(pay.codRiderDebtById).toBe(finA.id)
    expect(pay.codRiderDebtEntryId).toBe(body.entryId)
    expect(await prisma.auditLog.count({ where: { entityId: own.paymentId, action: 'cod.rider_debt.book', tenantId: A } })).toBe(1)

    const again = await call(finA, 'POST', `/${own.paymentId}/rider-debt`, { reason: 'rider kept the cash' })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ ok: true, alreadyBooked: true, entryId: body.entryId })
    expect(await prisma.journalEntry.count({ where: { reference: `cod.rider_debt:${own.paymentId}` } })).toBe(1)
  })

  it('GET lists it as rider_owes with who booked it; B sees nothing of A', async () => {
    const r = await call(finA, 'GET', '/?status=rider_owes')
    expect(r.statusCode).toBe(200)
    const row = r.json().rows.find((x: { paymentId: string }) => x.paymentId === own.paymentId)
    expect(row).toMatchObject({ status: 'rider_owes', brand: 'Alpha Brand', amountCents: own.amount, rider: { id: riderA, name: 'Asif Rider', companyName: 'Cod Alpha' } })
    expect(row.riderOwes.byName).toBe(`${PREFIX} fin-a`)
    const withRider = (await call(finA, 'GET', '/?status=with_rider')).json().rows
    expect(withRider.some((x: { paymentId: string }) => x.paymentId === own.paymentId)).toBe(false)
    const b = (await call(finB, 'GET', '/')).json().rows
    expect(b.some((x: { paymentId: string }) => x.paymentId === own.paymentId)).toBe(false)
    expect((await call(finA, 'GET', '/enabled')).json()).toEqual({ enabled: true })
  })

  it('refuses a POS order, a paid row, a pickup, no code, no sale on the books', async () => {
    const reason = { reason: 'rider kept the cash' }
    const pos = await mkCod({ source: 'pos' })
    expect((await call(finA, 'POST', `/${pos.paymentId}/rider-debt`, reason)).json().error.code).toBe('NOT_CASH_ON_DELIVERY')
    const paid = await mkCod({ status: 'paid' })
    const rp = await call(finA, 'POST', `/${paid.paymentId}/rider-debt`, reason)
    expect([rp.statusCode, rp.json().error.code]).toEqual([409, 'COD_ALREADY_PAID'])
    const pickup = await mkCod({ fulfilmentType: 'takeout', riderId: null })
    const rk = await call(finA, 'POST', `/${pickup.paymentId}/rider-debt`, reason)
    expect([rk.statusCode, rk.json().error.code]).toEqual([422, 'NO_RIDER'])
    const atCounter = (await call(finA, 'GET', '/?status=at_counter')).json().rows
    expect(atCounter.some((x: { paymentId: string }) => x.paymentId === pickup.paymentId)).toBe(true)
    const noCode = await mkCod({ code: false })
    const rn = await call(finA, 'POST', `/${noCode.paymentId}/rider-debt`, reason)
    expect([rn.statusCode, rn.json().error.code]).toEqual([409, 'COD_NOT_DELIVERED_WITH_CODE'])
    // legacy: true cannot open a delivery completed after code-only came on.
    const rnl = await call(finA, 'POST', `/${noCode.paymentId}/rider-debt`, { reason: 'old flow, no code at all', legacy: true })
    expect(rnl.json().error.code).toBe('COD_NOT_DELIVERED_WITH_CODE')
    const unbooked = await mkCod({ booked: false })
    const ru = await call(finA, 'POST', `/${unbooked.paymentId}/rider-debt`, reason)
    expect([ru.statusCode, ru.json().error.code]).toEqual([409, 'COD_SALE_NOT_BOOKED'])
    for (const id of [pos, paid, pickup, noCode, unbooked].map((x) => x.paymentId)) {
      expect((await prisma.payment.findUniqueOrThrow({ where: { id } })).codRiderDebtAt).toBeNull()
    }
    expect(await prisma.journalEntry.count({ where: { reference: { in: [pos, paid, pickup, noCode, unbooked].map((x) => `cod.rider_debt:${x.paymentId}`) } } })).toBe(0)
  })

  it('a cashier is 403; a role without the reconciliation module is 403', async () => {
    const x = await mkCod()
    expect((await call(cashierA, 'POST', `/${x.paymentId}/rider-debt`, { reason: 'rider kept the cash' })).statusCode).toBe(403)
    expect((await call(cashierA, 'GET', '/')).statusCode).toBe(403)
    expect((await call(fnbA, 'GET', '/')).statusCode).toBe(403)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: x.paymentId } })).codRiderDebtAt).toBeNull()
  })

  it('COD custody off for the company → 409, nothing saved', async () => {
    const x = await mkCod()
    await prisma.setting.delete({ where: { key: `${DELIVERY_CODE_ONLY_SETTING}:${A}` } })
    try {
      const r = await call(finA, 'POST', `/${x.paymentId}/rider-debt`, { reason: 'rider kept the cash' })
      expect([r.statusCode, r.json().error.code]).toEqual([409, 'COD_CUSTODY_OFF'])
      expect((await call(finA, 'GET', '/enabled')).json()).toEqual({ enabled: false })
      expect((await call(finA, 'GET', '/')).json().rows).toEqual([])
    } finally {
      await prisma.setting.create({ data: { key: `${DELIVERY_CODE_ONLY_SETTING}:${A}`, value: switchOnAt.toISOString() } })
    }
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: x.paymentId } })).codRiderDebtAt).toBeNull()
  })

  it('a reason under 5 characters is refused', async () => {
    const x = await mkCod()
    expect((await call(finA, 'POST', `/${x.paymentId}/rider-debt`, { reason: 'no' })).statusCode).toBe(400)
  })
})

describe('legacy path (delivered before code-only, no customer code)', () => {
  it('management → 403 LEGACY_NEEDS_FINANCE; finance with a reason books it and leaves a note', async () => {
    const old = await mkCod({ code: false, completedAt: new Date(switchOnAt.getTime() - DAY) })
    const rm = await call(mgmtA, 'POST', `/${old.paymentId}/rider-debt`, { reason: 'old flow, rider kept it', legacy: true })
    expect([rm.statusCode, rm.json().error.code]).toEqual([403, 'LEGACY_NEEDS_FINANCE'])
    const short = await call(finA, 'POST', `/${old.paymentId}/rider-debt`, { reason: 'old flow', legacy: true })
    expect(short.json().error.code).toBe('REASON_TOO_SHORT')
    const without = await call(finA, 'POST', `/${old.paymentId}/rider-debt`, { reason: 'old flow, rider kept it' })
    expect(without.json().error.code).toBe('COD_NOT_DELIVERED_WITH_CODE')
    const ok = await call(finA, 'POST', `/${old.paymentId}/rider-debt`, { reason: 'old flow, rider kept it', legacy: true })
    expect(ok.statusCode).toBe(200)
    expect(await entryLines(A, `cod.rider_debt:${old.paymentId}`)).toHaveLength(2)
    expect(await prisma.auditLog.count({ where: { entityId: old.paymentId, action: 'cod.rider_debt.book_legacy' } })).toBe(1)
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'cod_cash_overdue', entityId: old.paymentId } })
    expect(flag?.tenantId).toBe(A)
    expect(flag?.metadata).toMatchObject({ legacy: true })
  })

  it('the CEO (admin) may book a legacy one too', async () => {
    const old = await mkCod({ code: false, completedAt: new Date(switchOnAt.getTime() - 2 * DAY) })
    const r = await call(adminA, 'POST', `/${old.paymentId}/rider-debt`, { reason: 'old flow, rider kept it', legacy: true })
    expect(r.statusCode).toBe(200)
  })
})

describe('fleet rider of B on A\'s order', () => {
  let fl: { orderId: string; paymentId: string; amount: number }

  it('an A-only finance user → 403 NOT_IN_BOTH_COMPANIES', async () => {
    fl = await mkCod({ riderId: riderB })
    const r = await call(finA, 'POST', `/${fl.paymentId}/rider-debt`, { reason: 'fleet rider kept the cash' })
    expect([r.statusCode, r.json().error.code]).toEqual([403, 'NOT_IN_BOTH_COMPANIES'])
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: fl.paymentId } })).codRiderDebtAt).toBeNull()
  })

  it('a finance user of A and B books an inter-company transfer (source cod) in both books', async () => {
    const r = await call(finAB, 'POST', `/${fl.paymentId}/rider-debt`, { reason: 'fleet rider kept the cash' })
    expect(r.statusCode).toBe(200)
    const { transferId } = r.json()
    expect(transferId).toBeTruthy()
    const t = await prisma.intercompanyTransfer.findUniqueOrThrow({ where: { id: transferId } })
    expect(t).toMatchObject({
      tenantId: B, counterpartyTenantId: A, source: 'cod', sourceRef: `cod:${fl.paymentId}`, status: 'posted',
      debtorAccountCode: '1351', creditorAccountCode: '1010',
    })
    expect(Number(t.amountCents)).toBe(fl.amount)
    const bLines = await entryLines(B, `ic.transfer:${transferId}`)
    const aLines = await entryLines(A, `ic.transfer:${transferId}`)
    expect(bLines).toEqual(expect.arrayContaining([expect.objectContaining({ code: '1351', type: 'debit', cents: fl.amount })]))
    expect(bLines!.find((l) => l.type === 'credit')!.code).toMatch(/^21[5-9]\d$/) // Due to A
    expect(aLines).toEqual(expect.arrayContaining([expect.objectContaining({ code: '1010', type: 'credit', cents: fl.amount })]))
    expect(aLines!.find((l) => l.type === 'debit')!.code).toMatch(/^14[5-9]\d$/) // Due from B
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: fl.paymentId } })).codRiderDebtTransferId).toBe(transferId)
    expect(await prisma.journalEntry.count({ where: { reference: `cod.rider_debt:${fl.paymentId}` } })).toBe(0)
    const again = await call(finAB, 'POST', `/${fl.paymentId}/rider-debt`, { reason: 'fleet rider kept the cash' })
    expect(again.json()).toMatchObject({ alreadyBooked: true, transferId })
  })

  it('the pay-in reverses the fleet transfer after commit', async () => {
    await prisma.payment.update({ where: { id: fl.paymentId }, data: { status: 'paid' } })
    const r = await prisma.$transaction((tx) => posting.reverseCodRiderDebtTx(tx, { paymentId: fl.paymentId, tenantId: A }))
    expect(r).toEqual({ reversed: false, needsAfterCommit: true })
    await posting.reverseCodRiderDebtAfterCommit(fl.paymentId)
    const t = await prisma.intercompanyTransfer.findFirstOrThrow({ where: { id: (await prisma.payment.findUniqueOrThrow({ where: { id: fl.paymentId } })).codRiderDebtTransferId! } })
    expect(t.status).toBe('reversed')
    // Idempotent.
    await posting.reverseCodRiderDebtAfterCommit(fl.paymentId)
    const doc = await posting.codRiderDebtReversalReposter.load(fl.paymentId, null)
    expect(doc?.nothingOwed).toBeTruthy()
  })
})

describe('reversal when the rider hands the cash in (own rider)', () => {
  it('reverseCodRiderDebtTx posts cod.rider_debt.reversal:<pid> Dr 1010 / Cr 1351', async () => {
    const x = await mkCod()
    expect((await call(finA, 'POST', `/${x.paymentId}/rider-debt`, { reason: 'rider kept the cash' })).statusCode).toBe(200)
    // Still pending: the re-poster never reverses a debt still owed.
    const pending = await posting.codRiderDebtReversalReposter.load(x.paymentId, null)
    expect(pending?.nothingOwed).toMatch(/not handed this cash in/)
    expect((await posting.reverseCodRiderDebt(x.paymentId)).reason).toBe('not_paid_in')

    await prisma.payment.update({ where: { id: x.paymentId }, data: { status: 'paid' } })
    const r = await prisma.$transaction((tx) => posting.reverseCodRiderDebtTx(tx, { paymentId: x.paymentId, tenantId: A }))
    expect(r).toEqual({ reversed: true, needsAfterCommit: false })
    expect(await entryLines(A, `cod.rider_debt.reversal:${x.paymentId}`)).toEqual(expect.arrayContaining([
      { code: '1010', type: 'debit', cents: x.amount, conceptId: brandA },
      { code: '1351', type: 'credit', cents: x.amount, conceptId: brandA },
    ]))
    const again = await prisma.$transaction((tx) => posting.reverseCodRiderDebtTx(tx, { paymentId: x.paymentId, tenantId: A }))
    expect(again.reversed).toBe(false)
    expect(await prisma.journalEntry.count({ where: { reference: `cod.rider_debt.reversal:${x.paymentId}` } })).toBe(1)
    const doc = await posting.codRiderDebtReversalReposter.load(x.paymentId, null)
    expect(doc?.nothingOwed).toMatch(/already reversed/)
  })

  it('the re-poster posts a reversal that was refused', async () => {
    const x = await mkCod()
    expect((await call(finA, 'POST', `/${x.paymentId}/rider-debt`, { reason: 'rider kept the cash' })).statusCode).toBe(200)
    await prisma.payment.update({ where: { id: x.paymentId }, data: { status: 'paid', processedAt: new Date() } })
    const doc = await posting.codRiderDebtReversalReposter.load(x.paymentId, null)
    expect(doc).toMatchObject({ tenantId: A, amountCents: x.amount })
    expect(doc!.nothingOwed).toBeUndefined()
    const res = await doc!.post({ postedBy: finA.id })
    expect(res.posted).toBe(true)
    expect(res.entryId).toBeTruthy()
    expect(await entryLines(A, `cod.rider_debt.reversal:${x.paymentId}`)).toHaveLength(2)
  })
})

describe('closed period', () => {
  it('a month closed through today → 422 PERIOD_LOCKED, nothing saved', async () => {
    const x = await mkCod()
    const lock = await prisma.periodLock.create({ data: { tenantId: A, lockedThrough: new Date(Date.now() + DAY), lockedBy: adminA.id } })
    try {
      const r = await call(finA, 'POST', `/${x.paymentId}/rider-debt`, { reason: 'rider kept the cash' })
      expect([r.statusCode, r.json().error.code]).toEqual([422, 'PERIOD_LOCKED'])
      const fleet = await mkCod({ riderId: riderB })
      const rf = await call(finAB, 'POST', `/${fleet.paymentId}/rider-debt`, { reason: 'fleet rider kept the cash' })
      expect([rf.statusCode, rf.json().error.code]).toEqual([422, 'PERIOD_LOCKED'])
      for (const id of [x.paymentId, fleet.paymentId]) {
        const p = await prisma.payment.findUniqueOrThrow({ where: { id } })
        expect(p.codRiderDebtAt).toBeNull()
        expect(p.codRiderDebtTransferId).toBeNull()
      }
      expect(await prisma.intercompanyTransfer.count({ where: { sourceRef: `cod:${fleet.paymentId}` } })).toBe(0)
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
  })
})
