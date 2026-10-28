// Cash flow categories (FA critic V6, CA plan): a capex.* / fixed_asset.*
// entry is categorised line by line by its NON-cash lines — advances (1340),
// fixed assets (15xx), deposits (1360) and capital payables (2012) are
// investing; prepaid rent (1310), expenses (6xxx) and withholding (2040) are
// operating. A prepaid release moves no cash. Petty cash (1011) is a cash
// account, so a top-up from the safe is a transfer, not an outflow.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry, type JournalLineInput } from '../src/modules/accounting/journal.js'
import { parsePktEndOfDay, parsePktStartOfDay } from '../src/modules/accounting/dates.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { cashFlow } from '../src/modules/accounting/reports.js'

let A: string
let B: string
let app: FastifyInstance
let token: string
const from = parsePktStartOfDay('2026-08-01')
const to = parsePktEndOfDay('2026-08-31')

let n = 0
const post = (tenantId: string, sourceType: string, lines: JournalLineInput[], at = '2026-08-10T07:00:00Z') =>
  postJournalEntry({ tenantId, sourceType, sourceId: `cf${n++}`, description: sourceType, entryDate: new Date(at), lines })

const cat = (r: Awaited<ReturnType<typeof cashFlow>>, c: 'operating' | 'investing' | 'financing') => r.byCategory.find((x) => x.category === c)!

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'Flow Foods', slug: 'cfc-a' } })).id
  B = (await prisma.tenant.create({ data: { name: 'Flow Viva', slug: 'cfc-b' } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  const u = await prisma.user.create({
    data: { name: 'fin', email: 'fin.cfc@gsfoods.pk', password: await bcrypt.hash('x-Password-1', 4), role: 'finance', isActive: true, accountStatus: 'active', tenantId: A },
  })
  await prisma.tenantMember.create({ data: { tenantId: A, userId: u.id } })
  token = (issueStaffSession(u) as { accessToken: string }).accessToken
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('capex and register entries are categorised by their non-cash lines', () => {
  it('a CapEx instalment (advance less WHT) is investing; prepaid rent through CapEx is operating; a release has no cash line', async () => {
    // Instalment: Dr 1340 100,000 / Cr 2040 5,000 / Cr 1020 95,000.
    await post(A, 'capex.payment', [
      { accountCode: '1340', type: 'debit', amountCents: 10_000_000 },
      { accountCode: '2040', type: 'credit', amountCents: 500_000 },
      { accountCode: '1020', type: 'credit', amountCents: 9_500_000 },
    ])
    // Rent advance paid through CapEx: Dr 1310 / Cr 1020.
    await post(A, 'capex.payment', [
      { accountCode: '1310', type: 'debit', amountCents: 3_000_000 },
      { accountCode: '1020', type: 'credit', amountCents: 3_000_000 },
    ])
    // Its monthly release: no cash line, so not in the report at all.
    await post(A, 'prepaid.release', [
      { accountCode: '6010', type: 'debit', amountCents: 1_000_000 },
      { accountCode: '1310', type: 'credit', amountCents: 1_000_000 },
    ])
    const r = await cashFlow([A], from, to)
    expect(cat(r, 'investing').outflowCents).toBe(9_500_000)
    expect(cat(r, 'operating').outflowCents).toBe(3_000_000)
    expect(r.totals.outflowCents).toBe(12_500_000)
  })

  it('one CapEx payment with a deposit and a broker fee splits: deposit investing, fee operating', async () => {
    const before = await cashFlow([A], from, to)
    // Dr 1360 deposit 200,000 / Dr 6110 broker 50,000 / Cr 1020 250,000.
    await post(A, 'capex.payment', [
      { accountCode: '1360', type: 'debit', amountCents: 20_000_000 },
      { accountCode: '6110', type: 'debit', amountCents: 5_000_000 },
      { accountCode: '1020', type: 'credit', amountCents: 25_000_000 },
    ])
    const r = await cashFlow([A], from, to)
    expect(cat(r, 'investing').outflowCents - cat(before, 'investing').outflowCents).toBe(20_000_000)
    expect(cat(r, 'operating').outflowCents - cat(before, 'operating').outflowCents).toBe(5_000_000)
  })

  it('disposal proceeds on a fixed_asset.* entry are investing inflow', async () => {
    const before = await cashFlow([A], from, to)
    // Sold for 50,000: Dr 1020 50,000 / Dr 1591 30,000 / Cr 1510 80,000.
    await post(A, 'fixed_asset.disposal', [
      { accountCode: '1020', type: 'debit', amountCents: 5_000_000 },
      { accountCode: '1591', type: 'debit', amountCents: 3_000_000 },
      { accountCode: '1510', type: 'credit', amountCents: 8_000_000 },
    ])
    const r = await cashFlow([A], from, to)
    expect(cat(r, 'investing').inflowCents - cat(before, 'investing').inflowCents).toBe(5_000_000)
    expect(cat(r, 'operating').inflowCents).toBe(cat(before, 'operating').inflowCents)
  })

  it('a disposal with a GAIN (Cr 8030) is still all investing inflow', async () => {
    const before = await cashFlow([A], from, to)
    // Cost 100,000, accumulated 60,000, sold for 50,000: Dr 1020 50,000 / Dr 1591 60,000 / Cr 1510 100,000 / Cr 8030 10,000.
    await post(A, 'fixed_asset.dispose', [
      { accountCode: '1020', type: 'debit', amountCents: 5_000_000 },
      { accountCode: '1591', type: 'debit', amountCents: 6_000_000 },
      { accountCode: '1510', type: 'credit', amountCents: 10_000_000 },
      { accountCode: '8030', type: 'credit', amountCents: 1_000_000 },
    ])
    const r = await cashFlow([A], from, to)
    expect(cat(r, 'investing').inflowCents - cat(before, 'investing').inflowCents).toBe(5_000_000)
    expect(cat(r, 'operating').inflowCents).toBe(cat(before, 'operating').inflowCents)
  })
})

describe('petty cash is cash', () => {
  it('a top-up from the safe is a transfer; Garibsons funding is cash in; B never sees A\'s', async () => {
    const before = await cashFlow([A], from, to)
    await post(A, 'test.topup', [
      { accountCode: '1011', type: 'debit', amountCents: 1_000_000 },
      { accountCode: '1010', type: 'credit', amountCents: 1_000_000 },
    ])
    let r = await cashFlow([A], from, to)
    expect(r.totals.inflowCents).toBe(before.totals.inflowCents)
    expect(r.totals.outflowCents).toBe(before.totals.outflowCents)
    expect(r.totals.transfersCents - before.totals.transfersCents).toBe(1_000_000)
    const petty = r.byCashAccount.find((a) => a.code === '1011')!
    expect(petty).toMatchObject({ transferInCents: 1_000_000, inflowCents: 0, netCents: 1_000_000 })

    // H1: the Garibsons cashier funds the box — Dr 1011 / Cr 2210.
    await post(A, 'test.funding', [
      { accountCode: '1011', type: 'debit', amountCents: 400_000 },
      { accountCode: '2210', type: 'credit', amountCents: 400_000 },
    ])
    r = await cashFlow([A], from, to)
    expect(r.totals.inflowCents - before.totals.inflowCents).toBe(400_000)

    const viaRoute = await app.inject({ method: 'GET', url: '/accounting/cash-flow?dateFrom=2026-08-01&dateTo=2026-08-31', headers: { authorization: `Bearer ${token}` } })
    expect(viaRoute.statusCode).toBe(200)
    expect(viaRoute.json().totals.inflowCents).toBe(r.totals.inflowCents)
    const other = await cashFlow([B], from, to)
    expect(other.totals).toEqual({ inflowCents: 0, outflowCents: 0, netCents: 0, transfersCents: 0 })
  })
})

describe('a manual correction against an equipment advance stays investing (owner, 2026-10-28)', () => {
  it('the same machine paid twice, the duplicate refunded by a manual journal on 1340: investing nets to one payment', async () => {
    const T = (await prisma.tenant.create({ data: { name: 'Flow Dup', slug: 'cfc-dup' } })).id
    await ensureChartOfAccounts(T)
    // Two CapEx payments for one machine, then a manual entry: Dr bank 230,000 + Dr 1212-like expense 24,128 / Cr 1340 254,128.
    await post(T, 'capex.payment', [{ accountCode: '1340', type: 'debit', amountCents: 23_000_000 }, { accountCode: '1020', type: 'credit', amountCents: 23_000_000 }])
    await post(T, 'capex.payment', [{ accountCode: '1340', type: 'debit', amountCents: 25_412_800 }, { accountCode: '1020', type: 'credit', amountCents: 25_412_800 }])
    await post(T, 'manual', [
      { accountCode: '1020', type: 'debit', amountCents: 23_000_000 },
      { accountCode: '6130', type: 'debit', amountCents: 2_412_800 },
      { accountCode: '1340', type: 'credit', amountCents: 25_412_800 },
    ])
    const r = await cashFlow([T], from, to)
    expect(cat(r, 'investing')).toMatchObject({ inflowCents: 23_000_000, outflowCents: 48_412_800, netCents: -25_412_800 })
    expect(cat(r, 'operating').inflowCents).toBe(0)
    expect(r.totals.netCents).toBe(-25_412_800)
  })
})
