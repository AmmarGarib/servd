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

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { toCents, zMoneyCents } from '../../lib/money.js'
import { postJournalEntry, reverseJournalEntry } from './journal.js'
import { fmtPktDate } from './dates.js'

type Db = PrismaClient | Prisma.TransactionClient

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
    // One reversal per entry, even under a double click.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`journal.reverse:${tenantId}:${original.reference}`}))`
    const already = await tx.journalEntry.findFirst({ where: { tenantId, reference: reversalRef }, select: { id: true, entryDate: true } })
    if (already) {
      throw new AppError('ALREADY_REVERSED', `This entry was already reversed on ${fmtPktDate(already.entryDate)} (entry ${already.id.slice(0, 8)}).`, 409)
    }
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
