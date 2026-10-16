// /accounting/receivables/write-offs — bad-debt write-off of an ordinary
// receivable invoice (G12; accountant default H15: a direct write-off with a
// reason and evidence, no provision). The CEO approves every one.
//
//   request   finance / management / owner / CEO (WRITE_OFF_REQUESTERS) asks
//             to write off part or all of what an invoice still owes, with a
//             reason (10-500 characters) and 1-5 evidence files (JPEG / PNG /
//             WebP / PDF, ≤ 3 MB each, lib/evidenceFile.ts). One open request
//             per invoice (409 WRITE_OFF_OPEN); never more than the balance
//             (409 WRITE_OFF_EXCEEDS_BALANCE). A credit note or a void invoice
//             → 409. An on-account client's statement (kind 'statement') is
//             written off like an invoice. A request the CEO raises applies at
//             once — the CEO is the final authority (owner decision 27).
//   approve   the CEO (role admin) only. Separation of duties goes through
//             lib/separation-of-duties.ts assertNotSelfApproval (the CEO is
//             exempt). One transaction: lock the client (if any) → lock the
//             invoice → claim requested → approved → the amount is still ≤ the
//             balance (a payment may have come in since: 409) → writtenOffCents
//             += amount → post → status → suspend the client.
//   reject    the CEO, with a note. cancel: the requester or any requester role.
//   recover   money received later on a written-off amount: the write-off's
//             recoveredCents and the invoice's paidCents go up, writtenOffCents
//             down (the balance is unchanged) — 409 OVER_RECOVERY above what
//             is left. Reversing that payment (bounced cheque) on
//             /:invoiceId/payments/:paymentId/reverse restores both (routes.ts).
//
// Postings — in the INVOICE's company, inside the document's transaction:
//   receivable.write_off:<writeOffId>
//       Dr 6160 Bad Debts (the invoice's brand) / Cr 1110 — the full amount,
//       tax included (no sales-tax bad-debt relief). Dated at approval; a
//       closed period → 422 PERIOD_LOCKED and nothing is saved.
//       A STATEMENT splits the Dr 6160 per brand, pro rata to the net
//       (amount − refunded) of the charges it billed; the rounding remainder
//       goes on the largest line. Cr 1110 stays one line.
//   receivable.write_off_recovery:<paymentId>
//       Dr 1110 / Cr 6160, and with it
//   receivable.payment:<paymentId>
//       Dr the account the money went into (lib/bankAccounts.ts
//       moneyAccountCode, the invoice's company) / Cr 1110.
//       Both dated receivedAt (user-entered: a closed month → 422). Both
//       descriptions and the money line's memo carry the method and the
//       payment reference # (required for every method — owner, 2026-10-14).
//
// Client suspension: any approved write-off on an on-account client's invoice
// or statement suspends the client (status 'suspended', statusReason
// 'bad_debt_written_off') in the same transaction, so the till refuses its
// next charge (ON_ACCOUNT_NOT_ACTIVE). Only the CEO reactivates a client. A
// closed client stays closed.
//
// Lock order (receivables/onAccount.ts LOCK ORDER): the client account first
// (lockAccountTx) when the invoice has one, then the invoice row
// (lockInvoice), then the write-off row — on request, approve and recover.
// Files are decoded before the transaction opens.

import { auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma, ReceivableInvoice, ReceivableWriteOff, UserRole } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { ACCT, postJournalEntry } from '../accounting/journal.js'
import { assertTemplateAccounts } from '../../lib/chartOfAccounts.js'
import { toCents, zMoneyCents } from '../../lib/money.js'
import { moneyAccountCode, zPaymentRef, assertPaymentReference, receiptText } from '../../lib/bankAccounts.js'
import { findPaymentReferenceUses } from '../../lib/paymentRefs.js'
import { decodeEvidenceFile, sendEvidence, EVIDENCE_MAX_BYTES } from '../../lib/evidenceFile.js'
import { assertNotSelfApproval } from '../../lib/separation-of-duties.js'
import { findInScope, lockInvoice, restatus, assertLiveInvoice, balanceOf, totalOf, receiptMethodIn, receiptMemo } from './routes.js'
import { STATEMENT } from './ledger.js'
import { chargeNetCents, lockAccountTx } from './onAccount.js'

type Tx = Prisma.TransactionClient

/** Who may ask for a write-off, cancel one or record a recovery. Approving is the CEO's alone. */
export const WRITE_OFF_REQUESTERS = ['admin', 'owner', 'management', 'finance'] as UserRole[]
export const WRITE_OFF_STATUSES = ['requested', 'approved', 'rejected', 'cancelled'] as const

const BAD_DEBTS = ACCT.BAD_DEBTS     // 6160
const RECEIVABLE = ACCT.CUSTOMER_AR  // 1110
const MAX_FILES = 5
/** Five files of 3 MB as base64 (≈ 4 MB each) and the rest of the body. */
const REQUEST_BODY_LIMIT = 20 * 1024 * 1024
const PKT_OFFSET_MS = 5 * 3_600_000

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}/)
const isRequesterRole = (role: string) => (WRITE_OFF_REQUESTERS as readonly string[]).includes(role)
const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK')}`
const pktDay = (d: Date) => new Date(d.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10)
const staffOf = (req: FastifyRequest) => ({ userId: req.staffUser!.id, userEmail: req.staffUser!.email })

const EvidenceFile = z.object({
  fileName: z.string().trim().min(1).max(200),
  mime: z.string().trim().min(1).max(100),
  data: z.string().min(1),
})

// ─── Shapes ──────────────────────────────────────────────────────────────────

const WRITE_OFF_INCLUDE = {
  // File METADATA only — the bytes are read by GET /:id/evidence/:fileId alone.
  attachments: {
    select: { id: true, fileName: true, mime: true, sizeBytes: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.ReceivableWriteOffInclude
type WriteOffRow = Prisma.ReceivableWriteOffGetPayload<{ include: typeof WRITE_OFF_INCLUDE }>

interface Caller { id: string; role: string }

/** What the caller may do with this write-off — the admin keeps no role list. */
function capabilities(w: Pick<ReceivableWriteOff, 'status' | 'requestedById' | 'amountCents' | 'recoveredCents'>, me: Caller) {
  const requested = w.status === 'requested'
  return {
    canApprove: requested && me.role === 'admin',
    canReject: requested && me.role === 'admin',
    canCancel: requested && (isRequesterRole(me.role) || w.requestedById === me.id),
    canRecover: w.status === 'approved' && isRequesterRole(me.role) && toCents(w.recoveredCents) < toCents(w.amountCents),
  }
}

/** Rows as every route returns them: the write-off, its invoice, names and the caller's capability flags (never file bytes). */
async function shape(rows: WriteOffRow[], me: Caller) {
  if (rows.length === 0) return []
  const invoiceIds = [...new Set(rows.map((r) => r.invoiceId))]
  const userIds = [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter((x): x is string => !!x))]
  const [invoices, users] = await Promise.all([
    prisma.receivableInvoice.findMany({ where: { id: { in: invoiceIds } } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
  ])
  const conceptIds = [...new Set(invoices.map((i) => i.conceptId).filter((x): x is string => !!x))]
  const concepts = conceptIds.length
    ? await prisma.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, name: true } })
    : []
  const invById = new Map(invoices.map((i) => [i.id, i]))
  const nameOf = new Map(users.map((u) => [u.id, u.name ?? u.email ?? null]))
  const brandOf = new Map(concepts.map((c) => [c.id, c.name]))
  return rows.map((r) => {
    const inv = invById.get(r.invoiceId)
    const amountCents = toCents(r.amountCents)
    const recoveredCents = toCents(r.recoveredCents)
    return {
      ...r,
      amountCents,
      recoveredCents,
      recoverableCents: r.status === 'approved' ? amountCents - recoveredCents : 0,
      invoiceNumber: inv?.number ?? null,
      customerName: inv?.customerName ?? null,
      conceptId: inv?.conceptId ?? null,
      conceptName: inv?.conceptId ? brandOf.get(inv.conceptId) ?? null : null,
      invoice: inv
        ? {
            id: inv.id, number: inv.number, customerName: inv.customerName, status: inv.status,
            issueDate: inv.issueDate, dueDate: inv.dueDate,
            totalCents: totalOf(inv), balanceCents: balanceOf(inv), writtenOffCents: toCents(inv.writtenOffCents),
          }
        : null,
      requestedByName: nameOf.get(r.requestedById) ?? null,
      decidedByName: r.decidedById ? nameOf.get(r.decidedById) ?? null : null,
      ...capabilities(r, me),
    }
  })
}

const callerOf = (req: FastifyRequest): Caller => ({ id: req.staffUser!.id, role: req.staffUser!.role })

/** The write-off, or 404 — never another company's. */
async function findWriteOff(req: FastifyRequest, id: string, mode: ScopeMode): Promise<WriteOffRow> {
  const w = await prisma.receivableWriteOff.findFirst({
    where: { id, ...(await scopeTenantWhere(req, mode)) },
    include: WRITE_OFF_INCLUDE,
  })
  if (!w) throw new NotFoundError('ReceivableWriteOff', id)
  return w
}

const reload = async (id: string, me: Caller) =>
  (await shape([await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id }, include: WRITE_OFF_INCLUDE })], me))[0]!

const notPending = (w: Pick<ReceivableWriteOff, 'status'>) =>
  new AppError('WRITE_OFF_NOT_PENDING', `This write-off is ${w.status}, not waiting for a decision — reload it`, 409)

const exceedsBalance = (balanceCents: number) => new AppError(
  'WRITE_OFF_EXCEEDS_BALANCE',
  balanceCents > 0
    ? `That is more than the invoice still owes (${pkr(balanceCents)})`
    : 'Nothing is owed on this invoice any more — there is nothing to write off',
  409,
  { balanceCents: Math.max(0, balanceCents) },
)

/** A P2002 on receivable_write_offs_one_open: another request for this invoice got in first. */
function isOneOpenClash(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown }; message?: string }
  if (e.code === 'P2002') return true
  return typeof e.message === 'string' && e.message.includes('receivable_write_offs_one_open')
}
/** statusReason written on a client suspended by an approved write-off. */
export const BAD_DEBT_SUSPENSION_REASON = 'bad_debt_written_off'

/**
 * Lock the invoice's on-account client (when it has one, in the invoice's
 * company), then the invoice — the shared LOCK ORDER. `invoiceId`'s
 * customerAccountId never changes after issue, so reading it unlocked first
 * is safe. Returns the locked invoice and the locked client id (or null).
 */
async function lockClientThenInvoice(tx: Tx, invoiceId: string): Promise<{ inv: ReceivableInvoice; accountId: string | null }> {
  const head = await tx.receivableInvoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { tenantId: true, customerAccountId: true } })
  let accountId: string | null = null
  if (head.customerAccountId) {
    const acct = await lockAccountTx(tx, head.customerAccountId)
    // Never touch another company's client, whatever the row says.
    if (acct.tenantId === head.tenantId) accountId = acct.id
  }
  const inv = await lockInvoice(tx, invoiceId)
  return { inv, accountId }
}

export interface DebitLine { conceptId: string | null; amountCents: number }

/**
 * Split `amountCents` across brands pro rata to `weights` (net cents per
 * brand). Each share is floored; the remainder goes to the line with the
 * largest weight (ties: the first). Zero-weight brands get no line; with no
 * positive weight at all, one line on `fallbackConceptId`. Σ = amountCents.
 */
export function splitProRata(amountCents: number, weights: Array<{ conceptId: string; weightCents: number }>, fallbackConceptId: string | null): DebitLine[] {
  const live = weights.filter((w) => w.weightCents > 0)
  const total = live.reduce((t, w) => t + w.weightCents, 0)
  if (live.length === 0 || total <= 0) return [{ conceptId: fallbackConceptId, amountCents }]
  const lines = live.map((w) => ({ conceptId: w.conceptId, amountCents: Math.floor((amountCents * w.weightCents) / total), weight: w.weightCents }))
  const given = lines.reduce((t, l) => t + l.amountCents, 0)
  let largest = 0
  for (let i = 1; i < lines.length; i++) if (lines[i]!.weight > lines[largest]!.weight) largest = i
  lines[largest]!.amountCents += amountCents - given
  return lines.filter((l) => l.amountCents > 0).map(({ conceptId, amountCents: a }) => ({ conceptId, amountCents: a }))
}

/** The Dr 6160 lines of a write-off: one on the invoice's brand, or per brand of the statement's charges. */
async function badDebtLines(tx: Tx, inv: ReceivableInvoice, amountCents: number): Promise<DebitLine[]> {
  if (inv.kind !== STATEMENT) return [{ conceptId: inv.conceptId, amountCents }]
  const charges = await tx.customerAccountCharge.findMany({
    where: { tenantId: inv.tenantId, statementInvoiceId: inv.id },
    select: { conceptId: true, amountCents: true, refundedCents: true },
    orderBy: [{ chargedAt: 'asc' }, { id: 'asc' }],
  })
  const byBrand = new Map<string, number>()
  for (const c of charges) byBrand.set(c.conceptId, (byBrand.get(c.conceptId) ?? 0) + chargeNetCents(c))
  return splitProRata(amountCents, [...byBrand].map(([conceptId, weightCents]) => ({ conceptId, weightCents })), inv.conceptId)
}

const writeOffOpen = () => new AppError('WRITE_OFF_OPEN', 'A write-off of this invoice is already waiting for the CEO — decide or cancel that one first', 409)

// ─── Approve (the one place a write-off reaches the books) ───────────────────

/**
 * Apply a requested write-off inside `tx`: lock the invoice → claim requested
 * → approved → re-check the balance → writtenOffCents += amount → post
 * 'receivable.write_off:<id>' Dr 6160 / Cr 1110 in the invoice's company,
 * dated now → status. Anything refused (a payment took the balance below the
 * amount, a missing 6160, a period closed through today) rolls all of it back.
 */
async function applyWriteOffTx(tx: Tx, writeOffId: string, actorId: string, note: string | null): Promise<{ suspendedAccountId: string | null }> {
  const pending = await tx.receivableWriteOff.findUniqueOrThrow({ where: { id: writeOffId } })
  const { inv, accountId } = await lockClientThenInvoice(tx, pending.invoiceId)
  assertLiveInvoice(inv)
  const now = new Date()
  const claimed = await tx.receivableWriteOff.updateMany({
    where: { id: writeOffId, status: 'requested' },
    data: { status: 'approved', decidedById: actorId, decidedAt: now, decisionNote: note },
  })
  if (claimed.count === 0) throw notPending(await tx.receivableWriteOff.findUniqueOrThrow({ where: { id: writeOffId } }))
  const amount = toCents(pending.amountCents)
  const balance = balanceOf(inv)
  if (amount > balance) throw exceedsBalance(balance)
  await assertTemplateAccounts(tx, inv.tenantId, [BAD_DEBTS, RECEIVABLE])
  await tx.receivableInvoice.update({ where: { id: inv.id }, data: { writtenOffCents: { increment: amount } } })
  const debits = await badDebtLines(tx, inv, amount)
  const posted = await postJournalEntry({
    tenantId: inv.tenantId,
    sourceType: 'receivable.write_off',
    sourceId: writeOffId,
    description: `Bad debt written off on ${inv.number} — ${inv.customerName}: ${pending.reason}`.slice(0, 500),
    entryDate: now,
    postedBy: actorId,
    lines: [
      ...debits.map((d) => ({ accountCode: BAD_DEBTS, type: 'debit' as const, amountCents: d.amountCents, conceptId: d.conceptId })),
      { accountCode: RECEIVABLE, type: 'credit', amountCents: amount, conceptId: inv.conceptId },
    ],
  }, { tx })
  await tx.receivableWriteOff.update({ where: { id: writeOffId }, data: { journalEntryId: posted.entryId } })
  await restatus(tx, inv.id)
  // The client is suspended with the write-off (a closed client stays closed).
  let suspendedAccountId: string | null = null
  if (accountId) {
    const s = await tx.customerAccount.updateMany({
      where: { id: accountId, tenantId: inv.tenantId, status: { not: 'closed' } },
      data: { status: 'suspended', statusReason: BAD_DEBT_SUSPENSION_REASON },
    })
    if (s.count > 0) suspendedAccountId = accountId
  }
  return { suspendedAccountId }
}

/** Audit row for a client suspended by a write-off (after commit). */
async function auditSuspension(req: FastifyRequest, tenantId: string, accountId: string | null, writeOffId: string): Promise<void> {
  if (!accountId) return
  await audit({
    category: 'accounting', action: 'customer_account.suspend', entity: 'CustomerAccount', entityId: accountId,
    ...staffOf(req), tenantId, after: { status: 'suspended', statusReason: BAD_DEBT_SUSPENSION_REASON },
    metadata: { writeOffId },
  })
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function writeOffRoutes(fastify: FastifyInstance) {
  // GET /accounting/receivables/write-offs?status=&invoiceId=&limit= — every
  // write-off in view (the approvals inbox reads ?status=requested). Rows
  // carry canApprove / canReject / canCancel / canRecover for the caller.
  fastify.get<{ Querystring: Record<string, string | undefined> }>('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const q = z.object({
      status: z.enum(WRITE_OFF_STATUSES).optional(),
      invoiceId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse({
      status: req.query.status || undefined,
      invoiceId: req.query.invoiceId || undefined,
      limit: req.query.limit || undefined,
    })
    const rows = await prisma.receivableWriteOff.findMany({
      where: {
        ...(await scopeTenantWhere(req, 'read')),
        ...(q.status ? { status: q.status } : {}),
        ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
      },
      include: WRITE_OFF_INCLUDE,
      orderBy: { requestedAt: 'desc' },
      take: q.limit,
    })
    return { items: await shape(rows, callerOf(req)) }
  })

  // GET /accounting/receivables/write-offs/:id/evidence/:fileId — one evidence
  // file, inline, nosniff, never cached by a shared proxy.
  fastify.get<{ Params: { id: string; fileId: string } }>(
    '/:id/evidence/:fileId',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req, reply) => {
      const w = await findWriteOff(req, req.params.id, 'read')
      const file = await prisma.receivableWriteOffAttachment.findFirst({
        where: { id: req.params.fileId, writeOffId: w.id, tenantId: w.tenantId },
        select: { mime: true, data: true, fileName: true },
      })
      if (!file) throw new NotFoundError('ReceivableWriteOffAttachment', req.params.fileId)
      return sendEvidence(reply, file, file.fileName)
    },
  )

  // POST /accounting/receivables/write-offs — ask to write off (part of) an
  // invoice. {invoiceId, amountCents, reason, evidence: [{fileName, mime,
  // data (base64)}] 1..5}. The write-off belongs to the INVOICE's company. The
  // CEO's own request applies at once (201 with status 'approved').
  fastify.post('/', { preHandler: requireAuth(...WRITE_OFF_REQUESTERS), bodyLimit: REQUEST_BODY_LIMIT }, async (req, reply) => {
    const body = z.object({
      invoiceId: z.string().uuid(),
      amountCents: zMoneyCents('The amount to write off', { sign: 'positive' }),
      reason: z.string().trim().min(10).max(500),
      evidence: z.array(EvidenceFile).max(MAX_FILES).optional(),
    }).parse(req.body ?? {})
    const found = await findInScope(req, body.invoiceId)
    assertLiveInvoice(found)
    if (!body.evidence?.length) {
      throw new AppError('EVIDENCE_REQUIRED', 'Attach the evidence the debt cannot be collected (letters, a court or collection note, the client\'s closure) — at least one file', 400)
    }
    // Decoded and checked before any transaction opens.
    const files = body.evidence.map((f) => ({
      fileName: f.fileName,
      ...decodeEvidenceFile(f.data, f.mime, { allowPdf: true, maxBytes: EVIDENCE_MAX_BYTES }),
    }))
    const me = callerOf(req)
    const ceo = me.role === 'admin'
    if (ceo) await assertTemplateAccounts(prisma, found.tenantId, [BAD_DEBTS, RECEIVABLE])

    let created: ReceivableWriteOff
    let suspendedAccountId: string | null = null
    try {
      created = await prisma.$transaction(async (tx) => {
        const { inv } = await lockClientThenInvoice(tx, found.id)
        assertLiveInvoice(inv)
        const open = await tx.receivableWriteOff.findFirst({ where: { invoiceId: inv.id, status: 'requested' }, select: { id: true } })
        if (open) throw writeOffOpen()
        const balance = balanceOf(inv)
        if (body.amountCents > balance) throw exceedsBalance(balance)
        const w = await tx.receivableWriteOff.create({
          data: {
            tenantId: inv.tenantId, invoiceId: inv.id, amountCents: body.amountCents,
            reason: body.reason, requestedById: me.id,
          },
        })
        await tx.receivableWriteOffAttachment.createMany({
          data: files.map((f) => ({
            tenantId: inv.tenantId, writeOffId: w.id, fileName: f.fileName, mime: f.mime,
            sizeBytes: f.sizeBytes, data: f.bytes, uploadedById: me.id,
          })),
        })
        // The CEO is the final authority (decision 27): their own request
        // needs no second signature and is applied in the same transaction.
        if (ceo) suspendedAccountId = (await applyWriteOffTx(tx, w.id, me.id, 'Raised by the CEO — applied at once')).suspendedAccountId
        return w
      })
    } catch (err) {
      if (!(err instanceof AppError) && isOneOpenClash(err)) throw writeOffOpen()
      throw err
    }
    await audit({
      category: 'accounting', action: ceo ? 'receivable.write_off.apply' : 'receivable.write_off.request',
      entity: 'ReceivableWriteOff', entityId: created.id, ...staffOf(req), tenantId: found.tenantId,
      after: { invoiceId: found.id, invoiceNumber: found.number, amountCents: body.amountCents, reason: body.reason, files: files.length, appliedAtOnce: ceo },
    })
    await auditSuspension(req, found.tenantId, suspendedAccountId, created.id)
    // The bell (queued, after the commit): the CEO has a write-off to decide (the CEO's own applies at once).
    if (!ceo) approvalWaiting('bad_debt', created.id, { round: `requested:${created.requestedAt.toISOString()}`, actorId: me.id })
    return reply.status(201).send(await reload(created.id, me))
  })

  // approval.decide + the "decided" notice to the requester (the bell). The guard is a plain role list (CEO):
  // grant 'role'. After the commit; never fails the decision.
  async function decidedNotice(req: FastifyRequest, w: { id: string; tenantId: string }, decision: 'approve' | 'reject', note?: string | null) {
    try {
      await auditApproval(req, {
        type: 'bad_debt', id: w.id, tenantId: w.tenantId, decision, grant: { via: 'role' }, entity: 'ReceivableWriteOff',
        metadata: { decidedAt: new Date().toISOString(), ...(note ? { reason: note } : {}) },
      })
    } catch (err) {
      console.warn(`[write-offs] approval.decide not recorded: ${(err as Error).message}`)
    }
  }

  // POST /accounting/receivables/write-offs/:id/approve {note?} — the CEO.
  fastify.post<{ Params: { id: string } }>('/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {})
    const w = await findWriteOff(req, req.params.id, 'write')
    if (w.status !== 'requested') throw notPending(w)
    await assertNotSelfApproval({
      tenantId: w.tenantId,
      actor: req.staffUser!,
      creatorId: w.requestedById,
      action: 'approve a bad-debt write-off',
      entity: 'ReceivableWriteOff',
      entityId: w.id,
    })
    const me = callerOf(req)
    const { suspendedAccountId } = await prisma.$transaction((tx) => applyWriteOffTx(tx, w.id, me.id, body.note || null))
    await audit({
      category: 'accounting', action: 'receivable.write_off.approve', entity: 'ReceivableWriteOff', entityId: w.id,
      ...staffOf(req), tenantId: w.tenantId, before: { status: w.status }, after: { status: 'approved', note: body.note ?? null },
      metadata: { invoiceId: w.invoiceId, amountCents: toCents(w.amountCents) },
    })
    await auditSuspension(req, w.tenantId, suspendedAccountId, w.id)
    await decidedNotice(req, w, 'approve', body.note)
    return reload(w.id, me)
  })

  // POST /accounting/receivables/write-offs/:id/reject {note} — the CEO.
  fastify.post<{ Params: { id: string } }>('/:id/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().min(3).max(500) }).parse(req.body ?? {})
    const w = await findWriteOff(req, req.params.id, 'write')
    const res = await prisma.receivableWriteOff.updateMany({
      where: { id: w.id, status: 'requested' },
      data: { status: 'rejected', decidedById: req.staffUser!.id, decidedAt: new Date(), decisionNote: body.note },
    })
    if (res.count === 0) throw notPending(await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: w.id } }))
    await audit({
      category: 'accounting', action: 'receivable.write_off.reject', entity: 'ReceivableWriteOff', entityId: w.id,
      ...staffOf(req), tenantId: w.tenantId, before: { status: w.status }, after: { status: 'rejected', note: body.note },
    })
    await decidedNotice(req, w, 'reject', body.note)
    return reload(w.id, callerOf(req))
  })

  // POST /accounting/receivables/write-offs/:id/cancel {note?} — the
  // requester, or anyone who may request write-offs; while it is requested.
  fastify.post<{ Params: { id: string } }>('/:id/cancel', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {})
    const w = await findWriteOff(req, req.params.id, 'write')
    const me = callerOf(req)
    if (!isRequesterRole(me.role) && w.requestedById !== me.id) {
      throw new ForbiddenError('Only the person who asked for this write-off, finance or management can cancel it')
    }
    const res = await prisma.receivableWriteOff.updateMany({
      where: { id: w.id, status: 'requested' },
      data: { status: 'cancelled', decidedById: me.id, decidedAt: new Date(), decisionNote: body.note || 'Cancelled' },
    })
    if (res.count === 0) throw notPending(await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: w.id } }))
    await audit({
      category: 'accounting', action: 'receivable.write_off.cancel', entity: 'ReceivableWriteOff', entityId: w.id,
      ...staffOf(req), tenantId: w.tenantId, before: { status: w.status }, after: { status: 'cancelled', note: body.note ?? null },
    })
    return reload(w.id, me)
  })

  // POST /accounting/receivables/write-offs/:id/recover — money received on
  // a written-off amount. {amountCents ≤ amount − recovered, receivedAt,
  // method cash|card|bank_transfer|bank_deposit|cheque (old 'bank' =
  // bank_transfer), bankAccountId? (a bank of the INVOICE's company; another
  // company's → 422), reference (the payment reference # — required for every
  // method: 422 PAYMENT_REFERENCE_REQUIRED)}. One transaction: the counters,
  // the payment row (writeOffId) and both entries. 201 → {payment, writeOff,
  // referenceUsedBefore} (a warning only).
  fastify.post<{ Params: { id: string } }>('/:id/recover', { preHandler: requireAuth(...WRITE_OFF_REQUESTERS) }, async (req, reply) => {
    const body = z.object({
      amountCents: zMoneyCents('The amount recovered', { sign: 'positive' }),
      receivedAt: dateStr,
      method: receiptMethodIn(),
      bankAccountId: z.string().min(1).nullable().optional(),
      reference: zPaymentRef.nullable().optional(),
    }).parse(req.body ?? {})
    const w = await findWriteOff(req, req.params.id, 'write')
    if (w.status !== 'approved') {
      throw new AppError('WRITE_OFF_NOT_APPROVED', `Only an approved write-off can be recovered — this one is ${w.status}`, 409)
    }
    const reference = assertPaymentReference(body.method, body.reference)
    const how = receiptText(body.method, reference)
    const receivedAt = new Date(body.receivedAt)
    if (Number.isNaN(receivedAt.getTime())) throw new AppError('BAD_DATE', 'Give the date the money was received', 400)
    if (w.decidedAt && body.receivedAt.slice(0, 10) < pktDay(w.decidedAt)) {
      throw new AppError('BAD_DATE', 'A recovery cannot be dated before the write-off was approved', 400)
    }
    await assertTemplateAccounts(prisma, w.tenantId, [BAD_DEBTS, RECEIVABLE])
    const me = callerOf(req)

    const payment = await prisma.$transaction(async (tx) => {
      const { inv } = await lockClientThenInvoice(tx, w.invoiceId)
      assertLiveInvoice(inv)
      const cur = await tx.receivableWriteOff.findUniqueOrThrow({ where: { id: w.id } })
      if (cur.status !== 'approved') throw new AppError('WRITE_OFF_NOT_APPROVED', `Only an approved write-off can be recovered — this one is ${cur.status}`, 409)
      const leftCents = Math.min(toCents(cur.amountCents) - toCents(cur.recoveredCents), toCents(inv.writtenOffCents))
      if (body.amountCents > leftCents) {
        throw new AppError('OVER_RECOVERY', `That is more than is left to recover on this write-off (${pkr(Math.max(0, leftCents))})`, 409, {
          leftCents: Math.max(0, leftCents),
        })
      }
      const money = await moneyAccountCode(tx, inv.tenantId, { method: body.method, bankAccountId: body.bankAccountId })
      await tx.receivableWriteOff.update({ where: { id: cur.id }, data: { recoveredCents: { increment: body.amountCents } } })
      await tx.receivableInvoice.update({
        where: { id: inv.id },
        data: { writtenOffCents: { decrement: body.amountCents }, paidCents: { increment: body.amountCents } },
      })
      const p = await tx.receivablePayment.create({
        data: {
          tenantId: inv.tenantId, invoiceId: inv.id, amountCents: body.amountCents, receivedAt,
          method: body.method, bankAccountId: money.bankAccountId, reference,
          createdById: me.id, writeOffId: cur.id,
        },
      })
      // journal_entries.reference stays the dedupe key (sourceType:sourceId);
      // the payment reference # goes in the descriptions and the money line.
      await postJournalEntry({
        tenantId: inv.tenantId,
        sourceType: 'receivable.write_off_recovery',
        sourceId: p.id,
        description: `Bad debt recovered on ${inv.number} — ${inv.customerName} (${how})`.slice(0, 500),
        entryDate: receivedAt,
        postedBy: me.id,
        lines: [
          { accountCode: RECEIVABLE, type: 'debit', amountCents: body.amountCents, conceptId: inv.conceptId },
          { accountCode: BAD_DEBTS, type: 'credit', amountCents: body.amountCents, conceptId: inv.conceptId },
        ],
      }, { tx })
      await postJournalEntry({
        tenantId: inv.tenantId,
        sourceType: 'receivable.payment',
        sourceId: p.id,
        description: `Payment on ${inv.number} — ${inv.customerName} (recovery of a written-off amount; ${how})`.slice(0, 500),
        entryDate: receivedAt,
        postedBy: me.id,
        lines: [
          { accountCode: money.code, type: 'debit', amountCents: body.amountCents, memo: receiptMemo(inv.number, body.method, reference) },
          { accountCode: RECEIVABLE, type: 'credit', amountCents: body.amountCents, conceptId: inv.conceptId },
        ],
      }, { tx })
      await restatus(tx, inv.id)
      return p
    })
    await audit({
      category: 'accounting', action: 'receivable.write_off.recover', entity: 'ReceivablePayment', entityId: payment.id,
      ...staffOf(req), tenantId: w.tenantId, after: payment, metadata: { writeOffId: w.id, invoiceId: w.invoiceId },
    })
    // Same reference elsewhere in the invoice's company — a warning, never a block.
    const referenceUsedBefore = await findPaymentReferenceUses(prisma, w.tenantId, reference, {
      exclude: { kind: 'receivable_payment', id: payment.id },
    })
    return reply.status(201).send({ payment, writeOff: await reload(w.id, me), referenceUsedBefore })
  })
}
