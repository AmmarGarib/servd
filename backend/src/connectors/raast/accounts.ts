// Raast receiving accounts — which of the company's bank accounts a Raast
// payment lands in. ONE resolver used by the till, the intents, the SMS
// matcher, the ledger snapshot and the finance views.
//
// Precedence: the brand's own account (Concept.raastBankAccountId) when it is
// a usable account OF THE SAME COMPANY; else the company's default
// (BankAccount.raastDefault); else null (Raast not set up → 422
// RAAST_NOT_SET_UP). Never another company's account. "Usable" = same
// tenantId, isActive, not deleted, accountCode set, that code is an active
// account in the company's chart (the ledger debits it), and it is a BANK
// code — never cash, the drawer, the card/gateway clearing account or
// receivables (NON_BANK_MONEY_CODES): a Raast transfer lands in a bank.

import type { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Money codes that are NOT a bank balance: 1010 cash on hand, 1015 the POS
 * drawer, 1030 card / gateway receivable, 1110 customer receivable. A Raast
 * receiving account mapped to one of them would book Raast money off the
 * bank (1030 is exactly what Raast replaces), so it is never usable.
 */
export const NON_BANK_MONEY_CODES: readonly string[] = ['1010', '1015', '1030', '1110']

export function isRaastBankCode(code: string | null | undefined): code is string {
  return !!code && !NON_BANK_MONEY_CODES.includes(code)
}

export interface RaastAccount {
  bankAccountId: string
  ledgerCode: string
  bankName: string | null
  accountTitle: string | null
  raastId: string | null
  last4: string | null
}

const ACCOUNT_SELECT = {
  id: true, tenantId: true, name: true, bankName: true, accountTitle: true, accountNumber: true, iban: true,
  raastId: true, raastDefault: true, accountCode: true, isActive: true, deletedAt: true,
} as const

type Row = Prisma.BankAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>

function last4Of(r: Pick<Row, 'accountNumber' | 'iban'>): string | null {
  const digits = String(r.accountNumber ?? r.iban ?? '').replace(/[^0-9A-Za-z]/g, '')
  return digits ? digits.slice(-4) : null
}

function toAccount(r: Row): RaastAccount {
  return {
    bankAccountId: r.id,
    ledgerCode: r.accountCode as string,
    bankName: r.bankName ?? null,
    accountTitle: r.accountTitle ?? r.name ?? null,
    raastId: r.raastId ?? null,
    last4: last4Of(r),
  }
}

/** Usable rows among `rows` for `tenantId` (chart code must be active in that company's chart). */
async function usable(db: Db, tenantId: string, rows: Row[]): Promise<Row[]> {
  const candidates = rows.filter((r) => r.tenantId === tenantId && r.isActive && !r.deletedAt && isRaastBankCode(r.accountCode))
  if (!candidates.length) return []
  const codes = [...new Set(candidates.map((r) => r.accountCode as string))]
  const live = await db.account.findMany({ where: { tenantId, code: { in: codes }, isActive: true }, select: { code: true } })
  const ok = new Set(live.map((a) => a.code))
  return candidates.filter((r) => ok.has(r.accountCode as string))
}

/** The receiving account for a Raast payment on `conceptId` in `tenantId`, or null. */
export async function resolveRaastAccount(db: Db, tenantId: string, conceptId: string): Promise<RaastAccount | null> {
  const concept = await db.concept.findFirst({ where: { id: conceptId, tenantId }, select: { raastBankAccountId: true } })
  if (concept?.raastBankAccountId) {
    const own = await db.bankAccount.findFirst({ where: { id: concept.raastBankAccountId, tenantId }, select: ACCOUNT_SELECT })
    const [ok] = own ? await usable(db, tenantId, [own]) : []
    if (ok) return toAccount(ok)
  }
  const defaults = await db.bankAccount.findMany({ where: { tenantId, raastDefault: true, deletedAt: null }, select: ACCOUNT_SELECT })
  const [def] = await usable(db, tenantId, defaults)
  return def ? toAccount(def) : null
}

export interface RaastAccountsView {
  default: RaastAccount | null
  brands: { conceptId: string; name: string; overrideBankAccountId: string | null; effective: RaastAccount | null }[]
  accounts: (RaastAccount & { name: string; isDefault: boolean })[]
}

/** The company's Raast set-up for the finance / IT views (active brands only). */
export async function raastAccountsForCompany(db: Db, tenantId: string): Promise<RaastAccountsView> {
  const rows = await db.bankAccount.findMany({ where: { tenantId, deletedAt: null }, select: ACCOUNT_SELECT, orderBy: { name: 'asc' } })
  const ok = await usable(db, tenantId, rows)
  const byId = new Map(ok.map((r) => [r.id, r]))
  const def = ok.find((r) => r.raastDefault) ?? null
  const concepts = await db.concept.findMany({
    where: { tenantId, deletedAt: null }, select: { id: true, name: true, raastBankAccountId: true }, orderBy: { name: 'asc' },
  })
  return {
    default: def ? toAccount(def) : null,
    brands: concepts.map((c) => {
      const own = c.raastBankAccountId ? byId.get(c.raastBankAccountId) : undefined
      const eff = own ?? def
      return { conceptId: c.id, name: c.name, overrideBankAccountId: c.raastBankAccountId ?? null, effective: eff ? toAccount(eff) : null }
    }),
    accounts: ok.map((r) => ({ ...toAccount(r), name: r.name, isDefault: r.raastDefault })),
  }
}
