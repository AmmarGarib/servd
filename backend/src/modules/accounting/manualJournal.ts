// Manual journals — the ONE path that posts and reverses a hand-made entry.
//
// Extracted unchanged from `POST /accounting/journal` and
// `POST /accounting/journal/:id/reverse` (routes.ts) so the CEO's direct
// routes and the journal requests Finance prepares (journalRequests.ts) post
// exactly the same entry, with the same checks, messages, audit rows and
// `manual_journal` exception.
//
//   postManualJournal     validate the lines in the company's chart, post
//                         `manual:<sourceId>` through postJournalEntry, audit
//                         `journal.manual` (+ `journal.register_override`),
//                         flag `manual_journal` (+ `fixed_asset_gl_mismatch`)
//   reverseManualJournal  reverse one `manual:` entry once (advisory lock), as
//                         `manual.reversal:<sourceId>`; audit `journal.reverse`,
//                         flag `manual_journal`
//   assertManualLines     the line checks alone (balanced, accounts in the
//                         company and active, brands of the company)
//   assertReversible      the reversal checks that need no lock
//
// Inside a transaction (db is a TransactionClient) the audit rows and flags are
// NOT written — the caller runs `sideEffects()` after the commit, so a rolled-back
// approval never leaves a flag behind. On the base client they run at once.
//
// The company is always the caller's to resolve (the operator's active company
// for a direct post, the request's own company for a journal request, the
// entry's own company for a reversal); nothing here reads the request.

import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { toCents, zMoneyCents } from '../../lib/money.js'
import { postJournalEntry, reverseJournalEntry } from './journal.js'
import { assertManualSubAccounts, tagLineTx, tagPostedManualLinesTx } from '../../lib/subAccounts.js'
import { fmtPktDate } from './dates.js'

type Db = PrismaClient | Prisma.TransactionClient

/** Who posts, edits and cancels manual entries: the CEO and finance with the accounting module (routes.ts JOURNAL_POSTERS). */
export const MANUAL_JOURNAL_POSTERS = ['admin', 'finance'] as const

// Manual journal entries carry `manual:<uuid>`; their reversal (posted by
// reverseJournalEntry) carries `manual.reversal:<uuid>`.
export const MANUAL_PREFIX = 'manual:'
export const MANUAL_REVERSAL_PREFIX = 'manual.reversal:'

/** One line of a manual journal, as the client sends it (accounts by id). */
export const manualLineSchema = z.object({
  accountId: z.string().uuid(),
  type: z.enum(['debit', 'credit']),
  // One line ≤ MAX_MONEY_CENTS (PKR 900bn), else 422 AMOUNT_TOO_LARGE.
  amountCents: zMoneyCents('A journal line', { sign: 'positive' }),
  memo: z.string().optional(),
  // Optional brand attribution, so a manual adjustment can land on one
  // brand's P&L instead of the shared bucket.
  conceptId: z.string().uuid().nullable().optional(),
  // Optional sub-account of the line's account (lib/subAccounts.ts, owner 2026-10-23): the whole line is tagged to it.
  // A reporting tag only — the line still posts to its account.
  subAccountId: z.string().uuid().nullable().optional(),
})
export type ManualJournalLine = z.infer<typeof manualLineSchema>

export const journalEntrySchema = z.object({
  reference: z.string().optional(),
  description: z.string().min(1),
  entryDate: z.string().datetime().optional(),
  lines: z.array(manualLineSchema).min(2),
  // A line on a fixed-asset register account (1500–1599, 2012) needs the
  // CEO's reason; the entry is then audited and flagged
  // fixed_asset_gl_mismatch so the register tie-out explains it. The reason's
  // length is checked by the posting engine (422 REGISTER_CONTROLLED_ACCOUNT).
  registerOverride: z.object({ reason: z.string().trim().max(500) }).optional(),
})

export const reverseSchema = z.object({
  reason: z.string().trim().min(5).max(500),
  // Date of the reversing entry; defaults to now. The original may sit in a
  // closed month — the reversal is dated in the open period.
  entryDate: z.string().datetime().optional(),
})

/** Who did it, for the audit rows and the exception text. */
export interface ManualActor {
  id: string
  email?: string | null
  ip?: string | null
}

const isTx = (db: Db): db is Prisma.TransactionClient => !('$transaction' in db)

function totals(lines: ReadonlyArray<Pick<ManualJournalLine, 'type' | 'amountCents'>>) {
  const debits = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
  const credits = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
  return { debits, credits }
}

/** 422 UNBALANCED_ENTRY unless debits = credits (the direct route's first check). */
export function assertBalanced(lines: ReadonlyArray<Pick<ManualJournalLine, 'type' | 'amountCents'>>): { debits: number; credits: number } {
  const t = totals(lines)
  if (t.debits !== t.credits) {
    throw new AppError('UNBALANCED_ENTRY', `Debits (${t.debits}) must equal credits (${t.credits})`, 422)
  }
  return t
}

/**
 * The direct route's line checks, in its order: balanced; every account of
 * THIS company (422 ACCOUNT_NOT_IN_COMPANY) and active (422 ACCOUNT_INACTIVE);
 * every brand of this company (422 BRAND_NOT_IN_COMPANY). Returns the account
 * code of each account id (the posting engine takes codes).
 */
export async function assertManualLines(
  db: Db,
  tenantId: string,
  lines: readonly ManualJournalLine[],
): Promise<{ debits: number; credits: number; codeOf: Map<string, string> }> {
  const { debits, credits } = assertBalanced(lines)

  // The client names accounts by id; the posting engine takes codes, which
  // it resolves again inside this company's chart.
  const accountIds = Array.from(new Set(lines.map((l) => l.accountId)))
  const accounts = await db.account.findMany({
    where: { id: { in: accountIds }, tenantId },
    select: { id: true, code: true, isActive: true },
  })
  if (accounts.length !== accountIds.length) {
    throw new AppError('ACCOUNT_NOT_IN_COMPANY', 'One or more accounts belong to another company', 422)
  }
  const inactive = accounts.filter((a) => !a.isActive).map((a) => a.code)
  if (inactive.length > 0) {
    throw new AppError('ACCOUNT_INACTIVE', `Account(s) ${inactive.join(', ')} are deactivated — reactivate them in Configuration → Chart of accounts first`, 422)
  }
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]))

  // Brand attribution per line, optional. A brand must belong to the company
  // whose books this is.
  const conceptIds = Array.from(new Set(lines.map((l) => l.conceptId).filter((c): c is string => !!c)))
  if (conceptIds.length > 0) {
    const ownBrands = await db.concept.count({ where: { id: { in: conceptIds }, tenantId, deletedAt: null } })
    if (ownBrands !== conceptIds.length) {
      throw new AppError('BRAND_NOT_IN_COMPANY', 'A line names a brand that is not one of this company\'s brands', 422)
    }
  }
  // A sub-account named on a line is of that line's account, this company, and switched on.
  await assertManualSubAccounts(db, tenantId, lines)
  return { debits, credits, codeOf }
}

// ─── Post ────────────────────────────────────────────────────────────────────

export interface PostManualJournalInput {
  /** The company whose books this is (resolved by the caller). */
  tenantId: string
  description: string
  /** The operator's own reference — travels in the description, never the idempotency key. */
  reference?: string | null
  entryDate?: Date | string | null
  lines: ManualJournalLine[]
  /** User id stamped on the entry. */
  postedBy: string
  /** `manual:<sourceId>`; default a fresh uuid. A journal request passes its own id. */
  sourceId?: string
  /** CEO only (the direct route): a reason that opens a fixed-asset register account. */
  registerOverride?: { reason: string } | null
  /** For the audit rows and exception text; default { id: postedBy }. */
  actor?: ManualActor
  /** Extra audit metadata (a journal request adds its id and preparers). */
  metadata?: Record<string, unknown>
  /** Appended to the manual_journal exception's description. */
  flagNote?: string
}

export type ManualEntry = Prisma.JournalEntryGetPayload<{ include: { lines: { include: { account: true } } } }>

export interface PostManualJournalResult {
  entry: ManualEntry
  debits: number
  credits: number
  /** Audit + exceptions. Already run on the base client; the caller runs it after commit inside a transaction. */
  sideEffects: () => Promise<void>
}

/**
 * Post a manual journal (`manual:<sourceId>`) exactly as `POST /accounting/journal`
 * always has. Refusals (422): UNBALANCED_ENTRY, ACCOUNT_NOT_IN_COMPANY,
 * ACCOUNT_INACTIVE, BRAND_NOT_IN_COMPANY, and the engine's PERIOD_LOCKED,
 * REGISTER_CONTROLLED_ACCOUNT, INTERCOMPANY_ACCOUNT_CONTROLLED, AMOUNT_TOO_LARGE.
 */
export async function postManualJournal(db: Db, input: PostManualJournalInput): Promise<PostManualJournalResult> {
  // Lines tagged to a sub-account: the posting and its tags commit together.
  if (!isTx(db) && input.lines.some((l) => l.subAccountId)) {
    const r = await (db as PrismaClient).$transaction((tx) => postManualJournal(tx, input))
    await r.sideEffects()
    return r
  }
  const { tenantId } = input
  if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — the ledger is per company', 422)
  const { debits, credits, codeOf } = await assertManualLines(db, tenantId, input.lines)

  const reference = input.reference?.trim() || null
  const registerReason = input.registerOverride?.reason?.trim() || null
  const actor: ManualActor = input.actor ?? { id: input.postedBy }
  const posted = await postJournalEntry({
    ...(registerReason ? { controlledOverride: { reason: registerReason } } : {}),
    tenantId,
    sourceType: 'manual',
    sourceId: input.sourceId ?? randomUUID(),
    // JournalEntry.reference holds the idempotency key, so the operator's
    // own reference travels in the description (and the audit metadata).
    description: reference ? `${input.description} · ref ${reference}` : input.description,
    entryDate: input.entryDate ? new Date(input.entryDate) : new Date(),
    postedBy: input.postedBy,
    lines: input.lines.map((l) => ({
      accountCode: codeOf.get(l.accountId)!,
      type: l.type,
      amountCents: l.amountCents,
      memo: l.memo,
      conceptId: l.conceptId ?? null,
    })),
  }, isTx(db) ? { tx: db } : {})
  if (!posted.posted) {
    // `manual:<id>` already in the books — never post a second time, never
    // pretend this call posted it.
    throw new AppError('ALREADY_POSTED', 'This journal is already in the books.', 409)
  }

  await tagPostedManualLinesTx(db, { tenantId, entryId: posted.entryId, actorId: input.postedBy, lines: input.lines })
  const entry = await db.journalEntry.findUniqueOrThrow({
    where: { id: posted.entryId },
    include: { lines: { include: { account: true } } },
  })

  const sideEffects = async () => {
    await audit({ category: 'accounting',
      action: 'journal.manual',
      entity: 'JournalEntry',
      entityId: entry.id,
      userId: actor.id, tenantId,
      userEmail: actor.email ?? null,
      after: entry,
      metadata: { ip: actor.ip ?? null, debits, credits, reference, ...(input.metadata ?? {}) },
    })
    // A register account posted to by hand (the engine let it through only
    // with the reason): on the trail and in the inbox, so the register's
    // tie-out explains the difference.
    const registerLines = entry.lines.filter((l) => l.account.controlledBy === 'fixed_asset')
    const { flagException } = await import('../../lib/exceptions.js')
    if (registerReason && registerLines.length > 0) {
      const codes = Array.from(new Set(registerLines.map((l) => l.account.code))).sort()
      const registerCents = registerLines.reduce((s, l) => s + toCents(l.amountCents), 0)
      await audit({ category: 'accounting',
        action: 'journal.register_override',
        entity: 'JournalEntry',
        entityId: entry.id,
        userId: actor.id, tenantId,
        userEmail: actor.email ?? null,
        after: { codes, amountCents: registerCents },
        metadata: { ip: actor.ip ?? null, reason: registerReason, reference },
      })
      await flagException({
        tenantId,
        kind: 'fixed_asset_gl_mismatch',
        severity: 'high',
        title: `Fixed-asset account${codes.length === 1 ? '' : 's'} ${codes.join(', ')} posted to by hand`,
        description: `${actor.email ?? actor.id} posted a manual journal to the fixed-asset register's account${codes.length === 1 ? '' : 's'} (${codes.join(', ')}) for PKR ${(registerCents / 100).toFixed(0)}. `
          + `Reason: ${registerReason}. The register no longer ties to the ledger by this amount until it is matched by a register event or reversed.`,
        entityType: 'JournalEntry',
        entityId: entry.id,
        actorId: actor.id,
        amountCents: registerCents,
        metadata: { codes, reason: registerReason, reference },
      })
    }

    // Every manual JE is a high-trust action. The system fires a flag for
    // owner review — not because it's wrong, but because every single one
    // should have eyes on it. The resolution note is the owner's audit trail.
    await flagException({
      tenantId,
      kind: 'manual_journal',
      severity: debits >= 100000 ? 'high' : 'medium',           // PKR 1,000+ = high
      title: `Manual journal entry posted: ${input.description}`,
      description: `${actor.email ?? actor.id} posted a manual JE for PKR ${(debits / 100).toFixed(0)}. Reference: ${reference ?? 'none'}.${input.flagNote ? ` ${input.flagNote}` : ''}`,
      entityType: 'JournalEntry',
      entityId: entry.id,
      actorId: actor.id,
      amountCents: debits,
      metadata: { reference, debits, credits, lineCount: input.lines.length, ip: actor.ip ?? null, ...(input.metadata ?? {}) },
    })
  }

  let ran = false
  const once = async () => { if (ran) return; ran = true; await sideEffects() }
  if (!isTx(db)) await once()
  return { entry, debits, credits, sideEffects: once }
}

// ─── Reverse ─────────────────────────────────────────────────────────────────

type OriginalEntry = Prisma.JournalEntryGetPayload<{
  include: { lines: { include: { account: { select: { code: true; name: true; isActive: true; controlledBy: true } } } } }
}>

/**
 * A manual entry that resolves a cash voucher held on 1357 ("Resolved by
 * journal entry", trustops/voucherHoldResolve.ts) is that voucher's booking:
 * reversing or editing it would reopen 1357 under a voucher marked done. 409
 * ENTRY_RESOLVES_VOUCHER — a later correction is another manual entry.
 */
async function assertNotResolvingVoucher(db: Db, entryId: string): Promise<void> {
  const v = await db.cashVoucher.findFirst({ where: { postedJournalEntryId: entryId }, select: { number: true } })
  if (v) {
    throw new AppError('ENTRY_RESOLVES_VOUCHER', `This entry resolves cash voucher ${v.number} (held on 1357) — it cannot be reversed or edited; post a further manual entry to correct it.`, 409)
  }
}

/**
 * The reversal checks that need no lock, on the entry of THIS company
 * (404 when it is not one): a `manual:` entry (422 NOT_A_MANUAL_ENTRY), every
 * account active (422 ACCOUNT_INACTIVE), not linked as a tax payment
 * (409 TAX_PAYMENT_LINKED). `checkAlready` also refuses one already reversed
 * (409 ALREADY_REVERSED) — a journal request checks it when it is prepared;
 * the posting re-checks it under the lock.
 */
export async function assertReversible(
  db: Db,
  tenantId: string,
  entryId: string,
  opts: { checkAlready?: boolean } = {},
): Promise<{ original: OriginalEntry; sourceId: string; reversalRef: string; amountCents: number }> {
  const original = await db.journalEntry.findFirst({
    where: { id: entryId, tenantId },
    include: { lines: { include: { account: { select: { code: true, name: true, isActive: true, controlledBy: true } } } } },
  })
  if (!original || !original.tenantId) throw new NotFoundError('JournalEntry', entryId)
  if (!original.reference?.startsWith(MANUAL_PREFIX)) {
    throw new AppError(
      'NOT_A_MANUAL_ENTRY',
      original.reference?.startsWith(MANUAL_REVERSAL_PREFIX)
        ? 'This entry is itself a reversal — post a new manual entry instead of reversing it.'
        : 'Only manual journal entries can be reversed here. This entry was posted by its source document — correct it there (refund the order, void the bill, …).',
      422,
    )
  }
  const inactive = Array.from(new Set(original.lines.filter((l) => !l.account.isActive).map((l) => l.account.code)))
  if (inactive.length > 0) {
    throw new AppError('ACCOUNT_INACTIVE', `Account(s) ${inactive.join(', ')} are deactivated — reactivate them in Configuration → Chart of accounts first`, 422)
  }
  // A manual entry linked to the sales-tax return as a tax payment is that
  // payment: reversing it underneath the link would leave the return
  // counting a payment that no longer exists (and its reversal as output).
  const linkedPayment = await db.salesTaxPayment.findFirst({
    where: { tenantId, journalEntryId: original.id, linked: true },
    select: { id: true },
  })
  if (linkedPayment) {
    throw new AppError('TAX_PAYMENT_LINKED', 'This entry is linked to the sales-tax return as a tax payment — unlink it there first, then reverse it.', 409)
  }
  await assertNotResolvingVoucher(db, original.id)
  const sourceId = original.reference.slice(MANUAL_PREFIX.length)
  const reversalRef = `${MANUAL_REVERSAL_PREFIX}${sourceId}`
  if (opts.checkAlready) {
    const already = await db.journalEntry.findFirst({ where: { tenantId, reference: reversalRef }, select: { id: true, entryDate: true } })
    if (already) {
      throw new AppError('ALREADY_REVERSED', `This entry was already reversed on ${fmtPktDate(already.entryDate)} (entry ${already.id.slice(0, 8)}).`, 409)
    }
  }
  const amountCents = original.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + toCents(l.amountCents), 0)
  return { original, sourceId, reversalRef, amountCents }
}

export interface ReverseManualJournalInput {
  /** The entry's own company (resolved by the caller from the entry or the request). */
  tenantId: string
  entryId: string
  reason: string
  actorId: string
  entryDate?: Date | string | null
  actor?: Omit<ManualActor, 'id'>
  metadata?: Record<string, unknown>
}

export interface ReverseManualJournalResult {
  reversal: ManualEntry
  original: OriginalEntry
  amountCents: number
  sideEffects: () => Promise<void>
}

/**
 * Reverse a manual entry once, exactly as `POST /accounting/journal/:id/reverse`
 * always has: every line flipped as `manual.reversal:<sourceId>`, one reversal
 * per entry under an advisory lock (409 ALREADY_REVERSED), a register entry's
 * reversal carries the reason as its override. On the base client it opens its
 * own transaction; inside one it uses it.
 */
export async function reverseManualJournal(db: Db, input: ReverseManualJournalInput): Promise<ReverseManualJournalResult> {
  const { tenantId, reason } = input
  const { original, sourceId, reversalRef } = await assertReversible(db, tenantId, input.entryId)
  // A manual entry the CEO posted to the fixed-asset register's accounts
  // (registerOverride) is undone the same way: its reversal touches those
  // accounts too, so it carries the reason as its override (the journal's
  // controlled-account rule — a reason too short is refused there, 422).
  const registerLines = original.lines.filter((l) => l.account.controlledBy === 'fixed_asset')

  const run = async (tx: Prisma.TransactionClient) => {
    // The entry's change lock (text edits, change requests, approvals take it too), then one reversal per
    // entry, even under a double click.
    await lockEntryChangeTx(tx, tenantId, original.id)
    // An edit / cancellation waiting for the CEO is decided first (a decision of it has already left 'submitted').
    const open = await openChangeRequestOf(tx, tenantId, original.id)
    if (open) throw changePending(open)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`journal.reverse:${tenantId}:${original.reference}`}))`
    const already = await tx.journalEntry.findFirst({ where: { tenantId, reference: reversalRef }, select: { id: true, entryDate: true } })
    if (already) {
      throw new AppError('ALREADY_REVERSED', `This entry was already reversed on ${fmtPktDate(already.entryDate)} (entry ${already.id.slice(0, 8)}).`, 409)
    }
    // Re-checked under the lock a resolve takes too (trustops/voucherHoldResolve.ts).
    await assertNotResolvingVoucher(tx, original.id)
    return reverseJournalEntry(tenantId, 'manual', sourceId, reason, {
      tx,
      postedBy: input.actorId,
      entryDate: input.entryDate ? new Date(input.entryDate) : new Date(),
      ...(registerLines.length > 0 ? { controlledOverride: { reason } } : {}),
    })
  }
  const result = isTx(db) ? await run(db) : await (db as PrismaClient).$transaction((tx) => run(tx))
  if (!result.posted) {
    throw new AppError('ALREADY_REVERSED', 'This entry was already reversed.', 409)
  }

  const reversal = await db.journalEntry.findUniqueOrThrow({
    where: { id: result.entryId },
    include: { lines: { include: { account: true } } },
  })
  const amountCents = reversal.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + toCents(l.amountCents), 0)
  const email = input.actor?.email ?? null
  const ip = input.actor?.ip ?? null

  const sideEffects = async () => {
    await audit({ category: 'accounting',
      action: 'journal.reverse',
      entity: 'JournalEntry',
      entityId: reversal.id,
      // The books this touched — the entry's company, which may not be the
      // operator's active one.
      userId: input.actorId, tenantId,
      userEmail: email,
      before: original,
      after: reversal,
      metadata: { ip, reason, reversedEntryId: original.id, amountCents, ...(input.metadata ?? {}) },
    })
    if (registerLines.length > 0) {
      const codes = Array.from(new Set(registerLines.map((l) => l.account.code))).sort()
      const registerCents = registerLines.reduce((t, l) => t + toCents(l.amountCents), 0)
      await audit({ category: 'accounting',
        action: 'journal.register_override',
        entity: 'JournalEntry',
        entityId: reversal.id,
        userId: input.actorId, tenantId,
        userEmail: email,
        after: { codes, amountCents: registerCents, reverses: original.id },
        metadata: { ip, reason },
      })
      // The hand entry the register did not know about is gone: its open
      // fixed_asset_gl_mismatch flag is closed by the reversal.
      await defaultPrisma.exceptionFlag.updateMany({
        where: { tenantId, kind: 'fixed_asset_gl_mismatch', entityType: 'JournalEntry', entityId: original.id, status: { in: ['open', 'acknowledged'] } },
        data: { status: 'resolved', resolvedAt: new Date(), resolution: `Reversed by entry ${reversal.id.slice(0, 8)}: ${reason}`.slice(0, 500) },
      })
    }
    const { flagException } = await import('../../lib/exceptions.js')
    await flagException({
      tenantId,
      kind: 'manual_journal',
      severity: amountCents >= 100000 ? 'high' : 'medium',
      title: `Manual journal entry reversed: ${original.description}`,
      description: `${email ?? input.actorId} reversed a manual JE of PKR ${(amountCents / 100).toFixed(0)}. Reason: ${reason}.`,
      entityType: 'JournalEntry',
      entityId: reversal.id,
      actorId: input.actorId,
      amountCents,
      metadata: { reversedEntryId: original.id, reason, ip, amountCents, ...(input.metadata ?? {}) },
    })
  }

  let ran = false
  const once = async () => { if (ran) return; ran = true; await sideEffects() }
  if (!isTx(db)) await once()
  return { reversal, original, amountCents, sideEffects: once }
}

// ─── Journals tab (owner, 2026-10-23) ────────────────────────────────────────
//
// "option to edit/cancel/void any back dated or current Journal manual entry
// with final approval of CEO … CEO approve edits only when amount is edited,
// not for editing details/particulars/Memo."
//
//   • TEXT edits (description, the operator's reference, line memos) change the
//     entry IN PLACE at once — textEditManualJournal. Nothing posts.
//   • MONEY edits (an amount, account, brand, the date, lines added / removed)
//     and cancels go through amendManualJournal / reverseManualJournal — at once
//     for the CEO, after the CEO's approval for anyone else (journalRequests.ts
//     kinds 'amend' / 'reverse').

/** The entry's change lock: text edits, change requests, approvals and reversals serialise on it. */
export async function lockEntryChangeTx(tx: Prisma.TransactionClient, tenantId: string, entryId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`journal.change:${tenantId}:${entryId}`}))`
}

const REF_SEP = ' · ref '

/** A manual entry stores the operator's reference inside its description ("<text> · ref <ref>"). */
export function splitDescription(stored: string): { description: string; reference: string | null } {
  const at = stored.lastIndexOf(REF_SEP)
  if (at < 0) return { description: stored, reference: null }
  return { description: stored.slice(0, at), reference: stored.slice(at + REF_SEP.length) || null }
}
export function composeDescription(description: string, reference: string | null | undefined): string {
  const ref = reference?.trim() || null
  return ref ? `${description}${REF_SEP}${ref}` : description
}

type FingerprintEntry = {
  id: string; description: string; entryDate: Date
  lines: Array<{ id: string; accountId: string; type: string; amountCents: bigint | number; conceptId: string | null; memo: string | null }>
}
/** A hash of everything a change request was raised against (text and money); a mismatch at approval = ENTRY_CHANGED. */
export function entryFingerprint(e: FingerprintEntry): string {
  const lines = [...e.lines].sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((l) => [l.id, l.accountId, l.type, toCents(l.amountCents), l.conceptId ?? null, l.memo ?? null])
  return createHash('sha256').update(JSON.stringify([e.id, e.description, e.entryDate.toISOString(), lines])).digest('hex')
}

/** The money shape of a line: what a money edit changes. */
const shapeKey = (l: { accountId: string; type: string; amountCents: number; conceptId?: string | null }) =>
  `${l.accountId}|${l.type}|${l.amountCents}|${l.conceptId ?? ''}`

/**
 * Does `proposed` change only text? Same date (the same Karachi day; a missing
 * date = unchanged) and the same lines by money shape (account, side, amount,
 * brand), in any order. Returns the memo of each original line id when so, else null.
 */
export function textOnlyMapping(
  original: { entryDate: Date; lines: Array<{ id: string; accountId: string; type: string; amountCents: bigint | number; conceptId: string | null }> },
  proposed: { entryDate?: string | Date | null; lines: ManualJournalLine[] },
): Map<string, { memo: string | null; subAccountId?: string | null }> | null {
  if (proposed.entryDate && fmtPktDate(new Date(proposed.entryDate)) !== fmtPktDate(original.entryDate)) return null
  if (proposed.lines.length !== original.lines.length) return null
  const free = original.lines.map((l) => ({ id: l.id, key: shapeKey({ ...l, amountCents: toCents(l.amountCents) }) }))
  const memos = new Map<string, { memo: string | null; subAccountId?: string | null }>()
  for (const p of proposed.lines) {
    const i = free.findIndex((f) => f.key === shapeKey(p))
    if (i < 0) return null
    memos.set(free[i]!.id, { memo: p.memo?.trim() || null, ...(p.subAccountId !== undefined ? { subAccountId: p.subAccountId } : {}) })
    free.splice(i, 1)
  }
  return memos
}

/** Lines on an account only its own module posts to: refused up front for a request (the CEO alone overrides the register). */
export async function assertNoControlledLines(db: Db, tenantId: string, lines: readonly ManualJournalLine[]): Promise<void> {
  const ctl = await db.account.findMany({
    where: { tenantId, id: { in: [...new Set(lines.map((l) => l.accountId))] }, controlledBy: { not: null } },
    select: { code: true, name: true, controlledBy: true },
  })
  const c = ctl[0]
  if (!c) return
  if (c.controlledBy === 'fixed_asset') {
    throw new AppError('REGISTER_CONTROLLED_ACCOUNT', `Account ${c.code} '${c.name}' is kept by the fixed-asset register — record this through Fixed assets or CapEx; only the CEO may post there by hand.`, 422)
  }
  throw new AppError('INTERCOMPANY_ACCOUNT_CONTROLLED', `Account ${c.code} '${c.name}' is controlled by its own module — only that module posts to it.`, 422)
}

/** The reversal half of an edit is dated on the ORIGINAL's day — today only when that day is in a closed month. */
export async function editReversalDate(db: Db, tenantId: string, originalDate: Date): Promise<Date> {
  const lock = await db.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
  return lock && originalDate <= lock.lockedThrough ? new Date() : originalDate
}

export interface AmendManualJournalInput {
  tenantId: string
  entryId: string
  reason: string
  description: string
  reference?: string | null
  entryDate?: Date | string | null
  lines: ManualJournalLine[]
  actorId: string
  actor?: Omit<ManualActor, 'id'>
  registerOverride?: { reason: string } | null
  /** `manual:<sourceId>` of the corrected entry (a change request passes its own id). */
  sourceId?: string
  metadata?: Record<string, unknown>
}

/**
 * EDIT = reverse the original (dated on its own day, editReversalDate) + post
 * the corrected entry in the ORIGINAL's company, in the caller's transaction —
 * exactly what POST /accounting/journal/:id/amend has always done. Used by the
 * CEO's direct edit and by the CEO's approval of a finance edit request.
 */
export async function amendManualJournal(tx: Prisma.TransactionClient, input: AmendManualJournalInput) {
  const found = await tx.journalEntry.findFirst({ where: { id: input.entryId, tenantId: input.tenantId }, select: { entryDate: true } })
  if (!found) throw new NotFoundError('JournalEntry', input.entryId)
  const reversalDate = await editReversalDate(tx, input.tenantId, found.entryDate)
  const rev = await reverseManualJournal(tx, {
    tenantId: input.tenantId, entryId: input.entryId, reason: `Edited: ${input.reason}`, actorId: input.actorId,
    entryDate: reversalDate, actor: input.actor, metadata: input.metadata,
  })
  const posted = await postManualJournal(tx, {
    tenantId: input.tenantId,
    description: input.description,
    reference: input.reference,
    entryDate: input.entryDate,
    lines: input.lines,
    postedBy: input.actorId,
    registerOverride: input.registerOverride ?? null,
    actor: { id: input.actorId, email: input.actor?.email ?? null, ip: input.actor?.ip ?? null },
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    metadata: { ...(input.metadata ?? {}), replacesEntryId: input.entryId },
  })
  return { reversal: rev.reversal, original: rev.original, entry: posted.entry, reversedFx: rev.sideEffects, postedFx: posted.sideEffects }
}

/** Is this live manual entry reversed? (`manual.reversal:<sourceId>` exists.) */
export async function manualReversalOf(db: Db, tenantId: string, reference: string): Promise<{ id: string; entryDate: Date } | null> {
  if (!reference.startsWith(MANUAL_PREFIX)) return null
  return db.journalEntry.findFirst({
    where: { tenantId, reference: `${MANUAL_REVERSAL_PREFIX}${reference.slice(MANUAL_PREFIX.length)}` },
    select: { id: true, entryDate: true },
  })
}

export const OPEN_CHANGE_STATUSES = ['draft', 'submitted', 'returned'] as const

/** The open change request (edit / cancel) on an entry, if any. */
export async function openChangeRequestOf(db: Db, tenantId: string, entryId: string): Promise<{ id: string; kind: string; status: string } | null> {
  return db.journalRequest.findFirst({
    where: { tenantId, reverseEntryId: entryId, kind: { in: ['reverse', 'amend'] }, status: { in: [...OPEN_CHANGE_STATUSES] } },
    select: { id: true, kind: true, status: true },
  })
}

export function changePending(r: { id: string; kind: string; status: string }): AppError {
  return new AppError('CHANGE_PENDING', `A${r.kind === 'amend' ? 'n edit' : ' cancellation'} of this entry is already waiting (${r.status}) — decide or withdraw it first.`, 409, { requestId: r.id })
}

export const textEditSchema = z.object({
  description: z.string().trim().min(1).max(500).optional(),
  reference: z.string().trim().max(200).nullable().optional(),
  memos: z.array(z.object({ lineId: z.string().uuid(), memo: z.string().trim().max(500).nullable() })).max(200).optional(),
  // A line's sub-account (the whole line), or null to clear it — a reporting tag, so a text-level edit (2026-10-23).
  subAccounts: z.array(z.object({ lineId: z.string().uuid(), subAccountId: z.string().uuid().nullable() })).max(200).optional(),
})
export type TextEdit = z.infer<typeof textEditSchema>

/**
 * A TEXT edit of a live manual entry, in place, at once (owner, 2026-10-23):
 * description, the operator's reference, line memos. Nothing posts and no
 * amount, account, brand or date moves. Refused: not a manual entry (422
 * NOT_A_MANUAL_ENTRY, a reversal included), reversed (409 ENTRY_REVERSED), a
 * change request open (409 CHANGE_PENDING), dated in closed / reopened books
 * by anyone but the CEO (403 CEO_ONLY_CLOSED_BOOKS), a memo of another entry's
 * line (422 LINE_NOT_IN_ENTRY), nothing changed (409 NOTHING_CHANGED unless
 * `allowNoop`). Audit `journal.text_edit` with old → new, in the entry's company.
 */
export async function textEditManualJournal(tx: Prisma.TransactionClient, args: {
  tenantId: string; entryId: string; edit: TextEdit; actor: { id: string; role: string; email?: string | null; ip?: string | null }; allowNoop?: boolean
}): Promise<{ entry: ManualEntry; changed: boolean; sideEffects: () => Promise<void> }> {
  const { tenantId, entryId, edit, actor } = args
  await lockEntryChangeTx(tx, tenantId, entryId)
  const e = await tx.journalEntry.findFirst({ where: { id: entryId, tenantId }, include: { lines: true } })
  if (!e) throw new NotFoundError('JournalEntry', entryId)
  if (!e.reference?.startsWith(MANUAL_PREFIX)) {
    throw new AppError('NOT_A_MANUAL_ENTRY', 'Only manual journal entries are edited here — a reversal or a posting of a source document is corrected at its source.', 422)
  }
  if (await manualReversalOf(tx, tenantId, e.reference)) throw new AppError('ENTRY_REVERSED', 'This entry has been reversed — it can no longer be edited.', 409)
  const open = await openChangeRequestOf(tx, tenantId, entryId)
  if (open) throw changePending(open)
  if (actor.role !== 'admin') {
    const { closedBooksThrough } = await import('./closedBooks.js')
    const through = await closedBooksThrough(tx, tenantId)
    if (through && e.entryDate <= through) {
      throw new AppError('CEO_ONLY_CLOSED_BOOKS', `This entry is dated ${fmtPktDate(e.entryDate)}, in closed books — only the CEO can change it.`, 403)
    }
  }
  const cur = splitDescription(e.description)
  const nextDesc = composeDescription(edit.description ?? cur.description, edit.reference !== undefined ? edit.reference : cur.reference)
  const lineIds = new Set(e.lines.map((l) => l.id))
  const memoChanges: Array<{ lineId: string; before: string | null; after: string | null }> = []
  for (const m of edit.memos ?? []) {
    if (!lineIds.has(m.lineId)) throw new AppError('LINE_NOT_IN_ENTRY', 'A memo names a line of another entry', 422)
    const before = e.lines.find((l) => l.id === m.lineId)!.memo ?? null
    const after = m.memo?.trim() || null
    if (before !== after) memoChanges.push({ lineId: m.lineId, before, after })
  }
  // Sub-account tags: the whole line to one sub-account, or cleared.
  const tagChanges: Array<{ lineId: string; before: string[]; after: string | null }> = []
  for (const t of edit.subAccounts ?? []) {
    if (!lineIds.has(t.lineId)) throw new AppError('LINE_NOT_IN_ENTRY', 'A sub-account names a line of another entry', 422)
    const cur = await tx.journalLineSubAccount.findMany({ where: { journalLineId: t.lineId }, select: { subAccountId: true } })
    const same = t.subAccountId ? cur.length === 1 && cur[0]!.subAccountId === t.subAccountId : cur.length === 0
    if (!same) tagChanges.push({ lineId: t.lineId, before: cur.map((c) => c.subAccountId), after: t.subAccountId })
  }
  const descChanged = nextDesc !== e.description
  if (!descChanged && memoChanges.length === 0 && tagChanges.length === 0) {
    if (!args.allowNoop) throw new AppError('NOTHING_CHANGED', 'Nothing changed', 409)
  } else {
    if (descChanged) await tx.journalEntry.update({ where: { id: e.id }, data: { description: nextDesc } })
    for (const m of memoChanges) await tx.journalLine.update({ where: { id: m.lineId }, data: { memo: m.after } })
    for (const t of tagChanges) {
      const line = e.lines.find((l) => l.id === t.lineId)!
      await tagLineTx(tx, { tenantIds: [tenantId], journalLineId: t.lineId, replace: true, actorId: actor.id,
        allocations: t.after ? [{ subAccountId: t.after, amountCents: toCents(line.amountCents) }] : [] })
    }
  }
  const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: e.id }, include: { lines: { include: { account: true } } } })
  const changed = descChanged || memoChanges.length > 0 || tagChanges.length > 0
  const sideEffects = async () => {
    if (!changed) return
    await audit({
      category: 'accounting', action: 'journal.text_edit', entity: 'JournalEntry', entityId: e.id,
      userId: actor.id, userEmail: actor.email ?? null, tenantId,
      before: { description: e.description, memos: memoChanges.map((m) => ({ lineId: m.lineId, memo: m.before })), subAccounts: tagChanges.map((t) => ({ lineId: t.lineId, subAccountIds: t.before })) },
      after: { description: nextDesc, memos: memoChanges.map((m) => ({ lineId: m.lineId, memo: m.after })), subAccounts: tagChanges.map((t) => ({ lineId: t.lineId, subAccountId: t.after })) },
      metadata: { ip: actor.ip ?? null, actorRole: actor.role, voucherNo: e.voucherNo },
    })
  }
  return { entry, changed, sideEffects }
}
