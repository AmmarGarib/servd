// OpEx tracker â€” recurring operational expense management.
// Categories (Rent, Payroll, Utilities, etc.) â†’ Lines (specific vendors /
// items) â†’ Payments (per-period actuals). Variance vs budget fires flags.
//
// Special: the Payroll category pulls live from HR payroll runs
// rather than manual entry â€” that's wired in the GET /opex endpoint.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY, FINANCE_TEAM } from '../auth/middleware.js'
import { flagException } from '../../lib/exceptions.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, resolveTenantScope } from '../../lib/tenantScope.js'
import { assertConceptOfCompany, assertCapexProjectOfCompany, assertBankAccountOfCompany, assertSupplierOfCompany } from '../financePlanning/companyRefs.js'
import { syncOpexPaymentPosting, OPEX_SOURCE, opexAmountsOf, liveOpexReleases } from './posting.js'
import { classificationOf, classifyingTx, classificationsOfReferences } from '../accounting/paymentsRegister.js'
import { assertCategoryAccount, suggestedCategoryAccount } from './categoryAccounts.js'
import { liveRevisionsFor } from '../accounting/sourcePosting.js'
import { isPayrollCategory, expenseCodeForCategoryName } from '../accounting/expenseCategories.js'
import { profitAndLoss } from '../accounting/reports.js'
import { monthlyLabourCents } from '../projections/labour.js'
import { countedContributions, headOfficePlanCharges, PLAN_LABELS } from '../../lib/labour-budget.js'
import { headOfficeSetupApplied } from '../headOffices/books.js'
import { moduleGateForNewRoles } from './moduleGate.js'
import { assertMoneyFits, toCents, zMoneyCents } from '../../lib/money.js'
import { audit } from '../../lib/audit.js'
import { TAX_AUTHORITY_KEYS, isAuthorityKey, type AuthorityKey } from '../accounting/taxAuthorities.js'
import {
  WHT_SECTIONS, computeWithholding, whtSectionOrNull, withholdingRatesFor, type WhtSection, type WithholdingResult,
} from '../../lib/withholding.js'
import { assertNotEquipmentLine } from '../fixedAssets/classes.js'
import { fmtPktDate } from '../accounting/dates.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'

/** A date the API is given: 'YYYY-MM-DD' or a full ISO timestamp. */
const zDateString = z.string().min(10).max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'Not a date')

/** A paid date can be today or earlier — never a day still to come. Compared
 *  as Karachi days: a 'YYYY-MM-DD' arrives as UTC midnight (05:00 PKT), so an
 *  instant check refused today early and a day of slack let tomorrow through. */
export function assertNotFuturePaid(paidAt: Date | null | undefined, now: Date = new Date()): void {
  if (paidAt && fmtPktDate(paidAt) > fmtPktDate(now)) {
    throw new AppError('PAID_IN_FUTURE', 'A payment cannot be marked paid on a date that has not come yet', 422)
  }
}

/** The 6xxx code a category is booked to: `^6\d{3}$`, null clears it. */
const zExpenseCode = z.string().regex(/^6\d{3}$/, 'An operating-expense account is a 6xxx code').nullable().optional()

const cadenceEnum = z.enum(['monthly', 'quarterly', 'annual', 'per_use'])

// Who works the OpEx tracker (wave 3, UI-07): the manager tiers plus finance.
// OpEx is a page of the 'capital' module, which finance holds by default and
// whose workspace (Finance) it owns — it got 403 on every /opex call. Recording
// a recurring bill as paid posts it to the books (owner decision 23); that is
// finance's normal job. The backfill of old payments stays the CEO's.
// /opex is not a central module-gated prefix, so finance (newly let in) must
// also hold 'capital' — the CEO's Module Access untick closes every route here,
// writes and ledger postings included (W3B-RV-1). Manager tiers unchanged.
export const OPEX_TEAM = FINANCE_TEAM
const OPEX_GUARD = [requireAuth(...OPEX_TEAM), moduleGateForNewRoles(['capital'])]

// Every id an opex line points at — its category, brand, capex project and
// paying bank account — must belong to the line's own company (its
// category's). Checked on create and on every PATCH that sets one, so a
// partial update can never re-bind a line to another company's rows. Null
// clears a link and needs no check.
async function assertLineRefsOfCompany(
  tenantId: string | null,
  refs: { conceptId?: string | null; projectId?: string | null; bankAccountId?: string | null },
): Promise<void> {
  if (refs.conceptId)     await assertConceptOfCompany(tenantId, refs.conceptId)
  if (refs.projectId)     await assertCapexProjectOfCompany(tenantId, refs.projectId)
  if (refs.bankAccountId) await assertBankAccountOfCompany(tenantId, refs.bankAccountId)
}

/** A cash-paid line or payment does not name a bank account (lib/bankAccounts.ts BANK_ACCOUNT_ON_CASH). */
function assertMethodAndBank(method: string | null | undefined, bankAccountId: string | null | undefined): void {
  if (method === 'cash' && bankAccountId) {
    throw new AppError('BANK_ACCOUNT_ON_CASH', 'A cash payment does not use a bank account', 422)
  }
}

// ─── Vendor, withholding and input tax (finance wave B — H8 / H25 / H28) ─────
//
// A line names its vendor as a Supplier of the CATEGORY's company (the one
// vendor master; the page picks it from GET /procurement/suppliers?view=picker):
// supplierId wins over the free-text vendor, which is filled from the
// supplier's name and kept for legacy lines. A line may carry the usual WHT
// section (needs a vendor — its filer status and exemption decide the rate)
// and the authority that usually charges it sales tax.
//
// A payment stores the CASH (actualCents) and the split: invoice = cash +
// WHT, expense = invoice − input tax. The server works the withholding out
// (lib/withholding.ts computeWithholding, base = invoice − input tax) and the
// cash from the invoice — the page computes nothing (GET /opex/wht-quote
// previews it). Budgets and variance compare the EXPENSE, never the cash.

/** 'none' (or null) = no withholding section. */
const zWhtSection = z.enum([...WHT_SECTIONS, 'none']).nullable().optional()
const zAuthority = z.enum(TAX_AUTHORITY_KEYS).nullable().optional()

const lineSchema = z.object({
  categoryId:    z.string().min(1),
  conceptId:     z.string().uuid().nullable().optional(),
  projectId:     z.string().min(1).nullable().optional(),    // optional link to a CapexProject
  name:          z.string().min(1).max(120),
  vendor:        z.string().max(120).nullable().optional(),
  vendorContact: z.string().max(120).nullable().optional(),
  amountCents:   zMoneyCents('A line amount'),
  cadence:       cadenceEnum.default('monthly'),
  nextDueDate:   z.string().nullable().optional(),
  paymentMethod: z.string().max(40).nullable().optional(),
  bankAccountId: z.string().min(1).nullable().optional(),
  source:        z.enum(['manual', 'payroll', 'license', 'subscription']).default('manual'),
  notes:         z.string().nullable().optional(),
  // The vendor as a Supplier of the category's company (wins over `vendor`).
  supplierId:        z.string().min(1).nullable().optional(),
  whtSection:        zWhtSection,
  inputTaxAuthority: zAuthority,
})

/**
 * The supplier a line names, when it is a live, ordinary supplier of the
 * line's company; else 422 SUPPLIER_NOT_IN_COMPANY (another company's, a
 * deleted one, a system row, or none at all). The rule itself is
 * financePlanning/companyRefs.assertSupplierOfCompany (one definition, shared
 * with CapEx); this only adds the name that fills the line's `vendor`.
 */
async function supplierOfCompany(tenantId: string | null, supplierId: string): Promise<{ id: string; name: string }> {
  if (!tenantId) throw new AppError('SUPPLIER_NOT_IN_COMPANY', 'That vendor is not a supplier of this company — add it under Procurement → Suppliers first', 422)
  await assertSupplierOfCompany(tenantId, supplierId)
  return prisma.supplier.findUniqueOrThrow({ where: { id: supplierId }, select: { id: true, name: true } })
}

function vendorRequired(): AppError {
  return new AppError(
    'VENDOR_REQUIRED_FOR_WHT',
    'Withholding needs the vendor: pick the supplier on the line (its filer status and exemption certificate decide the rate)',
    422,
  )
}

/** The line with what the money rules read: its company, vendor and usual tax. */
const LINE_FOR_MONEY = {
  include: {
    category: { select: { id: true, tenantId: true, name: true } },
    supplier: { select: { id: true, name: true, filerStatus: true, whtExemptUntil: true, defaultWhtSection: true, defaultTaxAuthority: true, deletedAt: true } },
  },
} as const

type LineForMoney = {
  name: string
  whtSection: string | null
  inputTaxAuthority: string | null
  category: { tenantId: string | null }
  supplier: { filerStatus: string; whtExemptUntil: Date | null; defaultWhtSection: string | null; defaultTaxAuthority: string | null; deletedAt: Date | null } | null
}

/** What the payment body may say about the money; undefined = not said. */
interface PaymentMoneyInput {
  invoiceCents?: number
  actualCents?: number | null
  inputTaxCents?: number
  inputTaxAuthority?: AuthorityKey | null
  whtSection?: WhtSection | 'none' | null
  whtOverrideCents?: number | null
  whtOverrideReason?: string | null
}

/** A payment's stored money (for a PATCH). */
interface StoredMoney {
  actualCents: number | bigint | null
  whtCents: number | bigint
  inputTaxCents: number | bigint
  inputTaxAuthority: string | null
  whtSection: string | null
  whtRateBps: number | null
  filerStatus: string | null
  whtOverrideReason: string | null
  /** It was already paid before this edit: its cash and withholding are facts. */
  paidAt: Date | null
}

const MONEY_KEYS = ['invoiceCents', 'actualCents', 'inputTaxCents', 'inputTaxAuthority', 'whtSection', 'whtOverrideCents'] as const

/**
 * The columns of a PAID payment's money: the cash (actualCents), the
 * withholding with its snapshot, and the input tax with its authority.
 *
 *   invoice  = body.invoiceCents; else, when only the cash is sent
 *              (actualCents — the old form), the cash, which is refused (422
 *              INVOICE_AMOUNT_REQUIRED) when withholding would apply; else
 *              what the payment already holds (cash + WHT); else expected.
 *   section  = body.whtSection ('none' = none); else the payment's own
 *              snapshot once it has been worked out; else the line's; else the
 *              supplier's usual one. A section needs the line's vendor (422
 *              VENDOR_REQUIRED_FOR_WHT).
 *   WHT      = computeWithholding(base = invoice − input tax) at the paid date
 *              (the company switch, the vendor's filer status and exemption),
 *              or the stated override with its reason (422
 *              WHT_OVERRIDE_REASON_REQUIRED, never above the base).
 *   cash     = invoice − WHT.
 *   input tax needs its authority (body, else the payment's, else the
 *              line's usual one, else the supplier's — 422
 *              INPUT_TAX_AUTHORITY_REQUIRED) and must be below the invoice
 *              (422 INPUT_TAX_TOO_LARGE).
 *
 * An ALREADY-PAID payment's cash and withholding are facts (the vendor was
 * paid that cash; that WHT was withheld): an edit that restates none of the
 * withholding's inputs (invoiceCents, actualCents, inputTaxCents, whtSection,
 * whtOverrideCents) — a paid-date fix, the input-tax authority alone — keeps
 * the stored cash, WHT, section, rate, filer snapshot and override as they
 * are. When they are restated, a stated override is kept unless the body
 * clears it (whtOverrideCents: null), the vendor's filer status is the
 * payment's snapshot (not today's), and a row paid before withholding existed
 * (no snapshot) never has WHT invented after the fact unless a section is
 * sent.
 */
async function workOutPaymentMoney(a: {
  tenantId: string
  line: LineForMoney
  stored: StoredMoney | null
  body: PaymentMoneyInput
  expectedCents: number
  paidAt: Date
}): Promise<{
  data: {
    actualCents: number; whtCents: number; whtSection: string | null; whtRateBps: number | null; filerStatus: string
    whtOverrideReason: string | null; inputTaxCents: number; inputTaxAuthority: string | null
  }
  withholding: WithholdingResult
}> {
  const { body, stored, line } = a
  const supplier = line.supplier && !line.supplier.deletedAt ? line.supplier : null

  const inputTaxCents = body.inputTaxCents ?? (stored ? toCents(stored.inputTaxCents) : 0)
  let authority: string | null = body.inputTaxAuthority !== undefined ? body.inputTaxAuthority : (stored?.inputTaxAuthority ?? null)
  if (inputTaxCents > 0 && !isAuthorityKey(authority)) {
    authority = [line.inputTaxAuthority, supplier?.defaultTaxAuthority].find((x) => isAuthorityKey(x)) ?? null
    if (!authority) {
      throw new AppError('INPUT_TAX_AUTHORITY_REQUIRED', 'Say who charged the sales tax on this invoice (FBR or SRB) — input tax is set off only against that authority', 422)
    }
  }

  // Already paid, and nothing the withholding is worked out from restated:
  // the cash and the WHT stay exactly as paid (see the header).
  const paidBefore = !!stored?.paidAt && stored.actualCents != null
  const whtRestated = body.invoiceCents !== undefined || body.actualCents !== undefined || body.inputTaxCents !== undefined
    || body.whtSection !== undefined || body.whtOverrideCents !== undefined
  if (paidBefore && !whtRestated) {
    const whtCents = toCents(stored!.whtCents)
    const invoice = toCents(stored!.actualCents!) + whtCents
    if (inputTaxCents >= invoice && inputTaxCents > 0) {
      throw new AppError('INPUT_TAX_TOO_LARGE', 'The input sales tax must be less than the invoice amount', 422)
    }
    const section = whtSectionOrNull(stored!.whtSection)
    const filer = stored!.filerStatus ?? 'unknown'
    return {
      data: {
        actualCents: toCents(stored!.actualCents!), whtCents, whtSection: section, whtRateBps: stored!.whtRateBps,
        filerStatus: filer, whtOverrideReason: stored!.whtOverrideReason, inputTaxCents, inputTaxAuthority: authority,
      },
      withholding: { whtCents, rateBps: stored!.whtRateBps ?? 0, section, filerStatus: filer, exempt: filer === 'exempt', needsAtlCheck: false },
    }
  }
  // A row paid before withholding existed (no snapshot): never invent WHT after the fact.
  const legacyPaid = paidBefore && stored!.filerStatus == null

  const section: WhtSection | null = body.whtSection !== undefined
    ? whtSectionOrNull(body.whtSection)
    : legacyPaid
      ? null
      : stored?.filerStatus != null
        ? whtSectionOrNull(stored.whtSection)
        : (whtSectionOrNull(line.whtSection) ?? whtSectionOrNull(supplier?.defaultWhtSection))

  // A stated override stays stated until the body clears it (whtOverrideCents: null).
  const keptOverride = body.whtOverrideCents === undefined && stored?.whtOverrideReason != null
  const override = body.whtOverrideCents !== undefined ? body.whtOverrideCents : keptOverride ? toCents(stored!.whtCents) : null
  const reason = body.whtOverrideReason !== undefined ? (body.whtOverrideReason?.trim() || null) : keptOverride ? stored!.whtOverrideReason : null
  if (override != null && (reason?.length ?? 0) < 10) {
    throw new AppError('WHT_OVERRIDE_REASON_REQUIRED', 'Say why the withholding differs from the rate (at least 10 characters) — the CA reads it on the withholding register', 422)
  }
  if ((section || (override ?? 0) > 0) && !supplier) throw vendorRequired()

  // The invoice: stated; or the cash alone (the old form); or what is stored; or expected.
  const cashOnly = body.invoiceCents === undefined && body.actualCents != null ? body.actualCents : null
  let invoiceCents: number | null = body.invoiceCents
    ?? (cashOnly != null ? null : stored && stored.actualCents != null ? toCents(stored.actualCents) + toCents(stored.whtCents) : a.expectedCents)
  if (invoiceCents == null) {
    if (override != null) invoiceCents = cashOnly! + override
    else if (section && (await withholdingRatesFor(prisma, a.tenantId)).enabled) {
      throw new AppError(
        'INVOICE_AMOUNT_REQUIRED',
        'This vendor is withheld at source: give the invoice amount (what the vendor billed) — the cash paid is worked out from it',
        422,
      )
    } else invoiceCents = cashOnly!
  }
  assertMoneyFits(invoiceCents, 'The invoice amount')
  if (inputTaxCents >= invoiceCents) {
    throw new AppError('INPUT_TAX_TOO_LARGE', 'The input sales tax must be less than the invoice amount', 422)
  }
  const baseCents = invoiceCents - inputTaxCents
  const withholding = await computeWithholding(prisma, {
    tenantId: a.tenantId,
    supplier: supplier ? { filerStatus: supplier.filerStatus, whtExemptUntil: supplier.whtExemptUntil } : null,
    // An already-paid payment keeps the filer status it was paid under.
    ...(paidBefore && stored!.filerStatus ? { filerStatus: stored!.filerStatus } : {}),
    section,
    baseCents,
    at: a.paidAt,
  })
  let whtCents = withholding.whtCents
  if (override != null) {
    if (override > baseCents) {
      throw new AppError('WHT_OVERRIDE_TOO_LARGE', 'The withholding cannot be more than the invoice less its sales tax', 422)
    }
    whtCents = override
  }
  return {
    data: {
      actualCents: invoiceCents - whtCents,
      whtCents,
      whtSection: section,
      whtRateBps: section ? withholding.rateBps : null,
      filerStatus: withholding.filerStatus,
      whtOverrideReason: override != null ? reason : null,
      inputTaxCents,
      inputTaxAuthority: authority,
    },
    withholding,
  }
}

/** H25 / CapEx deposits: the treatment a payment asks for, and its coverage. */
function assertTreatment(treatment: string, coversFrom: string | null | undefined, coversMonths: number | null | undefined): void {
  if (treatment === 'deposit') {
    throw new AppError('DEPOSIT_USE_CAPEX', 'Record refundable deposits in CapEx with treatment deposit — a deposit is money we get back, never an expense', 422)
  }
  if (treatment === 'prepaid' && (!coversFrom || !coversMonths)) {
    throw new AppError('PREPAID_TERM_REQUIRED', 'A prepaid payment needs the months it covers: the first month (YYYY-MM) and how many months', 422)
  }
}

/**
 * Equipment goes on the register only through CapEx (owner, 2026-10-13): a
 * paid OpEx payment whose line name / notes read as equipment is refused (422
 * USE_CAPEX) unless finance or the CEO says it is not, with a reason.
 */
function equipmentGuard(
  line: { name: string },
  notes: string | null | undefined,
  body: { notEquipment?: boolean; notEquipmentReason?: string | null; expenseAccountCode?: string | null },
  role: string,
): { overridden: boolean; description: string } {
  const description = `${line.name}${notes ? ` — ${notes}` : ''}`
  const r = assertNotEquipmentLine({
    description, expenseAccountCode: body.expenseAccountCode ?? null,
    notEquipment: body.notEquipment, notEquipmentReason: body.notEquipmentReason ?? null,
  }, { role })
  return { overridden: r.overridden, description }
}

export async function opexRoutes(fastify: FastifyInstance) {

  // â”€â”€â”€ Categories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get<{ Querystring: { projectId?: string; scope?: string } }>('/categories',
    { preHandler: OPEX_GUARD },
    async (req) => {
      const { projectId, scope } = req.query
      // Filter lines by project: 'project' = lines with this projectId,
      // 'company' = lines with no projectId (cross-project), absent = both.
      const lineFilter: { isActive: boolean; projectId?: string | null } = { isActive: true }
      if (projectId && scope !== 'company') lineFilter.projectId = projectId
      else if (scope === 'company')          lineFilter.projectId = null

      const company = await scopeTenantWhere(req, 'read')
      const categories = await prisma.opexCategory.findMany({
        where: { deletedAt: null, isActive: true, ...company },
        include: {
          lines: {
            where: lineFilter,
            include: {
              payments: { orderBy: { periodStart: 'desc' }, take: 12 },
              supplier: { select: { id: true, name: true, filerStatus: true, whtExemptUntil: true, defaultWhtSection: true, defaultTaxAuthority: true } },
            },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      })

      // Hide categories that have no lines after filtering (only when filtering)
      const filtered = (projectId || scope) ? categories.filter((c) => c.lines.length > 0) : categories

      // The ledger state of every payment shown: the actual is what the
      // ledger holds (owner decision 23), so each paid row says whether its
      // entry is on the books.
      const tenantIds = (await resolveTenantScope(req)).tenantIds
      const paymentIds = filtered.flatMap((c) => c.lines.flatMap((l) => l.payments.map((p) => p.id)))
      const live = await liveRevisionsFor(tenantIds, OPEX_SOURCE, paymentIds)
      // Internal payment classification (2026-10-20) of each paid payment's entry — a reporting label.
      const classes = await classificationsOfReferences(prisma, tenantIds, paymentIds.map((id) => `${OPEX_SOURCE}:${id}`))

      return filtered.map((c) => {
        const monthlyExpected = c.lines.reduce((s, l) => s + monthlyCents(toCents(l.amountCents), l.cadence), 0)
        const budget = toCents(c.budgetMonthlyCents)
        const overBudgetPct = budget > 0 ? (monthlyExpected / budget) - 1 : 0
        const payroll = isPayrollCategory(c.name)
        return {
          ...c,
          // The name map's guess for a category with no account yet — what the
          // picker offers first. Never posted from until it is saved.
          suggestedExpenseAccountCode: payroll || c.expenseAccountCode ? null : expenseCodeForCategoryName(c.name),
          isPayroll: payroll,
          lines: c.lines.map((l) => ({
            ...l,
            payments: l.payments.map((p) => {
              const entry = live.get(p.id)
              const ledgerStatus = payroll || l.source === 'payroll' ? 'payroll'
                : !p.paidAt ? 'not_paid'
                : entry ? 'posted' : 'unposted'
              return {
                ...p,
                // cash + WHT = invoice; invoice − input tax = expense (what the budget compares).
                amounts: opexAmountsOf(p),
                ledger: {
                  status: ledgerStatus, entryId: entry?.entryId ?? null, amountCents: entry?.amountCents ?? null,
                  // Booked to (expense) and paid from (cash / bank chart code).
                  accountCode: entry?.debitCode ?? null, creditCode: entry?.creditCode ?? null,
                },
                classification: entry ? (classes.get(`${OPEX_SOURCE}:${p.id}`)?.classification ?? 'unclassified') : null,
              }
            }),
          })),
          monthlyExpectedCents: monthlyExpected,
          overBudgetPct,
          lineCount: c.lines.length,
        }
      })
    },
  )

  // A category's expense account (finance gaps 17d): the 6xxx account in its
  // company's chart its payments post to. Named on create or edit (checked
  // against THAT company's chart — 422 otherwise); left out on create, the
  // name map pre-fills it when the chart has the code. The payroll category
  // never has one (HR payroll books wages): naming one is 422.
  fastify.post('/categories', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const body = z.object({
      name:               z.string().min(1).max(80),
      emoji:              z.string().max(8).nullable().optional(),
      conceptId:          z.string().uuid().nullable().optional(),
      budgetMonthlyCents: zMoneyCents('The monthly budget').default(0),
      notes:              z.string().nullable().optional(),
      sortOrder:          z.number().int().optional(),
      expenseAccountCode: zExpenseCode,
    }).parse(req.body)
    if (body.conceptId) {
      const concept = await prisma.concept.findFirst({
        where: { id: body.conceptId, deletedAt: null, ...(await scopeTenantWhere(req, 'create')) },
      })
      if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    }
    // Bound to the ACTIVE company — a category with no company could never
    // post its payments to the books.
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
    let expenseAccountCode: string | null
    if (body.expenseAccountCode) {
      await assertCategoryAccount(tenantId, body.name, body.expenseAccountCode)
      expenseAccountCode = body.expenseAccountCode
    } else {
      // Explicit null = "not decided yet"; left out = the name map's suggestion.
      expenseAccountCode = body.expenseAccountCode === null ? null : await suggestedCategoryAccount(prisma, tenantId, body.name)
    }
    const cat = await prisma.opexCategory.create({ data: { ...body, expenseAccountCode, tenantId } })
    if (cat.expenseAccountCode) {
      await audit({
        category: 'accounting', action: 'opex.category.account', entity: 'OpexCategory', entityId: cat.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
        after: { name: cat.name, expenseAccountCode: cat.expenseAccountCode }, metadata: { suggested: !body.expenseAccountCode },
      })
    }
    return reply.status(201).send(cat)
  })

  fastify.patch<{ Params: { id: string } }>('/categories/:id', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const body = z.object({
      name:               z.string().min(1).max(80).optional(),
      emoji:              z.string().max(8).nullable().optional(),
      budgetMonthlyCents: zMoneyCents('The monthly budget').optional(),
      notes:              z.string().nullable().optional(),
      sortOrder:          z.number().int().optional(),
      isActive:           z.boolean().optional(),
      expenseAccountCode: zExpenseCode,
    }).parse(req.body)
    const owned = await prisma.opexCategory.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Category not found in your active company' } })
    const name = body.name ?? owned.name
    const data: typeof body = { ...body }
    if (body.expenseAccountCode) {
      // Checked against the CATEGORY's company's chart, never the operator's.
      if (!owned.tenantId) throw new AppError('CATEGORY_HAS_NO_COMPANY', 'This category is not bound to a company — recreate it under the company', 422)
      await assertCategoryAccount(owned.tenantId, name, body.expenseAccountCode)
    } else if (isPayrollCategory(name) && owned.expenseAccountCode) {
      // Renamed into the payroll category: HR payroll books it from now on.
      data.expenseAccountCode = null
    }
    const updated = await prisma.opexCategory.update({ where: { id: req.params.id }, data })
    if (updated.expenseAccountCode !== owned.expenseAccountCode) {
      await audit({
        category: 'accounting', action: 'opex.category.account', entity: 'OpexCategory', entityId: owned.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: owned.tenantId ?? req.staffUser!.tenantId,
        before: { name: owned.name, expenseAccountCode: owned.expenseAccountCode },
        after: { name: updated.name, expenseAccountCode: updated.expenseAccountCode },
        metadata: { companyId: owned.tenantId },
      })
    }
    return updated
  })

  fastify.delete<{ Params: { id: string } }>('/categories/:id', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const owned = await prisma.opexCategory.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Category not found in your active company' } })
    // To the Trash (modules/trash). A category that ever held lines keeps
    // their payments' history: never erased from the Trash.
    const lineCount = await prisma.opexLine.count({ where: { categoryId: owned.id } })
    await prisma.$transaction(async (tx) => {
      await moveToTrash(tx, req, {
        type: 'opex_category', entityId: owned.id, tenantId: owned.tenantId, conceptId: owned.conceptId,
        title: owned.name, subtitle: lineCount ? `${lineCount} line(s)` : null, reason: trashReasonOf(req),
        meta: { previous: { isActive: owned.isActive }, hadLines: lineCount > 0 },
      })
      await tx.opexCategory.update({
        where: { id: owned.id },
        data: { deletedAt: new Date(), isActive: false },
      })
    })
    return reply.status(204).send()
  })

  // â”€â”€â”€ Lines â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post('/lines', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const body = lineSchema.parse(req.body)
    // A new line binds to the ACTIVE company: its category must be one of the
    // active company's, and everything else it names must be that company's.
    const cat = await prisma.opexCategory.findFirst({
      where: { id: body.categoryId, deletedAt: null, ...(await scopeTenantWhere(req, 'create')) },
      select: { tenantId: true },
    })
    if (!cat) throw new AppError('CATEGORY_NOT_IN_COMPANY', 'That category does not belong to the active company', 422)
    assertMethodAndBank(body.paymentMethod, body.bankAccountId)
    await assertLineRefsOfCompany(cat.tenantId, body)
    // The vendor: a supplier of the CATEGORY's company; its name fills `vendor`.
    const supplier = body.supplierId ? await supplierOfCompany(cat.tenantId, body.supplierId) : null
    const whtSection = whtSectionOrNull(body.whtSection)
    if (whtSection && !supplier) throw vendorRequired()
    const line = await prisma.opexLine.create({
      data: {
        ...body,
        whtSection,
        ...(supplier && { vendor: supplier.name }),
        nextDueDate: body.nextDueDate ? new Date(body.nextDueDate) : null,
      },
    })
    return reply.status(201).send(line)
  })

  fastify.patch<{ Params: { id: string } }>('/lines/:id', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const body = lineSchema.partial().parse(req.body)
    const owned = await prisma.opexLine.findFirst({
      where: {
        id: req.params.id,
        category: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      },
      include: { category: { select: { tenantId: true } } },
    })
    if (!owned) throw new NotFoundError('OpexLine', req.params.id)
    // The line stays in its company: a new category must be the same
    // company's, and so must any brand / project / bank account being set.
    const tenantId = owned.category.tenantId
    if (body.categoryId !== undefined && body.categoryId !== owned.categoryId) {
      const cat = tenantId
        ? await prisma.opexCategory.findFirst({ where: { id: body.categoryId, tenantId, deletedAt: null }, select: { id: true } })
        : null
      if (!cat) throw new AppError('CATEGORY_NOT_IN_COMPANY', 'That category does not belong to this company', 422)
    }
    assertMethodAndBank(body.paymentMethod !== undefined ? body.paymentMethod : owned.paymentMethod, body.bankAccountId)
    await assertLineRefsOfCompany(tenantId, body)
    // The vendor stays a supplier of the line's company; a section needs one.
    const supplier = body.supplierId ? await supplierOfCompany(tenantId, body.supplierId) : null
    const whtSection = body.whtSection !== undefined ? whtSectionOrNull(body.whtSection) : undefined
    if (body.whtSection !== undefined || body.supplierId !== undefined) {
      const sectionAfter = whtSection !== undefined ? whtSection : whtSectionOrNull(owned.whtSection)
      const supplierAfter = body.supplierId !== undefined ? body.supplierId : owned.supplierId
      if (sectionAfter && !supplierAfter) throw vendorRequired()
    }
    // Switched to cash: the line no longer pays from a bank account.
    const clearBank = body.paymentMethod === 'cash' && body.bankAccountId === undefined && owned.bankAccountId != null
    return prisma.opexLine.update({
      where: { id: req.params.id },
      data: {
        ...body,
        ...(whtSection !== undefined && { whtSection }),
        ...(supplier && { vendor: supplier.name }),
        ...(clearBank && { bankAccountId: null }),
        nextDueDate: body.nextDueDate !== undefined ? (body.nextDueDate ? new Date(body.nextDueDate) : null) : undefined,
      },
    })
  })

  fastify.delete<{ Params: { id: string } }>('/lines/:id', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const owned = await prisma.opexLine.findFirst({
      where: {
        id: req.params.id,
        category: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      },
      include: { category: { select: { tenantId: true } } },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Line not found in your active company' } })
    // "Delete" switches the line off (its payments stay); the Trash keeps
    // what it was so Restore can switch it back on (modules/trash).
    await prisma.$transaction(async (tx) => {
      await moveToTrash(tx, req, {
        type: 'opex_line', entityId: owned.id, tenantId: owned.category.tenantId, conceptId: owned.conceptId,
        title: owned.name, subtitle: owned.vendor, parent: { type: 'opex_category', id: owned.categoryId },
        reason: trashReasonOf(req), meta: { previous: { isActive: owned.isActive } },
      })
      await tx.opexLine.update({ where: { id: owned.id }, data: { isActive: false } })
    })
    return reply.status(204).send()
  })

  // â”€â”€â”€ Payments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Marking a payment paid posts it to the books (owner decision 23) — in the
  // SAME transaction as the save, so a payment the ledger refuses (closed
  // month, unmapped category, bank account with no chart code) is not saved
  // as paid either. See opex/posting.ts.
  // The paid date, reference and receipt are the operator's (a bill paid on
  // 28 Sep but keyed on 2 Oct books on 28 Sep). `expenseAccountCode`,
  // `payFrom` and `bankAccountId` are instructions for THIS posting, not
  // columns of the payment: the expense code is remembered on an unmapped
  // category (opex/posting.ts); the bank lives on the line, and a payment paid
  // from somewhere else keeps that in its own journal entry (its live credit).
  const paymentBody = {
    actualCents:   zMoneyCents('The amount paid').nullable().optional(),
    paidAt:        zDateString.nullable().optional(),
    paymentRef:    z.string().max(120).nullable().optional(),
    receiptUrl:    z.string().url().max(2048).nullable().optional(),
    notes:         z.string().nullable().optional(),
    // The 6xxx account the payment is booked to (accounting/expenseCategories.ts).
    expenseAccountCode: z.string().regex(/^6\d{3}$/).nullable().optional(),
    // Where this payment's money came from, when not the line's own account.
    payFrom:       z.enum(['bank', 'cash']).optional(),
    bankAccountId: z.string().min(1).nullable().optional(),
    // Wave B (H8 / H28): what the vendor billed, its sales tax and who charged
    // it, and the withholding section (or 'none') / a stated override. The
    // server works out the WHT and the cash (actualCents = invoice − WHT).
    invoiceCents:      zMoneyCents('The invoice amount', { sign: 'positive' }).optional(),
    inputTaxCents:     zMoneyCents('The input sales tax').optional(),
    inputTaxAuthority: zAuthority,
    whtSection:        zWhtSection,
    whtOverrideCents:  zMoneyCents('The withholding').nullable().optional(),
    whtOverrideReason: z.string().trim().max(500).nullable().optional(),
    // H25: 'prepaid' = paid ahead for coversMonths from coversFrom (Dr 1310,
    // released monthly). 'deposit' is refused — refundable deposits are CapEx.
    treatment:     z.enum(['expense', 'prepaid', 'deposit']).optional(),
    coversFrom:    z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Give the first month as YYYY-MM').nullable().optional(),
    coversMonths:  z.number().int().min(1).max(120).nullable().optional(),
    // The equipment guard's override (finance / the CEO only, with a reason).
    notEquipment:       z.boolean().optional(),
    notEquipmentReason: z.string().trim().max(500).nullable().optional(),
  }

  /** An equipment override is audited and flagged in the payment's company (after the save). */
  async function flagEquipmentOverride(req: FastifyRequest, p: { id: string; tenantId: string | null }, description: string, reason: string | null | undefined) {
    await audit({
      category: 'accounting', action: 'opex.payment.not_equipment_override', entity: 'OpexPayment', entityId: p.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: p.tenantId ?? req.staffUser!.tenantId,
      after: { description, reason }, metadata: { companyId: p.tenantId },
    })
    await flagException({
      tenantId: p.tenantId,
      kind: 'equipment_override',
      severity: 'medium',
      title: `OpEx booked as an expense though it looks like equipment: ${description}`.slice(0, 200),
      description: `Finance / the CEO said this OpEx payment is not equipment: "${reason ?? ''}". Equipment belongs on the fixed-asset register through CapEx — check it.`,
      entityType: 'OpexPayment',
      entityId: p.id,
      actorId: req.staffUser!.id,
      metadata: { description, reason },
    })
  }

  fastify.post('/payments', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const body = z.object({
      lineId:        z.string().min(1),
      periodStart:   zDateString,
      periodEnd:     zDateString,
      expectedCents: zMoneyCents('The expected amount'),
      ...paymentBody,
    }).parse(req.body)
    const ownedLine = await prisma.opexLine.findFirst({
      where: {
        id: body.lineId,
        category: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      },
      ...LINE_FOR_MONEY,
    })
    // Another company's line is a row the caller cannot see: 404, nothing saved.
    if (!ownedLine) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Line not found in your companies' } })
    const {
      expenseAccountCode, payFrom, bankAccountId, notEquipment, notEquipmentReason,
      invoiceCents, inputTaxCents, inputTaxAuthority, whtSection, whtOverrideCents, whtOverrideReason, treatment: askedTreatment,
      ...data
    } = body
    if (payFrom === 'cash') assertMethodAndBank('cash', bankAccountId)
    const treatment = askedTreatment ?? 'expense'
    assertTreatment(treatment, data.coversFrom, data.coversMonths)
    const paidAt = data.paidAt ? new Date(data.paidAt) : null
    assertNotFuturePaid(paidAt)
    const tenantId = ownedLine.category.tenantId
    // The equipment guard, before anything is saved (only a paid payment books).
    const equipment = paidAt && !isPayrollCategory(ownedLine.category.name) && ownedLine.source !== 'payroll'
      ? equipmentGuard(ownedLine, data.notes, { notEquipment, notEquipmentReason, expenseAccountCode }, req.staffUser!.role)
      : null
    // Paid: the server works the money out (invoice → WHT → cash). Not paid
    // yet: a forecast — the tax fields are kept as given, nothing computed.
    // Payroll is HR's (never posted here, never withheld here).
    const payroll = isPayrollCategory(ownedLine.category.name) || ownedLine.source === 'payroll'
    const money = paidAt && tenantId && !payroll
      ? await workOutPaymentMoney({
        tenantId, line: ownedLine, stored: null, expectedCents: body.expectedCents, paidAt,
        body: { invoiceCents, actualCents: data.actualCents, inputTaxCents, inputTaxAuthority, whtSection, whtOverrideCents, whtOverrideReason },
      })
      : null
    const moneyData = money?.data ?? {
      actualCents: data.actualCents ?? null,
      ...(inputTaxCents !== undefined && { inputTaxCents }),
      ...(inputTaxAuthority !== undefined && { inputTaxAuthority }),
      ...(whtSection !== undefined && { whtSection: whtSectionOrNull(whtSection) }),
    }
    const { p, ledger } = await prisma.$transaction(classifyingTx(classificationOf(req.body), req.staffUser!.id, 'ledger.entryId', async (tx) => {
      const p = await tx.opexPayment.create({
        data: {
          ...data,
          ...moneyData,
          treatment,
          periodStart: new Date(data.periodStart),
          periodEnd:   new Date(data.periodEnd),
          paidAt,
        },
        include: { line: { include: { category: true } } },
      })
      const ledger = await syncOpexPaymentPosting(p.id, { tx, postedBy: req.staffUser!.id, expenseAccountCode, payFrom, bankAccountId })
      return { p, ledger }
    }))
    const amounts = opexAmountsOf(p)
    if (ledger.status === 'posted') {
      await audit({
        category: 'accounting', action: 'opex.payment.paid', entity: 'OpexPayment', entityId: p.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: p.line.category.tenantId ?? req.staffUser!.tenantId,
        after: { lineId: p.lineId, actualCents: p.actualCents, paidAt: p.paidAt, paymentRef: p.paymentRef, ...amounts, whtSection: p.whtSection, whtRateBps: p.whtRateBps, filerStatus: p.filerStatus, inputTaxAuthority: p.inputTaxAuthority, treatment: p.treatment, whtOverrideReason: p.whtOverrideReason },
        metadata: { entryId: ledger.entryId, companyId: p.line.category.tenantId, expenseAccountCode, payFrom, bankAccountId },
      })
    }
    if (equipment?.overridden) {
      await flagEquipmentOverride(req, { id: p.id, tenantId: p.line.category.tenantId }, equipment.description, notEquipmentReason)
    }

    // Variance flag: what the period COST (the expense — invoice less its
    // input tax; never the cash, which withholding lowers) significantly
    // above expected (vendor invoice jumped). > 15% over expected fires
    // `price_drift`. Catches inflated utility bills, surprise software price
    // hikes, etc.
    const spent = p.paidAt && p.actualCents != null ? amounts.expenseCents : null
    if (spent != null && body.expectedCents > 0) {
      const variancePct = (spent - body.expectedCents) / body.expectedCents
      if (variancePct > 0.15) {
        await flagException({
          tenantId: p.line.category.tenantId,
          kind: 'price_drift',
          severity: variancePct > 0.5 ? 'high' : 'medium',
          title: `OpEx jump: ${p.line.name} +${(variancePct * 100).toFixed(0)}%`,
          description: `Expected PKR ${(body.expectedCents / 100).toLocaleString()}, vendor charged PKR ${(spent / 100).toLocaleString()} (before sales tax) for ${new Date(body.periodStart).toLocaleDateString('en-GB')} to ${new Date(body.periodEnd).toLocaleDateString('en-GB')}. Either the rate changed (negotiate) or it's a billing error (dispute).`,
          entityType: 'OpexPayment',
          entityId: p.id,
          actorId: req.staffUser!.id,
          amountCents: spent - body.expectedCents,
          metadata: { lineId: body.lineId, lineName: p.line.name, expected: body.expectedCents, expense: spent, cash: amounts.cashCents, variancePct },
        })
      }
    }

    return reply.status(201).send({ ...p, amounts, needsAtlCheck: money?.withholding.needsAtlCheck ?? false, ledger })
  })

  // Correct a payment: amount, paid date, reference, receipt, period, the
  // expense account or where the money came from, the invoice / tax /
  // withholding / treatment — or un-mark it paid. The ledger follows in the
  // same transaction (opex/posting.ts): before it is on the books this simply
  // saves (and posts once it is paid); after, a change to the amounts, the
  // date or an account reverses the live entry and reposts
  // (opex.payment:<id>@n), a note / reference / receipt alone changes nothing
  // on the books, and un-marking it reverses it. A date in a closed month is
  // 422 PERIOD_LOCKED with nothing saved. The withholding is worked out again
  // only when the payment becomes paid or what it is worked out from is
  // restated (invoice, cash, input tax, section, override): a paid payment's
  // cash and WHT are facts — a paid-date fix or the input-tax authority alone
  // keeps them (workOutPaymentMoney).
  fastify.patch<{ Params: { id: string } }>('/payments/:id', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const body = z.object({
      ...paymentBody,
      periodStart: zDateString.optional(),
      periodEnd:   zDateString.optional(),
    }).parse(req.body)
    const owned = await prisma.opexPayment.findFirst({
      where: {
        id: req.params.id,
        line: { category: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
      },
      include: { line: LINE_FOR_MONEY },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found in your active company' } })
    const {
      expenseAccountCode, payFrom, bankAccountId, periodStart, periodEnd, notEquipment, notEquipmentReason,
      invoiceCents, inputTaxCents, inputTaxAuthority, whtSection, whtOverrideCents, whtOverrideReason, treatment: askedTreatment,
      ...data
    } = body
    if (payFrom === 'cash') assertMethodAndBank('cash', bankAccountId)
    const tenantId = owned.line.category.tenantId
    const treatment = askedTreatment ?? owned.treatment
    const coversFrom = data.coversFrom !== undefined ? data.coversFrom : owned.coversFrom
    const coversMonths = data.coversMonths !== undefined ? data.coversMonths : owned.coversMonths
    assertTreatment(treatment, coversFrom, coversMonths)
    // Released months follow the coverage they were worked out on: once a
    // prepaid payment is releasing, its treatment and coverage are fixed.
    if (owned.treatment === 'prepaid' && tenantId
      && (treatment !== owned.treatment || coversFrom !== owned.coversFrom || coversMonths !== owned.coversMonths)
      && await liveOpexReleases(prisma, tenantId, owned.id) > 0) {
      throw new AppError('PREPAID_RELEASING', 'This prepaid payment is already being released to expense month by month — its treatment and the months it covers can no longer change. Reverse the releases first.', 409)
    }
    const paidAt = data.paidAt !== undefined ? (data.paidAt ? new Date(data.paidAt) : null) : undefined
    assertNotFuturePaid(paidAt)
    const nowPaid = paidAt !== undefined ? paidAt : owned.paidAt
    const becomingPaid = !!nowPaid && !owned.paidAt
    const moneyGiven = MONEY_KEYS.some((k) => body[k] !== undefined)
    const dateMoved = !!nowPaid && paidAt !== undefined && owned.paidAt?.getTime() !== nowPaid.getTime()
    // Work the money out again only when it can have changed.
    const payroll = isPayrollCategory(owned.line.category.name) || owned.line.source === 'payroll'
    const recompute = !!nowPaid && !!tenantId && !payroll && (becomingPaid || moneyGiven || (dateMoved && owned.filerStatus != null))
    const equipment = nowPaid && !payroll && (becomingPaid || moneyGiven || data.notes !== undefined || treatment !== owned.treatment)
      ? equipmentGuard(owned.line, data.notes !== undefined ? data.notes : owned.notes, { notEquipment, notEquipmentReason, expenseAccountCode }, req.staffUser!.role)
      : null
    let moneyData: Record<string, unknown> = {}
    let needsAtlCheck = false
    if (recompute) {
      const money = await workOutPaymentMoney({
        tenantId: tenantId!, line: owned.line, expectedCents: toCents(owned.expectedCents), paidAt: nowPaid!,
        // Its amount so far (an old row's actualCents reads as the invoice — it carried no withholding).
        stored: owned,
        body: { invoiceCents, actualCents: data.actualCents, inputTaxCents, inputTaxAuthority, whtSection, whtOverrideCents, whtOverrideReason },
      })
      moneyData = money.data
      needsAtlCheck = money.withholding.needsAtlCheck
    } else {
      // Not paid (or nothing about the money changed): keep what was given.
      moneyData = {
        ...(data.actualCents !== undefined && { actualCents: data.actualCents }),
        ...(inputTaxCents !== undefined && { inputTaxCents }),
        ...(inputTaxAuthority !== undefined && { inputTaxAuthority }),
        ...(whtSection !== undefined && { whtSection: whtSectionOrNull(whtSection) }),
      }
    }
    const result = await prisma.$transaction(classifyingTx(classificationOf(req.body), req.staffUser!.id, 'ledger.entryId', async (tx) => {
      const updated = await tx.opexPayment.update({
        where: { id: owned.id },
        data: {
          ...data, paidAt, ...moneyData,
          ...(askedTreatment !== undefined && { treatment }),
          ...(periodStart !== undefined && { periodStart: new Date(periodStart) }),
          ...(periodEnd !== undefined && { periodEnd: new Date(periodEnd) }),
        },
      })
      const ledger = await syncOpexPaymentPosting(owned.id, { tx, postedBy: req.staffUser!.id, expenseAccountCode, payFrom, bankAccountId })
      return { ...updated, amounts: opexAmountsOf(updated), needsAtlCheck, ledger }
    }))
    await audit({
      category: 'accounting', action: 'opex.payment.correct', entity: 'OpexPayment', entityId: owned.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: owned.line.category.tenantId ?? req.staffUser!.tenantId,
      before: { actualCents: owned.actualCents, paidAt: owned.paidAt, paymentRef: owned.paymentRef, receiptUrl: owned.receiptUrl, periodStart: owned.periodStart, periodEnd: owned.periodEnd, ...opexAmountsOf(owned), whtSection: owned.whtSection, inputTaxAuthority: owned.inputTaxAuthority, treatment: owned.treatment, whtOverrideReason: owned.whtOverrideReason },
      after: { actualCents: result.actualCents, paidAt: result.paidAt, paymentRef: result.paymentRef, receiptUrl: result.receiptUrl, periodStart: result.periodStart, periodEnd: result.periodEnd, ...result.amounts, whtSection: result.whtSection, inputTaxAuthority: result.inputTaxAuthority, treatment: result.treatment, whtOverrideReason: result.whtOverrideReason },
      metadata: { ledger: result.ledger, expenseAccountCode, payFrom, bankAccountId, companyId: owned.line.category.tenantId },
    })
    if (equipment?.overridden) {
      await flagEquipmentOverride(req, { id: owned.id, tenantId: owned.line.category.tenantId }, equipment.description, notEquipmentReason)
    }
    return result
  })

  // GET /opex/wht-quote?lineId&invoiceCents&inputTaxCents&section — what the
  // server would withhold on this invoice today (lib/withholding.ts — the one
  // resolver): the page shows it and computes nothing. The line must be one
  // of the operator's companies' (404 otherwise); `section` 'none' = none,
  // left out = the line's (else its supplier's usual) section.
  fastify.get<{ Querystring: Record<string, string | undefined> }>('/wht-quote', { preHandler: OPEX_GUARD }, async (req) => {
    const q = z.object({
      lineId:        z.string().min(1),
      invoiceCents:  z.coerce.number().int().min(0),
      inputTaxCents: z.coerce.number().int().min(0).default(0),
      section:       z.enum([...WHT_SECTIONS, 'none']).optional(),
    }).parse(req.query)
    const line = await prisma.opexLine.findFirst({
      where: { id: q.lineId, category: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
      ...LINE_FOR_MONEY,
    })
    if (!line || !line.category.tenantId) throw new NotFoundError('OpexLine', q.lineId)
    assertMoneyFits(q.invoiceCents, 'The invoice amount')
    if (q.invoiceCents > 0 && q.inputTaxCents >= q.invoiceCents) {
      throw new AppError('INPUT_TAX_TOO_LARGE', 'The input sales tax must be less than the invoice amount', 422)
    }
    const supplier = line.supplier && !line.supplier.deletedAt ? line.supplier : null
    const section = q.section !== undefined
      ? whtSectionOrNull(q.section)
      : (whtSectionOrNull(line.whtSection) ?? whtSectionOrNull(supplier?.defaultWhtSection))
    if (section && !supplier) throw vendorRequired()
    const r = await computeWithholding(prisma, {
      tenantId: line.category.tenantId,
      supplier: supplier ? { filerStatus: supplier.filerStatus, whtExemptUntil: supplier.whtExemptUntil } : null,
      section,
      baseCents: Math.max(0, q.invoiceCents - q.inputTaxCents),
      at: new Date(),
    })
    return {
      whtCents: r.whtCents, rateBps: r.rateBps, section: r.section, filerStatus: r.filerStatus,
      exempt: r.exempt, needsAtlCheck: r.needsAtlCheck,
      cashCents: q.invoiceCents - r.whtCents,
      expenseCents: q.invoiceCents - q.inputTaxCents,
    }
  })

  // POST /opex/payments/post-unposted — put paid OpEx payments that predate
  // the posting rule on the books (admin; dry run by default). Payroll is
  // skipped (HR payroll books wages). Each payment is tried in its own
  // transaction; the dry run tries it too and rolls back, so the preview says
  // exactly what posting would do. Nothing is ever forced: a payment that
  // can't post is listed with WHY —
  //   needs_account  the category has no expense account (set it on the category)
  //   needs_bank     the company has several banks and the line names none, or
  //                  the line's bank is not a live, linked bank of the company
  //   needs_tax_details  input tax with no authority (or at / above the
  //                  invoice), or a prepaid payment with no months covered
  //   prepaid_releasing  a prepaid payment already being released
  //   period_locked  its paid date is in a closed month
  //   failed         anything else (code + reason in the row)
  fastify.post('/payments/post-unposted', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ dryRun: z.boolean().default(true) }).parse(req.body ?? {})
    const tenantIds = (await resolveTenantScope(req)).tenantIds
    const paid = await prisma.opexPayment.findMany({
      where: { paidAt: { not: null }, line: { category: { tenantId: { in: tenantIds }, deletedAt: null } } },
      select: {
        id: true, paidAt: true, actualCents: true,
        line: { select: { id: true, name: true, source: true, category: { select: { id: true, name: true, tenantId: true } } } },
      },
      orderBy: { paidAt: 'asc' },
    })
    const live = await liveRevisionsFor(tenantIds, OPEX_SOURCE, paid.map((p) => p.id))
    type Outcome = 'payroll' | 'already_posted' | 'would_post' | 'posted' | 'needs_account' | 'needs_bank' | 'needs_tax_details' | 'prepaid_releasing' | 'period_locked' | 'failed'
    const rows: Array<{
      paymentId: string; line: string; lineId: string; categoryId: string; category: string; tenantId: string | null
      paidAt: Date | null; amountCents: number | null; outcome: Outcome; code?: string; reason?: string
    }> = []
    class DryRun extends Error {}
    for (const p of paid) {
      const base = {
        paymentId: p.id, line: `${p.line.category.name} — ${p.line.name}`, lineId: p.line.id,
        categoryId: p.line.category.id, category: p.line.category.name, tenantId: p.line.category.tenantId,
        paidAt: p.paidAt, amountCents: p.actualCents == null ? null : toCents(p.actualCents),
      }
      if (isPayrollCategory(p.line.category.name) || p.line.source === 'payroll') { rows.push({ ...base, outcome: 'payroll' }); continue }
      if (live.has(p.id)) { rows.push({ ...base, outcome: 'already_posted' }); continue }
      try {
        await prisma.$transaction(async (tx) => {
          await syncOpexPaymentPosting(p.id, { tx, postedBy: req.staffUser!.id })
          if (body.dryRun) throw new DryRun()
        })
        rows.push({ ...base, outcome: 'posted' })
      } catch (err) {
        if (err instanceof DryRun) { rows.push({ ...base, outcome: 'would_post' }); continue }
        const code = err instanceof AppError ? err.code : 'INTERNAL'
        const outcome: Outcome =
          ['CATEGORY_NOT_MAPPED', 'ACCOUNT_NOT_FOUND', 'NOT_AN_EXPENSE_CODE', 'ACCOUNT_INACTIVE', 'ACCOUNT_CODE_TAKEN'].includes(code) ? 'needs_account'
          : ['BANK_ACCOUNT_REQUIRED', 'BANK_ACCOUNT_NOT_IN_COMPANY', 'BANK_ACCOUNT_NOT_LINKED', 'BANK_ACCOUNT_ON_CASH'].includes(code) ? 'needs_bank'
          // Wave B: input tax with no authority, input tax at or above the
          // invoice, a prepaid payment with no coverage — fix them on the payment.
          : ['INPUT_TAX_AUTHORITY_REQUIRED', 'INPUT_TAX_TOO_LARGE', 'BAD_TAX_AUTHORITY', 'PREPAID_TERM_REQUIRED', 'BAD_AMOUNT'].includes(code) ? 'needs_tax_details'
          : code === 'PREPAID_RELEASING' ? 'prepaid_releasing'
          : code === 'PERIOD_LOCKED' ? 'period_locked'
          : 'failed'
        rows.push({ ...base, outcome, code, reason: (err as Error).message })
      }
    }
    const counts: Partial<Record<Outcome, number>> = {}
    for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
    if (!body.dryRun && (counts.posted ?? 0) > 0) {
      // One audit row per company whose payments were posted, in that company.
      const byCompany = new Map<string | null, string[]>()
      for (const r of rows) if (r.outcome === 'posted') byCompany.set(r.tenantId ?? null, [...(byCompany.get(r.tenantId ?? null) ?? []), r.paymentId])
      for (const [companyId, posted] of byCompany) {
        await audit({
          category: 'accounting', action: 'opex.payments.post_unposted', entity: 'OpexPayment',
          userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: companyId ?? req.staffUser!.tenantId,
          metadata: { counts, posted },
        })
      }
    }
    return { dryRun: body.dryRun, counts, rows }
  })

  // GET /opex/actuals — what was actually spent, FROM THE LEDGER (decision
  // 23): the P&L's operating-expense accounts for the period, and per OpEx
  // category what its posted payments put on the books. The tracker's own
  // "paid" rows are only a view of these entries.
  fastify.get<{ Querystring: { dateFrom?: string; dateTo?: string } }>('/actuals', { preHandler: OPEX_GUARD }, async (req) => {
    const to = req.query.dateTo ? new Date(req.query.dateTo) : new Date()
    const from = req.query.dateFrom ? new Date(req.query.dateFrom) : new Date(to.getFullYear(), to.getMonth(), 1)
    const tenantIds = (await resolveTenantScope(req)).tenantIds
    const pl = await profitAndLoss(tenantIds, from, to)
    const payments = await prisma.opexPayment.findMany({
      where: { paidAt: { gte: from, lte: to }, line: { category: { tenantId: { in: tenantIds } } } },
      select: {
        id: true, actualCents: true, whtCents: true, inputTaxCents: true, treatment: true,
        line: { select: { category: { select: { id: true, name: true, budgetMonthlyCents: true } } } },
      },
    })
    const live = await liveRevisionsFor(tenantIds, OPEX_SOURCE, payments.map((p) => p.id))
    // Per category, what its posted payments COST (the expense: invoice less
    // its input tax — never the cash, which withholding lowers, nor the entry's
    // debit total, which carries the input tax). Prepaid payments count when
    // paid; their monthly releases are the P&L's.
    const byCategory = new Map<string, {
      categoryId: string; name: string; budgetMonthlyCents: number
      postedCents: number; cashCents: number; whtCents: number; inputTaxCents: number; prepaidCents: number; unpostedCount: number
    }>()
    for (const p of payments) {
      const c = p.line.category
      const row = byCategory.get(c.id) ?? { categoryId: c.id, name: c.name, budgetMonthlyCents: toCents(c.budgetMonthlyCents), postedCents: 0, cashCents: 0, whtCents: 0, inputTaxCents: 0, prepaidCents: 0, unpostedCount: 0 }
      const e = live.get(p.id)
      if (e) {
        const a = opexAmountsOf(p)
        row.postedCents += a.expenseCents
        row.cashCents += a.cashCents
        row.whtCents += a.whtCents
        row.inputTaxCents += a.inputTaxCents
        if (p.treatment === 'prepaid') row.prepaidCents += a.expenseCents
      } else if (!isPayrollCategory(c.name)) row.unpostedCount += 1
      byCategory.set(c.id, row)
    }
    return {
      dateFrom: pl.dateFrom,
      dateTo: pl.dateTo,
      source: 'ledger' as const,
      opexByAccount: pl.opex,
      totalOpexCents: pl.totals.opexCents,
      byCategory: Array.from(byCategory.values()).sort((a, b) => b.postedCents - a.postedCents),
    }
  })

  // â”€â”€â”€ Live data: payroll snapshot for the Payroll category â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get('/payroll-snapshot', { preHandler: OPEX_GUARD }, async (req) => {
    // Last 6 months of HR payroll runs for the companies in view; the UI
    // renders them as a "live" line under the Payroll category instead of
    // manual entry.
    const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    const tenantIds = (await resolveTenantScope(req)).tenantIds
    const hrRuns = await prisma.hrPayrollRun.findMany({
      where: { tenantId: { in: tenantIds }, period: { gte: sixMonthsAgo.toISOString().slice(0, 7) } },
      orderBy: { period: 'desc' },
      include: { _count: { select: { payslips: true } } },
      take: 12,
    })
    const runs = hrRuns.map((r) => {
      const [y, m] = r.period.split('-').map(Number) as [number, number]
      const totals = (r.totals ?? {}) as { earningsCents?: number }
      return { id: r.id, periodStart: new Date(Date.UTC(y, m - 1, 1)), periodEnd: new Date(Date.UTC(y, m, 0)), status: r.status, totalGrossCents: totals.earningsCents ?? 0, lineCount: r._count.payslips }
    })

    // Also project this month — sum unposted clock logs × wage rates
    const monthStart = new Date()
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
    const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1)

    // The budgeted payroll: THE labour rule (projections/labour.ts, owner
    // decision 25) — open and filled seats at each company's cost share,
    // frozen seats excluded, contributions and head-office charges netted — summed
    // over the companies in view. The Projections labour line is the same
    // figure. Edits in workforce/positions show on the next refresh.
    const labours = await Promise.all(tenantIds.map((t) => monthlyLabourCents(t)))
    const budgetedMonthly      = labours.reduce((s, l) => s + l.seatsCents, 0)
    const budgetedGrossMonthly = labours.reduce((s, l) => s + l.grossSalaryCents, 0)
    const headcountTotal       = labours.reduce((s, l) => s + l.headcount, 0)
    const openSeats            = labours.reduce((s, l) => s + l.openSeats, 0)
    const companyLevelSeatsMonthly = labours.reduce((s, l) => s + l.companyLevelSeatsCents, 0)
    // Contributions between two companies BOTH in view cancel out. Only the
    // contributions planning counts (lib/labour-budget.ts countedContributions:
    // after the head-office setup a linked head_office row no longer counts).
    let incomingMonthly = labours.reduce((s, l) => s + l.incomingContributionCents, 0)
    let outgoingMonthly = labours.reduce((s, l) => s + l.outgoingContributionCents, 0)
    if (tenantIds.length > 1) {
      const internalRows = await prisma.tenantContribution.findMany({
        where: { isActive: true, sourceTenantId: { in: tenantIds }, destinationTenantId: { in: tenantIds } },
        select: { sourceTenantId: true, destinationTenantId: true, category: true, monthlyCents: true },
      })
      const internal = (await countedContributions(internalRows, await headOfficeSetupApplied()))
        .reduce((s, c) => s + c.monthlyCents, 0)
      incomingMonthly -= internal
      outgoingMonthly -= internal
    }
    // Head office charges (plan) for the companies in view — the one helper
    // (headOfficePlanCharges); a head office and a company both in view cancel.
    // Empty until the head-office setup wizard has run.
    const hoPlan = await headOfficePlanCharges(tenantIds)
    const netMonthly = budgetedMonthly + outgoingMonthly - incomingMonthly + hoPlan.chargesMonthlyCents - hoPlan.rechargedOutMonthlyCents

    return {
      runs,
      currentMonth: { start: monthStart, end: monthEnd },
      // Live position-based budget. UI surfaces this above the run history
      // so the operator sees what they're COMMITTED to before they see
      // what's already been paid out.
      budget: {
        monthlyCents:       budgetedMonthly,
        grossMonthlyCents:  budgetedGrossMonthly,
        headcount:          headcountTotal,
        openSeats,
        // Inter-tenant contributions shown as separate lines under the
        // Payroll category. netMonthlyCents = what hits this tenant's P&L
        // after chargebacks.
        incomingContributionMonthlyCents: incomingMonthly,
        outgoingContributionMonthlyCents: outgoingMonthly,
        // D1 (after the setup wizard): "Company-level seats" and "Head office
        // charges (plan)" lines; a head office in view shows what it recharges.
        companyLevelSeatsMonthlyCents:    companyLevelSeatsMonthly,
        headOfficeChargesMonthlyCents:    hoPlan.chargesMonthlyCents,
        headOfficeCharges:                hoPlan.charges,
        rechargedOutMonthlyCents:         hoPlan.rechargedOutMonthlyCents,
        labels:                           PLAN_LABELS,
        netMonthlyCents:                  netMonthly,
      },
    }
  })

  // â”€â”€â”€ Cash-flow forecast (next 90 days) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get('/cashflow', { preHandler: OPEX_GUARD }, async (req) => {
    const { from, to } = cashflowWindow()

    const lines = await prisma.opexLine.findMany({
      where: {
        isActive: true,
        nextDueDate: { gte: from, lte: to },
        // Company scoping via the line's category tenant — matches every other
        // opex read in this module.
        category: await scopeTenantWhere(req, 'read'),
      },
      include: { category: { select: { name: true, emoji: true } } },
      orderBy: { nextDueDate: 'asc' },
    })

    return lines.map((l) => ({
      id: l.id,
      name: l.name,
      categoryName: l.category.name,
      categoryEmoji: l.category.emoji,
      dueDate: l.nextDueDate,
      amountCents: l.amountCents,
      vendor: l.vendor,
    }))
  })
}

/** The cash-flow window: today (Karachi) and the next 90 days. nextDueDate is
 *  stored as UTC midnight of its day, so "today" is UTC midnight of Karachi's
 *  date — a line due today stays in all day, not only until 05:00 PKT. */
export function cashflowWindow(now: Date = new Date()): { from: Date; to: Date } {
  const from = new Date(`${fmtPktDate(now)}T00:00:00Z`)
  return { from, to: new Date(from.getTime() + 90 * 86_400_000) }
}

// Cadence â†’ equivalent monthly cents for budget comparison.
function monthlyCents(amountCents: number, cadence: string): number {
  switch (cadence) {
    case 'quarterly': return Math.round(amountCents / 3)
    case 'annual':    return Math.round(amountCents / 12)
    case 'per_use':   return amountCents      // not strictly monthly; show as-is
    case 'monthly':
    default:          return amountCents
  }
}
