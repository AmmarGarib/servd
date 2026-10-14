// Cash requests — GS Foods' internal cash payment voucher, reworked as a
// request anyone can raise (owner, 2026-10-13; accountant H3, 2026-10-14).
//
//   "Anyone raises → HOD signs → director (CEO) approves → Jamil sb (the box
//    custodian) pays and marks it paid (no photo) → the holder uploads
//    receipts."  Hasnain (H3): "Expense at payment; receipts kept for the file."
//
//   draft ──sign-hod──▶ hod_signed ──approve (director)──▶ approved ──pay──▶ disbursed ──receipts / change──▶ settled
//     │                     │                                │                (paid · receipts in)
//   reject / cancel     reject / cancel                    cancel
//
// • Raise (any login, the ACTIVE company): amount, purpose, the expense
//   CATEGORY (a PAYOUT key; a cash keeper may name an explicit 6xxx), the
//   HOLDER (who takes the cash and brings the receipts — default the raiser),
//   brand / department, and — keepers only — the box. Raising, signing,
//   approving and printing never touch cash.
// • HOD = HR's rule (hr/service.ts directManagerUserIdOf: the holder's direct
//   reporting manager's login), or a cash keeper. The holder never signs their
//   own request (409 SELF_SIGN_HOD).
// • Director = the CEO (role admin), never the login that signed as HOD
//   (409 SAME_SIGNER).
// • POST /:id/pay — the box's custodian (or a keeper) hands the cash over. ONE
//   transaction: the request is claimed approved → disbursed (it pays once),
//   dueBy = now + OperationsConfig.cashAdvanceSettleDays, and ONE petty-cash
//   spend is recorded through recordPettyCashSpendTx — one expense line in the
//   request's category (accounting/pettyCashPosting.ts cashRequestPayLine):
//   Dr <category's 6xxx> / Cr 1011. INSUFFICIENT_FLOAT / PERIOD_LOCKED roll it
//   all back. ONLY this moves cash.
// • Receipts, settlements, reclass and change returned: cashRequestSettle.ts
//   (child routes). Receipts are evidence and book nothing; a settlement only
//   reclasses out of the account the pay booked; change returned is Dr 1011 /
//   Cr that account. Status 'settled' when receipts + change cover the amount.
// • Legacy vouchers paid by the old photo flow with no holder (payeeUserId
//   null) are 'needs review': keepers only, never flagged, until finance names
//   the holder (PATCH { holderUserId }, the one edit allowed after payment).
//
// Company separation: a request binds to the ACTIVE company on create; its
// box, brand and holder must be that company's (422). Every read and write of
// an existing request is scoped to the operator's companies — another
// company's request is 404 on every route. Files are stored in the database
// and never selected by a list.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { CashVoucherStatus, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { audit } from '../../lib/audit.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, activeTenantId, type TenantIdWhere } from '../../lib/tenantScope.js'
import { zInt4Cents } from '../../lib/money.js'
import { EVIDENCE_MAX_BYTES, sendEvidence } from '../../lib/evidenceFile.js'
import { resolveSpendAccount } from '../accounting/expenseCategories.js'
import { cashRequestPaidAccountTx, cashRequestPayLine, categoryRefOf } from '../accounting/pettyCashPosting.js'
import { directManagerUserIdOf, teamUserIdsUnder } from '../hr/service.js'
import { passesCashGuard, recordPettyCashSpendTx } from './pettyCash.js'
import { cashRequestSettleRoutes } from './cashRequestSettle.js'

// ─── Files ───────────────────────────────────────────────────────────────────

/** A receipt (or the legacy signed-voucher photo) may be at most 3 MB decoded. */
export const CASH_VOUCHER_PHOTO_MAX_BYTES = EVIDENCE_MAX_BYTES

// ─── Shapes ──────────────────────────────────────────────────────────────────

export const VOUCHER_INCLUDE = {
  box: { select: { id: true, name: true, custodianId: true, tenantId: true, isActive: true, deletedAt: true } },
  // File METADATA only — the bytes are read by GET /:id/attachments/:aid alone.
  attachments: {
    select: { id: true, kind: true, mime: true, sizeBytes: true, createdAt: true, uploadedById: true, settlementId: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.CashVoucherInclude
export type VoucherRow = Prisma.CashVoucherGetPayload<{ include: typeof VOUCHER_INCLUDE }>

export const voucherNumber = (seq: number) => `CV-${String(seq).padStart(5, '0')}`

/** What is still open on a paid request: amount − receipts booked − change returned − converted. */
export const remainingOf = (v: { amountCents: number; settledCents: number; returnedCents: number; convertedCents: number }) =>
  v.amountCents - v.settledCents - v.returnedCents - v.convertedCents

/** A request paid by the old photo flow that names no holder. */
const isLegacyNoHolder = (v: { status: CashVoucherStatus; payeeUserId: string | null }) => v.status === 'disbursed' && !v.payeeUserId

/** The steps the UI shows (the DB status stays as stored: paid / receipts in are both 'disbursed'). */
export type CashRequestStage =
  | 'draft' | 'hod_signed' | 'approved' | 'paid' | 'receipts_in' | 'settled' | 'needs_review' | 'rejected' | 'cancelled' | 'converted'

export function stageOf(v: { status: CashVoucherStatus; payeeUserId: string | null; attachments: Array<{ kind: string }> }): CashRequestStage {
  if (v.status !== 'disbursed') return v.status
  if (!v.payeeUserId) return 'needs_review'
  return v.attachments.some((a) => a.kind === 'receipt') ? 'receipts_in' : 'paid'
}

const PAID_STATUSES: CashVoucherStatus[] = ['disbursed', 'settled', 'converted']

// ─── Who is looking ──────────────────────────────────────────────────────────

export interface Viewer {
  id: string
  role: string
  email: string
  /** Passes CASH_GUARD (the manager tiers, finance with the accounting module). */
  keeper: boolean
  isAdmin: boolean
  /** Boxes this login holds (not deleted) in its companies. */
  heldBoxIds: Set<string>
  /** Companies where this login holds an OPEN box (it may pay an unboxed request there). */
  payBoxTenants: Set<string>
  /** This login's direct reports' logins in `tenantId` (HR's reporting line). */
  reportsIn: (tenantId: string) => Promise<Set<string>>
}

export async function viewerOf(req: FastifyRequest): Promise<Viewer> {
  const su = req.staffUser!
  const keeper = await passesCashGuard(req)
  const boxes = await prisma.pettyCashBox.findMany({
    where: { custodianId: su.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
    select: { id: true, tenantId: true, isActive: true },
  })
  const cache = new Map<string, Promise<Set<string>>>()
  return {
    id: su.id,
    role: su.role,
    email: su.email,
    keeper,
    isAdmin: su.role === 'admin',
    heldBoxIds: new Set(boxes.map((b) => b.id)),
    payBoxTenants: new Set(boxes.filter((b) => b.isActive && b.tenantId).map((b) => b.tenantId!)),
    reportsIn: (tenantId) => {
      let p = cache.get(tenantId)
      if (!p) {
        // HR's walk (/hr/team), narrowed to the DIRECT reports — HR's HOD rule.
        p = (async () => {
          const team = await teamUserIdsUnder(tenantId, su.id)
          const direct = await Promise.all(team.map(async (u) => ((await directManagerUserIdOf(tenantId, u)) === su.id ? u : null)))
          return new Set(direct.filter((u): u is string => !!u))
        })()
        cache.set(tenantId, p)
      }
      return p
    },
  }
}

export interface CashRequestCaps {
  canEdit: boolean
  canEditCategory: boolean
  canSignHod: boolean
  canApprove: boolean
  canReject: boolean
  canCancel: boolean
  canPay: boolean
  canUploadReceipts: boolean
  canSettle: boolean
  canReturnChange: boolean
  canReclass: boolean
  canNameHolder: boolean
}

/** May this viewer sign `v` as HOD (status aside)? Keepers, or the holder's direct manager — never the holder. */
async function hodEligible(viewer: Viewer, v: { tenantId: string; payeeUserId: string | null }): Promise<boolean> {
  if (v.payeeUserId === viewer.id) return false
  if (viewer.keeper) return true
  return !!v.payeeUserId && (await viewer.reportsIn(v.tenantId)).has(v.payeeUserId)
}

/** What this viewer may do on `v` — the UI shows buttons by these; the routes re-check each one. */
export async function capsOf(viewer: Viewer, v: VoucherRow): Promise<CashRequestCaps> {
  const me = viewer.id
  const s = v.status
  const raiser = v.preparedById === me
  const holder = v.payeeUserId
  const custodian = !!v.box && v.box.custodianId === me
  const remaining = remainingOf(v)
  const hod = s === 'draft' && (await hodEligible(viewer, v))
  const canUploadReceipts = s === 'disbursed' && (viewer.keeper || (!!holder && holder === me))
  return {
    canEdit: s === 'draft' && (raiser || viewer.keeper),
    canEditCategory: (s === 'draft' && (raiser || viewer.keeper)) || (viewer.keeper && (s === 'hod_signed' || s === 'approved')),
    canSignHod: hod,
    canApprove: s === 'hod_signed' && viewer.isAdmin && v.hodSignedById !== me,
    canReject: hod || (s === 'hod_signed' && viewer.isAdmin),
    canCancel: (s === 'draft' && (raiser || viewer.keeper)) || (viewer.keeper && (s === 'hod_signed' || s === 'approved')),
    canPay: s === 'approved' && (viewer.keeper || custodian || (!v.boxId && viewer.payBoxTenants.has(v.tenantId))),
    canUploadReceipts,
    canSettle: canUploadReceipts && remaining > 0,
    canReturnChange: s === 'disbursed' && remaining > 0 && (viewer.keeper || custodian),
    canReclass: viewer.keeper && (s === 'disbursed' || s === 'settled'),
    canNameHolder: viewer.keeper && !holder && (s === 'hod_signed' || s === 'approved' || s === 'disbursed'),
  }
}

/** May this viewer open `v` at all (inside its company scope)? */
export async function canSee(viewer: Viewer, v: VoucherRow): Promise<boolean> {
  if (viewer.keeper) return true
  if (v.payeeUserId === viewer.id) return true
  if (v.preparedById === viewer.id && !isLegacyNoHolder(v)) return true
  if (v.status === 'draft' && v.payeeUserId && (await viewer.reportsIn(v.tenantId)).has(v.payeeUserId)) return true
  if ((v.status === 'approved' || PAID_STATUSES.includes(v.status)) && v.boxId && viewer.heldBoxIds.has(v.boxId)) return true
  if (v.status === 'approved' && !v.boxId && viewer.payBoxTenants.has(v.tenantId)) return true
  return false
}

function idsOf(scope: TenantIdWhere): string[] {
  return typeof scope.tenantId === 'string' ? [scope.tenantId] : scope.tenantId.in
}

/** The list's visibility rule for a non-keeper, as a where clause (canSee in SQL). */
async function visibleWhere(viewer: Viewer, scope: TenantIdWhere): Promise<Prisma.CashVoucherWhereInput> {
  if (viewer.keeper) return {}
  const drafts: Prisma.CashVoucherWhereInput[] = []
  for (const t of idsOf(scope)) {
    const reports = [...(await viewer.reportsIn(t))]
    if (reports.length) drafts.push({ tenantId: t, payeeUserId: { in: reports } })
  }
  const or: Prisma.CashVoucherWhereInput[] = [
    { payeeUserId: viewer.id },
    { preparedById: viewer.id, NOT: { status: 'disbursed', payeeUserId: null } },
    { status: { in: ['approved', ...PAID_STATUSES] }, boxId: { in: [...viewer.heldBoxIds] } },
    { status: 'approved', boxId: null, tenantId: { in: [...viewer.payBoxTenants] } },
  ]
  if (drafts.length) or.push({ status: 'draft', OR: drafts })
  return { OR: or }
}

// ─── Presenting ──────────────────────────────────────────────────────────────

/** The request as every route returns it: the row, names, stage, counters and caps (never file bytes). */
export async function present(rows: VoucherRow[], viewer: Viewer) {
  const userIds = new Set<string>()
  const conceptIds = new Set<string>()
  const tenantIds = new Set<string>()
  for (const v of rows) {
    for (const id of [v.preparedById, v.hodSignedById, v.directorSignedById, v.rejectedById, v.cancelledById, v.disbursedById, v.payeeUserId, v.box?.custodianId ?? null]) {
      if (id) userIds.add(id)
    }
    if (v.conceptId) conceptIds.add(v.conceptId)
    tenantIds.add(v.tenantId)
  }
  // Names only, for ids these requests (already in scope) point at.
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
    const remainingCents = remainingOf(v)
    const ref = categoryRefOf(v.category)
    return {
      ...voucher,
      stage: stageOf(v),
      categoryKey: ref.categoryKey,
      categoryAccountCode: ref.accountCode,
      holderUserId: v.payeeUserId,
      holderName: nameOf(v.payeeUserId),
      remainingCents,
      overdue: v.status === 'disbursed' && !!v.dueBy && v.dueBy.getTime() < now && remainingCents > 0,
      needsReview: isLegacyNoHolder(v),
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
      hodSignedByName: nameOf(v.hodSignedById),
      directorSignedByName: nameOf(v.directorSignedById),
      rejectedByName: nameOf(v.rejectedById),
      cancelledByName: nameOf(v.cancelledById),
      disbursedByName: nameOf(v.disbursedById),
      isMine: v.preparedById === viewer.id || v.payeeUserId === viewer.id,
      ...(await capsOf(viewer, v)),
    }
  }))
}
export const presentOne = async (v: VoucherRow, viewer: Viewer) => (await present([v], viewer))[0]!

/** One request in full: the row, its settlements (lines, receipt metadata) and where its pay is booked. */
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
  return {
    ...base,
    paidAccountCode,
    payMovement,
    settlements: settlements.map((s) => ({ ...s, submittedByName: names.find((n) => n.id === s.submittedById)?.name ?? null })),
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
  // The expense category the pay is booked to (H3): a PAYOUT key, or — cash
  // keepers only — an explicit 6xxx code.
  categoryKey: z.string().trim().min(1).max(40).nullable().optional(),
  accountCode: z.string().trim().regex(/^\d{4}$/, 'An account code is four digits').nullable().optional(),
  conceptId: z.string().uuid().nullable().optional(),
  department: zOptionalText(80),
  // Paid from a petty-cash box (INT4), so INT4.
  amountCents: zInt4Cents('The amount', { sign: 'positive' }),
  /** Who takes the cash and brings the receipts. Default: whoever raises it. */
  holderUserId: z.string().min(1).max(64).optional(),
  /** The name on the paper. Default: the holder's name. */
  payeeName: z.string().trim().min(1).max(120).optional(),
  /** Keepers only. Otherwise the custodian picks the box at pay. */
  boxId: z.string().min(1).max(64).nullable().optional(),
}
const CreateBody = z.object(fields)
const PatchBody = z.object(fields).partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Send at least one field to change')
type PatchInput = z.infer<typeof PatchBody>

const NoteBody = z.object({ note: z.string().trim().min(3, 'Say why (at least 3 characters)').max(500) })

/** The holder must be a login of the request's company. */
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

/** The request, or 404 when it is not one of the operator's companies'. */
export async function loadVoucher(req: FastifyRequest, id: string): Promise<VoucherRow> {
  const v = await prisma.cashVoucher.findFirst({
    where: { id, ...(await scopeTenantWhere(req, 'write')) },
    include: VOUCHER_INCLUDE,
  })
  if (!v) throw new NotFoundError('CashVoucher', id)
  return v
}

/** The request for a viewer who may open it (else 403 NOT_YOURS). */
export async function loadVisible(req: FastifyRequest, id: string): Promise<{ v: VoucherRow; viewer: Viewer }> {
  const v = await loadVoucher(req, id)
  const viewer = await viewerOf(req)
  if (!(await canSee(viewer, v))) {
    throw new AppError('NOT_YOURS', 'Only whoever raised or holds this request, its HOD, the cashier who pays it, finance or a manager can open it', 403)
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

const VIEWS = ['mine', 'hod', 'director', 'to_pay', 'receipts_due', 'overdue', 'settled', 'needs_review', 'all'] as const

// ─── Routes (/trustops/cash-vouchers) ────────────────────────────────────────

export async function cashVoucherRoutes(fastify: FastifyInstance) {
  // GET / — the register, newest first; `cursor` = the last id of the previous
  // page (400 BAD_CURSOR when it is not in view). Read scope (the active
  // company, or every company in "All companies" view). A cash keeper sees
  // every request; anyone else the ones they raised, hold, may sign as HOD,
  // or may pay (approved or later on a box they hold; approved with no box in
  // a company where they hold one). `view`:
  //   mine — raised or held by me · hod — drafts I may sign · director —
  //   waiting for the CEO · to_pay — approved, mine to pay · receipts_due —
  //   paid, still open (mine as holder; keepers all) · overdue — receipts due
  //   date passed · settled · needs_review — legacy, no holder (keepers) · all.
  // Never the file bytes; each row carries the viewer's capability flags.
  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const viewer = await viewerOf(req)
    const q = z.object({
      view: z.enum(VIEWS).default('all'),
      status: z.nativeEnum(CashVoucherStatus).optional(),
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
    let view: Prisma.CashVoucherWhereInput = {}
    switch (q.view) {
      case 'mine': view = { OR: [{ preparedById: me }, { payeeUserId: me }] }; break
      case 'hod': {
        if (viewer.keeper) { view = { status: 'draft', NOT: { payeeUserId: me } }; break }
        const ors: Prisma.CashVoucherWhereInput[] = []
        for (const t of idsOf(scope)) {
          const reports = [...(await viewer.reportsIn(t))]
          if (reports.length) ors.push({ tenantId: t, payeeUserId: { in: reports } })
        }
        view = ors.length ? { status: 'draft', OR: ors } : { id: { in: [] } }
        break
      }
      case 'director': view = { status: 'hod_signed' }; break
      case 'to_pay': view = viewer.keeper ? { status: 'approved' } : {
        status: 'approved',
        OR: [{ boxId: { in: [...viewer.heldBoxIds] } }, { boxId: null, tenantId: { in: [...viewer.payBoxTenants] } }],
      }; break
      case 'receipts_due': view = { status: 'disbursed', ...(viewer.keeper ? {} : { payeeUserId: me }) }; break
      case 'overdue': view = { status: 'disbursed', dueBy: { lt: new Date() }, ...(viewer.keeper ? {} : { payeeUserId: me }) }; break
      case 'settled': view = { status: 'settled' }; break
      case 'needs_review': view = viewer.keeper ? { status: 'disbursed', payeeUserId: null } : { id: { in: [] } }; break
      case 'all': break
    }
    const rows = await prisma.cashVoucher.findMany({
      where: {
        AND: [
          scope,
          await visibleWhere(viewer, scope),
          view,
          after,
          q.status ? { status: q.status } : {},
        ],
      },
      include: VOUCHER_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    })
    const page = rows.slice(0, q.limit)
    return { items: await present(page, viewer), nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null, keeper: viewer.keeper }
  })

  // GET /:id — one request in full (the print view reads this).
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { v, viewer } = await loadVisible(req, req.params.id)
    return detailOf(v.id, viewer)
  })

  // GET /:id/attachments/:aid — a receipt, or a legacy signed-voucher photo,
  // inline (private, no-store, nosniff) — for whoever may open the request.
  fastify.get<{ Params: { id: string; aid: string } }>('/:id/attachments/:aid', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const { v } = await loadVisible(req, req.params.id)
    const file = await prisma.cashVoucherAttachment.findFirst({
      where: { id: req.params.aid, voucherId: v.id, tenantId: v.tenantId },
      select: { mime: true, data: true, kind: true },
    })
    if (!file) throw new NotFoundError('Attachment', req.params.aid)
    return sendEvidence(reply, file, `${v.number}-${file.kind === 'receipt' ? 'receipt' : 'signed'}-${req.params.aid.slice(0, 6)}`)
  })

  // POST / — raise a request in the ACTIVE company (any login). Touches no cash.
  fastify.post('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = CreateBody.parse(req.body)
    const tenantId = activeTenantId(req, 'a cash request belongs to one company')
    const keeper = await passesCashGuard(req)
    const me = req.staffUser!.id
    if (body.boxId && !keeper) {
      throw new AppError('BOX_PICK_KEEPERS_ONLY', 'Only finance or a manager picks the cash box — the cashier picks it when paying', 403)
    }
    if (body.boxId) await openBoxOf(tenantId, body.boxId)
    if (body.conceptId) {
      const concept = await assertConceptOwned(req, body.conceptId, 'create')
      if (concept.tenantId !== tenantId) throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand belongs to another company', 422)
    }
    const holder = await holderOf(tenantId, body.holderUserId ?? me)
    const category = await categoryOf(tenantId, body, keeper)
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
          voucherDate: body.voucherDate ?? new Date(),
          payeeName: body.payeeName ?? holder.name.slice(0, 120),
          payeeUserId: holder.id,
          purpose: body.purpose,
          category,
          conceptId: body.conceptId ?? null,
          department: body.department ?? null,
          amountCents: body.amountCents,
          boxId: body.boxId ?? null,
          status: 'draft',
          preparedById: me,
        },
        select: { id: true, tenantId: true, number: true },
      })
    })
    await auditVoucher(req, 'create', created, { amountCents: body.amountCents, holderUserId: holder.id, purpose: body.purpose, category, boxId: body.boxId ?? null })
    return reply.status(201).send(await detailOf(created.id, await viewerOf(req)))
  })

  // PATCH /:id — edit:
  //   • a draft: whoever raised it or a keeper (the box and an explicit
  //     account: keepers only);
  //   • HOD-signed / approved: a keeper may still change the category and the
  //     box (until it is paid);
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

    if (v.status === 'draft') {
      if (!raiser && !keeper) throw new ForbiddenError('Only whoever raised this request, finance or a manager can edit it')
    } else if (onlyHolder && !v.payeeUserId && ['hod_signed', 'approved', 'disbursed'].includes(v.status)) {
      if (!keeper) throw new ForbiddenError('Only finance or a manager can name who holds this cash')
    } else if (categoryOrBox && (v.status === 'hod_signed' || v.status === 'approved')) {
      if (!keeper) throw new ForbiddenError('Only finance or a manager can change the category or the box once the HOD has signed')
    } else {
      throw wrongStatus('VOUCHER_NOT_DRAFT', v, 'only a draft can be edited (finance may change the category until it is paid)')
    }
    if (body.boxId !== undefined && !keeper) {
      throw new AppError('BOX_PICK_KEEPERS_ONLY', 'Only finance or a manager picks the cash box — the cashier picks it when paying', 403)
    }

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
      if (body.payeeName === undefined && v.status === 'draft') data.payeeName = holder.name.slice(0, 120)
    }
    if (body.categoryKey !== undefined || body.accountCode !== undefined) data.category = await categoryOf(v.tenantId, body, keeper)
    if (body.voucherDate !== undefined) data.voucherDate = body.voucherDate
    if (body.payeeName !== undefined) data.payeeName = body.payeeName
    if (body.purpose !== undefined) data.purpose = body.purpose
    if (body.conceptId !== undefined) data.conceptId = body.conceptId
    if (body.department !== undefined) data.department = body.department
    if (body.amountCents !== undefined) data.amountCents = body.amountCents
    // Conditional on the state read: a sign or a pay racing this edit wins,
    // and the edit is refused.
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, status: v.status, ...(onlyHolder && v.status !== 'draft' ? { payeeUserId: null } : {}) },
      data,
    })
    if (res.count === 0) throw new AppError('VOUCHER_CHANGED', `Cash request ${v.number} was changed by someone else — reload it`, 409)
    const before = Object.fromEntries(Object.keys(data).map((k) => [k, v[k as keyof VoucherRow]]))
    await auditVoucher(req, onlyHolder && v.status !== 'draft' ? 'name_holder' : 'update', v, { ...data }, before)
    return detailOf(v.id, viewer)
  })

  // POST /:id/sign-hod — the HOD signs. draft → hod_signed. HR's rule: the
  // holder's direct reporting manager's login, or a cash keeper; never the
  // holder (409 SELF_SIGN_HOD); anyone else 403 NOT_HOD.
  fastify.post<{ Params: { id: string } }>('/:id/sign-hod', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (v.status !== 'draft') throw wrongStatus('VOUCHER_NOT_DRAFT', v, 'only a draft can be signed as HOD')
    if (v.payeeUserId === viewer.id) throw new AppError('SELF_SIGN_HOD', 'You hold this cash — your HOD signs it, not you', 409)
    if (!(await hodEligible(viewer, v))) {
      throw new AppError('NOT_HOD', 'Only the HOD of the person who holds the cash (their reporting manager), finance or a manager can sign this', 403)
    }
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, status: 'draft', payeeUserId: v.payeeUserId },
      data: { status: 'hod_signed', hodSignedById: viewer.id, hodSignedAt: now },
    })
    if (res.count === 0) throw new AppError('VOUCHER_NOT_DRAFT', `Cash request ${v.number} was signed or changed by someone else — reload it`, 409)
    await auditVoucher(req, 'sign_hod', v, { status: 'hod_signed', hodSignedAt: now.toISOString() }, { status: v.status })
    return detailOf(v.id, viewer)
  })

  // POST /:id/approve — the director (the CEO) signs. hod_signed → approved.
  // Two different people must sign: never the login that signed as HOD.
  fastify.post<{ Params: { id: string } }>('/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const v = await loadVoucher(req, req.params.id)
    const me = req.staffUser!.id
    if (v.status !== 'hod_signed') throw wrongStatus('VOUCHER_NOT_HOD_SIGNED', v, 'the director signs after the HOD')
    if (v.hodSignedById === me) {
      throw new AppError('SAME_SIGNER', 'You signed this request as HOD — a different person must sign as director', 409)
    }
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, status: 'hod_signed', hodSignedById: { not: me } },
      data: { status: 'approved', directorSignedById: me, directorSignedAt: now },
    })
    if (res.count === 0) throw new AppError('VOUCHER_NOT_HOD_SIGNED', `Cash request ${v.number} was changed by someone else — reload it`, 409)
    await auditVoucher(req, 'approve', v, { status: 'approved', directorSignedAt: now.toISOString() }, { status: v.status })
    return detailOf(v.id, await viewerOf(req))
  })

  // POST /:id/reject {note} — the HOD refuses a draft, or the director a
  // HOD-signed request. → rejected.
  fastify.post<{ Params: { id: string } }>('/:id/reject', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { note } = NoteBody.parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (v.status === 'draft') {
      if (v.payeeUserId === viewer.id) throw new AppError('SELF_SIGN_HOD', 'You hold this cash — cancel it instead', 409)
      if (!(await hodEligible(viewer, v))) throw new AppError('NOT_HOD', 'Only the HOD, finance or a manager can reject a draft', 403)
    } else if (v.status === 'hod_signed') {
      if (!viewer.isAdmin) throw new ForbiddenError('Only the director (CEO) can reject a request the HOD has signed')
    } else {
      throw wrongStatus('VOUCHER_NOT_HOD_SIGNED', v, 'only a draft or a request waiting for the director can be rejected')
    }
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, status: v.status },
      data: { status: 'rejected', rejectedById: viewer.id, rejectedAt: now, rejectNote: note },
    })
    if (res.count === 0) throw new AppError('VOUCHER_NOT_HOD_SIGNED', `Cash request ${v.number} was changed by someone else — reload it`, 409)
    await auditVoucher(req, 'reject', v, { status: 'rejected', note }, { status: v.status })
    return detailOf(v.id, viewer)
  })

  // POST /:id/cancel {note} — withdrawn before payment: whoever raised it (a
  // draft) or a keeper (draft, HOD-signed, approved).
  fastify.post<{ Params: { id: string } }>('/:id/cancel', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { note } = NoteBody.parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    const cancellable: CashVoucherStatus[] = viewer.keeper ? ['draft', 'hod_signed', 'approved'] : v.preparedById === viewer.id ? ['draft'] : []
    if (cancellable.length === 0) throw new ForbiddenError('Only whoever raised this request (while a draft), finance or a manager can cancel it')
    if (!['draft', 'hod_signed', 'approved'].includes(v.status)) throw wrongStatus('VOUCHER_NOT_CANCELLABLE', v, 'only a request not yet paid can be cancelled')
    if (!cancellable.includes(v.status)) throw new ForbiddenError('Once the HOD has signed, only finance or a manager can cancel it')
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, status: { in: cancellable } },
      data: { status: 'cancelled', cancelledById: viewer.id, cancelledAt: now, cancelNote: note },
    })
    if (res.count === 0) throw new AppError('VOUCHER_NOT_CANCELLABLE', `Cash request ${v.number} was paid or changed by someone else — reload it`, 409)
    await auditVoucher(req, 'cancel', v, { status: 'cancelled', note }, { status: v.status })
    return detailOf(v.id, viewer)
  })

  // POST /:id/pay { boxId? } — the box's custodian (Jamil sb) or a keeper
  // hands the cash to the holder. The box: the request's, else `boxId` (only
  // a keeper changes a box already set), else the custodian's only open box
  // in the request's company. ONE transaction: claim approved → disbursed
  // (409 ALREADY_PAID / VOUCHER_NOT_APPROVED), box / cashier / dueBy, and the
  // ONE spend (recordPettyCashSpendTx, one expense line in the request's
  // category: Dr 6xxx / Cr 1011, H3). 400 INSUFFICIENT_FLOAT and 422
  // PERIOD_LOCKED roll everything back. No photo.
  fastify.post<{ Params: { id: string } }>('/:id/pay', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = z.object({ boxId: z.string().min(1).max(64).optional() }).parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    const me = viewer.id
    if (PAID_STATUSES.includes(v.status)) throw new AppError('ALREADY_PAID', `Cash request ${v.number} has already been paid`, 409)
    if (v.status !== 'approved') throw wrongStatus('VOUCHER_NOT_APPROVED', v, 'only a request the director has approved can be paid')

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
    if (!v.payeeUserId) throw new AppError('HOLDER_REQUIRED', `Cash request ${v.number} names nobody to take the cash — finance names the holder first`, 422)
    const payLine = cashRequestPayLine(v)

    const { getOperationsConfig } = await import('../../lib/setup-config.js')
    const settleDays = (await getOperationsConfig(v.tenantId))?.cashAdvanceSettleDays ?? 30
    const custodian = await prisma.user.findUnique({ where: { id: box.custodianId }, select: { name: true } })
    const cashierName = custodian?.name ?? null
    const reasonFull = `Cash request ${v.number}: ${v.purpose}`
    const reason = reasonFull.length > 200 ? `${reasonFull.slice(0, 199)}…` : reasonFull
    const now = new Date()
    const dueBy = new Date(now.getTime() + settleDays * 86_400_000)

    const result = await prisma.$transaction(async (tx) => {
      const claimed = await tx.cashVoucher.updateMany({
        where: { id: v.id, tenantId: v.tenantId, status: 'approved' },
        data: { status: 'disbursed', boxId: box.id, disbursedAt: now, disbursedById: me, cashierName, dueBy },
      })
      if (claimed.count === 0) {
        const cur = await tx.cashVoucher.findUniqueOrThrow({ where: { id: v.id }, select: { status: true } })
        if (PAID_STATUSES.includes(cur.status)) throw new AppError('ALREADY_PAID', `Cash request ${v.number} has already been paid`, 409)
        throw wrongStatus('VOUCHER_NOT_APPROVED', { number: v.number, status: cur.status }, 'only a request the director has approved can be paid')
      }
      // The one spend path (pettyCash.ts) — booked in this transaction.
      const spent = await recordPettyCashSpendTx(tx, {
        box: { id: box.id },
        amountCents: v.amountCents,
        reason,
        vendorName: v.payeeName.slice(0, 120),
        approvedById: v.directorSignedById,
        createdById: me,
        nature: 'expense',
        lines: [payLine],
        cashVoucherId: v.id,
        conceptId: v.conceptId,
        actor: { id: me, role: viewer.role },
        // The category was checked when it was set (an explicit code only by a keeper).
        allowExplicit: true,
        // The receipts place equipment on CapEx (a capex settlement line).
        equipmentCheck: false,
        stockAllowed: false,
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
    }, { status: v.status, boxId: v.boxId })

    return {
      voucher: await detailOf(v.id, viewer),
      movement: { id: result.movement.id, amountCents: result.movement.amountCents, createdAt: result.movement.createdAt, journalEntryId: result.movement.journalEntryId },
      newFloatCents: result.newFloatCents,
    }
  })

  // Receipts, settlements, line reclass, change returned.
  await fastify.register(cashRequestSettleRoutes)
}
