// Journal posting engine — every business event that moves money posts here.
//
// Design principles:
//   1. Balanced. Sum(debits) MUST equal sum(credits) — enforced at write time.
//   2. Idempotent. (sourceType + sourceId) is unique per posting; replays are
//      no-ops, not duplicates. Webhooks, retries, and dual-bumps are safe.
//   3. Append-only semantics. Reversals POST a new opposing entry — they never
//      mutate or delete prior journal lines. Period-close locks rely on this.
//   4. Account codes (not UUIDs) at the call site. Codes are stable; UUIDs
//      change between environments.
//   5. Paisa as JS integers; journal_lines.amountCents is BIGINT (lib/money.ts).
//      No floats, no rounding drift. One line ≤ MAX_MONEY_CENTS (PKR 900bn).
//   6. One company per entry. Each company keeps its own chart of accounts and
//      its own books, so every posting names the company it belongs to: the
//      account codes resolve inside that company, the period-lock check reads
//      that company's close, and the entry is stamped with it. A posting can
//      never straddle two companies' ledgers.

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { fmtPktDate } from './dates.js'
import { amountTooLarge, assertMoneyFits, toCents } from '../../lib/money.js'

type Tx = Prisma.TransactionClient | PrismaClient

export interface JournalLineInput {
  accountCode: string
  type: 'debit' | 'credit'
  amountCents: number
  memo?: string
  // Brand attribution. Set by order/shift posting so per-brand cost is measured.
  // Omit (null) for shared/overhead lines — the per-brand P&L allocates those.
  conceptId?: string | null
}

export interface PostJournalEntryInput {
  // Company whose books this entry belongs to. Resolved from the source
  // document — the order's brand, the shift's company, the supplier's company,
  // or the operator's active company for manual entries.
  tenantId: string
  // Idempotency: a (sourceType, sourceId) pair posts at most once. Reversing
  // entries get a distinct sourceId (e.g. `${orderId}:reversal`).
  sourceType: string         // e.g. 'order.complete', 'order.refund', 'shift.close', 'supplier.bill'
  sourceId: string           // domain ID (orderId, shiftId, billId, …)
  description: string
  entryDate?: Date
  postedBy?: string          // user ID, or 'system'
  reference?: string         // free-text cross-ref (concept slug, external txn id, …)
  lines: JournalLineInput[]
}

export interface PostJournalEntryResult {
  entryId: string
  posted: boolean            // false = idempotent no-op (already posted)
}

// Per-concept revenue mapping. Source of truth for which 4xxx account each
// concept's sales hit. Adding a concept means adding its slug here AND seeding
// the matching Account row.
export const CONCEPT_REVENUE_CODE: Record<string, string> = {
  'simmer':          '4001',
  'stackd':          '4002',
  'stax':            '4002',  // pre-rename slug — keep so historical rows still map
  'strata':          '4003',
  'flipd':           '4004',
  'garnish-station': '4005',
  'stax-padel':      '4006',
  'bukhari':         '4007',
}

export function revenueCodeForConcept(slug: string): string {
  return CONCEPT_REVENUE_CODE[slug] ?? '4090' // Other/Catering fallback
}

// Stable account codes used throughout the posting modules. Imported via
// `import { ACCT } from './journal.js'` so typos surface at compile time.
export const ACCT = {
  CASH_ON_HAND:        '1010',
  CASH_DRAWER:         '1015',
  BANK:                '1020',
  CARD_RECEIVABLE:     '1030',
  CUSTOMER_AR:         '1110',
  INVENTORY_FOOD:      '1210',
  INVENTORY_BEVERAGE:  '1220',
  INVENTORY_PACKAGING: '1230',
  GST_INPUT:           '1320',

  AP_SUPPLIERS:        '2010',
  WAGES_PAYABLE:       '2020',
  GST_OUTPUT:          '2030',
  PRA_TAX_OUTPUT:      '2031',
  SRB_TAX_OUTPUT:      '2032',
  KPRA_TAX_OUTPUT:     '2033',
  BRA_TAX_OUTPUT:      '2034',
  WHT_PAYABLE:         '2040',
  STWH_PAYABLE:        '2041',
  WALLET_LIABILITY:    '2050',
  LOYALTY_LIABILITY:   '2060',
  TIPS_PAYABLE:        '2095',
  SERVICE_CHARGE_REVENUE: '4100',
  WHT_RECEIVABLE:      '1330',

  FOOD_COST:           '5010',
  BEVERAGE_COST:       '5020',
  PACKAGING_COST:      '5030',
  WASTE:               '5040',
  INVENTORY_VARIANCE:  '5050',

  WAGES_KITCHEN:       '6030',
  WAGES_FOH:           '6031',
  WAGES_MANAGEMENT:    '6032',
  WAGES_RIDERS:        '6035',
  CARD_FEES:           '6080',

  DISCOUNTS:           '7010',
  LOYALTY_REDEMPTIONS: '7020',
  COMPS:               '7030',
  REFUNDS:             '7040',

  CASH_VARIANCE:       '8010',
} as const

// Codes resolve inside ONE company's chart. The same code means different
// rows in different companies (GS Foods' 4001 is not GSX Viva's 4001), so a
// posting can never land on another company's account.
async function resolveAccountIds(tx: Tx, tenantId: string, codes: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(codes))
  const accounts = await tx.account.findMany({
    where: { tenantId, code: { in: unique }, isActive: true },
    select: { id: true, code: true },
  })
  const found = new Map(accounts.map((a) => [a.code, a.id]))
  const missing = unique.filter((c) => !found.has(c))
  if (missing.length > 0) {
    throw new AppError(
      'ACCOUNT_NOT_FOUND',
      `This company's chart of accounts is missing code(s): ${missing.join(', ')}. Add them in Configuration → Chart of accounts.`,
      500,
    )
  }
  return found
}

export async function postJournalEntry(
  input: PostJournalEntryInput,
  options: { tx?: Tx } = {},
): Promise<PostJournalEntryResult> {
  if (!input.sourceType || !input.sourceId) {
    throw new AppError('JOURNAL_MISSING_SOURCE', 'sourceType and sourceId are required for idempotency', 500)
  }
  if (!input.tenantId) {
    throw new AppError('JOURNAL_MISSING_TENANT', 'A journal entry must name the company it belongs to', 500)
  }
  if (input.lines.length < 2) {
    throw new AppError('JOURNAL_TOO_FEW_LINES', 'A journal entry needs at least two lines', 422)
  }

  // Drop zero-amount lines; reject negative amounts (must be expressed as
  // a credit/debit on the opposite side instead).
  const lines = input.lines.filter((l) => l.amountCents !== 0)
  for (const l of lines) {
    if (l.amountCents < 0) {
      throw new AppError('JOURNAL_NEGATIVE_AMOUNT', `Line amount must be positive (use opposite type for negatives): ${l.accountCode} ${l.amountCents}`, 422)
    }
    if (!Number.isInteger(l.amountCents)) {
      throw new AppError('JOURNAL_NOT_INTEGER', `Line amount must be integer cents: ${l.accountCode} ${l.amountCents}`, 422)
    }
    assertMoneyFits(l.amountCents, `${input.sourceType}:${input.sourceId} account ${l.accountCode}`)
  }
  if (lines.length < 2) {
    throw new AppError('JOURNAL_TOO_FEW_LINES', 'After dropping zero lines, fewer than two remained', 422)
  }

  const debitTotal  = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
  const creditTotal = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
  // Each line is ≤ MAX_MONEY_CENTS, but a total of many big lines can still
  // pass 2^53 and stop being exact — refuse rather than round.
  if (!Number.isSafeInteger(debitTotal) || !Number.isSafeInteger(creditTotal)) {
    throw amountTooLarge(`${input.sourceType}:${input.sourceId} total`)
  }
  if (debitTotal !== creditTotal) {
    throw new AppError(
      'JOURNAL_UNBALANCED',
      `Debits (${debitTotal}) ≠ credits (${creditTotal}) for ${input.sourceType}:${input.sourceId}`,
      422,
    )
  }

  const idempotencyRef = `${input.sourceType}:${input.sourceId}`
  const entryDate = input.entryDate ?? new Date()

  const run = async (tx: Tx): Promise<PostJournalEntryResult> => {
    // One posting of a (company, reference) at a time (RB-1). The idempotency
    // check below is a read followed by an insert under READ COMMITTED, and
    // journal_entries.reference has no unique index — so two callers racing
    // (two backfill runs, a backfill and the async completion posting, a
    // webhook retry) both saw "nothing posted" and both inserted, booking the
    // sale, its GST and its points twice. A transaction-scoped advisory lock
    // on (company, reference) makes the second caller wait for the first to
    // commit and then find its entry. Released with the transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.tenantId}::text), hashtext(${idempotencyRef}::text))`

    // Idempotency check — an entry with the same reference is treated as a
    // no-op. Scoped to the company so one company's books can never suppress
    // a posting in another's.
    const existing = await tx.journalEntry.findFirst({
      where: { reference: idempotencyRef, tenantId: input.tenantId },
      select: { id: true },
    })
    if (existing) return { entryId: existing.id, posted: false }

    // Period-lock check: refuse to post into a closed period. Reversal entries
    // can be posted with a current date that targets a closed source — this
    // rule only applies to the entry's own entryDate.
    // Only THIS company's close counts — GS Foods closing August must not
    // block GSX Viva from posting.
    const lock = await tx.periodLock.findFirst({
      where: { tenantId: input.tenantId },
      orderBy: { lockedThrough: 'desc' },
      select: { lockedThrough: true },
    })
    if (lock && entryDate <= lock.lockedThrough) {
      // Dates in PKT — a lock is a PKT end-of-day, and "books are closed
      // through 31 Aug" must read the same here as on the period-close page.
      throw new AppError(
        'PERIOD_LOCKED',
        `Cannot post to ${fmtPktDate(entryDate)} — books are closed through ${fmtPktDate(lock.lockedThrough)}. Post adjustments in the open period instead.`,
        422,
      )
    }

    const accountMap = await resolveAccountIds(tx, input.tenantId, lines.map((l) => l.accountCode))

    const created = await tx.journalEntry.create({
      data: {
        tenantId: input.tenantId,
        reference: idempotencyRef,
        description: input.description,
        entryDate,
        postedBy: input.postedBy ?? 'system',
        lines: {
          create: lines.map((l) => ({
            accountId: accountMap.get(l.accountCode)!,
            type: l.type,
            amountCents: l.amountCents,
            memo: l.memo ?? null,
            conceptId: l.conceptId ?? null,
          })),
        },
      },
      select: { id: true },
    })

    return { entryId: created.id, posted: true }
  }

  if (options.tx) return run(options.tx)
  return defaultPrisma.$transaction((tx) => run(tx))
}

// Reverse a previously posted entry by emitting the same lines with type
// flipped. The reversal is itself idempotent under (sourceType, sourceId+suffix).
export async function reverseJournalEntry(
  tenantId: string,
  originalSourceType: string,
  originalSourceId: string,
  reason: string,
  options: { tx?: Tx; suffix?: string; postedBy?: string; entryDate?: Date } = {},
): Promise<PostJournalEntryResult> {
  const tx = options.tx ?? defaultPrisma
  const reference = `${originalSourceType}:${originalSourceId}`
  // Scoped to the company — you can only reverse your own company's entry.
  const original = await tx.journalEntry.findFirst({
    where: { reference, tenantId },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  if (!original) {
    throw new AppError(
      'JOURNAL_REVERSE_NOT_FOUND',
      `Cannot reverse: no entry posted for ${reference}`,
      404,
    )
  }

  const suffix = options.suffix ?? 'reversal'
  return postJournalEntry(
    {
      tenantId,
      sourceType: `${originalSourceType}.${suffix}`,
      sourceId: originalSourceId,
      description: `Reversal of ${reference}: ${reason}`,
      entryDate: options.entryDate,
      postedBy: options.postedBy ?? 'system',
      reference: `reverses:${reference}`,
      lines: original.lines.map((l) => ({
        accountCode: l.account.code,
        type: l.type === 'debit' ? 'credit' : 'debit',
        amountCents: toCents(l.amountCents),
        memo: l.memo ?? `Reversal: ${reason}`,
        conceptId: l.conceptId, // keep brand attribution on the reversal
      })),
    },
    { tx: options.tx },
  )
}

// ─── A posting the ledger refused is never silent (BOOKS-07 / BOOKS-R2-01) ──
//
// The till close was the only posting whose refusal reached anyone: online
// order completions, refunds and loyalty postings were console.error'd, so a
// lock through today (or any other refusal) left a sale filed with the fiscal
// POS and missing from the books with nobody told. Every such refusal now
// raises ONE open high 'posting_failed' exception per (entity, posting) in the
// source document's company; POST /reconciliation/backfill-unposted re-posts
// it and resolves the flag.
//
// Bank deposits, waste (manual and void-after-fire), stock counts, a
// cancelled ticket's unwind and a till card failed after its close are
// flagged the same way and re-posted by the backfill's "other refused
// postings" step (reconciliation/backfillOrders.ts) — on their own date while
// that month is open, else into the current open month with a note naming the
// original date (owner decision 6). Never booked by hand: a manual journal
// does not carry the posting's key, so the backfill would book it again.

export interface PostingFailure {
  /** The source document's company. Null → the flag falls back to the brand's company. */
  tenantId:    string | null
  /** The posting that was refused: 'order.complete', 'order.refund', 'loyalty.earn', … */
  sourceType:  string
  sourceId:    string
  /** What the operator looks up: 'Order', 'LoyaltyTransaction', … */
  entityType:  string
  entityId:    string
  reason:      string
  title:       string
  conceptId?:  string | null
  amountCents?: number | null
  /** Who triggered the posting, when a person did. */
  actorId?:    string | null
  /**
   * Extra context the re-poster needs (e.g. a void's wasteLogIds), merged
   * into the flag's metadata. reason / sourceType / sourceId always win.
   */
  metadata?:   Record<string, unknown>
}

/**
 * The open posting_failed flags of one posting. Older void-waste flags were
 * raised without metadata.sourceType and carry `source: '<sourceType>:<id>'`
 * instead — they match too, so a new flag is never raised beside one and
 * resolving the posting closes it.
 */
function openPostingFlagWhere(entityType: string, entityId: string, sourceType: string): Prisma.ExceptionFlagWhereInput {
  return {
    kind: 'posting_failed', entityType, entityId,
    status: { in: ['open', 'acknowledged'] },
    OR: [
      { metadata: { path: ['sourceType'], equals: sourceType } },
      { metadata: { path: ['source'], string_starts_with: `${sourceType}:` } },
    ],
  }
}

/** Raise (once) a high posting_failed exception. Never throws. */
export async function flagPostingFailed(f: PostingFailure): Promise<void> {
  try {
    console.error(`[journal] ${f.sourceType}:${f.sourceId} did not post: ${f.reason}`)
    const open = await defaultPrisma.exceptionFlag.findFirst({
      where: openPostingFlagWhere(f.entityType, f.entityId, f.sourceType),
      select: { id: true },
    })
    if (open) return
    const { flagException } = await import('../../lib/exceptions.js')
    await flagException({
      // Omitted (not null) when unknown, so lib/exceptions.ts falls back to
      // the brand's company as the PostingFailure contract says.
      ...(f.tenantId ? { tenantId: f.tenantId } : {}),
      kind: 'posting_failed',
      severity: 'high',
      title: f.title,
      description: `${f.entityType} ${f.entityId.slice(0, 8)}: its ${f.sourceType} journal entry was refused (${f.reason.slice(0, 300)}). `
        + 'Fix the cause (for example a missing or inactive account in the chart), then post it from Reconciliation → Backfill unposted — '
        + 'Preview shows the day it will post on. Do not book it by hand: a manual journal does not carry its key, so it would be booked twice.',
      entityType: f.entityType,
      entityId: f.entityId,
      conceptId: f.conceptId ?? null,
      actorId: f.actorId ?? null,
      amountCents: f.amountCents ?? null, // lib/exceptions.ts clamps
      metadata: { ...(f.metadata ?? {}), reason: f.reason, sourceType: f.sourceType, sourceId: f.sourceId },
    })
  } catch (err) {
    console.error(`[journal] could not flag the refused ${f.sourceType}:${f.sourceId}:`, (err as Error).message)
  }
}

/**
 * Close the open posting_failed flags of an entity once its posting is on the
 * books. `tenantIds` limits it to those companies' flags (a backfill closes
 * only flags in the caller's scope).
 */
export async function resolvePostingFailed(
  entityType: string, entityId: string, sourceType: string, resolution: string,
  opts: { tenantIds?: string[] } = {},
): Promise<void> {
  await defaultPrisma.exceptionFlag.updateMany({
    where: {
      ...openPostingFlagWhere(entityType, entityId, sourceType),
      ...(opts.tenantIds ? { tenantId: { in: opts.tenantIds } } : {}),
    },
    data: { status: 'resolved', resolvedAt: new Date(), resolution },
  }).catch((err) => console.error(`[journal] could not resolve posting_failed for ${entityType} ${entityId}:`, (err as Error).message))
}

/**
 * How a refused posting is re-made by the backfill: `entryDate` dates it in
 * the open period when its document's own month is closed, `memoNote` names
 * the original date (see withLateNote), `postedBy` is the operator. Omitted,
 * the poster dates it as the live path does.
 */
export interface RepostOptions {
  entryDate?: Date
  memoNote?: string
  postedBy?: string
}

/**
 * A posting re-made after its document's month was closed: the entry is
 * dated in the open period and every line names the original date (owner
 * decision 6). `note` is that text; lines and description carry it.
 */
export function withLateNote(description: string, lines: JournalLineInput[], note: string | undefined): { description: string; lines: JournalLineInput[] } {
  if (!note) return { description, lines }
  return {
    description: `${description} — ${note}`,
    lines: lines.map((l) => ({ ...l, memo: `${l.memo ?? ''} [${note}]`.trim().slice(0, 250) })),
  }
}
