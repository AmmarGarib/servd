// Journal requests (head office D1/D3, spec §7.3 / §8): Finance PREPARES a
// manual journal, the CEO (or, once the owner switches it on, a Finance
// delegate — A22) APPROVES it, and only then does it reach the books.
//
// Additive: the CEO's direct `POST /accounting/journal` and
// `POST /accounting/journal/:id/reverse` are unchanged and stay CEO-only. A
// request is accounting's OWN pending state (no second approval engine): the
// approvals inbox reads `GET /accounting/journal-requests?status=submitted` as
// the caller and calls this module's approve / reject routes, whose guard
// (lib/approvalRights.ts assertCanApprove) decides.
//
//   kind 'post'     lines like a direct manual journal (accounts by id, brand per
//                   line); approval posts `manual:<requestId>` through
//                   manualJournal.ts postManualJournal — the very entry a direct
//                   post makes, so the CEO's reverse route can undo it.
//   kind 'reverse'  names a `manual:` entry of the same company + a reason;
//                   approval calls reverseManualJournal. CEO only, never handed over.
//   kind 'amend'    (owner, 2026-10-23: "edit/cancel/void any back dated or current
//                   Journal manual entry with final approval of CEO … only when amount
//                   is edited") names a `manual:` entry + a reason + the corrected
//                   description / reference / date / lines; approval runs
//                   manualJournal.ts amendManualJournal (reverse the original on its
//                   own day + post the corrected entry `manual:<requestId>`, one
//                   transaction) — the CEO's own direct edit. CEO only, never handed over.
//   Change requests (reverse / amend) of the Journals tab: one open per entry (409
//   CHANGE_PENDING, under the entry's change lock); `changeMeta.fingerprint` is the
//   entry as it was when raised — approval refuses 409 ENTRY_CHANGED if it moved or
//   was reversed since; a return / reject needs a note ≥10 (422 NOTE_TOO_SHORT).
//   Finance raises them through POST /accounting/journal/:id/amend | /reverse
//   (raiseChangeRequest; a text-only edit applies at once instead).
//
//   draft ──submit──▶ submitted ──approve──▶ posted
//     ▲  │              │  └──reject {note}──▶ returned ──PATCH / submit──▶ submitted
//     │  └──withdraw──▶ withdrawn ◀──withdraw──┘ (draft, submitted or returned)
//
// Rules:
//   - Preparers: admin, owner, management, finance (JR_PREPARERS). A new
//     request binds to the ACTIVE company (scopeTenantWhere(req, 'create')) —
//     on a head-office lens submit, the lens company — and is stamped with
//     viaHeadOfficeId (lib/headOffice.ts viaHeadOfficeForSubmit) at create and
//     again at submit.
//   - PATCH / submit / withdraw: the original preparer only (A7), and every one
//     appends the caller to preparedByIds; a reach-only caller is refused by
//     assertHoMayPropose unless it is their own request in the right state.
//   - Approve / reject: approvalSubject → assertCanApprove on serviceClient
//     facts BEFORE the row is read (A5); the claim is a conditional updateMany on
//     status 'submitted' (and, for a non-admin, NOT preparedByIds has me). The
//     posting runs in the claim's transaction: a refused posting (a closed
//     month, an inactive account, …) rolls the claim back → 422 and the request
//     stays submitted.
//   - A19: every write takes its company from the ROW, never the caller's
//     active company; auditApproval writes the one `approval.decide` row.

import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { assertMoneyFits, toCents } from '../../lib/money.js'
import { resolveTenantScope, scopeTenantWhere } from '../../lib/tenantScope.js'
import { assertHoMayPropose, viaHeadOfficeForSubmit } from '../../lib/headOffice.js'
import {
  approvalInputOf, approvalQueueTenantIds, approvalSubject, assertCanApprove, auditApproval,
  type ApprovalGrant,
} from '../../lib/approvalRights.js'
import {
  assertManualLines, assertNoControlledLines, assertReversible, manualLineSchema, postManualJournal, reverseManualJournal,
  amendManualJournal, changePending, entryFingerprint, lockEntryChangeTx, manualReversalOf, splitDescription,
  type ManualJournalLine,
} from './manualJournal.js'
import { classifyPaymentTx, type ClassificationInput } from './paymentsRegister.js'

/** Who prepares (creates, edits, submits, withdraws) a journal request. */
export const JR_PREPARERS = ['admin', 'owner', 'management', 'finance'] as const
export const JR_STATUSES = ['draft', 'submitted', 'returned', 'posted', 'withdrawn'] as const
export type JournalRequestStatus = (typeof JR_STATUSES)[number]
export const JR_KINDS = ['post', 'reverse', 'amend'] as const
/** Kinds that change an EXISTING manual entry — the CEO's alone (approvalRights.ts). */
export const JR_CHANGE_KINDS: readonly string[] = ['reverse', 'amend']
/** A return / rejection of a change request says why (owner, 2026-10-23). */
const CHANGE_NOTE_MIN = 10

const EDITABLE: readonly string[] = ['draft', 'returned']
const WITHDRAWABLE: readonly string[] = ['draft', 'submitted', 'returned']
const TX_OPTS = { timeout: 30_000, maxWait: 10_000 } as const
const TYPE = 'journal_request'

// ─── Bodies ──────────────────────────────────────────────────────────────────

const postFields = {
  description: z.string().trim().min(1).max(500),
  reference: z.string().trim().max(200).nullable().optional(),
  entryDate: z.string().datetime().nullable().optional(),
  // Exactly the direct route's line rules (manualJournal.ts manualLineSchema).
  lines: z.array(manualLineSchema).min(2).max(200),
}
const reverseFields = {
  reverseEntryId: z.string().uuid(),
  reason: z.string().trim().min(5).max(500),
  entryDate: z.string().datetime().nullable().optional(),
}

const amendFields = {
  ...postFields,
  reverseEntryId: z.string().uuid(),
  reason: z.string().trim().min(5).max(500),
}

export const createRequestSchema = z.union([
  z.object({ kind: z.literal('post').optional(), ...postFields, submit: z.boolean().optional() }),
  z.object({ kind: z.literal('reverse'), ...reverseFields, submit: z.boolean().optional() }),
  z.object({ kind: z.literal('amend'), ...amendFields, submit: z.boolean().optional() }),
])
export type CreateRequestBody = z.infer<typeof createRequestSchema>

export const patchPostSchema = z.object({
  description: postFields.description.optional(),
  reference: postFields.reference,
  entryDate: postFields.entryDate,
  lines: postFields.lines.optional(),
})
export const patchAmendSchema = patchPostSchema.extend({ reason: amendFields.reason.optional() })
export const patchReverseSchema = z.object({
  reason: reverseFields.reason.optional(),
  entryDate: reverseFields.entryDate,
})

export const rejectSchema = z.object({ note: z.string().trim().min(3).max(500) })

export const listQuerySchema = z.object({
  status: z.enum(JR_STATUSES).optional(),
  kind: z.enum(JR_KINDS).optional(),
  mine: z.enum(['1', 'true']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Row = Prisma.JournalRequestGetPayload<Record<string, never>>

function me(req: FastifyRequest) {
  const su = req.staffUser
  if (!su) throw new AppError('UNAUTHORIZED', 'Sign in first', 401)
  return su
}

const isPreparer = (role: string) => (JR_PREPARERS as readonly string[]).includes(role)
const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))]

/** The stored lines, re-validated (422 INVALID_LINES if a stored row is malformed). */
export function linesOf(row: Pick<Row, 'lines'>): ManualJournalLine[] {
  const parsed = z.array(manualLineSchema).safeParse(row.lines)
  if (!parsed.success) throw new AppError('INVALID_LINES', 'The request\'s lines are not valid — edit them and send it again', 422)
  return parsed.data
}

/** A refused posting is a 422 to the approver (the request stays submitted); a lost claim stays 409. */
function asRefusal(e: unknown): unknown {
  if (e instanceof AppError) {
    if (e.statusCode === 409 && ['REQUEST_NOT_PENDING', 'ALREADY_POSTED', 'ALREADY_REVERSED', 'TAX_PAYMENT_LINKED', 'ENTRY_CHANGED', 'CHANGE_PENDING', 'ENTRY_RESOLVES_VOUCHER'].includes(e.code)) return e
    if (e.statusCode === 422) return e
    return new AppError(e.code, e.message, 422, e.details)
  }
  return e
}

async function namesOf(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const users = await serviceClient.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })
  return new Map(users.map((u) => [u.id, u.name || u.email || u.id]))
}

export interface JournalRequestDto {
  id: string
  tenantId: string
  tenantName: string | null
  kind: string
  status: string
  description: string
  reference: string | null
  entryDate: string | null
  lines: unknown
  totalCents: number
  reverseEntryId: string | null
  reason: string | null
  preparedById: string
  preparedByIds: string[]
  preparedByName: string | null
  preparedAt: string
  submittedById: string | null
  submittedAt: string | null
  viaHeadOfficeId: string | null
  decidedById: string | null
  decidedByName: string | null
  decidedAt: string | null
  /** On a submitted / returned row: the last return's note. On a posted row: unchanged from that. */
  decisionNote: string | null
  decidedVia: string | null
  postedEntryId: string | null
  /** reverse / amend: the manual entry being cancelled or edited (= reverseEntryId). */
  targetEntryId: string | null
  /** amend: the payment classification the corrected entry takes (else the original's carries over). */
  classification: ClassificationInput | null
  createdAt: string
  updatedAt: string
}

async function toDtos(rows: Row[]): Promise<JournalRequestDto[]> {
  const [names, tenants] = await Promise.all([
    namesOf(uniq(rows.flatMap((r) => [r.preparedById, r.decidedById]))),
    rows.length
      ? serviceClient.tenant.findMany({ where: { id: { in: uniq(rows.map((r) => r.tenantId)) } }, select: { id: true, name: true } })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
  ])
  const tenantName = new Map(tenants.map((t) => [t.id, t.name]))
  const iso = (d: Date | null) => (d ? d.toISOString() : null)
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    tenantName: tenantName.get(r.tenantId) ?? null,
    kind: r.kind,
    status: r.status,
    description: r.description,
    reference: r.reference,
    entryDate: iso(r.entryDate),
    lines: r.lines,
    totalCents: toCents(r.totalCents),
    reverseEntryId: r.reverseEntryId,
    reason: r.reason,
    preparedById: r.preparedById,
    preparedByIds: r.preparedByIds,
    preparedByName: names.get(r.preparedById) ?? null,
    preparedAt: r.preparedAt.toISOString(),
    submittedById: r.submittedById,
    submittedAt: iso(r.submittedAt),
    viaHeadOfficeId: r.viaHeadOfficeId,
    decidedById: r.decidedById,
    decidedByName: r.decidedById ? (names.get(r.decidedById) ?? null) : null,
    decidedAt: iso(r.decidedAt),
    decisionNote: r.decisionNote,
    decidedVia: r.decidedVia,
    postedEntryId: r.postedEntryId,
    targetEntryId: r.kind === 'post' ? null : r.reverseEntryId,
    classification: metaOf(r).classification ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))
}

async function dtoOf(row: Row): Promise<JournalRequestDto> {
  return (await toDtos([row]))[0]!
}

async function auditRequest(req: FastifyRequest, row: Pick<Row, 'id' | 'tenantId'>, action: string, extra: { before?: unknown; after?: unknown; metadata?: Record<string, unknown> } = {}) {
  const su = req.staffUser
  await audit({
    category: 'accounting',
    action: `journal_request.${action}`,
    entity: 'JournalRequest',
    entityId: row.id,
    userId: su?.id ?? null,
    userEmail: su?.email ?? null,
    tenantId: row.tenantId, // A19: the request's company
    before: extra.before,
    after: extra.after,
    metadata: { ip: req.ip, ...(extra.metadata ?? {}) },
  })
}

/**
 * Validate a post request's lines in its company (the direct route's checks); returns the total.
 * The total is stored in a BIGINT money column, so it must fit MAX_MONEY_CENTS even though each
 * line already does (200 lines of the line cap would not) — 422 AMOUNT_TOO_LARGE otherwise.
 */
async function checkPostLines(tenantId: string, lines: ManualJournalLine[]): Promise<number> {
  const { debits } = await assertManualLines(prisma, tenantId, lines)
  assertMoneyFits(debits, 'journal request total')
  return debits
}

interface ChangeMeta { fingerprint?: string; classification?: ClassificationInput | null }
export function metaOf(r: Pick<Row, 'changeMeta'>): ChangeMeta {
  return r.changeMeta && typeof r.changeMeta === 'object' ? (r.changeMeta as ChangeMeta) : {}
}

/**
 * A change request's entry (reverse / amend): a manual entry of this company that
 * can still be reversed (assertReversible), not already under an open change
 * (409 CHANGE_PENDING). Returns the original and its fingerprint.
 */
async function checkChangeTarget(db: Prisma.TransactionClient | typeof prisma, tenantId: string, entryId: string, exceptRequestId?: string) {
  const r = await assertReversible(db, tenantId, entryId, { checkAlready: true })
  const open = await db.journalRequest.findFirst({
    where: {
      tenantId, kind: { in: [...JR_CHANGE_KINDS] }, reverseEntryId: entryId, status: { in: ['draft', 'submitted', 'returned'] },
      ...(exceptRequestId ? { NOT: { id: exceptRequestId } } : {}),
    },
    select: { id: true, kind: true, status: true },
  })
  if (open) throw changePending(open)
  return { ...r, fingerprint: entryFingerprint(r.original) }
}

/** The corrected lines of an amend: the direct route's line checks + no module-controlled account (that is the CEO's override). */
async function checkAmendLines(tenantId: string, lines: ManualJournalLine[]): Promise<number> {
  const total = await checkPostLines(tenantId, lines)
  await assertNoControlledLines(prisma, tenantId, lines)
  return total
}

export interface ChangeBody {
  kind: 'reverse' | 'amend'
  reason: string
  entryDate?: string | null
  description?: string
  reference?: string | null
  lines?: ManualJournalLine[]
  classification?: ClassificationInput | null
}

/**
 * Insert a change request (reverse / amend) for `entryId` in `tenantId` (the
 * ENTRY's company), under the entry's change lock so two cannot open at once.
 */
async function insertChangeRequest(req: FastifyRequest, tenantId: string, entryId: string, body: ChangeBody, submit: boolean): Promise<Row> {
  const su = me(req)
  const via = await viaHeadOfficeForSubmit(req, tenantId)
  const total = body.kind === 'amend' ? await checkAmendLines(tenantId, body.lines ?? []) : 0
  return prisma.$transaction(async (tx) => {
    await lockEntryChangeTx(tx, tenantId, entryId)
    const { original, amountCents, fingerprint } = await checkChangeTarget(tx, tenantId, entryId)
    const now = new Date()
    const common = {
      tenantId, kind: body.kind, reverseEntryId: original.id, reason: body.reason,
      preparedById: su.id, preparedByIds: [su.id], viaHeadOfficeId: via,
      changeMeta: { fingerprint, ...(body.classification ? { classification: body.classification } : {}) } as unknown as Prisma.InputJsonValue,
      ...(submit ? { status: 'submitted', submittedById: su.id, submittedAt: now } : { status: 'draft' }),
    }
    if (body.kind === 'reverse') {
      assertMoneyFits(amountCents, 'journal request total')
      return tx.journalRequest.create({ data: {
        ...common, description: `Reverse: ${original.description}`.slice(0, 500), reference: original.reference,
        entryDate: body.entryDate ? new Date(body.entryDate) : null, lines: [], totalCents: amountCents,
      } })
    }
    return tx.journalRequest.create({ data: {
      ...common, description: body.description!, reference: body.reference?.trim() || null,
      // An edit keeps the entry's date unless a new one is given.
      entryDate: body.entryDate ? new Date(body.entryDate) : original.entryDate,
      lines: (body.lines ?? []) as Prisma.InputJsonValue, totalCents: total,
    } })
  }, TX_OPTS)
}

/**
 * Finance's edit (money) or cancel of an existing manual entry, raised from the
 * Journals tab (POST /accounting/journal/:id/amend | /reverse): a SUBMITTED
 * request in the entry's company that the CEO approves. The caller resolved the
 * entry in its write scope (foreign → 404).
 */
export async function raiseChangeRequest(req: FastifyRequest, tenantId: string, entryId: string, body: ChangeBody): Promise<JournalRequestDto> {
  await assertHoMayPropose(req, tenantId, true, 'a journal change request')
  // Closed / reopened books stay the CEO's (owner, 2026-10-16): anyone else may
  // not even raise a change there — the entry's own date or the edit's new date.
  if (req.staffUser?.role !== 'admin') {
    const { closedBooksThrough } = await import('./closedBooks.js')
    const through = await closedBooksThrough(prisma, tenantId)
    if (through) {
      const entry = await prisma.journalEntry.findFirst({ where: { id: entryId, tenantId }, select: { entryDate: true } })
      const newDate = body.entryDate ? new Date(body.entryDate) : null
      const hit = (entry && entry.entryDate <= through) ? entry.entryDate : (newDate && !Number.isNaN(newDate.getTime()) && newDate <= through ? newDate : null)
      if (hit) throw new AppError('CEO_ONLY_CLOSED_BOOKS', 'This change touches closed books — only the CEO can change it.', 403)
    }
  }
  const row = await insertChangeRequest(req, tenantId, entryId, body, true)
  await auditRequest(req, row, 'submit', { after: { kind: row.kind, status: row.status, totalCents: toCents(row.totalCents), entryId }, metadata: { viaHeadOfficeId: row.viaHeadOfficeId, raisedFrom: 'journals' } })
  return dtoOf(row)
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * The list: the caller's read scope (preparers) ∪ the companies whose queue the
 * caller may decide (approvalQueueTenantIds — the delegated part read through
 * serviceClient, submitted items only). 403 for a caller with neither.
 */
export async function listRequests(req: FastifyRequest, q: z.infer<typeof listQuerySchema>): Promise<{ requests: JournalRequestDto[] }> {
  const su = me(req)
  const readIds = isPreparer(su.role) ? (await resolveTenantScope(req)).tenantIds : []
  const queueIds = await approvalQueueTenantIds(req, TYPE)
  if (readIds.length === 0 && queueIds.length === 0 && !isPreparer(su.role)) {
    throw new AppError('FORBIDDEN', 'Journal requests are for Finance and the CEO', 403)
  }
  const base: Prisma.JournalRequestWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.mine ? { preparedById: su.id } : {}),
  }
  const own = readIds.length
    ? await prisma.journalRequest.findMany({ where: { ...base, tenantId: { in: readIds } }, orderBy: { createdAt: 'desc' }, take: q.limit })
    : []
  const extra = queueIds.filter((t) => !readIds.includes(t))
  const delegated = extra.length && (!q.status || q.status === 'submitted')
    ? await serviceClient.journalRequest.findMany({ where: { ...base, status: 'submitted', tenantId: { in: extra } }, orderBy: { createdAt: 'desc' }, take: q.limit })
    : []
  const rows = [...own, ...delegated].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, q.limit)
  return { requests: await toDtos(rows) }
}

/** One request: in the caller's read or member scope, or a submitted one in a queue they may decide. Else 404. */
export async function getRequest(req: FastifyRequest, id: string): Promise<JournalRequestDto> {
  const su = me(req)
  const row = await serviceClient.journalRequest.findUnique({ where: { id } })
  if (!row) throw new NotFoundError('JournalRequest', id)
  const visible = new Set<string>(isPreparer(su.role) ? [...(await resolveTenantScope(req)).tenantIds, ...(su.memberTenantIds ?? [])] : [])
  if (!visible.has(row.tenantId)) {
    const queue = row.status === 'submitted' ? await approvalQueueTenantIds(req, TYPE) : []
    if (!queue.includes(row.tenantId)) throw new NotFoundError('JournalRequest', id)
  }
  return dtoOf(row)
}

// ─── Preparer writes ─────────────────────────────────────────────────────────

/** POST: a draft (or, with submit: true, a submitted request) in the ACTIVE company. */
export async function createRequest(req: FastifyRequest, body: CreateRequestBody): Promise<JournalRequestDto> {
  const su = me(req)
  const where = await scopeTenantWhere(req, 'create')
  const tenantId = typeof where.tenantId === 'string' ? where.tenantId : null
  if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — the ledger is per company', 422)
  // A lens (head office) caller may propose here: creating is a proposal.
  await assertHoMayPropose(req, tenantId, true, 'a journal request')
  const via = await viaHeadOfficeForSubmit(req, tenantId)

  if (body.kind === 'reverse' || body.kind === 'amend') {
    const row = await insertChangeRequest(req, tenantId, body.reverseEntryId, {
      kind: body.kind, reason: body.reason, entryDate: body.entryDate,
      ...(body.kind === 'amend' ? { description: body.description, reference: body.reference, lines: body.lines } : {}),
    }, !!body.submit)
    await auditRequest(req, row, body.submit ? 'submit' : 'create', { after: { kind: row.kind, status: row.status, totalCents: toCents(row.totalCents) }, metadata: { viaHeadOfficeId: via } })
    return dtoOf(row)
  }
  let data: Prisma.JournalRequestUncheckedCreateInput
  {
    const total = await checkPostLines(tenantId, body.lines)
    data = {
      tenantId, kind: 'post', status: 'draft',
      description: body.description,
      reference: body.reference?.trim() || null,
      entryDate: body.entryDate ? new Date(body.entryDate) : null,
      lines: body.lines as Prisma.InputJsonValue,
      totalCents: total,
      preparedById: su.id, preparedByIds: [su.id], viaHeadOfficeId: via,
    }
  }
  if (body.submit) {
    data.status = 'submitted'
    data.submittedById = su.id
    data.submittedAt = new Date()
  }
  const row = await prisma.journalRequest.create({ data })
  await auditRequest(req, row, body.submit ? 'submit' : 'create', { after: { kind: row.kind, status: row.status, totalCents: toCents(row.totalCents) }, metadata: { viaHeadOfficeId: via } })
  return dtoOf(row)
}

/**
 * The caller's own request for a preparer action: 404 outside the caller's
 * write scope (members + the lens company of a submit), 403 HEAD_OFFICE_SUBMIT_ONLY
 * for a reach-only caller who is not allowed the action, 403 NOT_YOUR_REQUEST
 * for anyone but the original preparer, 409 for the wrong state.
 */
async function ownRequest(req: FastifyRequest, id: string, states: readonly string[], what: string): Promise<Row> {
  const su = me(req)
  const row = await prisma.journalRequest.findFirst({ where: { id, ...(await scopeTenantWhere(req, 'write')) } })
  if (!row) throw new NotFoundError('JournalRequest', id)
  const own = row.preparedById === su.id
  await assertHoMayPropose(req, row.tenantId, own && states.includes(row.status), what)
  if (!own) throw new AppError('NOT_YOUR_REQUEST', 'Only the person who prepared this request can change, send or withdraw it', 403)
  if (!states.includes(row.status)) {
    throw new AppError('REQUEST_NOT_EDITABLE', `This request is ${row.status} — it can't be ${what === 'withdrawing it' ? 'withdrawn' : 'changed or sent'} now`, 409)
  }
  return row
}

/** PATCH: the preparer, while draft or returned. Lines are re-validated exactly as the direct route does. */
export async function updateRequest(req: FastifyRequest, id: string, raw: unknown): Promise<JournalRequestDto> {
  const su = me(req)
  const row = await ownRequest(req, id, EDITABLE, 'editing it')
  const data: Prisma.JournalRequestUncheckedUpdateManyInput = { preparedByIds: uniq([...row.preparedByIds, su.id]) }
  if (row.kind === 'reverse') {
    const b = patchReverseSchema.parse(raw ?? {})
    if (b.reason !== undefined) data.reason = b.reason
    if (b.entryDate !== undefined) data.entryDate = b.entryDate ? new Date(b.entryDate) : null
  } else if (row.kind === 'amend') {
    const b = patchAmendSchema.parse(raw ?? {})
    if (b.reason !== undefined) data.reason = b.reason
    if (b.description !== undefined) data.description = b.description
    if (b.reference !== undefined) data.reference = b.reference?.trim() || null
    if (b.entryDate !== undefined && b.entryDate) data.entryDate = new Date(b.entryDate)
    if (b.lines !== undefined) {
      data.totalCents = await checkAmendLines(row.tenantId, b.lines)
      data.lines = b.lines as Prisma.InputJsonValue
    }
  } else {
    const b = patchPostSchema.parse(raw ?? {})
    if (b.description !== undefined) data.description = b.description
    if (b.reference !== undefined) data.reference = b.reference?.trim() || null
    if (b.entryDate !== undefined) data.entryDate = b.entryDate ? new Date(b.entryDate) : null
    if (b.lines !== undefined) {
      data.totalCents = await checkPostLines(row.tenantId, b.lines)
      data.lines = b.lines as Prisma.InputJsonValue
    }
  }
  const n = await prisma.journalRequest.updateMany({ where: { id, status: { in: [...EDITABLE] }, preparedById: su.id }, data })
  if (n.count === 0) throw new AppError('REQUEST_NOT_EDITABLE', 'This request changed meanwhile — reload it', 409)
  const after = await prisma.journalRequest.findUniqueOrThrow({ where: { id } })
  await auditRequest(req, after, 'update', { before: { description: row.description, totalCents: toCents(row.totalCents), entryDate: row.entryDate }, after: { description: after.description, totalCents: toCents(after.totalCents), entryDate: after.entryDate } })
  return dtoOf(after)
}

/** Submit (draft or returned → submitted): re-checked, stamped with the head office it came through. */
export async function submitRequest(req: FastifyRequest, id: string): Promise<JournalRequestDto> {
  const su = me(req)
  const row = await ownRequest(req, id, EDITABLE, 'sending it for approval')
  if (JR_CHANGE_KINDS.includes(row.kind)) await checkChangeTarget(prisma, row.tenantId, row.reverseEntryId!, row.id)
  if (row.kind === 'amend') await checkAmendLines(row.tenantId, linesOf(row))
  else if (row.kind === 'post') await checkPostLines(row.tenantId, linesOf(row))
  const via = await viaHeadOfficeForSubmit(req, row.tenantId)
  const n = await prisma.journalRequest.updateMany({
    where: { id, status: { in: [...EDITABLE] }, preparedById: su.id },
    data: {
      status: 'submitted', submittedById: su.id, submittedAt: new Date(), viaHeadOfficeId: via, preparedByIds: uniq([...row.preparedByIds, su.id]),
      // A resubmitted (returned) request is undecided again: clear the return's decider fields.
      // decisionNote stays as the LAST RETURN's note so the preparer and approver still see why it
      // came back (the full history is in the audit log); it never means "decided" on its own.
      decidedById: null, decidedAt: null, decidedVia: null, delegationId: null,
    },
  })
  if (n.count === 0) throw new AppError('REQUEST_NOT_EDITABLE', 'This request changed meanwhile — reload it', 409)
  const after = await prisma.journalRequest.findUniqueOrThrow({ where: { id } })
  await auditRequest(req, after, 'submit', { metadata: { from: row.status, viaHeadOfficeId: via } })
  return dtoOf(after)
}

/** Withdraw (draft, submitted or returned → withdrawn): the preparer. */
export async function withdrawRequest(req: FastifyRequest, id: string): Promise<JournalRequestDto> {
  const su = me(req)
  const row = await ownRequest(req, id, WITHDRAWABLE, 'withdrawing it')
  const n = await prisma.journalRequest.updateMany({
    where: { id, status: { in: [...WITHDRAWABLE] }, preparedById: su.id },
    data: { status: 'withdrawn', preparedByIds: uniq([...row.preparedByIds, su.id]) },
  })
  if (n.count === 0) throw new AppError('REQUEST_NOT_EDITABLE', 'This request changed meanwhile — reload it', 409)
  const after = await prisma.journalRequest.findUniqueOrThrow({ where: { id } })
  await auditRequest(req, after, 'withdraw', { metadata: { from: row.status } })
  return dtoOf(after)
}

// ─── Decisions ───────────────────────────────────────────────────────────────

/** A5: the facts on serviceClient, then the right; 404 when there is no such request. */
async function rightTo(req: FastifyRequest, id: string, action: string): Promise<ApprovalGrant> {
  const s = await approvalSubject(TYPE, id)
  if (!s) throw new NotFoundError('JournalRequest', id)
  // approvalInputOf makes kind 'reverse' CEO only (ceoOnly), never handed over.
  return assertCanApprove(req, approvalInputOf(TYPE, id, s, { entity: 'JournalRequest', action }))
}

/** The claim: submitted → posted, by someone not among the preparers (non-admins). */
function claimWhere(id: string, actor: { id: string; role: string }): Prisma.JournalRequestWhereInput {
  return { id, status: 'submitted', ...(actor.role === 'admin' ? {} : { NOT: { preparedByIds: { has: actor.id } } }) }
}

/**
 * Approve: kind post → postManualJournal (`manual:<requestId>`); kind reverse →
 * reverseManualJournal (CEO only). One transaction with the claim: a refused
 * posting answers 422 and the request stays submitted.
 */
export async function approveRequest(req: FastifyRequest, id: string): Promise<{ request: JournalRequestDto; entryId: string; reversalId: string | null }> {
  const su = me(req)
  const grant = await rightTo(req, id, 'approve a journal request')
  const row = await prisma.journalRequest.findUnique({ where: { id } })
  if (!row) throw new NotFoundError('JournalRequest', id)
  if (row.status !== 'submitted') throw new AppError('REQUEST_NOT_PENDING', `This request is ${row.status}, not waiting for approval`, 409)
  const tenantId = row.tenantId // A19
  const now = new Date()
  const preparers = uniq([row.preparedById, row.submittedById, ...row.preparedByIds])
  const auditMeta = { journalRequestId: row.id, preparedById: row.preparedById, preparedByIds: preparers, viaHeadOfficeId: row.viaHeadOfficeId }

  const { entryId, reversalId, sideEffects } = await prisma.$transaction(async (tx) => {
    const claim = await tx.journalRequest.updateMany({
      where: claimWhere(id, su),
      data: { status: 'posted', decidedById: su.id, decidedAt: now, decidedVia: grant.via, delegationId: grant.delegationId ?? null },
    })
    if (claim.count === 0) throw new AppError('REQUEST_NOT_PENDING', 'This request is no longer waiting for approval', 409)
    try {
      if (JR_CHANGE_KINDS.includes(row.kind)) {
        if (su.role !== 'admin') throw new AppError('APPROVAL_NOT_YOURS', 'This needs the CEO', 403)
        // The entry as it was when the change was raised: nothing moved, nothing reversed since (409 ENTRY_CHANGED).
        await lockEntryChangeTx(tx, tenantId, row.reverseEntryId!)
        const target = await tx.journalEntry.findFirst({ where: { id: row.reverseEntryId!, tenantId }, include: { lines: true } })
        if (!target) throw new AppError('ENTRY_CHANGED', 'The entry this request changes is gone', 409)
        const fp = metaOf(row).fingerprint
        if ((target.reference && await manualReversalOf(tx, tenantId, target.reference)) || (fp && fp !== entryFingerprint(target))) {
          throw new AppError('ENTRY_CHANGED', 'The entry changed (or was reversed) after this request was raised — send it back so it can be raised again on the entry as it is now.', 409)
        }
      }
      if (row.kind === 'amend') {
        const a = await amendManualJournal(tx, {
          tenantId, entryId: row.reverseEntryId!, reason: row.reason ?? 'Edit approved',
          description: row.description, reference: row.reference, entryDate: row.entryDate, lines: linesOf(row),
          actorId: su.id, actor: { email: su.email, ip: req.ip }, sourceId: row.id, metadata: auditMeta,
        })
        // The corrected entry's payment label: the one asked for, else the original's (an edit never drops it).
        const prior = await tx.paymentClassification.findUnique({ where: { journalEntryId: row.reverseEntryId! } })
        const carried = metaOf(row).classification
          ?? (prior ? { classification: prior.classification, taxStatus: prior.taxStatus, nonDeductionReason: prior.nonDeductionReason } as ClassificationInput : null)
        await classifyPaymentTx(tx, { journalEntryId: a.entry.id, input: carried, setById: su.id, tenantId })
        await tx.journalRequest.update({ where: { id }, data: { postedEntryId: a.entry.id } })
        return { entryId: a.entry.id, reversalId: a.reversal.id as string | null, sideEffects: async () => { await a.reversedFx(); await a.postedFx() } }
      }
      if (row.kind === 'reverse') {
        const r = await reverseManualJournal(tx, {
          tenantId, entryId: row.reverseEntryId!, reason: row.reason ?? 'Reversal approved',
          actorId: su.id, entryDate: row.entryDate, actor: { email: su.email, ip: req.ip }, metadata: auditMeta,
        })
        await tx.journalRequest.update({ where: { id }, data: { postedEntryId: r.reversal.id } })
        return { entryId: r.reversal.id, reversalId: r.reversal.id as string | null, sideEffects: r.sideEffects }
      }
      const p = await postManualJournal(tx, {
        tenantId,
        description: row.description,
        reference: row.reference,
        entryDate: row.entryDate,
        lines: linesOf(row),
        postedBy: su.id,
        sourceId: row.id, // → `manual:<requestId>`
        actor: { id: su.id, email: su.email, ip: req.ip },
        metadata: auditMeta,
        flagNote: `Prepared as journal request ${row.id.slice(0, 8)}.`,
      })
      await tx.journalRequest.update({ where: { id }, data: { postedEntryId: p.entry.id } })
      return { entryId: p.entry.id, reversalId: null as string | null, sideEffects: p.sideEffects }
    } catch (e) {
      throw e instanceof AppError && e.statusCode === 403 ? e : asRefusal(e)
    }
  }, TX_OPTS)

  await sideEffects()
  await auditApproval(req, { type: TYPE, id, tenantId, decision: 'approve', grant, entity: 'JournalRequest', metadata: { entryId, kind: row.kind } })
  const after = await prisma.journalRequest.findUniqueOrThrow({ where: { id } })
  return { request: await dtoOf(after), entryId, reversalId }
}

/** Reject {note}: submitted → returned (the preparer may edit and send it again). */
export async function rejectRequest(req: FastifyRequest, id: string, note: string): Promise<JournalRequestDto> {
  const su = me(req)
  const grant = await rightTo(req, id, 'return a journal request')
  const row = await prisma.journalRequest.findUnique({ where: { id } })
  if (!row) throw new NotFoundError('JournalRequest', id)
  if (JR_CHANGE_KINDS.includes(row.kind) && note.trim().length < CHANGE_NOTE_MIN) {
    throw new AppError('NOTE_TOO_SHORT', `Say why (at least ${CHANGE_NOTE_MIN} characters)`, 422)
  }
  const n = await prisma.journalRequest.updateMany({
    where: claimWhere(id, su),
    data: { status: 'returned', decidedById: su.id, decidedAt: new Date(), decisionNote: note, decidedVia: grant.via, delegationId: grant.delegationId ?? null },
  })
  if (n.count === 0) throw new AppError('REQUEST_NOT_PENDING', `This request is ${row.status}, not waiting for approval`, 409)
  await auditApproval(req, { type: TYPE, id, tenantId: row.tenantId, decision: 'reject', grant, entity: 'JournalRequest', metadata: { note, kind: row.kind } })
  const after = await prisma.journalRequest.findUniqueOrThrow({ where: { id } })
  return dtoOf(after)
}

// ─── The change a request makes (Journals tab, 2026-10-23) ───────────────────

export interface DiffLine {
  id?: string
  accountId: string
  accountCode: string | null
  accountName: string | null
  type: 'debit' | 'credit'
  amountCents: number
  conceptId: string | null
  conceptName: string | null
  memo: string | null
  subAccountId?: string | null
}

/**
 * GET /accounting/journal-requests/:id/diff — the entry as it is now vs what the
 * request proposes (amend), or the entry the request cancels (reverse). Same
 * visibility as GET /:id (foreign → 404). `stale` = the entry moved or was
 * reversed since the request was raised (approval would answer ENTRY_CHANGED).
 */
export async function requestDiff(req: FastifyRequest, id: string) {
  const request = await getRequest(req, id)
  if (!request.targetEntryId) throw new AppError('NOT_A_CHANGE_REQUEST', 'This request posts a new entry — it changes no existing one', 422)
  const row = await serviceClient.journalRequest.findUniqueOrThrow({ where: { id } })
  const e = await serviceClient.journalEntry.findFirst({
    where: { id: request.targetEntryId, tenantId: row.tenantId },
    include: { lines: { include: { account: { select: { code: true, name: true } } } } },
  })
  if (!e) throw new NotFoundError('JournalEntry', request.targetEntryId)
  const proposedLines = row.kind === 'amend' ? linesOf(row) : []
  const accountIds = [...new Set(proposedLines.map((l) => l.accountId))]
  const conceptIds = [...new Set([...e.lines.map((l) => l.conceptId), ...proposedLines.map((l) => l.conceptId)].filter((c): c is string => !!c))]
  const [accounts, concepts] = await Promise.all([
    accountIds.length ? serviceClient.account.findMany({ where: { id: { in: accountIds }, tenantId: row.tenantId }, select: { id: true, code: true, name: true } }) : [],
    conceptIds.length ? serviceClient.concept.findMany({ where: { id: { in: conceptIds }, tenantId: row.tenantId }, select: { id: true, name: true } }) : [],
  ])
  const acc = new Map(accounts.map((a) => [a.id, a]))
  const brand = new Map(concepts.map((c) => [c.id, c.name]))
  const current: DiffLine[] = e.lines.map((l) => ({
    id: l.id, accountId: l.accountId, accountCode: l.account.code, accountName: l.account.name, type: l.type, amountCents: toCents(l.amountCents),
    conceptId: l.conceptId, conceptName: l.conceptId ? (brand.get(l.conceptId) ?? null) : null, memo: l.memo,
  }))
  const proposed: DiffLine[] = proposedLines.map((l) => ({
    accountId: l.accountId, accountCode: acc.get(l.accountId)?.code ?? null, accountName: acc.get(l.accountId)?.name ?? null,
    type: l.type, amountCents: l.amountCents, conceptId: l.conceptId ?? null, conceptName: l.conceptId ? (brand.get(l.conceptId) ?? null) : null, memo: l.memo?.trim() || null,
    subAccountId: l.subAccountId ?? null,
  }))
  const key = (l: DiffLine) => `${l.accountId}|${l.type}|${l.amountCents}|${l.conceptId ?? ''}`
  const left = [...current]
  const added: DiffLine[] = []
  for (const p of proposed) {
    const i = left.findIndex((c) => key(c) === key(p))
    if (i >= 0) left.splice(i, 1); else added.push(p)
  }
  const removed = row.kind === 'amend' ? left : current
  const sum = (ls: DiffLine[]) => ls.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
  const cur = splitDescription(e.description)
  const reversed = !!(e.reference && await manualReversalOf(serviceClient, row.tenantId, e.reference))
  const fp = metaOf(row).fingerprint
  return {
    request,
    entry: {
      id: e.id, voucherNo: e.voucherNo, reference: e.reference, entryDate: e.entryDate.toISOString(),
      description: cur.description, operatorReference: cur.reference, totalCents: sum(current), lines: current, reversed,
    },
    proposed: row.kind === 'amend'
      ? { entryDate: row.entryDate?.toISOString() ?? e.entryDate.toISOString(), description: row.description, operatorReference: row.reference, totalCents: sum(proposed), lines: proposed }
      : null,
    changes: {
      kind: row.kind as 'amend' | 'reverse',
      date: row.kind === 'amend' && !!row.entryDate && row.entryDate.getTime() !== e.entryDate.getTime(),
      description: row.kind === 'amend' && row.description !== cur.description,
      reference: row.kind === 'amend' && (row.reference ?? null) !== (cur.reference ?? null),
      totalBeforeCents: sum(current),
      totalAfterCents: row.kind === 'amend' ? sum(proposed) : 0,
      linesAdded: added,
      linesRemoved: removed,
    },
    stale: reversed || (!!fp && fp !== entryFingerprint(e)),
  }
}

/** Every change request (reverse / amend) raised against an entry, newest first — the entry's history in the Journals tab. */
export async function requestsForEntry(tenantId: string, entryId: string): Promise<JournalRequestDto[]> {
  const rows = await prisma.journalRequest.findMany({
    where: { tenantId, reverseEntryId: entryId, kind: { in: [...JR_CHANGE_KINDS] } },
    orderBy: { createdAt: 'desc' },
  })
  return toDtos(rows)
}
