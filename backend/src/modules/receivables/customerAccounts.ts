// /accounting/customer-accounts — on-account (corporate) clients: the client
// record, the CEO's approval, QR cards, the charges list, the tie-out and
// overdue reminders (on-account clients resumed, 2026-10-15). Statements are
// registered here as a child plugin (statements.ts owns them).
//
// Gate: module 'accounting' through the existing '/accounting' GATED_PREFIXES
// rule. Roles: CLIENT_VIEWERS read, CLIENT_EDITORS write (receivables/
// onAccount.ts — admin, owner, management, finance; fnb_manager is NOT one,
// although it views financials: client NTNs, CNICs and limits stay with
// finance).
//
//   GET    /                       ?status&pending=1&overdue=1&q — rows with
//                                  exposure / available / overdue / unbilled /
//                                  cardsActive (exposureOfTx)
//   GET    /tie-out                1110 vs the client ledgers, per company in
//                                  scope (accounting/tillClearing.ts tieOutOf)
//   GET    /:id                    the client, its cards (hint only), unbilled
//                                  charges (booked / not yet), its statements
//                                  and invoices with balances, write-offs
//   GET    /:id/charges            ?from&to (Karachi days) &unbilled=1
//   POST   /                       a new client in the ACTIVE company —
//                                  'pending' until the CEO approves (a client
//                                  the CEO creates is active at once, once the
//                                  company's till clearing is split off 1110)
//   PATCH  /:id                    details; a limit INCREASE waits for the CEO
//                                  (the CEO's own applies at once), a decrease
//                                  applies at once; suspend (reason), reactivate
//                                  (CEO only), close (nothing owed), resubmit a
//                                  rejected application ('pending')
//   POST   /:id/approve | reject   the CEO (ADMIN_ONLY): a new client or a
//                                  limit increase. 409 NOTHING_PENDING; approve
//                                  is 409 TILL_CLEARING_NOT_SPLIT until the
//                                  company is cut over to 1115
//   POST   /:id/cards              {label} → {card, code}: the code is shown
//                                  ONCE (only its sha256 and last 4 are kept)
//   POST   /:id/cards/:cardId/rotate   revoke ('rotated') + a new code, once
//   POST   /:id/cards/:cardId/revoke   {reason}
//   POST   /:id/remind             an overdue reminder email, once per Karachi
//                                  day (409 REMINDED_TODAY); 422 NO_EMAIL. A
//                                  test company and the practice copy send
//                                  nothing (lib/mailer.ts sendEmail).
//
// Nothing here posts to the ledger. Every write is audited
// ('on_account.client.*', 'on_account.card.*') in the CLIENT's company. A card
// code never reaches the audit trail, a log line or an error message — only
// its hint.
//
// Lock order (receivables/onAccount.ts): order → client account → invoice.

import { auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { CustomerAccount, CustomerAccountCard, Prisma } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, activeTenantId, resolveTenantScope, type ScopeMode } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { toCents, zMoneyCents } from '../../lib/money.js'
import { assertNotSelfApproval } from '../../lib/separation-of-duties.js'
import { newCardCode } from '../../lib/onAccountCard.js'
import { sendEmail } from '../../lib/mailer.js'
import { customerScope } from '../../lib/outboundScope.js'
import { isTestTenant } from '../../lib/testCompany.js'
import { isSandbox } from '../../lib/sandbox.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { karachiDay, karachiDayStart } from '../../connectors/util.js'
import { parsePktStartOfDay, parsePktEndOfDay } from '../accounting/dates.js'
import { tillClearingCutoverAt } from '../accounting/tillClearingCode.js'
import { tieOutOf } from '../accounting/tillClearing.js'
import { LIVE_KINDS, balanceOf, totalOf } from './ledger.js'
import {
  CLIENT_EDITORS, CLIENT_VIEWERS, ON_ACCOUNT_ERRORS, chargeNetCents, exposureOfTx, isChargeBookedTx, lockAccountTx,
  type Exposure,
} from './onAccount.js'
import { statementRoutes } from './statements.js'
import { cityLedgerBackOfficeRoutes } from './cityLedgerRoutes.js'
import { chargeOwedCents } from './cityLedger.js'
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABEL, type AccountType } from './cityLedger.js'

type Tx = Prisma.TransactionClient

export const CLIENT_STATUSES = ['pending', 'active', 'suspended', 'closed'] as const
export type ClientStatus = (typeof CLIENT_STATUSES)[number]

const isAdmin = (req: FastifyRequest) => req.staffUser?.role === 'admin'
const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK')}`
const actorOf = (req: FastifyRequest) => ({ userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null })
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

/** '' / whitespace → null; undefined stays undefined (field not sent). */
const optText = (max: number) =>
  z.string().trim().max(max).nullish().transform((v) => (v === undefined ? undefined : v ? v : null))

const ClientFields = {
  legalName: z.string().trim().min(2).max(200),
  tradeName: optText(200),
  ntn: optText(30),
  strn: optText(30),
  cnic: optText(30),
  address: optText(500),
  contactName: optText(120),
  contactPhone: optText(40),
  contactEmail: z.string().trim().max(200).nullish()
    .transform((v) => (v === undefined ? undefined : v ? v : null))
    .refine((v) => v == null || z.string().email().safeParse(v).success, 'Not an email address'),
  creditLimitCents: zMoneyCents('Credit limit', { sign: 'positive' }),
  // 0 = immediate (City Ledger payment terms, 2026-10-24); 7 / 15 / 30 or any number of days up to 180.
  termsDays: z.number().int().min(0).max(180),
  accountType: z.enum(ACCOUNT_TYPES),
  overdueGraceDays: z.number().int().min(0).max(90),
  requiresReference: z.boolean(),
  conceptIds: z.array(z.string().min(1).max(64)).max(100),
  notes: optText(2000),
}

const CreateBody = z.object({
  ...ClientFields,
  accountType: ClientFields.accountType.default('company'),
  /** The account code — typed by the person (unique per company), or OA-0001… when left empty. */
  number: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Use 2–20 letters, numbers or dashes')
    // OA-<digits> is the automatic series — a typed one could break its numbering.
    .refine((v) => !/^OA-[0-9]+$/.test(v), 'OA-<number> codes are given automatically — leave the code empty or choose another').optional(),
  termsDays: ClientFields.termsDays.default(30),
  overdueGraceDays: ClientFields.overdueGraceDays.default(7),
  requiresReference: ClientFields.requiresReference.default(false),
  conceptIds: ClientFields.conceptIds.default([]),
})

const PatchBody = z.object({
  legalName: ClientFields.legalName.optional(),
  tradeName: ClientFields.tradeName,
  ntn: ClientFields.ntn,
  strn: ClientFields.strn,
  cnic: ClientFields.cnic,
  address: ClientFields.address,
  contactName: ClientFields.contactName,
  contactPhone: ClientFields.contactPhone,
  contactEmail: ClientFields.contactEmail,
  creditLimitCents: ClientFields.creditLimitCents.optional(),
  termsDays: ClientFields.termsDays.optional(),
  accountType: ClientFields.accountType.optional(),
  overdueGraceDays: ClientFields.overdueGraceDays.optional(),
  requiresReference: ClientFields.requiresReference.optional(),
  conceptIds: ClientFields.conceptIds.optional(),
  notes: ClientFields.notes,
  status: z.enum(CLIENT_STATUSES).optional(),
  /** Why — required to suspend; kept as statusReason. */
  reason: z.string().trim().max(500).optional(),
})

/**
 * The CEO's decision applies what the CEO saw, never a later edit: the inbox
 * (and the client page) send the row's `updatedAt` and the limit shown, and
 * the approval is refused (409 REQUEST_CHANGED) when either moved since.
 */
const ApproveBody = z.object({
  note: z.string().trim().max(500).optional(),
  expectedUpdatedAt: z.string().datetime().optional(),
  creditLimitCents: zMoneyCents('Credit limit', { sign: 'positive' }).optional(),
}).default({})
const RejectBody = z.object({ note: z.string().trim().min(3, 'Say why').max(500) })
const CardBody = z.object({ label: z.string().trim().min(1).max(60) })
const RevokeBody = z.object({ reason: z.string().trim().min(3, 'Say why').max(200) })

// ─── Errors ──────────────────────────────────────────────────────────────────

const nameTaken = () => new AppError('CLIENT_NAME_TAKEN', 'This company already has a client with that legal name', 409)
const brandNotInCompany = () =>
  new AppError('BRAND_NOT_IN_COMPANY', "A client may only be billed at its own company's brands", 422)
const clientClosed = () => new AppError('CLIENT_CLOSED', 'This client is closed', 409)
const tillClearingNotSplit = () =>
  new AppError('TILL_CLEARING_NOT_SPLIT', ON_ACCOUNT_ERRORS.TILL_CLEARING_NOT_SPLIT, 409)

const isP2002 = (err: unknown) => (err as { code?: string })?.code === 'P2002'

// ─── Reads ───────────────────────────────────────────────────────────────────

/** The client, or 404 — never another company's (nor one outside `mode`'s scope). */
async function findAccount(req: FastifyRequest, id: string, mode: ScopeMode): Promise<CustomerAccount> {
  const a = await prisma.customerAccount.findFirst({ where: { id, ...(await scopeTenantWhere(req, mode)) } })
  if (!a) throw new NotFoundError('CustomerAccount', id)
  return a
}

/** A card as every route returns it — the hint, never the hash. */
function cardView(c: CustomerAccountCard) {
  return {
    id: c.id, accountId: c.accountId, label: c.label, hint: c.tokenHint,
    issuedById: c.issuedById, issuedAt: c.issuedAt,
    revokedAt: c.revokedAt, revokedById: c.revokedById, revokedReason: c.revokedReason,
    lastUsedAt: c.lastUsedAt, active: c.revokedAt === null,
  }
}

/** What is waiting for the CEO on this client, if anything. */
function pendingOf(a: CustomerAccount): 'new_client' | 'limit_increase' | null {
  if (a.status === 'pending') return 'new_client'
  if (a.requestedCreditLimitCents != null && a.status !== 'closed') return 'limit_increase'
  return null
}

interface Caller { id: string; role: string }

/** Rows as the list (and the approvals inbox) reads them. */
async function shapeRows(accounts: CustomerAccount[], me: Caller, now = new Date()) {
  if (accounts.length === 0) return []
  const ids = accounts.map((a) => a.id)
  const tenantIds = [...new Set(accounts.map((a) => a.tenantId))]
  const userIds = [...new Set(accounts.flatMap((a) => [a.createdById, a.limitRequestedById, a.approvedById]).filter((x): x is string => !!x))]
  const conceptIds = [...new Set(accounts.flatMap((a) => a.conceptIds))]
  const [cards, users, concepts, tenants, cutovers, exposures] = await Promise.all([
    prisma.customerAccountCard.groupBy({ by: ['accountId'], where: { accountId: { in: ids }, revokedAt: null }, _count: { _all: true } }),
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
    conceptIds.length ? prisma.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, name: true, tenantId: true } }) : [],
    prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }),
    Promise.all(tenantIds.map(async (t) => [t, await tillClearingCutoverAt(prisma, t)] as const)),
    Promise.all(accounts.map(async (a) => [a.id, await exposureOfTx(prisma, a.id, now)] as const)),
  ])
  const cardsOf = new Map(cards.map((c) => [c.accountId, c._count._all]))
  const nameOf = new Map(users.map((u) => [u.id, u.name ?? u.email ?? null]))
  const conceptOf = new Map(concepts.map((c) => [c.id, c]))
  const companyOf = new Map(tenants.map((t) => [t.id, t.name]))
  const cutOver = new Map(cutovers)
  const exposureOf = new Map(exposures)
  return accounts.map((a) => {
    const exposure = exposureOf.get(a.id) as Exposure
    const limitCents = toCents(a.creditLimitCents)
    const requested = a.requestedCreditLimitCents == null ? null : toCents(a.requestedCreditLimitCents)
    const pending = pendingOf(a)
    const decide = pending !== null && me.role === 'admin'
    const approveBlockedReason = pending && !cutOver.get(a.tenantId) ? ON_ACCOUNT_ERRORS.TILL_CLEARING_NOT_SPLIT : null
    const requesterId = pending === 'new_client' ? a.createdById : pending === 'limit_increase' ? a.limitRequestedById : null
    return {
      id: a.id,
      tenantId: a.tenantId,
      companyName: companyOf.get(a.tenantId) ?? null,
      number: a.number,
      legalName: a.legalName,
      tradeName: a.tradeName,
      ntn: a.ntn,
      strn: a.strn,
      cnic: a.cnic,
      address: a.address,
      contactName: a.contactName,
      contactPhone: a.contactPhone,
      contactEmail: a.contactEmail,
      status: a.status,
      statusReason: a.statusReason,
      creditLimitCents: limitCents,
      requestedCreditLimitCents: requested,
      limitRequestedById: a.limitRequestedById,
      limitRequestedByName: a.limitRequestedById ? nameOf.get(a.limitRequestedById) ?? null : null,
      limitRequestedAt: a.limitRequestedAt,
      termsDays: a.termsDays,
      overdueGraceDays: a.overdueGraceDays,
      accountType: a.accountType,
      accountTypeLabel: ACCOUNT_TYPE_LABEL[a.accountType as AccountType] ?? a.accountType,
      /** The receivable account the client's bills sit on: the company's 1110 Customer receivable (one AR control account). */
      receivableAccountCode: '1110',
      requiresReference: a.requiresReference,
      conceptIds: a.conceptIds,
      brands: a.conceptIds.map((id) => ({ id, name: conceptOf.get(id)?.name ?? null })),
      notes: a.notes,
      createdById: a.createdById,
      createdByName: nameOf.get(a.createdById) ?? null,
      createdAt: a.createdAt,
      approvedById: a.approvedById,
      approvedByName: a.approvedById ? nameOf.get(a.approvedById) ?? null : null,
      approvedAt: a.approvedAt,
      lastRemindedAt: a.lastRemindedAt,
      /** Echo back as `expectedUpdatedAt` on approve — a later edit refuses the approval. */
      updatedAt: a.updatedAt,
      // Exposure (what the client owes now) and the room left under the limit.
      unbilledCents: exposure.unbilledCents,
      invoicesDueCents: exposure.invoicesDueCents,
      exposureCents: exposure.exposureCents,
      /** Money owed back to the client (shown as "In credit"; blocks closing). */
      creditCents: exposure.creditCents,
      availableCents: a.status === 'active' ? Math.max(0, limitCents - exposure.exposureCents) : 0,
      overdue: exposure.overdue,
      cardsActive: cardsOf.get(a.id) ?? 0,
      // What waits for the CEO, and who asked (never their approver).
      pending,
      pendingSince: pending === 'new_client' ? a.createdAt : pending === 'limit_increase' ? a.limitRequestedAt : null,
      requestedById: requesterId,
      requestedByName: requesterId ? nameOf.get(requesterId) ?? null : null,
      tillClearingSplit: !!cutOver.get(a.tenantId),
      approveBlockedReason,
      canApprove: decide && !approveBlockedReason,
      canReject: decide,
    }
  })
}

/**
 * Who a client's email answers to: the client's own brand's email when it is
 * billed at one brand, else the company's first brand with an email. Null
 * when the company has none (the platform sender's address then).
 */
export async function companyReplyTo(tenantId: string, conceptIds: readonly string[] = []): Promise<string | null> {
  const brands = await prisma.concept.findMany({
    where: { tenantId, deletedAt: null, email: { not: null } },
    select: { id: true, email: true },
    orderBy: { createdAt: 'asc' },
  })
  const own = conceptIds.length === 1 ? brands.find((b) => b.id === conceptIds[0]) : undefined
  return (own ?? brands[0])?.email?.trim() || null
}

/** The brand ids, each a live brand of `tenantId` — else 422 BRAND_NOT_IN_COMPANY. */
async function brandsOfCompany(tenantId: string, conceptIds: readonly string[]): Promise<string[]> {
  const want = [...new Set(conceptIds)]
  if (want.length === 0) return []
  const found = await prisma.concept.findMany({ where: { id: { in: want }, tenantId, deletedAt: null }, select: { id: true } })
  if (found.length !== want.length) throw brandNotInCompany()
  return want
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// ─── Plugin ──────────────────────────────────────────────────────────────────

export async function customerAccountRoutes(app: FastifyInstance): Promise<void> {
  const viewers = { preHandler: requireAuth(...CLIENT_VIEWERS) }
  const editors = { preHandler: requireAuth(...CLIENT_EDITORS) }
  const ceo = { preHandler: requireAuth(...ADMIN_ONLY) }
  const callerOf = (req: FastifyRequest): Caller => ({ id: req.staffUser!.id, role: req.staffUser!.role })
  const reload = async (id: string, req: FastifyRequest) =>
    (await shapeRows([await prisma.customerAccount.findUniqueOrThrow({ where: { id } })], callerOf(req)))[0]!

  // Statements (statements.ts) live under the same prefix.
  await app.register(statementRoutes)
  // City Ledger: per-bill settlement, bills, history (cityLedgerRoutes.ts).
  await app.register(cityLedgerBackOfficeRoutes)

  // ── List ──
  app.get<{ Querystring: { status?: string; pending?: string; overdue?: string; q?: string } }>('/', viewers, async (req) => {
    const qs = z.object({
      status: z.enum(CLIENT_STATUSES).optional(),
      pending: z.enum(['0', '1', 'true', 'false']).optional(),
      overdue: z.enum(['0', '1', 'true', 'false']).optional(),
      q: z.string().trim().max(100).optional(),
    }).parse(req.query)
    const yes = (v?: string) => v === '1' || v === 'true'
    const where: Prisma.CustomerAccountWhereInput = {
      ...(await scopeTenantWhere(req, 'read')),
      ...(qs.status ? { status: qs.status } : {}),
      ...(yes(qs.pending) ? { OR: [{ status: 'pending' }, { requestedCreditLimitCents: { not: null }, status: { not: 'closed' } }] } : {}),
      ...(qs.q
        ? {
            AND: [{
              OR: [
                { legalName: { contains: qs.q, mode: 'insensitive' } },
                { tradeName: { contains: qs.q, mode: 'insensitive' } },
                { number: { contains: qs.q, mode: 'insensitive' } },
                { ntn: { contains: qs.q, mode: 'insensitive' } },
              ],
            }],
          }
        : {}),
    }
    const accounts = await prisma.customerAccount.findMany({ where, orderBy: [{ tenantId: 'asc' }, { number: 'asc' }], take: 500 })
    let items = await shapeRows(accounts, callerOf(req))
    if (yes(qs.overdue)) items = items.filter((r) => r.overdue !== null)
    return { items }
  })

  // ── Tie-out: 1110 against the client ledgers, per company in scope ──
  app.get('/tie-out', viewers, async (req) => {
    const scope = await resolveTenantScope(req)
    const tenants = scope.tenantIds.length
      ? await prisma.tenant.findMany({ where: { id: { in: scope.tenantIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
      : []
    const companies = []
    for (const t of tenants) companies.push({ tenantId: t.id, companyName: t.name, ...(await tieOutOf(t.id)) })
    return { companies }
  })

  // ── One client ──
  app.get<{ Params: { id: string } }>('/:id', viewers, async (req) => {
    const a = await findAccount(req, req.params.id, 'read')
    const [row] = await shapeRows([a], callerOf(req))
    const [cards, unbilled, bills] = await Promise.all([
      prisma.customerAccountCard.findMany({ where: { tenantId: a.tenantId, accountId: a.id }, orderBy: { issuedAt: 'desc' } }),
      prisma.customerAccountCharge.findMany({
        where: { tenantId: a.tenantId, accountId: a.id, statementInvoiceId: null },
        orderBy: { chargedAt: 'asc' },
        take: 1000,
      }),
      prisma.receivableInvoice.findMany({
        where: { tenantId: a.tenantId, customerAccountId: a.id },
        orderBy: [{ issueDate: 'desc' }, { number: 'desc' }],
      }),
    ])
    const writeOffs = bills.length
      ? await prisma.receivableWriteOff.findMany({
          where: { tenantId: a.tenantId, invoiceId: { in: bills.map((b) => b.id) } },
          orderBy: { requestedAt: 'desc' },
        })
      : []
    const conceptIds = [...new Set([...unbilled.map((c) => c.conceptId), ...bills.map((b) => b.conceptId).filter((x): x is string => !!x)])]
    const concepts = conceptIds.length ? await prisma.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, name: true } }) : []
    const brandOf = new Map(concepts.map((c) => [c.id, c.name]))
    const hintOf = new Map(cards.map((c) => [c.id, c.tokenHint]))
    const numberOf = new Map(bills.map((b) => [b.id, b.number]))
    const charges = await Promise.all(unbilled.map(async (c) => ({
      id: c.id, orderId: c.orderId, orderRef: orderRefOf(c.orderId), conceptId: c.conceptId, brand: brandOf.get(c.conceptId) ?? null,
      cardId: c.cardId, cardHint: c.cardId ? hintOf.get(c.cardId) ?? null : null, chargedAt: c.chargedAt, chargedDay: karachiDay(c.chargedAt),
      amountCents: c.amountCents, taxCents: c.taxCents, refundedCents: c.refundedCents, settledCents: c.settledCents, netCents: chargeOwedCents(c),
      reference: c.reference, booked: await isChargeBookedTx(prisma, c),
    })))
    return {
      ...row,
      cards: cards.map(cardView),
      unbilled: {
        charges,
        bookedCents: charges.filter((c) => c.booked).reduce((t, c) => t + c.netCents, 0),
        notBookedCents: charges.filter((c) => !c.booked).reduce((t, c) => t + c.netCents, 0),
      },
      bills: bills.map((b) => ({
        id: b.id, kind: b.kind, number: b.number, status: b.status, conceptId: b.conceptId,
        brand: b.conceptId ? brandOf.get(b.conceptId) ?? null : null,
        issueDate: b.issueDate, dueDate: b.dueDate, periodFrom: b.periodFrom, periodTo: b.periodTo,
        totalCents: totalOf(b), paidCents: toCents(b.paidCents), creditedCents: toCents(b.creditedCents),
        writtenOffCents: toCents(b.writtenOffCents),
        balanceCents: LIVE_KINDS.includes(b.kind) && b.status !== 'void' ? balanceOf(b) : 0,
      })),
      writeOffs: writeOffs.map((w) => ({
        id: w.id, invoiceId: w.invoiceId, invoiceNumber: numberOf.get(w.invoiceId) ?? null, status: w.status,
        amountCents: toCents(w.amountCents), recoveredCents: toCents(w.recoveredCents), reason: w.reason,
        requestedAt: w.requestedAt, decidedAt: w.decidedAt,
      })),
    }
  })

  // ── Charges ──
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; unbilled?: string } }>('/:id/charges', viewers, async (req) => {
    const a = await findAccount(req, req.params.id, 'read')
    const qs = z.object({ from: dateStr.optional(), to: dateStr.optional(), unbilled: z.enum(['0', '1', 'true', 'false']).optional() }).parse(req.query)
    const chargedAt: Prisma.DateTimeFilter = {}
    if (qs.from) chargedAt.gte = parsePktStartOfDay(qs.from)
    if (qs.to) chargedAt.lte = parsePktEndOfDay(qs.to)
    const rows = await prisma.customerAccountCharge.findMany({
      where: {
        tenantId: a.tenantId, accountId: a.id,
        ...(qs.from || qs.to ? { chargedAt } : {}),
        ...(qs.unbilled === '1' || qs.unbilled === 'true' ? { statementInvoiceId: null } : {}),
      },
      orderBy: { chargedAt: 'asc' },
      take: 2000,
    })
    const [concepts, cards, statements] = await Promise.all([
      prisma.concept.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.conceptId))] } }, select: { id: true, name: true } }),
      prisma.customerAccountCard.findMany({ where: { tenantId: a.tenantId, accountId: a.id }, select: { id: true, tokenHint: true, label: true } }),
      prisma.receivableInvoice.findMany({
        where: { tenantId: a.tenantId, id: { in: [...new Set(rows.map((r) => r.statementInvoiceId).filter((x): x is string => !!x))] } },
        select: { id: true, number: true },
      }),
    ])
    const brandOf = new Map(concepts.map((c) => [c.id, c.name]))
    const cardOf = new Map(cards.map((c) => [c.id, c]))
    const stOf = new Map(statements.map((s) => [s.id, s.number]))
    const items = await Promise.all(rows.map(async (c) => ({
      id: c.id, orderId: c.orderId, orderRef: orderRefOf(c.orderId), paymentId: c.paymentId,
      conceptId: c.conceptId, brand: brandOf.get(c.conceptId) ?? null,
      cardId: c.cardId, cardHint: c.cardId ? cardOf.get(c.cardId)?.tokenHint ?? null : null,
      cardLabel: c.cardId ? cardOf.get(c.cardId)?.label ?? null : null,
      chargedAt: c.chargedAt, chargedDay: karachiDay(c.chargedAt),
      amountCents: c.amountCents, taxCents: c.taxCents, refundedCents: c.refundedCents, settledCents: c.settledCents, netCents: chargeOwedCents(c),
      reference: c.reference, statementInvoiceId: c.statementInvoiceId,
      statementNumber: c.statementInvoiceId ? stOf.get(c.statementInvoiceId) ?? null : null,
      booked: c.statementInvoiceId ? true : await isChargeBookedTx(prisma, c),
    })))
    return { items, totalNetCents: items.reduce((t, c) => t + c.netCents, 0) }
  })

  // ── Create ──
  app.post('/', editors, async (req, reply) => {
    const tenantId = activeTenantId(req, 'a client belongs to one company')
    const body = CreateBody.parse(req.body)
    const conceptIds = [...new Set(body.conceptIds)]
    for (const id of conceptIds) {
      try {
        await assertConceptOwned(req, id, 'create')
      } catch (err) {
        if (err instanceof NotFoundError) throw brandNotInCompany()
        throw err
      }
    }
    const ceoNow = isAdmin(req) && !!(await tillClearingCutoverAt(prisma, tenantId))
    let created: CustomerAccount
    try {
      created = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'oa_number:' + tenantId}))`
        const [{ max }] = await tx.$queryRaw<Array<{ max: number | null }>>`
          SELECT MAX(CAST(SUBSTRING("number" FROM 4) AS INTEGER)) AS max
          FROM customer_accounts WHERE "tenantId" = ${tenantId} AND "number" ~ '^OA-[0-9]+$'`
        const number = body.number ?? `OA-${String((max ?? 0) + 1).padStart(4, '0')}`
        return tx.customerAccount.create({
          data: {
            tenantId, number,
            legalName: body.legalName, tradeName: body.tradeName ?? null, ntn: body.ntn ?? null, strn: body.strn ?? null,
            cnic: body.cnic ?? null, address: body.address ?? null, contactName: body.contactName ?? null,
            contactPhone: body.contactPhone ?? null, contactEmail: body.contactEmail ?? null,
            creditLimitCents: body.creditLimitCents, termsDays: body.termsDays, overdueGraceDays: body.overdueGraceDays,
            requiresReference: body.requiresReference, conceptIds, notes: body.notes ?? null, accountType: body.accountType,
            // The CEO's own client is active at once — but never before the company's
            // till clearing is split off 1110 (until then it waits like any other).
            status: ceoNow ? 'active' : 'pending',
            ...(ceoNow ? { approvedById: req.staffUser!.id, approvedAt: new Date() } : {}),
            createdById: req.staffUser!.id,
          },
        })
      })
    } catch (err) {
      if (isP2002(err)) {
        const target = String((err as { meta?: { target?: unknown } }).meta?.target ?? '')
        if (target.includes('number')) throw new AppError('ACCOUNT_CODE_TAKEN', 'This company already has a client with that account code', 409)
        throw nameTaken()
      }
      throw err
    }
    await audit({
      category: 'accounting', action: 'on_account.client.create', entity: 'CustomerAccount', entityId: created.id,
      tenantId, ...actorOf(req),
      after: { number: created.number, legalName: created.legalName, status: created.status, creditLimitCents: toCents(created.creditLimitCents), termsDays: created.termsDays, conceptIds },
    })
    // The bell (queued, after the commit): a new client waits for the CEO.
    if (created.status === 'pending') approvalWaiting('on_account_client', created.id, { round: 'created', actorId: req.staffUser!.id })
    return reply.status(201).send(await reload(created.id, req))
  })

  // ── Edit ──
  app.patch<{ Params: { id: string } }>('/:id', editors, async (req) => {
    const found = await findAccount(req, req.params.id, 'write')
    const body = PatchBody.parse(req.body ?? {})
    const me = req.staffUser!
    const actions: string[] = []
    let before: CustomerAccount
    let after: CustomerAccount
    try {
      ;({ before, after } = await prisma.$transaction(async (tx: Tx) => {
        const a = await lockAccountTx(tx, found.id)
        const data: Prisma.CustomerAccountUpdateInput = {}
        const target = body.status && body.status !== a.status ? body.status : null

        if (a.status === 'closed' && target !== 'pending') throw clientClosed()

        // Details.
        for (const k of ['legalName', 'tradeName', 'ntn', 'strn', 'cnic', 'address', 'contactName', 'contactPhone', 'contactEmail', 'notes'] as const) {
          if (body[k] !== undefined) (data as Record<string, unknown>)[k] = body[k]
        }
        if (body.termsDays !== undefined) data.termsDays = body.termsDays
        if (body.accountType !== undefined) data.accountType = body.accountType
        if (body.overdueGraceDays !== undefined) data.overdueGraceDays = body.overdueGraceDays
        if (body.requiresReference !== undefined) data.requiresReference = body.requiresReference
        // Brands: each one a brand of the CLIENT's own company.
        if (body.conceptIds !== undefined) data.conceptIds = await brandsOfCompany(a.tenantId, body.conceptIds)

        // Credit limit: an increase waits for the CEO; a decrease applies at once.
        if (body.creditLimitCents !== undefined) {
          const current = toCents(a.creditLimitCents)
          const wanted = body.creditLimitCents
          if (a.status === 'pending' || target === 'pending' || (wanted > current && me.role === 'admin')) {
            // A new (or resubmitted) client's whole record waits for the CEO anyway; the CEO's own increase applies.
            if (wanted !== current) actions.push(wanted > current ? 'limit_raised' : 'limit_lowered')
            data.creditLimitCents = wanted
            data.requestedCreditLimitCents = null
            data.limitRequestedById = null
            data.limitRequestedAt = null
          } else if (wanted > current) {
            actions.push('limit_requested')
            data.requestedCreditLimitCents = wanted
            data.limitRequestedById = me.id
            data.limitRequestedAt = new Date()
          } else if (wanted < current) {
            actions.push('limit_lowered')
            data.creditLimitCents = wanted
            // A lower limit supersedes any increase still waiting.
            data.requestedCreditLimitCents = null
            data.limitRequestedById = null
            data.limitRequestedAt = null
          } else if (a.requestedCreditLimitCents != null) {
            // Asking for the current limit withdraws the request.
            actions.push('limit_request_withdrawn')
            data.requestedCreditLimitCents = null
            data.limitRequestedById = null
            data.limitRequestedAt = null
          }
        }

        // Status.
        if (target === 'suspended') {
          if (a.status !== 'active') throw new AppError('BAD_STATE', `A ${a.status} client cannot be suspended`, 409)
          if (!body.reason || body.reason.length < 3) throw new AppError('REASON_REQUIRED', 'Say why the client is suspended', 422)
          data.status = 'suspended'
          data.statusReason = body.reason
          actions.push('suspended')
        } else if (target === 'active') {
          if (a.status === 'pending') throw new AppError('USE_APPROVE', 'A new client is made active by the CEO approving it', 409)
          if (me.role !== 'admin') throw new ForbiddenError('Only the CEO can reactivate a suspended client')
          if (!(await tillClearingCutoverAt(tx, a.tenantId))) throw tillClearingNotSplit()
          data.status = 'active'
          data.statusReason = body.reason || null
          actions.push('reactivated')
        } else if (target === 'closed') {
          const exposure = await exposureOfTx(tx, a.id)
          // In credit (a refund after the statement was paid): pay the
          // client back (Receivables → refund) before closing — 1110 still
          // carries what the company owes them.
          if (exposure.creditCents > 0) {
            throw new AppError('CLIENT_IN_CREDIT', `This client is in credit by ${pkr(exposure.creditCents)} — refund it to the client before closing`, 409, {
              creditCents: exposure.creditCents,
            })
          }
          if (exposure.exposureCents !== 0) {
            throw new AppError('CLIENT_HAS_BALANCE', `This client still owes ${pkr(exposure.exposureCents)} — settle it before closing`, 409, {
              exposureCents: exposure.exposureCents,
            })
          }
          data.status = 'closed'
          data.statusReason = body.reason || null
          data.requestedCreditLimitCents = null
          data.limitRequestedById = null
          data.limitRequestedAt = null
          // A closed client's cards stop working.
          await tx.customerAccountCard.updateMany({
            where: { tenantId: a.tenantId, accountId: a.id, revokedAt: null },
            data: { revokedAt: new Date(), revokedById: me.id, revokedReason: 'client closed' },
          })
          actions.push('closed')
        } else if (target === 'pending') {
          // Resubmit an application the CEO rejected (never approved).
          if (a.status !== 'closed' || a.approvedAt) {
            throw new AppError('BAD_STATE', 'Only a rejected application can be sent back to the CEO', 409)
          }
          data.status = 'pending'
          data.statusReason = null
          actions.push('resubmitted')
        }

        if (Object.keys(data).length === 0) return { before: a, after: a }
        if (actions.length === 0) actions.push('update')
        const updated = await tx.customerAccount.update({ where: { id: a.id }, data })
        return { before: a, after: updated }
      }))
    } catch (err) {
      if (isP2002(err)) throw nameTaken()
      throw err
    }
    if (before !== after) {
      const view = (x: CustomerAccount) => ({
        legalName: x.legalName, tradeName: x.tradeName, ntn: x.ntn, strn: x.strn, cnic: x.cnic, address: x.address,
        contactName: x.contactName, contactPhone: x.contactPhone, contactEmail: x.contactEmail,
        status: x.status, statusReason: x.statusReason, creditLimitCents: toCents(x.creditLimitCents),
        requestedCreditLimitCents: x.requestedCreditLimitCents == null ? null : toCents(x.requestedCreditLimitCents),
        termsDays: x.termsDays, overdueGraceDays: x.overdueGraceDays, requiresReference: x.requiresReference,
        conceptIds: x.conceptIds, notes: x.notes,
      })
      for (const action of actions) {
        await audit({
          category: 'accounting', action: `on_account.client.${action}`, entity: 'CustomerAccount', entityId: after.id,
          tenantId: after.tenantId, ...actorOf(req), before: view(before), after: view(after),
        })
      }
    }
    // The bell (queued): a credit-limit increase, or a rejected application sent back, waits for the CEO.
    if (before !== after) {
      if (actions.includes('limit_requested') && after.limitRequestedAt) {
        approvalWaiting('on_account_client', after.id, { round: `limit:${after.limitRequestedAt.toISOString()}`, actorId: req.staffUser!.id })
      } else if (actions.includes('resubmitted')) {
        approvalWaiting('on_account_client', after.id, { round: `resubmit:${after.updatedAt.toISOString()}`, actorId: req.staffUser!.id })
      }
    }
    return reload(after.id, req)
  })

  // approval.decide + the "decided" notice (the bell). The guard is a plain role list (CEO), so the grant is 'role'.
  // After the commit; never fails the decision.
  // A limit increase CLEARS limitRequestedById on decision: pass who asked (read before the write).
  async function decidedNotice(req: FastifyRequest, a: { id: string; tenantId: string }, decision: 'approve' | 'reject', note?: string | null, requestedById?: string | null) {
    try {
      await auditApproval(req, {
        type: 'on_account_client', id: a.id, tenantId: a.tenantId, decision, grant: { via: 'role' }, entity: 'CustomerAccount',
        metadata: { decidedAt: new Date().toISOString(), ...(note ? { reason: note } : {}), ...(requestedById ? { waitingUserIds: [requestedById] } : {}) },
      })
    } catch (err) {
      console.warn(`[on-account] approval.decide not recorded: ${(err as Error).message}`)
    }
  }

  // ── The CEO decides: a new client, or a limit increase ──
  app.post<{ Params: { id: string } }>('/:id/approve', ceo, async (req) => {
    const found = await findAccount(req, req.params.id, 'write')
    const body = ApproveBody.parse(req.body ?? {})
    const me = req.staffUser!
    const { kind, before, after } = await prisma.$transaction(async (tx) => {
      const a = await lockAccountTx(tx, found.id)
      const kind = pendingOf(a)
      if (!kind) throw new AppError('NOTHING_PENDING', 'Nothing on this client is waiting for approval — reload it', 409)
      // Apply only what the CEO saw: any edit since (limit, terms, brands…) refuses it.
      const shownLimit = kind === 'new_client' ? toCents(a.creditLimitCents) : toCents(a.requestedCreditLimitCents!)
      if (
        (body.expectedUpdatedAt !== undefined && new Date(body.expectedUpdatedAt).getTime() !== a.updatedAt.getTime())
        || (body.creditLimitCents !== undefined && body.creditLimitCents !== shownLimit)
      ) {
        throw new AppError('REQUEST_CHANGED', 'This request changed since you opened it, reload it', 409)
      }
      await assertNotSelfApproval({
        tenantId: a.tenantId, actor: { id: me.id, role: me.role },
        creatorId: kind === 'new_client' ? a.createdById : a.limitRequestedById,
        action: kind === 'new_client' ? 'approve an on-account client' : 'approve a credit-limit increase',
        entity: 'CustomerAccount', entityId: a.id,
      })
      // Switch: on-account needs the company's till clearing split off 1110 first.
      if (!(await tillClearingCutoverAt(tx, a.tenantId))) throw tillClearingNotSplit()
      const data: Prisma.CustomerAccountUpdateInput = kind === 'new_client'
        ? { status: 'active', statusReason: null, approvedById: me.id, approvedAt: new Date() }
        : { creditLimitCents: toCents(a.requestedCreditLimitCents!), requestedCreditLimitCents: null, limitRequestedById: null, limitRequestedAt: null }
      const updated = await tx.customerAccount.update({ where: { id: a.id }, data })
      return { kind, before: a, after: updated }
    })
    await audit({
      category: 'accounting', action: 'on_account.client.approve', entity: 'CustomerAccount', entityId: after.id,
      tenantId: after.tenantId, ...actorOf(req),
      before: { status: before.status, creditLimitCents: toCents(before.creditLimitCents) },
      after: { status: after.status, creditLimitCents: toCents(after.creditLimitCents) },
      metadata: { kind, note: body.note || null, requestedById: kind === 'new_client' ? before.createdById : before.limitRequestedById },
    })
    await decidedNotice(req, after, 'approve', null, kind === 'limit_increase' ? before.limitRequestedById : null)
    return reload(after.id, req)
  })

  app.post<{ Params: { id: string } }>('/:id/reject', ceo, async (req) => {
    const found = await findAccount(req, req.params.id, 'write')
    const { note } = RejectBody.parse(req.body ?? {})
    const me = req.staffUser!
    const { kind, before, after } = await prisma.$transaction(async (tx) => {
      const a = await lockAccountTx(tx, found.id)
      const kind = pendingOf(a)
      if (!kind) throw new AppError('NOTHING_PENDING', 'Nothing on this client is waiting for approval — reload it', 409)
      await assertNotSelfApproval({
        tenantId: a.tenantId, actor: { id: me.id, role: me.role },
        creatorId: kind === 'new_client' ? a.createdById : a.limitRequestedById,
        action: 'reject an on-account request', entity: 'CustomerAccount', entityId: a.id,
      })
      const data: Prisma.CustomerAccountUpdateInput = kind === 'new_client'
        // A rejected application is closed (finance may send it back: PATCH status 'pending').
        ? { status: 'closed', statusReason: `Rejected by the CEO: ${note}` }
        : { requestedCreditLimitCents: null, limitRequestedById: null, limitRequestedAt: null }
      const updated = await tx.customerAccount.update({ where: { id: a.id }, data })
      return { kind, before: a, after: updated }
    })
    await audit({
      category: 'accounting', action: 'on_account.client.reject', entity: 'CustomerAccount', entityId: after.id,
      tenantId: after.tenantId, ...actorOf(req),
      before: {
        status: before.status, creditLimitCents: toCents(before.creditLimitCents),
        requestedCreditLimitCents: before.requestedCreditLimitCents == null ? null : toCents(before.requestedCreditLimitCents),
      },
      after: { status: after.status },
      metadata: { kind, note },
    })
    await decidedNotice(req, after, 'reject', note, kind === 'limit_increase' ? before.limitRequestedById : null)
    return reload(after.id, req)
  })

  // ── Cards ──
  // The code is in the RESPONSE only — never stored, audited or logged.
  async function issueCardTx(tx: Tx, a: CustomerAccount, label: string, issuedById: string) {
    for (let attempt = 0; ; attempt++) {
      const { code, hash, hint } = newCardCode()
      try {
        const card = await tx.customerAccountCard.create({
          data: { tenantId: a.tenantId, accountId: a.id, label, tokenHash: hash, tokenHint: hint, issuedById },
        })
        return { card, code }
      } catch (err) {
        // 100 random bits: a clash is astronomically unlikely; try once more, never loop.
        if (isP2002(err) && attempt === 0) continue
        throw err
      }
    }
  }
  const cardableOrThrow = (a: CustomerAccount) => {
    if (a.status === 'closed') throw clientClosed()
    if (a.status === 'pending') throw new AppError('CLIENT_NOT_APPROVED', 'Cards are issued once the CEO has approved the client', 409)
  }

  app.post<{ Params: { id: string } }>('/:id/cards', editors, async (req, reply) => {
    const found = await findAccount(req, req.params.id, 'write')
    const { label } = CardBody.parse(req.body ?? {})
    const { card, code } = await prisma.$transaction(async (tx) => {
      const a = await lockAccountTx(tx, found.id)
      cardableOrThrow(a)
      return issueCardTx(tx, a, label, req.staffUser!.id)
    })
    await audit({
      category: 'accounting', action: 'on_account.card.issue', entity: 'CustomerAccountCard', entityId: card.id,
      tenantId: card.tenantId, ...actorOf(req), after: { accountId: card.accountId, label: card.label, hint: card.tokenHint },
    })
    return reply.status(201).send({ card: cardView(card), code })
  })

  /** The card of THIS client in its company, or 404. */
  async function cardOf(tx: Tx, a: CustomerAccount, cardId: string): Promise<CustomerAccountCard> {
    const card = await tx.customerAccountCard.findFirst({ where: { id: cardId, accountId: a.id, tenantId: a.tenantId } })
    if (!card) throw new NotFoundError('CustomerAccountCard', cardId)
    return card
  }
  const cardRevoked = () => new AppError('CARD_REVOKED', 'This card has already been revoked', 409)

  app.post<{ Params: { id: string; cardId: string } }>('/:id/cards/:cardId/rotate', editors, async (req) => {
    const found = await findAccount(req, req.params.id, 'write')
    const me = req.staffUser!
    const { old, card, code } = await prisma.$transaction(async (tx) => {
      const a = await lockAccountTx(tx, found.id)
      const old = await cardOf(tx, a, req.params.cardId)
      cardableOrThrow(a)
      const killed = await tx.customerAccountCard.updateMany({
        where: { id: old.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedById: me.id, revokedReason: 'rotated' },
      })
      if (killed.count !== 1) throw cardRevoked()
      return { old, ...(await issueCardTx(tx, a, old.label, me.id)) }
    })
    await audit({
      category: 'accounting', action: 'on_account.card.rotate', entity: 'CustomerAccountCard', entityId: card.id,
      tenantId: card.tenantId, ...actorOf(req),
      before: { cardId: old.id, hint: old.tokenHint }, after: { cardId: card.id, label: card.label, hint: card.tokenHint },
    })
    return { card: cardView(card), code, replacedCardId: old.id }
  })

  app.post<{ Params: { id: string; cardId: string } }>('/:id/cards/:cardId/revoke', editors, async (req) => {
    const found = await findAccount(req, req.params.id, 'write')
    const { reason } = RevokeBody.parse(req.body ?? {})
    const me = req.staffUser!
    const card = await prisma.$transaction(async (tx) => {
      const a = await lockAccountTx(tx, found.id)
      const c = await cardOf(tx, a, req.params.cardId)
      if (a.status === 'closed') throw clientClosed()
      const killed = await tx.customerAccountCard.updateMany({
        where: { id: c.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedById: me.id, revokedReason: reason },
      })
      if (killed.count !== 1) throw cardRevoked()
      return tx.customerAccountCard.findUniqueOrThrow({ where: { id: c.id } })
    })
    await audit({
      category: 'accounting', action: 'on_account.card.revoke', entity: 'CustomerAccountCard', entityId: card.id,
      tenantId: card.tenantId, ...actorOf(req), after: { accountId: card.accountId, hint: card.tokenHint, reason },
    })
    return { card: cardView(card) }
  })

  // ── Overdue reminder (once per Karachi day) ──
  app.post<{ Params: { id: string } }>('/:id/remind', editors, async (req) => {
    const a = await findAccount(req, req.params.id, 'write')
    if (!a.contactEmail) throw new AppError('NO_EMAIL', 'This client has no contact email — add one first', 422)
    const now = new Date()
    const exposure = await exposureOfTx(prisma, a.id, now)
    if (exposure.invoicesDueCents <= 0) throw new AppError('NOTHING_DUE', 'This client has no statement or invoice to pay', 409)

    // Claim today's reminder (conditional: two clicks never send two emails).
    const claimed = await prisma.customerAccount.updateMany({
      where: { id: a.id, tenantId: a.tenantId, OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lt: karachiDayStart(now) } }] },
      data: { lastRemindedAt: now },
    })
    if (claimed.count !== 1) throw new AppError('REMINDED_TODAY', 'This client was already reminded today', 409)

    const [company, bills, replyTo, testCompany] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: a.tenantId }, select: { name: true } }),
      prisma.receivableInvoice.findMany({
        where: { tenantId: a.tenantId, customerAccountId: a.id, kind: { in: [...LIVE_KINDS] }, status: { in: ['open', 'partial'] } },
        orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
      }),
      companyReplyTo(a.tenantId, a.conceptIds),
      isTestTenant(a.tenantId),
    ])
    const today = karachiDay(now)
    const rows = bills
      .map((b) => ({ number: b.number, due: karachiDay(b.dueDate), balance: balanceOf(b) }))
      .filter((b) => b.balance > 0)
    const from = escapeHtml(company?.name ?? 'servd')
    const html = [
      `<p>Dear ${escapeHtml(a.contactName || a.legalName)},</p>`,
      `<p>This is a reminder from ${from} that the following ${rows.length === 1 ? 'bill is' : 'bills are'} open on your account ${escapeHtml(a.number)}:</p>`,
      '<table cellpadding="6" style="border-collapse:collapse"><tr><th align="left">Bill</th><th align="left">Due</th><th align="right">Balance</th></tr>',
      ...rows.map((r) => `<tr><td>${escapeHtml(r.number)}</td><td>${r.due}${r.due < today ? ' (overdue)' : ''}</td><td align="right">${pkr(r.balance)}</td></tr>`),
      `</table><p><strong>Total due: ${pkr(exposure.invoicesDueCents)}</strong></p>`,
      exposure.overdue
        ? '<p>Charges on account are paused until the overdue balance is settled.</p>'
        : '',
      `<p>If you have already paid, please reply with the payment reference.</p><p>${from}</p>`,
    ].join('\n')

    try {
      await sendEmail({
        to: a.contactEmail,
        subject: `${company?.name ?? 'servd'} — payment reminder for ${a.number}`,
        html,
        replyTo,
        scope: customerScope(a.tenantId),
      })
    } catch (err) {
      // Not sent: give today's reminder back so it can be tried again.
      await prisma.customerAccount.updateMany({ where: { id: a.id, lastRemindedAt: now }, data: { lastRemindedAt: a.lastRemindedAt } })
      // The mailer's own message can name the SMTP host or auth details: log it, never return it.
      req.log.warn({ err, accountId: a.id }, 'on-account reminder email failed')
      throw new AppError('EMAIL_FAILED', 'The reminder could not be sent. Check the email settings and try again.', 502)
    }
    await audit({
      category: 'accounting', action: 'on_account.client.remind', entity: 'CustomerAccount', entityId: a.id,
      tenantId: a.tenantId, ...actorOf(req),
      metadata: { to: a.contactEmail, bills: rows.map((r) => r.number), dueCents: exposure.invoicesDueCents, testCompany },
    })
    // A test company and the practice copy send nothing — said plainly.
    const skipped = isSandbox() ? 'practice' as const : testCompany ? 'test_company' as const : null
    return { sent: skipped === null, ...(skipped ? { skipped } : {}), to: a.contactEmail, remindedAt: now }
  })
}
