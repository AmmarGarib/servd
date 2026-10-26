// Head office (D1) — the two accounts a recharge posts to, beside the pair
// accounts (spec §3 as amended by A1.1 / A1.2 and the owner's HO-Q3):
//
//   • HO books: the RECHARGE account — the template 4220 "Head Office Recharge
//     Income" (ACCT.HO_RECHARGE_INCOME, revenue, 42xx other income). Owner
//     HO-Q3, 2026-10-26: the monthly recharge SHOWS AS INCOME in the head
//     office's own books — never the 6990 contra-expense, which stays the
//     shared-fleet recharge's recovery account (intercompany/fleet.ts) and is
//     never a head-office recharge account. 4220 is resolved, never created
//     here (ensureChartOfAccounts / ensureChartInTx add it). The CA may re-map
//     it to another revenue or expense account that is not an engine code.
//     Books still on 6990 from before HO-Q3 are moved by
//     `moveRechargeToIncome` at boot (recharge OFF ones only).
//   • Company books: "Head office charges — <HO>" (expense), first free code
//     in 6200–6249, one per (company, head office); re-linking the same head
//     office reuses it.
//
// The Due-from / Due-to of a head-office pair are the EXISTING inter-company
// pair accounts (1450–1499 / 2150–2199, intercompany/accounts.ts
// ensurePairAccounts, controlledBy 'intercompany'); 1400–1449 / 2100–2149 stay
// reserved and unused. Nothing here creates a controlled account.
//
// Re-mapping (PUT /head-offices/:id/books/accounts, `applyMapping`):
//   charges   an active EXPENSE in that company's chart, not controlled
//   recharge  an active REVENUE or EXPENSE in the head office's chart, not controlled
//   neither may be a posting-engine code (ACCT.* or REQUIRED_ACCOUNT_CODES) —
//   422 ACCOUNT_RESERVED — except 4220, the one engine code allowed, and only
//   as the recharge account (6990 is refused: it is the fleet's). Any accepted
//   change clears the CA confirmation and switches recharge OFF in the same
//   transaction.

import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { CHART_OF_ACCOUNTS, REQUIRED_ACCOUNT_CODES } from '../../lib/chartOfAccounts.js'
import { ACCT } from '../accounting/journal.js'
import { serviceClient } from '../../lib/prisma.js'
import { invalidateConfirmation, lockBooks, REVENUE_RECHARGE_WARNING, type Invalidation } from './books.js'

export type Tx = Prisma.TransactionClient
export type Db = Tx | PrismaClient

/** Company books: "Head office charges — <HO>" (A1.1). */
export const HO_CHARGES_RANGE = { from: 6200, to: 6249 } as const
/** HO books: the recharge INCOME account (owner HO-Q3, 2026-10-26). */
export const HO_RECHARGE_CODE = ACCT.HO_RECHARGE_INCOME
/** The shared-fleet recovery account the head-office recharge used before HO-Q3 — never a recharge account now. */
export const LEGACY_HO_RECHARGE_CODE = ACCT.GROUP_RECHARGES

/** Posting-engine codes no head-office mapping may take (4220 is allowed as the recharge account only). */
const ENGINE_CODES: ReadonlySet<string> = new Set<string>([...Object.values(ACCT), ...REQUIRED_ACCOUNT_CODES])

/**
 * The first code in [from, to] absent from the tenant's chart — active or not.
 * 422 ACCOUNT_RANGE_FULL when every code is taken.
 */
export async function nextFreeCode(tx: Db, tenantId: string, from: number, to: number): Promise<string> {
  const range: string[] = []
  for (let c = from; c <= to; c++) range.push(String(c))
  const used = new Set((await tx.account.findMany({ where: { tenantId, code: { in: range } }, select: { code: true } })).map((a) => a.code))
  const code = range.find((c) => !used.has(c))
  if (!code) {
    throw new AppError('ACCOUNT_RANGE_FULL', `No free account code left in ${from}–${to} — free one in Configuration → Chart of accounts`, 422)
  }
  return code
}

/**
 * The company's "Head office charges — <HO>" account for a new link: the one a
 * previous link of the SAME head office used (if still an active expense), else
 * a new expense account at the first free code in 6200–6249.
 */
export async function createChargesAccount(tx: Tx, input: { companyId: string; hoId: string; hoName: string }): Promise<{ id: string; code: string; reused: boolean }> {
  const previous = await tx.headOfficeLink.findFirst({
    where: { tenantId: input.hoId, companyTenantId: input.companyId, chargesAccountId: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { charges: { select: { id: true, code: true, isActive: true, type: true, tenantId: true, controlledBy: true } } },
  })
  const prev = previous?.charges
  if (prev && prev.isActive && prev.type === 'expense' && prev.tenantId === input.companyId && !prev.controlledBy) {
    return { id: prev.id, code: prev.code, reused: true }
  }
  const code = await nextFreeCode(tx, input.companyId, HO_CHARGES_RANGE.from, HO_CHARGES_RANGE.to)
  const row = await tx.account.create({
    data: {
      tenantId: input.companyId,
      code,
      name: `Head office charges — ${input.hoName}`.slice(0, 120),
      type: 'expense',
      description: `Head office: the monthly recharge from ${input.hoName} (its costs shared by % table). Confirm name and code with your CA.`,
      isActive: true,
    },
    select: { id: true, code: true },
  })
  return { ...row, reused: false }
}

/**
 * Add the template chart to a tenant created in THIS transaction. Same rule as
 * lib/chartOfAccounts.ts ensureChartOfAccounts (only missing codes, never
 * overwrites), but on the transaction: that function writes through its own
 * client, which cannot see an uncommitted tenant. Boot's ensureChartOfAccounts
 * keeps the head office's chart complete afterwards, as for every company.
 */
export async function ensureChartInTx(tx: Tx, tenantId: string): Promise<number> {
  const have = new Set((await tx.account.findMany({ where: { tenantId }, select: { code: true } })).map((a) => a.code))
  const missing = CHART_OF_ACCOUNTS.filter((a) => !have.has(a.code))
  if (missing.length === 0) return 0
  await tx.account.createMany({
    data: missing.map((a) => ({
      tenantId, code: a.code, name: a.name, type: a.type, description: a.description ?? null,
      controlledBy: a.controlledBy ?? null, isActive: true,
    })),
    skipDuplicates: true,
  })
  return missing.length
}

/**
 * The head office's recharge account: its template 4220 Head Office Recharge
 * Income (HO-Q3 — resolved, never created here). The template chart is added
 * first when the head office lacks 4220. 422 RECHARGE_ACCOUNT_UNUSABLE when
 * 4220 is switched off, not a revenue account, or controlled.
 */
export async function resolveRechargeAccount(tx: Tx, hoId: string): Promise<{ id: string; code: string }> {
  let acc = await tx.account.findUnique({
    where: { tenantId_code: { tenantId: hoId, code: HO_RECHARGE_CODE } },
    select: { id: true, code: true, type: true, isActive: true, controlledBy: true },
  })
  if (!acc) {
    await ensureChartInTx(tx, hoId)
    acc = await tx.account.findUnique({
      where: { tenantId_code: { tenantId: hoId, code: HO_RECHARGE_CODE } },
      select: { id: true, code: true, type: true, isActive: true, controlledBy: true },
    })
  }
  if (!acc || !acc.isActive || acc.type !== 'revenue' || acc.controlledBy) {
    throw new AppError(
      'RECHARGE_ACCOUNT_UNUSABLE',
      `The head office's ${HO_RECHARGE_CODE} account is missing, switched off, not an income account or controlled — fix it in Configuration → Chart of accounts`,
      422,
    )
  }
  return { id: acc.id, code: acc.code }
}

/**
 * The code of a link's "Head office charges" account in the company's chart,
 * for posting. 404 for an unknown link; 422 CHARGES_ACCOUNT_UNUSABLE when the
 * link has none, or it is switched off / not an expense / controlled.
 */
export async function chargesAccountCodeFor(db: Db, linkId: string): Promise<string> {
  const link = await db.headOfficeLink.findUnique({
    where: { id: linkId },
    select: { companyTenantId: true, charges: { select: { code: true, tenantId: true, isActive: true, type: true, controlledBy: true } } },
  })
  if (!link) throw new NotFoundError('Head office link', linkId)
  const c = link.charges
  if (!c || c.tenantId !== link.companyTenantId || !c.isActive || c.type !== 'expense' || c.controlledBy) {
    throw new AppError('CHARGES_ACCOUNT_UNUSABLE', "The company's head office charges account is missing or switched off — re-map it on the head office Books tab", 422)
  }
  return c.code
}

// ─── Re-mapping ──────────────────────────────────────────────────────────────

export interface MappingInput {
  /** HO chart: the recharge account. */
  rechargeAccountId?: string
  /** Company charts: the charges account per LIVE link. */
  charges?: Array<{ companyTenantId: string; accountId: string }>
}

type Acc = { id: string; tenantId: string | null; code: string; name: string; type: string; isActive: boolean; controlledBy: string | null }
const ACC_SELECT = { id: true, tenantId: true, code: true, name: true, type: true, isActive: true, controlledBy: true } as const

async function accountIn(tx: Db, id: string, tenantId: string): Promise<Acc> {
  const acc = await tx.account.findUnique({ where: { id }, select: ACC_SELECT })
  // An account of another chart is "not found" here (company separation).
  if (!acc || acc.tenantId !== tenantId) throw new NotFoundError('Account', id)
  return acc
}

function assertNotReserved(acc: Acc, allowRechargeCode: boolean): void {
  if (allowRechargeCode && acc.code === HO_RECHARGE_CODE) return
  if (ENGINE_CODES.has(acc.code)) {
    throw new AppError('ACCOUNT_RESERVED', `${acc.code} ${acc.name} is an account servd posts to on its own — pick another one`, 422)
  }
}

/**
 * Check a mapping (no writes). Returns the resolved accounts and warnings.
 *   404  an account outside the right chart, or a company with no live link
 *   422 ACCOUNT_RESERVED / ACCOUNT_NOT_USABLE
 */
export async function validateMapping(tx: Db, hoId: string, input: MappingInput): Promise<{
  recharge: Acc | null
  charges: Array<{ linkId: string; companyTenantId: string; account: Acc }>
  warnings: string[]
}> {
  const warnings: string[] = []
  let recharge: Acc | null = null
  if (input.rechargeAccountId) {
    recharge = await accountIn(tx, input.rechargeAccountId, hoId)
    if (!recharge.isActive || recharge.controlledBy || (recharge.type !== 'expense' && recharge.type !== 'revenue')) {
      throw new AppError('ACCOUNT_NOT_USABLE', `${recharge.code} ${recharge.name}: the recharge account must be an active expense or revenue account that no module controls`, 422)
    }
    assertNotReserved(recharge, true)
    if (recharge.type === 'revenue') warnings.push(REVENUE_RECHARGE_WARNING)
  }
  const charges: Array<{ linkId: string; companyTenantId: string; account: Acc }> = []
  const seen = new Set<string>()
  for (const c of input.charges ?? []) {
    if (seen.has(c.companyTenantId)) throw new AppError('DUPLICATE_COMPANY', 'A company appears twice in the mapping', 422)
    seen.add(c.companyTenantId)
    const link = await tx.headOfficeLink.findFirst({ where: { tenantId: hoId, companyTenantId: c.companyTenantId, endedAt: null }, select: { id: true } })
    if (!link) throw new NotFoundError('Head office link', c.companyTenantId)
    const acc = await accountIn(tx, c.accountId, c.companyTenantId)
    if (!acc.isActive || acc.type !== 'expense' || acc.controlledBy) {
      throw new AppError('ACCOUNT_NOT_USABLE', `${acc.code} ${acc.name}: the head office charges account must be an active expense account that no module controls`, 422)
    }
    assertNotReserved(acc, false)
    charges.push({ linkId: link.id, companyTenantId: c.companyTenantId, account: acc })
  }
  return { recharge, charges, warnings }
}

export interface MappingResult extends Invalidation {
  changed: boolean
  before: { rechargeAccountId: string | null; charges: Array<{ companyTenantId: string; accountId: string | null }> }
  after: { rechargeAccountId: string | null; charges: Array<{ companyTenantId: string; accountId: string | null }> }
  warnings: string[]
}

/**
 * PUT /head-offices/:id/books/accounts. Validates, then applies under the books
 * lock; any actual change clears the confirmation and switches recharge OFF in
 * the same transaction. An unchanged mapping changes nothing.
 */
export async function applyMapping(tx: Tx, hoId: string, input: MappingInput, actorId: string): Promise<MappingResult> {
  const books = await lockBooks(tx, hoId)
  const v = await validateMapping(tx, hoId, input)
  const beforeCharges: Array<{ companyTenantId: string; accountId: string | null }> = []
  const afterCharges: Array<{ companyTenantId: string; accountId: string | null }> = []
  let changed = false
  if (v.recharge && v.recharge.id !== books.rechargeAccountId) {
    changed = true
    await tx.headOfficeBooks.update({ where: { tenantId: hoId }, data: { rechargeAccountId: v.recharge.id, updatedById: actorId } })
  }
  for (const c of v.charges) {
    const link = await tx.headOfficeLink.findUnique({ where: { id: c.linkId }, select: { chargesAccountId: true } })
    beforeCharges.push({ companyTenantId: c.companyTenantId, accountId: link?.chargesAccountId ?? null })
    afterCharges.push({ companyTenantId: c.companyTenantId, accountId: c.account.id })
    if (link?.chargesAccountId !== c.account.id) {
      changed = true
      await tx.headOfficeLink.update({ where: { id: c.linkId }, data: { chargesAccountId: c.account.id } })
    }
  }
  const inv: Invalidation = changed
    ? await invalidateConfirmation(tx, hoId, actorId, books)
    : { wasConfirmed: books.accountsConfirmedAt !== null, wasEnabled: books.rechargeEnabled }
  return {
    changed,
    ...inv,
    before: { rechargeAccountId: books.rechargeAccountId, charges: beforeCharges },
    after: { rechargeAccountId: v.recharge?.id ?? books.rechargeAccountId, charges: afterCharges },
    warnings: v.warnings,
  }
}

// ─── HO-Q3: books still on 6990 → 4220 ───────────────────────────────────────

/**
 * Owner HO-Q3 (2026-10-26): the recharge shows as INCOME in the head office's
 * books. Boot step (after ensureChartOfAccounts has added 4220): every head
 * office whose books still map the recharge to its 6990 (the pre-HO-Q3
 * default) is re-mapped to its 4220, with the CA confirmation cleared (the CA
 * confirms what will actually post). Books with recharge ON are left alone and
 * reported — the CEO re-maps those on the Books tab. Nothing is posted and no
 * entry already on 6990 moves. Idempotent: a second run finds nothing.
 */
export async function moveRechargeToIncome(db: PrismaClient = serviceClient): Promise<{ moved: string[]; skippedEnabled: string[] }> {
  const rows = await db.headOfficeBooks.findMany({
    where: { rechargeAccount: { code: LEGACY_HO_RECHARGE_CODE } },
    select: { tenantId: true },
  })
  const moved: string[] = []
  const skippedEnabled: string[] = []
  for (const r of rows) {
    const out = await db.$transaction(async (tx) => {
      const books = await lockBooks(tx, r.tenantId)
      const cur = books.rechargeAccountId
        ? await tx.account.findUnique({ where: { id: books.rechargeAccountId }, select: { code: true } })
        : null
      if (cur?.code !== LEGACY_HO_RECHARGE_CODE) return 'none' as const
      if (books.rechargeEnabled) return 'enabled' as const
      const income = await resolveRechargeAccount(tx, r.tenantId)
      await invalidateConfirmation(tx, r.tenantId, 'system', books)
      await tx.headOfficeBooks.update({ where: { tenantId: r.tenantId }, data: { rechargeAccountId: income.id, updatedById: 'system' } })
      return 'moved' as const
    })
    if (out === 'moved') moved.push(r.tenantId)
    else if (out === 'enabled') skippedEnabled.push(r.tenantId)
  }
  return { moved, skippedEnabled }
}
