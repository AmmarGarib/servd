import bcrypt from 'bcryptjs'
import { prisma } from '../../lib/prisma.js'
import { ingestOrder } from '../orders/service.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import { getFbrQueue, getSrbQueue } from '../../lib/queue.js'
import { getRefundPolicy, getReceiptConfig, getOperationsConfig } from '../../lib/setup-config.js'
import { audit } from '../../lib/audit.js'
import { sendEmail } from '../../lib/notify.js'
import { flagException } from '../../lib/exceptions.js'
import type { OrderDTO } from '@servd/types'
import type { PaymentMethod, Prisma } from '@prisma/client'

// ─── Company scoping ──────────────────────────────────────────────────────────
//
// The singleton config tables hold one global row PER COMPANY (unique on
// tenantId + scope + scopeId). The shared readers in lib/setup-config.ts still
// resolve a company-less "first row", which on a multi-company box is
// whichever company's row happens to sort first — so the till resolves its
// discount caps, service charge, refund caps and drawer-variance limit for the
// order's / shift's own company here. A brand with no company (legacy) falls
// back to the shared reader.

const GLOBAL_SCOPE = { scope: 'global', scopeId: null } as const

async function operationsConfigFor(tenantId: string | null) {
  if (!tenantId) return getOperationsConfig()
  const where = { ...GLOBAL_SCOPE, tenantId }
  return (await prisma.operationsConfig.findFirst({ where })) ?? prisma.operationsConfig.create({ data: where })
}

async function refundPolicyFor(tenantId: string | null) {
  if (!tenantId) return getRefundPolicy()
  const where = { ...GLOBAL_SCOPE, tenantId }
  return (await prisma.refundPolicy.findFirst({ where })) ?? prisma.refundPolicy.create({ data: where })
}

async function receiptConfigFor(tenantId: string | null) {
  if (!tenantId) return getReceiptConfig()
  const where = { ...GLOBAL_SCOPE, tenantId }
  return (await prisma.receiptConfig.findFirst({ where })) ?? prisma.receiptConfig.create({ data: where })
}

/** Mirror of lib/setup-config's computeServiceCharge, fed the company's own row. */
function serviceChargeFrom(
  ops: { serviceChargePct: number; serviceChargeAppliesToChannels: string[] } | null,
  subtotalCents: number,
  channel: string,
): number {
  if (!ops || ops.serviceChargePct <= 0) return 0
  const channels = ops.serviceChargeAppliesToChannels ?? []
  if (channels.length > 0 && !channels.includes(channel)) return 0
  return Math.round(subtotalCents * ops.serviceChargePct)
}

/**
 * Only managers of `tenantId` (primary company or a membership) may approve
 * an override at its tills — a PIN belonging to the other company's manager
 * must never unlock a discount, void, comp or refund here. No company → no
 * manager matches.
 */
function managersOf(tenantId: string | null): Prisma.UserWhereInput {
  const ids = tenantId ? [tenantId] : []
  return { OR: [{ tenantId: { in: ids } }, { tenantMemberships: { some: { tenantId: { in: ids } } } }] }
}

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
  const ops = await operationsConfigFor(tenantId)

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
    const cap = role === 'admin' || role === 'manager' ? managerDiscountCap : cashierDiscountCap
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

  // CEO policy: GST is split by tender — cash @ taxRateCash, card/digital @
  // taxRateCard. Cashier picks the method up front (`input.paymentMethod`);
  // for unknown / pending methods we default to the cash rate so the
  // customer never gets a smaller bill than they actually owe.
  const intendedMethod = input.paymentMethod ?? 'cash'
  const effectiveRate = intendedMethod === 'cash'
    ? (concept.taxRateCash ?? concept.taxRate)
    : (concept.taxRateCard ?? concept.taxRate)
  const taxRate = effectiveRate / 100
  // SRB POS rule: GST is charged on the PRE-discount sale value — the discount
  // does NOT reduce the taxable base. So taxAmount = saleValue × rate, and the
  // discount then comes off the tax-inclusive total:
  //   net = saleValue + tax − discount   (matches the SRB invoice payload)
  const taxCents = Math.round(itemTotal * taxRate)
  const netAfterDiscount = itemTotal + taxCents - discount
  // Service charge sits on top of the net (food + tax − discount).
  const serviceChargeCents = serviceChargeFrom(ops, netAfterDiscount, 'pos')
  const totalCents = netAfterDiscount + serviceChargeCents

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

  const { order } = await ingestOrder(dto)

  // Update with calculated values
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { discountCents: discount, taxCents, serviceChargeCents, totalCents },
    include: { items: { include: { modifiers: true } } },
  })

  return updated
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
  complimentaryReason?: string
}

// Card / wallet payments require gateway confirmation before being marked 'paid'.
// Cash and comp settle instantly at the till.
const INSTANT_SETTLE: Set<PaymentMethod> = new Set(['cash', 'comp'])

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

// SRB submission for the receipt QR. Tries the live gateway synchronously (so
// the QR can print on the receipt) but NEVER blocks the sale: on any error or
// timeout it falls back to the async retry queue and returns null. Returns the
// SRB invoice id + QR link on success. Silently returns null when the concept
// isn't SRB-registered.
async function submitSrbForReceipt(orderId: string): Promise<{ srbInvoiceId: string; qrCodeLink: string | null } | null> {
  try {
    const { buildSrbDataForOrder, submitSrbInvoice } = await import('../../adapters/srb/index.js')
    const data = await buildSrbDataForOrder(orderId)
    if (!data) return null // not SRB-registered — nothing to do
    const result = await withTimeout(submitSrbInvoice(data), 8000, 'SRB submit')
    await prisma.order.update({
      where: { id: orderId },
      data: { srbInvoiceNumber: result.srbInvoiceId, srbQrCodeLink: result.qrCodeLink },
    })
    return result
  } catch (err) {
    console.warn(`[SRB] sync submit failed for ${orderId}; falling back to queue: ${(err as Error).message}`)
    getSrbQueue()
      ?.add('submit', { orderId })
      .catch((e: Error) => console.warn('[SRB] Failed to enqueue fallback submission:', e.message))
    return null
  }
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

export async function processPayment(input: ProcessPaymentInput) {
  if (input.payments.length === 0) {
    throw new AppError('NO_PAYMENTS', 'At least one payment is required', 400)
  }
  if (input.payments.some((p) => p.amountCents <= 0)) {
    throw new AppError('INVALID_AMOUNT', 'Payment amounts must be positive', 400)
  }

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: { payments: true },
    })
    if (!order) throw new NotFoundError('Order', input.orderId)

    const alreadyPaid = order.payments
      .filter((p) => p.status === 'paid')
      .reduce((sum, p) => sum + p.amountCents, 0)

    if (alreadyPaid >= order.totalCents) {
      throw new AppError('ALREADY_PAID', 'Order is already fully paid', 400)
    }

    const remainingDue = order.totalCents - alreadyPaid
    const submittedTotal = input.payments.reduce((s, p) => s + p.amountCents, 0)

    // Allow up to 2 PKR rounding tolerance — protect against under/overcharge
    if (Math.abs(submittedTotal - remainingDue) > 2) {
      throw new AppError(
        'AMOUNT_MISMATCH',
        `Payments total ${submittedTotal} but ${remainingDue} is due`,
        400,
      )
    }

    // Card/wallet payments without gatewayRef must remain pending
    for (const p of input.payments) {
      if (!INSTANT_SETTLE.has(p.method) && !p.gatewayRef) {
        throw new AppError(
          'GATEWAY_REF_REQUIRED',
          `${p.method} payments require a gateway reference`,
          400,
        )
      }
    }

    const createdPayments = []

    for (const p of input.payments) {
      const changeCents =
        p.method === 'cash' && p.tenderedCents !== undefined
          ? Math.max(0, p.tenderedCents - p.amountCents)
          : undefined

      const status = INSTANT_SETTLE.has(p.method) ? 'paid' : 'pending'

      const payment = await tx.payment.create({
        data: {
          orderId: input.orderId,
          shiftId: input.shiftId,
          method: p.method,
          amountCents: p.amountCents,
          status,
          gateway: (p.gateway as never) ?? 'none',
          gatewayRef: p.gatewayRef ?? null,
          tenderedCents: p.tenderedCents ?? null,
          changeCents: changeCents ?? null,
          processedAt: status === 'paid' ? new Date() : null,
        },
      })
      createdPayments.push(payment)
    }

    // Only mark order completed if all payments settled instantly. Otherwise
    // it stays in its current status until the gateway webhook confirms.
    const allInstant = input.payments.every((p) => INSTANT_SETTLE.has(p.method))
    if (allInstant) {
      await tx.order.update({
        where: { id: input.orderId },
        data: { status: 'completed', completedAt: new Date() },
      })
    }

    // Write financial entry only when the order is fully settled (no pending payments).
    // Pending card/wallet payments will trigger entry creation from the gateway webhook.
    if (allInstant) {
      const existingEntry = await tx.financialEntry.findFirst({ where: { orderId: order.id } })
      if (!existingEntry) {
        // Own-fleet ordering only — no aggregator commission to deduct.
        await tx.financialEntry.create({
          data: {
            orderId: order.id,
            conceptId: order.conceptId,
            channel: order.source,
            grossCents: order.totalCents,
            commissionCents: 0,
            discountCents: order.discountCents,
            taxCents: order.taxCents,
            netCents: order.totalCents - order.discountCents,
          },
        })
      }
    }

    return { payments: createdPayments }
  })

  // Tax-invoicing fan-out. FBR (federal) stays fire-and-forget. SRB (Sindh) is
  // attempted SYNCHRONOUSLY so the invoice-verification QR can print on the
  // receipt (the SRB spec requires the QR on the invoice) — but it NEVER blocks
  // or fails the sale: on timeout/error submitSrbForReceipt falls back to the
  // async retry queue. Only for instant-settle orders; card/wallet orders submit
  // from the gateway webhook once the payment confirms.
  const allInstantSettle = input.payments.every((p) => INSTANT_SETTLE.has(p.method))
  let srb: { srbInvoiceId: string; qrCodeLink: string | null } | null = null
  if (allInstantSettle) {
    getFbrQueue()
      ?.add('submit', { orderId: input.orderId })
      .catch((err: Error) => console.warn('[FBR] Failed to enqueue invoice submission:', err.message))
    srb = await submitSrbForReceipt(input.orderId)
  }

  return { ...result, srb }
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
      payments: true,
      user: { select: { name: true, tenantId: true } },
      location: { select: { tenantId: true } },
    },
  })
  if (!shift) throw new NotFoundError('Shift', shiftId)
  if (shift.status === 'closed') throw new AppError('SHIFT_CLOSED', 'Shift is already closed', 400)

  await prisma.shift.update({
    where: { id: shiftId },
    data: { status: 'closed', closedAt: new Date(), closingFloatCents, notes: notes ?? null },
  })

  // Cash variance flag — closing drawer that doesn't reconcile is the
  // single most common indicator of cashier theft. Threshold lives in the
  // ReceiptConfig singleton (default PKR 200 = 20000 cents).
  const cashSales = shift.payments
    .filter((p) => p.method === 'cash' && p.status === 'paid')
    .reduce((s, p) => s + p.amountCents, 0)
  const expected = shift.openingFloatCents + cashSales
  const variance = closingFloatCents - expected
  // The variance limit of the company whose drawer this is — the location's
  // company, or the cashier's for shifts opened without a location.
  const recipt = await receiptConfigFor(shift.location?.tenantId ?? shift.user.tenantId)
  if (Math.abs(variance) > (recipt?.cashVarianceLimitCents ?? 20000)) {
    await flagException({
      kind: 'cash_variance',
      severity: Math.abs(variance) > 100000 ? 'high' : 'medium',
      title: `Cash variance: ${variance >= 0 ? '+' : ''}PKR ${(variance / 100).toFixed(0)}`,
      description: `${shift.user.name}'s shift closed with PKR ${(variance / 100).toFixed(0)} ${variance >= 0 ? 'over' : 'short'}. Expected ${(expected / 100).toFixed(0)}, counted ${(closingFloatCents / 100).toFixed(0)}.`,
      entityType: 'Shift',
      entityId: shiftId,
      actorId: shift.userId,
      amountCents: Math.abs(variance),
      metadata: { expected, counted: closingFloatCents, variance, openingFloat: shift.openingFloatCents, cashSales },
    })
  }

  // Post the day's POS sales + cash variance to the ledger. Lazy import to
  // avoid a hard dependency from the POS module on accounting.
  const { postShiftClose } = await import('../accounting/shiftPosting.js')
  postShiftClose(shiftId).catch((err) =>
    console.error(`[journal] postShiftClose failed for ${shiftId}:`, (err as Error).message),
  )

  return getZReport(shiftId)
}

export async function getZReport(shiftId: string) {
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    include: {
      payments: { include: { order: { select: { totalCents: true, discountCents: true, taxCents: true, tipCents: true } } } },
      cashMovements: true,
      user: { select: { name: true } },
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
    .filter((p) => p.method === 'comp')
    .reduce((s, p) => s + p.amountCents, 0)

  // Refund rows carry a NEGATIVE amountCents. Summing them raw produced a
  // negative "voids", and every consumer then SUBTRACTED it — so a refund
  // *added* to revenue and *raised* expected cash, showing double takings and
  // a phantom drawer shortage. Work in positive magnitudes instead.
  const refundedPayments = payments.filter((p) => p.status === 'refunded')
  const voids = refundedPayments.reduce((s, p) => s + Math.abs(p.amountCents), 0)
  // Only refunds actually handed back in cash move the drawer.
  const cashRefunds = refundedPayments
    .filter((p) => p.method === 'cash')
    .reduce((s, p) => s + Math.abs(p.amountCents), 0)

  const totalSales = cashSales + cardSales + walletSales
  const uniqueOrders = new Map<string, { discountCents: number; taxCents: number; tipCents: number }>()
  for (const p of payments) {
    if (p.order && !uniqueOrders.has(p.orderId)) {
      uniqueOrders.set(p.orderId, {
        discountCents: p.order.discountCents,
        taxCents: p.order.taxCents,
        tipCents: ('tipCents' in p.order && typeof p.order.tipCents === 'number') ? p.order.tipCents : 0,
      })
    }
  }
  const totalOrders = uniqueOrders.size
  const totalDiscounts = Array.from(uniqueOrders.values()).reduce((s, o) => s + o.discountCents, 0)
  const totalTax       = Array.from(uniqueOrders.values()).reduce((s, o) => s + o.taxCents, 0)
  const totalTips      = Array.from(uniqueOrders.values()).reduce((s, o) => s + o.tipCents, 0)

  // Cash movement aggregates — affect the expected drawer total.
  type CashMov = { type: string; amountCents: number }
  const movements: CashMov[] = shift.cashMovements ?? []
  const cashDrops   = movements.filter((m) => m.type === 'drop'  ).reduce((s, m) => s + m.amountCents, 0)
  const cashAdds    = movements.filter((m) => m.type === 'add'   ).reduce((s, m) => s + m.amountCents, 0)
  const cashPayouts = movements.filter((m) => m.type === 'payout').reduce((s, m) => s + m.amountCents, 0)
  const cashPayins  = movements.filter((m) => m.type === 'payin' ).reduce((s, m) => s + m.amountCents, 0)

  // Expected cash = opening + cash sales − cash voids/refunds − drops − payouts + adds + payins
  const expectedCash = shift.openingFloatCents
    + cashSales
    - cashRefunds
    - cashDrops
    - cashPayouts
    + cashAdds
    + cashPayins

  // Per-method breakdown for the tablet UI.
  const byMethodMap = new Map<string, { method: string; count: number; amountCents: number }>()
  for (const p of payments) {
    if (p.status !== 'paid' && p.method !== 'comp') continue
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
    cashVariance: shift.closingFloatCents !== null ? shift.closingFloatCents - expectedCash : null,

    // ─── v4 additions — tablet POS consumes these directly ─────────────────
    openingFloatCents:    shift.openingFloatCents,
    closingFloatCents:    shift.closingFloatCents,
    ordersCount:          totalOrders,
    grossCents:           totalSales,
    netCents:             totalSales - voids,
    taxCents:             totalTax,
    tipsCents:            totalTips,
    discountCents:        totalDiscounts,
    compCents:            compSales,
    voidsCount:           payments.filter((p) => p.status === 'refunded').length,
    refundsCents:         voids,
    byMethod,
    cashMovements: {
      drops:  cashDrops,
      adds:   cashAdds,
      payouts: cashPayouts,
      payins:  cashPayins,
      list:   movements,
    },
    expectedCashCents:    expectedCash,
    varianceCents:        shift.closingFloatCents !== null ? shift.closingFloatCents - expectedCash : null,
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

  const cap = actorRole === 'admin' || actorRole === 'manager' ? managerCap : cashierCap
  if (amountCents <= cap) return { approverId: null }

  // Above own cap. Either user is admin/manager (already at managerCap and
  // still over — block) or cashier with a manager PIN.
  if (actorRole === 'admin' || actorRole === 'manager') {
    throw new AppError('OVER_CAP', `Amount ${amountCents} exceeds the ${cap} cap for ${action}`, 403)
  }
  if (!managerOverridePin) {
    throw new AppError('MANAGER_OVERRIDE_REQUIRED', `Manager PIN required for ${action} above ${cap}`, 403)
  }

  const managers = await prisma.user.findMany({
    where: { isActive: true, role: { in: ['admin', 'manager'] }, pin: { not: null }, ...managersOf(tenantId) },
  })
  const checks = await Promise.all(managers.map(async (m) => ({ m, ok: m.pin ? await bcrypt.compare(managerOverridePin, m.pin) : false })))
  const approver = checks.find((c) => c.ok)?.m ?? null
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

  const policy = await refundPolicyFor(tenantId)
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
  await audit({
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

interface CompRefundInput {
  orderId: string
  amountCents: number
  reason: string
  photoUrl?: string
  actorId: string
  actorRole: string
  managerOverridePin?: string
}

export async function compOrder(input: CompRefundInput) {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { concept: { select: { tenantId: true } } },
  })
  if (!order) throw new NotFoundError('Order', input.orderId)
  const tenantId = order.concept.tenantId

  const policy = await refundPolicyFor(tenantId)
  const { approverId } = await ensureCapOrManagerOverride(
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

  // Comp = settlement at zero cost: a `comp` payment line for the amount.
  const payment = await prisma.payment.create({
    data: {
      orderId: input.orderId,
      method: 'comp',
      amountCents: input.amountCents,
      status: 'paid',
      gateway: 'none',
      processedAt: new Date(),
    },
  })

  await audit({
    action: 'order_comp',
    entity: 'Order',
    entityId: input.orderId,
    userId: input.actorId,
    metadata: { amountCents: input.amountCents, reason: input.reason, photoUrl: input.photoUrl, approverId, paymentId: payment.id },
  })
  await notifyOwnerIfThreshold(input.amountCents, policy, 'comp', input.orderId, input.reason, input.actorId)
  return payment
}

export async function refundOrder(input: CompRefundInput) {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: {
      payments: { where: { status: 'paid' } },
      concept: { select: { tenantId: true } },
    },
  })
  if (!order) throw new NotFoundError('Order', input.orderId)
  const tenantId = order.concept.tenantId

  // A refund is recorded as a NEW negative payment row; the original 'paid'
  // rows are left untouched. So comparing against the paid total alone let the
  // same order be refunded in full over and over. Subtract what has already
  // been refunded to get what is actually still refundable.
  const paidTotal = order.payments.reduce((s, p) => s + p.amountCents, 0)
  const refundedRows = await prisma.payment.findMany({
    where: { orderId: input.orderId, status: 'refunded' },
    select: { amountCents: true },
  })
  const alreadyRefunded = refundedRows.reduce((s, p) => s + Math.abs(p.amountCents), 0)
  const refundable = paidTotal - alreadyRefunded
  if (input.amountCents > refundable) {
    throw new AppError(
      'REFUND_EXCEEDS_PAID',
      alreadyRefunded > 0
        ? `Refund of ${input.amountCents} exceeds the ${refundable} still refundable (paid ${paidTotal}, already refunded ${alreadyRefunded})`
        : `Refund of ${input.amountCents} exceeds paid total of ${paidTotal}`,
      400,
    )
  }

  const policy = await refundPolicyFor(tenantId)
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

  // Mark the most recent paid payment(s) as refunded up to the amount.
  // Partial-payment refunds get a proportional negative adjustment line.
  let remaining = input.amountCents
  const adjustments: { paymentId: string; amount: number }[] = []
  for (const p of [...order.payments].sort((a, b) => +b.processedAt! - +a.processedAt!)) {
    if (remaining <= 0) break
    const apply = Math.min(remaining, p.amountCents)
    adjustments.push({ paymentId: p.id, amount: apply })
    remaining -= apply
  }

  // Single negative-amount payment row carries the refund total. Reuses the
  // method of the most-recent paid payment so reports attribute the refund
  // to the same tender. Status='refunded' is what the Z-report counts as void.
  const originalMethod = order.payments[0]?.method ?? 'cash'
  // Attach the refund to the same drawer as the sale. Without a shiftId the
  // Z-report never saw refunds at all: the cash was out of the till but
  // expected cash still counted the full sale, so the shift closed "short".
  const refundShiftId = order.payments[0]?.shiftId ?? order.shiftId ?? null
  const refundPayment = await prisma.payment.create({
    data: {
      orderId: input.orderId,
      shiftId: refundShiftId,
      method: originalMethod,
      amountCents: -input.amountCents,
      status: 'refunded',
      gateway: 'none',
      processedAt: new Date(),
    },
  })

  // File the SRB sales-return (invoiceType 2) for the refunded value.
  const srbReturnInvoiceNo = await submitSrbReturnForRefund(input.orderId, input.amountCents, refundPayment.id)

  await audit({
    action: 'order_refund',
    entity: 'Order',
    entityId: input.orderId,
    userId: input.actorId,
    metadata: { amountCents: input.amountCents, reason: input.reason, photoUrl: input.photoUrl, approverId, refundPaymentId: refundPayment.id, adjustments, srbReturnInvoiceNo },
  })
  await notifyOwnerIfThreshold(input.amountCents, policy, 'refund', input.orderId, input.reason, input.actorId)
  return { ...refundPayment, srbReturnInvoiceNo }
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

async function verifyManagerPin(pin: string | undefined, tenantId: string | null): Promise<{ id: string; role: string } | null> {
  if (!pin) return null
  const managers = await prisma.user.findMany({
    where: { isActive: true, deletedAt: null, role: { in: ['admin', 'manager'] }, pin: { not: null }, ...managersOf(tenantId) },
    select: { id: true, role: true, pin: true },
  })
  for (const m of managers) {
    if (m.pin && await bcrypt.compare(pin, m.pin)) return { id: m.id, role: m.role }
  }
  return null
}
