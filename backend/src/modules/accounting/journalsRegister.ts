// The Journals tab (owner, 2026-10-23): "a tab in servd which should store all
// the Journal entries (Payment journals and receiving journal separately) to
// find the entries in no time, and also option to edit/cancel/void any back
// dated or current Journal manual entry with final approval of CEO."
//
// ONE list over the whole ledger (no 90-day window), four views:
//   manual   `manual:` entries and their `manual.reversal:` entries;
//   payment  paymentsRegister.ts's definition of a payment (net money OUT of
//            1010 / 1011 / 1020 / the company's bank codes; live; not sales);
//   receipt  its mirror (net money IN), same file (moneyFlowWhereSql 'in');
//            sales / till sources (order*, pos.*, shift.close) are left out —
//            they would flood the list — unless includeSales=1;
//   all      every entry.
// Read scope = resolveTenantScope (the ledger's readers). Each row carries
// what the page needs to offer Open / Edit / Cancel under the rules of
// manualJournal.ts (text edits at once; money edits and cancels → the CEO).
//
// annotateEntries is also what the account statement (accountStatement.ts,
// GET /accounting/ledger?view=statement) puts on each of its lines.

import { particularsOf } from './particulars.js'
import type { FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { moneyAggregatesSql, moneyFlowWhereSql, moneyCodesOf } from './paymentsRegister.js'
import { MANUAL_PREFIX, MANUAL_JOURNAL_POSTERS, OPEN_CHANGE_STATUSES, splitDescription } from './manualJournal.js'
import { closedBooksThrough } from './closedBooks.js'
import { parsePktEndOfDay, parsePktStartOfDay } from './dates.js'
import type { UserRole } from '@prisma/client'

export const JOURNAL_VIEWS = ['manual', 'payment', 'receipt', 'all'] as const
export type JournalView = (typeof JOURNAL_VIEWS)[number]

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const journalsQuerySchema = z.object({
  view: z.enum(JOURNAL_VIEWS).default('manual'),
  q: z.string().trim().max(100).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  accountCode: z.string().trim().max(40).optional(),
  brandId: z.string().uuid().optional(),
  minCents: z.coerce.number().int().min(0).optional(),
  maxCents: z.coerce.number().int().min(0).optional(),
  includeSales: z.enum(['1', 'true', '0', 'false']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  format: z.string().optional(),
})
export type JournalsQuery = z.infer<typeof journalsQuerySchema>

// ─── Cursor ──────────────────────────────────────────────────────────────────

function encodeCursor(d: Date, id: string): string {
  return Buffer.from(`${d.toISOString()}|${id}`).toString('base64url')
}
function decodeCursor(c: string): { d: Date; id: string } {
  const [iso, id] = Buffer.from(c, 'base64url').toString().split('|')
  const d = new Date(iso ?? '')
  if (!id || Number.isNaN(d.getTime())) throw new AppError('INVALID_CURSOR', 'The page cursor is not valid — start from the first page', 400)
  return { d, id }
}

/** "1,250.50", "PKR 1250", "Rs. 1250" → 125050 paisa; null when q is not an amount. */
function amountOf(q: string): number | null {
  const t = q.replace(/^(pkr|rs\.?)\s*/i, '').replace(/,/g, '').trim()
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  return Math.round(Number(t) * 100)
}

// ─── Who may do what ─────────────────────────────────────────────────────────

export interface Viewer { id: string; role: string; isCeo: boolean; canPost: boolean }

/** The caller's journal rights: CEO, or finance holding `accounting` (routes.ts journalGate). */
export async function viewerOf(req: FastifyRequest): Promise<Viewer> {
  const su = req.staffUser
  if (!su) throw new AppError('UNAUTHORIZED', 'Sign in first', 401)
  const isCeo = su.role === 'admin'
  let canPost = isCeo
  if (!isCeo && (MANUAL_JOURNAL_POSTERS as readonly string[]).includes(su.role)) {
    const u = await prisma.user.findUnique({ where: { id: su.id }, select: { moduleAllow: true, moduleDeny: true } })
    const modules = await effectiveModulesForUser({ role: su.role as UserRole, moduleAllow: u?.moduleAllow ?? [], moduleDeny: u?.moduleDeny ?? [] })
    canPost = modules.has('accounting')
  }
  return { id: su.id, role: su.role, isCeo, canPost }
}

// ─── Per-entry annotations ───────────────────────────────────────────────────

export type JournalStatus = 'live' | 'reversed' | 'reversal' | 'change_pending'

export interface PendingChange {
  requestId: string
  kind: 'reverse' | 'amend'
  status: string
  reason: string | null
  preparedById: string
  preparedByName: string | null
  submittedAt: string | null
}

export interface EntryAnnotation {
  sourceType: string
  isManual: boolean
  status: JournalStatus
  reversedBy: { id: string; entryDate: string } | null
  reverses: { id: string } | null
  pendingChange: PendingChange | null
  /** Description / reference / memos may be changed now, in place. */
  canTextEdit: boolean
  /** Edit (money) or cancel may be done (CEO) or asked for (finance → the CEO approves). */
  canRequestChange: boolean
  /** True for anyone but the CEO: a money edit / cancel goes to the CEO. */
  changeNeedsApproval: boolean
  /** Why Edit / Cancel is not offered on a live manual entry, if it is not. */
  blockedReason: string | null
}

const REVERSAL_RE = /^([^:]+)\.(reversal|void):(.+)$/
export const sourceTypeOf = (reference: string | null) => {
  const r = reference ?? ''
  const at = r.indexOf(':')
  return at > 0 ? r.slice(0, at) : ''
}

/** Names of logins (postedBy may be 'system'). */
async function userNames(ids: string[]): Promise<Map<string, string>> {
  const real = [...new Set(ids.filter((i) => i && i !== 'system'))]
  if (real.length === 0) return new Map()
  const us = await prisma.user.findMany({ where: { id: { in: real } }, select: { id: true, name: true, email: true } })
  return new Map(us.map((u) => [u.id, u.name || u.email || u.id]))
}

/**
 * Status, reversal links, the open change request and the caller's Edit /
 * Cancel rights for each entry (all in the caller's scope already).
 */
export async function annotateEntries(
  viewer: Viewer,
  entries: Array<{ id: string; tenantId: string | null; reference: string | null; description: string; entryDate: Date }>,
): Promise<Map<string, EntryAnnotation>> {
  const out = new Map<string, EntryAnnotation>()
  if (entries.length === 0) return out
  const ids = entries.map((e) => e.id)
  const tenantIds = [...new Set(entries.map((e) => e.tenantId).filter((t): t is string => !!t))]

  // Reversals of these entries, and the originals of the reversals among them.
  const reversalRefs: Array<{ tenantId: string; reference: string }> = []
  const originalRefs: Array<{ tenantId: string; reference: string }> = []
  for (const e of entries) {
    if (!e.tenantId || !e.reference) continue
    const m = REVERSAL_RE.exec(e.reference)
    if (m && e.description.startsWith('Reversal of ')) { originalRefs.push({ tenantId: e.tenantId, reference: `${m[1]}:${m[3]}` }); continue }
    const at = e.reference.indexOf(':')
    if (at <= 0) continue
    const type = e.reference.slice(0, at)
    const rest = e.reference.slice(at + 1)
    reversalRefs.push({ tenantId: e.tenantId, reference: `${type}.reversal:${rest}` }, { tenantId: e.tenantId, reference: `${type}.void:${rest}` })
  }
  const [revs, origs, pending, vouchers, taxLinks, closed] = await Promise.all([
    reversalRefs.length ? prisma.journalEntry.findMany({ where: { OR: reversalRefs, description: { startsWith: 'Reversal of ' } }, select: { id: true, tenantId: true, reference: true, entryDate: true } }) : [],
    originalRefs.length ? prisma.journalEntry.findMany({ where: { OR: originalRefs }, select: { id: true, tenantId: true, reference: true } }) : [],
    prisma.journalRequest.findMany({
      where: { tenantId: { in: tenantIds }, reverseEntryId: { in: ids }, kind: { in: ['reverse', 'amend'] }, status: { in: [...OPEN_CHANGE_STATUSES] } },
      select: { id: true, kind: true, status: true, reason: true, preparedById: true, submittedAt: true, reverseEntryId: true },
    }),
    prisma.cashVoucher.findMany({ where: { postedJournalEntryId: { in: ids } }, select: { postedJournalEntryId: true, number: true } }),
    prisma.salesTaxPayment.findMany({ where: { journalEntryId: { in: ids }, linked: true }, select: { journalEntryId: true } }),
    viewer.isCeo ? Promise.resolve(new Map<string, Date | null>()) : (async () => new Map(await Promise.all(tenantIds.map(async (t) => [t, await closedBooksThrough(prisma, t)] as const))))(),
  ])
  const names = await userNames(pending.map((p) => p.preparedById))
  const revOf = new Map(revs.map((r) => [`${r.tenantId}|${r.reference}`, r]))
  const origOf = new Map(origs.map((o) => [`${o.tenantId}|${o.reference}`, o]))
  const pendingOf = new Map(pending.map((p) => [p.reverseEntryId!, p]))
  const voucherOf = new Map(vouchers.map((v) => [v.postedJournalEntryId!, v.number]))
  const taxLinked = new Set(taxLinks.map((t) => t.journalEntryId))

  for (const e of entries) {
    const ref = e.reference ?? ''
    const m = REVERSAL_RE.exec(ref)
    const isReversal = !!m && e.description.startsWith('Reversal of ')
    let reversedBy: EntryAnnotation['reversedBy'] = null
    let reverses: EntryAnnotation['reverses'] = null
    if (isReversal) {
      const o = origOf.get(`${e.tenantId}|${m![1]}:${m![3]}`)
      reverses = o ? { id: o.id } : null
    } else if (ref.includes(':')) {
      const at = ref.indexOf(':')
      const type = ref.slice(0, at)
      const rest = ref.slice(at + 1)
      const r = revOf.get(`${e.tenantId}|${type}.reversal:${rest}`) ?? revOf.get(`${e.tenantId}|${type}.void:${rest}`)
      reversedBy = r ? { id: r.id, entryDate: r.entryDate.toISOString() } : null
    }
    const p = pendingOf.get(e.id)
    const pendingChange: PendingChange | null = p ? {
      requestId: p.id, kind: p.kind as 'reverse' | 'amend', status: p.status, reason: p.reason,
      preparedById: p.preparedById, preparedByName: names.get(p.preparedById) ?? null, submittedAt: p.submittedAt?.toISOString() ?? null,
    } : null
    const status: JournalStatus = isReversal ? 'reversal' : reversedBy ? 'reversed' : pendingChange ? 'change_pending' : 'live'
    const isManual = ref.startsWith(MANUAL_PREFIX)
    let canTextEdit = false
    let canRequestChange = false
    let blockedReason: string | null = null
    if (isManual && status === 'live' && viewer.canPost) {
      const through = e.tenantId ? (closed as Map<string, Date | null>).get(e.tenantId) ?? null : null
      const closedForMe = !viewer.isCeo && !!through && e.entryDate <= through
      canTextEdit = !closedForMe
      if (voucherOf.has(e.id)) blockedReason = `Resolves cash voucher ${voucherOf.get(e.id)} — correct it with a further manual entry`
      else if (taxLinked.has(e.id)) blockedReason = 'Linked to the sales-tax return as a tax payment — unlink it there first'
      canRequestChange = !blockedReason
      if (closedForMe && !blockedReason) blockedReason = 'Dated in closed books — text changes are the CEO\'s; an edit or cancellation goes to the CEO'
    } else if (isManual && status === 'change_pending') {
      blockedReason = 'A change of this entry is waiting for the CEO'
    }
    out.set(e.id, {
      sourceType: isReversal ? `${m![1]}.${m![2]}` : sourceTypeOf(ref),
      isManual, status, reversedBy, reverses, pendingChange, canTextEdit, canRequestChange,
      changeNeedsApproval: !viewer.isCeo, blockedReason,
    })
  }
  return out
}

// ─── Rows ────────────────────────────────────────────────────────────────────

export interface JournalLineRow {
  id: string
  accountId: string
  accountCode: string
  accountName: string
  type: 'debit' | 'credit'
  amountCents: number
  conceptId: string | null
  conceptName: string | null
  memo: string | null
  /** Sub-account tags on this line (lib/subAccounts.ts); the rest of the line is unassigned. */
  subAccounts: Array<{ subAccountId: string; name: string; amountCents: number }>
}

export interface JournalRow extends EntryAnnotation {
  id: string
  tenantId: string | null
  companyName: string | null
  voucherNo: string | null
  /** The idempotency key `<sourceType>:<sourceId>` (never the operator's reference). */
  reference: string | null
  entryDate: string
  createdAt: string
  /** The description; for a manual entry without its " · ref …" suffix (that is operatorReference). */
  description: string
  /** The document's own narration (particulars.ts, owner 2026-10-24) — the Particulars column. */
  particulars: string
  operatorReference: string | null
  totalCents: number
  /** Money in (+) / out (−) of the company's money accounts by this entry. */
  moneyNetCents: number
  moneyAccounts: Array<{ code: string; name: string; netCents: number }>
  /** The biggest other account, e.g. "6010 Rent (+2 more)". */
  counterSummary: string
  brands: Array<{ id: string; name: string }>
  postedBy: { id: string; name: string } | null
  lines: JournalLineRow[]
}

/** Hydrate entry ids (already in scope) into rows, in the given order. */
export async function journalRows(viewer: Viewer, ids: string[]): Promise<JournalRow[]> {
  if (ids.length === 0) return []
  const entries = await prisma.journalEntry.findMany({
    where: { id: { in: ids } },
    include: { lines: { include: { account: { select: { code: true, name: true } }, subAccountAllocations: { select: { subAccountId: true, amountCents: true, subAccount: { select: { name: true } } } } } } },
  })
  const byId = new Map(entries.map((e) => [e.id, e]))
  const tenantIds = [...new Set(entries.map((e) => e.tenantId).filter((t): t is string => !!t))]
  const conceptIds = [...new Set(entries.flatMap((e) => e.lines.map((l) => l.conceptId)).filter((c): c is string => !!c))]
  const [ann, money, tenants, concepts, posters] = await Promise.all([
    annotateEntries(viewer, entries),
    moneyCodesOf(prisma, tenantIds),
    prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }),
    conceptIds.length ? prisma.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, name: true } }) : [],
    userNames(entries.map((e) => e.postedBy ?? '')),
  ])
  const tenantName = new Map(tenants.map((t) => [t.id, t.name]))
  const brandName = new Map(concepts.map((c) => [c.id, c.name]))
  const narrate = await particularsOf(tenantIds, entries)
  const rows: JournalRow[] = []
  for (const id of ids) {
    const e = byId.get(id)
    if (!e) continue
    const codes = (e.tenantId && money.get(e.tenantId)) || new Set<string>()
    const lines: JournalLineRow[] = e.lines.map((l) => ({
      id: l.id, accountId: l.accountId, accountCode: l.account.code, accountName: l.account.name, type: l.type,
      amountCents: toCents(l.amountCents), conceptId: l.conceptId, conceptName: l.conceptId ? (brandName.get(l.conceptId) ?? null) : null, memo: l.memo,
      subAccounts: l.subAccountAllocations.map((a) => ({ subAccountId: a.subAccountId, name: a.subAccount.name, amountCents: toCents(a.amountCents) })),
    }))
    const moneyByCode = new Map<string, { code: string; name: string; netCents: number }>()
    const other = new Map<string, { label: string; cents: number }>()
    for (const l of lines) {
      const signed = l.type === 'debit' ? l.amountCents : -l.amountCents
      if (codes.has(l.accountCode)) {
        const cur = moneyByCode.get(l.accountCode) ?? { code: l.accountCode, name: l.accountName, netCents: 0 }
        cur.netCents += signed
        moneyByCode.set(l.accountCode, cur)
      } else {
        const cur = other.get(l.accountCode) ?? { label: `${l.accountCode} ${l.accountName}`, cents: 0 }
        cur.cents += l.amountCents
        other.set(l.accountCode, cur)
      }
    }
    const sortedOther = [...other.values()].sort((a, b) => b.cents - a.cents)
    const isManual = (e.reference ?? '').startsWith(MANUAL_PREFIX)
    const split = isManual ? splitDescription(e.description) : { description: e.description, reference: null }
    const brandIds = [...new Set(lines.map((l) => l.conceptId).filter((c): c is string => !!c))]
    rows.push({
      id: e.id,
      tenantId: e.tenantId,
      companyName: e.tenantId ? (tenantName.get(e.tenantId) ?? null) : null,
      voucherNo: e.voucherNo,
      reference: e.reference,
      entryDate: e.entryDate.toISOString(),
      createdAt: e.createdAt.toISOString(),
      description: split.description,
      particulars: narrate(e),
      operatorReference: split.reference,
      totalCents: lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0),
      moneyNetCents: [...moneyByCode.values()].reduce((s, m) => s + m.netCents, 0),
      moneyAccounts: [...moneyByCode.values()].filter((m) => m.netCents !== 0),
      counterSummary: sortedOther.length ? `${sortedOther[0]!.label}${sortedOther.length > 1 ? ` (+${sortedOther.length - 1} more)` : ''}` : '',
      brands: brandIds.map((b) => ({ id: b, name: brandName.get(b) ?? '' })),
      postedBy: e.postedBy ? { id: e.postedBy, name: e.postedBy === 'system' ? 'System' : (posters.get(e.postedBy) ?? e.postedBy) } : null,
      lines,
      ...ann.get(e.id)!,
    })
  }
  return rows
}

// ─── The list ────────────────────────────────────────────────────────────────

function likeOf(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/**
 * GET /accounting/journals. Newest first ((entryDate, id) desc), cursor paged,
 * no date window unless from / to are given. `limit` up to 200 (an export takes
 * up to 20,000).
 */
export async function listJournals(req: FastifyRequest, q: JournalsQuery, opts: { maxRows?: number } = {}) {
  const viewer = await viewerOf(req)
  const scope = await resolveTenantScope(req)
  const limit = opts.maxRows ?? q.limit
  const empty = { view: q.view, rows: [] as JournalRow[], nextCursor: null as string | null, hasMore: false, viewer }
  if (scope.tenantIds.length === 0) return empty

  const from = q.from ? parsePktStartOfDay(q.from) : null
  const to = q.to ? parsePktEndOfDay(q.to) : null
  const money = q.view === 'payment' || q.view === 'receipt'
  const window = from || to ? { from: from ?? new Date(0), to: to ?? new Date('9999-12-31T00:00:00Z') } : null
  const conds: Prisma.Sql[] = [Prisma.sql`e."tenantId" = ANY(${scope.tenantIds}::text[])`]
  const join = money ? Prisma.sql`JOIN (${moneyAggregatesSql(scope.tenantIds, window)}) m ON m.id = e.id` : Prisma.empty
  if (money) conds.push(moneyFlowWhereSql(q.view === 'payment' ? 'out' : 'in', { includeSales: q.includeSales === '1' || q.includeSales === 'true' }))
  if (q.view === 'manual') conds.push(Prisma.sql`(e.reference LIKE 'manual:%' OR e.reference LIKE 'manual.reversal:%')`)
  if (from) conds.push(Prisma.sql`e."entryDate" >= ${from}`)
  if (to) conds.push(Prisma.sql`e."entryDate" <= ${to}`)
  if (q.accountCode) {
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l."accountId" WHERE l."journalEntryId" = e.id AND a.code = ${q.accountCode})`)
  }
  if (q.brandId) conds.push(Prisma.sql`EXISTS (SELECT 1 FROM journal_lines l WHERE l."journalEntryId" = e.id AND l."conceptId" = ${q.brandId})`)
  // Amount: a payment / receipt by the money that moved; any other entry by its total.
  const amountExpr = money
    ? Prisma.sql`ABS(m.cr - m.dr)`
    : Prisma.sql`(SELECT COALESCE(SUM(l."amountCents"), 0) FROM journal_lines l WHERE l."journalEntryId" = e.id AND l.type = 'debit')`
  if (q.minCents !== undefined) conds.push(Prisma.sql`${amountExpr} >= ${q.minCents}`)
  if (q.maxCents !== undefined) conds.push(Prisma.sql`${amountExpr} <= ${q.maxCents}`)
  if (q.q) {
    const like = likeOf(q.q)
    const amount = amountOf(q.q)
    const srcId = Prisma.sql`split_part(split_part(e.reference, ':', 2), '@', 1)`
    conds.push(Prisma.sql`(
         e."voucherNo" ILIKE ${like} OR e.reference ILIKE ${like} OR e.description ILIKE ${like}
      OR EXISTS (SELECT 1 FROM journal_lines l WHERE l."journalEntryId" = e.id AND l.memo ILIKE ${like})
      OR (e.reference LIKE 'supplier.payment%' AND EXISTS (SELECT 1 FROM supplier_payments sp JOIN suppliers s ON s.id = sp."supplierId" WHERE sp.id = ${srcId} AND s.name ILIKE ${like}))
      OR ((e.reference LIKE 'supplier.bill%' OR e.reference LIKE 'supplier.credit_note%') AND EXISTS (SELECT 1 FROM supplier_bills sb JOIN suppliers s ON s.id = sb."supplierId" WHERE sb.id = ${srcId} AND (s.name ILIKE ${like} OR sb."billNumber" ILIKE ${like})))
      OR (e.reference LIKE 'cashvoucher.%' AND EXISTS (SELECT 1 FROM cash_vouchers cv WHERE cv.id = ${srcId} AND (cv."payeeName" ILIKE ${like} OR cv.number ILIKE ${like})))
      OR (e.reference LIKE 'receivable.%' AND (
            EXISTS (SELECT 1 FROM receivable_payments rp JOIN receivable_invoices ri ON ri.id = rp."invoiceId" WHERE rp.id = ${srcId} AND (ri."customerName" ILIKE ${like} OR ri.number ILIKE ${like}))
         OR EXISTS (SELECT 1 FROM receivable_invoices ri WHERE ri.id = ${srcId} AND (ri."customerName" ILIKE ${like} OR ri.number ILIKE ${like}))))
      ${amount !== null ? Prisma.sql`OR EXISTS (SELECT 1 FROM journal_lines l WHERE l."journalEntryId" = e.id AND l."amountCents" = ${amount})` : Prisma.empty}
    )`)
  }
  if (q.cursor) {
    const c = decodeCursor(q.cursor)
    conds.push(Prisma.sql`(e."entryDate", e.id) < (${c.d}, ${c.id}::text)`)
  }
  const page = await prisma.$queryRaw<Array<{ id: string; entryDate: Date }>>`
    SELECT e.id, e."entryDate" FROM journal_entries e ${join}
     WHERE ${Prisma.join(conds, ' AND ')}
     ORDER BY e."entryDate" DESC, e.id DESC
     LIMIT ${limit + 1}`
  const hasMore = page.length > limit
  if (hasMore) page.pop()
  const last = page[page.length - 1]
  return {
    view: q.view,
    rows: await journalRows(viewer, page.map((p) => p.id)),
    nextCursor: hasMore && last ? encodeCursor(last.entryDate, last.id) : null,
    hasMore,
    viewer,
  }
}

/** One entry of the caller's read scope (else 404), as a register row. */
export async function journalRow(req: FastifyRequest, id: string): Promise<JournalRow> {
  const scope = await resolveTenantScope(req)
  const e = await prisma.journalEntry.findFirst({ where: { id, tenantId: { in: scope.tenantIds } }, select: { id: true } })
  if (!e) throw new NotFoundError('JournalEntry', id)
  const [row] = await journalRows(await viewerOf(req), [e.id])
  return row!
}
