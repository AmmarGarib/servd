// POS shift close → journal posting.
//
// Per-order JE posting is skipped for `source = pos` (orders/service.ts) — POS
// sales close out at shift end via the Z-report. One journal entry per shift,
// keyed on shiftId for idempotency.
//
// The drawer side uses the ONE expected-cash formula (lib/drawer.ts), the same
// figure the cashier counted against. Every movement of cash in or out of the
// drawer that is not a sale gets its own balanced pair, so the 8010 line is
// the true over/short only:
//
//   drop            Dr 1010 Cash on hand      / Cr 1015 Drawer
//   add, pay-in     Dr 1015 Drawer            / Cr 1010 Cash on hand
//   cash refund     Dr 7040 Refunds issued    / Cr 1015 Drawer
//   pay-out         Dr 8010 (unclassified)    / Cr 1015 Drawer
//   over / short    Dr/Cr 8010                / Cr/Dr 1015
//
// Before this, a drop, a pay-out or a cash refund was simply cash missing
// from the count, so it was booked as a cash-variance LOSS: a PKR 20,000 drop
// to the safe put a fake PKR 20,000 expense on the P&L.
//
// Interim lines, until their own postings exist (see the owner questions on
// the refund and pay-out duplicates):
//   • cash refunds are booked here, gross, to 7040 — without the GST share.
//     A refund payment that already has its own journal entry (reference
//     `<type>:<paymentId>`) is skipped, so a refund-time posting added later
//     cannot double-book it.
//   • pay-outs keep today's account (8010) on their own line, memo'd for the
//     accountant to reclassify; a pay-out with its own entry is skipped too.

import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry, revenueCodeForConcept, type JournalLineInput } from './journal.js'
import { drawerExpectationOf } from '../../lib/drawer.js'
import { SHIFT_COMPANY_INCLUDE, shiftTenantId } from '../../lib/tenantScope.js'

interface ConceptBucket {
  conceptId: string
  conceptSlug: string
  grossRevenueCents: number
  taxCents: number
  discountCents: number
  walletAppliedCents: number
}

export type ShiftCloseEntry =
  | { ok: false; reason: 'shift_not_found' | 'shift_has_no_company' | 'no_postable_activity' }
  | { ok: true; tenantId: string; entryDate: Date; lines: JournalLineInput[]; debits: number; credits: number; diagnostics: string }

/**
 * The journal entry a closed shift should post, without posting it. Used by
 * postShiftClose and by the one-off backfill (scripts/backfill-shift-close-
 * postings.ts), which must report what WOULD post before posting anything.
 */
export async function buildShiftCloseEntry(shiftId: string): Promise<ShiftCloseEntry> {
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    include: {
      payments: { include: { order: { include: { concept: { select: { id: true, slug: true } } } } } },
      cashMovements: { select: { id: true, type: true, amountCents: true } },
      // Whose drawer this was: Shift.tenantId, with the location / cashier as
      // the fallback ONLY for older rows (lib/tenantScope.ts).
      ...SHIFT_COMPANY_INCLUDE,
    },
  })
  if (!shift) return { ok: false, reason: 'shift_not_found' }
  const tenantId = shiftTenantId(shift)
  if (!tenantId) return { ok: false, reason: 'shift_has_no_company' }

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

  // Expected drawer — the one formula (lib/drawer.ts). Positive variance = over.
  const drawer       = drawerExpectationOf(shift)
  const expectedCash = drawer.expectedCents
  const actualCash   = shift.closingFloatCents ?? expectedCash
  const cashVariance = actualCash - expectedCash

  // Refunds / pay-outs that already carry their own journal entry are not
  // booked again here (see the header).
  const refundRows = shift.payments.filter((p) => p.method === 'cash' && p.status === 'refunded')
  const payoutRows = shift.cashMovements.filter((m) => m.type === 'payout')
  const ownPosted = new Set<string>()
  const sourceIds = [...refundRows.map((p) => p.id), ...payoutRows.map((m) => m.id)]
  if (sourceIds.length > 0) {
    const entries = await prisma.journalEntry.findMany({
      where: { tenantId, OR: sourceIds.map((id) => ({ reference: { endsWith: `:${id}` } })) },
      select: { reference: true },
    })
    for (const e of entries) {
      const id = e.reference?.slice(e.reference.lastIndexOf(':') + 1)
      if (id) ownPosted.add(id)
    }
  }
  const cashRefundsToBook = refundRows
    .filter((p) => !ownPosted.has(p.id))
    .reduce((t, p) => t + Math.abs(p.amountCents), 0)
  const payoutsToBook = payoutRows
    .filter((m) => !ownPosted.has(m.id))
    .reduce((t, m) => t + m.amountCents, 0)

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

  // ── Drawer movements that are not sales — each a balanced pair ──────────
  const tag = `(shift ${shiftId.slice(0, 8)})`
  if (drawer.dropsCents > 0) {
    lines.push({ accountCode: ACCT.CASH_ON_HAND, type: 'debit',  amountCents: drawer.dropsCents, memo: `Cash dropped to safe ${tag}` })
    lines.push({ accountCode: ACCT.CASH_DRAWER,  type: 'credit', amountCents: drawer.dropsCents, memo: `Cash dropped to safe ${tag}` })
  }
  const cashIn = drawer.addsCents + drawer.payinsCents
  if (cashIn > 0) {
    lines.push({ accountCode: ACCT.CASH_DRAWER,  type: 'debit',  amountCents: cashIn, memo: `Cash added / paid in to drawer ${tag}` })
    lines.push({ accountCode: ACCT.CASH_ON_HAND, type: 'credit', amountCents: cashIn, memo: `Cash added / paid in to drawer ${tag}` })
  }
  if (cashRefundsToBook > 0) {
    lines.push({ accountCode: ACCT.REFUNDS,     type: 'debit',  amountCents: cashRefundsToBook, memo: `Cash refunds from drawer ${tag}` })
    lines.push({ accountCode: ACCT.CASH_DRAWER, type: 'credit', amountCents: cashRefundsToBook, memo: `Cash refunds from drawer ${tag}` })
  }
  if (payoutsToBook > 0) {
    const memo = `Drawer pay-outs, unclassified — reclassify from 8010 ${tag}`
    lines.push({ accountCode: ACCT.CASH_VARIANCE, type: 'debit',  amountCents: payoutsToBook, memo })
    lines.push({ accountCode: ACCT.CASH_DRAWER,   type: 'credit', amountCents: payoutsToBook, memo })
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
  // The drawer is debited above by cashSalesCents and moved by the pairs
  // above — what the till says should be in it. When the count is short the
  // money genuinely isn't there, so the shortfall moves off the drawer and
  // onto the variance expense; when it is over, the reverse.
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

  if (lines.length < 2) return { ok: false, reason: 'no_postable_activity' }

  const debits  = lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
  const credits = lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
  const diagnostics =
    `cash=${cashSalesCents} card=${cardSalesCents} comps=${compCents} variance=${cashVariance} ` +
    `drops=${drawer.dropsCents} in=${cashIn} refunds=${cashRefundsToBook} payouts=${payoutsToBook} ` +
    `tax=${totalTax} revenue=${totalGrossRevenue} discounts=${totalDiscount} wallet=${totalWalletApplied}`
  return { ok: true, tenantId, entryDate: shift.closedAt ?? new Date(), lines, debits, credits, diagnostics }
}

export async function postShiftClose(shiftId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const entry = await buildShiftCloseEntry(shiftId)
  if (!entry.ok) return { posted: false, entryId: null, reason: entry.reason }

  // Fail loudly rather than silently. postJournalEntry rejects an unbalanced
  // entry, and the caller logs that rejection and moves on — which is how a
  // whole shift's sales went missing without anyone noticing. Check here, where
  // the shift id and the totals are in hand, so the log says which shift and by
  // how much.
  if (entry.debits !== entry.credits) {
    console.error(
      `[shiftPosting] shift ${shiftId} would post an UNBALANCED entry: debits ${entry.debits} vs credits ${entry.credits} ` +
      `(difference ${entry.debits - entry.credits}). Refusing to post — this shift's sales are NOT in the ledger. ` +
      entry.diagnostics,
    )
    return { posted: false, entryId: null, reason: 'unbalanced' }
  }

  const result = await postJournalEntry({
    tenantId: entry.tenantId,
    sourceType: 'shift.close',
    sourceId: shiftId,
    description: `POS shift ${shiftId.slice(0, 8)} closeout`,
    entryDate: entry.entryDate,
    postedBy: 'system',
    lines: entry.lines,
  })
  return { posted: result.posted, entryId: result.entryId }
}
