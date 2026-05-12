// POS shift close → journal posting.
//
// Per-order JE posting is skipped for `source = pos` (orders/service.ts) — POS
// sales close out at shift end via the Z-report. One journal entry per shift,
// keyed on shiftId for idempotency.

import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry, revenueCodeForConcept, type JournalLineInput } from './journal.js'

interface ConceptBucket {
  conceptSlug: string
  grossRevenueCents: number
  taxCents: number
  discountCents: number
  walletAppliedCents: number
}

export async function postShiftClose(shiftId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    include: {
      payments: { include: { order: { include: { concept: { select: { slug: true } } } } } },
    },
  })
  if (!shift) return { posted: false, entryId: null, reason: 'shift_not_found' }

  // Bucket revenue per concept and totals across all payment methods
  const byConcept = new Map<string, ConceptBucket>()
  let cashSalesCents = 0
  let cardSalesCents = 0
  let walletGatewayCents = 0  // JazzCash/Easypaisa wallets (external — not our customer wallet liability)
  let compCents = 0
  const seenOrders = new Set<string>()

  for (const p of shift.payments) {
    if (p.status !== 'paid') continue

    if (p.method === 'cash') cashSalesCents += p.amountCents
    else if (p.method === 'card' || p.method === 'keenu_qr') cardSalesCents += p.amountCents
    // F-PAY02: wallet methods removed in v1 — `walletGatewayCents` stays at 0
    // until JazzCash/Easypaisa adapters are reintroduced.
    else if (p.method === 'comp') compCents += p.amountCents

    const order = p.order
    if (!order || seenOrders.has(order.id)) continue
    seenOrders.add(order.id)

    const slug = order.concept.slug
    const grossSubtotal =
      order.totalCents +
      order.walletAmountCents -
      order.taxCents +
      order.discountCents +
      order.promoDiscountCents

    const bucket = byConcept.get(slug) ?? {
      conceptSlug: slug,
      grossRevenueCents: 0,
      taxCents: 0,
      discountCents: 0,
      walletAppliedCents: 0,
    }
    bucket.grossRevenueCents  += grossSubtotal
    bucket.taxCents           += order.taxCents
    bucket.discountCents      += order.discountCents + order.promoDiscountCents
    bucket.walletAppliedCents += order.walletAmountCents
    byConcept.set(slug, bucket)
  }

  // Cash variance: closing float − (opening float + cash sales). Positive = over.
  const expectedCash = shift.openingFloatCents + cashSalesCents
  const actualCash   = shift.closingFloatCents ?? expectedCash
  const cashVariance = actualCash - expectedCash

  const lines: JournalLineInput[] = []

  // ── Debits: payment receipts and contra-revenue ────────────────────────
  if (cashSalesCents > 0) {
    lines.push({ accountCode: ACCT.CASH_DRAWER, type: 'debit', amountCents: cashSalesCents, memo: `POS cash sales (shift ${shiftId.slice(0, 8)})` })
  }
  if (cardSalesCents > 0) {
    lines.push({ accountCode: ACCT.CARD_RECEIVABLE, type: 'debit', amountCents: cardSalesCents, memo: `POS card sales (shift ${shiftId.slice(0, 8)})` })
  }
  if (walletGatewayCents > 0) {
    // External gateway wallets settle to bank like card; net them through card receivable.
    lines.push({ accountCode: ACCT.CARD_RECEIVABLE, type: 'debit', amountCents: walletGatewayCents, memo: `POS gateway-wallet sales (shift ${shiftId.slice(0, 8)})` })
  }
  if (compCents > 0) {
    lines.push({ accountCode: ACCT.COMPS, type: 'debit', amountCents: compCents, memo: `POS comps (shift ${shiftId.slice(0, 8)})` })
  }

  let totalWalletApplied = 0
  let totalDiscount = 0
  let totalTax = 0
  let totalGrossRevenue = 0
  for (const b of byConcept.values()) {
    if (b.walletAppliedCents > 0) {
      lines.push({ accountCode: ACCT.WALLET_LIABILITY, type: 'debit', amountCents: b.walletAppliedCents, memo: `Wallet applied @ ${b.conceptSlug}` })
      totalWalletApplied += b.walletAppliedCents
    }
    if (b.discountCents > 0) {
      lines.push({ accountCode: ACCT.DISCOUNTS, type: 'debit', amountCents: b.discountCents, memo: `Discounts @ ${b.conceptSlug}` })
      totalDiscount += b.discountCents
    }
    totalTax          += b.taxCents
    totalGrossRevenue += b.grossRevenueCents
  }

  // Cash variance: short ⇒ debit expense; over ⇒ credit (negative expense)
  if (cashVariance !== 0) {
    lines.push({
      accountCode: ACCT.CASH_VARIANCE,
      type: cashVariance < 0 ? 'debit' : 'credit',
      amountCents: Math.abs(cashVariance),
      memo: `Drawer ${cashVariance < 0 ? 'short' : 'over'} (shift ${shiftId.slice(0, 8)})`,
    })
  }

  // ── Credits: revenue per concept + GST output ──────────────────────────
  for (const b of byConcept.values()) {
    if (b.grossRevenueCents > 0) {
      lines.push({
        accountCode: revenueCodeForConcept(b.conceptSlug),
        type: 'credit',
        amountCents: b.grossRevenueCents,
        memo: `Revenue @ ${b.conceptSlug}`,
      })
    }
  }
  if (totalTax > 0) {
    lines.push({ accountCode: ACCT.GST_OUTPUT, type: 'credit', amountCents: totalTax, memo: `GST output (shift ${shiftId.slice(0, 8)})` })
  }

  if (lines.length < 2) {
    return { posted: false, entryId: null, reason: 'no_postable_activity' }
  }

  const result = await postJournalEntry({
    sourceType: 'shift.close',
    sourceId: shiftId,
    description: `POS shift ${shiftId.slice(0, 8)} closeout`,
    entryDate: shift.closedAt ?? new Date(),
    postedBy: 'system',
    lines,
  })
  return { posted: result.posted, entryId: result.entryId }
}
