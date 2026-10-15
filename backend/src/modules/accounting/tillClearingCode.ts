// Till clearing — which account holds till money that did not settle on its own
// drawer (on-account clients resumed, 2026-10-15).
//
// 1115 Till Clearing is reserved in the chart, but nothing posts there until a
// company is cut over: till balances and refunds due stay on 1110 Customer
// receivable, exactly as today. The CEO's cut-over for a company writes the
// Setting `ledger.tillClearingCutoverAt:<tenantId>` (ISO time); from then on
// that company's new till-clearing postings use 1115. Readers of old lines
// keep using TILL_CLEARING_CODES (journal.ts), which lists both codes.

import type { PrismaClient, Prisma } from '@prisma/client'
import { ACCT } from './journal.js'

type Db = PrismaClient | Prisma.TransactionClient

export const TILL_CLEARING_CUTOVER_SETTING = 'ledger.tillClearingCutoverAt'

export function tillClearingCutoverKey(tenantId: string): string {
  return `${TILL_CLEARING_CUTOVER_SETTING}:${tenantId}`
}

/** When the company was cut over to 1115, or null (still on 1110). */
export async function tillClearingCutoverAt(db: Db, tenantId: string | null | undefined): Promise<Date | null> {
  if (!tenantId) return null
  const row = await db.setting.findUnique({ where: { key: tillClearingCutoverKey(tenantId) }, select: { value: true } })
  if (!row) return null
  const at = new Date(row.value)
  return Number.isNaN(at.getTime()) ? null : at
}

/** The till-clearing account code for a company's NEW postings: '1115' once cut over, else '1110'. */
export async function tillClearingCodeTx(db: Db, tenantId: string | null | undefined): Promise<'1110' | '1115'> {
  if (!tenantId) return '1110'
  // The marker's PRESENCE decides (a value that does not parse still means "cut over" — never flip back to 1110).
  const row = await db.setting.findUnique({ where: { key: tillClearingCutoverKey(tenantId) }, select: { key: true } })
  return row ? (ACCT.TILL_CLEARING as '1115') : (ACCT.CUSTOMER_AR as '1110')
}
