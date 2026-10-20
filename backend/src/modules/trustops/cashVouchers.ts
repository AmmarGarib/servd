// Cash vouchers — GS Foods' internal cash payment voucher (the cash request),
// in the flow the owner set on 2026-10-15:
//
//   "keep cash request open for all, after someone requests cash a voucher
//    should be created on auto and go to finance for approval, when approved
//    by finance it should go to CEO for final approval, after CEO's approval,
//    the person who requested cash will receive the cash and submit the
//    supporting, expense should [be booked] after docs verification by finance"
//   (HOD step dropped — finance replaces it; finance may also raise a voucher
//   for an outside payee, with a discount — same flow, same CV-00001 series.)
//
//   submitted ──finance approve──▶ finance_approved ──CEO approve──▶ approved ──pay──▶ disbursed ──documents + finance verify──▶ posted
//       ▲  return (finance / CEO, note) → returned ──resubmit──┘      reject (finance / CEO, note) → rejected
//   cancel: the raiser (submitted / returned) or a cash keeper (any status before pay) → cancelled
//
// CLOSED (owner, 2026-10-16: "When user attach the supporting then it should
// marked as closed" — "Closed, finance checks after"): a paid 2026-10-15
// voucher shows CLOSED as soon as it carries ≥ 1 supporting document (and
// finance has not sent it back since the latest upload) — the requester is
// done and it leaves their open list; finance still checks the documents and
// the expense is booked at that check (books: 'pending' → 'booked' once
// posted). Derived only (closedStateOf) — the DB status stays 'disbursed'.
// Finance (or the CEO) may SEND BACK a closed, not-yet-booked voucher with a
// note (POST /:id/send-back: returnedAt / returnNote / returnCount, status
// unchanged); it is open again until the requester attaches another document.
//
// • Raise (POST /): kind 'request' — ANY login, the ACTIVE company, the holder
//   is the raiser by default; status 'submitted' at once (the voucher is
//   created automatically, no draft step). Kind 'expense' — finance only, for
//   an outside payee (payeeName, no login), gross − discount = the amount;
//   created straight into 'finance_approved' (finance prepared it), or
//   'submitted' when `sendTo: 'finance'` (or the CEO raised it).
// • Finance approval (POST /:id/finance-approve): a FINANCE APPROVER — role
//   finance holding the accounting module, or the CEO — never on a voucher
//   they raised or hold (409 SELF_APPROVE). May set the expense account,
//   discount, brand and department in the same call (audited).
// • CEO approval (POST /:id/approve, ADMIN_ONLY): never the raiser / holder
//   (409 SELF_APPROVE), never the login that gave the finance approval (or a
//   legacy HOD signature) (409 SAME_SIGNER).
// • Return for correction (POST /:id/return {note}) and reject: finance from
//   submitted, the CEO from finance_approved. The raiser edits and resubmits
//   (POST /:id/resubmit).
// • POST /:id/pay — finance pays (viewer.payer). ONE transaction: approved →
//   disbursed (it pays once), expenseOnVerify = true, bookedAtPay = true,
//   dueBy = now + OperationsConfig.cashAdvanceSettleDays, and ONE entry that
//   books the EXPENSE (owner, 2026-10-16: "It should pass only one entry when
//   booked by finance, either docs are attached or not"): from a box, the
//   petty-cash spend through recordPettyCashSpendTx with one expense line
//   (cashRequestPayLine): Dr <the voucher's 6xxx> / Cr 1011; from cash on hand
//   or a bank, 'cashvoucher.pay:<id>' Dr <the voucher's 6xxx> / Cr 1010 | the
//   bank's code (paySource; GET /:id/pay-sources lists what the viewer may
//   pick). Nothing is held on 1357.
// • Supporting documents (stored under the voucher, book nothing) and
//   finance's check (marks it posted, books nothing): cashRequestSettle.ts.
//   Vouchers paid before bookedAtPay (held on 1357) still book Dr expense /
//   Cr 1357 at verification.
// • Legacy rows: 'draft' (waiting for an HOD) is treated as 'submitted'
//   (finance approves it); 'hod_signed' exactly like 'finance_approved'.
//   Rows PAID under H3 (expenseOnVerify false: expensed at pay) keep their
//   receipts / settlement / change rules (cashRequestSettle.ts). A legacy row
//   paid by the old photo flow with no holder is 'needs review' (keepers
//   only) until finance names the holder.
//
// Company separation: a voucher binds to the ACTIVE company on create; its
// box, brand and holder must be that company's (422). Every read and write of
// an existing voucher is scoped to the operator's companies — another
// company's voucher is 404 on every route. Files are stored in the database
// and never selected by a list.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { CashVoucherStatus, type FixedAssetClass, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { audit } from '../../lib/audit.js'
import { serviceClient } from '../../lib/prisma.js'
import { auditApproval } from '../../lib/approvalRights.js'
import { queueStaffNotify, notifyStaffMany, type NotifyInput } from '../../lib/staffNotify.js'
import { approvalWaiting } from '../approvals/notify.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, activeTenantId } from '../../lib/tenantScope.js'
import { assertInt4Fits, zInt4Cents } from '../../lib/money.js'
import { amountInWords } from '../../lib/amountInWords.js'
import { EVIDENCE_MAX_BYTES, sendEvidence } from '../../lib/evidenceFile.js'
import { resolveSpendAccount } from '../accounting/expenseCategories.js'
import { cashRequestPaidAccountTx, cashRequestPayLine, categoryRefOf, paidFromLabel, postCashVoucherSourceTx } from '../accounting/pettyCashPosting.js'
import { moneyAccountCode } from '../../lib/bankAccounts.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { passesCashGuard, recordPettyCashSpendTx } from './pettyCash.js'
import { cashRequestSettleRoutes, flagOverrides } from './cashRequestSettle.js'
import { assertNotEquipmentLine, getAssetClasses } from '../fixedAssets/classes.js'
import { assertSharedHasLocation } from '../fixedAssets/events.js'
import { recordEquipmentPurchaseTx } from '../financePlanning/capexPosting.js'
import { prepareBill, insertBillTx, afterBillCreated } from '../procurement/service.js'
import { ensureFifoReady } from '../../lib/stockLedger.js'
import { equipmentLocationsOf } from '../../lib/generalLocation.js'
import { cashVoucherExportRoutes } from './voucherExport.js'
import { classificationOf, classifyingTx, type ClassificationInput } from '../accounting/paymentsRegister.js'

// ─── Files ───────────────────────────────────────────────────────────────────

/** A receipt (or the legacy signed-voucher photo) may be at most 3 MB decoded. */
export const CASH_VOUCHER_PHOTO_MAX_BYTES = EVIDENCE_MAX_BYTES

// ─── Shapes ──────────────────────────────────────────────────────────────────

export const VOUCHER_INCLUDE = {
  box: { select: { id: true, name: true, custodianId: true, tenantId: true, isActive: true, deletedAt: true } },
  // File METADATA only — the bytes are read by GET /:id/attachments/:aid alone.
  attachments: {
    select: { id: true, kind: true, mime: true, fileName: true, sizeBytes: true, createdAt: true, uploadedById: true, settlementId: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.CashVoucherInclude
export type VoucherRow = Prisma.CashVoucherGetPayload<{ include: typeof VOUCHER_INCLUDE }>

export const voucherNumber = (seq: number) => `CV-${String(seq).padStart(5, '0')}`

/** What is still open on a paid request: amount − receipts booked − change returned − converted. */
export const remainingOf = (v: { amountCents: number; settledCents: number; returnedCents: number; convertedCents: number }) =>
  v.amountCents - v.settledCents - v.returnedCents - v.convertedCents

/** Waiting for finance (a legacy 'draft' waited for an HOD — finance has that step now). */
export const WAIT_FINANCE: CashVoucherStatus[] = ['submitted', 'draft']
/** Waiting for the CEO's final approval (a legacy 'hod_signed' is the same step). */
export const WAIT_CEO: CashVoucherStatus[] = ['finance_approved', 'hod_signed']
/** The raiser may still edit (and cancel). */
const EDITABLE: CashVoucherStatus[] = ['submitted', 'draft', 'returned']
/** Not yet paid — a keeper may still cancel. */
const PRE_PAY: CashVoucherStatus[] = [...EDITABLE, ...WAIT_CEO, 'approved']
export const PAID_STATUSES: CashVoucherStatus[] = ['disbursed', 'settled', 'converted', 'posted']

/** A request paid by the old photo flow that names no holder (never a finance-raised payee voucher). */
const isLegacyNoHolder = (v: { status: CashVoucherStatus; payeeUserId: string | null; kind: string; expenseOnVerify: boolean }) =>
  v.status === 'disbursed' && !v.payeeUserId && v.kind === 'request' && !v.expenseOnVerify

/** The steps the UI shows (the DB status stays as stored). */
export type CashRequestStage =
  | 'waiting_finance' | 'waiting_ceo' | 'returned' | 'approved'
  | 'awaiting_docs' | 'sent_back' | 'awaiting_verification' | 'posted'
  | 'paid' | 'receipts_in' | 'settled' | 'needs_review' | 'rejected' | 'cancelled' | 'converted'

type ClosedInput = {
  status: CashVoucherStatus
  expenseOnVerify: boolean
  /** Booked in one entry when finance paid it (owner, 2026-10-16) — its books are 'booked' from the pay. */
  bookedAtPay?: boolean
  disbursedAt: Date | null
  returnedAt: Date | null
  attachments: Array<{ kind: string; createdAt: Date }>
}

/**
 * Finance sent this paid voucher back (returnedAt after the pay — a return
 * before the pay is the approval-stage "returned for correction") and no
 * supporting document has been added since.
 */
export function sentBackOf(v: ClosedInput): boolean {
  if (v.status !== 'disbursed' || !v.expenseOnVerify || !v.returnedAt || !v.disbursedAt) return false
  if (v.returnedAt.getTime() <= v.disbursedAt.getTime()) return false
  const back = v.returnedAt.getTime()
  return !v.attachments.some((a) => a.kind === 'supporting' && a.createdAt.getTime() > back)
}

/**
 * The presentational CLOSED state (owner, 2026-10-16): a paid 2026-10-15
 * voucher is closed once it carries a supporting document (and is not sent
 * back since) — books 'pending' until finance verifies, 'booked' once posted.
 * A voucher booked at pay (bookedAtPay) is 'booked' from the pay: finance's
 * check only marks the documents checked.
 * Legacy rows and unpaid vouchers: never closed here (books null).
 */
export function closedStateOf(v: ClosedInput): { closed: boolean; booksState: 'pending' | 'booked' | null; sentBack: boolean } {
  if (!v.expenseOnVerify) return { closed: false, booksState: null, sentBack: false }
  if (v.status === 'posted') return { closed: true, booksState: 'booked', sentBack: false }
  if (v.status !== 'disbursed') return { closed: false, booksState: null, sentBack: false }
  const sentBack = sentBackOf(v)
  const closed = !sentBack && v.attachments.some((a) => a.kind === 'supporting')
  return { closed, booksState: v.bookedAtPay ? 'booked' : closed ? 'pending' : null, sentBack }
}

/**
 * Ids of every paid 2026-10-15 voucher (status disbursed) that is CLOSED
 * (books pending) and that is SENT BACK — closedStateOf in SQL, for the list
 * views and the dashboard. Callers intersect with their own company scope.
 * Small set: only vouchers paid and not yet verified.
 */
export async function paidDocStates(): Promise<{ closedIds: string[]; sentBackIds: string[] }> {
  const rows = await prisma.$queryRaw<Array<{ id: string; closed: boolean; sentBack: boolean }>>`
    SELECT v.id,
      EXISTS (
        SELECT 1 FROM cash_voucher_attachments a
        WHERE a."voucherId" = v.id AND a.kind = 'supporting'
          AND (v."returnedAt" IS NULL OR v."disbursedAt" IS NULL OR v."returnedAt" <= v."disbursedAt" OR a."createdAt" > v."returnedAt")
      ) AS closed,
      (v."returnedAt" IS NOT NULL AND v."disbursedAt" IS NOT NULL AND v."returnedAt" > v."disbursedAt"
        AND NOT EXISTS (
          SELECT 1 FROM cash_voucher_attachments a
          WHERE a."voucherId" = v.id AND a.kind = 'supporting' AND a."createdAt" > v."returnedAt"
        )) AS "sentBack"
    FROM cash_vouchers v
    WHERE v.status = 'disbursed' AND v."expenseOnVerify" = true`
  return { closedIds: rows.filter((r) => r.closed).map((r) => r.id), sentBackIds: rows.filter((r) => r.sentBack).map((r) => r.id) }
}

export function stageOf(v: ClosedInput & { payeeUserId: string | null; kind: string }): CashRequestStage {
  switch (v.status) {
    case 'draft':
    case 'submitted': return 'waiting_finance'
    case 'hod_signed':
    case 'finance_approved': return 'waiting_ceo'
    case 'disbursed':
      if (v.expenseOnVerify) {
        const st = closedStateOf(v)
        return st.closed ? 'awaiting_verification' : st.sentBack ? 'sent_back' : 'awaiting_docs'
      }
      if (isLegacyNoHolder(v)) return 'needs_review'
      return v.attachments.some((a) => a.kind === 'receipt') ? 'receipts_in' : 'paid'
    default: return v.status
  }
}

// ─── Who is looking ──────────────────────────────────────────────────────────

export interface Viewer {
  id: string
  role: string
  /** Passes CASH_GUARD (the manager tiers, finance with the accounting module). */
  keeper: boolean
  isAdmin: boolean
  /** May give the FINANCE approval and verify documents: role finance holding the accounting module, or the CEO. */
  financeApprover: boolean
  /** Boxes this login holds (not deleted) in its companies. */
  heldBoxIds: Set<string>
  /** Companies where this login holds an OPEN box (it may pay an unboxed request there). */
  payBoxTenants: Set<string>
  /** Pays approved vouchers (owner, 2026-10-16: "Paying a voucher should remain at Finance end"): role finance
   *  with the accounting module ONLY — not a box's cashier, a manager or the CEO (who approved it). */
  payer: boolean
}

export async function viewerOf(req: FastifyRequest): Promise<Viewer> {
  const su = req.staffUser!
  const keeper = await passesCashGuard(req)
  const boxes = await prisma.pettyCashBox.findMany({
    where: { custodianId: su.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
    select: { id: true, tenantId: true, isActive: true },
  })
  const isAdmin = su.role === 'admin'
  return {
    id: su.id,
    role: su.role,
    keeper,
    isAdmin,
    financeApprover: isAdmin || (su.role === 'finance' && keeper),
    heldBoxIds: new Set(boxes.map((b) => b.id)),
    payBoxTenants: new Set(boxes.filter((b) => b.isActive && b.tenantId).map((b) => b.tenantId!)),
    payer: su.role === 'finance' && keeper,
  }
}

export interface CashRequestCaps {
  canEdit: boolean
  canEditCategory: boolean
  /** Finance may change the discount (raise, finance approval, or until the CEO approves). */
  canEditDiscount: boolean
  /** Retired (the HOD step is gone, 2026-10-15) — always false; kept for old screens. */
  canSignHod: boolean
  canFinanceApprove: boolean
  /** The CEO's final approval. */
  canApprove: boolean
  canReturn: boolean
  canReject: boolean
  canResubmit: boolean
  canCancel: boolean
  canPay: boolean
  /** Add supporting documents (POST /:id/documents). */
  canUpload: boolean
  /** Finance sends a closed, not-yet-booked voucher back to the requester (POST /:id/send-back). */
  canSendBack: boolean
  /** Record what was spent (POST /:id/spend) before finance verifies. */
  canRecordSpend: boolean
  /** Finance verifies the documents and books the expense (POST /:id/verify-docs). */
  canVerify: boolean
  /** Finance marks a voucher still held on 1357 as cleared by a manual journal (POST /:id/resolve-by-journal). */
  canResolveByJournal: boolean
  /** The holder confirms they received the cash (POST /:id/confirm-received). */
  canConfirmReceived: boolean
  /** Finance (not the raiser / holder) or the CEO records receipt for a holder who cannot (e.g. has left), with a
   *  reason (POST /:id/confirm-received-on-behalf). */
  canConfirmReceivedOnBehalf: boolean
  canExport: boolean
  // Legacy H3 rows (expenseOnVerify false), paid before 2026-10-15:
  canUploadReceipts: boolean
  canSettle: boolean
  canReturnChange: boolean
  canReclass: boolean
  canNameHolder: boolean
}

/** Raised or held by this viewer — they never approve, return, reject or verify it. */
const isOwn = (viewer: Viewer, v: { preparedById: string; payeeUserId: string | null }) =>
  v.preparedById === viewer.id || v.payeeUserId === viewer.id

const supportingCountOf = (v: { attachments: Array<{ kind: string }> }) => v.attachments.filter((a) => a.kind === 'supporting').length

/** What this viewer may do on `v` — the UI shows buttons by these; the routes re-check each one. */
export async function capsOf(viewer: Viewer, v: VoucherRow): Promise<CashRequestCaps> {
  const me = viewer.id
  const s = v.status
  const raiser = v.preparedById === me
  const holder = v.payeeUserId
  const own = isOwn(viewer, v)
  const custodian = !!v.box && v.box.custodianId === me
  const remaining = remainingOf(v)
  const legacyPaid = s === 'disbursed' && !v.expenseOnVerify
  const newPaid = s === 'disbursed' && v.expenseOnVerify
  const financeStep = WAIT_FINANCE.includes(s) && viewer.financeApprover && !own
  const ceoStep = WAIT_CEO.includes(s) && viewer.isAdmin && !own
  const canUploadReceipts = legacyPaid && (viewer.keeper || (!!holder && holder === me))
  // The requester (whoever raised it) and the holder attach the documents once the cash is paid (owner, 2026-10-16).
  const docsParty = viewer.financeApprover || viewer.keeper || custodian || raiser || (v.kind === 'request' && !!holder && holder === me)
  const docState = closedStateOf(v)
  return {
    canEdit: EDITABLE.includes(s) && (raiser || viewer.keeper),
    canEditCategory: (EDITABLE.includes(s) && (raiser || viewer.keeper)) || (viewer.keeper && (WAIT_CEO.includes(s) || s === 'approved')),
    canEditDiscount: viewer.financeApprover && (EDITABLE.includes(s) || (WAIT_CEO.includes(s) && !own)),
    canSignHod: false,
    canFinanceApprove: financeStep,
    canApprove: ceoStep && v.financeApprovedById !== me && v.hodSignedById !== me,
    canReturn: financeStep || ceoStep,
    canReject: financeStep || ceoStep || (s === 'returned' && (viewer.financeApprover || viewer.isAdmin) && !own),
    canResubmit: s === 'returned' && (raiser || (v.kind === 'expense' && viewer.financeApprover)),
    canCancel: (EDITABLE.includes(s) && raiser) || (viewer.keeper && PRE_PAY.includes(s)),
    canPay: s === 'approved' && viewer.payer,
    canUpload: ((s === 'approved' || newPaid) && docsParty) || (s === 'posted' && viewer.keeper),
    canSendBack: newPaid && docState.closed && viewer.financeApprover && !own,
    // Never since 1357 was retired (owner, 2026-10-16): the expense is one entry; finance corrects by manual journal.
    canRecordSpend: false,
    canVerify: newPaid && viewer.financeApprover && !own && supportingCountOf(v) > 0 && (v.kind !== 'request' || !!v.cashReceivedAt),
    canResolveByJournal: newPaid && !v.bookedAtPay && !v.postedAt && (!!v.pettyCashMovementId || !!v.payJournalEntryId)
      && viewer.financeApprover && !own,
    canConfirmReceived: v.kind === 'request' && !!holder && holder === me && !v.cashReceivedAt
      && (s === 'disbursed' || s === 'posted' || s === 'settled' || s === 'converted'),
    canConfirmReceivedOnBehalf: v.kind === 'request' && !v.cashReceivedAt && newPaid && viewer.financeApprover && !own
      && v.disbursedById !== me,
    canExport: true, // every stage; stamped NOT APPROVED / VOID until the CEO approves (owner, 2026-10-16)
    canUploadReceipts,
    canSettle: canUploadReceipts && remaining > 0,
    canReturnChange: legacyPaid && remaining > 0 && (viewer.keeper || custodian),
    canReclass: viewer.keeper && ((s === 'disbursed' && !v.expenseOnVerify) || s === 'settled' || s === 'posted'),
    canNameHolder: viewer.keeper && !holder && v.kind === 'request' && (WAIT_CEO.includes(s) || s === 'approved' || legacyPaid),
  }
}

/** May this viewer open `v` at all (inside its company scope)? */
export async function canSee(viewer: Viewer, v: VoucherRow): Promise<boolean> {
  if (viewer.keeper || viewer.financeApprover) return true
  if (v.payeeUserId === viewer.id) return true
  if (v.preparedById === viewer.id && !isLegacyNoHolder(v)) return true
  if ((v.status === 'approved' || PAID_STATUSES.includes(v.status)) && v.boxId && viewer.heldBoxIds.has(v.boxId)) return true
  if (v.status === 'approved' && !v.boxId && viewer.payBoxTenants.has(v.tenantId)) return true
  return false
}

/** The list's visibility rule for a non-keeper, as a where clause (canSee in SQL). */
function visibleWhere(viewer: Viewer): Prisma.CashVoucherWhereInput {
  if (viewer.keeper || viewer.financeApprover) return {}
  return {
    OR: [
      { payeeUserId: viewer.id },
      { preparedById: viewer.id, NOT: { status: 'disbursed', payeeUserId: null, kind: 'request', expenseOnVerify: false } },
      { status: { in: ['approved', ...PAID_STATUSES] }, boxId: { in: [...viewer.heldBoxIds] } },
      { status: 'approved', boxId: null, tenantId: { in: [...viewer.payBoxTenants] } },
    ],
  }
}

// ─── Presenting ──────────────────────────────────────────────────────────────

/** The voucher as every route returns it: the row, names, stage, counters, words and caps (never file bytes). */
export async function present(rows: VoucherRow[], viewer: Viewer) {
  const userIds = new Set<string>()
  const conceptIds = new Set<string>()
  const tenantIds = new Set<string>()
  for (const v of rows) {
    for (const id of [
      v.preparedById, v.hodSignedById, v.directorSignedById, v.rejectedById, v.cancelledById, v.disbursedById, v.payeeUserId,
      v.box?.custodianId ?? null, v.submittedById, v.financeApprovedById, v.returnedById, v.docsVerifiedById, v.postedById,
      v.cashReceivedById,
      ...v.attachments.map((a) => a.uploadedById),
    ]) {
      if (id) userIds.add(id)
    }
    if (v.conceptId) conceptIds.add(v.conceptId)
    tenantIds.add(v.tenantId)
  }
  // Names only, for ids these vouchers (already in scope) point at.
  const locationIds = [...new Set(rows.map((v) => v.assetLocationId).filter((x): x is string => !!x))]
  const supplierIds = [...new Set(rows.map((v) => v.supplierId).filter((x): x is string => !!x))]
  const [users, concepts, tenants, assetLabels, locations, suppliers] = await Promise.all([
    userIds.size ? prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }) : [],
    conceptIds.size ? prisma.concept.findMany({ where: { id: { in: [...conceptIds] } }, select: { id: true, name: true } }) : [],
    tenantIds.size ? prisma.tenant.findMany({ where: { id: { in: [...tenantIds] } }, select: { id: true, name: true } }) : [],
    assetClassLabels(rows),
    locationIds.length ? prisma.location.findMany({ where: { id: { in: locationIds }, tenantId: { in: [...tenantIds] } }, select: { id: true, name: true } }) : [],
    supplierIds.length ? prisma.supplier.findMany({ where: { id: { in: supplierIds }, tenantId: { in: [...tenantIds] } }, select: { id: true, name: true } }) : [],
  ])
  const supplierName = new Map(suppliers.map((x) => [x.id, x.name]))
  const locationName = new Map(locations.map((l) => [l.id, l.name]))
  const userName = new Map(users.map((u) => [u.id, u.name]))
  const conceptName = new Map(concepts.map((c) => [c.id, c.name]))
  const tenantName = new Map(tenants.map((t) => [t.id, t.name]))
  const nameOf = (id: string | null) => (id ? (userName.get(id) ?? null) : null)
  const bankIds = [...new Set(rows.flatMap((v) => [v.payBankAccountId, v.plannedBankAccountId]).filter((x): x is string => !!x))]
  const bankRows = bankIds.length
    ? await prisma.bankAccount.findMany({ where: { id: { in: bankIds }, tenantId: { in: [...tenantIds] } }, select: { id: true, name: true, tenantId: true } })
    : []
  const now = Date.now()
  return Promise.all(rows.map(async (v) => {
    const { box, attachments, ...voucher } = v
    const receipts = attachments.filter((a) => a.kind === 'receipt')
    const signed = attachments.filter((a) => a.kind === 'signed_voucher')
    const supporting = attachments.filter((a) => a.kind === 'supporting')
    const remainingCents = remainingOf(v)
    const ref = categoryRefOf(v.category)
    const docState = closedStateOf(v)
    return {
      ...voucher,
      stage: stageOf(v),
      /** Closed for the requester (documents attached); finance still checks them — booksState says if the expense is booked. */
      closed: docState.closed,
      booksState: docState.booksState,
      /** Finance sent it back after the documents came in; open again until another document is attached. */
      sentBack: docState.sentBack,
      sentBackNote: docState.sentBack ? v.returnNote : null,
      /** The amount paid (= gross − discount). */
      totalCents: v.amountCents,
      grossOrAmountCents: v.grossCents ?? v.amountCents + v.discountCents,
      amountInWords: amountInWords(v.amountCents),
      categoryKey: ref.categoryKey,
      categoryAccountCode: ref.accountCode,
      /** Equipment (owner, 2026-10-19): the fixed-asset class's label — booked to CapEx advances (1340) at pay. */
      assetClassLabel: v.assetClassId ? (assetLabels.get(v.assetClassId) ?? null) : null,
      assetLocationName: v.assetLocationId ? (locationName.get(v.assetLocationId) ?? null) : null,
      /** "To pay from" (2026-10-19): the plan set at raise, the supplier (credit) and the planned bank's name. */
      payFrom: v.plannedPaySource,
      payFromBankAccountId: v.plannedBankAccountId,
      payFromBankName: v.plannedBankAccountId ? (bankRows.find((b) => b.id === v.plannedBankAccountId && b.tenantId === v.tenantId)?.name ?? null) : null,
      supplierName: v.supplierId ? (supplierName.get(v.supplierId) ?? null) : null,
      /** Internal payment classification chosen at raise (2026-10-20) — prefills the pay step. */
      classification: v.plannedClassification,
      taxStatus: v.plannedTaxStatus,
      nonDeductionReason: v.plannedNonDeductionReason,
      holderUserId: v.payeeUserId,
      holderName: nameOf(v.payeeUserId),
      remainingCents,
      overdue: v.status === 'disbursed' && !!v.dueBy && v.dueBy.getTime() < now && !docState.closed && (v.expenseOnVerify || remainingCents > 0),
      needsReview: isLegacyNoHolder(v),
      supportingCount: supporting.length,
      documents: supporting.map((a) => ({
        id: a.id, fileName: a.fileName, mime: a.mime, sizeBytes: a.sizeBytes, createdAt: a.createdAt,
        uploadedById: a.uploadedById, uploadedByName: nameOf(a.uploadedById),
      })),
      receiptCount: receipts.length,
      receiptsUnsettled: receipts.filter((a) => !a.settlementId).length,
      receipts: receipts.map((a) => ({ id: a.id, mime: a.mime, sizeBytes: a.sizeBytes, createdAt: a.createdAt, uploadedById: a.uploadedById, settlementId: a.settlementId })),
      signedPhotos: signed.map((a) => ({ id: a.id, mime: a.mime, sizeBytes: a.sizeBytes, createdAt: a.createdAt })),
      companyName: tenantName.get(v.tenantId) ?? null,
      conceptName: v.conceptId ? (conceptName.get(v.conceptId) ?? null) : null,
      boxName: box?.name ?? null,
      /** Where the cash came from once paid: the box's name, "Cash on hand" or the bank's name (owner, 2026-10-16). */
      paidFrom: paidFromLabel(v, {
        boxName: box?.name ?? null,
        bankName: bankRows.find((b) => b.id === v.payBankAccountId && b.tenantId === v.tenantId)?.name ?? null,
        supplierName: v.supplierId ? (supplierName.get(v.supplierId) ?? null) : null,
      }),
      custodianId: box?.custodianId ?? null,
      custodianName: box ? nameOf(box.custodianId) : null,
      payeeUserName: nameOf(v.payeeUserId),
      preparedByName: nameOf(v.preparedById),
      submittedByName: nameOf(v.submittedById),
      financeApprovedByName: nameOf(v.financeApprovedById),
      hodSignedByName: nameOf(v.hodSignedById),
      directorSignedByName: nameOf(v.directorSignedById),
      returnedByName: nameOf(v.returnedById),
      rejectedByName: nameOf(v.rejectedById),
      cancelledByName: nameOf(v.cancelledById),
      disbursedByName: nameOf(v.disbursedById),
      docsVerifiedByName: nameOf(v.docsVerifiedById),
      postedByName: nameOf(v.postedById),
      cashReceivedByName: nameOf(v.cashReceivedById),
      /** The digital voucher (no signatures, owner 2026-10-15): who paid, and who received — the holder (or the
       *  outside payee) until confirmed, then the confirmer. */
      paidByName: v.disbursedById ? nameOf(v.disbursedById) : null,
      receiverName: v.kind === 'expense' ? v.payeeName : ((v.cashReceivedById ? nameOf(v.cashReceivedById) : nameOf(v.payeeUserId)) ?? v.payeeName),
      isMine: v.preparedById === viewer.id || v.payeeUserId === viewer.id,
      ...(await capsOf(viewer, v)),
    }
  }))
}
export const presentOne = async (v: VoucherRow, viewer: Viewer) => (await present([v], viewer))[0]!

/** One voucher in full: the row, its settlements / spend lines and where its pay is booked. */
export async function detailOf(id: string, viewer: Viewer) {
  const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id }, include: VOUCHER_INCLUDE })
  const base = await presentOne(v, viewer)
  const [settlements, payMovement] = await Promise.all([
    prisma.cashVoucherSettlement.findMany({
      where: { voucherId: v.id, tenantId: v.tenantId },
      include: { lines: { orderBy: { createdAt: 'asc' } }, attachments: { select: { id: true, mime: true, sizeBytes: true, createdAt: true } } },
      orderBy: { seq: 'asc' },
    }),
    v.pettyCashMovementId
      ? prisma.pettyCashMovement.findUnique({ where: { id: v.pettyCashMovementId }, select: { id: true, amountCents: true, createdAt: true, journalEntryId: true, boxId: true } })
      : null,
  ])
  let paidAccountCode: string | null = null
  if (v.supplierBillId) {
    paidAccountCode = '2010'   // on credit: the supplier is owed (its bill)
  } else if (v.capexLineId) {
    // equipment: CapEx advances until the CEO capitalises it; on credit nothing is booked until then (→ 2012)
    paidAccountCode = v.paySource === 'credit' ? null : '1340'
  } else if (v.pettyCashMovementId || v.payJournalEntryId) {
    try { paidAccountCode = await cashRequestPaidAccountTx(prisma, v.id) } catch { paidAccountCode = null }
  }
  const submitters = [...new Set(settlements.map((s) => s.submittedById))]
  const names = submitters.length ? await prisma.user.findMany({ where: { id: { in: submitters } }, select: { id: true, name: true } }) : []
  // 2026-10-15 flow: what the holder (or finance) says was spent, before / as verified. A voucher booked at pay
  // has no spend lines (spend null): its one entry is the pay.
  const hold = v.expenseOnVerify && !v.bookedAtPay
  const spentCents = hold ? settlements.reduce((t, s) => t + s.lines.reduce((u, l) => u + l.amountCents, 0), 0) : null
  const spendLines = hold ? settlements.flatMap((s) => s.lines) : []
  return {
    ...base,
    paidAccountCode,
    payMovement,
    /**
     * The ONE entry that booked a bookedAtPay voucher (the box spend's or 'cashvoucher.pay:<id>'; a hold converted
     * to one entry — voucherHoldConversion.ts — its 'cashvoucher.hold_convert:<id>', stamped as postedJournalEntryId).
     */
    payEntryId: (v.bookedAtPay ? v.postedJournalEntryId : null) ?? v.payJournalEntryId ?? payMovement?.journalEntryId ?? null,
    /** On credit: the supplier bill finance's pay booked (paid later through Supplier payments). */
    supplierBill: v.supplierBillId
      ? await prisma.supplierBill.findFirst({
        where: { id: v.supplierBillId, supplier: { tenantId: v.tenantId } },
        select: { id: true, billNumber: true, status: true, dueDate: true, totalCents: true, whtCents: true, paidCents: true },
      })
      : null,
    /** Equipment: the CEO's capitalisation request raised at pay (pending → posted, or rejected: the cost stays on 1340). */
    capitalisation: v.capitaliseEventId
      ? await prisma.fixedAssetEvent.findFirst({
        where: { id: v.capitaliseEventId, tenantId: v.tenantId },
        select: { id: true, status: true, decidedAt: true, decisionNote: true },
      })
      : null,
    settlements: settlements.map((s) => ({ ...s, submittedByName: names.find((n) => n.id === s.submittedById)?.name ?? null })),
    spend: hold ? {
      lines: spendLines,
      spentCents,
      /** spent < paid: the change the holder hands back at verification. */
      changeDueCents: spendLines.length ? Math.max(0, v.amountCents - spentCents!) : null,
      /** spent > paid: what finance pays the holder at verification. */
      topUpDueCents: spendLines.length ? Math.max(0, spentCents! - v.amountCents) : null,
    } : null,
  }
}

// ─── Input ───────────────────────────────────────────────────────────────────

const zVoucherDate = z.string().trim()
  .refine((s) => /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s)), 'Use a date like 2026-10-13')
  .transform((s) => new Date(s))
const zOptionalText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((s) => (s === undefined ? undefined : s === null || s === '' ? null : s))

const fields = {
  voucherDate: zVoucherDate.optional(),
  purpose: z.string().trim().min(1).max(500),
  // The expense account (a PAYOUT key, or — cash keepers only — an explicit 6xxx code).
  categoryKey: z.string().trim().min(1).max(40).nullable().optional(),
  accountCode: z.string().trim().regex(/^\d{4}$/, 'An account code is four digits').nullable().optional(),
  conceptId: z.string().uuid().nullable().optional(),
  department: zOptionalText(80),
  // Paid from a petty-cash box (INT4), so INT4. The TOTAL paid (after discount).
  amountCents: zInt4Cents('The amount', { sign: 'positive' }).optional(),
  // Finance only: the amount before discount, and the discount (total = gross − discount).
  grossCents: zInt4Cents('The gross amount', { sign: 'positive' }).optional(),
  discountCents: zInt4Cents('The discount', { sign: 'nonnegative' }).optional(),
  /** Who takes the cash and brings the documents (kind request). Default: whoever raises it. */
  holderUserId: z.string().min(1).max(64).optional(),
  /** The name on the paper (kind expense: the outside payee). Default: the holder's name. */
  payeeName: z.string().trim().min(1).max(120).optional(),
  /** Keepers only. Otherwise the custodian picks the box at pay. */
  boxId: z.string().min(1).max(64).nullable().optional(),
  /**
   * Equipment on a finance payee voucher (owner, 2026-10-19): a fixed-asset class of the voucher's company INSTEAD
   * of an expense account (kind 'expense' only — 422 ASSET_ONLY_ON_PAYEE_VOUCHER). null clears it.
   */
  assetClassId: z.string().min(1).max(64).nullable().optional(),
  /** The outlet the equipment is at (required when the voucher has no brand: shared equipment). */
  assetLocationId: z.string().min(1).max(64).nullable().optional(),
  /**
   * "To pay from" on a payee voucher (owner, 2026-10-19): cash / bank (+ payFromBankAccountId) prefill finance's pay;
   * credit (+ supplierId) books a supplier bill at finance's pay instead of handing cash over. Kind 'expense' only.
   */
  payFrom: z.enum(['cash', 'bank', 'credit']).nullable().optional(),
  payFromBankAccountId: z.string().min(1).max(64).nullable().optional(),
  supplierId: z.string().min(1).max(64).nullable().optional(),
  /**
   * Internal payment classification (owner, 2026-10-20): Official / Unofficial / Unclassified + tax status, chosen
   * when the voucher is raised (finance / the CEO only). Prefills finance's pay; a label only (paymentsRegister.ts).
   * classification null clears it.
   */
  classification: z.enum(['official', 'unofficial', 'unclassified']).nullable().optional(),
  taxStatus: z.enum(['deducted', 'not_deducted', 'not_applicable']).nullable().optional(),
  nonDeductionReason: z.string().trim().max(500).nullable().optional(),
}
const CreateBody = z.object({
  ...fields,
  kind: z.enum(['request', 'expense']).default('request'),
  /** kind expense: 'ceo' (default — finance's preparing is its approval) or 'finance' (another finance person approves). */
  sendTo: z.enum(['ceo', 'finance']).optional(),
})
const PatchBody = z.object(fields).partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Send at least one field to change')
type PatchInput = z.infer<typeof PatchBody>

/**
 * The planned classification columns a create / patch body sets, or undefined when it names none. Finance / the CEO
 * only (403 CLASSIFICATION_FINANCE_ONLY); validated by the register's own rule (reason ≥10 when tax not deducted).
 */
function plannedClassificationOf(viewer: { financeApprover: boolean }, body: Record<string, unknown>):
  { plannedClassification: string | null; plannedTaxStatus: string | null; plannedNonDeductionReason: string | null } | undefined {
  if (body['classification'] === undefined && body['taxStatus'] === undefined && body['nonDeductionReason'] === undefined) return undefined
  if (!viewer.financeApprover) throw new AppError('CLASSIFICATION_FINANCE_ONLY', 'Only finance or the CEO classifies a payment', 403)
  if (body['classification'] === undefined) throw new AppError('INVALID_CLASSIFICATION', 'Pick a classification: Official, Unofficial or Unclassified', 400)
  if (body['classification'] === null) {
    return { plannedClassification: null, plannedTaxStatus: null, plannedNonDeductionReason: null }
  }
  const c = classificationOf(body)!
  return {
    plannedClassification: c.classification,
    plannedTaxStatus: c.taxStatus ?? null,
    plannedNonDeductionReason: c.taxStatus === 'not_deducted' ? (c.nonDeductionReason ?? '').trim() : null,
  }
}

/** The voucher's planned classification as a pay-time input (null = none planned). */
function plannedClassificationInput(v: { plannedClassification: string | null; plannedTaxStatus: string | null; plannedNonDeductionReason: string | null }): ClassificationInput | null {
  if (!v.plannedClassification) return null
  return {
    classification: v.plannedClassification as ClassificationInput['classification'],
    taxStatus: (v.plannedTaxStatus ?? null) as ClassificationInput['taxStatus'],
    nonDeductionReason: v.plannedNonDeductionReason,
  }
}

const NoteBody = z.object({ note: z.string().trim().min(3, 'Say why (at least 3 characters)').max(500) })

/** The holder must be a login of the voucher's company. */
async function holderOf(tenantId: string, userId: string): Promise<{ id: string; name: string }> {
  const u = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] },
    select: { id: true, name: true },
  })
  if (!u) throw new AppError('PAYEE_NOT_IN_COMPANY', 'The person who takes the cash must be a login of this request\'s company', 422)
  return u
}

/** An open petty-cash box of `tenantId`, or 422 BOX_NOT_IN_COMPANY. */
async function openBoxOf(tenantId: string, boxId: string) {
  const box = await prisma.pettyCashBox.findFirst({
    where: { id: boxId, tenantId, deletedAt: null, isActive: true },
    select: { id: true, name: true, custodianId: true, tenantId: true },
  })
  if (!box) throw new AppError('BOX_NOT_IN_COMPANY', 'That cash box is not an open petty-cash box of this request\'s company', 422)
  return box
}

/** The category as stored, checked in the company's chart (CashVoucher.category: key or keeper's 6xxx). */
async function categoryOf(tenantId: string, body: Pick<PatchInput, 'categoryKey' | 'accountCode'>, keeper: boolean): Promise<string> {
  const acct = await resolveSpendAccount(prisma, tenantId, { categoryKey: body.categoryKey, accountCode: body.accountCode }, { allowExplicit: keeper })
  return acct.categoryKey ?? acct.code
}

/**
 * Equipment on a payee voucher (owner, 2026-10-19). The class must be an
 * active, non-pooled FixedAssetClass of the VOUCHER's company (422
 * ASSET_CLASS_NOT_IN_COMPANY / CLASS_INACTIVE / POOLED_CLASS_USE_QUICK_BUY —
 * smallwares need a pool type: CapEx Quick buy), only on kind 'expense' (422
 * ASSET_ONLY_ON_PAYEE_VOUCHER), the outlet one of that company's (422
 * LOCATION_NOT_IN_COMPANY), and shared equipment (no brand) names its outlet
 * (422 LOCATION_REQUIRED_FOR_SHARED). Returns the class, or null when the
 * voucher names none (an outlet without a class: 400 LOCATION_ONLY_FOR_ASSET).
 */
export async function assetTargetOf(
  db: Prisma.TransactionClient | typeof prisma,
  tenantId: string,
  a: { kind: string; assetClassId: string | null; assetLocationId: string | null; conceptId: string | null },
): Promise<FixedAssetClass | null> {
  if (!a.assetClassId) {
    if (a.assetLocationId) throw new AppError('LOCATION_ONLY_FOR_ASSET', 'An outlet is only named for equipment (a fixed-asset class)', 400)
    return null
  }
  if (a.kind !== 'expense') {
    throw new AppError('ASSET_ONLY_ON_PAYEE_VOUCHER', 'Equipment (a fixed-asset class) is bought on a finance payee voucher — a cash request books an expense account', 422)
  }
  const cls = await db.fixedAssetClass.findFirst({ where: { id: a.assetClassId, tenantId } })
  if (!cls) throw new AppError('ASSET_CLASS_NOT_IN_COMPANY', 'That fixed-asset class is not one of this voucher\'s company\'s', 422)
  if (!cls.isActive) throw new AppError('CLASS_INACTIVE', `${cls.label} is switched off for this company`, 422)
  if (cls.pooled) {
    throw new AppError('POOLED_CLASS_USE_QUICK_BUY', `${cls.label} are pooled by type and outlet — buy them through CapEx Quick buy`, 422)
  }
  if (a.assetLocationId) {
    const l = await db.location.findFirst({ where: { id: a.assetLocationId, tenantId, deletedAt: null }, select: { id: true } })
    if (!l) throw new AppError('LOCATION_NOT_IN_COMPANY', 'That outlet is not one of this voucher\'s company\'s', 422)
  }
  assertSharedHasLocation(a.conceptId, a.assetLocationId)
  return cls
}

/** "Fixed asset — Kitchen equipment" for screens, the inbox and the printout (null for an expense voucher). */
export async function assetClassLabels(rows: Array<{ assetClassId: string | null; tenantId: string }>): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.assetClassId).filter((x): x is string => !!x))]
  if (ids.length === 0) return new Map()
  const cls = await prisma.fixedAssetClass.findMany({ where: { id: { in: ids }, tenantId: { in: [...new Set(rows.map((r) => r.tenantId))] } }, select: { id: true, label: true } })
  return new Map(cls.map((c) => [c.id, c.label]))
}

/**
 * "To pay from" (owner, 2026-10-19), checked in the VOUCHER's company: kind
 * 'expense' only (422 PAY_FROM_ONLY_ON_PAYEE_VOUCHER); a bank of that company
 * (moneyAccountCode: 422 for another company's); credit names a live supplier
 * of that company (422 SUPPLIER_REQUIRED / SUPPLIER_NOT_IN_COMPANY). A bank
 * without 'bank' or a supplier without 'credit' is 400.
 */
export async function payPlanOf(
  tenantId: string,
  a: { kind: string; payFrom: string | null; bankAccountId: string | null; supplierId: string | null },
): Promise<{ plannedPaySource: string | null; plannedBankAccountId: string | null; supplierId: string | null; supplierName: string | null }> {
  if (!a.payFrom && !a.bankAccountId && !a.supplierId) return { plannedPaySource: null, plannedBankAccountId: null, supplierId: null, supplierName: null }
  if (a.kind !== 'expense') {
    throw new AppError('PAY_FROM_ONLY_ON_PAYEE_VOUCHER', '"To pay from" is set on a finance payee voucher — a cash request is paid in cash', 422)
  }
  if (a.bankAccountId && a.payFrom !== 'bank') throw new AppError('BANK_NOT_FOR_SOURCE', 'A bank account is only named when it is paid from a bank', 400)
  if (a.supplierId && a.payFrom !== 'credit') throw new AppError('SUPPLIER_ONLY_ON_CREDIT', 'A supplier is only named when it is bought on credit', 400)
  if (!a.payFrom) throw new AppError('PAY_FROM_REQUIRED', 'Say how it is paid: cash, bank or credit', 400)
  if (a.payFrom === 'bank' && a.bankAccountId) await moneyAccountCode(prisma, tenantId, { method: 'bank_transfer', bankAccountId: a.bankAccountId })
  let supplierName: string | null = null
  if (a.payFrom === 'credit') supplierName = (await creditSupplierOf(tenantId, a.supplierId)).name
  return { plannedPaySource: a.payFrom, plannedBankAccountId: a.bankAccountId, supplierId: a.payFrom === 'credit' ? a.supplierId : null, supplierName }
}

/** A live, billable supplier of `tenantId` (422 SUPPLIER_REQUIRED / SUPPLIER_NOT_IN_COMPANY). */
async function creditSupplierOf(tenantId: string, supplierId: string | null | undefined): Promise<{ id: string; name: string }> {
  if (!supplierId) throw new AppError('SUPPLIER_REQUIRED', 'Pick the supplier this is bought on credit from', 422)
  const sup = await prisma.supplier.findFirst({ where: { id: supplierId, tenantId, deletedAt: null, systemKind: null }, select: { id: true, name: true } })
  if (!sup) throw new AppError('SUPPLIER_NOT_IN_COMPANY', 'That supplier is not one of this voucher\'s company\'s', 422)
  return sup
}

/**
 * The money of a voucher after an edit: `amountCents` is always the TOTAL
 * paid; `grossCents` the amount before discount (null when there is no
 * discount and none was given); total = gross − discount (CHECK
 * cash_vouchers_discount_chk). 400 AMOUNT_REQUIRED with nothing to go on;
 * 422 AMOUNT_MISMATCH when a sent total disagrees with gross − discount; 422
 * DISCOUNT_TOO_LARGE when nothing would be left to pay.
 */
export function voucherMoney(
  cur: { amountCents: number; grossCents: number | null; discountCents: number } | null,
  body: { amountCents?: number; grossCents?: number; discountCents?: number },
): { amountCents: number; grossCents: number | null; discountCents: number } {
  const discount = body.discountCents ?? cur?.discountCents ?? 0
  let gross: number | null
  let amount: number
  if (body.grossCents !== undefined) {
    gross = body.grossCents
    amount = gross - discount
    if (body.amountCents !== undefined && body.amountCents !== amount) {
      throw new AppError('AMOUNT_MISMATCH', `The total must be the gross less the discount (PKR ${(amount / 100).toFixed(2)})`, 422)
    }
  } else if (body.amountCents !== undefined) {
    amount = body.amountCents
    gross = discount > 0 ? amount + discount : null
  } else if (cur) {
    const base = cur.grossCents ?? cur.amountCents + cur.discountCents
    amount = base - discount
    gross = discount > 0 || cur.grossCents !== null ? base : null
  } else {
    throw new AppError('AMOUNT_REQUIRED', 'Say how much cash is needed', 400)
  }
  if (!(amount > 0)) throw new AppError('DISCOUNT_TOO_LARGE', 'The discount must be less than the amount', 422)
  if (gross !== null) assertInt4Fits(gross, 'The gross amount')
  assertInt4Fits(amount, 'The amount')
  return { amountCents: amount, grossCents: gross, discountCents: discount }
}

/** The voucher, or 404 when it is not one of the operator's companies'. */
export async function loadVoucher(req: FastifyRequest, id: string): Promise<VoucherRow> {
  const v = await prisma.cashVoucher.findFirst({
    where: { id, ...(await scopeTenantWhere(req, 'write')) },
    include: VOUCHER_INCLUDE,
  })
  if (!v) throw new NotFoundError('CashVoucher', id)
  return v
}

/** The voucher for a viewer who may open it (else 403 NOT_YOURS). */
export async function loadVisible(req: FastifyRequest, id: string): Promise<{ v: VoucherRow; viewer: Viewer }> {
  const v = await loadVoucher(req, id)
  const viewer = await viewerOf(req)
  if (!(await canSee(viewer, v))) {
    throw new AppError('NOT_YOURS', 'Only whoever raised or holds this voucher, the cashier who pays it, finance or a manager can open it', 403)
  }
  return { v, viewer }
}

const human = (s: CashVoucherStatus) => s.replace(/_/g, ' ')
export const wrongStatus = (code: string, v: { number: string; status: CashVoucherStatus }, needs: string) =>
  new AppError(code, `Cash request ${v.number} is ${human(v.status)} — ${needs}`, 409)

export function auditVoucher(req: FastifyRequest, step: string, v: { id: string; tenantId: string; number: string }, after: Record<string, unknown>, before?: Record<string, unknown>) {
  return audit({
    category: 'identity',
    action: `cash_voucher.${step}`,
    entity: 'CashVoucher',
    entityId: v.id,
    userId: req.staffUser!.id,
    userEmail: req.staffUser!.email,
    tenantId: v.tenantId,
    ...(before && { before }),
    after: { number: v.number, ...after },
    metadata: { ip: req.ip },
  })
}

// ─── The bell (owner, 2026-10-16) ───────────────────────────────────────────
// Hooks run in the ROUTES after the commit and after auditVoucher (a plain audit
// helper also used for update / cancel / pay) — never inside a transaction.

/** approval.decide + the "decided" notice to whoever is waiting on the voucher (queued; never fails the route). */
async function voucherDecided(
  req: FastifyRequest, type: 'cash_request_finance' | 'cash_voucher', v: { id: string; tenantId: string },
  decision: 'approve' | 'return' | 'reject' | 'cancel', at: Date, note?: string | null,
) {
  try {
    await auditApproval(req, {
      type, id: v.id, tenantId: v.tenantId, decision, grant: { via: 'role' }, entity: 'CashVoucher',
      metadata: { decidedAt: at.toISOString(), ...(note ? { reason: note } : {}) },
    })
  } catch (err) {
    console.warn(`[cash-vouchers] approval.decide not recorded: ${(err as Error).message}`)
  }
}

/** The queue a voucher waits in: finance's, or the CEO's. */
const queueTypeOf = (status: CashVoucherStatus): 'cash_request_finance' | 'cash_voucher' =>
  status === 'finance_approved' || status === 'hod_signed' || status === 'approved' ? 'cash_voucher' : 'cash_request_finance'

export type VoucherStep = 'approved' | 'paid' | 'sent_back' | 'verified'

/**
 * "Your step is next" for the people who are not approvers (kind task.next): the
 * box's custodian pays after the CEO's approval, the holder uploads documents
 * after the pay (and again after finance sends it back), the raiser and holder
 * hear it is booked. Queued; re-reads the voucher; never throws. Call after the
 * step has committed and been audited.
 */
export function voucherTaskNotice(step: VoucherStep, voucherId: string, actorId: string | null): void {
  queueStaffNotify(async () => {
    const v = await serviceClient.cashVoucher.findUnique({
      where: { id: voucherId },
      select: { id: true, tenantId: true, number: true, status: true, kind: true, preparedById: true, payeeUserId: true, boxId: true, returnCount: true, amountCents: true, bookedAtPay: true },
    })
    if (!v) return 0
    const wantStatus: Record<VoucherStep, CashVoucherStatus> = { approved: 'approved', paid: 'disbursed', sent_back: 'disbursed', verified: 'posted' }
    if (v.status !== wantStatus[step]) return 0
    const holder = v.payeeUserId ?? v.preparedById
    let userIds: string[] = []
    let title = ''
    let body: string | null = null
    let severity: NotifyInput['severity'] = 'info'
    let financeIds: string[] = []
    if (step === 'approved') {
      // Only finance pays (owner, 2026-10-16) — from a box, cash on hand or a bank.
      financeIds = await financePayersOf(v.tenantId)
      title = `Cash request ${v.number} is approved — ready to pay`
    } else if (step === 'paid') {
      userIds = v.kind === 'request' && v.payeeUserId ? [v.payeeUserId] : []
      title = `Cash request ${v.number} paid — upload the supporting documents`
      body = v.bookedAtPay
        ? 'Confirm you received the cash, then attach the receipts and bills under the voucher.'
        : 'Confirm you received the cash, then attach the receipts and record what was spent.'
    } else if (step === 'sent_back') {
      userIds = holder ? [holder] : []
      title = `Cash request ${v.number} sent back by finance`
      body = 'Attach the missing supporting document and send it again.'
      severity = 'warning'
    } else {
      userIds = [...new Set([v.preparedById, v.payeeUserId].filter((u): u is string => !!u))]
      title = v.bookedAtPay ? `Cash request ${v.number}: documents checked by finance` : `Cash request ${v.number} verified and booked`
      severity = 'success'
    }
    const row = (userId: string, words: string | null): NotifyInput => ({
      userId, tenantId: v.tenantId, kind: 'task.next', severity, title, body: words,
      link: `/finance/cash-vouchers?id=${encodeURIComponent(v.id)}`, entityType: 'cash_voucher', entityId: v.id, actorId,
      dedupeKey: `task.next:cash_voucher:${v.id}:${step}:r${v.returnCount}`,
    })
    const rows: NotifyInput[] = [
      ...userIds.filter((u) => u !== actorId).map((u) => row(u, body)),
      ...financeIds.filter((u) => u !== actorId).map((u) => row(u, 'The CEO approved it. Pay it from a petty-cash box, cash on hand or a bank account.')),
    ]
    return notifyStaffMany(rows)
  })
}

/**
 * Finance logins of `tenantId` who may pay a voucher from cash on hand or a bank (viewerOf's financeApprover
 * minus the CEO, who just approved it): role finance, active, a member of the company, holding the accounting
 * module (CASH_MODULE_GATE's rule).
 */
async function financePayersOf(tenantId: string): Promise<string[]> {
  const users = await serviceClient.user.findMany({
    where: {
      role: 'finance', isActive: true, accountStatus: 'active', deletedAt: null,
      OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }],
    },
    select: { id: true, role: true, moduleAllow: true, moduleDeny: true },
  })
  const out: string[] = []
  for (const u of users) {
    if ((await effectiveModulesForUser({ role: u.role, moduleAllow: u.moduleAllow, moduleDeny: u.moduleDeny })).has('accounting')) out.push(u.id)
  }
  return out
}

const selfApprove = () => new AppError('SELF_APPROVE', 'You raised or hold this voucher — someone else must decide it', 409)

/** NULL-safe "this column is not me" (Prisma's `not` leaves NULL rows out). */
const notMe = (field: 'financeApprovedById' | 'hodSignedById', me: string): Prisma.CashVoucherWhereInput =>
  ({ OR: [{ [field]: null }, { [field]: { not: me } }] })

const VIEWS = [
  // open: mine, not finished and not closed; closed: documents in (books pending) or booked; sent_back: finance sent it back.
  'open', 'closed', 'sent_back',
  'mine', 'finance', 'ceo', 'returned', 'to_pay', 'missing_docs', 'awaiting_verification', 'posted', 'all',
  // Kept working: hod (= finance), director (= ceo), and the legacy H3 views.
  'hod', 'director', 'receipts_due', 'overdue', 'settled', 'needs_review',
] as const

const PKT_OFFSET_MS = 5 * 3600_000
/** The Karachi day of `d`, 'YYYY-MM-DD'. */
function pktDay(d: Date): string {
  return new Date(d.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10)
}
/** 00:00 PKT on the first day of the current Karachi month. */
function pktMonthStart(now = new Date()): Date {
  const p = new Date(now.getTime() + PKT_OFFSET_MS)
  return new Date(Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), 1) - PKT_OFFSET_MS)
}

// ─── Routes (/trustops/cash-vouchers) ────────────────────────────────────────

export async function cashVoucherRoutes(fastify: FastifyInstance) {
  // GET / — the register, newest first; `cursor` = the last id of the previous
  // page (400 BAD_CURSOR when it is not in view). Read scope (the active
  // company, or every company in "All companies" view). Finance, the CEO and
  // cash keepers see every voucher; anyone else the ones they raised, hold,
  // or may pay (approved or later on a box they hold; approved with no box in
  // a company where they hold one). `view`:
  //   mine · finance (waiting for finance — finance approvers) · ceo (waiting
  //   for the CEO) · returned · to_pay (approved, mine to pay) · missing_docs
  //   (paid, no supporting document) · awaiting_verification (paid, documents
  //   in) · posted · all; kept: hod (= finance), director (= ceo),
  //   receipts_due, overdue, settled, needs_review.
  // Never the file bytes; each row carries the viewer's capability flags.
  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const viewer = await viewerOf(req)
    const q = z.object({
      view: z.enum(VIEWS).default('all'),
      status: z.nativeEnum(CashVoucherStatus).optional(),
      kind: z.enum(['request', 'expense']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().min(1).max(64).optional(),
    }).parse(req.query ?? {})
    const scope = await scopeTenantWhere(req, 'read')
    let after: Prisma.CashVoucherWhereInput = {}
    if (q.cursor) {
      const c = await prisma.cashVoucher.findFirst({ where: { id: q.cursor, ...scope }, select: { id: true, createdAt: true } })
      if (!c) throw new AppError('BAD_CURSOR', 'That page of cash requests is out of date — reload the list', 400)
      after = { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] }
    }
    const me = viewer.id
    const sees = viewer.keeper || viewer.financeApprover
    const none: Prisma.CashVoucherWhereInput = { id: { in: [] } }
    let view: Prisma.CashVoucherWhereInput = {}
    const needsDocStates = ['open', 'closed', 'sent_back', 'missing_docs', 'awaiting_verification', 'overdue'].includes(q.view)
    const ds = needsDocStates ? await paidDocStates() : { closedIds: [], sentBackIds: [] }
    const paidNew: Prisma.CashVoucherWhereInput = { status: 'disbursed', expenseOnVerify: true }
    switch (q.view) {
      case 'open': view = {
        OR: [{ preparedById: me }, { payeeUserId: me }],
        status: { notIn: ['posted', 'settled', 'converted', 'rejected', 'cancelled'] },
        id: { notIn: ds.closedIds },
      }; break
      case 'closed': view = { OR: [{ status: { in: ['posted', 'settled', 'converted'] } }, { id: { in: ds.closedIds } }] }; break
      case 'sent_back': view = { ...paidNew, id: { in: ds.sentBackIds } }; break
      case 'mine': view = { OR: [{ preparedById: me }, { payeeUserId: me }] }; break
      case 'hod':
      case 'finance': view = viewer.financeApprover ? { status: { in: WAIT_FINANCE } } : none; break
      case 'director':
      case 'ceo': view = { status: { in: WAIT_CEO } }; break
      case 'returned': view = { status: 'returned' }; break
      case 'to_pay': view = viewer.keeper ? { status: 'approved' } : {
        status: 'approved',
        OR: [{ boxId: { in: [...viewer.heldBoxIds] } }, { boxId: null, tenantId: { in: [...viewer.payBoxTenants] } }],
      }; break
      // Paid, not closed: no document yet, or finance sent it back.
      case 'missing_docs': view = { ...paidNew, id: { notIn: ds.closedIds } }; break
      // Closed — books pending: documents in, finance to check and book.
      case 'awaiting_verification': view = { ...paidNew, id: { in: ds.closedIds } }; break
      case 'posted': view = { status: 'posted' }; break
      case 'receipts_due': view = { status: 'disbursed', ...(sees ? {} : { payeeUserId: me }) }; break
      case 'overdue': view = { status: 'disbursed', dueBy: { lt: new Date() }, id: { notIn: ds.closedIds }, ...(sees ? {} : { OR: [{ payeeUserId: me }, { preparedById: me }] }) }; break
      case 'settled': view = { status: 'settled' }; break
      case 'needs_review': view = viewer.keeper ? { status: 'disbursed', payeeUserId: null, kind: 'request', expenseOnVerify: false } : none; break
      case 'all': break
    }
    const rows = await prisma.cashVoucher.findMany({
      where: {
        AND: [
          scope,
          visibleWhere(viewer),
          view,
          after,
          q.status ? { status: q.status } : {},
          q.kind ? { kind: q.kind } : {},
        ],
      },
      include: VOUCHER_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    })
    const page = rows.slice(0, q.limit)
    return {
      items: await present(page, viewer),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
      keeper: viewer.keeper,
      financeApprover: viewer.financeApprover,
    }
  })

  // GET /dashboard — counts and PKR totals in read scope: finance, the CEO and
  // cash keepers see the company's; anyone else only the vouchers they raised
  // or hold. Each bucket is { count, cents }:
  //   waitingFinance (submitted + legacy draft) · waitingCeo (finance_approved
  //   + legacy hod_signed) · returned · approvedUnpaid · missingDocs (paid, no
  //   supporting document) · awaitingVerification (paid, documents in) ·
  //   docsOverdue (paid, documents due date passed, not closed) ·
  //   sentBack (finance sent it back after the documents came in) ·
  //   postedThisMonth (verified and booked this Karachi month).
  // missingDocs counts every paid voucher that is not CLOSED (no document, or
  // sent back); awaitingVerification every closed one whose books are pending.
  // GET /raise-options — what a finance payee voucher may name (owner, 2026-10-19), in the ACTIVE company: its
  // active, non-pooled fixed-asset classes and outlets (equipment instead of an expense account), and its live
  // suppliers ("To pay from: Credit"). Finance approvers only (403).
  fastify.get('/raise-options', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const viewer = await viewerOf(req)
    if (!viewer.financeApprover) throw new AppError('ASSET_FINANCE_ONLY', 'Only finance raises a payee voucher', 403)
    const tenantId = activeTenantId(req, 'a voucher belongs to one company')
    const [classes, locations, suppliers] = await Promise.all([
      getAssetClasses(tenantId, prisma),
      equipmentLocationsOf(prisma, tenantId),
      prisma.supplier.findMany({ where: { tenantId, deletedAt: null, systemKind: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ])
    return {
      tenantId,
      classes: classes.filter((c) => c.isActive && !c.pooled).map((c) => ({ id: c.id, key: c.key, label: c.label, costAccountCode: c.costAccountCode })),
      locations,
      suppliers,
    }
  })

  fastify.get('/dashboard', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const viewer = await viewerOf(req)
    const scope = await scopeTenantWhere(req, 'read')
    const company = viewer.keeper || viewer.financeApprover
    const base: Prisma.CashVoucherWhereInput = {
      AND: [scope, company ? {} : { OR: [{ preparedById: viewer.id }, { payeeUserId: viewer.id }] }],
    }
    const now = new Date()
    const bucket = async (where: Prisma.CashVoucherWhereInput) => {
      const r = await prisma.cashVoucher.aggregate({ where: { AND: [base, where] }, _count: { _all: true }, _sum: { amountCents: true } })
      return { count: r._count._all, cents: r._sum.amountCents ?? 0 }
    }
    const paidNew: Prisma.CashVoucherWhereInput = { status: 'disbursed', expenseOnVerify: true }
    const ds = await paidDocStates()
    const [waitingFinance, waitingCeo, returned, approvedUnpaid, missingDocs, awaitingVerification, docsOverdue, sentBack, postedThisMonth] = await Promise.all([
      bucket({ status: { in: WAIT_FINANCE } }),
      bucket({ status: { in: WAIT_CEO } }),
      bucket({ status: 'returned' }),
      bucket({ status: 'approved' }),
      bucket({ ...paidNew, id: { notIn: ds.closedIds } }),
      bucket({ ...paidNew, id: { in: ds.closedIds } }),
      bucket({ ...paidNew, dueBy: { lt: now }, id: { notIn: ds.closedIds } }),
      bucket({ ...paidNew, id: { in: ds.sentBackIds } }),
      bucket({ status: 'posted', postedAt: { gte: pktMonthStart(now) } }),
    ])
    return {
      scope: company ? 'company' : 'mine',
      waitingFinance, waitingCeo, returned, approvedUnpaid, missingDocs, awaitingVerification, docsOverdue, sentBack, postedThisMonth,
    }
  })

  // GET /:id — one voucher in full (the print view reads this).
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { v, viewer } = await loadVisible(req, req.params.id)
    return detailOf(v.id, viewer)
  })

  // GET /:id/history — the voucher's audit trail (every cash_voucher.* step),
  // oldest first, with the actor's name. Whoever may open the voucher.
  fastify.get<{ Params: { id: string } }>('/:id/history', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { v } = await loadVisible(req, req.params.id)
    const rows = await prisma.auditLog.findMany({
      where: { entity: 'CashVoucher', entityId: v.id, tenantId: v.tenantId, action: { startsWith: 'cash_voucher.' } },
      select: { id: true, action: true, userId: true, userEmail: true, before: true, after: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
    })
    const ids = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))]
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []
    const nameOf = new Map(users.map((u) => [u.id, u.name]))
    return {
      items: rows.map((r) => ({
        id: r.id,
        action: r.action.replace(/^cash_voucher\./, ''),
        at: r.createdAt,
        userId: r.userId,
        userName: r.userId ? (nameOf.get(r.userId) ?? r.userEmail ?? null) : null,
        before: r.before,
        after: r.after,
      })),
    }
  })

  // GET /:id/attachments/:aid — a supporting document, a receipt, or a legacy
  // signed-voucher photo (private, no-store, nosniff; images and PDFs inline,
  // Office / text files as a download) — for whoever may open the voucher.
  fastify.get<{ Params: { id: string; aid: string } }>('/:id/attachments/:aid', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const { v } = await loadVisible(req, req.params.id)
    const file = await prisma.cashVoucherAttachment.findFirst({
      where: { id: req.params.aid, voucherId: v.id, tenantId: v.tenantId },
      select: { mime: true, data: true, kind: true, fileName: true },
    })
    if (!file) throw new NotFoundError('Attachment', req.params.aid)
    const label = file.kind === 'supporting' ? (file.fileName ?? 'document') : file.kind === 'receipt' ? 'receipt' : 'signed'
    return sendEvidence(reply, file, `${v.number}-${label}-${req.params.aid.slice(0, 6)}`)
  })

  // POST / — raise a voucher in the ACTIVE company. Touches no cash.
  //   kind 'request' (default): any login; the holder is the raiser unless
  //     named; status 'submitted' (waiting for finance).
  //   kind 'expense': finance approvers only (403 EXPENSE_VOUCHER_FINANCE_ONLY);
  //     payeeName (the outside payee) required, no holder; grossCents +
  //     discountCents (or amountCents); status 'finance_approved' (to the CEO)
  //     unless sendTo 'finance' or the CEO raised it ('submitted').
  //   A discount (grossCents / discountCents) is finance's only (403).
  fastify.post('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = CreateBody.parse(req.body)
    const tenantId = activeTenantId(req, 'a cash request belongs to one company')
    const viewer = await viewerOf(req)
    const keeper = viewer.keeper
    const me = viewer.id
    if (body.kind === 'expense' && !viewer.financeApprover) {
      throw new AppError('EXPENSE_VOUCHER_FINANCE_ONLY', 'Only finance raises a voucher for an outside payee — ask for cash for yourself instead', 403)
    }
    if ((body.grossCents !== undefined || (body.discountCents ?? 0) > 0) && !viewer.financeApprover) {
      throw new AppError('DISCOUNT_FINANCE_ONLY', 'Only finance sets a discount — send the amount you need', 403)
    }
    if (body.boxId && !keeper) {
      throw new AppError('BOX_PICK_KEEPERS_ONLY', 'Only finance or a manager picks the cash box — the cashier picks it when paying', 403)
    }
    if (body.boxId) await openBoxOf(tenantId, body.boxId)
    if (body.conceptId) {
      const concept = await assertConceptOwned(req, body.conceptId, 'create')
      if (concept.tenantId !== tenantId) throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand belongs to another company', 422)
    }
    let holder: { id: string; name: string } | null = null
    let payeeName: string
    if (body.kind === 'expense') {
      if (!body.payeeName) throw new AppError('PAYEE_REQUIRED', 'Name who is paid (the vendor or person)', 400)
      if (body.holderUserId) holder = await holderOf(tenantId, body.holderUserId)
      payeeName = body.payeeName
    } else {
      holder = await holderOf(tenantId, body.holderUserId ?? me)
      payeeName = body.payeeName ?? holder.name.slice(0, 120)
    }
    const money = voucherMoney(null, body)
    // Equipment (owner, 2026-10-19): a fixed-asset class instead of an expense account — finance's payee voucher only.
    if (body.assetClassId && (body.categoryKey || body.accountCode)) {
      throw new AppError('ASSET_OR_EXPENSE', 'Pick an expense account OR a fixed-asset class, not both', 400)
    }
    const assetCls = await assetTargetOf(prisma, tenantId, {
      kind: body.kind, assetClassId: body.assetClassId ?? null, assetLocationId: body.assetLocationId ?? null, conceptId: body.conceptId ?? null,
    })
    const category = assetCls ? null : await categoryOf(tenantId, body, keeper)
    const plannedCls = plannedClassificationOf(viewer, body)
    const plan = await payPlanOf(tenantId, {
      kind: body.kind, payFrom: body.payFrom ?? null, bankAccountId: body.payFromBankAccountId ?? null, supplierId: body.supplierId ?? null,
    })
    const now = new Date()
    const toCeo = body.kind === 'expense' && body.sendTo !== 'finance' && !viewer.isAdmin
    const created = await prisma.$transaction(async (tx) => {
      // Numbers are per company and gap-free under concurrency: one writer
      // per company takes the next number.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext('cash-voucher-seq'))`
      const max = await tx.cashVoucher.aggregate({ where: { tenantId }, _max: { seq: true } })
      const seq = (max._max.seq ?? 0) + 1
      return tx.cashVoucher.create({
        data: {
          tenantId,
          seq,
          number: voucherNumber(seq),
          kind: body.kind,
          voucherDate: body.voucherDate ?? now,
          payeeName,
          payeeUserId: holder?.id ?? null,
          purpose: body.purpose,
          category,
          assetClassId: assetCls?.id ?? null,
          assetLocationId: assetCls ? (body.assetLocationId ?? null) : null,
          plannedPaySource: plan.plannedPaySource,
          plannedBankAccountId: plan.plannedBankAccountId,
          supplierId: plan.supplierId,
          ...(plannedCls ?? {}),
          conceptId: body.conceptId ?? null,
          department: body.department ?? null,
          amountCents: money.amountCents,
          grossCents: money.grossCents,
          discountCents: money.discountCents,
          boxId: body.boxId ?? null,
          status: toCeo ? 'finance_approved' : 'submitted',
          preparedById: me,
          submittedById: me,
          submittedAt: now,
          ...(toCeo && { financeApprovedById: me, financeApprovedAt: now }),
        },
        select: { id: true, tenantId: true, number: true, status: true },
      })
    })
    await auditVoucher(req, 'create', created, {
      kind: body.kind, status: created.status, ...money, holderUserId: holder?.id ?? null, payeeName, purpose: body.purpose, category, boxId: body.boxId ?? null,
      ...(assetCls && { assetClassId: assetCls.id, assetClassKey: assetCls.key, assetLocationId: body.assetLocationId ?? null }),
      ...(plan.plannedPaySource && { payFrom: plan.plannedPaySource, payFromBankAccountId: plan.plannedBankAccountId, supplierId: plan.supplierId }),
      ...(plannedCls?.plannedClassification && { classification: plannedCls.plannedClassification, taxStatus: plannedCls.plannedTaxStatus }),
    })
    // The bell (queued): finance's queue, or straight to the CEO for a finance-raised payee voucher.
    approvalWaiting(queueTypeOf(created.status), created.id, { round: 'r0', actorId: me })
    return reply.status(201).send(await detailOf(created.id, viewer))
  })

  // PATCH /:id — edit:
  //   • waiting for finance or returned: whoever raised it or a keeper (the
  //     box and an explicit account: keepers only; the discount: finance);
  //   • waiting for the CEO: finance may still change the account, discount,
  //     brand, department and box; a keeper the account and the box;
  //   • approved: a keeper may still change the account and the box (until
  //     it is paid);
  //   • a request with no holder (legacy): a keeper names the holder — the one
  //     edit allowed after payment (audited).
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = PatchBody.parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    const keeper = viewer.keeper
    const raiser = v.preparedById === viewer.id
    const sent = (Object.keys(body) as Array<keyof PatchInput>).filter((k) => body[k] !== undefined)
    const onlyHolder = sent.length === 1 && sent[0] === 'holderUserId'
    const categoryOrBox = sent.every((k) => ['categoryKey', 'accountCode', 'boxId', 'assetClassId', 'assetLocationId'].includes(k))
    const financeFields = sent.every((k) => ['categoryKey', 'accountCode', 'boxId', 'discountCents', 'grossCents', 'conceptId', 'department', 'assetClassId', 'assetLocationId', 'payFrom', 'payFromBankAccountId', 'supplierId'].includes(k))
    const wantsDiscount = body.discountCents !== undefined || body.grossCents !== undefined
    const heldFix = v.status === 'disbursed' && v.expenseOnVerify && !v.bookedAtPay && !v.postedAt && sent.length > 0
      && sent.every((k) => k === 'categoryKey' || k === 'accountCode')

    if (EDITABLE.includes(v.status)) {
      if (!raiser && !keeper && !viewer.financeApprover) throw new ForbiddenError('Only whoever raised this voucher, finance or a manager can edit it')
    } else if (onlyHolder && !v.payeeUserId && v.kind === 'request' && (WAIT_CEO.includes(v.status) || v.status === 'approved' || (v.status === 'disbursed' && !v.expenseOnVerify))) {
      if (!keeper) throw new ForbiddenError('Only finance or a manager can name who holds this cash')
    } else if (WAIT_CEO.includes(v.status) && financeFields) {
      // finance (any of these fields) or a keeper (account / box)
      if (!viewer.financeApprover && !(keeper && categoryOrBox)) {
        throw new ForbiddenError('Only finance can change this voucher once finance has approved it (a manager may change the account or the box)')
      }
    } else if (categoryOrBox && v.status === 'approved') {
      if (!keeper) throw new ForbiddenError('Only finance or a manager can change the category or the box once it is approved')
    } else if (heldFix) {
      // A voucher still held on 1357 (paid under the 2026-10-15 hold flow) whose conversion was refused for its
      // category (voucherHoldConversion.ts): finance sets the expense account, then checks the documents — that
      // books it as one entry. Books nothing itself. Never on finance's own voucher.
      if (!viewer.financeApprover) throw new ForbiddenError('Only finance sets the expense account of a paid voucher still awaiting booking')
      if (isOwn(viewer, v)) throw selfApprove()
    } else {
      throw wrongStatus('VOUCHER_NOT_DRAFT', v, 'only a voucher waiting for finance, or returned, can be edited (finance may change the account until it is paid)')
    }
    if (body.boxId !== undefined && !keeper) {
      throw new AppError('BOX_PICK_KEEPERS_ONLY', 'Only finance or a manager picks the cash box — the cashier picks it when paying', 403)
    }
    if (wantsDiscount && !viewer.financeApprover) throw new AppError('DISCOUNT_FINANCE_ONLY', 'Only finance sets a discount', 403)
    const touchesAsset = body.assetClassId !== undefined || body.assetLocationId !== undefined
    if (touchesAsset && !viewer.financeApprover) {
      throw new AppError('ASSET_FINANCE_ONLY', 'Only finance names a fixed-asset class on a voucher', 403)
    }
    const touchesPlan = body.payFrom !== undefined || body.payFromBankAccountId !== undefined || body.supplierId !== undefined
    if (touchesPlan && !viewer.financeApprover) throw new AppError('PAY_FROM_FINANCE_ONLY', 'Only finance sets how a voucher is paid', 403)
    // Once finance has approved it, the money is never changed by whoever raised or holds it (separation of duties).
    if (!EDITABLE.includes(v.status) && (wantsDiscount || body.amountCents !== undefined) && isOwn(viewer, v)) throw selfApprove()

    const data: Prisma.CashVoucherUncheckedUpdateManyInput = {}
    if (body.boxId) await openBoxOf(v.tenantId, body.boxId)
    if (body.boxId !== undefined) data.boxId = body.boxId
    if (body.conceptId) {
      const concept = await assertConceptOwned(req, body.conceptId, 'write')
      if (concept.tenantId !== v.tenantId) throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand belongs to another company', 422)
    }
    if (body.holderUserId !== undefined) {
      const holder = await holderOf(v.tenantId, body.holderUserId)
      data.payeeUserId = holder.id
      if (body.payeeName === undefined && EDITABLE.includes(v.status) && v.kind === 'request') data.payeeName = holder.name.slice(0, 120)
    }
    // Equipment (owner, 2026-10-19): a fixed-asset class replaces the expense account and the other way round.
    const touchesCategory = !!(body.categoryKey || body.accountCode)
    if (body.assetClassId && touchesCategory) throw new AppError('ASSET_OR_EXPENSE', 'Pick an expense account OR a fixed-asset class, not both', 400)
    const effClass = body.assetClassId !== undefined ? body.assetClassId : (touchesCategory ? null : v.assetClassId)
    const effLoc = body.assetLocationId !== undefined ? body.assetLocationId : (effClass ? v.assetLocationId : null)
    if (touchesAsset || touchesCategory || (body.conceptId !== undefined && v.assetClassId)) {
      const cls = await assetTargetOf(prisma, v.tenantId, {
        kind: v.kind, assetClassId: effClass, assetLocationId: effLoc, conceptId: body.conceptId !== undefined ? body.conceptId : v.conceptId,
      })
      data.assetClassId = cls?.id ?? null
      data.assetLocationId = cls ? effLoc : null
      if (cls) data.category = null
    }
    if ((body.categoryKey !== undefined || body.accountCode !== undefined) && !data.assetClassId) data.category = await categoryOf(v.tenantId, body, keeper)
    if (touchesPlan) {
      const payFrom = body.payFrom !== undefined ? body.payFrom : v.plannedPaySource
      const plan = await payPlanOf(v.tenantId, {
        kind: v.kind, payFrom,
        bankAccountId: body.payFromBankAccountId !== undefined ? body.payFromBankAccountId : (payFrom === 'bank' ? v.plannedBankAccountId : null),
        supplierId: body.supplierId !== undefined ? body.supplierId : (payFrom === 'credit' ? v.supplierId : null),
      })
      data.plannedPaySource = plan.plannedPaySource
      data.plannedBankAccountId = plan.plannedBankAccountId
      data.supplierId = plan.supplierId
    }
    const plannedCls = plannedClassificationOf(viewer, body)
    if (plannedCls) Object.assign(data, plannedCls)
    if (body.voucherDate !== undefined) data.voucherDate = body.voucherDate
    if (body.payeeName !== undefined) data.payeeName = body.payeeName
    if (body.purpose !== undefined) data.purpose = body.purpose
    if (body.conceptId !== undefined) data.conceptId = body.conceptId
    if (body.department !== undefined) data.department = body.department
    if (body.amountCents !== undefined || wantsDiscount) {
      const m = voucherMoney(v, body)
      data.amountCents = m.amountCents
      data.grossCents = m.grossCents
      data.discountCents = m.discountCents
    }
    // Conditional on the state read: an approval or a pay racing this edit
    // wins, and the edit is refused.
    const res = await prisma.cashVoucher.updateMany({
      where: {
        id: v.id, status: v.status, amountCents: v.amountCents, discountCents: v.discountCents,
        ...(onlyHolder && !EDITABLE.includes(v.status) ? { payeeUserId: null } : {}),
        // A held voucher's account only while it is still held (the conversion claims bookedAtPay under the row lock).
        ...(heldFix ? { bookedAtPay: false, postedAt: null } : {}),
      },
      data,
    })
    if (res.count === 0) throw new AppError('VOUCHER_CHANGED', `Cash request ${v.number} was changed by someone else — reload it`, 409)
    const before = Object.fromEntries(Object.keys(data).map((k) => [k, v[k as keyof VoucherRow]]))
    await auditVoucher(req, onlyHolder && !EDITABLE.includes(v.status) ? 'name_holder' : 'update', v, { ...data }, before)
    return detailOf(v.id, viewer)
  })

  // POST /:id/finance-approve { categoryKey?, accountCode?, discountCents?,
  // grossCents?, conceptId?, department?, note? } — a finance approver (role
  // finance with the accounting module, or the CEO) approves a voucher
  // waiting for finance (submitted, or a legacy draft) → finance_approved;
  // never their own (409 SELF_APPROVE). The voucher must name a usable
  // expense account by now (422 / 400 from the category check). Changes made
  // in the same call are audited before / after.
  fastify.post<{ Params: { id: string } }>('/:id/finance-approve', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = z.object({
      categoryKey: fields.categoryKey,
      accountCode: fields.accountCode,
      discountCents: fields.discountCents,
      grossCents: fields.grossCents,
      conceptId: fields.conceptId,
      department: fields.department,
      assetClassId: fields.assetClassId,
      assetLocationId: fields.assetLocationId,
      note: z.string().trim().max(500).optional(),
    }).parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (!viewer.financeApprover) throw new AppError('NOT_FINANCE', 'Only finance approves a cash voucher at this step', 403)
    if (!WAIT_FINANCE.includes(v.status)) throw wrongStatus('VOUCHER_NOT_SUBMITTED', v, 'finance approves a voucher waiting for finance')
    if (isOwn(viewer, v)) throw selfApprove()
    const data: Prisma.CashVoucherUncheckedUpdateManyInput = {}
    if (body.conceptId) {
      const concept = await assertConceptOwned(req, body.conceptId, 'write')
      if (concept.tenantId !== v.tenantId) throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand belongs to another company', 422)
    }
    if (body.conceptId !== undefined) data.conceptId = body.conceptId
    if (body.department !== undefined) data.department = body.department
    // Equipment (owner, 2026-10-19): a fixed-asset class (checked in the voucher's company) instead of an account.
    const sentCategory = !!(body.categoryKey || body.accountCode)
    if (body.assetClassId && sentCategory) throw new AppError('ASSET_OR_EXPENSE', 'Pick an expense account OR a fixed-asset class, not both', 400)
    const effClass = body.assetClassId !== undefined ? body.assetClassId : (sentCategory ? null : v.assetClassId)
    const effLoc = body.assetLocationId !== undefined ? body.assetLocationId : (effClass ? v.assetLocationId : null)
    const assetCls = await assetTargetOf(prisma, v.tenantId, {
      kind: v.kind, assetClassId: effClass, assetLocationId: effLoc, conceptId: body.conceptId !== undefined ? body.conceptId : v.conceptId,
    })
    if (assetCls) {
      if (assetCls.id !== v.assetClassId) data.assetClassId = assetCls.id
      if (effLoc !== v.assetLocationId) data.assetLocationId = effLoc
      if (v.category !== null) data.category = null
    } else {
      if (v.assetClassId) { data.assetClassId = null; data.assetLocationId = null }
      // The account: the one sent, else the stored one — it must resolve now.
      const ref = body.categoryKey !== undefined || body.accountCode !== undefined
        ? { categoryKey: body.categoryKey, accountCode: body.accountCode }
        : categoryRefOf(v.category)
      const category = await categoryOf(v.tenantId, ref, true)
      if (category !== v.category) data.category = category
    }
    if (body.discountCents !== undefined || body.grossCents !== undefined) {
      const m = voucherMoney(v, body)
      data.amountCents = m.amountCents
      data.grossCents = m.grossCents
      data.discountCents = m.discountCents
    }
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, tenantId: v.tenantId, status: v.status, amountCents: v.amountCents, discountCents: v.discountCents },
      data: { ...data, status: 'finance_approved', financeApprovedById: viewer.id, financeApprovedAt: now },
    })
    if (res.count === 0) throw new AppError('VOUCHER_CHANGED', `Cash request ${v.number} was changed by someone else — reload it`, 409)
    const before = Object.fromEntries(Object.keys(data).map((k) => [k, v[k as keyof VoucherRow]]))
    await auditVoucher(req, 'finance_approve', v, { status: 'finance_approved', financeApprovedAt: now.toISOString(), ...data, ...(body.note && { note: body.note }) },
      { status: v.status, ...before })
    await voucherDecided(req, 'cash_request_finance', v, 'approve', now, body.note)
    // The bell: now waiting at the CEO's end.
    approvalWaiting('cash_voucher', v.id, { round: `r${v.returnCount}`, actorId: viewer.id })
    return detailOf(v.id, viewer)
  })

  // POST /:id/approve — the CEO's final approval. finance_approved (or a
  // legacy hod_signed) → approved; directorSignedById/At = approver + date.
  // Never the raiser / holder (409 SELF_APPROVE), never the login that gave
  // the finance approval or a legacy HOD signature (409 SAME_SIGNER).
  fastify.post<{ Params: { id: string } }>('/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    // The amount the CEO saw (inbox / detail screen). A finance edit after the screen loaded → 409, never a silent
    // approval of a different amount. Omitted = the amount read here, still pinned in the claim below.
    const seen = z.object({ amountCents: z.number().int().optional() }).parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const me = req.staffUser!.id
    if (!WAIT_CEO.includes(v.status)) throw wrongStatus('VOUCHER_NOT_FINANCE_APPROVED', v, 'the CEO approves after finance')
    if (seen.amountCents !== undefined && seen.amountCents !== v.amountCents) {
      throw new AppError('AMOUNT_CHANGED', `Cash request ${v.number} now pays ${v.amountCents / 100} — reload it and approve again`, 409)
    }
    if (v.preparedById === me || v.payeeUserId === me) throw selfApprove()
    if (v.financeApprovedById === me || v.hodSignedById === me) {
      throw new AppError('SAME_SIGNER', 'You gave the first approval on this voucher — a different person must give the final approval', 409)
    }
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { AND: [{ id: v.id, status: v.status, amountCents: v.amountCents, discountCents: v.discountCents }, notMe('financeApprovedById', me), notMe('hodSignedById', me)] },
      data: { status: 'approved', directorSignedById: me, directorSignedAt: now },
    })
    if (res.count === 0) throw new AppError('VOUCHER_NOT_FINANCE_APPROVED', `Cash request ${v.number} was changed by someone else — reload it`, 409)
    await auditVoucher(req, 'approve', v, { status: 'approved', directorSignedAt: now.toISOString() }, { status: v.status })
    await voucherDecided(req, 'cash_voucher', v, 'approve', now)
    voucherTaskNotice('approved', v.id, me)
    return detailOf(v.id, await viewerOf(req))
  })

  // POST /:id/return {note} — sent back for correction: finance from
  // submitted (or a legacy draft), the CEO from finance_approved / hod_signed.
  // → returned (returnedById/At, returnNote, returnCount + 1). Never on one's
  // own voucher (409 SELF_APPROVE).
  fastify.post<{ Params: { id: string } }>('/:id/return', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { note } = NoteBody.parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (WAIT_FINANCE.includes(v.status)) {
      if (!viewer.financeApprover) throw new AppError('NOT_FINANCE', 'Only finance returns a voucher waiting for finance', 403)
    } else if (WAIT_CEO.includes(v.status)) {
      if (!viewer.isAdmin) throw new ForbiddenError('Only the CEO returns a voucher waiting for the final approval')
    } else {
      throw wrongStatus('VOUCHER_NOT_RETURNABLE', v, 'only a voucher waiting for finance or the CEO can be returned for correction')
    }
    if (isOwn(viewer, v)) throw selfApprove()
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, tenantId: v.tenantId, status: v.status },
      data: { status: 'returned', returnedById: viewer.id, returnedAt: now, returnNote: note, returnCount: { increment: 1 } },
    })
    if (res.count === 0) throw new AppError('VOUCHER_CHANGED', `Cash request ${v.number} was changed by someone else — reload it`, 409)
    await auditVoucher(req, 'return', v, { status: 'returned', note }, { status: v.status })
    await voucherDecided(req, queueTypeOf(v.status), v, 'return', now, note)
    return detailOf(v.id, viewer)
  })

  // POST /:id/resubmit — the raiser sends a returned voucher again → submitted
  // (finance looks again). A finance-raised payee voucher resubmitted by a
  // finance person (not the CEO) → finance_approved (back to the CEO).
  fastify.post<{ Params: { id: string } }>('/:id/resubmit', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (v.status !== 'returned') throw wrongStatus('VOUCHER_NOT_RETURNED', v, 'only a returned voucher is resubmitted')
    const financeOwnsIt = v.kind === 'expense' && viewer.financeApprover
    if (v.preparedById !== viewer.id && !financeOwnsIt) {
      throw new ForbiddenError('Only whoever raised this voucher (or finance, for a payee voucher) can resubmit it')
    }
    const toCeo = v.kind === 'expense' && viewer.financeApprover && !viewer.isAdmin
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, tenantId: v.tenantId, status: 'returned' },
      data: toCeo
        ? { status: 'finance_approved', submittedById: viewer.id, submittedAt: now, financeApprovedById: viewer.id, financeApprovedAt: now }
        : { status: 'submitted', submittedById: viewer.id, submittedAt: now, financeApprovedById: null, financeApprovedAt: null },
    })
    if (res.count === 0) throw new AppError('VOUCHER_CHANGED', `Cash request ${v.number} was changed by someone else — reload it`, 409)
    await auditVoucher(req, 'resubmit', v, { status: toCeo ? 'finance_approved' : 'submitted' }, { status: v.status })
    // The bell (queued): back to the CEO (finance-raised payee voucher) or to finance. New round per return.
    approvalWaiting(toCeo ? 'cash_voucher' : 'cash_request_finance', v.id, { round: `r${v.returnCount}`, actorId: viewer.id })
    return detailOf(v.id, viewer)
  })

  // POST /:id/sign-hod — retired with the HOD step (2026-10-15): 410.
  fastify.post<{ Params: { id: string } }>('/:id/sign-hod', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    await loadVoucher(req, req.params.id)
    throw new AppError('HOD_STEP_RETIRED', 'Cash vouchers no longer need an HOD signature — finance approves them (POST /:id/finance-approve)', 410)
  })

  // POST /:id/reject {note} — finance refuses a voucher waiting for finance,
  // the CEO one waiting for the final approval; finance or the CEO may also
  // reject a returned one. → rejected. Never one's own (409 SELF_APPROVE).
  fastify.post<{ Params: { id: string } }>('/:id/reject', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { note } = NoteBody.parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (WAIT_FINANCE.includes(v.status)) {
      if (!viewer.financeApprover) throw new AppError('NOT_FINANCE', 'Only finance can reject a voucher waiting for finance', 403)
    } else if (WAIT_CEO.includes(v.status)) {
      if (!viewer.isAdmin) throw new ForbiddenError('Only the CEO can reject a voucher finance has approved')
    } else if (v.status === 'returned') {
      if (!viewer.financeApprover) throw new AppError('NOT_FINANCE', 'Only finance or the CEO can reject a returned voucher', 403)
    } else {
      throw wrongStatus('VOUCHER_NOT_REJECTABLE', v, 'only a voucher not yet approved by the CEO can be rejected')
    }
    if (isOwn(viewer, v)) throw selfApprove()
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, tenantId: v.tenantId, status: v.status },
      data: { status: 'rejected', rejectedById: viewer.id, rejectedAt: now, rejectNote: note },
    })
    if (res.count === 0) throw new AppError('VOUCHER_CHANGED', `Cash request ${v.number} was changed by someone else — reload it`, 409)
    await auditVoucher(req, 'reject', v, { status: 'rejected', note }, { status: v.status })
    await voucherDecided(req, queueTypeOf(v.status), v, 'reject', now, note)
    return detailOf(v.id, viewer)
  })

  // POST /:id/cancel {note} — withdrawn before payment: whoever raised it
  // (waiting for finance, or returned) or a keeper (any status before pay).
  fastify.post<{ Params: { id: string } }>('/:id/cancel', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { note } = NoteBody.parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    const cancellable: CashVoucherStatus[] = viewer.keeper ? PRE_PAY : v.preparedById === viewer.id ? EDITABLE : []
    if (cancellable.length === 0) throw new ForbiddenError('Only whoever raised this voucher (before finance approves it), finance or a manager can cancel it')
    if (!PRE_PAY.includes(v.status)) throw wrongStatus('VOUCHER_NOT_CANCELLABLE', v, 'only a voucher not yet paid can be cancelled')
    if (!cancellable.includes(v.status)) throw new ForbiddenError('Once finance has approved it, only finance or a manager can cancel it')
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, status: { in: cancellable } },
      data: { status: 'cancelled', cancelledById: viewer.id, cancelledAt: now, cancelNote: note },
    })
    if (res.count === 0) throw new AppError('VOUCHER_NOT_CANCELLABLE', `Cash request ${v.number} was paid or changed by someone else — reload it`, 409)
    await auditVoucher(req, 'cancel', v, { status: 'cancelled', note }, { status: v.status })
    // A raiser withdrawing their own voucher is not an approval decision: only a keeper's cancel is.
    if (v.preparedById !== viewer.id) await voucherDecided(req, queueTypeOf(v.status), v, 'cancel', now, note)
    return detailOf(v.id, viewer)
  })

  // POST /:id/send-back {note} — finance (a finance approver, or the CEO)
  // sends a CLOSED voucher (paid under the 2026-10-15 flow, documents in,
  // books pending) back to the requester: returnedById/At, returnNote,
  // returnCount + 1; the status stays 'disbursed'. It shows open again
  // ("Finance sent it back: <note>") until another supporting document is
  // attached. Never a booked voucher (409 VOUCHER_POSTED), never one that is
  // not closed (409 VOUCHER_NOT_CLOSED), never one's own (409 SELF_APPROVE).
  // Audited (cash_voucher.send_back).
  fastify.post<{ Params: { id: string } }>('/:id/send-back', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { note } = NoteBody.parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (!viewer.financeApprover) throw new AppError('NOT_FINANCE', 'Only finance (or the CEO) sends a voucher back for its documents', 403)
    if (v.status === 'posted' || v.postedAt) {
      throw new AppError('VOUCHER_POSTED', `Cash voucher ${v.number} is verified and booked — it cannot be sent back`, 409)
    }
    if (v.status !== 'disbursed' || !v.expenseOnVerify) {
      throw wrongStatus('VOUCHER_NOT_CLOSED', v, 'only a paid voucher whose documents are in can be sent back')
    }
    if (isOwn(viewer, v)) throw selfApprove()
    const now = new Date()
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM cash_vouchers WHERE id = ${v.id} FOR UPDATE`
      const cur = await tx.cashVoucher.findUniqueOrThrow({
        where: { id: v.id },
        select: {
          status: true, number: true, postedAt: true, expenseOnVerify: true, disbursedAt: true, returnedAt: true,
          attachments: { where: { kind: 'supporting' }, select: { kind: true, createdAt: true } },
        },
      })
      if (cur.status === 'posted' || cur.postedAt) throw new AppError('VOUCHER_POSTED', `Cash voucher ${cur.number} is verified and booked — it cannot be sent back`, 409)
      if (!closedStateOf(cur).closed) {
        throw new AppError('VOUCHER_NOT_CLOSED', `Cash voucher ${cur.number} has no new supporting document since it was sent back — nothing to send back`, 409)
      }
      await tx.cashVoucher.update({
        where: { id: v.id },
        data: { returnedById: viewer.id, returnedAt: now, returnNote: note, returnCount: { increment: 1 } },
      })
    })
    await auditVoucher(req, 'send_back', v, { note, returnedAt: now.toISOString() }, { returnedAt: v.returnedAt?.toISOString() ?? null, returnNote: v.returnNote })
    voucherTaskNotice('sent_back', v.id, viewer.id)
    return detailOf(v.id, viewer)
  })

  // POST /:id/confirm-received — the holder confirms "Cash received" (owner, 2026-10-15: the whole process is
  // digital, no signatures). Only the holder of a paid request; once (409 ALREADY_CONFIRMED). Their name then
  // shows in the voucher's Received by box; finance verifies only after it (422 CASH_RECEIPT_NOT_CONFIRMED).
  fastify.post<{ Params: { id: string } }>('/:id/confirm-received', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (v.kind !== 'request' || v.payeeUserId !== viewer.id) {
      throw new AppError('NOT_HOLDER', 'Only the person who took this cash confirms they received it', 403)
    }
    if (!['disbursed', 'posted', 'settled', 'converted'].includes(v.status)) {
      throw wrongStatus('VOUCHER_NOT_PAID', v, 'cash is confirmed once the cashier has paid it')
    }
    if (v.cashReceivedAt) throw new AppError('ALREADY_CONFIRMED', `You already confirmed receiving the cash of ${v.number}`, 409)
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, payeeUserId: viewer.id, cashReceivedAt: null },
      data: { cashReceivedById: viewer.id, cashReceivedAt: now },
    })
    if (res.count === 0) throw new AppError('ALREADY_CONFIRMED', `You already confirmed receiving the cash of ${v.number}`, 409)
    await auditVoucher(req, 'confirm_received', v, { cashReceivedAt: now.toISOString() })
    return detailOf(v.id, viewer)
  })

  // POST /:id/confirm-received-on-behalf {reason ≥10} — finance (role finance with the accounting module) or the
  // CEO records "cash received" for a holder who never confirmed (left, offboarded, unreachable), so the documents
  // check is not blocked for good (422 CASH_RECEIPT_NOT_CONFIRMED). Never the raiser or the holder (409
  // SELF_APPROVE), never whoever paid it (409 PAYER_CANNOT_CONFIRM); only a paid request of the 2026-10-15 flow still waiting (409 ALREADY_CONFIRMED / VOUCHER_NOT_PAID);
  // conditional on cashReceivedAt still null. Received by = the actor; audited 'confirm_received' with
  // via 'finance_on_behalf' and the reason. Books nothing.
  fastify.post<{ Params: { id: string } }>('/:id/confirm-received-on-behalf', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = z.object({ reason: z.string().trim().min(10, 'Say why (at least 10 characters)').max(500) }).parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (!viewer.financeApprover) {
      throw new AppError('NOT_FINANCE', 'Only finance or the CEO records cash received on the holder\'s behalf', 403)
    }
    if (v.kind !== 'request') throw new AppError('NOT_A_REQUEST', 'A payee voucher records its receipt when it is paid', 422)
    if (isOwn(viewer, v)) {
      throw new AppError('SELF_APPROVE', 'You raised or hold this voucher — another finance person or the CEO records it', 409)
    }
    // The receipt is the holder's word that the payer handed the cash over: the payer never gives it for them.
    if (v.disbursedById && v.disbursedById === viewer.id) {
      throw new AppError('PAYER_CANNOT_CONFIRM', 'You paid this voucher — another finance person or the CEO records that the holder received it', 409)
    }
    if (v.status !== 'disbursed' || !v.expenseOnVerify) {
      throw wrongStatus('VOUCHER_NOT_PAID', v, 'receipt is recorded on behalf only for a paid voucher waiting for its documents check')
    }
    if (v.cashReceivedAt) throw new AppError('ALREADY_CONFIRMED', `Cash received for ${v.number} is already confirmed`, 409)
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, tenantId: v.tenantId, status: 'disbursed', cashReceivedAt: null },
      data: { cashReceivedById: viewer.id, cashReceivedAt: now },
    })
    if (res.count === 0) throw new AppError('ALREADY_CONFIRMED', `Cash received for ${v.number} is already confirmed`, 409)
    await auditVoucher(req, 'confirm_received', v, {
      cashReceivedAt: now.toISOString(), via: 'finance_on_behalf', reason: body.reason, holderUserId: v.payeeUserId,
    })
    return detailOf(v.id, viewer)
  })

  // GET /:id/pay-sources — what this viewer may pay an approved voucher from
  // (the Pay panel's one grouped picker): petty-cash boxes (the custodian's
  // own open boxes of the voucher's company; finance and managers — cash
  // keepers — every open box of it; a box the voucher names is the only one
  // for a non-keeper), cash on hand (1010) and the company's live linked bank
  // accounts — those two for finance (with the accounting module) and the CEO
  // only. Everything is the VOUCHER's company's, never the viewer's active one.
  fastify.get<{ Params: { id: string } }>('/:id/pay-sources', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (!(await canSee(viewer, v))) throw new NotFoundError('CashVoucher', v.id)
    if (!viewer.payer) throw new AppError('PAY_FINANCE_ONLY', 'Only finance pays a cash voucher', 403)
    const boxWhere: Prisma.PettyCashBoxWhereInput = { tenantId: v.tenantId, deletedAt: null, isActive: true }
    const boxes = await prisma.pettyCashBox.findMany({
      where: viewer.keeper ? boxWhere : v.boxId ? { ...boxWhere, id: v.boxId, custodianId: viewer.id } : { ...boxWhere, custodianId: viewer.id },
      select: { id: true, name: true, floatCents: true, custodianId: true },
      orderBy: { name: 'asc' },
    })
    const custodians = await prisma.user.findMany({ where: { id: { in: [...new Set(boxes.map((b) => b.custodianId))] } }, select: { id: true, name: true } })
    const direct = viewer.financeApprover
    const banks = direct
      ? await prisma.bankAccount.findMany({
        where: { tenantId: v.tenantId, deletedAt: null, isActive: true, accountCode: { not: null } },
        select: { id: true, name: true, bankName: true, accountCode: true },
        orderBy: { name: 'asc' },
      })
      : []
    return {
      boxId: v.boxId,
      boxes: boxes.map((b) => ({
        id: b.id, name: b.name, floatCents: b.floatCents, mine: b.custodianId === viewer.id,
        custodianName: custodians.find((u) => u.id === b.custodianId)?.name ?? null,
      })),
      cashOnHand: direct,
      banks,
    }
  })

  // POST /:id/pay { source?, boxId?, bankAccountId? } — the cash is handed to
  // the holder (kind request) or the payee (kind expense). Finance only
  // (403 PAY_FINANCE_ONLY). ONE transaction: claim approved → disbursed (409
  // ALREADY_PAID / VOUCHER_NOT_APPROVED), expenseOnVerify = true, bookedAtPay
  // = true, dueBy (documents due), paySource, and ONE entry that books the
  // expense now (Dr the voucher's account, its brand) — documents and
  // finance's check later book nothing:
  //   source 'box' (default). The box: the voucher's, else `boxId` (only a
  //     keeper changes a box already set), else the payer's only open box of
  //     the voucher's company. The spend through recordPettyCashSpendTx with
  //     one expense line (cashRequestPayLine): Dr <6xxx> / Cr 1011, the float
  //     drops (400 INSUFFICIENT_FLOAT).
  //   source 'cash_on_hand' | 'bank' (owner, 2026-10-16): finance with the
  //     accounting module, or the CEO (403 PAY_SOURCE_FINANCE_ONLY). The
  //     account is lib/bankAccounts.ts moneyAccountCode for the VOUCHER's
  //     company — cash → 1010; bank → `bankAccountId` (a live linked bank of
  //     that company, else 422), none named → its only bank (422
  //     BANK_ACCOUNT_REQUIRED with two or more). ONE entry
  //     'cashvoucher.pay:<id>' Dr <6xxx> / Cr that account; no box, no float.
  // 422 PERIOD_LOCKED (and every other refused posting) rolls it all back.
  fastify.post<{ Params: { id: string } }>('/:id/pay', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = z.object({
      // Omitted: the voucher's "To pay from" (cash → cash on hand, bank → its bank, credit), else the box.
      source: z.enum(['box', 'cash_on_hand', 'bank', 'credit']).optional(),
      boxId: z.string().min(1).max(64).optional(),
      bankAccountId: z.string().min(1).max(64).optional(),
      /** source 'credit': the supplier (default the voucher's) and the bill's due date (default today, Karachi). */
      supplierId: z.string().min(1).max(64).optional(),
      billDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-31').optional(),
      // The pay books the expense, so the equipment check runs here (it used to run at verification): a voucher
      // whose purpose looks like equipment is 422 USE_CAPEX unless finance says it is not, with a reason.
      notEquipment: z.boolean().optional(),
      notEquipmentReason: z.string().trim().max(500).nullable().optional(),
    }).parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    const me = viewer.id
    // Only finance pays (owner, 2026-10-16: "Paying a voucher should remain at Finance end") — never a box's
    // cashier, a manager or the CEO, from any source.
    if (!viewer.payer) throw new AppError('PAY_FINANCE_ONLY', 'Only finance pays a cash voucher', 403)
    if (PAID_STATUSES.includes(v.status)) throw new AppError('ALREADY_PAID', `Cash request ${v.number} has already been paid`, 409)
    if (v.status !== 'approved') throw wrongStatus('VOUCHER_NOT_APPROVED', v, 'only a voucher the CEO has approved can be paid')
    const source: 'box' | 'cash_on_hand' | 'bank' | 'credit' = body.source
      ?? (v.plannedPaySource === 'credit' ? 'credit' : v.plannedPaySource === 'bank' ? 'bank' : v.plannedPaySource === 'cash' ? 'cash_on_hand' : 'box')
    const bankAccountIdIn = body.bankAccountId ?? (source === 'bank' && v.plannedBankAccountId ? v.plannedBankAccountId : undefined)
    const credit = source === 'credit'
    if (credit) {
      // Bought on credit (owner, 2026-10-19): no cash leaves — the pay books a supplier bill. A payee voucher only.
      if (v.kind !== 'expense') throw new AppError('PAY_FROM_ONLY_ON_PAYEE_VOUCHER', 'Only a payee voucher is booked on credit', 422)
      if (body.bankAccountId) throw new AppError('BANK_NOT_FOR_SOURCE', 'A bank account is only picked when paying from a bank', 422)
    } else if (body.supplierId || body.billDueDate) {
      throw new AppError('SUPPLIER_ONLY_ON_CREDIT', 'A supplier and a due date are only given when it is booked on credit', 422)
    }
    const direct = source !== 'box'
    if (direct) {
      if (!viewer.financeApprover) {
        throw new AppError('PAY_SOURCE_FINANCE_ONLY', 'Only finance or the CEO pays a voucher from cash on hand or a bank account', 403)
      }
      if (body.boxId) throw new AppError('BOX_NOT_FOR_SOURCE', 'A cash box is only picked when paying from petty cash', 422)
    } else if (body.bankAccountId) {
      throw new AppError('BANK_NOT_FOR_SOURCE', 'A bank account is only picked when paying from a bank', 422)
    }
    const supplier = credit ? await creditSupplierOf(v.tenantId, body.supplierId ?? v.supplierId) : null

    let box: { id: string; tenantId: string | null; isActive: boolean; custodianId: string; name: string } | null = null
    if (!direct) {
      let boxId = v.boxId
      if (body.boxId && body.boxId !== v.boxId) {
        if (v.boxId && !viewer.keeper) {
          throw new AppError('BOX_PICK_KEEPERS_ONLY', 'This request names its cash box — only finance or a manager can change it', 403)
        }
        boxId = body.boxId
      }
      if (!boxId) {
        const mine = await prisma.pettyCashBox.findMany({
          where: { custodianId: me, tenantId: v.tenantId, deletedAt: null, isActive: true }, select: { id: true },
        })
        if (mine.length === 1) boxId = mine[0]!.id
        else if (mine.length === 0 && !viewer.keeper) throw new AppError('NOT_CUSTODIAN', 'Only the cashier who holds a cash box of this company, finance or a manager can pay this', 403)
        else throw new AppError('BOX_REQUIRED', 'Pick the cash box the money comes from', 422)
      }
      box = await prisma.pettyCashBox.findFirst({ where: { id: boxId, deletedAt: null }, select: { id: true, tenantId: true, isActive: true, custodianId: true, name: true } })
      if (!box || box.tenantId !== v.tenantId) throw new AppError('BOX_NOT_IN_COMPANY', 'That cash box is not one of this request\'s company\'s', 422)
      if (!box.isActive) throw new AppError('BOX_UNAVAILABLE', `${box.name} is closed — pick another box`, 409)
      if (box.custodianId !== me && !viewer.keeper) {
        throw new AppError('NOT_CUSTODIAN', `Only the cashier who holds ${box.name}, finance or a manager can pay from it`, 403)
      }
    }
    if (v.kind === 'request' && !v.payeeUserId) {
      throw new AppError('HOLDER_REQUIRED', `Cash request ${v.number} names nobody to take the cash — finance names the holder first`, 422)
    }
    // Equipment (owner, 2026-10-19): a payee voucher naming a fixed-asset class goes through the CapEx Quick-buy
    // engine — checked (class, outlet, shared → outlet) BEFORE any cash leaves; the class satisfies the equipment
    // check. Otherwise the expense account is booked by this pay: it must be usable before any cash leaves
    // (finance fixes it with PATCH otherwise).
    const assetCls = await assetTargetOf(prisma, v.tenantId, {
      kind: v.kind, assetClassId: v.assetClassId, assetLocationId: v.assetLocationId, conceptId: v.conceptId,
    })
    const expense = assetCls ? null : await resolveSpendAccount(prisma, v.tenantId, categoryRefOf(v.category), { allowExplicit: true })
    // Equipment belongs on the register through CapEx: refused BEFORE any cash leaves (finance overrides with a
    // reason, flagged below). The description is the pay line's own (cashRequestPayLine).
    const payLineDescription = `${v.number}: ${v.purpose}`.slice(0, 200)
    const eq = expense
      ? assertNotEquipmentLine({
        description: payLineDescription, expenseAccountCode: expense.code,
        notEquipment: body.notEquipment, notEquipmentReason: body.notEquipmentReason ?? null,
      }, { role: viewer.role })
      : { overridden: false }
    // On credit, an expense becomes a supplier bill through procurement's own engine (createBill = prepareBill +
    // insertBillTx): the bill's checks (company, INT4 non-stock line limit, equipment, expense code, withholding) run
    // here, before the claim; the company's FIFO cut-over runs before the transaction, as createBill's does.
    const billPrep = credit && expense
      ? await prepareBill({
        supplierId: supplier!.id, billNumber: v.number, billDate: pktDay(new Date()), dueDate: body.billDueDate ?? pktDay(new Date()),
        notes: `Cash voucher ${v.number}: ${v.purpose} (payee ${v.payeeName})`.slice(0, 1000),
        lines: [{
          expenseAccountCode: expense.code, description: payLineDescription, quantity: 1, unitCostCents: v.amountCents,
          notEquipment: body.notEquipment, notEquipmentReason: body.notEquipmentReason ?? null,
        }],
        createdBy: me, actorRole: viewer.role, actorEmail: req.staffUser!.email,
      })
      : null
    if (billPrep) await ensureFifoReady(v.tenantId)

    const { getOperationsConfig } = await import('../../lib/setup-config.js')
    const settleDays = (await getOperationsConfig(v.tenantId))?.cashAdvanceSettleDays ?? 30
    const payer = await prisma.user.findUnique({ where: { id: box ? box.custodianId : me }, select: { name: true } })
    const cashierName = payer?.name ?? null
    const reasonFull = `Cash voucher ${v.number}: ${v.purpose}`
    const reason = reasonFull.length > 200 ? `${reasonFull.slice(0, 199)}…` : reasonFull
    const now = new Date()
    const dueBy = new Date(now.getTime() + settleDays * 86_400_000)

    const result = await prisma.$transaction(classifyingTx(classificationOf(req.body) ?? plannedClassificationInput(v), me, 'entryId', async (tx) => {
      // Cash on hand / bank: THE resolver, for the VOUCHER's company, inside the transaction.
      const account = direct && !credit
        ? await moneyAccountCode(tx, v.tenantId, { method: source === 'cash_on_hand' ? 'cash' : 'bank_transfer', bankAccountId: bankAccountIdIn ?? null })
        : null
      const claimed = await tx.cashVoucher.updateMany({
        // The pay books what was read above (expense account, equipment check, pay line, brand, holder, amount):
        // a concurrent PATCH of any of them makes the claim miss → 409 VOUCHER_CHANGED (pay again).
        where: {
          id: v.id, tenantId: v.tenantId, status: 'approved',
          category: v.category, conceptId: v.conceptId, payeeUserId: v.payeeUserId,
          amountCents: v.amountCents, purpose: v.purpose, payeeName: v.payeeName,
          assetClassId: v.assetClassId, assetLocationId: v.assetLocationId, supplierId: v.supplierId, plannedPaySource: v.plannedPaySource,
        },
        data: {
          status: 'disbursed', disbursedAt: now, disbursedById: me, cashierName, dueBy, expenseOnVerify: true, bookedAtPay: true,
          ...(box
            ? { boxId: box.id, paySource: 'box', payAccountCode: null, payBankAccountId: null }
            : credit
              ? { boxId: null, paySource: 'credit', payAccountCode: null, payBankAccountId: null, supplierId: supplier!.id }
              : { boxId: null, paySource: source, payAccountCode: account!.code, payBankAccountId: account!.bankAccountId }),
          // An outside payee has no login: the payer's record of the hand-over is the receipt (kind expense).
          ...(v.kind === 'expense' && { cashReceivedById: me, cashReceivedAt: now }),
        },
      })
      if (claimed.count === 0) {
        const cur = await tx.cashVoucher.findUniqueOrThrow({ where: { id: v.id }, select: { status: true } })
        if (PAID_STATUSES.includes(cur.status)) throw new AppError('ALREADY_PAID', `Cash request ${v.number} has already been paid`, 409)
        if (cur.status === 'approved') {
          throw new AppError('VOUCHER_CHANGED', `Cash request ${v.number} was changed while it was being paid — reload and pay again`, 409)
        }
        throw wrongStatus('VOUCHER_NOT_APPROVED', { number: v.number, status: cur.status }, 'only a voucher the CEO has approved can be paid')
      }
      if (assetCls) {
        // Equipment: the CapEx Quick-buy engine (financePlanning/capexPosting.ts recordEquipmentPurchaseTx) — a capital
        // line on the outlet's standing project, its payment Dr 1340 / Cr the source ('capex.payment:<id>' — from a box
        // through the one spend path: its capex line, Cr 1011, the float drops), and the capitalisation request the
        // CEO approves (Dr class cost / Cr 1340 → the register → monthly depreciation). Nothing else posts.
        let movement: Awaited<ReturnType<typeof recordPettyCashSpendTx>> | null = null
        const bought = await recordEquipmentPurchaseTx(tx, {
          tenantId: v.tenantId, locationId: v.assetLocationId, item: v.purpose.slice(0, 200), cls: assetCls,
          quantity: 1, unitCostCents: v.amountCents, paidAt: now, vendor: (supplier?.name ?? v.payeeName).slice(0, 120),
          notes: `Cash voucher ${v.number} — paid to ${v.payeeName}`.slice(0, 500),
          supplierId: credit ? supplier!.id : null,
          pay: credit ? { kind: 'credit' } : box
            ? {
              kind: 'cash_document',
              record: async (lineId) => {
                movement = await recordPettyCashSpendTx(tx, {
                  box: { id: box!.id }, amountCents: v.amountCents, reason, vendorName: v.payeeName.slice(0, 120),
                  approvedById: v.directorSignedById, createdById: me, nature: 'expense',
                  lines: [{ kind: 'capex', capexLineId: lineId, amountCents: v.amountCents, conceptId: v.conceptId, description: payLineDescription }],
                  allowExplicit: true, stockAllowed: false, equipmentCheck: false,
                  cashVoucherId: v.id, conceptId: v.conceptId, actor: { id: me, role: viewer.role },
                })
                const line = await tx.pettyCashSpendLine.findFirst({ where: { movementId: movement.movement.id, tenantId: v.tenantId }, select: { capexPaymentId: true } })
                if (!line?.capexPaymentId) throw new AppError('CAPEX_PAYMENT_MISSING', 'The box spend did not book its CapEx payment', 500)
                return { capexPaymentId: line.capexPaymentId, entryId: movement.movement.journalEntryId }
              },
            }
            : {
              kind: 'instalment', payFrom: source === 'cash_on_hand' ? 'cash' : 'bank', bankAccountId: account!.bankAccountId,
              paymentRef: v.number, notes: `Paid by cash voucher ${v.number}`,
              // The voucher pays its amount in full: no income tax is withheld here (as on every cash voucher).
              extra: { whtCents: 0, whtRateBps: 0 },
            },
          postedBy: me,
          capitalise: {
            input: { inServiceAt: pktDay(now), locationId: v.assetLocationId, conceptId: v.conceptId },
            requestedById: me,
            reason: (projectName) => `Cash voucher ${v.number}: ${v.purpose} — paid to ${v.payeeName} (${projectName})`,
          },
        })
        const m = movement as Awaited<ReturnType<typeof recordPettyCashSpendTx>> | null
        await tx.cashVoucher.update({
          where: { id: v.id },
          data: {
            capexLineId: bought.lineId, capitaliseEventId: bought.eventId,
            ...(m ? { pettyCashMovementId: m.movement.id } : bought.entryId ? { payJournalEntryId: bought.entryId } : {}),
          },
        })
        return {
          movement: m?.movement ?? null, newFloatCents: m?.newFloatCents ?? null, entryId: bought.entryId, account,
          asset: { capexLineId: bought.lineId, capexPaymentId: bought.paymentId, projectId: bought.projectId, eventId: bought.eventId },
          bill: null,
        }
      }
      if (billPrep) {
        // On credit: THE bill and its entry (Dr <6xxx> / Cr 2010, net of any withholding Cr 2040) — 'supplier.bill:<id>'.
        const bill = await insertBillTx(tx, billPrep)
        await tx.cashVoucher.update({ where: { id: v.id }, data: { supplierBillId: bill.id, payJournalEntryId: bill.journalEntryId } })
        return { movement: null, newFloatCents: null, entryId: bill.journalEntryId, account: null, asset: null, bill: { id: bill.id, billNumber: bill.billNumber } }
      }
      if (!box) {
        // THE one entry: Dr <the voucher's 6xxx> / Cr 1010 | the bank's code — 'cashvoucher.pay:<id>', in this transaction.
        const posted = await postCashVoucherSourceTx(tx, v.id, 'pay', v.amountCents, me)
        await tx.cashVoucher.update({ where: { id: v.id }, data: { payJournalEntryId: posted.entryId } })
        return { movement: null, newFloatCents: null, entryId: posted.entryId, account, asset: null, bill: null }
      }
      // The one spend path (pettyCash.ts) — THE one entry, one expense line in the voucher's account (the H3
      // booking, cashRequestPayLine): Dr <6xxx> / Cr 1011, the float drops, in this transaction.
      const spent = await recordPettyCashSpendTx(tx, {
        box: { id: box.id },
        amountCents: v.amountCents,
        reason,
        vendorName: v.payeeName.slice(0, 120),
        approvedById: v.directorSignedById,
        createdById: me,
        nature: 'expense',
        lines: [cashRequestPayLine(v)],
        allowExplicit: true,
        stockAllowed: false,
        equipmentCheck: false,
        cashVoucherId: v.id,
        conceptId: v.conceptId,
        actor: { id: me, role: viewer.role },
      })
      await tx.cashVoucher.update({ where: { id: v.id }, data: { pettyCashMovementId: spent.movement.id } })
      return { movement: spent.movement, newFloatCents: spent.newFloatCents, entryId: spent.movement.journalEntryId, account: null, asset: null, bill: null }
    }), { timeout: 20_000, maxWait: 10_000 })

    await auditVoucher(req, 'pay', v, {
      status: 'disbursed',
      amountCents: v.amountCents,
      paySource: source,
      boxId: box?.id ?? null,
      ...(supplier && { supplierId: supplier.id, supplierName: supplier.name }),
      ...(result.bill && { supplierBillId: result.bill.id, billNumber: result.bill.billNumber, journalEntryId: result.entryId }),
      ...(result.account && { payAccountCode: result.account.code, payBankAccountId: result.account.bankAccountId, journalEntryId: result.entryId }),
      ...(result.movement && { pettyCashMovementId: result.movement.id, newFloatCents: result.newFloatCents }),
      cashierName,
      dueBy: dueBy.toISOString(),
      expenseAccountCode: expense?.code ?? null,
      ...(result.asset && { assetClassKey: assetCls!.key, assetLocationId: v.assetLocationId, ...result.asset }),
      bookedAtPay: true,
      ...(eq.overridden && { notEquipment: true, notEquipmentReason: (body.notEquipmentReason ?? '').trim() }),
    }, { status: v.status, boxId: v.boxId })
    voucherTaskNotice('paid', v.id, me)
    if (result.asset) {
      // The CapEx side's own trail, and the bell: the capitalisation waits for the CEO (as a Quick buy's does).
      await audit({
        category: 'accounting', action: 'capex.voucher_buy', entity: 'CapexLine', entityId: result.asset.capexLineId,
        userId: me, userEmail: req.staffUser!.email, tenantId: v.tenantId,
        after: { voucherId: v.id, number: v.number, ...result.asset, entryId: result.entryId },
        metadata: { classKey: assetCls!.key, totalCents: v.amountCents, locationId: v.assetLocationId, paySource: source },
      })
      if (result.asset.eventId) approvalWaiting('fixed_asset_request', result.asset.eventId, { round: `create:${result.asset.eventId}`, actorId: me })
    }
    if (billPrep && result.bill) {
      // The bill's own after-commit step: its equipment override is audited and flagged as a bill's (high).
      await afterBillCreated(billPrep, result.bill)
    } else if (eq.overridden) {
      await flagOverrides(v, me, [{ accountCode: expense!.code, amountCents: v.amountCents, description: payLineDescription, overrideReason: (body.notEquipmentReason ?? '').trim() }])
    }

    return {
      voucher: await detailOf(v.id, viewer),
      movement: result.movement
        ? { id: result.movement.id, amountCents: result.movement.amountCents, createdAt: result.movement.createdAt, journalEntryId: result.movement.journalEntryId }
        : null,
      newFloatCents: result.newFloatCents,
      journalEntryId: result.entryId,
    }
  })

  // Supporting documents, spend lines, verification; legacy receipts,
  // settlements, line reclass, change returned.
  await fastify.register(cashRequestSettleRoutes)
  // GET /:id/export.pdf | /:id/export.xlsx (approved or later).
  await fastify.register(cashVoucherExportRoutes)
}

