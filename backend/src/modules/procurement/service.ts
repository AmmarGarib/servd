// Enterprise procurement service
//
// Owns:
//  - Purchase order lifecycle (create → submit → approve → send → receive → close)
//      draft → pending_approval (at/above the company's threshold) → approved
//      draft → approved (below it: auto-approved)
//      approved → sent ONLY when it actually goes out: emailed / WhatsApped by
//      sendPoToSupplier, or marked sent by staff who phoned it in (markPoSent).
//      Approval used to stamp 'sent' + sentAt though nothing was sent, so staff
//      believed a PO had gone out that the supplier never got.
//  - Receiving (receiving.ts: GRN + FIFO lots + GRNI, the one stock-in path)
//  - Supplier bills (AP), 3-way matching (PO ↔ receipt ↔ bill); a stock line
//    clears 2015 GRNI against its receipt (accounting/supplierPosting.ts)
//  - Multi-bill payment allocation, unapplying and voiding a payment
//  - Aging report
//  - Reorder suggestions
//  - PO email dispatch + audit trail
// Supplier credit notes / returns live in ./creditNotes.ts (the same AP
// subledger: SupplierBill rows of kind 'credit_note').

import { isBelowPar } from '../../lib/recipeCost.js'
import { classifyByReferenceTx, type ClassificationInput } from '../accounting/paymentsRegister.js'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { sendEmail } from '../../lib/notify.js'
import { moneyAccountCode } from '../../lib/bankAccounts.js'
import { withholdingForBill, postSupplierBill, postSupplierBillVoid, postSupplierPayment, postSupplierPaymentVoid } from '../accounting/supplierPosting.js'
import { sendText as sendWhatsApp } from '../../lib/whatsapp.js'
import { testCompanyBlocks, externalScope } from '../../lib/outboundScope.js'
import { postedOpeningBalances } from './openingBalance.js'
import { assertItemsOfCompany } from './scope.js'
import type { Prisma } from '@prisma/client'
import { type DbMoney, assertInt4Fits, assertMoneyFits, toCents } from '../../lib/money.js'
import { ensureFifoReady } from '../../lib/stockLedger.js'
import { flagException } from '../../lib/exceptions.js'
import { audit } from '../../lib/audit.js'
import { assertNotEquipmentLine } from '../fixedAssets/classes.js'
import { assertExpenseCode } from '../accounting/expenseCategories.js'
import { isAuthorityKey, type AuthorityKey } from '../accounting/taxAuthorities.js'
import { whtSectionOrNull, type WhtSection } from '../../lib/withholding.js'
import { fmtPktDate } from '../accounting/dates.js'
import { moveToTrash } from '../../lib/trash.js'
import { takeSnapshot } from '../trash/snapshot.js'

// ─── Amount ceilings (BOOKS-06) ──────────────────────────────────────────────
//
// PO totals, bill subtotal / tax / total / WHT, stock-line totals, payments
// and applications are BIGINT paisa: one amount ≤ MAX_MONEY_CENTS (PKR 900bn).
// A unit cost that becomes an item's STOCK cost (a PO line, a stock-linked
// bill line, receiving) lands in INT4 columns and stays ≤ INT4_MAX_CENTS
// (PKR 21,474,836.47); so do a bill's non-stock lines, which the ledger books
// to 1210 like stock (see createBill). Above either it is refused here, before
// anything is written, with 422 AMOUNT_TOO_LARGE (lib/money.ts).

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * Approval threshold from the Settings table. Above this, POs require admin
 * approval. Stored in paisa. Default 50,000 PKR = 5,000,000 paisa.
 *
 * Per company: `procurement.approvalThresholdCents:<tenantId>`. The old
 * company-less key is the read fallback until the company saves its own —
 * it used to be the one row every company shared, and it is never written
 * any more.
 */
const APPROVAL_THRESHOLD_KEY = 'procurement.approvalThresholdCents'
const DEFAULT_APPROVAL_THRESHOLD_CENTS = 5_000_000

export async function getApprovalThresholdCents(tenantId: string | null): Promise<number> {
  const row =
    (tenantId ? await prisma.setting.findUnique({ where: { key: `${APPROVAL_THRESHOLD_KEY}:${tenantId}` } }) : null) ??
    (await prisma.setting.findUnique({ where: { key: APPROVAL_THRESHOLD_KEY } }))
  if (!row?.value) return DEFAULT_APPROVAL_THRESHOLD_CENTS
  const n = parseInt(row.value, 10)
  return Number.isFinite(n) ? n : DEFAULT_APPROVAL_THRESHOLD_CENTS
}

export async function setApprovalThresholdCents(tenantId: string, thresholdCents: number): Promise<void> {
  const key = `${APPROVAL_THRESHOLD_KEY}:${tenantId}`
  await prisma.setting.upsert({
    where:  { key },
    create: { key, value: String(thresholdCents) },
    update: { value: String(thresholdCents) },
  })
}

// ─── PO lifecycle ────────────────────────────────────────────────────────────

export interface CreatePoInput {
  supplierId: string
  expectedDate?: string | null
  reference?: string | null
  notes?: string | null
  lines: Array<{ inventoryItemId: string; quantityOrdered: number; unitCostCents: number; notes?: string | null }>
  createdBy: string
}

export async function createPo(input: CreatePoInput) {
  if (input.lines.length === 0) {
    throw new AppError('NO_LINES', 'A PO needs at least one line', 400)
  }

  // A PO belongs to its supplier's company, and so must every item on it —
  // receiving it moves those items' stock and cost. A supplier with no
  // company can't be ordered from (receiving refuses it for the same reason).
  const supplier = await prisma.supplier.findUnique({
    where:  { id: input.supplierId },
    select: { id: true, name: true, tenantId: true, deletedAt: true, systemKind: true },
  })
  if (!supplier || supplier.deletedAt) throw new NotFoundError('Supplier', input.supplierId)
  if (supplier.systemKind) throw systemSupplierError(supplier.name)
  if (!supplier.tenantId) {
    throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'Assign this supplier to a company before ordering from it', 422)
  }
  await assertItemsOfCompany(input.lines.map((l) => l.inventoryItemId), supplier.tenantId, supplier.name)

  // A PO line's unit cost is INT4 (it becomes the item's stock cost); the
  // line total and the PO total are BIGINT (422, not a 500 at insert).
  input.lines.forEach((l, i) => {
    assertInt4Fits(l.unitCostCents, `Line ${i + 1}'s unit cost`)
    assertMoneyFits(Math.round(l.unitCostCents * l.quantityOrdered), `Line ${i + 1} (quantity × unit cost)`)
  })
  const totalCents = input.lines.reduce((s, l) => s + Math.round(l.unitCostCents * l.quantityOrdered), 0)
  assertMoneyFits(totalCents, 'This purchase order\'s total')

  const po = await prisma.purchaseOrder.create({
    data: {
      supplierId:   input.supplierId,
      expectedDate: input.expectedDate ? new Date(input.expectedDate) : null,
      reference:    input.reference   ?? null,
      notes:        input.notes       ?? null,
      totalCents,
      createdBy:    input.createdBy,
      status:       'draft',
      lines: {
        create: input.lines.map((l) => ({
          inventoryItemId: l.inventoryItemId,
          quantityOrdered: l.quantityOrdered,
          unitCostCents:   l.unitCostCents,
          notes:           l.notes ?? null,
        })),
      },
      activityLog: {
        create: { userId: input.createdBy, action: 'created', details: { totalCents, lineCount: input.lines.length } },
      },
    },
    include: { supplier: true, lines: { include: { inventoryItem: true } } },
  })

  return po
}

/**
 * Submit a draft PO for approval, or auto-approve it under the threshold.
 * Approved is not sent: the PO goes to the supplier through sendPoToSupplier
 * or markPoSent.
 *
 * Head office (D1/D3, spec §6.4 + A3): a PO submitted through a head office
 * (`viaHeadOfficeId`, from lib/headOffice.ts viaHeadOfficeForSubmit) ALWAYS
 * goes to pending_approval, whatever the threshold (`forceApproval`), and is
 * stamped with that head office in the same transaction. With neither option
 * the behaviour is exactly the pre-head-office one.
 */
export async function submitPo(
  poId: string,
  userId: string,
  opts: { forceApproval?: boolean; viaHeadOfficeId?: string | null } = {},
) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId }, include: { supplier: { select: { tenantId: true } } } })
  if (!po) throw new NotFoundError('PurchaseOrder', poId)
  if (po.status !== 'draft') throw new AppError('INVALID_STATE', `Cannot submit PO in status ${po.status}`, 400)

  // The PO's company's threshold (its supplier's company).
  const threshold = await getApprovalThresholdCents(po.supplier.tenantId)
  const total = toCents(po.totalCents)
  const via = opts.viaHeadOfficeId ?? null
  const forced = !!opts.forceApproval && total < threshold
  const needsApproval = total >= threshold || !!opts.forceApproval

  return prisma.$transaction(async (tx) => {
    const newStatus = needsApproval ? 'pending_approval' : 'approved'
    // Claim the draft: two submits racing never both pass.
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: poId, status: 'draft' },
      data: {
        ...(needsApproval
          ? { status: 'pending_approval' }
          : { status: 'approved', approvedById: userId, approvedAt: new Date() }),
        ...(via ? { viaHeadOfficeId: via } : {}),
      },
    })
    if (claimed.count === 0) throw new AppError('INVALID_STATE', 'This PO changed meanwhile — reload it', 409)
    await tx.poActivityLog.create({
      data: {
        purchaseOrderId: poId, userId, action: 'submitted',
        details: { needsApproval, threshold, total, ...(via ? { viaHeadOfficeId: via } : {}), ...(forced ? { forcedApproval: true } : {}) },
      },
    })
    if (!needsApproval) {
      await tx.poActivityLog.create({
        data: { purchaseOrderId: poId, userId, action: 'auto_approved', details: { reason: 'below_threshold' } },
      })
    }
    return { id: poId, status: newStatus, needsApproval }
  })
}

/**
 * How an approval decision was granted (lib/approvalRights.ts): recorded on
 * the PO's activity log only when it came through a hand-over, so a role-path
 * decision writes exactly the row it always did.
 */
export interface PoDecisionVia { via: 'role' | 'delegation'; delegationId?: string }

function decisionDetails(via?: PoDecisionVia): Record<string, unknown> | null {
  return via?.via === 'delegation' ? { via: 'delegation', delegationId: via.delegationId ?? null } : null
}

/**
 * pending_approval → approved. The claim is a conditional update on the
 * status: a second approver (a deputy, the CEO) racing this one gets 409.
 */
export async function approvePo(poId: string, approverId: string, decision?: PoDecisionVia) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } })
  if (!po) throw new NotFoundError('PurchaseOrder', poId)
  if (po.status !== 'pending_approval') throw new AppError('INVALID_STATE', `Cannot approve PO in status ${po.status}`, 400)

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: poId, status: 'pending_approval' },
      data:  { status: 'approved', approvedById: approverId, approvedAt: new Date() },
    })
    if (claimed.count === 0) throw new AppError('INVALID_STATE', 'This PO was decided meanwhile — reload it', 409)
    const details = decisionDetails(decision)
    await tx.poActivityLog.create({ data: { purchaseOrderId: poId, userId: approverId, action: 'approved', ...(details ? { details: details as Prisma.InputJsonValue } : {}) } })
    return { id: poId, status: 'approved' }
  })
}

/** pending_approval → draft with the reason; claimed on the status like approvePo. */
export async function rejectPo(poId: string, approverId: string, reason: string, decision?: PoDecisionVia) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } })
  if (!po) throw new NotFoundError('PurchaseOrder', poId)
  if (po.status !== 'pending_approval') throw new AppError('INVALID_STATE', `Cannot reject PO in status ${po.status}`, 400)

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: poId, status: 'pending_approval' },
      data:  { status: 'draft', rejectedReason: reason },
    })
    if (claimed.count === 0) throw new AppError('INVALID_STATE', 'This PO was decided meanwhile — reload it', 409)
    await tx.poActivityLog.create({ data: { purchaseOrderId: poId, userId: approverId, action: 'rejected', details: { reason, ...(decisionDetails(decision) ?? {}) } as Prisma.InputJsonValue } })
    return { id: poId, status: 'draft' }
  })
}

export async function cancelPo(poId: string, userId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    // Serialised with receiving (receiving.ts locks the same row) and with a
    // bill billed ahead of delivery (supplierPosting.ts locks it too): the
    // checks below read the PO as it is under the lock.
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
    const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: { select: { id: true, quantityReceived: true } } } })
    if (!po) throw new NotFoundError('PurchaseOrder', poId)
    if (po.status === 'cancelled') throw new AppError('INVALID_STATE', 'Already cancelled', 400)
    if (po.status === 'received') throw new AppError('INVALID_STATE', 'Cannot cancel a fully received PO', 400)

    const hasReceiving = po.lines.some((l) => l.quantityReceived > 0)
    if (hasReceiving) throw new AppError('INVALID_STATE', 'Cannot cancel — some lines have been received. Adjust manually.', 400)

    // A bill booked against this PO before delivery debited 2015 GRNI and
    // waits (a 'pending' GrniMatch) for the goods. Cancelling would strand
    // that debit and leave the bill payable for goods that can never arrive.
    // (A "short" credit note for the whole quantity voids those matches, so
    // the cancel goes through after it.)
    const lineIds = po.lines.map((l) => l.id)
    const pending = lineIds.length === 0 ? null : await tx.grniMatch.findFirst({
      where:  { poLineId: { in: lineIds }, status: 'pending' },
      select: { bill: { select: { billNumber: true } } },
    })
    if (pending) {
      throw new AppError(
        'PO_BILLED_AHEAD',
        `Bill ${pending.bill.billNumber} was booked against this purchase order before the goods arrived — void that bill (or raise a "short" credit note for what never came) before cancelling the order`,
        409,
      )
    }

    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: poId, status: { notIn: ['cancelled', 'received'] } },
      data:  { status: 'cancelled', cancelledById: userId, cancelledAt: new Date(), cancelReason: reason },
    })
    if (claimed.count === 0) throw new AppError('INVALID_STATE', 'This PO changed meanwhile — reload it', 409)
    await tx.poActivityLog.create({ data: { purchaseOrderId: poId, userId, action: 'cancelled', details: { reason } } })
    return { id: poId, status: 'cancelled' }
  })
}

/** A PO can go to the supplier once approved; re-sending a sent one is allowed. */
const SENDABLE_PO_STATUSES = ['approved', 'sent', 'partial']

function assertSendable(status: string) {
  if (status === 'draft' || status === 'pending_approval') {
    throw new AppError('PO_NOT_APPROVED', 'This PO has not been approved yet — submit it (and get it approved) before sending it', 400)
  }
  if (!SENDABLE_PO_STATUSES.includes(status)) {
    throw new AppError('INVALID_STATE', `Cannot send a PO that is ${status}`, 400)
  }
}

/**
 * Send an approved PO to the supplier — email when they have an address,
 * WhatsApp when they have a number (whatsappPhone, else phone). The PO
 * becomes 'sent' only when at least one channel actually delivered. A
 * supplier with neither: phone it in and use markPoSent.
 */
export async function sendPoToSupplier(poId: string, userId: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    // Each line carries its servd ingredient's SPEC (K6 — what we buy, e.g. "80/20, coarse ground").
    include: { supplier: true, lines: { include: { inventoryItem: { include: { masterIngredient: { select: { spec: true } } } } } } },
  })
  if (!po) throw new NotFoundError('PurchaseOrder', poId)
  assertSendable(po.status)

  // A test company never contacts a real supplier (lib/outboundScope.ts). The
  // PO still moves on as if sent, so a test can run end to end (receive, bill,
  // pay); the activity log says nothing was delivered.
  if (await testCompanyBlocks('supplier', externalScope(po.supplier.tenantId))) {
    const status = po.status === 'approved' ? 'sent' : po.status
    await prisma.$transaction([
      prisma.purchaseOrder.update({ where: { id: poId }, data: { sentAt: new Date(), status } }),
      prisma.poActivityLog.create({
        data: { purchaseOrderId: poId, userId, action: 'sent', details: { channels: [], testCompany: true, note: 'Test company: not sent to the supplier' } },
      }),
    ])
    return { status, channels: [] as string[], sentTo: null, failed: [] as string[], testCompany: true }
  }

  const email = po.supplier.email || null
  const waNumber = (po.supplier.whatsappPhone || po.supplier.phone || '').replace(/[^0-9]/g, '') || null
  if (!email && !waNumber) {
    throw new AppError(
      'NO_CONTACT',
      `${po.supplier.name} has no email or WhatsApp number on file. Add one to the supplier, or send the PO by phone and mark it as sent.`,
      400,
    )
  }

  const fmt = (c: number) => `PKR ${(c / 100).toLocaleString()}`
  const ref = po.reference ? `#${po.reference}` : `#${po.id.slice(0, 8).toUpperCase()}`
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const specOf = (l: (typeof po.lines)[number]) => l.inventoryItem.masterIngredient?.spec?.trim() || null
  const linesHtml = po.lines.map((l) => `
    <tr>
      <td style="padding:6px;border-bottom:1px solid #eee;">${esc(l.inventoryItem.name)}${specOf(l) ? `<div style="color:#666;font-size:12px;">Spec: ${esc(specOf(l)!)}</div>` : ''}</td>
      <td style="padding:6px;border-bottom:1px solid #eee;text-align:right;">${l.quantityOrdered} ${l.inventoryItem.unit}</td>
      <td style="padding:6px;border-bottom:1px solid #eee;text-align:right;">${fmt(l.unitCostCents)}</td>
      <td style="padding:6px;border-bottom:1px solid #eee;text-align:right;">${fmt(l.unitCostCents * l.quantityOrdered)}</td>
    </tr>`).join('')

  const html = `
    <div style="font-family:sans-serif;max-width:640px;">
      <h2>Purchase Order ${ref}</h2>
      <p>Hi ${po.supplier.name},</p>
      <p>Please find our purchase order below. Confirm receipt at your earliest convenience.</p>
      <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:16px 0;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px;text-align:left;">Item</th>
            <th style="padding:8px;text-align:right;">Qty</th>
            <th style="padding:8px;text-align:right;">Unit Cost</th>
            <th style="padding:8px;text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>${linesHtml}</tbody>
        <tfoot>
          <tr><td colspan="3" style="padding:12px;text-align:right;font-weight:bold;">Total</td>
              <td style="padding:12px;text-align:right;font-weight:bold;">${fmt(toCents(po.totalCents))}</td></tr>
        </tfoot>
      </table>
      ${po.expectedDate ? `<p><strong>Expected delivery:</strong> ${po.expectedDate.toDateString()}</p>` : ''}
      ${po.notes ? `<p><strong>Notes:</strong> ${po.notes}</p>` : ''}
      <p style="color:#888;font-size:12px;margin-top:32px;">Sent via servd procurement.</p>
    </div>`

  const text = [
    `Purchase Order ${ref}`,
    `Hi ${po.supplier.name}, please supply:`,
    '',
    ...po.lines.map((l) => `- ${l.inventoryItem.name}: ${l.quantityOrdered} ${l.inventoryItem.unit} @ ${fmt(l.unitCostCents)}${specOf(l) ? ` (spec: ${specOf(l)})` : ''}`),
    '',
    `Total: ${fmt(toCents(po.totalCents))}`,
    ...(po.expectedDate ? [`Expected delivery: ${po.expectedDate.toDateString()}`] : []),
    ...(po.notes ? [`Notes: ${po.notes}`] : []),
    'Please confirm receipt.',
  ].join('\n')

  const sent: string[] = []
  const failed: string[] = []
  if (email) {
    try { await sendEmail(email, `Purchase Order from servd — ${fmt(toCents(po.totalCents))}`, html, 'purchase_order', externalScope(po.supplier.tenantId)); sent.push('email') }
    catch (err) { failed.push(`email: ${(err as Error).message}`) }
  }
  if (waNumber) {
    try { await sendWhatsApp(waNumber, text, externalScope(po.supplier.tenantId)); sent.push('whatsapp') }
    catch (err) { failed.push(`whatsapp: ${(err as Error).message}`) }
  }

  if (sent.length === 0) {
    await prisma.poActivityLog.create({
      data: { purchaseOrderId: poId, userId, action: 'send_failed', details: { errors: failed } },
    })
    throw new AppError('SEND_FAILED', `The PO did not reach ${po.supplier.name} (${failed.join('; ')}). Try again, or send it by phone and mark it as sent.`, 502)
  }

  const now = new Date()
  await prisma.$transaction([
    prisma.purchaseOrder.update({
      where: { id: poId },
      data:  {
        sentAt: now,
        ...(sent.includes('email') ? { sentToEmail: email } : {}),
        status: po.status === 'approved' ? 'sent' : po.status,
      },
    }),
    prisma.poActivityLog.create({
      data: { purchaseOrderId: poId, userId, action: 'sent', details: { channels: sent, email: sent.includes('email') ? email : null, whatsapp: sent.includes('whatsapp') ? waNumber : null, failed } },
    }),
  ])

  return { status: po.status === 'approved' ? 'sent' : po.status, channels: sent, sentTo: sent.includes('email') ? email : waNumber, failed }
}

export type PoSendChannel = 'phone' | 'whatsapp' | 'email' | 'in_person'

/**
 * Staff sent an approved PO themselves (phoned it in, WhatsApped it from their
 * own phone, handed it over) — record that, and how. The only other way a PO
 * becomes 'sent' is sendPoToSupplier actually delivering it.
 */
export async function markPoSent(poId: string, userId: string, input: { channel: PoSendChannel; note?: string | null }) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
    const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, select: { status: true } })
    if (!po) throw new NotFoundError('PurchaseOrder', poId)
    if (po.status === 'draft' || po.status === 'pending_approval') {
      throw new AppError('PO_NOT_APPROVED', 'This PO has not been approved yet — it cannot be sent', 400)
    }
    if (po.status !== 'approved') throw new AppError('INVALID_STATE', `This PO is already ${po.status}`, 400)
    await tx.purchaseOrder.update({ where: { id: poId }, data: { status: 'sent', sentAt: new Date() } })
    await tx.poActivityLog.create({
      data: { purchaseOrderId: poId, userId, action: 'marked_sent', details: { channel: input.channel, note: input.note ?? null } },
    })
    return { id: poId, status: 'sent', channel: input.channel }
  })
}

// ─── Receiving ───────────────────────────────────────────────────────────────
//
// Receiving lives in ./receiving.ts (receiveGoods) — the ONE path that brings
// stock in, with or without a PO. receivePo was folded into it.

// ─── Bills (Accounts Payable) ────────────────────────────────────────────────

/** A system supplier ('Cash purchases') is never ordered from or billed. */
function systemSupplierError(name: string): AppError {
  return new AppError('SYSTEM_SUPPLIER', `${name} is a system supplier for goods bought with cash — it is never ordered from or billed`, 422)
}

export interface CreateBillLineInput {
  inventoryItemId?:    string | null
  poLineId?:           string | null
  /** A stock line billed against one receipt line (else its PO line, matched FIFO). */
  receiptLineId?:      string | null
  /** A line that is NOT stock: the 6xxx account it is booked to. */
  expenseAccountCode?: string | null
  /** An expense line that looks like equipment, booked as an expense anyway (finance / CEO, with a reason). */
  notEquipment?:       boolean
  notEquipmentReason?: string | null
  description:         string
  quantity:            number
  unitCostCents:       number
}

export interface CreateBillInput {
  supplierId:    string
  poId?:         string | null
  billNumber:    string
  billDate:      string
  dueDate?:      string | null   // if absent, computed from supplier paymentTermsDays
  taxCents?:     number
  /** Who charged the sales tax (H8) — default the supplier's usual authority, else FBR. */
  taxAuthority?: AuthorityKey | null
  /** The withholding section — default the supplier's usual one, else 153(1)(a); 'none' withholds nothing. */
  whtSection?:   WhtSection | 'none' | null
  notes?:        string | null
  attachmentUrl?: string | null
  lines: CreateBillLineInput[]
  createdBy: string
  /** The recorder's role — decides an equipment override (finance / CEO only). */
  actorRole?: string
  actorEmail?: string | null
}

export async function createBill(input: CreateBillInput) {
  const prepared = await prepareBill(input)
  // The stock goes into the books on FIFO lots: the company's one-time
  // cut-over runs first if it has not (outside the transaction).
  await ensureFifoReady(prepared.tenantId)

  // The bill, its GRNI matches, its lot re-pricing and its ledger entry commit
  // together (postSupplierBill in the same transaction): a bill dated in a
  // closed month is PERIOD_LOCKED 422, quantity beyond what was received and
  // ordered is OVER_BILLED 422 — nothing is saved.
  const bill = await prisma.$transaction((tx) => insertBillTx(tx, prepared), { timeout: 30_000 })
  await afterBillCreated(prepared, bill)
  return bill
}

/** A bill checked and computed (prepareBill), ready to insert inside a transaction (insertBillTx). */
export type PreparedBill = Awaited<ReturnType<typeof prepareBill>>

/**
 * Everything createBill checks and computes BEFORE its transaction: the
 * supplier (its company), the lines, the money limits, the equipment check,
 * the dates, the tax authority and the withholding. No write. A caller that
 * books a bill inside its OWN transaction (a cash voucher booked on credit,
 * trustops/cashVouchers.ts) runs this first, ensureFifoReady(tenantId) next,
 * then insertBillTx in its transaction and afterBillCreated after the commit.
 */
export async function prepareBill(input: CreateBillInput) {
  if (input.lines.length === 0) throw new AppError('NO_LINES', 'A bill needs at least one line', 400)

  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } })
  if (!supplier) throw new NotFoundError('Supplier', input.supplierId)
  if (supplier.systemKind) throw systemSupplierError(supplier.name)
  if (!supplier.tenantId) {
    throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'Assign this supplier to a company before recording its bills', 422)
  }
  const tenantId = supplier.tenantId
  const lines = await resolveBillLines(input, { id: supplier.id, name: supplier.name, tenantId })
  // Every line, the subtotal, the tax and the total must fit a money column
  // (and a ledger line — the bill posts in the same transaction): 422, never
  // a 500 at insert.
  //
  // A STOCK line's unit cost becomes a GrniMatch billed unit cost and a lot's
  // unit cost (per-unit stock cost, INT4 by BOOKS-06); its line total may be
  // BIGINT. A NON-stock line stays at the INT4 cap, line by line AND in total
  // (MONEY-BIG-1): capital spend (fit-out, equipment) goes through CapEx
  // (payments → 1340, capitalise → 15x0), never a bill — and an
  // equipment-looking line is refused (USE_CAPEX) unless finance or the CEO
  // overrides it with a reason.
  const assertNonStockFits = (cents: number, what: string) => {
    try { assertInt4Fits(cents, what) } catch (err) {
      if (!(err instanceof AppError)) throw err
      throw new AppError(err.code, `${err.message}. Capital spend (fit-out, equipment) belongs in CapEx, not a supplier bill.`, err.statusCode)
    }
  }
  let nonStockCents = 0
  const overrides: Array<{ line: number; description: string; reason: string }> = []
  for (const [i, l] of lines.entries()) {
    const lineCents = Math.round(l.unitCostCents * l.quantity)
    if (l.inventoryItemId) {
      assertInt4Fits(l.unitCostCents, `Line ${i + 1}'s unit cost (a stock item)`)
      assertMoneyFits(lineCents, `Line ${i + 1} (quantity × unit cost)`)
      continue
    }
    assertNonStockFits(l.unitCostCents, `Line ${i + 1}'s unit cost (not a stock item)`)
    assertNonStockFits(lineCents, `Line ${i + 1} (quantity × unit cost, not a stock item)`)
    nonStockCents += lineCents
    const code = l.expenseAccountCode?.trim()
    if (!code) {
      throw new AppError('EXPENSE_ACCOUNT_REQUIRED', `Line ${i + 1} ("${l.description}") is not a stock item — pick the expense account it is booked to`, 422)
    }
    // Equipment and smallwares go through CapEx (USE_CAPEX); stock lines are never checked.
    const eq = assertNotEquipmentLine(
      { description: l.description, expenseAccountCode: code, notEquipment: l.notEquipment, notEquipmentReason: l.notEquipmentReason },
      { role: input.actorRole ?? '' },
    )
    if (eq.overridden) overrides.push({ line: i + 1, description: l.description, reason: (l.notEquipmentReason ?? '').trim() })
    await assertExpenseCode(tenantId, code)
  }
  assertNonStockFits(nonStockCents, 'This bill\'s lines that are not stock items')
  const subtotalCents = lines.reduce((s, l) => s + Math.round(l.unitCostCents * l.quantity), 0)
  const taxCents      = input.taxCents ?? 0
  const totalCents    = subtotalCents + taxCents
  assertMoneyFits(subtotalCents, 'This bill\'s subtotal')
  assertMoneyFits(taxCents, 'This bill\'s tax')
  assertMoneyFits(totalCents, 'This bill\'s total')

  const billDate = new Date(input.billDate)
  if (Number.isNaN(billDate.getTime())) throw new AppError('INVALID_DATE', 'The bill date is not a date', 400)
  const dueDate  = input.dueDate
    ? new Date(input.dueDate)
    : new Date(billDate.getTime() + supplier.paymentTermsDays * 24 * 60 * 60 * 1000)
  if (Number.isNaN(dueDate.getTime())) throw new AppError('INVALID_DATE', 'The due date is not a date — use YYYY-MM-DD', 422)

  // Tax (H8): who charged the sales tax decides the input account. Withholding
  // (H8 / H28): the ONE resolver, fixed now and booked from these stored figures.
  const authority = input.taxAuthority ?? supplier.defaultTaxAuthority ?? 'fbr'
  if (!isAuthorityKey(authority)) throw new AppError('BAD_TAX_AUTHORITY', `Unknown sales tax authority "${authority}"`, 422)
  const sectionAsked = input.whtSection ?? supplier.defaultWhtSection ?? '153_1_a'
  const section = sectionAsked === 'none' ? null : whtSectionOrNull(sectionAsked)
  const wht = await withholdingForBill(prisma, {
    tenantId, supplier: { filerStatus: supplier.filerStatus, whtExemptUntil: supplier.whtExemptUntil },
    subtotalCents, section, at: billDate,
  })

  return { input, supplier, tenantId, lines, subtotalCents, taxCents, totalCents, billDate, dueDate, authority, section, sectionAsked, wht, overrides }
}

/** The bill row and its ledger entry, inside the caller's transaction (409 DUPLICATE_BILL for a number the supplier has). */
export async function insertBillTx(tx: Prisma.TransactionClient, p: PreparedBill) {
  const { input } = p
  let created
  try {
    created = await tx.supplierBill.create({
      data: {
        supplierId:   input.supplierId,
        poId:         input.poId      ?? null,
        billNumber:   input.billNumber,
        billDate:     p.billDate,
        dueDate:      p.dueDate,
        subtotalCents: p.subtotalCents,
        taxCents:     p.taxCents,
        totalCents:   p.totalCents,
        whtCents:     p.wht.whtCents,
        taxAuthority: p.authority,
        whtSection:   p.section ?? (p.sectionAsked === 'none' ? 'none' : null),
        whtRateBps:   p.wht.rateBps,
        notes:        input.notes         ?? null,
        attachmentUrl: input.attachmentUrl ?? null,
        createdBy:    input.createdBy,
        status:       'open',
        lines: {
          create: p.lines.map((l) => ({
            inventoryItemId:    l.inventoryItemId,
            poLineId:           l.poLineId,
            receiptLineId:      l.receiptLineId,
            expenseAccountCode: l.inventoryItemId ? null : (l.expenseAccountCode?.trim() || null),
            description:        l.description,
            quantity:           l.quantity,
            unitCostCents:      l.unitCostCents,
            lineTotalCents:     Math.round(l.unitCostCents * l.quantity),
          })),
        },
      },
      include: { supplier: true, lines: true, po: true },
    })
  } catch (err) {
    const e = err as Prisma.PrismaClientKnownRequestError
    if (e.code === 'P2002') {
      throw new AppError('DUPLICATE_BILL', `Bill number ${input.billNumber} already exists for this supplier`, 409)
    }
    throw err
  }
  const posted = await postSupplierBill(created.id, { tx })
  return Object.assign(created, { journalEntryId: posted.entryId })
}

/**
 * After the commit: an equipment-looking line booked as an expense is
 * audited and flagged (high) in the supplier's company — never undoing the bill.
 */
export async function afterBillCreated(p: PreparedBill, bill: { id: string; billNumber: string }) {
  const { input, supplier, tenantId } = p
  for (const o of p.overrides) {
    await audit({
      category: 'accounting', action: 'supplier_bill.not_equipment_override', entity: 'SupplierBill', entityId: bill.id,
      userId: input.createdBy, userEmail: input.actorEmail ?? null, tenantId,
      metadata: { billNumber: bill.billNumber, line: o.line, description: o.description, reason: o.reason },
    })
    await flagException({
      tenantId, kind: 'bill_equipment_override', severity: 'high',
      title: `Equipment-looking bill line booked as an expense: ${o.description}`.slice(0, 200),
      description: `${supplier.name} bill ${bill.billNumber}, line ${o.line}: "${o.description}" was booked as an expense, not through CapEx. Reason: ${o.reason}`,
      entityType: 'SupplierBill', entityId: bill.id, actorId: input.createdBy,
      metadata: { supplierId: supplier.id, line: o.line, reason: o.reason },
    })
  }
}

/**
 * A bill's lines resolved against the supplier: a PO line gives the line its
 * item; a receipt line must be this supplier's receipt of the same item (422
 * RECEIPT_LINE_MISMATCH); a stock line needs a PO line or a receipt line (422
 * STOCK_LINE_NEEDS_RECEIPT — "receive it at the dock first").
 */
async function resolveBillLines(
  input: Pick<CreateBillInput, 'supplierId' | 'poId' | 'lines'>,
  supplier: { id: string; name: string; tenantId: string },
): Promise<Array<CreateBillLineInput & { inventoryItemId: string | null; poLineId: string | null; receiptLineId: string | null }>> {
  await assertBillReferences(input, supplier)
  const poLineIds = [...new Set(input.lines.map((l) => l.poLineId).filter((x): x is string => !!x))]
  const poLines = poLineIds.length === 0 ? [] : await prisma.purchaseOrderLine.findMany({ where: { id: { in: poLineIds } }, select: { id: true, inventoryItemId: true } })
  const rlIds = [...new Set(input.lines.map((l) => l.receiptLineId).filter((x): x is string => !!x))]
  const rls = rlIds.length === 0 ? [] : await prisma.goodsReceiptLine.findMany({
    where: { id: { in: rlIds } },
    select: { id: true, inventoryItemId: true, poLineId: true, writtenOffAt: true, receipt: { select: { supplierId: true, tenantId: true, settledByType: true } } },
  })
  const resolved = input.lines.map((l, i) => {
    let itemId = l.inventoryItemId ?? null
    const pl = l.poLineId ? poLines.find((x) => x.id === l.poLineId) : null
    if (pl) {
      if (itemId && itemId !== pl.inventoryItemId) {
        throw new AppError('PO_LINE_MISMATCH', `Line ${i + 1}: that PO line is for a different item`, 422)
      }
      itemId = pl.inventoryItemId
    }
    if (l.receiptLineId) {
      const rl = rls.find((x) => x.id === l.receiptLineId)
      const ok = rl && rl.receipt.supplierId === supplier.id && (rl.receipt.tenantId ?? supplier.tenantId) === supplier.tenantId
        && !rl.receipt.settledByType && !rl.writtenOffAt
        && (!itemId || rl.inventoryItemId === itemId) && (!l.poLineId || rl.poLineId === l.poLineId)
      if (!ok) {
        throw new AppError('RECEIPT_LINE_MISMATCH', `Line ${i + 1}: that receipt is not ${supplier.name}'s delivery of this item`, 422)
      }
      itemId = rl!.inventoryItemId
    }
    if (itemId && !l.poLineId && !l.receiptLineId) {
      throw new AppError('STOCK_LINE_NEEDS_RECEIPT', `Line ${i + 1} ("${l.description}") is a stock item — receive it at the dock first, then bill it against the receipt or its PO line`, 422)
    }
    return { ...l, inventoryItemId: itemId, poLineId: l.poLineId ?? null, receiptLineId: l.receiptLineId ?? null }
  })
  const itemIds = resolved.map((l) => l.inventoryItemId).filter((x): x is string => !!x)
  if (itemIds.length > 0) await assertItemsOfCompany(itemIds, supplier.tenantId, supplier.name)
  return resolved
}

/**
 * Everything a new bill points at must be its supplier's: the PO, each PO line
 * (and on that PO, when one is given), and each inventory item (the supplier's
 * company's). A bill of company A used to be able to reference company B's
 * PO lines and items, which then fed B's 3-way match and price history.
 */
async function assertBillReferences(
  input: Pick<CreateBillInput, 'supplierId' | 'poId' | 'lines'>,
  supplier: { id: string; name: string; tenantId: string | null },
): Promise<void> {
  if (input.poId) {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: input.poId }, select: { supplierId: true } })
    if (!po) throw new NotFoundError('PurchaseOrder', input.poId)
    if (po.supplierId !== supplier.id) {
      throw new AppError('PO_SUPPLIER_MISMATCH', `That purchase order is not from ${supplier.name}`, 422)
    }
  }

  const poLineIds = Array.from(new Set(input.lines.map((l) => l.poLineId).filter((x): x is string => !!x)))
  if (poLineIds.length > 0) {
    const poLines = await prisma.purchaseOrderLine.findMany({
      where:  { id: { in: poLineIds } },
      select: { id: true, purchaseOrderId: true, purchaseOrder: { select: { supplierId: true } } },
    })
    for (const id of poLineIds) {
      const pl = poLines.find((x) => x.id === id)
      if (!pl) throw new NotFoundError('PurchaseOrderLine', id)
      if (pl.purchaseOrder.supplierId !== supplier.id || (input.poId && pl.purchaseOrderId !== input.poId)) {
        throw new AppError('PO_LINE_MISMATCH', `PO line ${id} is not on ${input.poId ? 'this purchase order' : `a purchase order from ${supplier.name}`}`, 422)
      }
    }
  }

  const itemIds = input.lines.map((l) => l.inventoryItemId).filter((x): x is string => !!x)
  if (itemIds.length > 0) {
    if (!supplier.tenantId) {
      throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'Assign this supplier to a company before billing stock items against it', 422)
    }
    await assertItemsOfCompany(itemIds, supplier.tenantId, supplier.name)
  }
}

export async function voidBill(billId: string, userId: string, reason: string) {
  // The void and the ledger reversal (plus re-opening GRNI and undoing the
  // bill's lot re-pricing) commit together; a reversal the ledger refuses
  // (e.g. today is in a closed period) refuses the void. The checks run under the bill's row
  // lock, so a payment or credit note applied at the same moment either lands
  // first (and is seen here) or waits and then finds the bill void.
  const owner = await prisma.supplierBill.findUnique({ where: { id: billId }, select: { supplier: { select: { tenantId: true } } } })
  if (owner?.supplier.tenantId) await ensureFifoReady(owner.supplier.tenantId)
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${billId} FOR UPDATE`
    const bill = await tx.supplierBill.findUnique({
      where:   { id: billId },
      include: { applications: { select: { id: true } }, creditsReceived: { select: { id: true } } },
    })
    if (!bill) throw new NotFoundError('SupplierBill', billId)
    if (bill.kind !== 'bill') {
      throw new AppError('NOT_A_BILL', 'That is a credit note — void it from the credit notes list', 422)
    }
    if (bill.status === 'void') throw new AppError('INVALID_STATE', 'Bill is already void', 400)
    if (bill.applications.length > 0) {
      throw new AppError('HAS_PAYMENTS', 'Cannot void a bill with applied payments — unapply payments first', 400)
    }
    if (bill.creditsReceived.length > 0) {
      throw new AppError('HAS_CREDITS', 'Cannot void a bill with credit notes applied to it — unapply them first', 400)
    }
    // A live credit note against this bill books part of it backwards; voiding
    // the bill as well would take the same goods and tax off the books twice.
    const liveCredits = await tx.supplierBill.count({ where: { originalBillId: billId, kind: 'credit_note', status: { not: 'void' } } })
    if (liveCredits > 0) {
      throw new AppError('HAS_CREDIT_NOTES', 'This bill has credit notes against it — void them first, then void the bill', 400)
    }

    const updated = await tx.supplierBill.update({
      where: { id: billId },
      data:  { status: 'void', voidedAt: new Date(), voidReason: reason, notes: bill.notes ? `${bill.notes}\n[voided by ${userId}]` : `[voided by ${userId}]` },
    })
    await postSupplierBillVoid(billId, reason, { tx, postedBy: userId })
    return updated
  }, { timeout: 30_000 })
}

/**
 * 3-way match check for a bill: compares billed vs ordered vs received.
 * Returns line-by-line match status — UI uses this to flag mismatches.
 */
export async function matchBill(billId: string) {
  const bill = await prisma.supplierBill.findUnique({
    where:   { id: billId },
    include: {
      lines: {
        include: { poLine: { include: { inventoryItem: true } }, inventoryItem: true },
      },
      po: true,
    },
  })
  if (!bill) throw new NotFoundError('SupplierBill', billId)

  const lineResults = bill.lines.map((bl) => {
    if (!bl.poLine) {
      return {
        billLineId: bl.id,
        description: bl.description,
        match: 'unmatched' as const,
        reason: 'No PO line linked',
      }
    }
    const ordered  = bl.poLine.quantityOrdered
    const received = bl.poLine.quantityReceived
    const billed   = bl.quantity
    const orderedCost  = bl.poLine.unitCostCents
    const billedCost   = toCents(bl.unitCostCents)

    const issues: string[] = []
    if (Math.abs(billed - received) > 0.001)     issues.push(`Billed ${billed}, received ${received}`)
    if (Math.abs(orderedCost - billedCost) > 1) issues.push(`Billed ${billedCost}p/unit, ordered ${orderedCost}p/unit`)

    return {
      billLineId:  bl.id,
      description: bl.description,
      match:       (issues.length === 0 ? 'matched' : 'mismatch') as 'matched' | 'mismatch',
      ordered, received, billed, orderedCost, billedCost,
      issues,
    }
  })

  return {
    billId,
    poId:         bill.poId,
    overallMatch: lineResults.every((r) => r.match === 'matched') ? 'matched' : 'mismatch' as 'matched' | 'mismatch',
    lines:        lineResults,
  }
}

// ─── What a bill still owes ──────────────────────────────────────────────────
//
// ONE rule, net of withholding: the supplier is owed totalCents − whtCents
// (that is what AP 2010 was credited with), less what has been paid and the
// supplier credit notes applied to it (creditedCents). The payment paths, the
// bill status, the AP aging, the supplier statement and a petty-cash or till
// spend against a bill all use it. They used to use the gross total, so a bill
// paid net of withholding stayed 'partially_paid' for ever and showed as
// owing the WHT the ledger had already moved to FBR.
//
// Callers outside procurement that pre-check a bill (trustops petty cash, the
// till pay-out) must select creditedCents too; the authoritative check is
// createPaymentTx's, on the full locked row.

type BillAmounts = { totalCents: DbMoney; whtCents: DbMoney; paidCents: DbMoney; creditedCents?: DbMoney | null }

/** What the supplier is still owed on this bill: total − WHT − paid − credited. */
export function billDueCents(b: BillAmounts): number {
  return toCents(b.totalCents) - toCents(b.whtCents) - toCents(b.paidCents) - (b.creditedCents == null ? 0 : toCents(b.creditedCents))
}

/**
 * The status a bill's payments and credit notes put it in, from scratch —
 * 'paid' when nothing is still due, 'partially_paid' when something has been
 * settled, else 'open' (so unapplying a payment re-opens the bill). Void and
 * draft are left alone. Bills only; a credit note has its own statuses.
 */
export function settledStatus(b: BillAmounts & { status: string }): string {
  if (b.status === 'void' || b.status === 'draft') return b.status
  const settled = toCents(b.paidCents) + (b.creditedCents == null ? 0 : toCents(b.creditedCents))
  if (settled > 0 && billDueCents(b) <= 0) return 'paid'
  return settled > 0 ? 'partially_paid' : 'open'
}

/** Lock bills (id order, so two payers never deadlock) and re-read them. */
export async function lockBills(tx: Prisma.TransactionClient, billIds: string[]) {
  const ids = Array.from(new Set(billIds)).sort()
  if (ids.length === 0) return []
  await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`
  return tx.supplierBill.findMany({ where: { id: { in: ids } } })
}

/** A bill a payment or credit can be applied to: a live bill of `supplierId`. */
export function assertPayableBill(
  b: { billNumber: string; kind: string; supplierId: string; status: string },
  supplierId: string,
): void {
  if (b.kind !== 'bill')            throw new AppError('NOT_A_BILL', `${b.billNumber} is a credit note, not a bill`, 422)
  if (b.supplierId !== supplierId)  throw new AppError('SUPPLIER_MISMATCH', `Bill ${b.billNumber} belongs to a different supplier`, 400)
  if (b.status === 'void')          throw new AppError('BILL_VOID', `Bill ${b.billNumber} is void`, 400)
}

// ─── Supplier Payments ───────────────────────────────────────────────────────

export type SupplierPaymentMethod = 'cash' | 'bank_transfer' | 'cheque' | 'wallet'

export interface CreatePaymentInput {
  supplierId:  string
  paymentDate: string
  method:      SupplierPaymentMethod
  /**
   * The company bank account the money left (Configuration → Bank accounts).
   * Bank transfer / cheque: optional when the supplier's company has one bank
   * (it is used), required when it has two or more (422 BANK_ACCOUNT_REQUIRED).
   * Wallet (JazzCash / Easypaisa): always required — the wallet is its own
   * account row with its own chart code, never the operating bank. Cash: none.
   */
  bankAccountId?: string | null
  reference?:  string | null
  amountCents: number
  notes?:      string | null
  /** Optional: pre-allocate to specific bills. If absent, payment is created unallocated. */
  applications?: Array<{ billId: string; amountAppliedCents: number }>
  createdBy: string
}

export async function createPayment(input: CreatePaymentInput, opts: { classification?: ClassificationInput | null } = {}) {
  return prisma.$transaction(async (tx) => {
    const payment = await createPaymentTx(tx, input)
    // Internal payment classification (2026-10-20): a label on the payment's entry, same transaction.
    if (opts.classification) {
      await classifyByReferenceTx(tx, { reference: `supplier.payment:${payment.id}`, input: opts.classification, setById: input.createdBy ?? null })
    }
    return payment
  })
}

/**
 * createPayment inside the caller's transaction — for a cash spend recorded
 * elsewhere (a petty-cash box paying a supplier's bill) that must write the
 * SupplierPayment and its own row atomically. The ledger entry
 * (postSupplierPayment) posts in the SAME transaction: a payment dated in a
 * closed month is PERIOD_LOCKED 422 and nothing is saved. (A caller's own
 * postSupplierPayment after commit is now an idempotent no-op.)
 */
export async function createPaymentTx(tx: Prisma.TransactionClient, input: CreatePaymentInput) {
  if (input.amountCents <= 0) throw new AppError('INVALID_AMOUNT', 'Amount must be positive', 400)
  assertMoneyFits(input.amountCents, 'This payment')
  // A date that is not a date is the caller's mistake (422), never a 500 at insert.
  const paymentDate = new Date(input.paymentDate)
  if (Number.isNaN(paymentDate.getTime())) throw new AppError('INVALID_DATE', 'The payment date is not a date — use YYYY-MM-DD', 422)

  const allocations = input.applications ?? []
  allocations.forEach((a) => assertMoneyFits(a.amountAppliedCents, 'An amount applied to a bill'))
  const totalAllocated = allocations.reduce((s, a) => s + a.amountAppliedCents, 0)
  if (totalAllocated > input.amountCents) {
    throw new AppError('OVER_ALLOCATED', 'Allocations exceed payment amount', 400)
  }
  if (new Set(allocations.map((a) => a.billId)).size !== allocations.length) {
    throw new AppError('DUPLICATE_BILL', 'Each bill can appear only once in a payment', 400)
  }

  // Which account the money left — the SUPPLIER's company's (finance gaps #9).
  // A bank of another company, a deleted / unlinked one, or a missing pick
  // when the company has two banks is 422 here, before anything is written.
  const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true, tenantId: true } })
  if (!supplier) throw new NotFoundError('Supplier', input.supplierId)
  if (input.method === 'wallet' && !input.bankAccountId) {
    throw new AppError(
      'BANK_ACCOUNT_REQUIRED',
      'Pick the JazzCash / Easypaisa account the money left (add it under Configuration → Bank accounts if it is not there)',
      422,
    )
  }
  let bankAccountId: string | null = null
  if (supplier.tenantId) {
    bankAccountId = (await moneyAccountCode(tx, supplier.tenantId, { method: input.method, bankAccountId: input.bankAccountId ?? null })).bankAccountId
  } else if (input.bankAccountId) {
    // A supplier with no company never reaches any ledger; no bank can be checked against it.
    throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'Assign this supplier to a company before paying it from a bank account', 422)
  }

  // Validate all bills belong to the same supplier and aren't void/paid —
  // under their row locks, so two payments can't both take the last of a bill.
  if (allocations.length > 0) {
    const bills = await lockBills(tx, allocations.map((a) => a.billId))
    for (const a of allocations) {
      const b = bills.find((x) => x.id === a.billId)
      if (!b) throw new NotFoundError('SupplierBill', a.billId)
      assertPayableBill(b, input.supplierId)
      if (b.status === 'paid') throw new AppError('BILL_PAID', `Bill ${b.billNumber} is fully paid`, 400)

      const remaining = billDueCents(b)
      if (a.amountAppliedCents > remaining) {
        throw new AppError('OVER_APPLIED', `Cannot apply ${a.amountAppliedCents} to bill ${b.billNumber} — only ${remaining} due`, 400)
      }
    }
  }

  const payment = await tx.supplierPayment.create({
    data: {
      supplierId:  input.supplierId,
      paymentDate,
      method:      input.method,
      bankAccountId,
      reference:   input.reference ?? null,
      amountCents: input.amountCents,
      appliedCents: totalAllocated,
      notes:       input.notes ?? null,
      createdBy:   input.createdBy,
      applications: { create: allocations.map((a) => ({ billId: a.billId, amountAppliedCents: a.amountAppliedCents })) },
    },
    include: { applications: true },
  })

  // Update bill paid totals + statuses
  for (const a of allocations) {
    const bill = await tx.supplierBill.update({
      where: { id: a.billId },
      data:  { paidCents: { increment: a.amountAppliedCents } },
    })
    const newStatus = settledStatus(bill)
    if (newStatus !== bill.status) {
      await tx.supplierBill.update({ where: { id: bill.id }, data: { status: newStatus } })
    }
  }

  await postSupplierPayment(payment.id, { tx })
  return payment
}

/** Allocate an existing unallocated payment to bills. */
export async function allocatePayment(
  paymentId: string,
  applications: Array<{ billId: string; amountAppliedCents: number }>,
) {
  applications.forEach((a) => assertMoneyFits(a.amountAppliedCents, 'An amount applied to a bill'))
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM supplier_payments WHERE id = ${paymentId} FOR UPDATE`
    const payment = await tx.supplierPayment.findUnique({
      where:   { id: paymentId },
      include: { applications: true },
    })
    if (!payment) throw new NotFoundError('SupplierPayment', paymentId)
    if (payment.voidedAt) throw new AppError('PAYMENT_VOID', 'This payment is void', 422)

    const alreadyApplied = payment.applications.reduce((s, a) => s + toCents(a.amountAppliedCents), 0)
    const adding         = applications.reduce((s, a) => s + a.amountAppliedCents, 0)
    if (alreadyApplied + adding > toCents(payment.amountCents)) {
      throw new AppError('OVER_ALLOCATED', 'New allocations exceed remaining payment amount', 400)
    }
    if (new Set(applications.map((a) => a.billId)).size !== applications.length) {
      throw new AppError('DUPLICATE_BILL', 'Each bill can appear only once in an allocation', 400)
    }

    const bills = await lockBills(tx, applications.map((a) => a.billId))
    for (const a of applications) {
      const bill = bills.find((x) => x.id === a.billId)
      if (!bill) throw new NotFoundError('SupplierBill', a.billId)
      assertPayableBill(bill, payment.supplierId)
      const remaining = billDueCents(bill)
      if (a.amountAppliedCents > remaining) {
        throw new AppError('OVER_APPLIED', `Bill ${bill.billNumber} only has ${remaining} due`, 400)
      }

      // A second allocation to the same bill adds to the first.
      const prior = payment.applications.find((x) => x.billId === a.billId)
      if (prior) {
        await tx.supplierPaymentApplication.update({
          where: { id: prior.id },
          data:  { amountAppliedCents: { increment: a.amountAppliedCents } },
        })
      } else {
        await tx.supplierPaymentApplication.create({
          data: { paymentId, billId: a.billId, amountAppliedCents: a.amountAppliedCents },
        })
      }
      const updated = await tx.supplierBill.update({
        where: { id: a.billId },
        data:  { paidCents: { increment: a.amountAppliedCents } },
      })
      const newStatus = settledStatus(updated)
      if (newStatus !== updated.status) {
        await tx.supplierBill.update({ where: { id: updated.id }, data: { status: newStatus } })
      }
    }

    await tx.supplierPayment.update({
      where: { id: paymentId },
      data:  { appliedCents: { increment: adding } },
    })

    return { ok: true }
  })
}

/**
 * Take a payment off one bill (finance gaps 14a / extra finding): the money
 * goes back to the payment's unapplied balance, the bill re-opens. No ledger
 * change — Dr 2010 already happened when the payment posted; this only moves
 * which bill it settles. Under the payment's then the bill's row lock.
 */
export async function unapplyPayment(paymentId: string, billId: string, actor: { userId: string | null; reason?: string | null } = { userId: null }) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM supplier_payments WHERE id = ${paymentId} FOR UPDATE`
    await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${billId} FOR UPDATE`
    const application = await tx.supplierPaymentApplication.findUnique({
      where: { paymentId_billId: { paymentId, billId } },
      include: {
        bill: { select: { billNumber: true } },
        payment: { select: { reference: true, supplier: { select: { name: true, tenantId: true } } } },
      },
    })
    if (!application) throw new AppError('NOT_APPLIED', 'This payment is not applied to that bill', 422)
    const amount = toCents(application.amountAppliedCents)
    // F5: the allocation is kept for ever in the Trash (type
    // 'payment_application' — never restored, never erased; re-allocate on the
    // payment), in this transaction, BEFORE the row goes.
    const { bill: appBill, payment: appPayment, ...appRow } = application
    await moveToTrash(tx, actor, {
      type: 'payment_application', entityId: application.id, tenantId: appPayment.supplier.tenantId,
      title: `Payment taken off bill ${appBill.billNumber ?? billId.slice(-8).toUpperCase()}`,
      subtitle: `${appPayment.supplier.name} · PKR ${(amount / 100).toLocaleString('en-PK')}`,
      reason: actor.reason ?? null,
      meta: { kind: 'supplier_payment', paymentId, billId },
      snapshot: takeSnapshot('SupplierPaymentApplication', appRow),
    })
    await tx.supplierPaymentApplication.delete({ where: { id: application.id } })
    const bill = await tx.supplierBill.update({
      where: { id: billId },
      data:  { paidCents: { decrement: amount } },
    })
    const status = settledStatus(bill)
    if (status !== bill.status) await tx.supplierBill.update({ where: { id: billId }, data: { status } })
    const payment = await tx.supplierPayment.update({
      where: { id: paymentId },
      data:  { appliedCents: { decrement: amount } },
    })
    return { payment, bill: { id: bill.id, billNumber: bill.billNumber, status, paidCents: toCents(bill.paidCents) }, amountCents: amount }
  })
}

/**
 * True when the payment was cash out of a petty-cash box or a till drawer
 * (trustops / pos pay a bill through createPaymentTx). That cash has left the
 * box: voiding the payment here would put it back into 1010 with nothing in
 * the box — it is unapplied (or the supplier's refund recorded), never voided.
 */
async function paidFromCashBox(tx: Prisma.TransactionClient, payment: { id: string; method: string; reference: string | null }): Promise<boolean> {
  if (payment.method !== 'cash') return false
  if (await tx.pettyCashMovement.count({ where: { supplierPaymentId: payment.id } }) > 0) return true
  const tillPayout = await tx.auditLog.count({
    where: { action: 'drawer.payout', metadata: { path: ['supplierPaymentId'], equals: payment.id } },
  })
  return tillPayout > 0 || (payment.reference ?? '').startsWith('till pay-out')
}

/**
 * Void a supplier payment (bounced cheque, recorded twice, wrong supplier):
 * only while it is applied to no bill (422 PAYMENT_APPLIED — unapply it
 * first). Its entry is reversed in the same transaction (dated today;
 * 'supplier.payment.void'), so a closed period refuses the void. Idempotent:
 * voiding a void payment returns it unchanged.
 */
export async function voidPayment(paymentId: string, userId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM supplier_payments WHERE id = ${paymentId} FOR UPDATE`
    const payment = await tx.supplierPayment.findUnique({
      where:   { id: paymentId },
      include: { applications: { select: { id: true } } },
    })
    if (!payment) throw new NotFoundError('SupplierPayment', paymentId)
    if (payment.voidedAt) return { payment, alreadyVoid: true as const, reversal: null }
    if (payment.applications.length > 0 || toCents(payment.appliedCents) !== 0) {
      throw new AppError('PAYMENT_APPLIED', 'This payment is applied to bills — unapply it from each bill first', 422)
    }
    if (await paidFromCashBox(tx, payment)) {
      throw new AppError(
        'PAYMENT_FROM_CASH_BOX',
        'This cash was paid out of petty cash or a till — it has left the box, so the payment can\'t be voided. Unapply it from the bill instead, and record any refund from the supplier.',
        422,
      )
    }
    const updated = await tx.supplierPayment.update({
      where: { id: paymentId },
      data:  { voidedAt: new Date(), voidReason: reason },
    })
    const reversal = await postSupplierPaymentVoid(paymentId, reason, { tx, postedBy: userId })
    return { payment: updated, alreadyVoid: false as const, reversal }
  })
}

// ─── AP aging ────────────────────────────────────────────────────────────────
//
// THE accounts-payable aging: the Accounting AP aging page, the Procurement
// Aging tab, the emailed ap_aging report and the supplier statement all read
// it. There used to be three agings (two bucketed by due date with different
// shapes — one of which crashed its tab — and the email by bill date) and a
// fourth "outstanding" on the statement; none of them tied to the ledger.
//
// Per supplier, it ties to ledger AP 2010:
//   buckets   each open bill's billDueCents (net of withholding, payments and
//             credit notes applied), aged by days past its DUE date
//             (current / 1-30 / 31-60 / 61-90 / 90+)
//   credits   payments not yet applied to a bill, the part of each supplier
//             credit note not yet applied to a bill (creditNotesCents), plus
//             any bill paid beyond what it owed — all already debited to AP
//             in full. Void payments and void credit notes are out.
//   opening   the supplier's opening balance AS POSTED to the ledger
//             (openingBalance.ts posts Supplier.openingBalanceCents once, as a
//             delta, Dr 3010 / Cr 2010) — its own column and inside `total`
//   total     Σ buckets + opening − credits   ← the supplier's AP balance in
//             the ledger; a payment left unapplied against the opening
//             balance nets it off here, as it does in AP 2010
//   openingUnposted  Supplier.openingBalanceCents not (yet) in the ledger —
//             0 unless a posting failed (e.g. the month is locked); NOT in
//             `total`. For a supplier with no company nothing is ever posted,
//             so its opening sits in `opening` and `total` under `unassigned`.
// Suppliers with no company are never posted to any ledger; they are listed
// under `unassigned`, never inside a company's totals.

export type AgingBucketKey = 'current' | '1_30' | '31_60' | '61_90' | '90_plus'

export interface AgingRow {
  supplierId: string
  supplierName: string
  tenantId: string | null
  bills: number
  current: number
  '1_30': number
  '31_60': number
  '61_90': number
  '90_plus': number
  creditsCents: number
  /** Of creditsCents: supplier credit notes not yet applied to a bill. */
  creditNotesCents: number
  total: number
  openingCents: number
  openingUnpostedCents: number
}

export type AgingTotals = Omit<AgingRow, 'supplierId' | 'supplierName' | 'tenantId'>

export interface AgingReport {
  asOf: string
  bySupplier: AgingRow[]
  total: AgingTotals
  unassigned: { bySupplier: AgingRow[]; total: AgingTotals }
}

/**
 * Whole Karachi calendar days a bill is past due at `asOf`. dueDate is stored
 * as UTC midnight of its day (a YYYY-MM-DD from the form); asOf is an instant.
 * Both are read as Karachi dates (fmtPktDate: UTC midnight stays the same day,
 * and a PKT-midnight instant reads as its own day too), so a bill due
 * yesterday is 1 day overdue from 00:00 PKT, not from 05:00 PKT.
 */
export function apDaysPastDue(dueDate: Date, asOf: Date): number {
  const dueDay = Date.parse(`${fmtPktDate(dueDate)}T00:00:00Z`)
  const asOfDay = Date.parse(`${fmtPktDate(asOf)}T00:00:00Z`)
  return Math.round((asOfDay - dueDay) / 86_400_000)
}

export function agingBucket(daysPastDue: number): AgingBucketKey {
  if (daysPastDue <= 0) return 'current'
  if (daysPastDue <= 30) return '1_30'
  if (daysPastDue <= 60) return '31_60'
  if (daysPastDue <= 90) return '61_90'
  return '90_plus'
}

const emptyTotals = (): AgingTotals => ({ bills: 0, current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0, creditsCents: 0, creditNotesCents: 0, total: 0, openingCents: 0, openingUnpostedCents: 0 })

/**
 * What is left of a supplier credit note to apply to bills: what it debited
 * to AP (total − its WHT share) less what has been applied (its creditedCents).
 */
export function creditNoteAvailableCents(cn: { totalCents: DbMoney; whtCents: DbMoney; creditedCents: DbMoney }): number {
  return toCents(cn.totalCents) - toCents(cn.whtCents) - toCents(cn.creditedCents)
}

type AgingDoc = { id: string; kind: string; dueDate: Date; totalCents: DbMoney; whtCents: DbMoney; paidCents: DbMoney; creditedCents: DbMoney }
type AgingSupplier = { id: string; name: string; tenantId: string | null; openingBalanceCents: DbMoney; bills: AgingDoc[]; payments: Array<{ amountCents: DbMoney; appliedCents: DbMoney }> }

/**
 * The suppliers' bills, credit notes and payments AS AT `asOf` (finance final,
 * item 17) — what AP 2010 held at the end of that day, so a month-end aging
 * run later still ties to the trial balance:
 *   • bills / credit notes dated on or before asOf (posted at their own date),
 *     not void — or voided after asOf (the void's reversal is dated the void);
 *   • payments dated on or before asOf, not voided by then;
 *   • paid / credited rebuilt from the applications of a payment / credit
 *     note counted to a bill counted — an application takes effect at the
 *     later of its two documents' dates (when it was keyed in does not
 *     matter; either way the total nets the same).
 */
async function suppliersAsOf(supplierWhere: Prisma.SupplierWhereInput, asOf: Date): Promise<AgingSupplier[]> {
  const liveAt = { OR: [{ voidedAt: null, status: { not: 'void' } }, { voidedAt: { gt: asOf } }] }
  const suppliers = await prisma.supplier.findMany({
    where: supplierWhere,
    select: {
      id: true, name: true, tenantId: true, openingBalanceCents: true,
      bills: {
        where:  { status: { not: 'draft' }, billDate: { lte: asOf }, ...liveAt },
        select: { id: true, kind: true, dueDate: true, totalCents: true, whtCents: true },
      },
      payments: {
        where:  { paymentDate: { lte: asOf }, OR: [{ voidedAt: null }, { voidedAt: { gt: asOf } }] },
        select: { id: true, amountCents: true },
      },
    },
  })
  const billIds = suppliers.flatMap((s) => s.bills.filter((b) => b.kind === 'bill').map((b) => b.id))
  const cnIds = suppliers.flatMap((s) => s.bills.filter((b) => b.kind === 'credit_note').map((b) => b.id))
  const paymentIds = suppliers.flatMap((s) => s.payments.map((p) => p.id))
  const [payApps, creditApps] = await Promise.all([
    billIds.length === 0 || paymentIds.length === 0 ? [] : prisma.supplierPaymentApplication.findMany({
      where:  { billId: { in: billIds }, paymentId: { in: paymentIds } },
      select: { billId: true, paymentId: true, amountAppliedCents: true },
    }),
    billIds.length === 0 || cnIds.length === 0 ? [] : prisma.supplierCreditApplication.findMany({
      where:  { billId: { in: billIds }, creditNoteId: { in: cnIds } },
      select: { billId: true, creditNoteId: true, amountCents: true },
    }),
  ])
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v)
  const paidByBill = new Map<string, number>(), appliedByPayment = new Map<string, number>()
  for (const a of payApps) { add(paidByBill, a.billId, toCents(a.amountAppliedCents)); add(appliedByPayment, a.paymentId, toCents(a.amountAppliedCents)) }
  const creditedByBill = new Map<string, number>(), usedByCn = new Map<string, number>()
  for (const a of creditApps) { add(creditedByBill, a.billId, toCents(a.amountCents)); add(usedByCn, a.creditNoteId, toCents(a.amountCents)) }
  return suppliers.map((s) => ({
    ...s,
    bills: s.bills.map((b) => b.kind === 'credit_note'
      ? { ...b, paidCents: 0, creditedCents: usedByCn.get(b.id) ?? 0 }
      : { ...b, paidCents: paidByBill.get(b.id) ?? 0, creditedCents: creditedByBill.get(b.id) ?? 0 }),
    payments: s.payments.map((p) => ({ amountCents: p.amountCents, appliedCents: appliedByPayment.get(p.id) ?? 0 })),
  }))
}

/**
 * `pointInTime`: rebuild every figure as at `asOf` (suppliersAsOf); otherwise
 * the documents as they stand now, aged at `asOf`.
 */
async function agingRows(supplierWhere: Prisma.SupplierWhereInput, asOf: Date, pointInTime = false): Promise<AgingRow[]> {
  const suppliers: AgingSupplier[] = pointInTime ? await suppliersAsOf(supplierWhere, asOf) : await prisma.supplier.findMany({
    where: supplierWhere,
    select: {
      id: true, name: true, tenantId: true, openingBalanceCents: true,
      bills: {
        where: { status: { notIn: ['void', 'draft'] } },
        select: { id: true, kind: true, dueDate: true, totalCents: true, whtCents: true, paidCents: true, creditedCents: true },
      },
      payments: { where: { voidedAt: null }, select: { amountCents: true, appliedCents: true } },
    },
  })

  const posted = await postedOpeningBalances(suppliers.map((s) => s.id), prisma, pointInTime ? asOf : undefined)
  const rows: AgingRow[] = []
  for (const s of suppliers) {
    // Company suppliers: the opening as posted to that company's ledger.
    // No company: nothing is ever posted, the column is the only figure.
    const opening = toCents(s.openingBalanceCents)
    const openingCents = s.tenantId ? (posted.get(s.id)?.get(s.tenantId) ?? 0) : opening
    const row: AgingRow = {
      supplierId: s.id, supplierName: s.name, tenantId: s.tenantId,
      bills: 0, current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0,
      creditsCents: 0, creditNotesCents: 0, total: 0, openingCents,
      // As at a past date the posted opening is the figure; "not yet posted" is today's question.
      openingUnpostedCents: s.tenantId && !pointInTime ? opening - openingCents : 0,
    }
    for (const b of s.bills) {
      if (b.kind === 'credit_note') {
        const left = creditNoteAvailableCents(b)
        if (left > 0) { row.creditsCents += left; row.creditNotesCents += left }
        continue
      }
      const due = billDueCents(b)
      if (due < 0) { row.creditsCents += -due; continue }   // paid beyond what it owed
      if (due === 0) continue
      row[agingBucket(apDaysPastDue(b.dueDate, asOf))] += due
      row.bills += 1
    }
    for (const p of s.payments) row.creditsCents += Math.max(0, toCents(p.amountCents) - toCents(p.appliedCents))
    row.total = row.current + row['1_30'] + row['31_60'] + row['61_90'] + row['90_plus'] + row.openingCents - row.creditsCents
    if (row.bills > 0 || row.creditsCents > 0 || row.openingCents !== 0 || row.openingUnpostedCents !== 0) rows.push(row)
  }
  return rows.sort((a, b) => b.total - a.total)
}

function totalsOf(rows: AgingRow[]): AgingTotals {
  const t = emptyTotals()
  for (const r of rows) {
    t.bills += r.bills
    t.current += r.current; t['1_30'] += r['1_30']; t['31_60'] += r['31_60']; t['61_90'] += r['61_90']; t['90_plus'] += r['90_plus']
    t.creditsCents += r.creditsCents; t.creditNotesCents += r.creditNotesCents; t.total += r.total; t.openingCents += r.openingCents
    t.openingUnpostedCents += r.openingUnpostedCents
  }
  return t
}

/**
 * AP aging for the companies in `tenantIds` (the request's scope). Fails
 * closed: an empty scope is an empty report, never every company's.
 */
export async function agingReport(
  tenantIds: string[],
  /**
   * asOf: the report AS AT that instant (every figure rebuilt — see
   * suppliersAsOf), e.g. the end of a month's last day; omitted = now, from
   * the documents as they stand.
   */
  opts: { includeUnassigned?: boolean; asOf?: Date } = {},
): Promise<AgingReport> {
  const pointInTime = !!opts.asOf
  const asOf = opts.asOf ?? new Date()
  if (tenantIds.length === 0) {
    return { asOf: asOf.toISOString(), bySupplier: [], total: emptyTotals(), unassigned: { bySupplier: [], total: emptyTotals() } }
  }
  const [rows, orphanRows] = await Promise.all([
    agingRows({ tenantId: { in: tenantIds } }, asOf, pointInTime),
    opts.includeUnassigned === false ? Promise.resolve([]) : agingRows({ tenantId: null }, asOf, pointInTime),
  ])
  return {
    asOf: asOf.toISOString(),
    bySupplier: rows,
    total: totalsOf(rows),
    unassigned: { bySupplier: orphanRows, total: totalsOf(orphanRows) },
  }
}

/** One supplier's aging row (the statement's "outstanding"). */
export async function supplierAging(supplierId: string, asOf = new Date()): Promise<AgingRow | null> {
  const [row] = await agingRows({ id: supplierId }, asOf)
  return row ?? null
}

// ─── Reorder Suggestions ─────────────────────────────────────────────────────

/**
 * Items below par level, grouped by their primary supplier. Each group is a
 * draft PO ready to fire. Considers in-flight POs to avoid double-ordering.
 */
/**
 * Kitchen flow (owner, 2026-10-26, part E): the ONE suggester. Without `demand` — the par rule (below par → up to
 * par). With `demand` (the shopping list: what the prep list and the forecast dishes will draw, per item, in stock
 * units) — those items only, suggested = demand − on hand (the OUTLET's stock when `locationId`, else the company
 * total) − on order. Every line carries its servd ingredient's SPEC (K6) for the PO.
 */
export async function reorderSuggestions(tenantIds: string[], opts: { demand?: Map<string, number>; locationId?: string | null } = {}) {
  // Items are company master data: scope by the item's own company. Fails
  // closed — an empty scope (staff with no company) suggests nothing, never
  // every company's par sheet.
  if (tenantIds.length === 0) return []
  const demand = opts.demand
  const items = await prisma.inventoryItem.findMany({
    where:   {
      deletedAt: null,
      tenantId: { in: tenantIds },
      ...(demand ? { id: { in: [...demand.keys()] } } : {}),
    },
    include: {
      supplier: { select: { id: true, name: true, tenantId: true } },
      masterIngredient: { select: { spec: true, specFields: true } },
    },
  })
  const { siteOnHandMany } = await import('../../lib/stockLedger.js')
  const siteStock = demand && opts.locationId ? await siteOnHandMany(prisma, items.map((i) => i.id), opts.locationId) : null

  // In-flight: not yet fully received, not cancelled — on these items only.
  const openLines = await prisma.purchaseOrderLine.findMany({
    where: {
      inventoryItemId: { in: items.map((i) => i.id) },
      purchaseOrder: { status: { in: ['draft', 'pending_approval', 'approved', 'sent', 'partial'] } },
    },
    include: { purchaseOrder: { select: { status: true } } },
  })
  const onOrder = new Map<string, number>()
  for (const l of openLines) {
    const remaining = Math.max(0, l.quantityOrdered - l.quantityReceived)
    onOrder.set(l.inventoryItemId, (onOrder.get(l.inventoryItemId) ?? 0) + remaining)
  }

  const groups = new Map<string, {
    supplierId: string | null
    supplierName: string
    lines: Array<{
      inventoryItemId: string
      name: string
      unit: string
      currentStock: number
      parLevel: number
      onOrder: number
      suggestedQty: number
      unitCostCents: number
      /** The shopping list's need for the item (demand mode only). */
      neededQty?: number
      spec: string | null
      specFields: Prisma.JsonValue | null
    }>
  }>()

  for (const item of items) {
    const incoming = onOrder.get(item.id) ?? 0
    const have = siteStock ? Math.max(0, siteStock.get(item.id) ?? 0) : item.currentStock
    const projected = have + incoming
    let suggestedQty: number
    if (demand) {
      // Whole stock units, never below what is needed (3 decimals of slack so 2.0000001 kg is not 3).
      suggestedQty = Math.ceil(Math.round(((demand.get(item.id) ?? 0) - projected) * 1000) / 1000)
    } else {
      if (!isBelowPar(item, incoming)) continue
      suggestedQty = Math.ceil(item.parLevel - projected)
    }
    if (suggestedQty <= 0) continue

    // A default supplier from another company is not a supplier this item's
    // company can order from (createPo would refuse it) — list it unassigned.
    const sup = item.supplier && item.supplier.tenantId === item.tenantId ? item.supplier : null
    const key = sup?.id ?? '__unassigned__'
    const group = groups.get(key) ?? {
      supplierId:   sup?.id ?? null,
      supplierName: sup?.name ?? 'Unassigned',
      lines: [],
    }
    group.lines.push({
      inventoryItemId: item.id,
      name:            item.name,
      unit:            item.unit,
      currentStock:    item.currentStock,
      parLevel:        item.parLevel,
      onOrder:         incoming,
      suggestedQty,
      unitCostCents:   item.unitCostCents ?? 0,
      ...(demand ? { neededQty: Math.round((demand.get(item.id) ?? 0) * 1000) / 1000, currentStock: have } : {}),
      spec:            item.masterIngredient?.spec ?? null,
      specFields:      item.masterIngredient?.specFields ?? null,
    })
    groups.set(key, group)
  }

  return Array.from(groups.values())
    .map((g) => ({
      ...g,
      estimatedTotalCents: g.lines.reduce((s, l) => s + l.suggestedQty * l.unitCostCents, 0),
    }))
    .sort((a, b) => b.estimatedTotalCents - a.estimatedTotalCents)
}
