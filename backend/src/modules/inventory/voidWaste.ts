// BOH-R2-03 — a line voided AFTER the kitchen fired it.
//
// The food was made, so its stock stays out (BOH-11). It used to stop there:
// no waste log, no ledger entry, and COGS skips voided lines — so 1210
// Inventory stayed higher than the stock on the shelf, permanently, by the
// plate cost of every such line (a physical count compares with currentStock,
// which already has it out, so it never surfaced as a variance either).
//
// Now the void books it as WASTE, inside the void's transaction (the order row
// is locked, as the depletion and the cancel restore lock it):
//
//   - What the order's depletion actually took for this line (its `taken`,
//     clamped at zero stock) — never more, and nothing when the depletion has
//     not run (it skips a voided line) or the order's stock was already given
//     back.
//   - That quantity leaves the depletion row's `taken` (kept under
//     `voidWasted`), so cancelling the order later does not put food that was
//     cooked and binned back on the shelf.
//   - One WasteLog per ingredient (reason 'void_after_fire', the item's
//     moving-average cost — the same costing as a manual waste entry), and ONE
//     journal entry Dr 5040 Waste / Cr 1210 Inventory — Food in the ORDER's
//     company, keyed on the order item (`pos.void_waste:<orderItemId>`, so it
//     can never post twice). A closed period refuses the posting: the void
//     still goes through, the waste log stands, and the caller raises a
//     'posting_failed' flag so finance books it in the open period.

import type { Prisma } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import { consumptionForSoldLines } from '../../lib/recipeCost.js'
import { postJournalEntry, ACCT, type JournalLineInput } from '../accounting/journal.js'

type Tx = Prisma.TransactionClient

const STOCK_DEPLETE = 'stock.sale_deplete'
const STOCK_RESTORE = 'stock.sale_restore'
export const VOID_WASTE_REASON = 'void_after_fire'
export const VOID_WASTE_SOURCE = 'pos.void_waste'

export interface VoidWasteResult {
  /** Inventory item id → quantity booked as waste (purchase units). */
  wasted: Record<string, number>
  costCents: number
  wasteLogIds: string[]
  entryId: string | null
  /** Why nothing was booked, when nothing was. */
  skipped: 'not_depleted' | 'no_recipe' | 'nothing_taken' | null
  /** The ledger refused the entry (e.g. PERIOD_LOCKED) — flag it after commit. */
  postingError: { code: string; message: string } | null
}

export async function wasteVoidedFiredLineTx(tx: Tx, input: {
  orderId: string
  /** The ORDER's company (concept.tenantId) — the books it posts to. */
  tenantId: string | null
  conceptId: string | null
  line: { id: string; name: string; menuItemId: string | null; quantity: number }
  actorId: string
  approverId: string | null
  reason: string
}): Promise<VoidWasteResult> {
  const none = (skipped: VoidWasteResult['skipped']): VoidWasteResult =>
    ({ wasted: {}, costCents: 0, wasteLogIds: [], entryId: null, skipped, postingError: null })

  const [depleted, restoredAll] = await Promise.all([
    tx.auditLog.findFirst({ where: { entity: 'Order', entityId: input.orderId, action: STOCK_DEPLETE }, select: { id: true, metadata: true } }),
    tx.auditLog.findFirst({ where: { entity: 'Order', entityId: input.orderId, action: STOCK_RESTORE }, select: { id: true } }),
  ])
  if (!depleted || restoredAll) return none('not_depleted')

  const need = await consumptionForSoldLines([{ menuItemId: input.line.menuItemId, quantity: input.line.quantity, status: 'pending' }], tx)
  if (need.size === 0) return none('no_recipe')

  const meta = (depleted.metadata ?? {}) as {
    taken?: Record<string, number>
    takenAtSale?: Record<string, number>
    voidWasted?: Record<string, Record<string, number>>
  } & Record<string, unknown>
  // Booked once per line: the void claims the line before this runs, and a
  // line already in voidWasted is never booked again.
  if (meta.voidWasted?.[input.line.id]) return none('nothing_taken')
  const taken = { ...(meta.taken ?? {}) }
  const wasted: Record<string, number> = {}
  for (const [id, qty] of need) {
    const out = taken[id] ?? 0
    const w = Math.min(qty, out)
    if (w > 0) {
      wasted[id] = w
      taken[id] = out - w
    }
  }
  if (Object.keys(wasted).length === 0) return none('nothing_taken')

  await tx.auditLog.update({
    where: { id: depleted.id },
    data: {
      metadata: {
        ...meta,
        takenAtSale: meta.takenAtSale ?? meta.taken ?? {},
        taken,
        voidWasted: { ...(meta.voidWasted ?? {}), [input.line.id]: wasted },
      } as Prisma.InputJsonValue,
    },
  })

  const items = await tx.inventoryItem.findMany({
    where: { id: { in: Object.keys(wasted) } },
    select: { id: true, name: true, unit: true, unitCostCents: true },
  })
  const note = `Voided after firing: ${input.line.quantity} × ${input.line.name} (order ${input.orderId}, line ${input.line.id}). Reason: ${input.reason}`
  const wasteLogIds: string[] = []
  const debits: JournalLineInput[] = []
  let costCents = 0
  for (const it of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const qty = wasted[it.id]!
    const cost = it.unitCostCents ? Math.round(it.unitCostCents * qty) : null
    const log = await tx.wasteLog.create({
      data: {
        inventoryItemId: it.id,
        quantity: qty,
        unit: it.unit,
        reason: VOID_WASTE_REASON,
        estimatedCostCents: cost,
        approvedById: input.approverId,
        recordedById: input.actorId,
        notes: note,
      },
      select: { id: true },
    })
    wasteLogIds.push(log.id)
    if (cost && cost > 0) {
      costCents += cost
      debits.push({ accountCode: ACCT.WASTE, type: 'debit', amountCents: cost, memo: `Void after fire: ${it.name}`, conceptId: input.conceptId })
    }
  }

  let entryId: string | null = null
  let postingError: VoidWasteResult['postingError'] = null
  if (costCents > 0 && input.tenantId) {
    try {
      const r = await postJournalEntry({
        tenantId: input.tenantId,
        sourceType: VOID_WASTE_SOURCE,
        sourceId: input.line.id,
        description: `Waste — ${input.line.quantity} × ${input.line.name} voided after firing`,
        entryDate: new Date(),
        postedBy: input.actorId,
        lines: [
          ...debits,
          { accountCode: ACCT.INVENTORY_FOOD, type: 'credit', amountCents: costCents, memo: 'Inventory derecognised (void after fire)', conceptId: input.conceptId },
        ],
      }, { tx })
      entryId = r.entryId
    } catch (err) {
      // postJournalEntry refuses (closed period, a missing account) before it
      // writes anything, so the transaction is still good: the void stands
      // and the caller flags the posting for finance.
      if (!(err instanceof AppError)) throw err
      postingError = { code: err.code, message: err.message }
    }
  } else if (costCents > 0) {
    postingError = { code: 'NO_COMPANY', message: 'The brand has no company to post the waste to' }
  }

  return { wasted, costCents, wasteLogIds, entryId, skipped: null, postingError }
}
