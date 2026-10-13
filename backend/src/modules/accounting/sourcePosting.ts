// Keep ONE live journal entry in step with a source document that can be
// edited after it posted — an OpEx payment whose amount is corrected, a capex
// instalment that is un-marked paid. The ledger is append-only (journal.ts),
// so a change is a reversal of the live entry plus a fresh posting, never an
// edit in place.
//
// References, per source document `<sourceType>:<id>`:
//   first posting      <sourceType>:<id>
//   later postings     <sourceType>:<id>@2, @3, …
//   each reversal      <sourceType>.reversal:<id>[@n]   (reverseJournalEntry)
//
// A revision is LIVE when it has no reversal. `syncSourcePosting` compares the
// live revision with what the document says should be on the books and does
// nothing when they match — so it is safe to call on every save, retry or
// replay. Reversals are dated today (the original may sit in a closed month);
// the new posting carries the document's own date, and the period lock
// decides whether that month is still open.
//
// `keepLiveDate`: a system posting that was late-dated into the open month
// (lateDatingFor — depreciation, prepaid releases) would otherwise differ from
// its document's natural date on every run and churn reversal + repost
// forever. With the flag, an existing live revision keeps its own date and
// only a change in the LINES reposts. Off by default: an OpEx / petty-cash
// edit that moves the date still reposts.
//
// Every reader takes the caller's transaction, so a posting earlier in the
// same transaction is seen (Quick buy capitalises a payment it just posted).

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '../../lib/prisma.js'
import { postJournalEntry, reverseJournalEntry, type JournalLineInput } from './journal.js'
import { toCents } from '../../lib/money.js'

type Tx = Prisma.TransactionClient | PrismaClient

export interface DesiredPosting {
  description: string
  entryDate: Date
  lines: JournalLineInput[]
}

export interface LiveRevision {
  sourceId: string            // `<id>` or `<id>@n`
  entryId: string
  entryDate: Date
  lines: Array<{ accountCode: string; type: 'debit' | 'credit'; amountCents: number; conceptId: string | null }>
}

/** The live (un-reversed) revision of a source document, if any. */
export async function liveRevision(
  tenantId: string,
  sourceType: string,
  id: string,
  tx: Tx = defaultPrisma,
): Promise<{ live: LiveRevision | null; revisions: number }> {
  const entries = await tx.journalEntry.findMany({
    where: {
      tenantId,
      OR: [
        { reference: `${sourceType}:${id}` },
        { reference: { startsWith: `${sourceType}:${id}@` } },
        { reference: `${sourceType}.reversal:${id}` },
        { reference: { startsWith: `${sourceType}.reversal:${id}@` } },
      ],
    },
    include: { lines: { include: { account: { select: { code: true } } } } },
    orderBy: { createdAt: 'asc' },
  })
  const posted = entries.filter((e) => e.reference?.startsWith(`${sourceType}:`))
  const reversed = new Set(
    entries
      .filter((e) => e.reference?.startsWith(`${sourceType}.reversal:`))
      .map((e) => e.reference!.slice(`${sourceType}.reversal:`.length)),
  )
  let live: LiveRevision | null = null
  for (const e of posted) {
    const sourceId = e.reference!.slice(`${sourceType}:`.length)
    if (reversed.has(sourceId)) continue
    live = {
      sourceId,
      entryId: e.id,
      entryDate: e.entryDate,
      lines: e.lines.map((l) => ({ accountCode: l.account.code, type: l.type, amountCents: toCents(l.amountCents), conceptId: l.conceptId })),
    }
  }
  return { live, revisions: posted.length }
}

function sameLines(a: LiveRevision['lines'], b: JournalLineInput[]): boolean {
  const key = (l: { accountCode: string; type: string; amountCents: number; conceptId?: string | null }) =>
    `${l.accountCode}|${l.type}|${l.amountCents}|${l.conceptId ?? ''}`
  const x = a.map(key).sort()
  const y = b.filter((l) => l.amountCents !== 0).map(key).sort()
  return x.length === y.length && x.every((k, i) => k === y[i])
}

export type SyncOutcome = 'unchanged' | 'posted' | 'reposted' | 'reversed' | 'nothing'

export interface SyncOptions {
  /** Reuse the live revision's entry date instead of `desired.entryDate` (see the header). */
  keepLiveDate?: boolean
}

/**
 * Bring the books in line with the document: `desired` null means "nothing
 * should be on the books" (reverse any live revision).
 *
 * `keepLiveDate` may be passed on the input or as the second argument
 * (either form; the input wins when both are given).
 */
export async function syncSourcePosting(input: {
  tenantId: string
  sourceType: string
  id: string
  desired: DesiredPosting | null
  postedBy?: string
  reason: string
  tx?: Tx
  keepLiveDate?: boolean
}, opts: SyncOptions = {}): Promise<{ outcome: SyncOutcome; entryId: string | null }> {
  const tx = input.tx
  const keepLiveDate = input.keepLiveDate ?? opts.keepLiveDate ?? false
  const { live, revisions } = await liveRevision(input.tenantId, input.sourceType, input.id, tx ?? defaultPrisma)

  const desired: DesiredPosting | null = input.desired && live && keepLiveDate
    ? { ...input.desired, entryDate: live.entryDate }
    : input.desired

  if (live && desired
    && live.entryDate.getTime() === desired.entryDate.getTime()
    && sameLines(live.lines, desired.lines)) {
    return { outcome: 'unchanged', entryId: live.entryId }
  }
  if (!live && !desired) return { outcome: 'nothing', entryId: null }

  if (live) {
    await reverseJournalEntry(input.tenantId, input.sourceType, live.sourceId, input.reason, {
      tx, postedBy: input.postedBy,
    })
  }
  if (!desired) return { outcome: 'reversed', entryId: null }

  const sourceId = revisions === 0 ? input.id : `${input.id}@${revisions + 1}`
  const r = await postJournalEntry({
    tenantId: input.tenantId,
    sourceType: input.sourceType,
    sourceId,
    description: desired.description,
    entryDate: desired.entryDate,
    postedBy: input.postedBy ?? 'system',
    lines: desired.lines,
  }, { tx })
  return { outcome: live ? 'reposted' : 'posted', entryId: r.entryId }
}

/**
 * Ledger state per source id for a list screen: the live revision's total
 * (sum of debits) and the first debit / credit codes, keyed by id. Ids with
 * nothing live are absent. Pass `tx` to see postings made earlier in the same
 * transaction. `tenants` is one company id or a list.
 */
export async function liveRevisionsFor(
  tenants: string | string[],
  sourceType: string,
  ids: string[],
  tx: Tx = defaultPrisma,
): Promise<Map<string, { entryId: string; amountCents: number; debitCode: string | null; creditCode: string | null; entryDate: Date }>> {
  const out = new Map<string, { entryId: string; amountCents: number; debitCode: string | null; creditCode: string | null; entryDate: Date }>()
  const tenantIds = typeof tenants === 'string' ? [tenants] : tenants
  if (ids.length === 0 || tenantIds.length === 0) return out
  const idSet = new Set(ids)
  const entries = await tx.journalEntry.findMany({
    where: {
      tenantId: { in: tenantIds },
      OR: [{ reference: { startsWith: `${sourceType}:` } }, { reference: { startsWith: `${sourceType}.reversal:` } }],
    },
    include: { lines: { include: { account: { select: { code: true } } } } },
    orderBy: { createdAt: 'asc' },
  })
  const baseOf = (sid: string) => sid.split('@')[0]!
  const reversed = new Set(
    entries.filter((e) => e.reference!.startsWith(`${sourceType}.reversal:`))
      .map((e) => e.reference!.slice(`${sourceType}.reversal:`.length)),
  )
  for (const e of entries) {
    if (!e.reference!.startsWith(`${sourceType}:`)) continue
    const sid = e.reference!.slice(`${sourceType}:`.length)
    const base = baseOf(sid)
    if (!idSet.has(base) || reversed.has(sid)) continue
    const debits = e.lines.filter((l) => l.type === 'debit')
    out.set(base, {
      entryId: e.id,
      amountCents: debits.reduce((t, l) => t + toCents(l.amountCents), 0),
      debitCode: debits[0]?.account.code ?? null,
      creditCode: e.lines.find((l) => l.type === 'credit')?.account.code ?? null,
      entryDate: e.entryDate,
    })
  }
  return out
}
