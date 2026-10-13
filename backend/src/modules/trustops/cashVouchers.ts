// Cash vouchers — GS Foods' internal cash payment voucher (owner, 2026-10-13).
//
//   "AG needs cash. Hasnain makes GS Foods internal voucher and signs as HOD.
//    AG signs as director. Voucher submitted to Jamil sb. Jamil sb signs and
//    cash disbursed. Voucher submitted to GS Foods system."
//   "generate voucher shouldnt put it in cash section. getting jamils
//    signature and sending pic of that should add voucher to cash"
//
// So:   draft ──sign-hod──▶ hod_signed ──approve (director)──▶ approved
//                                 │                               │
//                              reject                     disburse (photo of
//                                 ▼                     the cashier-signed paper)
//                             rejected                             ▼
//                                                              disbursed
//       cancel: draft | hod_signed | approved ──▶ cancelled
//
// Preparing, signing and printing a voucher NEVER touches cash. Only the
// upload of the photo of the paper the cashier (the box's custodian) signed
// turns it into ONE petty-cash spend, through recordPettyCashSpendTx — the
// same path as a manual spend on /trustops/petty-cash/movements. Petty-cash
// spends are not posted to the ledger yet (accounting/expenseCategories.ts),
// so neither is a voucher: do NOT add a ledger posting here — when the cash
// domain posts petty-cash spends, a disbursed voucher posts with them.
//
// Company separation: a voucher binds to the ACTIVE company on create; its box,
// brand and payee must be that company's (422). Every read and write of an
// existing voucher is scoped to the operator's companies — another company's
// voucher is 404. The photo is stored in the database (file storage is not
// configured on every server) and is never selected by the list.
//
// v1 — the owner will change the paper format later. Who counts as an HOD
// will be refined; today any cash keeper (CASH_GUARD) may sign as HOD. The
// director is the CEO (role admin), and must be a different login from the
// HOD who signed (409 SAME_SIGNER).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { CashVoucherStatus, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { audit } from '../../lib/audit.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, activeTenantId, type ScopeMode } from '../../lib/tenantScope.js'
import { zInt4Cents } from '../../lib/money.js'
import { CASH_GUARD, passesCashGuard, recordPettyCashSpendTx } from './pettyCash.js'
import { decodeEvidenceFile, sendEvidence, EVIDENCE_MAX_BYTES } from '../../lib/evidenceFile.js'

// ─── Photo rules ─────────────────────────────────────────────────────────────

/** The decoded photo may be at most 3 MB (the admin compresses it first). */
export const CASH_VOUCHER_PHOTO_MAX_BYTES = EVIDENCE_MAX_BYTES
/** base64 of 3 MB is 4 MB; a little room for a data-URL prefix and line breaks. */
const DISBURSE_BODY_LIMIT = 6 * 1024 * 1024

/**
 * The uploaded photo, checked by the one evidence decoder (lib/evidenceFile.ts):
 * JPEG / PNG / WebP whose bytes match the type, at most
 * CASH_VOUCHER_PHOTO_MAX_BYTES decoded. Anything else is 400 BAD_PHOTO.
 */
export function decodeVoucherPhoto(photo: string, mime: string): { mime: string; data: Buffer } {
  const f = decodeEvidenceFile(photo, mime, { maxBytes: CASH_VOUCHER_PHOTO_MAX_BYTES })
  return { mime: f.mime, data: f.bytes }
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

const VOUCHER_INCLUDE = {
  box: { select: { id: true, name: true, custodianId: true, tenantId: true, isActive: true, deletedAt: true } },
  // Photo METADATA only — the bytes are read by GET /:id/photo alone.
  attachments: {
    select: { id: true, mime: true, sizeBytes: true, createdAt: true, uploadedById: true },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
} satisfies Prisma.CashVoucherInclude
type VoucherRow = Prisma.CashVoucherGetPayload<{ include: typeof VOUCHER_INCLUDE }>

export const voucherNumber = (seq: number) => `CV-${String(seq).padStart(5, '0')}`

/** The voucher as every route returns it: the row, plus names (never the photo bytes). */
async function present(rows: VoucherRow[]) {
  const userIds = new Set<string>()
  const conceptIds = new Set<string>()
  const tenantIds = new Set<string>()
  for (const v of rows) {
    for (const id of [v.preparedById, v.hodSignedById, v.directorSignedById, v.rejectedById, v.cancelledById, v.disbursedById, v.payeeUserId, v.box.custodianId]) {
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
  return rows.map((v) => {
    const { box, attachments, ...voucher } = v
    const photo = attachments[0] ?? null
    return {
      ...voucher,
      companyName: tenantName.get(v.tenantId) ?? null,
      conceptName: v.conceptId ? (conceptName.get(v.conceptId) ?? null) : null,
      boxName: box.name,
      custodianId: box.custodianId,
      custodianName: nameOf(box.custodianId),
      payeeUserName: nameOf(v.payeeUserId),
      preparedByName: nameOf(v.preparedById),
      hodSignedByName: nameOf(v.hodSignedById),
      directorSignedByName: nameOf(v.directorSignedById),
      rejectedByName: nameOf(v.rejectedById),
      cancelledByName: nameOf(v.cancelledById),
      disbursedByName: nameOf(v.disbursedById),
      hasPhoto: !!photo,
      photo: photo ? { mime: photo.mime, sizeBytes: photo.sizeBytes, uploadedAt: photo.createdAt, uploadedById: photo.uploadedById } : null,
    }
  })
}
const presentOne = async (v: VoucherRow) => (await present([v]))[0]!

// ─── Input ───────────────────────────────────────────────────────────────────

const zVoucherDate = z.string().trim()
  .refine((s) => /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s)), 'Use a date like 2026-10-13')
  .transform((s) => new Date(s))
const zOptionalText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((s) => (s === undefined ? undefined : s === null || s === '' ? null : s))

const fields = {
  voucherDate: zVoucherDate.optional(),
  payeeName: z.string().trim().min(1).max(120),
  payeeUserId: z.string().uuid().nullable().optional(),
  purpose: z.string().trim().min(1).max(500),
  // Same width as a petty-cash movement's category (it becomes the spend's).
  category: zOptionalText(40),
  conceptId: z.string().uuid().nullable().optional(),
  department: zOptionalText(80),
  // Paid from a petty-cash box (INT4), so INT4.
  amountCents: zInt4Cents('The voucher amount', { sign: 'positive' }),
  boxId: z.string().min(1).max(64),
}
const CreateBody = z.object(fields)
const PatchBody = z.object(fields).partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Send at least one field to change')
type VoucherInput = z.infer<typeof PatchBody>

const NoteBody = z.object({ note: z.string().trim().min(3, 'Say why (at least 3 characters)').max(500) })
const DisburseBody = z.object({ photo: z.string().min(1), mime: z.string().min(1).max(100) })

/**
 * The box, brand and payee a voucher points at must be the voucher's own
 * company's: never trust an id from the client. A box must be open (active,
 * not deleted). On create `mode` is 'create' (the brand must be the active
 * company's, else 404); on edit 'write'.
 */
async function assertRefsOf(req: FastifyRequest, tenantId: string, body: VoucherInput, mode: ScopeMode): Promise<void> {
  if (body.boxId !== undefined) {
    const box = await prisma.pettyCashBox.findFirst({
      where: { id: body.boxId, tenantId, deletedAt: null, isActive: true },
      select: { id: true },
    })
    if (!box) throw new AppError('BOX_NOT_IN_COMPANY', 'That cash box is not an open petty-cash box of this voucher\'s company', 422)
  }
  if (body.conceptId) {
    const concept = await assertConceptOwned(req, body.conceptId, mode)
    if (concept.tenantId !== tenantId) throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand belongs to another company', 422)
  }
  if (body.payeeUserId) {
    const payee = await prisma.user.findFirst({
      where: { id: body.payeeUserId, deletedAt: null, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] },
      select: { id: true },
    })
    if (!payee) throw new AppError('PAYEE_NOT_IN_COMPANY', 'The person paid must be a member of this voucher\'s company', 422)
  }
}

/** The voucher, or 404 when it is not one of the operator's companies'. */
async function loadVoucher(req: FastifyRequest, id: string): Promise<VoucherRow> {
  const v = await prisma.cashVoucher.findFirst({
    where: { id, ...(await scopeTenantWhere(req, 'write')) },
    include: VOUCHER_INCLUDE,
  })
  if (!v) throw new NotFoundError('CashVoucher', id)
  return v
}

/** Finance / the manager tiers (CASH_GUARD), or the cashier: the box's custodian. */
async function assertCashOrCustodian(req: FastifyRequest, v: VoucherRow): Promise<void> {
  if (v.box.custodianId === req.staffUser!.id) return
  if (await passesCashGuard(req)) return
  throw new ForbiddenError('Only finance, a manager or the cash box\'s custodian can open this voucher')
}

const human = (s: CashVoucherStatus) => s.replace(/_/g, ' ')
const wrongStatus = (code: string, v: { number: string; status: CashVoucherStatus }, needs: string) =>
  new AppError(code, `Voucher ${v.number} is ${human(v.status)} — ${needs}`, 409)

async function reload(id: string) {
  return presentOne(await prisma.cashVoucher.findUniqueOrThrow({ where: { id }, include: VOUCHER_INCLUDE }))
}

function auditVoucher(req: FastifyRequest, step: string, v: { id: string; tenantId: string; number: string }, after: Record<string, unknown>, before?: Record<string, unknown>) {
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

// ─── Routes (/trustops/cash-vouchers) ────────────────────────────────────────

export async function cashVoucherRoutes(fastify: FastifyInstance) {
  // GET / — the register. View-aware (the active company, or every company in
  // "All companies" view). Newest first; `cursor` = the last id of the
  // previous page. Never the photo bytes.
  // A cashier who is not a cash keeper sees only the vouchers waiting on (or
  // paid from) a box they hold — that is how Jamil sb finds the ones to pay.
  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const keeper = await passesCashGuard(req)
    const q = z.object({
      status: z.nativeEnum(CashVoucherStatus).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().min(1).max(64).optional(),
    }).parse(req.query ?? {})
    const scope = await scopeTenantWhere(req, 'read')
    let after: Prisma.CashVoucherWhereInput = {}
    if (q.cursor) {
      const c = await prisma.cashVoucher.findFirst({ where: { id: q.cursor, ...scope }, select: { id: true, createdAt: true } })
      if (!c) throw new AppError('BAD_CURSOR', 'That page of vouchers is out of date — reload the list', 400)
      after = { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] }
    }
    const rows = await prisma.cashVoucher.findMany({
      where: {
        ...scope,
        ...(q.status && { status: q.status }),
        ...after,
        ...(!keeper && { box: { custodianId: req.staffUser!.id }, AND: [{ status: { in: ['approved', 'disbursed'] as CashVoucherStatus[] } }] }),
      },
      include: VOUCHER_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    })
    const page = rows.slice(0, q.limit)
    return { items: await present(page), nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null }
  })

  // GET /:id — one voucher (the print view reads this). Cash keepers, or the
  // cashier who holds its box.
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const v = await loadVoucher(req, req.params.id)
    await assertCashOrCustodian(req, v)
    return presentOne(v)
  })

  // GET /:id/photo — the signed paper, as an image.
  fastify.get<{ Params: { id: string } }>('/:id/photo', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const v = await loadVoucher(req, req.params.id)
    await assertCashOrCustodian(req, v)
    const photo = await prisma.cashVoucherAttachment.findFirst({
      where: { voucherId: v.id, tenantId: v.tenantId },
      orderBy: { createdAt: 'desc' },
      select: { mime: true, data: true },
    })
    if (!photo) throw new NotFoundError('Signed voucher photo')
    return sendEvidence(reply, photo, v.number)
  })

  // POST / — prepare a voucher in the ACTIVE company. Touches no cash.
  fastify.post('/', { preHandler: CASH_GUARD }, async (req, reply) => {
    const body = CreateBody.parse(req.body)
    const tenantId = activeTenantId(req, 'a cash voucher belongs to one company')
    await assertRefsOf(req, tenantId, body, 'create')
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
          payeeName: body.payeeName,
          payeeUserId: body.payeeUserId ?? null,
          purpose: body.purpose,
          category: body.category ?? null,
          conceptId: body.conceptId ?? null,
          department: body.department ?? null,
          amountCents: body.amountCents,
          boxId: body.boxId,
          status: 'draft',
          preparedById: req.staffUser!.id,
        },
        select: { id: true, tenantId: true, number: true },
      })
    })
    await auditVoucher(req, 'create', created, { amountCents: body.amountCents, payeeName: body.payeeName, purpose: body.purpose, boxId: body.boxId })
    return reply.status(201).send(await reload(created.id))
  })

  // PATCH /:id — edit a draft (its preparer, or a cash keeper).
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = PatchBody.parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    if (v.preparedById !== req.staffUser!.id && !(await passesCashGuard(req))) {
      throw new ForbiddenError('Only whoever prepared this voucher, finance or a manager can edit it')
    }
    if (v.status !== 'draft') throw wrongStatus('VOUCHER_NOT_DRAFT', v, 'only a draft can be edited')
    await assertRefsOf(req, v.tenantId, body, 'write')
    const data: Prisma.CashVoucherUncheckedUpdateManyInput = {}
    if (body.voucherDate !== undefined) data.voucherDate = body.voucherDate
    if (body.payeeName !== undefined) data.payeeName = body.payeeName
    if (body.payeeUserId !== undefined) data.payeeUserId = body.payeeUserId
    if (body.purpose !== undefined) data.purpose = body.purpose
    if (body.category !== undefined) data.category = body.category
    if (body.conceptId !== undefined) data.conceptId = body.conceptId
    if (body.department !== undefined) data.department = body.department
    if (body.amountCents !== undefined) data.amountCents = body.amountCents
    if (body.boxId !== undefined) data.boxId = body.boxId
    // Conditional: a sign racing this edit wins, and the edit is refused.
    const res = await prisma.cashVoucher.updateMany({ where: { id: v.id, status: 'draft' }, data })
    if (res.count === 0) throw wrongStatus('VOUCHER_NOT_DRAFT', { number: v.number, status: (await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).status }, 'only a draft can be edited')
    const before = Object.fromEntries(Object.keys(data).map((k) => [k, v[k as keyof VoucherRow]]))
    await auditVoucher(req, 'update', v, { ...data }, before)
    return reload(v.id)
  })

  // POST /:id/sign-hod — the HOD signs. draft → hod_signed. (v1: any cash keeper.)
  fastify.post<{ Params: { id: string } }>('/:id/sign-hod', { preHandler: CASH_GUARD }, async (req) => {
    const v = await loadVoucher(req, req.params.id)
    if (v.status !== 'draft') throw wrongStatus('VOUCHER_NOT_DRAFT', v, 'only a draft can be signed as HOD')
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, status: 'draft' },
      data: { status: 'hod_signed', hodSignedById: req.staffUser!.id, hodSignedAt: now },
    })
    if (res.count === 0) throw new AppError('VOUCHER_NOT_DRAFT', `Voucher ${v.number} was signed or changed by someone else — reload it`, 409)
    await auditVoucher(req, 'sign_hod', v, { status: 'hod_signed', hodSignedAt: now.toISOString() }, { status: v.status })
    return reload(v.id)
  })

  // POST /:id/approve — the director (the CEO) signs. hod_signed → approved.
  // Two different people must sign: never the login that signed as HOD.
  fastify.post<{ Params: { id: string } }>('/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const v = await loadVoucher(req, req.params.id)
    const me = req.staffUser!.id
    if (v.status !== 'hod_signed') throw wrongStatus('VOUCHER_NOT_HOD_SIGNED', v, 'the director signs after the HOD')
    if (v.hodSignedById === me) {
      throw new AppError('SAME_SIGNER', 'You signed this voucher as HOD — a different person must sign as director', 409)
    }
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, status: 'hod_signed', hodSignedById: { not: me } },
      data: { status: 'approved', directorSignedById: me, directorSignedAt: now },
    })
    if (res.count === 0) throw new AppError('VOUCHER_NOT_HOD_SIGNED', `Voucher ${v.number} was changed by someone else — reload it`, 409)
    await auditVoucher(req, 'approve', v, { status: 'approved', directorSignedAt: now.toISOString() }, { status: v.status })
    return reload(v.id)
  })

  // POST /:id/reject {note} — the director refuses it. hod_signed → rejected.
  fastify.post<{ Params: { id: string } }>('/:id/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const { note } = NoteBody.parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    if (v.status !== 'hod_signed') throw wrongStatus('VOUCHER_NOT_HOD_SIGNED', v, 'only a voucher waiting for the director can be rejected')
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, status: 'hod_signed' },
      data: { status: 'rejected', rejectedById: req.staffUser!.id, rejectedAt: now, rejectNote: note },
    })
    if (res.count === 0) throw new AppError('VOUCHER_NOT_HOD_SIGNED', `Voucher ${v.number} was changed by someone else — reload it`, 409)
    await auditVoucher(req, 'reject', v, { status: 'rejected', note }, { status: v.status })
    return reload(v.id)
  })

  // POST /:id/cancel {note} — withdrawn before payment.
  const CANCELLABLE: CashVoucherStatus[] = ['draft', 'hod_signed', 'approved']
  fastify.post<{ Params: { id: string } }>('/:id/cancel', { preHandler: CASH_GUARD }, async (req) => {
    const { note } = NoteBody.parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    if (!CANCELLABLE.includes(v.status)) throw wrongStatus('VOUCHER_NOT_CANCELLABLE', v, 'only a voucher not yet paid can be cancelled')
    const now = new Date()
    const res = await prisma.cashVoucher.updateMany({
      where: { id: v.id, status: { in: CANCELLABLE } },
      data: { status: 'cancelled', cancelledById: req.staffUser!.id, cancelledAt: now, cancelNote: note },
    })
    if (res.count === 0) throw new AppError('VOUCHER_NOT_CANCELLABLE', `Voucher ${v.number} was paid or changed by someone else — reload it`, 409)
    await auditVoucher(req, 'cancel', v, { status: 'cancelled', note }, { status: v.status })
    return reload(v.id)
  })

  // POST /:id/disburse {photo, mime} — the photo of the paper the cashier
  // signed. THIS is the moment the cash leaves the box: in one transaction the
  // voucher is claimed (approved → disbursed, so a second upload can never pay
  // twice), the photo is stored, and ONE petty-cash spend is recorded on the
  // voucher's box. INSUFFICIENT_FLOAT (or anything else) rolls all of it back:
  // the voucher stays approved, with no photo and no movement.
  fastify.post<{ Params: { id: string } }>('/:id/disburse', {
    preHandler: requireAuth(...ALL_STAFF),
    bodyLimit: DISBURSE_BODY_LIMIT,
  }, async (req) => {
    const body = DisburseBody.parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    await assertCashOrCustodian(req, v)
    if (v.status === 'disbursed') throw new AppError('ALREADY_DISBURSED', `Voucher ${v.number} has already been paid`, 409)
    if (v.status !== 'approved') throw wrongStatus('VOUCHER_NOT_APPROVED', v, 'only a voucher the director has signed can be paid')
    if (v.box.tenantId !== v.tenantId || v.box.deletedAt || !v.box.isActive) {
      throw new AppError('BOX_UNAVAILABLE', `The cash box on voucher ${v.number} is closed — cancel the voucher and raise a new one`, 409)
    }
    const photo = decodeVoucherPhoto(body.photo, body.mime)

    const me = req.staffUser!.id
    const custodian = await prisma.user.findUnique({ where: { id: v.box.custodianId }, select: { name: true } })
    const cashierName = custodian?.name ?? null
    const reasonFull = `Cash voucher ${v.number}: ${v.purpose}`
    const reason = reasonFull.length > 200 ? `${reasonFull.slice(0, 199)}…` : reasonFull
    const now = new Date()

    const result = await prisma.$transaction(async (tx) => {
      const claimed = await tx.cashVoucher.updateMany({
        where: { id: v.id, tenantId: v.tenantId, status: 'approved' },
        data: { status: 'disbursed', disbursedAt: now, disbursedById: me, cashierName },
      })
      if (claimed.count === 0) {
        const cur = await tx.cashVoucher.findUniqueOrThrow({ where: { id: v.id }, select: { status: true } })
        if (cur.status === 'disbursed') throw new AppError('ALREADY_DISBURSED', `Voucher ${v.number} has already been paid`, 409)
        throw wrongStatus('VOUCHER_NOT_APPROVED', { number: v.number, status: cur.status }, 'only a voucher the director has signed can be paid')
      }
      const attachment = await tx.cashVoucherAttachment.create({
        data: {
          tenantId: v.tenantId,
          voucherId: v.id,
          kind: 'signed_voucher',
          mime: photo.mime,
          sizeBytes: photo.data.length,
          data: photo.data,
          uploadedById: me,
        },
        select: { id: true },
      })
      // The one spend path (pettyCash.ts). No ledger posting — see the header.
      const spent = await recordPettyCashSpendTx(tx, {
        box: { id: v.boxId },
        amountCents: v.amountCents,
        category: v.category,
        reason,
        vendorName: v.payeeName.slice(0, 120),
        approvedById: v.directorSignedById,
        createdById: me,
      })
      await tx.cashVoucher.update({ where: { id: v.id }, data: { pettyCashMovementId: spent.movement.id } })
      return { attachmentId: attachment.id, movement: spent.movement, newFloatCents: spent.newFloatCents }
    }, { timeout: 20_000, maxWait: 10_000 })

    await auditVoucher(req, 'disburse', v, {
      status: 'disbursed',
      amountCents: v.amountCents,
      boxId: v.boxId,
      pettyCashMovementId: result.movement.id,
      newFloatCents: result.newFloatCents,
      photo: { attachmentId: result.attachmentId, mime: photo.mime, sizeBytes: photo.data.length },
      cashierName,
    }, { status: v.status })

    return {
      voucher: await reload(v.id),
      movement: { id: result.movement.id, amountCents: result.movement.amountCents, createdAt: result.movement.createdAt },
      newFloatCents: result.newFloatCents,
    }
  })
}
