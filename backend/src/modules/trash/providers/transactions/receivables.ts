// Trash — void receivable invoices / credit notes, reversed receipts and
// rejected or cancelled write-offs (stream B7, spec §1c).
//
//   receivable_invoice   ReceivableInvoice `void`, kinds invoice / credit_note.
//                        On-account STATEMENTS are excluded (they are
//                        regenerated per period). Copy = PREFILL of the invoice
//                        form: customer, brand, description, amount, tax,
//                        revenue account, notes. The number and the posting are
//                        new; dates start from today.
//   receivable_payment   ReceivablePayment `reversedAt` (a bounced cheque…).
//                        Copy = PREFILL of "record payment" on its invoice:
//                        amount, method, bank account. The payment reference #
//                        is required again (never copied).
//   receivable_writeoff  ReceivableWriteOff `rejected` / `cancelled`. Copy =
//                        PREFILL of the write-off request: invoice, amount,
//                        reason. Evidence is attached again; the CEO decides
//                        again.
//
// Company: the row's own tenantId. Roles = FINANCIALS_VIEWERS (the receivables
// routes' guard) and WRITE_OFF_REQUESTERS for write-offs; module `accounting`.

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { NotFoundError } from '../../../../lib/errors.js'
import { FINANCIALS_VIEWERS } from '../../../auth/middleware.js'
import { WRITE_OFF_REQUESTERS } from '../../../receivables/writeOffs.js'
import type { TrashCtx, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, n, pkr, prefill, qWhere, roles, scopeIds } from './common.js'

export const TRASH_RECEIVABLES = {
  receivable_invoice: 'receivable_invoice',
  receivable_payment: 'receivable_payment',
  receivable_writeoff: 'receivable_writeoff',
} as const

const FIN = roles(FINANCIALS_VIEWERS)
const WO = roles(WRITE_OFF_REQUESTERS)
const LINK = '/accounting/receivables'
const tenantIn = (ctx: TrashCtx) => ({ tenantId: { in: scopeIds(ctx.readScope) } })

// ── Invoices / credit notes ──────────────────────────────────────────────────

const INV_SELECT = {
  id: true, tenantId: true, conceptId: true, kind: true, number: true, customerName: true,
  amountCents: true, taxCents: true, voidedAt: true, voidReason: true, updatedAt: true,
} satisfies Prisma.ReceivableInvoiceSelect
type InvSel = Prisma.ReceivableInvoiceGetPayload<{ select: typeof INV_SELECT }>
const VOID_INVOICE = { status: 'void', kind: { in: ['invoice', 'credit_note'] } } satisfies Prisma.ReceivableInvoiceWhereInput

const invRow = (i: InvSel): TrashRow => ({
  id: i.id,
  tenantId: i.tenantId,
  conceptId: i.conceptId,
  title: `${i.kind === 'credit_note' ? 'Credit note' : 'Invoice'} ${i.number} — ${i.customerName}`,
  subtitle: pkr(n(i.amountCents) + n(i.taxCents)),
  at: i.voidedAt ?? i.updatedAt,
  reason: i.voidReason,
  statusLabel: 'Void',
})

const receivableInvoice: TrashProvider = {
  key: TRASH_RECEIVABLES.receivable_invoice,
  label: 'Receivable invoice',
  moduleId: 'accounting',
  roles: { list: FIN, restore: FIN, copy: FIN },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => LINK,
  async list(ctx, f) {
    const rows = await db.receivableInvoice.findMany({
      where: { AND: [tenantIn(ctx), VOID_INVOICE, { voidedAt: { not: null } }, atWhere('voidedAt', f), qWhere(f.q, ['number', 'customerName', 'description', 'voidReason'])] },
      orderBy: [{ voidedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: INV_SELECT,
    })
    return rows.map(invRow)
  },
  async get(ctx, id) {
    const i = await db.receivableInvoice.findFirst({ where: { id, ...tenantIn(ctx), ...VOID_INVOICE }, select: INV_SELECT })
    return i ? invRow(i) : null
  },
  async copy(ctx, id) {
    const i = await db.receivableInvoice.findFirst({
      where: { id, ...tenantIn(ctx), ...VOID_INVOICE },
      select: {
        kind: true, conceptId: true, customerName: true, customerEmail: true, customerPhone: true, customerNtn: true,
        customerId: true, customerAccountId: true, description: true, amountCents: true, taxCents: true,
        revenueAccountCode: true, notes: true, originalInvoiceId: true,
      },
    })
    if (!i) throw new NotFoundError('Trash item', id)
    // Never: the number, the dates, paid / credited / withheld / written-off amounts, the posting.
    return prefill(LINK, {
      kind: i.kind,
      conceptId: i.conceptId,
      customerName: i.customerName,
      customerEmail: i.customerEmail,
      customerPhone: i.customerPhone,
      customerNtn: i.customerNtn,
      customerId: i.customerId,
      customerAccountId: i.customerAccountId,
      description: i.description,
      amountCents: n(i.amountCents),
      taxCents: n(i.taxCents),
      revenueAccountCode: i.revenueAccountCode,
      notes: i.notes,
      ...(i.kind === 'credit_note' ? { invoiceId: i.originalInvoiceId, originalInvoiceId: i.originalInvoiceId } : {}),
    })
  },
  erasable: () => false,
}

// ── Reversed receipts ────────────────────────────────────────────────────────

const PAY_SELECT = {
  id: true, tenantId: true, amountCents: true, method: true, reversedAt: true, reversedReason: true, receivedAt: true,
  invoice: { select: { number: true, customerName: true, conceptId: true } },
} satisfies Prisma.ReceivablePaymentSelect
type PaySel = Prisma.ReceivablePaymentGetPayload<{ select: typeof PAY_SELECT }>

const payRow = (p: PaySel): TrashRow => ({
  id: p.id,
  tenantId: p.tenantId,
  conceptId: p.invoice.conceptId,
  title: `Receipt ${pkr(p.amountCents)} on ${p.invoice.number}`,
  subtitle: `${p.invoice.customerName} · ${p.method.replace('_', ' ')}`,
  at: p.reversedAt ?? p.receivedAt,
  reason: p.reversedReason,
  statusLabel: 'Reversed',
})

const receivablePayment: TrashProvider = {
  key: TRASH_RECEIVABLES.receivable_payment,
  label: 'Receivable receipt',
  moduleId: 'accounting',
  roles: { list: FIN, restore: FIN, copy: FIN },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => LINK,
  async list(ctx, f) {
    const s = f.q?.trim()
    const rows = await db.receivablePayment.findMany({
      where: {
        AND: [
          tenantIn(ctx), { reversedAt: { not: null } }, atWhere('reversedAt', f),
          s ? { OR: [{ reversedReason: { contains: s, mode: 'insensitive' } }, { invoice: { number: { contains: s, mode: 'insensitive' } } }, { invoice: { customerName: { contains: s, mode: 'insensitive' } } }] } : {},
        ],
      },
      orderBy: [{ reversedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: PAY_SELECT,
    })
    return rows.map(payRow)
  },
  async get(ctx, id) {
    const p = await db.receivablePayment.findFirst({ where: { id, ...tenantIn(ctx), reversedAt: { not: null } }, select: PAY_SELECT })
    return p ? payRow(p) : null
  },
  async copy(ctx, id) {
    const p = await db.receivablePayment.findFirst({
      where: { id, ...tenantIn(ctx), reversedAt: { not: null } },
      select: { invoiceId: true, amountCents: true, method: true, bankAccountId: true, taxAuthority: true },
    })
    if (!p) throw new NotFoundError('Trash item', id)
    // Never: the payment reference # (required again), the posting.
    return prefill(LINK, {
      invoiceId: p.invoiceId,
      amountCents: n(p.amountCents),
      method: p.method,
      bankAccountId: p.bankAccountId,
      taxAuthority: p.taxAuthority,
      reference: null,
    })
  },
  erasable: () => false,
}

// ── Rejected / cancelled write-offs ──────────────────────────────────────────

const WO_SELECT = {
  id: true, tenantId: true, amountCents: true, reason: true, status: true, decidedAt: true, decidedById: true, decisionNote: true, requestedAt: true,
  invoice: { select: { number: true, customerName: true, conceptId: true } },
} satisfies Prisma.ReceivableWriteOffSelect
type WoSel = Prisma.ReceivableWriteOffGetPayload<{ select: typeof WO_SELECT }>

const woRow = (w: WoSel): TrashRow => ({
  id: w.id,
  tenantId: w.tenantId,
  conceptId: w.invoice.conceptId,
  title: `Write-off ${pkr(w.amountCents)} on ${w.invoice.number}`,
  subtitle: w.invoice.customerName,
  at: w.decidedAt ?? w.requestedAt,
  byId: w.decidedById,
  reason: w.decisionNote,
  statusLabel: w.status === 'rejected' ? 'Rejected' : 'Cancelled',
})

const WO_DEAD = { status: { in: ['rejected', 'cancelled'] } } satisfies Prisma.ReceivableWriteOffWhereInput

const receivableWriteOff: TrashProvider = {
  key: TRASH_RECEIVABLES.receivable_writeoff,
  label: 'Write-off request',
  moduleId: 'accounting',
  roles: { list: WO, restore: WO, copy: WO },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => LINK,
  async list(ctx, f) {
    const s = f.q?.trim()
    const rows = await db.receivableWriteOff.findMany({
      where: {
        AND: [
          tenantIn(ctx), WO_DEAD, { decidedAt: { not: null } }, atWhere('decidedAt', f),
          s ? { OR: [{ reason: { contains: s, mode: 'insensitive' } }, { invoice: { number: { contains: s, mode: 'insensitive' } } }] } : {},
        ],
      },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: WO_SELECT,
    })
    return rows.map(woRow)
  },
  async get(ctx, id) {
    const w = await db.receivableWriteOff.findFirst({ where: { id, ...tenantIn(ctx), ...WO_DEAD }, select: WO_SELECT })
    return w ? woRow(w) : null
  },
  async copy(ctx, id) {
    const w = await db.receivableWriteOff.findFirst({
      where: { id, ...tenantIn(ctx), ...WO_DEAD },
      select: { invoiceId: true, amountCents: true, reason: true },
    })
    if (!w) throw new NotFoundError('Trash item', id)
    // Never: the CEO's decision, the evidence (attached again), the posting.
    return prefill(LINK, { invoiceId: w.invoiceId, amountCents: n(w.amountCents), reason: w.reason })
  },
  erasable: () => false,
}

export const RECEIVABLE_TRASH_PROVIDERS: readonly TrashProvider[] = [receivableInvoice, receivablePayment, receivableWriteOff]
