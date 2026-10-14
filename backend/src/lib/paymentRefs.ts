// Payment references used before (owner, 2026-10-14: "warn, don't block").
//
// Every back-office screen that records money coming in asks for a payment
// reference # (lib/bankAccounts.ts assertPaymentReference). The same
// reference showing up again is often legitimate — one bank transfer can pay
// several invoices — so servd never refuses it; the write still goes through
// and its response carries `referenceUsedBefore`, which the admin shows as a
// notice ("also used on …"). Raast references stay unique per company
// (RaastReceipt @@unique([tenantId, bankRef])) — that is a different rule.
//
// Scope: the SOURCE DOCUMENT's company only (`tenantId`) — never another
// company's rows, so a warning never leaks a foreign company's payment.

import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'

type Db = Prisma.TransactionClient | typeof prisma

export type PaymentRefKind =
  | 'gift_card'
  | 'wallet_topup'
  | 'receivable_payment'
  | 'capex_deposit_return'
  | 'intercompany_transfer'
  | 'deposit_drop'
  | 'asset_disposal'

export interface PaymentRefUse {
  kind: PaymentRefKind
  id: string
  /** Plain words for the notice, e.g. "Gift card GC-1A2B (14 Oct 2026)". */
  label: string
  at: string
}

const KIND_WORDS: Record<PaymentRefKind, string> = {
  gift_card: 'Gift card sale',
  wallet_topup: 'Wallet top-up',
  receivable_payment: 'Invoice payment',
  capex_deposit_return: 'Deposit returned',
  intercompany_transfer: 'Inter-company transfer',
  deposit_drop: 'Bank deposit drop',
  asset_disposal: 'Asset sale',
}

function day(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Karachi' })
}

/**
 * Where else this company already recorded `reference` (case-insensitive,
 * trimmed), newest first, at most `limit` (default 5). `exclude` drops the
 * row being written. Never throws on a missing table/column — a lookup that
 * fails returns [] (a warning must never block a receipt).
 */
export async function findPaymentReferenceUses(
  db: Db,
  tenantId: string,
  reference: string | null | undefined,
  opts: { exclude?: { kind: PaymentRefKind; id: string }; limit?: number } = {},
): Promise<PaymentRefUse[]> {
  const ref = (reference ?? '').trim()
  if (!ref || !tenantId) return []
  const limit = opts.limit ?? 5
  const eq = { equals: ref, mode: 'insensitive' as const }
  const uses: PaymentRefUse[] = []
  const push = (kind: PaymentRefKind, id: string, what: string, at: Date) => {
    if (opts.exclude && opts.exclude.kind === kind && opts.exclude.id === id) return
    uses.push({ kind, id, label: `${KIND_WORDS[kind]}${what ? ` ${what}` : ''} (${day(at)})`, at: at.toISOString() })
  }
  try {
    const [cards, wallet, receipts, deposits, transfers, drops, disposals] = await Promise.all([
      db.giftCard.findMany({ where: { tenantId, paymentRef: eq }, select: { id: true, code: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: limit }),
      db.walletTransaction.findMany({ where: { tenantId, paymentRef: eq }, select: { id: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: limit }),
      // Money received only: not withholding certificates ('wht' / 'st_withheld')
      // and not refunds (negative amounts) — those carry their own numbers.
      db.receivablePayment.findMany({
        where: { tenantId, reference: eq, method: { notIn: ['wht', 'st_withheld'] }, amountCents: { gt: 0 } },
        select: { id: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: limit,
      }),
      db.capexPayment.findMany({ where: { line: { project: { tenantId } }, depositReturnRef: eq }, select: { id: true, depositReturnedAt: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: limit }),
      db.intercompanyTransfer.findMany({
        where: { bankReference: eq, OR: [{ tenantId }, { counterpartyTenantId: tenantId }] },
        select: { id: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: limit,
      }),
      db.depositDrop.findMany({ where: { tenantId, slipNumber: eq }, select: { id: true, droppedAt: true }, orderBy: { droppedAt: 'desc' }, take: limit }),
      db.fixedAssetEvent.findMany({
        where: { tenantId, kind: 'disposal', status: { in: ['pending', 'posted'] }, payload: { path: ['reference'], equals: ref } },
        select: { id: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: limit,
      }),
    ])
    // Only the last 4 of a card code (finance never sees whole codes).
    for (const c of cards) push('gift_card', c.id, c.code ? `••••${c.code.slice(-4)}` : '', c.createdAt)
    for (const w of wallet) push('wallet_topup', w.id, '', w.createdAt)
    for (const r of receipts) push('receivable_payment', r.id, '', r.createdAt)
    for (const d of deposits) push('capex_deposit_return', d.id, '', d.depositReturnedAt ?? d.createdAt)
    for (const t of transfers) push('intercompany_transfer', t.id, '', t.createdAt)
    for (const d of drops) push('deposit_drop', d.id, '', d.droppedAt)
    for (const e of disposals) push('asset_disposal', e.id, '', e.createdAt)
  } catch (err) {
    console.warn('[paymentRefs] reference lookup failed:', (err as Error).message)
    return []
  }
  return uses.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}
