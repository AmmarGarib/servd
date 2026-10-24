// City Ledger (owner, 2026-10-24: "Extend on-account") — the on-account
// clients ARE the city ledger. This file adds paying a client's till bills ONE
// BY ONE (fully or in part, a payment split explicitly across chosen bills), at
// the till or in the back office. Everything else stays where it was:
// clients, cards, limits and the CEO's approval (customerAccounts.ts), the
// till's charge (pos/onAccountTender.ts), statements (statements.ts), and the
// statement payments, withholding, refunds and write-offs (receivables/routes.ts).
//
// Which bills: a client's bill (CustomerAccountCharge) whose sale is BOOKED
// (isChargeBookedTx — its drawer closed, so 1110 was debited) and that is NOT
// on a statement yet. A bill already on a statement is paid through the
// statement (Receivables) — 409 BILL_ON_STATEMENT names it. A statement then
// bills only what is still owed on each bill (amount − refunded − settled).
//
// Still owed on a bill = amountCents − refundedCents − settledCents
// (`chargeOwedCents`); settledCents = Σ its live allocations, kept on the
// charge (conditional increments under the client's lock).
//
// Money — ONE entry per settlement, 'cityledger.settlement:<id>', in the
// CLIENT's company, inside the settlement's transaction (a closed month
// refuses it and nothing is saved):
//     Dr the money account / Cr 1110 Customer receivable (one line per brand
//     of the bills, memo'd ON_ACCOUNT_MEMO so the till-clearing cut-over and
//     its sweep leave it alone).
//   • at the till, cash: the money goes INTO the drawer — Dr 1015 Drawer, and
//     a drawer pay-in (CashMovement 'payin') so the cashier's count expects
//     it; the drawer's close skips that pay-in (accounting/shiftPosting.ts),
//     so it is booked once.
//   • at the till, bank transfer: Dr the company's bank (moneyAccountCode),
//     reference required; nothing in the drawer.
//   • back office (finance): cash on hand 1010 / bank transfer / bank deposit
//     / cheque (RECEIPT_METHODS, never card — H50) with a reference # on every
//     method (assertPaymentReference).
//   Card and Raast are not taken against City Ledger bills: a card payment's
//   payout matching and a Raast receipt's bank matching read till SALE
//   payments only, so a settlement on them could never be matched.
//
// Reversal ('cityledger.settlement.reversal:<id>'): finance or the CEO, reason
// ≥10, the entry mirrored, the allocations' amounts given back to the bills
// (still owed again) — refused while one of its bills is on a statement (409
// SETTLED_BILL_ON_STATEMENT: the statement billed only the rest; void it first). Till cash only while its drawer is still OPEN — the cash
// goes back out of the drawer as a pay-out the close also skips; after the
// close it is a manual journal (409 DRAWER_CLOSED_USE_JOURNAL).
//
// Idempotent: (tenantId, idempotencyKey) — a retry returns the first
// settlement; the same key with different bills or amounts is 409.
// Lock order: (the order, never here) → client account → its charges.

import type { CityLedgerAllocation, CityLedgerSettlement, CustomerAccount, CustomerAccountCharge, Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertInt4Fits, toCents } from '../../lib/money.js'
import { RECEIPT_METHODS, assertPaymentReference, moneyAccountCode, receiptText } from '../../lib/bankAccounts.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { karachiDay } from '../../connectors/util.js'
import { ACCT, ON_ACCOUNT_MEMO, postJournalEntry, reverseJournalEntry, type JournalLineInput } from '../accounting/journal.js'
import { isChargeBookedTx, lockAccountTx } from './onAccount.js'
import { balanceOf, STATEMENT } from './ledger.js'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

export const SETTLEMENT_SOURCE = 'cityledger.settlement'
/** At the till: cash into the drawer, or a bank transfer with its reference. */
export const TILL_SETTLE_METHODS = ['cash', 'bank_transfer'] as const
/** Back office: the receipt methods (never card). */
export const OFFICE_SETTLE_METHODS = RECEIPT_METHODS

export const ACCOUNT_TYPES = ['company', 'corporate', 'travel_agent', 'guest', 'other'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  company: 'Company', corporate: 'Corporate customer', travel_agent: 'Travel agent', guest: 'Guest', other: 'Other',
}

const DAY = 86_400_000

/** Still owed on a bill not on a statement. */
export function chargeOwedCents(c: Pick<CustomerAccountCharge, 'amountCents' | 'refundedCents' | 'settledCents'>): number {
  return c.amountCents - c.refundedCents - c.settledCents
}

/** A bill's due day (YYYY-MM-DD, Karachi): its own day + the client's payment terms. */
export function billDueDay(chargedAt: Date, termsDays: number): string {
  return karachiDay(new Date(chargedAt.getTime() + termsDays * DAY))
}

export type BillStatus = 'open' | 'partial' | 'settled' | 'overdue' | 'refunded' | 'on_statement'

/** The status of a bill not on a statement (a bill on one follows its statement). */
export function billStatusOf(
  c: Pick<CustomerAccountCharge, 'amountCents' | 'refundedCents' | 'settledCents' | 'chargedAt'>,
  termsDays: number,
  graceDays: number,
  now: Date = new Date(),
): BillStatus {
  const owed = chargeOwedCents(c)
  if (c.refundedCents >= c.amountCents) return 'refunded'
  if (owed <= 0) return 'settled'
  const overdueAfter = karachiDay(new Date(c.chargedAt.getTime() + (termsDays + graceDays) * DAY))
  if (overdueAfter < karachiDay(now)) return 'overdue'
  return c.settledCents > 0 ? 'partial' : 'open'
}

const refuse = (code: string, message: string, status: number, details?: unknown) => new AppError(code, message, status, details)

// ─── Settle ──────────────────────────────────────────────────────────────────

export interface SettleInput {
  account: Pick<CustomerAccount, 'id' | 'tenantId'>
  /** Explicit split: which bills and how much on each (≥1, each > 0, no bill twice). */
  allocations: Array<{ chargeId: string; amountCents: number }>
  method: string
  reference?: string | null
  bankAccountId?: string | null
  receivedAt: Date
  channel: 'till' | 'back_office'
  /** The cashier's OPEN drawer (till only), already checked to be the client's company and the caller's. */
  shiftId?: string | null
  note?: string | null
  idempotencyKey?: string | null
  actorId: string
  /**
   * 'in' (default): money received against bills. 'out' (back office only): money PAID BACK on bills that owe
   * back (a bill refunded after it was paid — owed < 0): Dr 1110 / Cr the money, the bill's settled goes down.
   */
  direction?: 'in' | 'out'
  /** Till bank transfer: the cashier saw the credit on the counter device (bank app / SMS) — required. */
  transferVerified?: boolean
}

export interface SettleResult {
  settlement: CityLedgerSettlement & { allocations: CityLedgerAllocation[] }
  replayed: boolean
}

function sameRequest(s: CityLedgerSettlement & { allocations: CityLedgerAllocation[] }, input: SettleInput): boolean {
  const want = new Map(input.allocations.map((a) => [a.chargeId, a.amountCents]))
  return s.accountId === input.account.id && s.method === input.method && s.channel === input.channel && s.direction === (input.direction ?? 'in')
    && s.allocations.length === want.size && s.allocations.every((a) => want.get(a.chargeId) === a.amountCents)
}

export async function settleBills(input: SettleInput): Promise<SettleResult> {
  const { account } = input
  const out = input.direction === 'out'
  if (out && input.channel !== 'back_office') throw refuse('PAYBACK_BACK_OFFICE_ONLY', 'Money owed back to a client is paid by finance', 422)
  if (input.allocations.length === 0) throw refuse('NO_BILLS', 'Pick at least one bill to settle', 422)
  const ids = new Set<string>()
  for (const a of input.allocations) {
    if (ids.has(a.chargeId)) throw refuse('BILL_LISTED_TWICE', 'A bill is listed twice', 422)
    ids.add(a.chargeId)
    if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) throw refuse('INVALID_AMOUNT', 'Each amount must be more than zero', 422)
    assertInt4Fits(a.amountCents, 'An amount')
  }
  const total = input.allocations.reduce((t, a) => t + a.amountCents, 0)
  assertInt4Fits(total, 'The payment')

  // Methods and references per channel.
  let reference = (input.reference ?? '').trim() || null
  if (input.channel === 'till') {
    if (!(TILL_SETTLE_METHODS as readonly string[]).includes(input.method)) {
      throw refuse('METHOD_NOT_AT_TILL', 'At the till a City Ledger bill is settled in cash or by bank transfer', 422)
    }
    if (!input.shiftId) throw refuse('SHIFT_REQUIRED', 'Open your drawer first', 422)
    if (input.method === 'bank_transfer') {
      reference = assertPaymentReference(input.method, reference)
      // The money is checked on the counter device, never the customer's screen (the Raast rule).
      if (input.transferVerified !== true) throw refuse('TRANSFER_NOT_VERIFIED', 'Check the transfer has arrived on the counter device (bank app / SMS) and tick that you saw it', 422)
    }
    if (input.method === 'cash' && input.bankAccountId) throw refuse('BANK_ACCOUNT_ON_CASH', 'A cash payment does not use a bank account', 422)
  } else {
    if (!(OFFICE_SETTLE_METHODS as readonly string[]).includes(input.method)) {
      throw refuse('CARD_NOT_A_RECEIPT', 'Back-office receipts are cash, bank transfer, bank deposit or cheque', 422)
    }
    reference = assertPaymentReference(input.method, reference)
  }
  // A receipt is dated today or earlier (never in the future).
  if (karachiDay(input.receivedAt) > karachiDay(new Date())) throw refuse('DATE_IN_FUTURE', 'The date received cannot be in the future', 422)

  const tenantId = account.tenantId
  try {
    return await prisma.$transaction(async (tx) => {
      // A retry returns the first settlement.
      if (input.idempotencyKey) {
        const prior = await tx.cityLedgerSettlement.findFirst({ where: { tenantId, idempotencyKey: input.idempotencyKey }, include: { allocations: true } })
        if (prior) {
          if (!sameRequest(prior, input)) throw refuse('IDEMPOTENCY_KEY_REUSED', 'That idempotency key belongs to a different settlement', 409)
          return { settlement: prior, replayed: true }
        }
      }
      const client = await lockAccountTx(tx, account.id)
      if (client.tenantId !== tenantId) throw new NotFoundError('CustomerAccount', account.id)
      if (client.status === 'pending') throw refuse('CLIENT_NOT_APPROVED', 'This client is not approved yet — it has no bills', 409)
      // A till bank transfer reference pays ONE settlement only (the same transfer never settles twice).
      if (input.channel === 'till' && input.method === 'bank_transfer' && reference) {
        const used = await tx.cityLedgerSettlement.findFirst({ where: { tenantId, reference, method: 'bank_transfer', reversedAt: null }, select: { number: true } })
        if (used) throw refuse('REFERENCE_USED', `That transfer reference is already on settlement ${used.number}`, 409)
      }

      const charges = await tx.customerAccountCharge.findMany({ where: { id: { in: [...ids] }, tenantId, accountId: client.id } })
      if (charges.length !== ids.size) throw new NotFoundError('CustomerAccountCharge')
      const byId = new Map(charges.map((c) => [c.id, c]))
      const statementIds = [...new Set(charges.map((c) => c.statementInvoiceId).filter((x): x is string => !!x))]
      if (statementIds.length) {
        const st = await tx.receivableInvoice.findMany({ where: { id: { in: statementIds }, tenantId }, select: { number: true } })
        throw refuse('BILL_ON_STATEMENT', `That bill is on statement ${st.map((s) => s.number).join(', ')} — record the payment against the statement in Receivables`, 409, { statements: st.map((s) => s.number) })
      }
      for (const a of input.allocations) {
        const c = byId.get(a.chargeId)!
        if (!(await isChargeBookedTx(tx, c))) {
          throw refuse('BILL_NOT_BOOKED', `Bill #${orderRefOf(c.orderId)} is not in the books yet — settle it once the drawer that billed it has closed`, 409, { chargeId: c.id })
        }
        const owed = chargeOwedCents(c)
        if (out) {
          if (owed >= 0) throw refuse('NOTHING_OWED_BACK', `Bill #${orderRefOf(c.orderId)} owes nothing back`, 409, { chargeId: c.id })
          if (a.amountCents > -owed) throw refuse('OVER_ALLOCATED', `That is more than bill #${orderRefOf(c.orderId)} is owed back (PKR ${(-owed / 100).toLocaleString('en-PK')})`, 409, { chargeId: c.id, owedBackCents: -owed })
        } else {
          if (owed <= 0) throw refuse('BILL_ALREADY_SETTLED', `Bill #${orderRefOf(c.orderId)} is already settled`, 409, { chargeId: c.id })
          if (a.amountCents > owed) {
            throw refuse('OVER_ALLOCATED', `That is more than bill #${orderRefOf(c.orderId)} still owes (PKR ${(owed / 100).toLocaleString('en-PK')})`, 409, { chargeId: c.id, owedCents: owed })
          }
        }
        // Never dated before the bill itself.
        if (karachiDay(input.receivedAt) < karachiDay(c.chargedAt)) throw refuse('DATE_BEFORE_BILL', `The date is before bill #${orderRefOf(c.orderId)}`, 422)
      }

      // The money account.
      let moneyCode: string
      let bankAccountId: string | null = null
      let cashMovementId: string | null = null
      const number = await nextSettlementNumber(tx, tenantId)
      if (input.channel === 'till') {
        // The drawer: locked and re-read, so a close running now cannot miss the pay-in.
        // NO KEY UPDATE: serialises with the close's status claim, never with a payment row's foreign-key lock.
        await tx.$queryRaw`SELECT id FROM shifts WHERE id = ${input.shiftId!} FOR NO KEY UPDATE`
        const shift = await tx.shift.findUnique({ where: { id: input.shiftId! }, select: { status: true, tenantId: true } })
        if (!shift || shift.status !== 'open') throw refuse('SHIFT_CLOSED', 'This drawer is closed — open a new shift', 422)
        if (shift.tenantId && shift.tenantId !== tenantId) throw refuse('SHIFT_NOT_IN_COMPANY', 'That drawer is not of the client’s company', 422)
        if (input.method === 'cash') {
          moneyCode = ACCT.CASH_DRAWER
          const mv = await tx.cashMovement.create({
            data: { shiftId: input.shiftId!, type: 'payin', amountCents: total, reason: `City Ledger ${number} — ${client.number} ${client.legalName}`.slice(0, 250), recordedById: input.actorId },
          })
          cashMovementId = mv.id
        } else {
          const m = await moneyAccountCode(tx, tenantId, { method: input.method, bankAccountId: input.bankAccountId ?? null })
          moneyCode = m.code
          bankAccountId = m.bankAccountId
        }
      } else {
        const m = await moneyAccountCode(tx, tenantId, { method: input.method, bankAccountId: input.bankAccountId ?? null })
        moneyCode = m.code
        bankAccountId = m.bankAccountId
      }

      const settlement = await tx.cityLedgerSettlement.create({
        data: {
          tenantId, accountId: client.id, number, amountCents: total, method: input.method, reference, bankAccountId,
          receivedAt: input.receivedAt, channel: input.channel, shiftId: input.channel === 'till' ? input.shiftId! : null,
          cashMovementId, moneyAccountCode: moneyCode, idempotencyKey: input.idempotencyKey ?? null, direction: out ? 'out' : 'in',
          note: input.note?.trim() || null, createdById: input.actorId,
        },
      })
      for (const a of input.allocations) {
        await tx.cityLedgerAllocation.create({ data: { tenantId, settlementId: settlement.id, chargeId: a.chargeId, amountCents: a.amountCents } })
        // Conditional: never past what the bill owes, whatever ran in between.
        const c = byId.get(a.chargeId)!
        const moved = await tx.customerAccountCharge.updateMany({
          where: { id: c.id, statementInvoiceId: null, settledCents: c.settledCents, refundedCents: c.refundedCents },
          data: { settledCents: out ? { decrement: a.amountCents } : { increment: a.amountCents } },
        })
        if (moved.count !== 1) throw refuse('BILL_CHANGED', 'A bill changed while settling — try again', 409)
      }

      // ONE entry: Dr the money / Cr 1110 per brand of the bills.
      const byBrand = new Map<string, { cents: number; refs: string[] }>()
      for (const a of input.allocations) {
        const c = byId.get(a.chargeId)!
        const b = byBrand.get(c.conceptId) ?? { cents: 0, refs: [] }
        b.cents += a.amountCents
        b.refs.push(`#${orderRefOf(c.orderId)}`)
        byBrand.set(c.conceptId, b)
      }
      const how = receiptText(input.method, reference ?? number)
      const memoBase = `${ON_ACCOUNT_MEMO} — ${client.number} ${client.legalName} — City Ledger ${number}`
      // In: Dr the money / Cr 1110. Out (paid back): Dr 1110 / Cr the money.
      const moneySide = out ? 'credit' : 'debit'
      const arSide = out ? 'debit' : 'credit'
      const lines: JournalLineInput[] = [
        { accountCode: moneyCode, type: moneySide, amountCents: total, memo: `${memoBase}${out ? ' — paid back' : ''} (${how})`.slice(0, 250), conceptId: byBrand.size === 1 ? [...byBrand.keys()][0] : undefined },
        ...[...byBrand.entries()].map(([conceptId, b]): JournalLineInput => ({
          accountCode: ACCT.CUSTOMER_AR, type: arSide, amountCents: b.cents, conceptId,
          memo: `${memoBase} — bills ${b.refs.join(', ')}`.slice(0, 250),
        })),
      ]
      const posted = await postJournalEntry({
        tenantId,
        sourceType: SETTLEMENT_SOURCE,
        sourceId: settlement.id,
        description: `City Ledger ${out ? 'pay-back' : 'settlement'} ${number} — ${client.legalName} (${how})`.slice(0, 500),
        entryDate: input.receivedAt,
        postedBy: input.actorId,
        lines,
      }, { tx })
      if (!posted.posted) throw refuse('ALREADY_POSTED', `Settlement ${number} is already booked`, 409)
      const full = await tx.cityLedgerSettlement.findUniqueOrThrow({ where: { id: settlement.id }, include: { allocations: true } })
      return { settlement: full, replayed: false }
    }, { maxWait: 10_000, timeout: 20_000 })
  } catch (err) {
    // Two taps with one key: the loser's unique violation reads as the winner's replay.
    if ((err as { code?: string })?.code === 'P2002' && input.idempotencyKey) {
      const prior = await prisma.cityLedgerSettlement.findFirst({ where: { tenantId, idempotencyKey: input.idempotencyKey }, include: { allocations: true } })
      if (prior && sameRequest(prior, input)) return { settlement: prior, replayed: true }
    }
    throw err
  }
}

async function nextSettlementNumber(tx: Tx, tenantId: string): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'cl_settlement_number:' + tenantId}))`
  const [{ max }] = await tx.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX(CAST(SUBSTRING("number" FROM 5) AS INTEGER)) AS max
    FROM city_ledger_settlements WHERE "tenantId" = ${tenantId} AND "number" ~ '^CLS-[0-9]+$'`
  return `CLS-${String((max ?? 0) + 1).padStart(5, '0')}`
}

// ─── Reverse ─────────────────────────────────────────────────────────────────

export async function reverseSettlement(input: {
  settlementId: string; tenantIds: string[]; reason: string; actorId: string
  /** Till cash whose drawer has CLOSED: where the money goes back out from (default 1010 cash on hand). */
  refundFrom?: { method: string; bankAccountId?: string | null } | null
}): Promise<CityLedgerSettlement> {
  const reason = input.reason.trim()
  if (reason.length < 10) throw refuse('REASON_TOO_SHORT', 'Say why in at least 10 characters', 422)
  const found = await prisma.cityLedgerSettlement.findFirst({ where: { id: input.settlementId, tenantId: { in: input.tenantIds } }, select: { id: true, accountId: true, tenantId: true } })
  if (!found) throw new NotFoundError('CityLedgerSettlement', input.settlementId)
  return prisma.$transaction(async (tx) => {
    await lockAccountTx(tx, found.accountId)
    const s = await tx.cityLedgerSettlement.findUniqueOrThrow({ where: { id: found.id }, include: { allocations: true, account: { select: { number: true, legalName: true } } } })
    if (s.reversedAt) throw refuse('ALREADY_REVERSED', `Settlement ${s.number} is already reversed`, 409)
    // A bill paid here and billed since on a statement: the statement billed only the rest, so giving the money
    // back to the bill would leave the statement short. Void the statement first (it releases its bills).
    const billed = await tx.customerAccountCharge.findMany({ where: { id: { in: s.allocations.map((a) => a.chargeId) }, statementInvoiceId: { not: null } }, select: { statementInvoiceId: true } })
    if (billed.length) {
      const st = await tx.receivableInvoice.findMany({ where: { id: { in: billed.map((b) => b.statementInvoiceId!) } }, select: { number: true } })
      throw refuse('SETTLED_BILL_ON_STATEMENT', `A bill of settlement ${s.number} is now on statement ${st.map((x) => x.number).join(', ')} — void that statement first`, 409)
    }
    let reversalCashMovementId: string | null = null
    // Till cash: back out of the SAME drawer while it is open (a pay-out its close skips); once it has closed,
    // the cash went on to cash on hand / the bank with the close, so it goes back out from there.
    let closedDrawerFrom: string | null = null
    if (s.cashMovementId) {
      await tx.$queryRaw`SELECT id FROM shifts WHERE id = ${s.shiftId!} FOR NO KEY UPDATE`
      const shift = await tx.shift.findUnique({ where: { id: s.shiftId! }, select: { status: true } })
      if (shift?.status === 'open') {
        const mv = await tx.cashMovement.create({
          data: { shiftId: s.shiftId!, type: 'payout', amountCents: toCents(s.amountCents), reason: `City Ledger ${s.number} reversed — ${reason}`.slice(0, 250), recordedById: input.actorId },
        })
        reversalCashMovementId = mv.id
      } else {
        const from = input.refundFrom ?? { method: 'cash', bankAccountId: null }
        if (!(OFFICE_SETTLE_METHODS as readonly string[]).includes(from.method)) throw refuse('BAD_PAYMENT_METHOD', 'Say where the money goes back out from (cash on hand or a bank)', 422)
        closedDrawerFrom = (await moneyAccountCode(tx, s.tenantId, { method: from.method, bankAccountId: from.bankAccountId ?? null })).code
      }
    }
    const back = s.direction === 'out'
    for (const a of s.allocations) {
      const moved = await tx.customerAccountCharge.updateMany({
        where: back ? { id: a.chargeId } : { id: a.chargeId, settledCents: { gte: a.amountCents } },
        data: { settledCents: back ? { increment: a.amountCents } : { decrement: a.amountCents } },
      })
      if (moved.count !== 1) throw refuse('BILL_CHANGED', 'A bill changed while reversing — try again', 409)
    }
    const why = `Reversal of City Ledger ${back ? 'pay-back' : 'settlement'} ${s.number}: ${reason}`.slice(0, 250)
    if (closedDrawerFrom) {
      // The original's 1110 lines mirrored per brand; the money side from where the cash now is.
      const orig = await tx.journalEntry.findFirstOrThrow({ where: { tenantId: s.tenantId, reference: `${SETTLEMENT_SOURCE}:${s.id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
      const arLines = orig.lines.filter((l) => l.account.code === ACCT.CUSTOMER_AR)
      const posted = await postJournalEntry({
        tenantId: s.tenantId, sourceType: `${SETTLEMENT_SOURCE}.reversal`, sourceId: s.id, description: why, postedBy: input.actorId,
        lines: [
          ...arLines.map((l): JournalLineInput => ({ accountCode: ACCT.CUSTOMER_AR, type: 'debit', amountCents: toCents(l.amountCents), conceptId: l.conceptId ?? undefined, memo: l.memo ?? undefined })),
          { accountCode: closedDrawerFrom, type: 'credit', amountCents: toCents(s.amountCents), memo: `${ON_ACCOUNT_MEMO} — City Ledger ${s.number} reversed after its drawer closed — ${reason}`.slice(0, 250) },
        ],
      }, { tx })
      if (!posted.posted) throw refuse('ALREADY_REVERSED', `Settlement ${s.number} is already reversed`, 409)
    } else {
      await reverseJournalEntry(s.tenantId, SETTLEMENT_SOURCE, s.id, why, { tx, postedBy: input.actorId })
    }
    const claimed = await tx.cityLedgerSettlement.updateMany({
      where: { id: s.id, reversedAt: null },
      data: { reversedAt: new Date(), reversedById: input.actorId, reversedReason: reason.slice(0, 500), reversalCashMovementId },
    })
    if (claimed.count !== 1) throw refuse('ALREADY_REVERSED', `Settlement ${s.number} is already reversed`, 409)
    return tx.cityLedgerSettlement.findUniqueOrThrow({ where: { id: s.id } })
  }, { maxWait: 10_000, timeout: 20_000 })
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export interface OutstandingBill {
  chargeId: string
  orderId: string
  orderRef: string
  conceptId: string
  brand: string | null
  chargedAt: Date
  /** YYYY-MM-DD (Karachi). */
  dueDate: string
  reference: string | null
  amountCents: number
  taxCents: number
  refundedCents: number
  settledCents: number
  owedCents: number
  status: BillStatus
  booked: boolean
  statementNumber: string | null
}

/**
 * A client's bills with what each still owes. `onlyOpen` = bills that can be
 * settled one by one now (not on a statement, owing > 0). Read in the CLIENT's
 * company only.
 */
export async function clientBills(db: Db, account: Pick<CustomerAccount, 'id' | 'tenantId' | 'termsDays' | 'overdueGraceDays'>, opts: { onlyOpen?: boolean; includeOwedBack?: boolean; from?: Date; to?: Date } = {}): Promise<OutstandingBill[]> {
  const rows = await db.customerAccountCharge.findMany({
    where: {
      tenantId: account.tenantId, accountId: account.id,
      ...(opts.onlyOpen ? { statementInvoiceId: null } : {}),
      ...(opts.from || opts.to ? { chargedAt: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } } : {}),
    },
    orderBy: { chargedAt: 'asc' },
    take: 2000,
  })
  const conceptIds = [...new Set(rows.map((r) => r.conceptId))]
  const stIds = [...new Set(rows.map((r) => r.statementInvoiceId).filter((x): x is string => !!x))]
  const [concepts, statements] = await Promise.all([
    conceptIds.length ? db.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, name: true } }) : [],
    stIds.length ? db.receivableInvoice.findMany({ where: { id: { in: stIds }, tenantId: account.tenantId }, select: { id: true, number: true } }) : [],
  ])
  const brandOf = new Map(concepts.map((c) => [c.id, c.name]))
  const stOf = new Map(statements.map((s) => [s.id, s.number]))
  const out: OutstandingBill[] = []
  for (const c of rows) {
    const owed = c.statementInvoiceId ? 0 : chargeOwedCents(c)
    // Open = owes something; with includeOwedBack also a bill that owes BACK (finance pays it back).
    if (opts.onlyOpen && (opts.includeOwedBack ? owed === 0 : owed <= 0)) continue
    out.push({
      chargeId: c.id, orderId: c.orderId, orderRef: orderRefOf(c.orderId), conceptId: c.conceptId, brand: brandOf.get(c.conceptId) ?? null,
      chargedAt: c.chargedAt, dueDate: billDueDay(c.chargedAt, account.termsDays), reference: c.reference,
      amountCents: c.amountCents, taxCents: c.taxCents, refundedCents: c.refundedCents, settledCents: c.settledCents, owedCents: owed,
      status: c.statementInvoiceId ? 'on_statement' : billStatusOf(c, account.termsDays, account.overdueGraceDays),
      booked: c.statementInvoiceId ? true : await isChargeBookedTx(db, c),
      statementNumber: c.statementInvoiceId ? stOf.get(c.statementInvoiceId) ?? null : null,
    })
  }
  return out
}

export interface HistoryRow {
  at: Date
  type: 'bill' | 'refund' | 'settlement' | 'settlement_reversed' | 'pay_back' | 'pay_back_reversed' | 'statement_payment' | 'statement_payment_reversed' | 'write_off'
  reference: string
  orderRef: string | null
  /** + raises what the client owes, − lowers it. */
  debitCents: number
  creditCents: number
  balanceCents: number
  voucher: string | null
  status: string
  createdBy: string | null
}

/**
 * The client's transaction history: every bill (+), refund (−), City Ledger
 * settlement (−) and its reversal (+), statement payment (−) and its reversal
 * (+), approved write-off (−), with the running balance. The last balance
 * equals what the client owes now (exposure − credit) — tested.
 */
export async function clientHistory(db: Db, account: Pick<CustomerAccount, 'id' | 'tenantId'>): Promise<HistoryRow[]> {
  const t = account.tenantId
  const invoices = await db.receivableInvoice.findMany({ where: { tenantId: t, customerAccountId: account.id, kind: STATEMENT }, select: { id: true, number: true } })
  const invoiceNo = new Map(invoices.map((i) => [i.id, i.number]))
  const [charges, settlements, payments, writeOffs] = await Promise.all([
    db.customerAccountCharge.findMany({ where: { tenantId: t, accountId: account.id }, orderBy: { chargedAt: 'asc' } }),
    db.cityLedgerSettlement.findMany({ where: { tenantId: t, accountId: account.id }, include: { allocations: true } }),
    // POS bills only: payments on the client's STATEMENTS (a back-office invoice naming the client is not City Ledger).
    db.receivablePayment.findMany({ where: { tenantId: t, invoice: { tenantId: t, customerAccountId: account.id, kind: STATEMENT } }, include: { invoice: { select: { number: true } } } }),
    invoices.length ? db.receivableWriteOff.findMany({ where: { tenantId: t, status: 'approved', invoiceId: { in: invoices.map((i) => i.id) } } }) : [],
  ])
  const userIds = [...new Set([...charges.map((c) => c.chargedById), ...settlements.map((s) => s.createdById), ...payments.map((p) => p.createdById ?? '')].filter(Boolean))]
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []
  const nameOf = new Map(users.map((u) => [u.id, u.name]))
  const rows: Array<Omit<HistoryRow, 'balanceCents'>> = []
  // Refunds on the bills, dated when they were applied (the refund row's onAccountApplied marker).
  const refundedOrders = charges.filter((c) => c.refundedCents > 0).map((c) => c.orderId)
  const refundRows = refundedOrders.length
    ? await db.payment.findMany({ where: { orderId: { in: refundedOrders }, status: 'refunded' }, select: { id: true, orderId: true, createdAt: true, gatewayMeta: true } })
    : []
  const refundsOf = new Map<string, Array<{ at: Date; cents: number; id: string }>>()
  for (const r of refundRows) {
    const m = (r.gatewayMeta && typeof r.gatewayMeta === 'object' && !Array.isArray(r.gatewayMeta)) ? (r.gatewayMeta as Record<string, unknown>)['onAccountApplied'] as { cents?: number; at?: string } | undefined : undefined
    if (!m?.cents) continue
    refundsOf.set(r.orderId, [...(refundsOf.get(r.orderId) ?? []), { at: m.at ? new Date(m.at) : r.createdAt, cents: m.cents, id: r.id }])
  }
  for (const c of charges) {
    rows.push({ at: c.chargedAt, type: 'bill', reference: `Bill #${orderRefOf(c.orderId)}${c.reference ? ` · ${c.reference}` : ''}`, orderRef: orderRefOf(c.orderId), debitCents: c.amountCents, creditCents: 0, voucher: null, status: 'posted', createdBy: nameOf.get(c.chargedById) ?? null })
    let left = c.refundedCents
    for (const r of refundsOf.get(c.orderId) ?? []) {
      const cents = Math.min(left, r.cents)
      if (cents <= 0) continue
      left -= cents
      rows.push({ at: r.at, type: 'refund', reference: `Refund on bill #${orderRefOf(c.orderId)}`, orderRef: orderRefOf(c.orderId), debitCents: 0, creditCents: cents, voucher: `order.refund:${r.id}`, status: 'posted', createdBy: null })
    }
    if (left > 0) rows.push({ at: c.chargedAt, type: 'refund', reference: `Refund on bill #${orderRefOf(c.orderId)}`, orderRef: orderRefOf(c.orderId), debitCents: 0, creditCents: left, voucher: null, status: 'posted', createdBy: null })
  }
  for (const s of settlements) {
    const amt = toCents(s.amountCents)
    const back = s.direction === 'out'
    rows.push({ at: s.receivedAt, type: back ? 'pay_back' : 'settlement', reference: `${s.number}${back ? ' paid back' : ''} · ${s.method}${s.reference ? ` · ${s.reference}` : ''} · ${s.allocations.length} bill(s)`, orderRef: null, debitCents: back ? amt : 0, creditCents: back ? 0 : amt, voucher: `${SETTLEMENT_SOURCE}:${s.id}`, status: s.reversedAt ? 'reversed' : 'posted', createdBy: nameOf.get(s.createdById) ?? null })
    if (s.reversedAt) rows.push({ at: s.reversedAt, type: back ? 'pay_back_reversed' : 'settlement_reversed', reference: `${s.number} reversed — ${s.reversedReason ?? ''}`, orderRef: null, debitCents: back ? 0 : amt, creditCents: back ? amt : 0, voucher: `${SETTLEMENT_SOURCE}.reversal:${s.id}`, status: 'posted', createdBy: null })
  }
  for (const p of payments) {
    const amt = toCents(p.amountCents)
    // A refund paid out to the client is a negative-direction row (money handed back raises what they are owed back).
    const isRefund = p.method === 'refund' || amt < 0
    rows.push({ at: p.receivedAt, type: 'statement_payment', reference: `${p.invoice.number} · ${p.method}${p.reference ? ` · ${p.reference}` : ''}`, orderRef: null, debitCents: isRefund ? Math.abs(amt) : 0, creditCents: isRefund ? 0 : amt, voucher: `receivable.payment:${p.id}`, status: p.reversedAt ? 'reversed' : 'posted', createdBy: p.createdById ? nameOf.get(p.createdById) ?? null : null })
    if (p.reversedAt) rows.push({ at: p.reversedAt, type: 'statement_payment_reversed', reference: `${p.invoice.number} payment reversed${p.reversedReason ? ` — ${p.reversedReason}` : ''}`, orderRef: null, debitCents: isRefund ? 0 : amt, creditCents: isRefund ? Math.abs(amt) : 0, voucher: null, status: 'posted', createdBy: null })
  }
  for (const w of writeOffs) {
    const net = toCents(w.amountCents) - toCents(w.recoveredCents)
    rows.push({ at: w.decidedAt ?? w.requestedAt, type: 'write_off', reference: `${invoiceNo.get(w.invoiceId) ?? ''} written off — ${w.reason}`, orderRef: null, debitCents: 0, creditCents: net, voucher: `receivable.write_off:${w.id}`, status: 'posted', createdBy: null })
  }
  rows.sort((a, b) => a.at.getTime() - b.at.getTime())
  let bal = 0
  return rows.map((r) => { bal += r.debitCents - r.creditCents; return { ...r, balanceCents: bal } })
}

export { balanceOf }
