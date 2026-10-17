// One sales account per brand (owner, 2026-10-17: "One sales account per brand").
//
//   - every brand credits its sales to its OWN account in its company's chart
//     (Concept.revenueAccountCode; new brands "Sales — <brand>" at the first
//     free code in 4010–4089; legacy brands keep 4001–4007);
//   - a brand created through POST /concepts gets its account at create, in
//     the ACTIVE company's chart only;
//   - a sale booked on 4090 BEFORE the brand got its account is refunded from
//     4090 (the account the sale credited), never the new one — history
//     never moves;
//   - brand sales reports (brandSalesRevenueCents, brandSalesByConcept), the
//     sales-tax return and allocations count each brand's sales, old 4090
//     ones included, each line once;
//   - a company merge renumbers a clashing brand account instead of folding
//     two brands' sales into one account.
// Two companies throughout: B's brand account lives only in B's chart.
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { conceptRoutes } from '../src/modules/concepts/routes.js'
import { postOrderCompletion, postRefundPayment } from '../src/modules/accounting/orderPosting.js'
import { revenueCodeForConcept } from '../src/modules/accounting/journal.js'
import {
  ensureBrandRevenueAccount, ensureBrandRevenueAccounts, renumberClashingBrandAccountsTx, brandSalesByAccount,
} from '../src/modules/accounting/brandRevenueAccount.js'
import { brandSalesRevenueCents, brandSalesByConcept } from '../src/modules/accounting/reports.js'
import { salesTaxReturn } from '../src/modules/accounting/salesTaxReturn.js'

let app: FastifyInstance
let A: Company, B: Company
let ceoA: Who
const stamp = Date.now()
const day = () => ({ from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) })

const call = (who: Who, method: 'POST', url: string, payload: Record<string, unknown>) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${who.token}` } })

/** A completed online cash order of 115,000 (100,000 + 15,000 GST), booked by order.complete. */
async function sale(co: Company, conceptId = co.conceptId) {
  const o = await prisma.order.create({
    data: {
      conceptId, source: 'servd', fulfilmentType: 'takeout', status: 'completed', completedAt: new Date(),
      totalCents: 115_000, taxCents: 15_000, taxRatePct: 15,
      items: { create: [{ name: 'Beef Nihari', menuItemId: co.items.nihari, quantity: 1, unitPriceCents: 100_000 }] },
    },
  })
  await prisma.payment.create({ data: { orderId: o.id, method: 'card', amountCents: 115_000, status: 'paid', processedAt: new Date() } })
  const r = await postOrderCompletion(o.id)
  expect(r.posted).toBe(true)
  return o
}

async function refund(orderId: string, cents: number) {
  await prisma.order.update({ where: { id: orderId }, data: { status: 'refunded' } })
  const p = await prisma.payment.create({
    data: { orderId, method: 'card', amountCents: -cents, status: 'refunded', processedAt: new Date(), gatewayMeta: { refund: { reason: 'complaint' } } },
  })
  expect((await postRefundPayment(p.id)).posted).toBe(true)
  return p
}

/** [code, type, amount] of the 40xx lines of one entry. */
async function salesLines(tenantId: string, ref: string): Promise<Array<[string, string, number]>> {
  const lines = await prisma.journalLine.findMany({
    where: { journalEntry: { tenantId, reference: ref }, account: { code: { startsWith: '40' } } },
    select: { type: true, amountCents: true, account: { select: { code: true, tenantId: true } } },
  })
  for (const l of lines) expect(l.account.tenantId).toBe(tenantId)
  return lines.map((l) => [l.account.code, l.type, Number(l.amountCents)] as [string, string, number])
}

beforeAll(async () => {
  A = await mkCompany(`bra-a-${stamp}`)
  B = await mkCompany(`bra-b-${stamp}`)
  ceoA = await mkUser('bra-ceo-a', 'admin', A.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(conceptRoutes, { prefix: '/concepts' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('one sales account per brand', () => {
  let preSwitchA: string

  it('before the switch a brand with no account books to 4090', async () => {
    const c = await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId }, select: { slug: true, revenueAccountCode: true } })
    expect(c.revenueAccountCode).toBeNull()
    expect(revenueCodeForConcept(c)).toBe('4090')
    const o = await sale(A)
    preSwitchA = o.id
    expect(await salesLines(A.tenantId, `order.complete:${o.id}`)).toEqual([['4090', 'credit', 100_000]])
  })

  it('the boot step gives each company\'s brands their own account, in their own chart, once', async () => {
    const before = await prisma.account.count({ where: { tenantId: { in: [A.tenantId, B.tenantId] } } })
    await ensureBrandRevenueAccounts()
    const a = await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId }, select: { name: true, revenueAccountCode: true } })
    const b = await prisma.concept.findUniqueOrThrow({ where: { id: B.conceptId }, select: { name: true, revenueAccountCode: true } })
    expect(a.revenueAccountCode).toBe('4010')
    expect(b.revenueAccountCode).toBe('4010')
    const accA = await prisma.account.findFirstOrThrow({ where: { tenantId: A.tenantId, code: '4010' } })
    const accB = await prisma.account.findFirstOrThrow({ where: { tenantId: B.tenantId, code: '4010' } })
    expect(accA).toMatchObject({ name: `Sales — ${a.name}`, type: 'revenue', isActive: true })
    expect(accB).toMatchObject({ name: `Sales — ${b.name}`, type: 'revenue', isActive: true })
    expect(accA.id).not.toBe(accB.id)
    expect(await prisma.account.count({ where: { tenantId: { in: [A.tenantId, B.tenantId] } } })).toBe(before + 2)

    // Idempotent: a second run (and a second call per brand) adds nothing.
    await ensureBrandRevenueAccounts()
    expect((await ensureBrandRevenueAccount(A.conceptId)).created).toBe(false)
    expect(await prisma.account.count({ where: { tenantId: { in: [A.tenantId, B.tenantId] } } })).toBe(before + 2)
  })

  it('a legacy brand keeps its fixed code (no new account)', async () => {
    const legacy = await prisma.concept.create({
      data: { name: 'Bukhari', slug: 'bukhari', type: 'restaurant', tenantId: B.tenantId, taxRateCash: 15, taxRateCard: 8, province: 'SD' },
    })
    expect(await ensureBrandRevenueAccount(legacy.id)).toMatchObject({ code: '4007', created: false })
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: legacy.id } })).revenueAccountCode).toBe('4007')
  })

  it('each brand now posts to its own account; B never touches A\'s', async () => {
    const oA = await sale(A)
    const oB = await sale(B)
    expect(await salesLines(A.tenantId, `order.complete:${oA.id}`)).toEqual([['4010', 'credit', 100_000]])
    expect(await salesLines(B.tenantId, `order.complete:${oB.id}`)).toEqual([['4010', 'credit', 100_000]])
    const accA = await prisma.account.findFirstOrThrow({ where: { tenantId: A.tenantId, code: '4010' }, select: { id: true } })
    expect(await prisma.journalLine.count({ where: { accountId: accA.id, journalEntry: { tenantId: B.tenantId } } })).toBe(0)

    // A refund of a post-switch sale reverses the brand's own account.
    const p = await refund(oA.id, 115_000)
    expect(await salesLines(A.tenantId, `order.refund:${p.id}`)).toEqual([['4010', 'debit', 100_000]])
  })

  it('a refund of a sale booked on 4090 before the switch reverses 4090, never the new account', async () => {
    const p = await refund(preSwitchA, 57_500)
    expect(await salesLines(A.tenantId, `order.refund:${p.id}`)).toEqual([['4090', 'debit', 50_000]])
    // The original sale entry is untouched.
    expect(await salesLines(A.tenantId, `order.complete:${preSwitchA}`)).toEqual([['4090', 'credit', 100_000]])
  })

  it('brand sales reports and the sales-tax return count the brand\'s 4090 and own-account sales, each once', async () => {
    // A: pre-switch 100,000 − 50,000 refunded (4090) + post-switch 100,000 − 100,000 refunded (4010) = 50,000.
    expect(await brandSalesRevenueCents(prisma, A.tenantId, { ...day(), conceptId: A.conceptId })).toBe(50_000)
    const byA = await brandSalesByConcept(prisma, [A.tenantId], day())
    expect(byA.get(A.conceptId)).toBe(50_000)
    const byB = await brandSalesByConcept(prisma, [B.tenantId], day())
    expect(byB.get(B.conceptId)).toBe(100_000)
    expect(byB.has(A.conceptId)).toBe(false)

    const concepts = await prisma.concept.findMany({ where: { tenantId: A.tenantId }, select: { id: true, slug: true, revenueAccountCode: true } })
    const split = await brandSalesByAccount(prisma, A.tenantId, concepts, day())
    expect(split.byConcept.get(A.conceptId)).toBe(50_000)
    expect(split.otherCents).toBe(0)

    const { from, to } = day()
    const ret = await salesTaxReturn(A.tenantId, from, to)
    const nameA = (await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).name
    const row = ret.taxableValueByConceptCents.find((r) => r.conceptName === nameA)
    expect(row?.revenueCents).toBe(50_000)
    const retB = await salesTaxReturn(B.tenantId, from, to)
    expect(retB.taxableValueByConceptCents.reduce((t, r) => t + r.revenueCents, 0)).toBe(100_000)
  })

  it('POST /concepts gives the new brand its own account in the ACTIVE company only', async () => {
    const slug = `bra-new-${stamp}`
    const r = await call(ceoA, 'POST', '/concepts', { name: 'Viva Grill', slug, type: 'restaurant', serviceVessel: 'plate', province: 'SD' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().revenueAccountCode).toBe('4011')
    const c = await prisma.concept.findUniqueOrThrow({ where: { slug }, select: { id: true, tenantId: true, revenueAccountCode: true } })
    expect(c).toMatchObject({ tenantId: A.tenantId, revenueAccountCode: '4011' })
    expect(await prisma.account.findFirst({ where: { tenantId: A.tenantId, code: '4011' }, select: { name: true, type: true } }))
      .toEqual({ name: 'Sales — Viva Grill', type: 'revenue' })
    expect(await prisma.account.count({ where: { tenantId: B.tenantId, code: '4011' } })).toBe(0)

    // Its sales go to 4011, A's first brand stays on 4010.
    const o = await sale(A, c.id)
    expect(await salesLines(A.tenantId, `order.complete:${o.id}`)).toEqual([['4011', 'credit', 100_000]])
  })

  it('a hand-made account in the range is skipped, never reused', async () => {
    await prisma.account.create({ data: { tenantId: B.tenantId, code: '4011', name: 'Finance own account', type: 'revenue' } })
    const c = await prisma.concept.create({ data: { name: 'B Two', slug: `bra-b2-${stamp}`, type: 'restaurant', tenantId: B.tenantId, province: 'SD' } })
    expect((await ensureBrandRevenueAccount(c.id)).code).toBe('4012')
    expect((await prisma.account.findFirstOrThrow({ where: { tenantId: B.tenantId, code: '4011' } })).name).toBe('Finance own account')
  })

  it('a company merge renumbers a clashing brand account so two brands\' sales never share one', async () => {
    const C = await mkCompany(`bra-c-${stamp}`)
    const D = await mkCompany(`bra-d-${stamp}`)
    await ensureBrandRevenueAccount(C.conceptId)
    await ensureBrandRevenueAccount(D.conceptId)
    const oC = await sale(C)
    const accC = await prisma.account.findFirstOrThrow({ where: { tenantId: C.tenantId, code: '4010' }, select: { id: true } })
    const moved = await prisma.$transaction((tx) => renumberClashingBrandAccountsTx(tx, C.tenantId, D.tenantId))
    expect(moved).toEqual([{ conceptId: C.conceptId, from: '4010', to: '4011' }])
    // Same account row (its history stays on it), new code; the brand follows.
    expect((await prisma.account.findUniqueOrThrow({ where: { id: accC.id } })).code).toBe('4011')
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: C.conceptId } })).revenueAccountCode).toBe('4011')
    expect(await salesLines(C.tenantId, `order.complete:${oC.id}`)).toEqual([['4011', 'credit', 100_000]])
    // D's own brand account is untouched.
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: D.conceptId } })).revenueAccountCode).toBe('4010')
  })
})
