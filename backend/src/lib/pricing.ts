// Order pricing — THE one place an order's GST, service charge and total are
// worked out.
//
// Every channel used to price its own way: the till charged taxRateCash on the
// pre-discount base (always, because the tender was never sent), the
// storefront always charged taxRateCard (even for cash on delivery, while its
// checkout page showed 15%), group orders charged the cash rate while their
// page showed the legacy 17%, the receipt, FBR and SRB builders each
// recomputed tax their own way, and item tax classes were never applied. Now:
//
//   priceOrder(lines, tender, channel, concept)  ← ingestOrder callers (till,
//     storefront checkout + GET /storefront/quote, group orders), and the till
//     re-price at payment (decision 9)
//   Order.taxCents / Order.taxRatePct             ← what every document reads
//     (receipt, tax invoice, FBR, SRB) — never a recomputation
//
// Rules (owner decision 9, CEO/SRB policy):
//   - GST is split by tender: cash → Concept.taxRateCash (15%), card / Raast
//     QR / paid online (the digital group, Tender 'card') →
//     Concept.taxRateCard (8%). Cash on delivery is cash. A group
//     order takes the rate of the tender used at the till. A tender we cannot
//     classify (split, not yet chosen) takes the cash rate — the customer is
//     never billed less than they owe. Concept.taxRate (legacy 17%) is never
//     read.
//   - GST is charged on the PRE-discount item value (SRB POS rule): a discount
//     comes off the tax-inclusive total, it does not shrink the tax base.
//   - Item tax classes apply per line: zero-rated and exempt lines carry no
//     GST, a 'custom' line uses its own override rate, standard lines the
//     tender rate. Tax is rounded once per rate group, so an all-standard
//     order's tax is exactly round(itemTotal × rate).
//   - Service charge (when the company's ops config enables it for the
//     channel) sits on food + GST − discount. Never on the delivery fee, its
//     GST or the tip.
//   - Delivery fee: GST added on top at the tender rate (owner 2026-10-13,
//     H9); never in the service-charge or tip base. The zone fee is the fee
//     BEFORE GST; its GST is the order's STANDARD tender rate (15 % cash, 8 %
//     card / Raast / online / wallet) — never an item tax class, so a
//     zero-rated basket still pays GST on the delivery — rounded on its own:
//     deliveryFeeTaxCents = round(fee × rate / 100). Order.taxCents = GST on
//     the food (itemTaxCents) + GST on the fee (deliveryFeeTaxCents); both
//     parts are stored on the order (Order.deliveryFeeCents /
//     deliveryFeeTaxCents, written by ingestOrder from this price).
//   - Total = food + food GST − discount + delivery fee + delivery GST +
//     service charge. Customer credits (promo, points, wallet, gift card) and
//     the tip are applied by the caller on top of this figure.

import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { AppError } from './errors.js'
import { computeServiceCharge, computeDeliveryFee } from './setup-config.js'
import { haversineKm } from './geo.js'

/**
 * The tax-relevant class of a tender: which of the two GST rates applies.
 * 'card' IS the digital tax group — card (Card – Keenu), Raast QR (an instant
 * bank transfer, owner 2026-10-12) and every online gateway — billed at
 * Concept.taxRateCard. The name stays 'card' (PreBill.tender, the fiscal
 * payment mode and the pre-bill's two totals read it); screens say
 * "Card / Raast".
 */
export type Tender = 'cash' | 'card'

/**
 * The channel an order is priced for — decides whether the company's service
 * charge applies (ops config `serviceChargeAppliesToChannels`: pos /
 * storefront / whatsapp). A group order is one table's bill settled at the
 * till, so it is charged like a till sale.
 */
export type PricingChannel = 'pos' | 'storefront' | 'group' | 'whatsapp'

const SERVICE_CHARGE_CHANNEL: Record<PricingChannel, string> = {
  pos: 'pos',
  storefront: 'storefront',
  group: 'pos',
  whatsapp: 'whatsapp',
}

// The digital tax group ('card'): card, Raast QR, the retired Keenu QR (kept
// so old rows still read at the rate they were billed) and every online
// gateway (Keenu, JazzCash, EasyPaisa, the servd wallet) → the card rate.
const CARD_TENDERS = new Set(['card', 'raast', 'keenu_qr', 'keenu', 'jazzcash', 'easypaisa', 'wallet', 'online'])

/**
 * Map a payment method / gateway name to its tax tender. 'cash' (till cash,
 * cash on delivery) is cash; card, Raast QR and online gateways are the
 * digital group ('card'); anything else — 'split', 'comp', a tender not
 * chosen yet — takes the cash rate.
 *
 * 'on_account' (a named corporate client's bill, lib/tenders
 * ON_ACCOUNT_TENDER) is the CASH class by the owner / accountant default
 * (2026-10-13): tenderOf('on_account') === 'cash'. Never add it to
 * CARD_TENDERS without the CA's answer.
 */
export function tenderOf(method: string | null | undefined): Tender {
  if (method && CARD_TENDERS.has(method)) return 'card'
  return 'cash'
}

/**
 * The tender a set of payments settles under. All card-class → card; any
 * cash, or a mix → cash (the conservative rate). No payments → cash.
 */
export function tenderOfPayments(methods: Array<string | null | undefined>): Tender {
  if (methods.length === 0) return 'cash'
  return methods.every((m) => tenderOf(m) === 'card') ? 'card' : 'cash'
}

export interface PricingConcept {
  id: string
  tenantId: string | null
  taxRateCash: number
  taxRateCard: number
}

/** The standard GST rate (%) for a tender at a brand. */
export function gstRatePct(concept: Pick<PricingConcept, 'taxRateCash' | 'taxRateCard'>, tender: Tender): number {
  return tender === 'card' ? concept.taxRateCard : concept.taxRateCash
}

type TaxClass = 'standard' | 'zero_rated' | 'exempt' | 'custom'

/** The GST rate (%) of one line, given its item's tax class and the tender's standard rate. */
export function lineTaxRatePct(
  item: { taxClassification?: TaxClass | string | null; overrideTaxRate?: number | null } | null | undefined,
  standardRatePct: number,
): number {
  switch (item?.taxClassification) {
    case 'zero_rated':
    case 'exempt':
      return 0
    case 'custom':
      return item.overrideTaxRate ?? 0
    default:
      return standardRatePct
  }
}

export interface PriceLineInput {
  menuItemId?: string | null
  unitPriceCents: number
  quantity: number
  modifiers?: Array<{ priceDeltaCents: number }>
}

export interface PricedLine {
  lineCents: number
  taxRatePct: number
}

export interface OrderPrice {
  tender: Tender
  channel: PricingChannel
  /** The tender's standard rate — stored on Order.taxRatePct. */
  taxRatePct: number
  /** Food: Σ (unit + modifiers) × qty, pre-discount. */
  itemTotalCents: number
  discountCents: number
  /** GST on the food lines (item tax classes, one rounding per rate group). */
  itemTaxCents: number
  /** The delivery fee BEFORE GST (the zone's fee; 0 for pickup / dine-in / the till). */
  deliveryFeeCents: number
  /** GST on the delivery fee at the tender's standard rate: fee > 0 ? round(fee × taxRatePct / 100) : 0. */
  deliveryFeeTaxCents: number
  /** itemTaxCents + deliveryFeeTaxCents — what Order.taxCents stores. */
  taxCents: number
  serviceChargeCents: number
  /** food + food GST − discount + delivery fee + delivery GST + service charge. */
  totalCents: number
  lines: PricedLine[]
}

export interface PriceOptions {
  /** Staff discount at the till (not a promo — promos are applied by the caller). */
  discountCents?: number
  /** The delivery fee BEFORE GST (the zone's fee). Its GST is added on top (H9). */
  deliveryFeeCents?: number
  /** Read item tax classes inside the caller's transaction. */
  db?: Prisma.TransactionClient
}

export function lineCents(line: PriceLineInput): number {
  const mods = (line.modifiers ?? []).reduce((s, m) => s + m.priceDeltaCents, 0)
  return (line.unitPriceCents + mods) * line.quantity
}

/** GST on priced lines: one rounding per rate group. */
function taxOnLines(lines: PricedLine[]): number {
  const byRate = new Map<number, number>()
  for (const l of lines) byRate.set(l.taxRatePct, (byRate.get(l.taxRatePct) ?? 0) + l.lineCents)
  let tax = 0
  for (const [rate, cents] of byRate) {
    if (rate > 0) tax += Math.round((cents * rate) / 100)
  }
  return tax
}

/** THE order pricing function. See the header for the rules. */
export async function priceOrder(
  lines: PriceLineInput[],
  tender: Tender,
  channel: PricingChannel,
  concept: PricingConcept,
  opts: PriceOptions = {},
): Promise<OrderPrice> {
  const db = opts.db ?? prisma
  const standard = gstRatePct(concept, tender)

  const ids = [...new Set(lines.map((l) => l.menuItemId).filter((x): x is string => !!x))]
  const classes = ids.length > 0
    ? await db.menuItem.findMany({
        where: { id: { in: ids } },
        select: { id: true, taxClassification: true, overrideTaxRate: true },
      })
    : []
  const classOf = new Map(classes.map((c) => [c.id, c]))

  const priced: PricedLine[] = lines.map((l) => ({
    lineCents: lineCents(l),
    taxRatePct: lineTaxRatePct(l.menuItemId ? classOf.get(l.menuItemId) : null, standard),
  }))
  const itemTotalCents = priced.reduce((s, l) => s + l.lineCents, 0)
  const itemTaxCents = taxOnLines(priced)
  // A staff discount comes off the food and its GST — never the delivery.
  const discountCents = Math.max(0, Math.min(opts.discountCents ?? 0, itemTotalCents + itemTaxCents))
  const deliveryFeeCents = Math.max(0, opts.deliveryFeeCents ?? 0)
  // GST on the delivery, at the tender's STANDARD rate (H9) — never an item
  // class — and rounded on its own.
  const deliveryFeeTaxCents = deliveryFeeCents > 0 ? Math.round((deliveryFeeCents * standard) / 100) : 0
  // The service-charge base: food + food GST − discount (never the fee or its GST).
  const netCents = itemTotalCents + itemTaxCents - discountCents
  const serviceChargeCents = await computeServiceCharge(netCents, SERVICE_CHARGE_CHANNEL[channel], concept.tenantId)

  return {
    tender,
    channel,
    taxRatePct: standard,
    itemTotalCents,
    discountCents,
    itemTaxCents,
    deliveryFeeCents,
    deliveryFeeTaxCents,
    taxCents: itemTaxCents + deliveryFeeTaxCents,
    serviceChargeCents,
    totalCents: netCents + deliveryFeeCents + deliveryFeeTaxCents + serviceChargeCents,
    lines: priced,
  }
}

/**
 * The delivery fee for a drop point — the one zone lookup the storefront
 * checkout and its quote share. Coordinates are required (no coordinates used
 * to mean free delivery with no minimum), the kitchen must have a location,
 * the drop point must be inside a zone (decision 19) and the food must meet
 * the zone's minimum.
 */
export async function deliveryFeeFor(
  concept: { id: string; latitude: number | null; longitude: number | null },
  itemTotalCents: number,
  lat: number | null | undefined,
  lng: number | null | undefined,
): Promise<{ feeCents: number; zoneId: string | null; zoneName: string | null }> {
  if (lat == null || lng == null) {
    throw new AppError(
      'DELIVERY_LOCATION_REQUIRED',
      'We need your delivery location to work out the fee and send a rider. Please pick your address on the map.',
      400,
    )
  }
  if (concept.latitude == null || concept.longitude == null) {
    throw new AppError(
      'DELIVERY_UNAVAILABLE',
      "This kitchen hasn't set its location yet, so we can't quote delivery. Please choose pickup.",
      409,
    )
  }
  const distKm = haversineKm(concept.latitude, concept.longitude, lat, lng)
  const zone = await computeDeliveryFee(itemTotalCents, distKm, concept.id)
  if (zone.zoneId && !zone.meetsMinimum) {
    throw new AppError('BELOW_ZONE_MINIMUM', `Order does not meet the delivery minimum for ${zone.zoneName}`, 400)
  }
  return { feeCents: zone.feeCents, zoneId: zone.zoneId, zoneName: zone.zoneName }
}

/**
 * Split a stored tax amount across document lines (FBR wants tax per line)
 * in proportion to each line's taxable weight, largest remainder first, so
 * the lines always sum to exactly the tax the order was charged.
 */
export function allocateTaxCents(weights: number[], taxCents: number): number[] {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0)
  if (total <= 0 || taxCents === 0) return weights.map(() => 0)
  const raw = weights.map((w) => (Math.max(0, w) * taxCents) / total)
  const out = raw.map((r) => Math.floor(r))
  let left = taxCents - out.reduce((s, x) => s + x, 0)
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac)
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k]!.i]! += 1
  return out
}
