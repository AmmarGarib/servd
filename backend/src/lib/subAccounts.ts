// Sub-accounts — a SUB-LEDGER under one account of one company (owner,
// 2026-10-23: "option to create sub account in chart of accounts, e.g in Wages
// there should be option to add subaccount in name of employees to keep wages
// records in the name of employees, and also add option to fetch report/account
// statement with balance of subgroups mentioned under main account").
//
// Entries keep posting to the MAIN account. A sub-account only TAGS an amount of
// a journal line (journal_line_sub_accounts); the line is never changed, so the
// trial balance, the P&L, tax returns and every reader of a code are untouched.
//
// This file is the ONE writer:
//   createSubAccount / updateSubAccount   manual sub-accounts (CHART_EDITORS)
//   ensureEmployeeSubAccountTx            payroll's per-employee buckets (kind 'employee')
//   tagLineTx                             tag a line (validated: same company, same account,
//                                         active, Σ tags of the line ≤ the line's amount)
//   tagEntryByEmployeeTx                  payroll / F&F: per-employee amounts per account code
//   mirrorAllocationsTx                   a reversal mirrors its original's tags (journal.ts)
//   tagPostedManualLinesTx                a manual journal's `subAccountId` per line
//   setSubAccountsEnabled                 the account's "Sub-accounts on" switch
//
// The switch (owner, 2026-10-23: "limited to Wages Expense (HO) account only … switch on sub accounts for
// other head accounts also only in those for which I open subaccount"): `Account.subAccountsEnabled`. Off =
// payroll never tags the account, no new tag is accepted (422 SUB_ACCOUNTS_OFF), the journal picker and the
// statement show none; tags already there stay as history and show again when it is switched back on.
// Opening a sub-account by hand switches its account on.

import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError, NotFoundError } from './errors.js'
import { toCents } from './money.js'

type Db = PrismaClient | Prisma.TransactionClient

export const SUB_ACCOUNT_KINDS = ['manual', 'employee'] as const

// ─── Sub-accounts ────────────────────────────────────────────────────────────

/** The account of THIS company (404 otherwise — never trust a client id). */
async function accountOf(db: Db, tenantIds: string[], accountId: string) {
  const a = await db.account.findFirst({ where: { id: accountId, tenantId: { in: tenantIds } }, select: { id: true, tenantId: true, code: true, name: true, subAccountsEnabled: true } })
  if (!a?.tenantId) throw new NotFoundError('Account', accountId)
  return { ...a, tenantId: a.tenantId }
}

export async function createSubAccount(db: Db, args: { tenantIds: string[]; accountId: string; name: string; code?: string | null; actorId: string }) {
  const acc = await accountOf(db, args.tenantIds, args.accountId)
  try {
    const row = await db.subAccount.create({ data: {
      tenantId: acc.tenantId, accountId: acc.id, name: args.name.trim(), code: args.code?.trim() || null, kind: 'manual', createdById: args.actorId,
    } })
    // Opening a sub-account switches the account's sub-accounts on.
    if (!acc.subAccountsEnabled) await db.account.update({ where: { id: acc.id }, data: { subAccountsEnabled: true } })
    return row
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new AppError('SUB_ACCOUNT_NAME_TAKEN', `"${args.name.trim()}" already exists under ${acc.code}`, 409)
    throw e
  }
}

export async function updateSubAccount(db: Db, args: { tenantIds: string[]; id: string; name?: string; code?: string | null; isActive?: boolean }) {
  const sa = await db.subAccount.findFirst({ where: { id: args.id, tenantId: { in: args.tenantIds } } })
  if (!sa) throw new NotFoundError('SubAccount', args.id)
  if (sa.kind === 'employee' && args.name !== undefined && args.name.trim() !== sa.name) {
    throw new AppError('EMPLOYEE_SUB_ACCOUNT_NAME', 'An employee\'s wages sub-account is named after the employee — rename the employee in HR', 422)
  }
  try {
    const after = await db.subAccount.update({ where: { id: sa.id }, data: {
      ...(args.name !== undefined ? { name: args.name.trim() } : {}),
      ...(args.code !== undefined ? { code: args.code?.trim() || null } : {}),
      ...(args.isActive !== undefined ? { isActive: args.isActive } : {}),
    } })
    return { before: sa, after }
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new AppError('SUB_ACCOUNT_NAME_TAKEN', 'Another sub-account of this account has that name', 409)
    throw e
  }
}

/** The account's "Sub-accounts on" switch. Returns the value before and after. */
export async function setSubAccountsEnabled(db: Db, args: { tenantIds: string[]; accountId: string; enabled: boolean }) {
  const acc = await accountOf(db, args.tenantIds, args.accountId)
  if (acc.subAccountsEnabled !== args.enabled) await db.account.update({ where: { id: acc.id }, data: { subAccountsEnabled: args.enabled } })
  return { account: { id: acc.id, tenantId: acc.tenantId, code: acc.code, name: acc.name }, before: acc.subAccountsEnabled, after: args.enabled }
}

const subAccountsOff = (code: string) =>
  new AppError('SUB_ACCOUNTS_OFF', `Sub-accounts are switched off for account ${code} — switch them on in the chart of accounts first`, 422)

/** The employee's wages bucket under `accountId` (created on first use). */
export async function ensureEmployeeSubAccountTx(
  tx: Db, tenantId: string, accountId: string, employee: { id: string; fullName: string; employeeCode: string | null },
): Promise<string> {
  const found = await tx.subAccount.findUnique({ where: { accountId_employeeId: { accountId, employeeId: employee.id } }, select: { id: true } })
  if (found) return found.id
  const base = employee.employeeCode ? `${employee.fullName} (${employee.employeeCode})` : employee.fullName
  const clash = await tx.subAccount.findFirst({ where: { tenantId, accountId, name: base }, select: { id: true } })
  const name = clash ? `${base} #${employee.id.slice(0, 6)}` : base
  const row = await tx.subAccount.upsert({
    where: { accountId_employeeId: { accountId, employeeId: employee.id } },
    create: { tenantId, accountId, name, kind: 'employee', employeeId: employee.id },
    update: {},
    select: { id: true },
  })
  return row.id
}

// ─── Tags ────────────────────────────────────────────────────────────────────

export interface Allocation { subAccountId: string; amountCents: number }

/**
 * Tag one journal line. The line must be of a company in `tenantIds` (404), every
 * sub-account of the line's account and company (422 SUB_ACCOUNT_NOT_ON_ACCOUNT),
 * active for a new tag (422 SUB_ACCOUNT_INACTIVE), amounts > 0, and the line's
 * tags in total ≤ its amount (422 ALLOCATION_EXCEEDS_LINE). `replace` = these
 * become the line's only tags (an empty list clears them).
 */
export async function tagLineTx(tx: Db, args: {
  tenantIds: string[]; journalLineId: string; allocations: Allocation[]; replace?: boolean; actorId?: string | null
}): Promise<{ tenantId: string; before: Allocation[]; after: Allocation[] }> {
  const line = await tx.journalLine.findFirst({
    where: { id: args.journalLineId, journalEntry: { tenantId: { in: args.tenantIds } } },
    select: { id: true, accountId: true, amountCents: true, account: { select: { code: true, subAccountsEnabled: true } }, journalEntry: { select: { tenantId: true } }, subAccountAllocations: { select: { id: true, subAccountId: true, amountCents: true } } },
  })
  if (!line?.journalEntry.tenantId) throw new NotFoundError('JournalLine', args.journalLineId)
  const tenantId = line.journalEntry.tenantId
  // Clearing is always allowed; a new tag needs the account's sub-accounts on.
  if (args.allocations.length > 0 && !line.account.subAccountsEnabled) throw subAccountsOff(line.account.code)
  const ids = [...new Set(args.allocations.map((a) => a.subAccountId))]
  if (ids.length !== args.allocations.length) throw new AppError('SUB_ACCOUNT_LISTED_TWICE', 'A sub-account is listed twice for one line', 422)
  const subs = ids.length ? await tx.subAccount.findMany({ where: { id: { in: ids } }, select: { id: true, tenantId: true, accountId: true, isActive: true } }) : []
  const byId = new Map(subs.map((s) => [s.id, s]))
  const existing = new Map(line.subAccountAllocations.map((a) => [a.subAccountId, a]))
  for (const a of args.allocations) {
    const s = byId.get(a.subAccountId)
    if (!s || s.tenantId !== tenantId || s.accountId !== line.accountId) {
      throw new AppError('SUB_ACCOUNT_NOT_ON_ACCOUNT', 'A sub-account belongs to another account or company than this line', 422)
    }
    if (!s.isActive && !existing.has(s.id)) throw new AppError('SUB_ACCOUNT_INACTIVE', 'That sub-account is switched off', 422)
    if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) throw new AppError('INVALID_AMOUNT', 'A tag amount must be positive paisa', 422)
  }
  const before = line.subAccountAllocations.map((a) => ({ subAccountId: a.subAccountId, amountCents: toCents(a.amountCents) }))
  const kept = args.replace ? [] : before.filter((b) => !ids.includes(b.subAccountId))
  const after = [...kept, ...args.allocations]
  const total = after.reduce((s, a) => s + a.amountCents, 0)
  if (total > toCents(line.amountCents)) {
    throw new AppError('ALLOCATION_EXCEEDS_LINE', `The sub-account amounts (${total}) exceed the line (${toCents(line.amountCents)})`, 422)
  }
  if (args.replace) await tx.journalLineSubAccount.deleteMany({ where: { journalLineId: line.id } })
  else if (ids.length) await tx.journalLineSubAccount.deleteMany({ where: { journalLineId: line.id, subAccountId: { in: ids } } })
  if (args.allocations.length) {
    await tx.journalLineSubAccount.createMany({ data: args.allocations.map((a) => ({
      tenantId, journalLineId: line.id, subAccountId: a.subAccountId, amountCents: a.amountCents, createdById: args.actorId ?? null,
    })) })
  }
  return { tenantId, before, after }
}

/**
 * Payroll / F&F: tag an entry's lines per employee. `perCode` = account code →
 * employee → paisa. A line is tagged only when it is the ONLY line on its
 * account with that side, has no tags yet, and the employees' amounts are all
 * positive and add up to EXACTLY the line (else it is reported in `mismatched`
 * and left alone). Idempotent.
 */
export async function tagEntryByEmployeeTx(
  tx: Db, tenantId: string, entryId: string,
  perCode: Map<string, { type: 'debit' | 'credit'; byEmployee: Map<string, number> }>,
): Promise<{ tagged: string[]; mismatched: string[] }> {
  const lines = await tx.journalLine.findMany({
    where: { journalEntryId: entryId, journalEntry: { tenantId } },
    select: { id: true, accountId: true, type: true, amountCents: true, account: { select: { code: true, subAccountsEnabled: true } }, _count: { select: { subAccountAllocations: true } } },
  })
  const tagged: string[] = []
  const mismatched: string[] = []
  const empIds = [...new Set([...perCode.values()].flatMap((v) => [...v.byEmployee.keys()]))]
  const emps = empIds.length ? await tx.hrEmployee.findMany({ where: { id: { in: empIds }, tenantId }, select: { id: true, fullName: true, employeeCode: true } }) : []
  const empOf = new Map(emps.map((e) => [e.id, e]))
  for (const [code, spec] of perCode) {
    const parts = [...spec.byEmployee.entries()].filter(([, c]) => c !== 0)
    if (parts.length === 0) continue
    const on = lines.filter((l) => l.account.code === code && l.type === spec.type)
    // An account whose sub-accounts are off is never tagged (and is not a mismatch).
    if (on.length > 0 && on.every((l) => !l.account.subAccountsEnabled)) continue
    if (on.length !== 1) { mismatched.push(code); continue }
    const line = on[0]!
    if (line._count.subAccountAllocations > 0) continue
    const sum = parts.reduce((s, [, c]) => s + c, 0)
    if (parts.some(([, c]) => c < 0) || sum !== toCents(line.amountCents) || parts.some(([e]) => !empOf.has(e))) { mismatched.push(code); continue }
    const data = []
    for (const [empId, cents] of parts) {
      const subAccountId = await ensureEmployeeSubAccountTx(tx, tenantId, line.accountId, empOf.get(empId)!)
      data.push({ tenantId, journalLineId: line.id, subAccountId, amountCents: cents })
    }
    await tx.journalLineSubAccount.createMany({ data, skipDuplicates: true })
    tagged.push(code)
  }
  return { tagged, mismatched }
}

const lineKey = (l: { accountId: string; amountCents: bigint | number; conceptId: string | null }) => `${l.accountId}|${toCents(l.amountCents)}|${l.conceptId ?? ''}`

/** A reversal carries its original's tags (each original line ↔ its flipped line). Idempotent. */
export async function mirrorAllocationsTx(tx: Db, originalEntryId: string, reversalEntryId: string): Promise<number> {
  const orig = await tx.journalLine.findMany({
    where: { journalEntryId: originalEntryId, subAccountAllocations: { some: {} } },
    select: { accountId: true, amountCents: true, conceptId: true, type: true, subAccountAllocations: { select: { tenantId: true, subAccountId: true, amountCents: true } } },
  })
  if (orig.length === 0) return 0
  const rev = await tx.journalLine.findMany({
    where: { journalEntryId: reversalEntryId },
    select: { id: true, accountId: true, amountCents: true, conceptId: true, type: true, _count: { select: { subAccountAllocations: true } } },
  })
  const free = [...rev]
  let n = 0
  for (const o of orig) {
    const i = free.findIndex((r) => lineKey(r) === lineKey(o) && r.type !== o.type)
    if (i < 0) continue
    const r = free.splice(i, 1)[0]!
    if (r._count.subAccountAllocations > 0) continue
    await tx.journalLineSubAccount.createMany({
      data: o.subAccountAllocations.map((a) => ({ tenantId: a.tenantId, journalLineId: r.id, subAccountId: a.subAccountId, amountCents: toCents(a.amountCents) })),
      skipDuplicates: true,
    })
    n += o.subAccountAllocations.length
  }
  return n
}

/**
 * A manual journal's lines that name a sub-account (`subAccountId`) are tagged
 * for their whole amount once posted: each input line ↔ a posted line with the
 * same account, side, amount and brand. Validated by tagLineTx.
 */
export async function tagPostedManualLinesTx(tx: Db, args: {
  tenantId: string; entryId: string; actorId: string
  lines: ReadonlyArray<{ accountId: string; type: string; amountCents: number; conceptId?: string | null; subAccountId?: string | null }>
}): Promise<void> {
  const wanted = args.lines.filter((l) => l.subAccountId)
  if (wanted.length === 0) return
  const posted = await tx.journalLine.findMany({ where: { journalEntryId: args.entryId }, select: { id: true, accountId: true, type: true, amountCents: true, conceptId: true } })
  const free = [...posted]
  for (const l of wanted) {
    const i = free.findIndex((p) => p.accountId === l.accountId && p.type === l.type && toCents(p.amountCents) === l.amountCents && (p.conceptId ?? null) === (l.conceptId ?? null))
    if (i < 0) continue
    const p = free.splice(i, 1)[0]!
    await tagLineTx(tx, { tenantIds: [args.tenantId], journalLineId: p.id, allocations: [{ subAccountId: l.subAccountId!, amountCents: l.amountCents }], replace: true, actorId: args.actorId })
  }
}

/** Validate a manual journal's sub-account names before posting (422 SUB_ACCOUNT_NOT_ON_ACCOUNT / SUB_ACCOUNT_INACTIVE). */
export async function assertManualSubAccounts(db: Db, tenantId: string, lines: ReadonlyArray<{ accountId: string; subAccountId?: string | null }>): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.subAccountId).filter((x): x is string => !!x))]
  if (ids.length === 0) return
  const subs = await db.subAccount.findMany({ where: { id: { in: ids } }, select: { id: true, tenantId: true, accountId: true, isActive: true, account: { select: { code: true, subAccountsEnabled: true } } } })
  const byId = new Map(subs.map((s) => [s.id, s]))
  for (const l of lines) {
    if (!l.subAccountId) continue
    const s = byId.get(l.subAccountId)
    if (!s || s.tenantId !== tenantId || s.accountId !== l.accountId) throw new AppError('SUB_ACCOUNT_NOT_ON_ACCOUNT', 'A line names a sub-account of another account or company', 422)
    if (!s.account.subAccountsEnabled) throw subAccountsOff(s.account.code)
    if (!s.isActive) throw new AppError('SUB_ACCOUNT_INACTIVE', 'A line names a switched-off sub-account', 422)
  }
}
