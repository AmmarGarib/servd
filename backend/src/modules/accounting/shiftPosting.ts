// POS shift close → journal posting.
//
// Per-order JE posting is skipped for `source = pos` (orders/service.ts) — POS
// sales close out at shift end via the Z-report. One journal entry per shift,
// keyed on shiftId for idempotency.

import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry, revenueCodeForConcept, type JournalLineInput } from './journal.js'

interface ConceptBucket {
  conceptId: string
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
      payments: { include: { order: { include: { concept: { select: { id: true, slug: true } } } } } },
      // Whose drawer this was: stamped on the shift since 20260907140000, with
      // the location / cashier as the fallback for older rows.
      location: { select: { tenantId: true } },
      user:     { select: { tenantId: true } },
    },
  })
  if (!shift) return { posted: false, entryId: null, reason: 'shift_not_found' }
  const tenantId = shift.tenantId ?? shift.location?.tenantId ?? shift.user.tenantId
  if (!tenantId) return { posted: false, entryId: null, reason: 'shift_has_no_company' }

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
      conceptId: order.concept.id,
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
      lines.push({ accountCode: ACCT.WALLET_LIABILITY, type: 'debit', amountCents: b.walletAppliedCents, memo: `Wallet applied @ ${b.conceptSlug}`, conceptId: b.conceptId })
      totalWalletApplied += b.walletAppliedCents
    }
    if (b.discountCents > 0) {
      lines.push({ accountCode: ACCT.DISCOUNTS, type: 'debit', amountCents: b.discountCents, memo: `Discounts @ ${b.conceptSlug}`, conceptId: b.conceptId })
      totalDiscount += b.discountCents
    }
    totalTax          += b.taxCents
    totalGrossRevenue += b.grossRevenueCents
  }

  // Cash variance, as a BALANCED pair against the drawer.
  //
  // This used to push a single one-sided line to CASH_VARIANCE with nothing on
  // the other side, so the entry was out of balance by exactly the variance.
  // postJournalEntry rejects an unbalanced entry, and the caller in
  // pos/service.ts logs that rejection and carries on — so any shift whose
  // drawer did not reconcile to the cent produced NO journal entry at all.
  // Not the variance line: the whole shift. Every sale in it went missing from
  // the trial balance, the P&L, cash flow and the sales-tax return, while the
  // Z-report still showed the money. Drawers are rarely exact, so this was the
  // normal case, not the edge case.
  //
  // The drawer is debited above by cashSalesCents — what the sales say should
  // be in it. When the count is short the money genuinely isn't there, so the
  // shortfall moves off the drawer and onto the variance expense; when it is
  // over, the reverse.
  if (cashVariance !== 0) {
    const short = cashVariance < 0
    const amountCents = Math.abs(cashVariance)
    const memo = `Drawer ${short ? 'short' : 'over'} (shift ${shiftId.slice(0, 8)})`
    lines.push({ accountCode: short ? ACCT.CASH_VARIANCE : ACCT.CASH_DRAWER,   type: 'debit',  amountCents, memo })
    lines.push({ accountCode: short ? ACCT.CASH_DRAWER   : ACCT.CASH_VARIANCE, type: 'credit', amountCents, memo })
  }

  // ── Credits: revenue per concept + GST output ──────────────────────────
  for (const b of byConcept.values()) {
    if (b.grossRevenueCents > 0) {
      lines.push({
        accountCode: revenueCodeForConcept(b.conceptSlug),
        type: 'credit',
        amountCents: b.grossRevenueCents,
        memo: `Revenue @ ${b.conceptSlug}`,
        conceptId: b.conceptId,
      })
    }
  }
  if (totalTax > 0) {
    lines.push({ accountCode: ACCT.GST_OUTPUT, type: 'credit', amountCents: totalTax, memo: `GST output (shift ${shiftId.slice(0, 8)})` })
  }

  if (lines.length < 2) {
    return { posted: false, entryId: null, reason: 'no_postable_activity' }
  }

  // Fail loudly rather than silently. postJournalEntry rejects an unbalanced
  // entry, and the caller logs that rejection and moves on — which is how a
  // whole shift's sales went missing without anyone noticing. Check here, where
  // the shift id and the totals are in hand, so the log says which shift and by
  // how much.
  const debits  = lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
  const credits = lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
  if (debits !== credits) {
    console.error(
      `[shiftPosting] shift ${shiftId} would post an UNBALANCED entry: debits ${debits} vs credits ${credits} ` +
      `(difference ${debits - credits}). Refusing to post — this shift's sales are NOT in the ledger. ` +
      `cash=${cashSalesCents} card=${cardSalesCents} comps=${compCents} variance=${cashVariance} ` +
      `tax=${totalTax} revenue=${totalGrossRevenue} discounts=${totalDiscount} wallet=${totalWalletApplied}`,
    )
    return { posted: false, entryId: null, reason: 'unbalanced' }
  }

  const result = await postJournalEntry({
    tenantId,
    sourceType: 'shift.close',
    sourceId: shiftId,
    description: `POS shift ${shiftId.slice(0, 8)} closeout`,
    entryDate: shift.closedAt ?? new Date(),
    postedBy: 'system',
    lines,
  })
  return { posted: result.posted, entryId: result.entryId }
}
