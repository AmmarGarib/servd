// Tax paid to the authorities, and the one-off reclass of provincial output
// tax out of 2030 — the settlement side of the sales tax return (finance gap
// 6). The return itself (salesTaxReturn.ts) reads what is posted here.
//
//   • recordTaxPayment — a payment of one authority's tax for a period, in the
//     company's books: Dr the authority's output account (paid + input set
//     off) / Cr its input account (input set off) / Cr the bank or cash it was
//     paid from (paid). 'wht' pays income tax withheld (Dr 2040 / Cr bank),
//     'stwh' sales tax withheld as a withholding agent (Dr 2041 / Cr bank) —
//     neither takes an input set-off. Reference 'salestax.payment:<id>', dated
//     the day it was paid; a closed period refuses it (422 PERIOD_LOCKED) and
//     nothing is saved. One payment per (company, authority, period start).
//   • linkTaxPayment — a payment already posted by hand (a manual journal or a
//     bank-reconciliation adjustment) is LINKED as that period's payment, never
//     posted again; the return then leaves that entry out of the period's
//     output, as it does a payment posted here.
//   • voidTaxPayment — a payment recorded in error: a posted one is reversed
//     ('salestax.payment.reversal:<id>', today) and its record removed; a
//     linked one is unlinked (its entry stays as it was posted).
//   • postTaxReclass — a provincial brand's output tax still in 2030 for a
//     month moves to its authority's account: Dr 2030 / Cr 203x (the other way
//     for a net refund), both lines tagged with the brand so refunds follow it
//     (orderPosting.ts refundTaxAccountFor), dated in the SAME month as the
//     sales (today, or the month's last moment for a past month). The amount
//     is the brand's 2030 balance for the whole month — what the return's
//     "To reclassify" shows — so a second call finds nothing left (no-op).
//
// Every write names the company: the payment binds to the ACTIVE company
// (create); a reclass posts in the brand's company; a void acts on the
// payment's company. Foreign rows are 404.

import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { moneyAccountCode } from '../../lib/bankAccounts.js'
import { assertMoneyFits, toCents } from '../../lib/money.js'
import { ACCT, postJournalEntry, reverseJournalEntry, type JournalLineInput } from './journal.js'
import { fmtPktDate, parsePktEndOfDay, parsePktStartOfDay, pktToday } from './dates.js'
import { outputTaxCodeFor } from './orderPosting.js'
import {
  AUTHORITIES, WITHHOLDING, TAX_PAYMENT_SOURCE, TAX_RECLASS_SOURCE,
  debitBalanceAt, misroutedOutputTax, type AuthorityKey, type WithholdingKey,
} from './salesTaxReturn.js'

export const TAX_PAYMENT_AUTHORITIES = ['fbr', 'pra', 'srb', 'kpra', 'bra', 'wht', 'stwh'] as const
export type TaxPaymentAuthority = AuthorityKey | WithholdingKey

/** How a tax payment left the company. */
export const TAX_PAYMENT_METHODS = ['bank_transfer', 'cheque', 'online', 'cash'] as const
export type TaxPaymentMethod = (typeof TAX_PAYMENT_METHODS)[number]

/** Manual and reconciliation entries are the only ones a payment may be linked to. */
const LINKABLE_PREFIXES = ['manual:', 'reconciliation.adjustment:']

/**
 * What a payment to `authority` settles: the liability it debits, the input account it may set off.
 *
 * TODO(pending owner decision G3): payroll statutory remittances (EOBI /
 * SESSI, 2090) are not paid from here yet. TODO(pending owner decision G7):
 * provincial input (1321–1324) is never posted until input tax is booked by
 * authority, so a provincial set-off finds nothing to set off — the check in
 * recordTaxPayment refuses it rather than crediting an empty account.
 */
export function settlementAccounts(authority: TaxPaymentAuthority): { liability: string; input: string | null; label: string } {
  const a = AUTHORITIES.find((x) => x.key === authority)
  if (a) return { liability: a.output, input: a.input, label: a.authority }
  const w = WITHHOLDING.find((x) => x.key === authority)
  if (w) return { liability: w.account, input: null, label: w.authority }
  throw new AppError('BAD_AUTHORITY', `Unknown tax authority "${authority}"`, 422)
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

function periodOf(fromIso: string, toIso: string): { periodFrom: Date; periodTo: Date } {
  if (!DATE.test(fromIso) || !DATE.test(toIso)) throw new AppError('INVALID_DATE', 'Give the period as YYYY-MM-DD dates', 422)
  const periodFrom = parsePktStartOfDay(fromIso)
  const periodTo = parsePktEndOfDay(toIso)
  if (Number.isNaN(periodFrom.getTime()) || Number.isNaN(periodTo.getTime())) throw new AppError('INVALID_DATE', 'Give the period as YYYY-MM-DD dates', 422)
  if (periodTo < periodFrom) throw new AppError('BAD_PERIOD', 'The period ends before it starts', 422)
  return { periodFrom, periodTo }
}

/** The PKT month 'YYYY-MM' as a period: its first and last day. */
export function monthPeriod(month: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError('INVALID_DATE', 'Give the month as YYYY-MM', 422)
  const [y, m] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

/** A payment date (YYYY-MM-DD, Pakistan) as the instant its entry is dated: midday that day. Never in the future. */
function paidAtOf(iso: string): Date {
  if (!DATE.test(iso)) throw new AppError('INVALID_DATE', 'Give the payment date as YYYY-MM-DD', 422)
  const at = new Date(`${iso}T12:00:00+05:00`)
  if (Number.isNaN(at.getTime())) throw new AppError('INVALID_DATE', 'Give the payment date as YYYY-MM-DD', 422)
  if (at.getTime() > pktToday().to.getTime()) throw new AppError('PAID_IN_FUTURE', 'The payment date is in the future', 422)
  return at
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

function alreadyPaid(label: string, periodFrom: Date): AppError {
  return new AppError(
    'TAX_PAYMENT_EXISTS',
    `A ${label} payment for the period starting ${fmtPktDate(periodFrom)} is already recorded — void it first to record it again.`,
    409,
  )
}

// ─── Record a payment ──────────────────────────────────────────────────────

export interface RecordTaxPaymentInput {
  /** The ACTIVE company — the books the payment is in. */
  tenantId: string
  authority: TaxPaymentAuthority
  periodFrom: string
  periodTo: string
  /** Paid in money (paisa). */
  paidCents: number
  /** Input tax set off against the output in the same return (sales tax only). */
  inputSetOffCents: number
  paidAt: string
  method: TaxPaymentMethod
  bankAccountId: string | null
  cprNumber: string | null
  notes: string | null
  userId: string
}

export async function recordTaxPayment(input: RecordTaxPaymentInput) {
  const acc = settlementAccounts(input.authority)
  const { periodFrom, periodTo } = periodOf(input.periodFrom, input.periodTo)
  const paidAt = paidAtOf(input.paidAt)
  if (acc.input === null && input.inputSetOffCents > 0) {
    throw new AppError('NO_INPUT_SET_OFF', `${acc.label} is paid in full — there is no input tax to set off against it`, 422)
  }
  if (input.paidCents < 0 || input.inputSetOffCents < 0) throw new AppError('BAD_AMOUNT', 'Amounts cannot be negative', 422)
  if (input.paidCents + input.inputSetOffCents <= 0) throw new AppError('NOTHING_PAID', 'Enter the amount paid (or the input tax set off)', 422)
  const outputSetOffCents = input.paidCents + input.inputSetOffCents
  assertMoneyFits(outputSetOffCents, 'This payment')

  const existing = await prisma.salesTaxPayment.findFirst({
    where: { tenantId: input.tenantId, authority: input.authority, periodFrom },
    select: { id: true },
  })
  if (existing) throw alreadyPaid(acc.label, periodFrom)

  try {
    return await prisma.$transaction(async (tx) => {
      // Where the money came from: the named bank of THIS company (422 when
      // it is another company's, deleted or unlinked), its only bank, cash.
      const money = input.paidCents > 0
        ? await moneyAccountCode(tx, input.tenantId, { method: input.method, bankAccountId: input.bankAccountId })
        : null
      // Input set off can never be more than the books hold as recoverable.
      if (acc.input && input.inputSetOffCents > 0) {
        const available = await debitBalanceAt(tx, input.tenantId, acc.input, paidAt)
        if (input.inputSetOffCents > available) {
          throw new AppError(
            'INPUT_SET_OFF_TOO_LARGE',
            `Input tax set off (PKR ${(input.inputSetOffCents / 100).toFixed(2)}) is more than ${acc.input} holds on ${fmtPktDate(paidAt)} (PKR ${(available / 100).toFixed(2)})`,
            422,
          )
        }
      }
      const row = await tx.salesTaxPayment.create({
        data: {
          tenantId: input.tenantId,
          authority: input.authority,
          periodFrom, periodTo,
          outputSetOffCents,
          inputSetOffCents: input.inputSetOffCents,
          paidCents: input.paidCents,
          paidAt,
          bankAccountId: money?.bankAccountId ?? null,
          cprNumber: input.cprNumber,
          notes: input.notes,
          createdById: input.userId,
        },
      })
      const memo = `${acc.label} ${fmtPktDate(periodFrom)} – ${fmtPktDate(periodTo)}${input.cprNumber ? ` · CPR ${input.cprNumber}` : ''}`
      const lines: JournalLineInput[] = [{ accountCode: acc.liability, type: 'debit', amountCents: outputSetOffCents, memo }]
      if (acc.input && input.inputSetOffCents > 0) lines.push({ accountCode: acc.input, type: 'credit', amountCents: input.inputSetOffCents, memo: `Input set off — ${memo}` })
      if (money && input.paidCents > 0) lines.push({ accountCode: money.code, type: 'credit', amountCents: input.paidCents, memo })
      const posted = await postJournalEntry({
        tenantId: input.tenantId,
        sourceType: TAX_PAYMENT_SOURCE,
        sourceId: row.id,
        description: `Tax paid: ${memo}`,
        entryDate: paidAt,
        postedBy: input.userId,
        lines,
      }, { tx })
      return tx.salesTaxPayment.update({ where: { id: row.id }, data: { journalEntryId: posted.entryId } })
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw alreadyPaid(acc.label, periodFrom)
    throw err
  }
}

// ─── Link an entry already posted ─────────────────────────────────────────

/** What a posted entry pays to `authority`, read from its lines. */
async function settlementOf(tenantId: string, entryId: string, authority: TaxPaymentAuthority) {
  const acc = settlementAccounts(authority)
  const entry = await prisma.journalEntry.findFirst({
    where: { id: entryId, tenantId },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  if (!entry) throw new NotFoundError('JournalEntry', entryId)
  const net = (code: string, side: 'debit' | 'credit') => entry.lines
    .filter((l) => l.account.code === code)
    .reduce((t, l) => t + (l.type === side ? toCents(l.amountCents) : -toCents(l.amountCents)), 0)
  const outputSetOffCents = net(acc.liability, 'debit')
  const inputSetOffCents = acc.input ? Math.max(0, net(acc.input, 'credit')) : 0
  // Cash and bank: cash on hand, the drawer, the 102x bank codes and any code a
  // bank account of the company is linked to.
  const banks = await prisma.bankAccount.findMany({
    where: { tenantId, deletedAt: null, accountCode: { not: null } },
    select: { id: true, accountCode: true },
  })
  const bankCodes = new Set(banks.map((b) => b.accountCode!))
  const isMoney = (code: string) => code === ACCT.CASH_ON_HAND || code === ACCT.CASH_DRAWER || /^102\d$/.test(code) || bankCodes.has(code)
  const moneyCodes = [...new Set(entry.lines.filter((l) => l.type === 'credit' && isMoney(l.account.code)).map((l) => l.account.code))]
  const moneyOutCents = moneyCodes.reduce((t, c) => t + net(c, 'credit'), 0)
  const matching = banks.filter((b) => moneyCodes.includes(b.accountCode!))
  return { entry, acc, outputSetOffCents, inputSetOffCents, moneyOutCents, bankAccountId: matching.length === 1 ? matching[0]!.id : null }
}

export interface LinkTaxPaymentInput {
  tenantId: string
  journalEntryId: string
  authority: TaxPaymentAuthority
  periodFrom: string
  periodTo: string
  cprNumber: string | null
  notes: string | null
  userId: string
}

export async function linkTaxPayment(input: LinkTaxPaymentInput) {
  const { periodFrom, periodTo } = periodOf(input.periodFrom, input.periodTo)
  const s = await settlementOf(input.tenantId, input.journalEntryId, input.authority)
  const ref = s.entry.reference ?? ''
  if (!LINKABLE_PREFIXES.some((p) => ref.startsWith(p))) {
    throw new AppError(
      'NOT_LINKABLE',
      'Only a manual journal entry or a bank-reconciliation adjustment can be linked as a tax payment. Entries posted by sales, bills or payroll belong to their document.',
      422,
    )
  }
  if (ref.startsWith('manual:')) {
    const reversed = await prisma.journalEntry.findFirst({
      where: { tenantId: input.tenantId, reference: `manual.reversal:${ref.slice('manual:'.length)}` },
      select: { id: true },
    })
    if (reversed) throw new AppError('ENTRY_REVERSED', 'This entry has been reversed — it no longer pays anything', 422)
  }
  if (s.outputSetOffCents <= 0) {
    throw new AppError('NOT_A_TAX_PAYMENT', `This entry does not debit ${s.acc.liability} (${s.acc.label}) — it is not a payment of that tax`, 422)
  }
  const paidCents = s.outputSetOffCents - s.inputSetOffCents
  if (paidCents < 0) {
    throw new AppError('NOT_A_TAX_PAYMENT', `This entry sets off more input than the ${s.acc.label} tax it settles`, 422)
  }
  if (s.moneyOutCents < paidCents) {
    throw new AppError('NOT_A_TAX_PAYMENT', `This entry does not pay PKR ${(paidCents / 100).toFixed(2)} out of a bank or cash account — it is not a payment`, 422)
  }
  try {
    return await prisma.$transaction(async (tx) => {
      // One link of an entry at a time (there is no unique index on it): a
      // double click finds the first link.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.tenantId}::text), hashtext(${`salestax.link:${s.entry.id}`}::text))`
      const taken = await tx.salesTaxPayment.findFirst({ where: { tenantId: input.tenantId, journalEntryId: s.entry.id }, select: { authority: true } })
      if (taken) throw new AppError('ALREADY_LINKED', `This entry is already recorded as a ${taken.authority.toUpperCase()} payment`, 409)
      const existing = await tx.salesTaxPayment.findFirst({
        where: { tenantId: input.tenantId, authority: input.authority, periodFrom },
        select: { id: true },
      })
      if (existing) throw alreadyPaid(s.acc.label, periodFrom)
      return tx.salesTaxPayment.create({
        data: {
          tenantId: input.tenantId,
          authority: input.authority,
          periodFrom, periodTo,
          outputSetOffCents: s.outputSetOffCents,
          inputSetOffCents: s.inputSetOffCents,
          paidCents,
          paidAt: s.entry.entryDate,
          bankAccountId: s.bankAccountId,
          cprNumber: input.cprNumber,
          notes: input.notes,
          journalEntryId: s.entry.id,
          linked: true,
          createdById: input.userId,
        },
      })
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw alreadyPaid(s.acc.label, periodFrom)
    throw err
  }
}

/**
 * Manual / reconciliation entries of `tenantId` (the last 400 days) that debit
 * `authority`'s account and are not linked yet — what "Link existing entry"
 * offers.
 */
export async function linkCandidates(tenantId: string, authority: TaxPaymentAuthority) {
  const acc = settlementAccounts(authority)
  const since = new Date(Date.now() - 400 * 86_400_000)
  const entries = await prisma.journalEntry.findMany({
    where: {
      tenantId,
      entryDate: { gte: since },
      OR: LINKABLE_PREFIXES.map((p) => ({ reference: { startsWith: p } })),
      lines: { some: { type: 'debit', account: { tenantId, code: acc.liability } } },
    },
    include: { lines: { include: { account: { select: { code: true } } } } },
    orderBy: { entryDate: 'desc' },
    take: 50,
  })
  if (entries.length === 0) return []
  const [linked, reversals] = await Promise.all([
    prisma.salesTaxPayment.findMany({ where: { tenantId, journalEntryId: { in: entries.map((e) => e.id) } }, select: { journalEntryId: true } }),
    prisma.journalEntry.findMany({
      where: {
        tenantId,
        reference: { in: entries.filter((e) => e.reference?.startsWith('manual:')).map((e) => `manual.reversal:${e.reference!.slice('manual:'.length)}`) },
      },
      select: { reference: true },
    }),
  ])
  const linkedIds = new Set(linked.map((l) => l.journalEntryId))
  const reversedRefs = new Set(reversals.map((r) => `manual:${r.reference!.slice('manual.reversal:'.length)}`))
  return entries
    .filter((e) => !linkedIds.has(e.id) && !reversedRefs.has(e.reference ?? ''))
    .map((e) => ({
      id: e.id,
      reference: e.reference,
      description: e.description,
      entryDate: fmtPktDate(e.entryDate),
      debitCents: e.lines
        .filter((l) => l.account.code === acc.liability)
        .reduce((t, l) => t + (l.type === 'debit' ? toCents(l.amountCents) : -toCents(l.amountCents)), 0),
    }))
}

// ─── Void a payment recorded in error ──────────────────────────────────────

export async function voidTaxPayment(input: { scope: Prisma.SalesTaxPaymentWhereInput; id: string; reason: string; userId: string }) {
  const row = await prisma.salesTaxPayment.findFirst({ where: { id: input.id, ...input.scope } })
  if (!row) throw new NotFoundError('SalesTaxPayment', input.id)
  await prisma.$transaction(async (tx) => {
    const gone = await tx.salesTaxPayment.deleteMany({ where: { id: row.id } })
    if (gone.count === 0) throw new NotFoundError('SalesTaxPayment', row.id)
    // A linked entry belongs to whoever posted it: unlinking leaves it as it
    // was. A payment posted here is reversed — today, in the open period.
    if (!row.linked) {
      await reverseJournalEntry(row.tenantId, TAX_PAYMENT_SOURCE, row.id, input.reason, { tx, postedBy: input.userId, entryDate: new Date() })
    }
  })
  return row
}

// ─── Reclass a provincial brand's output tax out of 2030 ───────────────────

export interface ReclassConcept {
  id: string
  tenantId: string
  slug: string
  name: string
  province: string | null
  srbPosId: number | null
}

export interface ReclassResult {
  posted: boolean
  amountCents: number
  month: string
  fromAccount: string
  toAccount: string
  entryId: string | null
  reference: string | null
  entryDate: string | null
  /** The reclasses already on the books for this brand and month. */
  previous: Array<{ id: string; reference: string | null; entryDate: string }>
}

/**
 * Move `concept`'s output tax still in 2030 for the PKT month of [from, to]
 * to its authority's account. `from` and `to` must be in one month; the amount
 * is the brand's 2030 balance for the whole month, so the reclass leaves
 * nothing behind and a repeat is a no-op.
 */
export async function postTaxReclass(input: { concept: ReclassConcept; from: string; to: string; userId: string }): Promise<ReclassResult> {
  const { concept } = input
  if (!DATE.test(input.from) || !DATE.test(input.to)) throw new AppError('INVALID_DATE', 'Give the period as YYYY-MM-DD dates', 422)
  const month = input.from.slice(0, 7)
  if (input.to.slice(0, 7) !== month) {
    throw new AppError('RECLASS_ONE_MONTH', 'A reclass is for one month — pick dates inside the same month', 422)
  }
  const toAccount = outputTaxCodeFor(concept)
  if (toAccount === ACCT.GST_OUTPUT) {
    throw new AppError('NOT_PROVINCIAL', `${concept.name} files its sales tax with FBR (2030) — there is nothing to move`, 422)
  }
  const span = monthPeriod(month)
  const monthStart = parsePktStartOfDay(span.from)
  const monthEnd = parsePktEndOfDay(span.to)
  const now = new Date()
  if (now < monthStart) throw new AppError('RECLASS_FUTURE_MONTH', 'That month has not started yet', 422)
  // In the same month as the sales: today while it is open, else its last moment.
  const entryDate = now < monthEnd ? now : monthEnd
  const base = `${TAX_RECLASS_SOURCE}:${concept.id}:${month}`

  return prisma.$transaction(async (tx) => {
    // One reclass of a brand-month at a time: the amount is read and posted
    // under the lock, so a double click finds the first one's result.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${concept.tenantId}::text), hashtext(${`lock:${base}`}::text))`
    const previous = (await tx.journalEntry.findMany({
      where: { tenantId: concept.tenantId, reference: { startsWith: base } },
      select: { id: true, reference: true, entryDate: true },
      orderBy: { createdAt: 'asc' },
    })).map((e) => ({ id: e.id, reference: e.reference, entryDate: fmtPktDate(e.entryDate) }))
    const [row] = await misroutedOutputTax(tx, concept.tenantId, monthStart, monthEnd, [concept])
    const amountCents = row?.amountCents ?? 0
    const result: ReclassResult = {
      posted: false, amountCents, month, fromAccount: ACCT.GST_OUTPUT, toAccount,
      entryId: null, reference: null, entryDate: null, previous,
    }
    if (amountCents === 0) return result

    // A top-up (tax that reached 2030 after the first reclass) gets its own reference.
    const sourceId = previous.length === 0 ? `${concept.id}:${month}` : `${concept.id}:${month}:${previous.length + 1}`
    const abs = Math.abs(amountCents)
    const memo = `${concept.name}: output tax for ${month} moved from 2030 (FBR) to ${toAccount}`
    // Positive: tax credited to 2030 moves out (Dr 2030 / Cr 203x). Negative:
    // a refund of such a sale debited 2030 — move it the other way.
    const lines: JournalLineInput[] = amountCents > 0
      ? [
          { accountCode: ACCT.GST_OUTPUT, type: 'debit', amountCents: abs, memo, conceptId: concept.id },
          { accountCode: toAccount, type: 'credit', amountCents: abs, memo, conceptId: concept.id },
        ]
      : [
          { accountCode: toAccount, type: 'debit', amountCents: abs, memo, conceptId: concept.id },
          { accountCode: ACCT.GST_OUTPUT, type: 'credit', amountCents: abs, memo, conceptId: concept.id },
        ]
    const posted = await postJournalEntry({
      tenantId: concept.tenantId,
      sourceType: TAX_RECLASS_SOURCE,
      sourceId,
      description: `Sales tax reclass — ${memo}`,
      entryDate,
      postedBy: input.userId,
      lines,
    }, { tx })
    return { ...result, posted: posted.posted, entryId: posted.entryId, reference: `${TAX_RECLASS_SOURCE}:${sourceId}`, entryDate: fmtPktDate(entryDate) }
  })
}
