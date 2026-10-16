import type { FastifyInstance, FastifyRequest } from 'fastify'
import { trashReasonOf } from '../../lib/trash.js'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY, ALL_STAFF, FINANCE_TEAM, PROCUREMENT_TEAM } from '../auth/middleware.js'
import { resolveTenantScope, scopeTenantWhere } from '../../lib/tenantScope.js'
import { NotFoundError, AppError, ForbiddenError } from '../../lib/errors.js'
import { assertHoMayPropose, viaHeadOfficeForSubmit } from '../../lib/headOffice.js'
import {
  APPROVAL_RIGHTS, approvalInputOf, approvalQueueTenantIds, approvalSubject, assertCanApprove, auditApproval,
  canApprove, delegatedTenantsByType, type ApprovalGrant, type ApprovalType,
} from '../../lib/approvalRights.js'
import { supplierScopeWhere, findSupplierInScope, activeTenantOr422 } from './scope.js'
import type { UserRole } from '@prisma/client'
import { approvalWaiting } from '../approvals/notify.js'
import { requireModule } from '../notifications/requireModule.js'

// Company scope: every procurement row belongs to its supplier's company, so
// every route below scopes through the supplier (./scope.ts). Reads use
// 'read' (view-aware); anything that changes a supplier or attaches a new row
// to one uses 'write' (a company the operator belongs to). An operator with
// no company sees and touches nothing. Foreign ids are 404.
//
// Who (role gate; module 'procurement' is enforced on top by moduleAccess):
//   PROCUREMENT_TEAM (managers + the buyer role 'procurement'): suppliers,
//     POs (raise / submit / send / mark sent / cancel), and READ access to
//     bills, payments, the 3-way match, AP aging, reorder and price history.
//     The buyer role holds the procurement module, so these used to load the
//     page and then 403 on every PO, bill and reorder call.
//   MANAGERS: receiving (receiveGoods' own rule), a supplier's opening
//     balance or company move.
//   AP_WRITERS (MANAGERS with 'procurement' + finance with 'accounting';
//     owner, 2026-10-16): recording / voiding bills, supplier credit notes
//     (record / apply / unapply / void), paying (cash, bank, cheque, wallet),
//     allocating, unapplying and voiding payments — money moves and the
//     books, kept apart from whoever raised the order. Each of these writes
//     an 'accounting' audit row under the supplier's company.
//   ADMIN_ONLY: the approval threshold, the backfill. Approve / reject: the CEO or a live
//     Procurement hand-over (lib/approvalRights.ts — see poDecisionRight below).
//   AP_READERS (PROCUREMENT_TEAM + finance, wave 3 UI-07): READ the payables
//     — supplier list (every supplier of the company, not just assigned
//     ones), supplier statements, POs, bills, the 3-way match and supplier
//     payments. Finance owns the books (Accounting → AP aging, petty cash
//     paying a bill) but holds no 'procurement' module; the module gate on
//     these read paths must admit 'accounting' as well (lib/moduleAccess.ts
//     GATED_PREFIXES — as /procurement/ap-aging already does). Finance
//     raises, approves and receives NOTHING here; it bills and pays as an
//     AP_WRITER.
import {
  createPo, submitPo, approvePo, rejectPo, cancelPo, sendPoToSupplier, markPoSent,
  createBill, voidBill, matchBill,
  createPayment, allocatePayment, unapplyPayment, voidPayment,
  agingReport, supplierAging, reorderSuggestions,
  getApprovalThresholdCents, setApprovalThresholdCents,
} from './service.js'
import {
  CREDIT_NOTE_REASONS, createCreditNote, creditableBill, applyCreditNote, unapplyCreditNote, voidCreditNote,
} from './creditNotes.js'
import { receiveGoods } from './receiving.js'
import { decodeRecordFiles, zRecordFile, RECORD_FILES_BODY_LIMIT, RECORD_FILES_MAX_PER_UPLOAD } from '../../lib/recordFiles.js'
import { postedOpeningBalances, syncOpeningBalanceOrFlag } from './openingBalance.js'
import { postSupplierBill, postSupplierPayment } from '../accounting/supplierPosting.js'
import { audit } from '../../lib/audit.js'
import { type DbMoney, toCents, zInt4Cents, zMoneyCents } from '../../lib/money.js'
import { FILER_STATUSES, WHT_SECTIONS } from '../../lib/withholding.js'
import { TAX_AUTHORITY_KEYS } from '../accounting/taxAuthorities.js'
import { parsePktEndOfDay, fmtPktDate } from '../accounting/dates.js'

export const AP_READERS = Array.from(new Set([...PROCUREMENT_TEAM, 'finance'])) as UserRole[]

/**
 * Who records supplier bills, supplier credit notes and supplier payments
 * (owner, 2026-10-16: "Yes, all" — finance does these jobs): the managers, as
 * before, plus finance holding the 'accounting' module. Raising, approving and
 * receiving POs stay out of finance's reach. Every write is audited.
 */
export const AP_WRITERS = Array.from(new Set([...MANAGERS, 'finance'])) as UserRole[]

/**
 * The module half of AP_WRITERS (after requireAuth). lib/moduleAccess.ts
 * GATED_PREFIXES admits 'procurement' OR 'accounting' on these paths; this
 * keeps each role to its own: finance needs 'accounting', every other role
 * still needs 'procurement' (a manager holding only 'accounting' gets
 * nothing new). The CEO is never refused.
 */
const financeAccounting = requireModule('accounting')
const managerProcurement = requireModule('procurement')
export async function requireApWriterModule(req: FastifyRequest): Promise<void> {
  if (req.staffUser?.role === 'finance') return financeAccounting(req)
  return managerProcurement(req)
}
const apWrite = { preHandler: [requireAuth(...AP_WRITERS), requireApWriterModule] }

const PO_TYPE: ApprovalType = 'purchase_order'

/**
 * The approve / reject / queue routes are ALL_STAFF (a hand-over may name a
 * buyer), so the old role gate moves in here: the role list of the type
 * (lib/approvalRights.ts APPROVAL_RIGHTS — the CEO for POs), or a live
 * hand-over of the type. Anyone else gets exactly the 403 the old
 * requireAuth(...ADMIN_ONLY) gave.
 */
async function assertApproverRoleOrDelegate(req: FastifyRequest, type: ApprovalType): Promise<void> {
  const su = req.staffUser!
  if ((APPROVAL_RIGHTS[type].roles as readonly string[]).includes(su.role)) return
  if (((await delegatedTenantsByType(su.id)).get(type)?.size ?? 0) > 0) return
  throw new ForbiddenError(`Role '${su.role}' is not allowed for this resource`)
}

// Supplier payments and credit notes name the company bank account the money
// used; lists show it by name. A payment's bank is always its supplier's
// company's (createPaymentTx checks it), so the lookup needs no other scope.
async function withBankNames<T extends { bankAccountId: string | null }>(rows: T[]) {
  const ids = Array.from(new Set(rows.map((r) => r.bankAccountId).filter((x): x is string => !!x)))
  const banks = ids.length === 0 ? [] : await prisma.bankAccount.findMany({
    where:  { id: { in: ids } },
    select: { id: true, name: true, bankName: true, accountCode: true },
  })
  return rows.map((r) => ({ ...r, bankAccount: banks.find((b) => b.id === r.bankAccountId) ?? null }))
}

// The original bill's number on each credit note (originalBillId is a plain column).
async function withOriginalBill<T extends { originalBillId: string | null }>(rows: T[]) {
  const ids = Array.from(new Set(rows.map((r) => r.originalBillId).filter((x): x is string => !!x)))
  const bills = ids.length === 0 ? [] : await prisma.supplierBill.findMany({
    where:  { id: { in: ids } },
    select: { id: true, billNumber: true },
  })
  return rows.map((r) => ({ ...r, originalBill: bills.find((b) => b.id === r.originalBillId) ?? null }))
}

// Post a supplier's opening balance to its company's ledger (a delta — see
// openingBalance.ts), dated at its opening date. A refusal (e.g. the month is
// locked) raises a posting_failed flag that Reconciliation → Backfill
// unposted re-posts; the AP aging shows the amount as openingUnpostedCents
// until it posts.
async function syncOpening(req: FastifyRequest, supplierId: string) {
  const r = await syncOpeningBalanceOrFlag(supplierId, { postedBy: req.staffUser?.id })
  if (!r.ok) req.log.error({ err: r.error, supplierId }, 'supplier opening balance refused — flagged')
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

// Money inputs in paisa (lib/money.ts, BOOKS-06): an amount bound for a
// BIGINT column is ≤ MAX_MONEY_CENTS (PKR 900bn); a PO line's unit cost
// becomes an item's INT4 stock cost, so it is ≤ INT4_MAX_CENTS. Above either
// it is 422 AMOUNT_TOO_LARGE with a plain message, not a raw 500 at insert.
// Computed totals (quantity × unit cost, bill and PO totals) and a stock bill
// line's unit cost are checked in service.ts.

const poLineSchema = z.object({
  inventoryItemId: z.string().uuid(),
  quantityOrdered: z.number().positive().finite(),
  unitCostCents:   zInt4Cents('A unit cost'),
  notes:           z.string().optional().nullable(),
})

const poCreateSchema = z.object({
  supplierId:   z.string().uuid(),
  expectedDate: z.string().optional().nullable(),
  reference:    z.string().optional().nullable(),
  notes:        z.string().optional().nullable(),
  lines:        z.array(poLineSchema).min(1),
})

const billLineSchema = z.object({
  inventoryItemId:    z.string().uuid().optional().nullable(),
  poLineId:           z.string().uuid().optional().nullable(),
  // A stock line names the receipt (or PO line) it bills — "receive it at the
  // dock first"; a line that is not stock names its 6xxx expense account.
  receiptLineId:      z.string().min(1).optional().nullable(),
  expenseAccountCode: z.string().trim().regex(/^\d{4}$/, 'An account code is four digits').optional().nullable(),
  // An expense line that looks like equipment, booked as an expense anyway
  // (finance / the CEO only, with a reason — audited and flagged).
  notEquipment:       z.boolean().optional(),
  notEquipmentReason: z.string().trim().max(500).optional().nullable(),
  description:        z.string().min(1),
  quantity:           z.number().positive().finite(),
  unitCostCents:      zMoneyCents('A unit cost'),
})

const billCreateSchema = z.object({
  supplierId:    z.string().uuid(),
  poId:          z.string().uuid().optional().nullable(),
  billNumber:    z.string().min(1),
  billDate:      z.string(),
  dueDate:       z.string().optional().nullable(),
  taxCents:      zMoneyCents('The bill\'s tax').optional(),
  // H8: who charged the sales tax (its input account); default the supplier's usual one, else FBR.
  taxAuthority:  z.enum(TAX_AUTHORITY_KEYS).optional().nullable(),
  // The withholding section (lib/withholding.ts); default the supplier's usual one, else 153(1)(a).
  whtSection:    z.enum([...WHT_SECTIONS, 'none']).optional().nullable(),
  notes:         z.string().optional().nullable(),
  attachmentUrl: z.string().optional().nullable(),
  lines:         z.array(billLineSchema).min(1),
})

// A supplier's tax profile (H8 / H28) — the ONE vendor master: OpEx and CapEx
// vendors are Suppliers too. whtExemptUntil is a PKT date; the certificate
// covers that whole day (stored as its last instant).
const supplierTaxFields = {
  filerStatus:         z.enum(FILER_STATUSES).optional(),
  whtExemptCertNo:     z.string().trim().max(100).nullable().optional(),
  whtExemptUntil:      z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'A date (YYYY-MM-DD)').nullable().optional(),
  defaultTaxAuthority: z.enum(TAX_AUTHORITY_KEYS).nullable().optional(),
  defaultWhtSection:   z.enum([...WHT_SECTIONS, 'none']).nullable().optional(),
}
const exemptUntilOf = (v: string | null | undefined): Date | null | undefined =>
  v === undefined ? undefined : v === null ? null : parsePktEndOfDay(v)
// The day a supplier's opening balance is brought forward at (YYYY-MM-DD,
// stored as a DATE); null = the day the supplier was set up. Its postings are
// dated at it (openingBalance.ts).
const zOpeningDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date (YYYY-MM-DD)')
  .refine((v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()), 'Not a real date')
  .nullable().optional()
const openingDateOf = (v: string | null | undefined): Date | null | undefined =>
  v === undefined ? undefined : v === null ? null : new Date(`${v}T00:00:00Z`)

const paymentApplicationSchema = z.object({
  billId:             z.string().uuid(),
  amountAppliedCents: zMoneyCents('An amount applied to a bill', { sign: 'positive' }),
})

const paymentCreateSchema = z.object({
  supplierId:   z.string().uuid(),
  paymentDate:  z.string(),
  method:       z.enum(['cash', 'bank_transfer', 'cheque', 'wallet']),
  // The company bank account the money left (lib/bankAccounts.ts
  // moneyAccountCode, checked against the SUPPLIER's company): required for a
  // wallet (JazzCash / Easypaisa), and for a bank payment when the company has
  // two or more banks; never with cash.
  bankAccountId: z.string().min(1).nullable().optional(),
  reference:    z.string().optional().nullable(),
  amountCents:  zMoneyCents('This payment', { sign: 'positive' }),
  notes:        z.string().optional().nullable(),
  applications: z.array(paymentApplicationSchema).optional(),
})

const creditNoteCreateSchema = z.object({
  number:      z.string().trim().min(1).max(100),
  date:        z.string().min(1),
  reason:      z.enum(CREDIT_NOTE_REASONS),
  lines:       z.array(z.object({
    billLineId:    z.string().uuid(),
    qty:           z.number().positive().finite().nullable().optional(),
    unitCostCents: zMoneyCents('A credit per unit', { sign: 'positive' }).nullable().optional(),
  })).min(1),
  taxCents:    zMoneyCents('The credit note\'s tax').optional(),
  returnStock: z.boolean().optional(),
  applyToBill: z.boolean().optional(),
  notes:       z.string().max(500).nullable().optional(),
})

const creditApplicationSchema = z.object({
  billId:      z.string().uuid(),
  amountCents: zMoneyCents('An amount applied to a bill', { sign: 'positive' }),
})

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function procurementRoutes(fastify: FastifyInstance) {
  // ── Suppliers ──────────────────────────────────────────────────────────────

  fastify.get('/suppliers', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const user = req.staffUser!
    const q = z.object({
      view:       z.enum(['picker']).optional(),
      categoryId: z.string().min(1).optional(),
      tenantId:   z.string().min(1).optional(),
    }).parse(req.query ?? {})
    // The OpEx / CapEx vendor picker: the suppliers of ONE company — the OpEx
    // category's, else the one named, else the active one — resolved in write
    // scope (a foreign category or company is 404), with their tax profile.
    if (q.view === 'picker') {
      let tenantId: string | null = null
      if (q.categoryId) {
        const cat = await prisma.opexCategory.findUnique({ where: { id: q.categoryId }, select: { tenantId: true } })
        if (!cat?.tenantId || !user.memberTenantIds.includes(cat.tenantId)) throw new NotFoundError('OpexCategory', q.categoryId)
        tenantId = cat.tenantId
      } else if (q.tenantId) {
        if (!user.memberTenantIds.includes(q.tenantId)) throw new NotFoundError('Company', q.tenantId)
        tenantId = q.tenantId
      } else {
        tenantId = activeTenantOr422(req, null)
      }
      return prisma.supplier.findMany({
        where:   { tenantId, deletedAt: null, systemKind: null },
        select:  { id: true, name: true, filerStatus: true, whtExemptUntil: true, defaultWhtSection: true, defaultTaxAuthority: true },
        orderBy: { name: 'asc' },
      })
    }
    // Finance reads every supplier of its companies (AP), as the buyer does.
    const isManager = ['admin', 'manager', 'management', 'foh_management', 'boh_management', 'procurement', 'finance'].includes(user.role)
    const tenantWhere = await supplierScopeWhere(req, 'read')
    // System suppliers ('Cash purchases') are never listed.
    const scopeWhere = isManager
      ? { deletedAt: null, systemKind: null, ...tenantWhere }
      : { deletedAt: null, systemKind: null, assignedStaffId: user.id, ...tenantWhere }
    return prisma.supplier.findMany({
      where: scopeWhere,
      include: {
        assignedStaff: { select: { id: true, name: true } },
        // Tenant relation in portfolio mode so the Monitor UI can render
        // the indigo brand chip on each supplier card.
        tenant: { select: { id: true, name: true, slug: true } },
        _count: { select: { purchaseOrders: true, inventoryItems: true, bills: true, payments: true, conversations: true } },
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    })
  })

  // A supplier's opening balance posts to the ledger (Dr 3020 / Cr 2010) and a
  // company move carries its POs and bills with it — managers only. The buyer
  // can add and edit everything else (the edit form re-sends both unchanged,
  // so only a CHANGE is refused).
  const assertManagerFields = (
    req: FastifyRequest,
    body: { openingBalanceCents?: number; openingBalanceDate?: string | null; tenantId?: string | null },
    existing: { openingBalanceCents: DbMoney; openingBalanceDate: Date | null; tenantId: string | null } | null,
  ) => {
    if ((MANAGERS as string[]).includes(req.staffUser!.role)) return
    if (body.openingBalanceCents !== undefined && body.openingBalanceCents !== toCents(existing?.openingBalanceCents ?? 0)) {
      throw new ForbiddenError('Only a manager can set a supplier\'s opening balance.')
    }
    const before = existing?.openingBalanceDate ? existing.openingBalanceDate.toISOString().slice(0, 10) : null
    if (body.openingBalanceDate !== undefined && body.openingBalanceDate !== before) {
      throw new ForbiddenError('Only a manager can set the date of a supplier\'s opening balance.')
    }
    if (existing && body.tenantId !== undefined && body.tenantId !== existing.tenantId) {
      throw new ForbiddenError('Only a manager can move a supplier to another company.')
    }
  }

  fastify.post('/suppliers', { preHandler: requireAuth(...PROCUREMENT_TEAM) }, async (req, reply) => {
    const body = z.object({
      name:                z.string().min(1),
      phone:               z.string().optional(),
      whatsappPhone:       z.string().optional(),
      email:               z.string().email().optional(),
      address:             z.string().optional(),
      taxId:               z.string().optional(),
      notes:               z.string().optional(),
      paymentTermsDays:    z.number().int().min(0).max(365).optional(),
      leadTimeDays:        z.number().int().min(0).max(365).optional(),
      openingBalanceCents: zMoneyCents('The opening balance').optional(),
      openingBalanceDate:  zOpeningDate,
      ...supplierTaxFields,
      // Explicit company picker from the Add Supplier modal. In portfolio
      // view the frontend renders a required dropdown so the CEO doesn't
      // have to bounce out of portfolio to add suppliers per company.
      // Falls back to req.staffUser.tenantId when omitted.
      tenantId:            z.string().min(1).optional(),
    }).parse(req.body)
    assertManagerFields(req, body, null)

    // A new supplier always belongs to a company: the picked one (which must
    // be one of the operator's) or the active one. Never a company-less row —
    // that used to happen for staff with no company, and an orphan is visible
    // to every company.
    let tenantId: string
    try {
      tenantId = activeTenantOr422(req, body.tenantId ?? null)
    } catch (err) {
      if ((err as AppError).code === 'COMPANY_NOT_ALLOWED') {
        throw new ForbiddenError('You can only create a supplier inside a company you belong to.')
      }
      throw err
    }

    // Strip body.tenantId before spreading — Prisma needs the resolved value,
    // not the body field which may be undefined.
    const { tenantId: _bodyTenantId, whtExemptUntil, openingBalanceDate, ...rest } = body
    const supplier = await prisma.supplier.create({
      data: {
        ...rest,
        ...(whtExemptUntil !== undefined ? { whtExemptUntil: exemptUntilOf(whtExemptUntil) } : {}),
        ...(openingBalanceDate !== undefined ? { openingBalanceDate: openingDateOf(openingBalanceDate) } : {}),
        tenantId,
      },
      include: {
        assignedStaff: { select: { id: true, name: true } },
        tenant:        { select: { id: true, name: true, slug: true } },
      },
    })
    if (toCents(supplier.openingBalanceCents) !== 0) await syncOpening(req, supplier.id)
    return reply.status(201).send(supplier)
  })

  fastify.patch<{ Params: { id: string } }>(
    '/suppliers/:id',
    { preHandler: requireAuth(...PROCUREMENT_TEAM) },
    async (req) => {
      const existing = await findSupplierInScope(req, req.params.id, 'write')
      const body = z.object({
        name:                z.string().min(1).optional(),
        phone:               z.string().optional(),
        whatsappPhone:       z.string().optional(),
        email:               z.string().email().optional(),
        address:             z.string().optional(),
        taxId:               z.string().optional(),
        notes:               z.string().optional(),
        category:            z.string().max(50).optional(),
        assignedStaffId:     z.string().uuid().nullable().optional(),
        // Explicit company transfer — validated against the operator's
        // tenant memberships, mirrors the workforce hub pattern.
        tenantId:            z.string().min(1).nullable().optional(),
        paymentTermsDays:    z.number().int().min(0).max(365).optional(),
        leadTimeDays:        z.number().int().min(0).max(365).optional(),
        openingBalanceCents: zMoneyCents('The opening balance').optional(),
        openingBalanceDate:  zOpeningDate,
        ...supplierTaxFields,
      }).parse(req.body)
      if (existing.systemKind) {
        throw new AppError('SYSTEM_SUPPLIER', `${existing.name} is a system supplier — it cannot be edited`, 422)
      }
      assertManagerFields(req, body, existing)
      // The opening DATE dates the opening entry. Once an opening is on the
      // books, a new date would not move it (only a later delta would land on
      // the new day), so the books and the form would disagree: refuse it.
      // To move it: set the opening balance to 0 (the reversal posts at the
      // old date), then enter the date and the amount again.
      if (body.openingBalanceDate !== undefined) {
        const before = existing.openingBalanceDate ? existing.openingBalanceDate.toISOString().slice(0, 10) : null
        if (body.openingBalanceDate !== before) {
          const posted = (await postedOpeningBalances([existing.id])).get(existing.id)
          if (posted && Array.from(posted.values()).some((v) => v !== 0)) {
            throw new AppError(
              'OPENING_DATE_LOCKED',
              `${existing.name}'s opening balance is already on the books at its current date — set the opening balance to 0 and save, then enter the new date and the amount again`,
              409,
            )
          }
        }
      }
      // A supplier moves between the operator's companies, never out of them:
      // clearing its company would make it (and its POs, bills and threads)
      // visible to every company.
      if (body.tenantId === null) {
        throw new AppError('SUPPLIER_COMPANY_REQUIRED', 'A supplier must belong to a company', 422)
      }
      if (body.tenantId && !req.staffUser!.memberTenantIds.includes(body.tenantId)) {
        throw new ForbiddenError('You can only transfer a supplier into a company you belong to.')
      }
      // The assigned buyer must work for the supplier's company.
      const targetTenant = body.tenantId ?? existing.tenantId
      if (body.assignedStaffId && targetTenant) {
        const staff = await prisma.user.findFirst({
          where: {
            id: body.assignedStaffId,
            deletedAt: null,
            OR: [{ tenantId: targetTenant }, { tenantMemberships: { some: { tenantId: targetTenant } } }],
          },
          select: { id: true },
        })
        if (!staff) throw new AppError('STAFF_NOT_IN_COMPANY', 'That staff member does not work for this supplier\'s company', 422)
      }
      const { whtExemptUntil, openingBalanceDate, ...fields } = body
      const updated = await prisma.supplier.update({
        where: { id: req.params.id },
        data:  {
          ...fields,
          ...(whtExemptUntil !== undefined ? { whtExemptUntil: exemptUntilOf(whtExemptUntil) } : {}),
          ...(openingBalanceDate !== undefined ? { openingBalanceDate: openingDateOf(openingBalanceDate) } : {}),
        },
        include: {
          assignedStaff: { select: { id: true, name: true } },
          tenant:        { select: { id: true, name: true, slug: true } },
        },
      })
      // A new opening balance, or a move to another company, re-posts it.
      // (A new opening DATE is refused above once anything is posted.)
      if (body.openingBalanceCents !== undefined || body.openingBalanceDate !== undefined || body.tenantId !== undefined) {
        await syncOpening(req, updated.id)
      }
      return updated
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/suppliers/:id/statement',
    { preHandler: requireAuth(...AP_READERS) },
    async (req) => {
      const supplier = await findSupplierInScope(req, req.params.id, 'read')
      const [bills, creditNotes, payments, aging] = await Promise.all([
        prisma.supplierBill.findMany({ where: { supplierId: req.params.id, kind: 'bill' }, orderBy: { billDate: 'desc' } }),
        prisma.supplierBill.findMany({ where: { supplierId: req.params.id, kind: 'credit_note' }, orderBy: { billDate: 'desc' } }),
        prisma.supplierPayment.findMany({ where: { supplierId: req.params.id }, orderBy: { paymentDate: 'desc' }, include: { applications: true } }),
        supplierAging(req.params.id),
      ])
      // ONE balance, the AP aging row's total: open bills net of withholding,
      // payments and credit notes applied, plus the posted opening balance,
      // less unapplied payments and unapplied credit notes — which is this
      // supplier's AP 2010 balance in the ledger. The opening balance is
      // counted once, inside it (openingBalance.ts posts it).
      const outstanding = aging?.total ?? 0
      return {
        supplier,
        outstanding,
        ledgerOutstanding: outstanding,   // same figure; kept for older clients
        openingBalanceCents: supplier.openingBalanceCents,
        openingUnpostedCents: aging?.openingUnpostedCents ?? 0,
        aging,
        bills,
        creditNotes: await withOriginalBill(creditNotes),
        payments: await withBankNames(payments),
      }
    },
  )

  // ── Purchase Orders ────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { supplierId?: string; status?: string; limit?: string } }>(
    '/purchase-orders',
    { preHandler: requireAuth(...AP_READERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200)
      // Scope by supplier.tenantId — that's the single tenant anchor for
      // every procurement entity. PO returns include the supplier so the
      // result already carries the tenant context downstream consumers need.
      const tenantWhere = await supplierScopeWhere(req, 'read')
      return prisma.purchaseOrder.findMany({
        where: {
          supplier: tenantWhere,
          ...(req.query.supplierId && { supplierId: req.query.supplierId }),
          ...(req.query.status     && { status: req.query.status }),
        },
        include: {
          supplier: { select: { name: true, email: true, tenantId: true, tenant: { select: { id: true, name: true, slug: true } } } },
          lines:    { include: { inventoryItem: { select: { name: true, unit: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/purchase-orders/:id',
    { preHandler: requireAuth(...AP_READERS) },
    async (req) => {
      const po = await prisma.purchaseOrder.findFirst({
        where: { id: req.params.id, supplier: await supplierScopeWhere(req, 'read') },
        include: {
          supplier:    { include: { tenant: { select: { id: true, name: true, slug: true } } } },
          lines:       { include: { inventoryItem: true, discrepancies: true } },
          activityLog: { include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' } },
          bills:       true,
        },
      })
      if (!po) throw new NotFoundError('PurchaseOrder', req.params.id)
      return po
    },
  )

  fastify.post('/purchase-orders', { preHandler: requireAuth(...PROCUREMENT_TEAM) }, async (req, reply) => {
    const body = poCreateSchema.parse(req.body)
    // Don't let the operator post a PO against a supplier they can't see.
    // createPo then checks every line's item is the supplier's company's.
    // Through a head-office lens ('write' = members ∪ the lens company) a new
    // DRAFT is a proposal (spec §6.4) — allowed; it goes nowhere until submitted.
    const supplier = await findSupplierInScope(req, body.supplierId, 'write', { live: true })
    if (supplier.tenantId) await assertHoMayPropose(req, supplier.tenantId, true, 'a purchase order')
    const po = await createPo({ ...body, createdBy: req.staffUser!.id })
    return reply.status(201).send(po)
  })

  // Helper used by every PO lifecycle endpoint: the PO, through its
  // supplier's company, or 404.
  async function guardPo(req: FastifyRequest, poId: string) {
    const po = await prisma.purchaseOrder.findFirst({
      where:  { id: poId, supplier: await supplierScopeWhere(req, 'write') },
      select: { id: true, status: true, createdBy: true, supplier: { select: { tenantId: true } } },
    })
    if (!po) throw new NotFoundError('PurchaseOrder', poId)
    return po
  }

  // Submit. Through a head-office lens only your OWN PO (createdBy), and it
  // always goes to pending_approval whatever the threshold — the CEO (or the
  // Procurement hand-over) decides it (spec §6.4, A3). Everyone else: as before.
  fastify.post<{ Params: { id: string } }>(
    '/purchase-orders/:id/submit',
    { preHandler: requireAuth(...PROCUREMENT_TEAM) },
    async (req) => {
      const po = await guardPo(req, req.params.id)
      const tenantId = po.supplier.tenantId
      // The bell: a PO that entered the approval queue (queued, after the submit committed).
      // Round = the PO's updatedAt stamped by this submit, so a reject + resubmit notifies again.
      const announce = async (r: { status: string }) => {
        if (r.status !== 'pending_approval') return
        const row = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id }, select: { updatedAt: true } })
        approvalWaiting(PO_TYPE, req.params.id, { round: `submit:${(row?.updatedAt ?? new Date()).toISOString()}`, actorId: req.staffUser!.id })
      }
      if (!tenantId) { const r = await submitPo(req.params.id, req.staffUser!.id); await announce(r).catch(() => {}); return r }
      await assertHoMayPropose(req, tenantId, po.createdBy === req.staffUser!.id, "submitting someone else's purchase order")
      const via = await viaHeadOfficeForSubmit(req, tenantId)
      if (!via) { const r = await submitPo(req.params.id, req.staffUser!.id); await announce(r).catch(() => {}); return r }
      const result = await submitPo(req.params.id, req.staffUser!.id, { forceApproval: true, viaHeadOfficeId: via })
      await audit({
        category: 'accounting', action: 'po.submit', entity: 'PurchaseOrder', entityId: req.params.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId,
        metadata: { status: result.status, viaHeadOfficeId: via },
      })
      await announce(result).catch(() => {})
      return result
    },
  )

  // Approve / reject (D3, spec §7.3 + A5). The guard is ALL_STAFF plus the
  // module gate; who may decide is lib/approvalRights.ts: the CEO (role path,
  // in their member companies) or a live Procurement hand-over covering the
  // PO's company — never anyone who raised it. The PO's facts are read on
  // serviceClient BEFORE the right is proven (approvalSubject), then the
  // service re-reads it through `prisma` (RLS widened by assertCanApprove)
  // and claims it on status 'pending_approval' (a lost race → 409).
  // With no head office and no hand-over this answers exactly as the old
  // ADMIN_ONLY + guardPo did (same 403 role message, same 404).
  async function poDecisionRight(req: FastifyRequest, poId: string, action: 'approve' | 'reject') {
    await assertApproverRoleOrDelegate(req, PO_TYPE)
    const s = await approvalSubject(PO_TYPE, poId)
    if (!s) throw new NotFoundError('PurchaseOrder', poId)
    // A PO of a supplier with no company: the old guard admitted it only to an
    // operator with some company in scope; keep that.
    if (s.companyIds.length === 0 && (req.staffUser!.memberTenantIds ?? []).length === 0) throw new NotFoundError('PurchaseOrder', poId)
    let grant: ApprovalGrant
    try {
      grant = await assertCanApprove(req, approvalInputOf(PO_TYPE, poId, s, { entity: 'PurchaseOrder', action: `${action} purchase order` }))
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) throw new NotFoundError('PurchaseOrder', poId)
      throw err
    }
    return { s, grant }
  }

  fastify.post<{ Params: { id: string } }>(
    '/purchase-orders/:id/approve',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { s, grant } = await poDecisionRight(req, req.params.id, 'approve')
      const result = await approvePo(req.params.id, req.staffUser!.id, grant)
      await auditApproval(req, { type: PO_TYPE, id: req.params.id, tenantId: s.ownerTenantId, decision: 'approve', grant, entity: 'PurchaseOrder' })
      return result
    },
  )

  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/purchase-orders/:id/reject',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { s, grant } = await poDecisionRight(req, req.params.id, 'reject')
      const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body)
      const result = await rejectPo(req.params.id, req.staffUser!.id, reason, grant)
      await auditApproval(req, { type: PO_TYPE, id: req.params.id, tenantId: s.ownerTenantId, decision: 'reject', grant, entity: 'PurchaseOrder', metadata: { reason } })
      return result
    },
  )

  // Cancel. Through a head-office lens only your OWN PO, while it is still a
  // draft or waiting for approval (spec §6.4).
  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/purchase-orders/:id/cancel',
    { preHandler: requireAuth(...PROCUREMENT_TEAM) },
    async (req) => {
      const po = await guardPo(req, req.params.id)
      if (po.supplier.tenantId) {
        const own = po.createdBy === req.staffUser!.id && (po.status === 'draft' || po.status === 'pending_approval')
        await assertHoMayPropose(req, po.supplier.tenantId, own, "cancelling this purchase order")
      }
      const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body)
      return cancelPo(req.params.id, req.staffUser!.id, reason)
    },
  )

  // Send an approved PO: email and/or WhatsApp. 'sent' only when it went out.
  fastify.post<{ Params: { id: string } }>(
    '/purchase-orders/:id/send',
    { preHandler: requireAuth(...PROCUREMENT_TEAM) },
    async (req) => { await guardPo(req, req.params.id); return sendPoToSupplier(req.params.id, req.staffUser!.id) },
  )

  // The buyer sent it themselves (phone, own WhatsApp, in person) — record how.
  fastify.post<{ Params: { id: string } }>(
    '/purchase-orders/:id/mark-sent',
    { preHandler: requireAuth(...PROCUREMENT_TEAM) },
    async (req) => {
      await guardPo(req, req.params.id)
      const body = z.object({
        channel: z.enum(['phone', 'whatsapp', 'email', 'in_person']),
        note:    z.string().max(200).nullable().optional(),
      }).parse(req.body ?? {})
      return markPoSent(req.params.id, req.staffUser!.id, body)
    },
  )

  // Receive against a PO — the same receiveGoods() the dock page
  // (POST /crosschecks/receiving) calls: writes the GoodsReceipt, the PO line
  // quantities, the FIFO lots (a quantity a bill already priced at the billed
  // price) and Dr 12x0 / Cr 2015 GRNI in one transaction, with the photo
  // threshold and the raiser-can't-receive rule (CEO exempt).
  fastify.post<{ Params: { id: string } }>(
    '/purchase-orders/:id/receive',
    { preHandler: requireAuth(...MANAGERS), bodyLimit: RECORD_FILES_BODY_LIMIT },
    async (req, reply) => {
      await guardPo(req, req.params.id)
      const body = z.object({
        photoUrl: z.string().url().nullable().optional(),
        // The dock-door photos as files (owner, 2026-10-16) — record files of the receipt.
        photos:   z.array(zRecordFile).max(RECORD_FILES_MAX_PER_UPLOAD, `At most ${RECORD_FILES_MAX_PER_UPLOAD} photos`).optional(),
        notes:    z.string().max(500).nullable().optional(),
        // The outlet the goods arrived at (one of the supplier's company's — else 422 LOCATION_NOT_IN_COMPANY).
        locationId: z.string().min(1).nullable().optional(),
        lines: z.array(z.object({
          poLineId:           z.string().uuid(),
          quantityReceived:   z.number().min(0),
          discrepancyReason:  z.enum(['short_shipment', 'over_shipment', 'damaged', 'wrong_item', 'quality_issue']).optional(),
          // `discrepancyNotes` is the older name for the line note.
          discrepancyNotes:   z.string().max(200).optional(),
          notes:              z.string().max(200).nullable().optional(),
        })).min(1),
      }).parse(req.body)
      const photoFiles = decodeRecordFiles(body.photos ?? [], { allowOffice: false, stem: 'dock-photo' })
      const result = await receiveGoods({
        actor:    req.staffUser!,
        poId:     req.params.id,
        locationId: body.locationId ?? null,
        photoUrl: body.photoUrl ?? null,
        photoFiles,
        notes:    body.notes ?? null,
        lines:    body.lines.map((l) => ({
          poLineId:          l.poLineId,
          quantityReceived:  l.quantityReceived,
          discrepancyReason: l.discrepancyReason ?? null,
          notes:             l.notes ?? l.discrepancyNotes ?? null,
        })),
      })
      return reply.status(201).send({ ok: true, status: result.poStatus, receipt: result.receipt, flagged: result.flagged, files: result.files })
    },
  )

  // ── Bills (AP) ─────────────────────────────────────────────────────────────

  // GET /procurement/ap-aging — THE accounts-payable aging (service.ts
  // agingReport): net of withholding, by due date, unapplied payments as
  // credits, opening balances on their own, suppliers with no company apart.
  // Behind the Accounting AP aging page and the Procurement Aging tab; open to
  // finance as well as managers (module: procurement OR accounting).
  //
  // ?asOf=YYYY-MM-DD: the aging AS AT the end of that Karachi day (every bill,
  // credit note, payment and application rebuilt as it stood then), so a
  // month-end aging run later still ties to AP 2010 in the trial balance.
  // Suppliers with no company (legacy rows, never in any company's books) are
  // listed to the CEO only — anyone else would see other companies' names.
  fastify.get('/ap-aging', { preHandler: requireAuth(...FINANCE_TEAM, 'procurement') }, async (req) => {
    const q = z.object({
      asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date as YYYY-MM-DD').optional(),
    }).parse(req.query ?? {})
    let asOf: Date | undefined
    if (q.asOf) {
      asOf = parsePktEndOfDay(q.asOf)
      if (Number.isNaN(asOf.getTime())) throw new AppError('INVALID_DATE', 'Give the date as YYYY-MM-DD', 422)
    }
    const scope = await resolveTenantScope(req)
    return agingReport(scope.tenantIds, { asOf, includeUnassigned: req.staffUser!.role === 'admin' })
  })

  // Bills by default. A supplier credit note is a SupplierBill row too (kind
  // 'credit_note'); ?kind=credit_note lists them (with the original bill's
  // number), ?kind=all both. Every existing caller (petty cash's bill picker,
  // the payment allocator, the Accounting widgets) asks for bills.
  fastify.get<{ Querystring: { supplierId?: string; status?: string; overdue?: string; kind?: string } }>(
    '/bills',
    { preHandler: requireAuth(...AP_READERS) },
    async (req) => {
      const tenantWhere = await supplierScopeWhere(req, 'read')
      const kind = z.enum(['bill', 'credit_note', 'all']).default('bill').parse(req.query.kind ?? undefined)
      const rows = await prisma.supplierBill.findMany({
        where: {
          supplier: tenantWhere,
          ...(kind !== 'all' && { kind }),
          ...(req.query.supplierId && { supplierId: req.query.supplierId }),
          ...(req.query.status     && { status: req.query.status }),
          ...(req.query.overdue === 'true' && {
            kind:    'bill',
            status:  { in: ['open', 'partially_paid'] },
            dueDate: { lt: overdueCutoff() },
          }),
        },
        include: { supplier: { select: { name: true, tenantId: true } }, po: { select: { id: true, reference: true } } },
        orderBy: { billDate: 'desc' },
        take: 200,
      })
      return kind === 'bill' ? rows : withOriginalBill(rows)
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/bills/:id',
    { preHandler: requireAuth(...AP_READERS) },
    async (req) => {
      const bill = await prisma.supplierBill.findFirst({
        where: { id: req.params.id, supplier: await supplierScopeWhere(req, 'read') },
        include: {
          supplier: true,
          po:       true,
          lines:    { include: { inventoryItem: true, poLine: { include: { inventoryItem: true } } } },
          applications: { include: { payment: true } },
          // Credit notes applied to this bill / bills this credit note settles.
          creditsReceived: { include: { creditNote: { select: { id: true, billNumber: true, billDate: true } } } },
          creditsGiven:    { include: { bill: { select: { id: true, billNumber: true } } } },
        },
      })
      if (!bill) throw new NotFoundError('SupplierBill', req.params.id)
      const [withOriginal] = await withOriginalBill([bill])
      // For a bill: what is left to credit, line by line (the credit-note form).
      return { ...withOriginal, creditable: bill.kind === 'bill' ? await creditableBill(bill.id) : null }
    },
  )

  fastify.post('/bills', apWrite, async (req, reply) => {
    const body = billCreateSchema.parse(req.body)
    // createBill then checks the PO, PO lines and items are this supplier's,
    // and posts the bill in the same transaction that saves it (a closed
    // month is PERIOD_LOCKED 422 — nothing saved half-way).
    const supplier = await findSupplierInScope(req, body.supplierId, 'write', { live: true })
    const bill = await createBill({
      ...body, createdBy: req.staffUser!.id, actorRole: req.staffUser!.role, actorEmail: req.staffUser!.email ?? null,
    })
    await auditMoney(req, 'supplier.bill.create', 'SupplierBill', bill.id, supplier.tenantId, {
      supplierId: supplier.id, billNumber: bill.billNumber, poId: body.poId ?? null,
      totalCents: toCents(bill.totalCents), whtCents: toCents(bill.whtCents), actorRole: req.staffUser!.role,
    })
    return reply.status(201).send(bill)
  })

  // Bill guard — used by void / match / credit notes. Looks up the bill (or
  // credit note), scopes it through its supplier's company (404 when foreign).
  async function guardBill(req: FastifyRequest, billId: string) {
    const bill = await prisma.supplierBill.findFirst({
      where:  { id: billId, supplier: await supplierScopeWhere(req, 'write') },
      select: { id: true, kind: true, supplier: { select: { tenantId: true } } },
    })
    if (!bill) throw new NotFoundError('SupplierBill', billId)
    return bill
  }

  // A credit note, scoped the same way (404 when foreign, or not a credit note).
  async function guardCreditNote(req: FastifyRequest, id: string) {
    const cn = await prisma.supplierBill.findFirst({
      where:  { id, kind: 'credit_note', supplier: await supplierScopeWhere(req, 'write') },
      select: { id: true, billNumber: true, supplierId: true, supplier: { select: { tenantId: true } } },
    })
    if (!cn) throw new NotFoundError('SupplierCreditNote', id)
    return cn
  }

  // Bills named in a request body (a payment's or credit's applications) must
  // be in the operator's companies: a foreign id is 404 — never a message
  // that names another company's bill. Same-supplier is checked after.
  async function assertBillsInScope(req: FastifyRequest, billIds: string[]) {
    const ids = Array.from(new Set(billIds))
    if (ids.length === 0) return
    const found = await prisma.supplierBill.findMany({
      where:  { id: { in: ids }, supplier: await supplierScopeWhere(req, 'write') },
      select: { id: true },
    })
    const missing = ids.find((id) => !found.some((b) => b.id === id))
    if (missing) throw new NotFoundError('SupplierBill', missing)
  }

  const auditMoney = (req: FastifyRequest, action: string, entity: string, entityId: string, tenantId: string | null, metadata: Record<string, unknown>) =>
    audit({
      category: 'accounting', action, entity, entityId,
      userId: req.staffUser?.id ?? null, userEmail: req.staffUser?.email ?? null,
      // The document's company (the supplier's), which the operator belongs to.
      tenantId,
      metadata,
    })

  // Read-only views of a bill (the 3-way match) scope like the bill list.
  async function guardBillRead(req: FastifyRequest, billId: string) {
    const bill = await prisma.supplierBill.findFirst({
      where:  { id: billId, supplier: await supplierScopeWhere(req, 'read') },
      select: { id: true },
    })
    if (!bill) throw new NotFoundError('SupplierBill', billId)
  }

  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/bills/:id/void',
    apWrite,
    async (req) => {
      const found = await guardBill(req, req.params.id)
      const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body)
      // A credit note voids through its own path (stock back, its reversal).
      if (found.kind === 'credit_note') {
        const r = await voidCreditNote(req.params.id, req.staffUser!.id, reason)
        if (!r.alreadyVoid) await auditMoney(req, 'supplier.credit_note.void', 'SupplierBill', req.params.id, found.supplier.tenantId, { reason })
        return r.creditNote
      }
      // The ledger reversal commits with the void (service.ts voidBill).
      const voided = await voidBill(req.params.id, req.staffUser!.id, reason)
      await auditMoney(req, 'supplier.bill.void', 'SupplierBill', req.params.id, found.supplier.tenantId, { reason })
      return voided
    },
  )

  // ── Supplier credit notes / returns (finance gaps 14a, ./creditNotes.ts) ──

  // Record the supplier's credit note against one of its bills: lines picked
  // from the bill, goods optionally sent back (stock drops), posted in the
  // same transaction (a closed month is PERIOD_LOCKED 422 — nothing saved),
  // applied to the bill at once unless applyToBill is false.
  fastify.post<{ Params: { id: string } }>(
    '/bills/:id/credit-notes',
    apWrite,
    async (req, reply) => {
      const found = await guardBill(req, req.params.id)
      const body = creditNoteCreateSchema.parse(req.body)
      const r = await createCreditNote({ ...body, billId: req.params.id, createdBy: req.staffUser!.id })
      await auditMoney(req, 'supplier.credit_note.create', 'SupplierBill', r.creditNote.id, found.supplier.tenantId, {
        billId: req.params.id, billNumber: r.billNumber, number: r.creditNote.billNumber, reason: body.reason,
        totalCents: toCents(r.creditNote.totalCents), whtCents: toCents(r.creditNote.whtCents),
        returnStock: body.returnStock ?? false, appliedCents: r.appliedCents, entryId: r.entryId,
      })
      return reply.status(201).send({ ...r.creditNote, appliedCents: r.appliedCents })
    },
  )

  // Apply a credit note to open bills of the same supplier (no ledger change).
  fastify.post<{ Params: { id: string } }>(
    '/credit-notes/:id/apply',
    apWrite,
    async (req) => {
      const cn = await guardCreditNote(req, req.params.id)
      const body = z.object({ applications: z.array(creditApplicationSchema).min(1) }).parse(req.body)
      await assertBillsInScope(req, body.applications.map((a) => a.billId))
      const r = await applyCreditNote(req.params.id, body.applications, req.staffUser!.id)
      await auditMoney(req, 'supplier.credit_note.apply', 'SupplierBill', req.params.id, cn.supplier.tenantId, { applications: body.applications })
      return r
    },
  )

  // Take a credit note off a bill (no ledger change).
  fastify.post<{ Params: { id: string } }>(
    '/credit-notes/:id/unapply',
    apWrite,
    async (req) => {
      const cn = await guardCreditNote(req, req.params.id)
      const { billId } = z.object({ billId: z.string().uuid() }).parse(req.body)
      await assertBillsInScope(req, [billId])
      const r = await unapplyCreditNote(req.params.id, billId, { userId: req.staffUser!.id, reason: trashReasonOf(req) })
      await auditMoney(req, 'supplier.credit_note.unapply', 'SupplierBill', req.params.id, cn.supplier.tenantId, { billId, amountCents: r.amountCents })
      return { creditNoteId: r.creditNoteId, billId: r.billId, amountCents: r.amountCents, billStatus: r.billStatus }
    },
  )

  // Void a credit note entered in error — only while applied to no bill.
  fastify.post<{ Params: { id: string } }>(
    '/credit-notes/:id/void',
    apWrite,
    async (req) => {
      const cn = await guardCreditNote(req, req.params.id)
      const { reason } = z.object({ reason: z.string().trim().min(1) }).parse(req.body)
      const r = await voidCreditNote(req.params.id, req.staffUser!.id, reason)
      if (!r.alreadyVoid) await auditMoney(req, 'supplier.credit_note.void', 'SupplierBill', req.params.id, cn.supplier.tenantId, { reason })
      return r.creditNote
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/bills/:id/match',
    { preHandler: requireAuth(...AP_READERS) },
    async (req) => { await guardBillRead(req, req.params.id); return matchBill(req.params.id) },
  )

  // ── Supplier Payments ──────────────────────────────────────────────────────

  fastify.get<{ Querystring: { supplierId?: string } }>(
    '/payments',
    { preHandler: requireAuth(...AP_READERS) },
    async (req) => {
      const tenantWhere = await supplierScopeWhere(req, 'read')
      const rows = await prisma.supplierPayment.findMany({
        where: {
          supplier: tenantWhere,
          ...(req.query.supplierId ? { supplierId: req.query.supplierId } : {}),
        },
        include: {
          supplier:     { select: { name: true, tenantId: true } },
          applications: { include: { bill: { select: { id: true, billNumber: true, totalCents: true } } } },
        },
        orderBy: { paymentDate: 'desc' },
        take: 200,
      })
      return withBankNames(rows)
    },
  )

  fastify.post('/payments', apWrite, async (req, reply) => {
    const body = paymentCreateSchema.parse(req.body)
    // createPayment then checks every applied bill is this supplier's, and
    // the bank account is a live, linked account of the supplier's company
    // (another company's bank is 422 BANK_ACCOUNT_NOT_IN_COMPANY, nothing saved).
    const supplier = await findSupplierInScope(req, body.supplierId, 'write', { live: true })
    await assertBillsInScope(req, (body.applications ?? []).map((a) => a.billId))
    // Posted in the same transaction (service.ts createPaymentTx): a payment
    // dated in a closed month is PERIOD_LOCKED 422 and is not saved.
    const payment = await createPayment({ ...body, createdBy: req.staffUser!.id })
    await auditMoney(req, 'supplier.payment.create', 'SupplierPayment', payment.id, supplier.tenantId, {
      supplierId: supplier.id, method: payment.method, bankAccountId: payment.bankAccountId,
      amountCents: toCents(payment.amountCents), appliedCents: toCents(payment.appliedCents),
    })
    const [withBank] = await withBankNames([payment])
    return reply.status(201).send(withBank)
  })

  async function guardPayment(req: FastifyRequest, id: string) {
    const payment = await prisma.supplierPayment.findFirst({
      where:  { id, supplier: await supplierScopeWhere(req, 'write') },
      select: { id: true, supplier: { select: { tenantId: true } } },
    })
    if (!payment) throw new NotFoundError('SupplierPayment', id)
    return payment
  }

  fastify.post<{ Params: { id: string }; Body: { applications: Array<{ billId: string; amountAppliedCents: number }> } }>(
    '/payments/:id/allocate',
    apWrite,
    async (req) => {
      const payment = await guardPayment(req, req.params.id)
      const body = z.object({ applications: z.array(paymentApplicationSchema).min(1) }).parse(req.body)
      await assertBillsInScope(req, body.applications.map((a) => a.billId))
      const r = await allocatePayment(req.params.id, body.applications)
      await auditMoney(req, 'supplier.payment.allocate', 'SupplierPayment', req.params.id, payment.supplier.tenantId, { applications: body.applications })
      return r
    },
  )

  // Take a payment off one bill: the bill re-opens, the money is an unapplied
  // credit again. No ledger change (the payment already debited AP 2010).
  fastify.post<{ Params: { id: string } }>(
    '/payments/:id/unapply',
    apWrite,
    async (req) => {
      const payment = await guardPayment(req, req.params.id)
      const { billId } = z.object({ billId: z.string().uuid() }).parse(req.body)
      await assertBillsInScope(req, [billId])
      const r = await unapplyPayment(req.params.id, billId, { userId: req.staffUser!.id, reason: trashReasonOf(req) })
      await auditMoney(req, 'supplier.payment.unapply', 'SupplierPayment', req.params.id, payment.supplier.tenantId, { billId, amountCents: r.amountCents })
      return { paymentId: req.params.id, billId, amountCents: r.amountCents, billStatus: r.bill.status }
    },
  )

  // Void a payment (bounced cheque, recorded twice) — only while it is
  // applied to no bill. Its entry is reversed in the same transaction
  // ('supplier.payment.void', dated today); voiding twice is a no-op.
  fastify.post<{ Params: { id: string } }>(
    '/payments/:id/void',
    apWrite,
    async (req) => {
      const payment = await guardPayment(req, req.params.id)
      const { reason } = z.object({ reason: z.string().trim().min(1) }).parse(req.body)
      const r = await voidPayment(req.params.id, req.staffUser!.id, reason)
      if (!r.alreadyVoid) {
        await auditMoney(req, 'supplier.payment.void', 'SupplierPayment', req.params.id, payment.supplier.tenantId, {
          reason, amountCents: toCents(r.payment.amountCents), reversalEntryId: r.reversal?.entryId ?? null,
        })
      }
      const [withBank] = await withBankNames([r.payment])
      return withBank
    },
  )

  // ── Aging + reorder + price history ────────────────────────────────────────

  fastify.get('/reorder', { preHandler: requireAuth(...PROCUREMENT_TEAM) }, async (req) => {
    const scope = await resolveTenantScope(req)
    return reorderSuggestions(scope.tenantIds)
  })

  fastify.get<{ Querystring: { itemId?: string; supplierId?: string; limit?: string } }>(
    '/price-history',
    { preHandler: requireAuth(...PROCUREMENT_TEAM) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500)
      // Anchored on the item (company master data): only this company's
      // items' prices, and — when a supplier is on the row — only a supplier
      // in scope. A row with no supplier (a manual cost edit) is the item's
      // company's; it used to come through for every company.
      const itemWhere     = await scopeTenantWhere(req, 'read')
      const supplierWhere = await supplierScopeWhere(req, 'read')
      return prisma.itemPriceHistory.findMany({
        where: {
          inventoryItem: itemWhere,
          OR: [
            { supplier: supplierWhere },
            { supplierId: null },
          ],
          ...(req.query.itemId     && { inventoryItemId: req.query.itemId }),
          ...(req.query.supplierId && { supplierId: req.query.supplierId }),
        },
        include: {
          inventoryItem: { select: { name: true, unit: true } },
          supplier:      { select: { name: true } },
        },
        orderBy: { recordedAt: 'desc' },
        take: limit,
      })
    },
  )

  // ── Approvals queue ────────────────────────────────────────────────────────

  // The queue (D3, spec §7.4.5): the companies whose PO approvals the caller
  // may decide — (view ∩ members) for the CEO's role path, plus every company
  // a live Procurement hand-over covers (approvalQueueTenantIds, RLS widened).
  // A delegate never sees their own POs or one that came through another head
  // office (canApprove per row). A role-path caller keeps the old list
  // (suppliers with no company included). Nobody else: the old 403.
  fastify.get('/approvals', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    await assertApproverRoleOrDelegate(req, PO_TYPE)
    const su = req.staffUser!
    const roleAllows = (APPROVAL_RIGHTS[PO_TYPE].roles as readonly string[]).includes(su.role)
    const members = new Set(su.memberTenantIds ?? [])
    const roleIds = roleAllows ? (await resolveTenantScope(req)).tenantIds.filter((t) => members.has(t)) : []
    const queueIds = await approvalQueueTenantIds(req, PO_TYPE)
    if (queueIds.length === 0 && roleIds.length === 0) {
      return []
    }
    const supplierWhere: Prisma.SupplierWhereInput = roleIds.length > 0
      ? { OR: [{ tenantId: { in: queueIds } }, { tenantId: null }] }
      : { tenantId: { in: queueIds } }
    const rows = await prisma.purchaseOrder.findMany({
      where: { status: 'pending_approval', supplier: supplierWhere },
      include: {
        supplier: { select: { name: true, tenantId: true } },
        lines:    { include: { inventoryItem: { select: { name: true, unit: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    })
    const roleSet = new Set(roleIds)
    const keep = await Promise.all(rows.map(async (po) => {
      const t = po.supplier.tenantId
      if (t === null || roleSet.has(t)) return true
      // A company reached only through a hand-over: list what the delegate may decide.
      return canApprove(req, approvalInputOf(PO_TYPE, po.id, {
        companyIds: [t], ownerTenantId: t, submitterIds: po.createdBy ? [po.createdBy] : [],
        viaHeadOfficeId: po.viaHeadOfficeId, status: po.status, submittedAt: null,
      }))
    }))
    return rows.filter((_, i) => keep[i])
  })

  // ── Backfill: bills / payments that never reached the ledger ───────────────

  // POST /procurement/post-unposted — bills and payments saved before posting
  // moved into the save's transaction, whose after-commit post failed (most
  // often a closed month). Admin; dry run by default. Each posts in its own
  // transaction at its own date; one in a closed month is listed with the
  // reason, never forced into another period.
  fastify.post('/post-unposted', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ dryRun: z.boolean().default(true) }).parse(req.body ?? {})
    const tenantIds = (await resolveTenantScope(req)).tenantIds
    if (tenantIds.length === 0) return { dryRun: body.dryRun, rows: [] }
    const [bills, payments, entries] = await Promise.all([
      // Bills only: a credit note posts in the transaction that saves it.
      prisma.supplierBill.findMany({
        where:   { kind: 'bill', status: { notIn: ['void', 'draft'] }, supplier: { tenantId: { in: tenantIds } } },
        select:  { id: true, billNumber: true, billDate: true, totalCents: true, subtotalCents: true, taxCents: true, supplier: { select: { name: true, tenantId: true } } },
        orderBy: { billDate: 'asc' },
      }),
      prisma.supplierPayment.findMany({
        where:   { voidedAt: null, supplier: { tenantId: { in: tenantIds } } },
        select:  { id: true, paymentDate: true, amountCents: true, supplier: { select: { name: true, tenantId: true } } },
        orderBy: { paymentDate: 'asc' },
      }),
      prisma.journalEntry.findMany({
        where:  { tenantId: { in: tenantIds }, reference: { startsWith: 'supplier.' } },
        select: { tenantId: true, reference: true },
      }),
    ])
    const onBooks = new Set(entries.map((e) => `${e.tenantId}|${e.reference}`))
    type Row = { kind: 'bill' | 'payment'; id: string; label: string; date: Date; amountCents: number; outcome: string }
    const rows: Row[] = []
    const run = async (row: Omit<Row, 'outcome'>, ref: string, tenantId: string, post: () => Promise<{ posted: boolean; reason?: string }>) => {
      if (onBooks.has(`${tenantId}|${ref}`)) return
      if (body.dryRun) { rows.push({ ...row, outcome: 'would_post' }); return }
      try {
        const r = await post()
        rows.push({ ...row, outcome: r.posted ? 'posted' : (r.reason ?? 'skipped') })
      } catch (err) {
        const e = err as AppError
        rows.push({ ...row, outcome: `${e.code ?? 'error'}: ${e.message}` })
      }
    }
    for (const b of bills) {
      if (toCents(b.subtotalCents) === 0 && toCents(b.taxCents) === 0) continue
      await run({ kind: 'bill', id: b.id, label: `${b.supplier.name} bill ${b.billNumber}`, date: b.billDate, amountCents: toCents(b.totalCents) },
        `supplier.bill:${b.id}`, b.supplier.tenantId!, () => postSupplierBill(b.id))
    }
    for (const p of payments) {
      await run({ kind: 'payment', id: p.id, label: `Payment to ${p.supplier.name}`, date: p.paymentDate, amountCents: toCents(p.amountCents) },
        `supplier.payment:${p.id}`, p.supplier.tenantId!, () => postSupplierPayment(p.id))
    }
    return { dryRun: body.dryRun, rows }
  })

  // ── Settings: approval threshold ───────────────────────────────────────────

  // Per company: `procurement.approvalThresholdCents:<tenantId>`, read with
  // the old company-less key as the fallback until the company saves its own
  // (service.ts getApprovalThresholdCents). It used to be one global row, so
  // one company's admin changed every company's approval limit.
  const thresholdQuery = z.object({ tenantId: z.string().min(1).optional() })

  fastify.get('/settings/approval-threshold', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const tenantId = activeTenantOr422(req, thresholdQuery.parse(req.query ?? {}).tenantId ?? null)
    return { tenantId, thresholdCents: await getApprovalThresholdCents(tenantId) }
  })

  fastify.put('/settings/approval-threshold', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const { thresholdCents, tenantId: picked } = z.object({
      thresholdCents: zMoneyCents('The approval limit'),
      tenantId:       z.string().min(1).optional(),
    }).parse(req.body)
    const tenantId = activeTenantOr422(req, picked ?? null)
    await setApprovalThresholdCents(tenantId, thresholdCents)
    return { tenantId, thresholdCents }
  })
}

/** A bill is overdue once its due DAY is before Karachi today. dueDate is stored
 *  as UTC midnight of its day, so the cut-off is UTC midnight of today's
 *  Karachi date — a bill due today is not overdue at 05:00 PKT. */
export function overdueCutoff(now: Date = new Date()): Date {
  return new Date(`${fmtPktDate(now)}T00:00:00Z`)
}
