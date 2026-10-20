// The fiscal payload builder (spec §6.1, D8) — the ONE place an order becomes
// a document for the external fiscal POS.
//
// Built only from STORED order figures: Order.taxCents, Order.taxRatePct (15
// cash / 8 card, stamped by lib/pricing.ts and re-priced to the tender at the
// till), discountCents + promoDiscountCents, serviceChargeCents, tipCents,
// totalCents, walletAmountCents and the order's gift-card redemptions. Never
// concept.taxRate (the legacy 17 %), never a recomputed tax.
//
// ONL-R2-02 — totals.totalCents is the BILL, the value the ledger books
// (orderPosting computeSaleAccounting: revenue + GST + service + tip):
//   bill = Order.totalCents (what was still owed after the wallet and gift
//          cards) + Order.walletAmountCents + gift-card redemptions
//        = (sale value − discount) + tax + service charge + tip.
// Wallet, gift card and the COD cash still pending at completion are TENDERS
// of that bill, never subtracted from it.
//
// The delivery fee (owner 2026-10-13, H9) is a TAXED SUPPLY. An order priced
// with it stores Order.deliveryFeeCents (the fee before GST) and
// Order.deliveryFeeTaxCents (its GST at the order's standard tender rate,
// inside Order.taxCents), and the fee becomes a document LINE of its own:
//   { lineId 'delivery:<orderId>', itemCode 'DELIVERY-CHARGE',
//     description 'Delivery charge', quantity 1, unit = gross = the fee,
//     discount = its share of the discount, taxable = fee − that share,
//     taxRatePct = the order's standard rate, taxCents = deliveryFeeTaxCents }
// so the food lines carry Order.taxCents − deliveryFeeTaxCents, saleValueCents
// and discountCents include the fee line, and totals.deliveryChargeCents is 0.
// The FBR reference mapping gives that line ItemCode 'DELIVERY' (PCT
// 9963.1100 until the vendor / CA says otherwise).
// A LEGACY delivery order (priced before the fee had columns — fee 0 stored,
// the fee untaxed inside the total) keeps the old rule: its fee is
// totals.deliveryChargeCents, what is left of the bill once the food, tax,
// service and tip are accounted for, and only on a delivery order. Any other
// remainder means the stored figures do not add up: totalsCheck() says so and
// the outbox never files that document (fiscal_failed, totals_mismatch).
//
// F-RV-1 — a discount larger than the food. A loyalty redemption may cover
// the GST and the delivery fee too (storefront checkout caps it at the priced
// total, the till at what is still owed), and a 100 % discount leaves the
// customer paying only the GST. The discount covers the FOOD lines first (up
// to their gross, taxable 0), then the delivery-charge line (up to the fee),
// and only what is left above both is totals.billDiscountCents, taken off the
// bill after the tax:
//   Σ taxable + tax + service + tip + delivery − billDiscount = the bill.
// The stored tax is spread over the food lines by taxable × rate, or by
// gross × rate once they are fully discounted (GST is levied on the
// pre-discount value — lib/pricing priceOrder). billDiscountCents is present
// only when non-zero, so every other payload is unchanged.
//
// Buyer and tender of an on-account bill (owner 2026-10-13, H14): an order
// charged to a named corporate client (CustomerAccountCharge) names the client
// as the buyer (legal name, NTN, STRN, CNIC, address), and 'on_account' is the
// CASH class (lib/pricing tenderOf, the CA's default): payment mode 'cash',
// SRB modeOfPay 'Cash' when every tender is cash or on account, FBR
// PaymentMode 2 when any is (vendor to confirm), and a whole-order return of an
// all-on-account sale goes back 'on_account'.
//
// Ported from servd's old direct filers (adapters/fbr, adapters/srb — removed
// in the cutover), so nothing they got right is lost:
//   - FBR: the order's stored GST is split over the lines by each line's
//     taxable value × its item's tax-class rate (zero-rated / exempt lines
//     carry none), so the lines sum to exactly the GST the customer paid; an
//     order priced before Order.taxRatePct existed falls back to the rate of
//     the tender it was paid with (gstRatePct(concept, tender)).
//   - SRB: the sale value is the gross, PRE-discount, ex-tax value straight
//     from the lines (modifiers included), so it is right for every order
//     source; the discount is POS discount + storefront promo; "cash" only when
//     every paid tender is cash; the invoice time is the completion time; the
//     seller name is the brand's legal name, falling back to the brand name.
// toSrbInvoiceFields / toFbrInvoiceFields below show how the neutral payload
// maps onto each authority's own invoice — a reference for vendors and the
// regression the payload test encodes.

import type { Prisma } from '@prisma/client'
import { allocateTaxCents, gstRatePct, lineTaxRatePct, tenderOfPayments } from '../../lib/pricing.js'
import { NotFoundError } from '../../lib/errors.js'
import { giftCardAppliedOf, withTenderTips } from '../../modules/accounting/orderPosting.js'
import type { FiscalAuthority, FiscalLine, FiscalParty, FiscalPayload, FiscalRegistration, FiscalSettings } from '../types.js'
import { isoPkt, sha256Hex, stableStringify } from '../util.js'

type Tx = Prisma.TransactionClient

// Cash class: cash, and an on-account client's bill (owner/CA default — lib/pricing tenderOf).
const CASH = new Set(['cash', 'on_account'])
// The digital tax group (lib/pricing CARD_TENDERS → Concept.taxRateCard):
// card (Card – Keenu), Raast QR (an instant bank transfer to the seller's
// account, 2026-10-12), the retired Keenu QR (old sales) and the servd wallet
// (paid online). A Raast-only sale is mode 'card'; any cash with it is
// 'mixed', exactly as for card.
const CARD = new Set(['card', 'raast', 'keenu_qr', 'wallet'])
// Not money tendered at this sale: a comp, and a gift card (its money was
// taken when the card was sold). Neither decides cash / card.
const NOT_MONEY = new Set(['comp', 'gift_card'])

/**
 * The payload totals as servd sends them (contract v1). `deliveryChargeCents`
 * was added in ONL-R2-02 — optional for backward compatibility (a payload
 * built before it, and the setup dry run, have none = 0); since H9 it is the
 * LEGACY untaxed fee only, 0 when the fee is a DELIVERY-CHARGE line.
 * `billDiscountCents` (F-RV-1) is the discount above the food and the
 * delivery charge, taken off after the tax; present only when it is non-zero.
 */
export type FiscalTotals = FiscalPayload['totals'] & { deliveryChargeCents?: number; billDiscountCents?: number }

export function totalsOf(p: FiscalPayload): FiscalTotals {
  return p.totals as FiscalTotals
}

export interface TotalsCheck {
  ok: boolean
  /** lines' taxable + tax + service + tip + delivery charge − bill discount. */
  sumCents: number
  totalCents: number
  problems: string[]
}

/**
 * THE totals assertion, for a sale and a refund alike (ONL-R2-02):
 *   Σ lines.taxableCents + taxCents + serviceChargeCents + tipCents
 *     + deliveryChargeCents − billDiscountCents === totalCents
 * and Σ lines.taxCents === taxCents, Σ taxable === saleValue − discount, no
 * negative figure; a bill discount only once the food is fully discounted
 * (F-RV-1). A document that fails it is never filed.
 */
export function totalsCheck(p: FiscalPayload): TotalsCheck {
  const t = totalsOf(p)
  const fee = t.deliveryChargeCents ?? 0
  const billDiscount = t.billDiscountCents ?? 0
  const taxable = p.lines.reduce((s, l) => s + l.taxableCents, 0)
  const lineTax = p.lines.reduce((s, l) => s + l.taxCents, 0)
  const sumCents = taxable + t.taxCents + t.serviceChargeCents + t.tipCents + fee - billDiscount
  const problems: string[] = []
  if (sumCents !== t.totalCents) {
    problems.push(`lines ${taxable} + tax ${t.taxCents} + service ${t.serviceChargeCents} + tip ${t.tipCents} + delivery ${fee}${billDiscount ? ` − bill discount ${billDiscount}` : ''} = ${sumCents}, not the bill ${t.totalCents}`)
  }
  if (lineTax !== t.taxCents) problems.push(`line tax ${lineTax} is not the order's tax ${t.taxCents}`)
  if (taxable !== t.saleValueCents - t.discountCents) problems.push(`lines ${taxable} are not sale value ${t.saleValueCents} − discount ${t.discountCents}`)
  if (billDiscount > 0 && taxable !== 0) problems.push(`a bill discount ${billDiscount} while the lines still carry ${taxable}`)
  if ([t.totalCents, t.taxCents, t.serviceChargeCents, t.tipCents, fee, billDiscount, t.saleValueCents, t.discountCents].some((x) => !Number.isInteger(x) || x < 0)
    || p.lines.some((l) => l.taxableCents < 0 || l.taxCents < 0)) problems.push('a negative or fractional figure')
  return { ok: problems.length === 0, sumCents, totalCents: t.totalCents, problems }
}

export function payloadHash(p: FiscalPayload): string {
  return sha256Hex(stableStringify(p))
}

/** The fee line's itemCode (H9) and its line id prefix — `delivery:<orderId>`. */
export const DELIVERY_CHARGE_ITEM_CODE = 'DELIVERY-CHARGE' as const
export const deliveryLineId = (orderId: string) => `delivery:${orderId}`
/** The sale's delivery-charge line (H9) — never part of a voided dish's return. */
export const isDeliveryChargeLine = (l: Pick<FiscalLine, 'lineId' | 'itemCode'>): boolean =>
  l.itemCode === DELIVERY_CHARGE_ITEM_CODE || l.lineId.startsWith('delivery:')

/** A TILL-R3 void's exact split, as a return document takes it (buildRefundPayload opts.voidSplit). */
export interface VoidReturnSplit {
  revenueCents: number
  taxCents: number
  serviceChargeCents: number
  tipCents: number
  deliveryFeeCents?: number
  /** The voided order item — the sale line its value and GST go back on. */
  lineId?: string | null
}

/** Human order ref: the last 8 characters of the order id, upper-cased. */
export function orderRefOf(orderId: string): string {
  return orderId.replace(/-/g, '').slice(-8).toUpperCase()
}

/**
 * The registrations a document files under (spec §6.1): outlet overrides for
 * this outlet + brand first, then outlet-wide overrides, then the brand's own
 * POS ids (Concept.srbPosId → srb, Concept.fbrPosId → fbr). Each authority at
 * most once; an override beats the brand id for the same authority.
 */
export function resolveRegistrations(
  outlets: FiscalSettings['outlets'],
  concept: { id: string; fbrPosId: number | null; srbPosId: number | null },
  locationId: string | null,
): FiscalRegistration[] {
  const out: FiscalRegistration[] = []
  const seen = new Set<FiscalAuthority>()
  const add = (r: FiscalRegistration) => {
    if (seen.has(r.authority)) return
    seen.add(r.authority)
    out.push(r)
  }
  if (locationId) {
    for (const o of outlets) if (o.locationId === locationId && o.conceptId === concept.id) add({ authority: o.authority, posId: o.posId, ...(o.storeId && { storeId: o.storeId }) })
    for (const o of outlets) if (o.locationId === locationId && o.conceptId === null) add({ authority: o.authority, posId: o.posId, ...(o.storeId && { storeId: o.storeId }) })
  }
  if (concept.srbPosId) add({ authority: 'srb', posId: String(concept.srbPosId) })
  if (concept.fbrPosId) add({ authority: 'fbr', posId: String(concept.fbrPosId) })
  return out
}

/**
 * cash / card / mixed from the tenders (comps and gift cards are not money
 * tendered now and do not decide the mode). 'card' is the digital group:
 * card, Raast QR, the retired Keenu QR and the servd wallet; 'cash' is cash
 * and an on-account client's bill.
 */
export function paymentModeOf(methods: string[]): 'cash' | 'card' | 'mixed' {
  const money = methods.filter((m) => !NOT_MONEY.has(m))
  if (money.length === 0) return 'cash'
  if (money.every((m) => CASH.has(m))) return 'cash'
  if (money.every((m) => CARD.has(m))) return 'card'
  return 'mixed'
}

const ORDER_INCLUDE = {
  concept: {
    select: {
      id: true, name: true, invoiceLegalName: true, ntn: true, strn: true, province: true, invoiceAddress: true,
      fbrPosId: true, srbPosId: true, taxRateCash: true, taxRateCard: true, tenantId: true,
    },
  },
  items: {
    where: { status: { not: 'voided' as const } },
    orderBy: { createdAt: 'asc' as const },
    include: { modifiers: true, menuItem: { select: { taxClassification: true, overrideTaxRate: true } } },
  },
  // Money in: paid rows, and rows still pending at completion (a storefront
  // cash-on-delivery the rider collects, an online gateway still settling) —
  // both are tenders of the bill (ONL-R2-02). Refund / failed rows are not.
  payments: {
    where: { status: { in: ['paid' as const, 'pending' as const] }, amountCents: { gt: 0 } },
    orderBy: { createdAt: 'asc' as const },
    select: { method: true, amountCents: true, status: true, gatewayMeta: true },
  },
  giftCardRedemptions: { select: { amountCents: true } },
  customer: { select: { name: true, ntn: true, cnic: true } },
} satisfies Prisma.OrderInclude

export interface BuiltSale {
  payload: FiscalPayload
  hash: string
  conceptId: string
  locationId: string | null
  /** The bill (totals.totalCents) — the document's amountCents. */
  totalCents: number
  registrations: FiscalRegistration[]
  legacy: { fbrInvoiceNumber: string | null; srbInvoiceNumber: string | null }
  /** totalsCheck(payload): the outbox never files a document that fails it. */
  check: TotalsCheck
  /** How the bill was closed (Order.settlementChannel, till flow 2026-10-20): 'servd' is filed by hand, never sent. */
  settlementChannel: 'keenu' | 'servd' | null
}

/**
 * Build the neutral sale payload for an order, inside the caller's
 * transaction. `documentId` is the FiscalDocument id (the vendor idempotency
 * key) — pass the id the row will be created with.
 */
export async function buildFiscalSaleTx(tx: Tx, orderId: string, documentId: string, settings: Pick<FiscalSettings, 'outlets'>): Promise<BuiltSale> {
  // W4-FISCAL-1: a line voided on a PAID, still-open order is not taken off
  // the bill — its value goes back as a refund payment (pos/service
  // voidOrderItem, TILL-R3) whose return document completeOrder queues behind
  // this sale. So the sale lists what was CHARGED, that line included (its
  // totals are the stored, unlowered bill), and the return takes it off once.
  // Leaving the line out here took it off twice (sale lines + return) and
  // left the sale's lines disagreeing with its own totals.
  const refundedVoids = await tx.payment.findMany({
    where: { orderId, status: 'refunded', amountCents: { lt: 0 } },
    select: { gatewayMeta: true },
  })
  const refundedVoidIds = refundedVoids
    .map((p) => (p.gatewayMeta as { refund?: { voidedItemId?: unknown } } | null)?.refund?.voidedItemId)
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      ...ORDER_INCLUDE,
      items: { ...ORDER_INCLUDE.items, where: { OR: [{ status: { not: 'voided' as const } }, { id: { in: refundedVoidIds } }] } },
    },
  })
  if (!order) throw new NotFoundError('Order', orderId)
  const concept = order.concept
  const paid = order.payments.filter((p) => p.status === 'paid')
  const methods = paid.map((p) => p.method as string)
  const standardRate = order.taxRatePct ?? gstRatePct(concept, tenderOfPayments(methods))

  // Lines: gross = qty × (unit + modifiers), exactly as the order stores it.
  const base = order.items.map((it) => {
    const unit = it.unitPriceCents + it.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)
    const mods = it.modifiers.map((m) => m.name).filter(Boolean)
    return {
      id: it.id,
      code: it.menuItemId ?? 'POS-ITEM',
      description: (mods.length ? `${it.name} (${mods.join(', ')})` : it.name).slice(0, 200),
      quantity: it.quantity,
      unit,
      gross: unit * it.quantity,
      rate: lineTaxRatePct(it.menuItem, standardRate),
    }
  })
  const foodValueCents = base.reduce((s, l) => s + l.gross, 0)
  // H9: a delivery fee stored on the order is a taxed line of its own, with
  // its stored GST (never more than the order's tax). Fee 0 = no line (a
  // pickup, the till, or a legacy delivery whose fee is the remainder below).
  const feeCents = Math.max(0, order.deliveryFeeCents)
  const feeTaxCents = feeCents > 0 ? Math.max(0, Math.min(order.deliveryFeeTaxCents, order.taxCents)) : 0
  const foodTaxCents = order.taxCents - feeTaxCents
  const storedDiscount = Math.max(0, order.discountCents + order.promoDiscountCents)
  // The discount covers the food first, then the delivery-charge line; F-RV-1:
  // what it takes beyond both (loyalty over the GST, a 100 % discount) comes
  // off the bill after the tax.
  const foodDiscountCents = Math.min(storedDiscount, Math.max(0, foodValueCents))
  const feeDiscountCents = Math.min(storedDiscount - foodDiscountCents, feeCents)
  const billDiscountCents = storedDiscount - foodDiscountCents - feeDiscountCents
  const lineDiscount = allocateTaxCents(base.map((l) => l.gross), foodDiscountCents)
  const lineTaxable = base.map((l, i) => l.gross - lineDiscount[i]!)
  // The food's GST over the food lines by taxable × rate; once the food is
  // fully discounted (no taxable value left) by gross × rate — the tax was
  // levied on the pre-discount value.
  const taxWeights = base.map((l, i) => lineTaxable[i]! * l.rate)
  const lineTax = allocateTaxCents(
    taxWeights.some((w) => w > 0) ? taxWeights : base.map((l) => l.gross * l.rate),
    foodTaxCents,
  )
  const lines: FiscalLine[] = base.map((l, i) => ({
    lineId: l.id,
    itemCode: l.code,
    description: l.description,
    quantity: l.quantity,
    unitPriceCents: l.unit,
    grossCents: l.gross,
    discountCents: lineDiscount[i]!,
    taxableCents: lineTaxable[i]!,
    taxRatePct: l.rate,
    taxCents: lineTax[i]!,
  }))
  if (feeCents > 0) {
    lines.push({
      lineId: deliveryLineId(order.id),
      itemCode: DELIVERY_CHARGE_ITEM_CODE,
      description: 'Delivery charge',
      quantity: 1,
      unitPriceCents: feeCents,
      grossCents: feeCents,
      discountCents: feeDiscountCents,
      taxableCents: feeCents - feeDiscountCents,
      taxRatePct: standardRate,
      taxCents: feeTaxCents,
    })
  }
  const saleValueCents = foodValueCents + feeCents
  const discountCents = foodDiscountCents + feeDiscountCents

  // The bill (ONL-R2-02): what was still owed (Order.totalCents, lowered by
  // the wallet at checkout and by every gift-card redemption) plus the wallet
  // and gift-card value, with a tip found only on a tender folded in exactly
  // as the ledger does (withTenderTips).
  const giftCardCents = giftCardAppliedOf(order.giftCardRedemptions)
  const walletCents = Math.max(0, order.walletAmountCents)
  const valued = withTenderTips(order, order.payments)
  const tipCents = valued.tipCents
  const billCents = valued.totalCents + walletCents + giftCardCents
  const taxableTotal = lines.reduce((s, l) => s + l.taxableCents, 0)
  // A fee stored on the order is a line (above), so nothing is left over. A
  // LEGACY delivery order's untaxed fee is what is left of the bill; on any
  // other order the remainder must be zero (totalsCheck flags it).
  const remainder = billCents - (taxableTotal + order.taxCents + order.serviceChargeCents + tipCents - billDiscountCents)
  const deliveryChargeCents = feeCents === 0 && order.fulfilmentType === 'delivery' && remainder > 0 ? remainder : 0

  // Tenders: the paid rows (cash, card, raast — Raast QR — and the retired
  // keenu_qr on old sales, each by its stored amount), then what is still
  // pending (COD cash) up to the charged amount, then the wallet and gift
  // cards.
  const tenders = new Map<string, number>()
  const addTender = (method: string, cents: number) => { if (cents > 0) tenders.set(method, (tenders.get(method) ?? 0) + cents) }
  let left = valued.totalCents
  for (const p of paid) { addTender(p.method, p.amountCents); left -= p.amountCents }
  for (const p of order.payments) {
    if (p.status !== 'pending' || left <= 0) continue
    const take = Math.min(p.amountCents, left)
    addTender(p.method, take)
    left -= take
  }
  addTender('wallet', walletCents)
  addTender('gift_card', giftCardCents)
  const tenderMethods = [...tenders.keys()]

  const seller: FiscalParty & { legalName: string } = {
    legalName: concept.invoiceLegalName?.trim() || concept.name,
    ...(concept.ntn && { ntn: concept.ntn }),
    ...(concept.strn && { strn: concept.strn }),
    ...(concept.province && { province: concept.province }),
    ...(concept.invoiceAddress && { address: concept.invoiceAddress }),
  }
  // The buyer: an on-account client the order was charged to (its own
  // company's charge only — H14), else a customer with an NTN / CNIC.
  const client = concept.tenantId
    ? (await tx.customerAccountCharge.findFirst({
        where: { orderId: order.id, tenantId: concept.tenantId },
        select: { account: { select: { legalName: true, ntn: true, strn: true, cnic: true, address: true } } },
      }))?.account ?? null
    : null
  const c = order.customer
  const buyer: FiscalParty | null = client
    ? {
        legalName: client.legalName,
        ...(client.ntn && { ntn: client.ntn }),
        ...(client.strn && { strn: client.strn }),
        ...(client.cnic && { cnic: client.cnic }),
        ...(client.address && { address: client.address }),
      }
    : c && (c.ntn || c.cnic)
      ? { ...(c.name && { legalName: c.name }), ...(c.ntn && { ntn: c.ntn }), ...(c.cnic && { cnic: c.cnic }) }
      : null

  const invoice = await tx.taxInvoice.findFirst({ where: { orderId, type: 'invoice' }, select: { invoiceNumber: true }, orderBy: { issuedAt: 'asc' } })
  const registrations = resolveRegistrations(settings.outlets, concept, order.locationId)

  const totals: FiscalTotals = {
    saleValueCents,
    discountCents,
    taxableCents: taxableTotal,
    taxCents: order.taxCents,
    taxRatePct: standardRate,
    serviceChargeCents: order.serviceChargeCents,
    tipCents,
    deliveryChargeCents,
    ...(billDiscountCents > 0 && { billDiscountCents }),
    totalCents: billCents,
  }
  const payload: FiscalPayload = {
    version: 1,
    documentId,
    kind: 'sale',
    orderId: order.id,
    orderRef: orderRefOf(order.id),
    source: order.source,
    issuedAt: isoPkt(order.completedAt ?? order.placedAt),
    currency: 'PKR',
    registrations,
    seller,
    buyer,
    lines,
    totals,
    payment: {
      mode: paymentModeOf(tenderMethods),
      tenders: [...tenders.entries()].map(([method, amountCents]) => ({ method, amountCents })),
    },
    ...(invoice && { servdInvoiceNumber: invoice.invoiceNumber }),
    // Till flow (2026-10-20): a bill pushed to Keenu names the push, so the
    // Keenu driver files THE bill its POS settled (idempotent on the push).
    ...(order.settlementChannel === 'keenu' && { settlement: { channel: 'keenu' as const, ...keenuPushRefOf(order.settlementMeta) } }),
  }
  return {
    payload,
    hash: payloadHash(payload),
    conceptId: order.conceptId,
    locationId: order.locationId,
    totalCents: billCents,
    registrations,
    legacy: { fbrInvoiceNumber: order.fbrInvoiceNumber, srbInvoiceNumber: order.srbInvoiceNumber },
    check: totalsCheck(payload),
    settlementChannel: order.settlementChannel ?? null,
  }
}

/** The Keenu push reference stored on Order.settlementMeta.keenu (pos/keenuPush.ts). */
function keenuPushRefOf(meta: unknown): { pushId?: string; providerRef?: string } {
  const k = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as { keenu?: unknown }).keenu : null
  if (!k || typeof k !== 'object') return {}
  const o = k as { pushId?: unknown; providerRef?: unknown }
  return {
    ...(typeof o.pushId === 'string' && { pushId: o.pushId }),
    ...(typeof o.providerRef === 'string' && { providerRef: o.providerRef }),
  }
}

export interface RefundOriginal {
  documentId?: string
  fiscalNumber: string
  authority?: string
  issuedAt?: string
}

/**
 * The tender a return defaults to when the refund engine names none (a
 * whole-order void): Raast QR when the sale's money was all Raast — the
 * money goes back by bank transfer — 'on_account' when it was all charged to
 * an on-account client (it goes back on the client's account), else card for
 * a card-mode sale, else cash (the rule before Raast, unchanged).
 */
function defaultRefundMethod(sale: FiscalPayload): string {
  const money = sale.payment.tenders.map((t) => t.method).filter((m) => !NOT_MONEY.has(m))
  if (money.length > 0 && money.every((m) => m === 'raast')) return 'raast'
  if (money.length > 0 && money.every((m) => m === 'on_account')) return 'on_account'
  return sale.payment.mode === 'card' ? 'card' : 'cash'
}

/**
 * A refund / void document's payload, pro rata of its sale (spec §6.1):
 *   refundTax = round(sale.tax × refund / sale.total)
 * and likewise the tip, service-charge and delivery-charge shares; the rest is
 * the returned taxable value, spread over the sale lines by their taxable
 * values (largest remainder, so it sums exactly), with the refund tax spread
 * by taxable × rate. lines + tax + service + tip + delivery = the refund
 * amount exactly — the same rules as the sale (totalsCheck). A sale with a
 * bill discount (F-RV-1: the discount covered all of the food) returns its
 * share of that too, so a full refund of such a sale mirrors it: no taxable
 * value, all of the tax, the bill discount — as the ledger's refundShareOf
 * books it (tax share, negative revenue). sale.total is the
 * sale's BILL (ONL-R2-02), the base the ledger's refund split uses too
 * (orderPosting refundShareOf), so a refund paid back from a gift card or the
 * wallet takes its share of the tax, not all of it.
 */
export function buildRefundPayload(sale: FiscalPayload, opts: {
  documentId: string
  refundAmountCents: number
  issuedAt: Date
  reason?: string
  method?: string | null
  original: RefundOriginal | null
  /**
   * The tip share of this refund when it is known rather than pro rata: 0 for
   * the refund of a voided line (its amount is pure line value — a tip is
   * never part of it, W4-FISCAL-1), or the share an earlier build fixed (a
   * waiting refund rebuilt from its filed sale keeps it). Omitted → pro rata.
   */
  tipShareCents?: number
  /**
   * The exact split of a line voided on a paid, still-open order (TILL-R3):
   * what the void took off the bill (orderPosting voidSplitOf — the line's
   * value net of its discount, its own GST and service charge; never the
   * delivery fee or the tip). Its value and GST go back on that line
   * (`lineId`, the order item, when the sale lists it; else on the sale's
   * lines other than the delivery charge) — never pro rata over the bill,
   * which took a share off the delivery-charge line and reclaimed GST on a
   * zero-rated line. Ignored (the tip rule above applies) when it does not
   * add up to the refund or exceeds the sale.
   */
  voidSplit?: VoidReturnSplit
}): FiscalPayload {
  const st = totalsOf(sale)
  const saleTotal = st.totalCents
  const saleFee = Math.max(0, st.deliveryChargeCents ?? 0)
  const saleBillDiscount = Math.max(0, st.billDiscountCents ?? 0)
  const saleTaxable = sale.lines.reduce((s, l) => s + l.taxableCents, 0)
  const amount = Math.max(0, Math.min(opts.refundAmountCents, saleTotal > 0 ? saleTotal : opts.refundAmountCents))
  const share = (part: number) => (saleTotal > 0 ? Math.round((part * amount) / saleTotal) : 0)
  let refundTax: number
  let refundService: number
  let refundTip: number
  let refundFee: number
  let refundBillDiscount: number
  const vs = opts.voidSplit
  const voidExact = !!vs && [vs.revenueCents, vs.taxCents, vs.serviceChargeCents, vs.tipCents].every((x) => Number.isInteger(x) && x >= 0)
    && (vs.deliveryFeeCents ?? 0) === 0
    && vs.revenueCents + vs.taxCents + vs.serviceChargeCents + vs.tipCents === amount
    && vs.taxCents <= st.taxCents && vs.serviceChargeCents <= st.serviceChargeCents && vs.tipCents <= st.tipCents
  if (voidExact) {
    refundTax = vs!.taxCents
    refundService = vs!.serviceChargeCents
    refundTip = vs!.tipCents
    refundFee = 0
    refundBillDiscount = 0
  } else if (opts.tipShareCents === undefined) {
    refundTax = share(st.taxCents)
    refundService = share(st.serviceChargeCents)
    refundTip = share(st.tipCents)
    refundFee = share(saleFee)
    refundBillDiscount = share(saleBillDiscount)
  } else {
    // A known tip share: the rest of the refund is pro rata of the sale
    // WITHOUT its tip (a voided line's refund holds no tip, so its tax is
    // the line's share of the tax on the food, not of a total that includes
    // the tip).
    refundTip = Math.max(0, Math.min(opts.tipShareCents, st.tipCents, amount))
    const rest = amount - refundTip
    const nonTip = saleTotal - st.tipCents
    const shareOfRest = (part: number) => (nonTip > 0 ? Math.round((part * rest) / nonTip) : 0)
    refundBillDiscount = shareOfRest(saleBillDiscount)
    // The bill discount pays for part of the tax / fee (F-RV-1), so the cap is
    // what is left of the refund once the bill discount is added back.
    const room = rest + refundBillDiscount
    refundTax = Math.min(room, shareOfRest(st.taxCents))
    refundService = Math.min(room - refundTax, shareOfRest(st.serviceChargeCents))
    refundFee = Math.min(room - refundTax - refundService, shareOfRest(saleFee))
  }
  // Never more than the amount (rounding on a tiny refund): the fee, then the
  // service charge, give way first, so the parts still add up exactly.
  let over = refundTax + refundTip + refundService + refundFee - refundBillDiscount - amount
  if (over > 0) { const d = Math.min(over, refundFee); refundFee -= d; over -= d }
  if (over > 0) { const d = Math.min(over, refundService); refundService -= d; over -= d }
  if (over > 0) { const d = Math.min(over, refundTip); refundTip -= d; over -= d }
  if (over > 0) { const d = Math.min(over, refundTax); refundTax -= d; over -= d }
  if (over > 0) refundBillDiscount += over // never reached: the parts above are already 0
  let returned = amount - refundTax - refundTip - refundService - refundFee + refundBillDiscount
  if (saleTaxable === 0 && saleTotal > 0 && returned !== 0) {
    // A sale with no taxable value left (all of the food discounted) has no
    // line value to return: a rounding cent goes to the bill discount / tax.
    if (returned > 0) {
      const d = Math.min(returned, refundBillDiscount)
      refundBillDiscount -= d
      refundTax += returned - d
    } else {
      const d = Math.min(-returned, refundTax)
      refundTax -= d
      refundBillDiscount += -returned - d
    }
    returned = 0
  }

  // An exact void goes back on its own line when the sale lists it; else on
  // the sale's lines other than the delivery charge (all of them only if
  // nothing else carries value). Any other refund: pro rata over every line.
  const voidIdx = voidExact && vs!.lineId ? sale.lines.findIndex((l) => l.lineId === vs!.lineId) : -1
  const notFee = (w: number[]): number[] => {
    const m = w.map((x, i) => (isDeliveryChargeLine(sale.lines[i]!) ? 0 : x))
    return m.some((x) => x > 0) ? m : w
  }
  const pick = voidExact ? notFee : (w: number[]) => w
  let lineValues: number[]
  let lineTax: number[]
  if (voidIdx >= 0) {
    lineValues = sale.lines.map((_, i) => (i === voidIdx ? returned : 0))
    lineTax = sale.lines.map((_, i) => (i === voidIdx ? refundTax : 0))
  } else {
    lineValues = allocateTaxCents(pick(sale.lines.map((l) => l.taxableCents)), returned)
    // Tax by returned value × rate; with no value returned (a fully discounted
    // sale) by the sale's own line tax.
    const refundTaxWeights = sale.lines.map((l, i) => lineValues[i]! * l.taxRatePct)
    lineTax = allocateTaxCents(
      refundTaxWeights.some((w) => w > 0) ? refundTaxWeights : pick(sale.lines.map((l) => l.taxCents)),
      refundTax,
    )
  }
  const lines: FiscalLine[] = sale.lines.flatMap((l, i) => {
    const v = lineValues[i]!
    const t = lineTax[i]!
    if (v === 0 && t === 0) return []
    return [{
      lineId: l.lineId, itemCode: l.itemCode, description: l.description, quantity: l.quantity,
      unitPriceCents: l.quantity > 0 ? Math.round(v / l.quantity) : v,
      grossCents: v, discountCents: 0, taxableCents: v, taxRatePct: l.taxRatePct, taxCents: t,
    }]
  })
  const taxable = lines.reduce((s, l) => s + l.taxableCents, 0)

  const refundTotals: FiscalTotals = {
    saleValueCents: taxable,
    discountCents: 0,
    taxableCents: taxable,
    taxCents: refundTax,
    taxRatePct: st.taxRatePct,
    serviceChargeCents: refundService,
    tipCents: refundTip,
    // Only when the sale carries the field (a sale built before ONL-R2-02 has none).
    ...(st.deliveryChargeCents !== undefined && { deliveryChargeCents: refundFee }),
    ...(refundBillDiscount > 0 && { billDiscountCents: refundBillDiscount }),
    totalCents: amount,
  }
  const method = opts.method ?? defaultRefundMethod(sale)
  return {
    version: 1,
    documentId: opts.documentId,
    kind: 'refund',
    orderId: sale.orderId,
    orderRef: sale.orderRef,
    source: sale.source,
    issuedAt: isoPkt(opts.issuedAt),
    currency: 'PKR',
    registrations: sale.registrations,
    seller: sale.seller,
    buyer: sale.buyer,
    lines,
    totals: refundTotals,
    payment: { mode: paymentModeOf([method]), tenders: amount > 0 ? [{ method, amountCents: amount }] : [] },
    ...(sale.servdInvoiceNumber && { servdInvoiceNumber: sale.servdInvoiceNumber }),
    ...(opts.original && { original: opts.original }),
    refundAmountCents: amount,
    ...(opts.reason && { reason: opts.reason.slice(0, 300) }),
  }
}

// ─── Reference mappings onto the authorities' own invoices (ported) ───────────

const toPkr = (cents: number) => parseFloat((cents / 100).toFixed(2))
const round2 = (n: number) => parseFloat(n.toFixed(2))

function pktParts(iso: string) {
  const d = new Date(iso)
  const p = new Date(d.getTime() + 5 * 3_600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    y: p.getUTCFullYear(), mo: pad(p.getUTCMonth() + 1), d: pad(p.getUTCDate()),
    h: pad(p.getUTCHours()), mi: pad(p.getUTCMinutes()), s: pad(p.getUTCSeconds()),
  }
}

/** SRB "POS Invoice Payload Specification" v1 figures for this document (credentials excluded). */
export function toSrbInvoiceFields(p: FiscalPayload) {
  const reg = p.registrations.find((r) => r.authority === 'srb')
  const t = pktParts(p.issuedAt)
  const rateValue = Math.round(p.totals.taxRatePct)
  const saleValue = toPkr(p.kind === 'refund' ? p.totals.taxableCents : p.totals.saleValueCents)
  const taxAmount = round2(saleValue * (rateValue / 100)) // SRB spec: tax on the pre-discount value
  // A bill discount (F-RV-1) is discount too: net = sale value + tax − all of it.
  const discountAmount = toPkr(p.totals.discountCents + (totalsOf(p).billDiscountCents ?? 0))
  const tenders = p.payment.tenders.map((x) => x.method).filter((m) => m !== 'comp')
  const na = (v: string | undefined | null) => (v && v.trim() ? v.trim() : 'N/A')
  return {
    posId: reg ? Number(reg.posId) : null,
    name: p.seller.legalName,
    ntn: p.seller.ntn ?? '',
    invoiceDateTime: `${t.y}-${t.mo}-${t.d} ${t.h}:${t.mi}:${t.s}`,
    invoiceType: p.kind === 'refund' ? 2 : 1,
    invoiceId: p.kind === 'refund'
      ? `SRBRET-${p.orderId.slice(-10).toUpperCase()}-${p.documentId.slice(-6).toUpperCase()}`
      : `SRB-${p.orderId.slice(-12).toUpperCase()}`,
    rateValue,
    saleValue,
    taxAmount,
    discountAmount,
    netAmount: round2(saleValue + taxAmount - discountAmount),
    // SRB has two modes: Cash only when every tender is cash or on account
    // (an on-account bill is the cash class, H14); card, Raast QR, the wallet
    // and any other mix are 'Card'.
    modeOfPay: tenders.length > 0 && tenders.every((m) => m === 'cash' || m === 'on_account') ? 'Cash' : 'Card',
    consumerName: na(p.buyer?.legalName),
    consumerNTN: na(p.buyer?.ntn ?? p.buyer?.cnic),
    cpcCode: 'N/A',
  }
}

/** QR bank transfers in FBR's PaymentMode 3: Raast QR, and the retired Keenu QR's old sales. */
const RAAST_OR_QR = new Set(['raast', 'keenu_qr'])

/** FBR PRAL POS invoice figures for this document (token / credentials excluded). */
export function toFbrInvoiceFields(p: FiscalPayload) {
  const reg = p.registrations.find((r) => r.authority === 'fbr')
  const t = pktParts(p.issuedAt)
  const methods = p.payment.tenders.map((x) => x.method)
  return {
    InvoiceNumber: p.servdInvoiceNumber ?? `INV-${p.orderId.slice(-10).toUpperCase()}`,
    POSID: reg ? Number(reg.posId) : null,
    USIN: p.orderId,
    DateTime: `${t.d}${t.mo}${t.y}${t.h}${t.mi}${t.s}`,
    BuyerNTN: p.buyer?.ntn ?? '',
    BuyerCNIC: p.buyer?.cnic ?? '',
    BuyerName: p.buyer?.legalName ?? '',
    TotalBillAmount: toPkr(p.totals.totalCents),
    TotalQuantity: p.lines.reduce((s, l) => s + l.quantity, 0),
    // Never negative: a bill discount (F-RV-1) can leave less than the tax.
    TotalSaleValue: toPkr(Math.max(0, p.totals.totalCents - p.totals.taxCents)),
    TotalTaxCharged: toPkr(p.totals.taxCents),
    Discount: toPkr(p.totals.discountCents + (totalsOf(p).billDiscountCents ?? 0)),
    FurtherTax: 0,
    // 1 card, 2 cash, 3 wallet/QR. Any cash or on-account (the cash class,
    // H14) → 2; else a QR bank transfer (Raast QR, or the retired Keenu QR on
    // old sales) → 3; else 1. Raast as 3 and on-account as 2 are servd's
    // default reading of PRAL's modes — to be confirmed with the fiscal POS
    // vendor (docs/pos-connector-api.md §5).
    PaymentMode: methods.includes('cash') || methods.includes('on_account') ? 2 : methods.some((m) => RAAST_OR_QR.has(m)) ? 3 : 1,
    InvoiceType: p.kind === 'refund' ? 3 : 1, // 3 = credit note
    Items: p.lines.map((l) => ({
      // The delivery charge (H9) is its own item; every menu line is POS-ITEM.
      ItemCode: l.itemCode === DELIVERY_CHARGE_ITEM_CODE ? 'DELIVERY' : 'POS-ITEM',
      ItemName: l.description.slice(0, 100),
      Quantity: l.quantity,
      PCTCode: '9963.1100', // HS code for restaurant food service
      TaxRate: l.taxRatePct,
      SaleValue: toPkr(l.taxableCents),
      Discount: toPkr(l.discountCents),
      FurtherTax: 0,
      TaxCharged: toPkr(l.taxCents),
      TotalAmount: toPkr(l.taxableCents + l.taxCents),
      InvoiceType: p.kind === 'refund' ? 3 : 1,
      RefUSIN: p.kind === 'refund' ? (p.original?.fiscalNumber ?? '') : '',
    })),
  }
}
