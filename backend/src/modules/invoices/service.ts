// Tax invoice generation.
//
// Every invoice belongs to ONE company (TaxInvoice.tenantId — the order's
// brand's company; a credit note carries its original's). Numbers are unique
// per company and numbered per series: (company, prefix, year, invoice or
// credit note). Two companies may use the same prefix — each starts at 1 —
// and two brands of one company sharing a prefix share one series.
//
// Numbering scheme: <prefix>-<YYYY>-<00000> for invoices and
// <prefix>-<YYYY>-CN-<00000> for credit notes, where prefix is
// Concept.invoicePrefix (else the slug, upper-cased) and YYYY is the Karachi
// calendar year of issue.
//
// Allocation is race-safe, gap-free and O(1): each series has one row in
// tax_invoice_series holding the last number issued, bumped by a single
// INSERT … ON CONFLICT DO UPDATE … RETURNING inside the issuing transaction.
// The row lock serialises two issues in one series; a rolled-back issue
// rolls its number back. (Review D-RV-3: the MAX() over every invoice the
// company ever issued, run under the lock on every completed order, slowed
// numbering down as history grew.) The issuing transaction also takes a
// transaction-scoped advisory lock on the series first, so the "one invoice
// per order" check runs under it and two concurrent issues for one order give
// one invoice. (The per-brand invoice_counters table this replaced shared one
// counter between a brand's invoices and credit notes, restarted a new year
// at 2, and let two brands with one prefix collide.)
//
// Money (wave B, H9 + critic): a delivery order's fee is a taxable supply — it
// is in taxableValueCents and has its own 'Delivery charge' line, its GST is
// inside the stored Order.taxCents — and the invoice total equals the BILL:
//   totalCents = max(0, subtotal + deliveryFee + tax + serviceCharge + tip − discount)
// (a discount or loyalty that covered more than the food comes off the fee and
// the tax too, exactly as the bill and the fiscal payload's totals have it).
// A credit note mirrors its original line for line.
//
// Buyer (H14, on-account clients): when the caller names no buyer and the
// order was charged to an on-account client (CustomerAccountCharge), the
// invoice names the client — legal name, STRN, NTN, address — so the tax
// invoice at supply is the client's (the monthly statement is not one).

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { CREDIT_NOTE_SOURCE } from '../accounting/orderPosting.js'

const COUNTER_PAD = 5  // STX-2026-00001, plenty of room for years of activity

/** The description of a delivery order's fee line (H9) — a credit note's line mirrors it. */
export const DELIVERY_CHARGE_LINE = 'Delivery charge' as const

type Tx = Prisma.TransactionClient
type Series = { tenantId: string; prefix: string; year: number; type: 'invoice' | 'credit_note' }

/** The Karachi calendar year (PKT, UTC+5, no DST) of an instant. */
export function karachiYear(at: Date = new Date()): number {
  return new Date(at.getTime() + 5 * 3_600_000).getUTCFullYear()
}

/** A brand's invoice prefix. */
export function invoicePrefix(concept: { invoicePrefix: string | null; slug: string }): string {
  return concept.invoicePrefix?.trim() || concept.slug.toUpperCase()
}

/** The text every number of a series starts with, before its sequence. */
function seriesHead(s: Series): string {
  return s.type === 'credit_note' ? `${s.prefix}-${s.year}-CN-` : `${s.prefix}-${s.year}-`
}

/** Serialise everything that issues in one series, until the transaction ends. */
async function lockSeries(tx: Tx, s: Series): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`taxinvoice:${s.tenantId}:${s.type}:${seriesHead(s)}`}))`
}

/** Bump a series' counter and return the new last value (the series' row
 *  stays locked until the transaction ends). */
async function bumpSeries(tx: Tx, tenantId: string, head: string, atLeast = 0): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ lastValue: number }>>`
    INSERT INTO "tax_invoice_series" ("tenantId", "head", "lastValue", "updatedAt")
    VALUES (${tenantId}, ${head}, ${atLeast + 1}, NOW())
    ON CONFLICT ("tenantId", "head") DO UPDATE
       SET "lastValue" = GREATEST("tax_invoice_series"."lastValue", ${atLeast}::int) + 1,
           "updatedAt" = NOW()
    RETURNING "lastValue"
  `
  return rows[0]!.lastValue
}

/**
 * The highest sequence issued in a series, read from the invoices themselves
 * by the number's shape, whatever its type (the old per-brand counter gave
 * credit notes invoice-shaped numbers, and those numbers are taken all the
 * same; "<head>CN-…" is not digits, so the credit-note series never feeds the
 * invoice series). A scan of the company's invoices — only ever run when the
 * counter is found behind (a number issued outside it), never on the normal
 * path.
 */
async function highestIssued(tx: Tx, s: Series): Promise<number> {
  const head = seriesHead(s)
  const from = head.length + 1
  const rows = await tx.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX(CAST(SUBSTRING("invoiceNumber" FROM ${from}::int) AS INTEGER))::int AS max
      FROM "tax_invoices"
     WHERE "tenantId" = ${s.tenantId}
       AND LEFT("invoiceNumber", ${head.length}::int) = ${head}
       AND SUBSTRING("invoiceNumber" FROM ${from}::int) ~ '^[0-9]{1,9}$'
  `
  return rows[0]?.max ?? 0
}

/**
 * The next number of a series. Call with the series lock held (lockSeries).
 * O(1): one upsert on the series' counter row, plus one unique-index probe
 * that the number is free. If it is taken — an invoice numbered while the
 * counter was not kept (issued by an older release mid-deploy, or written by
 * hand) — the counter catches up with the highest number issued, once.
 */
async function nextNumber(tx: Tx, s: Series): Promise<string> {
  const head = seriesHead(s)
  const fmt = (seq: number) => `${head}${String(seq).padStart(COUNTER_PAD, '0')}`
  let seq = await bumpSeries(tx, s.tenantId, head)
  const taken = await tx.taxInvoice.findUnique({ where: { tenantId_invoiceNumber: { tenantId: s.tenantId, invoiceNumber: fmt(seq) } }, select: { id: true } })
  if (taken) seq = await bumpSeries(tx, s.tenantId, head, await highestIssued(tx, s))
  return fmt(seq)
}

/** The issuing transaction's limits: a series lock wait in a rush is
 *  expected, so wait longer than Prisma's 2 s / 5 s defaults — but bounded. */
const ISSUE_TX = { maxWait: 10_000, timeout: 20_000 } as const

export interface IssueInvoiceInput {
  orderId: string
  buyer?: {
    name?: string
    strn?: string
    ntn?: string
    address?: string
  }
}

export async function issueInvoiceForOrder(input: IssueInvoiceInput) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: {
        concept: true,
        items: { include: { modifiers: true } },
      },
    })
    if (!order)                            throw new NotFoundError('Order', input.orderId)
    if (order.deletedAt)                   throw new AppError('ORDER_DELETED', 'Cannot issue invoice for deleted order', 422)
    if (order.status !== 'completed')      throw new AppError('ORDER_NOT_COMPLETED', `Order is ${order.status}; only completed orders can be invoiced`, 422)

    // One invoice per order (fast path; re-checked under the series lock).
    const issued = await tx.taxInvoice.findFirst({ where: { orderId: order.id, type: 'invoice' }, include: { lines: true } })
    if (issued) return issued

    const concept = order.concept
    if (!concept.invoiceLegalName) {
      throw new AppError('CONCEPT_NOT_REGISTERED', `Concept ${concept.slug} is missing invoice legal name. Set strn/ntn/invoiceLegalName/invoicePrefix on the concept first.`, 422)
    }
    // The invoice is the brand's company's — the source document decides.
    if (!concept.tenantId) {
      throw new AppError('CONCEPT_NO_COMPANY', `Brand ${concept.slug} belongs to no company, so it cannot issue a tax invoice`, 422)
    }

    const series: Series = { tenantId: concept.tenantId, prefix: invoicePrefix(concept), year: karachiYear(), type: 'invoice' }
    await lockSeries(tx, series)

    // One invoice per order — checked under the series lock, so a second
    // concurrent issue for this order waits and then finds the first.
    const existing = await tx.taxInvoice.findFirst({ where: { orderId: order.id, type: 'invoice' }, include: { lines: true } })
    if (existing) return existing

    const invoiceNumber = await nextNumber(tx, series)

    // The buyer: the caller's, else an on-account client the order was charged
    // to (its own company's charge only), else the customer's name.
    let buyer = input.buyer
    if (!buyer) {
      const charge = await tx.customerAccountCharge.findFirst({
        where: { orderId: order.id, tenantId: concept.tenantId },
        select: { account: { select: { legalName: true, strn: true, ntn: true, address: true } } },
      })
      if (charge) {
        const a = charge.account
        buyer = {
          name: a.legalName,
          ...(a.strn && { strn: a.strn }),
          ...(a.ntn && { ntn: a.ntn }),
          ...(a.address && { address: a.address }),
        }
      }
    }

    // Money snapshot — the order's STORED figures, never a recomputation:
    // the GST is Order.taxCents, charged at Order.taxRatePct by
    // lib/pricing.ts priceOrder (tender rate, decision 9). We don't split
    // federal vs provincial here because that mapping is operator policy;
    // until the operator sets explicit per-province fields, all of it lands
    // in fbrTaxCents. The taxable value is the PRE-discount item value plus
    // the delivery charge (taxed at the order's rate, H9) — GST is charged on
    // it before any discount (SRB POS rule), so taxable × rate matches the
    // tax on the invoice. The total is the bill (see the header).
    const subtotal       = order.items
      .filter((i) => i.status !== 'voided')
      .reduce((s, i) => {
        const modSum = i.modifiers.reduce((ms, m) => ms + m.priceDeltaCents, 0)
        return s + (i.unitPriceCents + modSum) * i.quantity
      }, 0)
    const deliveryFee    = Math.max(0, order.deliveryFeeCents)
    const discount       = order.discountCents + order.promoDiscountCents
    const taxable        = subtotal + deliveryFee
    const fbrTax         = order.taxCents
    const serviceCharge  = order.serviceChargeCents
    const tip            = order.tipCents
    const total          = Math.max(0, subtotal + deliveryFee + fbrTax + serviceCharge + tip - discount)

    return tx.taxInvoice.create({
      data: {
        tenantId: concept.tenantId,
        invoiceNumber,
        type: 'invoice',
        orderId: order.id,
        conceptId: concept.id,
        sellerLegalName: concept.invoiceLegalName,
        sellerStrn: concept.strn,
        sellerNtn: concept.ntn,
        sellerAddress: concept.invoiceAddress,
        buyerName: buyer?.name ?? order.customerName,
        buyerStrn: buyer?.strn,
        buyerNtn: buyer?.ntn,
        buyerAddress: buyer?.address,
        subtotalCents: subtotal,
        discountCents: discount,
        taxableValueCents: taxable,
        fbrTaxCents: fbrTax,
        provincialTaxCents: 0,
        serviceChargeCents: serviceCharge,
        tipCents: tip,
        totalCents: total,
        deliveryFeeCents: deliveryFee,
        lines: {
          create: [
            ...order.items.filter((i) => i.status !== 'voided').map((i) => {
              const modSum = i.modifiers.reduce((ms, m) => ms + m.priceDeltaCents, 0)
              const unitPrice = i.unitPriceCents + modSum
              return {
                description: i.modifiers.length > 0
                  ? `${i.name} (${i.modifiers.map((m) => m.name).join(', ')})`
                  : i.name,
                quantity: i.quantity,
                unitPriceCents: unitPrice,
                lineTotalCents: unitPrice * i.quantity,
              }
            }),
            ...(deliveryFee > 0
              ? [{ description: DELIVERY_CHARGE_LINE, quantity: 1, unitPriceCents: deliveryFee, lineTotalCents: deliveryFee }]
              : []),
          ],
        },
      },
      include: { lines: true },
    })
  }, ISSUE_TX)
}

// Credit note — references the original invoice and belongs to the original's
// company, in that company's credit-note series.
//
// S-1 (owner, 2026-10-17: "Allow it, owed back"). A credit note always credits
// the WHOLE bill. On a bill that is still COMPLETED (never refunded in full),
// it is a sales return with no money handed over yet, so in the credit note's
// own transaction (under the order lock):
//   • ledger — ONE entry 'order.credit_note:<creditNoteId>': the same reversal
//     a refund of the money still refundable would book (orderPosting
//     refundShareOf / shareDebitLines: the brand's revenue, service charge,
//     tip, delivery fee and the output tax back to the account the sale
//     credited — refundTaxAccountFor), but the money side is Cr till clearing
//     (1110, or 1115 after the company's cut-over), memo REFUND DUE — owed
//     back to the customer, never cash / card / bank. Its slice is the LAST
//     one of the order's value, so the wallet and gift-card restores that the
//     'refunded' transition books (postOrderRefund, priced after the tender
//     refunds) tile the bill exactly with it;
//   • fiscal POS — the sale's return as ONE refund document ('void:<orderId>',
//     enqueueFiscalRefundTx): the sale's filed value less every return already
//     queued for it. Never sent from here directly; the outbox files it;
//   • then the order goes to 'refunded' through the state machine (as a refund
//     in full does): points, wallet and gift cards are restored there, and the
//     refund engine refuses any further refund (ALREADY_REFUNDED) — the money
//     owed back is paid out against till clearing, never booked twice.
// A refused posting rolls the credit note back (422). A cancelled / rejected /
// refunded order books nothing here (the cancel unwind or the refunds already
// did). The staff route answers 409 CREDIT_NOTE_EXISTS for a second one; the
// automatic credit note of a cancel / refund returns the existing one.
/**
 * `gate` (the staff route only): a credit note on a bill of an earlier sales
 * day is the CEO's, with a reason (night audit, nightAudit/backdate.ts —
 * 403 CEO_ONLY_BACKDATED / 422 BACKDATED_REASON_REQUIRED). The automatic
 * credit note of a cancel or refund (orders/service.ts) passes none: the
 * cancel is gated itself, a refund is not (owner question Q5).
 */
export async function issueCreditNoteForOrder(orderId: string, reason: string, gate?: { actor: { id: string; role: string; email?: string | null }; backdatedReason?: string | null }) {
  let backdated: import('../nightAudit/backdate.js').BackdatedGateResult = { backdated: false }
  let gateTenantId: string | null = null
  if (gate) {
    const { assertBackdatedSalesUndoAllowed, SALES_DAY_ORDER_SELECT } = await import('../nightAudit/backdate.js')
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { ...SALES_DAY_ORDER_SELECT, concept: { select: { tenantId: true } } } })
    if (order) {
      gateTenantId = order.concept.tenantId
      // A second credit note is refused (409, below) before anyone is asked for a reason.
      const already = await prisma.taxInvoice.findFirst({ where: { orderId, type: 'credit_note' }, select: { id: true } })
      if (already) {
        await finishCreditNoteTransition(orderId)
        throw creditNoteExists()
      }
      backdated = await assertBackdatedSalesUndoAllowed(prisma, {
        tenantId: gateTenantId, order, action: 'credit_note', actor: gate.actor, reason: gate.backdatedReason,
      })
    }
  }
  const out = await issueCreditNoteTx(orderId, reason, { refuseExisting: !!gate, actorId: gate?.actor.id ?? 'system' })
  const cn = out.creditNote
  if (out.fiscalDoc?.status === 'pending') {
    const { kickFiscal } = await import('../../connectors/fiscal/outbox.js')
    void kickFiscal(out.fiscalDoc.id)
  }
  if (out.returned) {
    await finishCreditNoteTransition(orderId)
    const { audit } = await import('../../lib/audit.js')
    await audit({
      category: 'accounting',
      action: 'credit_note.owed_back',
      entity: 'Order',
      entityId: orderId,
      userId: gate?.actor.id ?? null,
      userEmail: gate?.actor.email ?? null,
      tenantId: cn.tenantId,
      before: { status: 'completed' },
      after: { status: 'refunded', owedBackCents: out.owedBackCents },
      metadata: { creditNoteId: cn.id, invoiceNumber: cn.invoiceNumber, reason, entryId: out.entryId, fiscalRefund: out.fiscalDoc ? { documentId: out.fiscalDoc.id, status: out.fiscalDoc.status } : null },
    })
  }
  if (gate && backdated.backdated) {
    const { auditBackdatedSalesUndo } = await import('../nightAudit/backdate.js')
    await auditBackdatedSalesUndo({ tenantId: gateTenantId, orderId, action: 'credit_note', gate: backdated, actorId: gate.actor.id, actorEmail: gate.actor.email ?? null, amountCents: Math.abs(cn.totalCents) })
  }
  return { ...cn, owedBackCents: out.owedBackCents, entryId: out.entryId }
}

function creditNoteExists(): AppError {
  return new AppError('CREDIT_NOTE_EXISTS', 'This bill already has a credit note — a bill is credited once, in full', 409)
}

/** The ledger source of a credit note's sales return (sales source: 'order.' — night audit). One definition: orderPosting.ts. */
export { CREDIT_NOTE_SOURCE }

/**
 * A credit-noted bill still 'completed' (its credit note's return committed but
 * the transition failed): move it to 'refunded' now. Never throws.
 */
async function finishCreditNoteTransition(orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, concept: { select: { tenantId: true } } } })
    if (order?.status !== 'completed' || !order.concept.tenantId) return
    const cn = await prisma.taxInvoice.findFirst({ where: { orderId, type: 'credit_note' }, select: { id: true } })
    if (!cn) return
    const fiscal = await prisma.fiscalDocument.findFirst({ where: { tenantId: order.concept.tenantId, idempotencyKey: `void:${orderId}` }, select: { id: true } })
    const entry = await prisma.journalEntry.findFirst({ where: { tenantId: order.concept.tenantId, reference: `${CREDIT_NOTE_SOURCE}:${cn.id}` }, select: { id: true } })
    // Only a credit note issued under the S-1 rule (it booked a return or queued one).
    if (!fiscal && !entry) return
    const { updateOrderStatus } = await import('../orders/service.js')
    await updateOrderStatus(orderId, 'refunded')
  } catch (err) {
    console.error(`[invoice] credit note: status → refunded failed for ${orderId}:`, (err as Error).message)
  }
}

async function issueCreditNoteTx(orderId: string, reason: string, opts: { refuseExisting: boolean; actorId: string }) {
  return prisma.$transaction(async (tx) => {
    // The order lock first (the refund engine's lock), so a refund and a
    // credit note of one bill never both count the same money.
    const { lockOrderTx } = await import('../pos/service.js')
    await lockOrderTx(tx, orderId)

    const original = await tx.taxInvoice.findFirst({
      where: { orderId, type: 'invoice' },
      include: { lines: true },
    })
    if (!original) throw new NotFoundError('TaxInvoice', orderId)

    const concept = await tx.concept.findUnique({ where: { id: original.conceptId } })
    if (!concept) throw new NotFoundError('Concept', original.conceptId)

    const series: Series = { tenantId: original.tenantId, prefix: invoicePrefix(concept), year: karachiYear(), type: 'credit_note' }
    await lockSeries(tx, series)

    const existing = await tx.taxInvoice.findFirst({
      where: { originalInvoiceId: original.id, type: 'credit_note' },
      include: { lines: true },
    })
    if (existing) {
      if (opts.refuseExisting) throw creditNoteExists()
      return { creditNote: existing, returned: false, owedBackCents: 0, entryId: null, fiscalDoc: null }
    }

    // A bill still standing as a sale: what the credit note returns (S-1).
    const ret = await creditNoteReturnPlanTx(tx, orderId)

    const invoiceNumber = await nextNumber(tx, series)

    const creditNote = await tx.taxInvoice.create({
      data: {
        tenantId: original.tenantId,
        invoiceNumber,
        type: 'credit_note',
        orderId: original.orderId,
        conceptId: original.conceptId,
        originalInvoiceId: original.id,
        sellerLegalName: original.sellerLegalName,
        sellerStrn: original.sellerStrn,
        sellerNtn: original.sellerNtn,
        sellerAddress: original.sellerAddress,
        buyerName: original.buyerName,
        buyerStrn: original.buyerStrn,
        buyerNtn: original.buyerNtn,
        buyerAddress: original.buyerAddress,
        subtotalCents:      -original.subtotalCents,
        discountCents:      -original.discountCents,
        taxableValueCents:  -original.taxableValueCents,
        fbrTaxCents:        -original.fbrTaxCents,
        provincialTaxCents: -original.provincialTaxCents,
        serviceChargeCents: -original.serviceChargeCents,
        tipCents:           -original.tipCents,
        totalCents:         -original.totalCents,
        deliveryFeeCents:   -original.deliveryFeeCents,
        lines: {
          create: original.lines.map((l) => ({
            description: `Credit note: ${l.description} — ${reason}`,
            quantity: l.quantity,
            unitPriceCents: -l.unitPriceCents,
            lineTotalCents: -l.lineTotalCents,
          })),
        },
      },
      include: { lines: true },
    })
    if (!ret) return { creditNote, returned: false, owedBackCents: 0, entryId: null, fiscalDoc: null }
    const booked = await bookCreditNoteReturnTx(tx, ret, creditNote, reason, opts.actorId)
    return { creditNote, returned: true, ...booked }
  }, ISSUE_TX)
}

const CREDIT_NOTE_ORDER_SELECT = {
  id: true, status: true, source: true, conceptId: true, totalCents: true, walletAmountCents: true, taxCents: true,
  discountCents: true, promoDiscountCents: true, serviceChargeCents: true, tipCents: true, deliveryFeeCents: true,
  concept: { select: { slug: true, tenantId: true, province: true, srbPosId: true, revenueAccountCode: true } },
  payments: { select: { id: true, shiftId: true, method: true, status: true, amountCents: true, gatewayRef: true, gatewayMeta: true, processedAt: true, createdAt: true } },
  giftCardRedemptions: { select: { amountCents: true } },
} as const
type CreditNoteOrder = Prisma.OrderGetPayload<{ select: typeof CREDIT_NOTE_ORDER_SELECT }>

/**
 * What a credit note on this bill returns, or null when the bill no longer
 * stands as a sale (cancelled, rejected, refunded — nothing to book here).
 * The money owed back is what the refund engine would still refund
 * (pos/service refundableOf: tenders received less refunds, less card refunds
 * in flight on the machine). Refused like a refund: cash still with a rider
 * (422 CASH_NOT_PAID_IN); an on-account bill goes back to the client's account
 * through the refund route (422 ON_ACCOUNT_USE_REFUND).
 */
async function creditNoteReturnPlanTx(tx: Tx, orderId: string): Promise<{ order: CreditNoteOrder; tenantId: string; owedBackCents: number } | null> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: CREDIT_NOTE_ORDER_SELECT })
  if (order.status !== 'completed') return null
  const tenantId = order.concept.tenantId
  if (!tenantId) throw new AppError('NO_COMPANY', 'This brand is not bound to a company', 422)
  const { refundableOf, inFlightTerminalRefundCents } = await import('../pos/service.js')
  const state = refundableOf(order.payments, order.source)
  if (state.uncollectedCashCents > 0) {
    throw new AppError('CASH_NOT_PAID_IN', 'The cash for this order has not been paid into a drawer yet — pay it in (POS → cash due) first, then credit it', 422)
  }
  if ((state.byMethod.get('on_account') ?? 0) > 0) {
    throw new AppError('ON_ACCOUNT_USE_REFUND', "This bill was charged to an on-account client — refund it back to the client's account (the credit note follows the refund in full)", 422)
  }
  const inFlight = await inFlightTerminalRefundCents(tx, orderId)
  return { order, tenantId, owedBackCents: Math.max(0, state.refundable - inFlight) }
}

/** The credit note's ledger return (owed back on till clearing) and its fiscal refund document, in the caller's transaction. */
async function bookCreditNoteReturnTx(
  tx: Tx,
  ret: { order: CreditNoteOrder; tenantId: string; owedBackCents: number },
  creditNote: { id: string; invoiceNumber: string },
  reason: string,
  actorId: string,
): Promise<{ owedBackCents: number; entryId: string | null; fiscalDoc: { id: string; status: string } | null }> {
  const { order, tenantId, owedBackCents } = ret
  const { orderRefOf } = await import('../../lib/orderRef.js')
  let entryId: string | null = null
  if (owedBackCents > 0) {
    const op = await import('../accounting/orderPosting.js')
    const { postJournalEntry } = await import('../accounting/journal.js')
    const { tillClearingCodeTx } = await import('../accounting/tillClearingCode.js')
    const db = tx as unknown as typeof prisma
    // Valued as the refund engine values a refund (postRefundPayment): the sale
    // as it was booked, net of exact void refunds.
    const booking = await op.saleBookingOf(db, tenantId, order)
    const refundRows = order.payments.filter((p) => p.status === 'refunded')
    const giftCard = booking.legacyGiftCard ? 0 : op.giftCardAppliedOf(order.giftCardRedemptions)
    const valued = { ...op.netOfVoidRefunds(order, refundRows), giftCardAppliedCents: giftCard }
    const value = valued.totalCents + (valued.walletAmountCents ?? 0) + Math.max(0, giftCard)
    // The last slice of the bill: the tender refunds came first, and the wallet
    // and gift-card restores (postOrderRefund) take the slices right after them.
    const share = op.refundShareOf(valued, Math.max(0, value - owedBackCents), owedBackCents)
    const taxAccount = await op.refundTaxAccountFor(db, tenantId, valued, booking.saleTaxAccount, share.taxCents)
    const memo = `Credit note ${creditNote.invoiceNumber} on ${order.concept.slug} #${orderRefOf(order.id)}`
    const tillClearing = await tillClearingCodeTx(db, tenantId)
    const res = await postJournalEntry({
      tenantId,
      sourceType: CREDIT_NOTE_SOURCE,
      sourceId: creditNote.id,
      description: `Credit note ${creditNote.invoiceNumber}: sale ${orderRefOf(order.id)} returned (${order.concept.slug} / ${order.source}), PKR ${(owedBackCents / 100).toFixed(0)} owed back to the customer`,
      entryDate: new Date(),
      postedBy: actorId,
      lines: [
        ...op.shareDebitLines(valued, share, memo, taxAccount, op.refundRevenueAccountFor(valued, booking)),
        {
          accountCode: tillClearing, type: 'credit', amountCents: owedBackCents, conceptId: order.conceptId,
          memo: `${op.REFUND_DUE_PREFIX} — credit note ${creditNote.invoiceNumber} on order ${order.id}, owed back to the customer`,
        },
      ],
    }, { tx })
    if (!res.entryId) throw new AppError('CREDIT_NOTE_NOT_POSTED', 'The credit note could not be booked', 422)
    entryId = res.entryId
  }

  // The fiscal return: the sale's filed value less every return already queued
  // for it — one document, keyed 'void:<orderId>' (the refund-in-full key, so
  // the 'refunded' transition adds no second one).
  const { enqueueFiscalRefundTx } = await import('../../connectors/fiscal/outbox.js')
  const docs = await tx.fiscalDocument.findMany({ where: { orderId: order.id, tenantId }, select: { kind: true, amountCents: true } })
  const sale = docs.find((d) => d.kind === 'sale')
  const returned = docs.filter((d) => d.kind === 'refund').reduce((t, d) => t + d.amountCents, 0)
  const remainder = (sale?.amountCents ?? order.totalCents) - returned
  const fiscalDoc = remainder > 0
    ? await enqueueFiscalRefundTx(tx, { orderId: order.id, tenantId, refundPaymentId: null, amountCents: remainder, reason: `Credit note ${creditNote.invoiceNumber}: ${reason}`.slice(0, 200) })
    : null
  return { owedBackCents, entryId, fiscalDoc: fiscalDoc ? { id: fiscalDoc.id, status: fiscalDoc.status } : null }
}

// HTML render — kept minimal and printable. Operators can pdf-it via the
// browser's print dialog, or wire wkhtmltopdf / Playwright later if they need
// programmatic PDF generation.
export function renderInvoiceHtml(invoice: {
  invoiceNumber: string; type: string; issuedAt: Date
  sellerLegalName: string; sellerStrn?: string | null; sellerNtn?: string | null; sellerAddress?: string | null
  buyerName?: string | null; buyerStrn?: string | null; buyerNtn?: string | null; buyerAddress?: string | null
  subtotalCents: number; discountCents: number; taxableValueCents: number
  fbrTaxCents: number; provincialTaxCents: number; serviceChargeCents: number; tipCents: number; totalCents: number
  deliveryFeeCents?: number
  lines: Array<{ description: string; quantity: number; unitPriceCents: number; lineTotalCents: number }>
  /** A test company's invoice (owner, 2026-10-14): stamped TEST, never a real tax invoice. */
  testCompany?: boolean
}): string {
  const fmt = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 2 })}`
  const date = invoice.issuedAt.toISOString().slice(0, 10)
  const baseTitle = invoice.type === 'credit_note' ? 'Credit Note' : 'Tax Invoice'
  const title = invoice.testCompany ? `TEST ${baseTitle}` : baseTitle

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>${title} ${invoice.invoiceNumber}</title>
<style>
  body { font: 14px/1.4 system-ui, -apple-system, sans-serif; color: #111; padding: 32px; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .muted { color: #666; font-size: 12px; }
  .row { display: flex; gap: 24px; margin: 16px 0; }
  .row > div { flex: 1; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
  th { background: #f7f7f7; font-weight: 600; }
  .right { text-align: right; }
  .totals { margin-left: auto; width: 280px; }
  .totals tr td:first-child { color: #666; }
  .totals tr.grand td { font-weight: 700; font-size: 16px; padding-top: 12px; border-top: 2px solid #111; }
  .footer { margin-top: 32px; font-size: 11px; color: #888; }
  .stamp { display: inline-block; padding: 4px 10px; border: 2px solid #111; border-radius: 4px; font-weight: 700; letter-spacing: 1px; font-size: 11px; }
  @media print { body { padding: 0; } .no-print { display: none; } }
</style>
</head><body>

${invoice.testCompany ? '<div class="stamp">TEST COMPANY — NOT A REAL INVOICE</div>' : ''}
<h1>${title}</h1>
<div class="muted">${invoice.invoiceNumber} · Issued ${date}</div>

<div class="row">
  <div>
    <strong>From</strong><br/>
    ${escape(invoice.sellerLegalName)}<br/>
    ${invoice.sellerAddress ? escape(invoice.sellerAddress).split('\n').join('<br/>') + '<br/>' : ''}
    ${invoice.sellerStrn ? `STRN: <strong>${escape(invoice.sellerStrn)}</strong><br/>` : ''}
    ${invoice.sellerNtn  ? `NTN: <strong>${escape(invoice.sellerNtn)}</strong>` : ''}
  </div>
  <div>
    <strong>To</strong><br/>
    ${invoice.buyerName ? escape(invoice.buyerName) + '<br/>' : '(walk-in customer)<br/>'}
    ${invoice.buyerAddress ? escape(invoice.buyerAddress).split('\n').join('<br/>') + '<br/>' : ''}
    ${invoice.buyerStrn ? `STRN: ${escape(invoice.buyerStrn)}<br/>` : ''}
    ${invoice.buyerNtn  ? `NTN: ${escape(invoice.buyerNtn)}` : ''}
  </div>
</div>

<table>
  <thead>
    <tr><th>Description</th><th class="right">Qty</th><th class="right">Unit Price</th><th class="right">Line Total</th></tr>
  </thead>
  <tbody>
    ${invoice.lines.map((l) => `
      <tr>
        <td>${escape(l.description)}</td>
        <td class="right">${l.quantity}</td>
        <td class="right">${fmt(l.unitPriceCents)}</td>
        <td class="right">${fmt(l.lineTotalCents)}</td>
      </tr>
    `).join('')}
  </tbody>
</table>

<table class="totals">
  <tr><td>Subtotal</td>          <td class="right">${fmt(invoice.subtotalCents)}</td></tr>
  ${invoice.deliveryFeeCents ? `<tr><td>Delivery charge</td>   <td class="right">${fmt(invoice.deliveryFeeCents)}</td></tr>` : ''}
  ${invoice.discountCents !== 0 ?      `<tr><td>Discount</td>          <td class="right">${fmt(-invoice.discountCents)}</td></tr>` : ''}
  <tr><td>Taxable value</td>     <td class="right">${fmt(invoice.taxableValueCents)}</td></tr>
  ${invoice.fbrTaxCents !== 0 ?        `<tr><td>FBR sales tax</td>     <td class="right">${fmt(invoice.fbrTaxCents)}</td></tr>` : ''}
  ${invoice.provincialTaxCents !== 0 ? `<tr><td>Provincial sales tax</td><td class="right">${fmt(invoice.provincialTaxCents)}</td></tr>` : ''}
  ${invoice.serviceChargeCents !== 0 ? `<tr><td>Service charge</td>    <td class="right">${fmt(invoice.serviceChargeCents)}</td></tr>` : ''}
  ${invoice.tipCents !== 0 ?           `<tr><td>Tip</td>               <td class="right">${fmt(invoice.tipCents)}</td></tr>` : ''}
  <tr class="grand"><td>Total</td><td class="right">${fmt(invoice.totalCents)}</td></tr>
</table>

${invoice.type === 'credit_note' ? '<p><span class="stamp">CREDIT NOTE</span></p>' : ''}

<div class="footer">
  This is a computer-generated ${title.toLowerCase()}.
  ${invoice.sellerStrn ? `Registered under FBR sales tax registration ${escape(invoice.sellerStrn)}.` : ''}
</div>

</body></html>`
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!))
}
