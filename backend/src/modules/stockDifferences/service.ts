// Stock differences waiting for the CEO (H20 — owner decision 2026-10-14:
// "suspense, CEO clears").
//
// Waste and stock-count differences leave the shelves at once (the lots move
// when the waste / count is saved), but their COST waits in 1290 Stock
// Differences Suspense, with its reason, until the CEO approves it into cost
// of sales. accounting/inventoryPosting.ts (stockDifferenceAccount — THE
// switch point) and inventory/voidWaste.ts post them:
//
//   kind        source entry                    on 1290                  approved into
//   waste       'inventory.waste:<wasteLogId>'  Dr (a loss)              5040 Waste
//   void_waste  'pos.void_waste:<orderItemId>'  Dr (a loss)              5040 Waste
//   count       'inventory.count:<countId>'     Dr short / Cr over       5050 Inventory Variance
//
// A PENDING difference = one journal line on 1290 from one of those entries
// that has no clearing entry yet. There is no table: the clearing IS the
// entry 'stock_difference.clear:<journalLineId>' in the line's company
// (postJournalEntry is idempotent on it, one per company and line).
//
//   approve (CEO, role admin): per line, dated the approval day, in the line's
//     company, both lines carrying the line's brand (the brand split the
//     waste / count made when it was posted — the log's brand, else each
//     brand's recipe use of the ingredient, H20; untraceable stays head
//     office, brand-less):
//       loss  Dr 5040 / 5050  / Cr 1290
//       gain  Dr 1290         / Cr 5050
//     A closed month is never touched (the clearing is dated today; the books
//     closed through today refuse it, 422 PERIOD_LOCKED, nothing cleared).
//     Lines of ONE company per call (422 ONE_COMPANY); an id outside the
//     caller's companies is 404; a line already cleared is a no-op — every
//     line already cleared is 409 ALREADY_CLEARED.
//   send back (CEO): a note on the difference — an 'accounting' audit row
//     (action 'stock_difference.query', entity JournalLine) and a medium flag
//     'stock_difference_queried'; it stays pending.
//
// stockDifferenceCloseCheck warns (never blocks) while differences dated up
// to the lock still wait, per month.

import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { flagException, type ExceptionKind } from '../../lib/exceptions.js'
import { ACCT, postJournalEntry, type JournalLineInput } from '../accounting/journal.js'
import { fmtPktDate } from '../accounting/dates.js'
import type { CloseCheck } from '../accounting/closeCheckTypes.js'

type Db = Prisma.TransactionClient | PrismaClient

export type StockDifferenceKind = 'waste' | 'void_waste' | 'count'

/** The entries whose 1290 lines are stock differences, by kind. */
export const STOCK_DIFFERENCE_SOURCES: Readonly<Record<StockDifferenceKind, string>> = {
  waste: 'inventory.waste',
  void_waste: 'pos.void_waste',
  count: 'inventory.count',
}
const SOURCE_KIND = new Map<string, StockDifferenceKind>(
  (Object.entries(STOCK_DIFFERENCE_SOURCES) as Array<[StockDifferenceKind, string]>).map(([k, s]) => [s, k]),
)

/** Where an approved difference goes: waste → 5040, count → 5050. */
export const CLEARING_ACCOUNT: Readonly<Record<StockDifferenceKind, string>> = {
  waste: ACCT.WASTE,
  void_waste: ACCT.WASTE,
  count: ACCT.INVENTORY_VARIANCE,
}

/** The clearing entry's source type: 'stock_difference.clear:<journalLineId>'. */
export const STOCK_DIFFERENCE_CLEAR_SOURCE = 'stock_difference.clear'
export const clearingRef = (lineId: string) => `${STOCK_DIFFERENCE_CLEAR_SOURCE}:${lineId}`

/** The audit action of a "send back" note. */
export const STOCK_DIFFERENCE_QUERY_ACTION = 'stock_difference.query'
/**
 * The flag a "send back" raises. ExceptionFlag.kind is a plain String column;
 * the kind is listed in lib/exceptions.ts ExceptionKind by wave Z — until then
 * the literal is widened through string (the column takes any string).
 */
export const STOCK_DIFFERENCE_QUERIED_KIND = 'stock_difference_queried' as string as ExceptionKind

/** Who approves and sends back: the CEO. */
export const STOCK_DIFFERENCE_APPROVERS = ['admin'] as const

const PKT_MS = 5 * 3600_000
const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** 'YYYY-MM' of an instant, Pakistan time. */
const pktMonth = (d: Date) => fmtPktDate(d).slice(0, 7)
/** The Monday (YYYY-MM-DD, Pakistan time) of the week an instant falls in. */
function pktWeek(d: Date): string {
  const p = new Date(d.getTime() + PKT_MS)
  const dow = (p.getUTCDay() + 6) % 7 // Monday = 0
  return new Date(Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), p.getUTCDate() - dow)).toISOString().slice(0, 10)
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export interface StockDifferenceQuery {
  note: string
  byId: string | null
  byName: string | null
  at: string
}

export interface StockDifferenceRow {
  /** The 1290 journal line — what approve / send back take. */
  lineId: string
  tenantId: string
  companyName: string | null
  entryId: string
  /** The source entry: 'inventory.waste:<id>', 'pos.void_waste:<id>', 'inventory.count:<id>'. */
  reference: string
  sourceId: string
  kind: StockDifferenceKind
  /** loss = stock gone (a debit on 1290); gain = a count found more (a credit). */
  direction: 'loss' | 'gain'
  /** Signed: positive = a loss waiting to reach cost of sales, negative = a gain. */
  valueCents: number
  /** When the difference was booked (the source entry's date). */
  entryDate: string
  month: string
  /** Monday of its week, Pakistan time (YYYY-MM-DD). */
  week: string
  conceptId: string | null
  conceptName: string | null
  locationId: string | null
  locationName: string | null
  itemName: string | null
  /** The waste reason ('spoilage', 'remake', 'voided after firing' …) or 'count short' / 'count over'. */
  reason: string
  notes: string | null
  memo: string | null
  recordedById: string | null
  recordedByName: string | null
  status: 'pending' | 'cleared'
  /** "Send back" notes, oldest first. */
  queries: StockDifferenceQuery[]
  /** The clearing, once approved. */
  cleared: { entryId: string; reference: string; at: string; byId: string | null; byName: string | null; account: string } | null
  /** Where the CEO's approval puts it: 5040 or 5050. */
  clearingAccount: string
}

export interface StockDifferenceTotals {
  count: number
  /** Σ losses (positive). */
  lossCents: number
  /** Σ gains (positive). */
  gainCents: number
  /** lossCents − gainCents. */
  netCents: number
}

export interface ListStockDifferencesInput {
  /** The companies to read (already scoped by the caller). Empty = nothing. */
  tenantIds: string[]
  status: 'pending' | 'cleared'
  from?: Date | null
  to?: Date | null
  /** Opaque, from a previous page's nextCursor. */
  cursor?: string | null
  limit?: number
}

const sourcesSql = Object.values(STOCK_DIFFERENCE_SOURCES)

/** The cursor: '<entryDate ISO>|<lineId>'. */
function parseCursor(c: string | null | undefined): { at: Date; id: string } | null {
  if (!c) return null
  const i = c.lastIndexOf('|')
  if (i < 0) return null
  const at = new Date(c.slice(0, i))
  const id = c.slice(i + 1)
  return Number.isNaN(at.getTime()) || !id ? null : { at, id }
}

/**
 * WHERE of the 1290 lines of stock-difference entries of `a.tenantIds` with
 * `a.status`, in [from, to] — shared by the page and its totals.
 */
function linesWhere(a: ListStockDifferencesInput): Prisma.Sql {
  const conds: Prisma.Sql[] = [
    Prisma.sql`acc.code = ${ACCT.STOCK_DIFF_SUSPENSE}`,
    Prisma.sql`acc."tenantId" = ANY(${a.tenantIds}::text[])`,
    Prisma.sql`je."tenantId" = acc."tenantId"`,
    Prisma.sql`split_part(je.reference, ':', 1) = ANY(${sourcesSql}::text[])`,
  ]
  if (a.from) conds.push(Prisma.sql`je."entryDate" >= ${a.from}`)
  if (a.to) conds.push(Prisma.sql`je."entryDate" <= ${a.to}`)
  const clearing = Prisma.sql`SELECT 1 FROM journal_entries c WHERE c."tenantId" = je."tenantId" AND c.reference = ${`${STOCK_DIFFERENCE_CLEAR_SOURCE}:`} || jl.id`
  conds.push(a.status === 'cleared' ? Prisma.sql`EXISTS (${clearing})` : Prisma.sql`NOT EXISTS (${clearing})`)
  return Prisma.join(conds, ' AND ')
}

/**
 * The ids (newest first, keyset after `cursor`) of the matching lines. Raw
 * SQL returns ids only (money is re-read through the model API — lib/money.ts).
 */
async function lineIdsPage(db: Db, a: ListStockDifferencesInput, take: number): Promise<Array<{ id: string; at: Date }>> {
  if (a.tenantIds.length === 0) return []
  const cur = parseCursor(a.cursor)
  const after = cur
    ? Prisma.sql`AND (je."entryDate" < ${cur.at} OR (je."entryDate" = ${cur.at} AND jl.id < ${cur.id}))`
    : Prisma.empty
  return db.$queryRaw<Array<{ id: string; at: Date }>>`
    SELECT jl.id, je."entryDate" AS at
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl."journalEntryId"
      JOIN accounts acc ON acc.id = jl."accountId"
     WHERE ${linesWhere(a)} ${after}
     ORDER BY je."entryDate" DESC, jl.id DESC
     LIMIT ${take}`
}

/** Totals over every line with the status (not just the page). */
async function totalsOf(db: Db, a: ListStockDifferencesInput): Promise<StockDifferenceTotals> {
  if (a.tenantIds.length === 0) return { count: 0, lossCents: 0, gainCents: 0, netCents: 0 }
  const rows = await db.$queryRaw<Array<{ n: number; loss: bigint | number | null; gain: bigint | number | null }>>`
    SELECT count(*)::int AS n,
           COALESCE(sum(CASE WHEN jl.type = 'debit'  THEN jl."amountCents" ELSE 0 END), 0)::bigint AS loss,
           COALESCE(sum(CASE WHEN jl.type = 'credit' THEN jl."amountCents" ELSE 0 END), 0)::bigint AS gain
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl."journalEntryId"
      JOIN accounts acc ON acc.id = jl."accountId"
     WHERE ${linesWhere(a)}`
  const r = rows[0]
  const lossCents = toCents(r?.loss ?? 0)
  const gainCents = toCents(r?.gain ?? 0)
  return { count: r?.n ?? 0, lossCents, gainCents, netCents: lossCents - gainCents }
}

const LINE_SELECT = {
  id: true, type: true, amountCents: true, conceptId: true, memo: true,
  account: { select: { tenantId: true, code: true } },
  journalEntry: { select: { id: true, tenantId: true, reference: true, entryDate: true, postedBy: true } },
} as const satisfies Prisma.JournalLineSelect
type LineRow = Prisma.JournalLineGetPayload<{ select: typeof LINE_SELECT }>

const VOID_REASON_LABEL: Record<string, string> = {
  void_after_fire: 'voided after firing',
  cancelled_after_fire: 'cancelled after firing',
  returned_food: 'returned food',
}

/** The item a line's memo names: 'Waste (<why>): <item>' (void waste) or 'Count short|over — <item>: system …' (counts). */
function itemFromMemo(kind: StockDifferenceKind, memo: string | null): string | null {
  if (!memo) return null
  const clean = memo.replace(/ \[[^\]]*\]$/, '')
  if (kind === 'void_waste') return /^Waste \([^)]*\): (.+)$/.exec(clean)?.[1]?.trim() ?? null
  if (kind === 'count') return /^Count (?:short|over) — (.+?): system /.exec(clean)?.[1]?.trim() ?? null
  return null
}

/** Rows for the given 1290 lines, with their documents, names, notes and clearings. */
export async function shapeStockDifferences(db: Db, lines: LineRow[]): Promise<StockDifferenceRow[]> {
  if (lines.length === 0) return []
  const parsed = lines.map((l) => {
    const ref = l.journalEntry.reference ?? ''
    const i = ref.indexOf(':')
    const kind = SOURCE_KIND.get(i < 0 ? ref : ref.slice(0, i))!
    return { l, ref, kind, sourceId: i < 0 ? '' : ref.slice(i + 1), tenantId: l.account.tenantId ?? l.journalEntry.tenantId ?? '' }
  })
  const tenantIds = [...new Set(parsed.map((p) => p.tenantId).filter(Boolean))]
  const ids = (k: StockDifferenceKind) => [...new Set(parsed.filter((p) => p.kind === k).map((p) => p.sourceId))]

  const [wasteLogs, voidLogs, counts, clears, queries, tenants] = await Promise.all([
    ids('waste').length ? db.wasteLog.findMany({
      where: { id: { in: ids('waste') } },
      select: { id: true, tenantId: true, reason: true, notes: true, locationId: true, recordedById: true, inventoryItem: { select: { name: true, tenantId: true } } },
    }) : [],
    ids('void_waste').length ? db.wasteLog.findMany({
      where: { orderItemId: { in: ids('void_waste') } },
      select: { id: true, tenantId: true, orderItemId: true, reason: true, notes: true, locationId: true, recordedById: true, inventoryItem: { select: { name: true, tenantId: true } } },
      orderBy: { id: 'asc' },
    }) : [],
    ids('count').length ? db.physicalCount.findMany({
      where: { id: { in: ids('count') } },
      select: { id: true, tenantId: true, notes: true, locationId: true, countedById: true },
    }) : [],
    db.journalEntry.findMany({
      where: { tenantId: { in: tenantIds }, reference: { in: lines.map((l) => clearingRef(l.id)) } },
      select: { id: true, tenantId: true, reference: true, entryDate: true, postedBy: true, createdAt: true },
    }),
    db.auditLog.findMany({
      where: { action: STOCK_DIFFERENCE_QUERY_ACTION, entity: 'JournalLine', entityId: { in: lines.map((l) => l.id) }, tenantId: { in: tenantIds } },
      select: { entityId: true, tenantId: true, userId: true, metadata: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }),
  ])

  const wasteById = new Map(wasteLogs.map((w) => [w.id, w]))
  const countById = new Map(counts.map((c) => [c.id, c]))
  const clearOf = new Map(clears.map((c) => [`${c.tenantId}|${c.reference}`, c]))
  const conceptIds = [...new Set(lines.map((l) => l.conceptId).filter((x): x is string => !!x))]
  const locationIds = new Set<string>()
  const userIds = new Set<string>()
  for (const w of [...wasteLogs, ...voidLogs]) { if (w.locationId) locationIds.add(w.locationId); if (w.recordedById) userIds.add(w.recordedById) }
  for (const c of counts) { if (c.locationId) locationIds.add(c.locationId); userIds.add(c.countedById) }
  for (const q of queries) if (q.userId) userIds.add(q.userId)
  for (const c of clears) if (c.postedBy && c.postedBy !== 'system') userIds.add(c.postedBy)
  const [concepts, locations, users] = await Promise.all([
    conceptIds.length ? db.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, name: true } }) : [],
    locationIds.size ? db.location.findMany({ where: { id: { in: [...locationIds] } }, select: { id: true, name: true } }) : [],
    userIds.size ? db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }) : [],
  ])
  const conceptName = new Map(concepts.map((c) => [c.id, c.name]))
  const locationName = new Map(locations.map((l) => [l.id, l.name]))
  const userName = new Map(users.map((u) => [u.id, u.name]))
  const companyName = new Map(tenants.map((t) => [t.id, t.name]))

  return parsed.map(({ l, ref, kind, sourceId, tenantId }): StockDifferenceRow => {
    const amount = toCents(l.amountCents)
    const valueCents = l.type === 'debit' ? amount : -amount
    let itemName: string | null = null
    let reason = ''
    let notes: string | null = null
    let locationId: string | null = null
    let recordedById: string | null = null
    if (kind === 'waste') {
      const w = wasteById.get(sourceId)
      if (w && (w.tenantId ?? w.inventoryItem.tenantId) === tenantId) {
        itemName = w.inventoryItem.name; reason = w.reason; notes = w.notes; locationId = w.locationId; recordedById = w.recordedById
      }
    } else if (kind === 'void_waste') {
      itemName = itemFromMemo(kind, l.memo)
      const logs = voidLogs.filter((w) => w.orderItemId === sourceId && (w.tenantId ?? w.inventoryItem.tenantId) === tenantId)
      const w = logs.find((x) => x.inventoryItem.name === itemName) ?? logs[0]
      if (w) { reason = VOID_REASON_LABEL[w.reason] ?? w.reason; notes = w.notes; locationId = w.locationId; recordedById = w.recordedById }
      else reason = /^Waste \(([^)]*)\)/.exec(l.memo ?? '')?.[1] ?? 'sold-line waste'
    } else {
      itemName = itemFromMemo(kind, l.memo)
      reason = valueCents > 0 ? 'count short' : 'count over'
      const c = countById.get(sourceId)
      if (c && c.tenantId === tenantId) { notes = c.notes; locationId = c.locationId; recordedById = c.countedById }
    }
    if (!recordedById && l.journalEntry.postedBy && l.journalEntry.postedBy !== 'system') recordedById = l.journalEntry.postedBy
    const clear = clearOf.get(`${tenantId}|${clearingRef(l.id)}`) ?? null
    const clearedBy = clear?.postedBy && clear.postedBy !== 'system' ? clear.postedBy : null
    return {
      lineId: l.id,
      tenantId,
      companyName: companyName.get(tenantId) ?? null,
      entryId: l.journalEntry.id,
      reference: ref,
      sourceId,
      kind,
      direction: valueCents >= 0 ? 'loss' : 'gain',
      valueCents,
      entryDate: l.journalEntry.entryDate.toISOString(),
      month: pktMonth(l.journalEntry.entryDate),
      week: pktWeek(l.journalEntry.entryDate),
      conceptId: l.conceptId,
      conceptName: l.conceptId ? (conceptName.get(l.conceptId) ?? null) : null,
      locationId,
      locationName: locationId ? (locationName.get(locationId) ?? null) : null,
      itemName,
      reason,
      notes,
      memo: l.memo,
      recordedById,
      recordedByName: recordedById ? (userName.get(recordedById) ?? null) : null,
      status: clear ? 'cleared' : 'pending',
      queries: queries
        .filter((q) => q.entityId === l.id && q.tenantId === tenantId)
        .map((q) => {
          const m = (q.metadata ?? {}) as Record<string, unknown>
          return { note: typeof m.note === 'string' ? m.note : '', byId: q.userId, byName: q.userId ? (userName.get(q.userId) ?? null) : null, at: q.createdAt.toISOString() }
        }),
      cleared: clear
        ? { entryId: clear.id, reference: clear.reference ?? clearingRef(l.id), at: clear.entryDate.toISOString(), byId: clearedBy, byName: clearedBy ? (userName.get(clearedBy) ?? null) : null, account: CLEARING_ACCOUNT[kind] }
        : null,
      clearingAccount: CLEARING_ACCOUNT[kind],
    }
  })
}

/** One page of stock differences (newest first) and the totals of every line with that status. */
export async function listStockDifferences(a: ListStockDifferencesInput, db: Db = prisma): Promise<{
  rows: StockDifferenceRow[]; nextCursor: string | null; totals: StockDifferenceTotals
}> {
  const limit = Math.min(Math.max(a.limit ?? 200, 1), 500)
  const [page, totals] = await Promise.all([lineIdsPage(db, a, limit + 1), totalsOf(db, a)])
  const more = page.length > limit
  const ids = page.slice(0, limit)
  const lines = ids.length === 0 ? [] : await db.journalLine.findMany({ where: { id: { in: ids.map((x) => x.id) } }, select: LINE_SELECT })
  const byId = new Map(lines.map((l) => [l.id, l]))
  const ordered = ids.map((x) => byId.get(x.id)).filter((l): l is LineRow => !!l)
  const rows = await shapeStockDifferences(db, ordered)
  const last = ids[ids.length - 1]
  return { rows, nextCursor: more && last ? `${last.at.toISOString()}|${last.id}` : null, totals }
}

/**
 * The 1290 stock-difference lines `ids` names, in `tenantIds` only. Any id
 * that is not such a line of those companies → 404 (a foreign id never
 * confirms it exists).
 */
async function loadLines(db: Db, tenantIds: string[], ids: string[]): Promise<LineRow[]> {
  const unique = [...new Set(ids)]
  const lines = tenantIds.length === 0 || unique.length === 0 ? [] : await db.journalLine.findMany({
    where: {
      id: { in: unique },
      account: { code: ACCT.STOCK_DIFF_SUSPENSE, tenantId: { in: tenantIds } },
      journalEntry: { tenantId: { in: tenantIds }, OR: sourcesSql.map((s) => ({ reference: { startsWith: `${s}:` } })) },
    },
    select: LINE_SELECT,
  })
  const found = new Set(lines.filter((l) => l.account.tenantId && l.account.tenantId === l.journalEntry.tenantId).map((l) => l.id))
  const missing = unique.find((id) => !found.has(id))
  if (missing) throw new NotFoundError('Stock difference', missing)
  return lines
}

/** The rows for given line ids (scoped), for a response after a write. */
export async function stockDifferencesByIds(tenantIds: string[], ids: string[], db: Db = prisma): Promise<StockDifferenceRow[]> {
  return shapeStockDifferences(db, await loadLines(db, tenantIds, ids))
}

// ─── Approve ─────────────────────────────────────────────────────────────────

export interface ApproveResult {
  tenantId: string
  /** Lines cleared by this call, with their clearing entries. */
  cleared: Array<{ lineId: string; entryId: string; valueCents: number; account: string }>
  /** Lines that were already cleared (nothing posted for them). */
  alreadyCleared: string[]
  /** Σ signed value cleared by this call (losses positive). */
  clearedCents: number
}

/**
 * Clear `lineIds` (one company's) into cost of sales — see the header.
 * `tenantIds` is the caller's write scope (every company they belong to).
 * One transaction: every clearing posts, or none (a closed period refuses
 * them all).
 */
export async function approveStockDifferences(a: { tenantIds: string[]; lineIds: string[]; actorId: string }): Promise<ApproveResult> {
  if (a.lineIds.length === 0) throw new AppError('NO_LINES', 'Pick at least one difference to approve', 422)
  const lines = await loadLines(prisma, a.tenantIds, a.lineIds)
  const companies = [...new Set(lines.map((l) => l.account.tenantId!))]
  if (companies.length !== 1) {
    throw new AppError('ONE_COMPANY', 'Approve one company\'s differences at a time — switch to that company first', 422)
  }
  const tenantId = companies[0]!
  const today = new Date()
  const result = await prisma.$transaction(async (tx) => {
    const out: ApproveResult = { tenantId, cleared: [], alreadyCleared: [], clearedCents: 0 }
    for (const l of [...lines].sort((x, y) => x.id.localeCompare(y.id))) {
      const ref = l.journalEntry.reference ?? ''
      const kind = SOURCE_KIND.get(ref.slice(0, ref.indexOf(':')))!
      const account = CLEARING_ACCOUNT[kind]
      const cents = toCents(l.amountCents)
      if (cents <= 0) continue
      const loss = l.type === 'debit'
      const what = `${kind === 'count' ? (loss ? 'Count short' : 'Count over') : 'Waste'} approved by the CEO — ${l.memo ?? ref}`.slice(0, 250)
      const lines2: JournalLineInput[] = loss
        ? [
            { accountCode: account, type: 'debit', amountCents: cents, memo: what, conceptId: l.conceptId },
            { accountCode: ACCT.STOCK_DIFF_SUSPENSE, type: 'credit', amountCents: cents, memo: `Cleared from stock differences — ${ref}`.slice(0, 250), conceptId: l.conceptId },
          ]
        : [
            { accountCode: ACCT.STOCK_DIFF_SUSPENSE, type: 'debit', amountCents: cents, memo: `Cleared from stock differences — ${ref}`.slice(0, 250), conceptId: l.conceptId },
            { accountCode: account, type: 'credit', amountCents: cents, memo: what, conceptId: l.conceptId },
          ]
      const r = await postJournalEntry({
        tenantId,
        sourceType: STOCK_DIFFERENCE_CLEAR_SOURCE,
        sourceId: l.id,
        description: `Stock difference approved into ${account === ACCT.WASTE ? '5040 Waste' : '5050 Inventory Variance'} — ${pkr(cents)} (${ref}, booked ${fmtPktDate(l.journalEntry.entryDate)})`,
        entryDate: today,
        postedBy: a.actorId,
        lines: lines2,
      }, { tx })
      if (!r.posted) { out.alreadyCleared.push(l.id); continue }
      const signed = loss ? cents : -cents
      out.cleared.push({ lineId: l.id, entryId: r.entryId, valueCents: signed, account })
      out.clearedCents += signed
    }
    return out
  }, { timeout: 60_000, maxWait: 15_000 })
  if (result.cleared.length === 0) {
    throw new AppError('ALREADY_CLEARED', lines.length === 1 ? 'This difference was already approved' : 'These differences were already approved', 409, { alreadyCleared: result.alreadyCleared })
  }
  return result
}

// ─── Send back ───────────────────────────────────────────────────────────────

/**
 * The CEO sends a difference back with a note: an audit row the page lists
 * and a medium 'stock_difference_queried' flag, in the line's company. The
 * difference stays pending; one already approved is 409 ALREADY_CLEARED.
 */
export async function queryStockDifference(a: {
  tenantIds: string[]; lineId: string; note: string; actor: { id: string; email?: string | null }
}): Promise<StockDifferenceRow> {
  const note = a.note.trim()
  if (note.length < 3 || note.length > 500) throw new AppError('BAD_NOTE', 'Write a note of 3 to 500 characters', 422)
  const [line] = await loadLines(prisma, a.tenantIds, [a.lineId])
  const tenantId = line!.account.tenantId!
  const cleared = await prisma.journalEntry.findFirst({ where: { tenantId, reference: clearingRef(line!.id) }, select: { id: true } })
  if (cleared) throw new AppError('ALREADY_CLEARED', 'This difference was already approved — it cannot be sent back', 409)
  const [row] = await shapeStockDifferences(prisma, [line!])
  await prisma.auditLog.create({
    data: {
      category: 'accounting', tenantId, action: STOCK_DIFFERENCE_QUERY_ACTION, entity: 'JournalLine', entityId: line!.id,
      userId: a.actor.id, userEmail: a.actor.email ?? null,
      metadata: { note, reference: row!.reference, valueCents: row!.valueCents, kind: row!.kind } as Prisma.InputJsonValue,
    },
  })
  await flagException({
    tenantId,
    kind: STOCK_DIFFERENCE_QUERIED_KIND,
    severity: 'medium',
    title: `Stock difference sent back: ${row!.itemName ?? row!.reference} — ${pkr(Math.abs(row!.valueCents))}`,
    description: `The CEO sent back a ${row!.kind === 'count' ? 'count difference' : 'waste'} (${row!.reason}) of ${pkr(Math.abs(row!.valueCents))} booked ${fmtPktDate(new Date(row!.entryDate))}: "${note}". It stays in 1290 Stock Differences Suspense until approved.`,
    entityType: 'JournalLine',
    entityId: line!.id,
    conceptId: line!.conceptId,
    actorId: a.actor.id,
    amountCents: Math.abs(row!.valueCents),
    metadata: { reference: row!.reference, note },
  })
  return (await shapeStockDifferences(prisma, [line!]))[0]!
}

// ─── Month-end close ─────────────────────────────────────────────────────────

/**
 * A WARNING (never a block; overridable) while stock differences dated up to
 * the lock still wait for the CEO — per month, the value waiting. Closing is
 * safe: an approval is dated the day it is given, so a closed month is never
 * touched. wave Z lists it in accounting/closeChecks.ts CLOSE_CHECKS.
 */
export const stockDifferenceCloseCheck: CloseCheck = {
  key: 'stock_differences_pending',
  severity: 'warn',
  overridable: true,
  async run(ctx) {
    const rows = await ctx.db.$queryRaw<Array<{ month: string; n: number; loss: bigint | number | null; gain: bigint | number | null }>>`
      SELECT to_char(je."entryDate" + interval '5 hours', 'YYYY-MM') AS month,
             count(*)::int AS n,
             COALESCE(sum(CASE WHEN jl.type = 'debit'  THEN jl."amountCents" ELSE 0 END), 0)::bigint AS loss,
             COALESCE(sum(CASE WHEN jl.type = 'credit' THEN jl."amountCents" ELSE 0 END), 0)::bigint AS gain
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl."journalEntryId"
        JOIN accounts acc ON acc.id = jl."accountId"
       WHERE acc.code = ${ACCT.STOCK_DIFF_SUSPENSE}
         AND acc."tenantId" = ${ctx.tenantId}
         AND je."tenantId" = ${ctx.tenantId}
         AND split_part(je.reference, ':', 1) = ANY(${sourcesSql}::text[])
         AND je."entryDate" <= ${ctx.newLock}
         AND NOT EXISTS (
               SELECT 1 FROM journal_entries c
                WHERE c."tenantId" = je."tenantId" AND c.reference = ${`${STOCK_DIFFERENCE_CLEAR_SOURCE}:`} || jl.id)
       GROUP BY 1
       ORDER BY 1`
    if (rows.length === 0) return null
    const months = rows.map((r) => ({ month: r.month, n: r.n, net: toCents(r.loss ?? 0) - toCents(r.gain ?? 0) }))
    const count = months.reduce((t, m) => t + m.n, 0)
    const net = months.reduce((t, m) => t + m.net, 0)
    return {
      key: 'stock_differences_pending',
      severity: 'warn',
      title: 'Stock differences waiting for the CEO',
      detail: `${count} waste / count difference${count === 1 ? '' : 's'} up to ${fmtPktDate(ctx.newLock)} still wait in 1290 Stock Differences Suspense (${months.map((m) => `${m.month}: ${pkr(m.net)}`).join('; ')}). `
        + 'They reach cost of sales on the day the CEO approves them — a closed month is never changed.',
      count,
      cents: net,
      months: months.map((m) => m.month),
      link: '/finance/stock-differences',
      overridable: true,
    }
  },
}
