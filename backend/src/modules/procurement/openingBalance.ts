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

import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry } from '../accounting/journal.js'

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
): Promise<Map<string, Map<string, number>>> {
  const prefix = `${OPENING_SOURCE_TYPE}:`
  const refFilter: Prisma.JournalEntryWhereInput = supplierIds
    ? { OR: supplierIds.map((id) => ({ reference: { startsWith: `${prefix}${id}:` } })) }
    : { reference: { startsWith: prefix } }
  if (supplierIds && supplierIds.length === 0) return new Map()

  const lines = await db.journalLine.findMany({
    where: { account: { code: ACCT.AP_SUPPLIERS }, journalEntry: refFilter },
    select: { type: true, amountCents: true, journalEntry: { select: { reference: true, tenantId: true } } },
  })
  const out = new Map<string, Map<string, number>>()
  for (const l of lines) {
    const supplierId = l.journalEntry.reference?.slice(prefix.length).split(':')[0]
    const tenantId = l.journalEntry.tenantId
    if (!supplierId || !tenantId) continue
    const per = out.get(supplierId) ?? new Map<string, number>()
    per.set(tenantId, (per.get(tenantId) ?? 0) + (l.type === 'credit' ? l.amountCents : -l.amountCents))
    out.set(supplierId, per)
  }
  return out
}

export interface OpeningSyncResult {
  supplierId: string
  postings: Array<{ tenantId: string; deltaCents: number; entryId: string }>
}

/**
 * Make the ledger carry exactly Supplier.openingBalanceCents for this supplier,
 * in the supplier's company (and nothing in any other company). A supplier
 * with no company posts nothing (anything posted earlier is reversed).
 */
export async function syncSupplierOpeningBalance(
  supplierId: string,
  opts: { postedBy?: string } = {},
): Promise<OpeningSyncResult> {
  return prisma.$transaction(async (tx) => {
    // Serialise syncs of one supplier so two edits can't both post a delta.
    await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${supplierId} FOR UPDATE`
    const supplier = await tx.supplier.findUnique({
      where:  { id: supplierId },
      select: { id: true, name: true, tenantId: true, openingBalanceCents: true },
    })
    const result: OpeningSyncResult = { supplierId, postings: [] }
    if (!supplier) return result

    const posted = (await postedOpeningBalances([supplierId], tx)).get(supplierId) ?? new Map<string, number>()
    const targets = new Map<string, number>(Array.from(posted.keys()).map((t) => [t, 0]))
    if (supplier.tenantId) targets.set(supplier.tenantId, supplier.openingBalanceCents)

    for (const [tenantId, target] of targets) {
      const delta = target - (posted.get(tenantId) ?? 0)
      if (delta === 0) continue
      const amount = Math.abs(delta)
      const res = await postJournalEntry({
        tenantId,
        sourceType:  OPENING_SOURCE_TYPE,
        sourceId:    `${supplierId}:${randomUUID()}`,
        description: delta > 0
          ? `Opening balance owed to ${supplier.name}`
          : `Opening balance reduced for ${supplier.name}`,
        entryDate:   new Date(),
        postedBy:    opts.postedBy ?? 'system',
        lines: delta > 0
          ? [
              { accountCode: OPENING_OFFSET_CODE,  type: 'debit',  amountCents: amount, memo: 'Opening AP brought forward' },
              { accountCode: ACCT.AP_SUPPLIERS,    type: 'credit', amountCents: amount, memo: `${supplier.name} opening balance` },
            ]
          : [
              { accountCode: ACCT.AP_SUPPLIERS,    type: 'debit',  amountCents: amount, memo: `${supplier.name} opening balance adjustment` },
              { accountCode: OPENING_OFFSET_CODE,  type: 'credit', amountCents: amount, memo: 'Opening AP brought forward' },
            ],
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
    try {
      const r = await syncSupplierOpeningBalance(id)
      if (r.postings.length > 0) synced += 1
    } catch (err) {
      failed.push({ supplierId: id, error: (err as Error).message })
    }
  }
  return { synced, failed }
}
