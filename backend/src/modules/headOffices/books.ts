// Head office (D1) — the books settings: cost pool, CA confirmation, recharge
// switch (HeadOfficeBooks, one row per head office).
//
// The switch (CLAUDE.md "everything ships OFF"): recharge posting stays OFF
// until the CEO has confirmed the accounts with the CA AND recorded the CA's
// tax answer (POST confirm), then switches it on with a cutover month
// (PUT recharge). The DB backs this: CHECK head_office_books_enable_chk
// (rechargeEnabled needs accountsConfirmedAt and rechargeFromPeriod).
//
// ANY change to the accounts, the pool or the links clears the confirmation
// and switches recharge OFF in the same update (`invalidateConfirmation`), so
// the CA always confirms what will actually post.
//
// `headOfficeSetupApplied` is the setup-wizard marker other modules read
// (planning, HR, the admin) to keep today's behaviour until it is true.

import type { Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertMonth } from '../intercompany/fleet.js'

export type Tx = Prisma.TransactionClient
export type Db = Tx | PrismaClient

// ─── Cost pool ───────────────────────────────────────────────────────────────

const zCode = z.string().trim().regex(/^\d{4}$/, 'An account code is four digits')

/** HeadOfficeBooks.costPool: ranges inside 1000–9999 with from ≤ to; codes are strings. */
export const zCostPool = z.object({
  include: z.array(z.object({
    from: z.number().int().min(1000).max(9999),
    to: z.number().int().min(1000).max(9999),
  }).refine((r) => r.from <= r.to, { message: 'A range must run from the lower code to the higher one' })).max(20),
  includeCodes: z.array(zCode).max(200).default([]),
  excludeCodes: z.array(zCode).max(200).default([]),
})
export type CostPool = z.infer<typeof zCostPool>

/**
 * The head office is a SALARY-SPLITTING entity only (owner, 2026-10-30: "head
 * office is just a salary splitting entity. no expenses to be charged other than
 * salary splitting" — REPLACES HO-Q1's 5000–6999 pool). The pool is the wages
 * accounts 6030–6036 (kitchen, front of house, management, riders — each
 * carrying the employer EOBI / SESSI as payroll posts them — and gratuity);
 * nothing else the head office books is ever recharged. The recharge itself
 * credits 4220 income, outside the range, and pool.ts also drops the books'
 * recharge account by id whatever its code.
 */
export const SALARY_POOL_FROM = 6030
export const SALARY_POOL_TO = 6036
export const DEFAULT_COST_POOL: CostPool = { include: [{ from: SALARY_POOL_FROM, to: SALARY_POOL_TO }], includeCodes: [], excludeCodes: [] }

/** Every range and code of a pool inside the salary accounts? */
export function poolIsSalariesOnly(p: CostPool): boolean {
  const inRange = (n: number) => n >= SALARY_POOL_FROM && n <= SALARY_POOL_TO
  return p.include.every((r) => inRange(r.from) && inRange(r.to)) && p.includeCodes.every((c) => inRange(Number(c)))
}

/** The stored pool, parsed; an unreadable value falls back to the default (never throws on a read). */
export function parseCostPool(raw: unknown): CostPool {
  const r = zCostPool.safeParse(raw)
  return r.success ? r.data : DEFAULT_COST_POOL
}

// ─── Locking and the confirmation switch ─────────────────────────────────────

export type BooksRow = NonNullable<Awaited<ReturnType<Tx['headOfficeBooks']['findUnique']>>>

/** Lock the head office's books row for the rest of the transaction and return it. 404 when it has none. */
export async function lockBooks(tx: Tx, hoId: string): Promise<BooksRow> {
  await tx.$queryRaw`SELECT "tenantId" FROM "head_office_books" WHERE "tenantId" = ${hoId} FOR UPDATE`
  const row = await tx.headOfficeBooks.findUnique({ where: { tenantId: hoId } })
  if (!row) throw new NotFoundError('Head office books', hoId)
  return row
}

export interface Invalidation {
  /** The books were confirmed before this change. */
  wasConfirmed: boolean
  /** Recharge was ON before this change (audit ho.recharge.disable). */
  wasEnabled: boolean
}

/**
 * Clear the CA confirmation and switch recharge OFF, in the same update — for
 * every change to the accounts, the pool or the links. The caller holds (or
 * this takes) the books lock. The tax answer stays on the row as history; a
 * new confirmation asks for it again.
 */
export async function invalidateConfirmation(tx: Tx, hoId: string, actorId: string, locked?: BooksRow): Promise<Invalidation> {
  const before = locked ?? (await lockBooks(tx, hoId))
  const out = { wasConfirmed: before.accountsConfirmedAt !== null, wasEnabled: before.rechargeEnabled }
  await tx.headOfficeBooks.update({
    where: { tenantId: hoId },
    data: {
      accountsConfirmedAt: null,
      accountsConfirmedById: null,
      accountsConfirmedNote: null,
      rechargeEnabled: false,
      updatedById: actorId,
    },
  })
  return out
}

// ─── The book's settings ─────────────────────────────────────────────────────

/** PUT pool. Clears the confirmation (and switches recharge off). */
export async function updatePool(tx: Tx, hoId: string, pool: CostPool, actorId: string): Promise<{ before: CostPool; after: CostPool } & Invalidation> {
  const row = await lockBooks(tx, hoId)
  const parsed = zCostPool.parse(pool)
  if (!poolIsSalariesOnly(parsed)) {
    throw new AppError('POOL_SALARIES_ONLY', `The head office shares salaries only — the pool may name accounts ${SALARY_POOL_FROM}–${SALARY_POOL_TO} (wages and gratuity) and nothing else`, 422)
  }
  const inv = await invalidateConfirmation(tx, hoId, actorId, row)
  await tx.headOfficeBooks.update({ where: { tenantId: hoId }, data: { costPool: parsed, updatedById: actorId } })
  return { before: parseCostPool(row.costPool), after: parsed, ...inv }
}

export const zConfirm = z.object({
  note: z.string().trim().min(10, 'Say what the CA confirmed (at least 10 characters)').max(2000),
  taxAnswer: z.string().trim().min(10, "Record the CA's tax answer (at least 10 characters)").max(2000),
})

/**
 * POST confirm {note, taxAnswer}: the CEO records that the CA confirmed the
 * accounts (and how the charge is taxed). Refused while the mapping is
 * incomplete: 422 BOOKS_INCOMPLETE (no active recharge account, or a live link
 * without an active charges account).
 */
export async function confirmBooks(tx: Tx, hoId: string, input: { note: string; taxAnswer: string }, actorId: string): Promise<BooksRow> {
  const body = zConfirm.parse(input)
  const row = await lockBooks(tx, hoId)
  const problems: string[] = []
  const recharge = row.rechargeAccountId
    ? await tx.account.findUnique({ where: { id: row.rechargeAccountId }, select: { isActive: true, tenantId: true } })
    : null
  if (!recharge || !recharge.isActive || recharge.tenantId !== hoId) problems.push('the head office has no active recharge account')
  const links = await tx.headOfficeLink.findMany({
    where: { tenantId: hoId, endedAt: null },
    select: { companyTenantId: true, charges: { select: { isActive: true, tenantId: true, type: true } }, company: { select: { name: true } } },
  })
  for (const l of links) {
    if (!l.charges || !l.charges.isActive || l.charges.tenantId !== l.companyTenantId || l.charges.type !== 'expense') {
      problems.push(`${l.company.name} has no active head office charges account`)
    }
  }
  if (problems.length > 0) {
    throw new AppError('BOOKS_INCOMPLETE', `Map the accounts before confirming: ${problems.join('; ')}`, 422, { problems })
  }
  return tx.headOfficeBooks.update({
    where: { tenantId: hoId },
    data: {
      accountsConfirmedAt: new Date(),
      accountsConfirmedById: actorId,
      accountsConfirmedNote: body.note,
      taxAnswer: body.taxAnswer,
      updatedById: actorId,
    },
  })
}

export const zRecharge = z.object({
  enabled: z.boolean(),
  fromPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Give the cutover month as YYYY-MM').nullable().optional(),
  requireLockedPayroll: z.boolean().optional(),
})

/**
 * PUT recharge {enabled, fromPeriod, requireLockedPayroll}.
 *   409 ACCOUNTS_NOT_CONFIRMED  enabling books the CEO has not confirmed with the CA
 *   422 FROM_PERIOD_REQUIRED    enabling with no cutover month
 * Switching off is always allowed.
 */
export async function setRecharge(
  tx: Tx, hoId: string, input: z.infer<typeof zRecharge>, actorId: string,
): Promise<{ before: BooksRow; after: BooksRow }> {
  const body = zRecharge.parse(input)
  const row = await lockBooks(tx, hoId)
  const fromPeriod = body.fromPeriod === undefined ? row.rechargeFromPeriod : body.fromPeriod
  if (fromPeriod) assertMonth(fromPeriod, 'fromPeriod')
  if (body.enabled) {
    if (!row.accountsConfirmedAt) {
      throw new AppError('ACCOUNTS_NOT_CONFIRMED', 'Confirm the accounts with your CA first (Books → Confirm), then switch recharge on', 409)
    }
    if (!fromPeriod) throw new AppError('FROM_PERIOD_REQUIRED', 'Give the cutover month — the first month the head office charges the companies', 422)
  }
  const after = await tx.headOfficeBooks.update({
    where: { tenantId: hoId },
    data: {
      rechargeEnabled: body.enabled,
      rechargeFromPeriod: fromPeriod ?? null,
      ...(body.requireLockedPayroll !== undefined ? { requireLockedPayroll: body.requireLockedPayroll } : {}),
      updatedById: actorId,
    },
  })
  return { before: row, after }
}

// ─── The setup-wizard marker ─────────────────────────────────────────────────

/**
 * True once the head-office setup wizard has run for ANY head office
 * (HeadOfficeBooks.setupAppliedAt set). Planning, HR and the admin keep
 * today's behaviour while it is false. Read on serviceClient (a platform
 * flag, not company data) and never cached.
 */
export async function headOfficeSetupApplied(db: Db = serviceClient): Promise<boolean> {
  // Same filter as the wizard's alreadyApplied(): a test head office never counts.
  const n = await db.headOfficeBooks.count({ where: { setupAppliedAt: { not: null }, tenant: { isTest: false } } })
  return n > 0
}

// ─── GET books ───────────────────────────────────────────────────────────────

/**
 * Shown on the Books tab whenever the recharge account is revenue-type — the
 * default 4220 since HO-Q3 (owner, 2026-10-26: income, knowing the
 * All-companies P&L shows it as income and cost until eliminations exist).
 */
export const REVENUE_RECHARGE_WARNING =
  'The All-companies P&L will show the recharge as both income and cost until eliminations are built'

type AccountView = { id: string; code: string; name: string; type: string; isActive: boolean; controlledBy: string | null }
const ACCOUNT_VIEW = { id: true, code: true, name: true, type: true, isActive: true, controlledBy: true } as const

export interface BooksView {
  tenantId: string
  rechargeAccount: AccountView | null
  costPool: CostPool
  confirmed: boolean
  accountsConfirmedAt: Date | null
  accountsConfirmedById: string | null
  accountsConfirmedNote: string | null
  taxAnswer: string | null
  rechargeEnabled: boolean
  rechargeFromPeriod: string | null
  requireLockedPayroll: boolean
  setupAppliedAt: Date | null
  links: Array<{ linkId: string; companyTenantId: string; companyName: string; chargesAccount: AccountView | null }>
  warnings: string[]
}

/** GET /head-offices/:id/books — the settings, the mapped accounts per live link, and warnings. */
export async function booksView(db: Db, hoId: string): Promise<BooksView> {
  const row = await db.headOfficeBooks.findUnique({
    where: { tenantId: hoId },
    include: { rechargeAccount: { select: ACCOUNT_VIEW } },
  })
  if (!row) throw new NotFoundError('Head office books', hoId)
  const links = await db.headOfficeLink.findMany({
    where: { tenantId: hoId, endedAt: null },
    select: { id: true, companyTenantId: true, company: { select: { name: true } }, charges: { select: ACCOUNT_VIEW } },
    orderBy: { startedAt: 'asc' },
  })
  const warnings: string[] = []
  if (row.rechargeAccount?.type === 'revenue') warnings.push(REVENUE_RECHARGE_WARNING)
  if (!row.rechargeAccount || !row.rechargeAccount.isActive) warnings.push('Map an active recharge account')
  for (const l of links) {
    if (!l.charges || !l.charges.isActive) warnings.push(`${l.company.name}: map an active head office charges account`)
  }
  if (!row.accountsConfirmedAt) warnings.push('Confirm the accounts with your CA before switching recharge on')
  return {
    tenantId: row.tenantId,
    rechargeAccount: row.rechargeAccount,
    costPool: parseCostPool(row.costPool),
    confirmed: row.accountsConfirmedAt !== null,
    accountsConfirmedAt: row.accountsConfirmedAt,
    accountsConfirmedById: row.accountsConfirmedById,
    accountsConfirmedNote: row.accountsConfirmedNote,
    taxAnswer: row.taxAnswer,
    rechargeEnabled: row.rechargeEnabled,
    rechargeFromPeriod: row.rechargeFromPeriod,
    requireLockedPayroll: row.requireLockedPayroll,
    setupAppliedAt: row.setupAppliedAt,
    links: links.map((l) => ({ linkId: l.id, companyTenantId: l.companyTenantId, companyName: l.company.name, chargesAccount: l.charges })),
    warnings,
  }
}
