/**
 * What a buyer's pay-back voucher pays for (owner, 2026-11-24: "Not showing PO items in voucher").
 *
 * A pay-back voucher (procurement/poCash.ts raiseReimbursementTx) settles ONE supplier bill — the bill the CEO's GRN
 * approval made from what was really received. Its lines are the items the voucher pays for, so the voucher's screen,
 * print and PDF / Excel list them. Read only; the bill is looked up inside the VOUCHER's company (another company's
 * bill is never read). Quantities are shown in the unit the PO line was ordered in where there is one.
 */
import type { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export interface PayBackItem { id: string; item: string; quantity: number; unit: string; rateCents: number; totalCents: number }
export interface PayBackBill {
  id: string; billNumber: string; status: string
  supplier: { name: string }
  po: { id: string; reference: string | null } | null
  lines: PayBackItem[]
  /** The bill's own figures, so the voucher adds up: items + sales tax on the invoice − withholding = what is paid back. */
  itemsCents: number; taxCents: number; whtCents: number; totalCents: number
}

export async function payBackBillOf(db: Db, billId: string, tenantId: string): Promise<PayBackBill | null> {
  const bill = await db.supplierBill.findFirst({
    where: { id: billId, supplier: { tenantId } },
    select: {
      id: true, billNumber: true, status: true, subtotalCents: true, taxCents: true, whtCents: true, totalCents: true, supplier: { select: { name: true } }, po: { select: { id: true, reference: true } },
      lines: {
        orderBy: { id: 'asc' },
        select: {
          id: true, description: true, quantity: true, unitCostCents: true, lineTotalCents: true,
          inventoryItem: { select: { name: true, unit: true } },
          poLine: { select: { orderUnit: true, orderUnitFactor: true } },
        },
      },
    },
  })
  if (!bill) return null
  return {
    id: bill.id, billNumber: bill.billNumber, status: bill.status, supplier: bill.supplier, po: bill.po,
    itemsCents: Number(bill.subtotalCents), taxCents: Number(bill.taxCents), whtCents: Number(bill.whtCents), totalCents: Number(bill.totalCents),
    lines: bill.lines.map((l) => {
      const total = Number(l.lineTotalCents)
      const factor = l.poLine?.orderUnit && l.poLine.orderUnitFactor && l.poLine.orderUnitFactor > 0 ? l.poLine.orderUnitFactor : null
      const quantity = factor ? Math.round((l.quantity / factor) * 1e6) / 1e6 : l.quantity
      return {
        id: l.id,
        item: l.inventoryItem?.name ?? l.description ?? 'Item',
        quantity,
        unit: factor ? l.poLine!.orderUnit! : (l.inventoryItem?.unit ?? ''),
        rateCents: factor && quantity > 0 ? Math.round(total / quantity) : Number(l.unitCostCents),
        totalCents: total,
      }
    }),
  }
}
