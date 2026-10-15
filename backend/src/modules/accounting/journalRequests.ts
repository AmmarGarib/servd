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
import { toCents } from '../../lib/money.js'
import { resolveTenantScope, scopeTenantWhere } from '../../lib/tenantScope.js'
import { assertHoMayPropose, viaHeadOfficeForSubmit } from '../../lib/headOffice.js'
import {
  approvalInputOf, approvalQueueTenantIds, approvalSubject, assertCanApprove, auditApproval,
  type ApprovalGrant,
} from '../../lib/approvalRights.js'
import {
  assertManualLines, assertReversible, manualLineSchema, postManualJournal, reverseManualJournal,
  type ManualJournalLine,
} from './manualJournal.js'

/** Who prepares (creates, edits, submits, withdraws) a journal request. */
export const JR_PREPARERS = ['admin', 'owner', 'management', 'finance'] as const
export const JR_STATUSES = ['draft', 'submitted', 'returned', 'posted', 'withdrawn'] as const
export type JournalRequestStatus = (typeof JR_STATUSES)[number]
export const JR_KINDS = ['post', 'reverse'] as const

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

export const createRequestSchema = z.union([
  z.object({ kind: z.literal('post').optional(), ...postFields, submit: z.boolean().optional() }),
  z.object({ kind: z.literal('reverse'), ...reverseFields, submit: z.boolean().optional() }),
])
export type CreateRequestBody = z.infer<typeof createRequestSchema>

export const patchPostSchema = z.object({
  description: postFields.description.optional(),
  reference: postFields.reference,
  entryDate: postFields.entryDate,
  lines: postFields.lines.optional(),
})
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
    if (e.statusCode === 409 && ['REQUEST_NOT_PENDING', 'ALREADY_POSTED', 'ALREADY_REVERSED', 'TAX_PAYMENT_LINKED'].includes(e.code)) return e
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
  decisionNote: string | null
  decidedVia: string | null
  postedEntryId: string | null
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

/** Validate a post request's lines in its company (the direct route's checks); returns the total. */
async function checkPostLines(tenantId: string, lines: ManualJournalLine[]): Promise<number> {
  const { debits } = await assertManualLines(prisma, tenantId, lines)
  return debits
}

/** A reverse request's entry: a manual entry of this company, not reversed, not already asked for. */
async function checkReverseTarget(tenantId: string, entryId: string, exceptRequestId?: string) {
  const r = await assertReversible(prisma, tenantId, entryId, { checkAlready: true })
  const open = await prisma.journalRequest.findFirst({
    where: {
      tenantId, kind: 'reverse', reverseEntryId: entryId, status: { in: ['draft', 'submitted', 'returned'] },
      ...(exceptRequestId ? { NOT: { id: exceptRequestId } } : {}),
    },
    select: { id: true },
  })
  if (open) throw new AppError('REVERSAL_ALREADY_REQUESTED', 'A reversal of this entry is already being prepared or waiting for approval.', 409, { requestId: open.id })
  return r
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

  let data: Prisma.JournalRequestUncheckedCreateInput
  if (body.kind === 'reverse') {
    const { original, amountCents } = await checkReverseTarget(tenantId, body.reverseEntryId)
    data = {
      tenantId, kind: 'reverse', status: 'draft',
      description: `Reverse: ${original.description}`.slice(0, 500),
      reference: original.reference,
      entryDate: body.entryDate ? new Date(body.entryDate) : null,
      lines: [],
      totalCents: amountCents,
      reverseEntryId: original.id,
      reason: body.reason,
      preparedById: su.id, preparedByIds: [su.id], viaHeadOfficeId: via,
    }
  } else {
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
  if (row.kind === 'reverse') await checkReverseTarget(row.tenantId, row.reverseEntryId!, row.id)
  else await checkPostLines(row.tenantId, linesOf(row))
  const via = await viaHeadOfficeForSubmit(req, row.tenantId)
  const n = await prisma.journalRequest.updateMany({
    where: { id, status: { in: [...EDITABLE] }, preparedById: su.id },
    data: { status: 'submitted', submittedById: su.id, submittedAt: new Date(), viaHeadOfficeId: via, preparedByIds: uniq([...row.preparedByIds, su.id]) },
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
export async function approveRequest(req: FastifyRequest, id: string): Promise<{ request: JournalRequestDto; entryId: string }> {
  const su = me(req)
  const grant = await rightTo(req, id, 'approve a journal request')
  const row = await prisma.journalRequest.findUnique({ where: { id } })
  if (!row) throw new NotFoundError('JournalRequest', id)
  if (row.status !== 'submitted') throw new AppError('REQUEST_NOT_PENDING', `This request is ${row.status}, not waiting for approval`, 409)
  const tenantId = row.tenantId // A19
  const now = new Date()
  const preparers = uniq([row.preparedById, row.submittedById, ...row.preparedByIds])
  const auditMeta = { journalRequestId: row.id, preparedById: row.preparedById, preparedByIds: preparers, viaHeadOfficeId: row.viaHeadOfficeId }

  const { entryId, sideEffects } = await prisma.$transaction(async (tx) => {
    const claim = await tx.journalRequest.updateMany({
      where: claimWhere(id, su),
      data: { status: 'posted', decidedById: su.id, decidedAt: now, decidedVia: grant.via, delegationId: grant.delegationId ?? null },
    })
    if (claim.count === 0) throw new AppError('REQUEST_NOT_PENDING', 'This request is no longer waiting for approval', 409)
    try {
      if (row.kind === 'reverse') {
        if (su.role !== 'admin') throw new AppError('APPROVAL_NOT_YOURS', 'This needs the CEO', 403)
        const r = await reverseManualJournal(tx, {
          tenantId, entryId: row.reverseEntryId!, reason: row.reason ?? 'Reversal approved',
          actorId: su.id, entryDate: row.entryDate, actor: { email: su.email, ip: req.ip }, metadata: auditMeta,
        })
        await tx.journalRequest.update({ where: { id }, data: { postedEntryId: r.reversal.id } })
        return { entryId: r.reversal.id, sideEffects: r.sideEffects }
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
      return { entryId: p.entry.id, sideEffects: p.sideEffects }
    } catch (e) {
      throw e instanceof AppError && e.statusCode === 403 ? e : asRefusal(e)
    }
  }, TX_OPTS)

  await sideEffects()
  await auditApproval(req, { type: TYPE, id, tenantId, decision: 'approve', grant, entity: 'JournalRequest', metadata: { entryId, kind: row.kind } })
  const after = await prisma.journalRequest.findUniqueOrThrow({ where: { id } })
  return { request: await dtoOf(after), entryId }
}

/** Reject {note}: submitted → returned (the preparer may edit and send it again). */
export async function rejectRequest(req: FastifyRequest, id: string, note: string): Promise<JournalRequestDto> {
  const su = me(req)
  const grant = await rightTo(req, id, 'return a journal request')
  const row = await prisma.journalRequest.findUnique({ where: { id } })
  if (!row) throw new NotFoundError('JournalRequest', id)
  const n = await prisma.journalRequest.updateMany({
    where: claimWhere(id, su),
    data: { status: 'returned', decidedById: su.id, decidedAt: new Date(), decisionNote: note, decidedVia: grant.via, delegationId: grant.delegationId ?? null },
  })
  if (n.count === 0) throw new AppError('REQUEST_NOT_PENDING', `This request is ${row.status}, not waiting for approval`, 409)
  await auditApproval(req, { type: TYPE, id, tenantId: row.tenantId, decision: 'reject', grant, entity: 'JournalRequest', metadata: { note, kind: row.kind } })
  const after = await prisma.journalRequest.findUniqueOrThrow({ where: { id } })
  return dtoOf(after)
}
