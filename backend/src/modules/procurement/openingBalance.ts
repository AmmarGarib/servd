// Supplier opening balances — posted to the ledger ONCE, so a supplier has one
// balance and it is ledger AP 2010.
//
// Supplier.openingBalanceCents (what was owed when the supplier was set up in
// servd) used to live only on the statement: it was added to "outstanding" but
// never posted, so the statement and the ledger disagreed by exactly that
// amount, and a payment made against it sat as an unapplied credit for ever.
//
// Now the opening balance is posted to the supplier's company ledger:
//     Dr 3020 Retained Earnings  /  Cr 2010 Accounts Payable
// (opening AP carried over from before the books started). The posting is a
// DELTA against whatever has already been posted for that supplier, so it is
// safe to run repeatedly: editing the opening balance posts the difference,
// moving the supplier to another company reverses it in the old company and
// posts it in the new one, and a replay posts nothing. Each posting has its
// own reference `supplier.opening:<supplierId>:<uuid>`.
//
// The AP aging reads the POSTED amount (postedOpeningBalances) into each
// supplier's total, so aging total == ledger AP, and a payment left unapplied
// against the opening balance nets it off.
//
// Dated at the day the balance is brought forward (finance final, item 4):
// Supplier.openingBalanceDate, else the day the supplier was set up in servd
// (createdAt) — never "today", so an opening entered on the 20th for a go-live
// on the 1st lands on the 1st. A refused posting (a closed month, a missing
// account) is never only logged: syncOpeningBalanceOrFlag raises a
// posting_failed flag (sourceType 'supplier.opening', metadata.documentDate)
// and Reconciliation → Backfill unposted re-posts it (backfillOrders.ts
// REPOSTERS 'supplier.opening'), into the open month with a note when the
// opening date's month is closed.

import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ACCT, flagPostingFailed, postJournalEntry, resolvePostingFailed, withLateNote, type JournalLineInput } from '../accounting/journal.js'
import { toCents } from '../../lib/money.js'

export const OPENING_SOURCE_TYPE = 'supplier.opening'
/** Offset for opening AP: balances brought forward from before the books. */
export const OPENING_OFFSET_CODE = '3020'   // Retained Earnings

type Db = Prisma.TransactionClient | typeof prisma

/**
 * Opening AP already posted to the ledger, per supplier per company
 * (credit − debit on AP 2010 across the supplier's opening entries).
 */
export async function postedOpeningBalances(
  supplierIds?: string[],
  db: Db = prisma,
  /** Only entries dated on/before this instant (the AP aging as at a past date). */
  asOf?: Date,
): Promise<Map<string, Map<string, number>>> {
  const prefix = `${OPENING_SOURCE_TYPE}:`
  const refFilter: Prisma.JournalEntryWhereInput = supplierIds
    ? { OR: supplierIds.map((id) => ({ reference: { startsWith: `${prefix}${id}:` } })) }
    : { reference: { startsWith: prefix } }
  if (supplierIds && supplierIds.length === 0) return new Map()

  const lines = await db.journalLine.findMany({
    where: { account: { code: ACCT.AP_SUPPLIERS }, journalEntry: asOf ? { AND: [refFilter, { entryDate: { lte: asOf } }] } : refFilter },
    select: { type: true, amountCents: true, journalEntry: { select: { reference: true, tenantId: true } } },
  })
  const out = new Map<string, Map<string, number>>()
  for (const l of lines) {
    const supplierId = l.journalEntry.reference?.slice(prefix.length).split(':')[0]
    const tenantId = l.journalEntry.tenantId
    if (!supplierId || !tenantId) continue
    const per = out.get(supplierId) ?? new Map<string, number>()
    const amt = toCents(l.amountCents)
    per.set(tenantId, (per.get(tenantId) ?? 0) + (l.type === 'credit' ? amt : -amt))
    out.set(supplierId, per)
  }
  return out
}

export interface OpeningSyncResult {
  supplierId: string
  postings: Array<{ tenantId: string; deltaCents: number; entryId: string }>
}

/** The day a supplier's opening balance is brought forward at (see the header). */
export function openingDateOf(s: { openingBalanceDate: Date | null; createdAt: Date }): Date {
  return s.openingBalanceDate ?? s.createdAt
}

/**
 * Make the ledger carry exactly Supplier.openingBalanceCents for this supplier,
 * in the supplier's company (and nothing in any other company). A supplier
 * with no company posts nothing (anything posted earlier is reversed).
 */
export async function syncSupplierOpeningBalance(
  supplierId: string,
  /** entryDate / memoNote: the backfill's late placement (its month closed). */
  opts: { postedBy?: string; entryDate?: Date; memoNote?: string } = {},
): Promise<OpeningSyncResult> {
  return prisma.$transaction(async (tx) => {
    // Serialise syncs of one supplier so two edits can't both post a delta.
    await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${supplierId} FOR UPDATE`
    const supplier = await tx.supplier.findUnique({
      where:  { id: supplierId },
      select: { id: true, name: true, tenantId: true, openingBalanceCents: true, openingBalanceDate: true, createdAt: true },
    })
    const result: OpeningSyncResult = { supplierId, postings: [] }
    if (!supplier) return result

    const posted = (await postedOpeningBalances([supplierId], tx)).get(supplierId) ?? new Map<string, number>()
    const targets = new Map<string, number>(Array.from(posted.keys()).map((t) => [t, 0]))
    if (supplier.tenantId) targets.set(supplier.tenantId, toCents(supplier.openingBalanceCents))

    for (const [tenantId, target] of targets) {
      const delta = target - (posted.get(tenantId) ?? 0)
      if (delta === 0) continue
      const amount = Math.abs(delta)
      const base: JournalLineInput[] = delta > 0
        ? [
            { accountCode: OPENING_OFFSET_CODE,  type: 'debit',  amountCents: amount, memo: 'Opening AP brought forward' },
            { accountCode: ACCT.AP_SUPPLIERS,    type: 'credit', amountCents: amount, memo: `${supplier.name} opening balance` },
          ]
        : [
            { accountCode: ACCT.AP_SUPPLIERS,    type: 'debit',  amountCents: amount, memo: `${supplier.name} opening balance adjustment` },
            { accountCode: OPENING_OFFSET_CODE,  type: 'credit', amountCents: amount, memo: 'Opening AP brought forward' },
          ]
      const { description, lines } = withLateNote(
        delta > 0 ? `Opening balance owed to ${supplier.name}` : `Opening balance reduced for ${supplier.name}`,
        base, opts.memoNote,
      )
      const res = await postJournalEntry({
        tenantId,
        sourceType:  OPENING_SOURCE_TYPE,
        sourceId:    `${supplierId}:${randomUUID()}`,
        description,
        entryDate:   opts.entryDate ?? openingDateOf(supplier),
        postedBy:    opts.postedBy ?? 'system',
        lines,
      }, { tx })
      result.postings.push({ tenantId, deltaCents: delta, entryId: res.entryId })
    }
    return result
  })
}

/**
 * Sync every supplier that has an opening balance or an opening posting —
 * the one-off backfill for suppliers set up before opening balances were
 * posted, and safe to run at every boot (it posts only differences).
 */
export async function syncAllSupplierOpeningBalances(): Promise<{ synced: number; failed: Array<{ supplierId: string; error: string }> }> {
  const posted = await postedOpeningBalances()
  const withOpening = await prisma.supplier.findMany({
    where:  { openingBalanceCents: { not: 0 } },
    select: { id: true },
  })
  const ids = new Set<string>([...withOpening.map((s) => s.id), ...posted.keys()])
  let synced = 0
  const failed: Array<{ supplierId: string; error: string }> = []
  for (const id of ids) {
    const r = await syncOpeningBalanceOrFlag(id)
    if (r.ok) { if (r.result.postings.length > 0) synced += 1 }
    else failed.push({ supplierId: id, error: r.error })
  }
  return { synced, failed }
}

/**
 * syncSupplierOpeningBalance, and when the ledger refuses it (a closed month,
 * a missing account) a posting_failed flag in the supplier's company — never
 * only a log line. Reconciliation → Backfill unposted re-posts it
 * (backfillOrders.ts REPOSTERS 'supplier.opening'). Never throws.
 */
export async function syncOpeningBalanceOrFlag(
  supplierId: string,
  opts: { postedBy?: string } = {},
): Promise<{ ok: true; result: OpeningSyncResult } | { ok: false; error: string }> {
  try {
    const result = await syncSupplierOpeningBalance(supplierId, opts)
    // On the books (or nothing owed) now: an earlier refusal's flag is done.
    await resolvePostingFailed('Supplier', supplierId, OPENING_SOURCE_TYPE, 'The opening balance is on the books.')
    return { ok: true, result }
  } catch (err) {
    const error = (err as Error).message
    const s = await prisma.supplier.findUnique({
      where:  { id: supplierId },
      select: { name: true, tenantId: true, openingBalanceCents: true, openingBalanceDate: true, createdAt: true },
    }).catch(() => null)
    await flagPostingFailed({
      tenantId:    s?.tenantId ?? null,
      sourceType:  OPENING_SOURCE_TYPE,
      sourceId:    supplierId,
      entityType:  'Supplier',
      entityId:    supplierId,
      reason:      error,
      title:       `Opening balance of ${s?.name ?? 'a supplier'} did not reach the ledger`,
      actorId:     opts.postedBy ?? null,
      amountCents: s ? toCents(s.openingBalanceCents) : null,
      metadata:    s ? { documentDate: openingDateOf(s).toISOString() } : {},
    })
    return { ok: false, error }
  }
}
