// Money coming in on the fixed-asset and CapEx screens, and bank deposit drops
// (owner, 2026-10-14): a payment reference # on EVERY method (cash included),
// "Bank deposit" next to Cash / Bank transfer / Cheque, a reference used
// before is a WARNING (`referenceUsedBefore`), never a block — and only ever
// within the same company.
//
//   • R6 asset-sale proceeds (POST /accounting/fixed-assets/:id/requests kind
//     disposal, and /:id/dispose): 422 PAYMENT_REFERENCE_REQUIRED on every
//     method when there are proceeds; company B's bank → 422; B on A's asset
//     → 404; the entry's description and the money line's memo carry
//     "bank deposit, ref …"; a pending request raised before the rule (old
//     'online' method, no reference) still approves.
//   • R7 CapEx deposit returned by the landlord (POST /finance/capex/payments/
//     :id/deposit-return): method + reference (required when money came
//     back), the old payFrom alias, the money account of the PROJECT's
//     company, depositReturnMethod / depositReturnRef stored, memo carries it.
//   • I1 deposit drops (POST /trustops/deposit-drops): the slip # is stored,
//     in the posting, listed, and a slip # used before warns.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { FixedAsset, UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import { postAcquisition, nextAssetTag } from '../src/modules/fixedAssets/service.js'
import { fixedAssetRoutes } from '../src/modules/fixedAssets/routes.js'
import { financePlanningRoutes } from '../src/modules/financePlanning/routes.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { findPaymentReferenceUses } from '../src/lib/paymentRefs.js'

const RUN = Math.random().toString(36).slice(2, 8)
const FA = '/accounting/fixed-assets'
let app: FastifyInstance
const who: Record<string, { id: string; token: string }> = {}
interface Co { tenantId: string; brand: string; outlet: string; hbl: string; mcb: string | null }
let A: Co, B: Co
let seq = 0

async function mkCo(name: string, twoBanks: boolean): Promise<Co> {
  const tenantId = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(tenantId)
  await ensureAssetClasses(tenantId)
  const s = `${++seq}-${RUN}`
  const hbl = (await prisma.bankAccount.create({ data: { tenantId, name: `HBL ${name}`, accountCode: '1020' } })).id
  let mcb: string | null = null
  if (twoBanks) {
    await prisma.account.create({ data: { tenantId, code: '1021', name: 'Bank — MCB', type: 'asset', isActive: true } })
    mcb = (await prisma.bankAccount.create({ data: { tenantId, name: `MCB ${name}`, accountCode: '1021' } })).id
  }
  return {
    tenantId, hbl, mcb,
    brand: (await prisma.concept.create({ data: { name: `${name} brand`, slug: `prf-b-${s}`, type: 'restaurant', tenantId } })).id,
    outlet: (await prisma.location.create({ data: { name: `${name} outlet`, slug: `prf-l-${s}`, tenantId } })).id,
  }
}
async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@payrefs.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  who[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (w: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${who[w]!.token}` }, ...(payload !== undefined ? { payload: payload as never } : {}) })
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code

async function mkAsset(co: Co, name: string): Promise<FixedAsset> {
  const inService = new Date(Date.now() - 70 * 86_400_000)
  return prisma.$transaction(async (tx) => {
    const asset = await tx.fixedAsset.create({
      data: {
        tenantId: co.tenantId, name, category: 'kitchen_equipment', assetTag: await nextAssetTag(tx, co.tenantId), acquiredAt: inService, inServiceAt: inService,
        costCents: 120_000, originalCostCents: 120_000, usefulLifeMonths: 12, conceptId: co.brand, locationId: co.outlet, acquisitionCreditCode: '2012',
      },
    })
    await postAcquisition(tx, asset, { advancedCents: 0, owedCents: 120_000, inputTaxCents: 0, inputTaxCode: null, natural: inService })
    return asset
  })
}
async function entry(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return { description: je.description, rows: je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents), memo: l.memo ?? '' })) }
}
// Yesterday in Karachi: a 'YYYY-MM-DD' disposal date means noon PKT, which must not be in the future.
const today = () => new Date(Date.now() + 5 * 3_600_000 - 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  A = await mkCo('PayRefs A', true)
  B = await mkCo('PayRefs B', false)
  await mkUser('ceoA', 'admin', A.tenantId)
  await mkUser('finA', 'finance', A.tenantId)
  await mkUser('ceoB', 'admin', B.tenantId)
  await mkUser('finB', 'finance', B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(fixedAssetRoutes, { prefix: FA })
  await app.register(financePlanningRoutes, { prefix: '/finance' })
  await app.register(trustopsRoutes, { prefix: '/trustops' })
  await app.ready()
}, 90_000)

afterAll(async () => {
  const entries = await prisma.journalEntry.findMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] } }, include: { lines: true } })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + Number(l.amountCents), 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + Number(l.amountCents), 0)
    expect({ ref: e.reference, d }).toEqual({ ref: e.reference, d: c })
  }
  await app?.close()
})

// ─── R6 asset-sale proceeds ─────────────────────────────────────────────────

describe('asset sale proceeds: payment reference # and Bank deposit', () => {
  it('no reference → 422 on every method (cash too), on both routes; nothing is raised', async () => {
    const chiller = await mkAsset(A, 'Chiller')
    // No card (owner, 2026-10-16: back-office receipts take no card).
    for (const method of ['cash', 'bank_transfer', 'bank_deposit', 'cheque', 'bank', 'online']) {
      const bank = method === 'cash' ? {} : { bankAccountId: A.mcb }
      for (const reference of [undefined, '', '   ']) {
        const r = await call('finA', 'POST', `${FA}/${chiller.id}/requests`, {
          kind: 'disposal', reason: 'Sold to a second-hand dealer', effectiveDate: today(),
          payload: { kind: 'sale', proceedsCents: 50_000, method, ...bank, ...(reference !== undefined ? { reference } : {}) },
        })
        expect(r.statusCode, `${method} ${JSON.stringify(reference)} ${r.body}`).toBe(422)
        expect(code(r)).toBe('PAYMENT_REFERENCE_REQUIRED')
      }
      const d = await call('ceoA', 'POST', `${FA}/${chiller.id}/dispose`, { disposedAt: today(), kind: 'sale', proceedsCents: 50_000, method, ...bank })
      expect(code(d), method).toBe('PAYMENT_REFERENCE_REQUIRED')
    }
    // A scrap brings in nothing: no reference needed.
    expect(await prisma.fixedAssetEvent.count({ where: { assetId: chiller.id } })).toBe(0)
    const scrap = await call('finA', 'POST', `${FA}/${chiller.id}/dispose`, { disposedAt: today(), kind: 'scrap', reason: 'Compressor failed, scrapped' })
    expect(scrap.statusCode, scrap.body).toBe(202)
    expect(scrap.json().referenceUsedBefore).toEqual([])
  })

  it('company B\'s bank → 422; B on A\'s asset → 404; a reference longer than 100 → 400', async () => {
    const oven = await mkAsset(A, 'Oven')
    const foreign = await call('finA', 'POST', `${FA}/${oven.id}/requests`, {
      kind: 'disposal', reason: 'Sold to a second-hand dealer', effectiveDate: today(),
      payload: { kind: 'sale', proceedsCents: 50_000, method: 'bank_deposit', reference: 'DS-1', bankAccountId: B.hbl },
    })
    expect(code(foreign)).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect((await call('finB', 'POST', `${FA}/${oven.id}/dispose`, { disposedAt: today(), proceedsCents: 50_000, method: 'cash', reference: 'CR-1' })).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `${FA}/${oven.id}/requests`, { kind: 'disposal', reason: 'Sold to a second-hand dealer', payload: { kind: 'sale', proceedsCents: 1, method: 'cash', reference: 'CR-1' } })).statusCode).toBe(404)
    expect((await call('finA', 'POST', `${FA}/${oven.id}/dispose`, { disposedAt: today(), proceedsCents: 50_000, method: 'cash', reference: 'x'.repeat(101) })).statusCode).toBe(400)
    // An unknown method is refused by the one list.
    expect((await call('finA', 'POST', `${FA}/${oven.id}/dispose`, { disposedAt: today(), proceedsCents: 50_000, method: 'barter', reference: 'X' })).statusCode).toBe(400)
    expect(await prisma.fixedAssetEvent.count({ where: { assetId: oven.id } })).toBe(0)
  })

  it('a bank deposit posts to the named bank with "bank deposit, ref …"; the same reference again warns (never blocks), only in its own company', async () => {
    const grill = await mkAsset(A, 'Grill')
    const sold = await call('ceoA', 'POST', `${FA}/${grill.id}/requests`, {
      kind: 'disposal', reason: 'Sold to the franchisee', effectiveDate: today(),
      payload: { kind: 'sale', proceedsCents: 90_000, method: 'bank_deposit', reference: ' DS-4471 ', bankAccountId: A.mcb },
    })
    expect(sold.statusCode, sold.body).toBe(201)
    expect(sold.json()).toMatchObject({ status: 'posted', referenceUsedBefore: [] })
    const ev = await prisma.fixedAssetEvent.findUniqueOrThrow({ where: { id: sold.json().event.id } })
    expect(ev.payload).toMatchObject({ method: 'bank_deposit', reference: 'DS-4471', moneyCode: '1021', bankAccountId: A.mcb })
    const je = await entry(A.tenantId, `fixed_asset.dispose:${grill.id}`)
    expect(je.description).toContain('bank deposit, ref DS-4471')
    const money = je.rows.find((r) => r.code === '1021' && r.type === 'debit')!
    expect(money.amount).toBe(90_000)
    expect(money.memo).toContain('bank deposit, ref DS-4471')
    // Any letter case finds it, like every other kind (final gate: the JSON lookup was case-sensitive).
    for (const typed of ['ds-4471', ' Ds-4471 ']) {
      expect((await findPaymentReferenceUses(prisma, A.tenantId, typed)).map((u) => [u.kind, u.id])).toEqual([['asset_disposal', ev.id]])
    }

    // Finance raises another sale with the same reference (one deposit slip, two items): saved, with a warning.
    const fryer = await mkAsset(A, 'Fryer')
    const again = await call('finA', 'POST', `${FA}/${fryer.id}/dispose`, {
      disposedAt: today(), kind: 'sale', proceedsCents: 10_000, method: 'cheque', reference: 'DS-4471', bankAccountId: A.hbl, reason: 'Sold with the grill',
    })
    expect(again.statusCode, again.body).toBe(202)
    expect(again.json().referenceUsedBefore).toEqual([expect.objectContaining({ kind: 'asset_disposal', id: ev.id })])
    const approved = await call('ceoA', 'POST', `${FA}/requests/${again.json().event.id}/approve`, {})
    expect(approved.statusCode, approved.body).toBe(200)
    const je2 = await entry(A.tenantId, `fixed_asset.dispose:${fryer.id}`)
    expect(je2.rows.find((r) => r.code === '1020' && r.type === 'debit')!.memo).toContain('cheque, ref DS-4471')

    // Company B using the same number sees no warning: A's payments never leak.
    const ovenB = await mkAsset(B, 'Oven B')
    const b = await call('ceoB', 'POST', `${FA}/${ovenB.id}/dispose`, { disposedAt: today(), kind: 'sale', proceedsCents: 20_000, method: 'bank_deposit', reference: 'DS-4471' })
    expect(b.statusCode, b.body).toBe(201)
    expect(b.json().referenceUsedBefore).toEqual([])
    expect((await entry(B.tenantId, `fixed_asset.dispose:${ovenB.id}`)).rows.find((r) => r.code === '1020' && r.type === 'debit')!.amount).toBe(20_000)
  })

  it('cash proceeds need a reference too and land on 1010', async () => {
    const kettle = await mkAsset(A, 'Kettle')
    const r = await call('ceoA', 'POST', `${FA}/${kettle.id}/dispose`, { disposedAt: today(), kind: 'sale', proceedsCents: 5_000, method: 'cash', reference: 'CR-0091' })
    expect(r.statusCode, r.body).toBe(201)
    const je = await entry(A.tenantId, `fixed_asset.dispose:${kettle.id}`)
    expect(je.rows.find((x) => x.code === '1010' && x.type === 'debit')).toMatchObject({ amount: 5_000, memo: expect.stringContaining('cash, ref CR-0091') })
    // A bank account on a cash sale is refused.
    const toaster = await mkAsset(A, 'Toaster')
    expect(code(await call('ceoA', 'POST', `${FA}/${toaster.id}/dispose`, { disposedAt: today(), kind: 'sale', proceedsCents: 5_000, method: 'cash', reference: 'CR-0092', bankAccountId: A.hbl }))).toBe('BANK_ACCOUNT_ON_CASH')
  })

  it('a sale request raised before the rule (old "online" method, no reference) still approves', async () => {
    const mixer = await mkAsset(A, 'Mixer')
    const ev = await prisma.fixedAssetEvent.create({
      data: {
        tenantId: A.tenantId, assetId: mixer.id, kind: 'disposal', status: 'pending', effectiveDate: new Date(),
        payload: { kind: 'sale', proceedsCents: 30_000, method: 'online', bankAccountId: A.hbl }, amountCents: 30_000,
        reason: 'Sold online before the reference rule', requestedById: who.finA!.id,
      },
    })
    const ok = await call('ceoA', 'POST', `${FA}/requests/${ev.id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    const je = await entry(A.tenantId, `fixed_asset.dispose:${mixer.id}`)
    expect(je.rows.find((r) => r.code === '1020' && r.type === 'debit')).toMatchObject({ amount: 30_000, memo: expect.stringContaining('online payment') })
  })
})

// ─── R7 CapEx deposit returned by the landlord ──────────────────────────────

describe('CapEx deposit return: method, payment reference # and the project\'s bank', () => {
  async function deposit(amount: number): Promise<string> {
    const p = (await prisma.capexProject.create({ data: { tenantId: A.tenantId, name: `Lease ${++seq} ${RUN}`, conceptId: A.brand } })).id
    const l = (await prisma.capexLine.create({ data: { projectId: p, scope: 'SoftCosts', item: 'Security deposit — shop lease', unitCostCents: amount, treatment: 'deposit' } })).id
    const pay = await call('finA', 'POST', `/finance/capex/lines/${l}/payments`, { label: 'deposit', amountCents: amount, paidAt: '2026-09-10', bankAccountId: A.hbl })
    expect(pay.statusCode, pay.body).toBe(201)
    return pay.json().id as string
  }

  it('money back needs a reference on every method; B\'s bank → 422; B → 404; nothing posts', async () => {
    const id = await deposit(600_000)
    const url = `/finance/capex/payments/${id}/deposit-return`
    for (const method of ['cash', 'bank_transfer', 'bank_deposit', 'cheque']) {
      const bank = method === 'cash' ? {} : { bankAccountId: A.mcb }
      for (const reference of [undefined, '  ']) {
        const r = await call('finA', 'POST', url, { returnedCents: 600_000, receivedAt: '2026-10-01', method, ...bank, ...(reference !== undefined ? { reference } : {}) })
        expect(code(r), `${method} ${r.body}`).toBe('PAYMENT_REFERENCE_REQUIRED')
      }
    }
    // The old payFrom spelling is held to the same rule.
    expect(code(await call('finA', 'POST', url, { returnedCents: 600_000, receivedAt: '2026-10-01', payFrom: 'cash' }))).toBe('PAYMENT_REFERENCE_REQUIRED')
    // Card is not a way a landlord returns a deposit.
    expect((await call('finA', 'POST', url, { returnedCents: 600_000, receivedAt: '2026-10-01', method: 'card', reference: 'X' })).statusCode).toBe(400)
    expect(code(await call('finA', 'POST', url, { returnedCents: 600_000, receivedAt: '2026-10-01', method: 'bank_deposit', reference: 'DS-1', bankAccountId: B.hbl }))).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(code(await call('finA', 'POST', url, { returnedCents: 600_000, receivedAt: '2026-10-01', method: 'cheque', payFrom: 'cash', reference: 'CHQ-1' }))).toBe('PAYMENT_METHOD_CONFLICT')
    expect((await call('finB', 'POST', url, { returnedCents: 600_000, receivedAt: '2026-10-01', method: 'cash', reference: 'CR-1' })).statusCode).toBe(404)
    expect(await prisma.journalEntry.count({ where: { reference: { startsWith: `capex.deposit_return:${id}` } } })).toBe(0)
    expect(await prisma.capexPayment.findUniqueOrThrow({ where: { id } })).toMatchObject({ depositReturnRef: null, depositReturnMethod: null })
  })

  it('a bank deposit into the named bank: stored, in the memo; a reference used before warns; re-stating it does not warn about itself', async () => {
    const id = await deposit(500_000)
    const url = `/finance/capex/payments/${id}/deposit-return`
    // 'DS-4471' was used on an asset sale above: saved, with a warning.
    const r = await call('finA', 'POST', url, { returnedCents: 450_000, forfeitedCents: 50_000, reason: 'Paint damage', receivedAt: '2026-10-02', method: 'bank_deposit', reference: 'DS-4471', bankAccountId: A.mcb })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ method: 'bank_deposit', reference: 'DS-4471' })
    expect(r.json().referenceUsedBefore.map((u: { kind: string }) => u.kind)).toEqual(expect.arrayContaining(['asset_disposal']))
    expect(await prisma.capexPayment.findUniqueOrThrow({ where: { id } })).toMatchObject({
      depositReturnedCents: 450_000, depositForfeitedCents: 50_000, depositReturnMethod: 'bank_deposit', depositReturnRef: 'DS-4471', depositReturnBankAccountId: A.mcb,
    })
    const je = await entry(A.tenantId, `capex.deposit_return:${id}`)
    expect(je.description).toContain('bank deposit, ref DS-4471')
    expect(je.rows.find((x) => x.code === '1021' && x.type === 'debit')).toMatchObject({ amount: 450_000, memo: expect.stringContaining('bank deposit, ref DS-4471') })
    expect(je.rows.find((x) => x.code === '1360' && x.type === 'credit')!.amount).toBe(500_000)

    // Re-stated with a new reference: the stored one moves, no warning about this very return.
    const again = await call('finA', 'POST', url, { returnedCents: 450_000, forfeitedCents: 50_000, reason: 'Paint damage', receivedAt: '2026-10-02', method: 'bank_transfer', reference: 'IBFT-881', bankAccountId: A.mcb })
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json().referenceUsedBefore).toEqual([])
    const same = await call('finA', 'POST', url, { returnedCents: 450_000, forfeitedCents: 50_000, reason: 'Paint damage', receivedAt: '2026-10-02', method: 'bank_transfer', reference: 'IBFT-881', bankAccountId: A.mcb })
    expect(same.json().referenceUsedBefore).toEqual([])
    expect(await prisma.capexPayment.findUniqueOrThrow({ where: { id } })).toMatchObject({ depositReturnMethod: 'bank_transfer', depositReturnRef: 'IBFT-881' })
    // Only the words changed (same bank, same amounts): the entry was reversed and posted again.
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: `capex.deposit_return.reversal:${id}` } })).toBe(1)
    const now = await entry(A.tenantId, `capex.deposit_return:${id}@2`)
    expect(now.description).toContain('bank transfer, ref IBFT-881')
    expect(now.rows.find((x) => x.code === '1021' && x.type === 'debit')!.memo).toContain('bank transfer, ref IBFT-881')
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: { startsWith: `capex.deposit_return:${id}` } } })).toBe(2)
  })

  it('the old payFrom: cash alias lands on 1010; all kept by the landlord needs no reference', async () => {
    const id = await deposit(200_000)
    const r = await call('finA', 'POST', `/finance/capex/payments/${id}/deposit-return`, { returnedCents: 200_000, receivedAt: '2026-10-03', payFrom: 'cash', reference: 'CR-5512' })
    expect(r.statusCode, r.body).toBe(201)
    expect(await prisma.capexPayment.findUniqueOrThrow({ where: { id } })).toMatchObject({ depositReturnMethod: 'cash', depositReturnRef: 'CR-5512', depositReturnBankAccountId: null })
    expect((await entry(A.tenantId, `capex.deposit_return:${id}`)).rows.find((x) => x.code === '1010')).toMatchObject({ type: 'debit', amount: 200_000, memo: expect.stringContaining('cash, ref CR-5512') })

    const kept = await deposit(100_000)
    const k = await call('finA', 'POST', `/finance/capex/payments/${kept}/deposit-return`, { forfeitedCents: 100_000, reason: 'Broken lease terms', receivedAt: '2026-10-03' })
    expect(k.statusCode, k.body).toBe(201)
    expect(k.json()).toMatchObject({ reference: null, method: null, referenceUsedBefore: [] })
    expect(await prisma.capexPayment.findUniqueOrThrow({ where: { id: kept } })).toMatchObject({ depositReturnRef: null, depositReturnMethod: null })
  })
})

// ─── I1 deposit drops: the slip # ───────────────────────────────────────────

describe('bank deposit drops: Deposit slip #', () => {
  it('stored, in the posting and the list; a slip # used before warns; never across companies', async () => {
    const r = await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 30_000, bankAccountId: A.mcb, slipNumber: ' SLIP-77 ', bagSerial: 'BAG-1', receiptUrl: 'https://example.com/slip.jpg' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ tenantId: A.tenantId, slipNumber: 'SLIP-77', posted: true, referenceUsedBefore: [] })
    const je = await entry(A.tenantId, `deposit.drop:${r.json().id}`)
    expect(je.description).toContain('slip SLIP-77')
    expect(je.description).toContain('bag BAG-1')
    expect(je.rows.find((x) => x.code === '1021' && x.type === 'debit')).toMatchObject({ amount: 30_000, memo: expect.stringContaining('slip SLIP-77') })

    // The same slip again: saved, with a warning naming the earlier drop.
    const again = await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 1_000, bankAccountId: A.hbl, slipNumber: 'slip-77', receiptUrl: 'https://example.com/slip2.jpg' })
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json().referenceUsedBefore).toEqual([expect.objectContaining({ kind: 'deposit_drop', id: r.json().id })])

    // B: the same number warns about nothing of A's; A's bank on B's drop → 422.
    const b = await call('ceoB', 'POST', '/trustops/deposit-drops', { amountCents: 2_000, slipNumber: 'SLIP-77', receiptUrl: 'https://example.com/b.jpg' })
    expect(b.statusCode, b.body).toBe(201)
    expect(b.json().referenceUsedBefore).toEqual([])
    expect((await call('ceoB', 'POST', '/trustops/deposit-drops', { amountCents: 2_000, bankAccountId: A.hbl, slipNumber: 'SLIP-78' })).statusCode).toBe(422)

    // The list shows the slip #, per company.
    const listA = (await call('finA', 'GET', '/trustops/deposit-drops')).json() as Array<{ id: string; slipNumber: string | null; tenantId: string }>
    expect(listA.find((d) => d.id === r.json().id)!.slipNumber).toBe('SLIP-77')
    expect(listA.some((d) => d.tenantId !== A.tenantId)).toBe(false)
    expect(((await call('ceoB', 'GET', '/trustops/deposit-drops')).json() as Array<{ id: string }>).some((d) => d.id === r.json().id)).toBe(false)
  })

  it('the slip # is optional at the drop (no separate banked step) and at most 100 characters', async () => {
    const none = await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 4_000, bankAccountId: A.hbl, receiptUrl: 'https://example.com/n.jpg' })
    expect(none.statusCode, none.body).toBe(201)
    expect(none.json()).toMatchObject({ slipNumber: null, referenceUsedBefore: [] })
    expect((await entry(A.tenantId, `deposit.drop:${none.json().id}`)).description).toBe('Bank deposit drop')
    const blank = await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 4_000, bankAccountId: A.hbl, slipNumber: '   ', receiptUrl: 'https://example.com/n.jpg' })
    expect(blank.json().slipNumber).toBeNull()
    expect((await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 4_000, bankAccountId: A.hbl, slipNumber: 'x'.repeat(101) })).statusCode).toBe(400)
  })
})
