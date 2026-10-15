// The receivables subledger's figures and row helpers — ONE definition, read
// by the /accounting/receivables routes (routes.ts re-exports every name here,
// so older importers keep working), bad-debt write-offs and the on-account
// clients (onAccount.ts).
//
// Kinds of ReceivableInvoice:
//   'invoice'     AR-YYYY-NNNN — an invoice raised in the back office (posts
//                 receivable.issue)
//   'credit_note' AR-CN-YYYY-NNNN — against its original invoice
//   'statement'   AR-ST-YYYY-NNNN — an on-account client's statement of
//                 charges already booked at the till (posts NOTHING on issue,
//                 never a tax invoice). Its balance, status and settlement
//                 follow the same rules as an invoice.
//
// What the customer still owes (balanceOf) is ONE figure everywhere:
//     total − paid − credited − withheld − written off

import type { Prisma, ReceivableInvoice, ReceivablePayment } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import { toCents, type DbMoney } from '../../lib/money.js'
import { karachiDay } from '../../connectors/util.js'

type Tx = Prisma.TransactionClient

export const INVOICE = 'invoice'
export const CREDIT_NOTE = 'credit_note'
/** An on-account client's statement (AR-ST-YYYY-NNNN): settled like an invoice, posts nothing on issue. */
export const STATEMENT = 'statement'
/** Kinds that carry a balance the customer owes (a credit note's value sits on the row it credits). */
export const LIVE_KINDS: readonly string[] = [INVOICE, STATEMENT]

/** ReceivablePayment.method of a withholding row (income tax the client withheld). */
export const WHT_METHOD = 'wht'
/**
 * ReceivablePayment.method of sales tax the CLIENT withheld from us (H13, 1335).
 * Never 'stwh' — that key is OUR withholding as an agent (2041, tax payments).
 */
export const ST_WITHHELD_METHOD = 'st_withheld'
const WITHHOLDING_METHODS: ReadonlySet<string> = new Set([WHT_METHOD, ST_WITHHELD_METHOD])

// ─── The one balance ─────────────────────────────────────────────────────────

export interface Figures {
  kind: string
  status: string
  amountCents: DbMoney
  taxCents: DbMoney
  paidCents: DbMoney
  creditedCents: DbMoney
  whtCents: DbMoney
  writtenOffCents: DbMoney
}

export const totalOf = (inv: Pick<Figures, 'amountCents' | 'taxCents'>): number => toCents(inv.amountCents) + toCents(inv.taxCents)

/**
 * What the customer still owes: total − paid − credited − withheld − written
 * off. Negative = the customer is in credit. 0 for a void row and for a
 * credit note (its value sits on the invoice it credits). A statement counts
 * like an invoice.
 */
export function balanceOf(inv: Figures): number {
  if (inv.status === 'void' || inv.kind === CREDIT_NOTE) return 0
  return totalOf(inv) - toCents(inv.paidCents) - toCents(inv.creditedCents) - toCents(inv.whtCents) - toCents(inv.writtenOffCents)
}

/**
 * An invoice's (or statement's) status from its figures: open (nothing
 * against it), partial, paid (settled with money or withholding received),
 * credited (settled by credit notes alone — nothing was ever received),
 * written_off (settled, and part or all of it was written off as a bad debt —
 * out of aging).
 */
export function statusFor(inv: Figures): 'open' | 'partial' | 'paid' | 'credited' | 'written_off' {
  const received = toCents(inv.paidCents) !== 0 || toCents(inv.whtCents) !== 0
  const writtenOff = toCents(inv.writtenOffCents) !== 0
  if (balanceOf({ ...inv, status: 'open', kind: INVOICE }) <= 0) {
    if (writtenOff) return 'written_off'
    return received ? 'paid' : 'credited'
  }
  return received || writtenOff || toCents(inv.creditedCents) !== 0 ? 'partial' : 'open'
}

/**
 * payment = money received (a write-off recovery too — it carries writeOffId)
 * · withholding = tax the client withheld (income tax 'wht' or sales tax
 * 'st_withheld') · refund = money handed back.
 */
export function paymentKind(p: Pick<ReceivablePayment, 'method' | 'amountCents'>): 'payment' | 'withholding' | 'refund' {
  if (WITHHOLDING_METHODS.has(p.method)) return 'withholding'
  return toCents(p.amountCents) < 0 ? 'refund' : 'payment'
}

/** The sourceType of a payment row's journal entry ('receivable.payment', 'receivable.wht', 'receivable.st_withheld', 'receivable.refund'). */
export function sourceOfPayment(p: Pick<ReceivablePayment, 'method' | 'amountCents'>): string {
  if (p.method === ST_WITHHELD_METHOD) return 'receivable.st_withheld'
  if (p.method === WHT_METHOD) return 'receivable.wht'
  return toCents(p.amountCents) < 0 ? 'receivable.refund' : 'receivable.payment'
}

// ─── Row helpers ─────────────────────────────────────────────────────────────

/**
 * Lock the invoice row for the rest of `tx` and read it fresh. Every change to
 * an invoice's (or statement's) figures takes this first. Lock order where an
 * on-account client is involved: order → client account → invoice.
 */
export async function lockInvoice(tx: Tx, id: string): Promise<ReceivableInvoice> {
  await tx.$queryRaw`SELECT id FROM receivable_invoices WHERE id = ${id} FOR UPDATE`
  return tx.receivableInvoice.findUniqueOrThrow({ where: { id } })
}

/** Write the status the row's figures now give (void rows and credit notes keep theirs). */
export async function restatus(tx: Tx, id: string): Promise<ReceivableInvoice> {
  const inv = await tx.receivableInvoice.findUniqueOrThrow({ where: { id } })
  if (inv.status === 'void' || inv.kind === CREDIT_NOTE) return inv
  const status = statusFor(inv)
  return status === inv.status ? inv : tx.receivableInvoice.update({ where: { id }, data: { status } })
}

/**
 * The next number per company and prefix: AR-YYYY-NNNN (invoice),
 * AR-CN-YYYY-NNNN (credit note) — year of the date in UTC, as always —
 * and AR-ST-YYYY-NNNN (statement), year of the date in Karachi.
 */
export async function nextNumber(tx: Tx, tenantId: string, date: Date, kind: string): Promise<string> {
  const prefix = kind === STATEMENT
    ? `AR-ST-${karachiDay(date).slice(0, 4)}-`
    : kind === CREDIT_NOTE ? `AR-CN-${date.getUTCFullYear()}-` : `AR-${date.getUTCFullYear()}-`
  const last = await tx.receivableInvoice.findFirst({
    where: { tenantId, number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  })
  const n = last ? parseInt(last.number.slice(prefix.length), 10) + 1 : 1
  return `${prefix}${String(n).padStart(4, '0')}`
}

/**
 * The number is max+1 per company and prefix; two documents raised at the
 * same instant can pick the same one, and the unique index rejects the
 * second. Retry the whole transaction — it rolls back cleanly, ledger entry
 * included.
 */
export async function withNumberRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err
      if (attempt === 2) throw new AppError('INVOICE_NUMBER', 'Could not allocate an invoice number — try again', 409)
    }
  }
}
