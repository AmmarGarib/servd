// Raast QR — receiving accounts (spec §7.5, amendment S4; stream D).
//
//   - GET /setup/bank-accounts carries raastId + raastDefault
//   - PATCH raastDefault: one default per company (the old one is unset in the
//     same transaction), needs a linked chart code, never inactive; audited
//   - PUT /setup/raast-accounts: brand override; a foreign brand is 404, a
//     foreign / inactive / unlinked account is 422
//   - S4: 409 RAAST_ACCOUNT_SHARED when another company already receives
//     Raast on the same IBAN / account number / Raast ID
//   - resolveRaastAccount: brand override > company default > null; ignores
//     deleted, inactive and unlinked accounts and never another company's
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { prisma, mkCompany, mkUser, mkRaastAccount, type Company, type Who } from './connectorsFixtures.js'
import { setupRoutes } from '../src/modules/setup/routes.js'
import { resolveRaastAccount, NON_BANK_MONEY_CODES, isRaastBankCode } from '../src/connectors/raast/accounts.js'

let app: FastifyInstance
let A: Company
let B: Company
let financeA: Who, financeB: Who, cashierA: Who

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

/** A plain (not Raast) bank account of `co` linked to `code`. */
async function mkBank(co: Company, data: { code: string; iban?: string | null; accountNumber?: string | null; raastId?: string | null; isActive?: boolean; accountCode?: string | null }) {
  await prisma.account.upsert({
    where: { tenantId_code: { tenantId: co.tenantId, code: data.code } },
    update: { isActive: true },
    create: { tenantId: co.tenantId, code: data.code, name: `Bank ${data.code}`, type: 'asset' },
  })
  return prisma.bankAccount.create({
    data: {
      tenantId: co.tenantId, name: `Bank ${data.code} ${Math.random().toString(36).slice(2, 6)}`, bankName: 'HBL',
      iban: data.iban ?? null, accountNumber: data.accountNumber ?? null, raastId: data.raastId ?? null,
      accountCode: data.accountCode === undefined ? data.code : data.accountCode, isActive: data.isActive ?? true,
    },
  })
}

beforeAll(async () => {
  A = await mkCompany('rbank-a')
  B = await mkCompany('rbank-b')
  financeA = await mkUser('rb-fin-a', 'finance', A.tenantId)
  financeB = await mkUser('rb-fin-b', 'finance', B.tenantId)
  cashierA = await mkUser('rb-cash-a', 'cashier', A.tenantId)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(setupRoutes, { prefix: '/setup' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('the company default Raast account', () => {
  it('GET /bank-accounts carries raastId + raastDefault; PATCH sets them, one default per company, audited', async () => {
    const one = await mkBank(A, { code: '1023', iban: 'PK36MEZN0001234567890123' })
    const two = await mkBank(A, { code: '1024', accountNumber: '0101-5555-6666' })

    const set1 = await call(financeA, 'PATCH', `/setup/bank-accounts/${one.id}`, { raastDefault: true, raastId: '03001234567' })
    expect(set1.statusCode, set1.body).toBe(200)
    expect(set1.json()).toMatchObject({ raastDefault: true, raastId: '03001234567' })

    const list = await call(financeA, 'GET', '/setup/bank-accounts')
    expect(list.statusCode).toBe(200)
    const row = list.json().find((r: { id: string }) => r.id === one.id)
    expect(row).toMatchObject({ raastId: '03001234567', raastDefault: true })

    // A second default unsets the first (same transaction; the partial unique
    // index would refuse two).
    const set2 = await call(financeA, 'PATCH', `/setup/bank-accounts/${two.id}`, { raastDefault: true })
    expect(set2.statusCode, set2.body).toBe(200)
    const defaults = await prisma.bankAccount.findMany({ where: { tenantId: A.tenantId, raastDefault: true, deletedAt: null } })
    expect(defaults.map((d) => d.id)).toEqual([two.id])
    expect(await prisma.auditLog.count({ where: { action: 'raast.accounts.update', entityId: one.id } })).toBeGreaterThanOrEqual(1)

    // An empty Raast ID clears it.
    const clear = await call(financeA, 'PATCH', `/setup/bank-accounts/${one.id}`, { raastId: '' })
    expect(clear.json().raastId).toBeNull()

    // Company B never sees or edits A's account.
    expect((await call(financeB, 'GET', '/setup/bank-accounts')).json().find((r: { id: string }) => r.id === one.id)).toBeUndefined()
    expect((await call(financeB, 'PATCH', `/setup/bank-accounts/${one.id}`, { raastDefault: true })).statusCode).toBe(404)
    // The till cannot.
    expect((await call(cashierA, 'PATCH', `/setup/bank-accounts/${one.id}`, { raastDefault: true })).statusCode).toBe(403)
  })

  it('a default needs a linked chart code and an active account', async () => {
    const unlinked = await mkBank(A, { code: '1025', accountCode: null })
    const r = await call(financeA, 'PATCH', `/setup/bank-accounts/${unlinked.id}`, { raastDefault: true })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('BANK_ACCOUNT_NOT_LINKED')

    const off = await mkBank(A, { code: '1026', isActive: false })
    const r2 = await call(financeA, 'PATCH', `/setup/bank-accounts/${off.id}`, { raastDefault: true })
    expect(r2.statusCode).toBe(422)
    expect(r2.json().error.code).toBe('BANK_ACCOUNT_INACTIVE')

    // Deactivating the current default is refused too (pick another first).
    const cur = await prisma.bankAccount.findFirstOrThrow({ where: { tenantId: A.tenantId, raastDefault: true, deletedAt: null } })
    const r3 = await call(financeA, 'PATCH', `/setup/bank-accounts/${cur.id}`, { isActive: false })
    expect(r3.statusCode).toBe(422)
  })

  it('a Raast account must post to a BANK code — never cash, the drawer, 1030, receivables or till clearing (422 RAAST_NOT_A_BANK_CODE)', async () => {
    expect(NON_BANK_MONEY_CODES).toEqual(expect.arrayContaining(['1010', '1015', '1030', '1110', '1115']))
    expect(isRaastBankCode('1115')).toBe(false)
    expect(isRaastBankCode('1021')).toBe(true)
    for (const code of ['1010', '1015', '1030', '1110', '1115']) {
      const bad = await mkBank(A, { code })
      const r = await call(financeA, 'PATCH', `/setup/bank-accounts/${bad.id}`, { raastDefault: true })
      expect(r.statusCode, `${code}: ${r.body}`).toBe(422)
      expect(r.json().error.code).toBe('RAAST_NOT_A_BANK_CODE')
      const r2 = await call(financeA, 'PUT', '/setup/raast-accounts', { brands: [{ conceptId: A.conceptId, bankAccountId: bad.id }] })
      expect(r2.statusCode, `${code}: ${r2.body}`).toBe(422)
      expect(r2.json().error.code).toBe('RAAST_NOT_A_BANK_CODE')
      // Even if one were set directly in the DB, the resolver never uses it:
      // the till answers RAAST_NOT_SET_UP rather than book Raast off the bank.
      await prisma.concept.update({ where: { id: A.conceptId }, data: { raastBankAccountId: bad.id } })
      const resolved = await resolveRaastAccount(prisma, A.tenantId, A.conceptId)
      expect(resolved?.bankAccountId).not.toBe(bad.id)
      if (resolved) expect(['1010', '1015', '1030', '1110', '1115']).not.toContain(resolved.ledgerCode)
      await prisma.concept.update({ where: { id: A.conceptId }, data: { raastBankAccountId: null } })
      await prisma.bankAccount.update({ where: { id: bad.id }, data: { deletedAt: new Date(), isActive: false } })
    }
  })

  it('S4: another company cannot receive Raast on the same physical account (409 RAAST_ACCOUNT_SHARED)', async () => {
    const iban = 'PK36 SCBL 0000 0011 2345 6702'
    const aBank = await mkBank(A, { code: '1027', iban })
    expect((await call(financeA, 'PATCH', `/setup/bank-accounts/${aBank.id}`, { raastDefault: true })).statusCode).toBe(200)

    // Same IBAN, written differently, in company B.
    const bBank = await mkBank(B, { code: '1023', iban: 'pk36scbl0000001123456702' })
    const r = await call(financeB, 'PATCH', `/setup/bank-accounts/${bBank.id}`, { raastDefault: true })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('RAAST_ACCOUNT_SHARED')
    // …nor as a brand override.
    const r2 = await call(financeB, 'PUT', '/setup/raast-accounts', { brands: [{ conceptId: B.conceptId, bankAccountId: bBank.id }] })
    expect(r2.statusCode).toBe(409)
    expect(r2.json().error.code).toBe('RAAST_ACCOUNT_SHARED')

    // Same Raast ID.
    await call(financeA, 'PATCH', `/setup/bank-accounts/${aBank.id}`, { raastId: '0300-7654321' })
    const bByAlias = await mkBank(B, { code: '1024', raastId: '03007654321' })
    const r3 = await call(financeB, 'PATCH', `/setup/bank-accounts/${bByAlias.id}`, { raastDefault: true })
    expect(r3.json().error.code).toBe('RAAST_ACCOUNT_SHARED')

    // A different account in B is fine; and once A stops receiving on it
    // (deleted), B may use that IBAN.
    const bOwn = await mkBank(B, { code: '1025', iban: 'PK00HABB0000000000009999' })
    expect((await call(financeB, 'PATCH', `/setup/bank-accounts/${bOwn.id}`, { raastDefault: true })).statusCode).toBe(200)
    expect((await call(financeA, 'DELETE', `/setup/bank-accounts/${aBank.id}`)).statusCode).toBe(204)
    expect((await call(financeB, 'PATCH', `/setup/bank-accounts/${bBank.id}`, { raastDefault: true })).statusCode).toBe(200)
  })

  it('RV-CO-2: the same account as an IBAN in one company and an account number in another, or a mobile Raast ID as 03… vs +92…, is shared', async () => {
    const C = await mkCompany('rbank-c')
    const D = await mkCompany('rbank-d')
    const finC = await mkUser('rb-fin-c', 'finance', C.tenantId)
    const finD = await mkUser('rb-fin-d', 'finance', D.tenantId)
    const cBank = await mkBank(C, { code: '1023', iban: 'PK36SCBL0000002233445566' })
    expect((await call(finC, 'PATCH', `/setup/bank-accounts/${cBank.id}`, { raastDefault: true, raastId: '03331234567' })).statusCode).toBe(200)

    // The cheque-book account number of the same account.
    const dByNumber = await mkBank(D, { code: '1023', accountNumber: '02233445566' })
    const r1 = await call(finD, 'PATCH', `/setup/bank-accounts/${dByNumber.id}`, { raastDefault: true })
    expect(r1.statusCode, r1.body).toBe(409)
    expect(r1.json().error.code).toBe('RAAST_ACCOUNT_SHARED')

    // The same mobile Raast ID written with the country code.
    const dByMobile = await mkBank(D, { code: '1024', raastId: '+92 333 1234567' })
    const r2 = await call(finD, 'PATCH', `/setup/bank-accounts/${dByMobile.id}`, { raastDefault: true })
    expect(r2.statusCode, r2.body).toBe(409)
    expect(r2.json().error.code).toBe('RAAST_ACCOUNT_SHARED')

    // And the other way round: C's account number vs D's IBAN.
    const cNum = await mkBank(C, { code: '1024', accountNumber: '0044-5566-7788' })
    expect((await call(finC, 'PUT', '/setup/raast-accounts', { brands: [{ conceptId: C.conceptId, bankAccountId: cNum.id }] })).statusCode).toBe(200)
    const dIban = await mkBank(D, { code: '1025', iban: 'PK12HABB0000004455667788' })
    const r3 = await call(finD, 'PATCH', `/setup/bank-accounts/${dIban.id}`, { raastDefault: true })
    expect(r3.statusCode, r3.body).toBe(409)

    // A different account (a short or unrelated number) is fine.
    const dOwn = await mkBank(D, { code: '1026', accountNumber: '99887766554' })
    expect((await call(finD, 'PATCH', `/setup/bank-accounts/${dOwn.id}`, { raastDefault: true })).statusCode).toBe(200)
  })
})

describe('Raast by brand', () => {
  it('PUT /raast-accounts sets an override; GET shows default + effective per brand', async () => {
    const def = await mkRaastAccount(A, { code: '1028' })
    const brandAcc = await mkBank(A, { code: '1029', accountNumber: '9988776655' })
    const put = await call(financeA, 'PUT', '/setup/raast-accounts', { brands: [{ conceptId: A.conceptId, bankAccountId: brandAcc.id }] })
    expect(put.statusCode, put.body).toBe(200)
    const brand = put.json().brands.find((b: { conceptId: string }) => b.conceptId === A.conceptId)
    expect(brand.overrideBankAccountId).toBe(brandAcc.id)
    expect(brand.effective.bankAccountId).toBe(brandAcc.id)
    expect(put.json().default.bankAccountId).toBe(def.bankAccountId)
    expect(await prisma.auditLog.count({ where: { action: 'raast.accounts.update', tenantId: A.tenantId, entity: 'Concept' } })).toBe(1)

    const get = await call(financeA, 'GET', '/setup/raast-accounts')
    expect(get.statusCode).toBe(200)
    expect(get.json().brands.find((b: { conceptId: string }) => b.conceptId === A.conceptId).effective.bankAccountId).toBe(brandAcc.id)
    // B's view never lists A's brands.
    const bGet = await call(financeB, 'GET', '/setup/raast-accounts')
    expect(bGet.json().brands.find((b: { conceptId: string }) => b.conceptId === A.conceptId)).toBeUndefined()

    // Back to the default.
    const reset = await call(financeA, 'PUT', '/setup/raast-accounts', { brands: [{ conceptId: A.conceptId, bankAccountId: null }] })
    expect(reset.json().brands.find((b: { conceptId: string }) => b.conceptId === A.conceptId).effective.bankAccountId).toBe(def.bankAccountId)
  })

  it('a foreign brand is 404; a foreign, inactive or unlinked account is 422; nothing is written', async () => {
    const bBank = await mkBank(B, { code: '1026', accountNumber: '1112223334' })
    const foreignBrand = await call(financeA, 'PUT', '/setup/raast-accounts', { brands: [{ conceptId: B.conceptId, bankAccountId: null }] })
    expect(foreignBrand.statusCode).toBe(404)

    const foreignAcc = await call(financeA, 'PUT', '/setup/raast-accounts', { brands: [{ conceptId: A.conceptId, bankAccountId: bBank.id }] })
    expect(foreignAcc.statusCode).toBe(422)
    expect(foreignAcc.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')

    const inactive = await mkBank(A, { code: '1023', accountNumber: '4445556667', isActive: false })
    const r1 = await call(financeA, 'PUT', '/setup/raast-accounts', { brands: [{ conceptId: A.conceptId, bankAccountId: inactive.id }] })
    expect(r1.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')

    const unlinked = await mkBank(A, { code: '1024', accountNumber: '7778889990', accountCode: null })
    const r2 = await call(financeA, 'PUT', '/setup/raast-accounts', { brands: [{ conceptId: A.conceptId, bankAccountId: unlinked.id }] })
    expect(r2.statusCode).toBe(422)
    expect(r2.json().error.code).toBe('BANK_ACCOUNT_NOT_LINKED')

    // A batch with one bad row writes nothing.
    const good = await mkBank(A, { code: '1025', accountNumber: '1231231234' })
    const second = await prisma.concept.create({ data: { name: 'Brand rbank-a2', slug: 'brand-rbank-a2', type: 'restaurant', tenantId: A.tenantId, taxRate: 17, taxRateCash: 15, taxRateCard: 8 } })
    const mixed = await call(financeA, 'PUT', '/setup/raast-accounts', {
      brands: [{ conceptId: second.id, bankAccountId: good.id }, { conceptId: A.conceptId, bankAccountId: bBank.id }],
    })
    expect(mixed.statusCode).toBe(422)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: second.id } })).raastBankAccountId).toBeNull()
  })
})

describe('resolveRaastAccount', () => {
  it('brand override > company default > null; ignores deleted / inactive / unlinked; never another company', async () => {
    const X = await mkCompany('rbank-x')
    const Y = await mkCompany('rbank-y')
    expect(await resolveRaastAccount(prisma, X.tenantId, X.conceptId)).toBeNull()

    const def = await mkRaastAccount(X, { code: '1021' })
    expect((await resolveRaastAccount(prisma, X.tenantId, X.conceptId))?.bankAccountId).toBe(def.bankAccountId)

    const own = await mkRaastAccount(X, { code: '1022', forConceptId: X.conceptId })
    const got = await resolveRaastAccount(prisma, X.tenantId, X.conceptId)
    expect(got).toMatchObject({ bankAccountId: own.bankAccountId, ledgerCode: '1022' })

    // Override inactive → the default.
    await prisma.bankAccount.update({ where: { id: own.bankAccountId }, data: { isActive: false } })
    expect((await resolveRaastAccount(prisma, X.tenantId, X.conceptId))?.bankAccountId).toBe(def.bankAccountId)
    // Override deleted → the default.
    await prisma.bankAccount.update({ where: { id: own.bankAccountId }, data: { isActive: true, deletedAt: new Date() } })
    expect((await resolveRaastAccount(prisma, X.tenantId, X.conceptId))?.bankAccountId).toBe(def.bankAccountId)

    // The default's chart code switched off → nothing.
    await prisma.account.update({ where: { tenantId_code: { tenantId: X.tenantId, code: '1021' } }, data: { isActive: false } })
    expect(await resolveRaastAccount(prisma, X.tenantId, X.conceptId)).toBeNull()
    await prisma.account.update({ where: { tenantId_code: { tenantId: X.tenantId, code: '1021' } }, data: { isActive: true } })
    // Default unlinked → nothing.
    await prisma.bankAccount.update({ where: { id: def.bankAccountId }, data: { accountCode: null } })
    expect(await resolveRaastAccount(prisma, X.tenantId, X.conceptId)).toBeNull()
    await prisma.bankAccount.update({ where: { id: def.bankAccountId }, data: { accountCode: '1021' } })

    // A brand pointed (by a bad write) at another company's account: ignored.
    const yAcc = await mkRaastAccount(Y, { code: '1023' })
    await prisma.concept.update({ where: { id: X.conceptId }, data: { raastBankAccountId: yAcc.bankAccountId } })
    expect((await resolveRaastAccount(prisma, X.tenantId, X.conceptId))?.bankAccountId).toBe(def.bankAccountId)
    // And a brand of Y asked for under X: X's brand lookup fails → X's default, never Y's.
    expect((await resolveRaastAccount(prisma, X.tenantId, Y.conceptId))?.bankAccountId).toBe(def.bankAccountId)
    expect((await resolveRaastAccount(prisma, Y.tenantId, Y.conceptId))?.bankAccountId).toBe(yAcc.bankAccountId)
  })
})
