// Journals between companies (owner, 2026-11-12: "When i pass journal in GS which is related to Flipd, it should also
// appear in FLIPD to book same entry as receiving voucher with same details (editable)"; "It should hit FLIPD's
// payable account and same procedure if an entry is passed through FLIPD as liability paid"; "It should not require
// CEO's approval, CEO should get a notification instead"). Owner's pick: EXTEND (a draft in the other company), not the
// inter-company transfers (those stay as they are).
//
//   Link: an account carries `relatedTenantId` + `relatedAccountCode` (set on the chart by CHART_EDITORS, both or
//         neither — 422 RELATED_*): GS "2031 Loan to FLIPD" ↔ Flipd "<code> Payable to GS Foods".
//   Raise: a MANUAL journal (`manual:<id>`) with a line on a linked account raises ONE draft per other company
//         (`intercompany_journal_drafts`, tenantId = that company, unique per source entry + company), after the
//         posting commits (postManualJournal's side effects): every line flipped (debit ↔ credit, same amounts and
//         memos); a linked line goes to the other company's `relatedAccountCode`; any other line keeps its code when
//         the other company has that account live and not controlled, else it is left blank to pick; PV ↔ RV, JV / AV
//         stay; same date; description "<text> (from <company> <voucher no.>)". The other company's finance (with
//         `accounting`) and CEO(s) get a bell notice (`journal.intercompany`) — no approval step.
//   Book: that company's finance or CEO opens it in Journals (the New entry form, pre-filled, editable) and posts it
//         through the ONE manual-journal path (POST /accounting/journal {mirrorDraftId}); the claim is in the posting's
//         transaction (pending → posted, postedEntryId; twice → 409 DRAFT_NOT_PENDING). Or dismisses it with a note
//         ≥10 (POST /accounting/journal-drafts/:id/dismiss). Either way the CEO(s) of both companies are told.
//   Source cancelled / edited: a pending draft is withdrawn (an edit's new entry raises a new draft); a posted one
//         stays and both companies' finance + CEO(s) are told to review it.
//   Scope: a draft shows to members of either company (read); only the drafted company books / dismisses it (write,
//         another company's id 404).
import type { Prisma } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { toCents, fmtPkrCents } from '../../lib/money.js'
import { notifyStaffMany, type NotifyInput } from '../../lib/staffNotify.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'

type Tx = Prisma.TransactionClient

export interface MirrorLine {
  accountId: string | null
  accountCode: string | null
  accountName: string | null
  /** The code on the source line (shown when no account could be picked). */
  sourceAccountCode: string
  type: 'debit' | 'credit'
  amountCents: number
  memo: string | null
}

const FLIP_KIND: Record<string, string> = { PV: 'RV', RV: 'PV', JV: 'JV', AV: 'AV' }

async function companyName(id: string): Promise<string> {
  return (await serviceClient.tenant.findUnique({ where: { id }, select: { name: true } }))?.name ?? 'another company'
}

/** Finance (with accounting) and CEO logins of a company — the people told about a draft. */
async function financeAndCeoOf(tenantId: string): Promise<{ finance: string[]; ceo: string[] }> {
  const users = await serviceClient.user.findMany({
    where: {
      role: { in: ['admin', 'finance'] }, isActive: true, accountStatus: 'active', deletedAt: null,
      OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }],
    },
    select: { id: true, role: true, moduleAllow: true, moduleDeny: true },
  })
  const finance: string[] = []
  for (const u of users.filter((x) => x.role === 'finance')) {
    try { if ((await effectiveModulesForUser(u)).has('accounting')) finance.push(u.id) } catch { /* no modules → not told */ }
  }
  return { finance, ceo: users.filter((u) => u.role === 'admin').map((u) => u.id) }
}

async function tell(tenantId: string, who: 'finance_and_ceo' | 'ceo', row: Omit<NotifyInput, 'userId' | 'tenantId'>, actorId?: string | null) {
  const { finance, ceo } = await financeAndCeoOf(tenantId)
  const ids = [...new Set(who === 'ceo' ? ceo : [...finance, ...ceo])].filter((id) => id !== actorId)
  if (ids.length === 0) return
  await notifyStaffMany(ids.map((userId) => ({ ...row, userId, tenantId, dedupeKey: `${row.dedupeKey}:${userId}` })))
}

/** The other company's version of the source lines (see the contract). */
async function mirrorLines(targetTenantId: string, src: Array<{ type: string; amountCents: number; memo: string | null; account: { code: string; relatedTenantId: string | null; relatedAccountCode: string | null } }>): Promise<MirrorLine[]> {
  const codes = [...new Set(src.map((l) => (l.account.relatedTenantId === targetTenantId ? l.account.relatedAccountCode! : l.account.code)))]
  const accounts = await serviceClient.account.findMany({ where: { tenantId: targetTenantId, code: { in: codes } }, select: { id: true, code: true, name: true, isActive: true, controlledBy: true } })
  const byCode = new Map(accounts.map((a) => [a.code, a]))
  return src.map((l) => {
    const linked = l.account.relatedTenantId === targetTenantId
    const code = linked ? l.account.relatedAccountCode! : l.account.code
    const a = byCode.get(code)
    // A linked line always names its counterpart (even if it is off — posting will say so); an ordinary line only an
    // account the other company can post to by hand.
    const usable = a && (linked || (a.isActive && !a.controlledBy)) && !(l.account.relatedTenantId && !linked)
    return {
      accountId: usable ? a!.id : null, accountCode: usable ? a!.code : null, accountName: usable ? a!.name : null,
      sourceAccountCode: l.account.code,
      type: l.type === 'debit' ? 'credit' : 'debit', amountCents: l.amountCents, memo: l.memo,
    }
  })
}

/** After a manual journal commits: one pending draft per other company it touches through a linked account. Idempotent. */
export async function raiseMirrorDrafts(entryId: string, actorId?: string | null): Promise<number> {
  const e = await serviceClient.journalEntry.findUnique({
    where: { id: entryId },
    select: {
      id: true, tenantId: true, reference: true, description: true, entryDate: true, voucherKind: true, voucherNo: true,
      lines: { select: { type: true, amountCents: true, memo: true, account: { select: { code: true, relatedTenantId: true, relatedAccountCode: true } } } },
    },
  })
  if (!e?.tenantId || !(e.reference ?? '').startsWith('manual:')) return 0
  // An entry that booked another company's draft is that company's mirror — never sent back (no ping-pong).
  if (await serviceClient.intercompanyJournalDraft.findFirst({ where: { postedEntryId: e.id }, select: { id: true } })) return 0
  const targets = [...new Set(e.lines.map((l) => l.account.relatedTenantId).filter((t): t is string => !!t && t !== e.tenantId))]
  if (targets.length === 0) return 0
  const from = await companyName(e.tenantId)
  let made = 0
  for (const target of targets) {
    const lines = await mirrorLines(target, e.lines.map((l) => ({ type: l.type, amountCents: toCents(l.amountCents), memo: l.memo, account: l.account })))
    const kind = FLIP_KIND[e.voucherKind ?? 'JV'] ?? 'JV'
    const description = `${e.description} (from ${from}${e.voucherNo ? ` ${e.voucherNo}` : ''})`.slice(0, 500)
    const created = await serviceClient.intercompanyJournalDraft.createMany({
      data: [{
        tenantId: target, sourceTenantId: e.tenantId, sourceEntryId: e.id, sourceVoucherNo: e.voucherNo ?? null,
        voucherKind: kind, entryDate: e.entryDate, description, lines: lines as unknown as Prisma.InputJsonValue,
      }],
      skipDuplicates: true,
    })
    if (created.count === 0) continue
    made++
    const amount = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
    await tell(target, 'finance_and_ceo', {
      kind: 'journal.intercompany', severity: 'info',
      title: `${from} booked ${e.voucherNo ?? 'a journal'} with you — book your ${kind}`.slice(0, 140),
      body: `${e.description} · ${fmtPkrCents(amount)}. A pre-filled ${kind} is waiting in Journals → From other companies: check it, edit if needed, and post it.`.slice(0, 500),
      link: '/accounting/journal?tab=entry', entityType: 'IntercompanyJournalDraft', entityId: e.id, actorId: actorId ?? null,
      dedupeKey: `journal.intercompany:${e.id}:${target}`,
    }, actorId)
  }
  return made
}

/** The source entry was cancelled or replaced: pending drafts are withdrawn; booked ones are flagged to both sides. */
export async function sourceEntryGone(entryId: string, why: 'cancelled' | 'edited', actorId?: string | null): Promise<void> {
  const drafts = await serviceClient.intercompanyJournalDraft.findMany({ where: { sourceEntryId: entryId, status: { in: ['pending', 'posted'] } } })
  for (const d of drafts) {
    const from = await companyName(d.sourceTenantId)
    if (d.status === 'pending') {
      const r = await serviceClient.intercompanyJournalDraft.updateMany({
        where: { id: d.id, status: 'pending' },
        data: { status: 'withdrawn', decidedAt: new Date(), note: `The ${from} entry was ${why}${why === 'edited' ? ' — the corrected entry raises a new draft' : ''}` },
      })
      if (r.count === 0) continue
      continue
    }
    for (const t of [d.tenantId, d.sourceTenantId]) {
      await tell(t, 'finance_and_ceo', {
        kind: 'journal.intercompany', severity: 'warning',
        title: `${d.sourceVoucherNo ?? 'An inter-company journal'} was ${why} after the other side was booked`.slice(0, 140),
        body: `${from}'s entry was ${why}, but ${await companyName(d.tenantId)} had already booked its side. Review that entry and cancel or correct it if needed.`.slice(0, 500),
        link: '/accounting/journal?tab=journals', entityType: 'IntercompanyJournalDraft', entityId: d.id, actorId: actorId ?? null,
        dedupeKey: `journal.intercompany.gone:${d.id}:${why}`,
      }, actorId)
    }
  }
}

/** In the posting's transaction: this company's pending draft becomes booked by `postedEntryId` (409 if not pending). */
export async function claimMirrorDraftTx(tx: Tx, input: { draftId: string; tenantId: string; postedEntryId: string; actorId: string }): Promise<void> {
  const r = await tx.intercompanyJournalDraft.updateMany({
    where: { id: input.draftId, tenantId: input.tenantId, status: 'pending' },
    data: { status: 'posted', postedEntryId: input.postedEntryId, decidedById: input.actorId, decidedAt: new Date() },
  })
  if (r.count === 0) {
    const d = await tx.intercompanyJournalDraft.findFirst({ where: { id: input.draftId, tenantId: input.tenantId }, select: { status: true } })
    if (!d) throw new NotFoundError('IntercompanyJournalDraft', input.draftId)
    throw new AppError('DRAFT_NOT_PENDING', `This draft is already ${d.status}`, 409)
  }
}

/** After a draft was booked or dismissed: the CEO(s) of both companies are told (owner: a notice, not an approval). */
export async function draftDecidedNotice(draftId: string, actorId: string): Promise<void> {
  const d = await serviceClient.intercompanyJournalDraft.findUnique({ where: { id: draftId } })
  if (!d || (d.status !== 'posted' && d.status !== 'dismissed')) return
  const [here, from] = [await companyName(d.tenantId), await companyName(d.sourceTenantId)]
  const voucher = d.postedEntryId ? (await serviceClient.journalEntry.findUnique({ where: { id: d.postedEntryId }, select: { voucherNo: true } }))?.voucherNo : null
  for (const t of [...new Set([d.tenantId, d.sourceTenantId])]) {
    await tell(t, 'ceo', {
      kind: 'journal.intercompany', severity: d.status === 'posted' ? 'success' : 'warning',
      title: d.status === 'posted'
        ? `${here} booked its side of ${from}'s ${d.sourceVoucherNo ?? 'journal'}${voucher ? ` as ${voucher}` : ''}`.slice(0, 140)
        : `${here} dismissed its side of ${from}'s ${d.sourceVoucherNo ?? 'journal'}`.slice(0, 140),
      body: (d.status === 'dismissed' ? `Reason: ${d.note ?? '—'}` : d.description).slice(0, 500),
      link: '/accounting/journal?tab=journals', entityType: 'IntercompanyJournalDraft', entityId: d.id, actorId,
      dedupeKey: `journal.intercompany.${d.status}:${d.id}`,
    }, actorId)
  }
}
