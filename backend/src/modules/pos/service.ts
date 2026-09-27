import { prisma } from '../../lib/prisma.js'
import { ingestOrder } from '../orders/service.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import { getSrbQueue } from '../../lib/queue.js'
import { getRefundPolicy, getOperationsConfig } from '../../lib/setup-config.js'
import { audit } from '../../lib/audit.js'
import { sendEmail } from '../../lib/notify.js'
import { flagException } from '../../lib/exceptions.js'
import { emitItemUpdated } from '../../lib/ws.js'
import { priceOrder, tenderOf, tenderOfPayments, gstRatePct } from '../../lib/pricing.js'
import { drawerExpectation, drawerExpectationOf, drawerVariance, cashVarianceLimitCents, isDrawerBalanced } from '../../lib/drawer.js'
import { shiftTenantId, assertShiftOf, shiftOfCompany } from '../../lib/tenantScope.js'
import { SHIFT_SALE_PAYMENT_INCLUDE, summariseShiftSales, TENDER_ROUNDING_CENTS } from '../accounting/shiftPosting.js'
import { postRefundPayment } from '../accounting/orderPosting.js'
import { postJournalEntry, ACCT } from '../accounting/journal.js'
import { PAYOUT_CATEGORIES, type PayoutCategory } from '../accounting/expenseCategories.js'
import { cogsForSoldLines } from '../../lib/recipeCost.js'
import type { OrderDTO } from '@servd/types'
import type { Order, PaymentMethod, Prisma } from '@prisma/client'
// Manager-override PIN: the ONE verifier (company-scoped, active accounts,
// owner-decision-7 approvers) and the approver tier that rings at manager caps.
import { verifyManagerPin } from '../auth/managerPin.js'
import { isOverrideApprover } from '../../lib/roles.js'

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

export async function createPosOrder(input: PosOrderInput) {
  // Idempotency: a double-tapped "complete & fire" or an offline-queue resend
  // carries the SAME idempotencyKey. If we've already created that order, return
  // it untouched — no second ticket, no re-flagging, no duplicate charge.
  if (input.idempotencyKey) {
    const existing = await prisma.order.findUnique({
      where: { source_externalId: { source: 'pos' as never, externalId: input.idempotencyKey } },
      include: { items: { include: { modifiers: true } } },
    })
    if (existing) return existing
  }

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
      const approved = await verifyManagerPin(input.managerOverridePin, tenantId)
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
      if (role === 'cashier' && totalOverride > cashierPriceOverrideCap) {
        const approved = await verifyManagerPin(input.managerOverridePin, tenantId)
        if (!approved) {
          throw new AppError(
            'PRICE_OVERRIDE_BLOCKED',
            `Price override on ${overrides.length} item(s) requires manager PIN. Total delta: PKR ${(totalOverride / 100).toFixed(0)}.`,
            403,
          )
        }
      }
      // Always flag price overrides for owner review (even when authorized)
      await flagException({
        kind: 'high_value_void',                       // re-using kind for now
        severity: Math.abs(totalOverride) > 50000 ? 'high' : 'medium',
        title: `Price override on POS order`,
        description: `${overrides.length} item(s) priced differently from menu. Total delta: PKR ${(totalOverride / 100).toFixed(0)}. Reason: ${input.discountReason ?? 'no reason given'}.`,
        entityType: 'Order',
        conceptId: input.conceptId,
        actorId: input.staffId,
        amountCents: Math.abs(totalOverride),
        metadata: { overrides, role, conceptId: input.conceptId },
      })
    }

    // Always flag big discounts for review even when authorized
    if (discountPct > cashierDiscountCap) {
      await flagException({
        kind: 'high_value_void',
        severity: discountPct > managerDiscountCap ? 'high' : 'medium',
        title: `${(discountPct * 100).toFixed(0)}% discount on POS order`,
        description: `Cashier ${input.staffId} applied a ${(discountPct * 100).toFixed(0)}% discount (PKR ${(discount / 100).toFixed(0)} on PKR ${(itemTotal / 100).toFixed(0)} subtotal). Reason: ${input.discountReason ?? 'none given'}.`,
        conceptId: input.conceptId,
        actorId: input.staffId,
        amountCents: discount,
        metadata: { discountPct, itemTotal, discount, role, reason: input.discountReason },
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
    external_id: input.idempotencyKey ?? `pos-${Date.now()}`,
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
  const { order } = await ingestOrder(dto, { price })
  return prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    include: { items: { include: { modifiers: true } } },
  })
}

// ─── POS payment processing ───────────────────────────────────────────────────

export interface ProcessPaymentInput {
  orderId: string
  shiftId: string
  payments: Array<{
    method: PaymentMethod
    amountCents: number
    tenderedCents?: number  // for cash
    gatewayRef?: string     // for card
    gateway?: string
  }>
}

// Every tender taken at the till settles there and then. Cash is in the
// drawer; a card or Keenu QR tender carries the terminal's reference number
// (owner decision 4) — the terminal approved it, so it is money receivable
// from the processor (1030) from that moment, and the sale completes, files
// its FBR / SRB invoice and reaches the drawer's close like a cash sale. If
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
 * Close out a till sale that is now fully covered: mark it completed and write
 * its FinancialEntry (once). Runs inside the caller's transaction. Shared by
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
  // triggers — ledger, tax invoice, FBR / SRB, loyalty, rollups, webhook —
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
 * there; a till sale posts with its shift close), tax invoice, FBR, SRB tried
 * synchronously so the verification QR can print on the receipt, loyalty earn,
 * customer rollups, webhook and notice. Exactly once per order, and it never
 * fails the sale. Returns the SRB result for the receipt.
 */
async function afterTillSale(
  orderId: string,
  _customerId?: string | null,
  _source?: string,
): Promise<{ srbInvoiceId: string; qrCodeLink: string | null } | null> {
  try {
    const { completeOrder } = await import('../orders/service.js')
    const { srb } = await completeOrder(orderId, null, { via: 'till_payment', syncSrb: true })
    return srb
  } catch (err) {
    console.error(`[complete] till sale ${orderId} completion effects failed:`, (err as Error).message)
    return null
  }
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
}

export async function settlePayment(input: SettleInput) {
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    select: {
      id: true, status: true, method: true, amountCents: true, gatewayRef: true, shiftId: true,
      order: { select: { id: true, concept: { select: { tenantId: true } } } },
    },
  })
  if (!payment) throw new NotFoundError('Payment', input.paymentId)
  if (payment.status === 'paid') return { payment, alreadySettled: true, orderCompleted: false, srb: null }
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
  }

  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: 'pending' },
      data: {
        status: 'paid',
        ...(input.via === 'till' && { shiftId: input.shiftId! }),
        gatewayRef,
        ...(input.tenderedCents != null && {
          tenderedCents: input.tenderedCents,
          changeCents: payment.method === 'cash' ? Math.max(0, input.tenderedCents - payment.amountCents) : null,
        }),
        processedAt: new Date(),
      },
    })
    if (claimed.count === 0) throw new AppError('ALREADY_SETTLED', 'Payment is not pending', 409)
    const coverage = await applyCoverageTx(tx, payment.order.id, input.via)
    const settled = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } })
    return { settled, coverage }
  })

  const srb = result.coverage.completedNow
    ? await afterTillSale(payment.order.id, result.coverage.customerId, result.coverage.source)
    : null
  return { payment: result.settled, alreadySettled: false, orderCompleted: result.coverage.completedNow, srb }
}

/**
 * Re-price an unpaid till sale for the tender it is being paid with (decision
 * 9) through THE pricing function, inside the payment's transaction. Returns
 * the order's total due. A no-op when the tender's rate is the one the order
 * was priced at, when the order was not priced through lib/pricing (legacy
 * rows: no taxRatePct), when it is not a till sale, or when customer credits
 * (promo, wallet, gift card, tip) already sit on its total — re-pricing would
 * drop them.
 */
async function repriceForTenderTx(
  tx: Tx,
  order: Pick<Order, 'id' | 'conceptId' | 'source' | 'rawPayload' | 'totalCents' | 'discountCents' | 'taxRatePct' | 'promoDiscountCents' | 'walletAmountCents' | 'tipCents'>,
  methods: PaymentMethod[],
): Promise<number> {
  if (order.taxRatePct == null) return order.totalCents
  const { isTillSale } = await import('../orders/service.js')
  if (!isTillSale(order)) return order.totalCents
  if (order.promoDiscountCents > 0 || order.walletAmountCents > 0 || order.tipCents > 0) return order.totalCents
  if ((await tx.giftCardRedemption.count({ where: { orderId: order.id } })) > 0) return order.totalCents

  const concept = await tx.concept.findUniqueOrThrow({
    where: { id: order.conceptId },
    select: { id: true, tenantId: true, taxRateCash: true, taxRateCard: true },
  })
  const tender = tenderOfPayments(methods)
  if (gstRatePct(concept, tender) === order.taxRatePct) return order.totalCents
  const items = await tx.orderItem.findMany({
    where: { orderId: order.id, status: { not: 'voided' } },
    select: { menuItemId: true, unitPriceCents: true, quantity: true, modifiers: { select: { priceDeltaCents: true } } },
  })
  const price = await priceOrder(items, tender, order.source === 'pos' ? 'pos' : 'group', concept, {
    discountCents: order.discountCents,
    db: tx,
  })
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

export async function processPayment(input: ProcessPaymentInput) {
  if (input.payments.length === 0) {
    throw new AppError('NO_PAYMENTS', 'At least one payment is required', 400)
  }
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
  }

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: { payments: true },
    })
    if (!order) throw new NotFoundError('Order', input.orderId)

    const alreadyPaid = coveredCents(order.payments)
    if (alreadyPaid >= order.totalCents) {
      throw new AppError('ALREADY_PAID', 'Order is already fully paid', 400)
    }

    // Decision 9: a till sale is taxed at the rate of the tender it is paid
    // with. Rung up as cash and paid by card (or a group bill, priced at the
    // cash rate until the table chooses) → re-priced here, before any money
    // is taken, so the bill, the GST filed and the tender agree.
    const totalDue = alreadyPaid === 0
      ? await repriceForTenderTx(tx, order, input.payments.map((p) => p.method))
      : order.totalCents
    const remainingDue = totalDue - alreadyPaid
    const submittedTotal = input.payments.reduce((s, p) => s + p.amountCents, 0)

    // Allow up to 2 paisa rounding tolerance — protect against under/overcharge
    if (Math.abs(submittedTotal - remainingDue) > TENDER_ROUNDING_CENTS) {
      throw new AppError(
        'AMOUNT_MISMATCH',
        `Payments total ${submittedTotal} but ${remainingDue} is due`,
        400,
      )
    }

    const createdPayments = []
    for (const p of input.payments) {
      const changeCents =
        p.method === 'cash' && p.tenderedCents !== undefined
          ? Math.max(0, p.tenderedCents - p.amountCents)
          : undefined
      const payment = await tx.payment.create({
        data: {
          orderId: input.orderId,
          shiftId: input.shiftId,
          method: p.method,
          amountCents: p.amountCents,
          status: 'paid',
          gateway: (p.gateway as never) ?? 'none',
          gatewayRef: p.gatewayRef?.trim() || null,
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
    return { payments: createdPayments, coverage }
  })

  const srb = result.coverage.completedNow
    ? await afterTillSale(input.orderId, result.coverage.customerId, result.coverage.source)
    : null
  return { payments: result.payments, orderCompleted: result.coverage.completedNow, srb }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

// SRB sales-return for a refund (invoiceType 2). Tries synchronously so the
// return invoice id can be recorded immediately; on timeout/error it enqueues a
// durable retry (the worker handles kind:'return') so a compliance filing is
// never lost. Returns the SRB return invoice id on success.
async function submitSrbReturnForRefund(orderId: string, refundAmountCents: number, refundRef: string): Promise<string | null> {
  try {
    const { buildSrbReturnForRefund, submitSrbInvoice } = await import('../../adapters/srb/index.js')
    const data = await buildSrbReturnForRefund(orderId, refundAmountCents, refundRef)
    if (!data) return null // concept not SRB-registered
    const { srbInvoiceId } = await withTimeout(submitSrbInvoice(data), 8000, 'SRB return')
    return srbInvoiceId
  } catch (err) {
    console.warn(`[SRB] sales-return sync failed for order ${orderId} (refund ${refundRef}); enqueuing retry: ${(err as Error).message}`)
    getSrbQueue()
      ?.add('submit', { orderId, kind: 'return', refundAmountCents, refundRef })
      .catch((e: Error) => console.error(`[SRB] COMPLIANCE: failed to enqueue sales-return retry for ${orderId}: ${e.message}`))
    return null
  }
}

// ─── Shift management ─────────────────────────────────────────────────────────

export async function openShift(userId: string, openingFloatCents: number, tenantId: string | null = null) {
  // Check for already-open shift
  const existing = await prisma.shift.findFirst({
    where: { userId, status: 'open' },
  })
  if (existing) throw new AppError('SHIFT_OPEN', 'A shift is already open for this user', 400)

  // The drawer belongs to the company the cashier is acting in — that is
  // what every shift read/write is scoped on (Shift.tenantId).
  return prisma.shift.create({
    data: { userId, openingFloatCents, status: 'open', tenantId },
  })
}

export async function closeShift(shiftId: string, closingFloatCents: number, notes?: string) {
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    include: {
      user: { select: { name: true, tenantId: true } },
      location: { select: { tenantId: true } },
    },
  })
  if (!shift) throw new NotFoundError('Shift', shiftId)
  if (shift.status === 'closed') throw new AppError('SHIFT_CLOSED', 'Shift is already closed', 400)

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
  const limit = await cashVarianceLimitCents(shiftTenantId(shift))
  if (Math.abs(variance) > limit) {
    await flagException({
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
  const { postShiftClose } = await import('../accounting/shiftPosting.js')
  postShiftClose(shiftId)
    .then((r) => {
      if (!r.posted && r.reason && r.reason !== 'no_postable_activity') {
        console.error(`[journal] shift ${shiftId} did not post: ${r.reason}`)
      }
    })
    .catch((err) =>
      console.error(`[journal] postShiftClose failed for ${shiftId}:`, (err as Error).message),
    )

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
  }
}

// ─── Void / comp / refund ─────────────────────────────────────────────────────
// Each enforces RefundPolicy caps. Above the cashier cap, a manager PIN must be
// supplied; we re-verify the PIN at submission time so a delegated terminal
// can't move the cap by simply impersonating a manager session.

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

  const approver = await verifyManagerPin(managerOverridePin, tenantId)
  if (!approver) throw new AppError('INVALID_MANAGER_PIN', 'Manager PIN did not match any active manager', 403)

  if (amountCents > managerCap) {
    throw new AppError('OVER_MANAGER_CAP', `Amount ${amountCents} exceeds the manager cap of ${managerCap}`, 403)
  }
  return { approverId: approver.id }
}

async function notifyOwnerIfThreshold(
  amountCents: number,
  policy: { notifyOwnerAboveCents: number | null; approverEmail: string | null },
  action: string,
  orderId: string,
  reason: string,
  actorId?: string,
): Promise<void> {
  if (policy.notifyOwnerAboveCents == null || amountCents < policy.notifyOwnerAboveCents) return

  // Always fire an exception flag — the inbox should reflect it even if email is misconfigured.
  await flagException({
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

export async function voidOrderItem(input: VoidInput) {
  const item = await prisma.orderItem.findUnique({
    where: { id: input.orderItemId },
    include: { order: { select: { concept: { select: { tenantId: true } } } } },
  })
  if (!item || item.orderId !== input.orderId) throw new NotFoundError('OrderItem', input.orderItemId)
  if (item.voidedAt) throw new AppError('ALREADY_VOIDED', 'Item is already voided', 400)
  const lineCents = item.unitPriceCents * item.quantity
  const tenantId = item.order.concept.tenantId

  const policy = await getRefundPolicy(tenantId)
  const { approverId } = await ensureCapOrManagerOverride(
    lineCents,
    policy.cashierVoidLimitCents,
    policy.managerVoidLimitCents,
    policy,
    input.reason,
    undefined,
    input.actorRole,
    input.managerOverridePin,
    'void',
    tenantId,
  )

  const voided = await prisma.orderItem.update({
    where: { id: input.orderItemId },
    data: { voidedAt: new Date(), voidReason: input.reason, status: 'voided' },
  })
  // The kitchen screens drop the line live — this is the only void path now
  // (the KDS status route no longer accepts 'voided'), so it carries the push
  // that route used to send.
  emitItemUpdated(voided.id, 'voided', voided.stationId)
  await audit({ category: 'identity',
    action: 'order_item_void',
    entity: 'OrderItem',
    entityId: input.orderItemId,
    userId: input.actorId,
    metadata: { orderId: input.orderId, lineCents, reason: input.reason, approverId },
  })
  await notifyOwnerIfThreshold(lineCents, policy, 'void', input.orderId, input.reason, input.actorId)

  // Pattern detection — same cashier voiding 3+ items in the last hour is a
  // classic skim signal. Flag it once when the threshold trips.
  const oneHourAgo = new Date(Date.now() - 60 * 60_000)
  const recentVoids = await prisma.orderItem.count({
    where: {
      voidedAt: { gte: oneHourAgo },
      order: { posStaffId: input.actorId },
    },
  })
  if (recentVoids >= 3) {
    const actor = await prisma.user.findUnique({ where: { id: input.actorId }, select: { name: true } })
    await flagException({
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

  return voided
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
      const approver = await verifyManagerPin(input.managerOverridePin, tenantId)
      if (!approver) throw new AppError('INVALID_MANAGER_PIN', 'Manager PIN did not match any active manager', 403)
      approverId = approver.id
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    // What is still due, read inside the transaction the comp is written in.
    // Comping a paid order used to overpay it.
    const rows = await tx.payment.findMany({ where: { orderId: order.id }, select: { status: true, amountCents: true } })
    const alreadyPaid = coveredCents(rows)
    const due = order.totalCents - alreadyPaid
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
  })

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
  await notifyOwnerIfThreshold(input.amountCents, policy, 'comp', input.orderId, reason, input.actorId)

  const srb = result.coverage.completedNow ? await afterTillSale(order.id, order.customerId, order.source) : null
  return { ...result.payment, orderCompleted: result.coverage.completedNow, staffMealId, srb }
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
//   • The SRB sales-return is filed only against an invoice that was filed.

export interface RefundInput extends CompRefundInput {
  /** The open drawer a cash refund leaves from. Defaults to the actor's own open drawer. */
  shiftId?: string | null
  /** How the money goes back. Defaults to the tender of the most recent receipt. */
  method?: 'cash' | 'card' | 'keenu_qr'
}

const REFUNDABLE_TENDERS = new Set(['cash', 'card', 'keenu_qr'])

export async function refundOrder(input: RefundInput) {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: {
      payments: { orderBy: { createdAt: 'asc' } },
      concept: { select: { tenantId: true } },
    },
  })
  if (!order) throw new NotFoundError('Order', input.orderId)
  if (order.status === 'refunded') throw new AppError('ALREADY_REFUNDED', 'This order has been refunded in full', 409)
  if (order.status !== 'completed') {
    throw new AppError(
      'NOT_REFUNDABLE',
      `A ${order.status} order has not been sold yet — cancel it instead (POST /orders/:id/cancel)`,
      422,
    )
  }
  const tenantId = order.concept.tenantId
  if (!tenantId) throw new AppError('NO_COMPANY', 'This brand is not bound to a company', 422)

  // The refundable base: money received.
  const receipts = order.payments.filter((p) => p.status === 'paid' && p.amountCents > 0 && REFUNDABLE_TENDERS.has(p.method))
  const pendingDigital = order.payments.filter((p) => p.status === 'pending' && p.amountCents > 0 && REFUNDABLE_TENDERS.has(p.method))
  const base = receipts.length > 0
    ? receipts
    : order.source !== 'pos' ? pendingDigital : []
  const paidTotal = base.reduce((s, p) => s + p.amountCents, 0)
  // A refund is a NEW negative payment row; the original 'paid' rows stay
  // untouched. Subtract what has already been refunded, or the same order
  // could be refunded in full over and over.
  const alreadyRefunded = order.payments
    .filter((p) => p.status === 'refunded')
    .reduce((s, p) => s + Math.abs(p.amountCents), 0)
  const refundable = paidTotal - alreadyRefunded
  if (input.amountCents <= 0) throw new AppError('INVALID_AMOUNT', 'Refund amount must be positive', 400)
  if (input.amountCents > refundable) {
    throw new AppError(
      'REFUND_EXCEEDS_PAID',
      alreadyRefunded > 0
        ? `Refund of ${input.amountCents} exceeds the ${refundable} still refundable (paid ${paidTotal}, already refunded ${alreadyRefunded})`
        : `Refund of ${input.amountCents} exceeds paid total of ${paidTotal}`,
      400,
    )
  }

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
  )

  // How the money goes back: as asked, else the tender of the latest receipt.
  const latest = [...base].sort((a, b) => +(b.processedAt ?? b.createdAt) - +(a.processedAt ?? a.createdAt))[0]
  const method = (input.method ?? latest?.method ?? 'cash') as 'cash' | 'card' | 'keenu_qr'

  // Which drawer it leaves from: the one named (the route checked it is an
  // open drawer of this company), else the refunder's own open drawer here.
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

  const { refundPayment, entryId } = await prisma.$transaction(async (tx) => {
    const refundPayment = await tx.payment.create({
      data: {
        orderId: input.orderId,
        shiftId,
        method,
        amountCents: -input.amountCents,
        status: 'refunded',
        gateway: 'none',
        gatewayMeta: { refund: { reason: input.reason, approverId, actorId: input.actorId } },
        processedAt: new Date(),
      },
    })
    const posted = await postRefundPayment(refundPayment.id, { tx, postedBy: input.actorId })
    if (!posted.entryId) {
      throw new AppError('REFUND_NOT_POSTED', `The refund could not be booked: ${posted.reason ?? 'unknown'}`, 422)
    }
    return { refundPayment, entryId: posted.entryId }
  })

  // Refunded in full → the order's own terminal transition and its restores.
  const refundedInFull = alreadyRefunded + input.amountCents >= paidTotal
  if (refundedInFull) {
    const { updateOrderStatus } = await import('../orders/service.js')
    await updateOrderStatus(order.id, 'refunded').catch((err: Error) =>
      console.error(`[refund] status → refunded failed for ${order.id}: ${err.message}`))
  }

  // SRB sales-return (invoiceType 2) — only against an invoice that was filed.
  // A till sale whose own filing is still queued gets its return queued behind
  // it; a sale never filed (storefront today) has nothing to return against.
  let srbReturnInvoiceNo: string | null = null
  let srbReturn: 'filed' | 'queued' | 'not_filed_original' = 'not_filed_original'
  if (order.srbInvoiceNumber) {
    srbReturnInvoiceNo = await submitSrbReturnForRefund(input.orderId, input.amountCents, refundPayment.id)
    srbReturn = srbReturnInvoiceNo ? 'filed' : 'queued'
  } else if (order.source === 'pos') {
    getSrbQueue()
      ?.add('submit', { orderId: input.orderId, kind: 'return', refundAmountCents: input.amountCents, refundRef: refundPayment.id }, { delay: 5 * 60_000 })
      .catch((e: Error) => console.error(`[SRB] COMPLIANCE: failed to enqueue sales-return for ${input.orderId}: ${e.message}`))
    srbReturn = 'queued'
  }

  await audit({ category: 'identity',
    action: 'order_refund',
    entity: 'Order',
    entityId: input.orderId,
    userId: input.actorId,
    tenantId,
    before: { status: order.status, refundedCents: alreadyRefunded },
    after: { status: refundedInFull ? 'refunded' : order.status, refundedCents: alreadyRefunded + input.amountCents },
    metadata: { amountCents: input.amountCents, method, shiftId, reason: input.reason, photoUrl: input.photoUrl, approverId, refundPaymentId: refundPayment.id, entryId, srbReturn, srbReturnInvoiceNo },
  })
  await notifyOwnerIfThreshold(input.amountCents, policy, 'refund', input.orderId, input.reason, input.actorId)
  return { ...refundPayment, entryId, orderRefunded: refundedInFull, srbReturnInvoiceNo }
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
    const approver = await verifyManagerPin(input.managerOverridePin, tenantId)
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

  if (supplierPaymentId) {
    const { postSupplierPayment } = await import('../accounting/supplierPosting.js')
    await postSupplierPayment(supplierPaymentId).catch((err: Error) =>
      console.error(`[journal] till pay-out supplier payment ${supplierPaymentId} did not post: ${err.message}`))
  }
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

  const { redeemGiftCard } = await import('../giftCards/service.js')
  const redeemed = await redeemGiftCard({
    code: input.code,
    orderId: input.orderId,
    amountCents: input.amountCents,
    redeemedById: input.staffId ?? null,
  })

  const coverage = await prisma.$transaction((tx) => applyCoverageTx(tx, input.orderId, 'till'))
  const srb = coverage.completedNow ? await afterTillSale(input.orderId, coverage.customerId, coverage.source) : null
  return { ...redeemed, completed: coverage.completedNow, srb }
}
