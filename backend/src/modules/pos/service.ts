import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { ingestOrder } from '../orders/service.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import { getRefundPolicy, getOperationsConfig } from '../../lib/setup-config.js'
import { audit } from '../../lib/audit.js'
import { sendEmail } from '../../lib/notify.js'
import { flagException } from '../../lib/exceptions.js'
import { emitItemUpdated } from '../../lib/ws.js'
import { priceOrder, tenderOf, tenderOfPayments, gstRatePct, type OrderPrice, type PricingChannel, type Tender } from '../../lib/pricing.js'
import { drawerExpectation, drawerExpectationOf, drawerVariance, cashVarianceLimitCents, isDrawerBalanced } from '../../lib/drawer.js'
import { shiftTenantId, assertShiftOf, shiftOfCompany } from '../../lib/tenantScope.js'
import { SHIFT_SALE_PAYMENT_INCLUDE, summariseShiftSales, TENDER_ROUNDING_CENTS } from '../accounting/shiftPosting.js'
import {
  postRefundPayment, refundDueCents, isShiftReceipt, refundCreditAccount, refundTaxAccountFor, giftCardAppliedOf,
  GIFT_CARD_LIABILITY, OUTPUT_TAX_ACCOUNTS, REFUND_DUE_PREFIX,
} from '../accounting/orderPosting.js'
import { postJournalEntry, ACCT, revenueCodeForConcept, type JournalLineInput } from '../accounting/journal.js'
import { PAYOUT_CATEGORIES, type PayoutCategory } from '../accounting/expenseCategories.js'
import { cogsForSoldLines, consumptionForSoldLines } from '../../lib/recipeCost.js'
import { wasteVoidedFiredLineTx } from '../inventory/voidWaste.js'
import { MANAGERS } from '../auth/middleware.js'
import type { OrderDTO } from '@servd/types'
import type { Order, Payment, PaymentGateway, PaymentMethod, Prisma, TerminalChargeStatus } from '@prisma/client'
// Manager-override PIN: the ONE verifier (company-scoped, active accounts,
// owner-decision-7 approvers) and the approver tier that rings at manager caps.
import { verifyManagerPin } from '../auth/managerPin.js'
import { isOverrideApprover } from '../../lib/roles.js'
// POS connector (spec §6, §7): the fiscal outbox for refunds, the sale's
// fiscal view for the till, and the card-machine active-charge guard.
import { assertNoActiveTerminalChargeTx } from '../../connectors/terminal/guard.js'
import { getConnector, terminalDriverOf } from '../../connectors/registry.js'
import { enqueueFiscalRefundTx, kickFiscal } from '../../connectors/fiscal/outbox.js'
import { fiscalViewForOrder, legacySrbAlias, type FiscalView } from '../../connectors/fiscal/view.js'

// ─── Company scoping ──────────────────────────────────────────────────────────
//
// The singleton config tables hold one global row PER COMPANY. Every policy
// the till reads (discount caps, service charge, refund / void / comp caps,
// drawer-variance limit) goes through the shared readers in
// lib/setup-config.ts with the order's / shift's own company — never a local
// copy of the query.

// Only approvers of `tenantId` (primary company or a membership) may approve
// an override at its tills — a PIN belonging to the other company's manager
// must never unlock a discount, void, comp or refund here. Enforced inside
// verifyManagerPin (auth/managerPin.ts).

// ─── POS order creation ───────────────────────────────────────────────────────

export interface PosOrderInput {
  conceptId: string
  tableId?: string | null
  customerId?: string | null
  staffId: string
  staffRole?: string                                  // for discount + price-override role gates
  managerOverridePin?: string                         // required when discount/price-override exceeds cashier cap
  shiftId?: string | null
  items: Array<{
    menuItemId: string | null
    name: string
    quantity: number
    unitPriceCents: number
    notes?: string
    course?: number
    modifiers: Array<{ name: string; priceDeltaCents: number; modifierId?: string }>
  }>
  discountCents?: number
  discountReason?: string
  // Stable client key for idempotent order creation (double-tap / offline resend
  // dedupe). Used as the order's external_id.
  idempotencyKey?: string
  // CEO policy: GST splits by tender. Cashier picks the intended payment
  // method when ringing up so the bill on the receipt matches what gets
  // collected. 'cash' → taxRateCash (default 15%); anything else →
  // taxRateCard (default 8%). Defaults to 'cash' if not specified.
  paymentMethod?: 'cash' | 'card' | 'keenu_qr' | 'split' | 'comp'
}

type PosLine = PosOrderInput['items'][number]

/**
 * FOH-08: what an add-on costs comes from the menu, never from the till. A
 * modifier with a modifierId must be an option of THAT line's menu item (one
 * of its live modifier groups) and is charged at its menu price and name,
 * whatever the client sent — a cashier sold a PKR 1,450 Nihari for PKR 57.50
 * with an add-on "priced" at −1,400. A free-text add-on (no modifierId: "no
 * onions", "extra sauce +50") may only ADD to the price; anything that lowers
 * a bill is a discount or a price override, which carry their caps, PIN and
 * flag. (The storefront resolves its basket the same way — storefront/routes
 * resolveCheckoutItems.)
 */
export async function resolvePosLines(items: PosLine[]): Promise<PosLine[]> {
  const modIds = [...new Set(items.flatMap((i) => i.modifiers.map((m) => m.modifierId).filter((x): x is string => !!x)))]
  const mods = modIds.length > 0
    ? await prisma.modifier.findMany({
        where: { id: { in: modIds }, deletedAt: null, group: { deletedAt: null } },
        select: { id: true, name: true, priceDeltaCents: true, group: { select: { menuItemId: true } } },
      })
    : []
  const byId = new Map(mods.map((m) => [m.id, m]))
  return items.map((line) => ({
    ...line,
    modifiers: line.modifiers.map((m) => {
      if (m.modifierId) {
        const menu = byId.get(m.modifierId)
        if (!menu || !line.menuItemId || menu.group.menuItemId !== line.menuItemId) {
          throw new AppError('INVALID_MODIFIER', `"${m.name}" is not an add-on of ${line.name}`, 422)
        }
        return { modifierId: menu.id, name: menu.name, priceDeltaCents: menu.priceDeltaCents }
      }
      if (m.priceDeltaCents < 0) {
        throw new AppError('NEGATIVE_MODIFIER', `An add-on cannot lower the price ("${m.name}") — use a discount (caps and manager PIN apply)`, 422)
      }
      return { name: m.name, priceDeltaCents: m.priceDeltaCents }
    }),
  }))
}

/**
 * POST /pos/quote — what a ring-up WOULD be billed, through the same line
 * resolution and THE pricing function createPosOrder uses. Writes nothing.
 */
export async function quotePosOrder(input: {
  conceptId: string
  items: PosLine[]
  discountCents?: number
  paymentMethod?: PosOrderInput['paymentMethod']
}) {
  const concept = await prisma.concept.findUnique({ where: { id: input.conceptId } })
  if (!concept) throw new NotFoundError('Concept', input.conceptId)
  const items = await resolvePosLines(input.items)
  const price = await priceOrder(items, tenderOf(input.paymentMethod), 'pos', concept, { discountCents: input.discountCents ?? 0 })
  // THE priceOrder result (tender, taxRatePct, itemTotalCents, discountCents,
  // taxCents, serviceChargeCents, totalCents, lines…), plus the lines as the
  // server prices them (add-ons at menu price).
  return {
    conceptId: concept.id,
    ...price,
    items: items.map((i) => ({ menuItemId: i.menuItemId, name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents, modifiers: i.modifiers })),
  }
}

export async function createPosOrder(input: PosOrderInput) {
  // Idempotency: a double-tapped "complete & fire" or an offline-queue resend
  // carries the SAME idempotencyKey. If we've already created that order, return
  // it untouched — no second ticket, no re-flagging, no duplicate charge.
  // FOH-07: only to the brand it was rung for. The key is global (orders are
  // unique on source + externalId), so a key reused by another brand — another
  // company's till — is a 409, never that company's order.
  if (input.idempotencyKey) {
    const existing = await prisma.order.findUnique({
      where: { source_externalId: { source: 'pos', externalId: input.idempotencyKey } },
      include: RING_UP_INCLUDE,
    })
    if (existing) {
      // The same request = same brand and same till operator (the rule
      // ingestOrder applies to its own dedupe, orders/service assertSameRequest).
      if (existing.conceptId !== input.conceptId || (existing.posStaffId ?? null) !== input.staffId) throw idempotencyKeyReused()
      return existing
    }
  }

  // FOH-22: an unknown customer is the caller's mistake (422), not a 500 from
  // the foreign key halfway through the insert.
  if (input.customerId) {
    const customer = await prisma.customer.findFirst({ where: { id: input.customerId, deletedAt: null }, select: { id: true } })
    if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'That customer does not exist', 422)
  }

  // FOH-08: add-ons at their menu price (see resolvePosLines).
  input = { ...input, items: await resolvePosLines(input.items) }

  // Calculate total
  const itemTotal = input.items.reduce((sum, item) => {
    const modTotal = item.modifiers.reduce((ms, m) => ms + m.priceDeltaCents, 0)
    return sum + (item.unitPriceCents + modTotal) * item.quantity
  }, 0)

  const discount = input.discountCents ?? 0
  const concept = await prisma.concept.findUnique({ where: { id: input.conceptId } })
  if (!concept) throw new NotFoundError('Concept', input.conceptId)
  // Every policy read below (discount caps, service charge, manager PINs) is
  // resolved for the brand's own company.
  const tenantId = concept.tenantId
  const ops = await getOperationsConfig(tenantId)

  // Owner-review flags raised by the gates below, written once the order
  // exists (they carry its id).
  const pendingFlags: Array<Omit<Parameters<typeof flagException>[0], 'entityType' | 'entityId'>> = []

  // ── Discount + price-override role gates ─────────────────────────────────
  // Prevents cashiers giving 100%-off to friends. Above policy thresholds the
  // request must include a manager PIN, which we re-verify at submission time
  // (not just session — a cashier can't escalate by hijacking a manager
  // session that walked away from the till).
  if (discount > 0 || hasPriceOverride(input)) {
    const cashierDiscountCap = ops?.cashierDiscountPctCap ?? 0.10
    const managerDiscountCap = ops?.managerDiscountPctCap ?? 0.50
    const cashierPriceOverrideCap = ops?.cashierPriceOverrideCap ?? 0
    const role = input.staffRole ?? 'cashier'

    // Discount %
    const discountPct = itemTotal > 0 ? discount / itemTotal : 0
    const cap = isOverrideApprover(role) ? managerDiscountCap : cashierDiscountCap
    if (discountPct > cap) {
      const approved = await verifyManagerPin(input.managerOverridePin, tenantId, undefined, { actorId: input.staffId, action: 'discount' })
      // FOH-R2-03: a PIN that was sent and is wrong (or another company's) is
      // a wrong PIN — not "PIN required".
      if (!approved && input.managerOverridePin?.trim()) throw invalidManagerPin()
      if (!approved) {
        throw new AppError(
          'DISCOUNT_OVER_CAP',
          `Discount of ${(discountPct * 100).toFixed(0)}% exceeds the ${(cap * 100).toFixed(0)}% cap for ${role}. Manager PIN required.`,
          403,
        )
      }
      if (discountPct > managerDiscountCap && approved.role !== 'admin') {
        throw new AppError('DISCOUNT_OVER_MANAGER_CAP', `Discount over ${(managerDiscountCap * 100).toFixed(0)}% requires admin.`, 403)
      }
    }

    // Price override on line items
    const overrides = await detectPriceOverrides(input)
    if (overrides.length > 0) {
      const totalOverride = overrides.reduce((s, o) => s + o.deltaCents, 0)
      // The size of the override is how far the lines move from the menu in
      // EITHER direction. The gate used to compare the signed sum, so pricing
      // a dish BELOW the menu (a negative delta) never needed a PIN — and it
      // only applied to role 'cashier', so the waiter role skipped it.
      const overrideMagnitude = overrides.reduce((s, o) => s + Math.abs(o.deltaCents), 0)
      if (!isOverrideApprover(role) && overrideMagnitude > cashierPriceOverrideCap) {
        const approved = await verifyManagerPin(input.managerOverridePin, tenantId, undefined, { actorId: input.staffId, action: 'price_override' })
        if (!approved && input.managerOverridePin?.trim()) throw invalidManagerPin()
        if (!approved) {
          throw new AppError(
            'PRICE_OVERRIDE_BLOCKED',
            `Price override on ${overrides.length} item(s) requires manager PIN. Total delta: PKR ${(totalOverride / 100).toFixed(0)}.`,
            403,
          )
        }
      }
      // Always flag price overrides for owner review (even when authorized) —
      // once the order exists, so the flag points at it.
      pendingFlags.push({
        tenantId,
        kind: 'price_override',
        severity: overrideMagnitude > 50000 ? 'high' : 'medium',
        title: `Price override on POS order`,
        description: `${overrides.length} item(s) priced differently from menu. Total delta: PKR ${(totalOverride / 100).toFixed(0)}. Reason: ${input.discountReason ?? 'no reason given'}.`,
        conceptId: input.conceptId,
        actorId: input.staffId,
        amountCents: overrideMagnitude,
        metadata: { overrides, role, conceptId: input.conceptId },
      })
    }

    // Always flag big discounts for review even when authorized — after the
    // order is created, so the flag carries its id. FOH-R2-03: a discount is
    // not a void (nor a comp) — it has its own kind.
    if (discountPct > cashierDiscountCap) {
      pendingFlags.push({
        tenantId,
        kind: 'discount_above_cap',
        severity: discountPct > managerDiscountCap ? 'high' : 'medium',
        title: `${(discountPct * 100).toFixed(0)}% discount on POS order`,
        description: `Cashier ${input.staffId} applied a ${(discountPct * 100).toFixed(0)}% discount (PKR ${(discount / 100).toFixed(0)} on PKR ${(itemTotal / 100).toFixed(0)} subtotal). Reason: ${input.discountReason ?? 'none given'}.`,
        conceptId: input.conceptId,
        actorId: input.staffId,
        amountCents: discount,
        metadata: { realKind: 'discount_above_cap', discountPct, itemTotal, discount, role, reason: input.discountReason },
      })
    }
  }

  // THE order pricing (lib/pricing.ts): GST by the tender the cashier rang
  // it up under (cash 15% / card 8%, decision 9; not chosen → cash, so the
  // customer is never billed less than they owe), on the pre-discount base
  // (SRB POS rule), item tax classes applied, then the discount, then the
  // company's service charge for the till. If the customer ends up paying
  // with the other tender, processPayment re-prices before taking the money.
  const price = await priceOrder(input.items, tenderOf(input.paymentMethod), 'pos', concept, { discountCents: discount })
  const totalCents = price.totalCents

  const dto: OrderDTO = {
    source: 'pos',
    // FOH-06: a ring-up without a client key (the waiter screen) gets a key
    // that is unique — a UUID. It used to be `pos-${Date.now()}`, so two
    // tills ringing in the same millisecond collided on (source, externalId)
    // and the second caller was handed the FIRST order (another company's,
    // with its items and table) while its own items were dropped.
    external_id: input.idempotencyKey ?? `pos-${randomUUID()}`,
    concept_id: input.conceptId,
    placed_at: new Date().toISOString(),
    customer_id: input.customerId ?? null,
    customer_name: null,
    table_id: input.tableId ?? null,
    pos_staff_id: input.staffId,
    shift_id: input.shiftId ?? null,
    items: input.items.map((item) => ({
      externalItemId: item.menuItemId ?? 'pos-item',
      menuItemId: item.menuItemId,
      name: item.name,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      modifiers: item.modifiers.map((m) => ({ name: m.name, priceDeltaCents: m.priceDeltaCents })),
      notes: item.notes,
      course: item.course,
    })),
    payment: { provider: null, amountCents: totalCents, status: 'pending' },
    loyalty_points_earned: null,
    delivery_notes: null,
    estimated_pickup: null,
  }

  // The bill is written as the order is created (ingestOrder stamps GST, the
  // rate, the discount and the service charge from `price`), so the ticket
  // never fires with a bill the till then has to patch.
  const { order, created } = await ingestOrder(dto, { price })
  // Two concurrent ring-ups with one key race past the lookup above; the
  // loser gets the winner's order back from ingestOrder's unique-key dedupe.
  // That is only "the same ring-up" for the same brand.
  if (order.conceptId !== input.conceptId) throw idempotencyKeyReused()
  // FOH-R2-03: the discount / price-override alerts point at the order.
  // (A racing duplicate of the same ring-up got the first one's order back —
  // its flags were raised by that request.)
  if (created) for (const f of pendingFlags) await flagException({ ...f, entityType: 'Order', entityId: order.id })
  return prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    include: RING_UP_INCLUDE,
  })
}

/**
 * R2-UI-01: what a ring-up answers with — the order, its lines with add-ons,
 * and its payments (none yet on a fresh ticket). The admin till's payment
 * step reads `order.payments` straight from this response, on a fresh
 * ring-up and on an idempotent replay alike.
 */
const RING_UP_INCLUDE = {
  items: { include: { modifiers: true } },
  payments: { select: { id: true, method: true, amountCents: true, status: true } },
} satisfies Prisma.OrderInclude

// ─── POS payment processing ───────────────────────────────────────────────────

/** One tender of a till payment. */
export interface TillTenderInput {
  method: PaymentMethod
  /** What this tender takes — the bill's share PLUS any tip on it. */
  amountCents: number
  tenderedCents?: number  // for cash
  gatewayRef?: string     // for card
  gateway?: PaymentGateway
  /** FOH-14: the part of amountCents that is a tip (Order.tipCents → 2095 Tips Payable). */
  tipCents?: number
  // ── Card machine (spec §7). Set by the SERVER only (connectors/terminal) —
  //    the till route never accepts them from a client, except manualReason
  //    'terminal_offline' on a keyed slip reference.
  /** The TerminalCharge this tender records (persisted in gatewayMeta). */
  terminalChargeId?: string
  /** Why a card tender was keyed by hand while the card machine is connected. */
  manualReason?: 'unknown_outcome' | 'terminal_offline'
  authCode?: string | null
  cardBrand?: string | null
  cardLast4?: string | null
}

export interface ProcessPaymentInput {
  orderId: string
  shiftId: string
  payments: TillTenderInput[]
  /**
   * The card-machine charge this payment records (server only): the
   * active-charge guard lets exactly that charge through.
   */
  terminalChargeId?: string
  /**
   * FOH-04: stable client key for THIS payment submission (one per tap of
   * "Pay", reused by retries). Scoped to the order: a retry carrying a key
   * already taken on this order returns the first result instead of charging
   * again; the same key with different tenders is a 409.
   */
  idempotencyKey?: string
}

/** The largest amount a money column holds (Postgres INT4), in paisa — PKR 21.47 million. */
export const MAX_AMOUNT_CENTS = 2_147_483_647

/**
 * R2-UI-07: refuse an amount no money column can hold (a mistyped tender,
 * an extra zero or six) with 422 AMOUNT_TOO_LARGE, before anything is
 * written — the insert used to fail with a 500.
 */
export function assertAmountsFit(...amounts: Array<number | null | undefined>): void {
  for (const a of amounts) {
    if (a != null && Number.isFinite(a) && Math.abs(a) > MAX_AMOUNT_CENTS) {
      throw new AppError('AMOUNT_TOO_LARGE', `That amount (PKR ${(a / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}) is too large — check the figure you typed`, 422)
    }
  }
}

function invalidManagerPin(): AppError {
  return new AppError('INVALID_MANAGER_PIN', 'That PIN does not belong to an active manager of this company', 403)
}

function idempotencyKeyReused(): AppError {
  return new AppError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key belongs to a different request — generate a new one', 409)
}

/**
 * FOH-04/05: serialise everything that moves money on one order. Payments,
 * settles, comps, refunds, voids and splits each take this row lock first
 * and re-read the order's payments under it, so two cashiers (or a double
 * tap) can never both see "nothing paid yet". Same lock as the stock and
 * completion claims in orders/service (lockOrderForStock).
 */
export async function lockOrderTx(tx: Tx, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`
}

const ENDED: ReadonlySet<string> = new Set(['completed', 'refunded', 'cancelled', 'rejected'])

/** FOH-09: a ticket that was cancelled, rejected or refunded takes no money. */
function assertTakesMoney(status: string): void {
  if (status === 'cancelled' || status === 'rejected' || status === 'refunded') {
    throw new AppError('ORDER_NOT_OPEN', `This order is ${status} — it cannot take a payment`, 409)
  }
}

/**
 * FOH-15: money goes onto a drawer only by the cashier who owns it, or a
 * manager (as close and cash movements already required).
 */
export async function assertDrawerOperator(shiftId: string, actor: { id: string; role: string }): Promise<void> {
  if ((MANAGERS as readonly string[]).includes(actor.role)) return
  const shift = await prisma.shift.findUnique({ where: { id: shiftId }, select: { userId: true } })
  if (shift && shift.userId !== actor.id) {
    throw new AppError('NOT_YOUR_SHIFT', 'This is another cashier\'s drawer — only its own cashier or a manager can put money on it', 403)
  }
}


// Every tender taken at the till settles there and then. Cash is in the
// drawer; a card or Keenu QR tender carries the terminal's reference number
// (owner decision 4) — the terminal approved it, so it is money receivable
// from the processor (1030) from that moment, and the sale completes, files
// with the fiscal POS and reaches the drawer's close like a cash sale. If
// the processor later fails it, the Keenu webhook moves it to the customer's
// receivable (shiftPosting.ts postPosCardFailure). Card and QR tenders used to
// wait as 'pending' for a webhook that never matched them, so every card sale
// at the till sat in 'received' with no revenue record and no tax filing.
// A comp is NOT a tender: it goes through compOrder (caps, manager PIN, audit,
// owner notify). 'split' is not a tender either — it is the group-order
// placeholder that check-split replaces with the real tenders.
const TILL_TENDERS: ReadonlySet<PaymentMethod> = new Set(['cash', 'card', 'keenu_qr'] as PaymentMethod[])

type Tx = Prisma.TransactionClient

/**
 * Close out a till sale that is now fully covered: mark it completed (once).
 * Its ledger entry is the drawer's close (or completeOrder's 'order.complete'
 * for a non-till bill) — no register row. Runs inside the caller's transaction. Shared by
 * every settle (tender, check-split portion, gateway confirmation) and the
 * comp path, so a comped sale completes exactly like a paid one.
 */
async function completeTillSaleTx(
  tx: Tx,
  order: Pick<Order, 'id'>,
): Promise<void> {
  // The till's own status write (a till sale goes received → completed at
  // payment, which the kitchen state machine does not model). Conditional, so
  // an order that already ended is never re-completed. Everything a completion
  // triggers — ledger, tax invoice, fiscal POS, loyalty, rollups, webhook —
  // runs once in orders/service completeOrder, called by afterTillSale after
  // this transaction commits. (The FinancialEntry register row this used to
  // write is gone — owner decision 39: the ledger is the record.)
  await tx.order.updateMany({
    where: { id: order.id, status: { notIn: ['completed', 'refunded', 'cancelled', 'rejected'] } },
    data: { status: 'completed', completedAt: new Date() },
  })
}

/** Receipts that cover the bill: paid rows, positive amounts (comps included). */
function coveredCents(payments: Array<{ status: string; amountCents: number }>): number {
  return payments.filter((p) => p.status === 'paid' && p.amountCents > 0).reduce((t, p) => t + p.amountCents, 0)
}

/**
 * After a settle, inside its transaction: when the order is now covered, void
 * any leftover pending rows (the group order's 'split' placeholder, an online
 * tender superseded at the till) so nothing is left "awaiting" money that has
 * already been taken, and complete the sale when the settle is what completes
 * it — a till sale (source 'pos'), or a dine-in bill settled at the till
 * (owner decision 8). Delivery and pickup orders complete on fulfilment, so a
 * rider's cash paid into the drawer or an online payment confirmed by the
 * gateway never completes them here.
 */
async function applyCoverageTx(tx: Tx, orderId: string, via: 'till' | 'gateway'): Promise<{ covered: boolean; completedNow: boolean; customerId: string | null; source: string }> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { payments: { select: { id: true, status: true, amountCents: true } } },
  })
  const covered = coveredCents(order.payments) >= order.totalCents - TENDER_ROUNDING_CENTS
  if (!covered) return { covered, completedNow: false, customerId: order.customerId, source: order.source }
  await tx.payment.updateMany({
    where: { orderId, status: 'pending' },
    data: { status: 'failed', processedAt: new Date() },
  })
  const completes = order.source === 'pos' || (via === 'till' && order.fulfilmentType === 'dine_in')
  const open = !['completed', 'refunded', 'cancelled', 'rejected'].includes(order.status)
  if (completes && open) {
    await completeTillSaleTx(tx, order)
    return { covered, completedNow: true, customerId: order.customerId, source: order.source }
  }
  return { covered, completedNow: false, customerId: order.customerId, source: order.source }
}

/**
 * After a till sale completes (outside the transaction): THE completion
 * routine (orders/service completeOrder) — ledger (a non-till order settled
 * at the till, such as a group bill, gets its own 'order.complete' entry
 * there; a till sale posts with its shift close), the ONE fiscal sale
 * document (filed within the company's bounded till budget so the number and
 * QR can print on the full & final bill — "Fiscal invoice: pending"
 * otherwise), tax invoice, loyalty earn, customer rollups, webhook and
 * notice. Exactly once per order, and it never fails the sale. Returns the
 * sale's fiscal view for the till (a replay reads the current one).
 */
async function afterTillSale(
  orderId: string,
  _customerId?: string | null,
  _source?: string,
): Promise<FiscalView | null> {
  try {
    const { completeOrder } = await import('../orders/service.js')
    const { ran, fiscal } = await completeOrder(orderId, null, { via: 'till_payment', syncFiscal: true })
    return ran ? fiscal : await fiscalViewForOrder(orderId, 'sale', { staff: true })
  } catch (err) {
    console.error(`[complete] till sale ${orderId} completion effects failed:`, (err as Error).message)
    return null
  }
}

// ─── Card machine: what a card tender may be recorded from ─────────────────────

/**
 * W4-AUTH-2: the company's "allow manual card references" switch
 * (TerminalSettings.allowManualRef), enforced on the server — not only by the
 * till hiding the link. While the company's card machine is set up for this
 * drawer's outlet (the rule GET /pos/terminal/config shows the till: a usable
 * terminal connector with an active terminal at the outlet) and the switch is
 * OFF, a CARD tender is recorded only from the machine (a server-side
 * terminalChargeId). A keyed slip reference — 'terminal_offline' included —
 * is refused: "cash taken, card keyed with a made-up slip" is the skim the
 * switch exists to close. Keenu QR is not a card-machine tender.
 */
async function assertManualCardRefAllowed(tenantId: string | null, shiftId: string | null | undefined): Promise<void> {
  if (!tenantId) return
  const conn = await getConnector(tenantId, 'terminal')
  const usable = conn.row.enabled && conn.row.driver !== 'none' && !!terminalDriverOf(conn.row.driver)
  if (!usable || conn.terminalSettings.allowManualRef) return
  const shift = shiftId ? await prisma.shift.findUnique({ where: { id: shiftId }, select: { locationId: true } }) : null
  const atOutlet = conn.terminalSettings.terminals.some((t) => t.active && (!shift?.locationId || t.locationId === shift.locationId))
  if (!atOutlet) return
  throw new AppError(
    'MANUAL_CARD_REF_DISABLED',
    'Card payments here are taken on the card machine — a keyed slip reference is switched off for this company',
    403,
  )
}

/** Charge statuses a card tender may be recorded from: approved, or resolved by hand from the slip (spec §7.9). */
const RECORDABLE_CHARGE: ReadonlySet<TerminalChargeStatus> = new Set<TerminalChargeStatus>(['approved', 'unknown', 'cancel_requested', 'needs_attention', 'manual_resolved'])

/**
 * W4-MONEY-1: a payment recorded from a card-machine charge records exactly
 * what the card was charged, for exactly the bill (and the row) it was
 * started for. Under the order lock, inside the payment's transaction: the
 * charge is this order's, of this company, not yet recorded, and its amount
 * (and tip) equals what is being written. Any mismatch is a 409 — the
 * terminal service then reverses the charge (recordApprovedCharge), so a card
 * is never charged more than servd books.
 */
async function assertChargeMatchesTx(tx: Tx, chargeId: string, expect: {
  orderId: string
  tenantId: string | null
  amountCents: number
  tipCents: number
  targetPaymentId: string | null
}): Promise<void> {
  const c = await tx.terminalCharge.findUnique({
    where: { id: chargeId },
    select: { kind: true, orderId: true, tenantId: true, status: true, paymentId: true, targetPaymentId: true, amountCents: true, tipCents: true },
  })
  if (!c || c.kind !== 'charge' || c.orderId !== expect.orderId || c.tenantId !== expect.tenantId
    || (c.targetPaymentId ?? null) !== expect.targetPaymentId) {
    throw new AppError('TERMINAL_CHARGE_MISMATCH', 'That card-machine charge was not started for this bill', 409)
  }
  if (!RECORDABLE_CHARGE.has(c.status) || c.paymentId) {
    throw new AppError('TERMINAL_CHARGE_NOT_RECORDABLE', `That card-machine charge is ${c.status} — it cannot be recorded as a payment`, 409)
  }
  if (c.amountCents !== expect.amountCents || c.tipCents !== expect.tipCents) {
    throw new AppError(
      'AMOUNT_MISMATCH',
      `The card was charged ${c.amountCents} but ${expect.amountCents} would be recorded — the bill changed while the machine was charging`,
      409,
      { chargedCents: c.amountCents, dueCents: expect.amountCents },
    )
  }
}

/** The till's fiscal answer (spec §8.4): the view plus the deprecated `srb` alias for one release. */
function tillFiscal(fiscal: FiscalView | null): { fiscal: FiscalView | null; srb: ReturnType<typeof legacySrbAlias> } {
  return { fiscal, srb: legacySrbAlias(fiscal) }
}

// ─── The one settle ──────────────────────────────────────────────────────────
//
// settlePayment marks ONE pending payment row paid. It is the only way a
// pending row becomes money received: a check-split portion paid at the till,
// a storefront cash-on-delivery amount the rider pays into a drawer (owner
// decision 4 — it lands on that drawer's Z-report), and a gateway
// confirmation from the Keenu webhook. At the till it needs an OPEN drawer of
// the order's company and, for card / QR, the terminal reference; from the
// gateway it keeps the row's drawer (if any). Then the one coverage rule runs
// (applyCoverageTx).

export interface SettleInput {
  paymentId: string
  via: 'till' | 'gateway'
  /** The open drawer taking the money — required at the till. */
  shiftId?: string | null
  /** Card terminal / gateway transaction reference. Required for card and QR at the till. */
  gatewayRef?: string | null
  /** Cash handed over, for the change calculation. */
  tenderedCents?: number | null
  /** Card machine (server only, connectors/terminal): the gateway the money came through. */
  gateway?: PaymentGateway
  /** Card machine (server only): the TerminalCharge this settle records — let through the active-charge guard. */
  terminalChargeId?: string
}

export async function settlePayment(input: SettleInput) {
  assertAmountsFit(input.tenderedCents)
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    select: {
      id: true, status: true, method: true, amountCents: true, gatewayRef: true, shiftId: true, gatewayMeta: true,
      order: { select: { id: true, concept: { select: { tenantId: true } } } },
    },
  })
  if (!payment) throw new NotFoundError('Payment', input.paymentId)
  if (payment.status === 'paid') return { payment, alreadySettled: true, orderCompleted: false, fiscal: null, srb: null }
  if (payment.status !== 'pending') throw new AppError('NOT_PENDING', `Payment is ${payment.status}, not pending`, 422)
  if (payment.method === 'comp') {
    throw new AppError('COMP_NOT_A_TENDER', 'Comps go through POST /pos/orders/:id/comp — re-split this bill without the comp line', 422)
  }
  if (payment.method === 'split') {
    throw new AppError('SPLIT_PLACEHOLDER', 'This is the group bill placeholder — split the bill (or take one tender at the till) instead of settling it', 422)
  }
  const gatewayRef = input.gatewayRef?.trim() || payment.gatewayRef || null
  if (input.via === 'till') {
    if (!input.shiftId) throw new AppError('SHIFT_REQUIRED', 'Open a drawer before taking a payment', 422)
    // The drawer must be an OPEN shift of the ORDER's company.
    await assertShiftOf(payment.order.concept.tenantId, input.shiftId, true)
    if (payment.method !== 'cash' && !gatewayRef) {
      throw new AppError('GATEWAY_REF_REQUIRED', `${payment.method} payments require the card terminal's reference number`, 400)
    }
    // W4-AUTH-2: a keyed card reference only where the company allows it.
    if (payment.method === 'card' && !input.terminalChargeId) {
      await assertManualCardRefAllowed(payment.order.concept.tenantId, input.shiftId)
    }
    // FOH-24: the cash handed over covers the portion.
    if (payment.method === 'cash' && input.tenderedCents != null && input.tenderedCents < payment.amountCents) {
      throw new AppError('TENDERED_LESS_THAN_DUE', `Cash handed over (${input.tenderedCents}) is less than the ${payment.amountCents} due`, 400)
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    // FOH-04: one settle at a time per order, so two portions settled at once
    // both see each other — otherwise each saw the other's row still pending
    // and the fully paid bill never completed.
    await lockOrderTx(tx, payment.order.id)
    if (input.via === 'till') {
      // FOH-09: at the till a cancelled / refunded ticket takes no money. (A
      // gateway confirmation is recorded whatever the order's state: the
      // processor already has the customer's money.)
      const current = await tx.order.findUniqueOrThrow({ where: { id: payment.order.id }, select: { status: true } })
      assertTakesMoney(current.status)
      // §7.10: while the card machine works on this bill nothing else settles
      // it — except the charge being recorded.
      await assertNoActiveTerminalChargeTx(tx, payment.order.id, input.terminalChargeId)
    }
    // The row as it stands under the lock (a void may have lowered it).
    const amountCents = (await tx.payment.findUnique({ where: { id: payment.id }, select: { amountCents: true } }))?.amountCents ?? payment.amountCents
    // W4-MONEY-1: recorded from the card machine → the row must still be
    // exactly what the card was charged (a gift card or points applied while
    // the machine waited would otherwise book less than the customer paid).
    if (input.terminalChargeId) {
      await assertChargeMatchesTx(tx, input.terminalChargeId, {
        orderId: payment.order.id, tenantId: payment.order.concept.tenantId, amountCents, tipCents: 0, targetPaymentId: payment.id,
      })
    }
    if (input.via === 'till' && payment.method === 'cash' && input.tenderedCents != null && input.tenderedCents < amountCents) {
      throw new AppError('TENDERED_LESS_THAN_DUE', `Cash handed over (${input.tenderedCents}) is less than the ${amountCents} due`, 400)
    }
    const priorMeta = (payment.gatewayMeta && typeof payment.gatewayMeta === 'object' && !Array.isArray(payment.gatewayMeta))
      ? payment.gatewayMeta as Prisma.JsonObject
      : {}
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: 'pending' },
      data: {
        status: 'paid',
        ...(input.via === 'till' && { shiftId: input.shiftId! }),
        gatewayRef,
        ...(input.gateway && { gateway: input.gateway }),
        ...(input.terminalChargeId && { gatewayMeta: { ...priorMeta, terminalChargeId: input.terminalChargeId } }),
        ...(input.tenderedCents != null && {
          tenderedCents: input.tenderedCents,
          changeCents: payment.method === 'cash' ? Math.max(0, input.tenderedCents - amountCents) : null,
        }),
        processedAt: new Date(),
      },
    })
    if (claimed.count === 0) throw new AppError('ALREADY_SETTLED', 'Payment is not pending', 409)
    const coverage = await applyCoverageTx(tx, payment.order.id, input.via)
    const settled = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } })
    return { settled, coverage }
  }, { maxWait: 10_000, timeout: 15_000 })

  const fiscal = result.coverage.completedNow
    ? await afterTillSale(payment.order.id, result.coverage.customerId, result.coverage.source)
    : null
  return { payment: result.settled, alreadySettled: false, orderCompleted: result.coverage.completedNow, ...tillFiscal(fiscal) }
}

/** The order columns the tender pricing reads. */
type TenderPricedOrder = Pick<
  Order,
  'id' | 'conceptId' | 'source' | 'rawPayload' | 'totalCents' | 'discountCents' | 'taxRatePct' | 'taxCents'
  | 'serviceChargeCents' | 'promoDiscountCents' | 'walletAmountCents' | 'tipCents'
>

/**
 * THE bill of an unpaid till sale for the tender it is being paid with
 * (decision 9), through THE pricing function — READ ONLY. Shared by the
 * payment (repriceForTenderTx writes it) and GET /pos/orders/:id/quote, so
 * the quote is exactly what the payment will demand. Null when the order
 * keeps its stored bill: the tender's rate is the one it was priced at, it
 * was not priced through lib/pricing (legacy rows: no taxRatePct), it is not
 * a till sale, or customer credits (promo, wallet, gift card, tip) already
 * sit on its total — re-pricing would drop them.
 */
async function tenderPriceOf(db: Tx, order: TenderPricedOrder, methods: Array<string | null | undefined>): Promise<OrderPrice | null> {
  if (order.taxRatePct == null) return null
  const { isTillSale } = await import('../orders/service.js')
  if (!isTillSale(order)) return null
  if (order.promoDiscountCents > 0 || order.walletAmountCents > 0 || order.tipCents > 0) return null
  if ((await db.giftCardRedemption.count({ where: { orderId: order.id } })) > 0) return null

  const concept = await db.concept.findUniqueOrThrow({
    where: { id: order.conceptId },
    select: { id: true, tenantId: true, taxRateCash: true, taxRateCard: true },
  })
  const tender = tenderOfPayments(methods)
  if (gstRatePct(concept, tender) === order.taxRatePct) return null
  const items = await db.orderItem.findMany({
    where: { orderId: order.id, status: { not: 'voided' } },
    select: { menuItemId: true, unitPriceCents: true, quantity: true, modifiers: { select: { priceDeltaCents: true } } },
  })
  return priceOrder(items, tender, order.source === 'pos' ? 'pos' : 'group', concept, {
    discountCents: order.discountCents,
    db,
  })
}

/**
 * Re-price an unpaid till sale for its tender inside the caller's
 * transaction (tenderPriceOf, then write it). Returns the order's total due.
 */
async function repriceForTenderTx(tx: Tx, order: TenderPricedOrder, methods: Array<string | null | undefined>): Promise<number> {
  const price = await tenderPriceOf(tx, order, methods)
  if (!price) return order.totalCents
  await tx.order.update({
    where: { id: order.id },
    data: {
      taxCents: price.taxCents,
      taxRatePct: price.taxRatePct,
      serviceChargeCents: price.serviceChargeCents,
      totalCents: price.totalCents,
    },
  })
  return price.totalCents
}

/**
 * GET /pos/orders/:id/quote — what POST /pos/payments will demand for this
 * order if it is paid with `method`: the same rule processPayment applies
 * (re-priced for the tender while nothing is paid yet, else the stored total,
 * minus what is already covered). Writes nothing.
 */
export async function quoteOrderForTender(orderId: string, method: 'cash' | 'card' | 'keenu_qr') {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payments: { select: { status: true, amountCents: true } } },
  })
  if (!order) throw new NotFoundError('Order', orderId)
  const paidCents = coveredCents(order.payments)
  const price = paidCents === 0 ? await tenderPriceOf(prisma, order, [method]) : null
  const totalCents = price?.totalCents ?? order.totalCents
  return {
    orderId: order.id,
    status: order.status,
    tender: tenderOf(method),
    repriced: price != null,
    taxRatePct: price?.taxRatePct ?? order.taxRatePct,
    taxCents: price?.taxCents ?? order.taxCents,
    serviceChargeCents: price?.serviceChargeCents ?? order.serviceChargeCents,
    discountCents: order.discountCents,
    tipCents: order.tipCents,
    totalCents,
    paidCents,
    dueCents: Math.max(0, totalCents - paidCents),
  }
}

/**
 * FOH-10: before a bill is split into portions (check-split), inside the
 * split's transaction — lock the order, refuse an ended or already-paid bill,
 * and re-price it for the tenders the portions will be paid with, exactly as
 * a single payment is re-priced (repriceForTenderTx: all card → card rate,
 * any cash → cash rate). Split from this total; settling a portion then never
 * needs a re-price. Returns the total to split and the total it replaced.
 */
export async function prepareSplitTx(
  tx: Tx,
  orderId: string,
  methods: PaymentMethod[],
): Promise<{ totalCents: number; previousTotalCents: number }> {
  await lockOrderTx(tx, orderId)
  // §7.10: never re-split a bill the card machine is working on.
  await assertNoActiveTerminalChargeTx(tx, orderId)
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: { select: { status: true, amountCents: true } } } })
  assertTakesMoney(order.status)
  if (order.payments.some((p) => p.status === 'paid')) {
    throw new AppError('ALREADY_PAID', 'At least one payment on this order is already settled — cannot re-split', 409)
  }
  if (order.status === 'completed') {
    throw new AppError('ORDER_NOT_OPEN', 'This order is already completed — it cannot be split', 409)
  }
  const totalCents = await repriceForTenderTx(tx, order, methods)
  return { totalCents, previousTotalCents: order.totalCents }
}

/** The submission key a payment row was taken under (gatewayMeta.idempotencyKey). */
function paymentKeyOf(p: Pick<Payment, 'gatewayMeta'>): string | null {
  const meta = p.gatewayMeta as { idempotencyKey?: unknown } | null
  return typeof meta?.idempotencyKey === 'string' ? meta.idempotencyKey : null
}

export async function processPayment(input: ProcessPaymentInput) {
  if (input.payments.length === 0) {
    throw new AppError('NO_PAYMENTS', 'At least one payment is required', 400)
  }
  // R2-UI-07: a mistyped 11-digit tender is the cashier's typo (422), not a
  // 500 from the database column.
  assertAmountsFit(
    ...input.payments.flatMap((p) => [p.amountCents, p.tenderedCents, p.tipCents]),
    input.payments.reduce((s, p) => s + p.amountCents, 0),
  )
  if (input.payments.some((p) => p.amountCents <= 0)) {
    throw new AppError('INVALID_AMOUNT', 'Payment amounts must be positive', 400)
  }
  if (input.payments.some((p) => p.method === 'comp')) {
    throw new AppError('COMP_NOT_A_TENDER', 'A comp is not a tender — use POST /pos/orders/:id/comp (reason, caps and manager PIN apply)', 400)
  }
  if (input.payments.some((p) => !TILL_TENDERS.has(p.method))) {
    throw new AppError('NOT_A_TENDER', 'Take cash, card or Keenu QR at the till — split the bill first to pay it in parts', 400)
  }
  // Card and QR need the card terminal's reference number (owner decision 4).
  for (const p of input.payments) {
    if (p.method !== 'cash' && !p.gatewayRef?.trim()) {
      throw new AppError('GATEWAY_REF_REQUIRED', `${p.method} payments require the card terminal's reference number`, 400)
    }
    // FOH-24: the cash handed over must cover what the tender takes.
    if (p.method === 'cash' && p.tenderedCents !== undefined && p.tenderedCents < p.amountCents) {
      throw new AppError('TENDERED_LESS_THAN_DUE', `Cash handed over (${p.tenderedCents}) is less than the ${p.amountCents} being paid`, 400)
    }
    // FOH-14: a tip is part of what the tender takes, never more than it.
    const tip = p.tipCents ?? 0
    if (!Number.isInteger(tip) || tip < 0 || tip > p.amountCents) {
      throw new AppError('INVALID_TIP', 'A tip is a whole, non-negative amount within the tender it rides on', 400)
    }
  }
  const tipTotal = input.payments.reduce((s, p) => s + (p.tipCents ?? 0), 0)
  const submittedTotal = input.payments.reduce((s, p) => s + p.amountCents, 0)
  // A tender recorded from the card machine names THE charge of this payment.
  if (input.payments.some((p) => p.terminalChargeId && p.terminalChargeId !== input.terminalChargeId)) {
    throw new AppError('TERMINAL_CHARGE_MISMATCH', 'That card-machine charge was not started for this payment', 409)
  }
  // W4-AUTH-2: a keyed card reference only where the company allows it.
  if (input.payments.some((p) => p.method === 'card' && !p.terminalChargeId)) {
    const owner = await prisma.order.findUnique({ where: { id: input.orderId }, select: { concept: { select: { tenantId: true } } } })
    await assertManualCardRefAllowed(owner?.concept.tenantId ?? null, input.shiftId)
  }

  const result = await prisma.$transaction(async (tx) => {
    // FOH-04: lock the order, THEN read what is paid. Two cashiers settling
    // the same table, or a double-tapped card, used to both read "nothing
    // paid" under READ COMMITTED and both take the money.
    await lockOrderTx(tx, input.orderId)
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: { payments: true },
    })
    if (!order) throw new NotFoundError('Order', input.orderId)

    // A retry of a submission that already went through returns what it took.
    if (input.idempotencyKey) {
      const prior = order.payments.filter((p) => paymentKeyOf(p) === input.idempotencyKey)
      if (prior.length > 0) {
        const signature = (rows: Array<{ method: string; amountCents: number }>) =>
          rows.map((r) => `${r.method}:${r.amountCents}`).sort().join(',')
        if (signature(prior) !== signature(input.payments)) throw idempotencyKeyReused()
        return { payments: prior, coverage: null, replayCompleted: order.status === 'completed' }
      }
    }

    // §7.10: while the card machine works on this bill no other tender is
    // taken — only the charge being recorded passes (its own terminalChargeId).
    await assertNoActiveTerminalChargeTx(tx, input.orderId, input.terminalChargeId)

    // FOH-09: a cancelled / rejected / refunded ticket takes no money.
    assertTakesMoney(order.status)
    // W4-MONEY-1: a tender recorded from the card machine is exactly that charge.
    for (const p of input.payments) {
      if (!p.terminalChargeId) continue
      const tenant = await tx.concept.findUnique({ where: { id: order.conceptId }, select: { tenantId: true } })
      await assertChargeMatchesTx(tx, p.terminalChargeId, {
        orderId: order.id, tenantId: tenant?.tenantId ?? null, amountCents: p.amountCents, tipCents: p.tipCents ?? 0, targetPaymentId: null,
      })
    }
    const alreadyPaid = coveredCents(order.payments)
    if (order.totalCents <= 0 && alreadyPaid === 0) {
      throw new AppError('NOTHING_DUE', 'Nothing is due on this order — cancel the ticket instead', 409)
    }
    if (alreadyPaid >= order.totalCents) {
      throw new AppError('ALREADY_PAID', 'Order is already fully paid', 400)
    }
    if (order.status === 'completed') {
      // A completed order still owing is a delivery / pickup whose cash is
      // with the rider — it is paid in through its own pending row.
      throw new AppError('ORDER_NOT_OPEN', 'This order is already completed — pay its cash in from the cash-due list', 409)
    }

    // Decision 9: a till sale is taxed at the rate of the tender it is paid
    // with. Rung up as cash and paid by card (or a group bill, priced at the
    // cash rate until the table chooses) → re-priced here, before any money
    // is taken, so the bill, the GST filed and the tender agree.
    const totalDue = alreadyPaid === 0
      ? await repriceForTenderTx(tx, order, input.payments.map((p) => p.method))
      : order.totalCents
    const remainingDue = totalDue - alreadyPaid
    const submittedForBill = submittedTotal - tipTotal

    // Allow up to 2 paisa rounding tolerance — protect against under/overcharge
    if (Math.abs(submittedForBill - remainingDue) > TENDER_ROUNDING_CENTS) {
      throw new AppError(
        'AMOUNT_MISMATCH',
        tipTotal > 0
          ? `Payments total ${submittedTotal} (incl. ${tipTotal} tip) but ${remainingDue} is due before the tip`
          : `Payments total ${submittedTotal} but ${remainingDue} is due`,
        400,
      )
    }

    // FOH-14: the tip rides on the order (Order.tipCents, and on its total —
    // what the customer was charged). The shift close credits it to 2095
    // Tips Payable (computeSaleAccounting), the Z-report shows it and the tip
    // pool sums it. Added AFTER the tender re-price, which keeps a tipped bill.
    if (tipTotal > 0) {
      await tx.order.update({
        where: { id: order.id },
        data: { tipCents: { increment: tipTotal }, totalCents: { increment: tipTotal } },
      })
    }

    const createdPayments = []
    for (const p of input.payments) {
      const changeCents =
        p.method === 'cash' && p.tenderedCents !== undefined
          ? Math.max(0, p.tenderedCents - p.amountCents)
          : undefined
      const meta = {
        ...(input.idempotencyKey && { idempotencyKey: input.idempotencyKey }),
        ...((p.tipCents ?? 0) > 0 && { tipCents: p.tipCents }),
        // Card machine (spec §7): which charge this is, and what the slip says.
        ...(p.terminalChargeId && { terminalChargeId: p.terminalChargeId }),
        ...(p.authCode && { authCode: p.authCode }),
        ...(p.cardBrand && { cardBrand: p.cardBrand }),
        ...(p.cardLast4 && { cardLast4: p.cardLast4 }),
        ...(p.manualReason && { manualReason: p.manualReason }),
      }
      const payment = await tx.payment.create({
        data: {
          orderId: input.orderId,
          shiftId: input.shiftId,
          method: p.method,
          amountCents: p.amountCents,
          status: 'paid',
          gateway: p.gateway ?? 'none',
          gatewayRef: p.gatewayRef?.trim() || null,
          ...(Object.keys(meta).length > 0 && { gatewayMeta: meta }),
          tenderedCents: p.tenderedCents ?? null,
          changeCents: changeCents ?? null,
          processedAt: new Date(),
        },
      })
      createdPayments.push(payment)
    }

    // The tenders cover what was due, so the one coverage rule completes the
    // sale (and voids a leftover placeholder row).
    const coverage = await applyCoverageTx(tx, order.id, 'till')
    return { payments: createdPayments, coverage, replayCompleted: false }
  }, { maxWait: 10_000, timeout: 15_000 })

  if (!result.coverage) {
    // An idempotent replay: nothing new was taken. The sale's fiscal view as it stands now.
    const fiscal = result.replayCompleted ? await fiscalViewForOrder(input.orderId, 'sale', { staff: true }).catch(() => null) : null
    return { payments: result.payments, orderCompleted: result.replayCompleted, ...tillFiscal(fiscal), replayed: true }
  }
  const fiscal = result.coverage.completedNow
    ? await afterTillSale(input.orderId, result.coverage.customerId, result.coverage.source)
    : null
  return { payments: result.payments, orderCompleted: result.coverage.completedNow, ...tillFiscal(fiscal), replayed: false }
}

// ─── Shift management ─────────────────────────────────────────────────────────

export async function openShift(userId: string, openingFloatCents: number, tenantId: string | null = null) {
  // FOH-13: one open drawer per cashier, atomically. A double-tapped "Open
  // shift" used to pass the check twice and open two or three drawers, each
  // with a phantom float, stranded after the first was closed. The per-user
  // advisory lock serialises the check and the insert (this is the only
  // place a shift is created).
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shift-open:${userId}`}))`
    const existing = await tx.shift.findFirst({
      where: { userId, status: 'open' },
      select: { id: true },
    })
    if (existing) throw new AppError('SHIFT_OPEN', 'A shift is already open for this user', 400, { shiftId: existing.id })

    // The drawer belongs to the company the cashier is acting in — that is
    // what every shift read/write is scoped on (Shift.tenantId).
    return tx.shift.create({
      data: { userId, openingFloatCents, status: 'open', tenantId },
    })
  }, { maxWait: 10_000, timeout: 15_000 })
}

export interface OpenTicket {
  id: string
  ref: string
  placedAt: Date
  status: string
  table: string | null
  totalCents: number
  paidCents: number
  dueCents: number
}

export interface OpenTickets {
  count: number
  totalCents: number
  dueCents: number
  tickets: OpenTicket[]
}

/**
 * FOH-21: the tickets rung on this drawer that are still open — rung on the
 * shift, or rung by its cashier at the till without one while it was open.
 * Plus `unassigned`: the company's open till tickets rung with no drawer
 * (the waiter screen) in the same window, which no drawer owns.
 */
async function openTicketsOf(shift: {
  id: string
  userId: string
  openedAt: Date
  closedAt: Date | null
  tenantId: string | null
  locationId: string | null
  location?: { tenantId: string | null } | null
  user?: { tenantId: string | null } | null
}): Promise<OpenTickets & { unassigned: { count: number; totalCents: number } }> {
  const tenantId = shiftTenantId(shift)
  const window = { gte: shift.openedAt, ...(shift.closedAt && { lte: shift.closedAt }) }
  const open = { deletedAt: null, status: { notIn: [...ENDED] as Order['status'][] } }
  const rows = await prisma.order.findMany({
    where: {
      ...open,
      OR: [
        { shiftId: shift.id },
        ...(tenantId ? [{ shiftId: null, source: 'pos' as const, posStaffId: shift.userId, placedAt: window, concept: { tenantId } }] : []),
      ],
    },
    select: { id: true, placedAt: true, status: true, totalCents: true, table: { select: { label: true } }, payments: { select: { status: true, amountCents: true } } },
    orderBy: { placedAt: 'asc' },
    take: 200,
  })
  const tickets = rows.map((o) => {
    const paidCents = coveredCents(o.payments)
    return {
      id: o.id,
      ref: o.id.slice(-8).toUpperCase(),
      placedAt: o.placedAt,
      status: o.status,
      table: o.table?.label ?? null,
      totalCents: o.totalCents,
      paidCents,
      dueCents: Math.max(0, o.totalCents - paidCents),
    }
  })
    // TILL-R1: a ticket with nothing left to collect (voided down to PKR 0,
    // or covered within the tender tolerance) is not unpaid — it must never
    // hold a drawer's close (processPayment refuses it with NOTHING_DUE).
    .filter((t) => t.dueCents > TENDER_ROUNDING_CENTS)
  const unassigned = tenantId
    ? await prisma.order.aggregate({
        where: { ...open, source: 'pos', shiftId: null, posStaffId: { not: shift.userId }, placedAt: window, concept: { tenantId } },
        _count: { _all: true },
        _sum: { totalCents: true },
      })
    : null
  return {
    count: tickets.length,
    totalCents: tickets.reduce((s, t) => s + t.totalCents, 0),
    dueCents: tickets.reduce((s, t) => s + t.dueCents, 0),
    tickets,
    unassigned: { count: unassigned?._count._all ?? 0, totalCents: unassigned?._sum.totalCents ?? 0 },
  }
}

/**
 * GET /pos/shifts/:id/open-tickets — the unpaid tickets on a drawer, the same
 * list closeShift refuses on (409 OPEN_TICKETS) and the Z-report names. The
 * till reads it to show the cashier WHICH tickets hold the close before they
 * confirm "close anyway" (the cashier cannot read the Z-report).
 */
export async function openTicketsOnDrawer(shiftId: string): Promise<OpenTickets> {
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    include: { user: { select: { tenantId: true } }, location: { select: { tenantId: true } } },
  })
  if (!shift) throw new NotFoundError('Shift', shiftId)
  const { unassigned: _unassigned, ...open } = await openTicketsOf(shift)
  return open
}

/** BOOKS-07: a till close the ledger refused is raised to the company's inbox. */
async function flagShiftPostingFailed(shiftId: string, tenantId: string | null, reason: string): Promise<void> {
  console.error(`[journal] shift ${shiftId} did not post: ${reason}`)
  await flagException({
    tenantId,
    kind: 'posting_failed',
    severity: 'high',
    title: 'Till close did not reach the ledger',
    description: `Drawer ${shiftId.slice(0, 8)} closed but its journal entry was refused: ${reason}. Fix the cause (e.g. reopen the period) and re-post it from /reconciliation (backfill unposted).`,
    entityType: 'Shift',
    entityId: shiftId,
    metadata: { reason, sourceType: 'shift.close', sourceId: shiftId },
  })
}

export async function closeShift(
  shiftId: string,
  closingFloatCents: number,
  notes?: string,
  opts: { confirmOpenTickets?: boolean } = {},
) {
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    include: {
      user: { select: { name: true, tenantId: true } },
      location: { select: { tenantId: true } },
    },
  })
  if (!shift) throw new NotFoundError('Shift', shiftId)
  if (shift.status === 'closed') throw new AppError('SHIFT_CLOSED', 'Shift is already closed', 400)
  const tenantId = shiftTenantId(shift)

  // FOH-21: unpaid tickets on this drawer are named before it closes — a
  // walk-out is seen at the close, not found weeks later. Closing anyway takes
  // an explicit confirmation; the Z-report lists them either way.
  if (!opts.confirmOpenTickets) {
    const open = await openTicketsOf(shift)
    if (open.count > 0) {
      throw new AppError(
        'OPEN_TICKETS',
        `${open.count} unpaid ticket(s) worth PKR ${(open.dueCents / 100).toFixed(0)} are still open on this drawer — settle or cancel them, or confirm to close anyway`,
        409,
        { openTickets: { count: open.count, totalCents: open.totalCents, dueCents: open.dueCents, tickets: open.tickets } },
      )
    }
  }

  // Claim the close. The tablet and a manager in admin can both be closing
  // the same drawer; only one of them may win, or the variance is flagged
  // twice and the second count silently overwrites the first.
  const claimed = await prisma.shift.updateMany({
    where: { id: shiftId, status: 'open' },
    data: { status: 'closed', closedAt: new Date(), closingFloatCents, notes: notes ?? null },
  })
  if (claimed.count === 0) throw new AppError('SHIFT_CLOSED', 'Shift is already closed', 400)

  // Cash variance flag — a closing drawer that doesn't reconcile is the
  // single most common indicator of cashier theft. Expected cash is the one
  // formula in lib/drawer.ts (the same figure the cashier counted against on
  // the Z-report), and the tolerance is the shift's own company's
  // ReceiptConfig.cashVarianceLimitCents.
  const drawer = await drawerExpectation(shiftId)
  const expected = drawer.expectedCents
  const variance = closingFloatCents - expected
  const limit = await cashVarianceLimitCents(tenantId)
  if (Math.abs(variance) > limit) {
    await flagException({
      // FOH-11: the drawer's company, or the flag shows in no inbox.
      tenantId,
      kind: 'cash_variance',
      severity: Math.abs(variance) > 100000 ? 'high' : 'medium',
      title: `Cash variance: ${variance >= 0 ? '+' : ''}PKR ${(variance / 100).toFixed(0)}`,
      description: `${shift.user.name}'s shift closed with PKR ${(variance / 100).toFixed(0)} ${variance >= 0 ? 'over' : 'short'}. Expected ${(expected / 100).toFixed(0)}, counted ${(closingFloatCents / 100).toFixed(0)}.`,
      entityType: 'Shift',
      entityId: shiftId,
      actorId: shift.userId,
      amountCents: Math.abs(variance),
      metadata: { ...drawer, counted: closingFloatCents, variance, limitCents: limit },
    })
  }

  // Post the day's POS sales, drawer movements and true over/short to the
  // ledger. Lazy import to avoid a hard dependency from the POS module on
  // accounting. This is the ONLY shift close — /reconciliation closes through
  // POST /pos/shifts/:id/close too — so every closed drawer reaches the books.
  // BOOKS-07: a close the ledger refuses (a locked period, an unbalanced
  // entry) raises a high exception for the drawer's company instead of only
  // a log line nobody reads.
  const { postShiftClose } = await import('../accounting/shiftPosting.js')
  postShiftClose(shiftId)
    .then(async (r) => {
      if (!r.posted && r.reason && r.reason !== 'no_postable_activity') {
        await flagShiftPostingFailed(shiftId, tenantId, r.reason)
      }
    })
    .catch((err) => flagShiftPostingFailed(shiftId, tenantId, (err as Error).message))
    .catch((err) => console.error(`[journal] postShiftClose failed for ${shiftId}:`, (err as Error).message))

  return getZReport(shiftId)
}

export async function getZReport(shiftId: string) {
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    include: {
      // The same rows, and the same sale summary, the ledger post reads.
      payments: { include: SHIFT_SALE_PAYMENT_INCLUDE },
      cashMovements: true,
      user: { select: { name: true, tenantId: true } },
      location: { select: { tenantId: true } },
    },
  })
  if (!shift) throw new NotFoundError('Shift', shiftId)

  const payments = shift.payments

  const cashSales = payments
    .filter((p) => p.method === 'cash' && p.status === 'paid')
    .reduce((s, p) => s + p.amountCents, 0)

  const cardSales = payments
    .filter((p) => ['card', 'keenu_qr'].includes(p.method) && p.status === 'paid')
    .reduce((s, p) => s + p.amountCents, 0)

  const pendingCardSales = payments
    .filter((p) => ['card', 'keenu_qr'].includes(p.method) && p.status === 'pending')
    .reduce((s, p) => s + p.amountCents, 0)

  // F-PAY02: wallet sales line stays at 0 until JazzCash/Easypaisa adapters
  // are reintroduced. Z-reports still show the row so the shape of the
  // close-out summary doesn't change between releases.
  const walletSales = 0

  const compSales = payments
    .filter((p) => p.method === 'comp' && p.status === 'paid')
    .reduce((s, p) => s + p.amountCents, 0)

  // Refund rows carry a NEGATIVE amountCents. Summing them raw produced a
  // negative "voids", and every consumer then SUBTRACTED it — so a refund
  // *added* to revenue and *raised* expected cash, showing double takings and
  // a phantom drawer shortage. Work in positive magnitudes instead.
  const refundedPayments = payments.filter((p) => p.status === 'refunded')
  const voids = refundedPayments.reduce((s, p) => s + Math.abs(p.amountCents), 0)

  const totalSales = cashSales + cardSales + walletSales
  // Orders, tax, discounts, tips and service charge are the till orders this
  // drawer books, split by the one sale formula (accounting/shiftPosting.ts
  // summariseShiftSales → computeSaleAccounting) — the figures the shift's
  // journal entry posts, not a second count of its own.
  const sales = summariseShiftSales(shiftId, payments)
  const totalOrders    = sales.totals.orders
  const totalDiscounts = sales.totals.discountCents
  const totalTax       = sales.totals.taxCents
  const totalTips      = sales.totals.tipCents
  // F7: what gift cards paid of the bills this drawer books (Dr 2080 on the
  // close) — a tender the cashier took that is not cash or card.
  const giftCardCents  = sales.totals.giftCardAppliedCents
  // F7: money taken here on tickets that were then cancelled / rejected is
  // not a sale — it is owed back to the customer (the close credits 1110).
  // Refund due = those receipts less what has already been handed back on
  // the same orders.
  const cancelledIds = new Set(sales.cancelledPaid.orderIds)
  const refundedOnCancelled = new Map<string, number>()
  for (const p of payments) {
    if (!p.order || !cancelledIds.has(p.order.id) || refundedOnCancelled.has(p.order.id)) continue
    refundedOnCancelled.set(p.order.id, p.order.payments.filter((r) => r.status === 'refunded').reduce((t, r) => t + Math.abs(r.amountCents), 0))
  }
  const cancelledPaidCents = sales.cancelledPaid.cashCents + sales.cancelledPaid.cardCents
  const refundDueCents = Math.max(0, cancelledPaidCents - [...refundedOnCancelled.values()].reduce((t, c) => t + c, 0))

  // Expected drawer — the one formula (lib/drawer.ts): opening + cash sales
  // − cash refunds − drops − pay-outs + adds + pay-ins.
  const drawer = drawerExpectationOf(shift)
  const expectedCash = drawer.expectedCents
  const varianceCents = drawerVariance(shift.closingFloatCents, drawer)
  const varianceLimitCents = await cashVarianceLimitCents(shiftTenantId(shift))
  const movements = shift.cashMovements ?? []

  // Per-method breakdown for the tablet UI.
  const byMethodMap = new Map<string, { method: string; count: number; amountCents: number }>()
  for (const p of payments) {
    if (p.status !== 'paid') continue
    const row = byMethodMap.get(p.method) ?? { method: p.method, count: 0, amountCents: 0 }
    row.count       += 1
    row.amountCents += p.amountCents
    byMethodMap.set(p.method, row)
  }
  const byMethod = Array.from(byMethodMap.values()).sort((a, b) => b.amountCents - a.amountCents)

  // FOH-21: tickets rung on this drawer that are still unpaid (walk-outs,
  // abandoned tables) — the end-of-shift report names them.
  const { unassigned, ...openTickets } = await openTicketsOf(shift)

  return {
    // ─── Original fields (kept for back-compat with existing admin pages) ───
    shiftId,
    staffName: shift.user.name,
    openedAt: shift.openedAt,
    closedAt: shift.closedAt,
    status: shift.status,
    openingFloat: shift.openingFloatCents,
    closingFloat: shift.closingFloatCents,
    cashSales,
    cardSales,
    pendingCardSales,
    walletSales,
    compSales,
    voids,
    totalSales,
    totalOrders,
    totalDiscounts,
    totalTax,
    netRevenue: totalSales - voids,
    expectedCashInDrawer: expectedCash,
    actualCashInDrawer: shift.closingFloatCents ?? null,
    cashVariance: varianceCents,

    // ─── v4 additions — tablet POS consumes these directly ─────────────────
    openingFloatCents:    shift.openingFloatCents,
    closingFloatCents:    shift.closingFloatCents,
    notes:                shift.notes,
    ordersCount:          totalOrders,
    grossCents:           totalSales,
    netCents:             totalSales - voids,
    taxCents:             totalTax,
    tipsCents:            totalTips,
    // TILL-R5: the takings above (cash + card) include card tips, which are
    // staff money (2095), not sales — the sales figure without them.
    salesExTipsCents:     totalSales - totalTips,
    giftCardCents,
    cancelledPaid: {
      count:     sales.cancelledPaid.orderIds.length,
      cashCents: sales.cancelledPaid.cashCents,
      cardCents: sales.cancelledPaid.cardCents,
    },
    refundDueCents,
    serviceChargeCents:   sales.totals.serviceChargeCents,
    discountCents:        totalDiscounts,
    compCents:            compSales,
    voidsCount:           refundedPayments.length,
    refundsCents:         voids,
    cashRefundsCents:     drawer.cashRefundsCents,
    byMethod,
    cashMovements: {
      drops:   drawer.dropsCents,
      adds:    drawer.addsCents,
      payouts: drawer.payoutsCents,
      payins:  drawer.payinsCents,
      list:    movements,
    },
    expectedCashCents:    expectedCash,
    varianceCents,
    // The drawer company's tolerance and the verdict on it — clients show
    // this rather than hard-coding a threshold of their own.
    varianceLimitCents,
    isBalanced:           isDrawerBalanced(varianceCents, varianceLimitCents),
    openTickets,
    // The company's open till tickets rung with no drawer (waiter screen)
    // while this one was open — no drawer owns them.
    unassignedOpenTickets: unassigned,
  }
}

// ─── Void / comp / refund ─────────────────────────────────────────────────────
// Each enforces RefundPolicy caps. Comp / refund: above the cashier cap, a
// manager PIN must be supplied. A VOID always needs a manager (§17.4 — the
// cashier void cap is treated as 0; requireManagerApproval). We re-verify the
// PIN at submission time so a delegated terminal can't move the cap by simply
// impersonating a manager session.

interface VoidInput {
  orderId: string
  orderItemId: string
  reason: string
  actorId: string
  actorRole: string
  managerOverridePin?: string
}

async function ensureCapOrManagerOverride(
  amountCents: number,
  cashierCap: number,
  managerCap: number,
  policy: { requireReason: boolean; requirePhotoEvidence: boolean; notifyOwnerAboveCents: number | null; approverEmail: string | null },
  reason: string,
  photoUrl: string | undefined,
  actorRole: string,
  managerOverridePin: string | undefined,
  action: string,
  tenantId: string | null,
  /** Who sends the PIN and for which order — the PIN attempt limiter's keys (FOH-R2-01). */
  pinCtx: { actorId: string; orderId: string },
): Promise<{ approverId: string | null }> {
  if (policy.requireReason && reason.trim().length === 0) {
    throw new AppError('REASON_REQUIRED', 'Reason required by policy', 400)
  }
  if (policy.requirePhotoEvidence && !photoUrl) {
    throw new AppError('PHOTO_REQUIRED', 'Photo evidence required by policy', 400)
  }

  const cap = isOverrideApprover(actorRole) ? managerCap : cashierCap
  if (amountCents <= cap) return { approverId: null }

  // Above own cap. Either user is an approver (already at managerCap and
  // still over — block) or cashier with a manager PIN.
  if (isOverrideApprover(actorRole)) {
    throw new AppError('OVER_CAP', `Amount ${amountCents} exceeds the ${cap} cap for ${action}`, 403)
  }
  if (!managerOverridePin) {
    throw new AppError('MANAGER_OVERRIDE_REQUIRED', `Manager PIN required for ${action} above ${cap}`, 403)
  }

  const approver = await verifyManagerPin(managerOverridePin, tenantId, undefined, { ...pinCtx, action })
  if (!approver) throw new AppError('INVALID_MANAGER_PIN', 'Manager PIN did not match any active manager', 403)

  if (amountCents > managerCap) {
    throw new AppError('OVER_MANAGER_CAP', `Amount ${amountCents} exceeds the manager cap of ${managerCap}`, 403)
  }
  return { approverId: approver.id }
}

/**
 * §17.4 — the MANAGER who approves an act only a manager may do (every line
 * void; every cancel / void of a whole rung-up order): the actor, when they
 * are an override approver (owner decision 7); otherwise the owner of a valid
 * manager PIN of the ORDER's company — a PIN of another company's manager is
 * refused like a wrong one. There is no cap below which a cashier or server
 * may do it alone. The approver is always returned, so it is always recorded.
 */
export async function requireManagerApproval(input: {
  actorId: string
  actorRole: string
  managerOverridePin?: string | null
  tenantId: string | null
  /** What is being approved, for the message ("Voiding an item", "Cancelling an order"). */
  action: string
  /** The order being approved for — its own PIN-attempt bucket (FOH-R2-01). */
  orderId?: string | null
}): Promise<{ approverId: string; viaPin: boolean }> {
  if (isOverrideApprover(input.actorRole)) return { approverId: input.actorId, viaPin: false }
  if (!input.managerOverridePin?.trim()) {
    throw new AppError('MANAGER_OVERRIDE_REQUIRED', `${input.action} needs a manager — a manager signs in or enters their PIN`, 403)
  }
  const approver = await verifyManagerPin(input.managerOverridePin, input.tenantId, undefined, {
    actorId: input.actorId, orderId: input.orderId ?? null, action: input.action,
  })
  if (!approver) throw invalidManagerPin()
  return { approverId: approver.id, viaPin: true }
}

async function notifyOwnerIfThreshold(
  amountCents: number,
  policy: { notifyOwnerAboveCents: number | null; approverEmail: string | null },
  action: string,
  orderId: string,
  reason: string,
  actorId: string | undefined,
  tenantId: string | null,
): Promise<void> {
  if (policy.notifyOwnerAboveCents == null || amountCents < policy.notifyOwnerAboveCents) return

  // Always fire an exception flag — the inbox should reflect it even if email is misconfigured.
  await flagException({
    // FOH-11: the order's company, or no owner inbox ever shows it.
    tenantId,
    kind: action === 'comp' ? 'comp_above_threshold' : action === 'refund' ? 'refund_above_threshold' : 'high_value_void',
    severity: 'high',
    title: `${action.toUpperCase()} of PKR ${(amountCents / 100).toFixed(0)} on order`,
    description: `${action} above the owner-notify threshold. Reason: ${reason}`,
    entityType: 'Order',
    entityId: orderId,
    actorId: actorId ?? null,
    amountCents,
    metadata: { action, reason, threshold: policy.notifyOwnerAboveCents },
  })

  if (!policy.approverEmail) return
  sendEmail(
    policy.approverEmail,
    `[servd] ${action} of PKR ${(amountCents / 100).toFixed(0)} on order ${orderId}`,
    `<p>A ${action} above the notify threshold was just performed.</p><p><strong>Amount:</strong> PKR ${(amountCents / 100).toFixed(0)}<br/><strong>Order:</strong> ${orderId}<br/><strong>Reason:</strong> ${reason}</p>`,
  ).catch((err: Error) => console.warn(`[refund-policy] owner notification failed: ${err.message}`))
}

/** The pricing channel an order was billed under (lib/pricing.ts). */
function pricingChannelOf(order: { source: string; rawPayload?: unknown }): PricingChannel {
  if (order.source === 'pos') return 'pos'
  const raw = order.rawPayload as { channel?: unknown } | null | undefined
  if (raw?.channel === 'group_order') return 'group'
  return 'storefront'
}

/** Which tender's rate an order is priced at (its stored taxRatePct). Cash when unknown or ambiguous. */
function tenderOfRate(concept: { taxRateCash: number; taxRateCard: number }, taxRatePct: number | null): Tender {
  return taxRatePct != null && taxRatePct === concept.taxRateCard && taxRatePct !== concept.taxRateCash ? 'card' : 'cash'
}

/** FOH-16: only an open, unpaid ticket loses a line; a sold one is refunded. */
function assertVoidable(status: string): void {
  if (status === 'completed') {
    throw new AppError('ORDER_PAID', 'This order is paid — refund it instead (POST /pos/orders/:id/refund)', 422)
  }
  if (ENDED.has(status)) {
    throw new AppError('ORDER_NOT_OPEN', `This order is ${status} — its lines can no longer be voided`, 422)
  }
}

type PricedLineRow = { menuItemId: string | null; unitPriceCents: number; quantity: number; modifiers: Array<{ priceDeltaCents: number }> }

type VoidBill = { totalCents: number; taxCents: number; serviceChargeCents: number; discountCents: number }

/**
 * FOH-03 / BOH-02: what a voided line takes off the bill, inside the void's
 * transaction (the order is locked). THE pricing function prices the order
 * with and without the line — same tender (the rate it was billed at), same
 * staff discount, same channel — and the difference comes off the stored
 * GST, service charge, discount and total. Working on the difference keeps
 * whatever else sits on the total (a gift card already applied, a delivery
 * fee, a promo) exactly as it was. Reads only; lowerBillForVoidTx writes it.
 */
async function voidBillDeltaTx(
  tx: Tx,
  order: Pick<Order, 'id' | 'source' | 'rawPayload' | 'totalCents' | 'taxCents' | 'serviceChargeCents' | 'discountCents' | 'taxRatePct'>
    & { concept: { id: string; tenantId: string | null; taxRateCash: number; taxRateCard: number } },
  voidedLine: PricedLineRow,
): Promise<{ bill: VoidBill; removedCents: number; liveLines: number }> {
  const remaining = await tx.orderItem.findMany({
    where: { orderId: order.id, status: { not: 'voided' } },
    select: { menuItemId: true, unitPriceCents: true, quantity: true, modifiers: { select: { priceDeltaCents: true } } },
  })
  const tender = tenderOfRate(order.concept, order.taxRatePct)
  const channel = pricingChannelOf(order)
  const was = await priceOrder([...remaining, voidedLine], tender, channel, order.concept, { discountCents: order.discountCents, db: tx })
  const now = await priceOrder(remaining, tender, channel, order.concept, { discountCents: order.discountCents, db: tx })

  // Never take off more GST, service charge or discount than the bill
  // carries (an order not priced through lib/pricing, or a service charge
  // switched on after it was rung).
  const itemsOff = was.itemTotalCents - now.itemTotalCents
  const taxOff = Math.min(order.taxCents, Math.max(0, was.taxCents - now.taxCents))
  const serviceOff = Math.min(order.serviceChargeCents, Math.max(0, was.serviceChargeCents - now.serviceChargeCents))
  const discountOff = Math.min(order.discountCents, Math.max(0, was.discountCents - now.discountCents))
  const removedCents = itemsOff + taxOff + serviceOff - discountOff
  return {
    bill: {
      totalCents: order.totalCents - removedCents,
      taxCents: order.taxCents - taxOff,
      serviceChargeCents: order.serviceChargeCents - serviceOff,
      discountCents: order.discountCents - discountOff,
    },
    removedCents,
    liveLines: remaining.length,
  }
}

/**
 * Write the lowered bill (voidBillDeltaTx). Pending rows follow the bill:
 * check-split portions no longer add up, so they are cleared (re-split); a
 * placeholder or an uncollected cash row is lowered by the same amount.
 * Returns whether a split was cleared.
 */
async function lowerBillForVoidTx(tx: Tx, orderId: string, bill: VoidBill, removedCents: number): Promise<boolean> {
  if (bill.totalCents < 0) {
    throw new AppError('VOID_EXCEEDS_BILL', 'Credits already applied to this bill exceed what would be left — refund the credit first', 422)
  }
  await tx.order.update({ where: { id: orderId }, data: bill })

  const pending = await tx.payment.findMany({
    where: { orderId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, amountCents: true, splitGroup: true },
  })
  const portions = pending.filter((p) => p.splitGroup != null)
  if (portions.length > 0) await tx.payment.deleteMany({ where: { id: { in: portions.map((p) => p.id) } } })
  let left = removedCents
  for (const p of pending.filter((x) => x.splitGroup == null)) {
    if (left <= 0) break
    const take = Math.min(left, p.amountCents)
    if (take > 0) await tx.payment.update({ where: { id: p.id }, data: { amountCents: { decrement: take } } })
    left -= take
  }
  return portions.length > 0
}

const STOCK_DEPLETE = 'stock.sale_deplete'
const STOCK_RESTORE = 'stock.sale_restore'
const STOCK_VOID_RESTORE = 'stock.void_restore'
/** Lines the kitchen has not started: voiding them gives their stock back. */
const UNFIRED = ['pending', 'held'] as const

/**
 * BOH-11: give back the stock a voided, not-yet-cooked line took at ring-up,
 * inside the void's transaction (the order row is locked, as the depletion
 * and the cancel restore lock it — orders/service lockOrderForStock).
 *
 *   - Only what the order's depletion actually took (its `taken`, clamped at
 *     zero stock) and only once: the void claims the line first.
 *   - The depletion row's `taken` is kept NET of void restores (the original
 *     figures stay under `takenAtSale`), so cancelling the order later gives
 *     back only what is still out — restoreInventoryForOrder reads `taken`.
 *   - Not depleted yet (the fire-and-forget deduction has not run): nothing to
 *     give back — the line is voided now, so the deduction skips it.
 *   - A line the kitchen already started stays consumed: the food was made.
 *     It is booked as waste instead (BOH-R2-03, inventory/voidWaste.ts).
 */
async function restoreVoidedLineStockTx(
  tx: Tx,
  orderId: string,
  tenantId: string | null,
  line: { id: string; menuItemId: string | null; quantity: number },
  unfired: boolean,
): Promise<{ restored: Record<string, number>; skipped: 'cooked' | 'not_depleted' | 'no_recipe' | null }> {
  if (!unfired) return { restored: {}, skipped: 'cooked' }
  const [depleted, restoredAll] = await Promise.all([
    tx.auditLog.findFirst({ where: { entity: 'Order', entityId: orderId, action: STOCK_DEPLETE }, select: { id: true, metadata: true } }),
    tx.auditLog.findFirst({ where: { entity: 'Order', entityId: orderId, action: STOCK_RESTORE }, select: { id: true } }),
  ])
  if (!depleted || restoredAll) return { restored: {}, skipped: 'not_depleted' }

  const need = await consumptionForSoldLines([{ menuItemId: line.menuItemId, quantity: line.quantity, status: 'pending' }], tx)
  if (need.size === 0) return { restored: {}, skipped: 'no_recipe' }
  const meta = (depleted.metadata ?? {}) as { taken?: Record<string, number>; takenAtSale?: Record<string, number>; voidRestored?: Record<string, Record<string, number>> } & Record<string, unknown>
  const taken = { ...(meta.taken ?? {}) }
  const give: Record<string, number> = {}
  for (const [id, qty] of need) {
    const out = taken[id] ?? 0
    const back = Math.min(qty, out)
    if (back > 0) {
      give[id] = back
      taken[id] = out - back
    }
  }
  for (const id of Object.keys(give).sort()) {
    await tx.inventoryItem.updateMany({ where: { id }, data: { currentStock: { increment: give[id]! } } })
  }
  await tx.auditLog.update({
    where: { id: depleted.id },
    data: {
      metadata: {
        ...meta,
        takenAtSale: meta.takenAtSale ?? meta.taken ?? {},
        taken,
        voidRestored: { ...(meta.voidRestored ?? {}), [line.id]: give },
      } as Prisma.InputJsonValue,
    },
  })
  await tx.auditLog.create({
    data: {
      category: 'stock',
      tenantId,
      action: STOCK_VOID_RESTORE,
      entity: 'OrderItem',
      entityId: line.id,
      metadata: { orderId, restored: give } as Prisma.InputJsonValue,
    },
  })
  return { restored: give, skipped: null }
}

export async function voidOrderItem(input: VoidInput) {
  const item = await prisma.orderItem.findUnique({
    where: { id: input.orderItemId },
    include: {
      modifiers: { select: { priceDeltaCents: true } },
      order: { select: { status: true, conceptId: true, concept: { select: { tenantId: true } } } },
    },
  })
  if (!item || item.orderId !== input.orderId) throw new NotFoundError('OrderItem', input.orderItemId)
  if (item.voidedAt) throw new AppError('ALREADY_VOIDED', 'Item is already voided', 400)
  assertVoidable(item.order.status)
  // The line's value, add-ons included, is what the void cap is measured on.
  const lineCents = (item.unitPriceCents + item.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)) * item.quantity
  const tenantId = item.order.concept.tenantId

  const policy = await getRefundPolicy(tenantId)
  // §17.4 — EVERY void needs a manager: the cashier void cap is 0 (a
  // cashier or server never voids alone, whatever the line's value — a free
  // item included), the manager cap still applies. The approver is always
  // recorded (the actor's own id when the actor is the manager).
  if (policy.requireReason && input.reason.trim().length === 0) {
    throw new AppError('REASON_REQUIRED', 'Reason required by policy', 400)
  }
  const { approverId, viaPin } = await requireManagerApproval({
    actorId: input.actorId,
    actorRole: input.actorRole,
    managerOverridePin: input.managerOverridePin,
    tenantId,
    action: 'Voiding an item',
    orderId: input.orderId,
  })
  if (lineCents > policy.managerVoidLimitCents) {
    throw viaPin
      ? new AppError('OVER_MANAGER_CAP', `Amount ${lineCents} exceeds the manager cap of ${policy.managerVoidLimitCents}`, 403)
      : new AppError('OVER_CAP', `Amount ${lineCents} exceeds the ${policy.managerVoidLimitCents} cap for void`, 403)
  }

  const result = await prisma.$transaction(async (tx) => {
    // The order is locked, so a void and a payment never interleave: the
    // payment either sees the lowered bill or the void sees the payment.
    await lockOrderTx(tx, input.orderId)
    // W4-MONEY-4: the card machine is charging this bill as it stands — a
    // line coming off now would leave the card charged for a bill that no
    // longer exists. (A pending card ROW is caught below; a machine charge has
    // no Payment row until it is approved.)
    await assertNoActiveTerminalChargeTx(tx, input.orderId)
    const order = await tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      include: {
        payments: true,
        concept: { select: { id: true, tenantId: true, taxRateCash: true, taxRateCard: true } },
      },
    })
    assertVoidable(order.status)
    // A card / online payment in flight was started for the current amount.
    if (order.payments.some((p) => p.status === 'pending' && p.splitGroup == null && (p.method === 'card' || p.method === 'keenu_qr'))) {
      throw new AppError('PAYMENT_IN_PROGRESS', 'A card payment is in progress for this bill — wait for it, then refund the item', 409)
    }

    // Claim the line. Claimed while still unfired (pending / held) → its
    // stock goes back; the kitchen firing it a moment earlier (expo/fire.ts
    // claims pending lines the same way) makes it a cooked line instead.
    const voidData = { voidedAt: new Date(), voidReason: input.reason, status: 'voided' as const }
    const unfired = await tx.orderItem.updateMany({
      where: { id: input.orderItemId, orderId: input.orderId, voidedAt: null, status: { in: [...UNFIRED] as Array<'pending' | 'held'> } },
      data: voidData,
    })
    if (unfired.count === 0) {
      const claimed = await tx.orderItem.updateMany({
        where: { id: input.orderItemId, orderId: input.orderId, voidedAt: null },
        data: voidData,
      })
      if (claimed.count === 0) throw new AppError('ALREADY_VOIDED', 'Item is already voided', 400)
    }

    const delta = await voidBillDeltaTx(tx, order, {
      menuItemId: item.menuItemId, unitPriceCents: item.unitPriceCents, quantity: item.quantity, modifiers: item.modifiers,
    })
    const covered = coveredCents(order.payments)

    // FOH-16 / TILL-R3: money (or a comp) already on an OPEN bill.
    //   • What is on it still fits the bill without the line → a plain void:
    //     the bill comes down and less is left to collect. (A dine-in table
    //     that paid part of its bill loses a dish.)
    //   • The bill is fully paid but not completed (an online order paid by
    //     card, still in the kitchen) → the line is voided AND its value goes
    //     back on the tender it was paid with, through the refund engine's own
    //     row and 'order.refund' entry, in this transaction. The bill is NOT
    //     lowered: the sale the order becomes books what was charged and the
    //     refund entry reverses the line — exactly as a refund after
    //     completion does, so nothing is booked twice.
    //   • Part-paid and the payments already exceed what the bill would be →
    //     take the rest of the payment first, then refund the line.
    let bill: VoidBill
    let splitCleared = false
    let refund: { payment: Payment; entryId: string } | null = null
    if (covered <= delta.bill.totalCents + TENDER_ROUNDING_CENTS) {
      bill = delta.bill
      splitCleared = await lowerBillForVoidTx(tx, order.id, delta.bill, delta.removedCents)
    } else {
      if (covered < order.totalCents - TENDER_ROUNDING_CENTS) {
        throw new AppError(
          'ORDER_PARTLY_PAID',
          `PKR ${((covered) / 100).toFixed(0)} is already paid on this bill, more than it would be without this item — take the rest of the payment, then refund the item`,
          409,
        )
      }
      if (delta.liveLines === 0) {
        throw new AppError('VOID_LAST_LINE', 'This is the last item on a paid order — cancel the order instead of voiding it', 409)
      }
      const state = refundableOf(order.payments, order.source)
      // Back the way it came: the latest tender that can cover it.
      const byRecency = [...state.base]
        .sort((a, b) => +(b.processedAt ?? b.createdAt) - +(a.processedAt ?? a.createdAt))
        .map((p) => p.method as RefundMethod)
      const method = byRecency.find((m) => (state.byMethod.get(m) ?? 0) >= delta.removedCents) ?? state.latestMethod
      if (!method) {
        throw new AppError('REFUND_EXCEEDS_PAID', 'Nothing refundable was paid on this bill — the item cannot be voided', 422)
      }
      assertRefundable(state, delta.removedCents, method)
      // A cash refund leaves the refunder's open drawer (owner decision 3);
      // card / QR sits on it when there is one.
      const own = await tx.shift.findFirst({
        // A brand with no company has no drawer of its own: deny, never "any".
        where: { userId: input.actorId, status: 'open', ...shiftOfCompany(tenantId ? { tenantId } : { tenantId: { in: [] } }) },
        orderBy: { openedAt: 'desc' },
        select: { id: true },
      })
      if (method === 'cash' && !own) {
        throw new AppError('OPEN_DRAWER_REQUIRED', 'This item was paid in cash — open a shift so the refund can leave your drawer, then void it', 422)
      }
      refund = await writeRefundTx(tx, {
        orderId: order.id,
        shiftId: own?.id ?? null,
        method,
        amountCents: delta.removedCents,
        reason: `Void: ${input.reason}`,
        approverId,
        actorId: input.actorId,
        voidedItemId: input.orderItemId,
      })
      bill = { totalCents: order.totalCents, taxCents: order.taxCents, serviceChargeCents: order.serviceChargeCents, discountCents: order.discountCents }
    }

    const stock = await restoreVoidedLineStockTx(tx, input.orderId, tenantId, item, unfired.count === 1)
    // BOH-R2-03: a line the kitchen already fired keeps its stock out — and
    // that stock is booked as waste (WasteLog + Dr 5040 / Cr 1210 in the
    // order's company), in this transaction.
    const waste = unfired.count === 1 ? null : await wasteVoidedFiredLineTx(tx, {
      orderId: input.orderId,
      tenantId,
      conceptId: item.order.conceptId,
      line: { id: item.id, name: item.name, menuItemId: item.menuItemId, quantity: item.quantity },
      actorId: input.actorId,
      approverId,
      reason: input.reason,
    })
    const voided = await tx.orderItem.findUniqueOrThrow({ where: { id: input.orderItemId } })
    return { voided, bill: { ...bill, removedCents: delta.removedCents, splitCleared }, stock, refund, waste }
  }, { maxWait: 10_000, timeout: 15_000 })
  const { voided, bill, stock, refund, waste } = result
  if (waste?.postingError) {
    await flagException({
      tenantId,
      conceptId: item.order.conceptId,
      kind: 'posting_failed',
      severity: 'high',
      title: `Waste from a voided line not posted (${waste.postingError.code})`,
      description: `${item.quantity} × ${item.name} was voided after the kitchen fired it. Its stock is logged as waste (PKR ${(waste.costCents / 100).toFixed(0)}) but the ledger refused the entry: ${waste.postingError.message} Book Dr 5040 / Cr 1210 in the open period.`,
      entityType: 'OrderItem',
      entityId: item.id,
      actorId: input.actorId,
      amountCents: waste.costCents,
      metadata: { orderId: input.orderId, wasteLogIds: waste.wasteLogIds, source: `pos.void_waste:${item.id}`, code: waste.postingError.code },
    })
  }

  // The kitchen screens drop the line live — this is the only void path now
  // (the KDS status route no longer accepts 'voided'), so it carries the push
  // that route used to send.
  emitItemUpdated(voided.id, 'voided', voided.stationId)
  await audit({ category: 'identity',
    action: 'order_item_void',
    entity: 'OrderItem',
    entityId: input.orderItemId,
    userId: input.actorId,
    tenantId,
    metadata: { orderId: input.orderId, lineCents, reason: input.reason, approverId, removedCents: bill.removedCents, newTotalCents: bill.totalCents, stockRestored: stock.restored, stockSkipped: stock.skipped, stockWasted: waste?.wasted ?? {}, wasteCostCents: waste?.costCents ?? 0, wasteLogIds: waste?.wasteLogIds ?? [], wasteEntryId: waste?.entryId ?? null, refundPaymentId: refund?.payment.id ?? null },
  })
  if (refund) {
    await audit({ category: 'identity',
      action: 'order_refund',
      entity: 'Order',
      entityId: input.orderId,
      userId: input.actorId,
      tenantId,
      metadata: { amountCents: bill.removedCents, method: refund.payment.method, shiftId: refund.payment.shiftId, reason: input.reason, approverId, refundPaymentId: refund.payment.id, entryId: refund.entryId, voidedItemId: input.orderItemId },
    })
  }
  await notifyOwnerIfThreshold(lineCents, policy, 'void', input.orderId, input.reason, input.actorId, tenantId)

  // Pattern detection — the same person voiding 3+ items in the last hour is
  // a classic skim signal. Counted on who VOIDED (the audit trail), in this
  // company.
  const oneHourAgo = new Date(Date.now() - 60 * 60_000)
  const recentVoids = await prisma.auditLog.count({
    where: { action: 'order_item_void', userId: input.actorId, tenantId, createdAt: { gte: oneHourAgo } },
  })
  if (recentVoids >= 3) {
    const actor = await prisma.user.findUnique({ where: { id: input.actorId }, select: { name: true } })
    await flagException({
      // FOH-11: the order's company.
      tenantId,
      conceptId: item.order.conceptId,
      kind: 'consecutive_voids',
      severity: recentVoids >= 5 ? 'high' : 'medium',
      title: `${actor?.name ?? 'Cashier'} voided ${recentVoids} items in 1 hour`,
      description: `Pattern: a single cashier triggered ${recentVoids} voids in the last 60 minutes. Worth a Z-report glance.`,
      entityType: 'OrderItem',
      entityId: input.orderItemId,
      actorId: input.actorId,
      metadata: { count: recentVoids, windowMinutes: 60 },
    })
  }

  // The voided line as before, plus the bill it leaves (FOH-03).
  return {
    ...voided,
    order: {
      id: input.orderId,
      totalCents: bill.totalCents,
      taxCents: bill.taxCents,
      serviceChargeCents: bill.serviceChargeCents,
      discountCents: bill.discountCents,
    },
    removedCents: bill.removedCents,
    splitCleared: bill.splitCleared,
    stockRestored: stock.restored,
    // BOH-R2-03: a fired line's stock, booked as waste (quantities only — no cost at the till).
    stockWasted: waste?.wasted ?? {},
    // TILL-R3: a paid, still-open order's line goes back to the customer.
    refund: refund
      ? { id: refund.payment.id, amountCents: Math.abs(refund.payment.amountCents), method: refund.payment.method, shiftId: refund.payment.shiftId, entryId: refund.entryId }
      : null,
  }
}

export interface CompRefundInput {
  orderId: string
  amountCents: number
  reason: string
  photoUrl?: string
  actorId: string
  actorRole: string
  managerOverridePin?: string
}

export interface CompInput extends CompRefundInput {
  /** The open drawer the comp is rung on — required, like any settlement. */
  shiftId: string
  /**
   * A staff meal (owner decision 11): the meal is rung through the till like
   * any order — so its stock comes out through the normal order path and its
   * food cost is booked by the drawer's close — and comped in full, with a
   * manager PIN. The staff-meal log (/trustops/staff-meals) is the record of
   * these comps.
   */
  staffMeal?: { staffId: string }
}

async function isMemberOf(userId: string, tenantId: string): Promise<boolean> {
  const u = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] },
    select: { id: true },
  })
  return !!u
}

/**
 * Comp (part of) an order: on the house, no payment expected, tracked as a
 * P&L line (7030 Comps through the shift's journal entry).
 *
 * This is the ONE comp engine. The 'comp' tender on POST /pos/payments and on
 * check-split is gone: it had no RefundPolicy cap, no manager PIN, no audit
 * and no owner notify. Here the comp is capped and PIN-approved, sits on the
 * drawer it was rung on (so the Z-report's comps and the shift JE's 7030 line
 * see it — a comp with no drawer left the order's revenue on the close with
 * only the cash debited), can never exceed what is still due, and settles the
 * order exactly like a paid sale once it is covered (applyCoverageTx).
 *
 * Staff meals are comps too (owner decision 11) — see CompInput.staffMeal.
 */
export async function compOrder(input: CompInput) {
  assertAmountsFit(input.amountCents)
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: {
      concept: { select: { tenantId: true } },
      items: { select: { name: true, quantity: true, menuItemId: true, status: true } },
    },
  })
  if (!order) throw new NotFoundError('Order', input.orderId)
  if (['cancelled', 'rejected', 'refunded'].includes(order.status)) {
    throw new AppError('ORDER_NOT_OPEN', `Cannot comp a ${order.status} order`, 422)
  }
  const tenantId = order.concept.tenantId
  const reason = input.staffMeal ? `staff_meal: ${input.reason}` : input.reason

  const policy = await getRefundPolicy(tenantId)
  let { approverId } = await ensureCapOrManagerOverride(
    input.amountCents,
    policy.cashierCompLimitCents,
    policy.managerCompLimitCents,
    policy,
    input.reason,
    input.photoUrl,
    input.actorRole,
    input.managerOverridePin,
    'comp',
    tenantId,
    { actorId: input.actorId, orderId: input.orderId },
  )

  if (input.staffMeal) {
    if (!tenantId) throw new AppError('NO_COMPANY', 'This brand is not bound to a company', 422)
    if (order.source !== 'pos') throw new AppError('STAFF_MEAL_AT_TILL', 'A staff meal is rung up at the till', 422)
    if (!(await isMemberOf(input.staffMeal.staffId, tenantId))) {
      throw new AppError('STAFF_NOT_IN_COMPANY', 'That staff member is not a member of this company', 422)
    }
    // Every staff meal is approved by a manager — at any amount — like the
    // manual log it replaces.
    if (!approverId && !isOverrideApprover(input.actorRole)) {
      if (!input.managerOverridePin) throw new AppError('MANAGER_OVERRIDE_REQUIRED', 'Manager PIN required for a staff meal', 403)
      const approver = await verifyManagerPin(input.managerOverridePin, tenantId, undefined, { actorId: input.actorId, orderId: input.orderId, action: 'staff_meal' })
      if (!approver) throw new AppError('INVALID_MANAGER_PIN', 'Manager PIN did not match any active manager', 403)
      approverId = approver.id
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    // What is still due, read under the order lock the payment takes too
    // (FOH-04) — a comp racing a payment, or a second comp, sees the first.
    // Comping a paid order used to overpay it.
    await lockOrderTx(tx, order.id)
    // §7.10: no comp while the card machine works on this bill.
    await assertNoActiveTerminalChargeTx(tx, order.id)
    const current = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true, totalCents: true, payments: { select: { status: true, amountCents: true } } },
    })
    assertTakesMoney(current.status)
    const alreadyPaid = coveredCents(current.payments)
    const due = current.totalCents - alreadyPaid
    if (due <= 0) throw new AppError('ALREADY_PAID', 'Order is already fully paid', 400)
    if (input.amountCents > due) {
      throw new AppError('COMP_EXCEEDS_DUE', `Comp of ${input.amountCents} exceeds the ${due} still due on this order`, 400)
    }
    if (input.staffMeal && input.amountCents !== due) {
      throw new AppError('STAFF_MEAL_IN_FULL', 'A staff meal is comped in full', 400)
    }

    // Comp = settlement at zero cost: a `comp` payment line for the amount,
    // on the drawer it was rung on. Why, and for whom, rides on the row.
    const payment = await tx.payment.create({
      data: {
        orderId: order.id,
        shiftId: input.shiftId,
        method: 'comp',
        amountCents: input.amountCents,
        status: 'paid',
        gateway: 'none',
        gatewayMeta: {
          comp: {
            kind: input.staffMeal ? 'staff_meal' : 'comp',
            reason: input.reason,
            approverId,
            ...(input.staffMeal && { staffId: input.staffMeal.staffId }),
          },
        },
        processedAt: new Date(),
      },
    })

    const coverage = await applyCoverageTx(tx, order.id, 'till')
    return { payment, coverage }
  }, { maxWait: 10_000, timeout: 15_000 })

  // The staff-meal log row — the view of this comp in /trustops/staff-meals,
  // costed at the plate cost the shift close books as COGS.
  let staffMealId: string | null = null
  if (input.staffMeal && tenantId) {
    const costCents = await cogsForSoldLines(order.items)
    const summary = order.items.filter((i) => i.status !== 'voided').map((i) => `${i.quantity}× ${i.name}`).join(', ')
    const meal = await prisma.staffMeal.create({
      data: {
        tenantId,
        staffId: input.staffMeal.staffId,
        approvedById: approverId ?? input.actorId,
        shiftId: input.shiftId,
        conceptId: order.conceptId,
        description: `Till order #${order.id.slice(0, 8)} — ${summary}`.slice(0, 200),
        estimatedCostCents: costCents,
        reason: 'shift_meal',
      },
    })
    staffMealId = meal.id
    await flagHeavyStaffMeals(input.staffMeal.staffId, tenantId, order.conceptId, approverId ?? input.actorId)
  }

  await audit({ category: 'identity',
    action: input.staffMeal ? 'order_staff_meal' : 'order_comp',
    entity: 'Order',
    entityId: input.orderId,
    userId: input.actorId,
    tenantId,
    metadata: { amountCents: input.amountCents, reason, photoUrl: input.photoUrl, approverId, paymentId: result.payment.id, shiftId: input.shiftId, staffMealId },
  })
  await notifyOwnerIfThreshold(input.amountCents, policy, 'comp', input.orderId, reason, input.actorId, tenantId)

  const fiscal = result.coverage.completedNow ? await afterTillSale(order.id, order.customerId, order.source) : null
  return { ...result.payment, orderCompleted: result.coverage.completedNow, staffMealId, ...tillFiscal(fiscal) }
}

/** The weekly staff-meal cap flag (PKR 2,000 per person per 7 days, per company). */
async function flagHeavyStaffMeals(staffId: string, tenantId: string, conceptId: string, approverId: string): Promise<void> {
  const since = new Date(Date.now() - 7 * 86_400_000)
  const agg = await prisma.staffMeal.aggregate({
    where: { staffId, tenantId, consumedAt: { gte: since } },
    _sum: { estimatedCostCents: true },
    _count: { _all: true },
  })
  const cumulative = agg._sum.estimatedCostCents ?? 0
  if (cumulative < 200_000) return
  const staff = await prisma.user.findUnique({ where: { id: staffId }, select: { name: true, role: true } })
  await flagException({
    tenantId,
    conceptId,
    kind: 'shrinkage',
    severity: cumulative >= 500_000 ? 'high' : 'medium',
    title: `Heavy staff meal log: ${staff?.name ?? 'staff'}`,
    description: `${staff?.name ?? 'Staff'} (${staff?.role ?? 'role unknown'}) has had PKR ${(cumulative / 100).toFixed(0)} in staff meals across ${agg._count._all} entries in the last 7 days. Confirm policy compliance.`,
    entityType: 'User',
    entityId: staffId,
    actorId: approverId,
    amountCents: cumulative,
    metadata: { weeklyTotal: cumulative, count: agg._count._all },
  })
}

// ─── Refund — the ONE refund engine ──────────────────────────────────────────
//
// /refunds, the order page and the till all refund through here. What it does:
//   • RefundPolicy caps + manager PIN above the cashier's cap; reason required.
//   • Any amount up to what is still refundable (partial refunds allowed).
//   • The refundable base is what was received: paid tenders (comps are not
//     money and are never refunded). A completed online order whose payment
//     row nothing ever settled (storefront cash-on-delivery, online card) is
//     refundable up to its pending rows — the order completed, so the
//     customer paid.
//   • A CASH refund leaves the drawer that is open NOW (owner decision 3) —
//     the refunding cashier's own open drawer, or the one named — and is
//     recorded on that shift, so its Z-report and expected cash see it. The
//     sale's own drawer is usually closed and posted already. Card / QR
//     refunds sit on the refunder's open drawer when there is one.
//   • The refund row and its journal entry ('order.refund', orderPosting.ts)
//     are written in ONE transaction: a refund the ledger refuses (closed
//     period, unbalanced) is not recorded either.
//   • Refunded in full → status 'refunded' through the order state machine,
//     which restores loyalty points, wallet credit and gift-card balance,
//     issues the credit note, fires the webhook and tells the customer.
//   • The fiscal return (spec D4): a refund FiscalDocument inserted in the
//     SAME transaction as the negative Payment — it files with the fiscal POS
//     once the sale has its number (waiting until then). The tip share is
//     taken out of the taxable return in the document (buildRefundPayload,
//     pro rata — a tip was never part of the sale filed). Nothing else
//     enqueues a refund document.

export interface RefundInput extends CompRefundInput {
  /** The open drawer a cash refund leaves from. Defaults to the actor's own open drawer. */
  shiftId?: string | null
  /** How the money goes back. Defaults to the tender of the most recent receipt. */
  method?: 'cash' | 'card' | 'keenu_qr'
  /** Card machine (server only, connectors/terminal): the refund went back through this gateway. */
  gateway?: PaymentGateway
  /** Card machine: the processor's reference for the refund. */
  gatewayRef?: string
  /** Card machine: the refund TerminalCharge this books (persisted in gatewayMeta). */
  terminalChargeId?: string
}

const REFUNDABLE_TENDERS = new Set(['cash', 'card', 'keenu_qr'])
const DIGITAL_TENDERS = new Set(['card', 'keenu_qr'])
export type RefundMethod = 'cash' | 'card' | 'keenu_qr'

/**
 * What an order can still give back, from its payment rows. The ONE
 * computation — run on the pre-read (fast refusals before a PIN prompt) and
 * again under the order lock inside the refund's transaction (FOH-05), which
 * is the one that counts.
 *
 *   - The base is money received: paid tenders. A completed online order
 *     whose CARD / QR row the gateway never confirmed counts its pending
 *     digital rows (the order completed, so the customer paid the processor).
 *   - BOOKS-05: uncollected cash never counts. A cash-on-delivery / pickup
 *     row still 'pending' is cash the rider or counter has not paid into a
 *     drawer — refunding it out of a drawer handed over money the drawer never
 *     received and left the 1010 debit from order.complete stranded.
 *   - ONL-16: a refund goes back the way the money came, up to what came that
 *     way — choosing 'card' on a cash sale booked a card refund nobody got.
 */
function refundableOf(payments: Array<Pick<Payment, 'method' | 'status' | 'amountCents' | 'processedAt' | 'createdAt'>>, source: string) {
  const receipts = payments.filter((p) => p.status === 'paid' && p.amountCents > 0 && REFUNDABLE_TENDERS.has(p.method))
  const pendingDigital = payments.filter((p) => p.status === 'pending' && p.amountCents > 0 && DIGITAL_TENDERS.has(p.method))
  const uncollectedCash = payments.filter((p) => p.status === 'pending' && p.amountCents > 0 && p.method === 'cash')
  const base = receipts.length > 0
    ? receipts
    : source !== 'pos' ? pendingDigital : []
  const paidTotal = base.reduce((s, p) => s + p.amountCents, 0)
  const refunds = payments.filter((p) => p.status === 'refunded')
  const alreadyRefunded = refunds.reduce((s, p) => s + Math.abs(p.amountCents), 0)
  const byMethod = new Map<string, number>()
  for (const p of base) byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amountCents)
  for (const r of refunds) byMethod.set(r.method, (byMethod.get(r.method) ?? 0) - Math.abs(r.amountCents))
  const latest = [...base].sort((a, b) => +(b.processedAt ?? b.createdAt) - +(a.processedAt ?? a.createdAt))[0]
  return {
    base,
    paidTotal,
    alreadyRefunded,
    refundable: paidTotal - alreadyRefunded,
    /** Still refundable per tender. */
    byMethod,
    tenders: [...new Set(base.map((p) => p.method))],
    latestMethod: (latest?.method ?? null) as RefundMethod | null,
    uncollectedCashCents: base.length === 0 ? uncollectedCash.reduce((s, p) => s + p.amountCents, 0) : 0,
  }
}

/**
 * Card refunds the card machine has given (or is giving) back on this order
 * that no refund Payment books yet — TerminalCharge kind 'refund' with no
 * paymentId, still in flight. THE one count, shared by the manual refund
 * (refundOrder, under the order lock — W4-MONEY-3) and the card-machine
 * refund's own start (connectors/terminal startTerminalRefund), so the two
 * refund paths never give the same money back twice.
 *
 *   - `exceptChargeId`: the refund charge being booked right now.
 *   - `includeNeedsAttention`: a refund the machine gave but servd refused to
 *     book (needs_attention) is money already back on the card. A new machine
 *     refund counts it; the manual refund does not — booking it by hand is
 *     exactly what its alert asks for.
 */
export async function inFlightTerminalRefundCents(
  db: Tx | typeof prisma,
  orderId: string,
  opts: { exceptChargeId?: string | null; includeNeedsAttention?: boolean } = {},
): Promise<number> {
  const statuses: TerminalChargeStatus[] = ['pending', 'sent', 'approved', 'cancel_requested', 'unknown', ...(opts.includeNeedsAttention ? ['needs_attention' as const] : [])]
  const agg = await db.terminalCharge.aggregate({
    where: { orderId, kind: 'refund', paymentId: null, status: { in: statuses }, ...(opts.exceptChargeId && { id: { not: opts.exceptChargeId } }) },
    _sum: { amountCents: true },
  })
  return Math.max(0, agg._sum.amountCents ?? 0)
}

/** What is still refundable once card refunds in flight on the machine are counted (they go back to the card). */
function withInFlight(state: ReturnType<typeof refundableOf>, inFlightCardCents: number): ReturnType<typeof refundableOf> {
  if (inFlightCardCents <= 0) return state
  const byMethod = new Map(state.byMethod)
  byMethod.set('card', (byMethod.get('card') ?? 0) - inFlightCardCents)
  return { ...state, refundable: state.refundable - inFlightCardCents, byMethod }
}

function assertRefundable(state: ReturnType<typeof refundableOf>, amountCents: number, method: RefundMethod): void {
  if (state.uncollectedCashCents > 0) {
    throw new AppError(
      'CASH_NOT_PAID_IN',
      'The cash for this order has not been paid into a drawer yet — pay it in (POS → cash due) first, then refund it from the drawer',
      422,
    )
  }
  if (amountCents > state.refundable) {
    throw new AppError(
      'REFUND_EXCEEDS_PAID',
      state.alreadyRefunded > 0
        ? `Refund of ${amountCents} exceeds the ${state.refundable} still refundable (paid ${state.paidTotal}, already refunded ${state.alreadyRefunded})`
        : `Refund of ${amountCents} exceeds paid total of ${state.paidTotal}`,
      400,
    )
  }
  if (!state.tenders.includes(method)) {
    throw new AppError(
      'REFUND_METHOD_NOT_TENDERED',
      `This order was paid by ${state.tenders.join(' + ') || 'nothing refundable'} — refund it the same way, not by ${method}`,
      422,
    )
  }
  const left = state.byMethod.get(method) ?? 0
  if (amountCents > left) {
    throw new AppError('REFUND_EXCEEDS_TENDER', `Only ${Math.max(0, left)} paid by ${method} is still refundable`, 400)
  }
}

/**
 * THE refund row and its journal entry, inside the caller's (order-locked)
 * transaction: a negative 'refunded' payment on the drawer the money leaves
 * from, posted as 'order.refund' (orderPosting.ts postRefundPayment) — a
 * refund the ledger refuses is not recorded either. Shared by refundOrder
 * and a void on a paid, still-open order (TILL-R3).
 */
async function writeRefundTx(tx: Tx, r: {
  orderId: string
  shiftId: string | null
  method: RefundMethod
  amountCents: number
  reason: string
  approverId: string | null
  actorId: string
  voidedItemId?: string
  /** How the row is booked; default postRefundPayment. (A cancelled ticket's hand-back: bookCancelledHandBackTx.) */
  post?: (tx: Tx, refundPaymentId: string) => Promise<{ entryId: string | null; reason?: string }>
  /** Card machine refunds: the gateway, its reference and the refund charge. */
  gateway?: PaymentGateway
  gatewayRef?: string | null
  terminalChargeId?: string | null
}): Promise<{ payment: Payment; entryId: string }> {
  const payment = await tx.payment.create({
    data: {
      orderId: r.orderId,
      shiftId: r.shiftId,
      method: r.method,
      amountCents: -r.amountCents,
      status: 'refunded',
      gateway: r.gateway ?? 'none',
      gatewayRef: r.gatewayRef?.trim() || null,
      gatewayMeta: {
        refund: { reason: r.reason, approverId: r.approverId, actorId: r.actorId, ...(r.voidedItemId && { voidedItemId: r.voidedItemId }) },
        ...(r.terminalChargeId && { terminalChargeId: r.terminalChargeId }),
      },
      processedAt: new Date(),
    },
  })
  const posted = r.post
    ? await r.post(tx, payment.id)
    : await postRefundPayment(payment.id, { tx, postedBy: r.actorId })
  if (!posted.entryId) {
    throw new AppError('REFUND_NOT_POSTED', `The refund could not be booked: ${posted.reason ?? 'unknown'}`, 422)
  }
  return { payment, entryId: posted.entryId }
}

/**
 * TILL-R4: the part of a tender refund that is a return of the taxable sale.
 * (The fiscal refund document splits the tip out the same way, pro rata, in
 * connectors/fiscal/payload buildRefundPayload.) The tip is on Order.totalCents and on the tender
 * (FOH-14) but is staff money, never filed as sale value — refunding a tipped
 * bill used to file the tip as a return and reclaim GST on it. Cumulative,
 * like the ledger's refund shares (orderPosting.refundShareOf): each refund
 * takes round(T·(prior+this)/total) − round(T·prior/total) of the taxable
 * T = total − tip, so a series of refunds never returns more than was sold.
 */
export function taxableRefundCents(order: { totalCents: number; tipCents: number | null }, priorCents: number, thisCents: number): number {
  const total = order.totalCents
  const tip = Math.max(0, order.tipCents ?? 0)
  if (thisCents <= 0) return 0
  if (total <= 0 || tip <= 0) return thisCents
  const taxable = Math.max(0, total - tip)
  const upTo = Math.min(total, priorCents + thisCents)
  const from = Math.min(total, priorCents)
  return Math.round((taxable * upTo) / total) - Math.round((taxable * from) / total)
}

function assertRefundableStatus(status: string): void {
  if (status === 'refunded') throw new AppError('ALREADY_REFUNDED', 'This order has been refunded in full', 409)
  // (A cancelled / rejected ticket never reaches here: refundOrder hands back
  // what it took through refundDueOnCancelledTicket — LEDGER-R5.)
  if (status !== 'completed') {
    throw new AppError(
      'NOT_REFUNDABLE',
      `A ${status} order has not been sold yet — cancel it instead (POST /orders/:id/cancel)`,
      422,
    )
  }
}

/**
 * Every refusal refundOrder would make when booking a refund — the order's
 * status, what is still refundable by that tender, the company's RefundPolicy
 * (reason, photo) and the actor's own cap — WITHOUT writing anything. The
 * card-machine refund (connectors/terminal) runs it BEFORE the machine gives
 * money back, so an approved card refund is never one servd then refuses to
 * book. `extraInFlightCents` counts refunds already on their way back through
 * the machine but not booked yet (no refund Payment exists for them).
 *
 * The machine flow has no manager-PIN step (a PIN cannot be carried to the
 * booking), so above the actor's own cap it answers MANAGER_OVERRIDE_REQUIRED
 * (a manager who can approve it must start it) or OVER_CAP.
 */
export async function assertRefundAllowed(input: {
  orderId: string
  amountCents: number
  method: RefundMethod
  reason: string
  photoUrl?: string
  actorRole: string
  tenantId: string
  extraInFlightCents?: number
}): Promise<void> {
  if (input.amountCents <= 0) throw new AppError('INVALID_AMOUNT', 'Refund amount must be positive', 400)
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, include: { payments: true } })
  if (!order) throw new NotFoundError('Order', input.orderId)
  assertRefundableStatus(order.status)
  // Card refunds in flight on the machine (inFlightTerminalRefundCents) — the
  // caller counts them under its order lock and passes them in.
  const state = withInFlight(refundableOf(order.payments, order.source), Math.max(0, input.extraInFlightCents ?? 0))
  assertRefundable(state, input.amountCents, input.method)

  const policy = await getRefundPolicy(input.tenantId)
  if (policy.requireReason && input.reason.trim().length === 0) throw new AppError('REASON_REQUIRED', 'Reason required by policy', 400)
  if (policy.requirePhotoEvidence && !input.photoUrl) throw new AppError('PHOTO_REQUIRED', 'Photo evidence required by policy', 400)
  const approver = isOverrideApprover(input.actorRole)
  const cap = approver ? policy.managerRefundLimitCents : policy.cashierRefundLimitCents
  if (input.amountCents <= cap) return
  if (approver) throw new AppError('OVER_CAP', `Amount ${input.amountCents} exceeds the ${cap} cap for refund`, 403)
  throw new AppError('MANAGER_OVERRIDE_REQUIRED', `A refund above ${cap} must be started by a manager who can approve refunds`, 403)
}

/**
 * Which drawer a refund leaves from: the one named (the route checked it is an
 * open drawer of this company), else the refunder's own open drawer here. A
 * cash refund without one is refused.
 */
async function refundDrawerOf(input: RefundInput, tenantId: string, method: RefundMethod): Promise<string | null> {
  let shiftId = input.shiftId ?? null
  if (!shiftId) {
    const own = await prisma.shift.findFirst({
      where: { userId: input.actorId, status: 'open', ...shiftOfCompany({ tenantId }) },
      orderBy: { openedAt: 'desc' },
      select: { id: true },
    })
    shiftId = own?.id ?? null
  }
  if (method === 'cash' && !shiftId) {
    throw new AppError(
      'OPEN_DRAWER_REQUIRED',
      'A cash refund comes out of an open drawer — open a shift (or pick the open drawer the cash is leaving) first',
      422,
    )
  }
  return shiftId
}

type DuePayment = Pick<Payment, 'method' | 'status' | 'amountCents' | 'gatewayRef' | 'shiftId' | 'processedAt' | 'createdAt'>

/**
 * LEDGER-R5: what a cancelled / rejected ticket still owes back, by tender.
 * The total is refundDueCents (accounting/orderPosting.ts — drawer receipts
 * less refunds already handed back); per tender it is the same receipts and
 * refunds split by method, so the money goes back the way it came (ONL-16):
 * a card refund of cash taken would clear 1110 against 1030 while the cash
 * sat in the drawer.
 */
function refundDueOf(order: { status: string; payments: DuePayment[] }) {
  const due = refundDueCents(order)
  const taken = order.payments.filter((p) => p.amountCents > 0 && !!p.shiftId && REFUNDABLE_TENDERS.has(p.method) && isShiftReceipt(p))
  const refunds = order.payments.filter((p) => p.status === 'refunded' && p.amountCents < 0)
  const byMethod = new Map<string, number>()
  for (const p of taken) byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amountCents)
  for (const r of refunds) byMethod.set(r.method, (byMethod.get(r.method) ?? 0) - Math.abs(r.amountCents))
  const latest = [...taken].sort((a, b) => +(b.processedAt ?? b.createdAt) - +(a.processedAt ?? a.createdAt))[0]
  return {
    due,
    alreadyRefunded: refunds.reduce((t, r) => t + Math.abs(r.amountCents), 0),
    byMethod,
    tenders: [...new Set(taken.map((p) => p.method))],
    latestMethod: (latest?.method ?? null) as RefundMethod | null,
  }
}

function assertRefundDue(state: ReturnType<typeof refundDueOf>, amountCents: number, method: RefundMethod): void {
  if (state.due <= 0) throw new AppError('NOTHING_TO_REFUND', 'No money was taken on this ticket at the till', 422)
  if (amountCents > state.due) {
    throw new AppError('REFUND_EXCEEDS_DUE', `Refund of ${amountCents} exceeds the ${state.due} still owed back on this cancelled ticket`, 422)
  }
  if (!state.tenders.includes(method)) {
    throw new AppError(
      'REFUND_METHOD_NOT_TENDERED',
      `The money on this ticket was taken by ${state.tenders.join(' + ') || 'nothing refundable'} — hand it back the same way, not by ${method}`,
      422,
    )
  }
  const left = state.byMethod.get(method) ?? 0
  if (amountCents > left) {
    throw new AppError('REFUND_EXCEEDS_TENDER', `Only ${Math.max(0, left)} taken by ${method} is still owed back`, 400)
  }
}

// ─── R5-A / R5-B / R5-C: the books of a cancelled ticket ───────────────────
//
// Money taken on a ticket that is then cancelled is owed back. Where the books
// hold it depends on what was posted BEFORE the cancel:
//   • a drawer still open (or closed but not yet posted) when the ticket was
//     cancelled will hold its receipts as a refund due — its close credits
//     1110 per order, gross (shiftPosting, FOH-09); so does a close that was
//     posted after the cancel;
//   • a drawer whose close was posted BEFORE the cancel treated the ticket as
//     live. A till ticket's home drawer booked the SALE (revenue, service
//     charge, tip, tax, discount, wallet, gift cards, comps; the unpaid rest
//     Dr 1110) and any other drawer cleared 1110 with its receipts (R5-C). A
//     non-till ticket's cash was moved 1010 → 1015 as non-till cash (Cr 1010,
//     with nothing ever debiting 1010 for it), and its card receipts were
//     booked nowhere (R5-A);
//   • a refund taken while the ticket was still open (a TILL-R3 void) was
//     booked as a sale refund — revenue and tax shares (R5-B).
// None of that is a sale once the ticket is cancelled. So, once per order,
// the UNWIND ('order.cancel_unwind:<orderId>') reverses every sale-side line
// those postings made for the ticket — what a pre-cancel close booked for it,
// re-derived with the close's OWN formula (summariseShiftSales) on this order,
// and the non-money lines of its earlier refund entries, read from the ledger
// — into where the money is now owed from. Each hand-back ('order.refund:
// <refundId>') then debits where its tender's money is parked — 1010 (cash) /
// 1030 (card) up to what a pre-cancel close left there for a non-till ticket,
// the rest 1110 — and credits the drawer or card it leaves by. Together they
// net revenue, tax, wallet, gift card, comps, 1110 and 1010 to zero for the
// ticket once all of it is handed back, in any order of close, void, cancel
// and hand-back. (COGS a close booked stays booked — the food was made, as on
// any refund.) The simple case — every receipt on a drawer that closes after
// the cancel — is exactly LEDGER-R5's Dr 1110 / Cr drawer, and no unwind.

export const CANCEL_UNWIND_SOURCE = 'order.cancel_unwind'

/** Where a cancelled ticket's money sits: balanced against, never unwound. */
const MONEY_ACCOUNTS: ReadonlySet<string> = new Set([ACCT.CASH_ON_HAND, ACCT.CASH_DRAWER, ACCT.CARD_RECEIVABLE, ACCT.CUSTOMER_AR])
type ParkKey = 'cash' | 'card'
const parkKeyOf = (method: string): ParkKey => (method === 'cash' ? 'cash' : 'card')
/** A non-till ticket's receipts a pre-cancel close left outside 1110: cash Cr 1010; card booked nowhere (1030 nets itself). */
const PARK_ACCOUNT: Record<ParkKey, string> = { cash: ACCT.CASH_ON_HAND, card: ACCT.CARD_RECEIVABLE }

const CANCELLED_BOOKS_SELECT = {
  id: true, status: true, source: true, conceptId: true,
  totalCents: true, walletAmountCents: true, taxCents: true, discountCents: true,
  promoDiscountCents: true, serviceChargeCents: true, tipCents: true,
  concept: { select: { id: true, slug: true, province: true, srbPosId: true, tenantId: true } },
  payments: { select: { id: true, shiftId: true, method: true, status: true, amountCents: true, gatewayRef: true, gatewayMeta: true, createdAt: true } },
  giftCardRedemptions: { select: { amountCents: true } },
} as const
type CancelledBooksOrder = Prisma.OrderGetPayload<{ select: typeof CANCELLED_BOOKS_SELECT }>

/** A line before it is a JournalLineInput: + debit, − credit. */
type SignedLine = { accountCode: string; cents: number; conceptId: string | null; memo: string }

/** Signed lines → journal lines, netted per account + brand (zero nets dropped). */
function toJournalLines(signed: SignedLine[]): JournalLineInput[] {
  const net = new Map<string, SignedLine>()
  for (const l of signed) {
    const k = `${l.accountCode}|${l.conceptId ?? ''}`
    const cur = net.get(k)
    if (cur) cur.cents += l.cents
    else net.set(k, { ...l })
  }
  return [...net.values()]
    .filter((l) => l.cents !== 0)
    .map((l) => ({ accountCode: l.accountCode, type: l.cents > 0 ? 'debit' as const : 'credit' as const, amountCents: Math.abs(l.cents), memo: l.memo, conceptId: l.conceptId }))
}

/** The order's refund rows other than `except`, and the entries that booked them. */
async function refundEntriesTx(tx: Tx, tenantId: string, order: CancelledBooksOrder, except: string | null) {
  const rows = order.payments.filter((p) => p.status === 'refunded' && p.amountCents < 0 && p.id !== except)
  if (rows.length === 0) return []
  const entries = await tx.journalEntry.findMany({
    where: { tenantId, reference: { in: rows.map((r) => `order.refund:${r.id}`) } },
    select: { reference: true, lines: { select: { type: true, amountCents: true, conceptId: true, account: { select: { code: true } } } } },
  })
  const byRef = new Map(entries.map((e) => [e.reference, e.lines]))
  return rows.map((r) => ({ row: r, lines: byRef.get(`order.refund:${r.id}`) ?? [] }))
}

/**
 * What the cancelled ticket's pre-cancel postings left to undo: the sale-side
 * lines to reverse (signed), the debit each earlier sale-refund's reversal
 * needs (by its tender), and what a pre-cancel close parked outside 1110 for a
 * non-till ticket (by tender).
 */
async function cancelledTicketBooksTx(tx: Tx, tenantId: string, order: CancelledBooksOrder, exceptRefundId: string | null) {
  const reverse: SignedLine[] = []
  const shareDebits: Array<{ key: ParkKey; cents: number }> = []
  const parked: Record<ParkKey, number> = { cash: 0, card: 0 }
  const id8 = order.id.slice(0, 8)

  const receipts = order.payments.filter((p) => p.amountCents > 0 && !!p.shiftId && isShiftReceipt(p))
  const drawers = [...new Set(receipts.map((p) => p.shiftId!))]
  const closes = drawers.length === 0 ? [] : await tx.journalEntry.findMany({
    where: { tenantId, reference: { in: drawers.map((d) => `shift.close:${d}`) } },
    select: { id: true, reference: true },
  })
  let legacyCard: boolean | null = null
  for (const close of closes) {
    const shiftId = close.reference!.slice('shift.close:'.length)
    // This close saw the ticket cancelled: it holds the receipts as a refund due (Cr 1110).
    const dueLine = await tx.journalLine.findFirst({
      where: {
        journalEntryId: close.id, type: 'credit', account: { tenantId, code: ACCT.CUSTOMER_AR },
        AND: [{ memo: { startsWith: REFUND_DUE_PREFIX } }, { memo: { contains: order.id } }],
      },
      select: { id: true },
    })
    if (dueLine) continue
    const here = receipts.filter((p) => p.shiftId === shiftId && p.method !== 'comp')

    if (order.source !== 'pos') {
      // Non-till: its cash moved 1010 → 1015 (Cr 1010); its card was booked nowhere.
      for (const p of here) parked[parkKeyOf(p.method)] += p.amountCents
      continue
    }

    // A till ticket, as this close booked it while it was live — the close's own formula.
    if (legacyCard === null) {
      // A sale booked before ONL-05 has no 2080 debit naming the order (orderPosting.saleBookingOf).
      legacyCard = giftCardAppliedOf(order.giftCardRedemptions) > 0 && !(await tx.journalLine.findFirst({
        where: { type: 'debit', account: { tenantId, code: GIFT_CARD_LIABILITY }, journalEntry: { tenantId }, memo: { contains: order.id } },
        select: { id: true },
      }))
    }
    const { status: _cancelled, concept, ...live } = order
    void _cancelled
    const asLive = { ...live, concept: { id: concept.id, slug: concept.slug, province: concept.province, srbPosId: concept.srbPosId }, giftCardRedemptions: legacyCard ? [] : order.giftCardRedemptions }
    const anyRow = receipts.find((p) => p.shiftId === shiftId)!
    const s = summariseShiftSales(shiftId, [{ ...anyRow, orderId: order.id, order: asLive }])
    const memo = `Cancelled order ${order.id} — undo what drawer ${shiftId.slice(0, 8)} booked for it`
    const add = (accountCode: string, cents: number) => { if (cents !== 0) reverse.push({ accountCode, cents, conceptId: order.conceptId, memo }) }
    add(ACCT.COMPS, -s.compCents)               // the close debited 7030
    add(ACCT.CASH_VARIANCE, s.roundingCents)    // + = the close credited 8010
    const b = s.byConcept.get(order.conceptId)
    if (b) {
      // The home drawer booked the sale. The tax goes back to the account it was credited to (LEDGER-R2).
      const taxLine = await tx.journalLine.findFirst({
        where: { journalEntryId: close.id, type: 'credit', conceptId: order.conceptId, account: { tenantId, code: { in: [...OUTPUT_TAX_ACCOUNTS] } } },
        select: { account: { select: { code: true } } },
      })
      const taxAccount = await refundTaxAccountFor(tx as typeof prisma, tenantId, order, taxLine?.account.code ?? b.taxAccountCode, b.taxCents)
      add(revenueCodeForConcept(concept.slug), b.revenueCents)
      add(ACCT.SERVICE_CHARGE_REVENUE, b.serviceChargeCents)
      add(ACCT.TIPS_PAYABLE, b.tipCents)
      add(taxAccount, b.taxCents)
      add(ACCT.DISCOUNTS, -b.discountCents)
      add(ACCT.WALLET_LIABILITY, -b.walletAppliedCents)     // the cancel gave the wallet back
      add(GIFT_CARD_LIABILITY, -b.giftCardAppliedCents)     // … and the cards
    }
  }

  // Refunds booked as sale refunds while the ticket was live (TILL-R3 voids):
  // their non-money lines are reversed; the money they moved stays as it is.
  for (const { row, lines } of await refundEntriesTx(tx, tenantId, order, exceptRefundId)) {
    let net = 0
    for (const l of lines) {
      if (MONEY_ACCOUNTS.has(l.account.code)) continue
      const signed = l.type === 'debit' ? l.amountCents : -l.amountCents
      net += signed
      reverse.push({ accountCode: l.account.code, cents: -signed, conceptId: l.conceptId, memo: `Cancelled order ${order.id} — refund ${row.id.slice(0, 8)} was booked as a sale refund (#${id8})` })
    }
    if (net !== 0) shareDebits.push({ key: parkKeyOf(row.method), cents: net })
  }
  return { reverse, shareDebits, parked }
}

/** Debits on 1010 / 1030 this ticket's own unwind and hand-backs already made against what a close parked there. */
async function parkedUsedTx(tx: Tx, tenantId: string, order: CancelledBooksOrder, exceptRefundId: string | null): Promise<Record<ParkKey, number>> {
  const used: Record<ParkKey, number> = { cash: 0, card: 0 }
  const refs = [
    `${CANCEL_UNWIND_SOURCE}:${order.id}`,
    ...order.payments.filter((p) => p.status === 'refunded' && p.amountCents < 0 && p.id !== exceptRefundId).map((p) => `order.refund:${p.id}`),
  ]
  const rows = await tx.journalLine.groupBy({
    by: ['accountId'],
    _sum: { amountCents: true },
    where: { type: 'debit', account: { tenantId, code: { in: [PARK_ACCOUNT.cash, PARK_ACCOUNT.card] } }, journalEntry: { tenantId, reference: { in: refs } } },
  })
  if (rows.length === 0) return used
  const accounts = await tx.account.findMany({ where: { id: { in: rows.map((r) => r.accountId) } }, select: { id: true, code: true } })
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]))
  for (const r of rows) {
    const code = codeOf.get(r.accountId)
    if (code === PARK_ACCOUNT.cash) used.cash += r._sum.amountCents ?? 0
    else if (code === PARK_ACCOUNT.card) used.card += r._sum.amountCents ?? 0
  }
  return used
}

/** Takes up to `cents` from what is left parked under `key`; the rest is 1110. */
function takeParked(left: Record<ParkKey, number>, key: ParkKey, cents: number): Array<{ accountCode: string; cents: number }> {
  const fromPark = Math.max(0, Math.min(left[key], cents))
  left[key] -= fromPark
  return [{ accountCode: PARK_ACCOUNT[key], cents: fromPark }, { accountCode: ACCT.CUSTOMER_AR, cents: cents - fromPark }]
}

/**
 * Post the cancelled ticket's unwind, once (idempotent on the order). Inside
 * the caller's order-locked transaction. Nothing to undo → no entry.
 */
async function postCancelledUnwindTx(tx: Tx, order: CancelledBooksOrder, tenantId: string, postedBy: string, exceptRefundId: string | null): Promise<string | null> {
  const ref = `${CANCEL_UNWIND_SOURCE}:${order.id}`
  const existing = await tx.journalEntry.findFirst({ where: { tenantId, reference: ref }, select: { id: true } })
  if (existing) return existing.id
  const books = await cancelledTicketBooksTx(tx, tenantId, order, exceptRefundId)
  if (books.reverse.length === 0) return null
  const left = { ...books.parked }
  const used = await parkedUsedTx(tx, tenantId, order, exceptRefundId)
  left.cash -= used.cash; left.card -= used.card
  const memo = `Cancelled order ${order.id} — owed back to the customer, not a sale`
  const signed: SignedLine[] = [...books.reverse]
  // Each reversed sale-refund share is debited where its tender's money is parked.
  for (const d of books.shareDebits) {
    for (const t of takeParked(left, d.key, d.cents)) signed.push({ ...t, conceptId: order.conceptId, memo })
  }
  // What the sale reversal leaves is the ticket's money, now owed back: 1110.
  const rest = signed.reduce((t, l) => t + l.cents, 0)
  signed.push({ accountCode: ACCT.CUSTOMER_AR, cents: -rest, conceptId: order.conceptId, memo })
  const lines = toJournalLines(signed)
  if (lines.length === 0) return null
  const res = await postJournalEntry({
    tenantId,
    sourceType: CANCEL_UNWIND_SOURCE,
    sourceId: order.id,
    description: `Cancelled order ${order.id.slice(0, 8)} (${order.concept.slug} / ${order.source}): what was booked as a sale before the cancel, undone`,
    postedBy,
    lines,
  }, { tx })
  return res.entryId
}

/**
 * The entry for ONE hand-back on a cancelled ticket ('order.refund', keyed on
 * the refund row, so the shift close skips it): the unwind first (once), then
 * Dr where this tender's money is parked / Cr the drawer or card it leaves by.
 */
async function bookCancelledHandBackTx(tx: Tx, refundPaymentId: string, postedBy: string): Promise<{ entryId: string | null; reason?: string }> {
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: refundPaymentId },
    select: { id: true, orderId: true, method: true, shiftId: true, amountCents: true, processedAt: true },
  })
  const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId }, select: CANCELLED_BOOKS_SELECT })
  const tenantId = order.concept.tenantId
  if (!tenantId) return { entryId: null, reason: 'concept_has_no_company' }
  if (order.status !== 'cancelled' && order.status !== 'rejected') return { entryId: null, reason: 'not_cancelled' }

  await postCancelledUnwindTx(tx, order, tenantId, postedBy, payment.id)

  const amount = Math.abs(payment.amountCents)
  const books = await cancelledTicketBooksTx(tx, tenantId, order, payment.id)
  const used = await parkedUsedTx(tx, tenantId, order, payment.id)
  const left: Record<ParkKey, number> = { cash: books.parked.cash - used.cash, card: books.parked.card - used.card }
  const memo = `Refund due handed back — cancelled order ${order.id}`
  const signed: SignedLine[] = takeParked(left, parkKeyOf(payment.method), amount)
    .map((t) => ({ ...t, conceptId: order.conceptId, memo }))
  signed.push({ accountCode: refundCreditAccount(payment), cents: -amount, conceptId: order.conceptId, memo })
  // Dr 1030 / Cr 1030 for card a pre-cancel close never booked must stay two lines, so no netting here.
  const lines: JournalLineInput[] = signed
    .filter((l) => l.cents !== 0)
    .map((l) => ({ accountCode: l.accountCode, type: l.cents > 0 ? 'debit' as const : 'credit' as const, amountCents: Math.abs(l.cents), memo: l.memo, conceptId: l.conceptId }))
  const res = await postJournalEntry({
    tenantId,
    sourceType: 'order.refund',
    sourceId: payment.id,
    description: `Money taken on cancelled order ${order.id.slice(0, 8)} handed back (${order.concept.slug}, ${payment.method}) — not a sale`,
    entryDate: payment.processedAt ?? new Date(),
    postedBy,
    lines,
  }, { tx })
  return { entryId: res.entryId }
}

/**
 * The unwind on its own, for the cancel path: a cancelled ticket whose money
 * was all refunded before the cancel, or that took none, has no hand-back to
 * post it. Idempotent; takes the order lock. Returns the entry id, or null
 * when there was nothing to undo.
 */
export async function postCancelledTicketUnwind(orderId: string, postedBy = 'system'): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    await lockOrderTx(tx, orderId)
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: CANCELLED_BOOKS_SELECT })
    if (order.status !== 'cancelled' && order.status !== 'rejected') {
      throw new AppError('NOT_CANCELLED', 'Only a cancelled or rejected ticket is unwound', 422)
    }
    const tenantId = order.concept.tenantId
    if (!tenantId) throw new AppError('NO_COMPANY', 'This brand is not bound to a company', 422)
    return postCancelledUnwindTx(tx, order, tenantId, postedBy, null)
  }, { maxWait: 10_000, timeout: 15_000 })
}

/**
 * LEDGER-R5 — handing back money taken at the till on a ticket that was then
 * cancelled or rejected. It was never a sale: the shift close holds it as a
 * refund due (Cr 1110), and the refund row's own entry (bookCancelledHandBackTx)
 * clears exactly that (Dr 1110 / Cr 1015 drawer or 1030 card) — never revenue
 * or tax; whatever a pre-cancel close or a pre-cancel refund booked as a sale
 * is undone first, once (the unwind, R5-A/B/C above). So, unlike a sale's refund: the order STAYS cancelled (no 'refunded'
 * transition), postOrderRefund is not run (the cancel already restored points,
 * wallet and cards), and no SRB sales-return is filed — there was no sale —
 * unless an invoice WAS filed for it. Same caps / manager PIN and drawer as
 * any refund; the amount is capped at refundDueCents, re-checked under the
 * order lock.
 */
async function refundDueOnCancelledTicket(
  input: RefundInput,
  order: Order & { payments: Payment[] },
  tenantId: string,
) {
  const pre = refundDueOf(order)
  const method: RefundMethod = input.method ?? pre.latestMethod ?? 'cash'
  // Fast refusals before anyone is asked for a PIN; re-checked under the lock.
  assertRefundDue(pre, input.amountCents, method)

  const policy = await getRefundPolicy(tenantId)
  const { approverId } = await ensureCapOrManagerOverride(
    input.amountCents,
    policy.cashierRefundLimitCents,
    policy.managerRefundLimitCents,
    policy,
    input.reason,
    input.photoUrl,
    input.actorRole,
    input.managerOverridePin,
    'refund',
    tenantId,
    { actorId: input.actorId, orderId: input.orderId },
  )
  const shiftId = await refundDrawerOf(input, tenantId, method)

  const { refundPayment, entryId, state, fiscalDoc } = await prisma.$transaction(async (tx) => {
    await lockOrderTx(tx, input.orderId)
    const current = await tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      select: { status: true, payments: true },
    })
    const state = refundDueOf(current)
    assertRefundDue(state, input.amountCents, method)
    // Booked by where the money is parked, not as a sale refund (R5-A/B/C, above).
    const { payment: refundPayment, entryId } = await writeRefundTx(tx, {
      orderId: input.orderId, shiftId, method, amountCents: input.amountCents, reason: input.reason, approverId, actorId: input.actorId,
      post: (t, id) => bookCancelledHandBackTx(t, id, input.actorId),
      gateway: input.gateway, gatewayRef: input.gatewayRef, terminalChargeId: input.terminalChargeId,
    })
    // A cancelled ticket was never a sale, so nothing goes to the fiscal POS
    // (§17.1) — unless the sale WAS filed directly with SRB / FBR before the
    // connector, in which case its return must be filed by hand
    // (manual_required + an exception, owner flag e).
    const fiscalDoc = order.srbInvoiceNumber || order.fbrInvoiceNumber
      ? await enqueueFiscalRefundTx(tx, { orderId: input.orderId, tenantId, refundPaymentId: refundPayment.id, amountCents: input.amountCents, reason: input.reason, method })
      : null
    return { refundPayment, entryId, state, fiscalDoc }
  }, { maxWait: 10_000, timeout: 15_000 })

  if (fiscalDoc?.status === 'pending') void kickFiscal(fiscalDoc.id)
  const refundDueLeftCents = state.due - input.amountCents
  await audit({ category: 'identity',
    action: 'order_refund_due',
    entity: 'Order',
    entityId: input.orderId,
    userId: input.actorId,
    tenantId,
    before: { status: order.status, refundedCents: state.alreadyRefunded, refundDueCents: state.due },
    after: { status: order.status, refundedCents: state.alreadyRefunded + input.amountCents, refundDueCents: refundDueLeftCents },
    metadata: {
      amountCents: input.amountCents, method, shiftId, reason: input.reason, photoUrl: input.photoUrl, approverId, refundPaymentId: refundPayment.id, entryId,
      fiscalRefund: fiscalDoc ? { documentId: fiscalDoc.id, status: fiscalDoc.status } : null,
    },
  })
  await notifyOwnerIfThreshold(input.amountCents, policy, 'refund', input.orderId, input.reason, input.actorId, tenantId)
  const fiscalRefund = fiscalDoc ? await refundView(fiscalDoc.id) : null
  // srbReturnInvoiceNo: deprecated (spec §8.4), always null — the fiscal POS files returns now.
  return { ...refundPayment, entryId, orderRefunded: false, fiscalRefund, srbReturnInvoiceNo: null, refundDueLeftCents }
}

export async function refundOrder(input: RefundInput) {
  assertAmountsFit(input.amountCents)
  if (input.amountCents <= 0) throw new AppError('INVALID_AMOUNT', 'Refund amount must be positive', 400)
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: {
      payments: { orderBy: { createdAt: 'asc' } },
      concept: { select: { tenantId: true } },
    },
  })
  if (!order) throw new NotFoundError('Order', input.orderId)
  const tenantId = order.concept.tenantId
  // LEDGER-R5: a cancelled / rejected ticket that took money hands it back.
  if (order.status === 'cancelled' || order.status === 'rejected') {
    if (!tenantId) throw new AppError('NO_COMPANY', 'This brand is not bound to a company', 422)
    return refundDueOnCancelledTicket(input, order, tenantId)
  }
  assertRefundableStatus(order.status)
  if (!tenantId) throw new AppError('NO_COMPANY', 'This brand is not bound to a company', 422)

  // How the money goes back: as asked, else the tender of the latest receipt.
  // Card refunds the machine is giving back count as refunded (W4-MONEY-3).
  const pre = withInFlight(
    refundableOf(order.payments, order.source),
    await inFlightTerminalRefundCents(prisma, input.orderId, { exceptChargeId: input.terminalChargeId }),
  )
  const method: RefundMethod = input.method ?? pre.latestMethod ?? 'cash'
  // Fast refusals before anyone is asked for a PIN; re-checked under the lock.
  assertRefundable(pre, input.amountCents, method)

  const policy = await getRefundPolicy(tenantId)
  const { approverId } = await ensureCapOrManagerOverride(
    input.amountCents,
    policy.cashierRefundLimitCents,
    policy.managerRefundLimitCents,
    policy,
    input.reason,
    input.photoUrl,
    input.actorRole,
    input.managerOverridePin,
    'refund',
    tenantId,
    { actorId: input.actorId, orderId: input.orderId },
  )

  const shiftId = await refundDrawerOf(input, tenantId, method)

  const { refundPayment, entryId, state, fiscalDoc } = await prisma.$transaction(async (tx) => {
    // FOH-05: lock the order and recompute what is refundable from what is
    // committed NOW. Two refunds fired together each used to read "nothing
    // refunded yet" before either wrote, and both went through.
    await lockOrderTx(tx, input.orderId)
    const current = await tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      select: { status: true, source: true, payments: true },
    })
    assertRefundableStatus(current.status)
    // W4-MONEY-3: a card refund still on its way back through the machine
    // (not booked yet — it has no refund Payment) is money already promised
    // back; counted here, under the lock, so a manual refund can never give it
    // back a second time. The charge being booked now is not counted.
    const inFlight = await inFlightTerminalRefundCents(tx, input.orderId, { exceptChargeId: input.terminalChargeId })
    const state = withInFlight(refundableOf(current.payments, current.source), inFlight)
    assertRefundable(state, input.amountCents, method)

    const { payment: refundPayment, entryId } = await writeRefundTx(tx, {
      orderId: input.orderId, shiftId, method, amountCents: input.amountCents, reason: input.reason, approverId, actorId: input.actorId,
      gateway: input.gateway, gatewayRef: input.gatewayRef, terminalChargeId: input.terminalChargeId,
    })
    // The fiscal return, in THIS transaction with the negative Payment (D4):
    // it stands or falls with the refund. The whole tender amount is passed —
    // the document takes the tip share out of the taxable return pro rata.
    const fiscalDoc = await enqueueFiscalRefundTx(tx, {
      orderId: input.orderId, tenantId, refundPaymentId: refundPayment.id, amountCents: input.amountCents, reason: input.reason, method,
    })
    return { refundPayment, entryId, state, fiscalDoc }
  }, { maxWait: 10_000, timeout: 15_000 })
  const alreadyRefunded = state.alreadyRefunded
  const paidTotal = state.paidTotal

  // Refunded in full → the order's own terminal transition and its restores.
  const refundedInFull = alreadyRefunded + input.amountCents >= paidTotal
  if (refundedInFull) {
    const { updateOrderStatus } = await import('../orders/service.js')
    await updateOrderStatus(order.id, 'refunded').catch((err: Error) =>
      console.error(`[refund] status → refunded failed for ${order.id}: ${err.message}`))
  }

  // The fiscal return was queued in the refund's transaction; send it now
  // when its sale is already filed (a 'waiting' one is promoted when the sale
  // files). Redis down → the sweeper sends it.
  if (fiscalDoc?.status === 'pending') void kickFiscal(fiscalDoc.id)

  await audit({ category: 'identity',
    action: 'order_refund',
    entity: 'Order',
    entityId: input.orderId,
    userId: input.actorId,
    tenantId,
    before: { status: order.status, refundedCents: alreadyRefunded },
    after: { status: refundedInFull ? 'refunded' : order.status, refundedCents: alreadyRefunded + input.amountCents },
    metadata: {
      amountCents: input.amountCents, method, shiftId, reason: input.reason, photoUrl: input.photoUrl, approverId, refundPaymentId: refundPayment.id, entryId,
      ...(input.terminalChargeId && { terminalChargeId: input.terminalChargeId }),
      fiscalRefund: fiscalDoc ? { documentId: fiscalDoc.id, status: fiscalDoc.status } : null,
    },
  })
  await notifyOwnerIfThreshold(input.amountCents, policy, 'refund', input.orderId, input.reason, input.actorId, tenantId)
  const fiscalRefund = fiscalDoc ? await refundView(fiscalDoc.id) : null
  // srbReturnInvoiceNo: deprecated (spec §8.4), always null — the fiscal POS files returns now.
  return { ...refundPayment, entryId, orderRefunded: refundedInFull, fiscalRefund, srbReturnInvoiceNo: null }
}

/** A refund document as the till / refund screen shows it (staff view). */
async function refundView(documentId: string): Promise<FiscalView | null> {
  try {
    const { FISCAL_VIEW_SELECT, toFiscalView } = await import('../../connectors/fiscal/view.js')
    const row = await prisma.fiscalDocument.findUnique({ where: { id: documentId }, select: FISCAL_VIEW_SELECT })
    return row ? toFiscalView(row, { staff: true }) : null
  } catch {
    return null
  }
}

// ─── Drawer cash movements ───────────────────────────────────────────────────
//
// drop / add / pay-in move cash between the drawer and the safe; the shift
// close books each as its own balanced pair. A PAY-OUT to a vendor (owner
// decision 5) is allowed from the till with a manager PIN and under a cap,
// and is booked the way a petty-cash spend is: either against an open
// supplier bill (a cash SupplierPayment — Dr 2010 / Cr 1010 — plus the cash
// leaving the drawer, Dr 1010 / Cr 1015), or straight to its expense category
// (Dr 6xxx / Cr 1015). Each pay-out posts its own entry ('pos.payout', keyed
// on the movement), which the shift close then skips — pay-outs used to land
// on 8010 as "unclassified" for the accountant to dig out.

/** Default pay-out cap until OperationsConfig carries drawerPayoutCapCents. */
export const DEFAULT_DRAWER_PAYOUT_CAP_CENTS = 500_000 // PKR 5,000

export interface CashMovementInput {
  shiftId: string
  type: 'drop' | 'add' | 'payout' | 'payin'
  amountCents: number
  reason: string
  actorId: string
  actorRole: string
  managerOverridePin?: string
  /** Pay-out only: what it was spent on (PAYOUT_CATEGORIES). */
  category?: PayoutCategory
  /** Pay-out only: the open supplier bill this cash pays. */
  supplierBillId?: string | null
  vendorName?: string | null
  receiptUrl?: string | null
}

export async function recordCashMovement(input: CashMovementInput) {
  assertAmountsFit(input.amountCents)
  if (input.type !== 'payout') {
    return prisma.cashMovement.create({
      data: { shiftId: input.shiftId, type: input.type, amountCents: input.amountCents, reason: input.reason, recordedById: input.actorId },
    })
  }

  const shift = await prisma.shift.findUniqueOrThrow({
    where: { id: input.shiftId },
    include: { location: { select: { tenantId: true } }, user: { select: { tenantId: true } } },
  })
  const tenantId = shiftTenantId(shift)
  if (!tenantId) throw new AppError('SHIFT_HAS_NO_COMPANY', 'This drawer is not bound to a company', 422)

  const ops = await getOperationsConfig(tenantId)
  const configured = (ops as unknown as Record<string, unknown> | null)?.['drawerPayoutCapCents']
  const cap = typeof configured === 'number' ? configured : DEFAULT_DRAWER_PAYOUT_CAP_CENTS
  if (input.amountCents > cap) {
    throw new AppError('OVER_PAYOUT_CAP', `Pay-outs from the till are capped at PKR ${(cap / 100).toFixed(0)} — pay larger amounts from petty cash or the bank`, 403)
  }
  // The manager PIN, always — unless the person at the till is an approver.
  let approverId: string | null = null
  if (isOverrideApprover(input.actorRole)) approverId = input.actorId
  else {
    if (!input.managerOverridePin) throw new AppError('MANAGER_OVERRIDE_REQUIRED', 'Manager PIN required to pay a vendor from the till', 403)
    const approver = await verifyManagerPin(input.managerOverridePin, tenantId, undefined, { actorId: input.actorId, action: 'till_payout' })
    if (!approver) throw new AppError('INVALID_MANAGER_PIN', 'Manager PIN did not match any active manager', 403)
    approverId = approver.id
  }

  // What the cash pays: a supplier bill of this company, or an expense category.
  let bill: { id: string; supplierId: string; billNumber: string; supplierName: string } | null = null
  let expenseCode: string | null = null
  if (input.supplierBillId) {
    const found = await prisma.supplierBill.findFirst({
      where: { id: input.supplierBillId, supplier: { tenantId } },
      select: { id: true, supplierId: true, billNumber: true, status: true, totalCents: true, whtCents: true, paidCents: true, supplier: { select: { name: true } } },
    })
    if (!found) throw new AppError('BILL_NOT_IN_COMPANY', 'That supplier bill is not one of this drawer\'s company\'s', 422)
    if (found.status === 'void' || found.status === 'paid') throw new AppError('BILL_NOT_OPEN', `Bill ${found.billNumber} is ${found.status}`, 422)
    const { billDueCents } = await import('../procurement/service.js')
    const due = billDueCents(found)
    if (input.amountCents > due) throw new AppError('OVER_APPLIED', `Only ${due} is still due on bill ${found.billNumber}`, 400)
    bill = { id: found.id, supplierId: found.supplierId, billNumber: found.billNumber, supplierName: found.supplier.name }
  } else {
    const cat = PAYOUT_CATEGORIES.find((c) => c.key === input.category)
    if (!cat) {
      throw new AppError('PAYOUT_CATEGORY_REQUIRED', `Say what the pay-out was for (${PAYOUT_CATEGORIES.map((c) => c.key).join(', ')}) or pick the supplier bill it pays`, 400)
    }
    expenseCode = cat.code
  }

  // Blind count (owner decision 2): the drawer total is never shown, but a
  // pay-out can't take out more cash than the drawer should hold.
  const expected = await drawerExpectation(input.shiftId)
  if (input.amountCents > expected.expectedCents) {
    throw new AppError('INSUFFICIENT_DRAWER_CASH', 'That is more cash than this drawer should hold', 422)
  }

  const { movement, supplierPaymentId } = await prisma.$transaction(async (tx) => {
    const movement = await tx.cashMovement.create({
      data: {
        shiftId: input.shiftId,
        type: 'payout',
        amountCents: input.amountCents,
        reason: input.reason,
        recordedById: input.actorId,
        // The approver, never the PIN itself.
        managerOverridePin: approverId ? `approved-by:${approverId}` : null,
      },
    })
    let supplierPaymentId: string | null = null
    const tag = `(shift ${input.shiftId.slice(0, 8)})`
    const memo = `Till pay-out: ${input.reason}${input.vendorName ? ` — ${input.vendorName}` : ''} ${tag}`.slice(0, 250)
    if (bill) {
      const { createPaymentTx } = await import('../procurement/service.js')
      const payment = await createPaymentTx(tx, {
        supplierId: bill.supplierId,
        paymentDate: new Date().toISOString(),
        method: 'cash',
        reference: `till pay-out ${tag}`,
        amountCents: input.amountCents,
        notes: input.reason,
        applications: [{ billId: bill.id, amountAppliedCents: input.amountCents }],
        createdBy: input.actorId,
      })
      supplierPaymentId = payment.id
    }
    await postJournalEntry({
      tenantId,
      sourceType: 'pos.payout',
      sourceId: movement.id,
      description: bill ? `Till pay-out against bill ${bill.billNumber} (${bill.supplierName})` : `Till pay-out — ${input.reason}`,
      postedBy: input.actorId,
      lines: bill
        ? [
            { accountCode: ACCT.CASH_ON_HAND, type: 'debit',  amountCents: input.amountCents, memo },
            { accountCode: ACCT.CASH_DRAWER,  type: 'credit', amountCents: input.amountCents, memo },
          ]
        : [
            { accountCode: expenseCode!,      type: 'debit',  amountCents: input.amountCents, memo },
            { accountCode: ACCT.CASH_DRAWER,  type: 'credit', amountCents: input.amountCents, memo },
          ],
    }, { tx })
    return { movement, supplierPaymentId }
  })

  // The supplier payment's own entry (Dr 2010 / Cr 1010) was posted inside the
  // transaction by procurement createPaymentTx — nothing to post after it.
  await audit({ category: 'identity',
    action: 'drawer.payout',
    entity: 'CashMovement',
    entityId: movement.id,
    userId: input.actorId,
    tenantId,
    after: { amountCents: input.amountCents, reason: input.reason, category: input.category ?? null, supplierBillId: bill?.id ?? null },
    metadata: { approverId, supplierPaymentId, receiptUrl: input.receiptUrl ?? null, vendorName: input.vendorName ?? null },
  })
  return movement
}

// ─── Discount / price-override helpers ───────────────────────────────────────

function hasPriceOverride(input: PosOrderInput): boolean {
  // Quick check — if any line has a menuItemId we'll need to verify against
  // the catalog price. Returning true here causes detectPriceOverrides() to
  // run; cheap to false-positive.
  return input.items.some((i) => i.menuItemId != null)
}

async function detectPriceOverrides(input: PosOrderInput): Promise<Array<{ menuItemId: string; expected: number; charged: number; deltaCents: number }>> {
  const ids = input.items.map((i) => i.menuItemId).filter((x): x is string => !!x)
  if (ids.length === 0) return []
  const items = await prisma.menuItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, priceCents: true },
  })
  const priceMap = new Map(items.map((i) => [i.id, i.priceCents]))
  const out: Array<{ menuItemId: string; expected: number; charged: number; deltaCents: number }> = []
  for (const line of input.items) {
    if (!line.menuItemId) continue
    const expected = priceMap.get(line.menuItemId)
    if (expected == null) continue
    if (line.unitPriceCents !== expected) {
      out.push({
        menuItemId: line.menuItemId,
        expected,
        charged: line.unitPriceCents,
        deltaCents: (line.unitPriceCents - expected) * line.quantity,
      })
    }
  }
  return out
}


// ─── Gift-card tender (owner decision 14) ─────────────────────────────────────
//
// A gift card is accepted at the till. It is not a Payment row (PaymentMethod
// has no gift-card value, and a card is a liability, not money in the drawer):
// the one redeem engine (giftCards/service.redeemGiftCard) drains the card —
// the order's company only — and lowers the bill by what it paid. The cashier
// takes the rest through processPayment as usual; when the card covers
// everything still owed, the sale closes here exactly as a paid one does.
export async function applyGiftCardTender(input: {
  orderId: string
  code: string
  amountCents?: number
  staffId?: string | null
}) {
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, select: { id: true, source: true, fulfilmentType: true } })
  if (!order) throw new NotFoundError('Order', input.orderId)
  if (order.source !== 'pos' && order.fulfilmentType !== 'dine_in') {
    throw new AppError('NOT_A_TILL_SALE', 'The gift-card tender is for bills settled at the till', 422)
  }

  const redeem = {
    code: input.code,
    orderId: input.orderId,
    amountCents: input.amountCents,
    redeemedById: input.staffId ?? null,
  }
  const { redeemGiftCardTx } = await import('../giftCards/service.js')

  // TILL-R2: the card, the bill and the coverage in ONE transaction under the
  // order lock every other tender takes (processPayment, settle, comp, void).
  // The redeem used to read the bill unlocked in a transaction of its own: a
  // cash tender committing alongside it left the bill paid in full AND the
  // card drained (the guest charged twice, 2080 cleared for nothing). Under
  // the lock the redeem sees the cash first and finds NOTHING_DUE, or the cash
  // tender sees the card first and is asked only for the rest.
  const { redeemed, coverage } = await prisma.$transaction(async (tx) => {
    await lockOrderTx(tx, input.orderId)
    // §7.10: no gift card while the card machine works on this bill.
    await assertNoActiveTerminalChargeTx(tx, input.orderId)
    const redeemed = await redeemGiftCardTx(tx, redeem)
    return { redeemed, coverage: await applyCoverageTx(tx, input.orderId, 'till') }
  }, { maxWait: 10_000, timeout: 15_000 })
  const fiscal = coverage.completedNow ? await afterTillSale(input.orderId, coverage.customerId, coverage.source) : null
  return { ...redeemed, completed: coverage.completedNow, ...tillFiscal(fiscal) }
}
