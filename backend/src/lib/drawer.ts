// The drawer: what cash SHOULD be in a till, and whether the count agrees.
//
// This is the ONE expected-cash formula. The shift close (and its variance
// alert), the Z-report the cashier counts against, the ledger post, the
// /reconciliation list behind the CEO "Cash balanced" card and the bank
// deposit drop all read it from here. There used to be five, and they
// disagreed on the most ordinary shift there is: PKR 5,000 float, PKR 50,000
// cash sales, PKR 20,000 dropped to the safe mid-shift, PKR 35,000 counted.
// The tablet and /reconciliation said "matched"; the close raised a HIGH
// "PKR -20,000" exception; and the ledger booked a PKR 20,000 cash-variance
// loss, because a drop was not part of its sum.
//
//   expected = opening float
//            + cash sales            (Payment method 'cash', status 'paid')
//            − cash refunds          (Payment method 'cash', status 'refunded')
//            − drops − pay-outs      (CashMovement)
//            + adds  + pay-ins       (CashMovement)
//
// Card (Card – Keenu), Raast QR (a transfer straight to the company's bank —
// the ledger debits that bank, accounting/shiftPosting.ts) and the retired
// Keenu QR never touch the drawer: only method 'cash' counts here.
// Payment.shiftId is the only link from money to a drawer.
//
// The tolerance is the drawer company's ReceiptConfig.cashVarianceLimitCents
// (Configuration → Receipts), never a hard-coded figure: |variance| ≤ limit
// is balanced, anything beyond it is flagged.

import { prisma } from './prisma.js'
import { getReceiptConfig } from './setup-config.js'
import { NotFoundError } from './errors.js'
import { SHIFT_COMPANY_INCLUDE, shiftTenantId } from './tenantScope.js'

/** ReceiptConfig's own column default — used only when no company applies. */
export const DEFAULT_CASH_VARIANCE_LIMIT_CENTS = 20000

export interface DrawerPaymentRow {
  method: string
  status: string
  amountCents: number
}

export interface DrawerMovementRow {
  type: string
  amountCents: number
}

export interface DrawerExpectation {
  openingFloatCents: number
  cashSalesCents: number
  cashRefundsCents: number
  dropsCents: number
  addsCents: number
  payoutsCents: number
  payinsCents: number
  expectedCents: number
}

/**
 * The expected drawer from rows already in hand. Pure — pass the shift's own
 * payments and cash movements (every status; the filter is applied here).
 */
export function drawerExpectationOf(shift: {
  openingFloatCents: number
  payments: DrawerPaymentRow[]
  cashMovements: DrawerMovementRow[]
}): DrawerExpectation {
  let cashSalesCents = 0
  let cashRefundsCents = 0
  for (const p of shift.payments) {
    if (p.method !== 'cash') continue
    if (p.status === 'paid') cashSalesCents += p.amountCents
    // Refund rows carry a NEGATIVE amount; work in magnitudes.
    else if (p.status === 'refunded') cashRefundsCents += Math.abs(p.amountCents)
  }
  const sumOf = (type: string) =>
    shift.cashMovements.filter((m) => m.type === type).reduce((s, m) => s + m.amountCents, 0)
  const dropsCents   = sumOf('drop')
  const addsCents    = sumOf('add')
  const payoutsCents = sumOf('payout')
  const payinsCents  = sumOf('payin')

  const expectedCents = shift.openingFloatCents
    + cashSalesCents
    - cashRefundsCents
    - dropsCents
    - payoutsCents
    + addsCents
    + payinsCents

  return {
    openingFloatCents: shift.openingFloatCents,
    cashSalesCents,
    cashRefundsCents,
    dropsCents,
    addsCents,
    payoutsCents,
    payinsCents,
    expectedCents,
  }
}

/** Load a shift's payments and movements and compute its expected drawer. */
export async function drawerExpectation(shiftId: string): Promise<DrawerExpectation> {
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    select: {
      openingFloatCents: true,
      payments:      { select: { method: true, status: true, amountCents: true } },
      cashMovements: { select: { type: true, amountCents: true } },
    },
  })
  if (!shift) throw new NotFoundError('Shift', shiftId)
  return drawerExpectationOf(shift)
}

/** The drawer-variance tolerance of a company (Configuration → Receipts). */
export async function cashVarianceLimitCents(tenantId: string | null): Promise<number> {
  if (!tenantId) return DEFAULT_CASH_VARIANCE_LIMIT_CENTS
  const cfg = await getReceiptConfig(tenantId)
  return cfg?.cashVarianceLimitCents ?? DEFAULT_CASH_VARIANCE_LIMIT_CENTS
}

/** The tolerance for a shift's own company (Shift.tenantId, then the legacy fallbacks). */
export async function shiftVarianceLimitCents(shiftId: string): Promise<number> {
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    select: { tenantId: true, locationId: true, ...SHIFT_COMPANY_INCLUDE },
  })
  return cashVarianceLimitCents(shift ? shiftTenantId(shift) : null)
}

/** Counted − expected, or null while the drawer has not been counted. */
export function drawerVariance(countedCents: number | null, expected: DrawerExpectation): number | null {
  return countedCents === null ? null : countedCents - expected.expectedCents
}

/** Balanced = counted, and within the company's tolerance. */
export function isDrawerBalanced(varianceCents: number | null, limitCents: number): boolean {
  return varianceCents !== null && Math.abs(varianceCents) <= limitCents
}
