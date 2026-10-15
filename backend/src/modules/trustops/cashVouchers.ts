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
// • POST /:id/pay — the box's custodian (or a keeper) hands the cash over. ONE
//   transaction: approved → disbursed (it pays once), expenseOnVerify = true,
//   dueBy = now + OperationsConfig.cashAdvanceSettleDays, and ONE petty-cash
//   spend through recordPettyCashSpendTx (nature 'voucher_hold'): Dr 1357
//   Petty Cash Vouchers Awaiting Documents / Cr 1011 — NOT the expense.
// • Supporting documents, the spend lines, verification and the posting
//   (Dr expense / Cr 1357, once): cashRequestSettle.ts.
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
import { CashVoucherStatus, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { audit } from '../../lib/audit.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, activeTenantId } from '../../lib/tenantScope.js'
import { assertInt4Fits, zInt4Cents } from '../../lib/money.js'
import { amountInWords } from '../../lib/amountInWords.js'
import { EVIDENCE_MAX_BYTES, sendEvidence } from '../../lib/evidenceFile.js'
import { resolveSpendAccount } from '../accounting/expenseCategories.js'
import { cashRequestPaidAccountTx, categoryRefOf } from '../accounting/pettyCashPosting.js'
import { passesCashGuard, recordPettyCashSpendTx } from './pettyCash.js'
import { cashRequestSettleRoutes } from './cashRequestSettle.js'
import { cashVoucherExportRoutes } from './voucherExport.js'

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
  | 'awaiting_docs' | 'awaiting_verification' | 'posted'
  | 'paid' | 'receipts_in' | 'settled' | 'needs_review' | 'rejected' | 'cancelled' | 'converted'

export function stageOf(v: { status: CashVoucherStatus; payeeUserId: string | null; kind: string; expenseOnVerify: boolean; attachments: Array<{ kind: string }> }): CashRequestStage {
  switch (v.status) {
    case 'draft':
    case 'submitted': return 'waiting_finance'
    case 'hod_signed':
    case 'finance_approved': return 'waiting_ceo'
    case 'disbursed':
      if (v.expenseOnVerify) return v.attachments.some((a) => a.kind === 'supporting') ? 'awaiting_verification' : 'awaiting_docs'
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
  /** Record what was spent (POST /:id/spend) before finance verifies. */
  canRecordSpend: boolean
  /** Finance verifies the documents and books the expense (POST /:id/verify-docs). */
  canVerify: boolean
  /** The holder confirms they received the cash (POST /:id/confirm-received). */
  canConfirmReceived: boolean
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
  const docsParty = viewer.financeApprover || viewer.keeper || custodian || (v.kind === 'request' && !!holder && holder === me)
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
    canPay: s === 'approved' && (viewer.keeper || custodian || (!v.boxId && viewer.payBoxTenants.has(v.tenantId))),
    canUpload: ((s === 'approved' || newPaid) && docsParty) || (s === 'posted' && viewer.keeper),
    canRecordSpend: newPaid && docsParty,
    canVerify: newPaid && viewer.financeApprover && !own && supportingCountOf(v) > 0 && (v.kind !== 'request' || !!v.cashReceivedAt),
    canConfirmReceived: v.kind === 'request' && !!holder && holder === me && !v.cashReceivedAt
      && (s === 'disbursed' || s === 'posted' || s === 'settled' || s === 'converted'),
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
  const [users, concepts, tenants] = await Promise.all([
    userIds.size ? prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }) : [],
    conceptIds.size ? prisma.concept.findMany({ where: { id: { in: [...conceptIds] } }, select: { id: true, name: true } }) : [],
    tenantIds.size ? prisma.tenant.findMany({ where: { id: { in: [...tenantIds] } }, select: { id: true, name: true } }) : [],
  ])
  const userName = new Map(users.map((u) => [u.id, u.name]))
  const conceptName = new Map(concepts.map((c) => [c.id, c.name]))
  const tenantName = new Map(tenants.map((t) => [t.id, t.name]))
  const nameOf = (id: string | null) => (id ? (userName.get(id) ?? null) : null)
  const now = Date.now()
  return Promise.all(rows.map(async (v) => {
    const { box, attachments, ...voucher } = v
    const receipts = attachments.filter((a) => a.kind === 'receipt')
    const signed = attachments.filter((a) => a.kind === 'signed_voucher')
    const supporting = attachments.filter((a) => a.kind === 'supporting')
    const remainingCents = remainingOf(v)
    const ref = categoryRefOf(v.category)
    return {
      ...voucher,
      stage: stageOf(v),
      /** The amount paid (= gross − discount). */
      totalCents: v.amountCents,
      grossOrAmountCents: v.grossCents ?? v.amountCents + v.discountCents,
      amountInWords: amountInWords(v.amountCents),
      categoryKey: ref.categoryKey,
      categoryAccountCode: ref.accountCode,
      holderUserId: v.payeeUserId,
      holderName: nameOf(v.payeeUserId),
      remainingCents,
      overdue: v.status === 'disbursed' && !!v.dueBy && v.dueBy.getTime() < now && (v.expenseOnVerify || remainingCents > 0),
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
  if (v.pettyCashMovementId) {
    try { paidAccountCode = await cashRequestPaidAccountTx(prisma, v.id) } catch { paidAccountCode = null }
  }
  const submitters = [...new Set(settlements.map((s) => s.submittedById))]
  const names = submitters.length ? await prisma.user.findMany({ where: { id: { in: submitters } }, select: { id: true, name: true } }) : []
  // 2026-10-15 flow: what the holder (or finance) says was spent, before / as verified.
  const spentCents = v.expenseOnVerify ? settlements.reduce((t, s) => t + s.lines.reduce((u, l) => u + l.amountCents, 0), 0) : null
  const spendLines = v.expenseOnVerify ? settlements.flatMap((s) => s.lines) : []
  return {
    ...base,
    paidAccountCode,
    payMovement,
    settlements: settlements.map((s) => ({ ...s, submittedByName: names.find((n) => n.id === s.submittedById)?.name ?? null })),
    spend: v.expenseOnVerify ? {
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

const selfApprove = () => new AppError('SELF_APPROVE', 'You raised or hold this voucher — someone else must decide it', 409)

/** NULL-safe "this column is not me" (Prisma's `not` leaves NULL rows out). */
const notMe = (field: 'financeApprovedById' | 'hodSignedById', me: string): Prisma.CashVoucherWhereInput =>
  ({ OR: [{ [field]: null }, { [field]: { not: me } }] })

const VIEWS = [
  'mine', 'finance', 'ceo', 'returned', 'to_pay', 'missing_docs', 'awaiting_verification', 'posted', 'all',
  // Kept working: hod (= finance), director (= ceo), and the legacy H3 views.
  'hod', 'director', 'receipts_due', 'overdue', 'settled', 'needs_review',
] as const

const PKT_OFFSET_MS = 5 * 3600_000
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
    switch (q.view) {
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
      case 'missing_docs': view = { status: 'disbursed', expenseOnVerify: true, attachments: { none: { kind: 'supporting' } } }; break
      case 'awaiting_verification': view = { status: 'disbursed', expenseOnVerify: true, attachments: { some: { kind: 'supporting' } } }; break
      case 'posted': view = { status: 'posted' }; break
      case 'receipts_due': view = { status: 'disbursed', ...(sees ? {} : { payeeUserId: me }) }; break
      case 'overdue': view = { status: 'disbursed', dueBy: { lt: new Date() }, ...(sees ? {} : { payeeUserId: me }) }; break
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
  //   docsOverdue (paid, documents due date passed, not verified) ·
  //   postedThisMonth (verified and booked this Karachi month).
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
    const [waitingFinance, waitingCeo, returned, approvedUnpaid, missingDocs, awaitingVerification, docsOverdue, postedThisMonth] = await Promise.all([
      bucket({ status: { in: WAIT_FINANCE } }),
      bucket({ status: { in: WAIT_CEO } }),
      bucket({ status: 'returned' }),
      bucket({ status: 'approved' }),
      bucket({ ...paidNew, attachments: { none: { kind: 'supporting' } } }),
      bucket({ ...paidNew, attachments: { some: { kind: 'supporting' } } }),
      bucket({ ...paidNew, dueBy: { lt: now } }),
      bucket({ status: 'posted', postedAt: { gte: pktMonthStart(now) } }),
    ])
    return {
      scope: company ? 'company' : 'mine',
      waitingFinance, waitingCeo, returned, approvedUnpaid, missingDocs, awaitingVerification, docsOverdue, postedThisMonth,
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
      where: { entity: 'CashVoucher', entityId: v.id, tenantId: v.tenantId },
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
    const category = await categoryOf(tenantId, body, keeper)
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
    })
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
    const categoryOrBox = sent.every((k) => k === 'categoryKey' || k === 'accountCode' || k === 'boxId')
    const financeFields = sent.every((k) => ['categoryKey', 'accountCode', 'boxId', 'discountCents', 'grossCents', 'conceptId', 'department'].includes(k))
    const wantsDiscount = body.discountCents !== undefined || body.grossCents !== undefined

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
    } else {
      throw wrongStatus('VOUCHER_NOT_DRAFT', v, 'only a voucher waiting for finance, or returned, can be edited (finance may change the account until it is paid)')
    }
    if (body.boxId !== undefined && !keeper) {
      throw new AppError('BOX_PICK_KEEPERS_ONLY', 'Only finance or a manager picks the cash box — the cashier picks it when paying', 403)
    }
    if (wantsDiscount && !viewer.financeApprover) throw new AppError('DISCOUNT_FINANCE_ONLY', 'Only finance sets a discount', 403)
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
    if (body.categoryKey !== undefined || body.accountCode !== undefined) data.category = await categoryOf(v.tenantId, body, keeper)
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
    // The account: the one sent, else the stored one — it must resolve now.
    const ref = body.categoryKey !== undefined || body.accountCode !== undefined
      ? { categoryKey: body.categoryKey, accountCode: body.accountCode }
      : categoryRefOf(v.category)
    const category = await categoryOf(v.tenantId, ref, true)
    if (category !== v.category) data.category = category
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
    return detailOf(v.id, viewer)
  })

  // POST /:id/pay { boxId? } — the box's custodian or a keeper hands the cash
  // to the holder (kind request) or the payee (kind expense). The box: the
  // voucher's, else `boxId` (only a keeper changes a box already set), else
  // the custodian's only open box in the voucher's company. ONE transaction:
  // claim approved → disbursed (409 ALREADY_PAID / VOUCHER_NOT_APPROVED),
  // expenseOnVerify = true, box / cashier / dueBy (documents due), and the ONE
  // spend through recordPettyCashSpendTx (nature 'voucher_hold'): Dr 1357 /
  // Cr 1011 for the amount — the expense is booked when finance verifies the
  // documents. 400 INSUFFICIENT_FLOAT and 422 PERIOD_LOCKED roll everything
  // back.
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

  fastify.post<{ Params: { id: string } }>('/:id/pay', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = z.object({ boxId: z.string().min(1).max(64).optional() }).parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    const me = viewer.id
    if (PAID_STATUSES.includes(v.status)) throw new AppError('ALREADY_PAID', `Cash request ${v.number} has already been paid`, 409)
    if (v.status !== 'approved') throw wrongStatus('VOUCHER_NOT_APPROVED', v, 'only a voucher the CEO has approved can be paid')

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
    const box = await prisma.pettyCashBox.findFirst({ where: { id: boxId, deletedAt: null }, select: { id: true, tenantId: true, isActive: true, custodianId: true, name: true } })
    if (!box || box.tenantId !== v.tenantId) throw new AppError('BOX_NOT_IN_COMPANY', 'That cash box is not one of this request\'s company\'s', 422)
    if (!box.isActive) throw new AppError('BOX_UNAVAILABLE', `${box.name} is closed — pick another box`, 409)
    if (box.custodianId !== me && !viewer.keeper) {
      throw new AppError('NOT_CUSTODIAN', `Only the cashier who holds ${box.name}, finance or a manager can pay from it`, 403)
    }
    if (v.kind === 'request' && !v.payeeUserId) {
      throw new AppError('HOLDER_REQUIRED', `Cash request ${v.number} names nobody to take the cash — finance names the holder first`, 422)
    }
    // The expense account is booked at verification, but it must be usable
    // before any cash leaves (finance fixes it with PATCH otherwise).
    await resolveSpendAccount(prisma, v.tenantId, categoryRefOf(v.category), { allowExplicit: true })

    const { getOperationsConfig } = await import('../../lib/setup-config.js')
    const settleDays = (await getOperationsConfig(v.tenantId))?.cashAdvanceSettleDays ?? 30
    const custodian = await prisma.user.findUnique({ where: { id: box.custodianId }, select: { name: true } })
    const cashierName = custodian?.name ?? null
    const reasonFull = `Cash voucher ${v.number}: ${v.purpose}`
    const reason = reasonFull.length > 200 ? `${reasonFull.slice(0, 199)}…` : reasonFull
    const now = new Date()
    const dueBy = new Date(now.getTime() + settleDays * 86_400_000)

    const result = await prisma.$transaction(async (tx) => {
      const claimed = await tx.cashVoucher.updateMany({
        where: { id: v.id, tenantId: v.tenantId, status: 'approved' },
        data: {
          status: 'disbursed', boxId: box.id, disbursedAt: now, disbursedById: me, cashierName, dueBy, expenseOnVerify: true,
          // An outside payee has no login: the payer's record of the hand-over is the receipt (kind expense).
          ...(v.kind === 'expense' && { cashReceivedById: me, cashReceivedAt: now }),
        },
      })
      if (claimed.count === 0) {
        const cur = await tx.cashVoucher.findUniqueOrThrow({ where: { id: v.id }, select: { status: true } })
        if (PAID_STATUSES.includes(cur.status)) throw new AppError('ALREADY_PAID', `Cash request ${v.number} has already been paid`, 409)
        throw wrongStatus('VOUCHER_NOT_APPROVED', { number: v.number, status: cur.status }, 'only a voucher the CEO has approved can be paid')
      }
      // The one spend path (pettyCash.ts) — Dr 1357 / Cr 1011, in this transaction.
      const spent = await recordPettyCashSpendTx(tx, {
        box: { id: box.id },
        amountCents: v.amountCents,
        reason,
        vendorName: v.payeeName.slice(0, 120),
        approvedById: v.directorSignedById,
        createdById: me,
        nature: 'voucher_hold',
        cashVoucherId: v.id,
        conceptId: v.conceptId,
        actor: { id: me, role: viewer.role },
      })
      await tx.cashVoucher.update({ where: { id: v.id }, data: { pettyCashMovementId: spent.movement.id } })
      return { movement: spent.movement, newFloatCents: spent.newFloatCents }
    }, { timeout: 20_000, maxWait: 10_000 })

    await auditVoucher(req, 'pay', v, {
      status: 'disbursed',
      amountCents: v.amountCents,
      boxId: box.id,
      pettyCashMovementId: result.movement.id,
      newFloatCents: result.newFloatCents,
      cashierName,
      dueBy: dueBy.toISOString(),
      heldOn: '1357',
    }, { status: v.status, boxId: v.boxId })

    return {
      voucher: await detailOf(v.id, viewer),
      movement: { id: result.movement.id, amountCents: result.movement.amountCents, createdAt: result.movement.createdAt, journalEntryId: result.movement.journalEntryId },
      newFloatCents: result.newFloatCents,
    }
  })

  // Supporting documents, spend lines, verification; legacy receipts,
  // settlements, line reclass, change returned.
  await fastify.register(cashRequestSettleRoutes)
  // GET /:id/export.pdf | /:id/export.xlsx (approved or later).
  await fastify.register(cashVoucherExportRoutes)
}

