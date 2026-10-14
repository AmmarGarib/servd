// Money received outside the till (owner, 2026-10-14) — the shared rules in
// lib/bankAccounts.ts that every back-office receiving screen uses:
//
//   RECEIPT_METHODS  cash · card · bank transfer · BANK DEPOSIT · cheque.
//   moneyAccountCode 'bank_deposit' lands in a bank like a transfer: the named
//                    live, linked bank of the DOCUMENT's company; else that
//                    company's only bank; 1020 with none; 422
//                    BANK_ACCOUNT_REQUIRED with two or more and none named; a
//                    bank of another company is 422 (never a silent 1020).
//   assertPaymentReference  the payment reference # is required on EVERY
//                    method, cash included (422 PAYMENT_REFERENCE_REQUIRED);
//                    trimmed; at most 100 characters.
//   receiptText      "bank deposit, ref 4471" for descriptions and memos.
//
// Two companies: A (two banks), B (one bank), C (none).
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import {
  moneyAccountCode, linkBankLedgerAccount, RECEIPT_METHODS, RECEIPT_METHOD_LABEL, isBankMethod,
  zReceiptMethod, zPaymentRef, assertPaymentReference, receiptText,
} from '../src/lib/bankAccounts.js'

const RUN = Date.now().toString(36)
let tenantA: string, tenantB: string, tenantC: string
let bankA1: string, bankA2: string, bankA2Code: string, bankB: string

/** The AppError a call throws (or fails the test). */
async function refusal(p: Promise<unknown>): Promise<AppError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    return err as AppError
  }
  throw new Error('expected a refusal')
}
function refusalSync(fn: () => unknown): AppError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    return err as AppError
  }
  throw new Error('expected a refusal')
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Receipts A', slug: `rm-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Receipts B', slug: `rm-b-${RUN}` } })).id
  tenantC = (await prisma.tenant.create({ data: { name: 'Receipts C', slug: `rm-c-${RUN}` } })).id
  for (const t of [tenantA, tenantB, tenantC]) await ensureChartOfAccounts(t)
  bankA1 = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL Ops', accountCode: '1020' } })).id
  bankA2Code = await linkBankLedgerAccount(tenantA, 'Meezan Collections')
  bankA2 = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'Meezan Collections', accountCode: bankA2Code } })).id
  bankB = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'MCB Ops', accountCode: '1020' } })).id
}, 60_000)

describe('the receipt method list', () => {
  it('is cash, card, bank transfer, bank deposit, cheque — each with its words', () => {
    expect([...RECEIPT_METHODS]).toEqual(['cash', 'card', 'bank_transfer', 'bank_deposit', 'cheque'])
    expect(RECEIPT_METHODS.map((m) => RECEIPT_METHOD_LABEL[m])).toEqual(['Cash', 'Card', 'Bank transfer', 'Bank deposit', 'Cheque'])
    // Old stored spellings still read.
    expect(RECEIPT_METHOD_LABEL['bank']).toBe('Bank transfer')
    expect(RECEIPT_METHOD_LABEL['online']).toBe('Online payment')
  })

  it('bank transfer, bank deposit and cheque land in a bank; cash and card do not', () => {
    expect(RECEIPT_METHODS.filter((m) => isBankMethod(m))).toEqual(['bank_transfer', 'bank_deposit', 'cheque'])
    expect(isBankMethod('bank')).toBe(true)
    expect(isBankMethod(null)).toBe(false)
    expect(isBankMethod('')).toBe(false)
  })

  it('zReceiptMethod takes the list (or a subset) and nothing else', () => {
    for (const m of RECEIPT_METHODS) expect(zReceiptMethod().parse(m)).toBe(m)
    expect(zReceiptMethod().safeParse('wallet').success).toBe(false)
    expect(zReceiptMethod().safeParse('online').success).toBe(false)
    const refundOnly = zReceiptMethod(['cash', 'card', 'bank_transfer'] as const)
    expect(refundOnly.safeParse('bank_deposit').success).toBe(false)
    expect(refundOnly.parse('bank_transfer')).toBe('bank_transfer')
  })

  it('zPaymentRef trims and caps at 100 characters', () => {
    expect(zPaymentRef.parse('  IBFT-0091  ')).toBe('IBFT-0091')
    expect(zPaymentRef.safeParse('x'.repeat(101)).success).toBe(false)
  })
})

describe('moneyAccountCode: a bank deposit lands in the document company\'s bank', () => {
  it('with a named bank of the company: that bank\'s own code', async () => {
    expect(await moneyAccountCode(prisma, tenantA, { method: 'bank_deposit', bankAccountId: bankA2 })).toEqual({ code: bankA2Code, bankAccountId: bankA2 })
    expect(await moneyAccountCode(prisma, tenantA, { method: 'bank_deposit', bankAccountId: bankA1 })).toEqual({ code: '1020', bankAccountId: bankA1 })
  })

  it('a company with one bank: that bank, without a pick', async () => {
    expect(await moneyAccountCode(prisma, tenantB, { method: 'bank_deposit' })).toEqual({ code: '1020', bankAccountId: bankB })
  })

  it('a company with no bank: 1020', async () => {
    expect(await moneyAccountCode(prisma, tenantC, { method: 'bank_deposit' })).toEqual({ code: '1020', bankAccountId: null })
  })

  it('two banks and none named: 422 BANK_ACCOUNT_REQUIRED — never a guess', async () => {
    const e = await refusal(moneyAccountCode(prisma, tenantA, { method: 'bank_deposit' }))
    expect([e.code, e.statusCode]).toEqual(['BANK_ACCOUNT_REQUIRED', 422])
  })

  it("another company's bank: 422 BANK_ACCOUNT_NOT_IN_COMPANY, both ways", async () => {
    const e = await refusal(moneyAccountCode(prisma, tenantA, { method: 'bank_deposit', bankAccountId: bankB }))
    expect([e.code, e.statusCode]).toEqual(['BANK_ACCOUNT_NOT_IN_COMPANY', 422])
    const f = await refusal(moneyAccountCode(prisma, tenantB, { method: 'bank_deposit', bankAccountId: bankA2 }))
    expect(f.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
  })

  it('a deleted or unlinked bank of the company: 422', async () => {
    const gone = (await prisma.bankAccount.create({ data: { tenantId: tenantC, name: 'Closed', accountCode: '1020', deletedAt: new Date() } })).id
    expect((await refusal(moneyAccountCode(prisma, tenantC, { method: 'bank_deposit', bankAccountId: gone }))).code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    const unlinked = (await prisma.bankAccount.create({ data: { tenantId: tenantC, name: 'Unlinked', accountCode: null } })).id
    expect((await refusal(moneyAccountCode(prisma, tenantC, { method: 'bank_deposit', bankAccountId: unlinked }))).code).toBe('BANK_ACCOUNT_NOT_LINKED')
  })

  it('the other receipt methods: cash 1010 (no bank allowed), card 1030, transfer and cheque like a deposit', async () => {
    expect(await moneyAccountCode(prisma, tenantA, { method: 'cash' })).toEqual({ code: '1010', bankAccountId: null })
    expect((await refusal(moneyAccountCode(prisma, tenantA, { method: 'cash', bankAccountId: bankA1 }))).code).toBe('BANK_ACCOUNT_ON_CASH')
    expect(await moneyAccountCode(prisma, tenantA, { method: 'card' })).toEqual({ code: '1030', bankAccountId: null })
    expect(await moneyAccountCode(prisma, tenantA, { method: 'bank_transfer', bankAccountId: bankA2 })).toEqual({ code: bankA2Code, bankAccountId: bankA2 })
    expect(await moneyAccountCode(prisma, tenantA, { method: 'cheque', bankAccountId: bankA2 })).toEqual({ code: bankA2Code, bankAccountId: bankA2 })
    expect((await refusal(moneyAccountCode(prisma, tenantA, { method: 'cheque' }))).code).toBe('BANK_ACCOUNT_REQUIRED')
    expect((await refusal(moneyAccountCode(prisma, tenantA, { method: 'barter' }))).code).toBe('BAD_PAYMENT_METHOD')
  })
})

describe('assertPaymentReference: required on every method, cash included', () => {
  it.each(RECEIPT_METHODS.map((m) => [m]))('%s: missing or blank is 422 PAYMENT_REFERENCE_REQUIRED', (method) => {
    for (const ref of [undefined, null, '', '   ']) {
      const e = refusalSync(() => assertPaymentReference(method, ref))
      expect([e.code, e.statusCode]).toEqual(['PAYMENT_REFERENCE_REQUIRED', 422])
    }
    expect(assertPaymentReference(method, '  SLIP-77 ')).toBe('SLIP-77')
  })

  it('names the method in its message, and caps the reference at 100 characters', () => {
    expect(refusalSync(() => assertPaymentReference('bank_deposit', '')).message).toContain('bank deposit')
    expect(refusalSync(() => assertPaymentReference('cash', '')).message).toContain('cash')
    const long = refusalSync(() => assertPaymentReference('cheque', 'x'.repeat(101)))
    expect([long.code, long.statusCode]).toEqual(['PAYMENT_REFERENCE_TOO_LONG', 422])
    expect(assertPaymentReference('cheque', 'x'.repeat(100))).toHaveLength(100)
  })
})

describe('receiptText: the words that go into the books', () => {
  it('method and reference, lower case', () => {
    expect(receiptText('bank_deposit', '4471')).toBe('bank deposit, ref 4471')
    expect(receiptText('cash', ' CV-12 ')).toBe('cash, ref CV-12')
    expect(receiptText('cheque', '000123')).toBe('cheque, ref 000123')
    expect(receiptText('bank', 'IBFT9')).toBe('bank transfer, ref IBFT9')
  })

  it('without a reference: just the method; an unknown method reads as typed', () => {
    expect(receiptText('card', null)).toBe('card')
    expect(receiptText('card', '  ')).toBe('card')
    expect(receiptText('barter', 'x1')).toBe('barter, ref x1')
    expect(receiptText(null, null)).toBe('payment')
  })
})
