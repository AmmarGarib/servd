// The customer wallet — per company (ONL-R2-01).
//
// A wallet is a customer's stored value AT ONE COMPANY (CustomerWallet, keyed
// (tenantId, customerId)). It used to be one servd-wide number
// (Customer.walletBalance — retired, never read), so value company A granted
// paid an order at company B's brand: B's 2050 Wallet Liability went to a
// debit balance for money it never received, and A's top-up never reached
// A's books at all. CLAUDE.md: customer-facing money stays inside the company
// that issued it.
//
// This file is the ONE place a wallet balance moves:
//   - topUpWallet:     credit the TOP-UP's company and post it there in the
//                      same transaction — Dr 6065 Goodwill Credit to
//                      Customers (a manager's goodwill credit; 6060 before
//                      2026-10-26) or Dr the account the money
//                      went into (a paid top-up: 1010 cash / the
//                      company's bank account it was received into —
//                      lib/bankAccounts.ts moneyAccountCode) / Cr 2050. Never
//                      a top-up without its entry. A paid top-up is a
//                      back-office receipt (owner, 2026-10-14): cash,
//                      bank transfer, bank deposit or cheque (RECEIPT_METHODS)
//                      with its payment reference # — required on every
//                      method, stored on the WalletTransaction (method +
//                      paymentRef) and written into the entry's description
//                      and the money line's memo. Goodwill takes none.
//   - holdWalletForCheckout / attachHoldToOrder / releaseWalletHold: a wallet
//                      that IS the payment method is taken before the order
//                      is written (storefront ONLINE-R5), from the wallet of
//                      the BRAND's company only.
//   - spendWalletOnOrder: the "use my wallet" toggle, taken after the order
//                      exists, from the ORDER's company's wallet.
//   - restoreOrderWallet: a cancelled / refunded order's wallet share goes
//                      back to the ORDER's company's wallet, once.
// The spend itself is booked by the order's completion posting (Dr 2050 in
// the order's company, orderPosting.ts) — the same company whose wallet paid.
//
// Locking: every debit takes SELECT … FOR UPDATE on the wallet row; when an
// order is involved the ORDER row is locked first (the lock order every till
// tender, gift-card redeem and loyalty claim uses: order row, then the
// stored-value row).

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { ACCT, postJournalEntry } from '../accounting/journal.js'
import { moneyAccountCode, RECEIPT_METHODS, assertPaymentReference, assertReceiptMethod, receiptText, type ReceiptMethod } from '../../lib/bankAccounts.js'

type Tx = Prisma.TransactionClient

/**
 * Goodwill Credit to Customers — where a manager's goodwill wallet credit is
 * expensed (owner C6, 2026-10-26: "Give wallet goodwill credit its own account
 * so I can see what we give away"). Credits booked before that sit on 6060
 * Marketing & Promo and stay there: anything that undoes a goodwill credit
 * mirrors the lines of ITS OWN entry (reverseJournalEntry), never this constant.
 */
export const WALLET_GOODWILL_EXPENSE = '6065'

/**
 * How the customer paid for a PAID top-up — the one back-office receipt list
 * (lib/bankAccounts.ts RECEIPT_METHODS). The debit side is the account the
 * money went into (moneyAccountCode): cash → 1010 (no card since
 * 2026-10-16 — the till's only), bank transfer / bank deposit / cheque → the wallet company's
 * bank account it was received into (the named one; else the company's only
 * bank; 1020 with none; 422 BANK_ACCOUNT_REQUIRED when it has two or more
 * and none is named). The route still reads the old 'bank' as bank_transfer.
 */
export const TOPUP_TENDERS = RECEIPT_METHODS
export type TopUpTender = ReceiptMethod

/** The balance of the customer's wallet at one company (0 when none). */
export async function walletBalanceAt(tenantId: string | null | undefined, customerId: string, db: Tx | typeof prisma = prisma): Promise<number> {
  if (!tenantId) return 0
  const w = await db.customerWallet.findUnique({
    where: { tenantId_customerId: { tenantId, customerId } },
    select: { balanceCents: true },
  })
  return Math.max(0, w?.balanceCents ?? 0)
}

/** Every company's wallet of the customer: tenantId → balance. */
export async function walletBalancesOf(customerIds: string[], tenantIds?: string[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>()
  if (customerIds.length === 0 || (tenantIds && tenantIds.length === 0)) return out
  const rows = await prisma.customerWallet.findMany({
    where: { customerId: { in: customerIds }, ...(tenantIds && { tenantId: { in: tenantIds } }) },
    select: { customerId: true, tenantId: true, balanceCents: true },
  })
  for (const r of rows) {
    const m = out.get(r.customerId) ?? new Map<string, number>()
    m.set(r.tenantId, r.balanceCents)
    out.set(r.customerId, m)
  }
  return out
}

/**
 * The balance in view: the company's wallet, or — in a portfolio view — the
 * wallets of the companies in view summed (each still spendable only at its
 * own company's brands; `wallets` lists them apart).
 */
export function balanceInView(wallets: Map<string, number> | undefined, scope: string[]): number {
  if (!wallets) return 0
  return scope.reduce((t, id) => t + (wallets.get(id) ?? 0), 0)
}

async function lockOrderRowTx(tx: Tx, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`
}

/** The wallet row, created empty when missing, locked FOR UPDATE. */
async function lockWalletForCreditTx(tx: Tx, tenantId: string, customerId: string): Promise<{ id: string; balanceCents: number }> {
  await tx.$executeRaw`
    INSERT INTO customer_wallets ("id", "tenantId", "customerId", "balanceCents", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${tenantId}, ${customerId}, 0, now(), now())
    ON CONFLICT ("tenantId", "customerId") DO NOTHING`
  const rows = await tx.$queryRaw<Array<{ id: string; balanceCents: number }>>`
    SELECT id, "balanceCents" FROM customer_wallets
     WHERE "tenantId" = ${tenantId} AND "customerId" = ${customerId}
     FOR UPDATE`
  return rows[0]!
}

/** The wallet row locked FOR UPDATE, or null when the customer has none here. */
async function lockWalletForDebitTx(tx: Tx, tenantId: string, customerId: string): Promise<{ id: string; balanceCents: number } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; balanceCents: number }>>`
    SELECT id, "balanceCents" FROM customer_wallets
     WHERE "tenantId" = ${tenantId} AND "customerId" = ${customerId}
     FOR UPDATE`
  return rows[0] ?? null
}

interface MoveInput {
  tenantId: string
  customerId: string
  amountCents: number
  type: 'topup' | 'spend' | 'refund' | 'bonus'
  description: string
  orderId?: string | null
  /** A paid top-up received into a company bank account (same company). */
  bankAccountId?: string | null
  /** A paid top-up: how it was paid (RECEIPT_METHODS) and its payment reference #. */
  method?: string | null
  paymentRef?: string | null
}

/** Credit inside `tx` (wallet row locked). Returns the WalletTransaction and the balance after. */
export async function creditWalletTx(tx: Tx, input: MoveInput): Promise<{ transactionId: string; balanceAfter: number }> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new AppError('INVALID_AMOUNT', 'A wallet credit must be a positive whole amount', 400)
  }
  const w = await lockWalletForCreditTx(tx, input.tenantId, input.customerId)
  const updated = await tx.customerWallet.update({
    where: { id: w.id },
    data: { balanceCents: { increment: input.amountCents } },
    select: { balanceCents: true },
  })
  const wt = await tx.walletTransaction.create({
    data: {
      tenantId: input.tenantId,
      customerId: input.customerId,
      type: input.type,
      amountCents: input.amountCents,
      balanceAfter: updated.balanceCents,
      description: input.description,
      orderId: input.orderId ?? null,
      bankAccountId: input.bankAccountId ?? null,
      method: input.method ?? null,
      paymentRef: input.paymentRef ?? null,
    },
    select: { id: true },
  })
  return { transactionId: wt.id, balanceAfter: updated.balanceCents }
}

/** Debit inside `tx` (wallet row locked). null when the balance does not cover it — nothing moved. */
export async function debitWalletTx(tx: Tx, input: MoveInput): Promise<{ transactionId: string; balanceAfter: number } | null> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) return null
  const w = await lockWalletForDebitTx(tx, input.tenantId, input.customerId)
  if (!w || w.balanceCents < input.amountCents) return null
  const updated = await tx.customerWallet.update({
    where: { id: w.id },
    data: { balanceCents: { decrement: input.amountCents } },
    select: { balanceCents: true },
  })
  const wt = await tx.walletTransaction.create({
    data: {
      tenantId: input.tenantId,
      customerId: input.customerId,
      type: input.type,
      amountCents: -input.amountCents,
      balanceAfter: updated.balanceCents,
      description: input.description,
      orderId: input.orderId ?? null,
    },
    select: { id: true },
  })
  return { transactionId: wt.id, balanceAfter: updated.balanceCents }
}

// ─── Top-ups ────────────────────────────────────────────────────────────────

export interface TopUpInput {
  tenantId: string
  customerId: string
  amountCents: number
  /** goodwill = a manager's credit (Dr 6065); paid = the customer paid for it (Dr the tender). */
  kind: 'goodwill' | 'paid'
  tender?: TopUpTender
  /** A bank-type tender: the bank account of `tenantId` it was received into. */
  bankAccountId?: string | null
  /** A paid top-up's payment reference # (required, every tender); refused on goodwill. */
  paymentRef?: string | null
  description: string
  postedBy: string
}

/**
 * Credit the customer's wallet AT `tenantId` and book it in that company in
 * the SAME transaction: Dr 6065 (goodwill) or the account the money went
 * into (paid — moneyAccountCode, a bank of THAT company only) / Cr 2050. A
 * posting that cannot be made (period locked, chart missing a code, a bank of
 * another company) rolls the credit back — a wallet never holds value its
 * company's books do not owe.
 */
export async function topUpWallet(input: TopUpInput): Promise<{ transactionId: string; balanceAfter: number; entryId: string | null }> {
  if (input.kind === 'paid' && !input.tender) {
    throw new AppError('TENDER_REQUIRED', 'Say how the customer paid for the top-up (cash, bank transfer, bank deposit or cheque)', 422)
  }
  // Back-office receipts take no card (owner, 2026-10-16) — 422 CARD_NOT_A_RECEIPT.
  if (input.kind === 'paid') assertReceiptMethod(input.tender)
  if (input.kind === 'goodwill' && input.bankAccountId) {
    throw new AppError('BANK_ACCOUNT_ON_GOODWILL', 'A goodwill credit is our own cost — no money came in, so it has no bank account', 422)
  }
  if (input.kind === 'goodwill' && input.paymentRef?.trim()) {
    throw new AppError('REFERENCE_ON_GOODWILL', 'A goodwill credit is our own cost — no money came in, so it has no payment reference', 422)
  }
  // Every paid top-up carries its payment reference # (owner, 2026-10-14).
  const paymentRef = input.kind === 'paid' ? assertPaymentReference(input.tender, input.paymentRef) : null
  return prisma.$transaction(async (tx) => {
    const money = input.kind === 'goodwill'
      ? { code: WALLET_GOODWILL_EXPENSE, bankAccountId: null }
      : await moneyAccountCode(tx, input.tenantId, { method: input.tender!, bankAccountId: input.bankAccountId })
    const moved = await creditWalletTx(tx, {
      tenantId: input.tenantId,
      customerId: input.customerId,
      amountCents: input.amountCents,
      type: 'topup',
      description: input.description,
      bankAccountId: money.bankAccountId,
      method: input.kind === 'paid' ? input.tender! : null,
      paymentRef,
    })
    const debitAccount = money.code
    // "paid — bank deposit, ref 4471": the reference reaches the books in the
    // description and the memo (the entry's `reference` stays the dedupe key).
    const memo = `Wallet top-up (${input.kind === 'goodwill' ? 'goodwill' : `paid — ${receiptText(input.tender, paymentRef)}`}) #${moved.transactionId.slice(0, 8)}`
    const je = await postJournalEntry({
      tenantId: input.tenantId,
      sourceType: 'wallet.topup',
      sourceId: moved.transactionId,
      description: `${memo}: ${input.description}`.slice(0, 500),
      postedBy: input.postedBy,
      lines: [
        { accountCode: debitAccount, type: 'debit', amountCents: input.amountCents, memo },
        { accountCode: ACCT.WALLET_LIABILITY, type: 'credit', amountCents: input.amountCents, memo },
      ],
    }, { tx })
    return { ...moved, entryId: je.entryId }
  })
}

// ─── Checkout: the wallet as the payment method ─────────────────────────────

/**
 * Take `amountCents` from the customer's wallet at the brand's company BEFORE
 * the order is written. The spend row is written now (no order yet) and tied
 * to the order by attachHoldToOrder; if the order is never written,
 * releaseWalletHold gives it back. null when the balance does not cover it.
 */
export async function holdWalletForCheckout(args: { tenantId: string; customerId: string; amountCents: number }): Promise<{ transactionId: string } | null> {
  return prisma.$transaction(async (tx) => {
    const moved = await debitWalletTx(tx, { ...args, type: 'spend', description: 'Checkout (order being placed)' })
    return moved ? { transactionId: moved.transactionId } : null
  })
}

/** The held spend now belongs to `orderId`. */
export async function attachHoldToOrder(transactionId: string, orderId: string): Promise<void> {
  await prisma.walletTransaction.update({
    where: { id: transactionId },
    data: { orderId, description: `Order ${orderId}` },
  })
}

/**
 * Give back a hold whose order was never written. Idempotent: the hold's
 * spend row is deleted in the same transaction as the credit, so a second
 * call finds nothing to give back.
 */
export async function releaseWalletHold(hold: { tenantId: string; customerId: string; amountCents: number; transactionId: string }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const w = await lockWalletForCreditTx(tx, hold.tenantId, hold.customerId)
    const gone = await tx.walletTransaction.deleteMany({ where: { id: hold.transactionId, orderId: null, type: 'spend' } })
    if (gone.count === 0) return
    await tx.customerWallet.update({ where: { id: w.id }, data: { balanceCents: { increment: hold.amountCents } } })
  })
}

// ─── Checkout: the "use my wallet" toggle ───────────────────────────────────

/**
 * Take the wallet share of an order that already exists (its bill already
 * excludes it), from the wallet of the ORDER's company. Order row locked
 * first, then the wallet row. false when the balance moved and nothing was
 * taken — the caller puts the share back on the bill.
 */
export async function spendWalletOnOrder(args: { customerId: string; orderId: string; amountCents: number }): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockOrderRowTx(tx, args.orderId)
    const order = await tx.order.findUnique({ where: { id: args.orderId }, select: { concept: { select: { tenantId: true } } } })
    const tenantId = order?.concept.tenantId
    if (!tenantId) return false
    const moved = await debitWalletTx(tx, {
      tenantId,
      customerId: args.customerId,
      amountCents: args.amountCents,
      type: 'spend',
      description: `Order ${args.orderId}`,
      orderId: args.orderId,
    })
    return !!moved
  })
}

// ─── Restores ───────────────────────────────────────────────────────────────

/**
 * Give an order's wallet share back to the wallet of the ORDER's company —
 * once per order (a 'refund' WalletTransaction on the order is the claim,
 * checked under the order's row lock, so two concurrent restores credit
 * once). Returns the balance after, or null when nothing was restored.
 *
 * `book` (a refunded order: its sale debited 2050 for the share) runs in the
 * SAME transaction as the credit and posts its Cr 2050 entry with that `tx`
 * — the wallet is never credited without its entry, nor the entry posted
 * without the credit (W-RV-02). A failed posting rolls the credit back and
 * throws, so the caller flags it and a re-run restores and books together.
 * When the restore was already made (a run before this change whose entry
 * failed), `book` still runs — its posting is idempotent on the order — so
 * the missing entry can catch up.
 */
export async function restoreOrderWallet(
  orderId: string,
  reason: string,
  opts: { book?: (tx: Tx, amountCents: number) => Promise<void> } = {},
): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    await lockOrderRowTx(tx, orderId)
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { customerId: true, walletAmountCents: true, concept: { select: { tenantId: true } } },
    })
    if (!order?.customerId || order.walletAmountCents <= 0) return null
    const tenantId = order.concept.tenantId
    if (!tenantId) {
      throw new AppError('ORDER_HAS_NO_COMPANY', `Order ${orderId}'s brand has no company — its wallet share cannot be restored`, 500)
    }
    const already = await tx.walletTransaction.findFirst({ where: { orderId, type: 'refund' }, select: { id: true } })
    if (already) {
      if (opts.book) await opts.book(tx, order.walletAmountCents)
      return null
    }
    const moved = await creditWalletTx(tx, {
      tenantId,
      customerId: order.customerId,
      amountCents: order.walletAmountCents,
      type: 'refund',
      description: `Refund of order — ${reason}`,
      orderId,
    })
    if (opts.book) await opts.book(tx, order.walletAmountCents)
    return moved.balanceAfter
  })
}
