// Stock-count adjustments → the ledger.
//
// A count sets stock on hand to what was counted (decision 28). Sales COGS is
// perpetual (booked at shift close from recipes), so when the count finds
// more or less than the system expected, the inventory account has to move by
// the same value or the GL and the stock valuation drift apart after every
// count (2026-10-10 audit, BOH-12).
//
//   short (counted < system):  Dr 5050 Inventory Variance / Cr 1210 Inventory — Food
//   over  (counted > system):  Dr 1210 Inventory — Food   / Cr 5050 Inventory Variance
//
// Valued at the item's moving-average cost (the same cost the recipes, the
// waste log and sales COGS use). One entry per count, in the count's company
// (every line is that company's item — the route enforces it), idempotent on
// the count id. Each item contributes a balanced pair of lines, so the entry
// balances by construction; it is still asserted before posting.

import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry, type JournalLineInput } from '../accounting/journal.js'

export const COUNT_SOURCE_TYPE = 'inventory.count'

export async function postStockCount(countId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string; amountCents?: number }> {
  const count = await prisma.physicalCount.findUnique({ where: { id: countId }, include: { lines: true } })
  if (!count) return { posted: false, entryId: null, reason: 'count_not_found' }
  if (!count.tenantId) return { posted: false, entryId: null, reason: 'count_has_no_company' }

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: count.lines.map((l) => l.inventoryItemId) } },
    select: { id: true, name: true, unit: true, unitCostCents: true, tenantId: true },
  })
  const byId = new Map(items.map((i) => [i.id, i]))

  const lines: JournalLineInput[] = []
  let shortCents = 0
  let overCents = 0
  for (const l of count.lines) {
    const item = byId.get(l.inventoryItemId)
    // Never value another company's item into this company's books.
    if (!item || item.tenantId !== count.tenantId || !item.unitCostCents) continue
    const diff = l.physicalQty - l.systemQty
    const value = Math.round(Math.abs(diff) * item.unitCostCents)
    if (value === 0) continue
    const memo = `${item.name}: system ${l.systemQty} ${item.unit}, counted ${l.physicalQty} ${item.unit}`
    if (diff < 0) {
      shortCents += value
      lines.push({ accountCode: ACCT.INVENTORY_VARIANCE, type: 'debit',  amountCents: value, memo: `Count short — ${memo}` })
      lines.push({ accountCode: ACCT.INVENTORY_FOOD,     type: 'credit', amountCents: value, memo: `Count short — ${memo}` })
    } else {
      overCents += value
      lines.push({ accountCode: ACCT.INVENTORY_FOOD,     type: 'debit',  amountCents: value, memo: `Count over — ${memo}` })
      lines.push({ accountCode: ACCT.INVENTORY_VARIANCE, type: 'credit', amountCents: value, memo: `Count over — ${memo}` })
    }
  }
  if (lines.length === 0) return { posted: false, entryId: null, reason: 'no_variance' }

  const debits  = lines.filter((x) => x.type === 'debit').reduce((s, x) => s + x.amountCents, 0)
  const credits = lines.filter((x) => x.type === 'credit').reduce((s, x) => s + x.amountCents, 0)
  if (debits !== credits) {
    throw new Error(`stock count ${count.id}: unbalanced adjustment (debits ${debits} ≠ credits ${credits})`)
  }

  const result = await postJournalEntry({
    tenantId: count.tenantId,
    sourceType: COUNT_SOURCE_TYPE,
    sourceId: count.id,
    description: `Stock count adjustment — short PKR ${(shortCents / 100).toFixed(2)}, over PKR ${(overCents / 100).toFixed(2)}`,
    entryDate: count.countedAt,
    postedBy: count.countedById,
    lines,
  })
  return { posted: result.posted, entryId: result.entryId, amountCents: shortCents - overCents }
}
