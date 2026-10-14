// What a cancelled ticket still owes back (LEDGER-R5, orderPosting.ts
// refundDueCents) once the CEO has voided a Raast receipt as "never booked"
// (reconciliation/raast.ts voidNeverBooked — RaastReceipt.status 'voided').
//
//   - A cancelled ticket paid by Raast owes the Raast money back while its
//     receipt is provisional; once the receipt is voided it owes nothing for
//     it — the books never held that money.
//   - A comp is still never money owed back.
//   - Cash and card refunds due are unchanged, and a refund already handed
//     back still comes off.
//   - Through the database: the real void path, then the order re-read with
//     each payment's receipt status; the drawer's close (summariseShiftSales,
//     the Z-report's cancelledPaid and the ledger close) no longer holds the
//     voided Raast money as a refund due, so a late close never debits the
//     bank for it.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { refundDueCents, isVoidedRaast } from '../src/modules/accounting/orderPosting.js'
import { voidNeverBooked } from '../src/modules/reconciliation/raast.js'
import { summariseShiftSales, buildShiftCloseEntry, SHIFT_SALE_PAYMENT_INCLUDE, raastTotalCents } from '../src/modules/accounting/shiftPosting.js'
import { prisma, mkCompany, mkUser, mkRaastAccount, type Company, type Who } from './connectorsFixtures.js'

type P = Parameters<typeof refundDueCents>[0]['payments'][number]
const paid = (method: string, amountCents: number, extra: Partial<P> = {}): P =>
  ({ method, status: 'paid', amountCents, gatewayRef: method === 'card' ? 'T-1' : null, shiftId: 'shift-1', ...extra })
const raast = (amountCents: number, status: string | null): P => paid('raast', amountCents, { gatewayRef: 'RAAST1', raastReceipt: status ? { status } : null })

describe('refundDueCents — pure', () => {
  it('counts Raast money while its receipt is provisional, drops it once voided', () => {
    expect(refundDueCents({ status: 'cancelled', payments: [raast(50_000, 'provisional')] })).toBe(50_000)
    expect(refundDueCents({ status: 'cancelled', payments: [raast(50_000, 'voided')] })).toBe(0)
    expect(refundDueCents({ status: 'rejected', payments: [raast(50_000, 'voided')] })).toBe(0)
    // Matched / not received / no receipt loaded: counted as before.
    expect(refundDueCents({ status: 'cancelled', payments: [raast(50_000, 'matched')] })).toBe(50_000)
    expect(refundDueCents({ status: 'cancelled', payments: [raast(50_000, null)] })).toBe(50_000)
    expect(refundDueCents({ status: 'cancelled', payments: [paid('raast', 50_000, { gatewayRef: 'R' })] })).toBe(50_000)
  })

  it('a split ticket: only the voided Raast part drops; cash and card stay due', () => {
    const payments = [raast(30_000, 'voided'), paid('cash', 20_000), paid('card', 10_000)]
    expect(refundDueCents({ status: 'cancelled', payments })).toBe(30_000)
    // A cash refund already handed back still comes off.
    const handedBack = [...payments, { method: 'cash', status: 'refunded', amountCents: -20_000, gatewayRef: null, shiftId: 'shift-2' }]
    expect(refundDueCents({ status: 'cancelled', payments: handedBack })).toBe(10_000)
  })

  it('a comp is still excluded; a completed order owes nothing', () => {
    expect(refundDueCents({ status: 'cancelled', payments: [paid('comp', 40_000)] })).toBe(0)
    expect(refundDueCents({ status: 'cancelled', payments: [paid('comp', 40_000), paid('cash', 5_000)] })).toBe(5_000)
    expect(refundDueCents({ status: 'completed', payments: [paid('cash', 5_000)] })).toBe(0)
  })

  it('isVoidedRaast reads only a Raast row with a voided receipt', () => {
    expect(isVoidedRaast({ method: 'raast', raastReceipt: { status: 'voided' } })).toBe(true)
    expect(isVoidedRaast({ method: 'raast', raastReceipt: { status: 'provisional' } })).toBe(false)
    expect(isVoidedRaast({ method: 'card', raastReceipt: { status: 'voided' } })).toBe(false)
    expect(isVoidedRaast({ method: 'raast' })).toBe(false)
  })
})

describe('refundDueCents — after a real void', () => {
  let A: Company
  let ceo: Who
  let cashier: Who
  let bank: { bankAccountId: string; ledgerCode: string }

  beforeAll(async () => {
    const run = randomBytes(3).toString('hex')
    A = await mkCompany(`rdv-${run}`)
    ceo = await mkUser(`rdv-ceo-${run}`, 'admin', A.tenantId)
    cashier = await mkUser(`rdv-till-${run}`, 'cashier', A.tenantId)
    bank = await mkRaastAccount(A)
  })

  const load = (orderId: string) => prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      status: true,
      payments: { select: { method: true, status: true, amountCents: true, gatewayRef: true, shiftId: true, raastReceipt: { select: { status: true } } } },
    },
  })

  it('a cancelled till ticket paid by Raast + cash: the Raast part is due until the CEO voids it, the cash stays due', async () => {
    // A drawer that took the money and closed without its close reaching the books.
    const shift = await prisma.shift.create({ data: { userId: cashier.id, openingFloatCents: 0, status: 'open', tenantId: A.tenantId } })
    const order = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'pos', fulfilmentType: 'takeout', status: 'cancelled', totalCents: 80_000, taxCents: 0,
        items: { create: [{ name: 'Kheer', quantity: 1, unitPriceCents: 80_000, menuItemId: A.items.kheer }] },
      },
    })
    const ref = `RDV${randomBytes(5).toString('hex').replace(/[^0-9]/g, '3').slice(0, 9)}`
    const rp = await prisma.payment.create({
      data: { orderId: order.id, shiftId: shift.id, method: 'raast', amountCents: 50_000, status: 'paid', processedAt: new Date(), gateway: 'raast', gatewayRef: ref },
    })
    await prisma.payment.create({ data: { orderId: order.id, shiftId: shift.id, method: 'cash', amountCents: 30_000, status: 'paid', processedAt: new Date() } })
    const receipt = await prisma.raastReceipt.create({
      data: {
        tenantId: A.tenantId, orderId: order.id, conceptId: A.conceptId, shiftId: shift.id, paymentId: rp.id,
        bankAccountId: bank.bankAccountId, ledgerCode: bank.ledgerCode, amountCents: 50_000, dueCents: 80_000, bankRef: ref,
        status: 'provisional', confirmedVia: 'cashier', confirmedAt: new Date(), cashierVerified: true,
        idempotencyKey: `pay:${rp.id}`, createdById: cashier.id,
      },
    })
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 30_000 } })

    expect(refundDueCents(await load(order.id))).toBe(80_000)

    const voided = await voidNeverBooked(receipt.id, { actorId: ceo.id, reason: 'Transfer never arrived, never booked' })
    expect(voided.status).toBe('voided')

    // Only the cash is still owed back.
    expect(refundDueCents(await load(order.id))).toBe(30_000)
    // The drawer's close holds only the cash as a refund due — never the voided Raast money.
    const rows = await prisma.payment.findMany({ where: { shiftId: shift.id }, include: SHIFT_SALE_PAYMENT_INCLUDE })
    const sales = summariseShiftSales(shift.id, rows)
    expect(sales.cancelledPaid.cashCents).toBe(30_000)
    expect(raastTotalCents(sales.cancelledPaid.raastByCode)).toBe(0)
    expect(sales.cancelledPaid.byOrder).toEqual([{ orderId: order.id, cents: 30_000 }])
    const close = await buildShiftCloseEntry(shift.id)
    expect(close.ok).toBe(true)
    if (close.ok) {
      expect(close.debits).toBe(close.credits)
      expect(close.lines.some((l) => l.accountCode === bank.ledgerCode)).toBe(false)
      expect(close.lines.filter((l) => l.accountCode === '1110' && l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)).toBe(30_000)
    }

    // A caller that does not load the receipt counts it as before.
    const { payments } = await load(order.id)
    expect(refundDueCents({ status: 'cancelled', payments: payments.map(({ raastReceipt: _r, ...p }) => p) })).toBe(80_000)
  })
})
