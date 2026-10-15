// Trash — cancelled purchase orders, void supplier bills and void supplier
// payments (stream B7, spec §1c).
//
//   purchase_order    PurchaseOrder `cancelled`. Copy = CREATED: a new DRAFT
//                     through the module's own POST /procurement/purchase-orders
//                     (as the caller — its supplier / item / company checks
//                     decide), with today's item costs and only live items. A
//                     rejected PO returns to draft, so it is never listed.
//   supplier_bill     SupplierBill `void` (bills and credit notes). Copy =
//                     PREFILL of the bills form: supplier, dates, notes, lines
//                     (description, qty, unit cost, item / 6xxx account). The
//                     GRN / PO-line links are re-chosen (a stock line must bill
//                     an open receipt), WHT is re-resolved, nothing is posted.
//                     The supplier's bill number stays with the void bill
//                     (unique per supplier) — the form asks for it again.
//   supplier_payment  SupplierPayment `voidedAt`. Copy = PREFILL of the payment
//                     form: supplier, amount, method, bank account, notes. The
//                     reference # is entered again; allocations are never copied.
//
// Company: the supplier's (Supplier.tenantId); a company-less legacy supplier's
// rows are the CEO's only. Roles: POs = PROCUREMENT_TEAM (the PO routes'
// guard), bills / payments = MANAGERS (their void / create guard); module
// `procurement`.

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { AppError, NotFoundError } from '../../../../lib/errors.js'
import { MANAGERS, PROCUREMENT_TEAM } from '../../../auth/middleware.js'
import type { TrashCtx, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, injectCreate, n, pkr, pktDate, prefill, roles, scopeIds } from './common.js'

export const TRASH_PROCUREMENT = {
  purchase_order: 'purchase_order',
  supplier_bill: 'supplier_bill',
  supplier_payment: 'supplier_payment',
} as const

const PROC = roles(PROCUREMENT_TEAM)
const MGR = roles(MANAGERS)

/** The supplier in the caller's companies (company-less: the CEO only). */
function supplierScope(ctx: TrashCtx): Prisma.SupplierWhereInput {
  const ids = scopeIds(ctx.readScope)
  return ctx.isCeo ? { OR: [{ tenantId: { in: ids } }, { tenantId: null }] } : { tenantId: { in: ids } }
}

const qOn = (q: string | undefined, own: string[]): Record<string, unknown> => {
  const s = q?.trim()
  if (!s) return {}
  return { OR: [...own.map((f) => ({ [f]: { contains: s, mode: 'insensitive' } })), { supplier: { name: { contains: s, mode: 'insensitive' } } }] }
}

// ── Purchase orders ──────────────────────────────────────────────────────────

const PO_SELECT = {
  id: true, reference: true, totalCents: true, cancelledAt: true, cancelReason: true, updatedAt: true, cancelledById: true,
  supplier: { select: { name: true, tenantId: true } },
  _count: { select: { lines: true } },
} satisfies Prisma.PurchaseOrderSelect
type PoSel = Prisma.PurchaseOrderGetPayload<{ select: typeof PO_SELECT }>

const poRow = (p: PoSel): TrashRow => ({
  id: p.id,
  tenantId: p.supplier.tenantId,
  title: `PO to ${p.supplier.name} — ${pkr(p.totalCents)}`,
  subtitle: [p.reference, `${p._count.lines} line${p._count.lines === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
  at: p.cancelledAt ?? p.updatedAt,
  byId: p.cancelledById,
  reason: p.cancelReason,
  statusLabel: 'Cancelled',
})

const purchaseOrder: TrashProvider = {
  key: TRASH_PROCUREMENT.purchase_order,
  label: 'Purchase order',
  moduleId: 'procurement',
  roles: { list: PROC, restore: PROC, copy: PROC },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => '/procurement',
  async list(ctx, f) {
    const rows = await db.purchaseOrder.findMany({
      where: { AND: [{ supplier: supplierScope(ctx), status: 'cancelled', cancelledAt: { not: null } }, atWhere('cancelledAt', f), qOn(f.q, ['reference', 'cancelReason'])] },
      orderBy: [{ cancelledAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: PO_SELECT,
    })
    return rows.map(poRow)
  },
  async get(ctx, id) {
    const p = await db.purchaseOrder.findFirst({ where: { id, status: 'cancelled', supplier: supplierScope(ctx) }, select: PO_SELECT })
    return p ? poRow(p) : null
  },
  async copy(ctx, id) {
    const po = await db.purchaseOrder.findFirst({
      where: { id, status: 'cancelled', supplier: supplierScope(ctx) },
      select: {
        supplierId: true, reference: true, notes: true,
        supplier: { select: { deletedAt: true, name: true } },
        lines: { select: { inventoryItemId: true, quantityOrdered: true, unitCostCents: true, notes: true, inventoryItem: { select: { unitCostCents: true, deletedAt: true } } } },
      },
    })
    if (!po) throw new NotFoundError('Trash item', id)
    if (po.supplier.deletedAt) throw new AppError('SUPPLIER_DELETED', `${po.supplier.name} was deleted — restore the supplier or raise a new PO to another`, 422)
    // Prices are re-read: today's cost of the item, else the price agreed then.
    const lines = po.lines
      .filter((l) => !l.inventoryItem.deletedAt)
      .map((l) => ({
        inventoryItemId: l.inventoryItemId,
        quantityOrdered: l.quantityOrdered,
        // A null or zero "today's cost" (never costed yet) falls back to the agreed price.
        unitCostCents: l.inventoryItem.unitCostCents && l.inventoryItem.unitCostCents > 0 ? l.inventoryItem.unitCostCents : l.unitCostCents,
        notes: l.notes,
      }))
    if (!lines.length) throw new AppError('NOTHING_TO_COPY', 'Every item on this PO was deleted — raise a new PO', 422)
    // Never: approval, sent / received state, the old reference's sent email.
    const newId = await injectCreate(ctx, '/procurement/purchase-orders', {
      supplierId: po.supplierId,
      reference: po.reference,
      notes: po.notes,
      lines,
    }, (j) => (typeof j.id === 'string' ? j.id : undefined))
    return { mode: 'created', id: newId, link: '/procurement', newEntityType: 'PurchaseOrder' }
  },
  erasable: () => false,
}

// ── Supplier bills / credit notes ────────────────────────────────────────────

const BILL_SELECT = {
  id: true, kind: true, billNumber: true, totalCents: true, voidedAt: true, voidReason: true, updatedAt: true,
  supplier: { select: { name: true, tenantId: true } },
} satisfies Prisma.SupplierBillSelect
type BillSel = Prisma.SupplierBillGetPayload<{ select: typeof BILL_SELECT }>

const billRow = (b: BillSel): TrashRow => ({
  id: b.id,
  tenantId: b.supplier.tenantId,
  title: `${b.kind === 'credit_note' ? 'Credit note' : 'Bill'} ${b.billNumber} — ${b.supplier.name}`,
  subtitle: pkr(b.totalCents),
  at: b.voidedAt ?? b.updatedAt,
  reason: b.voidReason,
  statusLabel: 'Void',
})

const supplierBill: TrashProvider = {
  key: TRASH_PROCUREMENT.supplier_bill,
  label: 'Supplier bill',
  moduleId: 'procurement',
  roles: { list: MGR, restore: MGR, copy: MGR },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => '/procurement',
  async list(ctx, f) {
    const rows = await db.supplierBill.findMany({
      where: { AND: [{ supplier: supplierScope(ctx), status: 'void', voidedAt: { not: null } }, atWhere('voidedAt', f), qOn(f.q, ['billNumber', 'voidReason'])] },
      orderBy: [{ voidedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: BILL_SELECT,
    })
    return rows.map(billRow)
  },
  async get(ctx, id) {
    const b = await db.supplierBill.findFirst({ where: { id, status: 'void', supplier: supplierScope(ctx) }, select: BILL_SELECT })
    return b ? billRow(b) : null
  },
  async copy(ctx, id) {
    const b = await db.supplierBill.findFirst({
      where: { id, status: 'void', supplier: supplierScope(ctx) },
      select: {
        kind: true, supplierId: true, billNumber: true, billDate: true, dueDate: true, notes: true, taxAuthority: true, originalBillId: true,
        supplier: { select: { deletedAt: true, name: true } },
        lines: { select: { inventoryItemId: true, description: true, quantity: true, unitCostCents: true, expenseAccountCode: true, returnQty: true } },
      },
    })
    if (!b) throw new NotFoundError('Trash item', id)
    const warnings: string[] = [`Bill number ${b.billNumber} stays with the void ${b.kind === 'credit_note' ? 'credit note' : 'bill'} — enter the supplier's number again`]
    if (b.supplier.deletedAt) warnings.push(`${b.supplier.name} was deleted — pick the supplier again`)
    if (b.lines.some((l) => l.inventoryItemId)) warnings.push('Stock lines must be linked to an open goods receipt again')
    // Never: GRN / PO-line links, WHT, paid / credited amounts, the posting.
    return prefill('/procurement', {
      kind: b.kind,
      supplierId: b.supplier.deletedAt ? null : b.supplierId,
      originalBillNumber: b.billNumber,
      originalBillId: b.kind === 'credit_note' ? b.originalBillId : null,
      billDate: pktDate(b.billDate),
      dueDate: pktDate(b.dueDate),
      taxAuthority: b.taxAuthority,
      notes: b.notes,
      lines: b.lines.map((l) => ({
        inventoryItemId: l.inventoryItemId,
        description: l.description,
        quantity: l.quantity,
        unitCostCents: n(l.unitCostCents),
        expenseAccountCode: l.expenseAccountCode,
        ...(l.returnQty != null ? { returnQty: l.returnQty } : {}),
      })),
      warnings,
    })
  },
  erasable: () => false,
}

// ── Supplier payments ────────────────────────────────────────────────────────

const PAY_SELECT = {
  id: true, amountCents: true, method: true, paymentDate: true, voidedAt: true, voidReason: true,
  supplier: { select: { name: true, tenantId: true } },
} satisfies Prisma.SupplierPaymentSelect
type PaySel = Prisma.SupplierPaymentGetPayload<{ select: typeof PAY_SELECT }>

const payRow = (p: PaySel): TrashRow => ({
  id: p.id,
  tenantId: p.supplier.tenantId,
  title: `Payment to ${p.supplier.name} — ${pkr(p.amountCents)}`,
  subtitle: `${p.method.replace('_', ' ')} · paid ${pktDate(p.paymentDate)}`,
  at: p.voidedAt ?? p.paymentDate,
  reason: p.voidReason,
  statusLabel: 'Void',
})

const supplierPayment: TrashProvider = {
  key: TRASH_PROCUREMENT.supplier_payment,
  label: 'Supplier payment',
  moduleId: 'procurement',
  roles: { list: MGR, restore: MGR, copy: MGR },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => '/procurement',
  async list(ctx, f) {
    const rows = await db.supplierPayment.findMany({
      where: { AND: [{ supplier: supplierScope(ctx), voidedAt: { not: null } }, atWhere('voidedAt', f), qOn(f.q, ['voidReason', 'notes'])] },
      orderBy: [{ voidedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: PAY_SELECT,
    })
    return rows.map(payRow)
  },
  async get(ctx, id) {
    const p = await db.supplierPayment.findFirst({ where: { id, voidedAt: { not: null }, supplier: supplierScope(ctx) }, select: PAY_SELECT })
    return p ? payRow(p) : null
  },
  async copy(ctx, id) {
    const p = await db.supplierPayment.findFirst({
      where: { id, voidedAt: { not: null }, supplier: supplierScope(ctx) },
      select: { supplierId: true, amountCents: true, method: true, bankAccountId: true, notes: true },
    })
    if (!p) throw new NotFoundError('Trash item', id)
    // Never: the reference #, the allocations, the posting.
    return prefill('/procurement', {
      supplierId: p.supplierId,
      amountCents: n(p.amountCents),
      method: p.method,
      bankAccountId: p.bankAccountId,
      notes: p.notes,
      reference: null,
    })
  },
  erasable: () => false,
}

export const PROCUREMENT_TRASH_PROVIDERS: readonly TrashProvider[] = [purchaseOrder, supplierBill, supplierPayment]
