// Trash — reversed manual journal entries and withdrawn journal requests
// (stream B7, spec §1c).
//
//   journal_entry    A MANUAL JournalEntry (`manual:<id>`) that has its reversal
//                    twin (`manual.reversal:<id>`). System-sourced entries are
//                    never listed: their document owns them. Copy = CREATED: a
//                    new DRAFT JournalRequest (kind post) through the module's
//                    own POST /accounting/journal-requests — the same lines
//                    (account, debit / credit, amount, memo, brand) and
//                    description, dated today. NOTHING posts: the maker-checker
//                    (submit → the CEO approves) does that.
//   journal_request  JournalRequest `withdrawn`. Copy = CREATED: a new draft of
//                    kind post with the same lines. A `reverse` request is not
//                    copyable (reversing a live entry is the CEO's action on it).
//
// Company: the entry's / request's tenantId. Roles = JR_PREPARERS (who may
// prepare a journal); module `accounting`.

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { AppError, NotFoundError } from '../../../../lib/errors.js'
import { JR_PREPARERS } from '../../../accounting/journalRequests.js'
import { MANUAL_PREFIX, MANUAL_REVERSAL_PREFIX } from '../../../accounting/manualJournal.js'
import type { CopyResult, TrashCtx, TrashListFilter, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, injectCreate, n, pkr, qWhere, roles, scopeIds, sortRows } from './common.js'

export const TRASH_JOURNAL = { journal_entry: 'journal_entry', journal_request: 'journal_request' } as const

const PREP = roles(JR_PREPARERS)
const LINK = '/accounting/journal'
const REVERSE_NOT_COPYABLE = 'A reversal request is not copied — reverse the entry again from the journal if it still needs it'
const tenantIn = (ctx: TrashCtx) => ({ tenantId: { in: scopeIds(ctx.readScope) } })

interface DraftLine { accountId: string; type: 'debit' | 'credit'; amountCents: number; memo?: string; conceptId?: string | null }

async function createDraft(ctx: TrashCtx, description: string, lines: DraftLine[], reference?: string | null): Promise<CopyResult> {
  if (lines.length < 2) throw new AppError('NOTHING_TO_COPY', 'This journal has fewer than two lines — write it again', 422)
  const id = await injectCreate(ctx, '/accounting/journal-requests', {
    kind: 'post',
    description: description.slice(0, 500),
    ...(reference ? { reference: reference.slice(0, 200) } : {}),
    lines,
    submit: false,
  }, (j) => {
    const r = j.request as { id?: unknown } | undefined
    return typeof r?.id === 'string' ? r.id : undefined
  })
  return { mode: 'created', id, link: LINK, newEntityType: TRASH_JOURNAL.journal_request }
}

// ── Reversed manual entries ──────────────────────────────────────────────────

interface Pair {
  original: { id: string; tenantId: string | null; description: string; entryDate: Date; total: number; conceptId: string | null }
  reversal: { id: string; createdAt: Date; description: string; postedBy: string | null }
}

const ENTRY_SELECT = {
  id: true, tenantId: true, reference: true, description: true, entryDate: true, createdAt: true, postedBy: true,
  lines: { select: { type: true, amountCents: true, conceptId: true } },
} satisfies Prisma.JournalEntrySelect
type EntrySel = Prisma.JournalEntryGetPayload<{ select: typeof ENTRY_SELECT }>

const debitTotal = (e: EntrySel) => e.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + n(l.amountCents), 0)
const brandOf = (e: EntrySel) => {
  const ids = [...new Set(e.lines.map((l) => l.conceptId).filter(Boolean))]
  return ids.length === 1 ? (ids[0] as string) : null
}

/** Pair each reversal with its manual original (same company). */
async function pairsOf(reversals: EntrySel[]): Promise<Pair[]> {
  if (!reversals.length) return []
  const wanted = reversals.map((r) => ({ tenantId: r.tenantId, reference: `${MANUAL_PREFIX}${r.reference!.slice(MANUAL_REVERSAL_PREFIX.length)}` }))
  const originals = await db.journalEntry.findMany({ where: { OR: wanted }, select: ENTRY_SELECT })
  const byKey = new Map(originals.map((o) => [`${o.tenantId}|${o.reference}`, o]))
  const out: Pair[] = []
  for (const r of reversals) {
    const o = byKey.get(`${r.tenantId}|${MANUAL_PREFIX}${r.reference!.slice(MANUAL_REVERSAL_PREFIX.length)}`)
    if (!o) continue
    out.push({
      original: { id: o.id, tenantId: o.tenantId, description: o.description, entryDate: o.entryDate, total: debitTotal(o), conceptId: brandOf(o) },
      reversal: { id: r.id, createdAt: r.createdAt, description: r.description, postedBy: r.postedBy },
    })
  }
  return out
}

const pairRow = (p: Pair): TrashRow => ({
  id: p.original.id,
  tenantId: p.original.tenantId,
  conceptId: p.original.conceptId,
  title: `${p.original.description} — ${pkr(p.original.total)}`.slice(0, 300),
  subtitle: `Manual entry of ${p.original.entryDate.toISOString().slice(0, 10)}`,
  at: p.reversal.createdAt,
  byId: p.reversal.postedBy && p.reversal.postedBy !== 'system' ? p.reversal.postedBy : null,
  reason: p.reversal.description,
  statusLabel: 'Reversed',
})

async function listEntries(ctx: TrashCtx, f: TrashListFilter): Promise<TrashRow[]> {
  // The cursor is on the ORIGINAL's id but the reversal's time: read every
  // reversal at or before the cursor time and cut in memory.
  const reversals = await db.journalEntry.findMany({
    where: {
      AND: [
        tenantIn(ctx),
        { reference: { startsWith: MANUAL_REVERSAL_PREFIX } },
        atWhere('createdAt', { from: f.from, to: f.to }),
        f.before ? { createdAt: { lte: f.before.at } } : {},
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: f.limit + 50,
    select: ENTRY_SELECT,
  })
  const q = f.q?.trim().toLowerCase()
  const rows = (await pairsOf(reversals))
    .map(pairRow)
    .filter((r) => !q || r.title.toLowerCase().includes(q) || (r.reason ?? '').toLowerCase().includes(q))
    .filter((r) => !f.before || r.at.getTime() < f.before.at.getTime() || (r.at.getTime() === f.before.at.getTime() && r.id < f.before.id))
  return sortRows(rows, f.limit)
}

async function pairById(ctx: TrashCtx, id: string): Promise<Pair | null> {
  const o = await db.journalEntry.findFirst({ where: { id, ...tenantIn(ctx), reference: { startsWith: MANUAL_PREFIX } }, select: { tenantId: true, reference: true } })
  if (!o?.reference) return null
  const rev = await db.journalEntry.findFirst({
    where: { tenantId: o.tenantId, reference: `${MANUAL_REVERSAL_PREFIX}${o.reference.slice(MANUAL_PREFIX.length)}` },
    select: ENTRY_SELECT,
  })
  if (!rev) return null
  const [p] = await pairsOf([rev])
  return p ?? null
}

const journalEntry: TrashProvider = {
  key: TRASH_JOURNAL.journal_entry,
  label: 'Reversed journal entry',
  moduleId: 'accounting',
  roles: { list: PREP, restore: PREP, copy: PREP },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => LINK,
  list: listEntries,
  async get(ctx, id) {
    const p = await pairById(ctx, id)
    return p ? pairRow(p) : null
  },
  async preview(ctx, id) {
    const e = await db.journalEntry.findFirst({
      where: { id, ...tenantIn(ctx) },
      select: { description: true, entryDate: true, lines: { select: { type: true, amountCents: true, memo: true, account: { select: { code: true, name: true } } } } },
    })
    if (!e) return []
    return [
      { label: 'Description', value: e.description },
      { label: 'Date', value: e.entryDate.toISOString().slice(0, 10) },
      ...e.lines.map((l) => ({ label: `${l.type === 'debit' ? 'Dr' : 'Cr'} ${l.account.code} ${l.account.name}`, value: `${pkr(l.amountCents)}${l.memo ? ` — ${l.memo}` : ''}` })),
    ]
  },
  async copy(ctx, id) {
    const p = await pairById(ctx, id)
    if (!p) throw new NotFoundError('Trash item', id)
    const e = await db.journalEntry.findUniqueOrThrow({
      where: { id: p.original.id },
      select: { description: true, lines: { select: { accountId: true, type: true, amountCents: true, memo: true, conceptId: true } } },
    })
    return createDraft(ctx, e.description, e.lines.map((l) => ({
      accountId: l.accountId,
      type: l.type as 'debit' | 'credit',
      amountCents: n(l.amountCents),
      ...(l.memo ? { memo: l.memo } : {}),
      conceptId: l.conceptId,
    })))
  },
  erasable: () => false,
}

// ── Withdrawn journal requests ───────────────────────────────────────────────

const JR_SELECT = {
  id: true, tenantId: true, kind: true, description: true, totalCents: true, updatedAt: true, decisionNote: true,
} satisfies Prisma.JournalRequestSelect
type JrSel = Prisma.JournalRequestGetPayload<{ select: typeof JR_SELECT }>

const jrRow = (r: JrSel): TrashRow => ({
  id: r.id,
  tenantId: r.tenantId,
  title: `${r.description} — ${pkr(r.totalCents)}`.slice(0, 300),
  subtitle: r.kind === 'reverse' ? 'Reversal request' : 'Journal request',
  at: r.updatedAt,
  reason: r.decisionNote,
  statusLabel: 'Withdrawn',
  notCopyableReason: r.kind === 'reverse' ? REVERSE_NOT_COPYABLE : null,
})

const journalRequest: TrashProvider = {
  key: TRASH_JOURNAL.journal_request,
  label: 'Journal request',
  moduleId: 'accounting',
  roles: { list: PREP, restore: PREP, copy: PREP },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => LINK,
  async list(ctx, f) {
    const rows = await db.journalRequest.findMany({
      where: { AND: [tenantIn(ctx), { status: 'withdrawn' }, atWhere('updatedAt', f), qWhere(f.q, ['description', 'reference'])] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: JR_SELECT,
    })
    return rows.map(jrRow)
  },
  async get(ctx, id) {
    const r = await db.journalRequest.findFirst({ where: { id, ...tenantIn(ctx), status: 'withdrawn' }, select: JR_SELECT })
    return r ? jrRow(r) : null
  },
  async copy(ctx, id) {
    const r = await db.journalRequest.findFirst({
      where: { id, ...tenantIn(ctx), status: 'withdrawn' },
      select: { kind: true, description: true, reference: true, lines: true },
    })
    if (!r) throw new NotFoundError('Trash item', id)
    if (r.kind !== 'post') throw new AppError('NOT_COPYABLE', REVERSE_NOT_COPYABLE, 422, { reason: REVERSE_NOT_COPYABLE })
    const raw = Array.isArray(r.lines) ? (r.lines as unknown as Array<Record<string, unknown>>) : []
    const lines: DraftLine[] = raw.map((l) => ({
      accountId: String(l.accountId),
      type: l.type === 'credit' ? 'credit' : 'debit',
      amountCents: n(l.amountCents),
      ...(typeof l.memo === 'string' && l.memo ? { memo: l.memo } : {}),
      conceptId: typeof l.conceptId === 'string' ? l.conceptId : null,
    }))
    return createDraft(ctx, r.description, lines, r.reference)
  },
  erasable: () => false,
}

export const JOURNAL_TRASH_PROVIDERS: readonly TrashProvider[] = [journalEntry, journalRequest]
