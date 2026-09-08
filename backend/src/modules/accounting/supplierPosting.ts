// Supplier bill / payment / waste → journal posting.
//
// Bill creation: increases inventory (or expense) + GST input + AP.
// Payment: reduces AP + cash/bank.
// Waste: derecognises inventory to waste expense.
//
// All idempotent on (sourceType, sourceId).

import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry, type JournalLineInput } from './journal.js'
import { getOperationsConfig } from '../../lib/setup-config.js'

export async function postSupplierBill(billId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const bill = await prisma.supplierBill.findUnique({
    where: { id: billId },
    include: { supplier: true, lines: { include: { inventoryItem: true } } },
  })
  if (!bill) return { posted: false, entryId: null, reason: 'bill_not_found' }
  if (bill.status === 'void') return { posted: false, entryId: null, reason: 'bill_voided' }

  // v1: book all inventory purchases to Food. Beverage/Packaging splits will
  // come once InventoryItem grows a `category` field — see schema TODO.
  const lines: JournalLineInput[] = []
  if (bill.subtotalCents > 0) {
    lines.push({ accountCode: ACCT.INVENTORY_FOOD, type: 'debit', amountCents: bill.subtotalCents, memo: `Bill ${bill.billNumber}` })
  }
  if (bill.taxCents > 0) {
    lines.push({ accountCode: ACCT.GST_INPUT, type: 'debit', amountCents: bill.taxCents, memo: `Input GST on bill ${bill.billNumber}` })
  }

  // Withholding tax — section 153/153A. We deduct at source: supplier is
  // paid net of WHT, and we book a payable to FBR for the deducted amount.
  // The `withholdingTaxRecoverable` flag is informational (tracked in audit
  // metadata so the operator can later claim it).
  // Math: Inventory dr X, AP cr (X-WHT), WHT_PAYABLE cr WHT  → balanced.
  const ops = await getOperationsConfig(bill.supplier?.tenantId ?? null)
  let whtCents = 0
  if (ops.withholdingTaxEnabled && ops.withholdingTaxPct > 0 && bill.subtotalCents > 0) {
    whtCents = Math.round(bill.subtotalCents * ops.withholdingTaxPct)
    if (whtCents > 0) {
      lines.push({
        accountCode: ACCT.WHT_PAYABLE,
        type: 'credit',
        amountCents: whtCents,
        memo: `WHT ${(ops.withholdingTaxPct * 100).toFixed(2)}% on ${bill.billNumber}${ops.withholdingTaxRecoverable ? ' (recoverable)' : ''}`,
      })
    }
  }

  const apPayable = bill.totalCents - whtCents
  lines.push({ accountCode: ACCT.AP_SUPPLIERS, type: 'credit', amountCents: apPayable, memo: `${bill.supplier.name} bill ${bill.billNumber}${whtCents > 0 ? ' (net of WHT)' : ''}` })

  const result = await postJournalEntry({
    sourceType: 'supplier.bill',
    sourceId: bill.id,
    description: `Supplier bill ${bill.billNumber} from ${bill.supplier.name}`,
    entryDate: bill.billDate,
    postedBy: 'system',
    lines,
  })
  return { posted: result.posted, entryId: result.entryId }
}

export async function postSupplierBillVoid(billId: string, reason: string): Promise<{ posted: boolean; entryId: string | null }> {
  const { reverseJournalEntry } = await import('./journal.js')
  try {
    const result = await reverseJournalEntry('supplier.bill', billId, reason, { suffix: 'void' })
    return { posted: result.posted, entryId: result.entryId }
  } catch {
    return { posted: false, entryId: null }
  }
}

export async function postSupplierPayment(paymentId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const payment = await prisma.supplierPayment.findUnique({
    where: { id: paymentId },
    include: { supplier: true, applications: { include: { bill: true } } },
  })
  if (!payment) return { posted: false, entryId: null, reason: 'payment_not_found' }

  // method → cash account
  const cashAccount =
    payment.method === 'cash'   ? ACCT.CASH_ON_HAND :
    /* bank_transfer/cheque/wallet */ ACCT.BANK

  const lines: JournalLineInput[] = [
    { accountCode: ACCT.AP_SUPPLIERS, type: 'debit',  amountCents: payment.amountCents, memo: `Payment to ${payment.supplier.name}` },
    { accountCode: cashAccount,       type: 'credit', amountCents: payment.amountCents, memo: `${payment.method} via ${payment.reference ?? 'no ref'}` },
  ]

  const result = await postJournalEntry({
    sourceType: 'supplier.payment',
    sourceId: payment.id,
    description: `Supplier payment to ${payment.supplier.name} (${payment.method})`,
    entryDate: payment.paymentDate,
    postedBy: 'system',
    lines,
  })
  return { posted: result.posted, entryId: result.entryId }
}

export async function postWasteLog(wasteLogId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const log = await prisma.wasteLog.findUnique({
    where: { id: wasteLogId },
    include: { inventoryItem: true },
  })
  if (!log) return { posted: false, entryId: null, reason: 'waste_log_not_found' }

  const cost = log.estimatedCostCents ?? Math.round((log.inventoryItem.unitCostCents ?? 0) * log.quantity)
  if (cost <= 0) return { posted: false, entryId: null, reason: 'zero_cost' }

  const lines: JournalLineInput[] = [
    { accountCode: ACCT.WASTE,           type: 'debit',  amountCents: cost, memo: `Waste: ${log.reason} — ${log.inventoryItem.name}` },
    { accountCode: ACCT.INVENTORY_FOOD,  type: 'credit', amountCents: cost, memo: `Inventory derecognised (waste)` },
  ]

  const result = await postJournalEntry({
    sourceType: 'inventory.waste',
    sourceId: log.id,
    description: `Waste — ${log.inventoryItem.name} (${log.reason})`,
    entryDate: log.recordedAt,
    postedBy: log.recordedById ?? 'system',
    lines,
  })
  return { posted: result.posted, entryId: result.entryId }
}
